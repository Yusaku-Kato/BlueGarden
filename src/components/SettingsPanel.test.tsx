// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SETTINGS } from "../domain/settings";
import SettingsPanel, { clamp, type SettingsPanelProps } from "./SettingsPanel";

function setup() {
  const props: SettingsPanelProps = {
    settings: { ...DEFAULT_SETTINGS, render: { ...DEFAULT_SETTINGS.render, maxPlants: 100 } },
    onChange: vi.fn(),
    onReset: vi.fn(),
    onClose: vi.fn(),
    savedFeeds: [],
    loadingSavedFeeds: false,
    guest: false,
    onResolveFeedInput: vi.fn(() => Promise.resolve("at://x")),
  };
  render(<SettingsPanel {...props} />);
  return props;
}

describe("SettingsPanel", () => {
  afterEach(cleanup);

  it("is a labelled dialog that takes focus and closes on Escape", () => {
    const props = setup();
    const dialog = screen.getByRole("dialog", { name: "設定" });
    expect(document.activeElement).toBe(dialog);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it("emits clamped numeric patches", () => {
    const props = setup();
    fireEvent.change(screen.getByLabelText("最大植物数"), { target: { value: "9999" } });
    expect(props.onChange).toHaveBeenLastCalledWith({ render: { maxPlants: 300 } });
    fireEvent.change(screen.getByLabelText("最大植物数"), { target: { value: "-5" } });
    expect(props.onChange).toHaveBeenLastCalledWith({ render: { maxPlants: 50 } });
    fireEvent.change(screen.getByLabelText("寿命"), { target: { value: "120" } });
    expect(props.onChange).toHaveBeenLastCalledWith({ render: { plantLifetimeMs: 120_000 } });
    fireEvent.change(screen.getByLabelText("アニメーション速度"), { target: { value: "9" } });
    expect(props.onChange).toHaveBeenLastCalledWith({ render: { animationSpeed: 2 } });
  });

  it("shows the default lifetime", () => {
    setup();
    expect(screen.getByText(/既定 180 秒/)).toBeTruthy();
  });

  it("emits renderer, theme, effect and window patches", () => {
    const props = setup();
    fireEvent.click(screen.getByLabelText("3D (試験的)"));
    expect(props.onChange).toHaveBeenLastCalledWith({ renderer: "three3d" });
    fireEvent.change(screen.getByLabelText("テーマ"), { target: { value: "moss" } });
    expect(props.onChange).toHaveBeenLastCalledWith({ render: { theme: "moss" } });
    fireEvent.click(screen.getByLabelText("雨"));
    expect(props.onChange).toHaveBeenLastCalledWith({ render: { effects: { rain: false } } });
    fireEvent.click(screen.getByLabelText("トレイに閉じる"));
    expect(props.onChange).toHaveBeenLastCalledWith({ window: { closeToTray: true } });
  });

  it("requires confirmation before resetting", () => {
    const props = setup();
    fireEvent.click(screen.getByRole("button", { name: "設定をリセット" }));
    expect(props.onReset).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "キャンセル" }));
    expect(props.onReset).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "設定をリセット" }));
    fireEvent.click(screen.getByRole("button", { name: "リセットする" }));
    expect(props.onReset).toHaveBeenCalledTimes(1);
  });
});

describe("clamp", () => {
  it("bounds values and maps NaN to the minimum", () => {
    expect(clamp(5, 0, 2)).toBe(2);
    expect(clamp(-1, 0, 2)).toBe(0);
    expect(clamp(Number.NaN, 0, 2)).toBe(0);
  });
});
