import { PLANT } from "../config/gardenConfig";

const REPOST_WEIGHT = 2; // SPEC §17

/** Clamp to [min, max]. NaN returns min. */
export function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min;
  return Math.min(max, Math.max(min, value));
}

/** Non-finite, negative and zero inputs become 0; fractions are floored. */
export function sanitizeCount(count: number): number {
  return Number.isFinite(count) && count > 0 ? Math.floor(count) : 0;
}

export function engagement(likeCount: number, repostCount: number): number {
  return sanitizeCount(likeCount) + sanitizeCount(repostCount) * REPOST_WEIGHT;
}

export function plantScale(engagementValue: number): number {
  return clamp(
    PLANT.SCALE_MIN + Math.log1p(sanitizeCount(engagementValue)) * PLANT.SCALE_LOG_FACTOR,
    PLANT.SCALE_MIN,
    PLANT.SCALE_MAX,
  );
}

export function growthDurationMs(engagementValue: number): number {
  return clamp(
    PLANT.GROWTH_BASE_MS - Math.log1p(sanitizeCount(engagementValue)) * PLANT.GROWTH_LOG_FACTOR_MS,
    PLANT.GROWTH_MIN_MS,
    PLANT.GROWTH_BASE_MS,
  );
}
