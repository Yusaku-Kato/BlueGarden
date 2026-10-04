mod secure_store;
mod settings_store;
mod tray;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_oauth::init())
        .manage(tray::CloseToTray::default())
        .setup(|app| {
            tray::setup_optional(app.handle());
            Ok(())
        })
        .on_window_event(tray::on_window_event)
        .invoke_handler(tauri::generate_handler![
            settings_store::settings_load,
            settings_store::settings_save,
            secure_store::secret_get,
            secure_store::secret_set,
            secure_store::secret_delete,
            tray::window_set_close_to_tray
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
