import { describe, expect, it } from "vitest";
import {
  classifyFeedFailure,
  isAllowedPdsUrl,
  looksLikeAppPassword,
  normalizeIdentifier,
  validateIdentifier,
} from "./blueskySession";

describe("normalizeIdentifier", () => {
  it("trims and strips a leading @", () => {
    expect(normalizeIdentifier("  @alice.test ")).toBe("alice.test");
    expect(normalizeIdentifier("alice.test")).toBe("alice.test");
  });
});

describe("validateIdentifier", () => {
  it("accepts a plain handle", () => {
    expect(validateIdentifier("alice.test")).toBeNull();
  });

  it("rejects empty, whitespace-containing and overlong identifiers", () => {
    expect(validateIdentifier("")?.kind).toBe("invalidHandle");
    expect(validateIdentifier("alice test")?.kind).toBe("invalidHandle");
    expect(validateIdentifier("a".repeat(254))?.kind).toBe("invalidHandle");
    expect(validateIdentifier("a".repeat(253))).toBeNull();
  });
});

describe("looksLikeAppPassword", () => {
  it("matches the xxxx-xxxx-xxxx-xxxx shape only", () => {
    expect(looksLikeAppPassword("abcd-efgh-ijkl-mnop")).toBe(true);
    expect(looksLikeAppPassword("not-an-app-password")).toBe(false);
    expect(looksLikeAppPassword("")).toBe(false);
  });
});

describe("isAllowedPdsUrl", () => {
  it("allows bsky.social and any depth of *.bsky.network over https", () => {
    expect(isAllowedPdsUrl("https://bsky.social")).toBe(true);
    expect(isAllowedPdsUrl("https://morel.us-east.host.bsky.network")).toBe(true);
    expect(isAllowedPdsUrl("https://a.bsky.network/")).toBe(true);
  });

  it("rejects other hosts, lookalikes, plain http, odd ports, and garbage", () => {
    expect(isAllowedPdsUrl("https://bsky.network")).toBe(false);
    expect(isAllowedPdsUrl("https://evilbsky.network")).toBe(false);
    expect(isAllowedPdsUrl("https://bsky.network.evil.test")).toBe(false);
    expect(isAllowedPdsUrl("https://sub.bsky.social")).toBe(false);
    expect(isAllowedPdsUrl("http://bsky.social")).toBe(false);
    expect(isAllowedPdsUrl("https://bsky.social:8443")).toBe(false);
    expect(isAllowedPdsUrl("https://user@bsky.social")).toBe(false);
    expect(isAllowedPdsUrl("not a url")).toBe(false);
  });
});

describe("classifyFeedFailure", () => {
  const expiredToken = { name: "XrpcResponseError", status: 400, error: "ExpiredToken" };
  const unauthorized = { name: "XrpcAuthenticationError", status: 401, error: "AuthenticationRequired" };

  it("treats an auth failure on a live session as retryable (transient refresh failure)", () => {
    const live = { destroyed: false };
    expect(classifyFeedFailure(expiredToken, live).kind).toBe("serverError");
    expect(classifyFeedFailure(unauthorized, live).kind).toBe("serverError");
  });

  it("reports sessionExpired only when the session was destroyed", () => {
    expect(classifyFeedFailure(expiredToken, { destroyed: true }).kind).toBe("sessionExpired");
  });

  it("passes other failures through unchanged", () => {
    const live = { destroyed: false };
    expect(classifyFeedFailure({ name: "XrpcResponseError", status: 503 }, live).kind).toBe("serverError");
    expect(classifyFeedFailure({ name: "XrpcResponseError", status: 429 }, live).kind).toBe("rateLimited");
  });
});
