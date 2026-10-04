import { OAuthClient, parseAtprotoLoopbackClientId, type Session, TokenRevokedError } from "@atproto/oauth-client";
import { beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import { OAUTH } from "../../config/gardenConfig";
import { OAuthRedirectError, type OAuthRedirectListener } from "../../infra/oauthRedirect";
import { createMemorySecureStore, type SecureStore, SecureStoreError } from "../../infra/secureStore";
import type { GardenError } from "./errors";
import {
  buildClientMetadata,
  classifyOAuthError,
  createLoopbackClientId,
  createMemoryStateStore,
  createOAuthClient,
  createRuntimeImplementation,
  loginWithOAuth,
  type OAuthClientFactory,
  type OAuthClientLike,
  type OAuthClientParams,
  OAuthSessionStore,
  type OAuthSessionLike,
  parseOAuthSession,
  restoreOAuthSession,
  serializeOAuthSession,
} from "./oauthSession";

const DID = "did:plc:abcdefghijklmnopqrstuvwx";
const REDIRECT_URI = "http://127.0.0.1:49152/callback";

async function makeSession(accessToken = "synthetic-access"): Promise<Session> {
  const dpopKey = await createRuntimeImplementation().createKey(["ES256"]);
  return {
    dpopKey,
    authMethod: { method: "none" },
    tokenSet: {
      iss: "https://bsky.social",
      sub: DID,
      aud: "https://morel.us-east.host.bsky.network",
      scope: "atproto transition:generic",
      access_token: accessToken,
      refresh_token: "synthetic-refresh",
      token_type: "DPoP",
      expires_at: "2026-01-01T00:30:00.000Z",
    },
  };
}

describe("client metadata (V-13)", () => {
  it("declares the loopback client_id without a port and parses back to the configured scope", () => {
    const clientId = createLoopbackClientId();
    expect(clientId.startsWith("http://localhost?redirect_uri=")).toBe(true);
    const parsed = parseAtprotoLoopbackClientId(clientId);
    expect(parsed.redirect_uris).toEqual([`http://127.0.0.1${OAUTH.CALLBACK_PATH}`]);
    expect(parsed.scope).toBe(OAUTH.SCOPE);
  });

  it("lists the real-port redirect URI in the metadata while keeping the client_id stable", () => {
    const metadata = buildClientMetadata(REDIRECT_URI);
    expect(metadata.client_id).toBe(createLoopbackClientId());
    expect(metadata.redirect_uris).toEqual([REDIRECT_URI]);
    expect(metadata.token_endpoint_auth_method).toBe("none");
    expect(metadata.dpop_bound_access_tokens).toBe(true);
  });

  it("is accepted by OAuthClient, which rejects an authorize() redirect_uri that is not listed", async () => {
    const client = createOAuthClient({
      redirectUri: REDIRECT_URI,
      stateStore: createMemoryStateStore(),
      sessionStore: new OAuthSessionStore(null),
      onSessionDeleted: () => undefined,
    });
    expect(client).toBeInstanceOf(OAuthClient);
    // Declared without a port: the library would refuse a different port (hence one client per attempt).
    await expect(
      client.authorize("alice.test", { redirect_uri: "http://127.0.0.1:1/callback" }),
    ).rejects.toThrow("Invalid redirect_uri");
  });
});

describe("runtime implementation", () => {
  it("creates extractable DPoP keys, random bytes and SHA digests", async () => {
    const runtime = createRuntimeImplementation();
    const key = await runtime.createKey(["ES256"]);
    expect(key.privateJwk).toBeDefined();
    expect((await runtime.getRandomValues(32)).length).toBe(32);
    const digest = await runtime.digest(new TextEncoder().encode("abc"), { name: "sha256" });
    expect(Buffer.from(digest).toString("hex")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});

describe("OAuth session serialization (V-15)", () => {
  it("round-trips including the DPoP key", async () => {
    const session = await makeSession();
    const text = serializeOAuthSession(session);
    expect(text).not.toBeNull();
    const restored = await parseOAuthSession(text ?? "");
    expect(restored?.tokenSet).toEqual(session.tokenSet);
    expect(restored?.authMethod).toEqual({ method: "none" });
    expect(restored?.dpopKey.privateJwk).toEqual(session.dpopKey.privateJwk);
  });

  it("stays small enough for the 16 KiB secret limit with realistic token sizes", async () => {
    const text = serializeOAuthSession(await makeSession("a".repeat(1_200)));
    expect(text?.length ?? Number.POSITIVE_INFINITY).toBeLessThan(4_096);
  });

  it.each([
    ["not json", "{"],
    ["no key", JSON.stringify({ authMethod: { method: "none" }, tokenSet: {} })],
    ["bad did", "BAD_DID"],
    ["bad scope", "BAD_SCOPE"],
    ["bad auth method", "BAD_METHOD"],
  ])("rejects malformed stored data (%s)", async (name, text) => {
    let raw = text;
    if (name !== "not json" && name !== "no key") {
      const parsed: unknown = JSON.parse(serializeOAuthSession(await makeSession()) ?? "{}");
      const base = parsed as { tokenSet: Record<string, unknown>; authMethod: unknown };
      if (name === "bad did") base.tokenSet.sub = "did:example:x";
      if (name === "bad scope") base.tokenSet.scope = "transition:generic";
      if (name === "bad auth method") base.authMethod = { method: "client_secret" };
      raw = JSON.stringify(base);
    }
    expect(await parseOAuthSession(raw)).toBeNull();
  });
});

describe("OAuthSessionStore", () => {
  it("persists on set when remembering, and del keeps the stored secret", async () => {
    const secure = createMemorySecureStore();
    const store = new OAuthSessionStore(secure);
    const session = await makeSession();
    await store.set(DID, session);
    expect(await secure.get("session.oauth")).toContain("synthetic-refresh");
    expect(store.get(DID)).toBe(session);
    store.del(DID);
    expect(store.get(DID)).toBeUndefined();
    expect(await secure.get("session.oauth")).not.toBeNull();
    await store.forget();
    expect(await secure.get("session.oauth")).toBeNull();
    expect(store.remembered).toBe(true);
  });

  it("stays in memory when not remembering", async () => {
    const store = new OAuthSessionStore(null);
    await store.set(DID, await makeSession());
    expect(store.get(DID)).toBeDefined();
    expect(store.remembered).toBe(false);
  });

  it("does not fail when the secret store is unavailable; reports it once", async () => {
    const failing: SecureStore = {
      get: () => Promise.reject(new SecureStoreError("unavailable")),
      set: () => Promise.reject(new SecureStoreError("unavailable")),
      delete: () => Promise.reject(new SecureStoreError("unavailable")),
    };
    const onFailed = vi.fn();
    const store = new OAuthSessionStore(failing, onFailed);
    await store.set(DID, await makeSession());
    await store.set(DID, await makeSession());
    expect(store.get(DID)).toBeDefined();
    expect(store.remembered).toBe(false);
    expect(onFailed).toHaveBeenCalledTimes(1);
    await expect(store.forget()).resolves.toBeUndefined();
  });
});

describe("createMemoryStateStore", () => {
  it("is bounded (oldest dropped first) and clearable", async () => {
    const store = createMemoryStateStore(2);
    const value = {
      iss: "i",
      dpopKey: (await makeSession()).dpopKey,
      authMethod: { method: "none" } as const,
      verifier: "v",
    };
    store.set("a", value);
    store.set("b", value);
    store.set("c", value);
    expect(store.get("a")).toBeUndefined();
    expect(store.get("c")).toBeDefined();
    store.clear();
    expect(store.get("b")).toBeUndefined();
  });
});

describe("classifyOAuthError", () => {
  it("maps flow errors to actionable kinds without exposing parameters", () => {
    const callbackError = (query: string): Error =>
      Object.assign(new Error("callback"), { name: "OAuthCallbackError", params: new URLSearchParams(query) });
    expect(classifyOAuthError(callbackError("error=access_denied&state=s"), undefined).kind).toBe("authCancelled");
    expect(classifyOAuthError(callbackError("error=server_error"), undefined).kind).toBe("unknown");
    expect(classifyOAuthError(Object.assign(new Error("x"), { name: "OAuthResolverError" }), undefined).kind).toBe("invalidHandle");
    expect(classifyOAuthError(new TypeError("failed to fetch"), undefined).kind).toBe("network");
    expect(classifyOAuthError(new OAuthRedirectError("timeout"), undefined).kind).toBe("authCancelled");
    expect(classifyOAuthError(new OAuthRedirectError("failed"), undefined).kind).toBe("unknown");
    const controller = new AbortController();
    controller.abort();
    expect(classifyOAuthError(new Error("whatever"), controller.signal).kind).toBe("authCancelled");
  });
});

interface FakeFlow {
  factory: OAuthClientFactory;
  params: () => OAuthClientParams;
  session: OAuthSessionLike;
  listener: OAuthRedirectListener;
  /** Mock functions, kept as plain variables so expectations do not read unbound methods. */
  mocks: {
    authorize: Mock;
    callback: Mock;
    restore: Mock;
    signOut: Mock;
    close: Mock;
    waitForRedirect: Mock;
  };
}

async function fakeFlow(options: { aud?: string; handle?: string } = {}): Promise<FakeFlow> {
  let captured: OAuthClientParams | null = null;
  const stored = await makeSession();
  const signOut = vi.fn(() => Promise.resolve());
  const session = {
    did: DID,
    fetchHandler: vi.fn(),
    getTokenInfo: vi.fn(() => Promise.resolve({ aud: options.aud ?? "https://morel.us-east.host.bsky.network" })),
    signOut,
  } satisfies OAuthSessionLike;
  const authorize = vi.fn(() => Promise.resolve(new URL("https://auth.example.test/authorize?request_uri=synthetic")));
  const callback = vi.fn(async () => {
    await captured?.sessionStore.set(DID, stored);
    return { session };
  });
  const restore = vi.fn(() => Promise.resolve(session));
  const client = {
    authorize,
    callback,
    restore,
    identityResolver: { resolve: () => Promise.resolve({ handle: options.handle ?? "alice.test" }) },
  };
  const close = vi.fn(() => Promise.resolve());
  const waitForRedirect = vi.fn(() => Promise.resolve(new URLSearchParams("state=s&code=c")));
  const listener = { redirectUri: REDIRECT_URI, waitForRedirect, close } satisfies OAuthRedirectListener;
  const factory: OAuthClientFactory = (params) => {
    captured = params;
    const like: OAuthClientLike = client;
    return like;
  };
  return {
    factory,
    params: () => {
      if (captured === null) throw new Error("client not created");
      return captured;
    },
    session,
    listener,
    mocks: { authorize, callback, restore, signOut, close, waitForRedirect },
  };
}

function hooks() {
  return { onSessionLost: vi.fn(), onNotice: vi.fn<(error: GardenError) => void>() };
}

describe("loginWithOAuth", () => {
  let flow: FakeFlow;
  beforeEach(async () => {
    flow = await fakeFlow();
  });

  it("runs authorize, browser redirect and callback with the real-port redirect URI", async () => {
    const handle = await loginWithOAuth("@alice.test", hooks(), {
      clientFactory: flow.factory,
      listen: () => Promise.resolve(flow.listener),
    });
    expect(flow.params().redirectUri).toBe(REDIRECT_URI);
    expect(flow.mocks.authorize).toHaveBeenCalledWith("alice.test", expect.objectContaining({ redirect_uri: REDIRECT_URI }));
    expect(flow.mocks.waitForRedirect).toHaveBeenCalledWith("https://auth.example.test/authorize?request_uri=synthetic");
    expect(flow.mocks.callback).toHaveBeenCalledTimes(1);
    expect(flow.mocks.close).toHaveBeenCalledTimes(1);
    expect(handle).toMatchObject({ authMethod: "oauth", handle: "alice.test", did: DID, remembered: false });
    expect(handle.engagementClient).toBeDefined();
  });

  it("remembers into session.oauth only when asked", async () => {
    const secure = createMemorySecureStore();
    const handle = await loginWithOAuth("alice.test", hooks(), {
      remember: true,
      secureStore: secure,
      clientFactory: flow.factory,
      listen: () => Promise.resolve(flow.listener),
    });
    expect(handle.remembered).toBe(true);
    expect(await secure.get("session.oauth")).toContain("synthetic-refresh");
    expect(await secure.get("session.appPassword")).toBeNull();

    const other = await fakeFlow();
    const secure2 = createMemorySecureStore();
    const plain = await loginWithOAuth("alice.test", hooks(), {
      secureStore: secure2,
      clientFactory: other.factory,
      listen: () => Promise.resolve(other.listener),
    });
    expect(plain.remembered).toBe(false);
    expect(secure2.size).toBe(0);
  });

  it("continues unremembered with a notice when the secret store is unavailable", async () => {
    const failing: SecureStore = {
      get: () => Promise.reject(new SecureStoreError("unavailable")),
      set: () => Promise.reject(new SecureStoreError("unavailable")),
      delete: () => Promise.reject(new SecureStoreError("unavailable")),
    };
    const h = hooks();
    const handle = await loginWithOAuth("alice.test", h, {
      remember: true,
      secureStore: failing,
      clientFactory: flow.factory,
      listen: () => Promise.resolve(flow.listener),
    });
    expect(handle.remembered).toBe(false);
    expect(h.onNotice.mock.calls[0]?.[0].kind).toBe("secureStorageUnavailable");
  });

  it("rejects an unsupported PDS: signs out and does not keep anything", async () => {
    const other = await fakeFlow({ aud: "https://pds.example.test" });
    const secure = createMemorySecureStore();
    await expect(
      loginWithOAuth("alice.test", hooks(), {
        remember: true,
        secureStore: secure,
        clientFactory: other.factory,
        listen: () => Promise.resolve(other.listener),
      }),
    ).rejects.toMatchObject({ kind: "unsupportedPds" });
    expect(other.mocks.signOut).toHaveBeenCalledTimes(1);
    expect(await secure.get("session.oauth")).toBeNull();
  });

  it("maps cancellation and always releases the redirect listener", async () => {
    flow.mocks.waitForRedirect.mockRejectedValueOnce(new OAuthRedirectError("cancelled"));
    await expect(
      loginWithOAuth("alice.test", hooks(), { clientFactory: flow.factory, listen: () => Promise.resolve(flow.listener) }),
    ).rejects.toMatchObject({ kind: "authCancelled" });
    expect(flow.mocks.close).toHaveBeenCalledTimes(1);
    expect(flow.mocks.callback).not.toHaveBeenCalled();
  });

  it("maps an access_denied callback to authCancelled", async () => {
    flow.mocks.callback.mockRejectedValueOnce(
      Object.assign(new Error("denied"), { name: "OAuthCallbackError", params: new URLSearchParams("error=access_denied") }),
    );
    await expect(
      loginWithOAuth("alice.test", hooks(), { clientFactory: flow.factory, listen: () => Promise.resolve(flow.listener) }),
    ).rejects.toMatchObject({ kind: "authCancelled" });
    expect(flow.mocks.close).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["an email address", "user@example.test", "https://bsky.social"],
    ["an empty identifier", "  ", "https://bsky.social"],
    ["free text", "a b", "https://bsky.social"],
    ["a handle with a leading @", " @alice.test ", "alice.test"],
    ["a DID", "did:plc:abcdefghijklmnopqrstuvwx", "did:plc:abcdefghijklmnopqrstuvwx"],
  ])("authorizes %s with the right input", async (_label, input, expected) => {
    await loginWithOAuth(input, hooks(), { clientFactory: flow.factory, listen: () => Promise.resolve(flow.listener) });
    expect(flow.mocks.authorize).toHaveBeenCalledWith(expected, expect.objectContaining({ redirect_uri: REDIRECT_URI }));
  });

  it("maps a failed handle resolution to invalidHandle and a failed fetch to network", async () => {
    const listen = (): Promise<OAuthRedirectListener> => Promise.resolve(flow.listener);
    flow.mocks.authorize.mockRejectedValueOnce(
      new Error("Failed to resolve identity: nobody.example.test", { cause: new Error("Invalid status code") }),
    );
    await expect(loginWithOAuth("nobody.example.test", hooks(), { clientFactory: flow.factory, listen })).rejects.toMatchObject({
      kind: "invalidHandle",
    });
    flow.mocks.authorize.mockRejectedValueOnce(
      new Error("Failed to resolve identity: x.example.test", { cause: new TypeError("fetch failed") }),
    );
    await expect(loginWithOAuth("x.example.test", hooks(), { clientFactory: flow.factory, listen })).rejects.toMatchObject({
      kind: "network",
    });
    flow.mocks.authorize.mockRejectedValueOnce(new Error("Failed to resolve OAuth server metadata for issuer: https://bsky.social"));
    await expect(loginWithOAuth("", hooks(), { clientFactory: flow.factory, listen })).rejects.toMatchObject({ kind: "network" });
  });

  it("reports a busy listener as authCancelled", async () => {
    await expect(
      loginWithOAuth("alice.test", hooks(), {
        clientFactory: flow.factory,
        listen: () => Promise.reject(new OAuthRedirectError("busy")),
      }),
    ).rejects.toMatchObject({ kind: "authCancelled" });
  });

  it("logout signs out and deletes the stored secret; a later deletion event signals session loss", async () => {
    const secure = createMemorySecureStore();
    const h = hooks();
    const handle = await loginWithOAuth("alice.test", h, {
      remember: true,
      secureStore: secure,
      clientFactory: flow.factory,
      listen: () => Promise.resolve(flow.listener),
    });
    flow.params().onSessionDeleted(DID, new TokenRevokedError(DID));
    expect(h.onSessionLost).toHaveBeenCalledWith("expired");
    await vi.waitFor(async () => {
      expect(await secure.get("session.oauth")).toBeNull();
    });

    await handle.logout();
    await handle.logout();
    expect(flow.mocks.signOut).toHaveBeenCalledTimes(1);
  });

  it("ignores deletion events that happen before the login completed (library revoking an old session)", async () => {
    const h = hooks();
    flow.mocks.callback.mockImplementationOnce(() => {
      flow.params().onSessionDeleted(DID, new TokenRevokedError(DID));
      return Promise.resolve({ session: flow.session });
    });
    await loginWithOAuth("alice.test", h, { clientFactory: flow.factory, listen: () => Promise.resolve(flow.listener) });
    expect(h.onSessionLost).not.toHaveBeenCalled();
  });

  it("keeps the remembered login when the user logs out after a transient deletion", async () => {
    const secure = createMemorySecureStore();
    const h = hooks();
    const handle = await loginWithOAuth("alice.test", h, {
      remember: true,
      secureStore: secure,
      clientFactory: flow.factory,
      listen: () => Promise.resolve(flow.listener),
    });
    flow.params().onSessionDeleted(DID, new TypeError("failed to fetch"));
    expect(h.onSessionLost).toHaveBeenCalledWith("expired");
    await handle.logout();
    expect(await secure.get("session.oauth")).not.toBeNull();
  });

  it("deletes the remembered login on a normal explicit logout", async () => {
    const secure = createMemorySecureStore();
    const handle = await loginWithOAuth("alice.test", hooks(), {
      remember: true,
      secureStore: secure,
      clientFactory: flow.factory,
      listen: () => Promise.resolve(flow.listener),
    });
    expect(await secure.get("session.oauth")).not.toBeNull();
    await handle.logout();
    expect(await secure.get("session.oauth")).toBeNull();
  });

  it("signs the new session out and reports authCancelled when cancelled during the callback", async () => {
    const secure = createMemorySecureStore();
    const controller = new AbortController();
    flow.mocks.callback.mockImplementationOnce(async () => {
      await flow.params().sessionStore.set(DID, await makeSession());
      controller.abort();
      return { session: flow.session };
    });
    await expect(
      loginWithOAuth("alice.test", hooks(), {
        remember: true,
        secureStore: secure,
        signal: controller.signal,
        clientFactory: flow.factory,
        listen: () => Promise.resolve(flow.listener),
      }),
    ).rejects.toMatchObject({ kind: "authCancelled" });
    expect(flow.mocks.signOut).toHaveBeenCalledTimes(1);
    expect(await secure.get("session.oauth")).toBeNull();
  });

  it("deletes a previous App Password entry after a remembered OAuth login", async () => {
    const secure = createMemorySecureStore();
    await secure.set("session.appPassword", "synthetic-old-entry");
    await loginWithOAuth("alice.test", hooks(), {
      remember: true,
      secureStore: secure,
      clientFactory: flow.factory,
      listen: () => Promise.resolve(flow.listener),
    });
    expect(await secure.get("session.appPassword")).toBeNull();
    expect(await secure.get("session.oauth")).not.toBeNull();
  });

  it("keeps an App Password entry when the OAuth login is not remembered", async () => {
    const secure = createMemorySecureStore();
    await secure.set("session.appPassword", "synthetic-old-entry");
    await loginWithOAuth("alice.test", hooks(), {
      secureStore: secure,
      clientFactory: flow.factory,
      listen: () => Promise.resolve(flow.listener),
    });
    expect(await secure.get("session.appPassword")).not.toBeNull();
  });
});

describe("restoreOAuthSession", () => {
  async function seeded(): Promise<ReturnType<typeof createMemorySecureStore>> {
    const secure = createMemorySecureStore();
    await secure.set("session.oauth", serializeOAuthSession(await makeSession()) ?? "");
    return secure;
  }

  it("restores the stored session through the client", async () => {
    const flow = await fakeFlow();
    const secure = await seeded();
    const handle = await restoreOAuthSession(hooks(), secure, { clientFactory: flow.factory });
    expect(flow.mocks.restore).toHaveBeenCalledWith(DID);
    expect(handle).toMatchObject({ authMethod: "oauth", did: DID, remembered: true });
  });

  it("returns null when nothing is stored", async () => {
    const flow = await fakeFlow();
    expect(await restoreOAuthSession(hooks(), createMemorySecureStore(), { clientFactory: flow.factory })).toBeNull();
    expect(flow.mocks.restore).not.toHaveBeenCalled();
  });

  it("deletes a malformed entry", async () => {
    const flow = await fakeFlow();
    const secure = createMemorySecureStore();
    await secure.set("session.oauth", "{ nope");
    expect(await restoreOAuthSession(hooks(), secure, { clientFactory: flow.factory })).toBeNull();
    expect(await secure.get("session.oauth")).toBeNull();
  });

  it("deletes the entry when the session was revoked, keeps it after a transient network error", async () => {
    const flow = await fakeFlow();
    const secure = await seeded();
    flow.mocks.restore.mockRejectedValueOnce(new TokenRevokedError(DID));
    expect(await restoreOAuthSession(hooks(), secure, { clientFactory: flow.factory })).toBeNull();
    expect(await secure.get("session.oauth")).toBeNull();

    const flow2 = await fakeFlow();
    const secure2 = await seeded();
    flow2.mocks.restore.mockRejectedValueOnce(new TypeError("failed to fetch"));
    expect(await restoreOAuthSession(hooks(), secure2, { clientFactory: flow2.factory })).toBeNull();
    expect(await secure2.get("session.oauth")).not.toBeNull();
  });

  it("signs out and deletes when the restored account is on an unsupported PDS", async () => {
    const flow = await fakeFlow({ aud: "https://pds.example.test" });
    const secure = await seeded();
    expect(await restoreOAuthSession(hooks(), secure, { clientFactory: flow.factory })).toBeNull();
    expect(flow.mocks.signOut).toHaveBeenCalledTimes(1);
    expect(await secure.get("session.oauth")).toBeNull();
  });

  it("returns null quietly when the store is unavailable", async () => {
    const flow = await fakeFlow();
    const failing: SecureStore = {
      get: () => Promise.reject(new SecureStoreError("unavailable")),
      set: () => Promise.reject(new SecureStoreError("unavailable")),
      delete: () => Promise.reject(new SecureStoreError("unavailable")),
    };
    expect(await restoreOAuthSession(hooks(), failing, { clientFactory: flow.factory })).toBeNull();
  });
});
