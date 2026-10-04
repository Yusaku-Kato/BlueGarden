//! Secret storage backed by the OS credential store (docs/DESIGN.md 35.7, 36.4).
//!
//! Values are split into chunks because Windows Credential Manager limits a credential blob to
//! roughly 2.5 KB (1000 UTF-16 units = 2000 bytes). Neither keys nor values are ever logged;
//! errors are fixed codes.
//!
//! Layout: chunks live at "<key>#g<generation>#<index>" and "<key>#count" holds
//! "<generation>:<count>". A write goes to a new generation and flips the count last, so a
//! failed write leaves the previous value readable.

use keyring::Entry;

const SERVICE: &str = "app.bluegarden.desktop";
const ALLOWED_KEYS: [&str; 2] = ["session.appPassword", "session.oauth"];
const MAX_VALUE_BYTES: usize = 16_384;
const CHUNK_UTF16_UNITS: usize = 1000;

const ERR_INVALID_KEY: &str = "invalidKey";
const ERR_TOO_LARGE: &str = "tooLarge";
const ERR_UNAVAILABLE: &str = "unavailable";

/// Minimal credential backend so the chunking logic can be tested without an OS store.
trait Backend {
    fn get(&self, account: &str) -> Result<Option<String>, ()>;
    fn set(&self, account: &str, value: &str) -> Result<(), ()>;
    /// Deleting a missing account is not an error.
    fn delete(&self, account: &str) -> Result<(), ()>;
}

struct KeyringBackend;

impl KeyringBackend {
    fn entry(account: &str) -> Result<Entry, ()> {
        Entry::new(SERVICE, account).map_err(|_| ())
    }
}

impl Backend for KeyringBackend {
    fn get(&self, account: &str) -> Result<Option<String>, ()> {
        match Self::entry(account)?.get_password() {
            Ok(value) => Ok(Some(value)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(_) => Err(()),
        }
    }

    fn set(&self, account: &str, value: &str) -> Result<(), ()> {
        Self::entry(account)?.set_password(value).map_err(|_| ())
    }

    fn delete(&self, account: &str) -> Result<(), ()> {
        match Self::entry(account)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err(()),
        }
    }
}

fn validate_key(key: &str) -> Result<(), String> {
    if ALLOWED_KEYS.contains(&key) {
        Ok(())
    } else {
        Err(ERR_INVALID_KEY.to_string())
    }
}

fn chunk_account(key: &str, generation: u64, index: usize) -> String {
    format!("{key}#g{generation}#{index}")
}

fn count_account(key: &str) -> String {
    format!("{key}#count")
}

/// Splits into pieces of at most `CHUNK_UTF16_UNITS` UTF-16 code units, never inside a
/// character (so never inside a surrogate pair).
fn split_chunks(value: &str) -> Vec<String> {
    let mut chunks = Vec::new();
    let mut current = String::new();
    let mut units = 0;
    for ch in value.chars() {
        let width = ch.len_utf16();
        if units + width > CHUNK_UTF16_UNITS {
            chunks.push(std::mem::take(&mut current));
            units = 0;
        }
        current.push(ch);
        units += width;
    }
    if !current.is_empty() {
        chunks.push(current);
    }
    chunks
}

/// Generation and chunk count of the committed value. A corrupt record is treated as absent.
fn read_meta<B: Backend>(backend: &B, key: &str) -> Result<Option<(u64, usize)>, ()> {
    Ok(backend.get(&count_account(key))?.and_then(|text| {
        let (generation, count) = text.split_once(':')?;
        Some((generation.parse().ok()?, count.parse().ok()?))
    }))
}

fn delete_generation<B: Backend>(
    backend: &B,
    key: &str,
    generation: u64,
    count: usize,
) -> Result<(), ()> {
    for index in 0..count {
        backend.delete(&chunk_account(key, generation, index))?;
    }
    Ok(())
}

fn delete_all<B: Backend>(backend: &B, key: &str) -> Result<(), ()> {
    let meta = read_meta(backend, key)?;
    // Remove the count first so a partial delete never looks like a valid value.
    backend.delete(&count_account(key))?;
    if let Some((generation, count)) = meta {
        delete_generation(backend, key, generation, count)?;
    }
    Ok(())
}

fn store_get<B: Backend>(backend: &B, key: &str) -> Result<Option<String>, ()> {
    let Some((generation, count)) = read_meta(backend, key)? else {
        return Ok(None);
    };
    let mut value = String::new();
    for index in 0..count {
        match backend.get(&chunk_account(key, generation, index))? {
            Some(part) => value.push_str(&part),
            None => {
                // Incomplete data: treat as absent and clean up.
                delete_all(backend, key)?;
                return Ok(None);
            }
        }
    }
    Ok(Some(value))
}

fn write_generation<B: Backend>(
    backend: &B,
    key: &str,
    generation: u64,
    chunks: &[String],
) -> Result<(), ()> {
    for (index, chunk) in chunks.iter().enumerate() {
        backend.set(&chunk_account(key, generation, index), chunk)?;
    }
    backend.set(&count_account(key), &format!("{generation}:{}", chunks.len()))
}

/// Writes the chunks into a new generation, flips the count last, then removes the old
/// generation. A failure before the flip leaves the previous value intact.
fn store_set<B: Backend>(backend: &B, key: &str, value: &str) -> Result<(), ()> {
    let previous = read_meta(backend, key)?;
    let generation = previous.map_or(0, |(generation, _)| generation.wrapping_add(1));
    let chunks = split_chunks(value);
    if write_generation(backend, key, generation, &chunks).is_err() {
        // Best-effort removal of the half-written new generation.
        let _ = delete_generation(backend, key, generation, chunks.len());
        return Err(());
    }
    if let Some((old_generation, old_count)) = previous {
        // The new value is committed; stale old chunks are best-effort cleanup.
        let _ = delete_generation(backend, key, old_generation, old_count);
    }
    Ok(())
}

#[tauri::command]
pub fn secret_get(key: String) -> Result<Option<String>, String> {
    validate_key(&key)?;
    store_get(&KeyringBackend, &key).map_err(|_| ERR_UNAVAILABLE.to_string())
}

#[tauri::command]
pub fn secret_set(key: String, value: String) -> Result<(), String> {
    validate_key(&key)?;
    if value.len() > MAX_VALUE_BYTES {
        return Err(ERR_TOO_LARGE.to_string());
    }
    store_set(&KeyringBackend, &key, &value).map_err(|_| ERR_UNAVAILABLE.to_string())
}

#[tauri::command]
pub fn secret_delete(key: String) -> Result<(), String> {
    validate_key(&key)?;
    delete_all(&KeyringBackend, &key).map_err(|_| ERR_UNAVAILABLE.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::RefCell;
    use std::collections::HashMap;

    #[derive(Default)]
    struct MemoryBackend {
        map: RefCell<HashMap<String, String>>,
        /// Number of further successful `set` calls before every `set` fails (None = never).
        sets_until_failure: RefCell<Option<usize>>,
    }

    impl Backend for MemoryBackend {
        fn get(&self, account: &str) -> Result<Option<String>, ()> {
            Ok(self.map.borrow().get(account).cloned())
        }
        fn set(&self, account: &str, value: &str) -> Result<(), ()> {
            if let Some(remaining) = self.sets_until_failure.borrow_mut().as_mut() {
                if *remaining == 0 {
                    return Err(());
                }
                *remaining -= 1;
            }
            self.map
                .borrow_mut()
                .insert(account.to_string(), value.to_string());
            Ok(())
        }
        fn delete(&self, account: &str) -> Result<(), ()> {
            self.map.borrow_mut().remove(account);
            Ok(())
        }
    }

    const KEY: &str = "session.oauth";

    #[test]
    fn rejects_unknown_keys() {
        assert_eq!(validate_key("other"), Err("invalidKey".to_string()));
        assert_eq!(validate_key("session.appPassword"), Ok(()));
        assert_eq!(validate_key("session.oauth"), Ok(()));
        assert_eq!(secret_get("x".into()), Err("invalidKey".to_string()));
        assert_eq!(secret_delete("x".into()), Err("invalidKey".to_string()));
    }

    #[test]
    fn rejects_oversized_values() {
        let value = "a".repeat(MAX_VALUE_BYTES + 1);
        assert_eq!(secret_set(KEY.into(), value), Err("tooLarge".to_string()));
    }

    #[test]
    fn round_trips_multi_chunk_values() {
        let backend = MemoryBackend::default();
        let value: String = (0..3500)
            .map(|i| char::from(b'a' + (i % 26) as u8))
            .collect();
        store_set(&backend, KEY, &value).unwrap();
        assert_eq!(
            backend.map.borrow().get("session.oauth#count").unwrap(),
            "0:4"
        );
        assert!(backend
            .map
            .borrow()
            .values()
            .all(|v| v.encode_utf16().count() <= CHUNK_UTF16_UNITS));
        assert_eq!(store_get(&backend, KEY).unwrap(), Some(value));
    }

    #[test]
    fn round_trips_multibyte_values() {
        let backend = MemoryBackend::default();
        let value = "あ".repeat(2500);
        store_set(&backend, KEY, &value).unwrap();
        assert_eq!(store_get(&backend, KEY).unwrap(), Some(value));
    }

    #[test]
    fn chunks_never_split_surrogate_pairs() {
        // U+1F331 is two UTF-16 units; 1001 of them force several chunks.
        let value = "\u{1F331}".repeat(1001);
        let chunks = split_chunks(&value);
        assert!(chunks
            .iter()
            .all(|c| c.encode_utf16().count() <= CHUNK_UTF16_UNITS));
        assert!(chunks.len() >= 3);
        assert_eq!(chunks.concat(), value);
        let backend = MemoryBackend::default();
        store_set(&backend, KEY, &value).unwrap();
        assert_eq!(store_get(&backend, KEY).unwrap(), Some(value));
    }

    #[test]
    fn absent_when_never_set() {
        assert_eq!(store_get(&MemoryBackend::default(), KEY).unwrap(), None);
    }

    #[test]
    fn shrinking_removes_stale_chunks() {
        let backend = MemoryBackend::default();
        store_set(&backend, KEY, &"x".repeat(3500)).unwrap();
        store_set(&backend, KEY, "short").unwrap();
        assert_eq!(store_get(&backend, KEY).unwrap(), Some("short".to_string()));
        assert_eq!(backend.map.borrow().len(), 2);
    }

    #[test]
    fn empty_value_round_trips() {
        let backend = MemoryBackend::default();
        store_set(&backend, KEY, "").unwrap();
        assert_eq!(store_get(&backend, KEY).unwrap(), Some(String::new()));
    }

    #[test]
    fn missing_chunk_is_absent_and_cleaned() {
        let backend = MemoryBackend::default();
        store_set(&backend, KEY, &"y".repeat(2500)).unwrap();
        backend.map.borrow_mut().remove("session.oauth#g0#1");
        assert_eq!(store_get(&backend, KEY).unwrap(), None);
        assert!(backend.map.borrow().is_empty());
    }

    #[test]
    fn delete_removes_everything_and_keeps_other_keys() {
        let backend = MemoryBackend::default();
        store_set(&backend, KEY, &"z".repeat(2500)).unwrap();
        store_set(&backend, "session.appPassword", "pw").unwrap();
        delete_all(&backend, KEY).unwrap();
        assert_eq!(store_get(&backend, KEY).unwrap(), None);
        assert_eq!(
            store_get(&backend, "session.appPassword").unwrap(),
            Some("pw".to_string())
        );
        assert_eq!(backend.map.borrow().len(), 2);
    }

    #[test]
    fn failed_write_keeps_previous_value_at_every_failure_point() {
        let old = "o".repeat(2500);
        let new = "n".repeat(3500);
        for allowed in 0..6 {
            let backend = MemoryBackend::default();
            store_set(&backend, KEY, &old).unwrap();
            *backend.sets_until_failure.borrow_mut() = Some(allowed);
            let result = store_set(&backend, KEY, &new);
            *backend.sets_until_failure.borrow_mut() = None;
            let got = store_get(&backend, KEY).unwrap();
            if result.is_err() {
                assert_eq!(got, Some(old.clone()), "failure after {allowed} sets");
            } else {
                assert_eq!(got, Some(new.clone()));
            }
        }
    }

    #[test]
    fn failed_first_write_is_absent_not_corrupt() {
        let backend = MemoryBackend::default();
        *backend.sets_until_failure.borrow_mut() = Some(2);
        assert!(store_set(&backend, KEY, &"p".repeat(3500)).is_err());
        assert_eq!(store_get(&backend, KEY).unwrap(), None);
    }
}
