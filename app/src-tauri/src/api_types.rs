//! FILENAME: app/src-tauri/src/api_types.rs
// PURPOSE: Shared type definitions for Tauri API communication.
// CONTEXT: All structs use camelCase serialization for JavaScript interoperability.
// UPDATED: Added row_span and col_span for merged cells support.

use serde::{Deserialize, Serialize};

/// Cell data returned to the frontend.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CellData {
    pub row: u32,
    pub col: u32,
    pub display: String,
    /// Optional color override from number format (e.g., [Red] in custom format).
    /// CSS hex color string like "#ff0000". None when no format color applies.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub display_color: Option<String>,
    pub formula: Option<String>,
    pub style_index: usize,
    /// Number of rows this cell spans (1 = normal, >1 = merged master cell)
    #[serde(default = "default_span")]
    pub row_span: u32,
    /// Number of columns this cell spans (1 = normal, >1 = merged master cell)
    #[serde(default = "default_span")]
    pub col_span: u32,
    /// Sheet index for cross-sheet updates (None = current active sheet)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sheet_index: Option<usize>,
}

fn default_span() -> u32 {
    1
}

/// Input for batch cell updates.
/// Used by update_cells_batch for efficient bulk operations.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CellUpdateInput {
    pub row: u32,
    pub col: u32,
    pub value: String,
}

/// A single border side (top, right, bottom, or left).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BorderSideData {
    pub style: String,
    pub color: String,
    pub width: u8,
}

/// Style data returned to the frontend.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StyleData {
    pub bold: bool,
    pub italic: bool,
    pub underline: bool,
    pub strikethrough: bool,
    pub font_size: u8,
    pub font_family: String,
    pub text_color: String,
    pub background_color: String,
    pub text_align: String,
    pub vertical_align: String,
    pub number_format: String,
    pub wrap_text: bool,
    pub text_rotation: String,
    pub border_top: BorderSideData,
    pub border_right: BorderSideData,
    pub border_bottom: BorderSideData,
    pub border_left: BorderSideData,
}

/// Dimension data for column widths and row heights.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DimensionData {
    pub index: u32,
    pub size: f64,
    /// "row" or "column" — identifies the dimension type for the frontend.
    pub dimension_type: String,
}

/// A single border side for formatting parameters.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BorderSideParam {
    pub style: String,
    pub color: String,
}

/// Formatting parameters for cell styling.
#[derive(Debug, Clone, Deserialize, Serialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct FormattingParams {
    pub rows: Vec<u32>,
    pub cols: Vec<u32>,
    pub bold: Option<bool>,
    pub italic: Option<bool>,
    pub underline: Option<bool>,
    pub strikethrough: Option<bool>,
    pub font_size: Option<u8>,
    pub font_family: Option<String>,
    pub text_color: Option<String>,
    pub background_color: Option<String>,
    pub text_align: Option<String>,
    pub vertical_align: Option<String>,
    pub number_format: Option<String>,
    pub wrap_text: Option<bool>,
    pub text_rotation: Option<String>,
    pub border_top: Option<BorderSideParam>,
    pub border_right: Option<BorderSideParam>,
    pub border_bottom: Option<BorderSideParam>,
    pub border_left: Option<BorderSideParam>,
}

/// Result from apply_formatting that includes both updated cells and new styles.
/// This allows the frontend to update its style cache in a single round-trip.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FormattingResult {
    /// Updated cells with their new style indices
    pub cells: Vec<CellData>,
    /// New or updated styles that the frontend should cache
    /// Key is the style index, value is the style data
    pub styles: Vec<StyleEntry>,
}

/// A style entry with its index for caching purposes.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StyleEntry {
    pub index: usize,
    pub style: StyleData,
}

/// Function definition for the formula library.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FunctionInfo {
    pub name: String,
    pub syntax: String,
    pub description: String,
    pub category: String,
}

/// Result of getting available functions.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FunctionListResult {
    pub functions: Vec<FunctionInfo>,
}

/// Result from update_cell that includes both updated cells and optional dimension changes.
/// Dimension changes are only present when UI formulas (like SET.ROW.HEIGHT) are evaluated.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateCellResult {
    pub cells: Vec<CellData>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub dimension_changes: Vec<DimensionData>,
    /// When true, the frontend should refresh its style cache (e.g., after SET.CELL.FILLCOLOR).
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub needs_style_refresh: bool,
}

/// A merged cell region definition.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Hash)]
#[serde(rename_all = "camelCase")]
pub struct MergedRegion {
    pub start_row: u32,
    pub start_col: u32,
    pub end_row: u32,
    pub end_col: u32,
}

/// Result of merge operations.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MergeResult {
    pub success: bool,
    pub merged_regions: Vec<MergedRegion>,
    pub updated_cells: Vec<CellData>,
}

// ============================================================================
// Clear Range Options (Excel-compatible)
// ============================================================================

/// Specifies what to clear from a range.
/// Matches Excel's ClearApplyTo enum.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ClearApplyTo {
    /// Clear all contents and formatting (default behavior)
    All,
    /// Clear only cell values, leaving formatting intact
    Contents,
    /// Clear only formatting, leaving values intact
    Formats,
    /// Clear hyperlinks only (placeholder - not yet implemented)
    Hyperlinks,
    /// Remove hyperlinks and formatting but keep content
    RemoveHyperlinks,
    /// Reset cells to their default state
    ResetContents,
}

impl Default for ClearApplyTo {
    fn default() -> Self {
        ClearApplyTo::All
    }
}

/// Parameters for clear_range_with_options command.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClearRangeParams {
    pub start_row: u32,
    pub start_col: u32,
    pub end_row: u32,
    pub end_col: u32,
    #[serde(default)]
    pub apply_to: ClearApplyTo,
}

/// Result of clear_range_with_options command.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClearRangeResult {
    /// Number of cells affected
    pub count: u32,
    /// Updated cells (with new display values if only formatting was cleared)
    pub updated_cells: Vec<CellData>,
}

// ============================================================================
// Sort Range (Excel-compatible)
// ============================================================================

/// Specifies what to sort on.
/// Matches Excel's SortOn enum.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SortOn {
    /// Sort by cell value (default)
    Value,
    /// Sort by cell background color
    CellColor,
    /// Sort by font color
    FontColor,
    /// Sort by cell icon (conditional formatting)
    Icon,
}

impl Default for SortOn {
    fn default() -> Self {
        SortOn::Value
    }
}

/// Additional sort data options.
/// Matches Excel's SortDataOption enum.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SortDataOption {
    /// Normal sorting (default)
    Normal,
    /// Treat text as numbers when sorting
    TextAsNumber,
}

impl Default for SortDataOption {
    fn default() -> Self {
        SortDataOption::Normal
    }
}

/// Sort orientation (by rows or columns).
/// Matches Excel's SortOrientation enum.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum SortOrientation {
    /// Sort by rows (sort data vertically - typical case)
    Rows,
    /// Sort by columns (sort data horizontally)
    Columns,
}

impl Default for SortOrientation {
    fn default() -> Self {
        SortOrientation::Rows
    }
}

/// A single sort field/condition.
/// Matches Excel's SortField interface.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SortField {
    /// Column (or row) offset from the first column (or row) being sorted (0-based).
    /// Required field.
    pub key: u32,
    /// Sort direction: true for ascending (A-Z, 0-9), false for descending.
    #[serde(default = "default_ascending")]
    pub ascending: bool,
    /// What to sort on (value, cell color, font color, or icon).
    #[serde(default)]
    pub sort_on: SortOn,
    /// The color to sort by when sort_on is CellColor or FontColor (CSS color string).
    pub color: Option<String>,
    /// Additional data options (e.g., treat text as numbers).
    #[serde(default)]
    pub data_option: SortDataOption,
    /// For sorting rich values - the subfield/property name to sort on.
    pub sub_field: Option<String>,
}

fn default_ascending() -> bool {
    true
}

/// Parameters for sort_range command.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SortRangeParams {
    /// Start row of range to sort (0-based)
    pub start_row: u32,
    /// Start column of range to sort (0-based)
    pub start_col: u32,
    /// End row of range to sort (0-based, inclusive)
    pub end_row: u32,
    /// End column of range to sort (0-based, inclusive)
    pub end_col: u32,
    /// Sort fields (criteria) - at least one required
    pub fields: Vec<SortField>,
    /// Whether sorting is case-sensitive
    #[serde(default)]
    pub match_case: bool,
    /// Whether the range has a header row/column that should not be sorted
    #[serde(default)]
    pub has_headers: bool,
    /// Sort orientation (rows or columns)
    #[serde(default)]
    pub orientation: SortOrientation,
}

/// Result of sort_range command.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SortRangeResult {
    /// Whether the sort was successful
    pub success: bool,
    /// Number of rows (or columns) sorted
    pub sorted_count: u32,
    /// Updated cells after sorting
    pub updated_cells: Vec<CellData>,
    /// Error message if sort failed
    pub error: Option<String>,
}

// ============================================================================
// Conversion helpers: API types <--> Engine types
// ============================================================================

use engine::{BorderLineStyle, CellStyle, NumberFormat, TextAlign, TextRotation, VerticalAlign};

fn border_side_to_data(side: &engine::BorderStyle) -> BorderSideData {
    let style_str = if side.style == BorderLineStyle::None || side.width == 0 {
        "none".to_string()
    } else {
        match side.style {
            BorderLineStyle::None => "none".to_string(),
            BorderLineStyle::Solid => match side.width {
                0 => "none".to_string(),
                1 => "thin".to_string(),
                2 => "medium".to_string(),
                _ => "thick".to_string(),
            },
            BorderLineStyle::Dashed => "dashed".to_string(),
            BorderLineStyle::Dotted => "dotted".to_string(),
            BorderLineStyle::Double => "double".to_string(),
        }
    };
    BorderSideData {
        style: style_str,
        color: side.color.to_css(),
        width: side.width,
    }
}

impl From<&CellStyle> for StyleData {
    fn from(style: &CellStyle) -> Self {
        StyleData {
            bold: style.font.bold,
            italic: style.font.italic,
            underline: style.font.underline,
            strikethrough: style.font.strikethrough,
            font_size: style.font.size,
            font_family: style.font.family.clone(),
            text_color: style.font.color.to_css(),
            background_color: style.background.to_css(),
            text_align: match style.text_align {
                TextAlign::General => "general".to_string(),
                TextAlign::Left => "left".to_string(),
                TextAlign::Center => "center".to_string(),
                TextAlign::Right => "right".to_string(),
            },
            vertical_align: match style.vertical_align {
                VerticalAlign::Top => "top".to_string(),
                VerticalAlign::Middle => "middle".to_string(),
                VerticalAlign::Bottom => "bottom".to_string(),
            },
            number_format: format_number_format_name(&style.number_format),
            wrap_text: style.wrap_text,
            text_rotation: match style.text_rotation {
                TextRotation::None => "none".to_string(),
                TextRotation::Rotate90 => "rotate90".to_string(),
                TextRotation::Rotate270 => "rotate270".to_string(),
                TextRotation::Custom(angle) => format!("custom:{}", angle),
            },
            border_top: border_side_to_data(&style.borders.top),
            border_right: border_side_to_data(&style.borders.right),
            border_bottom: border_side_to_data(&style.borders.bottom),
            border_left: border_side_to_data(&style.borders.left),
        }
    }
}

// ============================================================================
// Batch Formula Shift (for fill operations)
// ============================================================================

/// Input for batch formula shifting.
/// Used by shift_formulas_batch for efficient fill operations.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FormulaShiftInput {
    /// The formula to shift (including the "=" prefix)
    pub formula: String,
    /// Row delta to shift (positive = down, negative = up)
    pub row_delta: i32,
    /// Column delta to shift (positive = right, negative = left)
    pub col_delta: i32,
}

/// Result of batch formula shifting.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FormulaShiftResult {
    /// The shifted formulas in the same order as the input
    pub formulas: Vec<String>,
}

/// Convert NumberFormat to a display name.
fn format_number_format_name(format: &NumberFormat) -> String {
    match format {
        NumberFormat::General => "General".to_string(),
        NumberFormat::Number {
            decimal_places,
            use_thousands_separator,
        } => {
            if *use_thousands_separator {
                format!("Number ({} decimals, with separators)", decimal_places)
            } else {
                format!("Number ({} decimals)", decimal_places)
            }
        }
        NumberFormat::Currency {
            symbol,
            decimal_places,
            ..
        } => {
            format!("Currency ({}, {} decimals)", symbol, decimal_places)
        }
        NumberFormat::Percentage { decimal_places } => {
            format!("Percentage ({} decimals)", decimal_places)
        }
        NumberFormat::Scientific { decimal_places } => {
            format!("Scientific ({} decimals)", decimal_places)
        }
        NumberFormat::Date { format } => format!("Date ({})", format),
        NumberFormat::Time { format } => format!("Time ({})", format),
        NumberFormat::Custom { format } => format.clone(),
    }
}

// ============================================================================
// Remove Duplicates (Excel-compatible)
// ============================================================================

/// Parameters for remove_duplicates command.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoveDuplicatesParams {
    /// Start row of range (0-based)
    pub start_row: u32,
    /// Start column of range (0-based)
    pub start_col: u32,
    /// End row of range (0-based, inclusive)
    pub end_row: u32,
    /// End column of range (0-based, inclusive)
    pub end_col: u32,
    /// Absolute column indices to use as duplicate keys
    pub key_columns: Vec<u32>,
    /// Whether the first row is a header (excluded from evaluation)
    pub has_headers: bool,
}

/// Result of remove_duplicates command.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoveDuplicatesResult {
    /// Whether the operation was successful
    pub success: bool,
    /// Number of duplicate rows removed
    pub duplicates_removed: u32,
    /// Number of unique rows remaining
    pub unique_remaining: u32,
    /// Updated cells after removal
    pub updated_cells: Vec<CellData>,
    /// Error message if operation failed
    pub error: Option<String>,
}

// ============================================================================
// Goal Seek (single-variable solver)
// ============================================================================

fn default_max_iterations() -> u32 {
    100
}

fn default_tolerance() -> f64 {
    0.001
}

/// Parameters for goal_seek command.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GoalSeekParams {
    /// Row of the target cell (must contain a formula), 0-based
    pub target_row: u32,
    /// Column of the target cell, 0-based
    pub target_col: u32,
    /// The numeric value we want the target cell to evaluate to
    pub target_value: f64,
    /// Row of the variable cell (must be a constant), 0-based
    pub variable_row: u32,
    /// Column of the variable cell, 0-based
    pub variable_col: u32,
    /// Maximum number of iterations (default: 100)
    #[serde(default = "default_max_iterations")]
    pub max_iterations: u32,
    /// Convergence tolerance (default: 0.001)
    #[serde(default = "default_tolerance")]
    pub tolerance: f64,
}

/// Result of goal_seek command.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GoalSeekResult {
    /// Whether a solution was found within tolerance
    pub found_solution: bool,
    /// The final value placed in the variable cell
    pub variable_value: f64,
    /// The final evaluated value of the target cell
    pub target_result: f64,
    /// Number of iterations performed
    pub iterations: u32,
    /// The original value of the variable cell (for reverting)
    pub original_variable_value: f64,
    /// Updated cells (the variable cell + target cell + any dependents)
    pub updated_cells: Vec<CellData>,
    /// Error message if goal seek failed validation
    pub error: Option<String>,
}

// ============================================================================
// Data Consolidation
// ============================================================================

/// Aggregation function for data consolidation.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum ConsolidationFunction {
    Sum,
    Count,
    Average,
    Max,
    Min,
    Product,
    CountNums,
    StdDev,
    StdDevP,
    Var,
    VarP,
}

/// A single source range reference for consolidation.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsolidationSourceRange {
    /// Sheet index (0-based)
    pub sheet_index: usize,
    /// Start row (0-based)
    pub start_row: u32,
    /// Start column (0-based)
    pub start_col: u32,
    /// End row (0-based, inclusive)
    pub end_row: u32,
    /// End column (0-based, inclusive)
    pub end_col: u32,
}

/// Parameters for the consolidate_data command.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsolidateParams {
    /// Aggregation function to apply
    pub function: ConsolidationFunction,
    /// Source ranges to consolidate
    pub source_ranges: Vec<ConsolidationSourceRange>,
    /// Destination sheet index (0-based)
    pub dest_sheet_index: usize,
    /// Destination start row (0-based)
    pub dest_row: u32,
    /// Destination start column (0-based)
    pub dest_col: u32,
    /// Use top row as column headers for category matching
    pub use_top_row: bool,
    /// Use left column as row headers for category matching
    pub use_left_column: bool,
}

/// Result of the consolidate_data command.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsolidateResult {
    /// Whether the operation was successful
    pub success: bool,
    /// Number of output rows written
    pub rows_written: u32,
    /// Number of output columns written
    pub cols_written: u32,
    /// Updated cells in the destination range
    pub updated_cells: Vec<CellData>,
    /// Error message if operation failed
    pub error: Option<String>,
}

// ============================================================================
// Trace Precedents / Trace Dependents
// ============================================================================

/// A single cell reference in a trace result.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TraceCellRef {
    pub row: u32,
    pub col: u32,
    /// Whether this cell currently displays an error value
    pub is_error: bool,
    /// The display value (for UI tooltips)
    pub display: String,
}

/// A contiguous range that feeds into a formula (or is fed by a cell).
/// When multiple individual cells form a contiguous rectangle, they are
/// grouped into a single TraceRange for visual compactness.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TraceRange {
    pub start_row: u32,
    pub start_col: u32,
    pub end_row: u32,
    pub end_col: u32,
    /// Whether ANY cell in this range has an error value
    pub has_error: bool,
}

/// A cross-sheet reference in a trace result.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TraceCrossSheetRef {
    pub sheet_name: String,
    pub sheet_index: usize,
    pub row: u32,
    pub col: u32,
    /// Whether this cell has an error
    pub is_error: bool,
}

/// Result of tracing precedents or dependents for a single cell.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TraceResult {
    /// The cell being traced
    pub source_row: u32,
    pub source_col: u32,
    /// Same-sheet individual cell references (ungrouped singletons)
    pub cells: Vec<TraceCellRef>,
    /// Same-sheet range references (grouped contiguous regions)
    pub ranges: Vec<TraceRange>,
    /// Cross-sheet references
    pub cross_sheet_refs: Vec<TraceCrossSheetRef>,
    /// Whether the source cell itself is in error
    pub source_is_error: bool,
}

// ============================================================================
// Evaluate Formula (step-by-step formula debugger)
// ============================================================================

/// State returned for each step of the Evaluate Formula debugger session.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EvalStepState {
    /// Unique session identifier
    pub session_id: String,
    /// Current formula display text (with partial evaluations inlined)
    pub formula_display: String,
    /// Character position where the underline starts (0-based)
    pub underline_start: usize,
    /// Character position where the underline ends (exclusive)
    pub underline_end: usize,
    /// Can click [Evaluate] button
    pub can_evaluate: bool,
    /// Can click [Step In] (current node is a cell ref with a formula)
    pub can_step_in: bool,
    /// Can click [Step Out] (currently inside a stepped-in frame)
    pub can_step_out: bool,
    /// Evaluation has completed (AST reduced to a single value)
    pub is_complete: bool,
    /// Which cell we're evaluating (e.g., "$A$1")
    pub cell_reference: String,
    /// If step-in is available, which cell it would enter
    pub step_in_target: Option<String>,
    /// Final result when evaluation is complete
    pub evaluation_result: Option<String>,
    /// Error message if something went wrong
    pub error: Option<String>,
}

// ============================================================================
// Custom Number Format Preview
// ============================================================================

/// Result of previewing a custom number format.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewResult {
    /// The formatted display string
    pub display: String,
    /// Optional color from format tokens (CSS hex)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
}

// ============================================================================
// Status Bar Aggregation
// ============================================================================

/// Result of computing aggregations over a selected range.
/// Numeric aggregations (sum, average, min, max) are None when no numeric cells exist.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SelectionAggregationResult {
    /// Sum of all numeric values
    pub sum: Option<f64>,
    /// Average of all numeric values
    pub average: Option<f64>,
    /// Minimum numeric value
    pub min: Option<f64>,
    /// Maximum numeric value
    pub max: Option<f64>,
    /// Count of all non-empty cells
    pub count: u32,
    /// Count of numeric cells only
    pub numerical_count: u32,
}

// ============================================================================
// Computed Properties types
// ============================================================================

/// A single computed property as returned to / received from the frontend.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComputedPropertyData {
    pub id: u64,
    pub attribute: String,
    pub formula: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_value: Option<String>,
}

/// Result from add/update/remove computed property operations.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ComputedPropertyResult {
    pub success: bool,
    pub properties: Vec<ComputedPropertyData>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub dimension_changes: Vec<DimensionData>,
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub needs_style_refresh: bool,
}
