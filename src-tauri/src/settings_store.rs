//! Persists the runtime settings JSON (docs/DESIGN.md 36.1).
//!
//! The file lives in the app config directory. The payload is only checked to be valid JSON and
//! within the size limit; its schema is validated by the front end. Contents are never logged and
//! errors are fixed codes that contain no paths.

use std::fs;
use std::io::Write;
use std::path::PathBuf;
use tauri::Manager;

const FILE_NAME: &str = "settings.json";
const TMP_FILE_NAME: &str = "settings.json.tmp";
/// Must match `SETTINGS.MAX_FILE_BYTES` in src/config/gardenConfig.ts.
const MAX_FILE_BYTES: usize = 16_384;

const ERR_TOO_LARGE: &str = "tooLarge";
const ERR_INVALID_JSON: &str = "invalidJson";
const ERR_IO: &str = "io";

fn config_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map_err(|_| ERR_IO.to_string())
}

/// Returns the stored JSON text, or `None` when no file exists yet.
fn read_settings(dir: &std::path::Path) -> Result<Option<String>, String> {
    let path = dir.join(FILE_NAME);
    let metadata = match fs::metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(ERR_IO.to_string()),
    };
    if metadata.len() > MAX_FILE_BYTES as u64 {
        return Err(ERR_TOO_LARGE.to_string());
    }
    match fs::read_to_string(&path) {
        Ok(text) => Ok(Some(text)),
        Err(_) => Err(ERR_IO.to_string()),
    }
}

fn write_settings(dir: &std::path::Path, json: &str) -> Result<(), String> {
    if json.len() > MAX_FILE_BYTES {
        return Err(ERR_TOO_LARGE.to_string());
    }
    if serde_json::from_str::<serde::de::IgnoredAny>(json).is_err() {
        return Err(ERR_INVALID_JSON.to_string());
    }
    fs::create_dir_all(dir).map_err(|_| ERR_IO.to_string())?;
    let tmp_path = dir.join(TMP_FILE_NAME);
    let final_path = dir.join(FILE_NAME);
    let written = (|| -> std::io::Result<()> {
        let mut file = fs::File::create(&tmp_path)?;
        file.write_all(json.as_bytes())?;
        file.sync_all()?;
        fs::rename(&tmp_path, &final_path)
    })();
    if written.is_err() {
        let _ = fs::remove_file(&tmp_path);
        return Err(ERR_IO.to_string());
    }
    Ok(())
}

#[tauri::command]
pub fn settings_load(app: tauri::AppHandle) -> Result<Option<String>, String> {
    read_settings(&config_dir(&app)?)
}

#[tauri::command]
pub fn settings_save(app: tauri::AppHandle, json: String) -> Result<(), String> {
    write_settings(&config_dir(&app)?, &json)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("bluegarden-settings-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn round_trips_and_creates_the_directory() {
        let dir = temp_dir("roundtrip");
        assert_eq!(read_settings(&dir), Ok(None));
        write_settings(&dir, "{\"version\":1}").unwrap();
        write_settings(&dir, "{\"version\":2}").unwrap();
        assert_eq!(read_settings(&dir), Ok(Some("{\"version\":2}".to_string())));
        assert!(!dir.join(TMP_FILE_NAME).exists());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn rejects_oversized_and_invalid_payloads() {
        let dir = temp_dir("reject");
        let big = format!("\"{}\"", "a".repeat(MAX_FILE_BYTES));
        assert_eq!(write_settings(&dir, &big), Err("tooLarge".to_string()));
        assert_eq!(write_settings(&dir, "{nope"), Err("invalidJson".to_string()));
        assert!(!dir.exists());
    }
}
