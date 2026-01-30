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
    
    /// Whether this field is collapsed in the view.
    pub collapsed: bool,
    
    /// Specific items that are hidden (filtered out).
    /// Stores the string representation of hidden values.
    pub hidden_items: Vec<String>,
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
        }
    }
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
    pub name: String,
    
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
}

impl PivotDefinition {
    /// Creates a new pivot table definition with minimal configuration.
    pub fn new(id: PivotId, source_start: CellCoord, source_end: CellCoord) -> Self {
        PivotDefinition {
            id,
            name: format!("PivotTable{}", id),
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