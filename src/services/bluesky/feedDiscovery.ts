import { isFeedGeneratorUri, isValidDid } from "../../domain/feedUri";
import { errorName, logger } from "../../infra/logger";
import { classifyError, GardenError } from "./errors";
import { readProp, readString } from "./untrusted";

/** getFeedGenerators accepts at most 25 URIs per call. */
const GENERATORS_PER_CALL = 25;
const MAX_SAVED_FEEDS = 50;
const MAX_DISPLAY_NAME_LENGTH = 100;

const SAVED_FEEDS_V2 = "app.bsky.actor.defs#savedFeedsPrefV2";
const SAVED_FEEDS_LEGACY = "app.bsky.actor.defs#savedFeedsPref";

/**
 * Directory-style XRPC calls. Each resolves with the raw response body (untrusted) and rejects
 * with whatever the SDK throws. Injected so tests do not need the real SDK.
 */
export interface FeedDirectoryXrpc {
  getPreferences(signal?: AbortSignal): Promise<unknown>;
  getFeedGenerators(uris: readonly string[], signal?: AbortSignal): Promise<unknown>;
  getFeedGenerator(uri: string, signal?: AbortSignal): Promise<unknown>;
  resolveHandle(handle: string, signal?: AbortSignal): Promise<unknown>;
}

export interface SavedFeedInfo {
  readonly uri: string;
  readonly displayName: string;
}

function readArray(value: unknown, key: string): unknown[] {
  const result = readProp(value, key);
  return Array.isArray(result) ? result : [];
}

function cleanName(value: string | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed === "" ? null : trimmed.slice(0, MAX_DISPLAY_NAME_LENGTH);
}

/** Feed URIs from the preferences body: V2 items first (pinned before saved), else legacy lists. */
function extractFeedUris(body: unknown): string[] {
  const preferences = readArray(body, "preferences");
  const pinned: string[] = [];
  const saved: string[] = [];

  const v2 = preferences.find((pref) => readString(pref, "$type") === SAVED_FEEDS_V2);
  if (v2 !== undefined) {
    for (const item of readArray(v2, "items")) {
      const value = readString(item, "value");
      if (readString(item, "type") !== "feed" || value === undefined) continue;
      (readProp(item, "pinned") === true ? pinned : saved).push(value);
    }
  } else {
    const legacy = preferences.find((pref) => readString(pref, "$type") === SAVED_FEEDS_LEGACY);
    for (const value of readArray(legacy, "pinned")) if (typeof value === "string") pinned.push(value);
    for (const value of readArray(legacy, "saved")) if (typeof value === "string") saved.push(value);
  }

  const unique = new Set<string>();
  for (const uri of [...pinned, ...saved]) {
    if (isFeedGeneratorUri(uri)) unique.add(uri);
    if (unique.size >= MAX_SAVED_FEEDS) break;
  }
  return [...unique];
}

function readGeneratorNames(body: unknown, into: Map<string, string>): void {
  for (const view of readArray(body, "feeds")) {
    const uri = readString(view, "uri");
    const name = cleanName(readString(view, "displayName"));
    if (uri !== undefined && name !== null) into.set(uri, name);
  }
}

/**
 * Saved and pinned feeds of the signed-in user, pinned first, at most 50. Feeds whose names
 * cannot be read are left out. Any failure yields an empty list (logged without details).
 */
export async function listSavedFeeds(xrpc: FeedDirectoryXrpc, signal?: AbortSignal): Promise<SavedFeedInfo[]> {
  try {
    const uris = extractFeedUris(await xrpc.getPreferences(signal));
    const names = new Map<string, string>();
    for (let start = 0; start < uris.length; start += GENERATORS_PER_CALL) {
      const chunk = uris.slice(start, start + GENERATORS_PER_CALL);
      readGeneratorNames(await xrpc.getFeedGenerators(chunk, signal), names);
    }
    const result: SavedFeedInfo[] = [];
    for (const uri of uris) {
      const displayName = names.get(uri);
      if (displayName !== undefined) result.push({ uri, displayName });
    }
    return result;
  } catch (error) {
    logger.warn("feeds.listFailed", { error: errorName(error) });
    return [];
  }
}

/** Display name of a feed generator. Throws GardenError only (`notFound` when unknown or nameless). */
export async function describeFeed(xrpc: FeedDirectoryXrpc, uri: string, signal?: AbortSignal): Promise<string> {
  if (!isFeedGeneratorUri(uri)) throw new GardenError("invalidFeedTarget");
  let body: unknown;
  try {
    body = await xrpc.getFeedGenerator(uri, signal);
  } catch (error) {
    throw classifyError(error, "feed");
  }
  const name = cleanName(readString(readProp(body, "view"), "displayName"));
  if (name === null) throw new GardenError("notFound");
  return name;
}

/** Resolves a handle to a DID through the directory. Throws GardenError only. */
export async function resolveHandleToDid(
  xrpc: FeedDirectoryXrpc,
  handle: string,
  signal?: AbortSignal,
): Promise<string> {
  let body: unknown;
  try {
    body = await xrpc.resolveHandle(handle, signal);
  } catch (error) {
    throw classifyError(error, "feed");
  }
  const did = readString(body, "did");
  if (did === undefined || !isValidDid(did)) throw new GardenError("malformedResponse");
  return did;
}
