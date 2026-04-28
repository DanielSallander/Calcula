//! FILENAME: core/calcula-format/src/features/ribbon_filters.rs
//! Ribbon filter definitions serialization.
//! Each ribbon filter is stored as ribbon_filters/filter_{id}.json.

use persistence::{
    SavedRibbonFilter, SavedRibbonFilterDisplayMode, SavedConnectionMode,
    SavedSlicerSourceType, SavedSlicerConnection,
};
use serde::{Deserialize, Serialize};

/// JSON-friendly ribbon filter definition that uses camelCase for the .cala format.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RibbonFilterDef {
    pub id: u64,
    pub name: String,
    pub source_type: String,
    pub cache_source_id: u64,
    pub field_name: String,
    #[serde(default = "default_unknown")]
    pub field_data_type: String,
    #[serde(default = "default_connection_mode")]
    pub connection_mode: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub connected_sources: Vec<RibbonFilterConnectionDef>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub connected_sheets: Vec<usize>,
    #[serde(default = "default_display_mode")]
    pub display_mode: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selected_items: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub cross_filter_targets: Vec<u64>,
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

fn default_unknown() -> String {
    "unknown".to_string()
}

fn default_connection_mode() -> String {
    "manual".to_string()
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
            source_type: match f.source_type {
                SavedSlicerSourceType::Table => "table".to_string(),
                SavedSlicerSourceType::Pivot => "pivot".to_string(),
                SavedSlicerSourceType::BiConnection => "biConnection".to_string(),
            },
            cache_source_id: f.cache_source_id,
            field_name: f.field_name.clone(),
            field_data_type: f.field_data_type.clone(),
            connection_mode: match f.connection_mode {
                SavedConnectionMode::Manual => "manual".to_string(),
                SavedConnectionMode::BySheet => "bySheet".to_string(),
                SavedConnectionMode::Workbook => "workbook".to_string(),
            },
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
            connected_sheets: f.connected_sheets.clone(),
            display_mode: match f.display_mode {
                SavedRibbonFilterDisplayMode::Checklist => "checklist".to_string(),
                SavedRibbonFilterDisplayMode::Buttons => "buttons".to_string(),
                SavedRibbonFilterDisplayMode::Dropdown => "dropdown".to_string(),
            },
            selected_items: f.selected_items.clone(),
            cross_filter_targets: f.cross_filter_targets.clone(),
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
            advanced_filter: None,
            name: f.name.clone(),
            source_type: match f.source_type.as_str() {
                "pivot" => SavedSlicerSourceType::Pivot,
                "biConnection" => SavedSlicerSourceType::BiConnection,
                _ => SavedSlicerSourceType::Table,
            },
            cache_source_id: f.cache_source_id,
            field_name: f.field_name.clone(),
            field_data_type: f.field_data_type.clone(),
            connection_mode: match f.connection_mode.as_str() {
                "bySheet" => SavedConnectionMode::BySheet,
                "workbook" => SavedConnectionMode::Workbook,
                _ => SavedConnectionMode::Manual,
            },
            connected_sources: f.connected_sources.iter().map(|c| {
                SavedSlicerConnection {
                    source_type: match c.source_type.as_str() {
                        "pivot" => SavedSlicerSourceType::Pivot,
                        "biConnection" => SavedSlicerSourceType::BiConnection,
                        _ => SavedSlicerSourceType::Table,
                    },
                    source_id: c.source_id,
                }
            }).collect(),
            connected_sheets: f.connected_sheets.clone(),
            display_mode: match f.display_mode.as_str() {
                "buttons" => SavedRibbonFilterDisplayMode::Buttons,
                "dropdown" => SavedRibbonFilterDisplayMode::Dropdown,
                _ => SavedRibbonFilterDisplayMode::Checklist,
            },
            selected_items: f.selected_items.clone(),
            cross_filter_targets: f.cross_filter_targets.clone(),
            order: f.order,
            button_columns: f.button_columns,
            button_rows: f.button_rows,
        }
    }
}
