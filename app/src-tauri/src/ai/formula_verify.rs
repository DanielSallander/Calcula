//! FILENAME: app/src-tauri/src/ai/formula_verify.rs
// PURPOSE: Rungs F0-F2 of the formula-assistant ladder against the LIVE grid —
//          normalise what the model wrote, parse and judge it against the
//          function catalogue, then evaluate it at the cell it is destined for.
// CONTEXT: The live sibling of `core/calcula-format/src/ai/formula_verify.rs`,
//          which runs the same ladder over a FIXTURE with no app around it. The
//          vocabulary is deliberately shared — a spill is a spill, an error
//          literal is the literal, a formula that will not parse reports the
//          parser's own message — so a model measured offline and a model used
//          in the product are held to one standard.
//
//          THE ONE THING THIS MODULE MUST NEVER DO IS GUESS. A rung that cannot
//          judge DECLINES and says why. An exhausted evaluation budget
//          (`#LIMIT!`) or a cancelled pass is a DECLINE, not a repair: the
//          formula may be perfect and the machine merely slow, and telling the
//          user to rewrite a correct formula is worse than telling them nothing.
//
//          WHY THE POSITION IS LOAD-BEARING. `ROW()`, `COLUMN()` and implicit
//          intersection all resolve against the cell the formula sits in, so
//          "the same formula" evaluated at the wrong address silently returns a
//          different answer. Every evaluation here carries an `EvalContext` with
//          the real target coordinates, and the fill-down preview SHIFTS the
//          references through the fill path's own shifter rather than
//          re-evaluating the same text one row down.
//
//          READ-ONLY. No `DocumentEffect`: this evaluates, it never writes. The
//          `localized` string it returns is what a caller would INSERT, and
//          inserting it is the caller's separate, gated act.

use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::eval_budget::{self, EvalSurface, SCRIPT_EVAL_TIMEOUT_MS};
use crate::AppState;
use engine::cell::{CellError, CellValue};
use engine::evaluator::{EvalContext, EvalResult, Evaluator};
use engine::grid::Grid;
use engine::style::StyleRegistry;
use engine::{CancelToken, LocaleSettings};
use parser::{BuiltinFunction, Expression};

// ---------------------------------------------------------------------------
// Wire shapes
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FormulaVerifyRequest {
    /// Exactly what the model produced, fences, backticks and all.
    pub formula: String,
    pub sheet_index: Option<usize>,
    pub row: u32,
    pub col: u32,
    /// How many rows below the target to ALSO preview, 0..=3. Clamped, never
    /// rejected: a caller asking for 50 gets 3 rather than an error.
    #[serde(default)]
    pub fill_down_rows: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifyFinding {
    /// A stable machine code — see the `FINDING_*` constants.
    pub code: String,
    pub message: String,
    pub hint: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewValue {
    pub row: u32,
    pub col: u32,
    /// Rendered with the TARGET cell's own number format, so a currency column
    /// previews as currency and a date column as a date rather than as a serial.
    pub display: String,
    /// "number" | "text" | "boolean" | "error" | "blank" | "spill" | "other".
    pub kind: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FormulaVerifyReport {
    /// The INVARIANT form, with the leading `=`. This is what parses and what a
    /// `.cala` stores.
    pub normalized: String,
    /// The same formula in the workbook's locale, with the leading `=`.
    ///
    /// THE STRING A CALLER INSERTS. The app's cell-input path delocalizes what
    /// it is handed, so feeding it the invariant form in a `;`-separator locale
    /// delocalizes an already-invariant formula a second time. Both carry the
    /// `=` because a cell handed `SUM(A1:A3)` stores TEXT, silently.
    pub localized: String,
    /// The input was written in the workbook's locale and was translated.
    pub delocalized_from_locale: bool,
    /// The FURTHEST rung reached: "f0" | "f1" | "f2".
    pub rung: String,
    /// "verified" | "repair" | "declined".
    pub verdict: String,
    pub findings: Vec<VerifyFinding>,
    pub values: Vec<PreviewValue>,
    /// Non-zero only when the formula produced a dynamic array.
    pub spill_rows: u32,
    pub spill_cols: u32,
    /// Canonical names, in first-seen order.
    pub functions_used: Vec<String>,
    /// Set exactly when `verdict` is "declined".
    pub decline_reason: Option<String>,
}

pub const FINDING_PARSE_ERROR: &str = "parse-error";
pub const FINDING_EMPTY: &str = "empty-formula";
pub const FINDING_UNKNOWN_FUNCTION: &str = "unknown-function";
pub const FINDING_REFUSED_FUNCTION: &str = "refused-function";
pub const FINDING_VOLATILE: &str = "volatile";
pub const FINDING_FILL_PREVIEW: &str = "fill-preview-unavailable";

/// The finding codes that mean "do not use this formula".
///
/// `volatile` is deliberately absent: RAND and TODAY are legitimate, and a
/// warning that blocks is a warning nobody can act on.
fn is_error_severity(code: &str) -> bool {
    matches!(
        code,
        FINDING_PARSE_ERROR | FINDING_EMPTY | FINDING_UNKNOWN_FUNCTION | FINDING_REFUSED_FUNCTION
    )
}

/// Catalogue CATEGORIES a suggested formula may never contain.
///
/// Judged by category rather than by a name list, so a function added to any of
/// these categories tomorrow is refused the day it lands: `UI` and `File` read
/// state outside the formula's own inputs, `Writeback` reaches the submission
/// log, and `Cube` needs an async prefetch that a synchronous verification
/// cannot perform — so a CUBEVALUE previewed here would answer differently from
/// the same CUBEVALUE in a cell, which is worse than refusing it.
const REFUSED_CATEGORIES: &[&str] = &["UI", "File", "Writeback", "Cube"];

/// Functions whose answer changes without the workbook changing.
///
/// Informational: a formula using one is fine, but a preview of it is a snapshot
/// and the caller should not present the previewed number as the answer.
const VOLATILE: &[&str] = &["RAND", "RANDBETWEEN", "NOW", "TODAY"];

// ---------------------------------------------------------------------------
// F0 — normalise
// ---------------------------------------------------------------------------

/// Strip the packaging a chat model wraps a formula in.
///
/// Models return ```` ```excel\n=SUM(A1:A3)\n``` ````, `` `=SUM(A1:A3)` ``, and
/// bare `=SUM(A1:A3)`, sometimes with trailing prose stripped by the caller and
/// sometimes not. Returns the formula BODY, without the leading `=`.
pub(crate) fn strip_wrapping(raw: &str) -> String {
    let mut text = raw.trim().to_string();

    // A fenced block: drop the opening fence plus its optional language tag
    // (which is on the fence line, not the formula line), then the closer.
    if text.starts_with("```") {
        text = match text.find('\n') {
            Some(nl) => text[nl + 1..].to_string(),
            // A one-line fence: ```=SUM(A1:A3)```
            None => text.trim_matches('`').to_string(),
        };
        if let Some(end) = text.rfind("```") {
            text = text[..end].to_string();
        }
        text = text.trim().to_string();
    }

    // Inline code spans, and any stray backticks either end.
    text = text.trim_matches('`').trim().to_string();
    text = text.trim_start_matches('=').trim().to_string();
    text
}

/// Is this formula written in a `;`-list-separator locale?
///
/// A `;` OUTSIDE a string literal, outside a quoted sheet name and outside `{}`
/// array braces can only be an argument separator, and the invariant form has
/// none. Inside braces a `;` is the array-constant ROW break, which is invariant
/// spelling and must not be read as a locale signal — misreading it there is how
/// a 2-D constant gets flattened into one row by a blind `;`->`,` rewrite.
pub(crate) fn looks_localized(text: &str) -> bool {
    let mut in_string = false;
    let mut in_sheet_name = false;
    let mut braces: u32 = 0;
    for ch in text.chars() {
        match ch {
            '"' if !in_sheet_name => in_string = !in_string,
            '\'' if !in_string => in_sheet_name = !in_sheet_name,
            _ if in_string || in_sheet_name => {}
            '{' => braces += 1,
            '}' => braces = braces.saturating_sub(1),
            ';' if braces == 0 => return true,
            _ => {}
        }
    }
    false
}

// ---------------------------------------------------------------------------
// F1 — parse and judge against the catalogue
// ---------------------------------------------------------------------------

/// Levenshtein distance over CHARACTERS.
///
/// Hand-rolled because `strsim` is not a dependency of this crate and adding one
/// for forty lines of two-row dynamic programming is not a trade worth making.
fn edit_distance(a: &str, b: &str) -> usize {
    let a: Vec<char> = a.chars().collect();
    let b: Vec<char> = b.chars().collect();
    if a.is_empty() {
        return b.len();
    }
    if b.is_empty() {
        return a.len();
    }
    let mut prev: Vec<usize> = (0..=b.len()).collect();
    let mut cur = vec![0usize; b.len() + 1];
    for (i, ca) in a.iter().enumerate() {
        cur[0] = i + 1;
        for (j, cb) in b.iter().enumerate() {
            let cost = if ca == cb { 0 } else { 1 };
            cur[j + 1] = (prev[j] + cost).min(cur[j] + 1).min(prev[j + 1] + 1);
        }
        std::mem::swap(&mut prev, &mut cur);
    }
    prev[b.len()]
}

/// The catalogue entry closest to a misspelled name.
///
/// Aliases are excluded: an alias carries an EMPTY syntax string
/// (`FunctionMeta::alias`), so suggesting one would hand the user a hint with
/// nothing in it.
fn closest_entry(name: &str) -> Option<parser::FunctionMeta> {
    let upper = name.to_uppercase();
    BuiltinFunction::all_catalog_entries()
        .into_iter()
        .filter(|m| !m.is_alias)
        .min_by_key(|m| (edit_distance(&upper, m.name), m.name))
}

fn category_of(canonical: &str) -> Option<&'static str> {
    BuiltinFunction::all_catalog_entries()
        .into_iter()
        .find(|m| m.name == canonical)
        .map(|m| m.category)
}

/// Every function call in the expression, in first-seen order.
///
/// The match is EXHAUSTIVE on purpose. A `_ => {}` arm would mean a new
/// `Expression` variant silently stops being walked — and this walk is what
/// keeps a `File` or `Writeback` function out of a suggested formula, so a
/// missed branch is a hole in a gate, not a cosmetic gap. A new variant must
/// break this build.
fn collect_calls(expr: &Expression, out: &mut Vec<BuiltinFunction>) {
    match expr {
        Expression::FunctionCall { func, args, .. } => {
            out.push(func.clone());
            for a in args {
                collect_calls(a, out);
            }
        }
        Expression::BinaryOp { left, right, .. } => {
            collect_calls(left, out);
            collect_calls(right, out);
        }
        Expression::UnaryOp { operand, .. } => collect_calls(operand, out),
        Expression::Range { start, end, .. } => {
            collect_calls(start, out);
            collect_calls(end, out);
        }
        Expression::Sheet3DRef { reference, .. } => collect_calls(reference, out),
        Expression::IndexAccess { target, index } => {
            collect_calls(target, out);
            collect_calls(index, out);
        }
        Expression::ArrayLiteral { rows } => {
            for row in rows {
                for cell in row {
                    collect_calls(cell, out);
                }
            }
        }
        Expression::ListLiteral { elements } => {
            for e in elements {
                collect_calls(e, out);
            }
        }
        Expression::DictLiteral { entries } => {
            for (k, v) in entries {
                collect_calls(k, out);
                collect_calls(v, out);
            }
        }
        Expression::SpillRef { cell, .. } => collect_calls(cell, out),
        Expression::ImplicitIntersection { operand } => collect_calls(operand, out),
        // Leaves: nothing nested to walk.
        Expression::Literal(_)
        | Expression::CellRef { .. }
        | Expression::ColumnRef { .. }
        | Expression::RowRef { .. }
        | Expression::NamedRef { .. }
        | Expression::TableRef { .. } => {}
    }
}

/// Judge every function the formula calls.
///
/// Returns the canonical names used (first-seen order, deduped) and the
/// findings. Pure, so the refusal and the spelling suggestion are testable
/// without a workbook.
pub(crate) fn analyse_functions(expr: &Expression) -> (Vec<String>, Vec<VerifyFinding>) {
    let mut calls = Vec::new();
    collect_calls(expr, &mut calls);

    let mut names: Vec<String> = Vec::new();
    let mut findings: Vec<VerifyFinding> = Vec::new();

    for func in &calls {
        // Resolve through `from_name` before judging, so an ALIAS is judged as
        // the function it is: AVG is AVERAGE, GETCONTROLVALUE is
        // GET.CONTROLVALUE and is refused for the same reason its primary
        // spelling is.
        let canonical = BuiltinFunction::from_name(func.to_canonical_name())
            .to_canonical_name()
            .to_string();
        if names.contains(&canonical) {
            continue;
        }
        names.push(canonical.clone());

        if let BuiltinFunction::Custom(unknown) = func {
            let hint = closest_entry(unknown).map(|m| {
                format!(
                    "The closest built-in is {} — {}",
                    m.name,
                    if m.syntax.is_empty() { m.name } else { m.syntax }
                )
            });
            findings.push(VerifyFinding {
                code: FINDING_UNKNOWN_FUNCTION.to_string(),
                message: format!("{} is not a function Calcula knows.", unknown),
                hint,
            });
            continue;
        }

        if let Some(category) = category_of(&canonical) {
            if REFUSED_CATEGORIES.contains(&category) {
                findings.push(VerifyFinding {
                    code: FINDING_REFUSED_FUNCTION.to_string(),
                    message: format!(
                        "{} is a {} function and must not appear in a suggested formula.",
                        canonical, category
                    ),
                    hint: Some(
                        "These read files, reach outside the sheet or need an asynchronous \
                         prefetch, so a preview of one would not answer the way a cell does."
                            .to_string(),
                    ),
                });
            }
        }

        if VOLATILE.contains(&canonical.as_str()) {
            findings.push(VerifyFinding {
                code: FINDING_VOLATILE.to_string(),
                message: format!("{} recalculates on its own.", canonical),
                hint: Some(
                    "The previewed value is a snapshot; the cell will show a different one."
                        .to_string(),
                ),
            });
        }
    }

    (names, findings)
}

/// A cheap structural hint for a formula the parser rejected.
///
/// `ParseError` carries a message and no position, so this is the only thing
/// that can point at WHERE. It looks for the two failures that account for most
/// of what a model gets wrong and stays quiet otherwise rather than inventing a
/// diagnosis.
fn parse_hint(text: &str) -> Option<String> {
    let mut in_string = false;
    let mut depth: i32 = 0;
    let mut unbalanced_close = false;
    for ch in text.chars() {
        match ch {
            '"' => in_string = !in_string,
            _ if in_string => {}
            '(' => depth += 1,
            ')' => {
                depth -= 1;
                if depth < 0 {
                    unbalanced_close = true;
                }
            }
            _ => {}
        }
    }
    if in_string {
        return Some("A double quote is never closed.".to_string());
    }
    if unbalanced_close {
        return Some("There is a closing parenthesis with nothing to close.".to_string());
    }
    if depth > 0 {
        return Some(format!(
            "{} opening {} never closed.",
            depth,
            if depth == 1 { "parenthesis is" } else { "parentheses are" }
        ));
    }
    None
}

// ---------------------------------------------------------------------------
// F2 — evaluate at the target
// ---------------------------------------------------------------------------

/// One evaluation's outcome, before it becomes report fields.
struct Evaluated {
    value: PreviewValue,
    spill_rows: u32,
    spill_cols: u32,
    /// The work budget ran out. A DECLINE, never a repair.
    limit_hit: bool,
}

fn kind_of(raw: &EvalResult) -> &'static str {
    match raw {
        EvalResult::Number(_) => "number",
        EvalResult::Text(_) => "text",
        EvalResult::Boolean(_) => "boolean",
        EvalResult::Error(_) => "error",
        EvalResult::Blank => "blank",
        EvalResult::Array(_) => "spill",
        _ => "other",
    }
}

/// Evaluate one parsed formula at one address, over the LIVE grids.
///
/// The `MultiSheetContext` is rebuilt per call because `Evaluator::with_context`
/// takes it by value and each address needs its own `EvalContext`; it holds
/// borrowed grids and is cheap. The same shape the offline sibling uses.
#[allow(clippy::too_many_arguments)]
fn evaluate_at(
    grids: &[Grid],
    sheet_names: &[String],
    sheet_index: usize,
    styles: &StyleRegistry,
    locale: &LocaleSettings,
    ast: &Expression,
    row: u32,
    col: u32,
) -> Evaluated {
    let grid = &grids[sheet_index];
    let context = crate::create_multi_sheet_context(grids, sheet_names, &sheet_names[sheet_index]);
    let ctx = EvalContext {
        current_row: Some(row),
        current_col: Some(col),
        ..Default::default()
    };
    let mut evaluator = Evaluator::with_context(grid, context, ctx);
    eval_budget::apply(&mut evaluator);
    let raw = evaluator.evaluate(ast);

    // THE ARRAY CHECK COMES FIRST, and deliberately: `to_cell_value` collapses
    // an array to its first element, so asking for the cell value before asking
    // whether it spilled turns "this spills nine values" into "this is 5".
    let (spill_rows, spill_cols) = match &raw {
        EvalResult::Array(items) => {
            if let Some(EvalResult::Array(_)) = items.first() {
                let cols = items
                    .iter()
                    .map(|r| match r {
                        EvalResult::Array(inner) => inner.len(),
                        _ => 1,
                    })
                    .max()
                    .unwrap_or(1);
                (items.len() as u32, cols as u32)
            } else {
                // A flat array spills DOWN, the way SEQUENCE(3) does. Reported
                // as rows x 1 rather than guessed at from context.
                (items.len() as u32, 1)
            }
        }
        _ => (0, 0),
    };

    let limit_hit = matches!(raw, EvalResult::Error(CellError::Limit));

    // The anchor is what the top-left cell would show, and it is the only part
    // of a spill a single-cell preview can render.
    let anchor: &EvalResult = match &raw {
        EvalResult::Array(items) => items.first().unwrap_or(&EvalResult::Blank),
        other => other,
    };
    let display = match anchor {
        EvalResult::Error(e) => e.as_literal().to_string(),
        EvalResult::Text(s) => s.clone(),
        EvalResult::Boolean(b) => {
            if *b {
                "TRUE".to_string()
            } else {
                "FALSE".to_string()
            }
        }
        // A scalar goes through the REAL formatter with the TARGET cell's own
        // number format, so a preview into a currency column reads as currency
        // and one into a date column reads as a date rather than as a serial.
        EvalResult::Number(n) => crate::format_cell_value(
            &CellValue::Number(*n),
            styles.get(grid.effective_style_index(row, col)),
            locale,
        ),
        EvalResult::Blank => "0".to_string(),
        other => crate::format_cell_value(
            &other.to_cell_value(),
            styles.get(grid.effective_style_index(row, col)),
            locale,
        ),
    };

    Evaluated {
        value: PreviewValue { row, col, display, kind: kind_of(&raw).to_string() },
        spill_rows,
        spill_cols,
        limit_hit,
    }
}

// ---------------------------------------------------------------------------
// The ladder
// ---------------------------------------------------------------------------

/// The most rows below the target that will be previewed.
const MAX_FILL_DOWN_ROWS: u32 = 3;

fn declined(
    normalized: String,
    localized: String,
    delocalized_from_locale: bool,
    rung: &str,
    reason: String,
    findings: Vec<VerifyFinding>,
    functions_used: Vec<String>,
) -> FormulaVerifyReport {
    FormulaVerifyReport {
        normalized,
        localized,
        delocalized_from_locale,
        rung: rung.to_string(),
        verdict: "declined".to_string(),
        findings,
        values: Vec::new(),
        spill_rows: 0,
        spill_cols: 0,
        functions_used,
        decline_reason: Some(reason),
    }
}

/// Run F0-F2. PURE over its inputs — no Tauri state, no locks — so every rung is
/// unit-testable against a hand-built grid.
pub(crate) fn verify_against(
    grids: &[Grid],
    sheet_names: &[String],
    sheet_index: usize,
    styles: &StyleRegistry,
    locale: &LocaleSettings,
    cancel: &CancelToken,
    request: &FormulaVerifyRequest,
) -> FormulaVerifyReport {
    // ---- F0: normalise -----------------------------------------------------
    let body = strip_wrapping(&request.formula);
    let delocalized_from_locale = looks_localized(&body);
    let invariant_body = if delocalized_from_locale {
        engine::formula_locale::delocalize_formula(&body, locale)
    } else {
        body.clone()
    };
    let normalized = format!("={}", invariant_body);
    let localized = format!(
        "={}",
        engine::formula_locale::localize_formula(&invariant_body, locale)
    );

    if invariant_body.trim().is_empty() {
        return FormulaVerifyReport {
            normalized,
            localized,
            delocalized_from_locale,
            rung: "f0".to_string(),
            verdict: "repair".to_string(),
            findings: vec![VerifyFinding {
                code: FINDING_EMPTY.to_string(),
                message: "There is no formula here once the code fence is removed.".to_string(),
                hint: None,
            }],
            values: Vec::new(),
            spill_rows: 0,
            spill_cols: 0,
            functions_used: Vec::new(),
            decline_reason: None,
        };
    }

    // ---- F1: parse and judge ----------------------------------------------
    let parsed = match parser::parse(&invariant_body) {
        Ok(ast) => crate::convert_expr(&ast),
        Err(e) => {
            return FormulaVerifyReport {
                normalized,
                localized,
                delocalized_from_locale,
                rung: "f0".to_string(),
                verdict: "repair".to_string(),
                findings: vec![VerifyFinding {
                    code: FINDING_PARSE_ERROR.to_string(),
                    message: e.message.clone(),
                    hint: parse_hint(&invariant_body),
                }],
                values: Vec::new(),
                spill_rows: 0,
                spill_cols: 0,
                functions_used: Vec::new(),
                decline_reason: None,
            };
        }
    };

    let (functions_used, mut findings) = analyse_functions(&parsed);

    // An error-severity finding stops the ladder at F1. Evaluating a formula
    // that calls an unknown or refused function tells nobody anything — it
    // answers #NAME? or reaches a surface the suggestion may not use — and a
    // preview value beside a refusal reads as permission.
    if findings.iter().any(|f| is_error_severity(&f.code)) {
        return FormulaVerifyReport {
            normalized,
            localized,
            delocalized_from_locale,
            rung: "f1".to_string(),
            verdict: "repair".to_string(),
            findings,
            values: Vec::new(),
            spill_rows: 0,
            spill_cols: 0,
            functions_used,
            decline_reason: None,
        };
    }

    if sheet_index >= grids.len() || sheet_index >= sheet_names.len() {
        return declined(
            normalized,
            localized,
            delocalized_from_locale,
            "f1",
            format!("sheet index out of range: {}", sheet_index),
            findings,
            functions_used,
        );
    }

    // ---- F2: evaluate at the target ----------------------------------------
    //
    // THE SERVICE BOUNDARY. Same three ceilings `evaluate_formula_typed` lives
    // under: per-expression fuel no larger than a cell the user typed gets, and
    // a wall clock that is legitimate here for the same reason it is legitimate
    // there — these results cross IPC and are never persisted, so no workbook's
    // content can come to depend on machine speed.
    //
    // No file reader and no GATHER source are installed, and neither is an
    // omission: every `File` and `Writeback` function is REFUSED at F1 above, so
    // a formula that reaches this line cannot call one.
    let _pass = eval_budget::begin_service_pass(
        EvalSurface::Script,
        cancel,
        Duration::from_millis(SCRIPT_EVAL_TIMEOUT_MS),
    );

    let target = evaluate_at(
        grids,
        sheet_names,
        sheet_index,
        styles,
        locale,
        &parsed,
        request.row,
        request.col,
    );

    if target.limit_hit {
        return declined(
            normalized,
            localized,
            delocalized_from_locale,
            "f2",
            "The evaluation budget ran out before this formula finished, so there is no \
             value to judge. That is a statement about the work, not about the formula."
                .to_string(),
            findings,
            functions_used,
        );
    }
    if eval_budget::cancel_requested() {
        return declined(
            normalized,
            localized,
            delocalized_from_locale,
            "f2",
            "The evaluation was cancelled or timed out before it finished.".to_string(),
            findings,
            functions_used,
        );
    }

    let spill_rows = target.spill_rows;
    let spill_cols = target.spill_cols;
    let mut values = vec![target.value];

    // Fill-down preview. The references are SHIFTED by the fill path's own
    // shifter (`shift_formula_internal`) rather than by re-evaluating the same
    // text one row down: a relative `A1` must become `A2` and an absolute `$A$1`
    // must not, and hand-rolling that rule is how three copies of it drifted
    // apart before it was centralised. Structured references deliberately do not
    // move — Excel shifts a specifier sideways only, never on a copy DOWN — so
    // the table-less entry point is the correct one here.
    let fill = request.fill_down_rows.min(MAX_FILL_DOWN_ROWS);
    for n in 1..=fill {
        let shifted = crate::commands::structure::shift_formula_internal(&normalized, n as i32, 0);
        let shifted_body = shifted.trim_start_matches('=');
        match parser::parse(shifted_body) {
            Ok(ast) => {
                let ast = crate::convert_expr(&ast);
                let out = evaluate_at(
                    grids,
                    sheet_names,
                    sheet_index,
                    styles,
                    locale,
                    &ast,
                    request.row + n,
                    request.col,
                );
                values.push(out.value);
            }
            Err(e) => {
                // The shift produced something the parser rejects. Reported, not
                // hidden and not guessed around: the TARGET row's verdict still
                // stands, and the caller is told the fill preview is missing.
                findings.push(VerifyFinding {
                    code: FINDING_FILL_PREVIEW.to_string(),
                    message: format!(
                        "The formula shifted down {} row(s) no longer parses: {}",
                        n, e.message
                    ),
                    hint: None,
                });
                break;
            }
        }
    }

    let verdict = if findings.iter().any(|f| is_error_severity(&f.code)) {
        "repair"
    } else {
        "verified"
    };

    FormulaVerifyReport {
        normalized,
        localized,
        delocalized_from_locale,
        rung: "f2".to_string(),
        verdict: verdict.to_string(),
        findings,
        values,
        spill_rows,
        spill_cols,
        functions_used,
        decline_reason: None,
    }
}

/// Verify a proposed formula against the open workbook.
///
/// Read-only: no `DocumentEffect`, nothing persisted changes.
#[tauri::command]
pub fn formula_assist_verify(
    request: FormulaVerifyRequest,
    state: State<AppState>,
    window: tauri::Window,
) -> Result<FormulaVerifyReport, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;

    let grids = state.grids.read().map_err(|e| e.to_string())?;
    let sheet_names = state.sheet_names.read().map_err(|e| e.to_string())?;
    let active_sheet = *state.active_sheet.read().map_err(|e| e.to_string())?;
    let styles = state.style_registry.read().map_err(|e| e.to_string())?;
    let locale = state.locale.lock().map_err(|e| e.to_string())?;

    let sheet_index = request.sheet_index.unwrap_or(active_sheet);
    Ok(verify_against(
        &grids,
        &sheet_names,
        sheet_index,
        &styles,
        &locale,
        &state.calc_cancel,
        &request,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use engine::cell::Cell;
    use engine::style::{CellStyle, NumberFormat};

    fn number(n: f64) -> Cell {
        Cell { ast: None, value: CellValue::Number(n), style_index: 0, rich_text: None }
    }

    fn req(formula: &str, row: u32, col: u32) -> FormulaVerifyRequest {
        FormulaVerifyRequest {
            formula: formula.to_string(),
            sheet_index: Some(0),
            row,
            col,
            fill_down_rows: 0,
        }
    }

    fn sheet() -> (Vec<Grid>, Vec<String>) {
        let mut grid = Grid::new();
        grid.set_cell(0, 0, number(5000.0));
        grid.set_cell(1, 0, number(7200.0));
        grid.set_cell(2, 0, number(3100.0));
        grid.set_cell(0, 1, number(2.0));
        grid.set_cell(1, 1, number(4.0));
        grid.set_cell(2, 1, number(8.0));
        (vec![grid], vec!["Sheet1".to_string()])
    }

    fn verify_with(
        styles: &StyleRegistry,
        locale: &LocaleSettings,
        request: &FormulaVerifyRequest,
    ) -> FormulaVerifyReport {
        let (grids, names) = sheet();
        let cancel = CancelToken::default();
        verify_against(&grids, &names, 0, styles, locale, &cancel, request)
    }

    fn verify(formula: &str, row: u32, col: u32) -> FormulaVerifyReport {
        verify_with(
            &StyleRegistry::new(),
            &LocaleSettings::invariant(),
            &req(formula, row, col),
        )
    }

    // ---- F0 ---------------------------------------------------------------

    #[test]
    fn a_fenced_answer_is_unwrapped_to_the_formula_alone() {
        assert_eq!(strip_wrapping("```excel\n=SUM(A1:A3)\n```"), "SUM(A1:A3)");
        assert_eq!(strip_wrapping("```\n=SUM(A1:A3)\n```"), "SUM(A1:A3)");
        assert_eq!(strip_wrapping("`=SUM(A1:A3)`"), "SUM(A1:A3)");
        assert_eq!(strip_wrapping("  =SUM(A1:A3)  "), "SUM(A1:A3)");
        assert_eq!(strip_wrapping("SUM(A1:A3)"), "SUM(A1:A3)");
        assert_eq!(strip_wrapping("```=SUM(A1:A3)```"), "SUM(A1:A3)");
    }

    #[test]
    fn a_semicolon_outside_a_string_is_the_locale_signal_and_inside_one_is_not() {
        assert!(looks_localized("SUM(A1;B1)"));
        assert!(!looks_localized("SUM(A1,B1)"));
        // A `;` inside a TEXT literal is data, not syntax. Treating it as a
        // locale signal would delocalize an already-invariant formula and turn
        // its `.` decimals into `,` argument separators.
        assert!(!looks_localized("TEXTJOIN(\";\",TRUE,A1:A3)"));
        // Inside `{}` a `;` is the array-constant ROW break — invariant
        // spelling. Misreading it here is how a 2-D constant gets flattened.
        assert!(!looks_localized("SUM({1,2;3,4})"));
        // ...but an argument separator OUTSIDE the braces still counts.
        assert!(looks_localized("SUM({1,2;3,4};A1)"));
        // A quoted sheet name may legitimately contain a semicolon.
        assert!(!looks_localized("'a;b'!A1"));
    }

    #[test]
    fn a_localized_formula_is_translated_and_both_spellings_come_back() {
        let locale = LocaleSettings::from_locale_id("sv-SE");
        assert_eq!(locale.list_separator, ';', "the test needs a ;-separator locale");
        let r = verify_with(&StyleRegistry::new(), &locale, &req("=SUM(A1;A2)", 0, 5));
        assert!(r.delocalized_from_locale);
        assert_eq!(r.normalized, "=SUM(A1,A2)", "storage is invariant");
        assert_eq!(r.localized, "=SUM(A1;A2)", "display and insertion are localized");
        assert_eq!(r.verdict, "verified", "{:?}", r.findings);
    }

    #[test]
    fn an_invariant_formula_in_a_localized_workbook_still_gets_a_localized_spelling() {
        // The model writes invariant; the CELL must be handed the locale form,
        // because the cell-input path delocalizes what it is given and would
        // otherwise read `,` as a decimal point.
        let locale = LocaleSettings::from_locale_id("sv-SE");
        let r = verify_with(&StyleRegistry::new(), &locale, &req("=SUM(A1,A2)", 0, 5));
        assert!(!r.delocalized_from_locale, "there was no `;` to translate");
        assert_eq!(r.normalized, "=SUM(A1,A2)");
        assert_eq!(r.localized, "=SUM(A1;A2)");
    }

    #[test]
    fn both_returned_spellings_carry_the_leading_equals() {
        // A cell handed `SUM(A1:A3)` stores TEXT, silently. The `=` is the whole
        // difference between a formula and a label.
        let r = verify("SUM(A1:A3)", 0, 5);
        assert!(r.normalized.starts_with('='), "{}", r.normalized);
        assert!(r.localized.starts_with('='), "{}", r.localized);
    }

    #[test]
    fn an_empty_answer_is_reported_rather_than_parsed() {
        let r = verify("```\n\n```", 0, 5);
        assert_eq!(r.rung, "f0");
        assert_eq!(r.verdict, "repair");
        assert_eq!(r.findings[0].code, FINDING_EMPTY);
    }

    // ---- F1 ---------------------------------------------------------------

    #[test]
    fn a_formula_that_does_not_parse_reports_why_and_never_reaches_f2() {
        let r = verify("=SUM(A1:A3", 0, 5);
        assert_eq!(r.rung, "f0");
        assert_eq!(r.verdict, "repair");
        assert_eq!(r.findings[0].code, FINDING_PARSE_ERROR);
        assert!(!r.findings[0].message.is_empty(), "the parser's own message");
        assert_eq!(
            r.findings[0].hint.as_deref(),
            Some("1 opening parenthesis is never closed.")
        );
        assert!(r.values.is_empty(), "a formula that will not parse has no value");
    }

    #[test]
    fn the_parse_hint_names_the_two_failures_it_can_actually_see() {
        assert_eq!(
            parse_hint("SUM(A1:A3"),
            Some("1 opening parenthesis is never closed.".to_string())
        );
        assert_eq!(
            parse_hint("SUM(A1:A3))"),
            Some("There is a closing parenthesis with nothing to close.".to_string())
        );
        assert_eq!(
            parse_hint("CONCAT(\"a)"),
            Some("A double quote is never closed.".to_string())
        );
        // A parenthesis inside a STRING is text, not structure.
        assert_eq!(parse_hint("CONCAT(\"(\")"), None);
        // And it stays quiet rather than inventing a diagnosis.
        assert_eq!(parse_hint("SUM(A1:A3)"), None);
    }

    #[test]
    fn an_unknown_function_names_the_closest_catalogue_entry_and_its_syntax() {
        let r = verify("=SUMM(A1:A3)", 0, 5);
        assert_eq!(r.rung, "f1");
        assert_eq!(r.verdict, "repair");
        let f = r
            .findings
            .iter()
            .find(|f| f.code == FINDING_UNKNOWN_FUNCTION)
            .expect("an invented name must be reported");
        let hint = f.hint.as_deref().expect("the hint names a real function");
        assert!(hint.contains("SUM"), "got {}", hint);
        assert!(hint.contains("SUM(number1"), "the syntax comes with it: {}", hint);
        assert!(r.values.is_empty(), "a #NAME? preview teaches nobody anything");
    }

    #[test]
    fn edit_distance_is_the_real_metric_and_not_a_prefix_match() {
        assert_eq!(edit_distance("SUM", "SUM"), 0);
        assert_eq!(edit_distance("SUMM", "SUM"), 1);
        assert_eq!(edit_distance("VLOOKUP", "VLOOKUP"), 0);
        assert_eq!(edit_distance("XLOOKUP", "VLOOKUP"), 1);
        assert_eq!(edit_distance("", "ABC"), 3);
        assert_eq!(edit_distance("ABC", ""), 3);
        // Transposition costs two under plain Levenshtein; the suggestion still
        // lands because everything else is further away.
        assert_eq!(edit_distance("AVEARGE", "AVERAGE"), 2);
        assert_eq!(closest_entry("AVEARGE").unwrap().name, "AVERAGE");
    }

    #[test]
    fn a_refused_category_is_refused_whichever_spelling_is_used() {
        // Judged by CATEGORY, and resolved through `from_name` first, so an
        // ALIAS is refused exactly as its primary spelling is. GETCONTROLVALUE
        // is the alias; GET.CONTROLVALUE is the entry.
        for spelling in ["GET.CONTROLVALUE(\"x\")", "GETCONTROLVALUE(\"x\")"] {
            let r = verify(&format!("={}", spelling), 0, 5);
            let refused = r
                .findings
                .iter()
                .find(|f| f.code == FINDING_REFUSED_FUNCTION)
                .unwrap_or_else(|| panic!("{} must be refused: {:?}", spelling, r.findings));
            assert!(refused.message.contains("UI"), "{}", refused.message);
            assert_eq!(r.verdict, "repair");
            assert!(r.values.is_empty(), "a refused formula is never previewed");
        }
    }

    #[test]
    fn every_refused_category_really_is_refused() {
        // One probe per category, so a category renamed in the catalogue fails
        // here rather than silently opening a door.
        for (formula, category) in [
            ("=FILEREAD(\"a.txt\")", "File"),
            ("=GATHER(\"r1\")", "Writeback"),
            ("=CUBESETCOUNT(A1)", "Cube"),
            ("=GET.ROW.HEIGHT(1)", "UI"),
        ] {
            let r = verify(formula, 0, 5);
            let refused = r
                .findings
                .iter()
                .find(|f| f.code == FINDING_REFUSED_FUNCTION)
                .unwrap_or_else(|| panic!("{} must be refused: {:?}", formula, r.findings));
            assert!(
                refused.message.contains(category),
                "{} should name {}: {}",
                formula,
                category,
                refused.message
            );
        }
    }

    #[test]
    fn an_ordinary_function_is_not_refused() {
        // The positive control for the refusal above: without it, a gate that
        // refuses everything would pass every refusal test.
        let r = verify("=SUM(A1:A3)", 0, 5);
        assert!(
            r.findings.iter().all(|f| f.code != FINDING_REFUSED_FUNCTION),
            "{:?}",
            r.findings
        );
        assert_eq!(r.verdict, "verified");
    }

    #[test]
    fn a_volatile_function_is_flagged_but_does_not_block() {
        let r = verify("=TODAY()", 0, 5);
        assert_eq!(r.rung, "f2", "informational findings do not stop the ladder");
        assert_eq!(r.verdict, "verified");
        assert!(r.findings.iter().any(|f| f.code == FINDING_VOLATILE));
    }

    #[test]
    fn every_nested_function_is_seen_by_the_walk() {
        // The walk is what keeps a refused function out of a suggestion, so it
        // must find one wherever it hides — inside arguments, operators, array
        // literals and index access alike.
        let r = verify("=IF(SUM(A1:A3)>ABS(-1),MAX(A1:A3),MIN(A1:A3))", 0, 5);
        for want in ["IF", "SUM", "ABS", "MAX", "MIN"] {
            assert!(
                r.functions_used.iter().any(|n| n == want),
                "{} missing from {:?}",
                want,
                r.functions_used
            );
        }
        // And a refused call buried inside an operand is still caught.
        let hidden = verify("=SUM(A1:A3) + GET.ROW.HEIGHT(1)", 0, 5);
        assert!(hidden
            .findings
            .iter()
            .any(|f| f.code == FINDING_REFUSED_FUNCTION));
    }

    #[test]
    fn an_alias_reports_under_its_primary_name() {
        let r = verify("=AVG(A1:A3)", 0, 5);
        assert_eq!(r.functions_used, vec!["AVERAGE".to_string()]);
    }

    // ---- F2 ---------------------------------------------------------------

    #[test]
    fn a_verified_formula_carries_its_value_from_the_live_grid() {
        let r = verify("=SUM(A1:A3)", 0, 5);
        assert_eq!(r.rung, "f2");
        assert_eq!(r.verdict, "verified");
        assert_eq!(r.values.len(), 1);
        assert_eq!(r.values[0].display, "15300");
        assert_eq!(r.values[0].kind, "number");
        assert_eq!(r.spill_rows, 0);
    }

    #[test]
    fn the_formula_is_evaluated_at_the_TARGET_address_and_not_at_the_origin() {
        // ROW() resolves against the cell the formula sits in. Evaluating at the
        // wrong address is silent, which is exactly why it is pinned.
        let r = verify("=ROW()", 6, 5);
        assert_eq!(r.values[0].display, "7", "row index 6 is 1-based row 7");
        let c = verify("=COLUMN()", 6, 5);
        assert_eq!(c.values[0].display, "6");
    }

    #[test]
    fn a_spill_is_reported_as_a_spill_and_never_collapsed_to_its_anchor() {
        // `to_cell_value` takes arr.first(), so asking for the value before
        // asking whether it spilled turns "three values" into "3100".
        let r = verify("=SORT(A1:A3)", 0, 5);
        assert_eq!(r.values[0].kind, "spill");
        assert_eq!(r.spill_rows, 3, "three rows spill down");
        assert_eq!(r.spill_cols, 1);
        assert_eq!(r.values[0].display, "3100", "the anchor is still shown");
    }

    #[test]
    fn an_error_reports_the_real_excel_literal() {
        let mut grid = Grid::new();
        grid.set_cell(0, 0, number(10.0));
        grid.set_cell(1, 0, number(0.0));
        let grids = vec![grid];
        let names = vec!["Sheet1".to_string()];
        let styles = StyleRegistry::new();
        let locale = LocaleSettings::invariant();
        let cancel = CancelToken::default();
        let r = verify_against(
            &grids,
            &names,
            0,
            &styles,
            &locale,
            &cancel,
            &req("=A1/A2", 0, 5),
        );
        assert_eq!(r.values[0].kind, "error");
        assert_eq!(r.values[0].display, "#DIV/0!");
        // An evaluated error is still a JUDGED formula: the ladder reached F2
        // and nothing structural is wrong, so it is not a decline.
        assert_eq!(r.rung, "f2");
        assert_ne!(r.verdict, "declined");
    }

    #[test]
    fn a_scalar_preview_is_rendered_with_the_TARGET_cells_own_number_format() {
        // A date is a NUMBER whose style says otherwise; previewing 45000 as
        // "45000" into a date column is a preview of something the cell will
        // never show.
        let mut styles = StyleRegistry::new();
        let dated = styles.get_or_create(CellStyle {
            number_format: NumberFormat::Date { format: "YYYY-MM-DD".to_string() },
            ..Default::default()
        });
        let mut grid = Grid::new();
        grid.set_cell(0, 0, number(45000.0));
        let mut target = number(0.0);
        target.style_index = dated;
        grid.set_cell(0, 5, target);
        let grids = vec![grid];
        let names = vec!["Sheet1".to_string()];
        let locale = LocaleSettings::invariant();
        let cancel = CancelToken::default();
        let r = verify_against(
            &grids,
            &names,
            0,
            &styles,
            &locale,
            &cancel,
            &req("=A1", 0, 5),
        );
        assert!(
            r.values[0].display.contains('-'),
            "expected a formatted date, got {:?}",
            r.values[0].display
        );
        assert_ne!(r.values[0].display, "45000");
    }

    #[test]
    fn a_fill_down_preview_shifts_the_references_rather_than_repeating_the_formula() {
        // THE case the shifter exists for: repeating the same text one row down
        // would report B1's answer three times. A1 must become A2, and the
        // ABSOLUTE anchor must not move.
        let mut request = req("=A1*B1", 0, 5);
        request.fill_down_rows = 2;
        let r = verify_with(&StyleRegistry::new(), &LocaleSettings::invariant(), &request);
        assert_eq!(r.values.len(), 3, "the target plus two filled rows");
        assert_eq!(r.values[0].display, "10000", "5000 * 2");
        assert_eq!(r.values[1].row, 1);
        assert_eq!(r.values[1].display, "28800", "7200 * 4");
        assert_eq!(r.values[2].display, "24800", "3100 * 8");

        let mut absolute = req("=$A$1*B1", 0, 5);
        absolute.fill_down_rows = 1;
        let a = verify_with(&StyleRegistry::new(), &LocaleSettings::invariant(), &absolute);
        assert_eq!(a.values[1].display, "20000", "$A$1 stays put: 5000 * 4");
    }

    #[test]
    fn the_fill_down_count_is_clamped_and_never_rejected() {
        let mut request = req("=A1", 0, 5);
        request.fill_down_rows = 50;
        let r = verify_with(&StyleRegistry::new(), &LocaleSettings::invariant(), &request);
        assert_eq!(r.values.len(), (MAX_FILL_DOWN_ROWS + 1) as usize);
        assert_eq!(r.verdict, "verified");
    }

    #[test]
    fn a_verified_verdict_requires_f2_with_no_error_severity_finding() {
        // The three ways a verdict can be reached, asserted together so the rule
        // cannot be half-changed.
        assert_eq!(verify("=SUM(A1:A3)", 0, 5).verdict, "verified");
        assert_eq!(verify("=SUM(A1:A3", 0, 5).verdict, "repair");
        assert_eq!(verify("=SUMM(A1:A3)", 0, 5).verdict, "repair");
        // And nothing that stops before F2 may claim "verified".
        for f in ["=SUM(A1:A3", "=SUMM(A1:A3)", "=FILEREAD(\"a\")"] {
            let r = verify(f, 0, 5);
            assert_ne!(r.rung, "f2", "{} must not reach F2", f);
            assert_ne!(r.verdict, "verified", "{}", f);
        }
    }

    #[test]
    fn a_decline_always_carries_its_reason_and_claims_no_value() {
        // A rung that cannot judge says so. The out-of-range sheet is the one
        // decline reachable without exhausting a real budget.
        let (grids, names) = sheet();
        let styles = StyleRegistry::new();
        let locale = LocaleSettings::invariant();
        let cancel = CancelToken::default();
        let r = verify_against(&grids, &names, 9, &styles, &locale, &cancel, &req("=A1", 0, 5));
        assert_eq!(r.verdict, "declined");
        assert!(r.decline_reason.is_some());
        assert!(r.values.is_empty(), "a decline claims nothing");
        assert_eq!(r.spill_rows, 0);
    }

    #[test]
    fn an_exhausted_budget_is_a_decline_and_not_a_repair() {
        // `#LIMIT!` says the MACHINE ran out, not that the formula is wrong.
        // Telling a user to rewrite a correct formula is worse than saying
        // nothing, so the mapping is pinned here even though provoking a real
        // exhaustion needs a pathological workbook.
        assert!(is_error_severity(FINDING_PARSE_ERROR));
        assert!(!is_error_severity(FINDING_VOLATILE));
        let declined_report = declined(
            "=A1".into(),
            "=A1".into(),
            false,
            "f2",
            "budget".into(),
            Vec::new(),
            Vec::new(),
        );
        assert_eq!(declined_report.verdict, "declined");
        assert_ne!(declined_report.verdict, "repair");
        assert_eq!(CellError::Limit.as_literal(), "#LIMIT!");
    }

    #[test]
    fn the_wire_shape_is_camel_case_for_the_typescript_mirror() {
        let mut request = req("=SUM(A1:A3)", 0, 5);
        request.fill_down_rows = 1;
        let r = verify_with(&StyleRegistry::new(), &LocaleSettings::invariant(), &request);
        let v = serde_json::to_value(&r).unwrap();
        assert!(v["delocalizedFromLocale"].is_boolean());
        assert!(v["spillRows"].is_number());
        assert!(v["spillCols"].is_number());
        assert!(v["functionsUsed"].is_array());
        assert!(v.get("declineReason").is_some());
        assert_eq!(v["verdict"], serde_json::json!("verified"));
        assert_eq!(v["rung"], serde_json::json!("f2"));
        assert!(v["values"][0]["display"].is_string());

        // And the REQUEST deserializes from the camelCase the frontend sends,
        // with `fillDownRows` optional.
        let parsed: FormulaVerifyRequest = serde_json::from_value(serde_json::json!({
            "formula": "=A1",
            "sheetIndex": 0,
            "row": 3,
            "col": 4
        }))
        .expect("the wire shape must deserialize");
        assert_eq!(parsed.fill_down_rows, 0);
        assert_eq!(parsed.row, 3);
    }
}
