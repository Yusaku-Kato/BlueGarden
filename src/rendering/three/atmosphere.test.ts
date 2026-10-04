import { describe, expect, it } from "vitest";
import {
  computeBloomStrength,
  computeFlowerGlow,
  computeFogDensity,
  computeLighting,
  dayAmount,
  sunElevation,
} from "./atmosphere";

describe("atmosphere", () => {
  it("puts the sun high at noon and below the horizon at midnight", () => {
    expect(sunElevation(0.5)).toBeCloseTo(1);
    expect(sunElevation(0)).toBeCloseTo(-1);
    expect(sunElevation(0.25)).toBeCloseTo(0);
  });

  it("is full day at noon and full night at midnight", () => {
    expect(dayAmount(0.5)).toBeCloseTo(1);
    expect(dayAmount(0)).toBeCloseTo(0);
  });

  it("uses the sun by day and the dimmer moon by night", () => {
    const noon = computeLighting(0.5, 0, "temperate");
    const midnight = computeLighting(0, 0, "temperate");
    expect(noon.directionalIntensity).toBeGreaterThan(midnight.directionalIntensity);
    expect(midnight.directionalIntensity).toBeGreaterThan(0);
    expect(noon.hemisphereIntensity).toBeGreaterThan(midnight.hemisphereIntensity);
    for (const lighting of [noon, midnight]) {
      expect(Math.hypot(lighting.directionX, lighting.directionY, lighting.directionZ)).toBeCloseTo(1);
      expect(lighting.directionY).toBeGreaterThan(0);
    }
  });

  it("brightens with weather.light and dims in a dark forest", () => {
    expect(computeLighting(0.5, 1, null).hemisphereIntensity).toBeGreaterThan(
      computeLighting(0.5, 0, null).hemisphereIntensity,
    );
    expect(computeLighting(0.5, 0, "darkForest").hemisphereIntensity).toBeLessThan(
      computeLighting(0.5, 0, "temperate").hemisphereIntensity,
    );
  });

  it("copes with non-finite input", () => {
    const lighting = computeLighting(Number.NaN, Number.NaN, null);
    expect(Number.isFinite(lighting.hemisphereIntensity)).toBe(true);
    expect(Number.isFinite(lighting.directionX)).toBe(true);
  });

  it("thickens the fog with weather.fog and climate, and ignores them when switched off", () => {
    const calm = computeFogDensity(0, "temperate", true);
    expect(computeFogDensity(1, "temperate", true)).toBeGreaterThan(calm);
    expect(computeFogDensity(0, "darkForest", true)).toBeGreaterThan(calm);
    expect(computeFogDensity(1, null, false)).toBe(computeFogDensity(0, null, true));
    expect(computeFogDensity(Number.NaN, null, true)).toBe(computeFogDensity(0, null, true));
  });

  it("raises bloom and flower glow at night, and glow needs the bloom toggle", () => {
    expect(computeBloomStrength(1)).toBeGreaterThan(computeBloomStrength(0));
    expect(computeFlowerGlow(1, true)).toBeGreaterThan(computeFlowerGlow(0, true));
    expect(computeFlowerGlow(1, false)).toBe(0);
  });
});
