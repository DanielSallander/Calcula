//! FILENAME: core/engine/src/range_half_tests.rs
//! PURPOSE: The range operator's HALVES, as Excel reads them (BUG-0737): a
//! LAMBDA parameter called with a reference, a call of a reference-returning
//! function, a parenthesised or implicitly intersected cell, a chained range,
//! and a qualified second half after an unqualified first.
//!
//! [LIVE] Excel 16, 2026-11-06, lane formula (SCRATCH/formula/probe.ps1,
//! p1.json, p2.json): Sheet1 A1:A5 = 1..5, B1:B5 = 10..50, C1:C5 = 100..500,
//! Sheet2 A1:A3000 = 1001.., each formula typed into Sheet1 column J. Every
//! function-call half was a parse error (the typed formula kept as text), and
//! a LAMBDA parameter was a value, so `LAMBDA(b,SUM(A1:b))(A3)` was #VALUE!.

use crate::cell::{Cell, CellError, CellValue};
use crate::evaluator::{EvalContext, EvalResult, Evaluator, MultiSheetContext};
use crate::grid::Grid;
use crate::locale::LocaleSettings;

fn sheets() -> (Grid, Grid) {
    let mut one = Grid::new();
    for r in 0..5u32 {
        let n = (r + 1) as f64;
        one.set_cell(r, 0, Cell::new_number(n));
        one.set_cell(r, 1, Cell::new_number(10.0 * n));
        one.set_cell(r, 2, Cell::new_number(100.0 * n));
    }
    let mut two = Grid::new();
    for r in 0..10u32 {
        two.set_cell(r, 0, Cell::new_number(1001.0 + r as f64));
    }
    (one, two)
}

/// The cell a typed formula becomes (refused at entry: text).
fn typed_cell(formula: &str) -> Cell {
    crate::typed_entry::parse_cell_input(formula, &LocaleSettings::from_locale_id("en-US"))
}

/// The typed formula evaluated in Sheet1!J10.
fn typed(formula: &str) -> EvalResult {
    let cell = typed_cell(formula);
    let ast = cell.get_ast().unwrap_or_else(|| panic!("{formula} was not accepted as a formula"));
    let (one, two) = sheets();
    let mut multi = MultiSheetContext::new("Sheet1".to_string());
    multi.add_grid("Sheet1".to_string(), &one);
    multi.add_grid("Sheet2".to_string(), &two);
    multi.sheet_order = vec!["Sheet1".to_string(), "Sheet2".to_string()];
    let ctx = EvalContext { current_row: Some(9), current_col: Some(9), ..Default::default() };
    Evaluator::with_context(&one, multi, ctx).evaluate(ast)
}

fn shown(v: &EvalResult) -> String {
    match v.to_cell_value() {
        CellValue::Number(n) => format!("{n}"),
        CellValue::Boolean(b) => if b { "TRUE".into() } else { "FALSE".into() },
        CellValue::Error(e) => e.as_literal().to_string(),
        CellValue::Text(s) => s,
        other => format!("{other:?}"),
    }
}

/// [LIVE] Excel 16's value for each formula (lane formula p1/p2).
const EXCEL: &[(&str, &str)] = &[
    // A LAMBDA parameter keeps the reference it was called with.
    ("=LAMBDA(b,SUM(A1:b))(A3)", "6"),
    ("=LET(f,LAMBDA(b,SUM(A1:b)),f(A3))", "6"),
    ("=LAMBDA(a,b,SUM(a:b))(A1,A3)", "6"),
    ("=LAMBDA(r,ROWS(r))(A1:A3)", "3"),
    ("=LAMBDA(r,ISREF(r))(A1)", "TRUE"),
    ("=LAMBDA(r,ISREF(r))(5)", "FALSE"),
    ("=LAMBDA(b,SUM(A1:b))(3)", "#VALUE!"),
    // ...and so do MAP / BYROW over a range: the cell or row.
    ("=INDEX(MAP(A1:A3,LAMBDA(c,ISREF(c))),3)", "TRUE"),
    ("=INDEX(MAP(A1:A3,LAMBDA(c,SUM(A1:c))),3)", "6"),
    ("=INDEX(MAP(A1:A3,LAMBDA(c,SUM(A1:c))),2)", "3"),
    ("=INDEX(BYROW(A1:B3,LAMBDA(r,ISREF(r))),2)", "TRUE"),
    // A call of a reference-returning function.
    ("=SUM(A1:INDEX(A1:A5,3))", "6"),
    ("=SUM(INDEX(A1:A5,2):A4)", "9"),
    ("=SUM(INDEX(A1:A5,2):INDEX(A1:A5,4))", "9"),
    ("=SUM(A1:INDEX(A1:C5,3,2))", "66"),
    ("=ROWS(A1:INDEX(A:A,4))", "4"),
    ("=SUM(A1:INDEX(A1:A5,0))", "15"),
    ("=SUM(A1:INDEX(A1:A5,3):A5)", "15"),
    ("=SUM(A1:INDEX(A1:A5,3)+0)", "6"),
    ("=SUM(A1:OFFSET(A1,2,0))", "6"),
    ("=SUM(A1:OFFSET(A1,1,0,2,1))", "6"),
    ("=SUM(A1:INDIRECT(\"A3\"))", "6"),
    ("=SUM(A1:INDIRECT(\"Sheet2!A3\"))", "#VALUE!"),
    ("=SUM(A1:INDEX(Sheet2!A1:A5,3))", "#VALUE!"),
    ("=SUM(A1:IF(TRUE,A3,A4))", "6"),
    ("=SUM(A1:CHOOSE(2,A2,A3))", "6"),
    ("=SUM(A1:IFS(TRUE,A3))", "6"),
    ("=SUM(A1:SWITCH(1,1,A3))", "6"),
    ("=SUM(A1:TAKE(A1:A5,3))", "6"),
    ("=SUM(A1:DROP(A1:A5,2))", "15"),
    // A parenthesised or implicitly intersected cell, and a chained range.
    ("=SUM(A1:(A3))", "6"),
    ("=SUM(A1:@A3)", "6"),
    ("=SUM(A1:A3:A4)", "10"),
    // An unqualified first half is the formula's own sheet.
    ("=SUM(A1:Sheet1!A3)", "6"),
    ("=SUM(A1:'Sheet1'!A3)", "6"),
    ("=SUM(A1:Sheet1!$A$3)", "6"),
    ("=SUM($A$1:Sheet1!A3)", "6"),
    ("=ROWS(A1:Sheet1!A3)", "3"),
    ("=SUM(A1:Sheet2!A3)", "#VALUE!"),
    ("=SUM(Sheet1!A1:Sheet2!A3)", "#VALUE!"),
    // The BUG-0646 shapes still hold.
    ("=LET(a,B2,SUM(a:C3))", "550"),
    ("=LET(b,A3,SUM(A1:b))", "6"),
];

#[test]
fn every_probed_range_half_answers_what_excel_does() {
    let mut wrong = Vec::new();
    for (formula, excel) in EXCEL {
        let cell = typed_cell(formula);
        if cell.get_ast().is_none() {
            wrong.push(format!("  {formula}: Excel {excel}, Calcula refused it ({:?})", cell.value));
            continue;
        }
        let got = shown(&typed(formula));
        if got != *excel {
            wrong.push(format!("  {formula}: Excel {excel}, Calcula {got}"));
        }
    }
    assert!(wrong.is_empty(), "NOT AS EXCEL ({}):\n{}", wrong.len(), wrong.join("\n"));
}

/// [LIVE] Excel refuses a range half that is a call of a function returning
/// VALUES (0x800A03EC, lane formula p1.json / p2.json); the typed text stays
/// text. Its siblings that return references are taken (above).
#[test]
fn a_value_function_is_no_range_half_at_entry() {
    for refused in [
        "=SUM(A1:SUM(A3))",
        "=SUM(A1:MAX(A3))",
        "=SUM(A1:CHOOSECOLS(A1:C3,2))",
        "=SUM(A1:FILTER(A1:A5,A1:A5>2))",
        "=SUM(A1:SORT(A1:A3))",
        "=SUM(A1:IFERROR(A3,A4))",
        "=SUM(A1:XMATCH(3,A1:A5))",
        "=SUM(A1:VLOOKUP(3,A1:B5,2))",
        "=SUM(A1:VSTACK(A3))",
        "=SUM(A1:N(A3))",
    ] {
        let cell = typed_cell(refused);
        assert!(cell.get_ast().is_none(), "{refused} must be refused at entry, as Excel refuses it");
        // ...while it still LOADS (a stored formula keeps its text).
        assert!(parser::parse(refused).is_ok(), "{refused} must still parse on load");
    }
}

#[test]
fn the_formula_bar_shows_each_half_as_typed() {
    for (typed_text, shown_text) in [
        ("=SUM(A1:INDEX(A1:A5,3))", "SUM(A1:INDEX(A1:A5,3))"),
        ("=SUM(INDEX(A1:A5,2):A4)", "SUM(INDEX(A1:A5,2):A4)"),
        ("=SUM(A1:Sheet1!A3)", "SUM(A1:SHEET1!A3)"),
        ("=SUM(A1:A3:A4)", "SUM(A1:A3:A4)"),
        ("=SUM(A1:@A3)", "SUM(A1:@A3)"),
        ("=LAMBDA(b,SUM(A1:b))(A3)", "LAMBDA(b,SUM(A1:b))(A3)"),
    ] {
        let cell = typed_cell(typed_text);
        assert_eq!(cell.formula_string().as_deref(), Some(shown_text), "{typed_text}");
        // ...and the stored text reads back to the same formula.
        let again = Cell::new_formula(format!("={}", cell.formula_string_raw().unwrap()));
        assert_eq!(again.formula_string().as_deref(), Some(shown_text), "{typed_text} round trip");
    }
    // An index past its range is INDEX's own #REF!, not the span's #VALUE!.
    assert_eq!(shown(&typed("=SUM(A1:INDEX(A1:A5,9))")), CellError::Ref.as_literal());
}
