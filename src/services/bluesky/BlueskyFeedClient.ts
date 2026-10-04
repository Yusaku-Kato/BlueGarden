import { FEED, POLLING } from "../../config/gardenConfig";
import { isFeedGeneratorUri } from "../../domain/feedUri";
import type { FeedTarget, GardenPost } from "../../domain/models";
import { normalizeQuery } from "../../domain/settings";
import { classifyError, GardenError } from "./errors";
import { normalizeFeed, normalizePostViews } from "./normalizeFeed";

/**
 * Minimal transport the feed client needs. Each method resolves with the raw response body
 * (untrusted) and rejects with whatever the SDK throws. Injected so tests do not need the real SDK.
 */
export interface FeedXrpc {
  getTimeline(params: { readonly limit: number }, signal: AbortSignal): Promise<unknown>;
  getFeed(params: { readonly feed: string; readonly limit: number }, signal: AbortSignal): Promise<unknown>;
  searchPosts(
    params: { readonly q: string; readonly sort: "latest"; readonly limit: number },
    signal: AbortSignal,
  ): Promise<unknown>;
}

export class BlueskyFeedClient {
  private readonly xrpc: FeedXrpc;

  constructor(xrpc: FeedXrpc) {
    this.xrpc = xrpc;
  }

  /** Latest page of the target feed as normalized posts, newest first. Throws GardenError only. */
  async fetchLatest(target: FeedTarget, signal: AbortSignal): Promise<GardenPost[]> {
    switch (target.kind) {
      case "timeline":
        return normalizeFeed(await this.call(() => this.xrpc.getTimeline({ limit: POLLING.TIMELINE_FETCH_LIMIT }, signal)));
      case "custom":
        if (!isFeedGeneratorUri(target.feedUri)) throw new GardenError("invalidFeedTarget");
        return normalizeFeed(
          await this.call(() =>
            this.xrpc.getFeed({ feed: target.feedUri, limit: FEED.CUSTOM_FETCH_LIMIT }, signal),
          ),
        );
      case "keyword":
        if (normalizeQuery(target.query) !== target.query) throw new GardenError("invalidFeedTarget");
        return normalizePostViews(
          await this.call(() =>
            this.xrpc.searchPosts({ q: target.query, sort: "latest", limit: FEED.SEARCH_FETCH_LIMIT }, signal),
          ),
        );
      case "global":
        // Global Garden is served by a Jetstream source, not by polling.
        throw new GardenError("notImplemented");
    }
  }

  private async call(request: () => Promise<unknown>): Promise<unknown> {
    try {
      return await request();
    } catch (error) {
      throw classifyError(error, "feed");
    }
  }
}
