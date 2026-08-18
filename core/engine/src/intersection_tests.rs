//! FILENAME: core/engine/src/intersection_tests.rs
//! PURPOSE: Excel's SPACE intersection operator, and the `#NULL!` it produces
//!          (open-items 2.1).
//!
//! WHAT WAS ACTUALLY WRONG, and it was not what the item said. The item read
//! "`#NULL!` is never produced" and pointed at an unused `CellError` variant, as
//! though a missing arm somewhere needed filling in. The truth was one layer down:
//! **the space intersection operator was not parsed at all.** The lexer's
//! `skip_whitespace` consumed every space and emitted nothing, so `=A1:A5 C1:C5`
//! could not even reach an evaluator — `Parser::parse` failed with "Unexpected
//! token after expression", the cell stored the formula anyway, and the user saw
//! `#VALUE!` on a cell that carried NO dependency edges and therefore never
//! recalculated either.
//!
//! So there was no smaller honest fix. Mapping the parse failure to `#NULL!` would
//! have been right for `=A1:A5 C1:C5` and WRONG for `=A1:B5 B1:C5`, which Excel
//! answers with the overlapping column's values — trading one wrong error for a
//! wrong error plus a wrong success.
//!
//! EVERY `#NULL!` CASE IS PAIRED WITH AN OVERLAP CONTROL. A guard that returns
//! `#NULL!` for everything would satisfy half these tests, and it would be a worse
//! defect than the one being fixed: intersection is mostly USED for the overlap.

use crate::cell::{Cell, CellError};
use crate::evaluator::{EvalResult, Evaluator};
use crate::grid::Grid;

fn eval(grid: &Grid, formula: &str) -> EvalResult {
    let ast = parser::parse(formula).expect("formula parses");
    Evaluator::new(grid).evaluate(&ast)
}

/// A 3x3 block at A1:C3 holding 1..9 reading left-to-right, top-to-bottom.
fn grid_3x3() -> Grid {
    let mut grid = Grid::new();
    let mut n = 0.0;
    for row in 1..=3u32 {
        for col in 0..3u32 {
            n += 1.0;
            grid.set_cell(row - 1, col, Cell::new_number(n));
        }
    }
    grid
}

#[test]
fn non_overlapping_ranges_are_the_null_error() {
    let grid = grid_3x3();
    // THE CASE THE ITEM WAS ABOUT. Before this, a hard parse error surfacing as
    // #VALUE! on a cell with no dependency edges.
    assert_eq!(
        eval(&grid, "=SUM(A1:A3 C1:C3)"),
        EvalResult::Error(CellError::Null),
        "columns A and C share no cell, which is the one thing in Excel that \
         produces #NULL!"
    );
    assert_eq!(
        eval(&grid, "=SUM(A1:C1 A3:C3)"),
        EvalResult::Error(CellError::Null),
        "rows 1 and 3 share no cell either"
    );
}

#[test]
fn an_overlap_is_the_overlapping_reference_not_an_error() {
    // THE CONTROL for the test above. Without this, returning #NULL! for every
    // intersection would pass — and intersection is mostly used for the overlap.
    let grid = grid_3x3();

    // A1:A3 (column A) x A2:C2 (row 2) = A2, which holds 4.
    assert_eq!(eval(&grid, "=SUM(A1:A3 A2:C2)"), EvalResult::Number(4.0));

    // A1:B3 x B1:C3 = column B = 2 + 5 + 8.
    assert_eq!(eval(&grid, "=SUM(A1:B3 B1:C3)"), EvalResult::Number(15.0));

    // A single cell inside a range intersects to itself.
    assert_eq!(eval(&grid, "=SUM(A1:C3 B2)"), EvalResult::Number(5.0));
}

#[test]
fn whole_column_and_whole_row_intersect_to_one_cell() {
    // The unbounded-axis case, which is why the rectangles carry a `u32::MAX`
    // sentinel rather than a materialised bound: `A:A 2:2` must be the cell A2,
    // not a million-row range.
    let grid = grid_3x3();
    assert_eq!(eval(&grid, "=SUM(A:A 2:2)"), EvalResult::Number(4.0));
    assert_eq!(eval(&grid, "=SUM(B:B 3:3)"), EvalResult::Number(8.0));
    // Two whole columns still intersect on the column axis.
    assert_eq!(eval(&grid, "=SUM(A:B B:C)"), EvalResult::Number(15.0));
    // ...and two disjoint whole columns do not.
    assert_eq!(eval(&grid, "=SUM(A:A C:C)"), EvalResult::Error(CellError::Null));
}

#[test]
fn intersection_binds_tighter_than_arithmetic() {
    // Excel's reference operators bind before arithmetic, so `A1:A3 A2:C2 + 1` is
    // (the intersection) + 1 = 5, not an intersection with `C2 + 1`.
    let grid = grid_3x3();
    assert_eq!(eval(&grid, "=A1:A3 A2:C2 + 1"), EvalResult::Number(5.0));
    // And tighter than `^`, which is why PREC_INTERSECT sits above PREC_POWER.
    assert_eq!(eval(&grid, "=A1:A3 A2:C2 ^ 2"), EvalResult::Number(16.0));
}

#[test]
fn intersection_is_left_associative_and_chains() {
    let grid = grid_3x3();
    // A1:C3 x B1:B3 = B column; that x B2:B2 = B2 = 5.
    assert_eq!(eval(&grid, "=SUM(A1:C3 B1:B3 B2:B2)"), EvalResult::Number(5.0));
    // A chain whose SECOND step empties the overlap is #NULL!, not the first
    // step's answer — a right-associative reading would have answered 15.
    assert_eq!(
        eval(&grid, "=SUM(A1:C3 A1:A3 C1:C3)"),
        EvalResult::Error(CellError::Null)
    );
}

#[test]
fn a_space_that_is_not_between_references_still_means_what_it_did() {
    // THE REGRESSION RISK OF THE WHOLE CHANGE. The lexer discards whitespace, so
    // making a space significant could have changed what ordinary formulas mean.
    // These all had a meaning before and must keep it.
    let grid = grid_3x3();
    assert_eq!(eval(&grid, "=SUM(A1:C3)"), EvalResult::Number(45.0));
    assert_eq!(eval(&grid, "= 1 + 2"), EvalResult::Number(3.0));
    assert_eq!(eval(&grid, "=A1 + B1"), EvalResult::Number(3.0));
    assert_eq!(eval(&grid, "=SUM( A1 , B1 )"), EvalResult::Number(3.0));
    assert_eq!(eval(&grid, "=IF( A1 > 0 , 10 , 20 )"), EvalResult::Number(10.0));
    // A space before a NUMBER is not an intersection: only a reference-shaped
    // token can begin a second operand.
    assert_eq!(eval(&grid, "=A1 * 3"), EvalResult::Number(3.0));
}

#[test]
fn the_operator_round_trips_through_the_renderer() {
    // The formula the user sees and the string saved to `.cala` are both RENDERED
    // FROM THE AST, so a renderer that dropped the space would silently rewrite
    // `A1:A3 A2:C2` into `A1:A3A2:C2` — which is a different formula and does not
    // parse back. This is the defect class that once turned 47 built-ins into Rust
    // variant names.
    for src in [
        "A1:A3 A2:C2",
        "SUM(A1:A3 A2:C2)",
        "A1:C3 B1:B3 B2:B2",
        "A:A 2:2",
        "A1:A3 A2:C2+1",
    ] {
        let ast = parser::parse(&format!("={}", src)).expect("parses");
        let rendered = crate::ast_render::render_formula(&ast);
        let reparsed = parser::parse(&format!("={}", rendered))
            .unwrap_or_else(|e| panic!("re-parse of {:?} failed: {:?}", rendered, e));
        assert_eq!(
            ast, reparsed,
            "rendering {:?} produced {:?}, which parses to a DIFFERENT AST",
            src, rendered
        );
        assert!(
            rendered.contains(' '),
            "the intersection space must survive rendering; got {:?}",
            rendered
        );
    }
}
