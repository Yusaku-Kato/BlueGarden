import { isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { useCallback, useEffect, useRef, useState } from "react";
import { errorName, logger } from "../infra/logger";

/** Screensaver ignores input for this long after it starts (the click that started it, jitter). */
export const SCREENSAVER_GRACE_MS = 500;
/** Mouse travel (px) that ends the screensaver once the grace period is over. */
export const SCREENSAVER_MOVE_THRESHOLD_PX = 8;

const TRAY_EVENT = "tray-action";

type TrayAction = "toggleFullscreen" | "screensaver" | "shown" | "hidden";

function isTrayAction(payload: unknown): payload is TrayAction {
  return (
    payload === "toggleFullscreen" || payload === "screensaver" || payload === "shown" || payload === "hidden"
  );
}

/** Window operations, implemented with Tauri when available and the Fullscreen API otherwise. */
interface DisplayBackend {
  isFullscreen(): Promise<boolean>;
  setFullscreen(fullscreen: boolean): Promise<void>;
  setCursorVisible(visible: boolean): Promise<void>;
}

function createTauriBackend(): DisplayBackend {
  const appWindow = getCurrentWindow();
  return {
    isFullscreen: () => appWindow.isFullscreen(),
    setFullscreen: (fullscreen) => appWindow.setFullscreen(fullscreen),
    setCursorVisible: (visible) => appWindow.setCursorVisible(visible),
  };
}

function createBrowserBackend(): DisplayBackend {
  return {
    isFullscreen: () => Promise.resolve((document.fullscreenElement ?? null) !== null),
    setFullscreen: async (fullscreen) => {
      if (fullscreen) {
        if ((document.fullscreenElement ?? null) === null) await document.documentElement.requestFullscreen();
      } else if ((document.fullscreenElement ?? null) !== null) {
        await document.exitFullscreen();
      }
    },
    // The browser has no cursor API; the screensaver hides it with CSS.
    setCursorVisible: () => Promise.resolve(),
  };
}

function createBackend(): DisplayBackend {
  return isTauri() ? createTauriBackend() : createBrowserBackend();
}

function warn(event: string): (error: unknown) => void {
  return (error) => {
    logger.warn(event, { error: errorName(error) });
  };
}

export interface DisplayModeState {
  readonly fullscreen: boolean;
  /** Fullscreen, no UI, no cursor. Any input (after a short grace period) ends it. */
  readonly screensaver: boolean;
  toggleFullscreen: () => void;
  enterScreensaver: () => void;
  exitScreensaver: () => void;
}

/**
 * Fullscreen (F11 / Esc), screensaver mode and the tray-action event (docs/DESIGN.md sections
 * 36.7, 38). The real window state is always read back instead of being assumed.
 */
export function useDisplayMode(): DisplayModeState {
  const [fullscreen, setFullscreenState] = useState(false);
  const [screensaver, setScreensaver] = useState(false);
  const fullscreenRef = useRef(false);
  const screensaverRef = useRef(false);
  /** Fullscreen state when the screensaver started; restored when it ends. */
  const fullscreenBeforeSaverRef = useRef(false);
  const backendRef = useRef<DisplayBackend | null>(null);
  const disposedRef = useRef(false);

  const backend = useCallback((): DisplayBackend => {
    backendRef.current ??= createBackend();
    return backendRef.current;
  }, []);

  const refreshFullscreen = useCallback((): void => {
    backend()
      .isFullscreen()
      .then((value) => {
        if (disposedRef.current) return;
        fullscreenRef.current = value;
        setFullscreenState(value);
      }, warn("display.isFullscreenFailed"));
  }, [backend]);

  const setScreensaverMode = useCallback((value: boolean): void => {
    if (value && !screensaverRef.current) fullscreenBeforeSaverRef.current = fullscreenRef.current;
    screensaverRef.current = value;
    setScreensaver(value);
  }, []);

  const toggleFullscreen = useCallback((): void => {
    const target = backend();
    target
      .isFullscreen()
      .then((current) => target.setFullscreen(!current))
      .then(refreshFullscreen, warn("display.toggleFailed"));
  }, [backend, refreshFullscreen]);

  const enterScreensaver = useCallback((): void => {
    setScreensaverMode(true);
  }, [setScreensaverMode]);

  const exitScreensaver = useCallback((): void => {
    setScreensaverMode(false);
  }, [setScreensaverMode]);

  // Initial state and external changes (browser Esc, F11 of the browser itself).
  useEffect(() => {
    disposedRef.current = false;
    refreshFullscreen();
    const onChange = (): void => {
      refreshFullscreen();
    };
    document.addEventListener("fullscreenchange", onChange);
    return () => {
      disposedRef.current = true;
      document.removeEventListener("fullscreenchange", onChange);
    };
  }, [refreshFullscreen]);

  // F11 toggles, Esc leaves fullscreen. Screensaver mode handles its own keys.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (screensaverRef.current) return;
      if (event.key === "F11") {
        event.preventDefault();
        toggleFullscreen();
      } else if (event.key === "Escape" && fullscreenRef.current) {
        backend().setFullscreen(false).then(refreshFullscreen, warn("display.exitFullscreenFailed"));
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [backend, refreshFullscreen, toggleFullscreen]);

  // Screensaver: fullscreen + hidden cursor while active. The cursor (owned here, never by Rust) and
  // the fullscreen state from before entry are restored in the cleanup.
  useEffect(() => {
    if (!screensaver) return;
    const target = backend();
    const restoreFullscreen = fullscreenBeforeSaverRef.current;
    let armed = false;
    let origin: { x: number; y: number } | null = null;

    target
      .setFullscreen(true)
      .then(() => target.setCursorVisible(false))
      .then(refreshFullscreen, warn("display.screensaverEnterFailed"));

    const graceTimer = setTimeout(() => {
      armed = true;
    }, SCREENSAVER_GRACE_MS);

    const leave = (): void => {
      if (armed) setScreensaverMode(false);
    };
    const onMouseMove = (event: MouseEvent): void => {
      if (!armed || origin === null) {
        origin = { x: event.clientX, y: event.clientY }; // jitter during the grace period is free
        return;
      }
      if (Math.hypot(event.clientX - origin.x, event.clientY - origin.y) > SCREENSAVER_MOVE_THRESHOLD_PX) leave();
    };
    const inputEvents = ["keydown", "mousedown", "wheel", "touchstart"] as const;
    for (const name of inputEvents) document.addEventListener(name, leave);
    document.addEventListener("mousemove", onMouseMove);

    return () => {
      clearTimeout(graceTimer);
      for (const name of inputEvents) document.removeEventListener(name, leave);
      document.removeEventListener("mousemove", onMouseMove);
      target
        .setCursorVisible(true)
        .then(() => target.setFullscreen(restoreFullscreen))
        .then(refreshFullscreen, warn("display.screensaverExitFailed"));
    };
  }, [screensaver, backend, refreshFullscreen, setScreensaverMode]);

  // Tray events. listen() resolves asynchronously: unlisten right away if we unmounted meanwhile.
  useEffect(() => {
    if (!isTauri()) return;
    let disposed = false;
    let unlisten: (() => void) | null = null;

    listen<unknown>(TRAY_EVENT, (event) => {
      if (disposed || !isTrayAction(event.payload)) return;
      if (event.payload === "screensaver") setScreensaverMode(true);
      refreshFullscreen(); // Rust already changed the window; just sync the UI state
    }).then(
      (stop) => {
        if (disposed) stop();
        else unlisten = stop;
      },
      warn("display.listenFailed"),
    );

    return () => {
      disposed = true;
      unlisten?.();
      unlisten = null;
    };
  }, [refreshFullscreen, setScreensaverMode]);

  return { fullscreen, screensaver, toggleFullscreen, enterScreensaver, exitScreensaver };
}
