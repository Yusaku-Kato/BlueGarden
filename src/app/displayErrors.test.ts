import { describe, expect, it } from "vitest";
import type { GardenErrorKind } from "../services/bluesky/errors";
import { messageFor } from "./displayErrors";

const ALL_KINDS: readonly GardenErrorKind[] = [
  "invalidHandle",
  "invalidCredentials",
  "authFactorRequired",
  "accountUnavailable",
  "unsupportedPds",
  "sessionExpired",
  "network",
  "timeout",
  "rateLimited",
  "serverError",
  "notFound",
  "malformedResponse",
  "notImplemented",
  "invalidFeedTarget",
  "authCancelled",
  "secureStorageUnavailable",
  "unknown",
];

describe("messageFor", () => {
  it.each(ALL_KINDS)("has a non-empty message for %s in auth and feed contexts", (kind) => {
    expect(messageFor({ source: "auth", kind }).length).toBeGreaterThan(0);
    expect(messageFor({ source: "feed", kind }).length).toBeGreaterThan(0);
  });

  it.each(ALL_KINDS)("asks to pick another feed for target errors (%s)", (kind) => {
    expect(messageFor({ source: "target", kind })).toContain("別のフィード");
  });

  it("has messages for render errors", () => {
    expect(messageFor({ source: "render", kind: "initFailed" }).length).toBeGreaterThan(0);
    expect(messageFor({ source: "render", kind: "contextLost" }).length).toBeGreaterThan(0);
  });

  it("distinguishes login and feed rate limiting", () => {
    expect(messageFor({ source: "auth", kind: "rateLimited" })).not.toBe(
      messageFor({ source: "feed", kind: "rateLimited" }),
    );
  });
});
