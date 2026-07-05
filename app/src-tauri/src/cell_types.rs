//! FILENAME: app/src-tauri/src/cell_types.rs
// PURPOSE: Per-cell "cell type" assignment storage and Tauri commands.
// CONTEXT: A cell type composes rendering + editing + interaction + validation
//          into one registrable brick (docs/design/granular-bricks.md). The
//          frontend registry (app/src/api/cellTypes.ts) owns the type
//          DEFINITIONS (checkbox, progress, button, ...); this module owns the
//          per-cell ASSIGNMENTS: (sheet_index, row, col) -> { typeId, params }.
//          Assignments are undoable ("obj_cell_types"), persisted per sheet
//          keyed by SheetId (like controls/validations), and — unlike the
//          older per-cell stores — shifted by structural row/column edits
//          inside the same undo transaction as the grid change.

use crate::AppState;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use tauri::State;

// ============================================================================
// Types
// ============================================================================

/// The assignment payload for one cell: which registered type renders/handles
/// it, plus type-specific parameters (opaque JSON owned by the type's
/// definition — e.g. `{ "max": 100 }` for a progress bar).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CellTypeAssignment {
    pub type_id: String,
    #[serde(default)]
    pub params: serde_json::Value,
}

/// Location key for an assignment: (sheet_index, row, col)
type CellTypeKey = (usize, u32, u32);

/// Storage for all assignments: (sheet_index, row, col) -> CellTypeAssignment
pub type CellTypeStorage = HashMap<CellTypeKey, CellTypeAssignment>;

/// An assignment with its location, for returning lists over IPC.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CellTypeEntry {
    pub sheet_index: usize,
    pub row: u32,
    pub col: u32,
    pub type_id: String,
    #[serde(default)]
    pub params: serde_json::Value,
}

/// Hard cap on cells affected by one range command. Assignments are stored
/// per cell, so an unbounded full-column apply (1M rows) would explode the
/// store; selections that large are a mistake, not a use case.
const MAX_RANGE_CELLS: u64 = 100_000;

/// All assignments for one sheet, sorted (row, col) for deterministic
/// snapshots/artifacts.
pub fn entries_for_sheet(store: &CellTypeStorage, sheet_index: usize) -> Vec<CellTypeEntry> {
    let mut entries: Vec<CellTypeEntry> = store
        .iter()
        .filter(|((si, _, _), _)| *si == sheet_index)
        .map(|((si, r, c), a)| CellTypeEntry {
            sheet_index: *si,
            row: *r,
            col: *c,
            type_id: a.type_id.clone(),
            params: a.params.clone(),
        })
        .collect();
    entries.sort_by_key(|e| (e.row, e.col));
    entries
}

/// Replace every assignment on `sheet_index` with `entries` (undo restore path).
pub fn replace_sheet_entries(
    store: &mut CellTypeStorage,
    sheet_index: usize,
    entries: Vec<CellTypeEntry>,
) {
    store.retain(|(si, _, _), _| *si != sheet_index);
    for e in entries {
        store.insert(
            (sheet_index, e.row, e.col),
            CellTypeAssignment { type_id: e.type_id, params: e.params },
        );
    }
}

// ============================================================================
// Structural shifts (insert/delete rows/columns)
// ============================================================================
// Called from commands/structure.rs with the undo transaction still open, so
// one Ctrl+Z restores the grid and the assignments atomically. Returns whether
// anything on the sheet changed (callers skip undo recording when false).

pub fn shift_rows_for_insert(
    store: &mut CellTypeStorage,
    sheet_index: usize,
    start_row: u32,
    count: u32,
) -> bool {
    let keys: Vec<CellTypeKey> = store
        .keys()
        .filter(|(si, r, _)| *si == sheet_index && *r >= start_row)
        .copied()
        .collect();
    if keys.is_empty() {
        return false;
    }
    let mut moved = Vec::with_capacity(keys.len());
    for key in keys {
        if let Some(v) = store.remove(&key) {
            moved.push((key, v));
        }
    }
    for ((si, r, c), v) in moved {
        store.insert((si, r + count, c), v);
    }
    true
}

pub fn shift_rows_for_delete(
    store: &mut CellTypeStorage,
    sheet_index: usize,
    start_row: u32,
    count: u32,
) -> bool {
    let end = start_row.saturating_add(count);
    let keys: Vec<CellTypeKey> = store
        .keys()
        .filter(|(si, r, _)| *si == sheet_index && *r >= start_row)
        .copied()
        .collect();
    if keys.is_empty() {
        return false;
    }
    let mut moved = Vec::new();
    for key in keys {
        let v = store.remove(&key);
        let (si, r, c) = key;
        if r >= end {
            if let Some(v) = v {
                moved.push(((si, r - count, c), v));
            }
        }
        // r in [start_row, end): the cell was deleted; the assignment drops.
    }
    for (key, v) in moved {
        store.insert(key, v);
    }
    true
}

pub fn shift_cols_for_insert(
    store: &mut CellTypeStorage,
    sheet_index: usize,
    start_col: u32,
    count: u32,
) -> bool {
    let keys: Vec<CellTypeKey> = store
        .keys()
        .filter(|(si, _, c)| *si == sheet_index && *c >= start_col)
        .copied()
        .collect();
    if keys.is_empty() {
        return false;
    }
    let mut moved = Vec::with_capacity(keys.len());
    for key in keys {
        if let Some(v) = store.remove(&key) {
            moved.push((key, v));
        }
    }
    for ((si, r, c), v) in moved {
        store.insert((si, r, c + count), v);
    }
    true
}

pub fn shift_cols_for_delete(
    store: &mut CellTypeStorage,
    sheet_index: usize,
    start_col: u32,
    count: u32,
) -> bool {
    let end = start_col.saturating_add(count);
    let keys: Vec<CellTypeKey> = store
        .keys()
        .filter(|(si, _, c)| *si == sheet_index && *c >= start_col)
        .copied()
        .collect();
    if keys.is_empty() {
        return false;
    }
    let mut moved = Vec::new();
    for key in keys {
        let v = store.remove(&key);
        let (si, r, c) = key;
        if c >= end {
            if let Some(v) = v {
                moved.push(((si, r, c - count), v));
            }
        }
    }
    for (key, v) in moved {
        store.insert(key, v);
    }
    true
}

// ============================================================================
// Persistence (opaque per-sheet payload, keyed by SheetId)
// ============================================================================

/// One persisted assignment inside a sheet's opaque `SavedSheetCellTypes`
/// payload. In-sheet coordinates only; the sheet association rides on the
/// carrier's SheetId (like controls / data validations).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedCellTypeEntry {
    pub row: u32,
    pub col: u32,
    pub type_id: String,
    #[serde(default)]
    pub params: serde_json::Value,
}

/// Collect the live assignment store into per-sheet opaque payloads for the
/// persistence carrier. Sheets without assignments produce no entry.
pub fn collect_cell_types_for_save(
    cell_types: &CellTypeStorage,
    sheet_ids: &[identity::SheetId],
) -> Vec<persistence::SavedSheetCellTypes> {
    let mut per_sheet: HashMap<usize, Vec<SavedCellTypeEntry>> = HashMap::new();
    for ((sheet_index, row, col), a) in cell_types.iter() {
        per_sheet
            .entry(*sheet_index)
            .or_default()
            .push(SavedCellTypeEntry {
                row: *row,
                col: *col,
                type_id: a.type_id.clone(),
                params: a.params.clone(),
            });
    }
    let mut saved = Vec::new();
    for (sheet_index, mut entries) in per_sheet {
        let Some(&sheet_id) = sheet_ids.get(sheet_index) else {
            continue;
        };
        // Deterministic artifact bytes across saves (HashMap iteration order
        // would otherwise churn checksums/diffs for identical content).
        entries.sort_by_key(|e| (e.row, e.col));
        if let Ok(value) = serde_json::to_value(&entries) {
            saved.push(persistence::SavedSheetCellTypes {
                sheet_id,
                cells: value,
            });
        }
    }
    saved.sort_by_key(|s| s.sheet_id);
    saved
}

/// Materialize persisted per-sheet assignment payloads into CellTypeStorage
/// entries at the sheet indices resolved by `sheet_index_of`. Entries whose
/// sheet cannot be resolved are skipped. Returns the number of assignments
/// added.
pub fn materialize_saved_cell_types(
    saved: &[persistence::SavedSheetCellTypes],
    cell_types: &mut CellTypeStorage,
    mut sheet_index_of: impl FnMut(identity::SheetId) -> Option<usize>,
) -> usize {
    let mut added = 0;
    for sheet_cell_types in saved {
        let Some(idx) = sheet_index_of(sheet_cell_types.sheet_id) else {
            continue;
        };
        let Ok(entries) =
            serde_json::from_value::<Vec<SavedCellTypeEntry>>(sheet_cell_types.cells.clone())
        else {
            continue;
        };
        for entry in entries {
            cell_types.insert(
                (idx, entry.row, entry.col),
                CellTypeAssignment { type_id: entry.type_id, params: entry.params },
            );
            added += 1;
        }
    }
    added
}

// ============================================================================
// Tauri Commands
// ============================================================================

/// Assign a cell type to a single cell on the active sheet (undoable).
#[tauri::command]
pub fn set_cell_type(
    state: State<AppState>,
    row: u32,
    col: u32,
    type_id: String,
    params: Option<serde_json::Value>,
) -> CellTypeEntry {
    let sheet_index = *state.active_sheet.lock().unwrap();
    let mut cell_types = state.cell_types.lock().unwrap();
    let previous = entries_for_sheet(&cell_types, sheet_index);
    let assignment = CellTypeAssignment {
        type_id,
        params: params.unwrap_or_else(|| serde_json::json!({})),
    };
    cell_types.insert((sheet_index, row, col), assignment.clone());
    drop(cell_types);

    crate::undo_commands::record_cell_types_undo(&state, sheet_index, previous, "Set cell type");

    CellTypeEntry {
        sheet_index,
        row,
        col,
        type_id: assignment.type_id,
        params: assignment.params,
    }
}

/// Assign a cell type to every cell in a range on the active sheet (one undo
/// step). Errors when the range exceeds the per-command cell cap.
#[tauri::command]
pub fn set_cell_type_range(
    state: State<AppState>,
    start_row: u32,
    start_col: u32,
    end_row: u32,
    end_col: u32,
    type_id: String,
    params: Option<serde_json::Value>,
) -> Result<u32, String> {
    let min_row = start_row.min(end_row);
    let max_row = start_row.max(end_row);
    let min_col = start_col.min(end_col);
    let max_col = start_col.max(end_col);
    let cell_count =
        (max_row as u64 - min_row as u64 + 1) * (max_col as u64 - min_col as u64 + 1);
    if cell_count > MAX_RANGE_CELLS {
        return Err(format!(
            "Range covers {} cells; cell types can be applied to at most {} cells at once",
            cell_count, MAX_RANGE_CELLS
        ));
    }

    let sheet_index = *state.active_sheet.lock().unwrap();
    let params = params.unwrap_or_else(|| serde_json::json!({}));
    let mut cell_types = state.cell_types.lock().unwrap();
    let previous = entries_for_sheet(&cell_types, sheet_index);
    let mut count = 0u32;
    for row in min_row..=max_row {
        for col in min_col..=max_col {
            cell_types.insert(
                (sheet_index, row, col),
                CellTypeAssignment { type_id: type_id.clone(), params: params.clone() },
            );
            count += 1;
        }
    }
    drop(cell_types);

    crate::undo_commands::record_cell_types_undo(&state, sheet_index, previous, "Set cell type");
    Ok(count)
}

/// Remove the cell-type assignment from a single cell on the active sheet
/// (undoable). Returns whether an assignment existed.
#[tauri::command]
pub fn clear_cell_type(state: State<AppState>, row: u32, col: u32) -> bool {
    let sheet_index = *state.active_sheet.lock().unwrap();
    let mut cell_types = state.cell_types.lock().unwrap();
    if !cell_types.contains_key(&(sheet_index, row, col)) {
        return false;
    }
    let previous = entries_for_sheet(&cell_types, sheet_index);
    cell_types.remove(&(sheet_index, row, col));
    drop(cell_types);

    crate::undo_commands::record_cell_types_undo(&state, sheet_index, previous, "Clear cell type");
    true
}

/// Remove all cell-type assignments inside a range on the active sheet (one
/// undo step). Returns how many were removed.
#[tauri::command]
pub fn clear_cell_type_range(
    state: State<AppState>,
    start_row: u32,
    start_col: u32,
    end_row: u32,
    end_col: u32,
) -> u32 {
    let min_row = start_row.min(end_row);
    let max_row = start_row.max(end_row);
    let min_col = start_col.min(end_col);
    let max_col = start_col.max(end_col);

    let sheet_index = *state.active_sheet.lock().unwrap();
    let mut cell_types = state.cell_types.lock().unwrap();
    let has_any = cell_types.keys().any(|(si, r, c)| {
        *si == sheet_index && *r >= min_row && *r <= max_row && *c >= min_col && *c <= max_col
    });
    if !has_any {
        return 0;
    }
    let previous = entries_for_sheet(&cell_types, sheet_index);
    let before = cell_types.len();
    cell_types.retain(|(si, r, c), _| {
        !(*si == sheet_index && *r >= min_row && *r <= max_row && *c >= min_col && *c <= max_col)
    });
    let removed = (before - cell_types.len()) as u32;
    drop(cell_types);

    crate::undo_commands::record_cell_types_undo(&state, sheet_index, previous, "Clear cell type");
    removed
}

/// Get the cell-type assignment for a specific cell on the active sheet.
#[tauri::command]
pub fn get_cell_type(state: State<AppState>, row: u32, col: u32) -> Option<CellTypeAssignment> {
    let sheet_index = *state.active_sheet.lock().unwrap();
    let cell_types = state.cell_types.lock().unwrap();
    cell_types.get(&(sheet_index, row, col)).cloned()
}

/// Get all cell-type assignments for a sheet (sorted row, col). Defaults to
/// the active sheet so the frontend index never races a sheet switch.
#[tauri::command]
pub fn get_all_cell_types(
    state: State<AppState>,
    sheet_index: Option<usize>,
) -> Vec<CellTypeEntry> {
    let sheet_index =
        sheet_index.unwrap_or_else(|| *state.active_sheet.lock().unwrap());
    let cell_types = state.cell_types.lock().unwrap();
    entries_for_sheet(&cell_types, sheet_index)
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    fn assignment(type_id: &str) -> CellTypeAssignment {
        CellTypeAssignment {
            type_id: type_id.to_string(),
            params: serde_json::json!({ "max": 100 }),
        }
    }

    fn sample_storage() -> CellTypeStorage {
        let mut store: CellTypeStorage = HashMap::new();
        store.insert((0, 2, 3), assignment("calcula.checkbox"));
        store.insert((0, 5, 3), assignment("calcula.progress"));
        store.insert((1, 0, 0), assignment("calcula.button"));
        store
    }

    #[test]
    fn entries_for_sheet_filters_and_sorts() {
        let store = sample_storage();
        let entries = entries_for_sheet(&store, 0);
        assert_eq!(entries.len(), 2);
        assert_eq!((entries[0].row, entries[0].col), (2, 3));
        assert_eq!((entries[1].row, entries[1].col), (5, 3));
        assert_eq!(entries_for_sheet(&store, 1).len(), 1);
        assert!(entries_for_sheet(&store, 2).is_empty());
    }

    #[test]
    fn replace_sheet_entries_swaps_only_that_sheet() {
        let mut store = sample_storage();
        replace_sheet_entries(
            &mut store,
            0,
            vec![CellTypeEntry {
                sheet_index: 0,
                row: 9,
                col: 9,
                type_id: "calcula.button".to_string(),
                params: serde_json::json!({}),
            }],
        );
        assert_eq!(entries_for_sheet(&store, 0).len(), 1);
        assert!(store.contains_key(&(0, 9, 9)));
        // Sheet 1 untouched
        assert!(store.contains_key(&(1, 0, 0)));
    }

    #[test]
    fn shift_rows_insert_moves_at_and_below() {
        let mut store = sample_storage();
        let changed = shift_rows_for_insert(&mut store, 0, 3, 2);
        assert!(changed);
        // Row 2 (above insertion point) stays; row 5 moves to 7.
        assert!(store.contains_key(&(0, 2, 3)));
        assert!(!store.contains_key(&(0, 5, 3)));
        assert!(store.contains_key(&(0, 7, 3)));
        // Other sheet untouched.
        assert!(store.contains_key(&(1, 0, 0)));
    }

    #[test]
    fn shift_rows_insert_at_the_tagged_row_moves_it() {
        let mut store = sample_storage();
        shift_rows_for_insert(&mut store, 0, 2, 1);
        assert!(!store.contains_key(&(0, 2, 3)));
        assert!(store.contains_key(&(0, 3, 3)));
        assert!(store.contains_key(&(0, 6, 3)));
    }

    #[test]
    fn shift_rows_delete_drops_deleted_and_shifts_below() {
        let mut store = sample_storage();
        // Delete rows 2..=3: the checkbox at row 2 drops, progress at 5 -> 3.
        let changed = shift_rows_for_delete(&mut store, 0, 2, 2);
        assert!(changed);
        assert!(!store.contains_key(&(0, 2, 3)));
        assert!(store.contains_key(&(0, 3, 3)));
        assert_eq!(entries_for_sheet(&store, 0).len(), 1);
    }

    #[test]
    fn shift_rows_no_entries_on_sheet_reports_unchanged() {
        let mut store = sample_storage();
        assert!(!shift_rows_for_insert(&mut store, 2, 0, 5));
        assert!(!shift_rows_for_delete(&mut store, 2, 0, 5));
        // Insertions strictly below every tag change nothing.
        assert!(!shift_rows_for_insert(&mut store, 0, 6, 5));
    }

    #[test]
    fn shift_cols_insert_and_delete() {
        let mut store = sample_storage();
        shift_cols_for_insert(&mut store, 0, 0, 2);
        assert!(store.contains_key(&(0, 2, 5)));
        assert!(store.contains_key(&(0, 5, 5)));

        // Delete cols 5..=5: both tags (now at col 5) drop.
        shift_cols_for_delete(&mut store, 0, 5, 1);
        assert!(entries_for_sheet(&store, 0).is_empty());
        assert!(store.contains_key(&(1, 0, 0)));
    }

    #[test]
    fn shift_cols_delete_before_shifts_left() {
        let mut store = sample_storage();
        shift_cols_for_delete(&mut store, 0, 0, 2);
        assert!(store.contains_key(&(0, 2, 1)));
        assert!(store.contains_key(&(0, 5, 1)));
    }

    #[test]
    fn collect_and_materialize_round_trip() {
        let store = sample_storage();
        let sheet_ids = vec![
            identity::SheetId::from_bytes(identity::generate_uuid_v7()),
            identity::SheetId::from_bytes(identity::generate_uuid_v7()),
        ];
        let saved = collect_cell_types_for_save(&store, &sheet_ids);
        assert_eq!(saved.len(), 2);

        let mut restored: CellTypeStorage = HashMap::new();
        let added = materialize_saved_cell_types(&saved, &mut restored, |sid| {
            // Remap: sheet 0 -> index 5, sheet 1 -> unresolvable (skipped).
            if sid == sheet_ids[0] {
                Some(5)
            } else {
                None
            }
        });
        assert_eq!(added, 2);
        let a = restored
            .get(&(5, 2, 3))
            .expect("assignment restored at remapped sheet");
        assert_eq!(a.type_id, "calcula.checkbox");
        assert_eq!(a.params, serde_json::json!({ "max": 100 }));
        assert!(restored.get(&(5, 5, 3)).is_some());
        assert_eq!(restored.len(), 2, "unresolvable sheet skipped");
    }

    #[test]
    fn collect_is_deterministic() {
        let store = sample_storage();
        let sheet_ids = vec![
            identity::SheetId::from_bytes(identity::generate_uuid_v7()),
            identity::SheetId::from_bytes(identity::generate_uuid_v7()),
        ];
        let a = serde_json::to_string(&collect_cell_types_for_save(&store, &sheet_ids)).unwrap();
        let b = serde_json::to_string(&collect_cell_types_for_save(&store, &sheet_ids)).unwrap();
        assert_eq!(a, b);
    }
}
