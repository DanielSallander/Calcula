//! FILENAME: app/src-tauri/src/lib.rs
// PURPOSE: Main library entry point (Tauri Bridge).
// CONTEXT: Uses a generic ProtectedRegion system for extension-owned cell regions.

use engine::{
    format_number, format_number_with_color, format_text_with_color, format_color_to_css,
    Cell, CellError, CellStyle, CellValue, Evaluator, Grid, NumberFormat,
    StyleRegistry, MultiSheetContext,
};
use engine::{
    BinaryOperator as EngineBinaryOp, BuiltinFunction as EngineBuiltinFn,
    Expression as EngineExpr, UnaryOperator as EngineUnaryOp, Value as EngineValue,
};
use parser::ast::{
    BinaryOperator as ParserBinaryOp, BuiltinFunction as ParserBuiltinFn,
    Expression as ParserExpr, TableSpecifier as ParserTableSpecifier,
    UnaryOperator as ParserUnaryOp, Value as ParserValue,
};
use parser::parse as parse_formula;
use std::collections::{HashMap, HashSet};
use std::sync::Mutex;
use persistence::FileState;
use engine::UndoStack;

pub mod persistence;
pub mod api_types;
pub mod calculation;
pub mod commands;
pub mod formula;
pub mod logging;
pub mod sheets;
pub mod undo_commands;
pub mod merge_commands;
pub mod pivot;
pub mod tablix;
pub mod named_ranges;
pub mod data_validation;
pub mod comments;
pub mod autofilter;
pub mod hyperlinks;
pub mod protection;
pub mod grouping;
pub mod conditional_formatting;
pub mod tables;
pub mod goal_seek;
pub mod tracing;
pub mod evaluate_formula;
pub mod consolidate;
pub mod status_bar;

pub use api_types::{CellData, StyleData, DimensionData, FormattingParams, MergedRegion};
pub use logging::{init_log_file, get_log_path, next_seq, write_log, write_log_raw};
pub use engine::{Transaction, CellChange};
pub use sheets::FreezeConfig;
pub use named_ranges::{NamedRange, NamedRangeResult};
pub use data_validation::{
    DataValidation, DataValidationType, DataValidationOperator, DataValidationAlertStyle,
    DataValidationRule, DataValidationErrorAlert, DataValidationPrompt,
    ValidationRange, DataValidationResult, InvalidCellsResult, CellValidationResult,
    NumericRule, DateRule, TimeRule, ListRule, ListSource, CustomRule,
    ValidationStorage,
};
pub use comments::{
    Comment, CommentReply, CommentMention, CommentContentType,
    CommentResult, ReplyResult, CommentIndicator, CommentStorage,
    AddCommentParams, UpdateCommentParams, AddReplyParams, UpdateReplyParams,
};
pub use autofilter::{
    FilterOn, FilterOperator, FilterCriteria, DynamicFilterCriteria,
    AutoFilter, AutoFilterInfo, AutoFilterResult, AutoFilterStorage,
    ColumnFilter, IconFilter, UniqueValuesResult, UniqueValue,
    ApplyAutoFilterParams,
};
pub use hyperlinks::{
    Hyperlink, HyperlinkType, HyperlinkResult, HyperlinkStorage,
    HyperlinkIndicator, InternalReference,
    AddHyperlinkParams, UpdateHyperlinkParams,
};
pub use protection::{
    SheetProtection, SheetProtectionOptions, AllowEditRange, CellProtection,
    ProtectionResult, ProtectionCheckResult, ProtectionStatus,
    ProtectionStorage, CellProtectionStorage,
    ProtectSheetParams, AddAllowEditRangeParams, SetCellProtectionParams,
    WorkbookProtection, WorkbookProtectionResult, WorkbookProtectionStatus,
};
pub use grouping::{
    RowGroup, ColumnGroup, SheetOutline, OutlineSettings, SummaryPosition,
    GroupResult, OutlineInfo, RowOutlineSymbol, ColOutlineSymbol,
    OutlineStorage, GroupRowsParams, GroupColumnsParams,
    MAX_OUTLINE_LEVEL,
};
pub use conditional_formatting::{
    CFValueType, ColorScalePoint, ColorScaleRule, DataBarDirection, DataBarAxisPosition,
    DataBarRule, IconSetType, ThresholdOperator, IconSetThreshold, IconSetRule,
    CellValueOperator, CellValueRule, TextRuleType, ContainsTextRule,
    TopBottomType, TopBottomRule, AverageRuleType, AboveAverageRule,
    TimePeriod, TimePeriodRule, ExpressionRule, ConditionalFormat,
    ConditionalFormatRule, ConditionalFormatRange, ConditionalFormatDefinition,
    ConditionalFormatStorage, CFResult, CellConditionalFormat, EvaluateCFResult,
    AddCFParams, UpdateCFParams,
};
pub use tables::{
    TotalsRowFunction, TableStyleOptions, TableColumn, Table,
    TableStorage, TableNameRegistry, TableResult, ResolvedStructuredRef,
    StructuredRefResult, CreateTableParams, ResizeTableParams,
    UpdateTableStyleParams, SetTotalsRowFunctionParams,
};

#[cfg(test)]
mod tests;

// ============================================================================
// APPLICATION STATE
// ============================================================================

/// A generic protected region on a sheet, registered by any extension (e.g., pivot, chart).
/// Extensions register regions through this struct; the kernel remains feature-agnostic.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct ProtectedRegion {
    /// Unique identifier (e.g., "pivot-1", "chart-3")
    pub id: String,
    /// Region type (e.g., "pivot", "chart")
    pub region_type: String,
    /// Numeric owner ID within the extension's namespace
    pub owner_id: u64,
    pub sheet_index: usize,
    pub start_row: u32,
    pub start_col: u32,
    pub end_row: u32,
    pub end_col: u32,
}

/// Tracks which cells produce UI effects on which targets.
/// Used for conflict detection: if two cells target the same row, both get #CONFLICT.
pub struct UiEffectRegistry {
    /// Row height effects: (sheet_index, target_row) -> set of source cells (sheet_index, row, col)
    pub row_height_sources: HashMap<(usize, u32), HashSet<(usize, u32, u32)>>,
    /// Column width effects: (sheet_index, target_col) -> set of source cells
    pub column_width_sources: HashMap<(usize, u32), HashSet<(usize, u32, u32)>>,
    /// Fill color effects: (sheet_index, target_row, target_col) -> set of source cells
    pub fill_color_sources: HashMap<(usize, u32, u32), HashSet<(usize, u32, u32)>>,
}

impl UiEffectRegistry {
    pub fn new() -> Self {
        UiEffectRegistry {
            row_height_sources: HashMap::new(),
            column_width_sources: HashMap::new(),
            fill_color_sources: HashMap::new(),
        }
    }
}

pub struct AppState {
    /// Multiple grids, one per sheet
    pub grids: Mutex<Vec<Grid>>,
    /// Sheet names in order
    pub sheet_names: Mutex<Vec<String>>,
    /// Currently active sheet index
    pub active_sheet: Mutex<usize>,
    /// The currently active grid (synced with grids[active_sheet])
    /// Commands use this for all cell operations
    pub grid: Mutex<Grid>,
    pub style_registry: Mutex<StyleRegistry>,
    pub column_widths: Mutex<HashMap<u32, f64>>,
    pub row_heights: Mutex<HashMap<u32, f64>>,
    pub dependents: Mutex<HashMap<(u32, u32), HashSet<(u32, u32)>>>,
    pub dependencies: Mutex<HashMap<(u32, u32), HashSet<(u32, u32)>>>,
    /// Calculation mode: "automatic" or "manual"
    pub calculation_mode: Mutex<String>,
    /// Column-level dependencies: column index -> set of formula cells that depend on entire column
    pub column_dependents: Mutex<HashMap<u32, HashSet<(u32, u32)>>>,
    /// Row-level dependencies: row index -> set of formula cells that depend on entire row
    pub row_dependents: Mutex<HashMap<u32, HashSet<(u32, u32)>>>,
    /// Track which columns each formula cell depends on (for cleanup)
    pub column_dependencies: Mutex<HashMap<(u32, u32), HashSet<u32>>>,
    /// Track which rows each formula cell depends on (for cleanup)
    pub row_dependencies: Mutex<HashMap<(u32, u32), HashSet<u32>>>,
    /// Cross-sheet dependencies: (sheet_name, row, col) -> set of (sheet_index, row, col) that depend on it
    pub cross_sheet_dependents: Mutex<HashMap<(String, u32, u32), HashSet<(usize, u32, u32)>>>,
    /// Track which cross-sheet cells each formula depends on (for cleanup)
    pub cross_sheet_dependencies: Mutex<HashMap<(usize, u32, u32), HashSet<(String, u32, u32)>>>,
    pub undo_stack: Mutex<UndoStack>,
    /// Freeze pane configurations per sheet
    pub freeze_configs: Mutex<Vec<FreezeConfig>>,
    /// Merged cell regions for the current sheet
    pub merged_regions: Mutex<HashSet<MergedRegion>>,
    /// Protected regions - cells in these regions cannot be edited directly.
    /// Registered by extensions (e.g., pivot tables, charts).
    pub protected_regions: Mutex<Vec<ProtectedRegion>>,
    /// Named ranges for formula references (key is uppercase name)
    pub named_ranges: Mutex<HashMap<String, named_ranges::NamedRange>>,
    /// Data validation rules per sheet
    pub data_validations: Mutex<data_validation::ValidationStorage>,
    /// Comments per sheet: sheet_index -> (row, col) -> Comment
    pub comments: Mutex<comments::CommentStorage>,
    /// AutoFilters per sheet: sheet_index -> AutoFilter
    pub auto_filters: Mutex<autofilter::AutoFilterStorage>,
    /// Hyperlinks per sheet: sheet_index -> (row, col) -> Hyperlink
    pub hyperlinks: Mutex<hyperlinks::HyperlinkStorage>,
    /// Sheet protection settings per sheet
    pub sheet_protection: Mutex<protection::ProtectionStorage>,
    /// Cell-level protection per sheet: sheet_index -> (row, col) -> CellProtection
    pub cell_protection: Mutex<protection::CellProtectionStorage>,
    /// Workbook-level structural protection (prevents add/delete/rename/move sheets)
    pub workbook_protection: Mutex<protection::WorkbookProtection>,
    /// Row/column grouping (outlines) per sheet
    pub outlines: Mutex<grouping::OutlineStorage>,
    /// Conditional formatting rules per sheet
    pub conditional_formats: Mutex<conditional_formatting::ConditionalFormatStorage>,
    /// Next conditional format rule ID
    pub next_cf_rule_id: Mutex<u64>,
    /// Tables per sheet: sheet_index -> table_id -> Table
    pub tables: Mutex<tables::TableStorage>,
    /// Table name registry: table_name (uppercase) -> (sheet_index, table_id)
    pub table_names: Mutex<tables::TableNameRegistry>,
    /// Next table ID
    pub next_table_id: Mutex<u64>,
    /// Registry tracking UI formula effects for conflict detection
    pub ui_effect_registry: Mutex<UiEffectRegistry>,
}

impl AppState {
    /// Get the active grid (convenience method)
    pub fn get_active_grid(&self) -> std::sync::MutexGuard<Grid> {
        self.grid.lock().unwrap()
    }
    
    /// Check if a cell is within any protected region.
    /// Returns the first matching region, or None.
    pub fn get_region_at_cell(&self, sheet_index: usize, row: u32, col: u32) -> Option<ProtectedRegion> {
        let regions = self.protected_regions.lock().unwrap();
        for region in regions.iter() {
            if region.sheet_index == sheet_index
                && row >= region.start_row
                && row <= region.end_row
                && col >= region.start_col
                && col <= region.end_col
            {
                return Some(region.clone());
            }
        }
        None
    }
}

pub fn create_app_state() -> AppState {
    log_info!("SYS", "Creating AppState");
    let initial_grid = Grid::new();
    AppState {
        grids: Mutex::new(vec![initial_grid.clone()]),
        sheet_names: Mutex::new(vec!["Sheet1".to_string()]),
        active_sheet: Mutex::new(0),
        grid: Mutex::new(initial_grid),
        style_registry: Mutex::new(StyleRegistry::new()),
        column_widths: Mutex::new(HashMap::new()),
        row_heights: Mutex::new(HashMap::new()),
        dependents: Mutex::new(HashMap::new()),
        dependencies: Mutex::new(HashMap::new()),
        calculation_mode: Mutex::new("automatic".to_string()),
        column_dependents: Mutex::new(HashMap::new()),
        row_dependents: Mutex::new(HashMap::new()),
        column_dependencies: Mutex::new(HashMap::new()),
        row_dependencies: Mutex::new(HashMap::new()),
        cross_sheet_dependents: Mutex::new(HashMap::new()),
        cross_sheet_dependencies: Mutex::new(HashMap::new()),
        undo_stack: Mutex::new(UndoStack::new()),
        freeze_configs: Mutex::new(vec![FreezeConfig::default()]),
        merged_regions: Mutex::new(HashSet::new()),
        protected_regions: Mutex::new(Vec::new()),
        named_ranges: Mutex::new(HashMap::new()),
        data_validations: Mutex::new(HashMap::new()),
        comments: Mutex::new(HashMap::new()),
        auto_filters: Mutex::new(HashMap::new()),
        hyperlinks: Mutex::new(HashMap::new()),
        sheet_protection: Mutex::new(HashMap::new()),
        cell_protection: Mutex::new(HashMap::new()),
        workbook_protection: Mutex::new(protection::WorkbookProtection::default()),
        outlines: Mutex::new(HashMap::new()),
        conditional_formats: Mutex::new(HashMap::new()),
        next_cf_rule_id: Mutex::new(1),
        tables: Mutex::new(HashMap::new()),
        table_names: Mutex::new(HashMap::new()),
        next_table_id: Mutex::new(1),
        ui_effect_registry: Mutex::new(UiEffectRegistry::new()),
    }
}

// ============================================================================
// CELL FORMATTING
// ============================================================================

/// Result of formatting a cell value: display text + optional color from format.
pub struct CellDisplayResult {
    pub text: String,
    pub color: Option<String>,
}

pub fn format_cell_value(value: &CellValue, style: &CellStyle) -> String {
    format_cell_value_with_color(value, style).text
}

/// Format a cell value and return both display text and optional color override.
/// The color is only populated for Custom formats that include [Color] tokens.
pub fn format_cell_value_with_color(value: &CellValue, style: &CellStyle) -> CellDisplayResult {
    match value {
        CellValue::Empty => CellDisplayResult { text: String::new(), color: None },
        CellValue::Number(n) => {
            let result = format_number_with_color(*n, &style.number_format);
            if !matches!(style.number_format, NumberFormat::General) {
                log_debug!("FMT", "num={} fmt={:?} --> {}", n, style.number_format, result.text);
            }
            CellDisplayResult {
                text: result.text,
                color: result.color.map(|c| format_color_to_css(&c).to_string()),
            }
        },
        CellValue::Text(s) => {
            let result = format_text_with_color(s, &style.number_format);
            CellDisplayResult {
                text: result.text,
                color: result.color.map(|c| format_color_to_css(&c).to_string()),
            }
        },
        CellValue::Boolean(b) => CellDisplayResult {
            text: if *b { "TRUE" } else { "FALSE" }.to_string(),
            color: None,
        },
        CellValue::Error(e) => CellDisplayResult {
            text: format!("#{:?}", e).to_uppercase(),
            color: None,
        },
    }
}

pub fn format_cell_value_simple(value: &CellValue) -> String {
    match value {
        CellValue::Empty => String::new(),
        CellValue::Number(n) => format_number_simple(*n),
        CellValue::Text(s) => s.clone(),
        CellValue::Boolean(b) => if *b { "TRUE" } else { "FALSE" }.to_string(),
        CellValue::Error(e) => format!("#{:?}", e).to_uppercase(),
    }
}

pub fn format_number_simple(n: f64) -> String {
    if n.fract() == 0.0 {
        format!("{:.0}", n)
    } else {
        let s = format!("{:.10}", n);
        s.trim_end_matches('0').trim_end_matches('.').to_string()
    }
}

// ============================================================================
// EXPRESSION CONVERSION (Parser -> Engine)
// ============================================================================

fn convert_value(v: &ParserValue) -> EngineValue {
    match v {
        ParserValue::Number(n) => EngineValue::Number(*n),
        ParserValue::String(s) => EngineValue::String(s.clone()),
        ParserValue::Boolean(b) => EngineValue::Boolean(*b),
    }
}

fn convert_binary_op(op: &ParserBinaryOp) -> EngineBinaryOp {
    match op {
        ParserBinaryOp::Add => EngineBinaryOp::Add,
        ParserBinaryOp::Subtract => EngineBinaryOp::Subtract,
        ParserBinaryOp::Multiply => EngineBinaryOp::Multiply,
        ParserBinaryOp::Divide => EngineBinaryOp::Divide,
        ParserBinaryOp::Power => EngineBinaryOp::Power,
        ParserBinaryOp::Concat => EngineBinaryOp::Concat,
        ParserBinaryOp::Equal => EngineBinaryOp::Equal,
        ParserBinaryOp::NotEqual => EngineBinaryOp::NotEqual,
        ParserBinaryOp::LessThan => EngineBinaryOp::LessThan,
        ParserBinaryOp::GreaterThan => EngineBinaryOp::GreaterThan,
        ParserBinaryOp::LessEqual => EngineBinaryOp::LessEqual,
        ParserBinaryOp::GreaterEqual => EngineBinaryOp::GreaterEqual,
    }
}

fn convert_unary_op(op: &ParserUnaryOp) -> EngineUnaryOp {
    match op {
        ParserUnaryOp::Negate => EngineUnaryOp::Negate,
    }
}

fn convert_builtin_function(func: &ParserBuiltinFn) -> EngineBuiltinFn {
    match func {
        ParserBuiltinFn::Sum => EngineBuiltinFn::Sum,
        ParserBuiltinFn::Average => EngineBuiltinFn::Average,
        ParserBuiltinFn::Min => EngineBuiltinFn::Min,
        ParserBuiltinFn::Max => EngineBuiltinFn::Max,
        ParserBuiltinFn::Count => EngineBuiltinFn::Count,
        ParserBuiltinFn::CountA => EngineBuiltinFn::CountA,
        ParserBuiltinFn::If => EngineBuiltinFn::If,
        ParserBuiltinFn::And => EngineBuiltinFn::And,
        ParserBuiltinFn::Or => EngineBuiltinFn::Or,
        ParserBuiltinFn::Not => EngineBuiltinFn::Not,
        ParserBuiltinFn::True => EngineBuiltinFn::True,
        ParserBuiltinFn::False => EngineBuiltinFn::False,
        ParserBuiltinFn::Abs => EngineBuiltinFn::Abs,
        ParserBuiltinFn::Round => EngineBuiltinFn::Round,
        ParserBuiltinFn::Floor => EngineBuiltinFn::Floor,
        ParserBuiltinFn::Ceiling => EngineBuiltinFn::Ceiling,
        ParserBuiltinFn::Sqrt => EngineBuiltinFn::Sqrt,
        ParserBuiltinFn::Power => EngineBuiltinFn::Power,
        ParserBuiltinFn::Mod => EngineBuiltinFn::Mod,
        ParserBuiltinFn::Int => EngineBuiltinFn::Int,
        ParserBuiltinFn::Sign => EngineBuiltinFn::Sign,
        ParserBuiltinFn::Len => EngineBuiltinFn::Len,
        ParserBuiltinFn::Upper => EngineBuiltinFn::Upper,
        ParserBuiltinFn::Lower => EngineBuiltinFn::Lower,
        ParserBuiltinFn::Trim => EngineBuiltinFn::Trim,
        ParserBuiltinFn::Concatenate => EngineBuiltinFn::Concatenate,
        ParserBuiltinFn::Left => EngineBuiltinFn::Left,
        ParserBuiltinFn::Right => EngineBuiltinFn::Right,
        ParserBuiltinFn::Mid => EngineBuiltinFn::Mid,
        ParserBuiltinFn::Rept => EngineBuiltinFn::Rept,
        ParserBuiltinFn::Text => EngineBuiltinFn::Text,
        ParserBuiltinFn::IsNumber => EngineBuiltinFn::IsNumber,
        ParserBuiltinFn::IsText => EngineBuiltinFn::IsText,
        ParserBuiltinFn::IsBlank => EngineBuiltinFn::IsBlank,
        ParserBuiltinFn::IsError => EngineBuiltinFn::IsError,
        ParserBuiltinFn::XLookup => EngineBuiltinFn::XLookup,
        ParserBuiltinFn::XLookups => EngineBuiltinFn::XLookups,
        ParserBuiltinFn::SetRowHeight => EngineBuiltinFn::SetRowHeight,
        ParserBuiltinFn::SetColumnWidth => EngineBuiltinFn::SetColumnWidth,
        ParserBuiltinFn::SetCellFillColor => EngineBuiltinFn::SetCellFillColor,
        ParserBuiltinFn::GetRowHeight => EngineBuiltinFn::GetRowHeight,
        ParserBuiltinFn::GetColumnWidth => EngineBuiltinFn::GetColumnWidth,
        ParserBuiltinFn::GetCellFillColor => EngineBuiltinFn::GetCellFillColor,
        ParserBuiltinFn::Row => EngineBuiltinFn::Row,
        ParserBuiltinFn::Column => EngineBuiltinFn::Column,
        ParserBuiltinFn::Custom(name) => EngineBuiltinFn::Custom(name.clone()),
    }
}

pub fn convert_expr(expr: &ParserExpr) -> EngineExpr {
    match expr {
        ParserExpr::Literal(v) => EngineExpr::Literal(convert_value(v)),
        ParserExpr::CellRef { sheet, col, row, .. } => {
            // Wildcard '*' sheet means all sheets — convert to Sheet3DRef
            if sheet.as_deref() == Some("*") {
                return EngineExpr::Sheet3DRef {
                    start_sheet: "*".to_string(),
                    end_sheet: "*".to_string(),
                    reference: Box::new(EngineExpr::CellRef {
                        sheet: None,
                        col: col.clone(),
                        row: *row,
                    }),
                };
            }
            EngineExpr::CellRef {
                sheet: sheet.clone(),
                col: col.clone(),
                row: *row,
            }
        }
        ParserExpr::Range { sheet, start, end } => {
            // Wildcard '*' sheet means all sheets — convert to Sheet3DRef
            if sheet.as_deref() == Some("*") {
                return EngineExpr::Sheet3DRef {
                    start_sheet: "*".to_string(),
                    end_sheet: "*".to_string(),
                    reference: Box::new(EngineExpr::Range {
                        sheet: None,
                        start: Box::new(convert_expr(start)),
                        end: Box::new(convert_expr(end)),
                    }),
                };
            }
            EngineExpr::Range {
                sheet: sheet.clone(),
                start: Box::new(convert_expr(start)),
                end: Box::new(convert_expr(end)),
            }
        }
        ParserExpr::ColumnRef { sheet, start_col, end_col, .. } => {
            if sheet.as_deref() == Some("*") {
                return EngineExpr::Sheet3DRef {
                    start_sheet: "*".to_string(),
                    end_sheet: "*".to_string(),
                    reference: Box::new(EngineExpr::ColumnRef {
                        sheet: None,
                        start_col: start_col.clone(),
                        end_col: end_col.clone(),
                    }),
                };
            }
            EngineExpr::ColumnRef {
                sheet: sheet.clone(),
                start_col: start_col.clone(),
                end_col: end_col.clone(),
            }
        }
        ParserExpr::RowRef { sheet, start_row, end_row, .. } => {
            if sheet.as_deref() == Some("*") {
                return EngineExpr::Sheet3DRef {
                    start_sheet: "*".to_string(),
                    end_sheet: "*".to_string(),
                    reference: Box::new(EngineExpr::RowRef {
                        sheet: None,
                        start_row: *start_row,
                        end_row: *end_row,
                    }),
                };
            }
            EngineExpr::RowRef {
                sheet: sheet.clone(),
                start_row: *start_row,
                end_row: *end_row,
            }
        }
        ParserExpr::BinaryOp { left, op, right } => EngineExpr::BinaryOp {
            left: Box::new(convert_expr(left)),
            op: convert_binary_op(op),
            right: Box::new(convert_expr(right)),
        },
        ParserExpr::UnaryOp { op, operand } => EngineExpr::UnaryOp {
            op: convert_unary_op(op),
            operand: Box::new(convert_expr(operand)),
        },
        ParserExpr::FunctionCall { func, args } => EngineExpr::FunctionCall {
            func: convert_builtin_function(func),
            args: args.iter().map(convert_expr).collect(),
        },
        // NamedRef nodes should have been resolved before reaching convert_expr.
        // If one reaches here, it means the name was not found — produce #NAME? error
        // by calling a Custom function (which the evaluator maps to CellError::Name).
        ParserExpr::NamedRef { name } => EngineExpr::FunctionCall {
            func: EngineBuiltinFn::Custom(format!("_UNRESOLVED_{}", name)),
            args: vec![],
        },
        // 3D cross-sheet reference: Sheet1:Sheet5!A1 or 'Jan:Dec'!A1:B10
        ParserExpr::Sheet3DRef { start_sheet, end_sheet, reference } => EngineExpr::Sheet3DRef {
            start_sheet: start_sheet.clone(),
            end_sheet: end_sheet.clone(),
            reference: Box::new(convert_expr(reference)),
        },
        // TableRef nodes should have been resolved before reaching convert_expr.
        // If one reaches here unresolved, produce #NAME? error.
        ParserExpr::TableRef { table_name, .. } => {
            let display = if table_name.is_empty() {
                "TABLE_REF".to_string()
            } else {
                table_name.clone()
            };
            EngineExpr::FunctionCall {
                func: EngineBuiltinFn::Custom(format!("_UNRESOLVED_{}", display)),
                args: vec![],
            }
        }
    }
}

fn col_letter_to_index(col: &str) -> u32 {
    let mut result: u32 = 0;
    for c in col.chars() {
        let val = (c.to_ascii_uppercase() as u32) - ('A' as u32) + 1;
        result = result * 26 + val;
    }
    result.saturating_sub(1)
}

// ============================================================================
// FORMULA EVALUATION
// ============================================================================

/// Result of extracting references from a formula expression
pub struct ExtractedRefs {
    /// Individual cell references (row, col) on the current sheet - 0-indexed
    pub cells: HashSet<(u32, u32)>,
    /// Column references (column indices)
    pub columns: HashSet<u32>,
    /// Row references (row indices) - 0-indexed
    pub rows: HashSet<u32>,
    /// Cross-sheet cell references (sheet_name, row, col) - row is 0-indexed
    pub cross_sheet_cells: HashSet<(String, u32, u32)>,
}

impl ExtractedRefs {
    pub fn new() -> Self {
        ExtractedRefs {
            cells: HashSet::new(),
            columns: HashSet::new(),
            rows: HashSet::new(),
            cross_sheet_cells: HashSet::new(),
        }
    }
}

pub fn extract_references(expr: &ParserExpr, grid: &Grid) -> HashSet<(u32, u32)> {
    let refs = extract_all_references(expr, grid);
    refs.cells
}

pub fn extract_all_references(expr: &ParserExpr, grid: &Grid) -> ExtractedRefs {
    let mut refs = ExtractedRefs::new();
    extract_references_recursive(expr, grid, &mut refs);
    refs
}

fn extract_references_recursive(expr: &ParserExpr, grid: &Grid, refs: &mut ExtractedRefs) {
    match expr {
        ParserExpr::Literal(_) => {}
        ParserExpr::CellRef { sheet, col, row, .. } => {
            let col_idx = col_letter_to_index(col);
            let row_idx = row.saturating_sub(1);
            if let Some(sheet_name) = sheet {
                refs.cross_sheet_cells.insert((sheet_name.clone(), row_idx, col_idx));
            } else {
                refs.cells.insert((row_idx, col_idx));
            }
        }
        ParserExpr::Range { sheet, start, end } => {
            if let (
                ParserExpr::CellRef { col: start_col, row: start_row, .. },
                ParserExpr::CellRef { col: end_col, row: end_row, .. },
            ) = (start.as_ref(), end.as_ref())
            {
                let sc = col_letter_to_index(start_col);
                let ec = col_letter_to_index(end_col);
                let sr = start_row.saturating_sub(1);
                let er = end_row.saturating_sub(1);
                
                if let Some(sheet_name) = sheet {
                    for r in sr.min(er)..=sr.max(er) {
                        for c in sc.min(ec)..=sc.max(ec) {
                            refs.cross_sheet_cells.insert((sheet_name.clone(), r, c));
                        }
                    }
                } else {
                    for r in sr.min(er)..=sr.max(er) {
                        for c in sc.min(ec)..=sc.max(ec) {
                            refs.cells.insert((r, c));
                        }
                    }
                }
            } else {
                extract_references_recursive(start, grid, refs);
                extract_references_recursive(end, grid, refs);
            }
        }
        ParserExpr::ColumnRef { start_col, end_col, .. } => {
            let sc = col_letter_to_index(start_col);
            let ec = col_letter_to_index(end_col);
            let min_col = sc.min(ec);
            let max_col = sc.max(ec);
            
            for col in min_col..=max_col {
                refs.columns.insert(col);
            }
            
            for ((r, c), _) in grid.cells.iter() {
                if *c >= min_col && *c <= max_col {
                    refs.cells.insert((*r, *c));
                }
            }
        }
        ParserExpr::RowRef { start_row, end_row, .. } => {
            let min_row = start_row.saturating_sub(1).min(end_row.saturating_sub(1));
            let max_row = start_row.saturating_sub(1).max(end_row.saturating_sub(1));
            
            for row in min_row..=max_row {
                refs.rows.insert(row);
            }
            
            for ((r, c), _) in grid.cells.iter() {
                if *r >= min_row && *r <= max_row {
                    refs.cells.insert((*r, *c));
                }
            }
        }
        ParserExpr::BinaryOp { left, right, .. } => {
            extract_references_recursive(left, grid, refs);
            extract_references_recursive(right, grid, refs);
        }
        ParserExpr::UnaryOp { operand, .. } => {
            extract_references_recursive(operand, grid, refs);
        }
        ParserExpr::FunctionCall { args, .. } => {
            for arg in args {
                extract_references_recursive(arg, grid, refs);
            }
        }
        // 3D cross-sheet reference: tag inner cells with each bookend sheet
        ParserExpr::Sheet3DRef { start_sheet, end_sheet, reference } => {
            // Extract the inner reference's cells (without sheet context)
            let mut inner_refs = ExtractedRefs::new();
            extract_references_recursive(reference, grid, &mut inner_refs);
            // Tag each cell with both bookend sheets as cross-sheet dependencies
            for (row, col) in &inner_refs.cells {
                refs.cross_sheet_cells.insert((start_sheet.clone(), *row, *col));
                refs.cross_sheet_cells.insert((end_sheet.clone(), *row, *col));
            }
        }
        // NamedRef nodes should be resolved before reference extraction.
        // If one is still present, it means the name couldn't be resolved — skip.
        ParserExpr::NamedRef { .. } => {}
        // TableRef nodes should be resolved before reference extraction.
        // If still present, skip (will produce #NAME? during evaluation).
        ParserExpr::TableRef { .. } => {}
    }
}

// ============================================================================
// NAMED REFERENCE RESOLUTION (AST SPLICING)
// ============================================================================

/// Resolves all `NamedRef` nodes in a parser AST by splicing in the parsed
/// `refers_to` sub-ASTs from the named ranges map. This implements "macro-expansion"
/// style name resolution: `=SUM(SalesData)` where SalesData = `=Sheet1!$A$1:$A$10`
/// becomes `SUM(Range(Sheet1!A1:A10))`.
///
/// Circular references are detected via the `visited` set. If a name refers to
/// itself (directly or indirectly), the NamedRef is replaced with an error literal.
pub fn resolve_names_in_ast(
    ast: &ParserExpr,
    named_ranges: &HashMap<String, named_ranges::NamedRange>,
    current_sheet_index: usize,
    visited: &mut HashSet<String>,
) -> ParserExpr {
    match ast {
        ParserExpr::NamedRef { name } => {
            let key = name.to_uppercase();

            // Circular reference detection
            if visited.contains(&key) {
                return ParserExpr::Literal(ParserValue::Number(f64::NAN));
            }

            // Look up the name (scope-aware: prefer sheet-scoped, then workbook-scoped)
            let nr = named_ranges
                .values()
                .find(|nr| {
                    let nr_key = nr.name.to_uppercase();
                    if nr_key != key {
                        return false;
                    }
                    // Sheet-scoped name matching current sheet
                    nr.sheet_index == Some(current_sheet_index)
                })
                .or_else(|| {
                    // Fall back to workbook-scoped
                    named_ranges.values().find(|nr| {
                        let nr_key = nr.name.to_uppercase();
                        nr_key == key && nr.sheet_index.is_none()
                    })
                });

            match nr {
                Some(nr) => {
                    // Parse the refers_to formula
                    match parse_formula(&nr.refers_to) {
                        Ok(sub_ast) => {
                            // Recursively resolve names in the sub-AST
                            visited.insert(key.clone());
                            let resolved = resolve_names_in_ast(
                                &sub_ast,
                                named_ranges,
                                current_sheet_index,
                                visited,
                            );
                            visited.remove(&key);
                            resolved
                        }
                        Err(_) => {
                            // Parse error in refers_to — treat as #NAME? error
                            ParserExpr::Literal(ParserValue::Number(f64::NAN))
                        }
                    }
                }
                None => {
                    // Name not found — leave as NamedRef (will become #NAME? in convert_expr)
                    ast.clone()
                }
            }
        }
        ParserExpr::Literal(_) => ast.clone(),
        ParserExpr::CellRef { .. } => ast.clone(),
        ParserExpr::ColumnRef { .. } => ast.clone(),
        ParserExpr::RowRef { .. } => ast.clone(),
        ParserExpr::BinaryOp { left, op, right } => ParserExpr::BinaryOp {
            left: Box::new(resolve_names_in_ast(left, named_ranges, current_sheet_index, visited)),
            op: *op,
            right: Box::new(resolve_names_in_ast(right, named_ranges, current_sheet_index, visited)),
        },
        ParserExpr::UnaryOp { op, operand } => ParserExpr::UnaryOp {
            op: *op,
            operand: Box::new(resolve_names_in_ast(operand, named_ranges, current_sheet_index, visited)),
        },
        ParserExpr::FunctionCall { func, args } => ParserExpr::FunctionCall {
            func: func.clone(),
            args: args
                .iter()
                .map(|a| resolve_names_in_ast(a, named_ranges, current_sheet_index, visited))
                .collect(),
        },
        ParserExpr::Range { sheet, start, end } => ParserExpr::Range {
            sheet: sheet.clone(),
            start: Box::new(resolve_names_in_ast(start, named_ranges, current_sheet_index, visited)),
            end: Box::new(resolve_names_in_ast(end, named_ranges, current_sheet_index, visited)),
        },
        // 3D cross-sheet reference: recurse into inner reference
        ParserExpr::Sheet3DRef { start_sheet, end_sheet, reference } => ParserExpr::Sheet3DRef {
            start_sheet: start_sheet.clone(),
            end_sheet: end_sheet.clone(),
            reference: Box::new(resolve_names_in_ast(reference, named_ranges, current_sheet_index, visited)),
        },
        // TableRef is resolved separately by resolve_table_refs_in_ast — pass through
        ParserExpr::TableRef { .. } => ast.clone(),
    }
}

/// Checks if a parser AST contains any NamedRef nodes that need resolution.
pub fn ast_has_named_refs(ast: &ParserExpr) -> bool {
    match ast {
        ParserExpr::NamedRef { .. } => true,
        ParserExpr::Literal(_) | ParserExpr::CellRef { .. }
        | ParserExpr::ColumnRef { .. } | ParserExpr::RowRef { .. }
        | ParserExpr::TableRef { .. } => false,
        ParserExpr::BinaryOp { left, right, .. } => {
            ast_has_named_refs(left) || ast_has_named_refs(right)
        }
        ParserExpr::UnaryOp { operand, .. } => ast_has_named_refs(operand),
        ParserExpr::FunctionCall { args, .. } => args.iter().any(ast_has_named_refs),
        ParserExpr::Range { start, end, .. } => {
            ast_has_named_refs(start) || ast_has_named_refs(end)
        }
        ParserExpr::Sheet3DRef { reference, .. } => ast_has_named_refs(reference),
    }
}

/// Checks if a parser AST contains any TableRef nodes that need resolution.
pub fn ast_has_table_refs(ast: &ParserExpr) -> bool {
    match ast {
        ParserExpr::TableRef { .. } => true,
        ParserExpr::Literal(_) | ParserExpr::CellRef { .. }
        | ParserExpr::ColumnRef { .. } | ParserExpr::RowRef { .. }
        | ParserExpr::NamedRef { .. } => false,
        ParserExpr::BinaryOp { left, right, .. } => {
            ast_has_table_refs(left) || ast_has_table_refs(right)
        }
        ParserExpr::UnaryOp { operand, .. } => ast_has_table_refs(operand),
        ParserExpr::FunctionCall { args, .. } => args.iter().any(ast_has_table_refs),
        ParserExpr::Range { start, end, .. } => {
            ast_has_table_refs(start) || ast_has_table_refs(end)
        }
        ParserExpr::Sheet3DRef { reference, .. } => ast_has_table_refs(reference),
    }
}

// ============================================================================
// TABLE REFERENCE RESOLUTION (AST SPLICING)
// ============================================================================

/// Context needed to resolve structured table references.
pub struct TableRefContext<'a> {
    /// All tables indexed by sheet_index -> table_id -> Table
    pub tables: &'a tables::TableStorage,
    /// Table name registry: uppercase_name -> (sheet_index, table_id)
    pub table_names: &'a tables::TableNameRegistry,
    /// The sheet index where the formula cell lives
    pub current_sheet_index: usize,
    /// The row of the formula cell (0-indexed) — needed for @ (this-row) references
    pub current_row: u32,
}

/// Resolves all `TableRef` nodes in a parser AST by converting them to
/// `CellRef` or `Range` nodes based on the table definitions.
///
/// Table references like `Table1[Revenue]` become `Range(CellRef(data_start_row, col)..CellRef(data_end_row, col))`.
/// This-row references like `[@Revenue]` become `CellRef(current_row, col)`.
pub fn resolve_table_refs_in_ast(
    ast: &ParserExpr,
    ctx: &TableRefContext,
) -> ParserExpr {
    match ast {
        ParserExpr::TableRef { table_name, specifier } => {
            resolve_single_table_ref(table_name, specifier, ctx)
        }
        ParserExpr::Literal(_) => ast.clone(),
        ParserExpr::CellRef { .. } => ast.clone(),
        ParserExpr::ColumnRef { .. } => ast.clone(),
        ParserExpr::RowRef { .. } => ast.clone(),
        ParserExpr::NamedRef { .. } => ast.clone(),
        ParserExpr::BinaryOp { left, op, right } => ParserExpr::BinaryOp {
            left: Box::new(resolve_table_refs_in_ast(left, ctx)),
            op: *op,
            right: Box::new(resolve_table_refs_in_ast(right, ctx)),
        },
        ParserExpr::UnaryOp { op, operand } => ParserExpr::UnaryOp {
            op: *op,
            operand: Box::new(resolve_table_refs_in_ast(operand, ctx)),
        },
        ParserExpr::FunctionCall { func, args } => ParserExpr::FunctionCall {
            func: func.clone(),
            args: args.iter().map(|a| resolve_table_refs_in_ast(a, ctx)).collect(),
        },
        ParserExpr::Range { sheet, start, end } => ParserExpr::Range {
            sheet: sheet.clone(),
            start: Box::new(resolve_table_refs_in_ast(start, ctx)),
            end: Box::new(resolve_table_refs_in_ast(end, ctx)),
        },
        // 3D cross-sheet reference: recurse into inner reference
        ParserExpr::Sheet3DRef { start_sheet, end_sheet, reference } => ParserExpr::Sheet3DRef {
            start_sheet: start_sheet.clone(),
            end_sheet: end_sheet.clone(),
            reference: Box::new(resolve_table_refs_in_ast(reference, ctx)),
        },
    }
}

/// Resolves a single TableRef node to CellRef/Range based on table metadata.
fn resolve_single_table_ref(
    table_name: &str,
    specifier: &ParserTableSpecifier,
    ctx: &TableRefContext,
) -> ParserExpr {
    // Find the table
    let table = if table_name.is_empty() {
        // Empty table name — infer from current cell position
        find_table_at_cell(ctx.tables, ctx.current_sheet_index, ctx.current_row)
    } else {
        find_table_by_name(table_name, ctx.tables, ctx.table_names)
    };

    let table = match table {
        Some(t) => t,
        None => {
            // Table not found — leave as unresolvable (will become #NAME?)
            return ParserExpr::NamedRef {
                name: if table_name.is_empty() {
                    "TABLE_REF".to_string()
                } else {
                    table_name.to_string()
                },
            };
        }
    };

    // Convert 0-based grid columns to 1-based A1 column letters
    match specifier {
        ParserTableSpecifier::Column(col_name) => {
            resolve_column_ref(&table, col_name, false)
        }
        ParserTableSpecifier::ThisRow(col_name) => {
            resolve_this_row_ref(&table, col_name, ctx.current_row)
        }
        ParserTableSpecifier::ColumnRange(start_col, end_col) => {
            resolve_column_range(&table, start_col, end_col, false)
        }
        ParserTableSpecifier::ThisRowRange(start_col, end_col) => {
            resolve_this_row_range(&table, start_col, end_col, ctx.current_row)
        }
        ParserTableSpecifier::AllRows => {
            make_range(None, table.start_row, table.start_col, table.end_row, table.end_col)
        }
        ParserTableSpecifier::DataRows => {
            make_range(None, table.data_start_row(), table.start_col, table.data_end_row(), table.end_col)
        }
        ParserTableSpecifier::Headers => {
            if table.style_options.header_row {
                make_range(None, table.start_row, table.start_col, table.start_row, table.end_col)
            } else {
                // No header row — return error
                ParserExpr::NamedRef { name: "_UNRESOLVED_HEADERS".to_string() }
            }
        }
        ParserTableSpecifier::Totals => {
            if table.style_options.total_row {
                make_range(None, table.end_row, table.start_col, table.end_row, table.end_col)
            } else {
                ParserExpr::NamedRef { name: "_UNRESOLVED_TOTALS".to_string() }
            }
        }
        ParserTableSpecifier::SpecialColumn(special_spec, col_name) => {
            resolve_special_column(&table, special_spec, col_name, ctx.current_row)
        }
    }
}

/// Finds a table by name using the name registry.
fn find_table_by_name<'a>(
    name: &str,
    tables: &'a tables::TableStorage,
    table_names: &tables::TableNameRegistry,
) -> Option<&'a tables::Table> {
    let key = name.to_uppercase();
    let (sheet_index, table_id) = table_names.get(&key)?;
    tables.get(sheet_index)?.get(table_id)
}

/// Finds the table that contains the given cell (for implicit table name resolution).
fn find_table_at_cell(
    tables: &tables::TableStorage,
    sheet_index: usize,
    current_row: u32,
) -> Option<&tables::Table> {
    // Look through all tables on the current sheet
    if let Some(sheet_tables) = tables.get(&sheet_index) {
        for table in sheet_tables.values() {
            if current_row >= table.start_row && current_row <= table.end_row {
                return Some(table);
            }
        }
    }
    None
}

/// Converts a 0-indexed column number to 1-based A1-style column letters.
fn index_to_col_letters(col_index: u32) -> String {
    let mut result = String::new();
    let mut n = col_index + 1; // Convert to 1-based
    while n > 0 {
        n -= 1;
        result.insert(0, (b'A' + (n % 26) as u8) as char);
        n /= 26;
    }
    result
}

/// Resolves Table1[Column] to a Range over the data rows of that column.
fn resolve_column_ref(
    table: &tables::Table,
    col_name: &str,
    _include_headers: bool,
) -> ParserExpr {
    match table.get_column_index(col_name) {
        Some(col_idx) => {
            let abs_col = table.start_col + col_idx as u32;
            make_range(
                None,
                table.data_start_row(),
                abs_col,
                table.data_end_row(),
                abs_col,
            )
        }
        None => ParserExpr::NamedRef {
            name: format!("_UNRESOLVED_{}_{}", table.name, col_name),
        },
    }
}

/// Resolves [@Column] to a single CellRef at the current row.
fn resolve_this_row_ref(
    table: &tables::Table,
    col_name: &str,
    current_row: u32,
) -> ParserExpr {
    match table.get_column_index(col_name) {
        Some(col_idx) => {
            let abs_col = table.start_col + col_idx as u32;
            let col_letters = index_to_col_letters(abs_col);
            // Row is 1-indexed in the AST
            ParserExpr::CellRef {
                sheet: None,
                col: col_letters,
                row: current_row + 1,
                col_absolute: true,
                row_absolute: true,
            }
        }
        None => ParserExpr::NamedRef {
            name: format!("_UNRESOLVED_{}_{}", table.name, col_name),
        },
    }
}

/// Resolves Table1[[Col1]:[Col2]] to a Range spanning those columns.
fn resolve_column_range(
    table: &tables::Table,
    start_col: &str,
    end_col: &str,
    _include_headers: bool,
) -> ParserExpr {
    let start_idx = table.get_column_index(start_col);
    let end_idx = table.get_column_index(end_col);

    match (start_idx, end_idx) {
        (Some(si), Some(ei)) => {
            let abs_start_col = table.start_col + si as u32;
            let abs_end_col = table.start_col + ei as u32;
            make_range(
                None,
                table.data_start_row(),
                abs_start_col,
                table.data_end_row(),
                abs_end_col,
            )
        }
        _ => ParserExpr::NamedRef {
            name: format!("_UNRESOLVED_{}_RANGE", table.name),
        },
    }
}

/// Resolves [@Col1]:[@Col2] to a Range on the current row spanning those columns.
fn resolve_this_row_range(
    table: &tables::Table,
    start_col: &str,
    end_col: &str,
    current_row: u32,
) -> ParserExpr {
    let start_idx = table.get_column_index(start_col);
    let end_idx = table.get_column_index(end_col);

    match (start_idx, end_idx) {
        (Some(si), Some(ei)) => {
            let abs_start_col = table.start_col + si as u32;
            let abs_end_col = table.start_col + ei as u32;
            make_range(
                None,
                current_row,
                abs_start_col,
                current_row,
                abs_end_col,
            )
        }
        _ => ParserExpr::NamedRef {
            name: format!("_UNRESOLVED_{}_RANGE", table.name),
        },
    }
}

/// Resolves [#Headers],[Column] or [#Totals],[Column] combinations.
fn resolve_special_column(
    table: &tables::Table,
    special: &ParserTableSpecifier,
    col_name: &str,
    _current_row: u32,
) -> ParserExpr {
    let col_idx = match table.get_column_index(col_name) {
        Some(idx) => idx,
        None => {
            return ParserExpr::NamedRef {
                name: format!("_UNRESOLVED_{}_{}", table.name, col_name),
            };
        }
    };
    let abs_col = table.start_col + col_idx as u32;

    match special {
        ParserTableSpecifier::Headers => {
            if table.style_options.header_row {
                make_range(None, table.start_row, abs_col, table.start_row, abs_col)
            } else {
                ParserExpr::NamedRef { name: "_UNRESOLVED_HEADERS".to_string() }
            }
        }
        ParserTableSpecifier::Totals => {
            if table.style_options.total_row {
                make_range(None, table.end_row, abs_col, table.end_row, abs_col)
            } else {
                ParserExpr::NamedRef { name: "_UNRESOLVED_TOTALS".to_string() }
            }
        }
        ParserTableSpecifier::AllRows => {
            make_range(None, table.start_row, abs_col, table.end_row, abs_col)
        }
        ParserTableSpecifier::DataRows => {
            make_range(None, table.data_start_row(), abs_col, table.data_end_row(), abs_col)
        }
        _ => ParserExpr::NamedRef {
            name: format!("_UNRESOLVED_SPECIAL_{}", table.name),
        },
    }
}

/// Creates a Range expression from 0-indexed row/col coordinates.
/// Uses absolute references ($) for stability.
fn make_range(
    sheet: Option<String>,
    start_row: u32,
    start_col: u32,
    end_row: u32,
    end_col: u32,
) -> ParserExpr {
    let start_col_letters = index_to_col_letters(start_col);
    let end_col_letters = index_to_col_letters(end_col);

    // If it's a single cell, return CellRef instead of Range
    if start_row == end_row && start_col == end_col {
        return ParserExpr::CellRef {
            sheet,
            col: start_col_letters,
            row: start_row + 1, // AST uses 1-indexed rows
            col_absolute: true,
            row_absolute: true,
        };
    }

    ParserExpr::Range {
        sheet,
        start: Box::new(ParserExpr::CellRef {
            sheet: None,
            col: start_col_letters,
            row: start_row + 1, // AST uses 1-indexed rows
            col_absolute: true,
            row_absolute: true,
        }),
        end: Box::new(ParserExpr::CellRef {
            sheet: None,
            col: end_col_letters,
            row: end_row + 1,
            col_absolute: true,
            row_absolute: true,
        }),
    }
}

// ============================================================================
// AST-to-formula serialization (for Convert to Range, etc.)
// ============================================================================

/// Converts a parser AST node back to a formula string.
/// Used by Convert to Range to rewrite table references as A1-style references.
pub fn expression_to_formula(expr: &ParserExpr) -> String {
    match expr {
        ParserExpr::Literal(val) => match val {
            ParserValue::Number(n) => {
                // Format without trailing zeros for integers
                if *n == (*n as i64) as f64 && n.abs() < 1e15 {
                    format!("{}", *n as i64)
                } else {
                    format!("{}", n)
                }
            }
            ParserValue::String(s) => format!("\"{}\"", s),
            ParserValue::Boolean(b) => if *b { "TRUE" } else { "FALSE" }.to_string(),
        },
        ParserExpr::CellRef { sheet, col, row, col_absolute, row_absolute } => {
            let mut s = String::new();
            if let Some(sheet_name) = sheet {
                if sheet_name.contains(' ') || sheet_name.contains('\'') {
                    s.push_str(&format!("'{}'!", sheet_name));
                } else {
                    s.push_str(&format!("{}!", sheet_name));
                }
            }
            if *col_absolute { s.push('$'); }
            s.push_str(col);
            if *row_absolute { s.push('$'); }
            s.push_str(&row.to_string());
            s
        }
        ParserExpr::Range { sheet, start, end } => {
            let mut s = String::new();
            if let Some(sheet_name) = sheet {
                if sheet_name.contains(' ') || sheet_name.contains('\'') {
                    s.push_str(&format!("'{}'!", sheet_name));
                } else {
                    s.push_str(&format!("{}!", sheet_name));
                }
            }
            // Start CellRef without sheet prefix (sheet is on the Range node)
            s.push_str(&expression_to_formula_no_sheet(start));
            s.push(':');
            s.push_str(&expression_to_formula_no_sheet(end));
            s
        }
        ParserExpr::ColumnRef { sheet, start_col, end_col, start_absolute, end_absolute } => {
            let mut s = String::new();
            if let Some(sheet_name) = sheet {
                if sheet_name.contains(' ') || sheet_name.contains('\'') {
                    s.push_str(&format!("'{}'!", sheet_name));
                } else {
                    s.push_str(&format!("{}!", sheet_name));
                }
            }
            if *start_absolute { s.push('$'); }
            s.push_str(start_col);
            s.push(':');
            if *end_absolute { s.push('$'); }
            s.push_str(end_col);
            s
        }
        ParserExpr::RowRef { sheet, start_row, end_row, start_absolute, end_absolute } => {
            let mut s = String::new();
            if let Some(sheet_name) = sheet {
                if sheet_name.contains(' ') || sheet_name.contains('\'') {
                    s.push_str(&format!("'{}'!", sheet_name));
                } else {
                    s.push_str(&format!("{}!", sheet_name));
                }
            }
            if *start_absolute { s.push('$'); }
            s.push_str(&start_row.to_string());
            s.push(':');
            if *end_absolute { s.push('$'); }
            s.push_str(&end_row.to_string());
            s
        }
        ParserExpr::BinaryOp { left, op, right } => {
            format!("{}{}{}", expression_to_formula(left), op, expression_to_formula(right))
        }
        ParserExpr::UnaryOp { op, operand } => {
            format!("{}{}", op, expression_to_formula(operand))
        }
        ParserExpr::FunctionCall { func, args } => {
            let func_name = builtin_function_to_name(func);
            let arg_strs: Vec<String> = args.iter().map(|a| expression_to_formula(a)).collect();
            format!("{}({})", func_name, arg_strs.join(","))
        }
        ParserExpr::NamedRef { name } => name.clone(),
        ParserExpr::Sheet3DRef { start_sheet, end_sheet, reference } => {
            let mut s = String::new();
            let combined = format!("{}:{}", start_sheet, end_sheet);
            // Quote if either sheet name contains spaces or special chars
            if start_sheet.contains(' ') || end_sheet.contains(' ')
                || start_sheet.contains('\'') || end_sheet.contains('\'')
            {
                s.push_str(&format!("'{}'!", combined));
            } else {
                s.push_str(&format!("{}!", combined));
            }
            s.push_str(&expression_to_formula(reference));
            s
        }
        ParserExpr::TableRef { table_name, specifier } => {
            // Should not appear after resolution, but handle gracefully
            let spec_str = table_specifier_to_string(specifier);
            if table_name.is_empty() {
                format!("[{}]", spec_str)
            } else {
                format!("{}[{}]", table_name, spec_str)
            }
        }
    }
}

/// Helper: serializes a CellRef without its sheet prefix (for Range start/end).
fn expression_to_formula_no_sheet(expr: &ParserExpr) -> String {
    match expr {
        ParserExpr::CellRef { col, row, col_absolute, row_absolute, .. } => {
            let mut s = String::new();
            if *col_absolute { s.push('$'); }
            s.push_str(col);
            if *row_absolute { s.push('$'); }
            s.push_str(&row.to_string());
            s
        }
        _ => expression_to_formula(expr),
    }
}

/// Converts a BuiltinFunction enum variant back to its canonical name string.
fn builtin_function_to_name(func: &ParserBuiltinFn) -> String {
    match func {
        ParserBuiltinFn::Sum => "SUM".to_string(),
        ParserBuiltinFn::Average => "AVERAGE".to_string(),
        ParserBuiltinFn::Min => "MIN".to_string(),
        ParserBuiltinFn::Max => "MAX".to_string(),
        ParserBuiltinFn::Count => "COUNT".to_string(),
        ParserBuiltinFn::CountA => "COUNTA".to_string(),
        ParserBuiltinFn::If => "IF".to_string(),
        ParserBuiltinFn::And => "AND".to_string(),
        ParserBuiltinFn::Or => "OR".to_string(),
        ParserBuiltinFn::Not => "NOT".to_string(),
        ParserBuiltinFn::True => "TRUE".to_string(),
        ParserBuiltinFn::False => "FALSE".to_string(),
        ParserBuiltinFn::Abs => "ABS".to_string(),
        ParserBuiltinFn::Round => "ROUND".to_string(),
        ParserBuiltinFn::Floor => "FLOOR".to_string(),
        ParserBuiltinFn::Ceiling => "CEILING".to_string(),
        ParserBuiltinFn::Sqrt => "SQRT".to_string(),
        ParserBuiltinFn::Power => "POWER".to_string(),
        ParserBuiltinFn::Mod => "MOD".to_string(),
        ParserBuiltinFn::Int => "INT".to_string(),
        ParserBuiltinFn::Sign => "SIGN".to_string(),
        ParserBuiltinFn::Len => "LEN".to_string(),
        ParserBuiltinFn::Upper => "UPPER".to_string(),
        ParserBuiltinFn::Lower => "LOWER".to_string(),
        ParserBuiltinFn::Trim => "TRIM".to_string(),
        ParserBuiltinFn::Concatenate => "CONCATENATE".to_string(),
        ParserBuiltinFn::Left => "LEFT".to_string(),
        ParserBuiltinFn::Right => "RIGHT".to_string(),
        ParserBuiltinFn::Mid => "MID".to_string(),
        ParserBuiltinFn::Rept => "REPT".to_string(),
        ParserBuiltinFn::Text => "TEXT".to_string(),
        ParserBuiltinFn::IsNumber => "ISNUMBER".to_string(),
        ParserBuiltinFn::IsText => "ISTEXT".to_string(),
        ParserBuiltinFn::IsBlank => "ISBLANK".to_string(),
        ParserBuiltinFn::IsError => "ISERROR".to_string(),
        ParserBuiltinFn::XLookup => "XLOOKUP".to_string(),
        ParserBuiltinFn::XLookups => "XLOOKUPS".to_string(),
        ParserBuiltinFn::SetRowHeight => "SET.ROW.HEIGHT".to_string(),
        ParserBuiltinFn::SetColumnWidth => "SET.COLUMN.WIDTH".to_string(),
        ParserBuiltinFn::SetCellFillColor => "SET.CELL.FILLCOLOR".to_string(),
        ParserBuiltinFn::GetRowHeight => "GET.ROW.HEIGHT".to_string(),
        ParserBuiltinFn::GetColumnWidth => "GET.COLUMN.WIDTH".to_string(),
        ParserBuiltinFn::GetCellFillColor => "GET.CELL.FILLCOLOR".to_string(),
        ParserBuiltinFn::Row => "ROW".to_string(),
        ParserBuiltinFn::Column => "COLUMN".to_string(),
        ParserBuiltinFn::Custom(name) => name.clone(),
    }
}

/// Converts a TableSpecifier to its string representation for formula display.
fn table_specifier_to_string(spec: &ParserTableSpecifier) -> String {
    match spec {
        ParserTableSpecifier::Column(name) => format!("[{}]", name),
        ParserTableSpecifier::ThisRow(name) => format!("[@{}]", name),
        ParserTableSpecifier::ColumnRange(start, end) => format!("[{}]:[{}]", start, end),
        ParserTableSpecifier::ThisRowRange(start, end) => format!("[@{}]:[@{}]", start, end),
        ParserTableSpecifier::AllRows => "[#All]".to_string(),
        ParserTableSpecifier::DataRows => "[#Data]".to_string(),
        ParserTableSpecifier::Headers => "[#Headers]".to_string(),
        ParserTableSpecifier::Totals => "[#Totals]".to_string(),
        ParserTableSpecifier::SpecialColumn(special, col) => {
            format!("{},{}", table_specifier_to_string(special), col)
        }
    }
}

// ============================================================================
// 3D REFERENCE BOOKEND REPAIR
// ============================================================================

/// Repairs 3D reference bookends in a formula after a sheet is deleted.
/// - If the deleted sheet is a bookend, shrink to the adjacent sheet.
/// - If both bookends become invalid (single-sheet 3D ref deleted), returns None
///   to indicate the formula should show #REF!.
/// Returns Some(new_formula) if the formula was modified, None if it should become #REF!,
/// or the original formula unchanged if no 3D refs were affected.
pub fn repair_3d_refs_on_delete(
    formula: &str,
    deleted_name: &str,
    sheet_names_after: &[String],
) -> Option<String> {
    let ast = match parse_formula(formula) {
        Ok(ast) => ast,
        Err(_) => return Some(formula.to_string()),
    };

    let (new_ast, had_ref_error) = repair_3d_delete_recursive(&ast, deleted_name, sheet_names_after);
    if had_ref_error {
        return None; // Entire formula becomes #REF!
    }

    let new_formula = format!("={}", expression_to_formula(&new_ast));
    Some(new_formula)
}

/// Recursively walks a parser AST and repairs Sheet3DRef bookends after sheet deletion.
/// Returns (new_ast, had_ref_error).
fn repair_3d_delete_recursive(
    ast: &ParserExpr,
    deleted_name: &str,
    sheet_names_after: &[String],
) -> (ParserExpr, bool) {
    match ast {
        ParserExpr::Sheet3DRef { start_sheet, end_sheet, reference } => {
            let del_upper = deleted_name.to_uppercase();
            let start_is_deleted = start_sheet.to_uppercase() == del_upper;
            let end_is_deleted = end_sheet.to_uppercase() == del_upper;

            if start_is_deleted && end_is_deleted {
                // Both bookends are the deleted sheet — #REF!
                return (ast.clone(), true);
            }

            let new_start = if start_is_deleted {
                // Find the next sheet after the deleted one in the post-delete order
                // The "next" sheet is the one that was immediately after the deleted sheet
                // in the original order. In the post-delete list, we look for the sheet
                // that's now adjacent to where the deleted sheet was.
                find_adjacent_sheet(deleted_name, end_sheet, sheet_names_after, true)
            } else {
                Some(start_sheet.clone())
            };

            let new_end = if end_is_deleted {
                find_adjacent_sheet(deleted_name, start_sheet, sheet_names_after, false)
            } else {
                Some(end_sheet.clone())
            };

            match (new_start, new_end) {
                (Some(s), Some(e)) => {
                    let (new_ref, err) = repair_3d_delete_recursive(reference, deleted_name, sheet_names_after);
                    if err { return (ast.clone(), true); }
                    (ParserExpr::Sheet3DRef {
                        start_sheet: s,
                        end_sheet: e,
                        reference: Box::new(new_ref),
                    }, false)
                }
                _ => (ast.clone(), true), // Can't find replacement — #REF!
            }
        }
        ParserExpr::BinaryOp { left, op, right } => {
            let (new_left, l_err) = repair_3d_delete_recursive(left, deleted_name, sheet_names_after);
            let (new_right, r_err) = repair_3d_delete_recursive(right, deleted_name, sheet_names_after);
            (ParserExpr::BinaryOp {
                left: Box::new(new_left),
                op: *op,
                right: Box::new(new_right),
            }, l_err || r_err)
        }
        ParserExpr::UnaryOp { op, operand } => {
            let (new_op, err) = repair_3d_delete_recursive(operand, deleted_name, sheet_names_after);
            (ParserExpr::UnaryOp { op: *op, operand: Box::new(new_op) }, err)
        }
        ParserExpr::FunctionCall { func, args } => {
            let mut new_args = Vec::new();
            let mut any_err = false;
            for arg in args {
                let (new_arg, err) = repair_3d_delete_recursive(arg, deleted_name, sheet_names_after);
                any_err = any_err || err;
                new_args.push(new_arg);
            }
            (ParserExpr::FunctionCall { func: func.clone(), args: new_args }, any_err)
        }
        ParserExpr::Range { sheet, start, end } => {
            let (new_start, s_err) = repair_3d_delete_recursive(start, deleted_name, sheet_names_after);
            let (new_end, e_err) = repair_3d_delete_recursive(end, deleted_name, sheet_names_after);
            (ParserExpr::Range {
                sheet: sheet.clone(),
                start: Box::new(new_start),
                end: Box::new(new_end),
            }, s_err || e_err)
        }
        // Leaf nodes — no 3D refs to repair
        _ => (ast.clone(), false),
    }
}

/// Finds the sheet adjacent to the deleted one, constrained by the other bookend.
/// If `toward_start` is true, finds the first sheet in post-delete order.
/// If `toward_start` is false, finds the last sheet before the other bookend.
fn find_adjacent_sheet(
    _deleted_name: &str,
    other_bookend: &str,
    sheet_names_after: &[String],
    toward_start: bool,
) -> Option<String> {
    // The remaining bookend is `other_bookend`. We just need the first (or last)
    // sheet in the post-delete order. Since the deleted sheet is already removed
    // from sheet_names_after, the adjacent sheet is the first/last in the range
    // that includes the other bookend.
    let other_upper = other_bookend.to_uppercase();
    let other_idx = sheet_names_after.iter()
        .position(|s| s.to_uppercase() == other_upper)?;

    if toward_start {
        // The start bookend was deleted — new start is the sheet at the same position
        // (which was the next sheet after the deleted one in the original order)
        // In the simplest case, the first sheet in the remaining names works
        if other_idx > 0 {
            Some(sheet_names_after[0].clone())
        } else {
            Some(sheet_names_after[0].clone())
        }
    } else {
        // The end bookend was deleted — new end is the sheet just before other_bookend's position
        // in the post-delete order, or the last sheet
        if other_idx < sheet_names_after.len() - 1 {
            Some(sheet_names_after[sheet_names_after.len() - 1].clone())
        } else {
            Some(sheet_names_after[sheet_names_after.len() - 1].clone())
        }
    }
}

/// Repairs 3D reference bookends in a formula after a sheet is renamed.
/// Updates any bookend that matches the old name to use the new name.
pub fn repair_3d_refs_on_rename(formula: &str, old_name: &str, new_name: &str) -> String {
    let ast = match parse_formula(formula) {
        Ok(ast) => ast,
        Err(_) => return formula.to_string(),
    };

    let new_ast = repair_3d_rename_recursive(&ast, old_name, new_name);
    format!("={}", expression_to_formula(&new_ast))
}

/// Recursively walks a parser AST and updates Sheet3DRef bookend names.
fn repair_3d_rename_recursive(ast: &ParserExpr, old_name: &str, new_name: &str) -> ParserExpr {
    let old_upper = old_name.to_uppercase();
    match ast {
        ParserExpr::Sheet3DRef { start_sheet, end_sheet, reference } => {
            let new_start = if start_sheet.to_uppercase() == old_upper {
                new_name.to_string()
            } else {
                start_sheet.clone()
            };
            let new_end = if end_sheet.to_uppercase() == old_upper {
                new_name.to_string()
            } else {
                end_sheet.clone()
            };
            ParserExpr::Sheet3DRef {
                start_sheet: new_start,
                end_sheet: new_end,
                reference: Box::new(repair_3d_rename_recursive(reference, old_name, new_name)),
            }
        }
        // Also update regular cross-sheet refs (CellRef, Range, ColumnRef, RowRef with sheet=Some)
        ParserExpr::CellRef { sheet: Some(s), col, row, col_absolute, row_absolute } => {
            let new_sheet = if s.to_uppercase() == old_upper {
                new_name.to_string()
            } else {
                s.clone()
            };
            ParserExpr::CellRef {
                sheet: Some(new_sheet),
                col: col.clone(),
                row: *row,
                col_absolute: *col_absolute,
                row_absolute: *row_absolute,
            }
        }
        ParserExpr::Range { sheet: Some(s), start, end } => {
            let new_sheet = if s.to_uppercase() == old_upper {
                new_name.to_string()
            } else {
                s.clone()
            };
            ParserExpr::Range {
                sheet: Some(new_sheet),
                start: Box::new(repair_3d_rename_recursive(start, old_name, new_name)),
                end: Box::new(repair_3d_rename_recursive(end, old_name, new_name)),
            }
        }
        ParserExpr::ColumnRef { sheet: Some(s), start_col, end_col, start_absolute, end_absolute } => {
            let new_sheet = if s.to_uppercase() == old_upper {
                new_name.to_string()
            } else {
                s.clone()
            };
            ParserExpr::ColumnRef {
                sheet: Some(new_sheet),
                start_col: start_col.clone(),
                end_col: end_col.clone(),
                start_absolute: *start_absolute,
                end_absolute: *end_absolute,
            }
        }
        ParserExpr::RowRef { sheet: Some(s), start_row, end_row, start_absolute, end_absolute } => {
            let new_sheet = if s.to_uppercase() == old_upper {
                new_name.to_string()
            } else {
                s.clone()
            };
            ParserExpr::RowRef {
                sheet: Some(new_sheet),
                start_row: *start_row,
                end_row: *end_row,
                start_absolute: *start_absolute,
                end_absolute: *end_absolute,
            }
        }
        ParserExpr::BinaryOp { left, op, right } => ParserExpr::BinaryOp {
            left: Box::new(repair_3d_rename_recursive(left, old_name, new_name)),
            op: *op,
            right: Box::new(repair_3d_rename_recursive(right, old_name, new_name)),
        },
        ParserExpr::UnaryOp { op, operand } => ParserExpr::UnaryOp {
            op: *op,
            operand: Box::new(repair_3d_rename_recursive(operand, old_name, new_name)),
        },
        ParserExpr::FunctionCall { func, args } => ParserExpr::FunctionCall {
            func: func.clone(),
            args: args.iter().map(|a| repair_3d_rename_recursive(a, old_name, new_name)).collect(),
        },
        ParserExpr::Range { sheet: None, start, end } => ParserExpr::Range {
            sheet: None,
            start: Box::new(repair_3d_rename_recursive(start, old_name, new_name)),
            end: Box::new(repair_3d_rename_recursive(end, old_name, new_name)),
        },
        // Leaf nodes — no changes
        _ => ast.clone(),
    }
}

/// Scans all formula cells across all grids and applies a repair function.
/// Used by sheet delete/rename to update 3D reference bookends.
pub fn repair_all_formulas(
    grids: &mut [Grid],
    repair_fn: &dyn Fn(&str) -> Option<String>,
) {
    for grid in grids.iter_mut() {
        let formula_cells: Vec<((u32, u32), String)> = grid.cells.iter()
            .filter_map(|((r, c), cell)| {
                cell.formula.as_ref().map(|f| ((*r, *c), f.clone()))
            })
            .collect();

        for ((row, col), formula) in formula_cells {
            match repair_fn(&formula) {
                Some(new_formula) => {
                    if new_formula != formula {
                        if let Some(cell) = grid.cells.get_mut(&(row, col)) {
                            cell.formula = Some(new_formula);
                            // Clear cached AST since formula changed
                            cell.cached_ast = None;
                        }
                    }
                }
                None => {
                    // Formula should become #REF!
                    if let Some(cell) = grid.cells.get_mut(&(row, col)) {
                        cell.value = CellValue::Error(CellError::Ref);
                        cell.cached_ast = None;
                    }
                }
            }
        }
    }
}

pub fn evaluate_formula(grid: &Grid, formula: &str) -> CellValue {
    match parse_formula(formula) {
        Ok(parser_ast) => {
            let engine_ast = convert_expr(&parser_ast);
            let evaluator = Evaluator::new(grid);
            let result = evaluator.evaluate(&engine_ast);
            result.to_cell_value()
        }
        Err(e) => {
            log_error!("EVAL", "parse_err formula={} err={}", formula, e);
            CellValue::Error(CellError::Value)
        }
    }
}

/// Evaluates a formula using a pre-parsed AST. More efficient than evaluate_formula
/// when the AST is already available (e.g., from cell's cached_ast).
pub fn evaluate_formula_with_ast(grid: &Grid, ast: &EngineExpr) -> CellValue {
    let evaluator = Evaluator::new(grid);
    let result = evaluator.evaluate(ast);
    result.to_cell_value()
}

pub fn evaluate_formula_multi_sheet(
    grids: &[Grid],
    sheet_names: &[String],
    current_sheet_index: usize,
    formula: &str,
) -> CellValue {
    if current_sheet_index >= grids.len() || current_sheet_index >= sheet_names.len() {
        return CellValue::Error(CellError::Ref);
    }

    match parse_formula(formula) {
        Ok(parser_ast) => {
            let engine_ast = convert_expr(&parser_ast);

            let current_grid = &grids[current_sheet_index];
            let current_sheet_name = &sheet_names[current_sheet_index];

            let context = create_multi_sheet_context(grids, sheet_names, current_sheet_name);

            let evaluator = Evaluator::with_multi_sheet(current_grid, context);
            evaluator.evaluate(&engine_ast).to_cell_value()
        }
        Err(e) => {
            log_error!("EVAL", "parse_err formula={} err={}", formula, e);
            CellValue::Error(CellError::Value)
        }
    }
}

/// Evaluates a formula using a pre-parsed AST with multi-sheet support.
/// This is the most efficient evaluation path when the AST is already cached.
pub fn evaluate_formula_multi_sheet_with_ast(
    grids: &[Grid],
    sheet_names: &[String],
    current_sheet_index: usize,
    ast: &EngineExpr,
) -> CellValue {
    if current_sheet_index >= grids.len() || current_sheet_index >= sheet_names.len() {
        return CellValue::Error(CellError::Ref);
    }

    let current_grid = &grids[current_sheet_index];
    let current_sheet_name = &sheet_names[current_sheet_index];

    let context = create_multi_sheet_context(grids, sheet_names, current_sheet_name);

    let evaluator = Evaluator::with_multi_sheet(current_grid, context);
    evaluator.evaluate(ast).to_cell_value()
}

/// Evaluates a formula AST and also returns any UI side-effects.
/// Used when the formula may contain UI functions like SET.ROW.HEIGHT.
pub fn evaluate_formula_with_effects(
    grids: &[Grid],
    sheet_names: &[String],
    current_sheet_index: usize,
    ast: &EngineExpr,
    eval_ctx: engine::EvalContext,
    style_registry: Option<&engine::StyleRegistry>,
) -> (CellValue, Vec<engine::UiEffect>) {
    if current_sheet_index >= grids.len() || current_sheet_index >= sheet_names.len() {
        return (CellValue::Error(CellError::Ref), Vec::new());
    }

    let current_grid = &grids[current_sheet_index];
    let current_sheet_name = &sheet_names[current_sheet_index];
    let context = create_multi_sheet_context(grids, sheet_names, current_sheet_name);
    let mut evaluator = Evaluator::with_context(current_grid, context, eval_ctx);
    if let Some(sr) = style_registry {
        evaluator.set_styles(sr);
    }
    let result = evaluator.evaluate(ast).to_cell_value();
    let effects = evaluator.take_ui_effects();
    (result, effects)
}

/// Result of processing UI effects.
pub struct UiEffectProcessResult {
    /// Dimension changes: (index, size, is_column)
    pub dimension_changes: Vec<(u32, f64, bool)>,
    /// Fill color changes: (target_row, target_col, r, g, b, a)
    pub fill_color_changes: Vec<(u32, u32, u8, u8, u8, u8)>,
    /// Whether any conflict was detected
    pub has_conflict: bool,
}

/// Process UI effects from a formula evaluation.
/// Registers effects in the registry, detects conflicts, and applies changes.
pub fn process_ui_effects(
    effects: &[engine::UiEffect],
    source_cell: (usize, u32, u32), // (sheet_index, row, col)
    registry: &mut UiEffectRegistry,
    row_heights: &mut HashMap<u32, f64>,
    column_widths: &mut HashMap<u32, f64>,
) -> UiEffectProcessResult {
    let mut result = UiEffectProcessResult {
        dimension_changes: Vec::new(),
        fill_color_changes: Vec::new(),
        has_conflict: false,
    };

    for effect in effects {
        match effect {
            engine::UiEffect::SetRowHeight { rows, height } => {
                for &target_row in rows {
                    let key = (source_cell.0, target_row);
                    let sources = registry.row_height_sources
                        .entry(key)
                        .or_insert_with(HashSet::new);
                    sources.insert(source_cell);

                    if sources.len() > 1 {
                        result.has_conflict = true;
                    } else {
                        row_heights.insert(target_row, *height);
                        result.dimension_changes.push((target_row, *height, false));
                    }
                }
            }
            engine::UiEffect::SetColumnWidth { cols, width } => {
                for &target_col in cols {
                    let key = (source_cell.0, target_col);
                    let sources = registry.column_width_sources
                        .entry(key)
                        .or_insert_with(HashSet::new);
                    sources.insert(source_cell);

                    if sources.len() > 1 {
                        result.has_conflict = true;
                    } else {
                        column_widths.insert(target_col, *width);
                        result.dimension_changes.push((target_col, *width, true));
                    }
                }
            }
            engine::UiEffect::SetCellFillColor { target_row, target_col, r, g, b, a } => {
                let key = (source_cell.0, *target_row, *target_col);
                let sources = registry.fill_color_sources
                    .entry(key)
                    .or_insert_with(HashSet::new);
                sources.insert(source_cell);

                if sources.len() > 1 {
                    result.has_conflict = true;
                } else {
                    result.fill_color_changes.push((*target_row, *target_col, *r, *g, *b, *a));
                }
            }
        }
    }

    result
}

/// Result of clearing UI effects for a cell.
pub struct ClearEffectsResult {
    /// Affected row height targets: (sheet_index, target_row)
    pub affected_rows: Vec<(usize, u32)>,
    /// Affected column width targets: (sheet_index, target_col)
    pub affected_cols: Vec<(usize, u32)>,
    /// Affected fill color targets: (sheet_index, target_row, target_col)
    pub affected_fill_colors: Vec<(usize, u32, u32)>,
}

/// Clear all UI effects for a specific source cell from the registry.
/// Called when a cell with a UI formula is deleted or cleared.
pub fn clear_ui_effects_for_cell(
    source_cell: (usize, u32, u32),
    registry: &mut UiEffectRegistry,
) -> ClearEffectsResult {
    let mut result = ClearEffectsResult {
        affected_rows: Vec::new(),
        affected_cols: Vec::new(),
        affected_fill_colors: Vec::new(),
    };

    registry.row_height_sources.retain(|key, sources| {
        if sources.remove(&source_cell) {
            result.affected_rows.push(*key);
        }
        !sources.is_empty()
    });

    registry.column_width_sources.retain(|key, sources| {
        if sources.remove(&source_cell) {
            result.affected_cols.push(*key);
        }
        !sources.is_empty()
    });

    registry.fill_color_sources.retain(|key, sources| {
        if sources.remove(&source_cell) {
            result.affected_fill_colors.push(*key);
        }
        !sources.is_empty()
    });

    result
}

/// Evaluates a formula AST using a pre-built evaluator. This is the fastest path
/// for batch operations where the same evaluator can be reused across many formulas.
pub fn evaluate_ast_with_evaluator(evaluator: &Evaluator, ast: &EngineExpr) -> CellValue {
    evaluator.evaluate(ast).to_cell_value()
}

/// Creates an Evaluator with multi-sheet context. Reuse this for batch evaluations
/// to avoid recreating the context (HashMap + string cloning) for each formula.
pub fn create_evaluator_for_sheet<'a>(
    grids: &'a [Grid],
    sheet_names: &[String],
    current_sheet_index: usize,
) -> Option<Evaluator<'a>> {
    if current_sheet_index >= grids.len() || current_sheet_index >= sheet_names.len() {
        return None;
    }

    let current_grid = &grids[current_sheet_index];
    let current_sheet_name = &sheet_names[current_sheet_index];
    let context = create_multi_sheet_context(grids, sheet_names, current_sheet_name);
    Some(Evaluator::with_multi_sheet(current_grid, context))
}

/// Parses a formula and converts it to the engine AST.
/// Returns the engine AST suitable for caching in a Cell.
pub fn parse_formula_to_engine_ast(formula: &str) -> Result<EngineExpr, String> {
    match parse_formula(formula) {
        Ok(parser_ast) => Ok(convert_expr(&parser_ast)),
        Err(e) => Err(format!("{}", e)),
    }
}

/// Creates a reusable MultiSheetContext for batch formula evaluation.
/// This is more efficient than creating a new context for each formula.
pub fn create_multi_sheet_context<'a>(
    grids: &'a [Grid],
    sheet_names: &[String],
    current_sheet_name: &str,
) -> MultiSheetContext<'a> {
    let mut context = MultiSheetContext::new(current_sheet_name.to_string());
    for (i, grid) in grids.iter().enumerate() {
        if i < sheet_names.len() {
            context.add_grid(sheet_names[i].clone(), grid);
        }
    }
    // Populate sheet_order for 3D reference evaluation
    context.sheet_order = sheet_names.to_vec();
    context
}

/// Evaluates a formula using a pre-built context. More efficient for batch operations.
pub fn evaluate_formula_with_context(
    grids: &[Grid],
    sheet_names: &[String],
    current_sheet_index: usize,
    formula: &str,
) -> CellValue {
    if current_sheet_index >= grids.len() || current_sheet_index >= sheet_names.len() {
        return CellValue::Error(CellError::Ref);
    }

    match parse_formula(formula) {
        Ok(parser_ast) => {
            let engine_ast = convert_expr(&parser_ast);
            let current_grid = &grids[current_sheet_index];
            let current_sheet_name = &sheet_names[current_sheet_index];

            // Build context efficiently
            let context = create_multi_sheet_context(grids, sheet_names, current_sheet_name);
            let evaluator = Evaluator::with_multi_sheet(current_grid, context);
            evaluator.evaluate(&engine_ast).to_cell_value()
        }
        Err(_) => CellValue::Error(CellError::Value),
    }
}

/// Batch evaluates multiple formulas efficiently by reusing the context.
/// Returns a vector of (row, col, result) tuples.
pub fn batch_evaluate_formulas(
    grids: &[Grid],
    sheet_names: &[String],
    current_sheet_index: usize,
    formulas: &[((u32, u32), &str)], // ((row, col), formula)
) -> Vec<((u32, u32), CellValue)> {
    if current_sheet_index >= grids.len() || current_sheet_index >= sheet_names.len() {
        return formulas
            .iter()
            .map(|((r, c), _)| ((*r, *c), CellValue::Error(CellError::Ref)))
            .collect();
    }

    let current_grid = &grids[current_sheet_index];
    let current_sheet_name = &sheet_names[current_sheet_index];

    // Build context once for all formulas
    let context = create_multi_sheet_context(grids, sheet_names, current_sheet_name);
    let evaluator = Evaluator::with_multi_sheet(current_grid, context);

    formulas
        .iter()
        .map(|((row, col), formula)| {
            let result = match parse_formula(formula) {
                Ok(parser_ast) => {
                    let engine_ast = convert_expr(&parser_ast);
                    evaluator.evaluate(&engine_ast).to_cell_value()
                }
                Err(_) => CellValue::Error(CellError::Value),
            };
            ((*row, *col), result)
        })
        .collect()
}

pub fn parse_cell_input(input: &str) -> Cell {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Cell::new();
    }
    if trimmed.starts_with('=') {
        return Cell::new_formula(trimmed.to_string());
    }
    let upper = trimmed.to_uppercase();
    if upper == "TRUE" {
        return Cell::new_boolean(true);
    }
    if upper == "FALSE" {
        return Cell::new_boolean(false);
    }
    if let Some(num) = parse_number(trimmed) {
        return Cell::new_number(num);
    }
    Cell::new_text(trimmed.to_string())
}

fn parse_number(s: &str) -> Option<f64> {
    let trimmed = s.trim();
    if trimmed.ends_with('%') {
        let num_part = trimmed.trim_end_matches('%').trim();
        if let Ok(n) = num_part.parse::<f64>() {
            return Some(n / 100.0);
        }
        return None;
    }
    let cleaned = trimmed.replace(',', "");
    if let Ok(n) = cleaned.parse::<f64>() {
        if n.is_finite() {
            return Some(n);
        }
    }
    None
}

// ============================================================================
// DEPENDENCY TRACKING
// ============================================================================

pub fn update_dependencies(
    cell_pos: (u32, u32),
    new_refs: HashSet<(u32, u32)>,
    dependencies: &mut HashMap<(u32, u32), HashSet<(u32, u32)>>,
    dependents: &mut HashMap<(u32, u32), HashSet<(u32, u32)>>,
) {
    let old_refs = dependencies.remove(&cell_pos).unwrap_or_default();
    
    for old_ref in &old_refs {
        if let Some(deps) = dependents.get_mut(old_ref) {
            deps.remove(&cell_pos);
            if deps.is_empty() {
                dependents.remove(old_ref);
            }
        }
    }
    for new_ref in &new_refs {
        dependents
            .entry(*new_ref)
            .or_insert_with(HashSet::new)
            .insert(cell_pos);
    }
    if !new_refs.is_empty() {
        dependencies.insert(cell_pos, new_refs);
    }
}

pub fn update_column_dependencies(
    cell_pos: (u32, u32),
    new_cols: HashSet<u32>,
    column_dependencies: &mut HashMap<(u32, u32), HashSet<u32>>,
    column_dependents: &mut HashMap<u32, HashSet<(u32, u32)>>,
) {
    let old_cols = column_dependencies.remove(&cell_pos).unwrap_or_default();
    
    for old_col in &old_cols {
        if let Some(deps) = column_dependents.get_mut(old_col) {
            deps.remove(&cell_pos);
            if deps.is_empty() {
                column_dependents.remove(old_col);
            }
        }
    }
    
    for new_col in &new_cols {
        column_dependents
            .entry(*new_col)
            .or_insert_with(HashSet::new)
            .insert(cell_pos);
    }
    
    if !new_cols.is_empty() {
        column_dependencies.insert(cell_pos, new_cols);
    }
}

pub fn update_row_dependencies(
    cell_pos: (u32, u32),
    new_rows: HashSet<u32>,
    row_dependencies: &mut HashMap<(u32, u32), HashSet<u32>>,
    row_dependents: &mut HashMap<u32, HashSet<(u32, u32)>>,
) {
    let old_rows = row_dependencies.remove(&cell_pos).unwrap_or_default();
    
    for old_row in &old_rows {
        if let Some(deps) = row_dependents.get_mut(old_row) {
            deps.remove(&cell_pos);
            if deps.is_empty() {
                row_dependents.remove(old_row);
            }
        }
    }
    
    for new_row in &new_rows {
        row_dependents
            .entry(*new_row)
            .or_insert_with(HashSet::new)
            .insert(cell_pos);
    }
    
    if !new_rows.is_empty() {
        row_dependencies.insert(cell_pos, new_rows);
    }
}

pub fn update_cross_sheet_dependencies(
    formula_cell: (usize, u32, u32),
    new_refs: HashSet<(String, u32, u32)>,
    cross_sheet_dependencies: &mut HashMap<(usize, u32, u32), HashSet<(String, u32, u32)>>,
    cross_sheet_dependents: &mut HashMap<(String, u32, u32), HashSet<(usize, u32, u32)>>,
) {
    let old_refs = cross_sheet_dependencies.remove(&formula_cell).unwrap_or_default();
    
    for old_ref in &old_refs {
        if let Some(deps) = cross_sheet_dependents.get_mut(old_ref) {
            deps.remove(&formula_cell);
            if deps.is_empty() {
                cross_sheet_dependents.remove(old_ref);
            }
        }
    }
    
    for new_ref in &new_refs {
        cross_sheet_dependents
            .entry(new_ref.clone())
            .or_insert_with(HashSet::new)
            .insert(formula_cell);
    }

    if !new_refs.is_empty() {
        cross_sheet_dependencies.insert(formula_cell, new_refs);
    }
}

pub fn get_recalculation_order(
    changed_cell: (u32, u32),
    dependents: &HashMap<(u32, u32), HashSet<(u32, u32)>>,
) -> Vec<(u32, u32)> {
    let mut to_recalc = Vec::new();
    let mut visited = HashSet::new();
    let mut stack = vec![changed_cell];
    while let Some(cell) = stack.pop() {
        if visited.contains(&cell) {
            continue;
        }
        if cell != changed_cell {
            to_recalc.push(cell);
        }
        visited.insert(cell);
        if let Some(deps) = dependents.get(&cell) {
            for dep in deps {
                if !visited.contains(dep) {
                    stack.push(*dep);
                }
            }
        }
    }
    
    to_recalc
}

pub fn get_column_row_dependents(
    changed_cell: (u32, u32),
    column_dependents: &HashMap<u32, HashSet<(u32, u32)>>,
    row_dependents: &HashMap<u32, HashSet<(u32, u32)>>,
) -> HashSet<(u32, u32)> {
    let (row, col) = changed_cell;
    let mut result = HashSet::new();
    
    if let Some(col_deps) = column_dependents.get(&col) {
        for dep in col_deps {
            if *dep != changed_cell {
                result.insert(*dep);
            }
        }
    }
    
    if let Some(row_deps) = row_dependents.get(&row) {
        for dep in row_deps {
            if *dep != changed_cell {
                result.insert(*dep);
            }
        }
    }
    
    result
}

// ============================================================================
// TAURI APP ENTRY
// ============================================================================

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    match init_log_file() {
        Ok(path) => {
            eprintln!("[LOG_INIT] SUCCESS - Log file: {:?}", path);
            log_info!("SYS", "Tauri backend starting, log={}", path.display());
        }
        Err(e) => {
            eprintln!("[LOG_INIT] FAILED: {}", e);
            eprintln!("[LOG_INIT] Continuing with console-only logging");
        }
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(create_app_state())
        .manage(FileState::default())
        .manage(pivot::PivotState::new())
        .manage(tablix::TablixState::new())
        .manage(evaluate_formula::EvalFormulaState::new())
        .invoke_handler(tauri::generate_handler![
            // Grid commands
            commands::get_viewport_cells,
            commands::get_cell,
            commands::update_cell,
            commands::update_cells_batch,
            commands::clear_cell,
            commands::clear_range,
            commands::clear_range_with_options,
            commands::sort_range,
            commands::remove_duplicates,
            commands::get_grid_bounds,
            commands::get_cell_count,
            commands::get_cells_in_rows,
            commands::get_cells_in_cols,
            commands::has_content_in_range,
            // Navigation commands
            commands::find_ctrl_arrow_target,
            commands::detect_data_region,
            // Dimension commands
            commands::set_column_width,
            commands::get_column_width,
            commands::get_all_column_widths,
            commands::set_row_height,
            commands::get_row_height,
            commands::get_all_row_heights,
            // Style commands
            commands::get_style,
            commands::get_all_styles,
            commands::set_cell_style,
            commands::apply_formatting,
            commands::preview_number_format,
            commands::get_style_count,
            commands::insert_rows,
            commands::insert_columns,
            commands::delete_rows,
            commands::delete_columns,
            commands::shift_formula_for_fill,
            commands::shift_formulas_batch,
            // Undo/Redo commands
            undo_commands::begin_undo_transaction,
            undo_commands::commit_undo_transaction,
            undo_commands::cancel_undo_transaction,
            undo_commands::get_undo_state,
            undo_commands::undo,
            undo_commands::redo,
            undo_commands::clear_undo_history,
            // Logging commands
            logging::log_frontend,
            logging::log_frontend_atomic,
            logging::get_next_seq,
            logging::sort_log_file,
            // Calculation mode commands
            calculation::set_calculation_mode,
            calculation::get_calculation_mode,
            calculation::calculate_now,
            calculation::calculate_sheet,
            // Formula library commands
            formula::get_functions_by_category,
            formula::get_all_functions,
            formula::get_function_template,
            // File commands
            persistence::save_file,
            persistence::open_file,
            persistence::new_file,
            persistence::get_current_file_path,
            persistence::is_file_modified,
            persistence::mark_file_modified,
            // Sheet commands
            sheets::get_sheets,
            sheets::get_active_sheet,
            sheets::set_active_sheet,
            sheets::add_sheet,
            sheets::delete_sheet,
            sheets::rename_sheet,
            sheets::set_freeze_panes,
            sheets::get_freeze_panes,
            // Find & Replace commands
            commands::find_all,
            commands::count_matches,
            commands::replace_all,
            commands::replace_single,
            // Merge cell commands
            merge_commands::merge_cells,
            merge_commands::unmerge_cells,
            merge_commands::get_merged_regions,
            merge_commands::get_merge_info,
            // Pivot table commands - Core operations
            pivot::create_pivot_table,
            pivot::update_pivot_fields,
            pivot::toggle_pivot_group,
            pivot::get_pivot_view,
            pivot::delete_pivot_table,
            pivot::get_pivot_source_data,
            pivot::refresh_pivot_cache,
            pivot::get_pivot_at_cell,
            pivot::get_pivot_regions_for_sheet,
            pivot::get_pivot_field_unique_values,
            // Pivot table commands - Excel-compatible API
            pivot::get_pivot_table_info,
            pivot::update_pivot_properties,
            pivot::get_pivot_layout_ranges,
            pivot::update_pivot_layout,
            pivot::get_pivot_hierarchies,
            pivot::add_pivot_hierarchy,
            pivot::remove_pivot_hierarchy,
            pivot::move_pivot_field,
            pivot::set_pivot_aggregation,
            pivot::set_pivot_number_format,
            pivot::apply_pivot_filter,
            pivot::clear_pivot_filter,
            pivot::sort_pivot_field,
            pivot::get_pivot_field_info,
            pivot::set_pivot_item_visibility,
            pivot::get_all_pivot_tables,
            pivot::refresh_all_pivot_tables,
            pivot::set_pivot_item_expanded,
            pivot::expand_collapse_level,
            pivot::expand_collapse_all,
            pivot::group_pivot_field,
            pivot::create_manual_group,
            pivot::ungroup_pivot_field,
            pivot::drill_through_to_sheet,
            // Named range commands
            named_ranges::create_named_range,
            named_ranges::update_named_range,
            named_ranges::delete_named_range,
            named_ranges::get_named_range,
            named_ranges::get_all_named_ranges,
            named_ranges::get_named_range_for_selection,
            named_ranges::rename_named_range,
            // Data validation commands
            data_validation::set_data_validation,
            data_validation::clear_data_validation,
            data_validation::get_data_validation,
            data_validation::get_all_data_validations,
            data_validation::validate_cell,
            data_validation::get_validation_prompt,
            data_validation::get_invalid_cells,
            data_validation::get_validation_list_values,
            data_validation::has_in_cell_dropdown,
            data_validation::validate_pending_value,
            // Comment commands
            comments::add_comment,
            comments::update_comment,
            comments::delete_comment,
            comments::get_comment,
            comments::get_comment_by_id,
            comments::get_all_comments,
            comments::get_comments_for_sheet,
            comments::get_comment_indicators,
            comments::get_comment_indicators_in_range,
            comments::resolve_comment,
            comments::add_reply,
            comments::update_reply,
            comments::delete_reply,
            comments::move_comment,
            comments::get_comment_count,
            comments::has_comment,
            comments::clear_all_comments,
            comments::clear_comments_in_range,
            // AutoFilter commands
            autofilter::apply_auto_filter,
            autofilter::clear_column_criteria,
            autofilter::clear_auto_filter_criteria,
            autofilter::reapply_auto_filter,
            autofilter::remove_auto_filter,
            autofilter::get_auto_filter,
            autofilter::get_auto_filter_range,
            autofilter::get_hidden_rows,
            autofilter::is_row_filtered,
            autofilter::get_filter_unique_values,
            autofilter::set_column_filter_values,
            autofilter::set_column_custom_filter,
            autofilter::set_column_top_bottom_filter,
            autofilter::set_column_dynamic_filter,
            // Hyperlink commands
            hyperlinks::add_hyperlink,
            hyperlinks::update_hyperlink,
            hyperlinks::remove_hyperlink,
            hyperlinks::get_hyperlink,
            hyperlinks::get_all_hyperlinks,
            hyperlinks::get_hyperlink_indicators,
            hyperlinks::get_hyperlinks_in_range,
            hyperlinks::has_hyperlink,
            hyperlinks::clear_hyperlinks_in_range,
            hyperlinks::move_hyperlink,
            // Protection commands
            protection::protect_sheet,
            protection::unprotect_sheet,
            protection::update_protection_options,
            protection::add_allow_edit_range,
            protection::remove_allow_edit_range,
            protection::get_allow_edit_ranges,
            protection::get_protection_status,
            protection::is_sheet_protected,
            protection::can_edit_cell,
            protection::can_perform_action,
            protection::set_cell_protection,
            protection::get_cell_protection,
            protection::verify_edit_range_password,
            // Workbook protection commands
            protection::protect_workbook,
            protection::unprotect_workbook,
            protection::is_workbook_protected,
            protection::get_workbook_protection_status,
            // Grouping (Outline) commands
            grouping::group_rows,
            grouping::ungroup_rows,
            grouping::group_columns,
            grouping::ungroup_columns,
            grouping::collapse_row_group,
            grouping::expand_row_group,
            grouping::collapse_column_group,
            grouping::expand_column_group,
            grouping::show_outline_level,
            grouping::get_outline_info,
            grouping::get_outline_settings,
            grouping::set_outline_settings,
            grouping::clear_outline,
            grouping::is_row_hidden_by_group,
            grouping::is_col_hidden_by_group,
            grouping::get_hidden_rows_by_group,
            grouping::get_hidden_cols_by_group,
            // Conditional Formatting commands
            conditional_formatting::add_conditional_format,
            conditional_formatting::update_conditional_format,
            conditional_formatting::delete_conditional_format,
            conditional_formatting::reorder_conditional_formats,
            conditional_formatting::get_conditional_format,
            conditional_formatting::get_all_conditional_formats,
            conditional_formatting::evaluate_conditional_formats,
            conditional_formatting::clear_conditional_formats_in_range,
            // Table commands
            tables::create_table,
            tables::delete_table,
            tables::rename_table,
            tables::update_table_style,
            tables::add_table_column,
            tables::remove_table_column,
            tables::rename_table_column,
            tables::set_totals_row_function,
            tables::toggle_totals_row,
            tables::resize_table,
            tables::convert_to_range,
            tables::check_table_auto_expand,
            tables::enforce_table_header,
            tables::set_calculated_column,
            tables::get_table,
            tables::get_table_by_name,
            tables::get_table_at_cell,
            tables::get_all_tables,
            tables::resolve_structured_reference,
            // Tablix commands
            tablix::create_tablix,
            tablix::update_tablix_fields,
            tablix::get_tablix_view,
            tablix::delete_tablix,
            tablix::toggle_tablix_group,
            tablix::get_tablix_at_cell,
            tablix::get_tablix_regions_for_sheet,
            tablix::convert_pivot_to_tablix,
            tablix::convert_tablix_to_pivot,
            tablix::refresh_tablix_cache,
            tablix::get_tablix_field_unique_values,
            // Goal Seek command
            goal_seek::goal_seek,
            // Data Consolidation command
            consolidate::consolidate_data,
            // Tracing commands (Trace Precedents / Trace Dependents)
            tracing::trace_precedents,
            tracing::trace_dependents,
            // Evaluate Formula commands (step-by-step formula debugger)
            evaluate_formula::eval_formula_init,
            evaluate_formula::eval_formula_evaluate,
            evaluate_formula::eval_formula_step_in,
            evaluate_formula::eval_formula_step_out,
            evaluate_formula::eval_formula_restart,
            evaluate_formula::eval_formula_close,
            // Status bar aggregation command
            status_bar::get_selection_aggregations,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}