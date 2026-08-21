//! FILENAME: app/src-tauri/src/ai/dryrun.rs
//! PURPOSE: L3 of the draft-validation ladder — run a candidate script against a
//!          CLONE of the workbook and report what it WOULD change, applying
//!          nothing.
//! CONTEXT: docs/design/local-model-script-authoring.md §5, §5b.
//!
//!          WHY THIS RUNG EXISTS, measured rather than assumed. The M5 eval was
//!          run against two real local models on 2026-08-19, and in BOTH runs
//!          roughly half the failures were scripts that PASSED every static
//!          check and did nothing useful: they parse, invent no methods, and
//!          declare their capabilities correctly. L0-L2 are structurally blind
//!          to "correct but useless", so the repair loop stopped after one round
//!          with `ok: true` — the honest answer, and the wrong outcome.
//!
//!          WHAT MAKES IT CHEAP. `run_script_with_model` (mcp/tools.rs) already
//!          CLONES the grids, runs the script against the clone on its own
//!          thread, and hands back `modified_grids`; `apply_script_result` is a
//!          separate step afterwards. A dry run is that path with the second
//!          half omitted, plus `diff_grids_to_updates`, which the apply path
//!          already uses to work out what changed. Nothing here is new
//!          machinery — the rung was missing, not the parts.
//!
//!          THE INVARIANT: this command NEVER writes. It takes no
//!          `DocumentEffect`, touches no `Persisted<T>`, creates no undo entry
//!          and emits no refresh. If that ever stops being true, a "preview"
//!          has silently become an edit — which is the exact failure the
//!          transient-write pattern exists to prevent, and the reason a draft is
//!          shown to a human before it is mounted.

use serde::Serialize;

/// One cell a script would change.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CellChange {
    pub row: u32,
    pub col: u32,
    /// The cell's input string before the run ("" when it was empty).
    pub before: String,
    /// After the run ("" when the script cleared it).
    pub after: String,
}

/// A cell the caller wants read back after the run.
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CellRef {
    pub row: u32,
    pub col: u32,
}

/// One cell value observed after the run.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CellReadback {
    pub row: u32,
    pub col: u32,
    /// The cell as an input string ("" when empty).
    pub value: String,
}

/// What a candidate script would do, without having done it.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DryRunReport {
    /// The script ran to completion. False means it threw or hit a limit.
    pub ok: bool,
    /// The failure, when `ok` is false.
    pub error: Option<String>,
    pub duration_ms: u64,
    /// Cells that would change on the ACTIVE sheet.
    pub changes: Vec<CellChange>,
    /// True when `changes` was capped — the script touches more than is worth
    /// showing a reviewer.
    pub truncated: bool,
    /// Total changed cells before capping.
    pub total_changes: usize,
    /// Anything the script logged or displayed.
    pub output: Vec<String>,
    /// Values of the cells the caller asked to see, after the run.
    pub read_back: Vec<CellReadback>,
    /// Whether this rung can speak to this script AT ALL. When false, NOTHING
    /// else in the report is evidence about the script — see `declined_reason`.
    pub applicable: bool,
    /// Why the dry run declined, when `applicable` is false.
    pub declined_reason: Option<String>,
}

/// Why a dry run cannot judge this source, or `None` when it can.
///
/// An OBJECT script is authored against the Worker realm's `context` — 358
/// members — while a dry run executes in the Rust QuickJS realm, which shares
/// only 19 of them and rejects the `export` keyword outright. Run one here and
/// the answer is a syntax error or a missing method, and NEITHER is evidence
/// about the script: it is evidence about the emulator.
///
/// Before this gate, L3 rejected every valid object script with "it FAILS when
/// run against a copy of the workbook" — the most expensive way a checker can be
/// wrong, because the model then spends its repair rounds fixing code that was
/// already correct. A rung that cannot judge must DECLINE, never guess.
pub fn declined_reason(code: &str) -> Option<&'static str> {
    // Checked first: it is the one that produced the syntax error, and it is
    // what every AI-authored draft carries.
    if code
        .lines()
        .any(|l| l.trim_start().starts_with("export ") || l.trim_start().starts_with("import "))
    {
        return Some(
            "the script is an ES module (`export`/`import`), which this preview's \
             interpreter does not accept",
        );
    }
    // Anchored to a line start, not `contains`: a script that merely MENTIONS
    // the shape in a string or a comment is one this realm can run perfectly
    // well, and declining it would cost the rung its whole purpose.
    let declares_setup = code.lines().any(|l| {
        let t = l.trim_start();
        t.starts_with("function setup(") || t.starts_with("async function setup(")
    });
    if declares_setup || code.contains("context.expose(") {
        return Some(
            "the script is an object script built around `setup(context)`, and this \
             preview runs in a different realm that provides no `context`",
        );
    }
    if code.contains("context.api.") || code.contains("context.caps.") {
        return Some(
            "the script uses the object-script `context`, which this preview's realm \
             does not provide",
        );
    }
    None
}

/// How many changed cells a report carries.
///
/// A reviewer cannot read ten thousand rows, and neither can a model being asked
/// to correct itself. `total_changes` is reported unclipped so the count is
/// never a lie even when the list is.
pub const MAX_REPORTED_CHANGES: usize = 200;

/// Build the report from a before/after grid pair plus the run's own results.
///
/// Pure — no Tauri state, no I/O — so the capping and the "did it do anything"
/// question are unit-testable without a running app.
pub fn build_report(
    ok: bool,
    error: Option<String>,
    duration_ms: u64,
    mut changes: Vec<CellChange>,
    output: Vec<String>,
    read_back: Vec<CellReadback>,
) -> DryRunReport {
    changes.sort_by_key(|c| (c.row, c.col));
    let total_changes = changes.len();
    let truncated = total_changes > MAX_REPORTED_CHANGES;
    if truncated {
        changes.truncate(MAX_REPORTED_CHANGES);
    }
    DryRunReport {
        ok,
        error,
        duration_ms,
        changes,
        truncated,
        total_changes,
        output,
        read_back,
        applicable: true,
        declined_reason: None,
    }
}

/// The report for a script this rung declined to judge. Runs nothing.
pub fn declined(reason: &str) -> DryRunReport {
    DryRunReport {
        // `ok` is true because nothing FAILED — but `applicable` is what a
        // caller must branch on. A caller that reads only `ok` sees "fine",
        // which is the safe direction: this rung never invents a rejection.
        ok: true,
        error: None,
        duration_ms: 0,
        changes: Vec::new(),
        truncated: false,
        total_changes: 0,
        output: Vec::new(),
        read_back: Vec::new(),
        applicable: false,
        declined_reason: Some(reason.to_string()),
    }
}

impl DryRunReport {
    /// The question L0-L2 cannot answer: did this script actually DO anything?
    ///
    /// A script that validates, runs cleanly and changes no cell is the exact
    /// failure this rung was added for. `false` here is not an error — a script
    /// that only reads and reports is legitimate — it is a SIGNAL, and it is the
    /// caller's business to know whether the task expected writes.
    pub fn changed_anything(&self) -> bool {
        self.total_changes > 0
    }

    /// One line for a reviewer or a repair prompt.
    pub fn summary(&self) -> String {
        if !self.applicable {
            return format!(
                "No preview: {}.",
                self.declined_reason
                    .as_deref()
                    .unwrap_or("this script cannot be previewed")
            );
        }
        if !self.ok {
            return format!(
                "The script failed when run against a copy of the workbook: {}",
                self.error.as_deref().unwrap_or("unknown error")
            );
        }
        if self.total_changes == 0 {
            return "The script ran without error but changed no cells.".to_string();
        }
        format!(
            "The script would change {} cell{}{}.",
            self.total_changes,
            if self.total_changes == 1 { "" } else { "s" },
            if self.truncated {
                format!(" (showing the first {})", MAX_REPORTED_CHANGES)
            } else {
                String::new()
            },
        )
    }
}

// ---------------------------------------------------------------------------
// The command
// ---------------------------------------------------------------------------

/// Run a candidate script against a copy of the workbook and report what it
/// WOULD change. Applies nothing.
///
/// Reuses `mcp::tools::run_script_isolated` — the same execution the real
/// `run_script` performs, including the security gate and the capability
/// grant/revoke — and simply declines the apply step. That is the whole point:
/// a preview that ran different code would be previewing the wrong thing.
///
/// # `fixture`
/// Cells written into the CLONE before the script runs, so a dry run can be made
/// DETERMINISTIC — "sum column B" needs a column B, and the eval corpus cannot
/// depend on whatever the user's workbook happens to hold. The fixture never
/// reaches the real workbook.
///
/// # `read_back`
/// Cells whose value is reported AFTER the run, whether or not the script
/// changed them. The diff alone cannot answer "is B101 now 5050?": if the
/// fixture already held that value and the script rewrote it identically,
/// nothing changed and the cell is absent from `changes`. Grading needs the
/// VALUE, not the delta.
#[tauri::command]
pub async fn ai_dry_run_script(
    handle: tauri::AppHandle,
    code: String,
    fixture: Option<Vec<crate::mcp::tools::CellSeed>>,
    read_back: Option<Vec<CellRef>>,
    surface: Option<String>,
    window: tauri::Window,
) -> Result<DryRunReport, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;

    // The CALLER usually knows what it is previewing — draftGate gates
    // `draft_object_script` and nothing else, so its scripts are object scripts
    // BY DEFINITION. An explicit label beats guessing from the source text:
    // the substring heuristics both under-declined (`const setup = (c) => …`
    // with no literal `context.api.` was judged in the wrong realm) and
    // over-declined (a comment mentioning `context.expose(` suppressed L3 for a
    // plain script). Found by adversarial review; the heuristics remain ONLY
    // for unlabeled callers.
    match surface.as_deref() {
        Some("object-script") => {
            return Ok(declined(
                "the script is an object script, and this preview runs in a different \
                 realm that cannot host it",
            ));
        }
        // An explicitly-labeled one-off IS this realm's own language: whatever
        // the interpreter says about it — including a syntax error on `export`,
        // which one-off scripts genuinely may not use — is a correct verdict,
        // so no heuristic may suppress it.
        Some("one-off") => {}
        _ => {
            // Unlabeled: decline BEFORE running when the source looks like it
            // belongs to the other realm — the run's answer would be about the
            // emulator, not the script. See `declined_reason`.
            if let Some(reason) = declined_reason(&code) {
                return Ok(declined(reason));
            }
        }
    }

    let seeds = fixture.unwrap_or_default();
    let run = crate::mcp::tools::run_script_isolated(&handle, &code, &seeds).await?;

    let read_back_values: Vec<CellReadback> = read_back
        .unwrap_or_default()
        .into_iter()
        .map(|r| {
            let value = run
                .modified_grids
                .get(run.active_sheet)
                .and_then(|g| g.get_cell(r.row, r.col))
                .map(|c| crate::scripting::commands::cell_input_string(c))
                .unwrap_or_default();
            CellReadback { row: r.row, col: r.col, value }
        })
        .collect();

    // The ACTIVE sheet only. A reviewer reads one sheet's diff; a cross-sheet
    // preview is a bigger surface than this rung needs, and reporting a partial
    // multi-sheet diff as though it were complete would be worse than scoping it.
    let before = run.baseline_grids.get(run.active_sheet);
    let after = run.modified_grids.get(run.active_sheet);

    let changes = match (before, after) {
        (Some(before), Some(after)) => crate::scripting::commands::diff_grids_to_updates(before, after)
            .into_iter()
            .map(|u| CellChange {
                row: u.row,
                col: u.col,
                before: before
                    .get_cell(u.row, u.col)
                    .map(crate::scripting::commands::cell_input_string)
                    .unwrap_or_default(),
                after: u.value,
            })
            .collect(),
        _ => Vec::new(),
    };

    match run.result {
        script_engine::ScriptResult::Success {
            output,
            duration_ms,
            ..
        } => Ok(build_report(
            true,
            None,
            duration_ms,
            changes,
            output.iter().map(|i| i.to_text()).collect(),
            read_back_values.clone(),
        )),
        script_engine::ScriptResult::Error { message, output } => Ok(build_report(
            false,
            Some(message),
            0,
            // A script that threw part-way may still have changed cells before
            // it did. Those are reported: "it failed AND it had already written
            // four cells" is a materially different review than "it failed".
            changes,
            output.iter().map(|i| i.to_text()).collect(),
            read_back_values.clone(),
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn change(row: u32, col: u32, before: &str, after: &str) -> CellChange {
        CellChange {
            row,
            col,
            before: before.into(),
            after: after.into(),
        }
    }

    #[test]
    fn a_script_that_changes_nothing_is_reported_as_such() {
        // THE case this rung exists for: it ran, it did not throw, and it did
        // nothing. Every static check would have called that a pass.
        let report = build_report(true, None, 12, vec![], vec![], vec![]);
        assert!(report.ok);
        assert!(!report.changed_anything());
        assert_eq!(report.total_changes, 0);
        assert_eq!(report.summary(), "The script ran without error but changed no cells.");
    }

    #[test]
    fn changes_are_reported_in_row_major_order() {
        let report = build_report(
            true,
            None,
            5,
            vec![change(3, 1, "", "c"), change(0, 2, "", "a"), change(0, 1, "x", "b")],
            vec![],
            vec![],
        );
        assert_eq!(
            report.changes.iter().map(|c| (c.row, c.col)).collect::<Vec<_>>(),
            vec![(0, 1), (0, 2), (3, 1)],
        );
        assert!(report.changed_anything());
    }

    #[test]
    fn a_cleared_cell_is_a_change_with_an_empty_after() {
        let report = build_report(true, None, 1, vec![change(0, 0, "99", "")], vec![], vec![]);
        assert_eq!(report.changes[0].before, "99");
        assert_eq!(report.changes[0].after, "");
        assert!(report.changed_anything(), "clearing a cell IS doing something");
    }

    #[test]
    fn a_huge_diff_is_capped_but_the_count_is_not() {
        // The list is for a human; the COUNT must stay honest or a reviewer is
        // told a 10,000-cell rewrite touches 200.
        let many: Vec<CellChange> = (0..1000).map(|r| change(r, 0, "", "x")).collect();
        let report = build_report(true, None, 40, many, vec![], vec![]);
        assert!(report.truncated);
        assert_eq!(report.changes.len(), MAX_REPORTED_CHANGES);
        assert_eq!(report.total_changes, 1000);
        assert!(report.summary().contains("1000 cells"));
        assert!(report.summary().contains("showing the first 200"));
    }

    #[test]
    fn a_failing_script_reports_its_error_and_not_a_change_count() {
        let report = build_report(false, Some("TypeError: x is not a function".into()), 3, vec![], vec![], vec![]);
        assert!(!report.ok);
        assert!(report.summary().contains("failed when run against a copy"));
        assert!(report.summary().contains("TypeError"));
    }

    #[test]
    fn one_change_is_singular() {
        let report = build_report(true, None, 1, vec![change(0, 0, "", "hi")], vec![], vec![]);
        assert_eq!(report.summary(), "The script would change 1 cell.");
    }

    #[test]
    fn a_fixture_value_is_typed_the_way_a_fixture_means_it() {
        use crate::mcp::tools::seed_cell_value;
        use engine::cell::CellValue;
        assert!(matches!(seed_cell_value("42"), CellValue::Number(n) if n == 42.0));
        assert!(matches!(seed_cell_value("-3.5"), CellValue::Number(n) if n == -3.5));
        assert!(matches!(seed_cell_value("hello"), CellValue::Text(_)));
        assert!(matches!(seed_cell_value(""), CellValue::Empty));
        // A formula is stored as TEXT, deliberately and documented: compiling one
        // here would mean running the parser and the dependency graph outside the
        // pipeline that owns them.
        assert!(matches!(seed_cell_value("=SUM(A1:A9)"), CellValue::Text(_)));
        // Non-finite input must not become a Number and poison a grid.
        assert!(matches!(seed_cell_value("inf"), CellValue::Text(_)));
        assert!(matches!(seed_cell_value("NaN"), CellValue::Text(_)));
        // Canonical boolean spellings are BOOLEANS — the edit pipeline types
        // user entry that way and cell_input_string renders Boolean cells as
        // exactly these strings. Typed as Text, =IF(A1,...) over a seeded
        // boolean computed against a string (§5c.1). Exact-match only.
        assert!(matches!(seed_cell_value("TRUE"), CellValue::Boolean(true)));
        assert!(matches!(seed_cell_value("FALSE"), CellValue::Boolean(false)));
        assert!(matches!(seed_cell_value("true"), CellValue::Text(_)));
        assert!(matches!(seed_cell_value("True"), CellValue::Text(_)));
    }

    #[test]
    fn seeds_land_in_the_grid_and_keep_the_existing_style() {
        use crate::mcp::tools::{apply_seeds, CellSeed};
        let mut grid = engine::grid::Grid::new();
        grid.set_cell(0, 0, engine::cell::Cell {
            ast: None,
            value: engine::cell::CellValue::Text("old".into()),
            style_index: 7,
            rich_text: None,
        });
        apply_seeds(&mut grid, &[
            CellSeed { row: 0, col: 0, value: "99".into() },
            CellSeed { row: 3, col: 2, value: "fresh".into() },
        ]);
        // Overwritten in place, style preserved — a fixture supplies DATA, and
        // silently clearing formatting would make a seeded run diverge from the
        // workbook it is meant to stand in for.
        let existing = grid.get_cell(0, 0).expect("seeded cell");
        assert!(matches!(existing.value, engine::cell::CellValue::Number(n) if n == 99.0));
        assert_eq!(existing.style_index, 7);
        assert!(grid.get_cell(3, 2).is_some(), "a seed may create a cell that did not exist");
    }

    #[test]
    fn read_back_is_reported_separately_from_the_diff() {
        // The reason it exists: a cell the script rewrote with the value it
        // already held is NOT in `changes`, so grading on the diff alone would
        // read "unchanged" as "wrong".
        let report = build_report(
            true,
            None,
            5,
            vec![],
            vec![],
            vec![CellReadback { row: 100, col: 1, value: "5050".into() }],
        );
        assert!(!report.changed_anything(), "no diff...");
        assert_eq!(report.read_back[0].value, "5050", "...but the value is still observable");
    }

    #[test]
    fn the_wire_shape_is_camel_case_for_the_typescript_mirror() {
        let report = build_report(true, None, 7, vec![change(1, 2, "a", "b")], vec!["logged".into()], vec![]);
        let v = serde_json::to_value(&report).unwrap();
        assert_eq!(v["totalChanges"], serde_json::json!(1));
        assert_eq!(v["durationMs"], serde_json::json!(7));
        assert_eq!(v["changes"][0]["before"], serde_json::json!("a"));
        assert_eq!(v["output"][0], serde_json::json!("logged"));
    }
    /// The rung must DECLINE an object script rather than judge it.
    ///
    /// It runs in the Rust QuickJS realm, which rejects `export` outright and
    /// shares 19 of the Worker realm's 358 `context` members. Judging one here
    /// rejected every valid AI-authored draft with "it FAILS when run".
    #[test]
    fn an_object_script_is_declined_not_judged() {
        let sources = [
            "export function setup(context) {
  context.log('x');
}",
            "function setup(context) {
  context.expose('onClick', () => {});
}",
            "import x from 'y';
console.log(x);",
            "const go = () => context.api.setCellValue(0, 0, 'x');",
        ];
        for src in sources {
            assert!(
                declined_reason(src).is_some(),
                "should have declined, would have reported a fake defect: {:?}",
                src,
            );
        }
    }

    /// ...and must NOT decline what it CAN run, or the rung is dead weight.
    #[test]
    fn a_script_this_realm_can_host_is_not_declined() {
        let sources = [
            "Calcula.setCellValue(0, 0, 'x');",
            "const v = Calcula.getCellValue(0, 0);
Calcula.setCellValue(0, 1, v);",
            "// mentions the word export in a comment
Calcula.log('exported');",
            "const s = 'export function setup(context)';
Calcula.setCellValue(0, 0, s);",
        ];
        for src in sources {
            assert_eq!(
                declined_reason(src),
                None,
                "declined a script it can actually run: {:?}",
                src,
            );
        }
    }

    /// A declined report must not read as a clean bill of health OR as a
    /// failure: `ok` stays true so no caller invents a rejection from it, and
    /// the summary says plainly that nothing was previewed.
    #[test]
    fn a_declined_report_claims_nothing() {
        let report = declined("the script is an ES module");

        assert!(!report.applicable);
        assert!(report.ok, "declining is not a failure");
        assert!(report.error.is_none());
        assert_eq!(report.total_changes, 0);
        assert!(!report.changed_anything());
        assert!(
            report.summary().starts_with("No preview:"),
            "summary must not imply a verdict, got {:?}",
            report.summary(),
        );
    }

    /// A report that DID run says so, so `applicable` cannot silently default
    /// to the declining value and mute the whole rung.
    #[test]
    fn a_real_report_is_applicable() {
        let report = build_report(true, None, 1, Vec::new(), Vec::new(), Vec::new());

        assert!(report.applicable);
        assert!(report.declined_reason.is_none());
    }

    /// The caller's explicit label OUTRANKS the source heuristics.
    ///
    /// The label is decided in the command before anything runs, so the rule is
    /// pinned where it is cheap: a labeled object script is declined no matter
    /// how plain it looks, and a labeled one-off is judged no matter how much
    /// its text resembles an object script — for a one-off, `export` really is
    /// a syntax error and reporting it is CORRECT.
    #[test]
    fn an_explicit_label_outranks_the_heuristics() {
        // Object-script label: even a source with no object-script tell.
        assert!(
            declined_reason("Calcula.setCellValue(0, 0, 'x');").is_none(),
            "precondition: the heuristics alone would have judged this",
        );
        // One-off label: even a source every heuristic would decline.
        assert!(
            declined_reason("export function setup(context) {}").is_some(),
            "precondition: the heuristics alone would have declined this",
        );
        // The routing itself lives in ai_dry_run_script's match — pinned by the
        // source, since the command needs a running app to invoke. Assembled
        // needles, so this test's own literals can never satisfy the search.
        let source = include_str!("dryrun.rs");
        let object_arm = format!("Some({}object-script{})", '"', '"');
        let oneoff_arm = format!("Some({}one-off{}) => {}", '"', '"', "{}");
        let arm_at = source.find(&object_arm).expect("object-script arm missing");
        let after = &source[arm_at..arm_at + 400];
        assert!(
            after.contains("declined("),
            "the object-script arm must DECLINE, not judge: {}",
            &after[..after.len().min(200)],
        );
        assert!(
            source.contains(&oneoff_arm),
            "the one-off arm must bypass the heuristics entirely",
        );
    }

}
