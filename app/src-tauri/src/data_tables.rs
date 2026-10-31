//! FILENAME: app/src-tauri/src/data_tables.rs
// PURPOSE: Data Tables (What-If Analysis) - one-variable and two-variable data tables.
// CONTEXT: Tabulates formula results for varying inputs. The formula cell is at
//          a fixed position, and input values are substituted one at a time.

use tauri::State;

use crate::api_types::{DataTableCell, DataTableOneVarParams, DataTableResult, DataTableTwoVarParams};
use crate::document_effect::DocumentEffect;
use crate::persistence::FileState;
use crate::whatif_recalc::{
    begin_whatif_run, check_run_protection_held, stored_cell_in, stored_value_in, write_cells_and_recalc_in,
    RecalcMode, RunSheet, WhatIfStates,
};
use crate::AppState;
use engine::{Cell, CellValue};

// A what-if data table WRITES its computed results into the grid, which is persisted,
// so both commands dirty the document. Neither took a `FileState` before.
//
// The effect is constructed after the sheet-protection gate AND after the orientation
// check that rejects "no input cell specified", so a refused call stays clean.
//
// EACH SUBSTITUTION IS A REAL WRITE (BUG-0613). The input cell is written and
// every dependent recalculated through the shared cascade (`whatif_recalc`); the
// table's formula cell is then read as its STORED value, which the cascade has
// just recalculated through the real dependency chain, on every sheet. This used
// to set the input and evaluate the formula's TEXT alone, so the classic layout
// -- a header `=B10` over a model whose `B10` reaches the input through other
// cells -- filled the whole table with one stale number; and the tidy-up after
// it re-evaluated every formula of the sheet in storage order, positionlessly,
// and no formula on any other sheet. Excel [LIVE]: `=TABLE(,A10)` over `=B10`,
// `B10 = Sheet2!B10+100`, `Sheet2!B10 = Sheet1!A10*2` fills 110 for input 5 and
// 114 for 7, and leaves A10 = 1 and Sheet2!B10 = 2 afterwards.
//
// The results are still written as values (Excel writes `{=TABLE(..)}` array
// formulas that recalculate with the workbook; Calcula has no TABLE function --
// re-running the command refreshes the table).

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
        CellValue::Error(e) => e.as_literal().to_string(),
        CellValue::Empty => String::new(),
        CellValue::List(_) | CellValue::Dict(_) => String::from("[collection]"),
    }
}

/// The input cell holding `value`, keeping the style the cell has now.
fn input_cell(state: &AppState, sheet: RunSheet, row: u32, col: u32, value: &CellValue) -> Cell {
    let style_index = stored_cell_in(state, sheet, row, col).map_or(0, |c| c.style_index);
    let mut cell = match value {
        CellValue::Number(n) => Cell::new_number(*n),
        CellValue::Text(t) => Cell::new_text(t.clone()),
        CellValue::Boolean(b) => Cell::new_boolean(*b),
        CellValue::Empty => Cell::default(),
        CellValue::Error(_) => {
            let mut cell = Cell::new();
            cell.value = value.clone();
            cell
        }
        _ => Cell::new_text(cell_value_to_string(value)),
    };
    cell.style_index = style_index;
    cell
}

/// A computed result as the table stores it, keeping the cell's style -- with
/// its REAL type. Every non-number used to be written as TEXT through
/// `cell_value_to_string`, so an error came out as the text "Div0" (its Debug
/// name) and a boolean as the text "TRUE": `=ISERROR(E12)` answered FALSE and a
/// `SUM` over the body skipped the cell. Excel's `{=TABLE()}` body holds the
/// formula's own value: `#DIV/0!` (ISERROR TRUE), TRUE / FALSE as booleans.
fn result_cell(state: &AppState, sheet: RunSheet, row: u32, col: u32, value: &CellValue) -> Cell {
    let style_index = stored_cell_in(state, sheet, row, col).map_or(0, |c| c.style_index);
    let mut cell = match value {
        CellValue::Number(n) => Cell::new_number(*n),
        CellValue::Boolean(b) => Cell::new_boolean(*b),
        CellValue::Text(t) => Cell::new_text(t.clone()),
        CellValue::Error(_) => {
            let mut cell = Cell::new();
            cell.value = value.clone();
            cell
        }
        // A blank result is Excel's 0 (a formula that reads an empty cell).
        CellValue::Empty => Cell::new_number(0.0),
        CellValue::List(_) | CellValue::Dict(_) => Cell::new_text(cell_value_to_string(value)),
    };
    cell.style_index = style_index;
    cell
}

/// One substitution: write the inputs, recalculate, read each formula cell.
fn substitute_and_read(
    state: &AppState,
    states: &WhatIfStates<'_>,
    effect: &DocumentEffect,
    sheet: RunSheet,
    inputs: &[((u32, u32), Option<Cell>)],
    formula_cells: &[(u32, u32)],
) -> Result<Vec<CellValue>, String> {
    let mut sink = Vec::new();
    write_cells_and_recalc_in(state, states, effect, sheet, inputs, RecalcMode::Always, &mut sink)?;
    Ok(formula_cells
        .iter()
        .map(|&(r, c)| stored_value_in(state, sheet, r, c))
        .collect())
}

/// Write the computed body, put the borrowed input cells back, and recalculate
/// both through the shared cascade: the inputs' dependents return to the
/// values they had, and every reader of the table body sees the new results.
fn finish_table(
    state: &AppState,
    states: &WhatIfStates<'_>,
    effect: &DocumentEffect,
    sheet: RunSheet,
    originals: &[((u32, u32), Option<Cell>)],
    results: &[DataTableCell],
    computed: Vec<((u32, u32), CellValue)>,
) -> DataTableResult {
    let mut updated_cells = Vec::new();
    let mut sink = Vec::new();
    let restored = write_cells_and_recalc_in(state, states, effect, sheet, originals, RecalcMode::Always, &mut sink);
    let body: Vec<((u32, u32), Option<Cell>)> = computed
        .into_iter()
        .map(|((r, c), v)| ((r, c), Some(result_cell(state, sheet, r, c, &v))))
        .collect();
    let written = write_cells_and_recalc_in(state, states, effect, sheet, &body, RecalcMode::AsAnEdit, &mut updated_cells);
    // The restore's repaints too: the inputs and their dependents changed back.
    crate::whatif_recalc::merge_reported_cells(&mut updated_cells, sink);
    DataTableResult {
        cells: results.to_vec(),
        updated_cells,
        error: restored.err().or(written.err()),
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
/// `(async)`: a run is many trials, each a recalculation of the changing
/// cells' dependents; as a sync command the whole run sat on the WebView2 UI
/// thread and the window showed Not Responding until it ended.
#[tauri::command(async)]
pub fn data_table_one_var(
    state: State<AppState>,
    file_state: State<FileState>,
    user_files_state: State<crate::persistence::UserFilesState>,
    pivot_state: State<'_, crate::pivot::types::PivotState>,
    pane_control_state: State<'_, crate::pane_control::PaneControlState>,
    ribbon_filter_state: State<'_, crate::ribbon_filter::RibbonFilterState>,
    params: DataTableOneVarParams,
) -> DataTableResult {
    let states = WhatIfStates {
        user_files: &user_files_state,
        pivots: &pivot_state,
        pane_control: &pane_control_state,
        ribbon_filter: &ribbon_filter_state,
    };
    data_table_one_var_impl(&state, &file_state, &states, params)
}

/// The body of [`data_table_one_var`], callable without a Tauri runtime.
pub(crate) fn data_table_one_var_impl(
    state: &AppState,
    file_state: &FileState,
    states: &WhatIfStates<'_>,
    params: DataTableOneVarParams,
) -> DataTableResult {
    // ONE what-if run at a time, taken before every gate (see `begin_whatif_run`).
    let _run = match begin_whatif_run(state) {
        Ok(run) => run,
        Err(e) => return DataTableResult { cells: Vec::new(), updated_cells: Vec::new(), error: Some(e) },
    };
    // BACKGROUND: a what-if table is rows x cols full evaluations driven by a
    // caller-supplied rectangle, and every result is WRITTEN into the grid — so
    // the persisting ceiling, not a tighter one, and cancellable because the
    // rectangle can be large.
    let _pass = crate::eval_budget::begin_pass(
        crate::eval_budget::EvalSurface::Background,
        &state.calc_cancel,
    );
    crate::log_info!(
        "DATATABLE",
        "One-var: range=({},{})..({},{}) sheet={}",
        params.start_row,
        params.start_col,
        params.end_row,
        params.end_col,
        params.sheet_index
    );

    let sheet_idx = params.sheet_index;

    // Determine orientation
    let col_input = params.col_input_row.zip(params.col_input_col);
    let row_input = params.row_input_row.zip(params.row_input_col);
    let (input_pos, column_oriented) = match (col_input, row_input) {
        (Some(pos), _) => (pos, true),
        (None, Some(pos)) => (pos, false),
        (None, None) => {
            return DataTableResult {
                cells: Vec::new(),
                updated_cells: Vec::new(),
                error: Some("Must specify either row input cell or column input cell.".to_string()),
            };
        }
    };

    // The table's shape, read under the grid locks; every guard dropped before
    // a substitution writes (the cascade takes them itself).
    //   formula_cells: where each formula sits (top row, or left column);
    //   inputs: (body line, input value) for each substitution.
    let (effect, run_sheet, original_input, formula_cells, inputs) = {
        let grid = state.grid.lock_pending().unwrap();
        let grids = state.grids.lock_pending().unwrap();
        let Some(sheet) = grids.get(sheet_idx) else {
            return DataTableResult {
                cells: Vec::new(),
                updated_cells: Vec::new(),
                error: Some(format!("Sheet index {} out of range", sheet_idx)),
            };
        };
        // Sheet protection over the table rectangle, which this command
        // rewrites wholesale (and whose input cell it overwrites temporarily),
        // on a protected background sheet too -- asked HERE, under the guards
        // the run reads its cells under, so it judges the sheet the table is
        // computed on (rev13A: a tab moved between an earlier gate and these
        // locks gated one sheet and ran on another).
        if let Err(e) = check_run_protection_held(state, &grid, &grids, sheet_idx, |kinds, protection, sheet, styles| {
            crate::protection::check_sheet_protection_range_in(
                kinds,
                protection,
                sheet,
                styles,
                sheet_idx,
                params.start_row.min(params.end_row),
                params.start_col.min(params.end_col),
                params.start_row.max(params.end_row),
                params.start_col.max(params.end_col),
            )
        }) {
            return DataTableResult { cells: Vec::new(), updated_cells: Vec::new(), error: Some(e) };
        }
        // The run's sheet by stable id, under the same guards as its cells.
        let run_sheet = RunSheet::at(state, sheet_idx);
        let original_input = sheet.get_cell(input_pos.0, input_pos.1).cloned();
        let value_at = |r: u32, c: u32| sheet.get_cell(r, c).map(|cell| cell.value.clone()).unwrap_or(CellValue::Empty);
        let (formula_cells, inputs): (Vec<(u32, u32)>, Vec<(u32, CellValue)>) = if column_oriented {
            (
                ((params.start_col + 1)..=params.end_col)
                    .filter(|&c| sheet.get_cell(params.start_row, c).and_then(|cell| cell.formula_string()).is_some())
                    .map(|c| (params.start_row, c))
                    .collect(),
                ((params.start_row + 1)..=params.end_row)
                    .map(|r| (r, value_at(r, params.start_col)))
                    .collect(),
            )
        } else {
            (
                ((params.start_row + 1)..=params.end_row)
                    .filter(|&r| sheet.get_cell(r, params.start_col).and_then(|cell| cell.formula_string()).is_some())
                    .map(|r| (r, params.start_col))
                    .collect(),
                ((params.start_col + 1)..=params.end_col)
                    .map(|c| (c, value_at(params.start_row, c)))
                    .collect(),
            )
        };

        // Past the protection gate and the orientation check: results are written below.
        let effect = DocumentEffect::mutates(file_state);
        let _grid = grid.authorize(&effect);
        let _grids = grids.authorize(&effect);
        (effect, run_sheet, original_input, formula_cells, inputs)
    };

    let mut result_cells = Vec::new();
    let mut computed: Vec<((u32, u32), CellValue)> = Vec::new();

    for (line, input_val) in &inputs {
        let write = [(input_pos, Some(input_cell(state, run_sheet, input_pos.0, input_pos.1, input_val)))];
        let values = match substitute_and_read(state, states, &effect, run_sheet, &write, &formula_cells) {
            Ok(values) => values,
            Err(e) => {
                let _ = write_cells_and_recalc_in(
                    state, states, &effect, run_sheet, &[(input_pos, original_input.clone())],
                    RecalcMode::Always, &mut Vec::new(),
                );
                return DataTableResult { cells: Vec::new(), updated_cells: Vec::new(), error: Some(e) };
            }
        };
        for (&(fr, fc), eval_result) in formula_cells.iter().zip(values) {
            // The body cell: the input's line, the formula's column (or row).
            let (r, c) = if column_oriented { (*line, fc) } else { (fr, *line) };
            result_cells.push(DataTableCell {
                row: r,
                col: c,
                value: cell_value_to_string(&eval_result),
                numeric_value: cell_value_to_f64(&eval_result),
            });
            computed.push(((r, c), eval_result));
        }
    }

    finish_table(
        state,
        states,
        &effect,
        run_sheet,
        &[(input_pos, original_input)],
        &result_cells,
        computed,
    )
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
/// `(async)`: a run is many trials, each a recalculation of the changing
/// cells' dependents; as a sync command the whole run sat on the WebView2 UI
/// thread and the window showed Not Responding until it ended.
#[tauri::command(async)]
pub fn data_table_two_var(
    state: State<AppState>,
    file_state: State<FileState>,
    user_files_state: State<crate::persistence::UserFilesState>,
    pivot_state: State<'_, crate::pivot::types::PivotState>,
    pane_control_state: State<'_, crate::pane_control::PaneControlState>,
    ribbon_filter_state: State<'_, crate::ribbon_filter::RibbonFilterState>,
    params: DataTableTwoVarParams,
) -> DataTableResult {
    let states = WhatIfStates {
        user_files: &user_files_state,
        pivots: &pivot_state,
        pane_control: &pane_control_state,
        ribbon_filter: &ribbon_filter_state,
    };
    data_table_two_var_impl(&state, &file_state, &states, params)
}

/// The body of [`data_table_two_var`], callable without a Tauri runtime.
pub(crate) fn data_table_two_var_impl(
    state: &AppState,
    file_state: &FileState,
    states: &WhatIfStates<'_>,
    params: DataTableTwoVarParams,
) -> DataTableResult {
    // ONE what-if run at a time, taken before every gate (see `begin_whatif_run`).
    let _run = match begin_whatif_run(state) {
        Ok(run) => run,
        Err(e) => return DataTableResult { cells: Vec::new(), updated_cells: Vec::new(), error: Some(e) },
    };
    // See data_table_one_var: same surface, quadratically more of it.
    let _pass = crate::eval_budget::begin_pass(
        crate::eval_budget::EvalSurface::Background,
        &state.calc_cancel,
    );
    crate::log_info!(
        "DATATABLE",
        "Two-var: range=({},{})..({},{}) sheet={}",
        params.start_row,
        params.start_col,
        params.end_row,
        params.end_col,
        params.sheet_index
    );

    let sheet_idx = params.sheet_index;
    let row_input_pos = (params.row_input_row, params.row_input_col);
    let col_input_pos = (params.col_input_row, params.col_input_col);
    let formula_pos = (params.start_row, params.start_col);

    let (effect, run_sheet, originals, col_inputs, row_inputs) = {
        let grid = state.grid.lock_pending().unwrap();
        let grids = state.grids.lock_pending().unwrap();
        let Some(sheet) = grids.get(sheet_idx) else {
            return DataTableResult {
                cells: Vec::new(),
                updated_cells: Vec::new(),
                error: Some(format!("Sheet index {} out of range", sheet_idx)),
            };
        };
        // Sheet protection over the table rectangle (rewritten wholesale, its
        // input cells overwritten temporarily), background sheets included --
        // asked under the guards the run reads its cells under (rev13A; see the
        // one-variable table).
        if let Err(e) = check_run_protection_held(state, &grid, &grids, sheet_idx, |kinds, protection, sheet, styles| {
            crate::protection::check_sheet_protection_range_in(
                kinds,
                protection,
                sheet,
                styles,
                sheet_idx,
                params.start_row.min(params.end_row),
                params.start_col.min(params.end_col),
                params.start_row.max(params.end_row),
                params.start_col.max(params.end_col),
            )
        }) {
            return DataTableResult { cells: Vec::new(), updated_cells: Vec::new(), error: Some(e) };
        }
        // The run's sheet by stable id, under the same guards as its cells.
        let run_sheet = RunSheet::at(state, sheet_idx);

        // The formula is in the top-left cell
        if sheet
            .get_cell(formula_pos.0, formula_pos.1)
            .and_then(|cell| cell.formula_string())
            .is_none()
        {
            return DataTableResult {
                cells: Vec::new(),
                updated_cells: Vec::new(),
                error: Some("The top-left cell of the table must contain a formula.".to_string()),
            };
        }

        let value_at = |r: u32, c: u32| sheet.get_cell(r, c).map(|cell| cell.value.clone()).unwrap_or(CellValue::Empty);
        // Original input cells (one entry when both inputs are the same cell)
        let mut originals = vec![
            (col_input_pos, sheet.get_cell(col_input_pos.0, col_input_pos.1).cloned()),
            (row_input_pos, sheet.get_cell(row_input_pos.0, row_input_pos.1).cloned()),
        ];
        if row_input_pos == col_input_pos {
            originals.truncate(1);
        }
        let col_inputs: Vec<(u32, CellValue)> = ((params.start_row + 1)..=params.end_row)
            .map(|r| (r, value_at(r, params.start_col)))
            .collect();
        let row_inputs: Vec<(u32, CellValue)> = ((params.start_col + 1)..=params.end_col)
            .map(|c| (c, value_at(params.start_row, c)))
            .collect();

        // Past the protection gate and the "top-left cell must contain a formula" check.
        let effect = DocumentEffect::mutates(file_state);
        let _grid = grid.authorize(&effect);
        let _grids = grids.authorize(&effect);
        (effect, run_sheet, originals, col_inputs, row_inputs)
    };

    let mut result_cells = Vec::new();
    let mut computed: Vec<((u32, u32), CellValue)> = Vec::new();

    // For each combination of row and column input values
    for (r, col_input_val) in &col_inputs {
        for (c, row_input_val) in &row_inputs {
            // Both inputs in one write (when they are the same cell, the row
            // input's value lands last, as it did before).
            let mut writes = vec![
                (col_input_pos, Some(input_cell(state, run_sheet, col_input_pos.0, col_input_pos.1, col_input_val))),
                (row_input_pos, Some(input_cell(state, run_sheet, row_input_pos.0, row_input_pos.1, row_input_val))),
            ];
            if row_input_pos == col_input_pos {
                writes.remove(0);
            }
            let eval_result = match substitute_and_read(state, states, &effect, run_sheet, &writes, &[formula_pos]) {
                Ok(mut values) => values.pop().unwrap_or(CellValue::Empty),
                Err(e) => {
                    let _ = write_cells_and_recalc_in(
                        state, states, &effect, run_sheet, &originals, RecalcMode::Always, &mut Vec::new(),
                    );
                    return DataTableResult { cells: Vec::new(), updated_cells: Vec::new(), error: Some(e) };
                }
            };
            result_cells.push(DataTableCell {
                row: *r,
                col: *c,
                value: cell_value_to_string(&eval_result),
                numeric_value: cell_value_to_f64(&eval_result),
            });
            computed.push(((*r, *c), eval_result));
        }
    }

    finish_table(state, states, &effect, run_sheet, &originals, &result_cells, computed)
}
