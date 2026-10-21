//! FILENAME: app/src-tauri/src/commands/structure_target_tests.rs
//! PURPOSE: P3 S5 -- whole rows/columns and line formats take a CELL TARGET
//!          (a floating grid's lines).
//!
//! What is pinned here:
//!   1. TABLE semantics (spec 2.5): inserting rows inside the window shifts the
//!      backing content, grows the window, moves the size map and the hidden
//!      set with their lines, re-points a host formula (`=Float1!A3` ->
//!      `=Float1!A5`) -- and ONE Ctrl+Z restores all of it;
//!   2. the cap counts the backing sheet's USED range, not only the window;
//!   3. a floating grid keeps at least one row / column;
//!   4. deleting columns shrinks the window by the lines that were inside it;
//!   5. a failure after the shift takes the whole edit back (R10);
//!   6. the host's protection gates the edit, and every refusal is clean;
//!   7. Row Height / Column Width and Hide / Unhide write the OBJECT's maps,
//!      never the backing sheet's, and Lock Objects refuses a hide.
//!
//! A CHILD module of `commands::data` (for the shared `Workbook` harness),
//! like `cell_target_content_tests`.

use super::cross_sheet_recalc_tests::Workbook;
use crate::api_types::{CellTargetRef, FloatingRange, FloatingRangePatch};
use crate::cell_target::{
    edit_lines_on_target, set_line_sizes_on_target, set_lines_hidden_on_target, FAIL_WINDOW_PATCH_FOR_TEST,
};
use crate::floating_range::PatchGate;
use crate::protection::{SheetProtection, SheetProtectionOptions};
use engine::{Cell, CellValue};

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/// A floating range named `Float1` on the ACTIVE sheet, window `rows` x
/// `cols`. Returns (target, id, backing index).
fn float1(wb: &Workbook, rows: u32, cols: u32) -> (CellTargetRef, identity::EntityId, usize) {
    let info = crate::floating_range::create_floating_range_inner(
        &wb.state,
        &wb.file,
        Some("Float1".to_string()),
        100.0,
        50.0,
    )
    .expect("create a floating range");
    crate::floating_range::update_floating_range_inner(
        &wb.state,
        &wb.file,
        info.range.id,
        FloatingRangePatch { row_count: Some(rows), col_count: Some(cols), ..Default::default() },
        PatchGate::ObjectEdit,
    )
    .expect("size the window");
    (CellTargetRef::FloatingRange { id: info.range.id }, info.range.id, info.backing_sheet_index)
}

fn type_in(wb: &Workbook, id: identity::EntityId, row: u32, col: u32, value: &str) {
    crate::floating_range::update_floating_range_cell_inner(
        &wb.state,
        &wb.file,
        &wb.files,
        &wb.pivots,
        &wb.pane,
        &wb.filters,
        id,
        row,
        col,
        value.to_string(),
        None,
    )
    .unwrap_or_else(|e| panic!("type into ({row},{col}): {e}"));
}

fn row_of(wb: &Workbook, id: identity::EntityId) -> FloatingRange {
    wb.state.floating_ranges.read().unwrap().iter().find(|fr| fr.id == id).cloned().expect("the row")
}

fn backing_value(wb: &Workbook, sheet: usize, row: u32, col: u32) -> CellValue {
    wb.state.grids.read().unwrap()[sheet].get_cell(row, col).map(|c| c.value.clone()).unwrap_or(CellValue::Empty)
}

fn host_formula(wb: &Workbook, row: u32, col: u32) -> Option<String> {
    wb.state.grid.read().unwrap().get_cell(row, col).and_then(|c| c.formula_string())
}

fn host_value(wb: &Workbook, row: u32, col: u32) -> CellValue {
    wb.state.grid.read().unwrap().get_cell(row, col).map(|c| c.value.clone()).unwrap_or(CellValue::Empty)
}

fn depth(wb: &Workbook) -> usize {
    wb.state.undo_stack.lock().unwrap().undo_depth()
}

fn undo_once(wb: &Workbook) {
    let transaction = wb.state.undo_stack.lock().unwrap().pop_undo().expect("an undo step");
    crate::undo_commands::apply_changes(
        &wb.state, &wb.file, &wb.files, &wb.pivots, &wb.slicer, &wb.filters, &wb.pane, &wb.timelines, transaction, true,
    );
}

/// Insert (`insert`) or delete `count` rows (`rows`) or columns at `at`.
fn edit(wb: &Workbook, t: &CellTargetRef, rows: bool, insert: bool, at: u32, count: u32) -> Result<Vec<crate::api_types::CellData>, String> {
    edit_lines_on_target(
        &wb.state,
        &wb.file,
        &wb.pivots,
        &wb.files,
        &wb.pane,
        &wb.filters,
        &wb.slicer,
        &wb.timelines,
        t,
        rows,
        insert,
        at,
        count,
    )
}

fn protect_host(wb: &Workbook, options: SheetProtectionOptions) {
    wb.state.sheet_protection.write(&crate::document_effect::test_seed_effect()).unwrap().insert(
        0,
        SheetProtection {
            protected: true,
            password_hash: None,
            password_salt: None,
            options,
            allow_edit_ranges: Vec::new(),
        },
    );
}

/// Run `refused`, which must fail, and prove it left the document clean and
/// the undo stack untouched. Returns the sentence.
fn assert_clean_refusal<T: std::fmt::Debug>(wb: &Workbook, what: &str, refused: impl FnOnce() -> Result<T, String>) -> String {
    crate::document_effect::mark_saved(&wb.file);
    let before = depth(wb);
    let err = match refused() {
        Ok(v) => panic!("{what}: must be refused, got Ok({v:?})"),
        Err(e) => e,
    };
    assert!(!wb.file.is_dirty(), "{what}: a refusal must leave the document clean");
    assert_eq!(depth(wb), before, "{what}: a refusal records no undo step");
    err
}

// ---------------------------------------------------------------------------
// 1. Table semantics, one undo step
// ---------------------------------------------------------------------------

#[test]
fn inserting_rows_inside_the_window_shifts_content_grows_the_window_and_undoes_as_one_step() {
    let wb = Workbook::new(1);
    let (t, id, backing) = float1(&wb, 4, 3);
    type_in(&wb, id, 0, 0, "head");
    type_in(&wb, id, 2, 0, "7");
    wb.set(0, 4, "=Float1!A3"); // Sheet1!E1 reads the grid's A3
    assert_eq!(host_value(&wb, 0, 4), CellValue::Number(7.0), "precondition: the host formula reads the grid");
    set_line_sizes_on_target(&wb.state, &wb.file, &t, true, &[(2, 2)], 30.0).expect("a row height on the grid");
    set_lines_hidden_on_target(&wb.state, &wb.file, &t, true, &[3], true).expect("hide grid row 4");

    let before = depth(&wb);
    let cells = edit(&wb, &t, true, true, 1, 2).expect("insert 2 rows at row 2 of the grid");
    assert!(cells.is_empty(), "the active sheet's cells did not change");
    assert_eq!(depth(&wb), before + 1, "ONE undo step");
    assert_eq!(
        wb.state.undo_stack.lock().unwrap().undo_description(),
        Some("Insert floating grid row(s)"),
        "named for the act"
    );

    let after = row_of(&wb, id);
    assert_eq!(after.row_count, 6, "the window grew by the inserted rows");
    assert_eq!(after.col_count, 3, "the columns are untouched");
    assert_eq!(after.row_heights.get(&4), Some(&30.0), "the row-height map moved with its row");
    assert_eq!(after.row_heights.get(&2), None);
    assert_eq!(after.hidden_rows, vec![5], "the hidden set moved with its row");
    assert_eq!(backing_value(&wb, backing, 0, 0), CellValue::Text("head".into()), "above the insert: unmoved");
    assert_eq!(backing_value(&wb, backing, 2, 0), CellValue::Empty, "the old A3 slid down");
    assert_eq!(backing_value(&wb, backing, 4, 0), CellValue::Number(7.0), "A3's content is now at A5");
    assert_eq!(host_formula(&wb, 0, 4).as_deref(), Some("Float1!A5"), "the host formula was re-pointed");
    assert_eq!(host_value(&wb, 0, 4), CellValue::Number(7.0), "and still reads the same value");
    assert_eq!(host_value(&wb, 2, 0), CellValue::Empty, "the HOST's own cells never moved");

    undo_once(&wb);
    let back = row_of(&wb, id);
    assert_eq!(back.row_count, 4, "one Ctrl+Z restores the window");
    assert_eq!(back.row_heights.get(&2), Some(&30.0), "and the size map");
    assert_eq!(back.row_heights.len(), 1);
    assert_eq!(back.hidden_rows, vec![3], "and the hidden set");
    assert_eq!(backing_value(&wb, backing, 2, 0), CellValue::Number(7.0), "and the content");
    assert_eq!(backing_value(&wb, backing, 4, 0), CellValue::Empty);
    assert_eq!(host_formula(&wb, 0, 4).as_deref(), Some("Float1!A3"), "and the host formula");
}

#[test]
fn inserting_below_the_window_shifts_content_but_leaves_the_frame() {
    let wb = Workbook::new(1);
    let (t, id, backing) = float1(&wb, 2, 2);
    // Content below the window widens the write extent to row 4.
    wb.state.grids.write(&crate::document_effect::test_seed_effect()).unwrap()[backing]
        .set_cell(3, 0, Cell::new_number(5.0));
    edit(&wb, &t, true, true, 3, 1).expect("insert at row 4, inside the extent, below the window");
    assert_eq!(row_of(&wb, id).row_count, 2, "an insert past the window does not grow it");
    assert_eq!(backing_value(&wb, backing, 4, 0), CellValue::Number(5.0), "the content shifted");
}

// ---------------------------------------------------------------------------
// 2. The cap counts the used range
// ---------------------------------------------------------------------------

#[test]
fn inserting_past_the_cap_refuses_clean_both_by_window_and_by_used_range() {
    let wb = Workbook::new(1);
    let (t, id, _) = float1(&wb, 999, 2);
    let err = assert_clean_refusal(&wb, "999-row window + 2", || edit(&wb, &t, true, true, 0, 2));
    assert!(err.contains("at most 1000 rows"), "got: {err}");
    assert_eq!(row_of(&wb, id).row_count, 999);
    // Positive control: exactly up to the cap is allowed.
    edit(&wb, &t, true, true, 0, 1).expect("999 + 1 = 1000 fits");
    assert_eq!(row_of(&wb, id).row_count, 1000);

    // A 4-row window whose backing sheet holds content at row 999: the shift
    // would push it past the cap, where no extent reaches.
    let wb = Workbook::new(1);
    let (t, id, backing) = float1(&wb, 4, 2);
    wb.state.grids.write(&crate::document_effect::test_seed_effect()).unwrap()[backing]
        .set_cell(998, 0, Cell::new_number(1.0));
    let err = assert_clean_refusal(&wb, "used range at row 999 + 2", || edit(&wb, &t, true, true, 0, 2));
    assert!(err.contains("at most 1000 rows"), "got: {err}");
    assert_eq!(row_of(&wb, id).row_count, 4);
    assert_eq!(backing_value(&wb, backing, 998, 0), CellValue::Number(1.0), "nothing moved");
}

// ---------------------------------------------------------------------------
// 3 + 4. Delete
// ---------------------------------------------------------------------------

#[test]
fn deleting_every_window_row_refuses_clean() {
    let wb = Workbook::new(1);
    let (t, id, _) = float1(&wb, 4, 2);
    let err = assert_clean_refusal(&wb, "delete all 4 rows", || edit(&wb, &t, true, false, 0, 4));
    assert!(err.contains("keeps at least one row"), "got: {err}");
    assert_eq!(row_of(&wb, id).row_count, 4);
    // Positive control: three of the four go.
    edit(&wb, &t, true, false, 0, 3).expect("delete 3 of 4 rows");
    assert_eq!(row_of(&wb, id).row_count, 1);
}

#[test]
fn deleting_a_column_shrinks_the_window_and_moves_the_widths() {
    let wb = Workbook::new(1);
    let (t, id, backing) = float1(&wb, 3, 4);
    type_in(&wb, id, 0, 2, "c");
    type_in(&wb, id, 0, 3, "d");
    set_line_sizes_on_target(&wb.state, &wb.file, &t, false, &[(3, 3)], 120.0).unwrap();
    set_line_sizes_on_target(&wb.state, &wb.file, &t, false, &[(1, 1)], 90.0).unwrap();
    set_lines_hidden_on_target(&wb.state, &wb.file, &t, false, &[1, 3], true).unwrap();

    let before = depth(&wb);
    edit(&wb, &t, false, false, 1, 1).expect("delete column B of the grid");
    assert_eq!(depth(&wb), before + 1, "ONE undo step");
    let after = row_of(&wb, id);
    assert_eq!(after.col_count, 3, "the window lost the deleted column");
    assert_eq!(after.col_widths.get(&2), Some(&120.0), "D's width moved to C");
    assert_eq!(after.col_widths.get(&1), None, "B's width went with B");
    assert_eq!(after.col_widths.len(), 1);
    assert_eq!(after.hidden_cols, vec![2], "B's hide went with B; D's moved to C");
    assert_eq!(backing_value(&wb, backing, 0, 1), CellValue::Text("c".into()));
    assert_eq!(backing_value(&wb, backing, 0, 2), CellValue::Text("d".into()));

    undo_once(&wb);
    let back = row_of(&wb, id);
    assert_eq!(back.col_count, 4);
    assert_eq!(back.hidden_cols, vec![1, 3]);
    assert_eq!(backing_value(&wb, backing, 0, 3), CellValue::Text("d".into()));
}

#[test]
fn a_delete_outside_the_extent_refuses_naming_the_line() {
    let wb = Workbook::new(1);
    let (t, _, _) = float1(&wb, 3, 2);
    let err = assert_clean_refusal(&wb, "delete rows 3..5", || edit(&wb, &t, true, false, 2, 3));
    assert!(err.contains("Row 4 is outside floating grid 'Float1'"), "got: {err}");
    let err = assert_clean_refusal(&wb, "insert at column E", || edit(&wb, &t, false, true, 4, 1));
    assert!(err.contains("Column E is outside floating grid 'Float1'"), "got: {err}");
}

// ---------------------------------------------------------------------------
// 5. All or nothing
// ---------------------------------------------------------------------------

#[test]
fn a_window_patch_failure_after_the_shift_takes_the_whole_edit_back() {
    let wb = Workbook::new(1);
    let (t, id, backing) = float1(&wb, 4, 2);
    type_in(&wb, id, 2, 0, "7");
    wb.set(0, 4, "=Float1!A3");
    let before = depth(&wb);

    FAIL_WINDOW_PATCH_FOR_TEST.with(|f| f.set(true));
    let err = edit(&wb, &t, true, true, 1, 2).expect_err("the injected patch failure surfaces");
    assert!(err.contains("unavailable"), "got: {err}");
    assert!(!FAIL_WINDOW_PATCH_FOR_TEST.with(|f| f.get()), "the injection was consumed by the patch step");

    assert_eq!(depth(&wb), before, "no half step survives on the undo stack");
    assert_eq!(row_of(&wb, id).row_count, 4, "the window never changed");
    assert_eq!(backing_value(&wb, backing, 2, 0), CellValue::Number(7.0), "the shift was taken back");
    assert_eq!(backing_value(&wb, backing, 4, 0), CellValue::Empty);
    assert_eq!(host_formula(&wb, 0, 4).as_deref(), Some("Float1!A3"), "the host formula was put back");
    assert_ne!(
        wb.state.undo_stack.lock().unwrap().undo_description(),
        Some("Insert floating grid row(s)"),
        "the cancelled step is not on the stack"
    );
    // The same edit without the injection succeeds: the rollback left a
    // workbook the edit can still run on.
    edit(&wb, &t, true, true, 1, 2).expect("the edit runs after a rollback");
    assert_eq!(row_of(&wb, id).row_count, 6);
    assert_eq!(host_formula(&wb, 0, 4).as_deref(), Some("Float1!A5"));
}

// ---------------------------------------------------------------------------
// 6. Host protection
// ---------------------------------------------------------------------------

#[test]
fn a_protected_host_gates_inserting_and_deleting_grid_rows() {
    let wb = Workbook::new(1);
    let (t, id, _) = float1(&wb, 4, 2);
    protect_host(&wb, SheetProtectionOptions { allow_edit_objects: true, ..Default::default() });
    let err = assert_clean_refusal(&wb, "insert on a protected host", || edit(&wb, &t, true, true, 1, 1));
    assert!(err.contains("insert floating grid rows"), "got: {err}");
    let err = assert_clean_refusal(&wb, "delete on a protected host", || edit(&wb, &t, true, false, 1, 1));
    assert!(err.contains("delete floating grid rows"), "got: {err}");

    // The host allows inserting rows: the insert goes through.
    protect_host(
        &wb,
        SheetProtectionOptions { allow_edit_objects: true, allow_insert_rows: true, ..Default::default() },
    );
    edit(&wb, &t, true, true, 1, 1).expect("the host allows Insert Rows");
    assert_eq!(row_of(&wb, id).row_count, 5);
}

// ---------------------------------------------------------------------------
// 7. Line sizes and hidden lines on the object
// ---------------------------------------------------------------------------

#[test]
fn row_height_on_a_target_writes_the_object_map_and_never_the_backing_sheet() {
    let wb = Workbook::new(1);
    let (t, id, backing) = float1(&wb, 4, 3);
    let before = depth(&wb);
    set_line_sizes_on_target(&wb.state, &wb.file, &t, true, &[(1, 2)], 33.0).expect("Row Height on grid rows 2-3");
    assert_eq!(depth(&wb), before + 1, "one undo step");
    assert_eq!(wb.state.undo_stack.lock().unwrap().undo_description(), Some("Row height"));
    let row = row_of(&wb, id);
    assert_eq!(row.row_heights.get(&1), Some(&33.0));
    assert_eq!(row.row_heights.get(&2), Some(&33.0));
    assert!(
        wb.state.all_row_heights.read().unwrap().get(backing).map(|m| m.is_empty()).unwrap_or(true),
        "the backing sheet's row heights are untouched"
    );
    assert!(wb.state.row_heights.read().unwrap().is_empty(), "and so are the active sheet's");

    // Clamped to the object's limits; <= 0 removes the override.
    set_line_sizes_on_target(&wb.state, &wb.file, &t, false, &[(0, 0)], 5000.0).unwrap();
    assert_eq!(row_of(&wb, id).col_widths.get(&0), Some(&1000.0), "clamped to 1000 px");
    set_line_sizes_on_target(&wb.state, &wb.file, &t, true, &[(1, 1)], 0.0).unwrap();
    assert_eq!(row_of(&wb, id).row_heights.get(&1), None, "a zero size removes the override");

    // The same size again changes nothing: clean, no step.
    crate::document_effect::mark_saved(&wb.file);
    let before = depth(&wb);
    set_line_sizes_on_target(&wb.state, &wb.file, &t, true, &[(2, 2)], 33.0).unwrap();
    assert!(!wb.file.is_dirty(), "a no-op resize leaves the document clean");
    assert_eq!(depth(&wb), before);

    let err = assert_clean_refusal(&wb, "a row outside the grid", || {
        set_line_sizes_on_target(&wb.state, &wb.file, &t, true, &[(2, 9)], 20.0)
    });
    assert!(err.contains("outside floating grid"), "got: {err}");
}

#[test]
fn hiding_on_a_target_writes_the_object_set_and_lock_objects_refuses_it() {
    let wb = Workbook::new(1);
    let canvas = crate::sheets::add_sheet_inner(&wb.state, &wb.file, None, ::persistence::SheetKind::new_canvas())
        .expect("add a canvas")
        .active_index;
    let (t, id, backing) = float1(&wb, 4, 3);

    let set = set_lines_hidden_on_target(&wb.state, &wb.file, &t, true, &[2, 0], true).expect("hide rows 1 and 3");
    assert_eq!(set, vec![0, 2], "the command answers the object's set, ascending");
    assert_eq!(row_of(&wb, id).hidden_rows, vec![0, 2]);
    assert!(
        wb.state.all_user_hidden_rows.read().unwrap().get(backing).map(|s| s.is_empty()).unwrap_or(true),
        "the backing sheet's user-hidden rows are untouched"
    );
    let set = set_lines_hidden_on_target(&wb.state, &wb.file, &t, true, &[0], false).expect("unhide row 1");
    assert_eq!(set, vec![2]);
    assert_eq!(wb.state.undo_stack.lock().unwrap().undo_description(), Some("Unhide floating grid rows"));

    crate::sheets::set_canvas_layout_inner(
        &wb.state,
        &wb.file,
        Some(canvas),
        &crate::api_types::CanvasLayoutPatch { objects_locked: Some(true), ..Default::default() },
    )
    .expect("Lock Objects");
    let err = assert_clean_refusal(&wb, "hide under Lock Objects", || {
        set_lines_hidden_on_target(&wb.state, &wb.file, &t, false, &[1], true)
    });
    assert!(err.to_lowercase().contains("lock"), "the page lock refused it, got: {err}");
    assert!(row_of(&wb, id).hidden_cols.is_empty());
    let err = assert_clean_refusal(&wb, "insert under Lock Objects", || edit(&wb, &t, true, true, 0, 1));
    assert!(err.to_lowercase().contains("lock"), "a window-growing insert is refused too, got: {err}");
}

// ---------------------------------------------------------------------------
// 8. The re-pointed formula keeps the workbook's spelling
// ---------------------------------------------------------------------------

/// The off-sheet structural rewrite re-parsed its output, and the lexer
/// uppercases bare sheet qualifiers: `=Sheet2!A3` came back as `=SHEET2!A5`
/// (and every host formula reading a floating grid as `=FLOAT1!A5`). The
/// value was right; the formula bar was not.
#[test]
fn an_off_sheet_row_insert_keeps_the_sheet_name_spelling_and_the_edge() {
    let wb = Workbook::new(2);
    wb.set(0, 4, "=Sheet2!A3");
    crate::commands::structure::off_sheet_structural_edit(
        &wb.state,
        &wb.file,
        &wb.pivots,
        &wb.files,
        &wb.pane,
        &wb.filters,
        &wb.slicer,
        &wb.timelines,
        1,
        calp::writeback::StructuralEdit::RowInsert { at: 1, count: 2 },
    )
    .expect("insert rows on the non-active Sheet2");
    assert_eq!(host_formula(&wb, 0, 4).as_deref(), Some("Sheet2!A5"), "the official spelling survives the shift");

    // And through a floating grid, the edge still recalculates the host.
    let wb = Workbook::new(1);
    let (t, id, _) = float1(&wb, 4, 3);
    type_in(&wb, id, 2, 0, "7");
    wb.set(0, 4, "=Float1!A3");
    edit(&wb, &t, true, true, 1, 2).unwrap();
    type_in(&wb, id, 4, 0, "9");
    assert_eq!(host_formula(&wb, 0, 4).as_deref(), Some("Float1!A5"));
    assert_eq!(host_value(&wb, 0, 4), CellValue::Number(9.0), "the re-pointed host formula follows the moved cell");
}
