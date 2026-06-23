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
#[derive(Debug, Clone)]
pub struct PulledSkin {
    pub skin: SkinPack,
    pub version: String,
    pub publisher_key: String,
    pub publisher_name: String,
    pub trust: SkinTrust,
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
        object_scripts: Vec::new(),
        module_scripts: Vec::new(),
        notebooks: Vec::new(),
        data_sources: Vec::new(),
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
pub fn skin_pull(
    registry: &dyn RegistryTransport,
    profile_dir: &Path,
    package_name: &str,
    pin: &VersionPin,
) -> Result<PulledSkin, CalpError> {
    let version = registry.resolve_version(package_name, pin)?;
    let version_str = version.to_string();
    let manifest = registry.get_version_manifest(package_name, &version_str)?;

    // (1) signature + TOFU, then (2) integrity — both before reading the payload.
    let trust =
        integrity::verify_manifest_signature_via(registry, package_name, &version_str, &manifest, profile_dir)?;
    integrity::verify_version_artifacts_via(registry, package_name, &version_str, &manifest)?;

    let bytes = registry
        .read_artifact(package_name, &version_str, SKIN_PACK_ARTIFACT)?
        .ok_or_else(|| CalpError::MissingArtifact {
            package: package_name.to_string(),
            version: version_str.clone(),
            file: SKIN_PACK_ARTIFACT.to_string(),
        })?;
    let skin: SkinPack = serde_json::from_slice(&bytes)?;

    Ok(PulledSkin {
        skin,
        version: version_str,
        publisher_key: manifest.publisher_key.clone(),
        publisher_name: manifest.publisher_name.clone(),
        // Both FirstUse and Verified mean the signature checked out; managed
        // installs pre-pin the org key so this is Verified in practice.
        trust: match trust {
            TrustStatus::Verified | TrustStatus::FirstUse => SkinTrust::Verified,
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::registry::LocalRegistry;
    use crate::signing::PublisherKeypair;
    use tempfile::TempDir;

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
            &VersionPin::Latest,
        )
        .unwrap();

        assert_eq!(pulled.skin.id, "acme.brand");
        assert_eq!(pulled.skin.base, "dark");
        assert_eq!(pulled.version, "1.0.0");
        assert_eq!(pulled.trust, SkinTrust::Verified);
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
        let pulled = skin_pull(&registry, sub_profile.path(), "acme-brand", &VersionPin::parse("^1.0").unwrap()).unwrap();
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

        let err = skin_pull(&registry, sub_profile.path(), "acme-brand", &VersionPin::Latest).unwrap_err();
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
        skin_pull(&registry, sub_profile.path(), "acme-brand", &VersionPin::Latest).unwrap();

        // A DIFFERENT publisher (B) republishes a new version to the same package.
        skin_publish(&registry, pub_b.path(), "acme-brand", "2.0.0", "2026-06-23T01:00:00Z", &make_skin("acme.brand")).unwrap();

        let err = skin_pull(&registry, sub_profile.path(), "acme-brand", &VersionPin::Latest).unwrap_err();
        assert!(matches!(err, CalpError::PublisherKeyChanged { .. }), "got {err:?}");
    }
}
