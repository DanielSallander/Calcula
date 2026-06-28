//! FILENAME: core/calp/src/identity_provider.rs
//! PURPOSE: Local subscriber identity for writeback submissions.
//! CONTEXT: Each Calcula installation has a stable subscriber identity
//! derived from the OS username and a machine-generated UUID. This identity
//! is attached to every writeback submission so the registry can attribute
//! contributions to specific subscribers.
//!
//! The identity is stored in the Calcula user profile directory (not per-
//! workbook) and persists across sessions. Future versions may replace the
//! local identity provider with SSO/AD integration without changing the
//! SubmitterIdentity struct or submission storage format.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

/// A subscriber's identity, attached to writeback submissions.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SubmitterIdentity {
    /// Human-readable display name (typically the OS username).
    pub display_name: String,
    /// Stable machine-generated identifier (UUID v7, created on first use).
    pub id: String,
    /// Forward-compatibility.
    #[serde(flatten, default, skip_serializing_if = "HashMap::is_empty")]
    pub extra: HashMap<String, serde_json::Value>,
}

/// File stored on disk to persist the identity across sessions.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct IdentityFile {
    format_version: u32,
    identity: SubmitterIdentity,
}

/// Get the path to the identity file in the given profile directory.
fn identity_file_path(profile_dir: &Path) -> PathBuf {
    profile_dir.join("subscriber-identity.json")
}

/// Load the subscriber identity from the profile directory, or create one
/// if none exists. The profile directory is created if it doesn't exist.
pub fn load_or_create(profile_dir: &Path) -> Result<SubmitterIdentity, String> {
    let path = identity_file_path(profile_dir);

    if path.exists() {
        let content = std::fs::read_to_string(&path)
            .map_err(|e| format!("Failed to read identity file: {}", e))?;
        let file: IdentityFile = serde_json::from_str(&content)
            .map_err(|e| format!("Failed to parse identity file: {}", e))?;
        // PRIVACY FAIL-CLOSED (C2b): a blank id is not a valid principal. serde
        // happily accepts {"id":""}, but a blank id would defeat the own_only /
        // own_plus_aggregate writeback filters (which key on id equality). Refuse
        // to load it: every get_subscriber_identity call then errors (callers
        // degrade fail-closed) rather than running with a privacy-defeating empty
        // principal. NOTE: this does NOT overwrite/re-mint the corrupt file — the
        // user must remove it to get a fresh identity (deliberately not silently
        // rewriting a file we did not author).
        if file.identity.id.trim().is_empty() {
            return Err("Identity file has a blank id; refusing to load.".to_string());
        }
        return Ok(file.identity);
    }

    // Create a new identity
    let display_name = std::env::var("USERNAME")
        .or_else(|_| std::env::var("USER"))
        .unwrap_or_else(|_| "Unknown".to_string());

    let id = {
        let bytes = identity::generate_uuid_v7();
        format!(
            "{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
            bytes[0], bytes[1], bytes[2], bytes[3],
            bytes[4], bytes[5], bytes[6], bytes[7],
            bytes[8], bytes[9], bytes[10], bytes[11], bytes[12], bytes[13], bytes[14], bytes[15],
        )
    };

    let identity = SubmitterIdentity {
        display_name,
        id,
        extra: HashMap::new(),
    };

    // Persist
    std::fs::create_dir_all(profile_dir)
        .map_err(|e| format!("Failed to create profile directory: {}", e))?;

    let file = IdentityFile {
        format_version: 1,
        identity: identity.clone(),
    };
    let content = serde_json::to_string_pretty(&file)
        .map_err(|e| format!("Failed to serialize identity: {}", e))?;
    std::fs::write(&path, content)
        .map_err(|e| format!("Failed to write identity file: {}", e))?;

    Ok(identity)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn creates_identity_on_first_use() {
        let dir = TempDir::new().unwrap();
        let identity = load_or_create(dir.path()).unwrap();

        assert!(!identity.id.is_empty());
        assert!(!identity.display_name.is_empty());

        // File was created
        assert!(identity_file_path(dir.path()).exists());
    }

    #[test]
    fn returns_same_identity_on_subsequent_calls() {
        let dir = TempDir::new().unwrap();
        let first = load_or_create(dir.path()).unwrap();
        let second = load_or_create(dir.path()).unwrap();

        assert_eq!(first.id, second.id);
        assert_eq!(first.display_name, second.display_name);
    }

    #[test]
    fn identity_survives_roundtrip() {
        let dir = TempDir::new().unwrap();
        let original = load_or_create(dir.path()).unwrap();

        // Read the raw file and verify structure
        let content = std::fs::read_to_string(identity_file_path(dir.path())).unwrap();
        let file: IdentityFile = serde_json::from_str(&content).unwrap();
        assert_eq!(file.format_version, 1);
        assert_eq!(file.identity, original);
    }

    #[test]
    fn identity_serde_roundtrip() {
        let identity = SubmitterIdentity {
            display_name: "Alice".to_string(),
            id: "test-uuid-123".to_string(),
            extra: HashMap::new(),
        };

        let json = serde_json::to_string(&identity).unwrap();
        let roundtripped: SubmitterIdentity = serde_json::from_str(&json).unwrap();
        assert_eq!(roundtripped, identity);
    }

    // C2b: a hand-written / corrupt identity file with a blank id must be
    // rejected (fail-closed) rather than loaded as a privacy-defeating principal.
    #[test]
    fn blank_id_identity_file_is_rejected() {
        let dir = TempDir::new().unwrap();
        let file = IdentityFile {
            format_version: 1,
            identity: SubmitterIdentity {
                display_name: "Ghost".to_string(),
                id: "".to_string(),
                extra: HashMap::new(),
            },
        };
        std::fs::write(
            identity_file_path(dir.path()),
            serde_json::to_string_pretty(&file).unwrap(),
        )
        .unwrap();

        let result = load_or_create(dir.path());
        assert!(result.is_err(), "a blank-id identity file must be refused");
    }

    #[test]
    fn identity_preserves_extra_fields() {
        let json = serde_json::json!({
            "displayName": "Bob",
            "id": "uuid-456",
            "ssoProvider": "okta",
            "department": "Finance"
        });
        let identity: SubmitterIdentity = serde_json::from_value(json).unwrap();
        assert_eq!(identity.display_name, "Bob");
        assert!(identity.extra.contains_key("ssoProvider"));
        assert!(identity.extra.contains_key("department"));
    }
}
