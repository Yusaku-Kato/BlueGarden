import { Client } from "@atproto/lex";
import { JoseKey } from "@atproto/jwk-jose";
import {
  atprotoLoopbackClientMetadata,
  isAtprotoDid,
  isAtprotoOAuthScope,
  isExpectedSessionError,
  type InternalStateData,
  OAuthClient,
  type RuntimeImplementation,
  type Session,
  type SessionStore,
  type StateStore,
} from "@atproto/oauth-client";
import { BLUESKY, OAUTH } from "../../config/gardenConfig";
import { errorName, logger } from "../../infra/logger";
import {
  listenForOAuthRedirect,
  type LoopbackRedirectUri,
  type OAuthRedirectError,
  type OAuthRedirectListener,
} from "../../infra/oauthRedirect";
import { type SecureStore, tauriSecureStore } from "../../infra/secureStore";
import { isValidDid, isValidHandle } from "../../domain/feedUri";
import { classifyError, GardenError, type GardenErrorKind } from "./errors";
import { SeenPostCache } from "./SeenPostCache";
import {
  type BlueskySessionHandle,
  createSessionHandle,
  isAllowedPdsUrl,
  notifyNotice,
  notifySessionLost,
  type SessionHooks,
} from "./sessionHandle";
import { APP_PASSWORD_SECRET, OAUTH_SECRET, storeErrorCode } from "./sessionPersistence";
import { readProp, readString } from "./untrusted";

/* ---------------------------------------------------------------------------------------------
 * Client metadata (loopback client, docs/DESIGN.md §34, V-13)
 * ------------------------------------------------------------------------------------------- */

/** The redirect URI as declared in the client_id: no port (RFC 8252 section 7.3). */
const DECLARED_REDIRECT_URI = `http://127.0.0.1${OAUTH.CALLBACK_PATH}` as const;

/**
 * `http://localhost?redirect_uri=<declared>&scope=<scope>`. The authorization server derives the
 * client metadata from this string, so it must stay identical across runs (refresh tokens are
 * bound to the client_id). The real, per-run port only appears in the authorization request.
 */
export function createLoopbackClientId(): string {
  return `http://localhost?redirect_uri=${encodeURIComponent(DECLARED_REDIRECT_URI)}&scope=${encodeURIComponent(OAUTH.SCOPE)}`;
}

/**
 * Metadata for one OAuthClient. @atproto/oauth-client rejects an authorize() redirect_uri that is not
 * in `redirect_uris` ("Invalid redirect_uri"), so the actual port URI is listed here while the
 * client_id keeps the port-less declaration.
 */
export function buildClientMetadata(redirectUri: LoopbackRedirectUri): ReturnType<typeof atprotoLoopbackClientMetadata> {
  return { ...atprotoLoopbackClientMetadata(createLoopbackClientId()), redirect_uris: [redirectUri] };
}

/* ---------------------------------------------------------------------------------------------
 * Runtime (WebCrypto + jose; keys are extractable so the DPoP JWK can be stored)
 * ------------------------------------------------------------------------------------------- */

const DIGEST_NAMES = { sha256: "SHA-256", sha384: "SHA-384", sha512: "SHA-512" } as const;

export function createRuntimeImplementation(): RuntimeImplementation {
  return {
    // JoseKey.generate() creates extractable key pairs.
    createKey: (algs) => JoseKey.generate(algs),
    getRandomValues: (length) => crypto.getRandomValues(new Uint8Array(length)),
    digest: async (data, alg) => new Uint8Array(await crypto.subtle.digest(DIGEST_NAMES[alg.name], data)),
  };
}

/* ---------------------------------------------------------------------------------------------
 * Stores
 * ------------------------------------------------------------------------------------------- */

const STATE_STORE_LIMIT = 8;

/** Pending authorizations: in memory, bounded (oldest dropped), cleared when the attempt ends. */
export function createMemoryStateStore(limit: number = STATE_STORE_LIMIT): StateStore & { clear(): void } {
  const entries = new Map<string, InternalStateData>();
  return {
    get: (key) => entries.get(key),
    set: (key, value) => {
      entries.delete(key);
      entries.set(key, value);
      while (entries.size > limit) {
        const oldest = entries.keys().next();
        if (oldest.done === true) break;
        entries.delete(oldest.value);
      }
    },
    del: (key) => {
      entries.delete(key);
    },
    clear: () => {
      entries.clear();
    },
  };
}

const STORED_VERSION = 1;

/** JSON for the OAuth session including the DPoP private JWK. Null when the key is not exportable. */
export function serializeOAuthSession(session: Session): string | null {
  const dpopJwk = session.dpopKey.privateJwk;
  if (dpopJwk === undefined) return null;
  return JSON.stringify({
    v: STORED_VERSION,
    dpopJwk,
    authMethod: session.authMethod,
    tokenSet: session.tokenSet,
  });
}

function parseAuthMethod(value: unknown): Session["authMethod"] | null {
  const method = readString(value, "method");
  if (method === "none") return { method };
  const kid = readString(value, "kid");
  if (method === "private_key_jwt" && kid !== undefined) return { method, kid };
  return null;
}

function parseTokenSet(value: unknown): Session["tokenSet"] | null {
  const iss = readString(value, "iss");
  const sub = readString(value, "sub");
  const aud = readString(value, "aud");
  const scope = readString(value, "scope");
  const accessToken = readString(value, "access_token");
  if (iss === undefined || aud === undefined || accessToken === undefined) return null;
  if (sub === undefined || !isAtprotoDid(sub)) return null;
  if (scope === undefined || !isAtprotoOAuthScope(scope)) return null;
  if (readString(value, "token_type") !== "DPoP") return null;
  const refreshToken = readString(value, "refresh_token");
  const expiresAt = readString(value, "expires_at");
  return {
    iss,
    sub,
    aud,
    scope,
    access_token: accessToken,
    token_type: "DPoP",
    ...(refreshToken === undefined ? {} : { refresh_token: refreshToken }),
    ...(expiresAt === undefined ? {} : { expires_at: expiresAt }),
  };
}

/** Parses untrusted stored text. Returns null for anything malformed. */
export async function parseOAuthSession(raw: string): Promise<Session | null> {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return null;
  }
  const authMethod = parseAuthMethod(readProp(json, "authMethod"));
  const tokenSet = parseTokenSet(readProp(json, "tokenSet"));
  const dpopJwk = readProp(json, "dpopJwk");
  if (authMethod === null || tokenSet === null || typeof dpopJwk !== "object" || dpopJwk === null) return null;
  try {
    const entries: Record<string, unknown> = Object.fromEntries(Object.entries(dpopJwk));
    const dpopKey = await JoseKey.fromJWK(entries);
    return { dpopKey, authMethod, tokenSet };
  } catch (error) {
    logger.warn("oauth.storedKeyInvalid", { error: errorName(error) });
    return null;
  }
}

/**
 * Session store: memory plus, when `persistent`, the OS secret store slot "session.oauth".
 * Secret store failures never fail the login: the session simply stays unremembered.
 * `del` only forgets the in-memory copy; the stored secret is removed by `forget()`, because
 * @atproto/oauth-client also deletes sessions after transient errors (TypeError) and those must not
 * wipe a remembered login.
 */
export class OAuthSessionStore implements SessionStore {
  private readonly sessions = new Map<string, Session>();
  private readonly store: SecureStore | null;
  private writes: Promise<void> = Promise.resolve();
  private persistFailed = false;
  private readonly onPersistFailed: () => void;

  constructor(store: SecureStore | null, onPersistFailed: () => void = () => undefined) {
    this.store = store;
    this.onPersistFailed = onPersistFailed;
  }

  /** True when remembering was requested and every write succeeded so far. */
  get remembered(): boolean {
    return this.store !== null && !this.persistFailed;
  }

  /** Primes the memory copy (used by restore, where the entry was just read). */
  prime(sub: string, session: Session): void {
    this.sessions.set(sub, session);
  }

  get(key: string): Session | undefined {
    return this.sessions.get(key);
  }

  set(key: string, value: Session): Promise<void> {
    this.sessions.set(key, value);
    return this.enqueue(async (store) => {
      const text = serializeOAuthSession(value);
      if (text === null) throw new Error("dpop key not exportable");
      await store.set(OAUTH_SECRET, text);
    });
  }

  del(key: string): void {
    this.sessions.delete(key);
  }

  /** Deletes the stored secret. Never rejects. */
  forget(): Promise<void> {
    this.sessions.clear();
    return this.enqueue(async (store) => {
      await store.delete(OAUTH_SECRET);
    }, false);
  }

  private enqueue(operation: (store: SecureStore) => Promise<void>, countFailure = true): Promise<void> {
    const store = this.store;
    if (store === null) return Promise.resolve();
    const run = async (): Promise<void> => {
      try {
        await operation(store);
      } catch (error) {
        logger.warn("secureStore.oauthWriteFailed", { reason: storeErrorCode(error) });
        if (countFailure && !this.persistFailed) {
          this.persistFailed = true;
          this.onPersistFailed();
        }
      }
    };
    this.writes = this.writes.then(run);
    return this.writes;
  }
}

/* ---------------------------------------------------------------------------------------------
 * Client seam (so the flow is testable without network)
 * ------------------------------------------------------------------------------------------- */

export interface OAuthSessionLike {
  readonly did: `did:${string}:${string}`;
  fetchHandler(pathname: string, init?: RequestInit): Promise<Response>;
  getTokenInfo(refresh?: boolean | "auto"): Promise<{ readonly aud: string }>;
  signOut(): Promise<void>;
}

export interface OAuthClientLike {
  authorize(input: string, options: { signal?: AbortSignal; redirect_uri: LoopbackRedirectUri }): Promise<URL>;
  callback(params: URLSearchParams, options: { redirect_uri: LoopbackRedirectUri }): Promise<{ session: OAuthSessionLike }>;
  restore(sub: string): Promise<OAuthSessionLike>;
  readonly identityResolver: { resolve(identifier: string): Promise<{ readonly handle: string }> };
}

export interface OAuthClientParams {
  readonly redirectUri: LoopbackRedirectUri;
  readonly stateStore: StateStore;
  readonly sessionStore: SessionStore;
  readonly onSessionDeleted: (sub: string, cause: unknown) => void;
}

export type OAuthClientFactory = (params: OAuthClientParams) => OAuthClientLike;

export const createOAuthClient: OAuthClientFactory = (params) =>
  new OAuthClient({
    responseMode: "query",
    clientMetadata: buildClientMetadata(params.redirectUri),
    handleResolver: BLUESKY.PUBLIC_APPVIEW_URL,
    runtimeImplementation: createRuntimeImplementation(),
    stateStore: params.stateStore,
    sessionStore: params.sessionStore,
    onSessionDeleted: params.onSessionDeleted,
  });

/* ---------------------------------------------------------------------------------------------
 * Errors
 * ------------------------------------------------------------------------------------------- */

function mapRedirectError(error: OAuthRedirectError): GardenError {
  switch (error.code) {
    case "busy":
    case "cancelled":
    case "timeout":
      return new GardenError("authCancelled");
    case "failed":
      return new GardenError("unknown");
  }
}

function isRedirectError(error: unknown): error is OAuthRedirectError {
  return readString(error, "name") === "OAuthRedirectError";
}

const CAUSE_DEPTH_LIMIT = 5;
const IDENTITY_FAILURE_PREFIX = "Failed to resolve identity";
const METADATA_FAILURE_PREFIX = "Failed to resolve OAuth";

function isNetworkFailure(error: unknown): boolean {
  return error instanceof TypeError || readString(error, "name") === "XrpcFetchError";
}

/**
 * Library resolution failures. OAuthResolverError carries no `name`, so it is recognised through the
 * cause chain and the message prefix (the message is only inspected, never copied: it contains the input).
 */
function classifyResolutionError(error: unknown, name: string | undefined): GardenErrorKind | null {
  let current: unknown = error;
  let identityFailure = name === "HandleResolverError" || name === "IdentityResolverError";
  let metadataFailure = false;
  for (let depth = 0; depth < CAUSE_DEPTH_LIMIT && current !== undefined && current !== null; depth += 1) {
    if (isNetworkFailure(current)) return "network";
    const currentName = readString(current, "name");
    if (currentName === "HandleResolverError" || currentName === "IdentityResolverError") identityFailure = true;
    const message = readString(current, "message");
    if (message?.startsWith(IDENTITY_FAILURE_PREFIX) === true) identityFailure = true;
    if (message?.startsWith(METADATA_FAILURE_PREFIX) === true) metadataFailure = true;
    current = readProp(current, "cause");
  }
  if (identityFailure) return "invalidHandle";
  // Authorization server / protected resource metadata could not be fetched or is unusable.
  if (metadataFailure) return "network";
  return name === "OAuthResolverError" ? "invalidHandle" : null;
}

/** Maps anything thrown during the OAuth flow. Never inspects or logs query parameters. */
export function classifyOAuthError(error: unknown, signal: AbortSignal | undefined): GardenError {
  if (error instanceof GardenError) return error;
  if (isRedirectError(error)) return mapRedirectError(error);
  if (signal?.aborted === true) return new GardenError("authCancelled");
  const name = readString(error, "name");
  if (name === "OAuthCallbackError") {
    const params = readProp(error, "params");
    const denied = params instanceof URLSearchParams && params.get("error") === "access_denied";
    return new GardenError(denied ? "authCancelled" : "unknown");
  }
  const resolution = classifyResolutionError(error, name);
  if (resolution !== null) return new GardenError(resolution);
  return classifyError(error, "login");
}

/* ---------------------------------------------------------------------------------------------
 * Login / restore
 * ------------------------------------------------------------------------------------------- */

export interface OAuthLoginOptions {
  /** Store the OAuth session (including the DPoP key) in the OS secret store. Default false. */
  readonly remember?: boolean;
  readonly signal?: AbortSignal;
  /** Test seams. */
  readonly secureStore?: SecureStore;
  readonly clientFactory?: OAuthClientFactory;
  readonly listen?: (signal: AbortSignal) => Promise<OAuthRedirectListener>;
}

interface OAuthSessionState {
  active: boolean;
  loggingOut: boolean;
  destroyed: boolean;
  /** Set after a transient (network) deletion: a later logout must not forget the stored login. */
  keepRemembered: boolean;
}

function isTransientDeletion(cause: unknown): boolean {
  return cause instanceof TypeError;
}

async function resolveHandle(client: OAuthClientLike, sub: string, fallback: string): Promise<string> {
  try {
    const info = await client.identityResolver.resolve(sub);
    if (info.handle !== "" && info.handle !== "handle.invalid") return info.handle;
  } catch (error) {
    logger.debug("oauth.handleResolveFailed", { error: errorName(error) });
  }
  return fallback;
}

function buildOAuthHandle(init: {
  client: OAuthClientLike;
  session: OAuthSessionLike;
  handle: string;
  seenPosts: SeenPostCache;
  state: OAuthSessionState;
  sessionStore: OAuthSessionStore;
  remembered: boolean;
}): BlueskySessionHandle {
  const { session, state } = init;
  return createSessionHandle({
    authMethod: "oauth",
    handle: init.handle,
    did: session.did,
    client: new Client(session),
    liveness: {
      get destroyed() {
        return state.destroyed;
      },
    },
    seenPosts: init.seenPosts,
    remembered: init.remembered,
    performLogout: async () => {
      state.loggingOut = true;
      if (state.keepRemembered) {
        // Transient deletion: drop the session locally, keep the remembered login for the next start.
        init.sessionStore.del(session.did);
        return;
      }
      try {
        await session.signOut();
      } catch (error) {
        logger.warn("session.logoutFailed", { error: errorName(error) });
      }
      await init.sessionStore.forget();
    },
  });
}

function createSessionDeletedHandler(
  state: OAuthSessionState,
  sessionStore: OAuthSessionStore,
  seenPosts: SeenPostCache,
  hooks: SessionHooks,
): (sub: string, cause: unknown) => void {
  return (_sub, cause) => {
    if (!state.active) return; // e.g. the library revoking a previous session while logging in
    state.destroyed = true;
    if (isTransientDeletion(cause)) state.keepRemembered = true;
    else void sessionStore.forget();
    if (state.loggingOut) return;
    seenPosts.clear();
    notifySessionLost(hooks);
  };
}

/** The user cancelled after the redirect: sign the freshly created session out (best effort) and stop. */
async function abortIfCancelled(
  signal: AbortSignal,
  session: OAuthSessionLike,
  state: OAuthSessionState,
  sessionStore: OAuthSessionStore,
): Promise<void> {
  if (!signal.aborted) return;
  state.loggingOut = true;
  await session.signOut().catch((error: unknown) => {
    logger.warn("session.logoutFailed", { error: errorName(error) });
  });
  await sessionStore.forget();
  throw new GardenError("authCancelled");
}

/**
 * A syntactically valid handle or DID is authorized directly. Anything else (empty, an email address,
 * free text) falls back to the entryway URL, where the user types their email and password in the
 * browser. @atproto/oauth-client accepts an https URL as input (OAuthResolver.resolve).
 */
export function chooseAuthorizeInput(identifier: string): string {
  const normalized = identifier.trim().replace(/^@/, "");
  if (isValidDid(normalized) || isValidHandle(normalized)) return normalized;
  return BLUESKY.SERVICE_URL;
}

/**
 * Signs in with OAuth through the system browser (docs/DESIGN.md §36.4). One attempt at a time;
 * `options.signal` cancels (authCancelled). Throws GardenError only. Codes, state and URLs are
 * never logged.
 */
export async function loginWithOAuth(
  identifier: string,
  hooks: SessionHooks,
  options: OAuthLoginOptions = {},
): Promise<BlueskySessionHandle> {
  const authorizeInput = chooseAuthorizeInput(identifier);

  const signal = options.signal ?? new AbortController().signal;
  const listen = options.listen ?? ((s: AbortSignal) => listenForOAuthRedirect(s));
  const createClient = options.clientFactory ?? createOAuthClient;
  const secureStore = options.remember === true ? (options.secureStore ?? tauriSecureStore) : null;

  const seenPosts = new SeenPostCache();
  const state: OAuthSessionState = { active: false, loggingOut: false, destroyed: false, keepRemembered: false };
  let persistNoticeSent = false;
  const sessionStore = new OAuthSessionStore(secureStore, () => {
    if (persistNoticeSent) return;
    persistNoticeSent = true;
    notifyNotice(hooks, new GardenError("secureStorageUnavailable"));
  });
  const stateStore = createMemoryStateStore();

  let listener: OAuthRedirectListener;
  try {
    listener = await listen(signal);
  } catch (error) {
    throw classifyOAuthError(error, signal);
  }

  let session: OAuthSessionLike;
  let client: OAuthClientLike;
  try {
    client = createClient({
      redirectUri: listener.redirectUri,
      stateStore,
      sessionStore,
      onSessionDeleted: createSessionDeletedHandler(state, sessionStore, seenPosts, hooks),
    });
    const authorizationUrl = await client.authorize(authorizeInput, { signal, redirect_uri: listener.redirectUri });
    const params = await listener.waitForRedirect(authorizationUrl.href);
    ({ session } = await client.callback(params, { redirect_uri: listener.redirectUri }));
  } catch (error) {
    throw classifyOAuthError(error, signal);
  } finally {
    stateStore.clear();
    await listener.close();
  }
  await abortIfCancelled(signal, session, state, sessionStore);

  // Same PDS allowlist as the App Password login (CSP connect-src).
  let pdsUrl = "";
  try {
    pdsUrl = (await session.getTokenInfo(false)).aud;
  } catch (error) {
    logger.warn("oauth.tokenInfoFailed", { error: errorName(error) });
  }
  await abortIfCancelled(signal, session, state, sessionStore);
  if (!isAllowedPdsUrl(pdsUrl)) {
    state.loggingOut = true;
    await session.signOut().catch((error: unknown) => {
      logger.warn("session.logoutFailed", { error: errorName(error) });
    });
    await sessionStore.forget();
    throw new GardenError("unsupportedPds");
  }

  const handle = await resolveHandle(client, session.did, session.did);
  await abortIfCancelled(signal, session, state, sessionStore);
  state.active = true;
  const remembered = sessionStore.remembered;
  if (remembered && secureStore !== null) {
    // A single remembered login at a time: drop a previous App Password entry (best effort).
    try {
      await secureStore.delete(APP_PASSWORD_SECRET);
    } catch (error) {
      logger.warn("secureStore.deleteFailed", { reason: storeErrorCode(error) });
    }
  }
  logger.info("login.success", { method: "oauth", remembered });
  return buildOAuthHandle({ client, session, handle, seenPosts, state, sessionStore, remembered });
}

/**
 * Resumes a remembered OAuth session. Returns null when nothing is stored, the entry is malformed
 * (deleted), the session was revoked (deleted) or the network failed (kept for the next start).
 */
export async function restoreOAuthSession(
  hooks: SessionHooks,
  store: SecureStore,
  options: { readonly clientFactory?: OAuthClientFactory } = {},
): Promise<BlueskySessionHandle | null> {
  let raw: string | null;
  try {
    raw = await store.get(OAUTH_SECRET);
  } catch (error) {
    logger.info("session.restoreSkipped", { reason: storeErrorCode(error) });
    return null;
  }
  if (raw === null) return null;

  const stored = await parseOAuthSession(raw);
  const sessionStore = new OAuthSessionStore(store);
  if (stored === null) {
    logger.warn("session.restoreInvalid");
    await sessionStore.forget();
    return null;
  }

  const seenPosts = new SeenPostCache();
  const state: OAuthSessionState = { active: false, loggingOut: false, destroyed: false, keepRemembered: false };
  const createClient = options.clientFactory ?? createOAuthClient;
  const client = createClient({
    redirectUri: DECLARED_REDIRECT_URI,
    stateStore: createMemoryStateStore(),
    sessionStore,
    onSessionDeleted: createSessionDeletedHandler(state, sessionStore, seenPosts, hooks),
  });
  const sub = stored.tokenSet.sub;
  sessionStore.prime(sub, stored);

  let session: OAuthSessionLike;
  try {
    session = await client.restore(sub);
  } catch (error) {
    logger.warn("session.restoreFailed", { error: errorName(error) });
    if (isExpectedSessionError(error) && !isTransientDeletion(error)) await sessionStore.forget();
    return null;
  }

  let pdsUrl = "";
  try {
    pdsUrl = (await session.getTokenInfo(false)).aud;
  } catch (error) {
    logger.warn("oauth.tokenInfoFailed", { error: errorName(error) });
  }
  if (!isAllowedPdsUrl(pdsUrl)) {
    await session.signOut().catch((error: unknown) => {
      logger.warn("session.logoutFailed", { error: errorName(error) });
    });
    await sessionStore.forget();
    return null;
  }

  const handle = await resolveHandle(client, session.did, session.did);
  state.active = true;
  logger.info("session.restored", { method: "oauth" });
  return buildOAuthHandle({ client, session, handle, seenPosts, state, sessionStore, remembered: true });
}
