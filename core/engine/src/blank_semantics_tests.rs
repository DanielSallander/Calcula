//! FILENAME: core/engine/src/blank_semantics_tests.rs
//! PURPOSE: Excel's three-way blank rule, asserted end to end (open-items 1.5).
//!
//! A blank cell is `0` in arithmetic, `""` in concatenation, and **not in the
//! population at all** for the counting and statistical functions. The third
//! meaning is the one no stand-in value can express — ignoring a value is not
//! the same as contributing one, because it changes the denominator — and it is
//! why `EvalResult::Blank` had to become a variant rather than a convention.
//!
//! WHY EVERY CASE IS PAIRED WITH A CONTROL. The fixture is chosen so the right
//! answer and the old wrong answer DIFFER: `AVERAGE` over `{1, blank, 3}` is 2
//! and used to be 1.333, `MIN` is 1 and used to be 0, `PRODUCT` is 3 and used
//! to be 0. A fixture where blank-as-zero happens to give the same number
//! proves nothing.
//!
//! THE TWO SPELLINGS OF A RANGE ARE ASSERTED TOGETHER. Before this work
//! `A1:A3` injected zeros for absent cells while `A:A` skipped them, so the
//! same workbook gave two different answers for the same function depending on
//! how the user wrote the range. That disagreement was invisible, so it gets
//! its own test.
//!
//! AND THE TWO REPRESENTATIONS OF BLANK. A cell missing from `grid.cells` and a
//! cell present holding `CellValue::Empty` are one thing to a user. The second
//! is produced in quantity — `Cell::new()`, un-evaluated formula cells, spill
//! vacating, styled-empty cells from `.xlsx` import, `.calp` overrides — and
//! treating only the first as blank is how `ISBLANK` came to answer FALSE for
//! an empty cell.

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
        other => panic!("{} gave {:?}, expected a number", formula, other),
    }
}

fn text(grid: &Grid, formula: &str) -> String {
    match eval(grid, formula) {
        EvalResult::Text(s) => s,
        other => panic!("{} gave {:?}, expected text", formula, other),
    }
}

fn boolean(grid: &Grid, formula: &str) -> bool {
    match eval(grid, formula) {
        EvalResult::Boolean(b) => b,
        other => panic!("{} gave {:?}, expected a boolean", formula, other),
    }
}

/// A1=1, A2 ABSENT, A3=3. B2 is PRESENT and holds `CellValue::Empty`.
/// C1 holds the empty string, which is a value and not a blank.
fn gapped() -> Grid {
    let mut g = Grid::new();
    g.set_cell(0, 0, Cell::new_number(1.0));
    g.set_cell(2, 0, Cell::new_number(3.0));
    let mut present_but_empty = Cell::new_number(0.0);
    present_but_empty.value = CellValue::Empty;
    g.set_cell(1, 1, present_but_empty);
    g.set_cell(0, 2, Cell::new_text(String::new()));
    g
}

// ---------------------------------------------------------------------------
// 1. Arithmetic — a blank is 0
// ---------------------------------------------------------------------------

#[test]
fn a_blank_is_zero_in_arithmetic() {
    let g = gapped();
    assert_eq!(num(&g, "=A2+1"), 1.0);
    assert_eq!(num(&g, "=A2*5"), 0.0);
    assert_eq!(num(&g, "=1-A2"), 1.0);
    assert_eq!(num(&g, "=-A2"), 0.0);
    assert_eq!(num(&g, "=A1+A2+A3"), 4.0);
    // ...and so is a cell that EXISTS holding CellValue::Empty.
    assert_eq!(num(&g, "=B2+7"), 7.0);
}

/// `=A1` over an empty cell DISPLAYS 0 in Excel, so the blank has to collapse
/// at the storage boundary even though it stays a blank inside the evaluator.
/// Both halves, because each guards a different mistake.
#[test]
fn a_bare_reference_to_a_blank_evaluates_blank_and_displays_zero() {
    let g = gapped();
    assert_eq!(eval(&g, "=A2"), EvalResult::Blank);
    assert_eq!(eval(&g, "=A2").to_cell_value(), CellValue::Number(0.0));
    assert_eq!(eval(&g, "=B2"), EvalResult::Blank);
}

// ---------------------------------------------------------------------------
// 2. Concatenation — a blank is ""
// ---------------------------------------------------------------------------

#[test]
fn a_blank_is_the_empty_string_in_text_contexts() {
    let g = gapped();
    assert_eq!(text(&g, "=A2&\"x\""), "x");
    assert_eq!(text(&g, "=CONCATENATE(A2,\"x\")"), "x");
    assert_eq!(text(&g, "=UPPER(A2)"), "");
    assert_eq!(text(&g, "=TRIM(A2)"), "");
    assert_eq!(num(&g, "=LEN(A2)"), 0.0);
    // The control: a real zero still concatenates as "0".
    let mut z = Grid::new();
    z.set_cell(0, 0, Cell::new_number(0.0));
    assert_eq!(text(&z, "=A1&\"x\""), "0x");
}

// ---------------------------------------------------------------------------
// 3. Counting and statistics — a blank is NOT IN THE POPULATION
// ---------------------------------------------------------------------------

#[test]
fn counting_functions_ignore_blanks_in_both_range_spellings() {
    let g = gapped();
    for range in ["A1:A3", "A:A"] {
        assert_eq!(num(&g, &format!("=COUNT({})", range)), 2.0, "COUNT {}", range);
        assert_eq!(num(&g, &format!("=COUNTA({})", range)), 2.0, "COUNTA {}", range);
    }
    // The severe case: a range far larger than the data used to return its own
    // area, so `COUNT(A1:A1000)` over two numbers answered 1000.
    assert_eq!(num(&g, "=COUNT(A1:A1000)"), 2.0);
    assert_eq!(num(&g, "=COUNTA(A1:A1000)"), 2.0);
}

#[test]
fn statistical_functions_shrink_their_denominator_rather_than_adding_a_zero() {
    let g = gapped();
    // 1.333 was the old answer, and it is exactly what a zero in the sample
    // gives — which is why this fixture has three cells and two values.
    assert_eq!(num(&g, "=AVERAGE(A1:A3)"), 2.0);
    assert_eq!(num(&g, "=MEDIAN(A1:A3)"), 2.0);
    assert_eq!(num(&g, "=MIN(A1:A3)"), 1.0);
    assert_eq!(num(&g, "=MAX(A1:A3)"), 3.0);
    // PRODUCT is the trap: it LOOKS arithmetic-shaped, so a blank read as zero
    // made every product containing an empty cell zero.
    assert_eq!(num(&g, "=PRODUCT(A1:A3)"), 3.0);
    // SUM is unchanged, because skipping a zero and adding it agree.
    assert_eq!(num(&g, "=SUM(A1:A3)"), 4.0);
    assert_eq!(num(&g, "=SMALL(A1:A3,1)"), 1.0);
    assert_eq!(num(&g, "=LARGE(A1:A3,1)"), 3.0);
}

#[test]
fn the_two_range_spellings_now_agree_with_each_other() {
    let g = gapped();
    // This was the sharpest symptom: the same function over the same data
    // answered differently depending on how the range was written.
    for f in ["COUNT", "COUNTA", "AVERAGE", "MIN", "MAX", "SUM"] {
        assert_eq!(
            num(&g, &format!("={}(A1:A3)", f)),
            num(&g, &format!("={}(A:A)", f)),
            "{} disagrees between A1:A3 and A:A",
            f
        );
    }
}

#[test]
fn an_all_blank_range_is_the_empty_set_not_a_set_of_zeros() {
    let g = gapped();
    assert_eq!(num(&g, "=COUNT(X1:X3)"), 0.0);
    assert_eq!(num(&g, "=COUNTA(X1:X3)"), 0.0);
    // SUM/MIN of the empty set are 0 in Excel — unchanged, and the guard that
    // this change did not turn them into errors.
    assert_eq!(num(&g, "=SUM(X1:X3)"), 0.0);
    assert_eq!(num(&g, "=MIN(X1:X3)"), 0.0);
    // AVERAGE of the empty set is #DIV/0!, which is only REACHABLE now that
    // the range is empty rather than full of zeros.
    assert_eq!(eval(&g, "=AVERAGE(X1:X3)"), EvalResult::Error(CellError::Div0));
}

#[test]
fn subtotal_and_aggregate_ignore_blanks_like_their_plain_counterparts() {
    let g = gapped();
    assert_eq!(num(&g, "=SUBTOTAL(1,A1:A3)"), 2.0); // AVERAGE
    assert_eq!(num(&g, "=SUBTOTAL(2,A1:A3)"), 2.0); // COUNT
    assert_eq!(num(&g, "=SUBTOTAL(3,A1:A3)"), 2.0); // COUNTA
    assert_eq!(num(&g, "=SUBTOTAL(9,A1:A3)"), 4.0); // SUM
    assert_eq!(num(&g, "=AGGREGATE(1,0,A1:A3)"), 2.0);
}

// ---------------------------------------------------------------------------
// 4. COUNTBLANK, ISBLANK and the "" distinction
// ---------------------------------------------------------------------------

/// COUNTBLANK never worked: its own comment claimed absent cells arrived as
/// empty text and were therefore handled, and they arrived as the number 0.
#[test]
fn countblank_counts_blanks_and_the_empty_string() {
    let g = gapped();
    assert_eq!(num(&g, "=COUNTBLANK(A1:A3)"), 1.0);
    // Excel's documented exception: a cell holding `""` is counted by
    // COUNTBLANK as well as by COUNTA. C1 holds the empty string.
    assert_eq!(num(&g, "=COUNTBLANK(C1:C1)"), 1.0);
    assert_eq!(num(&g, "=COUNTA(C1:C1)"), 1.0);
}

#[test]
fn isblank_sees_both_representations_and_refuses_the_empty_string() {
    let g = gapped();
    assert!(boolean(&g, "=ISBLANK(A2)"), "a cell absent from the grid");
    assert!(boolean(&g, "=ISBLANK(B2)"), "a cell present holding CellValue::Empty");
    assert!(!boolean(&g, "=ISBLANK(A1)"));
    // A value that merely LOOKS empty is not blank. `=ISBLANK("")` is FALSE in
    // Excel, and so is ISBLANK of a cell holding the empty string.
    assert!(!boolean(&g, "=ISBLANK(\"\")"));
    assert!(!boolean(&g, "=ISBLANK(C1)"));
}

// ISBLANK PROPAGATES AN ERROR rather than answering FALSE — answering FALSE
// would launder a broken reference into an ordinary result. That case needs a
// MULTI-SHEET evaluator to be meaningful (a single-sheet one resolves a foreign
// sheet name against the only grid it has), so it is asserted where the
// multi-sheet fixtures live: `a_reference_to_a_sheet_that_does_not_exist_is_
// ref_not_the_local_sheet` in `evaluator.rs`. Rewriting ISBLANK is exactly what
// could have broken it, which is why it is named here rather than assumed.

#[test]
fn a_blank_is_not_a_number_and_types_as_one() {
    let g = gapped();
    assert!(!boolean(&g, "=ISNUMBER(A2)"));
    assert!(!boolean(&g, "=ISTEXT(A2)"));
    // TYPE has no code for "blank": the blank collapses to a number first, so
    // Excel answers 1.
    assert_eq!(num(&g, "=TYPE(A2)"), 1.0);
    assert_eq!(num(&g, "=N(A2)"), 0.0);
}

// ---------------------------------------------------------------------------
// 5. Comparison — and its famous asymmetry
// ---------------------------------------------------------------------------

#[test]
fn a_blank_equals_both_zero_and_the_empty_string_while_they_differ() {
    let g = gapped();
    assert!(boolean(&g, "=A2=0"), "blank = 0");
    assert!(boolean(&g, "=A2=\"\""), "blank = \"\"");
    // ...but the empty string is only text. This asymmetry is Excel's, and it
    // is the whole reason a blank needs its own variant rather than a value to
    // stand in for it.
    assert!(!boolean(&g, "=\"\"=0"));
}

#[test]
fn ordering_against_a_blank_compares_it_as_the_other_sides_zero() {
    let g = gapped();
    assert!(!boolean(&g, "=A2>0"));
    assert!(boolean(&g, "=A2<1"));
    // Against TEXT it is the empty string. These two used to be #VALUE!,
    // because a number cannot enter the text-comparison branch.
    assert!(boolean(&g, "=A2<\"a\""));
    assert!(!boolean(&g, "=A2>\"\""));
}

#[test]
fn a_blank_is_false_in_a_logical_test() {
    let g = gapped();
    assert_eq!(num(&g, "=IF(A2,1,2)"), 2.0);
    assert!(!boolean(&g, "=AND(A2,TRUE)"));
    assert!(boolean(&g, "=OR(A2,TRUE)"));
    assert!(boolean(&g, "=NOT(A2)"));
}

// ---------------------------------------------------------------------------
// 6. Criteria — COUNTIF's three blank spellings
// ---------------------------------------------------------------------------

#[test]
fn countif_treats_blanks_as_excel_does() {
    let g = gapped();
    // A blank is NOT zero to a criteria: this counted every empty cell.
    assert_eq!(num(&g, "=COUNTIF(A1:A3,0)"), 0.0);
    // `""` counts blanks (and cells holding the empty string).
    assert_eq!(num(&g, "=COUNTIF(A1:A3,\"\")"), 1.0);
    // `"<>"` counts everything that is not blank.
    assert_eq!(num(&g, "=COUNTIF(A1:A3,\"<>\")"), 2.0);
    // A numeric comparison never picks up a blank.
    assert_eq!(num(&g, "=COUNTIF(A1:A3,\"<=1\")"), 1.0);
    assert_eq!(num(&g, "=COUNTIF(A1:A3,\">0\")"), 2.0);
}

/// The cached COUNTIF fast path must agree with the scan for every one of
/// these, or the pass cache is a second ANSWER rather than a faster route to
/// the same one. The three blank criteria are served by the scan on purpose —
/// `CriteriaIndex` buckets by value and has no notion of a blank.
#[test]
fn the_countif_cache_agrees_with_the_scan_over_blanks() {
    let g = gapped();
    for f in [
        "=COUNTIF(A1:A3,0)",
        "=COUNTIF(A1:A3,\"\")",
        "=COUNTIF(A1:A3,\"<>\")",
        "=COUNTIF(A1:A3,\"<=1\")",
        "=COUNTIF(A1:A3,\"<>apple\")",
        "=COUNTIF(A1:A3,\">0\")",
    ] {
        let scanned = eval(&g, f);
        let cached = {
            let _pass = crate::lookup_cache::begin_pass();
            let first = eval(&g, f);
            let second = eval(&g, f);
            assert_eq!(first, second, "index build vs hit mismatch for {}", f);
            first
        };
        assert_eq!(scanned, cached, "cache diverged from scan for {}", f);
    }
}

// ---------------------------------------------------------------------------
// 7. Lookup — a blank in the haystack matches nothing
// ---------------------------------------------------------------------------

#[test]
fn an_exact_lookup_does_not_match_a_blank_against_zero() {
    let g = gapped();
    assert_eq!(eval(&g, "=MATCH(0,A1:A3,0)"), EvalResult::Error(CellError::NA));
    assert_eq!(num(&g, "=MATCH(3,A1:A3,0)"), 3.0, "the positive control");
}

/// VLOOKUP returns a VALUE, so a blank result cell becomes the number 0 — which
/// is why `ISBLANK(VLOOKUP(…))` is FALSE in Excel and why users write
/// `IF(VLOOKUP(…)="","",…)`. INDEX returns a REFERENCE and keeps the blank.
#[test]
fn a_value_returning_lookup_collapses_a_blank_result_but_index_does_not() {
    let mut g = Grid::new();
    g.set_cell(0, 0, Cell::new_number(1.0)); // A1
    g.set_cell(1, 0, Cell::new_number(2.0)); // A2
    // B1 is set, B2 deliberately is not — the blank result cell.
    g.set_cell(0, 1, Cell::new_text("one".to_string()));

    assert_eq!(eval(&g, "=VLOOKUP(2,A1:B2,2,FALSE)"), EvalResult::Number(0.0));
    assert!(!boolean(&g, "=ISBLANK(VLOOKUP(2,A1:B2,2,FALSE))"));

    assert_eq!(eval(&g, "=INDEX(B1:B2,2)"), EvalResult::Blank);
    assert!(boolean(&g, "=ISBLANK(INDEX(B1:B2,2))"));
    assert_eq!(num(&g, "=COUNT(INDEX(B1:B2,2))"), 0.0);
}

// ---------------------------------------------------------------------------
// 8. Nothing blank ever leaves the evaluator
// ---------------------------------------------------------------------------

/// A blank must never be stored and must never spill: `to_cell_value` is the
/// door, and this asserts it for every shape that can reach it. Storing one
/// would create a formula cell that LOOKS empty — a different thing from a cell
/// that IS empty, and enough to make `ISBLANK` lie about a cell with a formula
/// in it.
#[test]
fn a_blank_never_reaches_a_cell() {
    let g = gapped();
    assert_eq!(eval(&g, "=A2").to_cell_value(), CellValue::Number(0.0));
    assert_eq!(eval(&g, "=INDEX(A1:A3,2)").to_cell_value(), CellValue::Number(0.0));
    // A spilled array of blanks stores zeros, exactly as Excel spills them.
    match eval(&g, "=SORT(A1:A3)") {
        EvalResult::Array(items) => {
            assert!(!items.is_empty());
            for item in &items {
                assert!(
                    !matches!(item.to_cell_value(), CellValue::Empty),
                    "a spilled element must never store as Empty: {:?}",
                    item
                );
            }
        }
        other => panic!("SORT gave {:?}", other),
    }
}

// ---------------------------------------------------------------------------
// 9. The database functions, whose criteria gate was the worst symptom
// ---------------------------------------------------------------------------

/// An EMPTY CRITERIA CELL MEANS "NO CONDITION". It used to arrive as the number
/// 0 and be applied as the live criterion `= 0`, which matches nothing — so
/// every D-function with a partially-filled criteria rectangle silently
/// filtered its whole database out and returned an empty result.
#[test]
fn an_empty_criteria_cell_is_no_condition_not_equal_to_zero() {
    let mut g = Grid::new();
    // Database A1:B4 — header + three rows.
    g.set_cell(0, 0, Cell::new_text("Name".to_string()));
    g.set_cell(0, 1, Cell::new_text("Qty".to_string()));
    g.set_cell(1, 0, Cell::new_text("a".to_string()));
    g.set_cell(1, 1, Cell::new_number(10.0));
    g.set_cell(2, 0, Cell::new_text("b".to_string()));
    g.set_cell(2, 1, Cell::new_number(20.0));
    g.set_cell(3, 0, Cell::new_text("c".to_string()));
    g.set_cell(3, 1, Cell::new_number(30.0));
    // Criteria D1:E2 — a header pair with only ONE condition filled in.
    g.set_cell(0, 3, Cell::new_text("Name".to_string()));
    g.set_cell(0, 4, Cell::new_text("Qty".to_string()));
    g.set_cell(1, 3, Cell::new_text("b".to_string()));
    // E2 is deliberately left empty: "no condition on Qty".

    assert_eq!(num(&g, "=DSUM(A1:B4,\"Qty\",D1:E2)"), 20.0);
    assert_eq!(num(&g, "=DCOUNT(A1:B4,\"Qty\",D1:E2)"), 1.0);
}

// ---------------------------------------------------------------------------
// 10. Paired statistics keep their pairs aligned
// ---------------------------------------------------------------------------

/// Excel drops the PAIR when either member is not a number. Filtering the two
/// arrays independently — which is what these functions did — shortens one side
/// and matches every later value against the wrong partner. The defect predates
/// blank-awareness (it fired on text cells) but blank-awareness is what makes
/// it common, because every empty cell in a data column used to hold its place.
#[test]
fn paired_statistics_drop_the_pair_rather_than_sliding_one_side() {
    let mut g = Grid::new();
    // X = A1:A4, Y = B1:B4, with A3 BLANK. The surviving pairs are
    // (1,10), (2,20), (4,40) — a perfect line y = 10x, so CORREL is 1 and
    // SLOPE is 10. Misaligned, the third pair would become (4,30) and both
    // would be something else.
    for (row, x) in [(0u32, 1.0), (1, 2.0), (3, 4.0)] {
        g.set_cell(row, 0, Cell::new_number(x));
    }
    for (row, y) in [(0u32, 10.0), (1, 20.0), (2, 30.0), (3, 40.0)] {
        g.set_cell(row, 1, Cell::new_number(y));
    }

    assert!((num(&g, "=SLOPE(B1:B4,A1:A4)") - 10.0).abs() < 1e-9);
    assert!((num(&g, "=CORREL(A1:A4,B1:B4)") - 1.0).abs() < 1e-9);
}

// ---------------------------------------------------------------------------
// 11. THE SECOND ROUND — every case below was a real defect that the first
//     twenty-one tests passed straight through
// ---------------------------------------------------------------------------
//
// An adversarial review of the blank work found fifteen defects the suite above
// could not see, and they share one shape: a materialiser, a collector or a
// comparator converted in ONE of its branches. The lesson is written into the
// tests rather than into a comment — each case below asserts the two spellings
// of the same question AGAINST EACH OTHER, so a future half-conversion fails
// rather than merely producing a different number somewhere nobody looks.

/// A blank in a sorted key column used to STOP an approximate lookup dead.
///
/// `compare_values` had no `Blank` arm, so a blank fell into "greater than
/// every number" and the ascending walk broke at it. The value returned was the
/// row BEFORE the blank — a plausible, wrong row.
#[test]
fn an_approximate_lookup_walks_past_a_blank_instead_of_stopping_at_it() {
    let mut g = Grid::new();
    g.set_cell(0, 0, Cell::new_number(1.0)); // A1
    // A2 deliberately empty — the gap in the sorted key column.
    g.set_cell(2, 0, Cell::new_number(3.0)); // A3
    g.set_cell(0, 1, Cell::new_number(10.0));
    g.set_cell(1, 1, Cell::new_number(20.0));
    g.set_cell(2, 1, Cell::new_number(30.0));

    assert_eq!(num(&g, "=VLOOKUP(3,A1:B3,2,TRUE)"), 30.0, "VLOOKUP approximate");
    assert_eq!(num(&g, "=LOOKUP(3,A1:A3,B1:B3)"), 30.0, "LOOKUP");
    // MATCH orders through a different helper. The two must agree — they
    // answered different rows for this exact grid.
    assert_eq!(num(&g, "=MATCH(3,A1:A3,1)"), 3.0, "MATCH type 1");
}

/// LOOKUP and XLOOKUP return VALUES, so a blank result cell is the number 0 —
/// and the CACHED and SCANNED paths must agree about that, or the same formula
/// answers differently depending on whether a recalc pass is active.
#[test]
fn every_value_returning_lookup_collapses_a_blank_result() {
    let mut g = Grid::new();
    g.set_cell(0, 0, Cell::new_text("a".to_string()));
    g.set_cell(1, 0, Cell::new_text("b".to_string()));
    g.set_cell(0, 1, Cell::new_number(10.0));
    // B2 deliberately empty — the blank result cell.

    for inner in ["LOOKUP(\"b\",A1:A2,B1:B2)", "XLOOKUP(\"b\",A1:A2,B1:B2)"] {
        let f = format!("={}", inner);
        assert_eq!(eval(&g, &f), EvalResult::Number(0.0), "{}", f);
        assert!(!boolean(&g, &format!("=ISBLANK({})", inner)), "ISBLANK of {}", inner);
        // ...and the cached path agrees with the scan.
        let scanned = eval(&g, &f);
        let cached = {
            let _pass = crate::lookup_cache::begin_pass();
            eval(&g, &f)
        };
        assert_eq!(scanned, cached, "cache diverged from scan for {}", f);
    }
}

/// SUBTOTAL's two spellings must agree. The bare-cell-reference branch of
/// `collect_visible_values` still injected zeros, and that branch is the one
/// the `=SUBTOTAL(9,B5,B10,B15)` grand-total idiom takes.
#[test]
fn subtotal_agrees_between_a_range_and_a_list_of_cell_references() {
    let g = gapped();
    for code in [1, 2, 3, 4, 5, 6, 9] {
        assert_eq!(
            num(&g, &format!("=SUBTOTAL({},A1:A3)", code)),
            num(&g, &format!("=SUBTOTAL({},A1,A2,A3)", code)),
            "SUBTOTAL({}) disagrees between a range and a cell list",
            code
        );
    }
}

/// AGGREGATE and SUBTOTAL are the same aggregates behind two names, and COUNTA
/// is where they parted company: AGGREGATE kept the old, backwards filter.
#[test]
fn aggregate_agrees_with_subtotal_and_with_the_plain_function() {
    let g = gapped();
    for (code, plain) in [(1, "AVERAGE"), (2, "COUNT"), (3, "COUNTA"), (4, "MAX"), (5, "MIN")] {
        let aggregate = num(&g, &format!("=AGGREGATE({},0,A1:A3)", code));
        assert_eq!(
            aggregate,
            num(&g, &format!("=SUBTOTAL({},A1:A3)", code)),
            "AGGREGATE({}) disagrees with SUBTOTAL({})",
            code,
            code
        );
        assert_eq!(
            aggregate,
            num(&g, &format!("={}(A1:A3)", plain)),
            "AGGREGATE({}) disagrees with {}",
            code,
            plain
        );
    }
}

/// OFFSET's single-cell and multi-cell branches are the same materialiser, and
/// only one of them had been converted.
#[test]
fn offset_answers_the_same_as_the_range_it_describes() {
    let g = gapped();
    for f in ["COUNT", "COUNTA", "AVERAGE", "MIN", "MAX", "SUM"] {
        assert_eq!(
            num(&g, &format!("={}(OFFSET(A1,0,0,3,1))", f)),
            num(&g, &format!("={}(A1:A3)", f)),
            "{} over OFFSET disagrees with {} over the same range",
            f,
            f
        );
    }
}

/// TEXTJOIN's Array branch swallowed blanks that its Range branch kept, so the
/// answer depended on how the argument was SHAPED rather than on what it held.
///
/// `A:A` USED TO BE THE ODD ONE OUT HERE, AND IS NOT ANY MORE. This comment
/// used to record a still-open limitation: a whole-column reference COMPACTED —
/// `eval_column_ref` returned only the populated cells — so `A:A` was shorter
/// than the column, and `=TEXTJOIN(",",FALSE,A:A)` yielded `"1,3"` where
/// `A1:A3` yielded `"1,,3"`. Invisible to an aggregate that skips blanks;
/// wrong for every positional consumer, which is why it also shifted
/// `INDEX`/`MATCH` positions and misaligned `SUMIF`'s two columns.
///
/// The objection recorded here was that the obvious fix — materialising a whole
/// column densely — would make `SUM(A:A)` walk a million rows. That was right
/// about the naive fix and wrong about the real one: the span is the USED RANGE
/// (`grid.max_row`), not the sheet, so a 200-row column materialises 200 cells.
/// Closed 2026-08-24; all three spellings now agree, and the assertion below
/// changed from `"1,3"` to `"1,,3"` to say so.
#[test]
fn textjoin_treats_every_positional_argument_shape_the_same_way() {
    let g = gapped();
    for ignore in ["TRUE", "FALSE"] {
        assert_eq!(
            text(&g, &format!("=TEXTJOIN(\",\",{},OFFSET(A1,0,0,3,1))", ignore)),
            text(&g, &format!("=TEXTJOIN(\",\",{},A1:A3)", ignore)),
            "TEXTJOIN ignore_empty={} disagrees between A1:A3 and the same three \
             cells reached through OFFSET",
            ignore
        );
    }
    // ...and the values themselves are Excel's.
    assert_eq!(text(&g, "=TEXTJOIN(\",\",TRUE,A1:A3)"), "1,3");
    assert_eq!(text(&g, "=TEXTJOIN(\",\",FALSE,A1:A3)"), "1,,3");
    // ...and the whole-column spelling now agrees with the rectangular one,
    // which is the property that used to be missing. `gapped()` puts data in
    // A1 and A3 with A2 empty, and the used range ends at row 3, so `A:A` is
    // exactly the three cells `A1:A3` is.
    assert_eq!(
        text(&g, "=TEXTJOIN(\",\",FALSE,A:A)"),
        text(&g, "=TEXTJOIN(\",\",FALSE,A1:A3)"),
        "a whole-column reference is row-indexed now; it must not drop the \
         blanks the rectangular spelling keeps"
    );
    assert_eq!(text(&g, "=TEXTJOIN(\",\",FALSE,A:A)"), "1,,3");
}

/// One criteria filter, one population: every D-function must agree about which
/// rows are in it. Four of them still reached the field through `as_number`, so
/// DCOUNT said 2 while DAVERAGE divided by 3.
#[test]
fn the_database_family_computes_over_one_population() {
    let mut g = Grid::new();
    g.set_cell(0, 0, Cell::new_text("Grp".to_string()));
    g.set_cell(0, 1, Cell::new_text("Qty".to_string()));
    for row in 1..4u32 {
        g.set_cell(row, 0, Cell::new_text("x".to_string()));
    }
    g.set_cell(1, 1, Cell::new_number(1.0));
    // Row 3's Qty is deliberately EMPTY — in the filter, out of the population.
    g.set_cell(3, 1, Cell::new_number(3.0));
    g.set_cell(0, 3, Cell::new_text("Grp".to_string()));
    g.set_cell(1, 3, Cell::new_text("x".to_string()));

    let q = |f: &str| -> f64 { num(&g, &format!("={}(A1:B4,\"Qty\",D1:D2)", f)) };
    assert_eq!(q("DCOUNT"), 2.0);
    assert_eq!(q("DCOUNTA"), 2.0);
    assert_eq!(q("DAVERAGE"), 2.0);
    assert_eq!(q("DMIN"), 1.0);
    assert_eq!(q("DMAX"), 3.0);
    assert_eq!(q("DPRODUCT"), 3.0);
    assert_eq!(q("DSUM"), 4.0);
}

/// The conditional aggregates reached their VALUE range through `as_number`, so
/// a blank contributed a zero and inflated the denominator — the same defect
/// AVERAGE had, one function along.
#[test]
fn the_conditional_aggregates_ignore_blanks_in_their_value_range() {
    let mut g = Grid::new();
    for row in 0..3u32 {
        g.set_cell(row, 0, Cell::new_text("x".to_string()));
    }
    g.set_cell(0, 1, Cell::new_number(1.0));
    // B2 deliberately empty.
    g.set_cell(2, 1, Cell::new_number(3.0));

    assert_eq!(num(&g, "=AVERAGEIF(A1:A3,\"x\",B1:B3)"), 2.0);
    assert_eq!(num(&g, "=MINIFS(B1:B3,A1:A3,\"x\")"), 1.0);
    assert_eq!(num(&g, "=MAXIFS(B1:B3,A1:A3,\"x\")"), 3.0);
    // The unconditional twins, for comparison — they must give the same answers.
    assert_eq!(num(&g, "=AVERAGE(B1:B3)"), 2.0);
    assert_eq!(num(&g, "=MIN(B1:B3)"), 1.0);
    assert_eq!(num(&g, "=MAX(B1:B3)"), 3.0);
}

/// T.TEST and F.TEST take two INDEPENDENT samples, not pairs. A mechanical
/// sweep gave them the paired collector, which truncated both to the shorter
/// length and silently discarded observations — and, worse, made T.TEST's own
/// "paired arrays must be the same length" guard unable to fire.
#[test]
fn the_two_sample_tests_do_not_truncate_one_sample_to_the_other() {
    let mut g = Grid::new();
    for (row, v) in [(0u32, 1.0), (1, 2.0), (2, 3.0), (3, 4.0), (4, 5.0)] {
        g.set_cell(row, 0, Cell::new_number(v));
    }
    for (row, v) in [(0u32, 2.0), (1, 4.0), (2, 6.0)] {
        g.set_cell(row, 1, Cell::new_number(v));
    }
    // Unequal, legitimate sample sizes: a two-sample test must use all five
    // observations on the left, not the first three.
    let five_vs_three = num(&g, "=T.TEST(A1:A5,B1:B3,2,3)");
    let three_vs_three = num(&g, "=T.TEST(A1:A3,B1:B3,2,3)");
    assert!(
        (five_vs_three - three_vs_three).abs() > 1e-9,
        "T.TEST over five observations must differ from T.TEST over three; \
         got {} for both, so two observations were silently discarded",
        five_vs_three
    );
    // ...and the PAIRED type still refuses unequal lengths, which is the guard
    // the truncation had made unreachable.
    assert_eq!(
        eval(&g, "=T.TEST(A1:A5,B1:B3,2,1)"),
        EvalResult::Error(CellError::Value),
        "paired T.TEST over unequal-length ranges must be an error"
    );
}

/// `SORT()` MATERIALISES a value, and the value of a blank is 0 — so a blank
/// must sort where a zero sorts, in both directions. Giving blanks their own
/// ordering class made the zero jump from one end of the result to the other
/// when the direction flipped, while every real value merely reversed.
#[test]
fn sorting_places_a_blank_where_its_own_spilled_value_belongs() {
    let mut g = Grid::new();
    g.set_cell(0, 0, Cell::new_number(5.0));
    // A2 empty -> spills as 0.
    g.set_cell(2, 0, Cell::new_number(3.0));

    let spilled = |formula: &str| -> Vec<f64> {
        match eval(&g, formula) {
            EvalResult::Array(items) => items
                .iter()
                .map(|i| match i.to_cell_value() {
                    CellValue::Number(n) => n,
                    other => panic!("spilled {:?}", other),
                })
                .collect(),
            other => panic!("{} gave {:?}", formula, other),
        }
    };
    assert_eq!(spilled("=SORT(A1:A3)"), vec![0.0, 3.0, 5.0]);
    assert_eq!(spilled("=SORT(A1:A3,1,-1)"), vec![5.0, 3.0, 0.0]);
}

/// UNIQUE removes duplicates from what it SPILLS. Keying on the internal
/// variant made a blank and a real zero two distinct keys and one output value,
/// so the de-duplicator emitted duplicates.
#[test]
fn unique_does_not_emit_two_rows_that_render_identically() {
    let mut g = Grid::new();
    g.set_cell(0, 0, Cell::new_number(0.0)); // a real zero
    // A2 empty — spills as 0 too.
    g.set_cell(2, 0, Cell::new_number(0.0));

    match eval(&g, "=UNIQUE(A1:A3)") {
        EvalResult::Array(items) => assert_eq!(
            items.len(),
            1,
            "a blank and a zero spill the same value, so UNIQUE must keep one: {:?}",
            items
        ),
        other => panic!("UNIQUE gave {:?}", other),
    }
}
