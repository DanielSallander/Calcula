//! FILENAME: core/calcula-format/src/features/slicers.rs
//! Slicer definitions serialization.
//! Each slicer is stored as slicers/slicer_{id}.json.

use persistence::{SavedSlicer, SavedSlicerSourceType};
use serde::{Deserialize, Serialize};

/// JSON-friendly slicer definition that uses camelCase for the .cala format.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SlicerDef {
    pub id: u64,
    pub name: String,
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
}

impl From<&SavedSlicer> for SlicerDef {
    fn from(s: &SavedSlicer) -> Self {
        SlicerDef {
            id: s.id,
            name: s.name.clone(),
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
        }
    }
}

impl From<&SlicerDef> for SavedSlicer {
    fn from(s: &SlicerDef) -> Self {
        SavedSlicer {
            id: s.id,
            name: s.name.clone(),
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
        }
    }
}
