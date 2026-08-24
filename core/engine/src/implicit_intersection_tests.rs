//! FILENAME: core/engine/src/implicit_intersection_tests.rs
//! PURPOSE: Excel's `@` operator — the exceljet glossary term "implicit
//!          intersection".
//!
//! THE WHOLE OPERATOR WAS UNTESTED. A repo-wide grep for `=@` matched two source
//! comments and nothing else, while two design docs listed "Implicit
//! intersection (@)" under implemented features without qualification — which is
//! how a half-built operator reads as complete. Three of its four rules were
//! wrong:
//!
//!   =@SEQUENCE(3)   answered element 0 in row 1, element 1 in row 2 and
//!                   #VALUE! from row 4 down. It indexed the array by
//!                   `current_row`, the ABSOLUTE grid row, so the answer
//!                   depended on where the formula was typed and was right in
//!                   row 1 only by accident. Excel reduces an ARRAY to its
//!                   top-left element, wherever the formula sits.
//!   =@A1:A1         #VALUE!. A one-cell reference is already a single value;
//!                   it fell through to the "formula is outside the range" arm.
//!   =@A1:C3         returned the formula's OWN cell — a self-reference rather
//!                   than an intersection, so the 2-D branch was degenerate.
//!
//! NOT A DEFECT ANY MORE, and worth recording so it is not re-filed: `=B4:B8+1`
//! used to be #VALUE! and was reported as "automatic implicit intersection is
//! missing". It now SPILLS, because the operators lift over arrays — and
//! spilling is what Excel 365 does with that formula. Legacy implicit
//! intersection is what `@` is FOR; it is not something a modern engine should
//! apply on its own.

use crate::cell::{Cell, CellError};
use crate::evaluator::{EvalContext, EvalResult, Evaluator, MultiSheetContext};
use crate::grid::Grid;

/// Evaluate `formula` as if it were typed in (row, col), 0-based.
///
/// THE POSITION IS THE POINT of every test here: `@` reduces a reference against
/// the formula's OWN row or column, so a test that did not vary it could not
/// have caught the row-position-dependent defect this file exists for.
fn eval_at(grid: &Grid, formula: &str, row: u32, col: u32) -> EvalResult {
    let ast = parser::parse(formula).expect("formula parses");
    let ctx = EvalContext {
        current_row: Some(row),
        current_col: Some(col),
        ..Default::default()
    };
    let ms = MultiSheetContext::new("Sheet1".to_string());
    Evaluator::with_context(grid, ms, ctx).evaluate(&ast)
}

/// B4:B8 = 10,20,30,40,50 (0-based rows 3..7, column B).
/// D1:F1 = 7,8,9 (0-based row 0, columns D..F).
fn fixture() -> Grid {
    let mut g = Grid::new();
    for (i, v) in [10.0, 20.0, 30.0, 40.0, 50.0].iter().enumerate() {
        g.set_cell(3 + i as u32, 1, Cell::new_number(*v));
    }
    for (i, v) in [7.0, 8.0, 9.0].iter().enumerate() {
        g.set_cell(0, 3 + i as u32, Cell::new_number(*v));
    }
    g
}

#[test]
fn a_single_column_reference_reduces_to_the_formulas_row() {
    let g = fixture();
    // Typed in row 6 (0-based 5), `@B4:B8` is B6 = 30.
    assert_eq!(eval_at(&g, "=@B4:B8", 5, 3), EvalResult::Number(30.0));
    assert_eq!(eval_at(&g, "=@B4:B8", 3, 3), EvalResult::Number(10.0));
    assert_eq!(eval_at(&g, "=@B4:B8", 7, 3), EvalResult::Number(50.0));
    // Outside the span there is no intersection.
    assert_eq!(eval_at(&g, "=@B4:B8", 8, 3), EvalResult::Error(CellError::Value));
    assert_eq!(eval_at(&g, "=@B4:B8", 0, 3), EvalResult::Error(CellError::Value));
}

#[test]
fn a_single_row_reference_reduces_to_the_formulas_column() {
    let g = fixture();
    // Typed in column E (0-based 4), `@D1:F1` is E1 = 8.
    assert_eq!(eval_at(&g, "=@D1:F1", 5, 4), EvalResult::Number(8.0));
    assert_eq!(eval_at(&g, "=@D1:F1", 5, 3), EvalResult::Number(7.0));
    assert_eq!(eval_at(&g, "=@D1:F1", 5, 5), EvalResult::Number(9.0));
    assert_eq!(eval_at(&g, "=@D1:F1", 5, 6), EvalResult::Error(CellError::Value));
}

#[test]
fn a_one_cell_reference_reduces_to_itself_from_anywhere() {
    let g = fixture();
    // This answered #VALUE! from every cell but B5 itself: a 1x1 range is
    // neither "a column containing my row" nor "a row containing my column" by
    // the old tests, so it fell into the no-intersection arm.
    assert_eq!(eval_at(&g, "=@B5", 40, 40), EvalResult::Number(20.0));
    assert_eq!(eval_at(&g, "=@B5:B5", 40, 40), EvalResult::Number(20.0));
}

#[test]
fn an_array_reduces_to_its_top_left_element_wherever_the_formula_sits() {
    let g = fixture();
    // THE ROW-POSITION-DEPENDENT DEFECT. The old code indexed the array by the
    // absolute grid row, so this answered 1 in row 1, 2 in row 2 and #VALUE!
    // from row 4 down. Excel's answer is 1 from every cell.
    for row in [0u32, 1, 2, 5, 40] {
        assert_eq!(
            eval_at(&g, "=@SEQUENCE(3)", row, 9),
            EvalResult::Number(1.0),
            "row {} disagreed",
            row
        );
    }
    assert_eq!(eval_at(&g, "=@{5;6;7}", 40, 9), EvalResult::Number(5.0));
    // A 2-D array takes its top-left cell, not its first row.
    assert_eq!(eval_at(&g, "=@{1,2;3,4}", 40, 9), EvalResult::Number(1.0));
    // A scalar is already one value.
    assert_eq!(eval_at(&g, "=@42", 40, 9), EvalResult::Number(42.0));
}

#[test]
fn a_two_dimensional_reference_has_no_intersection() {
    let mut g = fixture();
    g.set_cell(1, 1, Cell::new_number(99.0)); // B2, inside A1:C3
    // Outside: #VALUE!, as Excel gives.
    assert_eq!(eval_at(&g, "=@A1:C3", 9, 9), EvalResult::Error(CellError::Value));
    // INSIDE is the case that mattered: this used to return the formula's own
    // cell, which is a self-reference dressed up as an intersection.
    assert_eq!(eval_at(&g, "=@A1:C3", 1, 1), EvalResult::Error(CellError::Value));
}

#[test]
fn a_whole_column_reference_intersects_by_row_not_by_position() {
    let g = fixture();
    // `@A:A` used to fall through to the ARRAY path, where a whole-column
    // reference is a vector of populated cells — so it answered the FIRST
    // populated cell rather than the one on this row.
    assert_eq!(eval_at(&g, "=@B:B", 5, 9), EvalResult::Number(30.0));
    assert_eq!(eval_at(&g, "=@B:B", 3, 9), EvalResult::Number(10.0));
    // A whole ROW reference intersects by column.
    assert_eq!(eval_at(&g, "=@1:1", 9, 4), EvalResult::Number(8.0));
}

#[test]
fn an_undecorated_range_still_spills_rather_than_reducing() {
    // THE CONTROL FOR THE WHOLE FEATURE. `@` is opt-in: a bare range in
    // arithmetic must keep Excel 365's dynamic-array behaviour and produce an
    // ARRAY, not silently reduce to one value. If this ever starts returning a
    // scalar, automatic implicit intersection has crept back in.
    let g = fixture();
    let plus = eval_at(&g, "=B4:B8+1", 5, 9);
    assert_eq!(plus.spill_dimensions(), (5, 1));
    assert_eq!(plus.flatten()[0], EvalResult::Number(11.0));
    // ...and `@` on the same expression takes the top-left of that array.
    assert_eq!(eval_at(&g, "=@(B4:B8+1)", 40, 9), EvalResult::Number(11.0));
}
