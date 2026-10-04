import { useEffect, useRef, useState } from "react";
import { FEED } from "../config/gardenConfig";
import type { FeedTarget } from "../domain/models";
import { parseFeedTarget } from "../domain/settings";
import type { SavedFeedInfo } from "../services/bluesky/feedDiscovery";

/** How long the caption stays in the DOM; the CSS animation fades it in and out within this time. */
export const FEED_CAPTION_VISIBLE_MS = 4_000;

export interface FeedCaptionProps {
  target: FeedTarget;
  /** Used to look up a custom feed's display name when available. */
  savedFeeds: readonly SavedFeedInfo[];
  /** True in screensaver mode: nothing is shown. */
  hidden: boolean;
}

export function captionTextFor(target: FeedTarget, savedFeeds: readonly SavedFeedInfo[]): string {
  switch (target.kind) {
    case "timeline":
      return "タイムラインを眺めています";
    case "global":
      return "Bluesky 全体 (Global Garden) を眺めています";
    case "keyword":
      return `“${target.query}” の投稿を眺めています`;
    case "custom": {
      if (target.feedUri === FEED.DISCOVER_FEED_URI) return "Discover を眺めています";
      const known = savedFeeds.find((feed) => feed.uri === target.feedUri);
      return known === undefined ? "カスタムフィードを眺めています" : `${known.displayName} を眺めています`;
    }
  }
}

/**
 * A calm, short-lived note near the bottom center naming the feed being watched. It appears when
 * the effective feed changes (including the first entry into the garden) and removes itself after
 * FEED_CAPTION_VISIBLE_MS. A single timer is cleared on every change and on unmount.
 */
export default function FeedCaption({ target, savedFeeds, hidden }: FeedCaptionProps) {
  const [caption, setCaption] = useState<{ id: number; text: string } | null>(null);
  const savedFeedsRef = useRef(savedFeeds);
  const counterRef = useRef(0);
  const targetKey = JSON.stringify(target);

  useEffect(() => {
    savedFeedsRef.current = savedFeeds;
  }, [savedFeeds]);

  useEffect(() => {
    counterRef.current += 1;
    const text = captionTextFor(parseFeedTarget(JSON.parse(targetKey)), savedFeedsRef.current);
    setCaption({ id: counterRef.current, text });
    const timer = setTimeout(() => {
      setCaption(null);
    }, FEED_CAPTION_VISIBLE_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [targetKey]);

  if (hidden || caption === null) return <div className="feed-caption-region" aria-live="polite" />;
  return (
    <div className="feed-caption-region" aria-live="polite">
      <p key={caption.id} className="feed-caption">
        {caption.text}
      </p>
    </div>
  );
}
