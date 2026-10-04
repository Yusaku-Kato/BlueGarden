import type { GardenPost } from "../../domain/models";
import type { GardenError } from "./errors";

/** Metadata that accompanies a batch of posts (docs/DESIGN.md §35.3). */
export interface PostBatchMeta {
  /** Normalized activity count. 0 for the first batch of a source instance and for replays. */
  readonly activityCount: number;
}

export interface PostSourceEvents {
  /** Already deduplicated through seenPosts, oldest first. */
  onPosts(posts: readonly GardenPost[], meta: PostBatchMeta): void;
  onError(error: GardenError, nextDelayMs: number): void;
  onRecovered(): void;
  /** The source has already stopped itself. */
  onFatal(error: GardenError): void;
}

/** All methods are idempotent. */
export interface PostSource {
  start(): void;
  stop(): void;
  pause(): void;
  resume(): void;
}
