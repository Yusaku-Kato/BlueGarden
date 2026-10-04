import { describe, expect, it } from "vitest";
import { createGuestAccess } from "./guestAccess";

describe("createGuestAccess", () => {
  it("has its own bounded seen-post cache and an engagement client, and logout clears the cache", async () => {
    const first = createGuestAccess();
    const second = createGuestAccess();
    expect(first.authMethod).toBe("guest");
    expect(first.seenPosts).not.toBe(second.seenPosts);
    expect(first.engagementClient).toBeDefined();
    first.seenPosts.markIfNew("at://did:plc:abcdefghijklmnopqrstuvwx/app.bsky.feed.post/1");
    await first.logout();
    await first.logout();
    expect(first.seenPosts.size).toBe(0);
  });
});
