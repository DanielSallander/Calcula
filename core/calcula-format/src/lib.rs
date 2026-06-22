//! FILENAME: core/calcula-format/src/lib.rs
//! Calcula Native File Format (.cala)
//!
//! The `.cala` format is a ZIP archive containing structured JSON files.
//! Users see a single file; internally it's organized for AI readability,
//! git-friendliness, and efficient partial loading.
//!
//! Internal ZIP structure:
//! ```text
//! manifest.json
//! styles/registry.json
//! sheets/0_SheetName/data.json
//! sheets/0_SheetName/styles.json
//! sheets/0_SheetName/layout.json
//! tables/table_1.json
//! files/README.md              (user files)
//! files/docs/notes.txt         (user files in folders)
//! ...
//! ```

mod error;
mod manifest;
mod cell_ref;
pub mod sheet_data;
pub mod sheet_styles;
pub mod sheet_layout;
pub mod sheet_metadata;
mod zip_io;
mod atomic;
pub mod features;
pub mod ai;

pub use error::FormatError;
pub use manifest::{Manifest, SheetEntry};
// Re-export so the host can build/parse the ZIP bytes directly when needed.
pub use zip_io::{read_calcula_bytes, write_calcula_bytes};


use persistence::Workbook;

/// Save a workbook to `.cala`, optionally encrypting the whole file.
///
/// `password = None` writes a plain ZIP (default, unchanged behavior).
/// `password = Some(pw)` wraps the ZIP in an authenticated encryption container
/// (XChaCha20-Poly1305 + Argon2id). Either way the write is ATOMIC (temp file +
/// fsync + rename) so an interrupted save never corrupts the existing file.
pub fn save_calcula_opt(
    workbook: &Workbook,
    path: &std::path::Path,
    password: Option<&[u8]>,
) -> Result<(), FormatError> {
    let plain = zip_io::write_calcula_bytes(workbook)?;
    let out = match password {
        Some(pw) => calcula_crypto::encrypt(&plain, pw)
            .map_err(|e| FormatError::InvalidFormat(format!("encryption failed: {}", e)))?,
        None => plain,
    };
    atomic::atomic_write(path, &out)
}

/// Load a workbook from `.cala`. If the file is encrypted:
/// - `password = None` -> `Err(NeedsPassword)` (host prompts and retries),
/// - wrong password / tamper -> `Err(WrongPassword)`,
/// - structural damage -> `Err(EncryptedCorrupt)`.
/// A plain (unencrypted) file ignores `password`.
pub fn load_calcula_opt(
    path: &std::path::Path,
    password: Option<&[u8]>,
) -> Result<Workbook, FormatError> {
    let bytes = std::fs::read(path)?;
    if calcula_crypto::is_encrypted(&bytes) {
        let pw = password.ok_or(FormatError::NeedsPassword)?;
        let plain = calcula_crypto::decrypt(&bytes, pw).map_err(|e| match e {
            calcula_crypto::CryptoError::Auth => FormatError::WrongPassword,
            calcula_crypto::CryptoError::Corrupt(m) => FormatError::EncryptedCorrupt(m),
            calcula_crypto::CryptoError::NotEncrypted => {
                FormatError::EncryptedCorrupt("encryption magic vanished".to_string())
            }
            calcula_crypto::CryptoError::Kdf(m) => FormatError::EncryptedCorrupt(m),
        })?;
        zip_io::read_calcula_bytes(&plain)
    } else {
        zip_io::read_calcula_bytes(&bytes)
    }
}

/// Save a workbook to the plain (unencrypted) `.cala` format. Atomic write.
pub fn save_calcula(workbook: &Workbook, path: &std::path::Path) -> Result<(), FormatError> {
    save_calcula_opt(workbook, path, None)
}

/// Load a workbook from a plain `.cala` file. (An encrypted file yields
/// `NeedsPassword`; use `load_calcula_opt` with a password.)
pub fn load_calcula(path: &std::path::Path) -> Result<Workbook, FormatError> {
    load_calcula_opt(path, None)
}
