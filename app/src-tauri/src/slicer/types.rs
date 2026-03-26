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

// ============================================================================
// SLICER DEFINITION
// ============================================================================

/// A slicer definition — a visual filter control for Tables or PivotTables.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Slicer {
    /// Unique slicer ID
    pub id: u64,
    /// Display name (typically the field name, user can rename)
    pub name: String,
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
    /// Source ID (table ID or pivot table ID)
    pub source_id: u64,
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
    pub source_id: u64,
    pub field_name: String,
    pub columns: Option<u32>,
    pub style_preset: Option<String>,
}

/// Parameters for updating slicer properties.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateSlicerParams {
    pub name: Option<String>,
    pub show_header: Option<bool>,
    pub columns: Option<u32>,
    pub style_preset: Option<String>,
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
}

impl SlicerState {
    pub fn new() -> Self {
        Self {
            slicers: Mutex::new(HashMap::new()),
            next_id: Mutex::new(1),
        }
    }
}
