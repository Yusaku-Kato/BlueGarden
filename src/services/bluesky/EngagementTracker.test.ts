import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AFTER_GROWTH, POLLING } from "../../config/gardenConfig";
import type { EngagementClient, EngagementCounts } from "./engagementClient";
import { GardenError } from "./errors";
import { EngagementTracker } from "./EngagementTracker";

const uri = (index: number): string => `at://did:plc:abcdefghijklmnopqrstuvwx/app.bsky.feed.post/${String(index)}`;

interface Harness {
  tracker: EngagementTracker;
  calls: { uris: readonly string[]; signal: AbortSignal }[];
  updates: { token: string; counts: EngagementCounts }[];
  setResult(map: Map<string, EngagementCounts>): void;
  failNext(): void;
}

function setup(): Harness {
  const calls: Harness["calls"] = [];
  const updates: Harness["updates"] = [];
  let result = new Map<string, EngagementCounts>();
  let fail = false;
  const client: EngagementClient = {
    fetchCounts: (uris, signal) => {
      calls.push({ uris, signal });
      if (fail) {
        fail = false;
        return Promise.reject(new GardenError("network"));
      }
      return Promise.resolve(result);
    },
  };
  const tracker = new EngagementTracker({
    client,
    onUpdate: (token, counts) => updates.push({ token, counts }),
  });
  return {
    tracker,
    calls,
    updates,
    setResult: (map) => {
      result = map;
    },
    failNext: () => {
      fail = true;
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("EngagementTracker", () => {
  it("checks an entry once after DELAY_MS, reports counts, then forgets it", async () => {
    const h = setup();
    h.setResult(new Map([[uri(1), { likeCount: 7, repostCount: 3 }]]));
    h.tracker.start();
    h.tracker.track(uri(1), "plant-1");
    await vi.advanceTimersByTimeAsync(AFTER_GROWTH.DELAY_MS - 1);
    expect(h.calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.calls).toHaveLength(1);
    expect(h.updates).toEqual([{ token: "plant-1", counts: { likeCount: 7, repostCount: 3 } }]);
    expect(h.tracker.size).toBe(0);
    await vi.advanceTimersByTimeAsync(AFTER_GROWTH.DELAY_MS * 3);
    expect(h.calls).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("batches entries that are due together and omits posts the server did not return", async () => {
    const h = setup();
    h.setResult(new Map([[uri(1), { likeCount: 1, repostCount: 0 }]]));
    h.tracker.start();
    h.tracker.track(uri(1), "plant-1");
    h.tracker.track(uri(2), "plant-2");
    await vi.advanceTimersByTimeAsync(AFTER_GROWTH.DELAY_MS);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]?.uris).toEqual([uri(1), uri(2)]);
    expect(h.updates.map((update) => update.token)).toEqual(["plant-1"]);
    expect(h.tracker.size).toBe(0);
  });

  it("checks later entries in a later call", async () => {
    const h = setup();
    h.tracker.start();
    h.tracker.track(uri(1), "plant-1");
    await vi.advanceTimersByTimeAsync(10_000);
    h.tracker.track(uri(2), "plant-2");
    await vi.advanceTimersByTimeAsync(AFTER_GROWTH.DELAY_MS - 10_000);
    expect(h.calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.calls).toHaveLength(2);
    expect(h.calls[1]?.uris).toEqual([uri(2)]);
  });

  it("is bounded to TRACK_LIMIT and drops the oldest first", () => {
    const h = setup();
    for (let index = 0; index < AFTER_GROWTH.TRACK_LIMIT + 5; index += 1) h.tracker.track(uri(index), `plant-${String(index)}`);
    expect(h.tracker.size).toBe(AFTER_GROWTH.TRACK_LIMIT);
  });

  it("drops the oldest tokens on overflow", async () => {
    const h = setup();
    h.setResult(new Map([[uri(0), { likeCount: 1, repostCount: 1 }], [uri(5), { likeCount: 2, repostCount: 2 }]]));
    h.tracker.start();
    for (let index = 0; index < AFTER_GROWTH.TRACK_LIMIT + 5; index += 1) h.tracker.track(uri(index), `plant-${String(index)}`);
    await vi.advanceTimersByTimeAsync(AFTER_GROWTH.DELAY_MS);
    expect(h.updates.map((update) => update.token)).toEqual(["plant-5"]);
  });

  it("forgets the entry when the request fails (each entry is checked once)", async () => {
    const h = setup();
    h.failNext();
    h.tracker.start();
    h.tracker.track(uri(1), "plant-1");
    await vi.advanceTimersByTimeAsync(AFTER_GROWTH.DELAY_MS);
    expect(h.updates).toHaveLength(0);
    expect(h.tracker.size).toBe(0);
    await vi.advanceTimersByTimeAsync(AFTER_GROWTH.DELAY_MS * 2);
    expect(h.calls).toHaveLength(1);
  });

  it("pause stops the timer and the request; resume checks overdue entries", async () => {
    const h = setup();
    h.setResult(new Map([[uri(1), { likeCount: 4, repostCount: 0 }]]));
    h.tracker.start();
    h.tracker.track(uri(1), "plant-1");
    await vi.advanceTimersByTimeAsync(5_000);
    h.tracker.pause();
    h.tracker.pause();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(AFTER_GROWTH.DELAY_MS * 2);
    expect(h.calls).toHaveLength(0);
    expect(h.tracker.size).toBe(1);
    h.tracker.resume();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.updates).toHaveLength(1);
  });

  it("aborts an in-flight request on stop and ignores its result", async () => {
    const calls: AbortSignal[] = [];
    let release: (map: Map<string, EngagementCounts>) => void = () => undefined;
    const updates: string[] = [];
    const tracker = new EngagementTracker({
      client: {
        fetchCounts: (_uris, signal) => {
          calls.push(signal);
          return new Promise((resolve) => {
            release = resolve;
          });
        },
      },
      onUpdate: (token) => updates.push(token),
    });
    tracker.start();
    tracker.track(uri(1), "plant-1");
    await vi.advanceTimersByTimeAsync(AFTER_GROWTH.DELAY_MS);
    expect(calls).toHaveLength(1);
    tracker.stop();
    expect(calls[0]?.aborted).toBe(true);
    release(new Map([[uri(1), { likeCount: 1, repostCount: 1 }]]));
    await vi.advanceTimersByTimeAsync(0);
    expect(updates).toHaveLength(0);
    expect(tracker.size).toBe(0);
    tracker.track(uri(2), "plant-2"); // ignored after stop
    expect(tracker.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does nothing until started", async () => {
    const h = setup();
    h.tracker.track(uri(1), "plant-1");
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(AFTER_GROWTH.DELAY_MS * 2);
    expect(h.calls).toHaveLength(0);
    h.tracker.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.calls).toHaveLength(1);
  });

  it("survives an onUpdate that throws", async () => {
    const tracker = new EngagementTracker({
      client: { fetchCounts: () => Promise.resolve(new Map([[uri(1), { likeCount: 1, repostCount: 0 }]])) },
      onUpdate: () => {
        throw new Error("boom");
      },
    });
    tracker.start();
    tracker.track(uri(1), "plant-1");
    await vi.advanceTimersByTimeAsync(AFTER_GROWTH.DELAY_MS);
    expect(tracker.size).toBe(0);
    tracker.stop();
  });

  it("times out a request that never settles, aborts it, drops the batch and keeps scheduling", async () => {
    const signals: AbortSignal[] = [];
    const updates: string[] = [];
    let hang = true;
    const client: EngagementClient = {
      fetchCounts: (uris, signal) => {
        signals.push(signal);
        if (hang) return new Promise<never>(() => undefined);
        return Promise.resolve(new Map(uris.map((u) => [u, { likeCount: 1, repostCount: 1 }])));
      },
    };
    const tracker = new EngagementTracker({ client, onUpdate: (token) => updates.push(token) });
    tracker.start();
    tracker.track(uri(1), "plant-1");
    await vi.advanceTimersByTimeAsync(AFTER_GROWTH.DELAY_MS);
    expect(signals).toHaveLength(1);
    expect(signals[0]?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(POLLING.FETCH_TIMEOUT_MS);
    expect(signals[0]?.aborted).toBe(true);
    expect(tracker.size).toBe(0);

    hang = false;
    tracker.track(uri(2), "plant-2");
    await vi.advanceTimersByTimeAsync(AFTER_GROWTH.DELAY_MS);
    expect(signals).toHaveLength(2);
    expect(updates).toEqual(["plant-2"]);
    tracker.stop();
  });
});
