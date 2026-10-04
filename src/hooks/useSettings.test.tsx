// @vitest-environment happy-dom
import { act, cleanup, renderHook } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SETTINGS } from "../config/gardenConfig";
import { DEFAULT_SETTINGS } from "../domain/settings";

const mocks = vi.hoisted(() => ({
  loadSettingsRaw: vi.fn(),
  saveSettings: vi.fn(),
}));

vi.mock("../infra/settingsStore", () => mocks);

const { useSettings } = await import("./useSettings");

async function flushLoad(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

describe("useSettings", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.loadSettingsRaw.mockReset();
    mocks.saveSettings.mockReset();
    mocks.loadSettingsRaw.mockResolvedValue(null);
    mocks.saveSettings.mockResolvedValue(undefined);
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("starts with defaults and reports loaded after reading", async () => {
    const { result } = renderHook(() => useSettings());
    expect(result.current.loaded).toBe(false);
    expect(result.current.settings).toEqual(DEFAULT_SETTINGS);
    await flushLoad();
    expect(result.current.loaded).toBe(true);
    expect(result.current.settings).toEqual(DEFAULT_SETTINGS);
  });

  it("validates stored values through parseRuntimeSettings", async () => {
    mocks.loadSettingsRaw.mockResolvedValue({
      version: 1,
      render: { maxPlants: 9999, theme: "moss" },
    });
    const { result } = renderHook(() => useSettings());
    await flushLoad();
    expect(result.current.settings.render.theme).toBe("moss");
    expect(result.current.settings.render.maxPlants).toBe(SETTINGS.MAX_PLANTS.MAX);
  });

  it("falls back to defaults for garbage", async () => {
    mocks.loadSettingsRaw.mockResolvedValue("nonsense");
    const { result } = renderHook(() => useSettings());
    await flushLoad();
    expect(result.current.settings).toEqual(DEFAULT_SETTINGS);
  });

  it("merges nested patches and debounces to a single save", async () => {
    const { result } = renderHook(() => useSettings());
    await flushLoad();
    act(() => {
      result.current.update({ render: { maxPlants: 100 } });
      result.current.update({ render: { effects: { rain: false } } });
      result.current.update({ renderer: "three3d" });
    });
    expect(result.current.settings.render.maxPlants).toBe(100);
    expect(result.current.settings.render.effects.rain).toBe(false);
    expect(result.current.settings.render.effects.fog).toBe(true);
    expect(result.current.settings.renderer).toBe("three3d");
    expect(mocks.saveSettings).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SETTINGS.SAVE_DEBOUNCE_MS);
    });
    expect(mocks.saveSettings).toHaveBeenCalledTimes(1);
    expect(mocks.saveSettings).toHaveBeenCalledWith(result.current.settings);
  });

  it("reset restores defaults and saves them", async () => {
    const { result } = renderHook(() => useSettings());
    await flushLoad();
    act(() => {
      result.current.update({ render: { maxPlants: 100 } });
      result.current.reset();
    });
    expect(result.current.settings).toEqual(DEFAULT_SETTINGS);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SETTINGS.SAVE_DEBOUNCE_MS);
    });
    expect(mocks.saveSettings).toHaveBeenCalledTimes(1);
    expect(mocks.saveSettings).toHaveBeenCalledWith(DEFAULT_SETTINGS);
  });

  it("reset with keepFeed restores everything except the saved feed", async () => {
    const { result } = renderHook(() => useSettings());
    await flushLoad();
    act(() => {
      result.current.update({ feed: { kind: "global" }, render: { maxPlants: 100 } });
    });
    act(() => {
      result.current.reset({ keepFeed: true });
    });
    expect(result.current.settings).toEqual({ ...DEFAULT_SETTINGS, feed: { kind: "global" } });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SETTINGS.SAVE_DEBOUNCE_MS);
    });
    expect(mocks.saveSettings).toHaveBeenLastCalledWith({ ...DEFAULT_SETTINGS, feed: { kind: "global" } });
  });

  it("flushes a pending save on unmount and leaves no timer", async () => {
    const { result, unmount } = renderHook(() => useSettings());
    await flushLoad();
    act(() => {
      result.current.update({ render: { windIntensity: 0.5 } });
    });
    unmount();
    expect(mocks.saveSettings).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(SETTINGS.SAVE_DEBOUNCE_MS * 2);
    expect(mocks.saveSettings).toHaveBeenCalledTimes(1);
  });

  it("does not save when nothing changed", async () => {
    const { unmount } = renderHook(() => useSettings());
    await flushLoad();
    unmount();
    expect(mocks.saveSettings).not.toHaveBeenCalled();
  });

  it("survives the StrictMode double mount", async () => {
    const { result, unmount } = renderHook(() => useSettings(), { wrapper: StrictMode });
    await flushLoad();
    expect(result.current.loaded).toBe(true);
    act(() => {
      result.current.update({ render: { theme: "dawn" } });
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(SETTINGS.SAVE_DEBOUNCE_MS);
    });
    expect(mocks.saveSettings).toHaveBeenCalledTimes(1);
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });
});
