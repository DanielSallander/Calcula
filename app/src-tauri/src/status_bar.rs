//! FILENAME: app/src-tauri/src/status_bar.rs
// PURPOSE: Status bar aggregation command - computes quick statistics for a selection.
// CONTEXT: Called by the StatusBarAggregation extension when the user selects cells.
//          Computes Sum, Average, Count, Numerical Count, Min, Max in a single round-trip.

use tauri::State;
use engine::CellValue;
use crate::api_types::SelectionAggregationResult;
use crate::AppState;

/// Compute aggregations for the currently selected range.
/// Returns sum, average, count, numerical count, min, max.
///
/// - `selection_type`: "cells", "columns", or "rows"
///   For columns/rows, the scan is capped to grid.max_row/max_col.
#[tauri::command]
pub fn get_selection_aggregations(
    state: State<AppState>,
    start_row: u32,
    start_col: u32,
    end_row: u32,
    end_col: u32,
    selection_type: String,
) -> SelectionAggregationResult {
    let grid = state.grid.lock().unwrap();

    // Normalise bounds (ensure start <= end)
    let r0 = start_row.min(end_row);
    let c0 = start_col.min(end_col);
    let mut r1 = start_row.max(end_row);
    let mut c1 = start_col.max(end_col);

    // Cap to actual data bounds for column/row selections to avoid scanning empty space
    match selection_type.as_str() {
        "columns" => {
            r1 = r1.min(grid.max_row);
        }
        "rows" => {
            c1 = c1.min(grid.max_col);
        }
        _ => {
            // "cells" - use the provided bounds as-is
        }
    }

    let mut count: u32 = 0;
    let mut numerical_count: u32 = 0;
    let mut numeric_values: Vec<f64> = Vec::new();

    for row in r0..=r1 {
        for col in c0..=c1 {
            if let Some(cell) = grid.cells.get(&(row, col)) {
                match &cell.value {
                    CellValue::Empty => {
                        // Empty cells are not counted
                    }
                    CellValue::Number(n) => {
                        if !n.is_nan() && !n.is_infinite() {
                            count += 1;
                            numerical_count += 1;
                            numeric_values.push(*n);
                        } else {
                            // NaN/Infinity count as non-empty but not numeric
                            count += 1;
                        }
                    }
                    CellValue::Boolean(b) => {
                        count += 1;
                        numerical_count += 1;
                        numeric_values.push(if *b { 1.0 } else { 0.0 });
                    }
                    CellValue::Text(_) => {
                        count += 1;
                        // Text does not contribute to numeric aggregations
                    }
                    CellValue::Error(_) => {
                        count += 1;
                        // Errors do not contribute to numeric aggregations
                    }
                }
            }
        }
    }

    if numeric_values.is_empty() {
        SelectionAggregationResult {
            sum: None,
            average: None,
            min: None,
            max: None,
            count,
            numerical_count,
        }
    } else {
        let sum: f64 = numeric_values.iter().sum();
        let avg = sum / numeric_values.len() as f64;
        let min = numeric_values.iter().cloned().fold(f64::INFINITY, f64::min);
        let max = numeric_values.iter().cloned().fold(f64::NEG_INFINITY, f64::max);

        SelectionAggregationResult {
            sum: Some(sum),
            average: Some(avg),
            min: Some(min),
            max: Some(max),
            count,
            numerical_count,
        }
    }
}
