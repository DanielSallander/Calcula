//! FILENAME: app/src-tauri/src/calculation.rs
// PURPOSE: Calculation mode commands for manual/automatic recalculation.

use serde::{Serialize, Deserialize};
use tauri::State;
use crate::{AppState, evaluate_formula_with_pivot, format_cell_value};
use crate::api_types::CellData;
use crate::eval_budget::{self, EvalSurface, PendingCell, PendingRecalc, ProgressEmitter};
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

/// Get the current calculation state: "done" or "pending".
///
/// "pending" means a recalculation was CANCELLED and some cells still hold
/// pre-pass values — Excel's "Calculate" state. The frontend shows that word in
/// the status bar instead of "Ready", which is the whole affordance for "this
/// workbook has un-recalculated cells".
///
/// "calculating" is not reported here: a running pass publishes itself through
/// the `app:calc-progress` event stream instead, which is both more informative
/// (it carries counts and elapsed time) and reachable while the pass runs.
#[tauri::command]
pub fn get_calculation_state(state: State<AppState>) -> String {
    let stale = state
        .pending_recalc
        .lock()
        .ok()
        .is_some_and(|p| p.as_ref().is_some_and(|pr| !pr.is_empty()));
    if stale { "pending".to_string() } else { "done".to_string() }
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
    gather_fn: &dyn Fn(&str) -> engine::GatherRegionData,
    tables_map: &crate::tables::TableStorage,
    table_names_map: &crate::tables::TableNameRegistry,
    named_ranges_map: &std::collections::HashMap<String, crate::named_ranges::NamedRange>,
    row_heights: &std::collections::HashMap<u32, f64>,
    column_widths: &std::collections::HashMap<u32, f64>,
    cube: Option<&std::sync::Arc<engine::CubePrefetch>>,
    control_values: Option<&std::sync::Arc<crate::control_values::ControlValuesMap>>,
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
                cube_prefetch: cube.cloned(),
                current_row: Some(row),
                current_col: Some(col),
                row_heights: Some(row_heights.clone()),
                column_widths: Some(column_widths.clone()),
                hidden_rows: None,
                control_values: control_values.cloned(),
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
                Some(gather_fn),
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
    dependencies_map: &crate::DependencyMap,
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
///
/// # Why this command is `(async)`
///
/// **This is the change that makes cancellation exist at all**, and it is a
/// threading change rather than a token design. A plain `#[tauri::command]` on
/// a synchronous function runs on the MAIN thread, which on Windows is the
/// WebView2 UI thread: while a long recalculation ran, the webview could not
/// paint, could not dispatch a click, and could not deliver
/// `invoke("cancel_calculation")`. An `AtomicBool` nobody can reach is not
/// cancellation. `(async)` dispatches this to the async runtime's pool and
/// frees the UI thread, so the Cancel button can be drawn AND clicked.
///
/// The function itself stays synchronous Rust — it holds `std::sync::MutexGuard`s
/// and must never be suspended across an await. 106 commands in this crate are
/// already async, so `AppState`'s mutexes being touched off the main thread is
/// not a new hazard. The consequence to design for (not to discover) is that a
/// concurrent edit command now BLOCKS on the grid mutex while a recalc runs;
/// the frontend therefore enters an explicit "calculating" state on invoke,
/// which it wants anyway, because that is where the Cancel button lives.
#[tauri::command(async)]
pub fn calculate_now(window: tauri::Window, state: State<'_, AppState>, user_files_state: State<'_, UserFilesState>, pivot_state: State<'_, PivotState>, pane_control_state: State<'_, crate::pane_control::PaneControlState>, ribbon_filter_state: State<'_, crate::ribbon_filter::RibbonFilterState>, cube_results: Option<engine::CubePrefetch>) -> Result<Vec<CellData>, String> {
    // PERF-03: one lookup-index cache for the whole pass (lookup_cache.rs).
    let _lookup_pass = engine::begin_lookup_pass();
    // THE PASS OWNS THE CANCEL FLAG. `begin` clears anything a previous pass
    // left set; the guard clears it again on the way out (including on a panic)
    // so a cancelled pass cannot poison the resume the user is about to ask for.
    // Every evaluator built anywhere under this call now carries the pass token
    // and the Recalc fuel ceiling. See eval_budget.rs for why the surface is
    // ambient rather than a parameter on ~78 call sites.
    let pass = eval_budget::begin_pass(EvalSurface::Recalc, &state.calc_cancel);
    // VERIFICATION HOOK for the `(async)` change above. The claim "this no
    // longer runs on the WebView2 UI thread" is a claim about framework
    // behaviour, and the whole Cancel affordance rests on it, so it is logged
    // rather than asserted from the documentation: compare this thread id
    // against a UI-thread command's and they must differ.
    log_info!("CALC", "calculate_now on thread {:?}", std::thread::current().id());
    // Pre-fetched CUBE data for this full recalc (built async by cube_prefetch_all
    // on the frontend before calling). Shared via Arc so each formula's eval gets
    // it cheaply; None => cube cells preserve their last value (see eval_cube).
    let cube_arc = cube_results.map(std::sync::Arc::new);
    // GET.CONTROLVALUE snapshot: built ONCE per recalc, BEFORE the grid locks
    // below (canonical lock order: control stores first, grids last).
    let control_values = crate::control_values::build_control_values(
        &state, &pane_control_state, &ribbon_filter_state,
    );
    let mut grid = state.grid.lock().unwrap();
    let mut grids = state.grids.lock().unwrap();
    let sheet_names = state.sheet_names.lock().unwrap();
    let active_sheet = *state.active_sheet.lock().unwrap();

    // The active-sheet mirror (state.grid) is the source of truth; grids[i]
    // can lag behind it (see get_watch_cells note in commands/data.rs).
    // Formula evaluation below reads the ACTIVE sheet through `grids`, so a
    // stale grids[active] silently recalculates from old values (BUG-0016).
    // Sync it from the mirror before evaluating.
    if active_sheet < grids.len() {
        grids[active_sheet] = grid.clone();
    }
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

    // Pre-fetch writeback submissions once per recalculation pass so GATHER
    // formulas see current data (empty map, no registry I/O, when the
    // workbook has no writeback regions).
    let gather_data = crate::calp_commands::build_gather_data(&state);
    let gather_fn = |region_id: &str| -> engine::GatherRegionData {
        gather_data.get(region_id).cloned().unwrap_or_default()
    };

    let mut updated_cells = Vec::new();

    // Collect all cells with formulas
    let formula_cells: Vec<_> = grid
        .cells
        .iter()
        .filter_map(|(&(row, col), cell)| {
            cell.formula_string().map(|f| (row, col, f))
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
    let (mut non_circular, mut circular_groups) = partition_formula_cells(&formula_cells, &dependencies_map);
    drop(dependencies_map);

    // RESUME. If the previous pass on this sheet was cancelled, recalculate only
    // what it never reached, so an accidental Cancel costs nothing.
    //
    // Filtering the FRESH topological order down to the pending set is correct
    // because the pending set is, by construction, a topological SUFFIX of the
    // previous order: every precedent of a pending cell is either pending too
    // (and still precedes it here) or was already recalculated. Cells that an
    // edit cascade recalculated in the meantime were dropped from the set by
    // `update_cell`; any that were missed are merely recalculated twice, which
    // is wasteful and never wrong.
    let resume: Option<std::collections::HashSet<(u32, u32)>> = {
        let pending = state.pending_recalc.lock().map_err(|e| e.to_string())?;
        pending
            .as_ref()
            .filter(|p| p.sheet_index == active_sheet && !p.is_empty())
            .map(|p| p.cells.iter().map(|c| (c.row, c.col)).collect())
    };
    if let Some(resume_set) = &resume {
        non_circular.retain(|(r, c, _)| resume_set.contains(&(*r, *c)));
        // A circular group is atomic: if any member is pending, the group has to
        // be iterated as a whole — a half-converged group is not a resting state.
        circular_groups.retain(|g| g.iter().any(|(r, c, _)| resume_set.contains(&(*r, *c))));
        log_info!("CALC", "resuming cancelled pass: {} cells, {} circular groups",
            non_circular.len(), circular_groups.len());
    }

    let total_cells: usize =
        non_circular.len() + circular_groups.iter().map(|g| g.len()).sum::<usize>();
    let mut progress = ProgressEmitter::new(Some(window.clone()), "workbook", total_cells);
    let mut cells_done: usize = 0;
    let mut cancelled = false;
    // Everything a cancelled pass did NOT recalculate, in evaluation order.
    let mut pending_cells: Vec<PendingCell> = Vec::new();

    // Phase 1: Evaluate non-circular formulas in topological order (single pass)
    for (idx, (row, col, formula)) in non_circular.iter().enumerate() {
        // Check 1 of 2: before spending any work on this cell.
        if pass.cancelled() {
            cancelled = true;
            pending_cells.extend(
                non_circular[idx..].iter().map(|(r, c, _)| PendingCell { row: *r, col: *c }),
            );
            break;
        }

        let result = evaluate_single_formula(
            *row, *col, formula,
            &grids, &sheet_names, active_sheet,
            &styles, &user_files, &pivot_data_fn, &gather_fn,
            &tables_map, &table_names_map, &named_ranges_map,
            &row_heights, &column_widths,
            cube_arc.as_ref(),
            Some(&control_values),
        );

        // Check 2 of 2, and THE LOAD-BEARING ONE: after evaluating, BEFORE
        // writing. A formula aborted mid-flight by cancellation comes back as
        // `#LIMIT!` (the engine reports cancellation and exhaustion with the
        // same value; the host distinguishes them by asking the token it owns).
        // Writing it would land a bogus error in a cell the user only wanted to
        // stop computing. `idx` — not `idx + 1` — so this cell is recorded as
        // un-recalculated, which it is.
        if pass.cancelled() {
            cancelled = true;
            pending_cells.extend(
                non_circular[idx..].iter().map(|(r, c, _)| PendingCell { row: *r, col: *c }),
            );
            break;
        }

        if let Some(cell) = grid.get_cell(*row, *col) {
            let mut updated = cell.clone();
            updated.value = result;
            grid.set_cell(*row, *col, updated.clone());
            if active_sheet < grids.len() {
                grids[active_sheet].set_cell(*row, *col, updated.clone());
            }

            // Row/column tiers apply to what is displayed and to the index the
            // renderer gets; the stored cell keeps its own (inherit) index.
            let effective_style_index = grid.effective_style_index(*row, *col);
            let style = styles.get(effective_style_index);
            let display = format_cell_value(&updated.value, style, &locale);
            updated_cells.push(CellData {
                row: *row,
                col: *col,
                display,
                display_color: None,
                formula: updated.formula_string().map(|f| format!("={}", f)),
                style_index: effective_style_index,
                row_span: 1,
                col_span: 1,
                sheet_index: None,
                rich_text: None,
                accounting_layout: None,
            });
        }
        cells_done += 1;
        progress.tick(cells_done);
    }

    // Phase 2: Handle circular groups
    for (gi, group) in circular_groups.iter().enumerate() {
        if cancelled {
            break;
        }
        // A circular group is all-or-nothing: cancelling inside one leaves a
        // half-converged set of values that is neither the old answer nor the
        // new one, so the whole group (and every group after it) is recorded as
        // pending rather than partially written.
        if pass.cancelled() {
            cancelled = true;
            for g in &circular_groups[gi..] {
                pending_cells.extend(g.iter().map(|(r, c, _)| PendingCell { row: *r, col: *c }));
            }
            break;
        }
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

                    let effective_style_index = grid.effective_style_index(*row, *col);
                    let style = styles.get(effective_style_index);
                    let display = format_cell_value(&updated.value, style, &locale);
                    updated_cells.push(CellData {
                        row: *row,
                        col: *col,
                        display,
                        display_color: None,
                        formula: updated.formula_string().map(|f| format!("={}", f)),
                        style_index: effective_style_index,
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
                // ITERATIVE CALCULATION IS UNTOUCHED BY THE BUDGET, on purpose:
                // each iteration is its own top-level evaluation and re-arms a
                // fresh allowance, so 32,767 deliberate iterations look like
                // 32,767 cheap evaluations rather than one long one. Runaway
                // protection for iteration already exists at a different layer
                // (max_iterations / max_change) and the budget must not
                // second-guess it. What the loop DOES honour is Cancel — checked
                // once per iteration, which is fine-grained enough for a human
                // and free next to a whole group evaluation.
                if pass.cancelled() {
                    cancelled = true;
                    break;
                }
                let mut max_delta: f64 = 0.0;

                for (row, col, formula) in group {
                    let old_value = grid.get_cell(*row, *col)
                        .map(|c| cell_value_as_f64(&c.value))
                        .unwrap_or(0.0);

                    let new_result = evaluate_single_formula(
                        *row, *col, formula,
                        &grids, &sheet_names, active_sheet,
                        &styles, &user_files, &pivot_data_fn, &gather_fn,
                        &tables_map, &table_names_map, &named_ranges_map,
                        &row_heights, &column_widths,
                        cube_arc.as_ref(),
                        Some(&control_values),
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

            if cancelled {
                // Stopped mid-convergence. The group's cells hold intermediate
                // iterates, which are not an answer — record the whole group
                // and every group after it as un-recalculated.
                for g in &circular_groups[gi..] {
                    pending_cells.extend(g.iter().map(|(r, c, _)| PendingCell { row: *r, col: *c }));
                }
                break;
            }

            // Collect final values for all cells in the group
            for (row, col, _formula) in group {
                if let Some(cell) = grid.get_cell(*row, *col) {
                    let effective_style_index = grid.effective_style_index(*row, *col);
                    let style = styles.get(effective_style_index);
                    let display = format_cell_value(&cell.value, style, &locale);
                    updated_cells.push(CellData {
                        row: *row,
                        col: *col,
                        display,
                        display_color: None,
                        formula: cell.formula_string().map(|f| format!("={}", f)),
                        style_index: effective_style_index,
                        row_span: 1,
                        col_span: 1,
                        sheet_index: None,
                        rich_text: None,
                        accounting_layout: None,
                    });
                }
            }
        }
        cells_done += group.len();
        progress.tick(cells_done);
    }

    // Re-evaluate all computed properties for this sheet.
    // Skipped after a cancel: computed properties are re-derived from the whole
    // sheet, and re-deriving them from a half-recalculated one would bake the
    // partial state into row heights and column widths — where, unlike a cell
    // value, the user has no indicator telling them it is stale.
    if !cancelled {
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
                Some(&control_values),
            );
        // Note: calculate_now returns Vec<CellData>, not UpdateCellResult.
        // Dimension changes and style refresh are handled by the frontend
        // re-fetching viewport data after recalculation.
    }

    // WHAT THE PASS LEAVES BEHIND.
    //
    // On a clean finish the pending set is cleared: the workbook is fully
    // calculated and the status bar goes back to "Ready".
    //
    // On a cancel it records the exact remainder. A partial recalc is otherwise
    // an invisible hazard — a stale cell looks precisely like a correct one —
    // and the alternatives were worse: snapshotting the whole grid per recalc is
    // unaffordable and throws away work the user may want, and a per-cell dirty
    // bit adds a field to `Cell` plus an invalidation problem. See
    // eval_budget::PendingRecalc.
    //
    // `pending_recalc` is a LEAF mutex — nothing else is locked underneath it —
    // so taking it here, while the grid locks are still held, cannot deadlock.
    {
        let mut pending = state.pending_recalc.lock().map_err(|e| e.to_string())?;
        if cancelled {
            log_info!("CALC", "cancelled after {} of {} cells; {} left un-recalculated",
                cells_done, total_cells, pending_cells.len());
            *pending = Some(PendingRecalc { sheet_index: active_sheet, cells: pending_cells.clone() });
        } else {
            *pending = None;
        }
    }
    progress.finish(cells_done, cancelled, pending_cells.len());

    Ok(updated_cells)
}

/// Evaluate all formula cells on one sheet (active or not), writing results
/// into grids[sheet_index] (and the active-sheet mirror when applicable).
///
/// calculate_now only ever evaluates the ACTIVE sheet; .calp refresh and
/// override revert/accept write formula cells (value Empty pending recalc)
/// into arbitrary sheets, which would otherwise display empty until the user
/// manually recalculated there. Builds a local same-sheet dependency map for
/// evaluation order — the AppState dependency maps describe only the active
/// sheet. Computed properties are not re-evaluated here (active-sheet
/// machinery; the frontend recalc path covers them).
pub(crate) fn recalculate_sheet_values(
    state: &AppState,
    user_files_state: &UserFilesState,
    pivot_state: &PivotState,
    sheet_index: usize,
    control_states: Option<(&crate::pane_control::PaneControlState, &crate::ribbon_filter::RibbonFilterState)>,
) {
    // PERF-03: one lookup-index cache for the whole pass (lookup_cache.rs).
    let _lookup_pass = engine::begin_lookup_pass();
    // BACKGROUND surface: the user did not personally start this pass (.calp
    // refresh, override revert/accept), but it WRITES CELLS, so it gets exactly
    // the same fuel an interactive edit gets. That equality is a requirement,
    // not an oversight — a formula that computed a value on one path and
    // `#LIMIT!` on another would make the workbook's content depend on which
    // code path last touched it. See EvalSurface.
    //
    // It IS cancellable: these are among the longest passes in the product, and
    // they inherit whatever token the enclosing operation installed.
    // `begin_pass` claims the token only if nothing already owns it: this body
    // is sometimes the whole operation (a bare `.calp` refresh) and sometimes a
    // step inside a longer one (an animation frame, a pivot refresh). Only the
    // outermost claimant may clear the flag, or a nested pass would discard a
    // Cancel the user just issued against the operation containing it.
    let pass = eval_budget::begin_pass(EvalSurface::Background, &state.calc_cancel);
    // GET.CONTROLVALUE snapshot: built BEFORE any grid locks (canonical lock
    // order). None (states unreachable at the call site) => those formulas
    // evaluate to #N/A for this pass (v1).
    let control_values =
        crate::control_values::build_control_values_from_states(state, control_states);
    let mut grid_mirror = state.grid.lock().unwrap();
    let mut grids = state.grids.lock().unwrap();
    let sheet_names = state.sheet_names.lock().unwrap();
    let active_sheet = *state.active_sheet.lock().unwrap();
    if sheet_index >= grids.len() {
        return;
    }
    let styles = state.style_registry.lock().unwrap();
    let user_files = user_files_state.files.lock().unwrap();

    let iteration_enabled = *state.iteration_enabled.lock().unwrap();
    let max_iterations = *state.max_iterations.lock().unwrap();
    let max_change = *state.max_change.lock().unwrap();

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

    let gather_data = crate::calp_commands::build_gather_data(state);
    let gather_fn = |region_id: &str| -> engine::GatherRegionData {
        gather_data.get(region_id).cloned().unwrap_or_default()
    };

    let formula_cells: Vec<_> = grids[sheet_index]
        .cells
        .iter()
        .filter_map(|(&(row, col), cell)| {
            cell.formula_string().map(|f| (row, col, f))
        })
        .collect();
    if formula_cells.is_empty() {
        return;
    }

    let tables_map = state.tables.lock().unwrap();
    let table_names_map = state.table_names.lock().unwrap();
    let named_ranges_map = state.named_ranges.lock().unwrap();
    let (column_widths, row_heights) = {
        let all_cw = state.all_column_widths.lock().unwrap();
        let all_rh = state.all_row_heights.lock().unwrap();
        (
            all_cw.get(sheet_index).cloned().unwrap_or_default(),
            all_rh.get(sheet_index).cloned().unwrap_or_default(),
        )
    };

    // Local same-sheet dependency map for evaluation ordering.
    let mut local_deps = crate::DependencyMap::default();
    for (row, col, _f) in &formula_cells {
        if let Some(cell) = grids[sheet_index].get_cell(*row, *col) {
            if let Some(ast) = &cell.ast {
                let refs = crate::extract_all_references(ast, &grids[sheet_index]);
                if !refs.cells.is_empty() {
                    local_deps.insert((*row, *col), refs.cells);
                }
            }
        }
    }
    let (non_circular, circular_groups) = partition_formula_cells(&formula_cells, &local_deps);

    let mut cancelled = false;
    let mut pending_cells: Vec<PendingCell> = Vec::new();

    for (idx, (row, col, formula)) in non_circular.iter().enumerate() {
        if pass.cancelled() {
            cancelled = true;
            pending_cells.extend(
                non_circular[idx..].iter().map(|(r, c, _)| PendingCell { row: *r, col: *c }),
            );
            break;
        }
        let result = evaluate_single_formula(
            *row, *col, formula,
            &grids, &sheet_names, sheet_index,
            &styles, &user_files, &pivot_data_fn, &gather_fn,
            &tables_map, &table_names_map, &named_ranges_map,
            &row_heights, &column_widths,
            None,
            control_values.as_ref(),
        );
        // Same ordering rule as calculate_now: ask the token BEFORE writing, so
        // a formula aborted mid-flight never lands its `#LIMIT!` in a cell.
        if pass.cancelled() {
            cancelled = true;
            pending_cells.extend(
                non_circular[idx..].iter().map(|(r, c, _)| PendingCell { row: *r, col: *c }),
            );
            break;
        }
        if let Some(cell) = grids[sheet_index].get_cell(*row, *col) {
            let mut updated = cell.clone();
            updated.value = result;
            grids[sheet_index].set_cell(*row, *col, updated.clone());
            if sheet_index == active_sheet {
                grid_mirror.set_cell(*row, *col, updated);
            }
        }
    }

    for (gi, group) in circular_groups.iter().enumerate() {
        if cancelled {
            break;
        }
        if pass.cancelled() {
            cancelled = true;
            for g in &circular_groups[gi..] {
                pending_cells.extend(g.iter().map(|(r, c, _)| PendingCell { row: *r, col: *c }));
            }
            break;
        }
        if !iteration_enabled {
            for (row, col, _formula) in group {
                if let Some(cell) = grids[sheet_index].get_cell(*row, *col) {
                    let mut updated = cell.clone();
                    updated.value = engine::CellValue::Error(engine::CellError::Circular);
                    grids[sheet_index].set_cell(*row, *col, updated.clone());
                    if sheet_index == active_sheet {
                        grid_mirror.set_cell(*row, *col, updated);
                    }
                }
            }
        } else {
            for _iteration in 0..max_iterations {
                if pass.cancelled() {
                    cancelled = true;
                    break;
                }
                let mut max_delta: f64 = 0.0;
                for (row, col, formula) in group {
                    let old_value = grids[sheet_index].get_cell(*row, *col)
                        .map(|c| cell_value_as_f64(&c.value))
                        .unwrap_or(0.0);
                    let new_result = evaluate_single_formula(
                        *row, *col, formula,
                        &grids, &sheet_names, sheet_index,
                        &styles, &user_files, &pivot_data_fn, &gather_fn,
                        &tables_map, &table_names_map, &named_ranges_map,
                        &row_heights, &column_widths,
                        None,
                        control_values.as_ref(),
                    );
                    let new_numeric = cell_value_as_f64(&new_result);
                    if let Some(cell) = grids[sheet_index].get_cell(*row, *col) {
                        let mut updated = cell.clone();
                        updated.value = new_result;
                        grids[sheet_index].set_cell(*row, *col, updated.clone());
                        if sheet_index == active_sheet {
                            grid_mirror.set_cell(*row, *col, updated);
                        }
                    }
                    let delta = (new_numeric - old_value).abs();
                    if delta > max_delta {
                        max_delta = delta;
                    }
                }
                if max_delta < max_change {
                    break;
                }
            }
            if cancelled {
                for g in &circular_groups[gi..] {
                    pending_cells.extend(g.iter().map(|(r, c, _)| PendingCell { row: *r, col: *c }));
                }
                break;
            }
        }
    }

    // Same contract as calculate_now: a cancelled pass records its remainder so
    // the workbook is never silently half-calculated. A clean pass on this sheet
    // clears any pending set that belonged to it.
    if let Ok(mut pending) = state.pending_recalc.lock() {
        if cancelled {
            *pending = Some(PendingRecalc { sheet_index, cells: pending_cells });
        } else if pending.as_ref().is_some_and(|p| p.sheet_index == sheet_index) {
            *pending = None;
        }
    }
}

/// Recalculate all formula cells in the current sheet (same as calculate_now for single-sheet)
///
/// `(async)` for the same reason `calculate_now` is — it delegates straight to
/// it, and a sync wrapper around an off-main-thread body would put the whole
/// thing back on the UI thread.
#[tauri::command(async)]
pub fn calculate_sheet(window: tauri::Window, state: State<'_, AppState>, user_files_state: State<'_, UserFilesState>, pivot_state: State<'_, PivotState>, pane_control_state: State<'_, crate::pane_control::PaneControlState>, ribbon_filter_state: State<'_, crate::ribbon_filter::RibbonFilterState>) -> Result<Vec<CellData>, String> {
    log_enter_info!("CMD", "calculate_sheet");

    // For now, calculate_sheet does the same as calculate_now since we have a single sheet
    let result = calculate_now(window, state, user_files_state, pivot_state, pane_control_state, ribbon_filter_state, None);

    log_exit_info!("CMD", "calculate_sheet", "done");
    result
}

// ============================================================================
// CANCELLATION (the Ctrl+Break analogue)
// ============================================================================

/// Ask the running calculation to stop.
///
/// Does ONE thing: sets an atomic flag. That is the whole point — it must be
/// callable while a recalculation holds every grid lock in the application, so
/// it takes no lock the recalculation could be holding and cannot block or
/// deadlock behind it. The running pass notices at its next poll boundary
/// (roughly every 65,536 charges inside a formula, and between every two cells
/// in the pass loop), stops, and records what it did not get to.
///
/// Returns true if a calculation was plausibly running. It is harmless to call
/// when nothing is running: the flag is cleared by the next pass that claims it
/// (`PassToken::begin`) and by the guard that owns it on the way out, so a
/// stray Cancel cannot abort a future calculation.
#[tauri::command]
pub fn cancel_calculation(state: State<AppState>) -> bool {
    log_enter_info!("CMD", "cancel_calculation");
    state.calc_cancel.cancel();
    true
}

/// The cells a cancelled recalculation never reached, or `None` when the
/// workbook is fully calculated.
///
/// This is what lets the user SEE which cells are stale rather than being told
/// only that "calculation was cancelled" — a stale cell is otherwise visually
/// indistinguishable from a correct one.
#[tauri::command]
pub fn get_pending_recalc(state: State<AppState>) -> Option<PendingRecalc> {
    state.pending_recalc.lock().ok().and_then(|p| p.clone())
}

/// Forget the pending set WITHOUT recalculating.
///
/// Deliberately explicit and deliberately not called from any save or publish
/// path: dropping the marker is a claim that the stale cells no longer matter,
/// and only a human gets to make that claim.
#[tauri::command]
pub fn clear_pending_recalc(state: State<AppState>) -> bool {
    if let Ok(mut pending) = state.pending_recalc.lock() {
        let had = pending.is_some();
        *pending = None;
        return had;
    }
    false
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
