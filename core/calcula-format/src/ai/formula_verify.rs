//! FILENAME: core/calcula-format/src/ai/formula_verify.rs
// PURPOSE: Evaluate a formula against a fixture the way the product would, so a
//          formula can be GRADED offline — with no app, no WebView, no Tauri.
// CONTEXT: This is the oracle the AI programme's measurement rests on. A model
//          proposes a formula; this decides whether it is right. Two callers
//          share it: the eval runner (`tests/eval/run-formula-eval.mjs`, through
//          the `eval-formulas` example binary) and the verified pattern library
//          (`app/scripts/gen-formula-patterns.mjs`, which refuses to ship a
//          pattern whose stated result this module does not reproduce).
//
//          WHY IT LIVES HERE AND NOT IN THE APP CRATE. The obvious host is
//          `app/src-tauri`, which already does exactly this in
//          `ai/preview_eval.rs::evaluate_preview`. It was rejected for three
//          measured reasons: the app crate links the whole Arrow/DataFusion
//          tree so a one-line change costs minutes; its test and example
//          binaries do not inherit tauri-build's Windows manifest and die at
//          load with STATUS_ENTRYPOINT_NOT_FOUND until `fix-test-manifest.ps1`
//          patches them; and CI already runs `cargo test --workspace` from
//          `core/`, so a grader here is gated where a grader there is not.
//
//          WHY IT NEEDS NO AST CONVERSION. `core/engine` takes a real (not dev)
//          dependency on `core/parser` and re-exports the parser's `Expression`
//          as its own (`core/engine/src/lib.rs:188`), so the parser's output IS
//          the evaluator's input. The engine's own tests do exactly this in two
//          lines (`core/engine/src/array_semantics_tests.rs:38-41`). The app's
//          `convert_expr` is not in this path.
//
//          THE ONE THING THIS MODULE MUST NEVER DO IS GUESS. A formula that
//          does not parse, a result that spills, a batch that will not settle:
//          each is reported as itself. A grader that quietly substitutes a
//          plausible answer would corrupt every number the programme reports.

use engine::cell::{Cell, CellValue};
use engine::evaluator::{EvalContext, EvalResult, Evaluator, MultiSheetContext};
use engine::grid::Grid;
use serde::{Deserialize, Serialize};

/// How many fixture cells one request may carry.
///
/// Matches `MAX_PREVIEW_EVAL_CELLS` in the app's preview evaluator: the same
/// bound for the same reason, so neither surface can evaluate a fixture the
/// other would refuse.
pub const MAX_FIXTURE_CELLS: usize = 20_000;

/// The runaway bound on settle passes. See [`pass_budget`] for the working
/// budget, which is almost always far smaller.
const PASS_CAP: u32 = 512;

/// The aggregate work ceiling: formulas x passes may not exceed this.
const MAX_TOTAL_EVALS: u32 = 2_000_000;

/// The pass budget for `n` formulas.
///
/// This is batch (Jacobi) iteration: every formula is evaluated against the grid
/// as it stood at the start of the pass, so each pass propagates exactly ONE
/// dependency link. An acyclic set of `n` formulas is therefore settled after at
/// most `n` passes, and one more is needed to OBSERVE that nothing changed.
///
/// A flat budget is wrong and was wrong in the app's first version of this
/// loop: chain depth belongs to the FIXTURE, not to the formula under test, and
/// a 50-row running-total column is depth 50 of entirely ordinary content. Only
/// a true cycle or a volatile function can exhaust the budget now, and both
/// deserve exactly the unconverged verdict.
fn pass_budget(formula_count: u32) -> u32 {
    if formula_count == 0 {
        return 0;
    }
    formula_count
        .saturating_add(1)
        .min(PASS_CAP)
        .min((MAX_TOTAL_EVALS / formula_count).max(1))
}

/// One cell of the fixture, as the text a person would TYPE into it.
///
/// Not a typed value: the whole point is that the grader seeds the grid through
/// the same interpretation the product applies to typed input, so that a task
/// author writes `"2025-01-03"` and gets a date rather than a string.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FixtureCell {
    pub row: u32,
    pub col: u32,
    pub input: String,
}

/// A formula to evaluate, at the position it would occupy.
///
/// The POSITION is load-bearing and is the reason this module does not simply
/// call the app's raw evaluation helper: `ROW()`, `COLUMN()` and implicit
/// intersection all resolve against the cell the formula sits in, so evaluating
/// "the same formula" at the wrong address silently returns a different answer.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FormulaJob {
    pub row: u32,
    pub col: u32,
    pub formula: String,
}

/// What kind of thing a formula produced.
///
/// Kept separate from the display string because grading a number by its
/// rendering is how a comparison starts failing on the seventeenth decimal:
/// `display_value` prints an integral float as `{:.0}` and everything else with
/// Rust's default float formatting, so `0.1 + 0.2` renders as
/// `0.30000000000000004`. Numbers are compared as numbers.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ValueKind {
    Number,
    Text,
    Boolean,
    Error,
    Blank,
    /// A dynamic array. It would SPILL onto neighbouring cells, which a
    /// single-cell answer cannot express, so it is reported as itself rather
    /// than collapsed to its first element.
    Spill,
    /// `COLLECT()` / `DICT()` and anything else that is neither scalar nor
    /// spilling. Reported rather than coerced, so a task that produces one is
    /// visibly ungradable instead of quietly wrong.
    Other,
}

/// The outcome of one formula.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FormulaOutcome {
    pub row: u32,
    pub col: u32,
    /// The formula as supplied, echoed so a caller can correlate without
    /// relying on array order.
    pub formula: String,
    /// Absent when the formula parsed. Present with the parser's message when it
    /// did not — in which case every value field below is `None` and `kind` is
    /// `Error`. The parser reports no position, so this is the message alone.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub parse_error: Option<String>,
    pub kind: ValueKind,
    /// The value as the grid would show it, with no number format applied.
    pub display: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub number: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub boolean: Option<bool>,
    /// The error literal exactly as a cell would show it (`#DIV/0!`, `#N/A`).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// How many values the spill would cover. Zero unless `kind` is `Spill`.
    pub spill_len: u32,
    /// True when the spill is two-dimensional (its elements are themselves
    /// arrays), so a caller can tell a column of results from a grid of them.
    pub spill_nested: bool,
}

/// The result of evaluating one request.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EvalOutcome {
    pub results: Vec<FormulaOutcome>,
    /// False when the settle loop hit its budget with values still moving — a
    /// cycle, or a volatile function. The results are then a snapshot of an
    /// unfinished calculation and MUST NOT be graded.
    pub converged: bool,
    pub passes: u32,
    /// Present when the request was refused outright, in which case `results` is
    /// empty. A refusal is an ANSWER and travels in the result rather than as an
    /// error, so a caller cannot mistake "too big to evaluate" for "the
    /// evaluator is missing".
    #[serde(skip_serializing_if = "Option::is_none")]
    pub refused: Option<String>,
}

/// The locale a fixture is written in.
///
/// Fixtures are INVARIANT by construction — dot decimals, comma argument
/// separators — because that is how formulas are stored and how both corpora
/// are authored. The ladder still wants a locale for the parts of it that are
/// genuinely locale-shaped (the day/month order a bare `3/1/2024` implies), so
/// the default is supplied rather than any particular user's.
fn fixture_locale() -> engine::LocaleSettings {
    engine::LocaleSettings::invariant()
}

/// The cell the product would store for this typed text.
///
/// DELEGATES TO THE PRODUCT'S OWN LADDER (`engine::typed_entry`), and that is
/// the entire point of this function existing.
///
/// It began as a hand-rolled approximation — empty, `TRUE`/`FALSE`, a float, an
/// ISO date, else text — and the approximation was wrong in ways that silently
/// corrupted measurements rather than failing loudly. A fixture cell holding
/// `6%` was seeded as the STRING "6%" instead of the number 0.06, and `$1,000`
/// as a string instead of 1000, so every financial example was computed from
/// text and the grader then marked CORRECT formulas wrong. Ten function
/// documents disagreed with the engine for that reason alone, and the
/// disagreement looked like an engine defect.
///
/// The ladder also handles the leading apostrophe, typed error literals (`#N/A`
/// becomes an ERROR value, not the text "#N/A"), the `@` text format and
/// two-digit years — none of which an approximation was going to get right, and
/// every rung of which records a bug that shipped once.
///
/// A date becomes the serial NUMBER it is stored as. Calcula has no date value
/// type: a date is a number whose cell style carries a date format, and since
/// this module applies no styles, a date-returning formula reports its serial.
/// Corpus tasks are written to expect day and month COUNTS for that reason.
/// WHICH RUNG OF THE LADDER, AND WHY IT IS THE TYPED ONE. `typed_entry` offers
/// two entry points and the distinction matters here. `parse_cell_input_invariant`
/// is the SCRIPT-facing spelling: it infers no format, so `2025-01-03` stays the
/// text "2025-01-03" on the reasoning that a script meaning a date writes a
/// serial and says so. A fixture cell is not a script — it is, by this module's
/// own definition, "the text a person would TYPE" — so it takes the interactive
/// ladder, with an invariant locale standing in for the user's settings.
pub fn seed_cell(raw: &str) -> Cell {
    engine::typed_entry::parse_cell_input(raw, &fixture_locale())
}

/// The value the product would store for this typed text. See [`seed_cell`].
pub fn seed_value(raw: &str) -> CellValue {
    seed_cell(raw).value
}

/// Seed a grid from the fixture, returning it plus any formulas the FIXTURE
/// itself carries.
///
/// A fixture may hold formulas — a helper column is ordinary sheet content, and
/// a task that reads one is a fair task. They are stored with an EMPTY value and
/// settled by the same loop as the formulas under test: storing `"=SUM(A1:A9)"`
/// as text would make anything referencing that cell see a string where a number
/// belongs, which is a wrong answer rather than a missing one.
fn build_grid(fixture: &[FixtureCell]) -> (Grid, Vec<FormulaJob>) {
    let mut grid = Grid::new();
    let mut fixture_formulas = Vec::new();
    for c in fixture {
        let is_formula = c.input.starts_with('=');
        if is_formula {
            fixture_formulas.push(FormulaJob {
                row: c.row,
                col: c.col,
                formula: c.input.clone(),
            });
        }
        // A formula's VALUE is what the settle loop below fills in, so it is
        // stored empty rather than through the ladder (which would parse it and
        // attach an AST this loop does not use). Everything else goes through
        // the product's own typed-entry ladder.
        let cell = if is_formula {
            Cell { ast: None, value: CellValue::Empty, style_index: 0, rich_text: None }
        } else {
            seed_cell(&c.input)
        };
        grid.set_cell(c.row, c.col, cell);
    }
    (grid, fixture_formulas)
}

/// Evaluate one parsed formula at its own address.
///
/// The `MultiSheetContext` is rebuilt per call because `Evaluator::with_context`
/// takes it by value; it holds one borrowed grid and a one-entry map, so this is
/// cheap. Building it fresh per pass is also what lets the loop mutate the grid
/// between passes without fighting the borrow checker.
fn eval_one(grid: &Grid, sheet: &str, row: u32, col: u32, ast: &engine::Expression) -> EvalResult {
    let mut multi = MultiSheetContext::new(sheet.to_string());
    multi.add_grid(sheet.to_string(), grid);
    multi.sheet_order = vec![sheet.to_string()];
    let ctx = EvalContext {
        current_row: Some(row),
        current_col: Some(col),
        ..Default::default()
    };
    Evaluator::with_context(grid, multi, ctx).evaluate(ast)
}

/// Turn a settled evaluation result into the reported outcome.
///
/// The array check comes FIRST and deliberately: `EvalResult::to_cell_value`
/// collapses an array to its first element
/// (`core/engine/src/evaluator.rs:585`), so asking for the cell value before
/// asking whether it spilled turns "this spills nine values" into "this is 5".
fn describe(row: u32, col: u32, formula: &str, raw: &EvalResult) -> FormulaOutcome {
    let mut out = FormulaOutcome {
        row,
        col,
        formula: formula.to_string(),
        parse_error: None,
        kind: ValueKind::Other,
        display: String::new(),
        number: None,
        text: None,
        boolean: None,
        error: None,
        spill_len: 0,
        spill_nested: false,
    };
    match raw {
        EvalResult::Array(items) => {
            out.kind = ValueKind::Spill;
            out.spill_len = items.len() as u32;
            out.spill_nested = matches!(items.first(), Some(EvalResult::Array(_)));
            // The anchor is what the top-left cell would show, and it is the
            // only part of a spill a single-cell expectation can pin.
            if let Some(first) = items.first() {
                let anchor = describe(row, col, formula, first);
                out.display = anchor.display;
                out.number = anchor.number;
                out.text = anchor.text;
                out.boolean = anchor.boolean;
                out.error = anchor.error;
            }
        }
        EvalResult::Number(n) => {
            out.kind = ValueKind::Number;
            out.number = Some(*n);
            out.display = cell_display(&CellValue::Number(*n));
        }
        EvalResult::Text(s) => {
            out.kind = ValueKind::Text;
            out.text = Some(s.clone());
            out.display = s.clone();
        }
        EvalResult::Boolean(b) => {
            out.kind = ValueKind::Boolean;
            out.boolean = Some(*b);
            out.display = if *b { "TRUE".to_string() } else { "FALSE".to_string() };
        }
        EvalResult::Error(e) => {
            out.kind = ValueKind::Error;
            out.error = Some(e.as_literal().to_string());
            out.display = e.as_literal().to_string();
        }
        // A blank RESULT is not a blank cell: `=A1` over an empty cell displays
        // 0 in Excel and here, which is what `to_cell_value` encodes. Reported
        // as Blank so a caller can tell it from a literal zero if it cares.
        EvalResult::Blank => {
            out.kind = ValueKind::Blank;
            out.number = Some(0.0);
            out.display = "0".to_string();
        }
        other => {
            out.kind = ValueKind::Other;
            out.display = cell_display(&other.to_cell_value());
        }
    }
    out
}

/// Render a value the way a cell with no number format would.
fn cell_display(value: &CellValue) -> String {
    Cell {
        ast: None,
        value: value.clone(),
        style_index: 0,
        rich_text: None,
    }
    .display_value()
}

/// Evaluate every formula against the fixture and report what each produced.
///
/// Pure: no state, no I/O, no clock. The same request always produces the same
/// answer, which is what lets a generated pattern library be byte-pinned and a
/// measurement be repeated.
pub fn evaluate_fixture(
    fixture: &[FixtureCell],
    jobs: &[FormulaJob],
    sheet_name: &str,
) -> EvalOutcome {
    if fixture.len() > MAX_FIXTURE_CELLS {
        return EvalOutcome {
            results: Vec::new(),
            converged: true,
            passes: 0,
            refused: Some(format!(
                "the fixture holds {} cells, more than the {} this grader will evaluate",
                fixture.len(),
                MAX_FIXTURE_CELLS
            )),
        };
    }

    let (mut grid, fixture_formulas) = build_grid(fixture);

    // The fixture's own formulas settle alongside the ones under test, but only
    // the requested jobs are REPORTED. A job at the same address as a fixture
    // formula overrides it: the caller asked about that cell.
    let mut all: Vec<FormulaJob> = fixture_formulas
        .into_iter()
        .filter(|f| !jobs.iter().any(|j| j.row == f.row && j.col == f.col))
        .collect();
    all.extend(jobs.iter().cloned());

    // Parse once, not once per pass. A formula that does not parse still
    // occupies its cell so that dependents see a stable value and the loop can
    // converge, and it is reported with the parser's own message.
    let parsed: Vec<(FormulaJob, Result<engine::Expression, String>)> = all
        .into_iter()
        .map(|job| {
            let parsed = parser::parse(&job.formula).map_err(|e| e.message.clone());
            (job, parsed)
        })
        .collect();

    let budget = pass_budget(parsed.len() as u32);
    let mut passes = 0;
    let mut converged = parsed.is_empty();
    while passes < budget && !converged {
        passes += 1;
        // Evaluate the WHOLE set against the grid as it stands, then apply.
        // Evaluating and writing in one loop would make a formula's answer
        // depend on the order the cells happen to be in.
        let round: Vec<(u32, u32, CellValue)> = parsed
            .iter()
            .map(|(job, ast)| {
                let value = match ast {
                    Err(_) => CellValue::Error(engine::cell::CellError::Value),
                    Ok(ast) => {
                        let raw = eval_one(&grid, sheet_name, job.row, job.col, ast);
                        // A spill cannot be stored in one cell. Empty is a
                        // stable stand-in so the iteration still converges; the
                        // spill itself is reported from a fresh evaluation
                        // below, never from the grid.
                        if matches!(raw, EvalResult::Array(_)) {
                            CellValue::Empty
                        } else {
                            raw.to_cell_value()
                        }
                    }
                };
                (job.row, job.col, value)
            })
            .collect();

        let mut changed = false;
        for (row, col, value) in round {
            let current = grid.get_cell(row, col).map(|c| c.value.clone());
            if current.as_ref() != Some(&value) {
                changed = true;
                grid.set_cell(
                    row,
                    col,
                    Cell { ast: None, value, style_index: 0, rich_text: None },
                );
            }
        }
        if !changed {
            converged = true;
        }
    }

    // Report from a FINAL evaluation against the settled grid rather than from
    // the stored cell values: the stored value of a spilling formula is the
    // Empty stand-in above, and reporting that would turn every dynamic-array
    // task into a silent blank.
    let results = jobs
        .iter()
        .map(|job| {
            let entry = parsed
                .iter()
                .find(|(j, _)| j.row == job.row && j.col == job.col);
            match entry {
                Some((_, Ok(ast))) => {
                    let raw = eval_one(&grid, sheet_name, job.row, job.col, ast);
                    describe(job.row, job.col, &job.formula, &raw)
                }
                Some((_, Err(message))) => FormulaOutcome {
                    row: job.row,
                    col: job.col,
                    formula: job.formula.clone(),
                    parse_error: Some(message.clone()),
                    kind: ValueKind::Error,
                    display: String::new(),
                    number: None,
                    text: None,
                    boolean: None,
                    error: None,
                    spill_len: 0,
                    spill_nested: false,
                },
                // Unreachable: every job is in `parsed`. Reported rather than
                // unwrapped so a future refactor cannot turn it into a panic
                // inside a batch grading run.
                None => FormulaOutcome {
                    row: job.row,
                    col: job.col,
                    formula: job.formula.clone(),
                    parse_error: Some("the grader lost track of this formula".to_string()),
                    kind: ValueKind::Error,
                    display: String::new(),
                    number: None,
                    text: None,
                    boolean: None,
                    error: None,
                    spill_len: 0,
                    spill_nested: false,
                },
            }
        })
        .collect();

    EvalOutcome { results, converged, passes, refused: None }
}

/// Split an A1 reference into 0-based `(row, col)`.
///
/// IN THE LIBRARY AND TESTED, not inlined in the binary that needs it, because
/// the failure mode is silent: a corpus is written in A1 (`"F2"`) and evaluated
/// in indices, so an off-by-one here shifts every task by a row and the grader
/// reports confident wrong answers instead of errors.
///
/// Returns `None` for anything that is not a plain relative reference. `$` is
/// rejected rather than stripped: an absolute marker on a FIXTURE address means
/// the author confused a cell address with a formula reference, and quietly
/// accepting it hides that.
pub fn parse_a1(a1: &str) -> Option<(u32, u32)> {
    let trimmed = a1.trim();
    if trimmed.is_empty() {
        return None;
    }
    let split = trimmed.find(|c: char| c.is_ascii_digit())?;
    let (letters, digits) = trimmed.split_at(split);
    if letters.is_empty() || !letters.chars().all(|c| c.is_ascii_alphabetic()) {
        return None;
    }
    if !digits.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    let row_1_based: u32 = digits.parse().ok()?;
    if row_1_based == 0 {
        return None;
    }
    Some((row_1_based - 1, engine::coord::col_to_index(letters)))
}

/// What a task says the answer should be.
///
/// A struct rather than a tagged enum because both callers are JavaScript and a
/// serde-tagged enum is awkward to write by hand in a corpus file. `kind`
/// selects which field is read; the rest are ignored.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Expectation {
    pub kind: ExpectKind,
    #[serde(default)]
    pub number: Option<f64>,
    #[serde(default)]
    pub text: Option<String>,
    #[serde(default)]
    pub boolean: Option<bool>,
    #[serde(default)]
    pub error: Option<String>,
    #[serde(default)]
    pub display: Option<String>,
    /// Absolute tolerance for a number. Defaults to [`DEFAULT_TOLERANCE`], which
    /// is a RELATIVE comparison; set this to pin an absolute one (a task that
    /// says "to the nearest krona" wants `0.005`, not a relative epsilon).
    #[serde(default)]
    pub tolerance: Option<f64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ExpectKind {
    Number,
    Text,
    Boolean,
    Error,
    /// The rendered string, for the rare task whose point IS the rendering.
    Display,
}

/// The relative tolerance a number comparison uses when a task states none.
///
/// Relative, not absolute, because the corpus spans money in the thousands and
/// correlation coefficients below one, and a single absolute epsilon cannot
/// serve both. Binary floating point makes an exact comparison wrong even for
/// arithmetic a person would call exact: summing 0.1 three times is not 0.3.
pub const DEFAULT_TOLERANCE: f64 = 1e-9;

/// Whether an outcome satisfies an expectation, and why not when it does not.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MatchVerdict {
    pub matched: bool,
    /// Always populated, including on a match, so a passing run can be audited
    /// as readily as a failing one.
    pub reason: String,
}

/// Compare one outcome with one expectation.
///
/// THE RULES THAT MATTER, each chosen because the obvious alternative is wrong:
///
/// * A number is compared AS A NUMBER, never by its rendering. `display_value`
///   prints non-integral floats with Rust's default formatting, so a correct
///   answer can render as `0.30000000000000004`.
/// * A formula that did not parse, or a batch that did not settle, never
///   matches — regardless of what it happens to hold.
/// * A SPILL may satisfy a scalar expectation via its anchor, because that is
///   the only part of a spill a single-cell expectation can pin, but the reason
///   says so, so nobody later mistakes it for a scalar result.
/// * A wrong TYPE is a mismatch even when the rendering agrees: the text
///   `"9800"` is not the number 9800, and a corpus that accepted it would stop
///   detecting the commonest coercion bug there is.
pub fn compare(outcome: &FormulaOutcome, expect: &Expectation, converged: bool) -> MatchVerdict {
    if let Some(message) = &outcome.parse_error {
        return MatchVerdict {
            matched: false,
            reason: format!("the formula did not parse: {}", message),
        };
    }
    if !converged {
        return MatchVerdict {
            matched: false,
            reason: "the fixture did not settle, so no value here can be trusted".to_string(),
        };
    }
    let spill_note = if outcome.kind == ValueKind::Spill {
        format!(" (matched against the anchor of a {}-value spill)", outcome.spill_len)
    } else {
        String::new()
    };

    match expect.kind {
        ExpectKind::Number => {
            let want = match expect.number {
                Some(n) => n,
                None => {
                    return MatchVerdict {
                        matched: false,
                        reason: "the expectation says `number` but states no number".to_string(),
                    }
                }
            };
            // Blank counts as the number zero: `=A1` over an empty cell shows 0,
            // and a task expecting 0 should not fail on the distinction.
            match outcome.number {
                Some(got) => {
                    let ok = match expect.tolerance {
                        Some(abs) => (got - want).abs() <= abs,
                        None => {
                            let scale = want.abs().max(got.abs()).max(1.0);
                            (got - want).abs() <= DEFAULT_TOLERANCE * scale
                        }
                    };
                    MatchVerdict {
                        matched: ok,
                        reason: if ok {
                            format!("{} matches the expected {}{}", got, want, spill_note)
                        } else {
                            format!("computed {} but expected {}{}", got, want, spill_note)
                        },
                    }
                }
                None => MatchVerdict {
                    matched: false,
                    reason: format!(
                        "expected the number {} but the formula produced {}{}",
                        want, outcome.display, spill_note
                    ),
                },
            }
        }
        ExpectKind::Text => {
            let want = expect.text.clone().unwrap_or_default();
            match &outcome.text {
                Some(got) => {
                    let ok = got.trim() == want.trim();
                    MatchVerdict {
                        matched: ok,
                        reason: if ok {
                            format!("the text matches{}", spill_note)
                        } else if got.trim().eq_ignore_ascii_case(want.trim()) {
                            format!(
                                "computed {:?} but expected {:?} — the difference is only case{}",
                                got, want, spill_note
                            )
                        } else {
                            format!("computed {:?} but expected {:?}{}", got, want, spill_note)
                        },
                    }
                }
                None => MatchVerdict {
                    matched: false,
                    reason: format!(
                        "expected the text {:?} but the formula produced a {:?} ({}){}",
                        want, outcome.kind, outcome.display, spill_note
                    ),
                },
            }
        }
        ExpectKind::Boolean => {
            let want = expect.boolean.unwrap_or(false);
            match outcome.boolean {
                Some(got) => MatchVerdict {
                    matched: got == want,
                    reason: if got == want {
                        format!("the boolean matches{}", spill_note)
                    } else {
                        format!("computed {} but expected {}{}", got, want, spill_note)
                    },
                },
                None => MatchVerdict {
                    matched: false,
                    reason: format!(
                        "expected {} but the formula produced {}{}",
                        want, outcome.display, spill_note
                    ),
                },
            }
        }
        ExpectKind::Error => {
            let want = expect.error.clone().unwrap_or_default();
            match &outcome.error {
                Some(got) => MatchVerdict {
                    matched: got == &want,
                    reason: if got == &want {
                        format!("the error literal matches{}", spill_note)
                    } else {
                        format!("computed {} but expected {}{}", got, want, spill_note)
                    },
                },
                None => MatchVerdict {
                    matched: false,
                    reason: format!(
                        "expected the error {} but the formula produced {}{}",
                        want, outcome.display, spill_note
                    ),
                },
            }
        }
        ExpectKind::Display => {
            let want = expect.display.clone().unwrap_or_default();
            let ok = outcome.display == want;
            MatchVerdict {
                matched: ok,
                reason: if ok {
                    format!("the rendering matches{}", spill_note)
                } else {
                    format!(
                        "rendered {:?} but expected {:?}{}",
                        outcome.display, want, spill_note
                    )
                },
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fx(row: u32, col: u32, input: &str) -> FixtureCell {
        FixtureCell { row, col, input: input.to_string() }
    }

    fn job(row: u32, col: u32, formula: &str) -> FormulaJob {
        FormulaJob { row, col, formula: formula.to_string() }
    }

    fn one(fixture: &[FixtureCell], formula: &str) -> FormulaOutcome {
        let out = evaluate_fixture(fixture, &[job(0, 5, formula)], "Sheet1");
        assert!(out.converged, "the fixture did not settle: {:?}", out);
        out.results.into_iter().next().expect("one result")
    }

    #[test]
    fn a_formula_over_seeded_literals_gets_its_real_value() {
        let fixture = vec![fx(0, 0, "5000"), fx(1, 0, "7200"), fx(2, 0, "3100")];
        let r = one(&fixture, "=SUM(A1:A3)");
        assert_eq!(r.kind, ValueKind::Number);
        assert_eq!(r.number, Some(15300.0));
        assert_eq!(r.display, "15300");
    }

    #[test]
    fn text_and_numbers_are_told_apart_by_the_seeder() {
        // "5000" is a number; "'5000" is the text a leading apostrophe forces.
        assert_eq!(seed_value("5000"), CellValue::Number(5000.0));
        assert_eq!(seed_value("'5000"), CellValue::Text("5000".to_string()));
        assert_eq!(seed_value("TRUE"), CellValue::Boolean(true));
        assert_eq!(seed_value("'TRUE"), CellValue::Text("TRUE".to_string()));
        assert_eq!(seed_value("North"), CellValue::Text("North".to_string()));
        assert_eq!(seed_value(""), CellValue::Empty);
    }

    #[test]
    fn an_iso_date_is_seeded_as_a_serial_not_as_text() {
        // The app's own seeder calls this text; a date corpus cannot work that
        // way, so this module is deliberately wider. If this regresses, every
        // date task starts failing with #VALUE! against a CORRECT formula.
        let seeded = seed_value("2025-01-03");
        match seeded {
            CellValue::Number(n) => assert!(n > 45000.0, "not a plausible serial: {}", n),
            other => panic!("an ISO date must seed as a number, got {:?}", other),
        }
    }

    #[test]
    fn a_fixture_is_seeded_through_the_products_own_typed_entry_ladder() {
        // EVERY ONE OF THESE WAS WRONG under the hand-rolled seeder this
        // replaced: each landed as Text, so a formula over it answered #VALUE!
        // and the grader marked CORRECT formulas wrong. They are pinned
        // individually because the failure is silent — a wrong seed produces a
        // confident wrong grade, not an error.
        let cases: &[(&str, &str, &str)] = &[
            // (typed input, formula over it, expected display)
            ("6%", "=A1*100", "6"),          // a percent is a fraction, not text
            ("$1,000", "=A1+1", "1001"),     // a currency symbol is formatting
            ("1,234.5", "=A1*2", "2469"),    // thousands separators are formatting
            ("3/1/2024", "=YEAR(A1)", "2024"), // a slash date is a serial
            ("2025-01-03", "=YEAR(A1)", "2025"), // so is an ISO date
            ("'007", "=ISTEXT(A1)", "TRUE"), // the apostrophe escape holds
            ("#N/A", "=ISNA(A1)", "TRUE"),   // a typed error literal IS an error
            ("TRUE", "=IF(A1,1,0)", "1"),    // a typed boolean is a boolean
        ];
        for (input, formula, want) in cases {
            let r = one(&[fx(0, 0, input)], formula);
            assert_eq!(
                &r.display, want,
                "seeding {:?} then evaluating {:?} gave {:?}, expected {:?}",
                input, formula, r.display, want
            );
        }
    }

    #[test]
    fn a_two_condition_sum_excludes_the_rows_it_should() {
        let fixture = vec![
            fx(0, 0, "North"), fx(0, 1, "Widget"), fx(0, 2, "5000"),
            fx(1, 0, "South"), fx(1, 1, "Gadget"), fx(1, 2, "7200"),
            fx(2, 0, "North"), fx(2, 1, "Gadget"), fx(2, 2, "3100"),
            fx(3, 0, "South"), fx(3, 1, "Widget"), fx(3, 2, "6400"),
            fx(4, 0, "North"), fx(4, 1, "Widget"), fx(4, 2, "4800"),
        ];
        let r = one(&fixture, "=SUMIFS(C1:C5,A1:A5,\"North\",B1:B5,\"Widget\")");
        assert_eq!(r.number, Some(9800.0), "expected 5000 + 4800");
    }

    #[test]
    fn a_formula_that_does_not_parse_reports_the_parse_error_and_no_value() {
        let r = one(&[], "=SUM(");
        assert!(r.parse_error.is_some(), "a broken formula must report why");
        assert_eq!(r.number, None);
        assert_eq!(r.kind, ValueKind::Error);
    }

    #[test]
    fn an_unknown_function_evaluates_to_an_error_rather_than_a_number() {
        // `from_name` maps an unrecognised name to BuiltinFunction::Custom, and
        // evaluating one must not produce a plausible number.
        let r = one(&[fx(0, 0, "1")], "=SUMMX(A1:A1)");
        assert!(
            r.number.is_none(),
            "an invented function must not grade as a value: {:?}",
            r
        );
    }

    #[test]
    fn a_division_by_zero_reports_the_error_literal() {
        let fixture = vec![fx(0, 0, "10"), fx(1, 0, "0")];
        let r = one(&fixture, "=A1/A2");
        assert_eq!(r.kind, ValueKind::Error);
        assert_eq!(r.error.as_deref(), Some("#DIV/0!"));
        assert_eq!(r.display, "#DIV/0!");
    }

    #[test]
    fn a_spill_is_reported_as_a_spill_and_never_collapsed_silently() {
        let fixture = vec![fx(0, 0, "3"), fx(1, 0, "1"), fx(2, 0, "2")];
        let r = one(&fixture, "=SORT(A1:A3)");
        assert_eq!(r.kind, ValueKind::Spill, "SORT must report as spilling: {:?}", r);
        assert_eq!(r.spill_len, 3);
        // The anchor is still reported, because that is what a single-cell
        // expectation can pin.
        assert_eq!(r.number, Some(1.0));
    }

    #[test]
    fn a_deep_chain_in_the_fixture_settles_rather_than_reporting_a_false_cycle() {
        // A running-total column is depth 50 of ordinary content. A flat pass
        // budget called this circular; the derived budget must not.
        let mut fixture = vec![fx(0, 0, "1"), fx(0, 1, "1")];
        for row in 1..50u32 {
            fixture.push(fx(row, 0, "1"));
            fixture.push(fx(row, 1, &format!("=B{}+A{}", row, row + 1)));
        }
        let out = evaluate_fixture(&fixture, &[job(0, 5, "=B50")], "Sheet1");
        assert!(out.converged, "a 50-deep chain must settle, not read as a cycle");
        assert_eq!(out.results[0].number, Some(50.0));
    }

    #[test]
    fn a_circular_fixture_stops_and_says_it_did_not_settle() {
        let fixture = vec![fx(0, 0, "=B1+1"), fx(0, 1, "=A1+1")];
        let out = evaluate_fixture(&fixture, &[job(0, 5, "=A1")], "Sheet1");
        assert!(
            !out.converged,
            "a real cycle must be reported as unconverged rather than graded"
        );
    }

    #[test]
    fn the_formula_is_evaluated_at_its_own_address() {
        // ROW() with no argument resolves against the cell the formula sits in.
        // Evaluating it at the wrong address is silent, so it is pinned here.
        let out = evaluate_fixture(&[], &[job(6, 5, "=ROW()")], "Sheet1");
        assert_eq!(out.results[0].number, Some(7.0), "row 6 is 1-indexed row 7");
    }

    #[test]
    fn an_oversized_fixture_is_refused_with_a_reason_and_evaluates_nothing() {
        let fixture: Vec<FixtureCell> = (0..(MAX_FIXTURE_CELLS as u32 + 1))
            .map(|i| fx(i, 0, "1"))
            .collect();
        let out = evaluate_fixture(&fixture, &[job(0, 5, "=SUM(A:A)")], "Sheet1");
        assert!(out.refused.is_some(), "an oversized fixture must be refused");
        assert!(out.results.is_empty(), "a refusal evaluates nothing");
    }

    #[test]
    fn a1_addresses_convert_to_zero_based_indices() {
        assert_eq!(parse_a1("A1"), Some((0, 0)));
        assert_eq!(parse_a1("F2"), Some((1, 5)));
        assert_eq!(parse_a1("Z10"), Some((9, 25)));
        assert_eq!(parse_a1("AA1"), Some((0, 26)));
        assert_eq!(parse_a1(" C3 "), Some((2, 2)));
        // Rejected rather than coerced.
        assert_eq!(parse_a1("$A$1"), None, "an absolute marker is a mistake, not a form");
        assert_eq!(parse_a1("A"), None);
        assert_eq!(parse_a1("1"), None);
        assert_eq!(parse_a1("A0"), None, "rows are 1-based on the page");
        assert_eq!(parse_a1("A1:B2"), None, "a range is not a cell");
        assert_eq!(parse_a1(""), None);
    }

    fn expect_number(n: f64) -> Expectation {
        Expectation {
            kind: ExpectKind::Number,
            number: Some(n),
            text: None,
            boolean: None,
            error: None,
            display: None,
            tolerance: None,
        }
    }

    #[test]
    fn a_number_is_compared_numerically_not_by_its_rendering() {
        // 0.1 + 0.2 renders as 0.30000000000000004. A grader that compared
        // display strings would mark this correct answer wrong.
        let r = one(&[fx(0, 0, "0.1"), fx(1, 0, "0.2")], "=A1+A2");
        assert_ne!(r.display, "0.3", "the rendering really is not 0.3");
        let v = compare(&r, &expect_number(0.3), true);
        assert!(v.matched, "{}", v.reason);
    }

    #[test]
    fn a_text_result_never_satisfies_a_number_expectation() {
        // The commonest coercion bug there is: "9800" is not 9800.
        let r = one(&[fx(0, 0, "'9800")], "=A1");
        assert_eq!(r.kind, ValueKind::Text);
        let v = compare(&r, &expect_number(9800.0), true);
        assert!(!v.matched, "text must not satisfy a number expectation");
        assert!(v.reason.contains("expected the number"), "{}", v.reason);
    }

    #[test]
    fn an_unconverged_batch_never_matches_however_right_the_value_looks() {
        let r = one(&[fx(0, 0, "3")], "=A1*100");
        assert_eq!(r.number, Some(300.0));
        let v = compare(&r, &expect_number(300.0), false);
        assert!(!v.matched, "an unsettled fixture must not grade");
        assert!(v.reason.contains("did not settle"), "{}", v.reason);
    }

    #[test]
    fn a_parse_error_never_matches() {
        let r = one(&[], "=SUM(");
        let v = compare(&r, &expect_number(0.0), true);
        assert!(!v.matched);
        assert!(v.reason.contains("did not parse"), "{}", v.reason);
    }

    #[test]
    fn a_case_only_text_difference_is_a_mismatch_that_says_so() {
        let r = one(&[fx(0, 0, "north")], "=A1");
        let want = Expectation {
            kind: ExpectKind::Text,
            number: None,
            text: Some("North".to_string()),
            boolean: None,
            error: None,
            display: None,
            tolerance: None,
        };
        let v = compare(&r, &want, true);
        assert!(!v.matched, "case matters for a stated text answer");
        assert!(v.reason.contains("only case"), "{}", v.reason);
    }

    #[test]
    fn an_absolute_tolerance_overrides_the_relative_default() {
        let r = one(&[fx(0, 0, "10"), fx(1, 0, "3")], "=A1/A2");
        // 3.333... is nowhere near 3.34 relatively, but a task that says "to the
        // nearest oere" supplies an absolute tolerance and should pass.
        let mut want = expect_number(3.34);
        assert!(!compare(&r, &want, true).matched, "the default is strict");
        want.tolerance = Some(0.01);
        assert!(compare(&r, &want, true).matched, "an absolute tolerance must be honoured");
    }

    #[test]
    fn a_spill_can_satisfy_a_scalar_expectation_but_the_reason_says_so() {
        let fixture = vec![fx(0, 0, "3"), fx(1, 0, "1"), fx(2, 0, "2")];
        let r = one(&fixture, "=SORT(A1:A3)");
        let v = compare(&r, &expect_number(1.0), true);
        assert!(v.matched, "{}", v.reason);
        assert!(
            v.reason.contains("spill"),
            "a spill graded as a scalar must say so: {}",
            v.reason
        );
    }

    #[test]
    fn an_error_literal_must_match_exactly() {
        let r = one(&[fx(0, 0, "10"), fx(1, 0, "0")], "=A1/A2");
        let mut want = Expectation {
            kind: ExpectKind::Error,
            number: None,
            text: None,
            boolean: None,
            error: Some("#DIV/0!".to_string()),
            display: None,
            tolerance: None,
        };
        assert!(compare(&r, &want, true).matched);
        want.error = Some("#N/A".to_string());
        assert!(!compare(&r, &want, true).matched, "a different error is a mismatch");
    }

    #[test]
    fn the_same_request_twice_gives_a_byte_identical_answer() {
        let fixture = vec![fx(0, 0, "5"), fx(1, 0, "7"), fx(2, 0, "North")];
        let jobs = vec![job(0, 5, "=SUM(A1:A2)"), job(1, 5, "=COUNTA(A1:A3)")];
        let a = evaluate_fixture(&fixture, &jobs, "Sheet1");
        let b = evaluate_fixture(&fixture, &jobs, "Sheet1");
        assert_eq!(a, b, "the grader must be deterministic");
    }
}
