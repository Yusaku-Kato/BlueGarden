import { describe, expect, it } from "vitest";
import type { Mood } from "./models";
import { fnv1a32, PALETTES, pickColor } from "./plantPalette";

const MOODS: Mood[] = ["positive", "neutral", "negative"];

describe("pickColor", () => {
  it("is deterministic for the same URI", () => {
    const uri = "at://did:plc:test1/app.bsky.feed.post/1";
    expect(pickColor("positive", uri)).toBe(pickColor("positive", uri));
  });

  it("always returns a color from the mood palette", () => {
    for (const mood of MOODS) {
      for (let index = 0; index < 50; index += 1) {
        const color = pickColor(mood, `at://did:plc:test/app.bsky.feed.post/${index}`);
        expect(PALETTES[mood]).toContain(color);
      }
    }
  });

  it("uses more than one palette entry across URIs", () => {
    const colors = new Set<number>();
    for (let index = 0; index < 50; index += 1) {
      colors.add(pickColor("neutral", `at://did:plc:test/app.bsky.feed.post/${index}`));
    }
    expect(colors.size).toBeGreaterThan(1);
  });

  it("matches known FNV-1a 32-bit values", () => {
    expect(fnv1a32("")).toBe(0x811c9dc5);
    expect(fnv1a32("a")).toBe(0xe40c292c);
  });
});
