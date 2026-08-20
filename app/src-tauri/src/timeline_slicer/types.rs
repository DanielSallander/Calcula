//! FILENAME: app/src-tauri/src/timeline_slicer/types.rs
//! PURPOSE: Type definitions for Timeline Slicer API.
//! CONTEXT: Excel-compatible Timeline Slicer types for Tauri commands.
//!          A Timeline Slicer is a date-specific visual filter control
//!          that allows filtering by Days, Months, Quarters, or Years
//!          via a scrollable horizontal date range.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

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
    pub id: identity::EntityId,
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
    pub source_id: identity::EntityId,
    /// Date field name to filter on
    pub field_name: String,
    /// Current timeline granularity level
    #[serde(default)]
    pub level: TimelineLevel,
    /// Start of the selected date range (ISO 8601: "YYYY-MM-DD").
    /// None = no selection (all dates visible).
    ///
    /// No `skip_serializing_if`: the TS type declares `selectionStart: string
    /// | null` NON-optional, and every filter-state check in the extension is
    /// a strict `!== null`. Skipping None made a FRESH timeline read as
    /// `undefined` — i.e. "filtered" — painting the clear-filter indicator on
    /// a timeline with no filter. The wire must carry what the type promises.
    #[serde(default)]
    pub selection_start: Option<String>,
    /// End of the selected date range (ISO 8601: "YYYY-MM-DD").
    /// None = no selection (all dates visible). Serialized as null; see
    /// `selection_start`.
    #[serde(default)]
    pub selection_end: Option<String>,
    /// Whether to show the header bar
    pub show_header: bool,
    /// Whether to show the level selector buttons at the bottom
    pub show_level_selector: bool,
    /// Whether to show the scrollbar
    pub show_scrollbar: bool,
    /// Style preset name
    pub style_preset: String,
    /// Connected pivot table IDs (for report connections)
    #[serde(default)]
    pub connected_pivot_ids: Vec<identity::EntityId>,
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
    pub source_id: identity::EntityId,
    pub field_name: String,
    pub level: Option<TimelineLevel>,
    pub style_preset: Option<String>,
}

/// Deserialize `Option<Option<T>>` correctly from JSON (twin of the helper in
/// ribbon_filter/types.rs):
/// - field missing → `None` (outer: don't change)
/// - field: null → `Some(None)` (present: clear)
/// - field: value → `Some(Some(value))`
///
/// Without it serde maps JSON null to outer-None, so the TS promise
/// `headerText: null` ("clear back to name") could never reach the update arm
/// and clearing the header text was silently impossible.
fn deserialize_double_option<'de, T, D>(deserializer: D) -> Result<Option<Option<T>>, D::Error>
where
    T: serde::Deserialize<'de>,
    D: serde::Deserializer<'de>,
{
    Ok(Some(Option::deserialize(deserializer)?))
}

/// Parameters for updating timeline slicer properties.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateTimelineParams {
    pub name: Option<String>,
    #[serde(default, deserialize_with = "deserialize_double_option")]
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
    pub timeline_id: identity::EntityId,
    /// Start of selected range (ISO 8601). None = clear selection.
    pub selection_start: Option<String>,
    /// End of selected range (ISO 8601). None = clear selection.
    pub selection_end: Option<String>,
}

/// Parameters for updating report connections.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateTimelineConnectionsParams {
    pub timeline_id: identity::EntityId,
    pub connected_pivot_ids: Vec<identity::EntityId>,
}

// ============================================================================
// APPLICATION STATE
// ============================================================================

/// Timeline slicer state managed by Tauri.
pub struct TimelineSlicerState {
    /// All timeline slicers: id -> TimelineSlicer.
    ///
    /// `Persisted<T>` rather than a bare `Mutex` because this store IS a save
    /// source (`workbook.timeline_slicers`), so every write must name a
    /// `DocumentEffect` — `write(&effect)` makes a forgotten one a COMPILE ERROR.
    /// That matters here more than usual: before persistence landed, six of the
    /// seven timeline commands did not even take `FileState`, so they could not
    /// have dirtied the document at all. A save source that cannot set
    /// `is_modified` loses the user's work twice over — the close prompt and
    /// AutoRecover both read that one flag.
    ///
    /// The sibling precedent is `SlicerState.slicers`, NOT `PaneControlState`,
    /// which is a save source on a bare `Mutex` holding its discipline by an
    /// unenforceable convention.
    pub timelines: crate::document_effect::Persisted<HashMap<identity::EntityId, TimelineSlicer>>,
}

impl TimelineSlicerState {
    pub fn new() -> Self {
        Self {
            timelines: crate::document_effect::Persisted::new(HashMap::new()),
        }
    }
}

#[cfg(test)]
mod serde_shape_tests {
    use super::*;

    /// JSON null must mean "clear the header text", absent must mean "keep".
    /// Plain serde maps both to outer-None, which made clearing structurally
    /// impossible — the update arm never saw the null.
    #[test]
    fn header_text_null_clears_and_absent_keeps() {
        let p: UpdateTimelineParams = serde_json::from_str(r#"{"headerText":null}"#).unwrap();
        assert_eq!(p.header_text, Some(None));
        let p: UpdateTimelineParams = serde_json::from_str("{}").unwrap();
        assert_eq!(p.header_text, None);
        let p: UpdateTimelineParams = serde_json::from_str(r#"{"headerText":"Q"}"#).unwrap();
        assert_eq!(p.header_text, Some(Some("Q".to_string())));
    }

    /// The TS type declares `selectionStart: string | null` NON-optional and
    /// every filter-state check in the extension is a strict `!== null`.
    /// Skipping None on the wire made a FRESH timeline read as `undefined` —
    /// "filtered" — so the wire must carry the null the type promises.
    #[test]
    fn an_unfiltered_timeline_serializes_selection_as_null_not_absent() {
        let json = r#"{
            "id": "00000000-0000-4000-8000-000000000001",
            "name": "T1",
            "sheetIndex": 0,
            "x": 0.0, "y": 0.0, "width": 200.0, "height": 100.0,
            "sourceType": "pivot",
            "sourceId": "00000000-0000-4000-8000-000000000002",
            "fieldName": "Date",
            "showHeader": true,
            "showLevelSelector": true,
            "showScrollbar": true,
            "stylePreset": "default"
        }"#;
        let tl: TimelineSlicer = serde_json::from_str(json).unwrap();
        assert_eq!(tl.selection_start, None);
        let out = serde_json::to_value(&tl).unwrap();
        assert!(
            out.get("selectionStart").is_some_and(|v| v.is_null()),
            "selectionStart must serialize as JSON null, not be omitted; got {out}"
        );
        assert!(
            out.get("selectionEnd").is_some_and(|v| v.is_null()),
            "selectionEnd must serialize as JSON null, not be omitted; got {out}"
        );
    }
}
