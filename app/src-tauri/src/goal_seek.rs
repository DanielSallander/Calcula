//! FILENAME: app/src-tauri/src/goal_seek.rs
// PURPOSE: Goal Seek solver - iterative single-variable numerical solver.
// CONTEXT: Uses the secant method to find a variable cell value that makes
//          a target formula evaluate to a desired result.
//
// EVERY TRIAL IS A REAL WRITE (BUG-0613). A trial writes the changing cell and
// recalculates through the shared cascade (`whatif_recalc`), then reads the
// target cell's STORED value. It used to set the cell and evaluate the target's
// formula text alone, so a target that reached the changing cell through any
// other cell (`C1 = B1+1`, `B1 = A1*2`, or the same through another sheet) read
// a value no trial ever recalculated -- a flat function Goal Seek could not
// solve -- and the final value's dependents on other sheets were never
// recalculated at all. Excel [LIVE]: Goal Seek on `Sheet1!C1 = Sheet2!B1+1`,
// `Sheet2!B1 = Sheet1!A1*2` for 11 finds A1 = 5 and leaves Sheet2!B1 = 10.
//
// NO DEPENDENCY REFUSAL. This command refused a target that did not depend on
// the changing cell through the ACTIVE sheet's map -- which also refused every
// chain that crossed a sheet. Excel refuses nothing here [LIVE]: Goal Seek of
// `G1 = 5` to 7 by F1 returns "not found" and leaves the last trial value in
// F1. So does this now -- the LAST trial, not the best one.

use tauri::State;

use crate::api_types::{GoalSeekParams, GoalSeekResult};
use crate::document_effect::DocumentEffect;
use crate::persistence::FileState;
use crate::whatif_recalc::{
    begin_whatif_run, calculate_workbook_at_run_end, check_run_protection_held, stored_value_in,
    write_cells_and_recalc, write_cells_and_recalc_in, RecalcMode, RunSheet, WhatIfStates,
};
use crate::AppState;
use engine::{Cell, CellValue};

/// Build an error GoalSeekResult with the given message.
fn error_result(msg: &str) -> GoalSeekResult {
    GoalSeekResult {
        found_solution: false,
        variable_value: 0.0,
        target_result: 0.0,
        iterations: 0,
        original_variable_value: 0.0,
        updated_cells: Vec::new(),
        error: Some(msg.to_string()),
        undo_seq: None,
    }
}

// ============================================================================
// Tauri command
// ============================================================================

/// `(async)`: a run is many trials, each a recalculation of the changing
/// cells' dependents; as a sync command the whole run sat on the WebView2 UI
/// thread and the window showed Not Responding until it ended.
///
/// Two calls in one door: `params` runs a Goal Seek; `cancel_run` (the
/// `undo_seq` a run answered) is the status dialog's CANCEL
/// ([`cancel_goal_seek_impl`]).
#[tauri::command(async)]
pub fn goal_seek(
    state: State<AppState>,
    file_state: State<FileState>,
    user_files_state: State<crate::persistence::UserFilesState>,
    pivot_state: State<'_, crate::pivot::types::PivotState>,
    pane_control_state: State<'_, crate::pane_control::PaneControlState>,
    ribbon_filter_state: State<'_, crate::ribbon_filter::RibbonFilterState>,
    params: Option<GoalSeekParams>,
    cancel_run: Option<u64>,
) -> GoalSeekResult {
    let states = WhatIfStates {
        user_files: &user_files_state,
        pivots: &pivot_state,
        pane_control: &pane_control_state,
        ribbon_filter: &ribbon_filter_state,
    };
    match (params, cancel_run) {
        (_, Some(run)) => cancel_goal_seek_impl(&state, &file_state, &states, run),
        (Some(params), None) => goal_seek_impl(&state, &file_state, &states, params),
        (None, None) => error_result("Goal Seek needs a target, a value and a changing cell"),
    }
}

/// Why a Cancel took nothing back: the run's step is no longer the newest
/// entry in the undo history.
pub(crate) const CANCEL_STEP_MOVED: &str =
    "Something else changed the workbook after the Goal Seek ran, so its result was not taken back. \
     Use Undo to reach it.";

/// THE STATUS DIALOG'S CANCEL, as Excel's: the changing cell goes back exactly
/// as it was and the run leaves NOTHING in the history -- no undo step and no
/// redo step [LIVE, Excel 16, visible instance: Goal Seek of `B1 = A1*2` to 10
/// by A1, Cancel in Goal Seek Status -> A1 = 1 again, Undo and Redo both
/// disabled, Ctrl+Y changes nothing; Workbook.Saved is False, so the document
/// counts as changed]. Cancel used to be a scoped undo of the run's step,
/// which moved it onto the REDO stack, so Ctrl+Y re-applied the result.
///
/// The run's step (`run`, its `undo_seq`) is taken off the history only while
/// it is still the newest entry and is the Goal Seek step this door pushed,
/// under the stack lock alone; the cell it holds is then written back through
/// the same write and recalculation a trial uses. Anything else on top refuses
/// and moves nothing.
pub(crate) fn cancel_goal_seek_impl(
    state: &AppState,
    file_state: &FileState,
    states: &WhatIfStates<'_>,
    run: u64,
) -> GoalSeekResult {
    // Not while a run is writing trials (see `begin_whatif_run`).
    let _run = match begin_whatif_run(state) {
        Ok(run) => run,
        Err(e) => return error_result(&e),
    };
    // WRITE BACK FIRST, THEN TAKE THE STEP (rev12B, round 13). The step was
    // popped before the write-back, so a write that failed (a sheet removed
    // while the status dialog was open) lost the run's undo step AND left the
    // cell unrestored. Now the step is only READ here; it leaves the history
    // after the cell is back, so a failed write leaves the step for Undo.
    let change = {
        let mut stack = state.undo_stack.lock().unwrap();
        let is_the_run = stack.top_undo_seq() == Some(run) && stack.undo_description() == Some(GOAL_SEEK_STEP);
        if !is_the_run {
            return error_result(CANCEL_STEP_MOVED);
        }
        // Read the top step in place: taken and put straight back under this
        // one hold (`push_undo_for_redo` keeps its id and the redo stack).
        let step = stack.pop_undo();
        let change = step.as_ref().and_then(|step| step.changes.first().cloned());
        if let Some(step) = step {
            stack.push_undo_for_redo(step);
        }
        change
    };
    let Some(engine::CellChange::SetCell { sheet, row, col, previous }) = change else {
        return error_result(CANCEL_STEP_MOVED);
    };
    // Excel's Cancel leaves the workbook changed (Saved = False) [LIVE].
    let effect = DocumentEffect::mutates(file_state);
    let mut updated_cells = Vec::new();
    if let Err(e) = write_cells_and_recalc(
        state,
        states,
        &effect,
        sheet,
        &[((row, col), previous.clone())],
        RecalcMode::Always,
        &mut updated_cells,
    ) {
        return error_result(&e);
    }
    // The cell is back: the run leaves nothing in the history (Excel's
    // Cancel). Taken only if it is still the newest step -- the single-flight
    // keeps every other what-if out, and a step pushed on top meanwhile is
    // left alone (undoing the run's step later re-writes the value already
    // restored).
    {
        let mut stack = state.undo_stack.lock().unwrap();
        if stack.top_undo_seq() == Some(run) && stack.undo_description() == Some(GOAL_SEEK_STEP) {
            stack.pop_undo();
        }
    }
    // Excel's Cancel also leaves the whole workbook calculated [LIVE: under
    // manual calculation, Cancel in Goal Seek Status puts A1 back and
    // recalculates stale cells that never read it, CalculationState xlDone].
    calculate_workbook_at_run_end(state, states, &mut updated_cells);
    let restored = match previous.as_ref().map(|c| &c.value) {
        Some(CellValue::Number(n)) => *n,
        _ => 0.0,
    };
    GoalSeekResult {
        found_solution: false,
        variable_value: restored,
        target_result: 0.0,
        iterations: 0,
        original_variable_value: restored,
        updated_cells,
        error: None,
        undo_seq: None,
    }
}

/// The description of the one step a run pushes.
const GOAL_SEEK_STEP: &str = "Goal Seek";

/// The target's stored value as Goal Seek reads it: a number, or a logical
/// (TRUE = 1, FALSE = 0) -- [LIVE, Excel 16 COM] Goal Seek of `=A3>5` to 1 by
/// A3 returns True and leaves A3 = 6.12. Text, an error and an empty cell are
/// no number.
fn target_number(value: &CellValue) -> Option<f64> {
    match value {
        CellValue::Number(n) if n.is_finite() => Some(*n),
        CellValue::Boolean(b) => Some(if *b { 1.0 } else { 0.0 }),
        _ => None,
    }
}

/// The body of [`goal_seek`], callable without a Tauri runtime.
pub(crate) fn goal_seek_impl(
    state: &AppState,
    file_state: &FileState,
    states: &WhatIfStates<'_>,
    params: GoalSeekParams,
) -> GoalSeekResult {
    // ONE what-if run at a time, taken before every gate (see `begin_whatif_run`).
    let _run = match begin_whatif_run(state) {
        Ok(run) => run,
        Err(e) => return error_result(&e),
    };
    // BACKGROUND: up to 100 secant iterations, each a full dependent recalc
    // whose results are WRITTEN into the grid — the persisting ceiling, per
    // formula, with no aggregate cap (the 100-iteration bound already exists and
    // a second ceiling would abort legitimate convergence). Cancellable.
    let _pass = crate::eval_budget::begin_pass(
        crate::eval_budget::EvalSurface::Background,
        &state.calc_cancel,
    );
    crate::log_info!("GOALSEEK", "Starting: target=({},{}) value={} variable=({},{})",
        params.target_row, params.target_col, params.target_value,
        params.variable_row, params.variable_col);

    // (Sheet protection on the CHANGING cell is asked under the validation's
    // grid guards below, of the sheet the run writes -- rev13A.)

    // Check writeback region before acquiring other locks
    {
        let wb_index = state.writeback_index.lock().unwrap();
        if !wb_index.is_empty() {
            let active_sheet = *state.active_sheet.read().unwrap();
            let sheet_ids = state.sheet_ids.read().unwrap();
            if let Some(&sid) = sheet_ids.get(active_sheet) {
                if wb_index.contains(sid, params.variable_row, params.variable_col) {
                    return error_result(&format!(
                        "Cell at row {}, column {} is in a writeback region and cannot be used as a Goal Seek changing cell.",
                        params.variable_row + 1, params.variable_col + 1,
                    ));
                }
            }
        }
    }

    let target_pos = (params.target_row, params.target_col);
    let variable_pos = (params.variable_row, params.variable_col);

    // --- Validation, under the grid locks; every guard dropped before a trial
    // writes (the cascade takes them itself) ---
    let (effect, run_sheet, original_cell, original_value, variable_style_index) = {
        let grid = state.grid.lock_pending().unwrap();
        let grids = state.grids.lock_pending().unwrap();
        let active_sheet = *state.active_sheet.read().unwrap();

        // 0. Sheet protection on the CHANGING cell: Goal Seek writes it
        // permanently, so a locked cell refuses the run. Asked under these
        // guards, of the sheet the run writes (rev13A: it read the active
        // sheet before taking them).
        if let Err(e) = check_run_protection_held(state, &grid, &grids, active_sheet, |kinds, protection, sheet, styles| {
            crate::protection::check_sheet_protection_range_in(
                kinds,
                protection,
                sheet,
                styles,
                active_sheet,
                params.variable_row,
                params.variable_col,
                params.variable_row,
                params.variable_col,
            )
        }) {
            return error_result(&e);
        }

        // 1. Target cell must contain a formula
        let target_cell = grid.get_cell(params.target_row, params.target_col);
        if target_cell.and_then(|cell| cell.formula_string()).is_none() {
            return error_result("Cell must contain a formula");
        }
        // ...whose value is a number now. [LIVE, Excel 16 COM] a target that
        // currently holds text (`="x"&A2`, `=""`) or an error (`=1/A2` with A2
        // = 0) is refused before anything is written -- the changing cell
        // keeps its value and Workbook.Saved stays True (the UI dialog refuses
        // the same way). This run used to write a trial, find no number, put
        // the cell back and report the error with the document dirtied and no
        // undo step. A logical counts (TRUE = 1), as in Excel.
        if target_cell.and_then(|cell| target_number(&cell.value)).is_none() {
            return error_result("Target formula does not evaluate to a number");
        }

        // 2. Variable cell must NOT contain a formula
        let variable_cell = grid.get_cell(params.variable_row, params.variable_col).cloned();
        if variable_cell.as_ref().map_or(false, |c| c.has_formula()) {
            return error_result("Changing cell must not contain a formula");
        }

        // Save original variable value and style index for potential revert
        let original_value = match variable_cell.as_ref().map(|c| &c.value) {
            Some(CellValue::Number(n)) => *n,
            _ => 0.0,
        };
        let variable_style_index = variable_cell.as_ref().map_or(0, |c| c.style_index);

        // Every refusal is now behind us (sheet protection, writeback region,
        // target has a formula, variable has none), so from here the solver
        // WRITES into the grid. It is marked here rather than at the end because
        // even an unsuccessful run leaves the last trial in the changing cell,
        // as Excel's does [LIVE].
        let effect = DocumentEffect::mutates(file_state);
        let _grid = grid.authorize(&effect);
        let _grids = grids.authorize(&effect);
        // The run's sheet by stable id: every trial, read-back and the undo
        // step follow it if a tab moves while the run is going.
        let run_sheet = RunSheet::at(state, active_sheet);
        (effect, run_sheet, variable_cell, original_value, variable_style_index)
    };

    // One trial: the changing cell written, every dependent recalculated
    // through the shared cascade, the target's stored value read back. A write
    // that FAILED -- the run's sheet deleted mid-run (`WHATIF_SHEET_GONE`) -- is
    // an error, never "the target is no number" (rev13A: it was swallowed into
    // a silent "no solution, NaN").
    let trial = |x: f64, updated: &mut Vec<crate::api_types::CellData>| -> Result<Option<f64>, String> {
        let mut cell = Cell::new_number(x);
        cell.style_index = variable_style_index;
        write_cells_and_recalc_in(
            state,
            states,
            &effect,
            run_sheet,
            &[(variable_pos, Some(cell))],
            RecalcMode::Always,
            updated,
        )?;
        Ok(target_number(&stored_value_in(state, run_sheet, target_pos.0, target_pos.1)))
    };
    let mut sink = Vec::new();
    // The last value tried: what a search that finds nothing leaves behind.
    let mut last_x = original_value;
    // The first failed write; the search stops on it and the run reports it.
    let mut failed: Option<String> = None;
    let mut probe = |x: f64| -> Option<f64> {
        sink.clear();
        last_x = x;
        match trial(x, &mut sink) {
            Ok(target) => target,
            Err(e) => {
                failed.get_or_insert(e);
                None
            }
        }
    };

    let goal = params.target_value;
    let max_iter = params.max_iterations;
    let tol = params.tolerance;

    // --- Secant Method Solver ---

    // A trial whose target is no number ends the search with nothing found,
    // leaving that trial in the changing cell -- the first two probes as much
    // as any later one. [LIVE, Excel 16 COM] `=IF(A4>5,"big",A4)` sought to 10
    // by A4 = 1 returns False and leaves A4 = 5.00000000022352, the trial that
    // turned it into text. A target that is no number BEFORE the run was
    // refused above, before anything was written.
    let (best_x, iterations, found) = 'solve: {
        // Initial point: current variable value
        let mut x0 = original_value;
        let mut f0 = match probe(x0) {
            Some(v) => v - goal,
            None => break 'solve (x0, 0, false),
        };

        // Check if already at the solution
        if f0.abs() < tol {
            break 'solve (x0, 0, true);
        }

        // Second point: perturb slightly for secant method
        let mut x1 = if x0.abs() < 1e-10 { 0.001 } else { x0 * 1.001 };
        let mut f1 = match probe(x1) {
            Some(v) => v - goal,
            None => break 'solve (x1, 0, false),
        };

        if f1.abs() < tol {
            break 'solve (x1, 1, true);
        }

        let mut iterations: u32 = 0;
        let mut best_x = if f0.abs() < f1.abs() { x0 } else { x1 };
        let mut best_f = f0.abs().min(f1.abs());

        for _ in 0..max_iter {
            iterations += 1;

            let denominator = f1 - f0;
            if denominator.abs() < 1e-15 {
                // Derivative effectively zero - try a bigger perturbation
                x1 = x1 + if x1.abs() < 1e-10 { 1.0 } else { x1 * 0.1 };
                f1 = match probe(x1) {
                    Some(v) => v - goal,
                    None => break,
                };
                if f1.abs() < tol {
                    best_x = x1;
                    best_f = f1.abs();
                    break;
                }
                if f1.abs() < best_f {
                    best_f = f1.abs();
                    best_x = x1;
                }
                continue;
            }

            // Secant step
            let x_new = x1 - f1 * (x1 - x0) / denominator;

            // Clamp step size to prevent wild divergence
            let step = x_new - x1;
            let max_step = (x1 - x0).abs() * 10.0 + 1.0;
            let x_new = if step.abs() > max_step {
                x1 + step.signum() * max_step
            } else {
                x_new
            };

            let f_new = match probe(x_new) {
                Some(v) => v - goal,
                None => break,
            };

            if f_new.abs() < best_f {
                best_f = f_new.abs();
                best_x = x_new;
            }

            if f_new.abs() < tol {
                break;
            }

            // Advance for next iteration
            x0 = x1;
            f0 = f1;
            x1 = x_new;
            f1 = f_new;
        }
        (best_x, iterations, best_f < tol)
    };
    drop(probe);

    // A trial that could not be written (the sheet is gone) ends the run with
    // that error: there is no sheet to leave a value on and no step to take
    // back.
    if let Some(e) = failed {
        return error_result(&e);
    }

    // A search that finds nothing leaves its LAST trial in the changing cell,
    // as Excel does [LIVE: Goal Seek of `G1 = 5` to 7 by F1 = 10 returned False
    // and left F1 at -1006629.96, its last trial]. This used to write the best
    // trial instead -- for a target that does not depend on the changing cell
    // that is the second probe, `x0*1.001`, every time.
    let final_x = if found { best_x } else { last_x };
    crate::log_info!("GOALSEEK", "Done: found={} value={} iters={}", found, final_x, iterations);

    // The answer, written like any trial; this reply repaints every cell the
    // cascade re-evaluated, on every sheet.
    let mut updated_cells = Vec::new();
    let target_result = match trial(final_x, &mut updated_cells) {
        Ok(target) => target.unwrap_or(f64::NAN),
        // The sheet went between the last trial and the answer.
        Err(e) => return error_result(&e),
    };

    // ONE undo step that puts the changing cell back EXACTLY as it was -- a
    // text, an empty cell or a number, with its own format -- through the
    // restore Ctrl+Z uses, which recalculates its dependents. Pushed as a step
    // of its OWN (never joined to a stranger's open transaction) and the id it
    // was stamped with handed back, so the status dialog's Cancel can take back
    // THIS step and nothing else, leaving no redo step (`cancel_goal_seek_impl`).
    // Every guard is released here, so the stack is taken alone.
    // The sheet as it is NOW (a tab may have moved during the run); a sheet
    // deleted mid-run leaves nothing to take back.
    let undo_seq = run_sheet.index(state).and_then(|sheet| {
        let mut step = engine::Transaction::new(GOAL_SEEK_STEP);
        step.add_change(engine::CellChange::SetCell {
            sheet,
            row: variable_pos.0,
            col: variable_pos.1,
            previous: original_cell.clone(),
        });
        state.undo_stack.lock().unwrap().push_own_step(step)
    });

    // Found or not, the run ends with the WHOLE workbook calculated, as Excel's
    // does under manual calculation [LIVE]: every stale cell on every sheet,
    // and the "calculation incomplete" mark cleared (see
    // `calculate_workbook_at_run_end`). The trials above stayed seeded.
    calculate_workbook_at_run_end(state, states, &mut updated_cells);

    GoalSeekResult {
        found_solution: found,
        variable_value: final_x,
        target_result,
        iterations,
        original_variable_value: original_value,
        updated_cells,
        error: None,
        undo_seq,
    }
}
