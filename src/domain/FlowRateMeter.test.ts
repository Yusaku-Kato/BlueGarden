import { describe, expect, it } from "vitest";
import { FlowRateMeter } from "./FlowRateMeter";

describe("FlowRateMeter", () => {
  it("sums counts inside the 60 s window", () => {
    const meter = new FlowRateMeter();
    meter.record(0, 5);
    meter.record(15_000, 3);
    expect(meter.postsPerMinute(15_000)).toBe(8);
  });

  it("prunes entries outside the window", () => {
    const meter = new FlowRateMeter();
    meter.record(0, 5);
    meter.record(30_000, 2);
    expect(meter.postsPerMinute(59_999)).toBe(7);
    expect(meter.postsPerMinute(60_000)).toBe(2);
    expect(meter.postsPerMinute(120_000)).toBe(0);
  });

  it("caps stored entries", () => {
    const meter = new FlowRateMeter();
    for (let index = 0; index < 200; index += 1) meter.record(index, 1);
    expect(meter.postsPerMinute(199)).toBe(64);
  });

  it("records zero counts and resets", () => {
    const meter = new FlowRateMeter();
    meter.record(0, 0);
    expect(meter.postsPerMinute(0)).toBe(0);
    meter.record(1, 4);
    meter.reset();
    expect(meter.postsPerMinute(2)).toBe(0);
  });
});

describe("FlowRateMeter.snapshot", () => {
  it("returns zeros when empty", () => {
    expect(new FlowRateMeter().snapshot(0)).toEqual({
      postsPerMinute: 0,
      positiveShare: 0,
      negativeShare: 0,
      sampleSize: 0,
    });
  });

  it("computes shares over classified posts, independent of activityCount", () => {
    const meter = new FlowRateMeter();
    meter.record(0, 0, { positive: 2, negative: 1, neutral: 1 });
    meter.record(10_000, 4, { positive: 0, negative: 0, neutral: 4 });
    const snap = meter.snapshot(10_000);
    expect(snap.postsPerMinute).toBe(4);
    expect(snap.sampleSize).toBe(8);
    expect(snap.positiveShare).toBeCloseTo(0.25);
    expect(snap.negativeShare).toBeCloseTo(0.125);
  });

  it("prunes mood samples with the window", () => {
    const meter = new FlowRateMeter();
    meter.record(0, 1, { positive: 1, negative: 0, neutral: 0 });
    meter.record(50_000, 1, { positive: 0, negative: 1, neutral: 0 });
    const snap = meter.snapshot(60_000);
    expect(snap.sampleSize).toBe(1);
    expect(snap.positiveShare).toBe(0);
    expect(snap.negativeShare).toBe(1);
  });

  it("keeps two-argument record working and ignores invalid numbers", () => {
    const meter = new FlowRateMeter();
    meter.record(0, 3);
    meter.record(1, Number.NaN, { positive: -2, negative: Number.POSITIVE_INFINITY, neutral: 1.9 });
    const snap = meter.snapshot(1);
    expect(snap.postsPerMinute).toBe(3);
    expect(snap.sampleSize).toBe(1);
  });
});
