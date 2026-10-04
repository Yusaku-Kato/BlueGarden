import { describe, expect, it } from "vitest";
import { TokenBucket } from "./TokenBucket";

describe("TokenBucket", () => {
  it("allows a burst up to capacity, then refuses", () => {
    const bucket = new TokenBucket(2);
    expect(bucket.tryTake(0)).toBe(true);
    expect(bucket.tryTake(0)).toBe(true);
    expect(bucket.tryTake(0)).toBe(false);
  });

  it("refills at the configured rate and never above capacity", () => {
    const bucket = new TokenBucket(2);
    bucket.tryTake(0);
    bucket.tryTake(0);
    expect(bucket.tryTake(400)).toBe(false);
    expect(bucket.tryTake(500)).toBe(true);
    expect(bucket.tryTake(60_000)).toBe(true);
    expect(bucket.tryTake(60_000)).toBe(true);
    expect(bucket.tryTake(60_000)).toBe(false);
  });

  it("does not grant tokens when the clock goes backwards", () => {
    const bucket = new TokenBucket(1);
    expect(bucket.tryTake(10_000)).toBe(true);
    expect(bucket.tryTake(0)).toBe(false);
    expect(bucket.tryTake(500)).toBe(false);
  });
});
