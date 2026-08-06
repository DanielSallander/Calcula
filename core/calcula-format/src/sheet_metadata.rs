//! FILENAME: core/calcula-format/src/sheet_metadata.rs
//! Per-sheet metadata (metadata.json): merged regions, freeze panes, hidden
//! rows/cols, tab color, visibility, notes, hyperlinks, page setup and
//! gridlines. Before this file existed, the .cala format silently dropped
//! all of these on save/reload (found by the save/reload round-trip oracle:
//! BUG-0018 freeze panes, plus merges/notes/hyperlinks).

use persistence::{
    SavedHyperlink, SavedMergedRegion, SavedNote, SavedPageSetup, Sheet,
    DEFAULT_SHEET_ZOOM_PERCENT,
};
use serde::{Deserialize, Serialize};
use std::collections::HashSet;

/// Sheet-level metadata for a single sheet (metadata.json).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SheetMetadata {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub merged_regions: Vec<SavedMergedRegion>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub freeze_row: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub freeze_col: Option<u32>,
    /// EFFECTIVE hidden rows — the derived filter+outline+user cache, written
    /// for exporters. NOT the home of any authority; see `user_hidden_rows`.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub hidden_rows: Vec<u32>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub hidden_cols: Vec<u32>,
    /// Rows the USER hid by hand. Persisted separately from `hidden_rows`
    /// because that set is regenerated from filter+outline at every save: a
    /// manual hide stored only there would vanish the first time an outline
    /// group was expanded, and it is never read back at load either.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub user_hidden_rows: Vec<u32>,
    /// Columns the user hid by hand (see `user_hidden_rows`).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub user_hidden_cols: Vec<u32>,
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
    /// Per-sheet zoom as a REAL PERCENT (100 = 100%). Omitted at 100 so
    /// ordinary sheets keep writing the same bytes they always did.
    #[serde(default = "default_zoom", skip_serializing_if = "is_default_zoom")]
    pub zoom: f64,
    /// Split-bar row. Persisted separately from `freeze_row`: freeze locks a
    /// pane, split gives the quadrants independent scroll, and only freeze
    /// was ever written -- so a split layout silently reset on every reload.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub split_row: Option<u32>,
    /// Split-bar column (see `split_row`).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub split_col: Option<u32>,
}

/// Hand-written because `#[derive(Default)]` would give `zoom` f64's 0.0 --
/// a sheet zoomed to 0%, which then serializes (0 != 100) and comes back as a
/// blank grid. Every default here must be the value the field is OMITTED for.
impl Default for SheetMetadata {
    fn default() -> Self {
        SheetMetadata {
            merged_regions: Vec::new(),
            freeze_row: None,
            freeze_col: None,
            hidden_rows: Vec::new(),
            hidden_cols: Vec::new(),
            user_hidden_rows: Vec::new(),
            user_hidden_cols: Vec::new(),
            tab_color: String::new(),
            visibility: default_visibility(),
            notes: Vec::new(),
            hyperlinks: Vec::new(),
            page_setup: None,
            show_gridlines: true,
            zoom: DEFAULT_SHEET_ZOOM_PERCENT,
            split_row: None,
            split_col: None,
        }
    }
}

fn default_visibility() -> String {
    "visible".to_string()
}

fn default_true() -> bool {
    true
}

fn default_zoom() -> f64 {
    DEFAULT_SHEET_ZOOM_PERCENT
}

fn is_default_zoom(v: &f64) -> bool {
    (*v - DEFAULT_SHEET_ZOOM_PERCENT).abs() < 1e-9
}

impl SheetMetadata {
    pub fn from_sheet(sheet: &Sheet) -> Self {
        let mut hidden_rows: Vec<u32> = sheet.hidden_rows.iter().copied().collect();
        hidden_rows.sort_unstable();
        let mut hidden_cols: Vec<u32> = sheet.hidden_cols.iter().copied().collect();
        hidden_cols.sort_unstable();
        let mut user_hidden_rows: Vec<u32> = sheet.user_hidden_rows.iter().copied().collect();
        user_hidden_rows.sort_unstable();
        let mut user_hidden_cols: Vec<u32> = sheet.user_hidden_cols.iter().copied().collect();
        user_hidden_cols.sort_unstable();
        SheetMetadata {
            merged_regions: sheet.merged_regions.clone(),
            freeze_row: sheet.freeze_row,
            freeze_col: sheet.freeze_col,
            hidden_rows,
            hidden_cols,
            user_hidden_rows,
            user_hidden_cols,
            tab_color: sheet.tab_color.clone(),
            visibility: sheet.visibility.clone(),
            notes: sheet.notes.clone(),
            hyperlinks: sheet.hyperlinks.clone(),
            page_setup: sheet.page_setup.clone(),
            show_gridlines: sheet.show_gridlines,
            zoom: sheet.zoom,
            split_row: sheet.split_row,
            split_col: sheet.split_col,
        }
    }

    /// True when everything is at its default — the file can be omitted.
    pub fn is_default(&self) -> bool {
        self.merged_regions.is_empty()
            && self.freeze_row.is_none()
            && self.freeze_col.is_none()
            && self.hidden_rows.is_empty()
            && self.hidden_cols.is_empty()
            && self.user_hidden_rows.is_empty()
            && self.user_hidden_cols.is_empty()
            && self.tab_color.is_empty()
            && self.visibility == "visible"
            && self.notes.is_empty()
            && self.hyperlinks.is_empty()
            && self.page_setup.is_none()
            && self.show_gridlines
            && is_default_zoom(&self.zoom)
            && self.split_row.is_none()
            && self.split_col.is_none()
    }

    pub fn apply_to_sheet(&self, sheet: &mut Sheet) {
        sheet.merged_regions = self.merged_regions.clone();
        sheet.freeze_row = self.freeze_row;
        sheet.freeze_col = self.freeze_col;
        sheet.hidden_rows = self.hidden_rows.iter().copied().collect::<HashSet<u32>>();
        sheet.hidden_cols = self.hidden_cols.iter().copied().collect::<HashSet<u32>>();
        sheet.user_hidden_rows = self.user_hidden_rows.iter().copied().collect::<HashSet<u32>>();
        sheet.user_hidden_cols = self.user_hidden_cols.iter().copied().collect::<HashSet<u32>>();
        sheet.tab_color = self.tab_color.clone();
        sheet.visibility = self.visibility.clone();
        sheet.notes = self.notes.clone();
        sheet.hyperlinks = self.hyperlinks.clone();
        sheet.page_setup = self.page_setup.clone();
        sheet.show_gridlines = self.show_gridlines;
        sheet.zoom = self.zoom;
        sheet.split_row = self.split_row;
        sheet.split_col = self.split_col;
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

    /// A user hide must round-trip through metadata.json as its OWN field, and
    /// must not be confused with the derived effective-hidden cache.
    #[test]
    fn test_user_hidden_roundtrip_is_distinct_from_derived_hidden() {
        let mut sheet = Sheet::new("Sheet1".to_string());
        // Derived cache says rows 1,2 are hidden (say, by a filter).
        sheet.hidden_rows = [1u32, 2].into_iter().collect();
        // The user hid row 7 and column 3 by hand.
        sheet.user_hidden_rows = [7u32].into_iter().collect();
        sheet.user_hidden_cols = [3u32].into_iter().collect();

        let meta = SheetMetadata::from_sheet(&sheet);
        assert!(!meta.is_default());
        assert_eq!(meta.hidden_rows, vec![1, 2]);
        assert_eq!(meta.user_hidden_rows, vec![7]);
        assert_eq!(meta.user_hidden_cols, vec![3]);

        let json = serde_json::to_string(&meta).unwrap();
        assert!(json.contains("userHiddenRows"), "camelCase key expected: {json}");
        let parsed: SheetMetadata = serde_json::from_str(&json).unwrap();

        let mut restored = Sheet::new("Sheet1".to_string());
        parsed.apply_to_sheet(&mut restored);
        assert_eq!(restored.user_hidden_rows, sheet.user_hidden_rows);
        assert_eq!(restored.user_hidden_cols, sheet.user_hidden_cols);
        assert_eq!(restored.hidden_rows, sheet.hidden_rows);
    }

    /// Zoom and the split bar must round-trip as their own fields, and a
    /// sheet carrying only one of them must still force metadata.json to be
    /// written — otherwise the writer omits the file and the view is lost.
    #[test]
    fn test_zoom_and_split_roundtrip() {
        let mut sheet = Sheet::new("Sheet1".to_string());
        sheet.zoom = 60.0;
        sheet.split_row = Some(8);
        sheet.split_col = None;
        // A freeze on the same sheet must stay its own, separate setting.
        sheet.freeze_row = Some(1);

        let meta = SheetMetadata::from_sheet(&sheet);
        assert!(!meta.is_default());
        let json = serde_json::to_string(&meta).unwrap();
        assert!(json.contains("\"zoom\""), "camelCase key expected: {json}");
        assert!(json.contains("splitRow"), "camelCase key expected: {json}");
        assert!(
            !json.contains("splitCol"),
            "an absent split column must not be written: {json}"
        );

        let parsed: SheetMetadata = serde_json::from_str(&json).unwrap();
        let mut restored = Sheet::new("Sheet1".to_string());
        parsed.apply_to_sheet(&mut restored);
        assert_eq!(restored.zoom, 60.0);
        assert_eq!(restored.split_row, Some(8));
        assert_eq!(restored.split_col, None);
        assert_eq!(restored.freeze_row, Some(1), "freeze is not the split");
    }

    /// A 100% sheet with no split writes neither field, and a metadata.json
    /// that predates them still loads at 100% rather than at 0%.
    #[test]
    fn test_zoom_defaults_to_one_hundred_not_zero() {
        let meta = SheetMetadata::default();
        assert_eq!(meta.zoom, 100.0);
        let json = serde_json::to_string(&meta).unwrap();
        assert!(!json.contains("zoom"), "default zoom must be omitted: {json}");

        // The shape written before zoom existed.
        let legacy: SheetMetadata =
            serde_json::from_str(r#"{"visibility":"visible","showGridlines":true}"#).unwrap();
        assert_eq!(legacy.zoom, 100.0);
        assert_eq!(legacy.split_row, None);
        assert!(legacy.is_default());
    }

    /// A split alone forces metadata.json to be written.
    #[test]
    fn test_split_alone_forces_metadata_to_be_written() {
        let meta = SheetMetadata {
            split_col: Some(3),
            ..Default::default()
        };
        assert!(!meta.is_default());
    }

    /// A sheet that ONLY has a user hide is not "default" — otherwise the
    /// writer omits metadata.json and the hide is lost on save.
    #[test]
    fn test_user_hidden_alone_forces_metadata_to_be_written() {
        let meta = SheetMetadata {
            user_hidden_rows: vec![4],
            visibility: "visible".to_string(),
            show_gridlines: true,
            ..Default::default()
        };
        assert!(!meta.is_default());
    }
}
