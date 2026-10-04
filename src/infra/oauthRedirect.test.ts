import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OAUTH } from "../config/gardenConfig";
import { listenForOAuthRedirect, type OAuthRedirectDeps } from "./oauthRedirect";

const PORT = 49_152;

interface Fake {
  deps: OAuthRedirectDeps;
  emit(url: string): void;
  calls: { started: number; cancelled: number[]; unlistened: number; opened: string[] };
}

function createFake(overrides: Partial<OAuthRedirectDeps> = {}): Fake {
  let callback: (url: string) => void = () => undefined;
  const calls: Fake["calls"] = { started: 0, cancelled: [], unlistened: 0, opened: [] };
  const deps: OAuthRedirectDeps = {
    start: () => {
      calls.started += 1;
      return Promise.resolve(PORT);
    },
    onUrl: (cb) => {
      callback = cb;
      return Promise.resolve(() => {
        calls.unlistened += 1;
      });
    },
    cancel: (port) => {
      calls.cancelled.push(port);
      return Promise.resolve();
    },
    openUrl: (url) => {
      calls.opened.push(url);
      return Promise.resolve();
    },
    setTimeout: (handler, ms) => setTimeout(handler, ms),
    clearTimeout: (handle) => {
      clearTimeout(handle);
    },
    ...overrides,
  };
  return { deps, emit: (url) => {
      callback(url);
    }, calls };
}

const callbackUrl = (query: string): string => `http://127.0.0.1:${String(PORT)}${OAUTH.CALLBACK_PATH}?${query}`;

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("listenForOAuthRedirect", () => {
  it("returns the real-port redirect URI, opens the browser and resolves with the parameters", async () => {
    const fake = createFake();
    const listener = await listenForOAuthRedirect(new AbortController().signal, fake.deps);
    expect(listener.redirectUri).toBe(`http://127.0.0.1:${String(PORT)}/callback`);
    const waiting = listener.waitForRedirect("https://auth.example.test/authorize?request_uri=x");
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.calls.opened).toEqual(["https://auth.example.test/authorize?request_uri=x"]);
    fake.emit(callbackUrl("state=s1&code=c1&iss=https%3A%2F%2Fa.example"));
    const params = await waiting;
    expect(params.get("state")).toBe("s1");
    expect(params.get("code")).toBe("c1");
    await listener.close();
    await listener.close();
    expect(fake.calls.cancelled).toEqual([PORT]);
    expect(fake.calls.unlistened).toBe(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("ignores unrelated requests (other path, other port, no state)", async () => {
    const fake = createFake();
    const listener = await listenForOAuthRedirect(new AbortController().signal, fake.deps);
    const waiting = listener.waitForRedirect("https://auth.example.test/a");
    await vi.advanceTimersByTimeAsync(0);
    fake.emit(`http://127.0.0.1:${String(PORT)}/favicon.ico?state=x`);
    fake.emit(`http://127.0.0.1:1${OAUTH.CALLBACK_PATH}?state=x`);
    fake.emit(callbackUrl("code=c"));
    fake.emit("garbage");
    fake.emit(callbackUrl("state=ok"));
    expect((await waiting).get("state")).toBe("ok");
    await listener.close();
  });

  it("allows only one attempt at a time", async () => {
    const fake = createFake();
    const first = await listenForOAuthRedirect(new AbortController().signal, fake.deps);
    await expect(listenForOAuthRedirect(new AbortController().signal, fake.deps)).rejects.toMatchObject({ code: "busy" });
    await first.close();
    const second = await listenForOAuthRedirect(new AbortController().signal, fake.deps);
    await second.close();
  });

  it("rejects with timeout after OAUTH.TIMEOUT_MS and releases the server", async () => {
    const fake = createFake();
    const listener = await listenForOAuthRedirect(new AbortController().signal, fake.deps);
    const waiting = listener.waitForRedirect("https://auth.example.test/a");
    const assertion = expect(waiting).rejects.toMatchObject({ code: "timeout" });
    await vi.advanceTimersByTimeAsync(OAUTH.TIMEOUT_MS);
    await assertion;
    await listener.close();
    expect(fake.calls.cancelled).toEqual([PORT]);
  });

  it("rejects with cancelled when the signal aborts", async () => {
    const fake = createFake();
    const controller = new AbortController();
    const listener = await listenForOAuthRedirect(controller.signal, fake.deps);
    const waiting = listener.waitForRedirect("https://auth.example.test/a");
    const assertion = expect(waiting).rejects.toMatchObject({ code: "cancelled" });
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    await assertion;
    await listener.close();
    expect(fake.calls.unlistened).toBe(1);
  });

  it("is cancelled when the signal is already aborted, without starting a server", async () => {
    const fake = createFake();
    const controller = new AbortController();
    controller.abort();
    await expect(listenForOAuthRedirect(controller.signal, fake.deps)).rejects.toMatchObject({ code: "cancelled" });
    expect(fake.calls.started).toBe(0);
  });

  it("cleans up and reports failed when the server cannot start", async () => {
    const fake = createFake({ start: () => Promise.reject(new Error("port in use")) });
    await expect(listenForOAuthRedirect(new AbortController().signal, fake.deps)).rejects.toMatchObject({ code: "failed" });
    // the attempt slot is free again
    const ok = createFake();
    const listener = await listenForOAuthRedirect(new AbortController().signal, ok.deps);
    await listener.close();
  });

  it("refuses non-https authorization URLs and reports a failed browser launch", async () => {
    const fake = createFake();
    const listener = await listenForOAuthRedirect(new AbortController().signal, fake.deps);
    await expect(listener.waitForRedirect("http://auth.example.test/a")).rejects.toMatchObject({ code: "failed" });
    await expect(listener.waitForRedirect("file:///etc/passwd")).rejects.toMatchObject({ code: "failed" });
    expect(fake.calls.opened).toHaveLength(0);
    await listener.close();

    const failing = createFake({ openUrl: () => Promise.reject(new Error("no browser")) });
    const second = await listenForOAuthRedirect(new AbortController().signal, failing.deps);
    await expect(second.waitForRedirect("https://auth.example.test/a")).rejects.toMatchObject({ code: "failed" });
    await second.close();
    expect(vi.getTimerCount()).toBe(0);
  });
});
