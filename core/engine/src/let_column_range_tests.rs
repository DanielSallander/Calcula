//! FILENAME: core/engine/src/let_column_range_tests.rs
//! PURPOSE: Inside a LET or a LAMBDA, a bare `B:B` whose letters are a
//! parameter's name is the RANGE OPERATOR between two names, not column B.
//!
//! [LIVE] Excel 16, round 18, COM, a fresh workbook with A1:A3 = 10, 20, 30,
//! B1:B3 = 1, 5, 6 and D1 = 100 (scratchpad calcref/probe-let.ps1):
//!
//!   =LET(b,2,SUM(B:B)*b)          #VALUE!   (stored `SUM(b:b)*b`)
//!   =LET(b,A1:A3,SUM(B:B))        60        (b:b is A1:A3)
//!   =LET(b,2,SUM(B:D))            #NAME?    (stored `SUM(b:D)`: D is a name too)
//!   =LET(b,A1,d,A3,SUM(B:D))      60        (b:d is A1:A3)
//!   =LAMBDA(b,SUM(B:B))(2)        #VALUE!
//!   =LAMBDA(b,SUM(B:B))(A1:A2)    30
//!   =LET(b,2,SUM($B:$B))          12        (absolute: the column)
//!   =LET(b,2,SUM(Sheet1!B:B))     12        (qualified: the column)
//!   =LET(x,2,SUM(B:B))            12        (b is not bound: the column)
//!   =LET(b,A2,b:b)                20
//!   =LET(b,A1:A3,ROWS(B:B))       3
//!   =LET(b,SUM(B:B),b)            12        (b is not bound in its own value)
//!   =LET(b,2,c,SUM(B:B),c)        #VALUE!   (a later value sees b)
//!   =LET(b,A1:A3,LET(b,2,SUM(B:B)))          #VALUE!   (the inner b hides the outer)
//!   =LET(b,A1:A3,x,LAMBDA(b,SUM(B:B))(2),x)  #VALUE!   (so does a LAMBDA parameter)
//!
//! Calcula's lexer read every one of the bare spellings as column B and
//! answered 12 (or 24). The parser now rewrites a bare column range whose
//! FIRST letters a binder in scope names (round 20: the second half alone
//! does not -- `=LET(b,2,SUM(A:B))` is columns A:B) into `Range { NamedRef, NamedRef }`
//! (`parser::bind_parameter_column_ranges`) and the evaluator resolves it
//! against the binding (`Evaluator::eval_bound_name_range`).

use crate::cell::{Cell, CellError};
use crate::evaluator::{EvalResult, Evaluator};
use crate::grid::Grid;

fn sheet() -> Grid {
    let mut grid = Grid::new();
    for (row, a, b) in [(0u32, 10.0, 1.0), (1, 20.0, 5.0), (2, 30.0, 6.0)] {
        grid.set_cell(row, 0, Cell::new_number(a));
        grid.set_cell(row, 1, Cell::new_number(b));
    }
    grid.set_cell(0, 3, Cell::new_number(100.0));
    grid
}

fn eval(formula: &str) -> EvalResult {
    let grid = sheet();
    let ast = parser::parse(formula).expect("formula parses");
    Evaluator::new(&grid).evaluate(&ast)
}

fn number(formula: &str) -> f64 {
    match eval(formula) {
        EvalResult::Number(n) => n,
        other => panic!("{formula} gave {other:?}, expected a number"),
    }
}

#[test]
fn a_bare_column_range_named_by_a_let_parameter_is_the_parameters_range() {
    assert_eq!(
        eval("=LET(b,2,SUM(B:B)*b)"),
        EvalResult::Error(CellError::Value),
        "=LET(b,2,SUM(B:B)*b) summed column B; Excel reads b:b and answers #VALUE!"
    );
    assert_eq!(number("=LET(b,A1:A3,SUM(B:B))"), 60.0, "b:b is the range b is bound to");
    assert_eq!(
        eval("=LET(b,2,SUM(B:D))"),
        EvalResult::Error(CellError::Name),
        "b:D -- the other letter is a name too, and no name D exists"
    );
    assert_eq!(number("=LET(b,A1,d,A3,SUM(B:D))"), 60.0, "b:d spans A1 and A3");
    assert_eq!(number("=LET(b,A2,b:b)"), 20.0, "b bound to a single cell is that cell");
    assert_eq!(number("=LET(b,A1:A3,ROWS(B:B))"), 3.0);
    // A later value sees an earlier name; an inner LET of the same name hides
    // the outer reference [LIVE: both #VALUE!].
    assert_eq!(eval("=LET(b,2,c,SUM(B:B),c)"), EvalResult::Error(CellError::Value));
    assert_eq!(eval("=LET(b,A1:A3,LET(b,2,SUM(B:B)))"), EvalResult::Error(CellError::Value));
}

#[test]
fn a_lambda_parameter_shadows_the_column_the_same_way() {
    assert_eq!(eval("=LAMBDA(b,SUM(B:B))(2)"), EvalResult::Error(CellError::Value));
    assert_eq!(number("=LAMBDA(b,SUM(B:B))(A1:A2)"), 30.0);
    // A LAMBDA parameter hides an outer LET reference of the same name: b is
    // the value 2 inside the lambda.
    assert_eq!(eval("=LET(b,A1:A3,LAMBDA(b,SUM(B:B))(2))"), EvalResult::Error(CellError::Value));
    assert_eq!(eval("=LET(b,A1:A3,x,LAMBDA(b,SUM(B:B))(2),x)"), EvalResult::Error(CellError::Value));
}

#[test]
fn an_absolute_qualified_or_unbound_column_range_stays_the_column() {
    assert_eq!(number("=LET(b,2,SUM($B:$B))"), 12.0);
    assert_eq!(number("=LET(x,2,SUM(B:B))"), 12.0);
    assert_eq!(number("=SUM(B:B)"), 12.0);
    // A LET value sees only the names bound BEFORE it: b is not yet bound in
    // its own value, so B:B there is the column [LIVE: 12].
    assert_eq!(number("=LET(b,SUM(B:B),b)"), 12.0);
    // Outside the LET the column again.
    assert_eq!(number("=LET(b,2,b)+SUM(B:B)"), 14.0);
}

#[test]
fn the_rewrite_renders_back_to_the_same_text() {
    let ast = parser::parse("=LET(b,2,SUM(B:B)*b)").expect("parses");
    let text = crate::ast_render::render_formula(&ast);
    // Excel stores the range of the parameter in the parameter's spelling,
    // `SUM(b:b)` ([LIVE] round 18, above), and so does Calcula since lane formd
    // kept LET names as declared; the text reads back as the same tree.
    assert!(text.contains("SUM(b:b)"), "{text}");
    assert_eq!(parser::parse(&format!("={text}")).expect("reparses"), ast, "{text}");
}

/// The sheet of Excel's round-19/20 probes (xlpm2/probeA.ps1, parsefix/probe1.ps1):
/// A1:A5 = 1..5, B1:B5 = 10..50, C1:C5 = 100..500.
fn probe_sheet() -> Grid {
    let mut grid = Grid::new();
    for i in 0..5u32 {
        let n = f64::from(i + 1);
        grid.set_cell(i, 0, Cell::new_number(n));
        grid.set_cell(i, 1, Cell::new_number(10.0 * n));
        grid.set_cell(i, 2, Cell::new_number(100.0 * n));
    }
    grid
}

/// ONLY THE FIRST HALF MAKES A BARE COLUMN RANGE A NAME RANGE. Every row is
/// Excel 16's own value for the same formula on the same sheet [LIVE, rounds
/// 19/20: xlpm2 probeA, rev18x excel-own.json / excel-own2.json, parsefix
/// probe1]. Calcula bound `A:B` whenever EITHER half named a parameter, so
/// `=LET(b,2,SUM(A:B))` read `A:b` -- an unbound name A, #NAME? -- where Excel
/// sums columns A and B.
#[test]
fn a_bare_column_range_is_a_name_range_only_when_its_first_half_is_bound() {
    use CellError::{Name, Value};
    enum Want {
        N(f64),
        E(CellError),
    }
    use Want::{E, N};
    let rows: &[(&str, Want)] = &[
        // Second half bound, first not: the columns.
        ("=LET(b,2,SUM(A:B))", N(165.0)),
        ("=LET(c,2,SUM(A:C)*c)", N(3330.0)),
        ("=LET(b,2,SUM(A:B,b))", N(167.0)),
        // First half bound: the range operator between names.
        ("=LET(b,2,SUM(B:B)*b)", E(Value)),
        ("=LET(ab,2,SUM(AB:AB)+ab)", E(Value)),
        ("=LET(a,1,SUM(A:A)+a)", E(Value)),
        ("=LET(c,2,SUM(C:C)*c)", E(Value)),
        ("=LET(r,2,SUM(R:R)*r)", E(Value)),
        ("=LET(xfd,2,SUM(XFD:XFD)+xfd)", E(Value)),
        ("=LET(a,1,SUM(A:D)+a)", E(Name)),
        ("=LET(a,1,SUM(A:B)+a)", E(Name)),
        ("=LET(a,1,b,2,SUM(A:B)+a+b)", E(Value)),
        ("=LET(a,1,c,2,SUM(A:C)+a+c)", E(Value)),
        ("=LET(a,A1:A3,b,B1:B3,SUM(A:B))", N(66.0)),
        ("=LET(b,A1:A3,d,A2,SUM(B:D))", N(6.0)),
        // A second half of bare C / R nothing binds: R1C1's own column / row.
        ("=LET(a,1,SUM(A:C)+a)", E(Value)),
        ("=LET(a,1,SUM(A:c))", E(Value)),
        ("=LET(b,2,SUM(B:C)*b)", E(Value)),
        ("=LET(ab,1,SUM(AB:C)+ab)", E(Value)),
        ("=LET(a,1,SUM(A:R)+a)", E(Value)),
        ("=LAMBDA(b,SUM(B:C)*b)(2)", E(Value)),
        ("=LAMBDA(b,SUM(B:R)*b)(2)", E(Value)),
        ("=LET(a,{1,2},SUM(A:C))", E(Value)),
        ("=LET(a,A1,SUM(A:C))", E(Name)),
        // Absolute: the column whatever binds b.
        ("=LET(b,2,SUM($B:$B)*b)", N(300.0)),
        ("=LET(b,2,SUM($B:B)*b)", N(300.0)),
    ];
    let grid = probe_sheet();
    let mut wrong = Vec::new();
    for (formula, want) in rows {
        let ast = parser::parse(formula).expect("formula parses");
        let got = Evaluator::new(&grid).evaluate(&ast);
        let ok = match (want, &got) {
            (N(n), EvalResult::Number(g)) => (n - g).abs() < 1e-9,
            (E(e), EvalResult::Error(g)) => e == g,
            _ => false,
        };
        if !ok {
            wrong.push(format!("{formula} gave {got:?}"));
        }
    }
    assert!(wrong.is_empty(), "NOT EXCEL'S VALUE:\n{}", wrong.join("\n"));
}

// ---------------------------------------------------------------------------
// BUG-0646: the range operator between a NAME and a CELL, a spill after a
// name, and a sheet-qualified second half.
//
// [LIVE] Excel 16, parser lane probe (scratchpad parser-probe/probe.ps1), with
// A1:A5 = 1..5, B1:B5 = 10..50, C1:C5 = 100..500:
//
//   =LET(a,B2,SUM(a:C3))                   550      (B2:C3)
//   =LET(a,B2,SUM(C3:a))                   550
//   =LET(b,A3,SUM(A1:b))                   6        (A1:A3)
//   =LET(a,1,SUM(a:C3))                    #VALUE!  (a is no reference)
//   =SUM(A:C3)                             #NAME?   (A is a name, unbound)
//   =SUM(A1:B)                             #NAME?
//   =LET(a,SEQUENCE(3),SUM(a#))            #VALUE!
//   =LET(a,1,SUM(Sheet1!A1:Sheet1!A3)+a)   7, shown with both qualifiers
//   =SUM(Sheet1!A1:Sheet2!A3)              #VALUE!
//
// Every one of these was a PARSE error, so `Cell::new_formula` stored the
// typed text as a text value.
// ---------------------------------------------------------------------------

fn eval_probe(formula: &str) -> EvalResult {
    let grid = probe_sheet();
    let ast = parser::parse(formula).unwrap_or_else(|e| panic!("{formula} must parse: {e}"));
    Evaluator::new(&grid).evaluate(&ast)
}

#[test]
fn a_name_half_beside_a_cell_half_is_the_range_operator() {
    assert_eq!(eval_probe("=LET(a,B2,SUM(a:C3))"), EvalResult::Number(550.0));
    assert_eq!(eval_probe("=LET(a,B2,SUM(C3:a))"), EvalResult::Number(550.0));
    assert_eq!(eval_probe("=LET(b,A3,SUM(A1:b))"), EvalResult::Number(6.0));
    assert_eq!(eval_probe("=LET(a,1,SUM(a:C3))"), EvalResult::Error(CellError::Value));
    assert_eq!(eval_probe("=SUM(A:C3)"), EvalResult::Error(CellError::Name));
    assert_eq!(eval_probe("=SUM(A1:B)"), EvalResult::Error(CellError::Name));
    // Controls: the shapes that always parsed still mean what they meant.
    assert_eq!(eval_probe("=SUM(A1:B2)"), EvalResult::Number(33.0));
    assert_eq!(eval_probe("=SUM(A:B)"), EvalResult::Number(165.0));
}

#[test]
fn a_spill_after_a_name_bound_to_a_value_is_a_value_error() {
    assert_eq!(eval_probe("=LET(a,SEQUENCE(3),SUM(a#))"), EvalResult::Error(CellError::Value));
    assert_eq!(eval_probe("=SUM(nobody#)"), EvalResult::Error(CellError::Name));
    let ast = parser::parse("=LET(a,SEQUENCE(3),SUM(a#))").expect("parses");
    // The LET name keeps its declared spelling (lane formd, [LIVE] Excel 16).
    assert_eq!(crate::ast_render::render_formula(&ast), "LET(a,SEQUENCE(3),SUM(a#))");
}

#[test]
fn a_sheet_qualified_second_half_is_the_range_on_one_sheet_and_value_on_two() {
    assert_eq!(eval_probe("=LET(a,1,SUM(Sheet1!A1:Sheet1!A3)+a)"), EvalResult::Number(7.0));
    assert_eq!(eval_probe("=SUM(Sheet1!$A$1:Sheet1!$A$3)"), EvalResult::Number(6.0));
    assert_eq!(eval_probe("=SUM(Sheet1!A1:'Sheet1'!A3)"), EvalResult::Number(6.0));
    assert_eq!(eval_probe("=SUM(Sheet1!A1:Sheet2!A3)"), EvalResult::Error(CellError::Value));
    // The formula bar keeps BOTH qualifiers, as Excel's does.
    for (typed, shown) in [
        ("=SUM(Sheet1!A1:Sheet1!A3)", "SUM(SHEET1!A1:SHEET1!A3)"),
        ("=SUM(Sheet1!$A$1:Sheet1!$A$3)", "SUM(SHEET1!$A$1:SHEET1!$A$3)"),
        ("=SUM('My Sheet'!A1:'My Sheet'!A3)", "SUM('My Sheet'!A1:'My Sheet'!A3)"),
        // Control: one qualifier renders one.
        ("=SUM(Sheet1!A1:A3)", "SUM(SHEET1!A1:A3)"),
    ] {
        let ast = parser::parse(typed).expect("parses");
        assert_eq!(crate::ast_render::render_formula(&ast), shown, "{typed}");
        let again = parser::parse(&format!("={shown}")).expect("the rendered text parses back");
        assert_eq!(again, ast, "{typed}: render then parse is a fixed point");
    }
}

/// NEW-let-scope-fold. A LET name or LAMBDA parameter is bound and looked up by
/// Excel's per-character fold, never `to_uppercase` (which makes `ß` `SS`).
/// [LIVE, Excel 16, lane formd p1 J1794 / J1802, lane namese p2 J9 / J10]
/// `=LET(Straße,1,STRASSE)` and `=LAMBDA(Straße,STRASSE)(1)` are #NAME?;
/// `=LET(Straße,1,STRAẞE)` and `=LAMBDA(Straße,STRAẞE)(1)` are 1.
#[test]
fn a_let_or_lambda_binding_is_found_by_the_per_character_fold() {
    assert_eq!(eval("=LET(Straße,1,STRASSE)"), EvalResult::Error(CellError::Name));
    assert_eq!(eval("=LAMBDA(Straße,STRASSE)(1)"), EvalResult::Error(CellError::Name));
    assert_eq!(number("=LET(Straße,1,STRAẞE)"), 1.0);
    assert_eq!(number("=LAMBDA(Straße,STRAẞE)(1)"), 1.0);
    assert_eq!(number("=LET(straße,2,Straße*3)"), 6.0);
    // ASCII case still folds.
    assert_eq!(number("=LET(Abc,1,ABC+abc)"), 2.0);
}
