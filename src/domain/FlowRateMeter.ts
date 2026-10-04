import { FLOW } from "../config/gardenConfig";

/** Number of posts per mood that were actually classified in one batch. */
export interface MoodCounts {
  readonly positive: number;
  readonly negative: number;
  readonly neutral: number;
}

export interface FlowSnapshot {
  readonly postsPerMinute: number;
  /** positive / sampleSize, 0 when there are no samples. */
  readonly positiveShare: number;
  /** negative / sampleSize, 0 when there are no samples. */
  readonly negativeShare: number;
  /** Number of classified posts inside the window. */
  readonly sampleSize: number;
}

interface FlowEntry {
  readonly t: number;
  readonly count: number;
  readonly positive: number;
  readonly negative: number;
  readonly neutral: number;
}

function sanitize(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

/** Sliding-window posts-per-minute counter with bounded storage (docs/DESIGN.md §16, §35.8). */
export class FlowRateMeter {
  private entries: FlowEntry[] = [];

  /**
   * Records `activityCount` posts received at `nowMs`. `moods` (optional) are the posts that were
   * actually classified in this batch; they feed the mood shares but not postsPerMinute.
   */
  record(nowMs: number, activityCount: number, moods?: MoodCounts): void {
    this.prune(nowMs);
    this.entries.push({
      t: nowMs,
      count: sanitize(activityCount),
      positive: sanitize(moods?.positive ?? 0),
      negative: sanitize(moods?.negative ?? 0),
      neutral: sanitize(moods?.neutral ?? 0),
    });
    if (this.entries.length > FLOW.ENTRY_LIMIT) {
      this.entries.splice(0, this.entries.length - FLOW.ENTRY_LIMIT);
    }
  }

  /** Sum of activity counts recorded within the last FLOW.WINDOW_MS. */
  postsPerMinute(nowMs: number): number {
    return this.snapshot(nowMs).postsPerMinute;
  }

  snapshot(nowMs: number): FlowSnapshot {
    this.prune(nowMs);
    let postsPerMinute = 0;
    let positive = 0;
    let negative = 0;
    let neutral = 0;
    for (const entry of this.entries) {
      postsPerMinute += entry.count;
      positive += entry.positive;
      negative += entry.negative;
      neutral += entry.neutral;
    }
    const sampleSize = positive + negative + neutral;
    return {
      postsPerMinute,
      positiveShare: sampleSize === 0 ? 0 : positive / sampleSize,
      negativeShare: sampleSize === 0 ? 0 : negative / sampleSize,
      sampleSize,
    };
  }

  reset(): void {
    this.entries = [];
  }

  private prune(nowMs: number): void {
    const cutoff = nowMs - FLOW.WINDOW_MS;
    this.entries = this.entries.filter((entry) => entry.t > cutoff);
  }
}
