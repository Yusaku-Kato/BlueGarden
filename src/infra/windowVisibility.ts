import { isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { errorName, logger } from "./logger";

const TRAY_ACTION_EVENT = "tray-action";

const MINIMIZED_RECHECK_MS = 1_000;

/**
 * Reports whether the app window is hidden (docs/DESIGN.md section 9.4, ADR-07).
 *
 * `document.visibilityState` alone is not enough: in Tauri on Windows (WebView2) minimizing the
 * window keeps the page "visible" and requestAnimationFrame running. Inside Tauri the window's
 * minimized state is therefore checked on every resize and focus change as well.
 *
 * A window hidden to the system tray (`isVisible() === false`, docs/DESIGN.md §36.7) is hidden too.
 * It produces no resize event on the way back, so it shares the re-check interval of the minimized state.
 *
 * Calls `onChange` only when the combined value changes. Returns an idempotent unsubscribe.
 */
export function watchWindowHidden(onChange: (hidden: boolean) => void): () => void {
  let disposed = false;
  let documentHidden = document.visibilityState === "hidden";
  let minimized = false;
  let trayHidden = false;
  let reported: boolean | null = null;
  let recheckTimer: ReturnType<typeof setInterval> | null = null;
  const unlisteners: (() => void)[] = [];

  const report = (): void => {
    if (disposed) return;
    const hidden = documentHidden || minimized || trayHidden;
    if (hidden === reported) return;
    reported = hidden;
    onChange(hidden);
  };

  const onVisibilityChange = (): void => {
    documentHidden = document.visibilityState === "hidden";
    report();
  };
  document.addEventListener("visibilitychange", onVisibilityChange);
  report();

  if (isTauri()) watchTauriWindowState();

  function watchTauriWindowState(): void {
    const appWindow = getCurrentWindow();
    // On Windows the resize event that accompanies a restore can arrive while isMinimized() still
    // reports true, and no later event follows. While minimized, re-check once per second.
    const updateRecheck = (): void => {
      const needsRecheck = minimized || trayHidden;
      if (needsRecheck && !disposed && recheckTimer === null) {
        recheckTimer = setInterval(refresh, MINIMIZED_RECHECK_MS);
      } else if ((!needsRecheck || disposed) && recheckTimer !== null) {
        clearInterval(recheckTimer);
        recheckTimer = null;
      }
    };
    const refresh = (): void => {
      // A failed isVisible() must not hide the garden: it counts as visible.
      const visible = appWindow.isVisible().catch((error: unknown) => {
        logger.warn("window.isVisibleFailed", { error: errorName(error) });
        return true;
      });
      Promise.all([appWindow.isMinimized(), visible])
        .then(([isMinimized, isVisible]) => {
          minimized = isMinimized;
          trayHidden = !isVisible;
          updateRecheck();
          report();
        })
        .catch((error: unknown) => {
          logger.warn("window.isMinimizedFailed", { error: errorName(error) });
        });
    };
    const keep = (unlisten: () => void): void => {
      if (disposed) unlisten();
      else unlisteners.push(unlisten);
    };
    const onSubscribeFailed = (error: unknown): void => {
      logger.warn("window.listenFailed", { error: errorName(error) });
    };
    appWindow.onResized(refresh).then(keep, onSubscribeFailed);
    appWindow.onFocusChanged(refresh).then(keep, onSubscribeFailed);
    // The tray hides/shows the window without a resize or focus event; Rust announces it.
    listen<unknown>(TRAY_ACTION_EVENT, (event) => {
      if (event.payload === "hidden" || event.payload === "shown") refresh();
    }).then(keep, onSubscribeFailed);
    refresh();
  }

  return () => {
    if (disposed) return;
    disposed = true;
    if (recheckTimer !== null) clearInterval(recheckTimer);
    recheckTimer = null;
    document.removeEventListener("visibilitychange", onVisibilityChange);
    for (const unlisten of unlisteners.splice(0)) unlisten();
  };
}
