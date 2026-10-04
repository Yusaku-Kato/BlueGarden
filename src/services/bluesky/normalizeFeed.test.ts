import { describe, expect, it } from "vitest";
import { GardenError } from "./errors";
import { normalizeFeed, normalizePostViews } from "./normalizeFeed";

const URI = "at://did:plc:test/app.bsky.feed.post/1";

function item(overrides: Record<string, unknown> = {}, recordOverrides: Record<string, unknown> = {}) {
  return {
    post: {
      uri: URI,
      indexedAt: "2026-01-01T00:00:01.000Z",
      likeCount: 3,
      repostCount: 2,
      record: { text: "hello", createdAt: "2026-01-01T00:00:00.000Z", ...recordOverrides },
      ...overrides,
    },
  };
}

function malformedKind(raw: unknown): string | undefined {
  try {
    normalizeFeed(raw);
  } catch (error) {
    return error instanceof GardenError ? error.kind : "other";
  }
  return undefined;
}

describe("normalizeFeed", () => {
  it("normalizes a valid item", () => {
    expect(normalizeFeed({ feed: [item()] })).toEqual([
      {
        uri: URI,
        text: "hello",
        createdAt: "2026-01-01T00:00:00.000Z",
        likeCount: 3,
        repostCount: 2,
      },
    ]);
  });

  it("treats an empty feed as success", () => {
    expect(normalizeFeed({ feed: [] })).toEqual([]);
  });

  it("defaults missing, negative and non-finite counts to 0", () => {
    const [first, second] = normalizeFeed({
      feed: [
        item({ likeCount: undefined, repostCount: undefined }),
        item({ uri: "at://x/2", likeCount: -4, repostCount: Number.NaN }),
      ],
    });
    expect(first).toMatchObject({ likeCount: 0, repostCount: 0 });
    expect(second).toMatchObject({ likeCount: 0, repostCount: 0 });
  });

  it("defaults missing text to an empty string", () => {
    const [post] = normalizeFeed({ feed: [item({ record: { createdAt: "2026-01-01T00:00:00Z" } })] });
    expect(post?.text).toBe("");
  });

  it("truncates long text to 3000 characters", () => {
    const [post] = normalizeFeed({ feed: [item({}, { text: "a".repeat(5000) })] });
    expect(post?.text).toHaveLength(3000);
  });

  it("falls back to indexedAt when createdAt is invalid", () => {
    const [post] = normalizeFeed({ feed: [item({}, { createdAt: "not a date" })] });
    expect(post?.createdAt).toBe("2026-01-01T00:00:01.000Z");
  });

  it("drops items without a usable uri or date but keeps valid ones", () => {
    const posts = normalizeFeed({
      feed: [
        item({ uri: undefined }),
        item({ uri: 42 }),
        item({ uri: "https://example.test/1" }),
        item({ indexedAt: "bad" }, { createdAt: "bad" }),
        "garbage",
        null,
        item({ uri: "at://x/ok" }),
      ],
    });
    expect(posts.map((post) => post.uri)).toEqual(["at://x/ok"]);
  });

  it("accepts repost items (uri is the original post)", () => {
    const repost = { ...item(), reason: { $type: "app.bsky.feed.defs#reasonRepost" } };
    expect(normalizeFeed({ feed: [repost] })).toHaveLength(1);
  });

  it("throws malformedResponse when feed is not an array", () => {
    expect(malformedKind({ feed: "x" })).toBe("malformedResponse");
    expect(malformedKind({})).toBe("malformedResponse");
    expect(malformedKind(null)).toBe("malformedResponse");
    expect(malformedKind("text")).toBe("malformedResponse");
  });

  it("throws malformedResponse when a non-empty feed has no valid item", () => {
    expect(malformedKind({ feed: [item({ uri: undefined }), 5] })).toBe("malformedResponse");
  });

  it("returns fresh objects without references to the raw data", () => {
    const raw = { feed: [item()] };
    const [post] = normalizeFeed(raw);
    expect(post).not.toBe(raw.feed[0]);
    expect(Object.keys(post ?? {}).sort()).toEqual([
      "createdAt",
      "likeCount",
      "repostCount",
      "text",
      "uri",
    ]);
  });
});

describe("normalizePostViews", () => {
  it("normalizes bare postViews and drops malformed ones", () => {
    const view = item().post;
    const posts = normalizePostViews({ posts: [view, { uri: "https://x" }, 7] });
    expect(posts).toEqual([
      { uri: URI, text: "hello", createdAt: "2026-01-01T00:00:00.000Z", likeCount: 3, repostCount: 2 },
    ]);
  });

  it("defaults missing counts and accepts an empty list", () => {
    const view = item({ likeCount: undefined, repostCount: "x" }).post;
    expect(normalizePostViews({ posts: [view] })[0]).toMatchObject({ likeCount: 0, repostCount: 0 });
    expect(normalizePostViews({ posts: [] })).toEqual([]);
  });

  it("throws malformedResponse for a non-array or an all-invalid list", () => {
    for (const raw of [{}, null, { posts: "x" }, { feed: [] }, { posts: [1, 2] }]) {
      expect(() => normalizePostViews(raw)).toThrow(GardenError);
    }
  });
});
