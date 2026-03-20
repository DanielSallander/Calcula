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
}
