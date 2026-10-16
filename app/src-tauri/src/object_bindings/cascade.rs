//! FILENAME: app/src-tauri/src/object_bindings/cascade.rs
// PURPOSE: What happens to object property BINDINGS when something they name
//          goes away or moves (D §3.12): the object is deleted (its bindings
//          go with it, inside the delete's own undo step), a sheet is renamed
//          or deleted (the formulas are repaired like every other formula),
//          and rows / columns / cells are inserted or deleted (the formulas
//          shift like every other formula).
// CONTEXT: The persisted store is `AppState.object_bindings`. Every function
//          here writes ONLY the store: it bumps `generation` (so the runtime
//          rebuilds lazily on its next read) and announces a reload (so the
//          frontend seam re-lists and asks `ResolveAll`, whose `reevaluate`
//          does the rebuild and the evaluation once the caller's guards are
//          gone). None of them may call `eval::reevaluate`: they run inside
//          delete commands and structural shifts that hold canonical locks,
//          and evaluating takes `grid`/`grids` -- a self-deadlock on a
//          non-reentrant std mutex (D §3.3 rule 3, the sort_range PHASE-B
//          lesson; `reevaluate_has_only_the_declared_callers` pins it).
//
// LOCKS: the store is a LEAF. These functions take it while the caller may hold
// `grid`, `grids` and the `undo_stack` guard (the structural shift hands its
// `&mut UndoStack` in, and the restore is recorded through THAT, never through
// `state.undo_stack.lock()`, which would self-deadlock); nothing else is taken
// under it. A `rewrite` closure must take no lock (the sheet-rename and
// sheet-delete rewriters are pure text functions).

use std::collections::HashSet;

use crate::api_types::ObjectBindingRef;
use crate::document_effect::DocumentEffect;
use crate::AppState;

use super::object_json::{self, ObjectStores};
use super::store::BindingStoreSnapshot;

/// The description of the undo entry a structural shift records for the store.
const SHIFT_UNDO_DESCRIPTION: &str = "Shift bound properties";

/// Drop every binding of `objects`, returning the previous store for the
/// deleting command's undo step (`None` when none of them was bound -- then
/// nothing is written, nothing is announced and nothing should be recorded).
///
/// The caller records the snapshot with
/// `undo_commands::bindings_restore_bytes` INSIDE its own one step, listed
/// BEFORE the object's own restore so the reverse replay brings the object
/// back first and its bindings last (the `delete_chart` cascade ordering). A
/// delete whose command ends the undo history (a sheet delete) records
/// nothing.
pub(crate) fn drop_bindings_for_objects(
    state: &AppState,
    effect: &DocumentEffect,
    objects: &[ObjectBindingRef],
) -> Option<BindingStoreSnapshot> {
    if objects.is_empty() {
        return None;
    }
    let dead: HashSet<&ObjectBindingRef> = objects.iter().collect();
    let previous = {
        let mut store = match state.object_bindings.write(effect) {
            Ok(store) => store,
            Err(e) => {
                crate::log_warn!("BINDINGS", "the binding store is unreadable ({}); no binding was dropped", e);
                return None;
            }
        };
        if !store.bindings.keys().any(|key| dead.contains(&key.object)) {
            return None;
        }
        let previous = store.snapshot();
        store.bindings.retain(|key, _| !dead.contains(&key.object));
        store.bump_generation();
        previous
    };
    super::announce_reload();
    Some(previous)
}

/// The objects the binding store names that no longer exist anywhere in the
/// workbook (`object_json::live_object_refs`), sorted. The object stores are
/// read and released before the (leaf) store is taken.
///
/// A sheet delete asks this after its cascades ran: everything that went with
/// the sheet -- the canvas page itself, the charts, controls, slicers,
/// timelines, pivots and floating ranges on it, and the slicers and timelines
/// its tables and pivots took with them -- is exactly the set of bound objects
/// that stopped existing. The delete ends the undo history, so no Ctrl+Z could
/// ever bring one of them back to its bindings.
pub(crate) fn vanished_bound_objects(cx: &ObjectStores<'_>) -> Vec<ObjectBindingRef> {
    let live = object_json::live_object_refs(cx);
    let Ok(store) = cx.state.object_bindings.read() else { return Vec::new() };
    let mut out: Vec<ObjectBindingRef> = store
        .bindings
        .keys()
        .map(|key| &key.object)
        .filter(|object| !live.contains(*object))
        .cloned()
        .collect();
    out.sort();
    out.dedup();
    out
}

/// Rewrite every binding formula through `rewrite` (`None` = unchanged): the
/// binding arm of `sheets.rs` `rewrite_rule_formulas`, so a sheet RENAME
/// (`rename_rule_references`, and the `.calp` collision rename through it) and
/// a sheet DELETE (`delete_rule_references`: `#REF!`, a 3D endpoint moving
/// inward) reach bindings with no call site of their own. Returns true when
/// anything changed. No undo is recorded: both operations end the undo
/// history (a rename re-spells, a delete renumbers, every queued entry).
pub(crate) fn rewrite_binding_formulas(
    state: &AppState,
    effect: &DocumentEffect,
    rewrite: &dyn Fn(&str) -> Option<String>,
) -> bool {
    // The sheet names AFTER the rename / delete (the callers run with every
    // sheet guard released), copied out BEFORE the leaf store is taken: a
    // rewrite re-renders the whole formula, and the lexer upper-cases every
    // bare sheet name it re-reads, so an untouched `Data!A1` beside the
    // repaired reference would otherwise be stored as `DATA!A1`.
    let sheet_names: Vec<String> = state.sheet_names.read().map(|g| g.clone()).unwrap_or_default();
    let respelled = |text: String| super::formula::respell_sheet_case(&text, &sheet_names).unwrap_or(text);
    let changed = {
        let mut store = match state.object_bindings.write(effect) {
            Ok(store) => store,
            Err(e) => {
                crate::log_warn!("BINDINGS", "the binding store is unreadable ({}); no formula was repaired", e);
                return false;
            }
        };
        let mut changed = false;
        for binding in store.bindings.values_mut() {
            if let Some(rewritten) = rewrite(&binding.formula).map(&respelled) {
                if rewritten != binding.formula {
                    binding.formula = rewritten;
                    changed = true;
                }
            }
        }
        if changed {
            store.bump_generation();
        }
        changed
    };
    if changed {
        super::announce_reload();
    }
    changed
}

/// Structural shift (insert / delete rows or columns on `sheet_name`) of every
/// binding formula that reads that sheet, beside `shift_named_ranges` at every
/// one of its call sites. Records the previous store as one `obj_bindings`
/// restore INTO the open structural transaction, through the `undo_stack`
/// guard the caller is holding. Returns true when anything moved.
///
/// Every binding reference is sheet-QUALIFIED (D §3.6 rule 2), so the
/// formula's own sheet is "" -- a name no sheet can have -- and only references
/// that name `sheet_name` move.
pub(crate) fn shift_object_bindings(
    state: &AppState,
    effect: &DocumentEffect,
    undo_stack: &mut engine::UndoStack,
    sheet_name: &str,
    edit: calp::writeback::StructuralEdit,
) -> bool {
    use crate::commands::structure::{shift_formula_cols_sheet_aware, shift_formula_rows_sheet_aware};
    use calp::writeback::StructuralEdit as SE;
    shift_store_formulas(state, effect, undo_stack, &|formula| match edit {
        SE::RowInsert { at, count } => shift_formula_rows_sheet_aware(formula, "", sheet_name, at, count as i32),
        SE::RowDelete { at, count } => shift_formula_rows_sheet_aware(formula, "", sheet_name, at, -(count as i32)),
        SE::ColInsert { at, count } => shift_formula_cols_sheet_aware(formula, "", sheet_name, at, count as i32),
        SE::ColDelete { at, count } => shift_formula_cols_sheet_aware(formula, "", sheet_name, at, -(count as i32)),
    })
}

/// [`shift_object_bindings`] for Excel's Insert / Delete Cells: only the
/// references inside the shifted BAND move (`shift_formula_in_band`), beside
/// `shift_named_ranges_in_band`.
pub(crate) fn shift_object_bindings_in_band(
    state: &AppState,
    effect: &DocumentEffect,
    undo_stack: &mut engine::UndoStack,
    sheet_name: &str,
    band: &crate::commands::structure::structure_cells::BandEdit,
) -> bool {
    shift_store_formulas(state, effect, undo_stack, &|formula| {
        crate::commands::structure::structure_cells::shift_formula_in_band(formula, "", sheet_name, band)
    })
}

/// The shared body of the two shifts: rewrite every formula, and when any
/// moved, bump the generation, record the previous store into the caller's
/// open transaction and announce a reload.
fn shift_store_formulas(
    state: &AppState,
    effect: &DocumentEffect,
    undo_stack: &mut engine::UndoStack,
    shift: &dyn Fn(&str) -> String,
) -> bool {
    let previous = {
        let mut store = match state.object_bindings.write(effect) {
            Ok(store) => store,
            Err(e) => {
                crate::log_warn!("BINDINGS", "the binding store is unreadable ({}); no formula was shifted", e);
                return false;
            }
        };
        if store.bindings.is_empty() {
            return false;
        }
        let previous = store.snapshot();
        let mut changed = false;
        for binding in store.bindings.values_mut() {
            let shifted = shift(&binding.formula);
            if shifted != binding.formula {
                binding.formula = shifted;
                changed = true;
            }
        }
        if !changed {
            return false;
        }
        store.bump_generation();
        previous
    };
    undo_stack.record_custom_restore(
        crate::undo_commands::BINDINGS_RESTORE_KIND.to_string(),
        crate::undo_commands::bindings_restore_bytes(state, &previous),
        SHIFT_UNDO_DESCRIPTION,
    );
    super::announce_reload();
    true
}
