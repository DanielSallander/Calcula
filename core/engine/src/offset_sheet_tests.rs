//! FILENAME: core/engine/src/offset_sheet_tests.rs
//! PURPOSE: `OFFSET` resolves against the sheet its base names — the exceljet
//!          glossary term "dynamic named range".
//!
//! WHAT WAS WRONG, and it was a WRONG SHEET rather than an error. `fn_offset`
//! destructured `Expression::CellRef { col, row, .. }`, DROPPING the sheet, and
//! then read `self.grid` — the active sheet — directly. Measured on Sheet2 with
//! Sheet1!B5:B7 = 1,2,3 and Sheet2!B5:B7 = 10,20,30:
//!
//!   =SUM(Sheet1!B5:B7)                6      correct
//!   =SUM(OFFSET(Sheet1!B5,0,0,3,1))   60     the reader's OWN sheet
//!   =SUM(OFFSET(NoSuchSheet!B5,...))  60     straight through the #REF! guard
//!
//! This is the shape a dynamic named range is built out of — `OFFSET(anchor, 0,
//! 0, COUNTA(column), 1)` — and workbook scope is the DEFAULT, so a name defined
//! once and read from a second sheet quietly returned the second sheet's
//! numbers. Nothing on screen said so.
//!
//! Two more, in the same function: the base had to be a single cell, so Excel's
//! range form with inherited height and width was `#VALUE!`; and a multi-cell
//! result came back FLAT, which every shape reader takes to mean a column, so a
//! wide OFFSET spilled downwards.

use crate::cell::{Cell, CellError};
use crate::evaluator::{EvalResult, Evaluator, MultiSheetContext};
use crate::grid::Grid;

/// Sheet1!B5:B7 = 1,2,3 · Sheet2!B5:B7 = 10,20,30 — deliberately the same
/// addresses, so a sheet-blind read returns a plausible number rather than
/// nothing.
fn two_sheets() -> (Grid, Grid) {
    let mut s1 = Grid::new();
    let mut s2 = Grid::new();
    for (i, v) in [1.0, 2.0, 3.0].iter().enumerate() {
        s1.set_cell(4 + i as u32, 1, Cell::new_number(*v));
    }
    for (i, v) in [10.0, 20.0, 30.0].iter().enumerate() {
        s2.set_cell(4 + i as u32, 1, Cell::new_number(*v));
    }
    (s1, s2)
}

/// Evaluate `formula` as if it were sitting on Sheet2.
fn on_sheet2(s1: &Grid, s2: &Grid, formula: &str) -> EvalResult {
    let ast = parser::parse(formula).expect("formula parses");
    let mut ms = MultiSheetContext::new("Sheet2".to_string());
    // `add_grid`, not a direct insert: the map is keyed UPPERCASE for
    // case-insensitive lookup, and inserting the display spelling makes every
    // qualified reference #REF!.
    ms.add_grid("Sheet1".to_string(), s1);
    ms.add_grid("Sheet2".to_string(), s2);
    ms.sheet_order = vec!["Sheet1".to_string(), "Sheet2".to_string()];
    Evaluator::with_multi_sheet(s2, ms).evaluate(&ast)
}

#[test]
fn offset_reads_the_sheet_its_base_names() {
    let (s1, s2) = two_sheets();
    // The plain reference was always right; OFFSET disagreed with it.
    assert_eq!(on_sheet2(&s1, &s2, "=SUM(Sheet1!B5:B7)"), EvalResult::Number(6.0));
    assert_eq!(
        on_sheet2(&s1, &s2, "=SUM(OFFSET(Sheet1!B5,0,0,3,1))"),
        EvalResult::Number(6.0),
        "OFFSET must read Sheet1, not the sheet the formula sits on"
    );
    assert_eq!(
        on_sheet2(&s1, &s2, "=MAX(OFFSET(Sheet1!B5,0,0,COUNTA(Sheet1!B5:B100),1))"),
        EvalResult::Number(3.0),
        "the dynamic-named-range shape, which is what this is used for"
    );
    // An UNQUALIFIED base still means the formula's own sheet.
    assert_eq!(
        on_sheet2(&s1, &s2, "=SUM(OFFSET(B5,0,0,3,1))"),
        EvalResult::Number(60.0)
    );
}

#[test]
fn offset_respects_the_unknown_sheet_guard() {
    let (s1, s2) = two_sheets();
    // The plain reference is #REF!; OFFSET walked through the guard and answered
    // the active sheet's numbers.
    assert_eq!(
        on_sheet2(&s1, &s2, "=SUM(NoSuchSheet!B5:B7)"),
        EvalResult::Error(CellError::Ref)
    );
    assert_eq!(
        on_sheet2(&s1, &s2, "=SUM(OFFSET(NoSuchSheet!B5,0,0,3,1))"),
        EvalResult::Error(CellError::Ref)
    );
}

#[test]
fn offset_accepts_a_range_base_and_inherits_its_size() {
    let (s1, s2) = two_sheets();
    // Excel's range form: with no height/width, the size comes from the base.
    // Both spellings were #VALUE!.
    assert_eq!(on_sheet2(&s1, &s2, "=SUM(OFFSET(B5:B7,0,0))"), EvalResult::Number(60.0));
    assert_eq!(on_sheet2(&s1, &s2, "=SUM(OFFSET(B5:B7,0,0,3,1))"), EvalResult::Number(60.0));
    // Shifted by one row: B6:B8, so 20+30+0.
    assert_eq!(on_sheet2(&s1, &s2, "=SUM(OFFSET(B5:B7,1,0))"), EvalResult::Number(50.0));
    // A single-cell base still defaults to 1x1.
    assert_eq!(on_sheet2(&s1, &s2, "=OFFSET(B5,1,0)"), EvalResult::Number(20.0));
}

#[test]
fn a_multi_cell_offset_has_the_shape_it_names() {
    let mut g = Grid::new();
    // A1:C2 = 1..6
    for r in 0..2u32 {
        for c in 0..3u32 {
            g.set_cell(r, c, Cell::new_number((r * 3 + c + 1) as f64));
        }
    }
    let run = |f: &str| {
        let ast = parser::parse(f).expect("parses");
        Evaluator::new(&g).evaluate(&ast)
    };
    // A flat array reads as a COLUMN everywhere in the engine, so a wide OFFSET
    // used to spill down the sheet instead of across it.
    assert_eq!(run("=OFFSET(A1,0,0,1,3)").spill_dimensions(), (1, 3));
    assert_eq!(run("=OFFSET(A1,0,0,2,1)").spill_dimensions(), (2, 1));
    assert_eq!(run("=OFFSET(A1,0,0,2,3)").spill_dimensions(), (2, 3));
    // ...and INDEX can now address it by row and column.
    assert_eq!(run("=INDEX(OFFSET(A1,0,0,2,3),2,3)"), EvalResult::Number(6.0));
}

#[test]
fn offset_off_the_sheet_is_ref() {
    let g = Grid::new();
    let run = |f: &str| {
        let ast = parser::parse(f).expect("parses");
        Evaluator::new(&g).evaluate(&ast)
    };
    assert_eq!(run("=OFFSET(A1,-1,0)"), EvalResult::Error(CellError::Ref));
    assert_eq!(run("=OFFSET(A1,0,-1)"), EvalResult::Error(CellError::Ref));
    assert_eq!(run("=OFFSET(XFD1,0,1)"), EvalResult::Error(CellError::Ref));
    assert_eq!(run("=OFFSET(A1048576,1,0)"), EvalResult::Error(CellError::Ref));
    // A zero or negative height is #REF! too, not an empty array.
    assert_eq!(run("=OFFSET(A1,0,0,0,1)"), EvalResult::Error(CellError::Ref));
    assert_eq!(run("=OFFSET(A1,0,0,1,-2)"), EvalResult::Error(CellError::Ref));
}
