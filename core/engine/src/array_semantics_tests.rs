//! FILENAME: core/engine/src/array_semantics_tests.rs
//! PURPOSE: Excel's implicit ARRAY semantics, end to end — the glossary terms
//!          "array operation", "lifting", "pairwise lifting", "broadcasting",
//!          "array constant", "CSE" and "double unary" are all one feature.
//!
//! WHAT WAS ACTUALLY WRONG, measured against the live engine before the fix:
//!
//!   =A1:A3+1                 #VALUE!        (Excel: {2;3;4})
//!   =A1:A3*B1:B3             #VALUE!        (Excel: {10;40;90})
//!   =A1:A3>1                 #VALUE!        (Excel: {FALSE;TRUE;TRUE})
//!   =--(A1:A3>1)             #VALUE!        (Excel: {0;1;1})
//!   =SQRT(A1:A3)             #VALUE!        (Excel: {1;1.414…;1.732…})
//!   =FILTER(A1:A3,A1:A3>1)   #VALUE!        (Excel: {2;3})
//!   =SUM(IF(A1:A3>1,A1:A3))  #VALUE!        (Excel: 5)
//!   ={1;2;3}                 PARSE ERROR    (Excel: a 3x1 array)
//!
//! and — worse than any of those, because nothing on screen says anything is
//! wrong — three answers that were CONFIDENTLY WRONG NUMBERS:
//!
//!   =A1:A3&"x"               "1x"           (Excel: {"1x";"2x";"3x"})
//!   =A1:A3=1                 FALSE          (Excel: {TRUE;FALSE;FALSE})
//!   =SUMPRODUCT(A1:A3*B1:B3) 0              (Excel: 140)
//!
//! The cause was one line: `EvalResult::as_number()` has no `Array` arm and
//! answers `None`, and every arithmetic and comparison helper reduces both
//! operands through it. `as_text()` DOES have an Array arm and returns the
//! FIRST ELEMENT, which is where the silent wrong answers came from.
//!
//! WHY THE WRONG-NUMBER CASES ARE TESTED FIRST BELOW. A fix that made every
//! array operation return an ERROR would satisfy most of the #VALUE! cases
//! above and would still leave `SUMPRODUCT(A1:A3*B1:B3)` wrong. The tests are
//! ordered so the ones with no visible symptom come first.

use crate::cell::{Cell, CellError};
use crate::evaluator::{EvalResult, Evaluator};
use crate::grid::Grid;

fn eval(grid: &Grid, formula: &str) -> EvalResult {
    let ast = parser::parse(formula).expect("formula parses");
    Evaluator::new(grid).evaluate(&ast)
}

fn n(x: f64) -> EvalResult {
    EvalResult::Number(x)
}

/// A1:A3 = 1,2,3 · B1:B3 = 10,20,30 · C1:C3 = "a","b","c" · D1:F1 = 5,6,7
fn fixture() -> Grid {
    let mut grid = Grid::new();
    for (i, v) in [1.0, 2.0, 3.0].iter().enumerate() {
        grid.set_cell(i as u32, 0, Cell::new_number(*v));
    }
    for (i, v) in [10.0, 20.0, 30.0].iter().enumerate() {
        grid.set_cell(i as u32, 1, Cell::new_number(*v));
    }
    for (i, v) in ["a", "b", "c"].iter().enumerate() {
        grid.set_cell(i as u32, 2, Cell::new_text((*v).to_string()));
    }
    for (i, v) in [5.0, 6.0, 7.0].iter().enumerate() {
        grid.set_cell(0, 3 + i as u32, Cell::new_number(*v));
    }
    grid
}

/// The flat (column) form: `Array([a, b, c])` is 3 rows x 1 column.
fn column(vs: Vec<EvalResult>) -> EvalResult {
    EvalResult::Array(vs)
}

/// The nested single-row form: `Array([Array([a, b, c])])` is 1 row x 3 columns.
fn row(vs: Vec<EvalResult>) -> EvalResult {
    EvalResult::Array(vec![EvalResult::Array(vs)])
}

// ===================================================================
// The answers that were WRONG NUMBERS, not errors
// ===================================================================

#[test]
fn sumproduct_over_a_multiplied_pair_is_not_zero() {
    let grid = fixture();
    // THE WORST OF THE SET. `A1:A3*B1:B3` was #VALUE!, SUMPRODUCT skipped the
    // non-numeric argument, and the user got 0 — a plausible total, on a
    // formula that is in every spreadsheet textbook, with no error indicator.
    assert_eq!(eval(&grid, "=SUMPRODUCT(A1:A3*B1:B3)"), n(140.0));
    // The comma form always worked; it is the control that proves the fix did
    // not simply special-case SUMPRODUCT.
    assert_eq!(eval(&grid, "=SUMPRODUCT(A1:A3,B1:B3)"), n(140.0));
}

#[test]
fn concatenating_a_range_does_not_collapse_to_its_first_element() {
    let grid = fixture();
    // `as_text()` answers the first element for an Array, so this was "1x".
    assert_eq!(
        eval(&grid, "=A1:A3&\"x\""),
        column(vec![
            EvalResult::Text("1x".into()),
            EvalResult::Text("2x".into()),
            EvalResult::Text("3x".into()),
        ])
    );
}

#[test]
fn comparing_a_range_does_not_collapse_to_a_single_boolean() {
    let grid = fixture();
    // `eval_equal` ended in `_ => false`, so this answered a bare FALSE.
    assert_eq!(
        eval(&grid, "=A1:A3=1"),
        column(vec![
            EvalResult::Boolean(true),
            EvalResult::Boolean(false),
            EvalResult::Boolean(false),
        ])
    );
}

// ===================================================================
// Scalar lifting, pairwise lifting, broadcasting
// ===================================================================

#[test]
fn a_scalar_lifts_over_every_element() {
    let grid = fixture();
    assert_eq!(eval(&grid, "=A1:A3+1"), column(vec![n(2.0), n(3.0), n(4.0)]));
    assert_eq!(eval(&grid, "=A1:A3*2"), column(vec![n(2.0), n(4.0), n(6.0)]));
    assert_eq!(eval(&grid, "=A1:A3^2"), column(vec![n(1.0), n(4.0), n(9.0)]));
    assert_eq!(eval(&grid, "=10/A1:A3"), column(vec![n(10.0), n(5.0), n(10.0 / 3.0)]));
}

#[test]
fn two_arrays_of_the_same_shape_pair_up_element_by_element() {
    let grid = fixture();
    assert_eq!(
        eval(&grid, "=A1:A3*B1:B3"),
        column(vec![n(10.0), n(40.0), n(90.0)])
    );
    assert_eq!(
        eval(&grid, "=B1:B3-A1:A3"),
        column(vec![n(9.0), n(18.0), n(27.0)])
    );
}

#[test]
fn a_row_against_a_column_broadcasts_into_a_matrix() {
    let grid = fixture();
    // 1x3 (D1:F1 = 5,6,7) against 3x1 (A1:A3 = 1,2,3) is Excel's outer product.
    assert_eq!(
        eval(&grid, "=D1:F1*A1:A3"),
        EvalResult::Array(vec![
            EvalResult::Array(vec![n(5.0), n(6.0), n(7.0)]),
            EvalResult::Array(vec![n(10.0), n(12.0), n(14.0)]),
            EvalResult::Array(vec![n(15.0), n(18.0), n(21.0)]),
        ])
    );
}

#[test]
fn a_shape_mismatch_fills_the_ragged_corner_with_na_rather_than_refusing() {
    let grid = fixture();
    // Excel does NOT reject `{1;2;3}+{1;2}` — it answers `{2;4;#N/A}`. Refusing
    // the whole formula would be the tidier rule and the wrong one.
    assert_eq!(
        eval(&grid, "={1;2;3}+{1;2}"),
        column(vec![n(2.0), n(4.0), EvalResult::Error(CellError::NA)])
    );
}

#[test]
fn comparison_operators_lift_which_is_what_filter_needs() {
    let grid = fixture();
    assert_eq!(
        eval(&grid, "=A1:A3>1"),
        column(vec![
            EvalResult::Boolean(false),
            EvalResult::Boolean(true),
            EvalResult::Boolean(true),
        ])
    );
    // THE POINT OF THE ABOVE. A computed condition is how FILTER is used in
    // practice, and it returned #VALUE! because `get_range_dimensions` read the
    // condition SYNTACTICALLY, saw a BinaryOp rather than a Range, and called
    // it 1x1.
    assert_eq!(eval(&grid, "=FILTER(A1:A3,A1:A3>1)"), column(vec![n(2.0), n(3.0)]));
    let one = eval(&grid, "=FILTER(A1:A3,C1:C3=\"b\")");
    assert_eq!(one.spill_dimensions(), (1, 1));
    assert_eq!(one.flatten(), vec![n(2.0)]);
}

#[test]
fn the_double_unary_turns_an_array_of_booleans_into_ones_and_zeros() {
    let grid = fixture();
    // The idiom the operator is NAMED for. Both negations must lift.
    assert_eq!(
        eval(&grid, "=--(A1:A3>1)"),
        column(vec![n(0.0), n(1.0), n(1.0)])
    );
    assert_eq!(eval(&grid, "=SUMPRODUCT(--(A1:A3>1))"), n(2.0));
    assert_eq!(eval(&grid, "=-A1:A3"), column(vec![n(-1.0), n(-2.0), n(-3.0)]));
}

// ===================================================================
// Function lifting
// ===================================================================

#[test]
fn a_scalar_function_lifts_over_an_array_argument() {
    let grid = fixture();
    assert_eq!(eval(&grid, "=INT(A1:A3)"), column(vec![n(1.0), n(2.0), n(3.0)]));
    assert_eq!(eval(&grid, "=ABS(-A1:A3)"), column(vec![n(1.0), n(2.0), n(3.0)]));
    assert_eq!(
        eval(&grid, "=UPPER(C1:C3)"),
        column(vec![
            EvalResult::Text("A".into()),
            EvalResult::Text("B".into()),
            EvalResult::Text("C".into()),
        ])
    );
    // Two array arguments lift together.
    assert_eq!(
        eval(&grid, "=ROUND(A1:A3/3,A1:A3)"),
        column(vec![n(0.3), n(0.67), n(1.0)])
    );
}

#[test]
fn an_aggregate_is_not_lifted_or_it_would_run_once_per_cell() {
    let grid = fixture();
    // SUM/COUNT/MAX consume the whole array — the allowlist in
    // `lifts_over_arrays` exists to keep them off the lifting path. If SUM ever
    // lifted, this would be `{1;2;3}` instead of 6.
    assert_eq!(eval(&grid, "=SUM(A1:A3)"), n(6.0));
    assert_eq!(eval(&grid, "=COUNT(A1:A3)"), n(3.0));
    assert_eq!(eval(&grid, "=MAX(A1:A3)"), n(3.0));
    // And an aggregate OVER a lifted expression is the classic array formula.
    assert_eq!(eval(&grid, "=SUM(A1:A3*B1:B3)"), n(140.0));
    assert_eq!(eval(&grid, "=MAX(A1:A3*B1:B3)"), n(90.0));
}

#[test]
fn if_lifts_over_an_array_condition_but_keeps_its_short_circuit_for_a_scalar() {
    let grid = fixture();
    // The legacy array idiom, and the reason IF is handled separately from the
    // liftable allowlist.
    assert_eq!(eval(&grid, "=SUM(IF(A1:A3>1,A1:A3))"), n(5.0));
    assert_eq!(
        eval(&grid, "=IF(A1:A3>1,\"y\",\"n\")"),
        column(vec![
            EvalResult::Text("n".into()),
            EvalResult::Text("y".into()),
            EvalResult::Text("y".into()),
        ])
    );
    // THE CONTROL. A scalar condition must still take exactly one branch: if
    // both were evaluated, the divide-by-zero in the untaken branch would
    // surface. (A1 is 1, so the guard is false and the division is skipped.)
    let mut g = Grid::new();
    g.set_cell(0, 0, Cell::new_number(0.0));
    assert_eq!(eval(&g, "=IF(A1=0,0,1/A1)"), n(0.0));
}

// ===================================================================
// Array constants
// ===================================================================

#[test]
fn an_array_constant_has_the_shape_its_separators_describe() {
    let grid = Grid::new();
    // `,` breaks COLUMNS, `;` breaks ROWS. A row spills across; a column
    // spills down. Before this, `={1;2;3}` was not merely unevaluated — the
    // lexer had no `;` at all, so the formula failed to parse and the cell
    // stored the literal text `{1;2;3}` with no error of any kind.
    assert_eq!(eval(&grid, "={1,2,3}"), row(vec![n(1.0), n(2.0), n(3.0)]));
    assert_eq!(eval(&grid, "={1;2;3}"), column(vec![n(1.0), n(2.0), n(3.0)]));
    assert_eq!(
        eval(&grid, "={1,2;3,4}"),
        EvalResult::Array(vec![
            EvalResult::Array(vec![n(1.0), n(2.0)]),
            EvalResult::Array(vec![n(3.0), n(4.0)]),
        ])
    );

    // The shapes must survive as SPILL dimensions, or a row constant would
    // spill down the sheet instead of across it.
    assert_eq!(eval(&grid, "={1,2,3}").spill_dimensions(), (1, 3));
    assert_eq!(eval(&grid, "={1;2;3}").spill_dimensions(), (3, 1));
    assert_eq!(eval(&grid, "={1,2;3,4}").spill_dimensions(), (2, 2));
}

#[test]
fn an_array_constant_holds_text_booleans_and_errors() {
    let grid = Grid::new();
    assert_eq!(
        eval(&grid, "={\"a\",\"b\"}"),
        row(vec![EvalResult::Text("a".into()), EvalResult::Text("b".into())])
    );
    assert_eq!(
        eval(&grid, "={TRUE;FALSE}"),
        column(vec![EvalResult::Boolean(true), EvalResult::Boolean(false)])
    );
    // An error ELEMENT does not collapse the constant: Excel's `={1,NA()}` is a
    // legal array whose second cell is #N/A.
    assert_eq!(
        eval(&grid, "={1,NA()}"),
        row(vec![n(1.0), EvalResult::Error(CellError::NA)])
    );
}

#[test]
fn array_constants_feed_the_functions_that_exist_to_consume_them() {
    let grid = fixture();
    assert_eq!(eval(&grid, "=SUM({1,2,3})"), n(6.0));
    assert_eq!(eval(&grid, "=SUM({1;2;3}*{2;2;2})"), n(12.0));
    // The classic hard-coded lookup table.
    assert_eq!(eval(&grid, "=SUM(SQRT({1,4,9}))"), n(6.0));
}

#[test]
fn braces_still_mean_dict_when_a_colon_follows_the_first_element() {
    let grid = Grid::new();
    // Reclaiming `{...}` for Excel must not take Calcula's dict literal with
    // it — the two are told apart by the colon, exactly as the parser does.
    assert!(matches!(
        eval(&grid, "={\"a\": 1, \"b\": 2}"),
        EvalResult::Dict(_)
    ));
    // COLLECT is the List's remaining spelling, and it still does not spill.
    assert_eq!(eval(&grid, "=COLLECT(1,2,3)").spill_dimensions(), (1, 1));
}

// ===================================================================
// The operators that did not exist
// ===================================================================

#[test]
fn a_leading_plus_is_accepted_the_way_excel_accepts_it() {
    let grid = fixture();
    // `=+A1` is a Lotus habit Excel never dropped, so real workbooks are full
    // of it. It used to be a parse error stored as #VALUE!.
    assert_eq!(eval(&grid, "=+A1"), n(1.0));
    assert_eq!(eval(&grid, "=+SUM(A1:A3)"), n(6.0));
    assert_eq!(eval(&grid, "=1++1"), n(2.0));
    // It is a NO-OP, not a coercion: Excel's `=+"abc"` is "abc" while
    // `=-"abc"` is #VALUE!.
    assert_eq!(eval(&grid, "=+C1"), EvalResult::Text("a".into()));
    assert_eq!(eval(&grid, "=-C1"), EvalResult::Error(CellError::Value));
}

#[test]
fn postfix_percent_divides_by_a_hundred() {
    let grid = fixture();
    assert_eq!(eval(&grid, "=50%"), n(0.5));
    assert_eq!(eval(&grid, "=A1%"), n(0.01));
    assert_eq!(eval(&grid, "=(1+1)%"), n(0.02));
    assert_eq!(eval(&grid, "=SUM(A1:A3)%"), n(0.06));
    // Binds tighter than `*`, so this is A1 times 0.2, not 20% of the product.
    assert_eq!(eval(&grid, "=B1*20%"), n(2.0));
    // And it lifts.
    assert_eq!(
        eval(&grid, "=B1:B3%"),
        column(vec![n(0.1), n(0.2), n(0.3)])
    );
}

#[test]
fn the_precedence_of_power_matches_excel_in_both_directions() {
    let grid = Grid::new();
    // LEFT-associative: `(2^3)^2` = 64. Excel folds equal priority left to
    // right with no exception for `^`.
    assert_eq!(eval(&grid, "=2^3^2"), n(64.0));
    // Negation binds TIGHTER than `^`, so the -2 is what gets squared.
    assert_eq!(eval(&grid, "=-2^2"), n(4.0));
    // Percent binds tighter still.
    assert_eq!(eval(&grid, "=2^2%"), n(2.0f64.powf(0.02)));
}
