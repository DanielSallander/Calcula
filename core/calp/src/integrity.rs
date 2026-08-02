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
//!   2. pull/refresh/inspect: a `verify_and_load_manifest_via()` step runs
//!      BEFORE `verify_version_artifacts()`, establishing the manifest as a
//!      trusted root; TOFU pins live in the per-user profile dir
//!      (%LOCALAPPDATA%\Calcula\trusted-publishers.json, following the
//!      identity_provider::load_or_create pattern).
//!
//! ---------------------------------------------------------------------------
//! Wave J: pinning is a DECISION, not a side effect
//! ---------------------------------------------------------------------------
//! `verify_and_load_manifest_via` takes a required `PinPolicy`. Verification and
//! trust-CREATION are separate questions, and only an operation the user
//! performed deliberately (Subscribe / Install / admin policy) may answer the
//! second one. See the `PinPolicy` doc comment for the full rationale and the
//! three separate times this bug shipped before the parameter existed.

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

/// Top-level directories inside a version dir that are written AFTER publish
/// as append-only event logs — `submissions/` by subscribers, `reviews/` by
/// the publisher's review actions — and therefore excluded from the signed
/// checksum map (a separate trust domain from published artifacts).
pub const POST_PUBLISH_DIRS: &[&str] = &["submissions", "reviews"];

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
/// - top-level post-publish event directories (`submissions/`, `reviews/`)
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
            if POST_PUBLISH_DIRS.contains(&name_str.as_ref()) {
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
    // storage the artifact set IS the manifest's checksum keys — an
    // unreferenced blob is never pulled. `read_artifact` resolves
    // rel-path -> blob transparently.
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
    // Post-publish injection guard (the transport twin of the fs walk's
    // UnlistedArtifact check): `read_artifact` resolves DIR-FIRST for the
    // pre-dedup layout, so a LOOSE file dropped into the version directory
    // after publish would be served without any checksum coverage. A clean
    // blob-committed version lists nothing here; anything the manifest does
    // not name is injected content (or crashed-publish debris) — reject it.
    for rel in t.list_artifacts(package, version)? {
        if !manifest.artifact_checksums.contains_key(&rel) {
            return Err(CalpError::UnlistedArtifact {
                package: package.to_string(),
                version: version.to_string(),
                file: rel,
            });
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Phase 2: manifest signature verification + TOFU publisher pinning
// ---------------------------------------------------------------------------

/// The outcome of a successful manifest-signature + TOFU check.
///
/// NOTE FOR FUTURE EDITORS: the app-side maps that turn this into a wire string
/// (`calp_commands::calp_pull`, `calp_commands::calp_inspect_package`,
/// `calp_inspector::trust_status_str`) are deliberately EXHAUSTIVE matches with
/// no `_` arm. Adding a variant here must not compile until every one of them —
/// and the frontend presentation map behind it — has been given a row. A trust
/// state that renders as nothing, or falls through to "verified", is a security
/// bug, not a cosmetic one.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TrustStatus {
    /// This package's publisher key was not pinned before; it has now been
    /// pinned (trust-on-first-use) because the caller passed
    /// `PinPolicy::PinOnFirstUse` — i.e. the USER decided to trust this
    /// publisher. The caller should surface this so the user knows they are
    /// trusting a publisher for the first time.
    FirstUse,
    /// The package is signed by the SAME publisher key pinned by an earlier
    /// deliberate trust decision.
    Verified,
    /// The signature is cryptographically valid, but this machine has never
    /// agreed to trust this publisher for this package name, and this operation
    /// was not a trust decision (`PinPolicy::VerifyOnly`), so NOTHING was
    /// written to the pin store.
    ///
    /// AUTHENTIC IS NOT TRUSTED. Anyone can generate an Ed25519 keypair and sign
    /// a package; a valid signature proves only that the bytes were not altered
    /// after signing, never that the signer is who the user expects. Presenting
    /// this as "verified" is exactly the failure this status exists to prevent.
    NotPinned,
}

/// Whether a verification is allowed to CREATE a trust-on-first-use pin.
///
/// WHY THIS PARAMETER EXISTS (read before adding a call site).
///
/// A TOFU pin records "this publisher key is the one I expect for this package
/// name". It is a statement about a decision the USER made. If a pin can be
/// created by an operation the user experiences as passive — a scan, a preview,
/// an inspection, a background refresh, a recalculation — then a file that
/// merely APPEARS somewhere can SQUAT the identity that a genuine publisher will
/// later be measured against. The real publisher's next release then reads as
/// `PublisherKeyChanged`: the attacker's key becomes the trusted one and the
/// legitimate one becomes "possible package hijack".
///
/// That defect has now been found and fixed THREE separate times in this
/// codebase:
///   1. Wave H — extension scanning pinned on every launch
///      (`extension_install.rs`: `decide_extension_trust_for_scan`, the
///      non-trusting `TRUST_NOT_INSTALLED` status).
///   2. Wave I — library resolution pinned on preview
///      (`library_commands.rs`: `verify_library_manifest`, which now takes this
///      same enum).
///   3. Wave J — `.calp` package inspection, workbook open, writeback submit and
///      every GATHER recalculation all pinned, via
///      `verify_and_load_manifest_via`.
///
/// Three occurrences means patching call sites is the wrong fix. So the policy
/// is a REQUIRED parameter with no `Default` and no `Option`: a caller that does
/// not think about pinning does not compile. Pick the variant that names what
/// the USER just did, not what is convenient for the caller.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PinPolicy {
    /// The user has just decided to trust this publisher for this package name
    /// — Subscribe, Install, or an administrator's machine policy. First contact
    /// pins here, and ONLY here. Reports `FirstUse` on first contact.
    PinOnFirstUse,
    /// Look, authenticate, report. Writes nothing to the pin store, ever. Used
    /// by inspection/preview surfaces that exist precisely so the user can
    /// decide. First contact reports `NotPinned`.
    VerifyOnly,
    /// This operation is only meaningful for a package the user ALREADY trusts
    /// (writeback, GATHER, refresh, reset, an org-managed skin). It must run
    /// against an EXISTING pin: first contact is an error
    /// (`CalpError::PublisherNotPinned`), never a pin and never a status the
    /// caller might mistake for success.
    RequirePinned,
}

/// The byte-level core of manifest-signature verification + TOFU. Given the RAW
/// manifest bytes and the detached signature hex (already read by whichever
/// transport), do the cryptographic check against the asserted publisher key and
/// then apply `policy` to the pin store.
///
/// The ONLY place in the codebase that writes a `.calp`/skin publisher pin.
fn verify_manifest_signature_bytes(
    manifest_bytes: &[u8],
    sig_hex: &str,
    manifest: &VersionManifest,
    package: &str,
    profile_dir: &Path,
    policy: PinPolicy,
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

    // (3) TOFU. The store is READ on every path — a key that contradicts an
    // existing pin is refused even on a passive inspection, because a package
    // whose signer changed is exactly what the user must be told about. Only the
    // WRITE is gated by the policy.
    //
    // Fails closed in every direction: an unreadable-but-present pin store makes
    // `load_trusted_publishers` return Err, which propagates rather than being
    // treated as "nothing is pinned".
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
        None => match policy {
            PinPolicy::PinOnFirstUse => {
                crate::signing::pin_publisher(profile_dir, package, &manifest.publisher_key)?;
                Ok(TrustStatus::FirstUse)
            }
            PinPolicy::VerifyOnly => Ok(TrustStatus::NotPinned),
            PinPolicy::RequirePinned => Err(CalpError::PublisherNotPinned {
                package: package.to_string(),
                version: version.to_string(),
                got: manifest.publisher_key.clone(),
            }),
        },
    }
}

/// Transport-agnostic origin gate: read the raw `version-manifest.json` bytes
/// ONCE via the transport, verify the detached `version-manifest.sig` Ed25519
/// signature over *exactly those bytes*, apply TOFU pinning, and return the
/// manifest parsed from the verified bytes together with its trust status.
///
/// This is the ONLY sound way to obtain a trusted manifest over an untrusted
/// transport. A previous design fetched the manifest once for parsing and
/// *re-fetched* it for signature verification; over HTTP those are two
/// independent reads and a hostile server can return a genuinely-signed
/// manifest for the crypto check and a *different* body for the payload (a
/// "split-view" that lets an attacker rewrite `artifact_checksums`,
/// `min_app_version`, or the object inventory under a valid publisher badge).
/// Here the bytes that are cryptographically checked ARE the bytes every
/// downstream gate trusts, so no such divergence is possible.
///
/// An absent signature (or an empty asserted `publisher_key`) means the package
/// is unsigned -> hard error (no backward compat).
///
/// `policy` decides what happens on FIRST CONTACT with a publisher key this
/// machine has never pinned. It is required, and deliberately has no default —
/// see [`PinPolicy`] for why. If you are adding a call site: the question is not
/// "what does my code need", it is "did the user just decide to trust this
/// publisher?". If the answer is no, it is `VerifyOnly` or `RequirePinned`.
pub fn verify_and_load_manifest_via(
    t: &dyn RegistryTransport,
    package: &str,
    version: &str,
    profile_dir: &Path,
    policy: PinPolicy,
) -> Result<(TrustStatus, VersionManifest), CalpError> {
    // The single trusted copy of the manifest bytes. Everything downstream
    // (publisher_key, checksums, min_app_version, inventory) is parsed from
    // exactly these bytes AND is what the signature is checked against.
    let manifest_bytes = t
        .read_artifact(package, version, VERSION_MANIFEST_FILE)?
        .ok_or_else(|| {
            CalpError::Registry(format!(
                "version-manifest.json not found for {package}@{version}"
            ))
        })?;
    let manifest: VersionManifest = serde_json::from_slice(&manifest_bytes)?;

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

    // (2)+(3) Crypto + TOFU over the SAME bytes we parsed `manifest` from.
    let sig_hex = String::from_utf8_lossy(&sig_bytes);
    let trust = verify_manifest_signature_bytes(
        &manifest_bytes,
        sig_hex.trim(),
        &manifest,
        package,
        profile_dir,
        policy,
    )?;
    Ok((trust, manifest))
}

/// `verify_and_load_manifest_via` for the ALREADY-TRUSTED callers: the manifest
/// of a package this machine has previously, deliberately, agreed to trust.
///
/// Returns the manifest ALONE, on purpose. Under `PinPolicy::RequirePinned` the
/// only status that can come back is `TrustStatus::Verified` — first contact is
/// `PublisherNotPinned` and a changed key is `PublisherKeyChanged`, both errors —
/// so there is no trust answer left to discard. That matters: the ten writeback
/// / GATHER / model-writeback sites this function exists for all used to bind the
/// status as `_` and carry on, which is precisely how a fail-open hole hides. A
/// site that cannot obtain a status cannot ignore one.
///
/// Callers that DO need to react to first contact (inspection, subscribe) must
/// call `verify_and_load_manifest_via` and handle every `TrustStatus`.
pub fn load_pinned_manifest_via(
    t: &dyn RegistryTransport,
    package: &str,
    version: &str,
    profile_dir: &Path,
) -> Result<VersionManifest, CalpError> {
    let (trust, manifest) = verify_and_load_manifest_via(
        t,
        package,
        version,
        profile_dir,
        PinPolicy::RequirePinned,
    )?;
    debug_assert_eq!(
        trust,
        TrustStatus::Verified,
        "RequirePinned can only succeed against an existing pin"
    );
    Ok(manifest)
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
        // Post-publish event subtrees: subscriber submissions AND publisher
        // review events are both outside the signed artifact set.
        fs::create_dir_all(ver.join("submissions").join("user-1")).unwrap();
        fs::write(
            ver.join("submissions").join("user-1").join("r1_0_0_s1.json"),
            "{}",
        )
        .unwrap();
        fs::create_dir_all(ver.join("reviews")).unwrap();
        fs::write(ver.join("reviews").join("rev-1.json"), "{}").unwrap();

        let map = compute_artifact_checksums(ver).unwrap();
        let keys: Vec<&String> = map.keys().collect();
        assert_eq!(keys, vec!["named_ranges.json", "sheets/abc/data.json"]);
        assert_eq!(map["sheets/abc/data.json"], sha256_hex(b"data"));
    }

    // -----------------------------------------------------------------------
    // PinPolicy: pinning is a DECISION, not a side effect of verification.
    //
    // The fixture publishes a real signed package (skin_publish is the smallest
    // signed-package producer in the crate — one artifact, one manifest, one
    // detached signature) so these exercise the ACTUAL crypto + TOFU path rather
    // than a mock of it.
    // -----------------------------------------------------------------------

    use crate::registry::LocalRegistry;
    use crate::signing::{load_trusted_publishers, PublisherKeypair};
    use crate::skin_pack::{skin_publish, SkinPack};

    fn tiny_pack(id: &str) -> SkinPack {
        SkinPack {
            schema_version: 1,
            id: id.to_string(),
            name: "Pack".to_string(),
            base: "light".to_string(),
            tokens: None,
            grid: None,
            density: None,
            font_family: None,
            assets: None,
        }
    }

    /// Publish `package` v1.0.0 into a fresh registry, signed by a fresh
    /// publisher profile. Returns (registry dir, registry, publisher key hex).
    fn publish_signed(package: &str) -> (TempDir, TempDir, LocalRegistry, String) {
        let reg_dir = TempDir::new().unwrap();
        let pub_dir = TempDir::new().unwrap();
        let registry = LocalRegistry::open(reg_dir.path()).unwrap();
        skin_publish(
            &registry,
            pub_dir.path(),
            package,
            "1.0.0",
            "2026-07-31T00:00:00Z",
            &tiny_pack("p"),
        )
        .unwrap();
        let key = PublisherKeypair::load_or_create(pub_dir.path())
            .unwrap()
            .public_key_hex();
        (reg_dir, pub_dir, registry, key)
    }

    /// A PASSIVE operation authenticates and reports, and writes NOTHING —
    /// no matter how many times it runs. This is the property that stops an
    /// inspection, a scan or a background read from minting trust.
    #[test]
    fn verify_only_never_writes_the_pin_store() {
        let (_rd, _pd, registry, key) = publish_signed("acme.finance");
        let me = TempDir::new().unwrap();

        for _ in 0..3 {
            let (trust, manifest) = verify_and_load_manifest_via(
                &registry,
                "acme.finance",
                "1.0.0",
                me.path(),
                PinPolicy::VerifyOnly,
            )
            .unwrap();
            // Authentic...
            assert_eq!(manifest.publisher_key, key);
            // ...but NOT trusted, and it stays that way. A file cannot promote
            // itself by being looked at repeatedly.
            assert_eq!(trust, TrustStatus::NotPinned);
            assert!(
                load_trusted_publishers(me.path()).unwrap().is_empty(),
                "a passive verification must leave the pin store untouched"
            );
        }
        assert!(!crate::signing::trusted_publishers_file_path(me.path()).exists());
    }

    /// The COMMIT point still works: first contact pins, and the next contact
    /// reports the pin it created.
    #[test]
    fn pin_on_first_use_pins_and_then_verifies() {
        let (_rd, _pd, registry, key) = publish_signed("acme.finance");
        let me = TempDir::new().unwrap();

        let (first, _) = verify_and_load_manifest_via(
            &registry,
            "acme.finance",
            "1.0.0",
            me.path(),
            PinPolicy::PinOnFirstUse,
        )
        .unwrap();
        assert_eq!(first, TrustStatus::FirstUse);
        assert_eq!(
            load_trusted_publishers(me.path()).unwrap().get("acme.finance"),
            Some(&key)
        );

        let (second, _) = verify_and_load_manifest_via(
            &registry,
            "acme.finance",
            "1.0.0",
            me.path(),
            PinPolicy::PinOnFirstUse,
        )
        .unwrap();
        assert_eq!(second, TrustStatus::Verified);
    }

    /// An ALREADY-TRUSTED operation (writeback, GATHER, refresh, reset, org
    /// skin) refuses first contact outright: not a pin, and not a status the
    /// caller could mistake for success.
    #[test]
    fn require_pinned_refuses_first_contact_and_writes_nothing() {
        let (_rd, _pd, registry, _key) = publish_signed("acme.finance");
        let me = TempDir::new().unwrap();

        let err = verify_and_load_manifest_via(
            &registry,
            "acme.finance",
            "1.0.0",
            me.path(),
            PinPolicy::RequirePinned,
        )
        .unwrap_err();
        assert!(
            matches!(err, CalpError::PublisherNotPinned { .. }),
            "got {err:?}"
        );
        assert!(load_trusted_publishers(me.path()).unwrap().is_empty());

        // `load_pinned_manifest_via` is the same gate with no status to ignore.
        let err2 =
            load_pinned_manifest_via(&registry, "acme.finance", "1.0.0", me.path()).unwrap_err();
        assert!(matches!(err2, CalpError::PublisherNotPinned { .. }));
        assert!(load_trusted_publishers(me.path()).unwrap().is_empty());

        // ...and once the user really does subscribe, it starts working.
        verify_and_load_manifest_via(
            &registry,
            "acme.finance",
            "1.0.0",
            me.path(),
            PinPolicy::PinOnFirstUse,
        )
        .unwrap();
        let m = load_pinned_manifest_via(&registry, "acme.finance", "1.0.0", me.path()).unwrap();
        assert_eq!(m.package_name, "acme.finance");
    }

    /// THE BUG THIS WHOLE CHANGE EXISTS FOR.
    ///
    /// An attacker publishes `acme.finance` under their own key to a registry
    /// the victim merely LOOKS at (an inspection, a workbook that names it, a
    /// background read). Under the old behaviour that look created the pin, so
    /// when the genuine Acme released their package it reported
    /// `PublisherKeyChanged` — the attacker owned the identity and the real
    /// publisher looked like the hijacker.
    #[test]
    fn a_squat_seen_passively_does_not_poison_the_genuine_publisher() {
        let (_erd, _epd, evil_registry, evil_key) = publish_signed("acme.finance");
        let (_grd, _gpd, good_registry, good_key) = publish_signed("acme.finance");
        assert_ne!(evil_key, good_key);

        let me = TempDir::new().unwrap();

        // The victim's machine encounters the squatted package passively.
        let (trust, m) = verify_and_load_manifest_via(
            &evil_registry,
            "acme.finance",
            "1.0.0",
            me.path(),
            PinPolicy::VerifyOnly,
        )
        .unwrap();
        assert_eq!(trust, TrustStatus::NotPinned);
        assert_eq!(m.publisher_key, evil_key);
        assert!(load_trusted_publishers(me.path()).unwrap().is_empty());

        // Later the victim deliberately subscribes to the GENUINE package. This
        // must be an ordinary first use — NOT "publisher changed".
        let (trust2, m2) = verify_and_load_manifest_via(
            &good_registry,
            "acme.finance",
            "1.0.0",
            me.path(),
            PinPolicy::PinOnFirstUse,
        )
        .unwrap();
        assert_eq!(
            trust2,
            TrustStatus::FirstUse,
            "the genuine publisher must not be reported as a key change"
        );
        assert_eq!(m2.publisher_key, good_key);
        assert_eq!(
            load_trusted_publishers(me.path()).unwrap().get("acme.finance"),
            Some(&good_key)
        );
    }

    /// The store is READ on every path, including the passive one: a key that
    /// contradicts an existing pin is refused even when nothing would be
    /// written. "I am not going to pin" is not "I am not going to check".
    #[test]
    fn a_key_contradicting_an_existing_pin_is_refused_even_passively() {
        let (_grd, _gpd, good_registry, good_key) = publish_signed("acme.finance");
        let (_erd, _epd, evil_registry, _evil_key) = publish_signed("acme.finance");

        let me = TempDir::new().unwrap();
        verify_and_load_manifest_via(
            &good_registry,
            "acme.finance",
            "1.0.0",
            me.path(),
            PinPolicy::PinOnFirstUse,
        )
        .unwrap();

        for policy in [
            PinPolicy::VerifyOnly,
            PinPolicy::RequirePinned,
            PinPolicy::PinOnFirstUse,
        ] {
            let err = verify_and_load_manifest_via(
                &evil_registry,
                "acme.finance",
                "1.0.0",
                me.path(),
                policy,
            )
            .unwrap_err();
            assert!(
                matches!(err, CalpError::PublisherKeyChanged { .. }),
                "policy {policy:?} let a contradicting key through: {err:?}"
            );
        }
        // The pin is unchanged by any of those attempts.
        assert_eq!(
            load_trusted_publishers(me.path()).unwrap().get("acme.finance"),
            Some(&good_key)
        );
    }

    // -----------------------------------------------------------------------
    // Structural guard: a caller that forgets to think about pinning must FAIL
    // TO COMPILE, and this module must remain the only place that can pin.
    // -----------------------------------------------------------------------

    #[test]
    fn the_pin_policy_can_never_become_optional_or_defaulted() {
        let src = include_str!("integrity.rs");
        let production = src.split("#[cfg(test)]").next().unwrap();

        // The parameter is REQUIRED and positional. `Option<PinPolicy>` would
        // let a caller pass None; a `Default` impl (or `..Default::default()`)
        // would let one be omitted in a struct-ish call. Either turns "the
        // caller must decide" back into "the caller may forget", which is the
        // bug three waves in a row.
        assert!(
            production.contains("    policy: PinPolicy,"),
            "verify_and_load_manifest_via must take a required `policy: PinPolicy` parameter"
        );
        assert!(
            !production.contains("Option<PinPolicy>"),
            "PinPolicy must never be optional — an omitted policy must not compile"
        );
        assert!(
            !production.contains("impl Default for PinPolicy"),
            "PinPolicy must never have a Default — the default would silently become policy"
        );
        assert!(
            !production.contains("#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]\npub enum PinPolicy"),
            "PinPolicy must never derive Default"
        );

        // And this file must remain the ONLY writer of a .calp publisher pin,
        // reached from exactly one arm.
        assert_eq!(
            production.matches("crate::signing::pin_publisher(").count(),
            1,
            "integrity.rs must contain exactly one pin write, under PinPolicy::PinOnFirstUse"
        );
        let pin_arm = production
            .split("PinPolicy::PinOnFirstUse => {")
            .nth(1)
            .expect("the pin must live in the PinOnFirstUse arm");
        assert!(
            pin_arm.starts_with("\n                crate::signing::pin_publisher("),
            "the pin write must be the first statement of the PinOnFirstUse arm"
        );
    }
}
