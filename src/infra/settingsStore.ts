import { invoke, isTauri } from "@tauri-apps/api/core";
import type { RuntimeSettings } from "../domain/models";
import { errorName, logger } from "./logger";

/**
 * Persistence of the runtime settings (docs/DESIGN.md 36.1).
 *
 * Inside Tauri the Rust commands `settings_load` / `settings_save` own the file. In a plain
 * browser (vite dev) nothing is persisted; the last saved value is only kept for the session.
 * Neither function rejects: failures are logged with fixed codes and reported as null / void.
 * The settings file never holds secrets.
 */

let sessionValue: string | null = null;

export async function loadSettingsRaw(): Promise<unknown> {
  let text: string | null;
  if (isTauri()) {
    try {
      text = await invoke<string | null>("settings_load");
    } catch (error: unknown) {
      logger.warn("settings.loadFailed", { reason: commandErrorCode(error) });
      return null;
    }
  } else {
    text = sessionValue;
  }
  if (text === null) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch (error: unknown) {
    logger.warn("settings.parseFailed", { error: errorName(error) });
    return null;
  }
}

export async function saveSettings(settings: RuntimeSettings): Promise<void> {
  const json = JSON.stringify(settings);
  if (!isTauri()) {
    sessionValue = json;
    return;
  }
  try {
    await invoke("settings_save", { json });
  } catch (error: unknown) {
    logger.warn("settings.saveFailed", { reason: commandErrorCode(error) });
  }
}

const KNOWN_CODES: readonly string[] = ["tooLarge", "invalidJson", "io"];

function commandErrorCode(error: unknown): string {
  return typeof error === "string" && KNOWN_CODES.includes(error) ? error : "unknown";
}
