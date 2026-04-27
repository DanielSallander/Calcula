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

/// Whether a ribbon filter applies to the entire workbook or a single sheet.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RibbonFilterScope {
    Workbook,
    Sheet,
}

impl Default for RibbonFilterScope {
    fn default() -> Self {
        RibbonFilterScope::Sheet
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
    /// Workbook or sheet scope
    pub scope: RibbonFilterScope,
    /// Sheet index (only relevant when scope == Sheet)
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sheet_index: Option<usize>,
    /// Source type (table or pivot)
    pub source_type: SlicerSourceType,
    /// The pivot/table ID used as the data source for fetching filter items
    pub cache_source_id: u64,
    /// Field/column name to filter on
    pub field_name: String,
    /// Report Connections: pivots/tables that this filter controls
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub connected_sources: Vec<SlicerConnection>,
    /// Display mode: checklist, buttons, or dropdown
    #[serde(default)]
    pub display_mode: RibbonFilterDisplayMode,
    /// Selected items. None = all selected (no filter applied).
    /// Some(vec) = only these items are selected.
    pub selected_items: Option<Vec<String>>,
    /// Whether this filter participates in cross-filtering with canvas slicers
    #[serde(default = "default_true")]
    pub cross_filter_enabled: bool,
    /// Whether the card is collapsed in the UI
    #[serde(default)]
    pub collapsed: bool,
    /// Sort order within its section
    #[serde(default)]
    pub order: u32,
    /// Number of button columns (for Buttons display mode)
    #[serde(default = "default_button_columns")]
    pub button_columns: u32,
    /// Number of button rows (for Buttons display mode, 0 = auto)
    #[serde(default)]
    pub button_rows: u32,
}

fn default_true() -> bool {
    true
}

fn default_button_columns() -> u32 {
    2
}

// ============================================================================
// COMMAND PARAMS
// ============================================================================

/// Parameters for creating a new ribbon filter.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateRibbonFilterParams {
    pub name: String,
    pub scope: RibbonFilterScope,
    pub sheet_index: Option<usize>,
    pub source_type: SlicerSourceType,
    pub cache_source_id: u64,
    pub field_name: String,
    #[serde(default)]
    pub connected_sources: Vec<SlicerConnection>,
    pub display_mode: Option<RibbonFilterDisplayMode>,
    pub order: Option<u32>,
}

/// Parameters for updating ribbon filter properties.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateRibbonFilterParams {
    pub name: Option<String>,
    pub scope: Option<RibbonFilterScope>,
    pub sheet_index: Option<Option<usize>>,
    pub display_mode: Option<RibbonFilterDisplayMode>,
    pub collapsed: Option<bool>,
    pub order: Option<u32>,
    pub button_columns: Option<u32>,
    pub button_rows: Option<u32>,
    pub cross_filter_enabled: Option<bool>,
    pub connected_sources: Option<Vec<SlicerConnection>>,
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
