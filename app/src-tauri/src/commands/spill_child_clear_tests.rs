//! FILENAME: app/src-tauri/src/commands/spill_child_clear_tests.rs
//! PURPOSE: Delete / Clear Contents / Clear All over a SPILLED cell SKIPS the
//!          cell instead of refusing the gesture (rev-ui-2 / NEW-spill-child-clear).
//!
//! Excel 16 [LIVE, 2026-11-05, sheetspill/probe2.ps1], `=SEQUENCE(3)` in A1
//! (spilling A1:A3), 5 in C1 and 6 in C2:
//!   * ClearContents (and the Delete key) on A2 alone: nothing changes;
//!   * on A2:C2: C2 is emptied, the array stays;
//!   * on the two areas C1 and A2 (either order; A2:A3 with C1 too): C1 is
//!     emptied, the array stays;
//!   * on A1:A3, or A1 with C1: the origin goes and the array with it;
//!   * Clear (All) on A2: A2's FORMATS are cleared, its value stays;
//!   * a legacy CSE array's part is refused ("You can't change part of an
//!     array.") -- Calcula has no CSE arrays.
//! Calcula refused every one of the first four with "We can't delete this
//! value". Every test here starts from the asserted spill, and every write
//! goes through the real command body.
//! CONTEXT: A `#[path]` child of `data`, through the `cross_sheet_recalc_tests`
//!          `Workbook` harness, no Tauri runtime.

use super::cross_sheet_recalc_tests::Workbook;
use super::*;
use crate::api_types::ClearArea;
use engine::CellValue;

fn seed() -> crate::document_effect::DocumentEffect {
    crate::document_effect::test_seed_effect()
}

/// A1 `=SEQUENCE(3)` spilling A1:A3, C1 = 5, C2 = 6, on the active sheet.
fn spill_book() -> Workbook {
    let wb = Workbook::new(2);
    seed_spill(&wb, 0);
    wb
}

fn seed_spill(wb: &Workbook, sheet: usize) {
    wb.set(0, 0, "=SEQUENCE(3)");
    wb.set(0, 2, "5");
    wb.set(1, 2, "6");
    assert_eq!(
        spill_of(wb, sheet),
        Some(vec![(1, 0), (2, 0)]),
        "the precondition failed: A1 did not spill, so nothing below tests what it claims"
    );
}

fn spill_of(wb: &Workbook, sheet: usize) -> Option<Vec<(u32, u32)>> {
    wb.state.spill_ranges.read().unwrap().get(&(sheet, 0, 0)).cloned()
}

fn has_formula(wb: &Workbook, sheet: usize, row: u32, col: u32) -> bool {
    wb.state.grids.read().unwrap()[sheet]
        .get_cell(row, col)
        .is_some_and(|c| c.formula_string().is_some())
}

fn style_of(wb: &Workbook, row: u32, col: u32) -> usize {
    wb.state.grid.read().unwrap().get_cell(row, col).map(|c| c.style_index).unwrap_or(0)
}

/// Bold (row, col) on the active sheet, both mirrors.
fn embolden(wb: &Workbook, row: u32, col: u32) -> usize {
    let index = {
        let mut registry = wb.state.style_registry.write(&seed()).unwrap();
        let mut style = registry.default_style().clone();
        style.font.bold = true;
        registry.get_or_create_explicit(style)
    };
    for mirror in 0..2 {
        if mirror == 0 {
            let mut grid = wb.state.grid.write(&seed()).unwrap();
            let mut cell = grid.get_cell(row, col).cloned().unwrap_or_else(engine::Cell::new);
            cell.style_index = index;
            grid.set_cell(row, col, cell);
        } else {
            let mut grids = wb.state.grids.write(&seed()).unwrap();
            let mut cell = grids[0].get_cell(row, col).cloned().unwrap_or_else(engine::Cell::new);
            cell.style_index = index;
            grids[0].set_cell(row, col, cell);
        }
    }
    index
}

fn params(rect: (u32, u32, u32, u32), apply_to: ClearApplyTo, sheet_index: Option<usize>) -> ClearRangeParams {
    ClearRangeParams {
        start_row: rect.0,
        start_col: rect.1,
        end_row: rect.2,
        end_col: rect.3,
        apply_to,
        sheet_index,
        target: None,
    }
}

/// One area, the command's single-area body.
fn clear(wb: &Workbook, rect: (u32, u32, u32, u32), apply_to: ClearApplyTo) -> Result<ClearRangeResult, String> {
    clear_range_with_options_inner(&wb.state, &wb.file, &wb.files, &wb.pivots, &wb.pane, &wb.filters, params(rect, apply_to, None))
}

/// Several areas, as the gesture sends them (`first` + `more`).
fn clear_areas(
    wb: &Workbook,
    first: (u32, u32, u32, u32),
    more: &[(u32, u32, u32, u32)],
    apply_to: ClearApplyTo,
) -> Result<ClearRangeResult, String> {
    let more: Vec<ClearArea> = more
        .iter()
        .map(|&(r0, c0, r1, c1)| ClearArea { start_row: r0, start_col: c0, end_row: r1, end_col: c1 })
        .collect();
    clear_range_with_options_areas(&wb.state, &wb.file, &wb.files, &wb.pivots, &wb.pane, &wb.filters, params(first, apply_to, None), &more)
}

fn undo(wb: &Workbook) {
    let transaction = wb.state.undo_stack.lock().unwrap().pop_undo().expect("nothing to undo");
    crate::undo_commands::apply_changes(
        &wb.state, &wb.file, &wb.files, &wb.pivots, &wb.slicer, &wb.filters, &wb.pane, &wb.timeline,
        transaction, true,
    );
}

fn the_array_stands(wb: &Workbook, sheet: usize, what: &str) {
    assert!(has_formula(wb, sheet, 0, 0), "{what}: the origin's formula is gone");
    assert_eq!(spill_of(wb, sheet), Some(vec![(1, 0), (2, 0)]), "{what}: the spill map changed");
    for (row, n) in [(0u32, 1.0), (1, 2.0), (2, 3.0)] {
        assert_eq!(wb.value(sheet, row, 0), CellValue::Number(n), "{what}: A{} lost its spilled value", row + 1);
    }
}

#[test]
fn delete_on_a_spilled_cell_alone_changes_nothing_and_is_not_refused() {
    let wb = spill_book();
    let result = clear(&wb, (1, 0, 1, 0), ClearApplyTo::Contents);
    assert!(result.is_ok(), "Delete on the spilled A2 was refused ({:?}); Excel changes nothing", result.err());
    the_array_stands(&wb, 0, "Delete on A2");
    assert_eq!(wb.value(0, 0, 2), CellValue::Number(5.0), "C1 was touched");
}

#[test]
fn delete_across_a_spilled_cell_clears_the_rest_and_keeps_the_array() {
    let wb = spill_book();
    clear(&wb, (1, 0, 1, 2), ClearApplyTo::Contents).expect("Delete on A2:C2 was refused; Excel clears C2");
    assert_eq!(wb.value(0, 1, 2), CellValue::Empty, "C2 was not cleared");
    the_array_stands(&wb, 0, "Delete on A2:C2");
    assert_eq!(wb.value(0, 0, 2), CellValue::Number(5.0), "C1 (outside the rectangle) was touched");
}

#[test]
fn delete_over_the_origin_still_takes_the_whole_array() {
    // The control: the origin inside the selection releases the array.
    let wb = spill_book();
    clear(&wb, (0, 0, 2, 0), ClearApplyTo::Contents).expect("Delete on A1:A3");
    assert_eq!(spill_of(&wb, 0), None, "the array survived its origin");
    for row in 0..3u32 {
        assert_eq!(wb.value(0, row, 0), CellValue::Empty, "A{} kept a value", row + 1);
    }
}

#[test]
fn a_multi_area_delete_skips_the_spilled_area_and_clears_the_other() {
    for (first, more) in [
        ((0, 2, 0, 2), vec![(1, 0, 1, 0)]),
        ((1, 0, 1, 0), vec![(0, 2, 0, 2)]),
        ((1, 0, 2, 0), vec![(0, 2, 0, 2)]),
    ] {
        let wb = spill_book();
        let result = clear_areas(&wb, first, &more, ClearApplyTo::Contents);
        assert!(result.is_ok(), "{first:?} + {more:?} was refused ({:?}); Excel clears C1", result.err());
        assert_eq!(wb.value(0, 0, 2), CellValue::Empty, "{first:?} + {more:?}: C1 was not cleared");
        assert_eq!(wb.value(0, 1, 2), CellValue::Number(6.0), "{first:?} + {more:?}: C2 was touched");
        the_array_stands(&wb, 0, "multi-area Delete");
    }
}

#[test]
fn a_multi_area_delete_holding_the_origin_takes_the_array() {
    for (first, more) in [((0, 0, 0, 0), vec![(0, 2, 0, 2)]), ((1, 0, 2, 0), vec![(0, 0, 0, 0)])] {
        let wb = spill_book();
        clear_areas(&wb, first, &more, ClearApplyTo::Contents).expect("a delete holding the origin");
        assert_eq!(spill_of(&wb, 0), None, "{first:?} + {more:?}: the array survived its origin");
        for row in 0..3u32 {
            assert_eq!(wb.value(0, row, 0), CellValue::Empty, "{first:?} + {more:?}: A{} kept a value", row + 1);
        }
    }
}

#[test]
fn clear_all_on_a_spilled_cell_clears_its_formats_and_keeps_its_value() {
    let wb = spill_book();
    let bold = embolden(&wb, 1, 0);
    embolden(&wb, 1, 2);
    assert_eq!(style_of(&wb, 1, 0), bold, "fixture: A2 is bold");
    clear(&wb, (1, 0, 1, 2), ClearApplyTo::All).expect("Clear All on A2:C2 was refused; Excel clears C2 and A2's formats");
    assert_eq!(wb.value(0, 1, 2), CellValue::Empty, "C2 was not cleared");
    assert_eq!(style_of(&wb, 1, 2), 0, "C2 kept its format");
    assert_eq!(style_of(&wb, 1, 0), 0, "A2 kept its bold; Excel's Clear All clears a spilled cell's formats");
    the_array_stands(&wb, 0, "Clear All on A2:C2");
}

#[test]
fn undoing_a_clear_all_whose_other_area_held_the_origin_brings_the_array_back() {
    // A2:A3 (spilled, bold) and A1 (the origin) as two areas of Clear All: the
    // spilled cells go WITH the origin, so their own area must not record them
    // -- a restored literal in A2 would block the restored formula's re-spill.
    let wb = spill_book();
    embolden(&wb, 1, 0);
    embolden(&wb, 2, 0);
    clear_areas(&wb, (1, 0, 2, 0), &[(0, 0, 0, 0)], ClearApplyTo::All).expect("Clear All over the array and its origin");
    assert_eq!(spill_of(&wb, 0), None, "the array survived its origin");
    undo(&wb);
    the_array_stands(&wb, 0, "undo of Clear All over A2:A3 + A1");
}

#[test]
fn a_grouped_delete_skips_a_spilled_cell_on_the_other_sheet() {
    let wb = Workbook::new(2);
    wb.switch_to(1);
    seed_spill(&wb, 1);
    wb.switch_to(0);
    // MANUAL calculation: the background sheet is not re-evaluated after the
    // write, so a spilled value the clear wrongly emptied would STAY empty
    // (under automatic the re-spill would hide it).
    *wb.state.calculation_mode.lock().unwrap() = "manual".to_string();
    let written = clear_range_on_sheets_inner(
        &wb.state, &wb.file, &wb.files, &wb.pivots, &wb.pane, &wb.filters,
        &[0, 1],
        &[(1, 0, 1, 2)],
        ClearApplyTo::Contents,
    )
    .expect("a grouped Delete over A2:C2 was refused; Excel clears C2 on every sheet");
    assert_eq!(written, vec![1]);
    assert_eq!(wb.value(1, 1, 2), CellValue::Empty, "Sheet2!C2 was not cleared");
    the_array_stands(&wb, 1, "grouped Delete on A2:C2");
}

#[test]
fn an_off_sheet_clear_skips_a_spilled_cell_too() {
    let wb = Workbook::new(2);
    wb.switch_to(1);
    seed_spill(&wb, 1);
    wb.switch_to(0);
    // MANUAL calculation: the background sheet is not re-evaluated after the
    // write, so a spilled value the clear wrongly emptied would STAY empty
    // (under automatic the re-spill would hide it).
    *wb.state.calculation_mode.lock().unwrap() = "manual".to_string();
    let result = clear_range_with_options_inner(
        &wb.state, &wb.file, &wb.files, &wb.pivots, &wb.pane, &wb.filters,
        params((1, 0, 1, 2), ClearApplyTo::Contents, Some(1)),
    )
    .expect("an addressed clear of Sheet2!A2:C2 was refused");
    assert_eq!(wb.value(1, 1, 2), CellValue::Empty, "Sheet2!C2 was not cleared");
    // ONE cell cleared: C2. The spilled A2 is not touched at all (a clear that
    // emptied it too would count 2, and only the re-spill would hide it).
    assert_eq!(result.count, 1, "the off-sheet clear touched the spilled A2");
    the_array_stands(&wb, 1, "off-sheet clear of A2:C2");
}
