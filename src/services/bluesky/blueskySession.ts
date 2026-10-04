import { Client } from "@atproto/lex";
import {
  extractPdsEndpoint,
  PasswordSession,
  type PasswordSessionOptions,
  type SessionData,
} from "@atproto/lex-password-session";
import { BLUESKY } from "../../config/gardenConfig";
import { errorName, logger } from "../../infra/logger";
import { type SecretKey, type SecureStore, tauriSecureStore } from "../../infra/secureStore";
import { classifyError, GardenError } from "./errors";
import { restoreOAuthSession } from "./oauthSession";
import { SeenPostCache } from "./SeenPostCache";
import {
  type AppPasswordPersistence,
  createAppPasswordPersistence,
  OAUTH_SECRET,
  parseSessionData,
  storeErrorCode,
} from "./sessionPersistence";
import {
  type BlueskySessionHandle,
  createSessionHandle,
  isAllowedPdsUrl,
  notifyNotice,
  notifySessionLost,
  type SessionHooks,
} from "./sessionHandle";

export {
  classifyFeedFailure,
  isAllowedPdsUrl,
  type AuthMethod,
  type BlueskySessionHandle,
  type GardenAccess,
  type GuestAccessHandle,
  type SessionHooks,
  type SessionLostReason,
} from "./sessionHandle";
export { loginWithOAuth } from "./oauthSession";

export interface LoginOptions {
  /** Store refreshable session data (never the password) in the OS secret store. Default false. */
  readonly remember?: boolean;
  /** Test seam. Defaults to the Tauri-backed store. */
  readonly secureStore?: SecureStore;
}

const APP_PASSWORD_PATTERN = /^[a-z0-9]{4}(?:-[a-z0-9]{4}){3}$/i;
const WHITESPACE_PATTERN = /\s/;

/** Trims and removes a leading "@". */
export function normalizeIdentifier(raw: string): string {
  return raw.trim().replace(/^@/, "");
}

/** Client-side format check. Returns null when the identifier may be submitted. */
export function validateIdentifier(identifier: string): GardenError | null {
  const invalid =
    identifier.length === 0 ||
    identifier.length > BLUESKY.MAX_IDENTIFIER_LENGTH ||
    WHITESPACE_PATTERN.test(identifier);
  return invalid ? new GardenError("invalidHandle") : null;
}

/** True when the password has the App Password shape (xxxx-xxxx-xxxx-xxxx). Advisory only. */
export function looksLikeAppPassword(password: string): boolean {
  return APP_PASSWORD_PATTERN.test(password);
}

async function bestEffortLogout(session: PasswordSession): Promise<void> {
  try {
    await session.logout();
  } catch (error) {
    logger.warn("session.logoutFailed", { error: errorName(error) });
  }
}

async function bestEffortDelete(store: SecureStore, key: SecretKey): Promise<void> {
  try {
    await store.delete(key);
  } catch (error) {
    logger.warn("secureStore.deleteFailed", { reason: storeErrorCode(error) });
  }
}

/** Mutable flags shared between the SDK hooks and the handle. */
interface PasswordSessionState {
  loggingOut: boolean;
  /** True once session data may be written to the secret store. */
  persisting: boolean;
}

function createPasswordSessionOptions(
  hooks: SessionHooks,
  seenPosts: SeenPostCache,
  state: PasswordSessionState,
  persistence: AppPasswordPersistence | null,
): PasswordSessionOptions {
  return {
    // Must not throw. Writes only after the PDS allowlist check passed (state.persisting).
    onUpdated: async (data) => {
      if (!state.persisting || persistence === null) return;
      try {
        await persistence.save(data);
      } catch (error) {
        state.persisting = false;
        logger.warn("secureStore.saveFailed", { reason: storeErrorCode(error) });
        notifyNotice(hooks, new GardenError("secureStorageUnavailable"));
      }
    },
    onDeleted: async () => {
      if (state.persisting && persistence !== null) {
        try {
          await persistence.clear();
        } catch (error) {
          logger.warn("secureStore.deleteFailed", { reason: storeErrorCode(error) });
        }
      }
      if (state.loggingOut) return;
      seenPosts.clear();
      notifySessionLost(hooks);
    },
    onUpdateFailure: (_data, error) => {
      logger.warn("session.refreshFailed", { error: errorName(error) });
    },
    onDeleteFailure: (_data, error) => {
      logger.warn("session.logoutFailed", { error: errorName(error) });
    },
  };
}

function buildPasswordHandle(
  session: PasswordSession,
  seenPosts: SeenPostCache,
  state: PasswordSessionState,
  persistence: AppPasswordPersistence | null,
  remembered: boolean,
): BlueskySessionHandle {
  return createSessionHandle({
    authMethod: "appPassword",
    handle: session.handle,
    did: session.did,
    client: new Client(session),
    liveness: session,
    seenPosts,
    remembered,
    performLogout: async () => {
      state.loggingOut = true;
      await bestEffortLogout(session);
      if (persistence !== null && state.persisting) {
        try {
          await persistence.clear();
        } catch (error) {
          logger.warn("secureStore.deleteFailed", { reason: storeErrorCode(error) });
        }
      }
    },
  });
}

/**
 * Signs in with an App Password. The password is only passed through to the SDK call and is
 * kept nowhere. With `remember`, the refreshable session data (not the password) is written to the
 * OS secret store; if that is unavailable the login continues unremembered and `hooks.onNotice`
 * receives `secureStorageUnavailable`. Throws GardenError only.
 */
export async function login(
  identifier: string,
  password: string,
  hooks: SessionHooks,
  options: LoginOptions = {},
): Promise<BlueskySessionHandle> {
  const normalizedIdentifier = normalizeIdentifier(identifier);
  const invalid = validateIdentifier(normalizedIdentifier);
  if (invalid !== null) throw invalid;

  const store = options.secureStore ?? tauriSecureStore;
  const persistence = options.remember === true ? createAppPasswordPersistence(store) : null;
  const seenPosts = new SeenPostCache();
  const state: PasswordSessionState = { loggingOut: false, persisting: false };

  let session: PasswordSession;
  try {
    session = await PasswordSession.login({
      service: BLUESKY.SERVICE_URL,
      identifier: normalizedIdentifier,
      password,
      ...createPasswordSessionOptions(hooks, seenPosts, state, persistence),
    });
  } catch (error) {
    throw classifyError(error, "login");
  }

  const pdsUrl = extractPdsEndpoint(session.session.didDoc) ?? BLUESKY.SERVICE_URL;
  if (!isAllowedPdsUrl(pdsUrl)) {
    state.loggingOut = true;
    await bestEffortLogout(session);
    throw new GardenError("unsupportedPds");
  }

  let remembered = false;
  if (persistence !== null) {
    try {
      await persistence.save(session.session);
      state.persisting = true;
      remembered = true;
      await bestEffortDelete(store, OAUTH_SECRET); // a single remembered login at a time
    } catch (error) {
      logger.warn("secureStore.saveFailed", { reason: storeErrorCode(error) });
      notifyNotice(hooks, new GardenError("secureStorageUnavailable"));
    }
  }

  logger.info("login.success", { remembered });
  logger.debug("login.success", { handle: session.handle });
  return buildPasswordHandle(session, seenPosts, state, persistence, remembered);
}

async function restorePasswordSession(
  raw: string,
  hooks: SessionHooks,
  store: SecureStore,
): Promise<BlueskySessionHandle | null> {
  const persistence = createAppPasswordPersistence(store);
  const data: SessionData | null = parseSessionData(raw);
  if (data === null || !isAllowedPdsUrl(data.service)) {
    logger.warn("session.restoreInvalid");
    await persistence.clear().catch((error: unknown) => {
      logger.warn("secureStore.deleteFailed", { reason: storeErrorCode(error) });
    });
    return null;
  }

  const seenPosts = new SeenPostCache();
  const state: PasswordSessionState = { loggingOut: false, persisting: true };
  let session: PasswordSession;
  try {
    // Throws only when the session is definitely no longer valid; network errors resolve.
    session = await PasswordSession.resume(data, createPasswordSessionOptions(hooks, seenPosts, state, persistence));
  } catch (error) {
    logger.warn("session.restoreFailed", { error: errorName(error) });
    state.persisting = false;
    await persistence.clear().catch((clearError: unknown) => {
      logger.warn("secureStore.deleteFailed", { reason: storeErrorCode(clearError) });
    });
    return null;
  }

  const pdsUrl = extractPdsEndpoint(session.session.didDoc) ?? data.service;
  if (!isAllowedPdsUrl(pdsUrl)) {
    state.loggingOut = true;
    await bestEffortLogout(session);
    await persistence.clear().catch((error: unknown) => {
      logger.warn("secureStore.deleteFailed", { reason: storeErrorCode(error) });
    });
    return null;
  }

  logger.info("session.restored", { method: "appPassword" });
  return buildPasswordHandle(session, seenPosts, state, persistence, true);
}

/**
 * Resumes a remembered login (App Password session, else OAuth session) from the OS secret store.
 * Returns null when nothing usable is stored or the store is unavailable (never an error: the
 * caller shows the login screen). Entries that are definitively invalid are deleted.
 */
export async function restoreSession(
  hooks: SessionHooks,
  options: { readonly secureStore?: SecureStore } = {},
): Promise<BlueskySessionHandle | null> {
  const store = options.secureStore ?? tauriSecureStore;
  let raw: string | null;
  try {
    raw = await store.get("session.appPassword");
  } catch (error) {
    logger.info("session.restoreSkipped", { reason: storeErrorCode(error) });
    return null;
  }
  if (raw !== null) {
    const restored = await restorePasswordSession(raw, hooks, store);
    if (restored !== null) return restored;
  }
  return restoreOAuthSession(hooks, store);
}
