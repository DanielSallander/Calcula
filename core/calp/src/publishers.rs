//! FILENAME: core/calp/src/publishers.rs
//! PURPOSE: Who, besides the application's original publisher, may push to it.
//! CONTEXT: A profile holds exactly ONE Ed25519 keypair, and it is that user's
//! identity for every application they publish and for reviewing writeback. So
//! "share the team key" is not a small compromise — it overwrites each
//! developer's personal publishing identity machine-wide, makes a compromise
//! team-wide, and removes attribution entirely. Delegation is the alternative.
//!
//! # The shape
//!
//! The application's ROOT key is the key that signed its FIRST version. That is an
//! immutable anchor: version 1 cannot be republished, so nothing can move it.
//!
//! The root signs a `publishers.json` at the application root listing delegate
//! keys. A push is allowed from the root or any listed delegate.
//!
//! It lives beside `calp-manifest.json` rather than inside a version, for two
//! reasons: adding a colleague must not require publishing a version, and the
//! statement is about the application rather than about any one version of it.
//!
//! # What the subscriber sees: nothing new
//!
//! TOFU still pins ONE key per (workspace, application) — the ROOT key. A version
//! signed by a delegate verifies by chain: the version is signed by K, and K
//! appears in a `publishers.json` signed by the pinned root. The pin store, its
//! format and its prompts are untouched; the trust panel gains one line naming
//! the delegate.
//!
//! # The honest limit
//!
//! On a share that developers can write to, REMOVING a delegate is
//! rollback-vulnerable: someone can restore an older `publishers.json` along
//! with its still-valid signature. `revision` is monotonic and clients remember
//! the highest they have seen per application, which makes that DETECTABLE rather
//! than silent. It does not make it preventable. Real revocation means rotating
//! the root key, which is out of scope — and the workspace was never a trust
//! boundary against people who can write to it (see `calp-distribution.md`).

use std::collections::HashMap;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::error::CalpError;
use crate::signing::{verify_signature, PublisherKeypair};
use crate::transport::WorkspaceTransport;

/// The co-publisher list, at the application root.
pub const PUBLISHERS_FILE: &str = "publishers.json";
/// Its detached Ed25519 signature, by the ROOT key.
pub const PUBLISHERS_SIG_FILE: &str = "publishers.sig";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublisherList {
    pub format_version: u32,
    pub package_name: String,
    /// The key that signed the application's first version. Repeated here so a
    /// reader can check that this list claims the root it was verified against
    /// — a list signed by the right key but naming a different application or root
    /// is a list from somewhere else.
    pub root_key: String,
    /// Monotonic. A client that has seen revision N refuses an older one,
    /// which turns a rollback from silent into visible.
    pub revision: u64,
    pub updated_at: String,
    pub authorized_keys: Vec<AuthorizedKey>,
    #[serde(flatten, default, skip_serializing_if = "HashMap::is_empty")]
    pub extra: HashMap<String, serde_json::Value>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AuthorizedKey {
    /// Lowercase hex of the delegate's Ed25519 public key.
    pub key: String,
    /// Display only. Never used for authorization — the key is.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub name: String,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub added_at: String,
}

impl PublisherList {
    pub fn new(package_name: &str, root_key: &str, now: &str) -> Self {
        Self {
            format_version: 1,
            package_name: package_name.to_string(),
            root_key: root_key.to_string(),
            revision: 1,
            updated_at: now.to_string(),
            authorized_keys: Vec::new(),
            extra: HashMap::new(),
        }
    }

    /// Every key allowed to publish: the root, plus the delegates.
    ///
    /// The root is always included whether or not it is listed, because it is
    /// authorized by construction — a list that could exclude the root would be
    /// a list that could lock the owner out of their own application.
    pub fn allowed_keys(&self) -> Vec<String> {
        let mut keys = vec![self.root_key.clone()];
        for entry in &self.authorized_keys {
            if entry.key != self.root_key {
                keys.push(entry.key.clone());
            }
        }
        keys
    }

    pub fn allows(&self, key: &str) -> bool {
        !key.is_empty() && self.allowed_keys().iter().any(|k| k == key)
    }
}

/// The application's ROOT key: whoever signed its earliest published version.
///
/// Reads the version manifest rather than the application manifest's `versions`
/// entry, because the version manifest is SIGNED and the list entry is not.
/// Returns `None` for an application with no versions, or one whose first version
/// predates signing.
pub fn root_key_of(
    registry: &dyn WorkspaceTransport,
    package: &str,
) -> Result<Option<String>, CalpError> {
    let manifest = registry.get_application_manifest(package)?;
    let mut versions = manifest.parsed_versions();
    versions.sort();
    let Some(first) = versions.first() else {
        return Ok(None);
    };
    let first_manifest = registry.get_version_manifest(package, &first.to_string())?;
    if first_manifest.publisher_key.is_empty() {
        return Ok(None);
    }
    Ok(Some(first_manifest.publisher_key))
}

/// Load the co-publisher list, verified against `root_key`.
///
/// `Ok(None)` means the application has no list — which is not a failure: an
/// application with a single publisher never needs one, and that is the common
/// case.
///
/// Every way the list can be wrong is an ERROR rather than a `None`, because
/// "there is no list" and "there is a list I could not trust" must not produce
/// the same behaviour. A present-but-unverifiable list means somebody is
/// tampering, and treating it as absent would silently fall back to root-only —
/// which sounds safe until you remember the attacker's goal might be exactly to
/// make the real delegates disappear.
pub fn load_verified(
    registry: &dyn WorkspaceTransport,
    package: &str,
    root_key: &str,
) -> Result<Option<PublisherList>, CalpError> {
    let Some(bytes) = registry.read_application_artifact(package, PUBLISHERS_FILE)? else {
        return Ok(None);
    };
    let Some(sig) = registry.read_application_artifact(package, PUBLISHERS_SIG_FILE)? else {
        return Err(CalpError::PublisherListInvalid {
            package: package.to_string(),
            reason: "the co-publisher list is not signed".to_string(),
        });
    };
    let sig_hex = String::from_utf8(sig).map_err(|_| CalpError::PublisherListInvalid {
        package: package.to_string(),
        reason: "the co-publisher list's signature is unreadable".to_string(),
    })?;

    verify_signature(root_key, &bytes, sig_hex.trim(), package, "publishers").map_err(|_| {
        CalpError::PublisherListInvalid {
            package: package.to_string(),
            reason:
                "the co-publisher list is not signed by the key that published this application"
                    .to_string(),
        }
    })?;

    // Parse from the bytes that were VERIFIED, never from a re-read — the same
    // split-view defence the version manifest uses.
    let list: PublisherList =
        serde_json::from_slice(&bytes).map_err(|e| CalpError::PublisherListInvalid {
            package: package.to_string(),
            reason: format!("the co-publisher list is unreadable ({e})"),
        })?;

    if list.package_name != package {
        return Err(CalpError::PublisherListInvalid {
            package: package.to_string(),
            reason: format!(
                "the co-publisher list names the application '{}', not this one",
                list.package_name
            ),
        });
    }
    if list.root_key != root_key {
        return Err(CalpError::PublisherListInvalid {
            package: package.to_string(),
            reason: "the co-publisher list names a different root publisher".to_string(),
        });
    }

    Ok(Some(list))
}

/// Write the co-publisher list, signed by the ROOT keypair.
///
/// Refuses unless `keypair` IS the root. A delegate-signed list would let any
/// delegate add friends, which is the whole reason the list is a separate
/// root-signed artifact rather than a field in a version manifest.
pub fn write_signed(
    registry: &dyn WorkspaceTransport,
    list: &PublisherList,
    keypair: &PublisherKeypair,
) -> Result<(), CalpError> {
    if keypair.public_key_hex() != list.root_key {
        return Err(CalpError::PublisherListInvalid {
            package: list.package_name.clone(),
            reason: "only the publisher who created this application can change who may publish to it"
                .to_string(),
        });
    }
    let bytes = serde_json::to_vec_pretty(list)?;
    let signature = keypair.sign(&bytes);
    registry.write_application_artifact(&list.package_name, PUBLISHERS_FILE, &bytes)?;
    registry.write_application_artifact(
        &list.package_name,
        PUBLISHERS_SIG_FILE,
        signature.as_bytes(),
    )?;
    Ok(())
}

/// Load the list for `package` if it has one, given a profile that may hold the
/// root key. A convenience for the app layer's "can I manage this?" question.
pub fn load_for_profile(
    registry: &dyn WorkspaceTransport,
    package: &str,
    profile_dir: &Path,
) -> Result<(Option<String>, Option<PublisherList>, bool), CalpError> {
    let root = root_key_of(registry, package)?;
    let list = match &root {
        Some(root_key) => load_verified(registry, package, root_key)?,
        None => None,
    };
    let holds_root = match &root {
        Some(root_key) => {
            crate::signing::profile_holds_publisher_key(profile_dir, root_key).unwrap_or(false)
        }
        None => false,
    };
    Ok((root, list, holds_root))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::workspace::LocalWorkspace;
    use tempfile::TempDir;

    fn keypair(dir: &TempDir) -> PublisherKeypair {
        PublisherKeypair::load_or_create(dir.path()).unwrap()
    }

    fn setup() -> (TempDir, LocalWorkspace, TempDir, PublisherKeypair) {
        let reg_dir = TempDir::new().unwrap();
        let reg = LocalWorkspace::open(reg_dir.path()).unwrap();
        let prof = TempDir::new().unwrap();
        let kp = keypair(&prof);
        (reg_dir, reg, prof, kp)
    }

    #[test]
    fn a_package_with_no_list_is_not_an_error() {
        let (_d, reg, _p, kp) = setup();
        assert_eq!(
            load_verified(&reg, "pkg", &kp.public_key_hex()).unwrap(),
            None,
            "single-publisher applications are the common case and need no list"
        );
    }

    #[test]
    fn a_signed_list_round_trips_and_authorizes_its_delegates() {
        let (_d, reg, _p, root) = setup();
        let delegate = TempDir::new().unwrap();
        let delegate_key = keypair(&delegate).public_key_hex();

        let mut list = PublisherList::new("pkg", &root.public_key_hex(), "2026-08-29T00:00:00Z");
        list.authorized_keys.push(AuthorizedKey {
            key: delegate_key.clone(),
            name: "Alice".to_string(),
            added_at: "2026-08-29T00:00:00Z".to_string(),
        });
        write_signed(&reg, &list, &root).unwrap();

        let loaded = load_verified(&reg, "pkg", &root.public_key_hex())
            .unwrap()
            .expect("the list is there");
        assert_eq!(loaded, list);
        assert!(loaded.allows(&delegate_key));
        assert!(
            loaded.allows(&root.public_key_hex()),
            "the root is authorized by construction — a list must not be able to \
             lock the owner out of their own package"
        );
        assert!(!loaded.allows("deadbeef"));
        assert!(!loaded.allows(""), "an unsigned application is not authorized by an empty key");
    }

    #[test]
    fn a_delegate_cannot_sign_the_list() {
        // The reason the list is a separate root-signed artifact: otherwise any
        // delegate could add their own friends.
        let (_d, reg, _p, root) = setup();
        let delegate_dir = TempDir::new().unwrap();
        let delegate = keypair(&delegate_dir);

        let list = PublisherList::new("pkg", &root.public_key_hex(), "2026-08-29T00:00:00Z");
        let err = write_signed(&reg, &list, &delegate).unwrap_err();
        assert!(
            matches!(err, CalpError::PublisherListInvalid { .. }),
            "got {err:?}"
        );
    }

    #[test]
    fn a_tampered_list_is_an_error_not_an_absent_list() {
        // "There is no list" and "there is a list I could not trust" must not
        // behave the same: falling back to root-only on a tampered list is
        // exactly what an attacker deleting delegates would want.
        let (_d, reg, _p, root) = setup();
        let list = PublisherList::new("pkg", &root.public_key_hex(), "2026-08-29T00:00:00Z");
        write_signed(&reg, &list, &root).unwrap();

        let mut tampered = serde_json::to_value(&list).unwrap();
        tampered["authorizedKeys"] = serde_json::json!([{ "key": "aa".repeat(32) }]);
        reg.write_application_artifact(
            "pkg",
            PUBLISHERS_FILE,
            serde_json::to_vec_pretty(&tampered).unwrap().as_slice(),
        )
        .unwrap();

        let err = load_verified(&reg, "pkg", &root.public_key_hex()).unwrap_err();
        assert!(matches!(err, CalpError::PublisherListInvalid { .. }), "got {err:?}");
    }

    #[test]
    fn a_list_with_no_signature_is_refused() {
        let (_d, reg, _p, root) = setup();
        let list = PublisherList::new("pkg", &root.public_key_hex(), "2026-08-29T00:00:00Z");
        reg.write_application_artifact(
            "pkg",
            PUBLISHERS_FILE,
            serde_json::to_vec_pretty(&list).unwrap().as_slice(),
        )
        .unwrap();

        let err = load_verified(&reg, "pkg", &root.public_key_hex()).unwrap_err();
        assert!(matches!(err, CalpError::PublisherListInvalid { .. }), "got {err:?}");
    }

    #[test]
    fn a_list_borrowed_from_another_package_is_refused() {
        // Correctly signed by this root, but written for a different application —
        // copying it across is not a way to inherit its delegates.
        let (_d, reg, _p, root) = setup();
        let list = PublisherList::new("other-pkg", &root.public_key_hex(), "2026-08-29T00:00:00Z");
        let bytes = serde_json::to_vec_pretty(&list).unwrap();
        let sig = root.sign(&bytes);
        reg.write_application_artifact("pkg", PUBLISHERS_FILE, &bytes).unwrap();
        reg.write_application_artifact("pkg", PUBLISHERS_SIG_FILE, sig.as_bytes()).unwrap();

        let err = load_verified(&reg, "pkg", &root.public_key_hex()).unwrap_err();
        assert!(matches!(err, CalpError::PublisherListInvalid { .. }), "got {err:?}");
    }

    #[test]
    fn a_list_signed_by_a_different_key_is_refused() {
        let (_d, reg, _p, root) = setup();
        let impostor_dir = TempDir::new().unwrap();
        let impostor = keypair(&impostor_dir);

        // Claims our root, but is signed by someone else.
        let list = PublisherList::new("pkg", &root.public_key_hex(), "2026-08-29T00:00:00Z");
        let bytes = serde_json::to_vec_pretty(&list).unwrap();
        let sig = impostor.sign(&bytes);
        reg.write_application_artifact("pkg", PUBLISHERS_FILE, &bytes).unwrap();
        reg.write_application_artifact("pkg", PUBLISHERS_SIG_FILE, sig.as_bytes()).unwrap();

        let err = load_verified(&reg, "pkg", &root.public_key_hex()).unwrap_err();
        assert!(matches!(err, CalpError::PublisherListInvalid { .. }), "got {err:?}");
    }
}
