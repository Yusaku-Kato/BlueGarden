// @vitest-environment happy-dom
import { act, cleanup, renderHook } from "@testing-library/react";
import { StrictMode, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BlueskySessionHandle, SessionHooks } from "../services/bluesky/blueskySession";
import { GardenError } from "../services/bluesky/errors";

const mocks = vi.hoisted(() => ({
  login: vi.fn(),
  loginWithOAuth: vi.fn(),
  restoreSession: vi.fn(),
}));

vi.mock("../services/bluesky/blueskySession", async (importOriginal) => {
  const original = await importOriginal<typeof import("../services/bluesky/blueskySession")>();
  return {
    ...original,
    login: mocks.login,
    loginWithOAuth: mocks.loginWithOAuth,
    restoreSession: mocks.restoreSession,
  };
});

const { useBlueskySession } = await import("./useBlueskySession");

const SECRET = "abcd-efgh-ijkl-mnop";

function makeHandle(): BlueskySessionHandle & { logoutSpy: () => void } {
  const logoutSpy = vi.fn(() => Promise.resolve());
  const handle = {
    handle: "alice.bsky.social",
    did: "did:plc:test",
    feedClient: {},
    seenPosts: {},
    logout: logoutSpy,
    logoutSpy,
  };
  return handle as unknown as BlueskySessionHandle & { logoutSpy: () => void };
}

function form(identifier: string, password: string): FormData {
  const data = new FormData();
  data.set("identifier", identifier);
  data.set("appPassword", password);
  return data;
}

describe("useBlueskySession", () => {
  beforeEach(() => {
    mocks.login.mockReset();
    mocks.loginWithOAuth.mockReset();
    mocks.restoreSession.mockReset();
    mocks.restoreSession.mockResolvedValue(null);
  });
  afterEach(() => {
    cleanup();
  });

  it("rejects an invalid identifier without calling login", async () => {
    const { result } = renderHook(() => useBlueskySession());
    await act(async () => {
      await result.current.loginAction(form("not a handle", SECRET));
    });
    expect(mocks.login).not.toHaveBeenCalled();
    expect(result.current.authError).toEqual({ source: "auth", kind: "invalidHandle" });
    expect(result.current.status).toBe("signedOut");
  });

  it("ignores a double submit while signing in", async () => {
    let resolveLogin: (handle: BlueskySessionHandle) => void = () => undefined;
    mocks.login.mockImplementation(
      () =>
        new Promise<BlueskySessionHandle>((resolve) => {
          resolveLogin = resolve;
        }),
    );
    const { result } = renderHook(() => useBlueskySession());
    let first: Promise<void> = Promise.resolve();
    let second: Promise<void> = Promise.resolve();
    act(() => {
      first = result.current.loginAction(form("alice.bsky.social", SECRET));
      second = result.current.loginAction(form("alice.bsky.social", SECRET));
    });
    expect(result.current.status).toBe("signingIn");
    await act(async () => {
      resolveLogin(makeHandle());
      await Promise.all([first, second]);
    });
    expect(mocks.login).toHaveBeenCalledTimes(1);
    expect(result.current.status).toBe("authenticated");
    expect(result.current.session).not.toBeNull();
  });

  it("does not show sessionExpired when onSessionLost fires after an explicit logout", async () => {
    let hooks: SessionHooks | null = null;
    const handle = makeHandle();
    const logoutSpy = vi.fn(() => Promise.resolve());
    Object.defineProperty(handle, "logout", { value: logoutSpy });
    mocks.login.mockImplementation((_id: string, _pw: string, passed: SessionHooks) => {
      hooks = passed;
      return Promise.resolve(handle);
    });
    const { result } = renderHook(() => useBlueskySession());
    await act(async () => {
      await result.current.loginAction(form("alice.bsky.social", SECRET));
    });
    expect(result.current.status).toBe("authenticated");

    await act(async () => {
      await result.current.logout();
    });
    act(() => {
      hooks?.onSessionLost("expired");
      result.current.reportSessionLost();
    });
    expect(result.current.status).toBe("signedOut");
    expect(result.current.authError).toBeNull();
    expect(logoutSpy).toHaveBeenCalledTimes(1);
  });

  it("signs out with sessionExpired when the current session is lost", async () => {
    let hooks: SessionHooks | null = null;
    mocks.login.mockImplementation((_id: string, _pw: string, passed: SessionHooks) => {
      hooks = passed;
      return Promise.resolve(makeHandle());
    });
    const { result } = renderHook(() => useBlueskySession());
    await act(async () => {
      await result.current.loginAction(form("alice.bsky.social", SECRET));
    });
    act(() => {
      hooks?.onSessionLost("expired");
    });
    expect(result.current.status).toBe("signedOut");
    expect(result.current.authError).toEqual({ source: "auth", kind: "sessionExpired" });
  });

  it("never exposes the password in returned hook values", async () => {
    mocks.login.mockResolvedValue(makeHandle());
    const { result } = renderHook(() => useBlueskySession());
    await act(async () => {
      await result.current.loginAction(form("alice.bsky.social", SECRET));
    });
    const { status, authError, session } = result.current;
    expect(JSON.stringify({ status, authError, handle: session?.handle, did: session?.did })).not.toContain(
      SECRET,
    );
    expect(mocks.login.mock.calls[0]?.[1]).toBe(SECRET);
  });

  it("falls back to the login screen when nothing can be restored", async () => {
    const { result } = renderHook(() => useBlueskySession());
    expect(result.current.status).toBe("restoring");
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.status).toBe("signedOut");
    expect(result.current.authError).toBeNull();
  });

  it("restores a remembered session once, even under StrictMode", async () => {
    const handle = makeHandle();
    mocks.restoreSession.mockResolvedValue(handle);
    const wrapper = ({ children }: { children: ReactNode }) => <StrictMode>{children}</StrictMode>;
    const { result } = renderHook(() => useBlueskySession(), { wrapper });
    await act(async () => {
      await Promise.resolve();
    });
    expect(mocks.restoreSession).toHaveBeenCalledTimes(1);
    expect(result.current.status).toBe("authenticated");
    expect(result.current.session).toBe(handle);
    expect(handle.logoutSpy).not.toHaveBeenCalled();
  });

  it("shows a concise error when restore rejects unexpectedly", async () => {
    mocks.restoreSession.mockRejectedValue(new Error("boom"));
    const { result } = renderHook(() => useBlueskySession());
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.status).toBe("signedOut");
    expect(result.current.authError).toEqual({ source: "auth", kind: "sessionExpired" });
  });

  it("logs out a restored session that was superseded by a guest entry", async () => {
    let resolveRestore: (handle: BlueskySessionHandle | null) => void = () => undefined;
    mocks.restoreSession.mockReturnValue(
      new Promise<BlueskySessionHandle | null>((resolve) => {
        resolveRestore = resolve;
      }),
    );
    const handle = makeHandle();
    const { result } = renderHook(() => useBlueskySession());
    act(() => {
      result.current.enterAsGuest();
    });
    await act(async () => {
      resolveRestore(handle);
      await Promise.resolve();
    });
    expect(handle.logoutSpy).toHaveBeenCalledTimes(1);
    expect(result.current.status).toBe("guest");
  });

  it("enters as a guest without a session and logs out back to the login screen", async () => {
    const { result } = renderHook(() => useBlueskySession());
    await act(async () => {
      await Promise.resolve();
    });
    act(() => {
      result.current.enterAsGuest();
    });
    expect(result.current.status).toBe("guest");
    expect(result.current.access?.authMethod).toBe("guest");
    expect(result.current.session).toBeNull();
    expect(mocks.login).not.toHaveBeenCalled();

    await act(async () => {
      await result.current.logout();
    });
    expect(result.current.status).toBe("signedOut");
    expect(result.current.access).toBeNull();
  });

  it("passes the remember checkbox through to login", async () => {
    mocks.login.mockResolvedValue(makeHandle());
    const { result } = renderHook(() => useBlueskySession());
    const remembered = form("alice.bsky.social", SECRET);
    remembered.set("remember", "on");
    await act(async () => {
      await result.current.loginAction(remembered);
    });
    expect(mocks.login.mock.calls[0]?.[3]).toEqual({ remember: true });

    await act(async () => {
      await result.current.logout();
    });
    await act(async () => {
      await result.current.loginAction(form("alice.bsky.social", SECRET));
    });
    expect(mocks.login.mock.calls[1]?.[3]).toEqual({ remember: false });
  });

  it("shows a non-blocking notice when secure storage is unavailable", async () => {
    mocks.login.mockImplementation((_id: string, _pw: string, hooks: SessionHooks) => {
      hooks.onNotice?.(new GardenError("secureStorageUnavailable"));
      return Promise.resolve(makeHandle());
    });
    const { result } = renderHook(() => useBlueskySession());
    await act(async () => {
      await result.current.loginAction(form("alice.bsky.social", SECRET));
    });
    expect(result.current.status).toBe("authenticated");
    expect(result.current.notice).toBe("secureStorageUnavailable");
    act(() => {
      result.current.dismissNotice();
    });
    expect(result.current.notice).toBeNull();
  });

  it("signs in with OAuth using the handle and the remember flag", async () => {
    mocks.loginWithOAuth.mockResolvedValue(makeHandle());
    const { result } = renderHook(() => useBlueskySession());
    await act(async () => {
      await result.current.loginWithOAuthAction("@alice.bsky.social", true);
    });
    expect(mocks.loginWithOAuth.mock.calls[0]?.[0]).toBe("alice.bsky.social");
    expect(mocks.loginWithOAuth.mock.calls[0]?.[2]).toMatchObject({ remember: true });
    expect(result.current.status).toBe("authenticated");
  });

  it("passes an email or a blank identifier through to OAuth without validation", async () => {
    mocks.loginWithOAuth.mockResolvedValue(makeHandle());
    const { result } = renderHook(() => useBlueskySession());
    await act(async () => {
      await result.current.loginWithOAuthAction("  me@example.com ", false);
    });
    expect(mocks.loginWithOAuth.mock.calls[0]?.[0]).toBe("me@example.com");
    expect(result.current.authError).toBeNull();
    expect(result.current.status).toBe("authenticated");

    await act(async () => {
      await result.current.logout();
    });
    await act(async () => {
      await result.current.loginWithOAuthAction("", false);
    });
    expect(mocks.loginWithOAuth).toHaveBeenCalledTimes(2);
    expect(mocks.loginWithOAuth.mock.calls[1]?.[0]).toBe("");
  });

  it("cancels a pending OAuth attempt silently and allows only one attempt at a time", async () => {
    mocks.loginWithOAuth.mockImplementation(
      (_id: string, _hooks: SessionHooks, options: { signal: AbortSignal }) =>
        new Promise<BlueskySessionHandle>((_resolve, reject) => {
          options.signal.addEventListener("abort", () => {
            reject(new GardenError("authCancelled"));
          });
        }),
    );
    const { result } = renderHook(() => useBlueskySession());
    let first: Promise<void> = Promise.resolve();
    act(() => {
      first = result.current.loginWithOAuthAction("alice.bsky.social", false);
    });
    expect(result.current.status).toBe("signingIn");
    expect(result.current.pendingLogin).toBe("oauth");
    await act(async () => {
      await result.current.loginWithOAuthAction("alice.bsky.social", false); // ignored
      await result.current.loginAction(form("alice.bsky.social", SECRET)); // ignored
    });
    expect(mocks.loginWithOAuth).toHaveBeenCalledTimes(1);
    expect(mocks.login).not.toHaveBeenCalled();

    await act(async () => {
      result.current.cancelOAuth();
      await first;
    });
    expect(result.current.status).toBe("signedOut");
    expect(result.current.authError).toBeNull();
    expect(result.current.pendingLogin).toBeNull();
  });

  it("logs out a late OAuth result that arrives after the user cancelled", async () => {
    const late: { resolve: ((handle: BlueskySessionHandle) => void) | null } = { resolve: null };
    mocks.loginWithOAuth.mockImplementation(
      () =>
        new Promise<BlueskySessionHandle>((resolve) => {
          late.resolve = resolve;
        }),
    );
    const { result } = renderHook(() => useBlueskySession());
    let first: Promise<void> = Promise.resolve();
    act(() => {
      first = result.current.loginWithOAuthAction("alice.bsky.social", false);
    });
    act(() => {
      result.current.cancelOAuth();
    });
    expect(result.current.status).toBe("signedOut");
    expect(result.current.pendingLogin).toBeNull();
    const handle = makeHandle();
    await act(async () => {
      late.resolve?.(handle);
      await first;
    });
    expect(handle.logoutSpy).toHaveBeenCalledTimes(1);
    expect(result.current.status).toBe("signedOut");
    expect(result.current.access).toBeNull();
  });

  it("aborts a pending OAuth attempt on unmount", () => {
    const captured: { signal: AbortSignal | null } = { signal: null };
    mocks.loginWithOAuth.mockImplementation(
      (_id: string, _hooks: SessionHooks, options: { signal: AbortSignal }) => {
        captured.signal = options.signal;
        return new Promise<BlueskySessionHandle>(() => undefined);
      },
    );
    const { result, unmount } = renderHook(() => useBlueskySession());
    act(() => {
      void result.current.loginWithOAuthAction("alice.bsky.social", false);
    });
    unmount();
    expect(captured.signal?.aborted).toBe(true);
  });
});
