//! FILENAME: core/script-engine/src/lib.rs
//! PURPOSE: Public API for the Calcula script engine.
//! CONTEXT: Provides `ScriptEngine::run()` / `run_with_options()` as the entry
//! points for executing scripts in an embedded QuickJS runtime.
//! The engine operates on a ScriptContext (cloned from AppState, plus the live
//! HostState the host feeds in) and returns a ScriptResult with the outcome and
//! any modified grid data. Every runtime is created under ScriptLimits — see
//! limits.rs — so a runaway script aborts instead of wedging its thread.

pub mod display;
pub mod limits;
pub mod manifest;
pub mod model_provider;
pub mod notebook;
pub mod ops;
pub mod runtime;
pub mod types;

use std::time::Instant;

use engine::grid::Grid;
use engine::style::StyleRegistry;

/// Everything a one-off run needs beyond the grid data itself: the live host
/// state the `Calcula.*` getters answer from, application metadata, the
/// bookmark blobs, and the runtime safety limits.
///
/// `Default` is the "no host state available" profile (engine defaults +
/// one-off limits) — what `ScriptEngine::run` uses.
#[derive(Debug, Clone)]
pub struct ScriptRunOptions {
    /// Application metadata (version, locale separators, calculation mode).
    pub app_info: types::AppInfo,
    /// Live workbook/view state (zoom, named styles, iteration settings, ...).
    pub host_state: types::HostState,
    /// Serialized cell bookmarks JSON.
    pub cell_bookmarks_json: String,
    /// Serialized view bookmarks JSON.
    pub view_bookmarks_json: String,
    /// Memory / stack / wall-clock ceilings enforced on the runtime.
    pub limits: limits::ScriptLimits,
}

impl Default for ScriptRunOptions {
    fn default() -> Self {
        ScriptRunOptions {
            app_info: types::AppInfo::default(),
            host_state: types::HostState::default(),
            cell_bookmarks_json: "[]".to_string(),
            view_bookmarks_json: "[]".to_string(),
            limits: limits::ScriptLimits::default(),
        }
    }
}

/// The main script engine. Stateless - each execution creates a fresh QuickJS runtime.
pub struct ScriptEngine;

impl ScriptEngine {
    /// Execute a JavaScript source string against spreadsheet data with
    /// DEFAULT options (no host state, one-off limits).
    ///
    /// # Arguments
    /// * `source` - The script source code (JavaScript)
    /// * `filename` - Display name for error messages
    /// * `grids` - Cloned grid data (one per sheet)
    /// * `style_registry` - Cloned style registry
    /// * `sheet_names` - Sheet names
    /// * `active_sheet` - Active sheet index
    ///
    /// # Returns
    /// A tuple of (ScriptResult, modified_grids) where modified_grids contains
    /// the grids after script execution (with any changes the script made).
    pub fn run(
        source: &str,
        filename: &str,
        grids: Vec<Grid>,
        style_registry: StyleRegistry,
        sheet_names: Vec<String>,
        active_sheet: usize,
    ) -> (ScriptResult, Vec<Grid>) {
        Self::run_with_options(
            source,
            filename,
            grids,
            style_registry,
            sheet_names,
            active_sheet,
            ScriptRunOptions::default(),
        )
    }

    /// Execute a script with host-supplied state: application info, live
    /// workbook/view state, bookmark context, and runtime limits.
    pub fn run_with_options(
        source: &str,
        filename: &str,
        grids: Vec<Grid>,
        style_registry: StyleRegistry,
        sheet_names: Vec<String>,
        active_sheet: usize,
        options: ScriptRunOptions,
    ) -> (ScriptResult, Vec<Grid>) {
        let start = Instant::now();

        let context = types::ScriptContext::new(
            grids,
            style_registry,
            sheet_names,
            active_sheet,
            options.app_info,
            options.host_state,
        )
        .with_bookmarks(options.cell_bookmarks_json, options.view_bookmarks_json);

        match runtime::execute_script(source, filename, context, options.limits) {
            Ok(outcome) => {
                let duration_ms = start.elapsed().as_millis() as u64;
                let ctx = outcome.context;
                let output = ctx.console_output.borrow().clone();
                // A script error still reports what the script managed to print
                // before it failed — including a timeout abort, where the
                // partial output is the only clue about where it got stuck.
                if let Some(message) = outcome.error {
                    return (types::ScriptResult::Error { message, output }, Vec::new());
                }
                let cells_modified = *ctx.cells_modified.borrow();
                let bookmark_mutations = ctx.bookmark_mutations.borrow().clone();
                let deferred_actions = ctx.deferred_actions.borrow().clone();
                let workbook_properties_changed = ctx.workbook_properties_changed.borrow().clone();
                let screen_updating = *ctx.screen_updating.borrow();
                let grids = ctx.grids;
                let result = types::ScriptResult::Success {
                    output,
                    cells_modified,
                    duration_ms,
                    bookmark_mutations,
                    deferred_actions,
                    workbook_properties_changed,
                    screen_updating,
                };
                (result, grids)
            }
            Err(msg) => {
                let result = types::ScriptResult::Error {
                    message: msg,
                    output: Vec::new(),
                };
                (result, Vec::new())
            }
        }
    }
}

// Re-export key types for consumers
pub use limits::{
    ScriptLimits, DEFAULT_MEMORY_BYTES, DEFAULT_NOTEBOOK_TIMEOUT_MS, DEFAULT_ONE_OFF_TIMEOUT_MS,
};
pub use model_provider::{
    ModelColumnRef, ModelDataProvider, ModelFilterSpec, ModelProviderError,
    ModelProviderErrorKind, ModelQuerySpec, ModelTable,
};
pub use notebook::{CellRunInput, NotebookSession};
pub use types::{AppInfo, HostState, ScriptContext, ScriptMeta, ScriptOutputItem, ScriptResult};

// ---------------------------------------------------------------------------
// Tests (the one-off entry point; the notebook session is covered in notebook.rs)
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::{ScriptEngine, ScriptRunOptions};
    use crate::limits::ScriptLimits;
    use crate::types::{HostState, ScriptResult};
    use engine::grid::Grid;
    use engine::style::StyleRegistry;

    fn run(src: &str, options: ScriptRunOptions) -> (ScriptResult, Vec<Grid>) {
        ScriptEngine::run_with_options(
            src,
            "test.js",
            vec![Grid::new()],
            StyleRegistry::new(),
            vec!["Sheet1".to_string()],
            0,
            options,
        )
    }

    /// A tight budget aborts a runaway loop with the budget message instead of
    /// blocking the calling (UI) thread forever.
    #[test]
    fn one_off_runaway_loop_hits_the_time_budget() {
        let options = ScriptRunOptions {
            limits: ScriptLimits::with_timeout_ms(150),
            ..ScriptRunOptions::default()
        };
        let started = std::time::Instant::now();
        let (result, _) = run("while (true) {}", options);
        match result {
            ScriptResult::Error { message, .. } => assert!(
                message.contains("exceeded its time budget"),
                "unexpected message: {}",
                message
            ),
            other => panic!("expected a timeout error, got {:?}", other),
        }
        assert!(started.elapsed() < std::time::Duration::from_secs(10));
    }

    /// The limits do not get in the way of ordinary work.
    #[test]
    fn one_off_normal_script_still_succeeds_under_limits() {
        let options = ScriptRunOptions {
            limits: ScriptLimits::with_timeout_ms(2_000),
            ..ScriptRunOptions::default()
        };
        let (result, grids) = run(
            "var total = 0; for (var i = 0; i < 5000; i++) { total += i; } \
             Calcula.setCellValue(0, 0, String(total)); Calcula.log('ok');",
            options,
        );
        match result {
            ScriptResult::Success { output, cells_modified, .. } => {
                assert_eq!(output.last().map(|i| i.to_text()).as_deref(), Some("ok"));
                assert_eq!(cells_modified, 1);
            }
            other => panic!("expected success, got {:?}", other),
        }
        assert_eq!(
            crate::types::cell_value_to_string(&grids[0].get_cell(0, 0).unwrap().value),
            "12497500"
        );
    }

    /// Host state reaches the one-off surface too (it used to answer 1.0 / []
    /// no matter what the app held).
    #[test]
    fn one_off_reads_host_state() {
        let mut host = HostState::default();
        host.zoom = 0.8;
        host.named_style_names = vec!["Total".to_string()];
        host.view_mode = "pageBreakPreview".to_string();
        let options = ScriptRunOptions {
            host_state: host,
            ..ScriptRunOptions::default()
        };
        let (result, _) = run(
            "Calcula.log(Calcula.getZoom() + '|' + Calcula.getViewMode() + '|' + Calcula.getNamedStyles());",
            options,
        );
        match result {
            ScriptResult::Success { output, .. } => assert_eq!(
                output.last().map(|i| i.to_text()).as_deref(),
                Some(r#"0.8|pageBreakPreview|["Total"]"#)
            ),
            other => panic!("expected success, got {:?}", other),
        }
    }

    /// Workbook-property writes come back on the result so the host can persist
    /// them; they used to die with the discarded context clone.
    #[test]
    fn one_off_surfaces_workbook_property_writes() {
        let (result, _) = run(
            "Calcula.setWorkbookProperty('author', 'Daniel'); \
             Calcula.setWorkbookProperty('category', 'Finance');",
            ScriptRunOptions::default(),
        );
        match result {
            ScriptResult::Success { workbook_properties_changed, .. } => {
                assert_eq!(workbook_properties_changed.len(), 2);
                assert_eq!(
                    workbook_properties_changed.get("author").map(String::as_str),
                    Some("Daniel")
                );
                assert_eq!(
                    workbook_properties_changed.get("category").map(String::as_str),
                    Some("Finance")
                );
            }
            other => panic!("expected success, got {:?}", other),
        }
    }

    /// setRange counts effective changes: writing a block over itself is zero
    /// modifications, so the audit number matches what a diff would find.
    #[test]
    fn set_range_counts_effective_changes_only() {
        let (first, grids) = run(
            r#"Calcula.setRange(0, 0, JSON.stringify([["a","b"],["c","d"]]));"#,
            ScriptRunOptions::default(),
        );
        match first {
            ScriptResult::Success { cells_modified, .. } => assert_eq!(cells_modified, 4),
            other => panic!("expected success, got {:?}", other),
        }

        let (second, _) = ScriptEngine::run_with_options(
            r#"Calcula.setRange(0, 0, JSON.stringify([["a","b"],["c","ZZZ"]]));"#,
            "test.js",
            grids,
            StyleRegistry::new(),
            vec!["Sheet1".to_string()],
            0,
            ScriptRunOptions::default(),
        );
        match second {
            ScriptResult::Success { cells_modified, .. } => {
                assert_eq!(cells_modified, 1, "only D1 actually changed")
            }
            other => panic!("expected success, got {:?}", other),
        }
    }

    /// Overwriting a FORMULA with a literal of the same displayed value still
    /// counts: the script write drops the AST, which is a real change.
    #[test]
    fn overwriting_a_formula_counts_even_when_the_value_matches() {
        use engine::cell::Cell;
        let mut grid = Grid::new();
        grid.set_cell(0, 0, Cell::new_formula("1+1".to_string()));
        // Cache the value the formula would produce.
        if let Some(cell) = grid.cells.get_mut(&(0, 0)) {
            cell.value = engine::cell::CellValue::Number(2.0);
        }
        let (result, _) = ScriptEngine::run_with_options(
            "Calcula.setCellValue(0, 0, '2');",
            "test.js",
            vec![grid],
            StyleRegistry::new(),
            vec!["Sheet1".to_string()],
            0,
            ScriptRunOptions::default(),
        );
        match result {
            ScriptResult::Success { cells_modified, .. } => assert_eq!(cells_modified, 1),
            other => panic!("expected success, got {:?}", other),
        }
    }

    /// Switching sheets must reach the HOST, not just retarget the script's own
    /// writes: the context is discarded after the run, so `setActiveSheet` used
    /// to leave the user staring at the sheet they started on.
    #[test]
    fn switching_sheets_queues_an_activation_for_the_host() {
        let (result, _) = ScriptEngine::run_with_options(
            "Calcula.setActiveSheet(2); Calcula.previousSheet(); Calcula.nextSheet();",
            "test.js",
            vec![Grid::new(), Grid::new(), Grid::new()],
            StyleRegistry::new(),
            vec!["Sheet1".to_string(), "Sheet2".to_string(), "Sheet3".to_string()],
            0,
            ScriptRunOptions::default(),
        );
        match result {
            ScriptResult::Success { deferred_actions, .. } => {
                let indexes: Vec<usize> = deferred_actions
                    .iter()
                    .filter_map(|a| match a {
                        crate::types::DeferredAction::ActivateSheet { sheet_index } => {
                            Some(*sheet_index)
                        }
                        _ => None,
                    })
                    .collect();
                assert_eq!(indexes, vec![2, 1, 2], "one activation per switch, in order");
            }
            other => panic!("expected success, got {:?}", other),
        }
    }

    /// An out-of-range sheet index is ignored entirely — no retarget, no queued
    /// activation the host would have to reject.
    #[test]
    fn an_out_of_range_sheet_switch_queues_nothing() {
        let (result, _) = run("Calcula.setActiveSheet(7);", ScriptRunOptions::default());
        match result {
            ScriptResult::Success { deferred_actions, .. } => {
                assert!(deferred_actions.is_empty(), "{:?}", deferred_actions)
            }
            other => panic!("expected success, got {:?}", other),
        }
    }

    /// GOLDEN RULE: every struct-variant FIELD crosses the IPC boundary
    /// camelCased. The container `rename_all` only renames variant NAMES, so
    /// this fails the moment a per-variant `rename_all` is dropped.
    #[test]
    fn deferred_actions_and_bookmark_mutations_are_camel_case_on_the_wire() {
        use crate::types::{BookmarkMutation, DeferredAction};

        let actions = vec![
            DeferredAction::Goto { row: 1, col: 2, sheet_index: 3, select: true },
            DeferredAction::ActivateSheet { sheet_index: 4 },
            DeferredAction::FillDown { start_row: 1, start_col: 2, end_row: 3, end_col: 4 },
            DeferredAction::FillRight { start_row: 1, start_col: 2, end_row: 3, end_col: 4 },
            DeferredAction::SetIterationSettings {
                enabled: true,
                max_iterations: 50,
                max_change: 0.5,
            },
            DeferredAction::SetSheetVisibility {
                sheet_index: 2,
                visibility: "hidden".to_string(),
            },
        ];
        let json = serde_json::to_string(&actions).unwrap();
        for camel in [
            "sheetIndex",
            "startRow",
            "startCol",
            "endRow",
            "endCol",
            "maxIterations",
            "maxChange",
        ] {
            assert!(json.contains(camel), "missing {} in {}", camel, json);
        }
        for snake in [
            "sheet_index",
            "start_row",
            "start_col",
            "end_row",
            "end_col",
            "max_iterations",
            "max_change",
        ] {
            assert!(!json.contains(snake), "leaked {} in {}", snake, json);
        }

        let mutations = vec![
            BookmarkMutation::AddCellBookmark {
                row: 0,
                col: 0,
                sheet_index: 1,
                label: None,
                color: None,
            },
            BookmarkMutation::CreateViewBookmark {
                label: "v".to_string(),
                color: None,
                dimensions_json: Some("{}".to_string()),
            },
        ];
        let json = serde_json::to_string(&mutations).unwrap();
        assert!(json.contains("sheetIndex"), "{}", json);
        assert!(json.contains("dimensionsJson"), "{}", json);
        assert!(!json.contains("sheet_index"), "{}", json);
        assert!(!json.contains("dimensions_json"), "{}", json);
    }
}
