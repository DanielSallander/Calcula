//! FILENAME: app/src-tauri/src/commands/spill_batch_fill_tests.rs
//! PURPOSE: A batch write (a paste, a script's setValues, an MCP block write)
//! and a fill keep a dynamic array's ownership right, as Excel does.
//!
//! A child module of `commands::data` (declared with `#[path]` there), so it
//! drives the REAL batch body (`update_cells_batch_core`) with no Tauri runtime,
//! through the shared `cross_sheet_recalc_tests::Workbook` harness.
//!
//! THE DEFECTS THESE PIN.
//!
//!   1. A batch that wrote an array formula and then, LATER IN THE SAME BATCH,
//!      a literal inside the array's fresh spill lost the literal: the write
//!      loop spilled the formula at once, the literal landed under the array's
//!      claim, and the cascade's re-decision released the claim by ERASING the
//!      cell. Copy B1:B3 (`=SEQUENCE(3)` showing #SPILL!, blank, "x") and paste
//!      it at D1: "x" was gone and D1 showed 1, 2, 3. Excel [LIVE]: D1 #SPILL!,
//!      D3 "x".
//!   2. Pasting a BLANK over the cell that blocks an array left it #SPILL!:
//!      the array does not depend on its blocker, and the batch cascade passed
//!      no unblocked origins (a typed Delete did). Excel [LIVE] re-spills.
//!   3. Ctrl+D / Ctrl+R across an array copied its spilled values as LITERALS,
//!      so every filled origin was blocked by a copy of its own spill. Excel
//!      [LIVE] fills a spilled value as blank. `fill_range` takes Tauri `State`
//!      and cannot run in-process, so its source rule is pinned on the shared
//!      `fill_source_cells` plus a tripwire that both fill bodies use it.

use super::cross_sheet_recalc_tests::{body_of, Workbook};
use super::*;
use engine::{CellError, CellValue};

/// One sheet, en-US so the formulas read the same on every machine.
fn workbook() -> Workbook {
    let wb = Workbook::new(1);
    *wb.state.locale.lock().unwrap() = engine::LocaleSettings::from_locale_id("en-US");
    wb
}

/// A paste: ONE batch through the REAL batch body, in the order given.
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
            source: None,
        })
        .collect();
    update_cells_batch_core(
        &wb.state, &wb.file, &wb.files, &wb.pivots, updates, None, None, None, None,
    )
    .expect("the batch writes")
}

fn text(s: &str) -> CellValue {
    CellValue::Text(s.to_string())
}

/// The cells `spill_hosts` says the array at `origin` owns, sorted.
fn claimed_by(wb: &Workbook, origin: (u32, u32)) -> Vec<(u32, u32)> {
    let hosts = wb.state.spill_hosts.lock().unwrap();
    let mut cells: Vec<(u32, u32)> = hosts
        .iter()
        .filter(|(&(s, _, _), &o)| s == 0 && o == origin)
        .map(|(&(_, r, c), _)| (r, c))
        .collect();
    cells.sort_unstable();
    cells
}

/// `spill_ranges`' extent for the array at `origin`, sorted (empty: no entry).
fn extent_of(wb: &Workbook, origin: (u32, u32)) -> Vec<(u32, u32)> {
    let ranges = wb.state.spill_ranges.read().unwrap();
    let mut cells = ranges.get(&(0, origin.0, origin.1)).cloned().unwrap_or_default();
    cells.sort_unstable();
    cells
}

// ---------------------------------------------------------------------------
// 1. A literal written into a fresh spill of the same batch survives
// ---------------------------------------------------------------------------

#[test]
fn a_pasted_literal_inside_a_spill_the_same_paste_made_is_kept_and_the_array_is_spill_error() {
    let wb = workbook();
    // D1:D3 = the copy of B1:B3 (=SEQUENCE(3) blocked by "x"), in batch order.
    paste(&wb, &[(0, 3, "=SEQUENCE(3)"), (1, 3, ""), (2, 3, "x")]);

    assert_eq!(
        wb.value(0, 2, 3),
        text("x"),
        "the pasted literal in D3 was ERASED -- the cascade released D1's claim \
         over a cell this same paste had written"
    );
    assert_eq!(
        wb.value(0, 0, 3),
        CellValue::Error(CellError::Spill),
        "D1 must report #SPILL!: D3 holds the user's x (Excel [LIVE])"
    );
    assert_eq!(wb.value(0, 1, 3), CellValue::Empty, "D2 is the pasted blank");
    assert!(
        claimed_by(&wb, (0, 3)).is_empty() && extent_of(&wb, (0, 3)).is_empty(),
        "a blocked array claims nothing: hosts {:?}, extent {:?}",
        claimed_by(&wb, (0, 3)),
        extent_of(&wb, (0, 3))
    );
}

#[test]
fn a_literal_into_a_fresh_spill_with_no_blank_before_it_is_kept_too() {
    let wb = workbook();
    paste(&wb, &[(0, 3, "=SEQUENCE(3)"), (2, 3, "x")]);
    assert_eq!(wb.value(0, 2, 3), text("x"), "D3's literal was erased");
    assert_eq!(wb.value(0, 0, 3), CellValue::Error(CellError::Spill));
    assert_eq!(
        wb.value(0, 1, 3),
        CellValue::Empty,
        "D2 held D1's own spilled 2, which goes with the blocked array"
    );
    assert!(claimed_by(&wb, (0, 3)).is_empty() && extent_of(&wb, (0, 3)).is_empty());
}

#[test]
fn a_pasted_array_whose_spill_cells_the_paste_leaves_blank_still_spills() {
    // POSITIVE CONTROL: the claim is dropped for the blanks too, and the
    // cascade's re-decision spills back over them.
    let wb = workbook();
    paste(&wb, &[(0, 3, "=SEQUENCE(3)"), (1, 3, ""), (2, 3, "")]);
    assert_eq!(wb.value(0, 0, 3), CellValue::Number(1.0));
    assert_eq!(wb.value(0, 1, 3), CellValue::Number(2.0));
    assert_eq!(wb.value(0, 2, 3), CellValue::Number(3.0));
    assert_eq!(claimed_by(&wb, (0, 3)), vec![(1, 3), (2, 3)]);
    assert_eq!(extent_of(&wb, (0, 3)), vec![(1, 3), (2, 3)]);
}

// ---------------------------------------------------------------------------
// 2. A pasted blank over an array's blocker re-spills it
// ---------------------------------------------------------------------------

#[test]
fn pasting_a_blank_over_the_cell_that_blocks_an_array_re_spills_it() {
    let wb = workbook();
    wb.set(2, 1, "x"); // B3
    wb.set(0, 1, "=SEQUENCE(3)"); // B1, blocked by B3
    wb.set(0, 2, "=B1*10"); // C1 reads the array's first value
    assert_eq!(wb.value(0, 0, 1), CellValue::Error(CellError::Spill), "setup: blocked");

    paste(&wb, &[(2, 1, "")]);

    assert_eq!(
        wb.value(0, 0, 1),
        CellValue::Number(1.0),
        "B1 stayed #SPILL! after its blocker was pasted over with a blank -- \
         the batch cascade never re-decided the array (Excel [LIVE] re-spills)"
    );
    assert_eq!(wb.value(0, 1, 1), CellValue::Number(2.0));
    assert_eq!(wb.value(0, 2, 1), CellValue::Number(3.0));
    assert_eq!(claimed_by(&wb, (0, 1)), vec![(1, 1), (2, 1)]);
    assert_eq!(
        wb.value(0, 0, 2),
        CellValue::Number(10.0),
        "the array's reader follows it"
    );
}

#[test]
fn pasting_a_value_over_the_blocker_leaves_the_array_blocked() {
    // CONTROL: re-deciding an array whose blocker is still occupied is
    // convergent -- it stays #SPILL! and the new literal is kept.
    let wb = workbook();
    wb.set(2, 1, "x");
    wb.set(0, 1, "=SEQUENCE(3)");
    paste(&wb, &[(2, 1, "y")]);
    assert_eq!(wb.value(0, 0, 1), CellValue::Error(CellError::Spill));
    assert_eq!(wb.value(0, 2, 1), text("y"));
    assert!(claimed_by(&wb, (0, 1)).is_empty());
}

// ---------------------------------------------------------------------------
// 3. A fill copies a spilled value as BLANK
// ---------------------------------------------------------------------------

#[test]
fn a_fill_source_leaves_out_the_spilled_values_of_an_array_inside_it() {
    let wb = workbook();
    wb.set(0, 0, "=SEQUENCE(1,2)"); // A1, spills into B1
    assert_eq!(wb.value(0, 0, 1), CellValue::Number(2.0), "setup: B1 is spilled");

    let source = {
        let grid = wb.state.grid.read().unwrap();
        fill_source_cells(&wb.state, &grid, 0, 0, 0, 0, 1)
    };
    assert!(
        source.contains_key(&(0, 0)),
        "the ORIGIN is copied (its formula is what spills again)"
    );
    assert!(
        !source.contains_key(&(0, 1)),
        "B1, A1's spilled 2, was collected as a LITERAL: Ctrl+D over A1:B3 \
         then blocks every filled =SEQUENCE(1,2) with a copy of its own spill \
         (#SPILL!). Excel [LIVE] fills a spilled value as blank."
    );
}

#[test]
fn a_fill_source_leaves_out_a_spilled_value_whose_origin_is_outside_it() {
    // Excel [LIVE]: B1:B3 FillDown with B1 spilled from A1 leaves B2:B3 empty.
    let wb = workbook();
    wb.set(0, 0, "=SEQUENCE(1,2)");
    let source = {
        let grid = wb.state.grid.read().unwrap();
        fill_source_cells(&wb.state, &grid, 0, 0, 1, 0, 1)
    };
    assert!(source.is_empty(), "a spilled value fills as blank: {:?}", source.keys());
}

#[test]
fn a_fill_source_keeps_ordinary_cells_verbatim() {
    // POSITIVE CONTROL: no array, every stored cell is collected.
    let wb = workbook();
    wb.set(0, 0, "7");
    wb.set(0, 1, "=A1+1");
    let source = {
        let grid = wb.state.grid.read().unwrap();
        fill_source_cells(&wb.state, &grid, 0, 0, 0, 0, 1)
    };
    assert_eq!(source.get(&(0, 0)).map(|c| c.value.clone()), Some(CellValue::Number(7.0)));
    assert!(source.get(&(0, 1)).and_then(|c| c.formula_string()).is_some());
}

#[test]
fn both_fill_bodies_collect_their_source_through_the_spill_aware_helper() {
    const DATA_RS: &str = include_str!("data.rs");
    for func in ["fill_range_core", "fill_range_on_target"] {
        let body = body_of(DATA_RS, func);
        assert!(
            body.contains("fill_source_cells("),
            "`{}` collects its source cells without `fill_source_cells`, so a \
             spilled value is filled as a literal and every filled array is \
             blocked by a copy of its own spill",
            func
        );
    }
}
