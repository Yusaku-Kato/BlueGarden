import { AFTER_GROWTH, POLLING } from "../../config/gardenConfig";
import { errorName, logger } from "../../infra/logger";
import { classifyError, GardenError } from "./errors";
import type { EngagementClient, EngagementCounts } from "./engagementClient";

export interface EngagementTrackerOptions {
  readonly client: EngagementClient;
  /** Called at most once per tracked token, only for posts that were found. */
  readonly onUpdate: (token: string, counts: EngagementCounts) => void;
  /** Test seam. Defaults to Date.now. */
  readonly now?: () => number;
}

interface Entry {
  readonly uri: string;
  readonly dueAtMs: number;
}

type TrackerState = "idle" | "running" | "paused" | "stopped";

/**
 * After-growth re-fetch (SPEC §13.3, DESIGN §35.6). The only holder of the plant id to post URI
 * mapping. Bounded to TRACK_LIMIT entries (oldest dropped first); each entry is checked once,
 * AFTER_GROWTH.DELAY_MS after it was registered, then removed. One timer, one AbortController.
 */
export class EngagementTracker {
  private readonly options: EngagementTrackerOptions;
  /** Insertion order equals due order, because the delay is constant. Key: token (PlantSeed.id). */
  private readonly entries = new Map<string, Entry>();
  private state: TrackerState = "idle";
  private timer: ReturnType<typeof setTimeout> | null = null;
  private controller: AbortController | null = null;
  private generation = 0;

  constructor(options: EngagementTrackerOptions) {
    this.options = options;
  }

  get size(): number {
    return this.entries.size;
  }

  /** Registers a post. A later registration of the same token replaces the earlier one. */
  track(uri: string, token: string): void {
    if (this.state === "stopped") return;
    this.entries.delete(token);
    this.entries.set(token, { uri, dueAtMs: this.now() + AFTER_GROWTH.DELAY_MS });
    while (this.entries.size > AFTER_GROWTH.TRACK_LIMIT) {
      const oldest = this.entries.keys().next();
      if (oldest.done === true) break;
      this.entries.delete(oldest.value);
    }
    if (this.state === "running" && this.timer === null && this.controller === null) this.schedule();
  }

  start(): void {
    if (this.state === "running") return;
    if (this.state === "paused") {
      this.resume();
      return;
    }
    this.state = "running";
    this.schedule();
  }

  /** Clears the mapping, the timer and any request. */
  stop(): void {
    this.state = "stopped";
    this.cancel();
    this.entries.clear();
  }

  /** Keeps the mapping; entries that came due meanwhile are checked right after resume. */
  pause(): void {
    if (this.state !== "running") return;
    this.state = "paused";
    this.cancel();
  }

  resume(): void {
    if (this.state !== "paused") return;
    this.state = "running";
    this.schedule();
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  private cancel(): void {
    this.generation += 1;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    const controller = this.controller;
    this.controller = null;
    controller?.abort();
  }

  private schedule(): void {
    if (this.state !== "running" || this.controller !== null) return;
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    const first = this.entries.values().next();
    if (first.done === true) return;
    const delayMs = Math.max(0, first.value.dueAtMs - this.now());
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.checkDue();
    }, delayMs);
  }

  private async checkDue(): Promise<void> {
    if (this.state !== "running") return;
    const nowMs = this.now();
    const due: { token: string; uri: string }[] = [];
    for (const [token, entry] of this.entries) {
      if (entry.dueAtMs > nowMs) break;
      due.push({ token, uri: entry.uri });
    }
    for (const item of due) this.entries.delete(item.token); // checked once, whatever the outcome
    if (due.length === 0) {
      this.schedule();
      return;
    }

    this.generation += 1;
    const generation = this.generation;
    const controller = new AbortController();
    this.controller = controller;
    const timeout: { timer: ReturnType<typeof setTimeout> | null } = { timer: null };
    try {
      const timedOut = new Promise<never>((_resolve, reject) => {
        timeout.timer = setTimeout(() => {
          controller.abort();
          reject(new GardenError("timeout"));
        }, POLLING.FETCH_TIMEOUT_MS);
      });
      const counts = await Promise.race([
        this.options.client.fetchCounts(
          due.map((item) => item.uri),
          controller.signal,
        ),
        timedOut,
      ]);
      if (generation !== this.generation) return;
      for (const item of due) {
        const found = counts.get(item.uri);
        if (found !== undefined) this.notify(item.token, found);
      }
    } catch (error) {
      if (generation !== this.generation) return; // stop / pause: not an error
      logger.debug("engagement.fetchFailed", { kind: classifyError(error, "feed").kind });
    } finally {
      if (timeout.timer !== null) clearTimeout(timeout.timer);
      if (generation === this.generation) {
        this.controller = null;
        this.schedule();
      }
    }
  }

  private notify(token: string, counts: EngagementCounts): void {
    try {
      this.options.onUpdate(token, counts);
    } catch (error) {
      logger.error("unexpected", { where: "engagementUpdate", error: errorName(error) });
    }
  }
}
