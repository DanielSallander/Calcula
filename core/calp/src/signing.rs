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
    /// Load an EXISTING publisher keypair from the profile directory, or
    /// `Ok(None)` if this profile has never published (no publisher-key.json).
    /// Unlike `load_or_create`, this NEVER creates a keypair — it is a
    /// read-only ownership probe used to authorize publisher-only actions.
    pub fn load_existing(profile_dir: &Path) -> Result<Option<PublisherKeypair>, CalpError> {
        let path = publisher_key_file_path(profile_dir);
        if !path.exists() {
            return Ok(None);
        }
        let content = std::fs::read_to_string(&path)?;
        let file: PublisherKeyFile = serde_json::from_str(&content)?;
        let secret = from_hex(&file.secret_key).ok_or_else(|| {
            CalpError::Registry("publisher-key.json: secretKey is not valid hex".to_string())
        })?;
        let seed: [u8; 32] = secret.as_slice().try_into().map_err(|_| {
            CalpError::Registry("publisher-key.json: secretKey must be 32 bytes".to_string())
        })?;
        let signing_key = SigningKey::from_bytes(&seed);
        let display_name = if file.display_name.is_empty() {
            os_display_name()
        } else {
            file.display_name
        };
        Ok(Some(PublisherKeypair {
            signing_key,
            display_name,
        }))
    }

    pub fn load_or_create(profile_dir: &Path) -> Result<PublisherKeypair, CalpError> {
        if let Some(kp) = Self::load_existing(profile_dir)? {
            return Ok(kp);
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
        std::fs::write(publisher_key_file_path(profile_dir), content)?;

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

/// Does the keypair in `profile_dir` prove ownership of `publisher_key`?
///
/// Returns `true` iff this profile has a `publisher-key.json` whose Ed25519
/// public key (DERIVED from the on-disk secret key on load — not merely the
/// stored `publicKey` field) equals `publisher_key`. Because the public key is
/// recomputed from the secret, equality is cryptographically sound PROOF OF
/// POSSESSION of the matching private key: forging it would require breaking
/// Ed25519, not just editing a JSON field.
///
/// This is the authorization primitive for publisher-only actions
/// (approve/reject writeback submissions). An empty `publisher_key` (an
/// unsigned package) can never be owned, so it returns `false`.
pub fn profile_holds_publisher_key(
    profile_dir: &Path,
    publisher_key: &str,
) -> Result<bool, CalpError> {
    if publisher_key.is_empty() {
        return Ok(false);
    }
    match PublisherKeypair::load_existing(profile_dir)? {
        Some(kp) => Ok(kp.public_key_hex() == publisher_key),
        None => Ok(false),
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
    fn load_existing_returns_none_when_no_keypair() {
        let dir = TempDir::new().unwrap();
        // A profile that never published has no publisher-key.json.
        assert!(PublisherKeypair::load_existing(dir.path()).unwrap().is_none());
        // ...and the probe does NOT create one (read-only).
        assert!(!publisher_key_file_path(dir.path()).exists());
    }

    #[test]
    fn profile_holds_publisher_key_authorizes_only_the_owner() {
        // The publisher's profile: publishing created publisher-key.json here.
        let pub_dir = TempDir::new().unwrap();
        let publisher = PublisherKeypair::load_or_create(pub_dir.path()).unwrap();
        let pub_key = publisher.public_key_hex();

        // A different participant's profile (their own, different keypair).
        let sub_dir = TempDir::new().unwrap();
        let _subscriber = PublisherKeypair::load_or_create(sub_dir.path()).unwrap();

        // A profile that has never published at all.
        let empty_dir = TempDir::new().unwrap();

        // Only the publisher's own profile proves ownership of pub_key.
        assert!(profile_holds_publisher_key(pub_dir.path(), &pub_key).unwrap());
        // A different keypair does NOT match.
        assert!(!profile_holds_publisher_key(sub_dir.path(), &pub_key).unwrap());
        // No keypair at all does NOT match (and creates nothing).
        assert!(!profile_holds_publisher_key(empty_dir.path(), &pub_key).unwrap());
        assert!(!publisher_key_file_path(empty_dir.path()).exists());

        // An unsigned package (empty publisher_key) can never be owned.
        assert!(!profile_holds_publisher_key(pub_dir.path(), "").unwrap());
    }

    #[test]
    fn profile_holds_publisher_key_rejects_forged_public_key_field() {
        // Craft a publisher-key.json whose stored publicKey CLAIMS the victim's
        // key but whose secretKey is a different (attacker) seed. The probe must
        // derive the public key from the SECRET and reject the forgery.
        let victim_dir = TempDir::new().unwrap();
        let victim = PublisherKeypair::load_or_create(victim_dir.path()).unwrap();
        let victim_key = victim.public_key_hex();

        let attacker_dir = TempDir::new().unwrap();
        let attacker = PublisherKeypair::load_or_create(attacker_dir.path()).unwrap();
        let attacker_secret = to_hex(&attacker.signing_key.to_bytes());

        // Overwrite the attacker's file: secret = attacker's, but publicKey lies.
        let forged = PublisherKeyFile {
            format_version: 1,
            secret_key: attacker_secret,
            public_key: victim_key.clone(), // the lie
            display_name: "attacker".to_string(),
        };
        std::fs::write(
            publisher_key_file_path(attacker_dir.path()),
            serde_json::to_string_pretty(&forged).unwrap(),
        )
        .unwrap();

        // The probe derives from the secret, so the forgery is rejected.
        assert!(!profile_holds_publisher_key(attacker_dir.path(), &victim_key).unwrap());
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
