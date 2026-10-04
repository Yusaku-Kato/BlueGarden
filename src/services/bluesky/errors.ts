import { readNumber, readProp, readString } from "./untrusted";

export type GardenErrorKind =
  | "invalidHandle"
  | "invalidCredentials"
  | "authFactorRequired"
  | "accountUnavailable"
  | "unsupportedPds"
  | "sessionExpired"
  | "network"
  | "timeout"
  | "rateLimited"
  | "serverError"
  | "notFound"
  | "malformedResponse"
  | "notImplemented"
  | "invalidFeedTarget"
  | "authCancelled"
  | "secureStorageUnavailable"
  | "unknown";

/** Errors that end the session: the UI returns to the login screen (DESIGN §35.4). */
export function isSessionFatal(kind: GardenErrorKind): boolean {
  return (
    kind === "sessionExpired" ||
    kind === "invalidCredentials" ||
    kind === "accountUnavailable" ||
    kind === "unsupportedPds"
  );
}

/** Errors that end the current feed but not the session (DESIGN §35.4). */
export function isTargetFatal(kind: GardenErrorKind): boolean {
  return kind === "notFound" || kind === "invalidFeedTarget" || kind === "notImplemented";
}

export type ErrorContext = "login" | "feed";

/** Fixed, secret-free messages (docs/DESIGN.md §21). */
const MESSAGES: Readonly<Record<GardenErrorKind, string>> = {
  invalidHandle: "Invalid handle format.",
  invalidCredentials: "Incorrect handle or App Password.",
  authFactorRequired: "Use an App Password instead of your regular password.",
  accountUnavailable: "This account cannot be used.",
  unsupportedPds: "The server for this account is not supported.",
  sessionExpired: "The session has expired. Please sign in again.",
  network: "Cannot connect to the network.",
  timeout: "No response from Bluesky.",
  rateLimited: "Rate limited by Bluesky.",
  serverError: "Bluesky returned a server error.",
  notFound: "The feed was not found.",
  malformedResponse: "Received an unexpected response from Bluesky.",
  notImplemented: "This feed type is not supported yet.",
  invalidFeedTarget: "The feed address or search term is not valid.",
  authCancelled: "Sign-in was cancelled.",
  secureStorageUnavailable: "Secure storage is unavailable; the sign-in will not be remembered.",
  unknown: "An unexpected error occurred.",
};

/** The only error type the services layer throws. Never carries a cause or raw SDK data. */
export class GardenError extends Error {
  readonly kind: GardenErrorKind;
  /** Milliseconds until the rate limit resets. Set only for `rateLimited`, when known. */
  readonly retryAfterMs?: number;

  constructor(kind: GardenErrorKind, retryAfterMs?: number) {
    super(MESSAGES[kind]);
    this.name = "GardenError";
    this.kind = kind;
    if (retryAfterMs !== undefined) this.retryAfterMs = retryAfterMs;
  }
}

/** Minimal shape of a Headers-like object. */
export interface HeaderReader {
  get(name: string): string | null;
}

function isHeaderReader(value: unknown): value is HeaderReader {
  return typeof readProp(value, "get") === "function";
}

function parseSeconds(raw: string | null): number | undefined {
  if (raw === null || raw.trim() === "") return undefined;
  const seconds = Number(raw);
  return Number.isFinite(seconds) ? seconds : undefined;
}

/**
 * Milliseconds to wait according to rate-limit headers, or undefined when absent,
 * unparsable, or already in the past. `ratelimit-reset` is epoch seconds;
 * `retry-after` is a delay in seconds. The result is NOT capped here (the poller caps it).
 */
export function parseRateLimitReset(headers: unknown, nowMs: number): number | undefined {
  if (!isHeaderReader(headers)) return undefined;
  const resetEpochSeconds = parseSeconds(headers.get("ratelimit-reset"));
  if (resetEpochSeconds !== undefined) {
    const waitMs = resetEpochSeconds * 1000 - nowMs;
    if (waitMs > 0) return waitMs;
  }
  const retryAfterSeconds = parseSeconds(headers.get("retry-after"));
  if (retryAfterSeconds !== undefined && retryAfterSeconds > 0) return retryAfterSeconds * 1000;
  return undefined;
}

function isAbort(error: unknown): boolean {
  const names = [readString(error, "name"), readString(readProp(error, "cause"), "name")];
  return names.some((name) => name === "AbortError" || name === "TimeoutError");
}

function classifyByCode(code: string | undefined, context: ErrorContext): GardenErrorKind | null {
  switch (code) {
    case "AuthFactorTokenRequired":
      return "authFactorRequired";
    case "AccountTakedown":
    case "AccountDeactivated":
      return "accountUnavailable";
    case "RateLimitExceeded":
      return "rateLimited";
    case "UnknownFeed":
      return "notFound";
    case "BadQueryString":
      return "invalidFeedTarget";
    case "AuthenticationRequired":
      return context === "login" ? "invalidCredentials" : "sessionExpired";
    case "ExpiredToken":
    case "InvalidToken":
      return context === "feed" ? "sessionExpired" : null;
    default:
      return null;
  }
}

function classifyByStatus(status: number | undefined, context: ErrorContext): GardenErrorKind | null {
  if (status === undefined) return null;
  if (status === 429) return "rateLimited";
  if (status === 404) return "notFound";
  if (status === 401) return context === "login" ? "invalidCredentials" : "sessionExpired";
  if (status >= 500) return "serverError";
  return null;
}

function classifyByType(error: unknown): GardenErrorKind | null {
  const name = readString(error, "name");
  if (name === "LexAuthFactorError") return "authFactorRequired";
  if (name === "XrpcInvalidResponseError" || name === "XrpcResponseValidationError") {
    return "malformedResponse";
  }
  if (name === "XrpcFetchError" || error instanceof TypeError) return "network";
  return null;
}

/**
 * Converts any thrown value into a GardenError (docs/DESIGN.md §20.1).
 * The original value is discarded: no message, cause or stack is carried over.
 * Abort-like errors are reported as `timeout`; callers that abort on purpose
 * (stop/pause) must filter those before classifying.
 */
export function classifyError(
  error: unknown,
  context: ErrorContext,
  now: number = Date.now(),
): GardenError {
  if (error instanceof GardenError) return error;
  if (isAbort(error)) return new GardenError("timeout");

  const kind =
    classifyByCode(readString(error, "error"), context) ??
    classifyByStatus(readNumber(error, "status"), context) ??
    classifyByType(error) ??
    "unknown";

  if (kind === "rateLimited") {
    return new GardenError(kind, parseRateLimitReset(readProp(error, "headers"), now));
  }
  return new GardenError(kind);
}

