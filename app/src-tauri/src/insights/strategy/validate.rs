//! FILENAME: app/src-tauri/src/insights/strategy/validate.rs
// PURPOSE: Refuse a strategy document that would make the insights engine lie,
//          warn about one that has merely gone stale, and run the consultant's
//          own inline assertions so their file gates itself.
// CONTEXT: The severity split is the design, not decoration.
//
//          THE RULE, AND IT IS A TEST YOU CAN RUN AT EACH SITE:
//
//              A document that, SAVED AS IS, would make a fact WRONG or
//              SILENTLY WITHHELD is an ERROR.
//              A document that would only make a fact LESS GOOD is a WARNING.
//
//          The operational form of it - the question to ask before adding a
//          finding - is: does the state this finding describes change what the
//          PLANNER EMITS? If the document with the defect and the document
//          without it produce byte-identical facts, it cannot be an error no
//          matter how bad it looks. Two severity consumers act on the answer and
//          both are Error-only: `is_refused` gates the `set` write in
//          `bi::model_editor`, and the .calp publish gate in `calp_commands`
//          refuses to ship a document with an error to subscribers who cannot
//          fix it. Every warning below therefore SAVES and PUBLISHES, which is
//          the whole reason inflating one is not a free move.
//
//          An ERROR is a document that would produce a STATEMENT THAT IS WRONG:
//          a rule pointing at a measure that no longer exists, a rule scoped on
//          an invoice id, `lowerIsBetter` on a measure whose own KPI bands run
//          the other way, two equal-specificity rules whose winner is decided by
//          iteration order. None of those degrade gracefully - each one puts a
//          confident sentence in front of a reader, and the sentence is false.
//
//          A WARNING is a document that has gone STALE or is UNFINISHED: an entry
//          for a deleted measure, `reviewed: false`, a member that was renamed.
//          The engine still says only true things; it just says less than the
//          author intended.
//
//          WHAT IS *NOT* CHECKED HERE, AND WHY. A whole class of malformed value
//          - a `suppress` entry nobody emits, a date bound that is not ISO-8601,
//          a fiscal year start that is not MM-DD, a currency that is not
//          ISO-4217 - no longer reaches this file at all: those are TYPES in
//          types.rs with validating `Deserialize` impls, so serde refuses the
//          document before a `StrategyDoc` exists. A check here would be
//          unreachable code pretending to be a guard. Prefer the type; add a
//          finding only for what a well-formed document can still get wrong.
//
//          THE INLINE TESTS ARE WHY THIS FILE HAS TEETH. A consultant writes
//          "Returns in the Refunds department, up 5000, must come out favourable,
//          and rule 'refunds-dept' must be what decided it" and that assertion is
//          re-run against the resolver on every validation. Asserting the reason
//          as well as the answer is the point: a test that only checks the answer
//          passes for the wrong reason as soon as an unrelated rule starts winning.

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};

use super::facts::{authored_table_kinds, effective_date_table, AuthoredKinds, KindRefusal};
use super::overlap::check_overlaps;
use super::resolve::{point_from_scope, resolve, CalendarSource, ModelFacts, ResolvedMeasure};
use super::types::{
    Additivity, AggregationSpec, Attribute, BandBounds, Direction, ExpectedStatus, IsoDate,
    Materiality, QualifiedColumn, Role, Scope, ScopeValue, StrategyDoc, TableKind, Target,
    TestGiven, MAX_STRATEGY_DOC_BYTES, STRATEGY_DOC_VERSION,
};
// THE PLANNER'S OWN GATES, imported rather than reimplemented. Everything this
// file says about a hypothetical movement is decided by the same two functions a
// shipped report is decided by; see `judge_once`.
use crate::insights::model::{clears_materiality, favourability_at, Favourability};

/// Is this column a level of ANY hierarchy — the model's own, or one the
/// document declares?
///
/// The union, and not just the document's copy. `TableStrategy::hierarchies` is
/// written by `infer`; a document a person wrote by hand, or one written before
/// a hierarchy was added to the model, carries none — and scoping a rule on a
/// real hierarchy level was being refused as `scope-column-role` in exactly that
/// case. Consulting both can only turn a refusal into a pass.
fn in_a_hierarchy(facts: &ModelFacts, doc: &StrategyDoc, col: &QualifiedColumn) -> bool {
    doc.in_a_hierarchy(col) || facts.in_a_hierarchy(col)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Severity {
    /// The document must be refused.
    Error,
    /// The document applies, but something has gone stale or is unfinished.
    Warning,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Finding {
    pub severity: Severity,
    /// A stable kebab-case code, so a UI can group and a test can assert on
    /// something other than prose.
    pub code: String,
    /// Where in the document, e.g. `rules[2].scope` or `measures['Revenue']`.
    pub path: String,
    pub message: String,
}

impl Finding {
    fn error(code: &str, path: String, message: String) -> Self {
        Self {
            severity: Severity::Error,
            code: code.to_string(),
            path,
            message,
        }
    }

    fn warning(code: &str, path: String, message: String) -> Self {
        Self {
            severity: Severity::Warning,
            code: code.to_string(),
            path,
            message,
        }
    }
}

/// Does any finding refuse the document?
pub fn is_refused(findings: &[Finding]) -> bool {
    findings.iter().any(|f| f.severity == Severity::Error)
}

// ---------------------------------------------------------------------------
// Inline tests
// ---------------------------------------------------------------------------

/// What the resolver actually said about a hypothetical movement.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TestOutcome {
    pub status: ExpectedStatus,
    /// The rule that produced the outcome, when a rule did.
    pub decided_by: Option<String>,
}

/// A verdict, INCLUDING every state `ExpectedStatus` cannot express.
///
/// THE DEFECT BEHIND THE WHOLE VACUOUS-TEST FAMILY, and it was `Neutral` doing
/// the work of several different states. `judge` used to be a TOTAL function
/// into `ExpectedStatus`, so every path that could not decide something
/// collapsed into `Neutral` - and the planner does not do that:
///
///   * `favourability_at` returns `Option<Favourability>`, narrates `None` as
///     ", with no favourability claim" and reports it as "No claim". That is
///     `NoClaim` here, and no `ExpectedStatus` can name it: a test written
///     against such a point cannot assert anything, so it is REFUSED.
///   * below the materiality floor `facts_for_measure` builds no `Change` fact,
///     so nothing there carries a favourability for a word like "neutral" to
///     qualify. That is `ExpectedStatus::Immaterial`, which a test CAN assert,
///     because pinning the floor is a thing a consultant legitimately wants to
///     state. (The numbers themselves are still printed - see `judge_once`.)
///   * a point can also carry TWO judgements, or one whose word this file
///     cannot know. Neither is assertable either, and both used to be answered
///     with a confident single word.
///
/// Folding any of them into `neutral` produced the worst failure available in
/// the one artifact a consultant is asked to trust: a green tick meaning absence
/// of evidence.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Verdict {
    /// The engine states this about the point.
    Claim(ExpectedStatus),
    /// The engine makes no favourability claim here at all - `None` from
    /// `favourability_at`, and unassertable by any `ExpectedStatus`.
    NoClaim,
    /// A `Change` fact and a `Variance` fact are BOTH built here and their
    /// favourabilities differ - the movement is good news and the level is bad
    /// news, or either of them is neutral while the other is not.
    ///
    /// WHERE THE READER MEETS BOTH WORDS IS THE FACT SENTENCES, NOT THE ROW.
    /// This doc used to say "the report prints both words", and `build_report`
    /// (report.rs) emits ONE Status cell per measure: `MeasureRun::status` when
    /// it is set - a KPI band string, written only by the Variance branch of
    /// `facts_for_measure` and only when the model gives the measure KPI bands -
    /// and otherwise `favourability_word(m.favourability)`, which is assigned in
    /// the CHANGE branch and nowhere else. So the ROW carries one word: the
    /// band, or the movement's. The two narrated facts are where both appear.
    /// Either way no single `expect` can be right about the point, which is why
    /// this is a refusal rather than a choice.
    TwoAnswers,
    /// The judgement here rests on `Target::Measure` - another measure's value,
    /// which only a query produces - and the possible query results do not agree
    /// on the verdict.
    ///
    /// TWO WAYS THE QUERY DECIDES IT, and the second is the one the `Immaterial`
    /// family kept escaping through. The sign of `value - target` picks the word;
    /// and the query can also come back with no USABLE number, in which case no
    /// Variance fact is built and a below-the-floor point falls silent instead of
    /// being judged. Nothing in the document decides either one.
    ///
    /// THE TWO UNUSABLE CASES ARE REFUSED IN DIFFERENT FILES, and this doc used
    /// to credit both to `model_commands`. A referenced measure that is not in
    /// the queried grid leaves `observation.target_value` at `None` there, which
    /// is `model_commands`'. A target that comes back ZERO is stored as a
    /// present 0.0 quite happily, and it is `facts_for_measure` (`model.rs`) that
    /// declines to divide by it and so builds nothing. Three other comments in
    /// this file already attribute the zero case correctly.
    UnknownTarget,
}

impl std::fmt::Display for Verdict {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Verdict::Claim(s) => write!(f, "{s}"),
            Verdict::NoClaim => f.write_str("no claim at all"),
            Verdict::TwoAnswers => f.write_str("two words at once - the movement and the level \
                                               are judged differently here"),
            Verdict::UnknownTarget => f.write_str("a judgement against a target only a query \
                                                   resolves"),
        }
    }
}

/// A `given` field a test may leave out. `delta` is mandatory and so is absent.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum TestInput {
    Value,
    Baseline,
}

impl TestInput {
    fn field(self) -> &'static str {
        match self {
            TestInput::Value => "given.value",
            TestInput::Baseline => "given.baseline",
        }
    }

    fn code(self) -> &'static str {
        match self {
            TestInput::Value => "test-needs-value",
            TestInput::Baseline => "test-needs-baseline",
        }
    }
}

/// Everything the runner needs to know about one hypothetical point - the
/// movement AND the level it landed at, since both are judged.
///
/// The two reachable SETS are what turn "the answer happens to match" into a
/// judgement about whether the test says anything, and they are deliberately
/// different questions:
///
///   `determined` - the verdicts reachable as the fields the test OMITTED range
///   over every value. More than one means the verdict is not a function of what
///   the test states, so the test is under-specified and proves nothing.
///
///   `possible` - the verdicts reachable as EVERY field ranges. An `expect`
///   outside this can never be produced whatever numbers are written, which is a
///   different and more useful message than "it came out favourable". Gating the
///   unreachable-expectation finding on `determined` instead would turn every
///   ordinary failing test into "invalid", which is why there are two sets.
#[derive(Debug, Clone, PartialEq)]
pub struct Judgement {
    /// The verdict for the `given` exactly as written.
    pub verdict: Verdict,
    /// The rule that produced it, when a rule did.
    pub decided_by: Option<String>,
    pub determined: BTreeSet<Verdict>,
    pub possible: BTreeSet<Verdict>,
    /// The omitted fields the verdict actually depends on.
    pub missing: BTreeSet<TestInput>,
}

impl Judgement {
    /// The verdict in the shape a test can be compared against, which is only
    /// the verdicts an `ExpectedStatus` has a word for. Every other verdict is a
    /// refusal rather than an answer, and `run_inline_tests` says which.
    pub fn outcome(&self) -> Option<TestOutcome> {
        match self.verdict {
            Verdict::Claim(status) => Some(TestOutcome {
                status,
                decided_by: self.decided_by.clone(),
            }),
            Verdict::NoClaim | Verdict::TwoAnswers | Verdict::UnknownTarget => None,
        }
    }
}

/// Is a movement big enough to be worth a sentence?
///
/// THE PLANNER'S OWN FUNCTION, not a second implementation of it. This file had
/// its own copy, and the copy disagreed with the planner in exactly the case a
/// consultant hits: `clears_materiality` (insights::model) takes the PRIOR
/// PERIOD as the baseline of a relative threshold and is always given one, while
/// the copy here read `given.baseline` and, when the test omitted it, answered
/// "material" - so a test could go green on a movement the report suppresses.
///
/// An absent baseline is handed a zero and the planner's own zero-baseline
/// reasoning answers. That is honest here because the answer is never TRUSTED on
/// its own: the runner asks what happens across every baseline before it
/// believes any single one.
fn is_material(r: &ResolvedMeasure, given: &TestGiven) -> bool {
    clears_materiality(
        r.materiality.as_ref().map(|a| &a.value),
        given.baseline.unwrap_or(0.0),
        given.delta,
    )
}

/// Do `value`, `baseline` and `delta` describe ONE observation, or three
/// unrelated numbers?
///
/// NOTHING USED TO ASK, AND THE THREE FIELDS ARE NOT INDEPENDENT. A run reads
/// the last two points of a series: `facts_for_measure` takes `(first, last)`
/// from `observation.last_two()`, sets `delta = last - first` and judges
/// materiality against `first`. So the baseline of a real point IS
/// `value - delta`, and a `given` that says otherwise names an observation the
/// engine cannot produce.
///
/// The consequence is a vacuous green, because the harness splits the triple the
/// same way the planner does and then reads the two halves from DIFFERENT
/// numbers: `is_material` judges the floor from `baseline` and `delta`, while
/// `favourability_at` and `variance_at` judge the level from `value`. State
/// `value: 610, baseline: 1000, delta: 40` under a 5% relative floor and the
/// harness measures 40 against 50 and reports `immaterial` - while the only
/// series that could produce it is 570 -> 610, whose floor is 28.5, whose change
/// fact is built, and whose Status cell reads "Worse".
///
/// It is REFUSED rather than re-judged. Deriving the baseline and judging the
/// point anyway would make the runner quietly ignore a number the consultant
/// wrote down, which is the same disease one step further on.
///
/// THIS PREDICATE IS ONLY HALF OF GATE (0), AND ON ITS OWN IT LEAKED. The
/// tolerance below has to exist - a hand-typed `1_000_000.1 - 1_000_000.0` is a
/// binary-float hair off `0.1` and refusing it would refuse honest documents -
/// but a RELATIVE floor multiplies that hair straight into its threshold, so a
/// residue this predicate calls negligible is enough to move the floor from one
/// side of the movement to the other. Round the baseline of a 1.05-billion
/// measure to `1_000_000_000` while stating `value: 1_050_000_001` and
/// `delta: 50_000_000`: the residue is 1.0 against a tolerance of 1.05, and yet
/// 5% of the stated baseline is 50_000_000 exactly (cleared) while 5% of the
/// run's own `value - delta` is 50_000_000.05 (not cleared), so the harness
/// judged the movement `unfavourable` over a report that built no fact at all.
/// `run_inline_tests` therefore asks the floor the SECOND question - do the two
/// baselines agree about materiality - and refuses under this same code when
/// they do not. Pinning a movement AT its floor is one of the things an inline
/// test is for, so that is a boundary consultants really write about.
fn states_one_point(value: f64, baseline: f64, delta: f64) -> bool {
    // JSON carries no infinity or NaN, so a document cannot reach this with one;
    // a caller inside this crate can, and a non-finite `given` describes no
    // observation either.
    if !(value.is_finite() && baseline.is_finite() && delta.is_finite()) {
        return false;
    }
    // Scaled, because these are money and counts: an exact `==` would refuse
    // `1_000_000.1 - 1_000_000.0 == 0.1` for being a binary-float hair out.
    let scale = value.abs().max(baseline.abs()).max(delta.abs()).max(1.0);
    ((value - baseline) - delta).abs() <= scale * 1e-9
}

/// What a run's `Variance` fact does at this point - INCLUDING not existing.
///
/// THE HALF OF THE POINT `Immaterial` USED TO FORGET. `facts_for_measure` builds
/// its Variance branch OUTSIDE the materiality gate: it needs only
/// `observation.target_value` and a non-zero one, and `model_commands` fills
/// that in for `Target::Literal` and `Target::Measure`. So a movement below the
/// floor can still be judged - against its LEVEL rather than its movement - and
/// a harness that answered `Immaterial` there asserted the report was silent
/// while the report was calling the measure worse.
///
/// That the two gates differ is RIGHT, not a bug to paper over: materiality is a
/// property of a MOVEMENT, and a variance against target is a comparison of
/// LEVELS. A tiny movement can still sit far from target.
#[derive(Debug, Clone, Copy, PartialEq)]
enum VarianceFact {
    /// The run builds no Variance fact at this point: no target, a band or KPI
    /// target (neither of which `model_commands` turns into a number), a target
    /// of zero, or no observed value for the run to compare - and, listed
    /// alongside the `Judges` entries for a `Target::Measure`, the query coming
    /// back with no usable number for the measure that carries the target.
    NotBuilt,
    /// The run builds one, carrying this favourability - `None` being the "with
    /// no favourability claim" the report prints beside the numbers.
    Judges(Option<Favourability>),
}

/// The measure that carries this measure's target, when another one does.
fn target_measure_name(r: &ResolvedMeasure) -> Option<&str> {
    match r.target.as_ref().map(|t| &t.value) {
        Some(Target::Measure { r#ref }) => Some(r#ref.as_str()),
        _ => None,
    }
}

/// EVERY Variance outcome a run could produce here, asked of the planner.
///
/// A LIST RATHER THAN AN ANSWER, because `Target::Measure` does not pin one and
/// pretending it did was the narrowest spelling of the whole vacuous-green
/// family. The number comes from a query, so:
///
///   * its SIGN against the observed value picks the word, and only the sign
///     reaches `favourability_at`, so three probes cover every value the other
///     measure could take;
///   * and the query can produce NO usable number at all. `model_commands`
///     resolves a `Target::Measure` by finding the referenced measure's column
///     in the grid it just queried and reading the last row; a measure that is
///     not in that grid yields `None`, and a target that comes back 0.0 is
///     skipped by `facts_for_measure` rather than divided by. Either way the run
///     builds no Variance fact - so a point below the materiality floor, which
///     `Judges` would have the harness call `unfavourable`, is one the report
///     may say NOTHING about.
///
/// `judge_once` folds the list: outcomes that agree give that answer, outcomes
/// that disagree are `Verdict::UnknownTarget` and the test is refused. Every
/// other target shape returns exactly one outcome, so nothing but a
/// `Target::Measure` can reach that refusal.
fn variance_at(r: &ResolvedMeasure, given: &TestGiven) -> Vec<VarianceFact> {
    let Some(target) = r.target.as_ref().map(|t| &t.value) else {
        return vec![VarianceFact::NotBuilt];
    };
    // The run compares the LAST OBSERVED VALUE against the target. A test that
    // does not state one leaves the variance unknown here - and the reachability
    // sweep then reports the test as under-specified, naming `given.value`,
    // which is the finding a consultant can act on.
    let Some(value) = given.value else {
        return vec![VarianceFact::NotBuilt];
    };
    match target {
        // The document states the number and `model_commands` passes it straight
        // through, so there is exactly one outcome and no query to wait on.
        Target::Literal { value: t } if *t != 0.0 => {
            vec![VarianceFact::Judges(favourability_at(
                r,
                Some(value),
                value - *t,
            ))]
        }
        // `facts_for_measure` skips a target of zero rather than dividing by it.
        Target::Literal { .. } => vec![VarianceFact::NotBuilt],
        Target::Measure { .. } => {
            let mut out = vec![VarianceFact::NotBuilt];
            for delta in [-1.0, 0.0, 1.0] {
                let judged = VarianceFact::Judges(favourability_at(r, Some(value), delta));
                // Deduplicated because a band, a `neutral` direction and a
                // withheld one all answer the same word for every sign, and the
                // fold below runs `judge_with` once per entry.
                if !out.contains(&judged) {
                    out.push(judged);
                }
            }
            out
        }
        // Neither yields a `target_value`, so no Variance fact is built: a band
        // has no single number to be over or under, and a KPI target that
        // resolved to a number would have become a `Literal` by now.
        Target::Band { .. } | Target::Kpi => vec![VarianceFact::NotBuilt],
    }
}

/// A verdict and the rule that produced it.
#[derive(Debug, Clone, PartialEq)]
struct Judged {
    verdict: Verdict,
    decided_by: Option<String>,
}

/// The kernel: judge ONE hypothetical point, and say so when there is nothing a
/// test could assert about it.
///
/// IT DOES NOT MIRROR THE PLANNER, IT CALLS IT. This function used to re-derive
/// the direction match and the band containment - a second implementation of
/// `favourability_at`, sitting behind a cross-product test whose job was to
/// notice when the two drifted. They drifted anyway, and the test carried a
/// carve-out for the case where they disagreed. There is now one implementation
/// of the judgement, so `judge` and a shipped report cannot answer differently
/// about the same measure at the same point.
///
/// THE FOLD OVER `variance_at` IS THE `UnknownTarget` RULE, and it replaces
/// a hand-written gate that asked a narrower question. The old gate fired only
/// when the SIGN of a `Target::Measure` comparison changed the word; it could not
/// see the case where the query produces no usable number at all, so a point
/// below the materiality floor came back `Claim(...)` from the branch where a
/// variance exists while the run might build nothing whatever. Judging each
/// possible outcome and refusing when they disagree covers both, and covers
/// whatever a third one turns out to be.
fn judge_once(r: &ResolvedMeasure, given: &TestGiven) -> Judged {
    let mut judged = variance_at(r, given)
        .into_iter()
        .map(|outcome| judge_with(r, given, outcome));
    let first = judged
        .next()
        .expect("every arm of `variance_at` returns at least one outcome");
    if judged.all(|j| j == first) {
        return first;
    }
    // Only a `Target::Measure` yields more than one outcome, so this is that
    // measure's number being unknowable and nothing else.
    Judged {
        verdict: Verdict::UnknownTarget,
        decided_by: r
            .direction
            .as_ref()
            .and_then(|d| d.rule_id())
            .map(str::to_string),
    }
}

/// Judge the point on the assumption that the run's Variance fact does exactly
/// `variance`.
///
/// THE ORDER OF THE GATES IS THE PLANNER'S ORDER, and it is the substance of the
/// fix rather than tidiness. Nothing but the test named
/// `the_materiality_floor_answers_before_rule_4_does` pins it, because a point
/// that is both below the floor and direction-suppressed satisfies every other
/// assertion in this file under EITHER order:
///
///   1. MATERIALITY, first, because it decides whether the `Change` fact EXISTS.
///      In `facts_for_measure` the whole fact - its numbers, its direction
///      provenance, its favourability, its band - is built inside
///      `if clears_materiality(...)`. Below the floor, and with no Variance fact
///      either, nothing at this point carries a favourability, so the honest
///      verdict is `Immaterial` and not `Neutral`.
///
///      WHAT `Immaterial` DOES NOT MEAN IS "the report is silent". `model.rs`
///      sets `prior_label`, `prior_value`, `delta` and `pct` UNCONDITIONALLY,
///      before the gate, and `report.rs` prints all four into the row; only
///      `favourability` sits inside it, so the Status cell reads "No claim". The
///      accurate sentence is "no `Change` FACT, so no favourability - the
///      numbers are still printed".
///   2. Rule 4, a WITHHELD direction: the numbers ship and the judgement does
///      not. It is REPORTABLE (the rule that withheld it is named), which is why
///      a test can assert `suppressed` and cannot assert "no claim". It comes
///      SECOND because a withheld direction withholds a judgement from a fact
///      that exists - below the floor there is no such fact to withhold one
///      from.
///   3. TWO ANSWERS. A `Change` fact and a `Variance` fact can both be built and
///      disagree - the movement better, the level worse - and the reader then
///      sees two words in the two fact sentences. Pinning either one would be
///      picking a favourite.
///   4. the planner's own `favourability_at`, whose `None` is this function's
///      `NoClaim`: no direction resolves here, or the direction is `targetBand`
///      and no band reaches this point.
fn judge_with(r: &ResolvedMeasure, given: &TestGiven, variance: VarianceFact) -> Judged {
    // THE FACTS THAT EXIST AT THIS POINT, and the favourability each of them
    // carries. `favourability_at` is what a shipped fact carries; the band's
    // inclusivity flags are spent inside it, once, rather than being read one
    // way here and another way in the report. Its `None` - no direction, or
    // `targetBand` with no band at this point - survives a document that
    // VALIDATES, because `target-band-without-band` is scope-blind: a band
    // declared only on a rule scoped elsewhere gives a point where the direction
    // is `targetBand` and no band exists.
    let mut answers: Vec<Option<Favourability>> = Vec::new();
    if is_material(r, given) {
        answers.push(favourability_at(r, given.value, given.delta));
    }
    if let VarianceFact::Judges(f) = variance {
        answers.push(f);
    }

    // (1) NOTHING TO JUDGE.
    if answers.is_empty() {
        // Materiality is what decided this, so materiality's provenance is what
        // the test should be allowed to assert on. A movement below the floor
        // never reaches the direction, so the direction's rule is NOT a
        // fallback here - naming it would credit a rule that decided nothing.
        return Judged {
            verdict: Verdict::Claim(ExpectedStatus::Immaterial),
            decided_by: r
                .materiality
                .as_ref()
                .and_then(|a| a.rule_id())
                .map(str::to_string),
        };
    }

    // (2) RULE 4.
    if let Some(s) = r.suppression_of(Attribute::Direction) {
        return Judged {
            verdict: Verdict::Claim(ExpectedStatus::Suppressed),
            decided_by: Some(s.rule.clone()),
        };
    }

    let by_direction = r
        .direction
        .as_ref()
        .and_then(|d| d.rule_id())
        .map(str::to_string);

    // (3) TWO ANSWERS. Gate 1 returned unless one of the two facts exists, so
    // there is at least one answer here.
    //
    // "Gate 1", NEVER the lower-case word followed by a bracket, AND THAT IS NOT
    // A STYLE CHOICE. `document_store_census_tests` builds its call closure by
    // matching every identifier-then-open-bracket token in a function BODY -
    // comments and string literals included, deliberately, because a scanner
    // that skipped them once hid two real save-path leaks. This function is
    // inside the closure of `assemble_publish_workbook` (through
    // `validate_published_strategies` -> `run_inline_tests` -> `judge`), and
    // `mcp/objects.rs` declares a `pub(crate)` function of that name taking a
    // `&ScriptState`. So writing it that way in prose fabricated a call edge
    // that dragged `check_mcp_access` and `check_script_security` into the
    // publish closure, and the census correctly reported three `ScriptState`
    // fields as projected-but-never-reset. A COMMENT FAILED TWO TESTS. Any bare
    // generic name in that shape does it - keep prose out of it in here.
    let mut answers = answers.into_iter();
    let first = answers
        .next()
        .expect("gate 1 returns unless a fact exists at this point");
    if answers.any(|a| a != first) {
        return Judged {
            verdict: Verdict::TwoAnswers,
            decided_by: by_direction,
        };
    }

    // (4) THE PLANNER'S ANSWER, VERBATIM.
    let verdict = match first {
        Some(Favourability::Better) => Verdict::Claim(ExpectedStatus::Favourable),
        Some(Favourability::Worse) => Verdict::Claim(ExpectedStatus::Unfavourable),
        Some(Favourability::Neutral) => Verdict::Claim(ExpectedStatus::Neutral),
        None => Verdict::NoClaim,
    };
    Judged {
        verdict,
        decided_by: by_direction,
    }
}

// --- probes ---------------------------------------------------------------
//
// EVERY REACHABLE SET IS COMPUTED BY RE-RUNNING `judge_once`, never by a second
// implementation of the judgement. A parallel "which statuses could this
// produce" analysis is precisely the kind of copy that drifts from the thing it
// describes - which is the defect `is_material` above already carries a comment
// about.

/// The magnitude at or above which a movement clears the floor, LOCATED BY
/// ASKING THE GATE.
///
/// This was a third copy of `clears_materiality`'s arithmetic - the absolute
/// arm, the relative arm and the zero-baseline special case, retyped, with one
/// caller and no test of its own. Two copies of a rule drift; three is a
/// promise that they will. Nothing here knows what a `Materiality` means any
/// more: `clears_materiality` is monotone in `|delta|` (every arm is either
/// `delta != 0` or `|delta| >= t`), so the boundary can be found by bisection
/// over the planner's own answer and stays correct through any change to what
/// the floor is made of.
///
/// Returns 0.0 when every non-zero movement is material, which is what the
/// probes below need to know to skip their half-of-the-floor cases.
fn materiality_boundary(r: &ResolvedMeasure, baseline: f64) -> f64 {
    let materiality = r.materiality.as_ref().map(|m| &m.value);
    let material = |delta: f64| clears_materiality(materiality, baseline, delta);

    // The smallest positive number there is: if even that clears, the floor is
    // at zero and there is no immaterial side to probe.
    if material(f64::MIN_POSITIVE) {
        return 0.0;
    }
    // Upwards until something clears. A floor no finite movement clears (an
    // absurd `absolute` threshold) answers with the largest finite magnitude,
    // so the probes stay finite and the whole sweep stays on the immaterial
    // side - which is the truth about that document.
    let mut high = 1.0_f64;
    while !material(high) {
        high *= 2.0;
        if !high.is_finite() {
            return f64::MAX;
        }
    }
    // ...then halve the gap. 200 steps is far past the point where `low` and
    // `high` are adjacent f64s; the loop leaves early when they are.
    let mut low = 0.0_f64;
    for _ in 0..200 {
        let mid = low + (high - low) / 2.0;
        if mid <= low || mid >= high {
            break;
        }
        if material(mid) {
            high = mid;
        } else {
            low = mid;
        }
    }
    high
}

/// Observed values worth trying: absent, zero, every interesting point around
/// the band when one exists - both bounds, one step outside each, and the
/// midpoint - and, under a literal target, the target itself and one step
/// either side of it.
///
/// THE TARGET NEIGHBOURHOOD IS NOT DECORATION. The value is what decides a
/// Variance fact's favourability, so without probes that cross the target a
/// sweep over a measure with a literal target reaches only the side of it that
/// `0.0` happens to fall on, and a test whose verdict flips across the target
/// would be reported as determined.
fn value_probes(r: &ResolvedMeasure) -> Vec<Option<f64>> {
    let mut out = vec![None, Some(0.0)];
    if let Some(band) = r.target.as_ref().and_then(|t| t.value.as_band()) {
        out.extend([
            Some(band.low - 1.0),
            Some(band.low),
            Some((band.low + band.high) / 2.0),
            Some(band.high),
            Some(band.high + 1.0),
        ]);
    }
    if let Some(Target::Literal { value }) = r.target.as_ref().map(|t| &t.value) {
        out.extend([Some(value - 1.0), Some(*value), Some(value + 1.0)]);
    }
    out
}

/// Baselines worth trying: absent, zero (which the planner treats specially),
/// one, and - under a relative threshold - the baseline that puts the floor
/// just ABOVE this movement, which is the assignment that flips the verdict.
fn baseline_probes(r: &ResolvedMeasure, delta: f64) -> Vec<Option<f64>> {
    let mut out = vec![None, Some(0.0), Some(1.0)];
    if let Some(Materiality::Relative { value }) = r.materiality.as_ref().map(|m| &m.value) {
        if *value != 0.0 && value.is_finite() {
            let flips = 2.0 * delta.abs() / value.abs();
            if flips.is_finite() {
                out.push(Some(flips.max(1.0)));
            }
        }
    }
    out
}

/// Movements worth trying at a given baseline: nothing, and one comfortably
/// either side of the floor in both directions.
fn delta_probes(r: &ResolvedMeasure, baseline: f64) -> Vec<f64> {
    let t = materiality_boundary(r, baseline);
    let mut out = vec![0.0, t + 1.0, -(t + 1.0)];
    if t > 0.0 {
        out.push(t / 2.0);
        out.push(-(t / 2.0));
    }
    out
}

/// Which fields a reachability sweep is allowed to vary.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Freedom {
    /// Only the fields the test left out. Answers "is the verdict a function of
    /// what this test actually states?"
    Omitted,
    /// Every field, `delta` included. Answers "could this expectation ever be
    /// produced?"
    All,
}

/// The verdicts reachable from this `given` under the stated freedom.
fn reachable(r: &ResolvedMeasure, given: &TestGiven, freedom: Freedom) -> BTreeSet<Verdict> {
    let free_value = freedom == Freedom::All || given.value.is_none();
    let free_baseline = freedom == Freedom::All || given.baseline.is_none();

    // The as-written assignment is ALWAYS among the probes, freed or not, so
    // "the verdict this test actually produces" is guaranteed to be inside the
    // set the runner then reasons about. Without that, a `possible` set computed
    // from probes alone could exclude the very answer the document gives.
    let values: Vec<Option<f64>> = if free_value {
        let mut v = value_probes(r);
        v.push(given.value);
        v
    } else {
        vec![given.value]
    };
    let baselines: Vec<Option<f64>> = if free_baseline {
        let mut b = baseline_probes(r, given.delta);
        b.push(given.baseline);
        b
    } else {
        vec![given.baseline]
    };

    let mut out: BTreeSet<Verdict> = BTreeSet::new();
    for baseline in &baselines {
        // The delta probes depend on the baseline (a relative floor is a
        // fraction of it), so they are chosen INSIDE this loop rather than once.
        let deltas: Vec<f64> = if freedom == Freedom::All {
            let mut d = delta_probes(r, baseline.unwrap_or(0.0));
            d.push(given.delta);
            d
        } else {
            vec![given.delta]
        };
        for delta in deltas {
            for value in &values {
                let probe = TestGiven {
                    delta,
                    value: *value,
                    baseline: *baseline,
                };
                out.insert(judge_once(r, &probe).verdict);
            }
        }
    }
    out
}

/// Judge one hypothetical movement, and say what the test could have asserted.
pub fn judge(r: &ResolvedMeasure, given: &TestGiven) -> Judgement {
    let judged = judge_once(r, given);
    let determined = reachable(r, given, Freedom::Omitted);
    let possible = reachable(r, given, Freedom::All);

    // Which OMITTED field the verdict depends on, asked one field at a time so
    // the finding can name the field to add rather than "something".
    let verdicts_over = |probes: Vec<TestGiven>| -> BTreeSet<Verdict> {
        probes
            .into_iter()
            .map(|p| judge_once(r, &p).verdict)
            .collect()
    };
    let mut missing: BTreeSet<TestInput> = BTreeSet::new();
    if given.value.is_none()
        && verdicts_over(
            value_probes(r)
                .into_iter()
                .map(|v| TestGiven { value: v, ..given.clone() })
                .collect(),
        )
        .len()
            > 1
    {
        missing.insert(TestInput::Value);
    }
    if given.baseline.is_none()
        && verdicts_over(
            baseline_probes(r, given.delta)
                .into_iter()
                .map(|b| TestGiven { baseline: b, ..given.clone() })
                .collect(),
        )
        .len()
            > 1
    {
        missing.insert(TestInput::Baseline);
    }

    Judgement {
        verdict: judged.verdict,
        decided_by: judged.decided_by,
        determined,
        possible,
        missing,
    }
}

/// Run every inline test and report the failures as validation errors.
///
/// THE INLINE SUITE IS THE ONLY THING GIVING THIS FILE TEETH, so a test that
/// cannot prove anything is REFUSED rather than counted green. The refusal
/// families below are checked in the order they are written, because each later
/// one presumes the earlier ones passed, and the comparison the whole thing
/// exists for happens only once they have all declined to fire. (No count here:
/// the line used to promise five ways to prove nothing over a list whose last
/// entry is the comparison itself, which is not one of them - a number nothing
/// enforces goes stale the first time a gate is inserted.)
///
///   0. the `given` names no observation at all - `value - baseline != delta`,
///      so the three numbers cannot come from one pair of periods, or they miss
///      by only the residue `states_one_point` forgives and a relative floor
///      magnifies that residue into a change fact the run does not build;
///   1. the verdict is not a function of what the test states - under-specified;
///   2. the point carries no ONE claim an `ExpectedStatus` can name: no claim at
///      all, two disagreeing claims, or a claim against a target only a query
///      resolves;
///   3. the `expect` names a status no `given` could ever produce;
///   4. only then is the answer compared, and the reason for it.
///
/// (0) FIRST, AND IT NEVER COMPETES WITH (1). A `given` that states all three
/// fields leaves nothing for the reachability sweep to vary, so `determined` is
/// a singleton by construction and (1) cannot fire on the same test - the two
/// findings are about disjoint documents. It comes first anyway, because
/// everything after it reasons about a point, and there is no point here.
///
/// (1) BEFORE (2), AND THERE IS EXACTLY ONE SITE FOR EACH. The order is not a
/// preference: `determined` is a singleton by the time (2) is asked, so "no
/// claim as written" and "no claim whatever the omitted numbers are" have become
/// the same statement and one refusal covers both. Written the other way round
/// it took TWO blocks pushing the same code - a real one and a "cannot be
/// reached" defensive one - and removing either left the other quietly covering
/// for it, so neither was ever proved to do anything.
pub fn run_inline_tests(facts: &ModelFacts, doc: &StrategyDoc) -> Vec<Finding> {
    let mut out = Vec::new();
    for (i, t) in doc.tests.iter().enumerate() {
        let path = format!("tests[{i}]");
        if !facts.measures.contains_key(&t.measure) {
            // Already reported as an unknown measure; running it would only add
            // a second, less informative finding.
            continue;
        }
        let point = point_from_scope(&t.scope);
        let resolved = resolve(facts, doc, &t.measure, &point);

        // (0) A `given` THAT IS NOT AN OBSERVATION, in either of the two ways
        // three numbers can fail to name one: they contradict each other
        // outright, or they agree only to within a residue the floor is
        // sensitive to. The second needs the resolved measure, which is why the
        // resolution above happens before the gate rather than after it.
        if let (Some(value), Some(baseline)) = (t.given.value, t.given.baseline) {
            // The baseline `facts_for_measure` would judge from: it derives
            // `first = last - delta` off the series and never sees a `baseline`
            // field at all.
            let derived = value - t.given.delta;
            let floor = resolved.materiality.as_ref().map(|m| &m.value);
            let stated_clears = clears_materiality(floor, baseline, t.given.delta);
            let derived_clears = clears_materiality(floor, derived, t.given.delta);
            if !states_one_point(value, baseline, t.given.delta) {
                out.push(Finding::error(
                    "test-given-is-not-one-observation",
                    format!("{path}.given"),
                    format!(
                        "the test for '{}' states value {value}, baseline {baseline} and delta \
                         {}, and no observation can carry all three: a run reads two consecutive \
                         periods, so the baseline it judges against is always `value - delta` \
                         ({}). The floor would be measured from {baseline} here and from {} in \
                         the report, which is how an assertion goes green over a point the \
                         report judges differently. Set `baseline` to {}, or restate `delta` as \
                         {}",
                        t.measure,
                        t.given.delta,
                        value - t.given.delta,
                        value - t.given.delta,
                        value - t.given.delta,
                        value - baseline,
                    ),
                ));
                continue;
            }
            // AND THE HAIR THE PREDICATE ABOVE FORGIVES, WHICH IS NOT ALWAYS A
            // HAIR TO A RELATIVE FLOOR. `states_one_point` allows a residue of
            // `1e-9 * scale` so a hand-typed decimal is not refused for a binary
            // rounding, and a fraction-of-the-baseline threshold turns that
            // residue into a shift of the floor itself. Where the shift crosses
            // the movement, one baseline builds a change fact and the other does
            // not - so the two readings judge different reports, and the test is
            // refused for the same reason as the outright contradiction above.
            if stated_clears != derived_clears {
                out.push(Finding::error(
                    "test-given-is-not-one-observation",
                    format!("{path}.given"),
                    format!(
                        "the test for '{}' states value {value}, baseline {baseline} and delta \
                         {}. Those are within the rounding this runner forgives, but not within \
                         the materiality floor: a run derives its baseline as `value - delta` \
                         ({derived}), and the movement is {} the floor there while the stated \
                         baseline puts it {} - so one of the two builds a change fact and the \
                         other builds none. Write `baseline` as {derived}",
                        t.measure,
                        t.given.delta,
                        if derived_clears { "above" } else { "below" },
                        if stated_clears { "above" } else { "below" },
                    ),
                ));
                continue;
            }
        }

        let j = judge(&resolved, &t.given);

        // (1) UNDER-SPECIFIED. More than one verdict survives the fields the
        // test left out, so the answer is decided by numbers the test never
        // wrote down.
        if j.determined.len() > 1 {
            // `missing` is computed one field at a time; if two fields only
            // matter jointly it can come back empty while `determined` is still
            // split, and naming both is then the honest answer.
            let fields: Vec<TestInput> = if j.missing.is_empty() {
                [TestInput::Value, TestInput::Baseline]
                    .into_iter()
                    .filter(|f| match f {
                        TestInput::Value => t.given.value.is_none(),
                        TestInput::Baseline => t.given.baseline.is_none(),
                    })
                    .collect()
            } else {
                j.missing.iter().copied().collect()
            };
            let outcomes: Vec<String> = j.determined.iter().map(|v| v.to_string()).collect();
            for field in fields {
                out.push(Finding::error(
                    field.code(),
                    format!("{path}.given"),
                    format!(
                        "the test for '{}' cannot be judged: with `{}` left out the strategy \
                         resolves to {} depending on numbers the test never states, so the \
                         assertion passes or fails for reasons its reader cannot see. State \
                         `{}`. (The report supplies both from the data: the observed value of \
                         the last period, and the prior period as the baseline.)",
                        t.measure,
                        field.field(),
                        outcomes.join(" or "),
                        field.field()
                    ),
                ));
            }
            // Judging it anyway would add a second finding about a verdict that
            // was never reachable.
            continue;
        }

        // (2) NO SINGLE CLAIM TO ASSERT, and this is the ONLY site that says so.
        // `determined` is a singleton by now and always contains the verdict as
        // written, so whatever lands here is what every assignment of the
        // omitted fields lands on - a test that reads its `given` and throws it
        // away. Each unassertable verdict names its own cause, because "this
        // test proves nothing" and "which of the two words did you mean" send a
        // consultant to different edits.
        let Some(actual) = j.outcome() else {
            out.push(match j.verdict {
                Verdict::Claim(_) => unreachable!("`outcome` is Some for every Claim"),
                Verdict::NoClaim => Finding::error(
                    "test-has-no-judgement-to-assert",
                    path.clone(),
                    format!(
                        "the test for '{}' asserts '{}', but at this scope point the engine makes \
                         NO favourability claim whatever the numbers are - either no direction \
                         resolves here, or the direction is 'targetBand' and no band reaches this \
                         point. The report would print the movement with 'no favourability claim' \
                         beside it, and `expect` has no word for that: this test can only pass by \
                         accident. Give the measure a direction that reaches this scope, or \
                         declare the band here",
                        t.measure, t.expect.status
                    ),
                ),
                Verdict::TwoAnswers => Finding::error(
                    "test-point-has-two-answers",
                    path.clone(),
                    format!(
                        "the test for '{}' asserts '{}', but this point is judged TWICE and the \
                         two judgements disagree: the change fact judges the MOVEMENT and the \
                         variance fact judges the LEVEL against the target, and here they carry \
                         different words. Both sentences ship, so the reader meets both words in \
                         the fact list - while the report ROW's Status cell shows the movement's \
                         word alone - and no single `expect` is right about the point. State a \
                         `given` where the movement and the level agree, or scope the test where \
                         only one of the two is judged",
                        t.measure, t.expect.status
                    ),
                ),
                Verdict::UnknownTarget => Finding::error(
                    "test-target-is-another-measure",
                    path.clone(),
                    format!(
                        "the test for '{}' asserts '{}', but its target is {}, whose value only a \
                         query produces - and the query decides the verdict twice over. Which \
                         side of the target the value lands on picks the word, and a query that \
                         returns no usable number for it (the measure is missing from the grid, \
                         or comes back zero) builds no variance fact at all. This document does \
                         not state either, so the assertion cannot be checked here. Test this \
                         measure at a scope where a literal target applies, or state the goal as \
                         {{\"type\": \"literal\", \"value\": ..}}",
                        t.measure,
                        t.expect.status,
                        match target_measure_name(&resolved) {
                            Some(name) => format!("the measure '{name}'"),
                            None => "another measure".to_string(),
                        }
                    ),
                ),
            });
            continue;
        };

        // (3) AN EXPECTATION NOTHING COULD PRODUCE. Not "it came out the other
        // way" - no assignment of delta, value and baseline reaches this status
        // at all, so the test is asserting something about a different document.
        if !j.possible.contains(&Verdict::Claim(t.expect.status)) {
            let reachable: Vec<String> = j.possible.iter().map(|v| v.to_string()).collect();
            out.push(Finding::error(
                "test-expects-the-unreachable",
                path.clone(),
                format!(
                    "the test for '{}' expects '{}', which the strategy can NEVER produce at this \
                     scope point - no movement, value or baseline reaches it. The only outcomes \
                     here are: {}. Either the expectation names the wrong status or the rule the \
                     test is about does not reach this scope",
                    t.measure,
                    t.expect.status,
                    reachable.join(", ")
                ),
            ));
            continue;
        }

        if actual.status != t.expect.status {
            out.push(Finding::error(
                "inline-test-failed",
                path.clone(),
                format!(
                    "the test for '{}' expects '{}' but the strategy resolves to '{}'",
                    t.measure, t.expect.status, actual.status
                ),
            ));
            continue;
        }
        if let Some(expected_rule) = &t.expect.decided_by {
            if actual.decided_by.as_deref() != Some(expected_rule.as_str()) {
                out.push(Finding::error(
                    "inline-test-failed",
                    path,
                    format!(
                        "the test for '{}' expects rule '{}' to decide it, but it was decided by {}",
                        t.measure,
                        expected_rule,
                        actual
                            .decided_by
                            .as_deref()
                            .map(|r| format!("rule '{r}'"))
                            .unwrap_or_else(|| "no rule at all".to_string())
                    ),
                ));
            }
        }
    }
    out
}

// ---------------------------------------------------------------------------
// The validator
// ---------------------------------------------------------------------------

/// `YYYY-MM-DD`, zero padded.
///
/// The SCOPE BOUNDS no longer need this - they are `IsoDate` and serde refuses
/// anything else before a document exists. What still does is a column MEMBER,
/// which arrives from the model as an arbitrary string: `date-range-on-non-date-
/// column` asks whether the members of a column look like dates at all, and
/// there is nothing to type there.
fn is_iso_date(s: &str) -> bool {
    IsoDate::is_valid(s)
}

/// The wire spelling of a direction, for a message a person reads.
fn direction_label(d: Direction) -> &'static str {
    match d {
        Direction::HigherIsBetter => "higherIsBetter",
        Direction::LowerIsBetter => "lowerIsBetter",
        Direction::TargetBand => "targetBand",
        Direction::Neutral => "neutral",
    }
}

/// Every spelling of a `byDimension` key that `is_additive_over` will match.
///
/// It must stay EXACTLY the three that `insights::model::is_additive_over`
/// tries, in the same order, or this validator would bless a key the resolver
/// then fails to find.
fn aggregation_dimension_is_known(facts: &ModelFacts, key: &str) -> bool {
    if let Ok(qc) = key.parse::<QualifiedColumn>() {
        if facts.has_column(&qc) {
            return true;
        }
    }
    if facts.tables.values().any(|t| t.columns.contains(key)) {
        return true;
    }
    facts.has_table(key)
}

/// The wire spelling of an additivity, for a message a person reads.
fn additivity_label(a: Additivity) -> &'static str {
    match a {
        Additivity::Additive => "additive",
        Additivity::NonAdditive => "nonAdditive",
        Additivity::LastValue => "lastValue",
        Additivity::FirstValue => "firstValue",
        Additivity::Average => "average",
        Additivity::Max => "max",
        Additivity::Min => "min",
    }
}

/// Does this additivity only mean something ALONG a named dimension?
///
/// "The last value" is a question about an ORDER, and only a dimension supplies
/// one. There is no last value of Product; there is a last value over Date.
fn needs_a_dimension(a: Additivity) -> bool {
    match a {
        Additivity::LastValue
        | Additivity::FirstValue
        | Additivity::Average
        | Additivity::Max
        | Additivity::Min => true,
        Additivity::Additive | Additivity::NonAdditive => false,
    }
}

fn validate_aggregation(
    facts: &ModelFacts,
    spec: &AggregationSpec,
    path: &str,
    out: &mut Vec<Finding>,
) {
    // A SEMI-ADDITIVE DEFAULT WITH NOTHING TO BE SEMI-ADDITIVE ALONG.
    //
    // Two silent wrongs come out of this, and the second is the reason it is an
    // error rather than a warning. `is_additive_over` (insights::model) reads
    // the per-dimension entry and falls back to `default`, so `lastValue` with
    // no entries answers "not additive" for EVERY dimension and every share fact
    // the measure could have carried disappears. Then the provenance line prints
    // the effective additivity next to the dimension it was applied to, so the
    // report says "lastValue over Product" - a per-dimension claim the document
    // never made, about a rollup nobody can perform.
    if spec.by_dimension.is_empty() && needs_a_dimension(spec.default) {
        out.push(Finding::error(
            "semi-additive-without-dimension",
            path.to_string(),
            format!(
                "the default additivity is '{}', which only means something along a named \
                 dimension - there is no last value of Product, only a last value over Date. \
                 With an empty byDimension it applies to every dimension at once: every share \
                 fact for this measure is dropped in silence. Write the dimension it is \
                 semi-additive along in byDimension, or use 'nonAdditive' if it may never be \
                 summed",
                additivity_label(spec.default)
            ),
        ));
    }
    // A PER-DIMENSION ADDITIVITY KEYED ON SOMETHING THE MODEL DOES NOT HAVE, and
    // it is a silent wrong answer rather than a missing feature. `is_additive_over`
    // tries `Table[Column]`, the bare column and the bare table, and FALLS BACK
    // TO `default` when none match - so `"Dat": "lastValue"` on a closing balance
    // leaves the measure additive over Date, and the engine goes on to claim the
    // balance's share of an annual total.
    for key in spec.by_dimension.keys() {
        if aggregation_dimension_is_known(facts, key) {
            continue;
        }
        out.push(Finding::error(
            "unknown-aggregation-dimension",
            path.to_string(),
            format!(
                "byDimension is keyed on '{key}', which is not a table, not a column and not a \
                 Table[Column] in the model. An unmatched key falls back to the default \
                 additivity in silence, so a semi-additive measure would be summed along the \
                 dimension this entry was written to protect. Write the table name, the column \
                 name, or Table[Column]"
            ),
        ));
    }
}

fn validate_scope(
    facts: &ModelFacts,
    doc: &StrategyDoc,
    scope: &Scope,
    path: &str,
    out: &mut Vec<Finding>,
) {
    for (col, value) in scope {
        if !facts.has_table(&col.table) {
            out.push(Finding::error(
                "unknown-table",
                path.to_string(),
                format!("scope names '{col}', but the model has no table '{}'", col.table),
            ));
            continue;
        }
        if !facts.has_column(col) {
            out.push(Finding::error(
                "unknown-column",
                path.to_string(),
                format!(
                    "scope names '{col}', but table '{}' has no column '{}'",
                    col.table, col.column
                ),
            ));
            continue;
        }
        match doc.role_of(col) {
            Some(role) if !role.may_scope() && !in_a_hierarchy(facts, doc, col) => {
                out.push(Finding::error(
                    "scope-column-role",
                    path.to_string(),
                    format!(
                        "'{col}' has role '{}', so it cannot scope a rule - only analysis, filter \
                         and hierarchy columns can. Keys and labels identify rows; scoping by one \
                         produces a rule that matches a single record",
                        serde_json::to_string(&role).unwrap_or_default().trim_matches('"')
                    ),
                ));
            }
            None => out.push(Finding::warning(
                "undeclared-scope-column",
                path.to_string(),
                format!(
                    "'{col}' scopes a rule but the document declares no role for it, so nothing \
                     checks that scoping by it is meaningful"
                ),
            )),
            _ => {}
        }

        match value {
            ScopeValue::Members(members) => {
                if members.is_empty() {
                    out.push(Finding::error(
                        "empty-scope",
                        path.to_string(),
                        format!("'{col}' is constrained to no members, so the scope is empty"),
                    ));
                }
                // A MEMBER THE MODEL NO LONGER HAS IS STALENESS, NOT A LIE, and
                // it stays a warning under this file's own rule: the archetype
                // in the header is "a member that was renamed". The rule stops
                // applying, so the fact loses an annotation rather than gaining
                // a false one.
                //
                // IT ALSO CANNOT FIRE IN PRODUCTION TODAY. `facts_from_model`
                // writes `members: BTreeMap::new()` unconditionally ("members
                // are DATA, not schema"), and `known_members` maps an empty list
                // to `None`, so this arm and the ERROR-level
                // `date-range-on-non-date-column` below are both reachable only
                // from hand-built `ModelFacts`. That is a reachability hole
                // worth its own work item and NOT a severity question; raising
                // this one would change nothing about what ships.
                if let Some(known) = facts.known_members(col) {
                    for m in members {
                        if !known.contains(m) {
                            out.push(Finding::warning(
                                "unknown-member",
                                path.to_string(),
                                format!(
                                    "'{col}' is scoped to member '{m}', which the model no longer has"
                                ),
                            ));
                        }
                    }
                }
            }
            ScopeValue::DateRange { from, to } => {
                // The BOUNDS' FORM is no longer checked here: they are `IsoDate`
                // and a malformed one stops the document parsing, which closes
                // the run path this check never protected. What is still a
                // document-level question is whether the range holds anything.
                if let Some(to) = to {
                    if from > to {
                        out.push(Finding::error(
                            "empty-scope",
                            path.to_string(),
                            format!("'{col}' runs from '{from}' to '{to}', which is empty"),
                        ));
                    }
                }
                // A DATE RANGE OVER A COLUMN THAT DOES NOT HOLD DATES.
                //
                // `constraint_admits` (resolve.rs) compares the bounds to the
                // member as RAW STRINGS, which is exact for ISO-8601 and
                // meaningless for anything else: on a column whose members are
                // "Nordics" and "DACH", `from: "2025-01-01"` admits both, so the
                // rule silently annotates facts it does not describe.
                //
                // ONLY PROVABLE FROM THE MEMBERS. `ModelFacts` carries no column
                // TYPES, so a column with no declared members cannot be judged
                // here and is left alone rather than guessed at - refusing a
                // real date column for want of a member list would be the
                // confident-wrong this layer exists to avoid.
                if let Some(known) = facts.known_members(col) {
                    if let Some(text) = known.iter().find(|m| !is_iso_date(m)) {
                        out.push(Finding::error(
                            "date-range-on-non-date-column",
                            path.to_string(),
                            format!(
                                "'{col}' is constrained as a date range, but its members are not \
                                 dates ('{text}' is one of them). The resolver compares a range \
                                 to a member as text, so this range would match members it says \
                                 nothing about; constrain it with a member list instead"
                            ),
                        ));
                    }
                }
            }
        }
    }
}

/// The band a target resolves to, RESOLVED THE WAY resolve.rs RESOLVES IT.
///
/// `{"type": "kpi"}` is the case worth spelling out. resolve.rs turns it into
/// the KPI's own scalar target - a `Target::Literal` - and a model KPI carries a
/// NUMBER plus status bands, never a target band. So a kpi target can never
/// satisfy a `targetBand` direction, and answering "maybe, if the KPI has one"
/// would be a guess about a shape that does not exist.
fn resolved_band(target: &Target) -> Option<BandBounds> {
    match target {
        Target::Kpi => None,
        other => other.as_band(),
    }
}

/// Does ANY declaration in the document give this measure a band?
///
/// Deliberately scope-blind: a band declared by one rule is a band a
/// `targetBand` direction can land on somewhere, and refusing the document
/// because it is not a band EVERYWHERE would refuse a legal file. What is being
/// caught is the measure whose band exists nowhere at all, which is the case
/// that can never be judged.
fn has_a_band_anywhere(doc: &StrategyDoc, measure: &str) -> bool {
    let on_entry = doc
        .measures
        .get(measure)
        .and_then(|m| m.target.as_ref())
        .and_then(resolved_band)
        .is_some();
    on_entry
        || doc
            .rules
            .iter()
            .filter(|r| r.measure == measure)
            .filter_map(|r| r.set.target.as_ref())
            .any(|t| resolved_band(t).is_some())
}

/// A `targetBand` direction with no band anywhere: name both, and refuse.
///
/// It was a WARNING on a measure entry and NOT CHECKED AT ALL on a rule, so both
/// spellings saved. `favourability_of` returns `None` for the combination, so the
/// measure carries a direction that decides nothing, ships no favourability and
/// emits no variance line - with nothing anywhere saying why.
///
/// WHAT THE HARNESS SAYS ABOUT SUCH A POINT IS `Verdict::NoClaim`, and this
/// comment used to say `Neutral`. That was true of the `judge` that collapsed
/// every undecidable state into one word, and it is the defect `Verdict`'s own
/// doc describes at length as REMOVED: the last arm maps a `None` favourability
/// to `NoClaim`, which no `ExpectedStatus` can name, so a test written against
/// this point is refused with `test-has-no-judgement-to-assert` rather than
/// passing on a word nobody meant.
fn check_band_direction(
    doc: &StrategyDoc,
    measure: &str,
    subject: &str,
    path: String,
    out: &mut Vec<Finding>,
) {
    if has_a_band_anywhere(doc, measure) {
        return;
    }
    out.push(Finding::error(
        "target-band-without-band",
        path,
        format!(
            "{subject} declares direction 'targetBand' but no target of type 'band' exists for \
             measure '{measure}' - not on its own entry and not on any rule that annotates it. \
             'targetBand' means good is INSIDE a band, so with no band nothing can be judged: \
             the measure silently loses all favourability and its variance line. Declare \
             {{\"type\": \"band\", \"low\": .., \"high\": ..}}, or pick a direction that reads a \
             movement. A {{\"type\": \"kpi\"}} target does not count: a KPI carries a number and \
             status bands, and resolves to a literal target rather than to a band"
        ),
    ));
}

/// Every check that applies to a `Target` wherever it is written.
///
/// One function for both sites on purpose. `unknown-measure` was already checked
/// twice, in two copies, and the three checks added beside it - an unresolvable
/// kpi target and an empty band - would otherwise have been copied twice too,
/// which is how one site quietly stops checking what the other does.
fn validate_target(
    facts: &ModelFacts,
    measure: &str,
    target: &Target,
    subject: &str,
    path: String,
    out: &mut Vec<Finding>,
) {
    match target {
        Target::Measure { r#ref } => {
            if !facts.measures.contains_key(r#ref) {
                out.push(Finding::error(
                    "unknown-measure",
                    path,
                    format!("{subject} targets measure '{}', which is not in the model", r#ref),
                ));
            }
        }
        Target::Kpi => {
            // A GOAL DECLARED AGAINST NOTHING. resolve.rs keeps the bare marker
            // when the KPI cannot supply a number, model_commands maps it to no
            // target_value, and `facts_for_measure` then emits NO variance fact
            // at all - so the author states a goal and the report is simply
            // missing the line, with no note saying why.
            let Some(mf) = facts.measures.get(measure) else {
                // The measure itself is unknown and already reported; a second
                // finding about its target would only bury the first.
                return;
            };
            match mf.kpi.as_ref() {
                None => out.push(Finding::error(
                    "unresolvable-target-kpi",
                    path,
                    format!(
                        "{subject} inherits its target from a KPI, but measure '{measure}' has \
                         no KPI in the model. Nothing resolves the goal, so no variance is ever \
                         reported for it: define the KPI, or state the target here as \
                         {{\"type\": \"literal\", \"value\": ..}}"
                    ),
                )),
                Some(kpi) if kpi.target.is_none() => out.push(Finding::error(
                    "unresolvable-target-kpi",
                    path,
                    format!(
                        "{subject} inherits its target from KPI '{}', which carries no CONSTANT \
                         target - a KPI whose goal is itself another measure has no number until \
                         a query runs, and the planner never asks for one. No variance is ever \
                         reported: give the KPI a constant target, or state the target here as \
                         {{\"type\": \"literal\", \"value\": ..}}",
                        kpi.name
                    ),
                )),
                Some(_) => {}
            }
        }
        Target::Band { .. } => {
            if let Some(band) = target.as_band().filter(|b| b.is_empty()) {
                out.push(Finding::error(
                    "empty-band",
                    path,
                    format!(
                        "{subject} declares the band {}, which no value can be inside. Every \
                         value would be judged unfavourable, forever - the same defect as a date \
                         range that runs backwards, which this validator has always refused",
                        band.label()
                    ),
                ));
            }
        }
        Target::Literal { .. } => {}
    }
}

/// The wire spelling of a table kind, for a message that has to quote one.
fn table_kind_label(kind: TableKind) -> &'static str {
    match kind {
        TableKind::Fact => "fact",
        TableKind::Dimension => "dimension",
        TableKind::Bridge => "bridge",
        TableKind::Calendar => "calendar",
        TableKind::Other => "other",
    }
}

/// The TABLE time will actually run along once this document has had its say.
///
/// THE QUESTION `plan_time_axis` ASKS, WHICH IS NOT THE ONE `effective_date_table`
/// ANSWERS. A calendar and an axis are different things and this file used to
/// conflate them: `plan_time_axis` (insights::model) reads
/// `doc.model.default_time_axis` FIRST and falls back to the date table's own
/// date column only when that names no column in the model. So a document with
/// two authored calendars, no marked date table and no inferable one can still
/// have a perfectly good axis - and the finding below announced that the model
/// had none, on a run that was about to report a trend for every measure.
///
/// THE FALLBACK IS OPTIMISTIC, AND IT CAN BE OPTIMISTIC IN THE WRONG DIRECTION.
/// It stops at the TABLE rather than walking its date columns, which
/// `plan_time_axis` does: the columns it walks come from `date_axis_candidates`,
/// which needs the model this file is never given. Usually the consequence is a
/// warning where an error might have been warranted - the harmless direction.
/// But the reverse IS reachable, so do not read this function as a safety
/// property: a table that carries no `Date`/`Timestamp` column and no `DateKey`
/// role gives `date_axis_candidates` an empty list and `plan_time_axis` a `None`
/// axis, and the run reports no trend at all while the warning below says "Time
/// still runs along '{axis}' ... so every trend and seasonality claim in the
/// report is computed there". That reaches a reader only through a MARKED date
/// table: `mark_date_table`'s build-time validation type-checks whatever date
/// ROLES a column declares and never requires that any date column exist, so a
/// marked table with none is a model that builds. Inference cannot reach it -
/// `infer_date_table` (facts.rs) skips any table that carries no date column -
/// so `CalendarSource::Inferred` is safe and `Declared` is not.
fn surviving_time_axis<'a>(
    facts: &'a ModelFacts,
    doc: &'a StrategyDoc,
    authored: &'a AuthoredKinds,
) -> Option<&'a str> {
    if let Some(declared) = doc
        .model
        .default_time_axis
        .as_ref()
        .filter(|c| facts.has_column(c))
    {
        return Some(declared.table.as_str());
    }
    effective_date_table(facts, authored)
}

/// Judge the table kinds a person typed against the model's own topology.
///
/// WHY THIS IS HERE AND NOT AT THE DROPDOWN. `facts.rs` applies an authored kind
/// by REFUSING the ones a relationship graph disproves — quietly, because it has
/// no findings vector. Without this function that refusal would be exactly the
/// defect it was written to fix, one layer down: a person corrects the kind, the
/// engine declines, and nothing says so. Every value `authored_table_kinds`
/// declines to apply is reported here, and every value it applies that
/// contradicts the MODEL's own `mark_date_table` is warned about.
fn validate_table_kinds(
    facts: &ModelFacts,
    doc: &StrategyDoc,
    authored: &AuthoredKinds,
    out: &mut Vec<Finding>,
) {
    for conflict in &authored.conflicts {
        let path = format!("tables['{}'].kind", conflict.table);
        let kind = table_kind_label(conflict.authored);
        match &conflict.refusal {
            // AN ERROR, not a warning, by this file's own test - and it is the
            // CALENDAR half of this refusal that passes the test, not the whole
            // of it. `facts.rs`'s own header is the census, and only two kinds
            // can ever reach here (`claims_a_lookup` is true for `Dimension` and
            // `Calendar` alone). `calendar` is the one that can move a number:
            // accepted, it becomes `facts.date_table`, and from there the time
            // axis, the series query and every trend, change-point and
            // seasonality claim - so refusing one WITHHOLDS all of those, which
            // is the withheld half of the error rule. `dimension` moves no
            // number at all; it only makes `kind_conflict_notes`
            // (model_commands.rs) carry a note into the run.
            //
            // WHAT THIS COMMENT USED TO CLAIM, AND WHY IT IS GONE: that the kind
            // decides whether the table's columns are offered as breakdown axes
            // and whether it elects a label column. Those branches are real -
            // infer.rs, inside `infer_table` - but `infer_table` runs only from
            // `infer`, whose one production caller hands it MODEL-ONLY facts, so
            // no document ever reaches them. A justification that names a code
            // path the document cannot reach is how a severity survives without
            // ever being re-argued.
            KindRefusal::NothingLooksItUp { filters } => {
                let topology = match filters {
                    Some(other) => format!(
                        "nothing looks '{}' up — it is the FROM side of a relationship to '{other}', \
                         so filters flow out of it and it is the grain of the model",
                        conflict.table
                    ),
                    None => format!(
                        "no active many-to-one or one-to-one relationship points at '{}', so the \
                         model cannot look it up",
                        conflict.table
                    ),
                };
                out.push(Finding::error(
                    "authored-kind-contradicts-topology",
                    path,
                    format!(
                        "'{}' is declared '{kind}', which says the model looks this table up. But \
                         {topology}. A kind is not overruled here the way a heuristic is: \
                         direction is something the relationships DISPROVE. Change the kind, or \
                         add the relationship that would make it true",
                        conflict.table
                    ),
                ));
            }
            // Ambiguity refuses BOTH declarations, exactly as it does when the
            // heuristic finds two candidate calendars: picking the one that
            // sorted first would make what "time" means in a report depend on a
            // table name.
            //
            // WHETHER THAT COSTS THE MODEL ITS TIME AXIS IS A SEPARATE QUESTION,
            // and this finding used to assert the answer instead of asking it -
            // then asked a NARROWER question than the run does. What decides the
            // report is `plan_time_axis`, which takes `doc.model.defaultTimeAxis`
            // first and a surviving calendar's date column second, so a document
            // that declares an axis keeps every trend in the report even with
            // both its calendars thrown out. `surviving_time_axis` asks that
            // question; asking `effective_date_table` alone produced the error
            // below - "this model has no time axis at all" - on runs that
            // reported trend, change point AND seasonality for every measure.
            //
            // The severity follows this file's own rule, and follows it the same
            // way the sibling finding below does. A surviving axis means nothing
            // said becomes false and nothing is withheld; the document is merely
            // LESS than its author intended, so it warns and saves - which is
            // exactly the call `authored-calendar-is-not-the-date-table` makes
            // when ONE authored calendar loses to the model's mark. No surviving
            // axis is the other case entirely: every trend, change point and
            // seasonality claim for every measure is withheld, which is the
            // withheld half of the error rule.
            KindRefusal::AmbiguousCalendar { other } => {
                let decision = "Which table time runs along is one decision; make it, and give \
                                the other one a different kind";
                match surviving_time_axis(facts, doc, authored) {
                    Some(axis) => {
                        let whose = match doc.model.default_time_axis.as_ref() {
                            Some(declared) if declared.table == axis => format!(
                                "this document's own defaultTimeAxis names '{declared}'"
                            ),
                            _ => match facts.calendar_source {
                                Some(CalendarSource::Declared) => {
                                    format!("the MODEL marks '{axis}' as its date table")
                                }
                                _ => format!(
                                    "with no declaration left standing the heuristic falls back \
                                     to '{axis}'"
                                ),
                            },
                        };
                        out.push(Finding::warning(
                            "two-authored-calendars",
                            path,
                            format!(
                                "'{}' and '{other}' are both declared 'calendar', so NEITHER is \
                                 used. Time still runs along '{axis}', because {whose} - so every \
                                 trend and seasonality claim in the report is computed there, not \
                                 on the table you declared. {decision}",
                                conflict.table
                            ),
                        ));
                    }
                    None => {
                        // AND THE RUN DOES SAY WHY, which this message used to
                        // deny. `kind_conflict_notes` (model_commands) turns
                        // this same `AmbiguousCalendar` refusal into a note
                        // naming both tables, and pushes it BEFORE the
                        // "no time axis" note - so the reader is told the cause
                        // and then the symptom. What they cannot do is FIX it
                        // from a report, which is what this finding is for.
                        out.push(Finding::error(
                            "two-authored-calendars",
                            path,
                            format!(
                                "'{}' and '{other}' are both declared 'calendar', so neither is \
                                 used - and nothing else names a calendar or an axis either, so \
                                 this model has no time axis at all. No trend, change point or \
                                 seasonality is reported for any measure. {decision}",
                                conflict.table
                            ),
                        ));
                    }
                }
            }
        }
    }

    // AN AUTHORED CALENDAR THAT IS NOT THE MODEL'S OWN. The declaration stands —
    // the engine's time intelligence resolves against `model.date_table()` and
    // nothing else — so this cannot be silent: the tab would show 'calendar' on
    // a row that is not, in fact, the calendar the report walks.
    if facts.calendar_source == Some(CalendarSource::Declared) {
        if let (Some(chosen), Some(declared)) = (&authored.calendar, facts.date_table.as_deref()) {
            if chosen != declared {
                out.push(Finding::warning(
                    "authored-calendar-is-not-the-date-table",
                    format!("tables['{chosen}'].kind"),
                    format!(
                        "'{chosen}' is declared 'calendar' here, but the MODEL marks '{declared}' \
                         as its date table, and that mark wins: the engine's own time intelligence \
                         (TOTALYTD, DATEADD) resolves against it and cannot be pointed elsewhere \
                         from this document. Time still runs along '{declared}'. Change the mark in \
                         the Model Editor's Settings tab if '{chosen}' is the calendar"
                    ),
                ));
            }
        }
    }
}

/// Validate a whole document against the model it annotates.
pub fn validate(facts: &ModelFacts, doc: &StrategyDoc) -> Vec<Finding> {
    let mut out: Vec<Finding> = Vec::new();

    // ONCE. Judging the authored table kinds walks every table, every
    // relationship and the whole lookup set; it was being done twice per
    // validation - here for the time axis and again inside
    // `validate_table_kinds` - and two calls are also two chances for the two
    // sites to be given different documents. Both readers take this one.
    let authored = authored_table_kinds(facts, doc);

    // --- the document's own version -----------------------------------------
    //
    // A CLOSED SET OF EXACTLY ONE THAT NOTHING CHECKED. `{"version": 99}`
    // parsed and was then applied as if it were version 1: every rule, every
    // direction, every materiality read by a reader that has no idea what 99
    // was supposed to mean. That is the "confidently wrong" case, not the
    // "less good" one, so it is an error.
    //
    // Deliberately NOT a validating `Deserialize` on the field, unlike the
    // scalar formats: a version this reader cannot understand should produce a
    // finding with a PATH the Strategy tab can anchor to a row, rather than
    // discarding the whole document as unreadable.
    if doc.version != STRATEGY_DOC_VERSION {
        out.push(Finding::error(
            "unsupported-document-version",
            "version".into(),
            format!(
                "the document declares version {} and this build understands version {}. A \
                 document from a newer schema is not readable by pretending it is the old one: \
                 every field this reader does not know about would be silently dropped on the \
                 next save",
                doc.version, STRATEGY_DOC_VERSION
            ),
        ));
    }

    // --- model-wide ----------------------------------------------------------
    if let Some(axis) = &doc.model.default_time_axis {
        if !facts.has_column(axis) {
            out.push(Finding::error(
                "unknown-column",
                "model.defaultTimeAxis".into(),
                format!("the default time axis '{axis}' is not a column in the model"),
            ));
        } else if effective_date_table(facts, &authored) != Some(axis.table.as_str()) {
            // AGAINST THE CALENDAR THIS DOCUMENT ACTUALLY PRODUCES, not against
            // `facts.date_table` as passed in. A person who fixed the detection
            // by declaring `kind: "calendar"` on the right table, and then
            // pointed the axis at it, was told their own two edits disagreed.
            out.push(Finding::warning(
                "time-axis-not-date-table",
                "model.defaultTimeAxis".into(),
                format!(
                    "the default time axis '{axis}' is not in this model's calendar, so \
                     time intelligence will not use it"
                ),
            ));
        }
    }
    // `fiscalYearStart` and `reportingCurrency` USED TO BE CHECKED HERE and are
    // not any more: they are `MonthDay` and `CurrencyCode`, so a malformed value
    // cannot reach a `StrategyDoc` at all. The check that lived here protected
    // the two write gates and not the run path, which is exactly the asymmetry
    // the types remove. Nothing reads either field yet - the run walks whatever
    // periods the series query returns and never asks where the fiscal year
    // starts - which is why the guard belongs on the type rather than in a
    // finding a future consumer might not run. (It does not "bucket by cadence"
    // either: `ResolvedMeasure.cadence` is written by `resolve` and read by
    // NOTHING on the run path - not model.rs, not model_commands.rs, not
    // report.rs. Saying so here sent a reader looking for a bucketing step that
    // does not exist.)
    //
    // The model block is warned about exactly like a measure or a table row,
    // because it now carries the same `reviewed` flag they do - and because
    // `defaultTimeAxis` may be a calendar `facts.rs` GUESSED, which is the one
    // value in this document a person most needs to be asked to accept.
    if !doc.model.reviewed {
        out.push(Finding::warning(
            "unreviewed",
            "model".into(),
            "the model-wide defaults have not been reviewed by a human".to_string(),
        ));
    }
    for (i, m) in doc.model.priority.iter().enumerate() {
        if !facts.measures.contains_key(m) {
            out.push(Finding::error(
                "unknown-measure",
                format!("model.priority[{i}]"),
                format!("priority names '{m}', which is not a measure in the model"),
            ));
        }
    }

    // --- tables --------------------------------------------------------------
    validate_table_kinds(facts, doc, &authored, &mut out);
    for (table, ts) in &doc.tables {
        let path = format!("tables['{table}']");
        if !facts.has_table(table) {
            out.push(Finding::warning(
                "orphan-table",
                path,
                format!("'{table}' has a strategy entry but no longer exists in the model"),
            ));
            continue;
        }
        if !ts.reviewed {
            out.push(Finding::warning(
                "unreviewed",
                path.clone(),
                format!("'{table}' has not been reviewed by a human"),
            ));
        }
        if let Some(label) = &ts.label_column {
            if !facts.has_column(&QualifiedColumn::new(table, label)) {
                out.push(Finding::error(
                    "unknown-column",
                    format!("{path}.labelColumn"),
                    format!("'{table}' names label column '{label}', which does not exist"),
                ));
            }
        }
        for column in ts.columns.keys() {
            if !facts.has_column(&QualifiedColumn::new(table, column)) {
                out.push(Finding::error(
                    "unknown-column",
                    format!("{path}.columns['{column}']"),
                    format!("'{table}' has no column '{column}'"),
                ));
            }
        }
        for (h, chain) in ts.hierarchies.iter().enumerate() {
            for column in chain {
                if !facts.has_column(&QualifiedColumn::new(table, column)) {
                    out.push(Finding::error(
                        "unknown-column",
                        format!("{path}.hierarchies[{h}]"),
                        format!("hierarchy names '{table}[{column}]', which does not exist"),
                    ));
                }
            }
        }
    }

    // --- measures ------------------------------------------------------------
    for (measure, ms) in &doc.measures {
        let path = format!("measures['{measure}']");
        let Some(mf) = facts.measures.get(measure) else {
            out.push(Finding::warning(
                "orphan-measure",
                path,
                format!("'{measure}' has a strategy entry but no longer exists in the model"),
            ));
            continue;
        };
        if !ms.reviewed {
            out.push(Finding::warning(
                "unreviewed",
                path.clone(),
                format!("'{measure}' has not been reviewed by a human"),
            ));
        }

        // The contradiction that produces a confidently backwards sentence.
        //
        // The KPI's own answer comes from the ORDER ITS BAND STATUSES RUN IN, not
        // from its thresholds: the engine refuses a KPI whose thresholds do not
        // ascend, so a threshold-only reading called every KPI higher-is-better
        // and this check could never fire against a churn KPI.
        if let (Some(declared), Some(kpi)) = (ms.direction, mf.kpi.as_ref()) {
            let derived = kpi.direction();
            let opposed = matches!(
                (declared, derived),
                (Direction::LowerIsBetter, Some(Direction::HigherIsBetter))
                    | (Direction::HigherIsBetter, Some(Direction::LowerIsBetter))
            );
            if opposed {
                let derived = derived.expect("opposed implies a derived direction");
                out.push(Finding::error(
                    "direction-contradicts-kpi",
                    format!("{path}.direction"),
                    format!(
                        "measure '{measure}' is declared {}, but its own KPI '{}' has bands \
                         {} - whose statuses say {} as the ratio grows. One of the two is \
                         wrong and the engine must not choose",
                        direction_label(declared),
                        kpi.name,
                        kpi.band_summary(),
                        direction_label(derived),
                    ),
                ));
            }
        }

        // TWO PLACES TO DEFINE A TARGET IS TWO PLACES FOR IT TO DRIFT. A literal
        // in the strategy entry beside a constant on the model's KPI means the
        // variance line and the KPI badge on the same measure disagree, silently,
        // in the same report. `{"type": "kpi"}` is the spelling that cannot drift.
        if let (Some(Target::Literal { value }), Some(kpi)) = (&ms.target, mf.kpi.as_ref()) {
            if let Some(kpi_target) = kpi.target {
                let scale = value.abs().max(kpi_target.abs()).max(1.0);
                if (value - kpi_target).abs() > 1e-9 * scale {
                    out.push(Finding::error(
                        "target-contradicts-kpi",
                        format!("{path}.target"),
                        format!(
                            "'{measure}' declares the literal target {value} in the strategy \
                             document, but the model's KPI '{}' declares the constant target \
                             {kpi_target}. Two definitions of one goal drift apart; write \
                             {{\"type\": \"kpi\"}} to inherit the KPI's, or change the KPI",
                            kpi.name
                        ),
                    ));
                }
            }
        }

        if let Some(agg) = ms.aggregation.as_ref() {
            validate_aggregation(facts, agg, &format!("{path}.aggregation"), &mut out);
        }
        if ms.direction == Some(Direction::TargetBand) {
            check_band_direction(
                doc,
                measure,
                &format!("measure '{measure}'"),
                format!("{path}.direction"),
                &mut out,
            );
        }
        if let Some(target) = &ms.target {
            validate_target(
                facts,
                measure,
                target,
                &format!("measure '{measure}'"),
                format!("{path}.target"),
                &mut out,
            );
        }

        // What the EXECUTOR can join in one hop, which is what the planner may
        // ask for. Wider reachability is used further down for a different
        // question and must not be confused with this one.
        let one_hop = mf
            .fact_table
            .as_ref()
            .map(|t| facts.directly_related_tables(t))
            .unwrap_or_default();

        for (i, col) in ms.analysis_dimensions.iter().enumerate() {
            let p = format!("{path}.analysisDimensions[{i}]");
            if !facts.has_column(col) {
                out.push(Finding::error(
                    "unknown-column",
                    p,
                    format!("'{col}' is not a column in the model"),
                ));
                continue;
            }
            // A snowflaked attribute is REPORTED, not dropped. The whole reason
            // this is a warning rather than an error is that the document is
            // right about what the user wants and the engine is what cannot do
            // it yet; refusing the document would make the author delete a true
            // statement to work around a limitation.
            if !one_hop.is_empty() && !one_hop.contains(&col.table) {
                out.push(Finding::warning(
                    "unreachable-in-v1",
                    p.clone(),
                    format!(
                        "'{col}' is not on a table directly related to '{measure}'s fact table, \
                         and the query engine refuses relationship paths longer than one hop, so \
                         this breakdown cannot be computed yet"
                    ),
                ));
            }
            // A LABEL IS NOT AN ANALYSIS DIMENSION, AND A KEY NEVER WAS.
            //
            // A label is what a reader recognises ONE ROW by, so breaking a
            // measure down by it produces one fact per record: a report that is
            // technically true and completely useless. The role arm below has
            // refused `label` from the start; what is added here is the table's
            // `labelColumn` POINTER, which says the same thing about a column
            // the document never gave a role of its own.
            //
            // The pointer is the WEAKER of the two declarations and is treated
            // that way. `role` is a statement about one column; `labelColumn` is
            // written by `infer` from a NAME HEURISTIC (`label_score`: does the
            // last word read as "name"), and refusing a document outright on a
            // name heuristic is the confident-wrong this layer exists to avoid.
            // So an explicit `analysis`, `filter` or `hierarchy` role on the same
            // column WINS: that is a person stating, with the data in front of
            // them, that this column really is an axis - the cardinality call
            // nothing in this codebase can make on its own.
            let is_label_column = doc
                .tables
                .get(&col.table)
                .and_then(|t| t.label_column.as_deref())
                == Some(col.column.as_str());
            let refusal: Option<String> = match doc.role_of(col) {
                Some(role) if matches!(role, Role::Key | Role::Label | Role::Ignore) => {
                    Some(format!(
                        "'{col}' is declared as a {} column",
                        serde_json::to_string(&role).unwrap_or_default().trim_matches('"')
                    ))
                }
                None if is_label_column => Some(format!(
                    "'{col}' is the label column of table '{}' - what a reader recognises one \
                     of its rows by - and the document declares no role of its own for it",
                    col.table
                )),
                _ => None,
            };
            // A hierarchy level is an axis whoever declared the hierarchy said
            // was one, in the document or in the model, and that outranks both
            // spellings above - exactly as it already did for the role alone.
            if let Some(reason) = refusal {
                if !in_a_hierarchy(facts, doc, col) {
                    out.push(Finding::error(
                        "analysis-dimension-role",
                        p,
                        format!(
                            "{reason}, so breaking '{measure}' down by it produces one row per \
                             record rather than an insight"
                        ),
                    ));
                }
            }
        }

        let reachable = mf
            .fact_table
            .as_ref()
            .map(|t| facts.reachable_tables(t))
            .unwrap_or_default();
        for (i, col) in ms.never_slice_by.iter().enumerate() {
            let p = format!("{path}.neverSliceBy[{i}]");
            if !facts.has_column(col) {
                out.push(Finding::error(
                    "unknown-column",
                    p,
                    format!("'{col}' is not a column in the model"),
                ));
                continue;
            }
            // ONE COLUMN, TWO CONTRADICTORY STATEMENTS, AND A SECTION THAT JUST
            // IS NOT THERE. `plan_dimensions` skips a dimension that is also
            // forbidden, so the breakdown the document asked for is silently
            // absent from the report - a withheld fact, which this file's rule
            // makes an error rather than a warning. The prohibition is the safe
            // half to honour and the engine does honour it; what it cannot do is
            // decide which of the two statements the author meant.
            if ms.analysis_dimensions.contains(col) {
                out.push(Finding::error(
                    "contradictory-analysis-dimension",
                    p.clone(),
                    format!(
                        "'{measure}' lists '{col}' as an analysis dimension AND forbids slicing \
                         by it. The prohibition wins, so the breakdown the document asks for is \
                         missing from the report with nothing saying why. Remove one of the two \
                         statements"
                    ),
                ));
            }
            if !reachable.is_empty() && !reachable.contains(&col.table) {
                out.push(Finding::warning(
                    "unreachable-never-slice-by",
                    p,
                    format!(
                        "'{measure}' forbids slicing by '{col}', but no relationship path reaches \
                         '{}' from its fact table, so nothing could have sliced by it anyway",
                        col.table
                    ),
                ));
            }
        }
    }

    // --- rules ---------------------------------------------------------------
    let mut seen_ids: BTreeMap<&str, usize> = BTreeMap::new();
    // A column constrained as members here and as a date range there cannot be
    // reconciled by enumeration, which forces overlap.rs into its conservative
    // branch and reports collisions that may not exist.
    let mut constraint_kinds: BTreeMap<QualifiedColumn, BTreeSet<&'static str>> = BTreeMap::new();

    for (i, rule) in doc.rules.iter().enumerate() {
        let path = format!("rules[{i}]");
        *seen_ids.entry(rule.id.as_str()).or_insert(0) += 1;
        // AN ID IS HOW A FINDING NAMES THE RULE THAT PRODUCED IT, and how a test
        // says which rule it expects to decide something. A blank one is not a
        // cosmetic problem: `decidedBy: ""` would match it, the suppression
        // reason would read "rule '' sets ...", and the overlap checker would
        // report a collision between two rules the reader cannot tell apart.
        // Uniqueness was checked from the start and existence never was.
        if rule.id.trim().is_empty() {
            out.push(Finding::error(
                "blank-rule-id",
                format!("{path}.id"),
                "a rule's id is blank; ids are how a finding, a suppression reason and a test's \
                 `decidedBy` name the rule that produced an answer, so a rule without one \
                 produces answers nobody can trace"
                    .to_string(),
            ));
        }
        if !facts.measures.contains_key(&rule.measure) {
            out.push(Finding::error(
                "unknown-measure",
                path.clone(),
                format!(
                    "rule '{}' annotates measure '{}', which is not in the model",
                    rule.id, rule.measure
                ),
            ));
        }
        if rule.set.is_empty() {
            out.push(Finding::warning(
                "empty-rule",
                path.clone(),
                format!("rule '{}' sets nothing, so it has no effect", rule.id),
            ));
        }
        if let Some(target) = &rule.set.target {
            validate_target(
                facts,
                &rule.measure,
                target,
                &format!("rule '{}'", rule.id),
                format!("{path}.set.target"),
                &mut out,
            );
        }
        // A RULE'S OWN DIRECTION WAS NEVER LOOKED AT. The loop checked the
        // rule's measure, its target and its aggregation and skipped
        // `set.direction` entirely, so `targetBand` written on a rule was the
        // one spelling of the band defect nothing reported at all.
        if rule.set.direction == Some(Direction::TargetBand) {
            check_band_direction(
                doc,
                &rule.measure,
                &format!("rule '{}'", rule.id),
                format!("{path}.set.direction"),
                &mut out,
            );
        }
        // `unknown-fact-kind` USED TO LIVE HERE. A fact kind nobody emits
        // withholds nothing, so the fact the author asked to hide was PUBLISHED
        // - a silent no-op wearing the appearance of an instruction. It is now
        // structurally impossible: `suppress` is `Vec<SuppressibleFactKind>` and
        // serde refuses the document with "unknown variant `outlier`, expected
        // one of ..." before this function is ever called. The check the enum
        // does NOT subsume - a kind that exists but this particular run never
        // emits - has no instances: the vocabulary is diffed against the
        // emitter, in both directions, by a test in `insights::model`.
        if let Some(agg) = rule.set.aggregation.as_ref() {
            // A rule can override aggregation too, and a typo there is the same
            // silent fallback - narrowed to one scope, which makes it harder to
            // notice rather than easier.
            validate_aggregation(facts, agg, &format!("{path}.set.aggregation"), &mut out);
        }
        for (col, v) in &rule.scope {
            constraint_kinds.entry(col.clone()).or_default().insert(match v {
                ScopeValue::Members(_) => "members",
                ScopeValue::DateRange { .. } => "dateRange",
            });
        }
        validate_scope(facts, doc, &rule.scope, &format!("{path}.scope"), &mut out);
    }
    for (id, count) in seen_ids {
        if count > 1 {
            out.push(Finding::error(
                "duplicate-rule-id",
                "rules".into(),
                format!(
                    "rule id '{id}' is used {count} times; ids are how a finding names the rule \
                     that produced it, so they must be unique"
                ),
            ));
        }
    }
    for (col, kinds) in constraint_kinds {
        if kinds.len() > 1 {
            out.push(Finding::warning(
                "mixed-scope-constraint",
                "rules".into(),
                format!(
                    "'{col}' is constrained as a member list in one rule and as a date range in \
                     another; the overlap checker cannot prove those disjoint and will report \
                     collisions conservatively"
                ),
            ));
        }
    }

    // --- periods -------------------------------------------------------------
    let mut period_ids: BTreeMap<&str, usize> = BTreeMap::new();
    for (i, p) in doc.periods.iter().enumerate() {
        let path = format!("periods[{i}]");
        *period_ids.entry(p.id.as_str()).or_insert(0) += 1;
        if let Some(m) = &p.measure {
            if !facts.measures.contains_key(m) {
                out.push(Finding::error(
                    "unknown-measure",
                    path.clone(),
                    format!("period '{}' annotates measure '{m}', which is not in the model", p.id),
                ));
            }
        }
        validate_scope(facts, doc, &p.scope, &format!("{path}.scope"), &mut out);
    }
    for (id, count) in period_ids {
        if count > 1 {
            // A WARNING WHERE THE RULE EQUIVALENT IS AN ERROR, deliberately.
            // A rule id is REFERENCED - by a finding, by a suppression reason,
            // by a test's `decidedBy` - so two rules sharing one make an answer
            // untraceable. Nothing anywhere references a period id: the
            // annotation reaches the narrative layer by its scope, not by its
            // name. Two duplicates therefore change no fact the planner emits,
            // which under this file's rule is the definition of a warning.
            out.push(Finding::warning(
                "duplicate-period-id",
                "periods".into(),
                format!("period id '{id}' is used {count} times"),
            ));
        }
    }

    // --- tests ---------------------------------------------------------------
    for (i, t) in doc.tests.iter().enumerate() {
        let path = format!("tests[{i}]");
        if !facts.measures.contains_key(&t.measure) {
            out.push(Finding::error(
                "unknown-measure",
                path.clone(),
                format!("the test names measure '{}', which is not in the model", t.measure),
            ));
        }
        if let Some(rule_id) = &t.expect.decided_by {
            if !doc.rules.iter().any(|r| &r.id == rule_id) {
                out.push(Finding::error(
                    "unknown-rule",
                    format!("{path}.expect.decidedBy"),
                    format!("the test expects rule '{rule_id}' to decide it, but no such rule exists"),
                ));
            }
        }
        validate_scope(facts, doc, &t.scope, &format!("{path}.scope"), &mut out);
    }

    // --- overlaps ------------------------------------------------------------
    for conflict in check_overlaps(doc) {
        out.push(Finding::error("rule-overlap", "rules".into(), conflict.message()));
    }

    // --- the consultant's own assertions -------------------------------------
    out.extend(run_inline_tests(facts, doc));

    // --- size ----------------------------------------------------------------
    match serde_json::to_vec(doc) {
        Ok(bytes) if bytes.len() > MAX_STRATEGY_DOC_BYTES => out.push(Finding::error(
            "document-too-large",
            "".into(),
            // NOTHING TRUNCATES, and this message used to say a document that
            // does not fit is stored truncated. The over-cap write is REFUSED:
            // `bi/model_editor.rs` returns an error for an extension-data value
            // past the quota, and refusing rather than trimming is the whole
            // reason the constant's own comment gives for the cap being checked
            // here. Telling a person their file was silently cut short sends
            // them looking for the missing half of a document that was never
            // written.
            format!(
                "the document serializes to {} bytes, over the {MAX_STRATEGY_DOC_BYTES}-byte \
                 per-key extension-data cap; a document that does not fit is REFUSED rather \
                 than trimmed, so nothing is stored until it is smaller. Shorten the prose in \
                 `note` and `context`, or split rules that say the same thing",
                bytes.len()
            ),
        )),
        Ok(_) => {}
        Err(e) => out.push(Finding::error(
            "unserializable",
            "".into(),
            format!("the document cannot be serialized: {e}"),
        )),
    }

    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::insights::strategy::resolve::{
        BandStatus, KpiBand, KpiFacts, MeasureFacts, TableFacts,
    };
    // The planner itself, so a claim about what a report says can be PROVED
    // here rather than asserted about a mirror of it.
    use crate::insights::model::{facts_for_measure, MeasureObservation, ModelFactKind};
    use crate::insights::strategy::resolve::{Applied, AttrSource, Suppression};
    use engine::LocaleSettings;
    use crate::insights::strategy::types::{
        Additivity, AttributeSet, Cadence, ColumnStrategy, EntrySource, MeasureStrategy,
        PeriodAnnotation, Rule, StrategyTest, SuppressibleFactKind, TableStrategy, TestExpect,
    };

    fn col(t: &str, c: &str) -> QualifiedColumn {
        QualifiedColumn::new(t, c)
    }

    fn facts() -> ModelFacts {
        ModelFacts {
            measures: BTreeMap::from([
                (
                    "Returns".to_string(),
                    MeasureFacts {
                        fact_table: Some("Sales".into()),
                        unit: None,
                        kpi: None,
                    },
                ),
                (
                    "Churn".to_string(),
                    MeasureFacts {
                        fact_table: Some("Sales".into()),
                        unit: None,
                        kpi: Some(KpiFacts {
                            name: "Churn KPI".into(),
                            target: Some(0.9),
                            // A REAL churn KPI. The thresholds ascend because the
                            // engine's builder refuses any other order; the
                            // STATUSES worsen, which is the only thing in a KPI
                            // that says lower is better.
                            bands: vec![
                                KpiBand::new(0.5, BandStatus::OnTrack),
                                KpiBand::new(0.7, BandStatus::AtRisk),
                                KpiBand::new(0.9, BandStatus::OffTrack),
                            ],
                        }),
                    },
                ),
            ]),
            tables: BTreeMap::from([
                (
                    "Sales".to_string(),
                    TableFacts {
                        kind: None,
                        columns: BTreeSet::from([
                            "InvoiceId".to_string(),
                            "DeptKey".to_string(),
                            "Amount".to_string(),
                        ]),
                        members: BTreeMap::new(),
                        hierarchies: Vec::new(),
                    },
                ),
                (
                    "Dim".to_string(),
                    TableFacts {
                        kind: None,
                        columns: BTreeSet::from(["Dept".to_string(), "DeptKey".to_string()]),
                        members: BTreeMap::from([(
                            "Dept".to_string(),
                            vec!["Refunds".to_string(), "Retail".to_string()],
                        )]),
                        hierarchies: Vec::new(),
                    },
                ),
                (
                    "Far".to_string(),
                    TableFacts {
                        kind: None,
                        columns: BTreeSet::from(["Note".to_string()]),
                        members: BTreeMap::new(),
                        hierarchies: Vec::new(),
                    },
                ),
            ]),
            date_table: None,
            // No calendar at all, so no provenance for one either: the two
            // fields are absent together or present together.
            calendar_source: None,
            relationships: vec![(col("Sales", "DeptKey"), col("Dim", "DeptKey"))],
            // Sales looks Dim up, and nothing looks Sales up. That asymmetry is
            // what makes an authored `dimension` on Sales a claim the model
            // disproves, and it is the whole input to `validate_table_kinds`.
            lookup_tables: BTreeSet::from(["Dim".to_string()]),
        }
    }

    /// `facts()` plus a second lookup table that could be a calendar.
    ///
    /// The base fixture has exactly one table anything looks up, and half the
    /// table-kind cases need two: one to be the calendar and one to be wrong
    /// about.
    fn facts_with_two_lookups() -> ModelFacts {
        let mut facts = facts();
        facts
            .tables
            .get_mut("Sales")
            .expect("the fixture has a Sales table")
            .columns
            .insert("DateKey".to_string());
        facts.tables.insert(
            "Cal".to_string(),
            TableFacts {
                kind: Some(TableKind::Dimension),
                columns: BTreeSet::from(["Date".to_string(), "Month".to_string()]),
                members: BTreeMap::new(),
                hierarchies: Vec::new(),
            },
        );
        facts
            .relationships
            .push((col("Sales", "DateKey"), col("Cal", "Date")));
        facts.lookup_tables.insert("Cal".to_string());
        facts
    }

    /// A document entry a PERSON wrote: `source` absent or `Authored`, never
    /// `Inferred`. Only these overrule the model.
    fn authored_kind(kind: TableKind) -> TableStrategy {
        TableStrategy {
            kind: Some(kind),
            reviewed: true,
            source: Some(EntrySource::Authored),
            ..Default::default()
        }
    }

    /// A document that validates clean: reviewed, roles declared, no rules.
    fn clean_doc() -> StrategyDoc {
        let mut doc = StrategyDoc::default();
        doc.tables.insert(
            "Dim".into(),
            TableStrategy {
                columns: BTreeMap::from([
                    (
                        "Dept".to_string(),
                        ColumnStrategy {
                            role: Role::Analysis,
                            priority: None,
                        },
                    ),
                    (
                        "DeptKey".to_string(),
                        ColumnStrategy {
                            role: Role::Key,
                            priority: None,
                        },
                    ),
                ]),
                reviewed: true,
                ..Default::default()
            },
        );
        doc.tables.insert(
            "Sales".into(),
            TableStrategy {
                columns: BTreeMap::from([(
                    "InvoiceId".to_string(),
                    ColumnStrategy {
                        role: Role::Key,
                        priority: None,
                    },
                )]),
                reviewed: true,
                ..Default::default()
            },
        );
        doc.measures.insert(
            "Returns".into(),
            MeasureStrategy {
                direction: Some(Direction::LowerIsBetter),
                reviewed: true,
                ..Default::default()
            },
        );
        doc
    }

    fn codes(findings: &[Finding], severity: Severity) -> Vec<&str> {
        findings
            .iter()
            .filter(|f| f.severity == severity)
            .map(|f| f.code.as_str())
            .collect()
    }

    #[test]
    fn a_clean_document_produces_no_errors() {
        let findings = validate(&facts(), &clean_doc());
        assert_eq!(
            codes(&findings, Severity::Error),
            Vec::<&str>::new(),
            "unexpected errors: {findings:?}"
        );
        assert!(!is_refused(&findings));
    }

    // --- the table kinds a person typed --------------------------------------

    #[test]
    fn an_authored_dimension_on_a_table_nothing_looks_up_is_refused_and_names_the_join() {
        // THE CASE THE WHOLE SEAM TURNS ON. `dimension` and `calendar` both say
        // "the model can look this table up", and the fixture's Sales table is
        // the one filters flow OUT of. That is not a heuristic disagreeing with
        // a person; it is the relationship graph disproving them, so it refuses
        // instead of applying.
        let mut doc = clean_doc();
        let sales = doc.tables.get_mut("Sales").expect("clean_doc has a Sales entry");
        sales.kind = Some(TableKind::Dimension);
        sales.source = Some(EntrySource::Authored);

        let findings = validate(&facts(), &doc);
        let f = findings
            .iter()
            .find(|f| f.code == "authored-kind-contradicts-topology")
            .unwrap_or_else(|| panic!("no topology finding in {findings:?}"));
        assert_eq!(f.severity, Severity::Error);
        assert_eq!(f.path, "tables['Sales'].kind");
        assert!(f.message.contains("'Sales'"), "{}", f.message);
        assert!(
            f.message.contains("'Dim'"),
            "the finding has to name the join that disproves it: {}",
            f.message
        );
        assert!(is_refused(&findings));
    }

    #[test]
    fn an_authored_calendar_on_the_same_table_is_refused_for_the_same_reason() {
        // Calendar is the other lookup claim, and it is the one a person is most
        // likely to type: a wide fact table carrying an order date LOOKS like a
        // calendar, which is exactly why `infer_date_table` refuses one too.
        let mut doc = clean_doc();
        let sales = doc.tables.get_mut("Sales").expect("clean_doc has a Sales entry");
        sales.kind = Some(TableKind::Calendar);
        sales.source = Some(EntrySource::Authored);
        assert!(codes(&validate(&facts(), &doc), Severity::Error)
            .contains(&"authored-kind-contradicts-topology"));
    }

    #[test]
    fn a_kind_that_claims_no_lookup_is_accepted_wherever_it_is_written() {
        // The other half, and it is not a courtesy: `fact`, `bridge` and `other`
        // assert nothing a relationship can contradict - and `infer_table`
        // branches on neither of them, so applying one changes nothing a report
        // can see. A finding here would refuse a document for saying something
        // harmless.
        let mut doc = clean_doc();
        let dim = doc.tables.get_mut("Dim").expect("clean_doc has a Dim entry");
        dim.kind = Some(TableKind::Fact);
        dim.source = Some(EntrySource::Authored);
        let findings = validate(&facts(), &doc);
        assert_eq!(
            codes(&findings, Severity::Error),
            Vec::<&str>::new(),
            "unexpected errors: {findings:?}"
        );
    }

    #[test]
    fn a_kind_the_draft_inferred_is_not_a_statement_and_is_neither_applied_nor_refused() {
        // `infer` writes the DERIVED kind into every table of the draft. Reading
        // that copy back as a claim would let a document drafted against last
        // month's model overrule this month's relationship graph - so an
        // `inferred` entry is ignored, and ignoring it is not a finding either.
        let mut doc = clean_doc();
        let sales = doc.tables.get_mut("Sales").expect("clean_doc has a Sales entry");
        sales.kind = Some(TableKind::Dimension);
        sales.source = Some(EntrySource::Inferred);
        let findings = validate(&facts(), &doc);
        assert!(
            !codes(&findings, Severity::Error).contains(&"authored-kind-contradicts-topology"),
            "{findings:?}"
        );
    }

    #[test]
    fn two_authored_calendars_are_refused_and_each_names_the_other() {
        // Ambiguity refuses, exactly as it does in `infer_date_table`. Picking
        // the one that sorted first would make what "time" means in a report
        // depend on a table name.
        let mut doc = clean_doc();
        doc.tables.insert("Cal".into(), authored_kind(TableKind::Calendar));
        let dim = doc.tables.get_mut("Dim").expect("clean_doc has a Dim entry");
        dim.kind = Some(TableKind::Calendar);
        dim.source = Some(EntrySource::Authored);

        let findings = validate(&facts_with_two_lookups(), &doc);
        let refused: Vec<&Finding> = findings
            .iter()
            .filter(|f| f.code == "two-authored-calendars")
            .collect();
        assert_eq!(
            refused.iter().map(|f| f.path.as_str()).collect::<Vec<_>>(),
            vec!["tables['Cal'].kind", "tables['Dim'].kind"],
            "both are refused, not one: {findings:?}"
        );
        assert!(refused[0].message.contains("'Dim'"), "{}", refused[0].message);
        assert!(refused[1].message.contains("'Cal'"), "{}", refused[1].message);
        // AN ERROR *BECAUSE* NOTHING ELSE NAMES A CALENDAR. `facts()` marks no
        // date table and the fixture's names defeat the heuristic, so throwing
        // both declarations out really does leave the model with no time axis -
        // every trend, change point and seasonality claim silently absent, which
        // is the withheld half of this file's severity rule.
        assert!(
            refused.iter().all(|f| f.severity == Severity::Error),
            "with no surviving calendar this must refuse the save: {findings:?}"
        );
        assert!(
            refused[0].message.contains("no time axis at all"),
            "{}",
            refused[0].message
        );
        assert!(is_refused(&findings));
    }

    #[test]
    fn two_authored_calendars_only_warn_while_the_model_still_has_a_calendar() {
        // THE OTHER ARM, AND THE MESSAGE THAT WAS FALSE. "Neither is used and
        // this model has no time axis at all" was pushed unconditionally, and
        // `facts_from_model_with` tries `model.date_table()` FIRST and
        // `infer_date_table` LAST - so with both authored calendars refused the
        // model very often keeps a perfectly good axis. Nothing is withheld and
        // nothing is false there; the document is merely less than its author
        // intended, which is a warning under the same rule that makes ONE losing
        // authored calendar a warning. No test covered this because the fixture
        // left `date_table` unset.
        let mut doc = clean_doc();
        doc.tables.insert("Cal".into(), authored_kind(TableKind::Calendar));
        let dim = doc.tables.get_mut("Dim").expect("clean_doc has a Dim entry");
        dim.kind = Some(TableKind::Calendar);
        dim.source = Some(EntrySource::Authored);

        // (i) the MODEL marks one. The mark wins, exactly as it does against a
        // single authored calendar.
        let mut facts = facts_with_two_lookups();
        facts.date_table = Some("Cal".to_string());
        facts.calendar_source = Some(CalendarSource::Declared);
        let findings = validate(&facts, &doc);
        let reported: Vec<&Finding> = findings
            .iter()
            .filter(|f| f.code == "two-authored-calendars")
            .collect();
        assert_eq!(reported.len(), 2, "both are still reported: {findings:?}");
        assert!(
            reported.iter().all(|f| f.severity == Severity::Warning),
            "time still runs along Cal, so nothing is wrong or withheld: {findings:?}"
        );
        assert!(
            reported[0].message.contains("Time still runs along 'Cal'")
                && reported[0].message.contains("the MODEL marks"),
            "the message must say where time actually runs: {}",
            reported[0].message
        );
        assert!(!is_refused(&findings), "a warning saves: {findings:?}");

        // (ii) nobody marked one, but the heuristic found one. Still an axis,
        // still a warning, and the message says whose answer is being used.
        facts.calendar_source = Some(CalendarSource::Inferred);
        let findings = validate(&facts, &doc);
        let reported: Vec<&Finding> = findings
            .iter()
            .filter(|f| f.code == "two-authored-calendars")
            .collect();
        assert!(
            reported.iter().all(|f| f.severity == Severity::Warning),
            "{findings:?}"
        );
        assert!(
            reported[0].message.contains("the heuristic falls back to 'Cal'"),
            "{}",
            reported[0].message
        );
        assert!(!is_refused(&findings));

        // (iii) NO CALENDAR SURVIVES AND THE DOCUMENT STILL HAS AN AXIS, which
        // is the case the previous repair got wrong one rung up: it asked
        // `effective_date_table` - "does a CALENDAR survive" - while the run asks
        // `plan_time_axis`, which reads `defaultTimeAxis` FIRST and only then
        // falls back to the calendar's date column. So a document naming its own
        // axis was told the model had "no time axis at all" while the run
        // reported trend, change point and seasonality for every measure.
        let mut axis_declared = facts_with_two_lookups();
        axis_declared.date_table = None;
        axis_declared.calendar_source = None;
        let mut with_axis = doc.clone();
        with_axis.model.default_time_axis = Some(col("Cal", "Date"));
        let findings = validate(&axis_declared, &with_axis);
        let reported: Vec<&Finding> = findings
            .iter()
            .filter(|f| f.code == "two-authored-calendars")
            .collect();
        assert_eq!(reported.len(), 2, "both are still reported: {findings:?}");
        assert!(
            reported.iter().all(|f| f.severity == Severity::Warning),
            "an axis survives, so nothing is withheld and the document saves: {findings:?}"
        );
        assert!(
            reported[0].message.contains("Time still runs along 'Cal'")
                && reported[0].message.contains("defaultTimeAxis"),
            "the message must name the declaration that supplied the axis: {}",
            reported[0].message
        );
        assert!(!is_refused(&findings));

        // ...and the SAME facts with the axis declaration taken away really do
        // leave the model with none, or the arm above would be passing on a
        // document that was never at risk.
        assert!(
            codes(&validate(&axis_declared, &doc), Severity::Error)
                .contains(&"two-authored-calendars"),
            "without defaultTimeAxis there is no axis left and it must refuse"
        );
    }

    #[test]
    fn an_authored_calendar_that_is_not_the_models_marked_date_table_warns_and_the_mark_wins() {
        // THE THIRD CASE, and the one with two human statements in it. The model
        // marks Dim; the document says Cal is the calendar. The mark wins,
        // because the ENGINE's time intelligence resolves against it and cannot
        // be pointed elsewhere from this document - so overriding it here would
        // plot the report along one table while TOTALYTD computed along another.
        // A warning rather than an error: nothing said becomes false, the
        // document still saves and publishes, and the reader is told which of
        // the two won.
        let mut facts = facts_with_two_lookups();
        facts.date_table = Some("Dim".to_string());
        facts.calendar_source = Some(CalendarSource::Declared);

        let mut doc = clean_doc();
        doc.tables.insert("Cal".into(), authored_kind(TableKind::Calendar));

        let findings = validate(&facts, &doc);
        let f = findings
            .iter()
            .find(|f| f.code == "authored-calendar-is-not-the-date-table")
            .unwrap_or_else(|| panic!("no disagreement warning in {findings:?}"));
        assert_eq!(f.severity, Severity::Warning);
        assert_eq!(f.path, "tables['Cal'].kind");
        assert!(f.message.contains("'Cal'") && f.message.contains("'Dim'"), "{}", f.message);
        assert!(!is_refused(&findings), "a warning saves: {findings:?}");
    }

    #[test]
    fn an_authored_calendar_agreeing_with_the_mark_says_nothing_at_all() {
        let mut facts = facts_with_two_lookups();
        facts.date_table = Some("Cal".to_string());
        facts.calendar_source = Some(CalendarSource::Declared);
        let mut doc = clean_doc();
        doc.tables.insert("Cal".into(), authored_kind(TableKind::Calendar));
        assert!(
            !validate(&facts, &doc)
                .iter()
                .any(|f| f.code == "authored-calendar-is-not-the-date-table"),
            "the document and the mark agree; there is nothing to report"
        );
    }

    #[test]
    fn the_time_axis_warning_is_measured_against_the_calendar_the_document_produces() {
        // The half-fix this guards against: wire the kind into the run but not
        // into the validator, and a person who declared the calendar AND pointed
        // the axis at it is told their own two edits disagree - on the very
        // document that fixed the problem.
        let facts = facts_with_two_lookups();
        let mut doc = clean_doc();
        doc.model.default_time_axis = Some(col("Cal", "Date"));

        assert!(
            codes(&validate(&facts, &doc), Severity::Warning).contains(&"time-axis-not-date-table"),
            "with no calendar anywhere, an axis on Cal really is off the calendar"
        );

        doc.tables.insert("Cal".into(), authored_kind(TableKind::Calendar));
        let after = validate(&facts, &doc);
        assert!(
            !codes(&after, Severity::Warning).contains(&"time-axis-not-date-table"),
            "the document names Cal as the calendar, so the axis is on it: {after:?}"
        );
    }

    #[test]
    fn a_rule_on_a_deleted_measure_is_refused() {
        let mut doc = clean_doc();
        doc.rules.push(Rule {
            id: "r1".into(),
            measure: "Gone".into(),
            scope: Scope::new(),
            set: AttributeSet {
                direction: Some(Direction::HigherIsBetter),
                ..Default::default()
            },
            note: None,
        });
        let findings = validate(&facts(), &doc);
        assert!(codes(&findings, Severity::Error).contains(&"unknown-measure"));
        assert!(is_refused(&findings));
    }

    #[test]
    fn a_key_column_cannot_scope_a_rule() {
        let mut doc = clean_doc();
        doc.rules.push(Rule {
            id: "r1".into(),
            measure: "Returns".into(),
            scope: Scope::from([(
                col("Sales", "InvoiceId"),
                ScopeValue::Members(vec!["INV-1".into()]),
            )]),
            set: AttributeSet {
                direction: Some(Direction::HigherIsBetter),
                ..Default::default()
            },
            note: None,
        });
        let findings = validate(&facts(), &doc);
        let f = findings
            .iter()
            .find(|f| f.code == "scope-column-role")
            .expect("a key column scoping a rule must be refused");
        assert_eq!(f.severity, Severity::Error);
        assert!(f.message.contains("Sales[InvoiceId]"));
    }

    #[test]
    fn an_analysis_dimension_that_is_a_key_is_refused() {
        let mut doc = clean_doc();
        doc.measures
            .get_mut("Returns")
            .unwrap()
            .analysis_dimensions
            .push(col("Sales", "InvoiceId"));
        let findings = validate(&facts(), &doc);
        assert!(codes(&findings, Severity::Error).contains(&"analysis-dimension-role"));
    }

    #[test]
    fn an_analysis_dimension_that_is_a_label_is_refused_by_role_and_by_the_tables_label_pointer() {
        // A label is what a reader recognises ONE ROW by. Breaking a measure
        // down by it produces one fact per record - true, and useless - so the
        // two roles are mutually exclusive by definition.

        // (a) The ROLE says label.
        let mut by_role = clean_doc();
        by_role.tables.get_mut("Dim").unwrap().columns.insert(
            "Dept".into(),
            ColumnStrategy {
                role: Role::Label,
                priority: None,
            },
        );
        by_role
            .measures
            .get_mut("Returns")
            .unwrap()
            .analysis_dimensions
            .push(col("Dim", "Dept"));
        let f = validate(&facts(), &by_role)
            .into_iter()
            .find(|f| f.code == "analysis-dimension-role")
            .expect("a label-role column must be refused as a breakdown");
        assert_eq!(f.severity, Severity::Error);
        assert!(
            f.message.contains("Dim[Dept]") && f.message.contains("label"),
            "the finding must name the column and the role: {}",
            f.message
        );

        // (b) The table's `labelColumn` POINTER says it, with no per-column role
        // anywhere - the ordinary shape of a hand-written document, and the case
        // the role arm alone could not see.
        let mut by_pointer = clean_doc();
        by_pointer.tables.get_mut("Dim").unwrap().label_column = Some("Dept".into());
        by_pointer.tables.get_mut("Dim").unwrap().columns.remove("Dept");
        by_pointer
            .measures
            .get_mut("Returns")
            .unwrap()
            .analysis_dimensions
            .push(col("Dim", "Dept"));
        let f = validate(&facts(), &by_pointer)
            .into_iter()
            .find(|f| f.code == "analysis-dimension-role")
            .expect("the declared labelColumn must be refused as a breakdown");
        assert_eq!(f.severity, Severity::Error);
        assert!(
            f.message.contains("Dim[Dept]") && f.message.contains("label column"),
            "the finding must name the column and say what makes it a label: {}",
            f.message
        );
    }

    #[test]
    fn an_explicit_analysis_role_outranks_the_tables_label_pointer() {
        // THE DELIBERATE NARROWING, and the reason for it. `labelColumn` is
        // written by inference from a NAME HEURISTIC - "does the last word read
        // as 'name'" - while a per-column `role` is a person's statement made
        // with the data in front of them. Refusing a whole document because a
        // heuristic disagrees with a human would be the confident-wrong this
        // layer exists to avoid, and it would refuse the checked-in star fixture,
        // where `Product[Name]` is both the label column and a declared analysis
        // axis over a handful of products.
        let mut doc = clean_doc();
        doc.tables.get_mut("Dim").unwrap().label_column = Some("Dept".into());
        // `Dept` keeps its `role: analysis` from `clean_doc`.
        doc.measures
            .get_mut("Returns")
            .unwrap()
            .analysis_dimensions
            .push(col("Dim", "Dept"));
        assert!(
            !codes(&validate(&facts(), &doc), Severity::Error)
                .contains(&"analysis-dimension-role"),
            "a declared analysis role is a human decision and outranks the pointer"
        );
    }

    #[test]
    fn a_label_column_that_a_hierarchy_names_is_still_a_legitimate_breakdown() {
        // Whoever declared the hierarchy said this column is an axis, and that
        // outranks both spellings of "label" - exactly as it already did for the
        // role on its own.
        let mut doc = clean_doc();
        doc.tables.get_mut("Dim").unwrap().label_column = Some("Dept".into());
        doc.tables.get_mut("Dim").unwrap().columns.remove("Dept");
        doc.measures
            .get_mut("Returns")
            .unwrap()
            .analysis_dimensions
            .push(col("Dim", "Dept"));
        // Without the hierarchy: refused.
        assert!(codes(&validate(&facts(), &doc), Severity::Error)
            .contains(&"analysis-dimension-role"));

        // With one the MODEL declares: accepted.
        let mut with_hierarchy = facts();
        with_hierarchy.tables.get_mut("Dim").unwrap().hierarchies = vec![vec!["Dept".into()]];
        assert!(
            !codes(&validate(&with_hierarchy, &doc), Severity::Error)
                .contains(&"analysis-dimension-role"),
            "a level the model declares is a level"
        );
    }

    #[test]
    fn lower_is_better_on_a_churn_kpi_is_correct_and_is_not_refused() {
        // THE BUG THIS TEST WAS RE-POINTED AT. The Churn fixture's KPI has
        // ASCENDING thresholds - the engine's builder accepts no other order -
        // and WORSENING statuses. A validator that read the thresholds refused
        // this document, which is the one direction a churn measure can have.
        let mut doc = clean_doc();
        doc.measures.insert(
            "Churn".into(),
            MeasureStrategy {
                direction: Some(Direction::LowerIsBetter),
                reviewed: true,
                ..Default::default()
            },
        );
        let findings = validate(&facts(), &doc);
        assert!(
            !codes(&findings, Severity::Error).contains(&"direction-contradicts-kpi"),
            "a churn KPI's own bands agree with lowerIsBetter: {findings:?}"
        );
    }

    #[test]
    fn a_direction_opposite_to_what_the_kpi_bands_say_is_refused_naming_both() {
        // The teeth. Same fixture, and the two ways round to disagree with it:
        // higherIsBetter over a KPI whose statuses worsen upward, and
        // lowerIsBetter over one whose statuses improve upward.
        let mut doc = clean_doc();
        doc.measures.insert(
            "Churn".into(),
            MeasureStrategy {
                direction: Some(Direction::HigherIsBetter),
                reviewed: true,
                ..Default::default()
            },
        );
        let findings = validate(&facts(), &doc);
        let f = findings
            .iter()
            .find(|f| f.code == "direction-contradicts-kpi")
            .expect("the contradiction must be refused");
        assert!(
            f.message.contains("Churn")
                && f.message.contains("higherIsBetter")
                && f.message.contains("lowerIsBetter"),
            "must name the measure, the declared direction and the KPI's: {}",
            f.message
        );
        assert!(
            f.message.contains("Churn KPI") && f.message.contains("0.5:onTrack"),
            "must name the KPI and quote its bands: {}",
            f.message
        );

        // ...and the other way round, on a KPI that really does improve upward.
        let mut ascending = facts();
        ascending.measures.get_mut("Churn").unwrap().kpi = Some(KpiFacts {
            name: "Retention KPI".into(),
            target: Some(0.9),
            bands: vec![
                KpiBand::new(0.5, BandStatus::OffTrack),
                KpiBand::new(0.9, BandStatus::OnTrack),
            ],
        });
        let mut doc = clean_doc();
        doc.measures.insert(
            "Churn".into(),
            MeasureStrategy {
                direction: Some(Direction::LowerIsBetter),
                reviewed: true,
                ..Default::default()
            },
        );
        assert!(codes(&validate(&ascending, &doc), Severity::Error)
            .contains(&"direction-contradicts-kpi"));
    }

    #[test]
    fn a_kpi_that_states_no_ordering_refuses_neither_direction() {
        // One band, so there is no bad-to-good sequence at all. The engine must
        // not manufacture a contradiction out of a KPI that expressed no opinion.
        let mut flat = facts();
        flat.measures.get_mut("Churn").unwrap().kpi = Some(KpiFacts {
            name: "Bare KPI".into(),
            target: Some(0.9),
            bands: vec![KpiBand::new(0.9, BandStatus::OnTrack)],
        });
        for direction in [Direction::LowerIsBetter, Direction::HigherIsBetter] {
            let mut doc = clean_doc();
            doc.measures.insert(
                "Churn".into(),
                MeasureStrategy {
                    direction: Some(direction),
                    reviewed: true,
                    ..Default::default()
                },
            );
            assert!(
                !codes(&validate(&flat, &doc), Severity::Error)
                    .contains(&"direction-contradicts-kpi"),
                "{direction:?} should not be refused by a KPI with one band"
            );
        }
    }

    #[test]
    fn a_literal_target_that_disagrees_with_the_kpis_constant_is_refused_naming_both() {
        // Two definitions of one goal: the KPI badge would say 0.9 and the
        // variance line 0.75, in the same report, with nothing to reconcile them.
        let mut doc = clean_doc();
        doc.measures.insert(
            "Churn".into(),
            MeasureStrategy {
                direction: Some(Direction::LowerIsBetter),
                target: Some(Target::Literal { value: 0.75 }),
                reviewed: true,
                ..Default::default()
            },
        );
        let findings = validate(&facts(), &doc);
        let f = findings
            .iter()
            .find(|f| f.code == "target-contradicts-kpi")
            .expect("two targets for one measure must be refused");
        assert!(
            f.message.contains("0.75") && f.message.contains("0.9") && f.message.contains("Churn KPI"),
            "must name both numbers and both sources: {}",
            f.message
        );

        // The two ways to be consistent, both of which must pass: inherit the
        // KPI's target, or state the same number.
        for target in [Target::Kpi, Target::Literal { value: 0.9 }] {
            let mut ok = clean_doc();
            ok.measures.insert(
                "Churn".into(),
                MeasureStrategy {
                    direction: Some(Direction::LowerIsBetter),
                    target: Some(target.clone()),
                    reviewed: true,
                    ..Default::default()
                },
            );
            assert!(
                !codes(&validate(&facts(), &ok), Severity::Error)
                    .contains(&"target-contradicts-kpi"),
                "{target:?} agrees with the KPI and must not be refused"
            );
        }
    }

    #[test]
    fn a_by_dimension_key_that_matches_nothing_in_the_model_is_refused() {
        // `is_additive_over` falls back to `default` when no spelling matches, so
        // this typo would leave a lastValue balance ADDITIVE over Dept - and the
        // engine would then claim its share of a total.
        let mut doc = clean_doc();
        doc.measures.get_mut("Returns").unwrap().aggregation = Some(AggregationSpec {
            default: Additivity::Additive,
            by_dimension: BTreeMap::from([("Dpet".to_string(), Additivity::LastValue)]),
        });
        let findings = validate(&facts(), &doc);
        let f = findings
            .iter()
            .find(|f| f.code == "unknown-aggregation-dimension")
            .expect("an unmatched byDimension key must be refused");
        assert!(f.message.contains("Dpet"), "{}", f.message);
        assert!(
            f.message.contains("Table[Column]"),
            "the message must name the valid spellings: {}",
            f.message
        );
    }

    #[test]
    fn all_three_spellings_of_a_by_dimension_key_are_accepted() {
        // Exactly the three `is_additive_over` tries. Accepting fewer would refuse
        // a document the resolver honours; accepting more would bless a key it
        // silently ignores.
        for key in ["Dim[Dept]", "Dept", "Dim"] {
            let mut doc = clean_doc();
            doc.measures.get_mut("Returns").unwrap().aggregation = Some(AggregationSpec {
                default: Additivity::Additive,
                by_dimension: BTreeMap::from([(key.to_string(), Additivity::LastValue)]),
            });
            assert!(
                !codes(&validate(&facts(), &doc), Severity::Error)
                    .contains(&"unknown-aggregation-dimension"),
                "'{key}' is a spelling the resolver matches and must be accepted"
            );
        }
    }

    #[test]
    fn a_rules_own_by_dimension_typo_is_refused_too() {
        let mut doc = clean_doc();
        doc.rules.push(Rule {
            id: "r1".into(),
            measure: "Returns".into(),
            scope: Scope::from([(col("Dim", "Dept"), ScopeValue::Members(vec!["Refunds".into()]))]),
            set: AttributeSet {
                aggregation: Some(AggregationSpec {
                    default: Additivity::Additive,
                    by_dimension: BTreeMap::from([("Nope".to_string(), Additivity::LastValue)]),
                }),
                ..Default::default()
            },
            note: None,
        });
        let findings = validate(&facts(), &doc);
        let f = findings
            .iter()
            .find(|f| f.code == "unknown-aggregation-dimension")
            .expect("a rule's aggregation is as unvalidated as a measure's was");
        assert_eq!(f.path, "rules[0].set.aggregation");
    }

    #[test]
    fn a_model_hierarchy_lets_a_label_column_scope_even_with_no_hierarchy_in_the_document() {
        // The document declares Dept as a LABEL and declares no hierarchies at
        // all - the ordinary state of a hand-written file, or of one written
        // before somebody added the hierarchy to the model. Before the facts
        // carried the model's hierarchies, this was refused.
        let mut doc = clean_doc();
        doc.tables.get_mut("Dim").unwrap().columns.insert(
            "Dept".into(),
            ColumnStrategy {
                role: Role::Label,
                priority: None,
            },
        );
        doc.rules.push(Rule {
            id: "r1".into(),
            measure: "Returns".into(),
            scope: Scope::from([(col("Dim", "Dept"), ScopeValue::Members(vec!["Refunds".into()]))]),
            set: AttributeSet {
                materiality: Some(Materiality::Absolute { value: 1.0 }),
                ..Default::default()
            },
            note: None,
        });

        // Without the model hierarchy: refused, exactly as before.
        assert!(codes(&validate(&facts(), &doc), Severity::Error).contains(&"scope-column-role"));

        // With it: accepted, and nothing else changed.
        let mut with_hierarchy = facts();
        with_hierarchy.tables.get_mut("Dim").unwrap().hierarchies = vec![vec!["Dept".into()]];
        assert!(
            !codes(&validate(&with_hierarchy, &doc), Severity::Error)
                .contains(&"scope-column-role"),
            "a level the MODEL declares is a level"
        );
    }

    #[test]
    fn adding_the_models_hierarchies_can_only_remove_errors_and_never_add_one() {
        // The loosening claim, tested rather than asserted: for every document
        // below, the errors seen WITH the model's hierarchies must be a subset of
        // the errors seen without them.
        let mut labelled = clean_doc();
        labelled.tables.get_mut("Dim").unwrap().columns.insert(
            "Dept".into(),
            ColumnStrategy {
                role: Role::Label,
                priority: None,
            },
        );
        let mut scoped = labelled.clone();
        scoped.rules.push(Rule {
            id: "r1".into(),
            measure: "Returns".into(),
            scope: Scope::from([(col("Dim", "Dept"), ScopeValue::Members(vec!["Refunds".into()]))]),
            set: AttributeSet {
                direction: Some(Direction::HigherIsBetter),
                ..Default::default()
            },
            note: None,
        });
        let mut analysed = labelled.clone();
        analysed
            .measures
            .get_mut("Returns")
            .unwrap()
            .analysis_dimensions
            .push(col("Dim", "Dept"));
        let mut keyed = clean_doc();
        keyed.rules.push(Rule {
            id: "r1".into(),
            measure: "Returns".into(),
            scope: Scope::from([(
                col("Sales", "InvoiceId"),
                ScopeValue::Members(vec!["INV-1".into()]),
            )]),
            set: AttributeSet {
                direction: Some(Direction::HigherIsBetter),
                ..Default::default()
            },
            note: None,
        });

        let mut with_hierarchy = facts();
        with_hierarchy.tables.get_mut("Dim").unwrap().hierarchies = vec![vec!["Dept".into()]];

        for (label, doc) in [
            ("clean", clean_doc()),
            ("label-scoped", scoped),
            ("label-analysed", analysed),
            // A key column is in NO hierarchy, so its refusal must survive - or
            // "loosening only" would have quietly become "loosening everything".
            ("key-scoped", keyed),
        ] {
            let before: BTreeSet<String> = validate(&facts(), &doc)
                .iter()
                .filter(|f| f.severity == Severity::Error)
                .map(|f| format!("{}@{}", f.code, f.path))
                .collect();
            let after: BTreeSet<String> = validate(&with_hierarchy, &doc)
                .iter()
                .filter(|f| f.severity == Severity::Error)
                .map(|f| format!("{}@{}", f.code, f.path))
                .collect();
            assert!(
                after.is_subset(&before),
                "'{label}' gained errors when the model's hierarchies became visible: {:?}",
                after.difference(&before).collect::<Vec<_>>()
            );
        }
        assert!(
            codes(&validate(&with_hierarchy, &clean_doc()), Severity::Error).is_empty(),
            "the clean document stays clean"
        );
    }

    #[test]
    fn duplicate_rule_ids_are_refused() {
        let mut doc = clean_doc();
        for scope in [
            Scope::from([(col("Dim", "Dept"), ScopeValue::Members(vec!["Refunds".into()]))]),
            Scope::from([(col("Dim", "Dept"), ScopeValue::Members(vec!["Retail".into()]))]),
        ] {
            doc.rules.push(Rule {
                id: "same".into(),
                measure: "Returns".into(),
                scope,
                set: AttributeSet {
                    materiality: Some(Materiality::Absolute { value: 1.0 }),
                    ..Default::default()
                },
                note: None,
            });
        }
        let findings = validate(&facts(), &doc);
        assert!(codes(&findings, Severity::Error).contains(&"duplicate-rule-id"));
    }

    #[test]
    fn an_overlap_conflict_refuses_the_document() {
        let mut doc = clean_doc();
        doc.tables.get_mut("Sales").unwrap().columns.insert(
            "Amount".into(),
            ColumnStrategy {
                role: Role::Analysis,
                priority: None,
            },
        );
        doc.rules.push(Rule {
            id: "a".into(),
            measure: "Returns".into(),
            scope: Scope::from([(col("Dim", "Dept"), ScopeValue::Members(vec!["Refunds".into()]))]),
            set: AttributeSet {
                direction: Some(Direction::HigherIsBetter),
                ..Default::default()
            },
            note: None,
        });
        doc.rules.push(Rule {
            id: "b".into(),
            measure: "Returns".into(),
            scope: Scope::from([(col("Sales", "Amount"), ScopeValue::Members(vec!["big".into()]))]),
            set: AttributeSet {
                direction: Some(Direction::LowerIsBetter),
                ..Default::default()
            },
            note: None,
        });
        let findings = validate(&facts(), &doc);
        let f = findings
            .iter()
            .find(|f| f.code == "rule-overlap")
            .expect("the overlap must reach the validator, not just the checker");
        assert!(
            f.message.contains("'a'") && f.message.contains("'b'"),
            "the finding must name both rules: {}",
            f.message
        );
    }

    #[test]
    fn a_malformed_date_bound_stops_the_document_parsing_rather_than_reaching_this_validator() {
        // MEANING CHANGE, recorded deliberately. This used to assert
        // `malformed-date-range`, a validator ERROR - which protected the two
        // write gates and NOT the run path, where a hand-edited model file
        // reached overlap.rs with `1/4/2025` intact and had it compared
        // lexicographically against `2025-06-30`. The bound is now an `IsoDate`,
        // so the refusal happens where the value is READ. The assertion is
        // strictly stronger and it is a different assertion: "the validator
        // refuses it" became "the document cannot be read".
        let err = serde_json::from_str::<StrategyDoc>(
            r#"{"version":1,"rules":[{"id":"r1","measure":"Returns",
                "scope":{"Dim[Dept]":{"from":"1/4/2025","to":"2025-06-30"}},
                "set":{"cadence":"monthly"}}]}"#,
        )
        .unwrap_err()
        .to_string();
        assert!(err.contains("1/4/2025"), "the error must quote the bound: {err}");

        // A range that is well-formed and EMPTY is still this validator's
        // business, because no type can decide whether one date precedes
        // another - that is a statement about the document, not about a value.
        let mut doc = clean_doc();
        doc.tables.get_mut("Dim").unwrap().columns.insert(
            "Dept".into(),
            ColumnStrategy {
                role: Role::Analysis,
                priority: None,
            },
        );
        doc.rules.push(Rule {
            id: "r1".into(),
            measure: "Returns".into(),
            scope: Scope::from([(
                col("Dim", "Dept"),
                ScopeValue::between("2025-06-30", "2025-01-01"),
            )]),
            set: AttributeSet {
                cadence: Some(Cadence::Monthly),
                ..Default::default()
            },
            note: None,
        });
        assert!(codes(&validate(&facts(), &doc), Severity::Error).contains(&"empty-scope"));
    }

    #[test]
    fn a_document_version_this_build_does_not_understand_is_refused() {
        // `{"version": 99}` parsed and was applied AS IF IT WERE VERSION 1:
        // every rule read by a reader that has no idea what 99 meant. Nothing
        // checked it, in a file whose whole job is to refuse documents that
        // would make the engine lie.
        let mut doc = clean_doc();
        doc.version = 99;
        let f = validate(&facts(), &doc)
            .into_iter()
            .find(|f| f.code == "unsupported-document-version")
            .expect("a version this build cannot read must be refused");
        assert_eq!(f.severity, Severity::Error);
        assert_eq!(f.path, "version");
        assert!(f.message.contains("99") && f.message.contains('1'), "{}", f.message);
        // POSITIVE CONTROL: the version this build writes is accepted.
        assert!(!codes(&validate(&facts(), &clean_doc()), Severity::Error)
            .contains(&"unsupported-document-version"));
    }

    #[test]
    fn a_rule_with_a_blank_id_is_refused_because_nothing_could_name_it() {
        // Duplicate ids were an error from the start and a MISSING one was never
        // checked. The suppression reason would read "rule '' sets ...", and a
        // test's `decidedBy: ""` would match it.
        let mut doc = clean_doc();
        doc.rules.push(Rule {
            id: "   ".into(),
            measure: "Returns".into(),
            scope: Scope::from([(col("Dim", "Dept"), ScopeValue::Members(vec!["Refunds".into()]))]),
            set: AttributeSet {
                direction: Some(Direction::HigherIsBetter),
                ..Default::default()
            },
            note: None,
        });
        let f = validate(&facts(), &doc)
            .into_iter()
            .find(|f| f.code == "blank-rule-id")
            .expect("a blank rule id must be refused");
        assert_eq!(f.severity, Severity::Error);
        assert_eq!(f.path, "rules[0].id");

        // POSITIVE CONTROL: a named rule is not complained about.
        let mut ok = clean_doc();
        ok.rules.push(Rule {
            id: "refunds".into(),
            measure: "Returns".into(),
            scope: Scope::from([(col("Dim", "Dept"), ScopeValue::Members(vec!["Refunds".into()]))]),
            set: AttributeSet {
                direction: Some(Direction::HigherIsBetter),
                ..Default::default()
            },
            note: None,
        });
        assert!(!codes(&validate(&facts(), &ok), Severity::Error).contains(&"blank-rule-id"));
    }

    #[test]
    fn a_column_that_is_both_an_analysis_dimension_and_forbidden_is_refused() {
        // The prohibition wins in `plan_dimensions`, so the breakdown the
        // document asks for is simply absent from the report - a fact withheld
        // in silence, which this file's rule makes an error.
        let mut doc = clean_doc();
        let m = doc.measures.get_mut("Returns").unwrap();
        m.analysis_dimensions.push(col("Dim", "Dept"));
        m.never_slice_by.push(col("Dim", "Dept"));
        let f = validate(&facts(), &doc)
            .into_iter()
            .find(|f| f.code == "contradictory-analysis-dimension")
            .expect("one column cannot be both");
        assert_eq!(f.severity, Severity::Error);
        assert_eq!(f.path, "measures['Returns'].neverSliceBy[0]");
        assert!(f.message.contains("Dim[Dept]"), "{}", f.message);

        // POSITIVE CONTROL: the ordinary shape - a breakdown axis and a
        // separate forbidden column - is untouched.
        let mut ok = clean_doc();
        let m = ok.measures.get_mut("Returns").unwrap();
        m.analysis_dimensions.push(col("Dim", "Dept"));
        m.never_slice_by.push(col("Sales", "InvoiceId"));
        assert!(!codes(&validate(&facts(), &ok), Severity::Error)
            .contains(&"contradictory-analysis-dimension"));
    }

    #[test]
    fn an_orphan_entry_and_an_unreviewed_entry_warn_but_do_not_refuse() {
        let mut doc = clean_doc();
        doc.measures.insert(
            "Deleted".into(),
            MeasureStrategy {
                reviewed: true,
                ..Default::default()
            },
        );
        doc.measures.get_mut("Returns").unwrap().reviewed = false;
        let findings = validate(&facts(), &doc);
        assert!(!is_refused(&findings), "these are staleness, not lies: {findings:?}");
        let warns = codes(&findings, Severity::Warning);
        assert!(warns.contains(&"orphan-measure"));
        assert!(warns.contains(&"unreviewed"));
    }

    #[test]
    fn a_never_slice_by_column_no_relationship_reaches_warns() {
        let mut doc = clean_doc();
        doc.measures
            .get_mut("Returns")
            .unwrap()
            .never_slice_by
            .push(col("Far", "Note"));
        let findings = validate(&facts(), &doc);
        assert!(codes(&findings, Severity::Warning).contains(&"unreachable-never-slice-by"));
        assert!(!is_refused(&findings));
    }

    #[test]
    fn a_member_the_model_no_longer_has_warns() {
        let mut doc = clean_doc();
        doc.rules.push(Rule {
            id: "r1".into(),
            measure: "Returns".into(),
            scope: Scope::from([(
                col("Dim", "Dept"),
                ScopeValue::Members(vec!["Wholesale".into()]),
            )]),
            set: AttributeSet {
                materiality: Some(Materiality::Absolute { value: 1.0 }),
                ..Default::default()
            },
            note: None,
        });
        let findings = validate(&facts(), &doc);
        assert!(codes(&findings, Severity::Warning).contains(&"unknown-member"));
        assert!(!is_refused(&findings));
    }

    #[test]
    fn a_document_over_the_extension_data_cap_is_refused() {
        let mut doc = clean_doc();
        doc.periods.push(PeriodAnnotation {
            id: "big".into(),
            measure: None,
            scope: Scope::new(),
            note: "x".repeat(MAX_STRATEGY_DOC_BYTES + 1),
        });
        let findings = validate(&facts(), &doc);
        assert!(codes(&findings, Severity::Error).contains(&"document-too-large"));
    }

    // --- the inline test runner ---------------------------------------------

    fn doc_with_refunds_rule() -> StrategyDoc {
        let mut doc = clean_doc();
        doc.rules.push(Rule {
            id: "refunds-dept".into(),
            measure: "Returns".into(),
            scope: Scope::from([(
                col("Dim", "Dept"),
                ScopeValue::Members(vec!["Refunds".into()]),
            )]),
            set: AttributeSet {
                direction: Some(Direction::HigherIsBetter),
                ..Default::default()
            },
            note: None,
        });
        doc
    }

    #[test]
    fn a_consultants_passing_assertion_produces_no_finding() {
        let mut doc = doc_with_refunds_rule();
        doc.tests.push(StrategyTest {
            measure: "Returns".into(),
            scope: Scope::from([(
                col("Dim", "Dept"),
                ScopeValue::Members(vec!["Refunds".into()]),
            )]),
            given: TestGiven {
                delta: 5000.0,
                value: None,
                baseline: None,
            },
            expect: TestExpect {
                status: ExpectedStatus::Favourable,
                decided_by: Some("refunds-dept".into()),
            },
        });
        assert_eq!(run_inline_tests(&facts(), &doc), vec![]);
        assert!(!is_refused(&validate(&facts(), &doc)));
    }

    #[test]
    fn a_consultants_failing_assertion_refuses_the_document() {
        let mut doc = doc_with_refunds_rule();
        doc.tests.push(StrategyTest {
            measure: "Returns".into(),
            scope: Scope::from([(
                col("Dim", "Dept"),
                ScopeValue::Members(vec!["Refunds".into()]),
            )]),
            given: TestGiven {
                delta: 5000.0,
                value: None,
                baseline: None,
            },
            expect: TestExpect {
                status: ExpectedStatus::Unfavourable,
                decided_by: None,
            },
        });
        let findings = run_inline_tests(&facts(), &doc);
        assert_eq!(findings.len(), 1);
        assert_eq!(findings[0].code, "inline-test-failed");
        assert!(findings[0].message.contains("unfavourable"));
        assert!(is_refused(&validate(&facts(), &doc)));
    }

    #[test]
    fn an_assertion_that_is_right_for_the_wrong_reason_still_fails() {
        // The status matches, but a different rule (none at all) decided it. This
        // is the case a status-only assertion would wave through.
        let mut doc = doc_with_refunds_rule();
        doc.tests.push(StrategyTest {
            measure: "Returns".into(),
            scope: Scope::from([(col("Dim", "Dept"), ScopeValue::Members(vec!["Retail".into()]))]),
            given: TestGiven {
                delta: -5000.0,
                value: None,
                baseline: None,
            },
            expect: TestExpect {
                status: ExpectedStatus::Favourable,
                decided_by: Some("refunds-dept".into()),
            },
        });
        let findings = run_inline_tests(&facts(), &doc);
        assert_eq!(findings.len(), 1, "{findings:?}");
        assert!(
            findings[0].message.contains("decided by no rule at all"),
            "{}",
            findings[0].message
        );
    }

    #[test]
    fn an_aggregate_spanning_two_directions_is_reported_as_suppressed_to_the_test_runner() {
        let mut doc = doc_with_refunds_rule();
        // No scope: the fact rolls up Refunds and Retail, which disagree.
        doc.tests.push(StrategyTest {
            measure: "Returns".into(),
            scope: Scope::new(),
            given: TestGiven {
                delta: 5000.0,
                value: None,
                baseline: None,
            },
            expect: TestExpect {
                status: ExpectedStatus::Suppressed,
                decided_by: Some("refunds-dept".into()),
            },
        });
        assert_eq!(run_inline_tests(&facts(), &doc), vec![]);
    }

    #[test]
    fn a_movement_below_absolute_materiality_on_a_targetless_measure_is_immaterial_not_neutral() {
        // THIS TEST USED TO ASSERT THE DEFECT. Below the floor the run builds no
        // `Change` fact, so nothing here carries a favourability for "neutral"
        // to qualify - and `neutral` was also the harness's answer for a point
        // the engine makes no claim about, which is how a test could go green
        // over a report that judges nothing. `immaterial` is the word; `neutral`
        // is now refused here, because no assignment of delta, value or baseline
        // produces it.
        //
        // `clean_doc`'s Returns declares no target, and the name says so: with
        // one, the variance fact judges the LEVEL at this very point and
        // `immaterial` is the answer that would be wrong.
        let mut doc = clean_doc();
        doc.measures.get_mut("Returns").unwrap().materiality =
            Some(Materiality::Absolute { value: 1000.0 });
        doc.tests.push(StrategyTest {
            measure: "Returns".into(),
            scope: Scope::new(),
            given: TestGiven {
                delta: -10.0,
                value: None,
                baseline: None,
            },
            expect: TestExpect {
                status: ExpectedStatus::Immaterial,
                decided_by: None,
            },
        });
        assert_eq!(run_inline_tests(&facts(), &doc), vec![]);

        doc.tests[0].expect.status = ExpectedStatus::Neutral;
        assert_eq!(
            run_inline_tests(&facts(), &doc)
                .iter()
                .map(|f| f.code.as_str())
                .collect::<Vec<_>>(),
            vec!["test-expects-the-unreachable"],
            "`neutral` says a fact exists and is neither good nor bad; none exists here"
        );
    }

    #[test]
    fn a_test_naming_a_rule_that_does_not_exist_is_refused() {
        let mut doc = clean_doc();
        doc.tests.push(StrategyTest {
            measure: "Returns".into(),
            scope: Scope::new(),
            given: TestGiven {
                delta: -1.0,
                value: None,
                baseline: None,
            },
            expect: TestExpect {
                status: ExpectedStatus::Favourable,
                decided_by: Some("no-such-rule".into()),
            },
        });
        assert!(codes(&validate(&facts(), &doc), Severity::Error).contains(&"unknown-rule"));
    }

    // --- the companion-field sweep -------------------------------------------

    /// `Returns`, with whatever direction and target are handed in.
    fn returns_with(direction: Direction, target: Option<Target>) -> StrategyDoc {
        let mut doc = clean_doc();
        doc.measures.insert(
            "Returns".into(),
            MeasureStrategy {
                direction: Some(direction),
                target,
                reviewed: true,
                ..Default::default()
            },
        );
        doc
    }

    #[test]
    fn a_band_direction_with_no_band_is_refused_on_a_measure_entry_and_on_a_rule() {
        // THE REPORTED BUG, both spellings of it. The measure entry only WARNED,
        // and `set` refuses none of those, so the document saved; the rule's own
        // `set.direction` was never inspected at all. Either way the measure
        // carries a direction that decides nothing: `favourability_of` returns
        // None, so no favourability and no variance line ship, and nothing
        // anywhere says why. The harness FELL to Neutral for it back then, which
        // is the collapse `Verdict` was introduced to undo; today the point is
        // `NoClaim` and a test aimed at it is refused rather than answered.
        let by_entry = returns_with(Direction::TargetBand, None);
        let f = validate(&facts(), &by_entry)
            .into_iter()
            .find(|f| f.code == "target-band-without-band")
            .expect("a band direction with no band must be refused");
        assert_eq!(f.severity, Severity::Error, "a warning still saves the document");
        assert_eq!(f.path, "measures['Returns'].direction");
        assert!(
            f.message.contains("targetBand") && f.message.contains("Returns"),
            "the finding must name both: {}",
            f.message
        );

        // The rule spelling, on a measure whose own entry says nothing about a
        // band either.
        let mut by_rule = clean_doc();
        by_rule.rules.push(Rule {
            id: "r1".into(),
            measure: "Returns".into(),
            scope: Scope::from([(col("Dim", "Dept"), ScopeValue::Members(vec!["Refunds".into()]))]),
            set: AttributeSet {
                direction: Some(Direction::TargetBand),
                ..Default::default()
            },
            note: None,
        });
        let f = validate(&facts(), &by_rule)
            .into_iter()
            .find(|f| f.code == "target-band-without-band")
            .expect("a rule's own band direction must be refused too");
        assert_eq!(f.severity, Severity::Error);
        assert_eq!(f.path, "rules[0].set.direction");
        assert!(f.message.contains("rule 'r1'"), "{}", f.message);

        // POSITIVE CONTROL: with a band declared, both are accepted - and a band
        // declared by the RULE satisfies the measure entry's direction, because
        // a band that exists somewhere is a band the direction can land on.
        let ok = returns_with(Direction::TargetBand, Some(Target::band(1.0, 10.0)));
        assert!(
            !codes(&validate(&facts(), &ok), Severity::Error)
                .contains(&"target-band-without-band"),
            "a declared band is what the direction needs"
        );
        let mut band_on_the_rule = returns_with(Direction::TargetBand, None);
        band_on_the_rule.rules.push(Rule {
            id: "r1".into(),
            measure: "Returns".into(),
            scope: Scope::from([(col("Dim", "Dept"), ScopeValue::Members(vec!["Refunds".into()]))]),
            set: AttributeSet {
                target: Some(Target::band(1.0, 10.0)),
                ..Default::default()
            },
            note: None,
        });
        assert!(
            !codes(&validate(&facts(), &band_on_the_rule), Severity::Error)
                .contains(&"target-band-without-band")
        );
    }

    #[test]
    fn a_kpi_target_is_not_a_band_however_the_resolver_reads_it() {
        // Resolved the way resolve.rs resolves it: `{"type": "kpi"}` becomes the
        // KPI's own SCALAR target, and a model KPI carries a number plus status
        // bands - never a target band. So a kpi target can never satisfy a
        // targetBand direction, and the fixture's Churn KPI (which HAS a
        // constant target) is the case that proves it is not merely "the KPI
        // was missing".
        let mut doc = clean_doc();
        doc.measures.insert(
            "Churn".into(),
            MeasureStrategy {
                direction: Some(Direction::TargetBand),
                target: Some(Target::Kpi),
                reviewed: true,
                ..Default::default()
            },
        );
        let f = validate(&facts(), &doc)
            .into_iter()
            .find(|f| f.code == "target-band-without-band")
            .expect("a kpi target does not supply a band");
        assert!(
            f.message.contains("kpi"),
            "the finding must say why the kpi target does not count: {}",
            f.message
        );
        // ...and the kpi target itself is fine: this KPI does carry a number, so
        // nothing else about the document is being complained about.
        assert!(!codes(&validate(&facts(), &doc), Severity::Error)
            .contains(&"unresolvable-target-kpi"));
    }

    #[test]
    fn a_band_no_value_can_be_inside_is_refused_the_way_a_backwards_date_range_already_was() {
        // `low > high` judged every value unfavourable forever, and was never
        // checked - while the identically empty date range HAS been an error
        // from the start. The inconsistency is the finding.
        let reversed = returns_with(
            Direction::TargetBand,
            Some(Target::band(140000.0, 90000.0)),
        );
        let f = validate(&facts(), &reversed)
            .into_iter()
            .find(|f| f.code == "empty-band")
            .expect("a reversed band must be refused");
        assert_eq!(f.severity, Severity::Error);
        assert_eq!(f.path, "measures['Returns'].target");
        assert!(
            f.message.contains("[140000, 90000]"),
            "the finding must quote the band: {}",
            f.message
        );

        // A single point is legal while both ends are included, and empty the
        // moment one of them is not.
        let point = returns_with(Direction::TargetBand, Some(Target::band(5.0, 5.0)));
        assert!(!codes(&validate(&facts(), &point), Severity::Error).contains(&"empty-band"));
        let half_open = returns_with(
            Direction::TargetBand,
            Some(Target::Band {
                low: 5.0,
                high: 5.0,
                low_inclusive: true,
                high_inclusive: false,
            }),
        );
        assert!(codes(&validate(&facts(), &half_open), Severity::Error).contains(&"empty-band"));

        // ...and a rule's band is checked at its own path, or one site would
        // quietly stop checking what the other does.
        let mut on_a_rule = clean_doc();
        on_a_rule.rules.push(Rule {
            id: "r1".into(),
            measure: "Returns".into(),
            scope: Scope::from([(col("Dim", "Dept"), ScopeValue::Members(vec!["Refunds".into()]))]),
            set: AttributeSet {
                target: Some(Target::band(10.0, 1.0)),
                ..Default::default()
            },
            note: None,
        });
        let f = validate(&facts(), &on_a_rule)
            .into_iter()
            .find(|f| f.code == "empty-band")
            .expect("a rule's band is a band");
        assert_eq!(f.path, "rules[0].set.target");
    }

    #[test]
    fn a_kpi_target_on_a_measure_the_model_gives_no_kpi_is_refused() {
        // The author declared a goal and the report silently contains no
        // variance line: resolve.rs keeps the bare marker, model_commands maps
        // it to no target_value, and `facts_for_measure` emits nothing. No note
        // said why, because nothing had noticed.
        let doc = returns_with(Direction::LowerIsBetter, Some(Target::Kpi));
        let f = validate(&facts(), &doc)
            .into_iter()
            .find(|f| f.code == "unresolvable-target-kpi")
            .expect("a kpi target with no kpi must be refused");
        assert_eq!(f.severity, Severity::Error);
        assert_eq!(f.path, "measures['Returns'].target");
        assert!(f.message.contains("no KPI"), "{}", f.message);

        // POSITIVE CONTROL: the same target on the measure whose KPI carries a
        // constant is accepted, so the check is about the KPI and not about the
        // spelling `{"type": "kpi"}`.
        let mut ok = clean_doc();
        ok.measures.insert(
            "Churn".into(),
            MeasureStrategy {
                direction: Some(Direction::LowerIsBetter),
                target: Some(Target::Kpi),
                reviewed: true,
                ..Default::default()
            },
        );
        assert!(!codes(&validate(&facts(), &ok), Severity::Error)
            .contains(&"unresolvable-target-kpi"));
    }

    #[test]
    fn a_kpi_whose_own_goal_is_another_measure_cannot_supply_a_target_either() {
        // The second way to be unresolvable, and the one a reader would never
        // guess: facts.rs maps `KpiTarget::Measure(_)` to `target: None`, so the
        // KPI exists, looks complete in the model editor, and still resolves to
        // no number. Same silence, different cause, so the message differs.
        let mut measure_targeted = facts();
        measure_targeted
            .measures
            .get_mut("Churn")
            .unwrap()
            .kpi
            .as_mut()
            .unwrap()
            .target = None;
        let mut doc = clean_doc();
        doc.measures.insert(
            "Churn".into(),
            MeasureStrategy {
                direction: Some(Direction::LowerIsBetter),
                target: Some(Target::Kpi),
                reviewed: true,
                ..Default::default()
            },
        );
        let f = validate(&measure_targeted, &doc)
            .into_iter()
            .find(|f| f.code == "unresolvable-target-kpi")
            .expect("a KPI with no constant target must be refused");
        assert!(
            f.message.contains("Churn KPI") && f.message.contains("CONSTANT"),
            "the finding must name the KPI and say what it lacks: {}",
            f.message
        );
    }

    #[test]
    fn a_suppress_entry_naming_a_fact_kind_nobody_emits_cannot_be_written_at_all() {
        // MEANING CHANGE, recorded deliberately. This used to assert
        // `unknown-fact-kind`, a validator ERROR at `rules[0].set.suppress`.
        // `suppress` is now `Vec<SuppressibleFactKind>`, so the refusal happens
        // at PARSE time and the finding no longer exists: the entry cannot be
        // constructed in Rust and cannot be deserialized from JSON. That is a
        // strictly stronger assertion and a different one - "the validator
        // refuses it" became "the document cannot be read" - and it closes the
        // run path, where a hand-edited model file used to reach the engine with
        // a suppression that withheld nothing.
        //
        // `outlier` is the spelling this document's own type comment used to
        // give as its example, and it is wrong twice over: the core engine's key
        // for that fact is the PLURAL `outliers`, and a model run never wraps an
        // outlier fact at all.
        let err = serde_json::from_str::<StrategyDoc>(
            r#"{"version":1,"rules":[{"id":"r1","measure":"Returns",
                "scope":{"Dim[Dept]":["Refunds"]},"set":{"suppress":["outlier"]}}]}"#,
        )
        .unwrap_err()
        .to_string();
        assert!(
            err.contains("outlier") && err.contains("memberMove"),
            "serde must quote the typo and list the vocabulary: {err}"
        );

        // POSITIVE CONTROL: every spelling the engine really emits is accepted
        // and validates clean, or the type would refuse documents that work.
        for kind in SuppressibleFactKind::ALL {
            let mut ok = clean_doc();
            ok.rules.push(Rule {
                id: "r1".into(),
                measure: "Returns".into(),
                scope: Scope::from([(
                    col("Dim", "Dept"),
                    ScopeValue::Members(vec!["Refunds".into()]),
                )]),
                set: AttributeSet {
                    suppress: vec![*kind],
                    ..Default::default()
                },
                note: None,
            });
            assert_eq!(
                codes(&validate(&facts(), &ok), Severity::Error),
                Vec::<&str>::new(),
                "'{kind}' is a kind the engine emits and must be accepted"
            );
        }
    }

    #[test]
    fn a_semi_additive_default_with_no_dimension_to_be_semi_additive_along_is_refused() {
        // `is_additive_over` falls back to `default` for every dimension, so
        // `lastValue` with an empty byDimension answers "not additive"
        // everywhere and every share fact disappears - and then the provenance
        // line printed "lastValue over Product", a per-dimension claim the
        // document never made about a rollup that has no meaning.
        for default in [
            Additivity::LastValue,
            Additivity::FirstValue,
            Additivity::Average,
            Additivity::Max,
            Additivity::Min,
        ] {
            let mut doc = clean_doc();
            doc.measures.get_mut("Returns").unwrap().aggregation = Some(AggregationSpec {
                default,
                by_dimension: BTreeMap::new(),
            });
            let f = validate(&facts(), &doc)
                .into_iter()
                .find(|f| f.code == "semi-additive-without-dimension")
                .unwrap_or_else(|| panic!("{default:?} with no dimension must be refused"));
            assert_eq!(f.severity, Severity::Error);
            assert_eq!(f.path, "measures['Returns'].aggregation");
        }

        // THE TWO DEFAULTS THAT MEAN SOMETHING ON THEIR OWN, and the same
        // semi-additive default once it names the dimension it applies along:
        // all three must pass, or the check would refuse the ordinary balance.
        for spec in [
            AggregationSpec {
                default: Additivity::Additive,
                by_dimension: BTreeMap::new(),
            },
            AggregationSpec {
                default: Additivity::NonAdditive,
                by_dimension: BTreeMap::new(),
            },
            AggregationSpec {
                default: Additivity::Additive,
                by_dimension: BTreeMap::from([("Dim".to_string(), Additivity::LastValue)]),
            },
        ] {
            let mut ok = clean_doc();
            ok.measures.get_mut("Returns").unwrap().aggregation = Some(spec.clone());
            assert!(
                !codes(&validate(&facts(), &ok), Severity::Error)
                    .contains(&"semi-additive-without-dimension"),
                "{spec:?} is a legal aggregation"
            );
        }
    }

    #[test]
    fn a_test_under_a_band_direction_that_states_no_value_is_refused_rather_than_passing_vacuously() {
        // `judge` fell to Neutral for a band it could not evaluate, so a test
        // expecting `neutral` PASSED and proved nothing - in the one file that
        // gives this validator teeth.
        let mut doc = returns_with(Direction::TargetBand, Some(Target::band(1.0, 10.0)));
        doc.tests.push(StrategyTest {
            measure: "Returns".into(),
            scope: Scope::new(),
            given: TestGiven {
                delta: 5.0,
                value: None,
                baseline: None,
            },
            expect: TestExpect {
                status: ExpectedStatus::Neutral,
                decided_by: None,
            },
        });
        let findings = run_inline_tests(&facts(), &doc);
        assert_eq!(findings.len(), 1, "{findings:?}");
        assert_eq!(findings[0].code, "test-needs-value");
        assert_eq!(findings[0].path, "tests[0].given");
        assert!(is_refused(&validate(&facts(), &doc)));

        // POSITIVE CONTROL: with the value supplied the test is judged for real,
        // and a value inside the band is favourable.
        doc.tests[0].given.value = Some(5.0);
        doc.tests[0].expect.status = ExpectedStatus::Favourable;
        assert_eq!(run_inline_tests(&facts(), &doc), vec![]);
    }

    #[test]
    fn a_relative_materiality_test_with_no_baseline_is_refused_rather_than_judged_material() {
        // The validator answered "material" unconditionally when the baseline
        // was missing, while the planner uses the PRIOR PERIOD as the baseline
        // and would have suppressed the movement entirely. A test could go
        // green on a fact the report never prints.
        let mut doc = clean_doc();
        doc.measures.get_mut("Returns").unwrap().materiality =
            Some(Materiality::Relative { value: 0.5 });
        doc.tests.push(StrategyTest {
            measure: "Returns".into(),
            scope: Scope::new(),
            given: TestGiven {
                delta: -10.0,
                value: None,
                baseline: None,
            },
            expect: TestExpect {
                status: ExpectedStatus::Favourable,
                decided_by: None,
            },
        });
        let findings = run_inline_tests(&facts(), &doc);
        assert_eq!(findings.len(), 1, "{findings:?}");
        assert_eq!(findings[0].code, "test-needs-baseline");

        // WITH the baseline the planner's own threshold decides, and it decides
        // the other way: -10 against a baseline of 1000 is a 1% movement under a
        // 50% floor, so the movement is below the floor and the report says
        // nothing about it at all. `immaterial`, not `neutral` - the run emits
        // no fact there, and `neutral` is a judgement about a fact that exists.
        doc.tests[0].given.baseline = Some(1000.0);
        doc.tests[0].expect.status = ExpectedStatus::Immaterial;
        assert_eq!(run_inline_tests(&facts(), &doc), vec![]);
        // ...and a movement that clears the floor is judged on its direction.
        doc.tests[0].given.delta = -600.0;
        doc.tests[0].expect.status = ExpectedStatus::Favourable;
        assert_eq!(run_inline_tests(&facts(), &doc), vec![]);
    }

    #[test]
    fn an_excluded_band_end_judges_a_value_that_lands_exactly_on_it_unfavourable() {
        // What the inclusivity flags BUY. Same band, same value, opposite
        // verdict - so the flags are read rather than stored.
        let mut inclusive = returns_with(Direction::TargetBand, Some(Target::band(0.0, 1.0)));
        inclusive.tests.push(StrategyTest {
            measure: "Returns".into(),
            scope: Scope::new(),
            given: TestGiven {
                delta: 0.5,
                value: Some(1.0),
                baseline: None,
            },
            expect: TestExpect {
                status: ExpectedStatus::Favourable,
                decided_by: None,
            },
        });
        assert_eq!(run_inline_tests(&facts(), &inclusive), vec![]);

        let mut exclusive = inclusive.clone();
        exclusive.measures.get_mut("Returns").unwrap().target = Some(Target::Band {
            low: 0.0,
            high: 1.0,
            low_inclusive: true,
            high_inclusive: false,
        });
        exclusive.tests[0].expect.status = ExpectedStatus::Unfavourable;
        assert_eq!(run_inline_tests(&facts(), &exclusive), vec![]);
    }

    #[test]
    fn a_date_range_over_a_column_whose_members_are_not_dates_is_refused() {
        // `constraint_admits` compares a range to a member as TEXT, so
        // `from: "2025-01-01"` admits "Refunds" and "Retail" alike: the rule
        // annotates facts it says nothing about, quietly.
        let mut doc = clean_doc();
        doc.rules.push(Rule {
            id: "r1".into(),
            measure: "Returns".into(),
            scope: Scope::from([(col("Dim", "Dept"), ScopeValue::from_onwards("2025-01-01"))]),
            set: AttributeSet {
                direction: Some(Direction::HigherIsBetter),
                ..Default::default()
            },
            note: None,
        });
        let f = validate(&facts(), &doc)
            .into_iter()
            .find(|f| f.code == "date-range-on-non-date-column")
            .expect("a date range over department names must be refused");
        assert_eq!(f.severity, Severity::Error);
        assert!(
            f.message.contains("Dim[Dept]") && f.message.contains("Refunds"),
            "the finding must name the column and quote a member: {}",
            f.message
        );

        // THE LIMIT, ASSERTED. `ModelFacts` carries no column TYPES, so a column
        // with no declared members cannot be judged and is left alone rather
        // than guessed at. `Sales[Amount]` has no member list in the fixture.
        let mut unknowable = clean_doc();
        unknowable.tables.get_mut("Sales").unwrap().columns.insert(
            "Amount".into(),
            ColumnStrategy {
                role: Role::Analysis,
                priority: None,
            },
        );
        unknowable.rules.push(Rule {
            id: "r1".into(),
            measure: "Returns".into(),
            scope: Scope::from([(col("Sales", "Amount"), ScopeValue::from_onwards("2025-01-01"))]),
            set: AttributeSet {
                direction: Some(Direction::HigherIsBetter),
                ..Default::default()
            },
            note: None,
        });
        assert!(
            !codes(&validate(&facts(), &unknowable), Severity::Error)
                .contains(&"date-range-on-non-date-column"),
            "with no members to read, the check must not guess"
        );
    }

    #[test]
    fn the_model_block_is_reported_unreviewed_exactly_like_a_measure_or_a_table_row() {
        // It now carries the same `reviewed` flag they do, and `defaultTimeAxis`
        // is where a GUESSED calendar needs somewhere to be accepted.
        let doc = clean_doc();
        assert!(!doc.model.reviewed);
        let f = validate(&facts(), &doc)
            .into_iter()
            .find(|f| f.code == "unreviewed" && f.path == "model")
            .expect("the model block warns like every other row");
        assert_eq!(f.severity, Severity::Warning, "staleness never refuses");

        let mut reviewed = clean_doc();
        reviewed.model.reviewed = true;
        assert!(
            !validate(&facts(), &reviewed)
                .iter()
                .any(|f| f.code == "unreviewed" && f.path == "model"),
            "a confirmed block stops warning"
        );
    }

    #[test]
    fn a_target_naming_a_measure_the_model_does_not_have_is_still_refused_at_both_sites() {
        // Already validated before the sweep, and it must STAY validated: both
        // checks now live in one shared function, and the point of sharing it is
        // that neither site loses a check the other keeps.
        let by_entry = returns_with(
            Direction::HigherIsBetter,
            Some(Target::Measure { r#ref: "Gone".into() }),
        );
        let f = validate(&facts(), &by_entry)
            .into_iter()
            .find(|f| f.code == "unknown-measure" && f.path == "measures['Returns'].target")
            .expect("a measure target must name a real measure");
        assert_eq!(f.severity, Severity::Error);

        let mut by_rule = clean_doc();
        by_rule.rules.push(Rule {
            id: "r1".into(),
            measure: "Returns".into(),
            scope: Scope::from([(col("Dim", "Dept"), ScopeValue::Members(vec!["Refunds".into()]))]),
            set: AttributeSet {
                target: Some(Target::Measure { r#ref: "Gone".into() }),
                ..Default::default()
            },
            note: None,
        });
        assert!(validate(&facts(), &by_rule)
            .iter()
            .any(|f| f.code == "unknown-measure" && f.path == "rules[0].set.target"));
    }

    #[test]
    fn iso_dates_are_recognised_and_anything_else_is_not() {
        assert!(is_iso_date("2025-01-31"));
        assert!(is_iso_date("2025-12-01"));
        for bad in ["2025-1-31", "2025/01/31", "31-01-2025", "2025-13-01", "2025-01-00", ""] {
            assert!(!is_iso_date(bad), "'{bad}' should not be accepted");
        }
    }

    // --- the harness's own tests ---------------------------------------------
    //
    // THIS IS THE ARTIFACT A CONSULTANT IS ASKED TO TRUST. A green tick that
    // means "absence of evidence" is the worst failure available in this file,
    // so the runner is tested the way it tests: an intentionally under-specified
    // case must come back INVALID, and its repaired twin must still pass. A row
    // that was never vacuous in the first place proves nothing, which is why
    // every row below carries its own positive control.

    /// One inline test, appended to a document.
    fn with_test(
        mut doc: StrategyDoc,
        scope: Scope,
        given: TestGiven,
        expect: TestExpect,
    ) -> StrategyDoc {
        doc.tests.push(StrategyTest {
            measure: "Returns".into(),
            scope,
            given,
            expect,
        });
        doc
    }

    fn given(delta: f64, value: Option<f64>, baseline: Option<f64>) -> TestGiven {
        TestGiven {
            delta,
            value,
            baseline,
        }
    }

    fn expect(status: ExpectedStatus) -> TestExpect {
        TestExpect {
            status,
            decided_by: None,
        }
    }

    /// `Returns` with no direction anywhere: the model gives it no KPI and the
    /// strategy entry declares none, so nothing resolves one.
    fn returns_without_a_direction() -> StrategyDoc {
        let mut doc = clean_doc();
        doc.measures.get_mut("Returns").unwrap().direction = None;
        doc
    }

    /// `targetBand` on the measure entry, with the band declared ONLY by a rule
    /// scoped to one department. The document VALIDATES - `has_a_band_anywhere`
    /// is deliberately scope-blind - and yet at any other point there is no band
    /// to judge against.
    fn band_only_on_a_scoped_rule() -> StrategyDoc {
        let mut doc = returns_with(Direction::TargetBand, None);
        doc.rules.push(Rule {
            id: "refunds-capacity".into(),
            measure: "Returns".into(),
            scope: Scope::from([(col("Dim", "Dept"), ScopeValue::Members(vec!["Refunds".into()]))]),
            set: AttributeSet {
                target: Some(Target::band(1.0, 10.0)),
                ..Default::default()
            },
            note: None,
        });
        doc
    }

    /// `band_only_on_a_scoped_rule`, plus a materiality floor no small movement
    /// clears. The document shape the reviewer used to reproduce the vacuous
    /// green: identical to the one above except for a number.
    fn band_only_on_a_scoped_rule_with_a_floor() -> StrategyDoc {
        let mut doc = band_only_on_a_scoped_rule();
        doc.measures
            .get_mut("Returns")
            .expect("the fixture document has a Returns entry")
            .materiality = Some(Materiality::Absolute { value: 1000.0 });
        doc
    }

    fn refunds() -> Scope {
        Scope::from([(col("Dim", "Dept"), ScopeValue::Members(vec!["Refunds".into()]))])
    }

    fn retail() -> Scope {
        Scope::from([(col("Dim", "Dept"), ScopeValue::Members(vec!["Retail".into()]))])
    }

    #[test]
    fn an_under_specified_inline_test_is_reported_invalid_and_its_repaired_twin_still_passes() {
        // Each row: what is wrong, the document carrying the vacuous test, the
        // code that must come back, and the document carrying the repair.
        let relative = |value: f64| {
            let mut doc = clean_doc();
            doc.measures.get_mut("Returns").unwrap().materiality =
                Some(Materiality::Relative { value });
            doc
        };
        let neutral_direction = || {
            let mut doc = clean_doc();
            doc.measures.get_mut("Returns").unwrap().direction = Some(Direction::Neutral);
            doc
        };

        let rows: Vec<(&str, StrategyDoc, &str, StrategyDoc)> = vec![
            (
                "no direction resolves here, so the engine makes no claim at all",
                with_test(
                    returns_without_a_direction(),
                    Scope::new(),
                    given(5000.0, None, None),
                    expect(ExpectedStatus::Neutral),
                ),
                "test-has-no-judgement-to-assert",
                with_test(
                    clean_doc(),
                    Scope::new(),
                    given(5000.0, None, None),
                    expect(ExpectedStatus::Unfavourable),
                ),
            ),
            (
                "targetBand, but the band is declared only by a rule this point does not reach",
                with_test(
                    band_only_on_a_scoped_rule(),
                    retail(),
                    given(5.0, Some(5.0), None),
                    expect(ExpectedStatus::Neutral),
                ),
                "test-has-no-judgement-to-assert",
                with_test(
                    band_only_on_a_scoped_rule(),
                    refunds(),
                    given(5.0, Some(5.0), None),
                    expect(ExpectedStatus::Favourable),
                ),
            ),
            (
                "targetBand judges WHERE the value landed and the test states no value",
                with_test(
                    returns_with(Direction::TargetBand, Some(Target::band(1.0, 10.0))),
                    Scope::new(),
                    given(5.0, None, None),
                    expect(ExpectedStatus::Neutral),
                ),
                "test-needs-value",
                with_test(
                    returns_with(Direction::TargetBand, Some(Target::band(1.0, 10.0))),
                    Scope::new(),
                    given(5.0, Some(5.0), None),
                    expect(ExpectedStatus::Favourable),
                ),
            ),
            (
                "a relative floor is a fraction of something and the test states no baseline",
                with_test(
                    relative(0.5),
                    Scope::new(),
                    given(-10.0, None, None),
                    expect(ExpectedStatus::Favourable),
                ),
                "test-needs-baseline",
                // The repair asserts `immaterial`, not `neutral`: 10 against a
                // floor of 500 is below it, so the run builds no change fact and
                // there is no favourability for a `neutral` to be about. (The
                // row still prints the numbers; `Returns` here resolves no
                // target, so no variance fact judges the level either.)
                with_test(
                    relative(0.5),
                    Scope::new(),
                    given(-10.0, None, Some(1000.0)),
                    expect(ExpectedStatus::Immaterial),
                ),
            ),
            (
                // THE ROW THE REVIEWER REPRODUCED. Row 2's document plus a
                // materiality the old kernel never reached: it tested materiality
                // BEFORE it looked for a band, so an immaterial delta answered
                // `Claim(Neutral)` at a point with no band at all, `determined`
                // was a singleton, and the same document shape that is refused
                // one row above ran GREEN. It differs from that row only by a
                // number the code path did not read.
                "a movement below the floor is not 'neutral' - no change fact, so no favourability",
                with_test(
                    band_only_on_a_scoped_rule_with_a_floor(),
                    retail(),
                    given(5.0, None, None),
                    expect(ExpectedStatus::Neutral),
                ),
                "test-expects-the-unreachable",
                with_test(
                    band_only_on_a_scoped_rule_with_a_floor(),
                    retail(),
                    given(5.0, None, None),
                    expect(ExpectedStatus::Immaterial),
                ),
            ),
            (
                "a neutral direction can never produce 'favourable', whatever the numbers",
                with_test(
                    neutral_direction(),
                    Scope::new(),
                    given(5000.0, None, None),
                    expect(ExpectedStatus::Favourable),
                ),
                "test-expects-the-unreachable",
                with_test(
                    neutral_direction(),
                    Scope::new(),
                    given(5000.0, None, None),
                    expect(ExpectedStatus::Neutral),
                ),
            ),
            (
                "nothing suppresses this measure's direction, so 'suppressed' is unreachable",
                with_test(
                    clean_doc(),
                    Scope::new(),
                    given(-5000.0, None, None),
                    expect(ExpectedStatus::Suppressed),
                ),
                "test-expects-the-unreachable",
                with_test(
                    clean_doc(),
                    Scope::new(),
                    given(-5000.0, None, None),
                    expect(ExpectedStatus::Favourable),
                ),
            ),
        ];

        // EVERY ROW IS JUDGED, and the failures are collected rather than
        // panicked on one at a time. When a stage of the runner is deliberately
        // broken to prove it has teeth, "which rows red" is the measurement -
        // and a table that stops at the first one answers "row 1" no matter how
        // many stages were removed, which is how a stage came to be believed
        // proved by a row that never depended on it.
        let mut problems: Vec<String> = Vec::new();
        for (label, vacuous, code, repaired) in rows {
            let findings = run_inline_tests(&facts(), &vacuous);
            let codes: Vec<&str> = findings.iter().map(|f| f.code.as_str()).collect();
            if codes != vec![code] {
                problems.push(format!("'{label}' must be reported {code}, got {findings:?}"));
            }
            if !findings.iter().all(|f| f.severity == Severity::Error) {
                problems.push(format!(
                    "'{label}': an unprovable test must REFUSE the document, not warn"
                ));
            }
            if !is_refused(&validate(&facts(), &vacuous)) {
                problems.push(format!(
                    "'{label}': the finding must reach `validate` and refuse the save"
                ));
            }

            // POSITIVE CONTROL. Without it a row could be "invalid" because the
            // document is broken in some unrelated way, and the harness would
            // be proving nothing at all.
            let repaired_findings = run_inline_tests(&facts(), &repaired);
            if !repaired_findings.is_empty() {
                problems.push(format!(
                    "'{label}': the repaired document must run green, got {repaired_findings:?}"
                ));
            }
        }
        assert!(problems.is_empty(), "{}", problems.join("\n\n"));
    }

    #[test]
    fn a_test_the_old_guards_refused_for_the_wrong_reason_now_runs() {
        // FOUR FALSE REFUSALS the shape-based guards produced. They asked what
        // the STRATEGY names, not whether the VERDICT depends on it, and they
        // ran before the suppression short-circuit - so a perfectly determined
        // assertion was reported as unjudgeable.

        // (a) delta = 0 under a relative floor: immaterial for EVERY baseline,
        // so no baseline can change the verdict. The word for it is
        // `immaterial` and not `neutral` - a movement of nothing produces no
        // fact, so there is no sentence in the report for `neutral` to qualify.
        let mut zero = clean_doc();
        zero.measures.get_mut("Returns").unwrap().materiality =
            Some(Materiality::Relative { value: 0.02 });
        let zero = with_test(
            zero,
            Scope::new(),
            given(0.0, None, None),
            expect(ExpectedStatus::Immaterial),
        );
        assert_eq!(
            run_inline_tests(&facts(), &zero),
            vec![],
            "delta 0 is below every floor, whatever the baseline"
        );

        // (b) a relative floor of zero: material for EVERY baseline.
        let mut floorless = clean_doc();
        floorless.measures.get_mut("Returns").unwrap().materiality =
            Some(Materiality::Relative { value: 0.0 });
        let floorless = with_test(
            floorless,
            Scope::new(),
            given(-10.0, None, None),
            expect(ExpectedStatus::Favourable),
        );
        assert_eq!(run_inline_tests(&facts(), &floorless), vec![]);

        // (c) a band direction whose movement is IMMATERIAL: the value never
        // gets read, so demanding one was refusing a determined test.
        //
        // THIS CASE ASSERTED `neutral` AND WAS WRONG TO. At that point the run
        // emits NO fact whatever - the `Change` fact is built inside the
        // materiality gate, and a Band target yields no `target_value` so no
        // Variance fact is built either - and the old harness answered `neutral`
        // for it, which is the same vacuous green the whole family is about.
        // Enshrining it in a passing test made this file assert the defect. The
        // test is legitimate; the word was wrong.
        let mut immaterial = returns_with(Direction::TargetBand, Some(Target::band(1.0, 10.0)));
        immaterial.measures.get_mut("Returns").unwrap().materiality =
            Some(Materiality::Absolute { value: 1000.0 });
        let immaterial = with_test(
            immaterial,
            Scope::new(),
            given(10.0, None, None),
            expect(ExpectedStatus::Immaterial),
        );
        assert_eq!(run_inline_tests(&facts(), &immaterial), vec![]);
        // ...and the old spelling is now REFUSED, which is the half that makes
        // the paragraph above more than an opinion.
        let mut still_neutral = returns_with(Direction::TargetBand, Some(Target::band(1.0, 10.0)));
        still_neutral.measures.get_mut("Returns").unwrap().materiality =
            Some(Materiality::Absolute { value: 1000.0 });
        let still_neutral = with_test(
            still_neutral,
            Scope::new(),
            given(10.0, None, None),
            expect(ExpectedStatus::Neutral),
        );
        assert_eq!(
            run_inline_tests(&facts(), &still_neutral)
                .iter()
                .map(|f| f.code.as_str())
                .collect::<Vec<_>>(),
            vec!["test-expects-the-unreachable"],
            "a movement below the floor can never come out 'neutral'"
        );

        // (d) `expect: suppressed` on a measure that is BOTH a band and
        // relative: Rule 4 answers without reading the value or the direction,
        // and the old shape-based guards refused the test before Rule 4 ever
        // ran.
        //
        // IT DOES NOT ANSWER BEFORE THE FLOOR, and this case used to claim it
        // did - it stated no baseline and was green. A withheld direction only
        // withholds the judgement from a fact that EXISTS: below the floor
        // `facts_for_measure` emits nothing, so there is no fact to withhold a
        // direction from and the honest verdict is `immaterial`. Which of the
        // two a relative floor gives therefore depends on the baseline, and a
        // test that does not state one is under-specified. It states one now.
        let mut suppressed = returns_with(Direction::TargetBand, Some(Target::band(1.0, 10.0)));
        suppressed.measures.get_mut("Returns").unwrap().materiality =
            Some(Materiality::Relative { value: 0.03 });
        suppressed.rules.push(Rule {
            id: "refunds-are-different".into(),
            measure: "Returns".into(),
            scope: refunds(),
            set: AttributeSet {
                direction: Some(Direction::LowerIsBetter),
                ..Default::default()
            },
            note: None,
        });
        let suppressed = with_test(
            suppressed,
            Scope::new(),
            given(45000.0, None, Some(600000.0)),
            TestExpect {
                status: ExpectedStatus::Suppressed,
                decided_by: Some("refunds-are-different".into()),
            },
        );
        assert_eq!(run_inline_tests(&facts(), &suppressed), vec![]);
    }

    #[test]
    fn a_movement_below_the_floor_on_a_measure_with_no_target_is_immaterial() {
        // THE TWO HALVES OF ONE CLAIM, ASSERTED TOGETHER. The harness may call a
        // movement `immaterial` only if the planner really does judge nothing
        // about it - and the whole `neutral` conflation survived a review
        // because that half was asserted against a MIRROR of the planner rather
        // than against the planner. This test runs both.
        //
        // THE NAME SAYS `with no target` BECAUSE THE FIXTURE HAS NONE, and the
        // previous name did not. `clean_doc`'s Returns declares no target and
        // the observation below leaves `target_value` at its default `None`, so
        // "the run emits no fact" held here for a reason the input never stated;
        // the same measure with a literal target is judged at this very point,
        // which `a_movement_below_the_floor_against_a_target_is_still_judged`
        // proves against the planner.
        let mut doc = clean_doc();
        doc.measures.get_mut("Returns").unwrap().materiality =
            Some(Materiality::Absolute { value: 1000.0 });
        assert!(
            doc.measures["Returns"].target.is_none(),
            "this fixture's whole point is that nothing resolves a target here"
        );
        let resolved = resolve(&facts(), &doc, "Returns", &point_from_scope(&Scope::new()));
        let locale = LocaleSettings::from_locale_id("en-US");

        // The harness: 10 against a floor of 1000.
        assert_eq!(
            judge(&resolved, &given(10.0, None, Some(600.0))).verdict,
            Verdict::Claim(ExpectedStatus::Immaterial)
        );

        // The planner, on the same measure and the same movement: 600 -> 610.
        let below = MeasureObservation {
            measure: "Returns".to_string(),
            labels: vec!["Jan".to_string(), "Feb".to_string()],
            values: vec![600.0, 610.0],
            ..MeasureObservation::default()
        };
        let (produced, run) = facts_for_measure(&below, &resolved, &locale);
        assert!(
            produced.is_empty(),
            "with no target the run emits no fact at all below the floor - that is what makes \
             `immaterial` a different word from `neutral`, which qualifies a fact that exists: {:?}",
            produced.iter().map(|f| f.kind.kind_key()).collect::<Vec<_>>()
        );
        assert_eq!(run.favourability, None, "and nothing carries a favourability");
        // ...THE NUMBERS ARE STILL PRINTED, THOUGH. `immaterial` means "no
        // change fact, so no favourability", NOT "the report is silent": the row
        // carries the prior period, the delta and the percentage whatever the
        // floor says, and only the Status cell stops naming a word.
        //
        // IT IS NEVER EMPTY, WHICH IS THE POINT OF THE WORD IT CARRIES INSTEAD.
        // This line used to say the cell goes empty. `favourability_word` maps
        // `None` to "No claim", and report.rs says beside it that "An empty
        // status cell reads as 'nothing happened'" - the two other comments in
        // this file describing the same point already spell it "No claim".
        assert_eq!(run.prior_value, Some(600.0));
        assert_eq!(run.delta, Some(10.0));
        assert!(run.pct.is_some(), "the percentage is set before the gate too");

        // POSITIVE CONTROL. The same measure and the same floor, cleared: a fact
        // appears, it is judged, and the harness says the same word about it.
        let above = MeasureObservation {
            values: vec![600.0, 2600.0],
            ..below.clone()
        };
        let (produced, run) = facts_for_measure(&above, &resolved, &locale);
        assert!(
            produced.iter().any(|f| f.kind.kind_key() == "change"),
            "a movement of 2000 clears a floor of 1000"
        );
        assert_eq!(
            run.favourability,
            Some(Favourability::Worse),
            "Returns is lowerIsBetter and this went up"
        );
        assert_eq!(
            judge(&resolved, &given(2000.0, None, Some(600.0))).verdict,
            Verdict::Claim(ExpectedStatus::Unfavourable)
        );
    }

    /// `Returns`, lowerIsBetter, with a literal target and whatever floor is
    /// handed in - the shape every `Immaterial` fixture in this file avoided.
    fn returns_against_a_literal_target(materiality: Option<Materiality>) -> StrategyDoc {
        let mut doc = clean_doc();
        let returns = doc.measures.get_mut("Returns").expect("clean_doc has Returns");
        returns.target = Some(Target::Literal { value: 500.0 });
        returns.materiality = materiality;
        doc
    }

    #[test]
    fn a_movement_below_the_floor_against_a_target_is_still_judged() {
        // THE VACUOUS GREEN, THIRD SPELLING, AND IT WAS THE REPAIR THAT MADE IT.
        // The previous pass answered `Immaterial` the moment the movement fell
        // below the floor, on the stated premise that below the floor "the run
        // says nothing whatever". It is not true when a target resolves:
        // `facts_for_measure` builds its Variance branch OUTSIDE the materiality
        // gate, so the report judges the LEVEL and prints a word - and the test
        // asserting silence went green over it.
        //
        // Materiality is a property of a MOVEMENT and a variance is a comparison
        // of LEVELS; a tiny movement can sit far from target. So the fix is here
        // and not in `facts_for_measure`.
        let doc = returns_against_a_literal_target(Some(Materiality::Absolute { value: 1000.0 }));
        let resolved = resolve(&facts(), &doc, "Returns", &point_from_scope(&Scope::new()));
        let locale = LocaleSettings::from_locale_id("en-US");

        // THE PLANNER FIRST, so the claim about the report is proved and not
        // asserted: 600 -> 610 is a movement of 10 against a floor of 1000, and
        // 610 against a target of 500 is over by 110 on a lowerIsBetter measure.
        let observation = MeasureObservation {
            measure: "Returns".to_string(),
            labels: vec!["Jan".to_string(), "Feb".to_string()],
            values: vec![600.0, 610.0],
            target_value: Some(500.0),
            ..MeasureObservation::default()
        };
        let (produced, run) = facts_for_measure(&observation, &resolved, &locale);
        assert_eq!(
            produced.iter().map(|f| f.kind.kind_key()).collect::<Vec<_>>(),
            vec!["variance"],
            "no change fact below the floor, and a variance fact regardless of it"
        );
        assert!(
            produced[0].text.contains("worse"),
            "the report calls the measure worse in so many words: {}",
            produced[0].text
        );
        assert_eq!(run.favourability, None, "the CHANGE fact is still gated");
        assert_eq!(run.target, Some(500.0));

        // AND THE HARNESS SAYS THE SAME WORD.
        let point = given(10.0, Some(610.0), Some(600.0));
        assert_eq!(
            judge(&resolved, &point).verdict,
            Verdict::Claim(ExpectedStatus::Unfavourable),
            "the point the report calls worse cannot be reported as `immaterial`"
        );

        // THE REPRODUCTION, END TO END: the assertion that used to run green.
        let vacuous = with_test(
            doc.clone(),
            Scope::new(),
            point.clone(),
            expect(ExpectedStatus::Immaterial),
        );
        assert_eq!(
            run_inline_tests(&facts(), &vacuous)
                .iter()
                .map(|f| f.code.as_str())
                .collect::<Vec<_>>(),
            vec!["inline-test-failed"],
            "a test asserting the report is silent, where the report judges the measure worse"
        );

        // POSITIVE CONTROL: the word the report really uses runs green.
        let truthful = with_test(doc, Scope::new(), point, expect(ExpectedStatus::Unfavourable));
        assert_eq!(run_inline_tests(&facts(), &truthful), vec![]);

        // AND THE TARGET IS WHAT DOES IT. Drop `target_value` from the same
        // observation and the run really does fall silent - which is what makes
        // the `Immaterial` fixtures above true for a reason, rather than by
        // accident.
        let no_target = MeasureObservation {
            target_value: None,
            ..observation
        };
        assert!(
            facts_for_measure(&no_target, &resolved, &locale).0.is_empty(),
            "without a resolved target there is nothing at this point to judge"
        );
    }

    #[test]
    fn a_flat_period_against_a_target_is_judged_with_no_materiality_declared_anywhere() {
        // THE WIDER HALF OF THE SAME HOLE, and it needs no materiality entry at
        // all: `clears_materiality(None, ..)` is `delta != 0`, so ANY flat period
        // on ANY measure with a literal or measure target landed in it. Under
        // the old code the point answered `Neutral`, the repair traded that for
        // `Immaterial`, and the report says neither.
        let doc = returns_against_a_literal_target(None);
        assert!(
            doc.measures["Returns"].materiality.is_none(),
            "the point of this fixture is that no floor is declared anywhere"
        );
        let resolved = resolve(&facts(), &doc, "Returns", &point_from_scope(&Scope::new()));
        let locale = LocaleSettings::from_locale_id("en-US");

        let flat = MeasureObservation {
            measure: "Returns".to_string(),
            labels: vec!["Jan".to_string(), "Feb".to_string()],
            values: vec![610.0, 610.0],
            target_value: Some(500.0),
            ..MeasureObservation::default()
        };
        let (produced, _) = facts_for_measure(&flat, &resolved, &locale);
        assert_eq!(
            produced.iter().map(|f| f.kind.kind_key()).collect::<Vec<_>>(),
            vec!["variance"]
        );

        let point = given(0.0, Some(610.0), Some(610.0));
        assert_eq!(
            judge(&resolved, &point).verdict,
            Verdict::Claim(ExpectedStatus::Unfavourable)
        );
        assert_eq!(
            run_inline_tests(
                &facts(),
                &with_test(doc, Scope::new(), point, expect(ExpectedStatus::Immaterial))
            )
            .iter()
            .map(|f| f.code.as_str())
            .collect::<Vec<_>>(),
            vec!["inline-test-failed"]
        );
    }

    #[test]
    fn a_movement_and_a_level_that_disagree_leave_the_point_with_two_words() {
        // NEITHER WORD IS THE ANSWER. Returns fell 50 - good news on a
        // lowerIsBetter measure - and landed at 610 against a target of 500,
        // which is bad news. Both facts ship, both carry a favourability, and
        // they disagree; a test pinning either one would be picking a favourite
        // and calling it the report's verdict.
        let doc = returns_against_a_literal_target(None);
        let resolved = resolve(&facts(), &doc, "Returns", &point_from_scope(&Scope::new()));
        let locale = LocaleSettings::from_locale_id("en-US");

        let observation = MeasureObservation {
            measure: "Returns".to_string(),
            labels: vec!["Jan".to_string(), "Feb".to_string()],
            values: vec![660.0, 610.0],
            target_value: Some(500.0),
            ..MeasureObservation::default()
        };
        let (produced, run) = facts_for_measure(&observation, &resolved, &locale);
        assert_eq!(
            produced.iter().map(|f| f.kind.kind_key()).collect::<Vec<_>>(),
            vec!["change", "variance"]
        );
        assert_eq!(run.favourability, Some(Favourability::Better), "it fell");
        let variance = produced
            .iter()
            .find(|f| f.kind.kind_key() == "variance")
            .expect("the variance fact is right there");
        assert!(
            variance.text.contains("worse"),
            "...and it is still over target: {}",
            variance.text
        );

        let point = given(-50.0, Some(610.0), Some(660.0));
        assert_eq!(judge(&resolved, &point).verdict, Verdict::TwoAnswers);
        for status in [
            ExpectedStatus::Favourable,
            ExpectedStatus::Unfavourable,
            ExpectedStatus::Neutral,
            ExpectedStatus::Immaterial,
            ExpectedStatus::Suppressed,
        ] {
            let doc = with_test(doc.clone(), Scope::new(), point.clone(), expect(status));
            assert_eq!(
                run_inline_tests(&facts(), &doc)
                    .iter()
                    .map(|f| f.code.as_str())
                    .collect::<Vec<_>>(),
                vec!["test-point-has-two-answers"],
                "no `expect` can be right here, including '{status}'"
            );
        }
    }

    #[test]
    fn a_target_carried_by_another_measure_cannot_be_judged_from_the_document() {
        // A `Target::Measure` DOES produce a variance fact - `model_commands`
        // queries the other measure and fills `target_value` in - so the point
        // is judged, and this file cannot know with which word: the value only
        // exists once a query has run. Answering `immaterial` there would be the
        // same vacuous green one step further out.
        let mut doc = clean_doc();
        doc.measures.get_mut("Returns").unwrap().target = Some(Target::Measure {
            r#ref: "Churn".into(),
        });
        let resolved = resolve(&facts(), &doc, "Returns", &point_from_scope(&Scope::new()));
        let point = given(10.0, Some(610.0), Some(600.0));
        assert_eq!(judge(&resolved, &point).verdict, Verdict::UnknownTarget);

        let findings = run_inline_tests(
            &facts(),
            &with_test(doc, Scope::new(), point, expect(ExpectedStatus::Unfavourable)),
        );
        assert_eq!(
            findings.iter().map(|f| f.code.as_str()).collect::<Vec<_>>(),
            vec!["test-target-is-another-measure"]
        );
        assert!(
            findings[0].message.contains("'Churn'"),
            "the finding names the measure that carries the target: {}",
            findings[0].message
        );
    }

    #[test]
    fn the_materiality_floor_answers_before_rule_4_does() {
        // THE GATE ORDER, WHICH NOTHING ELSE IN THIS FILE PINS. A point that is
        // BOTH below the floor and direction-suppressed satisfies every other
        // assertion here under either order - `favourability_at` returns `None`
        // under suppression, so the cross-product sweep's `Suppressed` arm is
        // happy whichever way round the two gates run. Swapping the two gates in
        // `judge_with` and running the whole crate reds this test and
        // `where_a_variance_is_built_the_harness_says_what_the_run_really_emits`,
        // and nothing else - measured, because the sentence that stood here
        // asserted a count of tests that stayed green and named a number no
        // filter in this repo produces. A number in a comment proves nothing
        // anyway: if a total matters, a test has to assert it.
        //
        // Materiality is first because it decides whether the fact EXISTS. Rule
        // 4 withholds a judgement FROM a fact; below the floor there is no such
        // fact to withhold one from, so `suppressed` there would name a rule
        // that decided nothing.
        let mut doc = doc_with_refunds_rule();
        doc.measures.get_mut("Returns").unwrap().materiality =
            Some(Materiality::Absolute { value: 1000.0 });
        // The unscoped point rolls Refunds and Retail up, and they disagree
        // about direction, so Rule 4 suppresses it.
        let resolved = resolve(&facts(), &doc, "Returns", &point_from_scope(&Scope::new()));
        assert!(
            resolved.suppression_of(Attribute::Direction).is_some(),
            "the fixture must really be suppressed, or this proves nothing about the order"
        );

        let below = given(10.0, None, Some(600.0));
        assert_eq!(
            judge(&resolved, &below).verdict,
            Verdict::Claim(ExpectedStatus::Immaterial),
            "below the floor there is no fact for Rule 4 to withhold a direction from"
        );
        assert_eq!(
            judge(&resolved, &below).decided_by,
            None,
            "and the suppressing rule decided nothing here, so it is not named"
        );

        // THE OTHER SIDE OF THE SAME FLOOR, which is what makes the assertion
        // above about the ORDER rather than about materiality swallowing Rule 4
        // entirely.
        let above = given(5000.0, None, Some(600.0));
        assert_eq!(
            judge(&resolved, &above).verdict,
            Verdict::Claim(ExpectedStatus::Suppressed)
        );
        assert_eq!(
            judge(&resolved, &above).decided_by,
            Some("refunds-dept".to_string())
        );

        // ...and through the runner, because that is where a consultant meets it.
        assert_eq!(
            run_inline_tests(
                &facts(),
                &with_test(doc, Scope::new(), below, expect(ExpectedStatus::Immaterial))
            ),
            vec![]
        );
    }

    #[test]
    fn the_probe_floor_is_wherever_the_planners_own_gate_puts_it() {
        // `materiality_boundary` used to be a third copy of `clears_materiality`
        // - one caller, no test - and the probes that decide whether a test is
        // under-specified are chosen from it. It now bisects the planner's gate,
        // so what has to be proved is that the bisection lands where the gate
        // switches, including on the two shapes with a special case in them.
        let with = |m: Option<Materiality>| ResolvedMeasure {
            measure: "Returns".to_string(),
            materiality: m.map(|m| Applied::new(m, AttrSource::Strategy)),
            ..Default::default()
        };
        let cases: Vec<(&str, ResolvedMeasure, f64, f64)> = vec![
            ("no floor at all: any real movement counts", with(None), 100.0, 0.0),
            (
                "an absolute floor is the floor",
                with(Some(Materiality::Absolute { value: 1000.0 })),
                100.0,
                1000.0,
            ),
            (
                "a relative floor is a fraction of the baseline",
                with(Some(Materiality::Relative { value: 0.5 })),
                1000.0,
                500.0,
            ),
            (
                "a fraction of nothing is not a threshold",
                with(Some(Materiality::Relative { value: 0.5 })),
                0.0,
                0.0,
            ),
        ];
        for (label, r, baseline, expected) in cases {
            let boundary = materiality_boundary(&r, baseline);
            assert!(
                (boundary - expected).abs() <= expected.abs() * 1e-9,
                "{label}: boundary {boundary}, expected {expected}"
            );
            let materiality = r.materiality.as_ref().map(|m| &m.value);
            if boundary == 0.0 {
                assert!(
                    clears_materiality(materiality, baseline, f64::MIN_POSITIVE),
                    "{label}: a floor of zero must let the smallest movement through"
                );
            } else {
                assert!(
                    clears_materiality(materiality, baseline, boundary),
                    "{label}: the boundary itself must be material"
                );
                assert!(
                    !clears_materiality(materiality, baseline, boundary / 2.0),
                    "{label}: half of it must not be, or the probes never land below the floor"
                );
            }
        }
    }

    /// Every shape a resolved measure can take, for the two invariant sweeps.
    fn every_resolved_shape() -> Vec<ResolvedMeasure> {
        let mut out = Vec::new();
        let directions = [
            None,
            Some(Direction::HigherIsBetter),
            Some(Direction::LowerIsBetter),
            Some(Direction::Neutral),
            Some(Direction::TargetBand),
        ];
        let materialities = [
            None,
            Some(Materiality::Absolute { value: 100.0 }),
            Some(Materiality::Relative { value: 0.1 }),
        ];
        let targets = [
            None,
            // A number, so the run builds a VARIANCE fact here and a movement
            // below the floor is still judged. Every shape in this list used to
            // be a band, a KPI or nothing, which is the reason a whole family of
            // vacuous greens lived under these two sweeps undisturbed.
            Some(Target::Literal { value: 5.0 }),
            // A number only a query knows: the variance exists and its word does
            // not follow from the document.
            Some(Target::Measure {
                r#ref: "Plan".to_string(),
            }),
            Some(Target::band(90.0, 140.0)),
            // The band no value can satisfy: `contains` is false everywhere, so
            // `favourable` is not in its reachable set at all.
            Some(Target::band(140.0, 90.0)),
            Some(Target::Kpi),
        ];
        for suppressed in [false, true] {
            for direction in &directions {
                for materiality in &materialities {
                    for target in &targets {
                        out.push(ResolvedMeasure {
                            measure: "Returns".to_string(),
                            direction: direction
                                .map(|d| Applied::new(d, AttrSource::Strategy)),
                            materiality: materiality
                                .clone()
                                .map(|m| Applied::new(m, AttrSource::Strategy)),
                            target: target.clone().map(|t| Applied::new(t, AttrSource::Strategy)),
                            suppressions: if suppressed {
                                vec![Suppression {
                                    attribute: Attribute::Direction,
                                    rule: "mixed".to_string(),
                                    reason: "the aggregate spans two directions".to_string(),
                                }]
                            } else {
                                Vec::new()
                            },
                            ..Default::default()
                        });
                    }
                }
            }
        }
        out
    }

    fn every_given() -> Vec<TestGiven> {
        let mut out = Vec::new();
        for delta in [-1.0, 0.0, 1.0, -1000.0, 1000.0] {
            for value in [None, Some(80.0), Some(120.0), Some(160.0)] {
                for baseline in [None, Some(0.0), Some(1000.0)] {
                    out.push(TestGiven {
                        delta,
                        value,
                        baseline,
                    });
                }
            }
        }
        out
    }

    #[test]
    fn judge_never_returns_a_verdict_outside_its_own_reachable_set() {
        // THE INVARIANT THE OLD KERNEL BROKE. Under a band direction with no
        // observed value it answered `Neutral` - a status that was not even in
        // the set of statuses that point could produce - and a test expecting
        // `neutral` therefore passed over nothing at all.
        for r in every_resolved_shape() {
            for g in every_given() {
                let j = judge(&r, &g);
                assert!(
                    j.determined.contains(&j.verdict),
                    "the verdict {:?} is not in what the omitted fields can reach {:?} \
                     (direction {:?}, materiality {:?}, target {:?}, given {g:?})",
                    j.verdict,
                    j.determined,
                    r.direction.as_ref().map(|d| d.value),
                    r.materiality.as_ref().map(|m| &m.value),
                    r.target.as_ref().map(|t| &t.value),
                );
                assert!(
                    j.possible.is_superset(&j.determined),
                    "freeing MORE fields can only reach more: {:?} vs {:?}",
                    j.possible,
                    j.determined
                );
            }
        }
    }

    #[test]
    fn where_only_the_movement_is_judged_the_harness_says_the_planners_own_word() {
        // WHAT THIS GUARD IS NOW FOR. It used to diff two implementations of the
        // same judgement and carried a carve-out - `Claim(Neutral) if !material`
        // - for the one place they contradicted each other outright: with an
        // absolute floor of 100, a `targetBand` direction, a band of [90, 140],
        // a value of 120 and a delta of 1 the harness said "neutral" while
        // `favourability_at` said `Better`. The single case the guard existed to
        // catch was the single case it skipped.
        //
        // `judge_once` now CALLS `favourability_at`, so the two cannot disagree
        // by construction and there is nothing to carve out. What is left to
        // prove, and what this sweep proves, is the two things a shared function
        // does not give you for free: that the `Favourability` -> `ExpectedStatus`
        // mapping is faithful, and that the harness draws the materiality floor
        // in the SAME place the planner does. It also reds immediately if
        // anybody re-forks the judgement.
        //
        // AND IT IS THE MOVEMENT'S HALF ONLY, which the name now says. Where a
        // Variance fact is also built the point can carry a SECOND favourability
        // computed at a different delta - `value - target` rather than the
        // movement - so `favourability_at(.., g.delta)` is no longer the whole
        // answer there and asserting it as if it were is how the third vacuous
        // green got in. THE HALF THIS ONE SKIPS IS SWEPT BY
        // `where_a_variance_is_built_the_harness_says_what_the_run_really_emits`,
        // which runs the planner instead of `favourability_at` - a narrowing
        // that leaves no sweep behind it is how the variance half came to rest on
        // three hand-picked fixtures.
        let mut only_the_movement = 0_usize;
        let mut skipped = 0_usize;
        for r in every_resolved_shape() {
            for g in every_given() {
                if variance_at(&r, &g) != vec![VarianceFact::NotBuilt] {
                    skipped += 1;
                    continue;
                }
                only_the_movement += 1;
                let planner = favourability_at(&r, g.value, g.delta);
                let material = clears_materiality(
                    r.materiality.as_ref().map(|m| &m.value),
                    g.baseline.unwrap_or(0.0),
                    g.delta,
                );
                let context = format!(
                    "direction {:?}, materiality {:?}, target {:?}, given {g:?}",
                    r.direction.as_ref().map(|d| d.value),
                    r.materiality.as_ref().map(|m| &m.value),
                    r.target.as_ref().map(|t| &t.value),
                );
                match judge(&r, &g).verdict {
                    Verdict::Claim(ExpectedStatus::Favourable) => {
                        assert!(material, "a fact must exist to be favourable: {context}");
                        assert_eq!(planner, Some(Favourability::Better), "{context}")
                    }
                    Verdict::Claim(ExpectedStatus::Unfavourable) => {
                        assert!(material, "a fact must exist to be unfavourable: {context}");
                        assert_eq!(planner, Some(Favourability::Worse), "{context}")
                    }
                    Verdict::Claim(ExpectedStatus::Neutral) => {
                        // NO `if !material` HERE ANY MORE. `neutral` is now a
                        // claim about a fact that exists, so it must clear the
                        // floor AND match the planner - both halves, no arm of
                        // this match skipped.
                        assert!(material, "a fact must exist to be neutral: {context}");
                        assert_eq!(planner, Some(Favourability::Neutral), "{context}")
                    }
                    // The one verdict with no planner counterpart, and
                    // deliberately: with no fact built at all `favourability_at`
                    // is never consulted, and diffing against it would be
                    // diffing against a question nobody asked. What must hold -
                    // and what the whole family of vacuous greens came from
                    // getting wrong - is that the harness and the planner put
                    // the floor in the same place.
                    Verdict::Claim(ExpectedStatus::Immaterial) => {
                        assert!(!material, "{context}")
                    }
                    // Rule 4 and "no direction here" are the planner's SAME
                    // `None`: the numbers ship, the judgement does not.
                    Verdict::Claim(ExpectedStatus::Suppressed) | Verdict::NoClaim => {
                        assert_eq!(planner, None, "{context}")
                    }
                    // Both need a second fact, which the filter above excluded.
                    Verdict::TwoAnswers | Verdict::UnknownTarget => panic!(
                        "no variance fact is built here, so there is no second judgement to \
                         disagree with: {context}"
                    ),
                }
            }
        }
        // THE FILTER MUST NOT HAVE EATEN THE SWEEP, in either direction: an
        // empty loop passes, and a filter that skips nothing proves the skipped
        // shapes are unreachable rather than covered elsewhere.
        assert!(only_the_movement > 0 && skipped > 0, "{only_the_movement} judged, {skipped} skipped");
    }

    #[test]
    fn a_verdict_that_is_invariant_under_the_whole_given_is_a_legitimate_pin() {
        // The counterweight to everything above: a test whose answer does not
        // depend on its numbers is not automatically vacuous. Rule 4 answers
        // before any number is read, and a `neutral` DIRECTION answers the same
        // way for every movement. Both are things a consultant should be able to
        // pin, and warning about them would refuse documents that are right.
        let mut suppressed = clean_doc();
        suppressed.rules.push(Rule {
            id: "refunds-dept".into(),
            measure: "Returns".into(),
            scope: refunds(),
            set: AttributeSet {
                direction: Some(Direction::HigherIsBetter),
                ..Default::default()
            },
            note: None,
        });
        let suppressed = with_test(
            suppressed,
            Scope::new(),
            given(5000.0, None, None),
            TestExpect {
                status: ExpectedStatus::Suppressed,
                decided_by: Some("refunds-dept".into()),
            },
        );
        assert_eq!(run_inline_tests(&facts(), &suppressed), vec![]);

        let mut neutral = clean_doc();
        neutral.measures.get_mut("Returns").unwrap().direction = Some(Direction::Neutral);
        let neutral = with_test(
            neutral,
            Scope::new(),
            given(5000.0, None, None),
            expect(ExpectedStatus::Neutral),
        );
        assert_eq!(run_inline_tests(&facts(), &neutral), vec![]);
    }

    #[test]
    fn a_given_whose_value_and_baseline_contradict_its_delta_is_refused() {
        // THE FOURTH VACUOUS GREEN, AND EVERY GUARD IN THIS FILE WAS BLIND TO IT.
        // The three `given` fields are not independent - a run reads two
        // consecutive periods, so the baseline of any real point is
        // `value - delta` - and the harness reads the triple through two
        // different doors: `is_material` takes the floor from `baseline` and
        // `delta`, while the level is judged from `value`. State a baseline that
        // contradicts the other two and the floor moves under a level the
        // harness still judges.
        let mut doc = clean_doc();
        doc.measures
            .get_mut("Returns")
            .expect("clean_doc has a Returns entry")
            .materiality = Some(Materiality::Relative { value: 0.05 });
        assert!(
            doc.measures["Returns"].target.is_none(),
            "no target here: the fact the harness wrongly called absent is the CHANGE fact"
        );
        let resolved = resolve(&facts(), &doc, "Returns", &point_from_scope(&Scope::new()));
        let locale = LocaleSettings::from_locale_id("en-US");

        // 610 - 1000 is -390, not 40.
        let impossible = given(40.0, Some(610.0), Some(1000.0));
        assert!(!states_one_point(610.0, 1000.0, 40.0));

        // WHAT THE HARNESS STILL SAYS ABOUT IT, asserted rather than narrated:
        // 5% of 1000 is 50, the movement is 40, so the kernel answers
        // `immaterial` - and answers it as a DETERMINED verdict, because a test
        // that states all three fields leaves nothing for the sweep to vary.
        let j = judge(&resolved, &impossible);
        assert_eq!(j.verdict, Verdict::Claim(ExpectedStatus::Immaterial));
        assert_eq!(j.determined.len(), 1, "{:?}", j.determined);

        // AND WHAT THE PLANNER DOES WITH THE ONLY OBSERVATION THAT COULD PRODUCE
        // THAT POINT: 570 -> 610. The floor there is 5% of 570 = 28.5, which a
        // movement of 40 clears.
        let real = MeasureObservation {
            measure: "Returns".to_string(),
            labels: vec!["Jan".to_string(), "Feb".to_string()],
            values: vec![570.0, 610.0],
            ..MeasureObservation::default()
        };
        let (produced, run) = facts_for_measure(&real, &resolved, &locale);
        assert_eq!(
            produced.iter().map(|f| f.kind.kind_key()).collect::<Vec<_>>(),
            vec!["change"],
            "the run builds the very fact the assertion says is absent"
        );
        assert_eq!(
            run.favourability,
            Some(Favourability::Worse),
            "Returns is lowerIsBetter and this went up, so the Status cell reads 'Worse'"
        );

        // THE REFUSAL. Not a re-judgement: the runner will not silently derive
        // the baseline and judge a point the consultant did not write.
        let findings = run_inline_tests(
            &facts(),
            &with_test(
                doc.clone(),
                Scope::new(),
                impossible,
                expect(ExpectedStatus::Immaterial),
            ),
        );
        assert_eq!(
            findings.iter().map(|f| f.code.as_str()).collect::<Vec<_>>(),
            vec!["test-given-is-not-one-observation"]
        );
        assert_eq!(findings[0].severity, Severity::Error);
        assert_eq!(findings[0].path, "tests[0].given");
        assert!(
            findings[0].message.contains("570"),
            "the message names the baseline the run would use: {}",
            findings[0].message
        );

        // POSITIVE CONTROL: the same movement made into a real observation, and
        // asserting the word the report actually prints.
        let honest = with_test(
            doc,
            Scope::new(),
            given(40.0, Some(610.0), Some(570.0)),
            expect(ExpectedStatus::Unfavourable),
        );
        assert_eq!(run_inline_tests(&facts(), &honest), vec![]);
    }

    #[test]
    fn a_baseline_rounded_inside_the_tolerance_is_refused_when_it_moves_a_relative_floor() {
        // THE FOURTH VACUOUS GREEN AGAIN, LIVING INSIDE THE GATE BUILT TO STOP
        // IT. `states_one_point` cannot demand an exact triple - a hand-typed
        // `1_000_000.1 - 1_000_000.0` is a binary-float hair off `0.1` - so it
        // forgives `1e-9 * scale`. A RELATIVE floor is a fraction of the
        // baseline, so it turns that hair into a shift of the threshold, and a
        // movement stated ON its floor lands on the other side of it in the run.
        let mut doc = clean_doc();
        doc.measures
            .get_mut("Returns")
            .expect("clean_doc has a Returns entry")
            .materiality = Some(Materiality::Relative { value: 0.05 });
        let resolved = resolve(&facts(), &doc, "Returns", &point_from_scope(&Scope::new()));
        let locale = LocaleSettings::from_locale_id("en-US");

        // A consultant rounds the baseline of a 1.05-billion measure to a round
        // billion. Everything else is stated exactly.
        let value = 1_050_000_001.0_f64;
        let delta = 50_000_000.0_f64;
        let rounded = 1_000_000_000.0_f64;
        let derived = value - delta;

        // (a) THE CONSISTENCY PREDICATE LETS IT THROUGH, so it is not what
        // refuses this document and cannot be what this test is measuring.
        assert!(
            states_one_point(value, rounded, delta),
            "the residue is {}, inside the tolerance",
            (value - rounded) - delta
        );

        // (b) AND THE TWO BASELINES REALLY DO STRADDLE THE FLOOR. Without this
        // the fixture could be passing for the boring reason that both readings
        // answer alike, and the guard would pin nothing.
        let floor = resolved.materiality.as_ref().map(|m| &m.value);
        assert!(
            clears_materiality(floor, rounded, delta),
            "5% of the ROUNDED baseline is exactly the movement, so it clears"
        );
        assert!(
            !clears_materiality(floor, derived, delta),
            "5% of {derived} is above the movement, so the run's own baseline does not"
        );

        // (c) WHAT THE RUN DOES AT THAT POINT: nothing. No change fact, and
        // `Returns` resolves no target here, so no variance fact judges the
        // level either.
        let observation = MeasureObservation {
            measure: "Returns".to_string(),
            labels: vec!["Jan".to_string(), "Feb".to_string()],
            values: vec![derived, value],
            ..MeasureObservation::default()
        };
        let (produced, run) = facts_for_measure(&observation, &resolved, &locale);
        assert!(
            produced.is_empty(),
            "the run judges nothing here: {:?}",
            produced.iter().map(|f| f.kind.kind_key()).collect::<Vec<_>>()
        );
        assert_eq!(run.favourability, None, "so the Status cell reads 'No claim'");

        // (d) WHAT THE KERNEL SAYS, MEASURED RATHER THAN NARRATED: it reads the
        // stated baseline, so it judges the movement and calls it unfavourable -
        // a word over a report that prints none. That is why the refusal has to
        // happen in the gate and not by hoping the kernel agrees.
        let point = given(delta, Some(value), Some(rounded));
        assert_eq!(
            judge(&resolved, &point).verdict,
            Verdict::Claim(ExpectedStatus::Unfavourable)
        );

        let refused = with_test(
            doc.clone(),
            Scope::new(),
            point.clone(),
            expect(ExpectedStatus::Unfavourable),
        );
        let findings = run_inline_tests(&facts(), &refused);
        assert_eq!(
            findings.iter().map(|f| f.code.as_str()).collect::<Vec<_>>(),
            vec!["test-given-is-not-one-observation"]
        );
        assert_eq!(findings[0].path, "tests[0].given");
        assert!(
            findings[0].message.contains("1000000001"),
            "the message names the baseline the run would use: {}",
            findings[0].message
        );

        // POSITIVE CONTROL, AND IT IS THE HALF THAT KEEPS THIS FROM BEING A
        // BLANKET REFUSAL OF ROUNDED BASELINES: the same rounding under an
        // ABSOLUTE floor changes nothing - `clears_materiality` never reads the
        // baseline there - so the test is judged, and judged against the word
        // the run really produces.
        let mut absolute = clean_doc();
        absolute
            .measures
            .get_mut("Returns")
            .expect("clean_doc has a Returns entry")
            .materiality = Some(Materiality::Absolute { value: 1000.0 });
        let judged = with_test(
            absolute,
            Scope::new(),
            given(delta, Some(value), Some(rounded)),
            expect(ExpectedStatus::Unfavourable),
        );
        assert_eq!(run_inline_tests(&facts(), &judged), vec![]);

        // AND THE REPAIR THE MESSAGE ASKS FOR RUNS GREEN, on the word the run
        // really produces: below the floor with nothing else to judge, the
        // report says nothing at all.
        let repaired = with_test(
            doc,
            Scope::new(),
            given(delta, Some(value), Some(derived)),
            expect(ExpectedStatus::Immaterial),
        );
        assert_eq!(run_inline_tests(&facts(), &repaired), vec![]);
    }

    #[test]
    fn omitting_the_value_under_a_literal_target_is_reported_when_the_verdict_flips_across_it() {
        // THE PROBE SET IS PART OF THE GUARD, AND DELETING IT REDDED NOTHING.
        // `value_probes` adds the literal target and one step either side of it
        // exactly so a sweep over an omitted `value` crosses the target. Take
        // that away and the probes are `None` and `0.0`, both far BELOW a target
        // of 500 - so a test that omits `value` reads as determined while its
        // verdict changes the moment the value climbs past the target. No
        // fixture in this file had a literal target with `value` left out, so
        // the neighbourhood was asserted by its own header and by nothing else.
        let doc = returns_against_a_literal_target(None);
        let resolved = resolve(&facts(), &doc, "Returns", &point_from_scope(&Scope::new()));

        // BELOW THE TARGET the movement and the level agree - Returns is
        // lowerIsBetter, it fell, and it is under target - so the two probes
        // that survive the sabotage both answer `favourable`...
        assert_eq!(
            judge(&resolved, &given(-10.0, None, Some(600.0))).verdict,
            Verdict::Claim(ExpectedStatus::Favourable)
        );
        assert_eq!(
            judge(&resolved, &given(-10.0, Some(0.0), Some(10.0))).verdict,
            Verdict::Claim(ExpectedStatus::Favourable)
        );
        // ...and ABOVE it they disagree, which only a probe in the target's
        // neighbourhood reaches.
        assert_eq!(
            judge(&resolved, &given(-10.0, Some(501.0), Some(511.0))).verdict,
            Verdict::TwoAnswers
        );

        let vacuous = with_test(
            doc.clone(),
            Scope::new(),
            given(-10.0, None, Some(600.0)),
            expect(ExpectedStatus::Favourable),
        );
        assert_eq!(
            run_inline_tests(&facts(), &vacuous)
                .iter()
                .map(|f| f.code.as_str())
                .collect::<Vec<_>>(),
            vec!["test-needs-value"],
            "the verdict is not a function of what this test states"
        );

        // POSITIVE CONTROL: state the value and the same expectation runs green.
        let repaired = with_test(
            doc,
            Scope::new(),
            given(-10.0, Some(490.0), Some(500.0)),
            expect(ExpectedStatus::Favourable),
        );
        assert_eq!(run_inline_tests(&facts(), &repaired), vec![]);
    }

    #[test]
    fn an_immaterial_movement_against_a_measure_target_is_refused_rather_than_judged() {
        // THE SAME DEFECT ONE STEP NARROWER, and it is the case `variance_at`
        // used to answer confidently. A `Target::Measure` variance whose word is
        // the same on both sides of the comparison - a `neutral` direction is the
        // simplest - was reported as a settled judgement. But `model_commands`
        // resolves that target by looking the referenced measure up in the grid
        // it just queried, and yields `None` when it is not there; a target of
        // 0.0 is skipped by `facts_for_measure` too. With no variance fact and a
        // movement below the floor the run says NOTHING about the point, so the
        // verdict turns on a query result the document does not contain.
        let mut doc = clean_doc();
        let returns = doc.measures.get_mut("Returns").expect("clean_doc has Returns");
        returns.direction = Some(Direction::Neutral);
        returns.target = Some(Target::Measure { r#ref: "Churn".into() });
        returns.materiality = Some(Materiality::Absolute { value: 1000.0 });
        let resolved = resolve(&facts(), &doc, "Returns", &point_from_scope(&Scope::new()));
        let locale = LocaleSettings::from_locale_id("en-US");

        // BOTH RUNS, so the disagreement is a measurement and not a claim. 600 ->
        // 610 is a movement of 10 against a floor of 1000.
        let observation = MeasureObservation {
            measure: "Returns".to_string(),
            labels: vec!["Jan".to_string(), "Feb".to_string()],
            values: vec![600.0, 610.0],
            target_value: Some(500.0),
            ..MeasureObservation::default()
        };
        assert_eq!(
            facts_for_measure(&observation, &resolved, &locale)
                .0
                .iter()
                .map(|f| f.kind.kind_key())
                .collect::<Vec<_>>(),
            vec!["variance"],
            "with a number for the target the level is judged"
        );
        let unresolved = MeasureObservation {
            target_value: None,
            ..observation
        };
        assert!(
            facts_for_measure(&unresolved, &resolved, &locale).0.is_empty(),
            "and without one the report is silent about this measure entirely"
        );

        let point = given(10.0, Some(610.0), Some(600.0));
        assert_eq!(judge(&resolved, &point).verdict, Verdict::UnknownTarget);
        let findings = run_inline_tests(
            &facts(),
            &with_test(doc, Scope::new(), point, expect(ExpectedStatus::Neutral)),
        );
        assert_eq!(
            findings.iter().map(|f| f.code.as_str()).collect::<Vec<_>>(),
            vec!["test-target-is-another-measure"]
        );
        assert!(
            findings[0].message.contains("'Churn'"),
            "the finding names the measure that carries the target: {}",
            findings[0].message
        );
    }

    /// The favourabilities a run's judged facts carry at `baseline -> value`,
    /// deduplicated.
    ///
    /// DEDUPLICATED BECAUSE THE QUESTION IS WHICH WORDS SHIP, NOT HOW MANY
    /// SENTENCES CARRY THEM. A change fact and a variance fact that agree are one
    /// judgement told twice; disagreeing ones are the `TwoAnswers` point. The
    /// change fact is always pushed first in `facts_for_measure`, so the order
    /// here is canonical and two runs can be compared directly.
    fn run_words(
        r: &ResolvedMeasure,
        baseline: f64,
        value: f64,
        target_value: Option<f64>,
        locale: &LocaleSettings,
    ) -> Vec<Option<Favourability>> {
        let observation = MeasureObservation {
            measure: "Returns".to_string(),
            labels: vec!["Jan".to_string(), "Feb".to_string()],
            values: vec![baseline, value],
            target_value,
            ..MeasureObservation::default()
        };
        let mut out: Vec<Option<Favourability>> = Vec::new();
        for fact in facts_for_measure(&observation, r, locale).0 {
            let word = match fact.kind {
                ModelFactKind::Change { favourability, .. }
                | ModelFactKind::Variance { favourability, .. } => favourability,
                // Nothing else at two periods with no slices and no driver, and
                // nothing else carries a favourability if it did.
                _ => continue,
            };
            if !out.contains(&word) {
                out.push(word);
            }
        }
        out
    }

    #[test]
    fn where_a_variance_is_built_the_harness_says_what_the_run_really_emits() {
        // THE HALF THE OTHER SWEEP SKIPS. Its filter was narrowed to the shapes
        // where only the movement is judged, and nothing replaced the coverage:
        // the variance half was left resting on three hand-picked fixtures. This
        // sweep is the replacement, and it does NOT diff against
        // `favourability_at` - that is the mistake the narrowing was fixing,
        // because at a variance-bearing point the movement's favourability is
        // only half the answer. It runs `facts_for_measure` and reads the facts.
        //
        // ONLY CONSISTENT TRIPLES, and that is what makes the diff meaningful at
        // all: a run derives `first = last - delta`, so a `given` whose baseline
        // says otherwise describes no observation and the runner now refuses it
        // (`states_one_point`). Every point below is built as
        // `value = baseline + delta` for exactly that reason.
        //
        // AND THE TARGET IS SWEPT TOO, not fixed. A `Target::Literal` is pinned
        // by the document, so the run gets that one number. A `Target::Measure`
        // is whatever a query returns - including NOTHING, when the referenced
        // measure is absent from the grid - so all four possibilities are run and
        // `UnknownTarget` is required to be a real disagreement between them
        // rather than a label.
        let locale = LocaleSettings::from_locale_id("en-US");
        let mut swept = 0_usize;
        let mut skipped = 0_usize;
        let mut unknown = 0_usize;
        for r in every_resolved_shape() {
            for baseline in [100.0, 1000.0] {
                // Chosen so no `value` lands on 0 or on the literal target of
                // 5.0: a target of zero is skipped by the planner, and a value
                // ON the target is a different (and separately covered) case.
                for delta in [-900.0, -10.0, 0.0, 10.0, 900.0] {
                    let value = baseline + delta;
                    let g = TestGiven {
                        delta,
                        value: Some(value),
                        baseline: Some(baseline),
                    };
                    assert!(
                        states_one_point(value, baseline, delta),
                        "the sweep must only walk points a run can produce: {g:?}"
                    );
                    if variance_at(&r, &g) == vec![VarianceFact::NotBuilt] {
                        skipped += 1;
                        continue;
                    }
                    swept += 1;

                    let targets: Vec<Option<f64>> = match r.target.as_ref().map(|t| &t.value) {
                        Some(Target::Literal { value: t }) => vec![Some(*t)],
                        Some(Target::Measure { .. }) => {
                            vec![None, Some(value - 10.0), Some(value), Some(value + 10.0)]
                        }
                        other => panic!("no variance fact is built for {other:?}"),
                    };
                    let runs: Vec<Vec<Option<Favourability>>> = targets
                        .iter()
                        .map(|t| run_words(&r, baseline, value, *t, &locale))
                        .collect();
                    let context = format!(
                        "direction {:?}, materiality {:?}, target {:?}, given {g:?}, the run's \
                         words per target {targets:?} -> {runs:?}",
                        r.direction.as_ref().map(|d| d.value),
                        r.materiality.as_ref().map(|m| &m.value),
                        r.target.as_ref().map(|t| &t.value),
                    );

                    let verdict = judge(&r, &g).verdict;
                    if verdict == Verdict::UnknownTarget {
                        unknown += 1;
                        assert!(
                            runs.iter().any(|w| *w != runs[0]),
                            "`UnknownTarget` says the query decides the point, so two numbers it \
                             could return must make the run emit different judgements: {context}"
                        );
                        continue;
                    }
                    assert!(
                        runs.iter().all(|w| *w == runs[0]),
                        "every number the query could return gives the run the same judgement \
                         here, so refusing the point as `UnknownTarget` would be refusing a \
                         determined test: {context}"
                    );

                    let words = &runs[0];
                    let all = |f: Favourability| {
                        !words.is_empty() && words.iter().all(|w| *w == Some(f))
                    };
                    match verdict {
                        Verdict::Claim(ExpectedStatus::Favourable) => {
                            assert!(all(Favourability::Better), "{context}")
                        }
                        Verdict::Claim(ExpectedStatus::Unfavourable) => {
                            assert!(all(Favourability::Worse), "{context}")
                        }
                        Verdict::Claim(ExpectedStatus::Neutral) => {
                            assert!(all(Favourability::Neutral), "{context}")
                        }
                        // `immaterial` is the claim that the run judges nothing.
                        // A variance fact is built at every point this sweep
                        // reaches, so it should be unreachable here - and if it
                        // ever is reached, the assertion is still the honest one.
                        Verdict::Claim(ExpectedStatus::Immaterial) => {
                            assert!(words.is_empty(), "{context}")
                        }
                        // Both are the planner's `None` word on facts that DO
                        // ship; only the resolved measure says which of the two
                        // it is.
                        Verdict::Claim(ExpectedStatus::Suppressed) => {
                            assert!(
                                !words.is_empty() && words.iter().all(|w| w.is_none()),
                                "{context}"
                            );
                            assert!(
                                r.suppression_of(Attribute::Direction).is_some(),
                                "{context}"
                            );
                        }
                        Verdict::NoClaim => {
                            assert!(
                                !words.is_empty() && words.iter().all(|w| w.is_none()),
                                "{context}"
                            );
                            assert!(
                                r.suppression_of(Attribute::Direction).is_none(),
                                "{context}"
                            );
                        }
                        Verdict::TwoAnswers => assert!(
                            words.len() > 1,
                            "two disagreeing judgements must be two different words in the run: \
                             {context}"
                        ),
                        Verdict::UnknownTarget => unreachable!("returned above"),
                    }
                }
            }
        }
        // THE FILTER MUST NOT HAVE EATEN THE SWEEP, and `unknown` is counted for
        // the same reason: a sweep in which no point is ever refused as
        // `UnknownTarget` proves nothing about the arm that refuses one.
        assert!(
            swept > 0 && skipped > 0 && unknown > 0,
            "{swept} swept, {skipped} skipped, {unknown} refused as UnknownTarget"
        );
    }
}
