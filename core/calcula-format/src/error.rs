//! FILENAME: core/calcula-format/src/error.rs
//! Error types for the calcula format crate.

use thiserror::Error;

#[derive(Error, Debug)]
pub enum FormatError {
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),

    #[error("ZIP error: {0}")]
    Zip(#[from] zip::result::ZipError),

    #[error("JSON error: {0}")]
    Json(#[from] serde_json::Error),

    #[error("Invalid format: {0}")]
    InvalidFormat(String),

    #[error("Missing entry: {0}")]
    MissingEntry(String),

    /// The file is an encrypted `.cala` but no password was supplied — the host
    /// should prompt for one and retry.
    #[error("file is encrypted; a password is required")]
    NeedsPassword,

    /// Decryption authentication failed: wrong password OR the file was
    /// modified (indistinguishable by design).
    #[error("incorrect password or the file has been modified")]
    WrongPassword,

    /// The encrypted container is structurally malformed (not a password issue).
    #[error("encrypted file is corrupt: {0}")]
    EncryptedCorrupt(String),
}
