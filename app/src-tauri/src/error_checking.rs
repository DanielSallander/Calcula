//! FILENAME: app/src-tauri/src/error_checking.rs
// PURPOSE: Error checking indicators for cells (green triangles).
// CONTEXT: Detects potential cell errors like "number stored as text" and formula errors.
//          Returns indicator data for the frontend to render green corner triangles.

use serde::{Deserialize, Serialize};
use tauri::State;
use engine::CellValue;
use crate::AppState;

// ============================================================================
// Types
// ============================================================================

/// A single error indicator for a cell, sent to the frontend for rendering.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CellErrorIndicator {
    pub row: u32,
    pub col: u32,
    /// Error type identifier: "numberAsText", "formulaError"
    pub error_type: String,
    /// Human-readable description of the error
    pub message: String,
}

// ============================================================================
// Commands
// ============================================================================

/// Get error indicators for cells in the given viewport range.
/// Scans each cell and checks for common error conditions:
/// - "numberAsText": cell value is a Text that parses as a number and has no formula
/// - "formulaError": cell has a formula that evaluates to an error (#VALUE!, #DIV/0!, etc.)
#[tauri::command]
pub fn get_error_indicators(
    state: State<AppState>,
    start_row: u32,
    start_col: u32,
    end_row: u32,
    end_col: u32,
) -> Vec<CellErrorIndicator> {
    let grid = state.grid.lock().unwrap();
    let mut indicators = Vec::new();

    for row in start_row..=end_row {
        for col in start_col..=end_col {
            if let Some(cell) = grid.get_cell(row, col) {
                // Check 1: Number stored as text
                // Cell has no formula and its value is a Text that looks like a number
                if !cell.has_formula() {
                    if let CellValue::Text(ref text) = cell.value {
                        let trimmed = text.trim();
                        if !trimmed.is_empty() && is_numeric_string(trimmed) {
                            indicators.push(CellErrorIndicator {
                                row,
                                col,
                                error_type: "numberAsText".to_string(),
                                message: "Number Stored as Text".to_string(),
                            });
                            continue; // Only report one error per cell
                        }
                    }
                }

                // Check 2: Formula error
                // Cell has a formula and its value is an Error variant
                if cell.has_formula() {
                    if let CellValue::Error(ref err) = cell.value {
                        // One authority on the spelling — see crate::cell_error_display.
                        let error_display = crate::cell_error_display(err);
                        indicators.push(CellErrorIndicator {
                            row,
                            col,
                            error_type: error_indicator_type(err).to_string(),
                            message: error_explanation(err, &error_display),
                        });
                    }
                }
            }
        }
    }

    indicators
}

// ============================================================================
// Helpers
// ============================================================================

/// The indicator category for an error value.
///
/// `#LIMIT!` gets its OWN category rather than sharing "formulaError". The whole
/// justification for giving budget exhaustion a distinct `CellError` variant was
/// that the REMEDY differs — `#VALUE!` means "an argument has the wrong type,
/// fix the argument", `#LIMIT!` means "this formula is too expensive or never
/// terminates, simplify it" — and a category the frontend can filter on is what
/// makes "3 cells hit the calculation limit" answerable.
fn error_indicator_type(err: &engine::CellError) -> &'static str {
    match err {
        engine::CellError::Limit => "calculationLimit",
        _ => "formulaError",
    }
}

/// The message shown next to the indicator. For `#LIMIT!` this must NOT read
/// like a type error: a user sent to "check your arguments" by a runaway
/// recursion will not find anything wrong with them.
fn error_explanation(err: &engine::CellError, display: &str) -> String {
    match err {
        engine::CellError::Limit => format!(
            "{}: this formula exceeded the calculation limit. It is either far \
             more expensive than a single cell is allowed to be, or it never \
             finishes (an unbounded recursive LAMBDA, or a range far larger \
             than the data). Simplify it or narrow its ranges.",
            display
        ),
        _ => format!("Formula Error: {}", display),
    }
}

/// Check if a string looks like a number (integer, decimal, scientific notation,
/// with optional leading +/- sign, or percentage).
fn is_numeric_string(s: &str) -> bool {
    // Try standard float parsing first
    if s.parse::<f64>().is_ok() {
        return true;
    }

    // Also check for percentage strings like "45%"
    if s.ends_with('%') {
        let without_pct = &s[..s.len() - 1];
        if without_pct.parse::<f64>().is_ok() {
            return true;
        }
    }

    // Check for leading currency symbols followed by a number (e.g., "$100")
    // This is intentionally NOT flagged as "number as text" since these
    // are formatted strings, not pure numbers.

    false
}
