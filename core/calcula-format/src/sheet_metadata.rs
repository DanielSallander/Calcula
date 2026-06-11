//! FILENAME: core/calcula-format/src/sheet_metadata.rs
//! Per-sheet metadata (metadata.json): merged regions, freeze panes, hidden
//! rows/cols, tab color, visibility, notes, hyperlinks, page setup and
//! gridlines. Before this file existed, the .cala format silently dropped
//! all of these on save/reload (found by the save/reload round-trip oracle:
//! BUG-0018 freeze panes, plus merges/notes/hyperlinks).

use persistence::{SavedHyperlink, SavedMergedRegion, SavedNote, SavedPageSetup, Sheet};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

/// Sheet-level metadata for a single sheet (metadata.json).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SheetMetadata {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub merged_regions: Vec<SavedMergedRegion>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub freeze_row: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub freeze_col: Option<u32>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub hidden_rows: Vec<u32>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub hidden_cols: Vec<u32>,
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub tab_color: String,
    /// "visible" (default), "hidden", or "veryHidden".
    #[serde(default = "default_visibility")]
    pub visibility: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub notes: Vec<SavedNote>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub hyperlinks: Vec<SavedHyperlink>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub page_setup: Option<SavedPageSetup>,
    #[serde(default = "default_true")]
    pub show_gridlines: bool,
}

fn default_visibility() -> String {
    "visible".to_string()
}

fn default_true() -> bool {
    true
}

impl SheetMetadata {
    pub fn from_sheet(sheet: &Sheet) -> Self {
        let mut hidden_rows: Vec<u32> = sheet.hidden_rows.iter().copied().collect();
        hidden_rows.sort_unstable();
        let mut hidden_cols: Vec<u32> = sheet.hidden_cols.iter().copied().collect();
        hidden_cols.sort_unstable();
        SheetMetadata {
            merged_regions: sheet.merged_regions.clone(),
            freeze_row: sheet.freeze_row,
            freeze_col: sheet.freeze_col,
            hidden_rows,
            hidden_cols,
            tab_color: sheet.tab_color.clone(),
            visibility: sheet.visibility.clone(),
            notes: sheet.notes.clone(),
            hyperlinks: sheet.hyperlinks.clone(),
            page_setup: sheet.page_setup.clone(),
            show_gridlines: sheet.show_gridlines,
        }
    }

    /// True when everything is at its default — the file can be omitted.
    pub fn is_default(&self) -> bool {
        self.merged_regions.is_empty()
            && self.freeze_row.is_none()
            && self.freeze_col.is_none()
            && self.hidden_rows.is_empty()
            && self.hidden_cols.is_empty()
            && self.tab_color.is_empty()
            && self.visibility == "visible"
            && self.notes.is_empty()
            && self.hyperlinks.is_empty()
            && self.page_setup.is_none()
            && self.show_gridlines
    }

    pub fn apply_to_sheet(&self, sheet: &mut Sheet) {
        sheet.merged_regions = self.merged_regions.clone();
        sheet.freeze_row = self.freeze_row;
        sheet.freeze_col = self.freeze_col;
        sheet.hidden_rows = self.hidden_rows.iter().copied().collect::<HashSet<u32>>();
        sheet.hidden_cols = self.hidden_cols.iter().copied().collect::<HashSet<u32>>();
        sheet.tab_color = self.tab_color.clone();
        sheet.visibility = self.visibility.clone();
        sheet.notes = self.notes.clone();
        sheet.hyperlinks = self.hyperlinks.clone();
        sheet.page_setup = self.page_setup.clone();
        sheet.show_gridlines = self.show_gridlines;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_default_is_omittable() {
        let meta = SheetMetadata {
            visibility: "visible".to_string(),
            show_gridlines: true,
            ..Default::default()
        };
        assert!(meta.is_default());
    }

    #[test]
    fn test_freeze_roundtrip() {
        let meta = SheetMetadata {
            freeze_row: Some(1),
            visibility: "visible".to_string(),
            show_gridlines: true,
            ..Default::default()
        };
        assert!(!meta.is_default());
        let json = serde_json::to_string(&meta).unwrap();
        let parsed: SheetMetadata = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.freeze_row, Some(1));
        assert_eq!(parsed.freeze_col, None);
    }
}
