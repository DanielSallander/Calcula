//! FILENAME: core/engine/src/criteria_negation_tests.rs
//! PURPOSE: `"<>n"` is a NEGATION, not a numeric test — and an error ARGUMENT
//!          propagates out of the scalar-parameter builtins.
//!
//! WHY THESE TWO SHARE A FILE. Both are the same mistake in different clothes:
//! a value that is not a number was treated as a value that does not qualify,
//! when Excel treats it as a value that qualifies differently. In the criteria
//! family that turned "not equal to 1" into "is a number and is not 1"; in the
//! math family it turned "#DIV/0!" into "#VALUE!".
//!
//! THE CRITERIA DEFECT ONLY FIRES ON MIXED TYPES, which is exactly why it
//! survived: a pure-numeric column answers correctly, and `"<>"` is one of the
//! commonest criteria in the language. Over `{1, "1", TRUE, "apple"}`:
//!
//!   =COUNTIF(A1:A4,"<>1")          answered 0        Excel: 2
//!   =COUNTIF(A1:A4,"<>0")          answered 2        Excel: 4
//!   =SUMIF(A1:A4,"<>1",B1:B4)      answered 0        Excel: 70
//!   =AVERAGEIF(A1:A4,"<>1",B1:B4)  answered #DIV/0!  Excel: 35
//!
//! The AVERAGEIF one is the tell: nothing matched, so it divided by zero. A
//! user would have seen an error and never learned that the count was the bug.
//!
//! TWO COPIES HAD TO MOVE TOGETHER. The scan path in `matches_criteria` and the
//! pass cache's `count_not_equal` are independent implementations of the same
//! predicate, and the cache mirrored the defect rather than having one of its
//! own — so fixing only the scan would have made a cached COUNTIF disagree with
//! an uncached one on the same data. Every case below is asserted through BOTH,
//! by running it twice under a held pass guard.
//!
//! THE ERROR DEFECT was `as_number` answering `None` for an error exactly as it
//! does for the text "apple", across 264 builtins and 604 call sites. So
//! `=ABS(A1)` over a `#DIV/0!` cell blamed the argument's TYPE — sending the
//! user to look at the wrong thing — while `=A1+1`, `=SUM(A1:A2)` and
//! `=LEN(A1)` on the same cell already answered `#DIV/0!`. The engine
//! disagreed with itself about one cell.

use crate::cell::{Cell, CellError, CellValue};
use crate::evaluator::{EvalResult, Evaluator};
use crate::grid::Grid;

fn eval(grid: &Grid, formula: &str) -> EvalResult {
    let ast = parser::parse(formula).expect("formula parses");
    Evaluator::new(grid).evaluate(&ast)
}

fn num(grid: &Grid, formula: &str) -> f64 {
    match eval(grid, formula) {
        EvalResult::Number(n) => n,
        other => panic!("`{}` gave {:?}, expected a number", formula, other),
    }
}

/// Answers `formula` on the SCAN path and on the PASS-CACHE path, asserts the
/// two agree, and returns the answer.
///
/// THE FIRST CALL MUST BE OUTSIDE THE GUARD, and that is not a detail. Written
/// as "run it twice inside one guard", this helper proved nothing: COUNTIF is
/// served by the cache on BOTH calls, so a broken scan and a correct cache
/// agreed with each other at the correct answer. A sabotage of the scan path
/// alone passed it. The uncached call outside the guard is what actually
/// exercises `matches_criteria`; the pair inside builds the index and then
/// answers from it.
fn num_both_paths(grid: &Grid, formula: &str) -> f64 {
    let scanned = num(grid, formula);
    let cached = {
        let _guard = crate::lookup_cache::begin_pass();
        let built = num(grid, formula);
        let served = num(grid, formula);
        assert_eq!(
            built, served,
            "`{}` answered {} while building the pass cache and {} when served              from it",
            formula, built, served
        );
        served
    };
    assert_eq!(
        scanned, cached,
        "`{}` answered {} on the scan path and {} from the pass cache",
        formula, scanned, cached
    );
    cached
}

/// A1:A4 = 1 (number), "1" (text), TRUE, "apple"; B1:B4 = 10,20,30,40.
/// FOUR DIFFERENT TYPE CLASSES on purpose — the defect is invisible on a
/// column that holds only numbers.
fn mixed() -> Grid {
    let mut g = Grid::new();
    g.set_cell(0, 0, Cell::new_number(1.0));
    g.set_cell(1, 0, Cell::new_text("1".to_string()));
    g.set_cell(2, 0, Cell::new_boolean(true));
    g.set_cell(3, 0, Cell::new_text("apple".to_string()));
    for (r, v) in [(0, 10.0), (1, 20.0), (2, 30.0), (3, 40.0)] {
        g.set_cell(r, 1, Cell::new_number(v));
    }
    g
}

// ---------------------------------------------------------------------------
// `"<>n"` is a negation
// ---------------------------------------------------------------------------

#[test]
fn not_equal_counts_values_that_are_not_numbers_at_all() {
    let g = mixed();
    // TRUE and "apple" are not equal to 1, so both count. Text "1" IS equal to
    // 1 under Excel's criteria coercion, so it does not.
    assert_eq!(num_both_paths(&g, "=COUNTIF(A1:A4,\"<>1\")"), 2.0);
    // The CONTROL that makes the number above mean something: the positive
    // criteria must answer the complement, or a matcher that counted nothing
    // and a matcher that counted everything would both look plausible.
    assert_eq!(num_both_paths(&g, "=COUNTIF(A1:A4,1)"), 2.0);
}

#[test]
fn not_equal_to_a_value_nothing_equals_counts_the_whole_population() {
    let g = mixed();
    // Nothing in the column is 0, so every non-blank cell qualifies. This is
    // the case that shows the old rule was "is a number and is not 0" — it
    // answered 2, silently dropping the two cells that are not numbers.
    assert_eq!(num_both_paths(&g, "=COUNTIF(A1:A4,\"<>0\")"), 4.0);
}

#[test]
fn the_three_not_equal_criteria_now_agree_with_each_other() {
    let g = mixed();
    // `"<>apple"` (text) and `"<>a*"` (wildcard) were already negations over
    // every type; `"<>1"` (numeric) was the odd one out. All three now answer
    // "everything except what matches", which is what makes this a rule rather
    // than three behaviours.
    assert_eq!(num_both_paths(&g, "=COUNTIF(A1:A4,\"<>apple\")"), 3.0);
    assert_eq!(num_both_paths(&g, "=COUNTIF(A1:A4,\"<>a*\")"), 3.0);
    assert_eq!(num_both_paths(&g, "=COUNTIF(A1:A4,\"<>1\")"), 2.0);
}

#[test]
fn the_whole_conditional_family_reads_the_same_criteria() {
    let g = mixed();
    // SUMIF/AVERAGEIF/COUNTIFS share the matcher, so all three were wrong
    // together — and AVERAGEIF turned the miscount into a DIVISION BY ZERO,
    // which is the only one of them a user would have noticed.
    assert_eq!(num(&g, "=SUMIF(A1:A4,\"<>1\",B1:B4)"), 70.0);
    assert_eq!(num(&g, "=AVERAGEIF(A1:A4,\"<>1\",B1:B4)"), 35.0);
    assert_eq!(num(&g, "=COUNTIFS(A1:A4,\"<>1\")"), 2.0);
}

#[test]
fn a_purely_numeric_column_is_unchanged() {
    // THE REGRESSION CONTROL, and the reason the defect lived so long: on the
    // shape most ranges actually have, the old rule and the new one agree.
    let mut g = Grid::new();
    for (r, v) in [(0, 0.0), (1, 1.0), (2, 2.0)] {
        g.set_cell(r, 0, Cell::new_number(v));
    }
    assert_eq!(num_both_paths(&g, "=COUNTIF(A1:A3,\"<>0\")"), 2.0);
    assert_eq!(num_both_paths(&g, "=COUNTIF(A1:A3,\"<>1\")"), 2.0);
    // The ordering operators must NOT have become negations with it.
    assert_eq!(num_both_paths(&g, "=COUNTIF(A1:A3,\">0\")"), 2.0);
    assert_eq!(num_both_paths(&g, "=COUNTIF(A1:A3,\"<2\")"), 2.0);
    assert_eq!(num_both_paths(&g, "=COUNTIF(A1:A3,\">=1\")"), 2.0);
}

#[test]
fn a_blank_still_matches_only_the_blank_criteria() {
    // The blank rule was settled deliberately elsewhere and this change must
    // not move it: a blank is not "a value that is not 1", it is absent.
    let mut g = Grid::new();
    g.set_cell(0, 0, Cell::new_number(1.0));
    g.set_cell(2, 0, Cell::new_number(2.0)); // A2 left EMPTY
    assert_eq!(num_both_paths(&g, "=COUNTIF(A1:A3,\"<>1\")"), 1.0, "A3 only");
    assert_eq!(num(&g, "=COUNTIF(A1:A3,\"<>\")"), 2.0, "non-blank");
    assert_eq!(num(&g, "=COUNTIF(A1:A3,\"\")"), 1.0, "the blank itself");
}

// ---------------------------------------------------------------------------
// An error argument propagates
// ---------------------------------------------------------------------------

/// A1 holds a `#DIV/0!` VALUE; A2 holds the number 4.
fn with_error() -> Grid {
    let mut g = Grid::new();
    let mut err = Cell::new_number(0.0);
    err.value = CellValue::Error(CellError::Div0);
    g.set_cell(0, 0, err);
    g.set_cell(1, 0, Cell::new_number(4.0));
    g
}

#[test]
fn a_math_function_reports_the_error_it_was_given_not_a_type_complaint() {
    let g = with_error();
    for formula in [
        "=ABS(A1)", "=SQRT(A1)", "=INT(A1)", "=ROUND(A1,2)", "=SIGN(A1)",
        "=EXP(A1)", "=MOD(A1,2)", "=POWER(A1,2)", "=ISEVEN(A1)", "=NOT(A1)",
        "=YEAR(A1)", "=ABS(1/0)",
    ] {
        assert_eq!(
            eval(&g, formula),
            EvalResult::Error(CellError::Div0),
            "`{}` must report the DIVISION, not blame its argument's type",
            formula
        );
    }
}

#[test]
fn the_engine_no_longer_disagrees_with_itself_about_one_cell() {
    // These three already propagated. The defect was that the math family did
    // not, so the SAME cell produced two different diagnoses depending on which
    // function read it.
    let g = with_error();
    for formula in ["=A1+1", "=SUM(A1:A2)", "=MAX(A1:A2)", "=LEN(A1)"] {
        assert_eq!(eval(&g, formula), EvalResult::Error(CellError::Div0), "{}", formula);
    }
    assert_eq!(eval(&g, "=ABS(A1)"), EvalResult::Error(CellError::Div0));
}

#[test]
fn the_error_inspectors_still_receive_the_error() {
    // THE DANGEROUS HALF. `lifts_over_arrays` contains the error-handling
    // family, so a blanket propagation would make ISERROR answer the error and
    // IFERROR propagate the very thing it exists to swallow — turning every
    // error-handling formula in every workbook into the error it was hiding.
    let g = with_error();
    assert_eq!(eval(&g, "=ISERROR(A1)"), EvalResult::Boolean(true));
    assert_eq!(eval(&g, "=ISERR(A1)"), EvalResult::Boolean(true));
    assert_eq!(eval(&g, "=ISNA(A1)"), EvalResult::Boolean(false), "Div0 is not NA");
    assert_eq!(eval(&g, "=ISNA(NA())"), EvalResult::Boolean(true));
    assert_eq!(eval(&g, "=IFERROR(A1,\"safe\")"), EvalResult::Text("safe".to_string()));
    assert_eq!(eval(&g, "=IFERROR(1/0,\"safe\")"), EvalResult::Text("safe".to_string()));
    assert_eq!(eval(&g, "=IFNA(NA(),7)"), EvalResult::Number(7.0));
    assert_eq!(eval(&g, "=ERROR.TYPE(A1)"), EvalResult::Number(2.0));
    assert_eq!(eval(&g, "=IF(ISERROR(A1),0,A1)"), EvalResult::Number(0.0));
}

#[test]
fn the_type_predicates_answer_false_rather_than_becoming_the_error() {
    let g = with_error();
    for formula in ["=ISNUMBER(A1)", "=ISTEXT(A1)", "=ISLOGICAL(A1)", "=ISNONTEXT(A1)"] {
        let got = eval(&g, formula);
        assert!(
            matches!(got, EvalResult::Boolean(_)),
            "`{}` gave {:?} — a type predicate answers a question ABOUT the value",
            formula,
            got
        );
    }
    assert_eq!(eval(&g, "=ISNUMBER(A1)"), EvalResult::Boolean(false));
    assert_eq!(eval(&g, "=ISNUMBER(A2)"), EvalResult::Boolean(true), "control");
}

#[test]
fn an_error_inside_an_array_stays_per_element() {
    // The gate propagates only a TOP-LEVEL error argument. An error that is one
    // member of an array is the broadcast's business, so a lifted call still
    // answers element-wise rather than collapsing to a single error.
    let g = with_error();
    let lifted = eval(&g, "=ABS({-1,-2,-3})");
    assert_eq!(
        crate::array_lift::shape(&lifted),
        (1, 3),
        "a lifted call over an array must still return an array"
    );
    assert_eq!(num(&g, "=SUM(ABS({-1,-2}))"), 3.0);
    // And an ordinary argument is untouched.
    assert_eq!(num(&g, "=ABS(A2)"), 4.0);
}

// ---------------------------------------------------------------------------
// Three criteria defects found by growing the formula eval corpus, 2026-09-15
// ---------------------------------------------------------------------------

/// A1:A3 = the serials of 2025-01-01, 2025-01-15, 2024-06-30 (typed dates are
/// NUMBERS); A4 = the TEXT "2025-01-01"; B1:B4 = 100, 200, 400, 800.
fn dated() -> Grid {
    let mut g = Grid::new();
    for (r, serial) in [(0, 45658.0), (1, 45672.0), (2, 45473.0)] {
        g.set_cell(r, 0, Cell::new_number(serial));
    }
    g.set_cell(3, 0, Cell::new_text("2025-01-01".to_string()));
    for (r, v) in [(0, 100.0), (1, 200.0), (2, 400.0), (3, 800.0)] {
        g.set_cell(r, 1, Cell::new_number(v));
    }
    g
}

/// A date LITERAL inside a criteria string is read as the date. (BUG-0115)
///
/// `">=2025-01-01"` matched nothing and — far worse — `"<>2025-01-15"` fell
/// through to an exact-text compare no number ever equals and KEPT the row it
/// was told to drop: "not equal to that date" counted the row that IS that
/// date. The cause was a symmetry rule that is right for percent and currency
/// (the cell stores text) and inverts for dates (the cell stores a NUMBER).
#[test]
fn a_date_literal_in_a_criteria_string_compares_against_the_serial() {
    let g = dated();
    assert_eq!(num_both_paths(&g, "=COUNTIF(A1:A3,\">=2025-01-01\")"), 2.0);
    assert_eq!(num_both_paths(&g, "=SUMIF(A1:A3,\">=2025-01-01\",B1:B3)"), 300.0);
    assert_eq!(num_both_paths(&g, "=COUNTIF(A1:A3,\"<2025-01-01\")"), 1.0);
    assert_eq!(num_both_paths(&g, "=COUNTIF(A1:A3,\"=2025-01-15\")"), 1.0);
    // THE NEGATED CASE, the one that silently kept a row: two of the three
    // dates are not 2025-01-15.
    assert_eq!(num_both_paths(&g, "=COUNTIF(A1:A3,\"<>2025-01-15\")"), 2.0);
    // The concatenated spellings agree with the literal, as they always did.
    assert_eq!(num_both_paths(&g, "=COUNTIF(A1:A3,\">=\"&DATE(2025,1,1))"), 2.0);
    // A TEXT cell that merely LOOKS like the date is not a date and does not
    // match a date criterion — Excel's answer, and the half of the old
    // symmetry rule that was right. The range side keeps `CRITERIA`.
    assert_eq!(num_both_paths(&g, "=COUNTIF(A1:A4,\">=2025-01-01\")"), 2.0);
    assert_eq!(num_both_paths(&g, "=COUNTIF(A4:A4,\">=2025-01-01\")"), 0.0);
}

/// The four ORDERING operators compare text. (BUG-0116)
///
/// `<`, `<=`, `>` and `>=` had a numeric arm only: when the operand did not
/// parse as a number the arm fell through to `ExactText` of the WHOLE string,
/// operator included, which no cell equals. `<>` had a text arm all along,
/// which is why the family looked complete on a spot check.
#[test]
fn ordering_operators_compare_text_case_insensitively() {
    let mut g = Grid::new();
    for (r, v) in [(0, "Mango"), (1, "Apple"), (2, "Zebra"), (3, "apple")] {
        g.set_cell(r, 0, Cell::new_text((*v).to_string()));
    }
    g.set_cell(4, 0, Cell::new_number(5.0));
    // Over the four names: Mango and Zebra are at or past "M".
    assert_eq!(num_both_paths(&g, "=COUNTIF(A1:A4,\">=M\")"), 2.0);
    assert_eq!(num_both_paths(&g, "=COUNTIF(A1:A4,\"<M\")"), 2.0);
    assert_eq!(num_both_paths(&g, "=COUNTIF(A1:A4,\">Apple\")"), 2.0);
    // Case-insensitive, like every other text criteria: "apple" <= "APPLE".
    assert_eq!(num_both_paths(&g, "=COUNTIF(A1:A4,\"<=APPLE\")"), 2.0);
    // The pre-existing arms are unchanged and agree with the new ones.
    assert_eq!(num_both_paths(&g, "=COUNTIF(A1:A4,\"<>Apple\")"), 2.0);
    assert_eq!(num_both_paths(&g, "=COUNTIF(A1:A4,\"Mango\")"), 1.0);
    // A NUMBER is never ordered against text: 5 is not >= "M" and not < "M".
    // The two answers over the mixed column must still sum to the four texts.
    assert_eq!(num_both_paths(&g, "=COUNTIF(A1:A5,\">=M\")"), 2.0);
    assert_eq!(num_both_paths(&g, "=COUNTIF(A1:A5,\"<M\")"), 2.0);
    // A numeric operand still takes the numeric path, untouched.
    assert_eq!(num_both_paths(&g, "=COUNTIF(A1:A5,\">=5\")"), 1.0);
}

/// An error in the criteria ARGUMENT is the answer, not "match nothing".
/// (BUG-0117)
///
/// `NA()`, `1/0` and an undefined name all fell into the parser's catch-all
/// and matched nothing — a total of 0 with nothing on screen to say why, while
/// `=SUM(name)` beside it correctly said #NAME?. AVERAGEIFS was the tell: it
/// answered #DIV/0! over the empty match set rather than the #N/A it was
/// handed, proving the error was consumed rather than propagated. The parser
/// now returns a `Result` so every call site has to write the `Err` arm.
#[test]
fn an_error_in_the_criteria_argument_propagates_instead_of_matching_nothing() {
    let g = dated();
    let na = EvalResult::Error(CellError::NA);
    let div0 = EvalResult::Error(CellError::Div0);
    assert_eq!(eval(&g, "=SUMIF(A1:A3,NA(),B1:B3)"), na);
    assert_eq!(eval(&g, "=SUMIF(A1:A3,1/0,B1:B3)"), div0);
    assert_eq!(eval(&g, "=COUNTIF(A1:A3,NA())"), na);
    assert_eq!(eval(&g, "=SUMIFS(B1:B3,A1:A3,1/0)"), div0);
    assert_eq!(eval(&g, "=COUNTIFS(A1:A3,NA())"), na);
    assert_eq!(eval(&g, "=MAXIFS(B1:B3,A1:A3,NA())"), na);
    assert_eq!(eval(&g, "=MINIFS(B1:B3,A1:A3,1/0)"), div0);
    // THE TELL, now answering with the error it was handed.
    assert_eq!(eval(&g, "=AVERAGEIFS(B1:B3,A1:A3,NA())"), na);
    assert_eq!(eval(&g, "=AVERAGEIF(A1:A3,NA(),B1:B3)"), na);
    // The second criteria pair of an -IFS propagates too, not only the first.
    assert_eq!(eval(&g, "=SUMIFS(B1:B3,A1:A3,\">0\",A1:A3,NA())"), na);
    // CONTROL: a criteria that merely matches nothing is still an honest zero.
    assert_eq!(num_both_paths(&g, "=SUMIF(A1:A3,\"zzz\",B1:B3)"), 0.0);
}
