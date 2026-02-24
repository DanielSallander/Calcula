//! FILENAME: core/pivot-engine/src/definition.rs
//! Pivot Table Definition - The serializable configuration.
//!
//! This module contains all the types needed to DESCRIBE a pivot table.
//! These structures are designed to be:
//! - Serializable (for saving/loading workbooks)
//! - Sent over the Tauri bridge
//! - Immutable snapshots of user intent

use serde::{Deserialize, Serialize};
use engine::CellCoord;

/// Unique identifier for a pivot table within a workbook.
pub type PivotId = u32;

/// Index into the source data columns (0-based).
pub type FieldIndex = usize;

// ============================================================================
// AGGREGATION
// ============================================================================

/// Supported aggregation functions for value fields.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum AggregationType {
    Sum,
    Count,
    Average,
    Min,
    Max,
    CountNumbers,
    StdDev,
    StdDevP,
    Var,
    VarP,
    Product,
}

impl Default for AggregationType {
    fn default() -> Self {
        AggregationType::Sum
    }
}

// ============================================================================
// FIELD DEFINITIONS
// ============================================================================

/// Represents a field (column) from the source data.
/// Used for Row, Column, and Filter areas.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PivotField {
    /// Index of the source column (0-based from source range).
    pub source_index: FieldIndex,

    /// Display name (defaults to column header from source).
    pub name: String,

    /// Sort order for this field's items.
    pub sort_order: SortOrder,

    /// Whether to show subtotals for this field.
    pub show_subtotals: bool,

    /// Whether this field is collapsed in the view (field-level: collapses ALL items).
    pub collapsed: bool,

    /// Specific items that are hidden (filtered out).
    /// Stores the string representation of hidden values.
    pub hidden_items: Vec<String>,

    /// Per-item collapse tracking. Stores string labels of individually collapsed items.
    /// When an item label is in this list, that specific item is collapsed even if
    /// the field-level `collapsed` is false.
    #[serde(default)]
    pub collapsed_items: Vec<String>,

    /// Whether to show items with no data (Cartesian product of all unique values).
    #[serde(default)]
    pub show_all_items: bool,

    /// Grouping configuration for this field (date, number, or manual grouping).
    #[serde(default)]
    pub grouping: FieldGrouping,
}

impl PivotField {
    pub fn new(source_index: FieldIndex, name: String) -> Self {
        PivotField {
            source_index,
            name,
            sort_order: SortOrder::Ascending,
            show_subtotals: true,
            collapsed: false,
            hidden_items: Vec::new(),
            collapsed_items: Vec::new(),
            show_all_items: false,
            grouping: FieldGrouping::None,
        }
    }
}

// ============================================================================
// FIELD GROUPING
// ============================================================================

/// Grouping configuration for a pivot field.
/// Allows transforming raw values into hierarchical buckets.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum FieldGrouping {
    /// No grouping - use raw source values.
    None,
    /// Group date values by time periods (Year, Quarter, Month, etc.).
    DateGrouping {
        /// Which date levels to include in the hierarchy.
        levels: Vec<DateGroupLevel>,
    },
    /// Group numeric values into equal-width bins.
    NumberBinning {
        /// Starting value for the first bin.
        start: f64,
        /// Ending value for the last bin.
        end: f64,
        /// Width of each bin.
        interval: f64,
    },
    /// User-defined manual grouping of items.
    ManualGrouping {
        /// The manual groups: each maps a group name to its member items.
        groups: Vec<ManualGroup>,
        /// Name for the auto-generated group containing ungrouped items.
        #[serde(default = "default_ungrouped_name")]
        ungrouped_name: String,
    },
}

fn default_ungrouped_name() -> String {
    "Other".to_string()
}

impl Default for FieldGrouping {
    fn default() -> Self {
        FieldGrouping::None
    }
}

/// Levels for date grouping hierarchy.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum DateGroupLevel {
    Year,
    Quarter,
    Month,
    Week,
    Day,
}

/// A user-defined manual group: combines specific items under a parent label.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ManualGroup {
    /// Display name of the group (e.g., "Group1", "Eastern Region").
    pub name: String,
    /// The member item labels that belong to this group.
    pub members: Vec<String>,
}

/// Represents a value field with its aggregation function.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ValueField {
    /// Index of the source column (0-based from source range).
    pub source_index: FieldIndex,
    
    /// Display name (e.g., "Sum of Sales").
    pub name: String,
    
    /// The aggregation function to apply.
    pub aggregation: AggregationType,
    
    /// Number format string (e.g., "#,##0.00", "0%").
    pub number_format: Option<String>,
    
    /// Show values as (normal, % of grand total, % of row, etc.).
    pub show_values_as: ShowValuesAs,
}

impl ValueField {
    pub fn new(source_index: FieldIndex, name: String, aggregation: AggregationType) -> Self {
        ValueField {
            source_index,
            name,
            aggregation,
            number_format: None,
            show_values_as: ShowValuesAs::Normal,
        }
    }
}

/// How to display calculated values.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ShowValuesAs {
    Normal,
    PercentOfGrandTotal,
    PercentOfRowTotal,
    PercentOfColumnTotal,
    PercentOfParentRow,
    PercentOfParentColumn,
    Difference,
    PercentDifference,
    RunningTotal,
    Index,
}

impl Default for ShowValuesAs {
    fn default() -> Self {
        ShowValuesAs::Normal
    }
}

/// Sort order for field items.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum SortOrder {
    Ascending,
    Descending,
    Manual,
    DataSourceOrder,
}

impl Default for SortOrder {
    fn default() -> Self {
        SortOrder::Ascending
    }
}

// ============================================================================
// FILTER DEFINITIONS
// ============================================================================

/// A filter applied to a field in the filter area.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PivotFilter {
    /// The field this filter applies to.
    pub field: PivotField,
    
    /// The filter condition.
    pub condition: FilterCondition,
}

/// Types of filter conditions.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum FilterCondition {
    /// Include only these specific values.
    ValueList(Vec<FilterValue>),
    
    /// Top/Bottom N items.
    TopN {
        count: usize,
        by_value_field: FieldIndex,
        top: bool, // true = top, false = bottom
    },
    
    /// Comparison filter for numbers.
    NumberFilter {
        operator: ComparisonOperator,
        value: f64,
        /// Optional second value for Between/NotBetween.
        value2: Option<f64>,
    },
    
    /// Text-based filter.
    TextFilter {
        operator: TextOperator,
        value: String,
        case_sensitive: bool,
    },
    
    /// Date-based filter.
    DateFilter(DateFilterType),
}

/// A value that can be filtered on.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum FilterValue {
    Empty,
    Text(String),
    Number(f64),
    Boolean(bool),
}

/// Comparison operators for number/date filters.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ComparisonOperator {
    Equals,
    NotEquals,
    GreaterThan,
    GreaterThanOrEqual,
    LessThan,
    LessThanOrEqual,
    Between,
    NotBetween,
}

/// Text filter operators.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum TextOperator {
    Equals,
    NotEquals,
    Contains,
    NotContains,
    BeginsWith,
    EndsWith,
}

/// Pre-defined date filter types.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum DateFilterType {
    Today,
    Yesterday,
    ThisWeek,
    LastWeek,
    ThisMonth,
    LastMonth,
    ThisQuarter,
    LastQuarter,
    ThisYear,
    LastYear,
    YearToDate,
    Custom { start: Option<i64>, end: Option<i64> }, // Unix timestamps
}

// ============================================================================
// LAYOUT OPTIONS
// ============================================================================

/// Controls how the pivot table is displayed.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PivotLayout {
    /// Show row grand totals.
    pub show_row_grand_totals: bool,

    /// Show column grand totals.
    pub show_column_grand_totals: bool,

    /// Layout form: Compact, Outline, or Tabular.
    pub report_layout: ReportLayout,

    /// Repeat row labels in Tabular/Outline layouts.
    pub repeat_row_labels: bool,

    /// Show empty rows.
    pub show_empty_rows: bool,

    /// Show empty columns.
    pub show_empty_cols: bool,

    /// Where to place multiple value fields.
    pub values_position: ValuesPosition,

    // ============================================================================
    // NEW EXCEL-COMPATIBLE PROPERTIES
    // ============================================================================

    /// Auto-format when refreshed or fields moved.
    #[serde(default = "default_true")]
    pub auto_format: bool,

    /// Preserve formatting on refresh/recalculation.
    #[serde(default = "default_true")]
    pub preserve_formatting: bool,

    /// Display field headers and filter drop-downs.
    #[serde(default = "default_true")]
    pub show_field_headers: bool,

    /// Enable field list in UI.
    #[serde(default = "default_true")]
    pub enable_field_list: bool,

    /// Text to fill empty cells.
    #[serde(default)]
    pub empty_cell_text: Option<String>,

    /// Whether to fill empty cells with empty_cell_text.
    #[serde(default)]
    pub fill_empty_cells: bool,

    /// Subtotal location: AtTop, AtBottom, or Off.
    #[serde(default)]
    pub subtotal_location: SubtotalLocation,

    /// Alt text title for accessibility.
    #[serde(default)]
    pub alt_text_title: Option<String>,

    /// Alt text description for accessibility.
    #[serde(default)]
    pub alt_text_description: Option<String>,
}

fn default_true() -> bool {
    true
}

/// Subtotal location type.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
pub enum SubtotalLocation {
    /// Show subtotals at top of group.
    AtTop,
    /// Show subtotals at bottom of group (default).
    #[default]
    AtBottom,
    /// Do not show subtotals.
    Off,
}

impl Default for PivotLayout {
    fn default() -> Self {
        PivotLayout {
            show_row_grand_totals: true,
            show_column_grand_totals: true,
            report_layout: ReportLayout::Compact,
            repeat_row_labels: false,
            show_empty_rows: false,
            show_empty_cols: false,
            values_position: ValuesPosition::Columns,
            auto_format: true,
            preserve_formatting: true,
            show_field_headers: true,
            enable_field_list: true,
            empty_cell_text: None,
            fill_empty_cells: false,
            subtotal_location: SubtotalLocation::AtBottom,
            alt_text_title: None,
            alt_text_description: None,
        }
    }
}

/// Report layout styles.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ReportLayout {
    /// Compact form: All row fields in one column with indentation.
    Compact,
    /// Outline form: Each row field gets its own column, labels above data.
    Outline,
    /// Tabular form: Each row field gets its own column, labels inline.
    Tabular,
}

impl Default for ReportLayout {
    fn default() -> Self {
        ReportLayout::Compact
    }
}

/// Where to place the Values field when there are multiple value fields.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ValuesPosition {
    /// Value fields appear as additional columns.
    Columns,
    /// Value fields appear as additional rows.
    Rows,
}

impl Default for ValuesPosition {
    fn default() -> Self {
        ValuesPosition::Columns
    }
}

// ============================================================================
// MAIN DEFINITION STRUCT
// ============================================================================

/// The complete, serializable definition of a pivot table.
/// This is the "source of truth" that gets saved with the workbook.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PivotDefinition {
    /// Unique identifier for this pivot table.
    pub id: PivotId,

    /// User-friendly name for this pivot table.
    #[serde(default)]
    pub name: Option<String>,

    /// The source data range (top-left corner).
    pub source_start: CellCoord,

    /// The source data range (bottom-right corner).
    pub source_end: CellCoord,

    /// Whether the first row of source data contains headers.
    pub source_has_headers: bool,

    /// Fields placed in the Row area (ordered from outer to inner).
    pub row_fields: Vec<PivotField>,

    /// Fields placed in the Column area (ordered from outer to inner).
    pub column_fields: Vec<PivotField>,

    /// Fields placed in the Values area.
    pub value_fields: Vec<ValueField>,

    /// Fields placed in the Filter area (page filters).
    pub filter_fields: Vec<PivotFilter>,

    /// Layout and display options.
    pub layout: PivotLayout,

    /// Where the pivot table output starts in the destination sheet.
    pub destination: CellCoord,

    /// Destination sheet name (if different from source).
    pub destination_sheet: Option<String>,

    /// Version for cache invalidation.
    pub version: u64,

    // ============================================================================
    // NEW EXCEL-COMPATIBLE PROPERTIES
    // ============================================================================

    /// Allow multiple filters per field (Excel: allowMultipleFiltersPerField).
    #[serde(default)]
    pub allow_multiple_filters_per_field: bool,

    /// Enable editing of values in the data body (Excel: enableDataValueEditing).
    #[serde(default)]
    pub enable_data_value_editing: bool,

    /// Refresh when workbook opens (Excel: refreshOnOpen).
    #[serde(default)]
    pub refresh_on_open: bool,

    /// Use custom sort lists when sorting (Excel: useCustomSortLists).
    #[serde(default)]
    pub use_custom_sort_lists: bool,
}

impl PivotDefinition {
    /// Creates a new pivot table definition with minimal configuration.
    pub fn new(id: PivotId, source_start: CellCoord, source_end: CellCoord) -> Self {
        PivotDefinition {
            id,
            name: None,
            source_start,
            source_end,
            source_has_headers: true,
            row_fields: Vec::new(),
            column_fields: Vec::new(),
            value_fields: Vec::new(),
            filter_fields: Vec::new(),
            layout: PivotLayout::default(),
            destination: (0, 0),
            destination_sheet: None,
            version: 0,
            allow_multiple_filters_per_field: false,
            enable_data_value_editing: false,
            refresh_on_open: false,
            use_custom_sort_lists: false,
        }
    }
    
    /// Increments the version (for cache invalidation).
    pub fn bump_version(&mut self) {
        self.version += 1;
    }
    
    /// Returns the number of source rows (excluding header if applicable).
    pub fn source_row_count(&self) -> u32 {
        let total = self.source_end.0 - self.source_start.0 + 1;
        if self.source_has_headers && total > 0 {
            total - 1
        } else {
            total
        }
    }
    
    /// Returns the number of source columns.
    pub fn source_col_count(&self) -> u32 {
        self.source_end.1 - self.source_start.1 + 1
    }
}