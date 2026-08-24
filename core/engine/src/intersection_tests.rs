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

// ===================================================================
// Sheet qualifiers: the operands are compared by RESOLVED SHEET, never by
// how the sheet was SPELLED.
// ===================================================================

/// THE DEFECT: `eval_intersect` compared the two operands' raw `Option<String>`
/// sheet qualifiers, so two references to the SAME sheet failed to intersect
/// unless they were written identically.
///
/// `=SUM(Sheet1!A1:A3 A2:C2)` — a qualified operand and an unqualified one,
/// which is the NORMAL way to write this, because the qualifier is what tells
/// the reader which sheet the pair is about — answered `#NULL!` even though A2
/// is plainly inside both rectangles.
///
/// WHY THAT WAS WORSE THAN A SYNTAX COMPLAINT. `#NULL!` means "these ranges do
/// not overlap". It is a statement about the user's DATA, and it was false. A
/// user reading it goes and looks at their ranges, which are fine.
#[test]
fn a_sheet_qualifier_on_one_operand_still_intersects() {
    let grid = grid_3x3();
    // A1:A3 (column A) x A2:C2 (row 2) = A2, which holds 4. The unqualified
    // spelling of exactly this is asserted above in
    // `an_overlap_is_the_overlapping_reference_not_an_error`; the point here is
    // that adding a qualifier must not change the answer.
    assert_eq!(eval(&grid, "=SUM(Sheet1!A1:A3 A2:C2)"), EvalResult::Number(4.0));
    // ...and on the OTHER operand, because a fix that only canonicalized the
    // left-hand side would pass the line above.
    assert_eq!(eval(&grid, "=SUM(A1:A3 Sheet1!A2:C2)"), EvalResult::Number(4.0));
    // Both qualified, same sheet.
    assert_eq!(
        eval(&grid, "=SUM(Sheet1!A1:A3 Sheet1!A2:C2)"),
        EvalResult::Number(4.0)
    );
    // A larger overlap, so a fix that collapsed every intersection to a single
    // cell could not pass: A1:B3 x B1:C3 = column B = 2 + 5 + 8.
    assert_eq!(eval(&grid, "=SUM(Sheet1!A1:B3 B1:C3)"), EvalResult::Number(15.0));
}

/// THE CONTROL FOR THE TEST ABOVE, and the assertion that keeps the fix from
/// being "ignore sheets entirely".
///
/// Two operands that genuinely name DIFFERENT sheets have no cells in common
/// and must still be `#NULL!`. Without this, deleting the sheet comparison
/// outright would satisfy every other test in this section.
#[test]
fn genuinely_different_sheets_still_have_nothing_in_common() {
    use crate::evaluator::MultiSheetContext;

    let s1 = grid_3x3();
    let s2 = grid_3x3();
    let mut ms = MultiSheetContext::new("Sheet1".to_string());
    ms.add_grid("Sheet1".to_string(), &s1);
    ms.add_grid("Sheet2".to_string(), &s2);
    let ev = Evaluator::with_context(&s1, ms, crate::evaluator::EvalContext::default());

    let run = |f: &str| {
        let ast = parser::parse(f).expect("formula parses");
        ev.evaluate(&ast)
    };

    // Rectangles that WOULD overlap if they were on one sheet. That is what
    // makes this a real control: the geometry cannot be what produces #NULL!.
    assert_eq!(
        run("=SUM(Sheet1!A1:A3 Sheet2!A2:C2)"),
        EvalResult::Error(CellError::Null),
        "two different sheets share no cell, however the rectangles line up"
    );
    // The unqualified operand means the CURRENT sheet (Sheet1), so pairing it
    // with Sheet2 is also two different sheets.
    assert_eq!(
        run("=SUM(A1:A3 Sheet2!A2:C2)"),
        EvalResult::Error(CellError::Null)
    );
    // And the positive control on the same evaluator, so the #NULL!s above are
    // not just "this context cannot intersect anything".
    assert_eq!(run("=SUM(Sheet1!A1:A3 A2:C2)"), EvalResult::Number(4.0));
    assert_eq!(run("=SUM(Sheet2!A1:A3 Sheet2!A2:C2)"), EvalResult::Number(4.0));
}

/// Sheet names compare CASE-INSENSITIVELY, as they do everywhere else in the
/// engine.
///
/// The lexer uppercases BARE identifiers, so `Sheet1!` and `SHEET1!` already
/// arrived spelled the same and accidentally worked. A QUOTED name keeps its
/// case (`'Sheet1'!`), which is exactly how the spelling comparison could still
/// fail for two references to one sheet — and quoting is not exotic: it is
/// mandatory the moment a sheet name contains a space.
#[test]
fn sheet_names_intersect_case_insensitively_including_quoted_ones() {
    let grid = grid_3x3();
    assert_eq!(eval(&grid, "=SUM(Sheet1!A1:A3 SHEET1!A2:C2)"), EvalResult::Number(4.0));
    assert_eq!(eval(&grid, "=SUM('Sheet1'!A1:A3 SHEET1!A2:C2)"), EvalResult::Number(4.0));
    assert_eq!(eval(&grid, "=SUM('Sheet1'!A1:A3 'sheet1'!A2:C2)"), EvalResult::Number(4.0));
    assert_eq!(eval(&grid, "=SUM('Sheet1'!A1:A3 A2:C2)"), EvalResult::Number(4.0));
}

/// A NESTED intersection resolves sheets the same way a flat one does.
///
/// `reference_rect` carries its own copy of the sheet comparison so that
/// `A1:C3 B1:B9 B2:B2` stays left-associative, and the two copies have to agree
/// — otherwise adding a third operand to a working two-operand formula would
/// change its answer.
#[test]
fn a_nested_intersection_resolves_sheets_like_a_flat_one() {
    let grid = grid_3x3();
    // A1:C3 x B1:B3 = column B; x B2:B2 = B2, which holds 5.
    assert_eq!(eval(&grid, "=SUM(A1:C3 B1:B3 B2:B2)"), EvalResult::Number(5.0));
    // The same chain with the qualifier on each operand in turn.
    assert_eq!(eval(&grid, "=SUM(Sheet1!A1:C3 B1:B3 B2:B2)"), EvalResult::Number(5.0));
    assert_eq!(eval(&grid, "=SUM(A1:C3 Sheet1!B1:B3 B2:B2)"), EvalResult::Number(5.0));
    assert_eq!(eval(&grid, "=SUM(A1:C3 B1:B3 Sheet1!B2:B2)"), EvalResult::Number(5.0));
    // A non-overlapping chain is still #NULL!, so the above is not "nested
    // intersections always succeed".
    assert_eq!(
        eval(&grid, "=SUM(Sheet1!A1:C3 B1:B3 C2:C2)"),
        EvalResult::Error(CellError::Null)
    );
}
