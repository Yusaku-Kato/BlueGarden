import { beforeEach, describe, expect, it, vi } from "vitest";
import { BLUESKY } from "../../config/gardenConfig";
import { createMemorySecureStore, type SecretKey, type SecureStore, SecureStoreError } from "../../infra/secureStore";
import type { GardenError } from "./errors";

const mocks = vi.hoisted(() => ({
  login: vi.fn(),
  resume: vi.fn(),
}));

vi.mock("@atproto/lex-password-session", async (importOriginal) => {
  const original = await importOriginal<typeof import("@atproto/lex-password-session")>();
  return { ...original, PasswordSession: { login: mocks.login, resume: mocks.resume } };
});

const { login, restoreSession } = await import("./blueskySession");

const DID = "did:plc:abcdefghijklmnopqrstuvwx";
const PASSWORD = "abcd-efgh-ijkl-mnop";

function didDoc(endpoint: string): unknown {
  return { id: DID, service: [{ id: "#atproto_pds", type: "AtprotoPersonalDataServer", serviceEndpoint: endpoint }] };
}

function fakeSession(endpoint = "https://morel.us-east.host.bsky.network") {
  return {
    handle: "alice.test",
    did: DID,
    destroyed: false,
    session: {
      accessJwt: "access-1",
      refreshJwt: "refresh-1",
      handle: "alice.test",
      did: DID,
      email: "alice@example.test",
      service: BLUESKY.SERVICE_URL,
      didDoc: didDoc(endpoint),
    },
    logout: vi.fn(() => Promise.resolve()),
    fetchHandler: vi.fn(),
  };
}

interface LoginOptionsSeen {
  onUpdated?: (data: unknown) => Promise<void>;
  onDeleted?: () => Promise<void>;
  password?: string;
}

function hooks() {
  return { onSessionLost: vi.fn(), onNotice: vi.fn<(error: GardenError) => void>() };
}

/** A store that records every call and can be told to fail. */
function recordingStore(failWith: SecureStoreError | null = null): SecureStore & { calls: string[]; inner: ReturnType<typeof createMemorySecureStore> } {
  const inner = createMemorySecureStore();
  const calls: string[] = [];
  const wrap =
    <A extends unknown[], R>(name: string, fn: (...args: A) => Promise<R>) =>
    (...args: A): Promise<R> => {
      calls.push(`${name}:${String(args[0])}`);
      return failWith === null ? fn(...args) : Promise.reject(failWith);
    };
  return {
    calls,
    inner,
    get: wrap("get", (key: SecretKey) => inner.get(key)),
    set: wrap("set", (key: SecretKey, value: string) => inner.set(key, value)),
    delete: wrap("delete", (key: SecretKey) => inner.delete(key)),
  };
}

beforeEach(() => {
  mocks.login.mockReset();
  mocks.resume.mockReset();
});

describe("login with remember", () => {
  it("stores session data (never the password) after the PDS check", async () => {
    const session = fakeSession();
    mocks.login.mockResolvedValue(session);
    const store = recordingStore();
    const handle = await login("alice.test", PASSWORD, hooks(), { remember: true, secureStore: store });
    expect(handle.remembered).toBe(true);
    expect(handle.authMethod).toBe("appPassword");
    const saved = await store.inner.get("session.appPassword");
    expect(saved).toContain("refresh-1");
    expect(saved).not.toContain(PASSWORD);
    expect(saved).not.toContain("alice@example.test");
    expect(store.calls.every((call) => !call.includes(PASSWORD))).toBe(true);
  });

  it("does not touch the store without remember", async () => {
    mocks.login.mockResolvedValue(fakeSession());
    const store = recordingStore();
    const handle = await login("alice.test", PASSWORD, hooks(), { secureStore: store });
    expect(handle.remembered).toBe(false);
    expect(store.calls).toEqual([]);
  });

  it("does not persist anything before the PDS check, and not at all for an unsupported PDS", async () => {
    const session = fakeSession("https://pds.example.test");
    mocks.login.mockResolvedValue(session);
    const store = recordingStore();
    await expect(login("alice.test", PASSWORD, hooks(), { remember: true, secureStore: store })).rejects.toMatchObject({
      kind: "unsupportedPds",
    });
    expect(session.logout).toHaveBeenCalledTimes(1);
    expect(store.calls).toEqual([]);
  });

  it("persists refreshed session data through onUpdated once remembered", async () => {
    mocks.login.mockResolvedValue(fakeSession());
    const store = recordingStore();
    await login("alice.test", PASSWORD, hooks(), { remember: true, secureStore: store });
    const options = mocks.login.mock.calls[0]?.[0] as LoginOptionsSeen;
    expect(options.password).toBe(PASSWORD); // passed through to the SDK call only
    await options.onUpdated?.({ accessJwt: "access-2", refreshJwt: "refresh-2", handle: "alice.test", did: DID, service: BLUESKY.SERVICE_URL });
    expect(await store.inner.get("session.appPassword")).toContain("refresh-2");
  });

  it("continues unremembered and reports secureStorageUnavailable when the store is unavailable", async () => {
    mocks.login.mockResolvedValue(fakeSession());
    const h = hooks();
    const handle = await login("alice.test", PASSWORD, h, {
      remember: true,
      secureStore: recordingStore(new SecureStoreError("unavailable")),
    });
    expect(handle.remembered).toBe(false);
    expect(h.onNotice).toHaveBeenCalledTimes(1);
    expect(h.onNotice.mock.calls[0]?.[0].kind).toBe("secureStorageUnavailable");
    expect(h.onSessionLost).not.toHaveBeenCalled();
  });

  it("logout ends the session and deletes the stored secret, idempotently", async () => {
    const session = fakeSession();
    mocks.login.mockResolvedValue(session);
    const store = recordingStore();
    const handle = await login("alice.test", PASSWORD, hooks(), { remember: true, secureStore: store });
    await handle.logout();
    await handle.logout();
    expect(session.logout).toHaveBeenCalledTimes(1);
    expect(await store.inner.get("session.appPassword")).toBeNull();
  });

  it("removes the stored secret when the SDK reports the session deleted, and signals session loss", async () => {
    mocks.login.mockResolvedValue(fakeSession());
    const store = recordingStore();
    const h = hooks();
    await login("alice.test", PASSWORD, h, { remember: true, secureStore: store });
    const options = mocks.login.mock.calls[0]?.[0] as LoginOptionsSeen;
    await options.onDeleted?.();
    expect(await store.inner.get("session.appPassword")).toBeNull();
    expect(h.onSessionLost).toHaveBeenCalledWith("expired");
  });
});

describe("restoreSession", () => {
  async function seeded(extra: Record<string, unknown> = {}): Promise<ReturnType<typeof recordingStore>> {
    const store = recordingStore();
    await store.inner.set(
      "session.appPassword",
      JSON.stringify({
        v: 1,
        accessJwt: "access-1",
        refreshJwt: "refresh-1",
        handle: "alice.test",
        did: DID,
        service: BLUESKY.SERVICE_URL,
        ...extra,
      }),
    );
    store.calls.length = 0;
    return store;
  }

  it("resumes the stored App Password session", async () => {
    const store = await seeded();
    const session = fakeSession();
    mocks.resume.mockResolvedValue(session);
    const handle = await restoreSession(hooks(), { secureStore: store });
    expect(handle?.remembered).toBe(true);
    expect(handle?.authMethod).toBe("appPassword");
    expect(mocks.resume).toHaveBeenCalledTimes(1);
    expect(mocks.resume.mock.calls[0]?.[0]).toMatchObject({ refreshJwt: "refresh-1", did: DID });
  });

  it("returns null without any call when nothing is stored", async () => {
    const store = recordingStore();
    expect(await restoreSession(hooks(), { secureStore: store })).toBeNull();
    expect(mocks.resume).not.toHaveBeenCalled();
  });

  it("returns null quietly when the store is unavailable", async () => {
    const h = hooks();
    expect(await restoreSession(h, { secureStore: recordingStore(new SecureStoreError("unavailable")) })).toBeNull();
    expect(h.onNotice).not.toHaveBeenCalled();
  });

  it("deletes malformed or tampered entries", async () => {
    const store = await seeded();
    await store.inner.set("session.appPassword", "{ not json");
    expect(await restoreSession(hooks(), { secureStore: store })).toBeNull();
    expect(await store.inner.get("session.appPassword")).toBeNull();

    const tampered = await seeded({ service: "https://evil.example.test" });
    expect(await restoreSession(hooks(), { secureStore: tampered })).toBeNull();
    expect(mocks.resume).not.toHaveBeenCalled();
    expect(await tampered.inner.get("session.appPassword")).toBeNull();
  });

  it("deletes the entry when the session is definitely invalid", async () => {
    const store = await seeded();
    mocks.resume.mockRejectedValue(Object.assign(new Error("expired"), { name: "XrpcResponseError" }));
    expect(await restoreSession(hooks(), { secureStore: store })).toBeNull();
    expect(await store.inner.get("session.appPassword")).toBeNull();
  });

  it("logs out and deletes when the restored account is on a PDS outside the allowlist", async () => {
    const store = await seeded();
    const session = fakeSession("https://pds.example.test");
    mocks.resume.mockResolvedValue(session);
    expect(await restoreSession(hooks(), { secureStore: store })).toBeNull();
    expect(session.logout).toHaveBeenCalledTimes(1);
    expect(await store.inner.get("session.appPassword")).toBeNull();
  });
});
