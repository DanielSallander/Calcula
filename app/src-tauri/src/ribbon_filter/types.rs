//! FILENAME: app/src-tauri/src/ribbon_filter/types.rs
//! PURPOSE: Type definitions for Ribbon Filter API.
//! CONTEXT: Power BI-style filter pane — filters pinned to a ribbon tab.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Mutex;

use crate::slicer::types::{SlicerSourceType, SlicerConnection};

// ============================================================================
// ENUMS
// ============================================================================

/// How a ribbon filter determines which pivots/tables it connects to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ConnectionMode {
    /// User manually selects which pivots/tables to filter
    Manual,
    /// Automatically filters all pivots/tables on selected sheets
    BySheet,
    /// Automatically filters all pivots/tables in the workbook
    Workbook,
}

impl Default for ConnectionMode {
    fn default() -> Self {
        ConnectionMode::Manual
    }
}

/// Display mode for the filter card in the ribbon panel.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RibbonFilterDisplayMode {
    /// Checkboxes in a vertical list
    Checklist,
    /// Slicer-style buttons in a grid
    Buttons,
    /// Compact single-line dropdown
    Dropdown,
}

impl Default for RibbonFilterDisplayMode {
    fn default() -> Self {
        RibbonFilterDisplayMode::Checklist
    }
}

// ============================================================================
// RIBBON FILTER DEFINITION
// ============================================================================

/// A ribbon filter — a filter card pinned to the Filter Pane ribbon tab.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RibbonFilter {
    /// Unique filter ID
    pub id: u64,
    /// Display name
    pub name: String,
    /// Source type (table, pivot, or biConnection)
    pub source_type: SlicerSourceType,
    /// The pivot/table/connection ID used as the data source for fetching filter items
    pub cache_source_id: u64,
    /// Field/column name to filter on
    pub field_name: String,
    /// Data type of the field (text, number, date, unknown)
    #[serde(default = "default_field_data_type")]
    pub field_data_type: String,
    /// How connections are determined: manual, bySheet, or workbook
    #[serde(default)]
    pub connection_mode: ConnectionMode,
    /// For manual mode: explicitly selected pivots/tables
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub connected_sources: Vec<SlicerConnection>,
    /// For bySheet mode: which sheet indices to auto-connect pivots from
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub connected_sheets: Vec<usize>,
    /// Display mode: checklist, buttons, or dropdown
    #[serde(default)]
    pub display_mode: RibbonFilterDisplayMode,
    /// Selected items. None = all selected (no filter applied).
    /// Some(vec) = only these items are selected.
    pub selected_items: Option<Vec<String>>,
    /// IDs of other ribbon filters that this filter cross-filters.
    /// When this filter's selection changes, the listed filters' items
    /// are re-evaluated for hasData. Empty = no cross-filtering.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub cross_filter_targets: Vec<u64>,
    /// IDs of canvas slicers that this filter cross-filters.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub cross_filter_slicer_targets: Vec<u64>,
    /// Advanced filter condition (None = basic checklist mode).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub advanced_filter: Option<AdvancedFilter>,
    /// Hide items that have no matching data (cross-filter)
    #[serde(default)]
    pub hide_no_data: bool,
    /// Visually dim items that have no matching data
    #[serde(default = "default_true")]
    pub indicate_no_data: bool,
    /// Sort items with no data to the bottom of the list
    #[serde(default = "default_true")]
    pub sort_no_data_last: bool,
    /// Show "Select all" option in the dropdown
    #[serde(default)]
    pub show_select_all: bool,
    /// Single-select mode (only one item can be selected at a time)
    #[serde(default)]
    pub single_select: bool,
    /// Sort order within the ribbon
    #[serde(default)]
    pub order: u32,
    /// Number of button columns (for Buttons display mode)
    #[serde(default = "default_button_columns")]
    pub button_columns: u32,
    /// Number of button rows (for Buttons display mode, 0 = auto)
    #[serde(default)]
    pub button_rows: u32,
}

/// Operator for advanced filter conditions.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AdvancedFilterOperator {
    // Numeric
    IsLessThan,
    IsLessThanOrEqualTo,
    IsGreaterThan,
    IsGreaterThanOrEqualTo,
    // Text
    Contains,
    DoesNotContain,
    StartsWith,
    DoesNotStartWith,
    // Date
    IsAfter,
    IsOnOrAfter,
    IsBefore,
    IsOnOrBefore,
    // Common
    Is,
    IsNot,
    IsBlank,
    IsNotBlank,
    IsEmpty,
    IsNotEmpty,
}

/// Logic for combining two conditions in advanced filter.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AdvancedFilterLogic {
    And,
    Or,
}

impl Default for AdvancedFilterLogic {
    fn default() -> Self {
        AdvancedFilterLogic::And
    }
}

/// A single condition in an advanced filter.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdvancedFilterCondition {
    pub operator: AdvancedFilterOperator,
    /// Value to compare against (not used for IsBlank/IsNotBlank).
    #[serde(default)]
    pub value: String,
}

/// Advanced filter: one or two conditions with And/Or logic.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AdvancedFilter {
    pub condition1: AdvancedFilterCondition,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub condition2: Option<AdvancedFilterCondition>,
    #[serde(default)]
    pub logic: AdvancedFilterLogic,
}

fn default_true() -> bool {
    true
}

fn default_field_data_type() -> String {
    "unknown".to_string()
}

fn default_button_columns() -> u32 {
    2
}

/// Deserialize `Option<Option<T>>` correctly from JSON:
/// - field missing → `None` (outer)
/// - field: null → `Some(None)` (present but null)
/// - field: value → `Some(Some(value))`
fn deserialize_double_option<'de, T, D>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    T: Deserialize<'de>,
    D: serde::Deserializer<'de>,
{
    Ok(Some(Option::deserialize(deserializer)?))
}

// ============================================================================
// COMMAND PARAMS
// ============================================================================

/// Parameters for creating a new ribbon filter.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateRibbonFilterParams {
    pub name: String,
    pub source_type: SlicerSourceType,
    pub cache_source_id: u64,
    pub field_name: String,
    #[serde(default = "default_field_data_type")]
    pub field_data_type: String,
    #[serde(default)]
    pub connection_mode: ConnectionMode,
    #[serde(default)]
    pub connected_sources: Vec<SlicerConnection>,
    #[serde(default)]
    pub connected_sheets: Vec<usize>,
    pub display_mode: Option<RibbonFilterDisplayMode>,
    pub order: Option<u32>,
}

/// Parameters for updating ribbon filter properties.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateRibbonFilterParams {
    pub name: Option<String>,
    pub display_mode: Option<RibbonFilterDisplayMode>,
    pub order: Option<u32>,
    pub button_columns: Option<u32>,
    pub button_rows: Option<u32>,
    pub connection_mode: Option<ConnectionMode>,
    pub connected_sources: Option<Vec<SlicerConnection>>,
    pub connected_sheets: Option<Vec<usize>>,
    pub cross_filter_targets: Option<Vec<u64>>,
    pub cross_filter_slicer_targets: Option<Vec<u64>>,
    #[serde(default, deserialize_with = "deserialize_double_option")]
    pub advanced_filter: Option<Option<AdvancedFilter>>,
    pub hide_no_data: Option<bool>,
    pub indicate_no_data: Option<bool>,
    pub sort_no_data_last: Option<bool>,
    pub show_select_all: Option<bool>,
    pub single_select: Option<bool>,
}

// ============================================================================
// APPLICATION STATE
// ============================================================================

/// Ribbon filter state managed by Tauri.
pub struct RibbonFilterState {
    /// All ribbon filters: id -> RibbonFilter
    pub filters: Mutex<HashMap<u64, RibbonFilter>>,
    /// Next available filter ID
    pub next_id: Mutex<u64>,
}

impl RibbonFilterState {
    pub fn new() -> Self {
        Self {
            filters: Mutex::new(HashMap::new()),
            next_id: Mutex::new(1),
        }
    }
}
