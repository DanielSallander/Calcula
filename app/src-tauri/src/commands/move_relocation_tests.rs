//! FILENAME: app/src-tauri/src/commands/move_relocation_tests.rs
//! PURPOSE: A MOVE (drag-move, Cut + Paste) re-points the references INTO the
//! moved block and leaves every other reference alone, as Excel's
//! `Range.Cut Destination` does [LIVE, Excel 16, 2026-10-29].
//!
//! A child module of `commands::data` (declared with `#[path]` there), so it
//! drives the REAL bodies -- `update_cells_batch_core` for the move's writes and
//! `structure::relocate_cell_references_core` for the re-pointing -- with no
//! Tauri runtime, through the shared `cross_sheet_recalc_tests::Workbook`
//! harness.
//!
//! THE DEFECTS THESE PIN.
//!
//!   * The drag-move SHIFTED every relative reference of a moved formula by the
//!     move's offset, so `=A1` moved from B1 to B2 became `=A2` (Excel keeps
//!     `=A1`). The fix stops the shift in `useClipboard.ts`; it can only stop
//!     there if the relocation re-points what the shift used to get right --
//!     the moved formulas' references INTO the block -- and the relocation
//!     skipped the destination outright.
//!   * The relocation was ACTIVE-SHEET-ONLY and SHEET-BLIND: `=Sheet1!A1` on
//!     Sheet2 kept naming the emptied cell, `=Sheet2!A1` on Sheet1 was
//!     renumbered when Sheet1's A1 moved, and a defined name on the moved
//!     cells was never touched.
//!   * Each corner of a range moved on its own, so cutting A1:A3 of
//!     `=SUM(A1:A4)` to column C gave `=SUM(C1:A4)`, a twelve-cell rectangle.
//!   * (Round 6) A reference to a cell the move OVERWROTE kept naming it and
//!     silently read the moved value; Excel makes it `#REF!`. And a Cut on
//!     one sheet pasted on ANOTHER was never relocated at all (sections 6-8).
//!   * (Round 7) A followed range corner landing INSIDE the range shrank it to
//!     where it landed, and an overlapping move kept the strip it overwrote
//!     (sections 5 and 9); a row / column move left whole-row / whole-column
//!     references (`1:1`, `A:A`) on the lines it had just emptied (section
//!     10); the end of a 3-D span (`Sheet2:Sheet3!A1`) was read as a plain
//!     qualifier, so moving a cell on Sheet3 re-pointed the span on every
//!     sheet (section 11); and undoing a move left another sheet's restored
//!     formula's cross-sheet edge at the moved address (section 4).

use super::cross_sheet_recalc_tests::{undo_once, Workbook};
use super::*;
use crate::commands::structure::{relocate_cell_references_core, relocate_references_for_move, CellMove};
use engine::{CellError, CellValue};

/// `sheets` sheets, Sheet1 active, en-US so the formulas read the same on
/// every machine.
fn workbook(sheets: usize) -> Workbook {
    let wb = Workbook::new(sheets);
    *wb.state.locale.lock().unwrap() = engine::LocaleSettings::from_locale_id("en-US");
    wb
}

/// ONE batch through the REAL batch body.
fn batch(wb: &Workbook, writes: &[(u32, u32, String)]) {
    if writes.is_empty() {
        return;
    }
    let updates = writes
        .iter()
        .map(|(row, col, value)| crate::api_types::CellUpdateInput {
            row: *row,
            col: *col,
            value: value.clone(),
            style_index: None,
            invariant: Some(true),
            pasted: None,
        })
        .collect();
    update_cells_batch_core(
        &wb.state, &wb.file, &wb.files, &wb.pivots, updates, None, None, None, None,
    )
    .expect("the batch writes");
}

/// What a cell of `sheet` holds, as the frontend would send it back: `=` + the
/// formula, else the stored value.
fn input_on(wb: &Workbook, sheet: usize, row: u32, col: u32) -> String {
    let grids = wb.state.grids.read().unwrap();
    match grids[sheet].get_cell(row, col) {
        None => String::new(),
        Some(cell) => match cell.formula_string() {
            Some(f) => format!("={}", f),
            None => match &cell.value {
                CellValue::Number(n) => format!("{}", n),
                CellValue::Text(s) => s.clone(),
                CellValue::Empty => String::new(),
                other => panic!("the move harness does not carry {:?}", other),
            },
        },
    }
}

/// A DRAG-MOVE of the active sheet's `(r0, c0)..=(r1, c1)` to `(tr, tc)`,
/// exactly as `useClipboard.moveCells` now performs it: every source cell is
/// read first and written to the destination UNSHIFTED, the source cells the
/// destination does not cover are cleared, then `relocate_cell_references`
/// re-points the references into the block -- all in one undo step.
fn drag_move(wb: &Workbook, (r0, c0, r1, c1): (u32, u32, u32, u32), (tr, tc): (u32, u32)) {
    let active = *wb.state.active_sheet.read().unwrap();
    let mut writes = Vec::new();
    for r in r0..=r1 {
        for c in c0..=c1 {
            writes.push((tr + (r - r0), tc + (c - c0), input_on(wb, active, r, c)));
        }
    }
    let (er, ec) = (tr + (r1 - r0), tc + (c1 - c0));
    let mut clears = Vec::new();
    for r in r0..=r1 {
        for c in c0..=c1 {
            let in_dest = r >= tr && r <= er && c >= tc && c <= ec;
            if !in_dest {
                clears.push((r, c, String::new()));
            }
        }
    }
    wb.state.undo_stack.lock().unwrap().begin_transaction("Move cells");
    batch(wb, &writes);
    batch(wb, &clears);
    relocate_cell_references_core(
        &wb.state, &wb.file, &wb.files, &wb.pivots, &wb.pane, &wb.filters, r0, c0, r1, c1, tr, tc, None,
    )
    .expect("the relocation runs");
    wb.state.undo_stack.lock().unwrap().commit_transaction();
}

/// The formula a cell's formula bar shows (no `=`), or "" for none, UPPERCASED:
/// the lexer uppercases a bare sheet qualifier (`=Sheet1!A1` is stored as
/// `SHEET1!A1`), and these tests are about WHERE a reference points.
fn formula(wb: &Workbook, sheet: usize, row: u32, col: u32) -> String {
    let grids = wb.state.grids.read().unwrap();
    grids[sheet]
        .get_cell(row, col)
        .and_then(|cell| cell.formula_string())
        .unwrap_or_default()
        .to_uppercase()
}

fn refers_to(wb: &Workbook, name: &str) -> String {
    wb.state
        .named_ranges
        .read()
        .unwrap()
        .get(&name.to_uppercase())
        .map(|n| n.refers_to.clone())
        .unwrap_or_default()
}

fn define_name(wb: &Workbook, name: &str, refers_to: &str) {
    wb.state
        .named_ranges
        .write(&crate::document_effect::test_seed_effect())
        .unwrap()
        .insert(
            name.to_uppercase(),
            crate::named_ranges::NamedRange {
                name: name.to_string(),
                sheet_index: None,
                refers_to: refers_to.to_string(),
                comment: None,
                folder: None,
            },
        );
}

// ---------------------------------------------------------------------------
// 1. The moved formulas themselves
// ---------------------------------------------------------------------------

#[test]
fn a_moved_formula_keeps_naming_the_cells_outside_the_block() {
    // Excel [LIVE]: B1 =A1 cut to B2 stays =A1.
    let wb = workbook(1);
    wb.set(0, 0, "5"); // A1
    wb.set(0, 1, "=A1"); // B1
    drag_move(&wb, (0, 1, 0, 1), (1, 1));
    assert_eq!(formula(&wb, 0, 1, 1), "A1", "a reference OUT of the block never moves");
    assert_eq!(wb.number(0, 1, 1), 5.0);
    assert_eq!(formula(&wb, 0, 0, 1), "", "the source is empty after a move");
}

#[test]
fn a_moved_formulas_reference_into_the_block_follows_the_block() {
    // Excel [LIVE]: B1:D1 = (=A1, =B1, =$B$1+B1) cut to B3 gives
    // (=A1, =B3, =$B$3+B3).
    let wb = workbook(1);
    wb.set(0, 0, "5"); // A1
    wb.set(0, 1, "=A1"); // B1
    wb.set(0, 2, "=B1"); // C1
    wb.set(0, 3, "=$B$1+B1"); // D1
    drag_move(&wb, (0, 1, 0, 3), (2, 1));

    assert_eq!(formula(&wb, 0, 2, 1), "A1");
    assert_eq!(
        formula(&wb, 0, 2, 2),
        "B3",
        "the moved =B1 still names the EMPTIED source cell: the relocation \
         skipped the destination, so a reference INTO the moved block was never \
         re-pointed"
    );
    assert_eq!(formula(&wb, 0, 2, 3), "$B$3+B3", "absolute references follow too");
    assert_eq!(wb.number(0, 2, 2), 5.0);
    assert_eq!(wb.number(0, 2, 3), 10.0);
}

#[test]
fn an_overlapping_move_re_points_every_reference_once() {
    // Excel [LIVE]: A1:A3 = (5, =A1*2, =A2+1) with B1 =A3, cut to A2, gives
    // A2:A4 = (5, =A2*2, =A3+1) and B1 =A4.
    let wb = workbook(1);
    wb.set(0, 0, "5");
    wb.set(1, 0, "=A1*2");
    wb.set(2, 0, "=A2+1");
    wb.set(0, 1, "=A3");
    drag_move(&wb, (0, 0, 2, 0), (1, 0));

    assert_eq!(wb.value(0, 0, 0), CellValue::Empty);
    assert_eq!(wb.number(0, 1, 0), 5.0);
    assert_eq!(formula(&wb, 0, 2, 0), "A2*2");
    assert_eq!(formula(&wb, 0, 3, 0), "A3+1");
    assert_eq!(formula(&wb, 0, 0, 1), "A4");
    assert_eq!(wb.number(0, 2, 0), 10.0);
    assert_eq!(wb.number(0, 3, 0), 11.0);
    assert_eq!(wb.number(0, 0, 1), 11.0);
}

// ---------------------------------------------------------------------------
// 2. Other sheets
// ---------------------------------------------------------------------------

#[test]
fn a_formula_on_another_sheet_follows_the_moved_cells() {
    // Excel [LIVE]: Sheet2!A1 =Sheet1!A1*2 becomes =Sheet1!A5*2.
    let wb = workbook(2);
    wb.set(0, 0, "7"); // Sheet1!A1
    wb.switch_to(1);
    wb.set(0, 0, "=Sheet1!A1*2"); // Sheet2!A1
    wb.set(0, 1, "=A1+1"); // Sheet2!B1
    wb.switch_to(0);
    assert_eq!(wb.number(1, 0, 0), 14.0, "setup");

    drag_move(&wb, (0, 0, 0, 0), (4, 0));

    assert_eq!(
        formula(&wb, 1, 0, 0),
        "SHEET1!A5*2",
        "Sheet2's reference to the moved cell still names the EMPTIED A1 -- \
         the relocation never looked past the active sheet"
    );
    assert_eq!(wb.number(1, 0, 0), 14.0, "and reads the moved value");
    assert_eq!(wb.number(1, 0, 1), 15.0, "its own reader follows");
}

#[test]
fn a_reference_to_another_sheets_cell_at_the_moved_address_is_left_alone() {
    // Excel [LIVE]: with Sheet1!A1 cut to A5, D1 =A1 -> =A5, D2 =Sheet1!A1 ->
    // =Sheet1!A5, and D3 =Sheet2!A1 stays =Sheet2!A1.
    let wb = workbook(2);
    wb.switch_to(1);
    wb.set(0, 0, "100"); // Sheet2!A1
    wb.switch_to(0);
    wb.set(0, 0, "7"); // Sheet1!A1
    wb.set(0, 3, "=A1"); // D1
    wb.set(1, 3, "=Sheet1!A1"); // D2
    wb.set(2, 3, "=Sheet2!A1"); // D3

    drag_move(&wb, (0, 0, 0, 0), (4, 0));

    assert_eq!(formula(&wb, 0, 0, 3), "A5");
    assert_eq!(formula(&wb, 0, 1, 3), "SHEET1!A5", "a self-qualified reference follows");
    assert_eq!(
        formula(&wb, 0, 2, 3),
        "SHEET2!A1",
        "a reference to ANOTHER sheet's A1 was renumbered because THIS sheet's A1 \
         moved -- the relocation was sheet-blind"
    );
    assert_eq!(wb.number(0, 2, 3), 100.0);
}

// ---------------------------------------------------------------------------
// 3. Defined names
// ---------------------------------------------------------------------------

#[test]
fn a_defined_name_on_the_moved_cells_follows_them() {
    // Excel [LIVE]: MyRange =Sheet1!$A$1:$A$3 follows A1:A3 cut to C1 to
    // =Sheet1!$C$1:$C$3; a name on Sheet2's cells is untouched.
    let wb = workbook(2);
    wb.set(0, 0, "1");
    wb.set(1, 0, "2");
    wb.set(2, 0, "3");
    define_name(&wb, "MyRange", "=Sheet1!$A$1:$A$3");
    define_name(&wb, "Other", "=Sheet2!$A$1");
    wb.set(0, 4, "=SUM(MyRange)"); // E1
    assert_eq!(wb.number(0, 0, 4), 6.0, "setup");

    drag_move(&wb, (0, 0, 2, 0), (0, 2));

    assert_eq!(
        refers_to(&wb, "MyRange"),
        "=Sheet1!$C$1:$C$3",
        "the name still points at the EMPTIED cells"
    );
    assert_eq!(refers_to(&wb, "Other"), "=Sheet2!$A$1");
    assert_eq!(wb.number(0, 0, 4), 6.0, "the name's reader follows the moved values");
}

// ---------------------------------------------------------------------------
// 4. Undo puts every rewrite back
// ---------------------------------------------------------------------------

#[test]
fn undoing_a_move_restores_another_sheets_formula_and_a_moved_name() {
    let wb = workbook(2);
    wb.set(0, 0, "7");
    define_name(&wb, "Seven", "=Sheet1!$A$1");
    wb.switch_to(1);
    wb.set(0, 0, "=Sheet1!A1*2");
    wb.switch_to(0);

    drag_move(&wb, (0, 0, 0, 0), (4, 0));
    assert_eq!(formula(&wb, 1, 0, 0), "SHEET1!A5*2", "setup: rewritten");
    assert_eq!(refers_to(&wb, "Seven"), "=Sheet1!$A$5", "setup: rewritten");

    undo_once(&wb);

    assert_eq!(formula(&wb, 1, 0, 0), "SHEET1!A1*2", "undo restores the other sheet's formula");
    assert_eq!(refers_to(&wb, "Seven"), "=Sheet1!$A$1", "undo restores the name");
    assert_eq!(wb.number(0, 0, 0), 7.0, "and the moved value");

    // ...and its EDGE. The restore put the text back but left the cross-sheet
    // edge at the moved address (Sheet1!A5), so editing Sheet1!A1 afterwards
    // reached nothing and Sheet2!A1 kept showing 14.
    wb.set(0, 0, "8");
    assert_eq!(
        wb.number(1, 0, 0),
        16.0,
        "after the undo, an edit of Sheet1!A1 no longer reaches Sheet2!A1: the \
         restored formula's cross-sheet edge still points at the moved address"
    );
}

// ---------------------------------------------------------------------------
// 5. Excel's range rule, case by case [LIVE]
// ---------------------------------------------------------------------------

/// Cut `(r0, c0)..=(r1, c1)` to `(tr, tc)` (0-based) and relocate `formula`
/// as it would be on the edited sheet itself.
fn relocate(formula: &str, (r0, c0, r1, c1): (u32, u32, u32, u32), (tr, tc): (u32, u32)) -> String {
    let mv = CellMove {
        source_sheet: "Sheet1",
        dest_sheet: "Sheet1",
        block: (r0, c0, r1, c1),
        delta_row: tr as i32 - r0 as i32,
        delta_col: tc as i32 - c0 as i32,
    };
    relocate_references_for_move(formula, "Sheet1", "Sheet1", &mv)
}

#[test]
fn a_range_follows_the_way_excel_moves_it() {
    // (formula, cut block, destination, Excel's result) -- every row measured
    // over COM, Excel 16, 2026-10-29.
    let a = |r: u32, c: u32| (r, c);
    let cases: &[(&str, (u32, u32, u32, u32), (u32, u32), &str)] = &[
        // Whole range in the block: the range moves.
        ("SUM(A1:A3)", (0, 0, 2, 0), a(0, 2), "SUM(C1:C3)"),
        ("SUM(A1:A3)", (0, 0, 2, 0), a(1, 0), "SUM(A2:A4)"),
        // One corner, its whole edge moving along the range: it follows.
        ("SUM(A1:A3)", (2, 0, 2, 0), a(5, 0), "SUM(A1:A6)"),
        ("SUM(A2:A3)", (2, 0, 2, 0), a(5, 0), "SUM(A2:A6)"),
        ("SUM($A$1:$A$3)", (2, 0, 2, 0), a(5, 0), "SUM($A$1:$A$6)"),
        ("SUM(A2:A4)", (1, 0, 1, 0), a(0, 0), "SUM(A1:A4)"),
        // One corner that follows INWARD, onto cells of the range: the range
        // keeps the cells the cut left behind (relocate/probe1.ps1 'inward').
        ("SUM(A1:A5)", (4, 0, 4, 0), a(1, 0), "SUM(A1:A4)"),
        ("SUM(A1:A5)", (0, 0, 0, 0), a(3, 0), "SUM(A2:A5)"),
        ("SUM(A2:A6)", (1, 0, 1, 0), a(3, 0), "SUM(A3:A6)"),
        ("SUM(A1:B5)", (4, 0, 4, 1), a(1, 0), "SUM(A1:B4)"),
        ("SUM(A1:A3)", (2, 0, 2, 0), a(0, 0), "SUM(A1:A2)"),
        ("SUM(A1:A5)", (0, 0, 0, 0), a(4, 0), "SUM(A2:A5)"),
        ("SUM(A1:A5)", (4, 0, 4, 0), a(0, 0), "SUM(A1:A4)"),
        ("SUM(A1:E1)", (0, 4, 0, 4), a(0, 1), "SUM(A1:D1)"),
        ("SUM(A1:A5)", (3, 0, 4, 0), a(1, 0), "SUM(A1:A3)"),
        ("SUM(A2:A5)", (0, 0, 1, 0), a(3, 0), "SUM(A3:A5)"),
        // One corner that would turn the range inside out: unchanged.
        ("SUM(A3:A4)", (2, 0, 2, 0), a(5, 0), "SUM(A3:A4)"),
        ("SUM(A1:A3)", (0, 0, 0, 0), a(4, 0), "SUM(A1:A3)"),
        // One corner whose edge does not move whole: unchanged.
        ("SUM(A1:A4)", (0, 0, 2, 0), a(0, 2), "SUM(A1:A4)"),
        ("SUM(A1:B2)", (1, 1, 1, 1), a(3, 3), "SUM(A1:B2)"),
        ("SUM(A1:A3)", (2, 0, 2, 0), a(2, 2), "SUM(A1:A3)"),
        ("SUM(A1:A3)", (0, 0, 0, 0), a(0, 2), "SUM(A1:A3)"),
        ("SUM(A1:A3)", (1, 0, 2, 0), a(1, 2), "SUM(A1:A3)"),
        ("SUM(A1:B1)", (0, 1, 0, 1), a(4, 1), "SUM(A1:B1)"),
        ("SUM(B2:C3)", (1, 1, 1, 1), a(0, 0), "SUM(B2:C3)"),
        ("SUM(B2:C3)", (0, 0, 1, 1), a(4, 0), "SUM(B2:C3)"),
        // Only the middle moved: unchanged.
        ("SUM(A1:A3)", (1, 0, 1, 0), a(1, 2), "SUM(A1:A3)"),
    ];
    let mut wrong = Vec::new();
    for &(f, block, to, expected) in cases {
        let got = relocate(f, block, to);
        if got != expected {
            wrong.push(format!("{} cut {:?} to {:?}: got {}, Excel {}", f, block, to, got, expected));
        }
    }
    assert!(wrong.is_empty(), "the range rule disagrees with Excel:\n  {}", wrong.join("\n  "));
}

#[test]
fn single_references_follow_only_into_the_block_and_only_on_the_moved_sheet() {
    assert_eq!(relocate("A1+B1", (0, 1, 0, 1), (2, 1)), "A1+B3");
    assert_eq!(relocate("$B$1*2", (0, 1, 0, 1), (2, 1)), "$B$3*2");
    assert_eq!(relocate("Sheet2!B1+B1", (0, 1, 0, 1), (3, 1)), "Sheet2!B1+B4");
    assert_eq!(relocate("'Sheet1'!B1", (0, 1, 0, 1), (3, 1)), "'Sheet1'!B4");
    assert_eq!(relocate("\"B1\"&B1", (0, 1, 0, 1), (3, 1)), "\"B1\"&B4", "text is not a reference");
    // On another sheet, only a reference qualified with the moved sheet moves.
    assert_eq!(
        relocate_across("B1+Sheet1!B1", "Sheet2", "Sheet2", "Sheet1", (0, 1, 0, 1), "Sheet1", (3, 1)),
        "B1+Sheet1!B4"
    );
}

// ---------------------------------------------------------------------------
// 6. A reference to a cell the move OVERWROTE is #REF! [LIVE]
// ---------------------------------------------------------------------------

#[test]
fn a_reference_to_a_cell_the_move_overwrote_is_ref_error_like_excel() {
    // (formula, cut block, destination, Excel's result) -- measured over COM,
    // Excel 16, 2026-10-29 (cutpaste/probe-xsheet.ps1, probe-more.ps1).
    let a = |r: u32, c: u32| (r, c);
    let cases: &[(&str, (u32, u32, u32, u32), (u32, u32), &str)] = &[
        // A10:A11 cut onto C10:C11.
        ("C10", (9, 0, 10, 0), a(9, 2), "#REF!"),
        ("SUM(C9:C11)", (9, 0, 10, 0), a(9, 2), "SUM(C9:C11)"),
        ("SUM(C10:C11)", (9, 0, 10, 0), a(9, 2), "SUM(#REF!)"),
        ("SUM(C10:C12)", (9, 0, 10, 0), a(9, 2), "SUM(C10:C12)"),
        ("SUM(C11:C11)", (9, 0, 10, 0), a(9, 2), "SUM(#REF!)"),
        ("$C$11*2", (9, 0, 10, 0), a(9, 2), "#REF!*2"),
        ("C10+A10", (9, 0, 10, 0), a(9, 2), "#REF!+C10"),
        ("SUM(B10:C11)", (9, 0, 10, 0), a(9, 2), "SUM(B10:C11)"),
        ("Sheet1!C10", (9, 0, 10, 0), a(9, 2), "#REF!"),
        ("Sheet2!C10", (9, 0, 10, 0), a(9, 2), "Sheet2!C10"),
        // An overlapping move, A1:A3 cut onto A2:A4: only A4 was overwritten.
        ("A4", (0, 0, 2, 0), a(1, 0), "#REF!"),
        ("A2", (0, 0, 2, 0), a(1, 0), "A3"),
        ("SUM(A1:A3)", (0, 0, 2, 0), a(1, 0), "SUM(A2:A4)"),
        ("SUM(A1:A4)", (0, 0, 2, 0), a(1, 0), "SUM(A2:A4)"),
        // The moved formula itself, landing on the cell it read (A1 =C1 cut to C1).
        ("C1", (0, 0, 0, 0), a(0, 2), "#REF!"),
    ];
    let mut wrong = Vec::new();
    for &(f, block, to, expected) in cases {
        let got = relocate(f, block, to);
        if got != expected {
            wrong.push(format!("{} cut {:?} to {:?}: got {}, Excel {}", f, block, to, got, expected));
        }
    }
    assert!(
        wrong.is_empty(),
        "a reference to an OVERWRITTEN cell disagrees with Excel:\n  {}",
        wrong.join("\n  ")
    );
}

#[test]
fn a_formula_reading_an_overwritten_cell_shows_ref_error_after_the_move() {
    // Excel [LIVE]: A10=5, A11=6 cut onto C10 (C10 held 9): E1 =C10 -> =#REF!,
    // E2 =SUM(C9:C11) keeps its address (and now sums the moved 5 and 6), a
    // name on C10 -> #REF!, and E3 =C12 (beside the destination) is untouched.
    let wb = workbook(1);
    wb.set(9, 0, "5"); // A10
    wb.set(10, 0, "6"); // A11
    wb.set(9, 2, "9"); // C10
    wb.set(11, 2, "4"); // C12
    wb.set(0, 4, "=C10"); // E1
    wb.set(1, 4, "=SUM(C9:C11)"); // E2
    wb.set(2, 4, "=C12"); // E3
    define_name(&wb, "Dst", "=Sheet1!$C$10");
    assert_eq!(wb.number(0, 0, 4), 9.0, "setup");

    drag_move(&wb, (9, 0, 10, 0), (9, 2));

    assert_eq!(
        formula(&wb, 0, 0, 4),
        "#REF!",
        "a reference to the cell the move OVERWROTE kept naming it and silently \
         read the moved value -- Excel makes it #REF!"
    );
    assert_eq!(wb.value(0, 0, 4), CellValue::Error(CellError::Ref));
    assert_eq!(formula(&wb, 0, 1, 4), "SUM(C9:C11)", "a range only partly overwritten keeps its address");
    assert_eq!(wb.number(0, 1, 4), 11.0);
    assert_eq!(formula(&wb, 0, 2, 4), "C12");
    assert_eq!(refers_to(&wb, "Dst"), "=#REF!", "a name on the overwritten cell is #REF! too");
}

#[test]
fn undo_puts_back_a_reference_the_move_turned_into_ref_error() {
    let wb = workbook(1);
    wb.set(9, 0, "5"); // A10
    wb.set(9, 2, "9"); // C10
    wb.set(0, 4, "=C10"); // E1
    drag_move(&wb, (9, 0, 9, 0), (9, 2));
    assert_eq!(formula(&wb, 0, 0, 4), "#REF!", "setup");

    undo_once(&wb);

    assert_eq!(formula(&wb, 0, 0, 4), "C10");
    assert_eq!(wb.number(0, 0, 4), 9.0);
}

// ---------------------------------------------------------------------------
// 7. A move BETWEEN sheets: the rewriter, rule by rule [LIVE]
// ---------------------------------------------------------------------------

/// `formula`, living on `home` and read against `read`, after `block` on
/// `from` is cut to `to` on sheet `onto`.
fn relocate_across(
    formula: &str,
    read: &str,
    home: &str,
    from: &str,
    block: (u32, u32, u32, u32),
    onto: &str,
    to: (u32, u32),
) -> String {
    let mv = CellMove {
        source_sheet: from,
        dest_sheet: onto,
        block,
        delta_row: to.0 as i32 - block.0 as i32,
        delta_col: to.1 as i32 - block.1 as i32,
    };
    relocate_references_for_move(formula, read, home, &mv)
}

#[test]
fn a_range_on_the_source_sheet_follows_or_shrinks_the_way_excel_moves_it_off_the_sheet() {
    // Every row measured over COM, Excel 16, 2026-10-29: Sheet1's block cut to
    // Sheet2!C1, the formula on Sheet1 (cutpaste/probe-xsheet.ps1,
    // probe-more.ps1, probe-strips.ps1).
    let a1_a3 = (0, 0, 2, 0);
    let a1_b1 = (0, 0, 0, 1);
    let a4_a5 = (3, 0, 4, 0);
    let d1_e1 = (0, 3, 0, 4);
    let cases: &[(&str, (u32, u32, u32, u32), &str)] = &[
        // The block takes the BOTTOM / RIGHT strip of the range.
        ("SUM(A1:A5)", a4_a5, "SUM(A1:A3)"),
        ("SUM(A2:A4)", a4_a5, "SUM(A2:A3)"),
        ("SUM(A1:B5)", a4_a5, "SUM(A1:B5)"),
        ("SUM(A1:E1)", d1_e1, "SUM(A1:C1)"),
        ("SUM(B1:D1)", d1_e1, "SUM(B1:C1)"),
        ("SUM(A1:E2)", d1_e1, "SUM(A1:E2)"),
        // The block takes the TOP / LEFT strip, or the whole range.
        ("SUM(A1:A3)", a1_a3, "SUM(Sheet2!C1:C3)"),
        ("SUM(A1:A2)", a1_a3, "SUM(Sheet2!C1:C2)"),
        ("SUM(A2:A3)", a1_a3, "SUM(Sheet2!C2:C3)"),
        ("SUM(A1:A4)", a1_a3, "SUM(A4:A4)"),
        ("SUM(A2:A4)", a1_a3, "SUM(A4:A4)"),
        ("SUM(A3:A5)", a1_a3, "SUM(A4:A5)"),
        ("SUM(A1:A5)", a1_a3, "SUM(A4:A5)"),
        ("SUM(A3:A9)", a1_a3, "SUM(A4:A9)"),
        ("SUM(A1:C1)", a1_a3, "SUM(B1:C1)"),
        ("SUM(A1:B4)", a1_a3, "SUM(A1:B4)"),
        ("SUM(A1:D1)", a1_b1, "SUM(C1:D1)"),
        ("SUM(B1:D1)", a1_b1, "SUM(C1:D1)"),
        ("SUM(A1:B2)", a1_b1, "SUM(A2:B2)"),
        ("SUM(A1:A1)", a1_b1, "SUM(Sheet2!C1:C1)"),
        ("SUM(B1:B2)", a1_b1, "SUM(B2:B2)"),
    ];
    let mut wrong = Vec::new();
    for &(f, block, expected) in cases {
        let got = relocate_across(f, "Sheet1", "Sheet1", "Sheet1", block, "Sheet2", (0, 2));
        if got != expected {
            wrong.push(format!("{} with {:?} cut to Sheet2!C1: got {}, Excel {}", f, block, got, expected));
        }
    }
    assert!(wrong.is_empty(), "the off-sheet range rule disagrees with Excel:\n  {}", wrong.join("\n  "));
}

#[test]
fn single_references_follow_the_block_to_the_other_sheet_like_excel() {
    let a1_a2 = (0, 0, 1, 0);
    // Excel [LIVE]: Sheet1!A1:A2 cut to Sheet2!D4.
    assert_eq!(relocate_across("A1*2", "Sheet1", "Sheet1", "Sheet1", a1_a2, "Sheet2", (3, 3)), "Sheet2!D4*2");
    assert_eq!(relocate_across("Sheet1!A2", "Sheet1", "Sheet1", "Sheet1", a1_a2, "Sheet2", (3, 3)), "Sheet2!D5");
    assert_eq!(
        relocate_across("Sheet1!A1", "Sheet2", "Sheet2", "Sheet1", a1_a2, "Sheet2", (3, 3)),
        "Sheet2!D4",
        "Excel keeps the qualifier even on the sheet the block landed on"
    );
    assert_eq!(relocate_across("A1", "Sheet2", "Sheet2", "Sheet1", a1_a2, "Sheet2", (3, 3)), "A1", "Sheet2's own A1");
    assert_eq!(relocate_across("Sheet1!A2+1", "Sheet3", "Sheet3", "Sheet1", a1_a2, "Sheet2", (3, 3)), "Sheet2!D5+1");
    // A sheet name that needs quoting is quoted (Excel [LIVE]: ='My Data'!B2).
    assert_eq!(relocate_across("A1", "Sheet1", "Sheet1", "Sheet1", a1_a2, "My Data", (1, 1)), "'My Data'!B2");
    // Back onto the sheet whose cells they read (Sheet2!A1:A2 cut to Sheet1!B5).
    assert_eq!(relocate_across("Sheet2!A1", "Sheet1", "Sheet1", "Sheet2", a1_a2, "Sheet1", (4, 1)), "Sheet1!B5");
}

#[test]
fn a_formula_the_move_carried_to_another_sheet_keeps_reading_its_old_sheets_cells() {
    // Excel [LIVE]: Sheet1!A1:A2 cut to Sheet2!E1.
    let a1_a2 = (0, 0, 1, 0);
    assert_eq!(
        relocate_across("Sheet2!B1+B1+SUM(C1:C2)+$D$1", "Sheet1", "Sheet2", "Sheet1", a1_a2, "Sheet2", (0, 4)),
        "Sheet2!B1+Sheet1!B1+SUM(Sheet1!C1:C2)+Sheet1!$D$1",
        "a moved formula's references OUTSIDE the block must keep naming the source sheet's cells"
    );
    assert_eq!(
        relocate_across("A1+Sheet3!A1", "Sheet1", "Sheet2", "Sheet1", a1_a2, "Sheet2", (0, 4)),
        "E1+Sheet3!A1",
        "a reference INTO the block follows it, unqualified on the sheet the formula now lives on"
    );
    // Whole lines too (Excel [LIVE]: moved to 'My Data'!B2).
    assert_eq!(
        relocate_across("SUM(B:B)+SUM(3:3)+A1", "Sheet1", "My Data", "Sheet1", a1_a2, "My Data", (1, 1)),
        "SUM(Sheet1!B:B)+SUM(Sheet1!3:3)+B2"
    );
    // Back onto the sheet it read (Sheet2!A2 =A1+Sheet1!B1 cut to Sheet1!B6).
    assert_eq!(
        relocate_across("A1+Sheet1!B1", "Sheet2", "Sheet1", "Sheet2", a1_a2, "Sheet1", (4, 1)),
        "B5+Sheet1!B1"
    );
}

#[test]
fn a_reference_to_a_cell_overwritten_on_the_destination_sheet_is_ref_error() {
    // Excel [LIVE]: Sheet1!A1:A2 cut onto Sheet2!D4:D5.
    let a1_a2 = (0, 0, 1, 0);
    let on_sheet2 = |f: &str| relocate_across(f, "Sheet2", "Sheet2", "Sheet1", a1_a2, "Sheet2", (3, 3));
    assert_eq!(on_sheet2("D4"), "#REF!");
    assert_eq!(on_sheet2("SUM(D3:D5)"), "SUM(D3:D5)");
    assert_eq!(on_sheet2("SUM(D4:D4)"), "SUM(#REF!)");
    // Excel writes Sheet2!#REF!, which does not parse here; the value is the same.
    assert_eq!(on_sheet2("Sheet2!D4+SUM(Sheet2!D4:D5)"), "#REF!+SUM(#REF!)");
    assert_eq!(relocate_across("Sheet2!D4:D4", "Sheet1", "Sheet1", "Sheet1", a1_a2, "Sheet2", (3, 3)), "#REF!");
    assert_eq!(
        relocate_across("D4", "Sheet1", "Sheet1", "Sheet1", a1_a2, "Sheet2", (3, 3)),
        "D4",
        "Sheet1's D4 was not overwritten"
    );
}

// ---------------------------------------------------------------------------
// 8. Cut on one sheet, Paste on another -- through the real bodies
// ---------------------------------------------------------------------------

/// A Cut of `(r0, c0)..=(r1, c1)` on sheet `from` pasted at `(tr, tc)` on
/// sheet `onto`, exactly as `useClipboard.paste` now performs it: with `onto`
/// active, the cut cells are written UNSHIFTED by one batch, the source is
/// cleared on ITS OWN sheet by one sheet-addressed `clear_range_with_options`,
/// and the relocation is told the source sheet -- all in one undo step.
fn cut_paste_across(
    wb: &Workbook,
    from: usize,
    (r0, c0, r1, c1): (u32, u32, u32, u32),
    onto: usize,
    (tr, tc): (u32, u32),
) {
    let mut writes = Vec::new();
    for r in r0..=r1 {
        for c in c0..=c1 {
            writes.push((tr + (r - r0), tc + (c - c0), input_on(wb, from, r, c)));
        }
    }
    wb.switch_to(onto);
    wb.state.undo_stack.lock().unwrap().begin_transaction("Cut and paste");
    batch(wb, &writes);
    clear_range_with_options_inner(
        &wb.state,
        &wb.file,
        &wb.files,
        &wb.pivots,
        &wb.pane,
        &wb.filters,
        ClearRangeParams {
            start_row: r0,
            start_col: c0,
            end_row: r1,
            end_col: c1,
            apply_to: ClearApplyTo::All,
            sheet_index: Some(from),
            target: None,
        },
    )
    .expect("the source clears on its own sheet");
    relocate_cell_references_core(
        &wb.state, &wb.file, &wb.files, &wb.pivots, &wb.pane, &wb.filters, r0, c0, r1, c1, tr, tc, Some(from),
    )
    .expect("the relocation runs");
    wb.state.undo_stack.lock().unwrap().commit_transaction();
}

#[test]
fn a_cut_pasted_on_another_sheet_moves_the_cells_and_every_reference_follows() {
    // Excel [LIVE, cutpaste/probe-xsheet.ps1 xsheet_basic]: Sheet1!A1:A2 =
    // (7, =A1+B5) cut to Sheet2!D4.
    let wb = workbook(3);
    wb.set(4, 1, "1"); // Sheet1!B5
    wb.set(0, 0, "7"); // Sheet1!A1
    wb.set(1, 0, "=A1+B5"); // Sheet1!A2
    wb.set(0, 1, "=A1*2"); // Sheet1!B1
    wb.set(1, 1, "=Sheet1!A2"); // Sheet1!B2
    define_name(&wb, "MyName", "=Sheet1!$A$1");
    wb.switch_to(1);
    wb.set(0, 0, "100"); // Sheet2!A1
    wb.set(0, 2, "=Sheet1!A1"); // Sheet2!C1
    wb.set(1, 2, "=A1"); // Sheet2!C2
    wb.switch_to(2);
    wb.set(0, 0, "=Sheet1!A2+1"); // Sheet3!A1
    wb.switch_to(0);
    assert_eq!(wb.number(0, 1, 0), 8.0, "setup");

    cut_paste_across(&wb, 0, (0, 0, 1, 0), 1, (3, 3));

    // The cells moved: gone from Sheet1, on Sheet2.
    assert_eq!(wb.value(0, 0, 0), CellValue::Empty, "the source is cleared on ITS sheet");
    assert_eq!(formula(&wb, 0, 1, 0), "");
    assert_eq!(wb.value(1, 0, 0), CellValue::Number(100.0), "Sheet2!A1 -- the source's address there -- is untouched");
    assert_eq!(wb.number(1, 3, 3), 7.0);
    assert_eq!(
        formula(&wb, 1, 4, 3),
        "D4+SHEET1!B5",
        "the moved formula: its reference into the block follows it, the one outside keeps naming Sheet1's B5"
    );
    assert_eq!(wb.number(1, 4, 3), 8.0);
    // Every reference followed to the new sheet and address.
    assert_eq!(
        formula(&wb, 0, 0, 1),
        "SHEET2!D4*2",
        "a formula on the SOURCE sheet still names the emptied A1 -- a cut between sheets was never relocated"
    );
    assert_eq!(wb.number(0, 0, 1), 14.0);
    assert_eq!(formula(&wb, 0, 1, 1), "SHEET2!D5");
    assert_eq!(wb.number(0, 1, 1), 8.0);
    assert_eq!(formula(&wb, 1, 0, 2), "SHEET2!D4");
    assert_eq!(wb.number(1, 0, 2), 7.0);
    assert_eq!(formula(&wb, 1, 1, 2), "A1", "Sheet2's own A1 is not the moved cell");
    assert_eq!(formula(&wb, 2, 0, 0), "SHEET2!D5+1");
    assert_eq!(wb.number(2, 0, 0), 9.0);
    assert_eq!(refers_to(&wb, "MyName"), "=Sheet2!$D$4");
}

#[test]
fn a_range_on_the_source_sheet_shrinks_or_follows_when_its_cells_move_to_another_sheet() {
    // Excel [LIVE, xsheet_ranges]: Sheet1!A1:A3 cut to Sheet2!C1.
    let wb = workbook(2);
    for r in 0..5u32 {
        wb.set(r, 0, &(r + 1).to_string()); // A1:A5 = 1..5
    }
    wb.set(0, 3, "=SUM(A1:A3)"); // D1
    wb.set(1, 3, "=SUM(A1:A4)"); // D2
    wb.set(3, 3, "=SUM(A3:A5)"); // D4
    define_name(&wb, "Blk", "=Sheet1!$A$1:$A$3");

    cut_paste_across(&wb, 0, (0, 0, 2, 0), 1, (0, 2));

    assert_eq!(formula(&wb, 0, 0, 3), "SUM(SHEET2!C1:C3)");
    assert_eq!(wb.number(0, 0, 3), 6.0);
    assert_eq!(formula(&wb, 0, 1, 3), "SUM(A4:A4)", "the moved part leaves the range");
    assert_eq!(wb.number(0, 1, 3), 4.0);
    assert_eq!(formula(&wb, 0, 3, 3), "SUM(A4:A5)");
    assert_eq!(wb.number(0, 3, 3), 9.0);
    assert_eq!(refers_to(&wb, "Blk"), "=Sheet2!$C$1:$C$3");
}

/// Pop one REDO transaction and apply it through the real restore, as the
/// `redo` command does (`cross_sheet_recalc_tests`' own twin is private).
fn redo_once(wb: &Workbook) {
    let transaction = wb.state.undo_stack.lock().unwrap().pop_redo().expect("nothing on the redo stack");
    crate::undo_commands::apply_changes(
        &wb.state, &wb.file, &wb.files, &wb.pivots, &wb.slicer, &wb.filters, &wb.pane, &wb.timelines, transaction,
        false,
    );
}

/// rev6A#9. Undo restores Sheet1!B1 as `{=A1*2, cached 0}` -- it was recorded
/// after the source clear had recalculated it -- and Sheet2!E1 as `{=D4, cached
/// 7}`: only the cascades after the restore make them 14 and 9 again, so the
/// VALUES are pinned here, not just the formula text. A redo puts the move back,
/// and a third sheet and a defined name ride the same undo/redo pair.
#[test]
fn undoing_a_cut_pasted_on_another_sheet_puts_everything_back() {
    let wb = workbook(3);
    wb.set(0, 0, "7"); // Sheet1!A1
    wb.set(0, 1, "=A1*2"); // Sheet1!B1
    define_name(&wb, "MyName", "=Sheet1!$A$1");
    wb.switch_to(1);
    wb.set(3, 3, "9"); // Sheet2!D4, overwritten by the paste
    wb.set(0, 4, "=D4"); // Sheet2!E1
    wb.switch_to(2);
    wb.set(0, 0, "=Sheet1!A1+1"); // Sheet3!A1
    wb.set(0, 1, "=MyName*10"); // Sheet3!B1
    wb.switch_to(0);

    cut_paste_across(&wb, 0, (0, 0, 0, 0), 1, (3, 3));
    assert_eq!(formula(&wb, 0, 0, 1), "SHEET2!D4*2", "setup: re-pointed");
    assert_eq!(formula(&wb, 1, 0, 4), "#REF!", "setup: the overwritten D4's reader");
    assert_eq!(formula(&wb, 2, 0, 0), "SHEET2!D4+1", "setup: the third sheet re-pointed");
    assert_eq!(refers_to(&wb, "MyName"), "=Sheet2!$D$4", "setup: the name re-pointed");

    undo_once(&wb);

    assert_eq!(wb.number(0, 0, 0), 7.0, "the source comes back");
    assert_eq!(formula(&wb, 0, 0, 1), "A1*2", "the source sheet's formula comes back");
    assert_eq!(
        wb.number(0, 0, 1),
        14.0,
        "and its VALUE: it was restored with the 0 it held after the source clear"
    );
    assert_eq!(formula(&wb, 1, 0, 4), "D4");
    assert_eq!(wb.number(1, 0, 4), 9.0, "re-derived from the restored D4, not the 7 it was recorded with");
    assert_eq!(wb.number(1, 3, 3), 9.0, "the overwritten cell comes back");
    assert_eq!(formula(&wb, 2, 0, 0), "SHEET1!A1+1", "the third sheet's formula comes back");
    assert_eq!(wb.number(2, 0, 0), 8.0);
    assert_eq!(refers_to(&wb, "MyName"), "=Sheet1!$A$1", "the name comes back");
    assert_eq!(wb.number(2, 0, 1), 70.0, "the name's reader reads the restored A1");

    redo_once(&wb);

    assert_eq!(wb.value(0, 0, 0), CellValue::Empty, "redo moves the cell again");
    assert_eq!(wb.number(1, 3, 3), 7.0);
    assert_eq!(formula(&wb, 0, 0, 1), "SHEET2!D4*2", "redo re-points the source sheet's reader");
    assert_eq!(wb.number(0, 0, 1), 14.0);
    assert_eq!(formula(&wb, 1, 0, 4), "#REF!", "and the overwritten D4's reader is #REF! again");
    assert_eq!(wb.value(1, 0, 4), CellValue::Error(CellError::Ref));
    assert_eq!(formula(&wb, 2, 0, 0), "SHEET2!D4+1");
    assert_eq!(wb.number(2, 0, 0), 8.0);
    assert_eq!(refers_to(&wb, "MyName"), "=Sheet2!$D$4");
    assert_eq!(wb.number(2, 0, 1), 70.0);
}

// ---------------------------------------------------------------------------
// 9. An OVERLAPPING move shrinks a range by the strip it overwrote [LIVE]
// ---------------------------------------------------------------------------

#[test]
fn a_range_an_overlapping_move_partly_overwrote_shrinks_like_excel() {
    // (formula, cut block, destination, Excel's result) -- measured over COM,
    // Excel 16, 2026-10-29 (relocate/probe1.ps1 'overlap', probe2.ps1
    // 'overlap2'). The range loses the strip the move overwrote on the far
    // side of the block, along the axis it moved -- and only when the block
    // lands partly on itself.
    let a = |r: u32, c: u32| (r, c);
    let cases: &[(&str, (u32, u32, u32, u32), (u32, u32), &str)] = &[
        // A1:A3 cut onto A2:A4 (and its relatives): the strip goes.
        ("SUM(A4:A5)", (0, 0, 2, 0), a(1, 0), "SUM(A5:A5)"),
        ("SUM($A$4:$A$5)", (0, 0, 2, 0), a(1, 0), "SUM($A$5:$A$5)"),
        ("SUM(A4:A6)", (0, 0, 2, 0), a(2, 0), "SUM(A6:A6)"),
        ("SUM(A4:A9)", (0, 0, 2, 0), a(2, 0), "SUM(A6:A9)"),
        ("SUM(A5:A6)", (0, 0, 2, 0), a(2, 0), "SUM(A6:A6)"),
        ("SUM(A4:A5)", (1, 0, 2, 0), a(2, 0), "SUM(A5:A5)"),
        ("SUM(B4:B5)", (0, 1, 2, 1), a(1, 1), "SUM(B5:B5)"),
        ("SUM(A4:A5)", (0, 0, 2, 1), a(1, 0), "SUM(A5:A5)"),
        ("SUM(A4:B5)", (0, 0, 2, 1), a(1, 0), "SUM(A5:B5)"),
        // Upward and sideways.
        ("SUM(A1:A3)", (3, 0, 5, 0), a(2, 0), "SUM(A1:A2)"),
        ("SUM(C1:C3)", (3, 2, 5, 2), a(2, 2), "SUM(C1:C2)"),
        ("SUM(C1:D3)", (3, 2, 5, 3), a(2, 2), "SUM(C1:D2)"),
        ("SUM(D1:F1)", (0, 0, 0, 2), a(0, 1), "SUM(E1:F1)"),
        // Diagonal: A1:B3 cut onto B2:C4.
        ("SUM(C3:C5)", (0, 0, 2, 1), a(1, 1), "SUM(C5:C5)"),
        // A corner IN the block follows it (relocated_range), bounded.
        ("SUM(A3:A5)", (0, 0, 2, 0), a(1, 0), "SUM(A4:A5)"),
        ("SUM(A3:A6)", (0, 0, 2, 0), a(1, 0), "SUM(A4:A6)"),
        ("SUM(A2:A4)", (0, 0, 2, 0), a(1, 0), "SUM(A3:A4)"),
        ("SUM(A6:A8)", (0, 0, 5, 0), a(1, 0), "SUM(A7:A8)"),
        ("SUM(A1:A2)", (1, 0, 2, 0), a(0, 0), "SUM(A1:A1)"),
        ("SUM(A1:A3)", (2, 0, 4, 0), a(0, 0), "SUM(A1:A2)"),
        ("SUM(A4:A5)", (1, 0, 3, 0), a(2, 0), "SUM(A5:A5)"),
        // Unchanged: the block does not land on itself...
        ("SUM(A10:A12)", (0, 0, 1, 0), a(9, 0), "SUM(A10:A12)"),
        ("SUM(A4:A6)", (1, 0, 2, 0), a(3, 0), "SUM(A4:A6)"),
        ("SUM(A1:A3)", (3, 0, 4, 0), a(1, 0), "SUM(A1:A3)"),
        ("SUM(C10:E10)", (9, 0, 9, 1), a(9, 2), "SUM(C10:E10)"),
        // ...the strip is on the near side (the range spans the block)...
        ("SUM(A1:A5)", (1, 0, 2, 0), a(2, 0), "SUM(A1:A5)"),
        ("SUM(A1:A4)", (1, 0, 2, 0), a(2, 0), "SUM(A1:A4)"),
        ("SUM(A3:A6)", (3, 0, 4, 0), a(2, 0), "SUM(A3:A6)"),
        // ...across the move, or only partly overwritten.
        ("SUM(C4:C6)", (3, 0, 3, 1), a(3, 1), "SUM(C4:C6)"),
        ("SUM(A4:B5)", (0, 0, 2, 0), a(1, 0), "SUM(A4:B5)"),
        ("SUM(C1:D3)", (3, 2, 5, 2), a(2, 2), "SUM(C1:D3)"),
    ];
    let mut wrong = Vec::new();
    for &(f, block, to, expected) in cases {
        let got = relocate(f, block, to);
        if got != expected {
            wrong.push(format!("{} cut {:?} to {:?}: got {}, Excel {}", f, block, to, got, expected));
        }
    }
    assert!(
        wrong.is_empty(),
        "a range an overlapping move partly overwrote disagrees with Excel:\n  {}",
        wrong.join("\n  ")
    );
}

// ---------------------------------------------------------------------------
// 10. WHOLE COLUMNS and WHOLE ROWS follow a move of whole lines [LIVE]
// ---------------------------------------------------------------------------

const LAST_ROW: u32 = engine::EXCEL_MAX_ROW_INDEX;
const LAST_COL: u32 = engine::EXCEL_MAX_COL_INDEX;

/// Columns `c0..=c1` moved to start at column `tc` -- the block
/// `useClipboard.moveColumns` hands the relocation.
fn columns(c0: u32, c1: u32) -> (u32, u32, u32, u32) {
    (0, c0, LAST_ROW, c1)
}

/// Rows `r0..=r1` -- the block `useClipboard.moveRows` hands the relocation.
fn rows(r0: u32, r1: u32) -> (u32, u32, u32, u32) {
    (r0, 0, r1, LAST_COL)
}

#[test]
fn whole_lines_follow_a_move_of_whole_lines_the_way_excel_moves_them() {
    // (formula, cut block, destination, Excel's result) -- measured over COM,
    // Excel 16, 2026-10-29 (relocate/probe1.ps1 'wholecols' / 'wholerows').
    let a = |r: u32, c: u32| (r, c);
    let cases: &[(&str, (u32, u32, u32, u32), (u32, u32), &str)] = &[
        ("SUM(A:A)", columns(0, 1), a(0, 3), "SUM(D:D)"),
        ("SUM(A:B)", columns(0, 1), a(0, 3), "SUM(D:E)"),
        ("SUM($A:$A)", columns(0, 0), a(0, 3), "SUM($D:$D)"),
        ("SUM(A:A)+A1", columns(0, 0), a(0, 3), "SUM(D:D)+D1"),
        ("SUM(A:A)+COUNTIF(A:A,A2)", columns(0, 1), a(0, 3), "SUM(D:D)+COUNTIF(D:D,D2)"),
        // One edge, the way a cell range's corner follows.
        ("SUM(A:C)", columns(0, 1), a(0, 4), "SUM(A:C)"),
        ("SUM(A:C)", columns(2, 2), a(0, 4), "SUM(A:E)"),
        ("SUM(A:E)", columns(4, 4), a(0, 1), "SUM(A:D)"),
        ("SUM(B:D)", columns(1, 1), a(0, 2), "SUM(C:D)"),
        // Overwritten, wholly or as an overlapping move's strip, or partly.
        ("SUM(D:D)", columns(0, 0), a(0, 3), "SUM(#REF!)"),
        ("SUM(D:E)", columns(0, 2), a(0, 1), "SUM(E:E)"),
        ("SUM(C:F)", columns(0, 1), a(0, 3), "SUM(C:F)"),
        // A move of columns never touches a whole ROW.
        ("SUM(1:1)", columns(0, 0), a(0, 2), "SUM(1:1)"),
        // Rows.
        ("SUM(1:1)", rows(0, 1), a(9, 0), "SUM(10:10)"),
        ("SUM($1:$1)", rows(0, 0), a(6, 0), "SUM($7:$7)"),
        ("SUM(1:3)", rows(2, 2), a(5, 0), "SUM(1:6)"),
        ("SUM(1:5)", rows(4, 4), a(1, 0), "SUM(1:4)"),
        ("SUM(2:2)", rows(0, 0), a(1, 0), "SUM(#REF!)"),
        ("SUM(4:5)", rows(0, 2), a(1, 0), "SUM(5:5)"),
        ("SUM(A:A)", rows(0, 1), a(9, 0), "SUM(A:A)"),
        // A move of CELLS never changes a whole line.
        ("SUM(A:A)", (0, 0, 2, 0), a(0, 2), "SUM(A:A)"),
        ("SUM(A:A)", (0, 0, 0, 0), a(4, 0), "SUM(A:A)"),
        ("SUM(1:1)", (0, 0, 0, 0), a(4, 0), "SUM(1:1)"),
    ];
    let mut wrong = Vec::new();
    for &(f, block, to, expected) in cases {
        let got = relocate(f, block, to);
        if got != expected {
            wrong.push(format!("{} cut {:?} to {:?}: got {}, Excel {}", f, block, to, got, expected));
        }
    }
    assert!(
        wrong.is_empty(),
        "a whole-line reference disagrees with Excel's move:\n  {}",
        wrong.join("\n  ")
    );

    // On another sheet, and between sheets (Excel [LIVE, 'wholecols-moved',
    // 'xsheet-lines']).
    assert_eq!(
        relocate_across("SUM(Sheet1!A:A)+SUM(A:A)", "Sheet2", "Sheet2", "Sheet1", columns(0, 0), "Sheet1", (0, 3)),
        "SUM(Sheet1!D:D)+SUM(A:A)"
    );
    let cut_to_sheet2 = |f: &str| relocate_across(f, "Sheet1", "Sheet1", "Sheet1", columns(0, 0), "Sheet2", (0, 3));
    assert_eq!(cut_to_sheet2("SUM(A:A)"), "SUM(Sheet2!D:D)");
    assert_eq!(cut_to_sheet2("SUM(A:B)"), "SUM(B:B)");
    assert_eq!(cut_to_sheet2("SUM(1:1)"), "SUM(1:1)");
}

/// A MOVE OF WHOLE COLUMNS `c0..=c1` to start at column `tc`, as
/// `useClipboard.moveColumns` performs it on the active sheet: every stored
/// cell of the source columns is written UNSHIFTED to the target columns, the
/// source cells the target does not cover are cleared, and the relocation runs
/// over the whole-column block -- one undo step.
fn move_columns(wb: &Workbook, c0: u32, c1: u32, tc: u32) {
    let active = *wb.state.active_sheet.read().unwrap();
    let cells: Vec<(u32, u32)> = {
        let grids = wb.state.grids.read().unwrap();
        let mut keys: Vec<(u32, u32)> = grids[active].cells.keys().copied().filter(|&(_, c)| c >= c0 && c <= c1).collect();
        keys.sort_unstable();
        keys
    };
    let writes: Vec<(u32, u32, String)> =
        cells.iter().map(|&(r, c)| (r, tc + (c - c0), input_on(wb, active, r, c))).collect();
    let last = tc + (c1 - c0);
    let clears: Vec<(u32, u32, String)> =
        cells.iter().filter(|&&(_, c)| c < tc || c > last).map(|&(r, c)| (r, c, String::new())).collect();
    wb.state.undo_stack.lock().unwrap().begin_transaction("Move columns");
    batch(wb, &writes);
    batch(wb, &clears);
    relocate_cell_references_core(
        &wb.state, &wb.file, &wb.files, &wb.pivots, &wb.pane, &wb.filters, 0, c0, LAST_ROW, c1, 0, tc, None,
    )
    .expect("the relocation runs");
    wb.state.undo_stack.lock().unwrap().commit_transaction();
}

/// The row twin of [`move_columns`] (`useClipboard.moveRows`).
fn move_rows(wb: &Workbook, r0: u32, r1: u32, tr: u32) {
    let active = *wb.state.active_sheet.read().unwrap();
    let cells: Vec<(u32, u32)> = {
        let grids = wb.state.grids.read().unwrap();
        let mut keys: Vec<(u32, u32)> = grids[active].cells.keys().copied().filter(|&(r, _)| r >= r0 && r <= r1).collect();
        keys.sort_unstable();
        keys
    };
    let writes: Vec<(u32, u32, String)> =
        cells.iter().map(|&(r, c)| (tr + (r - r0), c, input_on(wb, active, r, c))).collect();
    let last = tr + (r1 - r0);
    let clears: Vec<(u32, u32, String)> =
        cells.iter().filter(|&&(r, _)| r < tr || r > last).map(|&(r, c)| (r, c, String::new())).collect();
    wb.state.undo_stack.lock().unwrap().begin_transaction("Move rows");
    batch(wb, &writes);
    batch(wb, &clears);
    relocate_cell_references_core(
        &wb.state, &wb.file, &wb.files, &wb.pivots, &wb.pane, &wb.filters, r0, 0, r1, LAST_COL, tr, 0, None,
    )
    .expect("the relocation runs");
    wb.state.undo_stack.lock().unwrap().commit_transaction();
}

#[test]
fn a_column_move_takes_the_whole_column_references_with_it() {
    // Excel [LIVE, relocate/probe1.ps1 'wholecols-moved']: with A:B moved to
    // D:E, B1 =SUM(A:A) and B2 =COUNTIF(A:A,A2) become E1 =SUM(D:D) and
    // E2 =COUNTIF(D:D,D2); C1 =SUM(A:B) outside the block becomes =SUM(D:E),
    // and Sheet2's =SUM(Sheet1!A:A) becomes =SUM(Sheet1!D:D).
    let wb = workbook(2);
    wb.set(0, 0, "5"); // A1
    wb.set(1, 0, "7"); // A2
    wb.set(2, 0, "7"); // A3
    wb.set(0, 1, "=SUM(A:A)"); // B1
    wb.set(1, 1, "=COUNTIF(A:A,A2)"); // B2
    wb.set(0, 2, "=SUM(A:B)"); // C1
    wb.switch_to(1);
    wb.set(0, 0, "=SUM(Sheet1!A:A)"); // Sheet2!A1
    wb.switch_to(0);
    assert_eq!(wb.number(0, 1, 1), 2.0, "setup");

    move_columns(&wb, 0, 1, 3);

    assert_eq!(
        formula(&wb, 0, 1, 4),
        "COUNTIF(D:D,D2)",
        "the moved formula's whole-column reference still names the EMPTIED column A"
    );
    assert_eq!(wb.number(0, 1, 4), 2.0, "and it counts the moved column, not an empty one");
    assert_eq!(formula(&wb, 0, 0, 4), "SUM(D:D)");
    assert_eq!(wb.number(0, 0, 4), 19.0);
    assert_eq!(formula(&wb, 0, 0, 2), "SUM(D:E)", "a whole-column reference outside the block follows too");
    assert_eq!(wb.number(0, 0, 2), 40.0);
    assert_eq!(formula(&wb, 1, 0, 0), "SUM(SHEET1!D:D)", "and one on another sheet");
    assert_eq!(wb.number(1, 0, 0), 19.0);
}

#[test]
fn a_row_move_takes_the_whole_row_references_with_it() {
    // Excel [LIVE, rev5A/probe-lines.ps1 'wholerows']: A1 = 5, A2 =SUM(1:1),
    // C20 =SUM(1:1); rows 1:2 moved to 10:11 give A11 =SUM(10:10) and
    // C20 =SUM(10:10).
    let wb = workbook(1);
    wb.set(0, 0, "5"); // A1
    wb.set(1, 0, "=SUM(1:1)"); // A2
    wb.set(19, 2, "=SUM(1:1)"); // C20

    move_rows(&wb, 0, 1, 9);

    assert_eq!(formula(&wb, 0, 10, 0), "SUM(10:10)", "the moved formula's whole-row reference stayed on row 1");
    assert_eq!(wb.number(0, 10, 0), 5.0);
    assert_eq!(formula(&wb, 0, 19, 2), "SUM(10:10)", "a whole-row reference outside the block follows too");
    assert_eq!(wb.number(0, 19, 2), 5.0);
}

// ---------------------------------------------------------------------------
// 11. A 3-D reference is never touched by a move [LIVE]
// ---------------------------------------------------------------------------

#[test]
fn a_3d_reference_is_left_alone_whichever_sheets_cells_move() {
    // Excel [LIVE, relocate/probe1.ps1 'threeD', rev5A/probe-move.ps1
    // 'threeD-last' / 'threeD-first']: =SUM(Sheet2:Sheet3!A1) stays as it is
    // when A1 of either end sheet is cut to A5, and so do its whole-column and
    // whole-row forms under a column or row move.
    for f in [
        "SUM(Sheet2:Sheet3!A1)",
        "SUM(SHEET2:SHEET3!A1:B2)",
        "SUM(Sheet2:Sheet3!$A$1)+Sheet3!A1",
        "SUM('Sheet 2:Sheet3'!A1)",
    ] {
        for moved in ["Sheet2", "Sheet3", "Sheet 2"] {
            let got = relocate_across(f, "Sheet1", "Sheet1", moved, (0, 0, 0, 0), moved, (4, 0));
            let expected = if moved == "Sheet3" && f.ends_with("+Sheet3!A1") {
                "SUM(Sheet2:Sheet3!$A$1)+Sheet3!A5".to_string()
            } else {
                f.to_string()
            };
            assert_eq!(got, expected, "{} with {}!A1 cut to A5", f, moved);
        }
    }
    let lines = "SUM(Sheet2:Sheet3!A:A)+SUM(Sheet2:Sheet3!1:1)";
    assert_eq!(relocate_across(lines, "Sheet1", "Sheet1", "Sheet3", columns(0, 0), "Sheet3", (0, 3)), lines);
    assert_eq!(relocate_across(lines, "Sheet1", "Sheet1", "Sheet3", rows(0, 0), "Sheet3", (8, 0)), lines);
    // A cut pasted ONTO the span's last sheet overwrote no cell of the span.
    assert_eq!(
        relocate_across("SUM(Sheet2:Sheet3!D4)", "Sheet1", "Sheet1", "Sheet1", (0, 0, 0, 0), "Sheet3", (3, 3)),
        "SUM(Sheet2:Sheet3!D4)"
    );
    // A formula the move carried to another sheet: the span keeps its sheets,
    // the plain reference gains its old sheet's name.
    assert_eq!(
        relocate_across("SUM(Sheet2:Sheet3!A:A)+B1", "Sheet1", "Sheet2", "Sheet1", (0, 0, 1, 0), "Sheet2", (0, 4)),
        "SUM(Sheet2:Sheet3!A:A)+Sheet1!B1"
    );
}

#[test]
fn moving_a_cell_on_either_end_sheet_of_a_3d_span_leaves_the_span_alone() {
    // Through the real batch + relocation core: Sheet1!H1 and a defined name
    // read Sheet2:Sheet3!A1; A1 is cut to A5 first on Sheet3, then on Sheet2.
    let wb = workbook(3);
    wb.set(0, 7, "=SUM(Sheet2:Sheet3!A1)"); // Sheet1!H1
    define_name(&wb, "Span", "=Sheet2:Sheet3!$A$1");
    wb.switch_to(2);
    wb.set(0, 0, "2"); // Sheet3!A1

    drag_move(&wb, (0, 0, 0, 0), (4, 0));

    assert_eq!(
        formula(&wb, 0, 0, 7),
        "SUM(SHEET2:SHEET3!A1)",
        "moving Sheet3's A1 re-pointed the 3-D span on Sheet1 -- it now also reads Sheet2's A5"
    );
    assert_eq!(refers_to(&wb, "Span"), "=Sheet2:Sheet3!$A$1", "and the name on the span");

    wb.switch_to(1);
    wb.set(0, 0, "1"); // Sheet2!A1
    drag_move(&wb, (0, 0, 0, 0), (4, 0));

    assert_eq!(formula(&wb, 0, 0, 7), "SUM(SHEET2:SHEET3!A1)");
    assert_eq!(refers_to(&wb, "Span"), "=Sheet2:Sheet3!$A$1");
}

// ---------------------------------------------------------------------------
// 12. Which other-sheet formulas a move reads at all
// ---------------------------------------------------------------------------

#[test]
fn only_a_formula_that_names_a_sheet_is_read_on_an_uninvolved_sheet() {
    use crate::commands::structure::names_a_sheet;
    let tree = |f: &str| parser::parse(f).unwrap_or_else(|e| panic!("{} does not parse: {:?}", f, e));
    for f in [
        "=Sheet1!A1+B2",
        "=SUM(Sheet1!A1:B2)",
        "=SUM('My Data'!A:A)",
        "=SUM(Sheet1!1:1)",
        "=SUM(Sheet2:Sheet3!A1)",
        "=IF(A1>0,LET(x,Sheet2!B1,x*2),0)",
        "=-Sheet1!A1",
    ] {
        assert!(names_a_sheet(&tree(f)), "{} names a sheet and must be read", f);
    }
    for f in ["=A1+B2", "=SUM(A:A)+SUM(1:1)", "=\"Sheet1!A1\"&A1", "=NOW()", "=SUM(A1:B2)*2"] {
        assert!(
            !names_a_sheet(&tree(f)),
            "{} names no sheet: a move on another sheet cannot change it, so it must not be rendered to text",
            f
        );
    }
}
