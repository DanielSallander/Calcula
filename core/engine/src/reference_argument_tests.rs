//! FILENAME: core/engine/src/reference_argument_tests.rs
//! PURPOSE: The Analysis ToolPak functions take a multi-cell REFERENCE whole
//! -- they do not lift over it -- while an ARRAY argument still lifts.
//!
//! [LIVE] Excel 16 (lane formc, 2026-11-05, NEW-lift-over-reference,
//! SCRATCH/formc/p4.json; lane xlsxdyn's per-parameter table
//! SCRATCH/xlsxdyn/classes2.txt marks these parameters R for a range and V for
//! an array constant). D1:D3 = 10, 20, 1003; B3:B4 = 1, 2; A5 = "x".
//!
//! WHAT WAS WRONG. ISODD, ISEVEN, N, T, EDATE, EOMONTH, QUOTIENT and WEEKNUM
//! were on the lifting list for every argument shape, so `=SUM(ISODD(D1:D3)*1)`
//! was 1 where Excel says #VALUE!, and `=SUM(N(D1:D3))` 1033 where Excel says
//! 10 (N of a multi-cell reference is its FIRST cell, as T's is).

use crate::cell::{Cell, CellError};
use crate::evaluator::{EvalResult, Evaluator};
use crate::grid::Grid;

fn sheet() -> Grid {
    let mut g = Grid::new();
    g.set_cell(0, 3, Cell::new_number(10.0));
    g.set_cell(1, 3, Cell::new_number(20.0));
    g.set_cell(2, 3, Cell::new_number(1003.0));
    g.set_cell(2, 1, Cell::new_number(1.0));
    g.set_cell(3, 1, Cell::new_number(2.0));
    g.set_cell(3, 0, Cell::new_boolean(true));
    g.set_cell(4, 0, Cell::new_text("x".to_string()));
    g
}

fn eval(formula: &str) -> EvalResult {
    let grid = sheet();
    let ast = parser::parse(formula).unwrap_or_else(|e| panic!("{formula} must parse: {e:?}"));
    Evaluator::new(&grid).evaluate(&ast)
}

#[test]
fn an_analysis_toolpak_function_takes_a_reference_whole_and_lifts_an_array() {
    let value = || EvalResult::Error(CellError::Value);
    let n = EvalResult::Number;
    let mut wrong = Vec::new();
    for (formula, excel) in [
        ("=SUM(ISODD(D1:D3)*1)", value()),
        ("=ISODD(D1:D3)", value()),
        ("=SUM(ISODD({1,2,3})*1)", n(2.0)),
        ("=ISODD(D1:D1)", EvalResult::Boolean(false)),
        ("=SUM(ISEVEN(D1:D3)*1)", value()),
        ("=SUM(ISEVEN({1,2,3})*1)", n(1.0)),
        ("=SUM(N(D1:D3))", n(10.0)),
        ("=N(D1:D3)", n(10.0)),
        ("=N(D2:D3)", n(20.0)),
        ("=SUM(N({1,2,3}))", n(6.0)),
        ("=COLUMNS(N({1,2,3}))", n(3.0)),
        ("=T(A5:A6)", EvalResult::Text("x".to_string())),
        ("=LEN(T(A5:A6))", n(1.0)),
        ("=T(A4:A5)", EvalResult::Text(String::new())),
        ("=ROWS(T({\"a\";\"b\"}))", n(2.0)),
        ("=SUM(EDATE(D1:D3,1))", value()),
        ("=SUM(EDATE({10,20},1))", n(92.0)),
        ("=SUM(EDATE(10,D1:D2))", value()),
        ("=SUM(EDATE(10,{1,2}))", n(111.0)),
        ("=SUM(EOMONTH(D1:D3,0))", value()),
        ("=SUM(EOMONTH({10,20},0))", n(62.0)),
        ("=EOMONTH(D1:D1,0)", n(31.0)),
        ("=SUM(QUOTIENT(D1:D3,3))", value()),
        ("=SUM(QUOTIENT({10,20},3))", n(9.0)),
        ("=SUM(QUOTIENT(100,D1:D2))", value()),
        ("=SUM(QUOTIENT(100,{10,20}))", n(15.0)),
        ("=QUOTIENT(D1:D1,3)", n(3.0)),
        ("=SUM(WEEKNUM(D1:D3))", value()),
        ("=SUM(WEEKNUM({10,20}))", n(5.0)),
        ("=SUM(WEEKNUM(10,B3:B4))", value()),
    ] {
        let got = eval(formula);
        if got != excel {
            wrong.push(format!("{formula}: Calcula {got:?}, [LIVE] Excel {excel:?}"));
        }
    }
    assert!(wrong.is_empty(), "{}", wrong.join("\n"));
}
