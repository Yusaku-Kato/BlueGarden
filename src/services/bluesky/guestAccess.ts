import { createPublicEngagementClient } from "./engagementClient";
import { SeenPostCache } from "./SeenPostCache";
import type { GuestAccessHandle } from "./sessionHandle";

/**
 * Access without an account (docs/DESIGN.md §35.5). Global Garden posts come from Jetstream and
 * like / repost counts from the unauthenticated public AppView. Holds no credentials.
 */
export function createGuestAccess(): GuestAccessHandle {
  const seenPosts = new SeenPostCache();
  return {
    authMethod: "guest",
    engagementClient: createPublicEngagementClient(),
    seenPosts,
    logout: () => {
      seenPosts.clear();
      return Promise.resolve();
    },
  };
}
