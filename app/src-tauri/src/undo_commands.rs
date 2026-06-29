//! FILENAME: app/src-tauri/src/undo_commands.rs
// PURPOSE: Tauri commands for undo/redo operations.

use crate::api_types::{CellData, MergedRegion};
use crate::persistence::FileState;
use crate::pivot::operations::*;
use crate::pivot::types::PivotState;
use crate::ribbon_filter::types::{RibbonFilter, RibbonFilterState};
use crate::slicer::types::{Slicer, SlicerState};
use crate::{
    extract_all_references, format_cell_value, update_column_dependencies,
    update_cross_sheet_dependencies, update_dependencies, update_row_dependencies, AppState,
};
use engine::{CellChange, GridSnapshot, Transaction, UndoMergeRegion};
use once_cell::sync::Lazy;
use pivot_engine::PivotDefinition;
use serde::Serialize;
use std::collections::HashMap;
use tauri::State;

/// Result of an undo/redo operation
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UndoResult {
    /// Whether the operation succeeded
    pub success: bool,
    /// Description of what was undone/redone
    pub description: Option<String>,
    /// Cells that were modified
    pub updated_cells: Vec<CellData>,
    /// Whether more undo operations are available
    pub can_undo: bool,
    /// Whether more redo operations are available
    pub can_redo: bool,
    /// Whether merged regions changed (frontend should refresh merge info)
    pub merge_changed: bool,
    /// Whether a structural restore occurred (frontend should do a full refresh)
    pub structural_restore: bool,
    /// Whether pivot table state was restored (frontend should refresh pivot view)
    pub pivot_changed: bool,
    /// Whether slicer state was restored (frontend should refresh slicers)
    pub slicer_changed: bool,
    /// Whether ribbon filter state was restored (frontend should refresh ribbon filters)
    pub ribbon_filter_changed: bool,
    /// Whether object state was restored (charts, sparklines, tables,
    /// autofilters, validation, named ranges, freeze panes) — frontend
    /// should refresh the corresponding stores.
    pub objects_changed: bool,
}

/// Get current undo/redo state
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UndoState {
    pub can_undo: bool,
    pub can_redo: bool,
    pub undo_description: Option<String>,
    pub redo_description: Option<String>,
    /// Number of transactions available to undo (used by test oracles).
    pub undo_depth: usize,
    /// Number of transactions available to redo (used by test oracles).
    pub redo_depth: usize,
}

/// Convert engine::UndoMergeRegion to api_types::MergedRegion
fn to_api_region(r: &UndoMergeRegion) -> MergedRegion {
    MergedRegion {
        start_row: r.start_row,
        start_col: r.start_col,
        end_row: r.end_row,
        end_col: r.end_col,
    }
}

/// Convert api_types::MergedRegion to engine::UndoMergeRegion
fn to_undo_region(r: &MergedRegion) -> UndoMergeRegion {
    UndoMergeRegion {
        start_row: r.start_row,
        start_col: r.start_col,
        end_row: r.end_row,
        end_col: r.end_col,
    }
}

/// Rebuild all formula dependency maps from scratch by scanning all cells of
/// the ACTIVE sheet (the state.grid mirror).
/// Called after a structural restore (undo of insert/delete rows/cols) and
/// after every sheet switch: the dependency maps are keyed by (row, col)
/// without a sheet dimension, so they only ever describe one sheet — leaving
/// them stale across switches made edits on the new sheet recalc against the
/// previous sheet's edges (BUG-0016).
pub(crate) fn rebuild_all_dependencies(state: &AppState) {
    let grid = state.grid.lock().unwrap();
    let active_sheet = *state.active_sheet.lock().unwrap();
    rebuild_all_dependencies_from_grid(&grid, active_sheet, state);
}

/// Same as rebuild_all_dependencies but for callers that already hold the
/// grid lock (passing it avoids a deadlock). Locks only the dependency maps.
pub(crate) fn rebuild_all_dependencies_from_grid(
    grid: &engine::Grid,
    active_sheet: usize,
    state: &AppState,
) {
    let mut dependents_map = state.dependents.lock().unwrap();
    let mut dependencies_map = state.dependencies.lock().unwrap();
    let mut column_dependents_map = state.column_dependents.lock().unwrap();
    let mut column_dependencies_map = state.column_dependencies.lock().unwrap();
    let mut row_dependents_map = state.row_dependents.lock().unwrap();
    let mut row_dependencies_map = state.row_dependencies.lock().unwrap();
    let mut cross_sheet_dependents = state.cross_sheet_dependents.lock().unwrap();
    let mut cross_sheet_dependencies = state.cross_sheet_dependencies.lock().unwrap();

    // Clear the single-sheet maps (they describe only the active sheet).
    dependents_map.clear();
    dependencies_map.clear();
    column_dependents_map.clear();
    column_dependencies_map.clear();
    row_dependents_map.clear();
    row_dependencies_map.clear();

    // The cross-sheet maps are GLOBAL across sheets — only rebuild the
    // ACTIVE sheet's edges. Wholesale clearing here would orphan every other
    // sheet's cross-references (e.g. Sheet2!B3 = Sheet1!C9 stops updating
    // after a switch back to Sheet1).
    let active_keys: Vec<(usize, u32, u32)> = cross_sheet_dependencies
        .keys()
        .filter(|k| k.0 == active_sheet)
        .copied()
        .collect();
    for key in active_keys {
        if let Some(refs) = cross_sheet_dependencies.remove(&key) {
            for r in refs {
                let now_empty = if let Some(deps) = cross_sheet_dependents.get_mut(&r) {
                    deps.remove(&key);
                    deps.is_empty()
                } else {
                    false
                };
                if now_empty {
                    cross_sheet_dependents.remove(&r);
                }
            }
        }
    }

    // Scan all cells and rebuild
    for (&(row, col), cell) in &grid.cells {
        if let Some(ast) = &cell.ast {
            let refs = extract_all_references(ast, &grid);

            if !refs.cells.is_empty() {
                update_dependencies(
                    (row, col),
                    refs.cells,
                    &mut dependencies_map,
                    &mut dependents_map,
                );
            }
            if !refs.columns.is_empty() {
                update_column_dependencies(
                    (row, col),
                    refs.columns,
                    &mut column_dependencies_map,
                    &mut column_dependents_map,
                );
            }
            if !refs.rows.is_empty() {
                update_row_dependencies(
                    (row, col),
                    refs.rows,
                    &mut row_dependencies_map,
                    &mut row_dependents_map,
                );
            }
            if !refs.cross_sheet_cells.is_empty() {
                update_cross_sheet_dependencies(
                    (active_sheet, row, col),
                    refs.cross_sheet_cells,
                    &mut cross_sheet_dependencies,
                    &mut cross_sheet_dependents,
                );
            }
        }
    }
}

/// Begin a transaction for batching multiple changes.
#[tauri::command]
pub fn begin_undo_transaction(state: State<AppState>, description: String) {
    let mut undo_stack = state.undo_stack.lock().unwrap();
    undo_stack.begin_transaction(description);
}

/// Commit the current transaction.
#[tauri::command]
pub fn commit_undo_transaction(state: State<AppState>) {
    let mut undo_stack = state.undo_stack.lock().unwrap();
    undo_stack.commit_transaction();
}

/// Cancel the current transaction.
#[tauri::command]
pub fn cancel_undo_transaction(state: State<AppState>) {
    let mut undo_stack = state.undo_stack.lock().unwrap();
    undo_stack.cancel_transaction();
}

/// Get current undo/redo state for UI.
#[tauri::command]
pub fn get_undo_state(state: State<AppState>) -> UndoState {
    let undo_stack = state.undo_stack.lock().unwrap();
    UndoState {
        can_undo: undo_stack.can_undo(),
        can_redo: undo_stack.can_redo(),
        undo_description: undo_stack.undo_description().map(String::from),
        redo_description: undo_stack.redo_description().map(String::from),
        undo_depth: undo_stack.undo_depth(),
        redo_depth: undo_stack.redo_depth(),
    }
}

/// Apply undo/redo changes and return the result.
/// Shared logic used by both `undo` and `redo` commands.
fn apply_changes(
    state: &AppState,
    file_state: &FileState,
    pivot_state: &PivotState,
    slicer_state: &SlicerState,
    ribbon_filter_state: &RibbonFilterState,
    transaction: Transaction,
    is_undo: bool,
) -> UndoResult {
    let undo_stack = state.undo_stack.lock().unwrap();
    let mut grid = state.grid.lock().unwrap();
    let mut grids = state.grids.lock().unwrap();
    let active_sheet = *state.active_sheet.lock().unwrap();
    let styles = state.style_registry.lock().unwrap();
    let mut column_widths = state.column_widths.lock().unwrap();
    let mut row_heights = state.row_heights.lock().unwrap();
    let mut merged_regions = state.merged_regions.lock().unwrap();
    let locale = state.locale.lock().unwrap();

    let description = transaction.description.clone();
    let mut updated_cells = Vec::new();
    let mut merge_changed = false;
    let mut structural_restore = false;
    let mut pivot_changed = false;
    let mut slicer_changed = false;
    let mut ribbon_filter_changed = false;
    let mut objects_changed = false;

    // Deferred custom restores that need to run AFTER grid locks are released
    // (pivot/slicer/ribbon_filter restores acquire their own locks and may need grid access)
    let mut deferred_restores: Vec<(String, Vec<u8>)> = Vec::new();

    // (row, col, pre, post) per restored cell, for subscriber override
    // maintenance: undoing an edit on a subscribed sheet must update/remove
    // the corresponding override, or the next refresh re-applies the stale
    // override and resurrects the undone edit.
    let mut override_edits: Vec<(u32, u32, Option<engine::Cell>, Option<engine::Cell>)> = Vec::new();

    // Build the inverse transaction
    let mut inverse_transaction = Transaction::new(description.clone());

    // Apply changes in REVERSE order for proper undo/redo semantics
    for change in transaction.changes.iter().rev() {
        match change {
            CellChange::SetCell { row, col, previous } => {
                // Save current state for inverse
                let current = grid.get_cell(*row, *col).cloned();
                override_edits.push((*row, *col, current.clone(), previous.clone()));
                inverse_transaction.add_change(CellChange::SetCell {
                    row: *row,
                    col: *col,
                    previous: current,
                });

                // Restore previous state
                match previous {
                    Some(cell) => {
                        grid.set_cell(*row, *col, cell.clone());
                        if active_sheet < grids.len() {
                            grids[active_sheet].set_cell(*row, *col, cell.clone());
                        }
                        let style = styles.get(cell.style_index);
                        let display = format_cell_value(&cell.value, style, &locale);
                        updated_cells.push(CellData {
                            row: *row,
                            col: *col,
                            display,
                            display_color: None,
                            formula: cell.formula_string().map(|f| format!("={}", f)),
                            style_index: cell.style_index,
                            row_span: 1,
                            col_span: 1,
                            sheet_index: None,
                            rich_text: None,
                            accounting_layout: None,
                        });
                    }
                    None => {
                        grid.clear_cell(*row, *col);
                        if active_sheet < grids.len() {
                            grids[active_sheet].clear_cell(*row, *col);
                        }
                        updated_cells.push(CellData {
                            row: *row,
                            col: *col,
                            display: String::new(),
                            display_color: None,
                            formula: None,
                            style_index: 0,
                            row_span: 1,
                            col_span: 1,
                            sheet_index: None,
                            rich_text: None,
                            accounting_layout: None,
                        });
                    }
                }
            }
            CellChange::SetColumnWidth { col, previous } => {
                let current = column_widths.get(col).copied();
                inverse_transaction.add_change(CellChange::SetColumnWidth {
                    col: *col,
                    previous: current,
                });
                match previous {
                    Some(width) => { column_widths.insert(*col, *width); }
                    None => { column_widths.remove(col); }
                }
            }
            CellChange::SetRowHeight { row, previous } => {
                let current = row_heights.get(row).copied();
                inverse_transaction.add_change(CellChange::SetRowHeight {
                    row: *row,
                    previous: current,
                });
                match previous {
                    Some(height) => { row_heights.insert(*row, *height); }
                    None => { row_heights.remove(row); }
                }
            }
            // The inverse keeps the SAME change variant; the apply direction
            // (is_undo) decides the operation. Storing the opposite variant
            // AND flipping on is_undo was a double negation: redo after undo
            // REMOVED the merge instead of restoring it (BUG-0009).
            CellChange::AddMergeRegion(region) => {
                inverse_transaction.add_change(CellChange::AddMergeRegion(region.clone()));
                if is_undo {
                    // Undo adding = remove it
                    merged_regions.remove(&to_api_region(region));
                } else {
                    // Redo adding = add it back
                    merged_regions.insert(to_api_region(region));
                }
                merge_changed = true;
            }
            CellChange::RemoveMergeRegion(region) => {
                inverse_transaction.add_change(CellChange::RemoveMergeRegion(region.clone()));
                if is_undo {
                    // Undo removing = add it back
                    merged_regions.insert(to_api_region(region));
                } else {
                    // Redo removing = remove it
                    merged_regions.remove(&to_api_region(region));
                }
                merge_changed = true;
            }
            CellChange::RestoreSnapshot(snapshot) => {
                // Save current state as inverse snapshot
                let current_snapshot = GridSnapshot {
                    cells: grid.cells.clone(),
                    row_heights: row_heights.clone(),
                    column_widths: column_widths.clone(),
                    merged_regions: merged_regions
                        .iter()
                        .map(|r| to_undo_region(r))
                        .collect(),
                    max_row: grid.max_row,
                    max_col: grid.max_col,
                };
                inverse_transaction.add_change(CellChange::RestoreSnapshot(current_snapshot));

                // Diff old vs new cells for override maintenance (union of
                // keys). Only value/formula matter — that is all the
                // override layer records.
                {
                    let keys: std::collections::HashSet<(u32, u32)> = grid.cells.keys()
                        .chain(snapshot.cells.keys())
                        .copied()
                        .collect();
                    for (row, col) in keys {
                        let pre = grid.cells.get(&(row, col));
                        let post = snapshot.cells.get(&(row, col));
                        let same = match (pre, post) {
                            (None, None) => true,
                            (Some(a), Some(b)) => {
                                a.value == b.value && a.formula_string() == b.formula_string()
                            }
                            _ => false,
                        };
                        if !same {
                            override_edits.push((row, col, pre.cloned(), post.cloned()));
                        }
                    }
                }

                // Restore from snapshot
                grid.cells = snapshot.cells.clone();
                grid.max_row = snapshot.max_row;
                grid.max_col = snapshot.max_col;
                *row_heights = snapshot.row_heights.clone();
                *column_widths = snapshot.column_widths.clone();
                merged_regions.clear();
                for r in &snapshot.merged_regions {
                    merged_regions.insert(to_api_region(r));
                }

                // Sync grids vector
                if active_sheet < grids.len() {
                    grids[active_sheet].cells = grid.cells.clone();
                    grids[active_sheet].max_row = grid.max_row;
                    grids[active_sheet].max_col = grid.max_col;
                }

                structural_restore = true;
                merge_changed = true;
            }
            CellChange::CustomRestore { kind, data } => {
                // Registry-driven dispatch. Deferred kinds (which acquire other
                // state locks) are queued to run AFTER the grid/style locks drop;
                // inline kinds run here. Unknown kinds log + no-op (parity with
                // the prior `_ =>` arm).
                match restore_spec(kind) {
                    Some(spec) if spec.defer => {
                        deferred_restores.push((kind.clone(), data.clone()));
                    }
                    Some(spec) => {
                        (spec.restore)(
                            state, pivot_state, slicer_state, ribbon_filter_state,
                            kind, data, &mut inverse_transaction,
                        );
                        set_restore_change_flag(
                            spec.change_class,
                            &mut pivot_changed, &mut slicer_changed,
                            &mut ribbon_filter_changed, &mut objects_changed,
                        );
                    }
                    None => eprintln!("[undo] Unknown custom restore kind: {}", kind),
                }
            }
        }
    }

    // Mark workbook as dirty
    if let Ok(mut modified) = file_state.is_modified.lock() { *modified = true; }

    // Drop all grid/style locks BEFORE processing deferred restores
    // (pivot/slicer/ribbon_filter restores need to acquire grid/state locks)
    drop(locale);
    drop(merged_regions);
    drop(row_heights);
    drop(column_widths);
    drop(styles);
    drop(grids);
    drop(grid);
    drop(undo_stack);

    // Keep subscriber overrides in step with the restored cells (no-op when
    // the active sheet isn't subscribed).
    crate::calp_commands::record_subscription_override_edits(state, active_sheet, &override_edits);

    // Process deferred pivot/slicer/ribbon_filter restores (now safe to acquire locks)
    for (kind, data) in deferred_restores {
        match restore_spec(&kind) {
            Some(spec) => {
                (spec.restore)(
                    state, pivot_state, slicer_state, ribbon_filter_state,
                    &kind, &data, &mut inverse_transaction,
                );
                set_restore_change_flag(
                    spec.change_class,
                    &mut pivot_changed, &mut slicer_changed,
                    &mut ribbon_filter_changed, &mut objects_changed,
                );
            }
            None => eprintln!("[undo] Unknown deferred custom restore kind: {}", kind),
        }
    }

    // Push inverse transaction to the appropriate stack (re-acquire undo_stack)
    {
        let mut undo_stack = state.undo_stack.lock().unwrap();
        if is_undo {
            undo_stack.push_redo(inverse_transaction);
        } else {
            undo_stack.push_undo_for_redo(inverse_transaction);
        }
    }

    let (can_undo, can_redo) = {
        let undo_stack = state.undo_stack.lock().unwrap();
        (undo_stack.can_undo(), undo_stack.can_redo())
    };

    // Rebuild dependency maps after structural restore
    if structural_restore {
        rebuild_all_dependencies(state);
    }

    UndoResult {
        success: true,
        description: Some(description),
        updated_cells,
        can_undo,
        can_redo,
        merge_changed,
        structural_restore,
        pivot_changed,
        slicer_changed,
        ribbon_filter_changed,
        objects_changed,
    }
}

/// Which subsystem a CustomRestore affected — drives the `*_changed` flags the
/// frontend keys off after an undo/redo.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum CustomRestoreKind {
    Pivot,
    Slicer,
    RibbonFilter,
    Objects,
    Other,
}

// ============================================================================
// CustomRestore registry (A3.4) — the backend undo/restore extension seam.
//
// A CellChange::CustomRestore carries a string `kind` + opaque bytes. This
// registry maps each kind to { restore_fn, change_class, defer } as DATA,
// replacing what used to be three hardcoded, drifting things: a `match` over
// kind, a fragile `kind.starts_with("pivot_"/"slicer"/…)` deferral check, and a
// hand-maintained kind→change-flag mapping. Adding a built-in feature's undo
// support is now one registry row + a one-line adapter, and the defer decision
// is EXPLICIT per kind (not pattern-matched on the name).
//
// `defer` is load-bearing for deadlock-avoidance: a deferred restore acquires
// OTHER state locks (pivot/slicer/ribbon_filter/object) and MUST run only after
// the grid/style locks are released. Inline (non-deferred) restores touch just
// AppState sublocks that are safe to take while grid locks are held. Every
// `defer`/`change_class` value below is transcribed 1:1 from the prior match +
// prefix logic; see the registry-consistency unit test.
//
// Registration is a central data table (trusted, in-tree only — never a surface
// untrusted code registers into). A future per-module/inventory self-registration
// (mirroring the frontend chart-mark registry) is possible but deliberately not
// taken here: there is no third-party consumer and a central table avoids
// startup-ordering risk.
// ============================================================================

/// Uniform restore handler. Receives every managed state a restore might need;
/// each adapter forwards to its concrete `apply_*_restore` using only what it
/// uses (the rest are ignored). `kind` is passed through for handlers that key
/// off it (default-dimension, object-swap).
type RestoreFn = fn(
    &AppState,
    &PivotState,
    &SlicerState,
    &RibbonFilterState,
    &str,
    &[u8],
    &mut Transaction,
);

struct RestoreSpec {
    restore: RestoreFn,
    change_class: CustomRestoreKind,
    /// Defer until grid/style locks are released (avoids lock-ordering deadlock).
    defer: bool,
}

// --- Adapters: forward the uniform signature to each concrete restore fn. ----
fn r_comment(s: &AppState, _p: &PivotState, _sl: &SlicerState, _rf: &RibbonFilterState, _k: &str, d: &[u8], inv: &mut Transaction) { apply_comment_restore(s, d, inv); }
fn r_note(s: &AppState, _p: &PivotState, _sl: &SlicerState, _rf: &RibbonFilterState, _k: &str, d: &[u8], inv: &mut Transaction) { apply_note_restore(s, d, inv); }
fn r_hyperlink(s: &AppState, _p: &PivotState, _sl: &SlicerState, _rf: &RibbonFilterState, _k: &str, d: &[u8], inv: &mut Transaction) { apply_hyperlink_restore(s, d, inv); }
fn r_default_dim(s: &AppState, _p: &PivotState, _sl: &SlicerState, _rf: &RibbonFilterState, k: &str, d: &[u8], inv: &mut Transaction) { apply_default_dimension_restore(s, k, d, inv); }
fn r_pivot_definition(s: &AppState, p: &PivotState, _sl: &SlicerState, _rf: &RibbonFilterState, _k: &str, d: &[u8], inv: &mut Transaction) { apply_pivot_definition_restore(s, p, d, inv); }
fn r_pivot_create(s: &AppState, p: &PivotState, _sl: &SlicerState, _rf: &RibbonFilterState, _k: &str, d: &[u8], inv: &mut Transaction) { apply_pivot_create_restore(s, p, d, inv); }
fn r_pivot_delete(s: &AppState, p: &PivotState, _sl: &SlicerState, _rf: &RibbonFilterState, _k: &str, d: &[u8], inv: &mut Transaction) { apply_pivot_delete_restore(s, p, d, inv); }
fn r_slicer(_s: &AppState, _p: &PivotState, sl: &SlicerState, _rf: &RibbonFilterState, _k: &str, d: &[u8], inv: &mut Transaction) { apply_slicer_restore(sl, d, inv); }
fn r_slicer_create(_s: &AppState, _p: &PivotState, sl: &SlicerState, _rf: &RibbonFilterState, _k: &str, d: &[u8], inv: &mut Transaction) { apply_slicer_create_restore(sl, d, inv); }
fn r_slicer_delete(_s: &AppState, _p: &PivotState, sl: &SlicerState, _rf: &RibbonFilterState, _k: &str, d: &[u8], inv: &mut Transaction) { apply_slicer_delete_restore(sl, d, inv); }
fn r_ribbon_filter(_s: &AppState, _p: &PivotState, _sl: &SlicerState, rf: &RibbonFilterState, _k: &str, d: &[u8], inv: &mut Transaction) { apply_ribbon_filter_restore(rf, d, inv); }
fn r_ribbon_filter_create(_s: &AppState, _p: &PivotState, _sl: &SlicerState, rf: &RibbonFilterState, _k: &str, d: &[u8], inv: &mut Transaction) { apply_ribbon_filter_create_restore(rf, d, inv); }
fn r_ribbon_filter_delete(_s: &AppState, _p: &PivotState, _sl: &SlicerState, rf: &RibbonFilterState, _k: &str, d: &[u8], inv: &mut Transaction) { apply_ribbon_filter_delete_restore(rf, d, inv); }
fn r_object_swap(s: &AppState, _p: &PivotState, _sl: &SlicerState, _rf: &RibbonFilterState, k: &str, d: &[u8], inv: &mut Transaction) { apply_object_swap_restore(s, k, d, inv); }

/// The kind → spec table, built once.
static RESTORE_REGISTRY: Lazy<HashMap<&'static str, RestoreSpec>> = Lazy::new(|| {
    use CustomRestoreKind::*;
    let mut m: HashMap<&'static str, RestoreSpec> = HashMap::new();
    // Inline (defer: false) — simple metadata restores, no cross-state lock, no change-flag.
    m.insert("comment", RestoreSpec { restore: r_comment, change_class: Other, defer: false });
    m.insert("note", RestoreSpec { restore: r_note, change_class: Other, defer: false });
    m.insert("hyperlink", RestoreSpec { restore: r_hyperlink, change_class: Other, defer: false });
    m.insert("default_row_height", RestoreSpec { restore: r_default_dim, change_class: Other, defer: false });
    m.insert("default_column_width", RestoreSpec { restore: r_default_dim, change_class: Other, defer: false });
    // Deferred (defer: true) — acquire other state locks; run after grid locks drop.
    m.insert("pivot_definition", RestoreSpec { restore: r_pivot_definition, change_class: Pivot, defer: true });
    m.insert("pivot_create", RestoreSpec { restore: r_pivot_create, change_class: Pivot, defer: true });
    m.insert("pivot_delete", RestoreSpec { restore: r_pivot_delete, change_class: Pivot, defer: true });
    m.insert("slicer", RestoreSpec { restore: r_slicer, change_class: Slicer, defer: true });
    m.insert("slicer_create", RestoreSpec { restore: r_slicer_create, change_class: Slicer, defer: true });
    m.insert("slicer_delete", RestoreSpec { restore: r_slicer_delete, change_class: Slicer, defer: true });
    m.insert("ribbon_filter", RestoreSpec { restore: r_ribbon_filter, change_class: RibbonFilter, defer: true });
    m.insert("ribbon_filter_create", RestoreSpec { restore: r_ribbon_filter_create, change_class: RibbonFilter, defer: true });
    m.insert("ribbon_filter_delete", RestoreSpec { restore: r_ribbon_filter_delete, change_class: RibbonFilter, defer: true });
    for k in [
        "obj_chart", "obj_sparklines", "obj_table", "obj_autofilter",
        "obj_validation", "obj_named_range", "obj_freeze",
    ] {
        m.insert(k, RestoreSpec { restore: r_object_swap, change_class: Objects, defer: true });
    }
    m
});

/// Look up the restore spec for a custom-restore `kind` (None ⇒ unknown kind).
fn restore_spec(kind: &str) -> Option<&'static RestoreSpec> {
    RESTORE_REGISTRY.get(kind)
}

/// Set the matching `*_changed` flag for a restore's change class (Other ⇒ none).
fn set_restore_change_flag(
    class: CustomRestoreKind,
    pivot_changed: &mut bool,
    slicer_changed: &mut bool,
    ribbon_filter_changed: &mut bool,
    objects_changed: &mut bool,
) {
    match class {
        CustomRestoreKind::Pivot => *pivot_changed = true,
        CustomRestoreKind::Slicer => *slicer_changed = true,
        CustomRestoreKind::RibbonFilter => *ribbon_filter_changed = true,
        CustomRestoreKind::Objects => *objects_changed = true,
        CustomRestoreKind::Other => {}
    }
}

/// Restore a comment snapshot for undo/redo.
fn apply_comment_restore(
    state: &AppState,
    data: &[u8],
    inverse_transaction: &mut Transaction,
) {
    use crate::comments::Comment;

    #[derive(serde::Deserialize, serde::Serialize)]
    struct CommentSnapshot {
        sheet_index: usize,
        row: u32,
        col: u32,
        previous: Option<Comment>,
    }

    let snapshot: CommentSnapshot = match serde_json::from_slice(data) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("[undo] Failed to deserialize comment snapshot: {}", e);
            return;
        }
    };

    let mut comments = state.comments.lock().unwrap();
    let sheet_comments = comments.entry(snapshot.sheet_index).or_default();
    let key = (snapshot.row, snapshot.col);

    // Save current state for inverse
    let current = sheet_comments.get(&key).cloned();
    let inverse_data = serde_json::to_vec(&CommentSnapshot {
        sheet_index: snapshot.sheet_index,
        row: snapshot.row,
        col: snapshot.col,
        previous: current,
    }).unwrap_or_default();
    inverse_transaction.add_change(CellChange::CustomRestore {
        kind: "comment".to_string(),
        data: inverse_data,
    });

    // Restore previous state
    match snapshot.previous {
        Some(comment) => { sheet_comments.insert(key, comment); }
        None => { sheet_comments.remove(&key); }
    }
}

/// Restore a note snapshot for undo/redo.
fn apply_note_restore(
    state: &AppState,
    data: &[u8],
    inverse_transaction: &mut Transaction,
) {
    use crate::notes::Note;

    #[derive(serde::Deserialize, serde::Serialize)]
    struct NoteSnapshot {
        sheet_index: usize,
        row: u32,
        col: u32,
        previous: Option<Note>,
    }

    let snapshot: NoteSnapshot = match serde_json::from_slice(data) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("[undo] Failed to deserialize note snapshot: {}", e);
            return;
        }
    };

    let mut notes = state.notes.lock().unwrap();
    let sheet_notes = notes.entry(snapshot.sheet_index).or_default();
    let key = (snapshot.row, snapshot.col);

    // Save current state for inverse
    let current = sheet_notes.get(&key).cloned();
    let inverse_data = serde_json::to_vec(&NoteSnapshot {
        sheet_index: snapshot.sheet_index,
        row: snapshot.row,
        col: snapshot.col,
        previous: current,
    }).unwrap_or_default();
    inverse_transaction.add_change(CellChange::CustomRestore {
        kind: "note".to_string(),
        data: inverse_data,
    });

    // Restore previous state
    match snapshot.previous {
        Some(note) => { sheet_notes.insert(key, note); }
        None => { sheet_notes.remove(&key); }
    }
}

/// Restore a hyperlink snapshot for undo/redo.
fn apply_hyperlink_restore(
    state: &AppState,
    data: &[u8],
    inverse_transaction: &mut Transaction,
) {
    use crate::hyperlinks::Hyperlink;

    #[derive(serde::Deserialize, serde::Serialize)]
    struct HyperlinkSnapshot {
        sheet_index: usize,
        row: u32,
        col: u32,
        previous: Option<Hyperlink>,
    }

    let snapshot: HyperlinkSnapshot = match serde_json::from_slice(data) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("[undo] Failed to deserialize hyperlink snapshot: {}", e);
            return;
        }
    };

    let mut hyperlinks = state.hyperlinks.lock().unwrap();
    let sheet_links = hyperlinks.entry(snapshot.sheet_index).or_default();
    let key = (snapshot.row, snapshot.col);

    // Save current state for inverse
    let current = sheet_links.get(&key).cloned();
    let inverse_data = serde_json::to_vec(&HyperlinkSnapshot {
        sheet_index: snapshot.sheet_index,
        row: snapshot.row,
        col: snapshot.col,
        previous: current,
    }).unwrap_or_default();
    inverse_transaction.add_change(CellChange::CustomRestore {
        kind: "hyperlink".to_string(),
        data: inverse_data,
    });

    // Restore previous state
    match snapshot.previous {
        Some(link) => { sheet_links.insert(key, link); }
        None => { sheet_links.remove(&key); }
    }
}

/// Restore default row height or column width for undo/redo.
fn apply_default_dimension_restore(
    state: &AppState,
    kind: &str,
    data: &[u8],
    inverse_transaction: &mut Transaction,
) {
    let value: f64 = match serde_json::from_slice(data) {
        Ok(v) => v,
        Err(e) => {
            eprintln!("[undo] Failed to deserialize default dimension: {}", e);
            return;
        }
    };

    match kind {
        "default_row_height" => {
            let mut h = state.default_row_height.lock().unwrap();
            let current = *h;
            inverse_transaction.add_change(CellChange::CustomRestore {
                kind: kind.to_string(),
                data: serde_json::to_vec(&current).unwrap_or_default(),
            });
            *h = value;
        }
        "default_column_width" => {
            let mut w = state.default_column_width.lock().unwrap();
            let current = *w;
            inverse_transaction.add_change(CellChange::CustomRestore {
                kind: kind.to_string(),
                data: serde_json::to_vec(&current).unwrap_or_default(),
            });
            *w = value;
        }
        _ => {}
    }
}

/// Perform undo operation.
#[tauri::command]
pub fn undo(
    state: State<AppState>,
    file_state: State<FileState>,
    pivot_state: State<'_, PivotState>,
    slicer_state: State<'_, SlicerState>,
    ribbon_filter_state: State<'_, RibbonFilterState>,
) -> UndoResult {
    let transaction = {
        let mut undo_stack = state.undo_stack.lock().unwrap();
        match undo_stack.pop_undo() {
            Some(t) => t,
            None => {
                return UndoResult {
                    success: false,
                    description: None,
                    updated_cells: Vec::new(),
                    can_undo: false,
                    can_redo: undo_stack.can_redo(),
                    merge_changed: false,
                    structural_restore: false,
                    pivot_changed: false,
                    slicer_changed: false,
                    ribbon_filter_changed: false,
                    objects_changed: false,
                };
            }
        }
    };

    apply_changes(&state, &file_state, &pivot_state, &slicer_state, &ribbon_filter_state, transaction, true)
}

/// Perform redo operation.
#[tauri::command]
pub fn redo(
    state: State<AppState>,
    file_state: State<FileState>,
    pivot_state: State<'_, PivotState>,
    slicer_state: State<'_, SlicerState>,
    ribbon_filter_state: State<'_, RibbonFilterState>,
) -> UndoResult {
    let transaction = {
        let mut undo_stack = state.undo_stack.lock().unwrap();
        match undo_stack.pop_redo() {
            Some(t) => t,
            None => {
                return UndoResult {
                    success: false,
                    description: None,
                    updated_cells: Vec::new(),
                    can_undo: undo_stack.can_undo(),
                    can_redo: false,
                    merge_changed: false,
                    structural_restore: false,
                    pivot_changed: false,
                    slicer_changed: false,
                    ribbon_filter_changed: false,
                    objects_changed: false,
                };
            }
        }
    };

    apply_changes(&state, &file_state, &pivot_state, &slicer_state, &ribbon_filter_state, transaction, false)
}

/// Clear undo/redo history (e.g., when opening a new file).
#[tauri::command]
pub fn clear_undo_history(state: State<AppState>) {
    let mut undo_stack = state.undo_stack.lock().unwrap();
    undo_stack.clear();
}

// ============================================================================
// PIVOT TABLE UNDO/REDO HANDLERS
// ============================================================================

/// Snapshot of a pivot definition for undo/redo.
/// Optionally includes cells that were overwritten when the pivot expanded,
/// so that `undo_pivot_overwrite` can restore them when the user cancels.
#[derive(serde::Serialize, serde::Deserialize)]
struct PivotDefinitionSnapshot {
    pivot_id: pivot_engine::PivotId,
    definition: PivotDefinition,
    /// Cells overwritten by the pivot expansion.
    /// Empty when no cells were overwritten.
    #[serde(default)]
    overwritten_cells: Vec<crate::pivot::operations::SavedCell>,
    /// Sheet index where overwritten cells lived.
    #[serde(default)]
    dest_sheet_idx: usize,
}

/// Snapshot of a full pivot table (definition + cache) for create/delete undo.
#[derive(serde::Serialize, serde::Deserialize)]
struct PivotFullSnapshot {
    pivot_id: pivot_engine::PivotId,
    definition: PivotDefinition,
    cache: pivot_engine::PivotCache,
}

/// Restore a pivot definition for undo/redo.
/// Replaces the current definition, recalculates the view, and rewrites the grid.
fn apply_pivot_definition_restore(
    state: &AppState,
    pivot_state: &PivotState,
    data: &[u8],
    inverse_transaction: &mut Transaction,
) {
    let snapshot: PivotDefinitionSnapshot = match serde_json::from_slice(data) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("[undo] Failed to deserialize pivot definition snapshot: {}", e);
            return;
        }
    };

    let pivot_id = snapshot.pivot_id;

    let mut pivot_tables = pivot_state.pivot_tables.lock().unwrap();
    if let Some((definition, cache)) = pivot_tables.get_mut(&pivot_id) {
        // Save current definition for inverse transaction
        let dest_sheet_idx_current = resolve_dest_sheet_index(state, definition);

        let current_snapshot = PivotDefinitionSnapshot {
            pivot_id,
            definition: definition.clone(),
            // Overwritten cells for the inverse will be captured when redo runs
            overwritten_cells: Vec::new(),
            dest_sheet_idx: dest_sheet_idx_current,
        };
        let inverse_data = serde_json::to_vec(&current_snapshot).unwrap_or_default();
        inverse_transaction.add_change(CellChange::CustomRestore {
            kind: "pivot_definition".to_string(),
            data: inverse_data,
        });

        // Restore the old definition
        *definition = snapshot.definition;

        // Recalculate the view
        let view = safe_calculate_pivot(definition, cache);

        // Store view for windowed cell fetching
        pivot_state.views.lock().unwrap().insert(pivot_id, view.clone());

        let destination = definition.destination;
        let dest_sheet_idx = resolve_dest_sheet_index(state, definition);

        drop(pivot_tables);

        // Rewrite the grid
        finalize_pivot_update(state, pivot_state, pivot_id, dest_sheet_idx, destination, &view);

        // Restore cells that were overwritten by the previous pivot expansion
        if !snapshot.overwritten_cells.is_empty() {
            let mut grids = state.grids.lock().unwrap();
            if let Some(dest_grid) = grids.get_mut(snapshot.dest_sheet_idx) {
                for sc in &snapshot.overwritten_cells {
                    dest_grid.set_cell(sc.row, sc.col, sc.cell.clone());
                }
            }
            let active_sheet = *state.active_sheet.lock().unwrap();
            if snapshot.dest_sheet_idx == active_sheet {
                let mut grid = state.grid.lock().unwrap();
                for sc in &snapshot.overwritten_cells {
                    grid.set_cell(sc.row, sc.col, sc.cell.clone());
                }
            }
        }
    } else {
        eprintln!("[undo] Pivot table {} not found for definition restore", pivot_id);
    }
}

/// Undo pivot creation: remove the pivot and clear its grid region.
fn apply_pivot_create_restore(
    state: &AppState,
    pivot_state: &PivotState,
    data: &[u8],
    inverse_transaction: &mut Transaction,
) {
    let snapshot: PivotFullSnapshot = match serde_json::from_slice(data) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("[undo] Failed to deserialize pivot create snapshot: {}", e);
            return;
        }
    };

    let pivot_id = snapshot.pivot_id;

    // Save current state for redo (redo = re-create the pivot)
    let mut pivot_tables = pivot_state.pivot_tables.lock().unwrap();
    if let Some((definition, cache)) = pivot_tables.get(&pivot_id) {
        let redo_snapshot = PivotFullSnapshot {
            pivot_id,
            definition: definition.clone(),
            cache: cache.clone(),
        };
        let redo_data = serde_json::to_vec(&redo_snapshot).unwrap_or_default();
        inverse_transaction.add_change(CellChange::CustomRestore {
            kind: "pivot_delete".to_string(),
            data: redo_data,
        });

        let dest_sheet_idx = resolve_dest_sheet_index(state, definition);

        // Clear the pivot grid region
        let old_region = get_pivot_region(state, pivot_id);
        if let Some(ref region) = old_region {
            let mut grids = state.grids.lock().unwrap();
            if let Some(dest_grid) = grids.get_mut(dest_sheet_idx) {
                clear_pivot_region_from_grid(
                    dest_grid,
                    region.start_row, region.start_col,
                    region.end_row, region.end_col,
                );

                let active_sheet = *state.active_sheet.lock().unwrap();
                if dest_sheet_idx == active_sheet {
                    let mut grid = state.grid.lock().unwrap();
                    for row in region.start_row..=region.end_row {
                        for col in region.start_col..=region.end_col {
                            grid.clear_cell(row, col);
                        }
                    }
                    grid.recalculate_bounds();
                }
            }
        }
    }

    // Remove pivot
    pivot_tables.remove(&pivot_id);
    pivot_state.views.lock().unwrap().remove(&pivot_id);

    // Clear active if this was the active pivot
    let mut active = pivot_state.active_pivot_id.lock().unwrap();
    if *active == Some(pivot_id) {
        *active = None;
    }
    drop(active);

    // Remove pivot region tracking
    let mut regions = state.protected_regions.lock().unwrap();
    regions.retain(|r| !(r.region_type == "pivot" && r.owner_id == pivot_id));
}

/// Undo pivot deletion: re-create the pivot from the snapshot.
fn apply_pivot_delete_restore(
    state: &AppState,
    pivot_state: &PivotState,
    data: &[u8],
    inverse_transaction: &mut Transaction,
) {
    let snapshot: PivotFullSnapshot = match serde_json::from_slice(data) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("[undo] Failed to deserialize pivot delete snapshot: {}", e);
            return;
        }
    };

    let pivot_id = snapshot.pivot_id;
    let definition = snapshot.definition;
    let mut cache = snapshot.cache;

    // Save for redo (redo = delete it again)
    let redo_snapshot = PivotFullSnapshot {
        pivot_id,
        definition: definition.clone(),
        cache: cache.clone(),
    };
    let redo_data = serde_json::to_vec(&redo_snapshot).unwrap_or_default();
    inverse_transaction.add_change(CellChange::CustomRestore {
        kind: "pivot_create".to_string(),
        data: redo_data,
    });

    // Recalculate view
    let view = safe_calculate_pivot(&definition, &mut cache);
    pivot_state.views.lock().unwrap().insert(pivot_id, view.clone());

    let destination = definition.destination;
    let dest_sheet_idx = resolve_dest_sheet_index(state, &definition);

    // Restore pivot
    let mut pivot_tables = pivot_state.pivot_tables.lock().unwrap();
    pivot_tables.insert(pivot_id, (definition, cache));
    drop(pivot_tables);

    // Write to grid
    finalize_pivot_update(state, pivot_state, pivot_id, dest_sheet_idx, destination, &view);
}

// ============================================================================
// SLICER UNDO/REDO HANDLERS
// ============================================================================

/// Snapshot of a slicer for property/selection undo.
#[derive(serde::Serialize, serde::Deserialize)]
struct SlicerSnapshot {
    slicer_id: identity::EntityId,
    previous: Slicer,
}

/// Snapshot for slicer creation undo (undo = delete).
#[derive(serde::Serialize, serde::Deserialize)]
struct SlicerCreateSnapshot {
    slicer_id: identity::EntityId,
}

/// Restore a slicer's previous state (properties/selection).
fn apply_slicer_restore(
    slicer_state: &SlicerState,
    data: &[u8],
    inverse_transaction: &mut Transaction,
) {
    let snapshot: SlicerSnapshot = match serde_json::from_slice(data) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("[undo] Failed to deserialize slicer snapshot: {}", e);
            return;
        }
    };

    let mut slicers = slicer_state.slicers.lock().unwrap();
    if let Some(slicer) = slicers.get_mut(&snapshot.slicer_id) {
        // Save current state for inverse
        let inverse_snapshot = SlicerSnapshot {
            slicer_id: snapshot.slicer_id,
            previous: slicer.clone(),
        };
        let inverse_data = serde_json::to_vec(&inverse_snapshot).unwrap_or_default();
        inverse_transaction.add_change(CellChange::CustomRestore {
            kind: "slicer".to_string(),
            data: inverse_data,
        });

        // Restore previous state
        *slicer = snapshot.previous;
    }
}

/// Undo slicer creation: remove the slicer.
fn apply_slicer_create_restore(
    slicer_state: &SlicerState,
    data: &[u8],
    inverse_transaction: &mut Transaction,
) {
    let snapshot: SlicerCreateSnapshot = match serde_json::from_slice(data) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("[undo] Failed to deserialize slicer create snapshot: {}", e);
            return;
        }
    };

    let mut slicers = slicer_state.slicers.lock().unwrap();
    if let Some(slicer) = slicers.remove(&snapshot.slicer_id) {
        // Save for redo (redo = re-create)
        let redo_snapshot = SlicerSnapshot {
            slicer_id: snapshot.slicer_id,
            previous: slicer,
        };
        let redo_data = serde_json::to_vec(&redo_snapshot).unwrap_or_default();
        inverse_transaction.add_change(CellChange::CustomRestore {
            kind: "slicer_delete".to_string(),
            data: redo_data,
        });
    }
}

/// Undo slicer deletion: re-create the slicer from snapshot.
fn apply_slicer_delete_restore(
    slicer_state: &SlicerState,
    data: &[u8],
    inverse_transaction: &mut Transaction,
) {
    let snapshot: SlicerSnapshot = match serde_json::from_slice(data) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("[undo] Failed to deserialize slicer delete snapshot: {}", e);
            return;
        }
    };

    // Save for redo (redo = delete it again)
    let redo_snapshot = SlicerCreateSnapshot {
        slicer_id: snapshot.slicer_id,
    };
    let redo_data = serde_json::to_vec(&redo_snapshot).unwrap_or_default();
    inverse_transaction.add_change(CellChange::CustomRestore {
        kind: "slicer_create".to_string(),
        data: redo_data,
    });

    // Restore slicer
    let mut slicers = slicer_state.slicers.lock().unwrap();
    slicers.insert(snapshot.slicer_id, snapshot.previous);
}

// ============================================================================
// RIBBON FILTER UNDO/REDO HANDLERS
// ============================================================================

/// Snapshot of a ribbon filter for property/selection undo.
#[derive(serde::Serialize, serde::Deserialize)]
struct RibbonFilterSnapshot {
    filter_id: identity::EntityId,
    previous: RibbonFilter,
}

/// Snapshot for ribbon filter creation undo (undo = delete).
#[derive(serde::Serialize, serde::Deserialize)]
struct RibbonFilterCreateSnapshot {
    filter_id: identity::EntityId,
}

/// Restore a ribbon filter's previous state (properties/selection).
fn apply_ribbon_filter_restore(
    ribbon_filter_state: &RibbonFilterState,
    data: &[u8],
    inverse_transaction: &mut Transaction,
) {
    let snapshot: RibbonFilterSnapshot = match serde_json::from_slice(data) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("[undo] Failed to deserialize ribbon filter snapshot: {}", e);
            return;
        }
    };

    let mut filters = ribbon_filter_state.filters.lock().unwrap();
    if let Some(filter) = filters.get_mut(&snapshot.filter_id) {
        // Save current state for inverse
        let inverse_snapshot = RibbonFilterSnapshot {
            filter_id: snapshot.filter_id,
            previous: filter.clone(),
        };
        let inverse_data = serde_json::to_vec(&inverse_snapshot).unwrap_or_default();
        inverse_transaction.add_change(CellChange::CustomRestore {
            kind: "ribbon_filter".to_string(),
            data: inverse_data,
        });

        // Restore previous state
        *filter = snapshot.previous;
    }
}

/// Undo ribbon filter creation: remove the filter.
fn apply_ribbon_filter_create_restore(
    ribbon_filter_state: &RibbonFilterState,
    data: &[u8],
    inverse_transaction: &mut Transaction,
) {
    let snapshot: RibbonFilterCreateSnapshot = match serde_json::from_slice(data) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("[undo] Failed to deserialize ribbon filter create snapshot: {}", e);
            return;
        }
    };

    let mut filters = ribbon_filter_state.filters.lock().unwrap();
    if let Some(filter) = filters.remove(&snapshot.filter_id) {
        let redo_snapshot = RibbonFilterSnapshot {
            filter_id: snapshot.filter_id,
            previous: filter,
        };
        let redo_data = serde_json::to_vec(&redo_snapshot).unwrap_or_default();
        inverse_transaction.add_change(CellChange::CustomRestore {
            kind: "ribbon_filter_delete".to_string(),
            data: redo_data,
        });
    }
}

/// Undo ribbon filter deletion: re-create the filter from snapshot.
fn apply_ribbon_filter_delete_restore(
    ribbon_filter_state: &RibbonFilterState,
    data: &[u8],
    inverse_transaction: &mut Transaction,
) {
    let snapshot: RibbonFilterSnapshot = match serde_json::from_slice(data) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("[undo] Failed to deserialize ribbon filter delete snapshot: {}", e);
            return;
        }
    };

    let redo_snapshot = RibbonFilterCreateSnapshot {
        filter_id: snapshot.filter_id,
    };
    let redo_data = serde_json::to_vec(&redo_snapshot).unwrap_or_default();
    inverse_transaction.add_change(CellChange::CustomRestore {
        kind: "ribbon_filter_create".to_string(),
        data: redo_data,
    });

    let mut filters = ribbon_filter_state.filters.lock().unwrap();
    filters.insert(snapshot.filter_id, snapshot.previous);
}

// ============================================================================
// Object-state restores (obj_*) — generic SWAP semantics.
//
// Applying an obj_* change replaces the targeted slice of state with the
// snapshot and records the displaced current state under the SAME kind in
// the inverse transaction. Swap is self-inverse, so undo and redo are
// symmetric by construction. Covers charts, sparkline groups, tables,
// autofilters, data validation, named ranges and freeze panes
// (BUG-0001/0002/0003/0006/0007/0008/0017: these lifecycles bypassed the
// undo system entirely).
// ============================================================================

#[derive(serde::Serialize, serde::Deserialize)]
struct ChartObjSnapshot {
    chart_id: identity::EntityId,
    previous: Option<crate::api_types::ChartEntry>,
}

#[derive(serde::Serialize, serde::Deserialize)]
struct SparklinesObjSnapshot {
    sheet_index: usize,
    /// groups_json for the sheet, or None when the sheet had no sparklines.
    previous: Option<String>,
}

#[derive(serde::Serialize, serde::Deserialize)]
struct TableObjSnapshot {
    sheet_index: usize,
    table_id: identity::EntityId,
    previous: Option<crate::tables::Table>,
}

#[derive(serde::Serialize, serde::Deserialize)]
struct AutoFilterObjSnapshot {
    sheet_index: usize,
    previous: Option<crate::autofilter::AutoFilter>,
}

#[derive(serde::Serialize, serde::Deserialize)]
struct ValidationObjSnapshot {
    sheet_index: usize,
    previous: Vec<crate::data_validation::ValidationRange>,
}

#[derive(serde::Serialize, serde::Deserialize)]
struct NamedRangeObjSnapshot {
    /// Uppercase registry key.
    key: String,
    previous: Option<crate::named_ranges::NamedRange>,
}

#[derive(serde::Serialize, serde::Deserialize)]
struct FreezeObjSnapshot {
    sheet_index: usize,
    previous: crate::sheets::FreezeConfig,
}

fn push_obj_inverse<T: serde::Serialize>(
    inverse_transaction: &mut Transaction,
    kind: &str,
    snapshot: &T,
) {
    let data = serde_json::to_vec(snapshot).unwrap_or_default();
    inverse_transaction.add_change(CellChange::CustomRestore {
        kind: kind.to_string(),
        data,
    });
}

fn apply_object_swap_restore(
    state: &AppState,
    kind: &str,
    data: &[u8],
    inverse_transaction: &mut Transaction,
) {
    match kind {
        "obj_chart" => {
            let snap: ChartObjSnapshot = match serde_json::from_slice(data) {
                Ok(s) => s,
                Err(e) => { eprintln!("[undo] bad obj_chart snapshot: {}", e); return; }
            };
            let mut charts = state.charts.lock().unwrap();
            let current = charts
                .iter()
                .position(|c| c.id == snap.chart_id)
                .map(|i| charts.remove(i));
            push_obj_inverse(inverse_transaction, kind, &ChartObjSnapshot {
                chart_id: snap.chart_id,
                previous: current,
            });
            if let Some(prev) = snap.previous {
                charts.push(prev);
            }
        }
        "obj_sparklines" => {
            let snap: SparklinesObjSnapshot = match serde_json::from_slice(data) {
                Ok(s) => s,
                Err(e) => { eprintln!("[undo] bad obj_sparklines snapshot: {}", e); return; }
            };
            let mut sparklines = state.sparklines.lock().unwrap();
            let current = sparklines
                .iter()
                .position(|s| s.sheet_index == snap.sheet_index)
                .map(|i| sparklines.remove(i).groups_json);
            push_obj_inverse(inverse_transaction, kind, &SparklinesObjSnapshot {
                sheet_index: snap.sheet_index,
                previous: current,
            });
            if let Some(groups_json) = snap.previous {
                sparklines.push(crate::api_types::SparklineEntry {
                    sheet_index: snap.sheet_index,
                    groups_json,
                });
            }
        }
        "obj_table" => {
            let snap: TableObjSnapshot = match serde_json::from_slice(data) {
                Ok(s) => s,
                Err(e) => { eprintln!("[undo] bad obj_table snapshot: {}", e); return; }
            };
            let mut tables = state.tables.lock().unwrap();
            let mut table_names = state.table_names.lock().unwrap();
            let sheet_tables = tables.entry(snap.sheet_index).or_default();
            let current = sheet_tables.remove(&snap.table_id);
            if let Some(ref t) = current {
                table_names.remove(&t.name.to_uppercase());
            }
            push_obj_inverse(inverse_transaction, kind, &TableObjSnapshot {
                sheet_index: snap.sheet_index,
                table_id: snap.table_id,
                previous: current,
            });
            if let Some(t) = snap.previous {
                table_names.insert(t.name.to_uppercase(), (snap.sheet_index, snap.table_id));
                sheet_tables.insert(snap.table_id, t);
            }
        }
        "obj_autofilter" => {
            let snap: AutoFilterObjSnapshot = match serde_json::from_slice(data) {
                Ok(s) => s,
                Err(e) => { eprintln!("[undo] bad obj_autofilter snapshot: {}", e); return; }
            };
            let mut auto_filters = state.auto_filters.lock().unwrap();
            let current = auto_filters.remove(&snap.sheet_index);
            push_obj_inverse(inverse_transaction, kind, &AutoFilterObjSnapshot {
                sheet_index: snap.sheet_index,
                previous: current,
            });
            if let Some(prev) = snap.previous {
                auto_filters.insert(snap.sheet_index, prev);
            }
        }
        "obj_validation" => {
            let snap: ValidationObjSnapshot = match serde_json::from_slice(data) {
                Ok(s) => s,
                Err(e) => { eprintln!("[undo] bad obj_validation snapshot: {}", e); return; }
            };
            let mut validations = state.data_validations.lock().unwrap();
            let current = validations.remove(&snap.sheet_index).unwrap_or_default();
            push_obj_inverse(inverse_transaction, kind, &ValidationObjSnapshot {
                sheet_index: snap.sheet_index,
                previous: current,
            });
            if !snap.previous.is_empty() {
                validations.insert(snap.sheet_index, snap.previous);
            }
        }
        "obj_named_range" => {
            let snap: NamedRangeObjSnapshot = match serde_json::from_slice(data) {
                Ok(s) => s,
                Err(e) => { eprintln!("[undo] bad obj_named_range snapshot: {}", e); return; }
            };
            let mut named_ranges = state.named_ranges.lock().unwrap();
            let current = named_ranges.remove(&snap.key);
            push_obj_inverse(inverse_transaction, kind, &NamedRangeObjSnapshot {
                key: snap.key.clone(),
                previous: current,
            });
            if let Some(prev) = snap.previous {
                named_ranges.insert(snap.key, prev);
            }
        }
        "obj_freeze" => {
            let snap: FreezeObjSnapshot = match serde_json::from_slice(data) {
                Ok(s) => s,
                Err(e) => { eprintln!("[undo] bad obj_freeze snapshot: {}", e); return; }
            };
            let mut freeze_configs = state.freeze_configs.lock().unwrap();
            while freeze_configs.len() <= snap.sheet_index {
                freeze_configs.push(crate::sheets::FreezeConfig::default());
            }
            let current = freeze_configs[snap.sheet_index].clone();
            push_obj_inverse(inverse_transaction, kind, &FreezeObjSnapshot {
                sheet_index: snap.sheet_index,
                previous: current,
            });
            freeze_configs[snap.sheet_index] = snap.previous;
        }
        _ => {}
    }
}

// ============================================================================
// Recording helpers — called by the mutating commands with the PRE-mutation
// state. Each opens its own one-shot transaction unless the caller already
// has one open.
// ============================================================================

fn record_object_undo(state: &AppState, kind: &str, data: Vec<u8>, description: &str) {
    let mut undo_stack = state.undo_stack.lock().unwrap();
    let opened = !undo_stack.has_open_transaction();
    if opened {
        undo_stack.begin_transaction(description.to_string());
    }
    undo_stack.record_custom_restore(kind.to_string(), data, description);
    if opened {
        undo_stack.commit_transaction();
    }
}

pub(crate) fn record_chart_undo(
    state: &AppState,
    chart_id: identity::EntityId,
    previous: Option<crate::api_types::ChartEntry>,
    description: &str,
) {
    let snap = ChartObjSnapshot { chart_id, previous };
    record_object_undo(state, "obj_chart", serde_json::to_vec(&snap).unwrap_or_default(), description);
}

pub(crate) fn record_sparklines_undo(
    state: &AppState,
    sheet_index: usize,
    previous: Option<String>,
    description: &str,
) {
    let snap = SparklinesObjSnapshot { sheet_index, previous };
    record_object_undo(state, "obj_sparklines", serde_json::to_vec(&snap).unwrap_or_default(), description);
}

pub(crate) fn record_table_undo(
    state: &AppState,
    sheet_index: usize,
    table_id: identity::EntityId,
    previous: Option<crate::tables::Table>,
    description: &str,
) {
    let snap = TableObjSnapshot { sheet_index, table_id, previous };
    record_object_undo(state, "obj_table", serde_json::to_vec(&snap).unwrap_or_default(), description);
}

pub(crate) fn record_autofilter_undo(
    state: &AppState,
    sheet_index: usize,
    previous: Option<crate::autofilter::AutoFilter>,
    description: &str,
) {
    let snap = AutoFilterObjSnapshot { sheet_index, previous };
    record_object_undo(state, "obj_autofilter", serde_json::to_vec(&snap).unwrap_or_default(), description);
}

pub(crate) fn record_validation_undo(
    state: &AppState,
    sheet_index: usize,
    previous: Vec<crate::data_validation::ValidationRange>,
    description: &str,
) {
    let snap = ValidationObjSnapshot { sheet_index, previous };
    record_object_undo(state, "obj_validation", serde_json::to_vec(&snap).unwrap_or_default(), description);
}

pub(crate) fn record_named_range_undo(
    state: &AppState,
    key: &str,
    previous: Option<crate::named_ranges::NamedRange>,
    description: &str,
) {
    let snap = NamedRangeObjSnapshot { key: key.to_string(), previous };
    record_object_undo(state, "obj_named_range", serde_json::to_vec(&snap).unwrap_or_default(), description);
}

pub(crate) fn record_freeze_undo(
    state: &AppState,
    sheet_index: usize,
    previous: crate::sheets::FreezeConfig,
    description: &str,
) {
    let snap = FreezeObjSnapshot { sheet_index, previous };
    record_object_undo(state, "obj_freeze", serde_json::to_vec(&snap).unwrap_or_default(), description);
}

#[cfg(test)]
mod restore_registry_tests {
    use super::*;

    /// The registry must reproduce the historical (kind -> defer, change_class)
    /// mapping EXACTLY. A diff here is a deliberate behavior change to undo.
    #[test]
    fn registry_matches_historical_mapping() {
        let expected: &[(&str, bool, CustomRestoreKind)] = &[
            ("comment", false, CustomRestoreKind::Other),
            ("note", false, CustomRestoreKind::Other),
            ("hyperlink", false, CustomRestoreKind::Other),
            ("default_row_height", false, CustomRestoreKind::Other),
            ("default_column_width", false, CustomRestoreKind::Other),
            ("pivot_definition", true, CustomRestoreKind::Pivot),
            ("pivot_create", true, CustomRestoreKind::Pivot),
            ("pivot_delete", true, CustomRestoreKind::Pivot),
            ("slicer", true, CustomRestoreKind::Slicer),
            ("slicer_create", true, CustomRestoreKind::Slicer),
            ("slicer_delete", true, CustomRestoreKind::Slicer),
            ("ribbon_filter", true, CustomRestoreKind::RibbonFilter),
            ("ribbon_filter_create", true, CustomRestoreKind::RibbonFilter),
            ("ribbon_filter_delete", true, CustomRestoreKind::RibbonFilter),
            ("obj_chart", true, CustomRestoreKind::Objects),
            ("obj_sparklines", true, CustomRestoreKind::Objects),
            ("obj_table", true, CustomRestoreKind::Objects),
            ("obj_autofilter", true, CustomRestoreKind::Objects),
            ("obj_validation", true, CustomRestoreKind::Objects),
            ("obj_named_range", true, CustomRestoreKind::Objects),
            ("obj_freeze", true, CustomRestoreKind::Objects),
        ];
        for (kind, defer, class) in expected {
            let spec = restore_spec(kind).unwrap_or_else(|| panic!("missing restore kind: {kind}"));
            assert_eq!(spec.defer, *defer, "defer mismatch for {kind}");
            assert_eq!(spec.change_class, *class, "change_class mismatch for {kind}");
        }
        // No extra kind slipped in unclassified.
        assert_eq!(RESTORE_REGISTRY.len(), expected.len(), "registry size drifted from expected");
    }

    /// The deadlock-critical `defer` flag must agree with the legacy
    /// `kind.starts_with("pivot_"/"slicer"/"ribbon_filter"/"obj_")` deferral for
    /// EVERY registered kind — this is what guarantees lock-ordering is preserved.
    #[test]
    fn defer_agrees_with_legacy_prefix_logic() {
        for (kind, spec) in RESTORE_REGISTRY.iter() {
            let legacy_deferred = kind.starts_with("pivot_")
                || kind.starts_with("slicer")
                || kind.starts_with("ribbon_filter")
                || kind.starts_with("obj_");
            assert_eq!(
                spec.defer, legacy_deferred,
                "defer for '{kind}' disagrees with the legacy prefix deferral"
            );
        }
    }

    #[test]
    fn unknown_kind_has_no_spec() {
        assert!(restore_spec("totally_unknown_kind").is_none());
    }
}
