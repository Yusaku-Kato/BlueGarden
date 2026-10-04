/** Strict syntax checks for AT Protocol identifiers used in feed targets. Pure, no I/O. */

const DID_MAX_LENGTH = 256;
const HANDLE_MAX_LENGTH = 253;
const RKEY_MAX_LENGTH = 512;

const DID_PATTERN = /^did:[a-z]+:[a-zA-Z0-9._:%-]*[a-zA-Z0-9._-]$/;
const HANDLE_LABEL_PATTERN = /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/;
const RKEY_PATTERN = /^[a-zA-Z0-9._:~-]+$/;
const FEED_GENERATOR_COLLECTION = "app.bsky.feed.generator";
const AT_PREFIX = "at://";

export function isValidDid(value: string): boolean {
  return value.length <= DID_MAX_LENGTH && DID_PATTERN.test(value);
}

export function isValidHandle(value: string): boolean {
  if (value.length === 0 || value.length > HANDLE_MAX_LENGTH) return false;
  const labels = value.split(".");
  if (labels.length < 2) return false;
  if (!labels.every((label) => HANDLE_LABEL_PATTERN.test(label))) return false;
  const tld = labels[labels.length - 1];
  return tld !== undefined && !/^[0-9]/.test(tld);
}

export function isValidRkey(value: string): boolean {
  return (
    value.length > 0 && value.length <= RKEY_MAX_LENGTH && value !== "." && value !== ".." && RKEY_PATTERN.test(value)
  );
}

export function buildFeedGeneratorUri(did: string, rkey: string): string {
  return `${AT_PREFIX}${did}/${FEED_GENERATOR_COLLECTION}/${rkey}`;
}

/** True only for `at://<did>/app.bsky.feed.generator/<rkey>` with nothing else. */
export function isFeedGeneratorUri(value: string): boolean {
  if (!value.startsWith(AT_PREFIX)) return false;
  const parts = value.slice(AT_PREFIX.length).split("/");
  if (parts.length !== 3) return false;
  const [did, collection, rkey] = parts;
  return (
    did !== undefined &&
    rkey !== undefined &&
    collection === FEED_GENERATOR_COLLECTION &&
    isValidDid(did) &&
    isValidRkey(rkey)
  );
}
