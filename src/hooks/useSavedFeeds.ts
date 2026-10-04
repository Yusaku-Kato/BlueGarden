import { useEffect, useState } from "react";
import { listSavedFeeds, type SavedFeedInfo } from "../services/bluesky/feedDiscovery";
import type { BlueskySessionHandle } from "../services/bluesky/blueskySession";

export interface SavedFeedsState {
  readonly savedFeeds: readonly SavedFeedInfo[];
  readonly loading: boolean;
}

const NO_FEEDS: readonly SavedFeedInfo[] = [];

/**
 * Loads the user's saved/pinned feeds (at most 50) each time `active` becomes true.
 * The request is aborted when the panel closes, the session changes or the component unmounts.
 */
export function useSavedFeeds(session: BlueskySessionHandle | null, active: boolean): SavedFeedsState {
  const [feeds, setFeeds] = useState<readonly SavedFeedInfo[]>(NO_FEEDS);
  const [settled, setSettled] = useState(false);

  useEffect(() => {
    if (session === null || !active) return;
    const controller = new AbortController();
    void listSavedFeeds(session.feedDirectory, controller.signal).then((result) => {
      if (controller.signal.aborted) return;
      setFeeds(result);
      setSettled(true);
    });
    return () => {
      controller.abort();
      setSettled(false);
    };
  }, [session, active]);

  const enabled = session !== null && active;
  return { savedFeeds: session === null ? NO_FEEDS : feeds, loading: enabled && !settled };
}
