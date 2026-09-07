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

const CORPUS_JSON: &str = include_str!("../../../../tests/eval/formulas.json");
const PATTERNS_JSON: &str = include_str!("../../../../tests/eval/formula-patterns.verified.json");

/// The corpus is expected to be substantial. Pinned so that an emptied or
/// truncated file fails LOUDLY rather than passing vacuously — a validator that
/// examines nothing and reports a clean bill of health is the failure mode this
/// repo has already paid for once.
const MIN_TASKS: usize = 50;
const MIN_FAMILIES: usize = 10;
const MIN_PATTERNS: usize = 300;

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
