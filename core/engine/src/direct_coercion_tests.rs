//! FILENAME: core/engine/src/direct_coercion_tests.rs
//! PURPOSE: Excel's DIRECT-vs-INDIRECT coercion rule for the aggregate
//!          collector, plus the two shape bugs that shared its blast radius.
//!
//! THE RULE, in one sentence. `=SUM(1,"2",TRUE)` is 4 and `=SUM({1,"2",TRUE})`
//! is 1. Excel coerces a text or logical value that the user TYPED as an
//! argument, and IGNORES the identical value when it arrived inside an array or
//! through a cell reference. The values are the same; only the route differs,
//! which is why the collector cannot decide from the value alone and why the
//! argument EXPRESSION has to reach it.
//!
//! WHY THIS FILE EXISTS RATHER THAN A HANDFUL OF ASSERTIONS ELSEWHERE. Getting
//! this wrong is not an error, it is a WRONG NUMBER, and it was wrong in the
//! direction that hides:
//!
//!   * `=SUM(A1:A3&"")` is THE standard diagnostic for "this column has
//!     silently turned into text". Excel answers 0 and the user goes looking.
//!     Calcula answered 6 — the same total as the numbers themselves — so the
//!     one formula whose whole job is to expose the problem reported that there
//!     wasn't one.
//!   * `=SUM(A1:A3>1)` answered 2, i.e. it COUNTED the TRUEs. That is the
//!     result the `--` in `=SUMPRODUCT(--(A1:A3>1))` exists to obtain; a build
//!     where the bare comparison already works is a build where every user who
//!     learned the idiom is writing something they no longer understand, and
//!     where a boolean column silently joins every total taken over it.
//!   * `=SUM(D1:D2)` over TRUE/FALSE answered 1. A checkbox column is not a
//!     quantity, and Excel does not treat it as one.
//!
//! THREE FAMILIES DISAGREE ON PURPOSE, and each is asserted here so a future
//! "simplification" that applies one rule everywhere fails:
//!
//!   * SUM/AVERAGE/COUNT/MAX/MIN/PRODUCT and the statistical family take
//!     NUMBERS ONLY from a reference or an array.
//!   * COUNTA counts every non-blank value from anywhere — that is its job.
//!   * AVERAGEA/MAXA/MINA/STDEVA and friends deliberately DO take text (as 0)
//!     and logicals (as 1/0) from references. They are the escape hatch for
//!     exactly the behaviour the others must not have, and they run through a
//!     different collector (`collect_numbers_a`) so they are untouched.
//!
//! THE TWO SHAPE BUGS. Both were found by walking the same collector and both
//! were invisible to anyone who tested one orientation: the engine's convention
//! is that a FLAT `EvalResult::Array` is a COLUMN and a ROW is
//! `Array([Array([…])])`, so `{1;2;3}` and `{1,2,3}` take different paths.
//! `=CONCAT({1,2,3})` returned the EMPTY STRING while `=CONCAT({1;2;3})`
//! returned "123", and `=INDEX({1,2,3},2)` was #REF! while `=INDEX({1;2;3},2)`
//! was 2. Every assertion below that names a horizontal shape is paired with
//! its vertical control for that reason.

use crate::cell::{Cell, CellError};
use crate::evaluator::{EvalResult, Evaluator};
use crate::grid::Grid;

/// A1:A3 are real NUMBERS 1,2,3.
/// B1:B3 are the same magnitudes stored as TEXT — the "column that turned into
/// text" this whole rule exists to expose.
/// C1 is text that is not a number at all.
/// D1/D2 are TRUE/FALSE — the checkbox column.
fn mixed_grid() -> Grid {
    let mut g = Grid::new();
    g.set_cell(0, 0, Cell::new_number(1.0));
    g.set_cell(1, 0, Cell::new_number(2.0));
    g.set_cell(2, 0, Cell::new_number(3.0));
    g.set_cell(0, 1, Cell::new_text("10".to_string()));
    g.set_cell(1, 1, Cell::new_text("20".to_string()));
    g.set_cell(2, 1, Cell::new_text("30".to_string()));
    g.set_cell(0, 2, Cell::new_text("abc".to_string()));
    g.set_cell(0, 3, Cell::new_boolean(true));
    g.set_cell(1, 3, Cell::new_boolean(false));
    g
}

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

fn text(grid: &Grid, formula: &str) -> String {
    match eval(grid, formula) {
        EvalResult::Text(s) => s,
        other => panic!("`{}` gave {:?}, expected text", formula, other),
    }
}

// ===================================================================
// The rule itself
// ===================================================================

/// The pair the whole change turns on. Same three values, two routes.
#[test]
fn a_typed_argument_coerces_and_the_same_value_in_an_array_does_not() {
    let g = Grid::new();
    // DIRECT: the user typed "2" and TRUE as arguments. 1 + 2 + 1 = 4.
    assert_eq!(num(&g, "=SUM(1,\"2\",TRUE)"), 4.0);
    // INDIRECT: identical values, reached through an array constant. Only the
    // 1 is in the population. If this ever equals 4 again, the collector has
    // gone back to asking the VALUE what it is instead of asking how it got here.
    assert_eq!(num(&g, "=SUM({1,\"2\",TRUE})"), 1.0);
    // ...in BOTH orientations, because a row and a column reach the recursion
    // through different `Array` nestings.
    assert_eq!(num(&g, "=SUM({1;\"2\";TRUE})"), 1.0);
}

/// THE FAILURE HALF OF THE RULE, ON ITS OWN.
///
/// Verification found that this file asserted the SUCCESS case everywhere
/// (`=SUM(1,"2",TRUE)` is 4) but never the plain refusals beside it, so a
/// regression that made EVERYTHING coerce — the exact risk of widening the
/// number parser, which now reads percent, currency, dates and times — would
/// have passed the whole suite. Each line below is a total that must stay 0 or
/// 1 however permissive the parser becomes, because the rule is about the
/// ROUTE the value travelled and not about whether it could be read.
#[test]
fn the_refusals_are_asserted_and_not_merely_implied() {
    let g = mixed_grid();
    // From an ARRAY: only the 1 is in the population, in both orientations.
    assert_eq!(num(&g, "=SUM({1,\"2\",TRUE})"), 1.0);
    assert_eq!(num(&g, "=SUM({1;\"2\";TRUE})"), 1.0);
    assert_eq!(num(&g, "=COUNT({1,\"2\",TRUE})"), 1.0);
    // From a RANGE of text cells: nothing at all, and COUNT agrees.
    assert_eq!(num(&g, "=SUM(B1:B3)"), 0.0);
    assert_eq!(num(&g, "=COUNT(B1:B3)"), 0.0);
    assert_eq!(num(&g, "=SUM(B1:B3,C1)"), 0.0);
    // ...including the spellings the parser learned AFTER this rule landed. A
    // range of percentages-as-text is still an empty numeric population.
    let mut widened = Grid::new();
    widened.set_cell(0, 0, Cell::new_text("5%".to_string()));
    widened.set_cell(1, 0, Cell::new_text("$5".to_string()));
    widened.set_cell(2, 0, Cell::new_text("2020-01-01".to_string()));
    widened.set_cell(3, 0, Cell::new_text("12:00".to_string()));
    assert_eq!(num(&widened, "=SUM(A1:A4)"), 0.0);
    assert_eq!(num(&widened, "=COUNT(A1:A4)"), 0.0);
    // CONTROLS: the identical characters typed as ARGUMENTS do coerce, which is
    // what makes every zero above a statement about provenance rather than a
    // statement that the parser cannot read them.
    assert_eq!(num(&g, "=SUM(1,\"2\",TRUE)"), 4.0);
    assert_eq!(num(&g, "=COUNT(1,\"2\",TRUE)"), 3.0);
    assert_eq!(num(&widened, "=SUM(\"5%\",\"$5\")"), 5.05);
    assert_eq!(num(&widened, "=COUNTA(A1:A4)"), 4.0);
}

/// `=SUM(A1:A3&"")` is the standard "has this column turned into text?" probe.
/// Answering 6 means answering "no" when the truth is "yes".
#[test]
fn concatenating_a_numeric_range_totals_zero_because_the_result_is_text() {
    let g = mixed_grid();
    // CONTROL: the untouched column really does total 6, so a fix that simply
    // broke SUM cannot satisfy this test.
    assert_eq!(num(&g, "=SUM(A1:A3)"), 6.0);
    assert_eq!(num(&g, "=SUM(A1:A3&\"\")"), 0.0);
}

/// The reason `=SUMPRODUCT(--(…))` exists. If a bare comparison already summed,
/// the double-unary would be cargo cult.
#[test]
fn a_comparison_over_a_range_totals_zero_but_the_double_unary_idiom_still_counts() {
    let g = mixed_grid();
    // Two of 1,2,3 are greater than 1 — but booleans out of an array are not
    // numbers, so the bare SUM sees an empty population.
    assert_eq!(num(&g, "=SUM(A1:A3>1)"), 0.0);
    // ...and the idiom that converts them explicitly still answers 2. This is
    // the CONTROL that makes the assertion above meaningful: a change that
    // simply dropped booleans everywhere would break this line.
    assert_eq!(num(&g, "=SUMPRODUCT(--(A1:A3>1))"), 2.0);
    // The same conversion spelled with arithmetic rather than `--`.
    assert_eq!(num(&g, "=SUMPRODUCT((A1:A3>1)*1)"), 2.0);
}

/// A checkbox column is not a quantity.
#[test]
fn a_boolean_column_contributes_nothing_to_a_total() {
    let g = mixed_grid();
    assert_eq!(num(&g, "=SUM(D1:D2)"), 0.0);
    // A DIRECTLY typed TRUE still counts, which is the half of the rule that
    // must survive.
    assert_eq!(num(&g, "=SUM(TRUE,TRUE)"), 2.0);
}

/// The single-cell case, which no depth counter can catch: a bare `B1` arrives
/// as a scalar `Text`, indistinguishable from a typed `"10"` unless the
/// EXPRESSION is consulted.
#[test]
fn a_single_cell_reference_to_text_is_not_coerced_either() {
    let g = mixed_grid();
    assert_eq!(num(&g, "=SUM(B1)"), 0.0);
    assert_eq!(num(&g, "=SUM(D1)"), 0.0);
    // CONTROL: the identical characters typed as an argument DO coerce, so this
    // pair is what proves the test is on provenance and not on the value.
    assert_eq!(num(&g, "=SUM(\"10\")"), 10.0);
    assert_eq!(num(&g, "=SUM(A1)"), 1.0);
    // The cell-by-cell spelling of a total must agree with the range spelling.
    assert_eq!(num(&g, "=SUM(B1)+SUM(B2)+SUM(B3)"), num(&g, "=SUM(B1:B3)"));
}

/// A mixed rectangle: only the real numbers are in the population.
#[test]
fn a_rectangle_of_mixed_types_totals_only_its_numbers() {
    let g = mixed_grid();
    // A1:D3 holds 1,2,3 as numbers; "10","20","30","abc" as text; TRUE, FALSE.
    assert_eq!(num(&g, "=SUM(A1:D3)"), 6.0);
    assert_eq!(num(&g, "=AVERAGE(A1:D3)"), 2.0);
    // COUNT is a count of NUMBERS. Three of them.
    assert_eq!(num(&g, "=COUNT(A1:D3)"), 3.0);
    // STDEV of {1,2,3} is exactly 1. A population that had swallowed "10"/"20"
    // /"30" would be an order of magnitude larger, so this pins the collector
    // for the statistical family too.
    assert_eq!(num(&g, "=STDEV(A1:D3)"), 1.0);
    assert_eq!(num(&g, "=MEDIAN(A1:D3)"), 2.0);
}

/// MAX/MIN/PRODUCT reach the same collector and Excel's answer for an EMPTY
/// numeric population is 0 for all three — not an error, and not the text's
/// magnitude.
#[test]
fn max_min_and_product_take_numbers_only_from_a_reference() {
    let g = mixed_grid();
    assert_eq!(num(&g, "=MAX(B1:B3)"), 0.0);
    assert_eq!(num(&g, "=MIN(B1:B3)"), 0.0);
    assert_eq!(num(&g, "=PRODUCT(B1:B3)"), 0.0);
    assert_eq!(num(&g, "=MAX(D1:D2)"), 0.0);
    // CONTROLS: the same three functions over the numeric column, so an
    // implementation that returned 0 unconditionally fails here.
    assert_eq!(num(&g, "=MAX(A1:A3)"), 3.0);
    assert_eq!(num(&g, "=MIN(A1:A3)"), 1.0);
    assert_eq!(num(&g, "=PRODUCT(A1:A3)"), 6.0);
    // And DIRECT arguments still coerce for MAX, as in Excel.
    assert_eq!(num(&g, "=MAX(1,\"5\",TRUE)"), 5.0);
}

/// COUNT is a count of NUMBERS; COUNTA is a count of VALUES. They must disagree
/// over this data or one of them is wrong.
#[test]
fn count_counts_numbers_while_counta_counts_everything_present() {
    let g = mixed_grid();
    assert_eq!(num(&g, "=COUNT(A1:D3)"), 3.0);
    // 3 numbers + 3 numeric texts + "abc" + TRUE + FALSE.
    assert_eq!(num(&g, "=COUNTA(A1:D3)"), 9.0);
    // COUNT's DIRECT rule is Excel's documented oddity: a quoted number and a
    // logical typed into the argument list ARE counted.
    assert_eq!(num(&g, "=COUNT(1,\"2\",TRUE)"), 3.0);
    // ...but not text that is not a number, even when typed directly.
    assert_eq!(num(&g, "=COUNT(1,\"abc\")"), 1.0);
    // From an array, only the number survives.
    assert_eq!(num(&g, "=COUNT({1,\"2\",TRUE})"), 1.0);
}

/// The `…A` family is the DELIBERATE exception and must not be swept up by the
/// same rule. AVERAGEA counts text as 0 and logicals as 1/0, from references.
#[test]
fn the_a_suffixed_family_still_counts_text_and_logicals_from_a_reference() {
    let g = mixed_grid();
    // Population is all 9 cells: 1,2,3 then 0,0,0 for the text, 0 for "abc",
    // 1 for TRUE, 0 for FALSE. Sum 7 over 9.
    assert!((num(&g, "=AVERAGEA(A1:D3)") - 7.0 / 9.0).abs() < 1e-12);
    // CONTROL: AVERAGE over the same range sees three values, not nine. If
    // these two ever agree, one family has been given the other's rule.
    assert_eq!(num(&g, "=AVERAGE(A1:D3)"), 2.0);
    // MAXA sees the TRUE as 1; MAX (above) sees nothing at all.
    assert_eq!(num(&g, "=MAXA(D1:D2)"), 1.0);
}

/// SUBTOTAL's arguments are references BY DEFINITION, so every value it sees is
/// indirect. It must agree with SUM over the same unfiltered data — the user
/// reaches for SUBTOTAL precisely so the filtered total matches the visible one.
#[test]
fn subtotal_agrees_with_sum_over_the_same_text_column() {
    let g = mixed_grid();
    assert_eq!(num(&g, "=SUBTOTAL(9,B1:B3)"), 0.0);
    assert_eq!(num(&g, "=SUBTOTAL(9,B1:B3)"), num(&g, "=SUM(B1:B3)"));
    assert_eq!(num(&g, "=SUBTOTAL(2,A1:D3)"), 3.0);
    // CONTROL: the numeric column still totals through SUBTOTAL.
    assert_eq!(num(&g, "=SUBTOTAL(9,A1:A3)"), 6.0);
    // COUNTA's code (3) keeps counting everything, exactly as `fn_counta` does.
    assert_eq!(num(&g, "=SUBTOTAL(3,A1:D3)"), 9.0);

    // AGGREGATE is SUBTOTAL's twin and keeps its OWN copy of the extractor.
    // The two have drifted before — `AGGREGATE(3,…)` once disagreed with
    // `SUBTOTAL(3,…)` about blanks — so both are asserted here rather than one
    // standing in for the other.
    assert_eq!(num(&g, "=AGGREGATE(9,0,B1:B3)"), 0.0);
    assert_eq!(num(&g, "=AGGREGATE(9,0,A1:A3)"), 6.0);
    assert_eq!(num(&g, "=AGGREGATE(2,0,A1:D3)"), 3.0);
}

/// Errors still win over the whole population, from any depth, left-most first.
/// The provenance flag must not have been allowed to swallow one.
#[test]
fn an_error_anywhere_in_the_population_still_propagates() {
    let mut g = mixed_grid();
    let mut err = Cell::new();
    err.value = crate::cell::CellValue::Error(CellError::Div0);
    g.set_cell(0, 5, err);
    g.set_cell(1, 5, Cell::new_number(5.0));
    // An error CELL inside the rectangle beats the number beside it.
    assert_eq!(eval(&g, "=SUM(F1:F2)"), EvalResult::Error(CellError::Div0));
    // ...and so does one typed directly, next to a perfectly good argument.
    assert_eq!(eval(&g, "=SUM(A1:A3,1/0)"), EvalResult::Error(CellError::Div0));
    assert_eq!(eval(&g, "=SUM({1,2}/0)"), EvalResult::Error(CellError::Div0));
}

/// SUMIF/COUNTIF have their own population rules and must be untouched.
#[test]
fn the_criteria_functions_keep_their_own_population_rules() {
    let g = mixed_grid();
    assert_eq!(num(&g, "=SUMIF(A1:A3,\">1\")"), 5.0);
    // COUNTIF matches the TEXT "10" in B1 — criteria matching compares values,
    // it does not build a numeric population, so the coercion change is
    // invisible to it.
    assert_eq!(num(&g, "=COUNTIF(B1:B3,\"10\")"), 1.0);
    assert_eq!(num(&g, "=COUNTIF(D1:D2,TRUE)"), 1.0);
}

// ===================================================================
// The two shape bugs found alongside it
// ===================================================================

/// A horizontal array constant is `Array([Array([…])])`; the old collector's
/// one-level `Array` arm dropped it whole and CONCAT returned "".
#[test]
fn concat_and_textjoin_read_a_horizontal_array_the_same_as_a_vertical_one() {
    let g = mixed_grid();
    assert_eq!(text(&g, "=CONCAT({1,2,3})"), "123");
    // The vertical CONTROL, which was always right — the pair is what makes the
    // failure legible as a SHAPE bug rather than a content bug.
    assert_eq!(text(&g, "=CONCAT({1;2;3})"), "123");
    assert_eq!(text(&g, "=TEXTJOIN(\"-\",TRUE,{1,2,3})"), "1-2-3");
    assert_eq!(text(&g, "=TEXTJOIN(\"-\",TRUE,{1;2;3})"), "1-2-3");
    // A 2-D constant reads in row-major order, which only works if the walk is
    // fully recursive rather than one level deep.
    assert_eq!(text(&g, "=CONCAT({1,2;3,4})"), "1234");
    // A horizontal RANGE goes down `textjoin_collect`'s own rectangle walk and
    // was never broken; asserting it keeps the two paths pinned together.
    assert_eq!(text(&g, "=CONCAT(A1:A3)"), "123");
}

/// One index over a one-dimensional array walks it in reading order, whichever
/// way it lies. The row case computed `row_num * cols` and ran off the end.
#[test]
fn index_with_one_argument_walks_a_row_as_readily_as_a_column() {
    let mut g = mixed_grid();
    // E1:G1 — a horizontal RANGE, the reference spelling of the same shape.
    g.set_cell(0, 4, Cell::new_number(7.0));
    g.set_cell(0, 5, Cell::new_number(8.0));
    g.set_cell(0, 6, Cell::new_number(9.0));

    assert_eq!(num(&g, "=INDEX({1,2,3},2)"), 2.0);
    // The vertical CONTROL, which already worked.
    assert_eq!(num(&g, "=INDEX({1;2;3},2)"), 2.0);
    assert_eq!(num(&g, "=INDEX(E1:G1,2)"), 8.0);
    assert_eq!(num(&g, "=INDEX(A1:A3,2)"), 2.0);
    // Reading order really is order: first and last must not both be 2.
    assert_eq!(num(&g, "=INDEX({1,2,3},1)"), 1.0);
    assert_eq!(num(&g, "=INDEX({1,2,3},3)"), 3.0);
    // Past the end is still #REF!, so the fix did not simply stop bounds-checking.
    assert_eq!(eval(&g, "=INDEX({1,2,3},4)"), EvalResult::Error(CellError::Ref));
    // The TWO-index spelling of the same row is unchanged — it always addressed
    // correctly, and the arity is part of the rule.
    assert_eq!(num(&g, "=INDEX(E1:G1,1,2)"), 8.0);
    assert_eq!(num(&g, "=INDEX({1,2,3},1,3)"), 3.0);
    // A genuine 2-D array is NOT affected by the one-dimensional rule.
    assert_eq!(num(&g, "=INDEX({1,2;3,4},2,2)"), 4.0);
}



// ===================================================================
// REFERENCE-NESS IS A CLASS, NOT A LIST OF SPELLINGS
//
// Everything above tests the rule on a bare `B1`. These test it on every
// OTHER expression form that delivers a value FROM a reference, because the
// rule is only worth anything if it holds for all of them: two spellings of
// one cell read that answer differently are a wrong TOTAL, and the reader has
// no way to tell which spelling is the honest one.
//
// The regression that prompted them: the INTERSECTION operator shipped in the
// same programme as this rule, and `is_reference_argument` did not know about
// it. `=SUM(A1:A3 A2:C2)` over a TEXT cell answered 2 while `=SUM(A2)` — the
// identical cell — answered 0.
// ===================================================================

/// A2 holds the TEXT "2"; A1 and A3 hold real numbers. B2 and C2 hold text too,
/// so `A1:A3 A2:C2` intersects to exactly A2 — a SINGLE-CELL reference reached
/// by an operator rather than by a name.
fn intersection_grid() -> Grid {
    let mut g = Grid::new();
    g.set_cell(0, 0, Cell::new_number(1.0));
    g.set_cell(1, 0, Cell::new_text("2".to_string()));
    g.set_cell(2, 0, Cell::new_number(3.0));
    g.set_cell(1, 1, Cell::new_text("2".to_string()));
    g.set_cell(1, 2, Cell::new_text("2".to_string()));
    g
}

/// THE REGRESSION. A single-cell INTERSECTION is a cell read, so the text in it
/// is ignored exactly as `=SUM(A2)` ignores it.
///
/// Before the fix `=SUM(A1:A3 A2:C2)` was 2 and `=COUNT(...)` was 1 — the text
/// coerced — while the two formulas beneath them, reaching the same cell, were
/// 0 and 0. The assertion is written as an EQUALITY between the two spellings
/// rather than against the literal 0, because that is the property that matters:
/// they must not be allowed to drift apart in either direction.
#[test]
fn a_single_cell_intersection_is_still_a_reference() {
    let g = intersection_grid();
    assert_eq!(num(&g, "=SUM(A1:A3 A2:C2)"), num(&g, "=SUM(A2)"));
    assert_eq!(num(&g, "=SUM(A1:A3 A2:C2)"), 0.0);
    assert_eq!(num(&g, "=COUNT(A1:A3 A2:C2)"), num(&g, "=COUNT(A2)"));
    assert_eq!(num(&g, "=COUNT(A1:A3 A2:C2)"), 0.0);
    // A MULTI-cell intersection was never affected — it materialises as an
    // Array and the collector's recursion already treats members as indirect.
    // Asserted anyway as the CONTROL that the fix did not change it.
    assert_eq!(num(&g, "=SUM(A1:A3 A1:C3)"), 4.0);
    // And the numbers really are reachable through the intersection, so "0" is
    // not "the intersection returns nothing".
    assert_eq!(num(&g, "=SUM(A1:A3 A1:C1)"), 1.0);
    assert_eq!(num(&g, "=SUM(A1:A3 A3:C3)"), 3.0);
}

/// THE REFERENCE-RETURNING FUNCTIONS. `INDEX`, `OFFSET` and `INDIRECT` each
/// hand back a reference, and a single-cell result of any of them arrives at
/// the collector as a bare scalar — the same blind spot as the intersection.
/// All three answered 2 before.
#[test]
fn index_offset_and_indirect_deliver_a_reference() {
    let g = intersection_grid();
    assert_eq!(num(&g, "=SUM(INDEX(A1:A3,2))"), 0.0);
    assert_eq!(num(&g, "=SUM(OFFSET(A1,1,0))"), 0.0);
    assert_eq!(num(&g, "=SUM(INDIRECT(\"A2\"))"), 0.0);
    // ...and they still reach the NUMBERS, so 0 is the text being ignored and
    // not the reference failing to resolve.
    assert_eq!(num(&g, "=SUM(INDEX(A1:A3,1))"), 1.0);
    assert_eq!(num(&g, "=SUM(OFFSET(A1,2,0))"), 3.0);
    assert_eq!(num(&g, "=SUM(INDIRECT(\"A3\"))"), 3.0);
}

/// THE CONTROL THAT MAKES THE TEST ON `INDEX` A TEST ON ITS SOURCE. `INDEX`
/// over an ARRAY CONSTANT returns a VALUE, not a reference, so the text in the
/// constant must still coerce.
///
/// This case is why the fix asks whether `args[0]` is a reference instead of
/// matching on the function NAME: a three-name list would have answered 0 here
/// and been wrong. If this assertion ever reads 0, the rule has been widened
/// from "reference-returning" to "reference-named".
#[test]
fn index_over_an_array_constant_still_coerces() {
    let g = intersection_grid();
    assert_eq!(num(&g, "=SUM(INDEX({1,\"2\"},2))"), 2.0);
    assert_eq!(num(&g, "=SUM(INDEX({1;\"2\"},2))"), 2.0);
}

/// `IF` AND `CHOOSE` return whichever branch runs, so they carry reference-ness
/// only when EVERY branch they could return is a reference. Both halves are
/// asserted: the all-reference form must not coerce, and the mixed form must.
///
/// Which branch actually runs is a RUNTIME fact the classifier cannot see. That
/// is why the test is "all branches" rather than "the branch that ran" — under
/// the second rule `=SUM(IF(A1>0,A2,"2"))` would answer 0 or 2 depending on
/// data, which is the one behaviour worse than either constant answer.
#[test]
fn if_and_choose_carry_reference_ness_only_when_every_branch_is_one() {
    let g = intersection_grid();
    // Every branch a reference -> a reference, whichever way the test goes.
    assert_eq!(num(&g, "=SUM(IF(TRUE,A2,A1))"), 0.0);
    assert_eq!(num(&g, "=SUM(IF(FALSE,A1,A2))"), 0.0);
    assert_eq!(num(&g, "=SUM(CHOOSE(1,A2,A1))"), 0.0);
    assert_eq!(num(&g, "=SUM(CHOOSE(2,A1,A2))"), 0.0);
    // ...and the numbers still arrive, so 0 is not "IF returned nothing".
    assert_eq!(num(&g, "=SUM(IF(TRUE,A1,A2))"), 1.0);
    assert_eq!(num(&g, "=SUM(CHOOSE(2,A2,A3))"), 3.0);
    // A MIXED branch list is a VALUE expression and keeps coercing — the
    // conservative direction, and the behaviour that shipped.
    assert_eq!(num(&g, "=SUM(IF(TRUE,A2,\"2\"))"), 2.0);
    assert_eq!(num(&g, "=SUM(CHOOSE(1,\"2\",A2))"), 2.0);
    // The two-argument IF omits the FALSE branch, whose value is the boolean
    // FALSE — a value, so the whole call is a value.
    assert_eq!(num(&g, "=SUM(IF(TRUE,A2))"), 2.0);
}

/// The forms that ALREADY worked, asserted so a future refactor of
/// `is_reference_argument` cannot quietly lose them while adding the new ones.
/// `@` picks one cell out of a reference; a redundant parenthesis is not a node
/// at all; a one-cell range is a range.
#[test]
fn the_reference_forms_that_already_worked_still_do() {
    let g = intersection_grid();
    assert_eq!(num(&g, "=SUM((A2))"), 0.0);
    assert_eq!(num(&g, "=SUM(A2:A2)"), 0.0);
    assert_eq!(num(&g, "=SUM(A:A)"), 4.0);
    assert_eq!(num(&g, "=SUM(2:2)"), 0.0);
    // CONTROL: the whole-row sum is 0 because row 2 is ALL text. Row 1 has a
    // number in it, so a rule that returned 0 for every row reference would
    // fail here.
    assert_eq!(num(&g, "=SUM(1:1)"), 1.0);
}

/// NAME-BOUND VALUES, and a KNOWN DIVERGENCE PINNED SO IT IS A DECISION RATHER
/// THAN A GAP (measured 2026-08-24).
///
/// A `LET` binding is spelled as a bare identifier, which parses to `NamedRef`,
/// which is classified as a reference UNCONDITIONALLY — the classifier walks
/// expressions and cannot see what the name was bound to. So the reference case
/// is right for the right-ish reason (`=LET(x,A2,SUM(x))` is 0, matching
/// `=SUM(A2)`), and the VALUE case leans the same way: `=LET(x,"2",SUM(x))` is
/// 0 where Excel answers 2, because Excel remembers that `x` holds a typed
/// value.
///
/// That is the CONSERVATIVE direction — a total that ignores text rather than
/// one that silently absorbs it — and getting it exactly right needs the value
/// itself to carry its provenance rather than the expression, which is the
/// reference-propagation job this file's rule deliberately stops short of.
/// Asserted at the CURRENT answers so the next person to touch it finds out the
/// case exists from a failure rather than from a bug report.
#[test]
fn a_name_bound_value_is_treated_as_a_reference_whatever_it_holds() {
    let g = intersection_grid();
    // RIGHT: a name bound to a text CELL does not coerce, matching `=SUM(A2)`.
    assert_eq!(num(&g, "=LET(x,A2,SUM(x))"), 0.0);
    assert_eq!(num(&g, "=SUM(A2)"), 0.0);
    // ...and a name bound to a numeric cell still totals, so this is not "LET
    // sums nothing".
    assert_eq!(num(&g, "=LET(x,A1,SUM(x))"), 1.0);
    // DIVERGENT: a name bound to a typed TEXT VALUE also refuses to coerce.
    // Excel answers 2 — the value was typed, so it is direct.
    assert_eq!(
        num(&g, "=LET(x,\"2\",SUM(x))"),
        0.0,
        "Excel answers 2 here; see this test's doc before changing it"
    );
    // The same shape through a LAMBDA parameter, which binds the same way.
    assert_eq!(num(&g, "=SUM(LAMBDA(v,SUM(v))(A2))"), 0.0);
    assert_eq!(
        num(&g, "=SUM(LAMBDA(v,SUM(v))(\"2\"))"),
        0.0,
        "Excel answers 2 here; see this test's doc before changing it"
    );
}
