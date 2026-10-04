import { describe, expect, it } from "vitest";
import {
  classifyError,
  GardenError,
  isSessionFatal,
  isTargetFatal,
  parseRateLimitReset,
  type GardenErrorKind,
} from "./errors";

/** Structural stand-ins for SDK failures. */
class FakeXrpcError extends Error {
  readonly status: number | undefined;
  readonly error: string;
  readonly headers: Headers | undefined;
  constructor(name: string, error: string, status?: number, headers?: Headers) {
    super(`secret-ish message ${name}`);
    this.name = name;
    this.error = error;
    this.status = status;
    this.headers = headers;
  }
}

const response = (status: number, error: string, headers?: Headers) =>
  new FakeXrpcError("XrpcResponseError", error, status, headers);

const NOW = 1_700_000_000_000;

function kindOf(error: unknown, context: "login" | "feed"): GardenErrorKind {
  return classifyError(error, context, NOW).kind;
}

describe("classifyError", () => {
  it("maps wrong credentials on login", () => {
    expect(kindOf(response(401, "AuthenticationRequired"), "login")).toBe("invalidCredentials");
    expect(kindOf(response(401, "Unknown"), "login")).toBe("invalidCredentials");
  });

  it("maps 401 / token errors on feed to sessionExpired", () => {
    expect(kindOf(response(401, "AuthenticationRequired"), "feed")).toBe("sessionExpired");
    expect(kindOf(response(401, "Whatever"), "feed")).toBe("sessionExpired");
    expect(kindOf(response(400, "ExpiredToken"), "feed")).toBe("sessionExpired");
    expect(kindOf(response(400, "InvalidToken"), "feed")).toBe("sessionExpired");
  });

  it("maps 2FA errors in both contexts", () => {
    const factor = new FakeXrpcError("LexAuthFactorError", "AuthFactorTokenRequired");
    expect(kindOf(factor, "login")).toBe("authFactorRequired");
    expect(kindOf(response(401, "AuthFactorTokenRequired"), "login")).toBe("authFactorRequired");
    expect(kindOf(factor, "feed")).toBe("authFactorRequired");
  });

  it("maps account takedown even when the status is 401", () => {
    expect(kindOf(response(401, "AccountTakedown"), "login")).toBe("accountUnavailable");
    expect(kindOf(response(400, "AccountTakedown"), "feed")).toBe("accountUnavailable");
  });

  it("maps aborts to timeout", () => {
    const abort = new DOMException("Aborted", "AbortError");
    expect(kindOf(abort, "feed")).toBe("timeout");
    const wrapped = new FakeXrpcError("XrpcFetchError", "InternalServerError");
    Object.defineProperty(wrapped, "cause", { value: abort });
    expect(kindOf(wrapped, "feed")).toBe("timeout");
  });

  it("maps fetch failures to network", () => {
    expect(kindOf(new TypeError("Failed to fetch"), "feed")).toBe("network");
    expect(kindOf(new FakeXrpcError("XrpcFetchError", "InternalServerError"), "login")).toBe("network");
  });

  it("maps 5xx to serverError", () => {
    expect(kindOf(response(500, "InternalServerError"), "feed")).toBe("serverError");
    expect(kindOf(response(503, "Unavailable"), "login")).toBe("serverError");
  });

  it("maps rate limits in both contexts", () => {
    expect(kindOf(response(429, "RateLimitExceeded"), "login")).toBe("rateLimited");
    expect(kindOf(response(429, "x"), "feed")).toBe("rateLimited");
  });

  it("maps invalid responses to malformedResponse", () => {
    const invalid = new FakeXrpcError("XrpcInvalidResponseError", "InvalidResponse");
    expect(kindOf(invalid, "feed")).toBe("malformedResponse");
    expect(kindOf(new GardenError("malformedResponse"), "feed")).toBe("malformedResponse");
  });

  it("maps BadQueryString to invalidFeedTarget", () => {
    expect(kindOf(response(400, "BadQueryString"), "feed")).toBe("invalidFeedTarget");
  });

  it("maps UnknownFeed to notFound", () => {
    expect(kindOf(response(400, "UnknownFeed"), "feed")).toBe("notFound");
  });

  it("falls back to unknown", () => {
    expect(kindOf(new Error("boom"), "feed")).toBe("unknown");
    expect(kindOf("string", "login")).toBe("unknown");
    expect(kindOf(undefined, "feed")).toBe("unknown");
    expect(kindOf(response(400, "Other"), "feed")).toBe("unknown");
  });

  it("passes an existing GardenError through", () => {
    const original = new GardenError("rateLimited", 5000);
    expect(classifyError(original, "feed")).toBe(original);
  });

  it("attaches retryAfterMs for rate limits from epoch-second headers", () => {
    const headers = new Headers({ "ratelimit-reset": String((NOW + 20_000) / 1000) });
    const error = classifyError(response(429, "RateLimitExceeded", headers), "feed", NOW);
    expect(error.retryAfterMs).toBe(20_000);
  });

  it("produces errors with a fixed message and no cause", () => {
    const source = response(401, "AuthenticationRequired");
    const error = classifyError(source, "login", NOW);
    expect(error.message).not.toContain("secret-ish");
    expect("cause" in error).toBe(false);
    expect(error.cause).toBeUndefined();
    const again = classifyError(new Error("another message"), "feed");
    expect(again.message).toBe(new GardenError("unknown").message);
  });
});

describe("parseRateLimitReset", () => {
  it("parses ratelimit-reset as epoch seconds", () => {
    const headers = new Headers({ "ratelimit-reset": String((NOW + 30_000) / 1000) });
    expect(parseRateLimitReset(headers, NOW)).toBe(30_000);
  });

  it("returns undefined for past, NaN, or missing values", () => {
    expect(parseRateLimitReset(new Headers({ "ratelimit-reset": String((NOW - 1000) / 1000) }), NOW)).toBeUndefined();
    expect(parseRateLimitReset(new Headers({ "ratelimit-reset": "abc" }), NOW)).toBeUndefined();
    expect(parseRateLimitReset(new Headers(), NOW)).toBeUndefined();
    expect(parseRateLimitReset(undefined, NOW)).toBeUndefined();
    expect(parseRateLimitReset({}, NOW)).toBeUndefined();
  });

  it("falls back to retry-after seconds", () => {
    expect(parseRateLimitReset(new Headers({ "retry-after": "12" }), NOW)).toBe(12_000);
    const both = new Headers({ "ratelimit-reset": "abc", "retry-after": "7" });
    expect(parseRateLimitReset(both, NOW)).toBe(7_000);
  });

  it("does not cap (the poller caps)", () => {
    const headers = new Headers({ "ratelimit-reset": String((NOW + 600_000) / 1000) });
    expect(parseRateLimitReset(headers, NOW)).toBe(600_000);
  });
});

describe("fatality predicates", () => {
  it.each<GardenErrorKind>(["sessionExpired", "invalidCredentials", "accountUnavailable", "unsupportedPds"])(
    "treats %s as session-fatal only",
    (kind) => {
      expect(isSessionFatal(kind)).toBe(true);
      expect(isTargetFatal(kind)).toBe(false);
    },
  );

  it.each<GardenErrorKind>(["notFound", "invalidFeedTarget", "notImplemented"])(
    "treats %s as target-fatal only",
    (kind) => {
      expect(isTargetFatal(kind)).toBe(true);
      expect(isSessionFatal(kind)).toBe(false);
    },
  );

  it.each<GardenErrorKind>(["network", "timeout", "rateLimited", "serverError", "malformedResponse", "authCancelled", "secureStorageUnavailable", "unknown"])(
    "treats %s as non-fatal",
    (kind) => {
      expect(isSessionFatal(kind)).toBe(false);
      expect(isTargetFatal(kind)).toBe(false);
    },
  );
});

describe("classifyError HTTP 404", () => {
  it("maps a bare 404 to notFound", () => {
    expect(classifyError({ status: 404 }, "feed").kind).toBe("notFound");
  });
});
