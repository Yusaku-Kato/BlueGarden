import { Client, l } from "@atproto/lex";
import { app, com } from "@bsky/sdk/lexicons";
import { BLUESKY } from "../../config/gardenConfig";
import { errorName, logger } from "../../infra/logger";
import { BlueskyFeedClient, type FeedXrpc } from "./BlueskyFeedClient";
import { createLexEngagementClient, type EngagementClient } from "./engagementClient";
import { classifyError, GardenError } from "./errors";
import type { FeedDirectoryXrpc } from "./feedDiscovery";
import type { SeenPostCache } from "./SeenPostCache";

export type SessionLostReason = "expired" | "revoked";

export interface SessionHooks {
  onSessionLost(reason: SessionLostReason): void;
  /** Non-fatal information, e.g. `secureStorageUnavailable` when "remember" could not be honored. */
  onNotice?(error: GardenError): void;
}

export type AuthMethod = "appPassword" | "oauth";

export interface BlueskySessionHandle {
  readonly authMethod: AuthMethod;
  readonly handle: string;
  readonly did: string;
  readonly feedClient: BlueskyFeedClient;
  /** Saved-feed lookup, feed names and handle resolution (docs/DESIGN.md section 36.2). */
  readonly feedDirectory: FeedDirectoryXrpc;
  /** Like / repost re-fetch after growth (docs/DESIGN.md section 35.6). */
  readonly engagementClient: EngagementClient;
  /** Session-scoped deduplication cache (docs/DESIGN.md section 10). Cleared on logout / session loss. */
  readonly seenPosts: SeenPostCache;
  /** True when session data was stored in the OS secret store and will survive a restart. */
  readonly remembered: boolean;
  /** Idempotent. Never rejects. Also deletes stored secrets. */
  logout(): Promise<void>;
}

/** Access without an account: the Global Garden over the public AppView (docs/DESIGN.md section 35.5). */
export interface GuestAccessHandle {
  readonly authMethod: "guest";
  readonly engagementClient: EngagementClient;
  readonly seenPosts: SeenPostCache;
  /** Idempotent. Never rejects. */
  logout(): Promise<void>;
}

export type GardenAccess = BlueskySessionHandle | GuestAccessHandle;

const WILDCARD_PREFIX = "*.";

function hostMatches(hostname: string, pattern: string): boolean {
  if (pattern.startsWith(WILDCARD_PREFIX)) {
    const suffix = pattern.slice(1); // ".bsky.network"
    return hostname.length > suffix.length && hostname.endsWith(suffix);
  }
  return hostname === pattern;
}

/** True when `url` is an https origin on the allowed PDS host list (matches the CSP connect-src). */
export function isAllowedPdsUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch (error) {
    logger.debug("pds.urlInvalid", { error: errorName(error) });
    return false;
  }
  if (parsed.protocol !== "https:" || parsed.port !== "" || parsed.username !== "") return false;
  const hostname = parsed.hostname.toLowerCase();
  return BLUESKY.ALLOWED_PDS_HOST_PATTERNS.some((pattern) => hostMatches(hostname, pattern));
}

export interface SessionLiveness {
  readonly destroyed: boolean;
}

/**
 * The SDK refreshes expired tokens itself. When that refresh fails transiently (onUpdateFailure),
 * it returns the original 401 / ExpiredToken response while the session stays alive. Only a
 * destroyed session (onDeleted) is a definitive loss; anything else must back off and retry.
 */
export function classifyFeedFailure(failure: unknown, session: SessionLiveness): GardenError {
  const classified = classifyError(failure, "feed");
  if (classified.kind === "sessionExpired" && !session.destroyed) {
    logger.warn("session.authRetry");
    return new GardenError("serverError");
  }
  return classified;
}

// validateResponse is off in the transports below: one bad item must not fail the whole page.
// The normalizers and readers validate what they use.
/** exactOptionalPropertyTypes: pass `signal` only when present. */
function withSignal(signal: AbortSignal | undefined): { signal?: AbortSignal } {
  return signal === undefined ? {} : { signal };
}

function createFeedXrpc(client: Client, session: SessionLiveness): FeedXrpc {
  return {
    async getTimeline(params, signal) {
      const result = await client.xrpcSafe(app.bsky.feed.getTimeline, { params, signal, validateResponse: false });
      if (!result.success) throw classifyFeedFailure(result, session);
      return result.body;
    },
    async getFeed(params, signal) {
      const feed = params.feed;
      if (!l.isAtUriString(feed)) throw new GardenError("invalidFeedTarget");
      const result = await client.xrpcSafe(app.bsky.feed.getFeed, {
        params: { feed, limit: params.limit },
        signal,
        validateResponse: false,
      });
      if (!result.success) throw classifyFeedFailure(result, session);
      return result.body;
    },
    async searchPosts(params, signal) {
      const result = await client.xrpcSafe(app.bsky.feed.searchPosts, { params, signal, validateResponse: false });
      if (!result.success) throw classifyFeedFailure(result, session);
      return result.body;
    },
  };
}

function createFeedDirectoryXrpc(client: Client, session: SessionLiveness): FeedDirectoryXrpc {
  return {
    async getPreferences(signal) {
      const result = await client.xrpcSafe(app.bsky.actor.getPreferences, {
        ...withSignal(signal),
        validateResponse: false,
      });
      if (!result.success) throw classifyFeedFailure(result, session);
      return result.body;
    },
    async getFeedGenerators(uris, signal) {
      const feeds = uris.filter((uri) => l.isAtUriString(uri));
      const result = await client.xrpcSafe(app.bsky.feed.getFeedGenerators, {
        params: { feeds },
        ...withSignal(signal),
        validateResponse: false,
      });
      if (!result.success) throw classifyFeedFailure(result, session);
      return result.body;
    },
    async getFeedGenerator(uri, signal) {
      if (!l.isAtUriString(uri)) throw new GardenError("invalidFeedTarget");
      const result = await client.xrpcSafe(app.bsky.feed.getFeedGenerator, {
        params: { feed: uri },
        ...withSignal(signal),
        validateResponse: false,
      });
      if (!result.success) throw classifyFeedFailure(result, session);
      return result.body;
    },
    async resolveHandle(handle, signal) {
      if (!l.isHandleString(handle)) throw new GardenError("invalidFeedTarget");
      const result = await client.xrpcSafe(com.atproto.identity.resolveHandle, {
        params: { handle },
        ...withSignal(signal),
        validateResponse: false,
      });
      if (!result.success) throw classifyFeedFailure(result, session);
      return result.body;
    },
  };
}

export function notifySessionLost(hooks: SessionHooks): void {
  try {
    hooks.onSessionLost("expired");
  } catch (error) {
    logger.error("unexpected", { where: "onSessionLost", error: errorName(error) });
  }
}

export function notifyNotice(hooks: SessionHooks, error: GardenError): void {
  try {
    hooks.onNotice?.(error);
  } catch (caught) {
    logger.error("unexpected", { where: "onNotice", error: errorName(caught) });
  }
}

export interface SessionHandleInit {
  readonly authMethod: AuthMethod;
  readonly handle: string;
  readonly did: string;
  readonly client: Client;
  readonly liveness: SessionLiveness;
  readonly seenPosts: SeenPostCache;
  readonly remembered: boolean;
  /** Ends the session on the server and deletes stored secrets. Called at most once. */
  readonly performLogout: () => Promise<void>;
}

/** Builds the app-facing handle shared by App Password and OAuth sessions. */
export function createSessionHandle(init: SessionHandleInit): BlueskySessionHandle {
  let logoutPromise: Promise<void> | null = null;
  return {
    authMethod: init.authMethod,
    handle: init.handle,
    did: init.did,
    feedClient: new BlueskyFeedClient(createFeedXrpc(init.client, init.liveness)),
    feedDirectory: createFeedDirectoryXrpc(init.client, init.liveness),
    engagementClient: createLexEngagementClient(init.client),
    seenPosts: init.seenPosts,
    remembered: init.remembered,
    logout: () => {
      logoutPromise ??= (async () => {
        init.seenPosts.clear();
        try {
          await init.performLogout();
        } catch (error) {
          logger.warn("session.logoutFailed", { error: errorName(error) });
        }
        logger.info("logout");
      })();
      return logoutPromise;
    },
  };
}
