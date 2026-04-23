//! FILENAME: app/src-tauri/src/lib.rs
// PURPOSE: Main library entry point (Tauri Bridge).
// CONTEXT: Uses a generic ProtectedRegion system for extension-owned cell regions.

use tauri::Manager;
use engine::{
    format_number_with_color, format_text_with_color, format_color_to_css,
    Cell, CellError, CellStyle, CellValue, EvalResult, Evaluator, Grid, NumberFormat,
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
use persistence::{FileState, UserFilesState};
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
pub mod bi;
pub mod scripting;
pub mod named_ranges;
pub mod data_validation;
pub mod comments;
pub mod notes;
pub mod autofilter;
pub mod hyperlinks;
pub mod protection;
pub mod grouping;
pub mod linked_sheets;
pub mod conditional_formatting;
pub mod tables;
pub mod goal_seek;
pub mod scenario_manager;
pub mod data_tables;
pub mod solver;
pub mod theme_commands;
pub mod tracing;
pub mod evaluate_formula;
pub mod formula_eval_plan;
pub mod consolidate;
pub mod status_bar;
pub mod computed_properties;
pub mod controls;
pub mod slicer;
pub mod timeline_slicer;
pub mod mcp;
pub mod locale_commands;
pub mod error_checking;
pub mod named_styles_cmd;
pub mod chart_commands;
pub mod r1c1;

pub use api_types::{CellData, StyleData, DimensionData, FormattingParams, MergedRegion};
pub use logging::{init_log_file, get_log_path, next_seq, write_log, write_log_raw};
pub use engine::{Transaction, CellChange};
pub use sheets::FreezeConfig;
pub use sheets::SplitConfig;
pub use named_ranges::{NamedRange, NamedRangeResult, ApplyNamesResult};
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
    /// Column widths for the currently active sheet (swapped on sheet switch)
    pub column_widths: Mutex<HashMap<u32, f64>>,
    /// Row heights for the currently active sheet (swapped on sheet switch)
    pub row_heights: Mutex<HashMap<u32, f64>>,
    /// Per-sheet column widths storage (indexed by sheet index)
    pub all_column_widths: Mutex<Vec<HashMap<u32, f64>>>,
    /// Per-sheet row heights storage (indexed by sheet index)
    pub all_row_heights: Mutex<Vec<HashMap<u32, f64>>>,
    /// Default row height for rows without custom heights (pixels)
    pub default_row_height: Mutex<f64>,
    /// Default column width for columns without custom widths (pixels)
    pub default_column_width: Mutex<f64>,
    pub dependents: Mutex<HashMap<(u32, u32), HashSet<(u32, u32)>>>,
    pub dependencies: Mutex<HashMap<(u32, u32), HashSet<(u32, u32)>>>,
    /// Calculation mode: "automatic" or "manual"
    pub calculation_mode: Mutex<String>,
    /// Iterative calculation: allow circular references to converge
    pub iteration_enabled: Mutex<bool>,
    /// Maximum number of iterations for circular reference resolution
    pub max_iterations: Mutex<u32>,
    /// Maximum change threshold for convergence (stop when delta < this value)
    pub max_change: Mutex<f64>,
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
    /// Split window configurations per sheet
    pub split_configs: Mutex<Vec<SplitConfig>>,
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
    /// Notes per sheet: sheet_index -> (row, col) -> Note
    pub notes: Mutex<notes::NoteStorage>,
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
    /// Computed properties per sheet: sheet_index -> SheetComputedProperties
    pub computed_properties: Mutex<computed_properties::ComputedPropertiesStorage>,
    /// Next computed property ID (auto-incremented)
    pub next_computed_prop_id: Mutex<u64>,
    /// Computed property dependencies: prop_id -> set of cells the formula references
    pub computed_prop_dependencies: Mutex<computed_properties::ComputedPropDependencies>,
    /// Reverse map: cell -> set of prop_ids that depend on it (for re-evaluation triggers)
    pub computed_prop_dependents: Mutex<computed_properties::ComputedPropDependents>,
    /// Control metadata: (sheet_index, row, col) -> ControlMetadata
    pub controls: Mutex<controls::ControlStorage>,
    /// Page setup settings per sheet (indexed by sheet index)
    pub page_setups: Mutex<Vec<crate::api_types::PageSetup>>,
    /// Tab colors per sheet (CSS hex string, empty = no color)
    pub tab_colors: Mutex<Vec<String>>,
    /// Visibility state per sheet: "visible", "hidden", or "veryHidden"
    pub sheet_visibility: Mutex<Vec<String>>,
    /// Spill tracking: maps (sheet_index, origin_row, origin_col) to list of (row, col) spill cells
    /// Used by dynamic array functions (FILTER, SORT, UNIQUE, SEQUENCE)
    pub spill_ranges: Mutex<HashMap<(usize, u32, u32), Vec<(u32, u32)>>>,
    /// Reverse spill map: (sheet_index, row, col) -> (origin_row, origin_col)
    /// Used to detect #SPILL! errors when a spill cell is occupied
    pub spill_hosts: Mutex<HashMap<(usize, u32, u32), (u32, u32)>>,
    /// Hidden rows set by the Advanced Filter extension (per sheet)
    pub advanced_filter_hidden_rows: Mutex<HashMap<usize, Vec<u32>>>,
    /// Document theme (colors + fonts). Defaults to Office theme.
    pub theme: Mutex<engine::ThemeDefinition>,
    /// Scenario Manager: per-sheet list of scenarios
    pub scenarios: Mutex<HashMap<usize, Vec<api_types::Scenario>>>,
    /// Linked sheets: tracks which sheets are linked to published sources
    pub linked_sheets: Mutex<Vec<calcula_format::publish::linked::LinkedSheetInfo>>,
    /// Locale/regional settings (decimal separator, list separator, date format, etc.)
    pub locale: Mutex<engine::LocaleSettings>,
    /// Auto-recover enabled (background save to prevent data loss)
    pub auto_recover_enabled: Mutex<bool>,
    /// Auto-recover interval in milliseconds (default: 300000 = 5 minutes)
    pub auto_recover_interval_ms: Mutex<u64>,
    /// Named cell styles: name -> NamedCellStyle
    pub named_styles: Mutex<HashMap<String, api_types::NamedCellStyle>>,
    /// Workbook document properties (author, title, subject, etc.)
    pub workbook_properties: Mutex<api_types::WorkbookProperties>,
    /// Use displayed precision for calculations (default: false)
    pub precision_as_displayed: Mutex<bool>,
    /// Recalculate before saving (default: true)
    pub calculate_before_save: Mutex<bool>,
    /// Chart entries: persisted chart definitions (opaque JSON)
    pub charts: Mutex<Vec<api_types::ChartEntry>>,
    /// Scroll area restriction per sheet (A1-style range like "A1:Z100", or None for unrestricted)
    pub scroll_areas: Mutex<Vec<Option<String>>>,
    /// Reference style: "A1" (default) or "R1C1"
    pub reference_style: Mutex<String>,
}

impl AppState {
    /// Get the active grid (convenience method)
    pub fn get_active_grid(&self) -> std::sync::MutexGuard<'_, Grid> {
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
    let app_state = AppState {
        grids: Mutex::new(vec![initial_grid.clone()]),
        sheet_names: Mutex::new(vec!["Sheet1".to_string()]),
        active_sheet: Mutex::new(0),
        grid: Mutex::new(initial_grid),
        style_registry: Mutex::new(StyleRegistry::new()),
        column_widths: Mutex::new(HashMap::new()),
        row_heights: Mutex::new(HashMap::new()),
        all_column_widths: Mutex::new(vec![HashMap::new()]),
        all_row_heights: Mutex::new(vec![HashMap::new()]),
        default_row_height: Mutex::new(24.0),
        default_column_width: Mutex::new(100.0),
        dependents: Mutex::new(HashMap::new()),
        dependencies: Mutex::new(HashMap::new()),
        calculation_mode: Mutex::new("automatic".to_string()),
        iteration_enabled: Mutex::new(false),
        max_iterations: Mutex::new(100),
        max_change: Mutex::new(0.001),
        column_dependents: Mutex::new(HashMap::new()),
        row_dependents: Mutex::new(HashMap::new()),
        column_dependencies: Mutex::new(HashMap::new()),
        row_dependencies: Mutex::new(HashMap::new()),
        cross_sheet_dependents: Mutex::new(HashMap::new()),
        cross_sheet_dependencies: Mutex::new(HashMap::new()),
        undo_stack: Mutex::new(UndoStack::new()),
        freeze_configs: Mutex::new(vec![FreezeConfig::default()]),
        split_configs: Mutex::new(vec![SplitConfig::default()]),
        merged_regions: Mutex::new(HashSet::new()),
        protected_regions: Mutex::new(Vec::new()),
        named_ranges: Mutex::new(HashMap::new()),
        data_validations: Mutex::new(HashMap::new()),
        comments: Mutex::new(HashMap::new()),
        notes: Mutex::new(HashMap::new()),
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
        computed_properties: Mutex::new(HashMap::new()),
        next_computed_prop_id: Mutex::new(1),
        computed_prop_dependencies: Mutex::new(HashMap::new()),
        computed_prop_dependents: Mutex::new(HashMap::new()),
        controls: Mutex::new(HashMap::new()),
        page_setups: Mutex::new(vec![crate::api_types::PageSetup::default()]),
        tab_colors: Mutex::new(vec![String::new()]),
        sheet_visibility: Mutex::new(vec!["visible".to_string()]),
        spill_ranges: Mutex::new(HashMap::new()),
        spill_hosts: Mutex::new(HashMap::new()),
        advanced_filter_hidden_rows: Mutex::new(HashMap::new()),
        theme: Mutex::new(engine::ThemeDefinition::default()),
        scenarios: Mutex::new(HashMap::new()),
        linked_sheets: Mutex::new(Vec::new()),
        locale: Mutex::new({
            let system_locale = sys_locale::get_locale()
                .unwrap_or_else(|| "en-US".to_string());
            log_info!("SYS", "Detected system locale: {}", system_locale);
            engine::LocaleSettings::from_locale_id(&system_locale)
        }),
        auto_recover_enabled: Mutex::new(true),
        auto_recover_interval_ms: Mutex::new(300_000), // 5 minutes
        named_styles: Mutex::new(HashMap::new()),
        workbook_properties: Mutex::new({
            let author = std::env::var("USERNAME")
                .or_else(|_| std::env::var("USER"))
                .unwrap_or_default();
            let now = chrono::Utc::now().to_rfc3339();
            api_types::WorkbookProperties {
                author,
                created: now.clone(),
                last_modified: now,
                ..Default::default()
            }
        }),
        precision_as_displayed: Mutex::new(false),
        calculate_before_save: Mutex::new(true),
        charts: Mutex::new(Vec::new()),
        scroll_areas: Mutex::new(vec![None]),
        reference_style: Mutex::new("A1".to_string()),
    };

    // Populate built-in named styles
    named_styles_cmd::init_builtin_named_styles(&app_state);

    app_state
}

// ============================================================================
// CELL FORMATTING
// ============================================================================

/// Result of formatting a cell value: display text + optional color from format.
pub struct CellDisplayResult {
    pub text: String,
    pub color: Option<String>,
    /// When set, the cell uses accounting layout with split rendering.
    pub accounting: Option<AccountingLayoutData>,
}

/// Accounting layout data for split rendering (symbol left, value right).
#[derive(Debug, Clone)]
pub struct AccountingLayoutData {
    pub symbol: String,
    pub symbol_before: bool,
    pub value: String,
}

pub fn format_cell_value(value: &CellValue, style: &CellStyle, locale: &engine::LocaleSettings) -> String {
    format_cell_value_with_color(value, style, locale).text
}

/// Format a cell value and return both display text and optional color override.
/// The color is only populated for Custom formats that include [Color] tokens.
pub fn format_cell_value_with_color(value: &CellValue, style: &CellStyle, locale: &engine::LocaleSettings) -> CellDisplayResult {
    match value {
        CellValue::Empty => CellDisplayResult { text: String::new(), color: None, accounting: None },
        CellValue::Number(n) => {
            let result = format_number_with_color(*n, &style.number_format, locale);
            if !matches!(style.number_format, NumberFormat::General) {
                log_debug!("FMT", "num={} fmt={:?} --> {}", n, style.number_format, result.text);
            }
            let accounting = result.accounting.map(|p| AccountingLayoutData {
                symbol: p.symbol,
                symbol_before: p.symbol_before,
                value: p.value,
            });
            CellDisplayResult {
                text: result.text,
                color: result.color.map(|c| format_color_to_css(&c).to_string()),
                accounting,
            }
        },
        CellValue::Text(s) => {
            let result = format_text_with_color(s, &style.number_format);
            CellDisplayResult {
                text: result.text,
                color: result.color.map(|c| format_color_to_css(&c).to_string()),
                accounting: None,
            }
        },
        CellValue::Boolean(b) => CellDisplayResult {
            text: if *b { "TRUE" } else { "FALSE" }.to_string(),
            color: None,
            accounting: None,
        },
        CellValue::Error(e) => CellDisplayResult {
            text: format!("#{:?}", e).to_uppercase(),
            color: None,
            accounting: None,
        },
        CellValue::List(items) => CellDisplayResult {
            text: format!("[List({})]", items.len()),
            color: None,
            accounting: None,
        },
        CellValue::Dict(entries) => CellDisplayResult {
            text: format!("[Dict({})]", entries.len()),
            color: None,
            accounting: None,
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
        CellValue::List(items) => format!("[List({})]", items.len()),
        CellValue::Dict(entries) => format!("[Dict({})]", entries.len()),
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
        // Aggregate functions
        ParserBuiltinFn::Sum => EngineBuiltinFn::Sum,
        ParserBuiltinFn::Average => EngineBuiltinFn::Average,
        ParserBuiltinFn::Min => EngineBuiltinFn::Min,
        ParserBuiltinFn::Max => EngineBuiltinFn::Max,
        ParserBuiltinFn::Count => EngineBuiltinFn::Count,
        ParserBuiltinFn::CountA => EngineBuiltinFn::CountA,

        // Conditional aggregates
        ParserBuiltinFn::SumIf => EngineBuiltinFn::SumIf,
        ParserBuiltinFn::SumIfs => EngineBuiltinFn::SumIfs,
        ParserBuiltinFn::CountIf => EngineBuiltinFn::CountIf,
        ParserBuiltinFn::CountIfs => EngineBuiltinFn::CountIfs,
        ParserBuiltinFn::AverageIf => EngineBuiltinFn::AverageIf,
        ParserBuiltinFn::AverageIfs => EngineBuiltinFn::AverageIfs,
        ParserBuiltinFn::CountBlank => EngineBuiltinFn::CountBlank,
        ParserBuiltinFn::MinIfs => EngineBuiltinFn::MinIfs,
        ParserBuiltinFn::MaxIfs => EngineBuiltinFn::MaxIfs,

        // Logical functions
        ParserBuiltinFn::If => EngineBuiltinFn::If,
        ParserBuiltinFn::And => EngineBuiltinFn::And,
        ParserBuiltinFn::Or => EngineBuiltinFn::Or,
        ParserBuiltinFn::Not => EngineBuiltinFn::Not,
        ParserBuiltinFn::True => EngineBuiltinFn::True,
        ParserBuiltinFn::False => EngineBuiltinFn::False,
        ParserBuiltinFn::IfError => EngineBuiltinFn::IfError,
        ParserBuiltinFn::IfNa => EngineBuiltinFn::IfNa,
        ParserBuiltinFn::Ifs => EngineBuiltinFn::Ifs,
        ParserBuiltinFn::Switch => EngineBuiltinFn::Switch,
        ParserBuiltinFn::Xor => EngineBuiltinFn::Xor,

        // Math functions
        ParserBuiltinFn::Abs => EngineBuiltinFn::Abs,
        ParserBuiltinFn::Round => EngineBuiltinFn::Round,
        ParserBuiltinFn::Floor => EngineBuiltinFn::Floor,
        ParserBuiltinFn::Ceiling => EngineBuiltinFn::Ceiling,
        ParserBuiltinFn::Sqrt => EngineBuiltinFn::Sqrt,
        ParserBuiltinFn::Power => EngineBuiltinFn::Power,
        ParserBuiltinFn::Mod => EngineBuiltinFn::Mod,
        ParserBuiltinFn::Int => EngineBuiltinFn::Int,
        ParserBuiltinFn::Sign => EngineBuiltinFn::Sign,
        ParserBuiltinFn::SumProduct => EngineBuiltinFn::SumProduct,
        ParserBuiltinFn::SumX2MY2 => EngineBuiltinFn::SumX2MY2,
        ParserBuiltinFn::SumX2PY2 => EngineBuiltinFn::SumX2PY2,
        ParserBuiltinFn::SumXMY2 => EngineBuiltinFn::SumXMY2,
        ParserBuiltinFn::Product => EngineBuiltinFn::Product,
        ParserBuiltinFn::Rand => EngineBuiltinFn::Rand,
        ParserBuiltinFn::RandBetween => EngineBuiltinFn::RandBetween,
        ParserBuiltinFn::Pi => EngineBuiltinFn::Pi,
        ParserBuiltinFn::Log => EngineBuiltinFn::Log,
        ParserBuiltinFn::Log10 => EngineBuiltinFn::Log10,
        ParserBuiltinFn::Ln => EngineBuiltinFn::Ln,
        ParserBuiltinFn::Exp => EngineBuiltinFn::Exp,
        ParserBuiltinFn::Sin => EngineBuiltinFn::Sin,
        ParserBuiltinFn::Cos => EngineBuiltinFn::Cos,
        ParserBuiltinFn::Tan => EngineBuiltinFn::Tan,
        ParserBuiltinFn::Asin => EngineBuiltinFn::Asin,
        ParserBuiltinFn::Acos => EngineBuiltinFn::Acos,
        ParserBuiltinFn::Atan => EngineBuiltinFn::Atan,
        ParserBuiltinFn::Atan2 => EngineBuiltinFn::Atan2,
        ParserBuiltinFn::RoundUp => EngineBuiltinFn::RoundUp,
        ParserBuiltinFn::RoundDown => EngineBuiltinFn::RoundDown,
        ParserBuiltinFn::Trunc => EngineBuiltinFn::Trunc,
        ParserBuiltinFn::Even => EngineBuiltinFn::Even,
        ParserBuiltinFn::Odd => EngineBuiltinFn::Odd,
        ParserBuiltinFn::Gcd => EngineBuiltinFn::Gcd,
        ParserBuiltinFn::Lcm => EngineBuiltinFn::Lcm,
        ParserBuiltinFn::Combin => EngineBuiltinFn::Combin,
        ParserBuiltinFn::Fact => EngineBuiltinFn::Fact,
        ParserBuiltinFn::Degrees => EngineBuiltinFn::Degrees,
        ParserBuiltinFn::Radians => EngineBuiltinFn::Radians,

        // Text functions
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
        ParserBuiltinFn::Find => EngineBuiltinFn::Find,
        ParserBuiltinFn::Search => EngineBuiltinFn::Search,
        ParserBuiltinFn::Substitute => EngineBuiltinFn::Substitute,
        ParserBuiltinFn::Replace => EngineBuiltinFn::Replace,
        ParserBuiltinFn::ValueFn => EngineBuiltinFn::ValueFn,
        ParserBuiltinFn::Exact => EngineBuiltinFn::Exact,
        ParserBuiltinFn::Proper => EngineBuiltinFn::Proper,
        ParserBuiltinFn::Char => EngineBuiltinFn::Char,
        ParserBuiltinFn::Code => EngineBuiltinFn::Code,
        ParserBuiltinFn::Clean => EngineBuiltinFn::Clean,
        ParserBuiltinFn::NumberValue => EngineBuiltinFn::NumberValue,
        ParserBuiltinFn::TFn => EngineBuiltinFn::TFn,

        // Date & Time functions
        ParserBuiltinFn::Today => EngineBuiltinFn::Today,
        ParserBuiltinFn::Now => EngineBuiltinFn::Now,
        ParserBuiltinFn::Date => EngineBuiltinFn::Date,
        ParserBuiltinFn::Year => EngineBuiltinFn::Year,
        ParserBuiltinFn::Month => EngineBuiltinFn::Month,
        ParserBuiltinFn::Day => EngineBuiltinFn::Day,
        ParserBuiltinFn::Hour => EngineBuiltinFn::Hour,
        ParserBuiltinFn::Minute => EngineBuiltinFn::Minute,
        ParserBuiltinFn::Second => EngineBuiltinFn::Second,
        ParserBuiltinFn::DateValue => EngineBuiltinFn::DateValue,
        ParserBuiltinFn::TimeValue => EngineBuiltinFn::TimeValue,
        ParserBuiltinFn::EDate => EngineBuiltinFn::EDate,
        ParserBuiltinFn::EOMonth => EngineBuiltinFn::EOMonth,
        ParserBuiltinFn::NetworkDays => EngineBuiltinFn::NetworkDays,
        ParserBuiltinFn::WorkDay => EngineBuiltinFn::WorkDay,
        ParserBuiltinFn::DateDif => EngineBuiltinFn::DateDif,
        ParserBuiltinFn::Weekday => EngineBuiltinFn::Weekday,
        ParserBuiltinFn::WeekNum => EngineBuiltinFn::WeekNum,

        // Information functions
        ParserBuiltinFn::IsNumber => EngineBuiltinFn::IsNumber,
        ParserBuiltinFn::IsText => EngineBuiltinFn::IsText,
        ParserBuiltinFn::IsBlank => EngineBuiltinFn::IsBlank,
        ParserBuiltinFn::IsError => EngineBuiltinFn::IsError,
        ParserBuiltinFn::IsNa => EngineBuiltinFn::IsNa,
        ParserBuiltinFn::IsErr => EngineBuiltinFn::IsErr,
        ParserBuiltinFn::IsLogical => EngineBuiltinFn::IsLogical,
        ParserBuiltinFn::IsOdd => EngineBuiltinFn::IsOdd,
        ParserBuiltinFn::IsEven => EngineBuiltinFn::IsEven,
        ParserBuiltinFn::TypeFn => EngineBuiltinFn::TypeFn,
        ParserBuiltinFn::NFn => EngineBuiltinFn::NFn,
        ParserBuiltinFn::Na => EngineBuiltinFn::Na,
        ParserBuiltinFn::IsFormula => EngineBuiltinFn::IsFormula,

        // Lookup & Reference functions
        ParserBuiltinFn::XLookup => EngineBuiltinFn::XLookup,
        ParserBuiltinFn::XLookups => EngineBuiltinFn::XLookups,
        ParserBuiltinFn::Index => EngineBuiltinFn::Index,
        ParserBuiltinFn::Match => EngineBuiltinFn::Match,
        ParserBuiltinFn::Choose => EngineBuiltinFn::Choose,
        ParserBuiltinFn::Indirect => EngineBuiltinFn::Indirect,
        ParserBuiltinFn::Offset => EngineBuiltinFn::Offset,
        ParserBuiltinFn::Address => EngineBuiltinFn::Address,
        ParserBuiltinFn::Rows => EngineBuiltinFn::Rows,
        ParserBuiltinFn::Columns => EngineBuiltinFn::Columns,
        ParserBuiltinFn::Transpose => EngineBuiltinFn::Transpose,

        // Statistical functions
        ParserBuiltinFn::Median => EngineBuiltinFn::Median,
        ParserBuiltinFn::Stdev => EngineBuiltinFn::Stdev,
        ParserBuiltinFn::StdevP => EngineBuiltinFn::StdevP,
        ParserBuiltinFn::Var => EngineBuiltinFn::Var,
        ParserBuiltinFn::VarP => EngineBuiltinFn::VarP,
        ParserBuiltinFn::Large => EngineBuiltinFn::Large,
        ParserBuiltinFn::Small => EngineBuiltinFn::Small,
        ParserBuiltinFn::Rank => EngineBuiltinFn::Rank,
        ParserBuiltinFn::Percentile => EngineBuiltinFn::Percentile,
        ParserBuiltinFn::Quartile => EngineBuiltinFn::Quartile,
        ParserBuiltinFn::Mode => EngineBuiltinFn::Mode,
        ParserBuiltinFn::Frequency => EngineBuiltinFn::Frequency,

        // Financial functions
        ParserBuiltinFn::Pmt => EngineBuiltinFn::Pmt,
        ParserBuiltinFn::Pv => EngineBuiltinFn::Pv,
        ParserBuiltinFn::Fv => EngineBuiltinFn::Fv,
        ParserBuiltinFn::Npv => EngineBuiltinFn::Npv,
        ParserBuiltinFn::Irr => EngineBuiltinFn::Irr,
        ParserBuiltinFn::Rate => EngineBuiltinFn::Rate,
        ParserBuiltinFn::Nper => EngineBuiltinFn::Nper,
        ParserBuiltinFn::Sln => EngineBuiltinFn::Sln,
        ParserBuiltinFn::Db => EngineBuiltinFn::Db,
        ParserBuiltinFn::Ddb => EngineBuiltinFn::Ddb,

        // UI GET functions
        ParserBuiltinFn::GetRowHeight => EngineBuiltinFn::GetRowHeight,
        ParserBuiltinFn::GetColumnWidth => EngineBuiltinFn::GetColumnWidth,
        ParserBuiltinFn::GetCellFillColor => EngineBuiltinFn::GetCellFillColor,

        // Reference functions
        ParserBuiltinFn::Row => EngineBuiltinFn::Row,
        ParserBuiltinFn::Column => EngineBuiltinFn::Column,

        // Advanced / Lambda
        ParserBuiltinFn::Let => EngineBuiltinFn::Let,
        ParserBuiltinFn::TextJoin => EngineBuiltinFn::TextJoin,
        ParserBuiltinFn::Lambda => EngineBuiltinFn::Lambda,
        ParserBuiltinFn::Map => EngineBuiltinFn::Map,
        ParserBuiltinFn::Reduce => EngineBuiltinFn::Reduce,
        ParserBuiltinFn::Scan => EngineBuiltinFn::Scan,
        ParserBuiltinFn::MakeArray => EngineBuiltinFn::MakeArray,
        ParserBuiltinFn::ByRow => EngineBuiltinFn::ByRow,
        ParserBuiltinFn::ByCol => EngineBuiltinFn::ByCol,

        ParserBuiltinFn::Filter => EngineBuiltinFn::Filter,
        ParserBuiltinFn::Sort => EngineBuiltinFn::Sort,
        ParserBuiltinFn::SortBy => EngineBuiltinFn::SortBy,
        ParserBuiltinFn::Unique => EngineBuiltinFn::Unique,
        ParserBuiltinFn::Sequence => EngineBuiltinFn::Sequence,
        ParserBuiltinFn::RandArray => EngineBuiltinFn::RandArray,
        ParserBuiltinFn::GroupBy => EngineBuiltinFn::GroupBy,
        ParserBuiltinFn::PivotBy => EngineBuiltinFn::PivotBy,
        ParserBuiltinFn::GetPivotData => EngineBuiltinFn::GetPivotData,

        // Collection functions (3D cells)
        ParserBuiltinFn::Collect => EngineBuiltinFn::Collect,
        ParserBuiltinFn::DictFn => EngineBuiltinFn::DictFn,
        ParserBuiltinFn::Keys => EngineBuiltinFn::Keys,
        ParserBuiltinFn::Values => EngineBuiltinFn::Values,
        ParserBuiltinFn::Contains => EngineBuiltinFn::Contains,
        ParserBuiltinFn::IsList => EngineBuiltinFn::IsList,
        ParserBuiltinFn::IsDict => EngineBuiltinFn::IsDict,
        ParserBuiltinFn::Flatten => EngineBuiltinFn::Flatten,
        ParserBuiltinFn::Take => EngineBuiltinFn::Take,
        ParserBuiltinFn::Drop => EngineBuiltinFn::Drop,
        ParserBuiltinFn::Append => EngineBuiltinFn::Append,
        ParserBuiltinFn::Merge => EngineBuiltinFn::Merge,
        ParserBuiltinFn::HStack => EngineBuiltinFn::HStack,

        // File functions
        ParserBuiltinFn::FileRead => EngineBuiltinFn::FileRead,
        ParserBuiltinFn::FileLines => EngineBuiltinFn::FileLines,
        ParserBuiltinFn::FileExists => EngineBuiltinFn::FileExists,

        // Subtotal function
        ParserBuiltinFn::Subtotal => EngineBuiltinFn::Subtotal,

        // Additional date functions
        ParserBuiltinFn::Days => EngineBuiltinFn::Days,
        ParserBuiltinFn::Time => EngineBuiltinFn::Time,

        // Lookup functions (legacy)
        ParserBuiltinFn::VLookup => EngineBuiltinFn::VLookup,
        ParserBuiltinFn::HLookup => EngineBuiltinFn::HLookup,
        ParserBuiltinFn::Lookup => EngineBuiltinFn::Lookup,

        // Hyperbolic & reciprocal trig
        ParserBuiltinFn::Sinh => EngineBuiltinFn::Sinh,
        ParserBuiltinFn::Cosh => EngineBuiltinFn::Cosh,
        ParserBuiltinFn::Tanh => EngineBuiltinFn::Tanh,
        ParserBuiltinFn::Cot => EngineBuiltinFn::Cot,
        ParserBuiltinFn::Coth => EngineBuiltinFn::Coth,
        ParserBuiltinFn::Csc => EngineBuiltinFn::Csc,
        ParserBuiltinFn::Csch => EngineBuiltinFn::Csch,
        ParserBuiltinFn::Sec => EngineBuiltinFn::Sec,
        ParserBuiltinFn::Sech => EngineBuiltinFn::Sech,
        ParserBuiltinFn::Acot => EngineBuiltinFn::Acot,
        // Rounding variants
        ParserBuiltinFn::CeilingMath => EngineBuiltinFn::CeilingMath,
        ParserBuiltinFn::CeilingPrecise => EngineBuiltinFn::CeilingPrecise,
        ParserBuiltinFn::FloorMath => EngineBuiltinFn::FloorMath,
        ParserBuiltinFn::FloorPrecise => EngineBuiltinFn::FloorPrecise,
        ParserBuiltinFn::IsoCeiling => EngineBuiltinFn::IsoCeiling,
        // Additional math (Group 3)
        ParserBuiltinFn::Multinomial => EngineBuiltinFn::Multinomial,
        ParserBuiltinFn::Combina => EngineBuiltinFn::Combina,
        ParserBuiltinFn::FactDouble => EngineBuiltinFn::FactDouble,
        ParserBuiltinFn::SqrtPi => EngineBuiltinFn::SqrtPi,
        // Aggregate
        ParserBuiltinFn::Aggregate => EngineBuiltinFn::Aggregate,
        // Web
        ParserBuiltinFn::EncodeUrl => EngineBuiltinFn::EncodeUrl,

        // Additional math functions
        ParserBuiltinFn::MRound => EngineBuiltinFn::MRound,
        ParserBuiltinFn::Quotient => EngineBuiltinFn::Quotient,
        ParserBuiltinFn::SumSq => EngineBuiltinFn::SumSq,
        ParserBuiltinFn::Roman => EngineBuiltinFn::Roman,
        ParserBuiltinFn::Arabic => EngineBuiltinFn::Arabic,
        ParserBuiltinFn::Base => EngineBuiltinFn::Base,
        ParserBuiltinFn::Decimal => EngineBuiltinFn::Decimal,

        // Additional text functions
        ParserBuiltinFn::Dollar => EngineBuiltinFn::Dollar,
        ParserBuiltinFn::Euro => EngineBuiltinFn::Euro,
        ParserBuiltinFn::Fixed => EngineBuiltinFn::Fixed,
        ParserBuiltinFn::Unichar => EngineBuiltinFn::Unichar,
        ParserBuiltinFn::Unicode => EngineBuiltinFn::Unicode,

        // Additional information functions
        ParserBuiltinFn::ErrorType => EngineBuiltinFn::ErrorType,
        ParserBuiltinFn::IsNonText => EngineBuiltinFn::IsNonText,
        ParserBuiltinFn::IsRef => EngineBuiltinFn::IsRef,
        ParserBuiltinFn::Sheet => EngineBuiltinFn::Sheet,
        ParserBuiltinFn::Sheets => EngineBuiltinFn::Sheets,

        // New probability distributions
        ParserBuiltinFn::NormInv => EngineBuiltinFn::NormInv,
        ParserBuiltinFn::NormSDist => EngineBuiltinFn::NormSDist,
        ParserBuiltinFn::NormSInv => EngineBuiltinFn::NormSInv,
        ParserBuiltinFn::TDist2T => EngineBuiltinFn::TDist2T,
        ParserBuiltinFn::TDistRT => EngineBuiltinFn::TDistRT,
        ParserBuiltinFn::TInv => EngineBuiltinFn::TInv,
        ParserBuiltinFn::TInv2T => EngineBuiltinFn::TInv2T,
        ParserBuiltinFn::TTest => EngineBuiltinFn::TTest,
        ParserBuiltinFn::ChisqDistRT => EngineBuiltinFn::ChisqDistRT,
        ParserBuiltinFn::ChisqInv => EngineBuiltinFn::ChisqInv,
        ParserBuiltinFn::ChisqInvRT => EngineBuiltinFn::ChisqInvRT,
        ParserBuiltinFn::ChisqTest => EngineBuiltinFn::ChisqTest,
        ParserBuiltinFn::FDistRT => EngineBuiltinFn::FDistRT,
        ParserBuiltinFn::FInv => EngineBuiltinFn::FInv,
        ParserBuiltinFn::FInvRT => EngineBuiltinFn::FInvRT,
        ParserBuiltinFn::FTest => EngineBuiltinFn::FTest,
        ParserBuiltinFn::BinomInv => EngineBuiltinFn::BinomInv,
        ParserBuiltinFn::BinomDistRange => EngineBuiltinFn::BinomDistRange,
        ParserBuiltinFn::BetaDist => EngineBuiltinFn::BetaDist,
        ParserBuiltinFn::BetaInv => EngineBuiltinFn::BetaInv,
        ParserBuiltinFn::GammaDist => EngineBuiltinFn::GammaDist,
        ParserBuiltinFn::GammaInv => EngineBuiltinFn::GammaInv,
        ParserBuiltinFn::GammaFn => EngineBuiltinFn::GammaFn,
        ParserBuiltinFn::GammaLnFn => EngineBuiltinFn::GammaLnFn,
        ParserBuiltinFn::WeibullDist => EngineBuiltinFn::WeibullDist,
        ParserBuiltinFn::ExponDist => EngineBuiltinFn::ExponDist,
        ParserBuiltinFn::LognormDist => EngineBuiltinFn::LognormDist,
        ParserBuiltinFn::LognormInv => EngineBuiltinFn::LognormInv,
        ParserBuiltinFn::HypgeomDist => EngineBuiltinFn::HypgeomDist,
        ParserBuiltinFn::NegbinomDist => EngineBuiltinFn::NegbinomDist,
        // Descriptive/Analytical
        ParserBuiltinFn::Correl => EngineBuiltinFn::Correl,
        ParserBuiltinFn::Pearson => EngineBuiltinFn::Pearson,
        ParserBuiltinFn::Rsq => EngineBuiltinFn::Rsq,
        ParserBuiltinFn::Slope => EngineBuiltinFn::Slope,
        ParserBuiltinFn::Intercept => EngineBuiltinFn::Intercept,
        ParserBuiltinFn::Steyx => EngineBuiltinFn::Steyx,
        ParserBuiltinFn::CovarianceP => EngineBuiltinFn::CovarianceP,
        ParserBuiltinFn::CovarianceS => EngineBuiltinFn::CovarianceS,
        ParserBuiltinFn::Kurt => EngineBuiltinFn::Kurt,
        ParserBuiltinFn::Skew => EngineBuiltinFn::Skew,
        ParserBuiltinFn::SkewP => EngineBuiltinFn::SkewP,
        ParserBuiltinFn::Avedev => EngineBuiltinFn::Avedev,
        ParserBuiltinFn::Devsq => EngineBuiltinFn::Devsq,
        ParserBuiltinFn::Geomean => EngineBuiltinFn::Geomean,
        ParserBuiltinFn::Harmean => EngineBuiltinFn::Harmean,
        ParserBuiltinFn::Trimmean => EngineBuiltinFn::Trimmean,
        ParserBuiltinFn::Standardize => EngineBuiltinFn::Standardize,
        ParserBuiltinFn::PercentileExc => EngineBuiltinFn::PercentileExc,
        ParserBuiltinFn::PercentRankExc => EngineBuiltinFn::PercentRankExc,
        ParserBuiltinFn::QuartileExc => EngineBuiltinFn::QuartileExc,
        ParserBuiltinFn::Prob => EngineBuiltinFn::Prob,
        ParserBuiltinFn::Fisher => EngineBuiltinFn::Fisher,
        ParserBuiltinFn::FisherInv => EngineBuiltinFn::FisherInv,
        ParserBuiltinFn::Permut => EngineBuiltinFn::Permut,
        ParserBuiltinFn::PermutationA => EngineBuiltinFn::PermutationA,
        ParserBuiltinFn::Phi => EngineBuiltinFn::Phi,
        ParserBuiltinFn::Gauss => EngineBuiltinFn::Gauss,
        // Forecasting
        ParserBuiltinFn::ForecastLinear => EngineBuiltinFn::ForecastLinear,
        ParserBuiltinFn::ForecastEts => EngineBuiltinFn::ForecastEts,
        ParserBuiltinFn::ForecastEtsConfint => EngineBuiltinFn::ForecastEtsConfint,
        ParserBuiltinFn::ForecastEtsSeason => EngineBuiltinFn::ForecastEtsSeason,
        ParserBuiltinFn::ForecastEtsStat => EngineBuiltinFn::ForecastEtsStat,
        // Statistical version variants
        ParserBuiltinFn::AverageA => EngineBuiltinFn::AverageA,
        ParserBuiltinFn::MaxA => EngineBuiltinFn::MaxA,
        ParserBuiltinFn::MinA => EngineBuiltinFn::MinA,
        ParserBuiltinFn::StdevA => EngineBuiltinFn::StdevA,
        ParserBuiltinFn::StdevPA => EngineBuiltinFn::StdevPA,
        ParserBuiltinFn::VarA => EngineBuiltinFn::VarA,
        ParserBuiltinFn::VarPA => EngineBuiltinFn::VarPA,
        // Bond & Security financial
        ParserBuiltinFn::Accrint => EngineBuiltinFn::Accrint,
        ParserBuiltinFn::Accrintm => EngineBuiltinFn::Accrintm,
        ParserBuiltinFn::PriceFn => EngineBuiltinFn::PriceFn,
        ParserBuiltinFn::PriceDisc => EngineBuiltinFn::PriceDisc,
        ParserBuiltinFn::PriceMat => EngineBuiltinFn::PriceMat,
        ParserBuiltinFn::YieldFn => EngineBuiltinFn::YieldFn,
        ParserBuiltinFn::YieldDisc => EngineBuiltinFn::YieldDisc,
        ParserBuiltinFn::YieldMat => EngineBuiltinFn::YieldMat,
        ParserBuiltinFn::DurationFn => EngineBuiltinFn::DurationFn,
        ParserBuiltinFn::Mduration => EngineBuiltinFn::Mduration,
        ParserBuiltinFn::Disc => EngineBuiltinFn::Disc,
        ParserBuiltinFn::Intrate => EngineBuiltinFn::Intrate,
        ParserBuiltinFn::Received => EngineBuiltinFn::Received,
        ParserBuiltinFn::Coupdaybs => EngineBuiltinFn::Coupdaybs,
        ParserBuiltinFn::Coupdays => EngineBuiltinFn::Coupdays,
        ParserBuiltinFn::Coupdaysnc => EngineBuiltinFn::Coupdaysnc,
        ParserBuiltinFn::Coupncd => EngineBuiltinFn::Coupncd,
        ParserBuiltinFn::Coupnum => EngineBuiltinFn::Coupnum,
        ParserBuiltinFn::Couppcd => EngineBuiltinFn::Couppcd,
        // Treasury
        ParserBuiltinFn::TbillEq => EngineBuiltinFn::TbillEq,
        ParserBuiltinFn::TbillPrice => EngineBuiltinFn::TbillPrice,
        ParserBuiltinFn::TbillYield => EngineBuiltinFn::TbillYield,
        // Other financial
        ParserBuiltinFn::DollarDe => EngineBuiltinFn::DollarDe,
        ParserBuiltinFn::DollarFr => EngineBuiltinFn::DollarFr,
        ParserBuiltinFn::Pduration => EngineBuiltinFn::Pduration,
        ParserBuiltinFn::Rri => EngineBuiltinFn::Rri,
        ParserBuiltinFn::Ispmt => EngineBuiltinFn::Ispmt,
        ParserBuiltinFn::Amordegrc => EngineBuiltinFn::Amordegrc,
        ParserBuiltinFn::Amorlinc => EngineBuiltinFn::Amorlinc,
        ParserBuiltinFn::OddfPrice => EngineBuiltinFn::OddfPrice,
        ParserBuiltinFn::OddfYield => EngineBuiltinFn::OddfYield,
        ParserBuiltinFn::OddlPrice => EngineBuiltinFn::OddlPrice,
        ParserBuiltinFn::OddlYield => EngineBuiltinFn::OddlYield,
        // Engineering - Base conversion
        ParserBuiltinFn::Bin2Dec => EngineBuiltinFn::Bin2Dec,
        ParserBuiltinFn::Bin2Hex => EngineBuiltinFn::Bin2Hex,
        ParserBuiltinFn::Bin2Oct => EngineBuiltinFn::Bin2Oct,
        ParserBuiltinFn::Dec2Bin => EngineBuiltinFn::Dec2Bin,
        ParserBuiltinFn::Dec2Hex => EngineBuiltinFn::Dec2Hex,
        ParserBuiltinFn::Dec2Oct => EngineBuiltinFn::Dec2Oct,
        ParserBuiltinFn::Hex2Bin => EngineBuiltinFn::Hex2Bin,
        ParserBuiltinFn::Hex2Dec => EngineBuiltinFn::Hex2Dec,
        ParserBuiltinFn::Hex2Oct => EngineBuiltinFn::Hex2Oct,
        ParserBuiltinFn::Oct2Bin => EngineBuiltinFn::Oct2Bin,
        ParserBuiltinFn::Oct2Dec => EngineBuiltinFn::Oct2Dec,
        ParserBuiltinFn::Oct2Hex => EngineBuiltinFn::Oct2Hex,
        // Engineering - Bit operations
        ParserBuiltinFn::BitAnd => EngineBuiltinFn::BitAnd,
        ParserBuiltinFn::BitOr => EngineBuiltinFn::BitOr,
        ParserBuiltinFn::BitXor => EngineBuiltinFn::BitXor,
        ParserBuiltinFn::BitLShift => EngineBuiltinFn::BitLShift,
        ParserBuiltinFn::BitRShift => EngineBuiltinFn::BitRShift,
        // Engineering - Complex numbers
        ParserBuiltinFn::ComplexFn => EngineBuiltinFn::ComplexFn,
        ParserBuiltinFn::ImAbs => EngineBuiltinFn::ImAbs,
        ParserBuiltinFn::Imaginary => EngineBuiltinFn::Imaginary,
        ParserBuiltinFn::ImReal => EngineBuiltinFn::ImReal,
        ParserBuiltinFn::ImArgument => EngineBuiltinFn::ImArgument,
        ParserBuiltinFn::ImConjugate => EngineBuiltinFn::ImConjugate,
        ParserBuiltinFn::ImCos => EngineBuiltinFn::ImCos,
        ParserBuiltinFn::ImCosh => EngineBuiltinFn::ImCosh,
        ParserBuiltinFn::ImCot => EngineBuiltinFn::ImCot,
        ParserBuiltinFn::ImCsc => EngineBuiltinFn::ImCsc,
        ParserBuiltinFn::ImCsch => EngineBuiltinFn::ImCsch,
        ParserBuiltinFn::ImDiv => EngineBuiltinFn::ImDiv,
        ParserBuiltinFn::ImExp => EngineBuiltinFn::ImExp,
        ParserBuiltinFn::ImLn => EngineBuiltinFn::ImLn,
        ParserBuiltinFn::ImLog10 => EngineBuiltinFn::ImLog10,
        ParserBuiltinFn::ImLog2 => EngineBuiltinFn::ImLog2,
        ParserBuiltinFn::ImPower => EngineBuiltinFn::ImPower,
        ParserBuiltinFn::ImProduct => EngineBuiltinFn::ImProduct,
        ParserBuiltinFn::ImSec => EngineBuiltinFn::ImSec,
        ParserBuiltinFn::ImSech => EngineBuiltinFn::ImSech,
        ParserBuiltinFn::ImSin => EngineBuiltinFn::ImSin,
        ParserBuiltinFn::ImSinh => EngineBuiltinFn::ImSinh,
        ParserBuiltinFn::ImSqrt => EngineBuiltinFn::ImSqrt,
        ParserBuiltinFn::ImSub => EngineBuiltinFn::ImSub,
        ParserBuiltinFn::ImSum => EngineBuiltinFn::ImSum,
        ParserBuiltinFn::ImTan => EngineBuiltinFn::ImTan,
        // Engineering - Bessel
        ParserBuiltinFn::BesselI => EngineBuiltinFn::BesselI,
        ParserBuiltinFn::BesselJ => EngineBuiltinFn::BesselJ,
        ParserBuiltinFn::BesselK => EngineBuiltinFn::BesselK,
        ParserBuiltinFn::BesselY => EngineBuiltinFn::BesselY,
        // Engineering - Other
        ParserBuiltinFn::ConvertFn => EngineBuiltinFn::ConvertFn,
        ParserBuiltinFn::Delta => EngineBuiltinFn::Delta,
        ParserBuiltinFn::Erf => EngineBuiltinFn::Erf,
        ParserBuiltinFn::ErfPrecise => EngineBuiltinFn::ErfPrecise,
        ParserBuiltinFn::Erfc => EngineBuiltinFn::Erfc,
        ParserBuiltinFn::ErfcPrecise => EngineBuiltinFn::ErfcPrecise,
        ParserBuiltinFn::Gestep => EngineBuiltinFn::Gestep,
        ParserBuiltinFn::SeriesSum => EngineBuiltinFn::SeriesSum,
        // Matrix
        ParserBuiltinFn::Mmult => EngineBuiltinFn::Mmult,
        ParserBuiltinFn::Mdeterm => EngineBuiltinFn::Mdeterm,
        ParserBuiltinFn::Minverse => EngineBuiltinFn::Minverse,
        ParserBuiltinFn::Munit => EngineBuiltinFn::Munit,

        // Database functions
        ParserBuiltinFn::DAverage => EngineBuiltinFn::DAverage,
        ParserBuiltinFn::DCount => EngineBuiltinFn::DCount,
        ParserBuiltinFn::DCountA => EngineBuiltinFn::DCountA,
        ParserBuiltinFn::DGet => EngineBuiltinFn::DGet,
        ParserBuiltinFn::DMax => EngineBuiltinFn::DMax,
        ParserBuiltinFn::DMin => EngineBuiltinFn::DMin,
        ParserBuiltinFn::DProduct => EngineBuiltinFn::DProduct,
        ParserBuiltinFn::DStdev => EngineBuiltinFn::DStdev,
        ParserBuiltinFn::DStdevP => EngineBuiltinFn::DStdevP,
        ParserBuiltinFn::DSum => EngineBuiltinFn::DSum,
        ParserBuiltinFn::DVar => EngineBuiltinFn::DVar,
        ParserBuiltinFn::DVarP => EngineBuiltinFn::DVarP,

        ParserBuiltinFn::Custom(name) => EngineBuiltinFn::Custom(name.clone()),
        other => EngineBuiltinFn::Custom(format!("{:?}", other)),
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
        // NamedRef nodes may survive resolution when used as LAMBDA/LET parameter
        // names or references to those parameters in the body. The evaluator will
        // check the current scope for these names; unresolved ones produce #NAME?.
        ParserExpr::NamedRef { name } => EngineExpr::NamedRef {
            name: name.clone(),
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
        ParserExpr::IndexAccess { target, index } => EngineExpr::IndexAccess {
            target: Box::new(convert_expr(target)),
            index: Box::new(convert_expr(index)),
        },
        ParserExpr::ListLiteral { elements } => EngineExpr::ListLiteral {
            elements: elements.iter().map(|e| convert_expr(e)).collect(),
        },
        ParserExpr::DictLiteral { entries } => EngineExpr::DictLiteral {
            entries: entries.iter().map(|(k, v)| (convert_expr(k), convert_expr(v))).collect(),
        },
        ParserExpr::SpillRef { cell } => EngineExpr::SpillRef {
            cell: Box::new(convert_expr(cell)),
        },
        ParserExpr::ImplicitIntersection { operand } => EngineExpr::ImplicitIntersection {
            operand: Box::new(convert_expr(operand)),
        },
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

pub fn column_index_to_letter(mut idx: u32) -> String {
    let mut result = String::new();
    loop {
        result.insert(0, (b'A' + (idx % 26) as u8) as char);
        if idx < 26 {
            break;
        }
        idx = idx / 26 - 1;
    }
    result
}

/// Checks if an AST contains any SpillRef nodes that need resolution.
pub fn ast_has_spill_refs(ast: &ParserExpr) -> bool {
    match ast {
        ParserExpr::SpillRef { .. } => true,
        ParserExpr::BinaryOp { left, right, .. } => {
            ast_has_spill_refs(left) || ast_has_spill_refs(right)
        }
        ParserExpr::UnaryOp { operand, .. } => ast_has_spill_refs(operand),
        ParserExpr::FunctionCall { args, .. } => args.iter().any(ast_has_spill_refs),
        ParserExpr::Range { start, end, .. } => {
            ast_has_spill_refs(start) || ast_has_spill_refs(end)
        }
        ParserExpr::IndexAccess { target, index } => {
            ast_has_spill_refs(target) || ast_has_spill_refs(index)
        }
        ParserExpr::ImplicitIntersection { operand } => ast_has_spill_refs(operand),
        ParserExpr::Sheet3DRef { reference, .. } => ast_has_spill_refs(reference),
        ParserExpr::ListLiteral { elements } => elements.iter().any(ast_has_spill_refs),
        ParserExpr::DictLiteral { entries } => {
            entries.iter().any(|(k, v)| ast_has_spill_refs(k) || ast_has_spill_refs(v))
        }
        _ => false,
    }
}

/// Resolves SpillRef nodes in the AST by replacing them with Range expressions
/// based on the current spill_ranges state.
pub fn resolve_spill_refs_in_ast(
    ast: &ParserExpr,
    spill_ranges: &HashMap<(usize, u32, u32), Vec<(u32, u32)>>,
    current_sheet_index: usize,
) -> ParserExpr {
    match ast {
        ParserExpr::SpillRef { cell } => {
            // Extract the cell reference coordinates
            if let ParserExpr::CellRef { sheet, col, row, col_absolute, row_absolute } = cell.as_ref() {
                let col_idx = col_letter_to_index(col);
                let row_idx = row - 1; // Convert to 0-based

                // Look up the spill range for this cell
                let key = (current_sheet_index, row_idx, col_idx);
                if let Some(spill_cells) = spill_ranges.get(&key) {
                    // Compute the bounding box (origin + all spill cells)
                    let mut min_row = row_idx;
                    let mut max_row = row_idx;
                    let mut min_col = col_idx;
                    let mut max_col = col_idx;
                    for &(sr, sc) in spill_cells {
                        min_row = min_row.min(sr);
                        max_row = max_row.max(sr);
                        min_col = min_col.min(sc);
                        max_col = max_col.max(sc);
                    }

                    // Build a Range expression
                    ParserExpr::Range {
                        sheet: sheet.clone(),
                        start: Box::new(ParserExpr::CellRef {
                            sheet: None,
                            col: column_index_to_letter(min_col),
                            row: min_row + 1,
                            col_absolute: *col_absolute,
                            row_absolute: *row_absolute,
                        }),
                        end: Box::new(ParserExpr::CellRef {
                            sheet: None,
                            col: column_index_to_letter(max_col),
                            row: max_row + 1,
                            col_absolute: *col_absolute,
                            row_absolute: *row_absolute,
                        }),
                    }
                } else {
                    // No spill range at this cell - just return the single cell ref
                    cell.as_ref().clone()
                }
            } else {
                // SpillRef on non-CellRef is invalid
                ast.clone()
            }
        }
        ParserExpr::BinaryOp { left, op, right } => ParserExpr::BinaryOp {
            left: Box::new(resolve_spill_refs_in_ast(left, spill_ranges, current_sheet_index)),
            op: op.clone(),
            right: Box::new(resolve_spill_refs_in_ast(right, spill_ranges, current_sheet_index)),
        },
        ParserExpr::UnaryOp { op, operand } => ParserExpr::UnaryOp {
            op: op.clone(),
            operand: Box::new(resolve_spill_refs_in_ast(operand, spill_ranges, current_sheet_index)),
        },
        ParserExpr::FunctionCall { func, args } => ParserExpr::FunctionCall {
            func: func.clone(),
            args: args.iter().map(|a| resolve_spill_refs_in_ast(a, spill_ranges, current_sheet_index)).collect(),
        },
        ParserExpr::Range { sheet, start, end } => ParserExpr::Range {
            sheet: sheet.clone(),
            start: Box::new(resolve_spill_refs_in_ast(start, spill_ranges, current_sheet_index)),
            end: Box::new(resolve_spill_refs_in_ast(end, spill_ranges, current_sheet_index)),
        },
        ParserExpr::IndexAccess { target, index } => ParserExpr::IndexAccess {
            target: Box::new(resolve_spill_refs_in_ast(target, spill_ranges, current_sheet_index)),
            index: Box::new(resolve_spill_refs_in_ast(index, spill_ranges, current_sheet_index)),
        },
        ParserExpr::ImplicitIntersection { operand } => ParserExpr::ImplicitIntersection {
            operand: Box::new(resolve_spill_refs_in_ast(operand, spill_ranges, current_sheet_index)),
        },
        ParserExpr::Sheet3DRef { start_sheet, end_sheet, reference } => ParserExpr::Sheet3DRef {
            start_sheet: start_sheet.clone(),
            end_sheet: end_sheet.clone(),
            reference: Box::new(resolve_spill_refs_in_ast(reference, spill_ranges, current_sheet_index)),
        },
        ParserExpr::ListLiteral { elements } => ParserExpr::ListLiteral {
            elements: elements.iter().map(|e| resolve_spill_refs_in_ast(e, spill_ranges, current_sheet_index)).collect(),
        },
        ParserExpr::DictLiteral { entries } => ParserExpr::DictLiteral {
            entries: entries.iter().map(|(k, v)| (
                resolve_spill_refs_in_ast(k, spill_ranges, current_sheet_index),
                resolve_spill_refs_in_ast(v, spill_ranges, current_sheet_index),
            )).collect(),
        },
        // All other nodes (Literal, CellRef, ColumnRef, RowRef, NamedRef, TableRef) pass through
        _ => ast.clone(),
    }
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
        // IndexAccess: recurse into both target and index
        ParserExpr::IndexAccess { target, index } => {
            extract_references_recursive(target, grid, refs);
            extract_references_recursive(index, grid, refs);
        }
        // ListLiteral: recurse into all elements
        ParserExpr::ListLiteral { elements } => {
            for elem in elements {
                extract_references_recursive(elem, grid, refs);
            }
        }
        // DictLiteral: recurse into all keys and values
        ParserExpr::DictLiteral { entries } => {
            for (key, value) in entries {
                extract_references_recursive(key, grid, refs);
                extract_references_recursive(value, grid, refs);
            }
        }
        ParserExpr::SpillRef { cell } => {
            extract_references_recursive(cell, grid, refs);
        }
        ParserExpr::ImplicitIntersection { operand } => {
            extract_references_recursive(operand, grid, refs);
        }
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
        ParserExpr::FunctionCall { func, args } => {
            // For LAMBDA and LET, parameter name positions must NOT be resolved
            // as named ranges — they are local bindings that shadow global names.
            match func {
                ParserBuiltinFn::Lambda if args.len() >= 2 => {
                    // LAMBDA(param1, param2, ..., body)
                    // Collect parameter names to shadow them in the body
                    let mut param_names: Vec<String> = Vec::new();
                    for p_arg in &args[..args.len() - 1] {
                        if let ParserExpr::NamedRef { name } = p_arg {
                            param_names.push(name.to_uppercase());
                        }
                    }
                    let mut resolved_args: Vec<ParserExpr> = Vec::with_capacity(args.len());
                    // Parameter name arguments: keep as-is (don't resolve)
                    for p_arg in &args[..args.len() - 1] {
                        resolved_args.push(p_arg.clone());
                    }
                    // Body: resolve names EXCEPT parameter names
                    let body = args.last().unwrap();
                    resolved_args.push(resolve_names_in_ast_with_shadows(
                        body, named_ranges, current_sheet_index, visited, &param_names,
                    ));
                    ParserExpr::FunctionCall {
                        func: func.clone(),
                        args: resolved_args,
                    }
                }
                ParserBuiltinFn::Let if args.len() >= 3 && args.len() % 2 == 1 => {
                    // LET(name1, value1, name2, value2, ..., calculation)
                    // Collect all LET-bound names to shadow in value exprs and body
                    let pair_count = (args.len() - 1) / 2;
                    let mut let_names: Vec<String> = Vec::new();
                    for i in 0..pair_count {
                        if let ParserExpr::NamedRef { name } = &args[i * 2] {
                            let_names.push(name.to_uppercase());
                        }
                    }
                    let mut resolved_args: Vec<ParserExpr> = Vec::with_capacity(args.len());
                    for (idx, arg) in args.iter().enumerate() {
                        if idx % 2 == 0 && idx < args.len() - 1 {
                            // Name positions: keep as-is
                            resolved_args.push(arg.clone());
                        } else {
                            // Value and body positions: resolve with shadows
                            resolved_args.push(resolve_names_in_ast_with_shadows(
                                arg, named_ranges, current_sheet_index, visited, &let_names,
                            ));
                        }
                    }
                    ParserExpr::FunctionCall {
                        func: func.clone(),
                        args: resolved_args,
                    }
                }
                _ => {
                    // Check if a Custom function name is actually a named range
                    // (e.g., =testing(5,9) where "testing" is a named LAMBDA).
                    // If so, resolve it and wrap as __INVOKE__(resolved_lambda, args...).
                    if let ParserBuiltinFn::Custom(ref custom_name) = func {
                        let key = custom_name.to_uppercase();
                        let nr = named_ranges
                            .values()
                            .find(|nr| {
                                let nr_key = nr.name.to_uppercase();
                                nr_key == key && nr.sheet_index == Some(current_sheet_index)
                            })
                            .or_else(|| {
                                named_ranges.values().find(|nr| {
                                    let nr_key = nr.name.to_uppercase();
                                    nr_key == key && nr.sheet_index.is_none()
                                })
                            });
                        if let Some(nr) = nr {
                            if let Ok(sub_ast) = parse_formula(&nr.refers_to) {
                                visited.insert(key.clone());
                                let resolved_callee = resolve_names_in_ast(
                                    &sub_ast, named_ranges, current_sheet_index, visited,
                                );
                                visited.remove(&key);
                                // Build __INVOKE__(resolved_lambda, arg1, arg2, ...)
                                let mut invoke_args = vec![resolved_callee];
                                for a in args {
                                    invoke_args.push(resolve_names_in_ast(
                                        a, named_ranges, current_sheet_index, visited,
                                    ));
                                }
                                return ParserExpr::FunctionCall {
                                    func: ParserBuiltinFn::Custom("__INVOKE__".to_string()),
                                    args: invoke_args,
                                };
                            }
                        }
                    }
                    ParserExpr::FunctionCall {
                        func: func.clone(),
                        args: args
                            .iter()
                            .map(|a| resolve_names_in_ast(a, named_ranges, current_sheet_index, visited))
                            .collect(),
                    }
                },
            }
        }
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
        ParserExpr::IndexAccess { target, index } => ParserExpr::IndexAccess {
            target: Box::new(resolve_names_in_ast(target, named_ranges, current_sheet_index, visited)),
            index: Box::new(resolve_names_in_ast(index, named_ranges, current_sheet_index, visited)),
        },
        ParserExpr::ListLiteral { elements } => ParserExpr::ListLiteral {
            elements: elements.iter().map(|e| resolve_names_in_ast(e, named_ranges, current_sheet_index, visited)).collect(),
        },
        ParserExpr::DictLiteral { entries } => ParserExpr::DictLiteral {
            entries: entries.iter().map(|(k, v)| (
                resolve_names_in_ast(k, named_ranges, current_sheet_index, visited),
                resolve_names_in_ast(v, named_ranges, current_sheet_index, visited),
            )).collect(),
        },
        ParserExpr::SpillRef { cell } => ParserExpr::SpillRef {
            cell: Box::new(resolve_names_in_ast(cell, named_ranges, current_sheet_index, visited)),
        },
        ParserExpr::ImplicitIntersection { operand } => ParserExpr::ImplicitIntersection {
            operand: Box::new(resolve_names_in_ast(operand, named_ranges, current_sheet_index, visited)),
        },
    }
}

/// Like `resolve_names_in_ast`, but skips resolution for NamedRef nodes
/// whose uppercased name is in the `shadows` set. Used for LAMBDA/LET parameters
/// which should NOT be resolved as global named ranges.
fn resolve_names_in_ast_with_shadows(
    ast: &ParserExpr,
    named_ranges: &HashMap<String, named_ranges::NamedRange>,
    current_sheet_index: usize,
    visited: &mut HashSet<String>,
    shadows: &[String],
) -> ParserExpr {
    match ast {
        ParserExpr::NamedRef { name } => {
            let key = name.to_uppercase();
            // If the name is shadowed by a LAMBDA/LET param, keep it as NamedRef
            if shadows.iter().any(|s| s == &key) {
                return ast.clone();
            }
            // Otherwise, delegate to the normal resolver
            resolve_names_in_ast(ast, named_ranges, current_sheet_index, visited)
        }
        ParserExpr::Literal(_) | ParserExpr::CellRef { .. }
        | ParserExpr::ColumnRef { .. } | ParserExpr::RowRef { .. }
        | ParserExpr::TableRef { .. } => ast.clone(),
        ParserExpr::BinaryOp { left, op, right } => ParserExpr::BinaryOp {
            left: Box::new(resolve_names_in_ast_with_shadows(left, named_ranges, current_sheet_index, visited, shadows)),
            op: *op,
            right: Box::new(resolve_names_in_ast_with_shadows(right, named_ranges, current_sheet_index, visited, shadows)),
        },
        ParserExpr::UnaryOp { op, operand } => ParserExpr::UnaryOp {
            op: *op,
            operand: Box::new(resolve_names_in_ast_with_shadows(operand, named_ranges, current_sheet_index, visited, shadows)),
        },
        ParserExpr::FunctionCall { func, args } => {
            // For nested LAMBDA/LET inside a shadowed context, extend shadows
            match func {
                ParserBuiltinFn::Lambda if args.len() >= 2 => {
                    let mut inner_shadows: Vec<String> = shadows.to_vec();
                    for p_arg in &args[..args.len() - 1] {
                        if let ParserExpr::NamedRef { name } = p_arg {
                            inner_shadows.push(name.to_uppercase());
                        }
                    }
                    let mut resolved_args: Vec<ParserExpr> = Vec::with_capacity(args.len());
                    for p_arg in &args[..args.len() - 1] {
                        resolved_args.push(p_arg.clone());
                    }
                    resolved_args.push(resolve_names_in_ast_with_shadows(
                        args.last().unwrap(), named_ranges, current_sheet_index, visited, &inner_shadows,
                    ));
                    ParserExpr::FunctionCall { func: func.clone(), args: resolved_args }
                }
                ParserBuiltinFn::Let if args.len() >= 3 && args.len() % 2 == 1 => {
                    let pair_count = (args.len() - 1) / 2;
                    let mut inner_shadows: Vec<String> = shadows.to_vec();
                    for i in 0..pair_count {
                        if let ParserExpr::NamedRef { name } = &args[i * 2] {
                            inner_shadows.push(name.to_uppercase());
                        }
                    }
                    let mut resolved_args: Vec<ParserExpr> = Vec::with_capacity(args.len());
                    for (idx, arg) in args.iter().enumerate() {
                        if idx % 2 == 0 && idx < args.len() - 1 {
                            resolved_args.push(arg.clone());
                        } else {
                            resolved_args.push(resolve_names_in_ast_with_shadows(
                                arg, named_ranges, current_sheet_index, visited, &inner_shadows,
                            ));
                        }
                    }
                    ParserExpr::FunctionCall { func: func.clone(), args: resolved_args }
                }
                _ => {
                    // Check if a Custom function name is actually a named range
                    // (e.g., =testing(5,9) where "testing" is a named LAMBDA).
                    if let ParserBuiltinFn::Custom(ref custom_name) = func {
                        let key = custom_name.to_uppercase();
                        // Don't resolve if shadowed by a LAMBDA/LET parameter
                        if !shadows.iter().any(|s| s == &key) {
                            let nr = named_ranges
                                .values()
                                .find(|nr| {
                                    let nr_key = nr.name.to_uppercase();
                                    nr_key == key && nr.sheet_index == Some(current_sheet_index)
                                })
                                .or_else(|| {
                                    named_ranges.values().find(|nr| {
                                        let nr_key = nr.name.to_uppercase();
                                        nr_key == key && nr.sheet_index.is_none()
                                    })
                                });
                            if let Some(nr) = nr {
                                if let Ok(sub_ast) = parse_formula(&nr.refers_to) {
                                    visited.insert(key.clone());
                                    let resolved_callee = resolve_names_in_ast_with_shadows(
                                        &sub_ast, named_ranges, current_sheet_index, visited, shadows,
                                    );
                                    visited.remove(&key);
                                    let mut invoke_args = vec![resolved_callee];
                                    for a in args {
                                        invoke_args.push(resolve_names_in_ast_with_shadows(
                                            a, named_ranges, current_sheet_index, visited, shadows,
                                        ));
                                    }
                                    return ParserExpr::FunctionCall {
                                        func: ParserBuiltinFn::Custom("__INVOKE__".to_string()),
                                        args: invoke_args,
                                    };
                                }
                            }
                        }
                    }
                    ParserExpr::FunctionCall {
                        func: func.clone(),
                        args: args.iter().map(|a| resolve_names_in_ast_with_shadows(a, named_ranges, current_sheet_index, visited, shadows)).collect(),
                    }
                },
            }
        }
        ParserExpr::Range { sheet, start, end } => ParserExpr::Range {
            sheet: sheet.clone(),
            start: Box::new(resolve_names_in_ast_with_shadows(start, named_ranges, current_sheet_index, visited, shadows)),
            end: Box::new(resolve_names_in_ast_with_shadows(end, named_ranges, current_sheet_index, visited, shadows)),
        },
        ParserExpr::Sheet3DRef { start_sheet, end_sheet, reference } => ParserExpr::Sheet3DRef {
            start_sheet: start_sheet.clone(),
            end_sheet: end_sheet.clone(),
            reference: Box::new(resolve_names_in_ast_with_shadows(reference, named_ranges, current_sheet_index, visited, shadows)),
        },
        ParserExpr::IndexAccess { target, index } => ParserExpr::IndexAccess {
            target: Box::new(resolve_names_in_ast_with_shadows(target, named_ranges, current_sheet_index, visited, shadows)),
            index: Box::new(resolve_names_in_ast_with_shadows(index, named_ranges, current_sheet_index, visited, shadows)),
        },
        ParserExpr::ListLiteral { elements } => ParserExpr::ListLiteral {
            elements: elements.iter().map(|e| resolve_names_in_ast_with_shadows(e, named_ranges, current_sheet_index, visited, shadows)).collect(),
        },
        ParserExpr::DictLiteral { entries } => ParserExpr::DictLiteral {
            entries: entries.iter().map(|(k, v)| (
                resolve_names_in_ast_with_shadows(k, named_ranges, current_sheet_index, visited, shadows),
                resolve_names_in_ast_with_shadows(v, named_ranges, current_sheet_index, visited, shadows),
            )).collect(),
        },
        ParserExpr::SpillRef { cell } => ParserExpr::SpillRef {
            cell: Box::new(resolve_names_in_ast_with_shadows(cell, named_ranges, current_sheet_index, visited, shadows)),
        },
        ParserExpr::ImplicitIntersection { operand } => ParserExpr::ImplicitIntersection {
            operand: Box::new(resolve_names_in_ast_with_shadows(operand, named_ranges, current_sheet_index, visited, shadows)),
        },
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
        ParserExpr::FunctionCall { func, args } => {
            // Custom function names might be named ranges pointing to LAMBDAs
            if matches!(func, ParserBuiltinFn::Custom(_)) {
                return true;
            }
            args.iter().any(ast_has_named_refs)
        }
        ParserExpr::Range { start, end, .. } => {
            ast_has_named_refs(start) || ast_has_named_refs(end)
        }
        ParserExpr::Sheet3DRef { reference, .. } => ast_has_named_refs(reference),
        ParserExpr::IndexAccess { target, index } => {
            ast_has_named_refs(target) || ast_has_named_refs(index)
        }
        ParserExpr::ListLiteral { elements } => elements.iter().any(ast_has_named_refs),
        ParserExpr::DictLiteral { entries } => entries.iter().any(|(k, v)| ast_has_named_refs(k) || ast_has_named_refs(v)),
        ParserExpr::SpillRef { cell } => ast_has_named_refs(cell),
        ParserExpr::ImplicitIntersection { operand } => ast_has_named_refs(operand),
    }
}

/// Checks if a parser AST contains any TableRef nodes that need resolution.
pub fn ast_has_table_refs(ast: &ParserExpr) -> bool {
    match ast {
        ParserExpr::TableRef { .. } => true,
        ParserExpr::Literal(_) | ParserExpr::CellRef { .. }
        | ParserExpr::ColumnRef { .. } | ParserExpr::RowRef { .. }
        | ParserExpr::NamedRef { .. } => false,
        ParserExpr::IndexAccess { target, index } => {
            ast_has_table_refs(target) || ast_has_table_refs(index)
        }
        ParserExpr::BinaryOp { left, right, .. } => {
            ast_has_table_refs(left) || ast_has_table_refs(right)
        }
        ParserExpr::UnaryOp { operand, .. } => ast_has_table_refs(operand),
        ParserExpr::FunctionCall { args, .. } => args.iter().any(ast_has_table_refs),
        ParserExpr::Range { start, end, .. } => {
            ast_has_table_refs(start) || ast_has_table_refs(end)
        }
        ParserExpr::Sheet3DRef { reference, .. } => ast_has_table_refs(reference),
        ParserExpr::ListLiteral { elements } => elements.iter().any(ast_has_table_refs),
        ParserExpr::DictLiteral { entries } => entries.iter().any(|(k, v)| ast_has_table_refs(k) || ast_has_table_refs(v)),
        ParserExpr::SpillRef { cell } => ast_has_table_refs(cell),
        ParserExpr::ImplicitIntersection { operand } => ast_has_table_refs(operand),
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
        ParserExpr::IndexAccess { target, index } => ParserExpr::IndexAccess {
            target: Box::new(resolve_table_refs_in_ast(target, ctx)),
            index: Box::new(resolve_table_refs_in_ast(index, ctx)),
        },
        ParserExpr::ListLiteral { elements } => ParserExpr::ListLiteral {
            elements: elements.iter().map(|e| resolve_table_refs_in_ast(e, ctx)).collect(),
        },
        ParserExpr::DictLiteral { entries } => ParserExpr::DictLiteral {
            entries: entries.iter().map(|(k, v)| (
                resolve_table_refs_in_ast(k, ctx),
                resolve_table_refs_in_ast(v, ctx),
            )).collect(),
        },
        ParserExpr::SpillRef { cell } => ParserExpr::SpillRef {
            cell: Box::new(resolve_table_refs_in_ast(cell, ctx)),
        },
        ParserExpr::ImplicitIntersection { operand } => ParserExpr::ImplicitIntersection {
            operand: Box::new(resolve_table_refs_in_ast(operand, ctx)),
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
            // Should not appear after resolution, but handle gracefully.
            // table_specifier_to_string already wraps in brackets, e.g. [@sales] or [Column].
            let spec_str = table_specifier_to_string(specifier);
            if table_name.is_empty() {
                spec_str
            } else {
                format!("{}{}", table_name, spec_str)
            }
        }
        ParserExpr::IndexAccess { target, index } => {
            format!("{}[{}]", expression_to_formula(target), expression_to_formula(index))
        }
        ParserExpr::ListLiteral { elements } => {
            let inner: Vec<String> = elements.iter().map(|e| expression_to_formula(e)).collect();
            format!("{{{}}}", inner.join(", "))
        }
        ParserExpr::DictLiteral { entries } => {
            let inner: Vec<String> = entries.iter().map(|(k, v)| {
                format!("{}: {}", expression_to_formula(k), expression_to_formula(v))
            }).collect();
            format!("{{{}}}", inner.join(", "))
        }
        ParserExpr::SpillRef { cell } => {
            format!("{}#", expression_to_formula(cell))
        }
        ParserExpr::ImplicitIntersection { operand } => {
            format!("@{}", expression_to_formula(operand))
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
        ParserBuiltinFn::SumIf => "SUMIF".to_string(),
        ParserBuiltinFn::SumIfs => "SUMIFS".to_string(),
        ParserBuiltinFn::CountIf => "COUNTIF".to_string(),
        ParserBuiltinFn::CountIfs => "COUNTIFS".to_string(),
        ParserBuiltinFn::AverageIf => "AVERAGEIF".to_string(),
        ParserBuiltinFn::AverageIfs => "AVERAGEIFS".to_string(),
        ParserBuiltinFn::CountBlank => "COUNTBLANK".to_string(),
        ParserBuiltinFn::MinIfs => "MINIFS".to_string(),
        ParserBuiltinFn::MaxIfs => "MAXIFS".to_string(),
        ParserBuiltinFn::If => "IF".to_string(),
        ParserBuiltinFn::And => "AND".to_string(),
        ParserBuiltinFn::Or => "OR".to_string(),
        ParserBuiltinFn::Not => "NOT".to_string(),
        ParserBuiltinFn::True => "TRUE".to_string(),
        ParserBuiltinFn::False => "FALSE".to_string(),
        ParserBuiltinFn::IfError => "IFERROR".to_string(),
        ParserBuiltinFn::IfNa => "IFNA".to_string(),
        ParserBuiltinFn::Ifs => "IFS".to_string(),
        ParserBuiltinFn::Switch => "SWITCH".to_string(),
        ParserBuiltinFn::Xor => "XOR".to_string(),
        ParserBuiltinFn::Abs => "ABS".to_string(),
        ParserBuiltinFn::Round => "ROUND".to_string(),
        ParserBuiltinFn::Floor => "FLOOR".to_string(),
        ParserBuiltinFn::Ceiling => "CEILING".to_string(),
        ParserBuiltinFn::Sqrt => "SQRT".to_string(),
        ParserBuiltinFn::Power => "POWER".to_string(),
        ParserBuiltinFn::Mod => "MOD".to_string(),
        ParserBuiltinFn::Int => "INT".to_string(),
        ParserBuiltinFn::Sign => "SIGN".to_string(),
        ParserBuiltinFn::SumProduct => "SUMPRODUCT".to_string(),
        ParserBuiltinFn::SumX2MY2 => "SUMX2MY2".to_string(),
        ParserBuiltinFn::SumX2PY2 => "SUMX2PY2".to_string(),
        ParserBuiltinFn::SumXMY2 => "SUMXMY2".to_string(),
        ParserBuiltinFn::Product => "PRODUCT".to_string(),
        ParserBuiltinFn::Rand => "RAND".to_string(),
        ParserBuiltinFn::RandBetween => "RANDBETWEEN".to_string(),
        ParserBuiltinFn::Pi => "PI".to_string(),
        ParserBuiltinFn::Log => "LOG".to_string(),
        ParserBuiltinFn::Log10 => "LOG10".to_string(),
        ParserBuiltinFn::Ln => "LN".to_string(),
        ParserBuiltinFn::Exp => "EXP".to_string(),
        ParserBuiltinFn::Sin => "SIN".to_string(),
        ParserBuiltinFn::Cos => "COS".to_string(),
        ParserBuiltinFn::Tan => "TAN".to_string(),
        ParserBuiltinFn::Asin => "ASIN".to_string(),
        ParserBuiltinFn::Acos => "ACOS".to_string(),
        ParserBuiltinFn::Atan => "ATAN".to_string(),
        ParserBuiltinFn::Atan2 => "ATAN2".to_string(),
        ParserBuiltinFn::RoundUp => "ROUNDUP".to_string(),
        ParserBuiltinFn::RoundDown => "ROUNDDOWN".to_string(),
        ParserBuiltinFn::Trunc => "TRUNC".to_string(),
        ParserBuiltinFn::Even => "EVEN".to_string(),
        ParserBuiltinFn::Odd => "ODD".to_string(),
        ParserBuiltinFn::Gcd => "GCD".to_string(),
        ParserBuiltinFn::Lcm => "LCM".to_string(),
        ParserBuiltinFn::Combin => "COMBIN".to_string(),
        ParserBuiltinFn::Fact => "FACT".to_string(),
        ParserBuiltinFn::Degrees => "DEGREES".to_string(),
        ParserBuiltinFn::Radians => "RADIANS".to_string(),
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
        ParserBuiltinFn::Find => "FIND".to_string(),
        ParserBuiltinFn::Search => "SEARCH".to_string(),
        ParserBuiltinFn::Substitute => "SUBSTITUTE".to_string(),
        ParserBuiltinFn::Replace => "REPLACE".to_string(),
        ParserBuiltinFn::ValueFn => "VALUE".to_string(),
        ParserBuiltinFn::Exact => "EXACT".to_string(),
        ParserBuiltinFn::Proper => "PROPER".to_string(),
        ParserBuiltinFn::Char => "CHAR".to_string(),
        ParserBuiltinFn::Code => "CODE".to_string(),
        ParserBuiltinFn::Clean => "CLEAN".to_string(),
        ParserBuiltinFn::NumberValue => "NUMBERVALUE".to_string(),
        ParserBuiltinFn::TFn => "T".to_string(),
        ParserBuiltinFn::Today => "TODAY".to_string(),
        ParserBuiltinFn::Now => "NOW".to_string(),
        ParserBuiltinFn::Date => "DATE".to_string(),
        ParserBuiltinFn::Year => "YEAR".to_string(),
        ParserBuiltinFn::Month => "MONTH".to_string(),
        ParserBuiltinFn::Day => "DAY".to_string(),
        ParserBuiltinFn::Hour => "HOUR".to_string(),
        ParserBuiltinFn::Minute => "MINUTE".to_string(),
        ParserBuiltinFn::Second => "SECOND".to_string(),
        ParserBuiltinFn::DateValue => "DATEVALUE".to_string(),
        ParserBuiltinFn::TimeValue => "TIMEVALUE".to_string(),
        ParserBuiltinFn::EDate => "EDATE".to_string(),
        ParserBuiltinFn::EOMonth => "EOMONTH".to_string(),
        ParserBuiltinFn::NetworkDays => "NETWORKDAYS".to_string(),
        ParserBuiltinFn::WorkDay => "WORKDAY".to_string(),
        ParserBuiltinFn::DateDif => "DATEDIF".to_string(),
        ParserBuiltinFn::Weekday => "WEEKDAY".to_string(),
        ParserBuiltinFn::WeekNum => "WEEKNUM".to_string(),
        ParserBuiltinFn::IsNumber => "ISNUMBER".to_string(),
        ParserBuiltinFn::IsText => "ISTEXT".to_string(),
        ParserBuiltinFn::IsBlank => "ISBLANK".to_string(),
        ParserBuiltinFn::IsError => "ISERROR".to_string(),
        ParserBuiltinFn::IsNa => "ISNA".to_string(),
        ParserBuiltinFn::IsErr => "ISERR".to_string(),
        ParserBuiltinFn::IsLogical => "ISLOGICAL".to_string(),
        ParserBuiltinFn::IsOdd => "ISODD".to_string(),
        ParserBuiltinFn::IsEven => "ISEVEN".to_string(),
        ParserBuiltinFn::TypeFn => "TYPE".to_string(),
        ParserBuiltinFn::NFn => "N".to_string(),
        ParserBuiltinFn::Na => "NA".to_string(),
        ParserBuiltinFn::IsFormula => "ISFORMULA".to_string(),
        ParserBuiltinFn::XLookup => "XLOOKUP".to_string(),
        ParserBuiltinFn::XLookups => "XLOOKUPS".to_string(),
        ParserBuiltinFn::Index => "INDEX".to_string(),
        ParserBuiltinFn::Match => "MATCH".to_string(),
        ParserBuiltinFn::Choose => "CHOOSE".to_string(),
        ParserBuiltinFn::Indirect => "INDIRECT".to_string(),
        ParserBuiltinFn::Offset => "OFFSET".to_string(),
        ParserBuiltinFn::Address => "ADDRESS".to_string(),
        ParserBuiltinFn::Rows => "ROWS".to_string(),
        ParserBuiltinFn::Columns => "COLUMNS".to_string(),
        ParserBuiltinFn::Transpose => "TRANSPOSE".to_string(),
        ParserBuiltinFn::Median => "MEDIAN".to_string(),
        ParserBuiltinFn::Stdev => "STDEV".to_string(),
        ParserBuiltinFn::StdevP => "STDEV.P".to_string(),
        ParserBuiltinFn::Var => "VAR".to_string(),
        ParserBuiltinFn::VarP => "VAR.P".to_string(),
        ParserBuiltinFn::Large => "LARGE".to_string(),
        ParserBuiltinFn::Small => "SMALL".to_string(),
        ParserBuiltinFn::Rank => "RANK".to_string(),
        ParserBuiltinFn::Percentile => "PERCENTILE".to_string(),
        ParserBuiltinFn::Quartile => "QUARTILE".to_string(),
        ParserBuiltinFn::Mode => "MODE".to_string(),
        ParserBuiltinFn::Frequency => "FREQUENCY".to_string(),
        ParserBuiltinFn::Pmt => "PMT".to_string(),
        ParserBuiltinFn::Pv => "PV".to_string(),
        ParserBuiltinFn::Fv => "FV".to_string(),
        ParserBuiltinFn::Npv => "NPV".to_string(),
        ParserBuiltinFn::Irr => "IRR".to_string(),
        ParserBuiltinFn::Rate => "RATE".to_string(),
        ParserBuiltinFn::Nper => "NPER".to_string(),
        ParserBuiltinFn::Sln => "SLN".to_string(),
        ParserBuiltinFn::Db => "DB".to_string(),
        ParserBuiltinFn::Ddb => "DDB".to_string(),
        ParserBuiltinFn::GetRowHeight => "GET.ROW.HEIGHT".to_string(),
        ParserBuiltinFn::GetColumnWidth => "GET.COLUMN.WIDTH".to_string(),
        ParserBuiltinFn::GetCellFillColor => "GET.CELL.FILLCOLOR".to_string(),
        ParserBuiltinFn::Row => "ROW".to_string(),
        ParserBuiltinFn::Column => "COLUMN".to_string(),
        ParserBuiltinFn::Let => "LET".to_string(),
        ParserBuiltinFn::TextJoin => "TEXTJOIN".to_string(),
        ParserBuiltinFn::Filter => "FILTER".to_string(),
        ParserBuiltinFn::Sort => "SORT".to_string(),
        ParserBuiltinFn::SortBy => "SORTBY".to_string(),
        ParserBuiltinFn::Unique => "UNIQUE".to_string(),
        ParserBuiltinFn::Sequence => "SEQUENCE".to_string(),
        ParserBuiltinFn::RandArray => "RANDARRAY".to_string(),
        ParserBuiltinFn::GroupBy => "GROUPBY".to_string(),
        ParserBuiltinFn::PivotBy => "PIVOTBY".to_string(),
        ParserBuiltinFn::GetPivotData => "GETPIVOTDATA".to_string(),
        ParserBuiltinFn::Collect => "COLLECT".to_string(),
        ParserBuiltinFn::DictFn => "DICT".to_string(),
        ParserBuiltinFn::Keys => "KEYS".to_string(),
        ParserBuiltinFn::Values => "VALUES".to_string(),
        ParserBuiltinFn::Contains => "CONTAINS".to_string(),
        ParserBuiltinFn::IsList => "ISLIST".to_string(),
        ParserBuiltinFn::IsDict => "ISDICT".to_string(),
        ParserBuiltinFn::Flatten => "FLATTEN".to_string(),
        ParserBuiltinFn::Take => "TAKE".to_string(),
        ParserBuiltinFn::Drop => "DROP".to_string(),
        ParserBuiltinFn::Append => "APPEND".to_string(),
        ParserBuiltinFn::Merge => "MERGE".to_string(),
        ParserBuiltinFn::HStack => "HSTACK".to_string(),
        ParserBuiltinFn::FileRead => "FILEREAD".to_string(),
        ParserBuiltinFn::FileLines => "FILELINES".to_string(),
        ParserBuiltinFn::FileExists => "FILEEXISTS".to_string(),
        ParserBuiltinFn::Lambda => "LAMBDA".to_string(),
        ParserBuiltinFn::Map => "MAP".to_string(),
        ParserBuiltinFn::Reduce => "REDUCE".to_string(),
        ParserBuiltinFn::Scan => "SCAN".to_string(),
        ParserBuiltinFn::MakeArray => "MAKEARRAY".to_string(),
        ParserBuiltinFn::ByRow => "BYROW".to_string(),
        ParserBuiltinFn::ByCol => "BYCOL".to_string(),
        ParserBuiltinFn::Subtotal => "SUBTOTAL".to_string(),
        // Hyperbolic & reciprocal trig
        ParserBuiltinFn::Sinh => "SINH".to_string(),
        ParserBuiltinFn::Cosh => "COSH".to_string(),
        ParserBuiltinFn::Tanh => "TANH".to_string(),
        ParserBuiltinFn::Cot => "COT".to_string(),
        ParserBuiltinFn::Coth => "COTH".to_string(),
        ParserBuiltinFn::Csc => "CSC".to_string(),
        ParserBuiltinFn::Csch => "CSCH".to_string(),
        ParserBuiltinFn::Sec => "SEC".to_string(),
        ParserBuiltinFn::Sech => "SECH".to_string(),
        ParserBuiltinFn::Acot => "ACOT".to_string(),
        // Rounding variants
        ParserBuiltinFn::CeilingMath => "CEILING.MATH".to_string(),
        ParserBuiltinFn::CeilingPrecise => "CEILING.PRECISE".to_string(),
        ParserBuiltinFn::FloorMath => "FLOOR.MATH".to_string(),
        ParserBuiltinFn::FloorPrecise => "FLOOR.PRECISE".to_string(),
        ParserBuiltinFn::IsoCeiling => "ISO.CEILING".to_string(),
        // Additional math (Group 3)
        ParserBuiltinFn::Multinomial => "MULTINOMIAL".to_string(),
        ParserBuiltinFn::Combina => "COMBINA".to_string(),
        ParserBuiltinFn::FactDouble => "FACTDOUBLE".to_string(),
        ParserBuiltinFn::SqrtPi => "SQRTPI".to_string(),
        // Aggregate
        ParserBuiltinFn::Aggregate => "AGGREGATE".to_string(),
        // Web
        ParserBuiltinFn::EncodeUrl => "ENCODEURL".to_string(),
        // Database functions
        ParserBuiltinFn::DAverage => "DAVERAGE".to_string(),
        ParserBuiltinFn::DCount => "DCOUNT".to_string(),
        ParserBuiltinFn::DCountA => "DCOUNTA".to_string(),
        ParserBuiltinFn::DGet => "DGET".to_string(),
        ParserBuiltinFn::DMax => "DMAX".to_string(),
        ParserBuiltinFn::DMin => "DMIN".to_string(),
        ParserBuiltinFn::DProduct => "DPRODUCT".to_string(),
        ParserBuiltinFn::DStdev => "DSTDEV".to_string(),
        ParserBuiltinFn::DStdevP => "DSTDEVP".to_string(),
        ParserBuiltinFn::DSum => "DSUM".to_string(),
        ParserBuiltinFn::DVar => "DVAR".to_string(),
        ParserBuiltinFn::DVarP => "DVARP".to_string(),
        ParserBuiltinFn::Custom(name) => name.clone(),
        other => format!("{:?}", other),
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

/// Evaluates a formula AST with EvalContext and optional StyleRegistry.
/// Used when the formula may need current cell position or style access (for GET.* functions).
pub fn evaluate_formula_with_context(
    grids: &[Grid],
    sheet_names: &[String],
    current_sheet_index: usize,
    ast: &EngineExpr,
    eval_ctx: engine::EvalContext,
    style_registry: Option<&engine::StyleRegistry>,
) -> CellValue {
    if current_sheet_index >= grids.len() || current_sheet_index >= sheet_names.len() {
        return CellValue::Error(CellError::Ref);
    }

    let current_grid = &grids[current_sheet_index];
    let current_sheet_name = &sheet_names[current_sheet_index];
    let context = create_multi_sheet_context(grids, sheet_names, current_sheet_name);
    let mut evaluator = Evaluator::with_context(current_grid, context, eval_ctx);
    if let Some(sr) = style_registry {
        evaluator.set_styles(sr);
    }
    evaluator.evaluate(ast).to_cell_value()
}

/// Like `evaluate_formula_with_context` but with file reader support.
pub fn evaluate_formula_with_context_and_files(
    grids: &[Grid],
    sheet_names: &[String],
    current_sheet_index: usize,
    ast: &EngineExpr,
    eval_ctx: engine::EvalContext,
    style_registry: Option<&engine::StyleRegistry>,
    user_files: &HashMap<String, Vec<u8>>,
) -> CellValue {
    if current_sheet_index >= grids.len() || current_sheet_index >= sheet_names.len() {
        return CellValue::Error(CellError::Ref);
    }

    let current_grid = &grids[current_sheet_index];
    let current_sheet_name = &sheet_names[current_sheet_index];
    let context = create_multi_sheet_context(grids, sheet_names, current_sheet_name);
    let reader = |path: &str| -> Option<String> {
        user_files.get(path).and_then(|bytes| String::from_utf8(bytes.clone()).ok())
    };
    let mut evaluator = Evaluator::with_context(current_grid, context, eval_ctx);
    if let Some(sr) = style_registry {
        evaluator.set_styles(sr);
    }
    evaluator.set_file_reader(&reader);
    evaluator.evaluate(ast).to_cell_value()
}

/// Like `evaluate_formula_with_context_and_files` but with pivot data lookup support.
pub fn evaluate_formula_with_pivot(
    grids: &[Grid],
    sheet_names: &[String],
    current_sheet_index: usize,
    ast: &EngineExpr,
    eval_ctx: engine::EvalContext,
    style_registry: Option<&engine::StyleRegistry>,
    user_files: &HashMap<String, Vec<u8>>,
    pivot_data_fn: Option<&dyn Fn(&str, u32, u32, &[(&str, &str)]) -> Option<f64>>,
) -> CellValue {
    if current_sheet_index >= grids.len() || current_sheet_index >= sheet_names.len() {
        return CellValue::Error(CellError::Ref);
    }

    let current_grid = &grids[current_sheet_index];
    let current_sheet_name = &sheet_names[current_sheet_index];
    let context = create_multi_sheet_context(grids, sheet_names, current_sheet_name);
    let reader = |path: &str| -> Option<String> {
        user_files.get(path).and_then(|bytes| String::from_utf8(bytes.clone()).ok())
    };
    let mut evaluator = Evaluator::with_context(current_grid, context, eval_ctx);
    if let Some(sr) = style_registry {
        evaluator.set_styles(sr);
    }
    evaluator.set_file_reader(&reader);
    if let Some(pf) = pivot_data_fn {
        evaluator.set_pivot_data_fn(pf);
    }
    evaluator.evaluate(ast).to_cell_value()
}

/// Evaluates a formula AST with context, returning the raw EvalResult.
/// Used for dynamic array functions that need spill handling.
pub fn evaluate_formula_raw(
    grids: &[Grid],
    sheet_names: &[String],
    current_sheet_index: usize,
    ast: &EngineExpr,
    eval_ctx: engine::EvalContext,
    style_registry: Option<&engine::StyleRegistry>,
) -> EvalResult {
    if current_sheet_index >= grids.len() || current_sheet_index >= sheet_names.len() {
        return EvalResult::Error(CellError::Ref);
    }

    let current_grid = &grids[current_sheet_index];
    let current_sheet_name = &sheet_names[current_sheet_index];
    let context = create_multi_sheet_context(grids, sheet_names, current_sheet_name);
    let mut evaluator = Evaluator::with_context(current_grid, context, eval_ctx);
    if let Some(sr) = style_registry {
        evaluator.set_styles(sr);
    }
    evaluator.evaluate(ast)
}

/// Like `evaluate_formula_raw` but with file reader support.
pub fn evaluate_formula_raw_with_files(
    grids: &[Grid],
    sheet_names: &[String],
    current_sheet_index: usize,
    ast: &EngineExpr,
    eval_ctx: engine::EvalContext,
    style_registry: Option<&engine::StyleRegistry>,
    user_files: &HashMap<String, Vec<u8>>,
) -> EvalResult {
    evaluate_formula_raw_with_files_and_pivot(
        grids, sheet_names, current_sheet_index, ast, eval_ctx,
        style_registry, user_files, None,
    )
}

/// Like `evaluate_formula_raw_with_files` but also supports GETPIVOTDATA via an optional closure.
pub fn evaluate_formula_raw_with_files_and_pivot(
    grids: &[Grid],
    sheet_names: &[String],
    current_sheet_index: usize,
    ast: &EngineExpr,
    eval_ctx: engine::EvalContext,
    style_registry: Option<&engine::StyleRegistry>,
    user_files: &HashMap<String, Vec<u8>>,
    pivot_data_fn: Option<&dyn Fn(&str, u32, u32, &[(&str, &str)]) -> Option<f64>>,
) -> EvalResult {
    if current_sheet_index >= grids.len() || current_sheet_index >= sheet_names.len() {
        return EvalResult::Error(CellError::Ref);
    }

    let current_grid = &grids[current_sheet_index];
    let current_sheet_name = &sheet_names[current_sheet_index];
    let context = create_multi_sheet_context(grids, sheet_names, current_sheet_name);
    let reader = |path: &str| -> Option<String> {
        user_files.get(path).and_then(|bytes| String::from_utf8(bytes.clone()).ok())
    };
    let mut evaluator = Evaluator::with_context(current_grid, context, eval_ctx);
    if let Some(sr) = style_registry {
        evaluator.set_styles(sr);
    }
    evaluator.set_file_reader(&reader);
    if let Some(pf) = pivot_data_fn {
        evaluator.set_pivot_data_fn(pf);
    }
    evaluator.evaluate(ast)
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

/// Creates an Evaluator with multi-sheet context and file reader support.
pub fn create_evaluator_with_files<'a>(
    grids: &'a [Grid],
    sheet_names: &[String],
    current_sheet_index: usize,
    file_reader: Option<&'a dyn Fn(&str) -> Option<String>>,
) -> Option<Evaluator<'a>> {
    if current_sheet_index >= grids.len() || current_sheet_index >= sheet_names.len() {
        return None;
    }

    let current_grid = &grids[current_sheet_index];
    let current_sheet_name = &sheet_names[current_sheet_index];
    let context = create_multi_sheet_context(grids, sheet_names, current_sheet_name);
    let mut evaluator = Evaluator::with_multi_sheet(current_grid, context);
    if let Some(reader) = file_reader {
        evaluator.set_file_reader(reader);
    }
    Some(evaluator)
}

/// Like `evaluate_formula_multi_sheet` but with file reader support for FILEREAD/FILELINES/FILEEXISTS.
pub fn evaluate_formula_multi_sheet_with_files(
    grids: &[Grid],
    sheet_names: &[String],
    current_sheet_index: usize,
    formula: &str,
    user_files: &HashMap<String, Vec<u8>>,
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
            let reader = |path: &str| -> Option<String> {
                user_files.get(path).and_then(|bytes| String::from_utf8(bytes.clone()).ok())
            };
            let mut evaluator = Evaluator::with_multi_sheet(current_grid, context);
            evaluator.set_file_reader(&reader);
            evaluator.evaluate(&engine_ast).to_cell_value()
        }
        Err(e) => {
            log_error!("EVAL", "parse_err formula={} err={}", formula, e);
            CellValue::Error(CellError::Value)
        }
    }
}

/// Like `evaluate_formula_multi_sheet_with_ast` but with file reader support.
pub fn evaluate_formula_multi_sheet_with_ast_and_files(
    grids: &[Grid],
    sheet_names: &[String],
    current_sheet_index: usize,
    ast: &EngineExpr,
    user_files: &HashMap<String, Vec<u8>>,
) -> CellValue {
    if current_sheet_index >= grids.len() || current_sheet_index >= sheet_names.len() {
        return CellValue::Error(CellError::Ref);
    }

    let current_grid = &grids[current_sheet_index];
    let current_sheet_name = &sheet_names[current_sheet_index];
    let context = create_multi_sheet_context(grids, sheet_names, current_sheet_name);
    let reader = |path: &str| -> Option<String> {
        user_files.get(path).and_then(|bytes| String::from_utf8(bytes.clone()).ok())
    };
    let mut evaluator = Evaluator::with_multi_sheet(current_grid, context);
    evaluator.set_file_reader(&reader);
    evaluator.evaluate(ast).to_cell_value()
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

pub fn parse_cell_input(input: &str, locale: &engine::LocaleSettings) -> Cell {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Cell::new();
    }
    if trimmed.starts_with('=') {
        // Delocalize the formula: convert locale separators to invariant format for storage
        let invariant = engine::delocalize_formula(trimmed, locale);
        return Cell::new_formula(invariant);
    }
    let upper = trimmed.to_uppercase();
    if upper == "TRUE" {
        return Cell::new_boolean(true);
    }
    if upper == "FALSE" {
        return Cell::new_boolean(false);
    }
    if let Some(num) = parse_number(trimmed, locale) {
        return Cell::new_number(num);
    }
    Cell::new_text(trimmed.to_string())
}

/// Parse cell input that is already in invariant (US) format.
/// Formulas are stored as-is without delocalization; numbers use '.' as decimal separator.
pub fn parse_cell_input_invariant(input: &str, locale: &engine::LocaleSettings) -> Cell {
    let trimmed = input.trim();
    if trimmed.is_empty() {
        return Cell::new();
    }
    if trimmed.starts_with('=') {
        // Formula is already in invariant format — store directly
        return Cell::new_formula(trimmed.to_string());
    }
    let upper = trimmed.to_uppercase();
    if upper == "TRUE" {
        return Cell::new_boolean(true);
    }
    if upper == "FALSE" {
        return Cell::new_boolean(false);
    }
    // Try invariant number parsing first (dot decimal), then locale-aware
    if let Ok(n) = trimmed.parse::<f64>() {
        if n.is_finite() {
            return Cell::new_number(n);
        }
    }
    if let Some(num) = parse_number(trimmed, locale) {
        return Cell::new_number(num);
    }
    Cell::new_text(trimmed.to_string())
}

/// Parse a string as a number, respecting locale separators.
/// - Strips the locale's thousands separator
/// - Replaces the locale's decimal separator with '.' for f64 parsing
fn parse_number(s: &str, locale: &engine::LocaleSettings) -> Option<f64> {
    let trimmed = s.trim();
    if trimmed.ends_with('%') {
        let num_part = trimmed.trim_end_matches('%').trim();
        // For percentage parsing, also apply locale decimal separator
        let cleaned = if locale.decimal_separator == ',' {
            num_part
                .replace('.', "") // strip thousands (dot in comma-decimal locales)
                .replace(',', ".") // convert decimal comma to dot
        } else {
            num_part.replace(',', "") // strip thousands
        };
        if let Ok(n) = cleaned.parse::<f64>() {
            return Some(n / 100.0);
        }
        return None;
    }

    // Strip thousands separator, then convert decimal separator to '.'
    let cleaned = if locale.decimal_separator == ',' {
        // Comma-decimal locale: thousands separator is '.', ' ', or '\u{00A0}'
        let s = trimmed
            .replace(&locale.thousands_separator.to_string(), "")
            .replace(',', ".");
        s
    } else {
        // Dot-decimal locale: thousands separator is ','
        trimmed.replace(&locale.thousands_separator.to_string(), "")
    };

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
// Third-Party Extension Loading
// ============================================================================

/// Extension file entry returned by scan_extension_directory.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionFileEntry {
    /// File name (e.g., "my-extension.js")
    pub file_name: String,
    /// Full absolute path
    pub path: String,
    /// File content (the JavaScript source)
    pub content: String,
}

/// Scan a directory for third-party extension bundles (.js files).
/// Returns the file name, path, and content of each found extension.
#[tauri::command]
fn scan_extension_directory(dir: String) -> Result<Vec<ExtensionFileEntry>, String> {
    let path = std::path::Path::new(&dir);
    if !path.exists() {
        // Directory doesn't exist — not an error, just no extensions
        return Ok(vec![]);
    }
    if !path.is_dir() {
        return Err(format!("'{}' is not a directory", dir));
    }

    let mut entries = Vec::new();
    let read_dir = std::fs::read_dir(path).map_err(|e| format!("Failed to read directory: {}", e))?;

    for entry in read_dir {
        let entry = entry.map_err(|e| format!("Failed to read entry: {}", e))?;
        let file_path = entry.path();

        // Only load .js files (pre-built extension bundles)
        if file_path.extension().and_then(|e| e.to_str()) == Some("js") {
            let file_name = file_path.file_name()
                .and_then(|n| n.to_str())
                .unwrap_or("unknown")
                .to_string();
            let content = std::fs::read_to_string(&file_path)
                .map_err(|e| format!("Failed to read '{}': {}", file_name, e))?;
            entries.push(ExtensionFileEntry {
                file_name,
                path: file_path.to_string_lossy().to_string(),
                content,
            });
        }

        // Also support directories with an index.js entry point
        if file_path.is_dir() {
            let index_path = file_path.join("index.js");
            if index_path.exists() {
                let dir_name = file_path.file_name()
                    .and_then(|n| n.to_str())
                    .unwrap_or("unknown")
                    .to_string();
                let content = std::fs::read_to_string(&index_path)
                    .map_err(|e| format!("Failed to read '{}/index.js': {}", dir_name, e))?;
                entries.push(ExtensionFileEntry {
                    file_name: format!("{}/index.js", dir_name),
                    path: index_path.to_string_lossy().to_string(),
                    content,
                });
            }
        }
    }

    Ok(entries)
}

/// Get the default path for third-party extensions (next to the app data dir).
#[tauri::command]
fn get_extensions_directory(app_handle: tauri::AppHandle) -> Result<String, String> {
    use tauri::Manager;
    let app_data = app_handle.path().app_data_dir()
        .map_err(|e| format!("Failed to get app data dir: {}", e))?;
    let ext_dir = app_data.join("extensions");
    // Create the directory if it doesn't exist
    if !ext_dir.exists() {
        std::fs::create_dir_all(&ext_dir)
            .map_err(|e| format!("Failed to create extensions dir: {}", e))?;
    }
    Ok(ext_dir.to_string_lossy().to_string())
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
        .plugin(tauri_plugin_clipboard_manager::init())
        .manage(create_app_state())
        .manage(FileState::default())
        .manage(UserFilesState::default())
        .manage(pivot::PivotState::new())
        .manage(bi::BiState::new())
        .manage(evaluate_formula::EvalFormulaState::new())
        .manage(scripting::ScriptState::new())
        .manage(slicer::SlicerState::new())
        .manage(timeline_slicer::TimelineSlicerState::new())
        .manage(mcp::McpState::new())
        .invoke_handler(tauri::generate_handler![
            // Grid commands
            commands::get_viewport_cells,
            commands::get_spill_ranges,
            commands::get_cell,
            commands::get_watch_cells,
            commands::get_cell_collection,
            commands::get_collection_texts,
            commands::update_cell,
            commands::update_cells_batch,
            commands::clear_cell,
            commands::clear_range,
            commands::clear_range_with_options,
            commands::sort_range,
            commands::fill_range,
            commands::update_cell_on_sheets,
            commands::clear_range_on_sheets,
            commands::remove_duplicates,
            commands::get_grid_bounds,
            commands::get_cell_count,
            commands::get_used_range,
            commands::get_cells_in_rows,
            commands::get_cells_in_cols,
            commands::has_content_in_range,
            // Navigation commands
            commands::find_ctrl_arrow_target,
            commands::detect_data_region,
            commands::get_current_region,
            commands::go_to_special,
            // Dimension commands
            commands::set_column_width,
            commands::get_column_width,
            commands::get_all_column_widths,
            commands::set_row_height,
            commands::get_row_height,
            commands::get_all_row_heights,
            commands::get_default_dimensions,
            commands::set_default_row_height,
            commands::set_default_column_width,
            // Style commands
            commands::get_style,
            commands::get_all_styles,
            commands::set_cell_style,
            commands::set_cell_rich_text,
            commands::apply_formatting,
            commands::apply_formatting_to_sheets,
            commands::apply_border_preset,
            commands::preview_number_format,
            commands::get_style_count,
            commands::insert_rows,
            commands::insert_columns,
            commands::delete_rows,
            commands::delete_columns,
            commands::shift_formula_for_fill,
            commands::shift_formulas_batch,
            commands::relocate_cell_references,
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
            calculation::get_iteration_settings,
            calculation::set_iteration_settings,
            calculation::get_calculation_state,
            calculation::get_precision_as_displayed,
            calculation::set_precision_as_displayed,
            calculation::get_calculate_before_save,
            calculation::set_calculate_before_save,
            // Formula library commands
            formula::get_functions_by_category,
            formula::get_all_functions,
            formula::get_function_template,
            formula::evaluate_expressions,
            // File commands
            persistence::save_file,
            persistence::open_file,
            persistence::new_file,
            persistence::get_current_file_path,
            persistence::is_file_modified,
            persistence::mark_file_modified,
            persistence::list_virtual_files,
            persistence::read_virtual_file,
            persistence::create_virtual_file,
            persistence::create_virtual_folder,
            persistence::delete_virtual_file,
            persistence::rename_virtual_file,
            persistence::get_ai_context,
            persistence::read_text_file,
            persistence::write_text_file,
            persistence::get_auto_recover_settings,
            persistence::set_auto_recover_settings,
            persistence::auto_recover_save,
            persistence::get_workbook_properties,
            persistence::set_workbook_properties,
            // Sheet commands
            sheets::get_sheets,
            sheets::get_active_sheet,
            sheets::set_active_sheet,
            sheets::add_sheet,
            sheets::delete_sheet,
            sheets::rename_sheet,
            sheets::set_freeze_panes,
            sheets::get_freeze_panes,
            sheets::set_split_window,
            sheets::get_split_window,
            sheets::move_sheet,
            sheets::copy_sheet,
            sheets::hide_sheet,
            sheets::unhide_sheet,
            sheets::set_tab_color,
            sheets::next_sheet,
            sheets::previous_sheet,
            sheets::set_scroll_area,
            sheets::get_scroll_area,
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
            pivot::get_pivot_cell_window,
            pivot::cancel_pivot_operation,
            pivot::revert_pivot_operation,
            pivot::delete_pivot_table,
            pivot::relocate_pivot,
            pivot::get_pivot_source_data,
            pivot::refresh_pivot_cache,
            pivot::get_pivot_at_cell,
            pivot::get_pivot_data_formula,
            pivot::get_pivot_regions_for_sheet,
            pivot::get_pivot_field_unique_values,
            // Pivot table commands - Excel-compatible API
            pivot::get_pivot_table_info,
            pivot::update_pivot_properties,
            pivot::change_pivot_data_source,
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
            pivot::create_pivot_from_bi_model,
            pivot::update_bi_pivot_fields,
            pivot::set_bi_lookup_columns,
            pivot::show_report_filter_pages,
            pivot::add_calculated_field,
            pivot::update_calculated_field,
            pivot::remove_calculated_field,
            pivot::add_calculated_item,
            pivot::remove_calculated_item,
            // Named range commands
            named_ranges::create_named_range,
            named_ranges::update_named_range,
            named_ranges::delete_named_range,
            named_ranges::get_named_range,
            named_ranges::get_all_named_ranges,
            named_ranges::get_named_range_for_selection,
            named_ranges::rename_named_range,
            named_ranges::apply_names_to_formulas,
            // BI (Business Intelligence) commands
            bi::bi_create_connection,
            bi::bi_delete_connection,
            bi::bi_update_connection,
            bi::bi_get_connections,
            bi::bi_get_connection,
            bi::bi_connect,
            bi::bi_disconnect,
            bi::bi_bind_table,
            bi::bi_query,
            bi::bi_insert_result,
            bi::bi_refresh_connection,
            bi::bi_get_model_info,
            bi::bi_get_region_at_cell,
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
            // Note commands
            notes::add_note,
            notes::update_note,
            notes::delete_note,
            notes::get_note,
            notes::get_note_by_id,
            notes::get_all_notes,
            notes::get_note_indicators,
            notes::get_note_indicators_in_range,
            notes::resize_note,
            notes::toggle_note_visibility,
            notes::show_all_notes,
            notes::move_note,
            notes::has_note,
            notes::clear_all_notes,
            notes::clear_notes_in_range,
            notes::convert_note_to_comment,
            // AutoFilter commands
            autofilter::apply_auto_filter,
            autofilter::clear_column_criteria,
            autofilter::clear_auto_filter_criteria,
            autofilter::reapply_auto_filter,
            autofilter::remove_auto_filter,
            autofilter::get_auto_filter,
            autofilter::get_auto_filter_range,
            autofilter::get_hidden_rows,
            autofilter::set_advanced_filter_hidden_rows,
            autofilter::clear_advanced_filter_hidden_rows,
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
            tables::convert_formula_to_table_refs,
            // Goal Seek command
            goal_seek::goal_seek,
            // Scenario Manager commands
            scenario_manager::scenario_list,
            scenario_manager::scenario_add,
            scenario_manager::scenario_delete,
            scenario_manager::scenario_show,
            scenario_manager::scenario_summary,
            scenario_manager::scenario_merge,
            // Data Tables commands
            data_tables::data_table_one_var,
            data_tables::data_table_two_var,
            // Solver commands
            solver::solver_solve,
            solver::solver_revert,
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
            // Formula evaluation plan (visual formula debugger)
            formula_eval_plan::get_formula_eval_plan,
            // Status bar aggregation command
            status_bar::get_selection_aggregations,
            // Computed Properties commands
            computed_properties::get_computed_properties,
            computed_properties::get_available_attributes,
            computed_properties::add_computed_property,
            computed_properties::update_computed_property,
            computed_properties::remove_computed_property,
            // Scripting commands
            scripting::run_script,
            scripting::get_script_security_level,
            scripting::set_script_security_level,
            scripting::list_scripts,
            scripting::get_script,
            scripting::save_script,
            scripting::delete_script,
            scripting::rename_script,
            // Notebook commands
            scripting::notebook_create,
            scripting::notebook_save,
            scripting::notebook_load,
            scripting::notebook_list,
            scripting::notebook_delete,
            scripting::notebook_run_cell,
            scripting::notebook_run_all,
            scripting::notebook_rewind,
            scripting::notebook_run_from,
            scripting::notebook_reset_runtime,
            // Control metadata commands
            controls::get_control_metadata,
            controls::set_control_property,
            controls::set_control_metadata,
            controls::remove_control_metadata,
            controls::get_all_controls,
            controls::resolve_control_properties,
            // Print commands
            commands::get_page_setup,
            commands::set_page_setup,
            commands::get_print_data,
            commands::write_binary_file,
            commands::insert_row_page_break,
            commands::remove_row_page_break,
            commands::insert_col_page_break,
            commands::remove_col_page_break,
            commands::reset_all_page_breaks,
            commands::set_print_area,
            commands::clear_print_area,
            commands::set_print_title_rows,
            commands::clear_print_title_rows,
            commands::set_print_title_cols,
            commands::clear_print_title_cols,
            commands::move_page_break,
            // MCP server commands
            mcp::mcp_start,
            mcp::mcp_stop,
            mcp::mcp_status,
            mcp::mcp_set_port,
            // Linked Sheet commands
            linked_sheets::publish_sheets,
            linked_sheets::get_publish_info,
            linked_sheets::unpublish_sheet,
            linked_sheets::browse_published_sheets,
            linked_sheets::link_published_sheets,
            linked_sheets::refresh_linked_sheet,
            linked_sheets::refresh_all_linked_sheets,
            linked_sheets::unlink_sheet,
            linked_sheets::get_linked_sheet_status,
            linked_sheets::get_linked_sheets,
            // Slicer commands
            slicer::create_slicer,
            slicer::delete_slicer,
            slicer::update_slicer,
            slicer::update_slicer_position,
            slicer::update_slicer_selection,
            slicer::get_all_slicers,
            slicer::get_slicers_for_sheet,
            slicer::get_slicer_items,
            slicer::get_slicer_computed_properties,
            slicer::get_slicer_available_attributes,
            slicer::add_slicer_computed_property,
            slicer::update_slicer_computed_property,
            slicer::remove_slicer_computed_property,
            slicer::get_slicer_computed_attributes,
            // Timeline slicer commands
            timeline_slicer::create_timeline_slicer,
            timeline_slicer::delete_timeline_slicer,
            timeline_slicer::update_timeline_slicer,
            timeline_slicer::update_timeline_position,
            timeline_slicer::update_timeline_selection,
            timeline_slicer::update_timeline_scroll,
            timeline_slicer::update_timeline_connections,
            timeline_slicer::get_all_timeline_slicers,
            timeline_slicer::get_timeline_slicers_for_sheet,
            timeline_slicer::get_timeline_data,
            timeline_slicer::get_timeline_selected_items,
            timeline_slicer::get_pivot_date_fields,
            // Theme commands
            theme_commands::get_document_theme,
            theme_commands::set_document_theme,
            theme_commands::list_builtin_themes,
            theme_commands::get_theme_color_palette,
            // Locale / regional settings
            locale_commands::get_locale_settings,
            locale_commands::set_locale,
            locale_commands::get_supported_locales,
            // Named cell styles commands
            named_styles_cmd::get_named_styles,
            named_styles_cmd::create_named_style,
            named_styles_cmd::delete_named_style,
            named_styles_cmd::apply_named_style,
            // Error checking indicators
            error_checking::get_error_indicators,
            // Chart persistence commands
            chart_commands::get_charts,
            chart_commands::save_chart,
            chart_commands::update_chart,
            chart_commands::delete_chart,
            // R1C1 reference style commands
            r1c1::get_reference_style,
            r1c1::set_reference_style,
            r1c1::convert_formula_style,
            // Third-party extension loading
            scan_extension_directory,
            get_extensions_directory,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            if let tauri::RunEvent::Exit = event {
                // Shut down the MCP server gracefully if running
                if let Some(state) = app_handle.try_state::<mcp::McpState>() {
                    if let Ok(ct) = state.cancel_token.lock() {
                        if let Some(token) = ct.as_ref() {
                            token.cancel();
                        }
                    }
                }
            }
        });
}