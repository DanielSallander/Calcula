//! FILENAME: core/engine/src/whole_axis_tests.rs
//! PURPOSE: Whole-axis references (`A:A`, `A:D`, `1:1`, `1:5`) are ROW- AND
//!          COLUMN-INDEXED — the exceljet terms "full column reference",
//!          "full row reference" and "BigNum".
//!
//! WHAT WAS ACTUALLY WRONG. `eval_column_ref` and `eval_row_ref` returned only
//! the POPULATED cells, so the array was shorter than the axis and element `i`
//! had nothing to do with row (or column) `i`. That is invisible to an aggregate
//! — `SUM` skips blanks either way — and wrong for everything that pairs two
//! references by ordinal. The failures were PLAUSIBLE WRONG NUMBERS, appearing
//! only on gapped data, with no error on the cell:
//!
//!   =SUMIF(B:B,"x",C:C)                    summed the wrong rows of C
//!   =MATCH(30,C:C,0)                       the ordinal among populated cells, not the row
//!   =TEXTJOIN(",",FALSE,A:A)               dropped the blanks A1:A3 keeps
//!   =INDEX(1:1,1,3)                        the first populated cell, not C1
//!   =MATCH(9.99999999999999E+307,A1:A100)  100 (the last EMPTY row), not 10
//!   =LOOKUP(9.99999999999999E+307,A1:A100) 0  (a blank collapsed), not 10
//!
//! THE FIX IS THE USED RANGE. Both axes now materialise densely over
//! `grid.max_row` / `grid.max_col` — the sheet's own bounding box, not
//! 1,048,576 — which is what makes it affordable AND what makes two columns
//! align: the bound has to be shared, or each column would end at its own last
//! row and they would misalign again. Plus Excel's rule that a BLANK IS NOT A
//! LOOKUP CANDIDATE, without which trailing empties still won every approximate
//! search (`as_number()` answers `Some(0.0)` for a blank, by design).
//!
//! EVERY MISALIGNMENT CASE IS PAIRED WITH A RECTANGULAR CONTROL. The bug was
//! that `A:A` and `A1:A3` disagreed about the same data, so asserting the
//! whole-axis answer alone would not have caught it — and a "fix" that made both
//! spellings equally wrong would satisfy half these tests.

use crate::cell::{Cell, CellError};
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

fn text(grid: &Grid, formula: &str) -> String {
    match eval(grid, formula) {
        EvalResult::Text(s) => s,
        other => panic!("`{}` gave {:?}, expected text", formula, other),
    }
}

/// B1="x", B2 EMPTY, B3="x"; C1:C3 = 10,20,30. The hole in B is the whole point.
fn gapped_pair() -> Grid {
    let mut g = Grid::new();
    g.set_cell(0, 1, Cell::new_text("x".to_string()));
    g.set_cell(2, 1, Cell::new_text("x".to_string()));
    g.set_cell(0, 2, Cell::new_number(10.0));
    g.set_cell(1, 2, Cell::new_number(20.0));
    g.set_cell(2, 2, Cell::new_number(30.0));
    g
}

/// Row 1 = 10, EMPTY, 20; row 2 = 1, 2, 3.
fn gapped_row() -> Grid {
    let mut g = Grid::new();
    g.set_cell(0, 0, Cell::new_number(10.0));
    g.set_cell(0, 2, Cell::new_number(20.0));
    g.set_cell(1, 0, Cell::new_number(1.0));
    g.set_cell(1, 1, Cell::new_number(2.0));
    g.set_cell(1, 2, Cell::new_number(3.0));
    g
}

// ===================================================================
// Paired vectors: the silent wrong numbers
// ===================================================================

#[test]
fn the_criteria_family_pairs_whole_columns_by_row() {
    let g = gapped_pair();
    // B2 is empty, so the compacted vectors were B=[x,x] against C=[10,20,30]:
    // "x" at index 1 picked up C2 instead of C3 and the answer was 30.
    for f in [
        "=SUMIF(B:B,\"x\",C:C)",
        "=SUMIFS(C:C,B:B,\"x\")",
        // The RECTANGULAR CONTROL over the same cells. These always agreed with
        // Excel; the whole-column spellings had to be made to agree with them.
        "=SUMIF(B1:B3,\"x\",C1:C3)",
        "=SUMIFS(C1:C3,B1:B3,\"x\")",
    ] {
        assert_eq!(num(&g, f), 40.0, "`{}` must sum C1 and C3", f);
    }
    assert_eq!(num(&g, "=COUNTIFS(B:B,\"x\")"), 2.0);
    assert_eq!(num(&g, "=AVERAGEIFS(C:C,B:B,\"x\")"), 20.0);
    assert_eq!(num(&g, "=MAXIFS(C:C,B:B,\"x\")"), 30.0);
    assert_eq!(num(&g, "=MINIFS(C:C,B:B,\"x\")"), 10.0);
}

#[test]
fn match_over_a_whole_column_answers_a_row_not_an_ordinal() {
    let g = gapped_pair();
    // C is dense, B has the hole; MATCH on B is where the ordinal showed.
    assert_eq!(num(&g, "=MATCH(30,C:C,0)"), 3.0);
    assert_eq!(num(&g, "=MATCH(30,C1:C3,0)"), 3.0, "rectangular control");
    // INDEX must address the same row the MATCH named.
    assert_eq!(num(&g, "=INDEX(C:C,MATCH(30,C:C,0))"), 30.0);
    // And the gapped column: "x" is at rows 1 and 3, never at 2.
    assert_eq!(num(&g, "=MATCH(\"x\",B:B,0)"), 1.0);
    assert_eq!(text(&g, "=INDEX(B:B,3)"), "x");
    assert!(
        matches!(eval(&g, "=INDEX(B:B,2)"), EvalResult::Blank | EvalResult::Number(_)),
        "row 2 of B is the hole; it must be reachable, not skipped over"
    );
}

#[test]
fn a_whole_column_is_bounded_by_the_used_range_not_the_sheet() {
    let g = gapped_pair();
    // The used range ends at row 3, so `C:C` is three cells — NOT 1,048,576,
    // which is the objection the old compaction existed to avoid.
    assert_eq!(num(&g, "=ROWS(C:C)"), 3.0);
    assert_eq!(num(&g, "=COUNTA(B:B)"), 2.0, "COUNTA still ignores the blank");
    assert_eq!(num(&g, "=COUNT(C:C)"), 3.0);
    assert_eq!(num(&g, "=SUM(C:C)"), 60.0);
}

#[test]
fn aggregates_are_unchanged_by_the_row_indexing() {
    // THE CONTROL FOR THE WHOLE CHANGE. Making the axis dense must not turn a
    // hole into a zero for anything that counts or averages, or `SUM(A:A)` and
    // `AVERAGE(A:A)` would quietly change meaning on every gapped column in
    // every existing workbook.
    let g = gapped_pair();
    assert_eq!(num(&g, "=AVERAGE(C:C)"), 20.0);
    assert_eq!(num(&g, "=COUNTA(B:B)"), 2.0);
    assert_eq!(num(&g, "=COUNTBLANK(B1:B3)"), 1.0);
    // A column with a numeric hole: AVERAGE must divide by 2, not by 3.
    let mut h = Grid::new();
    h.set_cell(0, 0, Cell::new_number(10.0));
    h.set_cell(2, 0, Cell::new_number(20.0));
    assert_eq!(num(&h, "=AVERAGE(A:A)"), 15.0);
    assert_eq!(num(&h, "=COUNT(A:A)"), 2.0);
    assert_eq!(num(&h, "=SUM(A:A)"), 30.0);
}

// ===================================================================
// Whole ROW references
// ===================================================================

#[test]
fn a_whole_row_reference_keeps_its_orientation() {
    let g = gapped_row();
    // THE DEFECT THIS PINS was not about blanks at all: `get_range_dimensions`
    // had no RowRef arm and answered (1,1), so `fn_index` took the
    // single-column branch and discarded the column argument entirely. It was
    // wrong even on a fully dense row.
    assert_eq!(num(&g, "=INDEX(1:1,1,3)"), 20.0);
    assert_eq!(num(&g, "=INDEX(2:2,1,2)"), 2.0);
    assert_eq!(num(&g, "=INDEX(A1:C1,1,3)"), 20.0, "rectangular control");
}

#[test]
fn two_whole_rows_pair_by_column() {
    let g = gapped_row();
    // B1 is empty, so the compacted vectors were row1=[10,20] against
    // row2=[1,2,3]: ">5" matched at indexes 0 and 1 and summed 1+2 = 3.
    assert_eq!(num(&g, "=SUMIF(1:1,\">5\",2:2)"), 4.0);
    assert_eq!(
        num(&g, "=SUMIF(A1:C1,\">5\",A2:C2)"),
        4.0,
        "the rectangular spelling of the same data, which was always right"
    );
    assert_eq!(num(&g, "=SUM(1:1)"), 30.0);
    assert_eq!(num(&g, "=COUNT(1:1)"), 2.0);
}

// ===================================================================
// BigNum
// ===================================================================

/// A1:A10 = 1..10, then nothing until row 100 — the shape the BigNum idiom is
/// used on. The far cell is in another COLUMN so column A's own data stops at
/// row 10 while the sheet's used range reaches row 100.
fn bignum_grid() -> Grid {
    let mut g = Grid::new();
    for i in 0..10u32 {
        g.set_cell(i, 0, Cell::new_number((i + 1) as f64));
    }
    g.set_cell(99, 5, Cell::new_number(0.0));
    g
}

const BIGNUM: &str = "9.99999999999999E+307";

#[test]
fn bignum_finds_the_last_numeric_value_not_the_last_row() {
    let g = bignum_grid();
    // The idiom's whole purpose. Every trailing blank used to compare as
    // `0 <= BigNum`, so the LAST EMPTY row won: MATCH answered 100 and the
    // value-returning lookups answered 0 — a plausible number, not an error.
    assert_eq!(num(&g, &format!("=MATCH({},A1:A100)", BIGNUM)), 10.0);
    assert_eq!(
        num(&g, &format!("=INDEX(A1:A100,MATCH({},A1:A100))", BIGNUM)),
        10.0
    );
    assert_eq!(num(&g, &format!("=LOOKUP({},A1:A100)", BIGNUM)), 10.0);
    assert_eq!(num(&g, &format!("=VLOOKUP({},A1:A100,1)", BIGNUM)), 10.0);
    // The whole-column spelling now agrees, which it could not before: it used
    // to answer the COUNT of populated cells rather than a row number.
    assert_eq!(num(&g, &format!("=MATCH({},A:A)", BIGNUM)), 10.0);
}

#[test]
fn the_classic_bignum_substitute_works_too() {
    // `=LOOKUP(2,1/(range<>""),range)` needs comparison operators to lift over a
    // range. They did not, so `(A1:A100<>"")` collapsed to a single FALSE and
    // the idiom answered A1. It works now because the operators lift.
    let g = bignum_grid();
    assert_eq!(num(&g, "=LOOKUP(2,1/(A1:A100<>\"\"),A1:A100)"), 10.0);
}

#[test]
fn a_blank_is_still_not_a_wall_for_a_lookup() {
    // The blank skip must SKIP, not stop: data below a gap has to stay
    // reachable, or the fix would trade one wrong answer for another.
    let mut g = Grid::new();
    g.set_cell(0, 0, Cell::new_number(1.0));
    g.set_cell(4, 0, Cell::new_number(5.0)); // A5, with A2:A4 empty
    assert_eq!(num(&g, &format!("=LOOKUP({},A1:A5)", BIGNUM)), 5.0);
    assert_eq!(num(&g, &format!("=MATCH({},A1:A5)", BIGNUM)), 5.0);
}

// ===================================================================
// Error literals
// ===================================================================

#[test]
fn an_error_literal_evaluates_to_that_error() {
    let g = Grid::new();
    assert_eq!(eval(&g, "=#REF!"), EvalResult::Error(CellError::Ref));
    assert_eq!(eval(&g, "=#N/A"), EvalResult::Error(CellError::NA));
    assert_eq!(eval(&g, "=#DIV/0!"), EvalResult::Error(CellError::Div0));
    // It behaves as an error everywhere, not merely as a value that prints like
    // one: it propagates, and the IS* predicates see it.
    assert_eq!(eval(&g, "=#REF!+1"), EvalResult::Error(CellError::Ref));
    assert_eq!(eval(&g, "=ISNA(#N/A)"), EvalResult::Boolean(true));
    assert_eq!(eval(&g, "=ISERROR(#REF!)"), EvalResult::Boolean(true));
    assert_eq!(eval(&g, "=IFERROR(#REF!,\"caught\")"), EvalResult::Text("caught".into()));
    // And it survives a render -> re-parse round trip, which is what makes it
    // safe for the shifters to WRITE.
    let ast = parser::parse("=#REF!+1").expect("parses");
    assert_eq!(crate::ast_render::render_formula_raw(&ast), "#REF!+1");
}

#[test]
fn error_literals_match_the_lexers_table() {
    // TWO TABLES, ONE TRUTH. `CellError::as_literal` lives here and the lexer's
    // `ERROR_LITERALS` lives in the parser crate, which cannot depend on this
    // one (the dependency runs the other way), so the spellings are written
    // twice. A literal the lexer accepts but `from_literal` does not recognise
    // silently becomes `#VALUE!` — the wrong error, with nothing to say so.
    for lit in parser::lexer::ERROR_LITERALS {
        let parsed = CellError::from_literal(lit);
        assert_eq!(
            parsed.as_literal(),
            lit,
            "the lexer accepts `{}` but the engine maps it to `{}`",
            lit,
            parsed.as_literal()
        );
    }
    // ...and in the other direction: every error the engine can PRODUCE must be
    // writable, or a formula holding one could not round-trip through text.
    for err in [
        CellError::Div0, CellError::Ref, CellError::Name, CellError::Value,
        CellError::NA, CellError::Null, CellError::Num, CellError::Spill,
        CellError::Circular, CellError::Conflict, CellError::Blocked, CellError::Limit,
    ] {
        assert!(
            parser::lexer::ERROR_LITERALS.contains(&err.as_literal()),
            "`{}` can be produced but not written",
            err.as_literal()
        );
    }
}

#[test]
fn a_literal_past_the_numeric_ceiling_is_num_not_infinity() {
    let g = Grid::new();
    // `finite_or_num` gated arithmetic RESULTS only, so `=1.8E308+0` was #NUM!
    // while the bare literal sailed past as an infinity: `=ISNUMBER(1.8E308)`
    // answered TRUE and `=1.8E308&""` rendered the text "inf".
    assert_eq!(eval(&g, "=1.8E308"), EvalResult::Error(CellError::Num));
    assert_eq!(eval(&g, "=1E309"), EvalResult::Error(CellError::Num));
    assert_eq!(eval(&g, "=ISNUMBER(1.8E308)"), EvalResult::Boolean(false));
    // BigNum itself is finite and must still be an ordinary number.
    assert!(matches!(eval(&g, BIGNUM), EvalResult::Number(_)));
    assert_eq!(eval(&g, "=1.7E308+0"), EvalResult::Number(1.7e308));
}

// ===================================================================
// OWNER DECISION, 2026-08-24 — A DELIBERATE DIVERGENCE FROM EXCEL.
// ===================================================================

/// `=ROWS(A:A)` ANSWERS THE USED-RANGE HEIGHT, NOT EXCEL'S 1,048,576, AND THAT
/// IS CORRECT FOR CALCULA. Owner decision, 2026-08-24. Do not "fix" it.
///
/// EXCEL'S ANSWER IS 1,048,576 — the sheet's full height — regardless of what is
/// in the column. Calcula answers the height of the sheet's used range (3 for
/// the fixture below). This test exists because that difference looks exactly
/// like a bug, and the next person to compare Calcula against Excel will find it
/// and be tempted.
///
/// THE REASON IS PERFORMANCE, and it is structural rather than a micro-
/// optimization. A whole-axis reference in this engine MATERIALIZES densely over
/// `grid.max_row` / `grid.max_col` — see `eval_column_ref` — because that is
/// what makes element `i` mean "row `i`" and lets two columns align (the defect
/// this whole file was written for). The used range is what makes that
/// affordable: a column of 200 rows costs 200 cells. Reporting 1,048,576 from
/// `ROWS` while materializing 200 would be worse than either choice on its own —
/// the two numbers describing the same reference would disagree, so
/// `INDEX(A:A, ROWS(A:A))` would address a row that was never built. Making
/// `ROWS` honest about the sheet height would instead require materializing the
/// sheet height, which is the million-row allocation the used-range bound exists
/// to avoid.
///
/// SO THE DIVERGENCE IS THE PRICE OF THE ALIGNMENT FIX, not an oversight, and it
/// is CONSISTENT: every whole-axis function reports the same bound.
///
/// TWO EXISTING TESTS ALREADY DEFEND THIS BOUND from the other direction, and
/// are cross-referenced rather than duplicated here:
///
///   * `a_whole_column_is_bounded_by_the_used_range_not_the_sheet` (this file)
///     asserts `=ROWS(C:C)` is 3 and that the AGGREGATES agree with it.
///   * `test_column_ref_single_column_row_order_preserved_c3a`
///     (`evaluator.rs`, in `mod tests`) asserts that `A:A` materializes exactly
///     `max_row` elements, holes included — the mechanism this divergence is
///     the consequence of.
///
/// What THIS test adds is the statement of INTENT: the number is a decision, the
/// decision has a date and a reason, and COLUMNS and COUNTBLANK are pinned to
/// the same rule so nobody converts one of the three and leaves the others.
#[test]
fn whole_axis_dimensions_report_the_used_range_by_owner_decision_2026_08_24() {
    // A 3x3 block: the used range is rows 1..3 and columns A..C.
    let mut g = Grid::new();
    for r in 0..3u32 {
        for c in 0..3u32 {
            g.set_cell(r, c, Cell::new_number((r * 3 + c + 1) as f64));
        }
    }

    // ROWS over a whole column: 3, the used-range HEIGHT. Excel says 1,048,576.
    assert_eq!(
        num(&g, "=ROWS(A:A)"),
        3.0,
        "OWNER DECISION 2026-08-24: the used-range height, not Excel's 1,048,576"
    );
    // COLUMNS over a whole row: 3, the used-range WIDTH. Excel says 16,384.
    assert_eq!(
        num(&g, "=COLUMNS(1:1)"),
        3.0,
        "OWNER DECISION 2026-08-24: the used-range width, not Excel's 16,384"
    );
    // COUNTBLANK agrees with them: it counts blanks WITHIN the same bound, so a
    // fully populated used range has none. Excel counts the sheet's remaining
    // 1,048,573 empty rows and answers 1,048,573.
    assert_eq!(
        num(&g, "=COUNTBLANK(A:A)"),
        0.0,
        "OWNER DECISION 2026-08-24: blanks within the used range, not the sheet"
    );

    // THE THREE MUST AGREE WITH EACH OTHER, which is the property that actually
    // has to hold. Asserting each against a literal would still pass if someone
    // converted ROWS to Excel's answer and left COLUMNS alone.
    assert_eq!(
        num(&g, "=ROWS(A:A)"),
        num(&g, "=ROWS(A:C)"),
        "every column shares the SHEET's used range, not its own last row"
    );
    assert_eq!(num(&g, "=COLUMNS(1:1)"), num(&g, "=COLUMNS(1:3)"));

    // AND THE BOUND MOVES WITH THE DATA. A used range that grows changes all
    // three answers — the assertions above are not passing because the engine
    // returns a constant 3, and a switch to Excel's fixed 1,048,576 would make
    // this pair identical and fail.
    let mut tall = g.clone();
    tall.set_cell(9, 0, Cell::new_number(99.0)); // A10, extending the used range
    assert_eq!(num(&tall, "=ROWS(A:A)"), 10.0);
    assert_eq!(
        num(&tall, "=COUNTBLANK(A:A)"),
        6.0,
        "A4:A9 are the blanks inside the grown used range"
    );

    // CONSISTENCY WITH WHAT IS ACTUALLY MATERIALIZED — the reason the divergence
    // exists at all. ROWS must report the count the reference really produces,
    // or INDEX would address a row that was never built.
    assert_eq!(
        num(&tall, "=COUNTA(A:A)") + num(&tall, "=COUNTBLANK(A:A)"),
        num(&tall, "=ROWS(A:A)"),
        "ROWS must equal what the whole-column reference materializes"
    );
    assert_eq!(
        num(&tall, "=INDEX(A:A,ROWS(A:A))"),
        99.0,
        "the last row ROWS names must be reachable"
    );
}
