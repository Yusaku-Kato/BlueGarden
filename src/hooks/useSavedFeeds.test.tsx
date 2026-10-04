// @vitest-environment happy-dom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SavedFeedInfo } from "../services/bluesky/feedDiscovery";
import type { BlueskySessionHandle } from "../services/bluesky/blueskySession";

const mocks = vi.hoisted(() => ({ listSavedFeeds: vi.fn() }));

vi.mock("../services/bluesky/feedDiscovery", () => ({ listSavedFeeds: mocks.listSavedFeeds }));

const { useSavedFeeds } = await import("./useSavedFeeds");

const FEEDS: SavedFeedInfo[] = [{ uri: "at://did:plc:x/app.bsky.feed.generator/a", displayName: "A" }];

function makeSession(): BlueskySessionHandle {
  return { feedDirectory: {} } as unknown as BlueskySessionHandle;
}

interface Deferred {
  readonly signal: AbortSignal;
  resolve: (feeds: SavedFeedInfo[]) => void;
}

function captureCalls(): Deferred[] {
  const calls: Deferred[] = [];
  mocks.listSavedFeeds.mockImplementation(
    (_xrpc: unknown, signal: AbortSignal) =>
      new Promise<SavedFeedInfo[]>((resolve) => {
        calls.push({ signal, resolve });
      }),
  );
  return calls;
}

describe("useSavedFeeds", () => {
  beforeEach(() => {
    mocks.listSavedFeeds.mockReset();
  });
  afterEach(() => {
    cleanup();
  });

  it("does not load while inactive or without a session", () => {
    const calls = captureCalls();
    renderHook(() => useSavedFeeds(makeSession(), false));
    renderHook(() => useSavedFeeds(null, true));
    expect(calls).toHaveLength(0);
  });

  it("loads feeds when active and reports loading until settled", async () => {
    const calls = captureCalls();
    const session = makeSession();
    const { result } = renderHook(() => useSavedFeeds(session, true));
    expect(result.current.loading).toBe(true);
    await act(async () => {
      calls[0]?.resolve(FEEDS);
      await Promise.resolve();
    });
    expect(result.current.loading).toBe(false);
    expect(result.current.savedFeeds).toEqual(FEEDS);
  });

  it("aborts when the panel closes and ignores the late result", async () => {
    const calls = captureCalls();
    const session = makeSession();
    const { result, rerender } = renderHook((props: { active: boolean }) => useSavedFeeds(session, props.active), {
      initialProps: { active: true },
    });
    rerender({ active: false });
    expect(calls[0]?.signal.aborted).toBe(true);
    await act(async () => {
      calls[0]?.resolve(FEEDS);
      await Promise.resolve();
    });
    expect(result.current.savedFeeds).toEqual([]);
    expect(result.current.loading).toBe(false);
  });

  it("aborts on unmount", () => {
    const calls = captureCalls();
    const { unmount } = renderHook(() => useSavedFeeds(makeSession(), true));
    unmount();
    expect(calls[0]?.signal.aborted).toBe(true);
  });
});
