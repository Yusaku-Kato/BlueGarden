// @vitest-environment happy-dom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FEED } from "../config/gardenConfig";
import type { FeedTarget } from "../domain/models";
import type { SavedFeedInfo } from "../services/bluesky/feedDiscovery";
import FeedCaption, { FEED_CAPTION_VISIBLE_MS } from "./FeedCaption";

const NO_FEEDS: readonly SavedFeedInfo[] = [];
const CUSTOM_URI = "at://did:plc:x/app.bsky.feed.generator/cats";

function captionOf(target: FeedTarget, savedFeeds: readonly SavedFeedInfo[] = NO_FEEDS): string {
  render(<FeedCaption target={target} savedFeeds={savedFeeds} hidden={false} />);
  return screen.getByText(/眺めています/).textContent;
}

describe("FeedCaption", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("describes each kind of target", () => {
    expect(captionOf({ kind: "timeline" })).toBe("タイムラインを眺めています");
    cleanup();
    expect(captionOf({ kind: "global" })).toBe("Bluesky 全体 (Global Garden) を眺めています");
    cleanup();
    expect(captionOf({ kind: "keyword", query: "cats" })).toBe("“cats” の投稿を眺めています");
    cleanup();
    expect(captionOf({ kind: "custom", feedUri: FEED.DISCOVER_FEED_URI })).toBe("Discover を眺めています");
    cleanup();
    expect(captionOf({ kind: "custom", feedUri: CUSTOM_URI }, [{ uri: CUSTOM_URI, displayName: "Cat Pics" }])).toBe(
      "Cat Pics を眺めています",
    );
    cleanup();
    expect(captionOf({ kind: "custom", feedUri: CUSTOM_URI })).toBe("カスタムフィードを眺めています");
  });

  it("is a polite live region and disappears after the timeout", () => {
    const { container } = render(<FeedCaption target={{ kind: "timeline" }} savedFeeds={NO_FEEDS} hidden={false} />);
    expect(container.querySelector("[aria-live='polite']")).not.toBeNull();
    expect(screen.queryByText("タイムラインを眺めています")).not.toBeNull();
    act(() => {
      vi.advanceTimersByTime(FEED_CAPTION_VISIBLE_MS - 1);
    });
    expect(screen.queryByText("タイムラインを眺めています")).not.toBeNull();
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.queryByText("タイムラインを眺めています")).toBeNull();
  });

  it("shows a new caption when the target changes and restarts the timeout", () => {
    const { rerender } = render(<FeedCaption target={{ kind: "timeline" }} savedFeeds={NO_FEEDS} hidden={false} />);
    act(() => {
      vi.advanceTimersByTime(3_000);
    });
    rerender(<FeedCaption target={{ kind: "global" }} savedFeeds={NO_FEEDS} hidden={false} />);
    expect(screen.queryByText("Bluesky 全体 (Global Garden) を眺めています")).not.toBeNull();
    act(() => {
      vi.advanceTimersByTime(3_000);
    });
    expect(screen.queryByText("Bluesky 全体 (Global Garden) を眺めています")).not.toBeNull();
    expect(vi.getTimerCount()).toBe(1);
  });

  it("does not re-announce when only the saved feeds change", () => {
    const { rerender } = render(
      <FeedCaption target={{ kind: "custom", feedUri: CUSTOM_URI }} savedFeeds={NO_FEEDS} hidden={false} />,
    );
    rerender(
      <FeedCaption
        target={{ kind: "custom", feedUri: CUSTOM_URI }}
        savedFeeds={[{ uri: CUSTOM_URI, displayName: "Cat Pics" }]}
        hidden={false}
      />,
    );
    expect(screen.queryByText("カスタムフィードを眺めています")).not.toBeNull();
    expect(screen.queryByText("Cat Pics を眺めています")).toBeNull();
  });

  it("renders nothing visible in screensaver mode", () => {
    render(<FeedCaption target={{ kind: "timeline" }} savedFeeds={NO_FEEDS} hidden />);
    expect(screen.queryByText(/眺めています/)).toBeNull();
  });

  it("clears its timer on unmount", () => {
    const { unmount } = render(<FeedCaption target={{ kind: "timeline" }} savedFeeds={NO_FEEDS} hidden={false} />);
    expect(vi.getTimerCount()).toBe(1);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
