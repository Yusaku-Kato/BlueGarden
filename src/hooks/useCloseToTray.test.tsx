// @vitest-environment happy-dom
import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(), isTauri: true }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke, isTauri: () => mocks.isTauri }));

const { useCloseToTray } = await import("./useCloseToTray");

describe("useCloseToTray", () => {
  beforeEach(() => {
    mocks.invoke.mockReset();
    mocks.invoke.mockResolvedValue(true);
    mocks.isTauri = true;
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("does not invoke before settings are loaded, then invokes once they are", () => {
    const { rerender } = renderHook(
      (props: { loaded: boolean }) => {
        useCloseToTray(true, props.loaded);
      },
      {
        initialProps: { loaded: false },
      },
    );
    expect(mocks.invoke).not.toHaveBeenCalled();
    rerender({ loaded: true });
    expect(mocks.invoke).toHaveBeenCalledWith("window_set_close_to_tray", { enabled: true });
  });

  it("invokes again when the setting changes", () => {
    const { rerender } = renderHook(
      (props: { enabled: boolean }) => {
        useCloseToTray(props.enabled, true);
      },
      {
        initialProps: { enabled: false },
      },
    );
    rerender({ enabled: true });
    expect(mocks.invoke.mock.calls.map((call) => (call[1] as { enabled: boolean }).enabled)).toEqual([false, true]);
  });

  it("does nothing outside Tauri", () => {
    mocks.isTauri = false;
    renderHook(() => {
      useCloseToTray(true, true);
    });
    expect(mocks.invoke).not.toHaveBeenCalled();
  });

  it("swallows invoke failures", async () => {
    mocks.invoke.mockRejectedValue(new Error("boom"));
    expect(() =>
      renderHook(() => {
        useCloseToTray(true, true);
      }),
    ).not.toThrow();
    await Promise.resolve();
    await Promise.resolve();
    expect(mocks.invoke).toHaveBeenCalledTimes(1);
  });
});
