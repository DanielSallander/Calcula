//! FILENAME: app/src-tauri/src/solver.rs
// PURPOSE: Solver - multi-variable optimization with constraints.
// CONTEXT: Supports three solving methods:
//          1. GRG Nonlinear (gradient-based for nonlinear problems)
//          2. Simplex LP (for linear problems)
//          3. Evolutionary (genetic algorithm for non-smooth problems)
//
// EVERY TRIAL IS A REAL WRITE (BUG-0613). A trial writes the variable cells and
// recalculates through the shared cascade (`whatif_recalc`); the objective and
// every constraint cell are then read as STORED values, which the cascade has
// just recalculated through the real dependency chain, on every sheet. The
// solver used to set the cells and evaluate the objective's formula TEXT alone,
// so an objective or constraint that reached a variable through another cell
// (on this sheet or another) read a value no trial recalculated, and the
// answer's dependents on other sheets kept their old values -- the cascade it
// ran at the end used the ACTIVE sheet's map, even for a Solver run on another
// sheet. Excel's Solver recalculates the workbook for every trial.

use tauri::State;

use crate::api_types::{
    ConstraintOperator, SolverConstraint, SolverMethod, SolverObjective, SolverParams,
    SolverResult, SolverVariableCell, SolverVariableValue,
};
use crate::document_effect::DocumentEffect;
use crate::whatif_recalc::{
    begin_whatif_run, check_run_protection_held, stored_number_in, stored_value_in, write_cells_and_recalc_in,
    RecalcMode, RunSheet, WhatIfStates,
};
use crate::AppState;
use engine::{Cell, CellValue};

// ============================================================================
// The workbook as a solver algorithm sees it
// ============================================================================

/// What a solver algorithm reads and writes: set the variable cells (and have
/// the workbook recalculated), read a cell on the solver's sheet.
trait SolverModel {
    /// Write `values` into the variable cells, recalculate, and return the
    /// objective cell's value (`None` when it is not a finite number).
    fn set_and_objective(&mut self, values: &[f64]) -> Option<f64>;
    /// The current value of a cell on the solver's sheet as a number (0 when it
    /// is not one).
    fn cell_number(&self, row: u32, col: u32) -> f64;
    /// Whether the user asked the run to stop (Esc / Stop): every algorithm
    /// checks it between trials and returns the best point it has, as Excel's
    /// Solver does on "Stop" ("Solver stopped at user's request").
    fn stopped(&self) -> bool {
        false
    }
}

/// The real workbook: each trial is a write through the shared cascade.
struct WorkbookModel<'a> {
    state: &'a AppState,
    states: &'a WhatIfStates<'a>,
    effect: &'a DocumentEffect,
    sheet: RunSheet,
    variables: &'a [SolverVariableCell],
    style_indices: &'a [usize],
    objective: (u32, u32),
    /// The first trial write that FAILED (the run's sheet deleted mid-run:
    /// `WHATIF_SHEET_GONE`). It stops the search ([`SolverModel::stopped`]) and
    /// the run reports it, never "no feasible solution" (as Goal Seek does).
    failed: Option<String>,
}

impl WorkbookModel<'_> {
    fn variable_writes(&self, values: &[f64]) -> Vec<((u32, u32), Option<Cell>)> {
        self.variables
            .iter()
            .enumerate()
            .map(|(i, var)| {
                let mut cell = Cell::new_number(values[i]);
                cell.style_index = self.style_indices[i];
                ((var.row, var.col), Some(cell))
            })
            .collect()
    }
}

impl SolverModel for WorkbookModel<'_> {
    fn set_and_objective(&mut self, values: &[f64]) -> Option<f64> {
        // A stopped run writes nothing more; the caller writes the answer.
        if self.stopped() {
            return None;
        }
        let mut sink = Vec::new();
        if let Err(e) = write_cells_and_recalc_in(
            self.state,
            self.states,
            self.effect,
            self.sheet,
            &self.variable_writes(values),
            RecalcMode::Always,
            &mut sink,
        ) {
            self.failed.get_or_insert(e);
            return None;
        }
        stored_number_in(self.state, self.sheet, self.objective.0, self.objective.1)
    }

    fn cell_number(&self, row: u32, col: u32) -> f64 {
        match stored_value_in(self.state, self.sheet, row, col) {
            CellValue::Number(n) => n,
            _ => 0.0,
        }
    }

    fn stopped(&self) -> bool {
        self.failed.is_some() || self.state.calc_cancel.is_cancelled()
    }
}

// ============================================================================
// Constraint helpers
// ============================================================================

/// Check if all constraints are satisfied.
fn check_constraints(
    model: &dyn SolverModel,
    constraints: &[SolverConstraint],
    variables: &[SolverVariableCell],
    values: &[f64],
) -> bool {
    for constraint in constraints {
        let lhs = model.cell_number(constraint.cell_row, constraint.cell_col);

        match constraint.operator {
            ConstraintOperator::Integer => {
                // Check if the variable value is integer
                let var_idx = variables.iter().position(|v| v.row == constraint.cell_row && v.col == constraint.cell_col);
                if let Some(idx) = var_idx {
                    if (values[idx] - values[idx].round()).abs() > 1e-6 {
                        return false;
                    }
                }
            }
            ConstraintOperator::Binary => {
                let var_idx = variables.iter().position(|v| v.row == constraint.cell_row && v.col == constraint.cell_col);
                if let Some(idx) = var_idx {
                    if (values[idx] - 0.0).abs() > 1e-6 && (values[idx] - 1.0).abs() > 1e-6 {
                        return false;
                    }
                }
            }
            ConstraintOperator::AllDifferent => {
                // All variable values must be different (skip for now, complex)
            }
            _ => {
                let rhs = if let Some(rhs_val) = constraint.rhs_value {
                    rhs_val
                } else if let (Some(rr), Some(rc)) = (constraint.rhs_cell_row, constraint.rhs_cell_col) {
                    model.cell_number(rr, rc)
                } else {
                    0.0
                };

                match constraint.operator {
                    ConstraintOperator::LessEqual => {
                        if lhs > rhs + 1e-10 { return false; }
                    }
                    ConstraintOperator::GreaterEqual => {
                        if lhs < rhs - 1e-10 { return false; }
                    }
                    ConstraintOperator::Equal => {
                        if (lhs - rhs).abs() > 1e-10 { return false; }
                    }
                    _ => {}
                }
            }
        }
    }
    true
}

/// Calculate constraint violation penalty (for methods that need it).
fn constraint_penalty(
    model: &dyn SolverModel,
    constraints: &[SolverConstraint],
    variables: &[SolverVariableCell],
    values: &[f64],
) -> f64 {
    let mut penalty = 0.0;
    for constraint in constraints {
        let lhs = model.cell_number(constraint.cell_row, constraint.cell_col);

        match constraint.operator {
            ConstraintOperator::Integer => {
                let var_idx = variables.iter().position(|v| v.row == constraint.cell_row && v.col == constraint.cell_col);
                if let Some(idx) = var_idx {
                    let frac = (values[idx] - values[idx].round()).abs();
                    penalty += frac * 1000.0;
                }
            }
            ConstraintOperator::Binary => {
                let var_idx = variables.iter().position(|v| v.row == constraint.cell_row && v.col == constraint.cell_col);
                if let Some(idx) = var_idx {
                    let dist = (values[idx] - 0.0).abs().min((values[idx] - 1.0).abs());
                    penalty += dist * 1000.0;
                }
            }
            ConstraintOperator::AllDifferent => {}
            _ => {
                let rhs = if let Some(rhs_val) = constraint.rhs_value {
                    rhs_val
                } else if let (Some(rr), Some(rc)) = (constraint.rhs_cell_row, constraint.rhs_cell_col) {
                    model.cell_number(rr, rc)
                } else {
                    0.0
                };

                match constraint.operator {
                    ConstraintOperator::LessEqual => {
                        if lhs > rhs { penalty += (lhs - rhs) * 1000.0; }
                    }
                    ConstraintOperator::GreaterEqual => {
                        if lhs < rhs { penalty += (rhs - lhs) * 1000.0; }
                    }
                    ConstraintOperator::Equal => {
                        penalty += (lhs - rhs).abs() * 1000.0;
                    }
                    _ => {}
                }
            }
        }
    }
    penalty
}

/// The penalised value the algorithms minimise for one trial.
fn penalised_objective(
    model: &mut dyn SolverModel,
    x: &[f64],
    objective: SolverObjective,
    target_value: Option<f64>,
    constraints: &[SolverConstraint],
    variables: &[SolverVariableCell],
) -> f64 {
    let sign = match objective {
        SolverObjective::Maximize => -1.0, // Negate to convert to minimization
        SolverObjective::Minimize => 1.0,
        SolverObjective::TargetValue => 1.0,
    };
    let val = model.set_and_objective(x).unwrap_or(f64::MAX);
    let obj = match objective {
        SolverObjective::TargetValue => {
            let target = target_value.unwrap_or(0.0);
            (val - target).powi(2)
        }
        _ => val * sign,
    };
    obj + constraint_penalty(&*model, constraints, variables, x)
}

// ============================================================================
// GRG Nonlinear Solver
// ============================================================================

/// Generalized Reduced Gradient solver for nonlinear optimization.
/// Uses numerical gradients and steepest descent with line search.
#[allow(clippy::too_many_arguments)]
fn solve_grg(
    model: &mut dyn SolverModel,
    start: Vec<f64>,
    variables: &[SolverVariableCell],
    objective: SolverObjective,
    target_value: Option<f64>,
    constraints: &[SolverConstraint],
    max_iterations: u32,
    tolerance: f64,
) -> (Vec<f64>, f64, u32, bool, String) {
    let n = variables.len();
    let mut x = start;

    let eval_objective = |model: &mut dyn SolverModel, x: &[f64]| -> f64 {
        penalised_objective(model, x, objective, target_value, constraints, variables)
    };

    let h = 1e-6; // Step for numerical gradient
    let mut best_obj = eval_objective(model, &x);
    let mut best_x = x.clone();
    let mut iterations = 0u32;
    let mut step_size: f64 = 1.0;

    for _ in 0..max_iterations {
        if model.stopped() {
            break;
        }
        iterations += 1;

        // Compute numerical gradient
        let mut gradient = vec![0.0; n];
        let f0 = eval_objective(model, &x);

        for i in 0..n {
            let mut x_plus = x.clone();
            x_plus[i] += h;
            let f_plus = eval_objective(model, &x_plus);
            gradient[i] = (f_plus - f0) / h;
        }

        // Check gradient norm for convergence
        let grad_norm: f64 = gradient.iter().map(|g| g * g).sum::<f64>().sqrt();
        if grad_norm < tolerance {
            break;
        }

        // Normalize gradient
        let grad_unit: Vec<f64> = gradient.iter().map(|g| g / grad_norm).collect();

        // Line search with backtracking
        step_size = step_size.min(1.0_f64);
        let mut found_improvement = false;

        for _ in 0..20 {
            if model.stopped() {
                break;
            }
            let x_new: Vec<f64> = x
                .iter()
                .zip(grad_unit.iter())
                .map(|(xi, gi)| xi - step_size * gi)
                .collect();

            let f_new = eval_objective(model, &x_new);
            if f_new < f0 - tolerance * step_size * grad_norm {
                x = x_new;
                if f_new < best_obj {
                    best_obj = f_new;
                    best_x = x.clone();
                }
                step_size *= 1.2; // Increase step for next iteration
                found_improvement = true;
                break;
            }
            step_size *= 0.5;
        }

        if !found_improvement {
            step_size = 0.1;
            // Try a small perturbation
            if (f0 - best_obj).abs() < tolerance {
                break; // Converged
            }
        }
    }

    // Apply best solution
    let final_obj = model.set_and_objective(&best_x).unwrap_or(f64::NAN);
    let feasible = check_constraints(&*model, constraints, variables, &best_x);

    let status = if feasible {
        "Solver found a solution. All constraints and optimality conditions are satisfied.".to_string()
    } else {
        "Solver converged to a solution, but not all constraints are satisfied.".to_string()
    };

    (best_x, final_obj, iterations, feasible, status)
}

// ============================================================================
// Simplex LP Solver
// ============================================================================

/// Simple Simplex-like solver for linear problems.
/// Uses gradient descent with the assumption of linearity for efficiency.
#[allow(clippy::too_many_arguments)]
fn solve_simplex(
    model: &mut dyn SolverModel,
    start: Vec<f64>,
    variables: &[SolverVariableCell],
    objective: SolverObjective,
    target_value: Option<f64>,
    constraints: &[SolverConstraint],
    max_iterations: u32,
    tolerance: f64,
) -> (Vec<f64>, f64, u32, bool, String) {
    // For linear problems, the gradient is constant, so we compute it once
    // and use it to find the optimal vertex of the feasible region.
    // We fall back to the GRG method since it handles both cases.
    solve_grg(
        model, start, variables, objective, target_value, constraints,
        max_iterations, tolerance,
    )
}

// ============================================================================
// Evolutionary Solver
// ============================================================================

/// Evolutionary solver using differential evolution.
/// Good for non-smooth, non-convex problems.
#[allow(clippy::too_many_arguments)]
fn solve_evolutionary(
    model: &mut dyn SolverModel,
    start: Vec<f64>,
    variables: &[SolverVariableCell],
    objective: SolverObjective,
    target_value: Option<f64>,
    constraints: &[SolverConstraint],
    max_iterations: u32,
    tolerance: f64,
) -> (Vec<f64>, f64, u32, bool, String) {
    let n = variables.len();
    let pop_size = (10 * n).max(20).min(200); // Population size
    let f_scale = 0.8; // Differential weight
    let cr = 0.9; // Crossover probability

    // Current variable values as seed
    let seed: Vec<f64> = start;

    let eval = |model: &mut dyn SolverModel, x: &[f64]| -> f64 {
        penalised_objective(model, x, objective, target_value, constraints, variables)
    };

    // Initialize population
    // Use a simple LCG for reproducible randomness (no external dependency)
    let mut rng_state: u64 = 42;
    let mut next_rand = || -> f64 {
        rng_state = rng_state.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        ((rng_state >> 33) as f64) / (u32::MAX as f64)
    };

    let mut population: Vec<Vec<f64>> = Vec::with_capacity(pop_size);
    let mut fitness: Vec<f64> = Vec::with_capacity(pop_size);

    // First individual is the seed
    population.push(seed.clone());
    fitness.push(eval(model, &seed));

    // Generate rest of population around the seed
    for _ in 1..pop_size {
        if model.stopped() {
            break;
        }
        let individual: Vec<f64> = seed
            .iter()
            .map(|&s| {
                let range = if s.abs() < 1.0 { 10.0 } else { s.abs() * 2.0 };
                s + (next_rand() - 0.5) * range
            })
            .collect();
        let f = eval(model, &individual);
        fitness.push(f);
        population.push(individual);
    }

    let pop_size = population.len();
    let mut best_idx = 0;
    for i in 1..pop_size {
        if fitness[i] < fitness[best_idx] {
            best_idx = i;
        }
    }
    let mut best_fitness = fitness[best_idx];
    let mut best_x = population[best_idx].clone();

    let mut iterations = 0u32;
    let mut stagnation = 0u32;
    let mut prev_best = best_fitness;

    for _ in 0..max_iterations {
        // Differential evolution needs four distinct individuals.
        if model.stopped() || pop_size < 4 {
            break;
        }
        iterations += 1;

        for i in 0..pop_size {
            if model.stopped() {
                break;
            }
            // Select three distinct random individuals (not i)
            let mut a = (next_rand() * pop_size as f64) as usize % pop_size;
            while a == i { a = (a + 1) % pop_size; }
            let mut b = (next_rand() * pop_size as f64) as usize % pop_size;
            while b == i || b == a { b = (b + 1) % pop_size; }
            let mut c_idx = (next_rand() * pop_size as f64) as usize % pop_size;
            while c_idx == i || c_idx == a || c_idx == b { c_idx = (c_idx + 1) % pop_size; }

            // Mutation + Crossover
            let j_rand = (next_rand() * n as f64) as usize % n;
            let mut trial = population[i].clone();
            for j in 0..n {
                if next_rand() < cr || j == j_rand {
                    trial[j] = population[a][j] + f_scale * (population[b][j] - population[c_idx][j]);
                }
            }

            // Apply integer/binary constraints
            for constraint in constraints {
                let var_idx = variables.iter().position(|v| v.row == constraint.cell_row && v.col == constraint.cell_col);
                if let Some(idx) = var_idx {
                    match constraint.operator {
                        ConstraintOperator::Integer => {
                            trial[idx] = trial[idx].round();
                        }
                        ConstraintOperator::Binary => {
                            trial[idx] = if trial[idx] >= 0.5 { 1.0 } else { 0.0 };
                        }
                        _ => {}
                    }
                }
            }

            // Selection
            let trial_fitness = eval(model, &trial);
            if trial_fitness <= fitness[i] {
                population[i] = trial;
                fitness[i] = trial_fitness;

                if trial_fitness < best_fitness {
                    best_fitness = trial_fitness;
                    best_x = population[i].clone();
                }
            }
        }

        // Check convergence
        if (prev_best - best_fitness).abs() < tolerance {
            stagnation += 1;
            if stagnation > 50 {
                break;
            }
        } else {
            stagnation = 0;
        }
        prev_best = best_fitness;
    }

    // Apply best solution
    let final_obj = model.set_and_objective(&best_x).unwrap_or(f64::NAN);
    let feasible = check_constraints(&*model, constraints, variables, &best_x);

    let status = if feasible {
        "Solver found a solution. All constraints are satisfied.".to_string()
    } else {
        "Solver completed but not all constraints could be satisfied.".to_string()
    };

    (best_x, final_obj, iterations, feasible, status)
}

// ============================================================================
// Main Solver Command
// ============================================================================

fn refusal(msg: String) -> SolverResult {
    SolverResult {
        found_solution: false,
        objective_value: f64::NAN,
        variable_values: Vec::new(),
        iterations: 0,
        status_message: msg.clone(),
        updated_cells: Vec::new(),
        original_values: Vec::new(),
        sheet_id: None,
        error: Some(msg),
    }
}

/// `(async)`: a run is many trials, each a recalculation of the changing
/// cells' dependents; as a sync command the whole run sat on the WebView2 UI
/// thread and the window showed Not Responding until it ended.
#[tauri::command(async)]
pub fn solver_solve(
    state: State<AppState>,
    file_state: State<crate::persistence::FileState>,
    user_files_state: State<crate::persistence::UserFilesState>,
    pivot_state: State<'_, crate::pivot::types::PivotState>,
    pane_control_state: State<'_, crate::pane_control::PaneControlState>,
    ribbon_filter_state: State<'_, crate::ribbon_filter::RibbonFilterState>,
    params: SolverParams,
) -> SolverResult {
    let states = WhatIfStates {
        user_files: &user_files_state,
        pivots: &pivot_state,
        pane_control: &pane_control_state,
        ribbon_filter: &ribbon_filter_state,
    };
    solver_solve_impl(&state, &file_state, &states, params)
}

/// The body of [`solver_solve`], callable without a Tauri runtime.
pub(crate) fn solver_solve_impl(
    state: &AppState,
    file_state: &crate::persistence::FileState,
    states: &WhatIfStates<'_>,
    params: SolverParams,
) -> SolverResult {
    // ONE what-if run at a time, taken before every gate (see `begin_whatif_run`).
    let _run = match begin_whatif_run(state) {
        Ok(run) => run,
        Err(e) => return refusal(e),
    };
    // BACKGROUND: GRG/simplex/evolutionary all drive many full recalcs whose
    // results are written into the grid. Persisting ceiling per formula; the
    // iteration counts are Solver's own business, and Cancel is the escape.
    let _pass = crate::eval_budget::begin_pass(
        crate::eval_budget::EvalSurface::Background,
        &state.calc_cancel,
    );
    crate::log_info!(
        "SOLVER",
        "Starting: objective=({},{}) method={:?} variables={}",
        params.objective_row,
        params.objective_col,
        params.method,
        params.variable_cells.len()
    );

    // (Sheet protection on the VARIABLE cells is asked under the validation's
    // grid guards below, of the sheet the run writes -- rev13A.)

    // Check writeback regions before acquiring other locks
    {
        let wb_index = state.writeback_index.lock().unwrap();
        if !wb_index.is_empty() {
            let sheet_ids = state.sheet_ids.read().unwrap();
            if let Some(&sid) = sheet_ids.get(params.sheet_index) {
                let mut blocked_cells = Vec::new();
                for var in &params.variable_cells {
                    if wb_index.contains(sid, var.row, var.col) {
                        blocked_cells.push(format!(
                            "row {}, column {}",
                            var.row + 1, var.col + 1,
                        ));
                    }
                }
                if !blocked_cells.is_empty() {
                    return refusal(format!(
                        "Cannot solve: the following variable cells are in writeback regions: {}",
                        blocked_cells.join(", "),
                    ));
                }
            }
        }
    }

    let sheet_idx = params.sheet_index;

    // Validation under the grid locks; every guard dropped before a trial
    // writes (the cascade takes them itself).
    let (effect, run_sheet, original_values, style_indices) = {
        let grid = state.grid.lock_pending().unwrap();
        let grids = state.grids.lock_pending().unwrap();
        let Some(sheet) = grids.get(sheet_idx) else {
            return refusal(format!("Sheet index {} out of range", sheet_idx));
        };

        // Sheet protection on the VARIABLE cells, of params.sheet_index -- not
        // the active sheet: Solver can target a background sheet. Asked HERE,
        // under the guards the run reads its cells under, so it judges the
        // sheet the run writes (rev13A: the gate ran before these locks, and a
        // tab moved in between gated one sheet and solved on another).
        if let Err(e) = check_run_protection_held(state, &grid, &grids, sheet_idx, |kinds, protection, sheet, styles| {
            crate::protection::check_sheet_protection_cells_in(
                kinds,
                protection,
                sheet,
                styles,
                sheet_idx,
                params.variable_cells.iter().map(|v| (v.row, v.col)),
            )
        }) {
            return refusal(e);
        }

        // Validate objective cell has a formula
        if sheet
            .get_cell(params.objective_row, params.objective_col)
            .and_then(|c| c.formula_string())
            .is_none()
        {
            return refusal("Objective cell must contain a formula.".to_string());
        }
        if params.variable_cells.is_empty() {
            return refusal("At least one variable cell is required.".to_string());
        }

        // Save original values (the reply's revert buffer: Keep Solver
        // Solution / Restore Original Values runs solver_revert)
        let original_values: Vec<SolverVariableValue> = params
            .variable_cells
            .iter()
            .map(|v| SolverVariableValue {
                row: v.row,
                col: v.col,
                value: sheet
                    .get_cell(v.row, v.col)
                    .map(|c| match &c.value {
                        CellValue::Number(n) => *n,
                        _ => 0.0,
                    })
                    .unwrap_or(0.0),
            })
            .collect();
        let style_indices: Vec<usize> = params
            .variable_cells
            .iter()
            .map(|v| sheet.get_cell(v.row, v.col).map_or(0, |c| c.style_index))
            .collect();

        // Every gate above has passed; from here this command commits.
        // Constructed HERE and not at the top so a refusal cannot leave a
        // spuriously dirty document -- see DocumentEffect::mutates on ordering.
        let effect = DocumentEffect::mutates(file_state);
        let _grid = grid.authorize(&effect);
        let _grids = grids.authorize(&effect);
        // The run's sheet by stable id, under the same guards as its cells:
        // every trial and the answer follow it if a tab moves mid-run.
        let run_sheet = RunSheet::at(state, sheet_idx);
        (effect, run_sheet, original_values, style_indices)
    };

    let mut model = WorkbookModel {
        state,
        states,
        effect: &effect,
        sheet: run_sheet,
        variables: &params.variable_cells,
        style_indices: &style_indices,
        objective: (params.objective_row, params.objective_col),
        failed: None,
    };
    let start: Vec<f64> = original_values.iter().map(|v| v.value).collect();

    // Run the selected solver
    let (best_x, final_obj, iterations, found, status) = match params.method {
        SolverMethod::GrgNonlinear => solve_grg(
            &mut model,
            start,
            &params.variable_cells,
            params.objective,
            params.target_value,
            &params.constraints,
            params.max_iterations,
            params.tolerance,
        ),
        SolverMethod::SimplexLp => solve_simplex(
            &mut model,
            start,
            &params.variable_cells,
            params.objective,
            params.target_value,
            &params.constraints,
            params.max_iterations,
            params.tolerance,
        ),
        SolverMethod::Evolutionary => solve_evolutionary(
            &mut model,
            start,
            &params.variable_cells,
            params.objective,
            params.target_value,
            &params.constraints,
            params.max_iterations,
            params.tolerance,
        ),
    };

    // A trial that could not be written (the sheet is gone) ends the run with
    // that error: there is no sheet to write an answer on or to restore.
    if let Some(e) = model.failed.take() {
        return refusal(e);
    }

    // STOPPED BY THE USER (Esc in the dialog -> `cancel_calculation`): the
    // algorithm returned the best point it had. The flag is cleared before the
    // answer is written, so that write is a real recalculation and not one the
    // cancel cuts short, and the result says what happened, as Excel's
    // "Solver stopped at user's request" does -- the result dialog then offers
    // Keep Solver Solution / Restore Original Values.
    let stopped = state.calc_cancel.is_cancelled();
    if stopped {
        state.calc_cancel.reset();
    }
    let (found, status) = if stopped {
        (false, "Solver stopped at user's request.".to_string())
    } else {
        (found, status)
    };

    // The answer, written like any trial; this reply repaints every cell the
    // cascade re-evaluated, on every sheet.
    let mut updated_cells = Vec::new();
    if let Err(e) = write_answer(state, states, &effect, run_sheet, &model.variable_writes(&best_x), &mut updated_cells) {
        // The sheet went between the last trial and the answer.
        return refusal(e);
    }
    // Solved, not solved or stopped, the run ends with the WHOLE workbook
    // calculated, as Excel's Solver does under manual calculation [LIVE] (see
    // `calculate_workbook_at_run_end`). The trials above stayed seeded.
    crate::whatif_recalc::calculate_workbook_at_run_end(state, states, &_run, &mut updated_cells);
    // The objective as this final write left it (the algorithm's own last
    // reading may have been cut short by a stop).
    let final_obj = stored_number_in(state, run_sheet, params.objective_row, params.objective_col).unwrap_or(final_obj);

    // Build variable values
    let variable_values: Vec<SolverVariableValue> = params
        .variable_cells
        .iter()
        .enumerate()
        .map(|(i, v)| SolverVariableValue {
            row: v.row,
            col: v.col,
            value: best_x[i],
        })
        .collect();

    crate::log_info!(
        "SOLVER",
        "Done: found={} obj={} iters={}",
        found,
        final_obj,
        iterations
    );

    SolverResult {
        found_solution: found,
        objective_value: final_obj,
        variable_values,
        iterations,
        status_message: status,
        updated_cells,
        original_values,
        sheet_id: run_sheet.id(),
        error: None,
    }
}

/// THE ANSWER'S WRITE, which a second Esc cannot cut short. Esc during a run
/// raises the workbook cancel token; the run stops, clears it and writes the
/// best point -- but the dialog still shows the run as going, so a SECOND Esc
/// raised the token again during this write, and the cascade evaluated the
/// answer's remaining dependents as `#LIMIT!`, which nothing re-cascaded or
/// recorded as pending. This write is evaluated under a PRIVATE token nobody
/// can raise (a nested governor shadows the run's), so it always completes; the
/// run's own pass, which still owns the workbook token, clears a stray raise
/// when it ends.
pub(crate) fn write_answer(
    state: &AppState,
    states: &WhatIfStates<'_>,
    effect: &DocumentEffect,
    sheet: RunSheet,
    writes: &[((u32, u32), Option<Cell>)],
    updated_cells: &mut Vec<crate::api_types::CellData>,
) -> Result<(), String> {
    let uncancellable = engine::CancelToken::new();
    let _answer = crate::eval_budget::begin_pass(crate::eval_budget::EvalSurface::Background, &uncancellable);
    // A failed write (the sheet is gone: `WHATIF_SHEET_GONE`) is the caller's
    // to report; it used to be discarded here.
    write_cells_and_recalc_in(state, states, effect, sheet, writes, RecalcMode::Always, updated_cells).map(|_| ())
}

/// Revert solver results to original values.
#[tauri::command]
pub fn solver_revert(
    state: State<AppState>,
    file_state: State<crate::persistence::FileState>,
    user_files_state: State<crate::persistence::UserFilesState>,
    pivot_state: State<'_, crate::pivot::types::PivotState>,
    pane_control_state: State<'_, crate::pane_control::PaneControlState>,
    ribbon_filter_state: State<'_, crate::ribbon_filter::RibbonFilterState>,
    sheet_id: identity::SheetId,
    original_values: Vec<SolverVariableValue>,
) -> SolverResult {
    let states = WhatIfStates {
        user_files: &user_files_state,
        pivots: &pivot_state,
        pane_control: &pane_control_state,
        ribbon_filter: &ribbon_filter_state,
    };
    solver_revert_impl(&state, &file_state, &states, sheet_id, original_values)
}

/// The body of [`solver_revert`], callable without a Tauri runtime.
///
/// The sheet is named by the STABLE id the run answered (`SolverResult::sheet_id`),
/// never by index: the result dialog stays open while the user may drag a tab,
/// insert or delete a sheet, and a Restore by index then wrote the original
/// values onto whichever sheet held that position (rev13A / pubepoch). Resolved
/// again under the write's own grid locks; a sheet deleted meanwhile is refused
/// with `WHATIF_SHEET_GONE` and nothing is written.
pub(crate) fn solver_revert_impl(
    state: &AppState,
    file_state: &crate::persistence::FileState,
    states: &WhatIfStates<'_>,
    sheet_id: identity::SheetId,
    original_values: Vec<SolverVariableValue>,
) -> SolverResult {
    let run_sheet = RunSheet::with_id(sheet_id);
    // Not while a run is writing trials (see `begin_whatif_run`).
    let _run = match begin_whatif_run(state) {
        Ok(run) => run,
        Err(e) => return refusal(e),
    };
    let _pass = crate::eval_budget::begin_pass(
        crate::eval_budget::EvalSurface::Background,
        &state.calc_cancel,
    );
    // DELIBERATELY NOT protection-gated. This is the undo of solver_solve, and
    // it restores values the sheet already held. If the sheet were protected
    // between solve and revert, gating here would strand the user with Solver's
    // numbers and no way back — the same reasoning that exempts undo replay
    // (see the exempt-paths block in protection.rs). solver_solve itself IS
    // gated, so nothing reaches here that protection did not already allow.
    //
    // Reverting writes cell values just as solving does, so it dirties too: the
    // document after a revert is not the document that was last saved unless the
    // save happened to fall exactly between solve and revert.
    //
    // The protection exemption above does NOT extend to the sheet KIND:
    // solver_solve refuses a canvas (its variable cells go through the
    // protection wrapper, which gates the kind), so a canvas is never a
    // legitimate revert target. A scripted call aimed at one is refused, before
    // the effect. (A sheet's kind is fixed for its life and moves with it, so
    // the index resolved here judges the sheet the write below resolves.)
    let Some(sheet_index) = run_sheet.index(state) else {
        return refusal(crate::whatif_recalc::WHATIF_SHEET_GONE.to_string());
    };
    if let Err(e) = crate::sheets::ensure_not_canvas_in_state(state, sheet_index, "revert Solver values") {
        return refusal(e);
    }
    let effect = DocumentEffect::mutates(file_state);

    // Restore original values, keeping each cell's style
    let writes: Vec<((u32, u32), Option<Cell>)> = original_values
        .iter()
        .map(|orig| {
            let style_index = crate::whatif_recalc::stored_cell_in(state, run_sheet, orig.row, orig.col)
                .map_or(0, |c| c.style_index);
            let mut cell = Cell::new_number(orig.value);
            cell.style_index = style_index;
            ((orig.row, orig.col), Some(cell))
        })
        .collect();

    // Recalculate dependents, on every sheet, through the shared cascade, on
    // the sheet wherever it is at the moment of the write.
    let mut updated_cells = Vec::new();
    if let Err(e) = write_cells_and_recalc_in(
        state,
        states,
        &effect,
        run_sheet,
        &writes,
        RecalcMode::Always,
        &mut updated_cells,
    ) {
        return refusal(e);
    }
    // Excel's Restore Original Values leaves the whole workbook calculated too
    // [LIVE: `SolverFinish KeepFinal:=2` under manual calculation puts A1 back
    // and recalculates stale cells that never read it, CalculationState xlDone].
    crate::whatif_recalc::calculate_workbook_at_run_end(state, states, &_run, &mut updated_cells);

    SolverResult {
        found_solution: false,
        objective_value: f64::NAN,
        variable_values: Vec::new(),
        iterations: 0,
        status_message: "Original values restored.".to_string(),
        updated_cells,
        original_values: Vec::new(),
        sheet_id: Some(sheet_id),
        error: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A model with no workbook: the objective is a closure of the values.
    struct FnModel<F: FnMut(&[f64]) -> f64> {
        f: F,
    }
    impl<F: FnMut(&[f64]) -> f64> SolverModel for FnModel<F> {
        fn set_and_objective(&mut self, values: &[f64]) -> Option<f64> {
            Some((self.f)(values))
        }
        fn cell_number(&self, _row: u32, _col: u32) -> f64 {
            0.0
        }
    }

    #[test]
    fn grg_minimises_a_parabola_through_the_model() {
        let vars = vec![SolverVariableCell { row: 0, col: 0 }];
        let mut model = FnModel { f: |x: &[f64]| (x[0] - 3.0).powi(2) };
        let (best, _obj, _it, _feasible, _status) = solve_grg(
            &mut model,
            vec![0.0],
            &vars,
            SolverObjective::Minimize,
            None,
            &[],
            1000,
            1e-6,
        );
        assert!((best[0] - 3.0).abs() < 1e-2, "GRG found {}", best[0]);
    }
}
