//! FILENAME: core/calcula-format/src/features/slicers.rs
//! Slicer definitions serialization.
//! Each slicer is stored as slicers/slicer_{id}.json.

use identity::{EntityId, SheetId};
use persistence::{SavedSlicer, SavedSlicerSourceType, SavedSlicerSelectionMode, SavedSlicerArrangement, SavedSlicerComputedProperty, SavedSlicerConnection};
use serde::{Deserialize, Serialize};

/// JSON-friendly slicer definition that uses camelCase for the .cala format.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SlicerDef {
    pub id: EntityId,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub header_text: Option<String>,
    pub sheet_id: SheetId,
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
    pub source_type: String,
    pub cache_source_id: EntityId,
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
    /// Computed properties (formula-driven attributes)
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub computed_properties: Vec<SlicerComputedPropertyDef>,
    /// Report Connections: pivots/tables that this slicer filters.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub connected_sources: Vec<SlicerConnectionDef>,
    /// Filter level: 1 = ordinary slicer (default), 2..=9 = pinned (survives
    /// a measure's bare CLEAR/RESET).
    #[serde(default = "default_filter_level")]
    pub filter_level: u8,
    /// MODEL slicers on a package connection: the stable package data-source
    /// id they re-bind by. Absent for every other slicer. The "slicers"
    /// feature id already covers the section, and dropping the field loses a
    /// re-bind visibly rather than misreading the document, so no version link.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data_source_id: Option<String>,
}

/// JSON-friendly slicer connection (Report Connection) for the .cala format.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SlicerConnectionDef {
    pub source_type: String,
    pub source_id: EntityId,
}

/// JSON-friendly computed property definition for the .cala format.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SlicerComputedPropertyDef {
    pub id: EntityId,
    pub attribute: String,
    pub formula: String,
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

fn default_filter_level() -> u8 {
    1
}

impl From<&SavedSlicer> for SlicerDef {
    fn from(s: &SavedSlicer) -> Self {
        SlicerDef {
            id: s.id,
            name: s.name.clone(),
            header_text: s.header_text.clone(),
            sheet_id: s.sheet_id,
            x: s.x,
            y: s.y,
            width: s.width,
            height: s.height,
            source_type: match s.source_type {
                SavedSlicerSourceType::Table => "table".to_string(),
                SavedSlicerSourceType::Pivot => "pivot".to_string(),
                SavedSlicerSourceType::BiConnection => "biConnection".to_string(),
            },
            cache_source_id: s.cache_source_id,
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
            computed_properties: s.computed_properties.iter().map(|cp| {
                SlicerComputedPropertyDef {
                    id: cp.id,
                    attribute: cp.attribute.clone(),
                    formula: cp.formula.clone(),
                }
            }).collect(),
            connected_sources: s.connected_sources.iter().map(|c| {
                SlicerConnectionDef {
                    source_type: match c.source_type {
                        SavedSlicerSourceType::Table => "table".to_string(),
                        SavedSlicerSourceType::Pivot => "pivot".to_string(),
                        SavedSlicerSourceType::BiConnection => "biConnection".to_string(),
                    },
                    source_id: c.source_id,
                }
            }).collect(),
            filter_level: s.filter_level,
            data_source_id: s.data_source_id.clone(),
        }
    }
}

impl From<&SlicerDef> for SavedSlicer {
    fn from(s: &SlicerDef) -> Self {
        SavedSlicer {
            id: s.id,
            name: s.name.clone(),
            header_text: s.header_text.clone(),
            sheet_id: s.sheet_id,
            x: s.x,
            y: s.y,
            width: s.width,
            height: s.height,
            source_type: match s.source_type.as_str() {
                "pivot" => SavedSlicerSourceType::Pivot,
                "biConnection" => SavedSlicerSourceType::BiConnection,
                _ => SavedSlicerSourceType::Table,
            },
            cache_source_id: s.cache_source_id,
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
            computed_properties: s.computed_properties.iter().map(|cp| {
                SavedSlicerComputedProperty {
                    id: cp.id,
                    attribute: cp.attribute.clone(),
                    formula: cp.formula.clone(),
                }
            }).collect(),
            connected_sources: s.connected_sources.iter().map(|c| {
                SavedSlicerConnection {
                    source_type: match c.source_type.as_str() {
                        "pivot" => SavedSlicerSourceType::Pivot,
                        "biConnection" => SavedSlicerSourceType::BiConnection,
                        _ => SavedSlicerSourceType::Table,
                    },
                    source_id: c.source_id,
                }
            }).collect(),
            filter_level: s.filter_level,
            data_source_id: s.data_source_id.clone(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn model_slicer(data_source_id: Option<&str>) -> SavedSlicer {
        let conn = EntityId::from_bytes(identity::generate_uuid_v7());
        SavedSlicer {
            id: EntityId::from_bytes(identity::generate_uuid_v7()),
            name: "Region".to_string(),
            header_text: None,
            sheet_id: SheetId::from_bytes(identity::generate_uuid_v7()),
            x: 0.0,
            y: 0.0,
            width: 180.0,
            height: 240.0,
            source_type: SavedSlicerSourceType::BiConnection,
            cache_source_id: conn,
            field_name: "Sales.region".to_string(),
            selected_items: Some(vec!["East".to_string()]),
            show_header: true,
            columns: 1,
            style_preset: "SlicerStyleLight1".to_string(),
            selection_mode: SavedSlicerSelectionMode::Standard,
            hide_no_data: false,
            indicate_no_data: true,
            sort_no_data_last: true,
            force_selection: false,
            show_select_all: false,
            arrangement: SavedSlicerArrangement::Vertical,
            rows: 0,
            item_gap: 4.0,
            autogrid: true,
            item_padding: 0.0,
            button_radius: 2.0,
            computed_properties: Vec::new(),
            connected_sources: vec![SavedSlicerConnection {
                source_type: SavedSlicerSourceType::BiConnection,
                source_id: conn,
            }],
            filter_level: 1,
            data_source_id: data_source_id.map(|s| s.to_string()),
        }
    }

    /// A MODEL slicer's stable data-source id survives the `.cala` round trip
    /// as camelCase `dataSourceId`, and is absent (not null) when there is
    /// none -- an older reader then sees exactly the shape it always did.
    #[test]
    fn a_model_slicers_data_source_id_round_trips_through_the_cala_def() {
        let saved = model_slicer(Some("ds-1"));
        let json = serde_json::to_string(&SlicerDef::from(&saved)).unwrap();
        assert!(json.contains("\"dataSourceId\":\"ds-1\""), "{json}");
        let back = SavedSlicer::from(&serde_json::from_str::<SlicerDef>(&json).unwrap());
        assert_eq!(back.data_source_id.as_deref(), Some("ds-1"));
        assert!(matches!(back.source_type, SavedSlicerSourceType::BiConnection));

        let json = serde_json::to_string(&SlicerDef::from(&model_slicer(None))).unwrap();
        assert!(!json.contains("dataSourceId"), "None must be omitted: {json}");
        // An older file (no field at all) still reads.
        let back = SavedSlicer::from(&serde_json::from_str::<SlicerDef>(&json).unwrap());
        assert_eq!(back.data_source_id, None);
    }
}
