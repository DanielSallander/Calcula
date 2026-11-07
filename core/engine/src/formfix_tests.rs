//! FILENAME: core/engine/src/formfix_tests.rs
//! PURPOSE: Ledger programme 2, wave 3, lane `formfix` -- the error, lambda
//! and range-half rules the wave-1 formula lane left open, each as Excel 16
//! answers it: a LAMBDA used as text or as a number, COUNT / COUNTA over an
//! error, SUMPRODUCT and AGGREGATE over a whole-argument error, PIVOTBY with
//! every row filtered out, an all-blank TRIMRANGE, EXPAND of an error, numbers
//! in TEXTJOIN / CONCAT, the LET / XLOOKUP / TRIMRANGE / SINGLE range halves,
//! a cell-shaped OPTIONAL LAMBDA parameter, and a sheet-qualified name.
//!
//! [LIVE] Excel 16, 2026-11-06, lane formfix (SCRATCH/formfix/probe.ps1,
//! p1.json, p3.json): Sheet1 A1:A5 = 1..5, B1:B5 = 10..50, C1:C5 = 100..500,
//! E1:E5 and G1:G5 empty, F1 `=""`, F3 7, each formula typed into column J.

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
    let mut empty_text = Cell::new_formula("=\"\"".to_string());
    empty_text.value = CellValue::Text(String::new());
    one.set_cell(0, 5, empty_text);
    one.set_cell(2, 5, Cell::new_number(7.0));
    one
}

fn typed_cell(formula: &str) -> Cell {
    crate::typed_entry::parse_cell_input(formula, &LocaleSettings::from_locale_id("en-US"))
}

/// The typed formula evaluated in Sheet1!J10, the way Excel's `Text` shows
/// it (a spill as its cells, `;` between rows and `,` between columns).
fn typed(formula: &str) -> String {
    let cell = typed_cell(formula);
    let ast = cell.get_ast().unwrap_or_else(|| panic!("{formula} was not accepted as a formula"));
    let one = sheet();
    let mut multi = MultiSheetContext::new("Sheet1".to_string());
    multi.add_grid("Sheet1".to_string(), &one);
    multi.sheet_order = vec!["Sheet1".to_string()];
    let ctx = EvalContext { current_row: Some(9), current_col: Some(9), ..Default::default() };
    let v = Evaluator::with_context(&one, multi, ctx).evaluate(ast);
    shown(&v)
}

fn cell_text(v: &EvalResult) -> String {
    match v.to_cell_value() {
        CellValue::Number(n) => format!("{n}"),
        CellValue::Boolean(b) => if b { "TRUE".into() } else { "FALSE".into() },
        CellValue::Error(e) => e.as_literal().to_string(),
        CellValue::Text(s) => s,
        CellValue::Empty => String::new(),
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

/// [LIVE] Excel 16's answer for each formula (lane formfix p1.json, p3.json).
const EXCEL: &[(&str, &str)] = &[
    // A LAMBDA has no text and no number (W1: "#LAMBDA" text, LEN 7).
    ("=TEXTJOIN(\",\",TRUE,LAMBDA(x,x))", "#VALUE!"),
    ("=CONCAT(LAMBDA(x,x))", "#VALUE!"),
    ("=CONCATENATE(LAMBDA(x,x))", "#VALUE!"),
    ("=LEN(LAMBDA(x,x))", "#VALUE!"),
    ("=UPPER(LAMBDA(x,x))", "#VALUE!"),
    ("=LAMBDA(x,x)&\"a\"", "#VALUE!"),
    ("=\"a\"&LAMBDA(x,x)", "#VALUE!"),
    ("=LAMBDA(x,x)+1", "#VALUE!"),
    ("=LAMBDA(x,x)=1", "#VALUE!"),
    ("=N(LAMBDA(x,x))", "#VALUE!"),
    ("=T(LAMBDA(x,x))", "#VALUE!"),
    ("=VALUE(LAMBDA(x,x))", "#VALUE!"),
    ("=ISTEXT(LAMBDA(x,x))", "FALSE"),
    ("=ISERROR(LAMBDA(x,x))", "FALSE"),
    // ...and aggregates do not skip it.
    ("=SUM(LAMBDA(x,x))", "#VALUE!"),
    ("=SUM(1,LAMBDA(x,x))", "#VALUE!"),
    ("=AVERAGE(LAMBDA(x,x))", "#VALUE!"),
    ("=MAX(LAMBDA(x,x))", "#VALUE!"),
    ("=PRODUCT(LAMBDA(x,x))", "#VALUE!"),
    ("=COUNT(LAMBDA(x,x))", "0"),
    ("=COUNTA(LAMBDA(x,x))", "1"),
    // COUNT never answers an error; COUNTA counts one.
    ("=COUNT(FILTER(A1:A5,A1:A5>100))", "0"),
    ("=COUNTA(FILTER(A1:A5,A1:A5>100))", "1"),
    ("=COUNT(NA())", "0"),
    ("=COUNTA(NA())", "1"),
    ("=COUNT(1/0)", "0"),
    ("=COUNTA(1/0)", "1"),
    ("=COUNT(1,NA(),2)", "2"),
    ("=COUNTA(1,NA(),2)", "3"),
    ("=COUNT({1,2},NA())", "2"),
    ("=COUNT(IF(TRUE,NA()))", "0"),
    ("=COUNT(SQRT(-1))", "0"),
    ("=COUNT({1,#N/A,3})", "2"),
    ("=COUNTA({1,#N/A,3})", "3"),
    ("=COUNT(A1:A5,1/0)", "5"),
    ("=COUNTA(E1:E5,NA())", "1"),
    // SUMPRODUCT: an error anywhere is the answer; only numbers multiply.
    ("=SUMPRODUCT(FILTER(A1:A5,A1:A5>100))", "#CALC!"),
    ("=SUMPRODUCT(NA())", "#N/A"),
    ("=SUMPRODUCT(1/0)", "#DIV/0!"),
    ("=SUMPRODUCT({1,#N/A})", "#N/A"),
    ("=SUMPRODUCT(A1:A5,FILTER(A1:A5,A1:A5>100))", "#CALC!"),
    ("=SUMPRODUCT(SEQUENCE(0))", "#CALC!"),
    ("=SUMPRODUCT({TRUE,2})", "2"),
    ("=SUMPRODUCT({\"3\",2})", "2"),
    ("=SUMPRODUCT(TRUE)", "0"),
    // AGGREGATE: a whole-argument error whatever the option; no array in
    // the reference form.
    ("=AGGREGATE(9,6,FILTER(A1:A5,A1:A5>100))", "#CALC!"),
    ("=AGGREGATE(9,6,1/0)", "#DIV/0!"),
    ("=AGGREGATE(9,6,NA())", "#N/A"),
    ("=AGGREGATE(9,6,A1:A5,FILTER(A1:A5,A1:A5>100))", "#CALC!"),
    ("=AGGREGATE(14,6,FILTER(A1:A5,A1:A5>100),1)", "#CALC!"),
    ("=AGGREGATE(14,6,1/0,1)", "#DIV/0!"),
    ("=AGGREGATE(14,6,{1,#N/A,3},1)", "3"),
    ("=AGGREGATE(9,4,FILTER(A1:A5,A1:A5>100))", "#CALC!"),
    ("=AGGREGATE(9,6,{1,2})", "#VALUE!"),
    ("=AGGREGATE(4,6,FILTER(A1:A5,A1:A5>100))", "#CALC!"),
    ("=AGGREGATE(9,6,5)", "#VALUE!"),
    ("=AGGREGATE(9,6,FILTER(A1:A5,A1:A5>1))", "#VALUE!"),
    ("=AGGREGATE(9,6,A1:A5*1)", "#VALUE!"),
    ("=AGGREGATE(9,6,IF(TRUE,A1:A5))", "15"),
    ("=AGGREGATE(14,6,A1:A5/(A1:A5>2),1)", "5"),
    ("=AGGREGATE(14,6,5,1)", "5"),
    ("=AGGREGATE(9,6,A1:A5)", "15"),
    // ...and a call or operator that RETURNS a reference is one (lane form4,
    // [LIVE] SCRATCH/verify-formfix/p1.json J10-J146).
    ("=AGGREGATE(9,6,TRIMRANGE(A1:A5))", "15"),
    ("=AGGREGATE(9,6,A1:.A5)", "15"),
    ("=AGGREGATE(9,6,LET(r,A1:A5,r))", "15"),
    ("=AGGREGATE(9,6,TAKE(A1:A5,3))", "6"),
    ("=AGGREGATE(9,6,DROP(A1:A5,1))", "14"),
    ("=AGGREGATE(9,6,A1:A5 A2:A3)", "5"),
    ("=AGGREGATE(9,6,INDEX(A1:A5,0))", "15"),
    ("=AGGREGATE(9,6,OFFSET(A1,0,0,3))", "6"),
    ("=AGGREGATE(2,6,A1:A5,A1:A5)", "10"),
    ("=AGGREGATE(9,6,A1:INDEX(A1:A5,3))", "6"),
    ("=AGGREGATE(14,6,TRIMRANGE(A1:A5),1)", "5"),
    ("=AGGREGATE(9,6,LAMBDA(x,x)(A1:A5))", "15"),
    ("=AGGREGATE(9,6,\"5\")", "#VALUE!"),
    ("=AGGREGATE(9,6,XLOOKUP(3,A1:A5,A1:A5))", "3"),
    // A LAMBDA is no truth value; SUMPRODUCT compares rows x columns.
    ("=IF(LAMBDA(x,x),1,2)", "#VALUE!"),
    ("=SUMPRODUCT({1;2},{3,4})", "#VALUE!"),
    // PIVOTBY with every row filtered out, as GROUPBY.
    ("=PIVOTBY(A1:A5,B1:B5,C1:C5,SUM,,,,,,A1:A5>100)", "#VALUE!"),
    ("=PIVOTBY(A1:A5,B1:B5,C1:C5,SUM,0,0,,0,,A1:A5>100)", "#VALUE!"),
    ("=GROUPBY(A1:A5,C1:C5,SUM,,,,A1:A5>100)", "#VALUE!"),
    // TRIMRANGE: every row trimmed away is #REF!.
    ("=TRIMRANGE(E1:E5)", "#REF!"),
    ("=E1:.E5", "#REF!"),
    ("=E1.:.E5", "#REF!"),
    ("=E1.:E5", "#REF!"),
    ("=SUM(TRIMRANGE(E1:E5))", "#REF!"),
    ("=ROWS(TRIMRANGE(E1:E5))", "#REF!"),
    ("=SUM(E1:.E5)", "#REF!"),
    ("=ISREF(TRIMRANGE(E1:E5))", "FALSE"),
    ("=IFERROR(TRIMRANGE(E1:E5),\"x\")", "x"),
    ("=TRIMRANGE(E1:E5,1)", "#REF!"),
    ("=TRIMRANGE(E1:E5,2)", "#REF!"),
    ("=TRIMRANGE(E1:E5,3)", "#REF!"),
    ("=TRIMRANGE(E1:E5,3,0)", "#REF!"),
    ("=TRIMRANGE(E1:E5,1,1)", "#REF!"),
    ("=TRIMRANGE(E1:E5,0)", "0;0;0;0;0"),
    ("=TRIMRANGE(E1:E5,0,3)", "0;0;0;0;0"),
    ("=TRIMRANGE(E1:E5,0,1)", "0;0;0;0;0"),
    ("=TRIMRANGE(E1:E5,0,0)", "0;0;0;0;0"),
    ("=TRIMRANGE(E1:G5,0)", ";0;7;0;0"),
    ("=TRIMRANGE(E1:G5)", ";0;7"),
    ("=TRIMRANGE(E2:G5,0)", "0;7;0;0"),
    ("=TRIMRANGE(E1:G5,3,0)", "0,,0;0,0,0;0,7,0"),
    ("=TRIMRANGE(E1:G2,1,0)", "0,,0;0,0,0"),
    ("=ROWS(TRIMRANGE(E1:G5,0))", "5"),
    ("=COLUMNS(TRIMRANGE(E1:G5,3,0))", "3"),
    ("=COLUMNS(TRIMRANGE(E1:G5,0))", "1"),
    // EXPAND of an error value is that error, whole.
    ("=EXPAND(FILTER(A1:A5,A1:A5>100),2)", "#CALC!"),
    ("=EXPAND(NA(),2)", "#N/A"),
    ("=EXPAND(1/0,2,2)", "#DIV/0!"),
    ("=EXPAND(FILTER(A1:A5,A1:A5>100),2,2,0)", "#CALC!"),
    // Range halves LET, XLOOKUP, TRIMRANGE and SINGLE (`@`) follow their
    // reference.
    ("=SUM(A1:XLOOKUP(3,A1:A5,A1:A5))", "6"),
    ("=SUM(XLOOKUP(2,A1:A5,A1:A5):A4)", "9"),
    ("=SUM(A1:XLOOKUP(9,A1:A5,A1:A5,A2))", "3"),
    ("=SUM(A1:XLOOKUP(30,B1:B5,A1:C5))", "666"),
    ("=SUM(A1:XLOOKUP(9,A1:A5,A1:A5))", "#N/A"),
    ("=SUM(A1:LET(x,A3,x))", "6"),
    ("=SUM(LET(x,A2,x):A4)", "9"),
    ("=SUM(A1:LET(x,A3:A4,x))", "10"),
    ("=SUM(A1:LET(x,5,x))", "#VALUE!"),
    ("=SUM(A1:TRIMRANGE(A3:A3))", "6"),
    ("=SUM(A1:TRIMRANGE(A2:A5))", "15"),
    ("=SUM(A1:SINGLE(A3))", "6"),
    ("=SUM(A1:@A3)", "6"),
    ("=SUM(A1:SINGLE(A3:A4))", "#VALUE!"),
    // A LAMBDA-call half follows its body's reference (lane form4; formfix
    // p1.json: Excel 6).
    ("=SUM(A1:LAMBDA(x,x)(A3))", "6"),
    // A cell-shaped optional parameter makes the formula R1C1's: its plain
    // cells are names (Excel #NAME?; Calcula has no optional parameters
    // yet and answers #VALUE!, so only the reading is pinned here -- see
    // `a_cell_shaped_optional_parameter_reads_the_formula_in_r1c1`).
];

#[test]
fn every_probed_formula_answers_what_excel_does() {
    let _locale = crate::number_text::begin(crate::number_text::NumberTextLocale::of(&LocaleSettings::from_locale_id("en-US")));
    let mut wrong = Vec::new();
    for (formula, excel) in EXCEL {
        let got = typed(formula);
        if got != *excel {
            wrong.push(format!("{formula}: Calcula {got}, Excel {excel}"));
        }
    }
    assert!(wrong.is_empty(), "NOT EXCEL'S ANSWER ({} of {}):\n{}", wrong.len(), EXCEL.len(), wrong.join("\n"));
}

/// TEXTJOIN / CONCAT spell a number as `&` does: 15 significant digits in the
/// locale's decimal [LIVE, sv-SE regional settings, lane formfix p3.json:
/// `=TEXTJOIN(",",TRUE,0.1+0.2)` "0,3", `(..,1/3)` "0,333333333333333",
/// `=CONCAT(0.1+0.2)` "0,3"]. Calcula used Rust's `Display`:
/// "0.30000000000000004".
#[test]
fn textjoin_and_concat_spell_a_number_as_ampersand_does() {
    for (formula, excel) in [
        ("=TEXTJOIN(\",\",TRUE,0.1+0.2)", "0.3"),
        ("=TEXTJOIN(\",\",TRUE,1/3)", "0.333333333333333"),
        ("=CONCAT(0.1+0.2)", "0.3"),
        ("=TEXTJOIN(\"|\",TRUE,A1:A2/3)", "0.333333333333333|0.666666666666667"),
    ] {
        let _locale = crate::number_text::begin(crate::number_text::NumberTextLocale::of(&LocaleSettings::from_locale_id("en-US")));
        assert_eq!(typed(formula), excel, "{formula} (en-US)");
    }
    // The decimal separator is the evaluator's locale (`number_text::format`,
    // installed per formula), as for `&`: the sv-SE "0,3" measured live.
}

/// W2 (xlsx lane): a cell-shaped OPTIONAL parameter (`[A1]`) declares a
/// cell-shaped name like any other, so Excel reads the WHOLE formula in R1C1,
/// where a plain cell is a NAME [LIVE, lane formfix p1.json:
/// `=LAMBDA([A1],SUM(A1:A3))(B1)` is shown `=LAMBDA([A1],SUM(A1:'A3'))('B1')`
/// and filed `_xlfn.LAMBDA(_xlop.A1,SUM(_xlpm.A1:_xlnm.A3))(_xlnm.B1)`;
/// `=LAMBDA([A1],B1)(5)` is `=LAMBDA([A1],'B1')(5)`]. Calcula read A3 and B1
/// as cells. `[x]` declares nothing cell-shaped and changes nothing.
///
/// SABOTAGE (formfix-opt): `declares_cell_shaped_name` ignores an optional
/// slot -- fails at "OPTIONAL PARAMETER".
#[test]
fn a_cell_shaped_optional_parameter_reads_the_formula_in_r1c1() {
    for (formula, shown) in [
        ("=LAMBDA([A1],SUM(A1:A3))(B1)", "LAMBDA([A1],SUM(A1:'A3'))('B1')"),
        ("=LAMBDA([A1],B1)(5)", "LAMBDA([A1],'B1')(5)"),
        ("=LAMBDA(x,[A1],x+A1)(1,2)", "LAMBDA(x,[A1],x+A1)(1,2)"),
        ("=LAMBDA([x],SUM(A1:A3))(1)", "LAMBDA([x],SUM(A1:A3))(1)"),
    ] {
        let cell = typed_cell(formula);
        assert!(cell.get_ast().is_some(), "{formula} is a formula");
        assert_eq!(cell.formula_string().as_deref(), Some(shown), "OPTIONAL PARAMETER: {formula}");
    }
    let ast = parser::parse("=LAMBDA([A1],SUM(A1:A3))(B1)").expect("parses");
    assert!(parser::parser::declares_cell_shaped_name(&ast));
    assert!(!parser::parser::declares_cell_shaped_name(&parser::parse("=LAMBDA([x],SUM(A1:A3))(1)").unwrap()));
}

/// BUG-0744/0749: a SHEET-QUALIFIED NAME (`Sheet1!Dup`) is kept as typed and
/// reads back as the same name -- the host resolves it in Sheet1's scope
/// (app `formfix_lane_tests`). With no name of that spelling it is #NAME?
/// [LIVE, lane formfix p1.json: `=Sheet1!Nope` #NAME?]. W2: `Sheet1!C$3` and
/// `Sheet1!R$3` are cells [LIVE: 300 and 0].
#[test]
fn a_qualified_name_and_a_qualified_mixed_reference_round_trip() {
    for (formula, shown) in [
        ("=Sheet1!Dup+1", "SHEET1!DUP+1"),
        ("=SUM(Sheet1!RngN)", "SUM(SHEET1!RNGN)"),
        ("='My Sheet'!Rate", "'My Sheet'!RATE"),
        ("=Sheet1!C$3", "SHEET1!C$3"),
        ("=Sheet1!R$3", "SHEET1!R$3"),
    ] {
        let cell = typed_cell(formula);
        assert_eq!(cell.formula_string().as_deref(), Some(shown), "{formula}");
        let raw = cell.formula_string_raw().expect("a formula");
        assert_eq!(
            parser::parse(&format!("={raw}")).expect("reparses"),
            parser::parse(formula).expect("parses"),
            "{formula} reads back as itself"
        );
    }
    assert_eq!(typed("=Sheet1!Nope"), "#NAME?");
    assert_eq!(typed("=Sheet1!C$3"), "300");
    assert_eq!(typed("=Sheet1!R$3"), "0");
    assert_eq!(typed("=SUM(Sheet1!C$1:C$3)"), "600");
}
