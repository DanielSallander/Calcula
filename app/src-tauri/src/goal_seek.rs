//! FILENAME: app/src-tauri/src/goal_seek.rs
// PURPOSE: Goal Seek solver - iterative single-variable numerical solver.
// CONTEXT: Uses the secant method to find a variable cell value that makes
//          a target formula evaluate to a desired result.

use std::collections::{HashMap, HashSet};
use tauri::State;

use crate::api_types::{CellData, GoalSeekParams, GoalSeekResult};
use crate::{
    evaluate_formula_multi_sheet,
    format_cell_value, get_column_row_dependents, get_recalculation_order, AppState,
};
use engine::{Cell, CellValue, Grid, StyleRegistry};

// ============================================================================
// Dependency verification
// ============================================================================

/// Check if the target cell transitively depends on the variable cell.
/// Uses BFS through the dependents map (variable -> ... -> target).
fn variable_affects_target(
    variable_pos: (u32, u32),
    target_pos: (u32, u32),
    dependents: &HashMap<(u32, u32), HashSet<(u32, u32)>>,
    column_dependents: &HashMap<u32, HashSet<(u32, u32)>>,
    row_dependents: &HashMap<u32, HashSet<(u32, u32)>>,
) -> bool {
    let mut visited = HashSet::new();
    let mut stack = vec![variable_pos];

    while let Some(cell) = stack.pop() {
        if cell == target_pos {
            return true;
        }
        if visited.contains(&cell) {
            continue;
        }
        visited.insert(cell);

        // Direct cell-to-cell dependents
        if let Some(deps) = dependents.get(&cell) {
            for dep in deps {
                if !visited.contains(dep) {
                    stack.push(*dep);
                }
            }
        }
    }

    // Also check column-level and row-level dependents for the variable cell
    // (e.g., formulas using whole-column references like A:A)
    let (var_row, var_col) = variable_pos;
    if let Some(col_deps) = column_dependents.get(&var_col) {
        if col_deps.contains(&target_pos) {
            return true;
        }
    }
    if let Some(row_deps) = row_dependents.get(&var_row) {
        if row_deps.contains(&target_pos) {
            return true;
        }
    }

    false
}

// ============================================================================
// Solver helper
// ============================================================================

/// Set the variable cell to a numeric value in the grids array and evaluate
/// the target formula. Returns the numeric result, or None if non-numeric.
fn evaluate_target(
    grids: &mut [Grid],
    sheet_names: &[String],
    active_sheet: usize,
    variable_pos: (u32, u32),
    variable_style_index: usize,
    target_formula: &str,
    value: f64,
) -> Option<f64> {
    // Create a cell with the trial value, preserving the original style
    let mut var_cell = Cell::new_number(value);
    var_cell.style_index = variable_style_index;

    // Set in the active sheet's grid
    grids[active_sheet].set_cell(variable_pos.0, variable_pos.1, var_cell);

    // Evaluate the target formula in multi-sheet context
    let result = evaluate_formula_multi_sheet(
        grids,
        sheet_names,
        active_sheet,
        target_formula,
    );

    match result {
        CellValue::Number(n) if n.is_finite() => Some(n),
        _ => None,
    }
}

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
    }
}

// ============================================================================
// Tauri command
// ============================================================================

#[tauri::command]
pub fn goal_seek(
    state: State<AppState>,
    params: GoalSeekParams,
) -> GoalSeekResult {
    crate::log_info!("GOALSEEK", "Starting: target=({},{}) value={} variable=({},{})",
        params.target_row, params.target_col, params.target_value,
        params.variable_row, params.variable_col);

    // Acquire locks (same order as update_cell to avoid deadlocks)
    let mut grid = state.grid.lock().unwrap();
    let mut grids = state.grids.lock().unwrap();
    let active_sheet = *state.active_sheet.lock().unwrap();
    let sheet_names = state.sheet_names.lock().unwrap();
    let styles = state.style_registry.lock().unwrap();
    let dependents_map = state.dependents.lock().unwrap();
    let column_dependents_map = state.column_dependents.lock().unwrap();
    let row_dependents_map = state.row_dependents.lock().unwrap();
    let merged_regions = state.merged_regions.lock().unwrap();

    let target_pos = (params.target_row, params.target_col);
    let variable_pos = (params.variable_row, params.variable_col);

    // --- Validation ---

    // 1. Target cell must contain a formula
    let target_formula = match grid.get_cell(params.target_row, params.target_col) {
        Some(cell) => match &cell.formula {
            Some(f) => f.clone(),
            None => return error_result("Cell must contain a formula"),
        },
        None => return error_result("Cell must contain a formula"),
    };

    // 2. Variable cell must NOT contain a formula
    let variable_cell = grid.get_cell(params.variable_row, params.variable_col);
    if variable_cell.map_or(false, |c| c.formula.is_some()) {
        return error_result("Changing cell must not contain a formula");
    }

    // Save original variable value and style index for potential revert
    let original_value = match variable_cell.map(|c| &c.value) {
        Some(CellValue::Number(n)) => *n,
        Some(CellValue::Empty) | None => 0.0,
        _ => 0.0,
    };
    let variable_style_index = variable_cell.map_or(0, |c| c.style_index);

    // 3. Dependency verification: target must depend on variable
    if !variable_affects_target(
        variable_pos,
        target_pos,
        &dependents_map,
        &column_dependents_map,
        &row_dependents_map,
    ) {
        return error_result("Target cell formula does not depend on the changing cell");
    }

    let goal = params.target_value;
    let max_iter = params.max_iterations;
    let tol = params.tolerance;

    // --- Secant Method Solver ---

    // Initial point: current variable value
    let mut x0 = original_value;
    let f0_eval = evaluate_target(
        &mut grids, &sheet_names, active_sheet,
        variable_pos, variable_style_index, &target_formula, x0,
    );
    let mut f0 = match f0_eval {
        Some(v) => v - goal,
        None => {
            // Restore original value
            let mut restore_cell = Cell::new_number(original_value);
            restore_cell.style_index = variable_style_index;
            grids[active_sheet].set_cell(variable_pos.0, variable_pos.1, restore_cell);
            return error_result("Target formula does not evaluate to a number");
        }
    };

    // Check if already at the solution
    if f0.abs() < tol {
        // Already solved - still need to build updated_cells
        // Fall through to finalization with x0 as the answer
        return finalize_result(
            &mut grid, &mut grids, &styles, &merged_regions,
            &dependents_map, &column_dependents_map, &row_dependents_map,
            &sheet_names, active_sheet,
            variable_pos, variable_style_index,
            target_pos, &target_formula,
            x0, original_value, 0, true,
        );
    }

    // Second point: perturb slightly for secant method
    let mut x1 = if x0.abs() < 1e-10 { 0.001 } else { x0 * 1.001 };
    let f1_eval = evaluate_target(
        &mut grids, &sheet_names, active_sheet,
        variable_pos, variable_style_index, &target_formula, x1,
    );
    let mut f1 = match f1_eval {
        Some(v) => v - goal,
        None => {
            let mut restore_cell = Cell::new_number(original_value);
            restore_cell.style_index = variable_style_index;
            grids[active_sheet].set_cell(variable_pos.0, variable_pos.1, restore_cell);
            return error_result("Target formula does not evaluate to a number");
        }
    };

    if f1.abs() < tol {
        return finalize_result(
            &mut grid, &mut grids, &styles, &merged_regions,
            &dependents_map, &column_dependents_map, &row_dependents_map,
            &sheet_names, active_sheet,
            variable_pos, variable_style_index,
            target_pos, &target_formula,
            x1, original_value, 1, true,
        );
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
            f1 = match evaluate_target(
                &mut grids, &sheet_names, active_sheet,
                variable_pos, variable_style_index, &target_formula, x1,
            ) {
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

        let f_new = match evaluate_target(
            &mut grids, &sheet_names, active_sheet,
            variable_pos, variable_style_index, &target_formula, x_new,
        ) {
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

    let found = best_f < tol;

    crate::log_info!("GOALSEEK", "Done: found={} value={} residual={} iters={}",
        found, best_x, best_f, iterations);

    finalize_result(
        &mut grid, &mut grids, &styles, &merged_regions,
        &dependents_map, &column_dependents_map, &row_dependents_map,
        &sheet_names, active_sheet,
        variable_pos, variable_style_index,
        target_pos, &target_formula,
        best_x, original_value, iterations, found,
    )
}

// ============================================================================
// Finalization: apply result and build updated cells
// ============================================================================

#[allow(clippy::too_many_arguments)]
fn finalize_result(
    grid: &mut Grid,
    grids: &mut [Grid],
    styles: &StyleRegistry,
    merged_regions: &HashSet<crate::api_types::MergedRegion>,
    dependents_map: &HashMap<(u32, u32), HashSet<(u32, u32)>>,
    column_dependents_map: &HashMap<u32, HashSet<(u32, u32)>>,
    row_dependents_map: &HashMap<u32, HashSet<(u32, u32)>>,
    sheet_names: &[String],
    active_sheet: usize,
    variable_pos: (u32, u32),
    variable_style_index: usize,
    target_pos: (u32, u32),
    target_formula: &str,
    final_value: f64,
    original_value: f64,
    iterations: u32,
    found: bool,
) -> GoalSeekResult {
    // 1. Set the final value in the variable cell
    let mut final_cell = Cell::new_number(final_value);
    final_cell.style_index = variable_style_index;
    grids[active_sheet].set_cell(variable_pos.0, variable_pos.1, final_cell.clone());
    grid.set_cell(variable_pos.0, variable_pos.1, final_cell);

    // 2. Re-evaluate the target cell to get its final display value
    let target_result_value = evaluate_formula_multi_sheet(
        grids,
        sheet_names,
        active_sheet,
        target_formula,
    );
    let target_result_num = match &target_result_value {
        CellValue::Number(n) => *n,
        _ => f64::NAN,
    };

    // Update the target cell value in the grid
    if let Some(target_cell) = grids[active_sheet].get_cell(target_pos.0, target_pos.1).cloned() {
        let mut updated_target = target_cell;
        updated_target.value = target_result_value.clone();
        grids[active_sheet].set_cell(target_pos.0, target_pos.1, updated_target.clone());
        grid.set_cell(target_pos.0, target_pos.1, updated_target);
    }

    // 3. Re-evaluate all dependents of the variable cell
    let mut recalc_order = get_recalculation_order(variable_pos, dependents_map);
    // Also get column/row dependents
    let extra_deps = get_column_row_dependents(variable_pos, column_dependents_map, row_dependents_map);
    for dep in &extra_deps {
        if !recalc_order.contains(dep) {
            recalc_order.push(*dep);
        }
    }

    for &(r, c) in &recalc_order {
        if let Some(cell) = grids[active_sheet].get_cell(r, c).cloned() {
            if let Some(formula) = &cell.formula {
                let new_value = evaluate_formula_multi_sheet(
                    grids,
                    sheet_names,
                    active_sheet,
                    formula,
                );
                let mut updated = cell;
                updated.value = new_value;
                grids[active_sheet].set_cell(r, c, updated.clone());
                grid.set_cell(r, c, updated);
            }
        }
    }

    // 4. Build updated_cells vector
    let mut updated_cells = Vec::new();

    // Helper to build CellData
    let build_cell_data = |g: &Grid, r: u32, c: u32| -> Option<CellData> {
        let cell = g.get_cell(r, c)?;
        let style = styles.get(cell.style_index);
        let display = format_cell_value(&cell.value, style);

        let merge = merged_regions.iter().find(|m| m.start_row == r && m.start_col == c);
        let (row_span, col_span) = match merge {
            Some(m) => (m.end_row - m.start_row + 1, m.end_col - m.start_col + 1),
            None => (1, 1),
        };

        Some(CellData {
            row: r,
            col: c,
            display,
            formula: cell.formula.clone(),
            style_index: cell.style_index,
            row_span,
            col_span,
            sheet_index: None,
        })
    };

    // Variable cell
    if let Some(cd) = build_cell_data(&grids[active_sheet], variable_pos.0, variable_pos.1) {
        updated_cells.push(cd);
    }

    // Target cell
    if let Some(cd) = build_cell_data(&grids[active_sheet], target_pos.0, target_pos.1) {
        updated_cells.push(cd);
    }

    // Dependent cells
    for &(r, c) in &recalc_order {
        if (r, c) != target_pos && (r, c) != variable_pos {
            if let Some(cd) = build_cell_data(&grids[active_sheet], r, c) {
                updated_cells.push(cd);
            }
        }
    }

    GoalSeekResult {
        found_solution: found,
        variable_value: final_value,
        target_result: target_result_num,
        iterations,
        original_variable_value: original_value,
        updated_cells,
        error: None,
    }
}
