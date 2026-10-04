import { engagement, growthDurationMs, plantScale } from "./engagement";
import type { GardenPost, Mood, PlantSeed } from "./models";
import { pickColor } from "./plantPalette";

/** Converts a post to a PlantSeed. The result carries no post text or URI. */
export function toPlantSeed(post: GardenPost, mood: Mood, id: string): PlantSeed {
  const engagementValue = engagement(post.likeCount, post.repostCount);
  return {
    id,
    mood,
    color: pickColor(mood, post.uri),
    scale: plantScale(engagementValue),
    growthDurationMs: growthDurationMs(engagementValue),
    thorny: mood === "negative",
  };
}
