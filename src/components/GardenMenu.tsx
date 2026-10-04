import { useEffect, useRef, useState } from "react";

interface GardenMenuProps {
  onLogout: () => void;
  onOpenSettings: () => void;
  onToggleFullscreen: () => void;
  onEnterScreensaver: () => void;
  /** Guests have no account: the logout item returns to the login screen instead. */
  guest: boolean;
  fullscreen: boolean;
}

export default function GardenMenu({
  onLogout,
  onOpenSettings,
  onToggleFullscreen,
  onEnterScreensaver,
  guest,
  fullscreen,
}: GardenMenuProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const closeOnOutsidePointer = (event: PointerEvent): void => {
      if (event.target instanceof Node && containerRef.current?.contains(event.target) === true) return;
      setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    document.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      document.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  return (
    <div className="garden-menu" ref={containerRef}>
      <button
        type="button"
        className="garden-menu-button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="メニュー"
        onClick={() => {
          setOpen((value) => !value);
        }}
      >
        <span aria-hidden="true">⋯</span>
      </button>
      {open ? (
        <div className="garden-menu-list" role="menu">
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onLogout();
            }}
          >
            {guest ? "ログイン画面に戻る" : "ログアウト"}
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onOpenSettings();
            }}
          >
            設定
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onToggleFullscreen();
            }}
          >
            {fullscreen ? "全画面を解除" : "全画面"}
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => {
              setOpen(false);
              onEnterScreensaver();
            }}
          >
            スクリーンセーバー
          </button>
        </div>
      ) : null}
    </div>
  );
}
