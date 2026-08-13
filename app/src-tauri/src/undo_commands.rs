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
    /// Whether the USER-hidden row/column sets were restored (a hide/unhide
    /// undo, or the coordinate shift a structural undo reverses). The frontend
    /// must re-read `get_user_hidden_rows` / `get_user_hidden_cols`: unlike a
    /// cell edit, nothing in `updated_cells` reveals that a row's visibility
    /// changed.
    pub hidden_changed: bool,
    /// Every frontend refresh DOMAIN this undo/redo touched, as the
    /// `MutationDomain` names the Shell translator already understands.
    ///
    /// This is the announcement channel, and it is DATA rather than a widening
    /// list of booleans for one reason: the flags above can only be added to by
    /// changing three files in step (Rust struct, TS interface, the `if
    /// (result.xChanged) domains.push("x")` ladder in Core), and the non-cell
    /// domains — outline, hyperlinks, validations, annotations — are exactly the
    /// ones that never got added, so undoing a grouping or a hyperlink change
    /// told the frontend nothing and it kept painting the old state. The five
    /// legacy booleans are now DERIVED from this same set, so a kind cannot be
    /// classified twice and disagree with itself.
    pub refresh_domains: Vec<String>,
}

/// ONE VOCABULARY OF DOMAINS, and this is the alias to it (§3cd).
///
/// This enum used to be declared here, with its own `wire_name` match. Then a
/// backend-initiated cascade needed to announce the same domains
/// (`object_deps::announce_cascade`), and for a while the crate had TWO enums
/// naming the same wire strings — which is the drift the whole domain design
/// exists to prevent, one layer down. `crossLayerConstantDrift.test.ts` caught
/// it the moment the second one grew a member the first did not have.
///
/// `object_deps::UiDomain` is the canonical declaration because that is where
/// the mapping FROM an object kind TO its domain lives, and every domain in the
/// vocabulary is some object kind's answer. Undo simply reports a SET of them.
pub(crate) use crate::object_deps::UiDomain as MutationDomain;

/// A SET of refresh domains. A restore kind declares a set, not a single class:
/// `obj_validation` is both an object-store swap and a validation change, and
/// the single-class field it replaces could only ever say one of the two.
/// u32, not u16: the shared vocabulary is 16 members wide, so `1u16 << 15` was
/// the last representable bit and the next domain anybody added would have
/// shifted out of range — silently, into a set that contains nothing.
#[derive(Clone, Copy, Default, PartialEq, Eq, Debug)]
pub(crate) struct MutationDomains(u32);

impl MutationDomains {
    pub(crate) const fn none() -> Self {
        MutationDomains(0)
    }

    pub(crate) const fn of(d: MutationDomain) -> Self {
        MutationDomains(1u32 << d as u32)
    }

    pub(crate) fn contains(self, d: MutationDomain) -> bool {
        self.0 & (1u32 << d as u32) != 0
    }

    pub(crate) fn extend(&mut self, other: MutationDomains) {
        self.0 |= other.0;
    }

    /// The wire names, in declaration order.
    pub(crate) fn wire_names(self) -> Vec<String> {
        MutationDomain::ALL
            .iter()
            .filter(|d| self.contains(**d))
            .filter_map(|d| d.wire_name())
            .map(|s| s.to_string())
            .collect()
    }
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
    /// Whether an undo transaction is currently OPEN (begin without commit).
    /// Callers that want to group their own writes into one undo entry must
    /// probe this first: `begin_transaction` is a no-op while a transaction is
    /// open, so an unconditional commit would close SOMEONE ELSE'S group early.
    pub transaction_open: bool,
    /// The history ids on the undo stack, oldest first.
    ///
    /// Exists because `undo_depth` is a SIZE, not a position, and the two were
    /// being confused. The undo-round-trip oracle remembered a depth, acted,
    /// and then undid `depth_now - depth_then` steps to return to the
    /// remembered state -- arithmetic that is only sound while the history cap
    /// is out of reach. Past the cap, every push drops the oldest entry, the
    /// depth stops growing, and the difference under-counts: the oracle walked
    /// back a fraction of the distance and reported whatever the walk had done
    /// in between as an undo defect. (That is the whole of S12's "un-undone
    /// cell edit" and "table restored that never existed" -- the two leftovers
    /// were the OLDEST actions of the window, which is what "did not go back
    /// far enough" looks like from the outside.)
    ///
    /// With ids the question is exact: remember the id on top, and later count
    /// the entries ABOVE it. If it is absent, the remembered state is
    /// unreachable and no step count restores it.
    pub undo_seqs: Vec<u64>,
    /// How many transactions the size cap has dropped over this document's
    /// lifetime. The only evidence eviction leaves.
    pub evicted_total: u64,
    /// How many transactions a WHOLESALE clear has discarded over this
    /// document's lifetime.
    ///
    /// A remembered id can go missing for three different reasons and only one
    /// of them is ever a product defect, so the three have to be tellable
    /// apart: the cap dropped it (`evicted_total` moved), a workbook-STRUCTURE
    /// change ended the history (this moved — Excel parity, BUG-0005), or the
    /// caller itself undid past it (neither moved). Without this counter the
    /// undo-round-trip oracle read the second case as the third and reported
    /// "the walk undid past the checkpoint" about a sheet insert.
    pub cleared_total: u64,
    /// The history cap (Excel keeps 100 too).
    pub history_limit: usize,
}

/// A geometry restore whose sheet is NOT the active one.
///
/// The four changes below carried no sheet dimension at all until BUG-0005's
/// sweep: they were implicitly "the active sheet", which is true when they are
/// RECORDED and need not be true when they are RESTORED. A user resizes a
/// column on Sheet2, switches to Sheet1 and presses Ctrl+Z, and the restore
/// landed on Sheet1 — silently, with the sheet that was actually edited left
/// alone. `RestoreSnapshot` was the same defect with the whole grid at stake.
///
/// They are queued rather than applied in place because `apply_changes` holds
/// the ACTIVE sheet's mirrors (`column_widths`, `row_heights`,
/// `merged_regions`) for its whole pass, and an off-sheet restore needs the
/// `all_*` stores instead. `set_active_sheet` takes mirror-then-all in every
/// case, so taking them the other way round here would close a deadlock cycle
/// — and std's locks are not reentrant, so even the same-store case would hang.
/// The deferred pass runs after every guard is released.
#[derive(Debug)]
pub(crate) enum OffSheetGeometry {
    ColumnWidth { sheet: usize, col: u32, previous: Option<f64> },
    RowHeight { sheet: usize, row: u32, previous: Option<f64> },
    /// `was_added` records which DIRECTION the original change was, not what
    /// to do now: the apply direction is `is_undo`, exactly as for the
    /// active-sheet arms (storing the opposite variant AND flipping on
    /// `is_undo` was the double negation of BUG-0009).
    Merge { sheet: usize, region: UndoMergeRegion, was_added: bool },
    Snapshot(GridSnapshot),
}

/// What an off-sheet geometry restore changed, for the caller's flags.
#[derive(Default)]
pub(crate) struct OffSheetGeometryOutcome {
    pub merge_changed: bool,
    pub structural_restore: bool,
}

/// Apply one off-sheet geometry restore. Runs in `apply_changes`'s DEFERRED
/// phase, with every grid/width/height/merge guard released, and takes its
/// locks in `apply_sheet_structural_restore`'s order so the two cannot
/// deadlock against each other.
pub(crate) fn apply_off_sheet_geometry(
    state: &AppState,
    effect: &crate::document_effect::DocumentEffect,
    item: &OffSheetGeometry,
    is_undo: bool,
    inverse_transaction: &mut Transaction,
    report: &mut RestoreReport,
) -> OffSheetGeometryOutcome {
    let mut outcome = OffSheetGeometryOutcome::default();
    match item {
        OffSheetGeometry::ColumnWidth { sheet, col, previous } => {
            let mut all = state.all_column_widths.write(effect).unwrap();
            while all.len() <= *sheet {
                all.push(HashMap::new());
            }
            let current = all[*sheet].get(col).copied();
            inverse_transaction.add_change(CellChange::SetColumnWidth {
                sheet: *sheet,
                col: *col,
                previous: current,
            });
            match previous {
                Some(width) => { all[*sheet].insert(*col, *width); }
                None => { all[*sheet].remove(col); }
            }
        }
        OffSheetGeometry::RowHeight { sheet, row, previous } => {
            let mut all = state.all_row_heights.write(effect).unwrap();
            while all.len() <= *sheet {
                all.push(HashMap::new());
            }
            let current = all[*sheet].get(row).copied();
            inverse_transaction.add_change(CellChange::SetRowHeight {
                sheet: *sheet,
                row: *row,
                previous: current,
            });
            match previous {
                Some(height) => { all[*sheet].insert(*row, *height); }
                None => { all[*sheet].remove(row); }
            }
        }
        OffSheetGeometry::Merge { sheet, region, was_added } => {
            inverse_transaction.add_change(if *was_added {
                CellChange::AddMergeRegion { sheet: *sheet, region: region.clone() }
            } else {
                CellChange::RemoveMergeRegion { sheet: *sheet, region: region.clone() }
            });
            // `was_added == is_undo` means "take it away": undoing an add, or
            // redoing a remove. The other two combinations put it back.
            let remove = *was_added == is_undo;
            crate::report::with_sheet_merges_mut(state, effect, *sheet, |merged| {
                if remove {
                    merged.remove(&to_api_region(region));
                } else {
                    merged.insert(to_api_region(region));
                }
            });
            outcome.merge_changed = true;
        }
        OffSheetGeometry::Snapshot(snapshot) => {
            let idx = snapshot.sheet;
            report.wrote_sheet(idx);

            // Cells BEFORE the swap, for the subscriber override layer. Undoing
            // an edit on a subscribed sheet must update or remove the matching
            // override, or the next refresh re-applies the stale one and
            // resurrects the undone edit. The active-sheet arm has always done
            // this; an off-sheet restore that skipped it would be a new gap.
            let mut override_edits: Vec<(u32, u32, Option<engine::Cell>, Option<engine::Cell>)> =
                Vec::new();

            let mut inverse = {
                // Same order as `apply_sheet_structural_restore`: mirror,
                // grids, then the all- stores. The mirror is taken even though
                // this branch never writes it, so the two functions can never
                // acquire the pair in opposite orders.
                let _mirror = state.grid.write(effect).unwrap();
                let mut grids = state.grids.write(effect).unwrap();
                let mut all_cw = state.all_column_widths.write(effect).unwrap();
                let mut all_rh = state.all_row_heights.write(effect).unwrap();
                if idx >= grids.len() {
                    return outcome;
                }
                while all_cw.len() <= idx {
                    all_cw.push(HashMap::new());
                }
                while all_rh.len() <= idx {
                    all_rh.push(HashMap::new());
                }

                {
                    let keys: std::collections::HashSet<(u32, u32)> = grids[idx]
                        .cells
                        .keys()
                        .chain(snapshot.cells.keys())
                        .copied()
                        .collect();
                    for (row, col) in keys {
                        let pre = grids[idx].cells.get(&(row, col));
                        let post = snapshot.cells.get(&(row, col));
                        if cell_value_differs(pre, post) {
                            override_edits.push((row, col, pre.cloned(), post.cloned()));
                        }
                    }
                }

                let inverse = GridSnapshot {
                    sheet: idx,
                    cells: grids[idx].cells.clone(),
                    row_heights: all_rh[idx].clone(),
                    column_widths: all_cw[idx].clone(),
                    merged_regions: std::collections::HashSet::new(), // filled below
                    max_row: grids[idx].max_row,
                    max_col: grids[idx].max_col,
                    row_styles: grids[idx].row_styles.iter().map(|(k, v)| (*k, *v)).collect(),
                    column_styles: grids[idx].column_styles.iter().map(|(k, v)| (*k, *v)).collect(),
                };

                grids[idx].cells = snapshot.cells.clone();
                grids[idx].max_row = snapshot.max_row;
                grids[idx].max_col = snapshot.max_col;
                grids[idx].row_styles = snapshot.row_styles.iter().map(|(k, v)| (*k, *v)).collect();
                grids[idx].column_styles =
                    snapshot.column_styles.iter().map(|(k, v)| (*k, *v)).collect();
                all_cw[idx] = snapshot.column_widths.clone();
                all_rh[idx] = snapshot.row_heights.clone();
                inverse
            };

            inverse.merged_regions =
                crate::report::with_sheet_merges_mut(state, effect, idx, |merged| {
                    let prev: std::collections::HashSet<UndoMergeRegion> =
                        merged.iter().map(to_undo_region).collect();
                    merged.clear();
                    for r in &snapshot.merged_regions {
                        merged.insert(to_api_region(r));
                    }
                    prev
                });

            crate::calp_commands::record_subscription_override_edits(
                state,
                effect,
                idx,
                &override_edits,
            );

            inverse_transaction.add_change(CellChange::RestoreSnapshot(inverse));
            outcome.merge_changed = true;
            outcome.structural_restore = true;
        }
    }
    outcome
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

/// Whether a restore actually MOVED a cell's calculated content, as opposed to
/// only its appearance.
///
/// Two things key off this and both need the same answer. The subscriber
/// override layer records only value/formula, so a style-only restore must not
/// manufacture an override; and the dependent cascade seeds off restored cells,
/// so a "Bold 10,000 cells" undo — which records a `SetCell` per cell, in
/// styles.rs, named_styles_cmd.rs and protection.rs alike — must not walk the
/// whole dependency graph to re-derive the numbers it started with.
fn cell_value_differs(pre: Option<&engine::Cell>, post: Option<&engine::Cell>) -> bool {
    match (pre, post) {
        (None, None) => false,
        (Some(a), Some(b)) => a.value != b.value || a.formula_string() != b.formula_string(),
        _ => true,
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
    // Cloned BEFORE the dependency locks: `rebuild_all_dependencies_from_grid`
    // needs the official sheet names to canonicalise cross-sheet keys, and
    // taking that lock inside would add a fourth lock to a function some
    // callers already reach while holding the grid.
    // CANONICAL LOCK ORDER: `grid` FIRST, then everything else. The
    // recalculation pass holds both grid locks and then takes `sheet_names` /
    // `named_ranges` / `tables` on a background thread, so a reader that holds
    // any of those and then waits for a grid lock closes a cycle.
    let grid = state.grid.read().unwrap();
    let sheet_names = state.sheet_names.read().unwrap().clone();
    // Same rule for the name tables: acquired HERE, at the call site, so a
    // caller that already holds one cannot deadlock inside the rebuild.
    let named_ranges = state.named_ranges.read().unwrap();
    let tables = state.tables.read().unwrap();
    let table_names = state.table_names.read().unwrap();
    let active_sheet = *state.active_sheet.read().unwrap();
    rebuild_all_dependencies_from_grid(
        &grid,
        active_sheet,
        &sheet_names,
        crate::name_resolution::NameTables {
            named_ranges: &named_ranges,
            tables: &tables,
            table_names: &table_names,
            sheet_names: &sheet_names,
            spill_ranges: &state.spill_ranges,
        },
        state,
    );
}

/// Same as rebuild_all_dependencies but for callers that already hold the
/// grid lock (passing it avoids a deadlock). Locks only the dependency maps.
///
/// `sheet_names` is the workbook's official name list, passed rather than
/// locked so this stays safe for callers holding other AppState locks. It is
/// NOT optional: cross-sheet dependents are keyed by sheet NAME and the cascade
/// looks them up under the official spelling, so rebuilding straight from the
/// AST's spelling registers keys nothing will ever find. See
/// `normalize_cross_sheet_refs`.
pub(crate) fn rebuild_all_dependencies_from_grid(
    grid: &engine::Grid,
    active_sheet: usize,
    sheet_names: &[String],
    name_tables: crate::name_resolution::NameTables<'_>,
    state: &AppState,
) {
    let mut dependents_map = state.dependents.lock().unwrap();
    let mut dependencies_map = state.dependencies.lock().unwrap();
    let mut column_dependents_map = state.column_dependents.lock().unwrap();
    let mut column_dependencies_map = state.column_dependencies.lock().unwrap();
    let mut row_dependents_map = state.row_dependents.lock().unwrap();
    let mut row_dependencies_map = state.row_dependencies.lock().unwrap();
    let mut name_dependents_map = state.name_dependents.lock().unwrap();
    let mut name_dependencies_map = state.name_dependencies.lock().unwrap();
    let mut table_dependents_map = state.table_dependents.lock().unwrap();
    let mut table_dependencies_map = state.table_dependencies.lock().unwrap();
    let mut cross_sheet_dependents = state.cross_sheet_dependents.lock().unwrap();
    let mut cross_sheet_dependencies = state.cross_sheet_dependencies.lock().unwrap();

    // Clear the single-sheet maps (they describe only the active sheet).
    dependents_map.clear();
    dependencies_map.clear();
    column_dependents_map.clear();
    column_dependencies_map.clear();
    row_dependents_map.clear();
    row_dependencies_map.clear();
    // DEFINED-NAME edges are single-sheet for the same reason (D2): they are
    // keyed by name with no sheet dimension, so they describe the active sheet
    // only and are rebuilt with it.
    name_dependents_map.clear();
    name_dependencies_map.clear();
    // STRUCTURED-REFERENCE edges are single-sheet for the same reason (§2aj):
    // keyed by table name with no sheet dimension, so they describe the active
    // sheet only and are rebuilt with it.
    table_dependents_map.clear();
    table_dependencies_map.clear();

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
            // THE STORED TREE KEEPS ITS DEFINED NAMES (D2), and
            // `extract_references_recursive` cannot see through a `NamedRef` —
            // it has no cell coordinates to give. Expanding first is what keeps
            // `=RATE*B2` a dependent of the cell `RATE` points at: without it,
            // the first sheet switch or structural undo would quietly drop that
            // edge and editing the precedent would move nothing.
            let expanded =
                crate::name_resolution::eval_ast(ast, &name_tables.at(active_sheet, row, col));
            let refs = extract_all_references(&expanded, &grid);

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
            // The name edges come from the STORED tree, which is the one in the
            // grid: a formula keeps its defined names now (D2).
            let names = crate::name_resolution::names_of_cell(cell);
            if !names.is_empty() {
                crate::name_resolution::update_name_dependencies(
                    (row, col),
                    names,
                    &mut name_dependencies_map,
                    &mut name_dependents_map,
                );
            }
            // ...and the TABLE edges, from the same tree and for the same
            // reason: the stored form keeps `Sales[Amount]` (§2aj), so a sheet
            // switch or a structural undo would otherwise drop every edge that
            // makes a table resize a recalculation.
            let read_tables = crate::table_deps::tables_of_cell(cell);
            if !read_tables.is_empty() {
                crate::table_deps::update_table_dependencies(
                    (row, col),
                    read_tables,
                    &mut table_dependencies_map,
                    &mut table_dependents_map,
                );
            }
            if !refs.cross_sheet_cells.is_empty() {
                update_cross_sheet_dependencies(
                    (active_sheet, row, col),
                    crate::normalize_cross_sheet_refs(&refs.cross_sheet_cells, sheet_names),
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
        transaction_open: undo_stack.has_open_transaction(),
        undo_seqs: undo_stack.undo_seqs(),
        evicted_total: undo_stack.evicted_total(),
        cleared_total: undo_stack.cleared_total(),
        history_limit: undo_stack.max_size(),
    }
}

/// Apply undo/redo changes and return the result.
/// Shared logic used by both `undo` and `redo` commands.
///
/// `pub(crate)` so tests can drive the real restore without a Tauri runtime:
/// `undo`/`redo` themselves take an `AppHandle`, this takes plain references.
pub(crate) fn apply_changes(
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
    let grid = state.grid.lock_pending().unwrap();
    let grids = state.grids.lock_pending().unwrap();
    let active_sheet = *state.active_sheet.read().unwrap();
    let styles = state.style_registry.read().unwrap();
    // `lock_pending`, not `read`: the guard has to be taken here, in the same
    // critical section as the grid, and the effect does not exist yet.
    let column_widths = state.column_widths.lock_pending().unwrap();
    let row_heights = state.row_heights.lock_pending().unwrap();
    let merged_regions = state.merged_regions.lock_pending().unwrap();
    let locale = state.locale.lock().unwrap();

    // Undo/redo rewrites persisted state, so it dirties -- deliberately even when the
    // restore lands back on the last-saved content. Tracking true equality with disk
    // would need a whole-workbook content hash at every step; a false-positive prompt
    // is cheap, a false negative loses data. (bi_model_undo/redo already work this way.)
    // Built up-front so the restore adapters below can reach `Persisted::write`.
    let effect = crate::document_effect::DocumentEffect::mutates(file_state);
    let mut grid = grid.authorize(&effect);
    let mut grids = grids.authorize(&effect);
    let mut column_widths = column_widths.authorize(&effect);
    let mut row_heights = row_heights.authorize(&effect);
    let mut merged_regions = merged_regions.authorize(&effect);

    let description = transaction.description.clone();
    let mut updated_cells = Vec::new();
    let mut merge_changed = false;
    let mut structural_restore = false;
    // Every frontend refresh domain this restore touched. One accumulator, from
    // which the legacy `*_changed` booleans on `UndoResult` are derived at the
    // end — a kind can no longer be classified in two places and disagree.
    let mut domains = MutationDomains::none();
    // What the restores themselves reported: the sheets whose cells they
    // rewrote, and whether a name every formula resolves through moved. This is
    // the channel `report_restore` / `calp_reset` never had.
    let mut report = RestoreReport::default();

    // Deferred custom restores that need to run AFTER grid locks are released
    // (pivot/slicer/ribbon_filter restores acquire their own locks and may need grid access)
    let mut deferred_restores: Vec<(String, Vec<u8>)> = Vec::new();

    // OFF-SHEET geometry restores, deferred for exactly the reason above.
    //
    // `column_widths`, `row_heights` and `merged_regions` are the ACTIVE
    // sheet's mirrors, and this pass holds all three. An off-sheet restore has
    // to reach `all_column_widths` / `all_row_heights` / `all_merged_regions`
    // instead, which are locks this pass does NOT hold and must not take here:
    // `set_active_sheet` takes the mirror before the all- store in every case,
    // so taking them the other way round closes a cycle, and std's locks are
    // not reentrant anyway. The deferred pass runs with every guard above
    // released — the same contract the pivot column-width restore learned the
    // hard way (it deadlocked against its own caller, and the harness reported
    // it as "the application went away").
    //
    // The ACTIVE-sheet path is untouched by all of this: when the change's
    // sheet is the active one it is applied inline exactly as before.
    let mut deferred_geometry: Vec<OffSheetGeometry> = Vec::new();

    // (row, col, pre, post) per restored cell, for subscriber override
    // maintenance: undoing an edit on a subscribed sheet must update/remove
    // the corresponding override, or the next refresh re-applies the stale
    // override and resurrects the undone edit.
    let mut override_edits: Vec<(u32, u32, Option<engine::Cell>, Option<engine::Cell>)> = Vec::new();

    // Build the inverse transaction.
    //
    // It inherits the popped transaction's history id. The inverse IS the same
    // point in history seen from the other side, so undo-then-redo has to put
    // the SAME id back on the undo stack -- a fresh one would make every
    // caller that remembered that point (the undo-round-trip oracle) conclude
    // the point had been lost.
    let mut inverse_transaction = Transaction::new(description.clone());
    inverse_transaction.seq = transaction.seq;

    // Apply changes in REVERSE order for proper undo/redo semantics
    for change in transaction.changes.iter().rev() {
        match change {
            CellChange::SetCell { sheet, row, col, previous } => {
                // WHICH SHEET. `SetCell` carries the sheet it was recorded on, so
                // an undo issued after a sheet switch restores where the edit was
                // made instead of overwriting whatever sheet is now in front of
                // the user. Before, every `SetCell` was replayed into the active
                // mirror and `grids[active_sheet]` unconditionally: undo after a
                // switch silently corrupted the new sheet AND left the edited one
                // unchanged, and there was no way for a restore to seed a cascade
                // anywhere but the active sheet.
                let is_active = *sheet == active_sheet;
                let current = if is_active {
                    grid.get_cell(*row, *col).cloned()
                } else {
                    grids.get(*sheet).and_then(|g| g.get_cell(*row, *col)).cloned()
                };
                if is_active {
                    // The override layer and the dependent cascade are both
                    // ACTIVE-sheet machinery (`record_subscription_override_edits`
                    // takes the active index; the seed list is bare row/col), so
                    // only active-sheet restores go in here. Off-sheet ones are
                    // reported as SHEETS and re-evaluated through the shared
                    // off-sheet cascade below.
                    override_edits.push((*row, *col, current.clone(), previous.clone()));
                } else {
                    report.wrote_sheet(*sheet);
                }
                inverse_transaction.add_change(CellChange::SetCell {
                    sheet: *sheet,
                    row: *row,
                    col: *col,
                    previous: current,
                });

                // Restore previous state
                match previous {
                    Some(cell) => {
                        if is_active {
                            grid.set_cell(*row, *col, cell.clone());
                        }
                        if *sheet < grids.len() {
                            grids[*sheet].set_cell(*row, *col, cell.clone());
                        }
                        // Resolved against the active-sheet mirror the cell was
                        // just restored into, so the row/column tiers apply. An
                        // off-sheet restore has no mirror to resolve against, so
                        // it reports the cell's own style index.
                        let effective_style_index = if is_active {
                            grid.effective_style_index(*row, *col)
                        } else {
                            cell.style_index
                        };
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
                            sheet_index: if is_active { None } else { Some(*sheet) },
                            rich_text: None,
                            accounting_layout: None,
                        });
                    }
                    None => {
                        if is_active {
                            grid.clear_cell(*row, *col);
                        }
                        if *sheet < grids.len() {
                            grids[*sheet].clear_cell(*row, *col);
                        }
                        // The cell is gone, but a row/column style may still
                        // give its position an appearance.
                        let effective_style_index = if is_active {
                            grid.effective_style_index(*row, *col)
                        } else {
                            0
                        };
                        updated_cells.push(CellData {
                            row: *row,
                            col: *col,
                            display: String::new(),
                            display_color: None,
                            formula: None,
                            style_index: effective_style_index,
                            row_span: 1,
                            col_span: 1,
                            sheet_index: if is_active { None } else { Some(*sheet) },
                            rich_text: None,
                            accounting_layout: None,
                        });
                    }
                }
            }
            CellChange::SetColumnWidth { sheet, col, previous } => {
                // `column_widths` is the ACTIVE sheet's mirror. A resize
                // recorded on another sheet has to reach that sheet's entry in
                // `all_column_widths`, which needs a lock this pass must not
                // take while holding the mirror -- so it is deferred.
                if *sheet != active_sheet {
                    deferred_geometry.push(OffSheetGeometry::ColumnWidth {
                        sheet: *sheet,
                        col: *col,
                        previous: *previous,
                    });
                } else {
                    let current = column_widths.get(col).copied();
                    inverse_transaction.add_change(CellChange::SetColumnWidth {
                        sheet: *sheet,
                        col: *col,
                        previous: current,
                    });
                    match previous {
                        Some(width) => { column_widths.insert(*col, *width); }
                        None => { column_widths.remove(col); }
                    }
                }
            }
            CellChange::SetRowHeight { sheet, row, previous } => {
                if *sheet != active_sheet {
                    deferred_geometry.push(OffSheetGeometry::RowHeight {
                        sheet: *sheet,
                        row: *row,
                        previous: *previous,
                    });
                } else {
                    let current = row_heights.get(row).copied();
                    inverse_transaction.add_change(CellChange::SetRowHeight {
                        sheet: *sheet,
                        row: *row,
                        previous: current,
                    });
                    match previous {
                        Some(height) => { row_heights.insert(*row, *height); }
                        None => { row_heights.remove(row); }
                    }
                }
            }
            // The inverse keeps the SAME change variant; the apply direction
            // (is_undo) decides the operation. Storing the opposite variant
            // AND flipping on is_undo was a double negation: redo after undo
            // REMOVED the merge instead of restoring it (BUG-0009).
            CellChange::AddMergeRegion { sheet, region } => {
                if *sheet != active_sheet {
                    deferred_geometry.push(OffSheetGeometry::Merge {
                        sheet: *sheet,
                        region: region.clone(),
                        was_added: true,
                    });
                } else {
                    inverse_transaction.add_change(CellChange::AddMergeRegion {
                        sheet: *sheet,
                        region: region.clone(),
                    });
                    if is_undo {
                        // Undo adding = remove it
                        merged_regions.remove(&to_api_region(region));
                    } else {
                        // Redo adding = add it back
                        merged_regions.insert(to_api_region(region));
                    }
                    merge_changed = true;
                }
            }
            CellChange::RemoveMergeRegion { sheet, region } => {
                if *sheet != active_sheet {
                    deferred_geometry.push(OffSheetGeometry::Merge {
                        sheet: *sheet,
                        region: region.clone(),
                        was_added: false,
                    });
                } else {
                    inverse_transaction.add_change(CellChange::RemoveMergeRegion {
                        sheet: *sheet,
                        region: region.clone(),
                    });
                    if is_undo {
                        // Undo removing = add it back
                        merged_regions.insert(to_api_region(region));
                    } else {
                        // Redo removing = remove it
                        merged_regions.remove(&to_api_region(region));
                    }
                    merge_changed = true;
                }
            }
            CellChange::RestoreSnapshot(snapshot) if snapshot.sheet != active_sheet => {
                // THE SEVERE ONE. This variant REPLACES a whole grid, and it
                // used to replace the active sheet's whichever sheet it was
                // taken from: insert a row on Sheet2, switch to Sheet1, undo,
                // and Sheet1's entire cell map became Sheet2's saved one.
                // Deferred for the same lock reason as the geometry above -- an
                // off-sheet whole-grid swap needs `all_column_widths` /
                // `all_row_heights` / `all_merged_regions`.
                deferred_geometry.push(OffSheetGeometry::Snapshot(snapshot.clone()));
            }
            CellChange::RestoreSnapshot(snapshot) => {
                // Save current state as inverse snapshot
                let current_snapshot = GridSnapshot {
                    sheet: active_sheet,
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
                        if cell_value_differs(pre, post) {
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
                            pane_control_state, &effect, kind, data, &mut inverse_transaction,
                            &mut report,
                        );
                        domains.extend(spec.domains);
                    }
                    None => eprintln!("[undo] Unknown custom restore kind: {}", kind),
                }
            }
        }
    }

    // (dirty flag already set by `effect` at the top of the restore pass)

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
    crate::calp_commands::record_subscription_override_edits(state, &effect, active_sheet, &override_edits);

    // OFF-SHEET geometry, now that every guard above is released. Before this
    // existed, each of these landed on the ACTIVE sheet instead of the one it
    // was recorded on — a wrong column width at best, and at worst a whole
    // grid replaced by another sheet's.
    for item in &deferred_geometry {
        let outcome =
            apply_off_sheet_geometry(state, &effect, item, is_undo, &mut inverse_transaction, &mut report);
        merge_changed |= outcome.merge_changed;
        structural_restore |= outcome.structural_restore;
    }

    // Process deferred pivot/slicer/ribbon_filter restores (now safe to acquire locks)
    for (kind, data) in deferred_restores {
        match restore_spec(&kind) {
            Some(spec) => {
                (spec.restore)(
                    state, pivot_state, slicer_state, ribbon_filter_state,
                    pane_control_state, &effect, &kind, &data, &mut inverse_transaction,
                    &mut report,
                );
                domains.extend(spec.domains);
                if kind == "sheet_structural_snapshot" {
                    // Whole-sheet swap: when the restored sheet is (or has
                    // become) the active one, the mirror changed shape — the
                    // frontend must fully refresh and the dependency maps must
                    // be rebuilt, exactly like an engine RestoreSnapshot.
                    structural_restore = true;
                    merge_changed = true;
                }
                if kind == "sheet_merge_regions" {
                    merge_changed = true;
                }
            }
            None => eprintln!("[undo] Unknown deferred custom restore kind: {}", kind),
        }
    }

    // Rebuild the dependency maps whenever a restore changed WHICH FORMULA sits
    // in a cell, not only after a structural one.
    //
    // The maps are derived state — `rebuild_all_dependencies` reads them back
    // out of the grid's formula ASTs — and restoring a cell used to put the
    // formula back while leaving the edges as the undone operation had left
    // them. Overwrite `A2 = A1*2` with a literal and the edge `A1 -> A2` is
    // dropped (`update_dependencies` with no refs); undo then restored a
    // formula that was INERT for the rest of the session, so the next edit to
    // A1 silently failed to reach it. That is the same shape as BUG-0019's
    // fourth cause: a map that describes the grid quietly stops describing it,
    // and every symptom is a stale number rather than an error.
    //
    // Cheaper alternatives (incremental edge maintenance per restored cell) are
    // exactly the hand-maintained-edge pattern that produced BUG-0019, and undo
    // is a human-scale action — the same full rescan already runs on every
    // sheet switch.
    //
    // This MUST also precede the dependent cascade below, which looks its seeds
    // up in precisely these maps. (The structural rebuild used to run last,
    // which was harmless only because nothing after it read them.)
    let formula_edges_changed = override_edits.iter().any(|(_, _, pre, post)| {
        pre.as_ref().and_then(|c| c.formula_string())
            != post.as_ref().and_then(|c| c.formula_string())
    });
    if structural_restore || formula_edges_changed {
        rebuild_all_dependencies(state);
    }

    // THE OFF-SHEET HALF OF THE CASCADE — what the restores just reported.
    //
    // A restore that rewrote cells on a sheet OTHER than the active one has no
    // seed the active-sheet cascade below can use: that cascade's whole
    // vocabulary is `(row, col)` on the active sheet. Four kinds land here —
    // `report_restore`, `calp_reset`, `script_grid_cells` and a sheet-tagged
    // `SetCell` — and they are all whole-region or whole-sheet swaps that carry
    // their own cached values, so the thing left stale is never their own cells:
    // it is the OTHER sheets' formulas reading into them. `report_restore` and
    // `calp_reset` previously reported nothing at all and got no recalculation
    // in either direction.
    //
    // `recalc_after_off_sheet_write` is the shared entry point a FORWARD
    // off-sheet write already uses — the written sheets and then the active one,
    // twice, so one more cross-sheet hop propagates. Reusing it is what keeps
    // this from becoming a fourth copy of the recalculation walk, and it means
    // an off-sheet undo and the off-sheet write it reverses converge through
    // identical code. Second lock phase, like everything below: it takes its own
    // locks and its caller must hold none.
    //
    // A WORKBOOK-WIDE trigger is a separate case, and named ranges are the
    // reason it exists. A name is resolved during evaluation; it is not an edge
    // in `dependents`, `column_dependents`, `row_dependents` or
    // `cross_sheet_dependents`, so no cell seed anywhere describes "every
    // formula that resolves through TAXRATE". Undoing a name definition
    // therefore left every one of them stale — the value was wrong and nothing
    // in the document said so. The honest trigger is every sheet, which is what
    // the load path does after reading names back.
    {
        let sheets: Vec<usize> = if report.workbook_recalc {
            let count = state.grids.read().unwrap().len();
            (0..count).collect()
        } else {
            report.sheets_rewritten.iter().copied().collect()
        };
        if !sheets.is_empty() {
            crate::commands::data::recalc_after_off_sheet_write(
                state,
                user_files_state,
                pivot_state,
                pane_control_state,
                ribbon_filter_state,
                &sheets,
            );
        }
    }

    // THE DEPENDENT CASCADE — undo/redo is a value RESTORE, and a restore on its
    // own is a wrong answer.
    //
    // Only the cells a caller passed to `record_cell_change` are in a
    // transaction; the dependents its forward cascade re-evaluated never were.
    // So restoring `Sheet1!C5` used to leave `Sheet1!C9 = SUM(C4:C8)` and
    // `Sheet2!B3 = Sheet1!C9` sitting at their post-edit values, disagreeing
    // with what loading the same document produces. Excel's undo restores the
    // prior state INCLUDING dependent values; so does this. `redo` reaches this
    // through the same function with the inverse transaction, so both
    // directions cascade or neither does.
    //
    // WHY THE RESTORED CELLS ARE RE-DERIVED RATHER THAN BELIEVED. The obvious
    // reading is that a restored `Cell` carries the exact value it held before
    // the undone operation, so it is authoritative and only its dependents need
    // recomputing. That reading is wrong, and the counter-example is ordinary: a
    // transaction is not required to capture its `previous` cells before it
    // starts writing. Any grouped run that writes cell by cell —
    // `begin_undo_transaction` + N `update_cell` (the scripting and CLI batch
    // shape), find-and-replace, fill — cascades after EACH write, so a formula
    // cell recorded LATE in the transaction was captured with a value the same
    // transaction had already changed. Undo `[C5 = 6950, C9 = 99999]` and C9's
    // recorded `previous` is `=SUM(C4:C8)` cached at 27800: the mid-transaction
    // total, not the one the user is undoing back to. Believing it restores a
    // number that never existed before the operation.
    //
    // Re-deriving is immune to that, because DERIVED state is not what a
    // transaction is for. `recalc_after_active_sheet_bulk_rewrite` orders the
    // seeds among themselves topologically and skips any seed with no formula,
    // so restored LITERALS keep exactly the recorded value (that is the state
    // undo owns) while restored FORMULAS are re-evaluated from precedents the
    // restore has already finished putting back. The two kinds of transaction
    // therefore converge instead of competing: one that carries no dependents
    // gets them recomputed, and one that carries them — `RestoreSnapshot` hands
    // back cached values for the whole active sheet — recomputes to the same
    // numbers it carried, having also fixed the cells it could not carry (the
    // OTHER sheets' formulas reading into it, which no active-sheet snapshot
    // covers). The cost is that a restored volatile (`=RAND()`, `=NOW()`) lands
    // on a fresh value, which is what any other recalculation of it does too.
    //
    // Seeds are only the cells whose value or formula actually MOVED. A
    // style-only undo also records `SetCell` — styles.rs, named_styles_cmd.rs
    // and protection.rs all do — and seeding a bold-10,000-cells undo with
    // 10,000 unchanged cells would walk the whole dependency graph to re-derive
    // the numbers it started with.
    //
    // LOCKING: `recalc_after_active_sheet_bulk_rewrite` acquires everything
    // itself and its caller must hold nothing — hence a SECOND phase here, after
    // every grid/style guard above was dropped and after
    // `rebuild_all_dependencies` released the dependency maps it needs. Same
    // shape, and the same reason, as `sort_range`: std mutexes are not
    // reentrant.
    {
        let seeds: Vec<(u32, u32)> = override_edits
            .iter()
            .filter(|(_, _, pre, post)| cell_value_differs(pre.as_ref(), post.as_ref()))
            .map(|&(row, col, _, _)| (row, col))
            .collect();
        crate::commands::data::recalc_after_active_sheet_bulk_rewrite(
            state,
            user_files_state,
            pane_control_state,
            ribbon_filter_state,
            &seeds,
            &mut updated_cells,
        );
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

    UndoResult {
        success: true,
        description: Some(description),
        updated_cells,
        can_undo,
        can_redo,
        merge_changed,
        structural_restore,
        // Derived from the ONE domain set, so the flags and the domain list
        // cannot disagree about what this restore touched.
        pivot_changed: domains.contains(MutationDomain::Pivot),
        slicer_changed: domains.contains(MutationDomain::Slicer),
        ribbon_filter_changed: domains.contains(MutationDomain::RibbonFilter),
        pane_control_changed: domains.contains(MutationDomain::PaneControl),
        objects_changed: domains.contains(MutationDomain::Objects),
        hidden_changed: domains.contains(MutationDomain::Hidden),
        refresh_domains: domains.wire_names(),
    }
}

/// What a restore DID, reported back to `apply_changes` by the restore itself.
///
/// THE GAP THIS CLOSES. The restore -> recalculation channel was a
/// `Vec<(u32, u32)>` of ACTIVE-sheet coordinates, so a restore that rewrote
/// cells on another sheet — `report_restore`, `calp_reset`,
/// `script_grid_cells`, `obj_cross_sheet_formulas` — had no way to say so and
/// got no cascade at all. Their own sheet was right (they carry cached values);
/// what stayed stale was every OTHER sheet's formula reading into them. Reporting
/// SHEETS rather than cells is the right granularity for them, because each is a
/// whole-region or whole-sheet swap: the shared off-sheet cascade
/// (`recalc_after_off_sheet_write`) re-evaluates the written sheets and the
/// active one, which is exactly the same treatment a forward off-sheet write
/// gets.
#[derive(Debug, Default)]
pub(crate) struct RestoreReport {
    /// Sheets whose CELLS this restore rewrote.
    pub sheets_rewritten: std::collections::BTreeSet<usize>,
    /// The restore changed something EVERY formula in the workbook can resolve
    /// through — a named range. No cell-level seed can describe that: names are
    /// resolved during evaluation and are not edges in any dependency map, so
    /// undoing a name definition left every formula using it stale. The only
    /// honest trigger is a whole-workbook re-evaluation.
    pub workbook_recalc: bool,
}

impl RestoreReport {
    fn wrote_sheet(&mut self, sheet_index: usize) {
        self.sheets_rewritten.insert(sheet_index);
    }
}

// ============================================================================
// CustomRestore registry (A3.4) — the backend undo/restore extension seam.
//
// A CellChange::CustomRestore carries a string `kind` + opaque bytes. This
// registry maps each kind to { restore_fn, domains, defer } as DATA,
// replacing what used to be three hardcoded, drifting things: a `match` over
// kind, a fragile `kind.starts_with("pivot_"/"slicer"/…)` deferral check, and a
// hand-maintained kind→change-flag mapping. Adding a built-in feature's undo
// support is now one registry row + a one-line adapter, and the defer decision
// is EXPLICIT per kind (not pattern-matched on the name).
//
// `domains` is a SET, and it used to be a single `change_class`. That single
// value is why the NON-CELL domains announced nothing on undo: a kind can be
// two things at once — `obj_validation` is an object-store swap AND a
// validation change — so the one field it had to fit into could only ever name
// the first. `UndoResult`'s five legacy booleans are now DERIVED from this set,
// which leaves one source of truth instead of a flag ladder and a domain list
// that drift apart.
//
// `defer` is load-bearing for deadlock-avoidance: a deferred restore acquires
// OTHER state locks (pivot/slicer/ribbon_filter/object) and MUST run only after
// the grid/style locks are released. Inline (non-deferred) restores touch just
// AppState sublocks that are safe to take while grid locks are held. Every
// `defer` value below is transcribed 1:1 from the prior match + prefix logic;
// see the registry-consistency unit test.
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
// The restore adapters carry a `&DocumentEffect` for the same reason every other
// mutation path does: an undo/redo restore rewrites persisted stores, so the leaves
// need the token to reach `Persisted::write`. `apply_changes` builds it once (see
// `DocumentEffect::mutates` there) and hands the same decision to every adapter.
type RestoreFn = fn(
    &AppState,
    &PivotState,
    &SlicerState,
    &RibbonFilterState,
    &PaneControlState,
    &crate::document_effect::DocumentEffect,
    &str,
    &[u8],
    &mut Transaction,
    &mut RestoreReport,
);

struct RestoreSpec {
    restore: RestoreFn,
    /// Every frontend domain this kind's restore affects. A SET, because a
    /// restore is routinely more than one thing at once (a validation swap is an
    /// object-store change AND a validation change), and the single-class field
    /// this replaces could only name one of them — which is why the non-cell
    /// domains announced nothing on undo.
    domains: MutationDomains,
    /// Defer until grid/style locks are released (avoids lock-ordering deadlock).
    defer: bool,
}

// --- Adapters: forward the uniform signature to each concrete restore fn. ----
fn r_comment(s: &AppState, _p: &PivotState, _sl: &SlicerState, _rf: &RibbonFilterState, _pc: &PaneControlState, e: &crate::document_effect::DocumentEffect, _k: &str, d: &[u8], inv: &mut Transaction, _rp: &mut RestoreReport) { apply_comment_restore(s, e, d, inv); }
fn r_note(s: &AppState, _p: &PivotState, _sl: &SlicerState, _rf: &RibbonFilterState, _pc: &PaneControlState, e: &crate::document_effect::DocumentEffect, _k: &str, d: &[u8], inv: &mut Transaction, _rp: &mut RestoreReport) { apply_note_restore(s, e, d, inv); }
fn r_hyperlink(s: &AppState, _p: &PivotState, _sl: &SlicerState, _rf: &RibbonFilterState, _pc: &PaneControlState, e: &crate::document_effect::DocumentEffect, _k: &str, d: &[u8], inv: &mut Transaction, _rp: &mut RestoreReport) { apply_hyperlink_restore(s, e, d, inv); }
fn r_default_dim(s: &AppState, _p: &PivotState, _sl: &SlicerState, _rf: &RibbonFilterState, _pc: &PaneControlState, e: &crate::document_effect::DocumentEffect, k: &str, d: &[u8], inv: &mut Transaction, _rp: &mut RestoreReport) { apply_default_dimension_restore(s, e, k, d, inv); }
fn r_pivot_definition(s: &AppState, p: &PivotState, _sl: &SlicerState, rf: &RibbonFilterState, pc: &PaneControlState, e: &crate::document_effect::DocumentEffect, _k: &str, d: &[u8], inv: &mut Transaction, _rp: &mut RestoreReport) { apply_pivot_definition_restore(s, p, rf, pc, e, d, inv); }
fn r_pivot_create(s: &AppState, p: &PivotState, _sl: &SlicerState, _rf: &RibbonFilterState, _pc: &PaneControlState, e: &crate::document_effect::DocumentEffect, _k: &str, d: &[u8], inv: &mut Transaction, _rp: &mut RestoreReport) { apply_pivot_create_restore(s, p, d, inv, e); }
fn r_pivot_delete(s: &AppState, p: &PivotState, _sl: &SlicerState, rf: &RibbonFilterState, pc: &PaneControlState, e: &crate::document_effect::DocumentEffect, _k: &str, d: &[u8], inv: &mut Transaction, _rp: &mut RestoreReport) { apply_pivot_delete_restore(s, p, rf, pc, d, inv, e); }
fn r_slicer(_s: &AppState, _p: &PivotState, sl: &SlicerState, _rf: &RibbonFilterState, _pc: &PaneControlState, e: &crate::document_effect::DocumentEffect, _k: &str, d: &[u8], inv: &mut Transaction, _rp: &mut RestoreReport) { apply_slicer_restore(sl, e, d, inv); }
fn r_slicer_create(_s: &AppState, _p: &PivotState, sl: &SlicerState, _rf: &RibbonFilterState, _pc: &PaneControlState, e: &crate::document_effect::DocumentEffect, _k: &str, d: &[u8], inv: &mut Transaction, _rp: &mut RestoreReport) { apply_slicer_create_restore(sl, e, d, inv); }
fn r_slicer_delete(_s: &AppState, _p: &PivotState, sl: &SlicerState, _rf: &RibbonFilterState, _pc: &PaneControlState, e: &crate::document_effect::DocumentEffect, _k: &str, d: &[u8], inv: &mut Transaction, _rp: &mut RestoreReport) { apply_slicer_delete_restore(sl, e, d, inv); }
fn r_ribbon_filter(_s: &AppState, _p: &PivotState, _sl: &SlicerState, rf: &RibbonFilterState, _pc: &PaneControlState, e: &crate::document_effect::DocumentEffect, _k: &str, d: &[u8], inv: &mut Transaction, _rp: &mut RestoreReport) { apply_ribbon_filter_restore(rf, e, d, inv); }
fn r_ribbon_filter_create(_s: &AppState, _p: &PivotState, _sl: &SlicerState, rf: &RibbonFilterState, _pc: &PaneControlState, e: &crate::document_effect::DocumentEffect, _k: &str, d: &[u8], inv: &mut Transaction, _rp: &mut RestoreReport) { apply_ribbon_filter_create_restore(rf, e, d, inv); }
fn r_ribbon_filter_delete(_s: &AppState, _p: &PivotState, _sl: &SlicerState, rf: &RibbonFilterState, _pc: &PaneControlState, e: &crate::document_effect::DocumentEffect, _k: &str, d: &[u8], inv: &mut Transaction, _rp: &mut RestoreReport) { apply_ribbon_filter_delete_restore(rf, e, d, inv); }
fn r_pane_control(_s: &AppState, _p: &PivotState, _sl: &SlicerState, _rf: &RibbonFilterState, pc: &PaneControlState, _e: &crate::document_effect::DocumentEffect, _k: &str, d: &[u8], inv: &mut Transaction, _rp: &mut RestoreReport) { apply_pane_control_restore(pc, d, inv); }
fn r_pane_control_create(_s: &AppState, _p: &PivotState, _sl: &SlicerState, _rf: &RibbonFilterState, pc: &PaneControlState, _e: &crate::document_effect::DocumentEffect, _k: &str, d: &[u8], inv: &mut Transaction, _rp: &mut RestoreReport) { apply_pane_control_create_restore(pc, d, inv); }
fn r_pane_control_delete(_s: &AppState, _p: &PivotState, _sl: &SlicerState, _rf: &RibbonFilterState, pc: &PaneControlState, _e: &crate::document_effect::DocumentEffect, _k: &str, d: &[u8], inv: &mut Transaction, _rp: &mut RestoreReport) { apply_pane_control_delete_restore(pc, d, inv); }
fn r_object_swap(s: &AppState, _p: &PivotState, _sl: &SlicerState, _rf: &RibbonFilterState, _pc: &PaneControlState, e: &crate::document_effect::DocumentEffect, k: &str, d: &[u8], inv: &mut Transaction, rp: &mut RestoreReport) { apply_object_swap_restore(s, e, k, d, inv, rp); }
fn r_script_grid_cells(s: &AppState, _p: &PivotState, _sl: &SlicerState, _rf: &RibbonFilterState, _pc: &PaneControlState, e: &crate::document_effect::DocumentEffect, _k: &str, d: &[u8], inv: &mut Transaction, rp: &mut RestoreReport) { apply_script_grid_cells_restore(s, e, d, inv, rp); }
fn r_sheet_merge_regions(s: &AppState, _p: &PivotState, _sl: &SlicerState, _rf: &RibbonFilterState, _pc: &PaneControlState, e: &crate::document_effect::DocumentEffect, _k: &str, d: &[u8], inv: &mut Transaction, rp: &mut RestoreReport) { apply_sheet_merge_regions_restore(s, e, d, inv, rp); }
fn r_sheet_structural(s: &AppState, _p: &PivotState, _sl: &SlicerState, _rf: &RibbonFilterState, _pc: &PaneControlState, e: &crate::document_effect::DocumentEffect, _k: &str, d: &[u8], inv: &mut Transaction, rp: &mut RestoreReport) { apply_sheet_structural_restore(s, e, d, inv, rp); }
fn r_report_restore(s: &AppState, _p: &PivotState, _sl: &SlicerState, _rf: &RibbonFilterState, _pc: &PaneControlState, e: &crate::document_effect::DocumentEffect, _k: &str, d: &[u8], inv: &mut Transaction, rp: &mut RestoreReport) { apply_report_restore(s, e, d, inv, rp); }
fn r_calp_reset(s: &AppState, _p: &PivotState, _sl: &SlicerState, _rf: &RibbonFilterState, _pc: &PaneControlState, e: &crate::document_effect::DocumentEffect, _k: &str, d: &[u8], inv: &mut Transaction, rp: &mut RestoreReport) { apply_calp_reset_restore(s, e, d, inv, rp); }
fn r_outline(s: &AppState, _p: &PivotState, _sl: &SlicerState, _rf: &RibbonFilterState, _pc: &PaneControlState, e: &crate::document_effect::DocumentEffect, _k: &str, d: &[u8], inv: &mut Transaction, _rp: &mut RestoreReport) { apply_outline_restore(s, e, d, inv); }
fn r_user_hidden(s: &AppState, _p: &PivotState, _sl: &SlicerState, _rf: &RibbonFilterState, _pc: &PaneControlState, e: &crate::document_effect::DocumentEffect, _k: &str, d: &[u8], inv: &mut Transaction, _rp: &mut RestoreReport) { apply_user_hidden_restore(s, e, d, inv); }
fn r_pivot_col_widths(s: &AppState, _p: &PivotState, _sl: &SlicerState, _rf: &RibbonFilterState, _pc: &PaneControlState, e: &crate::document_effect::DocumentEffect, _k: &str, d: &[u8], inv: &mut Transaction, _rp: &mut RestoreReport) { apply_pivot_col_widths_restore(s, e, d, inv); }

/// The kind → spec table, built once.
static RESTORE_REGISTRY: Lazy<HashMap<&'static str, RestoreSpec>> = Lazy::new(|| {
    use MutationDomain::*;
    const NONE: MutationDomains = MutationDomains::none();
    const OBJ: MutationDomains = MutationDomains::of(Objects);
    let mut m: HashMap<&'static str, RestoreSpec> = HashMap::new();
    // Inline (defer: false) — simple metadata restores, no cross-state lock.
    //
    // These four used to declare NO domain at all, which is precisely why
    // undoing a note, a comment or a hyperlink told the frontend nothing and
    // left its cache — and therefore the painted grid — showing the undone
    // state until something unrelated forced a refresh.
    m.insert("comment", RestoreSpec { restore: r_comment, domains: MutationDomains::of(Annotations), defer: false });
    m.insert("note", RestoreSpec { restore: r_note, domains: MutationDomains::of(Annotations), defer: false });
    m.insert("hyperlink", RestoreSpec { restore: r_hyperlink, domains: MutationDomains::of(Hyperlinks), defer: false });
    // Default row height / column width: geometry, re-read through the
    // dimension refresh the frontend already runs, so no store domain.
    m.insert("default_row_height", RestoreSpec { restore: r_default_dim, domains: NONE, defer: false });
    m.insert("default_column_width", RestoreSpec { restore: r_default_dim, domains: NONE, defer: false });
    // A pivot auto-fit's column resize (BUG-0014). Geometry, like the two
    // above, so no store domain — the frontend re-reads dimensions on the
    // refresh it already runs.
    //
    // DEFERRED, and the first version of this was not. `apply_changes` takes
    // `column_widths` at the top of the pass and holds it until the inline
    // restores are done, so an INLINE handler that reaches for
    // `state.column_widths.write(..)` deadlocks against its own caller — std's
    // RwLock is not reentrant. Measured: the app stopped answering on the first
    // undo the journey spec performed, and the harness reported it as "the
    // application went away", not as a lock bug. The deferred pass runs after
    // every grid/style/width lock is dropped, which is exactly the contract the
    // pivot/slicer/ribbon-filter restores already rely on.
    m.insert(PIVOT_COL_WIDTHS_RESTORE_KIND, RestoreSpec { restore: r_pivot_col_widths, domains: NONE, defer: true });
    // Deferred (defer: true) — acquire other state locks; run after grid locks drop.
    m.insert(PIVOT_DEFINITION_RESTORE_KIND, RestoreSpec { restore: r_pivot_definition, domains: MutationDomains::of(Pivot), defer: true });
    m.insert("pivot_create", RestoreSpec { restore: r_pivot_create, domains: MutationDomains::of(Pivot), defer: true });
    m.insert("pivot_delete", RestoreSpec { restore: r_pivot_delete, domains: MutationDomains::of(Pivot), defer: true });
    m.insert("slicer", RestoreSpec { restore: r_slicer, domains: MutationDomains::of(Slicer), defer: true });
    m.insert("slicer_create", RestoreSpec { restore: r_slicer_create, domains: MutationDomains::of(Slicer), defer: true });
    m.insert("slicer_delete", RestoreSpec { restore: r_slicer_delete, domains: MutationDomains::of(Slicer), defer: true });
    m.insert("ribbon_filter", RestoreSpec { restore: r_ribbon_filter, domains: MutationDomains::of(RibbonFilter), defer: true });
    m.insert("ribbon_filter_create", RestoreSpec { restore: r_ribbon_filter_create, domains: MutationDomains::of(RibbonFilter), defer: true });
    m.insert("ribbon_filter_delete", RestoreSpec { restore: r_ribbon_filter_delete, domains: MutationDomains::of(RibbonFilter), defer: true });
    m.insert("pane_control", RestoreSpec { restore: r_pane_control, domains: MutationDomains::of(PaneControl), defer: true });
    m.insert("pane_control_create", RestoreSpec { restore: r_pane_control_create, domains: MutationDomains::of(PaneControl), defer: true });
    m.insert("pane_control_delete", RestoreSpec { restore: r_pane_control_delete, domains: MutationDomains::of(PaneControl), defer: true });
    // Object-store swaps. Most are only "objects"; the ones that ALSO own a
    // non-cell frontend cache name that cache too, which is the whole point of
    // the domain being a set — `grid:refresh` does not make the Validation
    // extension re-read its rules, and never did.
    for (k, extra) in [
        ("obj_chart", NONE), ("obj_sparklines", NONE), ("obj_table", NONE),
        ("obj_autofilter", NONE),
        ("obj_validation", MutationDomains::of(Validations)),
        ("obj_named_range", NONE), ("obj_freeze", NONE), ("obj_extension_data", NONE),
        ("obj_cell_types", NONE), ("obj_cell_behaviors", NONE),
        ("obj_writeback_regions", NONE), ("obj_object_scripts", NONE),
        // Per-sheet cell-keyed stores moved by a structural edit.
        ("obj_comments", MutationDomains::of(Annotations)),
        ("obj_notes", MutationDomains::of(Annotations)),
        ("obj_hyperlinks", MutationDomains::of(Hyperlinks)),
        ("obj_conditional_formats", MutationDomains::of(ConditionalFormats)),
        ("obj_sheet_protection", NONE), ("obj_sheet_protection_record", NONE),
        // Carries the per-sheet OUTLINE among its four stores.
        ("obj_coord_stores", MutationDomains::of(Outline)),
        ("obj_named_ranges", NONE), ("obj_range_strings", NONE),
        ("obj_cross_sheet_formulas", NONE),
        ("obj_controls", MutationDomains::of(Controls)),
        ("obj_style_tiers", NONE), ("obj_workbook_protection", NONE),
    ] {
        let mut domains = OBJ;
        domains.extend(extra);
        m.insert(k, RestoreSpec { restore: r_object_swap, domains, defer: true });
    }
    // Row/column groups, on their own (group/ungroup/collapse/expand/clear).
    // Not an object store — the outline is its own per-sheet state and its own
    // frontend cache.
    m.insert(OUTLINE_RESTORE_KIND, RestoreSpec { restore: r_outline, domains: MutationDomains::of(Outline), defer: true });
    // Off-active-sheet cell writes from a script / AI tool (apply_script_modified_grids).
    // Deferred: re-acquires the grid/grids/active-sheet locks (released by the time
    // deferred restores run). Tagged Objects so the frontend fires grid:refresh on
    // undo/redo (re-fetches the active viewport when the restored sheet IS active;
    // a non-active restored sheet re-materializes from grids[idx] on sheet switch).
    m.insert("script_grid_cells", RestoreSpec { restore: r_script_grid_cells, domains: OBJ, defer: true });
    // Wave 3 cross-sheet structural ops: per-sheet merge-set swap and per-sheet
    // full structural snapshot. Deferred for the same reason as
    // script_grid_cells (they re-acquire the grid/grids/active-sheet locks);
    // tagged Objects so the frontend fires grid:refresh on undo/redo.
    m.insert("sheet_merge_regions", RestoreSpec { restore: r_sheet_merge_regions, domains: OBJ, defer: true });
    m.insert("sheet_structural_snapshot", RestoreSpec { restore: r_sheet_structural, domains: OBJ, defer: true });
    // Grid reports: cell-based restore of the report cells + definitions + region.
    // Tagged Objects so the frontend fires grid:refresh on undo/redo.
    m.insert("report_restore", RestoreSpec { restore: r_report_restore, domains: OBJ, defer: true });
    // Subscription reset: whole-sheet swap (cells/widths/heights/merges) +
    // override-layer swap for the reset sheets. Deferred (re-acquires grid
    // locks); tagged Objects so the frontend fires grid:refresh on undo/redo.
    m.insert("calp_reset", RestoreSpec { restore: r_calp_reset, domains: OBJ, defer: true });
    // User hide/unhide of rows/columns. Inline: it touches only the
    // user_hidden_* AppState sublocks, which nothing else holds while the grid
    // locks are held. Its own change class so the frontend re-reads the hidden
    // sets — no cell in `updated_cells` reveals a visibility change.
    m.insert(USER_HIDDEN_RESTORE_KIND, RestoreSpec { restore: r_user_hidden, domains: MutationDomains::of(Hidden), defer: false });
    m
});

/// Look up the restore spec for a custom-restore `kind` (None ⇒ unknown kind).
fn restore_spec(kind: &str) -> Option<&'static RestoreSpec> {
    RESTORE_REGISTRY.get(kind)
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
    effect: &crate::document_effect::DocumentEffect,
    data: &[u8],
    inverse_transaction: &mut Transaction,
    report: &mut RestoreReport,
) {
    let snapshot: ScriptGridCellsSnapshot = match serde_json::from_slice(data) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("[undo] Failed to deserialize script_grid_cells snapshot: {}", e);
            return;
        }
    };
    // The cells are restored with their cached values, but formulas on OTHER
    // sheets that read them are not — report the sheet so `apply_changes` runs
    // the shared off-sheet cascade over it.
    report.wrote_sheet(snapshot.sheet_index);

    let mut mirror = state.grid.write(&effect).unwrap();
    let mut grids = state.grids.write(&effect).unwrap();
    let active_sheet = *state.active_sheet.read().unwrap();

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

/// Serialized payload for the `"sheet_merge_regions"` CustomRestore — ONE
/// sheet's full merged-region set as it was before an off-active-sheet
/// merge/unmerge (Wave 3 cross-sheet structural ops). A whole-set swap, because
/// per-sheet merge sets are small and the swap is symmetric: restore captures
/// the then-current set as the inverse, so redo re-applies the post-op set.
/// Slave-cell content travels separately as a `script_grid_cells` entry in the
/// SAME transaction.
#[derive(serde::Deserialize, serde::Serialize)]
pub(crate) struct SheetMergeRegionsSnapshot {
    pub sheet_index: usize,
    pub regions: Vec<crate::api_types::MergedRegion>,
}

/// Serialized "sheet_merge_regions" snapshot bytes (in-open-transaction
/// contract, same as `script_grid_cells_snapshot_bytes`).
pub(crate) fn sheet_merge_regions_snapshot_bytes(
    sheet_index: usize,
    regions: Vec<crate::api_types::MergedRegion>,
) -> Vec<u8> {
    serde_json::to_vec(&SheetMergeRegionsSnapshot { sheet_index, regions }).unwrap_or_default()
}

/// Restore (undo/redo) one sheet's merged-region set. `with_sheet_merges`
/// resolves the mirror-vs-per-sheet-store split, so this works whether or not
/// the target sheet is active at undo time.
fn apply_sheet_merge_regions_restore(
    state: &AppState,
    effect: &crate::document_effect::DocumentEffect,
    data: &[u8],
    inverse_transaction: &mut Transaction,
    report: &mut RestoreReport,
) {
    let snapshot: SheetMergeRegionsSnapshot = match serde_json::from_slice(data) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("[undo] Failed to deserialize sheet_merge_regions snapshot: {}", e);
            return;
        }
    };
    report.wrote_sheet(snapshot.sheet_index);

    let previous = crate::report::with_sheet_merges_mut(state, effect, snapshot.sheet_index, |merged| {
        let prev: Vec<crate::api_types::MergedRegion> = merged.iter().cloned().collect();
        merged.clear();
        for r in &snapshot.regions {
            merged.insert(r.clone());
        }
        prev
    });

    inverse_transaction.add_change(CellChange::CustomRestore {
        kind: "sheet_merge_regions".to_string(),
        data: serde_json::to_vec(&SheetMergeRegionsSnapshot {
            sheet_index: snapshot.sheet_index,
            regions: previous,
        })
        .unwrap_or_default(),
    });
}

/// Serialized payload for the `"sheet_structural_snapshot"` CustomRestore —
/// one sheet's FULL grid state (cells, heights, widths, merges, style tiers)
/// before an off-active-sheet insert/delete rows/columns (Wave 3 cross-sheet
/// structural ops). The active-sheet twin of this is the engine-level
/// `CellChange::RestoreSnapshot`, which can only ever target the mirror — this
/// kind carries the sheet index so undo restores the RIGHT sheet no matter
/// which sheet is active by then.
#[derive(serde::Deserialize, serde::Serialize)]
pub(crate) struct SheetStructuralSnapshot {
    pub sheet_index: usize,
    pub cells: Vec<(u32, u32, engine::Cell)>,
    pub row_heights: HashMap<u32, f64>,
    pub column_widths: HashMap<u32, f64>,
    pub merges: Vec<crate::api_types::MergedRegion>,
    pub row_styles: Vec<(u32, usize)>,
    pub column_styles: Vec<(u32, usize)>,
}

/// Serialized "sheet_structural_snapshot" bytes (in-open-transaction contract;
/// a serialization failure restores nothing, so it is logged like
/// `script_grid_cells_snapshot_bytes`).
pub(crate) fn sheet_structural_snapshot_bytes(snapshot: &SheetStructuralSnapshot) -> Vec<u8> {
    match serde_json::to_vec(snapshot) {
        Ok(bytes) => bytes,
        Err(e) => {
            crate::log_error!(
                "UNDO",
                "sheet_structural_snapshot for sheet {} could not be serialized ({}); this undo entry will restore nothing",
                snapshot.sheet_index + 1,
                e
            );
            Vec::new()
        }
    }
}

/// Capture one sheet's full structural state (the counterpart of
/// `capture_grid_snapshot` for a NON-ACTIVE sheet: reads `grids[idx]` and the
/// per-sheet stores; reads the mirrors when `idx` IS active, since the
/// per-sheet stores are then empty by take-semantics).
pub(crate) fn capture_sheet_structural_snapshot(
    state: &AppState,
    sheet_index: usize,
) -> Result<SheetStructuralSnapshot, String> {
    let grids = state.grids.read().map_err(|e| e.to_string())?;
    let active = *state.active_sheet.read().map_err(|e| e.to_string())?;
    let grid = grids
        .get(sheet_index)
        .ok_or_else(|| format!("Sheet index {} out of range", sheet_index))?;
    let is_active = sheet_index == active;

    let row_heights = if is_active {
        state.row_heights.read().map_err(|e| e.to_string())?.clone()
    } else {
        state
            .all_row_heights
            .read()
            .map_err(|e| e.to_string())?
            .get(sheet_index)
            .cloned()
            .unwrap_or_default()
    };
    let column_widths = if is_active {
        state.column_widths.read().map_err(|e| e.to_string())?.clone()
    } else {
        state
            .all_column_widths
            .read()
            .map_err(|e| e.to_string())?
            .get(sheet_index)
            .cloned()
            .unwrap_or_default()
    };
    let cells = grid
        .cells
        .iter()
        .map(|(&(r, c), cell)| (r, c, cell.clone()))
        .collect();
    let row_styles = grid.row_styles.iter().map(|(k, v)| (*k, *v)).collect();
    let column_styles = grid.column_styles.iter().map(|(k, v)| (*k, *v)).collect();
    drop(grids);

    let merges = crate::report::with_sheet_merges(state, sheet_index, |merged| {
        merged.iter().cloned().collect::<Vec<_>>()
    });

    Ok(SheetStructuralSnapshot {
        sheet_index,
        cells,
        row_heights,
        column_widths,
        merges,
        row_styles,
        column_styles,
    })
}

/// Restore (undo/redo) one sheet's full structural state, capturing the
/// then-current state as the symmetric inverse. Follows the calp_reset
/// restore's lock order (grids, active_sheet, mirror, mirror dims, all dims);
/// merges go through `with_sheet_merges` in their own scope. Cells carry their
/// cached values, so no recalc of the restored sheet is needed; the caller
/// (`apply_changes`) re-evaluates the active sheet and rebuilds dependency
/// maps via the `sheet_structural_snapshot` kind checks.
fn apply_sheet_structural_restore(
    state: &AppState,
    effect: &crate::document_effect::DocumentEffect,
    data: &[u8],
    inverse_transaction: &mut Transaction,
    report: &mut RestoreReport,
) {
    let snapshot: SheetStructuralSnapshot = match serde_json::from_slice(data) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("[undo] Failed to deserialize sheet_structural_snapshot: {}", e);
            return;
        }
    };
    let idx = snapshot.sheet_index;
    report.wrote_sheet(idx);

    let mut inverse = {
        let mut mirror = state.grid.write(&effect).unwrap();
        let mut grids = state.grids.write(&effect).unwrap();
        let active = *state.active_sheet.read().unwrap();
        let mut mirror_cw = state.column_widths.write(&effect).unwrap();
        let mut mirror_rh = state.row_heights.write(&effect).unwrap();
        let mut all_cw = state.all_column_widths.write(&effect).unwrap();
        let mut all_rh = state.all_row_heights.write(&effect).unwrap();
        if idx >= grids.len() {
            return;
        }
        let is_active = idx == active;

        let inverse = SheetStructuralSnapshot {
            sheet_index: idx,
            cells: grids[idx]
                .cells
                .iter()
                .map(|(&(r, c), cell)| (r, c, cell.clone()))
                .collect(),
            row_heights: if is_active {
                mirror_rh.clone()
            } else {
                all_rh.get(idx).cloned().unwrap_or_default()
            },
            column_widths: if is_active {
                mirror_cw.clone()
            } else {
                all_cw.get(idx).cloned().unwrap_or_default()
            },
            merges: Vec::new(), // filled in the merge pass below
            row_styles: grids[idx].row_styles.iter().map(|(k, v)| (*k, *v)).collect(),
            column_styles: grids[idx].column_styles.iter().map(|(k, v)| (*k, *v)).collect(),
        };

        let mut restored = engine::Grid::new();
        for (row, col, cell) in &snapshot.cells {
            restored.set_cell(*row, *col, cell.clone());
        }
        restored.row_styles = snapshot.row_styles.iter().map(|(k, v)| (*k, *v)).collect();
        restored.column_styles = snapshot.column_styles.iter().map(|(k, v)| (*k, *v)).collect();
        grids[idx] = restored;
        if idx < all_cw.len() {
            all_cw[idx] = snapshot.column_widths.clone();
        }
        if idx < all_rh.len() {
            all_rh[idx] = snapshot.row_heights.clone();
        }
        if is_active {
            *mirror = grids[idx].clone();
            *mirror_cw = snapshot.column_widths.clone();
            *mirror_rh = snapshot.row_heights.clone();
        }
        inverse
    };

    inverse.merges = crate::report::with_sheet_merges_mut(state, &effect, idx, |merged| {
        let prev: Vec<crate::api_types::MergedRegion> = merged.iter().cloned().collect();
        merged.clear();
        for m in &snapshot.merges {
            merged.insert(m.clone());
        }
        prev
    });

    inverse_transaction.add_change(CellChange::CustomRestore {
        kind: "sheet_structural_snapshot".to_string(),
        data: sheet_structural_snapshot_bytes(&inverse),
    });
}

/// Restore a grid-report snapshot for undo/redo: restore the affected cells, the
/// report-definitions list, and each report's protected region, then record the
/// current state as the inverse (redo). Cell-based (mirrors script_grid_cells),
/// so it works offline without re-running the design query.
fn apply_report_restore(
    state: &AppState,
    effect: &crate::document_effect::DocumentEffect,
    data: &[u8],
    inverse_transaction: &mut Transaction,
    report: &mut RestoreReport,
) {
    let snapshot: crate::report::ReportUndoSnapshot = match serde_json::from_slice(data) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("[undo] Failed to deserialize report snapshot: {}", e);
            return;
        }
    };
    // THE COORDINATE GAP THIS CLOSES. A report restore swaps a whole BOX of
    // cells on a known sheet and carries their cached values, so its own sheet
    // reads correctly the instant the swap lands. What used to stay stale was
    // another sheet's formula pointing into the box — because this restore
    // reported nothing at all, and the cascade seeds off reported cells.
    // Reporting the SHEET is the right granularity: the box is a whole region,
    // not a handful of seeds, and the shared off-sheet cascade re-evaluates the
    // sheet and then the active one.
    report.wrote_sheet(snapshot.sheet_index);

    // --- Restore grid cells (capture current for the inverse/redo) ---
    let mut inverse_cells: Vec<(u32, u32, Option<engine::Cell>)> =
        Vec::with_capacity(snapshot.cells.len());
    {
        let mut mirror = state.grid.write(&effect).unwrap();
        let mut grids = state.grids.write(&effect).unwrap();
        let active_sheet = *state.active_sheet.read().unwrap();
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
        crate::report::with_sheet_merges_mut(state, effect, snapshot.sheet_index, |merged| {
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
    let current_defs = crate::report::with_reports_mut(state, effect, |defs| {
        std::mem::replace(defs, snapshot.definitions.clone())
    });
    {
        let mut regions = state.protected_regions.lock().unwrap();
        regions.retain(|r| r.region_type != "report");
    }
    for r in &snapshot.definitions {
        crate::report::reregister_report_region(state, r);
    }

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
    effect: &crate::document_effect::DocumentEffect,
    data: &[u8],
    inverse_transaction: &mut Transaction,
    report: &mut RestoreReport,
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
        // Same reason as `apply_report_restore`: this replaces whole SHEETS and
        // carries their cached values, so the stale cells are the ones on other
        // sheets reading into them. Reported per sheet, before the `continue`
        // guard below can skip an out-of-range index.
        report.wrote_sheet(idx);

        // --- Cells + widths/heights (locks scoped per sheet, in the
        // set_active_sheet canonical order: grids, active_sheet, grid mirror,
        // column_widths, row_heights, all_cw, all_rh). The ACTIVE sheet's
        // widths/heights live in the MIRRORS (take-semantics) — capture and
        // restore through them for that sheet.
        let mut inverse = {
            let mut mirror = state.grid.write(&effect).unwrap();
            let mut grids = state.grids.write(&effect).unwrap();
            let active = *state.active_sheet.read().unwrap();
            let mut mirror_cw = state.column_widths.write(&effect).unwrap();
            let mut mirror_rh = state.row_heights.write(&effect).unwrap();
            let mut all_cw = state.all_column_widths.write(&effect).unwrap();
            let mut all_rh = state.all_row_heights.write(&effect).unwrap();
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
        inverse.merges = crate::report::with_sheet_merges_mut(state, &effect, idx, |merged| {
            let prev: Vec<crate::MergedRegion> = merged.iter().cloned().collect();
            *merged = sheet.merges.iter().cloned().collect();
            prev
        });

        inverse_sheets.push(inverse);
    }

    // --- Override layer: swap the affected sheets' entries ---
    let inverse_overrides = {
        let mut layer = state.override_layer.write(effect).unwrap();
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
    effect: &crate::document_effect::DocumentEffect,
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

    let mut comments = state.comments.write(effect).unwrap();
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
    effect: &crate::document_effect::DocumentEffect,
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

    let mut notes = state.notes.write(effect).unwrap();
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
    effect: &crate::document_effect::DocumentEffect,
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

    let mut hyperlinks = state.hyperlinks.write(effect).unwrap();
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
    effect: &crate::document_effect::DocumentEffect,
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
            let mut h = state.default_row_height.write(effect).unwrap();
            let current = *h;
            inverse_transaction.add_change(CellChange::CustomRestore {
                kind: kind.to_string(),
                data: serde_json::to_vec(&current).unwrap_or_default(),
            });
            *h = value;
        }
        "default_column_width" => {
            let mut w = state.default_column_width.write(effect).unwrap();
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

/// Recalculate SUBTOTAL/AGGREGATE after an undo/redo that moved ROW
/// VISIBILITY.
///
/// `hidden_changed` is already the flag that tells the frontend "re-read the
/// hidden sets, nothing in `updated_cells` reveals this" — and the same is true
/// of the two functions whose value depends on visibility. Undoing a hide
/// without this leaves the pre-undo total on screen and in the saved file.
///
/// Runs only when the flag is set, so the ordinary cell-edit undo pays one
/// bool test. Errors are swallowed: the undo itself already succeeded.
fn recalc_visibility_after_undo(
    app: &tauri::AppHandle,
    state: &AppState,
    user_files_state: &UserFilesState,
    pivot_state: &PivotState,
    pane_control_state: &PaneControlState,
    ribbon_filter_state: &RibbonFilterState,
    result: &UndoResult,
) {
    if !result.success || !result.hidden_changed {
        return;
    }
    crate::commands::dimensions::recalc_visibility_after_row_change(
        app,
        state,
        user_files_state,
        pivot_state,
        pane_control_state,
        ribbon_filter_state,
    );
}

/// Perform undo operation.
#[tauri::command]
pub fn undo(
    app: tauri::AppHandle,
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
                    hidden_changed: false,
                    refresh_domains: Vec::new(),
                };
            }
        }
    };

    let result = apply_changes(&state, &file_state, &user_files_state, &pivot_state, &slicer_state, &ribbon_filter_state, &pane_control_state, transaction, true);
    recalc_visibility_after_undo(&app, &state, &user_files_state, &pivot_state, &pane_control_state, &ribbon_filter_state, &result);
    result
}

/// Perform redo operation.
#[tauri::command]
pub fn redo(
    app: tauri::AppHandle,
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
                    hidden_changed: false,
                    refresh_domains: Vec::new(),
                };
            }
        }
    };

    let result = apply_changes(&state, &file_state, &user_files_state, &pivot_state, &slicer_state, &ribbon_filter_state, &pane_control_state, transaction, false);
    recalc_visibility_after_undo(&app, &state, &user_files_state, &pivot_state, &pane_control_state, &ribbon_filter_state, &result);
    result
}

// `clear_undo_history` USED TO BE HERE, and it was deleted rather than wired up
// (2026-08-10, defect 4a).
//
// It was a `#[tauri::command]` with no product caller anywhere — no menu item,
// no command, no frontend invoke — whose own doc comment named the route it was
// missing: "e.g., when opening a new file". That route is real, and it is now
// `persistence::reset_document_scoped_stores`, which BOTH document-replacing
// paths run. Re-exposing the same clear as a command would put the undo stack's
// lifetime back into somebody's hands to remember, which is precisely the shape
// that let the stack outlive its document in the first place.
//
// There is no user-facing reason for the command either: Excel exposes no
// "clear undo history" action, and the stack's lifetime IS the document's — the
// user asks for it by closing the document, not by asking for it. Its only
// caller was E2E walker setup (`app/e2e/walker/reset.ts`), where it was already
// redundant: that helper calls `new_file` immediately before, which resets the
// stack through the shared function.
//
// Every command also costs main-thread stack in `generate_handler!` (32MB
// reserve, ~660 commands), so an unused one is not free.

// ============================================================================
// PIVOT TABLE UNDO/REDO HANDLERS
// ============================================================================

/// The restore kind every pivot-definition undo records under. One constant, so
/// the four places that record one cannot drift from the one place that reads it.
pub(crate) const PIVOT_DEFINITION_RESTORE_KIND: &str = "pivot_definition";

/// Snapshot of a pivot definition for undo/redo.
/// Optionally includes cells that were overwritten when the pivot expanded,
/// so that `undo_pivot_overwrite` can restore them when the user cancels.
#[derive(serde::Serialize, serde::Deserialize)]
pub(crate) struct PivotDefinitionSnapshot {
    pub(crate) pivot_id: pivot_engine::PivotId,
    pub(crate) definition: PivotDefinition,
    /// Cells overwritten by the pivot expansion.
    /// Empty when no cells were overwritten.
    #[serde(default)]
    pub(crate) overwritten_cells: Vec<crate::pivot::operations::SavedCell>,
    /// Sheet index where overwritten cells lived.
    #[serde(default)]
    pub(crate) dest_sheet_idx: usize,
    /// The CACHE as it was, for the commands that replace it.
    ///
    /// A field change re-renders the SAME records, so the definition alone is a
    /// complete description of what to put back and this stays `None` — the
    /// cache can be large, and cloning one per field change would be a real
    /// cost. But `change_pivot_data_source` rebuilds the cache from a different
    /// range and `update_bi_pivot_fields` re-queries the model for one, and
    /// restoring an old definition against the NEW records renders something
    /// that was never on screen: field indices that mean different columns, or
    /// rows the old definition never had. Those two record the cache (BUG-0021,
    /// BUG-0022). `None` means "the cache was not touched — leave it alone".
    #[serde(default)]
    pub(crate) cache: Option<pivot_engine::PivotCache>,
}

/// Read a pivot-definition undo snapshot back.
///
/// The one decoder, for the same reason there is one encoder: `undo_pivot_overwrite`
/// carried its own private copy of the struct, so the cache field this snapshot
/// grew would have been invisible to it — and it would have gone on restoring a
/// definition against records from a different query, which is the very defect
/// the field exists to close.
pub(crate) fn decode_pivot_definition_snapshot(data: &[u8]) -> Option<PivotDefinitionSnapshot> {
    serde_json::from_slice(data).ok()
}

/// Serialize a pivot-definition undo snapshot.
///
/// THE ONE WRITER. This payload had three independent authors — the pivot
/// commands, the MCP object tools (as an untyped `json!` literal) and the .calp
/// reset — against a single reader, so a field added here reached one of them
/// and was silently defaulted away in the others. `cache` is exactly such a
/// field.
pub(crate) fn encode_pivot_definition_snapshot(
    pivot_id: pivot_engine::PivotId,
    definition: PivotDefinition,
    overwritten_cells: Vec<crate::pivot::operations::SavedCell>,
    dest_sheet_idx: usize,
    cache: Option<pivot_engine::PivotCache>,
) -> Vec<u8> {
    let snapshot = PivotDefinitionSnapshot {
        pivot_id,
        definition,
        overwritten_cells,
        dest_sheet_idx,
        cache,
    };
    serde_json::to_vec(&snapshot).unwrap_or_default()
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
    effect: &crate::document_effect::DocumentEffect,
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

    let mut pivot_tables = pivot_state.pivot_tables.write(effect).unwrap();
    if let Some((definition, cache)) = pivot_tables.get_mut(&pivot_id) {
        // Save current definition for inverse transaction
        let dest_sheet_idx_current = resolve_dest_sheet_index(state, definition);

        // THE INVERSE MIRRORS THE SNAPSHOT'S SHAPE. If this entry carries a
        // cache, the action it undoes replaced the cache — so redoing it has to
        // put the current one back too, or the redo would render the restored
        // definition against records from before the change.
        let inverse_data = encode_pivot_definition_snapshot(
            pivot_id,
            definition.clone(),
            // Overwritten cells for the inverse will be captured when redo runs
            Vec::new(),
            dest_sheet_idx_current,
            snapshot.cache.as_ref().map(|_| cache.clone()),
        );
        inverse_transaction.add_change(CellChange::CustomRestore {
            kind: PIVOT_DEFINITION_RESTORE_KIND.to_string(),
            data: inverse_data,
        });

        // Restore the old definition — and the records it was written against,
        // when the action being undone replaced them.
        *definition = snapshot.definition;
        if let Some(old_cache) = snapshot.cache {
            *cache = old_cache;
        }

        // Recalculate the view
        let view = safe_calculate_pivot(definition, cache);

        // Store view for windowed cell fetching
        pivot_state.views.lock().unwrap().insert(pivot_id, view.clone());

        let destination = definition.destination;
        let dest_sheet_idx = resolve_dest_sheet_index(state, definition);

        drop(pivot_tables);

        // Rewrite the grid
        finalize_pivot_update(state, effect, pivot_state, pivot_id, dest_sheet_idx, destination, &view, Some((pane_control_state, ribbon_filter_state)));

        // Restore cells that were overwritten by the previous pivot expansion
        if !snapshot.overwritten_cells.is_empty() {
            // CANONICAL GRID LOCK ORDER: `grid` before `grids` — see the note in
            // `state_digest.rs`. The mirror used to be taken inside the
            // active-sheet branch, i.e. AFTER `grids`, which is the order that
            // deadlocks against the background recalculation pass.
            let mut grid = state.grid.write(&effect).unwrap();
            let mut grids = state.grids.write(&effect).unwrap();
            if let Some(dest_grid) = grids.get_mut(snapshot.dest_sheet_idx) {
                for sc in &snapshot.overwritten_cells {
                    dest_grid.set_cell(sc.row, sc.col, sc.cell.clone());
                }
            }
            let active_sheet = *state.active_sheet.read().unwrap();
            if snapshot.dest_sheet_idx == active_sheet {
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
    effect: &crate::document_effect::DocumentEffect,
) {
    let snapshot: PivotFullSnapshot = match serde_json::from_slice(data) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("[undo] Failed to deserialize pivot create snapshot: {}", e);
            return;
        }
    };

    let pivot_id = snapshot.pivot_id;

    // CANONICAL LOCK ORDER: `grid`, `grids`, then everything else. The two grid
    // guards are needed only inside the `old_region` branch below, but taking
    // them THERE takes them while `pivot_tables` is held -- and the
    // recalculation pass holds both grid locks and then takes `pivot_tables` on
    // a background thread, which is a cycle. Neither `get_pivot_region` nor
    // `resolve_dest_sheet_index` touches a grid lock, so hoisting is safe.
    let mut grid = state.grid.write(&effect).unwrap();
    let mut grids = state.grids.write(&effect).unwrap();
    // Save current state for redo (redo = re-create the pivot)
    let mut pivot_tables = pivot_state.pivot_tables.write(effect).unwrap();
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
            // `grid` and `grids` were acquired at the top of the function -- see
            // the lock-order note there.
            if let Some(dest_grid) = grids.get_mut(dest_sheet_idx) {
                clear_pivot_region_from_grid(
                    dest_grid,
                    region.start_row, region.start_col,
                    region.end_row, region.end_col,
                );

                let active_sheet = *state.active_sheet.read().unwrap();
                if dest_sheet_idx == active_sheet {
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
    effect: &crate::document_effect::DocumentEffect,
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
    let mut pivot_tables = pivot_state.pivot_tables.write(effect).unwrap();
    pivot_tables.insert(pivot_id, (definition, cache));
    drop(pivot_tables);

    // Write to grid
    finalize_pivot_update(state, effect, pivot_state, pivot_id, dest_sheet_idx, destination, &view, Some((pane_control_state, ribbon_filter_state)));
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
    effect: &crate::document_effect::DocumentEffect,
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

    let mut slicers = slicer_state.slicers.write(effect).unwrap();
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
    effect: &crate::document_effect::DocumentEffect,
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

    let mut slicers = slicer_state.slicers.write(effect).unwrap();
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
    effect: &crate::document_effect::DocumentEffect,
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
    let mut slicers = slicer_state.slicers.write(effect).unwrap();
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
    effect: &crate::document_effect::DocumentEffect,
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

    let mut filters = ribbon_filter_state.filters.write(effect).unwrap();
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
    effect: &crate::document_effect::DocumentEffect,
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

    let mut filters = ribbon_filter_state.filters.write(effect).unwrap();
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
    effect: &crate::document_effect::DocumentEffect,
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

    let mut filters = ribbon_filter_state.filters.write(effect).unwrap();
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
    /// Tables whose `show_filter_button` moved WITH this filter, and the value
    /// to put back.
    ///
    /// For a table, "has an AutoFilter" and "shows filter buttons" are ONE
    /// state (Excel's `ListObject.ShowAutoFilter`), so removing the filter
    /// clears the flag — see `remove_auto_filter_inner`. The flag is persisted
    /// and the filter's ownership is re-derived FROM it, so an undo that put
    /// the filter back without the flag would restore an orphan: the filter
    /// would exist, `relink_autofilter_owner` would refuse to give it to a
    /// table that no longer advertises buttons, and the table's own filter
    /// would have stopped being the table's.
    ///
    /// Empty for every filter operation that only touches criteria.
    #[serde(default)]
    filter_buttons: Vec<(identity::EntityId, bool)>,
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
/// rules individually could not reproduce it. The same reason makes it the
/// right shape for the rule COMMANDS too: `add` recomputes a priority from the
/// current maximum and re-sorts, and `reorder` renumbers every rule, so no
/// per-rule inverse exists.
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

/// Record undo for a command that rewrites one sheet's conditional-format
/// rules. `previous` is the rule list BEFORE the mutation (empty = the sheet
/// had none, and undo restores exactly that).
///
/// Call AFTER dropping the `conditional_formats` guard: this takes the
/// undo-stack lock and `record_object_undo` opens its own transaction when
/// none is open.
pub(crate) fn record_conditional_formats_undo(
    state: &AppState,
    sheet_index: usize,
    previous: Vec<crate::conditional_formatting::ConditionalFormatDefinition>,
    description: &str,
) {
    let data = conditional_formats_snapshot_bytes(sheet_index, previous);
    record_object_undo(state, "obj_conditional_formats", data, description);
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
    serde_json::to_vec(&AutoFilterObjSnapshot {
        sheet_index,
        previous,
        filter_buttons: Vec::new(),
    })
    .unwrap_or_default()
}

/// Serialized "script_grid_cells" snapshot bytes (same in-open-transaction
/// contract as `table_snapshot_bytes`).
///
/// A serialization failure here means the undo entry restores NOTHING, so it is
/// logged at error level rather than swallowed. Callers record the payload after
/// their mutation already landed and cannot roll it back, so returning empty is
/// the only option left — it must at least be visible in the log. (Every
/// `engine::Cell` shape is representable since `parser::ast::Value` became
/// adjacently tagged; this is a tripwire, not an expected path.)
pub(crate) fn script_grid_cells_snapshot_bytes(
    sheet_index: usize,
    cells: Vec<(u32, u32, Option<engine::Cell>)>,
) -> Vec<u8> {
    let cell_count = cells.len();
    match serde_json::to_vec(&ScriptGridCellsSnapshot { sheet_index, cells }) {
        Ok(bytes) => bytes,
        Err(e) => {
            crate::log_error!(
                "UNDO",
                "script_grid_cells snapshot for sheet {} ({} cell(s)) could not be serialized ({}); this undo entry will restore nothing",
                sheet_index + 1,
                cell_count,
                e
            );
            Vec::new()
        }
    }
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
    effect: &crate::document_effect::DocumentEffect,
    kind: &str,
    data: &[u8],
    inverse_transaction: &mut Transaction,
    report: &mut RestoreReport,
) {
    match kind {
        "obj_chart" => {
            let snap: ChartObjSnapshot = match serde_json::from_slice(data) {
                Ok(s) => s,
                Err(e) => { eprintln!("[undo] bad obj_chart snapshot: {}", e); return; }
            };
            let mut charts = state.charts.write(effect).unwrap();
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
            let mut sparklines = state.sparklines.write(effect).unwrap();
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
            let mut tables = state.tables.write(effect).unwrap();
            let mut table_names = state.table_names.write(effect).unwrap();
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
            let (restored_filter, displaced_filter) = {
                let mut auto_filters = state.auto_filters.write(effect).unwrap();
                let current = auto_filters.remove(&snap.sheet_index);
                if let Some(prev) = snap.previous {
                    auto_filters.insert(snap.sheet_index, prev);
                }
                (auto_filters.get(&snap.sheet_index).cloned(), current)
            };
            // OWNERSHIP IS DERIVED, AND UNDO IS ONE OF THE PLACES THAT HAS TO
            // RE-DERIVE IT.
            //
            // `Table.auto_filter_id` is not persisted and is not maintained
            // incrementally: `relink_autofilter_owner` recomputes it "wherever
            // the sheet's filter is created, replaced or removed" (tables.rs).
            // An undo does all three and did none of the recomputing, so
            // winding back past a filter change left every table on the sheet
            // claiming nothing — the table's own filter button silently stopped
            // being the filter's owner.
            //
            // Found by the soak walk's undo round-trip oracle on fresh seed
            // 1786446166374, which failed twice out of two runs with
            // `tables.<id>.autoFilterId: "<id>" -> "<absent>"` and passes 150/150
            // with this in place.
            //
            // The `auto_filters` guard is DROPPED before `tables` is taken — one
            // lock at a time. `Persisted<T>` is a Mutex, not an RwLock, so every
            // pair held simultaneously is another edge in a graph that has
            // deadlocked this app repeatedly; this arm adds none.
            //
            // THE FILTER BUTTONS TRAVEL WITH THE FILTER. `show_filter_button`
            // is persisted and ownership is re-derived from it, so restoring
            // the filter alone would restore an ORPHAN: `relink_autofilter_owner`
            // refuses to hand a filter to a table that does not advertise
            // buttons. The inverse records the CURRENT values of the same
            // tables, so redo is exact rather than approximately right.
            let mut displaced_buttons: Vec<(identity::EntityId, bool)> = Vec::new();
            if let Ok(mut tables) = state.tables.write(effect) {
                if let Some(sheet_tables) = tables.get_mut(&snap.sheet_index) {
                    for (table_id, want) in &snap.filter_buttons {
                        if let Some(t) = sheet_tables.get_mut(table_id) {
                            displaced_buttons.push((*table_id, t.style_options.show_filter_button));
                            t.style_options.show_filter_button = *want;
                        }
                    }
                    crate::tables::relink_autofilter_owner(
                        sheet_tables,
                        restored_filter.as_ref(),
                    );
                }
            }
            // Pushed LAST, once both halves of the previous state are known —
            // and after every guard is released, so the inverse can never be
            // built while a lock this arm took is still held.
            push_obj_inverse(inverse_transaction, kind, &AutoFilterObjSnapshot {
                sheet_index: snap.sheet_index,
                previous: displaced_filter,
                filter_buttons: displaced_buttons,
            });
        }
        "obj_validation" => {
            let snap: ValidationObjSnapshot = match serde_json::from_slice(data) {
                Ok(s) => s,
                Err(e) => { eprintln!("[undo] bad obj_validation snapshot: {}", e); return; }
            };
            let mut validations = state.data_validations.write(effect).unwrap();
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
            let mut cell_types = state.cell_types.write(effect).unwrap();
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
            let mut behaviors = state.cell_behaviors.write(effect).unwrap();
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
            let mut store = state.sheet_protection.write(effect).unwrap();
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
            let mut wb = state.workbook_protection.write(effect).unwrap();
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
                let mut store = state.controls.write(effect).unwrap();
                let current = store.iter().map(|(k, v)| (*k, v.clone())).collect();
                store.clear();
                for (k, v) in snap.controls {
                    store.insert(k, v);
                }
                current
            };
            let current_ids = {
                let mut scripts = state.object_scripts.write(effect).unwrap();
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
            let mut mirror = state.grid.write(&effect).unwrap();
            let mut grids = state.grids.write(&effect).unwrap();
            let active_sheet = *state.active_sheet.read().unwrap();
            let is_active = snap.sheet_index == active_sheet;
            report.wrote_sheet(snap.sheet_index);
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
            let mut mirror = state.grid.write(&effect).unwrap();
            let mut grids = state.grids.write(&effect).unwrap();
            let active_sheet = *state.active_sheet.read().unwrap();
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
            let cur_print = state.page_setups.write(effect).ok().and_then(|mut v| {
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
            // A NAME IS NOT A CELL. `TAXRATE` is resolved while a formula is
            // evaluated, so no CELL seed describes the formulas that read it.
            // Undoing a definition therefore left every one of them holding a
            // number computed against the OTHER definition, with nothing in the
            // document indicating it.
            //
            // D2 added a real name -> dependents edge (`name_dependents`), so a
            // narrower trigger now EXISTS — `recalc_after_name_change` uses it
            // for the forward commands. It is deliberately not used here: this
            // arm restores a WHOLE-STORE snapshot, so the set of changed names
            // is the symmetric difference of two maps rather than one name, and
            // the active-sheet edge map cannot describe the other sheets anyway.
            // Whole-workbook is the honest trigger for a whole-store swap.
            report.workbook_recalc = true;
            let mut store = state.named_ranges.write(effect).unwrap();
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
            let cur_outline = state.outlines.write(effect).ok().and_then(|mut m| {
                let prev = m.remove(&idx);
                if let Some(v) = snap.outline.clone() { m.insert(idx, v); }
                prev
            });
            let cur_scenarios = state.scenarios.write(effect).ok().and_then(|mut m| {
                let prev = m.remove(&idx);
                if let Some(v) = snap.scenarios.clone() { m.insert(idx, v); }
                prev
            });
            let cur_computed = state.computed_properties.write(effect).ok().and_then(|mut m| {
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
            let mut store = state.sheet_protection.write(effect).unwrap();
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
            let mut store = state.conditional_formats.write(effect).unwrap();
            let current = store.remove(&snap.sheet_index).unwrap_or_default();
            push_obj_inverse(inverse_transaction, kind, &ConditionalFormatsObjSnapshot {
                sheet_index: snap.sheet_index,
                previous: current,
            });
            store.insert(snap.sheet_index, snap.previous);
        }
        "obj_comments" => {
            let mut store = state.comments.write(effect).unwrap();
            apply_sheet_cell_map_restore(&mut store, kind, data, inverse_transaction);
        }
        "obj_notes" => {
            let mut store = state.notes.write(effect).unwrap();
            apply_sheet_cell_map_restore(&mut store, kind, data, inverse_transaction);
        }
        "obj_hyperlinks" => {
            let mut store = state.hyperlinks.write(effect).unwrap();
            apply_sheet_cell_map_restore(&mut store, kind, data, inverse_transaction);
        }
        "obj_object_scripts" => {
            let snap: ObjectScriptsObjSnapshot = match serde_json::from_slice(data) {
                Ok(s) => s,
                Err(e) => { eprintln!("[undo] bad obj_object_scripts snapshot: {}", e); return; }
            };
            let mut scripts = state.object_scripts.write(effect).unwrap();
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
            let mut regions = state.writeback_draft_regions.write(effect).unwrap();

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
            // See "obj_named_ranges". A single-name restore COULD now seed from
            // `name_dependents` (D2), but the restore runs while `apply_changes`
            // holds the grid and style guards, and the seeded cascade is a
            // second-lock-phase call — reporting a flag is how every other
            // restore hands work to that phase. Whole-workbook is a superset of
            // the right answer, so this is a cost decision, not a correctness
            // one.
            report.workbook_recalc = true;
            let mut named_ranges = state.named_ranges.write(effect).unwrap();
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
            let mut freeze_configs = state.freeze_configs.write(effect).unwrap();
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
            let mut ext_data = state.extension_data.write(effect).unwrap();
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
    record_autofilter_undo_with_buttons(state, sheet_index, previous, Vec::new(), description)
}

/// As `record_autofilter_undo`, but also restores the `show_filter_button` flag
/// of the tables named in `filter_buttons`.
///
/// Only the REMOVAL path needs this: it is the one operation that changes a
/// table's advertised filter buttons along with the filter itself, because for
/// a table the two are one state. See `AutoFilterObjSnapshot::filter_buttons`.
pub(crate) fn record_autofilter_undo_with_buttons(
    state: &AppState,
    sheet_index: usize,
    previous: Option<crate::autofilter::AutoFilter>,
    filter_buttons: Vec<(identity::EntityId, bool)>,
    description: &str,
) {
    let snap = AutoFilterObjSnapshot { sheet_index, previous, filter_buttons };
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

    /// The registry's (kind -> defer, domains) mapping, pinned EXACTLY. A diff
    /// here is a deliberate behaviour change to undo — in either direction:
    /// dropping a domain silences an announcement the frontend needs, and adding
    /// one fires a store refresh on an undo that did not touch it.
    #[test]
    fn registry_matches_expected_domains() {
        use MutationDomain::*;
        const NONE: MutationDomains = MutationDomains::none();
        const OBJ: MutationDomains = MutationDomains::of(Objects);
        fn obj_plus(d: MutationDomain) -> MutationDomains {
            let mut s = OBJ;
            s.extend(MutationDomains::of(d));
            s
        }
        let expected: Vec<(&str, bool, MutationDomains)> = vec![
            // The four NON-CELL domains are the point of this table. Before the
            // domain set existed these five rows said "no domain at all", which
            // is why undoing a note, a comment, a hyperlink or a grouping
            // repainted nothing.
            ("comment", false, MutationDomains::of(Annotations)),
            ("note", false, MutationDomains::of(Annotations)),
            ("hyperlink", false, MutationDomains::of(Hyperlinks)),
            ("default_row_height", false, NONE),
            ("default_column_width", false, NONE),
            // DEFERRED, unlike the two geometry kinds above it: `apply_changes`
            // holds `column_widths` for the whole inline pass, so an inline
            // handler that writes it deadlocks against its own caller.
            ("pivot_col_widths", true, NONE),
            ("outline", true, MutationDomains::of(Outline)),
            ("pivot_definition", true, MutationDomains::of(Pivot)),
            ("pivot_create", true, MutationDomains::of(Pivot)),
            ("pivot_delete", true, MutationDomains::of(Pivot)),
            ("slicer", true, MutationDomains::of(Slicer)),
            ("slicer_create", true, MutationDomains::of(Slicer)),
            ("slicer_delete", true, MutationDomains::of(Slicer)),
            ("ribbon_filter", true, MutationDomains::of(RibbonFilter)),
            ("ribbon_filter_create", true, MutationDomains::of(RibbonFilter)),
            ("ribbon_filter_delete", true, MutationDomains::of(RibbonFilter)),
            ("pane_control", true, MutationDomains::of(PaneControl)),
            ("pane_control_create", true, MutationDomains::of(PaneControl)),
            ("pane_control_delete", true, MutationDomains::of(PaneControl)),
            ("obj_chart", true, OBJ),
            ("obj_sparklines", true, OBJ),
            ("obj_table", true, OBJ),
            ("obj_autofilter", true, OBJ),
            ("obj_validation", true, obj_plus(Validations)),
            ("obj_named_range", true, OBJ),
            ("obj_freeze", true, OBJ),
            ("script_grid_cells", true, OBJ),
            ("sheet_merge_regions", true, OBJ),
            ("sheet_structural_snapshot", true, OBJ),
            ("obj_extension_data", true, OBJ),
            ("obj_cell_types", true, OBJ),
            ("obj_cell_behaviors", true, OBJ),
            ("obj_writeback_regions", true, OBJ),
            ("obj_object_scripts", true, OBJ),
            ("obj_comments", true, obj_plus(Annotations)),
            ("obj_notes", true, obj_plus(Annotations)),
            ("obj_hyperlinks", true, obj_plus(Hyperlinks)),
            // ConditionalFormats, not bare OBJ: the extension caches the rule
            // LIST, and `grid:refresh` only makes it re-evaluate that cache.
            ("obj_conditional_formats", true, obj_plus(ConditionalFormats)),
            ("obj_sheet_protection", true, OBJ),
            ("obj_sheet_protection_record", true, OBJ),
            ("obj_coord_stores", true, obj_plus(Outline)),
            ("obj_named_ranges", true, OBJ),
            ("obj_range_strings", true, OBJ),
            ("obj_cross_sheet_formulas", true, OBJ),
            ("obj_controls", true, obj_plus(Controls)),
            ("obj_style_tiers", true, OBJ),
            ("obj_workbook_protection", true, OBJ),
            ("report_restore", true, OBJ),
            ("calp_reset", true, OBJ),
            // User hide/unhide: inline (only touches the user_hidden_* sublocks)
            // and its own domain so the frontend re-reads the sets.
            ("user_hidden", false, MutationDomains::of(Hidden)),
        ];
        for (kind, defer, domains) in &expected {
            let spec = restore_spec(kind).unwrap_or_else(|| panic!("missing restore kind: {kind}"));
            assert_eq!(spec.defer, *defer, "defer mismatch for {kind}");
            assert_eq!(spec.domains, *domains, "domains mismatch for {kind}");
        }
        // No extra kind slipped in unclassified.
        assert_eq!(RESTORE_REGISTRY.len(), expected.len(), "registry size drifted from expected");
    }

    /// `hidden` is the one domain that is NOT announced through the domain list:
    /// it drives a dimension re-read (`hiddenChanged`), not a store refresh, and
    /// the frontend `MutationDomain` union does not contain it. Everything else
    /// must have a wire name, or a restore would set a flag no listener sees.
    #[test]
    fn every_domain_but_hidden_has_a_wire_name() {
        for d in MutationDomain::ALL {
            // TWO members carry no wire name, and they mean different things.
            // `Hidden` is a real domain reported through a dedicated flag;
            // `None` is the answer `ObjectKind::ui_domain` gives for a kind no
            // frontend store caches, and it is in ALL only so the list stays
            // exhaustive against the enum.
            if matches!(d, MutationDomain::Hidden | MutationDomain::None) {
                assert!(d.wire_name().is_none(), "{d:?} must not be announced as a domain");
            } else {
                assert!(d.wire_name().is_some(), "{d:?} has no wire name");
            }
        }
    }

    /// `UiDomain::ALL` is hand-maintained; a variant missing from it is dropped
    /// from every undo announcement in silence. The exhaustive `wire_name`
    /// match is what the compiler DOES force, so the two are compared here.
    #[test]
    fn every_ui_domain_is_in_all() {
        let names: std::collections::BTreeSet<Option<&'static str>> =
            MutationDomain::ALL.iter().map(|d| d.wire_name()).collect();
        // 16 variants, 14 of which have a distinct wire name; `Hidden` and
        // `None` share the absent one.
        assert_eq!(
            MutationDomain::ALL.len(),
            15 + 1,
            "UiDomain::ALL has fallen out of step with the enum"
        );
        assert_eq!(names.len(), 14 + 1, "two domains share a wire name");
        // And every ObjectKind's answer is a member.
        for kind in crate::object_deps::ObjectKind::ALL {
            assert!(
                MutationDomain::ALL.contains(&kind.ui_domain()),
                "{} maps to a domain that is not in UiDomain::ALL",
                kind.wire_name()
            );
        }
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
                || *kind == "sheet_merge_regions"
                || *kind == "sheet_structural_snapshot"
                || *kind == "report_restore"
                || *kind == "calp_reset"
                // The outline is its own per-sheet store, taken after the grid
                // locks drop for the same reason every other store-swap is.
                || *kind == OUTLINE_RESTORE_KIND;
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

// ============================================================================
// Row/column grouping (the outline) — undo, and the announcement on undo.
// ============================================================================

/// CustomRestore `kind` for one sheet's row/column outline.
pub(crate) const OUTLINE_RESTORE_KIND: &str = "outline";

/// Snapshot for the `"outline"` CustomRestore — one sheet's WHOLE outline
/// before a group / ungroup / collapse / expand / clear.
///
/// THE GAP THIS CLOSES. Grouping had no undo entry of any kind: `group_rows`
/// and its eight siblings wrote `state.outlines` and returned, so Ctrl+Z after
/// grouping a block silently undid whatever the user had done BEFORE it. The
/// only outline that was ever restorable was the one a structural edit shifted
/// (`obj_coord_stores`), which is a different operation entirely.
///
/// Whole-outline rather than per-group deltas, for the same reason
/// `user_hidden` is whole-set: one gesture rewrites several groups at once
/// (`ungroup_rows` SPLITS a group into two), levels are recomputed across the
/// whole sheet afterwards, and the value is small — a handful of ranges. `None`
/// means the sheet had no outline at all, which restores by removing the key
/// rather than by installing an empty one, so an undone `clear_outline` does not
/// leave behind a record the save path would then have to skip.
#[derive(serde::Serialize, serde::Deserialize)]
struct OutlineSnapshot {
    sheet_index: usize,
    previous: Option<crate::grouping::SheetOutline>,
}

/// Record the PRE-mutation outline of `sheet_index` as an undoable step.
///
/// Follows `record_object_undo`'s in-open-transaction contract: it joins a
/// transaction the caller already opened (so a scripted batch of groupings stays
/// ONE user-visible step) and otherwise opens and commits its own.
pub(crate) fn record_outline_undo(
    state: &AppState,
    sheet_index: usize,
    previous: Option<crate::grouping::SheetOutline>,
    description: &str,
) {
    let snap = OutlineSnapshot { sheet_index, previous };
    record_object_undo(
        state,
        OUTLINE_RESTORE_KIND,
        serde_json::to_vec(&snap).unwrap_or_default(),
        description,
    );
}

// ============================================================================
// PIVOT AUTO-FIT COLUMN WIDTHS (BUG-0014)
// ============================================================================

/// The restore kind a pivot auto-fit records so its column resize is undone
/// with the pivot change that caused it.
pub(crate) const PIVOT_COL_WIDTHS_RESTORE_KIND: &str = "pivot_col_widths";

/// The widths a pivot auto-fit overwrote, on ONE sheet.
///
/// Sheet-INDEXED rather than active-sheet-implicit, because a pivot can render
/// on a sheet the user is not looking at (a subscribed report renders on its own
/// appended sheet) and the fit writes `all_column_widths[dest]` in that case.
/// An active-sheet-only restore would silently do nothing there — the same
/// sheet-blindness that made `CellChange::SetCell` grow a `sheet` field.
#[derive(serde::Serialize, serde::Deserialize)]
struct PivotColWidthsSnapshot {
    sheet_index: usize,
    /// `(column, width before the fit)`. `None` = the column had no explicit
    /// width, so the restore REMOVES the entry rather than writing a default.
    previous: Vec<(u32, Option<f64>)>,
}

/// Serialize the column widths a pivot auto-fit overwrote, for the caller to
/// record inside the SAME transaction as the pivot mutation (Excel undoes the
/// two together, and a separate transaction would cost the user a second
/// Ctrl+Z).
///
/// Returns `None` when there is nothing to record — auto-fit off, or an empty
/// view — so the no-op is decided here rather than at every call site.
pub(crate) fn encode_pivot_col_widths_snapshot(
    sheet_index: usize,
    previous: Vec<(u32, Option<f64>)>,
) -> Option<Vec<u8>> {
    if previous.is_empty() {
        return None;
    }
    let snap = PivotColWidthsSnapshot { sheet_index, previous };
    serde_json::to_vec(&snap).ok()
}

/// Put the pre-fit column widths back, capturing the CURRENT ones as the
/// symmetric inverse so redo re-applies the fit.
fn apply_pivot_col_widths_restore(
    state: &AppState,
    effect: &crate::document_effect::DocumentEffect,
    data: &[u8],
    inverse_transaction: &mut Transaction,
) {
    let snap: PivotColWidthsSnapshot = match serde_json::from_slice(data) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("[undo] bad pivot column-width snapshot: {}", e);
            return;
        }
    };

    let active = match state.active_sheet.read() {
        Ok(a) => *a,
        Err(_) => return,
    };

    let mut inverse: Vec<(u32, Option<f64>)> = Vec::with_capacity(snap.previous.len());

    if snap.sheet_index == active {
        let Ok(mut widths) = state.column_widths.write(effect) else { return };
        for (col, prev) in &snap.previous {
            let current = widths.get(col).copied();
            inverse.push((*col, current));
            match prev {
                Some(w) => {
                    widths.insert(*col, *w);
                }
                None => {
                    widths.remove(col);
                }
            }
        }
    } else {
        let Ok(mut all) = state.all_column_widths.write(effect) else { return };
        if snap.sheet_index >= all.len() {
            return;
        }
        for (col, prev) in &snap.previous {
            let current = all[snap.sheet_index].get(col).copied();
            inverse.push((*col, current));
            match prev {
                Some(w) => {
                    all[snap.sheet_index].insert(*col, *w);
                }
                None => {
                    all[snap.sheet_index].remove(col);
                }
            }
        }
    }

    let inverse_snap = PivotColWidthsSnapshot {
        sheet_index: snap.sheet_index,
        previous: inverse,
    };
    inverse_transaction.add_change(CellChange::CustomRestore {
        kind: PIVOT_COL_WIDTHS_RESTORE_KIND.to_string(),
        data: serde_json::to_vec(&inverse_snap).unwrap_or_default(),
    });
}

/// Restore one sheet's outline, capturing the CURRENT one as the symmetric
/// inverse so redo re-applies the grouping.
fn apply_outline_restore(
    state: &AppState,
    effect: &crate::document_effect::DocumentEffect,
    data: &[u8],
    inverse_transaction: &mut Transaction,
) {
    let snap: OutlineSnapshot = match serde_json::from_slice(data) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("[undo] bad outline snapshot: {}", e);
            return;
        }
    };
    let idx = snap.sheet_index;
    let current = {
        let mut outlines = match state.outlines.write(effect) {
            Ok(o) => o,
            Err(_) => return,
        };
        let current = outlines.remove(&idx);
        if let Some(previous) = snap.previous {
            outlines.insert(idx, previous);
        }
        current
    };
    inverse_transaction.add_change(CellChange::CustomRestore {
        kind: OUTLINE_RESTORE_KIND.to_string(),
        data: serde_json::to_vec(&OutlineSnapshot { sheet_index: idx, previous: current })
            .unwrap_or_default(),
    });
}

/// CustomRestore `kind` for the user-hidden row/column sets.
pub(crate) const USER_HIDDEN_RESTORE_KIND: &str = "user_hidden";

/// Snapshot for the `"user_hidden"` CustomRestore — one sheet's hand-hidden
/// row and/or column set BEFORE a hide/unhide (or a structural shift).
///
/// Whole-set rather than per-index deltas, for the same reason
/// `obj_named_ranges` is whole-map: one gesture ("Hide" over a 500-row
/// selection) touches many indices at once, the set is small, and a partial
/// restore could leave the grid disagreeing with itself about which rows exist.
/// `None` for an axis means "this change did not touch it" — restoring then
/// leaves that axis alone rather than clearing it.
#[derive(serde::Serialize, serde::Deserialize)]
struct UserHiddenSnapshot {
    sheet_index: usize,
    rows: Option<Vec<u32>>,
    cols: Option<Vec<u32>>,
}

/// Serialized `"user_hidden"` snapshot bytes (in-open-transaction contract).
pub(crate) fn user_hidden_snapshot_bytes(
    sheet_index: usize,
    rows: Option<Vec<u32>>,
    cols: Option<Vec<u32>>,
) -> Vec<u8> {
    serde_json::to_vec(&UserHiddenSnapshot { sheet_index, rows, cols }).unwrap_or_default()
}

/// Restore one sheet's user-hidden sets, capturing the CURRENT sets as the
/// inverse so redo re-applies the hide.
pub(crate) fn apply_user_hidden_restore(
    state: &AppState,
    effect: &crate::document_effect::DocumentEffect,
    data: &[u8],
    inverse_transaction: &mut Transaction,
) {
    let snap: UserHiddenSnapshot = match serde_json::from_slice(data) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("[undo] bad user_hidden snapshot: {}", e);
            return;
        }
    };
    let idx = snap.sheet_index;
    let cur_rows = snap.rows.as_ref().map(|rows| {
        let mut current: Vec<u32> =
            crate::commands::dimensions::user_hidden_rows_for_sheet(state, idx)
                .into_iter()
                .collect();
        current.sort_unstable();
        let restored: std::collections::HashSet<u32> = rows.iter().copied().collect();
        let cols = crate::commands::dimensions::user_hidden_cols_for_sheet(state, idx);
        crate::commands::dimensions::set_user_hidden_for_sheet(state, effect, idx, restored, cols);
        current
    });
    let cur_cols = snap.cols.as_ref().map(|cols| {
        let mut current: Vec<u32> =
            crate::commands::dimensions::user_hidden_cols_for_sheet(state, idx)
                .into_iter()
                .collect();
        current.sort_unstable();
        let restored: std::collections::HashSet<u32> = cols.iter().copied().collect();
        let rows = crate::commands::dimensions::user_hidden_rows_for_sheet(state, idx);
        crate::commands::dimensions::set_user_hidden_for_sheet(state, effect, idx, rows, restored);
        current
    });
    inverse_transaction.add_change(engine::undo::CellChange::CustomRestore {
        kind: USER_HIDDEN_RESTORE_KIND.to_string(),
        data: user_hidden_snapshot_bytes(idx, cur_rows, cur_cols),
    });
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

/// Record the PRE-mutation control store as an undoable step. Backs control
/// CREATE and DELETE, which recorded nothing at all: creating or deleting a
/// shape, a button or a picture was invisible to Ctrl+Z, so undo skipped past it
/// to the user's previous action while the control stayed exactly as it was.
///
/// `script_instance_ids` IS DELIBERATELY EMPTY for create/delete, and that is the
/// interesting half. A control's instance id derives from its ANCHOR
/// (`control-<sheet>-<row>-<col>`), and deleting a control deletes its object
/// scripts outright rather than re-keying them — precisely so that the next
/// control created at that cell cannot inherit code its author never wrote.
/// Restoring the binding here would reopen that: the recreated control would
/// come back wired to a script row that no longer exists, and any control later
/// created at the same anchor would find a live-looking binding waiting for it.
/// So undo brings back the control, not the script. Re-keying — where the same
/// control moves and its binding must follow — is the structural-shift case, and
/// that one does populate this list (see `shift_controls`).
///
/// In-open-transaction contract, like every other recorder here: a scripted
/// batch that creates ten shapes inside one `begin_undo_transaction` stays ONE
/// user-visible undo step.
pub(crate) fn record_controls_undo(
    state: &AppState,
    previous: Vec<((usize, u32, u32), crate::controls::ControlMetadata)>,
    description: &str,
) {
    record_object_undo(
        state,
        "obj_controls",
        controls_snapshot_bytes(previous, Vec::new()),
        description,
    );
}

#[cfg(test)]
mod sheet_tagged_restore_tests {
    //! Wave 3: the RESTORE half of the sheet-tagged undo kinds. The command
    //! tests (commands/off_sheet_tests.rs) prove the payloads are recorded
    //! with the right sheet index; these prove replaying a payload mutates
    //! exactly that sheet and captures a symmetric inverse for redo.

    use super::*;
    use engine::{Cell, CellValue};
    use std::collections::HashSet;

    fn two_sheet_state() -> AppState {
        let state = crate::create_app_state();
        state.grids.write(&crate::document_effect::DocumentEffect::deliberately_clean(crate::document_effect::CleanReason::LoadingFromDisk)).unwrap().push(engine::Grid::new());
        state.sheet_names.write(&crate::document_effect::test_seed_effect()).unwrap().push("Sheet2".to_string());
        state.all_column_widths.write(&crate::document_effect::test_seed_effect()).unwrap().push(HashMap::new());
        state.all_row_heights.write(&crate::document_effect::test_seed_effect()).unwrap().push(HashMap::new());
        // create_app_state leaves all_merged_regions EMPTY (the mirror holds
        // the active sheet's set); size it for both sheets so tests can index.
        {
            let mut all = state.all_merged_regions.write(&crate::document_effect::test_seed_effect()).unwrap();
            while all.len() < 2 {
                all.push(HashSet::new());
            }
        }
        state
            .sheet_ids
            .write(&crate::document_effect::test_seed_effect())
            .unwrap()
        .push(identity::SheetId::from_bytes(identity::generate_uuid_v7()));
        state
    }

    #[test]
    fn sheet_structural_restore_targets_the_named_sheet_and_captures_the_inverse() {
        let state = two_sheet_state();
        // Sheet 0 (active) sentinel that must survive untouched.
        state.grid.write(&crate::document_effect::DocumentEffect::deliberately_clean(crate::document_effect::CleanReason::LoadingFromDisk)).unwrap().set_cell(0, 0, Cell::new_number(999.0));
        state.grids.write(&crate::document_effect::DocumentEffect::deliberately_clean(crate::document_effect::CleanReason::LoadingFromDisk)).unwrap()[0].set_cell(0, 0, Cell::new_number(999.0));

        // Pre-edit state of sheet 2, captured as the undo snapshot.
        state.grids.write(&crate::document_effect::DocumentEffect::deliberately_clean(crate::document_effect::CleanReason::LoadingFromDisk)).unwrap()[1].set_cell(4, 0, Cell::new_number(2.0));
        state.all_row_heights.write(&crate::document_effect::test_seed_effect()).unwrap()[1].insert(4, 33.0);
        let snapshot = capture_sheet_structural_snapshot(&state, 1).expect("capture");

        // Simulate the post-edit state (as if 3 rows were inserted at 2).
        {
            let mut grids = state.grids.write(&crate::document_effect::DocumentEffect::deliberately_clean(crate::document_effect::CleanReason::LoadingFromDisk)).unwrap();
            grids[1].clear_cell(4, 0);
            grids[1].set_cell(7, 0, Cell::new_number(2.0));
            let mut all_rh = state.all_row_heights.write(&crate::document_effect::test_seed_effect()).unwrap();
            all_rh[1].clear();
            all_rh[1].insert(7, 33.0);
        }

        // Undo: replay the pre-edit snapshot.
        let mut inverse = Transaction::new("test");
        apply_sheet_structural_restore(
            &state,
            // Undo replay IS a document change: the restore writes cells.
            &crate::document_effect::DocumentEffect::mutates(
                &crate::persistence::FileState::default(),
            ),
            &sheet_structural_snapshot_bytes(&snapshot),
            &mut inverse,
            &mut RestoreReport::default(),
        );

        let grids = state.grids.read().unwrap();
        assert_eq!(
            grids[1].get_cell(4, 0).map(|c| c.value.clone()),
            Some(CellValue::Number(2.0)),
            "sheet 2 restored to its pre-edit shape"
        );
        assert!(grids[1].get_cell(7, 0).is_none(), "post-edit position vacated");
        assert_eq!(
            grids[0].get_cell(0, 0).map(|c| c.value.clone()),
            Some(CellValue::Number(999.0)),
            "sheet 1 untouched by a sheet-2 restore"
        );
        drop(grids);
        assert_eq!(
            state.all_row_heights.read().unwrap()[1].get(&4),
            Some(&33.0),
            "per-sheet row heights restored"
        );

        // The inverse (redo) captures the post-edit state, sheet-tagged.
        let redo = inverse
            .changes
            .iter()
            .find_map(|c| match c {
                CellChange::CustomRestore { kind, data }
                    if kind == "sheet_structural_snapshot" =>
                {
                    Some(data)
                }
                _ => None,
            })
            .expect("symmetric inverse recorded");
        let redo_snapshot: SheetStructuralSnapshot = serde_json::from_slice(redo).unwrap();
        assert_eq!(redo_snapshot.sheet_index, 1);
        assert!(
            redo_snapshot
                .cells
                .iter()
                .any(|(r, _, cell)| *r == 7 && cell.value == CellValue::Number(2.0)),
            "redo re-applies the post-edit state"
        );
    }

    #[test]
    fn sheet_merge_regions_restore_swaps_only_the_named_sheets_set() {
        let state = two_sheet_state();
        // Active mirror holds a merge that must survive.
        state.merged_regions.write(&crate::document_effect::test_seed_effect()).unwrap().insert(crate::api_types::MergedRegion {
            start_row: 0, start_col: 0, end_row: 1, end_col: 1,
        });
        // Sheet 2 currently holds a post-merge region; the snapshot says the
        // pre-merge set was empty.
        state.all_merged_regions.write(&crate::document_effect::test_seed_effect()).unwrap()[1].insert(crate::api_types::MergedRegion {
            start_row: 3, start_col: 3, end_row: 4, end_col: 4,
        });

        let mut inverse = Transaction::new("test");
        apply_sheet_merge_regions_restore(
            &state,
            &crate::document_effect::test_seed_effect(),
            &sheet_merge_regions_snapshot_bytes(1, Vec::new()),
            &mut inverse,
            &mut RestoreReport::default(),
        );

        assert!(
            state.all_merged_regions.read().unwrap()[1].is_empty(),
            "sheet 2's set swapped to the snapshot (empty)"
        );
        assert_eq!(
            state.merged_regions.read().unwrap().len(),
            1,
            "the ACTIVE sheet's merge set is untouched"
        );

        let redo = inverse
            .changes
            .iter()
            .find_map(|c| match c {
                CellChange::CustomRestore { kind, data } if kind == "sheet_merge_regions" => {
                    Some(data)
                }
                _ => None,
            })
            .expect("symmetric inverse recorded");
        let redo_snapshot: SheetMergeRegionsSnapshot = serde_json::from_slice(redo).unwrap();
        assert_eq!(redo_snapshot.sheet_index, 1);
        assert_eq!(redo_snapshot.regions.len(), 1, "redo re-applies the post-merge set");
    }
}

#[cfg(test)]
#[path = "undo_sheet_domain_tests.rs"]
mod undo_sheet_domain_tests;

#[cfg(test)]
#[path = "undo_sheet_structure_tests.rs"]
mod undo_sheet_structure_tests;

#[cfg(test)]
#[path = "autofilter_table_button_tests.rs"]
mod autofilter_table_button_tests;

#[cfg(test)]
#[path = "undo_s12_soak_leak_tests.rs"]
mod undo_s12_soak_leak_tests;

#[cfg(test)]
#[path = "pivot_undo_cache_tests.rs"]
mod pivot_undo_cache_tests;
