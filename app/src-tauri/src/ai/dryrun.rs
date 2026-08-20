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
#[tauri::command]
pub async fn ai_dry_run_script(
    handle: tauri::AppHandle,
    code: String,
    window: tauri::Window,
) -> Result<DryRunReport, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;

    let run = crate::mcp::tools::run_script_isolated(&handle, &code).await?;

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
        let report = build_report(true, None, 12, vec![], vec![]);
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
        );
        assert_eq!(
            report.changes.iter().map(|c| (c.row, c.col)).collect::<Vec<_>>(),
            vec![(0, 1), (0, 2), (3, 1)],
        );
        assert!(report.changed_anything());
    }

    #[test]
    fn a_cleared_cell_is_a_change_with_an_empty_after() {
        let report = build_report(true, None, 1, vec![change(0, 0, "99", "")], vec![]);
        assert_eq!(report.changes[0].before, "99");
        assert_eq!(report.changes[0].after, "");
        assert!(report.changed_anything(), "clearing a cell IS doing something");
    }

    #[test]
    fn a_huge_diff_is_capped_but_the_count_is_not() {
        // The list is for a human; the COUNT must stay honest or a reviewer is
        // told a 10,000-cell rewrite touches 200.
        let many: Vec<CellChange> = (0..1000).map(|r| change(r, 0, "", "x")).collect();
        let report = build_report(true, None, 40, many, vec![]);
        assert!(report.truncated);
        assert_eq!(report.changes.len(), MAX_REPORTED_CHANGES);
        assert_eq!(report.total_changes, 1000);
        assert!(report.summary().contains("1000 cells"));
        assert!(report.summary().contains("showing the first 200"));
    }

    #[test]
    fn a_failing_script_reports_its_error_and_not_a_change_count() {
        let report = build_report(false, Some("TypeError: x is not a function".into()), 3, vec![], vec![]);
        assert!(!report.ok);
        assert!(report.summary().contains("failed when run against a copy"));
        assert!(report.summary().contains("TypeError"));
    }

    #[test]
    fn one_change_is_singular() {
        let report = build_report(true, None, 1, vec![change(0, 0, "", "hi")], vec![]);
        assert_eq!(report.summary(), "The script would change 1 cell.");
    }

    #[test]
    fn the_wire_shape_is_camel_case_for_the_typescript_mirror() {
        let report = build_report(true, None, 7, vec![change(1, 2, "a", "b")], vec!["logged".into()]);
        let v = serde_json::to_value(&report).unwrap();
        assert_eq!(v["totalChanges"], serde_json::json!(1));
        assert_eq!(v["durationMs"], serde_json::json!(7));
        assert_eq!(v["changes"][0]["before"], serde_json::json!("a"));
        assert_eq!(v["output"][0], serde_json::json!("logged"));
    }
}
