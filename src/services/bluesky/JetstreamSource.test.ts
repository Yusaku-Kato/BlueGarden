import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JETSTREAM } from "../../config/gardenConfig";
import type { GardenPost } from "../../domain/models";
import type { GardenError } from "./errors";
import { normalizeJetstreamEvent } from "./normalizeJetstreamEvent";
import { type JetstreamConnectParams, JetstreamSource, reconnectDelayMs } from "./JetstreamSource";
import type { PostBatchMeta } from "./PostSource";
import { SeenPostCache } from "./SeenPostCache";

const control = vi.hoisted(() => ({ unlimited: false }));

vi.mock("./TokenBucket", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./TokenBucket")>();
  class ControllableBucket extends actual.TokenBucket {
    override tryTake(nowMs: number): boolean {
      return control.unlimited ? true : super.tryTake(nowMs);
    }
  }
  return { ...actual, TokenBucket: ControllableBucket };
});

vi.mock("./normalizeJetstreamEvent", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./normalizeJetstreamEvent")>();
  return { ...actual, normalizeJetstreamEvent: vi.fn(actual.normalizeJetstreamEvent) };
});

const DID = "did:plc:abcdefghijklmnopqrstuvwx";

function postEvent(index: number, timeUs: number): unknown {
  return {
    did: DID,
    timeUs,
    kind: "commit",
    commit: {
      operation: "create",
      collection: "app.bsky.feed.post",
      rkey: `3k${String(index).padStart(10, "0")}`,
      record: { text: `synthetic ${String(index)}`, createdAt: "2026-01-02T03:04:05.000Z" },
    },
  };
}

class FakeConnection {
  readonly params: JetstreamConnectParams;
  closed = false;
  private readonly queue: unknown[] = [];
  private waiter: ((result: IteratorResult<unknown>) => void) | null = null;
  private rejecter: ((error: Error) => void) | null = null;
  private pendingError: Error | null = null;
  private ended = false;

  constructor(params: JetstreamConnectParams) {
    this.params = params;
    params.signal.addEventListener("abort", () => {
      this.closed = true;
      this.end();
    });
  }

  push(event: unknown): void {
    if (this.waiter !== null) {
      const resolve = this.waiter;
      this.waiter = null;
      this.rejecter = null;
      resolve({ done: false, value: event });
    } else {
      this.queue.push(event);
    }
  }

  end(): void {
    this.ended = true;
    if (this.waiter !== null) {
      const resolve = this.waiter;
      this.waiter = null;
      this.rejecter = null;
      resolve({ done: true, value: undefined });
    }
  }

  fail(error: Error): void {
    if (this.rejecter !== null) {
      const reject = this.rejecter;
      this.waiter = null;
      this.rejecter = null;
      reject(error);
    } else {
      this.pendingError = error;
    }
  }

  iterable(): AsyncIterable<unknown> {
    return {
      [Symbol.asyncIterator]: () => ({
        next: (): Promise<IteratorResult<unknown>> => {
          if (this.pendingError !== null) return Promise.reject(this.pendingError);
          const next = this.queue.shift();
          if (next !== undefined) return Promise.resolve({ done: false, value: next });
          if (this.ended) return Promise.resolve({ done: true, value: undefined });
          return new Promise((resolve, reject) => {
            this.waiter = resolve;
            this.rejecter = reject;
          });
        },
        return: (): Promise<IteratorResult<unknown>> => {
          this.closed = true;
          return Promise.resolve({ done: true, value: undefined });
        },
      }),
    };
  }
}

interface Harness {
  source: JetstreamSource;
  connections: FakeConnection[];
  batches: { posts: readonly GardenPost[]; meta: PostBatchMeta }[];
  errors: { error: GardenError; delay: number }[];
  recovered: { count: number };
  seen: SeenPostCache;
}

function setup(): Harness {
  const connections: FakeConnection[] = [];
  const batches: Harness["batches"] = [];
  const errors: Harness["errors"] = [];
  const recovered = { count: 0 };
  const seen = new SeenPostCache();
  const source = new JetstreamSource({
    seenPosts: seen,
    events: {
      onPosts: (posts, meta) => batches.push({ posts, meta }),
      onError: (error, delay) => errors.push({ error, delay }),
      onRecovered: () => {
        recovered.count += 1;
      },
      onFatal: () => {
        throw new Error("unexpected fatal");
      },
    },
    connect: (params) => {
      const connection = new FakeConnection(params);
      connections.push(connection);
      return connection.iterable();
    },
  });
  return { source, connections, batches, errors, recovered, seen };
}

function current(harness: Harness): FakeConnection {
  const connection = harness.connections[harness.connections.length - 1];
  if (connection === undefined) throw new Error("no connection");
  return connection;
}

async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0);
}

beforeEach(() => {
  control.unlimited = false;
  vi.mocked(normalizeJetstreamEvent).mockClear();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("reconnectDelayMs", () => {
  it("doubles from the minimum up to the cap", () => {
    expect([1, 2, 3, 4, 5, 6, 7, 100].map(reconnectDelayMs)).toEqual([2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000, 60_000]);
  });
});

describe("JetstreamSource", () => {
  it("connects to the first host live and is idempotent on start", async () => {
    const h = setup();
    h.source.start();
    h.source.start();
    await settle();
    expect(h.connections).toHaveLength(1);
    expect(current(h).params.host).toBe(JETSTREAM.HOSTS[0]);
    expect(current(h).params.cursorUs).toBeUndefined();
    h.source.stop();
  });

  it("counts every create (scaled, with carry) and samples at most the bucket rate", async () => {
    const h = setup();
    h.source.start();
    await settle();
    const connection = current(h);
    // 100 posts in the same instant: bucket capacity is 2.
    for (let index = 0; index < 100; index += 1) connection.push(postEvent(index, 1_000_000 + index));
    // Non-post events are ignored.
    connection.push({ did: DID, timeUs: 5, kind: "identity", identity: { did: DID } });
    connection.push({ did: DID, timeUs: 6, kind: "commit", commit: { operation: "delete", collection: "app.bsky.feed.post", rkey: "x" } });
    await vi.advanceTimersByTimeAsync(JETSTREAM.FLUSH_INTERVAL_MS);
    expect(h.batches).toHaveLength(1);
    const batch = h.batches[0];
    expect(batch?.posts).toHaveLength(2);
    expect(batch?.meta.activityCount).toBe(Math.floor(100 * JETSTREAM.ACTIVITY_SCALE));
    h.source.stop();
  });

  it("carries the fractional activity into later flushes", async () => {
    const h = setup();
    h.source.start();
    await settle();
    const connection = current(h);
    for (let index = 0; index < 30; index += 1) connection.push(postEvent(index, 1_000_000 + index)); // 0.6
    await vi.advanceTimersByTimeAsync(JETSTREAM.FLUSH_INTERVAL_MS);
    expect(h.batches[0]?.meta.activityCount).toBe(0);
    for (let index = 30; index < 60; index += 1) connection.push(postEvent(index, 2_000_000 + index)); // 1.2 total
    await vi.advanceTimersByTimeAsync(JETSTREAM.FLUSH_INTERVAL_MS);
    expect(h.batches[h.batches.length - 1]?.meta.activityCount).toBe(1);
    h.source.stop();
  });

  it("deduplicates by URI through seenPosts", async () => {
    const h = setup();
    h.source.start();
    await settle();
    const connection = current(h);
    connection.push(postEvent(1, 1_000_001));
    await vi.advanceTimersByTimeAsync(1_000);
    connection.push(postEvent(1, 1_000_002));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.batches.flatMap((batch) => batch.posts)).toHaveLength(1);
    h.source.stop();
  });

  it("emits posts oldest first", async () => {
    const h = setup();
    h.source.start();
    await settle();
    const connection = current(h);
    connection.push(postEvent(1, 1));
    connection.push(postEvent(2, 2));
    await vi.advanceTimersByTimeAsync(JETSTREAM.FLUSH_INTERVAL_MS);
    const uris = h.batches.flatMap((batch) => batch.posts.map((post) => post.uri));
    expect(uris[0]?.endsWith("0000000001")).toBe(true);
    expect(uris[1]?.endsWith("0000000002")).toBe(true);
    h.source.stop();
  });

  it("reconnects with backoff and failover, then reports recovery on the first event", async () => {
    const h = setup();
    h.source.start();
    await settle();
    current(h).push(postEvent(1, 1_000_000));
    await settle();
    current(h).fail(new Error("socket reset"));
    await settle();
    expect(h.errors).toHaveLength(1);
    expect(h.errors[0]?.error.kind).toBe("network");
    expect(h.errors[0]?.delay).toBe(JETSTREAM.RECONNECT_MIN_MS);
    expect(h.connections).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(JETSTREAM.RECONNECT_MIN_MS);
    expect(h.connections).toHaveLength(2);
    expect(current(h).params.host).toBe(JETSTREAM.HOSTS[1]);
    expect(h.recovered.count).toBe(0);

    current(h).end(); // drops again before any event
    await settle();
    expect(h.errors[1]?.delay).toBe(JETSTREAM.RECONNECT_MIN_MS * 2);
    await vi.advanceTimersByTimeAsync(JETSTREAM.RECONNECT_MIN_MS * 2);
    expect(current(h).params.host).toBe(JETSTREAM.HOSTS[2]);
    current(h).push(postEvent(2, 3_000_000));
    await settle();
    expect(h.recovered.count).toBe(1);
    h.source.stop();
  });

  it("resets the backoff after a stable connection", async () => {
    const h = setup();
    h.source.start();
    await settle();
    current(h).end();
    await settle();
    await vi.advanceTimersByTimeAsync(JETSTREAM.RECONNECT_MIN_MS);
    current(h).push(postEvent(1, 1_000_000));
    await vi.advanceTimersByTimeAsync(JETSTREAM.STABLE_RESET_MS);
    current(h).end();
    await settle();
    expect(h.errors[h.errors.length - 1]?.delay).toBe(JETSTREAM.RECONNECT_MIN_MS);
    h.source.stop();
  });

  it("does not reset the backoff when the connection drops before it was stable", async () => {
    const h = setup();
    h.source.start();
    await settle();
    current(h).end();
    await settle();
    await vi.advanceTimersByTimeAsync(JETSTREAM.RECONNECT_MIN_MS);
    current(h).push(postEvent(1, 1_000_000));
    await vi.advanceTimersByTimeAsync(JETSTREAM.STABLE_RESET_MS - 1);
    current(h).end();
    await settle();
    expect(h.errors[h.errors.length - 1]?.delay).toBe(JETSTREAM.RECONNECT_MIN_MS * 2);
    h.source.stop();
  });

  it("resumes from the cursor for short gaps and does not count replayed events", async () => {
    const h = setup();
    h.source.start();
    await settle();
    current(h).push(postEvent(1, 10_000_000));
    await settle();
    current(h).fail(new Error("reset"));
    await settle();
    await vi.advanceTimersByTimeAsync(JETSTREAM.RECONNECT_MIN_MS);
    const resumed = current(h);
    expect(resumed.params.cursorUs).toBe(10_000_000);
    await vi.advanceTimersByTimeAsync(JETSTREAM.FLUSH_INTERVAL_MS); // flush what was counted so far
    const before = h.batches.reduce((sum, batch) => sum + batch.meta.activityCount, 0);

    // Replayed gap (server time within the gap + slack): not counted.
    for (let index = 0; index < 100; index += 1) resumed.push(postEvent(100 + index, 10_000_001 + index));
    await vi.advanceTimersByTimeAsync(JETSTREAM.FLUSH_INTERVAL_MS);
    const afterReplay = h.batches.reduce((sum, batch) => sum + batch.meta.activityCount, 0);
    expect(afterReplay).toBe(before);

    // A live event far beyond the replay window is counted again.
    for (let index = 0; index < 100; index += 1) resumed.push(postEvent(300 + index, 99_000_000_000 + index));
    await vi.advanceTimersByTimeAsync(JETSTREAM.FLUSH_INTERVAL_MS);
    const afterLive = h.batches.reduce((sum, batch) => sum + batch.meta.activityCount, 0);
    expect(afterLive).toBe(before + Math.floor(100 * JETSTREAM.ACTIVITY_SCALE));
    h.source.stop();
  });

  it("goes live (no cursor) when the gap exceeds CURSOR_MAX_REWIND_MS", async () => {
    const h = setup();
    h.source.start();
    await settle();
    current(h).push(postEvent(1, 10_000_000));
    await settle();
    // Fail repeatedly so the cumulative gap passes the rewind limit.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      current(h).end();
      await settle();
      await vi.advanceTimersByTimeAsync(reconnectDelayMs(attempt + 1));
    }
    expect(current(h).params.cursorUs).toBeUndefined();
    h.source.stop();
  });

  it("pause closes the socket and clears timers; resume reconnects live", async () => {
    const h = setup();
    h.source.start();
    await settle();
    const first = current(h);
    first.push(postEvent(1, 10_000_000));
    await settle();
    h.source.pause();
    h.source.pause();
    expect(first.closed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    h.source.resume();
    await settle();
    expect(h.connections).toHaveLength(2);
    expect(current(h).params.cursorUs).toBeUndefined();
    h.source.resume();
    await settle();
    expect(h.connections).toHaveLength(2);
    h.source.stop();
  });

  it("stop closes the socket, leaves no timers, and ignores late events", async () => {
    const h = setup();
    h.source.start();
    await settle();
    const connection = current(h);
    h.source.stop();
    h.source.stop();
    expect(connection.closed).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    connection.push(postEvent(1, 1));
    await vi.advanceTimersByTimeAsync(JETSTREAM.FLUSH_INTERVAL_MS * 3);
    expect(h.batches).toHaveLength(0);
    expect(h.errors).toHaveLength(0);
    expect(h.connections).toHaveLength(1);
  });

  it("stop during backoff cancels the reconnect", async () => {
    const h = setup();
    h.source.start();
    await settle();
    current(h).end();
    await settle();
    h.source.stop();
    await vi.advanceTimersByTimeAsync(JETSTREAM.RECONNECT_MAX_MS * 2);
    expect(h.connections).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("survives callbacks that throw", async () => {
    const connections: FakeConnection[] = [];
    const source = new JetstreamSource({
      seenPosts: new SeenPostCache(),
      events: {
        onPosts: () => {
          throw new Error("boom");
        },
        onError: () => undefined,
        onRecovered: () => undefined,
        onFatal: () => undefined,
      },
      connect: (params) => {
        const connection = new FakeConnection(params);
        connections.push(connection);
        return connection.iterable();
      },
    });
    source.start();
    await settle();
    connections[0]?.push(postEvent(1, 1));
    await vi.advanceTimersByTimeAsync(JETSTREAM.FLUSH_INTERVAL_MS * 2);
    connections[0]?.push(postEvent(2, 2));
    await vi.advanceTimersByTimeAsync(JETSTREAM.FLUSH_INTERVAL_MS);
    source.stop();
  });

  it("drops the oldest pending posts when the pending buffer overflows", async () => {
    control.unlimited = true;
    const h = setup();
    h.source.start();
    await settle();
    const connection = current(h);
    const pendingLimit = JETSTREAM.BATCH_LIMIT * 10;
    const total = pendingLimit + 5;
    for (let index = 0; index < total; index += 1) connection.push(postEvent(index, 1_000_000 + index));
    await vi.advanceTimersByTimeAsync(JETSTREAM.FLUSH_INTERVAL_MS);
    const first = h.batches[0]?.posts ?? [];
    expect(first).toHaveLength(JETSTREAM.BATCH_LIMIT);
    expect(first[0]?.uri.endsWith("0000000005")).toBe(true); // 0..4 were dropped
    for (let flush = 1; flush < 20; flush += 1) await vi.advanceTimersByTimeAsync(JETSTREAM.FLUSH_INTERVAL_MS);
    expect(h.batches.flatMap((batch) => batch.posts)).toHaveLength(pendingLimit);
    h.source.stop();
  });

  it("never normalizes events the sampler rejected", async () => {
    const h = setup();
    h.source.start();
    await settle();
    const connection = current(h);
    for (let index = 0; index < 100; index += 1) connection.push(postEvent(index, 1_000_000 + index));
    await vi.advanceTimersByTimeAsync(JETSTREAM.FLUSH_INTERVAL_MS);
    expect(vi.mocked(normalizeJetstreamEvent)).toHaveBeenCalledTimes(JETSTREAM.MAX_PLANTS_PER_SEC);
    h.source.stop();
  });

  it("dedupes replayed events through seenPosts and does not count them", async () => {
    const h = setup();
    h.source.start();
    await settle();
    current(h).push(postEvent(1, 10_000_000));
    await settle();
    current(h).fail(new Error("reset"));
    await settle();
    await vi.advanceTimersByTimeAsync(JETSTREAM.RECONNECT_MIN_MS);
    const resumed = current(h);
    expect(resumed.params.cursorUs).toBe(10_000_000);
    await vi.advanceTimersByTimeAsync(JETSTREAM.FLUSH_INTERVAL_MS);
    const postsBefore = h.batches.flatMap((batch) => batch.posts).length;
    const countBefore = h.batches.reduce((sum, batch) => sum + batch.meta.activityCount, 0);
    expect(postsBefore).toBe(1);

    resumed.push(postEvent(1, 10_000_001)); // same URI, replayed
    await vi.advanceTimersByTimeAsync(JETSTREAM.FLUSH_INTERVAL_MS);
    expect(h.batches.flatMap((batch) => batch.posts)).toHaveLength(postsBefore);
    expect(h.batches.reduce((sum, batch) => sum + batch.meta.activityCount, 0)).toBe(countBefore);
    h.source.stop();
  });
});
