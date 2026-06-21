//! FILENAME: core/calp/src/integrity.rs
//! PURPOSE: Package integrity — SHA-256 artifact checksums (S5, phase 1).
//! CONTEXT: On publish, every artifact in a version directory is hashed and
//! the digests are recorded in the version manifest (written last, so the
//! manifest is the integrity root and the publish commit point). On pull —
//! and therefore on refresh, which shares the pull machinery — the whole
//! version directory is re-hashed and compared against the manifest BEFORE
//! anything is materialized:
//!   - listed file with different bytes  -> ChecksumMismatch
//!   - listed file missing from disk     -> MissingArtifact
//!   - on-disk file not listed           -> UnlistedArtifact (no post-publish
//!     file injection)
//!   - empty checksum map                -> MissingChecksums (pre-checksum
//!     packages are rejected, not allowed through; republish to fix)
//!
//! ---------------------------------------------------------------------------
//! Phase 2 seam: publisher signing (Ed25519 + TOFU key pinning)
//! ---------------------------------------------------------------------------
//! The checksum map makes every artifact verifiable from the version manifest,
//! but the manifest itself is still unsigned — anyone who can write to the
//! registry can rewrite manifest + checksums together. Phase 2 plugs in here:
//!   1. publish(): sign the raw bytes of version-manifest.json with the
//!      publisher's Ed25519 key -> detached `version-manifest.sig` sibling.
//!   2. pull/refresh/inspect: a `verify_manifest_signature()` step runs
//!      BEFORE `verify_version_artifacts()`, establishing the manifest as a
//!      trusted root; TOFU pins live in the per-user profile dir
//!      (%LOCALAPPDATA%\Calcula\trusted-publishers.json, following the
//!      identity_provider::load_or_create pattern).

use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

use sha2::{Digest, Sha256};

use crate::error::CalpError;
use crate::manifest::VersionManifest;
use crate::transport::RegistryTransport;

/// The version manifest filename — the integrity root. Never listed in its
/// own checksum map.
pub const VERSION_MANIFEST_FILE: &str = "version-manifest.json";

/// Detached Ed25519 signature over the raw bytes of `version-manifest.json`
/// (S5 phase 2). A sibling of the manifest in the version directory; excluded
/// from the checksum map (it is itself a sealing artifact over the root) for
/// the same reason the manifest is.
pub const VERSION_MANIFEST_SIG_FILE: &str = "version-manifest.sig";

/// Top-level directories inside a version dir that are written by
/// SUBSCRIBERS after publish (separate trust domain) and therefore excluded
/// from the publisher's checksum map.
const SUBSCRIBER_DIRS: &[&str] = &["submissions"];

/// Lowercase hex SHA-256 of a byte slice.
pub fn sha256_hex(bytes: &[u8]) -> String {
    let digest = Sha256::digest(bytes);
    let mut out = String::with_capacity(digest.len() * 2);
    for b in digest {
        out.push_str(&format!("{:02x}", b));
    }
    out
}

/// Walk a version directory and compute SHA-256 digests of every artifact.
///
/// Keys are version-dir-relative paths with forward slashes (the manifest
/// convention, e.g. "sheets/{sheet_id}/data.json"). Excluded:
/// - `version-manifest.json` at the root (the integrity root itself)
/// - top-level subscriber-written directories (`submissions/`)
pub fn compute_artifact_checksums(
    version_dir: &Path,
) -> Result<BTreeMap<String, String>, CalpError> {
    let mut map = BTreeMap::new();
    if !version_dir.exists() {
        return Ok(map);
    }
    for entry in fs::read_dir(version_dir)? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        let name = entry.file_name();
        let name_str = name.to_string_lossy();
        if file_type.is_file() {
            // The manifest is the integrity root; its detached signature
            // (S5 phase 2) seals that root. Neither is listed in the map.
            if name_str == VERSION_MANIFEST_FILE || name_str == VERSION_MANIFEST_SIG_FILE {
                continue;
            }
            let bytes = fs::read(entry.path())?;
            map.insert(name_str.into_owned(), sha256_hex(&bytes));
        } else if file_type.is_dir() {
            if SUBSCRIBER_DIRS.contains(&name_str.as_ref()) {
                continue;
            }
            walk_dir(&entry.path(), version_dir, &mut map)?;
        }
    }
    Ok(map)
}

/// Recursively hash all files under `dir`, keyed relative to `base` with
/// forward slashes.
fn walk_dir(
    dir: &Path,
    base: &Path,
    out: &mut BTreeMap<String, String>,
) -> Result<(), CalpError> {
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        let path = entry.path();
        if file_type.is_dir() {
            walk_dir(&path, base, out)?;
        } else if file_type.is_file() {
            let rel = path.strip_prefix(base).map_err(|e| {
                CalpError::Registry(format!(
                    "Artifact path {} escapes version directory: {}",
                    path.display(),
                    e
                ))
            })?;
            let rel_str = rel
                .components()
                .map(|c| c.as_os_str().to_string_lossy())
                .collect::<Vec<_>>()
                .join("/");
            let bytes = fs::read(&path)?;
            out.insert(rel_str, sha256_hex(&bytes));
        }
    }
    Ok(())
}

/// Verify every artifact in a version directory against the manifest's
/// published checksums. Called at the top of `pull()` — the single chokepoint
/// shared by subscribe and refresh — BEFORE any artifact is materialized.
///
/// This also covers artifacts that the Tauri layer reads lazily after pull
/// (e.g. models/{ds}/model.json): their on-disk bytes are verified here.
pub fn verify_version_artifacts(
    version_dir: &Path,
    manifest: &VersionManifest,
    package: &str,
    version: &str,
) -> Result<(), CalpError> {
    if manifest.artifact_checksums.is_empty() {
        // Pre-checksum package. No backward compatibility: hard error.
        return Err(CalpError::MissingChecksums {
            package: package.to_string(),
            version: version.to_string(),
        });
    }

    let actual = compute_artifact_checksums(version_dir)?;
    compare_checksums(&actual, manifest, package, version)
}

/// Compare a freshly-computed checksum map against the manifest's published
/// checksums. The trust gate shared by the fs-path and transport-agnostic
/// verify paths: a listed file missing/changed, or an unlisted file present,
/// each fails. The empty-map (pre-checksum package) case is handled by the
/// callers BEFORE they compute `actual`.
fn compare_checksums(
    actual: &BTreeMap<String, String>,
    manifest: &VersionManifest,
    package: &str,
    version: &str,
) -> Result<(), CalpError> {
    // Every listed artifact must exist with matching bytes.
    for (file, expected) in &manifest.artifact_checksums {
        match actual.get(file) {
            None => {
                return Err(CalpError::MissingArtifact {
                    package: package.to_string(),
                    version: version.to_string(),
                    file: file.clone(),
                });
            }
            Some(found) if found != expected => {
                return Err(CalpError::ChecksumMismatch {
                    package: package.to_string(),
                    version: version.to_string(),
                    file: file.clone(),
                });
            }
            Some(_) => {}
        }
    }

    // Every on-disk artifact must be listed (no post-publish file injection).
    for file in actual.keys() {
        if !manifest.artifact_checksums.contains_key(file) {
            return Err(CalpError::UnlistedArtifact {
                package: package.to_string(),
                version: version.to_string(),
                file: file.clone(),
            });
        }
    }

    Ok(())
}

// ---------------------------------------------------------------------------
// D8: transport-agnostic integrity — same trust gate over `&dyn RegistryTransport`
// ---------------------------------------------------------------------------

/// Compute SHA-256 digests of every checksummable artifact via the transport
/// (not the filesystem). For each rel-path the transport lists, read its bytes
/// and hash them. The transport's `list_artifacts` already excludes the
/// integrity root, its signature, and the submissions subtree — exactly the set
/// the fs walk excludes — so the resulting map matches the manifest convention.
pub fn compute_artifact_checksums_via(
    t: &dyn RegistryTransport,
    package: &str,
    version: &str,
) -> Result<BTreeMap<String, String>, CalpError> {
    let mut map = BTreeMap::new();
    for rel in t.list_artifacts(package, version)? {
        // list_artifacts only returns paths that exist; a None here would mean
        // the artifact vanished between listing and reading — treat as missing.
        let bytes = t
            .read_artifact(package, version, &rel)?
            .ok_or_else(|| CalpError::MissingArtifact {
                package: package.to_string(),
                version: version.to_string(),
                file: rel.clone(),
            })?;
        map.insert(rel, sha256_hex(&bytes));
    }
    Ok(map)
}

/// Transport-agnostic counterpart to `verify_version_artifacts`: verify every
/// artifact the transport exposes for a version against the manifest's
/// published checksums BEFORE any artifact is materialized.
pub fn verify_version_artifacts_via(
    t: &dyn RegistryTransport,
    package: &str,
    version: &str,
    manifest: &VersionManifest,
) -> Result<(), CalpError> {
    if manifest.artifact_checksums.is_empty() {
        // Pre-checksum package. No backward compatibility: hard error.
        return Err(CalpError::MissingChecksums {
            package: package.to_string(),
            version: version.to_string(),
        });
    }
    // Content-addressed verification: every artifact named in the (signed)
    // manifest must be readable and hash to its published digest. With blob
    // storage the artifact set IS the manifest's checksum keys, so there is no
    // separate dir-walk + unlisted-file check — an unreferenced blob is never
    // pulled. `read_artifact` resolves rel-path -> blob transparently.
    for (rel, expected) in &manifest.artifact_checksums {
        let bytes = t
            .read_artifact(package, version, rel)?
            .ok_or_else(|| CalpError::MissingArtifact {
                package: package.to_string(),
                version: version.to_string(),
                file: rel.clone(),
            })?;
        if sha256_hex(&bytes) != *expected {
            return Err(CalpError::ChecksumMismatch {
                package: package.to_string(),
                version: version.to_string(),
                file: rel.clone(),
            });
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Phase 2: manifest signature verification + TOFU publisher pinning
// ---------------------------------------------------------------------------

/// The outcome of a successful manifest-signature + TOFU check.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrustStatus {
    /// This package's publisher key was not pinned before; it has now been
    /// pinned (trust-on-first-use). The caller should surface this so the user
    /// knows they are trusting a publisher for the first time.
    FirstUse,
    /// The package is signed by the SAME publisher key pinned on a prior pull.
    Verified,
}

/// Verify the manifest's Ed25519 signature and apply trust-on-first-use
/// publisher pinning. Called at the top of `pull()` — BEFORE
/// `verify_version_artifacts()` — so a tampered or wrongly-signed manifest is
/// rejected before its (now-untrusted) checksum map is even consulted.
///
/// Steps:
///   1. Read the RAW bytes of version-manifest.json and the detached
///      `version-manifest.sig`. A missing signature file OR an empty
///      `manifest.publisher_key` means the package is unsigned: hard error
///      (MissingSignature), no backward compatibility — mirrors MissingChecksums.
///   2. Verify the signature over those raw bytes against the manifest's
///      asserted `publisher_key` (invalid -> ManifestSignatureInvalid).
///   3. TOFU: consult `trusted-publishers.json` in `profile_dir`. If the
///      package is already pinned and the pin differs from the asserted key,
///      reject (PublisherKeyChanged). If pinned and equal -> Verified. If not
///      yet pinned -> pin it now and report FirstUse.
pub fn verify_manifest_signature(
    version_dir: &Path,
    manifest: &VersionManifest,
    package: &str,
    profile_dir: &Path,
) -> Result<TrustStatus, CalpError> {
    let version = manifest.version.as_str();

    // (1) Unsigned packages are rejected outright (no backward compat).
    let sig_path = version_dir.join(VERSION_MANIFEST_SIG_FILE);
    if manifest.publisher_key.is_empty() || !sig_path.exists() {
        return Err(CalpError::MissingSignature {
            package: package.to_string(),
            version: version.to_string(),
        });
    }

    // Sign/verify the RAW on-disk bytes — never a re-serialization of the
    // parsed manifest (re-serializing may not be byte-identical).
    let manifest_path = version_dir.join(VERSION_MANIFEST_FILE);
    let manifest_bytes = fs::read(&manifest_path)?;
    let sig_hex = fs::read_to_string(&sig_path)?;

    verify_manifest_signature_bytes(
        &manifest_bytes,
        sig_hex.trim(),
        manifest,
        package,
        profile_dir,
    )
}

/// The byte-level core of manifest-signature verification + TOFU pinning,
/// shared by the fs-path `verify_manifest_signature` and the transport-agnostic
/// `verify_manifest_signature_via`. Given the RAW manifest bytes and the
/// detached signature hex (already read by whichever transport), do the
/// cryptographic check against the asserted publisher key and apply TOFU.
fn verify_manifest_signature_bytes(
    manifest_bytes: &[u8],
    sig_hex: &str,
    manifest: &VersionManifest,
    package: &str,
    profile_dir: &Path,
) -> Result<TrustStatus, CalpError> {
    let version = manifest.version.as_str();

    // (2) Cryptographic verification against the asserted publisher key.
    crate::signing::verify_signature(
        &manifest.publisher_key,
        manifest_bytes,
        sig_hex,
        package,
        version,
    )?;

    // (3) Trust-on-first-use pinning.
    let pinned = crate::signing::load_trusted_publishers(profile_dir)?;
    match pinned.get(package) {
        Some(pinned_key) if pinned_key != &manifest.publisher_key => {
            Err(CalpError::PublisherKeyChanged {
                package: package.to_string(),
                version: version.to_string(),
                pinned: pinned_key.clone(),
                got: manifest.publisher_key.clone(),
            })
        }
        Some(_) => Ok(TrustStatus::Verified),
        None => {
            crate::signing::pin_publisher(profile_dir, package, &manifest.publisher_key)?;
            Ok(TrustStatus::FirstUse)
        }
    }
}

/// Transport-agnostic counterpart to `verify_manifest_signature`: read the raw
/// `version-manifest.json` bytes and the detached `version-manifest.sig` via the
/// transport, then run the same crypto + TOFU gate. An absent signature (or an
/// empty asserted `publisher_key`) means the package is unsigned -> hard error.
pub fn verify_manifest_signature_via(
    t: &dyn RegistryTransport,
    package: &str,
    version: &str,
    manifest: &VersionManifest,
    profile_dir: &Path,
) -> Result<TrustStatus, CalpError> {
    // (1) Unsigned packages are rejected outright (no backward compat).
    let sig_bytes = t.read_artifact(package, version, VERSION_MANIFEST_SIG_FILE)?;
    let sig_bytes = match (manifest.publisher_key.is_empty(), sig_bytes) {
        (false, Some(sig)) => sig,
        _ => {
            return Err(CalpError::MissingSignature {
                package: package.to_string(),
                version: version.to_string(),
            });
        }
    };

    // Read the RAW manifest bytes via the transport — never a re-serialization
    // of the parsed manifest (re-serializing may not be byte-identical).
    let manifest_bytes = t
        .read_artifact(package, version, VERSION_MANIFEST_FILE)?
        .ok_or_else(|| CalpError::MissingSignature {
            package: package.to_string(),
            version: version.to_string(),
        })?;

    let sig_hex = String::from_utf8_lossy(&sig_bytes);
    verify_manifest_signature_bytes(
        &manifest_bytes,
        sig_hex.trim(),
        manifest,
        package,
        profile_dir,
    )
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn sha256_hex_known_vector() {
        // NIST test vector: SHA-256("abc")
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        // Empty input
        assert_eq!(
            sha256_hex(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }

    #[test]
    fn compute_skips_manifest_and_submissions_and_uses_forward_slashes() {
        let dir = TempDir::new().unwrap();
        let ver = dir.path();
        fs::write(ver.join(VERSION_MANIFEST_FILE), "{}").unwrap();
        fs::create_dir_all(ver.join("sheets").join("abc")).unwrap();
        fs::write(ver.join("sheets").join("abc").join("data.json"), "data").unwrap();
        fs::write(ver.join("named_ranges.json"), "[]").unwrap();
        fs::create_dir_all(ver.join("submissions").join("user-1")).unwrap();
        fs::write(
            ver.join("submissions").join("user-1").join("r1_0_0.json"),
            "{}",
        )
        .unwrap();

        let map = compute_artifact_checksums(ver).unwrap();
        let keys: Vec<&String> = map.keys().collect();
        assert_eq!(keys, vec!["named_ranges.json", "sheets/abc/data.json"]);
        assert_eq!(map["sheets/abc/data.json"], sha256_hex(b"data"));
    }
}
