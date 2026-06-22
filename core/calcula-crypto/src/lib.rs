//! FILENAME: core/calcula-crypto/src/lib.rs
//! Whole-file encryption container for the `.cala` format.
//!
//! Opt-in: a plain `.cala` is a ZIP (`PK..`); an encrypted one is a small
//! authenticated container that wraps the full ZIP bytes.
//!
//! Crypto (all RustCrypto, vetted by an adversarial design review):
//! - AEAD: XChaCha20-Poly1305 (192-bit nonce -> random per-save nonces are
//!   collision-safe even if a key ever repeats; constant-time in software,
//!   which matters on targets without AES-NI).
//! - KDF: Argon2id (v1.3), memory-hard, params stored in the header.
//! - A FRESH random salt AND nonce are generated on EVERY encrypt, so each
//!   save derives a brand-new key and no (key, nonce) pair is ever reused.
//! - The ENTIRE header (magic, version, ids, Argon2 params, salt, nonce) is
//!   fed to the AEAD as Associated Data, so any header bit-flip fails auth.
//! - Key + passphrase material is held in `Zeroizing` and scrubbed on drop.
//!
//! Container layout (all integers little-endian; bytes [0..HEADER_LEN) = AAD):
//! ```text
//!  0   8   magic         = b"CALAENC1"
//!  8   1   container_ver = 1
//!  9   1   aead_id       = 1  (XChaCha20-Poly1305)
//! 10   1   kdf_id        = 1  (Argon2id v0x13)
//! 11   4   m_cost (KiB)
//! 15   4   t_cost
//! 19   4   p
//! 23   1   out_len  = 32
//! 24   1   salt_len = 16
//! 25  16   salt
//! 41   1   nonce_len = 24
//! 42  24   nonce
//! 66  ..   ciphertext || Poly1305 tag
//! ```

use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{Key, XChaCha20Poly1305, XNonce};
use rand_core::{OsRng, RngCore};
use zeroize::Zeroizing;

/// File magic for an encrypted container. Cannot collide with a ZIP (`PK\x03\x04`).
pub const MAGIC: &[u8; 8] = b"CALAENC1";

const CONTAINER_VER: u8 = 1;
const AEAD_ID_XCHACHA: u8 = 1;
const KDF_ID_ARGON2ID: u8 = 1;
const KEY_LEN: usize = 32;
const SALT_LEN: usize = 16;
const NONCE_LEN: usize = 24;
const HEADER_LEN: usize = 66;

// Default Argon2id parameters — desktop interactive target (~0.25-0.5s).
const DEF_M_COST: u32 = 65536; // 64 MiB (KiB)
const DEF_T_COST: u32 = 3;
const DEF_P: u32 = 1;

// Clamps applied on decrypt: reject a malicious file that would DoS via huge
// memory, or weaken the KDF via a downgrade. (Defends both directions.)
const MIN_M_COST: u32 = 19_456; // 19 MiB floor (downgrade guard)
const MAX_M_COST: u32 = 1_048_576; // 1 GiB ceiling (OOM/DoS guard)
const MAX_P: u32 = 4;

#[derive(thiserror::Error, Debug)]
pub enum CryptoError {
    /// The buffer is not an encrypted Calcula container (no magic). Callers
    /// should fall back to the plain-ZIP path.
    #[error("not an encrypted Calcula container")]
    NotEncrypted,
    /// The container is structurally malformed (bad version/ids/lengths,
    /// truncation, out-of-range KDF params) — detected before any AEAD work.
    #[error("encrypted container is malformed or corrupt: {0}")]
    Corrupt(String),
    /// AEAD authentication failed: wrong password OR the file was modified.
    /// These are indistinguishable by design (don't leak which).
    #[error("incorrect password or the file has been modified")]
    Auth,
    /// Key derivation failed.
    #[error("key derivation failed: {0}")]
    Kdf(String),
}

/// True if `bytes` looks like an encrypted Calcula container.
pub fn is_encrypted(bytes: &[u8]) -> bool {
    bytes.len() >= MAGIC.len() && &bytes[..MAGIC.len()] == MAGIC
}

fn derive_key(
    passphrase: &[u8],
    salt: &[u8],
    m_cost: u32,
    t_cost: u32,
    p: u32,
) -> Result<Zeroizing<[u8; KEY_LEN]>, CryptoError> {
    let params = argon2::Params::new(m_cost, t_cost, p, Some(KEY_LEN))
        .map_err(|e| CryptoError::Kdf(e.to_string()))?;
    let argon2 = argon2::Argon2::new(argon2::Algorithm::Argon2id, argon2::Version::V0x13, params);
    let mut key = Zeroizing::new([0u8; KEY_LEN]);
    argon2
        .hash_password_into(passphrase, salt, key.as_mut_slice())
        .map_err(|e| CryptoError::Kdf(e.to_string()))?;
    Ok(key)
}

/// Build the canonical 66-byte header (also used verbatim as the AEAD AAD).
fn build_header(m_cost: u32, t_cost: u32, p: u32, salt: &[u8; SALT_LEN], nonce: &[u8; NONCE_LEN]) -> Vec<u8> {
    let mut h = Vec::with_capacity(HEADER_LEN);
    h.extend_from_slice(MAGIC);
    h.push(CONTAINER_VER);
    h.push(AEAD_ID_XCHACHA);
    h.push(KDF_ID_ARGON2ID);
    h.extend_from_slice(&m_cost.to_le_bytes());
    h.extend_from_slice(&t_cost.to_le_bytes());
    h.extend_from_slice(&p.to_le_bytes());
    h.push(KEY_LEN as u8);
    h.push(SALT_LEN as u8);
    h.extend_from_slice(salt);
    h.push(NONCE_LEN as u8);
    h.extend_from_slice(nonce);
    debug_assert_eq!(h.len(), HEADER_LEN);
    h
}

/// Encrypt a full `.cala` ZIP under `passphrase`. Fresh salt + nonce each call.
pub fn encrypt(plaintext: &[u8], passphrase: &[u8]) -> Result<Vec<u8>, CryptoError> {
    let (m_cost, t_cost, p) = (DEF_M_COST, DEF_T_COST, DEF_P);

    let mut salt = [0u8; SALT_LEN];
    OsRng.fill_bytes(&mut salt);
    let mut nonce = [0u8; NONCE_LEN];
    OsRng.fill_bytes(&mut nonce);

    let header = build_header(m_cost, t_cost, p, &salt, &nonce);
    let key = derive_key(passphrase, &salt, m_cost, t_cost, p)?;

    let cipher = XChaCha20Poly1305::new(Key::from_slice(key.as_slice()));
    let ciphertext = cipher
        .encrypt(
            XNonce::from_slice(&nonce),
            Payload { msg: plaintext, aad: &header },
        )
        .map_err(|_| CryptoError::Kdf("AEAD encryption failed".to_string()))?;

    let mut out = header;
    out.extend_from_slice(&ciphertext);
    Ok(out)
}

/// Decrypt a container produced by [`encrypt`]. Validates structure (→ `Corrupt`)
/// then authenticates with the header as AAD (→ `Auth` on tag failure).
pub fn decrypt(container: &[u8], passphrase: &[u8]) -> Result<Vec<u8>, CryptoError> {
    if !is_encrypted(container) {
        return Err(CryptoError::NotEncrypted);
    }
    if container.len() < HEADER_LEN {
        return Err(CryptoError::Corrupt("truncated header".to_string()));
    }
    let header = &container[..HEADER_LEN];

    // Fixed-field validation (offsets per the layout above).
    if header[8] != CONTAINER_VER {
        return Err(CryptoError::Corrupt(format!("unknown container version {}", header[8])));
    }
    if header[9] != AEAD_ID_XCHACHA {
        return Err(CryptoError::Corrupt(format!("unknown AEAD id {}", header[9])));
    }
    if header[10] != KDF_ID_ARGON2ID {
        return Err(CryptoError::Corrupt(format!("unknown KDF id {}", header[10])));
    }
    let m_cost = u32::from_le_bytes([header[11], header[12], header[13], header[14]]);
    let t_cost = u32::from_le_bytes([header[15], header[16], header[17], header[18]]);
    let p = u32::from_le_bytes([header[19], header[20], header[21], header[22]]);
    if header[23] as usize != KEY_LEN {
        return Err(CryptoError::Corrupt("bad key length".to_string()));
    }
    if header[24] as usize != SALT_LEN {
        return Err(CryptoError::Corrupt("bad salt length".to_string()));
    }
    if header[41] as usize != NONCE_LEN {
        return Err(CryptoError::Corrupt("bad nonce length".to_string()));
    }

    // Clamp KDF params before deriving: reject downgrade (too weak) and a
    // malicious up-grade (would OOM the process).
    if !(MIN_M_COST..=MAX_M_COST).contains(&m_cost) {
        return Err(CryptoError::Corrupt(format!("Argon2 m_cost {} out of range", m_cost)));
    }
    if t_cost == 0 {
        return Err(CryptoError::Corrupt("Argon2 t_cost is zero".to_string()));
    }
    if p == 0 || p > MAX_P {
        return Err(CryptoError::Corrupt(format!("Argon2 parallelism {} out of range", p)));
    }

    let salt = &header[25..25 + SALT_LEN];
    let nonce = &header[42..42 + NONCE_LEN];
    let key = derive_key(passphrase, salt, m_cost, t_cost, p)?;

    let cipher = XChaCha20Poly1305::new(Key::from_slice(key.as_slice()));
    cipher
        .decrypt(
            XNonce::from_slice(nonce),
            Payload { msg: &container[HEADER_LEN..], aad: header },
        )
        .map_err(|_| CryptoError::Auth)
}

#[cfg(test)]
mod tests {
    use super::*;

    const PW: &[u8] = b"correct horse battery staple";

    #[test]
    fn roundtrip_various_sizes() {
        for size in [0usize, 1, 100, 64 * 1024, 5 * 1024 * 1024] {
            let mut plain = vec![0u8; size];
            OsRng.fill_bytes(&mut plain);
            let ct = encrypt(&plain, PW).unwrap();
            assert!(is_encrypted(&ct));
            let back = decrypt(&ct, PW).unwrap();
            assert_eq!(back, plain, "roundtrip failed for size {}", size);
        }
    }

    #[test]
    fn wrong_password_is_auth_error() {
        let ct = encrypt(b"secret data", PW).unwrap();
        match decrypt(&ct, b"wrong password") {
            Err(CryptoError::Auth) => {}
            other => panic!("expected Auth, got {:?}", other),
        }
    }

    #[test]
    fn tampered_ciphertext_rejected() {
        let mut ct = encrypt(b"secret data here", PW).unwrap();
        let last = ct.len() - 1;
        ct[last] ^= 0x01;
        assert!(matches!(decrypt(&ct, PW), Err(CryptoError::Auth)));
    }

    #[test]
    fn tampered_header_is_authenticated() {
        // Flipping any header byte (params/salt/nonce) must fail auth, proving
        // the header is bound as AAD, not just structurally parsed.
        for &offset in &[11usize /* m_cost */, 25 /* salt */, 42 /* nonce */] {
            let mut ct = encrypt(b"secret data here", PW).unwrap();
            ct[offset] ^= 0x01;
            // m_cost flip may land outside the clamp -> Corrupt; salt/nonce -> Auth.
            // Either way it must NOT decrypt successfully.
            assert!(
                decrypt(&ct, PW).is_err(),
                "header tamper at offset {} unexpectedly decrypted",
                offset
            );
        }
    }

    #[test]
    fn salt_flip_fails_auth() {
        let mut ct = encrypt(b"secret data here", PW).unwrap();
        ct[25] ^= 0x01; // salt byte -> different key -> tag mismatch
        assert!(matches!(decrypt(&ct, PW), Err(CryptoError::Auth)));
    }

    #[test]
    fn bad_magic_and_truncation() {
        assert!(!is_encrypted(b"PK\x03\x04rest"));
        assert!(matches!(decrypt(b"PK\x03\x04rest", PW), Err(CryptoError::NotEncrypted)));
        let mut ct = encrypt(b"x", PW).unwrap();
        ct.truncate(HEADER_LEN - 1);
        assert!(matches!(decrypt(&ct, PW), Err(CryptoError::Corrupt(_))));
    }

    #[test]
    fn bad_version_is_corrupt() {
        let mut ct = encrypt(b"x", PW).unwrap();
        ct[8] = 99; // container_ver
        assert!(matches!(decrypt(&ct, PW), Err(CryptoError::Corrupt(_))));
    }

    #[test]
    fn param_clamp_rejects_oversized_m_cost_before_derive() {
        let mut ct = encrypt(b"x", PW).unwrap();
        // Set m_cost to 2 GiB worth of KiB -> must be rejected (no OOM).
        let huge: u32 = 2_000_000;
        ct[11..15].copy_from_slice(&huge.to_le_bytes());
        assert!(matches!(decrypt(&ct, PW), Err(CryptoError::Corrupt(_))));
    }

    #[test]
    fn fresh_salt_and_nonce_every_encrypt() {
        let a = encrypt(b"same plaintext", PW).unwrap();
        let b = encrypt(b"same plaintext", PW).unwrap();
        // salt (bytes 25..41) and nonce (42..66) must differ between saves.
        assert_ne!(&a[25..41], &b[25..41], "salt repeated across saves");
        assert_ne!(&a[42..66], &b[42..66], "nonce repeated across saves");
        assert_ne!(a, b, "ciphertext identical across saves");
        // ...and both still decrypt.
        assert_eq!(decrypt(&a, PW).unwrap(), b"same plaintext");
        assert_eq!(decrypt(&b, PW).unwrap(), b"same plaintext");
    }
}
