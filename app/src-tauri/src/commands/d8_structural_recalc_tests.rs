//! FILENAME: app/src-tauri/src/commands/d8_structural_recalc_tests.rs
//! PURPOSE: D8 / §2s — a structural edit must RECALCULATE.
//!
//! A CHILD module of `data` (declared with `#[path]` there) so it reuses the
//! `Workbook` harness `cross_sheet_recalc_tests` owns rather than copying one:
//! a copied harness drifts, and a drifted harness is how a recalculation defect
//! hides — which is the whole subject of this file.
//!
//! THE DEFECT THESE PIN. `insert_rows` / `insert_columns` / `delete_rows` /
//! `delete_columns` re-pointed every reference and carried every cached value
//! along with its cell, then stopped. That is correct and free for almost every
//! formula, which is exactly why it survived: each formula still means the same
//! cells and each value moved with its owner. It is not quite true. A range
//! endpoint SHIFTS, and a cell's own ADDRESS moves, so a formula whose result
//! depends on the SHAPE or POSITION of what it reads kept a number its own
//! rewritten AST no longer produces:
//!
//! * `=ROWS(A1:A5)` became `=ROWS(A1:A6)` and went on displaying 5;
//! * `=ROW()` slid from row 5 to row 6 and went on displaying 5 — and this one
//!   matters twice over, because the register's recommended fix (seed the cells
//!   whose AST was rewritten) would never have caught it. `=ROW()` has no
//!   arguments. Nothing of its own is ever rewritten. **The register's
//!   completeness claim was false, and the measurement is what said so.**
//! * `=SUM(A:A)` dropped a value with nothing moved and nothing rewritten, when
//!   the last populated row of column A was deleted;
//! * `=ROWS(DATA)` and `Sheet2!B1 = ROWS(Sheet1!A1:A5)` went stale on a
//!   definition and a cross-sheet reference the edit itself had re-pointed.
//!
//! THE ORACLE, and why it is not a list of expected numbers. `assert_settled`
//! re-evaluates every sheet from its stored formulas and fails if ANY value
//! moves — i.e. it asserts that the document agrees with what LOADING it would
//! produce. A hand-written expectation can only confirm the cases somebody
//! already thought of, and the question D8 asks is precisely *which* formulas go
//! stale. The named tests below then pin the individual numbers, so a failure
//! says what broke rather than only that something did.

use super::cross_sheet_recalc_tests::{body_of, Workbook};
use super::*;
use crate::commands::structure::{
    delete_columns_impl, delete_rows_impl, insert_columns_impl, insert_rows_impl,
    off_sheet_structural_edit,
};
use engine::CellValue;

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

fn insert_rows_at(wb: &Workbook, row: u32, count: u32) {
    insert_rows_impl(
        &wb.state, &wb.file, &wb.pivots, &wb.files, &wb.pane, &wb.filters, &wb.slicer,
        &wb.timeline, row, count, None,
    )
    .expect("insert_rows");
}

fn delete_rows_at(wb: &Workbook, row: u32, count: u32) {
    delete_rows_impl(
        &wb.state, &wb.file, &wb.pivots, &wb.files, &wb.pane, &wb.filters, &wb.slicer,
        &wb.timeline, row, count, None,
    )
    .expect("delete_rows");
}

fn insert_cols_at(wb: &Workbook, col: u32, count: u32) {
    insert_columns_impl(
        &wb.state, &wb.file, &wb.pivots, &wb.files, &wb.pane, &wb.filters, &wb.slicer,
        &wb.timeline, col, count, None,
    )
    .expect("insert_columns");
}

fn delete_cols_at(wb: &Workbook, col: u32, count: u32) {
    delete_columns_impl(
        &wb.state, &wb.file, &wb.pivots, &wb.files, &wb.pane, &wb.filters, &wb.slicer,
        &wb.timeline, col, count, None,
    )
    .expect("delete_columns");
}

/// Undo through the REAL restore path. `undo`/`redo` themselves take a Tauri
/// `AppHandle`; `apply_changes` is the shared body both of them run and takes
/// plain references, so this is the same code the user's Ctrl+Z reaches.
fn undo(wb: &Workbook) {
    let transaction = wb
        .state
        .undo_stack
        .lock()
        .unwrap()
        .pop_undo()
        .expect("nothing to undo");
    crate::undo_commands::apply_changes(
        &wb.state, &wb.file, &wb.files, &wb.pivots, &wb.slicer, &wb.filters, &wb.pane, transaction,
        true,
    );
}

fn redo(wb: &Workbook) {
    let transaction = wb
        .state
        .undo_stack
        .lock()
        .unwrap()
        .pop_redo()
        .expect("nothing to redo");
    crate::undo_commands::apply_changes(
        &wb.state, &wb.file, &wb.files, &wb.pivots, &wb.slicer, &wb.filters, &wb.pane, transaction,
        false,
    );
}

fn snapshot(wb: &Workbook) -> Vec<((usize, u32, u32), Option<String>, CellValue)> {
    let grids = wb.state.grids.read().unwrap();
    let mut out = Vec::new();
    for (idx, grid) in grids.iter().enumerate() {
        for (&(r, c), cell) in grid.cells.iter() {
            out.push(((idx, r, c), cell.formula_string(), cell.value.clone()));
        }
    }
    out.sort_by(|a, b| a.0.cmp(&b.0));
    out
}

/// THE ORACLE: the workbook must already hold the values a fresh load would
/// produce. Any cell whose value MOVES when every sheet is re-evaluated from its
/// stored formulas was stale a moment ago.
#[track_caller]
fn assert_settled(wb: &Workbook, what: &str) {
    let before = snapshot(wb);
    let sheet_count = wb.state.grids.read().unwrap().len();
    for idx in 0..sheet_count {
        crate::calculation::recalculate_sheet_values(
            &wb.state,
            &wb.files,
            &wb.pivots,
            idx,
            Some((&wb.pane, &wb.filters)),
        );
    }
    let after = snapshot(wb);
    let mut stale = Vec::new();
    for (key, formula, was) in &before {
        if let Some((_, _, now)) = after.iter().find(|(k, _, _)| k == key) {
            if was != now {
                stale.push(format!(
                    "S{} r{} c{}  {}  showed {:?}, a fresh evaluation gives {:?}",
                    key.0,
                    key.1,
                    key.2,
                    formula.clone().unwrap_or_default(),
                    was,
                    now
                ));
            }
        }
    }
    assert!(
        stale.is_empty(),
        "after {} the workbook disagrees with what loading it would produce — \
         these cells are STALE:\n  {}",
        what,
        stale.join("\n  ")
    );
}

fn num(wb: &Workbook, sheet: usize, row: u32, col: u32) -> f64 {
    wb.number(sheet, row, col)
}

fn text(wb: &Workbook, sheet: usize, row: u32, col: u32) -> String {
    match wb.value(sheet, row, col) {
        CellValue::Text(t) => t,
        other => panic!("S{} ({},{}) is {:?}, expected text", sheet, row, col, other),
    }
}

/// Five literals in A1:A5 and one of every position- or shape-sensitive formula
/// the function set offers, in column C.
fn shape_sensitive_sheet(wb: &Workbook) {
    for r in 0..5u32 {
        wb.set(r, 0, &format!("{}", (r + 1) * 10));
    }
    wb.set(0, 2, "=ROWS(A1:A5)");
    wb.set(1, 2, "=COLUMNS(A1:C1)");
    wb.set(2, 2, "=COUNTA(A1:A5)");
    wb.set(3, 2, "=SUBTOTAL(9;A1:A5)");
    wb.set(4, 2, "=AGGREGATE(9;0;A1:A5)");
    wb.set(5, 2, "=SUM(A1:A5)");
    wb.set(6, 2, "=ROW()");
    wb.set(7, 2, "=COLUMN()");
    wb.set(8, 2, "=ADDRESS(ROW();COLUMN())");
    wb.set(9, 2, "=ROW(A5)");
    wb.set(10, 2, "=COLUMN(C1)");
    wb.set(11, 2, "=CELL(\"address\";A5)");
    wb.set(12, 4, "=SUM(A:A)");
    wb.set(13, 4, "=COUNTA(A:A)");
}

// ---------------------------------------------------------------------------
// 1. The SHAPE of a rewritten reference
// ---------------------------------------------------------------------------

/// The register's own example, and the one the whole decision is named after.
#[test]
fn a_row_insert_inside_a_range_updates_rows() {
    let wb = Workbook::new(1);
    for r in 0..5u32 {
        wb.set(r, 0, &format!("{}", (r + 1) * 10));
    }
    wb.set(0, 2, "=ROWS(A1:A5)");
    assert_eq!(num(&wb, 0, 0, 2), 5.0, "precondition");

    insert_rows_at(&wb, 2, 1);

    assert_eq!(
        num(&wb, 0, 0, 2),
        6.0,
        "the stored formula is now =ROWS(A1:A6); displaying 5 is the §2s defect"
    );
    assert_settled(&wb, "a row insert inside a =ROWS range");
}

#[test]
fn a_row_delete_inside_a_range_updates_rows_and_the_aggregates() {
    let wb = Workbook::new(1);
    shape_sensitive_sheet(&wb);
    assert_eq!(num(&wb, 0, 0, 2), 5.0, "precondition");
    assert_eq!(num(&wb, 0, 5, 2), 150.0, "precondition");

    // Row index 2 holds A3 = 30 and the =COUNTA cell.
    delete_rows_at(&wb, 2, 1);

    assert_eq!(num(&wb, 0, 0, 2), 4.0, "=ROWS(A1:A4)");
    // The three aggregates each moved up one row.
    assert_eq!(num(&wb, 0, 2, 2), 120.0, "=SUBTOTAL(9;A1:A4)");
    assert_eq!(num(&wb, 0, 3, 2), 120.0, "=AGGREGATE(9;0;A1:A4)");
    assert_eq!(num(&wb, 0, 4, 2), 120.0, "=SUM(A1:A4)");
    assert_settled(&wb, "a row delete inside the ranges");
}

#[test]
fn a_column_insert_inside_a_range_updates_columns() {
    let wb = Workbook::new(1);
    wb.set(1, 2, "=COLUMNS(A1:C1)");
    assert_eq!(num(&wb, 0, 1, 2), 3.0, "precondition");

    insert_cols_at(&wb, 1, 1);

    assert_eq!(
        num(&wb, 0, 1, 3),
        4.0,
        "the stored formula is now =COLUMNS(A1:D1)"
    );
    assert_settled(&wb, "a column insert inside a =COLUMNS range");
}

#[test]
fn a_column_delete_inside_a_range_updates_columns() {
    let wb = Workbook::new(1);
    wb.set(1, 2, "=COLUMNS(A1:C1)");
    wb.set(0, 1, "1");
    assert_eq!(num(&wb, 0, 1, 2), 3.0, "precondition");

    delete_cols_at(&wb, 1, 1);

    assert_eq!(
        num(&wb, 0, 1, 1),
        2.0,
        "the stored formula is now =COLUMNS(A1:B1)"
    );
    assert_settled(&wb, "a column delete inside a =COLUMNS range");
}

// ---------------------------------------------------------------------------
// 2. The POSITION of the formula's own cell — the case that refutes option 1
// ---------------------------------------------------------------------------

/// `=ROW()` and `=COLUMN()` take NO arguments, so no structural edit ever
/// rewrites them. Seeding "the cells whose AST was rewritten" — the register's
/// recommendation, on the stated grounds that "a shape-sensitive formula only
/// goes stale if its own reference was rewritten" — would leave every one of
/// these four cases failing.
#[test]
fn a_moved_formula_with_no_arguments_follows_its_cell() {
    for (label, edit) in [
        ("row insert", 0usize),
        ("row delete", 1),
        ("column insert", 2),
        ("column delete", 3),
    ] {
        let wb = Workbook::new(1);
        wb.set(4, 4, "=ROW()");
        wb.set(5, 4, "=COLUMN()");
        wb.set(6, 4, "=ADDRESS(ROW();COLUMN())");
        assert_eq!(num(&wb, 0, 4, 4), 5.0, "precondition ({})", label);
        assert_eq!(num(&wb, 0, 5, 4), 5.0, "precondition ({})", label);
        assert_eq!(text(&wb, 0, 6, 4), "$E$7", "precondition ({})", label);

        let (row_of_row_fn, col_of_row_fn) = match edit {
            0 => {
                insert_rows_at(&wb, 0, 1);
                (5u32, 4u32)
            }
            1 => {
                delete_rows_at(&wb, 0, 1);
                (3, 4)
            }
            2 => {
                insert_cols_at(&wb, 0, 1);
                (4, 5)
            }
            _ => {
                delete_cols_at(&wb, 0, 1);
                (4, 3)
            }
        };

        assert_eq!(
            num(&wb, 0, row_of_row_fn, col_of_row_fn),
            row_of_row_fn as f64 + 1.0,
            "=ROW() after a {} — it has no reference to rewrite, so only \
             seeding MOVED cells reaches it",
            label
        );
        assert_eq!(
            num(&wb, 0, row_of_row_fn + 1, col_of_row_fn),
            col_of_row_fn as f64 + 1.0,
            "=COLUMN() after a {}",
            label
        );
        assert_settled(&wb, label);
    }
}

// ---------------------------------------------------------------------------
// 3. Whole-column / whole-row references — nothing moved, nothing rewritten
// ---------------------------------------------------------------------------

/// `=SUM(A:A)` has no endpoint for the shift to move and need not sit anywhere
/// near the edit. Deleting the LAST populated row of column A moves nothing and
/// rewrites nothing, and the total still has to drop — so the seed set has to
/// carry the position the deleted value VACATED.
#[test]
fn a_whole_column_reader_follows_a_deleted_row() {
    let wb = Workbook::new(1);
    wb.set(4, 0, "10");
    wb.set(0, 2, "=SUM(A:A)");
    wb.set(1, 2, "=COUNTA(A:A)");
    assert_eq!(num(&wb, 0, 0, 2), 10.0, "precondition");
    assert_eq!(num(&wb, 0, 1, 2), 1.0, "precondition");

    delete_rows_at(&wb, 4, 1);

    assert_eq!(
        num(&wb, 0, 0, 2),
        0.0,
        "=SUM(A:A) after its only value was deleted"
    );
    assert_eq!(
        num(&wb, 0, 1, 2),
        0.0,
        "=COUNTA(A:A) after its only value was deleted"
    );
    assert_settled(&wb, "a row delete under a whole-column reader");
}

#[test]
fn a_whole_row_reader_follows_a_deleted_column() {
    let wb = Workbook::new(1);
    wb.set(0, 4, "10");
    wb.set(3, 0, "=SUM(1:1)");
    assert_eq!(num(&wb, 0, 3, 0), 10.0, "precondition");

    delete_cols_at(&wb, 4, 1);

    assert_eq!(
        num(&wb, 0, 3, 0),
        0.0,
        "=SUM(1:1) after its only value was deleted"
    );
    assert_settled(&wb, "a column delete under a whole-row reader");
}

// ---------------------------------------------------------------------------
// 4. Defined names — an edge no coordinate map holds
// ---------------------------------------------------------------------------

/// `shift_named_ranges` re-points `DATA` from `A1:A5` to `A1:A6`. `=ROWS(DATA)`
/// neither moved nor was rewritten, and a defined name is resolved during
/// EVALUATION rather than being an edge in `dependents` — so the only seed
/// vocabulary that reaches this reader is the NAME.
#[test]
fn a_defined_name_reader_follows_the_shifted_definition() {
    let wb = Workbook::new(1);
    for r in 0..5u32 {
        wb.set(r, 0, &format!("{}", (r + 1) * 10));
    }
    let created = crate::named_ranges::create_named_range_impl(
        &wb.state,
        &wb.file,
        "DATA".to_string(),
        None,
        "=Sheet1!$A$1:$A$5".to_string(),
        None,
        None,
    );
    assert!(created.success, "named range: {:?}", created.error);
    crate::undo_commands::rebuild_all_dependencies(&wb.state);
    wb.set(0, 3, "=ROWS(DATA)");
    assert_eq!(num(&wb, 0, 0, 3), 5.0, "precondition");

    insert_rows_at(&wb, 2, 1);

    assert_eq!(num(&wb, 0, 0, 3), 6.0, "DATA is now $A$1:$A$6");
    assert_settled(&wb, "a row insert under a defined-name reader");
}

// ---------------------------------------------------------------------------
// 5. Cross-sheet — a rewritten AST on a sheet the active cascade cannot reach
// ---------------------------------------------------------------------------

/// `shift_cross_sheet_formulas` re-points Sheet2's formula when Sheet1 is
/// edited. The active-sheet cascade speaks `(row, col)` on Sheet1 only, so this
/// reader is reached through `recalc_after_off_sheet_write` — the same entry
/// point the OFF-sheet structural edit already uses.
#[test]
fn a_cross_sheet_reader_follows_an_edit_on_the_active_sheet() {
    for (label, insert) in [("insert", true), ("delete", false)] {
        let wb = Workbook::new(2);
        for r in 0..5u32 {
            wb.set(r, 0, &format!("{}", (r + 1) * 10));
        }
        wb.switch_to(1);
        wb.set(0, 0, "=ROWS(Sheet1!A1:A5)");
        wb.switch_to(0);
        assert_eq!(num(&wb, 1, 0, 0), 5.0, "precondition ({})", label);

        if insert {
            insert_rows_at(&wb, 2, 1);
            assert_eq!(num(&wb, 1, 0, 0), 6.0, "Sheet2 reads =ROWS(Sheet1!A1:A6)");
        } else {
            delete_rows_at(&wb, 2, 1);
            assert_eq!(num(&wb, 1, 0, 0), 4.0, "Sheet2 reads =ROWS(Sheet1!A1:A4)");
        }
        assert_settled(&wb, label);
    }
}

/// The OFF-SHEET structural edit (an explicit non-active `sheet_index`) has the
/// same obligation, and reaches it through `recalc_after_off_sheet_write`.
#[test]
fn an_off_sheet_structural_edit_recalculates_the_sheet_it_edited() {
    let wb = Workbook::new(2);
    wb.switch_to(1);
    for r in 0..5u32 {
        wb.set(r, 0, &format!("{}", (r + 1) * 10));
    }
    wb.set(0, 2, "=ROWS(A1:A5)");
    // BELOW the insertion point, so it moves.
    wb.set(3, 2, "=ROW()");
    wb.switch_to(0);
    assert_eq!(num(&wb, 1, 0, 2), 5.0, "precondition");
    assert_eq!(num(&wb, 1, 3, 2), 4.0, "precondition");

    off_sheet_structural_edit(
        &wb.state,
        &wb.file,
        &wb.pivots,
        &wb.files,
        &wb.pane,
        &wb.filters,
        &wb.slicer,
        &wb.timeline,
        1,
        calp::writeback::StructuralEdit::RowInsert { at: 2, count: 1 },
    )
    .expect("off-sheet insert");

    assert_eq!(num(&wb, 1, 0, 2), 6.0, "=ROWS(A1:A6) on the edited sheet");
    assert_eq!(num(&wb, 1, 4, 2), 5.0, "=ROW() moved from row 4 to row 5");
    assert_settled(&wb, "an off-sheet row insert");
}

// ---------------------------------------------------------------------------
// 6. UNDO and REDO — the inverse operation has the same obligation
// ---------------------------------------------------------------------------

/// Undo of a structural edit restores the pre-edit grid from a snapshot, and
/// redo restores the post-edit one — so BOTH carry cached values, and both are
/// only as correct as the values that were in the grid when their snapshot was
/// taken. Fixing the forward path is therefore what makes REDO right, not
/// incidental to it: before this change redo replayed a snapshot captured from a
/// workbook that was already stale.
#[test]
fn undo_and_redo_of_a_row_insert_carry_settled_values() {
    let wb = Workbook::new(1);
    shape_sensitive_sheet(&wb);
    assert_eq!(num(&wb, 0, 0, 2), 5.0);
    assert_eq!(num(&wb, 0, 6, 2), 7.0, "=ROW() at row index 6");

    insert_rows_at(&wb, 2, 1);
    assert_eq!(num(&wb, 0, 0, 2), 6.0);
    assert_eq!(num(&wb, 0, 7, 2), 8.0, "=ROW() moved down one");
    assert_settled(&wb, "the row insert");

    undo(&wb);
    assert_eq!(num(&wb, 0, 0, 2), 5.0, "=ROWS is back to A1:A5");
    assert_eq!(num(&wb, 0, 6, 2), 7.0, "=ROW() is back at row index 6");
    assert_settled(&wb, "undo of the row insert");

    redo(&wb);
    assert_eq!(num(&wb, 0, 0, 2), 6.0, "=ROWS is A1:A6 again");
    assert_eq!(num(&wb, 0, 7, 2), 8.0, "=ROW() is back down one");
    assert_settled(&wb, "redo of the row insert");
}

#[test]
fn undo_and_redo_of_a_row_delete_carry_settled_values() {
    let wb = Workbook::new(1);
    shape_sensitive_sheet(&wb);

    delete_rows_at(&wb, 2, 1);
    assert_eq!(num(&wb, 0, 0, 2), 4.0);
    assert_settled(&wb, "the row delete");

    undo(&wb);
    assert_eq!(num(&wb, 0, 0, 2), 5.0);
    assert_eq!(num(&wb, 0, 5, 2), 150.0, "=SUM(A1:A5) is whole again");
    assert_settled(&wb, "undo of the row delete");

    redo(&wb);
    assert_eq!(num(&wb, 0, 0, 2), 4.0);
    assert_settled(&wb, "redo of the row delete");
}

#[test]
fn undo_and_redo_of_a_column_edit_carry_settled_values() {
    let wb = Workbook::new(1);
    wb.set(1, 2, "=COLUMNS(A1:C1)");
    wb.set(2, 2, "=COLUMN()");

    insert_cols_at(&wb, 1, 1);
    assert_eq!(num(&wb, 0, 1, 3), 4.0);
    assert_eq!(num(&wb, 0, 2, 3), 4.0, "=COLUMN() moved right one");
    assert_settled(&wb, "the column insert");

    undo(&wb);
    assert_eq!(num(&wb, 0, 1, 2), 3.0);
    assert_eq!(num(&wb, 0, 2, 2), 3.0);
    assert_settled(&wb, "undo of the column insert");

    redo(&wb);
    assert_eq!(num(&wb, 0, 1, 3), 4.0);
    assert_eq!(num(&wb, 0, 2, 3), 4.0);
    assert_settled(&wb, "redo of the column insert");
}

/// Undo of a CROSS-SHEET edit: the rewrite on Sheet2 joined the same
/// transaction, so reverting it has to revert Sheet2's VALUE too.
#[test]
fn undo_of_a_structural_edit_settles_the_other_sheets_too() {
    let wb = Workbook::new(2);
    for r in 0..5u32 {
        wb.set(r, 0, &format!("{}", (r + 1) * 10));
    }
    wb.switch_to(1);
    wb.set(0, 0, "=ROWS(Sheet1!A1:A5)");
    wb.switch_to(0);

    insert_rows_at(&wb, 2, 1);
    assert_eq!(num(&wb, 1, 0, 0), 6.0);

    undo(&wb);
    assert_eq!(
        num(&wb, 1, 0, 0),
        5.0,
        "Sheet2 reads =ROWS(Sheet1!A1:A5) again"
    );
    assert_settled(&wb, "undo of a cross-sheet structural edit");

    redo(&wb);
    assert_eq!(num(&wb, 1, 0, 0), 6.0);
    assert_settled(&wb, "redo of a cross-sheet structural edit");
}

// ---------------------------------------------------------------------------
// 7. The whole surface at once — the net the named tests sit inside
// ---------------------------------------------------------------------------

/// One of every position- and shape-sensitive formula, four edits, and the
/// ORACLE. Each of these four produced a non-empty stale list before the fix
/// (7, 11, 4 and 5 cells respectively), which is the measurement D8 was decided
/// on.
#[test]
fn no_structural_edit_leaves_anything_stale() {
    let wb = Workbook::new(1);
    shape_sensitive_sheet(&wb);
    insert_rows_at(&wb, 2, 1);
    assert_settled(&wb, "a row insert");

    let wb = Workbook::new(1);
    shape_sensitive_sheet(&wb);
    delete_rows_at(&wb, 2, 1);
    assert_settled(&wb, "a row delete");

    let wb = Workbook::new(1);
    shape_sensitive_sheet(&wb);
    insert_cols_at(&wb, 1, 1);
    assert_settled(&wb, "a column insert");

    let wb = Workbook::new(1);
    shape_sensitive_sheet(&wb);
    wb.set(0, 1, "1");
    delete_cols_at(&wb, 1, 1);
    assert_settled(&wb, "a column delete");
}

/// MANUAL CALCULATION still means manual. The user asked for stale values until
/// F9, and a structural edit is a value change like any other.
#[test]
fn manual_calculation_mode_still_defers_the_structural_recalculation() {
    let wb = Workbook::new(1);
    for r in 0..5u32 {
        wb.set(r, 0, &format!("{}", (r + 1) * 10));
    }
    wb.set(0, 2, "=ROWS(A1:A5)");
    *wb.state.calculation_mode.lock().unwrap() = "manual".to_string();

    insert_rows_at(&wb, 2, 1);

    assert_eq!(
        num(&wb, 0, 0, 2),
        5.0,
        "manual mode must not recalculate; F9 is what the user asked for"
    );
}

// ---------------------------------------------------------------------------
// 8. Wiring — the entry points are still the SHARED ones
// ---------------------------------------------------------------------------

/// The behavioural tests above prove the values are right TODAY. This proves
/// they are right through the ONE shared cascade rather than a fourth walk
/// somebody added here — the constraint D8 was given, and the thing a value
/// assertion cannot see.
#[test]
fn every_structural_edit_seeds_the_shared_cascade() {
    const STRUCTURE_RS: &str = include_str!("structure.rs");
    for name in [
        "insert_rows_impl",
        "insert_columns_impl",
        "delete_rows_impl",
        "delete_columns_impl",
    ] {
        let body = body_of(STRUCTURE_RS, name);
        assert!(
            body.contains("recalc_after_active_sheet_bulk_rewrite("),
            "`{}` re-points references and moves cached values and must then \
             seed the ONE shared cascade — see D8 / §2s",
            name
        );
        assert!(
            body.contains("recalc_structural_side_effects("),
            "`{}` must also run the two triggers the coordinate cascade cannot \
             express: a re-pointed cross-sheet formula and a re-pointed defined \
             name",
            name
        );
    }
    let off_sheet = body_of(STRUCTURE_RS, "off_sheet_structural_edit");
    assert!(
        off_sheet.contains("recalc_after_off_sheet_write("),
        "the off-sheet structural edit recalculates through the whole-sheet \
         entry point, not a copy of the seeded one"
    );
    assert!(
        off_sheet.contains("recalc_after_name_change("),
        "the off-sheet structural edit shifts named ranges too, and a name is \
         not an edge in any coordinate map"
    );
}
// ---------------------------------------------------------------------------
// STEP 2 of D8 — the cost, measured
// ---------------------------------------------------------------------------

/// A tall sheet with a realistic formula density, built the way LOADING builds
/// one — cells straight into the grid with parsed ASTs, then one dependency
/// rebuild and one whole-sheet evaluation. Driving 9 x `rows` edits through
/// `update_cell_impl` would spend all its time cascading the fixture into
/// existence rather than measuring the thing under test.
///
/// Layout, per data row (data starts at row 3, headers above it):
///   A..E  literals
///   F     `=A{r}+B{r}`          own-row reference: rewritten by a row insert
///   G     `=SUM(A{r}:E{r})`     own-row range
///   H     `=IF(G{r}>10;1;0)`    a second hop, so the cascade has depth
///   I     `=ROW()`              NO reference at all: moves, is never rewritten
/// and three whole-range aggregates at the top, which are rewritten but do NOT
/// move.
fn build_tall_sheet(wb: &Workbook, rows: u32) {
    const FIRST: u32 = 3;
    let effect = crate::document_effect::DocumentEffect::deliberately_clean(
        crate::document_effect::CleanReason::LoadingFromDisk,
    );
    {
        let mut grid = wb.state.grid.write(&effect).unwrap();
        let mut put = |r: u32, c: u32, text: &str| {
            let cell = if text.starts_with('=') {
                engine::Cell::new_formula(text.to_string())
            } else {
                engine::Cell::new_number(text.parse::<f64>().unwrap())
            };
            grid.set_cell(r, c, cell);
        };
        let last = FIRST + rows - 1;
        put(0, 9, &format!("=SUM(A{}:A{})", FIRST + 1, last + 1));
        put(1, 9, "=COUNTA(A:A)");
        put(2, 9, &format!("=ROWS(A{}:A{})", FIRST + 1, last + 1));
        for i in 0..rows {
            let r = FIRST + i;
            let a1 = r + 1;
            for c in 0..5u32 {
                put(r, c, &format!("{}", (i % 97) + 1));
            }
            put(r, 5, &format!("=A{}+B{}", a1, a1));
            put(r, 6, &format!("=SUM(A{}:E{})", a1, a1));
            put(r, 7, &format!("=IF(G{}>10;1;0)", a1));
            put(r, 8, "=ROW()");
        }
        grid.recalculate_bounds();
    }
    {
        let mut grids = wb.state.grids.write(&effect).unwrap();
        grids[0] = wb.state.grid.read().unwrap().clone();
    }
    crate::undo_commands::rebuild_all_dependencies(&wb.state);
    crate::calculation::recalculate_sheet_values(
        &wb.state,
        &wb.files,
        &wb.pivots,
        0,
        Some((&wb.pane, &wb.filters)),
    );
}

/// The four candidate seed sets, computed from the POST-edit grid so all four
/// are measured against identical state.
///
///   `opt1`      the register's option 1: only the cells whose AST was rewritten
///               (in this fixture, every moved formula EXCEPT column I, whose
///               `=ROW()` has nothing to rewrite, plus the three top aggregates)
///   `opt1_row`  option 1 plus every moved FORMULA cell — the completeness the
///               `=ROW()` measurement forces
///   `chosen`    `opt1_row` plus ONE seed per affected COLUMN (the fixture holds
///               `=COUNTA(A:A)`, so stripe coverage is live)
///   `all_moved` the register's option 2: every moved cell, literals included
fn candidate_seeds(
    wb: &Workbook,
    moved_from: u32,
) -> (
    Vec<(u32, u32)>,
    Vec<(u32, u32)>,
    Vec<(u32, u32)>,
    Vec<(u32, u32)>,
) {
    let grid = wb.state.grid.read().unwrap();
    let top: Vec<(u32, u32)> = vec![(0, 9), (1, 9), (2, 9)];
    let mut opt1 = top.clone();
    let mut opt1_row = top.clone();
    let mut chosen = top.clone();
    let mut all_moved = top.clone();
    let mut seen_cols: std::collections::HashSet<u32> = std::collections::HashSet::new();
    for (&(r, c), cell) in grid.cells.iter() {
        if r < moved_from {
            continue;
        }
        let has_formula = cell.formula_string().is_some();
        if has_formula && c != 8 {
            opt1.push((r, c));
        }
        if has_formula {
            opt1_row.push((r, c));
            chosen.push((r, c));
        }
        if seen_cols.insert(c) {
            chosen.push((r, c));
        }
        all_moved.push((r, c));
    }
    for v in [&mut opt1, &mut opt1_row, &mut chosen, &mut all_moved] {
        v.sort_unstable();
        v.dedup();
    }
    (opt1, opt1_row, chosen, all_moved)
}

fn time_seeded(wb: &Workbook, seeds: &[(u32, u32)]) -> f64 {
    let start = std::time::Instant::now();
    let mut out: Vec<CellData> = Vec::new();
    recalc_after_active_sheet_bulk_rewrite(
        &wb.state,
        &wb.files,
        &wb.pane,
        &wb.filters,
        seeds,
        &mut out,
    );
    start.elapsed().as_secs_f64() * 1000.0
}

fn time_whole_sheet(wb: &Workbook) -> f64 {
    let start = std::time::Instant::now();
    crate::calculation::recalculate_sheet_values(
        &wb.state,
        &wb.files,
        &wb.pivots,
        0,
        Some((&wb.pane, &wb.filters)),
    );
    start.elapsed().as_secs_f64() * 1000.0
}

/// D8's cost question, answered the way D1 and D3 answered theirs.
///
/// `#[ignore]`d: run with
/// `cargo test --lib d8_cost -- --ignored --nocapture --test-threads=1`.
/// DEBUG profile, so read the RATIOS, not the absolute milliseconds. Every
/// candidate is measured against the SAME settled post-edit state, so the
/// columns differ only by their seed set.
#[test]
#[ignore]
fn d8_cost_of_recalculating_a_structural_edit() {
    println!(
        "{:<8}{:>7}{:>11}{:>11}{:>10}{:>11}{:>10}{:>11}{:>11}{:>9}",
        "case", "rows", "cmd total", "no recalc", "opt1", "opt1+move", "CHOSEN", "opt2 all", "wholeSht", "seeds"
    );
    for rows in [2_000u32, 10_000u32] {
        // WORST CASE: insert at the top of the data, so every row moves and
        // every own-row reference is rewritten. It is also the COMMON case
        // ("insert a row at the top of my table"), which is why it is here.
        // TYPICAL CASE: insert 50 rows from the bottom.
        for (label, at) in [("worst", 3u32), ("typical", rows - 47)] {
            let wb = Workbook::new(1);
            build_tall_sheet(&wb, rows);

            let start = std::time::Instant::now();
            insert_rows_at(&wb, at, 1);
            let cmd_total = start.elapsed().as_secs_f64() * 1000.0;

            let (opt1, opt1_row, chosen, all_moved) = candidate_seeds(&wb, at + 1);
            let t_opt1 = time_seeded(&wb, &opt1);
            let t_opt1_row = time_seeded(&wb, &opt1_row);
            let t_chosen = time_seeded(&wb, &chosen);
            let t_all = time_seeded(&wb, &all_moved);
            let t_whole = time_whole_sheet(&wb);

            println!(
                "{:<8}{:>7}{:>9.2}ms{:>9.2}ms{:>8.2}ms{:>9.2}ms{:>8.2}ms{:>9.2}ms{:>9.2}ms{:>9}",
                label,
                rows,
                cmd_total,
                cmd_total - t_chosen,
                t_opt1,
                t_opt1_row,
                t_chosen,
                t_all,
                t_whole,
                chosen.len()
            );
        }
    }
}

// ---------------------------------------------------------------------------
// 8. WHAT THE CASCADE KNOWS ABOUT HIDDEN ROWS
//
// Found in the integration pass, by probing the NEIGHBOURS of a structural edit
// rather than by reading it. `recalc_after_active_sheet_bulk_rewrite` — the ONE
// shared entry point D3 and D8 both seed — installed no row-visibility pass, and
// `row_visibility.rs` is explicit that with no guard installed the aggregates
// "behave as if nothing is hidden". So every cell that cascade re-evaluated was
// computed against a workbook with nothing hidden.
//
// That is not a stale value, it is a WRONG one, written over a right one: hide a
// row, settle `=SUBTOTAL(109;A1:A5)` at its correct 130, insert a row anywhere,
// and the cascade re-derived it as 150 and stored that. Before D8 the structural
// edit recalculated nothing, so this cell kept the correct 130 — the D8 fix is
// what made the gesture reach the bug, which is exactly why the fix had to be
// probed rather than assumed complete.
//
// Every caller was affected (`sort_range`, `relocate_cell_references`, D3's
// eight); the four structural edits are merely the most frequent. The sibling
// `recalc_after_off_sheet_write` never had it — it delegates to
// `recalculate_sheet_values`, which installs the guard itself.
// ---------------------------------------------------------------------------

/// SUBTOTAL/AGGREGATE are the only functions whose answer depends on something
/// that is not a cell value, so they are the only way to observe this. 109 and
/// option 5 exclude user-hidden rows; 9 and option 0 count them, and are here as
/// the control — if BOTH move, the visibility index is not what broke.
#[test]
fn the_cascade_re_evaluates_a_hidden_row_aggregate_with_the_rows_still_hidden() {
    let wb = Workbook::new(1);
    for r in 0..5u32 {
        wb.set(r, 0, &format!("{}", (r + 1) * 10));
    }
    wb.set(0, 2, "=SUBTOTAL(109;A1:A5)");
    wb.set(1, 2, "=SUBTOTAL(9;A1:A5)");
    wb.set(2, 2, "=AGGREGATE(9;5;A1:A5)");
    wb.set(3, 2, "=AGGREGATE(9;0;A1:A5)");
    assert_eq!(num(&wb, 0, 0, 2), 150.0, "precondition: nothing hidden");

    // Hide the row holding 20, then settle exactly as the real
    // `set_rows_hidden` command does (its recalc half needs an AppHandle).
    crate::commands::dimensions::set_rows_hidden_inner(&wb.state, &wb.file, &[1], true)
        .expect("hide row");
    crate::calculation::recalculate_sheet_values(
        &wb.state,
        &wb.files,
        &wb.pivots,
        0,
        Some((&wb.pane, &wb.filters)),
    );
    assert_eq!(num(&wb, 0, 0, 2), 130.0, "SUBTOTAL(109) drops the hidden 20");
    assert_eq!(num(&wb, 0, 2, 2), 130.0, "AGGREGATE option 5 drops it too");
    assert_eq!(num(&wb, 0, 1, 2), 150.0, "SUBTOTAL(9) keeps it");

    // A structural edit BELOW the hidden row: nothing about visibility changes,
    // but the range endpoint shifts, so the cascade re-evaluates all four.
    insert_rows_at(&wb, 4, 1);

    assert_eq!(
        num(&wb, 0, 0, 2),
        130.0,
        "the cascade re-derived =SUBTOTAL(109;A1:A6) as if row 2 were visible          and overwrote the correct 130 with 150"
    );
    assert_eq!(num(&wb, 0, 2, 2), 130.0, "same for AGGREGATE option 5");
    assert_eq!(num(&wb, 0, 1, 2), 150.0, "the control must NOT move");
    assert_eq!(num(&wb, 0, 3, 2), 150.0, "the control must NOT move");
    assert_settled(&wb, "a structural edit with a row hidden");
}

/// The same for a DELETE, and for a hidden row that the edit itself moves: the
/// hidden-row set is shifted by the edit, so the snapshot has to be taken AFTER
/// the mutation, not before it.
#[test]
fn a_delete_above_a_hidden_row_leaves_the_aggregate_agreeing_with_a_reload() {
    let wb = Workbook::new(1);
    for r in 0..6u32 {
        wb.set(r, 0, &format!("{}", (r + 1) * 10));
    }
    wb.set(0, 2, "=SUBTOTAL(109;A1:A6)");

    crate::commands::dimensions::set_rows_hidden_inner(&wb.state, &wb.file, &[4], true)
        .expect("hide row");
    crate::calculation::recalculate_sheet_values(
        &wb.state,
        &wb.files,
        &wb.pivots,
        0,
        Some((&wb.pane, &wb.filters)),
    );
    assert_eq!(num(&wb, 0, 0, 2), 160.0, "210 total less the hidden 50");

    delete_rows_at(&wb, 0, 1);

    // The oracle is the point here, not the arithmetic: whatever the hidden set
    // shifted to, the stored value must be what a reload would produce.
    assert_settled(&wb, "a row delete above a hidden row");
}

// ---------------------------------------------------------------------------
// 7. BUG-0055 — the EDGES a grown range needs, not just its rewritten text
// ---------------------------------------------------------------------------

/// The D8 family, one edge over. D8 shipped re-pointing + re-evaluating; the
/// dependency-map maintenance for a range that GREW across the insert shifted
/// only the edges that already existed. The inserted cells were never inside
/// the old range, so no edge was shifted into place for them — and a write into
/// the inserted row recalculated NOTHING. `assert_settled` cannot catch this
/// class (it re-evaluates everything, edges or no edges); only an incremental
/// write through the real edit path can.
#[test]
fn a_write_into_an_inserted_row_recalculates_the_grown_range() {
    let wb = Workbook::new(1);
    wb.set(0, 0, "10");
    wb.set(1, 0, "20");
    wb.set(2, 0, "30");
    wb.set(3, 0, "=SUM(A1:A3)");
    assert_eq!(num(&wb, 0, 3, 0), 60.0, "precondition");

    insert_rows_at(&wb, 1, 1);
    // The formula moved to A5 and was re-pointed to =SUM(A1:A4).
    assert_eq!(num(&wb, 0, 4, 0), 60.0, "after the insert, before any write");

    // Write INTO the inserted row — the cell the old range never covered.
    wb.set(1, 0, "15");
    assert_eq!(
        num(&wb, 0, 4, 0),
        75.0,
        "BUG-0055: the inserted cell had no dependency edge, so =SUM(A1:A4) kept 60"
    );

    // Control from the filed repro: a cell the range covered BEFORE the insert
    // still cascades, and its result proves the value store had the 15 all
    // along — only the edge was missing.
    wb.set(2, 0, "25");
    assert_eq!(num(&wb, 0, 4, 0), 80.0, "10+15+25+30");
    assert_settled(&wb, "a write into an inserted row");
}

/// The column twin — same mechanism, same fix.
#[test]
fn a_write_into_an_inserted_column_recalculates_the_grown_range() {
    let wb = Workbook::new(1);
    wb.set(0, 0, "10");
    wb.set(0, 1, "20");
    wb.set(0, 2, "30");
    wb.set(0, 3, "=SUM(A1:C1)");
    assert_eq!(num(&wb, 0, 0, 3), 60.0, "precondition");

    insert_cols_at(&wb, 1, 1);
    assert_eq!(num(&wb, 0, 0, 4), 60.0, "after the insert, before any write");

    wb.set(0, 1, "15");
    assert_eq!(
        num(&wb, 0, 0, 4),
        75.0,
        "BUG-0055 (column twin): the inserted cell had no dependency edge"
    );
    assert_settled(&wb, "a write into an inserted column");
}

/// A defined name whose target range spans the insert: the fix rebuilds the
/// edge maps by EXPANDING stored ASTs (`rebuild_all_dependencies`), so the
/// name-using formula must keep its expanded cell edges — the regression the
/// raw-parse alternative (the cut/paste relocation precedent) would have
/// introduced.
#[test]
fn a_name_backed_formula_keeps_its_expanded_edges_across_an_insert() {
    let wb = Workbook::new(1);
    wb.set(0, 0, "10");
    wb.set(1, 0, "20");
    {
        let mut names = wb
            .state
            .named_ranges
            .write(&crate::document_effect::test_seed_effect())
            .unwrap();
        names.insert(
            "DATA".to_string(),
            crate::named_ranges::NamedRange {
                name: "DATA".to_string(),
                sheet_index: None,
                refers_to: "=Sheet1!$A$1:$A$2".to_string(),
                comment: None,
                folder: None,
            },
        );
    }
    wb.set(0, 2, "=SUM(DATA)");
    assert_eq!(num(&wb, 0, 0, 2), 30.0, "precondition");

    // Insert BELOW both name targets, so the name's definition is untouched
    // and only the rebuild path decides whether the expanded edges survive.
    insert_rows_at(&wb, 5, 1);
    wb.set(1, 0, "25");
    assert_eq!(
        num(&wb, 0, 0, 2),
        35.0,
        "the expanded name edge (A2 -> the SUM) must survive the insert's rebuild"
    );
}
