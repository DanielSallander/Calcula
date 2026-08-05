//! FILENAME: app/src-tauri/src/commands/user_hidden_tests.rs
//! PURPOSE: The user-hide authority — the rows/columns a person hid by hand.
//!
//! Hiding a row used to be frontend-only session state: it never reached the
//! backend, never marked the document dirty, was not undoable, did not shift
//! when rows were inserted, and was gone after a save/reload (and after a sheet
//! switch, which wiped the reducer's whole dimensions object). These tests pin
//! each of those, plus the composition rule that keeps the three hidden
//! authorities from overwriting one another:
//!
//!     effectiveHidden(row) = userHidden OR filterHidden OR outlineHidden

use crate::commands::dimensions::{
    ensure_user_hidden_len, load_active_user_hidden, set_cols_hidden_inner, set_rows_hidden_inner,
    set_user_hidden_for_sheet, stash_active_user_hidden, user_hidden_cols_for_sheet,
    user_hidden_rows_for_sheet,
};
use crate::commands::nav::{collect_hidden_cols_for_sheet, collect_hidden_rows_for_sheet};
use crate::persistence::FileState;
use crate::AppState;
use std::collections::HashSet;

/// Two-sheet workbook, sheet 0 active, with the per-sheet user-hidden vectors
/// sized for both sheets.
fn two_sheet_state() -> AppState {
    let state = crate::create_app_state();
    state.grids.lock().unwrap().push(engine::Grid::new());
    state.sheet_names.lock().unwrap().push("Sheet2".to_string());
    state
        .sheet_ids
        .lock()
        .unwrap()
        .push(identity::SheetId::from_bytes(identity::generate_uuid_v7()));
    ensure_user_hidden_len(&state, 2);
    state
}

fn set_of(v: &[u32]) -> HashSet<u32> {
    v.iter().copied().collect()
}

// ============================================================================
// 1. The command surface
// ============================================================================

#[test]
fn hiding_rows_reaches_the_backend_and_marks_the_document_dirty() {
    let state = crate::create_app_state();
    let file_state = FileState::default();
    assert!(!*file_state.is_modified.lock().unwrap());

    let result = set_rows_hidden_inner(&state, &file_state, &[4, 5, 6], true).unwrap();

    assert_eq!(result, vec![4, 5, 6], "the command answers with the new set");
    assert_eq!(user_hidden_rows_for_sheet(&state, 0), set_of(&[4, 5, 6]));
    assert!(
        *file_state.is_modified.lock().unwrap(),
        "hiding a row is a document mutation, not a view preference — it MUST dirty the file"
    );
}

#[test]
fn hiding_columns_reaches_the_backend_and_marks_the_document_dirty() {
    let state = crate::create_app_state();
    let file_state = FileState::default();

    let result = set_cols_hidden_inner(&state, &file_state, &[2], true).unwrap();

    assert_eq!(result, vec![2]);
    assert!(*file_state.is_modified.lock().unwrap());
}

#[test]
fn unhide_removes_only_the_named_indices() {
    let state = crate::create_app_state();
    let file_state = FileState::default();
    set_rows_hidden_inner(&state, &file_state, &[1, 2, 3], true).unwrap();

    let after = set_rows_hidden_inner(&state, &file_state, &[2], false).unwrap();

    assert_eq!(after, vec![1, 3]);
}

#[test]
fn a_hide_is_one_undo_step_however_many_rows_it_covers() {
    let state = crate::create_app_state();
    let file_state = FileState::default();
    let rows: Vec<u32> = (0..500).collect();

    set_rows_hidden_inner(&state, &file_state, &rows, true).unwrap();

    let stack = state.undo_stack.lock().unwrap();
    assert!(stack.can_undo(), "hide/unhide must be undoable (it is in Excel)");
    assert_eq!(
        stack.undo_depth(),
        1,
        "500 rows hidden in one gesture is ONE undo step, not 500"
    );
}

// ============================================================================
// 2. Undo / redo
// ============================================================================

#[test]
fn undo_restores_the_previous_hidden_set_and_redo_re_applies_it() {
    let state = crate::create_app_state();
    let file_state = FileState::default();
    set_rows_hidden_inner(&state, &file_state, &[7], true).unwrap();
    assert_eq!(user_hidden_rows_for_sheet(&state, 0), set_of(&[7]));

    // Undo: replay the recorded snapshot the way apply_changes does.
    let transaction = state.undo_stack.lock().unwrap().pop_undo().unwrap();
    let mut inverse = engine::undo::Transaction::new("inverse");
    for change in &transaction.changes {
        if let engine::undo::CellChange::CustomRestore { kind, data } = change {
            assert_eq!(kind, crate::undo_commands::USER_HIDDEN_RESTORE_KIND);
            crate::undo_commands::apply_user_hidden_restore(&state, data, &mut inverse);
        }
    }
    assert!(
        user_hidden_rows_for_sheet(&state, 0).is_empty(),
        "undo of a hide must unhide the row"
    );

    // Redo: replay the inverse the restore captured.
    let mut inverse2 = engine::undo::Transaction::new("inverse2");
    for change in &inverse.changes {
        if let engine::undo::CellChange::CustomRestore { data, .. } = change {
            crate::undo_commands::apply_user_hidden_restore(&state, data, &mut inverse2);
        }
    }
    assert_eq!(
        user_hidden_rows_for_sheet(&state, 0),
        set_of(&[7]),
        "redo must put the hide back"
    );
}

// ============================================================================
// 3. Per-sheet isolation
// ============================================================================

#[test]
fn hiding_a_row_on_sheet1_leaves_sheet2_alone_and_survives_the_round_trip_back() {
    let state = two_sheet_state();
    let file_state = FileState::default();
    set_rows_hidden_inner(&state, &file_state, &[5], true).unwrap();

    // Switch to Sheet2 (what sheets::set_active_sheet does).
    stash_active_user_hidden(&state, 0);
    *state.active_sheet.lock().unwrap() = 1;
    load_active_user_hidden(&state, 1);

    assert!(
        user_hidden_rows_for_sheet(&state, 1).is_empty(),
        "Sheet1's hide must not bleed onto Sheet2"
    );

    // ...and back to Sheet1.
    stash_active_user_hidden(&state, 1);
    *state.active_sheet.lock().unwrap() = 0;
    load_active_user_hidden(&state, 0);

    assert_eq!(
        user_hidden_rows_for_sheet(&state, 0),
        set_of(&[5]),
        "the hide must still be there after a sheet round-trip — it used to have a \
         lifetime of 'until you click another sheet tab'"
    );
}

#[test]
fn a_background_sheets_hidden_set_is_readable_without_switching_to_it() {
    let state = two_sheet_state();
    set_user_hidden_for_sheet(&state, 1, set_of(&[2, 3]), set_of(&[8]));

    assert_eq!(user_hidden_rows_for_sheet(&state, 1), set_of(&[2, 3]));
    assert_eq!(user_hidden_cols_for_sheet(&state, 1), set_of(&[8]));
    assert!(user_hidden_rows_for_sheet(&state, 0).is_empty());
}

#[test]
fn deleting_a_sheet_drops_its_slot_and_renumbers_the_rest() {
    let state = two_sheet_state();
    crate::commands::dimensions::ensure_user_hidden_len(&state, 3);
    set_user_hidden_for_sheet(&state, 1, set_of(&[1]), HashSet::new());
    set_user_hidden_for_sheet(&state, 2, set_of(&[2]), HashSet::new());

    crate::commands::dimensions::remove_user_hidden_sheet(&state, 1);

    assert_eq!(
        user_hidden_rows_for_sheet(&state, 1),
        set_of(&[2]),
        "sheet 2's set must move down to index 1 with the sheet"
    );
}

#[test]
fn reordering_sheets_carries_the_hidden_sets_with_them() {
    let state = two_sheet_state();
    crate::commands::dimensions::ensure_user_hidden_len(&state, 3);
    *state.active_sheet.lock().unwrap() = 2; // keep the mirror out of the way
    set_user_hidden_for_sheet(&state, 0, set_of(&[10]), HashSet::new());
    set_user_hidden_for_sheet(&state, 1, set_of(&[11]), HashSet::new());

    // Move sheet 0 to position 2.
    crate::commands::dimensions::rotate_user_hidden_sheet(&state, 0, 2, 3);

    // Read the per-sheet slots directly (park the active index outside the
    // range so no read is answered from the active-sheet mirror).
    *state.active_sheet.lock().unwrap() = 9;
    assert_eq!(user_hidden_rows_for_sheet(&state, 0), set_of(&[11]));
    assert_eq!(user_hidden_rows_for_sheet(&state, 2), set_of(&[10]));
}

#[test]
fn duplicating_a_sheet_copies_its_hidden_sets() {
    let state = two_sheet_state();
    *state.active_sheet.lock().unwrap() = 1;
    set_user_hidden_for_sheet(&state, 0, set_of(&[4]), set_of(&[6]));

    crate::commands::dimensions::duplicate_user_hidden_sheet(&state, 0, 1);

    *state.active_sheet.lock().unwrap() = 9; // no mirror involvement
    assert_eq!(user_hidden_rows_for_sheet(&state, 1), set_of(&[4]));
    assert_eq!(user_hidden_cols_for_sheet(&state, 1), set_of(&[6]));
}

// ============================================================================
// 4. The composition rule — three independent authorities, union only
// ============================================================================

#[test]
fn effective_hidden_is_the_union_of_user_filter_and_outline() {
    let state = crate::create_app_state();
    let file_state = FileState::default();

    // User hides row 1.
    set_rows_hidden_inner(&state, &file_state, &[1], true).unwrap();
    // An advanced filter hides row 2.
    state
        .advanced_filter_hidden_rows
        .lock()
        .unwrap()
        .insert(0, vec![2]);
    // A collapsed outline group hides rows 4..=5.
    {
        let mut outlines = state.outlines.lock().unwrap();
        let outline = outlines.entry(0).or_default();
        outline.row_groups.push(crate::grouping::RowGroup {
            start_row: 4,
            end_row: 6,
            level: 1,
            collapsed: true,
        });
    }

    let hidden = collect_hidden_rows_for_sheet(&state, 0);
    assert!(hidden.contains(&1), "user hide missing from the effective set");
    assert!(hidden.contains(&2), "filter hide missing from the effective set");
    // A collapsed group hides its detail rows; the summary row (end_row by
    // default) stays visible so the +/- button is still clickable.
    assert!(hidden.contains(&4) && hidden.contains(&5), "outline hide missing");
    assert!(!hidden.contains(&3));
}

#[test]
fn clearing_a_filter_does_not_clear_a_user_hide() {
    let state = crate::create_app_state();
    let file_state = FileState::default();
    set_rows_hidden_inner(&state, &file_state, &[3], true).unwrap();
    state
        .advanced_filter_hidden_rows
        .lock()
        .unwrap()
        .insert(0, vec![3, 7]);
    assert!(collect_hidden_rows_for_sheet(&state, 0).contains(&7));

    // The filter is cleared — it only ever owned its OWN set.
    state.advanced_filter_hidden_rows.lock().unwrap().remove(&0);

    let hidden = collect_hidden_rows_for_sheet(&state, 0);
    assert!(
        hidden.contains(&3),
        "row 3 was hidden by hand as well as by the filter; clearing the filter must leave it hidden"
    );
    assert!(!hidden.contains(&7));
}

#[test]
fn unhiding_by_hand_does_not_resurrect_a_filter_hidden_row() {
    let state = crate::create_app_state();
    let file_state = FileState::default();
    // Row 3 is hidden by BOTH a filter and by hand.
    set_rows_hidden_inner(&state, &file_state, &[3], true).unwrap();
    state
        .advanced_filter_hidden_rows
        .lock()
        .unwrap()
        .insert(0, vec![3]);

    // The user selects rows 0..10 and picks Unhide.
    let rows: Vec<u32> = (0..10).collect();
    set_rows_hidden_inner(&state, &file_state, &rows, false).unwrap();

    assert!(
        collect_hidden_rows_for_sheet(&state, 0).contains(&3),
        "unhiding by hand must not override the filter — the filter still says row 3 is out"
    );
}

#[test]
fn expanding_an_outline_group_does_not_clear_a_user_hide() {
    let state = crate::create_app_state();
    let file_state = FileState::default();
    set_rows_hidden_inner(&state, &file_state, &[4], true).unwrap();
    {
        let mut outlines = state.outlines.lock().unwrap();
        let outline = outlines.entry(0).or_default();
        outline.row_groups.push(crate::grouping::RowGroup {
            start_row: 4,
            end_row: 6,
            level: 1,
            collapsed: true,
        });
    }
    assert!(collect_hidden_rows_for_sheet(&state, 0).contains(&5));

    // Expand the group.
    {
        let mut outlines = state.outlines.lock().unwrap();
        outlines.get_mut(&0).unwrap().row_groups[0].collapsed = false;
    }

    let hidden = collect_hidden_rows_for_sheet(&state, 0);
    assert!(
        hidden.contains(&4),
        "row 4 was hidden by hand too; expanding the group must leave it hidden"
    );
    assert!(!hidden.contains(&5), "the group's other rows come back visible");
}

#[test]
fn hidden_columns_compose_the_same_way() {
    let state = crate::create_app_state();
    let file_state = FileState::default();
    set_cols_hidden_inner(&state, &file_state, &[2], true).unwrap();
    {
        let mut outlines = state.outlines.lock().unwrap();
        let outline = outlines.entry(0).or_default();
        outline.column_groups.push(crate::grouping::ColumnGroup {
            start_col: 5,
            end_col: 7,
            level: 1,
            collapsed: true,
        });
    }

    let hidden = collect_hidden_cols_for_sheet(&state, 0);
    assert!(hidden.contains(&2), "user-hidden column missing");
    // Detail columns hide; the summary column (end_col) keeps its button.
    assert!(hidden.contains(&5) && hidden.contains(&6), "outline-hidden columns missing");
}

// ============================================================================
// 5. Coordinate shift
// ============================================================================

#[test]
fn inserting_a_row_above_a_hidden_row_shifts_the_hide_down() {
    let state = crate::create_app_state();
    let file_state = FileState::default();
    set_rows_hidden_inner(&state, &file_state, &[10], true).unwrap();

    let mut undo_stack = engine::UndoStack::new();
    crate::commands::structure::shift_misc_coordinate_stores(
        &state,
        &mut undo_stack,
        0,
        calp::writeback::StructuralEdit::RowInsert { at: 5, count: 1 },
    );

    let hidden = user_hidden_rows_for_sheet(&state, 0);
    assert!(hidden.contains(&11), "the hidden row moved down to 11");
    assert!(!hidden.contains(&10), "row 10 now holds different data and must be visible");
}

#[test]
fn deleting_the_hidden_row_removes_the_hide_and_pulls_later_ones_up() {
    let state = crate::create_app_state();
    let file_state = FileState::default();
    set_rows_hidden_inner(&state, &file_state, &[3, 10], true).unwrap();

    let mut undo_stack = engine::UndoStack::new();
    crate::commands::structure::shift_misc_coordinate_stores(
        &state,
        &mut undo_stack,
        0,
        calp::writeback::StructuralEdit::RowDelete { at: 3, count: 1 },
    );

    let hidden = user_hidden_rows_for_sheet(&state, 0);
    assert!(!hidden.contains(&3), "the deleted row's hide goes with it");
    assert_eq!(hidden, set_of(&[9]), "row 10 shifted up to 9");
}

#[test]
fn inserting_a_column_shifts_hidden_columns_and_leaves_rows_alone() {
    let state = crate::create_app_state();
    let file_state = FileState::default();
    set_rows_hidden_inner(&state, &file_state, &[4], true).unwrap();
    set_cols_hidden_inner(&state, &file_state, &[7], true).unwrap();

    let mut undo_stack = engine::UndoStack::new();
    crate::commands::structure::shift_misc_coordinate_stores(
        &state,
        &mut undo_stack,
        0,
        calp::writeback::StructuralEdit::ColInsert { at: 2, count: 3 },
    );

    assert_eq!(user_hidden_cols_for_sheet(&state, 0), set_of(&[10]));
    assert_eq!(
        user_hidden_rows_for_sheet(&state, 0),
        set_of(&[4]),
        "a column edit must not touch the hidden ROWS"
    );
}

#[test]
fn the_shift_is_undoable() {
    let state = crate::create_app_state();
    let file_state = FileState::default();
    set_rows_hidden_inner(&state, &file_state, &[10], true).unwrap();

    let mut undo_stack = engine::UndoStack::new();
    undo_stack.begin_transaction("Insert row");
    crate::commands::structure::shift_misc_coordinate_stores(
        &state,
        &mut undo_stack,
        0,
        calp::writeback::StructuralEdit::RowInsert { at: 5, count: 1 },
    );
    undo_stack.commit_transaction();

    let transaction = undo_stack.pop_undo().expect("the shift must record an undo entry");
    let mut inverse = engine::undo::Transaction::new("inverse");
    for change in &transaction.changes {
        if let engine::undo::CellChange::CustomRestore { kind, data } = change {
            if kind == crate::undo_commands::USER_HIDDEN_RESTORE_KIND {
                crate::undo_commands::apply_user_hidden_restore(&state, data, &mut inverse);
            }
        }
    }
    assert_eq!(
        user_hidden_rows_for_sheet(&state, 0),
        set_of(&[10]),
        "undoing the insert must put the hide back on row 10"
    );
}

// ============================================================================
// 6. Save / reload round-trip (.cala)
// ============================================================================

#[test]
fn user_hidden_survives_a_cala_save_and_reload_per_sheet() {
    let state = two_sheet_state();
    let file_state = FileState::default();
    // Sheet1 (active): hand-hidden row 5 and column 2.
    set_rows_hidden_inner(&state, &file_state, &[5], true).unwrap();
    set_cols_hidden_inner(&state, &file_state, &[2], true).unwrap();
    // Sheet2 (background): hand-hidden row 8.
    set_user_hidden_for_sheet(&state, 1, set_of(&[8]), HashSet::new());

    // ---- Save: collect state onto the Workbook, then through the archive. ----
    let mut workbook = persistence::Workbook::new();
    workbook.sheets.clear();
    for i in 0..2 {
        let mut sheet = persistence::Sheet::new(format!("Sheet{}", i + 1));
        crate::persistence::apply_user_hidden_to_sheet(&state, &mut sheet, i);
        workbook.sheets.push(sheet);
    }
    assert_eq!(workbook.sheets[0].user_hidden_rows, set_of(&[5]));
    assert_eq!(workbook.sheets[1].user_hidden_rows, set_of(&[8]));

    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("hidden.cala");
    calcula_format::save_calcula(&workbook, &path).unwrap();
    let reloaded = calcula_format::load_calcula(&path).unwrap();

    // ---- Load: re-hydrate AppState from the reloaded workbook. ----
    let fresh = two_sheet_state();
    crate::persistence::restore_user_hidden_from_workbook(&fresh, &reloaded, 0).unwrap();

    assert_eq!(
        user_hidden_rows_for_sheet(&fresh, 0),
        set_of(&[5]),
        "the active sheet's hand-hidden row must come back hidden"
    );
    assert_eq!(user_hidden_cols_for_sheet(&fresh, 0), set_of(&[2]));
    assert_eq!(
        user_hidden_rows_for_sheet(&fresh, 1),
        set_of(&[8]),
        "a background sheet's hides must come back too, on the right sheet"
    );
}

// ============================================================================
// The script-facing READ: get_hidden_rows_info / get_hidden_cols_info
// ============================================================================
// A script asking "what did I hide?" and a script asking "is this row visible?"
// are different questions. The read answers BOTH, under distinct names, for ANY
// sheet -- the reach `getSpecialCells("visible")` needed and did not have while
// user hide lived in frontend state.

#[test]
fn hidden_info_separates_the_by_hand_set_from_the_effective_union() {
    let state = two_sheet_state();
    let file_state = FileState::default();
    // Hidden by hand: row 5. Hidden by an advanced filter: rows 11, 12.
    set_rows_hidden_inner(&state, &file_state, &[5], true).unwrap();
    state
        .advanced_filter_hidden_rows
        .lock()
        .unwrap()
        .insert(0, vec![11, 12]);

    let info = crate::commands::dimensions::hidden_rows_info_inner(&state, None).unwrap();
    assert_eq!(info.user, vec![5], "only the hand-hidden row is 'user'");
    assert_eq!(
        info.effective,
        vec![5, 11, 12],
        "'effective' is the union of every authority, ascending"
    );
    assert!(
        info.user.iter().all(|r| info.effective.contains(r)),
        "the by-hand set is always a subset of the effective set"
    );
}

#[test]
fn hidden_info_reads_a_background_sheet_without_an_activate_dance() {
    let state = two_sheet_state();
    let file_state = FileState::default();
    // Sheet1 (active) hides row 5; Sheet2 (background) hides row 8 and column 3.
    set_rows_hidden_inner(&state, &file_state, &[5], true).unwrap();
    set_user_hidden_for_sheet(&state, 1, set_of(&[8]), set_of(&[3]));

    let rows = crate::commands::dimensions::hidden_rows_info_inner(&state, Some(1)).unwrap();
    assert_eq!(rows.user, vec![8]);
    assert_eq!(rows.effective, vec![8]);
    let cols = crate::commands::dimensions::hidden_cols_info_inner(&state, Some(1)).unwrap();
    assert_eq!(cols.user, vec![3]);

    // The active sheet's own answer is unaffected by the background read.
    let active = crate::commands::dimensions::hidden_rows_info_inner(&state, Some(0)).unwrap();
    assert_eq!(active.user, vec![5]);
}

#[test]
fn hidden_info_refuses_a_sheet_that_does_not_exist() {
    let state = two_sheet_state();
    // "Nothing is hidden" would be a silent wrong answer for a missing sheet.
    let err = crate::commands::dimensions::hidden_rows_info_inner(&state, Some(9)).unwrap_err();
    assert!(err.contains("getHiddenRows"), "the method must name itself: {}", err);
    assert!(err.contains('9'), "the refusal must name the bad index: {}", err);
    let err = crate::commands::dimensions::hidden_cols_info_inner(&state, Some(2)).unwrap_err();
    assert!(err.contains("getHiddenColumns"), "{}", err);
}
