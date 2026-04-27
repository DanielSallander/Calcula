//! FILENAME: core/calcula-format/src/features/ribbon_filters.rs
//! Ribbon filter definitions serialization.
//! Each ribbon filter is stored as ribbon_filters/filter_{id}.json.

use persistence::{
    SavedRibbonFilter, SavedRibbonFilterScope, SavedRibbonFilterDisplayMode,
    SavedSlicerSourceType, SavedSlicerConnection,
};
use serde::{Deserialize, Serialize};

/// JSON-friendly ribbon filter definition that uses camelCase for the .cala format.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RibbonFilterDef {
    pub id: u64,
    pub name: String,
    pub scope: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sheet_index: Option<usize>,
    pub source_type: String,
    pub cache_source_id: u64,
    pub field_name: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub connected_sources: Vec<RibbonFilterConnectionDef>,
    #[serde(default = "default_display_mode")]
    pub display_mode: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selected_items: Option<Vec<String>>,
    #[serde(default = "default_true")]
    pub cross_filter_enabled: bool,
    #[serde(default)]
    pub collapsed: bool,
    #[serde(default)]
    pub order: u32,
    #[serde(default = "default_button_columns")]
    pub button_columns: u32,
    #[serde(default)]
    pub button_rows: u32,
}

/// JSON-friendly connection reference for the .cala format.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RibbonFilterConnectionDef {
    pub source_type: String,
    pub source_id: u64,
}

fn default_display_mode() -> String {
    "checklist".to_string()
}

fn default_true() -> bool {
    true
}

fn default_button_columns() -> u32 {
    2
}

impl From<&SavedRibbonFilter> for RibbonFilterDef {
    fn from(f: &SavedRibbonFilter) -> Self {
        RibbonFilterDef {
            id: f.id,
            name: f.name.clone(),
            scope: match f.scope {
                SavedRibbonFilterScope::Workbook => "workbook".to_string(),
                SavedRibbonFilterScope::Sheet => "sheet".to_string(),
            },
            sheet_index: f.sheet_index,
            source_type: match f.source_type {
                SavedSlicerSourceType::Table => "table".to_string(),
                SavedSlicerSourceType::Pivot => "pivot".to_string(),
                SavedSlicerSourceType::BiConnection => "biConnection".to_string(),
            },
            cache_source_id: f.cache_source_id,
            field_name: f.field_name.clone(),
            connected_sources: f.connected_sources.iter().map(|c| {
                RibbonFilterConnectionDef {
                    source_type: match c.source_type {
                        SavedSlicerSourceType::Table => "table".to_string(),
                        SavedSlicerSourceType::Pivot => "pivot".to_string(),
                        SavedSlicerSourceType::BiConnection => "biConnection".to_string(),
                    },
                    source_id: c.source_id,
                }
            }).collect(),
            display_mode: match f.display_mode {
                SavedRibbonFilterDisplayMode::Checklist => "checklist".to_string(),
                SavedRibbonFilterDisplayMode::Buttons => "buttons".to_string(),
                SavedRibbonFilterDisplayMode::Dropdown => "dropdown".to_string(),
            },
            selected_items: f.selected_items.clone(),
            cross_filter_enabled: f.cross_filter_enabled,
            collapsed: f.collapsed,
            order: f.order,
            button_columns: f.button_columns,
            button_rows: f.button_rows,
        }
    }
}

impl From<&RibbonFilterDef> for SavedRibbonFilter {
    fn from(f: &RibbonFilterDef) -> Self {
        SavedRibbonFilter {
            id: f.id,
            name: f.name.clone(),
            scope: match f.scope.as_str() {
                "workbook" => SavedRibbonFilterScope::Workbook,
                _ => SavedRibbonFilterScope::Sheet,
            },
            sheet_index: f.sheet_index,
            source_type: match f.source_type.as_str() {
                "pivot" => SavedSlicerSourceType::Pivot,
                "biConnection" => SavedSlicerSourceType::BiConnection,
                _ => SavedSlicerSourceType::Table,
            },
            cache_source_id: f.cache_source_id,
            field_name: f.field_name.clone(),
            connected_sources: f.connected_sources.iter().map(|c| {
                SavedSlicerConnection {
                    source_type: match c.source_type.as_str() {
                        "pivot" => SavedSlicerSourceType::Pivot,
                        _ => SavedSlicerSourceType::Table,
                    },
                    source_id: c.source_id,
                }
            }).collect(),
            display_mode: match f.display_mode.as_str() {
                "buttons" => SavedRibbonFilterDisplayMode::Buttons,
                "dropdown" => SavedRibbonFilterDisplayMode::Dropdown,
                _ => SavedRibbonFilterDisplayMode::Checklist,
            },
            selected_items: f.selected_items.clone(),
            cross_filter_enabled: f.cross_filter_enabled,
            collapsed: f.collapsed,
            order: f.order,
            button_columns: f.button_columns,
            button_rows: f.button_rows,
        }
    }
}
