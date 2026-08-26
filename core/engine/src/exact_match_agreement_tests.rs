//! FILENAME: core/engine/src/exact_match_agreement_tests.rs
//! PURPOSE: EVERY EXACT-MATCH SURFACE IN THE ENGINE MUST GIVE THE SAME ANSWER,
//! and the criteria family's deliberate divergences from them must be
//! deliberate.
//!
//! # The defect this file exists to prevent is DISAGREEMENT, not wrongness
//!
//! Each of MATCH, VLOOKUP, HLOOKUP, LOOKUP, XLOOKUP, SWITCH and the pass cache
//! had its own hand-written notion of "the same value". In ONE build, on ONE
//! column, they answered:
//!
//! ```text
//!                                     needle 1E-300, column holds 2E-300
//!   =(1E-300=A2)                          FALSE
//!   =MATCH(1E-300,A1:A4,0)                #N/A
//!   =VLOOKUP(1E-300,A1:B4,2,FALSE)        the payload of the 2E-300 row  <-- !
//!   =XLOOKUP(1E-300,A1:A4,B1:B4)          the payload of the 2E-300 row  <-- !
//! ```
//!
//! because `values_equal` used `|a-b| < 1e-10`, `xlookup_values_equal` used
//! `|a-b| < f64::EPSILON` and `eval_values_equal` used `==`. Two more
//! disagreements came out of the same three copies:
//!
//! ```text
//!   =VLOOKUP("STRASSE",…,FALSE)   #N/A over a cell holding "Straße"
//!                                 (ASCII-only fold; every other path matched)
//!   =XLOOKUP("1",A1:A4,B1:B4)     the row of the NUMBER 1, not the TEXT "1"
//!                                 (only XLOOKUP cross-typed)
//! ```
//!
//! None of these is an error on the sheet. Every one is a plausible payload
//! from the WRONG ROW, and a user comparing two formulas that should agree has
//! no way to tell which one lied.
//!
//! # The predicate
//!
//! There is now ONE: `Evaluator::exact_lookup_equal`, which is the `=`
//! operator's own ladder (`excel_comparison_ordering` returning `Equal`) with
//! blank resolution left off. Numbers exact, text case-insensitive over full
//! Unicode, booleans by value, and NEVER across type classes.
//!
//! Each test below therefore asserts AGREEMENT — surface against surface —
//! rather than each surface against a remembered constant. A regression in one
//! path reddens the pair, and the message names both sides.
//!
//! # The criteria family diverges ON PURPOSE, and that is pinned too
//!
//! `COUNTIF(rng,1)` counts a cell holding the TEXT "1" while `=(A1="1")` is
//! FALSE. That is Excel's own behaviour — criteria coerce numeric text, the
//! comparison operators do not — so it is asserted side by side with the
//! operator that disagrees, in the section at the bottom, to keep it legible as
//! a decision. What is NOT Excel's behaviour, and was fixed with these tests, is
//! a LOGICAL matching a numeric criterion.

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

fn boolean(grid: &Grid, formula: &str) -> bool {
    match eval(grid, formula) {
        EvalResult::Boolean(b) => b,
        other => panic!("`{}` gave {:?}, expected a boolean", formula, other),
    }
}

fn na(grid: &Grid, formula: &str) {
    assert_eq!(
        eval(grid, formula),
        EvalResult::Error(CellError::NA),
        "`{}` should find nothing",
        formula
    );
}

/// THE MIXED COLUMN, and the fixture every cross-type case runs on.
///   A1 = the NUMBER 1
///   A2 = the TEXT "1"
///   A3 = TRUE
///   A4 = the TEXT "apple"
/// B1:B4 = 10, 20, 30, 40 — payloads chosen so the answer NAMES the row that
/// matched, which is what makes a wrong row visible instead of merely a wrong
/// count.
///
/// Row 6 (A6:D6) is the same four values laid out ACROSS, with payloads in row
/// 7, so HLOOKUP runs on data identical to VLOOKUP's. An orientation-only
/// difference is exactly the kind of drift a column-only fixture hides.
fn mixed() -> Grid {
    let mut g = Grid::new();
    g.set_cell(0, 0, Cell::new_number(1.0));
    g.set_cell(1, 0, Cell::new_text("1".to_string()));
    g.set_cell(2, 0, Cell::new_boolean(true));
    g.set_cell(3, 0, Cell::new_text("apple".to_string()));
    for r in 0..4u32 {
        g.set_cell(r, 1, Cell::new_number(((r + 1) * 10) as f64));
    }
    g.set_cell(5, 0, Cell::new_number(1.0));
    g.set_cell(5, 1, Cell::new_text("1".to_string()));
    g.set_cell(5, 2, Cell::new_boolean(true));
    g.set_cell(5, 3, Cell::new_text("apple".to_string()));
    for c in 0..4u32 {
        g.set_cell(6, c, Cell::new_number(((c + 1) * 10) as f64));
    }
    g
}

/// THE TINY-NUMBER COLUMN. A1=5, A2=2E-300, A3=7, A4=9, payloads 100..400.
///
/// 2E-300 is not a curiosity: it is the smallest fixture on which an ABSOLUTE
/// tolerance is distinguishable from exactness. Both discarded tolerances
/// (1e-10 and f64::EPSILON = 2.22e-16) are ASTRONOMICALLY larger than the gap
/// between 1E-300 and 2E-300, so a needle of 1E-300 "equalled" it under both,
/// while above magnitude 1 an absolute tolerance is finer than the float
/// spacing itself and can never be observed. A fixture built from ordinary
/// magnitudes would have passed under every one of the three old predicates.
fn tiny() -> Grid {
    let mut g = Grid::new();
    g.set_cell(0, 0, Cell::new_number(5.0));
    g.set_cell(1, 0, Cell::new_number(2e-300));
    g.set_cell(2, 0, Cell::new_number(7.0));
    g.set_cell(3, 0, Cell::new_number(9.0));
    for r in 0..4u32 {
        g.set_cell(r, 1, Cell::new_number(((r + 1) * 100) as f64));
    }
    g
}

// ===================================================================
// 1. Numbers are EXACT, on every surface
// ===================================================================

/// The headline disagreement. `=` says 1E-300 and 2E-300 are different numbers;
/// every exact lookup must say the same.
///
/// VLOOKUP and XLOOKUP both returned 200 — the payload of the 2E-300 row — while
/// MATCH and `=` refused. A silent wrong row is the worst failure a lookup has:
/// nothing on the sheet indicates it happened.
#[test]
fn no_exact_lookup_matches_a_number_that_the_equals_operator_calls_different() {
    let g = tiny();
    assert!(!boolean(&g, "=(1E-300=A2)"), "the operator itself");
    na(&g, "=MATCH(1E-300,A1:A4,0)");
    na(&g, "=VLOOKUP(1E-300,A1:B4,2,FALSE)");
    na(&g, "=XLOOKUP(1E-300,A1:A4,B1:B4)");
    na(&g, "=SWITCH(1E-300,A2,\"hit\")");
    // CONTROL: the SAME formulas over the SAME column find the value that IS
    // there. Without this pair "no match" could simply mean "matching is
    // broken", and every assertion above would pass on a function that always
    // returns #N/A.
    assert!(boolean(&g, "=(2E-300=A2)"));
    assert_eq!(num(&g, "=MATCH(2E-300,A1:A4,0)"), 2.0);
    assert_eq!(num(&g, "=VLOOKUP(2E-300,A1:B4,2,FALSE)"), 200.0);
    assert_eq!(num(&g, "=XLOOKUP(2E-300,A1:A4,B1:B4)"), 200.0);
}

/// The same rule at ordinary magnitudes, where the old 1e-10 tolerance was
/// still reachable: 1 and 1.00000000005 differ by 5e-11.
#[test]
fn a_difference_below_the_old_tolerance_is_still_a_difference() {
    let mut g = Grid::new();
    g.set_cell(0, 0, Cell::new_number(1.000_000_000_05));
    g.set_cell(0, 1, Cell::new_number(99.0));
    assert!(!boolean(&g, "=(1=A1)"));
    na(&g, "=MATCH(1,A1:A1,0)");
    na(&g, "=VLOOKUP(1,A1:B1,2,FALSE)");
    na(&g, "=XLOOKUP(1,A1:A1,B1:B1)");
    // CONTROL: the exact value is found by all three.
    assert_eq!(num(&g, "=MATCH(1.00000000005,A1:A1,0)"), 1.0);
    assert_eq!(num(&g, "=VLOOKUP(1.00000000005,A1:B1,2,FALSE)"), 99.0);
    assert_eq!(num(&g, "=XLOOKUP(1.00000000005,A1:A1,B1:B1)"), 99.0);
}

// ===================================================================
// 2. Type classes are never crossed, on every surface
// ===================================================================

/// THE NEEDLE'S TYPE PICKS THE ROW. Three needles that print the same way — the
/// number 1, the text "1", the boolean TRUE — must each land on their OWN row,
/// and the payloads say which one they landed on.
///
/// XLOOKUP was the odd one out: it parsed a text needle with `str::parse::<f64>`
/// and matched the NUMBER row, so `=XLOOKUP("1",…)` returned 10 where MATCH,
/// VLOOKUP and HLOOKUP all returned 20.
#[test]
fn every_exact_lookup_picks_the_row_of_the_needles_own_type() {
    let g = mixed();
    // Needle: the NUMBER 1 -> row 1 (payload 10).
    assert_eq!(num(&g, "=MATCH(1,A1:A4,0)"), 1.0);
    assert_eq!(num(&g, "=VLOOKUP(1,A1:B4,2,FALSE)"), 10.0);
    assert_eq!(num(&g, "=HLOOKUP(1,A6:D7,2,FALSE)"), 10.0);
    assert_eq!(num(&g, "=XLOOKUP(1,A1:A4,B1:B4)"), 10.0);
    // Needle: the TEXT "1" -> row 2 (payload 20).
    assert_eq!(num(&g, "=MATCH(\"1\",A1:A4,0)"), 2.0);
    assert_eq!(num(&g, "=VLOOKUP(\"1\",A1:B4,2,FALSE)"), 20.0);
    assert_eq!(num(&g, "=HLOOKUP(\"1\",A6:D7,2,FALSE)"), 20.0);
    assert_eq!(num(&g, "=XLOOKUP(\"1\",A1:A4,B1:B4)"), 20.0);
    // Needle: TRUE -> row 3 (payload 30). A boolean is its own class, so it
    // must not find the NUMBER 1 even though `=TRUE+0` is 1.
    assert_eq!(num(&g, "=MATCH(TRUE,A1:A4,0)"), 3.0);
    assert_eq!(num(&g, "=VLOOKUP(TRUE,A1:B4,2,FALSE)"), 30.0);
    assert_eq!(num(&g, "=HLOOKUP(TRUE,A6:D7,2,FALSE)"), 30.0);
    assert_eq!(num(&g, "=XLOOKUP(TRUE,A1:A4,B1:B4)"), 30.0);
    // ...and the `=` operator agrees that the three are mutually unequal, which
    // is the rule all twelve assertions above are an instance of.
    assert!(!boolean(&g, "=(A1=A2)"));
    assert!(!boolean(&g, "=(A1=A3)"));
    assert!(!boolean(&g, "=(A2=A3)"));
}

/// A needle whose TYPE is absent from the column finds nothing anywhere, rather
/// than being coerced into a neighbouring class.
#[test]
fn a_needle_of_an_absent_type_finds_nothing_on_any_surface() {
    let g = tiny(); // all numbers
    na(&g, "=MATCH(\"5\",A1:A4,0)");
    na(&g, "=VLOOKUP(\"5\",A1:B4,2,FALSE)");
    assert_eq!(
        eval(&g, "=XLOOKUP(\"5\",A1:A4,B1:B4,\"NF\")"),
        EvalResult::Text("NF".into())
    );
    // CONTROL: spelled as a NUMBER the same needle is found by all three, so
    // the column really does contain a 5.
    assert_eq!(num(&g, "=MATCH(5,A1:A4,0)"), 1.0);
    assert_eq!(num(&g, "=VLOOKUP(5,A1:B4,2,FALSE)"), 100.0);
    assert_eq!(num(&g, "=XLOOKUP(5,A1:A4,B1:B4)"), 100.0);
}

/// XLOOKUP'S BINARY SEARCH MODES navigate with the SORT comparator, which
/// reduces both sides through `as_number()` and therefore calls the text "5"
/// equal to the number 5. Landing on such a hit and returning it made
/// `search_mode` 2 disagree with `search_mode` 1 on identical data — one
/// function, one argument changed, two answers. The descent still uses the
/// ordering (a binary search has no choice); the LANDING is verified against
/// the exact predicate.
#[test]
fn xlookup_binary_search_agrees_with_its_own_linear_search() {
    let mut g = Grid::new();
    for (i, v) in [1.0, 3.0, 5.0, 7.0].iter().enumerate() {
        g.set_cell(i as u32, 0, Cell::new_number(*v));
        g.set_cell(i as u32, 1, Cell::new_number((i as f64 + 1.0) * 10.0));
    }
    // A text needle finds nothing in EITHER mode. `…,0,2)` used to answer 30.
    for mode in ["1", "2", "-1", "-2"] {
        let f = format!("=XLOOKUP(\"5\",A1:A4,B1:B4,\"NF\",0,{})", mode);
        assert_eq!(
            eval(&g, &f),
            EvalResult::Text("NF".into()),
            "search_mode {} crossed types",
            mode
        );
    }
    // CONTROL: the NUMBER needle is found in every mode, and finds the same
    // row, so the verification did not simply disable binary search.
    for mode in ["1", "2", "-1", "-2"] {
        let f = format!("=XLOOKUP(5,A1:A4,B1:B4,\"NF\",0,{})", mode);
        assert_eq!(num(&g, &f), 30.0, "search_mode {} lost the real match", mode);
    }
}

// ===================================================================
// 3. Text folds over full Unicode, on every surface
// ===================================================================

/// "Straße".to_uppercase() is "STRASSE" — a ONE-to-TWO character expansion that
/// `eq_ignore_ascii_case` cannot see. VLOOKUP alone used the ASCII fold, so it
/// was the only surface that answered #N/A here. Calcula ships Swedish by
/// default, which is why an ASCII-only fold is not an exotic edge case.
#[test]
fn every_exact_lookup_folds_case_over_full_unicode() {
    let mut g = Grid::new();
    g.set_cell(0, 0, Cell::new_text("Straße".to_string()));
    g.set_cell(0, 1, Cell::new_number(10.0));
    g.set_cell(1, 0, Cell::new_text("ÅKERBÄR".to_string()));
    g.set_cell(1, 1, Cell::new_number(20.0));
    assert!(boolean(&g, "=(\"STRASSE\"=A1)"));
    assert_eq!(num(&g, "=MATCH(\"STRASSE\",A1:A2,0)"), 1.0);
    assert_eq!(num(&g, "=VLOOKUP(\"STRASSE\",A1:B2,2,FALSE)"), 10.0);
    assert_eq!(num(&g, "=XLOOKUP(\"STRASSE\",A1:A2,B1:B2)"), 10.0);
    assert_eq!(num(&g, "=COUNTIF(A1:A2,\"STRASSE\")"), 1.0);
    // A Swedish word whose fold is one-to-one, in the other direction.
    assert_eq!(num(&g, "=MATCH(\"åkerbär\",A1:A2,0)"), 2.0);
    assert_eq!(num(&g, "=VLOOKUP(\"åkerbär\",A1:B2,2,FALSE)"), 20.0);
    assert_eq!(num(&g, "=XLOOKUP(\"åkerbär\",A1:A2,B1:B2)"), 20.0);
    // CONTROL: folding is not "everything matches" — a different word does not.
    na(&g, "=MATCH(\"STRASS\",A1:A2,0)");
    na(&g, "=VLOOKUP(\"STRASS\",A1:B2,2,FALSE)");
}

// ===================================================================
// 4. The pass cache answers exactly what the scan answers
// ===================================================================

/// THE CACHE MAY NEVER CHANGE AN ANSWER. `lookup_cache` builds an index per
/// range per recalc pass; whether a pass guard is held is an implementation
/// detail of the RECALC DRIVER, not of the formula, so a cached answer that
/// differs from a scanned one means the same workbook computes differently
/// depending on how it was opened — and unit tests, which hold no guard, would
/// never see it.
///
/// Every case here is run TWICE over the same grid: once with no guard (scan)
/// and once inside `begin_pass` (index), asserted equal to each other.
#[test]
fn the_pass_cache_and_the_scan_path_never_disagree() {
    let m = mixed();
    let t = tiny();
    let cases: &[(&Grid, &str)] = &[
        (&t, "=MATCH(1E-300,A1:A4,0)"),
        (&t, "=VLOOKUP(1E-300,A1:B4,2,FALSE)"),
        (&t, "=XLOOKUP(1E-300,A1:A4,B1:B4,\"NF\")"),
        (&t, "=MATCH(2E-300,A1:A4,0)"),
        (&t, "=VLOOKUP(2E-300,A1:B4,2,FALSE)"),
        (&t, "=XLOOKUP(2E-300,A1:A4,B1:B4,\"NF\")"),
        (&m, "=MATCH(\"1\",A1:A4,0)"),
        (&m, "=VLOOKUP(\"1\",A1:B4,2,FALSE)"),
        (&m, "=XLOOKUP(\"1\",A1:A4,B1:B4,\"NF\")"),
        (&m, "=MATCH(TRUE,A1:A4,0)"),
        (&m, "=VLOOKUP(TRUE,A1:B4,2,FALSE)"),
        (&m, "=XLOOKUP(TRUE,A1:A4,B1:B4,\"NF\")"),
        (&m, "=MATCH(\"APPLE\",A1:A4,0)"),
        (&m, "=VLOOKUP(\"APPLE\",A1:B4,2,FALSE)"),
        (&m, "=COUNTIF(A1:A4,1)"),
        (&m, "=COUNTIF(A1:A4,TRUE)"),
        (&m, "=COUNTIF(A1:A4,\">0\")"),
        (&m, "=SUMIF(A1:A4,1,B1:B4)"),
    ];
    for (grid, formula) in cases {
        let scanned = eval(grid, formula);
        let cached = {
            let _guard = crate::lookup_cache::begin_pass();
            eval(grid, formula)
        };
        assert_eq!(
            cached, scanned,
            "`{}` answered {:?} cached and {:?} scanned",
            formula, cached, scanned
        );
    }
}

// ===================================================================
// 5. The criteria family: one fixed TYPE rule, one pinned divergence
// ===================================================================

/// A LOGICAL IS NOT THE NUMBER 1 IN A CRITERION, and it was. Over the mixed
/// column `=COUNTIF(A1:A4,1)` answered 3 — the number, the text "1" AND TRUE —
/// where Excel answers 2. The cause was `criteria_number` falling through to
/// `as_number()`, the ARITHMETIC coercion, for a TYPE test.
///
/// The whole criteria family shares that reading, so all of them moved
/// together; each is asserted because each has its own collector and a fix
/// applied to COUNTIF alone would leave SUMIFS wrong and silent.
#[test]
fn a_logical_never_matches_a_numeric_criterion() {
    let g = mixed();
    // A1 = 1, A2 = "1", A3 = TRUE, A4 = "apple"; B = 10,20,30,40.
    assert_eq!(num(&g, "=COUNTIF(A1:A4,1)"), 2.0);
    assert_eq!(num(&g, "=COUNTIFS(A1:A4,1)"), 2.0);
    assert_eq!(num(&g, "=COUNTIF(A1:A4,\">0\")"), 2.0);
    assert_eq!(num(&g, "=COUNTIF(A1:A4,\">=1\")"), 2.0);
    // SUMIF/SUMIFS: 10 + 20 = 30. It was 60 — the TRUE row's 30 was included.
    assert_eq!(num(&g, "=SUMIF(A1:A4,1,B1:B4)"), 30.0);
    assert_eq!(num(&g, "=SUMIFS(B1:B4,A1:A4,1)"), 30.0);
    assert_eq!(num(&g, "=AVERAGEIF(A1:A4,1,B1:B4)"), 15.0);
    assert_eq!(num(&g, "=MAXIFS(B1:B4,A1:A4,1)"), 20.0);
    assert_eq!(num(&g, "=MINIFS(B1:B4,A1:A4,1)"), 10.0);
    // CONTROL — and it is the assertion that keeps the rule honest: a BOOLEAN
    // criterion still finds the boolean. The rule is "a logical is its own
    // class", not "logicals are invisible to COUNTIF".
    assert_eq!(num(&g, "=COUNTIF(A1:A4,TRUE)"), 1.0);
    assert_eq!(num(&g, "=SUMIF(A1:A4,TRUE,B1:B4)"), 30.0);
    assert_eq!(num(&g, "=COUNTIF(A1:A4,FALSE)"), 0.0);
    // ...and it is the same type-class rule the comparison operators enforce.
    assert!(!boolean(&g, "=(A3=1)"));
}

/// AN EXCEL DIVERGENCE THAT IS A DECISION, NOT AN INCONSISTENCY, pinned here so
/// it reads as one.
///
/// Excel's criteria genuinely DO coerce numeric text where the `=` operator
/// does not. `COUNTIF(rng,1)` counts a cell holding the TEXT "1"; `=(A1="1")`
/// is FALSE about the very same pair. Both lines are asserted together because
/// separately each looks like a bug in the other's direction, and someone
/// "unifying equality" would otherwise have no way to know that this pair is
/// supposed to disagree.
#[test]
fn criteria_coerce_numeric_text_where_the_equals_operator_does_not() {
    let g = mixed();
    // The criterion spelled as a number and as text behave identically, and
    // both count the NUMBER 1 and the TEXT "1".
    assert_eq!(num(&g, "=COUNTIF(A1:A4,1)"), 2.0);
    assert_eq!(num(&g, "=COUNTIF(A1:A4,\"1\")"), 2.0);
    // The operator says those two cells are NOT the same value...
    assert!(!boolean(&g, "=(A1=A2)"));
    // ...and neither does the exact-match LOOKUP family, which follows the
    // operator rather than the criteria: three surfaces, three different rows.
    assert_eq!(num(&g, "=MATCH(1,A1:A4,0)"), 1.0);
    assert_eq!(num(&g, "=MATCH(\"1\",A1:A4,0)"), 2.0);
}

/// KNOWN DIVERGENCES IN THE CRITERIA FAMILY, MEASURED 2026-08-24 AND LEFT
/// STANDING. Both are recorded at the CURRENT answer so that a later fix has to
/// state its intent, and so neither is mistaken for the type rule above.
///
///   1. THE NUMERIC TOLERANCE IS STILL 1e-10, ABSOLUTE. `COUNTIF(rng,1E-300)`
///      counts a cell holding 2E-300 — the same absolute-tolerance defect the
///      exact-match paths were just cured of. It is NOT simply "make it exact":
///      Excel's criteria really do have a tolerance, a RELATIVE one at 15
///      significant digits, which is why `COUNTIF(rng,0.3)` matches a cell
///      holding `=0.1+0.2` in Excel while `=(0.1+0.2=0.3)` is FALSE there. Both
///      `==` and 1e-10-absolute are wrong; getting it right means implementing
///      the 15-digit rounding, which is a different change from this one.
///
///   2. `"<>n"` IS A NUMERIC TEST, NOT A NEGATION. `COUNTIF(rng,"<>1")` over
///      {1, "1", TRUE, "apple"} answers 0 because the matcher requires the cell
///      to read as a number before comparing; Excel answers 2 (TRUE and
///      "apple"). Unchanged by this work — it answered 0 before the type rule
///      too — and it needs its own decision about blanks, which is why it is
///      pinned rather than patched in passing.
#[test]
fn the_criteria_divergences_left_standing_are_recorded_here() {
    let t = tiny();
    assert_eq!(
        num(&t, "=COUNTIF(A1:A4,1E-300)"),
        1.0,
        "criteria still use a 1e-10 ABSOLUTE tolerance; Excel rounds to 15 \
         significant digits. See this test's doc before changing it"
    );
    // ...while the exact-match family, on the same column, refuses.
    na(&t, "=MATCH(1E-300,A1:A4,0)");

    // `"<>n"` is now Excel's NEGATION and lives in `criteria_negation_tests`.
    // The complement control stays here, where the exact-match family can be
    // seen agreeing with it on the same column.
    let m = mixed();
    assert_eq!(
        num(&m, "=COUNTIF(A1:A4,\"<>1\")"),
        2.0,
        "the negation and the equality must stay complements of each other"
    );
    // The positive form it is the complement of.
    assert_eq!(num(&m, "=COUNTIF(A1:A4,1)"), 2.0);
}

// ===================================================================
// 6. The predicate itself, directly
// ===================================================================

/// `exact_lookup_equal` asserted without a formula around it, so a failure says
/// which PAIR disagrees rather than which function did.
///
/// The relation must be an EQUIVALENCE — reflexive, symmetric — which the old
/// epsilon predicates were not: with a tolerance, equality is NOT transitive
/// (1.0 ≈ 1.00000000005 ≈ 1.0000000001, but the ends are 1e-10 apart), and a
/// non-transitive "equality" underneath a first-match index means the answer
/// depends on scan order.
#[test]
fn the_shared_predicate_is_an_equivalence_and_never_crosses_types() {
    let vals = [
        EvalResult::Number(1.0),
        EvalResult::Text("1".into()),
        EvalResult::Boolean(true),
        EvalResult::Text("apple".into()),
        EvalResult::Number(0.0),
        EvalResult::Boolean(false),
        EvalResult::Blank,
        EvalResult::Text("".into()),
    ];
    for a in &vals {
        for b in &vals {
            assert_eq!(
                Evaluator::exact_lookup_equal(a, b),
                Evaluator::exact_lookup_equal(b, a),
                "asymmetric for {:?} / {:?}",
                a,
                b
            );
        }
    }
    // Reflexive for everything with a rung. A BLANK has none, and deliberately
    // does not equal itself here: an empty cell in a key column must not match
    // a needle of 0, which is exactly what `=A1=0` (TRUE) would have given if
    // the lookup reused `=`'s blank resolution.
    for v in &vals {
        let expect = !matches!(v, EvalResult::Blank);
        assert_eq!(
            Evaluator::exact_lookup_equal(v, v),
            expect,
            "reflexivity wrong for {:?}",
            v
        );
    }
    // Transitivity, which an epsilon predicate breaks: the two outer values are
    // 1e-10 apart, so under the discarded VLOOKUP rule each was equal to the
    // middle one but they were not equal to each other.
    let (lo, mid, hi) = (
        EvalResult::Number(1.0),
        EvalResult::Number(1.000_000_000_05),
        EvalResult::Number(1.000_000_000_1),
    );
    assert!(!Evaluator::exact_lookup_equal(&lo, &mid));
    assert!(!Evaluator::exact_lookup_equal(&mid, &hi));
    assert!(!Evaluator::exact_lookup_equal(&lo, &hi));
    // Cross-class pairs are never equal, in both directions.
    assert!(!Evaluator::exact_lookup_equal(
        &EvalResult::Number(1.0),
        &EvalResult::Text("1".into())
    ));
    assert!(!Evaluator::exact_lookup_equal(
        &EvalResult::Number(1.0),
        &EvalResult::Boolean(true)
    ));
    assert!(!Evaluator::exact_lookup_equal(
        &EvalResult::Number(0.0),
        &EvalResult::Boolean(false)
    ));
    // ...and within a class it really does say yes, so "never equal" is not the
    // whole story.
    assert!(Evaluator::exact_lookup_equal(
        &EvalResult::Text("Straße".into()),
        &EvalResult::Text("STRASSE".into())
    ));
    assert!(Evaluator::exact_lookup_equal(
        &EvalResult::Number(-0.0),
        &EvalResult::Number(0.0)
    ));
}
