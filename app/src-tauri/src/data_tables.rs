//! FILENAME: app/src-tauri/src/data_tables.rs
// PURPOSE: Data Tables (What-If Analysis) - one-variable and two-variable data tables.
// CONTEXT: Tabulates formula results for varying inputs. The formula cell is at
//          a fixed position, and input values are substituted one at a time.

use std::collections::HashSet;
use tauri::State;

use crate::api_types::{
    CellData, DataTableCell, DataTableOneVarParams, DataTableResult, DataTableTwoVarParams,
    MergedRegion,
};
use crate::{evaluate_formula_multi_sheet, format_cell_value, AppState};
use engine::{Cell, CellValue, Grid, StyleRegistry};

// ============================================================================
// Helper: build CellData from grid
// ============================================================================

fn build_cell_data(
    grid: &Grid,
    styles: &StyleRegistry,
    merged_regions: &HashSet<MergedRegion>,
    r: u32,
    c: u32,
) -> Option<CellData> {
    let cell = grid.get_cell(r, c)?;
    let style = styles.get(cell.style_index);
    let display = format_cell_value(&cell.value, style);

    let merge = merged_regions
        .iter()
        .find(|m| m.start_row == r && m.start_col == c);
    let (row_span, col_span) = match merge {
        Some(m) => (m.end_row - m.start_row + 1, m.end_col - m.start_col + 1),
        None => (1, 1),
    };

    Some(CellData {
        row: r,
        col: c,
        display,
        display_color: None,
        formula: cell.formula.clone(),
        style_index: cell.style_index,
        row_span,
        col_span,
        sheet_index: None,
        rich_text: None,
        accounting_layout: None,
    })
}

/// Extract numeric value from a CellValue
fn cell_value_to_f64(val: &CellValue) -> Option<f64> {
    match val {
        CellValue::Number(n) => Some(*n),
        _ => None,
    }
}

/// Format a CellValue for display
fn cell_value_to_string(val: &CellValue) -> String {
    match val {
        CellValue::Number(n) => {
            if *n == (*n as i64) as f64 && n.abs() < 1e15 {
                format!("{}", *n as i64)
            } else {
                format!("{}", n)
            }
        }
        CellValue::Text(t) => t.clone(),
        CellValue::Boolean(b) => if *b { "TRUE" } else { "FALSE" }.to_string(),
        CellValue::Error(e) => format!("{:?}", e),
        CellValue::Empty => String::new(),
        CellValue::List(_) | CellValue::Dict(_) => String::from("[collection]"),
    }
}

// ============================================================================
// One-Variable Data Table
// ============================================================================

/// Calculate a one-variable data table.
///
/// Layout (column-oriented, col_input provided):
///   - Top-left cell (start_row, start_col): formula cell (or empty)
///   - Column start_col, rows start_row+1..end_row: input values
///   - Columns start_col+1..end_col, row start_row: formula cells
///   - Body (start_row+1..end_row, start_col+1..end_col): computed results
///
/// Layout (row-oriented, row_input provided):
///   - Top-left cell (start_row, start_col): formula cell (or empty)
///   - Row start_row, cols start_col+1..end_col: input values
///   - Column start_col, rows start_row+1..end_row: formula cells
///   - Body (start_row+1..end_row, start_col+1..end_col): computed results
#[tauri::command]
pub fn data_table_one_var(
    state: State<AppState>,
    params: DataTableOneVarParams,
) -> DataTableResult {
    crate::log_info!(
        "DATATABLE",
        "One-var: range=({},{})..({},{}) sheet={}",
        params.start_row,
        params.start_col,
        params.end_row,
        params.end_col,
        params.sheet_index
    );

    let mut grid = state.grid.lock().unwrap();
    let mut grids = state.grids.lock().unwrap();
    let active_sheet = *state.active_sheet.lock().unwrap();
    let sheet_names = state.sheet_names.lock().unwrap();
    let styles = state.style_registry.lock().unwrap();
    let merged_regions = state.merged_regions.lock().unwrap();

    let sheet_idx = params.sheet_index;

    // Determine orientation
    let is_col_input = params.col_input_row.is_some() && params.col_input_col.is_some();
    let is_row_input = params.row_input_row.is_some() && params.row_input_col.is_some();

    if !is_col_input && !is_row_input {
        return DataTableResult {
            cells: Vec::new(),
            updated_cells: Vec::new(),
            error: Some("Must specify either row input cell or column input cell.".to_string()),
        };
    }

    let mut result_cells = Vec::new();
    let mut updated_cells = Vec::new();

    if is_col_input {
        // Column-oriented: input values down the left column
        let input_row = params.col_input_row.unwrap();
        let input_col = params.col_input_col.unwrap();

        // Save original input cell value
        let original_input = grids[sheet_idx]
            .get_cell(input_row, input_col)
            .cloned();

        // Collect formulas from the top row (start_row, start_col+1..end_col)
        let mut formulas: Vec<Option<String>> = Vec::new();
        for c in (params.start_col + 1)..=params.end_col {
            let formula = grids[sheet_idx]
                .get_cell(params.start_row, c)
                .and_then(|cell| cell.formula.clone());
            formulas.push(formula);
        }

        // For each input value (down left column)
        for r in (params.start_row + 1)..=params.end_row {
            let input_val = grids[sheet_idx]
                .get_cell(r, params.start_col)
                .map(|c| c.value.clone())
                .unwrap_or(CellValue::Empty);

            // Set the input cell to this value
            set_cell_value(&mut grids[sheet_idx], input_row, input_col, &input_val);

            // Evaluate each formula
            for (fi, formula_opt) in formulas.iter().enumerate() {
                let c = params.start_col + 1 + fi as u32;
                if let Some(formula) = formula_opt {
                    let eval_result = evaluate_formula_multi_sheet(
                        &grids, &sheet_names, sheet_idx, formula,
                    );
                    let display = cell_value_to_string(&eval_result);
                    let numeric = cell_value_to_f64(&eval_result);

                    result_cells.push(DataTableCell {
                        row: r,
                        col: c,
                        value: display.clone(),
                        numeric_value: numeric,
                    });

                    // Write result to grid
                    let style_index = grids[sheet_idx]
                        .get_cell(r, c)
                        .map_or(0, |cell| cell.style_index);
                    let mut new_cell = match &eval_result {
                        CellValue::Number(n) => Cell::new_number(*n),
                        _ => Cell::new_text(display.clone()),
                    };
                    new_cell.style_index = style_index;
                    grids[sheet_idx].set_cell(r, c, new_cell.clone());
                    if sheet_idx == active_sheet {
                        grid.set_cell(r, c, new_cell);
                    }
                }
            }
        }

        // Restore original input cell
        restore_cell(&mut grids[sheet_idx], input_row, input_col, &original_input);
        if sheet_idx == active_sheet {
            restore_cell(&mut grid, input_row, input_col, &original_input);
        }

    } else {
        // Row-oriented: input values across the top row
        let input_row = params.row_input_row.unwrap();
        let input_col = params.row_input_col.unwrap();

        let original_input = grids[sheet_idx]
            .get_cell(input_row, input_col)
            .cloned();

        // Collect formulas from the left column (start_row+1..end_row, start_col)
        let mut formulas: Vec<Option<String>> = Vec::new();
        for r in (params.start_row + 1)..=params.end_row {
            let formula = grids[sheet_idx]
                .get_cell(r, params.start_col)
                .and_then(|cell| cell.formula.clone());
            formulas.push(formula);
        }

        // For each input value (across top row)
        for c in (params.start_col + 1)..=params.end_col {
            let input_val = grids[sheet_idx]
                .get_cell(params.start_row, c)
                .map(|cell| cell.value.clone())
                .unwrap_or(CellValue::Empty);

            // Set the input cell to this value
            set_cell_value(&mut grids[sheet_idx], input_row, input_col, &input_val);

            // Evaluate each formula
            for (fi, formula_opt) in formulas.iter().enumerate() {
                let r = params.start_row + 1 + fi as u32;
                if let Some(formula) = formula_opt {
                    let eval_result = evaluate_formula_multi_sheet(
                        &grids, &sheet_names, sheet_idx, formula,
                    );
                    let display = cell_value_to_string(&eval_result);
                    let numeric = cell_value_to_f64(&eval_result);

                    result_cells.push(DataTableCell {
                        row: r,
                        col: c,
                        value: display.clone(),
                        numeric_value: numeric,
                    });

                    let style_index = grids[sheet_idx]
                        .get_cell(r, c)
                        .map_or(0, |cell| cell.style_index);
                    let mut new_cell = match &eval_result {
                        CellValue::Number(n) => Cell::new_number(*n),
                        _ => Cell::new_text(display.clone()),
                    };
                    new_cell.style_index = style_index;
                    grids[sheet_idx].set_cell(r, c, new_cell.clone());
                    if sheet_idx == active_sheet {
                        grid.set_cell(r, c, new_cell);
                    }
                }
            }
        }

        // Restore original input cell
        restore_cell(&mut grids[sheet_idx], input_row, input_col, &original_input);
        if sheet_idx == active_sheet {
            restore_cell(&mut grid, input_row, input_col, &original_input);
        }
    }

    // Build updated cells for grid refresh
    for r in params.start_row..=params.end_row {
        for c in params.start_col..=params.end_col {
            if let Some(cd) = build_cell_data(&grids[sheet_idx], &styles, &merged_regions, r, c) {
                updated_cells.push(cd);
            }
        }
    }

    // Re-evaluate formulas back with restored input
    re_evaluate_formulas(
        &mut grid,
        &mut grids,
        &sheet_names,
        sheet_idx,
        active_sheet,
    );

    DataTableResult {
        cells: result_cells,
        updated_cells,
        error: None,
    }
}

// ============================================================================
// Two-Variable Data Table
// ============================================================================

/// Calculate a two-variable data table.
///
/// Layout:
///   - Top-left cell (start_row, start_col): the formula cell
///   - Top row (start_row, start_col+1..end_col): row input values
///   - Left column (start_row+1..end_row, start_col): column input values
///   - Body (start_row+1..end_row, start_col+1..end_col): computed results
#[tauri::command]
pub fn data_table_two_var(
    state: State<AppState>,
    params: DataTableTwoVarParams,
) -> DataTableResult {
    crate::log_info!(
        "DATATABLE",
        "Two-var: range=({},{})..({},{}) sheet={}",
        params.start_row,
        params.start_col,
        params.end_row,
        params.end_col,
        params.sheet_index
    );

    let mut grid = state.grid.lock().unwrap();
    let mut grids = state.grids.lock().unwrap();
    let active_sheet = *state.active_sheet.lock().unwrap();
    let sheet_names = state.sheet_names.lock().unwrap();
    let styles = state.style_registry.lock().unwrap();
    let merged_regions = state.merged_regions.lock().unwrap();

    let sheet_idx = params.sheet_index;

    // The formula is in the top-left cell
    let formula = match grids[sheet_idx]
        .get_cell(params.start_row, params.start_col)
        .and_then(|cell| cell.formula.clone())
    {
        Some(f) => f,
        None => {
            return DataTableResult {
                cells: Vec::new(),
                updated_cells: Vec::new(),
                error: Some("The top-left cell of the table must contain a formula.".to_string()),
            };
        }
    };

    // Save original input cell values
    let original_row_input = grids[sheet_idx]
        .get_cell(params.row_input_row, params.row_input_col)
        .cloned();
    let original_col_input = grids[sheet_idx]
        .get_cell(params.col_input_row, params.col_input_col)
        .cloned();

    let mut result_cells = Vec::new();

    // For each combination of row and column input values
    for r in (params.start_row + 1)..=params.end_row {
        let col_input_val = grids[sheet_idx]
            .get_cell(r, params.start_col)
            .map(|c| c.value.clone())
            .unwrap_or(CellValue::Empty);

        // Set column input cell
        set_cell_value(
            &mut grids[sheet_idx],
            params.col_input_row,
            params.col_input_col,
            &col_input_val,
        );

        for c in (params.start_col + 1)..=params.end_col {
            let row_input_val = grids[sheet_idx]
                .get_cell(params.start_row, c)
                .map(|cell| cell.value.clone())
                .unwrap_or(CellValue::Empty);

            // Set row input cell
            set_cell_value(
                &mut grids[sheet_idx],
                params.row_input_row,
                params.row_input_col,
                &row_input_val,
            );

            // Evaluate the formula
            let eval_result =
                evaluate_formula_multi_sheet(&grids, &sheet_names, sheet_idx, &formula);
            let display = cell_value_to_string(&eval_result);
            let numeric = cell_value_to_f64(&eval_result);

            result_cells.push(DataTableCell {
                row: r,
                col: c,
                value: display.clone(),
                numeric_value: numeric,
            });

            // Write result to grid
            let style_index = grids[sheet_idx]
                .get_cell(r, c)
                .map_or(0, |cell| cell.style_index);
            let mut new_cell = match &eval_result {
                CellValue::Number(n) => Cell::new_number(*n),
                _ => Cell::new_text(display.clone()),
            };
            new_cell.style_index = style_index;
            grids[sheet_idx].set_cell(r, c, new_cell.clone());
            if sheet_idx == active_sheet {
                grid.set_cell(r, c, new_cell);
            }
        }
    }

    // Restore original input cells
    restore_cell(
        &mut grids[sheet_idx],
        params.row_input_row,
        params.row_input_col,
        &original_row_input,
    );
    restore_cell(
        &mut grids[sheet_idx],
        params.col_input_row,
        params.col_input_col,
        &original_col_input,
    );
    if sheet_idx == active_sheet {
        restore_cell(&mut grid, params.row_input_row, params.row_input_col, &original_row_input);
        restore_cell(&mut grid, params.col_input_row, params.col_input_col, &original_col_input);
    }

    // Build updated cells
    let mut updated_cells = Vec::new();
    for r in params.start_row..=params.end_row {
        for c in params.start_col..=params.end_col {
            if let Some(cd) = build_cell_data(&grids[sheet_idx], &styles, &merged_regions, r, c) {
                updated_cells.push(cd);
            }
        }
    }

    // Re-evaluate with restored input values
    re_evaluate_formulas(
        &mut grid,
        &mut grids,
        &sheet_names,
        sheet_idx,
        active_sheet,
    );

    DataTableResult {
        cells: result_cells,
        updated_cells,
        error: None,
    }
}

// ============================================================================
// Helpers
// ============================================================================

/// Set a cell's value in the grid (preserving style).
fn set_cell_value(grid: &mut Grid, row: u32, col: u32, value: &CellValue) {
    let style_index = grid.get_cell(row, col).map_or(0, |c| c.style_index);
    let mut cell = match value {
        CellValue::Number(n) => Cell::new_number(*n),
        CellValue::Text(t) => Cell::new_text(t.clone()),
        CellValue::Boolean(b) => Cell::new_boolean(*b),
        CellValue::Empty => Cell::default(),
        _ => Cell::new_text(cell_value_to_string(value)),
    };
    cell.style_index = style_index;
    grid.set_cell(row, col, cell);
}

/// Restore a cell from saved state.
fn restore_cell(grid: &mut Grid, row: u32, col: u32, original: &Option<Cell>) {
    match original {
        Some(cell) => grid.set_cell(row, col, cell.clone()),
        None => grid.set_cell(row, col, Cell::default()),
    }
}

/// Re-evaluate formula cells after data table computation.
/// This is a simplified recalc for the formula cells that may have been
/// affected by the temporary input value changes.
fn re_evaluate_formulas(
    grid: &mut Grid,
    grids: &mut [Grid],
    sheet_names: &[String],
    sheet_idx: usize,
    active_sheet: usize,
) {
    // Walk through all cells in the sheet and re-evaluate any formula cells
    // This is a simple approach; a production system would use the dependency graph
    let max_row = grids[sheet_idx].max_row;
    let max_col = grids[sheet_idx].max_col;
    if max_row > 0 || max_col > 0 {
        for r in 0..=max_row {
            for c in 0..=max_col {
                if let Some(cell) = grids[sheet_idx].get_cell(r, c).cloned() {
                    if let Some(formula) = &cell.formula {
                        let new_value = evaluate_formula_multi_sheet(
                            grids, sheet_names, sheet_idx, formula,
                        );
                        let mut updated = cell;
                        updated.value = new_value;
                        grids[sheet_idx].set_cell(r, c, updated.clone());
                        if sheet_idx == active_sheet {
                            grid.set_cell(r, c, updated);
                        }
                    }
                }
            }
        }
    }
}
