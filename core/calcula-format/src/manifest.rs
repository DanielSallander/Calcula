//! FILENAME: core/calcula-format/src/manifest.rs
//! Manifest (manifest.json) — the root descriptor of a .cala file.

use identity::SheetId;
use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// Format version chain
// ---------------------------------------------------------------------------
//
// The `.cala` archive carries ONE `format_version` in its manifest, and the
// rule mirrors the BI model's stamp chain (`stamp_feature_format_version` in
// bi/commands.rs): the writer stamps the HIGHEST minimum any feature actually
// present in this document requires, raising it and never lowering it, and the
// reader refuses anything above what it understands.
//
// Why a feature ever gets a link in this chain: not because it is new, but
// because an older reader would MISHANDLE it. Simply ignoring an unknown
// section is usually fine — the section is dropped on the next save, and the
// user loses cosmetic state. That calculus changes for persisted automation:
// silently dropping `scheduled_jobs.json` disarms schedules the user still
// believes are running, with no error anywhere. So the scheduler takes a link
// (see `features::scheduled_jobs::SCHEDULED_JOBS_MIN_FORMAT_VERSION`) and an
// older build fails the open loudly instead.

/// The floor every `.cala` carries: the original archive layout.
pub const CALA_BASE_FORMAT_VERSION: u32 = 1;

/// The highest `format_version` THIS build knows how to read. A file stamped
/// above this is refused rather than partially understood.
pub const CALA_MAX_SUPPORTED_FORMAT_VERSION: u32 = 2;

/// Raise (never lower) a manifest's `format_version` to the minimum a present
/// feature requires. Idempotent, and safe to call once per feature.
pub fn stamp_feature_format_version(manifest: &mut Manifest, minimum: u32) {
    if minimum > manifest.format_version {
        manifest.format_version = minimum;
    }
}

/// Root manifest for a .cala file.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    /// Format version: `CALA_BASE_FORMAT_VERSION`, raised by
    /// `stamp_feature_format_version` to the highest minimum any feature
    /// present in this document requires.
    pub format_version: u32,
    /// Application identifier.
    pub application: String,
    /// ISO 8601 creation timestamp.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub created: Option<String>,
    /// ISO 8601 last modified timestamp.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub modified: Option<String>,
    /// Sheet entries in order.
    pub sheets: Vec<SheetEntry>,
    /// Index of the active sheet.
    pub active_sheet: usize,
    /// Declares which optional feature sections are present in the archive.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub features: Vec<String>,
    /// Default row height in pixels (omitted when 20.0 — Excel's Calibri-11 default).
    #[serde(default = "default_row_height", skip_serializing_if = "is_default_row_height")]
    pub default_row_height: f64,
    /// Default column width in pixels (omitted when 64.29 — Excel's 8.47-char default).
    #[serde(default = "default_column_width", skip_serializing_if = "is_default_column_width")]
    pub default_column_width: f64,
}

fn default_row_height() -> f64 { 20.0 }
fn default_column_width() -> f64 { 64.29 }
fn is_default_row_height(v: &f64) -> bool { (*v - 20.0).abs() < f64::EPSILON }
fn is_default_column_width(v: &f64) -> bool { (*v - 64.29).abs() < 1e-6 }

/// Entry for a single sheet in the manifest.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SheetEntry {
    /// Sheet index (0-based).
    pub index: usize,
    /// Display name of the sheet.
    pub name: String,
    /// Folder name inside sheets/ (e.g., "0_Sales").
    pub folder: String,
    /// Stable sheet identity (UUID v7). Optional for backward compat with old .cala files.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sheet_id: Option<SheetId>,
}

impl Manifest {
    /// Create a manifest for a workbook with the given sheet names and IDs.
    pub fn from_sheets(names: &[String], ids: &[SheetId], active_sheet: usize) -> Self {
        let sheets = names
            .iter()
            .zip(ids.iter())
            .enumerate()
            .map(|(i, (name, id))| {
                let folder = format!("{}_{}", i, sanitize_folder_name(name));
                SheetEntry {
                    index: i,
                    name: name.clone(),
                    folder,
                    sheet_id: Some(*id),
                }
            })
            .collect();

        Manifest {
            format_version: CALA_BASE_FORMAT_VERSION,
            application: "Calcula".to_string(),
            created: None,
            modified: None,
            sheets,
            active_sheet,
            features: Vec::new(),
            default_row_height: 20.0,
            default_column_width: 64.29,
        }
    }

    /// Create a manifest for a workbook with the given sheet names (mints no IDs — for tests).
    pub fn from_sheet_names(names: &[String], active_sheet: usize) -> Self {
        let sheets = names
            .iter()
            .enumerate()
            .map(|(i, name)| {
                let folder = format!("{}_{}", i, sanitize_folder_name(name));
                SheetEntry {
                    index: i,
                    name: name.clone(),
                    folder,
                    sheet_id: None,
                }
            })
            .collect();

        Manifest {
            format_version: CALA_BASE_FORMAT_VERSION,
            application: "Calcula".to_string(),
            created: None,
            modified: None,
            sheets,
            active_sheet,
            features: Vec::new(),
            default_row_height: 20.0,
            default_column_width: 64.29,
        }
    }
}

/// Sanitize a sheet name for use as a folder name.
/// Replaces characters that are problematic in file paths.
fn sanitize_folder_name(name: &str) -> String {
    name.chars()
        .map(|c| match c {
            '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '_',
            _ => c,
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_manifest_serialization() {
        let manifest = Manifest::from_sheet_names(
            &["Sales".to_string(), "Summary".to_string()],
            0,
        );
        let json = serde_json::to_string_pretty(&manifest).unwrap();
        let parsed: Manifest = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.format_version, 1);
        assert_eq!(parsed.sheets.len(), 2);
        assert_eq!(parsed.sheets[0].folder, "0_Sales");
        assert_eq!(parsed.sheets[1].folder, "1_Summary");
    }

    #[test]
    fn test_sanitize_folder_name() {
        assert_eq!(sanitize_folder_name("Sheet1"), "Sheet1");
        assert_eq!(sanitize_folder_name("Q1/Q2 Report"), "Q1_Q2 Report");
        assert_eq!(sanitize_folder_name("Data:Raw"), "Data_Raw");
    }
}
