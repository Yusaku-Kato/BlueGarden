import { describe, expect, it } from "vitest";
import { PLANT } from "../config/gardenConfig";
import { evaluatePlant, lifeMsFor, swayRotation, windSway } from "./plantLifecycle";
import type { PlantLifecycleState } from "./plantLifecycle";

const base: PlantLifecycleState = {
  ageMs: 0,
  lifeMs: 180_000,
  growthDurationMs: 2_000,
  targetScale: 1.5,
  evictAtAgeMs: null,
};

function at(ageMs: number, overrides: Partial<PlantLifecycleState> = {}) {
  return evaluatePlant({ ...base, ageMs, ...overrides });
}

describe("evaluatePlant", () => {
  it("starts tiny and transparent", () => {
    const result = at(0);
    expect(result.phase).toBe("growing");
    expect(result.scale).toBeCloseTo(PLANT.INITIAL_SCALE);
    expect(result.alpha).toBe(0);
  });

  it("grows to the target scale with easeOutCubic at the growth boundary", () => {
    const halfway = at(1_000);
    expect(halfway.phase).toBe("growing");
    expect(halfway.scale).toBeCloseTo(0.01 + (1.5 - 0.01) * 0.875);
    const done = at(2_000);
    expect(done.phase).toBe("mature");
    expect(done.scale).toBeCloseTo(1.5);
  });

  it("fades in over FADE_IN_MS", () => {
    expect(at(PLANT.FADE_IN_MS / 2).alpha).toBeCloseTo(0.5);
    expect(at(PLANT.FADE_IN_MS).alpha).toBe(1);
  });

  it("is mature until the last FADE_MS, then fades linearly to dead", () => {
    const fadeStart = base.lifeMs - PLANT.FADE_MS;
    expect(at(fadeStart - 1).phase).toBe("mature");
    expect(at(fadeStart - 1).alpha).toBe(1);
    const fading = at(fadeStart);
    expect(fading.phase).toBe("fading");
    expect(fading.alpha).toBe(1);
    expect(at(fadeStart + PLANT.FADE_MS / 2).alpha).toBeCloseTo(0.5);
    expect(at(base.lifeMs).phase).toBe("dead");
    expect(at(base.lifeMs + 1_000).alpha).toBe(0);
  });

  it("evicting fades from the current alpha to zero over EVICTION_FADE_MS", () => {
    const evictAtAgeMs = 10_000;
    const start = at(evictAtAgeMs, { evictAtAgeMs });
    expect(start.phase).toBe("evicting");
    expect(start.alpha).toBeCloseTo(1);
    expect(at(evictAtAgeMs + PLANT.EVICTION_FADE_MS / 2, { evictAtAgeMs }).alpha).toBeCloseTo(0.5);
    expect(at(evictAtAgeMs + PLANT.EVICTION_FADE_MS, { evictAtAgeMs }).phase).toBe("dead");
  });

  it("a per-plant evictFadeMs overrides EVICTION_FADE_MS", () => {
    const evictAtAgeMs = 10_000;
    expect(at(evictAtAgeMs + 1_000, { evictAtAgeMs, evictFadeMs: 2_000 }).alpha).toBeCloseTo(0.5);
    expect(at(evictAtAgeMs + 2_000, { evictAtAgeMs, evictFadeMs: 2_000 }).phase).toBe("dead");
  });

  it("evicting during fade-in starts from the partial alpha", () => {
    const evictAtAgeMs = PLANT.FADE_IN_MS / 2;
    const result = at(evictAtAgeMs + PLANT.EVICTION_FADE_MS / 2, { evictAtAgeMs });
    expect(result.alpha).toBeCloseTo(0.25);
  });

  it("evicting during the natural fade starts from the faded alpha", () => {
    const evictAtAgeMs = base.lifeMs - PLANT.FADE_MS / 2;
    expect(at(evictAtAgeMs, { evictAtAgeMs }).alpha).toBeCloseTo(0.5);
  });

  it("is dead at lifeMs even when eviction is still in progress", () => {
    const evictAtAgeMs = base.lifeMs - 100;
    expect(at(base.lifeMs, { evictAtAgeMs }).phase).toBe("dead");
  });
});

describe("lifeMsFor", () => {
  it("stays within the jitter range", () => {
    const low = lifeMsFor(() => 0);
    const high = lifeMsFor(() => 1);
    expect(low).toBeCloseTo(PLANT.LIFETIME_MS * (1 - PLANT.LIFETIME_JITTER_RATIO));
    expect(high).toBeCloseTo(PLANT.LIFETIME_MS * (1 + PLANT.LIFETIME_JITTER_RATIO));
    expect(lifeMsFor(() => 0.5)).toBeCloseTo(PLANT.LIFETIME_MS);
  });

  it("clamps out-of-range random values", () => {
    expect(lifeMsFor(() => 5)).toBeCloseTo(high());
    expect(lifeMsFor(() => Number.NaN)).toBeCloseTo(low());
  });
});

function high(): number {
  return PLANT.LIFETIME_MS * (1 + PLANT.LIFETIME_JITTER_RATIO);
}
function low(): number {
  return PLANT.LIFETIME_MS * (1 - PLANT.LIFETIME_JITTER_RATIO);
}

describe("swayRotation", () => {
  it("never exceeds the wind amplitude", () => {
    for (let time = 0; time < 20_000; time += 137) {
      expect(Math.abs(swayRotation(time, 1.3))).toBeLessThanOrEqual(PLANT.WIND_AMPLITUDE);
    }
  });

  it("depends on the phase", () => {
    expect(swayRotation(0, 0)).toBe(0);
    expect(swayRotation(0, Math.PI / 2)).toBeCloseTo(PLANT.WIND_AMPLITUDE);
  });
});

describe("growth age, lifetime base and wind factor", () => {
  it("uses growthAgeMs for the growth tween but ageMs for the lifetime", () => {
    const fast = at(1_000, { growthAgeMs: 2_000 });
    expect(fast.phase).toBe("mature");
    expect(fast.scale).toBeCloseTo(1.5);
    expect(at(1_000).phase).toBe("growing");
    expect(at(180_000, { growthAgeMs: 0 }).phase).toBe("dead");
  });

  it("scales the lifetime base and keeps the jitter", () => {
    expect(lifeMsFor(() => 0.5, 60_000)).toBeCloseTo(60_000);
    expect(lifeMsFor(() => 0, 100_000)).toBeCloseTo(100_000 * (1 - PLANT.LIFETIME_JITTER_RATIO));
    expect(lifeMsFor(() => 1, 100_000)).toBeCloseTo(100_000 * (1 + PLANT.LIFETIME_JITTER_RATIO));
  });

  it("windSway equals swayRotation at factor 1 and scales linearly", () => {
    expect(windSway(1_234, 0.7, 1)).toBeCloseTo(swayRotation(1_234, 0.7));
    expect(windSway(1_234, 0.7, 2)).toBeCloseTo(2 * swayRotation(1_234, 0.7));
    expect(windSway(1_234, 0.7, 0)).toBe(0);
    expect(windSway(Number.NaN, 0, 1)).toBe(0);
  });
});
