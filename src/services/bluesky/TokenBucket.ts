/**
 * Token bucket with O(1) state. Holds at most `capacity` tokens and refills `ratePerSecond`
 * tokens per second. The caller supplies the clock so the sampler stays deterministic in tests.
 */
export class TokenBucket {
  private readonly capacity: number;
  private readonly ratePerMs: number;
  private tokens: number;
  private lastRefillMs: number | null = null;

  constructor(ratePerSecond: number, capacity: number = ratePerSecond) {
    this.capacity = Math.max(1, capacity);
    this.ratePerMs = Math.max(0, ratePerSecond) / 1000;
    this.tokens = this.capacity;
  }

  /** Takes one token. Returns false when the bucket is empty. */
  tryTake(nowMs: number): boolean {
    this.refill(nowMs);
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }

  private refill(nowMs: number): void {
    if (this.lastRefillMs !== null && nowMs > this.lastRefillMs) {
      this.tokens = Math.min(this.capacity, this.tokens + (nowMs - this.lastRefillMs) * this.ratePerMs);
    }
    // A clock that moved backwards only moves the reference point; it never grants tokens.
    this.lastRefillMs = nowMs;
  }
}
