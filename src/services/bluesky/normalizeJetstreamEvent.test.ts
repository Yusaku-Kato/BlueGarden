import { describe, expect, it } from "vitest";
import { BLUESKY } from "../../config/gardenConfig";
import { isPostCreateEvent, normalizeJetstreamEvent, readTimeUs } from "./normalizeJetstreamEvent";

const DID = "did:plc:abcdefghijklmnopqrstuvwx";

function event(overrides: Record<string, unknown> = {}, commit: Record<string, unknown> = {}): unknown {
  return {
    did: DID,
    timeUs: 1_700_000_000_000_000,
    kind: "commit",
    commit: {
      operation: "create",
      collection: "app.bsky.feed.post",
      rkey: "3kabcdefghij2",
      record: { text: "hello garden", createdAt: "2026-01-02T03:04:05.000Z" },
      ...commit,
    },
    ...overrides,
  };
}

describe("normalizeJetstreamEvent", () => {
  it("maps a create post to a GardenPost", () => {
    expect(normalizeJetstreamEvent(event())).toEqual({
      uri: `at://${DID}/app.bsky.feed.post/3kabcdefghij2`,
      text: "hello garden",
      createdAt: "2026-01-02T03:04:05.000Z",
      likeCount: 0,
      repostCount: 0,
    });
  });

  it("accepts the raw wire field time_us", () => {
    const wire = { did: DID, time_us: 1_700_000_000_000_000, kind: "commit", commit: { operation: "create", collection: "app.bsky.feed.post", rkey: "3kabcdefghij2", record: {} } };
    expect(normalizeJetstreamEvent(wire)?.createdAt).toBe(new Date(1_700_000_000_000).toISOString());
  });

  it("falls back to time_us when createdAt is invalid", () => {
    const post = normalizeJetstreamEvent(event({}, { record: { text: "x", createdAt: "garbage" } }));
    expect(post?.createdAt).toBe(new Date(1_700_000_000_000).toISOString());
  });

  it("truncates long text", () => {
    const post = normalizeJetstreamEvent(event({}, { record: { text: "a".repeat(10_000), createdAt: "2026-01-02T03:04:05Z" } }));
    expect(post?.text.length).toBe(BLUESKY.MAX_TEXT_LENGTH_FOR_ANALYSIS);
  });

  it("uses empty text when the record has none", () => {
    expect(normalizeJetstreamEvent(event({}, { record: { createdAt: "2026-01-02T03:04:05Z" } }))?.text).toBe("");
  });

  it.each([
    ["update", event({}, { operation: "update" })],
    ["delete", event({}, { operation: "delete" })],
    ["other collection", event({}, { collection: "app.bsky.feed.like" })],
    ["identity", event({ kind: "identity" })],
    ["bad did", event({ did: "did:plc:short" })],
    ["non-string did", event({ did: 5 })],
    ["bad rkey", event({}, { rkey: "a/b" })],
    ["dot rkey", event({}, { rkey: ".." })],
    ["missing rkey", event({}, { rkey: undefined })],
    ["no commit", { did: DID, kind: "commit" }],
    ["null", null],
    ["string", "text"],
  ])("returns null for %s", (_name, input) => {
    expect(normalizeJetstreamEvent(input)).toBeNull();
  });

  it("returns null when neither createdAt nor time_us is usable", () => {
    expect(normalizeJetstreamEvent(event({ timeUs: "x" }, { record: {} }))).toBeNull();
    expect(normalizeJetstreamEvent(event({ timeUs: -1 }, { record: {} }))).toBeNull();
  });
});

describe("isPostCreateEvent / readTimeUs", () => {
  it("looks only at kind, operation and collection", () => {
    expect(isPostCreateEvent({ kind: "commit", commit: { operation: "create", collection: "app.bsky.feed.post" } })).toBe(true);
    expect(isPostCreateEvent({ kind: "commit", commit: { operation: "create", collection: "x" } })).toBe(false);
    expect(readTimeUs({ timeUs: 1.5 })).toBeUndefined();
    expect(readTimeUs({ time_us: 7 })).toBe(7);
  });
});
