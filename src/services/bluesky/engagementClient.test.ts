import { describe, expect, it } from "vitest";
import { AFTER_GROWTH } from "../../config/gardenConfig";
import {
  createEngagementClient,
  createPublicEngagementClient,
  type FetchLike,
  normalizeEngagement,
} from "./engagementClient";
import { GardenError } from "./errors";

const DID = "did:plc:abcdefghijklmnopqrstuvwx";
const uri = (index: number): string => `at://${DID}/app.bsky.feed.post/3k${String(index).padStart(10, "0")}`;
const signal = (): AbortSignal => new AbortController().signal;

describe("normalizeEngagement", () => {
  it("reads counts, defaults missing ones to 0 and drops malformed items", () => {
    const map = normalizeEngagement({
      posts: [
        { uri: uri(1), likeCount: 5, repostCount: 2, record: { text: "ignored" } },
        { uri: uri(2) },
        { uri: uri(3), likeCount: -4, repostCount: Number.NaN },
        { uri: 7 },
        { uri: "https://example.test/x", likeCount: 1 },
        null,
      ],
    });
    expect(map.size).toBe(3);
    expect(map.get(uri(1))).toEqual({ likeCount: 5, repostCount: 2 });
    expect(map.get(uri(2))).toEqual({ likeCount: 0, repostCount: 0 });
    expect(map.get(uri(3))).toEqual({ likeCount: 0, repostCount: 0 });
  });

  it("throws malformedResponse when posts is not an array", () => {
    expect(() => normalizeEngagement({})).toThrow(GardenError);
    expect(() => normalizeEngagement(null)).toThrow(GardenError);
  });
});

describe("createEngagementClient", () => {
  it("splits requests into chunks of URIS_PER_CALL and merges the results", async () => {
    const sizes: number[] = [];
    const client = createEngagementClient((uris) => {
      sizes.push(uris.length);
      return Promise.resolve({ posts: uris.map((u) => ({ uri: u, likeCount: 1, repostCount: 0 })) });
    });
    const all = Array.from({ length: AFTER_GROWTH.URIS_PER_CALL * 2 + 3 }, (_v, index) => uri(index));
    const result = await client.fetchCounts(all, signal());
    expect(sizes).toEqual([AFTER_GROWTH.URIS_PER_CALL, AFTER_GROWTH.URIS_PER_CALL, 3]);
    expect(result.size).toBe(all.length);
  });

  it("omits posts the server did not return", async () => {
    const client = createEngagementClient(() => Promise.resolve({ posts: [{ uri: uri(1), likeCount: 3 }] }));
    const result = await client.fetchCounts([uri(1), uri(2)], signal());
    expect([...result.keys()]).toEqual([uri(1)]);
  });

  it("rejects with timeout when already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const client = createEngagementClient(() => Promise.resolve({ posts: [] }));
    await expect(client.fetchCounts([uri(1)], controller.signal)).rejects.toMatchObject({ kind: "timeout" });
  });
});

describe("createPublicEngagementClient", () => {
  function jsonResponse(body: unknown): Response {
    return new Response(JSON.stringify(body), { status: 200 });
  }

  it("calls the public getPosts endpoint with repeated uris params and no credentials", async () => {
    const calls: { url: string; headers: Record<string, string> }[] = [];
    const fetchImpl: FetchLike = (url, init) => {
      calls.push({ url, headers: init.headers });
      return Promise.resolve(jsonResponse({ posts: [{ uri: uri(1), likeCount: 9, repostCount: 4 }] }));
    };
    const client = createPublicEngagementClient(fetchImpl, "https://appview.example.test");
    const result = await client.fetchCounts([uri(1), "not-a-uri"], signal());
    expect(result.get(uri(1))).toEqual({ likeCount: 9, repostCount: 4 });
    const url = new URL(calls[0]?.url ?? "");
    expect(url.origin).toBe("https://appview.example.test");
    expect(url.pathname).toBe("/xrpc/app.bsky.feed.getPosts");
    expect(url.searchParams.getAll("uris")).toEqual([uri(1)]);
    expect(Object.keys(calls[0]?.headers ?? {})).toEqual(["accept"]);
  });

  it("does not call the network when no URI is valid", async () => {
    let called = false;
    const client = createPublicEngagementClient(() => {
      called = true;
      return Promise.resolve(jsonResponse({ posts: [] }));
    });
    expect((await client.fetchCounts(["x"], signal())).size).toBe(0);
    expect(called).toBe(false);
  });

  it("classifies HTTP and network failures", async () => {
    const limited = createPublicEngagementClient(() =>
      Promise.resolve(new Response("", { status: 429, headers: { "retry-after": "7" } })),
    );
    await expect(limited.fetchCounts([uri(1)], signal())).rejects.toMatchObject({
      kind: "rateLimited",
      retryAfterMs: 7_000,
    });
    const down = createPublicEngagementClient(() => Promise.reject(new TypeError("failed to fetch")));
    await expect(down.fetchCounts([uri(1)], signal())).rejects.toMatchObject({ kind: "network" });
    const server = createPublicEngagementClient(() => Promise.resolve(new Response("", { status: 503 })));
    await expect(server.fetchCounts([uri(1)], signal())).rejects.toMatchObject({ kind: "serverError" });
  });

  it("reports malformed bodies", async () => {
    const notJson = createPublicEngagementClient(() => Promise.resolve(new Response("<html>", { status: 200 })));
    await expect(notJson.fetchCounts([uri(1)], signal())).rejects.toMatchObject({ kind: "malformedResponse" });
    const wrongShape = createPublicEngagementClient(() => Promise.resolve(jsonResponse({ nope: 1 })));
    await expect(wrongShape.fetchCounts([uri(1)], signal())).rejects.toMatchObject({ kind: "malformedResponse" });
  });
});
