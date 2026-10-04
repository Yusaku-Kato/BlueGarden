// @vitest-environment happy-dom
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type TrayHandler = (event: { payload: unknown }) => void;

const mocks = vi.hoisted(() => ({
  fullscreen: false,
  isTauri: true,
  setFullscreen: vi.fn(),
  setCursorVisible: vi.fn(),
  listen: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => mocks.isTauri }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    isFullscreen: () => Promise.resolve(mocks.fullscreen),
    setFullscreen: mocks.setFullscreen,
    setCursorVisible: mocks.setCursorVisible,
  }),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }));

const { useDisplayMode, SCREENSAVER_GRACE_MS } = await import("./useDisplayMode");

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

function press(key: string): void {
  act(() => {
    document.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
  });
}

function moveMouse(x: number, y: number): void {
  act(() => {
    document.dispatchEvent(new MouseEvent("mousemove", { clientX: x, clientY: y, bubbles: true }));
  });
}

describe("useDisplayMode", () => {
  let trayHandler: TrayHandler | null;
  let unlisten: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    mocks.fullscreen = false;
    mocks.isTauri = true;
    mocks.setFullscreen.mockReset();
    mocks.setFullscreen.mockImplementation((value: boolean) => {
      mocks.fullscreen = value;
      return Promise.resolve();
    });
    mocks.setCursorVisible.mockReset();
    mocks.setCursorVisible.mockResolvedValue(undefined);
    trayHandler = null;
    unlisten = vi.fn();
    mocks.listen.mockReset();
    mocks.listen.mockImplementation((_name: string, handler: TrayHandler) => {
      trayHandler = handler;
      return Promise.resolve(unlisten);
    });
  });

  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("F11 toggles fullscreen and the state follows the real window", async () => {
    const { result } = renderHook(() => useDisplayMode());
    await settle();
    expect(result.current.fullscreen).toBe(false);

    press("F11");
    await settle();
    expect(mocks.setFullscreen).toHaveBeenLastCalledWith(true);
    expect(result.current.fullscreen).toBe(true);

    press("F11");
    await settle();
    expect(mocks.setFullscreen).toHaveBeenLastCalledWith(false);
    expect(result.current.fullscreen).toBe(false);
  });

  it("Escape leaves fullscreen but does nothing when not fullscreen", async () => {
    const { result } = renderHook(() => useDisplayMode());
    await settle();
    press("Escape");
    await settle();
    expect(mocks.setFullscreen).not.toHaveBeenCalled();

    mocks.fullscreen = true;
    act(() => {
      result.current.toggleFullscreen();
    });
    await settle();
    expect(result.current.fullscreen).toBe(false);
    mocks.setFullscreen.mockClear();

    mocks.fullscreen = true;
    document.dispatchEvent(new Event("fullscreenchange"));
    await settle();
    expect(result.current.fullscreen).toBe(true);
    press("Escape");
    await settle();
    expect(mocks.setFullscreen).toHaveBeenCalledWith(false);
    expect(result.current.fullscreen).toBe(false);
  });

  it("screensaver goes fullscreen with a hidden cursor and ignores input during the grace period", async () => {
    const { result } = renderHook(() => useDisplayMode());
    await settle();
    act(() => {
      result.current.enterScreensaver();
    });
    await settle();
    expect(mocks.setFullscreen).toHaveBeenCalledWith(true);
    expect(mocks.setCursorVisible).toHaveBeenCalledWith(false);
    expect(result.current.screensaver).toBe(true);

    act(() => {
      document.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    press("a");
    expect(result.current.screensaver).toBe(true);
  });

  it("screensaver exits on input after the grace period and restores cursor and window", async () => {
    const { result } = renderHook(() => useDisplayMode());
    await settle();
    act(() => {
      result.current.enterScreensaver();
    });
    await settle();
    await advance(SCREENSAVER_GRACE_MS + 1);
    act(() => {
      document.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    await settle();
    expect(result.current.screensaver).toBe(false);
    expect(mocks.setCursorVisible).toHaveBeenLastCalledWith(true);
    expect(mocks.setFullscreen).toHaveBeenLastCalledWith(false);
    expect(result.current.fullscreen).toBe(false);
  });

  it("screensaver exit keeps the window fullscreen when it was fullscreen before", async () => {
    mocks.fullscreen = true;
    const { result } = renderHook(() => useDisplayMode());
    await settle();
    expect(result.current.fullscreen).toBe(true);
    act(() => {
      result.current.enterScreensaver();
    });
    await settle();
    await advance(SCREENSAVER_GRACE_MS + 1);
    act(() => {
      document.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
    });
    await settle();
    expect(result.current.screensaver).toBe(false);
    expect(mocks.setCursorVisible).toHaveBeenLastCalledWith(true);
    expect(mocks.setFullscreen).toHaveBeenLastCalledWith(true);
    expect(result.current.fullscreen).toBe(true);
  });

  it.each([
    ["keydown", () => new KeyboardEvent("keydown", { key: "x", bubbles: true })],
    ["wheel", () => new Event("wheel", { bubbles: true })],
    ["touchstart", () => new Event("touchstart", { bubbles: true })],
  ])("screensaver exits on %s after the grace period", async (_name, makeEvent) => {
    const { result } = renderHook(() => useDisplayMode());
    await settle();
    act(() => {
      result.current.enterScreensaver();
    });
    await advance(SCREENSAVER_GRACE_MS + 1);
    act(() => {
      document.dispatchEvent(makeEvent());
    });
    expect(result.current.screensaver).toBe(false);
  });

  it("screensaver exits only on mouse travel above 8px, measured after the grace period", async () => {
    const { result } = renderHook(() => useDisplayMode());
    await settle();
    act(() => {
      result.current.enterScreensaver();
    });
    moveMouse(100, 100);
    moveMouse(150, 150); // jitter during the grace period is ignored (and moves the origin)
    expect(result.current.screensaver).toBe(true);
    await advance(SCREENSAVER_GRACE_MS + 1);
    moveMouse(154, 153); // 5px
    expect(result.current.screensaver).toBe(true);
    moveMouse(160, 150); // 10px from the origin
    expect(result.current.screensaver).toBe(false);
  });

  it("removes its document listeners and restores the cursor on unmount", async () => {
    const { result, unmount } = renderHook(() => useDisplayMode());
    await settle();
    act(() => {
      result.current.enterScreensaver();
    });
    await settle();
    mocks.setCursorVisible.mockClear();
    unmount();
    await settle();
    expect(mocks.setCursorVisible).toHaveBeenCalledWith(true);
    mocks.setFullscreen.mockClear();
    press("F11");
    await settle();
    expect(mocks.setFullscreen).not.toHaveBeenCalled();
  });

  it("enters screensaver state on the tray-action event and syncs fullscreen", async () => {
    const { result } = renderHook(() => useDisplayMode());
    await settle();
    expect(mocks.listen).toHaveBeenCalledWith("tray-action", expect.any(Function));

    mocks.fullscreen = true; // Rust already changed the window
    act(() => {
      trayHandler?.({ payload: "toggleFullscreen" });
    });
    await settle();
    expect(result.current.fullscreen).toBe(true);
    expect(result.current.screensaver).toBe(false);

    act(() => {
      trayHandler?.({ payload: "screensaver" });
    });
    expect(result.current.screensaver).toBe(true);

    act(() => {
      trayHandler?.({ payload: "somethingElse" });
      trayHandler?.({ payload: "hidden" });
      trayHandler?.({ payload: "shown" });
    });
    expect(result.current.screensaver).toBe(true);
  });

  it("unlistens on unmount, and immediately when listen() resolves after unmount", async () => {
    const first = renderHook(() => useDisplayMode());
    await settle();
    first.unmount();
    expect(unlisten).toHaveBeenCalledTimes(1);

    let resolveListen: (stop: () => void) => void = () => undefined;
    mocks.listen.mockImplementation(
      () =>
        new Promise<() => void>((resolve) => {
          resolveListen = resolve;
        }),
    );
    const late = vi.fn();
    const second = renderHook(() => useDisplayMode());
    second.unmount();
    expect(late).not.toHaveBeenCalled();
    await act(async () => {
      resolveListen(late);
      await Promise.resolve();
    });
    expect(late).toHaveBeenCalledTimes(1);
  });

  it("falls back to the Fullscreen API outside Tauri and never listens to tray events", async () => {
    mocks.isTauri = false;
    const request = vi.fn(() => Promise.resolve());
    Object.defineProperty(document.documentElement, "requestFullscreen", { value: request, configurable: true });
    const { result } = renderHook(() => useDisplayMode());
    await settle();
    expect(mocks.listen).not.toHaveBeenCalled();
    act(() => {
      result.current.toggleFullscreen();
    });
    await settle();
    expect(request).toHaveBeenCalledTimes(1);
    expect(mocks.setFullscreen).not.toHaveBeenCalled();
  });
});
