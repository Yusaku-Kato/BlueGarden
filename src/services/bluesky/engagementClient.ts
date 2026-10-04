import type { Client } from "@atproto/lex";
import { l } from "@atproto/lex";
import { app } from "@bsky/sdk/lexicons";
import { AFTER_GROWTH, BLUESKY } from "../../config/gardenConfig";
import { sanitizeCount } from "../../domain/engagement";
import { classifyError, GardenError } from "./errors";
import { readNumber, readProp, readString } from "./untrusted";

export interface EngagementCounts {
  readonly likeCount: number;
  readonly repostCount: number;
}

/** Re-fetches like / repost counts after growth (SPEC §13.3, DESIGN §35.6). Never carries post text. */
export interface EngagementClient {
  /**
   * `app.bsky.feed.getPosts`, at most AFTER_GROWTH.URIS_PER_CALL URIs per request (larger inputs
   * are split). Posts that were deleted, hidden or malformed are omitted from the result.
   * Rejects with GardenError only.
   */
  fetchCounts(uris: readonly string[], signal: AbortSignal): Promise<ReadonlyMap<string, EngagementCounts>>;
}

/** Narrows a getPosts response body. Items without a usable uri are dropped; missing counts become 0. */
export function normalizeEngagement(raw: unknown): Map<string, EngagementCounts> {
  const list = readProp(raw, "posts");
  if (!Array.isArray(list)) throw new GardenError("malformedResponse");
  const items: unknown[] = list;
  const result = new Map<string, EngagementCounts>();
  for (const item of items) {
    const uri = readString(item, "uri");
    if (uri === undefined || !uri.startsWith("at://")) continue;
    result.set(uri, {
      likeCount: sanitizeCount(readNumber(item, "likeCount") ?? 0),
      repostCount: sanitizeCount(readNumber(item, "repostCount") ?? 0),
    });
  }
  return result;
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let index = 0; index < items.length; index += size) chunks.push(items.slice(index, index + size));
  return chunks;
}

/** One getPosts request for at most URIS_PER_CALL URIs. Resolves to the unvalidated response body. */
export type GetPostsCall = (uris: readonly string[], signal: AbortSignal) => Promise<unknown>;

/** Wraps a single-request function with chunking and response narrowing. */
export function createEngagementClient(getPosts: GetPostsCall): EngagementClient {
  return {
    async fetchCounts(uris, signal) {
      const merged = new Map<string, EngagementCounts>();
      for (const part of chunk(uris, AFTER_GROWTH.URIS_PER_CALL)) {
        if (signal.aborted) throw new GardenError("timeout");
        const body = await getPosts(part, signal);
        for (const [uri, counts] of normalizeEngagement(body)) merged.set(uri, counts);
      }
      return merged;
    },
  };
}

/** Engagement through an authenticated lex client (App Password session or OAuth). */
export function createLexEngagementClient(client: Client): EngagementClient {
  return createEngagementClient(async (uris, signal) => {
    const validUris = uris.filter((uri) => l.isAtUriString(uri));
    if (validUris.length === 0) return { posts: [] };
    const result = await client.xrpcSafe(app.bsky.feed.getPosts, {
      params: { uris: validUris },
      signal,
      validateResponse: false,
    });
    if (!result.success) throw classifyError(result, "feed");
    return result.body;
  });
}

export type FetchLike = (input: string, init: { signal: AbortSignal; headers: Record<string, string> }) => Promise<Response>;

/** Engagement through the unauthenticated public AppView (guests, Global Garden). */
export function createPublicEngagementClient(
  fetchImpl: FetchLike = (input, init) => fetch(input, init),
  baseUrl: string = BLUESKY.PUBLIC_APPVIEW_URL,
): EngagementClient {
  return createEngagementClient(async (uris, signal) => {
    const query = new URLSearchParams();
    for (const uri of uris) {
      if (l.isAtUriString(uri)) query.append("uris", uri);
    }
    if (query.size === 0) return { posts: [] };
    let response: Response;
    try {
      response = await fetchImpl(`${baseUrl}/xrpc/app.bsky.feed.getPosts?${query.toString()}`, {
        signal,
        headers: { accept: "application/json" },
      });
    } catch (error) {
      throw classifyError(error, "feed");
    }
    if (!response.ok) throw classifyError({ status: response.status, headers: response.headers }, "feed");
    try {
      const body: unknown = await response.json();
      return body;
    } catch (error) {
      throw signal.aborted ? classifyError(error, "feed") : new GardenError("malformedResponse");
    }
  });
}
