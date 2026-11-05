//! FILENAME: core/engine/src/lambda_helper_error_tests.rs
//! PURPOSE: MAP, BYROW, BYCOL, SCAN, REDUCE and MAKEARRAY treat an ERROR
//! argument as Excel does.
//!
//! [LIVE] Excel 16 (lane formc, 2026-11-05, SCRATCH/formc/p1.json, p2.json),
//! each formula typed into column J of a fresh workbook whose A1 is 1.5, A2 a
//! text and A6 / A7 hold `=1/0` / `=NA()`. `TYPE` tells an array (64) from an
//! error (16).
//!
//! WHAT WAS WRONG. `=MAP(xyz,LAMBDA(x,x))` over an unknown name was `{#NAME?}`
//! -- a one-element ARRAY of the error -- where Excel's answer is the error
//! itself; an error in MAKEARRAY's counts became #VALUE!; and SCAN / REDUCE stopped at the first error the
//! accumulator met (the initial value's or a step's) where Excel passes it on
//! to the LAMBDA like any other value. SCAN over a ROW also came back as a
//! column.

use crate::cell::{Cell, CellError, CellValue};
use crate::evaluator::{EvalResult, Evaluator};
use crate::grid::Grid;

fn sheet() -> Grid {
    let mut g = Grid::new();
    g.set_cell(0, 0, Cell::new_number(1.5));
    g.set_cell(1, 0, Cell::new_number(2.0));
    let mut div0 = Cell::new_number(0.0);
    div0.value = CellValue::Error(CellError::Div0);
    g.set_cell(5, 0, div0);
    let mut na = Cell::new_number(0.0);
    na.value = CellValue::Error(CellError::NA);
    g.set_cell(6, 0, na);
    g
}

fn eval(formula: &str) -> EvalResult {
    let grid = sheet();
    let ast = parser::parse(formula).unwrap_or_else(|e| panic!("{formula} must parse: {e:?}"));
    Evaluator::new(&grid).evaluate(&ast)
}

/// [LIVE] Excel 16's value for each formula.
const EXCEL: &[(&str, f64)] = &[
    // An array argument that is an error VALUE is the error ...
    ("=TYPE(MAP(xyz,LAMBDA(x,x)))", 16.0),
    ("=ERROR.TYPE(MAP(xyz,LAMBDA(x,x)))", 5.0),
    ("=TYPE(MAP(1/0,LAMBDA(x,x)))", 16.0),
    ("=TYPE(MAP(NA(),LAMBDA(x,x+1)))", 16.0),
    ("=TYPE(MAP(xyz,LAMBDA(x,1)))", 16.0),
    ("=TYPE(MAP(LET(x,1/0,x),LAMBDA(x,x)))", 16.0),
    ("=TYPE(LET(x,1/0,MAP(x,LAMBDA(y,y))))", 16.0),
    ("=TYPE(BYROW(xyz,LAMBDA(r,SUM(r))))", 16.0),
    ("=TYPE(BYROW(1/0,LAMBDA(r,SUM(r))))", 16.0),
    ("=TYPE(BYROW(1/0,LAMBDA(r,1)))", 16.0),
    ("=TYPE(BYCOL(xyz,LAMBDA(c,SUM(c))))", 16.0),
    ("=TYPE(BYCOL(NA(),LAMBDA(c,SUM(c))))", 16.0),
    ("=TYPE(SCAN(0,xyz,LAMBDA(a,b,a+b)))", 16.0),
    ("=TYPE(REDUCE(0,xyz,LAMBDA(a,b,a+b)))", 16.0),
    ("=TYPE(REDUCE(0,1/0,LAMBDA(a,b,a+b)))", 16.0),
    // ... and so is a MAKEARRAY count; a LAMBDA slot that is no function is
    // #VALUE! whatever it holds.
    ("=TYPE(MAP({1,2},xyz))", 16.0),
    ("=ERROR.TYPE(MAP({1,2},xyz))", 3.0),
    ("=ERROR.TYPE(MAP({1,2},1/0))", 3.0),
    ("=ERROR.TYPE(MAKEARRAY(2,2,xyz))", 3.0),
    ("=ERROR.TYPE(BYROW(xyz,LAMBDA(r,1)))", 5.0),
    ("=TYPE(MAKEARRAY(1/0,2,LAMBDA(r,c,r)))", 16.0),
    ("=ERROR.TYPE(MAKEARRAY(1/0,2,LAMBDA(r,c,r)))", 2.0),
    ("=TYPE(MAKEARRAY(xyz,2,LAMBDA(r,c,r)))", 16.0),
    ("=ERROR.TYPE(MAKEARRAY(2,NA(),LAMBDA(r,c,r)))", 7.0),
    ("=TYPE(MAKEARRAY(2,2,xyz))", 16.0),
    ("=TYPE(MAP({1,2},LAMBDA(x,y,x)))", 16.0),
    // A REFERENCE to an error cell is a one-cell array of it.
    ("=TYPE(MAP(A6,LAMBDA(x,x)))", 64.0),
    ("=TYPE(MAP(A6:A7,LAMBDA(x,x)))", 64.0),
    ("=TYPE(LET(x,A6,MAP(x,LAMBDA(y,y))))", 64.0),
    ("=TYPE(MAP(INDEX(A6:A7,1),LAMBDA(x,x)))", 64.0),
    ("=TYPE(MAP(IF(1,A6),LAMBDA(x,x)))", 64.0),
    ("=TYPE(BYROW(A6,LAMBDA(r,r)))", 64.0),
    ("=TYPE(SCAN(1/0,A6,LAMBDA(a,b,a)))", 64.0),
    // A scalar or an error RESULT is still an array.
    ("=TYPE(MAP(5,LAMBDA(x,x)))", 64.0),
    ("=TYPE(MAP(1,LAMBDA(x,x)))", 64.0),
    ("=TYPE(MAP(A1,LAMBDA(x,x)))", 64.0),
    ("=TYPE(MAP(A1:A2,LAMBDA(x,x)))", 64.0),
    ("=TYPE(MAP(5,LAMBDA(x,1/0)))", 64.0),
    ("=TYPE(MAP({1,2},LAMBDA(x,1/0)))", 64.0),
    ("=TYPE(BYROW(5,LAMBDA(r,r)))", 64.0),
    ("=TYPE(MAKEARRAY(1,1,LAMBDA(r,c,1)))", 64.0),
    ("=TYPE(MAKEARRAY(2,2,LAMBDA(r,c,1/0)))", 64.0),
    ("=TYPE(SCAN(0,5,LAMBDA(a,b,a+b)))", 64.0),
    // SCAN / REDUCE pass an error accumulator on to the LAMBDA.
    ("=TYPE(SCAN(1/0,{1,2},LAMBDA(a,b,a+b)))", 64.0),
    ("=ERROR.TYPE(INDEX(SCAN(1/0,{1,2},LAMBDA(a,b,a+b)),1,1))", 2.0),
    ("=TYPE(SCAN(xyz,{1,2},LAMBDA(a,b,a+b)))", 64.0),
    ("=TYPE(SCAN(0,{1,\"x\",2},LAMBDA(a,b,a+b)))", 64.0),
    ("=INDEX(SCAN(0,{1,\"x\",2},LAMBDA(a,b,a+b)),1,1)", 1.0),
    ("=ERROR.TYPE(INDEX(SCAN(0,{1,\"x\",2},LAMBDA(a,b,a+b)),1,3))", 3.0),
    ("=INDEX(SCAN(0,{1,2},LAMBDA(a,b,IF(b=1,1/0,5))),1,2)", 5.0),
    ("=INDEX(SCAN(1/0,{1,2},LAMBDA(a,b,5)),1,1)", 5.0),
    ("=INDEX(SCAN(xyz,{1,2},LAMBDA(a,b,5)),1,2)", 5.0),
    ("=REDUCE(0,{1,2},LAMBDA(a,b,IF(b=1,1/0,5)))", 5.0),
    ("=REDUCE(1/0,{1,2},LAMBDA(a,b,5))", 5.0),
    ("=REDUCE(xyz,{1,2},LAMBDA(a,b,5))", 5.0),
    ("=TYPE(REDUCE(1/0,{1,2},LAMBDA(a,b,a+b)))", 16.0),
    ("=ERROR.TYPE(REDUCE(1/0,{1,2},LAMBDA(a,b,a+b)))", 2.0),
];

#[test]
fn the_lambda_helpers_treat_an_error_argument_as_excel_does() {
    let mut wrong = Vec::new();
    for (formula, excel) in EXCEL {
        match eval(formula) {
            EvalResult::Number(n) if n == *excel => {}
            other => wrong.push(format!("{formula}: Calcula {other:?}, [LIVE] Excel {excel}")),
        }
    }
    assert!(wrong.is_empty(), "{}", wrong.join("\n"));
}

#[test]
fn map_over_an_unknown_name_is_that_error_not_an_array_of_it() {
    assert_eq!(eval("=MAP(xyz,LAMBDA(x,x))"), EvalResult::Error(CellError::Name));
    // [LIVE] `=REDUCE(1/0,{1,2},LAMBDA(a,b,ISERROR(a)))` is FALSE: the first
    // step saw the error (TRUE), the second that TRUE.
    assert_eq!(eval("=REDUCE(1/0,{1,2},LAMBDA(a,b,ISERROR(a)))"), EvalResult::Boolean(false));
}
