//! FILENAME: app/src-tauri/src/pivot/types.rs
//! PURPOSE: Type definitions for Pivot Table API.
//! CONTEXT: Excel-compatible Pivot Table types for Tauri commands.

use pivot_engine::PivotId;
use serde::{Deserialize, Serialize};

// ============================================================================
// ENUMS - Excel-compatible types
// ============================================================================

/// Layout type for pivot table display.
/// Matches Excel's PivotLayoutType enum.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub enum PivotLayoutType {
    /// Compact layout (default) - row fields in single column with indentation
    #[default]
    Compact,
    /// Tabular layout - each row field in separate column
    Tabular,
    /// Outline layout - like tabular but with subtotals on separate rows
    Outline,
}

/// Subtotal location for pivot table fields.
/// Matches Excel's SubtotalLocationType enum.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub enum SubtotalLocationType {
    /// Show subtotals at top of group
    AtTop,
    /// Show subtotals at bottom of group (default)
    #[default]
    AtBottom,
    /// Do not show subtotals
    Off,
}

/// Aggregation function for value fields.
/// Matches Excel's AggregationFunction enum.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub enum AggregationFunction {
    /// Automatic (sum for numbers, count for text)
    Automatic,
    /// Sum of values
    #[default]
    Sum,
    /// Count of values
    Count,
    /// Average of values
    Average,
    /// Maximum value
    Max,
    /// Minimum value
    Min,
    /// Product of values
    Product,
    /// Count of numeric values only
    CountNumbers,
    /// Standard deviation (sample)
    StandardDeviation,
    /// Standard deviation (population)
    StandardDeviationP,
    /// Variance (sample)
    Variance,
    /// Variance (population)
    VarianceP,
}

/// Show values as calculation type.
/// Matches Excel's ShowAsCalculation enum.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub enum ShowAsCalculation {
    /// No calculation, show raw value
    #[default]
    None,
    /// Percent of grand total
    PercentOfGrandTotal,
    /// Percent of row total
    PercentOfRowTotal,
    /// Percent of column total
    PercentOfColumnTotal,
    /// Percent of parent row
    PercentOfParentRowTotal,
    /// Percent of parent column
    PercentOfParentColumnTotal,
    /// Difference from base item
    DifferenceFrom,
    /// Percent difference from base item
    PercentDifferenceFrom,
    /// Running total
    RunningTotal,
    /// Percent of running total
    PercentOfRunningTotal,
    /// Rank smallest to largest
    RankAscending,
    /// Rank largest to smallest
    RankDescending,
    /// Index calculation
    Index,
}

/// Filter type for pivot field filtering.
/// Matches Excel's PivotFilterType enum.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum PivotFilterType {
    /// Unknown filter type
    Unknown,
    /// Value-based filter (top N, above average, etc.)
    Value,
    /// Manual filter (specific items selected)
    Manual,
    /// Label filter (text pattern matching)
    Label,
    /// Date filter (date-specific conditions)
    Date,
}

/// Condition for label filters.
/// Matches Excel's LabelFilterCondition enum.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum LabelFilterCondition {
    BeginsWith,
    EndsWith,
    Contains,
    DoesNotContain,
    Equals,
    DoesNotEqual,
    GreaterThan,
    GreaterThanOrEqualTo,
    LessThan,
    LessThanOrEqualTo,
    Between,
}

/// Condition for value filters.
/// Matches Excel's ValueFilterCondition enum.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ValueFilterCondition {
    Equals,
    DoesNotEqual,
    GreaterThan,
    GreaterThanOrEqualTo,
    LessThan,
    LessThanOrEqualTo,
    Between,
    TopN,
    BottomN,
    TopNPercent,
    BottomNPercent,
}

/// Condition for date filters.
/// Matches Excel's DateFilterCondition enum.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum DateFilterCondition {
    Equals,
    Before,
    BeforeOrEqualTo,
    After,
    AfterOrEqualTo,
    Between,
    Tomorrow,
    Today,
    Yesterday,
    NextWeek,
    ThisWeek,
    LastWeek,
    NextMonth,
    ThisMonth,
    LastMonth,
    NextQuarter,
    ThisQuarter,
    LastQuarter,
    NextYear,
    ThisYear,
    LastYear,
    YearToDate,
    AllDatesInPeriodQuarter1,
    AllDatesInPeriodQuarter2,
    AllDatesInPeriodQuarter3,
    AllDatesInPeriodQuarter4,
    AllDatesInPeriodJanuary,
    AllDatesInPeriodFebruary,
    AllDatesInPeriodMarch,
    AllDatesInPeriodApril,
    AllDatesInPeriodMay,
    AllDatesInPeriodJune,
    AllDatesInPeriodJuly,
    AllDatesInPeriodAugust,
    AllDatesInPeriodSeptember,
    AllDatesInPeriodOctober,
    AllDatesInPeriodNovember,
    AllDatesInPeriodDecember,
}

/// Sort direction for pivot fields.
/// Matches Excel's SortBy enum.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub enum SortBy {
    #[default]
    Ascending,
    Descending,
}

/// Pivot axis for field placement.
/// Matches Excel's PivotAxis enum.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum PivotAxis {
    Unknown,
    Row,
    Column,
    Data,
    Filter,
}

// ============================================================================
// FILTER TYPES
// ============================================================================

/// Label filter for text-based filtering.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PivotLabelFilter {
    pub condition: LabelFilterCondition,
    /// Text to compare against
    pub substring: Option<String>,
    /// Lower bound for Between condition
    pub lower_bound: Option<String>,
    /// Upper bound for Between condition
    pub upper_bound: Option<String>,
    /// If true, excludes items matching condition instead of including
    pub exclusive: Option<bool>,
}

/// Value filter for numeric filtering.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PivotValueFilter {
    pub condition: ValueFilterCondition,
    /// Value to compare against
    pub comparator: Option<f64>,
    /// Lower bound for Between condition
    pub lower_bound: Option<f64>,
    /// Upper bound for Between condition
    pub upper_bound: Option<f64>,
    /// N value for TopN/BottomN conditions
    pub value: Option<u32>,
    /// The data hierarchy to filter on (field name or index)
    pub selection_type: Option<String>,
    /// If true, excludes items matching condition
    pub exclusive: Option<bool>,
}

/// Date filter for date-based filtering.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PivotDateFilter {
    pub condition: DateFilterCondition,
    /// Date to compare against (ISO format)
    pub comparator: Option<String>,
    /// Lower bound for Between condition
    pub lower_bound: Option<String>,
    /// Upper bound for Between condition
    pub upper_bound: Option<String>,
    /// Whether to include whole days
    pub whole_days: Option<bool>,
    /// If true, excludes items matching condition
    pub exclusive: Option<bool>,
}

/// Manual filter for explicit item selection.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PivotManualFilter {
    /// Items to include (if empty, all items shown)
    pub selected_items: Vec<String>,
}

/// Combined pivot filters for a field.
/// Matches Excel's PivotFilters interface.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PivotFilters {
    pub date_filter: Option<PivotDateFilter>,
    pub label_filter: Option<PivotLabelFilter>,
    pub manual_filter: Option<PivotManualFilter>,
    pub value_filter: Option<PivotValueFilter>,
}

// ============================================================================
// SUBTOTALS CONFIGURATION
// ============================================================================

/// Subtotals configuration for a pivot field.
/// Matches Excel's Subtotals interface.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Subtotals {
    /// Show automatic subtotal
    pub automatic: Option<bool>,
    /// Show average subtotal
    pub average: Option<bool>,
    /// Show count subtotal
    pub count: Option<bool>,
    /// Show count numbers subtotal
    pub count_numbers: Option<bool>,
    /// Show max subtotal
    pub max: Option<bool>,
    /// Show min subtotal
    pub min: Option<bool>,
    /// Show product subtotal
    pub product: Option<bool>,
    /// Show standard deviation subtotal
    pub standard_deviation: Option<bool>,
    /// Show standard deviation population subtotal
    pub standard_deviation_p: Option<bool>,
    /// Show sum subtotal
    pub sum: Option<bool>,
    /// Show variance subtotal
    pub variance: Option<bool>,
    /// Show variance population subtotal
    pub variance_p: Option<bool>,
}

// ============================================================================
// SHOW AS RULE
// ============================================================================

/// Rule for showing values as a calculation.
/// Matches Excel's ShowAsRule interface.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShowAsRule {
    /// The calculation type
    pub calculation: ShowAsCalculation,
    /// Base field for relative calculations
    pub base_field: Option<String>,
    /// Base item for relative calculations
    pub base_item: Option<String>,
}

// ============================================================================
// REQUEST TYPES
// ============================================================================

/// Request to create a new pivot table
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
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
    /// Optional: name for the pivot table
    pub name: Option<String>,
}

/// Field configuration for pivot updates
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PivotFieldConfig {
    /// Source column index (0-based)
    pub source_index: usize,
    /// Display name
    pub name: String,
    /// Sort order: "asc", "desc", "manual", "source"
    pub sort_order: Option<String>,
    /// Whether to show subtotals
    pub show_subtotals: Option<bool>,
    /// Whether field is collapsed (field-level: collapses ALL items)
    pub collapsed: Option<bool>,
    /// Items to hide (filter out)
    pub hidden_items: Option<Vec<String>>,
    /// Per-item collapse tracking: specific item labels that are collapsed
    pub collapsed_items: Option<Vec<String>>,
    /// Whether to show all items (including empty / items with no data)
    pub show_all_items: Option<bool>,
    /// Subtotals configuration
    pub subtotals: Option<Subtotals>,
    /// Grouping configuration for this field
    pub grouping: Option<FieldGroupingConfig>,
}

/// Value field configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
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
    /// Position in the values area (0-based)
    pub position: Option<usize>,
    /// Show as rule for calculated display
    pub show_as: Option<ShowAsRule>,
}

/// Layout configuration.
/// Matches Excel's PivotLayout properties.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct LayoutConfig {
    /// Show grand totals for rows
    pub show_row_grand_totals: Option<bool>,
    /// Show grand totals for columns
    pub show_column_grand_totals: Option<bool>,
    /// Report layout: "compact", "outline", "tabular"
    pub report_layout: Option<String>,
    /// Repeat all row labels for each item
    pub repeat_row_labels: Option<bool>,
    /// Show empty rows
    pub show_empty_rows: Option<bool>,
    /// Show empty columns
    pub show_empty_cols: Option<bool>,
    /// Where to place values: "columns" or "rows"
    pub values_position: Option<String>,
    /// Auto-format when refreshed or fields moved
    pub auto_format: Option<bool>,
    /// Preserve formatting on refresh/recalculation
    pub preserve_formatting: Option<bool>,
    /// Display field headers and filter drop-downs
    pub show_field_headers: Option<bool>,
    /// Enable field list in UI
    pub enable_field_list: Option<bool>,
    /// Text to fill empty cells
    pub empty_cell_text: Option<String>,
    /// Whether to fill empty cells with empty_cell_text
    pub fill_empty_cells: Option<bool>,
    /// Subtotal location type
    pub subtotal_location: Option<SubtotalLocationType>,
    /// Alt text title for accessibility
    pub alt_text_title: Option<String>,
    /// Alt text description for accessibility
    pub alt_text_description: Option<String>,
}

/// Request to update pivot table fields
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
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
#[serde(rename_all = "camelCase")]
pub struct ToggleGroupRequest {
    /// Pivot table ID
    pub pivot_id: PivotId,
    /// Whether this is a row (true) or column (false) group
    pub is_row: bool,
    /// The field index to toggle
    pub field_index: usize,
    /// The specific value to toggle (optional - if None, toggle all)
    pub value: Option<String>,
    /// Full group path for path-specific toggle: (field_index, value_id) pairs.
    /// When provided, only the exact item at this path is toggled (not other
    /// items with the same label under different parents).
    #[serde(default)]
    pub group_path: Option<Vec<(usize, u32)>>,
}

// ============================================================================
// NEW REQUEST TYPES FOR EXCEL-COMPATIBLE API
// ============================================================================

/// Request to apply filters to a pivot field.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ApplyPivotFilterRequest {
    /// Pivot table ID
    pub pivot_id: PivotId,
    /// Field index (in source data)
    pub field_index: usize,
    /// Filters to apply
    pub filters: PivotFilters,
}

/// Request to clear pivot field filters.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClearPivotFilterRequest {
    /// Pivot table ID
    pub pivot_id: PivotId,
    /// Field index (in source data)
    pub field_index: usize,
    /// Optional: specific filter type to clear (if None, clears all)
    pub filter_type: Option<PivotFilterType>,
}

/// Request to sort a pivot field.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SortPivotFieldRequest {
    /// Pivot table ID
    pub pivot_id: PivotId,
    /// Field index to sort
    pub field_index: usize,
    /// Sort direction
    pub sort_by: SortBy,
    /// Sort by values of a data hierarchy (optional)
    pub values_hierarchy: Option<String>,
    /// Scope of pivot items for sorting by values
    pub pivot_item_scope: Option<Vec<String>>,
}

/// Request to set a data hierarchy's aggregation function.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetAggregationRequest {
    /// Pivot table ID
    pub pivot_id: PivotId,
    /// Value field index (in the values area)
    pub value_field_index: usize,
    /// Aggregation function to use
    pub summarize_by: AggregationFunction,
}

/// Request to set how values are displayed.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetShowAsRequest {
    /// Pivot table ID
    pub pivot_id: PivotId,
    /// Value field index (in the values area)
    pub value_field_index: usize,
    /// Show as rule
    pub show_as: ShowAsRule,
}

/// Request to set number format for a value field.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetNumberFormatRequest {
    /// Pivot table ID
    pub pivot_id: PivotId,
    /// Value field index (in the values area)
    pub value_field_index: usize,
    /// Number format string
    pub number_format: String,
}

/// Request to move a field to a different hierarchy.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MoveFieldRequest {
    /// Pivot table ID
    pub pivot_id: PivotId,
    /// Field index (in source data)
    pub field_index: usize,
    /// Target axis (Row, Column, Data, Filter)
    pub target_axis: PivotAxis,
    /// Position within the target axis (0-based)
    pub position: Option<usize>,
}

/// Request to add a field to a hierarchy.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AddHierarchyRequest {
    /// Pivot table ID
    pub pivot_id: PivotId,
    /// Source field index
    pub field_index: usize,
    /// Target axis
    pub axis: PivotAxis,
    /// Optional: position in axis (appends to end if not specified)
    pub position: Option<usize>,
    /// Optional: name override
    pub name: Option<String>,
    /// For values axis: aggregation function
    pub aggregation: Option<AggregationFunction>,
}

/// Request to remove a field from a hierarchy.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoveHierarchyRequest {
    /// Pivot table ID
    pub pivot_id: PivotId,
    /// Axis to remove from
    pub axis: PivotAxis,
    /// Position in the axis (0-based)
    pub position: usize,
}

/// Request to reorder a field within a hierarchy.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReorderHierarchyRequest {
    /// Pivot table ID
    pub pivot_id: PivotId,
    /// Axis containing the field
    pub axis: PivotAxis,
    /// Current position (0-based)
    pub from_position: usize,
    /// New position (0-based)
    pub to_position: usize,
}

/// Request to set pivot item visibility.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetItemVisibilityRequest {
    /// Pivot table ID
    pub pivot_id: PivotId,
    /// Field index
    pub field_index: usize,
    /// Item name
    pub item_name: String,
    /// Whether the item should be visible
    pub visible: bool,
}

/// Request to expand or collapse a pivot item.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetItemExpandedRequest {
    /// Pivot table ID
    pub pivot_id: PivotId,
    /// Field index
    pub field_index: usize,
    /// Item name
    pub item_name: String,
    /// Whether the item should be expanded
    pub is_expanded: bool,
}

/// Request to update pivot table properties.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdatePivotPropertiesRequest {
    /// Pivot table ID
    pub pivot_id: PivotId,
    /// Pivot table name
    pub name: Option<String>,
    /// Allow multiple filters per field
    pub allow_multiple_filters_per_field: Option<bool>,
    /// Enable data value editing
    pub enable_data_value_editing: Option<bool>,
    /// Refresh when workbook opens
    pub refresh_on_open: Option<bool>,
    /// Use custom sort lists
    pub use_custom_sort_lists: Option<bool>,
}

/// Request to update pivot layout.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdatePivotLayoutRequest {
    /// Pivot table ID
    pub pivot_id: PivotId,
    /// Layout configuration
    pub layout: LayoutConfig,
}

/// Response containing the pivot view data
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PivotViewResponse {
    pub pivot_id: PivotId,
    pub version: u64,
    pub row_count: usize,
    pub col_count: usize,
    pub row_label_col_count: usize,
    pub column_header_row_count: usize,
    pub filter_row_count: usize,
    pub filter_rows: Vec<FilterRowData>,
    pub row_field_summaries: Vec<HeaderFieldSummaryData>,
    pub column_field_summaries: Vec<HeaderFieldSummaryData>,
    pub rows: Vec<PivotRowData>,
    pub columns: Vec<PivotColumnData>,
}

/// Filter row metadata for frontend interaction
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FilterRowData {
    pub field_index: usize,
    pub field_name: String,
    pub selected_values: Vec<String>,
    pub unique_values: Vec<String>,
    pub display_value: String,
    pub view_row: usize,
}

/// Summary info about a row or column field for header filter dropdowns.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HeaderFieldSummaryData {
    /// The source field index.
    pub field_index: usize,
    /// Display name of the field.
    pub field_name: String,
    /// Whether this field currently has an active filter (hidden items).
    pub has_active_filter: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PivotRowData {
    pub view_row: usize,
    pub row_type: String,
    pub depth: u8,
    pub visible: bool,
    pub cells: Vec<PivotCellData>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
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
    /// Group path for drill-down: (field_index, value_id) pairs identifying this cell's data.
    #[serde(default)]
    pub group_path: Vec<(usize, u32)>,
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
#[serde(rename_all = "camelCase")]
pub struct PivotColumnData {
    pub view_col: usize,
    pub col_type: String,
    pub depth: u8,
    pub width_hint: u16,
}

/// Source data response for drill-down
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SourceDataResponse {
    pub pivot_id: PivotId,
    pub headers: Vec<String>,
    pub rows: Vec<Vec<String>>,
    pub total_count: usize,
    pub is_truncated: bool,
}

// ============================================================================
// NEW RESPONSE TYPES FOR EXCEL-COMPATIBLE API
// ============================================================================

/// Response for pivot table properties.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PivotTableInfo {
    /// Pivot table ID
    pub id: PivotId,
    /// Pivot table name
    pub name: String,
    /// Source range in A1 notation
    pub source_range: String,
    /// Destination cell in A1 notation
    pub destination: String,
    /// Allow multiple filters per field
    pub allow_multiple_filters_per_field: bool,
    /// Enable data value editing
    pub enable_data_value_editing: bool,
    /// Refresh on workbook open
    pub refresh_on_open: bool,
    /// Use custom sort lists
    pub use_custom_sort_lists: bool,
    /// Source has headers
    pub has_headers: bool,
}

/// Range information response.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RangeInfo {
    /// Start row (0-based)
    pub start_row: u32,
    /// Start column (0-based)
    pub start_col: u32,
    /// End row (0-based)
    pub end_row: u32,
    /// End column (0-based)
    pub end_col: u32,
    /// A1 notation of the range
    pub address: String,
}

/// Response for pivot layout ranges.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PivotLayoutRanges {
    /// Full pivot table range (excluding filter area)
    pub range: Option<RangeInfo>,
    /// Data body range (values only)
    pub data_body_range: Option<RangeInfo>,
    /// Column label range
    pub column_label_range: Option<RangeInfo>,
    /// Row label range
    pub row_label_range: Option<RangeInfo>,
    /// Filter axis range
    pub filter_axis_range: Option<RangeInfo>,
}

/// Pivot field information response.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PivotFieldInfo {
    /// Field ID (source column index)
    pub id: usize,
    /// Field name
    pub name: String,
    /// Whether all items are shown
    pub show_all_items: bool,
    /// Applied filters
    pub filters: PivotFilters,
    /// Whether field is filtered
    pub is_filtered: bool,
    /// Subtotals configuration
    pub subtotals: Subtotals,
    /// Items in this field
    pub items: Vec<PivotItemInfo>,
}

/// Pivot item information response.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PivotItemInfo {
    /// Item ID
    pub id: u32,
    /// Item name/value
    pub name: String,
    /// Whether item is expanded (for expandable items)
    pub is_expanded: bool,
    /// Whether item is visible
    pub visible: bool,
}

/// Data pivot hierarchy information.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DataHierarchyInfo {
    /// Hierarchy ID
    pub id: usize,
    /// Hierarchy name
    pub name: String,
    /// Source field index
    pub field_index: usize,
    /// Aggregation function
    pub summarize_by: AggregationFunction,
    /// Number format
    pub number_format: Option<String>,
    /// Position in values area
    pub position: usize,
    /// Show as rule
    pub show_as: Option<ShowAsRule>,
}

/// Row/Column pivot hierarchy information.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RowColumnHierarchyInfo {
    /// Hierarchy ID
    pub id: usize,
    /// Hierarchy name
    pub name: String,
    /// Source field index
    pub field_index: usize,
    /// Position in axis
    pub position: usize,
}

/// Response for all hierarchies in a pivot table.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PivotHierarchiesInfo {
    /// All available hierarchies (one per source field)
    pub hierarchies: Vec<SourceFieldInfo>,
    /// Row hierarchies
    pub row_hierarchies: Vec<RowColumnHierarchyInfo>,
    /// Column hierarchies
    pub column_hierarchies: Vec<RowColumnHierarchyInfo>,
    /// Data (values) hierarchies
    pub data_hierarchies: Vec<DataHierarchyInfo>,
    /// Filter hierarchies
    pub filter_hierarchies: Vec<RowColumnHierarchyInfo>,
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
    pub name: String,
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

// ============================================================================
// EXPAND/COLLAPSE AND GROUPING REQUEST TYPES
// ============================================================================

/// Request to expand or collapse all items at a specific field level.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExpandCollapseLevelRequest {
    /// Pivot table ID
    pub pivot_id: PivotId,
    /// Whether this targets row fields (true) or column fields (false)
    pub is_row: bool,
    /// The field index within the axis (0-based position)
    pub field_index: usize,
    /// true = expand all items, false = collapse all items
    pub expand: bool,
}

/// Request to expand or collapse all fields in the entire pivot table.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExpandCollapseAllRequest {
    /// Pivot table ID
    pub pivot_id: PivotId,
    /// true = expand all, false = collapse all
    pub expand: bool,
}

/// Grouping configuration for a field (sent from frontend).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum FieldGroupingConfig {
    /// No grouping
    None,
    /// Group dates by time periods
    DateGrouping {
        /// Levels: "year", "quarter", "month", "week", "day"
        levels: Vec<String>,
    },
    /// Group numbers into equal-width bins
    NumberBinning {
        start: f64,
        end: f64,
        interval: f64,
    },
    /// Manual grouping (user-defined groups)
    ManualGrouping {
        groups: Vec<ManualGroupConfig>,
        ungrouped_name: Option<String>,
    },
}

/// Manual group definition (sent from frontend).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManualGroupConfig {
    pub name: String,
    pub members: Vec<String>,
}

/// Request to apply grouping to a pivot field.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupFieldRequest {
    /// Pivot table ID
    pub pivot_id: PivotId,
    /// Field index (source column index)
    pub field_index: usize,
    /// Grouping configuration
    pub grouping: FieldGroupingConfig,
}

/// Request to create a manual group on a field.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateManualGroupRequest {
    /// Pivot table ID
    pub pivot_id: PivotId,
    /// Field index (source column index)
    pub field_index: usize,
    /// Name for the new group
    pub group_name: String,
    /// Items to include in the group
    pub member_items: Vec<String>,
}

/// Request to remove all grouping from a field.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UngroupFieldRequest {
    /// Pivot table ID
    pub pivot_id: PivotId,
    /// Field index (source column index)
    pub field_index: usize,
}

/// Request to perform a drill-through (creates a new sheet with detail rows).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DrillThroughRequest {
    /// Pivot table ID
    pub pivot_id: PivotId,
    /// Group path: (field_index, value_id) pairs identifying the cell
    pub group_path: Vec<(usize, u32)>,
    /// Maximum number of records to include
    pub max_records: Option<usize>,
}

/// Response for a drill-through operation.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DrillThroughResponse {
    /// Name of the new sheet
    pub sheet_name: String,
    /// Index of the new sheet
    pub sheet_index: usize,
    /// Number of data rows written
    pub row_count: usize,
    /// Number of columns written
    pub col_count: usize,
}

use std::collections::HashMap;
use std::sync::Mutex;
use pivot_engine::{PivotCache, PivotDefinition};

/// Managed state for the pivot extension.
/// Registered separately from AppState to keep the kernel feature-agnostic.
pub struct PivotState {
    /// Pivot table storage: id -> (definition, cache)
    pub pivot_tables: Mutex<HashMap<PivotId, (PivotDefinition, PivotCache)>>,
    /// Next available pivot table ID
    pub next_pivot_id: Mutex<PivotId>,
    /// Currently active pivot table ID (for single-pivot operations)
    pub active_pivot_id: Mutex<Option<PivotId>>,
}

impl PivotState {
    pub fn new() -> Self {
        PivotState {
            pivot_tables: Mutex::new(HashMap::new()),
            next_pivot_id: Mutex::new(1),
            active_pivot_id: Mutex::new(None),
        }
    }
}