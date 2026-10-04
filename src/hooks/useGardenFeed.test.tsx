// @vitest-environment happy-dom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FeedTarget } from "../domain/models";
import { TrendMeter } from "../domain/TrendMeter";
import { FEED_SWITCH_FADE_MS, type TerrariumRenderer } from "../rendering/TerrariumRenderer";
import type { GardenAccess } from "../services/bluesky/blueskySession";

interface PipelineOptions {
  createSource: (events: unknown) => unknown;
  engagementClient?: unknown;
  onError: (kind: string, delay: number) => void;
  onRecovered: () => void;
  onSessionFatal: (kind: string) => void;
  onTargetFatal: (kind: string) => void;
}

const mocks = vi.hoisted(() => {
  const pipelines: {
    options: PipelineOptions;
    start: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
    pause: ReturnType<typeof vi.fn>;
    resume: ReturnType<typeof vi.fn>;
  }[] = [];
  return { pipelines, createPostSource: vi.fn() };
});

vi.mock("../app/GardenPipeline", () => ({
  GardenPipeline: class {
    start = vi.fn();
    stop = vi.fn();
    pause = vi.fn();
    resume = vi.fn();
    constructor(options: PipelineOptions) {
      mocks.pipelines.push({ options, start: this.start, stop: this.stop, pause: this.pause, resume: this.resume });
    }
  },
}));
vi.mock("../app/createPostSource", () => ({ createPostSource: mocks.createPostSource }));

const { useGardenFeed } = await import("./useGardenFeed");

const TIMELINE: FeedTarget = { kind: "timeline" };
const GLOBAL: FeedTarget = { kind: "global" };

const clearPending = vi.fn();
const fadeOutAll = vi.fn();

function makeEngine(): TerrariumRenderer {
  return { clearPending, fadeOutAll } as unknown as TerrariumRenderer;
}

function sessionAccess(did = "did:plc:a"): GardenAccess {
  return {
    authMethod: "appPassword",
    handle: "alice.bsky.social",
    did,
    feedClient: { fetchLatest: vi.fn() },
    engagementClient: {},
    seenPosts: {},
  } as unknown as GardenAccess;
}

function guestAccess(): GardenAccess {
  return { authMethod: "guest", engagementClient: {}, seenPosts: {} } as unknown as GardenAccess;
}

function lastPipeline(): (typeof mocks.pipelines)[number] {
  const pipeline = mocks.pipelines[mocks.pipelines.length - 1];
  if (pipeline === undefined) throw new Error("no pipeline created");
  return pipeline;
}

describe("useGardenFeed", () => {
  const resetSpy = vi.fn();

  beforeEach(() => {
    resetSpy.mockReset();
    clearPending.mockReset();
    fadeOutAll.mockReset();
    mocks.pipelines.length = 0;
    mocks.createPostSource.mockReset();
    vi.spyOn(TrendMeter.prototype, "reset").mockImplementation(() => {
      resetSpy();
    });
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("does nothing without an access or an engine", () => {
    renderHook(() => useGardenFeed(null, makeEngine(), TIMELINE, vi.fn(), false));
    renderHook(() => useGardenFeed(sessionAccess(), null, TIMELINE, vi.fn(), false));
    expect(mocks.pipelines).toHaveLength(0);
  });

  it("a target-fatal error sets targetError and does not report a lost session", () => {
    const onSessionLost = vi.fn();
    const access = sessionAccess();
    const engine = makeEngine();
    const { result } = renderHook(() => useGardenFeed(access, engine, TIMELINE, onSessionLost, false));
    act(() => {
      lastPipeline().options.onError("network", 15_000);
    });
    expect(result.current.feedError).toEqual({ source: "feed", kind: "network" });
    act(() => {
      lastPipeline().options.onTargetFatal("notFound");
    });
    expect(result.current.targetError).toEqual({ source: "target", kind: "notFound" });
    expect(result.current.feedError).toBeNull();
    expect(onSessionLost).not.toHaveBeenCalled();
  });

  it("a session-fatal error is forwarded to onSessionLost", () => {
    const onSessionLost = vi.fn();
    const access = sessionAccess();
    const engine = makeEngine();
    renderHook(() => useGardenFeed(access, engine, TIMELINE, onSessionLost, false));
    lastPipeline().options.onSessionFatal("sessionExpired");
    expect(onSessionLost).toHaveBeenCalledWith("sessionExpired");
  });

  it("resets the trend on a target change but not when only the engine changes", () => {
    const access = sessionAccess();
    const engineA = makeEngine();
    const engineB = makeEngine();
    interface Props {
      engine: TerrariumRenderer;
      target: FeedTarget;
    }
    const initial: Props = { engine: engineA, target: TIMELINE };
    const { rerender } = renderHook(
      (props: Props) => useGardenFeed(access, props.engine, props.target, vi.fn(), false),
      { initialProps: initial },
    );
    expect(resetSpy).toHaveBeenCalledTimes(1);
    expect(mocks.pipelines).toHaveLength(1);

    rerender({ engine: engineB, target: TIMELINE });
    expect(mocks.pipelines).toHaveLength(2); // pipeline rebuilt for the new engine
    expect(resetSpy).toHaveBeenCalledTimes(1); // trend kept

    rerender({ engine: engineB, target: GLOBAL });
    expect(mocks.pipelines).toHaveLength(3);
    expect(resetSpy).toHaveBeenCalledTimes(2);
  });

  it("resets the trend when the access identity changes", () => {
    const engine = makeEngine();
    const { rerender } = renderHook((props: { access: GardenAccess }) => useGardenFeed(props.access, engine, TIMELINE, vi.fn(), false), {
      initialProps: { access: sessionAccess("did:plc:a") },
    });
    expect(resetSpy).toHaveBeenCalledTimes(1);
    rerender({ access: sessionAccess("did:plc:b") });
    expect(resetSpy).toHaveBeenCalledTimes(2);
  });

  it("pause and resume reach the running pipeline, and a new pipeline starts paused when needed", () => {
    const access = sessionAccess();
    const engine = makeEngine();
    const { rerender } = renderHook(
      (props: { paused: boolean }) => useGardenFeed(access, engine, TIMELINE, vi.fn(), props.paused),
      { initialProps: { paused: false } },
    );
    const pipeline = lastPipeline();
    expect(pipeline.start).toHaveBeenCalledTimes(1);
    pipeline.resume.mockClear();
    rerender({ paused: true });
    expect(pipeline.pause).toHaveBeenCalledTimes(1);
    rerender({ paused: false });
    expect(pipeline.resume).toHaveBeenCalledTimes(1);

    const pausedEngine = makeEngine();
    const pausedHook = renderHook(() => useGardenFeed(access, pausedEngine, TIMELINE, vi.fn(), true));
    expect(lastPipeline().pause).toHaveBeenCalled();
    pausedHook.unmount();
  });

  it("a guest gets global source access without a feed client", () => {
    const guest = guestAccess();
    const engine = makeEngine();
    renderHook(() => useGardenFeed(guest, engine, GLOBAL, vi.fn(), false));
    const events = {};
    lastPipeline().options.createSource(events);
    expect(mocks.createPostSource).toHaveBeenCalledTimes(1);
    const [sourceAccess, target, passedEvents] = mocks.createPostSource.mock.calls[0] as [
      Record<string, unknown>,
      FeedTarget,
      unknown,
    ];
    expect("feedClient" in sourceAccess).toBe(false);
    expect(sourceAccess.seenPosts).toBe((guest as { seenPosts: unknown }).seenPosts);
    expect(target).toEqual(GLOBAL);
    expect(passedEvents).toBe(events);
    expect(lastPipeline().options.engagementClient).toBeDefined();
  });

  it("a session gets its feed client, and no engagement client for non-global targets", () => {
    const access = sessionAccess();
    const engine = makeEngine();
    renderHook(() => useGardenFeed(access, engine, TIMELINE, vi.fn(), false));
    lastPipeline().options.createSource({});
    const [sourceAccess] = mocks.createPostSource.mock.calls[0] as [Record<string, unknown>];
    expect("feedClient" in sourceAccess).toBe(true);
    expect(lastPipeline().options.engagementClient).toBeUndefined();
  });

  describe("feed switch fade", () => {
    interface Props {
      access: GardenAccess;
      engine: TerrariumRenderer;
      target: FeedTarget;
    }
    function mount(initial: Props) {
      return renderHook((props: Props) => useGardenFeed(props.access, props.engine, props.target, vi.fn(), false), {
        initialProps: initial,
      });
    }

    it("fades everything out when the target changes for the same access", () => {
      const access = sessionAccess();
      const engine = makeEngine();
      const { rerender } = mount({ access, engine, target: TIMELINE });
      rerender({ access, engine, target: GLOBAL });
      expect(fadeOutAll).toHaveBeenCalledTimes(1);
      expect(fadeOutAll).toHaveBeenCalledWith(FEED_SWITCH_FADE_MS);
    });

    it("does not fade on first mount", () => {
      mount({ access: sessionAccess(), engine: makeEngine(), target: TIMELINE });
      expect(fadeOutAll).not.toHaveBeenCalled();
    });

    it("does not fade when only the engine changes", () => {
      const access = sessionAccess();
      const { rerender } = mount({ access, engine: makeEngine(), target: TIMELINE });
      rerender({ access, engine: makeEngine(), target: TIMELINE });
      expect(fadeOutAll).not.toHaveBeenCalled();
    });

    it("does not fade when the access changes, even together with the target", () => {
      const engine = makeEngine();
      const { rerender } = mount({ access: sessionAccess("did:plc:a"), engine, target: TIMELINE });
      rerender({ access: sessionAccess("did:plc:b"), engine, target: TIMELINE });
      rerender({ access: guestAccess(), engine, target: GLOBAL });
      expect(fadeOutAll).not.toHaveBeenCalled();
    });
  });

  it("cleanup stops the pipeline and clears pending plants", () => {
    const engine = makeEngine();
    const access = sessionAccess();
    const { unmount } = renderHook(() => useGardenFeed(access, engine, TIMELINE, vi.fn(), false));
    const pipeline = lastPipeline();
    unmount();
    expect(pipeline.stop).toHaveBeenCalledTimes(1);
    expect(clearPending).toHaveBeenCalledTimes(1);
  });
});
