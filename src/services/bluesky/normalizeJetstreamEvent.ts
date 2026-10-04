import { l } from "@atproto/lex";
import { BLUESKY } from "../../config/gardenConfig";
import type { GardenPost } from "../../domain/models";
import { readNumber, readProp, readString } from "./untrusted";

export const POST_COLLECTION = "app.bsky.feed.post";

/** What the source needs to know about an event before deciding whether to parse it further. */
export function isPostCreateEvent(event: unknown): boolean {
  if (readString(event, "kind") !== "commit") return false;
  const commit = readProp(event, "commit");
  return readString(commit, "operation") === "create" && readString(commit, "collection") === POST_COLLECTION;
}

/** Server timestamp in microseconds (`timeUs` from @bsky/jetstream, `time_us` on the wire). */
export function readTimeUs(event: unknown): number | undefined {
  const value = readNumber(event, "timeUs") ?? readNumber(event, "time_us");
  return value !== undefined && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

const PLC_DID_PATTERN = /^did:plc:[a-z2-7]{24}$/;

/** atproto account DIDs: did:plc with a 24-character base32 id, or did:web. */
function isAccountDid(did: string): boolean {
  if (!l.isDidString(did)) return false;
  return PLC_DID_PATTERN.test(did) || did.startsWith("did:web:");
}

function isParsableDate(value: string | undefined): value is string {
  return value !== undefined && !Number.isNaN(Date.parse(value));
}

function isoFromTimeUs(timeUs: number): string | null {
  const date = new Date(Math.floor(timeUs / 1000));
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/**
 * Narrows an unknown Jetstream v1 event to a GardenPost (docs/DESIGN.md §36.3).
 * Only `create` commits of app.bsky.feed.post qualify. did and rkey are validated strictly because
 * they form the dedup key; anything else yields null. Counts are 0 (Jetstream carries none).
 * The returned object shares nothing with `event`.
 */
export function normalizeJetstreamEvent(event: unknown): GardenPost | null {
  if (!isPostCreateEvent(event)) return null;
  const did = readString(event, "did");
  const commit = readProp(event, "commit");
  const rkey = readString(commit, "rkey");
  if (did === undefined || rkey === undefined) return null;
  if (!isAccountDid(did) || !l.isRecordKeyString(rkey)) return null;

  const record = readProp(commit, "record");
  const recordCreatedAt = readString(record, "createdAt");
  const timeUs = readTimeUs(event);
  const createdAt = isParsableDate(recordCreatedAt)
    ? recordCreatedAt
    : timeUs === undefined
      ? null
      : isoFromTimeUs(timeUs);
  if (createdAt === null) return null;

  const text = readString(record, "text") ?? "";
  return {
    uri: `at://${did}/${POST_COLLECTION}/${rkey}`,
    text: text.slice(0, BLUESKY.MAX_TEXT_LENGTH_FOR_ANALYSIS),
    createdAt,
    likeCount: 0,
    repostCount: 0,
  };
}
