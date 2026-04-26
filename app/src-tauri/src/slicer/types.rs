//! FILENAME: app/src-tauri/src/slicer/types.rs
//! PURPOSE: Type definitions for Slicer API.
//! CONTEXT: Excel-compatible Slicer types for Tauri commands.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Mutex;

// ============================================================================
// SLICER SOURCE TYPE
// ============================================================================

/// The type of data source a slicer is connected to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SlicerSourceType {
    /// Slicer connected to a Table (ListObject)
    Table,
    /// Slicer connected to a PivotTable
    Pivot,
}

/// Selection behavior mode for a slicer.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SlicerSelectionMode {
    /// Standard: click = exclusive, Ctrl+click = toggle
    Standard,
    /// Single: only one item can be selected at a time (no multi-select)
    Single,
    /// Multi: single click toggles items (no Ctrl needed)
    Multi,
}

impl Default for SlicerSelectionMode {
    fn default() -> Self {
        SlicerSelectionMode::Standard
    }
}

/// Layout arrangement for slicer items.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SlicerArrangement {
    /// Grid layout: items in rows × columns
    Grid,
    /// Horizontal: items in a single row, scrolling horizontally
    Horizontal,
    /// Vertical: items in a single column, scrolling vertically
    Vertical,
}

impl Default for SlicerArrangement {
    fn default() -> Self {
        SlicerArrangement::Vertical
    }
}

// ============================================================================
// SLICER CONNECTION
// ============================================================================

/// A typed reference to a pivot or table that a slicer filters (Report Connection).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SlicerConnection {
    pub source_type: SlicerSourceType,
    pub source_id: u64,
}

// ============================================================================
// SLICER DEFINITION
// ============================================================================

/// A slicer definition — a visual filter control for Tables or PivotTables.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Slicer {
    /// Unique slicer ID
    pub id: u64,
    /// Display name (used as programmatic reference, e.g. in scripts)
    pub name: String,
    /// Header display text (shown in header bar). If None, `name` is displayed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub header_text: Option<String>,
    /// Sheet index where the slicer is placed
    pub sheet_index: usize,
    /// X position in pixels (from sheet origin, top-left of A1)
    pub x: f64,
    /// Y position in pixels (from sheet origin, top-left of A1)
    pub y: f64,
    /// Width in pixels
    pub width: f64,
    /// Height in pixels
    pub height: f64,
    /// Source type (table or pivot)
    pub source_type: SlicerSourceType,
    /// The pivot/table ID used as the data source for fetching slicer items.
    pub cache_source_id: u64,
    /// Field/column name to filter on
    pub field_name: String,
    /// Selected items. None = all selected (no filter applied).
    /// Some(vec) = only these items are selected.
    pub selected_items: Option<Vec<String>>,
    /// Whether to show the header bar with field name
    pub show_header: bool,
    /// Number of button columns (1-5)
    pub columns: u32,
    /// Style preset name (e.g., "SlicerStyleLight1")
    pub style_preset: String,
    /// Selection mode: standard, single, or multi
    #[serde(default)]
    pub selection_mode: SlicerSelectionMode,
    /// Hide items that have no matching data (default: false)
    #[serde(default)]
    pub hide_no_data: bool,
    /// Visually indicate items with no data — grayed out (default: true)
    #[serde(default = "default_true")]
    pub indicate_no_data: bool,
    /// Sort items with no data to the end of the list (default: true)
    #[serde(default = "default_true")]
    pub sort_no_data_last: bool,
    /// Force at least one item to always be selected (default: false)
    #[serde(default)]
    pub force_selection: bool,
    /// Show a "Select all" option at the top of the item list (default: false)
    #[serde(default)]
    pub show_select_all: bool,
    /// Layout arrangement: grid, horizontal, or vertical (default: vertical)
    #[serde(default)]
    pub arrangement: SlicerArrangement,
    /// Number of rows (used when arrangement is grid; 0 = auto)
    #[serde(default)]
    pub rows: u32,
    /// Gap between items in pixels (default: 4)
    #[serde(default = "default_gap")]
    pub item_gap: f64,
    /// Auto-compute grid rows/columns from slicer size (default: true)
    #[serde(default = "default_true")]
    pub autogrid: bool,
    /// Internal padding around the item area in pixels (default: 0)
    #[serde(default)]
    pub item_padding: f64,
    /// Corner radius for item buttons in pixels (default: 2)
    #[serde(default = "default_button_radius")]
    pub button_radius: f64,
    /// Report Connections: pivots/tables that this slicer filters.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub connected_sources: Vec<SlicerConnection>,
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

// ============================================================================
// SLICER ITEM
// ============================================================================

/// A single item (unique value) in a slicer's list.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SlicerItem {
    /// Display text
    pub value: String,
    /// Whether this item is currently selected
    pub selected: bool,
    /// Whether this item has matching data (false = grayed out, no data matches)
    pub has_data: bool,
}

// ============================================================================
// COMMAND PARAMS
// ============================================================================

/// Parameters for creating a new slicer.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateSlicerParams {
    pub name: String,
    pub sheet_index: usize,
    pub x: f64,
    pub y: f64,
    pub width: Option<f64>,
    pub height: Option<f64>,
    pub source_type: SlicerSourceType,
    /// The pivot/table ID used as the data source for fetching slicer items.
    pub cache_source_id: u64,
    pub field_name: String,
    /// Initial Report Connections (pivots/tables this slicer filters).
    #[serde(default)]
    pub connected_sources: Vec<SlicerConnection>,
    pub columns: Option<u32>,
    pub style_preset: Option<String>,
}

/// Parameters for updating slicer properties.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateSlicerParams {
    pub name: Option<String>,
    pub header_text: Option<Option<String>>,
    pub show_header: Option<bool>,
    pub columns: Option<u32>,
    pub style_preset: Option<String>,
    pub selection_mode: Option<SlicerSelectionMode>,
    pub hide_no_data: Option<bool>,
    pub indicate_no_data: Option<bool>,
    pub sort_no_data_last: Option<bool>,
    pub force_selection: Option<bool>,
    pub show_select_all: Option<bool>,
    pub arrangement: Option<SlicerArrangement>,
    pub rows: Option<u32>,
    pub item_gap: Option<f64>,
    pub autogrid: Option<bool>,
    pub item_padding: Option<f64>,
    pub button_radius: Option<f64>,
    pub connected_sources: Option<Vec<SlicerConnection>>,
}

// ============================================================================
// APPLICATION STATE
// ============================================================================

/// Slicer state managed by Tauri.
pub struct SlicerState {
    /// All slicers: id -> Slicer
    pub slicers: Mutex<HashMap<u64, Slicer>>,
    /// Next available slicer ID
    pub next_id: Mutex<u64>,
    /// Computed properties: slicer_id -> list of properties
    pub computed_properties: Mutex<super::computed::SlicerComputedPropertiesStorage>,
    /// Next available computed property ID
    pub next_computed_prop_id: Mutex<u64>,
    /// Dependency tracking: prop_id -> cells it references
    pub computed_prop_dependencies: Mutex<super::computed::SlicerComputedPropDependencies>,
    /// Reverse dependency: cell -> prop_ids
    pub computed_prop_dependents: Mutex<super::computed::SlicerComputedPropDependents>,
}

impl SlicerState {
    pub fn new() -> Self {
        Self {
            slicers: Mutex::new(HashMap::new()),
            next_id: Mutex::new(1),
            computed_properties: Mutex::new(HashMap::new()),
            next_computed_prop_id: Mutex::new(1),
            computed_prop_dependencies: Mutex::new(HashMap::new()),
            computed_prop_dependents: Mutex::new(HashMap::new()),
        }
    }
}
