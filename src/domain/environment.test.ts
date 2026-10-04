import { describe, expect, it } from "vitest";
import { CLIMATE, TREND, WEATHER } from "../config/gardenConfig";
import { dayPhaseFromMinutes, deriveClimate, deriveWeather, nightness } from "./environment";
import type { TrendValue } from "./TrendMeter";

const trend = (overrides: Partial<TrendValue>): TrendValue => ({
  ppm: 0,
  positiveShare: 0,
  negativeShare: 0,
  observedMs: TREND.MIN_OBSERVED_MS,
  ...overrides,
});

describe("dayPhaseFromMinutes", () => {
  it("maps minutes to 0..1 and wraps", () => {
    expect(dayPhaseFromMinutes(0)).toBe(0);
    expect(dayPhaseFromMinutes(720)).toBe(0.5);
    expect(dayPhaseFromMinutes(1_440)).toBe(0);
    expect(dayPhaseFromMinutes(-360)).toBe(0.75);
    expect(dayPhaseFromMinutes(Number.NaN)).toBe(0);
  });
});

describe("nightness", () => {
  it("is 0 in daytime and 1 at midnight", () => {
    expect(nightness(0.5)).toBe(0);
    expect(nightness(WEATHER.FIREFLY_DAWN_PHASE)).toBe(0);
    expect(nightness(0)).toBe(1);
    expect(nightness(0.95)).toBe(1);
  });

  it("ramps at dusk and dawn", () => {
    expect(nightness(WEATHER.FIREFLY_DUSK_PHASE)).toBe(0);
    expect(nightness(WEATHER.FIREFLY_DUSK_PHASE + WEATHER.FIREFLY_TWILIGHT_WIDTH / 2)).toBeCloseTo(0.5);
    expect(nightness(WEATHER.FIREFLY_DAWN_PHASE - WEATHER.FIREFLY_TWILIGHT_WIDTH / 2)).toBeCloseTo(0.5);
  });
});

describe("deriveWeather", () => {
  it("is calm with no activity", () => {
    expect(deriveWeather({ postsPerMinute: 0, positiveShare: 0, negativeShare: 0 }, 0.5)).toEqual({
      postsPerMinute: 0,
      rain: 0,
      wind: 0,
      light: 0,
      fog: 0,
      fireflies: 0,
    });
  });

  it("ramps linearly and clamps at 1", () => {
    const mid = (WEATHER.WIND_START_PPM + WEATHER.WIND_FULL_PPM) / 2;
    expect(deriveWeather({ postsPerMinute: mid, positiveShare: 0, negativeShare: 0 }, 0.5).wind).toBeCloseTo(0.5);
    const full = deriveWeather({ postsPerMinute: 10_000, positiveShare: 1, negativeShare: 1 }, 0.5);
    expect([full.rain, full.wind, full.light, full.fog]).toEqual([1, 1, 1, 1]);
  });

  it("scales fireflies by night-ness", () => {
    const snapshot = { postsPerMinute: WEATHER.FIREFLY_FULL_PPM, positiveShare: 0, negativeShare: 0 };
    expect(deriveWeather(snapshot, 0.5).fireflies).toBe(0);
    expect(deriveWeather(snapshot, 0).fireflies).toBe(1);
  });

  it("sanitizes invalid input", () => {
    const weather = deriveWeather({ postsPerMinute: Number.NaN, positiveShare: Number.NaN, negativeShare: -1 }, Number.NaN);
    expect(weather.postsPerMinute).toBe(0);
    expect(weather.light).toBe(0);
    expect(weather.fog).toBe(0);
  });
});

describe("typical global traffic (measured shares: positive ~0.18, negative ~0.04)", () => {
  it("gives subtle light, no fog and a temperate climate", () => {
    const weather = deriveWeather({ postsPerMinute: 0, positiveShare: 0.18, negativeShare: 0.04 }, 0.5);
    expect(weather.light).toBeGreaterThan(0);
    expect(weather.light).toBeLessThan(0.3);
    expect(weather.fog).toBe(0);
    expect(deriveClimate(trend({ positiveShare: 0.18, negativeShare: 0.04 }), "temperate")).toBe("temperate");
  });

  it("shows fog only when negative share is clearly elevated", () => {
    expect(deriveWeather({ postsPerMinute: 0, positiveShare: 0, negativeShare: 0.15 }, 0.5).fog).toBeGreaterThan(0.3);
    expect(deriveClimate(trend({ negativeShare: 0.12 }), "temperate")).toBe("darkForest");
  });
});

describe("deriveClimate", () => {
  it("stays temperate until observed long enough", () => {
    expect(deriveClimate(trend({ negativeShare: 1, observedMs: TREND.MIN_OBSERVED_MS - 1 }), "temperate")).toBe(
      "temperate",
    );
  });

  it("enters each climate at its threshold", () => {
    expect(deriveClimate(trend({ ppm: CLIMATE.RAINY_PPM }), "temperate")).toBe("rainyGarden");
    expect(deriveClimate(trend({ positiveShare: CLIMATE.BLOOMING_POSITIVE_SHARE }), "temperate")).toBe(
      "bloomingGarden",
    );
    expect(deriveClimate(trend({ negativeShare: CLIMATE.DARK_NEGATIVE_SHARE }), "temperate")).toBe("darkForest");
    expect(deriveClimate(trend({ ppm: CLIMATE.RAINY_PPM - 1 }), "temperate")).toBe("temperate");
  });

  it("applies hysteresis before leaving a climate", () => {
    const inside = CLIMATE.RAINY_PPM * (1 - CLIMATE.HYSTERESIS / 2);
    const outside = CLIMATE.RAINY_PPM * (1 - CLIMATE.HYSTERESIS) - 0.1;
    expect(deriveClimate(trend({ ppm: inside }), "rainyGarden")).toBe("rainyGarden");
    expect(deriveClimate(trend({ ppm: inside }), "temperate")).toBe("temperate");
    expect(deriveClimate(trend({ ppm: outside }), "rainyGarden")).toBe("temperate");
  });

  it("uses the priority darkForest > rainyGarden > bloomingGarden", () => {
    const all = trend({ ppm: 100, positiveShare: 0.5, negativeShare: 0.5 });
    expect(deriveClimate(all, "temperate")).toBe("darkForest");
    expect(deriveClimate({ ...all, negativeShare: 0 }, "temperate")).toBe("rainyGarden");
    expect(deriveClimate({ ...all, negativeShare: 0, ppm: 0 }, "temperate")).toBe("bloomingGarden");
  });
});
