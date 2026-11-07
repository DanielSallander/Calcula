//! FILENAME: core/engine/src/form5_tests.rs
//! PURPOSE: Ledger programme 2, wave 5, lane `form5` -- the SHAPE of an array
//! a function builds, as Excel 16 answers it. TRANSPOSE returned its cells as
//! one flat list, which the engine reads as a COLUMN (`array_lift`'s
//! flat-is-a-column convention), so `=TRANSPOSE(A1:A3)` spilled DOWN,
//! `=TRANSPOSE({1,2;3,4})` came out 1;3;2;4 and `=ROWS(TRANSPOSE(A1:A2))` was
//! 2. The rest of the table audits every other function that builds an array
//! (MMULT, MUNIT, SEQUENCE, CHOOSEROWS / CHOOSECOLS, WRAPROWS / WRAPCOLS,
//! TOCOL / TOROW, VSTACK / HSTACK, SORTBY, SORT, INDEX with 0, UNIQUE, FILTER,
//! TAKE / DROP / EXPAND), plus AGGREGATE over a reference call that has no
//! reference to give (#REF!) and IFS with a LAMBDA condition.
//!
//! [LIVE] Excel 16, 2026-11-06, lane form5 (SCRATCH/form5/probe.ps1 over
//! SCRATCH/form5/f1.txt..f4.txt, output p1.log..p4.log): Sheet1 A1:A5 = 1..5, B1:B5 = 10..50,
//! C1:C5 = 100..500, E1:E5 empty, each formula typed into J10 and read back
//! as its spill (`;` between rows, `,` between columns).

use crate::cell::{Cell, CellValue};
use crate::evaluator::{EvalContext, EvalResult, Evaluator, MultiSheetContext};
use crate::grid::Grid;
use crate::locale::LocaleSettings;

fn sheet() -> Grid {
    let mut one = Grid::new();
    for r in 0..5u32 {
        let n = (r + 1) as f64;
        one.set_cell(r, 0, Cell::new_number(n));
        one.set_cell(r, 1, Cell::new_number(10.0 * n));
        one.set_cell(r, 2, Cell::new_number(100.0 * n));
    }
    one
}

/// The typed formula evaluated in Sheet1!J10, shown the way a spill shows it.
fn typed(formula: &str) -> String {
    let cell = crate::typed_entry::parse_cell_input(formula, &LocaleSettings::from_locale_id("en-US"));
    let ast = cell.get_ast().unwrap_or_else(|| panic!("{formula} was not accepted as a formula"));
    let one = sheet();
    let mut multi = MultiSheetContext::new("Sheet1".to_string());
    multi.add_grid("Sheet1".to_string(), &one);
    multi.sheet_order = vec!["Sheet1".to_string()];
    let ctx = EvalContext { current_row: Some(9), current_col: Some(9), ..Default::default() };
    let v = Evaluator::with_context(&one, multi, ctx).evaluate(ast);
    shown(&v)
}

/// One spilled cell as Excel's `Text` shows it: a BLANK element shows 0, as
/// the grid's spill and Excel's both do. That makes this helper BLIND to the
/// difference between a blank element and the number 0 (the form5 verifier's
/// finding: `("=TRANSPOSE(E1:E3)","0,0,0")` passes either way), so the blank
/// is matched here by name rather than through `to_cell_value`'s collapse,
/// and what a blank element IS -- ISBLANK TRUE, COUNTA counting it in a built
/// array, `&"x"` giving "x" -- is pinned in `form6_tests`
/// (`a_built_array_keeps_blank_elements_and_counta_counts_them`).
fn cell_text(v: &EvalResult) -> String {
    if matches!(v, EvalResult::Blank) {
        return "0".to_string();
    }
    match v.to_cell_value() {
        CellValue::Number(n) => format!("{}", (n * 1e12).round() / 1e12 + 0.0),
        CellValue::Boolean(b) => if b { "TRUE".into() } else { "FALSE".into() },
        CellValue::Error(e) => e.as_literal().to_string(),
        CellValue::Text(s) => s,
        CellValue::Empty => "0".to_string(),
        other => format!("{other:?}"),
    }
}

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

/// [LIVE] Excel 16's answer for each formula (lane form5 p1.log, p2.log, p3.log, p4.log; MINVERSE's
/// "1,5" / "-0,5" are the Swedish regional decimal).
const EXCEL: &[(&str, &str)] = &[
    ("=TRANSPOSE(A1:A3)", "1,2,3"),
    ("=TRANSPOSE(A1:B3)", "1,2,3;10,20,30"),
    ("=TRANSPOSE({1,2;3,4})", "1,3;2,4"),
    ("=TRANSPOSE({1,2;3,4;5,6})", "1,3,5;2,4,6"),
    ("=TRANSPOSE({1,2,3})", "1;2;3"),
    ("=TRANSPOSE({1;2;3})", "1,2,3"),
    ("=TRANSPOSE(A1:C1)", "1;10;100"),
    ("=ROWS(TRANSPOSE(A1:A2))", "1"),
    ("=COLUMNS(TRANSPOSE(A1:A2))", "2"),
    ("=ROWS(TRANSPOSE(A1:B3))", "2"),
    ("=COLUMNS(TRANSPOSE(A1:B3))", "3"),
    ("=ROWS(TRANSPOSE({1,2,3}))", "3"),
    ("=TRANSPOSE(A1)", "1"),
    ("=TRANSPOSE(E1)", "0"),
    ("=TRANSPOSE(A1:A3)*2", "2,4,6"),
    ("=TRANSPOSE(SEQUENCE(2,3))", "1,4;2,5;3,6"),
    ("=TRANSPOSE(TRANSPOSE(A1:B3))", "1,10;2,20;3,30"),
    ("=INDEX(TRANSPOSE(A1:B3),2,1)", "10"),
    ("=INDEX(TRANSPOSE(A1:B3),1,3)", "3"),
    ("=SUMPRODUCT(A1:A2,TRANSPOSE(A1:A2))", "#VALUE!"),
    ("=SUMPRODUCT(TRANSPOSE(A1:A2),{1,2})", "5"),
    ("=SUMPRODUCT(TRANSPOSE(A1:A3),TRANSPOSE(B1:B3))", "140"),
    ("=MMULT(TRANSPOSE(A1:A3),A1:A3)", "14"),
    ("=MMULT(A1:A3,TRANSPOSE(A1:A3))", "1,2,3;2,4,6;3,6,9"),
    ("=TRANSPOSE(E1:E3)", "0,0,0"),
    ("=TRANSPOSE(1/0)", "#DIV/0!"),
    ("=TRANSPOSE(\"a\")", "a"),
    ("=TRANSPOSE({1,#N/A;3,4})", "1,3;#N/A,4"),
    ("=TRANSPOSE(A1:A3&\"x\")", "1x,2x,3x"),
    ("=TRANSPOSE(A1:B2)+{10,20;30,40}", "11,22;40,60"),
    ("=MMULT({1,2;3,4},{1;1})", "3;7"),
    ("=MMULT({1,2},{3;4})", "11"),
    ("=MMULT({1;2},{3,4})", "3,4;6,8"),
    ("=MMULT({1,2;3,4},{1,0;0,1})", "1,2;3,4"),
    ("=MMULT({1,2,3},{1;2;3})", "14"),
    ("=MUNIT(2)", "1,0;0,1"),
    ("=MUNIT(3)", "1,0,0;0,1,0;0,0,1"),
    ("=MUNIT(1)", "1"),
    ("=ROWS(MUNIT(3))", "3"),
    ("=SEQUENCE(2,3)", "1,2,3;4,5,6"),
    ("=SEQUENCE(1,3)", "1,2,3"),
    ("=SEQUENCE(3)", "1;2;3"),
    ("=SEQUENCE(3,1)", "1;2;3"),
    ("=COLUMNS(SEQUENCE(1,4))", "4"),
    ("=ROWS(SEQUENCE(1,4))", "1"),
    ("=CHOOSEROWS(A1:B5,2,4)", "2,20;4,40"),
    ("=CHOOSEROWS(A1:B5,2)", "2,20"),
    ("=CHOOSEROWS({1,2,3},1)", "1,2,3"),
    ("=CHOOSEROWS({1;2;3},1,3)", "1;3"),
    ("=CHOOSECOLS(A1:C5,1,3)", "1,100;2,200;3,300;4,400;5,500"),
    ("=CHOOSECOLS(A1:C5,2)", "10;20;30;40;50"),
    ("=CHOOSECOLS({1,2,3},2,3)", "2,3"),
    ("=CHOOSECOLS({1,2,3},2)", "2"),
    ("=CHOOSECOLS(A1:C2,3,1)", "100,1;200,2"),
    ("=WRAPROWS({1,2,3,4,5},2)", "1,2;3,4;5,#N/A"),
    ("=WRAPCOLS({1,2,3,4,5},2)", "1,3,5;2,4,#N/A"),
    ("=WRAPROWS(A1:A5,5)", "1,2,3,4,5"),
    ("=WRAPCOLS(A1:A5,5)", "1;2;3;4;5"),
    ("=WRAPROWS({1,2,3},1)", "1;2;3"),
    ("=WRAPCOLS({1,2,3},1)", "1,2,3"),
    ("=WRAPROWS(A1:A4,2)", "1,2;3,4"),
    ("=WRAPCOLS(A1:A4,2)", "1,3;2,4"),
    ("=TOCOL(A1:B2)", "1;10;2;20"),
    ("=TOROW(A1:B2)", "1,10,2,20"),
    ("=TOROW(A1:A3)", "1,2,3"),
    ("=TOCOL({1,2,3})", "1;2;3"),
    ("=TOROW({1;2;3})", "1,2,3"),
    ("=TOCOL(A1:B2,,TRUE)", "1;2;10;20"),
    ("=TOROW(A1:B2,,TRUE)", "1,2,10,20"),
    ("=VSTACK({1,2},{3,4})", "1,2;3,4"),
    ("=VSTACK(1,2)", "1;2"),
    ("=VSTACK({1,2})", "1,2"),
    ("=VSTACK(A1:B2,C1:C2)", "1,10;2,20;100,#N/A;200,#N/A"),
    ("=HSTACK(1,2)", "1,2"),
    ("=HSTACK({1;2},{3;4})", "1,3;2,4"),
    ("=HSTACK(A1:A2)", "1;2"),
    ("=HSTACK({1,2},{3;4})", "1,2,3;#N/A,#N/A,4"),
    ("=SORTBY(A1:B3,A1:A3,-1)", "3,30;2,20;1,10"),
    ("=SORTBY({1,2,3},{3,2,1})", "3,2,1"),
    ("=SORTBY(A1:A3,A1:A3,-1)", "3;2;1"),
    ("=SORTBY({1,2;3,4},{1,2},-1)", "2,1;4,3"),
    ("=SORT({3,1,2},,,TRUE)", "1,2,3"),
    ("=SORT({3,1,2})", "3,1,2"),
    ("=SORT(A1:B3,2,-1)", "3,30;2,20;1,10"),
    ("=INDEX({1,2;3,4},2,0)", "3,4"),
    ("=INDEX({1,2;3,4},0,2)", "2;4"),
    ("=INDEX({1,2;3,4},0,0)", "1,2;3,4"),
    ("=INDEX(A1:B3,0,2)", "10;20;30"),
    ("=INDEX(A1:B3,2,0)", "2,20"),
    ("=INDEX({1,2,3},2)", "2"),
    ("=INDEX({1;2;3},2)", "2"),
    ("=INDEX({1,2;3,4},2)", "3,4"),
    ("=ROWS(INDEX({1,2;3,4},2,0))", "1"),
    ("=COLUMNS(INDEX({1,2;3,4},2,0))", "2"),
    ("=MINVERSE({1,2;3,4})", "-2,1;1.5,-0.5"),
    ("=UNIQUE({1,1,2})", "1,1,2"),
    ("=UNIQUE({1,2;1,2;3,4})", "1,2;3,4"),
    ("=FILTER({1,2,3},{TRUE,FALSE,TRUE})", "1,3"),
    ("=TAKE({1,2,3;4,5,6},1)", "1,2,3"),
    ("=DROP({1,2,3;4,5,6},,1)", "2,3;5,6"),
    ("=EXPAND({1,2},2,3,0)", "1,2,0;0,0,0"),
    ("=AGGREGATE(9,6,INDEX(A1:A5,9))", "#REF!"),
    ("=AGGREGATE(9,6,OFFSET(A1,-1,0))", "#REF!"),
    ("=AGGREGATE(14,6,INDEX(A1:A5,9),1)", "#REF!"),
    ("=AGGREGATE(9,6,INDEX(A1:A5,0,3))", "#REF!"),
    ("=AGGREGATE(9,6,DROP(A1:A5,9))", "#CALC!"),
    ("=AGGREGATE(9,6,TAKE(A1:A5,0))", "#CALC!"),
    ("=AGGREGATE(9,6,INDEX(A1:A5,2))", "2"),
    ("=AGGREGATE(9,6,XLOOKUP(99,A1:A5,A1:A5))", "#N/A"),
    ("=AGGREGATE(9,6,A1:A2,INDEX(A1:A5,9))", "#REF!"),
    ("=AGGREGATE(9,6,INDEX(A1:A5,9),A1:A2)", "#REF!"),
    ("=AGGREGATE(9,6,TRIMRANGE(E1:E5))", "#REF!"),
    ("=AGGREGATE(4,6,INDEX(A1:A5,9))", "#REF!"),
    ("=AGGREGATE(9,5,INDEX(A1:A5,9))", "#REF!"),
    ("=AGGREGATE(9,6,1/0)", "#DIV/0!"),
    ("=AGGREGATE(9,6,OFFSET(A1,0,0,-1))", "1"),
    ("=AGGREGATE(9,6,INDEX(A1:A5,0)/0)", "#VALUE!"),
    ("=AGGREGATE(9,6,LET(r,INDEX(A1:A5,9),r))", "#REF!"),
    ("=IFS(LAMBDA(x,x),1)", "#VALUE!"),
    ("=IFS(FALSE,1,LAMBDA(x,x),2)", "#VALUE!"),
    ("=IFS(TRUE,LAMBDA(x,x))", "#CALC!"),
    ("=IFS(LAMBDA(x,x)(TRUE),1)", "1"),
    ("=IFS({TRUE,FALSE},1)", "1,#N/A"),
    ("=MMULT({1,#N/A},{1;1})", "#N/A"),
    ("=MMULT({1,\"a\"},{1;1})", "#VALUE!"),
    ("=MMULT({1,TRUE},{1;1})", "#VALUE!"),
    ("=MMULT(A1:B1,E1:E2)", "#VALUE!"),
    ("=MMULT({1,2},{1,2})", "#VALUE!"),
    ("=MMULT(1/0,1)", "#DIV/0!"),
    ("=MMULT(2,3)", "6"),
    ("=MMULT({1,#DIV/0!},{#N/A;1})", "#DIV/0!"),
    ("=MMULT({1,2;3,4},{1,#N/A;1,1})", "#N/A"),
    ("=MDETERM({1,2;3,4})", "-2"),
    ("=MDETERM({1,2,3})", "#VALUE!"),
    ("=MDETERM({1,\"a\";3,4})", "#VALUE!"),
    ("=MDETERM({1,#N/A;3,4})", "#N/A"),
    ("=MDETERM(5)", "5"),
    ("=MDETERM(A1:B2)", "0"),
    ("=MINVERSE({1,2,3})", "#VALUE!"),
    ("=MINVERSE({1,\"a\";3,4})", "#VALUE!"),
    ("=MINVERSE({1,#N/A;3,4})", "#N/A"),
    ("=MINVERSE({1,2;2,4})", "#NUM!"),
    ("=MINVERSE(4)", "0.25"),
    ("=MINVERSE(A1:A2)", "#VALUE!"),
    ("=EXPAND(1,1,3)", "1,#N/A,#N/A"),
    ("=EXPAND({1,2,3},1)", "1,2,3"),
    ("=EXPAND(A1:C1,1,4,0)", "1,10,100,0"),
    ("=CHOOSECOLS(A1:C1,1,3)", "1,100"),
    ("=CHOOSEROWS(A1:C3,1)", "1,10,100"),
    ("=VSTACK(A1:C1)", "1,10,100"),
    ("=HSTACK({1,2})", "1,2"),
    ("=SORTBY({1,2,3},{3,2,1},1)", "3,2,1"),
    ("=SORTBY(A1:C1,{3,2,1})", "100,10,1"),
    ("=SORTBY({1,2;3,4},{1,2})", "1,2;3,4"),
    ("=SORTBY({1,2;3,4},{2,1})", "2,1;4,3"),
    ("=SORTBY({1,2,3},{1;2;3})", "#VALUE!"),
    ("=SORT({3,1,2},1,-1,TRUE)", "3,2,1"),
    ("=SORT({3,1,2;6,5,4},2,1,TRUE)", "2,1,3;4,5,6"),
    ("=SORT(A1:C1,,-1,TRUE)", "100,10,1"),
    ("=SORT({3;1;2})", "1;2;3"),
    ("=INDEX({1,2;3,4},1,0)", "1,2"),
    ("=INDEX(A1:C3,0,0)", "1,10,100;2,20,200;3,30,300"),
    ("=INDEX(A1:C1,0,2)", "10"),
    ("=INDEX(A1:A3,0,1)", "1;2;3"),
    ("=INDEX(A1:A3,2,0)", "2"),
    ("=INDEX({1,2,3},0,2)", "2"),
    ("=INDEX({1;2;3},2,0)", "2"),
    ("=SUM(INDEX(A1:B3,0,2))", "60"),
    ("=INDEX(A1:B3,0,2)*1", "10;20;30"),
    ("=WRAPROWS({1,2,3,4},4)", "1,2,3,4"),
    ("=WRAPCOLS({1,2,3,4},4)", "1;2;3;4"),
    ("=WRAPROWS({1;2;3},3)", "1,2,3"),
    ("=WRAPROWS({1,2,3},2,0)", "1,2;3,0"),
    ("=UNIQUE({1,2,1},TRUE)", "1,2"),
    ("=FREQUENCY({1,2,3},{2})", "2;1"),
    ("=LINEST({1,2,3},{1,2,3})", "1,0"),
    ("=TEXTSPLIT(\"a,b,c\",\",\")", "a,b,c"),
    ("=TEXTSPLIT(\"a,b;c,d\",\",\",\";\")", "a,b;c,d"),
    ("=MAKEARRAY(1,3,LAMBDA(r,c,c))", "1,2,3"),
    ("=MAKEARRAY(2,2,LAMBDA(r,c,r*10+c))", "11,12;21,22"),
    ("=SCAN(0,{1,2,3},LAMBDA(a,b,a+b))", "1,3,6"),
    ("=MAP({1,2,3},LAMBDA(x,x*2))", "2,4,6"),
    ("=BYROW({1,2;3,4},LAMBDA(r,SUM(r)))", "3;7"),
    ("=BYCOL({1,2;3,4},LAMBDA(c,SUM(c)))", "4,6"),
    ("=GROUPBY(A1:A3,B1:B3,SUM,0,0)", "1,10;2,20;3,30"),
    ("=XLOOKUP(2,A1:A3,A1:C3)", "2,20,200"),
    ("=XLOOKUP(20,B1:B3,A1:C3)", "2,20,200"),
    ("=XLOOKUP(10,{10,20,30},{1,2,3;4,5,6})", "1;4"),
    ("=TRIMRANGE(A1:C1)", "1,10,100"),
    ("=SEQUENCE(1,1)", "1"),
    ("=FILTER(A1:C3,A1:A3=2)", "2,20,200"),
    ("=FILTER(A1:C3,{TRUE,FALSE,TRUE})", "1,100;2,200;3,300"),
    ("=TAKE(A1:C3,1)", "1,10,100"),
    ("=TAKE(A1:C3,-1)", "3,30,300"),
    ("=DROP(A1:C3,2)", "3,30,300"),
    ("=TOROW({1;2;3},,TRUE)", "1,2,3"),
    ("=IFS({TRUE,FALSE},1)", "1,#N/A"),
    ("=IFS({TRUE;FALSE},1,TRUE,2)", "1;2"),
    ("=IFS(TRUE,{1,2})", "1,2"),
    ("=IFS(FALSE,1,TRUE,{1,2,3})", "1,2,3"),
    ("=INDEX(A1:B3,1,3)", "#REF!"),
    ("=INDEX(A1:B3,4,1)", "#REF!"),
    ("=INDEX(A1:A3,2,2)", "#REF!"),
    ("=INDEX(A1:A3,4)", "#REF!"),
    ("=INDEX(A1:C1,4)", "#REF!"),
    ("=INDEX(A1:A5,-1)", "#VALUE!"),
    ("=INDEX({1,2,3},-1)", "#VALUE!"),
    ("=INDEX({1,2;3,4},1,3)", "#REF!"),
    ("=INDEX({1,2;3,4},3)", "#REF!"),
    ("=INDEX({1,2,3},4)", "#REF!"),
    ("=INDEX({1,2,3},2,1)", "#REF!"),
    ("=INDEX({1,2,3},1,2)", "2"),
    ("=INDEX({1;2;3},1,2)", "#REF!"),
    ("=INDEX({1;2;3},0)", "1;2;3"),
    ("=INDEX({1,2,3},0)", "1,2,3"),
    ("=INDEX({1,2;3,4},0)", "1,2;3,4"),
    ("=INDEX(A1:B3,0)", "#REF!"),
    ("=INDEX(A1:B3,2)", "#REF!"),
    ("=INDEX(A1:C1,2)", "10"),
    ("=INDEX(A1:C1,1,2)", "10"),
    ("=INDEX(A1:B3,2,)", "2,20"),
    ("=INDEX(A1:B3,,2)", "10;20;30"),
    ("=INDEX(A1:B3,\"2\",1)", "2"),
    ("=INDEX(A1:B3,1.9,1.9)", "1"),
    ("=INDEX(A1:B3,1/0,1)", "#DIV/0!"),
    ("=INDEX(1/0,1)", "#DIV/0!"),
    ("=INDEX(5,1)", "5"),
    ("=INDEX(5,1,1)", "5"),
    ("=INDEX(5,2)", "#REF!"),
    ("=INDEX(A1,1)", "1"),
    ("=INDEX(A1,0,0)", "1"),
    ("=INDEX(E1:E3,2)", "0"),
    ("=INDEX(SEQUENCE(3,2),2,0)", "3,4"),
    ("=INDEX(SEQUENCE(3,2),0,2)", "2;4;6"),
    ("=INDEX(SEQUENCE(1,3),2)", "2"),
    ("=INDEX(A:A,3)", "3"),
    ("=SUM(INDEX(A:C,0,2))", "150"),
    ("=ROWS(INDEX(A1:C3,0,1))", "3"),
    ("=ISBLANK(INDEX(E1:E3,2))", "TRUE"),
    ("=INDEX(A1:C3,2,0)*2", "4,40,400"),
    ("=AGGREGATE(9,6,INDEX(A1:A5,-1))", "#VALUE!"),
    ("=AGGREGATE(14,6,IF(FALSE,A1:A5,{1,2}),1)", "2"),
    ("=AGGREGATE(9,6,IF(FALSE,A1:A5,5))", "#VALUE!"),
    ("=AGGREGATE(9,6,INDIRECT(\"zz\"))", "#REF!"),
    ("=AGGREGATE(9,6,INDEX(xyz,1))", "#NAME?"),
    ("=AGGREGATE(9,6,XLOOKUP(99,A1:A5,A1:A5,\"none\"))", "#VALUE!"),
    ("=AGGREGATE(9,6,CHOOSE(3,A1,A2))", "#VALUE!"),
    ("=AGGREGATE(9,6,OFFSET(A1,0,0,-2))", "#REF!"),
    ("=AGGREGATE(9,6,OFFSET(A3,0,0,-2))", "5"),
    ("=AGGREGATE(9,6,IF(TRUE,INDEX(A1:A5,9)))", "#REF!"),
    ("=AGGREGATE(9,6,TAKE(INDEX(A1:A5,9),1))", "#REF!"),
    ("=AGGREGATE(9,6,INDEX(A1:C5,2))", "#REF!"),
    ("=OFFSET(A3,0,0,-2)", "2;3"),
    ("=SUM(OFFSET(A3,0,0,-2))", "5"),
    ("=SUM(OFFSET(C3,0,0,1,-2))", "330"),
    ("=ROWS(OFFSET(A3,0,0,-2))", "2"),
    ("=SUM(A1:INDEX(A1:C5,3))", "#REF!"),
    ("=SUM(A1:INDEX(A1:C5,3,0))", "666"),
    ("=SUM(INDEX(A1:C5,3))", "#REF!"),
    ("=SUM(A1:INDEX(A1:A5,-1))", "#VALUE!"),
    ("=SUM(A1:INDEX(A1:A5,3,))", "6"),
];

fn check(select: impl Fn(&str) -> bool) {
    let _locale = crate::number_text::begin(crate::number_text::NumberTextLocale::of(&LocaleSettings::from_locale_id("en-US")));
    let mut wrong = Vec::new();
    let mut n = 0;
    for (formula, excel) in EXCEL.iter().filter(|(f, _)| select(f)) {
        n += 1;
        let got = typed(formula);
        if got != *excel {
            wrong.push(format!("{formula}: Calcula {got}, Excel {excel}"));
        }
    }
    assert!(n > 0, "no rows selected");
    assert!(wrong.is_empty(), "NOT EXCEL'S ANSWER ({} of {n}):\n{}", wrong.len(), wrong.join("\n"));
}

/// TRANSPOSE is `cols x rows` of its argument -- a column comes back a ROW,
/// a 2-D range or array literal its mirror -- and everything that reads it
/// (ROWS / COLUMNS, INDEX, SUMPRODUCT's shape check, MMULT, an operator)
/// sees that shape.
#[test]
fn transpose_answers_cols_by_rows() {
    check(|f| f.contains("TRANSPOSE"));
}

/// AGGREGATE over a reference-returning call that has no reference to give
/// (`INDEX(A1:A5,9)`, `OFFSET(A1,-1,0)`, `TRIMRANGE` of nothing) answers that
/// call's #REF! even under option 6, which ignores errors only IN the cells.
#[test]
fn aggregate_answers_the_ref_error_of_an_out_of_range_reference_call() {
    check(|f| f.starts_with("=AGGREGATE"));
}

/// IFS with a LAMBDA as a condition is #VALUE!, as IF's is.
#[test]
fn ifs_with_a_lambda_condition_is_value() {
    check(|f| f.starts_with("=IFS"));
}

/// Every other function that builds an array, by the same table.
#[test]
fn every_other_array_builder_answers_excels_shape() {
    check(|f| !f.contains("TRANSPOSE") && !f.starts_with("=AGGREGATE") && !f.starts_with("=IFS"));
}
