//! FILENAME: app/src-tauri/src/timeline_slicer/types.rs
//! PURPOSE: Type definitions for Timeline Slicer API.
//! CONTEXT: Excel-compatible Timeline Slicer types for Tauri commands.
//!          A Timeline Slicer is a date-specific visual filter control
//!          that allows filtering by Days, Months, Quarters, or Years
//!          via a scrollable horizontal date range.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Mutex;

// ============================================================================
// TIMELINE LEVEL
// ============================================================================

/// The granularity level for the timeline display.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TimelineLevel {
    Years,
    Quarters,
    Months,
    Days,
}

impl Default for TimelineLevel {
    fn default() -> Self {
        TimelineLevel::Months
    }
}

// ============================================================================
// TIMELINE STYLE PRESET
// ============================================================================

/// Style preset identifier for timeline slicers.
/// Uses the same naming convention as Excel's TimelineStyle* presets.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineStylePreset {
    pub id: String,
    pub name: String,
}

// ============================================================================
// TIMELINE SLICER DEFINITION
// ============================================================================

/// A timeline slicer definition — a date-specific visual filter for PivotTables.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineSlicer {
    /// Unique timeline slicer ID
    pub id: u64,
    /// Display name (programmatic reference)
    pub name: String,
    /// Header display text. If None, `name` is displayed.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub header_text: Option<String>,
    /// Sheet index where the timeline is placed
    pub sheet_index: usize,
    /// X position in pixels (from sheet origin)
    pub x: f64,
    /// Y position in pixels (from sheet origin)
    pub y: f64,
    /// Width in pixels
    pub width: f64,
    /// Height in pixels
    pub height: f64,
    /// Source type — currently only "pivot" is supported for timelines
    pub source_type: TimelineSourceType,
    /// Source pivot table ID
    pub source_id: u64,
    /// Date field name to filter on
    pub field_name: String,
    /// Current timeline granularity level
    #[serde(default)]
    pub level: TimelineLevel,
    /// Start of the selected date range (ISO 8601: "YYYY-MM-DD").
    /// None = no selection (all dates visible).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub selection_start: Option<String>,
    /// End of the selected date range (ISO 8601: "YYYY-MM-DD").
    /// None = no selection (all dates visible).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub selection_end: Option<String>,
    /// Whether to show the header bar
    pub show_header: bool,
    /// Whether to show the level selector buttons at the bottom
    pub show_level_selector: bool,
    /// Whether to show the scrollbar
    pub show_scrollbar: bool,
    /// Style preset name
    pub style_preset: String,
    /// Horizontal scroll position (in logical units, depends on level)
    #[serde(default)]
    pub scroll_position: f64,
    /// Connected pivot table IDs (for report connections)
    #[serde(default)]
    pub connected_pivot_ids: Vec<u64>,
}

// ============================================================================
// SOURCE TYPE
// ============================================================================

/// Source type for timeline slicers.
/// Currently only PivotTable is supported (same as Excel).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum TimelineSourceType {
    Pivot,
}

// ============================================================================
// TIMELINE PERIOD
// ============================================================================

/// A single period in the timeline display.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelinePeriod {
    /// Display label (e.g., "Jan", "Q1", "2024", "15")
    pub label: String,
    /// Group label for the period's parent level (e.g., "2024" for months, "Q1 2024" for days)
    pub group_label: String,
    /// Start date of this period (ISO 8601: "YYYY-MM-DD")
    pub start_date: String,
    /// End date of this period (ISO 8601: "YYYY-MM-DD")
    pub end_date: String,
    /// Whether this period has any data in the source
    pub has_data: bool,
    /// Whether this period is within the current selection
    pub is_selected: bool,
    /// Index within the timeline (0-based)
    pub index: usize,
}

// ============================================================================
// TIMELINE DATA RESPONSE
// ============================================================================

/// Response from get_timeline_data: contains the date range and periods.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimelineDataResponse {
    /// Minimum date in the source data (ISO 8601)
    pub min_date: String,
    /// Maximum date in the source data (ISO 8601)
    pub max_date: String,
    /// Periods at the current level
    pub periods: Vec<TimelinePeriod>,
    /// Current level
    pub level: TimelineLevel,
    /// Total number of periods
    pub total_periods: usize,
}

// ============================================================================
// COMMAND PARAMS
// ============================================================================

/// Parameters for creating a new timeline slicer.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateTimelineParams {
    pub name: String,
    pub sheet_index: usize,
    pub x: f64,
    pub y: f64,
    pub width: Option<f64>,
    pub height: Option<f64>,
    pub source_id: u64,
    pub field_name: String,
    pub level: Option<TimelineLevel>,
    pub style_preset: Option<String>,
}

/// Parameters for updating timeline slicer properties.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateTimelineParams {
    pub name: Option<String>,
    pub header_text: Option<Option<String>>,
    pub show_header: Option<bool>,
    pub show_level_selector: Option<bool>,
    pub show_scrollbar: Option<bool>,
    pub level: Option<TimelineLevel>,
    pub style_preset: Option<String>,
}

/// Parameters for updating the timeline selection range.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateTimelineSelectionParams {
    pub timeline_id: u64,
    /// Start of selected range (ISO 8601). None = clear selection.
    pub selection_start: Option<String>,
    /// End of selected range (ISO 8601). None = clear selection.
    pub selection_end: Option<String>,
}

/// Parameters for updating report connections.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateTimelineConnectionsParams {
    pub timeline_id: u64,
    pub connected_pivot_ids: Vec<u64>,
}

// ============================================================================
// APPLICATION STATE
// ============================================================================

/// Timeline slicer state managed by Tauri.
pub struct TimelineSlicerState {
    /// All timeline slicers: id -> TimelineSlicer
    pub timelines: Mutex<HashMap<u64, TimelineSlicer>>,
    /// Next available timeline slicer ID
    pub next_id: Mutex<u64>,
}

impl TimelineSlicerState {
    pub fn new() -> Self {
        Self {
            timelines: Mutex::new(HashMap::new()),
            next_id: Mutex::new(1),
        }
    }
}
