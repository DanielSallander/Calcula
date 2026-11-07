//! FILENAME: core/engine/src/form6_tests.rs
//! PURPOSE: Ledger programme 2, wave 6, lane `form6` -- the items the form5
//! verifier found next door, each pinned by Excel 16's own answer:
//!
//! - XLOOKUP checks that its lookup vector and its return array agree in
//!   size (#VALUE! otherwise, on the scan path AND the lookup-cache fast
//!   path), lifts an ARRAY lookup_value element by element, and returns the
//!   REFERENCE it found -- a blank result cell stays blank (ISBLANK TRUE,
//!   COUNTA 0, `&"x"` is "x") although the cell that shows it shows 0.
//! - A function that BUILDS an array (TRANSPOSE, CHOOSEROWS, VSTACK, SORTBY,
//!   TOROW, WRAPROWS, ...) keeps a blank source cell as a blank ELEMENT
//!   (ISBLANK TRUE, `=""` TRUE, ISNUMBER FALSE), and COUNTA counts every
//!   element of such an array, blanks included, while it skips the empty
//!   cells of a REFERENCE (a range, TAKE / DROP / INDEX over one, LET, IF,
//!   CHOOSE, OFFSET, INDIRECT, a scalar XLOOKUP). TRANSPOSE of one blank cell
//!   is the number 0; TRANSPOSE of a LAMBDA is a 1x1 array holding it.
//! - AGGREGATE 14-19 answers the error of its k argument, lifts an array k,
//!   refuses a multi-cell reference k (#VALUE!), reads k the way LARGE /
//!   SMALL / PERCENTILE / QUARTILE do, and answers #NUM! (not #VALUE!) for a
//!   k out of range or no numbers at all.
//! - INDEX takes area_num: 1 on the one area there is, #REF! beyond it,
//!   #VALUE! for 0, a negative or an omitted one.
//! - LINEST / LOGEST: const and stats, several x variables, and a collinear
//!   x column dropped as Excel drops it (the EARLIER of two dependent columns).
//!
//! [LIVE] Excel 16, 2026-11-06, lane form6 (SCRATCH/form6/probe3.ps1 over
//! SCRATCH/form6/f6.txt, output p6v.log; numbers read from Value2 in the
//! invariant culture, `|` between the columns of a spill): Sheet1 A1:A5 =
//! 1..5, B1:B5 = 10..50, C1:C5 = 100..500, E1:F5 empty, each formula typed
//! into J10. The display of a spilled blank and of a 0 are the same "0", so
//! the blank rows are pinned through what Excel CAN tell apart: ISBLANK,
//! COUNTA, `=""` and `&"x"`.

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

/// One spilled cell as Excel shows it. A BLANK element shows "0" as Excel's
/// spill shows it -- which is exactly why no display row can tell a blank
/// from a 0, and why the blank rows below ask ISBLANK / COUNTA instead.
fn cell_text(v: &EvalResult) -> String {
    match v {
        EvalResult::Blank => "0".to_string(),
        EvalResult::Number(n) => format!("{}", (n * 1e12).round() / 1e12 + 0.0),
        EvalResult::Boolean(b) => if *b { "TRUE".into() } else { "FALSE".into() },
        EvalResult::Error(e) => e.as_literal().to_string(),
        EvalResult::Text(s) => s.clone(),
        other => match other.to_cell_value() {
            CellValue::Error(e) => e.as_literal().to_string(),
            shown => format!("{shown:?}"),
        },
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

/// [LIVE] Excel 16's answer for each formula (lane form6 p6v.log).
const EXCEL: &[(&str, &str)] = &[
    ("=XLOOKUP(2,A1:A5,A1:C3)", "#VALUE!"),
    ("=XLOOKUP(2,A1:A3,A1:C5)", "#VALUE!"),
    ("=XLOOKUP(10,A1:C1,A1:B3)", "#VALUE!"),
    ("=XLOOKUP(10,A1:C1,A1:C3)", "10;20;30"),
    ("=XLOOKUP(2,A1:A5,B1:B3)", "#VALUE!"),
    ("=XLOOKUP(10,A1:C1,A2:B2)", "#VALUE!"),
    ("=XLOOKUP(9,A1:A5,B1:B3,\"nf\")", "#VALUE!"),
    ("=XLOOKUP(2,A1:A5,B1:B5)", "20"),
    ("=XLOOKUP(2,A1:A5,B1:C5)", "20,200"),
    ("=XLOOKUP(2,{1;2;3},{10;20})", "#VALUE!"),
    ("=XLOOKUP(2,{1,2,3},{10,20})", "#VALUE!"),
    ("=XLOOKUP(2,{1;2;3},{10,20,30})", "#VALUE!"),
    ("=XLOOKUP(2,A1:A3,B1:D1)", "#VALUE!"),
    ("=XLOOKUP(2,A1:A3,B1)", "#VALUE!"),
    ("=XLOOKUP(1,A1:A1,B1)", "10"),
    ("=XLOOKUP(1,A1,B1:B2)", "10;20"),
    ("=XLOOKUP(1,A1,B1)", "10"),
    ("=XLOOKUP(1,1,5)", "5"),
    ("=XLOOKUP(1,{1,2},{5;6})", "#VALUE!"),
    ("=XLOOKUP(2,A1:B5,B1:B5)", "#VALUE!"),
    ("=XLOOKUP(2,A1:A5,B1:B6,,0,-1)", "#VALUE!"),
    ("=XLOOKUP(2,A1:A5,B1:B6,,1)", "#VALUE!"),
    ("=XLOOKUP(\"*\",A1:A5,B1:B3,,2)", "#VALUE!"),
    ("=XLOOKUP(2,A1:A5,B1:B3,,,2)", "#VALUE!"),
    ("=XLOOKUP(2,A1:A5,B1:B3,,,-2)", "#VALUE!"),
    ("=XLOOKUP(2,A1:A5,1/0)", "#DIV/0!"),
    ("=XLOOKUP(2,1/0,B1:B5)", "#DIV/0!"),
    ("=XLOOKUP({2;3},A1:A5,B1:B5)", "20;30"),
    ("=XLOOKUP({2,3},A1:A5,B1:B5)", "20,30"),
    ("=XLOOKUP({2;9},A1:A5,B1:B5)", "20;#N/A"),
    ("=XLOOKUP({2;9},A1:A5,B1:B5,\"nf\")", "20;nf"),
    ("=XLOOKUP({2;3},A1:A5,B1:C5)", "20;30"),
    ("=XLOOKUP({2;3},A1:A3,A1:C3)", "2;3"),
    ("=XLOOKUP({1,10},A1:C1,A1:C3)", "1,10"),
    ("=XLOOKUP({2,3;4,5},A1:A5,B1:B5)", "20,30;40,50"),
    ("=XLOOKUP(A2:A3,A1:A5,B1:B5)", "20;30"),
    ("=XLOOKUP({2;3},A1:A5,B1:B3)", "#VALUE!;#VALUE!"),
    ("=XLOOKUP({1;\"a\"},A1:A5,B1:B5)", "10;#N/A"),
    ("=XLOOKUP({1;2},A1:C1,A2:C2)", "2;#N/A"),
    ("=XLOOKUP({2.5;3},A1:A5,B1:B5,,-1)", "20;30"),
    ("=XLOOKUP({1;9},A1:A5,B1:B5,{\"a\";\"b\"})", "10;a"),
    ("=XLOOKUP({1;9},A1:A5,B1:B5,{\"a\",\"b\"})", "10;a"),
    ("=XLOOKUP({2;3},A1:A5,B1:B5,,,-1)", "20;30"),
    ("=COUNTA(XLOOKUP({1;2},A1:A5,E1:E5))", "2"),
    ("=XLOOKUP({1;2},A1:A5,E1:E5)&\"x\"", "x;x"),
    ("=XLOOKUP(SEQUENCE(2),A1:A5,B1:B5)", "10;20"),
    ("=COUNTA(XLOOKUP(1,A1:A5,E1:F5))", "0"),
    ("=COUNTA(XLOOKUP(1,A1:A5,E1:E5))", "0"),
    ("=COUNTA(XLOOKUP(A1,A1:A5,E1:F5))", "0"),
    ("=COUNTA(XLOOKUP(9,A1:A5,E1:E5,E1:E2))", "0"),
    ("=COUNTA(XLOOKUP(1,{1;2;3;4;5},E1:E5))", "0"),
    ("=ISBLANK(XLOOKUP(1,A1:A5,E1:E5))", "TRUE"),
    ("=ISBLANK(XLOOKUP(1,A1:A5,E1:F5))", "TRUE,TRUE"),
    ("=ISBLANK(XLOOKUP(1,{1;2;3;4;5},E1:E5))", "TRUE"),
    ("=XLOOKUP(1,A1:A5,E1:E5)=\"\"", "TRUE"),
    ("=ISNUMBER(XLOOKUP(1,A1:A5,E1:E5))", "FALSE"),
    ("=XLOOKUP(1,A1:A5,E1:E5)&\"x\"", "x"),
    ("=XLOOKUP(1,A1:A5,E1:E5,,,-1)&\"x\"", "x"),
    ("=XLOOKUP(1,A1:A5,E1:E5,,-1)&\"x\"", "x"),
    ("=XLOOKUP(1,A1:A5,E1:F5)&\"x\"", "x,x"),
    ("=XLOOKUP(1,A1:A5,E1:F5)", "0,0"),
    ("=XLOOKUP(1,A1:A5,E1:E5)", "0"),
    ("=COUNTA(TRANSPOSE(E1:E2),1)", "3"),
    ("=COUNTA(TRANSPOSE(E1:E3))", "3"),
    ("=COUNTA(TRANSPOSE(E1),E1)", "1"),
    ("=ISBLANK(TRANSPOSE(E1))", "FALSE"),
    ("=ISNUMBER(TRANSPOSE(E1))", "TRUE"),
    ("=TRANSPOSE(E1)=\"\"", "FALSE"),
    ("=ISBLANK(TRANSPOSE(E1:E1))", "FALSE"),
    ("=ISBLANK(TRANSPOSE(E1:E2))", "TRUE,TRUE"),
    ("=ISNUMBER(TRANSPOSE(E1:E2))", "FALSE,FALSE"),
    ("=TRANSPOSE(E1:E2)=\"\"", "TRUE,TRUE"),
    ("=TRANSPOSE(E1:E2)&\"x\"", "x,x"),
    ("=ISBLANK(INDEX(TRANSPOSE(E1:E2),1,1))", "TRUE"),
    ("=COUNTA(INDEX(TRANSPOSE(E1:E2),1,1))", "1"),
    ("=SUMPRODUCT(--(TRANSPOSE(E1:E2)=\"\"))", "2"),
    ("=COUNTA(CHOOSEROWS(E1:F3,1))", "2"),
    ("=COUNTA(CHOOSECOLS(E1:F3,1))", "3"),
    ("=ISBLANK(CHOOSEROWS(E1:E3,1))", "TRUE"),
    ("=COUNTA(VSTACK(E1:E2))", "2"),
    ("=COUNTA(HSTACK(E1:E2))", "2"),
    ("=COUNTA(VSTACK(E1:E2,A1))", "3"),
    ("=VSTACK(E1:E2)&\"x\"", "x;x"),
    ("=ISBLANK(INDEX(VSTACK(E1:E2),1))", "TRUE"),
    ("=COUNTA(SORTBY(E1:E2,{1;2}))", "2"),
    ("=COUNTA(SORTBY(E1:E2,{2;1}),HSTACK(E1:E2))", "4"),
    ("=COUNTA(TOROW(E1:E2))", "2"),
    ("=COUNTA(TOCOL(E1:E2))", "2"),
    ("=COUNTA(TOCOL(E1:E3,0))", "3"),
    ("=ISBLANK(TOROW(E1:E2))", "TRUE,TRUE"),
    ("=COUNTA(WRAPROWS(E1:E4,2))", "4"),
    ("=COUNTA(WRAPCOLS(E1:E4,2))", "4"),
    ("=COUNTA(SORT(E1:E2))", "2"),
    ("=COUNTA(UNIQUE(E1:E2))", "1"),
    ("=COUNTA(FILTER(E1:E3,{1;1;1}))", "3"),
    ("=COUNTA(EXPAND(E1:E2,3))", "3"),
    ("=COUNTA(MAP(E1:E3,LAMBDA(x,x)))", "3"),
    ("=COUNTA({1,2},TRANSPOSE(E1:E2))", "4"),
    ("=COUNTA(TAKE(E1:E3,2))", "0"),
    ("=COUNTA(DROP(E1:E3,1))", "0"),
    ("=COUNTA(TAKE(E1:F3,1,1))", "0"),
    ("=COUNTA(INDEX(E1:F3,0,1))", "0"),
    ("=COUNTA(E1:E3)", "0"),
    ("=COUNTA(LET(x,E1:E3,x))", "0"),
    ("=COUNTA(LAMBDA(r,r)(E1:E3))", "0"),
    ("=COUNTA(IF(TRUE,E1:E2))", "0"),
    ("=COUNTA(CHOOSE(1,E1:E2))", "0"),
    ("=COUNTA(OFFSET(E1,0,0,3))", "0"),
    ("=COUNTA(E1:E2&\"\")", "2"),
    ("=COUNT(TRANSPOSE(E1:E2))", "0"),
    ("=SUM(TRANSPOSE(E1:E2))", "0"),
    ("=TYPE(TRANSPOSE(LAMBDA(x,x)))", "64"),
    ("=ISERROR(TRANSPOSE(LAMBDA(x,x)))", "FALSE"),
    ("=TRANSPOSE(LAMBDA(x,x))", "#CALC!"),
    ("=ROWS(TRANSPOSE(LAMBDA(x,x)))", "1"),
    ("=INDEX(TRANSPOSE(LAMBDA(x,x)),1,1)(3)", "3"),
    ("=TYPE(INDEX(TRANSPOSE(LAMBDA(x,x)),1,1))", "128"),
    ("=AGGREGATE(14,6,A1:A5,INDEX(A1:A5,9))", "#REF!"),
    ("=AGGREGATE(14,6,A1:A5,1/0)", "#DIV/0!"),
    ("=AGGREGATE(14,6,INDEX(A1:A5,0),INDEX({1,2},3))", "#REF!"),
    ("=AGGREGATE(14,6,A1:A5,\"x\")", "#VALUE!"),
    ("=AGGREGATE(14,6,A1:A5,\"2\")", "4"),
    ("=AGGREGATE(14,6,A1:A5,TRUE)", "5"),
    ("=AGGREGATE(14,6,A1:A5,E1)", "#NUM!"),
    ("=AGGREGATE(15,6,A1:A5,#N/A)", "#N/A"),
    ("=AGGREGATE(16,6,A1:A5,1/0)", "#DIV/0!"),
    ("=AGGREGATE(17,6,A1:A5,1/0)", "#DIV/0!"),
    ("=AGGREGATE(18,6,A1:A5,1/0)", "#DIV/0!"),
    ("=AGGREGATE(19,6,A1:A5,1/0)", "#DIV/0!"),
    ("=AGGREGATE(16,6,A1:A5,\"x\")", "#VALUE!"),
    ("=AGGREGATE(14,6,A1:A5,{1,2})", "5,4"),
    ("=AGGREGATE(14,6,A1:A5,A1:A2)", "#VALUE!"),
    ("=AGGREGATE(14,6,A1:A5,0)", "#NUM!"),
    ("=AGGREGATE(14,6,A1:A5,9)", "#NUM!"),
    ("=AGGREGATE(14,6,A1:A5,-1)", "#NUM!"),
    ("=AGGREGATE(16,6,A1:A5,2)", "#NUM!"),
    ("=AGGREGATE(14,6,1/0,1/0)", "#DIV/0!"),
    ("=AGGREGATE(14,6,E1:E3,1)", "#NUM!"),
    ("=AGGREGATE(15,6,E1:E3,1)", "#NUM!"),
    ("=AGGREGATE(16,6,E1:E3,0.5)", "#NUM!"),
    ("=AGGREGATE(17,6,E1:E3,1)", "#NUM!"),
    ("=AGGREGATE(18,6,E1:E3,0.5)", "#NUM!"),
    ("=AGGREGATE(19,6,E1:E3,1)", "#NUM!"),
    ("=AGGREGATE(14,6,A1:A5,1.5)", "4"),
    ("=AGGREGATE(14,6,A1:A5,1.9)", "4"),
    ("=AGGREGATE(15,6,A1:A5,2.9)", "2"),
    ("=AGGREGATE(17,6,A1:A5,2.5)", "3"),
    ("=AGGREGATE(17,6,A1:A5,5)", "#NUM!"),
    ("=AGGREGATE(17,6,A1:A5,-1)", "#NUM!"),
    ("=AGGREGATE(16,6,A1:A5,-0.1)", "#NUM!"),
    ("=AGGREGATE(16,6,A1:A5,0.3)", "2.2"),
    ("=AGGREGATE(18,6,A1:A5,0.1)", "#NUM!"),
    ("=AGGREGATE(18,6,A1:A5,0)", "#NUM!"),
    ("=AGGREGATE(18,6,A1:A5,1)", "#NUM!"),
    ("=AGGREGATE(18,6,A1:A5,0.4)", "2.4"),
    ("=AGGREGATE(19,6,A1:A5,0)", "#NUM!"),
    ("=AGGREGATE(19,6,A1:A5,4)", "#NUM!"),
    ("=AGGREGATE(19,6,A1:A5,3.5)", "4.5"),
    ("=AGGREGATE(19,6,A1:A2,1)", "#NUM!"),
    ("=AGGREGATE(14,4,{1,#N/A},1/0)", "#DIV/0!"),
    ("=AGGREGATE(14,4,{1,#N/A},9)", "#N/A"),
    ("=AGGREGATE(14,6,A1:A5,{1;9})", "5;#NUM!"),
    ("=AGGREGATE(14,6,A1:A5,{1;\"x\"})", "5;#VALUE!"),
    ("=AGGREGATE(14,6,A1:A5,{1;#N/A})", "5;#N/A"),
    ("=AGGREGATE(16,6,A1:A5,{0,0.5,1})", "1,3,5"),
    ("=AGGREGATE(14,6,A1:A5,A1)", "5"),
    ("=AGGREGATE(14,6,A1:A5,A1:A2*1)", "5;4"),
    ("=AGGREGATE(14,6,A1:A5,SEQUENCE(2))", "5;4"),
    ("=AGGREGATE(14,6,A1:A5,INDEX(A1:A5,2))", "4"),
    ("=AGGREGATE(14,6,A1:A5,INDEX(A1:A5,0))", "#VALUE!"),
    ("=AGGREGATE(14,6,A1:A5,\"\")", "#VALUE!"),
    ("=AGGREGATE(15,6,A1:A5,2)", "2"),
    ("=AGGREGATE(14,6,A1:A5,5)", "1"),
    ("=INDEX(A1:B3,3,2,1)", "30"),
    ("=INDEX(A1:B3,3,2,2)", "#REF!"),
    ("=INDEX(A1:B3,3,2,0)", "#VALUE!"),
    ("=INDEX({1,2;3,4},2,2,1)", "4"),
    ("=INDEX({1,2;3,4},2,2,2)", "#REF!"),
    ("=INDEX({1,2;3,4},2,2,0)", "#VALUE!"),
    ("=INDEX({1,2;3,4},9,2,2)", "#REF!"),
    ("=INDEX(A1:B3,3,2,\"x\")", "#VALUE!"),
    ("=INDEX(A1:B3,3,2,1/0)", "#DIV/0!"),
    ("=INDEX(A1:B3,3,2,1.9)", "30"),
    ("=INDEX(A1:A5,3,,1)", "3"),
    ("=INDEX(A1:A5,3,1,-1)", "#VALUE!"),
    ("=INDEX(A1:B3,9,1,2)", "#REF!"),
    ("=INDEX(A1:B3,1/0,1,2)", "#DIV/0!"),
    ("=INDEX(A1:B3,\"x\",1,2)", "#VALUE!"),
    ("=INDEX(A1:B3,1,1,)", "#VALUE!"),
    ("=INDEX(A1:B3,2,2,TRUE)", "20"),
    ("=INDEX(A1:B3,2,2,\"1\")", "20"),
    ("=INDEX(A1:B3,2,2,E1)", "#VALUE!"),
    ("=INDEX(A1:B3,2,2,{1,2})", "20,#REF!"),
    ("=SUM(INDEX(A1:B3,0,1,1))", "6"),
    ("=SUM(A1:INDEX(A1:B3,2,2,1))", "33"),
    ("=SUM(A1:INDEX(A1:B3,2,2,2))", "#REF!"),
    ("=AGGREGATE(9,6,INDEX(A1:A5,2,1,2))", "#REF!"),
    ("=INDEX(A1:A5,2,1,1.5)", "2"),
    ("=ROUND(LOGEST(B1:B5,A1:A5,TRUE,TRUE),6)", "1.478758,8.056478;0.053259,0.176641;0.947325,0.168421;53.952542,3;1.530392,0.085097"),
    ("=ROUND(LOGEST(B1:B5,A1:A5,FALSE,TRUE),6)", "2.612327,1;0.135558,#N/A;0.926169,1.005326;50.17761,4;50.71349,4.042719"),
    ("=ROUND(LOGEST(B1:B5,A1:A5,FALSE,FALSE),6)", "2.612327,1"),
    ("=ROUND(LOGEST(B1:B5,A1:A5),6)", "1.478758,8.056478"),
    ("=ROUND(LOGEST(B1:B5),6)", "1.478758,8.056478"),
    ("=ROWS(LOGEST(B1:B5,A1:A5,TRUE,TRUE))", "5"),
    ("=COLUMNS(LOGEST(B1:B5,A1:A5,TRUE,TRUE))", "2"),
    ("=ROUND(LOGEST({2;5;9;20},{1,7;2,3;3,5;4,1},TRUE,TRUE),6)", "0.956059,1.969259,1.432589;0.021948,0.043895,0.189818;0.998773,0.058892,#N/A;407.082461,1,#N/A;2.823696,0.003468,#N/A"),
    ("=ROUND(LOGEST({2;5;9;20},{1,7;2,3;3,5;4,1},FALSE,TRUE),6)", "0.993533,2.130751,1;0.012629,0.021133,#N/A;0.999057,0.089183,#N/A;1059.704908,2,#N/A;16.857044,0.015907,#N/A"),
    ("=ROUND(LOGEST({2;5;9;20},{1,7;2,3;3,5;4,1}),6)", "0.956059,1.969259,1.432589"),
    ("=ROUND(LOGEST({2;5;9;21},{1;2;3;4},TRUE,TRUE),6)", "2.147257,0.9759;0.042986,0.117722;0.993712,0.09612;316.043429,2;2.919941,0.018478"),
    ("=ROUND(LOGEST({2;5;9;21},{1;2;3;4},FALSE,TRUE),6)", "2.129867,1;0.014482,#N/A;0.998901,0.07932;2725.65603,3;17.148781,0.018875"),
    ("=ROUND(LOGEST({1;2;3},{1;2;3},,TRUE),6)", "1.732051,0.605707;0.083047,0.179401;0.977654,0.117446;43.750655,1;0.603474,0.013793"),
    ("=LOGEST({1;-2;3},{1;2;3})", "#NUM!"),
    ("=LOGEST({1;2;0},{1;2;3})", "#NUM!"),
    ("=LOGEST({1;2;4},{1;2;3},\"x\")", "#VALUE!"),
    ("=ROUND(LINEST(LN({2;5;9;20}),{1,7;2,3;3,5;4,1},TRUE,TRUE),6)", "-0.044935,0.677658,0.359483;0.021948,0.043895,0.189818;0.998773,0.058892,#N/A;407.082461,1,#N/A;2.823696,0.003468,#N/A"),
    ("=ROUND(LINEST({1;2;4},{1;2;3},FALSE,TRUE),6)", "1.214286,0;0.112938,#N/A;0.982993,0.422577;115.6,2;20.642857,0.357143"),
    ("=ROUND(LINEST({1;2;4},{1;2;3},FALSE,FALSE),6)", "1.214286,0"),
    ("=ROUND(LINEST({1,2,4},{1,2,3}),6)", "1.5,-0.666667"),
    ("=ROUND(LINEST({1;2;4;7},{1,5;2,3;3,1;4,4}),6)", "0.333333,2.166667,-3"),
    ("=ROUND(LINEST({1;2;4;7;8},{1,5;2,3;3,1;4,4;5,0},TRUE,TRUE),6)", "0.318681,2.186813,-2.989011;0.098289,0.128904,0.606689;0.995274,0.2965,#N/A;210.575,2,#N/A;37.024176,0.175824,#N/A"),
    ("=ROUND(LINEST({1,2,4,7,8},{1,2,3,4,5;5,3,1,4,0},FALSE,TRUE),6)", "-0.097113,1.598425,0;0.149091,0.143567,#N/A;0.982763,0.877442,#N/A;85.523864,3,#N/A;131.690289,2.309711,#N/A"),
    ("=ROUND(LINEST({1;2;4},A1:A3),6)", "1.5,-0.666667"),
    ("=ROUND(LINEST({1;2;4},{1;2;3},TRUE,TRUE),6)", "1.5,-0.666667;0.288675,0.62361;0.964286,0.408248;27,1;4.5,0.166667"),
    ("=ROUND(LINEST({1;2;4},,TRUE,TRUE),6)", "1.5,-0.666667;0.288675,0.62361;0.964286,0.408248;27,1;4.5,0.166667"),
    ("=ROUND(LINEST({1;2;4},{1;2;3},,),6)", "1.5,-0.666667"),
    ("=ROUND(LINEST({1;2},{1;2},TRUE,TRUE),6)", "1,0;0,0;1,0;#NUM!,0;0.5,0"),
    ("=ROUND(LINEST({1;2;3;4},{1,2;2,4;3,6;4,8},TRUE,TRUE),6)", "0.5,0,0;0,0,0;1,0,#N/A;#NUM!,2,#N/A;5,0,#N/A"),
    ("=ROUND(LINEST({1;2;3;5},{1,1;2,2;3,3;4,4}),6)", "1.3,0,-0.5"),
    ("=LINEST({1;2;3},{1;2})", "#REF!"),
    ("=LINEST({1;2;\"a\"},{1;2;3})", "#VALUE!"),
    ("=LINEST(E1:E3,A1:A3)", "#VALUE!"),
    ("=LINEST({1;2;4},{1;2;3},TRUE,\"x\")", "#VALUE!"),
    ("=LINEST({1;2;4},{1;2;3},1/0)", "#DIV/0!"),
    ("=ROUND(LINEST(5),6)", "0,5"),
    ("=ROUND(LINEST(B1:B5,A1:A5),6)", "10,0"),
    ("=ROUND(LINEST({3;5;8;13},{1;2;3;4},TRUE,TRUE),6)", "3.3,-1;0.479583,1.313393;0.959471,1.072381;47.347826,2;54.45,2.3"),
    ("=ROWS(LINEST({1;2;4;7},{1,5;2,3;3,1;4,4},TRUE,TRUE))", "5"),
    ("=COLUMNS(LINEST({1;2;4;7},{1,5;2,3;3,1;4,4},TRUE,TRUE))", "3"),
    // ROUND passes an error through (lane form6 f8.txt / p8.log), which the
    // ROUND(LINEST(..,TRUE,TRUE),6) rows above rely on for their #N/A cells.
    ("=ROUND(NA(),0)", "#N/A"),
    ("=ROUND(1,1/0)", "#DIV/0!"),
    ("=ROUND({1.26,#N/A},1)", "1.3,#N/A"),
    ("=ROUND(1/0,NA())", "#DIV/0!"),
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

fn is_lambda_row(f: &str) -> bool {
    f.contains("TRANSPOSE(LAMBDA")
}
fn is_xlookup_row(f: &str) -> bool {
    !is_lambda_row(f) && f.contains("XLOOKUP")
}
fn is_aggregate_row(f: &str) -> bool {
    !is_xlookup_row(f) && f.starts_with("=AGGREGATE")
}
fn is_regression_row(f: &str) -> bool {
    f.contains("LINEST") || f.contains("LOGEST") || f.starts_with("=ROUND(")
}
fn is_blank_row(f: &str) -> bool {
    !is_lambda_row(f) && !is_xlookup_row(f) && !is_aggregate_row(f) && !is_regression_row(f) && f.contains("E1")
}
fn is_index_row(f: &str) -> bool {
    !is_lambda_row(f) && !is_xlookup_row(f) && !is_aggregate_row(f) && !is_regression_row(f) && !is_blank_row(f)
}

/// XLOOKUP: the size check, the lifted lookup_value, the blank it returns.
#[test]
fn xlookup_checks_sizes_lifts_its_lookup_value_and_returns_a_reference() {
    check(is_xlookup_row);
}

/// The same rows with a lookup-cache pass active, so the cached fast path
/// (literal same-sheet vectors, exact match, first-to-last) answers them --
/// it must agree with the scan, size check and blank included.
#[test]
fn xlookup_cached_fast_path_answers_the_same() {
    let _pass = crate::lookup_cache::begin_pass();
    check(is_xlookup_row);
}

/// An array a function builds keeps a blank as a blank element, and COUNTA
/// counts the elements of such an array; TRANSPOSE of one blank cell is 0.
#[test]
fn a_built_array_keeps_blank_elements_and_counta_counts_them() {
    check(is_blank_row);
}

/// TRANSPOSE of a LAMBDA is a 1x1 array that holds it (TYPE 64, not an
/// error), which a cell shows as #CALC!.
#[test]
fn transpose_of_a_lambda_is_an_array_holding_it() {
    check(is_lambda_row);
}

/// AGGREGATE 14-19: k's error, an array k, a reference k, #NUM! out of range.
#[test]
fn aggregate_reads_its_k_argument_as_excel_does() {
    check(is_aggregate_row);
}

/// INDEX's fourth argument, area_num.
#[test]
fn index_takes_an_area_number() {
    check(is_index_row);
}

/// LINEST / LOGEST with const, stats and several x variables.
#[test]
fn linest_and_logest_take_const_stats_and_several_variables() {
    check(is_regression_row);
}
