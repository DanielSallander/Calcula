//! FILENAME: core/engine/src/calc_error_tests.rs
//! PURPOSE: Excel's `#CALC!` (BUG-0774) -- where the engine answers it, where it
//! keeps `#VALUE!`, and the array functions it needed (TAKE / DROP / HSTACK over
//! arrays, TOCOL's blanks).
//!
//! [LIVE] Excel 16, 2026-11-06, lane formula (SCRATCH/formula/probe.ps1,
//! p1.json, p2.json, p3.json): a fresh Excel 16 instance's new workbook with
//! A1:A5 = 1..5, B1:B5 = 10..50, C1:C5 = 100..500, F1 `=""`, F3 = 7 and
//! E1:E5 / F2 empty; each formula typed (`Formula2`) into column J, its spill
//! read back cell by cell (`Range.Text`), and `ERROR.TYPE` / `ISERROR` /
//! `ISERR` / `ISNA` / `IFERROR` written beside it. Calcula answered `#VALUE!`
//! for every `#CALC!` below, stored an uncalled LAMBDA as the TEXT "#LAMBDA",
//! spilled nested arrays as a grid, and had no TAKE / DROP / HSTACK over
//! arrays at all.

use crate::cell::{Cell, CellError, CellValue};
use crate::evaluator::{EvalResult, Evaluator};
use crate::grid::Grid;
use crate::locale::LocaleSettings;

fn sheet() -> Grid {
    let mut grid = Grid::new();
    for r in 0..5u32 {
        let n = (r + 1) as f64;
        grid.set_cell(r, 0, Cell::new_number(n));
        grid.set_cell(r, 1, Cell::new_number(10.0 * n));
        grid.set_cell(r, 2, Cell::new_number(100.0 * n));
    }
    // F1 holds a formula's "" (text, not blank); F2 is empty; F3 is 7.
    let mut empty_text = Cell::new_formula("=\"\"".to_string());
    empty_text.value = CellValue::Text(String::new());
    grid.set_cell(0, 5, empty_text);
    grid.set_cell(2, 5, Cell::new_number(7.0));
    grid
}

fn typed(formula: &str) -> EvalResult {
    let cell = crate::typed_entry::parse_cell_input(formula, &LocaleSettings::from_locale_id("en-US"));
    let ast = cell.get_ast().unwrap_or_else(|| panic!("{formula} was not accepted as a formula"));
    let grid = sheet();
    Evaluator::new(&grid).evaluate(ast)
}

/// What ONE cell shows: the value as a cell stores it (`to_cell_value`, which
/// is where an uncalled LAMBDA becomes #CALC!).
fn cell_text(v: &EvalResult) -> String {
    match v.to_cell_value() {
        CellValue::Number(n) => format!("{n}"),
        CellValue::Text(s) => s,
        CellValue::Boolean(b) => if b { "TRUE".into() } else { "FALSE".into() },
        CellValue::Error(e) => e.as_literal().to_string(),
        CellValue::Empty => String::new(),
        other => format!("{other:?}"),
    }
}

/// The result as Excel's spill reads: rows joined by `;`, cells by `,`, a
/// ragged row padded with #N/A as the spill pads it (`array_lift::at`).
fn shown(v: &EvalResult) -> String {
    if !crate::array_lift::lifts(v) {
        return cell_text(v);
    }
    let (rows, cols) = crate::array_lift::shape(v);
    (0..rows)
        .map(|r| (0..cols).map(|c| cell_text(&crate::array_lift::at(v, r, c))).collect::<Vec<_>>().join(","))
        .collect::<Vec<_>>()
        .join(";")
}

/// [LIVE] Excel 16's spill for each formula (lane formula p1/p2/p3).
const EXCEL: &[(&str, &str)] = &[
    // -- The value itself ---------------------------------------------------
    ("=FILTER(A1:A5,A1:A5>100)", "#CALC!"),
    ("=ERROR.TYPE(FILTER(A1:A5,A1:A5>100))", "14"),
    ("=ISERROR(FILTER(A1:A5,A1:A5>100))", "TRUE"),
    ("=ISERR(FILTER(A1:A5,A1:A5>100))", "TRUE"),
    ("=ISNA(FILTER(A1:A5,A1:A5>100))", "FALSE"),
    ("=IFERROR(FILTER(A1:A5,A1:A5>100),\"caught\")", "caught"),
    ("=IFNA(FILTER(A1:A5,A1:A5>100),\"caught\")", "#CALC!"),
    ("=TYPE(FILTER(A1:A5,A1:A5>100))", "16"),
    ("=FILTER(A1:A5,A1:A5>100)&\"x\"", "#CALC!"),
    ("=SUM(FILTER(A1:A5,A1:A5>100))", "#CALC!"),
    ("=INDEX(FILTER(A1:A5,A1:A5>100),1)", "#CALC!"),
    ("=FILTER(A1:A5,A1:A5>100)=1", "#CALC!"),
    ("=-FILTER(A1:A5,A1:A5>100)", "#CALC!"),
    ("=ISNUMBER(FILTER(A1:A5,A1:A5>100))", "FALSE"),
    ("=N(FILTER(A1:A5,A1:A5>100))", "#CALC!"),
    ("=LET(x,FILTER(A1:A5,A1:A5>100),1)", "1"),
    ("=LET(x,FILTER(A1:A5,A1:A5>100),ISERROR(x))", "TRUE"),
    ("=SUM(IFERROR(FILTER(A1:A5,A1:A5>100),0))", "0"),
    ("=ERROR.TYPE(#N/A)", "7"),
    // -- An uncalled LAMBDA is #CALC! in its cell, and no error before that --
    ("=LAMBDA(x,x)", "#CALC!"),
    ("=LAMBDA(5)", "#CALC!"),
    ("=LET(f,LAMBDA(x,x),f)", "#CALC!"),
    ("=IF(TRUE,LAMBDA(x,x))", "#CALC!"),
    ("=CHOOSE(1,LAMBDA(x,x))", "#CALC!"),
    ("=IFS(TRUE,LAMBDA(x,x))", "#CALC!"),
    ("=LET(f,LAMBDA(x,x),IF(TRUE,f,1))", "#CALC!"),
    ("=IFERROR(LAMBDA(x,x),\"caught\")", "#CALC!"),
    ("=ISERROR(LAMBDA(x,x))", "FALSE"),
    ("=ERROR.TYPE(LAMBDA(x,x))", "#N/A"),
    ("=TYPE(LAMBDA(x,x))", "128"),
    ("=LAMBDA(x,x)+1", "#VALUE!"),
    ("=LAMBDA(x,x)()", "#VALUE!"),
    ("=LAMBDA(x,x)(1,2)", "#VALUE!"),
    ("=VSTACK(LAMBDA(x,x),1)", "#CALC!;1"),
    ("=HSTACK(LAMBDA(x,x),2)", "#CALC!,2"),
    ("=INDEX(VSTACK(LAMBDA(x,x),1),1)", "#CALC!"),
    ("=TYPE(VSTACK(LAMBDA(x,x),1))", "64"),
    ("=ROWS(VSTACK(LAMBDA(x,x),1))", "2"),
    ("=VSTACK(1,LAMBDA(x,x)(1))", "1;1"),
    // -- A NESTED array is one #CALC! for the whole helper ------------------
    ("=MAP({1,2},LAMBDA(a,{1,2}))", "#CALC!"),
    ("=MAP({1,2},LAMBDA(a,SEQUENCE(a)))", "#CALC!"),
    ("=MAP({1,2},LAMBDA(a,A1:A2))", "#CALC!"),
    ("=MAP({1,2},LAMBDA(a,IF(a=1,{1,2},3)))", "#CALC!"),
    ("=MAP(A1:A2,B1:B2,LAMBDA(a,b,{1,2}))", "#CALC!"),
    ("=MAP({1,2},LAMBDA(a,LAMBDA(b,b)))", "#CALC!,#CALC!"),
    ("=MAP({1,2},LAMBDA(a,FILTER(A1:A5,A1:A5>100)))", "#CALC!,#CALC!"),
    ("=MAP({1,2},LAMBDA(a,A1))", "1,1"),
    ("=MAP({1,2},LAMBDA(a,{5}))", "5,5"),
    ("=MAP(A1:A3,LAMBDA(c,c))", "1;2;3"),
    ("=BYROW(A1:B2,LAMBDA(r,r))", "#CALC!"),
    ("=BYROW(A1:B2,LAMBDA(r,r*1))", "#CALC!"),
    ("=BYROW(A1:B2,LAMBDA(r,A1:A2))", "#CALC!"),
    ("=BYROW(A1:A2,LAMBDA(r,r))", "1;2"),
    ("=BYROW(A1:B2,LAMBDA(r,{1}))", "1;1"),
    ("=BYROW(A1:B2,LAMBDA(r,LAMBDA(x,x)))", "#CALC!;#CALC!"),
    ("=BYCOL(A1:B2,LAMBDA(c,c))", "#CALC!"),
    ("=BYCOL(A1:B2,LAMBDA(c,{1;2}))", "#CALC!"),
    ("=BYCOL(A1:B1,LAMBDA(c,c))", "1,10"),
    ("=SCAN(0,{1,2},LAMBDA(a,b,{1,2}))", "#CALC!"),
    ("=SCAN(0,{1,2},LAMBDA(a,b,LAMBDA(x,x)))", "#CALC!,#CALC!"),
    ("=SCAN(0,{1,2},LAMBDA(a,b,{5}))", "5,5"),
    ("=MAKEARRAY(2,2,LAMBDA(r,c,{1,2}))", "#CALC!"),
    ("=MAKEARRAY(1,1,LAMBDA(r,c,{1,2}))", "#CALC!"),
    ("=MAKEARRAY(2,1,LAMBDA(r,c,IF(r=1,5,{1,2})))", "#CALC!"),
    ("=MAKEARRAY(2,2,LAMBDA(r,c,LAMBDA(x,x)))", "#CALC!,#CALC!;#CALC!,#CALC!"),
    ("=MAKEARRAY(1,1,LAMBDA(r,c,{5}))", "5"),
    ("=MAKEARRAY(0,1,LAMBDA(r,c,1))", "#VALUE!"),
    // The function argument left out: Excel takes the formula (lane formula
    // p4.json) and answers #CALC!.
    ("=BYROW(A1:A3)", "#CALC!"),
    ("=BYCOL(A1:A3)", "#CALC!"),
    // REDUCE's one result may be an array, and spills.
    ("=REDUCE(0,{1,2},LAMBDA(a,b,{1,2}))", "1,2"),
    ("=REDUCE(0,{1,2},LAMBDA(a,b,LAMBDA(x,x)))", "#CALC!"),
    ("=REDUCE(0,{1,2},LAMBDA(a,b,FILTER(A1:A5,A1:A5>100)))", "#CALC!"),
    // -- An EMPTY array -------------------------------------------------------
    ("=SEQUENCE(0)", "#CALC!"),
    ("=SEQUENCE(1,0)", "#CALC!"),
    ("=SEQUENCE(0,0)", "#CALC!"),
    ("=SEQUENCE(0.5)", "#CALC!"),
    ("=SEQUENCE(1,0.5)", "#CALC!"),
    ("=SEQUENCE(-1)", "#VALUE!"),
    ("=RANDARRAY(0)", "#CALC!"),
    ("=RANDARRAY(0,1)", "#CALC!"),
    ("=RANDARRAY(1,0)", "#CALC!"),
    ("=RANDARRAY(0.5)", "#CALC!"),
    ("=UNIQUE({1,1},,TRUE)", "1,1"),
    ("=UNIQUE({1;1;2;2},FALSE,TRUE)", "#CALC!"),
    ("=UNIQUE({1;1},FALSE,TRUE)", "#CALC!"),
    ("=UNIQUE(FILTER(A1:A5,A1:A5>100))", "#CALC!"),
    ("=SORT(FILTER(A1:A5,A1:A5>100))", "#CALC!"),
    ("=FILTER(A1:B5,{FALSE,FALSE})", "#CALC!"),
    ("=FILTER(A1:A5,A1:A5>100,FILTER(A1:A5,A1:A5>100))", "#CALC!"),
    ("=FILTER(A1:A5,A1:A5>100,\"\")", ""),
    ("=FILTER(A1:B5,{TRUE,FALSE})", "1;2;3;4;5"),
    ("=FILTER(A1:A5,{TRUE;FALSE})", "#VALUE!"),
    ("=TOCOL(A1:A3/0,2)", "#CALC!"),
    ("=TOCOL(E1:E3,1)", "#CALC!"),
    ("=TOROW(E1:E3,1)", "#CALC!"),
    ("=TOCOL(E1:E3)", "0;0;0"),
    ("=TOCOL(F1:F3,1)", ";7"),
    ("=TOCOL(F1:F3,0)", ";0;7"),
    ("=TOROW(F1:F3,1)", ",7"),
    ("=TOCOL(F2:F2,1)", "#CALC!"),
    ("=TOCOL(F1:F1,1)", ""),
    ("=TEXTSPLIT(\",\",\",\",,TRUE)", "#CALC!"),
    ("=TEXTSPLIT(\";;\",\",\",\";\",TRUE)", "#CALC!"),
    ("=TEXTSPLIT(\",,\",\",\",,TRUE)", "#CALC!"),
    ("=TEXTSPLIT(\"\",\",\")", "#VALUE!"),
    ("=TEXTSPLIT(\"\",\",\",,TRUE)", "#VALUE!"),
    ("=TEXTSPLIT(\"a\",\",\",,TRUE)", "a"),
    ("=VSTACK(FILTER(A1:A5,A1:A5>100))", "#CALC!"),
    ("=HSTACK(FILTER(A1:A5,A1:A5>100),1)", "#CALC!"),
    ("=WRAPROWS(FILTER(A1:A5,A1:A5>100),2)", "#CALC!"),
    ("=VSTACK(1/0,1)", "#DIV/0!"),
    ("=HSTACK(1/0,1)", "#DIV/0!"),
    ("=EXPAND({1},0)", "#VALUE!"),
    ("=CHOOSEROWS({1;2},3)", "#VALUE!"),
    ("=CHOOSECOLS({1,2},0)", "#VALUE!"),
    ("=GROUPBY(A1:A5,B1:B5,SUM,,,,A1:A5>100)", "#VALUE!"),
    // -- TAKE / DROP over arrays ---------------------------------------------
    ("=TAKE({1;2},0)", "#CALC!"),
    ("=TAKE({1;2},,0)", "#CALC!"),
    ("=TAKE(A1:C5,0,1)", "#CALC!"),
    ("=TAKE(A1:C5,1,0)", "#CALC!"),
    ("=TAKE({1;2},5)", "1;2"),
    ("=TAKE(A1:C5,2)", "1,10,100;2,20,200"),
    ("=TAKE(A1:C5,-2)", "4,40,400;5,50,500"),
    ("=TAKE(A1:C5,2,-1)", "100;200"),
    ("=TAKE(A1:C5,,2)", "1,10;2,20;3,30;4,40;5,50"),
    ("=TAKE(A1:C5,9)", "1,10,100;2,20,200;3,30,300;4,40,400;5,50,500"),
    ("=TAKE(A1:C5,1.9)", "1,10,100"),
    ("=TAKE(A1:C5,-1.9)", "5,50,500"),
    ("=TAKE(A1:C5,\"2\")", "1,10,100;2,20,200"),
    ("=TAKE(A1:C5,TRUE)", "1,10,100"),
    ("=TAKE(A1:C5,\"x\")", "#VALUE!"),
    ("=TAKE(A1:C5,1/0)", "#DIV/0!"),
    ("=TAKE(1/0,1)", "#DIV/0!"),
    ("=TAKE(5,1)", "5"),
    ("=TAKE(\"a\",1,1)", "a"),
    ("=TAKE({1,2,3},1)", "1,2,3"),
    ("=TAKE({1,2,3},,-2)", "2,3"),
    ("=TAKE(A1:C5,{1,2})", "#VALUE!,#VALUE!"),
    ("=DROP({1;2},2)", "#CALC!"),
    ("=DROP({1,2},,2)", "#CALC!"),
    ("=DROP({1;2},5)", "#CALC!"),
    ("=DROP({1;2},-2)", "#CALC!"),
    ("=DROP(A1:C5,9)", "#CALC!"),
    ("=DROP(A1:C5,0,3)", "#CALC!"),
    ("=DROP({1;2},0)", "1;2"),
    ("=DROP(A1:C5,2)", "3,30,300;4,40,400;5,50,500"),
    ("=DROP(A1:C5,-2)", "1,10,100;2,20,200;3,30,300"),
    ("=DROP(A1:C5,1,1)", "20,200;30,300;40,400;50,500"),
    ("=DROP(A1:C5,,-2)", "1;2;3;4;5"),
    ("=DROP(A1:C5,0,0)", "1,10,100;2,20,200;3,30,300;4,40,400;5,50,500"),
    ("=DROP(A1:C5,1.9)", "2,20,200;3,30,300;4,40,400;5,50,500"),
    ("=DROP(A1:C5,-1.9)", "1,10,100;2,20,200;3,30,300;4,40,400"),
    ("=DROP(1/0,1)", "#DIV/0!"),
    ("=DROP(A1:C5,\"x\")", "#VALUE!"),
    ("=DROP({1,2,3},,1)", "2,3"),
    ("=DROP(5,0)", "5"),
    // -- HSTACK over arrays ------------------------------------------------------
    ("=HSTACK(A1:A2,B1:B3)", "1,10;2,20;#N/A,30"),
    ("=HSTACK(1,2,3)", "1,2,3"),
    ("=HSTACK({1;2},{3,4;5,6;7,8})", "1,3,4;2,5,6;#N/A,7,8"),
    ("=HSTACK(A1:A2)", "1;2"),
    ("=HSTACK(\"a\")", "a"),
    ("=HSTACK(A1:B2,C1)", "1,10,100;2,20,#N/A"),
    ("=VSTACK(A1:B1,C1:C2)", "1,10;100,#N/A;200,#N/A"),
];

#[test]
fn every_probed_formula_answers_what_excel_does() {
    let mut wrong = Vec::new();
    for (formula, excel) in EXCEL {
        let got = shown(&typed(formula));
        if got != *excel {
            wrong.push(format!("  {formula}: Excel {excel}, Calcula {got}"));
        }
    }
    assert!(wrong.is_empty(), "NOT AS EXCEL ({}):\n{}", wrong.len(), wrong.join("\n"));
}

#[test]
fn calc_is_its_own_error_with_excels_code_and_literal() {
    assert_eq!(CellError::Calc.as_literal(), "#CALC!");
    assert_eq!(CellError::from_literal("#CALC!"), CellError::Calc);
    assert_eq!(CellError::from_literal(" #calc! "), CellError::Calc);
    assert_eq!(typed("=FILTER(A1:A5,A1:A5>100)"), EvalResult::Error(CellError::Calc));
    assert_eq!(typed("=ERROR.TYPE(FILTER(A1:A5,A1:A5>100))"), EvalResult::Number(14.0));
}

#[test]
fn an_uncalled_lambda_is_stored_as_the_error_not_as_text() {
    // The cell VALUE, not just its display: a formula over the cell must see an
    // error (`ISERROR(J1)` TRUE), which the old text "#LAMBDA" could not give.
    assert_eq!(typed("=LAMBDA(x,x)").to_cell_value(), CellValue::Error(CellError::Calc));
}

#[test]
fn a_typed_calc_literal_is_text_and_a_pasted_one_is_the_error() {
    let us = LocaleSettings::from_locale_id("en-US");
    // [LIVE] `Range.Formula = "#CALC!"` stores TEXT (ISERROR FALSE) ...
    let typed = crate::typed_entry::parse_cell_input("#CALC!", &us);
    assert_eq!(typed.value, CellValue::Text("#CALC!".to_string()));
    // ... and Excel refuses `=#CALC!` outright.
    assert!(crate::typed_entry::parse_cell_input("=#CALC!", &us).get_ast().is_none());
    // A PASTED #CALC! value comes back the error it was copied from.
    let (pasted, _) = crate::typed_entry::parse_pasted_input("#CALC!", &us);
    assert_eq!(pasted.value, CellValue::Error(CellError::Calc));
    // CONTROL: a pasted ordinary error literal is still that error.
    let (na, _) = crate::typed_entry::parse_pasted_input("#N/A", &us);
    assert_eq!(na.value, CellValue::Error(CellError::NA));
}

#[test]
fn a_list_keeps_its_own_take_drop_and_hstack() {
    // Calcula's contained LIST (COLLECT) is not an Excel array: TAKE / DROP /
    // HSTACK over lists keep the list forms they had.
    assert_eq!(
        typed("=TAKE(COLLECT({1;2;3}),2)"),
        EvalResult::List(vec![EvalResult::Number(1.0), EvalResult::Number(2.0)])
    );
    assert_eq!(typed("=DROP(COLLECT({1;2;3}),2)"), EvalResult::List(vec![EvalResult::Number(3.0)]));
    assert_eq!(
        typed("=HSTACK(COLLECT(1),COLLECT(2))"),
        EvalResult::List(vec![EvalResult::Number(1.0), EvalResult::Number(2.0)])
    );
}
