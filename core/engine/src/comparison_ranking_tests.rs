//! FILENAME: core/engine/src/comparison_ranking_tests.rs
//! PURPOSE: Excel's TYPE RANKING for the six comparison operators, plus the two
//! equality sites that inherited the old numeric tolerance.
//!
//! THE RULE. A comparison ranks its operands by TYPE CLASS FIRST and only
//! compares values inside the same class:
//!
//!     number  <  text  <  FALSE  <  TRUE
//!
//! Any text outranks any number, any boolean outranks any text, and within text
//! the compare is case-INSENSITIVE. This ranking is a COMPARISON rule only —
//! arithmetic still coerces text to number — which is why every ladder case here
//! is paired with an arithmetic control that must give the OTHER answer.
//!
//! WHAT WAS SILENTLY WRONG. All five operators reduced both operands through
//! `as_number()`, whose Text arm calls `parse::<f64>()`. That produced three
//! different flavours of wrong answer from one cause, and no single case would
//! have exposed all three:
//!   - numeric-looking text compared as a NUMBER: `="1"=1` was TRUE, `=1<>"1"`
//!     was FALSE, `=2>"1"` was TRUE, `=1&2=12` was TRUE (`&` yields the TEXT
//!     "12", which cannot equal a number);
//!   - non-numeric text had no numeric branch to fall onto, so `="a">1` and
//!     `=1>"a"` were `#VALUE!` where Excel answers TRUE and FALSE — an ERROR
//!     spreading through whatever consumed it, which is how `=SUM(--(A1:A4>0))`
//!     over a column holding one word became `#VALUE!` instead of a count;
//!   - booleans compared as 1/0, so a CHAINED comparison silently re-entered as
//!     a number: `=1<2<3` was TRUE and `=3>2>1` was FALSE, both the opposite of
//!     Excel, because Excel ranks the intermediate TRUE above every number.
//!
//! WHY THE CHAINS GET THEIR OWN CASES. They are the reason the boolean rung is
//! load-bearing rather than academic: a user writing `=1<2<3` gets a plausible
//! TRUE and no error, and the two chains are asserted TOGETHER because they must
//! disagree with each other — a fix that made both TRUE, or both FALSE, would be
//! equally wrong and a single case could not tell.
//!
//! EQUALITY IS EXACT. `=` used an ABSOLUTE tolerance of `f64::EPSILON` (2.22e-16)
//! and `MATCH(...,0)` a coarser `1e-10`. An absolute tolerance is finer than the
//! float spacing above magnitude ~1 (so it never did anything there) and simply
//! wrong below it: `=1E-300=2E-300` was TRUE, `=1E-300=0` was TRUE, and MATCH
//! found rows the `=` operator called unequal.

use crate::cell::{Cell, CellError, CellValue};
use crate::evaluator::{EvalResult, Evaluator};
use crate::grid::Grid;

fn eval(grid: &Grid, formula: &str) -> EvalResult {
    let ast = parser::parse(formula).expect("formula parses");
    Evaluator::new(grid).evaluate(&ast)
}

/// Asserts a formula answers a specific boolean — never merely "not an error",
/// because the old code answered a plausible boolean for most of these.
fn boolean(grid: &Grid, formula: &str) -> bool {
    match eval(grid, formula) {
        EvalResult::Boolean(b) => b,
        other => panic!("{} gave {:?}, expected a boolean", formula, other),
    }
}

fn num(grid: &Grid, formula: &str) -> f64 {
    match eval(grid, formula) {
        EvalResult::Number(n) => n,
        other => panic!("{} gave {:?}, expected a number", formula, other),
    }
}

fn empty() -> Grid {
    Grid::new()
}

/// A1=1 (number), A2="1" (text), A3=TRUE, A4="apple", A5 ABSENT (blank).
/// B1 is PRESENT holding `CellValue::Empty` — the second spelling of blank.
fn mixed_column() -> Grid {
    let mut g = Grid::new();
    g.set_cell(0, 0, Cell::new_number(1.0));
    g.set_cell(1, 0, Cell::new_text("1".to_string()));
    g.set_cell(2, 0, Cell::new_boolean(true));
    g.set_cell(3, 0, Cell::new_text("apple".to_string()));
    let mut present_but_empty = Cell::new_number(0.0);
    present_but_empty.value = CellValue::Empty;
    g.set_cell(0, 1, present_but_empty);
    g
}

// ---------------------------------------------------------------------------
// 1. The seven reported defects, each with Excel's answer
// ---------------------------------------------------------------------------

/// Numeric-looking TEXT is still text. Every one of these answered the opposite
/// before, because `as_number()` parsed `"1"` into 1 and the comparison never
/// learned the operand had been text.
#[test]
fn numeric_text_never_equals_a_number() {
    let g = empty();
    assert!(!boolean(&g, "=\"1\"=1"), "text \"1\" must not equal the number 1");
    assert!(boolean(&g, "=1<>\"1\""), "<> must agree with = inverted");
    // `&` YIELDS TEXT. This is the case that shows the defect is not about
    // literals: nothing in `=1&2=12` is written as a string, yet the left side
    // is the text "12" and cannot equal a number.
    assert!(!boolean(&g, "=1&2=12"));
    // CONTROL: text really does equal text, case-insensitively, so the fix is
    // not "everything cross-type is false" applied too widely.
    assert!(boolean(&g, "=1&2=\"12\""));
}

/// ANY text outranks ANY number, in BOTH directions. Asserted as a pair because
/// a fix that made both TRUE (or both FALSE) would satisfy either half alone.
#[test]
fn any_text_outranks_any_number() {
    let g = empty();
    assert!(boolean(&g, "=\"1\">2"), "text outranks a number even when it looks smaller");
    assert!(!boolean(&g, "=2>\"1\""));
    // The same with text that does not parse at all — this pair used to be
    // #VALUE! rather than a wrong boolean, a different symptom of one cause.
    assert!(boolean(&g, "=\"a\">1"));
    assert!(!boolean(&g, "=1>\"a\""));
    // The magnitude genuinely does not matter: the class decides first.
    assert!(boolean(&g, "=\"a\">1E308"));
    assert!(boolean(&g, "=\"0\">1E308"));
}

/// CHAINED COMPARISONS. The intermediate is a BOOLEAN and a boolean outranks
/// every number, so the two chains must give OPPOSITE answers. Excel: FALSE and
/// TRUE. Calcula gave TRUE and FALSE — both wrong, and both plausible.
#[test]
fn a_chained_comparison_ranks_its_intermediate_boolean_above_numbers() {
    let g = empty();
    // (1<2) is TRUE; TRUE < 3 is FALSE because TRUE outranks 3.
    assert!(!boolean(&g, "=1<2<3"));
    // (3>2) is TRUE; TRUE > 1 is TRUE for the same reason.
    assert!(boolean(&g, "=3>2>1"));
    // The rung itself, without the chain sugar.
    assert!(boolean(&g, "=TRUE>1000"));
    assert!(!boolean(&g, "=1000>TRUE"));
}

// ---------------------------------------------------------------------------
// 2. The ladder as a whole
// ---------------------------------------------------------------------------

/// The full ordering `number < text < FALSE < TRUE`, walked rung by rung in both
/// directions. Every cross-class pair is asserted twice so an implementation
/// that returned a constant cannot pass.
#[test]
fn the_type_ranking_is_number_then_text_then_false_then_true() {
    let g = empty();
    // number < text
    assert!(boolean(&g, "=1<\"a\""));
    assert!(!boolean(&g, "=\"a\"<1"));
    // text < boolean — BOTH booleans, because FALSE is a rung above all text
    // even though FALSE coerces to the number 0.
    assert!(boolean(&g, "=\"z\"<FALSE"));
    assert!(!boolean(&g, "=FALSE<\"z\""));
    assert!(boolean(&g, "=\"z\"<TRUE"));
    // FALSE < TRUE
    assert!(boolean(&g, "=FALSE<TRUE"));
    assert!(!boolean(&g, "=TRUE<FALSE"));
    // number < boolean, transitively
    assert!(boolean(&g, "=1<FALSE"));
    // Cross-class pairs are never EQUAL, which is what makes `=TRUE=1` FALSE
    // even though `=TRUE+0` is 1.
    assert!(!boolean(&g, "=TRUE=1"));
    assert!(!boolean(&g, "=FALSE=0"));
    assert!(!boolean(&g, "=\"\"=0"));
}

/// Within a class the VALUE decides, and all four ordering operators agree with
/// `=` about it. The `<=`/`>=` pair matters on its own: they must accept the
/// Equal ordering that `<`/`>` reject.
#[test]
fn within_a_class_the_value_decides() {
    let g = empty();
    // Text is case-INSENSITIVE.
    assert!(boolean(&g, "=\"A\"=\"a\""));
    assert!(boolean(&g, "=\"A\"<\"b\""));
    assert!(!boolean(&g, "=\"A\"<\"a\""));
    assert!(boolean(&g, "=\"A\"<=\"a\""));
    assert!(boolean(&g, "=\"A\">=\"a\""));
    // ...but NOT numeric-insensitive: "1" and "1.0" are different strings.
    assert!(!boolean(&g, "=\"1\"=\"1.0\""));
    // Numbers.
    assert!(boolean(&g, "=1<=1"));
    assert!(boolean(&g, "=1>=1"));
    assert!(!boolean(&g, "=1<1"));
    // Booleans.
    assert!(boolean(&g, "=TRUE>=TRUE"));
    assert!(boolean(&g, "=FALSE<=TRUE"));
}

/// The ranking applies to values read from CELLS, not just to literals — the
/// parser is not doing the typing. `=A3>A4` (TRUE vs "apple") and `=A4>A1`
/// ("apple" vs 1) were both `#VALUE!` before.
#[test]
fn the_ranking_applies_to_values_read_from_cells() {
    let g = mixed_column();
    assert!(!boolean(&g, "=A1=A2"), "number 1 vs text \"1\"");
    assert!(boolean(&g, "=A2>A1"), "text outranks number");
    assert!(!boolean(&g, "=A1>A2"));
    assert!(boolean(&g, "=A3>A4"), "TRUE outranks text");
    assert!(boolean(&g, "=A4>A1"), "text outranks number");
}

// ---------------------------------------------------------------------------
// 3. Controls — what the ranking must NOT touch
// ---------------------------------------------------------------------------

/// ARITHMETIC STILL COERCES. This is the control for the whole file: the ladder
/// is a comparison rule, and routing arithmetic through it would turn `="1"+1`
/// into `#VALUE!`. Direct-argument coercion in the aggregates is asserted here
/// too, because it is the same `as_number()` the operators stopped using.
#[test]
fn arithmetic_still_coerces_text_and_logicals_to_numbers() {
    let g = empty();
    assert_eq!(num(&g, "=\"1\"+1"), 2.0);
    assert_eq!(num(&g, "=\"2\"*\"3\""), 6.0);
    assert_eq!(num(&g, "=TRUE+1"), 2.0);
    assert_eq!(num(&g, "=-TRUE"), -1.0);
    // Directly-typed arguments coerce; this is the rule the `--(...)` idiom
    // exists to work around for the array/reference case.
    assert_eq!(num(&g, "=SUM(1,\"2\",TRUE)"), 4.0);
}


/// BLANK COMPARISONS. A blank adopts the type it is compared against — 0 / "" /
/// FALSE — which is why `=A5=0` and `=A5=""` are BOTH true for one empty cell
/// while `=""=0` is false. The ladder runs AFTER that resolution, so it must
/// leave every one of these alone. Both spellings of blank are asserted: A5 is
/// absent from the grid, B1 is present holding `CellValue::Empty`.
#[test]
fn blank_still_adopts_the_type_it_is_compared_against() {
    let g = mixed_column();
    assert!(boolean(&g, "=A5=0"));
    assert!(boolean(&g, "=A5=\"\""));
    assert!(boolean(&g, "=A5=FALSE"));
    assert!(boolean(&g, "=B1=0"));
    assert!(boolean(&g, "=B1=\"\""));
    assert!(boolean(&g, "=B1=FALSE"));
    // The famous asymmetry: "" is only text, so it is not 0.
    assert!(!boolean(&g, "=\"\"=0"));
    // Ordering against each class, all three of which used to be #VALUE! or
    // wrong before blanks were resolved first.
    assert!(boolean(&g, "=A5<\"a\""), "blank is \"\" against text");
    assert!(boolean(&g, "=A5>-1"), "blank is 0 against a number");
    assert!(boolean(&g, "=A5<TRUE"), "blank is FALSE against a boolean");
    // Two blanks are equal.
    assert!(boolean(&g, "=A5=A6"));
}

/// CRITERIA ARE A DIFFERENT PATH WITH DIFFERENT RULES, and the ladder must not
/// reach it. `parse_criteria`/`matches_criteria` turn a criterion into a number
/// and apply it with `as_number()`; Excel's criteria genuinely DO coerce numeric
/// text, so `COUNTIF(range,"1")` still finds a cell holding the NUMBER 1 even
/// though `=A1="1"` is now FALSE. That contrast is the point of this test: the
/// two paths are supposed to disagree.
///
/// The load-bearing assertion is "apple". Under the ladder it outranks 0, so a
/// `">0"` criterion routed through the new rule would count it; a count that
/// excludes it is the proof that the criteria path was left alone.
///
/// REWRITTEN 2026-08-24 — THE BOOLEAN COUNTS CHANGED, AND THEY WERE WRONG.
/// This test used to assert that the LOGICAL cell is counted by a numeric
/// criterion. It is not, in Excel, and it is not here any more:
///
/// ```text
///                          OLD (asserted)   NEW (asserted)   Excel
///   =COUNTIF(A1:A4,1)          3.0              2.0            2
///   =COUNTIF(A1:A4,"1")        3.0              2.0            2
///   =COUNTIF(A1:A4,">0")       3.0              2.0            (see below)
///   =SUMIF(A1:A4,">0")         3.0              2.0
/// ```
///
/// The cause was `criteria_number` reaching `as_number()`, which renders TRUE
/// as 1 — the ARITHMETIC coercion, applied to a TYPE test. It is the same
/// type-class rule the ladder above encodes, arriving in the criteria family.
///
/// WHAT DID NOT CHANGE, and is the point of keeping this test here: the criteria
/// path still coerces numeric TEXT, so `COUNTIF(rng,1)` counts the cell holding
/// the text "1" while `=A1="1"` is FALSE. Those two lines sit next to each other
/// deliberately — the divergence is Excel's own, not an inconsistency.
///
/// STILL DIVERGENT, deliberately and unchanged: Excel's `COUNTIF(A1:A4,">0")`
/// over this fixture is 1, because Excel does not coerce range TEXT for a
/// COMPARISON criterion the way it does for an equality one. Calcula answers 2.
/// That is a pre-existing text-coercion question, not the boolean type rule this
/// change is about, and it is recorded here so a later fix has to state its
/// intent rather than discover the number.
#[test]
fn criteria_matching_was_not_routed_through_the_ladder() {
    let g = mixed_column();
    // A1 = number 1, A2 = text "1", A3 = TRUE, A4 = "apple".
    // Both spellings of the criterion behave identically — criteria coerce TEXT.
    assert_eq!(num(&g, "=COUNTIF(A1:A4,1)"), 2.0);
    assert_eq!(num(&g, "=COUNTIF(A1:A4,\"1\")"), 2.0);
    // ...while the `=` operator says the two are NOT the same value. The
    // criteria path and the operator are allowed to disagree; this pins that
    // they still do, in the direction Excel wants.
    assert!(!boolean(&g, "=A1=\"1\""));
    // THE LOGICAL IS NOT A NUMBER. A3 holds TRUE; neither the equality
    // criterion nor the comparison one may see it as 1.
    assert_eq!(num(&g, "=COUNTIF(A1:A4,\">0\")"), 2.0);
    assert_eq!(num(&g, "=SUMIF(A1:A4,\">0\")"), 2.0);
    // CONTROL: a BOOLEAN criterion still finds it, so the rule is "a boolean is
    // its own class" and not "booleans are invisible to COUNTIF".
    assert_eq!(num(&g, "=COUNTIF(A1:A4,TRUE)"), 1.0);
    assert_eq!(num(&g, "=COUNTIF(A1:A4,FALSE)"), 0.0);
    // "apple" is NOT counted: the criterion is a number test, not a ranking.
    // (Under the ladder "apple" outranks 0, so a `">0"` routed through the
    // comparison rule would have counted it.)
    assert_eq!(num(&g, "=COUNTIF(A1:A4,\"apple\")"), 1.0);
    assert_eq!(num(&g, "=COUNTIF(A1:A4,\"APPLE\")"), 1.0);
}

/// ARRAY LIFTING. `=A1:A4>1` must still produce an ARRAY of booleans, and the
/// `--(...)` idiom must still fold it. This also pins a real improvement: the
/// fourth cell holds "apple", whose comparison used to be `#VALUE!` and poisoned
/// the whole SUM. Now it ranks above every number, so the count is 4.
#[test]
fn comparisons_still_lift_over_arrays() {
    let g = mixed_column();
    match eval(&g, "=A1:A4>0") {
        EvalResult::Array(items) => {
            assert_eq!(items.len(), 4);
            for (i, item) in items.iter().enumerate() {
                assert_eq!(
                    item,
                    &EvalResult::Boolean(true),
                    "element {} should be TRUE: 1>0, \"1\" and \"apple\" outrank 0, TRUE outranks 0",
                    i
                );
            }
        }
        other => panic!("=A1:A4>0 gave {:?}, expected an array", other),
    }
    assert_eq!(num(&g, "=SUM(--(A1:A4>0))"), 4.0);
    // A CONTROL that must NOT be all-true, so "everything is TRUE now" cannot
    // satisfy the assertion above: only the number 1 fails to outrank 5.
    assert_eq!(num(&g, "=SUM(--(A1:A4>5))"), 3.0);
}

/// IF and the logical functions read a comparison's BOOLEAN, so they inherit the
/// ranking rather than implementing it. `=IF("1"=1,...)` used to take the true
/// branch.
#[test]
fn if_and_logicals_follow_the_ranking() {
    let g = empty();
    assert_eq!(eval(&g, "=IF(\"1\"=1,\"eq\",\"ne\")"), EvalResult::Text("ne".into()));
    assert_eq!(eval(&g, "=IF(\"a\">1,\"eq\",\"ne\")"), EvalResult::Text("eq".into()));
    assert!(boolean(&g, "=AND(\"a\">1,TRUE>\"a\")"));
    assert!(!boolean(&g, "=OR(\"1\"=1,2>\"1\")"));
}

/// AN ERROR OPERAND PROPAGATES, and the LEFT-MOST error wins. The ladder never
/// sees an error — it is short-circuited above — and this pins that it stays
/// that way rather than an error falling into the "no rung" `#VALUE!` arm.
#[test]
fn an_error_operand_still_propagates_leftmost_first() {
    let g = empty();
    assert_eq!(eval(&g, "=1/0=1"), EvalResult::Error(CellError::Div0));
    assert_eq!(eval(&g, "=1=1/0"), EvalResult::Error(CellError::Div0));
    // Left-most wins: #DIV/0! is on the left of #N/A.
    assert_eq!(eval(&g, "=(1/0)>NA()"), EvalResult::Error(CellError::Div0));
    assert_eq!(eval(&g, "=NA()>(1/0)"), EvalResult::Error(CellError::NA));
}

// ---------------------------------------------------------------------------
// 4. Numeric equality is EXACT
// ---------------------------------------------------------------------------

/// `=` compared with an ABSOLUTE tolerance of `f64::EPSILON` (2.22e-16). Below
/// magnitude 1 that is enormous, so genuinely different numbers tested equal —
/// and a number tested equal to ZERO. Excel's `=` compares the stored doubles.
#[test]
fn numeric_equality_is_exact_not_epsilon() {
    let g = empty();
    assert!(!boolean(&g, "=1E-300=2E-300"), "two different tiny numbers are not equal");
    assert!(!boolean(&g, "=1E-300=0"), "a tiny number is not zero");
    assert!(boolean(&g, "=1E-300<>0"));
    // The ordering operators agree, and did NOT have the tolerance — so this
    // pair is the control that `=` was the odd one out.
    assert!(boolean(&g, "=1E-300>0"));
    assert!(boolean(&g, "=2E-300>1E-300"));
    // CONTROLS: exact equality is still equality.
    assert!(boolean(&g, "=1=1"));
    assert!(boolean(&g, "=1E-300=1E-300"));
    assert!(boolean(&g, "=0=-0"), "IEEE says +0 and -0 are equal, and so does Excel");
    // Above magnitude 1 the tolerance was finer than the float spacing, so it
    // never changed an answer there — asserted so a future "let's add a relative
    // epsilon" reads as the behaviour change it would be.
    assert!(!boolean(&g, "=1000000=1000001"));
}

// ---------------------------------------------------------------------------
// 5. MATCH type 0 — the second equality site
// ---------------------------------------------------------------------------

/// `MATCH(...,0)` used `|a-b| < 1e-10`, five orders of magnitude COARSER than
/// the `=` operator's tolerance. It therefore found rows that Calcula's own `=`
/// says are not equal — a silent wrong ROW, not a rounding nicety.
#[test]
fn match_exact_uses_exact_number_equality() {
    let g = empty();
    // The row MATCH used to return, next to the `=` that disagrees with it.
    assert_eq!(eval(&g, "=MATCH(1E-300,{2E-300;5},0)"), EvalResult::Error(CellError::NA));
    assert!(!boolean(&g, "=(1E-300=2E-300)"));
    // A tolerance-sized gap inside the OLD 1e-10 window, at a magnitude where
    // the difference is unambiguous.
    assert_eq!(eval(&g, "=MATCH(1E-11,{2E-11;5},0)"), EvalResult::Error(CellError::NA));
    // CONTROLS: an exact hit is still found, at the right index, and the type
    // classes stay separate.
    assert_eq!(num(&g, "=MATCH(1E-300,{5;1E-300},0)"), 2.0);
    assert_eq!(num(&g, "=MATCH(2,{1;2;3},0)"), 2.0);
    assert_eq!(eval(&g, "=MATCH(\"1\",{1;2},0)"), EvalResult::Error(CellError::NA));
    assert_eq!(num(&g, "=MATCH(TRUE,{1;TRUE},0)"), 2.0);
}

/// THE SAME QUESTION ASKED THROUGH THE PASS CACHE. `match_cached` answers from
/// `EqFamily::Match`, which mirrors `eval_values_equal` by hand — so the two can
/// drift, and then one formula gives two answers depending on whether a recalc
/// pass guard happens to be held. The fast path needs a LITERAL RANGE (not an
/// array constant), so this fixture writes cells.
#[test]
fn match_exact_agrees_with_itself_through_the_pass_cache() {
    let mut g = Grid::new();
    g.set_cell(0, 0, Cell::new_number(2e-300));
    g.set_cell(1, 0, Cell::new_number(5.0));
    g.set_cell(2, 0, Cell::new_number(1e-300));

    // Scan path: no guard held, so `with_active` returns None.
    assert_eq!(num(&g, "=MATCH(1E-300,A1:A3,0)"), 3.0);
    assert_eq!(eval(&g, "=MATCH(3E-300,A1:A3,0)"), EvalResult::Error(CellError::NA));

    // Cached path: identical answers, or the cache is lying.
    let _pass = crate::lookup_cache::begin_pass();
    assert_eq!(num(&g, "=MATCH(1E-300,A1:A3,0)"), 3.0);
    assert_eq!(eval(&g, "=MATCH(3E-300,A1:A3,0)"), EvalResult::Error(CellError::NA));
    // Repeat, so the second call is served from the BUILT index rather than
    // building it — the two are different code paths inside `first_match`.
    assert_eq!(num(&g, "=MATCH(1E-300,A1:A3,0)"), 3.0);
    assert_eq!(num(&g, "=MATCH(5,A1:A3,0)"), 2.0);
}
