//! FILENAME: core/calcula-format/examples/eval-formulas.rs
// PURPOSE: The offline formula oracle, as a process. JSON on stdin, JSON on
//          stdout, no app, no WebView, no Tauri, no network.
// CONTEXT: Two JavaScript callers need to know whether a formula is right, and
//          neither can run Rust in-process:
//            * `tests/eval/run-formula-eval.mjs` grades what a language model
//              proposed against a task's expectation.
//            * `app/scripts/gen-formula-patterns.mjs` refuses to ship a pattern
//              from `functions/*.md` whose stated result the engine does not
//              reproduce.
//          Both shell out to this binary and read its JSON, so there is exactly
//          ONE definition of "correct" in the programme.
//
//          AN EXAMPLE RATHER THAN A BIN. `cargo run --example` needs no entry in
//          `[[bin]]`, keeps the binary out of every ordinary `cargo build`, and
//          costs nothing when it is not being used. It links only `core/`
//          crates, so it starts in milliseconds and — unlike anything in the app
//          crate — needs no Windows manifest patching to load.
//
//          BATCHED ON PURPOSE. Every job carries its own fixture and is
//          evaluated against its own grid, so tasks cannot contaminate each
//          other; but they travel in ONE request, because a process launch per
//          task dominates the runtime of a hundred-task corpus.
//
//          THIS PROCESS EXITS 0 FOR A WRONG ANSWER. A mismatch is a RESULT, not
//          a failure: the caller reads `matched` per cell. A non-zero exit means
//          the request itself could not be understood, which is the only thing a
//          caller cannot recover from.
//
// USAGE:   cargo run -p calcula-format --example eval-formulas --release < request.json

use std::io::{Read, Write};

use calcula_format::ai::formula_verify::{
    compare, evaluate_fixture, parse_a1, Expectation, FixtureCell, FormulaJob, FormulaOutcome,
    MatchVerdict,
};
use serde::{Deserialize, Serialize};

/// A fixture cell as a corpus writes it: an A1 address and the text a person
/// would type.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct A1Cell {
    a1: String,
    input: String,
}

/// One formula to evaluate against the job's fixture, with an optional
/// expectation. Without an expectation the cell is still evaluated and reported
/// — that is how the pattern generator discovers what a doc example ACTUALLY
/// produces before deciding whether the doc's stated result is true.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct A1Formula {
    a1: String,
    formula: String,
    #[serde(default)]
    expect: Option<Expectation>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Job {
    id: String,
    #[serde(default)]
    fixture: Vec<A1Cell>,
    formulas: Vec<A1Formula>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Request {
    #[serde(default)]
    sheet_name: Option<String>,
    jobs: Vec<Job>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CellResult {
    a1: String,
    outcome: FormulaOutcome,
    #[serde(skip_serializing_if = "Option::is_none")]
    verdict: Option<MatchVerdict>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct JobResult {
    id: String,
    /// Present when the job could not be evaluated at all — a malformed address,
    /// or a fixture the grader refuses. Distinct from a WRONG answer, and the
    /// caller must not count it as one.
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    converged: bool,
    passes: u32,
    cells: Vec<CellResult>,
    /// True when every cell that carried an expectation matched it. `None` when
    /// the job stated no expectations at all, so "no expectations" can never be
    /// mistaken for "everything passed".
    #[serde(skip_serializing_if = "Option::is_none")]
    matched: Option<bool>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Summary {
    jobs: usize,
    graded: usize,
    matched: usize,
    unmatched: usize,
    errored: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Response {
    /// Bumped when the shape changes, so a stale runner fails loudly instead of
    /// silently misreading a field.
    version: u32,
    results: Vec<JobResult>,
    summary: Summary,
}

const RESPONSE_VERSION: u32 = 1;

fn run_job(job: &Job, sheet_name: &str) -> JobResult {
    let mut fixture = Vec::with_capacity(job.fixture.len());
    for cell in &job.fixture {
        match parse_a1(&cell.a1) {
            Some((row, col)) => fixture.push(FixtureCell {
                row,
                col,
                input: cell.input.clone(),
            }),
            None => {
                return JobResult {
                    id: job.id.clone(),
                    error: Some(format!("fixture cell {:?} is not a plain A1 address", cell.a1)),
                    converged: false,
                    passes: 0,
                    cells: Vec::new(),
                    matched: None,
                }
            }
        }
    }

    let mut jobs = Vec::with_capacity(job.formulas.len());
    for f in &job.formulas {
        match parse_a1(&f.a1) {
            Some((row, col)) => jobs.push(FormulaJob {
                row,
                col,
                formula: f.formula.clone(),
            }),
            None => {
                return JobResult {
                    id: job.id.clone(),
                    error: Some(format!("target cell {:?} is not a plain A1 address", f.a1)),
                    converged: false,
                    passes: 0,
                    cells: Vec::new(),
                    matched: None,
                }
            }
        }
    }

    let outcome = evaluate_fixture(&fixture, &jobs, sheet_name);
    if let Some(reason) = outcome.refused {
        return JobResult {
            id: job.id.clone(),
            error: Some(reason),
            converged: outcome.converged,
            passes: outcome.passes,
            cells: Vec::new(),
            matched: None,
        };
    }

    let mut cells = Vec::with_capacity(outcome.results.len());
    let mut expectations = 0usize;
    let mut satisfied = 0usize;
    for (spec, result) in job.formulas.iter().zip(outcome.results.into_iter()) {
        let verdict = spec.expect.as_ref().map(|e| {
            expectations += 1;
            let v = compare(&result, e, outcome.converged);
            if v.matched {
                satisfied += 1;
            }
            v
        });
        cells.push(CellResult {
            a1: spec.a1.clone(),
            outcome: result,
            verdict,
        });
    }

    JobResult {
        id: job.id.clone(),
        error: None,
        converged: outcome.converged,
        passes: outcome.passes,
        cells,
        matched: if expectations == 0 {
            None
        } else {
            Some(satisfied == expectations)
        },
    }
}

fn main() {
    let mut raw = String::new();
    if let Err(e) = std::io::stdin().read_to_string(&mut raw) {
        eprintln!("eval-formulas: could not read stdin: {}", e);
        std::process::exit(2);
    }
    let request: Request = match serde_json::from_str(&raw) {
        Ok(r) => r,
        Err(e) => {
            eprintln!("eval-formulas: the request is not valid JSON for this tool: {}", e);
            std::process::exit(2);
        }
    };

    let sheet_name = request.sheet_name.as_deref().unwrap_or("Sheet1").to_string();
    let results: Vec<JobResult> = request
        .jobs
        .iter()
        .map(|job| run_job(job, &sheet_name))
        .collect();

    let summary = Summary {
        jobs: results.len(),
        graded: results.iter().filter(|r| r.matched.is_some()).count(),
        matched: results.iter().filter(|r| r.matched == Some(true)).count(),
        unmatched: results.iter().filter(|r| r.matched == Some(false)).count(),
        errored: results.iter().filter(|r| r.error.is_some()).count(),
    };

    let response = Response {
        version: RESPONSE_VERSION,
        results,
        summary,
    };

    // Compact, not pretty: a hundred-task response is read by a program.
    match serde_json::to_string(&response) {
        Ok(json) => {
            let mut out = std::io::stdout();
            if out.write_all(json.as_bytes()).is_err() || out.write_all(b"\n").is_err() {
                std::process::exit(2);
            }
            let _ = out.flush();
        }
        Err(e) => {
            eprintln!("eval-formulas: could not serialize the response: {}", e);
            std::process::exit(2);
        }
    }
}
