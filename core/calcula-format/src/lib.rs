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
//! ...
//! ```

mod error;
mod manifest;
mod cell_ref;
mod sheet_data;
mod sheet_styles;
mod sheet_layout;
mod zip_io;
pub mod features;
pub mod ai;

pub use error::FormatError;
pub use manifest::{Manifest, SheetEntry};

use persistence::Workbook;

/// Save a workbook to the `.cala` format (ZIP archive).
pub fn save_calcula(workbook: &Workbook, path: &std::path::Path) -> Result<(), FormatError> {
    zip_io::write_calcula(workbook, path)
}

/// Load a workbook from the `.cala` format (ZIP archive).
pub fn load_calcula(path: &std::path::Path) -> Result<Workbook, FormatError> {
    zip_io::read_calcula(path)
}
