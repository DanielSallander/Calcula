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

/// Set the calculation mode ("automatic" or "manual").
///
/// STRICT: anything else is an error, not a silent coercion. The old behavior
/// (default to "automatic" on a typo) meant a script calling
/// `api.setCalculationMode("Manual ")` silently flipped the workbook to
/// automatic — the exact opposite of what it asked for — and the author never
/// learned why their batch writes were recalculating per-cell.
#[tauri::command]
pub fn set_calculation_mode(state: State<AppState>, mode: String) -> Result<String, String> {
    log_enter_info!("CMD", "set_calculation_mode", "mode={}", mode);

    let valid_mode = match mode.to_lowercase().as_str() {
        "automatic" => "automatic".to_string(),
        "manual" => "manual".to_string(),
        _ => {
            log_warn!("CMD", "invalid calculation mode rejected: {}", mode);
            return Err(format!(
                "Invalid calculation mode '{}': expected 'automatic' or 'manual'",
                mode
            ));
        }
    };

    let mut calc_mode = state.calculation_mode.lock().unwrap();
    *calc_mode = valid_mode.clone();

    log_exit_info!("CMD", "set_calculation_mode", "set to {}", valid_mode);
    Ok(valid_mode)
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

// ---------------------------------------------------------------------------
// Cross-sheet circular references (§2c follow-on)
// ---------------------------------------------------------------------------
//
// `partition_formula_cells` above runs Kahn's algorithm over ONE sheet's local
// map, and that map is built from `ExtractedRefs::cells` — same-sheet
// references only. A cycle that crosses a sheet boundary therefore had no
// detector anywhere: `Sheet1!A1 = Sheet2!A1` with `Sheet2!A1 = Sheet1!A1`
// terminated and produced whichever number the evaluation order happened to
// leave behind, instead of `#CIRCULAR!`. An order-dependent number is the worst
// possible failure for the soak/regression oracles, which compare recalc
// results across runs.
//
// The fix is one workbook-level graph, computed by `workbook_circular_cells`
// and merged into each sheet's partition, so a cross-sheet cycle lands in
// exactly the same `circular_groups` bucket a same-sheet cycle lands in — and
// therefore inherits the ITERATIVE-CALCULATION branch unchanged. That last
// point is the requirement that shaped the design: iterative calculation is a
// supported feature, and a deliberate circular reference under it must keep
// converging rather than start reporting `#CIRCULAR!`.
//
// COST. This is the hot path, so the walk is gated twice before it can become
// a workbook-sized traversal:
//
//   1. **No cross-sheet reference anywhere => return immediately.** The scan
//      that discovers this is the same single AST walk that would build the
//      graph, so a single-sheet workbook pays one pass over its own ASTs and
//      nothing more.
//   2. **The SHEET-LEVEL projection must itself contain a cycle.** Project
//      every cross-sheet edge down to (precedent sheet -> dependent sheet) and
//      run Kahn over that S-node graph. A cell cycle crossing a boundary
//      implies a cycle in this projection, so an ACYCLIC projection is a sound
//      proof that no cross-sheet cell cycle exists — and real workbooks are
//      overwhelmingly layered (data sheets feeding a summary sheet), i.e.
//      acyclic. Only a workbook whose sheets genuinely reference each other in
//      a loop pays for the full cell-level Kahn.
//
// On top of that the result is memoised for the duration of a recalculation
// PASS (`begin_circular_pass`), because `recalc_after_off_sheet_write` calls
// `recalculate_sheet_values` 2*(S+1) times in a row and the answer cannot
// change between those calls: recalculation rewrites cell VALUES, never
// formulas or ASTs, and the graph is a function of the ASTs alone.
//
// Reasoned, not measured: the gates are structural (they remove the traversal
// entirely rather than making it faster), and the memo bounds the remaining
// work at one traversal per pass instead of 2*(S+1).

thread_local! {
    /// `None` = no pass open (compute and throw away).
    /// `Some(None)` = pass open, not computed yet.
    /// `Some(Some(set))` = pass open, computed.
    static CIRCULAR_PASS: std::cell::RefCell<
        Option<Option<std::rc::Rc<std::collections::HashSet<(usize, u32, u32)>>>>,
    > = const { std::cell::RefCell::new(None) };
}

/// Guard returned by `begin_circular_pass`.
pub(crate) struct CircularPassGuard {
    /// Only the OUTERMOST scope clears the memo, so a nested
    /// `recalculate_sheet_values` cannot discard the set its caller is reusing.
    owns: bool,
}

impl Drop for CircularPassGuard {
    fn drop(&mut self) {
        if self.owns {
            CIRCULAR_PASS.with(|c| *c.borrow_mut() = None);
        }
    }
}

/// Memoise cross-sheet cycle detection across every `recalculate_sheet_values`
/// call made inside this scope. Safe precisely because nothing inside a
/// recalculation pass edits a formula.
pub(crate) fn begin_circular_pass() -> CircularPassGuard {
    CIRCULAR_PASS.with(|c| {
        let mut slot = c.borrow_mut();
        if slot.is_some() {
            CircularPassGuard { owns: false }
        } else {
            *slot = Some(None);
            CircularPassGuard { owns: true }
        }
    })
}

/// The pass-scoped accessor: computes on first demand, reuses thereafter.
fn cross_sheet_circular_cells(
    grids: &[engine::Grid],
    sheet_names: &[String],
) -> std::rc::Rc<std::collections::HashSet<(usize, u32, u32)>> {
    let cached = CIRCULAR_PASS.with(|c| c.borrow().clone());
    match cached {
        Some(Some(set)) => set,
        Some(None) => {
            let set = std::rc::Rc::new(workbook_circular_cells(grids, sheet_names));
            CIRCULAR_PASS.with(|c| *c.borrow_mut() = Some(Some(set.clone())));
            set
        }
        None => std::rc::Rc::new(workbook_circular_cells(grids, sheet_names)),
    }
}

/// Every formula cell that sits on — or downstream of — a dependency cycle
/// once CROSS-SHEET edges are taken into account.
///
/// "Downstream of" is deliberate and matches `partition_formula_cells`
/// exactly: Kahn leaves a cell in the residue when any precedent of it is
/// still in the residue, so a cell reading a circular cell is reported too.
/// The same-sheet detector has always behaved that way, and the two must agree
/// or a cycle would be reported differently depending on whether it happened
/// to cross a boundary.
///
/// Returns an EMPTY set for a workbook with no cross-sheet references at all,
/// so same-sheet-only workbooks are unaffected (their cycles are still found
/// by `partition_formula_cells`, which keeps running unchanged).
pub(crate) fn workbook_circular_cells(
    grids: &[engine::Grid],
    sheet_names: &[String],
) -> std::collections::HashSet<(usize, u32, u32)> {
    use std::collections::{HashMap, HashSet, VecDeque};

    type Node = (usize, u32, u32);

    // Precedent lists over FORMULA CELLS ONLY. A literal has no outgoing edge,
    // so it can never be part of a cycle and never needs to be a node.
    let mut precedents: HashMap<Node, Vec<Node>> = HashMap::new();
    let mut formula_cells: Vec<Node> = Vec::new();
    // (precedent sheet -> dependent sheet) for CROSS-sheet edges only.
    let mut sheet_edges: HashSet<(usize, usize)> = HashSet::new();
    // Raw, un-filtered cross-sheet edges; kept so the second phase does not
    // have to re-walk every AST.
    let mut cross_edges: Vec<(Node, Node)> = Vec::new();
    let mut same_sheet_edges: Vec<(Node, Node)> = Vec::new();

    // Sheet name -> index, matched case-insensitively because the lexer
    // UPPERCASES bare identifiers (`=Sheet1!A2` is stored as `SHEET1!A2`).
    // Same normalisation `normalize_cross_sheet_refs` performs for the
    // dependency maps; done inline here because this walk wants the INDEX, and
    // resolving straight to it avoids materialising the canonical name.
    let sheet_index_of = |name: &str| -> Option<usize> {
        sheet_names.iter().position(|n| n.eq_ignore_ascii_case(name))
    };

    for (sheet_idx, grid) in grids.iter().enumerate() {
        for (&(row, col), cell) in &grid.cells {
            let Some(ast) = &cell.ast else { continue };
            if !cell.has_formula() {
                continue;
            }
            let node: Node = (sheet_idx, row, col);
            formula_cells.push(node);

            let refs = crate::extract_all_references(ast, grid);
            for &(r, c) in &refs.cells {
                same_sheet_edges.push(((sheet_idx, r, c), node));
            }
            for (name, r, c) in &refs.cross_sheet_cells {
                let Some(target_sheet) = sheet_index_of(name) else {
                    continue; // reference to a sheet that no longer exists
                };
                // A PREFIXED reference to the cell's own sheet
                // (`=Sheet1!A1` written on Sheet1) is a same-sheet edge that
                // `ExtractedRefs::cells` never reports, so the local detector
                // misses it too. Recorded as a sheet SELF-loop below, which is
                // what makes the projection treat it as cyclic.
                sheet_edges.insert((target_sheet, sheet_idx));
                cross_edges.push(((target_sheet, *r, *c), node));
            }
        }
    }

    // GATE 1: no cross-sheet reference anywhere.
    if sheet_edges.is_empty() {
        return HashSet::new();
    }

    // GATE 2: the sheet-level projection must contain a cycle.
    if !sheet_graph_has_cycle(&sheet_edges, sheet_names.len()) {
        return HashSet::new();
    }

    // Full cell-level Kahn over both edge kinds.
    let formula_set: HashSet<Node> = formula_cells.iter().copied().collect();
    for (from, to) in same_sheet_edges.into_iter().chain(cross_edges.into_iter()) {
        if formula_set.contains(&from) {
            precedents.entry(to).or_default().push(from);
        }
    }

    let mut in_degree: HashMap<Node, usize> = formula_cells.iter().map(|&n| (n, 0)).collect();
    let mut dependents: HashMap<Node, Vec<Node>> = HashMap::new();
    for (&node, preds) in &precedents {
        for &pred in preds {
            *in_degree.entry(node).or_insert(0) += 1;
            dependents.entry(pred).or_default().push(node);
        }
    }

    let mut queue: VecDeque<Node> = in_degree
        .iter()
        .filter(|(_, &d)| d == 0)
        .map(|(&n, _)| n)
        .collect();
    let mut removed: HashSet<Node> = HashSet::new();
    while let Some(node) = queue.pop_front() {
        removed.insert(node);
        if let Some(deps) = dependents.get(&node) {
            for &dep in deps {
                if let Some(d) = in_degree.get_mut(&dep) {
                    *d -= 1;
                    if *d == 0 {
                        queue.push_back(dep);
                    }
                }
            }
        }
    }

    formula_set.difference(&removed).copied().collect()
}

/// Kahn over the S-node sheet projection. A self-edge (a sheet referencing
/// itself through an explicit prefix) counts as a cycle: it can never reach
/// in-degree zero, which is exactly the answer wanted.
fn sheet_graph_has_cycle(edges: &std::collections::HashSet<(usize, usize)>, sheets: usize) -> bool {
    use std::collections::VecDeque;

    let mut in_degree = vec![0usize; sheets];
    let mut out: Vec<Vec<usize>> = vec![Vec::new(); sheets];
    let mut edge_count = 0usize;
    for &(from, to) in edges {
        if from >= sheets || to >= sheets {
            continue;
        }
        out[from].push(to);
        in_degree[to] += 1;
        edge_count += 1;
    }
    if edge_count == 0 {
        return false;
    }

    let mut queue: VecDeque<usize> = (0..sheets).filter(|&i| in_degree[i] == 0).collect();
    let mut removed = 0usize;
    while let Some(node) = queue.pop_front() {
        removed += 1;
        for &next in &out[node] {
            in_degree[next] -= 1;
            if in_degree[next] == 0 {
                queue.push_back(next);
            }
        }
    }
    removed != sheets
}

/// Move this sheet's cross-sheet cycle members out of the topologically-sorted
/// bucket and into the circular bucket, so they take the SAME branch a
/// same-sheet cycle takes: `#CIRCULAR!` when iteration is off, and the
/// convergence loop when it is on.
///
/// Members already in a same-sheet circular group are untouched — they are not
/// in `non_circular` to begin with.
fn merge_cross_sheet_circular(
    sheet_index: usize,
    circular: &std::collections::HashSet<(usize, u32, u32)>,
    non_circular: &mut Vec<(u32, u32, String)>,
    circular_groups: &mut Vec<Vec<(u32, u32, String)>>,
) {
    if circular.is_empty() {
        return;
    }
    let on_this_sheet: std::collections::HashSet<(u32, u32)> = circular
        .iter()
        .filter(|(s, _, _)| *s == sheet_index)
        .map(|(_, r, c)| (*r, *c))
        .collect();
    if on_this_sheet.is_empty() {
        return;
    }
    let moved: Vec<(u32, u32, String)> = non_circular
        .iter()
        .filter(|(r, c, _)| on_this_sheet.contains(&(*r, *c)))
        .cloned()
        .collect();
    if moved.is_empty() {
        return;
    }
    non_circular.retain(|(r, c, _)| !on_this_sheet.contains(&(*r, *c)));
    // ONE group for the whole sheet-local residue. Grouping matters only under
    // iterative calculation, where a group is iterated as a unit; merging
    // independent cycles into one unit converges them together, which is
    // wasteful at worst and never wrong.
    circular_groups.push(moved);
}

/// Stamp `#CIRCULAR!` on the members of a detected cross-sheet cycle that do
/// NOT live on the sheet this pass is evaluating. Returns the cells it changed.
///
/// WHY THIS EXISTS — THE OTHER HALF OF THE SAME FACT.
/// `merge_cross_sheet_circular` moves only the members on `active_sheet` into a
/// circular group, because that is the only sheet a pass evaluates. `calculate_now`
/// evaluates exactly one sheet, so with `Sheet1!A1 = Sheet2!A1` and
/// `Sheet2!A1 = Sheet1!A1` it reported `#CIRCULAR!` on the sheet you were LOOKING
/// AT and left the other member holding whatever number the previous evaluation
/// order produced — `0`. Measured on the running app, not reasoned: F9 on Sheet1
/// gave `#CIRCULAR` / `0`, and only a second F9 after switching to Sheet2 made the
/// two agree.
///
/// That surviving number is the exact defect the workbook-level detector exists to
/// remove. It is also strictly worse than the original bug in one respect: half the
/// cycle now says "error" while the other half says "zero", so a user reading the
/// summary sheet gets a plausible number with a contradiction one tab away.
/// `recalculate_sheet_values` never had the problem because the off-sheet write path
/// calls it for EVERY sheet; nothing calls `calculate_now` more than once.
///
/// A CYCLE IS A WORKBOOK-LEVEL FACT, so it is reported on every sheet that owns a
/// member. This is not a second detector and not a second traversal: `circular` is
/// the set the caller already computed, it is EMPTY for any workbook with no
/// cross-sheet reference at all (gate 1 of `workbook_circular_cells`), and this
/// walks only its own members.
///
/// GATED ON ITERATION BEING OFF, for the same reason the active-sheet branch is:
/// under iterative calculation the members CONVERGE (one hop per whole-workbook
/// round — see `recalculate_sheet_values`), and stamping them here would be exactly
/// the regression `iterative_mode_never_writes_circular_across_sheets` forbids.
///
/// The ACTIVE sheet is deliberately skipped: its members are written by the caller's
/// own circular-group loop, which also owns the iterative branch and the mirror.
pub(crate) fn mark_off_sheet_circular_cells(
    grids: &mut [engine::Grid],
    circular: &std::collections::HashSet<(usize, u32, u32)>,
    active_sheet: usize,
    iteration_enabled: bool,
) -> Vec<(usize, u32, u32)> {
    if circular.is_empty() || iteration_enabled {
        return Vec::new();
    }
    // Sorted so the reported order is deterministic: these cells reach the
    // frontend as a list, and the soak/regression oracles compare runs.
    let mut targets: Vec<(usize, u32, u32)> = circular
        .iter()
        .filter(|(s, _, _)| *s != active_sheet && *s < grids.len())
        .copied()
        .collect();
    targets.sort_unstable();

    let mut marked = Vec::new();
    for (sheet, row, col) in targets {
        let existing = match grids[sheet].get_cell(row, col).cloned() {
            Some(cell) => cell,
            None => continue,
        };
        // Already reported: nothing moved, so nothing is announced. Keeps a
        // repeated F9 from re-emitting the whole cycle every time.
        if matches!(
            existing.value,
            engine::CellValue::Error(engine::CellError::Circular)
        ) {
            continue;
        }
        let mut updated = existing;
        updated.value = engine::CellValue::Error(engine::CellError::Circular);
        grids[sheet].set_cell(row, col, updated);
        marked.push((sheet, row, col));
    }
    marked
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
    // SUBTOTAL/AGGREGATE row-visibility snapshot: built ONCE for this
    // pass (never per formula) and read by the evaluator through the
    // thread-local pass scope. Built BEFORE any grid lock is taken.
    let _visibility_pass = crate::row_visibility::begin_pass(&state);
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
    // CENSUS "UNCLEAR" -> DELIBERATELY CLEAN (DerivedCache). Recalculation rewrites
    // cell VALUES, and values are persisted, so this looks like a document mutation.
    // It is not one, for two reasons.
    //
    // 1. The values are DERIVED. They are a pure function of state that is itself
    //    persisted (formulas, inputs, locale, the model), so a recalc result can never
    //    be "lost" at close -- reopening the workbook reproduces it. Dirtying here
    //    would offer to save work that was never at risk.
    // 2. It would make the prompt lie in the expensive direction. A workbook holding
    //    NOW(), TODAY() or RAND() recalculates on open and on all sorts of ambient
    //    events; marking dirty would make merely LOOKING at such a file prompt to save
    //    on close. That is precisely the unpredictable prompt this whole effort exists
    //    to prevent -- a prompt users learn to dismiss protects nothing.
    //
    // The commands that make a recalc's results meaningful DO mark: the edit that
    // caused the staleness (update_cell / update_cells_batch), and `clear_pending_recalc`
    // when a human discards the marker. Note also that `save_file` calls this command
    // itself when calculate-before-save is on (persistence.rs) and then assigns
    // is_modified = false; a dirty mark here would be both wrong and immediately undone.
    //
    // `calculate_sheet` delegates straight to this function and inherits the decision.
    // Recorded rather than omitted: `rg deliberately_clean` must list every such call.
    let effect = crate::document_effect::DocumentEffect::deliberately_clean(
        crate::document_effect::CleanReason::DerivedCache,
    );
    // Pre-fetched CUBE data for this full recalc (built async by cube_prefetch_all
    // on the frontend before calling). Shared via Arc so each formula's eval gets
    // it cheaply; None => cube cells preserve their last value (see eval_cube).
    let cube_arc = cube_results.map(std::sync::Arc::new);
    // GET.CONTROLVALUE snapshot: built ONCE per recalc, BEFORE the grid locks
    // below (canonical lock order: control stores first, grids last).
    let control_values = crate::control_values::build_control_values(
        &state, &pane_control_state, &ribbon_filter_state,
    );
    let mut grid = state.grid.write(&effect).unwrap();
    let mut grids = state.grids.write(&effect).unwrap();
    let sheet_names = state.sheet_names.read().unwrap();
    let active_sheet = *state.active_sheet.read().unwrap();

    // The active-sheet mirror (state.grid) is the source of truth; grids[i]
    // can lag behind it (see get_watch_cells note in commands/data.rs).
    // Formula evaluation below reads the ACTIVE sheet through `grids`, so a
    // stale grids[active] silently recalculates from old values (BUG-0016).
    // Sync it from the mirror before evaluating.
    if active_sheet < grids.len() {
        grids[active_sheet] = grid.clone();
    }
    let mut styles = state.style_registry.write(&effect).unwrap();
    let user_files = user_files_state.files.lock().unwrap();
    let locale = state.locale.lock().unwrap();

    // Read iteration settings
    let iteration_enabled = *state.iteration_enabled.lock().unwrap();
    let max_iterations = *state.max_iterations.lock().unwrap();
    let max_change = *state.max_change.lock().unwrap();

    // Build pivot data lookup closure for GETPIVOTDATA
    let pivot_tables = pivot_state.pivot_tables.read().unwrap();
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
    let tables_map = state.tables.read().unwrap();
    let table_names_map = state.table_names.read().unwrap();
    let named_ranges_map = state.named_ranges.read().unwrap();
    let mut row_heights = state.row_heights.write(&effect).unwrap();
    let mut column_widths = state.column_widths.write(&effect).unwrap();
    let dependencies_map = state.dependencies.lock().unwrap();

    // Partition formula cells into non-circular (topological order) and circular groups
    let (mut non_circular, mut circular_groups) = partition_formula_cells(&formula_cells, &dependencies_map);
    drop(dependencies_map);

    // §2c follow-on: `state.dependencies` has no sheet dimension, so F9 could
    // not see a cycle that crosses a boundary either. Same merge as
    // `recalculate_sheet_values`; the sheet under recalculation here is always
    // the active one.
    {
        let cross_circular = cross_sheet_circular_cells(&grids, &sheet_names);
        merge_cross_sheet_circular(
            active_sheet,
            &cross_circular,
            &mut non_circular,
            &mut circular_groups,
        );
        // ...and the members on the OTHER sheets, which this pass does not
        // evaluate and which were therefore left holding an order-dependent
        // number while the active sheet said `#CIRCULAR!`. See
        // `mark_off_sheet_circular_cells` for the measurement.
        let marked =
            mark_off_sheet_circular_cells(&mut grids, &cross_circular, active_sheet, iteration_enabled);
        for (sheet, row, col) in marked {
            let effective_style_index = grids[sheet].effective_style_index(row, col);
            let style = styles.get(effective_style_index);
            let formula = grids[sheet]
                .get_cell(row, col)
                .and_then(|c| c.formula_string())
                .map(|f| format!("={}", f));
            updated_cells.push(CellData {
                row,
                col,
                display: format_cell_value(
                    &engine::CellValue::Error(engine::CellError::Circular),
                    style,
                    &locale,
                ),
                display_color: None,
                formula,
                style_index: effective_style_index,
                row_span: 1,
                col_span: 1,
                // NAMED, so the frontend cannot paint an off-sheet value onto the
                // sheet on screen: Core applies only cells with no sheet index.
                sheet_index: Some(sheet),
                rich_text: None,
                accounting_layout: None,
            });
        }
    }

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
        // Refreshes each property's CACHED VALUE from formulas that are themselves
        // persisted -- the same derived-state argument as the recalc pass this sits in
        // (see the `effect` at the top of this command). The property definitions are
        // untouched here; add/update/remove_computed_property own the dirty flag.
        let mut cp_storage = state.computed_properties.write(&effect).unwrap();
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
    // SUBTOTAL/AGGREGATE row-visibility snapshot: built ONCE for this
    // pass (never per formula) and read by the evaluator through the
    // thread-local pass scope. Built BEFORE any grid lock is taken.
    let _visibility_pass = crate::row_visibility::begin_pass(state);
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
    // RECALC COMPANION. This pass re-derives cell VALUES from inputs that are
    // themselves persisted (formulas, literals, locale, control values), so it
    // must not dirty on its own account: the ENTRY command that made those
    // values stale already owns the flag, and dirtying here would make a
    // workbook holding NOW()/RAND() prompt to save merely for being looked at.
    // See CleanReason::RecalcCompanion.
    let effect = crate::document_effect::DocumentEffect::deliberately_clean(
        crate::document_effect::CleanReason::RecalcCompanion,
    );
    let mut grid_mirror = state.grid.write(&effect).unwrap();
    let mut grids = state.grids.write(&effect).unwrap();
    let sheet_names = state.sheet_names.read().unwrap();
    let active_sheet = *state.active_sheet.read().unwrap();
    if sheet_index >= grids.len() {
        return;
    }
    let styles = state.style_registry.read().unwrap();
    let user_files = user_files_state.files.lock().unwrap();

    let iteration_enabled = *state.iteration_enabled.lock().unwrap();
    let max_iterations = *state.max_iterations.lock().unwrap();
    let max_change = *state.max_change.lock().unwrap();

    let pivot_tables = pivot_state.pivot_tables.read().unwrap();
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

    let tables_map = state.tables.read().unwrap();
    let table_names_map = state.table_names.read().unwrap();
    let named_ranges_map = state.named_ranges.read().unwrap();
    let (column_widths, row_heights) = {
        let all_cw = state.all_column_widths.read().unwrap();
        let all_rh = state.all_row_heights.read().unwrap();
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
    let (mut non_circular, mut circular_groups) =
        partition_formula_cells(&formula_cells, &local_deps);

    // §2c follow-on: `local_deps` describes THIS sheet only, so a cycle that
    // crosses a boundary is invisible to the partition above and used to
    // produce an order-dependent number. Merge the workbook-level answer in.
    let cross_circular = cross_sheet_circular_cells(&grids, &sheet_names);
    merge_cross_sheet_circular(
        sheet_index,
        &cross_circular,
        &mut non_circular,
        &mut circular_groups,
    );

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
///
/// CENSUS "UNCLEAR" -> MUTATES-DOCUMENT. `AppState::pending_recalc` really is
/// persisted (`attach_pending_recalc_for_save` / `restore_pending_recalc_on_load`),
/// so dropping the staleness marker changes what a save writes -- and it is a
/// human's explicit claim, which is exactly the kind of decision the close prompt
/// exists to protect. Conditional on `had`: clearing an already-empty marker
/// changes nothing and must not dirty.
#[tauri::command]
pub fn clear_pending_recalc(state: State<AppState>, file_state: State<crate::persistence::FileState>) -> bool {
    clear_pending_recalc_impl(&state, &file_state)
}

/// Command body over plain references, so the "unclear -> mutates-document" decision
/// above is unit-testable without a Tauri `State`.
pub(crate) fn clear_pending_recalc_impl(
    state: &AppState,
    file_state: &crate::persistence::FileState,
) -> bool {
    if let Ok(mut pending) = state.pending_recalc.lock() {
        let had = pending.is_some();
        *pending = None;
        if had {
            let _effect = crate::document_effect::DocumentEffect::mutates(&file_state);
        }
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

// ============================================================================
// VISIBILITY-DEPENDENT RECALCULATION (SUBTOTAL / AGGREGATE)
// ============================================================================

/// Cheap string prefilter for a formula that could depend on row VISIBILITY.
///
/// `Cell::formula_string()` renders the CANONICAL function name, so matching
/// these two substrings catches every spelling and every nesting depth. It is
/// deliberately over-broad (a defined name like `SUBTOTAL_HELPER` matches): a
/// false positive costs one extra re-evaluation, a false negative leaves a
/// wrong number on screen.
fn formula_depends_on_visibility(formula: &str) -> bool {
    let upper = formula.to_uppercase();
    upper.contains("SUBTOTAL") || upper.contains("AGGREGATE")
}

/// Targeted recalc after ROW VISIBILITY changed — hide/unhide, an AutoFilter
/// applied or cleared, an advanced filter, an outline group collapsed or
/// expanded, and the undo of any of those.
///
/// WHY THIS EXISTS. SUBTOTAL and AGGREGATE are the only functions whose result
/// depends on something that is not a cell value. Nothing in the dependency
/// graph links them to "row 7 is now hidden": no cell was written, so no
/// dependent was dirtied, so without this pass a `SUBTOTAL(109, A1:A100)` keeps
/// displaying its pre-hide total until some unrelated edit happens to sweep it
/// up. A stale total is exactly as wrong as the ignored-hidden-rows bug this
/// change fixes — arguably worse, because it looks authoritative.
///
/// It is the `recalc_control_dependents_core` pattern with a different seed
/// rule (GET.CONTROLVALUE cells -> SUBTOTAL/AGGREGATE cells), and it shares
/// that path's helpers and its documented v1 limitations:
///
/// 1. **Other-sheet pass.** Every non-active sheet holding a visibility-
///    dependent formula is recalculated whole via `recalculate_sheet_values`,
///    together with every sheet that transitively depends on one of them, in
///    sheet-level dependency order. No spill maintenance and no `CellData`
///    reporting off the active sheet (the frontend refetches on sheet switch).
/// 2. **Active-sheet pass.** Seeds = the active sheet's visibility-dependent
///    cells, plus every active-sheet cell referencing a sheet recalculated in
///    pass 1. Seeds and their dependents re-evaluate through the shared
///    `reevaluate_formula_cell` cascade (so results SPILL and collapse exactly
///    like an edit), then `cascade_cross_sheet_dependents` propagates forward.
///
/// A cross-sheet SUBTOTAL is covered from either direction: a formula on
/// Sheet1 reading `Sheet2!A1:A10` is an active-sheet seed by its own text, and
/// one on Sheet3 reading the same range is swept up by the other-sheet pass.
///
/// Callers must hold NO grid or store lock. Honours manual calculation mode,
/// like every other dependent cascade. Returns the active-sheet cells to apply.
pub(crate) fn recalc_visibility_dependents_core(
    state: &AppState,
    user_files_state: &UserFilesState,
    pivot_state: &PivotState,
    control_states: Option<(
        &crate::pane_control::PaneControlState,
        &crate::ribbon_filter::RibbonFilterState,
    )>,
) -> Result<Vec<CellData>, String> {
    use std::collections::{HashMap, HashSet};

    // PERF-03: one lookup-index cache for the whole pass (lookup_cache.rs).
    let _lookup_pass = engine::begin_lookup_pass();
    // THE POINT OF THE PASS: the snapshot is rebuilt here, so these formulas
    // re-evaluate against the visibility state that just changed.
    let _visibility_pass = crate::row_visibility::begin_pass(state);
    // BACKGROUND: the user hid a row; the cascade that follows writes cells.
    let _pass = eval_budget::begin_pass(EvalSurface::Background, &state.calc_cancel);

    {
        let calc_mode = state.calculation_mode.lock().unwrap();
        if *calc_mode != "automatic" {
            return Ok(Vec::new());
        }
    }

    let control_values =
        crate::control_values::build_control_values_from_states(state, control_states);

    // RECALC COMPANION. This pass re-derives cell VALUES from inputs that are
    // themselves persisted (formulas, literals, locale, control values), so it
    // must not dirty on its own account: the ENTRY command that made those
    // values stale already owns the flag, and dirtying here would make a
    // workbook holding NOW()/RAND() prompt to save merely for being looked at.
    // See CleanReason::RecalcCompanion.
    let effect = crate::document_effect::DocumentEffect::deliberately_clean(
        crate::document_effect::CleanReason::RecalcCompanion,
    );
    // Pre-pass: sync the active-sheet mirror into `grids` (BUG-0016 discipline)
    // and find the non-active sheets holding visibility-dependent formulas.
    let (visibility_sheets, prepass_active_sheet) = {
        let grid = state.grid.read().unwrap();
        let mut grids = state.grids.write(&effect).unwrap();
        let active_sheet = *state.active_sheet.read().unwrap();
        if active_sheet < grids.len() {
            grids[active_sheet] = grid.clone();
        }
        let list: Vec<usize> = grids
            .iter()
            .enumerate()
            .filter(|&(idx, g)| {
                idx != active_sheet
                    && g.cells.values().any(|cell| {
                        cell.formula_string()
                            .is_some_and(|f| formula_depends_on_visibility(&f))
                    })
            })
            .map(|(idx, _)| idx)
            .collect();
        (list, active_sheet)
    };

    // Sheet-level cross-sheet edges, and the active-sheet cells referencing
    // each source sheet (reverse-propagation seeds). Brief locks, canonical
    // order, no grid lock held.
    let (sheet_edges, active_deps_by_source) = {
        let sheet_names = state.sheet_names.read().unwrap();
        let cross = state.cross_sheet_dependents.lock().unwrap();
        let mut edges: HashMap<usize, HashSet<usize>> = HashMap::new();
        let mut active_deps: HashMap<usize, Vec<(u32, u32)>> = HashMap::new();
        for ((src_name, _r, _c), deps) in cross.iter() {
            let Some(src_idx) = sheet_names
                .iter()
                .position(|n| n.eq_ignore_ascii_case(src_name))
            else {
                continue;
            };
            for &(dep_sheet, dep_row, dep_col) in deps.iter() {
                if dep_sheet != src_idx {
                    edges.entry(src_idx).or_default().insert(dep_sheet);
                }
                if dep_sheet == prepass_active_sheet && src_idx != prepass_active_sheet {
                    active_deps
                        .entry(src_idx)
                        .or_default()
                        .push((dep_row, dep_col));
                }
            }
        }
        (edges, active_deps)
    };

    // Pass 1: other sheets, whole-sheet recalc in sheet-level dependency order.
    let other_recalc = crate::control_values::ordered_sheet_closure(
        &visibility_sheets,
        &sheet_edges,
        prepass_active_sheet,
    );
    for &idx in &other_recalc {
        recalculate_sheet_values(state, user_files_state, pivot_state, idx, control_states);
    }

    let extra_seeds: Vec<(u32, u32)> = {
        let recalced: HashSet<usize> = other_recalc.iter().copied().collect();
        let mut set: HashSet<(u32, u32)> = HashSet::new();
        for (src_idx, deps) in active_deps_by_source.iter() {
            if recalced.contains(src_idx) {
                set.extend(deps.iter().copied());
            }
        }
        let mut list: Vec<(u32, u32)> = set.into_iter().collect();
        list.sort_unstable();
        list
    };

    // Pass 2: active sheet, spill-aware, under the update_cell-style lock set.
    let updated_cells = {
        let user_files = user_files_state.files.lock().unwrap();
        let sheet_names = state.sheet_names.read().unwrap();
        let mut grid = state.grid.write(&effect).unwrap();
        let mut grids = state.grids.write(&effect).unwrap();
        let active_sheet = *state.active_sheet.read().unwrap();
        if active_sheet < grids.len() {
            grids[active_sheet] = grid.clone();
        }

        let styles = state.style_registry.read().unwrap();
        let dependents_map = state.dependents.lock().unwrap();
        let column_dependents_map = state.column_dependents.lock().unwrap();
        let row_dependents_map = state.row_dependents.lock().unwrap();
        let cross_sheet_dependents_map = state.cross_sheet_dependents.lock().unwrap();
        let merged_regions = state.merged_regions.read().unwrap();
        let locale = state.locale.lock().unwrap();
        let cascade_tables = state.tables.read().unwrap();
        let cascade_table_names = state.table_names.read().unwrap();
        let cascade_named_ranges = state.named_ranges.read().unwrap();

        let mut seeds: Vec<(u32, u32)> = grid
            .cells
            .iter()
            .filter_map(|(&(row, col), cell)| {
                let formula = cell.formula_string()?;
                formula_depends_on_visibility(&formula).then_some((row, col))
            })
            .collect();
        seeds.sort_unstable();

        {
            let seed_set: HashSet<(u32, u32)> = seeds.iter().copied().collect();
            for &coord in &extra_seeds {
                if !seed_set.contains(&coord) {
                    seeds.push(coord);
                }
            }
        }

        if seeds.is_empty() {
            Vec::new()
        } else {
            let mut affected =
                crate::control_values::multi_root_recalc_order(&seeds, &dependents_map);
            let mut affected_set: HashSet<(u32, u32)> = affected.iter().copied().collect();
            for &seed in &seeds {
                let extra = crate::get_column_row_dependents(
                    seed,
                    &column_dependents_map,
                    &row_dependents_map,
                );
                let mut extra: Vec<(u32, u32)> = extra
                    .into_iter()
                    .filter(|d| !affected_set.contains(d))
                    .collect();
                extra.sort_unstable();
                for dep in extra {
                    affected_set.insert(dep);
                    affected.push(dep);
                }
            }

            let merge_lookup: HashMap<(u32, u32), &crate::api_types::MergedRegion> =
                merged_regions
                    .iter()
                    .map(|r| ((r.start_row, r.start_col), r))
                    .collect();

            let mut updated_cells: Vec<CellData> = Vec::new();
            let mut cache_hits = 0u32;
            let mut cache_misses = 0u32;
            let include_cascade_formulas =
                affected.len() <= crate::commands::data::CASCADE_FORMULA_LIMIT;

            for &(row, col) in &affected {
                let cell_opt = grid.get_cell(row, col).cloned();
                if let Some(cell) = cell_opt {
                    if let Some(formula) = cell.formula_string() {
                        crate::commands::data::reevaluate_formula_cell(
                            state,
                            &mut grid,
                            &mut grids,
                            &sheet_names,
                            active_sheet,
                            row,
                            col,
                            &cell,
                            &formula,
                            &user_files,
                            // No UDF / CUBE prefetch on this path: those
                            // dependents PRESERVE their stored value (the
                            // preserve-on-no-prefetch invariant), same as the
                            // control-value cascade.
                            None,
                            None,
                            control_values.as_ref(),
                            &styles,
                            &locale,
                            &merge_lookup,
                            &cascade_tables,
                            &cascade_table_names,
                            &cascade_named_ranges,
                            &mut updated_cells,
                            &mut cache_hits,
                            &mut cache_misses,
                            include_cascade_formulas,
                        );
                    }
                }
            }

            let initial_changed: Vec<(u32, u32)> = {
                let mut seen: HashSet<(u32, u32)> = HashSet::new();
                updated_cells
                    .iter()
                    .filter(|c| c.sheet_index.is_none())
                    .filter_map(|c| seen.insert((c.row, c.col)).then_some((c.row, c.col)))
                    .collect()
            };
            let no_controls =
                std::sync::Arc::new(crate::control_values::ControlValuesMap::new());
            crate::commands::data::cascade_cross_sheet_dependents(
                &mut grid,
                &mut grids,
                &sheet_names,
                active_sheet,
                &cross_sheet_dependents_map,
                &user_files,
                control_values.as_ref().unwrap_or(&no_controls),
                &styles,
                &locale,
                &merge_lookup,
                &initial_changed,
                &affected,
                &mut updated_cells,
                include_cascade_formulas,
            );

            updated_cells
        }
    };

    Ok(updated_cells)
}

/// Tauri wrapper for `recalc_visibility_dependents_core`.
///
/// Exposed as a command so the surfaces that change row visibility WITHOUT
/// going through the backend hide command — an AutoFilter applied from the
/// ribbon, an outline group collapsed — can request the dependent
/// recalculation with one invoke.
#[tauri::command]
pub fn recalc_visibility_dependents(
    state: State<AppState>,
    user_files_state: State<UserFilesState>,
    pivot_state: State<'_, PivotState>,
    pane_control_state: State<'_, crate::pane_control::PaneControlState>,
    ribbon_filter_state: State<'_, crate::ribbon_filter::RibbonFilterState>,
) -> Result<Vec<CellData>, String> {
    recalc_visibility_dependents_core(
        &state,
        &user_files_state,
        &pivot_state,
        Some((&pane_control_state, &ribbon_filter_state)),
    )
}

/// Run the SUBTOTAL/AGGREGATE cascade after a row-visibility change, resolving
/// every state it needs from the `AppHandle`.
///
/// WHY A HANDLE AND NOT FIVE `State` PARAMS: the surfaces that change row
/// visibility without going through `set_rows_hidden` — every AutoFilter
/// command, every outline collapse/expand — are ~17 commands whose signatures
/// would each have to grow five parameters. Tauri injects `AppHandle` just as
/// happily, and `Manager::state()` resolves the rest, so each of those commands
/// pays ONE parameter and ONE call.
///
/// FAILURES ARE SWALLOWED ON PURPOSE, exactly as in
/// `commands::dimensions::recalc_visibility_after_row_change`: the filter or
/// collapse itself already succeeded, and a failed recalculation must not turn
/// a successful, undoable user action into an error. The stale-value case is
/// then no worse than before this pass existed.
///
/// Emits `grid:refresh` when cells actually changed — no cell was *written* by
/// the visibility change itself, so nothing else would tell the frontend to
/// refetch.
///
/// CALLERS MUST HOLD NO GRID OR STORE LOCK. Call it after the command body has
/// returned and its locks have dropped (the `*_inner` split in autofilter.rs
/// and grouping.rs exists for exactly this reason).
///
/// There is deliberately NO column counterpart: SUBTOTAL and AGGREGATE are
/// row-oriented, and Microsoft's AGGREGATE reference states outright that
/// hiding columns in a horizontal range does not affect the result.
pub(crate) fn recalc_visibility_after_row_change_from_handle(app: &tauri::AppHandle) {
    use tauri::{Emitter, Manager};

    let state = app.state::<AppState>();
    let user_files_state = app.state::<UserFilesState>();
    let pivot_state = app.state::<PivotState>();
    let pane_control_state = app.state::<crate::pane_control::PaneControlState>();
    let ribbon_filter_state = app.state::<crate::ribbon_filter::RibbonFilterState>();

    match recalc_visibility_dependents_core(
        &state,
        &user_files_state,
        &pivot_state,
        Some((&pane_control_state, &ribbon_filter_state)),
    ) {
        Ok(cells) if !cells.is_empty() => {
            let _ = app.emit("grid:refresh", ());
        }
        Ok(_) => {}
        Err(e) => {
            crate::log_warn!("CMD", "visibility recalc after filter/outline change failed: {}", e);
        }
    }
}
