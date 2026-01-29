//! FILENAME: app/src-tauri/src/pivot/types.rs
use engine::pivot::PivotId;
use serde::{Deserialize, Serialize};

/// Request to create a new pivot table
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreatePivotRequest {
    /// Source range in A1 notation (e.g., "A1:D100")
    pub source_range: String,
    /// Destination cell in A1 notation (e.g., "F1")
    pub destination_cell: String,
    /// Optional: sheet index for source data (defaults to active sheet)
    pub source_sheet: Option<usize>,
    /// Optional: sheet index for destination (defaults to active sheet)
    pub destination_sheet: Option<usize>,
    /// Whether first row contains headers
    pub has_headers: Option<bool>,
}

/// Field configuration for pivot updates
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PivotFieldConfig {
    /// Source column index (0-based)
    pub source_index: usize,
    /// Display name
    pub name: String,
    /// Sort order: "asc", "desc", "manual", "source"
    pub sort_order: Option<String>,
    /// Whether to show subtotals
    pub show_subtotals: Option<bool>,
    /// Whether field is collapsed
    pub collapsed: Option<bool>,
    /// Items to hide (filter out)
    pub hidden_items: Option<Vec<String>>,
}

/// Value field configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ValueFieldConfig {
    /// Source column index (0-based)
    pub source_index: usize,
    /// Display name
    pub name: String,
    /// Aggregation type: "sum", "count", "average", "min", "max", etc.
    pub aggregation: String,
    /// Number format string
    pub number_format: Option<String>,
    /// Show values as: "normal", "percent_of_total", etc.
    pub show_values_as: Option<String>,
}

/// Layout configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LayoutConfig {
    pub show_row_grand_totals: Option<bool>,
    pub show_column_grand_totals: Option<bool>,
    /// "compact", "outline", "tabular"
    pub report_layout: Option<String>,
    pub repeat_row_labels: Option<bool>,
    pub show_empty_rows: Option<bool>,
    pub show_empty_cols: Option<bool>,
    /// "columns" or "rows"
    pub values_position: Option<String>,
}

/// Request to update pivot table fields
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UpdatePivotFieldsRequest {
    /// Pivot table ID
    pub pivot_id: PivotId,
    /// Row fields (optional - if None, keep existing)
    pub row_fields: Option<Vec<PivotFieldConfig>>,
    /// Column fields (optional)
    pub column_fields: Option<Vec<PivotFieldConfig>>,
    /// Value fields (optional)
    pub value_fields: Option<Vec<ValueFieldConfig>>,
    /// Filter fields (optional)
    pub filter_fields: Option<Vec<PivotFieldConfig>>,
    /// Layout options (optional)
    pub layout: Option<LayoutConfig>,
}

/// Request to toggle a group's expand/collapse state
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ToggleGroupRequest {
    /// Pivot table ID
    pub pivot_id: PivotId,
    /// Whether this is a row (true) or column (false) group
    pub is_row: bool,
    /// The field index to toggle
    pub field_index: usize,
    /// The specific value to toggle (optional - if None, toggle all)
    pub value: Option<String>,
}

/// Response containing the pivot view data
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PivotViewResponse {
    pub pivot_id: PivotId,
    pub version: u64,
    pub row_count: usize,
    pub col_count: usize,
    pub row_label_col_count: usize,
    pub column_header_row_count: usize,
    pub filter_row_count: usize,
    pub filter_rows: Vec<FilterRowData>,
    pub rows: Vec<PivotRowData>,
    pub columns: Vec<PivotColumnData>,
}

/// Filter row metadata for frontend interaction
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FilterRowData {
    pub field_index: usize,
    pub field_name: String,
    pub selected_values: Vec<String>,
    pub unique_values: Vec<String>,
    pub display_value: String,
    pub view_row: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PivotRowData {
    pub view_row: usize,
    pub row_type: String,
    pub depth: u8,
    pub visible: bool,
    pub cells: Vec<PivotCellData>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PivotCellData {
    pub cell_type: String,
    pub value: PivotCellValueData,
    pub formatted_value: String,
    pub indent_level: u8,
    pub is_bold: bool,
    pub is_expandable: bool,
    pub is_collapsed: bool,
    pub background_style: String,
    pub number_format: Option<String>,
    pub filter_field_index: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type", content = "data")]
pub enum PivotCellValueData {
    Empty,
    Number(f64),
    Text(String),
    Boolean(bool),
    Error(String),
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PivotColumnData {
    pub view_col: usize,
    pub col_type: String,
    pub depth: u8,
    pub width_hint: u16,
}

/// Source data response for drill-down
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SourceDataResponse {
    pub pivot_id: PivotId,
    pub headers: Vec<String>,
    pub rows: Vec<Vec<String>>,
    pub total_count: usize,
    pub is_truncated: bool,
}

/// Zone field info - represents a field assigned to a zone
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ZoneFieldInfo {
    pub source_index: usize,
    pub name: String,
    pub is_numeric: bool,
    /// Only present for value fields
    pub aggregation: Option<String>,
}

/// Current field configuration for the pivot editor
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PivotFieldConfiguration {
    pub row_fields: Vec<ZoneFieldInfo>,
    pub column_fields: Vec<ZoneFieldInfo>,
    pub value_fields: Vec<ZoneFieldInfo>,
    pub filter_fields: Vec<ZoneFieldInfo>,
    pub layout: LayoutConfig,
}

/// Response for pivot region check
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PivotRegionInfo {
    pub pivot_id: PivotId,
    pub is_empty: bool,
    pub source_fields: Vec<SourceFieldInfo>,
    /// Current field configuration - which fields are in which zones
    pub field_configuration: PivotFieldConfiguration,
    /// Filter zones: (row, col, field_index) for each filter dropdown cell
    pub filter_zones: Vec<FilterZoneInfo>,
}

/// Info about a filter dropdown cell position
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FilterZoneInfo {
    pub row: u32,
    pub col: u32,
    pub field_index: usize,
    pub field_name: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceFieldInfo {
    pub index: usize,
    pub name: String,
    pub is_numeric: bool,
}

/// Pivot region data for rendering
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PivotRegionData {
    pub pivot_id: PivotId,
    pub start_row: u32,
    pub start_col: u32,
    pub end_row: u32,
    pub end_col: u32,
    pub is_empty: bool,
}

/// Response for field unique values query
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FieldUniqueValuesResponse {
    pub field_index: usize,
    pub field_name: String,
    pub unique_values: Vec<String>,
}