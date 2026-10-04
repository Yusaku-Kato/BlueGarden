import { TREND } from "../config/gardenConfig";
import type { FlowSnapshot } from "./FlowRateMeter";

export interface TrendValue {
  readonly ppm: number;
  readonly positiveShare: number;
  readonly negativeShare: number;
  /** Time between the first and the latest update. */
  readonly observedMs: number;
}

/**
 * Exponential moving average of the flow snapshot with time constant TREND.TAU_MS.
 * O(1) memory, no history, no clock access (docs/DESIGN.md §35.8).
 * Mood shares only move on snapshots that have classified samples.
 */
export class TrendMeter {
  private ppm = 0;
  private positiveShare = 0;
  private negativeShare = 0;
  private startMs: number | null = null;
  private lastMs = 0;

  update(nowMs: number, snapshot: FlowSnapshot): void {
    if (!Number.isFinite(nowMs)) return;
    if (this.startMs === null) {
      this.startMs = nowMs;
      this.lastMs = nowMs;
      this.ppm = snapshot.postsPerMinute;
      this.positiveShare = snapshot.positiveShare;
      this.negativeShare = snapshot.negativeShare;
      return;
    }
    const dt = Math.max(0, nowMs - this.lastMs);
    this.lastMs = Math.max(this.lastMs, nowMs);
    const alpha = 1 - Math.exp(-dt / TREND.TAU_MS);
    this.ppm += (snapshot.postsPerMinute - this.ppm) * alpha;
    if (snapshot.sampleSize > 0) {
      this.positiveShare += (snapshot.positiveShare - this.positiveShare) * alpha;
      this.negativeShare += (snapshot.negativeShare - this.negativeShare) * alpha;
    }
  }

  value(): TrendValue {
    return {
      ppm: this.ppm,
      positiveShare: this.positiveShare,
      negativeShare: this.negativeShare,
      observedMs: this.startMs === null ? 0 : this.lastMs - this.startMs,
    };
  }

  reset(): void {
    this.ppm = 0;
    this.positiveShare = 0;
    this.negativeShare = 0;
    this.startMs = null;
    this.lastMs = 0;
  }
}
