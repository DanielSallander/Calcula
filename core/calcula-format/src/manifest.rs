//! FILENAME: core/calcula-format/src/manifest.rs
//! Manifest (manifest.json) — the root descriptor of a .cala file.

use serde::{Deserialize, Serialize};

/// Root manifest for a .cala file.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    /// Format version (currently 1).
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
    /// Default row height in pixels (omitted when 24.0).
    #[serde(default = "default_row_height", skip_serializing_if = "is_default_row_height")]
    pub default_row_height: f64,
    /// Default column width in pixels (omitted when 100.0).
    #[serde(default = "default_column_width", skip_serializing_if = "is_default_column_width")]
    pub default_column_width: f64,
}

fn default_row_height() -> f64 { 24.0 }
fn default_column_width() -> f64 { 100.0 }
fn is_default_row_height(v: &f64) -> bool { (*v - 24.0).abs() < f64::EPSILON }
fn is_default_column_width(v: &f64) -> bool { (*v - 100.0).abs() < f64::EPSILON }

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
}

impl Manifest {
    /// Create a manifest for a workbook with the given sheet names.
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
                }
            })
            .collect();

        Manifest {
            format_version: 1,
            application: "Calcula".to_string(),
            created: None,
            modified: None,
            sheets,
            active_sheet,
            features: Vec::new(),
            default_row_height: 24.0,
            default_column_width: 100.0,
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
