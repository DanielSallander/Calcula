//! FILENAME: app/src-tauri/src/ribbon_filter/types.rs
//! PURPOSE: Type definitions for Ribbon Filter API.
//! CONTEXT: Power BI-style filter pane — filters pinned to a ribbon tab.
//!          Filter values always come from a Calcula model (BI) connection;
//!          filters apply to the BI pivots backed by that same connection.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Mutex;

// ============================================================================
// ENUMS
// ============================================================================

/// How a ribbon filter determines which pivots it connects to.
/// Only pivots backed by the filter's model connection are ever targeted.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ConnectionMode {
    /// User manually selects which of the connection's pivots to filter
    Manual,
    /// Automatically filters the connection's pivots on selected sheets
    BySheet,
    /// Automatically filters all of the connection's pivots in the workbook
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
    pub id: identity::EntityId,
    /// Display name
    pub name: String,
    /// The Calcula model (BI) connection whose model provides this filter's
    /// values — the only allowed value source for ribbon filters.
    pub connection_id: identity::EntityId,
    /// For filters on a package-pulled connection: the stable package
    /// data-source id. Package connections mint a fresh uuid on every pull,
    /// so this key re-binds connection_id after reload/re-pull (local
    /// connection ids are stable and need no re-bind; None for those).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub data_source_id: Option<String>,
    /// Field to filter on, in "Table.Column" form
    pub field_name: String,
    /// Data type of the field (text, number, date, unknown)
    #[serde(default = "default_field_data_type")]
    pub field_data_type: String,
    /// How target pivots are determined: manual, bySheet, or workbook
    #[serde(default)]
    pub connection_mode: ConnectionMode,
    /// For manual mode: explicitly selected target pivots (BI pivots
    /// backed by this filter's connection)
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub connected_pivots: Vec<identity::EntityId>,
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
    pub cross_filter_targets: Vec<identity::EntityId>,
    /// IDs of canvas slicers that this filter cross-filters.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub cross_filter_slicer_targets: Vec<identity::EntityId>,
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
    pub connection_id: identity::EntityId,
    pub field_name: String,
    #[serde(default = "default_field_data_type")]
    pub field_data_type: String,
    #[serde(default)]
    pub connection_mode: ConnectionMode,
    #[serde(default)]
    pub connected_pivots: Vec<identity::EntityId>,
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
    pub connected_pivots: Option<Vec<identity::EntityId>>,
    pub connected_sheets: Option<Vec<usize>>,
    pub cross_filter_targets: Option<Vec<identity::EntityId>>,
    pub cross_filter_slicer_targets: Option<Vec<identity::EntityId>>,
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
    pub filters: Mutex<HashMap<identity::EntityId, RibbonFilter>>,
}

impl RibbonFilterState {
    pub fn new() -> Self {
        Self {
            filters: Mutex::new(HashMap::new()),
        }
    }
}
