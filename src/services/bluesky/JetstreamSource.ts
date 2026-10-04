import { JetstreamV1, type LiveTransport, websocketTransport } from "@bsky/jetstream";
import { JETSTREAM } from "../../config/gardenConfig";
import type { GardenPost } from "../../domain/models";
import { errorName, logger } from "../../infra/logger";
import { GardenError } from "./errors";
import { isPostCreateEvent, normalizeJetstreamEvent, POST_COLLECTION, readTimeUs } from "./normalizeJetstreamEvent";
import type { PostSource, PostSourceEvents } from "./PostSource";
import type { SeenPostCache } from "./SeenPostCache";
import { TokenBucket } from "./TokenBucket";

/** One connection attempt. The returned iterable must end (not retry) when the connection drops. */
export interface JetstreamConnectParams {
  readonly host: string;
  /** Jetstream v1 cursor (time_us). Undefined means live. */
  readonly cursorUs: number | undefined;
  readonly signal: AbortSignal;
  readonly onError: (error: unknown) => void;
}
export type JetstreamConnector = (params: JetstreamConnectParams) => AsyncIterable<unknown>;

export interface JetstreamSourceOptions {
  readonly seenPosts: SeenPostCache;
  readonly events: PostSourceEvents;
  /** Test seam. Defaults to @bsky/jetstream (JetstreamV1) over a native WebSocket. */
  readonly connect?: JetstreamConnector;
}

type SourceState = "idle" | "running" | "paused" | "stopped";

/** Posts waiting for the next flush. Overflow drops the oldest (sampling makes this unreachable in practice). */
const PENDING_LIMIT = JETSTREAM.BATCH_LIMIT * 10;
/** Extra server-time margin when deciding which events of a resumed connection are replays. */
const REPLAY_SLACK_MS = 1_000;

/** Delay after the n-th consecutive failed connection: 2s, 4s, ... capped at RECONNECT_MAX_MS. */
export function reconnectDelayMs(consecutiveFailures: number): number {
  const exponent = Math.min(Math.max(consecutiveFailures - 1, 0), 16);
  return Math.min(JETSTREAM.RECONNECT_MIN_MS * 2 ** exponent, JETSTREAM.RECONNECT_MAX_MS);
}

/**
 * Default connector. @bsky/jetstream is browser-ready (native WebSocket via @atproto/ws-client).
 * Its own reconnect is disabled (`shouldReconnect: () => false`): the stream ends on any drop and
 * this class owns backoff, host failover and cursor policy. Frames are consumed one at a time by a
 * synchronous handler, so the library's internal queue does not grow. `raw: true` skips the typed
 * record conversion; only the wire JSON parse happens for every frame.
 */
export function createJetstreamConnector(
  transport: LiveTransport = websocketTransport({ shouldReconnect: () => false }),
): JetstreamConnector {
  return ({ host, cursorUs, signal, onError }) =>
    new JetstreamV1(`https://${host}`).live({
      collections: [POST_COLLECTION],
      raw: true,
      signal,
      onError,
      cursor: { load: () => Promise.resolve(cursorUs), save: () => Promise.resolve() },
      liveTransport: transport,
    });
}

/**
 * Global Garden source (docs/DESIGN.md §36.3, §38). Every post create is counted for activity;
 * a token bucket picks the few events that are normalized into plants. Needs no session.
 */
export class JetstreamSource implements PostSource {
  private readonly options: JetstreamSourceOptions;
  private readonly connector: JetstreamConnector;
  private readonly sampler = new TokenBucket(JETSTREAM.MAX_PLANTS_PER_SEC);
  private state: SourceState = "idle";
  private generation = 0;
  private controller: AbortController | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private stableTimer: ReturnType<typeof setTimeout> | null = null;
  private consecutiveFailures = 0;
  private hostIndex = 0;
  /** True after a reported disconnect until the next connection delivers an event. */
  private recoveryPending = false;

  private pending: GardenPost[] = [];
  /** Counted events times ACTIVITY_SCALE; the fractional part carries over to the next flush. */
  private activityAccumulator = 0;

  /** In-session resume point. */
  private lastTimeUs: number | undefined;
  private lastEventWallMs = 0;
  private replayUntilUs = 0;

  constructor(options: JetstreamSourceOptions) {
    this.options = options;
    this.connector = options.connect ?? createJetstreamConnector();
  }

  start(): void {
    if (this.state === "running") return;
    if (this.state === "paused") {
      this.resume();
      return;
    }
    this.state = "running";
    this.consecutiveFailures = 0;
    this.begin();
  }

  stop(): void {
    this.state = "stopped";
    this.halt();
    this.pending = [];
    this.activityAccumulator = 0;
  }

  pause(): void {
    if (this.state !== "running") return;
    this.state = "paused";
    this.halt();
    this.lastTimeUs = undefined; // resume reconnects live
    this.pending = [];
    this.activityAccumulator = 0;
  }

  resume(): void {
    if (this.state !== "paused") return;
    this.state = "running";
    this.begin();
  }

  private begin(): void {
    this.flushTimer ??= setInterval(() => {
      this.flush();
    }, JETSTREAM.FLUSH_INTERVAL_MS);
    if (this.consecutiveFailures === 0) {
      this.connect();
    } else {
      // Resuming while backing off: wait out the delay so hide / show cannot cause rapid reconnects.
      this.scheduleReconnect(reconnectDelayMs(this.consecutiveFailures));
    }
  }

  private scheduleReconnect(delayMs: number): void {
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delayMs);
  }

  /** Aborts the socket, clears every timer and invalidates the running consumer. */
  private halt(): void {
    this.generation += 1;
    if (this.reconnectTimer !== null) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    if (this.flushTimer !== null) clearInterval(this.flushTimer);
    this.flushTimer = null;
    this.clearStableTimer();
    const controller = this.controller;
    this.controller = null;
    controller?.abort();
  }

  private clearStableTimer(): void {
    if (this.stableTimer !== null) clearTimeout(this.stableTimer);
    this.stableTimer = null;
  }

  private connect(): void {
    if (this.state !== "running") return;
    this.generation += 1;
    const generation = this.generation;
    const controller = new AbortController();
    this.controller = controller;

    const nowMs = Date.now();
    const useCursor = this.lastTimeUs !== undefined && nowMs - this.lastEventWallMs <= JETSTREAM.CURSOR_MAX_REWIND_MS;
    const cursorUs = useCursor ? this.lastTimeUs : undefined;
    this.replayUntilUs =
      cursorUs === undefined ? 0 : cursorUs + (nowMs - this.lastEventWallMs + REPLAY_SLACK_MS) * 1000;
    if (!useCursor) this.lastTimeUs = undefined;

    const host = JETSTREAM.HOSTS[this.hostIndex % JETSTREAM.HOSTS.length];
    if (host === undefined) return;
    void this.consume(generation, controller, host, cursorUs);
  }

  private async consume(
    generation: number,
    controller: AbortController,
    host: string,
    cursorUs: number | undefined,
  ): Promise<void> {
    let iterator: AsyncIterator<unknown> | null = null;
    try {
      const iterable = this.connector({
        host,
        cursorUs,
        signal: controller.signal,
        onError: (error) => {
          // Malformed frames are skipped by the library; only the type is worth a debug line.
          logger.debug("jetstream.frameSkipped", { error: errorName(error) });
        },
      });
      iterator = iterable[Symbol.asyncIterator]();
      let announced = false;
      for (;;) {
        const step = await iterator.next();
        if (generation !== this.generation) return; // stop / pause / superseded
        if (step.done === true) break;
        if (!announced) {
          announced = true;
          this.onConnected();
        }
        this.handleEvent(step.value);
      }
      if (generation === this.generation) this.handleDisconnect("closed");
    } catch (error) {
      if (generation !== this.generation) return;
      this.handleDisconnect(errorName(error));
    } finally {
      // Closes the socket if the loop exited early. Failures here are irrelevant.
      void iterator?.return?.().catch(() => undefined);
    }
  }

  private onConnected(): void {
    if (this.recoveryPending) {
      this.recoveryPending = false;
      logger.info("jetstream.recovered");
      this.safely("onRecovered", () => {
        this.options.events.onRecovered();
      });
    }
    this.clearStableTimer();
    this.stableTimer = setTimeout(() => {
      this.stableTimer = null;
      this.consecutiveFailures = 0;
    }, JETSTREAM.STABLE_RESET_MS);
  }

  private handleEvent(event: unknown): void {
    const timeUs = readTimeUs(event);
    if (timeUs !== undefined) {
      this.lastTimeUs = timeUs;
      this.lastEventWallMs = Date.now();
    }
    // Everything else is dropped without being parsed further.
    if (!isPostCreateEvent(event)) return;

    const isReplay = timeUs !== undefined && timeUs <= this.replayUntilUs;
    if (!isReplay) this.activityAccumulator += JETSTREAM.ACTIVITY_SCALE;
    if (!this.sampler.tryTake(Date.now())) return;

    const post = normalizeJetstreamEvent(event);
    if (post === null || !this.options.seenPosts.markIfNew(post.uri)) return;
    this.pending.push(post);
    if (this.pending.length > PENDING_LIMIT) this.pending.splice(0, this.pending.length - PENDING_LIMIT);
  }

  private flush(): void {
    if (this.state !== "running") return;
    const activityCount = Math.floor(this.activityAccumulator);
    this.activityAccumulator -= activityCount;
    const posts = this.pending.splice(0, JETSTREAM.BATCH_LIMIT); // oldest first
    if (posts.length === 0 && activityCount === 0) return;
    this.safely("onPosts", () => {
      this.options.events.onPosts(posts, { activityCount });
    });
  }

  private handleDisconnect(reason: string): void {
    this.clearStableTimer();
    const controller = this.controller;
    this.controller = null;
    controller?.abort();

    this.consecutiveFailures += 1;
    this.recoveryPending = true;
    this.hostIndex = (this.hostIndex + 1) % JETSTREAM.HOSTS.length;
    const delayMs = reconnectDelayMs(this.consecutiveFailures);
    logger.warn("jetstream.disconnected", { reason, failures: this.consecutiveFailures, nextDelayMs: delayMs });
    this.generation += 1;
    this.scheduleReconnect(delayMs);
    this.safely("onError", () => {
      this.options.events.onError(new GardenError("network"), delayMs);
    });
  }

  /** Callbacks must not break the stream. */
  private safely(name: string, callback: () => void): void {
    try {
      callback();
    } catch (error) {
      logger.error("unexpected", { where: name, error: errorName(error) });
    }
  }
}
