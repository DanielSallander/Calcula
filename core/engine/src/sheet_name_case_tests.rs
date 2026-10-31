//! FILENAME: core/engine/src/sheet_name_case_tests.rs
//! PURPOSE: A qualified reference finds its sheet by EXCEL's sheet-name case
//!          rule, never by Rust's full uppercasing.
//!
//! WHAT WAS WRONG. `MultiSheetContext` keyed its grids by `to_uppercase()`,
//! which expands `ß` to `SS`: `Straße` and `STRASSE` -- two sheets Excel holds
//! side by side [LIVE, Excel 16] -- had one key, so whichever was registered
//! last answered for both. The 3-D range walk (`get_sheets_in_range`) and the
//! row-visibility map used the same fold. They now key by
//! `identity::sheet_name_key`, the one rule entry also enforces, which is
//! Excel's measured per-character case equivalence: `ß` and `ẞ` are one
//! character to it, `ß` and `SS` are not.

use crate::cell::Cell;
use crate::evaluator::{EvalResult, Evaluator, MultiSheetContext};
use crate::grid::Grid;

fn sheet_with(value: f64) -> Grid {
    let mut g = Grid::new();
    g.set_cell(0, 0, Cell::new_number(value));
    g
}

/// `Straße`!A1 = 1, `STRASSE`!A1 = 2, `Ärende`!A1 = 4, formula on `Report`,
/// registered in that order (the conflated map answered with the LAST).
fn evaluate_on_report(formula: &str) -> EvalResult {
    let strasse_sz = sheet_with(1.0);
    let strasse_ss = sheet_with(2.0);
    let arende = sheet_with(4.0);
    let report = Grid::new();
    let names = ["Stra\u{df}e", "STRASSE", "\u{c4}rende", "Report"];
    let grids = [&strasse_sz, &strasse_ss, &arende, &report];
    let mut ms = MultiSheetContext::new("Report".to_string());
    for (name, grid) in names.iter().zip(grids) {
        ms.add_grid(name.to_string(), grid);
    }
    ms.sheet_order = names.iter().map(|n| n.to_string()).collect();
    let ast = parser::parse(formula).expect("formula parses");
    Evaluator::with_multi_sheet(&report, ms).evaluate(&ast)
}

#[test]
fn two_names_excel_keeps_apart_are_two_sheets_to_a_formula() {
    assert_eq!(
        evaluate_on_report("='Stra\u{df}e'!A1"),
        EvalResult::Number(1.0),
        "Stra\u{df}e!A1 read STRASSE's cell: the lookup expanded \u{df} to SS"
    );
    assert_eq!(evaluate_on_report("='STRASSE'!A1"), EvalResult::Number(2.0));
    assert_eq!(evaluate_on_report("='strasse'!A1"), EvalResult::Number(2.0), "case-insensitive within ASCII");
    assert_eq!(
        evaluate_on_report("='STRA\u{1e9e}E'!A1"),
        EvalResult::Number(1.0),
        "capital sharp s is the same character as \u{df} to Excel [LIVE]"
    );
    assert_eq!(evaluate_on_report("='\u{e4}RENDE'!A1"), EvalResult::Number(4.0), "case-insensitive beyond ASCII");
}

#[test]
fn a_3d_range_finds_its_end_sheets_by_the_same_rule() {
    // Stra\u{df}e..STRASSE spans the first two tabs only: 1 + 2.
    assert_eq!(
        evaluate_on_report("=SUM('Stra\u{df}e:STRASSE'!A1)"),
        EvalResult::Number(3.0),
        "the range's end sheets were found by the conflating fold"
    );
    assert_eq!(evaluate_on_report("=SUM('strasse:\u{e4}rende'!A1)"), EvalResult::Number(6.0));
}

/// The same references typed BARE, as Excel reads and writes them
/// [LIVE, Excel 16, 2026-10-30: `=Straße!A1` -> 1, `=STRASSE!A1` -> 2,
/// `=straße!A1` -> 1, `=SUM(Straße:STRASSE!A1)` -> 3]. The lexer used to fold a
/// bare identifier with Rust's full `to_uppercase`, which would have turned
/// `Straße` into `STRASSE` -- the OTHER sheet -- and before that it did not read
/// a non-ASCII letter at all, so none of these parsed.
#[test]
fn a_bare_non_ascii_sheet_name_reads_its_own_sheet() {
    assert_eq!(
        evaluate_on_report("=Stra\u{df}e!A1"),
        EvalResult::Number(1.0),
        "bare Stra\u{df}e!A1 read STRASSE's cell: the lexer expanded \u{df} to SS"
    );
    assert_eq!(evaluate_on_report("=stra\u{df}e!A1"), EvalResult::Number(1.0));
    assert_eq!(evaluate_on_report("=STRASSE!A1"), EvalResult::Number(2.0));
    assert_eq!(evaluate_on_report("=\u{e4}RENDE!A1"), EvalResult::Number(4.0));
    assert_eq!(evaluate_on_report("=SUM(Stra\u{df}e:STRASSE!A1)"), EvalResult::Number(3.0));
    assert_eq!(evaluate_on_report("=SUM(stra\u{df}e:\u{c4}rende!A1)"), EvalResult::Number(7.0));
}

/// rev13C minor, evaluated. With K1 = 42 on the formula's sheet, Excel answers
/// `=SUM(<KELVIN SIGN>1)` with #NAME? [LIVE, rev13C kelvin.ps1] -- the Kelvin
/// sign is no ASCII K to it -- and `=<DOTLESS I>F(TRUE,1,2)` with 1. The lexer
/// folded the Kelvin sign into K with the sheet-name table and read K1 (42).
#[test]
fn the_kelvin_sign_is_no_column_letter_and_a_dotless_i_function_still_calls() {
    let mut report = Grid::new();
    report.set_cell(0, 10, Cell::new_number(42.0));
    let eval = |formula: &str| {
        let ms = MultiSheetContext::new("Report".to_string());
        let ast = parser::parse(formula).expect("formula parses");
        Evaluator::with_multi_sheet(&report, ms).evaluate(&ast)
    };
    assert_eq!(eval("=SUM(K1)"), EvalResult::Number(42.0), "control: the ASCII K1 reads 42");
    assert_ne!(
        eval("=SUM(\u{212a}1)"),
        EvalResult::Number(42.0),
        "the Kelvin sign was folded into the cell reference K1"
    );
    assert_eq!(eval("=\u{131}F(TRUE,1,2)"), EvalResult::Number(1.0));
}
