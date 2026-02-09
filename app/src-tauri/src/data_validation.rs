//! FILENAME: app/src-tauri/src/data_validation.rs
//! PURPOSE: Data validation for cells - Excel-compatible validation rules.
//! CONTEXT: Implements validation types (WholeNumber, Decimal, List, Date, Time,
//! TextLength, Custom), operators, error alerts, and input prompts.

use crate::AppState;
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
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
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
    },
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

        DataValidationRule::Custom(_rule) => {
            // Custom formulas require formula evaluation context
            // For now, we'll return true and implement full formula evaluation later
            // when we have access to the evaluator context
            true
        }
    }
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

/// Resolve list values from a range source.
pub fn resolve_list_source(
    source: &ListSource,
    grids: &[Grid],
    _sheet_names: &[String],
    current_sheet: usize,
) -> Vec<String> {
    match source {
        ListSource::Values(v) => v.clone(),
        ListSource::Range {
            sheet_index,
            start_row,
            start_col,
            end_row,
            end_col,
        } => {
            let sheet_idx = sheet_index.unwrap_or(current_sheet);
            if sheet_idx >= grids.len() {
                return Vec::new();
            }

            let grid = &grids[sheet_idx];
            let mut values = Vec::new();

            let min_row = (*start_row).min(*end_row);
            let max_row = (*start_row).max(*end_row);
            let min_col = (*start_col).min(*end_col);
            let max_col = (*start_col).max(*end_col);

            for r in min_row..=max_row {
                for c in min_col..=max_col {
                    if let Some(cell) = grid.cells.get(&(r, c)) {
                        let text = match &cell.value {
                            CellValue::Text(s) => s.clone(),
                            CellValue::Number(n) => crate::format_number_simple(*n),
                            CellValue::Boolean(b) => if *b { "TRUE".to_string() } else { "FALSE".to_string() },
                            CellValue::Empty => continue,
                            CellValue::Error(_) => continue,
                        };
                        if !text.is_empty() {
                            values.push(text);
                        }
                    }
                }
            }

            values
        }
    }
}

// ============================================================================
// TAURI COMMANDS
// ============================================================================

/// Set data validation on a range.
#[tauri::command]
pub fn set_data_validation(
    state: State<AppState>,
    start_row: u32,
    start_col: u32,
    end_row: u32,
    end_col: u32,
    validation: DataValidation,
) -> DataValidationResult {
    let active_sheet = *state.active_sheet.lock().unwrap();
    let mut validations = state.data_validations.lock().unwrap();

    let sheet_validations = validations.entry(active_sheet).or_insert_with(Vec::new);

    // Normalize coordinates
    let min_row = start_row.min(end_row);
    let max_row = start_row.max(end_row);
    let min_col = start_col.min(end_col);
    let max_col = start_col.max(end_col);

    // Remove any existing validations that overlap completely with the new range
    sheet_validations.retain(|vr| {
        !(vr.start_row >= min_row && vr.end_row <= max_row
          && vr.start_col >= min_col && vr.end_col <= max_col)
    });

    // Add the new validation range
    let vr = ValidationRange {
        start_row: min_row,
        start_col: min_col,
        end_row: max_row,
        end_col: max_col,
        validation: validation.clone(),
    };
    sheet_validations.push(vr);

    DataValidationResult {
        success: true,
        validation: Some(validation),
        error: None,
    }
}

/// Clear data validation from a range.
#[tauri::command]
pub fn clear_data_validation(
    state: State<AppState>,
    start_row: u32,
    start_col: u32,
    end_row: u32,
    end_col: u32,
) -> DataValidationResult {
    let active_sheet = *state.active_sheet.lock().unwrap();
    let mut validations = state.data_validations.lock().unwrap();

    if let Some(sheet_validations) = validations.get_mut(&active_sheet) {
        let min_row = start_row.min(end_row);
        let max_row = start_row.max(end_row);
        let min_col = start_col.min(end_col);
        let max_col = start_col.max(end_col);

        // Remove validations that are fully contained in the cleared range
        sheet_validations.retain(|vr| {
            !(vr.start_row >= min_row && vr.end_row <= max_row
              && vr.start_col >= min_col && vr.end_col <= max_col)
        });
    }

    DataValidationResult {
        success: true,
        validation: None,
        error: None,
    }
}

/// Get data validation for a specific cell.
#[tauri::command]
pub fn get_data_validation(
    state: State<AppState>,
    row: u32,
    col: u32,
) -> Option<DataValidation> {
    let active_sheet = *state.active_sheet.lock().unwrap();
    let validations = state.data_validations.lock().unwrap();

    if let Some(sheet_validations) = validations.get(&active_sheet) {
        if let Some(validation) = get_validation_for_cell(sheet_validations, row, col) {
            return Some(validation.clone());
        }
    }

    None
}

/// Get all validation ranges for the current sheet.
#[tauri::command]
pub fn get_all_data_validations(
    state: State<AppState>,
) -> Vec<ValidationRange> {
    let active_sheet = *state.active_sheet.lock().unwrap();
    let validations = state.data_validations.lock().unwrap();

    validations.get(&active_sheet).cloned().unwrap_or_default()
}

/// Validate a cell value against its validation rule.
#[tauri::command]
pub fn validate_cell(
    state: State<AppState>,
    row: u32,
    col: u32,
) -> CellValidationResult {
    let active_sheet = *state.active_sheet.lock().unwrap();
    let validations = state.data_validations.lock().unwrap();
    let grids = state.grids.lock().unwrap();
    let sheet_names = state.sheet_names.lock().unwrap();

    // Get the validation rule for this cell
    let validation = if let Some(sheet_validations) = validations.get(&active_sheet) {
        get_validation_for_cell(sheet_validations, row, col).cloned()
    } else {
        None
    };

    let validation = match validation {
        Some(v) => v,
        None => {
            return CellValidationResult {
                is_valid: true,
                error_alert: None,
            };
        }
    };

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

    // Create a resolver for list sources
    let grids_ref = &grids;
    let sheet_names_ref = &sheet_names;
    let resolver = |source: &ListSource| -> Vec<String> {
        resolve_list_source(source, grids_ref, sheet_names_ref, active_sheet)
    };

    let is_valid = validate_cell_value(&cell_value, &validation, Some(&resolver));

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
    let active_sheet = *state.active_sheet.lock().unwrap();
    let validations = state.data_validations.lock().unwrap();

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
    let active_sheet = *state.active_sheet.lock().unwrap();
    let validations = state.data_validations.lock().unwrap();
    let grids = state.grids.lock().unwrap();
    let sheet_names = state.sheet_names.lock().unwrap();

    let mut invalid_cells = Vec::new();

    if let Some(sheet_validations) = validations.get(&active_sheet) {
        if active_sheet < grids.len() {
            let grid = &grids[active_sheet];

            // Create a resolver for list sources
            let grids_ref = &grids;
            let sheet_names_ref = &sheet_names;
            let resolver = |source: &ListSource| -> Vec<String> {
                resolve_list_source(source, grids_ref, sheet_names_ref, active_sheet)
            };

            // Check each validation range
            for vr in sheet_validations {
                for row in vr.start_row..=vr.end_row {
                    for col in vr.start_col..=vr.end_col {
                        let cell_value = grid
                            .cells
                            .get(&(row, col))
                            .map(|c| c.value.clone())
                            .unwrap_or(CellValue::Empty);

                        if !validate_cell_value(&cell_value, &vr.validation, Some(&resolver)) {
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
    let active_sheet = *state.active_sheet.lock().unwrap();
    let validations = state.data_validations.lock().unwrap();
    let grids = state.grids.lock().unwrap();
    let sheet_names = state.sheet_names.lock().unwrap();

    if let Some(sheet_validations) = validations.get(&active_sheet) {
        if let Some(validation) = get_validation_for_cell(sheet_validations, row, col) {
            if let DataValidationRule::List(list_rule) = &validation.rule {
                let values = resolve_list_source(
                    &list_rule.source,
                    &grids,
                    &sheet_names,
                    active_sheet,
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
    let active_sheet = *state.active_sheet.lock().unwrap();
    let validations = state.data_validations.lock().unwrap();

    if let Some(sheet_validations) = validations.get(&active_sheet) {
        if let Some(validation) = get_validation_for_cell(sheet_validations, row, col) {
            if let DataValidationRule::List(list_rule) = &validation.rule {
                return list_rule.in_cell_dropdown;
            }
        }
    }

    false
}
