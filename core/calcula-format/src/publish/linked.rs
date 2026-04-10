//! FILENAME: core/calcula-format/src/publish/linked.rs
//! Linked sheet metadata — tracks which sheets in a workbook are linked
//! to a published source and their sync state.

use crate::sheet_layout::SheetLayout;
use serde::{Deserialize, Serialize};

/// Metadata for a single linked sheet in the consumer's workbook.
/// Stored in `_meta/linked_sheets.json` inside the `.cala` archive.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkedSheetInfo {
    /// Local sheet index in the consumer's workbook.
    pub sheet_index: usize,
    /// Stable ID of the published sheet this links to.
    pub published_sheet_id: String,
    /// Version of the published sheet at last sync.
    pub synced_version: u64,
    /// Path to the publication directory (e.g., "C:/shared/models/sales.calp-pub/").
    pub source_path: String,
    /// Folder name within the publication directory (e.g., "0_SalesDashboard").
    pub source_folder: String,
    /// Checksum of last synced data (for quick change detection).
    pub synced_checksum: String,
    /// ISO 8601 timestamp of last successful refresh.
    pub last_refreshed: String,
    /// Consumer's local layout overrides (column widths, row heights).
    /// These survive refresh. `None` means use the source layout as-is.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub layout_overrides: Option<SheetLayout>,
}

/// Status of a linked sheet relative to its published source.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkedSheetStatus {
    /// Local sheet index.
    pub sheet_index: usize,
    /// Current sync state.
    pub state: LinkState,
    /// Local synced version.
    pub local_version: u64,
    /// Remote version (if source is available).
    pub remote_version: Option<u64>,
    /// Human-readable message.
    pub message: String,
}

/// Sync state of a linked sheet.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum LinkState {
    /// Local version matches remote.
    UpToDate,
    /// Remote has a newer version.
    Stale,
    /// Cannot reach the publication directory.
    SourceUnavailable,
}

/// Result of a refresh operation on a linked sheet.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RefreshResult {
    /// Local sheet index.
    pub sheet_index: usize,
    /// Whether any data was actually updated.
    pub updated: bool,
    /// Version before refresh.
    pub old_version: u64,
    /// Version after refresh (same as old if not updated).
    pub new_version: u64,
    /// Warnings generated during refresh (e.g., schema changes).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub warnings: Vec<String>,
}

/// Result of linking published sheets into a workbook.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkResult {
    /// Sheet indices of the newly linked sheets in the consumer's workbook.
    pub linked_sheet_indices: Vec<usize>,
    /// Names of the newly linked sheets.
    pub linked_sheet_names: Vec<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_linked_sheet_info_roundtrip() {
        let info = LinkedSheetInfo {
            sheet_index: 2,
            published_sheet_id: "sales-dashboard".to_string(),
            synced_version: 3,
            source_path: "C:/shared/models/sales.calp-pub/".to_string(),
            source_folder: "0_SalesDashboard".to_string(),
            synced_checksum: "sha256:abc123".to_string(),
            last_refreshed: "2026-04-09T12:00:00Z".to_string(),
            layout_overrides: None,
        };

        let json = serde_json::to_string_pretty(&info).unwrap();
        let parsed: LinkedSheetInfo = serde_json::from_str(&json).unwrap();

        assert_eq!(parsed.sheet_index, 2);
        assert_eq!(parsed.published_sheet_id, "sales-dashboard");
        assert_eq!(parsed.synced_version, 3);
        assert!(parsed.layout_overrides.is_none());
        // layout_overrides should be omitted from JSON when None
        assert!(!json.contains("layoutOverrides"));
    }

    #[test]
    fn test_linked_sheet_info_with_layout_overrides() {
        let layout = SheetLayout {
            column_widths: [(0, 150.0), (3, 200.0)].into_iter().collect(),
            row_heights: [(0, 30.0)].into_iter().collect(),
        };

        let info = LinkedSheetInfo {
            sheet_index: 0,
            published_sheet_id: "test".to_string(),
            synced_version: 1,
            source_path: "/shared/test.calp-pub/".to_string(),
            source_folder: "0_Test".to_string(),
            synced_checksum: "abc".to_string(),
            last_refreshed: "2026-01-01T00:00:00Z".to_string(),
            layout_overrides: Some(layout),
        };

        let json = serde_json::to_string_pretty(&info).unwrap();
        let parsed: LinkedSheetInfo = serde_json::from_str(&json).unwrap();

        let overrides = parsed.layout_overrides.unwrap();
        assert_eq!(overrides.column_widths.len(), 2);
        assert_eq!(overrides.column_widths[&0], 150.0);
    }

    #[test]
    fn test_link_state_serialization() {
        let status = LinkedSheetStatus {
            sheet_index: 1,
            state: LinkState::Stale,
            local_version: 2,
            remote_version: Some(5),
            message: "Remote version 5 available (local: 2)".to_string(),
        };

        let json = serde_json::to_string(&status).unwrap();
        assert!(json.contains("\"stale\""));

        let parsed: LinkedSheetStatus = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.state, LinkState::Stale);
        assert_eq!(parsed.remote_version, Some(5));
    }
}
