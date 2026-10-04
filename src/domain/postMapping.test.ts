import { describe, expect, it } from "vitest";
import type { GardenPost, Mood } from "./models";
import { toPlantSeed } from "./postMapping";

const POST: GardenPost = {
  uri: "at://did:plc:test/app.bsky.feed.post/1",
  text: "synthetic text",
  createdAt: "2026-01-01T00:00:00.000Z",
  likeCount: 10,
  repostCount: 0,
};

const ALLOWED_KEYS = ["color", "growthDurationMs", "id", "mood", "scale", "thorny"];

describe("toPlantSeed", () => {
  it("returns exactly the PlantSeed keys", () => {
    const seed = toPlantSeed(POST, "positive", "plant-1");
    expect(Object.keys(seed).sort()).toEqual(ALLOWED_KEYS);
    expect(seed.id).toBe("plant-1");
  });

  it("sets thorny only for negative mood", () => {
    const moods: Mood[] = ["positive", "neutral", "negative"];
    for (const mood of moods) {
      expect(toPlantSeed(POST, mood, "plant-1").thorny).toBe(mood === "negative");
    }
  });

  it("maps engagement to scale and growth", () => {
    const seed = toPlantSeed(POST, "neutral", "plant-2");
    expect(seed.scale).toBeCloseTo(1.13, 2);
    expect(seed.growthDurationMs).toBeCloseTo(1901, 0);
  });

  it("contains no post text or URI", () => {
    const serialized = JSON.stringify(toPlantSeed(POST, "neutral", "plant-3"));
    expect(serialized).not.toContain("synthetic text");
    expect(serialized).not.toContain("at://");
  });
});
