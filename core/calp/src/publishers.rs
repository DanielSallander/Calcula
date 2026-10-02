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
//! with its still-valid signature, and the removed delegate is authorised again.
//!
//! On the DEVELOPER side that is now detected. `revision` is monotonic when the
//! root writes the list, and every door `authorize_signer` guards (checkout, the
//! push merge, the hold-back, the held-code restore at push) and every push
//! checks it against this machine's high-water mark for the (workspace,
//! application) -- kept with the per-machine root anchor in
//! `developer_anchor.rs` -- and refuses a lower one
//! (`CalpError::PublisherListRolledBack`). A machine that never saw the newer
//! list cannot know it existed, so the protection starts at the first revision
//! this machine sees.
//!
//! On the SUBSCRIBER side it is still open: the TOFU delegate path
//! (`integrity::delegate_is_authorized`, reading `load_verified`) keeps no mark,
//! so a rolled-back list re-authorises a removed delegate for a subscriber's
//! refresh. Real revocation means rotating the root key, which is out of scope --
//! and the workspace was never a trust boundary against people who can write to
//! it (see `calp-distribution.md`).

use std::collections::HashMap;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::developer_anchor::{AnchorGate, AnchorPolicy, AnchorStatus};
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

// ---------------------------------------------------------------------------
// Who may have signed what a DEVELOPER opens (BUG-0262)
// ---------------------------------------------------------------------------

/// The application's authorised publishers, ANCHORED AT ITS ROOT and proved
/// rather than read.
#[derive(Debug, Clone, PartialEq)]
pub struct RootAnchoredPublishers {
    /// The key that signed the application's first version, taken from that
    /// version's manifest AFTER its signature verified under this very key.
    pub root_key: String,
    /// The name the first version's signed manifest gives. Display only.
    pub root_name: String,
    /// The first version, as the workspace listing names it.
    pub root_version: String,
    /// The root-signed co-publisher list, when the application has one.
    pub list: Option<PublisherList>,
}

impl RootAnchoredPublishers {
    /// Whether `key` may publish this application: the root, or a delegate the
    /// root's own list names. An empty key (an unsigned version) never may.
    pub fn allows(&self, key: &str) -> bool {
        if key.is_empty() {
            return false;
        }
        match &self.list {
            // `PublisherList::allows` includes the root by construction, and
            // `load_verified` has already refused a list naming another root.
            Some(list) => list.allows(key),
            None => key == self.root_key,
        }
    }

    /// The root publisher, named for a person: their name and key fingerprint.
    pub fn root_holder(&self) -> String {
        let name = if self.root_name.trim().is_empty() {
            "the publisher who created it"
        } else {
            self.root_name.as_str()
        };
        format!("{name} (key {})", crate::signing::key_fingerprint(&self.root_key))
    }
}

/// Who may publish `package`, anchored at its ROOT: the key that signed its
/// FIRST version, proved by that version's own signature.
///
/// # Why the root and nothing else
///
/// The question a working copy must answer — "is the version I am about to
/// edit, or merge into my next push, one an authorised publisher signed?" —
/// needs an anchor that planted versions cannot move:
///
/// * the HEAD's signer (what `publish::resolve_authorized_keys` falls back to
///   when there is no list) is circular — ONE planted head names itself;
/// * the PREVIOUS version's signer is circular too — TWO planted versions name
///   each other.
///
/// # Fails CLOSED, unlike [`root_key_of`]
///
/// `root_key_of` answers `None` for an unsigned first version, read with no
/// signature check, and the push-side check turns that into "no continuity to
/// enforce". Planting an UNSIGNED `0.0.1` was therefore the cheapest way to
/// switch the check off. Here, every one of these is an error:
///
/// * no versions at all;
/// * a first version with no signature or no publisher key;
/// * a first version that does not verify under the key it names;
/// * a co-publisher list that exists but does not verify under that root.
///
/// # What this function cannot see, and what sees it instead
///
/// The version listing itself is unsigned, so someone who can write to the
/// share can plant a fake first version signed by THEIR OWN key, and this
/// function -- which needs nothing remembered -- proves it just as well as the
/// real one. Nor can it see a ROLLED-BACK co-publisher list: an older
/// `publishers.json` the root really signed, restored with its signature,
/// verifies here too.
///
/// Both are caught one step later, by what THIS MACHINE remembers:
/// `developer_anchor::anchor_root` refuses a root that contradicts the one this
/// machine recorded for the (workspace, application), and a list revision lower
/// than the highest it has seen. [`authorize_signer`] runs it on every developer
/// door. What stays open is the first contact (trust on first use: a machine
/// whose first sight of an application is a planted root remembers that root)
/// and every machine that has not recorded anything yet -- subscribers among
/// them.
pub fn root_anchored_publishers(
    registry: &dyn WorkspaceTransport,
    package: &str,
) -> Result<RootAnchoredPublishers, CalpError> {
    let root = verified_root(registry, package)?;
    let list = load_verified(registry, package, &root.root_key)?;
    Ok(RootAnchoredPublishers {
        root_key: root.root_key,
        root_name: root.root_name,
        root_version: root.root_version,
        list,
    })
}

/// The application's ROOT alone: the first version, proved by its own
/// signature, FAILING CLOSED exactly as [`root_anchored_publishers`] does --
/// without reading the co-publisher list.
///
/// For the one caller that must go on when the list cannot be trusted: the
/// creator REPLACING that list. A tampered or rolled-back list must not lock
/// the root out of the only repair there is.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerifiedRoot {
    pub root_key: String,
    pub root_name: String,
    pub root_version: String,
}

/// See [`VerifiedRoot`].
pub fn verified_root(
    registry: &dyn WorkspaceTransport,
    package: &str,
) -> Result<VerifiedRoot, CalpError> {
    let manifest = registry.get_application_manifest(package)?;
    let mut versions = manifest.parsed_versions();
    versions.sort();
    let Some(first) = versions.first() else {
        return Err(CalpError::ApplicationRootUnverifiable {
            package: package.to_string(),
            reason: "the workspace lists no versions of it".to_string(),
        });
    };
    let first = first.to_string();

    // Crypto only: the root is not a trust decision this machine has made, so
    // no pin is read or written — the signature must simply verify under the
    // key the manifest names, over exactly the bytes that name it.
    let signed = crate::integrity::load_signed_manifest_via(registry, package, &first).map_err(
        |e| CalpError::ApplicationRootUnverifiable {
            package: package.to_string(),
            reason: match e {
                CalpError::MissingSignature { .. } => {
                    format!("its first version, v{first}, is not signed")
                }
                other => format!(
                    "its first version, v{first}, does not verify under the key it names ({other})"
                ),
            },
        },
    )?;
    let root_key = signed.manifest.publisher_key.clone();
    if root_key.is_empty() {
        // `load_signed_manifest_via` already refuses this; kept so the rule
        // does not depend on a helper's current behaviour.
        return Err(CalpError::ApplicationRootUnverifiable {
            package: package.to_string(),
            reason: format!("its first version, v{first}, names no publisher key"),
        });
    }

    Ok(VerifiedRoot {
        root_key,
        root_name: signed.manifest.publisher_name.clone(),
        root_version: first,
    })
}

/// On what authority a version's signer published it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SignerRole {
    /// The key that signed the application's first version.
    Root,
    /// A co-publisher named in the root-signed `publishers.json`.
    CoPublisher,
}

/// A version's signer, checked against [`root_anchored_publishers`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuthorizedSigner {
    /// The key that signed the version (lowercase hex).
    pub key: String,
    /// The name the version's own signed manifest gives. Display only.
    pub name: String,
    pub role: SignerRole,
    /// For a co-publisher, the name the ROOT gave them in its signed list —
    /// which, unlike `name`, the signer did not write about themselves. Empty
    /// for the root.
    pub listed_as: String,
    pub root_key: String,
    pub root_name: String,
    /// What THIS MACHINE remembers about the root: recorded just now, matched,
    /// or (for a passive read) nothing remembered and nothing recorded.
    pub anchor: crate::developer_anchor::AnchorStatus,
}

/// Refuse a version whose signer is not an authorised publisher of `package`,
/// anchored at the root. Every door that opens a published version FOR
/// EDITING — checkout, and the push merge that brings a newer head into a
/// working copy — asks this before it writes anything.
///
/// `signer_key` / `signer_name` MUST come from the version's VERIFIED manifest
/// (the one whose signature the caller already checked), never from a re-read:
/// the answer is about the bytes the caller is about to use.
///
/// `anchor` is REQUIRED: the root the workspace proves is checked against the
/// root THIS MACHINE remembers, and the co-publisher list against the highest
/// revision it has seen (`developer_anchor::anchor_root`), BEFORE the signer is
/// judged -- a planted first version would otherwise authorise every version
/// its planter signs. Whether first contact may RECORD is the gate's policy,
/// which each door states; a record happens only AFTER the signer passed, so a
/// refused version leaves nothing remembered (BUG-0266).
pub fn authorize_signer(
    registry: &dyn WorkspaceTransport,
    package: &str,
    version: &str,
    signer_key: &str,
    signer_name: &str,
    anchor: &AnchorGate,
) -> Result<AuthorizedSigner, CalpError> {
    authorize_signer_under(registry, package, version, signer_key, signer_name, anchor)
        .map(|(signer, _)| signer)
}

/// [`authorize_signer`], also returning the authority the signer was judged
/// against -- for a door that records first contact itself, LATER, after gates
/// of its own (`checkout::PendingCheckout::admit`), and must record exactly
/// the root it judged rather than whatever the workspace names by then.
pub(crate) fn authorize_signer_under(
    registry: &dyn WorkspaceTransport,
    package: &str,
    version: &str,
    signer_key: &str,
    signer_name: &str,
    anchor: &AnchorGate,
) -> Result<(AuthorizedSigner, RootAnchoredPublishers), CalpError> {
    let authority = root_anchored_publishers(registry, package)?;
    // Asked FIRST, so a contradicted root or a rolled-back list is named for
    // what it is rather than as the signer refusal it would also cause -- but
    // asked WITHOUT recording. Recording before the signer is judged is how a
    // fresh machine refused a planted root's application remembered the
    // PLANTER as its creator, and then refused the genuine one (BUG-0266).
    let check_only = AnchorGate {
        profile_dir: anchor.profile_dir,
        scope: anchor.scope,
        policy: AnchorPolicy::CheckOnly,
    };
    let mut anchor_status = crate::developer_anchor::anchor_root(&check_only, package, &authority)?;
    if !authority.allows(signer_key) {
        return Err(CalpError::SignerNotAuthorized {
            package: package.to_string(),
            version: version.to_string(),
            signer_name: if signer_name.trim().is_empty() {
                "an unnamed publisher".to_string()
            } else {
                signer_name.to_string()
            },
            signer_fingerprint: crate::signing::key_fingerprint(signer_key),
            root_holder: authority.root_holder(),
        });
    }
    let (role, listed_as) = if signer_key == authority.root_key {
        (SignerRole::Root, String::new())
    } else {
        let listed_as = authority
            .list
            .as_ref()
            .and_then(|l| l.authorized_keys.iter().find(|k| k.key == signer_key))
            .map(|k| k.name.clone())
            .unwrap_or_default();
        (SignerRole::CoPublisher, listed_as)
    };
    // The signer passed: first contact may now be recorded, when the door's
    // policy allows. `anchor_root` re-asks under its own lock, so a record
    // another thread or process made in between is matched or contradicted,
    // never overwritten.
    if anchor_status == AnchorStatus::NotAnchored && anchor.policy != AnchorPolicy::CheckOnly {
        anchor_status = crate::developer_anchor::anchor_root(anchor, package, &authority)?;
    }
    Ok((
        AuthorizedSigner {
            key: signer_key.to_string(),
            name: signer_name.to_string(),
            role,
            listed_as,
            root_key: authority.root_key.clone(),
            root_name: authority.root_name.clone(),
            anchor: anchor_status,
        },
        authority,
    ))
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
