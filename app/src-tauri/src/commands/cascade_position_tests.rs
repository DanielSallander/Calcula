//! FILENAME: app/src-tauri/src/commands/cascade_position_tests.rs
//! PURPOSE: A DEPENDENT that a cascade re-evaluates is evaluated AT ITS OWN
//! CELL -- the position `reevaluate_formula_cell` has always given the
//! single-edit cascade.
//!
//! A child module of `commands::data` (declared with `#[path]` there), so it
//! drives the real write bodies -- `update_cells_batch_core` (a paste, a
//! script's setValues), `update_cell_impl` (an edit), `update_cell_on_sheets_inner`
//! (a background-sheet write) and the undo restore -- with no Tauri runtime,
//! through the shared `cross_sheet_recalc_tests::Workbook` harness.
//!
//! THE DEFECT THESE PIN. The batch writer's same-sheet cascade, `fill_range`'s
//! and the cross-sheet walk's per-cell step (`recalc_walked_cell`, which every
//! edit path's off-sheet half runs) evaluated a dependent through an entry
//! point that carries NO position (`current_row` / `current_col` both `None`).
//! Everything in the formula language that asks "where am I?" then answered
//! for nowhere:
//!
//!   * argument-less `ROW()` / `COLUMN()` -> `#VALUE!`;
//!   * implicit intersection (`=@A1:A10` in B5) -> reduced against row 1, so
//!     it read A1 instead of A5;
//!   * a CUBE cell with no cube data in this pass -> `#N/A` instead of its last
//!     served value (`preserved_cube_value` reads the cell AT the position), the
//!     clobber docs/design/cube-formulas-and-custom-functions.md 2.4 forbids;
//!   * a custom-function cell with no resolver -> `#NAME?` instead of its last
//!     value (`preserved_udf_value`, the same rule, 4.4).
//!
//! And, the same hand-copied loop, it wrote `EvalResult::to_cell_value()`, so a
//! dynamic-array DEPENDENT collapsed to its first element on a paste instead of
//! re-spilling (the 3bm anti-pattern `apply_spill_decision` exists to end).

use super::cross_sheet_recalc_tests::{body_of, undo_once, Workbook};
use super::*;
use engine::{CellError, CellValue};

/// `sheets` sheets, Sheet1 active, en-US so the formulas below read the same on
/// every machine (the harness takes the startup locale, which may be sv-SE).
fn workbook(sheets: usize) -> Workbook {
    let wb = Workbook::new(sheets);
    *wb.state.locale.lock().unwrap() = engine::LocaleSettings::from_locale_id("en-US");
    wb
}

/// A paste: one batch through the REAL batch body, as `update_cells_batch`
/// runs it for a write with no UDF or cube pre-fetch (an ordinary paste, and
/// every Rust-side caller -- the script surfaces and the MCP tools).
fn paste(wb: &Workbook, writes: &[(u32, u32, &str)]) -> Vec<CellData> {
    let updates = writes
        .iter()
        .map(|&(row, col, value)| crate::api_types::CellUpdateInput {
            row,
            col,
            value: value.to_string(),
            style_index: None,
            invariant: Some(true),
            pasted: None,
            moved: None,
        })
        .collect();
    update_cells_batch_core(
        &wb.state, &wb.file, &wb.files, &wb.pivots, updates, None, None, None, None,
    )
    .expect("the batch writes")
}

/// A background-sheet write through the REAL `update_cell_on_sheets` body.
fn write_on_sheets(wb: &Workbook, sheets: Vec<usize>, row: u32, col: u32, value: &str) {
    let wrote = update_cell_on_sheets_inner(
        &wb.state,
        &wb.file,
        &wb.files,
        &wb.pivots,
        &wb.pane,
        &wb.filters,
        sheets.clone(),
        row,
        col,
        value.to_string(),
        Some(true),
        None,
        None,
    )
    .expect("the background write");
    assert_eq!(wrote, sheets, "the background write landed on every sheet asked");
}

/// Put `value` behind an existing formula cell as a workbook OPENED from disk
/// holds it: the stored value, and -- what the open path records for every
/// root cube and custom-function cell (`bi::cube::remember_loaded_call_results`)
/// -- the results cache's entry that it is that call's answer for the
/// arguments the cell has now. Without that entry a recalculation with no cube
/// data or UDF resolver refuses the call rather than vouch for it (rev3A#3).
/// Both halves of the mirror when the sheet is active; canonical lock order
/// (grid, then grids).
fn stamp(wb: &Workbook, sheet: usize, row: u32, col: u32, value: CellValue) {
    stamp_value_only(wb, sheet, row, col, value);
    crate::bi::cube::remember_loaded_call_results(&wb.state);
}

/// Put `value` behind an existing formula cell and record NOTHING about where
/// it came from -- a composite formula's value, which the open path does not
/// seed (its call has no saved value of its own).
fn stamp_value_only(wb: &Workbook, sheet: usize, row: u32, col: u32, value: CellValue) {
    let clean = crate::document_effect::DocumentEffect::deliberately_clean(
        crate::document_effect::CleanReason::LoadingFromDisk,
    );
    let active = *wb.state.active_sheet.read().unwrap();
    let mut grid = wb.state.grid.write(&clean).unwrap();
    let mut grids = wb.state.grids.write(&clean).unwrap();
    let mut cell = grids[sheet]
        .get_cell(row, col)
        .cloned()
        .expect("stamp a cell that holds a formula");
    assert!(cell.formula_string().is_some(), "stamp a FORMULA cell");
    cell.value = value;
    if sheet == active {
        grid.set_cell(row, col, cell.clone());
    }
    grids[sheet].set_cell(row, col, cell);
}

fn num(n: f64) -> CellValue {
    CellValue::Number(n)
}

// ---------------------------------------------------------------------------
// 1. The batch (paste / script setValues) cascade, same sheet
// ---------------------------------------------------------------------------

#[test]
fn a_paste_recalculates_a_row_reading_dependent_at_its_own_row() {
    let wb = workbook(1);
    wb.set(0, 0, "2"); // A1
    wb.set(3, 1, "=ROW()*A1"); // B4
    wb.set(1, 4, "=COLUMN()+A1"); // E2
    assert_eq!(wb.value(0, 3, 1), num(8.0), "precondition: the edit evaluates B4 at B4");
    assert_eq!(wb.value(0, 1, 4), num(7.0), "precondition: the edit evaluates E2 at E2");

    paste(&wb, &[(0, 0, "5")]);

    assert_eq!(
        wb.value(0, 3, 1),
        num(20.0),
        "B4 = ROW()*A1 after a paste into A1: the batch cascade evaluated the \
         dependent at no position, so ROW() had no row to answer"
    );
    assert_eq!(
        wb.value(0, 1, 4),
        num(10.0),
        "E2 = COLUMN()+A1 after a paste into A1: COLUMN() had no column to answer"
    );
}

#[test]
fn a_pasted_row_or_column_formula_reads_the_cell_it_landed_in() {
    // The written cells are MEMBERS of the batch's cascade order, so a formula
    // the batch writes is evaluated twice: once where it lands (positioned) and
    // again by the cascade -- which overwrote the right answer with #VALUE!.
    let wb = workbook(1);
    let cells = paste(&wb, &[(6, 1, "=ROW()"), (6, 2, "=COLUMN()")]);

    assert_eq!(wb.value(0, 6, 1), num(7.0), "=ROW() pasted into B7");
    assert_eq!(wb.value(0, 6, 2), num(3.0), "=COLUMN() pasted into C7");
    let b7: Vec<&str> = cells
        .iter()
        .filter(|c| c.row == 6 && c.col == 1 && c.sheet_index.is_none())
        .map(|c| c.display.as_str())
        .collect();
    assert!(
        !b7.is_empty() && b7.iter().all(|d| *d == "7"),
        "every answer the batch returns for B7 must be its value, or the grid paints \
         the last one: {:?}",
        b7
    );
}

#[test]
fn a_paste_recalculates_an_implicit_intersection_on_the_dependents_own_row() {
    let wb = workbook(1);
    wb.set(0, 0, "100"); // A1
    wb.set(4, 0, "1"); // A5
    wb.set(4, 1, "=@A1:A10"); // B5 intersects A1:A10 on row 5
    assert_eq!(wb.value(0, 4, 1), num(1.0), "precondition: B5 reads A5");

    paste(&wb, &[(4, 0, "7")]);

    assert_eq!(
        wb.value(0, 4, 1),
        num(7.0),
        "B5 = @A1:A10 after a paste into A5 must read A5; evaluated at no position \
         the intersection is taken on row 1 and reads A1 (100)"
    );
}

#[test]
fn a_paste_keeps_a_cube_cells_last_value_when_it_carries_no_cube_data() {
    // A paste with no cube data (a Rust-side writer, or a session that has not
    // latched). Section 2.4: such a pass must not clobber a cube cell whose
    // argument it rewrote with the SAME member -- it keeps the value the model
    // last answered for that member.
    let wb = workbook(1);
    wb.set(1, 0, "[Revenue]"); // A2, the member the cube cell reads
    wb.set(1, 1, r#"=CUBEVALUE("Sales",A2)"#); // B2
    stamp(&wb, 0, 1, 1, num(225.0)); // what the model served

    paste(&wb, &[(1, 0, "[Revenue]")]);

    assert_eq!(
        wb.value(0, 1, 1),
        num(225.0),
        "a paste into the cell a CUBEVALUE reads clobbered the cube cell: with no \
         position, preserved_cube_value had no cell to keep and answered #N/A"
    );
}

#[test]
fn a_rust_side_batch_keeps_a_custom_function_cells_last_value() {
    // The script surfaces and the MCP tools call the batch body with no UDF
    // pre-fetch at all. Section 4.4: the custom-function cell keeps its value.
    let wb = workbook(1);
    wb.set(0, 0, "3"); // A1
    wb.set(0, 1, "=MYFN(A1)"); // B1
    stamp(&wb, 0, 0, 1, num(42.0)); // what the script host served

    paste(&wb, &[(0, 0, "3")]);

    assert_eq!(
        wb.value(0, 0, 1),
        num(42.0),
        "a write into the cell a custom function reads clobbered it: with no \
         position, preserved_udf_value had no cell to keep and answered #NAME?"
    );
}

#[test]
fn a_paste_re_lays_a_dynamic_array_dependent() {
    // The same hand-copied loop wrote `to_cell_value()`: B1 = SEQUENCE(A1) kept
    // its old two-row spill when a paste made A1 four, and kept a stale tail
    // when one made it one.
    let wb = workbook(1);
    wb.set(0, 0, "2"); // A1
    wb.set(0, 1, "=SEQUENCE(A1)"); // B1 spills B1:B2
    assert_eq!(wb.value(0, 1, 1), num(2.0), "precondition: B1 spills into B2");

    paste(&wb, &[(0, 0, "4")]);
    assert_eq!(wb.value(0, 0, 1), num(1.0), "the origin keeps its first element");
    assert_eq!(
        (wb.value(0, 2, 1), wb.value(0, 3, 1)),
        (num(3.0), num(4.0)),
        "a paste that GREW the array must re-spill it into B3:B4"
    );

    paste(&wb, &[(0, 0, "1")]);
    assert_eq!(
        (wb.value(0, 1, 1), wb.value(0, 2, 1), wb.value(0, 3, 1)),
        (CellValue::Empty, CellValue::Empty, CellValue::Empty),
        "a paste that SHRANK the array must release its old tail"
    );
}

// ---------------------------------------------------------------------------
// 2. The cross-sheet walk (every edit path's off-sheet half) and undo
// ---------------------------------------------------------------------------

/// Sheet1!A1 = 2; on Sheet2, B3 = ROW()*Sheet1!A1 (6) and D2 = COLUMN()*Sheet1!A1
/// (8), authored while Sheet2 is active, as the user does.
fn row_readers_on_sheet2() -> Workbook {
    let wb = workbook(2);
    wb.set(0, 0, "2");
    wb.switch_to(1);
    wb.set(2, 1, "=ROW()*Sheet1!A1");
    wb.set(1, 3, "=COLUMN()*Sheet1!A1");
    wb.switch_to(0);
    assert_eq!(wb.value(1, 2, 1), num(6.0), "precondition: Sheet2!B3");
    assert_eq!(wb.value(1, 1, 3), num(8.0), "precondition: Sheet2!D2");
    wb
}

#[test]
fn an_edit_recalculates_an_off_sheet_row_reading_dependent_at_its_own_cell() {
    let wb = row_readers_on_sheet2();
    wb.set(0, 0, "5");
    assert_eq!(
        wb.value(1, 2, 1),
        num(15.0),
        "Sheet2!B3 = ROW()*Sheet1!A1 after an edit of Sheet1!A1: the cross-sheet \
         walk evaluated it at no position"
    );
    assert_eq!(wb.value(1, 1, 3), num(20.0), "Sheet2!D2 = COLUMN()*Sheet1!A1");
}

#[test]
fn a_paste_recalculates_an_off_sheet_row_reading_dependent_at_its_own_cell() {
    let wb = row_readers_on_sheet2();
    paste(&wb, &[(0, 0, "5")]);
    assert_eq!(wb.value(1, 2, 1), num(15.0), "Sheet2!B3 after a paste into Sheet1!A1");
    assert_eq!(wb.value(1, 1, 3), num(20.0), "Sheet2!D2 after a paste into Sheet1!A1");
}

#[test]
fn undo_recalculates_an_off_sheet_row_reading_dependent_at_its_own_cell() {
    let wb = row_readers_on_sheet2();
    wb.set(0, 0, "5");
    undo_once(&wb);
    assert_eq!(wb.number(0, 0, 0), 2.0, "the undo restored Sheet1!A1");
    assert_eq!(
        wb.value(1, 2, 1),
        num(6.0),
        "Sheet2!B3 after the undo: the restore's cross-sheet walk evaluated it at \
         no position"
    );
}

#[test]
fn an_off_sheet_implicit_intersection_reads_the_dependents_own_row() {
    let wb = workbook(2);
    wb.set(0, 0, "100"); // Sheet1!A1
    wb.set(4, 0, "1"); // Sheet1!A5
    wb.switch_to(1);
    wb.set(4, 1, "=@Sheet1!A1:A10"); // Sheet2!B5
    wb.switch_to(0);
    assert_eq!(wb.value(1, 4, 1), num(1.0), "precondition: Sheet2!B5 reads Sheet1!A5");

    wb.set(4, 0, "7");

    assert_eq!(
        wb.value(1, 4, 1),
        num(7.0),
        "Sheet2!B5 = @Sheet1!A1:A10 must intersect on ITS row (5), not row 1"
    );
}

#[test]
fn an_edit_keeps_an_off_sheet_cube_cells_last_value() {
    // The cross-sheet walk is handed no cube data at all, by any caller.
    let wb = workbook(2);
    wb.set(1, 0, "[Revenue]"); // Sheet1!A2
    wb.switch_to(1);
    wb.set(1, 1, r#"=CUBEVALUE("Sales",Sheet1!A2)"#); // Sheet2!B2
    wb.switch_to(0);
    stamp(&wb, 1, 1, 1, num(225.0));

    wb.set(1, 0, "[Revenue]");

    assert_eq!(
        wb.value(1, 1, 1),
        num(225.0),
        "an edit of the member a cube cell on another sheet reads clobbered it to \
         #N/A (preserved_cube_value had no position)"
    );
    assert_ne!(wb.value(1, 1, 1), CellValue::Error(CellError::NA));
}

// ---------------------------------------------------------------------------
// 2b. rev3A#3: a recalculation with no cube data or UDF resolver answers each
//     call from the sheet's results cache, for EXACTLY the arguments it has
//     (round 6; round 5 also required the call to be the whole formula).
//     Giving these routes a position (round 3) let the old preserve hand back
//     the cell's WHOLE stored value on all of them: a changed argument kept the
//     previous member's number, and a composite formula fed its own result to
//     its operator again at every recalculation.
// ---------------------------------------------------------------------------

#[test]
fn a_paste_of_a_new_member_refuses_the_cube_cells_old_value() {
    let wb = workbook(1);
    wb.set(1, 0, "[Revenue]"); // A2
    wb.set(1, 1, r#"=CUBEVALUE("Sales",A2)"#); // B2
    stamp(&wb, 0, 1, 1, num(225.0)); // Revenue's number

    paste(&wb, &[(1, 0, "[Cost]")]);

    assert_eq!(
        wb.value(0, 1, 1),
        CellValue::Error(CellError::NA),
        "a paste of a new member kept the previous member's number in the cube cell"
    );
    // Pasting the old member back serves Revenue's recorded answer again,
    // although the cell now holds #N/A: the results cache answers a call for
    // its exact arguments (round 6, changed on purpose; round 5 kept only a
    // value the cell still held, so this stayed #N/A until a recalculation
    // with cube data reached it).
    paste(&wb, &[(1, 0, "[Revenue]")]);
    assert_eq!(
        wb.value(0, 1, 1),
        num(225.0),
        "the member went back to Revenue, whose answer is recorded"
    );
}

#[test]
fn an_edit_on_another_sheet_of_a_new_member_refuses_the_cube_cells_old_value() {
    // THE REVIEWER'S SCENARIO: Report!B2 reads Control!A1; the cross-sheet walk
    // carries no cube data at all, by any caller.
    let wb = workbook(2);
    wb.set(1, 0, "[Revenue]"); // Sheet1!A2
    wb.switch_to(1);
    wb.set(1, 1, r#"=CUBEVALUE("Sales",Sheet1!A2)"#); // Sheet2!B2
    wb.switch_to(0);
    stamp(&wb, 1, 1, 1, num(225.0));

    wb.set(1, 0, "[Cost]");

    assert_eq!(
        wb.value(1, 1, 1),
        CellValue::Error(CellError::NA),
        "the cross-sheet walk kept Revenue's number for Cost"
    );
}

#[test]
fn a_composite_cube_formula_is_never_divided_again_by_repeated_recalculations() {
    // Sheet2!B2 = CUBEVALUE(..)/1000 showed 0.225. Each edit of the cell it
    // reads ran the walk, and the stored 0.225 came back as CUBEVALUE's answer:
    // 0.000225, then 0.000000225. Nothing ever SERVED this call here (the value
    // is only stamped, and the open path does not seed a call inside a larger
    // formula), so the results cache has no answer and it is refused instead.
    // A served one keeps its value: bi::cube's
    // the_cross_sheet_walk_keeps_a_composite_cube_formula_reading_another_sheet.
    let wb = workbook(2);
    wb.set(1, 0, "[Revenue]");
    wb.switch_to(1);
    wb.set(1, 1, r#"=CUBEVALUE("Sales",Sheet1!A2)/1000"#);
    wb.switch_to(0);
    stamp_value_only(&wb, 1, 1, 1, num(0.225));

    for edit in 1..=3 {
        wb.set(1, 0, "[Revenue]");
        assert_eq!(
            wb.value(1, 1, 1),
            CellValue::Error(CellError::NA),
            "edit {}: the stored quotient fed the division again",
            edit
        );
    }
}

#[test]
fn a_rust_side_batch_that_changes_a_custom_functions_argument_refuses_its_old_value() {
    let wb = workbook(1);
    wb.set(0, 0, "3"); // A1
    wb.set(0, 1, "=MYFN(A1)"); // B1
    wb.set(0, 2, "=MYFN(A1)*2"); // C1
    stamp(&wb, 0, 0, 1, num(42.0));
    stamp_value_only(&wb, 0, 0, 2, num(84.0));

    paste(&wb, &[(0, 0, "4")]);

    assert_eq!(
        wb.value(0, 0, 1),
        CellValue::Error(CellError::Name),
        "MYFN(3)'s answer was kept for MYFN(4)"
    );
    assert_eq!(
        wb.value(0, 0, 2),
        CellValue::Error(CellError::Name),
        "C1 = MYFN(A1)*2 fed its own stored value to the multiplication"
    );

    // A1 back to 3: MYFN(3)'s answer (seeded from B1's saved value) serves
    // both cells again -- C1 computes 84 from the CALL's answer, never 168
    // from its own stored value (round 6, the results cache).
    paste(&wb, &[(0, 0, "3")]);
    assert_eq!(wb.value(0, 0, 1), num(42.0), "back to 3: MYFN(3)'s recorded answer");
    assert_eq!(wb.value(0, 0, 2), num(84.0), "C1 = MYFN(A1)*2 computed from MYFN(3)'s answer");
}

#[test]
fn a_background_write_of_a_new_member_refuses_the_cube_cells_old_value() {
    // revFU#2: a write to a sheet that is not active (`update_cell_on_sheets`)
    // recalculates that sheet with no cube data. The cube cell keeps its value
    // for the member it was answered for, and refuses it for any other.
    let wb = workbook(2);
    wb.switch_to(1);
    wb.set(1, 0, "[Revenue]"); // Sheet2!A2
    wb.set(1, 1, r#"=CUBEVALUE("Sales",A2)"#); // Sheet2!B2
    wb.switch_to(0);
    stamp(&wb, 1, 1, 1, num(225.0));

    write_on_sheets(&wb, vec![1], 1, 0, "[Revenue]");
    assert_eq!(wb.value(1, 1, 1), num(225.0), "the same member: the value is kept");

    write_on_sheets(&wb, vec![1], 1, 0, "[Cost]");
    assert_eq!(
        wb.value(1, 1, 1),
        CellValue::Error(CellError::NA),
        "a background write of a new member kept the previous member's number"
    );
}

// ---------------------------------------------------------------------------
// 3. The background-sheet write (coverage: its recalculation is the positioned
//    whole-sheet pass, so this path was not affected)
// ---------------------------------------------------------------------------

#[test]
fn a_background_write_recalculates_a_row_reading_dependent_at_its_own_cell() {
    let wb = workbook(2);
    wb.switch_to(1);
    wb.set(0, 0, "2"); // Sheet2!A1
    wb.set(3, 1, "=ROW()*A1"); // Sheet2!B4
    wb.switch_to(0);
    wb.set(2, 2, "=ROW()*Sheet2!A1"); // Sheet1!C3, the active sheet's reader
    assert_eq!(wb.value(1, 3, 1), num(8.0), "precondition: Sheet2!B4");
    assert_eq!(wb.value(0, 2, 2), num(6.0), "precondition: Sheet1!C3");

    write_on_sheets(&wb, vec![1], 0, 0, "5");

    assert_eq!(wb.value(1, 3, 1), num(20.0), "Sheet2!B4 after a background write to Sheet2!A1");
    assert_eq!(wb.value(0, 2, 2), num(15.0), "Sheet1!C3 after a background write to Sheet2!A1");

    write_on_sheets(&wb, vec![1], 6, 2, "=ROW()+COLUMN()");
    assert_eq!(wb.value(1, 6, 2), num(10.0), "=ROW()+COLUMN() written into Sheet2!C7");
}

// ---------------------------------------------------------------------------
// 4. Source tripwire: fill_range cannot run in-process (it takes Tauri State),
//    so its cascade is pinned to the SAME per-cell evaluator the batch's
//    behavioural tests above exercise.
// ---------------------------------------------------------------------------

#[test]
fn every_same_sheet_cascade_evaluates_through_the_positioned_per_cell_evaluator() {
    const DATA_RS: &str = include_str!("data.rs");
    for command in [
        "update_cell_impl",
        "update_cells_batch_core",
        // The command delegates to this body (testability split).
        "fill_range_core",
        "recalc_after_active_sheet_bulk_rewrite",
    ] {
        let body = body_of(DATA_RS, command);
        assert!(
            body.contains("reevaluate_formula_cell("),
            "`{}` re-evaluates dependents without `reevaluate_formula_cell`, the one \
             per-cell evaluator that gives a dependent its own position and spills it",
            command
        );
        assert!(
            !body.contains("evaluate_formula_raw_with_ast_files_and_cube("),
            "`{}` evaluates a cell through the POSITIONLESS entry point again -- \
             ROW()/COLUMN() answer #VALUE!, `@` intersects row 1, and a cube or \
             custom-function cell is clobbered instead of kept",
            command
        );
    }
}

#[test]
fn the_cross_sheet_walk_evaluates_each_dependent_at_its_own_cell() {
    // The behavioural tests in section 2 drive the walk; this pins the position
    // to the walk's ONE per-cell step, so a second step added beside it is seen.
    const DATA_RS: &str = include_str!("data.rs");
    let walked = body_of(DATA_RS, "recalc_walked_cell");
    assert!(
        walked.contains("current_row: Some(dep_row)") && walked.contains("current_col: Some(dep_col)"),
        "the cross-sheet walk's per-cell step must evaluate the dependent at its own cell"
    );
    assert!(
        !walked.contains("evaluate_formula_raw_with_ast_files_and_cube("),
        "the cross-sheet walk's per-cell step went back to the positionless entry point"
    );
}
