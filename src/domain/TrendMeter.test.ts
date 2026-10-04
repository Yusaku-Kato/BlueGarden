import { describe, expect, it } from "vitest";
import { TREND } from "../config/gardenConfig";
import { TrendMeter } from "./TrendMeter";

const snap = (ppm: number, pos = 0, neg = 0, sampleSize = 10) => ({
  postsPerMinute: ppm,
  positiveShare: pos,
  negativeShare: neg,
  sampleSize,
});

describe("TrendMeter", () => {
  it("starts empty", () => {
    expect(new TrendMeter().value()).toEqual({ ppm: 0, positiveShare: 0, negativeShare: 0, observedMs: 0 });
  });

  it("seeds from the first snapshot and tracks observed time", () => {
    const meter = new TrendMeter();
    meter.update(1_000, snap(40, 0.2, 0.1));
    meter.update(61_000, snap(40, 0.2, 0.1));
    const value = meter.value();
    expect(value.ppm).toBeCloseTo(40);
    expect(value.observedMs).toBe(60_000);
  });

  it("moves (1 - exp(-1)) of the way after one tau", () => {
    const meter = new TrendMeter();
    meter.update(0, snap(0));
    meter.update(TREND.TAU_MS, snap(100));
    expect(meter.value().ppm).toBeCloseTo(100 * (1 - Math.exp(-1)));
  });

  it("ignores shares of snapshots without samples", () => {
    const meter = new TrendMeter();
    meter.update(0, snap(10, 0.4, 0.2));
    meter.update(TREND.TAU_MS, snap(10, 0, 0, 0));
    expect(meter.value().positiveShare).toBeCloseTo(0.4);
  });

  it("handles non-monotonic or invalid time and resets", () => {
    const meter = new TrendMeter();
    meter.update(1_000, snap(10));
    meter.update(500, snap(50));
    meter.update(Number.NaN, snap(50));
    expect(meter.value().observedMs).toBe(0);
    meter.reset();
    expect(meter.value().ppm).toBe(0);
  });
});
