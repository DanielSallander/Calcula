//! FILENAME: app/src-tauri/src/data_validation.rs
//! PURPOSE: Data validation for cells - Excel-compatible validation rules.
//! CONTEXT: Implements validation types (WholeNumber, Decimal, List, Date, Time,
//! TextLength, Custom), operators, error alerts, and input prompts.

use crate::AppState;
use crate::document_effect::DocumentEffect;
use crate::persistence::FileState;
use engine::{CellValue, Grid};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use tauri::State;

// ============================================================================
// DATA VALIDATION TYPES
// ============================================================================

/// The type of validation applied to a cell or range.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DataValidationType {
    /// No validation
    None,
    /// Whole number validation (integers only)
    WholeNumber,
    /// Decimal number validation
    Decimal,
    /// List/dropdown validation
    List,
    /// Date validation
    Date,
    /// Time validation
    Time,
    /// Text length validation
    TextLength,
    /// Custom formula validation
    Custom,
}

impl Default for DataValidationType {
    fn default() -> Self {
        DataValidationType::None
    }
}

/// Comparison operators for validation rules.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DataValidationOperator {
    /// Value must be between formula1 and formula2 (inclusive)
    Between,
    /// Value must NOT be between formula1 and formula2
    NotBetween,
    /// Value must equal formula1
    Equal,
    /// Value must NOT equal formula1
    NotEqual,
    /// Value must be greater than formula1
    GreaterThan,
    /// Value must be less than formula1
    LessThan,
    /// Value must be greater than or equal to formula1
    GreaterThanOrEqual,
    /// Value must be less than or equal to formula1
    LessThanOrEqual,
}

impl Default for DataValidationOperator {
    fn default() -> Self {
        DataValidationOperator::Between
    }
}

/// Error alert style when invalid data is entered.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DataValidationAlertStyle {
    /// Stop - prevents entry of invalid data
    Stop,
    /// Warning - warns but allows entry
    Warning,
    /// Information - informational only, allows entry
    Information,
}

impl Default for DataValidationAlertStyle {
    fn default() -> Self {
        DataValidationAlertStyle::Stop
    }
}

// ============================================================================
// VALIDATION RULES
// ============================================================================

/// Numeric validation rule (for WholeNumber, Decimal, TextLength).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NumericRule {
    /// First formula/value for comparison
    pub formula1: f64,
    /// Second formula/value for comparison (used with Between/NotBetween)
    pub formula2: Option<f64>,
    /// Comparison operator
    pub operator: DataValidationOperator,
}

/// Date validation rule.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DateRule {
    /// First date value (as Excel serial date number)
    pub formula1: f64,
    /// Second date value (used with Between/NotBetween)
    pub formula2: Option<f64>,
    /// Comparison operator
    pub operator: DataValidationOperator,
}

/// Time validation rule.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TimeRule {
    /// First time value (as fraction of day, e.g., 0.5 = 12:00)
    pub formula1: f64,
    /// Second time value (used with Between/NotBetween)
    pub formula2: Option<f64>,
    /// Comparison operator
    pub operator: DataValidationOperator,
}

/// List validation rule (dropdown).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListRule {
    /// Source values for the dropdown (can be literal values or a range reference)
    pub source: ListSource,
    /// Whether to show the in-cell dropdown arrow
    pub in_cell_dropdown: bool,
}

/// Source of list values.
///
/// `rename_all_fields` as well as `rename_all`: `rename_all` on an enum renames
/// only the VARIANTS, so `Range { start_row, .. }` crossed the wire as
/// `start_row` while the frontend sends and reads `startRow` -- the Data
/// Validation dialog's list-from-range rule was refused outright ("missing
/// field `start_row`"). Pinned by `serde_enum_field_case_tests`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum ListSource {
    /// Literal list of string values
    Values(Vec<String>),
    /// Range reference (e.g., "Sheet1!A1:A10" or named range)
    Range {
        sheet_index: Option<usize>,
        start_row: u32,
        start_col: u32,
        end_row: u32,
        end_col: u32,
        /// Which parts of the source are RELATIVE (written without `$`), as
        /// typed for the validated range's top-left cell (BUG-0745). Excel
        /// moves a relative part by each cell's offset from that top-left
        /// [LIVE, Excel 16, 2026-11-06, cfdvb/probe1.ps1 C1-C4]: `=F1:F2` on
        /// H2:H4 is `=F2:F3` at H3 (`a` refused there, `c` allowed) and
        /// `=F3:F4` at H4; `=$F1:F$2` is `=$F3:F$2` at J4; `=Other!A1:A2` moves
        /// too. Absent = every part absolute, the shape before this existed.
        #[serde(default, skip_serializing_if = "ListRelative::is_absolute")]
        relative: ListRelative,
        /// The source's sheet was DELETED (BUG-0750). Excel keeps the rule and
        /// its rectangle, shows the source as `=#REF!$A$1:$A$3`, keeps the
        /// dropdown and refuses every entry, the value the list used to allow
        /// included [LIVE, cfdvb/probe1.ps1 F0/F1]. `sheet_index` is then
        /// `None` and means nothing.
        #[serde(default, skip_serializing_if = "std::ops::Not::not")]
        sheet_gone: bool,
    },
}

/// Which corners' row and column of a list source are relative (no `$`).
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ListRelative {
    #[serde(default)]
    pub start_row: bool,
    #[serde(default)]
    pub start_col: bool,
    #[serde(default)]
    pub end_row: bool,
    #[serde(default)]
    pub end_col: bool,
}

impl ListRelative {
    /// Every part absolute (`$F$1:$F$5`).
    pub fn is_absolute(&self) -> bool {
        !(self.start_row || self.start_col || self.end_row || self.end_col)
    }
}

/// The rectangle a list source names AT the cell (`row`, `col`) of a
/// validation whose top-left is `anchor`: each relative part moved by the
/// cell's offset, wrapping round the sheet's edge as Excel's does
/// ([LIVE] C4: `=F1048576:F1` read one row down is `F1:F2`). `None` for a
/// literal list or a source whose sheet is gone.
pub(crate) fn list_rect_at(
    source: &ListSource,
    anchor: (u32, u32),
    row: u32,
    col: u32,
) -> Option<(Option<usize>, u32, u32, u32, u32)> {
    let ListSource::Range { sheet_index, start_row, start_col, end_row, end_col, relative, sheet_gone } = source else {
        return None;
    };
    if *sheet_gone {
        return None;
    }
    let rows = engine::EXCEL_MAX_ROW_INDEX as i64 + 1;
    let cols = engine::EXCEL_MAX_COL_INDEX as i64 + 1;
    let drow = row as i64 - anchor.0 as i64;
    let dcol = col as i64 - anchor.1 as i64;
    let mv = |v: u32, rel: bool, d: i64, size: i64| -> u32 {
        if rel && d != 0 {
            (v as i64 + d).rem_euclid(size) as u32
        } else {
            v
        }
    };
    let r0 = mv(*start_row, relative.start_row, drow, rows);
    let r1 = mv(*end_row, relative.end_row, drow, rows);
    let c0 = mv(*start_col, relative.start_col, dcol, cols);
    let c1 = mv(*end_col, relative.end_col, dcol, cols);
    Some((*sheet_index, r0.min(r1), c0.min(c1), r0.max(r1), c0.max(c1)))
}

/// A RELATIVE list source as formula text written for its validation's
/// top-left, always sheet-qualified (`='Data'!$F1:F2`), so the formula
/// shifters can carry it through an edit. `None` for an absolute, literal or
/// gone source (those keep their own paths).
pub(crate) fn relative_list_formula(source: &ListSource, own_sheet: usize, sheet_names: &[String]) -> Option<String> {
    let ListSource::Range { sheet_index, start_row, start_col, end_row, end_col, relative, sheet_gone } = source else {
        return None;
    };
    if *sheet_gone || relative.is_absolute() {
        return None;
    }
    let name = sheet_names.get(sheet_index.unwrap_or(own_sheet))?;
    let part = |row: u32, col: u32, rel_row: bool, rel_col: bool| {
        format!(
            "{}{}{}{}",
            if rel_col { "" } else { "$" },
            engine::index_to_col(col),
            if rel_row { "" } else { "$" },
            row + 1
        )
    };
    Some(format!(
        "={}!{}:{}",
        engine::ast_render::quote_sheet_name(name),
        part(*start_row, *start_col, relative.start_row, relative.start_col),
        part(*end_row, *end_col, relative.end_row, relative.end_col)
    ))
}

/// Read a [`relative_list_formula`] back into `source`'s rectangle and flags
/// (its sheet stays: no structural edit renumbers sheets). A formula that is
/// no longer a rectangle (`#REF!`) makes the source an EMPTY list, which
/// refuses every entry as Excel's `=#REF!` source does. Returns whether the
/// source changed.
pub(crate) fn set_relative_list_formula(source: &mut ListSource, formula: &str) -> bool {
    use engine::Expression as E;
    let ListSource::Range { start_row, start_col, end_row, end_col, relative, .. } = source else {
        return false;
    };
    let corner = |e: &E| -> Option<(u32, u32, bool, bool)> {
        match e {
            E::CellRef { col, row, col_absolute, row_absolute, .. } if *row > 0 => {
                Some((*row - 1, engine::col_to_index(col), !*row_absolute, !*col_absolute))
            }
            _ => None,
        }
    };
    let parsed = parser::parse(formula).ok().and_then(|ast| match ast {
        E::Range { start, end, .. } => Some((corner(&start)?, corner(&end)?)),
        E::CellRef { .. } => {
            let c = corner(&ast)?;
            Some((c, c))
        }
        _ => None,
    });
    match parsed {
        Some((a, b)) => {
            let next = (a.0, a.1, b.0, b.1, ListRelative { start_row: a.2, start_col: a.3, end_row: b.2, end_col: b.3 });
            let before = (*start_row, *start_col, *end_row, *end_col, *relative);
            if next == before {
                return false;
            }
            *start_row = next.0;
            *start_col = next.1;
            *end_row = next.2;
            *end_col = next.3;
            *relative = next.4;
            true
        }
        None => {
            *source = ListSource::Values(Vec::new());
            true
        }
    }
}

/// The formulas of a validation that move with its cells, written for its
/// top-left: a custom formula, and a RELATIVE list source as text
/// ([`relative_list_formula`]). Paired with [`set_validation_formulas`].
pub(crate) fn validation_formulas(validation: &DataValidation, own_sheet: usize, sheet_names: &[String]) -> Vec<String> {
    match &validation.rule {
        DataValidationRule::Custom(rule) => vec![rule.formula.clone()],
        DataValidationRule::List(list) => relative_list_formula(&list.source, own_sheet, sheet_names).into_iter().collect(),
        _ => Vec::new(),
    }
}

/// Write back what [`validation_formulas`] read (same order and length).
pub(crate) fn set_validation_formulas(validation: &mut DataValidation, formulas: &[String]) -> bool {
    let Some(first) = formulas.first() else { return false };
    match &mut validation.rule {
        DataValidationRule::Custom(rule) => {
            if rule.formula == *first {
                false
            } else {
                rule.formula = first.clone();
                true
            }
        }
        DataValidationRule::List(list) => set_relative_list_formula(&mut list.source, first),
        _ => false,
    }
}

/// A validation whose top-left moves from `from` to `to` without its cells
/// moving (a cut, a partial clear): every formula re-stated so each cell
/// keeps testing what it tested, wrapping at the sheet's edge (BUG-0747).
pub(crate) fn restate_validation(
    validation: &mut DataValidation,
    from: (u32, u32),
    to: (u32, u32),
    own_sheet: usize,
    sheet_names: &[String],
) -> bool {
    if from == to {
        return false;
    }
    let (drow, dcol) = (to.0 as i64 - from.0 as i64, to.1 as i64 - from.1 as i64);
    let moved: Vec<String> = validation_formulas(validation, own_sheet, sheet_names)
        .iter()
        .map(|f| crate::conditional_formatting::move_rule_formula_wrapping(f, drow, dcol))
        .collect();
    set_validation_formulas(validation, &moved)
}

/// Custom formula validation rule.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomRule {
    /// Formula that must evaluate to TRUE for valid data
    /// The formula is evaluated relative to the top-left cell of the validated range
    pub formula: String,
}

/// The complete validation rule (union of all rule types).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DataValidationRule {
    /// No rule
    None,
    /// Whole number validation
    WholeNumber(NumericRule),
    /// Decimal number validation
    Decimal(NumericRule),
    /// List/dropdown validation
    List(ListRule),
    /// Date validation
    Date(DateRule),
    /// Time validation
    Time(TimeRule),
    /// Text length validation
    TextLength(NumericRule),
    /// Custom formula validation
    Custom(CustomRule),
}

impl Default for DataValidationRule {
    fn default() -> Self {
        DataValidationRule::None
    }
}

// ============================================================================
// ERROR ALERT AND PROMPT
// ============================================================================

/// Error alert configuration shown when invalid data is entered.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DataValidationErrorAlert {
    /// Alert title
    pub title: String,
    /// Alert message
    pub message: String,
    /// Alert style (Stop, Warning, Information)
    pub style: DataValidationAlertStyle,
    /// Whether to show the alert (default true)
    pub show_alert: bool,
}

impl Default for DataValidationErrorAlert {
    fn default() -> Self {
        DataValidationErrorAlert {
            title: String::new(),
            message: String::new(),
            style: DataValidationAlertStyle::Stop,
            show_alert: true,
        }
    }
}

/// Input prompt shown when the cell is selected.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DataValidationPrompt {
    /// Prompt title
    pub title: String,
    /// Prompt message
    pub message: String,
    /// Whether to show the prompt (default true)
    pub show_prompt: bool,
}

impl Default for DataValidationPrompt {
    fn default() -> Self {
        DataValidationPrompt {
            title: String::new(),
            message: String::new(),
            show_prompt: true,
        }
    }
}

// ============================================================================
// DATA VALIDATION DEFINITION
// ============================================================================

/// Complete data validation definition for a cell or range.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DataValidation {
    /// The validation rule
    pub rule: DataValidationRule,
    /// Error alert configuration
    pub error_alert: DataValidationErrorAlert,
    /// Input prompt configuration
    pub prompt: DataValidationPrompt,
    /// Whether to allow blank cells (default true)
    pub ignore_blanks: bool,
}

impl Default for DataValidation {
    fn default() -> Self {
        DataValidation {
            rule: DataValidationRule::None,
            error_alert: DataValidationErrorAlert::default(),
            prompt: DataValidationPrompt::default(),
            ignore_blanks: true,
        }
    }
}

/// A cell range with its validation rule.
/// Stored per-sheet, keyed by the range coordinates.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ValidationRange {
    pub start_row: u32,
    pub start_col: u32,
    pub end_row: u32,
    pub end_col: u32,
    pub validation: DataValidation,
}

// ============================================================================
// RESULT TYPES
// ============================================================================

/// Result of a validation operation.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DataValidationResult {
    pub success: bool,
    pub validation: Option<DataValidation>,
    pub error: Option<String>,
}

/// Result of getting invalid cells.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InvalidCellsResult {
    /// List of invalid cell coordinates (row, col)
    pub cells: Vec<(u32, u32)>,
    /// Total count of invalid cells
    pub count: usize,
}

/// Result of validating a single cell value.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CellValidationResult {
    pub is_valid: bool,
    pub error_alert: Option<DataValidationErrorAlert>,
}

/// Parameters for setting validation on a range.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetValidationParams {
    pub start_row: u32,
    pub start_col: u32,
    pub end_row: u32,
    pub end_col: u32,
    pub validation: DataValidation,
}

// ============================================================================
// VALIDATION STORAGE
// ============================================================================

/// Storage for data validations per sheet.
/// Key is sheet index, value is a map of validation ranges.
pub type ValidationStorage = HashMap<usize, Vec<ValidationRange>>;

// ============================================================================
// VALIDATION LOGIC
// ============================================================================

/// Check if a numeric value satisfies a numeric rule.
fn check_numeric_rule(value: f64, rule: &NumericRule) -> bool {
    match rule.operator {
        DataValidationOperator::Between => {
            if let Some(f2) = rule.formula2 {
                let min = rule.formula1.min(f2);
                let max = rule.formula1.max(f2);
                value >= min && value <= max
            } else {
                false
            }
        }
        DataValidationOperator::NotBetween => {
            if let Some(f2) = rule.formula2 {
                let min = rule.formula1.min(f2);
                let max = rule.formula1.max(f2);
                value < min || value > max
            } else {
                true
            }
        }
        DataValidationOperator::Equal => (value - rule.formula1).abs() < f64::EPSILON,
        DataValidationOperator::NotEqual => (value - rule.formula1).abs() >= f64::EPSILON,
        DataValidationOperator::GreaterThan => value > rule.formula1,
        DataValidationOperator::LessThan => value < rule.formula1,
        DataValidationOperator::GreaterThanOrEqual => value >= rule.formula1,
        DataValidationOperator::LessThanOrEqual => value <= rule.formula1,
    }
}

/// Check if a value is a valid whole number (integer).
fn is_whole_number(value: f64) -> bool {
    value.fract() == 0.0 && value.is_finite()
}

/// Validate a cell value against a validation rule.
pub fn validate_cell_value(
    cell_value: &CellValue,
    validation: &DataValidation,
    list_resolver: Option<&dyn Fn(&ListSource) -> Vec<String>>,
    formula_evaluator: Option<&dyn Fn(&str) -> CellValue>,
) -> bool {
    // Handle blanks
    if matches!(cell_value, CellValue::Empty) {
        return validation.ignore_blanks;
    }

    match &validation.rule {
        DataValidationRule::None => true,

        DataValidationRule::WholeNumber(rule) => {
            if let CellValue::Number(n) = cell_value {
                is_whole_number(*n) && check_numeric_rule(*n, rule)
            } else {
                false
            }
        }

        DataValidationRule::Decimal(rule) => {
            if let CellValue::Number(n) = cell_value {
                check_numeric_rule(*n, rule)
            } else {
                false
            }
        }

        DataValidationRule::List(rule) => {
            let cell_text = match cell_value {
                CellValue::Text(s) => s.clone(),
                CellValue::Number(n) => crate::format_number_simple(*n),
                CellValue::Boolean(b) => if *b { "TRUE".to_string() } else { "FALSE".to_string() },
                _ => return false,
            };

            // Get the list values
            let values = match &rule.source {
                ListSource::Values(v) => v.clone(),
                ListSource::Range { .. } => {
                    if let Some(resolver) = list_resolver {
                        resolver(&rule.source)
                    } else {
                        return true; // Can't resolve range, assume valid
                    }
                }
            };

            // Case-insensitive comparison (Excel behavior)
            let cell_upper = cell_text.to_uppercase();
            values.iter().any(|v| v.to_uppercase() == cell_upper)
        }

        DataValidationRule::Date(rule) => {
            // Dates are stored as numbers (Excel serial date)
            if let CellValue::Number(n) = cell_value {
                check_numeric_rule(*n, &NumericRule {
                    formula1: rule.formula1,
                    formula2: rule.formula2,
                    operator: rule.operator,
                })
            } else {
                false
            }
        }

        DataValidationRule::Time(rule) => {
            // Times are stored as fractional numbers (0.0 to 1.0)
            if let CellValue::Number(n) = cell_value {
                let time_part = n.fract();
                check_numeric_rule(time_part, &NumericRule {
                    formula1: rule.formula1,
                    formula2: rule.formula2,
                    operator: rule.operator,
                })
            } else {
                false
            }
        }

        DataValidationRule::TextLength(rule) => {
            let length = match cell_value {
                CellValue::Text(s) => s.len() as f64,
                CellValue::Number(n) => crate::format_number_simple(*n).len() as f64,
                CellValue::Boolean(b) => if *b { 4.0 } else { 5.0 }, // "TRUE" or "FALSE"
                _ => return false,
            };
            check_numeric_rule(length, rule)
        }

        DataValidationRule::Custom(rule) => {
            if let Some(evaluator) = formula_evaluator {
                let result = evaluator(&rule.formula);
                match result {
                    CellValue::Number(n) => n != 0.0,
                    CellValue::Boolean(b) => b,
                    _ => false,
                }
            } else {
                // No evaluator available - assume valid
                true
            }
        }
    }
}

/// The validation RANGE a cell belongs to (its rule and the top-left its
/// custom formula is written for).
pub(crate) fn get_validation_range_for_cell(
    validations: &[ValidationRange],
    row: u32,
    col: u32,
) -> Option<&ValidationRange> {
    validations
        .iter()
        .find(|vr| row >= vr.start_row && row <= vr.end_row && col >= vr.start_col && col <= vr.end_col)
}

/// A CUSTOM validation formula's value at (`row`, `col`): the formula is its
/// range's top-left cell's, and this cell reads it moved by its own offset
/// (NEW-cf-relative-eval). [LIVE, Excel 16, cfeval/probe1.ps1 P11] `=B1>A1` on
/// B1:B3 holds B2 valid against A2 and B3 invalid against A3.
fn custom_formula_value(
    formulas: &crate::conditional_formatting::RuleFormulas,
    vr: &ValidationRange,
    formula: &str,
    row: u32,
    col: u32,
) -> CellValue {
    formulas.value_at(formula, (vr.start_row, vr.start_col), row, col)
}

/// Get the validation rule for a specific cell.
pub fn get_validation_for_cell(
    validations: &[ValidationRange],
    row: u32,
    col: u32,
) -> Option<&DataValidation> {
    for vr in validations {
        if row >= vr.start_row && row <= vr.end_row && col >= vr.start_col && col <= vr.end_col {
            return Some(&vr.validation);
        }
    }
    None
}

/// Resolve list values from a range source, AT the validated cell (`row`,
/// `col`) of a range whose top-left is `anchor`: a relative source is read
/// moved by the cell's offset (BUG-0745, [`list_rect_at`]), and a source on a
/// deleted sheet holds no values (BUG-0750). The dropdown and the entry check
/// both read through here.
pub fn resolve_list_source(
    source: &ListSource,
    grids: &[Grid],
    _sheet_names: &[String],
    current_sheet: usize,
    anchor: (u32, u32),
    row: u32,
    col: u32,
) -> Vec<String> {
    match source {
        ListSource::Values(v) => v.clone(),
        ListSource::Range { .. } => list_source_cells(source, grids, current_sheet, anchor, row, col)
            .into_iter()
            .filter_map(list_compare_text)
            .collect(),
    }
}

/// A list item's COMPARISON text: invariant, as `validate_cell_value` spells
/// the entry. `None` for a cell that offers nothing (empty, an error, an
/// array).
fn list_compare_text(value: &CellValue) -> Option<String> {
    let text = match value {
        CellValue::Text(s) => s.clone(),
        CellValue::Number(n) => crate::format_number_simple(*n),
        CellValue::Boolean(b) => if *b { "TRUE".to_string() } else { "FALSE".to_string() },
        CellValue::Empty | CellValue::Error(_) | CellValue::List(_) | CellValue::Dict(_) => return None,
    };
    (!text.is_empty()).then_some(text)
}

/// The DROPDOWN's items at a cell: the values [`resolve_list_source`]
/// compares, as the user reads them -- a number in the APP locale ("1,5"
/// under sv-SE), so the item picked is entered as the number it shows
/// (verify-cfdvb new defect: the dropdown showed the invariant "1.5", which
/// an sv-SE entry reads as text).
pub(crate) fn resolve_list_display(
    source: &ListSource,
    grids: &[Grid],
    current_sheet: usize,
    anchor: (u32, u32),
    row: u32,
    col: u32,
    locale: &engine::LocaleSettings,
) -> Vec<String> {
    match source {
        ListSource::Values(v) => v.clone(),
        ListSource::Range { .. } => list_source_cells(source, grids, current_sheet, anchor, row, col)
            .into_iter()
            .filter(|v| list_compare_text(v).is_some())
            .map(|v| crate::format_cell_value_display(v, locale))
            .collect(),
    }
}

/// The values a range list source names at a cell, row by row. The work is
/// bounded by the cells the source sheet HOLDS, never by the rectangle's
/// area: a source with mixed `$` anchors (`=$F1:F$2`) grows with each cell's
/// offset, past the 10,000 cells the dialog allows for its first cell
/// (verify-cfdvb finding 5), and a rectangle larger than the sheet's filled
/// cells is read from those cells.
fn list_source_cells<'g>(
    source: &ListSource,
    grids: &'g [Grid],
    current_sheet: usize,
    anchor: (u32, u32),
    row: u32,
    col: u32,
) -> Vec<&'g CellValue> {
    let Some((sheet_index, min_row, min_col, max_row, max_col)) = list_rect_at(source, anchor, row, col) else {
        return Vec::new();
    };
    let Some(grid) = grids.get(sheet_index.unwrap_or(current_sheet)) else {
        return Vec::new();
    };
    let area = (max_row - min_row + 1) as u64 * (max_col - min_col + 1) as u64;
    if area <= grid.cells.len() as u64 {
        let mut out = Vec::new();
        for r in min_row..=max_row {
            for c in min_col..=max_col {
                if let Some(cell) = grid.cells.get(&(r, c)) {
                    out.push(&cell.value);
                }
            }
        }
        return out;
    }
    let mut held: Vec<(&(u32, u32), &'g CellValue)> = grid
        .cells
        .iter()
        .filter(|((r, c), _)| *r >= min_row && *r <= max_row && *c >= min_col && *c <= max_col)
        .map(|(k, cell)| (k, &cell.value))
        .collect();
    held.sort_unstable_by_key(|(k, _)| **k);
    held.into_iter().map(|(_, v)| v).collect()
}

/// Circle Invalid Data's list membership over one pass: every filled cell of
/// a source sheet indexed once by its comparison text, so each validated
/// cell's own rectangle (a relative source moves, a mixed one grows) is a
/// few binary searches, not a walk of the rectangle (verify-cfdvb finding 5:
/// `=$F1:F$2` on 20,000 cells walked about 200 million cells).
#[derive(Default)]
struct ListMembership {
    /// sheet -> upper-cased text -> its cells, sorted by (col, row).
    sheets: HashMap<usize, HashMap<String, Vec<(u32, u32)>>>,
}

impl ListMembership {
    /// Whether the list `source` names AT (`row`, `col`) holds `text`
    /// (case-insensitive, as `validate_cell_value` compares).
    fn contains(
        &mut self,
        grids: &[Grid],
        source: &ListSource,
        current_sheet: usize,
        anchor: (u32, u32),
        row: u32,
        col: u32,
        text: &str,
    ) -> bool {
        let Some((sheet_index, r0, c0, r1, c1)) = list_rect_at(source, anchor, row, col) else {
            return false;
        };
        let sheet = sheet_index.unwrap_or(current_sheet);
        let Some(grid) = grids.get(sheet) else { return false };
        let index = self.sheets.entry(sheet).or_insert_with(|| {
            let mut index: HashMap<String, Vec<(u32, u32)>> = HashMap::new();
            for (&(r, c), cell) in grid.cells.iter() {
                if let Some(t) = list_compare_text(&cell.value) {
                    index.entry(t.to_uppercase()).or_default().push((c, r));
                }
            }
            for cells in index.values_mut() {
                cells.sort_unstable();
            }
            index
        });
        let Some(cells) = index.get(&text.to_uppercase()) else { return false };
        let mut at = cells.partition_point(|&p| p < (c0, r0));
        while let Some(&(c, r)) = cells.get(at) {
            if c > c1 {
                return false;
            }
            if r >= r0 && r <= r1 {
                return true;
            }
            // Past this column's rows (or before them): the next column.
            let next = if r < r0 { (c, r0) } else { (c + 1, r0) };
            at = cells.partition_point(|&p| p < next);
        }
        false
    }
}

// ============================================================================
// TAURI COMMANDS
// ============================================================================

/// Resolve an optional 0-based sheet index: None = the active sheet, Some(i)
/// must be in range. The validation storage is a HashMap keyed by sheet index,
/// so without this an out-of-range index would silently create a phantom
/// sheet's rule list instead of erroring.
fn resolve_validation_sheet(state: &AppState, sheet_index: Option<usize>) -> Result<usize, String> {
    let active = *state.active_sheet.read().unwrap();
    match sheet_index {
        None => Ok(active),
        Some(idx) => {
            let count = state.sheet_names.read().unwrap().len();
            if idx < count {
                Ok(idx)
            } else {
                Err(format!(
                    "Sheet index {} out of range: workbook has {} sheet(s)",
                    idx, count
                ))
            }
        }
    }
}

/// Set data validation on a range (on the active sheet, or `sheet_index`).
#[tauri::command]
pub fn set_data_validation(
    state: State<AppState>,
    file_state: State<FileState>,
    start_row: u32,
    start_col: u32,
    end_row: u32,
    end_col: u32,
    validation: DataValidation,
    sheet_index: Option<usize>,
) -> DataValidationResult {
    set_data_validation_impl(&state, &file_state, start_row, start_col, end_row, end_col, validation, sheet_index)
}

/// What a data validation naming a structured reference is refused with
/// (NEW-cfdv-structured-refs). The refusal is [LIVE, Excel 16, 2026-11-05,
/// cfdv/probe1.ps1 C21/C22]: `Validation.Add` refuses a custom formula
/// `=T1[@A]>1` or `=SUM(T1[A])>0` and a list source `=T1[A]` while it accepts
/// `=SUM($A$2:$A$3)>0`. COM reports only 0x800A03EC, so the sentence is
/// Excel's dialog text for a reference a rule cannot hold, not a measured
/// string. (A list source never reaches here as text: the dialog resolves it
/// to a range or refuses it first, `listSourceRef.ts`.)
pub(crate) const DV_STRUCTURED_REFERENCE_REFUSAL: &str =
    "This type of reference cannot be used in a Data Validation formula. \
     Change the reference to a single cell, or use the reference with a worksheet function, such as =SUM(A1:E5).";

/// The entry refusal for a validation, before any lock or effect.
pub(crate) fn validation_entry_refusal(validation: &DataValidation) -> Option<String> {
    match &validation.rule {
        DataValidationRule::Custom(rule)
            if crate::conditional_formatting::formula_names_structured_reference(&rule.formula) =>
        {
            Some(DV_STRUCTURED_REFERENCE_REFUSAL.to_string())
        }
        _ => None,
    }
}

/// A validation through a structural edit (NEW-cfdv-structural-shift; the
/// Excel rule is stated at `conditional_formatting::rebase_rule_formula`).
///
/// * A CUSTOM formula is its range's top-left cell's formula: on the edited
///   sheet it is re-stated from `new_anchor` (the piece's top-left after the
///   edit); on any other sheet only references qualified with the edited
///   sheet move. [LIVE, cfdv/probe1.ps1 V5/V11] `=H2>$D$1` on H2:H10: insert
///   row 1 -> `=H3>$D$2`, delete row 1 -> `=H1>#REF!`.
/// * A LIST source is a rectangle on a sheet (`sheet_index`, `None` = the
///   validation's own) and moves as a reference to it does -- [LIVE, V1-V9]
///   `=$F$1:$F$5`: insert row 1 -> `$F$2:$F$6`, insert column F ->
///   `$G$1:$G$5`, delete row 3 -> `$F$1:$F$4`, Insert Cells F1 down ->
///   `$F$2:$F$6`, `=Other!$A$1:$A$3` follows a row inserted on Other; when
///   every cell of it is deleted Excel's source reads `=#REF!`, which refuses
///   every entry -- here an EMPTY list, the rule `sheets::remap_list_sources`
///   already uses for a source whose sheet is gone.
///
/// Returns whether anything changed.
#[allow(clippy::too_many_arguments)]
pub(crate) fn rebase_validation_formulas(
    validation: &mut DataValidation,
    own_sheet: usize,
    edited_sheet: usize,
    old_anchor: (u32, u32),
    new_anchor: (u32, u32),
    formula_sheet: &str,
    edited_sheet_name: &str,
    sheet_names: &[String],
    band: &crate::commands::structure::structure_cells::BandEdit,
) -> bool {
    // A RELATIVE list source (BUG-0745) moves as the formula text it is:
    // the same re-statement a custom formula gets ([LIVE] cfdvb/probe1.ps1
    // C5: `=F1:F2` on H2:H4, insert row 1 -> `=F2:F3` at H3).
    if let DataValidationRule::List(list) = &mut validation.rule {
        if let Some(text) = relative_list_formula(&list.source, own_sheet, sheet_names) {
            let next = if own_sheet == edited_sheet {
                crate::conditional_formatting::rebase_rule_formula(
                    &text, old_anchor, new_anchor, formula_sheet, edited_sheet_name, band,
                )
            } else {
                crate::conditional_formatting::shift_rule_formula(&text, formula_sheet, edited_sheet_name, band)
            };
            return next != text && set_relative_list_formula(&mut list.source, &next);
        }
    }
    match &mut validation.rule {
        DataValidationRule::Custom(rule) => {
            let next = if own_sheet == edited_sheet {
                crate::conditional_formatting::rebase_rule_formula(
                    &rule.formula, old_anchor, new_anchor, formula_sheet, edited_sheet_name, band,
                )
            } else {
                crate::conditional_formatting::shift_rule_formula(&rule.formula, formula_sheet, edited_sheet_name, band)
            };
            if next != rule.formula {
                rule.formula = next;
                return true;
            }
            false
        }
        DataValidationRule::List(list) => {
            let ListSource::Range { sheet_index, start_row, start_col, end_row, end_col, sheet_gone, .. } = &mut list.source else {
                return false;
            };
            if *sheet_gone || sheet_index.unwrap_or(own_sheet) != edited_sheet {
                return false;
            }
            let rect = crate::commands::coord_shift::CellRange {
                start_row: *start_row,
                end_row: *end_row,
                start_col: *start_col,
                end_col: *end_col,
            };
            match band.shift_reference_range(rect) {
                Some(moved) if moved == rect => false,
                Some(moved) => {
                    *start_row = moved.start_row;
                    *end_row = moved.end_row;
                    *start_col = moved.start_col;
                    *end_col = moved.end_col;
                    true
                }
                None => {
                    list.source = ListSource::Values(Vec::new());
                    true
                }
            }
        }
        DataValidationRule::None
        | DataValidationRule::WholeNumber(_)
        | DataValidationRule::Decimal(_)
        | DataValidationRule::Date(_)
        | DataValidationRule::Time(_)
        | DataValidationRule::TextLength(_) => false,
    }
}

/// Command body over plain references, so the entry refusal's clean document
/// is unit-testable without a Tauri `State`.
#[allow(clippy::too_many_arguments)]
pub(crate) fn set_data_validation_impl(
    state: &AppState,
    file_state: &FileState,
    start_row: u32,
    start_col: u32,
    end_row: u32,
    end_col: u32,
    validation: DataValidation,
    sheet_index: Option<usize>,
) -> DataValidationResult {
    if let Some(refusal) = validation_entry_refusal(&validation) {
        return DataValidationResult { success: false, validation: None, error: Some(refusal) };
    }
    let target_sheet = match resolve_validation_sheet(state, sheet_index) {
        Ok(idx) => idx,
        Err(e) => {
            return DataValidationResult { success: false, validation: None, error: Some(e) }
        }
    };
    // The sheet names a relative list source is re-stated with, taken and
    // released before the validation store.
    let sheet_names = state.sheet_names.read().map(|n| (*n).clone()).unwrap_or_default();
    // Validation rules are persisted (`workbook.data_validations`) and written
    // only by the save path.
    let effect = DocumentEffect::mutates(file_state);
    let mut validations = state.data_validations.write(&effect).unwrap();

    let sheet_validations = validations.entry(target_sheet).or_insert_with(Vec::new);

    // Pre-mutation snapshot for undo (BUG-0008: validation changes bypassed
    // the undo system).
    let previous = sheet_validations.clone();

    // Normalize coordinates
    let min_row = start_row.min(end_row);
    let max_row = start_row.max(end_row);
    let min_col = start_col.min(end_col);
    let max_col = start_col.max(end_col);

    // The new rule REPLACES the old ones over its cells: every validation it
    // overlaps is cut, and what is left keeps its rule (BUG-0747).
    cut_validations(sheet_validations, (min_row, min_col, max_row, max_col), target_sheet, &sheet_names);

    // Add the new validation range
    let vr = ValidationRange {
        start_row: min_row,
        start_col: min_col,
        end_row: max_row,
        end_col: max_col,
        validation: validation.clone(),
    };
    sheet_validations.push(vr);
    drop(validations);

    crate::undo_commands::record_validation_undo(
        &state,
        target_sheet,
        previous,
        "Set data validation",
    );

    DataValidationResult {
        success: true,
        validation: Some(validation),
        error: None,
    }
}

/// Clear data validation from a range (on the active sheet, or `sheet_index`).
#[tauri::command]
pub fn clear_data_validation(
    state: State<AppState>,
    file_state: State<FileState>,
    start_row: u32,
    start_col: u32,
    end_row: u32,
    end_col: u32,
    sheet_index: Option<usize>,
) -> DataValidationResult {
    clear_data_validation_impl(&state, &file_state, start_row, start_col, end_row, end_col, sheet_index)
}

/// `range` minus `cut` (both `(start_row, start_col, end_row, end_col)`), as
/// at most four rectangles: the full-width bands above and below the cut,
/// then the parts left and right of it within the cut's rows.
fn subtract_rect(range: (u32, u32, u32, u32), cut: (u32, u32, u32, u32)) -> Vec<(u32, u32, u32, u32)> {
    let (r0, c0, r1, c1) = range;
    let (k0, l0, k1, l1) = cut;
    if k0 > r1 || k1 < r0 || l0 > c1 || l1 < c0 {
        return vec![range];
    }
    let mut out = Vec::with_capacity(4);
    if k0 > r0 {
        out.push((r0, c0, k0 - 1, c1));
    }
    if k1 < r1 {
        out.push((k1 + 1, c0, r1, c1));
    }
    let (m0, m1) = (r0.max(k0), r1.min(k1));
    if l0 > c0 {
        out.push((m0, c0, m1, l0 - 1));
    }
    if l1 < c1 {
        out.push((m0, l1 + 1, m1, c1));
    }
    out
}

/// Take `cut` out of every validation in `ranges` it overlaps, as Excel
/// does when a range is set or cleared over part of an older rule
/// (BUG-0747): [LIVE, Excel 16, 2026-11-06, cfdvb/probe1.ps1 E1-E5] a whole
/// number rule on A1:A10 with a list set on A3:A4 keeps A1:A2 and A5:A10
/// whole-number; clearing C1:C2 of `=C1>0` on C1:C10 leaves C3 testing
/// `=C3>0`, and clearing the middle (C5:C6, or E2 of D1:F3) leaves every
/// other cell testing its own cell. Each piece is a validated range of its
/// own, its formulas re-stated for its top-left ([`restate_validation`]).
/// Returns whether anything changed.
pub(crate) fn cut_validations(
    ranges: &mut Vec<ValidationRange>,
    cut: (u32, u32, u32, u32),
    own_sheet: usize,
    sheet_names: &[String],
) -> bool {
    let mut changed = false;
    let mut next: Vec<ValidationRange> = Vec::with_capacity(ranges.len());
    for vr in ranges.drain(..) {
        let rect = (vr.start_row, vr.start_col, vr.end_row, vr.end_col);
        let pieces = subtract_rect(rect, cut);
        if pieces.len() == 1 && pieces[0] == rect {
            next.push(vr);
            continue;
        }
        changed = true;
        for (r0, c0, r1, c1) in pieces {
            let mut piece = vr.clone();
            restate_validation(&mut piece.validation, (vr.start_row, vr.start_col), (r0, c0), own_sheet, sheet_names);
            piece.start_row = r0;
            piece.start_col = c0;
            piece.end_row = r1;
            piece.end_col = c1;
            next.push(piece);
        }
    }
    *ranges = next;
    changed
}

/// [`clear_data_validation`] over plain references. A clear that touches
/// no validation leaves the document clean and records nothing.
#[allow(clippy::too_many_arguments)]
pub(crate) fn clear_data_validation_impl(
    state: &AppState,
    file_state: &FileState,
    start_row: u32,
    start_col: u32,
    end_row: u32,
    end_col: u32,
    sheet_index: Option<usize>,
) -> DataValidationResult {
    let target_sheet = match resolve_validation_sheet(state, sheet_index) {
        Ok(idx) => idx,
        Err(e) => {
            return DataValidationResult { success: false, validation: None, error: Some(e) }
        }
    };
    let sheet_names = state.sheet_names.read().map(|n| (*n).clone()).unwrap_or_default();
    let cut = (start_row.min(end_row), start_col.min(end_col), start_row.max(end_row), start_col.max(end_col));
    // The cut decided in the same critical section as the write, and the
    // effect only when it changes something.
    let pending = state.data_validations.lock_pending().unwrap();
    let Some(current) = pending.get(&target_sheet) else {
        return DataValidationResult { success: true, validation: None, error: None };
    };
    let previous = current.clone();
    let mut next = previous.clone();
    if !cut_validations(&mut next, cut, target_sheet, &sheet_names) {
        return DataValidationResult { success: true, validation: None, error: None };
    }
    // Validation rules are persisted (`workbook.data_validations`) and written
    // only by the save path.
    let effect = DocumentEffect::mutates(file_state);
    let mut validations = pending.authorize(&effect);
    validations.insert(target_sheet, next);
    drop(validations);

    crate::undo_commands::record_validation_undo(state, target_sheet, previous, "Clear data validation");

    DataValidationResult {
        success: true,
        validation: None,
        error: None,
    }
}

/// Get data validation for a specific cell (on the active sheet, or `sheet_index`).
#[tauri::command]
pub fn get_data_validation(
    state: State<AppState>,
    row: u32,
    col: u32,
    sheet_index: Option<usize>,
) -> Option<DataValidation> {
    let target_sheet = resolve_validation_sheet(&state, sheet_index).ok()?;
    let validations = state.data_validations.read().unwrap();

    if let Some(sheet_validations) = validations.get(&target_sheet) {
        if let Some(validation) = get_validation_for_cell(sheet_validations, row, col) {
            return Some(validation.clone());
        }
    }

    None
}

/// Get all validation ranges for a sheet (the active sheet, or `sheet_index`).
#[tauri::command]
pub fn get_all_data_validations(
    state: State<AppState>,
    sheet_index: Option<usize>,
) -> Result<Vec<ValidationRange>, String> {
    let target_sheet = resolve_validation_sheet(&state, sheet_index)?;
    let validations = state.data_validations.read().unwrap();

    Ok(validations.get(&target_sheet).cloned().unwrap_or_default())
}

/// Validate a cell value against its validation rule.
#[tauri::command]
pub fn validate_cell(
    state: State<AppState>,
    row: u32,
    col: u32,
) -> CellValidationResult {
    // TRANSIENT: validation answers "may this value go in", it never writes a
    // cell, and it runs on every keystroke in the editor — the one place a
    // four-second formula would read as a frozen keyboard.
    let _governor = crate::eval_budget::install(crate::eval_budget::EvalSurface::Transient);
    let active_sheet = *state.active_sheet.read().unwrap();
    // Defined names and tables a formula may read, snapshotted BEFORE the grid
    // guards; a spill reference reads the live map (BUG-0748).
    let names = crate::conditional_formatting::snapshot_rule_names(&state);
    // CANONICAL LOCK ORDER: `grids` first, then everything else. The
    // recalculation pass holds both grid locks and then takes `sheet_names`,
    // and it runs on a background thread, so a reader that holds any other
    // store and then waits for `grids` closes a cycle that hangs the app.
    let grids = state.grids.read().unwrap();
    let sheet_names = state.sheet_names.read().unwrap();
    let validations = state.data_validations.read().unwrap();

    // Get the validation range for this cell
    let vr = if let Some(sheet_validations) = validations.get(&active_sheet) {
        get_validation_range_for_cell(sheet_validations, row, col).cloned()
    } else {
        None
    };

    let vr = match vr {
        Some(v) => v,
        None => {
            return CellValidationResult {
                is_valid: true,
                error_alert: None,
            };
        }
    };
    let validation = vr.validation.clone();

    // Get the cell value
    let cell_value = if active_sheet < grids.len() {
        grids[active_sheet]
            .cells
            .get(&(row, col))
            .map(|c| c.value.clone())
            .unwrap_or(CellValue::Empty)
    } else {
        CellValue::Empty
    };

    // Create a resolver for list sources, read AT this cell (BUG-0745).
    let grids_ref = &grids;
    let sheet_names_ref = &sheet_names;
    let anchor = (vr.start_row, vr.start_col);
    let resolver = |source: &ListSource| -> Vec<String> {
        resolve_list_source(source, grids_ref, sheet_names_ref, active_sheet, anchor, row, col)
    };

    // Create a formula evaluator for custom validation: relative to the
    // range's top-left (NEW-cf-relative-eval).
    let formulas = crate::conditional_formatting::RuleFormulas::resolved(
        grids_ref, sheet_names_ref, active_sheet, names.tables(sheet_names_ref),
    );
    let formula_eval = |formula: &str| -> CellValue { custom_formula_value(&formulas, &vr, formula, row, col) };

    let is_valid = validate_cell_value(&cell_value, &validation, Some(&resolver), Some(&formula_eval));

    CellValidationResult {
        is_valid,
        error_alert: if !is_valid && validation.error_alert.show_alert {
            Some(validation.error_alert.clone())
        } else {
            None
        },
    }
}

/// Get the input prompt for a cell (if any).
#[tauri::command]
pub fn get_validation_prompt(
    state: State<AppState>,
    row: u32,
    col: u32,
) -> Option<DataValidationPrompt> {
    let active_sheet = *state.active_sheet.read().unwrap();
    let validations = state.data_validations.read().unwrap();

    if let Some(sheet_validations) = validations.get(&active_sheet) {
        if let Some(validation) = get_validation_for_cell(sheet_validations, row, col) {
            if validation.prompt.show_prompt
               && (!validation.prompt.title.is_empty() || !validation.prompt.message.is_empty()) {
                return Some(validation.prompt.clone());
            }
        }
    }

    None
}

/// Get all invalid cells in the current sheet.
#[tauri::command]
pub fn get_invalid_cells(
    state: State<AppState>,
) -> InvalidCellsResult {
    get_invalid_cells_on(&state)
}

/// [`get_invalid_cells`] over a plain reference (tests drive the real body).
pub(crate) fn get_invalid_cells_on(state: &AppState) -> InvalidCellsResult {
    let _governor = crate::eval_budget::install(crate::eval_budget::EvalSurface::Transient);
    let active_sheet = *state.active_sheet.read().unwrap();
    // Defined names and tables a formula may read, snapshotted BEFORE the grid
    // guards; a spill reference reads the live map (BUG-0748).
    let names = crate::conditional_formatting::snapshot_rule_names(&state);
    // CANONICAL LOCK ORDER: `grids` first, then everything else. The
    // recalculation pass holds both grid locks and then takes `sheet_names`,
    // and it runs on a background thread, so a reader that holds any other
    // store and then waits for `grids` closes a cycle that hangs the app.
    let grids = state.grids.read().unwrap();
    let sheet_names = state.sheet_names.read().unwrap();
    let validations = state.data_validations.read().unwrap();

    let mut invalid_cells = Vec::new();

    if let Some(sheet_validations) = validations.get(&active_sheet) {
        if active_sheet < grids.len() {
            let grid = &grids[active_sheet];

            let grids_ref = &grids;
            let sheet_names_ref = &sheet_names;

            // One formula cache for the whole pass: a custom formula is parsed
            // once, then evaluated per cell relative to its range's top-left
            // (NEW-cf-relative-eval).
            let formulas = crate::conditional_formatting::RuleFormulas::resolved(
                grids_ref, sheet_names_ref, active_sheet, names.tables(sheet_names_ref),
            );

            // A range list source is answered from one index per pass.
            let mut membership = ListMembership::default();

            // Check each validation range
            for vr in sheet_validations {
                for row in vr.start_row..=vr.end_row {
                    for col in vr.start_col..=vr.end_col {
                        let cell_value = grid
                            .cells
                            .get(&(row, col))
                            .map(|c| c.value.clone())
                            .unwrap_or(CellValue::Empty);
                        if let DataValidationRule::List(ListRule { source: source @ ListSource::Range { .. }, .. }) =
                            &vr.validation.rule
                        {
                            // The same answer `validate_cell_value` gives, by
                            // the index: a blank by Ignore Blank, an error or
                            // an array never, a value when the list holds it.
                            let valid = match &cell_value {
                                CellValue::Empty => vr.validation.ignore_blanks,
                                CellValue::Text(_) | CellValue::Number(_) | CellValue::Boolean(_) => {
                                    let text = list_compare_text(&cell_value).unwrap_or_default();
                                    membership.contains(
                                        grids_ref,
                                        source,
                                        active_sheet,
                                        (vr.start_row, vr.start_col),
                                        row,
                                        col,
                                        &text,
                                    )
                                }
                                _ => false,
                            };
                            if !valid {
                                invalid_cells.push((row, col));
                            }
                            continue;
                        }
                        let formula_eval =
                            |formula: &str| -> CellValue { custom_formula_value(&formulas, vr, formula, row, col) };
                        // A list source read AT this cell (BUG-0745).
                        let resolver = |source: &ListSource| -> Vec<String> {
                            resolve_list_source(source, grids_ref, sheet_names_ref, active_sheet, (vr.start_row, vr.start_col), row, col)
                        };

                        if !validate_cell_value(&cell_value, &vr.validation, Some(&resolver), Some(&formula_eval)) {
                            invalid_cells.push((row, col));
                        }
                    }
                }
            }
        }
    }

    let count = invalid_cells.len();
    InvalidCellsResult {
        cells: invalid_cells,
        count,
    }
}

/// Get dropdown list values for a cell with list validation.
#[tauri::command]
pub fn get_validation_list_values(
    state: State<AppState>,
    row: u32,
    col: u32,
) -> Option<Vec<String>> {
    get_validation_list_values_on(&state, row, col)
}

/// [`get_validation_list_values`] over a plain reference (tests drive the
/// real body).
pub(crate) fn get_validation_list_values_on(state: &AppState, row: u32, col: u32) -> Option<Vec<String>> {
    let active_sheet = *state.active_sheet.read().unwrap();
    // The items are SHOWN, so they read in the app locale (leaf lock: take,
    // clone, drop -- before the grids).
    let locale = state.locale.lock().unwrap().clone();
    // CANONICAL LOCK ORDER: `grids` first, then everything else. The
    // recalculation pass holds both grid locks and then takes `sheet_names`,
    // and it runs on a background thread, so a reader that holds any other
    // store and then waits for `grids` closes a cycle that hangs the app.
    let grids = state.grids.read().unwrap();
    let validations = state.data_validations.read().unwrap();

    if let Some(sheet_validations) = validations.get(&active_sheet) {
        if let Some(vr) = get_validation_range_for_cell(sheet_validations, row, col) {
            if let DataValidationRule::List(list_rule) = &vr.validation.rule {
                // The dropdown lists what THIS cell's source names (BUG-0745).
                let values = resolve_list_display(
                    &list_rule.source,
                    &grids,
                    active_sheet,
                    (vr.start_row, vr.start_col),
                    row,
                    col,
                    &locale,
                );
                return Some(values);
            }
        }
    }

    None
}

/// Check if a cell has an in-cell dropdown.
#[tauri::command]
pub fn has_in_cell_dropdown(
    state: State<AppState>,
    row: u32,
    col: u32,
) -> bool {
    let active_sheet = *state.active_sheet.read().unwrap();
    let validations = state.data_validations.read().unwrap();

    if let Some(sheet_validations) = validations.get(&active_sheet) {
        if let Some(validation) = get_validation_for_cell(sheet_validations, row, col) {
            if let DataValidationRule::List(list_rule) = &validation.rule {
                return list_rule.in_cell_dropdown;
            }
        }
    }

    false
}

/// Validate a pending (not yet committed) value against a cell's validation rule.
/// This is used by the commit guard system to validate before writing to the grid.
#[tauri::command]
pub fn validate_pending_value(
    state: State<AppState>,
    row: u32,
    col: u32,
    pending_value: String,
) -> CellValidationResult {
    validate_pending_value_on(&state, row, col, pending_value)
}

/// The most dependent cells a pending entry's check re-evaluates; past it
/// the dependents keep their committed values (the check runs on Enter, and
/// a sheet whose every cell follows the entry is not re-calculated for it).
const PENDING_DEPENDENTS_LIMIT: usize = 10_000;

/// [`validate_pending_value`] over a plain reference (tests drive the real
/// body).
///
/// THE ENTRY IS WHAT IS JUDGED (BUG-0746). The value is read by the same
/// typed-entry ladder a commit uses (`engine::typed_entry`, in the app locale
/// and the format the cell would land in), and a CUSTOM formula is evaluated
/// over the sheet AS IT WOULD BE: the active grid with the pending value in
/// the cell, so `=H2>5`, `=SUM($B$2:$B$10)<=100` and a name naming the cell
/// all read the entry rather than the value it replaces. Calcula read the
/// cell's OLD value, so a rule refused a valid entry and passed an invalid
/// one whenever the old value said otherwise. The cells on the sheet that
/// depend on the entry are re-evaluated over that grid first (up to
/// [`PENDING_DEPENDENTS_LIMIT`] of them), as Excel calculates before it
/// judges.
pub(crate) fn validate_pending_value_on(
    state: &AppState,
    row: u32,
    col: u32,
    pending_value: String,
) -> CellValidationResult {
    let _governor = crate::eval_budget::install(crate::eval_budget::EvalSurface::Transient);
    let active_sheet = *state.active_sheet.read().unwrap();
    // Defined names and tables a formula may read, snapshotted BEFORE the grid
    // guards; a spill reference reads the live map (BUG-0748).
    let names = crate::conditional_formatting::snapshot_rule_names(state);
    let locale = state.locale.lock().unwrap().clone();
    // CANONICAL LOCK ORDER: `grids` first, then everything else. The
    // recalculation pass holds both grid locks and then takes `sheet_names`,
    // and it runs on a background thread, so a reader that holds any other
    // store and then waits for `grids` closes a cycle that hangs the app.
    let grids = state.grids.read().unwrap();
    let sheet_names = state.sheet_names.read().unwrap();
    let validations = state.data_validations.read().unwrap();

    // Get the validation range for this cell
    let vr = if let Some(sheet_validations) = validations.get(&active_sheet) {
        get_validation_range_for_cell(sheet_validations, row, col).cloned()
    } else {
        None
    };
    drop(validations);

    let vr = match vr {
        Some(v) => v,
        None => {
            return CellValidationResult {
                is_valid: true,
                error_alert: None,
            };
        }
    };
    let validation = vr.validation.clone();
    let Some(grid) = grids.get(active_sheet) else {
        return CellValidationResult { is_valid: true, error_alert: None };
    };

    // The pending text as the commit would store it.
    let entered = if pending_value.is_empty() {
        engine::Cell::new()
    } else {
        let target_format = match state.style_registry.read() {
            Ok(styles) => engine::typed_entry::entry_format_at(grid, &styles, row, col),
            Err(_) => engine::NumberFormat::General,
        };
        engine::typed_entry::parse_cell_input_in_format(&pending_value, &locale, Some(&target_format)).0
    };
    // A FORMULA entry is judged by its value (cfdvfix, [LIVE] Excel 16,
    // 2026-11-06, cfdvfix/probe7.ps1): Whole Number 1..3 refuses `=5` and
    // takes `=1+1`; Custom `=D1>5` refuses `=3` and takes `=9`. The formula is
    // evaluated at the cell over the sheet as it is (Calcula assumed every
    // formula valid).
    let cell_value = match &entered.ast {
        Some(ast) => crate::conditional_formatting::RuleFormulas::resolved(
            &grids,
            &sheet_names,
            active_sheet,
            names.tables(&sheet_names),
        )
        .value_of_cell_formula(ast, row, col),
        None => entered.value.clone(),
    };

    // Create a resolver for list sources, read AT this cell (BUG-0745).
    let grids_ref = &grids;
    let sheet_names_ref = &sheet_names;
    let anchor = (vr.start_row, vr.start_col);
    let resolver = |source: &ListSource| -> Vec<String> {
        resolve_list_source(source, grids_ref, sheet_names_ref, active_sheet, anchor, row, col)
    };

    // A custom formula reads the sheet with the entry in place. Only that
    // rule pays for the copy of the sheet. (The copy is a SCRATCH grid: the
    // writes below never reach AppState, and it is dropped when the check
    // returns -- `a_pending_check_leaves_the_document_untouched`. An
    // engine-level value overlay would spare the copy, but the evaluator reads
    // `Grid::cells` directly in hundreds of places; the copy is paid only by a
    // Custom rule, once per Enter.)
    let pending_grid = if matches!(validation.rule, DataValidationRule::Custom(_)) {
        let mut scratch_grid = grid.clone();
        let mut cell = grid.get_cell(row, col).cloned().unwrap_or_else(engine::Cell::new);
        cell.value = cell_value.clone();
        cell.ast = None;
        if matches!(cell_value, CellValue::Empty) {
            scratch_grid.cells.remove(&(row, col));
        } else {
            scratch_grid.set_cell(row, col, cell);
        }
        // The cells that depend on the entry are re-evaluated first, as Excel
        // judges a custom rule after its calculation [LIVE, Excel 16,
        // 2026-11-06, cfdvb/probe4.ps1 E1/E2]: G2 `=H2*2` with `=G2>10` on H2
        // takes 8 typed into an empty H2 and refuses 3 typed over an 8. In
        // dependency order, bounded; the readers on other sheets follow below.
        let order = state
            .dependents
            .lock()
            .map(|deps| crate::get_recalculation_order((row, col), &deps))
            .unwrap_or_default();
        let mut changed: Vec<(u32, u32)> = vec![(row, col)];
        if order.len() <= PENDING_DEPENDENTS_LIMIT {
            for (r, c) in order {
                let Some(ast) = scratch_grid.get_cell(r, c).and_then(|cell| cell.ast.clone()) else { continue };
                let value = crate::conditional_formatting::RuleFormulas::resolved(
                    grids_ref, sheet_names_ref, active_sheet, names.tables(sheet_names_ref),
                )
                .reading_sheet_as(&scratch_grid)
                .value_of_cell_formula(&ast, r, c);
                if let Some(cell) = scratch_grid.cells.get_mut(&(r, c)) {
                    cell.value = value;
                }
                changed.push((r, c));
            }
        }
        Some((scratch_grid, changed))
    } else {
        None
    };
    // The cells on OTHER sheets that read the entry (or a cell of this sheet
    // the entry changed) are re-evaluated too, over this sheet as it would
    // be, so a rule such as `=Calc!B2>10` judges the entry (verify-cfdvb new
    // defect). One step across sheets; the sheets copied are only those with
    // such a reader.
    let mut other_sheets: Vec<(usize, Grid)> = Vec::new();
    if let Some((scratch_grid, changed)) = &pending_grid {
        let readers: Vec<(usize, u32, u32)> = match (sheet_names.get(active_sheet), state.cross_sheet_dependents.lock()) {
            (Some(name), Ok(cross)) => {
                let mut all: Vec<(usize, u32, u32)> = changed
                    .iter()
                    .filter_map(|&(r, c)| crate::cross_sheet_readers(&cross, name, r, c))
                    .flatten()
                    .filter(|(s, _, _)| *s != active_sheet && *s < grids.len())
                    .collect();
                all.sort_unstable();
                all.dedup();
                all
            }
            _ => Vec::new(),
        };
        if readers.len() <= PENDING_DEPENDENTS_LIMIT {
            let mut sheets: Vec<usize> = readers.iter().map(|(s, _, _)| *s).collect();
            sheets.dedup();
            for sheet in sheets {
                let values: Vec<((u32, u32), CellValue)> = readers
                    .iter()
                    .filter(|(s, _, _)| *s == sheet)
                    .filter_map(|&(_, r, c)| {
                        let ast = grids[sheet].get_cell(r, c)?.ast.clone()?;
                        let value = crate::conditional_formatting::RuleFormulas::resolved(
                            grids_ref, sheet_names_ref, sheet, names.tables(sheet_names_ref),
                        )
                        .reading_other_sheets_as(vec![(active_sheet, scratch_grid)])
                        .value_of_cell_formula(&ast, r, c);
                        Some(((r, c), value))
                    })
                    .collect();
                if values.is_empty() {
                    continue;
                }
                let mut reader_scratch_grid = grids[sheet].clone();
                for ((r, c), value) in values {
                    if let Some(cell) = reader_scratch_grid.cells.get_mut(&(r, c)) {
                        cell.value = value;
                    }
                }
                other_sheets.push((sheet, reader_scratch_grid));
            }
        }
    }
    let formulas = crate::conditional_formatting::RuleFormulas::resolved(
        grids_ref, sheet_names_ref, active_sheet, names.tables(sheet_names_ref),
    );
    let formulas = match &pending_grid {
        Some((g, _)) => formulas
            .reading_sheet_as(g)
            .reading_other_sheets_as(other_sheets.iter().map(|(s, g)| (*s, g)).collect()),
        None => formulas,
    };
    let formula_eval = |formula: &str| -> CellValue { custom_formula_value(&formulas, &vr, formula, row, col) };

    let is_valid = validate_cell_value(&cell_value, &validation, Some(&resolver), Some(&formula_eval));

    CellValidationResult {
        is_valid,
        error_alert: if !is_valid && validation.error_alert.show_alert {
            Some(validation.error_alert.clone())
        } else {
            None
        },
    }
}
