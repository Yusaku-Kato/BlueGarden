import { buildFeedGeneratorUri, isFeedGeneratorUri, isValidDid, isValidHandle, isValidRkey } from "../../domain/feedUri";
import { classifyError, GardenError } from "./errors";

const MAX_INPUT_LENGTH = 600;
const BSKY_APP_HOST = "bsky.app";

export type ParsedFeedInput =
  | { readonly kind: "uri"; readonly feedUri: string }
  | { readonly kind: "bskyUrl"; readonly actor: string; readonly rkey: string };

function isValidActor(actor: string): boolean {
  return isValidDid(actor) || isValidHandle(actor);
}

function parseBskyUrl(input: string): ParsedFeedInput | null {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.hostname !== BSKY_APP_HOST) return null;
  if (url.port !== "" || url.username !== "" || url.password !== "") return null;
  const segments = url.pathname.replace(/\/$/, "").split("/");
  const [leading, profile, actor, feed, rkey, ...rest] = segments;
  if (leading !== "" || profile !== "profile" || feed !== "feed" || rest.length > 0) return null;
  if (actor === undefined || rkey === undefined) return null;
  return isValidActor(actor) && isValidRkey(rkey) ? { kind: "bskyUrl", actor, rkey } : null;
}

/**
 * Recognizes `at://<did>/app.bsky.feed.generator/<rkey>` and
 * `https://bsky.app/profile/<handle-or-did>/feed/<rkey>`. Anything else yields null.
 */
export function parseFeedInput(input: string): ParsedFeedInput | null {
  const trimmed = input.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_INPUT_LENGTH) return null;
  if (trimmed.startsWith("at://")) {
    return isFeedGeneratorUri(trimmed) ? { kind: "uri", feedUri: trimmed } : null;
  }
  return parseBskyUrl(trimmed);
}

/**
 * Turns user input into `at://did/app.bsky.feed.generator/rkey`. A handle in a bsky.app URL is
 * resolved with `resolveHandle`. Throws GardenError only (`invalidFeedTarget` for bad input).
 */
export async function resolveFeedUri(
  input: string,
  resolveHandle: (handle: string) => Promise<string>,
): Promise<string> {
  const parsed = parseFeedInput(input);
  if (parsed === null) throw new GardenError("invalidFeedTarget");
  if (parsed.kind === "uri") return parsed.feedUri;
  if (isValidDid(parsed.actor)) return buildFeedGeneratorUri(parsed.actor, parsed.rkey);

  let did: string;
  try {
    did = await resolveHandle(parsed.actor);
  } catch (error) {
    const classified = classifyError(error, "feed");
    throw classified.kind === "unknown" ? new GardenError("invalidFeedTarget") : classified;
  }
  if (!isValidDid(did)) throw new GardenError("invalidFeedTarget");
  return buildFeedGeneratorUri(did, parsed.rkey);
}
