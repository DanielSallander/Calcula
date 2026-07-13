//! FILENAME: app/src-tauri/src/control_values.rs
//! PURPOSE: Build the GET.CONTROLVALUE snapshot Arc that gets threaded into
//!          `engine::EvalContext.control_values` by every recalc path.
//! CONTEXT: Wraps pane_control::values::collect_control_values over the three
//!          control families (pane controls, ribbon filters, named on-grid
//!          controls). Build ONCE per command and share the Arc across every
//!          formula evaluation that command performs.
//!
//! LOCK ORDER (deadlock discipline — matches pane_control/values.rs and the
//! resolve_control_properties convention in controls.rs):
//!   1. pane-controls lock  -> extract entries -> DROP
//!   2. ribbon-filters lock -> extract entries -> DROP
//!   3. on-grid controls lock -> CLONE storage -> DROP
//!   4. only THEN read grids (lock briefly here, or use a caller-held slice)
//! Never hold two of these locks at once. Paths that already hold the grids
//! lock must use `build_control_values_with_grids` — acquiring the store
//! locks while grids are held is safe precisely BECAUSE no code path holds a
//! store lock while acquiring grids. (update_cell and the targeted recalc
//! below build their snapshot BEFORE taking any grid lock.)

use std::collections::{HashMap, HashSet, VecDeque};
use std::sync::Arc;

use parser::ast::{BuiltinFunction, Expression, Value};
use tauri::State;

use crate::api_types::{CellData, MergedRegion};
use crate::controls::ControlMetadata;
use crate::pane_control::values::{
    collect_control_values, on_grid_named_values, pane_control_named_values,
    ribbon_filter_named_values,
};
use crate::pane_control::PaneControlState;
use crate::persistence::UserFilesState;
use crate::ribbon_filter::RibbonFilterState;
use crate::AppState;

/// The GET.CONTROLVALUE snapshot map: TRIMMED + UPPERCASED control name ->
/// current value. Keys match the evaluator's case-insensitive lookup.
pub type ControlValuesMap = HashMap<String, engine::ControlValue>;

/// Build the GET.CONTROLVALUE snapshot, acquiring each store lock briefly in
/// the canonical order (pane controls -> ribbon filters -> on-grid controls ->
/// grids) and dropping it before the next. Call this at the TOP of a command,
/// BEFORE any long-lived grid locks are taken, and share the returned Arc
/// across every EvalContext the command constructs.
pub fn build_control_values(
    state: &AppState,
    pane_state: &PaneControlState,
    filter_state: &RibbonFilterState,
) -> Arc<ControlValuesMap> {
    // 1. Pane controls: lock, extract, DROP.
    let pane_entries = {
        let controls = pane_state.controls.lock().unwrap();
        pane_control_named_values(&controls)
    };
    // 2. Ribbon filters: lock, extract, DROP.
    let filter_entries = {
        let filters = filter_state.filters.lock().unwrap();
        ribbon_filter_named_values(&filters)
    };
    // 3. On-grid controls: CLONE the storage under its own lock, DROP.
    let storage = {
        let controls = state.controls.lock().unwrap();
        controls.clone()
    };
    // 4. Only now touch grids (brief lock, dropped at block end).
    let on_grid_entries = {
        let grids = state.grids.lock().unwrap();
        on_grid_named_values(&storage, &grids)
    };
    Arc::new(collect_control_values(
        &pane_entries,
        &filter_entries,
        &on_grid_entries,
    ))
}

/// Variant for paths that ALREADY hold the grids lock (e.g. inside an
/// update_cell-style command body, or the targeted control recalc command
/// built in the next stage): pass the held guard/slice instead of re-locking.
///
/// Safe despite running "after" grids in the canonical order: the store locks
/// are still taken briefly one at a time, and no code path holds a store lock
/// while acquiring grids (see module header), so this cannot deadlock.
#[allow(dead_code)] // reserved for paths that must build under held grid locks
pub fn build_control_values_with_grids(
    state: &AppState,
    pane_state: &PaneControlState,
    filter_state: &RibbonFilterState,
    grids: &[engine::grid::Grid],
) -> Arc<ControlValuesMap> {
    let pane_entries = {
        let controls = pane_state.controls.lock().unwrap();
        pane_control_named_values(&controls)
    };
    let filter_entries = {
        let filters = filter_state.filters.lock().unwrap();
        ribbon_filter_named_values(&filters)
    };
    let storage = {
        let controls = state.controls.lock().unwrap();
        controls.clone()
    };
    let on_grid_entries = on_grid_named_values(&storage, grids);
    Arc::new(collect_control_values(
        &pane_entries,
        &filter_entries,
        &on_grid_entries,
    ))
}

/// Convenience for internal recalc helpers that receive the control states as
/// an OPTIONAL pair (None = path where the states are unreachable; formulas
/// there evaluate GET.CONTROLVALUE to #N/A, v1). Builds with the canonical
/// lock order; call BEFORE taking any long-lived grid locks.
pub fn build_control_values_from_states(
    state: &AppState,
    control_states: Option<(&PaneControlState, &RibbonFilterState)>,
) -> Option<Arc<ControlValuesMap>> {
    control_states.map(|(pane_state, filter_state)| {
        build_control_values(state, pane_state, filter_state)
    })
}

/// The static, non-empty "name" property of an on-grid control, if any — the
/// same rule `on_grid_named_values` applies when building the snapshot map.
/// Shared by the update_cell / update_cells_batch anchor probes: editing the
/// ANCHOR cell of a control named this way changes the value GET.CONTROLVALUE
/// returns, so those commands trigger `recalc_control_dependents_core` for
/// the name after their own cascade.
pub(crate) fn static_control_name(meta: &ControlMetadata) -> Option<String> {
    let prop = meta.properties.get("name")?;
    if prop.value_type != "static" {
        return None;
    }
    let name = prop.value.trim();
    if name.is_empty() {
        None
    } else {
        Some(name.to_string())
    }
}

// ============================================================================
// Targeted recalc of GET.CONTROLVALUE dependents
// ============================================================================

/// Result of statically scanning one formula AST for GET.CONTROLVALUE calls.
pub(crate) struct ControlNameScan {
    /// TRIMMED + UPPERCASED literal control names passed as the first arg.
    pub names: HashSet<String>,
    /// True when at least one call has a non-literal (or missing) first arg —
    /// the referenced control cannot be known statically, so the cell must be
    /// treated as depending on EVERY control.
    pub dynamic: bool,
}

/// Walk a formula AST and collect every control name referenced by a
/// GET.CONTROLVALUE call (all alias spellings map to the same
/// `BuiltinFunction::GetControlValue` at parse time). Nested calls are found
/// anywhere in the expression tree — e.g. `IF(A1, GET.CONTROLVALUE("x"), 0)`.
pub(crate) fn collect_control_names(expr: &Expression) -> ControlNameScan {
    let mut scan = ControlNameScan {
        names: HashSet::new(),
        dynamic: false,
    };
    walk_control_names(expr, &mut scan);
    scan
}

fn walk_control_names(expr: &Expression, scan: &mut ControlNameScan) {
    match expr {
        Expression::FunctionCall { func, args, .. } => {
            if *func == BuiltinFunction::GetControlValue {
                match args.first() {
                    Some(Expression::Literal(Value::String(name))) => {
                        scan.names.insert(name.trim().to_uppercase());
                    }
                    // Non-string-literal (or missing) first arg: dynamic.
                    _ => scan.dynamic = true,
                }
            }
            // Walk ALL args regardless: nested GET.CONTROLVALUE calls, and a
            // dynamic first arg may itself contain literal calls.
            for arg in args {
                walk_control_names(arg, scan);
            }
        }
        Expression::BinaryOp { left, right, .. } => {
            walk_control_names(left, scan);
            walk_control_names(right, scan);
        }
        Expression::UnaryOp { operand, .. } => walk_control_names(operand, scan),
        Expression::Range { start, end, .. } => {
            walk_control_names(start, scan);
            walk_control_names(end, scan);
        }
        Expression::IndexAccess { target, index } => {
            walk_control_names(target, scan);
            walk_control_names(index, scan);
        }
        Expression::ImplicitIntersection { operand } => walk_control_names(operand, scan),
        Expression::Sheet3DRef { reference, .. } => walk_control_names(reference, scan),
        Expression::SpillRef { cell, .. } => walk_control_names(cell, scan),
        Expression::ListLiteral { elements } => {
            for e in elements {
                walk_control_names(e, scan);
            }
        }
        Expression::DictLiteral { entries } => {
            for (k, v) in entries {
                walk_control_names(k, scan);
                walk_control_names(v, scan);
            }
        }
        Expression::Literal(_)
        | Expression::CellRef { .. }
        | Expression::ColumnRef { .. }
        | Expression::RowRef { .. }
        | Expression::NamedRef { .. }
        | Expression::TableRef { .. } => {}
    }
}

/// Cheap string prefilter run before the AST walk. `Cell::formula_string()`
/// renders the CANONICAL function name (alias spellings GET.CONTROL.VALUE /
/// GETCONTROLVALUE normalize to GET.CONTROLVALUE at parse time), so matching
/// the substring "CONTROLVALUE" catches every spelling.
fn formula_mentions_control_value(formula: &str) -> bool {
    formula.to_uppercase().contains("CONTROLVALUE")
}

/// Topological evaluation order for the dependent closure of MULTIPLE seed
/// cells at once — a multi-root generalization of `get_recalculation_order`
/// (lib.rs), needed because several GET.CONTROLVALUE cells can change from one
/// control mutation and one seed may itself depend on another seed's output.
/// Seeds come first (a seed fed by another member is ordered after its
/// precedents); members on dependency cycles are appended at the end so they
/// still get recalculated (same policy as `get_recalculation_order`).
fn multi_root_recalc_order(
    seeds: &[(u32, u32)],
    dependents: &crate::DependencyMap,
) -> Vec<(u32, u32)> {
    // Shared Kahn implementation (lib.rs); include_seeds=true keeps this
    // pass's contract: seeds are members of the ordering, a seed fed by
    // another member is ordered after its precedents, cycles appended sorted.
    crate::recalc_order_from_seeds(seeds, dependents, true)
}

/// Sheet-level recalc plan for the other-sheet pass: starting from the sheets
/// that contain GET.CONTROLVALUE formulas (`seed_sheets`), follow the
/// sheet-level cross-sheet dependency edges (`edges`: source sheet -> sheets
/// with a formula referencing it) to a closure, then order it so a sheet is
/// recalculated AFTER the sheets it depends on (Kahn over the induced
/// subgraph). The ACTIVE sheet is excluded and never expanded through — its
/// cells are re-evaluated spill-aware by the active-sheet pass instead (a
/// chain other -> active -> other is completed by the forward cross-sheet
/// walk that pass runs). Sheets on a sheet-level dependency cycle are
/// appended at the end so they are still recalculated once (order imperfect —
/// documented residual gap).
fn ordered_sheet_closure(
    seed_sheets: &[usize],
    edges: &HashMap<usize, HashSet<usize>>,
    active_sheet: usize,
) -> Vec<usize> {
    // Closure over dependent edges, never entering the active sheet.
    let mut members: HashSet<usize> = HashSet::new();
    let mut queue: VecDeque<usize> = VecDeque::new();
    for &s in seed_sheets {
        if s != active_sheet && members.insert(s) {
            queue.push_back(s);
        }
    }
    while let Some(s) = queue.pop_front() {
        if let Some(deps) = edges.get(&s) {
            for &d in deps {
                if d != active_sheet && members.insert(d) {
                    queue.push_back(d);
                }
            }
        }
    }

    // In-degree over the induced subgraph (member -> member edges only).
    let mut in_degree: HashMap<usize, usize> = members.iter().map(|&s| (s, 0)).collect();
    for s in &members {
        if let Some(deps) = edges.get(s) {
            for d in deps {
                if d == s {
                    continue;
                }
                if let Some(deg) = in_degree.get_mut(d) {
                    *deg += 1;
                }
            }
        }
    }

    // Kahn's algorithm; deterministic (sorted) start and expansion order.
    let mut start: Vec<usize> = members
        .iter()
        .copied()
        .filter(|s| in_degree[s] == 0)
        .collect();
    start.sort_unstable();
    let mut ready: VecDeque<usize> = start.into();
    let mut result: Vec<usize> = Vec::with_capacity(members.len());
    while let Some(s) = ready.pop_front() {
        result.push(s);
        if let Some(deps) = edges.get(&s) {
            let mut next: Vec<usize> = Vec::new();
            for d in deps {
                if let Some(deg) = in_degree.get_mut(d) {
                    if *deg > 0 {
                        *deg -= 1;
                        if *deg == 0 {
                            next.push(*d);
                        }
                    }
                }
            }
            next.sort_unstable();
            for d in next {
                ready.push_back(d);
            }
        }
    }

    // Sheet-level cycles: append so they still get recalculated once.
    if result.len() < members.len() {
        let done: HashSet<usize> = result.iter().copied().collect();
        let mut leftovers: Vec<usize> =
            members.iter().copied().filter(|s| !done.contains(s)).collect();
        leftovers.sort_unstable();
        result.extend(leftovers);
    }

    result
}

/// Targeted recalc after a control/filter value change — thin Tauri wrapper.
/// The full contract lives on `recalc_control_dependents_core`, which is
/// shared with the named-anchor hooks in update_cell / update_cells_batch.
#[tauri::command]
pub fn recalc_control_dependents(
    state: State<AppState>,
    user_files_state: State<UserFilesState>,
    pivot_state: State<'_, crate::pivot::PivotState>,
    pane_control_state: State<'_, PaneControlState>,
    ribbon_filter_state: State<'_, RibbonFilterState>,
    changed_names: Option<Vec<String>>,
) -> Result<Vec<CellData>, String> {
    recalc_control_dependents_core(
        &state,
        &user_files_state,
        &pivot_state,
        &pane_control_state,
        &ribbon_filter_state,
        changed_names,
    )
}

/// Targeted recalc after a control/filter value change: re-evaluates ONLY the
/// formula cells that read GET.CONTROLVALUE — those matching `changed_names`
/// (case-insensitive) plus every dynamic-name call site, or ALL of them when
/// `changed_names` is `None` — together with their dependents, across sheets:
///
/// 1. **Other-sheet pass.** Every non-active sheet containing a
///    GET.CONTROLVALUE formula is recalculated via `recalculate_sheet_values`,
///    together with every sheet that (transitively) depends on one of them
///    through cross-sheet references, in sheet-level dependency order
///    (`ordered_sheet_closure`). LIMITATIONS (v1): no spill maintenance off
///    the active sheet — array results collapse to the origin cell (matches
///    .calp refresh); sheets on a sheet-level dependency cycle recalc once in
///    appended (imperfect) order; no `CellData` is reported for these sheets
///    (the frontend refetches on sheet switch).
/// 2. **Active-sheet pass.** Seeds = matching GET.CONTROLVALUE cells PLUS
///    every active-sheet cell that references a sheet recalculated in pass 1
///    (reverse cross-sheet propagation; deliberately over-broad — any
///    dependence on such a sheet qualifies, not just references to
///    control-affected cells). Seeds and their dependents (cell, column and
///    row dependents; the scenario_show precedent) re-evaluate through the
///    shared `reevaluate_formula_cell` cascade body, so multi-select filter
///    values SPILL and collapse exactly like `update_cell` dependents.
///    Finally the shared `cascade_cross_sheet_dependents` walk propagates the
///    changed values to formulas on other sheets (forward cross-sheet
///    propagation), exactly like `update_cell`'s cascade.
///
/// Callable from other commands WITHOUT Tauri State re-entry: takes plain
/// state refs and acquires every lock itself — callers must hold NO grid or
/// store locks when invoking it. It never re-enters update_cell or the
/// named-anchor probes, so anchor-triggered invocations cannot recurse.
///
/// Returns the updated active-sheet cells (plus cleared/created spill cells,
/// plus forward-propagated cross-sheet cells tagged `sheet_index: Some(..)`)
/// for the frontend to apply like `update_cell` results.
pub(crate) fn recalc_control_dependents_core(
    state: &AppState,
    user_files_state: &UserFilesState,
    pivot_state: &crate::pivot::PivotState,
    pane_control_state: &PaneControlState,
    ribbon_filter_state: &RibbonFilterState,
    changed_names: Option<Vec<String>>,
) -> Result<Vec<CellData>, String> {
    // Respect manual calculation mode — this is the dependent cascade of a
    // control mutation, and update_cell gates its cascade the same way.
    {
        let calc_mode = state.calculation_mode.lock().unwrap();
        if *calc_mode != "automatic" {
            return Ok(Vec::new());
        }
    }

    // GET.CONTROLVALUE snapshot: built ONCE, BEFORE any grid locks (canonical
    // lock order: control stores first, grids last).
    let control_values =
        build_control_values(state, pane_control_state, ribbon_filter_state);

    let changed_upper: Option<HashSet<String>> = changed_names
        .map(|names| names.iter().map(|n| n.trim().to_uppercase()).collect());

    // Pre-pass: sync the active-sheet mirror into grids (BUG-0016 discipline —
    // the other-sheet pass below evaluates THROUGH grids, and other sheets may
    // reference active-sheet cells) and detect the non-active sheets that
    // contain GET.CONTROLVALUE formulas. Name-agnostic prefilter, like the
    // active-sheet scan's string prefilter (conservative).
    let (control_sheets, prepass_active_sheet) = {
        let grid = state.grid.lock().unwrap();
        let mut grids = state.grids.lock().unwrap();
        let active_sheet = *state.active_sheet.lock().unwrap();
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
                            .map_or(false, |f| formula_mentions_control_value(&f))
                    })
            })
            .map(|(idx, _)| idx)
            .collect();
        (list, active_sheet)
    };

    // Sheet-level cross-sheet dependency edges (source sheet -> sheets with a
    // formula referencing it) and, per source sheet, the ACTIVE-sheet cells
    // referencing it (the reverse-propagation seeds for the active-sheet
    // pass). Brief locks, canonical order (sheet_names before the map, no
    // grid lock held).
    let (sheet_edges, active_deps_by_source) = {
        let sheet_names = state.sheet_names.lock().unwrap();
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

    // Pass 1: other sheets, whole-sheet recalc in sheet-level dependency
    // order (a sheet recalculates after the sheets it depends on).
    // LIMITATION (v1): no spill maintenance off the active sheet —
    // recalculate_sheet_values collapses array results to the origin cell
    // (matches .calp refresh) — and no CellData reporting for these sheets.
    let other_recalc =
        ordered_sheet_closure(&control_sheets, &sheet_edges, prepass_active_sheet);
    for &idx in &other_recalc {
        crate::calculation::recalculate_sheet_values(
            state,
            user_files_state,
            pivot_state,
            idx,
            Some((pane_control_state, ribbon_filter_state)),
        );
    }

    // Reverse-propagation seeds: active-sheet cells referencing any sheet
    // recalculated in pass 1. Over-broad by design (see fn doc); dedup +
    // sorted for determinism.
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

    // Pass 2: active sheet, spill-aware, under the standard update_cell-style
    // lock set (all pass-1 locks have dropped; recalculate_sheet_values takes
    // and releases its own).
    let updated_cells = {
        let user_files = user_files_state.files.lock().unwrap();
        let sheet_names = state.sheet_names.lock().unwrap();
        let mut grid = state.grid.lock().unwrap();
        let mut grids = state.grids.lock().unwrap();
        let active_sheet = *state.active_sheet.lock().unwrap();

        // The active-sheet mirror (state.grid) is the source of truth; grids[i]
        // can lag behind it (BUG-0016, see calculate_now). Sync before scanning
        // and evaluating.
        if active_sheet < grids.len() {
            grids[active_sheet] = grid.clone();
        }

        let styles = state.style_registry.lock().unwrap();
        let dependents_map = state.dependents.lock().unwrap();
        let column_dependents_map = state.column_dependents.lock().unwrap();
        let row_dependents_map = state.row_dependents.lock().unwrap();
        // Read-only here; position in the sequence mirrors update_cell's
        // canonical lock order (after the row/column dependency maps).
        let cross_sheet_dependents_map = state.cross_sheet_dependents.lock().unwrap();
        let merged_regions = state.merged_regions.lock().unwrap();
        let locale = state.locale.lock().unwrap();
        let cascade_tables = state.tables.lock().unwrap();
        let cascade_table_names = state.table_names.lock().unwrap();
        let cascade_named_ranges = state.named_ranges.lock().unwrap();

        // Scan the active sheet: string prefilter, then AST walk. Sorted for a
        // deterministic seed order (HashMap iteration is not).
        let mut scan_hits: Vec<((u32, u32), ControlNameScan)> = grid
            .cells
            .iter()
            .filter_map(|(&(row, col), cell)| {
                let formula = cell.formula_string()?;
                if !formula_mentions_control_value(&formula) {
                    return None;
                }
                // formula_string() implies a present AST.
                let ast = cell.get_cached_ast()?;
                Some(((row, col), collect_control_names(ast)))
            })
            .collect();
        scan_hits.sort_by_key(|(coord, _)| *coord);

        let mut seeds: Vec<(u32, u32)> = scan_hits
            .iter()
            .filter(|(_, scan)| match &changed_upper {
                // No name hint (e.g. undo/redo): every GET.CONTROLVALUE cell
                // is a seed.
                None => true,
                Some(set) => {
                    scan.dynamic || scan.names.iter().any(|n| set.contains(n))
                }
            })
            .map(|(coord, _)| *coord)
            .collect();

        // Reverse cross-sheet propagation: append the pass-1-fed cells
        // (bypass the name filter — they are staleness-driven, not
        // name-driven).
        {
            let seed_set: HashSet<(u32, u32)> = seeds.iter().copied().collect();
            for &coord in &extra_seeds {
                if !seed_set.contains(&coord) {
                    seeds.push(coord);
                }
            }
        }

        // Seeds first, then dependents in topological order.
        let mut affected = multi_root_recalc_order(&seeds, &dependents_map);
        // Column/row dependents of each seed, appended after the topological
        // order (mirrors update_cell / scenario_show, scenario_manager.rs).
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

        let merge_lookup: HashMap<(u32, u32), &MergedRegion> = merged_regions
            .iter()
            .map(|r| ((r.start_row, r.start_col), r))
            .collect();

        let mut updated_cells: Vec<CellData> = Vec::new();
        let mut cache_hits = 0u32;
        let mut cache_misses = 0u32;
        // PERF-20: same wide-cascade formula trim as update_cell's cascade.
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
                        // No UDF prefetch on this path (v1): UDF-bearing
                        // dependents PRESERVE their stored value —
                        // reevaluate_formula_cell threads the cell's own
                        // position, so preserved_udf_value engages (#NAME?
                        // only when there is nothing to keep).
                        None,
                        // No CUBE prefetch: cube-bearing dependents preserve
                        // their last value the same way (preserve-on-no-
                        // prefetch invariant via preserved_cube_value).
                        None,
                        Some(&control_values),
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

        // Forward cross-sheet propagation: the value changes made above reach
        // formulas on other sheets through the exact walk update_cell's
        // cascade uses (shared fn; scalar-only off the active sheet — no
        // spill maintenance there).
        let initial_changed: Vec<(u32, u32)> = {
            let mut seen: HashSet<(u32, u32)> = HashSet::new();
            updated_cells
                .iter()
                .filter(|c| c.sheet_index.is_none())
                .filter_map(|c| seen.insert((c.row, c.col)).then_some((c.row, c.col)))
                .collect()
        };
        crate::commands::data::cascade_cross_sheet_dependents(
            &mut grid,
            &mut grids,
            &sheet_names,
            active_sheet,
            &cross_sheet_dependents_map,
            &dependents_map,
            &user_files,
            &control_values,
            &styles,
            &locale,
            &merge_lookup,
            &initial_changed,
            &affected,
            &mut updated_cells,
            include_cascade_formulas,
        );

        updated_cells
    };

    Ok(updated_cells)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(formula: &str) -> Expression {
        parser::parse(formula).expect("formula should parse")
    }

    fn make_formula_cell(formula: &str) -> engine::Cell {
        engine::Cell {
            ast: Some(Box::new(parse(formula))),
            value: engine::CellValue::Empty,
            style_index: 0,
            rich_text: None,
        }
    }

    // ---------------- collect_control_names ----------------

    #[test]
    fn collects_literal_name_uppercased_and_trimmed() {
        let scan = collect_control_names(&parse("GET.CONTROLVALUE(\" Region \")"));
        assert!(!scan.dynamic);
        assert_eq!(scan.names.len(), 1);
        assert!(scan.names.contains("REGION"));
    }

    #[test]
    fn collects_names_nested_inside_other_functions() {
        let scan = collect_control_names(&parse(
            "IF(A1>0, GET.CONTROLVALUE(\"x\"), SUM(B1:B2)+GET.CONTROLVALUE(\"y\"))",
        ));
        assert!(!scan.dynamic);
        assert_eq!(scan.names.len(), 2);
        assert!(scan.names.contains("X"));
        assert!(scan.names.contains("Y"));
    }

    #[test]
    fn non_literal_first_arg_is_dynamic() {
        let scan = collect_control_names(&parse("GET.CONTROLVALUE(A1)"));
        assert!(scan.dynamic);
        assert!(scan.names.is_empty());
    }

    #[test]
    fn mixed_dynamic_and_literal_calls_collect_both() {
        let scan =
            collect_control_names(&parse("GET.CONTROLVALUE(A1) + GET.CONTROLVALUE(\"z\")"));
        assert!(scan.dynamic);
        assert_eq!(scan.names.len(), 1);
        assert!(scan.names.contains("Z"));
    }

    #[test]
    fn default_arg_second_param_does_not_affect_scan() {
        let scan = collect_control_names(&parse("GET.CONTROLVALUE(\"n\", 0)"));
        assert!(!scan.dynamic);
        assert!(scan.names.contains("N"));
    }

    #[test]
    fn alias_spellings_map_to_same_call() {
        for formula in [
            "GET.CONTROL.VALUE(\"a\")",
            "GETCONTROLVALUE(\"a\")",
            "get.controlvalue(\"a\")",
        ] {
            let scan = collect_control_names(&parse(formula));
            assert!(!scan.dynamic, "{formula}");
            assert!(scan.names.contains("A"), "{formula}");
        }
    }

    #[test]
    fn plain_formula_has_no_names() {
        let scan = collect_control_names(&parse("SUM(A1:A10)*2"));
        assert!(!scan.dynamic);
        assert!(scan.names.is_empty());
    }

    // ---------------- string prefilter ----------------

    #[test]
    fn prefilter_matches_canonical_render_of_all_alias_spellings() {
        // Cells store the AST; formula_string() renders the canonical name,
        // so the substring prefilter catches every input spelling.
        for input in [
            "GET.CONTROLVALUE(\"s\")",
            "GET.CONTROL.VALUE(\"s\")",
            "GETCONTROLVALUE(\"s\")",
            "IF(A1, GET.CONTROL.VALUE(\"s\"), 0)",
        ] {
            let cell = make_formula_cell(input);
            let rendered = cell.formula_string().expect("formula cell renders");
            assert!(
                formula_mentions_control_value(&rendered),
                "prefilter missed rendered form of {input}: {rendered}"
            );
        }
    }

    #[test]
    fn prefilter_skips_unrelated_formulas() {
        let cell = make_formula_cell("SUM(A1:A10)");
        let rendered = cell.formula_string().unwrap();
        assert!(!formula_mentions_control_value(&rendered));
    }

    // ---------------- multi_root_recalc_order ----------------

    #[test]
    fn multi_root_order_puts_seed_precedents_first() {
        // A(0,0) -> B(1,0) -> C(2,0); both A and B are seeds (B listed first
        // in scan order). B must still evaluate AFTER A.
        let mut dependents = crate::DependencyMap::default();
        dependents.insert((0, 0), crate::CoordSet::from_iter([(1, 0)]));
        dependents.insert((1, 0), crate::CoordSet::from_iter([(2, 0)]));

        let order = multi_root_recalc_order(&[(1, 0), (0, 0)], &dependents);
        let pos = |c: (u32, u32)| order.iter().position(|&x| x == c).unwrap();
        assert_eq!(order.len(), 3);
        assert!(pos((0, 0)) < pos((1, 0)));
        assert!(pos((1, 0)) < pos((2, 0)));
    }

    #[test]
    fn multi_root_order_appends_cycles() {
        // A -> B -> A cycle, seeded at A: both must appear exactly once.
        let mut dependents = crate::DependencyMap::default();
        dependents.insert((0, 0), crate::CoordSet::from_iter([(0, 1)]));
        dependents.insert((0, 1), crate::CoordSet::from_iter([(0, 0)]));

        let order = multi_root_recalc_order(&[(0, 0)], &dependents);
        assert_eq!(order.len(), 2);
        assert!(order.contains(&(0, 0)));
        assert!(order.contains(&(0, 1)));
    }

    // ---------------- static_control_name (anchor probe rule) ----------------

    fn control_meta(props: &[(&str, &str, &str)]) -> ControlMetadata {
        use crate::controls::ControlPropertyValue;
        let mut properties = HashMap::new();
        for (key, value_type, value) in props {
            properties.insert(
                key.to_string(),
                ControlPropertyValue {
                    value_type: value_type.to_string(),
                    value: value.to_string(),
                },
            );
        }
        ControlMetadata {
            control_type: "checkbox".to_string(),
            properties,
        }
    }

    #[test]
    fn static_control_name_trims_and_returns_static_names() {
        let meta = control_meta(&[("name", "static", "  Threshold  ")]);
        assert_eq!(static_control_name(&meta), Some("Threshold".to_string()));
    }

    #[test]
    fn static_control_name_rejects_formula_empty_and_missing() {
        // Formula-typed name: excluded (matches on_grid_named_values).
        let meta = control_meta(&[("name", "formula", "=A1")]);
        assert_eq!(static_control_name(&meta), None);
        // Whitespace-only name: excluded.
        let meta = control_meta(&[("name", "static", "   ")]);
        assert_eq!(static_control_name(&meta), None);
        // No name property at all: excluded.
        let meta = control_meta(&[("text", "static", "Click")]);
        assert_eq!(static_control_name(&meta), None);
    }

    // ---------------- ordered_sheet_closure ----------------

    fn sheet_edges(pairs: &[(usize, usize)]) -> HashMap<usize, HashSet<usize>> {
        let mut edges: HashMap<usize, HashSet<usize>> = HashMap::new();
        for &(src, dep) in pairs {
            edges.entry(src).or_default().insert(dep);
        }
        edges
    }

    #[test]
    fn sheet_closure_orders_sources_before_dependents() {
        // Sheet 1 feeds 2 feeds 3 (sheet 0 active). Seeding {1} must recalc
        // all three, source-first.
        let edges = sheet_edges(&[(1, 2), (2, 3)]);
        let order = ordered_sheet_closure(&[1], &edges, 0);
        assert_eq!(order, vec![1, 2, 3]);
    }

    #[test]
    fn sheet_closure_orders_multiple_seeds_topologically() {
        // 2 depends on 1; seeding {2, 1} (scan order) must still put 1 first.
        let edges = sheet_edges(&[(1, 2)]);
        let order = ordered_sheet_closure(&[2, 1], &edges, 0);
        assert_eq!(order, vec![1, 2]);
    }

    #[test]
    fn sheet_closure_excludes_active_and_never_expands_through_it() {
        // 1 feeds active(0), active feeds 2: the closure from {1} is [1] only —
        // active-sheet cells recalc spill-aware in pass 2, and the forward
        // walk completes the active -> 2 leg.
        let edges = sheet_edges(&[(1, 0), (0, 2)]);
        let order = ordered_sheet_closure(&[1], &edges, 0);
        assert_eq!(order, vec![1]);
        // Active sheet as a seed is dropped too.
        let order = ordered_sheet_closure(&[0, 1], &edges, 0);
        assert_eq!(order, vec![1]);
    }

    #[test]
    fn sheet_closure_appends_cycles_once() {
        // 1 <-> 2 sheet-level cycle seeded at 1: both recalc exactly once.
        let edges = sheet_edges(&[(1, 2), (2, 1)]);
        let order = ordered_sheet_closure(&[1], &edges, 0);
        assert_eq!(order.len(), 2);
        assert!(order.contains(&1));
        assert!(order.contains(&2));
    }
}
