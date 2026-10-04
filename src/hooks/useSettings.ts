import { useCallback, useEffect, useRef, useState } from "react";
import { SETTINGS } from "../config/gardenConfig";
import type { RuntimeSettings } from "../domain/models";
import { DEFAULT_SETTINGS, mergeSettings, parseRuntimeSettings, type RuntimeSettingsPatch } from "../domain/settings";
import { loadSettingsRaw, saveSettings } from "../infra/settingsStore";

export interface UseSettingsResult {
  readonly settings: RuntimeSettings;
  /** True once the stored settings have been read (or found missing / invalid). */
  readonly loaded: boolean;
  update: (patch: RuntimeSettingsPatch) => void;
  /** Restores defaults; `keepFeed` preserves the saved feed target (guests never change it). */
  reset: (options?: { readonly keepFeed?: boolean }) => void;
}

export function useSettings(): UseSettingsResult {
  const [settings, setSettings] = useState<RuntimeSettings>(DEFAULT_SETTINGS);
  const [loaded, setLoaded] = useState(false);
  const latest = useRef<RuntimeSettings>(DEFAULT_SETTINGS);
  const dirty = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flush = useCallback((): void => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    if (!dirty.current) return;
    dirty.current = false;
    void saveSettings(latest.current);
  }, []);

  const commit = useCallback(
    (next: RuntimeSettings): void => {
      latest.current = next;
      dirty.current = true;
      setSettings(next);
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = setTimeout(flush, SETTINGS.SAVE_DEBOUNCE_MS);
    },
    [flush],
  );

  useEffect(() => {
    let cancelled = false;
    void loadSettingsRaw().then((raw) => {
      if (cancelled) return;
      // A change made before the file was read wins over the stored value.
      if (!dirty.current) {
        const parsed = parseRuntimeSettings(raw);
        latest.current = parsed;
        setSettings(parsed);
      }
      setLoaded(true);
    });
    return () => {
      cancelled = true;
      flush();
    };
  }, [flush]);

  const update = useCallback(
    (patch: RuntimeSettingsPatch): void => {
      commit(mergeSettings(latest.current, patch));
    },
    [commit],
  );

  const reset = useCallback(
    (options?: { readonly keepFeed?: boolean }): void => {
      commit(options?.keepFeed === true ? { ...DEFAULT_SETTINGS, feed: latest.current.feed } : DEFAULT_SETTINGS);
    },
    [commit],
  );

  return { settings, loaded, update, reset };
}
