//! FILENAME: core/calcula-format/src/features/slicers.rs
//! Slicer definitions serialization.
//! Each slicer is stored as slicers/slicer_{id}.json.

use persistence::{SavedSlicer, SavedSlicerSourceType, SavedSlicerSelectionMode, SavedSlicerArrangement};
use serde::{Deserialize, Serialize};

/// JSON-friendly slicer definition that uses camelCase for the .cala format.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SlicerDef {
    pub id: u64,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub header_text: Option<String>,
    pub sheet_index: usize,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub source_type: String,
    pub source_id: u64,
    pub field_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selected_items: Option<Vec<String>>,
    pub show_header: bool,
    pub columns: u32,
    pub style_preset: String,
    #[serde(default = "default_selection_mode")]
    pub selection_mode: String,
    #[serde(default)]
    pub hide_no_data: bool,
    #[serde(default = "default_true")]
    pub indicate_no_data: bool,
    #[serde(default = "default_true")]
    pub sort_no_data_last: bool,
    #[serde(default)]
    pub force_selection: bool,
    #[serde(default)]
    pub show_select_all: bool,
    #[serde(default = "default_arrangement")]
    pub arrangement: String,
    #[serde(default)]
    pub rows: u32,
    #[serde(default = "default_gap")]
    pub item_gap: f64,
    #[serde(default = "default_true")]
    pub autogrid: bool,
    #[serde(default)]
    pub item_padding: f64,
    #[serde(default = "default_button_radius")]
    pub button_radius: f64,
}

fn default_selection_mode() -> String {
    "standard".to_string()
}

fn default_arrangement() -> String {
    "vertical".to_string()
}

fn default_true() -> bool {
    true
}

fn default_gap() -> f64 {
    4.0
}

fn default_button_radius() -> f64 {
    2.0
}

impl From<&SavedSlicer> for SlicerDef {
    fn from(s: &SavedSlicer) -> Self {
        SlicerDef {
            id: s.id,
            name: s.name.clone(),
            header_text: s.header_text.clone(),
            sheet_index: s.sheet_index,
            x: s.x,
            y: s.y,
            width: s.width,
            height: s.height,
            source_type: match s.source_type {
                SavedSlicerSourceType::Table => "table".to_string(),
                SavedSlicerSourceType::Pivot => "pivot".to_string(),
            },
            source_id: s.source_id,
            field_name: s.field_name.clone(),
            selected_items: s.selected_items.clone(),
            show_header: s.show_header,
            columns: s.columns,
            style_preset: s.style_preset.clone(),
            selection_mode: match s.selection_mode {
                SavedSlicerSelectionMode::Standard => "standard".to_string(),
                SavedSlicerSelectionMode::Single => "single".to_string(),
                SavedSlicerSelectionMode::Multi => "multi".to_string(),
            },
            hide_no_data: s.hide_no_data,
            indicate_no_data: s.indicate_no_data,
            sort_no_data_last: s.sort_no_data_last,
            force_selection: s.force_selection,
            show_select_all: s.show_select_all,
            arrangement: match s.arrangement {
                SavedSlicerArrangement::Grid => "grid".to_string(),
                SavedSlicerArrangement::Horizontal => "horizontal".to_string(),
                SavedSlicerArrangement::Vertical => "vertical".to_string(),
            },
            rows: s.rows,
            item_gap: s.item_gap,
            autogrid: s.autogrid,
            item_padding: s.item_padding,
            button_radius: s.button_radius,
        }
    }
}

impl From<&SlicerDef> for SavedSlicer {
    fn from(s: &SlicerDef) -> Self {
        SavedSlicer {
            id: s.id,
            name: s.name.clone(),
            header_text: s.header_text.clone(),
            sheet_index: s.sheet_index,
            x: s.x,
            y: s.y,
            width: s.width,
            height: s.height,
            source_type: match s.source_type.as_str() {
                "pivot" => SavedSlicerSourceType::Pivot,
                _ => SavedSlicerSourceType::Table,
            },
            source_id: s.source_id,
            field_name: s.field_name.clone(),
            selected_items: s.selected_items.clone(),
            show_header: s.show_header,
            columns: s.columns,
            style_preset: s.style_preset.clone(),
            selection_mode: match s.selection_mode.as_str() {
                "single" => SavedSlicerSelectionMode::Single,
                "multi" => SavedSlicerSelectionMode::Multi,
                _ => SavedSlicerSelectionMode::Standard,
            },
            hide_no_data: s.hide_no_data,
            indicate_no_data: s.indicate_no_data,
            sort_no_data_last: s.sort_no_data_last,
            force_selection: s.force_selection,
            show_select_all: s.show_select_all,
            arrangement: match s.arrangement.as_str() {
                "grid" => SavedSlicerArrangement::Grid,
                "horizontal" => SavedSlicerArrangement::Horizontal,
                _ => SavedSlicerArrangement::Vertical,
            },
            rows: s.rows,
            item_gap: s.item_gap,
            autogrid: s.autogrid,
            item_padding: s.item_padding,
            button_radius: s.button_radius,
        }
    }
}
