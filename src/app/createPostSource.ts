import type { FeedTarget } from "../domain/models";
import type { BlueskyFeedClient } from "../services/bluesky/BlueskyFeedClient";
import { GardenError } from "../services/bluesky/errors";
import { FeedPoller } from "../services/bluesky/FeedPoller";
import { JetstreamSource, type JetstreamConnector } from "../services/bluesky/JetstreamSource";
import type { PostSource, PostSourceEvents } from "../services/bluesky/PostSource";
import type { SeenPostCache } from "../services/bluesky/SeenPostCache";

/**
 * What a source needs from the access handle. `feedClient` is absent for guests, who can only use
 * the global target; asking a guest for another target is reported as a target-fatal error.
 */
export interface PostSourceAccess {
  readonly feedClient?: Pick<BlueskyFeedClient, "fetchLatest">;
  readonly seenPosts: SeenPostCache;
}

export interface PostSourceDependencies {
  /** Test seam for the Jetstream connection. */
  readonly jetstreamConnector?: JetstreamConnector;
}

/** Reports a target-fatal error on start (a guest asked for a feed that needs a session). */
class UnavailableSource implements PostSource {
  private readonly events: PostSourceEvents;
  private reported = false;

  constructor(events: PostSourceEvents) {
    this.events = events;
  }

  start(): void {
    if (this.reported) return;
    this.reported = true;
    this.events.onFatal(new GardenError("notImplemented"));
  }

  stop(): void {
    this.reported = true;
  }

  pause(): void {
    // Nothing to pause.
  }

  resume(): void {
    // Nothing to resume.
  }
}

/** Chooses the post source for a feed target (docs/DESIGN.md §35.3, §36.2, §36.3). */
export function createPostSource(
  access: PostSourceAccess,
  target: FeedTarget,
  events: PostSourceEvents,
  dependencies: PostSourceDependencies = {},
): PostSource {
  const { feedClient, seenPosts } = access;
  if (target.kind === "global") {
    return new JetstreamSource({
      seenPosts,
      events,
      ...(dependencies.jetstreamConnector === undefined ? {} : { connect: dependencies.jetstreamConnector }),
    });
  }
  if (feedClient === undefined) return new UnavailableSource(events);
  return new FeedPoller({
    fetch: (signal) => feedClient.fetchLatest(target, signal),
    seenPosts,
    events,
  });
}
