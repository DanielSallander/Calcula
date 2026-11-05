//! FILENAME: core/engine/src/formula_spelling_tests.rs
//! PURPOSE: What the formula bar shows for three typed spellings, each against
//! [LIVE] Excel 16 (lane formd, SCRATCH/formd/p1.json, p2.json; a fresh
//! Excel 16 instance's new workbook, each formula typed with `Range.Formula2`
//! into column J and read back the same way):
//!
//! - NEW-let-param-case: a LET name or LAMBDA parameter keeps its DECLARED
//!   spelling, and every use in its scope takes it (Calcula upper-cased all).
//! - NEW-r1c1-sheet-qualified: an R1C1 reference behind a sheet qualifier
//!   (`Sheet2!RC`, `Sheet2!R1C1`, `Sheet2!R[-1]C[-9]`) is the reference it
//!   means at the entry cell (Calcula refused them as parse errors).
//! - NEW-tbl-empty-brackets: `Tbl[]` is the whole table's data body
//!   (Calcula refused it).

use crate::cell::Cell;
use crate::evaluator::{EvalResult, Evaluator};
use crate::grid::Grid;
use crate::locale::LocaleSettings;

fn typed(formula: &str) -> Cell {
    crate::typed_entry::parse_cell_input(formula, &LocaleSettings::from_locale_id("en-US"))
}

/// The formula bar text of a typed formula.
fn shown(formula: &str) -> String {
    let cell = typed(formula);
    format!("={}", cell.formula_string().unwrap_or_else(|| panic!("{formula} was not accepted as a formula")))
}

/// The text a typed formula is SAVED as reads back as the same formula.
fn round_trips(formula: &str) {
    let cell = typed(formula);
    let saved = format!("={}", cell.formula_string_raw().expect("a formula"));
    let loaded = Cell::new_formula(saved.clone());
    assert_eq!(loaded.get_ast(), cell.get_ast(), "{formula}: saved as {saved}, which loads as another formula");
}

/// [LIVE] Excel 16: typed text, then the formula bar's text.
const LET_CASE: &[(&str, &str)] = &[
    ("=LET(Abc,1,ABC+abc)", "=LET(Abc,1,Abc+Abc)"),
    ("=LAMBDA(x,x*2)(5)", "=LAMBDA(x,x*2)(5)"),
    ("=LAMBDA(X,x*2)(5)", "=LAMBDA(X,X*2)(5)"),
    ("=LET(myVal,2,MYVAL*myval)", "=LET(myVal,2,myVal*myVal)"),
    ("=LET(x,1,LET(X,2,x))", "=LET(x,1,LET(X,2,X))"),
    ("=LAMBDA(aB,Ab+1)(1)", "=LAMBDA(aB,aB+1)(1)"),
    ("=LET(Ab,1,SUM(Ab,aB))", "=LET(Ab,1,SUM(Ab,Ab))"),
    ("=LET(Abc,1,Abc)", "=LET(Abc,1,Abc)"),
    ("=LET(Straße,1,STRAßE)", "=LET(Straße,1,Straße)"),
    ("=LET(äb,1,ÄB)", "=LET(äb,1,äb)"),
    ("=LET(x,1,y,LAMBDA(X,X+x),y(5))", "=LET(x,1,y,LAMBDA(X,X+X),y(5))"),
    ("=LAMBDA(Total,LET(total,Total*2,TOTAL))(3)", "=LAMBDA(Total,LET(total,Total*2,total))(3)"),
    ("=LET(_Ab,1,_AB)", "=LET(_Ab,1,_Ab)"),
];

#[test]
fn a_let_name_or_lambda_parameter_is_shown_as_declared_as_excel_shows_it() {
    let mut wrong = Vec::new();
    for (formula, expected) in LET_CASE {
        let got = shown(formula);
        if &got != expected {
            wrong.push(format!("{formula}: Excel {expected}, Calcula {got}"));
        }
        round_trips(formula);
    }
    assert!(wrong.is_empty(), "{} disagreement(s):\n{}", wrong.len(), wrong.join("\n"));
}

/// The spelling is display only: the values are Excel's [LIVE] (J1730..J1842).
#[test]
fn a_respelled_name_still_binds_as_excel_binds_it() {
    let grid = Grid::new();
    let value = |formula: &str| Evaluator::new(&grid).evaluate(typed(formula).get_ast().expect("a formula"));
    for (formula, expected) in [
        ("=LET(Abc,1,ABC+abc)", 2.0),
        ("=LAMBDA(X,x*2)(5)", 10.0),
        ("=LET(myVal,2,MYVAL*myval)", 4.0),
        ("=LET(x,1,LET(X,2,x))", 2.0),
        ("=LET(x,1,y,LAMBDA(X,X+x),y(5))", 10.0),
        ("=LAMBDA(Total,LET(total,Total*2,TOTAL))(3)", 6.0),
        ("=LET(äb,1,ÄB)", 1.0),
    ] {
        assert_eq!(value(formula), EvalResult::Number(expected), "{formula}");
    }
    // An UNBOUND name keeps the lexer's spelling: a defined name, a sheet's
    // name and an R1C1 reference compare exactly as before.
    assert_eq!(shown("=rate*2"), "=RATE*2");
    assert_eq!(shown("=LET(x,1,x+rate)"), "=LET(x,1,x+RATE)");
}

/// [LIVE] Excel 16: the cell (0-based row, col) the formula was typed into,
/// the typed text, and the formula bar's text.
const SHEET_R1C1: &[(u32, u32, &str, &str)] = &[
    (1857, 9, "=Sheet2!RC", "=Sheet2!J1858"),
    (1865, 9, "=Sheet2!R1C1", "=Sheet2!$A$1"),
    (1873, 9, "=Sheet2!R[-1]C[-9]", "=Sheet2!A1873"),
    (1881, 9, "=Sheet2!RC[-9]", "=Sheet2!A1882"),
    (1889, 9, "=Sheet2!R[1]C", "=Sheet2!J1891"),
    (1897, 9, "=Sheet2!R2C", "=Sheet2!J$2"),
    (1905, 9, "=Sheet2!R2C1", "=Sheet2!$A$2"),
    (1913, 9, "=SUM(Sheet2!C[-9])", "=SUM(Sheet2!A:A)"),
    (1921, 9, "=SUM(Sheet2!R[-1])", "=SUM(Sheet2!1921:1921)"),
    (1929, 9, "=SUM(Sheet2!C)", "=SUM(Sheet2!J:J)"),
    (1937, 9, "=SUM(Sheet2!R)", "=SUM(Sheet2!1938:1938)"),
    (1945, 9, "=SUM(Sheet2!R1C1:R2C1)", "=SUM(Sheet2!$A$1:$A$2)"),
    (1953, 9, "=SUM(Sheet2!R[-1]C[-9]:R[1]C[-9])", "=SUM(Sheet2!A1953:A1955)"),
    (2009, 9, "='Sheet2'!RC", "=Sheet2!J2010"),
    (2017, 9, "=SUM(Sheet1:Sheet2!RC)", "=SUM(Sheet1:Sheet2!J2018)"),
    (2025, 9, "=SUM(Sheet1:Sheet2!R1C1)", "=SUM(Sheet1:Sheet2!$A$1)"),
    (2033, 9, "=Sheet2!rc", "=Sheet2!J2034"),
    (2041, 9, "=Sheet2!$A$1", "=Sheet2!$A$1"),
    (2113, 9, "=LET(A1,5,A1+Sheet2!RC)", "=LET(A1,5,A1+Sheet2!J2114)"),
    // Not R1C1: an A1 cell and an A1 column range behind the qualifier.
    (897, 9, "=SUM(Sheet2!RC:RC)", "=SUM(Sheet2!RC:RC)"),
    (0, 9, "=Sheet2!C1", "=Sheet2!C1"),
    (0, 9, "=Sheet2!RC4", "=Sheet2!RC4"),
];

#[test]
fn a_sheet_qualified_r1c1_reference_is_the_reference_excel_reads() {
    let mut wrong = Vec::new();
    for (row, col, formula, expected) in SHEET_R1C1 {
        let cell = typed(formula);
        let Some(ast) = cell.get_ast() else {
            wrong.push(format!("{formula}: Excel {expected}, Calcula refused it"));
            continue;
        };
        let mut ast = ast.clone();
        parser::resolve_r1c1_names(&mut ast, *row, *col, &|_| false);
        // A bare sheet name is folded by the lexer; the host restamps the
        // sheet's own spelling (`restamp_workbook_name_casing`), which this
        // engine-only test stands in for.
        let got = format!("={}", crate::ast_render::render_formula(&ast)).replace("SHEET1", "Sheet1").replace("SHEET2", "Sheet2");
        if &got != expected {
            wrong.push(format!("{formula}: Excel {expected}, Calcula {got}"));
        }
    }
    assert!(wrong.is_empty(), "{} disagreement(s):\n{}", wrong.len(), wrong.join("\n"));
}

/// [LIVE] Excel 16 (table Tbl, 3 data rows x 2 columns): `=ROWS(Tbl[])` 3,
/// `=SUM(Tbl[])` 9, `=COLUMNS(Tbl[])` 2, `=Tbl[]` and `=ABS(Tbl[])` spill
/// 3x2, `=SUM(Tbl[ ])` 9. The host resolves the whole table to the body.
///
/// THE FORMULA BAR SHOWS THE BARE NAME (NEW-bare-table-name): [LIVE, Excel 16,
/// lane formd p1 F2 column, lane namese p1] `=ROWS(Tbl[])` shows `=ROWS(Tbl)`
/// while `=ROWS(Tbl[#Data])` keeps `[#Data]`. This pinned `Tbl[#Data]` for
/// the empty brackets until the whole table had a specifier of its own
/// (`TableSpecifier::Whole`); the stored text is `Tbl[]`, Excel's file text.
#[test]
fn empty_brackets_are_the_whole_table() {
    for (formula, expected) in [
        ("=Tbl[]", "=Tbl"),
        ("=ROWS(Tbl[])", "=ROWS(Tbl)"),
        ("=SUM(Tbl[])", "=SUM(Tbl)"),
        ("=ABS(Tbl[])", "=ABS(Tbl)"),
        ("=Tbl[]+0", "=Tbl+0"),
        ("=COLUMNS(Tbl[])", "=COLUMNS(Tbl)"),
        ("=SUM(Tbl[ ])", "=SUM(Tbl)"),
    ] {
        // The table's own spelling is the host's to restamp, as a sheet's.
        assert_eq!(shown(formula).replace("TBL", "Tbl"), expected, "{formula}");
        round_trips(formula);
    }
}
