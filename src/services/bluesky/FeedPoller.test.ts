import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GardenPost } from "../../domain/models";
import { setLogSinkForTesting } from "../../infra/logger";
import { GardenError, type GardenErrorKind } from "./errors";
import { backoffDelayMs, FeedPoller } from "./FeedPoller";
import type { PostBatchMeta } from "./PostSource";
import { SeenPostCache } from "./SeenPostCache";

function post(id: number): GardenPost {
  return {
    uri: `at://did:plc:test/app.bsky.feed.post/${id}`,
    text: "",
    createdAt: "2026-01-01T00:00:00.000Z",
    likeCount: 0,
    repostCount: 0,
  };
}

type FetchFn = (signal: AbortSignal) => Promise<GardenPost[]>;

interface Harness {
  poller: FeedPoller;
  seen: SeenPostCache;
  fetch: ReturnType<typeof vi.fn<FetchFn>>;
  posts: { uris: string[]; meta: PostBatchMeta }[];
  errors: { kind: GardenErrorKind; delay: number }[];
  recovered: ReturnType<typeof vi.fn>;
  fatal: GardenError[];
}

function createHarness(fetchImpl: FetchFn, seen = new SeenPostCache()): Harness {
  const fetch = vi.fn<FetchFn>(fetchImpl);
  const posts: Harness["posts"] = [];
  const errors: Harness["errors"] = [];
  const fatal: GardenError[] = [];
  const recovered = vi.fn();
  const poller = new FeedPoller({
    fetch,
    seenPosts: seen,
    events: {
      onPosts: (newPosts, meta) => {
        posts.push({ uris: newPosts.map((item) => item.uri), meta });
      },
      onError: (error, delay) => {
        errors.push({ kind: error.kind, delay });
      },
      onRecovered: recovered,
      onFatal: (error) => {
        fatal.push(error);
      },
    },
  });
  return { poller, seen, fetch, posts, errors, recovered, fatal };
}

const fail = (kind: GardenErrorKind, retryAfterMs?: number) => () =>
  Promise.reject(new GardenError(kind, retryAfterMs));

let restoreLog: () => void;

beforeEach(() => {
  vi.useFakeTimers();
  restoreLog = setLogSinkForTesting(() => undefined);
});

afterEach(() => {
  restoreLog();
  vi.useRealTimers();
});

describe("backoffDelayMs", () => {
  it("follows 15s, 30s, 60s, 60s", () => {
    expect([1, 2, 3, 4, 100].map(backoffDelayMs)).toEqual([15_000, 30_000, 60_000, 60_000, 60_000]);
  });
});

describe("FeedPoller scheduling", () => {
  it("fetches immediately and then every 15 seconds", async () => {
    const h = createHarness(() => Promise.resolve([]));
    h.poller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(14_999);
    expect(h.fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.fetch).toHaveBeenCalledTimes(2);
    h.poller.stop();
  });

  it("backs off 15 -> 30 -> 60 -> 60 after failures", async () => {
    const h = createHarness(fail("network"));
    h.poller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.errors.map((entry) => entry.delay)).toEqual([15_000]);
    await vi.advanceTimersByTimeAsync(15_000);
    await vi.advanceTimersByTimeAsync(30_000);
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.errors.map((entry) => entry.delay)).toEqual([15_000, 30_000, 60_000, 60_000, 60_000]);
    h.poller.stop();
  });

  it("resets after success and reports recovery once", async () => {
    let calls = 0;
    const h = createHarness(() => {
      calls += 1;
      return calls <= 2 ? Promise.reject(new GardenError("network")) : Promise.resolve([]);
    });
    h.poller.start();
    await vi.advanceTimersByTimeAsync(0); // fail 1
    await vi.advanceTimersByTimeAsync(15_000); // fail 2
    await vi.advanceTimersByTimeAsync(30_000); // success
    expect(h.recovered).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(15_000); // success again, no second recovery
    expect(h.recovered).toHaveBeenCalledTimes(1);
    expect(calls).toBe(4);
    h.poller.stop();
  });

  it("times out a hanging request, aborts it, and backs off", async () => {
    const captured: { signal: AbortSignal | null } = { signal: null };
    const h = createHarness((signal) => {
      captured.signal = signal;
      return new Promise<GardenPost[]>(() => undefined);
    });
    h.poller.start();
    await vi.advanceTimersByTimeAsync(19_999);
    expect(h.errors).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(captured.signal?.aborted).toBe(true);
    expect(h.errors).toEqual([{ kind: "timeout", delay: 15_000 }]);
    h.poller.stop();
  });

  it("does not count stop or pause aborts as errors", async () => {
    const h = createHarness((signal) => new Promise<GardenPost[]>((_resolve, reject) => {
      signal.addEventListener("abort", () => {
        reject(new DOMException("Aborted", "AbortError"));
      });
    }));
    h.poller.start();
    await vi.advanceTimersByTimeAsync(100);
    h.poller.pause();
    await vi.advanceTimersByTimeAsync(100_000);
    expect(h.errors).toEqual([]);
    h.poller.resume();
    await vi.advanceTimersByTimeAsync(100);
    h.poller.stop();
    await vi.advanceTimersByTimeAsync(100_000);
    expect(h.errors).toEqual([]);
    expect(h.fetch).toHaveBeenCalledTimes(2);
  });

  it("discards a result that resolves after stop", async () => {
    let resolveFetch: (value: GardenPost[]) => void = () => undefined;
    const h = createHarness(() => new Promise<GardenPost[]>((resolve) => {
      resolveFetch = resolve;
    }));
    h.poller.start();
    await vi.advanceTimersByTimeAsync(0);
    h.poller.stop();
    resolveFetch([post(1)]);
    await vi.advanceTimersByTimeAsync(100_000);
    expect(h.posts).toEqual([]);
    expect(h.seen.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("discards a result that resolves after pause, then refetches on resume", async () => {
    let resolveFetch: (value: GardenPost[]) => void = () => undefined;
    const h = createHarness(() => new Promise<GardenPost[]>((resolve) => {
      resolveFetch = resolve;
    }));
    h.poller.start();
    await vi.advanceTimersByTimeAsync(0);
    h.poller.pause();
    resolveFetch([post(1)]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(h.posts).toEqual([]);
    h.poller.resume();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.fetch).toHaveBeenCalledTimes(2);
    h.poller.stop();
  });

  it("keeps at most one timer after repeated start/stop", async () => {
    const h = createHarness(() => Promise.resolve([]));
    for (let index = 0; index < 5; index += 1) {
      h.poller.start();
      h.poller.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(vi.getTimerCount()).toBeLessThanOrEqual(1);
      h.poller.stop();
      h.poller.stop();
      expect(vi.getTimerCount()).toBe(0);
    }
  });

  it("pause and resume are idempotent", async () => {
    const h = createHarness(() => Promise.resolve([]));
    h.poller.resume();
    h.poller.pause();
    expect(h.fetch).not.toHaveBeenCalled();
    h.poller.start();
    await vi.advanceTimersByTimeAsync(0);
    h.poller.pause();
    h.poller.pause();
    expect(vi.getTimerCount()).toBe(0);
    h.poller.resume();
    h.poller.resume();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.fetch).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBeLessThanOrEqual(1);
    h.poller.stop();
  });

  it("does not fetch immediately on resume while backing off", async () => {
    const h = createHarness(fail("network"));
    h.poller.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(15_000); // second failure -> next delay 30 s
    expect(h.fetch).toHaveBeenCalledTimes(2);

    for (let i = 0; i < 5; i += 1) {
      h.poller.pause();
      h.poller.resume();
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(h.fetch).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(29_999);
    expect(h.fetch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(h.fetch).toHaveBeenCalledTimes(3);
    h.poller.stop();
  });
});

describe("FeedPoller errors", () => {
  it.each<GardenErrorKind>([
    "sessionExpired",
    "invalidCredentials",
    "accountUnavailable",
    "notFound",
    "unsupportedPds",
    "invalidFeedTarget",
    "notImplemented",
  ])("stops on fatal kind %s", async (kind) => {
    const h = createHarness(fail(kind));
    h.poller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.fatal.map((error) => error.kind)).toEqual([kind]);
    expect(h.errors).toEqual([]);
    await vi.advanceTimersByTimeAsync(200_000);
    expect(h.fetch).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("uses rate-limit wait when it exceeds the backoff", async () => {
    const h = createHarness(fail("rateLimited", 40_000));
    h.poller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.errors).toEqual([{ kind: "rateLimited", delay: 40_000 }]);
    h.poller.stop();
  });

  it("caps rate-limit waits at 60 s", async () => {
    const h = createHarness(fail("rateLimited", 600_000));
    h.poller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.errors).toEqual([{ kind: "rateLimited", delay: 60_000 }]);
    h.poller.stop();
  });

  it("falls back to backoff when the rate-limit wait is unknown or shorter", async () => {
    const h = createHarness(fail("rateLimited"));
    h.poller.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(h.errors.map((entry) => entry.delay)).toEqual([15_000, 30_000]);
    h.poller.stop();
  });

  it("keeps polling when callbacks throw", async () => {
    const fetch = vi.fn<FetchFn>(() => Promise.resolve([post(1)]));
    const poller = new FeedPoller({
      fetch,
      seenPosts: new SeenPostCache(),
      events: {
        onPosts: () => {
          throw new Error("consumer bug");
        },
        onError: () => undefined,
        onRecovered: () => undefined,
        onFatal: () => undefined,
      },
    });
    poller.start();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(fetch).toHaveBeenCalledTimes(2);
    poller.stop();
  });
});

describe("FeedPoller deduplication", () => {
  it("emits only new posts, oldest first, and reports zero activity for the first batch", async () => {
    const pages = [[post(3), post(2), post(1)], [post(4), post(3), post(2)], [post(4)]];
    let index = 0;
    const h = createHarness(() => Promise.resolve(pages[index++] ?? []));
    h.poller.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(15_000);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(h.posts.map((entry) => entry.uris.map((uri) => uri.slice(-1)))).toEqual([
      ["1", "2", "3"],
      ["4"],
      [],
    ]);
    expect(h.posts.map((entry) => entry.meta.activityCount)).toEqual([0, 1, 0]);
    h.poller.stop();
  });

  it("counts nothing on the first fetch even with a populated cache, then counts new posts", async () => {
    const seen = new SeenPostCache();
    seen.markIfNew(post(1).uri);
    const pages = [[post(2), post(1)], [post(4), post(3), post(2)]];
    let index = 0;
    const h = createHarness(() => Promise.resolve(pages[index++] ?? []), seen);
    h.poller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.posts).toHaveLength(1);
    expect(h.posts[0]?.meta.activityCount).toBe(0);
    expect(h.posts[0]?.uris).toEqual([post(2).uri]);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(h.posts[1]?.meta.activityCount).toBe(2);
    h.poller.stop();
  });

  it("drops duplicate URIs inside one page", async () => {
    const h = createHarness(() => Promise.resolve([post(1), post(1)]));
    h.poller.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.posts[0]?.uris).toHaveLength(1);
    h.poller.stop();
  });
});
