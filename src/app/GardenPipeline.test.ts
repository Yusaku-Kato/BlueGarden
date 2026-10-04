import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import type { EnvironmentState, PlantSeed } from "../domain/models";
import { engagement, plantScale } from "../domain/engagement";
import { TrendMeter } from "../domain/TrendMeter";
import { setLogSinkForTesting } from "../infra/logger";
import type { GardenErrorKind } from "../services/bluesky/errors";
import { BlueskyFeedClient, type FeedXrpc } from "../services/bluesky/BlueskyFeedClient";
import { SeenPostCache } from "../services/bluesky/SeenPostCache";
import type { EngagementClient } from "../services/bluesky/engagementClient";
import { createPostSource } from "./createPostSource";
import type { GardenSink } from "./gardenSink";
import { GardenPipeline } from "./GardenPipeline";

function timelineItem(id: number, text = "plain words") {
  return {
    post: {
      uri: `at://did:plc:test/app.bsky.feed.post/${String(id)}`,
      indexedAt: "2026-01-01T00:00:00.000Z",
      likeCount: 1,
      repostCount: 0,
      record: { text, createdAt: "2026-01-01T00:00:00.000Z" },
    },
  };
}

class FakeSink implements GardenSink {
  readonly seeds: PlantSeed[] = [];
  readonly environments: EnvironmentState[] = [];
  addPlant(seed: PlantSeed): void {
    this.seeds.push(seed);
  }
  readonly grown: { id: string; scale: number }[] = [];
  growPlant(id: string, scale: number): void {
    this.grown.push({ id, scale });
  }
  setEnvironment(environment: EnvironmentState): void {
    this.environments.push(environment);
  }
}

const unusedXrpc: Pick<FeedXrpc, "getFeed" | "searchPosts"> = {
  getFeed: () => Promise.reject(new Error("unused")),
  searchPosts: () => Promise.reject(new Error("unused")),
};

function httpError(status: number): Error {
  return Object.assign(new Error("http"), { status });
}

function createFeedClient(pages: unknown[][]): BlueskyFeedClient {
  let index = 0;
  const xrpc: FeedXrpc = {
    ...unusedXrpc,
    getTimeline: () => Promise.resolve({ feed: pages[index++] ?? [] }),
  };
  return new BlueskyFeedClient(xrpc);
}

interface Callbacks {
  onError: Mock<(kind: GardenErrorKind, nextDelayMs: number) => void>;
  onRecovered: Mock<() => void>;
  onSessionFatal: Mock<(kind: GardenErrorKind) => void>;
  onTargetFatal: Mock<(kind: GardenErrorKind) => void>;
}

function createCallbacks(): Callbacks {
  return { onError: vi.fn(), onRecovered: vi.fn(), onSessionFatal: vi.fn(), onTargetFatal: vi.fn() };
}

function createPipeline(
  client: BlueskyFeedClient,
  sink: GardenSink,
  seenPosts: SeenPostCache,
  callbacks: Callbacks = createCallbacks(),
): GardenPipeline {
  return new GardenPipeline({
    createSource: (events) => createPostSource({ feedClient: client, seenPosts }, { kind: "timeline" }, events),
    sink,
    trend: new TrendMeter(),
    now: () => Date.now(),
    localMinutes: () => 720,
    ...callbacks,
  });
}

let restoreLog: () => void;

beforeEach(() => {
  vi.useFakeTimers();
  restoreLog = setLogSinkForTesting(() => undefined);
});

afterEach(() => {
  restoreLog();
  vi.useRealTimers();
});

describe("GardenPipeline", () => {
  it("plants one seed per new post and ignores re-polled URIs", async () => {
    const sink = new FakeSink();
    const pipeline = createPipeline(
      createFeedClient([[timelineItem(2), timelineItem(1)], [timelineItem(2), timelineItem(1)]]),
      sink,
      new SeenPostCache(),
    );
    pipeline.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(sink.seeds).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(sink.seeds).toHaveLength(2);
    pipeline.stop();
  });

  it("plants exactly one seed for one post", async () => {
    const sink = new FakeSink();
    const pipeline = createPipeline(createFeedClient([[timelineItem(1)]]), sink, new SeenPostCache());
    pipeline.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(sink.seeds).toHaveLength(1);
    pipeline.stop();
  });

  it("emits seeds with exactly the allowed PlantSeed keys and opaque sequential ids", async () => {
    const sink = new FakeSink();
    const pipeline = createPipeline(
      createFeedClient([[timelineItem(2, "so happy"), timelineItem(1, "so sad")]]),
      sink,
      new SeenPostCache(),
    );
    pipeline.start();
    await vi.advanceTimersByTimeAsync(0);
    for (const seed of sink.seeds) {
      expect(Object.keys(seed).sort()).toEqual(["color", "growthDurationMs", "id", "mood", "scale", "thorny"]);
    }
    expect(sink.seeds.map((seed) => seed.id)).toEqual(["plant-1", "plant-2"]);
    expect(sink.seeds.map((seed) => seed.mood)).toEqual(["negative", "positive"]);
    pipeline.stop();
  });

  it("emits a calm environment on start, then one per batch with mood-derived shares", async () => {
    const sink = new FakeSink();
    const pipeline = createPipeline(
      createFeedClient([[timelineItem(3, "so happy"), timelineItem(2, "so happy"), timelineItem(1)]]),
      sink,
      new SeenPostCache(),
    );
    pipeline.start();
    expect(sink.environments).toHaveLength(1);
    expect(sink.environments[0]?.weather.postsPerMinute).toBe(0);
    expect(sink.environments[0]?.climate).toBe("temperate");
    await vi.advanceTimersByTimeAsync(0);
    expect(sink.environments).toHaveLength(2);
    const environment = sink.environments[1];
    expect(environment?.dayPhase).toBe(0.5);
    expect(environment?.weather.light).toBe(1); // 2 of 3 positive
    expect(environment?.weather.fog).toBe(0);
    pipeline.stop();
  });

  it("does not count the initial batch in activity, but counts later posts", async () => {
    const sink = new FakeSink();
    const pipeline = createPipeline(
      createFeedClient([[timelineItem(1), timelineItem(2)], [timelineItem(3)]]),
      sink,
      new SeenPostCache(),
    );
    pipeline.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(sink.environments.at(-1)?.weather.postsPerMinute).toBe(0);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(sink.environments.at(-1)?.weather.postsPerMinute).toBe(1);
    pipeline.stop();
  });

  it("re-emits the environment on a slow timer without posts", async () => {
    const sink = new FakeSink();
    const pipeline = createPipeline(createFeedClient([[]]), sink, new SeenPostCache());
    pipeline.start();
    await vi.advanceTimersByTimeAsync(0);
    const before = sink.environments.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sink.environments.length).toBeGreaterThan(before);
    pipeline.stop();
  });

  it("does not replant when a new pipeline reuses the session cache", async () => {
    const sink = new FakeSink();
    const seen = new SeenPostCache();
    const page = [timelineItem(2), timelineItem(1)];
    const first = createPipeline(createFeedClient([page]), sink, seen);
    first.start();
    await vi.advanceTimersByTimeAsync(0);
    first.stop();
    expect(sink.seeds).toHaveLength(2);

    const second = createPipeline(createFeedClient([page]), sink, seen);
    second.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(sink.seeds).toHaveLength(2);
    second.stop();
  });

  it("calms the environment on stop, idempotently, and clears every timer", async () => {
    const sink = new FakeSink();
    const pipeline = createPipeline(createFeedClient([[timelineItem(1)]]), sink, new SeenPostCache());
    pipeline.start();
    await vi.advanceTimersByTimeAsync(0);
    pipeline.stop();
    const emitted = sink.environments.length;
    pipeline.stop();
    expect(sink.environments).toHaveLength(emitted);
    expect(sink.environments.at(-1)?.weather.postsPerMinute).toBe(0);
    expect(sink.environments.at(-1)?.climate).toBe("temperate");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears the environment timer while paused and restarts it on resume", async () => {
    const pipeline = createPipeline(createFeedClient([[]]), new FakeSink(), new SeenPostCache());
    pipeline.start();
    await vi.advanceTimersByTimeAsync(0);
    pipeline.pause();
    expect(vi.getTimerCount()).toBe(0);
    pipeline.resume();
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    pipeline.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("survives a throwing sink", async () => {
    const throwing: GardenSink = {
      addPlant: () => {
        throw new Error("sink bug");
      },
      growPlant: () => {
        throw new Error("sink bug");
      },
      setEnvironment: () => {
        throw new Error("sink bug");
      },
    };
    const pipeline = createPipeline(
      createFeedClient([[timelineItem(1)], [timelineItem(2)]]),
      throwing,
      new SeenPostCache(),
    );
    pipeline.start();
    await vi.advanceTimersByTimeAsync(15_000);
    pipeline.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reports feed failures through onError and keeps going", async () => {
    const callbacks = createCallbacks();
    const failing: FeedXrpc = { ...unusedXrpc, getTimeline: () => Promise.reject(new TypeError("offline")) };
    const pipeline = createPipeline(new BlueskyFeedClient(failing), new FakeSink(), new SeenPostCache(), callbacks);
    pipeline.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(callbacks.onError).toHaveBeenCalledWith("network", 15_000);
    pipeline.stop();
  });

  it("routes target-fatal errors to onTargetFatal only", async () => {
    const callbacks = createCallbacks();
    const missing: FeedXrpc = { ...unusedXrpc, getTimeline: () => Promise.reject(httpError(404)) };
    const pipeline = createPipeline(new BlueskyFeedClient(missing), new FakeSink(), new SeenPostCache(), callbacks);
    pipeline.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(callbacks.onTargetFatal).toHaveBeenCalledWith("notFound");
    expect(callbacks.onSessionFatal).not.toHaveBeenCalled();
    pipeline.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("routes session-fatal errors to onSessionFatal", async () => {
    const callbacks = createCallbacks();
    const expired: FeedXrpc = { ...unusedXrpc, getTimeline: () => Promise.reject(httpError(401)) };
    const pipeline = createPipeline(new BlueskyFeedClient(expired), new FakeSink(), new SeenPostCache(), callbacks);
    pipeline.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(callbacks.onSessionFatal).toHaveBeenCalledWith("sessionExpired");
    expect(callbacks.onTargetFatal).not.toHaveBeenCalled();
    pipeline.stop();
  });

  it("reports notImplemented as target-fatal when a guest (no feed client) asks for a session feed", () => {
    const callbacks = createCallbacks();
    const pipeline = new GardenPipeline({
      createSource: (events) => createPostSource({ seenPosts: new SeenPostCache() }, { kind: "timeline" }, events),
      sink: new FakeSink(),
      trend: new TrendMeter(),
      ...callbacks,
    });
    pipeline.start();
    expect(callbacks.onTargetFatal).toHaveBeenCalledWith("notImplemented");
    pipeline.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("runs the global feed through the Jetstream source without a session and cleans up", () => {
    const callbacks = createCallbacks();
    const pending = (): Promise<IteratorResult<unknown>> => new Promise(() => undefined);
    const pipeline = new GardenPipeline({
      createSource: (events) =>
        createPostSource({ seenPosts: new SeenPostCache() }, { kind: "global" }, events, {
          jetstreamConnector: () => ({ [Symbol.asyncIterator]: () => ({ next: pending }) }),
        }),
      sink: new FakeSink(),
      trend: new TrendMeter(),
      ...callbacks,
    });
    pipeline.start();
    expect(callbacks.onTargetFatal).not.toHaveBeenCalled();
    expect(callbacks.onSessionFatal).not.toHaveBeenCalled();
    pipeline.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  describe("after-growth tracking", () => {
    const POST_URI = "at://did:plc:test/app.bsky.feed.post/1";

    function createEngagementClient(): { client: EngagementClient; fetchCounts: Mock } {
      const fetchCounts = vi.fn(() => Promise.resolve(new Map([[POST_URI, { likeCount: 100, repostCount: 10 }]])));
      return { client: { fetchCounts }, fetchCounts };
    }

    function createTrackedPipeline(sink: FakeSink, engagementClient?: EngagementClient): GardenPipeline {
      return new GardenPipeline({
        createSource: (events) =>
          createPostSource(
            { feedClient: createFeedClient([[timelineItem(1)]]), seenPosts: new SeenPostCache() },
            { kind: "timeline" },
            events,
          ),
        sink,
        trend: new TrendMeter(),
        localMinutes: () => 720,
        ...(engagementClient === undefined ? {} : { engagementClient }),
        ...createCallbacks(),
      });
    }

    it("grows a planted post by its re-fetched engagement after the delay", async () => {
      const sink = new FakeSink();
      const { client, fetchCounts } = createEngagementClient();
      const pipeline = createTrackedPipeline(sink, client);
      pipeline.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(sink.grown).toHaveLength(0);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(fetchCounts).toHaveBeenCalledTimes(1);
      expect(sink.grown).toHaveLength(1);
      expect(sink.grown[0]?.id).toBe(sink.seeds[0]?.id);
      expect(sink.grown[0]?.scale).toBe(plantScale(engagement(100, 10)));
      pipeline.stop();
    });

    it("does not track or grow anything without an engagement client", async () => {
      const sink = new FakeSink();
      const pipeline = createTrackedPipeline(sink);
      pipeline.start();
      await vi.advanceTimersByTimeAsync(40_000);
      expect(sink.seeds).toHaveLength(1);
      expect(sink.grown).toHaveLength(0);
      pipeline.stop();
    });

    it("clears the tracker on stop", async () => {
      const sink = new FakeSink();
      const { client, fetchCounts } = createEngagementClient();
      const pipeline = createTrackedPipeline(sink, client);
      pipeline.start();
      await vi.advanceTimersByTimeAsync(0);
      pipeline.stop();
      expect(vi.getTimerCount()).toBe(0);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(fetchCounts).not.toHaveBeenCalled();
      expect(sink.grown).toHaveLength(0);
    });
  });
});
