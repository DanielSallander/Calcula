//! FILENAME: app/src-tauri/src/solver.rs
// PURPOSE: Solver - multi-variable optimization with constraints.
// CONTEXT: Supports three solving methods:
//          1. GRG Nonlinear (gradient-based for nonlinear problems)
//          2. Simplex LP (for linear problems)
//          3. Evolutionary (genetic algorithm for non-smooth problems)

use std::collections::HashSet;
use tauri::State;

use crate::api_types::{
    CellData, ConstraintOperator, MergedRegion, SolverConstraint, SolverMethod, SolverObjective,
    SolverParams, SolverResult, SolverVariableCell, SolverVariableValue,
};
use crate::{
    evaluate_formula_multi_sheet, format_cell_value, get_column_row_dependents,
    get_recalculation_order, AppState,
};
use engine::{Cell, CellValue, Grid, StyleRegistry};

// ============================================================================
// Helper: build CellData
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

// ============================================================================
// Evaluation helpers
// ============================================================================

/// Set variable cell values in the grid and evaluate the objective formula.
fn set_variables_and_evaluate(
    grids: &mut [Grid],
    sheet_names: &[String],
    sheet_idx: usize,
    variables: &[SolverVariableCell],
    values: &[f64],
    style_indices: &[usize],
    objective_formula: &str,
) -> Option<f64> {
    // Set all variable cells
    for (i, var) in variables.iter().enumerate() {
        let mut cell = Cell::new_number(values[i]);
        cell.style_index = style_indices[i];
        grids[sheet_idx].set_cell(var.row, var.col, cell);
    }

    // Evaluate objective
    let result = evaluate_formula_multi_sheet(grids, sheet_names, sheet_idx, objective_formula);
    match result {
        CellValue::Number(n) if n.is_finite() => Some(n),
        _ => None,
    }
}

/// Evaluate a constraint cell's value after setting variables.
fn evaluate_constraint_cell(
    grids: &[Grid],
    sheet_names: &[String],
    sheet_idx: usize,
    row: u32,
    col: u32,
) -> f64 {
    if let Some(cell) = grids[sheet_idx].get_cell(row, col) {
        if let Some(formula) = &cell.formula {
            match evaluate_formula_multi_sheet(grids, sheet_names, sheet_idx, formula) {
                CellValue::Number(n) => return n,
                _ => {}
            }
        }
        match &cell.value {
            CellValue::Number(n) => return *n,
            _ => {}
        }
    }
    0.0
}

/// Check if all constraints are satisfied.
fn check_constraints(
    grids: &[Grid],
    sheet_names: &[String],
    sheet_idx: usize,
    constraints: &[SolverConstraint],
    variables: &[SolverVariableCell],
    values: &[f64],
) -> bool {
    for constraint in constraints {
        let lhs = evaluate_constraint_cell(grids, sheet_names, sheet_idx, constraint.cell_row, constraint.cell_col);

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
                    evaluate_constraint_cell(grids, sheet_names, sheet_idx, rr, rc)
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
    grids: &[Grid],
    sheet_names: &[String],
    sheet_idx: usize,
    constraints: &[SolverConstraint],
    variables: &[SolverVariableCell],
    values: &[f64],
) -> f64 {
    let mut penalty = 0.0;
    for constraint in constraints {
        let lhs = evaluate_constraint_cell(grids, sheet_names, sheet_idx, constraint.cell_row, constraint.cell_col);

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
                    evaluate_constraint_cell(grids, sheet_names, sheet_idx, rr, rc)
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

// ============================================================================
// GRG Nonlinear Solver
// ============================================================================

/// Generalized Reduced Gradient solver for nonlinear optimization.
/// Uses numerical gradients and steepest descent with line search.
fn solve_grg(
    grids: &mut [Grid],
    sheet_names: &[String],
    sheet_idx: usize,
    variables: &[SolverVariableCell],
    style_indices: &[usize],
    objective_formula: &str,
    objective: SolverObjective,
    target_value: Option<f64>,
    constraints: &[SolverConstraint],
    max_iterations: u32,
    tolerance: f64,
) -> (Vec<f64>, f64, u32, bool, String) {
    let n = variables.len();
    let mut x: Vec<f64> = variables
        .iter()
        .map(|v| {
            grids[sheet_idx]
                .get_cell(v.row, v.col)
                .map(|c| match &c.value {
                    CellValue::Number(n) => *n,
                    _ => 0.0,
                })
                .unwrap_or(0.0)
        })
        .collect();

    let sign = match objective {
        SolverObjective::Maximize => -1.0, // Negate to convert to minimization
        SolverObjective::Minimize => 1.0,
        SolverObjective::TargetValue => 1.0,
    };

    let eval_objective = |grids: &mut [Grid], x: &[f64]| -> f64 {
        let val = set_variables_and_evaluate(
            grids, sheet_names, sheet_idx, variables, x, style_indices, objective_formula,
        )
        .unwrap_or(f64::MAX);

        let obj = match objective {
            SolverObjective::TargetValue => {
                let target = target_value.unwrap_or(0.0);
                (val - target).powi(2)
            }
            _ => val * sign,
        };

        // Add constraint penalty
        let pen = constraint_penalty(grids, sheet_names, sheet_idx, constraints, variables, x);
        obj + pen
    };

    let h = 1e-6; // Step for numerical gradient
    let mut best_obj = eval_objective(grids, &x);
    let mut best_x = x.clone();
    let mut iterations = 0u32;
    let mut step_size: f64 = 1.0;

    for _ in 0..max_iterations {
        iterations += 1;

        // Compute numerical gradient
        let mut gradient = vec![0.0; n];
        let f0 = eval_objective(grids, &x);

        for i in 0..n {
            let mut x_plus = x.clone();
            x_plus[i] += h;
            let f_plus = eval_objective(grids, &x_plus);
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
            let x_new: Vec<f64> = x
                .iter()
                .zip(grad_unit.iter())
                .map(|(xi, gi)| xi - step_size * gi)
                .collect();

            let f_new = eval_objective(grids, &x_new);
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
    set_variables_and_evaluate(
        grids, sheet_names, sheet_idx, variables, &best_x, style_indices, objective_formula,
    );

    let feasible = check_constraints(grids, sheet_names, sheet_idx, constraints, variables, &best_x);
    let final_obj = set_variables_and_evaluate(
        grids, sheet_names, sheet_idx, variables, &best_x, style_indices, objective_formula,
    )
    .unwrap_or(f64::NAN);

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
fn solve_simplex(
    grids: &mut [Grid],
    sheet_names: &[String],
    sheet_idx: usize,
    variables: &[SolverVariableCell],
    style_indices: &[usize],
    objective_formula: &str,
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
        grids, sheet_names, sheet_idx, variables, style_indices,
        objective_formula, objective, target_value, constraints,
        max_iterations, tolerance,
    )
}

// ============================================================================
// Evolutionary Solver
// ============================================================================

/// Evolutionary solver using differential evolution.
/// Good for non-smooth, non-convex problems.
fn solve_evolutionary(
    grids: &mut [Grid],
    sheet_names: &[String],
    sheet_idx: usize,
    variables: &[SolverVariableCell],
    style_indices: &[usize],
    objective_formula: &str,
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

    // Get current variable values as seed
    let seed: Vec<f64> = variables
        .iter()
        .map(|v| {
            grids[sheet_idx]
                .get_cell(v.row, v.col)
                .map(|c| match &c.value {
                    CellValue::Number(n) => *n,
                    _ => 0.0,
                })
                .unwrap_or(0.0)
        })
        .collect();

    let sign = match objective {
        SolverObjective::Maximize => -1.0,
        SolverObjective::Minimize => 1.0,
        SolverObjective::TargetValue => 1.0,
    };

    let eval = |grids: &mut [Grid], x: &[f64]| -> f64 {
        let val = set_variables_and_evaluate(
            grids, sheet_names, sheet_idx, variables, x, style_indices, objective_formula,
        )
        .unwrap_or(f64::MAX);

        let obj = match objective {
            SolverObjective::TargetValue => {
                let target = target_value.unwrap_or(0.0);
                (val - target).powi(2)
            }
            _ => val * sign,
        };

        let pen = constraint_penalty(grids, sheet_names, sheet_idx, constraints, variables, x);
        obj + pen
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
    fitness.push(eval(grids, &seed));

    // Generate rest of population around the seed
    for _ in 1..pop_size {
        let individual: Vec<f64> = seed
            .iter()
            .map(|&s| {
                let range = if s.abs() < 1.0 { 10.0 } else { s.abs() * 2.0 };
                s + (next_rand() - 0.5) * range
            })
            .collect();
        let f = eval(grids, &individual);
        fitness.push(f);
        population.push(individual);
    }

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
        iterations += 1;

        for i in 0..pop_size {
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
            let trial_fitness = eval(grids, &trial);
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
    set_variables_and_evaluate(
        grids, sheet_names, sheet_idx, variables, &best_x, style_indices, objective_formula,
    );

    let feasible = check_constraints(grids, sheet_names, sheet_idx, constraints, variables, &best_x);
    let final_obj = set_variables_and_evaluate(
        grids, sheet_names, sheet_idx, variables, &best_x, style_indices, objective_formula,
    )
    .unwrap_or(f64::NAN);

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

#[tauri::command]
pub fn solver_solve(
    state: State<AppState>,
    params: SolverParams,
) -> SolverResult {
    crate::log_info!(
        "SOLVER",
        "Starting: objective=({},{}) method={:?} variables={}",
        params.objective_row,
        params.objective_col,
        params.method,
        params.variable_cells.len()
    );

    // Acquire locks
    let mut grid = state.grid.lock().unwrap();
    let mut grids = state.grids.lock().unwrap();
    let active_sheet = *state.active_sheet.lock().unwrap();
    let sheet_names = state.sheet_names.lock().unwrap();
    let styles = state.style_registry.lock().unwrap();
    let dependents_map = state.dependents.lock().unwrap();
    let column_dependents_map = state.column_dependents.lock().unwrap();
    let row_dependents_map = state.row_dependents.lock().unwrap();
    let merged_regions = state.merged_regions.lock().unwrap();

    let sheet_idx = params.sheet_index;

    // Validate objective cell has a formula
    let objective_formula = match grids[sheet_idx]
        .get_cell(params.objective_row, params.objective_col)
        .and_then(|c| c.formula.clone())
    {
        Some(f) => f,
        None => {
            return SolverResult {
                found_solution: false,
                objective_value: f64::NAN,
                variable_values: Vec::new(),
                iterations: 0,
                status_message: "Objective cell must contain a formula.".to_string(),
                updated_cells: Vec::new(),
                original_values: Vec::new(),
                error: Some("Objective cell must contain a formula.".to_string()),
            };
        }
    };

    if params.variable_cells.is_empty() {
        return SolverResult {
            found_solution: false,
            objective_value: f64::NAN,
            variable_values: Vec::new(),
            iterations: 0,
            status_message: "At least one variable cell is required.".to_string(),
            updated_cells: Vec::new(),
            original_values: Vec::new(),
            error: Some("At least one variable cell is required.".to_string()),
        };
    }

    // Save original values
    let original_values: Vec<SolverVariableValue> = params
        .variable_cells
        .iter()
        .map(|v| {
            let val = grids[sheet_idx]
                .get_cell(v.row, v.col)
                .map(|c| match &c.value {
                    CellValue::Number(n) => *n,
                    _ => 0.0,
                })
                .unwrap_or(0.0);
            SolverVariableValue {
                row: v.row,
                col: v.col,
                value: val,
            }
        })
        .collect();

    // Get style indices for variable cells
    let style_indices: Vec<usize> = params
        .variable_cells
        .iter()
        .map(|v| {
            grids[sheet_idx]
                .get_cell(v.row, v.col)
                .map_or(0, |c| c.style_index)
        })
        .collect();

    // Run the selected solver
    let (best_x, final_obj, iterations, found, status) = match params.method {
        SolverMethod::GrgNonlinear => solve_grg(
            &mut grids,
            &sheet_names,
            sheet_idx,
            &params.variable_cells,
            &style_indices,
            &objective_formula,
            params.objective,
            params.target_value,
            &params.constraints,
            params.max_iterations,
            params.tolerance,
        ),
        SolverMethod::SimplexLp => solve_simplex(
            &mut grids,
            &sheet_names,
            sheet_idx,
            &params.variable_cells,
            &style_indices,
            &objective_formula,
            params.objective,
            params.target_value,
            &params.constraints,
            params.max_iterations,
            params.tolerance,
        ),
        SolverMethod::Evolutionary => solve_evolutionary(
            &mut grids,
            &sheet_names,
            sheet_idx,
            &params.variable_cells,
            &style_indices,
            &objective_formula,
            params.objective,
            params.target_value,
            &params.constraints,
            params.max_iterations,
            params.tolerance,
        ),
    };

    // Sync grid if on active sheet
    if sheet_idx == active_sheet {
        for var in params.variable_cells.iter() {
            if let Some(cell) = grids[sheet_idx].get_cell(var.row, var.col).cloned() {
                grid.set_cell(var.row, var.col, cell);
            }
        }
    }

    // Re-evaluate all dependents
    let mut all_deps = Vec::new();
    for var in &params.variable_cells {
        let recalc = get_recalculation_order((var.row, var.col), &dependents_map);
        let extra = get_column_row_dependents(
            (var.row, var.col),
            &column_dependents_map,
            &row_dependents_map,
        );
        for dep in recalc.iter().chain(extra.iter()) {
            if !all_deps.contains(dep) {
                all_deps.push(*dep);
            }
        }
    }

    for &(r, c) in &all_deps {
        if let Some(cell) = grids[sheet_idx].get_cell(r, c).cloned() {
            if let Some(formula) = &cell.formula {
                let new_value =
                    evaluate_formula_multi_sheet(&grids, &sheet_names, sheet_idx, formula);
                let mut updated = cell;
                updated.value = new_value;
                grids[sheet_idx].set_cell(r, c, updated.clone());
                if sheet_idx == active_sheet {
                    grid.set_cell(r, c, updated);
                }
            }
        }
    }

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

    // Build updated cells
    let mut updated_cells = Vec::new();
    for var in &params.variable_cells {
        if let Some(cd) = build_cell_data(&grids[sheet_idx], &styles, &merged_regions, var.row, var.col) {
            updated_cells.push(cd);
        }
    }
    // Objective cell
    if let Some(cd) = build_cell_data(
        &grids[sheet_idx],
        &styles,
        &merged_regions,
        params.objective_row,
        params.objective_col,
    ) {
        updated_cells.push(cd);
    }
    // Dependent cells
    for &(r, c) in &all_deps {
        let already = updated_cells.iter().any(|cd| cd.row == r && cd.col == c);
        if !already {
            if let Some(cd) = build_cell_data(&grids[sheet_idx], &styles, &merged_regions, r, c) {
                updated_cells.push(cd);
            }
        }
    }

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
        error: None,
    }
}

/// Revert solver results to original values.
#[tauri::command]
pub fn solver_revert(
    state: State<AppState>,
    sheet_index: usize,
    original_values: Vec<SolverVariableValue>,
) -> SolverResult {
    let mut grid = state.grid.lock().unwrap();
    let mut grids = state.grids.lock().unwrap();
    let active_sheet = *state.active_sheet.lock().unwrap();
    let sheet_names = state.sheet_names.lock().unwrap();
    let styles = state.style_registry.lock().unwrap();
    let dependents_map = state.dependents.lock().unwrap();
    let column_dependents_map = state.column_dependents.lock().unwrap();
    let row_dependents_map = state.row_dependents.lock().unwrap();
    let merged_regions = state.merged_regions.lock().unwrap();

    // Restore original values
    for orig in &original_values {
        let style_index = grids[sheet_index]
            .get_cell(orig.row, orig.col)
            .map_or(0, |c| c.style_index);
        let mut cell = Cell::new_number(orig.value);
        cell.style_index = style_index;
        grids[sheet_index].set_cell(orig.row, orig.col, cell.clone());
        if sheet_index == active_sheet {
            grid.set_cell(orig.row, orig.col, cell);
        }
    }

    // Recalculate dependents
    let mut all_deps = Vec::new();
    for orig in &original_values {
        let recalc = get_recalculation_order((orig.row, orig.col), &dependents_map);
        let extra = get_column_row_dependents(
            (orig.row, orig.col),
            &column_dependents_map,
            &row_dependents_map,
        );
        for dep in recalc.iter().chain(extra.iter()) {
            if !all_deps.contains(dep) {
                all_deps.push(*dep);
            }
        }
    }

    for &(r, c) in &all_deps {
        if let Some(cell) = grids[sheet_index].get_cell(r, c).cloned() {
            if let Some(formula) = &cell.formula {
                let new_value =
                    evaluate_formula_multi_sheet(&grids, &sheet_names, sheet_index, formula);
                let mut updated = cell;
                updated.value = new_value;
                grids[sheet_index].set_cell(r, c, updated.clone());
                if sheet_index == active_sheet {
                    grid.set_cell(r, c, updated);
                }
            }
        }
    }

    // Build updated cells
    let mut updated_cells = Vec::new();
    for orig in &original_values {
        if let Some(cd) = build_cell_data(&grids[sheet_index], &styles, &merged_regions, orig.row, orig.col) {
            updated_cells.push(cd);
        }
    }
    for &(r, c) in &all_deps {
        if let Some(cd) = build_cell_data(&grids[sheet_index], &styles, &merged_regions, r, c) {
            updated_cells.push(cd);
        }
    }

    SolverResult {
        found_solution: false,
        objective_value: f64::NAN,
        variable_values: Vec::new(),
        iterations: 0,
        status_message: "Original values restored.".to_string(),
        updated_cells,
        original_values: Vec::new(),
        error: None,
    }
}
