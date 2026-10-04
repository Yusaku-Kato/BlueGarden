import { describe, expect, it, vi } from "vitest";
import { BlueskyFeedClient, type FeedXrpc } from "./BlueskyFeedClient";

const FEED_URI = "at://did:plc:abcdefghijklmnopqrstuvwx/app.bsky.feed.generator/cool";
const view = {
  uri: "at://did:plc:test/app.bsky.feed.post/1",
  indexedAt: "2026-01-01T00:00:00.000Z",
  record: { text: "hi", createdAt: "2026-01-01T00:00:00.000Z" },
};

function createXrpc(overrides: Partial<FeedXrpc> = {}): FeedXrpc {
  return {
    getTimeline: () => Promise.resolve({ feed: [{ post: view }] }),
    getFeed: () => Promise.resolve({ feed: [{ post: view }] }),
    searchPosts: () => Promise.resolve({ posts: [view] }),
    ...overrides,
  };
}

const signal = new AbortController().signal;

describe("BlueskyFeedClient.fetchLatest", () => {
  it("reads the timeline", async () => {
    const posts = await new BlueskyFeedClient(createXrpc()).fetchLatest({ kind: "timeline" }, signal);
    expect(posts.map((post) => post.uri)).toEqual([view.uri]);
  });

  it("reads a custom feed with getFeed", async () => {
    const getFeed = vi.fn<FeedXrpc["getFeed"]>(() => Promise.resolve({ feed: [{ post: view }] }));
    const posts = await new BlueskyFeedClient(createXrpc({ getFeed })).fetchLatest(
      { kind: "custom", feedUri: FEED_URI },
      signal,
    );
    expect(posts).toHaveLength(1);
    expect(getFeed).toHaveBeenCalledWith({ feed: FEED_URI, limit: 50 }, signal);
  });

  it("searches keywords by latest with postViews", async () => {
    const searchPosts = vi.fn<FeedXrpc["searchPosts"]>(() => Promise.resolve({ posts: [view, 3] }));
    const posts = await new BlueskyFeedClient(createXrpc({ searchPosts })).fetchLatest(
      { kind: "keyword", query: "moss" },
      signal,
    );
    expect(posts).toHaveLength(1);
    expect(searchPosts).toHaveBeenCalledWith({ q: "moss", sort: "latest", limit: 50 }, signal);
  });

  it("rejects invalid targets without a request", async () => {
    const getFeed = vi.fn<FeedXrpc["getFeed"]>();
    const searchPosts = vi.fn<FeedXrpc["searchPosts"]>();
    const client = new BlueskyFeedClient(createXrpc({ getFeed, searchPosts }));
    await expect(client.fetchLatest({ kind: "custom", feedUri: "https://x" }, signal)).rejects.toMatchObject({
      kind: "invalidFeedTarget",
    });
    await expect(client.fetchLatest({ kind: "keyword", query: "  " }, signal)).rejects.toMatchObject({
      kind: "invalidFeedTarget",
    });
    expect(getFeed).not.toHaveBeenCalled();
    expect(searchPosts).not.toHaveBeenCalled();
  });

  it("keeps global unimplemented", async () => {
    await expect(new BlueskyFeedClient(createXrpc()).fetchLatest({ kind: "global" }, signal)).rejects.toMatchObject({
      kind: "notImplemented",
    });
  });

  it("classifies transport failures", async () => {
    const client = new BlueskyFeedClient(
      createXrpc({ getFeed: () => Promise.reject(Object.assign(new Error("x"), { error: "UnknownFeed" })), searchPosts: () => Promise.reject(new TypeError("offline")) }),
    );
    await expect(client.fetchLatest({ kind: "custom", feedUri: FEED_URI }, signal)).rejects.toMatchObject({ kind: "notFound" });
    await expect(client.fetchLatest({ kind: "keyword", query: "a" }, signal)).rejects.toMatchObject({ kind: "network" });
  });
});
