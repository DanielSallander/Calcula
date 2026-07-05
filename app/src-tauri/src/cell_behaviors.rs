//! FILENAME: app/src-tauri/src/cell_behaviors.rs
// PURPOSE: Cell-behavior binding storage and Tauri commands (granular bricks,
//          phase 2: per-cell script behaviors).
// CONTEXT: A binding says "THIS range has behavior X": it pairs a grid range
//          with an object script (objectType "range", instanceId = binding id)
//          plus dispatch metadata (claimClick). Bindings are first-class,
//          persisted records — inspectable without running any code (the
//          anti-VBA-opacity rule; see docs/design/granular-bricks.md §Phase 2).
//          Undoable ("obj_cell_behaviors"), persisted per binding keyed by
//          SheetId, and shifted by structural row/column edits inside the same
//          undo transaction as the grid change (table-boundary semantics:
//          insert above shifts, inside grows; delete overlapping shrinks,
//          delete containing marks the binding orphaned + disabled).

use crate::AppState;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use tauri::State;

// ============================================================================
// Types
// ============================================================================

fn default_true() -> bool {
    true
}

/// One cell-behavior binding: a range target + its script + dispatch metadata.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CellBehaviorBinding {
    /// Opaque UUID. Doubles as the script's instanceId.
    pub id: String,
    /// The object script (objectType "range") this binding dispatches to.
    pub script_id: String,
    pub sheet_index: usize,
    pub start_row: u32,
    pub start_col: u32,
    pub end_row: u32,
    pub end_col: u32,
    /// Whether a click on the target suppresses default selection handling.
    /// Declarative metadata — never a handler return value (handlers run async).
    #[serde(default = "default_true")]
    pub claim_click: bool,
    #[serde(default = "default_true")]
    pub enabled: bool,
    /// Set when a structural edit deleted the entire target. The binding stops
    /// dispatching but survives (undo restores it; the panel offers re-target).
    #[serde(default)]
    pub orphaned: bool,
}

/// Storage: binding id -> binding.
pub type CellBehaviorStorage = HashMap<String, CellBehaviorBinding>;

/// All bindings, sorted by id for deterministic snapshots/artifacts.
pub fn all_bindings(store: &CellBehaviorStorage) -> Vec<CellBehaviorBinding> {
    let mut bindings: Vec<CellBehaviorBinding> = store.values().cloned().collect();
    bindings.sort_by(|a, b| a.id.cmp(&b.id));
    bindings
}

/// Replace the whole store (undo restore path — bindings are workbook-level
/// and few, so whole-store swap keeps the restore trivially correct).
pub fn replace_all(store: &mut CellBehaviorStorage, bindings: Vec<CellBehaviorBinding>) {
    store.clear();
    for b in bindings {
        store.insert(b.id.clone(), b);
    }
}

// ============================================================================
// Structural shifts (insert/delete rows/columns)
// ============================================================================
// Same discipline as cell_types: called with the undo transaction still open.
// Returns whether anything changed (callers skip undo recording when false).

pub fn shift_rows_for_insert(
    store: &mut CellBehaviorStorage,
    sheet_index: usize,
    start_row: u32,
    count: u32,
) -> bool {
    let mut changed = false;
    for b in store.values_mut() {
        if b.sheet_index != sheet_index {
            continue;
        }
        if b.start_row >= start_row {
            b.start_row += count;
            b.end_row += count;
            changed = true;
        } else if b.end_row >= start_row {
            // Insert inside the target: the range grows.
            b.end_row += count;
            changed = true;
        }
    }
    changed
}

pub fn shift_rows_for_delete(
    store: &mut CellBehaviorStorage,
    sheet_index: usize,
    start_row: u32,
    count: u32,
) -> bool {
    let d0 = start_row;
    let d1 = start_row.saturating_add(count); // exclusive
    let mut changed = false;
    for b in store.values_mut() {
        if b.sheet_index != sheet_index || b.end_row < d0 {
            continue;
        }
        changed = true;
        let new_start = if b.start_row >= d1 {
            b.start_row - count
        } else if b.start_row >= d0 {
            d0
        } else {
            b.start_row
        };
        // end is inclusive; end >= d0 guaranteed by the guard above.
        let new_end = if b.end_row >= d1 {
            b.end_row - count
        } else if d0 > 0 {
            d0 - 1
        } else {
            // Deleted from row 0 through the end of the target.
            b.orphaned = true;
            b.enabled = false;
            continue;
        };
        if new_end < new_start {
            // Target fully deleted: orphan + disable, keep coords for the panel.
            b.orphaned = true;
            b.enabled = false;
        } else {
            b.start_row = new_start;
            b.end_row = new_end;
        }
    }
    changed
}

pub fn shift_cols_for_insert(
    store: &mut CellBehaviorStorage,
    sheet_index: usize,
    start_col: u32,
    count: u32,
) -> bool {
    let mut changed = false;
    for b in store.values_mut() {
        if b.sheet_index != sheet_index {
            continue;
        }
        if b.start_col >= start_col {
            b.start_col += count;
            b.end_col += count;
            changed = true;
        } else if b.end_col >= start_col {
            b.end_col += count;
            changed = true;
        }
    }
    changed
}

pub fn shift_cols_for_delete(
    store: &mut CellBehaviorStorage,
    sheet_index: usize,
    start_col: u32,
    count: u32,
) -> bool {
    let d0 = start_col;
    let d1 = start_col.saturating_add(count);
    let mut changed = false;
    for b in store.values_mut() {
        if b.sheet_index != sheet_index || b.end_col < d0 {
            continue;
        }
        changed = true;
        let new_start = if b.start_col >= d1 {
            b.start_col - count
        } else if b.start_col >= d0 {
            d0
        } else {
            b.start_col
        };
        let new_end = if b.end_col >= d1 {
            b.end_col - count
        } else if d0 > 0 {
            d0 - 1
        } else {
            b.orphaned = true;
            b.enabled = false;
            continue;
        };
        if new_end < new_start {
            b.orphaned = true;
            b.enabled = false;
        } else {
            b.start_col = new_start;
            b.end_col = new_end;
        }
    }
    changed
}

// ============================================================================
// Persistence (per-binding opaque payload, keyed by SheetId)
// ============================================================================

/// The persisted in-sheet payload of one binding (sheet association rides on
/// the carrier's SheetId; sheet_index is runtime-only).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedCellBehaviorEntry {
    pub id: String,
    pub script_id: String,
    pub start_row: u32,
    pub start_col: u32,
    pub end_row: u32,
    pub end_col: u32,
    #[serde(default = "default_true")]
    pub claim_click: bool,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default)]
    pub orphaned: bool,
}

/// Collect the live binding store into per-binding payloads for the
/// persistence carrier. Bindings on unresolvable sheets are skipped.
pub fn collect_cell_behaviors_for_save(
    store: &CellBehaviorStorage,
    sheet_ids: &[identity::SheetId],
) -> Vec<persistence::SavedCellBehavior> {
    let mut saved: Vec<persistence::SavedCellBehavior> = Vec::new();
    for b in store.values() {
        let Some(&sheet_id) = sheet_ids.get(b.sheet_index) else {
            continue;
        };
        let entry = SavedCellBehaviorEntry {
            id: b.id.clone(),
            script_id: b.script_id.clone(),
            start_row: b.start_row,
            start_col: b.start_col,
            end_row: b.end_row,
            end_col: b.end_col,
            claim_click: b.claim_click,
            enabled: b.enabled,
            orphaned: b.orphaned,
        };
        if let Ok(value) = serde_json::to_value(&entry) {
            saved.push(persistence::SavedCellBehavior {
                sheet_id,
                binding: value,
            });
        }
    }
    // Deterministic carrier ordering (binding id inside the payload).
    saved.sort_by(|a, b| {
        (a.sheet_id, a.binding["id"].as_str().unwrap_or(""))
            .cmp(&(b.sheet_id, b.binding["id"].as_str().unwrap_or("")))
    });
    saved
}

/// Materialize persisted bindings into the store at the sheet indices resolved
/// by `sheet_index_of`. Returns the number added.
pub fn materialize_saved_cell_behaviors(
    saved: &[persistence::SavedCellBehavior],
    store: &mut CellBehaviorStorage,
    mut sheet_index_of: impl FnMut(identity::SheetId) -> Option<usize>,
) -> usize {
    let mut added = 0;
    for s in saved {
        let Some(idx) = sheet_index_of(s.sheet_id) else {
            continue;
        };
        let Ok(entry) = serde_json::from_value::<SavedCellBehaviorEntry>(s.binding.clone()) else {
            continue;
        };
        store.insert(
            entry.id.clone(),
            CellBehaviorBinding {
                id: entry.id,
                script_id: entry.script_id,
                sheet_index: idx,
                start_row: entry.start_row,
                start_col: entry.start_col,
                end_row: entry.end_row,
                end_col: entry.end_col,
                claim_click: entry.claim_click,
                enabled: entry.enabled,
                orphaned: entry.orphaned,
            },
        );
        added += 1;
    }
    added
}

// ============================================================================
// Tauri Commands
// ============================================================================

/// Create or replace a binding (undoable). The binding's id is caller-supplied
/// (a UUID minted frontend-side so it can double as the script instanceId).
#[tauri::command]
pub fn set_cell_behavior(
    state: State<AppState>,
    binding: CellBehaviorBinding,
) -> CellBehaviorBinding {
    let mut store = state.cell_behaviors.lock().unwrap();
    let previous = all_bindings(&store);
    store.insert(binding.id.clone(), binding.clone());
    drop(store);

    crate::undo_commands::record_cell_behaviors_undo(&state, previous, "Attach cell behavior");
    binding
}

/// Remove a binding (undoable). Returns whether it existed. The associated
/// script is NOT removed here — script lifecycle belongs to the script UI.
#[tauri::command]
pub fn remove_cell_behavior(state: State<AppState>, id: String) -> bool {
    let mut store = state.cell_behaviors.lock().unwrap();
    if !store.contains_key(&id) {
        return false;
    }
    let previous = all_bindings(&store);
    store.remove(&id);
    drop(store);

    crate::undo_commands::record_cell_behaviors_undo(&state, previous, "Remove cell behavior");
    true
}

/// Enable/disable a binding (undoable). Returns whether it existed.
#[tauri::command]
pub fn set_cell_behavior_enabled(state: State<AppState>, id: String, enabled: bool) -> bool {
    let mut store = state.cell_behaviors.lock().unwrap();
    if !store.contains_key(&id) {
        return false;
    }
    let previous = all_bindings(&store);
    if let Some(b) = store.get_mut(&id) {
        b.enabled = enabled;
    }
    drop(store);

    crate::undo_commands::record_cell_behaviors_undo(
        &state,
        previous,
        if enabled { "Enable cell behavior" } else { "Disable cell behavior" },
    );
    true
}

/// Get one binding by id.
#[tauri::command]
pub fn get_cell_behavior(state: State<AppState>, id: String) -> Option<CellBehaviorBinding> {
    let store = state.cell_behaviors.lock().unwrap();
    store.get(&id).cloned()
}

/// Get every binding (all sheets; the frontend indexes them spatially).
#[tauri::command]
pub fn get_all_cell_behaviors(state: State<AppState>) -> Vec<CellBehaviorBinding> {
    let store = state.cell_behaviors.lock().unwrap();
    all_bindings(&store)
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    fn binding(id: &str, sheet: usize, r0: u32, c0: u32, r1: u32, c1: u32) -> CellBehaviorBinding {
        CellBehaviorBinding {
            id: id.to_string(),
            script_id: format!("script-{id}"),
            sheet_index: sheet,
            start_row: r0,
            start_col: c0,
            end_row: r1,
            end_col: c1,
            claim_click: true,
            enabled: true,
            orphaned: false,
        }
    }

    fn store_with(bindings: Vec<CellBehaviorBinding>) -> CellBehaviorStorage {
        let mut s = CellBehaviorStorage::new();
        for b in bindings {
            s.insert(b.id.clone(), b);
        }
        s
    }

    #[test]
    fn insert_above_shifts_inside_grows() {
        let mut s = store_with(vec![binding("a", 0, 5, 0, 8, 2), binding("b", 1, 5, 0, 8, 2)]);
        // Insert 2 rows at row 3 (above): whole target shifts.
        assert!(shift_rows_for_insert(&mut s, 0, 3, 2));
        let a = &s["a"];
        assert_eq!((a.start_row, a.end_row), (7, 10));
        // Other sheet untouched.
        assert_eq!((s["b"].start_row, s["b"].end_row), (5, 8));

        // Insert inside: grows.
        assert!(shift_rows_for_insert(&mut s, 0, 8, 3));
        let a = &s["a"];
        assert_eq!((a.start_row, a.end_row), (7, 13));

        // Insert below: unchanged.
        assert!(!shift_rows_for_insert(&mut s, 0, 14, 1));
    }

    #[test]
    fn delete_overlapping_shrinks() {
        let mut s = store_with(vec![binding("a", 0, 5, 0, 8, 2)]);
        // Delete rows 7..=9 (count 3 at 7): overlap trims the tail.
        assert!(shift_rows_for_delete(&mut s, 0, 7, 3));
        let a = &s["a"];
        assert_eq!((a.start_row, a.end_row), (5, 6));
        assert!(!a.orphaned);

        // Delete rows 0..=1 (fully above): shifts up.
        assert!(shift_rows_for_delete(&mut s, 0, 0, 2));
        let a = &s["a"];
        assert_eq!((a.start_row, a.end_row), (3, 4));
    }

    #[test]
    fn delete_head_overlap_clamps_start() {
        let mut s = store_with(vec![binding("a", 0, 5, 0, 8, 2)]);
        // Delete rows 4..=6: rows 5-6 of the target vanish; 7-8 slide to 4-5.
        assert!(shift_rows_for_delete(&mut s, 0, 4, 3));
        let a = &s["a"];
        assert_eq!((a.start_row, a.end_row), (4, 5));
        assert!(!a.orphaned);
    }

    #[test]
    fn delete_containing_orphans_and_disables() {
        let mut s = store_with(vec![binding("a", 0, 5, 0, 6, 2)]);
        assert!(shift_rows_for_delete(&mut s, 0, 4, 5));
        let a = &s["a"];
        assert!(a.orphaned);
        assert!(!a.enabled);
    }

    #[test]
    fn delete_from_row_zero_through_target_orphans() {
        let mut s = store_with(vec![binding("a", 0, 0, 0, 3, 2)]);
        assert!(shift_rows_for_delete(&mut s, 0, 0, 10));
        assert!(s["a"].orphaned);
    }

    #[test]
    fn col_shifts_mirror_row_semantics() {
        let mut s = store_with(vec![binding("a", 0, 0, 5, 2, 8)]);
        assert!(shift_cols_for_insert(&mut s, 0, 6, 2));
        assert_eq!((s["a"].start_col, s["a"].end_col), (5, 10));
        assert!(shift_cols_for_delete(&mut s, 0, 0, 5));
        assert_eq!((s["a"].start_col, s["a"].end_col), (0, 5));
    }

    #[test]
    fn collect_and_materialize_round_trip() {
        let s = store_with(vec![binding("a", 0, 1, 1, 2, 2), binding("b", 1, 0, 0, 0, 0)]);
        let sheet_ids = vec![
            identity::SheetId::from_bytes(identity::generate_uuid_v7()),
            identity::SheetId::from_bytes(identity::generate_uuid_v7()),
        ];
        let saved = collect_cell_behaviors_for_save(&s, &sheet_ids);
        assert_eq!(saved.len(), 2);

        let mut restored = CellBehaviorStorage::new();
        let added = materialize_saved_cell_behaviors(&saved, &mut restored, |sid| {
            if sid == sheet_ids[0] {
                Some(3) // remapped index
            } else {
                None // unresolvable sheet: skipped
            }
        });
        assert_eq!(added, 1);
        let a = restored.get("a").expect("binding restored");
        assert_eq!(a.sheet_index, 3);
        assert_eq!(a.script_id, "script-a");
        assert!(a.claim_click);
    }

    #[test]
    fn replace_all_swaps_whole_store() {
        let mut s = store_with(vec![binding("a", 0, 0, 0, 0, 0)]);
        replace_all(&mut s, vec![binding("b", 0, 1, 1, 1, 1)]);
        assert!(!s.contains_key("a"));
        assert!(s.contains_key("b"));
    }
}
