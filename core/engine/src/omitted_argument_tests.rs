//! FILENAME: core/engine/src/omitted_argument_tests.rs
//! PURPOSE: Excel's OMITTED ARGUMENT — the nothing between the two commas of
//!          `=IF(TRUE,,5)`, `=XLOOKUP(x,a,b,,2)` and `=VLOOKUP(x,t,2,)`.
//!
//! WHAT IT IS. Excel does not treat `,,` as a missing argument. It treats it as
//! an argument whose value is EMPTY: `0` in arithmetic, `""` in concatenation,
//! `FALSE` as a condition, and outside the population entirely for the counting
//! functions. That is the same three-way rule `EvalResult::Blank` already
//! carries for an empty CELL, which is why the parser lowers an omitted
//! argument to `Value::Blank` rather than inventing a second kind of empty.
//!
//! THE THREE THINGS THAT WOULD BE SILENTLY WRONG:
//!
//!   * THE ARITY. `=VLOOKUP(x,t,2,)` has FOUR arguments and the fourth is
//!     empty, which means EXACT match. A grammar that skipped the empty slot
//!     would hand the evaluator the THREE-argument call, which means
//!     APPROXIMATE match — over unsorted data that is a neighbouring row's
//!     value: a plausible number from the wrong record, with no error to show
//!     for it. Every test here that uses a trailing `,` asserts the count.
//!
//!   * THE COERCION. `Blank` in a boolean flag is FALSE. Two hand-rolled
//!     coercions in the lookup family ended `_ => true`, so the empty slot read
//!     as TRUE and did the opposite of what the user asked for. `as_boolean`
//!     had said `Blank => false` all along; the tests below pin the pair
//!     against each other rather than against one another's spelling.
//!
//!   * THE RENDER. This renderer's output is what `.cala` STORES and re-parses
//!     on load. An omitted argument that rendered as anything at all — `0`,
//!     `""` — would come back as a DIFFERENT formula after a save/reload, and
//!     `=VLOOKUP(x,t,2,"")` is `#VALUE!` where `=VLOOKUP(x,t,2,)` is a lookup.

use crate::ast_render::render_formula_raw;
use crate::cell::{Cell, CellError, CellValue};
use crate::evaluator::{EvalResult, Evaluator};
use crate::grid::Grid;
use parser::ast::{Expression, Value};

fn eval(grid: &Grid, formula: &str) -> EvalResult {
    let ast = parser::parse(formula).unwrap_or_else(|e| panic!("`{}` does not parse: {}", formula, e));
    Evaluator::new(grid).evaluate(&ast)
}

fn num(grid: &Grid, formula: &str) -> f64 {
    match eval(grid, formula) {
        EvalResult::Number(n) => n,
        other => panic!("`{}` gave {:?}, expected a number", formula, other),
    }
}

/// How many arguments the evaluator will actually see.
fn argc(formula: &str) -> usize {
    match parser::parse(formula).unwrap_or_else(|e| panic!("`{}` does not parse: {}", formula, e)) {
        Expression::FunctionCall { args, .. } => args.len(),
        other => panic!("`{}` is not a call: {:?}", formula, other),
    }
}

/// A1:A3 hold 10, 20, 30 and B1:B3 hold 1, 2, 3 — a two-column lookup table
/// whose first column is sorted, so approximate and exact match give DIFFERENT
/// answers for a value that is not present.
fn lookup_table() -> Grid {
    let mut g = Grid::new();
    for (r, v) in [(0u32, 10.0), (1, 20.0), (2, 30.0)] {
        g.set_cell(r, 0, Cell::new_number(v));
    }
    for (r, v) in [(0u32, 1.0), (1, 2.0), (2, 3.0)] {
        g.set_cell(r, 1, Cell::new_number(v));
    }
    g
}

// ---------------------------------------------------------------------------
// THE ARITY
// ---------------------------------------------------------------------------

/// THE COUNT OF ARGUMENTS MUST NOT CHANGE.
///
/// This is the whole trap of the feature. Every arity check in the evaluator —
/// and there is one at the top of nearly every `fn_*` — reads `args.len()`, and
/// several functions change BEHAVIOUR on it rather than merely validating.
/// Filling the slot with a value is what keeps the user's formula and the
/// evaluator's view of it the same call.
#[test]
fn an_omitted_argument_still_occupies_its_slot() {
    for (formula, expected) in [
        ("=IF(TRUE,,5)", 3),
        ("=IF(,1,2)", 3),
        ("=IF(TRUE,,)", 3),
        ("=VLOOKUP(1,A1:B3,2,)", 4),
        ("=XLOOKUP(1,A1:A3,B1:B3,,2)", 5),
        ("=SUM(1,,2)", 3),
        ("=SUM(,)", 2),
    ] {
        assert_eq!(argc(formula), expected, "{} has the wrong arity", formula);
    }
    // CONTROL: the genuinely EMPTY list is still zero arguments, not one blank.
    // There is no Excel text for a single omitted argument, and inventing one
    // here would turn `=SUM()` into a one-argument call.
    assert_eq!(argc("=SUM()"), 0, "=SUM() gained an argument");
}

/// The slot holds the EMPTY value, not the empty string and not zero.
///
/// Named on the AST because the three are indistinguishable once evaluated in
/// arithmetic — all of them are 0 — and only differ where it matters:
/// `=SUM(1,"",2)` and `=SUM(1,,2)` are both 3, but `=VLOOKUP(x,t,2,"")` is
/// `#VALUE!` while `=VLOOKUP(x,t,2,)` is a lookup.
#[test]
fn the_slot_holds_blank_and_not_an_empty_string() {
    match parser::parse("=IF(TRUE,,5)").expect("parses") {
        Expression::FunctionCall { args, .. } => {
            assert_eq!(args[1], Expression::Literal(Value::Blank));
            assert_ne!(args[1], Expression::Literal(Value::String(String::new())));
            assert_ne!(args[1], Expression::Literal(Value::Number(0.0)));
        }
        other => panic!("not a call: {:?}", other),
    }
}

// ---------------------------------------------------------------------------
// THE VALUE
// ---------------------------------------------------------------------------

/// Excel's three-way reading of an empty value, one case each.
///
/// The three arms cannot be satisfied by any single stand-in, which is the
/// point: `0` would break the concatenation, `""` would break the arithmetic,
/// and either would break AVERAGE's denominator.
#[test]
fn an_omitted_argument_reads_as_excels_empty_value() {
    let g = Grid::new();
    // 0 in arithmetic.
    assert_eq!(num(&g, "=SUM(1,,2)"), 3.0);
    // "" in concatenation — and NOT the text "0".
    assert_eq!(eval(&g, "=CONCAT(\"a\",,\"b\")"), EvalResult::Text("ab".to_string()));
    // Out of the population for the counting family: the denominator is 2, so
    // the mean of 1 and 3 is 2. A stand-in value of 0 would answer 1.333.
    assert_eq!(num(&g, "=AVERAGE(1,,3)"), 2.0);
    assert_eq!(num(&g, "=COUNT(1,,2)"), 2.0);
    // FALSE as a condition.
    assert_eq!(num(&g, "=IF(,1,2)"), 2.0);
    // ...and it is the EMPTY VALUE, not the empty string. Everything above is
    // satisfied by `""` as well (text is ignored by SUM, AVERAGE and COUNT
    // alike), so without this line the test would pass on an evaluator that had
    // quietly substituted text. TYPE is where the two part company: 1 is
    // number, 2 is text.
    assert_eq!(num(&g, "=TYPE(IF(TRUE,,5))"), 1.0);
}

/// `=IF(TRUE,,5)` is 0 in a cell — Excel's answer, and the reason `Blank`
/// collapses on storage rather than leaving a formula cell that LOOKS empty.
#[test]
fn an_omitted_branch_displays_as_zero() {
    let g = Grid::new();
    assert_eq!(eval(&g, "=IF(TRUE,,5)").to_cell_value(), CellValue::Number(0.0));
    // CONTROL: the other branch is untouched, so a fix that made everything
    // blank could not satisfy this test.
    assert_eq!(num(&g, "=IF(FALSE,,5)"), 5.0);
}

// ---------------------------------------------------------------------------
// THE COERCION — the wrong-answer half
// ---------------------------------------------------------------------------

/// AN EMPTY 4th ARGUMENT TO VLOOKUP IS EXACT MATCH.
///
/// `=VLOOKUP(x,t,2,)` is the shorthand half the spreadsheet world types for
/// "exact match". The coercion read the empty slot as TRUE, so the lookup
/// silently went APPROXIMATE and returned the row BELOW the search value — a
/// real number from the wrong record where Excel answers `#N/A`.
///
/// 15 is not in the table on purpose: it is the only kind of input that tells
/// the two match modes apart. The two controls are what make the assertion
/// mean something — the approximate form must still find row 1, and the
/// explicit FALSE must still be `#N/A`, so a change that made every lookup
/// fail cannot pass this test.
#[test]
fn an_empty_range_lookup_is_exact_match() {
    let g = lookup_table();
    assert_eq!(eval(&g, "=VLOOKUP(15,A1:B3,2,)"), EvalResult::Error(CellError::NA));
    assert_eq!(eval(&g, "=VLOOKUP(15,A1:B3,2,FALSE)"), EvalResult::Error(CellError::NA));
    // CONTROLS: approximate match, both spellings of it, still answers 1.
    assert_eq!(num(&g, "=VLOOKUP(15,A1:B3,2)"), 1.0);
    assert_eq!(num(&g, "=VLOOKUP(15,A1:B3,2,TRUE)"), 1.0);
}

/// HLOOKUP must agree with VLOOKUP about the same empty slot. The two carry
/// separate copies of the coercion, so one could be fixed and the other not —
/// which would mean `=HLOOKUP(x,t,2,)` and `=VLOOKUP(x,t,2,)` disagreeing about
/// what the user asked for.
#[test]
fn hlookup_reads_the_empty_slot_the_same_way() {
    let mut g = Grid::new();
    // Row 1: 10, 20, 30 (sorted). Row 2: 1, 2, 3.
    for (c, v) in [(0u32, 10.0), (1, 20.0), (2, 30.0)] {
        g.set_cell(0, c, Cell::new_number(v));
    }
    for (c, v) in [(0u32, 1.0), (1, 2.0), (2, 3.0)] {
        g.set_cell(1, c, Cell::new_number(v));
    }
    assert_eq!(eval(&g, "=HLOOKUP(15,A1:C2,2,)"), EvalResult::Error(CellError::NA));
    assert_eq!(num(&g, "=HLOOKUP(15,A1:C2,2)"), 1.0);
}

/// TEXTJOIN's empty `ignore_empty` is FALSE — KEEP the empties.
///
/// The coercion defaulted it to TRUE, which drops them: the joined text came
/// back with fewer fields than the range had rows, and every position after the
/// first gap was shifted. A caller splitting the result back apart reads the
/// wrong column from then on.
#[test]
fn an_empty_ignore_empty_keeps_the_gaps() {
    let mut g = Grid::new();
    g.set_cell(0, 0, Cell::new_number(1.0));
    // A2 left empty on purpose — it is the gap under test.
    g.set_cell(2, 0, Cell::new_number(3.0));
    assert_eq!(
        eval(&g, "=TEXTJOIN(\",\",,A1:A3)"),
        EvalResult::Text("1,,3".to_string()),
        "the omitted flag dropped the gap"
    );
    // CONTROL: an explicit TRUE still drops it, so this is not a test that
    // simply stopped ignoring empties altogether.
    assert_eq!(
        eval(&g, "=TEXTJOIN(\",\",TRUE,A1:A3)"),
        EvalResult::Text("1,3".to_string())
    );
}

/// XLOOKUP's empty `if_not_found` is a supplied value (empty), not the absent
/// argument — so a miss is 0 rather than `#N/A`. The two differ only when the
/// lookup fails, which is exactly when a user reaches for the argument.
#[test]
fn an_empty_if_not_found_is_supplied_not_absent() {
    let g = lookup_table();
    assert_eq!(eval(&g, "=XLOOKUP(99,A1:A3,B1:B3,)"), EvalResult::Blank);
    assert_eq!(eval(&g, "=XLOOKUP(99,A1:A3,B1:B3)"), EvalResult::Error(CellError::NA));
    // CONTROL: a HIT is unaffected by which spelling was used.
    assert_eq!(num(&g, "=XLOOKUP(20,A1:A3,B1:B3,,0)"), 2.0);
}

// ---------------------------------------------------------------------------
// THE RENDER
// ---------------------------------------------------------------------------

/// `=IF(TRUE,,5)` MUST NOT COME BACK AS `=IF(TRUE,5)`.
///
/// The renderer's output is the formula bar AND what `.cala` stores, so a lost
/// comma is a workbook that computes a different number after a reload, with no
/// error at any point. Round-tripped through the parser rather than merely
/// string-compared, so the assertion is about MEANING and not spelling.
#[test]
fn an_omitted_argument_survives_render_and_re_parse() {
    for source in [
        "IF(TRUE,,5)",
        "IF(,1,2)",
        "VLOOKUP(1,A1:B3,2,)",
        "XLOOKUP(1,A1:A3,B1:B3,,2)",
        "SUM(1,,2)",
        "IF(TRUE,,)",
    ] {
        let ast = parser::parse(source).unwrap_or_else(|e| panic!("{} does not parse: {}", source, e));
        let rendered = render_formula_raw(&ast);
        assert_eq!(rendered, source, "{} did not render back to itself", source);
        let reparsed = parser::parse(&rendered)
            .unwrap_or_else(|e| panic!("{} rendered {}, which does not parse: {}", source, rendered, e));
        assert_eq!(reparsed, ast, "{} changed shape across the round trip", source);
    }
}
