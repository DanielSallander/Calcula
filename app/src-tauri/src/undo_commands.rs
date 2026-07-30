//! FILENAME: app/src-tauri/src/undo_commands.rs
// PURPOSE: Tauri commands for undo/redo operations.

use crate::api_types::{CellData, MergedRegion};
use crate::pane_control::types::{PaneControl, PaneControlState};
use crate::persistence::{FileState, UserFilesState};
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
    /// Whether pane control state was restored (frontend should refresh the Controls pane)
    pub pane_control_changed: bool,
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
    user_files_state: &UserFilesState,
    pivot_state: &PivotState,
    slicer_state: &SlicerState,
    ribbon_filter_state: &RibbonFilterState,
    pane_control_state: &PaneControlState,
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
    let mut pane_control_changed = false;
    let mut objects_changed = false;
    // True when an off-active-sheet script/AI write was undone/redone — drives a
    // post-restore active-sheet recalc (see the deferred-restore loop below).
    let mut script_cells_restored = false;

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
                        // Resolved against the active-sheet mirror the cell was
                        // just restored into, so the row/column tiers apply.
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
                    None => {
                        grid.clear_cell(*row, *col);
                        if active_sheet < grids.len() {
                            grids[active_sheet].clear_cell(*row, *col);
                        }
                        // The cell is gone, but a row/column style may still
                        // give its position an appearance.
                        let effective_style_index = grid.effective_style_index(*row, *col);
                        updated_cells.push(CellData {
                            row: *row,
                            col: *col,
                            display: String::new(),
                            display_color: None,
                            formula: None,
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
                    row_styles: grid.row_styles.iter().map(|(k, v)| (*k, *v)).collect(),
                    column_styles: grid.column_styles.iter().map(|(k, v)| (*k, *v)).collect(),
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
                grid.row_styles = snapshot.row_styles.iter().map(|(k, v)| (*k, *v)).collect();
                grid.column_styles =
                    snapshot.column_styles.iter().map(|(k, v)| (*k, *v)).collect();
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
                    grids[active_sheet].row_styles = grid.row_styles.clone();
                    grids[active_sheet].column_styles = grid.column_styles.clone();
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
                            pane_control_state, kind, data, &mut inverse_transaction,
                        );
                        set_restore_change_flag(
                            spec.change_class,
                            &mut pivot_changed, &mut slicer_changed,
                            &mut ribbon_filter_changed, &mut pane_control_changed,
                            &mut objects_changed,
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
                    pane_control_state, &kind, &data, &mut inverse_transaction,
                );
                set_restore_change_flag(
                    spec.change_class,
                    &mut pivot_changed, &mut slicer_changed,
                    &mut ribbon_filter_changed, &mut pane_control_changed,
                    &mut objects_changed,
                );
                if kind == "script_grid_cells" {
                    script_cells_restored = true;
                }
            }
            None => eprintln!("[undo] Unknown deferred custom restore kind: {}", kind),
        }
    }

    // Symmetry with the forward apply: when a non-active script/AI write is
    // undone/redone, the restored off-sheet Cells already carry their cached
    // values (no recalc needed for them), but ACTIVE-sheet formulas that reference
    // the restored cells must be re-evaluated — exactly as the forward path recalcs
    // the active sheet (scripting::commands). Without this, an active formula like
    // `=Sheet2!A1` would keep its pre-undo (stale) value until the next edit.
    if script_cells_restored {
        crate::calculation::recalculate_sheet_values(state, user_files_state, pivot_state, active_sheet, Some((pane_control_state, ribbon_filter_state)));
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
        pane_control_changed,
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
    /// Pane controls (Controls pane) — drives `pane_control_changed`.
    PaneControl,
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
    &PaneControlState,
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
fn r_comment(s: &AppState, _p: &PivotState, _sl: &SlicerState, _rf: &RibbonFilterState, _pc: &PaneControlState, _k: &str, d: &[u8], inv: &mut Transaction) { apply_comment_restore(s, d, inv); }
fn r_note(s: &AppState, _p: &PivotState, _sl: &SlicerState, _rf: &RibbonFilterState, _pc: &PaneControlState, _k: &str, d: &[u8], inv: &mut Transaction) { apply_note_restore(s, d, inv); }
fn r_hyperlink(s: &AppState, _p: &PivotState, _sl: &SlicerState, _rf: &RibbonFilterState, _pc: &PaneControlState, _k: &str, d: &[u8], inv: &mut Transaction) { apply_hyperlink_restore(s, d, inv); }
fn r_default_dim(s: &AppState, _p: &PivotState, _sl: &SlicerState, _rf: &RibbonFilterState, _pc: &PaneControlState, k: &str, d: &[u8], inv: &mut Transaction) { apply_default_dimension_restore(s, k, d, inv); }
fn r_pivot_definition(s: &AppState, p: &PivotState, _sl: &SlicerState, rf: &RibbonFilterState, pc: &PaneControlState, _k: &str, d: &[u8], inv: &mut Transaction) { apply_pivot_definition_restore(s, p, rf, pc, d, inv); }
fn r_pivot_create(s: &AppState, p: &PivotState, _sl: &SlicerState, _rf: &RibbonFilterState, _pc: &PaneControlState, _k: &str, d: &[u8], inv: &mut Transaction) { apply_pivot_create_restore(s, p, d, inv); }
fn r_pivot_delete(s: &AppState, p: &PivotState, _sl: &SlicerState, rf: &RibbonFilterState, pc: &PaneControlState, _k: &str, d: &[u8], inv: &mut Transaction) { apply_pivot_delete_restore(s, p, rf, pc, d, inv); }
fn r_slicer(_s: &AppState, _p: &PivotState, sl: &SlicerState, _rf: &RibbonFilterState, _pc: &PaneControlState, _k: &str, d: &[u8], inv: &mut Transaction) { apply_slicer_restore(sl, d, inv); }
fn r_slicer_create(_s: &AppState, _p: &PivotState, sl: &SlicerState, _rf: &RibbonFilterState, _pc: &PaneControlState, _k: &str, d: &[u8], inv: &mut Transaction) { apply_slicer_create_restore(sl, d, inv); }
fn r_slicer_delete(_s: &AppState, _p: &PivotState, sl: &SlicerState, _rf: &RibbonFilterState, _pc: &PaneControlState, _k: &str, d: &[u8], inv: &mut Transaction) { apply_slicer_delete_restore(sl, d, inv); }
fn r_ribbon_filter(_s: &AppState, _p: &PivotState, _sl: &SlicerState, rf: &RibbonFilterState, _pc: &PaneControlState, _k: &str, d: &[u8], inv: &mut Transaction) { apply_ribbon_filter_restore(rf, d, inv); }
fn r_ribbon_filter_create(_s: &AppState, _p: &PivotState, _sl: &SlicerState, rf: &RibbonFilterState, _pc: &PaneControlState, _k: &str, d: &[u8], inv: &mut Transaction) { apply_ribbon_filter_create_restore(rf, d, inv); }
fn r_ribbon_filter_delete(_s: &AppState, _p: &PivotState, _sl: &SlicerState, rf: &RibbonFilterState, _pc: &PaneControlState, _k: &str, d: &[u8], inv: &mut Transaction) { apply_ribbon_filter_delete_restore(rf, d, inv); }
fn r_pane_control(_s: &AppState, _p: &PivotState, _sl: &SlicerState, _rf: &RibbonFilterState, pc: &PaneControlState, _k: &str, d: &[u8], inv: &mut Transaction) { apply_pane_control_restore(pc, d, inv); }
fn r_pane_control_create(_s: &AppState, _p: &PivotState, _sl: &SlicerState, _rf: &RibbonFilterState, pc: &PaneControlState, _k: &str, d: &[u8], inv: &mut Transaction) { apply_pane_control_create_restore(pc, d, inv); }
fn r_pane_control_delete(_s: &AppState, _p: &PivotState, _sl: &SlicerState, _rf: &RibbonFilterState, pc: &PaneControlState, _k: &str, d: &[u8], inv: &mut Transaction) { apply_pane_control_delete_restore(pc, d, inv); }
fn r_object_swap(s: &AppState, _p: &PivotState, _sl: &SlicerState, _rf: &RibbonFilterState, _pc: &PaneControlState, k: &str, d: &[u8], inv: &mut Transaction) { apply_object_swap_restore(s, k, d, inv); }
fn r_script_grid_cells(s: &AppState, _p: &PivotState, _sl: &SlicerState, _rf: &RibbonFilterState, _pc: &PaneControlState, _k: &str, d: &[u8], inv: &mut Transaction) { apply_script_grid_cells_restore(s, d, inv); }
fn r_report_restore(s: &AppState, _p: &PivotState, _sl: &SlicerState, _rf: &RibbonFilterState, _pc: &PaneControlState, _k: &str, d: &[u8], inv: &mut Transaction) { apply_report_restore(s, d, inv); }
fn r_calp_reset(s: &AppState, _p: &PivotState, _sl: &SlicerState, _rf: &RibbonFilterState, _pc: &PaneControlState, _k: &str, d: &[u8], inv: &mut Transaction) { apply_calp_reset_restore(s, d, inv); }

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
    m.insert("pane_control", RestoreSpec { restore: r_pane_control, change_class: PaneControl, defer: true });
    m.insert("pane_control_create", RestoreSpec { restore: r_pane_control_create, change_class: PaneControl, defer: true });
    m.insert("pane_control_delete", RestoreSpec { restore: r_pane_control_delete, change_class: PaneControl, defer: true });
    for k in [
        "obj_chart", "obj_sparklines", "obj_table", "obj_autofilter",
        "obj_validation", "obj_named_range", "obj_freeze", "obj_extension_data",
        "obj_cell_types", "obj_cell_behaviors", "obj_writeback_regions",
        "obj_object_scripts",
        // Per-sheet cell-keyed stores moved by a structural edit.
        "obj_comments", "obj_notes", "obj_hyperlinks",
        "obj_conditional_formats", "obj_sheet_protection", "obj_sheet_protection_record",
        "obj_coord_stores", "obj_named_ranges", "obj_range_strings",
        "obj_cross_sheet_formulas", "obj_controls", "obj_style_tiers",
        "obj_workbook_protection",
    ] {
        m.insert(k, RestoreSpec { restore: r_object_swap, change_class: Objects, defer: true });
    }
    // Off-active-sheet cell writes from a script / AI tool (apply_script_modified_grids).
    // Deferred: re-acquires the grid/grids/active-sheet locks (released by the time
    // deferred restores run). Tagged Objects so the frontend fires grid:refresh on
    // undo/redo (re-fetches the active viewport when the restored sheet IS active;
    // a non-active restored sheet re-materializes from grids[idx] on sheet switch).
    m.insert("script_grid_cells", RestoreSpec { restore: r_script_grid_cells, change_class: Objects, defer: true });
    // Grid reports: cell-based restore of the report cells + definitions + region.
    // Tagged Objects so the frontend fires grid:refresh on undo/redo.
    m.insert("report_restore", RestoreSpec { restore: r_report_restore, change_class: Objects, defer: true });
    // Subscription reset: whole-sheet swap (cells/widths/heights/merges) +
    // override-layer swap for the reset sheets. Deferred (re-acquires grid
    // locks); tagged Objects so the frontend fires grid:refresh on undo/redo.
    m.insert("calp_reset", RestoreSpec { restore: r_calp_reset, change_class: Objects, defer: true });
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
    pane_control_changed: &mut bool,
    objects_changed: &mut bool,
) {
    match class {
        CustomRestoreKind::Pivot => *pivot_changed = true,
        CustomRestoreKind::Slicer => *slicer_changed = true,
        CustomRestoreKind::RibbonFilter => *ribbon_filter_changed = true,
        CustomRestoreKind::PaneControl => *pane_control_changed = true,
        CustomRestoreKind::Objects => *objects_changed = true,
        CustomRestoreKind::Other => {}
    }
}

/// Serialized payload for the `"script_grid_cells"` CustomRestore — an
/// off-active-sheet cell write made by a script / AI tool. Produced by
/// `scripting::commands::apply_script_modified_grids` and consumed here. Each
/// entry carries the full prior `Cell` (incl. its cached value), so restoring is
/// exact and needs NO recalc; `None` means the cell was empty before.
#[derive(serde::Deserialize, serde::Serialize)]
pub(crate) struct ScriptGridCellsSnapshot {
    pub sheet_index: usize,
    pub cells: Vec<(u32, u32, Option<engine::Cell>)>,
}

/// Restore (undo/redo) an off-active-sheet script/AI cell write.
///
/// Writes each captured cell back into `grids[sheet_index]` (and the active
/// mirror when that sheet happens to be active at undo time), capturing the
/// CURRENT cells as the symmetric inverse so redo re-applies the post-write
/// state. No recalc is needed: each restored `Cell` already carries its cached
/// value. Lock order matches `recalculate_sheet_values` (grid → grids →
/// active_sheet) to stay deadlock-consistent.
fn apply_script_grid_cells_restore(
    state: &AppState,
    data: &[u8],
    inverse_transaction: &mut Transaction,
) {
    let snapshot: ScriptGridCellsSnapshot = match serde_json::from_slice(data) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("[undo] Failed to deserialize script_grid_cells snapshot: {}", e);
            return;
        }
    };

    let mut mirror = state.grid.lock().unwrap();
    let mut grids = state.grids.lock().unwrap();
    let active_sheet = *state.active_sheet.lock().unwrap();

    if snapshot.sheet_index >= grids.len() {
        return;
    }
    let is_active = snapshot.sheet_index == active_sheet;

    let mut inverse_cells: Vec<(u32, u32, Option<engine::Cell>)> =
        Vec::with_capacity(snapshot.cells.len());
    for (row, col, restore_to) in &snapshot.cells {
        // Capture current for the inverse (redo restores the post-write state).
        let current = grids[snapshot.sheet_index].get_cell(*row, *col).cloned();
        inverse_cells.push((*row, *col, current));

        match restore_to {
            Some(cell) => {
                grids[snapshot.sheet_index].set_cell(*row, *col, cell.clone());
                if is_active {
                    mirror.set_cell(*row, *col, cell.clone());
                }
            }
            None => {
                grids[snapshot.sheet_index].clear_cell(*row, *col);
                if is_active {
                    mirror.clear_cell(*row, *col);
                }
            }
        }
    }

    drop(grids);
    drop(mirror);

    inverse_transaction.add_change(CellChange::CustomRestore {
        kind: "script_grid_cells".to_string(),
        data: serde_json::to_vec(&ScriptGridCellsSnapshot {
            sheet_index: snapshot.sheet_index,
            cells: inverse_cells,
        })
        .unwrap_or_default(),
    });
}

/// Restore a grid-report snapshot for undo/redo: restore the affected cells, the
/// report-definitions list, and each report's protected region, then record the
/// current state as the inverse (redo). Cell-based (mirrors script_grid_cells),
/// so it works offline without re-running the design query.
fn apply_report_restore(
    state: &AppState,
    data: &[u8],
    inverse_transaction: &mut Transaction,
) {
    let snapshot: crate::report::ReportUndoSnapshot = match serde_json::from_slice(data) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("[undo] Failed to deserialize report snapshot: {}", e);
            return;
        }
    };

    // --- Restore grid cells (capture current for the inverse/redo) ---
    let mut inverse_cells: Vec<(u32, u32, Option<engine::Cell>)> =
        Vec::with_capacity(snapshot.cells.len());
    {
        let mut mirror = state.grid.lock().unwrap();
        let mut grids = state.grids.lock().unwrap();
        let active_sheet = *state.active_sheet.lock().unwrap();
        if snapshot.sheet_index < grids.len() {
            let is_active = snapshot.sheet_index == active_sheet;
            for (row, col, restore_to) in &snapshot.cells {
                let current = grids[snapshot.sheet_index].get_cell(*row, *col).cloned();
                inverse_cells.push((*row, *col, current));
                match restore_to {
                    Some(cell) => {
                        grids[snapshot.sheet_index].set_cell(*row, *col, cell.clone());
                        if is_active {
                            mirror.set_cell(*row, *col, cell.clone());
                        }
                    }
                    None => {
                        grids[snapshot.sheet_index].clear_cell(*row, *col);
                        if is_active {
                            mirror.clear_cell(*row, *col);
                        }
                    }
                }
            }
            if is_active {
                mirror.recalculate_bounds();
            }
        }
    }

    // --- Restore merged regions inside the box (capture current for redo) ---
    // The snapshot carries the box's merges as they were (report header merges
    // + any pre-existing user merges); swap them in on the REPORT'S sheet (the
    // per-sheet store when it isn't the active one).
    let mut inverse_merges: Vec<crate::MergedRegion> = Vec::new();
    if let (Some(first), Some(last)) = (snapshot.cells.first(), snapshot.cells.last()) {
        let (sr, sc, er, ec) = (first.0, first.1, last.0, last.1);
        crate::report::with_sheet_merges(state, snapshot.sheet_index, |merged| {
            inverse_merges = merged
                .iter()
                .filter(|m| m.start_row >= sr && m.end_row <= er && m.start_col >= sc && m.end_col <= ec)
                .cloned()
                .collect();
            merged.retain(|m| {
                !(m.start_row >= sr && m.end_row <= er && m.start_col >= sc && m.end_col <= ec)
            });
            for m in &snapshot.merges {
                merged.insert(m.clone());
            }
        });
    }

    // --- Restore report definitions + regions (capture current for redo) ---
    let current_defs = state.report_definitions.lock().unwrap().clone();
    *state.report_definitions.lock().unwrap() = snapshot.definitions.clone();
    {
        let mut regions = state.protected_regions.lock().unwrap();
        regions.retain(|r| r.region_type != "report");
    }
    for r in &snapshot.definitions {
        crate::report::reregister_report_region(state, r);
    }
    crate::report::sync_reports_to_extension_data(state);

    inverse_transaction.add_change(CellChange::CustomRestore {
        kind: "report_restore".to_string(),
        data: serde_json::to_vec(&crate::report::ReportUndoSnapshot {
            sheet_index: snapshot.sheet_index,
            cells: inverse_cells,
            definitions: current_defs,
            merges: inverse_merges,
        })
        .unwrap_or_default(),
    });
}

/// Restore a subscription-reset snapshot for undo/redo: swap every affected
/// sheet's FULL content (cells, widths, heights, merges) and the override
/// layer's entries for those sheets back to the snapshot, capturing the
/// then-current state as the symmetric inverse. Whole-sheet swaps (unlike the
/// box-scoped report restore) because a reset replaces the entire sheet.
/// Cells carry their cached values, so no recalc of the restored cells is
/// needed; dependency maps are rebuilt when the active sheet was swapped.
fn apply_calp_reset_restore(
    state: &AppState,
    data: &[u8],
    inverse_transaction: &mut Transaction,
) {
    use crate::calp_commands::{CalpResetSheetSnapshot, CalpResetSnapshot};

    let snapshot: CalpResetSnapshot = match serde_json::from_slice(data) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("[undo] Failed to deserialize calp_reset snapshot: {}", e);
            return;
        }
    };

    let mut inverse_sheets: Vec<CalpResetSheetSnapshot> = Vec::with_capacity(snapshot.sheets.len());
    let mut active_affected = false;

    for sheet in &snapshot.sheets {
        let idx = sheet.sheet_index;

        // --- Cells + widths/heights (locks scoped per sheet, in the
        // set_active_sheet canonical order: grids, active_sheet, grid mirror,
        // column_widths, row_heights, all_cw, all_rh). The ACTIVE sheet's
        // widths/heights live in the MIRRORS (take-semantics) — capture and
        // restore through them for that sheet.
        let mut inverse = {
            let mut grids = state.grids.lock().unwrap();
            let active = *state.active_sheet.lock().unwrap();
            let mut mirror = state.grid.lock().unwrap();
            let mut mirror_cw = state.column_widths.lock().unwrap();
            let mut mirror_rh = state.row_heights.lock().unwrap();
            let mut all_cw = state.all_column_widths.lock().unwrap();
            let mut all_rh = state.all_row_heights.lock().unwrap();
            if idx >= grids.len() {
                continue;
            }
            let is_active = idx == active;

            let inverse = CalpResetSheetSnapshot {
                sheet_index: idx,
                cells: grids[idx]
                    .cells
                    .iter()
                    .map(|(k, c)| (k.0, k.1, c.clone()))
                    .collect(),
                column_widths: if is_active {
                    mirror_cw.clone()
                } else {
                    all_cw.get(idx).cloned().unwrap_or_default()
                },
                row_heights: if is_active {
                    mirror_rh.clone()
                } else {
                    all_rh.get(idx).cloned().unwrap_or_default()
                },
                merges: Vec::new(), // filled in the merge pass below
            };

            let mut restored = engine::Grid::new();
            for (row, col, cell) in &sheet.cells {
                restored.set_cell(*row, *col, cell.clone());
            }
            grids[idx] = restored;
            if idx < all_cw.len() {
                all_cw[idx] = sheet.column_widths.clone();
            }
            if idx < all_rh.len() {
                all_rh[idx] = sheet.row_heights.clone();
            }
            if is_active {
                *mirror = grids[idx].clone();
                *mirror_cw = sheet.column_widths.clone();
                *mirror_rh = sheet.row_heights.clone();
                active_affected = true;
            }
            inverse
        };

        // --- Merges (own lock scope via with_sheet_merges) ---
        inverse.merges = crate::report::with_sheet_merges(state, idx, |merged| {
            let prev: Vec<crate::MergedRegion> = merged.iter().cloned().collect();
            *merged = sheet.merges.iter().cloned().collect();
            prev
        });

        inverse_sheets.push(inverse);
    }

    // --- Override layer: swap the affected sheets' entries ---
    let inverse_overrides = {
        let mut layer = state.override_layer.lock().unwrap();
        let affected: std::collections::HashSet<_> =
            snapshot.override_sheet_ids.iter().cloned().collect();
        let current: Vec<calp::CellOverride> = layer
            .overrides
            .iter()
            .filter(|o| affected.contains(&o.sheet_id))
            .cloned()
            .collect();
        layer.overrides.retain(|o| !affected.contains(&o.sheet_id));
        layer.overrides.extend(snapshot.overrides.iter().cloned());
        current
    };

    if active_affected {
        rebuild_all_dependencies(state);
    }

    inverse_transaction.add_change(CellChange::CustomRestore {
        kind: "calp_reset".to_string(),
        data: serde_json::to_vec(&CalpResetSnapshot {
            sheets: inverse_sheets,
            override_sheet_ids: snapshot.override_sheet_ids.clone(),
            overrides: inverse_overrides,
        })
        .unwrap_or_default(),
    });
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
    user_files_state: State<'_, UserFilesState>,
    pivot_state: State<'_, PivotState>,
    slicer_state: State<'_, SlicerState>,
    ribbon_filter_state: State<'_, RibbonFilterState>,
    pane_control_state: State<'_, PaneControlState>,
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
                    pane_control_changed: false,
                    objects_changed: false,
                };
            }
        }
    };

    apply_changes(&state, &file_state, &user_files_state, &pivot_state, &slicer_state, &ribbon_filter_state, &pane_control_state, transaction, true)
}

/// Perform redo operation.
#[tauri::command]
pub fn redo(
    state: State<AppState>,
    file_state: State<FileState>,
    user_files_state: State<'_, UserFilesState>,
    pivot_state: State<'_, PivotState>,
    slicer_state: State<'_, SlicerState>,
    ribbon_filter_state: State<'_, RibbonFilterState>,
    pane_control_state: State<'_, PaneControlState>,
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
                    pane_control_changed: false,
                    objects_changed: false,
                };
            }
        }
    };

    apply_changes(&state, &file_state, &user_files_state, &pivot_state, &slicer_state, &ribbon_filter_state, &pane_control_state, transaction, false)
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
    ribbon_filter_state: &RibbonFilterState,
    pane_control_state: &PaneControlState,
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
        finalize_pivot_update(state, pivot_state, pivot_id, dest_sheet_idx, destination, &view, Some((pane_control_state, ribbon_filter_state)));

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
    ribbon_filter_state: &RibbonFilterState,
    pane_control_state: &PaneControlState,
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
    finalize_pivot_update(state, pivot_state, pivot_id, dest_sheet_idx, destination, &view, Some((pane_control_state, ribbon_filter_state)));
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
// PANE CONTROL UNDO/REDO HANDLERS (mirror the ribbon filter handlers)
// ============================================================================

/// Snapshot of a pane control for property/value undo.
#[derive(serde::Serialize, serde::Deserialize)]
struct PaneControlSnapshot {
    control_id: identity::EntityId,
    previous: PaneControl,
}

/// Snapshot for pane control creation undo (undo = delete).
#[derive(serde::Serialize, serde::Deserialize)]
struct PaneControlCreateSnapshot {
    control_id: identity::EntityId,
}

/// Restore a pane control's previous state (properties/value).
fn apply_pane_control_restore(
    pane_control_state: &PaneControlState,
    data: &[u8],
    inverse_transaction: &mut Transaction,
) {
    let snapshot: PaneControlSnapshot = match serde_json::from_slice(data) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("[undo] Failed to deserialize pane control snapshot: {}", e);
            return;
        }
    };

    let mut controls = pane_control_state.controls.lock().unwrap();
    if let Some(control) = controls.get_mut(&snapshot.control_id) {
        // Save current state for inverse
        let inverse_snapshot = PaneControlSnapshot {
            control_id: snapshot.control_id,
            previous: control.clone(),
        };
        let inverse_data = serde_json::to_vec(&inverse_snapshot).unwrap_or_default();
        inverse_transaction.add_change(CellChange::CustomRestore {
            kind: "pane_control".to_string(),
            data: inverse_data,
        });

        // Restore previous state
        *control = snapshot.previous;
    }
}

/// Undo pane control creation: remove the control.
fn apply_pane_control_create_restore(
    pane_control_state: &PaneControlState,
    data: &[u8],
    inverse_transaction: &mut Transaction,
) {
    let snapshot: PaneControlCreateSnapshot = match serde_json::from_slice(data) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("[undo] Failed to deserialize pane control create snapshot: {}", e);
            return;
        }
    };

    let mut controls = pane_control_state.controls.lock().unwrap();
    if let Some(control) = controls.remove(&snapshot.control_id) {
        let redo_snapshot = PaneControlSnapshot {
            control_id: snapshot.control_id,
            previous: control,
        };
        let redo_data = serde_json::to_vec(&redo_snapshot).unwrap_or_default();
        inverse_transaction.add_change(CellChange::CustomRestore {
            kind: "pane_control_delete".to_string(),
            data: redo_data,
        });
    }
}

/// Undo pane control deletion: re-create the control from snapshot.
fn apply_pane_control_delete_restore(
    pane_control_state: &PaneControlState,
    data: &[u8],
    inverse_transaction: &mut Transaction,
) {
    let snapshot: PaneControlSnapshot = match serde_json::from_slice(data) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("[undo] Failed to deserialize pane control delete snapshot: {}", e);
            return;
        }
    };

    let redo_snapshot = PaneControlCreateSnapshot {
        control_id: snapshot.control_id,
    };
    let redo_data = serde_json::to_vec(&redo_snapshot).unwrap_or_default();
    inverse_transaction.add_change(CellChange::CustomRestore {
        kind: "pane_control_create".to_string(),
        data: redo_data,
    });

    let mut controls = pane_control_state.controls.lock().unwrap();
    controls.insert(snapshot.control_id, snapshot.previous);
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

/// Serialized "obj_validation" snapshot bytes for callers recording into an
/// already-open transaction (same contract as `cell_types_snapshot_bytes`).
pub(crate) fn validation_snapshot_bytes(
    sheet_index: usize,
    previous: Vec<crate::data_validation::ValidationRange>,
) -> Vec<u8> {
    serde_json::to_vec(&ValidationObjSnapshot { sheet_index, previous }).unwrap_or_default()
}

/// Snapshot for the "obj_sheet_protection" CustomRestore — one sheet's
/// allow-edit ranges before the mutation.
///
/// Scoped to `allow_edit_ranges` ONLY, deliberately — this is the inverse of a
/// structural shift, which moves rectangles and touches nothing else. Widening
/// it to the whole record would make undo of a row insert also revert whatever
/// `protect_sheet` / `unprotect_sheet` / `update_protection_options` did
/// afterwards, silently unprotecting the sheet and dropping its password hash.
/// (Those commands are undoable now, via the separate whole-record
/// `obj_sheet_protection_record` kind below, so they would at least be on the
/// stack — but they are still SEPARATE user actions, and one Ctrl+Z must not
/// undo two of them.)
///
/// Restoring only the ranges is safe precisely because each `AllowEditRange`
/// carries its OWN `password_hash`/`password_salt` — a range resurrected from
/// this Vec comes back with its gate intact, so who-can-edit-what is preserved
/// exactly without touching sheet-level state the shift never mutated.
#[derive(serde::Serialize, serde::Deserialize)]
struct SheetProtectionObjSnapshot {
    sheet_index: usize,
    previous_ranges: Vec<crate::protection::AllowEditRange>,
}

/// Serialized "obj_sheet_protection" snapshot bytes (in-open-transaction
/// contract, as for `cell_types_snapshot_bytes`).
pub(crate) fn sheet_protection_snapshot_bytes(
    sheet_index: usize,
    previous_ranges: Vec<crate::protection::AllowEditRange>,
) -> Vec<u8> {
    serde_json::to_vec(&SheetProtectionObjSnapshot { sheet_index, previous_ranges })
        .unwrap_or_default()
}

/// Snapshot for the "obj_sheet_protection_record" CustomRestore — one sheet's
/// WHOLE protection record before the mutation. `None` = the sheet had no
/// record at all, so undo must remove the key rather than leave a default one.
///
/// Deliberately distinct from `obj_sheet_protection` above, which is scoped to
/// `allow_edit_ranges`. Each kind is the exact inverse of one mutation:
/// the structural shift only moves rectangles, whereas `protect_sheet` /
/// `unprotect_sheet` / `update_protection_options` change sheet-level fields
/// and must be able to put the password hash and salt back.
#[derive(serde::Serialize, serde::Deserialize)]
struct SheetProtectionRecordSnapshot {
    sheet_index: usize,
    previous: Option<crate::protection::SheetProtection>,
}

/// Record undo for a command that replaces a sheet's whole protection record.
///
/// Call AFTER dropping the `sheet_protection` guard — this takes the undo-stack
/// lock, and `record_object_undo` opens its own transaction when none is open.
pub(crate) fn record_sheet_protection_record_undo(
    state: &AppState,
    sheet_index: usize,
    previous: Option<crate::protection::SheetProtection>,
    description: &str,
) {
    let data = serde_json::to_vec(&SheetProtectionRecordSnapshot { sheet_index, previous })
        .unwrap_or_default();
    record_object_undo(state, "obj_sheet_protection_record", data, description);
}

/// Snapshot for the "obj_conditional_formats" CustomRestore — one sheet's whole
/// rule list before the mutation.
///
/// Whole-sheet Vec swap because the Vec ORDER is evaluation semantics
/// (`priority` ordering, and `stop_if_true` breaks the loop), so restoring
/// rules individually could not reproduce it.
///
/// This is the FIRST undo entry conditional formatting has ever had — the CF
/// commands themselves record none (tracked as BUG-0020). It exists so a
/// structural shift of rule ranges is undoable; it does not make add/update/
/// delete undoable.
#[derive(serde::Serialize, serde::Deserialize)]
struct ConditionalFormatsObjSnapshot {
    sheet_index: usize,
    previous: Vec<crate::conditional_formatting::ConditionalFormatDefinition>,
}

/// Serialized "obj_conditional_formats" snapshot bytes (in-open-transaction
/// contract, as above).
pub(crate) fn conditional_formats_snapshot_bytes(
    sheet_index: usize,
    previous: Vec<crate::conditional_formatting::ConditionalFormatDefinition>,
) -> Vec<u8> {
    serde_json::to_vec(&ConditionalFormatsObjSnapshot { sheet_index, previous })
        .unwrap_or_default()
}

/// Snapshot for the "obj_cell_types" CustomRestore — every cell-type
/// assignment on one sheet BEFORE the mutation; restore swaps the sheet's
/// assignments wholesale (same shape as obj_validation).
#[derive(serde::Serialize, serde::Deserialize)]
struct CellTypesObjSnapshot {
    sheet_index: usize,
    previous: Vec<crate::cell_types::CellTypeEntry>,
}

/// Serialized "obj_cell_types" snapshot bytes for callers that record into an
/// already-open transaction themselves. The structure commands hold the
/// undo-stack lock while shifting, so they cannot go through
/// record_cell_types_undo (it re-locks the stack); they call
/// `undo_stack.record_custom_restore("obj_cell_types", bytes, …)` directly,
/// which is what makes grid + assignment restore a single undo step.
pub(crate) fn cell_types_snapshot_bytes(
    sheet_index: usize,
    previous: Vec<crate::cell_types::CellTypeEntry>,
) -> Vec<u8> {
    serde_json::to_vec(&CellTypesObjSnapshot { sheet_index, previous }).unwrap_or_default()
}

/// Snapshot for the "obj_cell_behaviors" CustomRestore — the WHOLE binding
/// store before the mutation (bindings are workbook-level and few; a
/// whole-store swap keeps restore trivially correct).
#[derive(serde::Serialize, serde::Deserialize)]
struct CellBehaviorsObjSnapshot {
    previous: Vec<crate::cell_behaviors::CellBehaviorBinding>,
}

/// Serialized "obj_cell_behaviors" snapshot bytes (same in-open-transaction
/// contract as cell_types_snapshot_bytes).
pub(crate) fn cell_behaviors_snapshot_bytes(
    previous: Vec<crate::cell_behaviors::CellBehaviorBinding>,
) -> Vec<u8> {
    serde_json::to_vec(&CellBehaviorsObjSnapshot { previous }).unwrap_or_default()
}

/// Snapshot of ONE sheet's cell-keyed store, for the structural-shift restores.
///
/// Generic because comments, notes, hyperlinks and cell protection all share
/// the `HashMap<sheet, HashMap<(row, col), T>>` shape — a structural edit moves
/// every entry on the sheet at once, so a per-cell restore (the existing
/// "comment"/"note"/"hyperlink" kinds) cannot express it.
///
/// `previous` is a Vec of pairs rather than a map because JSON object keys must
/// be strings and these are `(u32, u32)` tuples.
#[derive(serde::Serialize, serde::Deserialize)]
struct SheetCellMapSnapshot<T> {
    sheet_index: usize,
    previous: Vec<((u32, u32), T)>,
}

/// Serialize one sheet's cell-keyed store for an in-open-transaction restore
/// (same contract as `cell_types_snapshot_bytes`).
pub(crate) fn sheet_cell_map_snapshot_bytes<T: serde::Serialize>(
    sheet_index: usize,
    previous: Vec<((u32, u32), T)>,
) -> Vec<u8> {
    serde_json::to_vec(&SheetCellMapSnapshot { sheet_index, previous }).unwrap_or_default()
}

/// Snapshot for the "obj_workbook_protection" CustomRestore — the whole
/// workbook-protection record before the mutation.
///
/// Whole-record here IS correct, unlike the sheet-level case: this store has
/// exactly two writers (`protect_workbook` / `unprotect_workbook`), both of
/// which now record undo, so no untracked field can be newer than the snapshot.
#[derive(serde::Serialize, serde::Deserialize)]
struct WorkbookProtectionObjSnapshot {
    previous: crate::protection::WorkbookProtection,
}

/// Record undo for a workbook-protection mutation.
///
/// Call AFTER dropping the `workbook_protection` guard.
pub(crate) fn record_workbook_protection_undo(
    state: &AppState,
    previous: crate::protection::WorkbookProtection,
    description: &str,
) {
    let data = serde_json::to_vec(&WorkbookProtectionObjSnapshot { previous }).unwrap_or_default();
    record_object_undo(state, "obj_workbook_protection", data, description);
}

/// Swap one sheet's cell-keyed store with a snapshot, pushing the CURRENT
/// contents as the symmetric inverse so redo re-applies the shift.
fn apply_sheet_cell_map_restore<T>(
    store: &mut HashMap<usize, HashMap<(u32, u32), T>>,
    kind: &str,
    data: &[u8],
    inverse_transaction: &mut Transaction,
) where
    T: serde::Serialize + serde::de::DeserializeOwned,
{
    let snap: SheetCellMapSnapshot<T> = match serde_json::from_slice(data) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("[undo] bad {} snapshot: {}", kind, e);
            return;
        }
    };
    let current: Vec<((u32, u32), T)> = store
        .remove(&snap.sheet_index)
        .map(|m| m.into_iter().collect())
        .unwrap_or_default();
    push_obj_inverse(
        inverse_transaction,
        kind,
        &SheetCellMapSnapshot { sheet_index: snap.sheet_index, previous: current },
    );
    store.insert(snap.sheet_index, snap.previous.into_iter().collect());
}

/// Snapshot for the "obj_object_scripts" CustomRestore — the WHOLE object-script
/// list before a mutation.
///
/// Whole-list swap for the same reason as cell behaviors: scripts are
/// workbook-level and few, and deleting one object can prune several at once.
/// Exists so `delete_table`'s script pruning is undoable — restoring a table
/// whose scripts stayed deleted is a half-undo.
#[derive(serde::Serialize, serde::Deserialize)]
struct ObjectScriptsObjSnapshot {
    previous: Vec<::persistence::SavedObjectScript>,
}

/// Serialized "obj_object_scripts" snapshot bytes (same in-open-transaction
/// contract as cell_types_snapshot_bytes).
pub(crate) fn object_scripts_snapshot_bytes(
    previous: Vec<::persistence::SavedObjectScript>,
) -> Vec<u8> {
    serde_json::to_vec(&ObjectScriptsObjSnapshot { previous }).unwrap_or_default()
}

/// Serialized "obj_table" snapshot bytes, for callers recording several
/// restores into one already-open transaction (see `delete_table`, which must
/// undo its cell rewrite, filter removal and script pruning together with the
/// table itself).
pub(crate) fn table_snapshot_bytes(
    sheet_index: usize,
    table_id: identity::EntityId,
    previous: Option<crate::tables::Table>,
) -> Vec<u8> {
    serde_json::to_vec(&TableObjSnapshot { sheet_index, table_id, previous }).unwrap_or_default()
}

/// Serialized "obj_autofilter" snapshot bytes (same in-open-transaction
/// contract as `table_snapshot_bytes`).
pub(crate) fn autofilter_snapshot_bytes(
    sheet_index: usize,
    previous: Option<crate::autofilter::AutoFilter>,
) -> Vec<u8> {
    serde_json::to_vec(&AutoFilterObjSnapshot { sheet_index, previous }).unwrap_or_default()
}

/// Serialized "script_grid_cells" snapshot bytes (same in-open-transaction
/// contract as `table_snapshot_bytes`).
pub(crate) fn script_grid_cells_snapshot_bytes(
    sheet_index: usize,
    cells: Vec<(u32, u32, Option<engine::Cell>)>,
) -> Vec<u8> {
    serde_json::to_vec(&ScriptGridCellsSnapshot { sheet_index, cells }).unwrap_or_default()
}

/// Snapshot for the "obj_writeback_regions" CustomRestore — the author-side
/// draft region list before a structural shift, plus the ids that shift
/// dropped.
///
/// Applied as a SELECTOR MERGE rather than a whole-list swap: restore puts back
/// the geometry of regions that still exist and resurrects only the ids the
/// shift itself dropped. A whole-list swap would also roll back schema/policy
/// edits made after the structural edit (those commands record no undo entry of
/// their own), and would resurrect regions the author deliberately removed
/// later. Undoing an insert should undo the insert's effect on geometry —
/// nothing else.
#[derive(serde::Serialize, serde::Deserialize)]
struct WritebackRegionsObjSnapshot {
    /// Regions as they were: restore each one's SELECTOR if it still exists.
    previous: Vec<calp::WritebackRegionDeclaration>,
    /// Ids that may be re-inserted from `previous` when currently absent —
    /// exactly the ones the shift dropped, so a region the author deleted for
    /// their own reasons afterwards is not resurrected behind their back.
    #[serde(default)]
    resurrect_ids: Vec<String>,
    /// Ids to delete if present. Empty when recording the forward shift; the
    /// inverse uses it so REDO can re-drop what undo resurrected.
    #[serde(default)]
    remove_ids: Vec<String>,
}

/// Serialized "obj_writeback_regions" snapshot bytes (same in-open-transaction
/// contract as cell_types_snapshot_bytes). Without this, undoing an insert
/// would restore the grid but leave the shifted selectors behind —
/// reintroducing exactly the coordinate drift the shift exists to prevent.
pub(crate) fn writeback_regions_snapshot_bytes(
    previous: Vec<calp::WritebackRegionDeclaration>,
    dropped_ids: Vec<String>,
) -> Vec<u8> {
    serde_json::to_vec(&WritebackRegionsObjSnapshot {
        previous,
        resurrect_ids: dropped_ids,
        remove_ids: Vec::new(),
    })
    .unwrap_or_default()
}

/// Snapshot for the "obj_style_tiers" CustomRestore — one sheet's row OR column
/// style-tier entries before a mutation (set_cell_protection's whole-row/column
/// path). `previous` holds (index, prior style index); 0 means the tier was
/// absent, which `set_row_style`/`set_column_style` treat as "clear".
#[derive(serde::Serialize, serde::Deserialize)]
struct StyleTiersObjSnapshot {
    sheet_index: usize,
    is_column: bool,
    previous: Vec<(u32, usize)>,
}

/// Serialized "obj_style_tiers" snapshot bytes (in-open-transaction contract,
/// same as cell_types_snapshot_bytes — the caller holds the undo-stack lock).
pub(crate) fn style_tiers_snapshot_bytes(
    sheet_index: usize,
    is_column: bool,
    previous: Vec<(u32, usize)>,
) -> Vec<u8> {
    serde_json::to_vec(&StyleTiersObjSnapshot { sheet_index, is_column, previous })
        .unwrap_or_default()
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

/// Snapshot for the "obj_extension_data" CustomRestore — the prior JSON value of
/// one extension's persisted state (None = it had none). Used by the undoable
/// per-extension persistence path (set_extension_data_undoable).
#[derive(serde::Serialize, serde::Deserialize)]
struct ExtensionDataObjSnapshot {
    extension_id: String,
    previous: Option<serde_json::Value>,
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
        "obj_cell_types" => {
            let snap: CellTypesObjSnapshot = match serde_json::from_slice(data) {
                Ok(s) => s,
                Err(e) => { eprintln!("[undo] bad obj_cell_types snapshot: {}", e); return; }
            };
            let mut cell_types = state.cell_types.lock().unwrap();
            let current = crate::cell_types::entries_for_sheet(&cell_types, snap.sheet_index);
            push_obj_inverse(inverse_transaction, kind, &CellTypesObjSnapshot {
                sheet_index: snap.sheet_index,
                previous: current,
            });
            crate::cell_types::replace_sheet_entries(
                &mut cell_types,
                snap.sheet_index,
                snap.previous,
            );
        }
        "obj_cell_behaviors" => {
            let snap: CellBehaviorsObjSnapshot = match serde_json::from_slice(data) {
                Ok(s) => s,
                Err(e) => { eprintln!("[undo] bad obj_cell_behaviors snapshot: {}", e); return; }
            };
            let mut behaviors = state.cell_behaviors.lock().unwrap();
            let current = crate::cell_behaviors::all_bindings(&behaviors);
            push_obj_inverse(inverse_transaction, kind, &CellBehaviorsObjSnapshot {
                previous: current,
            });
            crate::cell_behaviors::replace_all(&mut behaviors, snap.previous);
        }
        "obj_sheet_protection" => {
            let snap: SheetProtectionObjSnapshot = match serde_json::from_slice(data) {
                Ok(s) => s,
                Err(e) => { eprintln!("[undo] bad obj_sheet_protection snapshot: {}", e); return; }
            };
            let mut store = state.sheet_protection.lock().unwrap();
            // Swap ONLY allow_edit_ranges on the LIVE record; see the snapshot
            // struct's doc comment for why the rest must be left alone.
            let current = if store.contains_key(&snap.sheet_index) {
                let record = store.get_mut(&snap.sheet_index).unwrap();
                std::mem::replace(&mut record.allow_edit_ranges, snap.previous_ranges)
            } else if snap.previous_ranges.is_empty() {
                // No record and nothing to put back — don't materialize an empty
                // protection record as a side effect of undo.
                Vec::new()
            } else {
                let mut record = crate::protection::SheetProtection::default();
                record.allow_edit_ranges = snap.previous_ranges;
                store.insert(snap.sheet_index, record);
                Vec::new()
            };
            push_obj_inverse(inverse_transaction, kind, &SheetProtectionObjSnapshot {
                sheet_index: snap.sheet_index,
                previous_ranges: current,
            });
        }
        "obj_workbook_protection" => {
            let snap: WorkbookProtectionObjSnapshot = match serde_json::from_slice(data) {
                Ok(s) => s,
                Err(e) => { eprintln!("[undo] bad obj_workbook_protection snapshot: {}", e); return; }
            };
            let mut wb = state.workbook_protection.lock().unwrap();
            let current = wb.clone();
            *wb = snap.previous;
            push_obj_inverse(inverse_transaction, kind, &WorkbookProtectionObjSnapshot {
                previous: current,
            });
        }
        "obj_controls" => {
            let snap: ControlsObjSnapshot = match serde_json::from_slice(data) {
                Ok(s) => s,
                Err(e) => { eprintln!("[undo] bad obj_controls snapshot: {}", e); return; }
            };
            let current_controls: Vec<((usize, u32, u32), crate::controls::ControlMetadata)> = {
                let mut store = state.controls.lock().unwrap();
                let current = store.iter().map(|(k, v)| (*k, v.clone())).collect();
                store.clear();
                for (k, v) in snap.controls {
                    store.insert(k, v);
                }
                current
            };
            let current_ids = {
                let mut scripts = state.object_scripts.lock().unwrap();
                let mut prev = Vec::new();
                for (script_id, restore_to) in snap.script_instance_ids {
                    if let Some(script) = scripts.iter_mut().find(|s| s.id == script_id) {
                        prev.push((script_id, script.instance_id.clone()));
                        script.instance_id = restore_to;
                    }
                }
                prev
            };
            push_obj_inverse(inverse_transaction, kind, &ControlsObjSnapshot {
                controls: current_controls,
                script_instance_ids: current_ids,
            });
        }
        "obj_cross_sheet_formulas" => {
            let snap: CrossSheetFormulasObjSnapshot = match serde_json::from_slice(data) {
                Ok(s) => s,
                Err(e) => { eprintln!("[undo] bad obj_cross_sheet_formulas snapshot: {}", e); return; }
            };
            // Canonical lock order: grid (mirror) -> grids -> active_sheet,
            // same as r_script_grid_cells. The mirror write matters: the user
            // may have switched to the restored sheet since the edit, and
            // writing only grids[i] leaves the visible grid stale.
            let mut mirror = state.grid.lock().unwrap();
            let mut grids = state.grids.lock().unwrap();
            let active_sheet = *state.active_sheet.lock().unwrap();
            let is_active = snap.sheet_index == active_sheet;
            let mut current: Vec<((u32, u32), Option<engine::Cell>)> = Vec::new();
            if let Some(grid) = grids.get_mut(snap.sheet_index) {
                for ((row, col), restore_to) in &snap.previous {
                    current.push(((*row, *col), grid.get_cell(*row, *col).cloned()));
                    match restore_to {
                        Some(cell) => {
                            grid.set_cell(*row, *col, cell.clone());
                            if is_active {
                                mirror.set_cell(*row, *col, cell.clone());
                            }
                        }
                        None => {
                            grid.clear_cell(*row, *col);
                            if is_active {
                                mirror.clear_cell(*row, *col);
                            }
                        }
                    }
                }
            }
            push_obj_inverse(inverse_transaction, kind, &CrossSheetFormulasObjSnapshot {
                sheet_index: snap.sheet_index,
                previous: current,
            });
        }
        "obj_style_tiers" => {
            let snap: StyleTiersObjSnapshot = match serde_json::from_slice(data) {
                Ok(s) => s,
                Err(e) => { eprintln!("[undo] bad obj_style_tiers snapshot: {}", e); return; }
            };
            // Canonical lock order: grid (mirror) -> grids -> active_sheet.
            // Both mirrors, same as the forward path in set_cell_protection.
            let mut mirror = state.grid.lock().unwrap();
            let mut grids = state.grids.lock().unwrap();
            let active_sheet = *state.active_sheet.lock().unwrap();
            let is_active = snap.sheet_index == active_sheet;
            let mut current: Vec<(u32, usize)> = Vec::new();
            if let Some(grid) = grids.get_mut(snap.sheet_index) {
                for (idx, restore_to) in &snap.previous {
                    let existing = if snap.is_column {
                        grid.column_styles.get(idx).copied().unwrap_or(0)
                    } else {
                        grid.row_styles.get(idx).copied().unwrap_or(0)
                    };
                    current.push((*idx, existing));
                    if snap.is_column {
                        grid.set_column_style(*idx, *restore_to);
                        if is_active {
                            mirror.set_column_style(*idx, *restore_to);
                        }
                    } else {
                        grid.set_row_style(*idx, *restore_to);
                        if is_active {
                            mirror.set_row_style(*idx, *restore_to);
                        }
                    }
                }
            }
            push_obj_inverse(inverse_transaction, kind, &StyleTiersObjSnapshot {
                sheet_index: snap.sheet_index,
                is_column: snap.is_column,
                previous: current,
            });
        }
        "obj_range_strings" => {
            let snap: RangeStringsObjSnapshot = match serde_json::from_slice(data) {
                Ok(s) => s,
                Err(e) => { eprintln!("[undo] bad obj_range_strings snapshot: {}", e); return; }
            };
            let idx = snap.sheet_index;
            let cur_print = state.page_setups.lock().ok().and_then(|mut v| {
                let ps = v.get_mut(idx)?;
                let prev = ps.print_area.clone();
                ps.print_area = snap.print_area.clone().unwrap_or_default();
                Some(prev)
            });
            let cur_scroll = state.scroll_areas.lock().ok().and_then(|mut v| {
                let slot = v.get_mut(idx)?;
                let prev = slot.clone();
                *slot = snap.scroll_area.clone();
                Some(prev)
            }).flatten();
            push_obj_inverse(inverse_transaction, kind, &RangeStringsObjSnapshot {
                sheet_index: idx,
                print_area: cur_print,
                scroll_area: cur_scroll,
            });
        }
        "obj_named_ranges" => {
            let snap: NamedRangesObjSnapshot = match serde_json::from_slice(data) {
                Ok(s) => s,
                Err(e) => { eprintln!("[undo] bad obj_named_ranges snapshot: {}", e); return; }
            };
            let mut store = state.named_ranges.lock().unwrap();
            let current: Vec<(String, crate::named_ranges::NamedRange)> =
                store.iter().map(|(k, v)| (k.clone(), v.clone())).collect();
            store.clear();
            for (k, v) in snap.previous {
                store.insert(k, v);
            }
            push_obj_inverse(inverse_transaction, kind, &NamedRangesObjSnapshot { previous: current });
        }
        "obj_coord_stores" => {
            let snap: CoordStoresObjSnapshot = match serde_json::from_slice(data) {
                Ok(s) => s,
                Err(e) => { eprintln!("[undo] bad obj_coord_stores snapshot: {}", e); return; }
            };
            let idx = snap.sheet_index;
            // Swap each store, capturing the CURRENT value as the inverse so
            // redo re-applies the shift.
            let cur_outline = state.outlines.lock().ok().and_then(|mut m| {
                let prev = m.remove(&idx);
                if let Some(v) = snap.outline.clone() { m.insert(idx, v); }
                prev
            });
            let cur_scenarios = state.scenarios.lock().ok().and_then(|mut m| {
                let prev = m.remove(&idx);
                if let Some(v) = snap.scenarios.clone() { m.insert(idx, v); }
                prev
            });
            let cur_computed = state.computed_properties.lock().ok().and_then(|mut m| {
                let prev = m.remove(&idx);
                if let Some(v) = snap.computed.clone() { m.insert(idx, v); }
                prev
            });
            let cur_hidden = state.advanced_filter_hidden_rows.lock().ok().and_then(|mut m| {
                let prev = m.remove(&idx);
                if let Some(v) = snap.hidden_rows.clone() { m.insert(idx, v); }
                prev
            });
            push_obj_inverse(inverse_transaction, kind, &CoordStoresObjSnapshot {
                sheet_index: idx,
                outline: cur_outline,
                scenarios: cur_scenarios,
                computed: cur_computed,
                hidden_rows: cur_hidden,
            });
        }
        "obj_sheet_protection_record" => {
            let snap: SheetProtectionRecordSnapshot = match serde_json::from_slice(data) {
                Ok(s) => s,
                Err(e) => { eprintln!("[undo] bad obj_sheet_protection_record snapshot: {}", e); return; }
            };
            let mut store = state.sheet_protection.lock().unwrap();
            let current = store.remove(&snap.sheet_index);
            push_obj_inverse(inverse_transaction, kind, &SheetProtectionRecordSnapshot {
                sheet_index: snap.sheet_index,
                previous: current,
            });
            // Absent `previous` means the sheet had NO record — leave the key
            // removed rather than inserting a default one.
            if let Some(previous) = snap.previous {
                store.insert(snap.sheet_index, previous);
            }
        }
        "obj_conditional_formats" => {
            let snap: ConditionalFormatsObjSnapshot = match serde_json::from_slice(data) {
                Ok(s) => s,
                Err(e) => { eprintln!("[undo] bad obj_conditional_formats snapshot: {}", e); return; }
            };
            let mut store = state.conditional_formats.lock().unwrap();
            let current = store.remove(&snap.sheet_index).unwrap_or_default();
            push_obj_inverse(inverse_transaction, kind, &ConditionalFormatsObjSnapshot {
                sheet_index: snap.sheet_index,
                previous: current,
            });
            store.insert(snap.sheet_index, snap.previous);
        }
        "obj_comments" => {
            let mut store = state.comments.lock().unwrap();
            apply_sheet_cell_map_restore(&mut store, kind, data, inverse_transaction);
        }
        "obj_notes" => {
            let mut store = state.notes.lock().unwrap();
            apply_sheet_cell_map_restore(&mut store, kind, data, inverse_transaction);
        }
        "obj_hyperlinks" => {
            let mut store = state.hyperlinks.lock().unwrap();
            apply_sheet_cell_map_restore(&mut store, kind, data, inverse_transaction);
        }
        "obj_object_scripts" => {
            let snap: ObjectScriptsObjSnapshot = match serde_json::from_slice(data) {
                Ok(s) => s,
                Err(e) => { eprintln!("[undo] bad obj_object_scripts snapshot: {}", e); return; }
            };
            let mut scripts = state.object_scripts.lock().unwrap();
            let current = scripts.clone();
            push_obj_inverse(inverse_transaction, kind, &ObjectScriptsObjSnapshot {
                previous: current,
            });
            *scripts = snap.previous;
        }
        "obj_writeback_regions" => {
            let snap: WritebackRegionsObjSnapshot = match serde_json::from_slice(data) {
                Ok(s) => s,
                Err(e) => { eprintln!("[undo] bad obj_writeback_regions snapshot: {}", e); return; }
            };
            let mut regions = state.writeback_draft_regions.lock().unwrap();

            // What this apply is about to change, computed BEFORE mutating, so
            // the inverse is an exact mirror: whatever we insert, redo removes;
            // whatever we remove, redo re-inserts.
            let will_insert: Vec<String> = snap
                .previous
                .iter()
                .filter(|p| {
                    snap.resurrect_ids.contains(&p.id) && !regions.iter().any(|r| r.id == p.id)
                })
                .map(|p| p.id.clone())
                .collect();
            let will_remove: Vec<String> = snap
                .remove_ids
                .iter()
                .filter(|id| regions.iter().any(|r| r.id == **id))
                .cloned()
                .collect();
            push_obj_inverse(inverse_transaction, kind, &WritebackRegionsObjSnapshot {
                previous: regions.clone(),
                resurrect_ids: will_remove.clone(),
                remove_ids: will_insert.clone(),
            });

            // 1. Selector-only restore for regions that still exist, so later
            //    schema/policy edits on them survive the undo.
            for prev in &snap.previous {
                if let Some(cur) = regions.iter_mut().find(|r| r.id == prev.id) {
                    cur.selector = prev.selector.clone();
                }
            }
            // 2. Re-insert what this apply is allowed to resurrect, at roughly
            //    the original position.
            for (i, prev) in snap.previous.iter().enumerate() {
                if will_insert.contains(&prev.id) {
                    let at = i.min(regions.len());
                    regions.insert(at, prev.clone());
                }
            }
            // 3. Drop what the mirror direction had resurrected.
            if !will_remove.is_empty() {
                regions.retain(|r| !will_remove.contains(&r.id));
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
        "obj_extension_data" => {
            let snap: ExtensionDataObjSnapshot = match serde_json::from_slice(data) {
                Ok(s) => s,
                Err(e) => { eprintln!("[undo] bad obj_extension_data snapshot: {}", e); return; }
            };
            let mut ext_data = state.extension_data.lock().unwrap();
            let current = ext_data.remove(&snap.extension_id);
            push_obj_inverse(inverse_transaction, kind, &ExtensionDataObjSnapshot {
                extension_id: snap.extension_id.clone(),
                previous: current,
            });
            if let Some(prev) = snap.previous {
                ext_data.insert(snap.extension_id, prev);
            }
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

/// Record an undoable change to one extension's persisted state. `previous` is the
/// value BEFORE the mutation (None = it had none); restore swaps it back. Backs
/// the dedicated set_extension_data_undoable command (opt-in; the plain
/// set_extension_data stays non-undoable).
pub(crate) fn record_extension_data_undo(
    state: &AppState,
    extension_id: String,
    previous: Option<serde_json::Value>,
    description: &str,
) {
    let snap = ExtensionDataObjSnapshot { extension_id, previous };
    record_object_undo(state, "obj_extension_data", serde_json::to_vec(&snap).unwrap_or_default(), description);
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

pub(crate) fn record_cell_types_undo(
    state: &AppState,
    sheet_index: usize,
    previous: Vec<crate::cell_types::CellTypeEntry>,
    description: &str,
) {
    let snap = CellTypesObjSnapshot { sheet_index, previous };
    record_object_undo(state, "obj_cell_types", serde_json::to_vec(&snap).unwrap_or_default(), description);
}

pub(crate) fn record_cell_behaviors_undo(
    state: &AppState,
    previous: Vec<crate::cell_behaviors::CellBehaviorBinding>,
    description: &str,
) {
    record_object_undo(
        state,
        "obj_cell_behaviors",
        cell_behaviors_snapshot_bytes(previous),
        description,
    );
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
mod writeback_regions_snapshot_tests {
    //! The "obj_writeback_regions" snapshot is applied as a selector MERGE, not
    //! a whole-list swap, so undoing a structural edit reverts the geometry it
    //! shifted without rolling back unrelated later edits. These pin that.
    use super::*;

    fn decl(id: &str, sheet: identity::SheetId, r0: u32, r1: u32) -> calp::WritebackRegionDeclaration {
        calp::WritebackRegionDeclaration {
            id: id.to_string(),
            selector: calp::writeback::RegionSelector {
                sheet_id: sheet,
                row_start: r0,
                row_end: r1,
                col_start: 0,
                col_end: 3,
            },
            mode: None,
            schema: None,
            visibility: None,
            submission_policy: None,
            version_binding: None,
            lifecycle: None,
            aggregation_hint: None,
            expected_respondents: Vec::new(),
            extra: std::collections::HashMap::new(),
        }
    }

    #[test]
    fn snapshot_bytes_round_trip_carries_dropped_ids() {
        let s = identity::SheetId::from_bytes(identity::generate_uuid_v7());
        let bytes = writeback_regions_snapshot_bytes(
            vec![decl("a", s, 0, 5), decl("b", s, 10, 15)],
            vec!["b".to_string()],
        );
        let snap: WritebackRegionsObjSnapshot = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(snap.previous.len(), 2);
        assert_eq!(snap.resurrect_ids, vec!["b"]);
        assert!(
            snap.remove_ids.is_empty(),
            "the forward record never removes; only the inverse does"
        );
    }

    #[test]
    fn snapshot_tolerates_missing_optional_fields() {
        // `#[serde(default)]` on both id lists — an older payload must not
        // fail to deserialize and silently skip the restore.
        let snap: WritebackRegionsObjSnapshot =
            serde_json::from_str(r#"{"previous":[]}"#).unwrap();
        assert!(snap.resurrect_ids.is_empty());
        assert!(snap.remove_ids.is_empty());
    }
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
            ("pane_control", true, CustomRestoreKind::PaneControl),
            ("pane_control_create", true, CustomRestoreKind::PaneControl),
            ("pane_control_delete", true, CustomRestoreKind::PaneControl),
            ("obj_chart", true, CustomRestoreKind::Objects),
            ("obj_sparklines", true, CustomRestoreKind::Objects),
            ("obj_table", true, CustomRestoreKind::Objects),
            ("obj_autofilter", true, CustomRestoreKind::Objects),
            ("obj_validation", true, CustomRestoreKind::Objects),
            ("obj_named_range", true, CustomRestoreKind::Objects),
            ("obj_freeze", true, CustomRestoreKind::Objects),
            ("script_grid_cells", true, CustomRestoreKind::Objects),
            ("obj_extension_data", true, CustomRestoreKind::Objects),
            ("obj_cell_types", true, CustomRestoreKind::Objects),
            ("obj_cell_behaviors", true, CustomRestoreKind::Objects),
            ("obj_writeback_regions", true, CustomRestoreKind::Objects),
            ("obj_object_scripts", true, CustomRestoreKind::Objects),
            ("obj_comments", true, CustomRestoreKind::Objects),
            ("obj_notes", true, CustomRestoreKind::Objects),
            ("obj_hyperlinks", true, CustomRestoreKind::Objects),
            ("obj_conditional_formats", true, CustomRestoreKind::Objects),
            ("obj_sheet_protection", true, CustomRestoreKind::Objects),
            ("obj_sheet_protection_record", true, CustomRestoreKind::Objects),
            ("obj_coord_stores", true, CustomRestoreKind::Objects),
            ("obj_named_ranges", true, CustomRestoreKind::Objects),
            ("obj_range_strings", true, CustomRestoreKind::Objects),
            ("obj_cross_sheet_formulas", true, CustomRestoreKind::Objects),
            ("obj_controls", true, CustomRestoreKind::Objects),
            ("obj_style_tiers", true, CustomRestoreKind::Objects),
            ("obj_workbook_protection", true, CustomRestoreKind::Objects),
            ("report_restore", true, CustomRestoreKind::Objects),
            ("calp_reset", true, CustomRestoreKind::Objects),
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
    /// `script_grid_cells`, `report_restore`, and `calp_reset` are newer than
    /// the legacy prefixes but are likewise deferred (all re-acquire the
    /// grid/grids/active-sheet locks for cell-based restores), so they join the
    /// deferred set explicitly; `pane_control*` kinds acquire the PaneControlState
    /// lock and are deferred exactly like their ribbon_filter siblings.
    #[test]
    fn defer_agrees_with_legacy_prefix_logic() {
        for (kind, spec) in RESTORE_REGISTRY.iter() {
            let legacy_deferred = kind.starts_with("pivot_")
                || kind.starts_with("slicer")
                || kind.starts_with("ribbon_filter")
                || kind.starts_with("pane_control")
                || kind.starts_with("obj_")
                || *kind == "script_grid_cells"
                || *kind == "report_restore"
                || *kind == "calp_reset";
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

/// Snapshot for the "obj_coord_stores" CustomRestore — the per-sheet stores
/// that are keyed by row/column position but live outside the grid.
///
/// One kind rather than four, because they are only ever shifted together (by
/// the same structural edit) and restoring them together keeps a single undo
/// step. Each field is the WHOLE per-sheet value before the shift; these are
/// small (a handful of groups / scenarios / hidden rows per sheet), so a
/// whole-value swap is cheaper than tracking individual deltas.
#[derive(serde::Serialize, serde::Deserialize)]
struct CoordStoresObjSnapshot {
    sheet_index: usize,
    outline: Option<crate::grouping::SheetOutline>,
    scenarios: Option<Vec<crate::api_types::Scenario>>,
    computed: Option<crate::computed_properties::SheetComputedProperties>,
    hidden_rows: Option<Vec<u32>>,
}

/// Serialized "obj_coord_stores" snapshot bytes (in-open-transaction contract).
pub(crate) fn coord_stores_snapshot_bytes(
    sheet_index: usize,
    outline: Option<crate::grouping::SheetOutline>,
    scenarios: Option<Vec<crate::api_types::Scenario>>,
    computed: Option<crate::computed_properties::SheetComputedProperties>,
    hidden_rows: Option<Vec<u32>>,
) -> Vec<u8> {
    serde_json::to_vec(&CoordStoresObjSnapshot {
        sheet_index,
        outline,
        scenarios,
        computed,
        hidden_rows,
    })
    .unwrap_or_default()
}

/// Snapshot for the "obj_named_ranges" CustomRestore — the whole named-range
/// map before a structural edit rewrote the definitions.
///
/// Whole-map rather than per-name: a single edit can touch many definitions,
/// the map is small (names are authored by hand), and a partial restore could
/// leave two names disagreeing about where the same range lives.
#[derive(serde::Serialize, serde::Deserialize)]
struct NamedRangesObjSnapshot {
    previous: Vec<(String, crate::named_ranges::NamedRange)>,
}

/// Serialized "obj_named_ranges" snapshot bytes (in-open-transaction contract).
pub(crate) fn named_ranges_snapshot_bytes(
    previous: Vec<(String, crate::named_ranges::NamedRange)>,
) -> Vec<u8> {
    serde_json::to_vec(&NamedRangesObjSnapshot { previous }).unwrap_or_default()
}

/// Snapshot for the "obj_range_strings" CustomRestore — one sheet's A1 range
/// STRINGS (print area, scroll area) before a structural edit rewrote them.
#[derive(serde::Serialize, serde::Deserialize)]
struct RangeStringsObjSnapshot {
    sheet_index: usize,
    print_area: Option<String>,
    scroll_area: Option<String>,
}

/// Serialized "obj_range_strings" snapshot bytes (in-open-transaction contract).
pub(crate) fn range_strings_snapshot_bytes(
    sheet_index: usize,
    print_area: Option<String>,
    scroll_area: Option<String>,
) -> Vec<u8> {
    serde_json::to_vec(&RangeStringsObjSnapshot { sheet_index, print_area, scroll_area })
        .unwrap_or_default()
}

/// Snapshot for the "obj_cross_sheet_formulas" CustomRestore — the cells on a
/// NON-ACTIVE sheet whose formulas were rewritten because the edited sheet's
/// rows/columns moved under them.
///
/// The active sheet is already covered by `GridSnapshot`; this exists because
/// that snapshot only captures one sheet, and a structural edit now rewrites
/// references on every sheet that points at the edited one.
#[derive(serde::Serialize, serde::Deserialize)]
struct CrossSheetFormulasObjSnapshot {
    sheet_index: usize,
    previous: Vec<((u32, u32), Option<engine::Cell>)>,
}

/// Serialized "obj_cross_sheet_formulas" snapshot bytes.
pub(crate) fn cross_sheet_formulas_snapshot_bytes(
    sheet_index: usize,
    previous: Vec<((u32, u32), Option<engine::Cell>)>,
) -> Vec<u8> {
    serde_json::to_vec(&CrossSheetFormulasObjSnapshot { sheet_index, previous })
        .unwrap_or_default()
}

/// Snapshot for the "obj_controls" CustomRestore — the on-grid control store
/// and the object-script instance ids that name those controls.
///
/// BOTH in one snapshot, deliberately. A control's identity is its cell
/// coordinate: the store is keyed by `(sheet, row, col)` and any attached
/// object script is bound by the derived id `control-<sheet>-<row>-<col>`.
/// Restoring one without the other would leave a script bound to a control that
/// no longer exists, which is the same breakage that made shifting the key alone
/// a bad trade.
#[derive(serde::Serialize, serde::Deserialize)]
struct ControlsObjSnapshot {
    controls: Vec<((usize, u32, u32), crate::controls::ControlMetadata)>,
    /// (script id, previous instance_id) for every binding that was re-keyed.
    /// Keyed by the script's own STABLE id, never its vector index — indices
    /// shift when a script is deleted, and a stale index would silently rebind
    /// a control to whichever script now occupies the slot.
    script_instance_ids: Vec<(String, Option<String>)>,
}

/// Serialized "obj_controls" snapshot bytes (in-open-transaction contract).
pub(crate) fn controls_snapshot_bytes(
    controls: Vec<((usize, u32, u32), crate::controls::ControlMetadata)>,
    script_instance_ids: Vec<(String, Option<String>)>,
) -> Vec<u8> {
    serde_json::to_vec(&ControlsObjSnapshot { controls, script_instance_ids })
        .unwrap_or_default()
}
