import { POLLING } from "../../config/gardenConfig";
import type { GardenPost } from "../../domain/models";
import { errorName, logger } from "../../infra/logger";
import { classifyError, GardenError, isSessionFatal, isTargetFatal } from "./errors";
import type { PostSource, PostSourceEvents } from "./PostSource";
import type { SeenPostCache } from "./SeenPostCache";

export interface FeedPollerOptions {
  fetch: (signal: AbortSignal) => Promise<GardenPost[]>;
  seenPosts: SeenPostCache;
  events: PostSourceEvents;
}

type PollerState = "idle" | "running" | "paused" | "stopped";

const BACKOFF_EXPONENT_CAP = 10;

/** Delay after the n-th consecutive failure: 15s, 30s, 60s, 60s, ... */
export function backoffDelayMs(consecutiveFailures: number): number {
  const exponent = Math.min(Math.max(consecutiveFailures - 1, 0), BACKOFF_EXPONENT_CAP);
  return Math.min(POLLING.INTERVAL_MS * 2 ** exponent, POLLING.MAX_BACKOFF_MS);
}

function abortRace(signal: AbortSignal): { promise: Promise<never>; dispose: () => void } {
  let dispose = (): void => undefined;
  const promise = new Promise<never>((_resolve, reject) => {
    const onAbort = (): void => {
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    dispose = () => {
      signal.removeEventListener("abort", onAbort);
    };
  });
  return { promise, dispose };
}

/** Polls a feed with a setTimeout chain, bounded backoff and per-request timeout (docs/DESIGN.md section 9). */
export class FeedPoller implements PostSource {
  private readonly options: FeedPollerOptions;
  private state: PollerState = "idle";
  private generation = 0;
  private consecutiveFailures = 0;
  /** True once this instance has completed a fetch; the first batch carries no activity. */
  private hasSucceeded = false;
  private scheduleTimer: ReturnType<typeof setTimeout> | null = null;
  private timeoutTimer: ReturnType<typeof setTimeout> | null = null;
  private controller: AbortController | null = null;

  constructor(options: FeedPollerOptions) {
    this.options = options;
  }

  /** Fetches immediately, then keeps polling. No-op while running. */
  start(): void {
    if (this.state === "running") return;
    if (this.state === "paused") {
      this.resume();
      return;
    }
    this.consecutiveFailures = 0;
    this.state = "running";
    void this.poll();
  }

  stop(): void {
    this.state = "stopped";
    this.cancelPending();
  }

  pause(): void {
    if (this.state !== "running") return;
    this.state = "paused";
    this.cancelPending();
  }

  /**
   * Fetches immediately when healthy. While backing off (failures or rate limit), waits out the
   * current backoff delay instead, so repeated hide/show cannot cause high-frequency retries.
   */
  resume(): void {
    if (this.state !== "paused") return;
    this.state = "running";
    if (this.consecutiveFailures > 0) {
      this.schedule(backoffDelayMs(this.consecutiveFailures));
      return;
    }
    void this.poll();
  }

  /** Clears timers, aborts the in-flight request, and invalidates its result. */
  private cancelPending(): void {
    this.generation += 1;
    if (this.scheduleTimer !== null) clearTimeout(this.scheduleTimer);
    this.scheduleTimer = null;
    this.endRequest();
  }

  private endRequest(): void {
    if (this.timeoutTimer !== null) clearTimeout(this.timeoutTimer);
    this.timeoutTimer = null;
    const controller = this.controller;
    this.controller = null;
    controller?.abort();
  }

  private async poll(): Promise<void> {
    this.generation += 1;
    const generation = this.generation;
    const controller = new AbortController();
    this.controller = controller;
    const timeout = { fired: false };
    this.timeoutTimer = setTimeout(() => {
      timeout.fired = true;
      controller.abort();
    }, POLLING.FETCH_TIMEOUT_MS);
    const race = abortRace(controller.signal);

    try {
      const posts = await Promise.race([this.options.fetch(controller.signal), race.promise]);
      race.dispose();
      if (generation !== this.generation) return;
      this.endRequest();
      this.handleSuccess(posts);
    } catch (error) {
      race.dispose();
      if (generation !== this.generation) return; // stop/pause: not an error
      this.endRequest();
      this.handleFailure(timeout.fired ? new GardenError("timeout") : classifyError(error, "feed"));
    }
  }

  private handleSuccess(posts: GardenPost[]): void {
    const fresh: GardenPost[] = [];
    for (let index = posts.length - 1; index >= 0; index -= 1) {
      const post = posts[index];
      if (post !== undefined && this.options.seenPosts.markIfNew(post.uri)) fresh.push(post);
    }

    const activityCount = this.hasSucceeded ? fresh.length : 0;
    this.hasSucceeded = true;
    const recovered = this.consecutiveFailures > 0;
    this.consecutiveFailures = 0;
    this.schedule(POLLING.INTERVAL_MS);
    this.safely("onPosts", () => {
      this.options.events.onPosts(fresh, { activityCount });
    });
    if (recovered) {
      logger.info("poller.recovered");
      this.safely("onRecovered", () => {
        this.options.events.onRecovered();
      });
    }
  }

  private handleFailure(error: GardenError): void {
    if (isSessionFatal(error.kind) || isTargetFatal(error.kind)) {
      this.state = "stopped";
      this.cancelPending();
      logger.warn("api.error", { kind: error.kind, fatal: true });
      this.safely("onFatal", () => {
        this.options.events.onFatal(error);
      });
      return;
    }

    this.consecutiveFailures += 1;
    const delayMs = this.failureDelayMs(error);
    this.schedule(delayMs);
    logger.warn("api.error", {
      kind: error.kind,
      failures: this.consecutiveFailures,
      nextDelayMs: delayMs,
    });
    this.safely("onError", () => {
      this.options.events.onError(error, delayMs);
    });
  }

  private failureDelayMs(error: GardenError): number {
    const backoff = backoffDelayMs(this.consecutiveFailures);
    if (error.kind !== "rateLimited") return backoff;
    return Math.min(Math.max(backoff, error.retryAfterMs ?? 0), POLLING.MAX_BACKOFF_MS);
  }

  private schedule(delayMs: number): void {
    if (this.state !== "running") return;
    if (this.scheduleTimer !== null) clearTimeout(this.scheduleTimer);
    this.scheduleTimer = setTimeout(() => {
      this.scheduleTimer = null;
      if (this.state === "running") void this.poll();
    }, delayMs);
  }

  /** Callbacks must not break the polling loop. */
  private safely(name: string, callback: () => void): void {
    try {
      callback();
    } catch (error) {
      logger.error("unexpected", { where: name, error: errorName(error) });
    }
  }
}
