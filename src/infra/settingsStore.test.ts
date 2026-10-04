import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../domain/settings";

const tauri = vi.hoisted(() => ({
  inTauri: false,
  invoke: vi.fn<(command: string, args?: unknown) => Promise<unknown>>(),
}));
const logged = vi.hoisted(() => ({ warn: vi.fn<(event: string, fields?: unknown) => void>() }));

vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => tauri.inTauri,
  invoke: (command: string, args?: unknown) => tauri.invoke(command, args),
}));
vi.mock("./logger", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./logger")>();
  return { ...actual, logger: { ...actual.logger, warn: logged.warn } };
});

const { loadSettingsRaw, saveSettings } = await import("./settingsStore");

const SETTINGS = DEFAULT_SETTINGS;
const OTHER_SETTINGS = { ...DEFAULT_SETTINGS, renderer: "three3d" as const };

beforeEach(() => {
  tauri.inTauri = false;
  tauri.invoke.mockReset();
  logged.warn.mockReset();
});

describe("settingsStore (Tauri)", () => {
  beforeEach(() => {
    tauri.inTauri = true;
  });

  it("returns null and logs parseFailed when the stored text is not JSON", async () => {
    tauri.invoke.mockResolvedValueOnce("{ not json");
    expect(await loadSettingsRaw()).toBeNull();
    expect(logged.warn).toHaveBeenCalledWith("settings.parseFailed", expect.anything());
  });

  it("returns null when nothing is stored", async () => {
    tauri.invoke.mockResolvedValueOnce(null);
    expect(await loadSettingsRaw()).toBeNull();
    expect(logged.warn).not.toHaveBeenCalled();
  });

  it("parses stored JSON", async () => {
    tauri.invoke.mockResolvedValueOnce('{"a":1}');
    expect(await loadSettingsRaw()).toEqual({ a: 1 });
  });

  it("maps a known command error code and never rejects", async () => {
    tauri.invoke.mockRejectedValueOnce("tooLarge");
    expect(await loadSettingsRaw()).toBeNull();
    expect(logged.warn).toHaveBeenCalledWith("settings.loadFailed", { reason: "tooLarge" });
  });

  it("maps an unknown error code (or non-string error) to unknown", async () => {
    tauri.invoke.mockRejectedValueOnce("surprise: unexpected text");
    expect(await loadSettingsRaw()).toBeNull();
    expect(logged.warn).toHaveBeenLastCalledWith("settings.loadFailed", { reason: "unknown" });

    tauri.invoke.mockRejectedValueOnce(new Error("boom"));
    expect(await loadSettingsRaw()).toBeNull();
    expect(logged.warn).toHaveBeenLastCalledWith("settings.loadFailed", { reason: "unknown" });
  });

  it("save passes the JSON to settings_save and swallows failures with a mapped code", async () => {
    tauri.invoke.mockResolvedValueOnce(undefined);
    await saveSettings(SETTINGS);
    expect(tauri.invoke).toHaveBeenCalledWith("settings_save", { json: JSON.stringify(SETTINGS) });

    tauri.invoke.mockRejectedValueOnce("io");
    await expect(saveSettings(SETTINGS)).resolves.toBeUndefined();
    expect(logged.warn).toHaveBeenLastCalledWith("settings.saveFailed", { reason: "io" });
  });
});

describe("settingsStore (not Tauri)", () => {
  it("keeps the last saved value for the session only and never calls Tauri", async () => {
    await saveSettings(SETTINGS);
    expect(await loadSettingsRaw()).toEqual(SETTINGS);
    await saveSettings(OTHER_SETTINGS);
    expect(await loadSettingsRaw()).toEqual(OTHER_SETTINGS);
    expect(tauri.invoke).not.toHaveBeenCalled();
  });
});
