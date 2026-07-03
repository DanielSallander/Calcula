//! FILENAME: core/calcula-format/src/features/ribbon_filters.rs
//! Ribbon filter definitions serialization.
//! Each ribbon filter is stored as ribbon_filters/filter_{id}.json.
//! Filter values always come from a Calcula model (BI) connection;
//! `connectionId` references the embedded connection's stable UUID.

use identity::EntityId;
use persistence::{
    SavedRibbonFilter, SavedRibbonFilterDisplayMode, SavedConnectionMode,
    SavedAdvancedFilter,
};
use serde::{Deserialize, Serialize};

/// JSON-friendly ribbon filter definition that uses camelCase for the .cala format.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RibbonFilterDef {
    pub id: EntityId,
    pub name: String,
    /// The Calcula model (BI) connection providing this filter's values.
    pub connection_id: EntityId,
    /// For filters on a package-pulled connection: the stable package
    /// data-source id used to re-bind connection_id after re-pull.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data_source_id: Option<String>,
    pub field_name: String,
    #[serde(default = "default_unknown")]
    pub field_data_type: String,
    #[serde(default = "default_connection_mode")]
    pub connection_mode: String,
    /// For manual mode: explicitly selected target pivots.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub connected_pivots: Vec<EntityId>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub connected_sheets: Vec<usize>,
    #[serde(default = "default_display_mode")]
    pub display_mode: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub selected_items: Option<Vec<String>>,
    /// Advanced (operator/value/logic) filter condition. Persisted in the .cala
    /// mirror so a Filter-Pane advanced filter survives save/reload.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub advanced_filter: Option<SavedAdvancedFilter>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub cross_filter_targets: Vec<EntityId>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub cross_filter_slicer_targets: Vec<EntityId>,
    #[serde(default)]
    pub hide_no_data: bool,
    #[serde(default = "default_true")]
    pub indicate_no_data: bool,
    #[serde(default = "default_true")]
    pub sort_no_data_last: bool,
    #[serde(default)]
    pub show_select_all: bool,
    #[serde(default)]
    pub single_select: bool,
    #[serde(default)]
    pub order: u32,
    #[serde(default = "default_button_columns")]
    pub button_columns: u32,
    #[serde(default)]
    pub button_rows: u32,
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
            connection_id: f.connection_id,
            data_source_id: f.data_source_id.clone(),
            field_name: f.field_name.clone(),
            field_data_type: f.field_data_type.clone(),
            connection_mode: match f.connection_mode {
                SavedConnectionMode::Manual => "manual".to_string(),
                SavedConnectionMode::BySheet => "bySheet".to_string(),
                SavedConnectionMode::Workbook => "workbook".to_string(),
            },
            connected_pivots: f.connected_pivots.clone(),
            connected_sheets: f.connected_sheets.clone(),
            display_mode: match f.display_mode {
                SavedRibbonFilterDisplayMode::Checklist => "checklist".to_string(),
                SavedRibbonFilterDisplayMode::Buttons => "buttons".to_string(),
                SavedRibbonFilterDisplayMode::Dropdown => "dropdown".to_string(),
            },
            selected_items: f.selected_items.clone(),
            advanced_filter: f.advanced_filter.clone(),
            cross_filter_targets: f.cross_filter_targets.clone(),
            cross_filter_slicer_targets: f.cross_filter_slicer_targets.clone(),
            hide_no_data: f.hide_no_data,
            indicate_no_data: f.indicate_no_data,
            sort_no_data_last: f.sort_no_data_last,
            show_select_all: f.show_select_all,
            single_select: f.single_select,
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
            advanced_filter: f.advanced_filter.clone(),
            name: f.name.clone(),
            connection_id: f.connection_id,
            data_source_id: f.data_source_id.clone(),
            field_name: f.field_name.clone(),
            field_data_type: f.field_data_type.clone(),
            connection_mode: match f.connection_mode.as_str() {
                "bySheet" => SavedConnectionMode::BySheet,
                "workbook" => SavedConnectionMode::Workbook,
                _ => SavedConnectionMode::Manual,
            },
            connected_pivots: f.connected_pivots.clone(),
            connected_sheets: f.connected_sheets.clone(),
            display_mode: match f.display_mode.as_str() {
                "buttons" => SavedRibbonFilterDisplayMode::Buttons,
                "dropdown" => SavedRibbonFilterDisplayMode::Dropdown,
                _ => SavedRibbonFilterDisplayMode::Checklist,
            },
            selected_items: f.selected_items.clone(),
            cross_filter_targets: f.cross_filter_targets.clone(),
            cross_filter_slicer_targets: f.cross_filter_slicer_targets.clone(),
            hide_no_data: f.hide_no_data,
            indicate_no_data: f.indicate_no_data,
            sort_no_data_last: f.sort_no_data_last,
            show_select_all: f.show_select_all,
            single_select: f.single_select,
            order: f.order,
            button_columns: f.button_columns,
            button_rows: f.button_rows,
        }
    }
}
