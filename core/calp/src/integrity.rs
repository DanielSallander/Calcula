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

/// The version manifest filename — the integrity root. Never listed in its
/// own checksum map.
pub const VERSION_MANIFEST_FILE: &str = "version-manifest.json";

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
            if name_str == VERSION_MANIFEST_FILE {
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
