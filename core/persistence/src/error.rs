//! FILENAME: core/persistence/src/error.rs

use thiserror::Error;

#[derive(Error, Debug)]
pub enum PersistenceError {
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),

    #[error("XLSX write error: {0}")]
    XlsxWrite(#[from] rust_xlsxwriter::XlsxError),

    #[error("XLSX read error: {0}")]
    XlsxRead(#[from] calamine::XlsxError),

    #[error("Invalid file format: {0}")]
    InvalidFormat(String),

    #[error("Sheet not found: {0}")]
    SheetNotFound(String),
}