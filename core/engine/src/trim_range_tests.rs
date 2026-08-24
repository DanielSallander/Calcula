//! FILENAME: core/engine/src/trim_range_tests.rs
//! PURPOSE: `TRIMRANGE` and the `.` trim-reference operator — the exceljet
//!          terms "TRIMRANGE function" and "dot operator".
//!
//! WHAT THEY ARE FOR. `=SUM(A:A)` is the spelling a user reaches for when the
//! data will grow, and it is the spelling that then drags every blank row on
//! the sheet into whatever it feeds. TRIMRANGE cuts the blank edges off, so an
//! over-reaching reference computes over exactly the data in it — which is why
//! Excel gave it a one-character spelling (`A1:.A100`) as well as a name.
//!
//! THE DOT IS SUGAR, AND THAT IS ASSERTED, NOT ASSUMED. The parser lowers a
//! dotted range straight to a `TRIMRANGE` call rather than growing trim fields
//! on `Expression::Range`, so the two features are ONE feature with two
//! spellings and cannot drift. `the_dot_operator_is_exactly_the_function`
//! compares the two ASTs directly; every behavioural test below then runs in
//! BOTH spellings, so a fix applied to one and not the other fails here.
//!
//! THE THREE THINGS THAT WOULD BE SILENTLY WRONG:
//!
//!   * trimming the INTERIOR. A blank row with data above and below it is part
//!     of the data's shape; dropping it renumbers every row after it, and the
//!     result still looks like a plausible column of numbers.
//!   * treating `""` as blank. A formula returning the empty string is text,
//!     and it holds its row — `is_blank` is the same distinction the rest of
//!     the engine draws, and getting it wrong here changes a COUNTA.
//!   * trimming an axis the caller asked to keep. The codes are per-axis and
//!     the default is "both"; an implementation that ignored the arguments
//!     would pass every test that only ever uses the default.

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

/// Flattens a result to the values it actually holds, in reading order, so a
/// shape assertion and a content assertion stay separate concerns.
fn flat(v: &EvalResult) -> Vec<EvalResult> {
    match v {
        EvalResult::Array(items) => items.iter().flat_map(|i| flat(i)).collect(),
        other => vec![other.clone()],
    }
}

fn nums(grid: &Grid, formula: &str) -> Vec<f64> {
    flat(&eval(grid, formula))
        .iter()
        .map(|v| match v {
            EvalResult::Number(n) => *n,
            other => panic!("`{}` produced {:?}, expected numbers", formula, other),
        })
        .collect()
}

/// A2:A4 hold 10, 20, 30. A1 and A5:A8 are EMPTY — blank edges on both sides,
/// which is the shape the whole feature exists for.
fn padded_column() -> Grid {
    let mut g = Grid::new();
    g.set_cell(1, 0, Cell::new_number(10.0));
    g.set_cell(2, 0, Cell::new_number(20.0));
    g.set_cell(3, 0, Cell::new_number(30.0));
    // Something far below, in ANOTHER column, so `max_row` extends past the
    // data and the trailing blanks are real rather than an artifact of the
    // used range stopping at A4.
    g.set_cell(7, 3, Cell::new_number(1.0));
    g
}

#[test]
fn a_blank_edge_is_dropped_from_both_ends() {
    let g = padded_column();
    assert_eq!(nums(&g, "=TRIMRANGE(A1:A8)"), vec![10.0, 20.0, 30.0]);
    assert_eq!(nums(&g, "=A1.:.A8"), vec![10.0, 20.0, 30.0]);
}

#[test]
fn the_untrimmed_range_still_carries_its_blanks() {
    // The control. Without this, an implementation that trimmed NOTHING and one
    // that trimmed everything asked would both have to be checked by eye.
    let g = padded_column();
    assert_eq!(flat(&eval(&g, "=A1:A8")).len(), 8);
    assert_eq!(flat(&eval(&g, "=TRIMRANGE(A1:A8)")).len(), 3);
}

#[test]
fn an_interior_blank_survives_because_the_hole_is_part_of_the_shape() {
    let mut g = Grid::new();
    g.set_cell(1, 0, Cell::new_number(10.0));
    // row 2 (A3) deliberately empty
    g.set_cell(3, 0, Cell::new_number(30.0));
    g.set_cell(7, 3, Cell::new_number(1.0));

    let trimmed = eval(&g, "=TRIMRANGE(A1:A8)");
    assert_eq!(flat(&trimmed).len(), 3, "A2:A4 — the hole is kept");
    assert_eq!(
        flat(&trimmed)[1],
        EvalResult::Blank,
        "the interior blank must still be blank, not closed up"
    );
}

#[test]
fn an_empty_string_is_not_a_blank_and_holds_its_row() {
    let mut g = Grid::new();
    g.set_cell(0, 0, Cell::new_text(String::new()));
    g.set_cell(1, 0, Cell::new_number(20.0));
    g.set_cell(7, 3, Cell::new_number(1.0));

    // A1 is text, so nothing is trimmed off the top.
    assert_eq!(flat(&eval(&g, "=TRIMRANGE(A1:A8)")).len(), 2);
    assert_eq!(num(&g, "=COUNTA(TRIMRANGE(A1:A8))"), 2.0);
}

#[test]
fn the_codes_are_per_edge() {
    let g = padded_column();
    // 0 = keep this axis whole, 1 = leading only, 2 = trailing only, 3 = both.
    assert_eq!(flat(&eval(&g, "=TRIMRANGE(A1:A8,0)")).len(), 8, "0 trims nothing");
    assert_eq!(flat(&eval(&g, "=TRIMRANGE(A1:A8,1)")).len(), 7, "leading: A1 goes");
    assert_eq!(flat(&eval(&g, "=TRIMRANGE(A1:A8,2)")).len(), 4, "trailing: A5:A8 go");
    assert_eq!(flat(&eval(&g, "=TRIMRANGE(A1:A8,3)")).len(), 3, "both");
}

#[test]
fn the_two_axes_are_independent() {
    // B2:C3 hold data inside the block A1:D4, so there is one blank row and one
    // blank column to trim at each edge. Trimming rows must not trim columns.
    let mut g = Grid::new();
    for (r, c, v) in [(1, 1, 1.0), (1, 2, 2.0), (2, 1, 3.0), (2, 2, 4.0)] {
        g.set_cell(r, c, Cell::new_number(v));
    }
    g.set_cell(7, 7, Cell::new_number(9.0));

    assert_eq!(flat(&eval(&g, "=TRIMRANGE(A1:D4)")).len(), 4, "2x2");
    assert_eq!(
        flat(&eval(&g, "=TRIMRANGE(A1:D4,3,0)")).len(),
        8,
        "rows trimmed to 2, columns left at 4"
    );
    assert_eq!(
        flat(&eval(&g, "=TRIMRANGE(A1:D4,0,3)")).len(),
        8,
        "columns trimmed to 2, rows left at 4"
    );
}

#[test]
fn the_trimmed_block_keeps_its_rectangle() {
    // Shape, not just count: a 2x2 that flattened to a 4x1 would pass every
    // length assertion above and then transpose silently inside INDEX.
    let mut g = Grid::new();
    for (r, c, v) in [(1, 1, 1.0), (1, 2, 2.0), (2, 1, 3.0), (2, 2, 4.0)] {
        g.set_cell(r, c, Cell::new_number(v));
    }
    g.set_cell(7, 7, Cell::new_number(9.0));

    assert_eq!(num(&g, "=ROWS(TRIMRANGE(A1:D4))"), 2.0);
    assert_eq!(num(&g, "=COLUMNS(TRIMRANGE(A1:D4))"), 2.0);
    assert_eq!(num(&g, "=INDEX(TRIMRANGE(A1:D4),2,1)"), 3.0);
}

#[test]
fn it_makes_an_over_reaching_reference_compute_over_its_data() {
    // The reason the feature exists, stated as the thing a user would write.
    let g = padded_column();
    assert_eq!(num(&g, "=SUM(TRIMRANGE(A:A))"), 60.0);
    assert_eq!(num(&g, "=AVERAGE(TRIMRANGE(A:A))"), 20.0);
    assert_eq!(num(&g, "=ROWS(TRIMRANGE(A:A))"), 3.0);
    assert_eq!(num(&g, "=ROWS(A:A)"), 8.0, "control: untrimmed spans the used range");
}

#[test]
fn an_all_blank_range_answers_a_blank_rather_than_an_error() {
    // Trimming everything leaves a range with no rows, which no array shape can
    // express. A blank keeps `SUM` at 0; an error would make an empty column
    // poison every formula reading it.
    let mut g = Grid::new();
    g.set_cell(7, 7, Cell::new_number(9.0));
    assert_eq!(eval(&g, "=TRIMRANGE(A1:A5)"), EvalResult::Blank);
    assert_eq!(num(&g, "=SUM(TRIMRANGE(A1:A5))"), 0.0);
}

#[test]
fn a_trim_code_outside_zero_to_three_is_a_value_error() {
    let g = padded_column();
    assert_eq!(
        eval(&g, "=TRIMRANGE(A1:A8,4)"),
        EvalResult::Error(CellError::Value)
    );
    assert_eq!(
        eval(&g, "=TRIMRANGE(A1:A8,-1)"),
        EvalResult::Error(CellError::Value)
    );
}

#[test]
fn an_error_in_the_range_survives_the_trim() {
    let mut g = Grid::new();
    let mut err = Cell::new_number(0.0);
    err.value = CellValue::Error(CellError::Div0);
    g.set_cell(1, 0, err);
    g.set_cell(2, 0, Cell::new_number(20.0));
    g.set_cell(7, 3, Cell::new_number(1.0));
    // An error is not blank, so it holds the top edge and reaches the caller.
    assert_eq!(flat(&eval(&g, "=TRIMRANGE(A1:A8)")).len(), 2, "A2:A3");
    assert_eq!(
        eval(&g, "=SUM(TRIMRANGE(A1:A8))"),
        EvalResult::Error(CellError::Div0)
    );
}

// ---------------------------------------------------------------------------
// The dot operator
// ---------------------------------------------------------------------------

#[test]
fn the_dot_operator_is_exactly_the_function() {
    // The load-bearing claim of the whole design: the dot is not a second
    // implementation, it is the same one under a shorter name. Asserted on the
    // AST so it holds even where the two happen to agree numerically.
    let cases = [
        ("=A1.:A8", "=TRIMRANGE(A1:A8,1,1)"),
        ("=A1:.A8", "=TRIMRANGE(A1:A8,2,2)"),
        ("=A1.:.A8", "=TRIMRANGE(A1:A8,3,3)"),
    ];
    for (dotted, spelled) in cases {
        assert_eq!(
            parser::parse(dotted).expect("dotted form parses"),
            parser::parse(spelled).expect("function form parses"),
            "{} should be {}",
            dotted,
            spelled
        );
    }
}

#[test]
fn each_side_of_the_colon_trims_its_own_end() {
    let g = padded_column();
    assert_eq!(flat(&eval(&g, "=A1.:A8")).len(), 7, "dot before: A1 goes");
    assert_eq!(flat(&eval(&g, "=A1:.A8")).len(), 4, "dot after: A5:A8 go");
    assert_eq!(flat(&eval(&g, "=A1.:.A8")).len(), 3, "both dots");
    assert_eq!(flat(&eval(&g, "=A1:A8")).len(), 8, "control: no dots, no trim");
}

#[test]
fn the_dot_works_on_a_whole_column_and_inside_a_function() {
    let g = padded_column();
    assert_eq!(num(&g, "=SUM(A:.A)"), 60.0);
    assert_eq!(num(&g, "=ROWS(A:.A)"), 4.0, "trailing dot only: A1's blank stays");
    assert_eq!(num(&g, "=ROWS(A.:.A)"), 3.0, "both dots on a whole column");
    assert_eq!(num(&g, "=SUM(A1:.A8)"), 60.0);
}

#[test]
fn a_dotted_argument_does_not_trim_the_expression_around_it() {
    // The flags are saved and restored per atom. Without that, the dot inside
    // the first argument would leak outward and trim the second one too — which
    // on this grid would produce the same number, so the test uses shapes.
    let g = padded_column();
    assert_eq!(num(&g, "=ROWS(A1:.A8)+ROWS(A1:A8)"), 4.0 + 8.0);
    assert_eq!(num(&g, "=ROWS(A1:A8)+ROWS(A1:.A8)"), 8.0 + 4.0);
    assert_eq!(num(&g, "=ROWS((A1:.A8))"), 4.0, "parenthesised");
}

#[test]
fn a_dot_that_is_not_an_operator_is_still_what_it_always_was() {
    let g = padded_column();
    // A decimal point: the digit after it is the whole difference.
    assert_eq!(num(&g, "=.5+1"), 1.5);
    assert_eq!(num(&g, "=1.25*4"), 5.0);
    // A dotted defined name keeps its dot, because a letter follows it.
    assert!(
        matches!(
            parser::parse("=Q1.Sales").expect("parses"),
            parser::ast::Expression::NamedRef { ref name, .. } if name == "Q1.SALES"
        ),
        "a dot inside a name must not be lexed as the operator"
    );
    // A dot with nothing to modify is a typo and says so.
    assert!(parser::parse("=A1.").is_err(), "a trailing dot is not a reference");
}

#[test]
fn the_dot_survives_a_sheet_prefix() {
    let g = padded_column();
    // The dots are attached to the colon, not to the reference's spelling, so
    // the qualified form must behave identically.
    assert_eq!(
        parser::parse("=Sheet1!A1:.A8").expect("parses"),
        parser::parse("=TRIMRANGE(Sheet1!A1:A8,2,2)").expect("parses")
    );
    assert_eq!(num(&g, "=ROWS($A$1:.$A$8)"), 4.0, "absolute markers too");
}

#[test]
fn the_dot_form_round_trips_through_the_renderer() {
    // The parser lowers the dot to a function call, so without the renderer's
    // matching collapse a user who typed `=A1:.A8` would find
    // `=TRIMRANGE(A1:A8,2,2)` in the formula bar the next time they opened the
    // cell -- a formula that rewrites itself on being looked at.
    for source in ["A1.:A8", "A1:.A8", "A1.:.A8", "A:.A", "SUM(A1:.A8)+1"] {
        let rendered = crate::ast_render::render_formula(
            &parser::parse(&format!("={}", source)).expect("parses"),
        );
        assert_eq!(rendered, source, "`{}` must render back as itself", source);
    }
}

#[test]
fn the_dots_land_on_the_reference_colon_of_a_3d_reference() {
    // `Sheet1:Sheet3!A1:A8` has TWO colons and the dots belong to the second.
    // Splicing onto the first would produce `Sheet1.:.Sheet3!A1:A8`, which is
    // not the same formula and does not parse back.
    // The sheet names come back uppercase because the lexer uppercases bare
    // identifiers -- long-standing behaviour, and not what this test is about.
    let ast = parser::parse("=Sheet1:Sheet3!A1:.A8").expect("parses");
    let rendered = crate::ast_render::render_formula(&ast);
    assert_eq!(rendered, "SHEET1:SHEET3!A1:.A8");
    assert_eq!(parser::parse(&format!("={}", rendered)).expect("re-parses"), ast);
}

#[test]
fn the_function_form_still_renders_as_a_function_when_it_is_not_a_dot() {
    // Only the parser's own shape -- three arguments, equal codes in 1..=3 --
    // collapses. Everything else has to stay legible as a call, or a formula
    // that cannot be written with dots would render as something that lies.
    for source in [
        "TRIMRANGE(A1:A8)",
        "TRIMRANGE(A1:A8,3)",
        "TRIMRANGE(A1:A8,0,0)",
        "TRIMRANGE(A1:A8,1,2)",
        "TRIMRANGE(SORT(A1:A8),3,3)",
    ] {
        let rendered = crate::ast_render::render_formula(
            &parser::parse(&format!("={}", source)).expect("parses"),
        );
        assert_eq!(rendered, source, "`{}` must stay a call", source);
    }
}

#[test]
fn the_dot_needs_no_locale_rule() {
    // The `.` is not a separator in any locale Calcula translates, so a Swedish
    // user types the same characters an invariant one does. Pinned because the
    // translation layer DOES rewrite `.` between digits, and a rule that
    // reached one character further would eat the operator.
    use crate::formula_locale::{delocalize_formula, localize_formula};
    use crate::locale::LocaleSettings;
    let sv = LocaleSettings::from_locale_id("sv-SE");
    assert_eq!(delocalize_formula("=A1:.A8", &sv), "=A1:.A8");
    assert_eq!(localize_formula("=A1:.A8", &sv), "=A1:.A8");
    assert_eq!(delocalize_formula("=SUM(A1:.A8;1,5)", &sv), "=SUM(A1:.A8,1.5)");
    assert_eq!(localize_formula("=SUM(A1:.A8,1.5)", &sv), "=SUM(A1:.A8;1,5)");
}
