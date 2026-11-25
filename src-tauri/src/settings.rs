//! User preferences as one JSON document (the UI owns its shape), plus AI provider keys in the Keychain.

use anyhow::{Result, bail};
use serde_json::Value;
use std::path::{Path, PathBuf};

const KEYCHAIN_SERVICE: &str = "au.com.talkk.shift";

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
    // One write at a time: two saves sharing the temp file could otherwise leave the older one in place.
    static WRITING: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _guard = WRITING
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
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

fn ai_entry(provider: &str) -> Result<keyring_core::Entry> {
    // Provider ids come from the UI; keep them to a safe charset before naming a Keychain item.
    if provider.is_empty()
        || provider.len() > 32
        || !provider
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-')
    {
        bail!("invalid provider id");
    }
    crate::auth::keychain_entry(KEYCHAIN_SERVICE, &format!("ai-{provider}"))
}

pub fn set_ai_key(provider: &str, key: &str) -> Result<()> {
    let key = key.trim();
    if key.is_empty() {
        bail!("API key is empty");
    }
    ai_entry(provider)?.set_password(key)?;
    Ok(())
}

pub fn get_ai_key(provider: &str) -> Option<String> {
    ai_entry(provider).ok()?.get_password().ok()
}

/// AI auto-label rules: the labels the user described in Settings → AI, by name. None while auto-label is off.
pub fn ai_label_rules(dir: &Path) -> Option<Vec<(String, String)>> {
    let ai = &load(dir)["ai"];
    if !ai["autoLabel"].as_bool().unwrap_or(false) {
        return None;
    }
    let rules: Vec<(String, String)> = ai["labelRules"]
        .as_object()?
        .iter()
        .filter_map(|(name, d)| Some((name.clone(), d.as_str()?.trim().to_string())))
        .filter(|(_, d)| !d.is_empty())
        .collect();
    (!rules.is_empty()).then_some(rules)
}

/// The follow-up labels by name, (needs my reply, waiting for a reply), when both are set and differ.
pub fn follow_up_labels(dir: &Path) -> Option<(String, String)> {
    let f = &load(dir)["inbox"]["followUps"];
    let (needs, waiting) = (f["needsReply"].as_str()?, f["waiting"].as_str()?);
    (!needs.is_empty() && !waiting.is_empty() && needs != waiting)
        .then(|| (needs.to_owned(), waiting.to_owned()))
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
