import { describe, expect, it } from "vitest";
import { clamp, engagement, growthDurationMs, plantScale, sanitizeCount } from "./engagement";

describe("clamp", () => {
  it("clamps both ends and maps NaN to min", () => {
    expect(clamp(5, 0, 3)).toBe(3);
    expect(clamp(-1, 0, 3)).toBe(0);
    expect(clamp(2, 0, 3)).toBe(2);
    expect(clamp(Number.NaN, 1, 3)).toBe(1);
  });
});

describe("sanitizeCount", () => {
  it("returns 0 for negative, NaN and infinite input", () => {
    expect(sanitizeCount(-5)).toBe(0);
    expect(sanitizeCount(Number.NaN)).toBe(0);
    expect(sanitizeCount(Infinity)).toBe(0);
    expect(sanitizeCount(-Infinity)).toBe(0);
  });

  it("floors fractions", () => {
    expect(sanitizeCount(3.9)).toBe(3);
  });
});

describe("engagement", () => {
  it("is likes + reposts * 2", () => {
    expect(engagement(3, 4)).toBe(11);
    expect(engagement(0, 0)).toBe(0);
  });

  it("ignores invalid counts", () => {
    expect(engagement(-1, Number.NaN)).toBe(0);
    expect(engagement(Infinity, 2)).toBe(4);
  });
});

describe("plantScale / growthDurationMs", () => {
  it("matches the DESIGN table", () => {
    const table: [number, number, number][] = [
      [0, 0.75, 2500],
      [10, 1.13, 1901],
      [100, 1.49, 1346],
      [1000, 1.86, 1000],
      [10_000, 2.22, 1000],
    ];
    for (const [value, scale, growth] of table) {
      expect(plantScale(value)).toBeCloseTo(scale, 2);
      expect(growthDurationMs(value)).toBeCloseTo(growth, 0);
    }
  });

  it("hits the bounds for huge values", () => {
    expect(plantScale(1e9)).toBe(2.4);
    expect(plantScale(40_000)).toBe(2.4);
    expect(growthDurationMs(1e9)).toBe(1000);
  });

  it("is monotonic", () => {
    let previousScale = 0;
    let previousGrowth = Infinity;
    for (const value of [0, 1, 2, 5, 10, 50, 100, 500, 1000, 5000]) {
      expect(plantScale(value)).toBeGreaterThanOrEqual(previousScale);
      expect(growthDurationMs(value)).toBeLessThanOrEqual(previousGrowth);
      previousScale = plantScale(value);
      previousGrowth = growthDurationMs(value);
    }
  });

  it("stays in range for invalid input", () => {
    expect(plantScale(Number.NaN)).toBe(0.75);
    expect(plantScale(-10)).toBe(0.75);
    expect(growthDurationMs(Number.NaN)).toBe(2500);
  });
});
