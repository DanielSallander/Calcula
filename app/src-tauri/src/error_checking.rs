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
                if cell.formula.is_none() {
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
                if cell.formula.is_some() {
                    if let CellValue::Error(ref err) = cell.value {
                        // Match the display format used in cell.rs
                        let error_display = match err {
                            engine::CellError::NA => "#N/A".to_string(),
                            engine::CellError::Conflict => "#CONFLICT".to_string(),
                            other => format!("#{:?}", other).to_uppercase(),
                        };
                        indicators.push(CellErrorIndicator {
                            row,
                            col,
                            error_type: "formulaError".to_string(),
                            message: format!("Formula Error: {}", error_display),
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
