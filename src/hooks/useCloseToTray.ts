import { invoke, isTauri } from "@tauri-apps/api/core";
import { useEffect } from "react";
import { errorName, logger } from "../infra/logger";

/**
 * Tells the native side whether the close button hides the window to the tray
 * (docs/DESIGN.md section 36.7). Runs once settings are loaded, then on every change. No-op outside Tauri.
 */
export function useCloseToTray(enabled: boolean, settingsLoaded: boolean): void {
  useEffect(() => {
    if (!settingsLoaded || !isTauri()) return;
    invoke("window_set_close_to_tray", { enabled }).catch((error: unknown) => {
      logger.warn("window.closeToTrayFailed", { error: errorName(error) });
    });
  }, [enabled, settingsLoaded]);
}
