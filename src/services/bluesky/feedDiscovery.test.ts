import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLogSinkForTesting } from "../../infra/logger";
import { describeFeed, listSavedFeeds, resolveHandleToDid, type FeedDirectoryXrpc } from "./feedDiscovery";

const feedUri = (n: number) => `at://did:plc:abcdefghijklmnopqrstuvwx/app.bsky.feed.generator/feed${n}`;
const view = (n: number, displayName: unknown = `Feed ${n}`) => ({ uri: feedUri(n), displayName });
const item = (n: number, pinned: boolean, type = "feed") => ({ id: `i${n}`, type, value: feedUri(n), pinned });

let restoreLog: () => void;
beforeEach(() => {
  restoreLog = setLogSinkForTesting(() => undefined);
});
afterEach(() => {
  restoreLog();
});

function createXrpc(overrides: Partial<FeedDirectoryXrpc> = {}): FeedDirectoryXrpc {
  return {
    getPreferences: () => Promise.resolve({ preferences: [] }),
    getFeedGenerators: (uris) =>
      Promise.resolve({
        feeds: uris.map((uri) => ({ uri, displayName: `Name of ${uri.slice(-5)}` })),
      }),
    getFeedGenerator: () => Promise.resolve({ view: view(1) }),
    resolveHandle: () => Promise.resolve({ did: "did:plc:abc123" }),
    ...overrides,
  };
}

describe("listSavedFeeds", () => {
  it("lists feed items, pinned first, skipping non-feed types", async () => {
    const xrpc = createXrpc({
      getPreferences: () =>
        Promise.resolve({
          preferences: [
            { $type: "app.bsky.actor.defs#adultContentPref", enabled: true },
            {
              $type: "app.bsky.actor.defs#savedFeedsPrefV2",
              items: [item(1, false), item(2, true), item(3, true, "timeline"), item(4, false, "list"), item(5, true)],
            },
          ],
        }),
      getFeedGenerators: (uris) => Promise.resolve({ feeds: uris.map((uri, index) => ({ uri, displayName: `N${index}` })) }),
    });
    expect(await listSavedFeeds(xrpc)).toEqual([
      { uri: feedUri(2), displayName: "N0" },
      { uri: feedUri(5), displayName: "N1" },
      { uri: feedUri(1), displayName: "N2" },
    ]);
  });

  it("falls back to the legacy preference", async () => {
    const xrpc = createXrpc({
      getPreferences: () =>
        Promise.resolve({
          preferences: [{ $type: "app.bsky.actor.defs#savedFeedsPref", pinned: [feedUri(1)], saved: [feedUri(1), feedUri(2), 7] }],
        }),
    });
    expect((await listSavedFeeds(xrpc)).map((entry) => entry.uri)).toEqual([feedUri(1), feedUri(2)]);
  });

  it("chunks name lookups by 25 and caps the total at 50", async () => {
    const items = Array.from({ length: 80 }, (_, index) => item(index, false));
    const getFeedGenerators = vi.fn<FeedDirectoryXrpc["getFeedGenerators"]>((uris) =>
      Promise.resolve({ feeds: uris.map((uri) => ({ uri, displayName: "x" })) }),
    );
    const xrpc = createXrpc({
      getPreferences: () => Promise.resolve({ preferences: [{ $type: "app.bsky.actor.defs#savedFeedsPrefV2", items }] }),
      getFeedGenerators,
    });
    expect(await listSavedFeeds(xrpc)).toHaveLength(50);
    expect(getFeedGenerators.mock.calls.map(([uris]) => uris.length)).toEqual([25, 25]);
  });

  it("drops invalid URIs, duplicates and feeds without names", async () => {
    const xrpc = createXrpc({
      getPreferences: () =>
        Promise.resolve({
          preferences: [
            {
              $type: "app.bsky.actor.defs#savedFeedsPrefV2",
              items: [item(1, true), item(1, false), { type: "feed", value: "https://x", pinned: true }, item(2, false), null, 5],
            },
          ],
        }),
      getFeedGenerators: () => Promise.resolve({ feeds: [view(1), view(2, "   "), { uri: 3 }, null] }),
    });
    expect(await listSavedFeeds(xrpc)).toEqual([{ uri: feedUri(1), displayName: "Feed 1" }]);
  });

  it("returns an empty list on malformed bodies and failures", async () => {
    expect(await listSavedFeeds(createXrpc({ getPreferences: () => Promise.resolve("junk") }))).toEqual([]);
    expect(await listSavedFeeds(createXrpc({ getPreferences: () => Promise.reject(new TypeError("offline")) }))).toEqual([]);
    const failingNames = createXrpc({
      getPreferences: () =>
        Promise.resolve({ preferences: [{ $type: "app.bsky.actor.defs#savedFeedsPrefV2", items: [item(1, true)] }] }),
      getFeedGenerators: () => Promise.reject(new Error("boom")),
    });
    expect(await listSavedFeeds(failingNames)).toEqual([]);
  });
});

describe("describeFeed", () => {
  it("returns the display name", async () => {
    expect(await describeFeed(createXrpc(), feedUri(1))).toBe("Feed 1");
  });

  it("throws notFound for a nameless view or an unknown feed", async () => {
    await expect(describeFeed(createXrpc({ getFeedGenerator: () => Promise.resolve({}) }), feedUri(1))).rejects.toMatchObject({
      kind: "notFound",
    });
    const unknown = createXrpc({ getFeedGenerator: () => Promise.reject(Object.assign(new Error("x"), { error: "UnknownFeed" })) });
    await expect(describeFeed(unknown, feedUri(1))).rejects.toMatchObject({ kind: "notFound" });
  });

  it("rejects invalid URIs without a request", async () => {
    const getFeedGenerator = vi.fn<FeedDirectoryXrpc["getFeedGenerator"]>();
    await expect(describeFeed(createXrpc({ getFeedGenerator }), "nope")).rejects.toMatchObject({
      kind: "invalidFeedTarget",
    });
    expect(getFeedGenerator).not.toHaveBeenCalled();
  });
});

describe("resolveHandleToDid", () => {
  it("returns a valid DID and rejects malformed bodies", async () => {
    expect(await resolveHandleToDid(createXrpc(), "alice.example.com")).toBe("did:plc:abc123");
    const bad = createXrpc({ resolveHandle: () => Promise.resolve({ did: "nope" }) });
    await expect(resolveHandleToDid(bad, "alice.example.com")).rejects.toMatchObject({ kind: "malformedResponse" });
  });
});
