//! FILENAME: core/calp/src/signing.rs
//! PURPOSE: Publisher signing (Ed25519) + TOFU publisher-key pinning (S5 phase 2).
//! CONTEXT: Phase 1 (integrity.rs) made every artifact verifiable from the
//! version manifest via SHA-256, but the manifest itself was unsigned: anyone
//! who can write to the registry could rewrite manifest + checksums together.
//! Phase 2 closes that hole and makes a package's ORIGIN verifiable:
//!
//!   - Each publisher has a persistent Ed25519 keypair in the per-user profile
//!     directory (`publisher-key.json`), created on first publish with the OS
//!     CSPRNG (`rand_core::OsRng`). NEVER use identity::generate_uuid_v7 for
//!     key material — it is a non-crypto PRNG.
//!   - On publish, the RAW BYTES of version-manifest.json as written to disk
//!     are signed; the detached signature is written next to it as
//!     `version-manifest.sig` (hex of the 64-byte signature). The manifest
//!     also carries the publisher's PUBLIC key (`publisher_key`), so the
//!     subscriber knows the asserted signer.
//!   - On pull/refresh/inspect, the signature is verified BEFORE artifact
//!     checksums, and the publisher key is pinned trust-on-first-use:
//!     `trusted-publishers.json` maps packageName -> publisherKeyHex. First
//!     pull pins; later pulls must match the pin, else PublisherKeyChanged.
//!
//! This module owns the keypair, the sign/verify primitives, and the TOFU
//! store. integrity.rs wires them into the pull/inspect verification step.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use ed25519_dalek::{Signature, Signer, SigningKey, VerifyingKey};
use rand_core::OsRng;
use serde::{Deserialize, Serialize};

use crate::error::CalpError;

// ---------------------------------------------------------------------------
// Hex helpers (hand-rolled, matching integrity::sha256_hex — no new dep)
// ---------------------------------------------------------------------------

/// Lowercase hex of a byte slice.
fn to_hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push_str(&format!("{:02x}", b));
    }
    out
}

/// Decode a lowercase/uppercase hex string into bytes. Returns None on any
/// non-hex character or an odd length.
fn from_hex(s: &str) -> Option<Vec<u8>> {
    if s.len() % 2 != 0 {
        return None;
    }
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(s.len() / 2);
    let mut i = 0;
    while i < bytes.len() {
        let hi = (bytes[i] as char).to_digit(16)?;
        let lo = (bytes[i + 1] as char).to_digit(16)?;
        out.push(((hi << 4) | lo) as u8);
        i += 2;
    }
    Some(out)
}

// ---------------------------------------------------------------------------
// Publisher keypair (persisted, created on first publish via OS CSPRNG)
// ---------------------------------------------------------------------------

/// On-disk format for the publisher keypair (publisher-key.json).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PublisherKeyFile {
    format_version: u32,
    /// Hex of the 32-byte Ed25519 secret (signing) key seed.
    secret_key: String,
    /// Hex of the 32-byte Ed25519 public (verifying) key.
    public_key: String,
    /// Human-readable display name (OS username) recorded for convenience.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    display_name: String,
}

/// A publisher's signing identity. Loaded/created from the per-user profile
/// directory, persists across sessions.
pub struct PublisherKeypair {
    signing_key: SigningKey,
    display_name: String,
}

fn publisher_key_file_path(profile_dir: &Path) -> PathBuf {
    profile_dir.join("publisher-key.json")
}

fn os_display_name() -> String {
    std::env::var("USERNAME")
        .or_else(|_| std::env::var("USER"))
        .unwrap_or_else(|_| "Unknown".to_string())
}

impl PublisherKeypair {
    /// Load the publisher keypair from the profile directory, or create one if
    /// none exists. Key material is generated with the OS CSPRNG (OsRng), NOT
    /// the codebase's non-crypto UUID PRNG. The profile directory is created
    /// if needed. Mirrors identity_provider::load_or_create.
    pub fn load_or_create(profile_dir: &Path) -> Result<PublisherKeypair, CalpError> {
        let path = publisher_key_file_path(profile_dir);

        if path.exists() {
            let content = std::fs::read_to_string(&path)?;
            let file: PublisherKeyFile = serde_json::from_str(&content)?;
            let secret = from_hex(&file.secret_key).ok_or_else(|| {
                CalpError::Registry("publisher-key.json: secretKey is not valid hex".to_string())
            })?;
            let seed: [u8; 32] = secret.as_slice().try_into().map_err(|_| {
                CalpError::Registry(
                    "publisher-key.json: secretKey must be 32 bytes".to_string(),
                )
            })?;
            let signing_key = SigningKey::from_bytes(&seed);
            let display_name = if file.display_name.is_empty() {
                os_display_name()
            } else {
                file.display_name
            };
            return Ok(PublisherKeypair {
                signing_key,
                display_name,
            });
        }

        // First publish: generate fresh key material with the OS CSPRNG.
        let signing_key = SigningKey::generate(&mut OsRng);
        let display_name = os_display_name();

        std::fs::create_dir_all(profile_dir)?;
        let file = PublisherKeyFile {
            format_version: 1,
            secret_key: to_hex(&signing_key.to_bytes()),
            public_key: to_hex(signing_key.verifying_key().as_bytes()),
            display_name: display_name.clone(),
        };
        let content = serde_json::to_string_pretty(&file)?;
        std::fs::write(&path, content)?;

        Ok(PublisherKeypair {
            signing_key,
            display_name,
        })
    }

    /// Lowercase hex of the 32-byte public (verifying) key.
    pub fn public_key_hex(&self) -> String {
        to_hex(self.signing_key.verifying_key().as_bytes())
    }

    /// The publisher's display name (OS username).
    pub fn display_name(&self) -> String {
        self.display_name.clone()
    }

    /// Sign arbitrary bytes (the raw on-disk manifest bytes). Returns the
    /// detached 64-byte signature as lowercase hex.
    pub fn sign(&self, bytes: &[u8]) -> String {
        let sig: Signature = self.signing_key.sign(bytes);
        to_hex(&sig.to_bytes())
    }
}

// ---------------------------------------------------------------------------
// Verification primitive
// ---------------------------------------------------------------------------

/// Verify a detached Ed25519 signature over `bytes` against a hex-encoded
/// public key. Any failure — bad hex, wrong key length, wrong signature
/// length, or a signature that does not validate — maps to
/// ManifestSignatureInvalid (the caller supplies package/version context).
///
/// Uses `verify_strict`, which rejects signatures made with small-order /
/// non-canonical keys (the stricter, recommended check).
pub fn verify_signature(
    public_key_hex: &str,
    bytes: &[u8],
    signature_hex: &str,
    package: &str,
    version: &str,
) -> Result<(), CalpError> {
    let invalid = || CalpError::ManifestSignatureInvalid {
        package: package.to_string(),
        version: version.to_string(),
    };

    let key_bytes = from_hex(public_key_hex).ok_or_else(invalid)?;
    let key_arr: [u8; 32] = key_bytes.as_slice().try_into().map_err(|_| invalid())?;
    let verifying_key = VerifyingKey::from_bytes(&key_arr).map_err(|_| invalid())?;

    let sig_bytes = from_hex(signature_hex).ok_or_else(invalid)?;
    let sig_arr: [u8; 64] = sig_bytes.as_slice().try_into().map_err(|_| invalid())?;
    let signature = Signature::from_bytes(&sig_arr);

    verifying_key
        .verify_strict(bytes, &signature)
        .map_err(|_| invalid())
}

// ---------------------------------------------------------------------------
// TOFU store (trusted-publishers.json: packageName -> publisherKeyHex)
// ---------------------------------------------------------------------------

/// On-disk format for the trust-on-first-use publisher pin store.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TrustedPublishersFile {
    format_version: u32,
    /// Map of package name -> pinned publisher public key (hex).
    publishers: BTreeMap<String, String>,
}

impl Default for TrustedPublishersFile {
    fn default() -> Self {
        Self {
            format_version: 1,
            publishers: BTreeMap::new(),
        }
    }
}

fn trusted_publishers_file_path(profile_dir: &Path) -> PathBuf {
    profile_dir.join("trusted-publishers.json")
}

/// Load the TOFU pin map (packageName -> publisherKeyHex). Returns an empty
/// map if the store does not exist yet.
pub fn load_trusted_publishers(
    profile_dir: &Path,
) -> Result<BTreeMap<String, String>, CalpError> {
    let path = trusted_publishers_file_path(profile_dir);
    if !path.exists() {
        return Ok(BTreeMap::new());
    }
    let content = std::fs::read_to_string(&path)?;
    let file: TrustedPublishersFile = serde_json::from_str(&content)?;
    Ok(file.publishers)
}

/// Pin a package's publisher key (trust-on-first-use). Reads the current store,
/// inserts/updates the entry, and writes it back. The profile directory is
/// created if needed.
pub fn pin_publisher(
    profile_dir: &Path,
    package: &str,
    key_hex: &str,
) -> Result<(), CalpError> {
    let mut publishers = load_trusted_publishers(profile_dir)?;
    publishers.insert(package.to_string(), key_hex.to_string());

    std::fs::create_dir_all(profile_dir)?;
    let file = TrustedPublishersFile {
        format_version: 1,
        publishers,
    };
    let content = serde_json::to_string_pretty(&file)?;
    std::fs::write(trusted_publishers_file_path(profile_dir), content)?;
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
    fn hex_roundtrip() {
        let bytes = [0x00u8, 0x01, 0x7f, 0x80, 0xff, 0xab];
        let hex = to_hex(&bytes);
        assert_eq!(hex, "00017f80ffab");
        assert_eq!(from_hex(&hex).unwrap(), bytes);
        // Odd length / non-hex are rejected.
        assert!(from_hex("abc").is_none());
        assert!(from_hex("zz").is_none());
    }

    #[test]
    fn keypair_load_or_create_roundtrip_same_key() {
        let dir = TempDir::new().unwrap();
        let first = PublisherKeypair::load_or_create(dir.path()).unwrap();
        let first_pub = first.public_key_hex();

        // File was created.
        assert!(publisher_key_file_path(dir.path()).exists());

        // Second call returns the SAME key (loaded, not regenerated).
        let second = PublisherKeypair::load_or_create(dir.path()).unwrap();
        assert_eq!(first_pub, second.public_key_hex());

        // Public key is 32 bytes -> 64 hex chars.
        assert_eq!(first_pub.len(), 64);
        assert!(first_pub.chars().all(|c| c.is_ascii_hexdigit() && !c.is_ascii_uppercase()));
    }

    #[test]
    fn sign_then_verify_roundtrip_ok() {
        let dir = TempDir::new().unwrap();
        let kp = PublisherKeypair::load_or_create(dir.path()).unwrap();
        let msg = b"the raw manifest bytes";
        let sig = kp.sign(msg);
        // 64-byte signature -> 128 hex chars.
        assert_eq!(sig.len(), 128);
        verify_signature(&kp.public_key_hex(), msg, &sig, "pkg", "1.0.0").unwrap();
    }

    #[test]
    fn tampered_message_fails_verification() {
        let dir = TempDir::new().unwrap();
        let kp = PublisherKeypair::load_or_create(dir.path()).unwrap();
        let mut msg = b"the raw manifest bytes".to_vec();
        let sig = kp.sign(&msg);

        // Flip one byte of the signed message.
        msg[0] ^= 0x01;
        let err = verify_signature(&kp.public_key_hex(), &msg, &sig, "pkg", "1.0.0")
            .unwrap_err();
        assert!(matches!(err, CalpError::ManifestSignatureInvalid { .. }));
    }

    #[test]
    fn wrong_key_fails_verification() {
        let dir_a = TempDir::new().unwrap();
        let dir_b = TempDir::new().unwrap();
        let kp_a = PublisherKeypair::load_or_create(dir_a.path()).unwrap();
        let kp_b = PublisherKeypair::load_or_create(dir_b.path()).unwrap();
        assert_ne!(kp_a.public_key_hex(), kp_b.public_key_hex());

        let msg = b"signed by A";
        let sig = kp_a.sign(msg);
        // Verify A's signature against B's public key -> invalid.
        let err = verify_signature(&kp_b.public_key_hex(), msg, &sig, "pkg", "1.0.0")
            .unwrap_err();
        assert!(matches!(err, CalpError::ManifestSignatureInvalid { .. }));
    }

    #[test]
    fn malformed_signature_or_key_fails() {
        let dir = TempDir::new().unwrap();
        let kp = PublisherKeypair::load_or_create(dir.path()).unwrap();
        let msg = b"hello";
        // Not hex at all.
        assert!(matches!(
            verify_signature(&kp.public_key_hex(), msg, "nothex", "p", "1.0.0"),
            Err(CalpError::ManifestSignatureInvalid { .. })
        ));
        // Right hex form but wrong length signature.
        assert!(matches!(
            verify_signature(&kp.public_key_hex(), msg, "abcd", "p", "1.0.0"),
            Err(CalpError::ManifestSignatureInvalid { .. })
        ));
        // Bad public key.
        let sig = kp.sign(msg);
        assert!(matches!(
            verify_signature("00", msg, &sig, "p", "1.0.0"),
            Err(CalpError::ManifestSignatureInvalid { .. })
        ));
    }

    #[test]
    fn tofu_store_starts_empty_then_pins() {
        let dir = TempDir::new().unwrap();
        assert!(load_trusted_publishers(dir.path()).unwrap().is_empty());

        pin_publisher(dir.path(), "pkg-a", "aabb").unwrap();
        pin_publisher(dir.path(), "pkg-b", "ccdd").unwrap();

        let map = load_trusted_publishers(dir.path()).unwrap();
        assert_eq!(map.get("pkg-a"), Some(&"aabb".to_string()));
        assert_eq!(map.get("pkg-b"), Some(&"ccdd".to_string()));
        assert!(trusted_publishers_file_path(dir.path()).exists());
    }

    #[test]
    fn tofu_pin_updates_existing_entry() {
        let dir = TempDir::new().unwrap();
        pin_publisher(dir.path(), "pkg", "1111").unwrap();
        pin_publisher(dir.path(), "pkg", "2222").unwrap();
        let map = load_trusted_publishers(dir.path()).unwrap();
        assert_eq!(map.get("pkg"), Some(&"2222".to_string()));
    }
}
