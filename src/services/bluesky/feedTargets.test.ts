import { describe, expect, it, vi } from "vitest";
import { GardenError } from "./errors";
import { parseFeedInput, resolveFeedUri } from "./feedTargets";

const DID = "did:plc:abcdefghijklmnopqrstuvwx";
const URI = `at://${DID}/app.bsky.feed.generator/cool-feed`;

describe("parseFeedInput", () => {
  it("accepts generator URIs", () => {
    expect(parseFeedInput(`  ${URI}  `)).toEqual({ kind: "uri", feedUri: URI });
  });

  it("accepts bsky.app feed URLs with handle or DID", () => {
    expect(parseFeedInput("https://bsky.app/profile/alice.example.com/feed/cool-feed")).toEqual({
      kind: "bskyUrl",
      actor: "alice.example.com",
      rkey: "cool-feed",
    });
    expect(parseFeedInput(`https://bsky.app/profile/${DID}/feed/cool-feed/`)).toEqual({
      kind: "bskyUrl",
      actor: DID,
      rkey: "cool-feed",
    });
  });

  it("rejects everything else", () => {
    const bad = [
      "",
      "   ",
      "cool-feed",
      `at://${DID}/app.bsky.feed.post/1`,
      `at://${DID}/app.bsky.feed.generator/`,
      `at://${DID}/app.bsky.feed.generator/a/b`,
      "at://alice.example.com/app.bsky.feed.generator/x",
      "http://bsky.app/profile/alice.example.com/feed/x",
      "https://evil.example/profile/alice.example.com/feed/x",
      "https://bsky.app.evil.example/profile/alice.example.com/feed/x",
      "https://user@bsky.app/profile/alice.example.com/feed/x",
      "https://bsky.app/profile/alice.example.com/lists/x",
      "https://bsky.app/profile/alice.example.com/feed/x/extra",
      "https://bsky.app/profile/not a handle/feed/x",
      "https://bsky.app/profile/alice/feed/x",
      "https://bsky.app/profile/alice.example.com/feed/..",
      `at://${DID}/app.bsky.feed.generator/${"a".repeat(700)}`,
    ];
    for (const input of bad) expect(parseFeedInput(input), input).toBeNull();
  });
});

describe("resolveFeedUri", () => {
  it("returns URIs and DID-based URLs without resolving", async () => {
    const resolve = vi.fn<(handle: string) => Promise<string>>();
    expect(await resolveFeedUri(URI, resolve)).toBe(URI);
    expect(await resolveFeedUri(`https://bsky.app/profile/${DID}/feed/cool-feed`, resolve)).toBe(URI);
    expect(resolve).not.toHaveBeenCalled();
  });

  it("resolves handles", async () => {
    const resolve = vi.fn<(handle: string) => Promise<string>>(() => Promise.resolve(DID));
    expect(await resolveFeedUri("https://bsky.app/profile/alice.example.com/feed/cool-feed", resolve)).toBe(URI);
    expect(resolve).toHaveBeenCalledWith("alice.example.com");
  });

  it("throws invalidFeedTarget for bad input or a bad resolved DID", async () => {
    const resolve = () => Promise.resolve("not-a-did");
    await expect(resolveFeedUri("nope", resolve)).rejects.toMatchObject({ kind: "invalidFeedTarget" });
    await expect(
      resolveFeedUri("https://bsky.app/profile/alice.example.com/feed/x", resolve),
    ).rejects.toMatchObject({ kind: "invalidFeedTarget" });
  });

  it("maps resolver failures to GardenError", async () => {
    const url = "https://bsky.app/profile/alice.example.com/feed/x";
    await expect(resolveFeedUri(url, () => Promise.reject(new Error("Unable to resolve")))).rejects.toMatchObject({
      kind: "invalidFeedTarget",
    });
    await expect(resolveFeedUri(url, () => Promise.reject(new TypeError("offline")))).rejects.toMatchObject({
      kind: "network",
    });
    await expect(resolveFeedUri(url, () => Promise.reject(new GardenError("rateLimited")))).rejects.toBeInstanceOf(
      GardenError,
    );
  });
});
