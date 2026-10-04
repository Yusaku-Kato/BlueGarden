import { BLUESKY } from "../../config/gardenConfig";
import { sanitizeCount } from "../../domain/engagement";
import type { GardenPost } from "../../domain/models";
import { logger } from "../../infra/logger";
import { GardenError } from "./errors";
import { readNumber, readProp, readString } from "./untrusted";

const AT_URI_PREFIX = "at://";

function isParsableDate(value: string | undefined): value is string {
  return value !== undefined && !Number.isNaN(Date.parse(value));
}

function normalizePostView(post: unknown): GardenPost | null {
  const uri = readString(post, "uri");
  if (uri === undefined || !uri.startsWith(AT_URI_PREFIX)) return null;

  const record = readProp(post, "record");
  const recordCreatedAt = readString(record, "createdAt");
  const createdAt = isParsableDate(recordCreatedAt) ? recordCreatedAt : readString(post, "indexedAt");
  if (!isParsableDate(createdAt)) return null;

  const text = readString(record, "text") ?? "";
  return {
    uri,
    text: text.slice(0, BLUESKY.MAX_TEXT_LENGTH_FOR_ANALYSIS),
    createdAt,
    likeCount: sanitizeCount(readNumber(post, "likeCount") ?? 0),
    repostCount: sanitizeCount(readNumber(post, "repostCount") ?? 0),
  };
}

/**
 * The only boundary between SDK responses and the domain (docs/DESIGN.md §8.3).
 * Drops malformed items individually. Throws `malformedResponse` when `feed` is not an array
 * or when a non-empty feed yields no valid post. Returns fresh objects without references to `raw`.
 */
export function normalizeFeed(raw: unknown): GardenPost[] {
  return normalizeList(readProp(raw, "feed"), (item) => normalizePostView(readProp(item, "post")));
}

/**
 * Same rules as normalizeFeed for responses that carry bare postViews (`posts: postView[]`,
 * as returned by app.bsky.feed.searchPosts).
 */
export function normalizePostViews(raw: unknown): GardenPost[] {
  return normalizeList(readProp(raw, "posts"), normalizePostView);
}

function normalizeList(list: unknown, normalizeItem: (item: unknown) => GardenPost | null): GardenPost[] {
  if (!Array.isArray(list)) throw new GardenError("malformedResponse");

  const items: unknown[] = list;
  const posts: GardenPost[] = [];
  for (const item of items) {
    const post = normalizeItem(item);
    if (post !== null) posts.push(post);
  }

  const ignored = items.length - posts.length;
  if (ignored > 0) logger.debug("posts.ignored", { count: ignored, reason: "malformed" });
  if (items.length > 0 && posts.length === 0) throw new GardenError("malformedResponse");
  return posts;
}
