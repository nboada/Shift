//! User preferences as one JSON document (the UI owns its shape), plus AI provider keys in the Keychain.

use anyhow::{Result, bail};
use serde_json::Value;
use std::path::{Path, PathBuf};

const KEYCHAIN_SERVICE: &str = "com.nicboada.mail";

pub fn path(dir: &Path) -> PathBuf {
    dir.join("settings.json")
}

pub fn load(dir: &Path) -> Value {
    std::fs::read(path(dir))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_else(|| Value::Object(Default::default()))
}

pub fn save(dir: &Path, value: &Value) -> Result<()> {
    if !value.is_object() {
        bail!("settings must be a JSON object");
    }
    // Write-then-rename so a crash mid-write never leaves a truncated file.
    let tmp = dir.join("settings.json.tmp");
    std::fs::write(&tmp, serde_json::to_vec_pretty(value)?)?;
    std::fs::rename(tmp, path(dir))?;
    Ok(())
}

/// Seconds between Gmail checks, from `general.syncSeconds`, clamped to a sane range.
pub fn sync_seconds(dir: &Path) -> u64 {
    load(dir)["general"]["syncSeconds"]
        .as_u64()
        .unwrap_or(30)
        .clamp(15, 3600)
}

pub struct Notifications {
    pub enabled: bool,
    pub sound: bool,
    pub only_people: bool,
}

/// `notifications.*`, with the UI's defaults (src/settings.ts) when unset.
pub fn notifications(dir: &Path) -> Notifications {
    let v = &load(dir)["notifications"];
    Notifications {
        enabled: v["enabled"].as_bool().unwrap_or(true),
        sound: v["sound"].as_bool().unwrap_or(true),
        only_people: v["onlyPeople"].as_bool().unwrap_or(false),
    }
}

fn ai_entry(provider: &str) -> Result<keyring::Entry> {
    // Provider ids come from the UI; keep them to a safe charset before naming a Keychain item.
    if provider.is_empty()
        || provider.len() > 32
        || !provider
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-')
    {
        bail!("invalid provider id");
    }
    Ok(keyring::Entry::new(
        KEYCHAIN_SERVICE,
        &format!("ai-{provider}"),
    )?)
}

pub fn set_ai_key(provider: &str, key: &str) -> Result<()> {
    let key = key.trim();
    if key.is_empty() {
        bail!("API key is empty");
    }
    ai_entry(provider)?.set_password(key)?;
    Ok(())
}

pub fn has_ai_key(provider: &str) -> bool {
    ai_entry(provider)
        .and_then(|e| Ok(e.get_password()?))
        .is_ok()
}

pub fn delete_ai_key(provider: &str) -> Result<()> {
    let _ = ai_entry(provider)?.delete_credential();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_and_clamps() {
        let dir = std::env::temp_dir().join(format!("shift-settings-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(sync_seconds(&dir), 30, "default when missing");
        save(
            &dir,
            &serde_json::json!({ "general": { "syncSeconds": 5 } }),
        )
        .unwrap();
        assert_eq!(sync_seconds(&dir), 15, "clamped to minimum");
        assert_eq!(load(&dir)["general"]["syncSeconds"], 5);
        assert!(save(&dir, &serde_json::json!([1])).is_err());
        assert!(ai_entry("../evil").is_err());
        std::fs::remove_dir_all(dir).unwrap();
    }
}
