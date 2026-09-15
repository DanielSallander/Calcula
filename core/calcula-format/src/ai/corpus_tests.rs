//! FILENAME: core/calcula-format/src/ai/corpus_tests.rs
// PURPOSE: Keep the AI programme's measurement corpora HONEST as the engine
//          changes underneath them.
// CONTEXT: Two checked-in corpora feed the formula assistant's measurement:
//
//            * `tests/eval/formulas.json` — the hand-written tasks. Each states
//              a request, a fixture, the reference formula that answers it, the
//              expected answer, and a DISTRACTOR: the plausible wrong formula a
//              model reaches for.
//            * `tests/eval/formula-patterns.verified.json` — the library mined
//              from `functions/*.md` and verified against this engine.
//
//          A corpus whose reference solutions do not actually work measures
//          nothing — it would score models against behaviour the product does
//          not have. That is not hypothetical: this repo's script corpus once
//          shipped a reference answer that failed the moment it was finally run.
//          So the corpora are asserted here, in `cargo test --workspace`, which
//          CI already runs from `core/`.
//
//          THE DISTRACTOR ASSERTION IS THE UNUSUAL ONE and it is the reason the
//          corpus is worth anything. A task whose wrong answer also satisfies
//          the expectation discriminates nothing: every model "passes" it and
//          the score stops meaning anything. Checking that the WRONG formula
//          fails is how a task proves it can tell two models apart.

use super::formula_verify::{compare, evaluate_fixture, parse_a1, Expectation, FixtureCell, FormulaJob};
use serde::Deserialize;
use std::collections::BTreeMap;

const CORPUS_JSON: &str = include_str!("../../../../tests/eval/formulas.json");
const PATTERNS_JSON: &str = include_str!("../../../../tests/eval/formula-patterns.verified.json");

/// The corpus is expected to be substantial. Pinned so that an emptied or
/// truncated file fails LOUDLY rather than passing vacuously — a validator that
/// examines nothing and reports a clean bill of health is the failure mode this
/// repo has already paid for once.
const MIN_TASKS: usize = 140;
const MIN_FAMILIES: usize = 10;
const MIN_PATTERNS: usize = 300;

/// Tasks each family must carry before a difference IN THAT FAMILY is measurable.
///
/// McNemar's exact test needs SIX clean flips for p < 0.05 at ANY corpus size,
/// and that applies to every SUBSET — so a family of five could never reach
/// significance however much compute was spent on it. Every family held exactly
/// five until 2026-09-15, which meant the corpus could report "this model is
/// better overall" and could never report "better at WHAT". A model bake-off ran
/// aground on exactly that: the two candidates were COMPLEMENTARY rather than
/// ranked, and nothing here could say in which direction.
///
/// Twelve is the working floor — six flips is then half the family rather than
/// all of it.
const MIN_PER_FAMILY: usize = 12;

#[derive(Debug, Deserialize)]
struct CorpusFile {
    tasks: Vec<CorpusTask>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CorpusTask {
    id: String,
    family: String,
    fixture: CorpusFixture,
    target: String,
    reference: String,
    expect: Expectation,
    distractor: CorpusDistractor,
}

#[derive(Debug, Deserialize)]
struct CorpusFixture {
    cells: Vec<CorpusCell>,
}

#[derive(Debug, Deserialize)]
struct CorpusCell {
    a1: String,
    input: String,
}

#[derive(Debug, Deserialize)]
struct CorpusDistractor {
    formula: String,
}

#[derive(Debug, Deserialize)]
struct PatternFile {
    verified: Vec<VerifiedPattern>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct VerifiedPattern {
    id: String,
    fixture: Vec<CorpusCell>,
    target: String,
    formula: String,
    expect: Expectation,
    /// Does this pattern's answer depend on WHEN it runs, or on chance?
    ///
    /// `=TODAY()` verified on one day reds every build after midnight, and
    /// `RANDBETWEEN` never settles at all. Such a pattern still ships and is
    /// still run — the guard just asks whether it EVALUATES rather than what to.
    /// A volatile pattern that starts returning an error is still caught, which
    /// is the half worth catching; a test that fails at midnight is one people
    /// learn to ignore, and it takes the other 578 down with it.
    ///
    /// `#[serde(default)]` so a library generated before the flag existed still
    /// parses — those simply claim to be stable, which is what they were treated
    /// as anyway.
    #[serde(default)]
    volatile: bool,
}

fn cells_of(cells: &[CorpusCell], what: &str, id: &str) -> Vec<FixtureCell> {
    cells
        .iter()
        .map(|c| {
            let (row, col) = parse_a1(&c.a1)
                .unwrap_or_else(|| panic!("{} {}: {:?} is not an A1 address", what, id, c.a1));
            FixtureCell { row, col, input: c.input.clone() }
        })
        .collect()
}

/// Evaluate one formula at one address over one fixture, and report the verdict.
fn run(
    cells: &[CorpusCell],
    target: &str,
    formula: &str,
    expect: &Expectation,
    id: &str,
) -> (bool, String) {
    let fixture = cells_of(cells, "fixture of", id);
    let (row, col) = parse_a1(target)
        .unwrap_or_else(|| panic!("task {}: target {:?} is not an A1 address", id, target));
    let jobs = vec![FormulaJob { row, col, formula: formula.to_string() }];
    let outcome = evaluate_fixture(&fixture, &jobs, "Sheet1");
    if let Some(reason) = outcome.refused {
        return (false, format!("refused: {}", reason));
    }
    let result = &outcome.results[0];
    let verdict = compare(result, expect, outcome.converged);
    (verdict.matched, verdict.reason)
}

/// Does a volatile pattern still parse and evaluate to something that is not an
/// error? The most that can honestly be asked of `=TODAY()` in a checked-in
/// library.
fn evaluates_without_error(p: &VerifiedPattern) -> (bool, String) {
    let fixture = cells_of(&p.fixture, "fixture of", &p.id);
    let (row, col) = parse_a1(&p.target)
        .unwrap_or_else(|| panic!("pattern {}: target {:?} is not an A1 address", p.id, p.target));
    let jobs = vec![FormulaJob { row, col, formula: p.formula.clone() }];
    let outcome = evaluate_fixture(&fixture, &jobs, "Sheet1");
    if let Some(reason) = outcome.refused {
        return (false, format!("refused: {}", reason));
    }
    let result = &outcome.results[0];
    if let Some(parse_error) = &result.parse_error {
        return (false, format!("did not parse: {}", parse_error));
    }
    if let Some(error) = &result.error {
        return (false, format!("evaluated to the error {}", error));
    }
    (true, String::new())
}

#[test]
fn a_volatile_pattern_is_checked_for_evaluating_and_not_for_a_recorded_answer() {
    // The guard this exists to keep honest: `=TODAY()` verified on one day must
    // not red the build on the next. Both halves are asserted, because a flag
    // that silently disabled the check would be worse than the midnight failure.
    let library: PatternFile = serde_json::from_str(PATTERNS_JSON).expect("the library parses");
    let volatile: Vec<&VerifiedPattern> = library.verified.iter().filter(|p| p.volatile).collect();
    assert!(
        !volatile.is_empty(),
        "no pattern is marked volatile, so this guard is testing nothing — the docs carry \
         TODAY/NOW examples and the generator is supposed to flag them"
    );
    for p in &volatile {
        let (ok, reason) = evaluates_without_error(p);
        assert!(ok, "{} [{}]: {}", p.id, p.formula, reason);
    }

    // AND THE FLAG AGREES WITH THE FORMULA, in both directions. This is the part
    // that keeps the weaker assertion from becoming a place to hide a failure: a
    // pattern flagged volatile must really call a volatile function, and one
    // that calls one must be flagged.
    //
    // Deliberately NOT "at least one volatile pattern currently fails the strict
    // check" — that was the first version of this assertion and it was the same
    // bug wearing a different hat: it holds only on a day the library was not
    // generated, so it would have gone red today and green tomorrow.
    const VOLATILE_FNS: [&str; 5] = ["TODAY(", "NOW(", "RAND(", "RANDBETWEEN(", "RANDARRAY("];
    let calls_volatile = |formula: &str| {
        let upper = formula.to_uppercase().replace(' ', "");
        VOLATILE_FNS.iter().any(|f| upper.contains(f))
    };
    for p in &library.verified {
        assert_eq!(
            p.volatile,
            calls_volatile(&p.formula),
            "{}: the volatile flag ({}) disagrees with the formula {:?}",
            p.id,
            p.volatile,
            p.formula
        );
    }
}

#[test]
fn the_corpus_is_substantial_enough_to_measure_anything() {
    let corpus: CorpusFile = serde_json::from_str(CORPUS_JSON).expect("the corpus parses");
    assert!(
        corpus.tasks.len() >= MIN_TASKS,
        "the corpus holds {} tasks, fewer than the {} it is supposed to carry — an emptied \
         corpus must fail here rather than pass every other test vacuously",
        corpus.tasks.len(),
        MIN_TASKS
    );
    let mut families: Vec<&str> = corpus.tasks.iter().map(|t| t.family.as_str()).collect();
    families.sort_unstable();
    families.dedup();
    assert!(
        families.len() >= MIN_FAMILIES,
        "the corpus spans only {} families ({:?}); it is supposed to span at least {}",
        families.len(),
        families,
        MIN_FAMILIES
    );
    let mut ids: Vec<&str> = corpus.tasks.iter().map(|t| t.id.as_str()).collect();
    let before = ids.len();
    ids.sort_unstable();
    ids.dedup();
    assert_eq!(before, ids.len(), "two corpus tasks share an id");
}

#[test]
fn every_family_is_sampled_often_enough_to_measure_a_difference_in_it() {
    let corpus: CorpusFile = serde_json::from_str(CORPUS_JSON).expect("the corpus parses");

    let mut counts: BTreeMap<&str, usize> = BTreeMap::new();
    for task in &corpus.tasks {
        *counts.entry(task.family.as_str()).or_insert(0) += 1;
    }

    // Guard the guard: an empty tally would make every assertion below vacuous.
    assert!(
        counts.len() >= MIN_FAMILIES,
        "only {} families were counted; the tally did not read the corpus",
        counts.len()
    );

    let thin: Vec<String> = counts
        .iter()
        .filter(|(_, &n)| n < MIN_PER_FAMILY)
        .map(|(fam, n)| format!("{}={}", fam, n))
        .collect();

    assert!(
        thin.is_empty(),
        "these families are sampled too thinly for a difference in them to reach p<0.05: {}\n\
         Each needs at least {} tasks; see MIN_PER_FAMILY for why the number is what it is.",
        thin.join(", "),
        MIN_PER_FAMILY
    );
}

#[test]
fn every_reference_formula_produces_its_expected_value() {
    let corpus: CorpusFile = serde_json::from_str(CORPUS_JSON).expect("the corpus parses");
    let mut failures = Vec::new();
    for task in &corpus.tasks {
        let (matched, reason) = run(
            &task.fixture.cells,
            &task.target,
            &task.reference,
            &task.expect,
            &task.id,
        );
        if !matched {
            failures.push(format!(
                "  {} [{}]\n     {}\n     {}",
                task.id, task.family, task.reference, reason
            ));
        }
    }
    assert!(
        failures.is_empty(),
        "{} of {} reference formulas do not produce the answer their task states.\n\
         Either the engine changed or the task is wrong; neither may be ignored.\n{}",
        failures.len(),
        corpus.tasks.len(),
        failures.join("\n")
    );
}

#[test]
fn every_distractor_fails_its_task() {
    let corpus: CorpusFile = serde_json::from_str(CORPUS_JSON).expect("the corpus parses");
    let mut toothless = Vec::new();
    for task in &corpus.tasks {
        if task.distractor.formula.trim().is_empty() {
            toothless.push(format!("  {} declares no distractor at all", task.id));
            continue;
        }
        let (matched, _) = run(
            &task.fixture.cells,
            &task.target,
            &task.distractor.formula,
            &task.expect,
            &task.id,
        );
        if matched {
            toothless.push(format!(
                "  {} [{}]: the WRONG formula {} also satisfies the expectation, so the task \
                 cannot tell a right answer from a plausible wrong one",
                task.id, task.family, task.distractor.formula
            ));
        }
    }
    assert!(
        toothless.is_empty(),
        "{} corpus task(s) discriminate nothing:\n{}",
        toothless.len(),
        toothless.join("\n")
    );
}

#[test]
fn every_shipped_pattern_still_reproduces_its_recorded_result() {
    let library: PatternFile = serde_json::from_str(PATTERNS_JSON).expect("the library parses");
    assert!(
        library.verified.len() >= MIN_PATTERNS,
        "the verified pattern library holds only {} entries, fewer than the {} expected",
        library.verified.len(),
        MIN_PATTERNS
    );
    let mut failures = Vec::new();
    for p in &library.verified {
        if p.volatile {
            // Asked what it CAN answer: does it still evaluate? Comparing a
            // recorded value would be comparing against the day the library was
            // generated. An error here is still a real failure — this is not a
            // skip, it is a weaker assertion applied where the strong one is
            // meaningless.
            let (evaluated, reason) = evaluates_without_error(p);
            if !evaluated {
                failures.push(format!(
                    "  {} [volatile]: {}\n     {}",
                    p.id, p.formula, reason
                ));
            }
            continue;
        }
        let (matched, reason) = run(&p.fixture, &p.target, &p.formula, &p.expect, &p.id);
        if !matched {
            failures.push(format!("  {}: {}\n     {}", p.id, p.formula, reason));
        }
    }
    assert!(
        failures.is_empty(),
        "{} of {} verified patterns no longer reproduce their recorded result — regenerate the \
         library and read the diff, because each one is either a doc to fix or an engine \
         behaviour that changed:\n{}",
        failures.len(),
        library.verified.len(),
        failures.join("\n")
    );
}
