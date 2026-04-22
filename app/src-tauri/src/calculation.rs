//! FILENAME: app/src-tauri/src/calculation.rs
// PURPOSE: Calculation mode commands for manual/automatic recalculation.

use serde::{Serialize, Deserialize};
use tauri::State;
use crate::{AppState, evaluate_formula_with_pivot, format_cell_value};
use crate::api_types::CellData;
use crate::{log_enter, log_exit, log_enter_info, log_exit_info, log_warn, log_info};
use crate::persistence::UserFilesState;
use crate::pivot::types::PivotState;
use engine;

// ============================================================================
// ITERATION SETTINGS
// ============================================================================

/// Settings for iterative calculation (circular reference resolution).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IterationSettings {
    pub enabled: bool,
    pub max_iterations: u32,
    pub max_change: f64,
}

// ============================================================================
// CALCULATION MODE COMMANDS
// ============================================================================

/// Set the calculation mode ("automatic" or "manual")
#[tauri::command]
pub fn set_calculation_mode(state: State<AppState>, mode: String) -> String {
    log_enter_info!("CMD", "set_calculation_mode", "mode={}", mode);

    let valid_mode = match mode.to_lowercase().as_str() {
        "automatic" | "auto" => "automatic".to_string(),
        "manual" => "manual".to_string(),
        _ => {
            log_warn!("CMD", "invalid calculation mode: {}, defaulting to automatic", mode);
            "automatic".to_string()
        }
    };

    let mut calc_mode = state.calculation_mode.lock().unwrap();
    *calc_mode = valid_mode.clone();

    log_exit_info!("CMD", "set_calculation_mode", "set to {}", valid_mode);
    valid_mode
}

/// Get the current calculation mode
#[tauri::command]
pub fn get_calculation_mode(state: State<AppState>) -> String {
    log_enter!("CMD", "get_calculation_mode");

    let calc_mode = state.calculation_mode.lock().unwrap();
    let mode = calc_mode.clone();

    log_exit!("CMD", "get_calculation_mode", "mode={}", mode);
    mode
}

// ============================================================================
// ITERATION SETTINGS COMMANDS
// ============================================================================

/// Get the current iterative calculation settings.
#[tauri::command]
pub fn get_iteration_settings(state: State<AppState>) -> IterationSettings {
    log_enter!("CMD", "get_iteration_settings");

    let enabled = *state.iteration_enabled.lock().unwrap();
    let max_iterations = *state.max_iterations.lock().unwrap();
    let max_change = *state.max_change.lock().unwrap();

    let settings = IterationSettings { enabled, max_iterations, max_change };
    log_exit!("CMD", "get_iteration_settings", "enabled={} max_iterations={} max_change={}",
        settings.enabled, settings.max_iterations, settings.max_change);
    settings
}

/// Set the iterative calculation settings.
#[tauri::command]
pub fn set_iteration_settings(
    state: State<AppState>,
    enabled: bool,
    max_iterations: u32,
    max_change: f64,
) -> IterationSettings {
    log_enter_info!("CMD", "set_iteration_settings",
        "enabled={} max_iterations={} max_change={}", enabled, max_iterations, max_change);

    *state.iteration_enabled.lock().unwrap() = enabled;
    *state.max_iterations.lock().unwrap() = max_iterations;
    *state.max_change.lock().unwrap() = max_change;

    let settings = IterationSettings { enabled, max_iterations, max_change };
    log_exit_info!("CMD", "set_iteration_settings", "applied");
    settings
}

// ============================================================================
// CALCULATION STATE
// ============================================================================

/// Get the current calculation state.
/// Returns "done", "calculating", or "pending".
/// Currently always returns "done" since calculation is synchronous,
/// but having this API ready enables future async calculation.
#[tauri::command]
pub fn get_calculation_state(_state: State<AppState>) -> String {
    "done".to_string()
}

// ============================================================================
// RECALCULATION COMMANDS
// ============================================================================

/// Evaluate a single formula cell, returning its CellValue.
/// Helper shared by calculate_now for both normal and iterative evaluation.
fn evaluate_single_formula(
    row: u32,
    col: u32,
    formula: &str,
    grids: &[engine::Grid],
    sheet_names: &[String],
    active_sheet: usize,
    styles: &engine::StyleRegistry,
    user_files: &std::collections::HashMap<String, Vec<u8>>,
    pivot_data_fn: &dyn Fn(&str, u32, u32, &[(&str, &str)]) -> Option<f64>,
    tables_map: &crate::tables::TableStorage,
    table_names_map: &crate::tables::TableNameRegistry,
    named_ranges_map: &std::collections::HashMap<String, crate::named_ranges::NamedRange>,
    row_heights: &std::collections::HashMap<u32, f64>,
    column_widths: &std::collections::HashMap<u32, f64>,
) -> engine::CellValue {
    match parser::parse(formula) {
        Ok(parsed) => {
            // Resolve named references
            let resolved = if crate::ast_has_named_refs(&parsed) {
                let mut visited = std::collections::HashSet::new();
                crate::resolve_names_in_ast(&parsed, named_ranges_map, active_sheet, &mut visited)
            } else {
                parsed
            };

            // Resolve structured table references
            let resolved = if crate::ast_has_table_refs(&resolved) {
                let ctx = crate::TableRefContext {
                    tables: tables_map,
                    table_names: table_names_map,
                    current_sheet_index: active_sheet,
                    current_row: row,
                };
                crate::resolve_table_refs_in_ast(&resolved, &ctx)
            } else {
                resolved
            };

            let engine_ast = crate::convert_expr(&resolved);
            let eval_ctx = engine::EvalContext {
                current_row: Some(row),
                current_col: Some(col),
                row_heights: Some(row_heights.clone()),
                column_widths: Some(column_widths.clone()),
                hidden_rows: None,
            };
            evaluate_formula_with_pivot(
                grids,
                sheet_names,
                active_sheet,
                &engine_ast,
                eval_ctx,
                Some(styles),
                user_files,
                Some(pivot_data_fn),
            )
        }
        Err(_) => engine::CellValue::Error(engine::CellError::Value),
    }
}

/// Extract the numeric value from a CellValue, returning 0.0 for non-numeric values.
fn cell_value_as_f64(value: &engine::CellValue) -> f64 {
    match value {
        engine::CellValue::Number(n) => *n,
        engine::CellValue::Boolean(b) => if *b { 1.0 } else { 0.0 },
        _ => 0.0,
    }
}

/// Detect circular groups among formula cells using the dependency maps.
/// Returns (non_circular_cells_in_order, circular_groups) where each circular
/// group is a Vec of (row, col, formula) that must be iterated together.
fn partition_formula_cells(
    formula_cells: &[(u32, u32, String)],
    dependencies_map: &std::collections::HashMap<(u32, u32), std::collections::HashSet<(u32, u32)>>,
) -> (Vec<(u32, u32, String)>, Vec<Vec<(u32, u32, String)>>) {
    use std::collections::{HashMap, HashSet, VecDeque};

    let formula_set: HashSet<(u32, u32)> = formula_cells.iter().map(|(r, c, _)| (*r, *c)).collect();
    let formula_map: HashMap<(u32, u32), String> = formula_cells.iter().map(|(r, c, f)| ((*r, *c), f.clone())).collect();

    // Build adjacency within formula cells only
    // in_degree counts how many formula-cell predecessors each cell has
    let mut in_degree: HashMap<(u32, u32), usize> = HashMap::new();
    let mut dependents_local: HashMap<(u32, u32), Vec<(u32, u32)>> = HashMap::new();

    for &(r, c, _) in formula_cells {
        in_degree.entry((r, c)).or_insert(0);
    }

    for &(r, c, _) in formula_cells {
        if let Some(deps) = dependencies_map.get(&(r, c)) {
            for dep in deps {
                if formula_set.contains(dep) {
                    *in_degree.entry((r, c)).or_insert(0) += 1;
                    dependents_local.entry(*dep).or_default().push((r, c));
                }
            }
        }
    }

    // Kahn's algorithm for topological sort
    let mut queue: VecDeque<(u32, u32)> = in_degree
        .iter()
        .filter(|(_, &deg)| deg == 0)
        .map(|(&cell, _)| cell)
        .collect();

    let mut sorted = Vec::new();

    while let Some(cell) = queue.pop_front() {
        sorted.push(cell);
        if let Some(deps) = dependents_local.get(&cell) {
            for &dep in deps {
                if let Some(deg) = in_degree.get_mut(&dep) {
                    *deg -= 1;
                    if *deg == 0 {
                        queue.push_back(dep);
                    }
                }
            }
        }
    }

    let sorted_set: HashSet<(u32, u32)> = sorted.iter().copied().collect();

    // Non-circular cells in topological order
    let non_circular: Vec<(u32, u32, String)> = sorted
        .iter()
        .map(|&(r, c)| (r, c, formula_map[&(r, c)].clone()))
        .collect();

    // Remaining cells are part of circular references
    let circular_cells: HashSet<(u32, u32)> = formula_set
        .difference(&sorted_set)
        .copied()
        .collect();

    if circular_cells.is_empty() {
        return (non_circular, Vec::new());
    }

    // Group circular cells into connected components using BFS
    let mut visited: HashSet<(u32, u32)> = HashSet::new();
    let mut groups: Vec<Vec<(u32, u32, String)>> = Vec::new();

    for &cell in &circular_cells {
        if visited.contains(&cell) {
            continue;
        }

        let mut group = Vec::new();
        let mut bfs_queue = VecDeque::new();
        bfs_queue.push_back(cell);

        while let Some(current) = bfs_queue.pop_front() {
            if visited.contains(&current) || !circular_cells.contains(&current) {
                continue;
            }
            visited.insert(current);
            group.push((current.0, current.1, formula_map[&current].clone()));

            // Follow both directions to find the full connected component
            if let Some(deps) = dependencies_map.get(&current) {
                for dep in deps {
                    if circular_cells.contains(dep) && !visited.contains(dep) {
                        bfs_queue.push_back(*dep);
                    }
                }
            }
            if let Some(deps) = dependents_local.get(&current) {
                for dep in deps {
                    if circular_cells.contains(dep) && !visited.contains(dep) {
                        bfs_queue.push_back(*dep);
                    }
                }
            }
        }

        if !group.is_empty() {
            groups.push(group);
        }
    }

    (non_circular, groups)
}

/// Recalculate all formulas in the grid.
/// When iterative calculation is enabled, circular references are resolved
/// by repeatedly evaluating the circular group until convergence.
#[tauri::command]
pub fn calculate_now(state: State<AppState>, user_files_state: State<UserFilesState>, pivot_state: State<'_, PivotState>) -> Result<Vec<CellData>, String> {
    let mut grid = state.grid.lock().unwrap();
    let mut grids = state.grids.lock().unwrap();
    let sheet_names = state.sheet_names.lock().unwrap();
    let active_sheet = *state.active_sheet.lock().unwrap();
    let mut styles = state.style_registry.lock().unwrap();
    let user_files = user_files_state.files.lock().unwrap();
    let locale = state.locale.lock().unwrap();

    // Read iteration settings
    let iteration_enabled = *state.iteration_enabled.lock().unwrap();
    let max_iterations = *state.max_iterations.lock().unwrap();
    let max_change = *state.max_change.lock().unwrap();

    // Build pivot data lookup closure for GETPIVOTDATA
    let pivot_tables = pivot_state.pivot_tables.lock().unwrap();
    let pivot_views = pivot_state.views.lock().unwrap();
    let pivot_data_fn = |data_field: &str, pivot_row: u32, pivot_col: u32, pairs: &[(&str, &str)]| -> Option<f64> {
        crate::pivot::operations::lookup_pivot_data(
            &pivot_tables,
            &pivot_views,
            data_field,
            pivot_row,
            pivot_col,
            pairs,
        )
    };

    let mut updated_cells = Vec::new();

    // Collect all cells with formulas
    let formula_cells: Vec<_> = grid
        .cells
        .iter()
        .filter_map(|(&(row, col), cell)| {
            cell.formula.as_ref().map(|f| (row, col, f.clone()))
        })
        .collect();

    // Lock table state once for all formula evaluations
    let tables_map = state.tables.lock().unwrap();
    let table_names_map = state.table_names.lock().unwrap();
    let named_ranges_map = state.named_ranges.lock().unwrap();
    let mut row_heights = state.row_heights.lock().unwrap();
    let mut column_widths = state.column_widths.lock().unwrap();
    let dependencies_map = state.dependencies.lock().unwrap();

    // Partition formula cells into non-circular (topological order) and circular groups
    let (non_circular, circular_groups) = partition_formula_cells(&formula_cells, &dependencies_map);
    drop(dependencies_map);

    // Phase 1: Evaluate non-circular formulas in topological order (single pass)
    for (row, col, formula) in &non_circular {
        let result = evaluate_single_formula(
            *row, *col, formula,
            &grids, &sheet_names, active_sheet,
            &styles, &user_files, &pivot_data_fn,
            &tables_map, &table_names_map, &named_ranges_map,
            &row_heights, &column_widths,
        );

        if let Some(cell) = grid.get_cell(*row, *col) {
            let mut updated = cell.clone();
            updated.value = result;
            grid.set_cell(*row, *col, updated.clone());
            if active_sheet < grids.len() {
                grids[active_sheet].set_cell(*row, *col, updated.clone());
            }

            let style = styles.get(updated.style_index);
            let display = format_cell_value(&updated.value, style, &locale);
            updated_cells.push(CellData {
                row: *row,
                col: *col,
                display,
                display_color: None,
                formula: updated.formula,
                style_index: updated.style_index,
                row_span: 1,
                col_span: 1,
                sheet_index: None,
                rich_text: None,
                accounting_layout: None,
            });
        }
    }

    // Phase 2: Handle circular groups
    for group in &circular_groups {
        if !iteration_enabled {
            // Iteration disabled: set all cells in the circular group to #CIRC! error
            for (row, col, _formula) in group {
                if let Some(cell) = grid.get_cell(*row, *col) {
                    let mut updated = cell.clone();
                    updated.value = engine::CellValue::Error(engine::CellError::Circular);
                    grid.set_cell(*row, *col, updated.clone());
                    if active_sheet < grids.len() {
                        grids[active_sheet].set_cell(*row, *col, updated.clone());
                    }

                    let style = styles.get(updated.style_index);
                    let display = format_cell_value(&updated.value, style, &locale);
                    updated_cells.push(CellData {
                        row: *row,
                        col: *col,
                        display,
                        display_color: None,
                        formula: updated.formula,
                        style_index: updated.style_index,
                        row_span: 1,
                        col_span: 1,
                        sheet_index: None,
                        rich_text: None,
                        accounting_layout: None,
                    });
                }
            }
        } else {
            // Iteration enabled: iterate the circular group until convergence
            log_info!("CALC", "Iterating circular group of {} cells (max_iterations={}, max_change={})",
                group.len(), max_iterations, max_change);

            for iteration in 0..max_iterations {
                let mut max_delta: f64 = 0.0;

                for (row, col, formula) in group {
                    let old_value = grid.get_cell(*row, *col)
                        .map(|c| cell_value_as_f64(&c.value))
                        .unwrap_or(0.0);

                    let new_result = evaluate_single_formula(
                        *row, *col, formula,
                        &grids, &sheet_names, active_sheet,
                        &styles, &user_files, &pivot_data_fn,
                        &tables_map, &table_names_map, &named_ranges_map,
                        &row_heights, &column_widths,
                    );

                    let new_numeric = cell_value_as_f64(&new_result);

                    if let Some(cell) = grid.get_cell(*row, *col) {
                        let mut updated = cell.clone();
                        updated.value = new_result;
                        grid.set_cell(*row, *col, updated.clone());
                        if active_sheet < grids.len() {
                            grids[active_sheet].set_cell(*row, *col, updated);
                        }
                    }

                    let delta = (new_numeric - old_value).abs();
                    if delta > max_delta {
                        max_delta = delta;
                    }
                }

                if max_delta < max_change {
                    log_info!("CALC", "Circular group converged after {} iterations (max_delta={})",
                        iteration + 1, max_delta);
                    break;
                }
            }

            // Collect final values for all cells in the group
            for (row, col, _formula) in group {
                if let Some(cell) = grid.get_cell(*row, *col) {
                    let style = styles.get(cell.style_index);
                    let display = format_cell_value(&cell.value, style, &locale);
                    updated_cells.push(CellData {
                        row: *row,
                        col: *col,
                        display,
                        display_color: None,
                        formula: cell.formula.clone(),
                        style_index: cell.style_index,
                        row_span: 1,
                        col_span: 1,
                        sheet_index: None,
                        rich_text: None,
                        accounting_layout: None,
                    });
                }
            }
        }
    }

    // Re-evaluate all computed properties for this sheet
    {
        let mut cp_storage = state.computed_properties.lock().unwrap();
        let (_dim_changes, _style_refresh) =
            crate::computed_properties::re_evaluate_all_properties(
                &mut cp_storage,
                &mut grids,
                &mut grid,
                &sheet_names,
                active_sheet,
                &mut row_heights,
                &mut column_widths,
                &mut styles,
            );
        // Note: calculate_now returns Vec<CellData>, not UpdateCellResult.
        // Dimension changes and style refresh are handled by the frontend
        // re-fetching viewport data after recalculation.
    }

    Ok(updated_cells)
}

/// Recalculate all formula cells in the current sheet (same as calculate_now for single-sheet)
#[tauri::command]
pub fn calculate_sheet(state: State<AppState>, user_files_state: State<UserFilesState>, pivot_state: State<'_, PivotState>) -> Result<Vec<CellData>, String> {
    log_enter_info!("CMD", "calculate_sheet");

    // For now, calculate_sheet does the same as calculate_now since we have a single sheet
    let result = calculate_now(state, user_files_state, pivot_state);

    log_exit_info!("CMD", "calculate_sheet", "done");
    result
}

// ============================================================================
// PRECISION AS DISPLAYED
// ============================================================================

#[tauri::command]
pub fn get_precision_as_displayed(state: State<AppState>) -> bool {
    *state.precision_as_displayed.lock().unwrap()
}

#[tauri::command]
pub fn set_precision_as_displayed(state: State<AppState>, enabled: bool) -> bool {
    *state.precision_as_displayed.lock().unwrap() = enabled;
    enabled
}

// ============================================================================
// CALCULATE BEFORE SAVE
// ============================================================================

#[tauri::command]
pub fn get_calculate_before_save(state: State<AppState>) -> bool {
    *state.calculate_before_save.lock().unwrap()
}

#[tauri::command]
pub fn set_calculate_before_save(state: State<AppState>, enabled: bool) -> bool {
    *state.calculate_before_save.lock().unwrap() = enabled;
    enabled
}
