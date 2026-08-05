//! FILENAME: app/src-tauri/src/commands/off_sheet_tests.rs
//! PURPOSE: Wave 3 cross-sheet structural ops — the three promises each
//! command makes for an explicit non-active `sheet_index`:
//!   1. the mutation LANDS on the target sheet (and only there);
//!   2. undo is recorded SHEET-TAGGED, so Ctrl+Z restores the right sheet
//!      no matter which sheet is active by then;
//!   3. protection is checked on the TARGET sheet, not the active one.
//!
//! The restore half of promise 2 (actually replaying the payload) is pinned by
//! the `apply_sheet_structural_restore` / `apply_sheet_merge_regions_restore`
//! tests in undo_commands.rs, which own those private fns.

use crate::api_types::{ClearApplyTo, ClearRangeParams, SortField, SortOrientation, SortRangeParams};
use crate::commands::structure::off_sheet_structural_edit;
use crate::persistence::{FileState, UserFilesState};
use crate::pivot::types::PivotState;
use crate::AppState;
use engine::{Cell, CellValue};
use std::collections::{HashMap, HashSet};

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

struct Aux {
    file: FileState,
    files: UserFilesState,
    pivots: PivotState,
    pane: crate::pane_control::PaneControlState,
    filters: crate::ribbon_filter::RibbonFilterState,
}

fn aux() -> Aux {
    Aux {
        file: FileState::default(),
        files: UserFilesState::default(),
        pivots: PivotState::new(),
        pane: crate::pane_control::PaneControlState::new(),
        filters: crate::ribbon_filter::RibbonFilterState::new(),
    }
}

/// Workbook with two sheets, sheet 0 active. Sheet 2's grid is handed to the
/// caller for seeding.
fn two_sheet_state(seed_sheet2: impl FnOnce(&mut engine::Grid)) -> AppState {
    let state = crate::create_app_state();
    {
        let mut grid2 = engine::Grid::new();
        seed_sheet2(&mut grid2);
        state.grids.lock().unwrap().push(grid2);
        state.sheet_names.lock().unwrap().push("Sheet2".to_string());
        state.all_column_widths.lock().unwrap().push(HashMap::new());
        state.all_row_heights.lock().unwrap().push(HashMap::new());
        // create_app_state leaves all_merged_regions EMPTY (the mirror holds
        // the active sheet's set); size it for both sheets so tests can index.
        {
            let mut all = state.all_merged_regions.lock().unwrap();
            while all.len() < 2 {
                all.push(HashSet::new());
            }
        }
        state
            .sheet_ids
            .lock()
            .unwrap()
            .push(identity::SheetId::from_bytes(identity::generate_uuid_v7()));
    }
    // The active mirror gets a sentinel so cross-contamination is detectable.
    state
        .grid
        .lock()
        .unwrap()
        .set_cell(0, 0, Cell::new_number(999.0));
    state.grids.lock().unwrap()[0].set_cell(0, 0, Cell::new_number(999.0));
    state
}

/// Enable sheet protection with Excel-default options (everything disallowed).
fn protect_sheet(state: &AppState, sheet: usize) {
    state.sheet_protection.lock().unwrap().insert(
        sheet,
        crate::protection::SheetProtection {
            protected: true,
            ..Default::default()
        },
    );
}

fn value_at(state: &AppState, sheet: usize, row: u32, col: u32) -> Option<CellValue> {
    state.grids.lock().unwrap()[sheet]
        .get_cell(row, col)
        .map(|c| c.value.clone())
}

/// All CustomRestore (kind, data) pairs of the single undo transaction.
fn undo_restores(state: &AppState) -> Vec<(String, Vec<u8>)> {
    let mut undo = state.undo_stack.lock().unwrap();
    assert_eq!(undo.undo_depth(), 1, "exactly one undoable action");
    let transaction = undo.pop_undo().expect("a transaction");
    transaction
        .changes
        .iter()
        .filter_map(|c| match c {
            engine::undo::CellChange::CustomRestore { kind, data } => {
                Some((kind.clone(), data.clone()))
            }
            _ => None,
        })
        .collect()
}

fn mirror_untouched(state: &AppState) {
    let mirror = state.grid.lock().unwrap();
    assert_eq!(
        mirror.get_cell(0, 0).map(|c| c.value.clone()),
        Some(CellValue::Number(999.0)),
        "the ACTIVE sheet's mirror must not be touched by an off-sheet op"
    );
}

// ---------------------------------------------------------------------------
// insert/delete rows/columns
// ---------------------------------------------------------------------------

#[test]
fn off_sheet_insert_rows_lands_and_records_sheet_tagged_undo() {
    let state = two_sheet_state(|g| {
        g.set_cell(0, 0, Cell::new_number(1.0));
        g.set_cell(4, 0, Cell::new_number(2.0));
    });
    let a = aux();

    off_sheet_structural_edit(
        &state, &a.file, &a.pivots, &a.files, &a.pane, &a.filters,
        1,
        calp::writeback::StructuralEdit::RowInsert { at: 2, count: 3 },
    )
    .expect("insert succeeds");

    assert_eq!(value_at(&state, 1, 0, 0), Some(CellValue::Number(1.0)), "above the insert: unmoved");
    assert_eq!(value_at(&state, 1, 7, 0), Some(CellValue::Number(2.0)), "below the insert: shifted down");
    assert_eq!(value_at(&state, 1, 4, 0), None, "old position vacated");
    mirror_untouched(&state);
    assert!(*a.file.is_modified.lock().unwrap(), "workbook dirtied");

    let restores = undo_restores(&state);
    let (kind, data) = restores
        .iter()
        .find(|(k, _)| k == "sheet_structural_snapshot")
        .expect("a sheet-tagged structural snapshot");
    assert_eq!(kind, "sheet_structural_snapshot");
    let snapshot: crate::undo_commands::SheetStructuralSnapshot =
        serde_json::from_slice(data).expect("payload deserializes");
    assert_eq!(snapshot.sheet_index, 1, "undo targets the EDITED sheet");
    assert!(
        snapshot
            .cells
            .iter()
            .any(|(r, c, cell)| *r == 4 && *c == 0 && cell.value == CellValue::Number(2.0)),
        "snapshot carries the pre-insert cell at its pre-insert position"
    );
}

#[test]
fn off_sheet_delete_rows_lands_and_snapshots_the_deleted_cells() {
    let state = two_sheet_state(|g| {
        g.set_cell(1, 0, Cell::new_number(10.0));
        g.set_cell(5, 0, Cell::new_number(20.0));
    });
    let a = aux();

    off_sheet_structural_edit(
        &state, &a.file, &a.pivots, &a.files, &a.pane, &a.filters,
        1,
        calp::writeback::StructuralEdit::RowDelete { at: 1, count: 2 },
    )
    .expect("delete succeeds");

    assert_eq!(value_at(&state, 1, 1, 0), None, "deleted row is gone");
    assert_eq!(value_at(&state, 1, 3, 0), Some(CellValue::Number(20.0)), "below shifted up by 2");
    mirror_untouched(&state);

    let restores = undo_restores(&state);
    let (_, data) = restores
        .iter()
        .find(|(k, _)| k == "sheet_structural_snapshot")
        .expect("structural snapshot present");
    let snapshot: crate::undo_commands::SheetStructuralSnapshot =
        serde_json::from_slice(data).unwrap();
    assert_eq!(snapshot.sheet_index, 1);
    assert!(
        snapshot
            .cells
            .iter()
            .any(|(r, _, cell)| *r == 1 && cell.value == CellValue::Number(10.0)),
        "the DELETED cell is in the snapshot, so undo can resurrect it"
    );
}

#[test]
fn off_sheet_insert_columns_shifts_right_on_the_target_only() {
    let state = two_sheet_state(|g| {
        g.set_cell(0, 1, Cell::new_number(7.0));
    });
    let a = aux();

    off_sheet_structural_edit(
        &state, &a.file, &a.pivots, &a.files, &a.pane, &a.filters,
        1,
        calp::writeback::StructuralEdit::ColInsert { at: 0, count: 2 },
    )
    .expect("insert succeeds");

    assert_eq!(value_at(&state, 1, 0, 3), Some(CellValue::Number(7.0)));
    assert_eq!(value_at(&state, 1, 0, 1), None);
    mirror_untouched(&state);
}

#[test]
fn off_sheet_delete_columns_shifts_left_on_the_target_only() {
    let state = two_sheet_state(|g| {
        g.set_cell(0, 0, Cell::new_number(1.0));
        g.set_cell(0, 3, Cell::new_number(4.0));
    });
    let a = aux();

    off_sheet_structural_edit(
        &state, &a.file, &a.pivots, &a.files, &a.pane, &a.filters,
        1,
        calp::writeback::StructuralEdit::ColDelete { at: 1, count: 2 },
    )
    .expect("delete succeeds");

    assert_eq!(value_at(&state, 1, 0, 0), Some(CellValue::Number(1.0)));
    assert_eq!(value_at(&state, 1, 0, 1), Some(CellValue::Number(4.0)), "col 3 slid to col 1");
    mirror_untouched(&state);
}

#[test]
fn off_sheet_structural_edit_moves_the_target_sheets_row_heights() {
    let state = two_sheet_state(|_| {});
    state.all_row_heights.lock().unwrap()[1].insert(5, 44.0);
    let a = aux();

    off_sheet_structural_edit(
        &state, &a.file, &a.pivots, &a.files, &a.pane, &a.filters,
        1,
        calp::writeback::StructuralEdit::RowInsert { at: 0, count: 2 },
    )
    .expect("insert succeeds");

    let all_rh = state.all_row_heights.lock().unwrap();
    assert_eq!(all_rh[1].get(&7), Some(&44.0), "height moved with its row");
    assert_eq!(all_rh[1].get(&5), None);
}

#[test]
fn off_sheet_structural_edit_is_blocked_by_target_protection_not_active() {
    // Protection on the ACTIVE sheet must NOT block an edit on sheet 2 ...
    let state = two_sheet_state(|g| {
        g.set_cell(0, 0, Cell::new_number(1.0));
    });
    protect_sheet(&state, 0);
    let a = aux();
    off_sheet_structural_edit(
        &state, &a.file, &a.pivots, &a.files, &a.pane, &a.filters,
        1,
        calp::writeback::StructuralEdit::RowInsert { at: 0, count: 1 },
    )
    .expect("active-sheet protection is irrelevant to a sheet-2 edit");

    // ... and protection on the TARGET sheet must block it.
    let state = two_sheet_state(|g| {
        g.set_cell(0, 0, Cell::new_number(1.0));
    });
    protect_sheet(&state, 1);
    let err = off_sheet_structural_edit(
        &state, &a.file, &a.pivots, &a.files, &a.pane, &a.filters,
        1,
        calp::writeback::StructuralEdit::RowInsert { at: 0, count: 1 },
    )
    .expect_err("target-sheet protection must refuse the edit");
    assert!(err.to_lowercase().contains("protect"), "error names protection: {err}");
    assert_eq!(value_at(&state, 1, 0, 0), Some(CellValue::Number(1.0)), "nothing moved");
    assert_eq!(state.undo_stack.lock().unwrap().undo_depth(), 0, "no undo entry for a refused edit");
}

#[test]
fn off_sheet_structural_edit_rejects_an_out_of_range_sheet() {
    let state = two_sheet_state(|_| {});
    let a = aux();
    let err = off_sheet_structural_edit(
        &state, &a.file, &a.pivots, &a.files, &a.pane, &a.filters,
        7,
        calp::writeback::StructuralEdit::RowInsert { at: 0, count: 1 },
    )
    .expect_err("out-of-range sheet index must error");
    assert!(err.contains("out of range"), "{err}");
}

// ---------------------------------------------------------------------------
// merge / unmerge
// ---------------------------------------------------------------------------

#[test]
fn off_sheet_merge_clears_slaves_and_tags_both_undo_payloads() {
    let state = two_sheet_state(|g| {
        g.set_cell(1, 1, Cell::new_number(1.0)); // master
        g.set_cell(2, 2, Cell::new_number(9.0)); // slave — will be cleared
    });
    let a = aux();

    let result = crate::merge_commands::merge_cells_off_sheet(&state, &a.file, 1, 1, 1, 2, 2)
        .expect("merge succeeds");
    assert!(result.success);

    assert_eq!(value_at(&state, 1, 1, 1), Some(CellValue::Number(1.0)), "master keeps content");
    assert_eq!(value_at(&state, 1, 2, 2), None, "slave cleared");
    mirror_untouched(&state);

    // Geometry landed in the SHEET-2 store, not the active mirror's set.
    assert_eq!(state.all_merged_regions.lock().unwrap()[1].len(), 1);
    assert!(state.merged_regions.lock().unwrap().is_empty(), "active mirror set untouched");

    let restores = undo_restores(&state);
    let cells = restores
        .iter()
        .find(|(k, _)| k == "script_grid_cells")
        .expect("slave-cell snapshot");
    let cell_snapshot: crate::undo_commands::ScriptGridCellsSnapshot =
        serde_json::from_slice(&cells.1).unwrap();
    assert_eq!(cell_snapshot.sheet_index, 1);
    let merges = restores
        .iter()
        .find(|(k, _)| k == "sheet_merge_regions")
        .expect("merge-set snapshot");
    let merge_snapshot: crate::undo_commands::SheetMergeRegionsSnapshot =
        serde_json::from_slice(&merges.1).unwrap();
    assert_eq!(merge_snapshot.sheet_index, 1);
    assert!(merge_snapshot.regions.is_empty(), "pre-merge set was empty");
}

#[test]
fn off_sheet_merge_is_blocked_by_target_protection() {
    let state = two_sheet_state(|g| {
        g.set_cell(2, 2, Cell::new_number(9.0));
    });
    protect_sheet(&state, 1);
    let a = aux();

    let err = crate::merge_commands::merge_cells_off_sheet(&state, &a.file, 1, 1, 1, 2, 2)
        .expect_err("protected target must refuse the merge");
    assert!(err.to_lowercase().contains("protect"), "{err}");
    assert_eq!(value_at(&state, 1, 2, 2), Some(CellValue::Number(9.0)), "slave survives");
}

#[test]
fn off_sheet_unmerge_removes_the_region_and_tags_the_undo() {
    let state = two_sheet_state(|_| {});
    state.all_merged_regions.lock().unwrap()[1].insert(crate::api_types::MergedRegion {
        start_row: 1,
        start_col: 1,
        end_row: 2,
        end_col: 2,
    });
    let a = aux();

    let result = crate::merge_commands::unmerge_cells_off_sheet(&state, &a.file, 1, 1, 1)
        .expect("unmerge succeeds");
    assert!(result.success);
    assert!(state.all_merged_regions.lock().unwrap()[1].is_empty());

    let restores = undo_restores(&state);
    let (_, data) = restores
        .iter()
        .find(|(k, _)| k == "sheet_merge_regions")
        .expect("merge-set snapshot");
    let snapshot: crate::undo_commands::SheetMergeRegionsSnapshot =
        serde_json::from_slice(data).unwrap();
    assert_eq!(snapshot.sheet_index, 1);
    assert_eq!(snapshot.regions.len(), 1, "the removed region is in the snapshot");
}

// ---------------------------------------------------------------------------
// clear_range_with_options
// ---------------------------------------------------------------------------

fn clear_params(apply_to: ClearApplyTo) -> ClearRangeParams {
    ClearRangeParams {
        start_row: 0,
        start_col: 0,
        end_row: 1,
        end_col: 1,
        apply_to,
        sheet_index: Some(1),
    }
}

#[test]
fn off_sheet_clear_lands_and_records_sheet_tagged_undo() {
    let state = two_sheet_state(|g| {
        g.set_cell(0, 0, Cell::new_number(5.0));
        g.set_cell(1, 1, Cell::new_number(6.0));
    });
    let a = aux();

    let result = crate::commands::data::clear_range_with_options_off_sheet(
        &state, &a.file, &a.files, &a.pivots, &a.pane, &a.filters,
        1,
        clear_params(ClearApplyTo::All),
    )
    .expect("clear succeeds");
    assert_eq!(result.count, 2);

    assert_eq!(value_at(&state, 1, 0, 0), None);
    assert_eq!(value_at(&state, 1, 1, 1), None);
    mirror_untouched(&state);
    assert!(*a.file.is_modified.lock().unwrap());

    let restores = undo_restores(&state);
    let (_, data) = restores
        .iter()
        .find(|(k, _)| k == "script_grid_cells")
        .expect("cell snapshot");
    let snapshot: crate::undo_commands::ScriptGridCellsSnapshot =
        serde_json::from_slice(data).unwrap();
    assert_eq!(snapshot.sheet_index, 1, "undo restores the TARGET sheet");
    assert_eq!(snapshot.cells.len(), 2);
}

#[test]
fn off_sheet_clear_contents_keeps_the_style() {
    let state = two_sheet_state(|g| {
        let mut cell = Cell::new_number(5.0);
        cell.style_index = 3;
        g.set_cell(0, 0, cell);
    });
    let a = aux();

    crate::commands::data::clear_range_with_options_off_sheet(
        &state, &a.file, &a.files, &a.pivots, &a.pane, &a.filters,
        1,
        clear_params(ClearApplyTo::Contents),
    )
    .expect("clear succeeds");

    let cell = state.grids.lock().unwrap()[1].get_cell(0, 0).cloned().expect("cell kept");
    assert_eq!(cell.value, CellValue::Empty, "value cleared");
    assert_eq!(cell.style_index, 3, "format kept");
}

#[test]
fn off_sheet_clear_is_blocked_by_target_protection() {
    let state = two_sheet_state(|g| {
        g.set_cell(0, 0, Cell::new_number(5.0));
    });
    protect_sheet(&state, 1);
    let a = aux();

    let err = crate::commands::data::clear_range_with_options_off_sheet(
        &state, &a.file, &a.files, &a.pivots, &a.pane, &a.filters,
        1,
        clear_params(ClearApplyTo::All),
    )
    .expect_err("protected target must refuse the clear");
    assert!(err.to_lowercase().contains("protect"), "{err}");
    assert_eq!(value_at(&state, 1, 0, 0), Some(CellValue::Number(5.0)));
}

// ---------------------------------------------------------------------------
// sort_range
// ---------------------------------------------------------------------------

fn sort_params() -> SortRangeParams {
    SortRangeParams {
        start_row: 0,
        start_col: 0,
        end_row: 2,
        end_col: 0,
        fields: vec![SortField {
            key: 0,
            ascending: true,
            sort_on: Default::default(),
            color: None,
            data_option: Default::default(),
            sub_field: None,
            custom_order: None,
        }],
        match_case: false,
        has_headers: false,
        orientation: SortOrientation::Rows,
        sheet_index: Some(1),
    }
}

#[test]
fn off_sheet_sort_permutes_the_target_and_records_sheet_tagged_undo() {
    let state = two_sheet_state(|g| {
        g.set_cell(0, 0, Cell::new_number(3.0));
        g.set_cell(1, 0, Cell::new_number(1.0));
        g.set_cell(2, 0, Cell::new_number(2.0));
    });
    let a = aux();

    let result = crate::commands::data::sort_range_off_sheet(
        &state, &a.file, &a.files, &a.pivots, &a.pane, &a.filters, 1, sort_params(),
    )
    .expect("sort succeeds");
    assert!(result.success);
    assert_eq!(result.sorted_count, 3);

    assert_eq!(value_at(&state, 1, 0, 0), Some(CellValue::Number(1.0)));
    assert_eq!(value_at(&state, 1, 1, 0), Some(CellValue::Number(2.0)));
    assert_eq!(value_at(&state, 1, 2, 0), Some(CellValue::Number(3.0)));
    mirror_untouched(&state);

    let restores = undo_restores(&state);
    let (_, data) = restores
        .iter()
        .find(|(k, _)| k == "script_grid_cells")
        .expect("cell snapshot");
    let snapshot: crate::undo_commands::ScriptGridCellsSnapshot =
        serde_json::from_slice(data).unwrap();
    assert_eq!(snapshot.sheet_index, 1);
    assert!(
        snapshot
            .cells
            .iter()
            .any(|(r, _, cell)| *r == 0
                && cell.as_ref().map(|c| c.value.clone()) == Some(CellValue::Number(3.0))),
        "snapshot carries the PRE-sort order"
    );
}

#[test]
fn off_sheet_sort_is_blocked_by_target_protection() {
    let state = two_sheet_state(|g| {
        g.set_cell(0, 0, Cell::new_number(3.0));
        g.set_cell(1, 0, Cell::new_number(1.0));
    });
    protect_sheet(&state, 1);
    let a = aux();

    let err = crate::commands::data::sort_range_off_sheet(
        &state, &a.file, &a.files, &a.pivots, &a.pane, &a.filters, 1, sort_params(),
    )
    .expect_err("protected target (allowSort=false) must refuse");
    assert!(err.to_lowercase().contains("protect"), "{err}");
    assert_eq!(value_at(&state, 1, 0, 0), Some(CellValue::Number(3.0)), "order unchanged");
}

// ---------------------------------------------------------------------------
// replace_all / replace_single
// ---------------------------------------------------------------------------

#[test]
fn off_sheet_replace_all_rewrites_the_target_and_records_sheet_tagged_undo() {
    let state = two_sheet_state(|g| {
        g.set_cell(0, 0, Cell {
            value: CellValue::Text("alpha beta".to_string()),
            ast: None,
            style_index: 0,
            rich_text: None,
        });
    });
    let a = aux();

    let result = crate::commands::search::replace_all_off_sheet(
        &state, &a.files, &a.pivots, &a.pane, &a.filters,
        1,
        "beta".to_string(),
        "gamma".to_string(),
        false,
        false,
    )
    .expect("replace succeeds");
    assert_eq!(result.replacement_count, 1);
    assert_eq!(
        value_at(&state, 1, 0, 0),
        Some(CellValue::Text("alpha gamma".to_string()))
    );
    mirror_untouched(&state);

    let restores = undo_restores(&state);
    let (_, data) = restores
        .iter()
        .find(|(k, _)| k == "script_grid_cells")
        .expect("cell snapshot");
    let snapshot: crate::undo_commands::ScriptGridCellsSnapshot =
        serde_json::from_slice(data).unwrap();
    assert_eq!(snapshot.sheet_index, 1);
    assert_eq!(
        snapshot.cells[0].2.as_ref().map(|c| c.value.clone()),
        Some(CellValue::Text("alpha beta".to_string())),
        "undo restores the pre-replace text"
    );
}

#[test]
fn off_sheet_replace_all_is_blocked_by_target_protection() {
    let state = two_sheet_state(|g| {
        g.set_cell(0, 0, Cell {
            value: CellValue::Text("beta".to_string()),
            ast: None,
            style_index: 0,
            rich_text: None,
        });
    });
    protect_sheet(&state, 1);
    let a = aux();

    let err = crate::commands::search::replace_all_off_sheet(
        &state, &a.files, &a.pivots, &a.pane, &a.filters,
        1,
        "beta".to_string(),
        "gamma".to_string(),
        false,
        false,
    )
    .expect_err("protected target (cells locked by default) must refuse");
    assert!(err.to_lowercase().contains("protect"), "{err}");
    assert_eq!(value_at(&state, 1, 0, 0), Some(CellValue::Text("beta".to_string())));
}

#[test]
fn off_sheet_replace_single_rewrites_one_cell_on_the_target() {
    let state = two_sheet_state(|g| {
        g.set_cell(2, 3, Cell {
            value: CellValue::Text("old".to_string()),
            ast: None,
            style_index: 0,
            rich_text: None,
        });
    });
    let a = aux();

    let result = crate::commands::search::replace_single_off_sheet(
        &state, &a.files, &a.pivots, &a.pane, &a.filters,
        1, 2, 3,
        "old".to_string(),
        "new".to_string(),
        true,
    )
    .expect("replace succeeds");
    assert!(result.is_some(), "a replacement happened");
    assert_eq!(value_at(&state, 1, 2, 3), Some(CellValue::Text("new".to_string())));
    mirror_untouched(&state);

    let restores = undo_restores(&state);
    assert!(restores.iter().any(|(k, _)| k == "script_grid_cells"));
}
