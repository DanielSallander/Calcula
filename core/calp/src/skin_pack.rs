//! FILENAME: core/calp/src/skin_pack.rs
//! PURPOSE: Distributable App Skin payload ("skin pack") — inert presentation
//! data (CSS-variable token overrides + canvas grid overrides + density/font +
//! branding assets), code-free, layered over a light/dark base on the client.
//! CONTEXT: A skin pack is plain signed JSON. It reuses the SAME Ed25519 +
//! SHA-256 trust spine as .calp packages (signing.rs / integrity.rs) but needs
//! none of the sheet/script/pivot machinery — it is colors and fonts. The shape
//! mirrors the frontend `Skin` (camelCase) so the host can apply it directly.

use std::collections::BTreeMap;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::error::CalpError;
use crate::integrity::{self, TrustStatus};
use crate::manifest::{PackageManifest, VersionEntry, VersionManifest};
use crate::registry_id::RegistryScope;
use crate::signing::{verify_signature, PublisherKeypair};
use crate::transport::RegistryTransport;
use crate::version::VersionPin;

/// The single artifact a skin package carries.
pub const SKIN_PACK_ARTIFACT: &str = "skin-pack.json";
/// The `.calp` package kind for a skin (no sheets/scripts/pivots).
pub const SKIN_KIND: &str = "skin";

/// Branding assets a corporate skin may carry. data-URLs or local paths.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkinAssets {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub logo: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
}

/// A distributable skin. Field names mirror the frontend `Skin` interface so the
/// host can return it to the WebView unchanged (serde camelCase).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkinPack {
    /// Pack schema version (forward-compat; ignored by the frontend Skin).
    #[serde(default = "default_schema_version")]
    pub schema_version: u32,
    /// Stable skin id; should match the policy's defaultSkinId.
    pub id: String,
    /// Display name.
    pub name: String,
    /// Baseline to layer over: "light" or "dark".
    pub base: String,
    /// CSS-variable token overrides (delta only).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub tokens: Option<BTreeMap<String, String>>,
    /// Canvas grid overrides (delta only) — kept generic to avoid coupling.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub grid: Option<serde_json::Value>,
    /// Density preset: "comfortable" | "compact".
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub density: Option<String>,
    /// UI font family.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub font_family: Option<String>,
    /// Optional branding assets.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub assets: Option<SkinAssets>,
}

fn default_schema_version() -> u32 {
    1
}

/// Trust outcome of resolving a skin pack from disk.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SkinTrust {
    /// Signed and the signature verified against the expected publisher key.
    Verified,
    /// Signed, valid, and the publisher key was pinned by THIS operation because
    /// the caller was a deliberate trust decision (`PinPolicy::PinOnFirstUse`).
    FirstUse,
    /// Pinned just now for THIS registry, and the same key is already trusted for
    /// this package from another registry — a migration, a mirror, or a second
    /// spelling of one location.
    FirstUseKnownPublisher,
    /// Pinned just now for this registry even though a DIFFERENT key is pinned
    /// for the same package name elsewhere, because the user was shown both and
    /// accepted. Never presented as an ordinary first use.
    FirstUseAcceptedNameConflict,
    /// Signed and the signature is valid, but this machine holds no pin for the
    /// package — nobody here ever agreed to trust that signer. Authentic, NOT
    /// trusted. Kept distinct from `Verified` on purpose: the previous code
    /// collapsed a trust-on-first-use result into `Verified`, so a first-contact
    /// squat rendered in the Appearance panel as a green "verified" badge.
    NotPinned,
    /// Not pinned for this registry, and a DIFFERENT key is pinned for the same
    /// package name from another registry. Two registries claiming one name is
    /// what a hijack looks like — never quietly "not pinned yet".
    NotPinnedNameConflict,
    /// No publisher key expected — applied as unsigned (advisory) data.
    Unsigned,
    /// A signature was required but missing or invalid — REJECTED (not applied).
    Unknown,
}

/// Result of loading + verifying a skin pack from a file.
#[derive(Debug, Clone)]
pub struct LoadedSkin {
    /// The skin pack, or None when verification was required and failed.
    pub skin: Option<SkinPack>,
    pub trust: SkinTrust,
}

/// Load a skin pack JSON from `path`. If `expected_publisher_key` is non-empty,
/// a detached signature at `<path>.sig` (hex) is REQUIRED and must verify over
/// the raw file bytes — otherwise the skin is rejected (`skin: None`,
/// `trust: Unknown`). With no expected key the pack is returned `Unsigned`.
///
/// This reuses the exact `verify_signature` primitive that gates .calp manifests,
/// so a tampered skin pack or a wrong signer is caught the same way.
pub fn load_and_verify_skin(
    path: &Path,
    expected_publisher_key: &str,
) -> Result<LoadedSkin, CalpError> {
    let bytes = std::fs::read(path)?;

    if !expected_publisher_key.is_empty() {
        let sig_path = path.with_extension(match path.extension().and_then(|e| e.to_str()) {
            Some(ext) => format!("{ext}.sig"),
            None => "sig".to_string(),
        });
        if !sig_path.exists() {
            return Ok(LoadedSkin { skin: None, trust: SkinTrust::Unknown });
        }
        let sig_hex = std::fs::read_to_string(&sig_path)?;
        // The package label here is purely for the error context.
        match verify_signature(expected_publisher_key, &bytes, sig_hex.trim(), "skin", "1.0.0") {
            Ok(()) => {
                let skin: SkinPack = serde_json::from_slice(&bytes)?;
                Ok(LoadedSkin { skin: Some(skin), trust: SkinTrust::Verified })
            }
            Err(_) => Ok(LoadedSkin { skin: None, trust: SkinTrust::Unknown }),
        }
    } else {
        let skin: SkinPack = serde_json::from_slice(&bytes)?;
        Ok(LoadedSkin { skin: Some(skin), trust: SkinTrust::Unsigned })
    }
}

// ---------------------------------------------------------------------------
// Remote distribution over the .calp registry rail (transport + signing + integrity)
// ---------------------------------------------------------------------------

/// A skin pulled + verified from a registry.
///
/// The three `*_bytes` fields carry the RAW proof material, not a re-serialized
/// copy: they are what [`verify_cached_skin`] needs to re-establish the same
/// chain offline. Re-serializing `skin` would not be byte-identical and would
/// therefore not hash to the checksum the publisher signed.
#[derive(Debug, Clone)]
pub struct PulledSkin {
    pub skin: SkinPack,
    pub version: String,
    pub publisher_key: String,
    pub publisher_name: String,
    pub trust: SkinTrust,
    /// Raw bytes of the `skin-pack.json` artifact, exactly as published.
    pub skin_bytes: Vec<u8>,
    /// Raw bytes of `version-manifest.json`, exactly as signed.
    pub manifest_bytes: Vec<u8>,
    /// The detached Ed25519 signature (hex) over `manifest_bytes`.
    pub manifest_sig_hex: String,
}

/// Re-verify a skin pack held in a LOCAL, UNTRUSTED cache against the publisher
/// key an administrator authored — the offline twin of [`skin_pull`].
///
/// WHY THIS EXISTS. The org-skin cache lives in the per-user profile directory,
/// which the user (and anything running as the user) can write. It used to be
/// read back, applied, and labelled `"verified"` with no check of any kind, so
/// dropping a JSON file into `%LOCALAPPDATA%\Calcula\skins-cache\` was enough to
/// take over the machine's branding under a green badge — and, because a
/// `refresh: "manual"` policy skips the registry pull whenever a cache file
/// exists, without the genuine registry ever being consulted. That made the
/// cache a way around the `PinPolicy::RequirePinned` gate on the pull itself.
///
/// The chain here is rooted in `%PROGRAMDATA%\Calcula\policy.json`, which is
/// admin-writable only:
///   1. the detached signature must verify over the cached manifest bytes under
///      `expected_publisher_key`;
///   2. the cached skin bytes must hash to the `skin-pack.json` digest recorded
///      in those now-authenticated manifest bytes.
/// Anything else — no key to check against, a forged manifest, swapped payload
/// bytes — is an error, and the caller applies no skin.
pub fn verify_cached_skin(
    skin_bytes: &[u8],
    manifest_bytes: &[u8],
    sig_hex: &str,
    expected_publisher_key: &str,
) -> Result<SkinPack, CalpError> {
    if expected_publisher_key.is_empty() {
        // No trust root to check against. A cache is only ever as good as the
        // key that vouches for it, so an absent key is a refusal, never a pass.
        return Err(CalpError::MissingSignature {
            package: "skin-cache".to_string(),
            version: String::new(),
        });
    }

    verify_signature(
        expected_publisher_key,
        manifest_bytes,
        sig_hex.trim(),
        "skin-cache",
        "cached",
    )?;

    // The manifest is authenticated now, so its checksum map can be trusted.
    let manifest: VersionManifest = serde_json::from_slice(manifest_bytes)?;
    let expected_digest = manifest
        .artifact_checksums
        .get(SKIN_PACK_ARTIFACT)
        .ok_or_else(|| CalpError::MissingChecksums {
            package: manifest.package_name.clone(),
            version: manifest.version.clone(),
        })?;
    if &integrity::sha256_hex(skin_bytes) != expected_digest {
        return Err(CalpError::ChecksumMismatch {
            package: manifest.package_name.clone(),
            version: manifest.version.clone(),
            file: SKIN_PACK_ARTIFACT.to_string(),
        });
    }

    Ok(serde_json::from_slice(skin_bytes)?)
}

/// Publish a skin pack to a registry as a `skin`-kind package version. Mirrors
/// the canonical publish flow (write artifact -> checksum -> write+sign manifest
/// -> update package manifest under lock) but carries only `skin-pack.json` — no
/// sheets/scripts/pivots. The publisher's Ed25519 key (created on first publish)
/// signs the version manifest, so subscribers verify origin + integrity exactly
/// like any .calp package.
pub fn skin_publish(
    registry: &dyn RegistryTransport,
    profile_dir: &Path,
    package_name: &str,
    version: &str,
    now: &str,
    skin: &SkinPack,
) -> Result<(), CalpError> {
    let keypair = PublisherKeypair::load_or_create(profile_dir)?;
    let skin_bytes = serde_json::to_vec_pretty(skin)?;

    // Clear any debris from a prior crashed publish of this exact version.
    let _ = registry.clear_version(package_name, version);
    registry.write_artifact(package_name, version, SKIN_PACK_ARTIFACT, &skin_bytes)?;

    let mut manifest = VersionManifest {
        format_version: 1,
        package_name: package_name.to_string(),
        version: version.to_string(),
        kind: SKIN_KIND.to_string(),
        published_at: now.to_string(),
        published_by: keypair.display_name(),
        publisher_key: keypair.public_key_hex(),
        publisher_name: keypair.display_name(),
        min_app_version: String::new(),
        sheets: Vec::new(),
        named_ranges: Vec::new(),
        tables: Vec::new(),
        locked_sheets: Vec::new(),
        locked_cells: Vec::new(),
        writeback_regions: None,
        model_writebacks: None,
        object_scripts: Vec::new(),
        module_scripts: Vec::new(),
        notebooks: Vec::new(),
        data_sources: Vec::new(),
        custom_objects: Vec::new(),
        artifact_checksums: BTreeMap::new(),
        extra: std::collections::HashMap::new(),
    };

    manifest.artifact_checksums =
        integrity::compute_artifact_checksums_via(registry, package_name, version)?;
    registry.commit_artifacts_as_blobs(package_name, version, &manifest.artifact_checksums)?;
    registry.write_version_manifest(package_name, version, &manifest)?;

    // Sign the RAW on-disk manifest bytes (read back — a re-serialization may not
    // be byte-identical), write the detached signature next to it.
    let manifest_bytes = registry
        .read_artifact(package_name, version, integrity::VERSION_MANIFEST_FILE)?
        .ok_or_else(|| {
            CalpError::Registry(format!("version manifest missing after write for {package_name}@{version}"))
        })?;
    let signature_hex = keypair.sign(&manifest_bytes);
    registry.write_artifact(
        package_name,
        version,
        integrity::VERSION_MANIFEST_SIG_FILE,
        signature_hex.as_bytes(),
    )?;

    // Append the version to the package manifest under the registry lock.
    {
        let _lock = registry.lock()?;
        let mut pkg = registry
            .get_package_manifest(package_name)
            .unwrap_or_else(|_| PackageManifest::new(package_name, SKIN_KIND, &keypair.display_name(), now));
        pkg.versions.retain(|e| e.version != version); // idempotent republish
        pkg.versions.push(VersionEntry {
            version: version.to_string(),
            published_at: now.to_string(),
            published_by: keypair.display_name(),
            extra: std::collections::HashMap::new(),
        });
        registry.write_package_manifest(&pkg)?;
    }

    Ok(())
}

/// Pull + verify a skin pack from a registry. Resolves the version pin, verifies
/// the Ed25519 manifest signature (with TOFU publisher pinning) and the SHA-256
/// artifact integrity BEFORE parsing the payload. Any verification failure
/// (tampered pack, wrong signer, changed key) propagates as a `CalpError`.
///
/// `policy` is required, with no default — see [`integrity::PinPolicy`].
/// `managed_policy::try_remote_pull` (the org-skin path that runs at APP LAUNCH,
/// before any user interaction) passes `RequirePinned`: the administrator's
/// `policy.json` supplies the pin via `publisherKey`, and if it does not, the
/// answer is "no org skin plus a surfaced misconfiguration", never "trust
/// whatever key this registry happens to serve at startup".
pub fn skin_pull(
    registry: &dyn RegistryTransport,
    profile_dir: &Path,
    package_name: &str,
    scope: &RegistryScope,
    pin: &VersionPin,
    policy: integrity::PinPolicy,
) -> Result<PulledSkin, CalpError> {
    let version = registry.resolve_version(package_name, pin)?;
    let version_str = version.to_string();

    // (1) signature + TOFU (over the single trusted manifest copy), then
    // (2) integrity — both before reading the payload.
    let integrity::VerifiedManifest { trust, manifest, .. } =
        integrity::verify_and_load_manifest_via(
            registry,
            package_name,
            &version_str,
            scope,
            profile_dir,
            policy,
        )?;
    integrity::verify_version_artifacts_via(registry, package_name, &version_str, &manifest)?;

    let bytes = registry
        .read_artifact(package_name, &version_str, SKIN_PACK_ARTIFACT)?
        .ok_or_else(|| CalpError::MissingArtifact {
            package: package_name.to_string(),
            version: version_str.clone(),
            file: SKIN_PACK_ARTIFACT.to_string(),
        })?;
    let skin: SkinPack = serde_json::from_slice(&bytes)?;

    // The proof material a later OFFLINE read needs to re-establish this same
    // chain (see `verify_cached_skin`). Both reads are of artifacts that
    // `verify_and_load_manifest_via` has already authenticated above.
    let manifest_bytes = registry
        .read_artifact(package_name, &version_str, integrity::VERSION_MANIFEST_FILE)?
        .ok_or_else(|| CalpError::MissingArtifact {
            package: package_name.to_string(),
            version: version_str.clone(),
            file: integrity::VERSION_MANIFEST_FILE.to_string(),
        })?;
    let manifest_sig_hex = registry
        .read_artifact(
            package_name,
            &version_str,
            integrity::VERSION_MANIFEST_SIG_FILE,
        )?
        .map(|b| String::from_utf8_lossy(&b).trim().to_string())
        .ok_or_else(|| CalpError::MissingSignature {
            package: package_name.to_string(),
            version: version_str.clone(),
        })?;

    Ok(PulledSkin {
        skin,
        skin_bytes: bytes,
        manifest_bytes,
        manifest_sig_hex,
        version: version_str,
        publisher_key: manifest.publisher_key.clone(),
        publisher_name: manifest.publisher_name.clone(),
        // One TOFU state maps to one skin-trust state. Collapsing FirstUse (or
        // NotPinned) into Verified is what let a first-contact squat display a
        // green "verified" badge — never do that again.
        trust: match trust {
            TrustStatus::Verified => SkinTrust::Verified,
            TrustStatus::FirstUse => SkinTrust::FirstUse,
            TrustStatus::FirstUseKnownPublisher => SkinTrust::FirstUseKnownPublisher,
            TrustStatus::FirstUseAcceptedNameConflict => {
                SkinTrust::FirstUseAcceptedNameConflict
            }
            TrustStatus::NotPinned => SkinTrust::NotPinned,
            TrustStatus::NotPinnedNameConflict => SkinTrust::NotPinnedNameConflict,
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::registry::LocalRegistry;
    use crate::registry_id::registry_scope;
    use crate::signing::{load_pins, PinKey, PublisherKeypair};
    use tempfile::TempDir;

    /// The scope a real call site would derive from the registry's location.
    fn scope_of(dir: &TempDir) -> RegistryScope {
        registry_scope(&dir.path().to_string_lossy()).unwrap()
    }

    fn sample_json(id: &str) -> String {
        format!(
            r##"{{"schemaVersion":1,"id":"{id}","name":"Acme","base":"dark","tokens":{{"--accent-primary":"#ff6600"}}}}"##
        )
    }

    #[test]
    fn unsigned_pack_loads_as_unsigned() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("acme.json");
        std::fs::write(&path, sample_json("acme.brand")).unwrap();

        let loaded = load_and_verify_skin(&path, "").unwrap();
        assert_eq!(loaded.trust, SkinTrust::Unsigned);
        let skin = loaded.skin.unwrap();
        assert_eq!(skin.id, "acme.brand");
        assert_eq!(skin.base, "dark");
        assert_eq!(skin.tokens.unwrap().get("--accent-primary").unwrap(), "#ff6600");
    }

    #[test]
    fn signed_pack_verifies() {
        let dir = TempDir::new().unwrap();
        let kp = PublisherKeypair::load_or_create(dir.path()).unwrap();
        let path = dir.path().join("acme.json");
        let json = sample_json("acme.brand");
        std::fs::write(&path, &json).unwrap();
        let sig = kp.sign(json.as_bytes());
        std::fs::write(dir.path().join("acme.json.sig"), &sig).unwrap();

        let loaded = load_and_verify_skin(&path, &kp.public_key_hex()).unwrap();
        assert_eq!(loaded.trust, SkinTrust::Verified);
        assert!(loaded.skin.is_some());
    }

    #[test]
    fn tampered_signed_pack_rejected() {
        let dir = TempDir::new().unwrap();
        let kp = PublisherKeypair::load_or_create(dir.path()).unwrap();
        let path = dir.path().join("acme.json");
        let json = sample_json("acme.brand");
        std::fs::write(&path, &json).unwrap();
        let sig = kp.sign(json.as_bytes());
        std::fs::write(dir.path().join("acme.json.sig"), &sig).unwrap();

        // Tamper with the file AFTER signing.
        std::fs::write(&path, sample_json("acme.evil")).unwrap();

        let loaded = load_and_verify_skin(&path, &kp.public_key_hex()).unwrap();
        assert_eq!(loaded.trust, SkinTrust::Unknown);
        assert!(loaded.skin.is_none(), "tampered skin must not be applied");
    }

    #[test]
    fn signature_required_but_missing_rejects() {
        let dir = TempDir::new().unwrap();
        let kp = PublisherKeypair::load_or_create(dir.path()).unwrap();
        let path = dir.path().join("acme.json");
        std::fs::write(&path, sample_json("acme.brand")).unwrap();
        // No .sig file at all.
        let loaded = load_and_verify_skin(&path, &kp.public_key_hex()).unwrap();
        assert_eq!(loaded.trust, SkinTrust::Unknown);
        assert!(loaded.skin.is_none());
    }

    // --- Remote registry publish/pull ---------------------------------------

    fn make_skin(id: &str) -> SkinPack {
        let mut tokens = BTreeMap::new();
        tokens.insert("--accent-primary".to_string(), "#ff6600".to_string());
        SkinPack {
            schema_version: 1,
            id: id.to_string(),
            name: "Acme".to_string(),
            base: "dark".to_string(),
            tokens: Some(tokens),
            grid: None,
            density: None,
            font_family: None,
            assets: None,
        }
    }

    #[test]
    fn publish_then_pull_roundtrips_verified() {
        let reg_dir = TempDir::new().unwrap();
        let pub_profile = TempDir::new().unwrap();
        let sub_profile = TempDir::new().unwrap();
        let registry = LocalRegistry::open(reg_dir.path()).unwrap();

        skin_publish(
            &registry,
            pub_profile.path(),
            "acme-brand",
            "1.0.0",
            "2026-06-23T00:00:00Z",
            &make_skin("acme.brand"),
        )
        .unwrap();

        let pulled = skin_pull(
            &registry,
            sub_profile.path(),
            "acme-brand",
            &scope_of(&reg_dir),
            &VersionPin::Latest,
            integrity::PinPolicy::PinOnFirstUse,
        )
        .unwrap();

        assert_eq!(pulled.skin.id, "acme.brand");
        assert_eq!(pulled.skin.base, "dark");
        assert_eq!(pulled.version, "1.0.0");
        // A fresh subscriber profile has no pin; PinOnFirstUse creates it and
        // says so. It must NOT masquerade as "Verified".
        assert_eq!(pulled.trust, SkinTrust::FirstUse);
        assert_eq!(
            pulled.skin.tokens.unwrap().get("--accent-primary").unwrap(),
            "#ff6600"
        );
    }

    #[test]
    fn version_pin_resolves_highest_match() {
        let reg_dir = TempDir::new().unwrap();
        let pub_profile = TempDir::new().unwrap();
        let sub_profile = TempDir::new().unwrap();
        let registry = LocalRegistry::open(reg_dir.path()).unwrap();

        for v in ["1.0.0", "1.1.0", "2.0.0"] {
            skin_publish(&registry, pub_profile.path(), "acme-brand", v, "2026-06-23T00:00:00Z", &make_skin("acme.brand")).unwrap();
        }

        // ^1.0 must pick 1.1.0, not 2.0.0.
        let pulled = skin_pull(
            &registry,
            sub_profile.path(),
            "acme-brand",
            &scope_of(&reg_dir),
            &VersionPin::parse("^1.0").unwrap(),
            integrity::PinPolicy::PinOnFirstUse,
        )
        .unwrap();
        assert_eq!(pulled.version, "1.1.0");
    }

    #[test]
    fn tampered_artifact_fails_integrity() {
        let reg_dir = TempDir::new().unwrap();
        let pub_profile = TempDir::new().unwrap();
        let sub_profile = TempDir::new().unwrap();
        let registry = LocalRegistry::open(reg_dir.path()).unwrap();

        skin_publish(&registry, pub_profile.path(), "acme-brand", "1.0.0", "2026-06-23T00:00:00Z", &make_skin("acme.brand")).unwrap();

        // Tamper with the skin-pack.json artifact on disk (after signing).
        registry
            .write_artifact("acme-brand", "1.0.0", SKIN_PACK_ARTIFACT, br#"{"schemaVersion":1,"id":"evil","name":"x","base":"dark"}"#)
            .unwrap();

        let err = skin_pull(&registry, sub_profile.path(), "acme-brand", &scope_of(&reg_dir), &VersionPin::Latest, integrity::PinPolicy::PinOnFirstUse).unwrap_err();
        assert!(matches!(err, CalpError::ChecksumMismatch { .. }), "got {err:?}");
    }

    #[test]
    fn publisher_key_change_is_rejected() {
        let reg_dir = TempDir::new().unwrap();
        let pub_a = TempDir::new().unwrap();
        let pub_b = TempDir::new().unwrap();
        let sub_profile = TempDir::new().unwrap();
        let registry = LocalRegistry::open(reg_dir.path()).unwrap();

        // First publish + pull pins publisher A (TOFU).
        skin_publish(&registry, pub_a.path(), "acme-brand", "1.0.0", "2026-06-23T00:00:00Z", &make_skin("acme.brand")).unwrap();
        skin_pull(&registry, sub_profile.path(), "acme-brand", &scope_of(&reg_dir), &VersionPin::Latest, integrity::PinPolicy::PinOnFirstUse).unwrap();

        // A DIFFERENT publisher (B) republishes a new version to the same package.
        skin_publish(&registry, pub_b.path(), "acme-brand", "2.0.0", "2026-06-23T01:00:00Z", &make_skin("acme.brand")).unwrap();

        let err = skin_pull(&registry, sub_profile.path(), "acme-brand", &scope_of(&reg_dir), &VersionPin::Latest, integrity::PinPolicy::PinOnFirstUse).unwrap_err();
        assert!(matches!(err, CalpError::PublisherKeyChanged { .. }), "got {err:?}");
    }

    /// The org-skin path runs at APP LAUNCH. Under `RequirePinned` an
    /// unrecognised signer is refused outright rather than pinned — the machine
    /// policy's `publisherKey` is the only thing that may seed that pin.
    #[test]
    fn require_pinned_refuses_an_unpinned_signer_and_writes_nothing() {
        let reg_dir = TempDir::new().unwrap();
        let pub_profile = TempDir::new().unwrap();
        let sub_profile = TempDir::new().unwrap();
        let registry = LocalRegistry::open(reg_dir.path()).unwrap();

        skin_publish(&registry, pub_profile.path(), "acme-brand", "1.0.0", "2026-06-23T00:00:00Z", &make_skin("acme.brand")).unwrap();

        let err = skin_pull(
            &registry,
            sub_profile.path(),
            "acme-brand",
            &scope_of(&reg_dir),
            &VersionPin::Latest,
            integrity::PinPolicy::RequirePinned,
        )
        .unwrap_err();
        assert!(matches!(err, CalpError::PublisherNotPinned { .. }), "got {err:?}");
        assert!(
            load_pins(sub_profile.path()).unwrap().is_empty(),
            "a refused startup pull must leave the pin store untouched"
        );
    }

    /// ...and with the administrator's key pre-pinned (what `managed_policy`
    /// does from `%PROGRAMDATA%\\Calcula\\policy.json`) the same pull succeeds
    /// and reports the honest `Verified`.
    #[test]
    fn require_pinned_succeeds_once_the_admin_key_is_pre_pinned() {
        let reg_dir = TempDir::new().unwrap();
        let pub_profile = TempDir::new().unwrap();
        let sub_profile = TempDir::new().unwrap();
        let registry = LocalRegistry::open(reg_dir.path()).unwrap();

        skin_publish(&registry, pub_profile.path(), "acme-brand", "1.0.0", "2026-06-23T00:00:00Z", &make_skin("acme.brand")).unwrap();
        let org_key = PublisherKeypair::load_or_create(pub_profile.path())
            .unwrap()
            .public_key_hex();
        let scope = scope_of(&reg_dir);
        crate::signing::pin_publisher(
            sub_profile.path(),
            &PinKey::calp(&scope, "acme-brand"),
            &scope.label,
            &org_key,
        )
        .unwrap();

        let pulled = skin_pull(
            &registry,
            sub_profile.path(),
            "acme-brand",
            &scope,
            &VersionPin::Latest,
            integrity::PinPolicy::RequirePinned,
        )
        .unwrap();
        assert_eq!(pulled.trust, SkinTrust::Verified);
    }

    /// The admin pre-pin must be written under the SAME scope the pull reads.
    /// If the administrator spells `registryUrl` differently from the way the
    /// pull opens it, the pin lands in one scope and is looked up in another —
    /// which under `RequirePinned` means no org skin at all, silently. This is
    /// the test that catches a second, divergent canonicalizer being introduced.
    #[test]
    fn a_pre_pin_written_from_a_different_spelling_still_verifies() {
        let reg_dir = TempDir::new().unwrap();
        let pub_profile = TempDir::new().unwrap();
        let sub_profile = TempDir::new().unwrap();
        let registry = LocalRegistry::open(reg_dir.path()).unwrap();

        skin_publish(&registry, pub_profile.path(), "acme-brand", "1.0.0", "2026-06-23T00:00:00Z", &make_skin("acme.brand")).unwrap();
        let org_key = PublisherKeypair::load_or_create(pub_profile.path())
            .unwrap()
            .public_key_hex();

        // The administrator typed a forward-slash, upper-case, trailing-slash
        // spelling of the very same folder.
        let admin_spelling = format!(
            "{}/",
            reg_dir.path().to_string_lossy().replace('\\', "/").to_uppercase()
        );
        let admin_scope = registry_scope(&admin_spelling).unwrap();
        crate::signing::pin_publisher(
            sub_profile.path(),
            &PinKey::calp(&admin_scope, "acme-brand"),
            &admin_scope.label,
            &org_key,
        )
        .unwrap();

        let pulled = skin_pull(
            &registry,
            sub_profile.path(),
            "acme-brand",
            &scope_of(&reg_dir),
            &VersionPin::Latest,
            integrity::PinPolicy::RequirePinned,
        )
        .unwrap();
        assert_eq!(pulled.trust, SkinTrust::Verified);
    }
}
