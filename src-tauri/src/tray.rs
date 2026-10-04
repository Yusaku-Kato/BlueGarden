//! System tray and close-to-tray behaviour (docs/DESIGN.md 36.7).
//!
//! Window changes are performed here; the `tray-action` event only tells the front end so it can
//! sync its own state. Payloads: "toggleFullscreen" | "screensaver" | "shown" | "hidden".

use std::sync::atomic::{AtomicBool, Ordering};
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow, Window, WindowEvent};

const MAIN_WINDOW: &str = "main";
const TRAY_EVENT: &str = "tray-action";

/// Close-to-tray state: whether the user enabled it and whether a tray icon actually exists.
/// Without a tray, hiding the window would make it unrecoverable, so the setting is ignored.
#[derive(Default)]
pub struct CloseToTray {
    enabled: AtomicBool,
    tray_available: AtomicBool,
}

/// Pure close decision: hide to the tray only when enabled and a tray exists.
fn should_hide_on_close(enabled: bool, tray_available: bool) -> bool {
    enabled && tray_available
}

fn main_window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window(MAIN_WINDOW)
}

fn emit_action(app: &AppHandle, action: &str) {
    let _ = app.emit(TRAY_EVENT, action);
}

fn show_window(app: &AppHandle) {
    if let Some(window) = main_window(app) {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_focus();
        emit_action(app, "shown");
    }
}

fn hide_window(app: &AppHandle) {
    if let Some(window) = main_window(app) {
        let _ = window.hide();
        emit_action(app, "hidden");
    }
}

fn toggle_visible(app: &AppHandle) {
    let Some(window) = main_window(app) else {
        return;
    };
    let visible = window.is_visible().unwrap_or(true);
    let minimized = window.is_minimized().unwrap_or(false);
    if visible && !minimized {
        hide_window(app);
    } else {
        show_window(app);
    }
}

fn toggle_fullscreen(app: &AppHandle) {
    if let Some(window) = main_window(app) {
        let fullscreen = window.is_fullscreen().unwrap_or(false);
        let _ = window.show();
        let _ = window.set_fullscreen(!fullscreen);
        emit_action(app, "toggleFullscreen");
    }
}

fn start_screensaver(app: &AppHandle) {
    if let Some(window) = main_window(app) {
        let _ = window.show();
        let _ = window.unminimize();
        let _ = window.set_fullscreen(true);
        let _ = window.set_focus();
        emit_action(app, "screensaver");
    }
}

/// Builds the tray; on failure logs a fixed message and continues without it.
pub fn setup_optional(app: &AppHandle) {
    match setup(app) {
        Ok(()) => app
            .state::<CloseToTray>()
            .tray_available
            .store(true, Ordering::Relaxed),
        Err(_) => eprintln!("tray unavailable; close-to-tray disabled"),
    }
}

fn setup(app: &AppHandle) -> tauri::Result<()> {
    let toggle = MenuItem::with_id(app, "toggleVisible", "表示/非表示", true, None::<&str>)?;
    let fullscreen = MenuItem::with_id(app, "toggleFullscreen", "全画面", true, None::<&str>)?;
    let saver = MenuItem::with_id(app, "screensaver", "スクリーンセーバー", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", "終了", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&toggle, &fullscreen, &saver, &separator, &quit])?;

    let mut builder = TrayIconBuilder::with_id("main")
        .tooltip("BlueGarden")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "toggleVisible" => toggle_visible(app),
            "toggleFullscreen" => toggle_fullscreen(app),
            "screensaver" => start_screensaver(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                toggle_visible(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }
    builder.build(app)?;
    Ok(())
}

pub fn on_window_event(window: &Window, event: &WindowEvent) {
    if window.label() != MAIN_WINDOW {
        return;
    }
    if let WindowEvent::CloseRequested { api, .. } = event {
        let state = window.app_handle().state::<CloseToTray>();
        let enabled = state.enabled.load(Ordering::Relaxed);
        let tray_available = state.tray_available.load(Ordering::Relaxed);
        if should_hide_on_close(enabled, tray_available) {
            api.prevent_close();
            let _ = window.hide();
            emit_action(window.app_handle(), "hidden");
        }
    }
}

#[tauri::command]
pub fn window_set_close_to_tray(enabled: bool, state: State<'_, CloseToTray>) -> bool {
    state.enabled.store(enabled, Ordering::Relaxed);
    should_hide_on_close(enabled, state.tray_available.load(Ordering::Relaxed))
}

#[cfg(test)]
mod tests {
    use super::should_hide_on_close;

    #[test]
    fn hides_only_when_enabled_and_tray_exists() {
        assert!(should_hide_on_close(true, true));
        assert!(!should_hide_on_close(true, false));
        assert!(!should_hide_on_close(false, true));
        assert!(!should_hide_on_close(false, false));
    }
}
