// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const tauri = vi.hoisted(() => ({
  inTauri: false,
  minimized: false,
  visible: true,
  visibleError: false,
  resizeHandlers: [] as (() => void)[],
  unlisten: vi.fn(),
  trayHandlers: [] as ((event: { payload: unknown }) => void)[],
  deferListen: null as null | { resolve: () => void },
}));

vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => tauri.inTauri }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: (_name: string, handler: (event: { payload: unknown }) => void) => {
    tauri.trayHandlers.push(handler);
    if (tauri.deferListen !== null) {
      return new Promise<() => void>((resolve) => {
        tauri.deferListen = {
          resolve: () => {
            resolve(tauri.unlisten);
          },
        };
      });
    }
    return Promise.resolve(tauri.unlisten);
  },
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    isMinimized: () => Promise.resolve(tauri.minimized),
    isVisible: () => (tauri.visibleError ? Promise.reject(new Error("boom")) : Promise.resolve(tauri.visible)),
    onResized: (handler: () => void) => {
      tauri.resizeHandlers.push(handler);
      return Promise.resolve(tauri.unlisten);
    },
    onFocusChanged: () => Promise.resolve(tauri.unlisten),
  }),
}));

const { watchWindowHidden } = await import("./windowVisibility");

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  tauri.inTauri = false;
  tauri.minimized = false;
  tauri.visible = true;
  tauri.visibleError = false;
  tauri.resizeHandlers = [];
  tauri.trayHandlers = [];
  tauri.deferListen = null;
  tauri.unlisten.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("watchWindowHidden", () => {
  it("reports the initial state once and follows document visibility", () => {
    let visibility: DocumentVisibilityState = "visible";
    vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
    const changes: boolean[] = [];
    const stop = watchWindowHidden((hidden) => changes.push(hidden));

    visibility = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
    document.dispatchEvent(new Event("visibilitychange"));
    visibility = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    expect(changes).toEqual([false, true, false]);

    stop();
    visibility = "hidden";
    document.dispatchEvent(new Event("visibilitychange"));
    expect(changes).toEqual([false, true, false]);
  });

  it("treats a minimized Tauri window as hidden even when the page stays visible", async () => {
    tauri.inTauri = true;
    const changes: boolean[] = [];
    const stop = watchWindowHidden((hidden) => changes.push(hidden));
    await flush();

    tauri.minimized = true;
    for (const handler of tauri.resizeHandlers) handler();
    await flush();
    tauri.minimized = false;
    for (const handler of tauri.resizeHandlers) handler();
    await flush();
    expect(changes).toEqual([false, true, false]);

    stop();
    expect(tauri.unlisten).toHaveBeenCalledTimes(3);
  });

  it("detects a restore that arrives without a usable event, then stops re-checking", async () => {
    vi.useFakeTimers();
    try {
      tauri.inTauri = true;
      tauri.minimized = true;
      const changes: boolean[] = [];
      const stop = watchWindowHidden((hidden) => changes.push(hidden));
      await vi.advanceTimersByTimeAsync(0);
      expect(changes).toEqual([false, true]);
      expect(vi.getTimerCount()).toBe(1);

      tauri.minimized = false; // restored, but no resize/focus event is delivered
      await vi.advanceTimersByTimeAsync(1_000);
      expect(changes).toEqual([false, true, false]);
      expect(vi.getTimerCount()).toBe(0);

      stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("treats a window hidden to the tray as hidden and notices the restore by re-checking", async () => {
    vi.useFakeTimers();
    try {
      tauri.inTauri = true;
      tauri.visible = false;
      const changes: boolean[] = [];
      const stop = watchWindowHidden((hidden) => changes.push(hidden));
      await vi.advanceTimersByTimeAsync(0);
      expect(changes).toEqual([false, true]);
      expect(vi.getTimerCount()).toBe(1);

      tauri.visible = true; // shown from the tray; no resize event is guaranteed
      await vi.advanceTimersByTimeAsync(1_000);
      expect(changes).toEqual([false, true, false]);
      expect(vi.getTimerCount()).toBe(0);
      stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not hide the garden when isVisible fails", async () => {
    tauri.inTauri = true;
    tauri.visibleError = true;
    const changes: boolean[] = [];
    const stop = watchWindowHidden((hidden) => changes.push(hidden));
    await flush();
    expect(changes).toEqual([false]);
    stop();
  });

  it("clears the re-check timer on unsubscribe", async () => {
    vi.useFakeTimers();
    try {
      tauri.inTauri = true;
      tauri.minimized = true;
      const stop = watchWindowHidden(() => undefined);
      await vi.advanceTimersByTimeAsync(0);
      expect(vi.getTimerCount()).toBe(1);
      stop();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("re-checks immediately on tray-action hidden/shown and ignores other payloads", async () => {
    tauri.inTauri = true;
    const changes: boolean[] = [];
    const stop = watchWindowHidden((hidden) => changes.push(hidden));
    await flush();

    tauri.visible = false;
    for (const handler of tauri.trayHandlers) handler({ payload: "toggleFullscreen" });
    await flush();
    expect(changes).toEqual([false]);
    for (const handler of tauri.trayHandlers) handler({ payload: "hidden" });
    await flush();
    tauri.visible = true;
    for (const handler of tauri.trayHandlers) handler({ payload: "shown" });
    await flush();
    expect(changes).toEqual([false, true, false]);
    stop();
  });

  it("unlistens immediately when disposed before listen resolves", async () => {
    tauri.inTauri = true;
    tauri.deferListen = { resolve: () => undefined };
    const stop = watchWindowHidden(() => undefined);
    await flush();
    stop();
    tauri.unlisten.mockClear();
    tauri.deferListen.resolve();
    await flush();
    expect(tauri.unlisten).toHaveBeenCalledTimes(1);
  });
});
