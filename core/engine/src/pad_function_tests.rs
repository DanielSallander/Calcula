//! FILENAME: core/engine/src/pad_function_tests.rs
//! PURPOSE: LPAD and RPAD — Calcula's two padding functions, which Excel does
//!          not have — pinned to the Snowflake semantics the owner chose
//!          (2026-10-08) and to the spreadsheet rules the rest of the text
//!          family already follows.
//!
//! WHY SNOWFLAKE AND NOT "WHAT A USER MIGHT GUESS". There is no Excel LPAD to
//! be compatible with, so the function had to borrow its meaning from
//! somewhere, and the one decision that is easy to get backwards is what
//! happens when the text is ALREADY LONGER than the requested length. Snowflake
//! (and Oracle, and Postgres) cut it to its LEFT-MOST `length` characters for
//! BOTH functions — `LPAD('Twelve Dollars',10,'$')` is `'Twelve Dol'`, not
//! `'ve Dollars'`. A user who reads "LPAD pads on the left" may expect the
//! RIGHT end to survive; that expectation is wrong in every SQL dialect the
//! model engine pushes LPAD down to, and a workbook formula that disagreed with
//! the same name one layer down would be the worse surprise. The doc says so.
//!
//! THE SPREADSHEET ADJUSTMENTS, each one a place where a SQL rule has no
//! meaning in a grid and the text family's existing rule wins instead:
//!
//!   * a NEGATIVE length is `#VALUE!` (LEFT/RIGHT/MID/REPT all refuse; Postgres
//!     returns ''), and a non-integer one is cut toward zero like LEFT's;
//!   * a length above 32,767 — Excel's cell-text ceiling, `MAX_CELL_TEXT_LEN` —
//!     is `#VALUE!` ALWAYS, decided before anything is allocated, so
//!     `LPAD("a",1e20)` is an answer rather than an abort;
//!   * a BLANK text is `""` (spreadsheets have no NULL), and numbers and
//!     booleans are coerced exactly as LEFT coerces them, in the workbook's
//!     decimal dialect;
//!   * an OMITTED pad — `LPAD(A1,5)` or `LPAD(A1,5,)` — is one space, while a
//!     pad that is a REFERENCE to an empty cell is the empty string and so pads
//!     nothing. That split is BUG-0114's rule: an empty slot means "the
//!     default", a blank cell means "this value".
//!
//! CHARACTERS, NOT BYTES. Every Unicode case uses a string whose byte and
//! character lengths differ, for the reason `text_character_semantics_tests`
//! gives: an ASCII fixture cannot catch `str::len()`.
//!
//! WHY A FILE OF ITS OWN. The other test files each pin ONE cross-cutting rule
//! (error propagation, array lifting, omitted slots) across the whole family,
//! and LPAD/RPAD join each of those lists too. This file is the place that
//! states what the two functions MEAN.

use crate::budget::MAX_CELL_TEXT_LEN;
use crate::cell::{Cell, CellError, CellValue};
use crate::evaluator::{EvalResult, Evaluator};
use crate::grid::Grid;
use crate::locale::LocaleSettings;

fn eval_on(grid: &Grid, formula: &str) -> EvalResult {
    let ast = parser::parse(formula).unwrap_or_else(|e| panic!("`{}` does not parse: {}", formula, e));
    Evaluator::new(grid).evaluate(&ast)
}

fn eval(formula: &str) -> EvalResult {
    eval_on(&Grid::new(), formula)
}

fn text(formula: &str) -> String {
    match eval(formula) {
        EvalResult::Text(t) => t,
        other => panic!("`{}` gave {:?}, expected text", formula, other),
    }
}

fn t(s: &str) -> EvalResult {
    EvalResult::Text(s.to_string())
}

fn value_error(formula: &str) {
    assert_eq!(eval(formula), EvalResult::Error(CellError::Value), "{formula} should be #VALUE!");
}

// ===========================================================================
// SNOWFLAKE'S OWN EXAMPLES — the binding semantics, verbatim
// ===========================================================================

#[test]
fn snowflake_examples_pad_on_the_requested_side() {
    assert_eq!(text("=LPAD(\"5\",8,\"0\")"), "00000005");
    assert_eq!(text("=LPAD(\"Hi\",10,\"$\")"), "$$$$$$$$Hi");
    assert_eq!(text("=RPAD(\"Hi\",10,\"$\")"), "Hi$$$$$$$$");
    assert_eq!(text("=LPAD(\"abc\",5,\"0\")"), "00abc");
    assert_eq!(text("=RPAD(\"abc\",5,\"0\")"), "abc00");
}

/// THE DECISION MOST LIKELY TO BE "FIXED" BY SOMEONE WHO HAS NOT READ THE
/// HEADER: an over-long text keeps its LEFT end for BOTH functions.
#[test]
fn a_text_longer_than_length_is_cut_to_its_left_most_characters_for_both() {
    assert_eq!(text("=LPAD(\"Twelve Dollars\",10,\"$\")"), "Twelve Dol");
    assert_eq!(text("=RPAD(\"Twelve Dollars\",10,\"$\")"), "Twelve Dol");
    // Exactly the length: untouched, no padding, no cut.
    assert_eq!(text("=LPAD(\"abcde\",5,\"0\")"), "abcde");
    assert_eq!(text("=RPAD(\"abcde\",5,\"0\")"), "abcde");
}

/// A multi-character pad is repeated FROM ITS OWN START and cut where the
/// space runs out — for RPAD too, which is the half a "repeat the pad, then
/// take the right-most characters" implementation gets wrong.
#[test]
fn a_multi_character_pad_cycles_from_its_start_and_is_cut() {
    assert_eq!(text("=LPAD(\"123.50\",19,\"*_\")"), "*_*_*_*_*_*_*123.50");
    assert_eq!(text("=RPAD(\"123.50\",19,\"*_\")"), "123.50*_*_*_*_*_*_*");
    assert_eq!(text("=LPAD(\"x\",6,\"abc\")"), "abcabx");
    assert_eq!(text("=RPAD(\"x\",6,\"abc\")"), "xabcab");
}

/// An EMPTY pad inserts nothing, but the text is still cut.
#[test]
fn an_empty_pad_pads_nothing_but_still_cuts() {
    assert_eq!(text("=LPAD(\"abc\",2,\"\")"), "ab");
    assert_eq!(text("=RPAD(\"abc\",2,\"\")"), "ab");
    assert_eq!(text("=LPAD(\"abc\",5,\"\")"), "abc");
    assert_eq!(text("=RPAD(\"abc\",5,\"\")"), "abc");
}

// ===========================================================================
// THE DEFAULT PAD — omitted vs. blank
// ===========================================================================

#[test]
fn an_omitted_pad_is_one_space() {
    assert_eq!(text("=LPAD(\"a\",3)"), "  a");
    assert_eq!(text("=RPAD(\"a\",3)"), "a  ");
    // The empty slot is the SAME default (BUG-0114), not zero and not "".
    assert_eq!(text("=LPAD(\"a\",3,)"), "  a");
    assert_eq!(text("=RPAD(\"a\",3,)"), "a  ");
}

/// A pad that REFERENCES an empty cell is that cell's value — the empty
/// string — so nothing is padded. If this ever answers "  a", the lift has
/// started handing a blank cell to the function as an omitted slot.
#[test]
fn a_pad_that_references_an_empty_cell_pads_nothing() {
    let mut g = Grid::new();
    g.set_cell(0, 0, Cell::new_text("a".to_string()));
    assert_eq!(eval_on(&g, "=LPAD(A1,3,B1)"), t("a"));
    assert_eq!(eval_on(&g, "=RPAD(A1,3,B1)"), t("a"));
    // And a cell holding the empty-string result of a formula is the same.
    assert_eq!(eval_on(&g, "=LPAD(A1,3,\"\")"), t("a"));
}

// ===========================================================================
// LENGTH
// ===========================================================================

#[test]
fn length_zero_is_the_empty_string() {
    assert_eq!(text("=LPAD(\"abc\",0,\"0\")"), "");
    assert_eq!(text("=RPAD(\"abc\",0,\"0\")"), "");
}

#[test]
fn a_non_integer_length_is_cut_toward_zero() {
    assert_eq!(text("=LPAD(\"a\",2.9,\"0\")"), "0a");
    assert_eq!(text("=RPAD(\"a\",2.9,\"0\")"), "a0");
    assert_eq!(text("=LPAD(\"abc\",0.5,\"0\")"), "");
}

#[test]
fn a_negative_length_is_value_error() {
    value_error("=LPAD(\"a\",-1,\"0\")");
    value_error("=RPAD(\"a\",-1,\"0\")");
    // Negative but above -1 still refuses, as LEFT does: the sign is checked
    // BEFORE the cut toward zero, so -0.5 is not quietly 0.
    value_error("=LPAD(\"a\",-0.5,\"0\")");
}

/// THE CEILING. 32,767 is Excel's cell-text limit (`MAX_CELL_TEXT_LEN`); the
/// refusal is on the REQUESTED length, always — even where the result would
/// have been short (`LPAD("abc",40000,"")` would only be "abc") — because
/// "the length you asked for is out of range" is one rule a user can predict,
/// and "it depends on the pad" is not (owner decision 2026-10-08).
#[test]
fn length_is_limited_to_the_excel_cell_text_ceiling() {
    assert_eq!(MAX_CELL_TEXT_LEN, 32_767, "the doc and the tests quote this number");
    match eval("=LPAD(\"a\",32767,\"x\")") {
        EvalResult::Text(s) => {
            assert_eq!(s.chars().count(), 32_767);
            assert!(s.ends_with("xa"));
        }
        other => panic!("32,767 must be accepted, got {other:?}"),
    }
    match eval("=RPAD(\"a\",32767,\"x\")") {
        EvalResult::Text(s) => assert_eq!(s.chars().count(), 32_767),
        other => panic!("32,767 must be accepted, got {other:?}"),
    }
    // A fraction above the ceiling is cut toward zero FIRST: 32,767.9
    // characters is 32,767 characters, which is allowed.
    match eval("=LPAD(\"a\",32767.9,\"x\")") {
        EvalResult::Text(s) => assert_eq!(s.chars().count(), 32_767),
        other => panic!("32,767.9 cuts to 32,767 and must be accepted, got {other:?}"),
    }
    value_error("=LPAD(\"a\",32768,\"x\")");
    value_error("=RPAD(\"a\",32768,\"x\")");
    value_error("=LPAD(\"abc\",40000,\"\")");
    // Far above every limit: refused BEFORE the cast and the allocation, so it
    // is an answer and not an out-of-memory abort.
    value_error("=LPAD(\"a\",1E+20,\"x\")");
    value_error("=RPAD(\"a\",1E+300,\"x\")");
}

#[test]
fn length_is_coerced_like_lefts_count() {
    // Numeric text, TRUE and a blank cell: 5, 1 and 0.
    assert_eq!(text("=LPAD(\"a\",\"5\",\"0\")"), "0000a");
    assert_eq!(text("=LPAD(\"ab\",TRUE,\"0\")"), "a");
    let g = Grid::new();
    assert_eq!(eval_on(&g, "=LPAD(\"ab\",B9,\"0\")"), t(""));
    // Text that is not a number is the wrong TYPE.
    value_error("=LPAD(\"a\",\"x\",\"0\")");
    value_error("=RPAD(\"a\",\"x\",\"0\")");
}

// ===========================================================================
// COERCION OF THE TEXT AND THE PAD
// ===========================================================================

#[test]
fn numbers_and_booleans_are_coerced_like_left_coerces_them() {
    assert_eq!(text("=LPAD(42,5,\"0\")"), "00042");
    assert_eq!(text("=RPAD(42,5,\"0\")"), "42000");
    assert_eq!(text("=LPAD(TRUE,6,\"*\")"), "**TRUE");
    assert_eq!(text("=RPAD(FALSE,6,\"*\")"), "FALSE*");
    // A numeric PAD is coerced too.
    assert_eq!(text("=LPAD(7,3,0)"), "007");
}

#[test]
fn a_blank_cell_as_text_is_the_empty_string() {
    let g = Grid::new();
    assert_eq!(eval_on(&g, "=LPAD(A1,3,\"0\")"), t("000"));
    assert_eq!(eval_on(&g, "=RPAD(A1,3,\"0\")"), t("000"));
}

/// THE WORKBOOK'S DECIMAL DIALECT. Calcula ships sv-SE by default, where the
/// number 1.5 is written "1,5"; padding it must not switch it to English.
/// Through `set_locale`, so the test exercises the evaluator's own ambient
/// install rather than a scope this test set up by hand.
#[test]
fn a_number_is_padded_in_the_workbooks_decimal_dialect() {
    let grid = Grid::new();
    let ast = parser::parse("=LPAD(1.5,5,\"0\")").expect("formula parses");
    let mut se = Evaluator::new(&grid);
    se.set_locale(LocaleSettings::from_locale_id("sv-SE"));
    assert_eq!(se.evaluate(&ast), t("001,5"));
    let ast = parser::parse("=RPAD(1.5,5,\"0\")").expect("formula parses");
    assert_eq!(se.evaluate(&ast), t("1,500"));
    // The control: the same formula in en-US.
    let us = Evaluator::new(&grid);
    let ast = parser::parse("=LPAD(1.5,5,\"0\")").expect("formula parses");
    assert_eq!(us.evaluate(&ast), t("001.5"));
}

// ===========================================================================
// UNICODE — characters, never bytes
// ===========================================================================

#[test]
fn length_counts_characters_not_bytes() {
    // Three characters, six bytes. A byte count would pad with ONE "ö" less
    // than asked, or cut inside a character and panic.
    assert_eq!(text("=LPAD(\"åäö\",5,\"ö\")"), "ööåäö");
    assert_eq!(text("=RPAD(\"åäö\",5,\"ö\")"), "åäööö");
    // Cutting through multi-byte text keeps whole characters.
    assert_eq!(text("=LPAD(\"Åsa Öberg\",5,\"-\")"), "Åsa Ö");
    // CJK (3 bytes) and an astral-plane emoji (4 bytes) as text and as pad.
    assert_eq!(text("=LPAD(\"日本\",4,\"語\")"), "語語日本");
    assert_eq!(text("=RPAD(\"ok\",5,\"😀\")"), "ok😀😀😀");
    assert_eq!(text("=LPAD(\"x\",4,\"😀å\")"), "😀å😀x");
}

// ===========================================================================
// ERRORS AND ARITY
// ===========================================================================

#[test]
fn an_error_in_any_argument_propagates_and_the_left_most_wins() {
    for f in ["LPAD", "RPAD"] {
        assert_eq!(eval(&format!("={f}(1/0,3,\"0\")")), EvalResult::Error(CellError::Div0));
        assert_eq!(eval(&format!("={f}(\"a\",1/0,\"0\")")), EvalResult::Error(CellError::Div0));
        assert_eq!(eval(&format!("={f}(\"a\",3,1/0)")), EvalResult::Error(CellError::Div0));
        assert_eq!(eval(&format!("={f}(NA(),1/0,\"0\")")), EvalResult::Error(CellError::NA));
        assert_eq!(eval(&format!("={f}(\"a\",NA(),1/0)")), EvalResult::Error(CellError::NA));
        assert_eq!(eval(&format!("={f}(\"a\",1/0,NA())")), EvalResult::Error(CellError::Div0));
    }
    // A STORED error reached through a reference, which is how it happens in
    // a real workbook.
    let mut g = Grid::new();
    let mut cell = Cell::new();
    cell.value = CellValue::Error(CellError::Div0);
    g.set_cell(0, 0, cell);
    assert_eq!(eval_on(&g, "=LPAD(A1,3,\"0\")"), EvalResult::Error(CellError::Div0));
    assert_eq!(eval_on(&g, "=RPAD(\"a\",3,A1)"), EvalResult::Error(CellError::Div0));
}

#[test]
fn the_wrong_number_of_arguments_is_value_error() {
    value_error("=LPAD(\"a\")");
    value_error("=RPAD(\"a\")");
    value_error("=LPAD(\"a\",3,\"0\",1)");
    value_error("=RPAD(\"a\",3,\"0\",1)");
}

// ===========================================================================
// ARRAYS — the function lifts, it does not read the first element
// ===========================================================================

fn column(vs: Vec<EvalResult>) -> EvalResult {
    EvalResult::Array(vs)
}

fn row(vs: Vec<EvalResult>) -> EvalResult {
    EvalResult::Array(vec![EvalResult::Array(vs)])
}

/// WITHOUT THE LIFT THIS IS A SILENT WRONG ANSWER, not an error: `as_text` on
/// an array returns its FIRST element, so `=LPAD(A1:A3,4,"0")` used to answer
/// a single "000a" in one cell and say nothing about the other two rows.
#[test]
fn a_column_of_texts_spills_a_column() {
    let mut g = Grid::new();
    for (i, v) in ["a", "bb", "ccc"].iter().enumerate() {
        g.set_cell(i as u32, 0, Cell::new_text((*v).to_string()));
    }
    assert_eq!(eval_on(&g, "=LPAD(A1:A3,4,\"0\")"), column(vec![t("000a"), t("00bb"), t("0ccc")]));
    assert_eq!(eval_on(&g, "=RPAD(A1:A3,4,\"0\")"), column(vec![t("a000"), t("bb00"), t("ccc0")]));
}

#[test]
fn an_array_of_lengths_spills_a_row() {
    assert_eq!(eval("=RPAD(\"x\",{2,3,4},\".\")"), row(vec![t("x."), t("x.."), t("x...")]));
    assert_eq!(eval("=LPAD(\"x\",{2,3,4},\".\")"), row(vec![t(".x"), t("..x"), t("...x")]));
}

#[test]
fn texts_and_pads_lift_pairwise() {
    assert_eq!(eval("=LPAD({\"a\";\"bb\"},3,{\"-\";\"*\"})"), column(vec![t("--a"), t("*bb")]));
    assert_eq!(eval("=RPAD({\"a\";\"bb\"},3,{\"-\";\"*\"})"), column(vec![t("a--"), t("bb*")]));
}

/// An error INSIDE an array is that element's error; its neighbours still
/// answer. A refusal of the whole spill would hide two good values.
#[test]
fn an_error_inside_an_array_is_a_per_element_error() {
    let mut g = Grid::new();
    g.set_cell(0, 0, Cell::new_text("a".to_string()));
    let mut bad = Cell::new();
    bad.value = CellValue::Error(CellError::Div0);
    g.set_cell(1, 0, bad);
    g.set_cell(2, 0, Cell::new_number(7.0));
    assert_eq!(
        eval_on(&g, "=LPAD(A1:A3,3,\"0\")"),
        column(vec![t("00a"), EvalResult::Error(CellError::Div0), t("007")])
    );
    // A negative length in one element refuses only that element.
    assert_eq!(
        eval("=LPAD(\"a\",{2,-1,3},\"0\")"),
        row(vec![t("0a"), EvalResult::Error(CellError::Value), t("00a")])
    );
}

/// The omitted pad keeps its meaning when the OTHER arguments lift: the lift
/// binds values to slots, and the slot for an omitted argument must still read
/// as omitted (one space), not as a blank value (no padding).
#[test]
fn an_omitted_pad_is_still_a_space_while_the_text_lifts() {
    assert_eq!(eval("=LPAD({\"a\";\"b\"},2,)"), column(vec![t(" a"), t(" b")]));
    assert_eq!(eval("=RPAD({\"a\";\"b\"},2)"), column(vec![t("a "), t("b ")]));
}

/// A USER definition named LPAD/RPAD wins over the builtin, as a LET binding
/// does here (the workbook-defined-name half is pinned in the host's
/// `name_resolution` tests).
///
/// LPAD and RPAD are two of the LAMBDAs Excel users write most often,
/// precisely because Excel has no such function, and many of them keep the
/// RIGHT end where Calcula's builtin keeps the LEFT. When the builtin landed
/// it silently took every such call over: `=LET(lpad, LAMBDA(...), lpad(...))`
/// ran the builtin -- a different answer with no error, or `#VALUE!` for a
/// lambda of another arity. A name the user bound in the formula itself is the
/// nearest definition and must be the one that runs.
#[test]
fn a_let_bound_lambda_named_lpad_or_rpad_shadows_the_builtin() {
    assert_eq!(text("=LET(LPAD, LAMBDA(t, \"x\"&t), LPAD(\"a\"))"), "xa");
    assert_eq!(text("=LET(rpad, LAMBDA(t, t&\"y\"), RPAD(\"a\"))"), "ay");
    // The user's RIGHT-end-keeping pad, the common Excel recipe, keeps "def".
    assert_eq!(
        text("=LET(lpad, LAMBDA(t,n,c, RIGHT(REPT(c,n)&t,n)), lpad(\"abcdef\",3,\"0\"))"),
        "def"
    );
    // A LAMBDA PARAMETER bound to a lambda shadows it the same way.
    assert_eq!(
        text("=LAMBDA(lpad, lpad(\"a\"))(LAMBDA(t, \"[\"&t&\"]\"))"),
        "[a]"
    );
    // A LET binding that is NOT a lambda does not capture the call: the
    // builtin still runs, exactly as a value-bound `x` cannot be called.
    assert_eq!(text("=LET(lpad, 5, LPAD(\"a\",lpad,\"0\"))"), "0000a");
    // And outside any binding the builtin is untouched.
    assert_eq!(text("=LPAD(\"abcdef\",3,\"0\")"), "abc");
}
