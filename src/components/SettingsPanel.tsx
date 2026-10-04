import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { SETTINGS } from "../config/gardenConfig";
import type { EffectToggles, GardenTheme, RendererKind, RuntimeSettings } from "../domain/models";
import type { RuntimeSettingsPatch } from "../domain/settings";
import FeedSelector, { type FeedSelectorProps } from "./FeedSelector";

export interface SettingsPanelProps {
  settings: RuntimeSettings;
  onChange: (patch: RuntimeSettingsPatch) => void;
  onReset: () => void;
  onClose: () => void;
  savedFeeds: FeedSelectorProps["savedFeeds"];
  loadingSavedFeeds: boolean;
  guest: boolean;
  onResolveFeedInput: FeedSelectorProps["onResolveFeedInput"];
}

const THEMES: readonly { value: GardenTheme; label: string }[] = [
  { value: "twilight", label: "黄昏 (Twilight)" },
  { value: "dawn", label: "夜明け (Dawn)" },
  { value: "moss", label: "苔 (Moss)" },
  { value: "nocturne", label: "夜想曲 (Nocturne)" },
];

const EFFECTS: readonly { key: keyof EffectToggles; label: string }[] = [
  { key: "lightParticles", label: "光の粒" },
  { key: "rain", label: "雨" },
  { key: "wind", label: "風" },
  { key: "fog", label: "霧" },
  { key: "fireflies", label: "蛍" },
  { key: "bloom", label: "Bloom" },
  { key: "dayNightCycle", label: "昼夜" },
  { key: "climate", label: "気候" },
];

const RENDERERS: readonly { value: RendererKind; label: string }[] = [
  { value: "pixi2d", label: "2D" },
  { value: "three3d", label: "3D (試験的)" },
];

export function clamp(value: number, min: number, max: number): number {
  if (Number.isNaN(value)) return min;
  return Math.min(max, Math.max(min, value));
}

const FOCUSABLE = "button:not(:disabled), input:not(:disabled), select:not(:disabled)";

export default function SettingsPanel({
  settings,
  onChange,
  onReset,
  onClose,
  savedFeeds,
  loadingSavedFeeds,
  guest,
  onResolveFeedInput,
}: SettingsPanelProps) {
  const titleId = useId();
  const rendererName = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const [confirmingReset, setConfirmingReset] = useState(false);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);
  const { render } = settings;

  // Focus moves into the panel on open and back to the opener on close; Esc closes; Tab stays inside.
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    panelRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab" || panelRef.current === null) return;
      const items = Array.from(panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE));
      const first = items[0];
      const last = items[items.length - 1];
      if (first === undefined || last === undefined) return;
      if (event.shiftKey && (document.activeElement === first || document.activeElement === panelRef.current)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      opener?.focus();
    };
  }, []);

  const lifetimeSeconds = Math.round(render.plantLifetimeMs / 1000);
  const defaultLifetimeSeconds = SETTINGS.PLANT_LIFETIME_MS.DEFAULT / 1000;

  return (
    <div className="settings-overlay">
      <div
        className="settings-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        ref={panelRef}
      >
        <header className="settings-header">
          <h2 id={titleId}>設定</h2>
          <button type="button" className="settings-close" aria-label="閉じる" onClick={onClose}>
            <span aria-hidden="true">×</span>
          </button>
        </header>

        <div className="settings-body">
          <FeedSelector
            value={settings.feed}
            savedFeeds={savedFeeds}
            loadingSavedFeeds={loadingSavedFeeds}
            guest={guest}
            onChange={(feed) => {
              onChange({ feed });
            }}
            onResolveFeedInput={onResolveFeedInput}
          />

          <fieldset className="settings-group">
            <legend>レンダラー</legend>
            {RENDERERS.map((option) => (
              <label className="feed-option" key={option.value}>
                <input
                  type="radio"
                  name={rendererName}
                  checked={settings.renderer === option.value}
                  onChange={() => {
                    onChange({ renderer: option.value });
                  }}
                />
                <span>{option.label}</span>
              </label>
            ))}
          </fieldset>

          <fieldset className="settings-group">
            <legend>植物</legend>
            <RangeField
              label="最大植物数"
              value={render.maxPlants}
              min={SETTINGS.MAX_PLANTS.MIN}
              max={SETTINGS.MAX_PLANTS.MAX}
              step={10}
              display={String(render.maxPlants)}
              onValue={(maxPlants) => {
                onChange({ render: { maxPlants } });
              }}
            />
            <RangeField
              label="寿命"
              value={lifetimeSeconds}
              min={SETTINGS.PLANT_LIFETIME_MS.MIN / 1000}
              max={SETTINGS.PLANT_LIFETIME_MS.MAX / 1000}
              step={10}
              display={`${String(lifetimeSeconds)} 秒 (既定 ${String(defaultLifetimeSeconds)} 秒)`}
              onValue={(seconds) => {
                onChange({ render: { plantLifetimeMs: seconds * 1000 } });
              }}
            />
            <p className="settings-hint">寿命は新しく生える植物から反映されます。</p>
          </fieldset>

          <fieldset className="settings-group">
            <legend>動き</legend>
            <RangeField
              label="アニメーション速度"
              value={render.animationSpeed}
              min={SETTINGS.ANIMATION_SPEED.MIN}
              max={SETTINGS.ANIMATION_SPEED.MAX}
              step={0.1}
              display={`×${render.animationSpeed.toFixed(1)}`}
              onValue={(animationSpeed) => {
                onChange({ render: { animationSpeed } });
              }}
            />
            <RangeField
              label="粒子の強さ"
              value={render.particleIntensity}
              min={SETTINGS.PARTICLE_INTENSITY.MIN}
              max={SETTINGS.PARTICLE_INTENSITY.MAX}
              step={0.1}
              display={`×${render.particleIntensity.toFixed(1)}`}
              onValue={(particleIntensity) => {
                onChange({ render: { particleIntensity } });
              }}
            />
            <RangeField
              label="風の強さ"
              value={render.windIntensity}
              min={SETTINGS.WIND_INTENSITY.MIN}
              max={SETTINGS.WIND_INTENSITY.MAX}
              step={0.1}
              display={`×${render.windIntensity.toFixed(1)}`}
              onValue={(windIntensity) => {
                onChange({ render: { windIntensity } });
              }}
            />
          </fieldset>

          <fieldset className="settings-group">
            <legend>テーマ</legend>
            <select
              aria-label="テーマ"
              value={render.theme}
              onChange={(event) => {
                const theme = THEMES.find((option) => option.value === event.target.value);
                if (theme !== undefined) onChange({ render: { theme: theme.value } });
              }}
            >
              {THEMES.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </fieldset>

          <fieldset className="settings-group">
            <legend>エフェクト</legend>
            <div className="settings-toggles">
              {EFFECTS.map((effect) => (
                <label className="feed-option" key={effect.key}>
                  <input
                    type="checkbox"
                    checked={render.effects[effect.key]}
                    onChange={(event) => {
                      onChange({ render: { effects: { [effect.key]: event.target.checked } } });
                    }}
                  />
                  <span>{effect.label}</span>
                </label>
              ))}
            </div>
          </fieldset>

          <fieldset className="settings-group">
            <legend>ウィンドウ</legend>
            <label className="feed-option">
              <input
                type="checkbox"
                checked={settings.window.closeToTray}
                onChange={(event) => {
                  onChange({ window: { closeToTray: event.target.checked } });
                }}
              />
              <span>トレイに閉じる</span>
            </label>
          </fieldset>
        </div>

        <footer className="settings-footer">
          {confirmingReset ? (
            <div className="settings-confirm" role="group" aria-label="リセットの確認">
              <span>すべての設定を初期値に戻しますか？</span>
              <button
                type="button"
                onClick={() => {
                  setConfirmingReset(false);
                  onReset();
                }}
              >
                リセットする
              </button>
              <button
                type="button"
                onClick={() => {
                  setConfirmingReset(false);
                }}
              >
                キャンセル
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => {
                setConfirmingReset(true);
              }}
            >
              設定をリセット
            </button>
          )}
        </footer>
      </div>
    </div>
  );
}

interface RangeFieldProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  display: ReactNode;
  onValue: (value: number) => void;
}

function RangeField({ label, value, min, max, step, display, onValue }: RangeFieldProps) {
  const id = useId();
  return (
    <div className="settings-range">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => {
          onValue(clamp(Number(event.target.value), min, max));
        }}
      />
      <output htmlFor={id}>{display}</output>
    </div>
  );
}
