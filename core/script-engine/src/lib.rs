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
        host.zoom = 80.0;
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
                Some(r#"80|pageBreakPreview|["Total"]"#)
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

    /// An out-of-range sheet switch THROWS — it used to be silently ignored,
    /// which left every following write landing on the WRONG sheet. Nothing is
    /// queued for the host to reject.
    #[test]
    fn an_out_of_range_sheet_switch_throws_and_queues_nothing() {
        let (result, _) = run("Calcula.setActiveSheet(7);", ScriptRunOptions::default());
        match result {
            ScriptResult::Error { message, .. } => {
                assert!(message.contains("out of range"), "{}", message)
            }
            other => panic!("expected an error, got {:?}", other),
        }
    }

    /// GOLDEN RULE: every struct-variant FIELD crosses the IPC boundary
    /// camelCased. The container `rename_all` only renames variant NAMES, so
    /// this fails the moment a per-variant `rename_all` is dropped.
    #[test]
    fn deferred_actions_and_bookmark_mutations_are_camel_case_on_the_wire() {
        use crate::types::{BookmarkMutation, DeferredAction};

        let actions = vec![
            DeferredAction::Goto {
                row: 1,
                col: 2,
                end_row: Some(3),
                end_col: Some(4),
                sheet_index: 3,
                select: true,
            },
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

    // -- application.goto: numeric + A1 forms --------------------------------

    use crate::types::DeferredAction;
    use engine::cell::{Cell, CellValue};

    fn text_cell(text: &str) -> Cell {
        Cell {
            ast: None,
            value: CellValue::Text(text.to_string()),
            style_index: 0,
            rich_text: None,
        }
    }

    fn run_two_sheets(src: &str, grids: Vec<Grid>) -> (ScriptResult, Vec<Grid>) {
        ScriptEngine::run_with_options(
            src,
            "test.js",
            grids,
            StyleRegistry::new(),
            vec!["Sheet1".to_string(), "Sheet2".to_string()],
            0,
            ScriptRunOptions::default(),
        )
    }

    fn deferred(result: ScriptResult) -> Vec<DeferredAction> {
        match result {
            ScriptResult::Success { deferred_actions, .. } => deferred_actions,
            other => panic!("expected success, got {:?}", other),
        }
    }

    #[test]
    fn goto_numeric_form_queues_a_single_cell_goto() {
        let (result, _) = run_two_sheets(
            "Calcula.application.goto(4, 5, 'Sheet2');",
            vec![Grid::new(), Grid::new()],
        );
        assert_eq!(
            deferred(result),
            vec![DeferredAction::Goto {
                row: 4,
                col: 5,
                end_row: None,
                end_col: None,
                sheet_index: 1,
                select: true,
            }]
        );
    }

    #[test]
    fn goto_a1_form_queues_a_range_goto_with_sheet_prefix() {
        let (result, _) = run_two_sheets(
            "Calcula.application.goto('Sheet2!B2:C5'); Calcula.application.goto('B3');",
            vec![Grid::new(), Grid::new()],
        );
        assert_eq!(
            deferred(result),
            vec![
                DeferredAction::Goto {
                    row: 1,
                    col: 1,
                    end_row: Some(4),
                    end_col: Some(2),
                    sheet_index: 1,
                    select: true,
                },
                // Single-cell address: end fields stay None, active sheet.
                DeferredAction::Goto {
                    row: 2,
                    col: 1,
                    end_row: None,
                    end_col: None,
                    sheet_index: 0,
                    select: true,
                },
            ]
        );
    }

    #[test]
    fn goto_a1_form_rejects_extra_arguments_and_bad_sheets() {
        let (result, _) = run_two_sheets(
            r#"
            var msgs = [];
            try { Calcula.application.goto('A1', 1); msgs.push('extra-ok'); }
            catch (e) { msgs.push('extra-threw'); }
            try { Calcula.application.goto('Nope!A1'); msgs.push('sheet-ok'); }
            catch (e) { msgs.push('sheet-threw:' + (e.message.indexOf('Nope') >= 0)); }
            Calcula.log(msgs.join(','));
            "#,
            vec![Grid::new(), Grid::new()],
        );
        match result {
            ScriptResult::Success { output, deferred_actions, .. } => {
                assert_eq!(
                    output.last().map(|i| i.to_text()).as_deref(),
                    Some("extra-threw,sheet-threw:true")
                );
                assert!(deferred_actions.is_empty(), "nothing may be queued");
            }
            other => panic!("expected success, got {:?}", other),
        }
    }

    // -- getRangeEdge / getCurrentRegion / getUsedRange ops: parity with the
    //    shared engine::navigation implementation the Tauri commands call ----

    /// A grid with a block at A1:D1 and a lone cell at G1.
    fn edge_fixture() -> Grid {
        let mut g = Grid::new();
        for (c, t) in ["a", "b", "c", "d"].iter().enumerate() {
            g.set_cell(0, c as u32, text_cell(t));
        }
        g.set_cell(0, 6, text_cell("g"));
        g
    }

    #[test]
    fn get_range_edge_op_matches_engine_navigation() {
        let grid = edge_fixture();
        let cases: Vec<(u32, u32, &str)> =
            vec![(0, 0, "right"), (0, 3, "right"), (0, 6, "left"), (0, 20, "left"), (5, 0, "up")];
        let expected: Vec<(u32, u32)> = cases
            .iter()
            .map(|&(r, c, d)| {
                engine::navigation::range_edge(
                    &grid,
                    r,
                    c,
                    engine::navigation::EdgeDirection::parse(d).unwrap(),
                    engine::navigation::EXCEL_MAX_ROW_INDEX,
                    engine::navigation::EXCEL_MAX_COL_INDEX,
                )
            })
            .collect();
        let src = format!(
            r#"
            var cases = {};
            var out = [];
            for (var i = 0; i < cases.length; i++) {{
                var res = JSON.parse(Calcula.getRangeEdge(cases[i][0], cases[i][1], cases[i][2]));
                out.push([res.row, res.col]);
            }}
            Calcula.log(JSON.stringify(out));
            "#,
            serde_json::json!(cases
                .iter()
                .map(|&(r, c, d)| (r, c, d.to_string()))
                .collect::<Vec<_>>())
        );
        let (result, _) = run_two_sheets(&src, vec![grid, Grid::new()]);
        match result {
            ScriptResult::Success { output, .. } => {
                let logged = output.last().map(|i| i.to_text()).unwrap_or_default();
                let got: Vec<(u32, u32)> = serde_json::from_str(&logged).unwrap();
                assert_eq!(got, expected, "op answers must equal engine::navigation");
            }
            other => panic!("expected success, got {:?}", other),
        }
    }

    #[test]
    fn get_range_edge_op_rejects_a_bad_direction() {
        let (result, _) = run_two_sheets(
            r#"
            try { Calcula.getRangeEdge(0, 0, 'sideways'); Calcula.log('no-throw'); }
            catch (e) { Calcula.log('threw:' + (e.message.indexOf('sideways') >= 0)); }
            "#,
            vec![Grid::new(), Grid::new()],
        );
        match result {
            ScriptResult::Success { output, .. } => assert_eq!(
                output.last().map(|i| i.to_text()).as_deref(),
                Some("threw:true")
            ),
            other => panic!("expected success, got {:?}", other),
        }
    }

    #[test]
    fn get_current_region_op_matches_engine_navigation_and_takes_a_sheet() {
        // Block at B2:C4 on Sheet2; Sheet1 stays empty.
        let mut sheet2 = Grid::new();
        for r in 1..=3 {
            for c in 1..=2 {
                sheet2.set_cell(r, c, text_cell("x"));
            }
        }
        let expected = engine::navigation::current_region(&sheet2, 2, 2).unwrap();
        let (result, _) = run_two_sheets(
            r#"
            var hit = JSON.parse(Calcula.getCurrentRegion(2, 2, 'Sheet2'));
            var miss = JSON.parse(Calcula.getCurrentRegion(50, 50, 1));
            var active = JSON.parse(Calcula.getCurrentRegion(0, 0));
            Calcula.log(JSON.stringify([hit, miss, active.empty]));
            "#,
            vec![Grid::new(), sheet2],
        );
        match result {
            ScriptResult::Success { output, .. } => {
                let logged = output.last().map(|i| i.to_text()).unwrap_or_default();
                let parsed: serde_json::Value = serde_json::from_str(&logged).unwrap();
                let hit = &parsed[0];
                assert_eq!(hit["startRow"].as_u64().unwrap() as u32, expected.0);
                assert_eq!(hit["startCol"].as_u64().unwrap() as u32, expected.1);
                assert_eq!(hit["endRow"].as_u64().unwrap() as u32, expected.2);
                assert_eq!(hit["endCol"].as_u64().unwrap() as u32, expected.3);
                assert_eq!(hit["empty"].as_bool(), Some(false));
                // Isolated empty cell: collapsed box + empty flag.
                let miss = &parsed[1];
                assert_eq!(miss["empty"].as_bool(), Some(true));
                assert_eq!(miss["startRow"].as_u64(), Some(50));
                // Active sheet (Sheet1) is empty at A1.
                assert_eq!(parsed[2].as_bool(), Some(true));
            }
            other => panic!("expected success, got {:?}", other),
        }
    }

    #[test]
    fn get_used_range_op_takes_a_sheet_arg() {
        let mut sheet2 = Grid::new();
        sheet2.set_cell(2, 3, text_cell("a"));
        sheet2.set_cell(7, 1, text_cell("b"));
        let (result, _) = run_two_sheets(
            r#"
            var byName = JSON.parse(Calcula.getUsedRange('Sheet2'));
            var byIndex = JSON.parse(Calcula.getUsedRange(1));
            var active = JSON.parse(Calcula.getUsedRange());
            Calcula.log(JSON.stringify([byName, byIndex.startCol, active.empty]));
            "#,
            vec![Grid::new(), sheet2],
        );
        match result {
            ScriptResult::Success { output, .. } => {
                let logged = output.last().map(|i| i.to_text()).unwrap_or_default();
                let parsed: serde_json::Value = serde_json::from_str(&logged).unwrap();
                assert_eq!(parsed[0]["startRow"].as_u64(), Some(2));
                assert_eq!(parsed[0]["startCol"].as_u64(), Some(1));
                assert_eq!(parsed[0]["endRow"].as_u64(), Some(7));
                assert_eq!(parsed[0]["endCol"].as_u64(), Some(3));
                assert_eq!(parsed[0]["empty"].as_bool(), Some(false));
                assert_eq!(parsed[1].as_u64(), Some(1), "index arg = name arg");
                assert_eq!(parsed[2].as_bool(), Some(true), "active sheet is empty");
            }
            other => panic!("expected success, got {:?}", other),
        }
    }

    #[test]
    fn get_used_range_op_rejects_an_unknown_sheet() {
        let (result, _) = run_two_sheets(
            r#"
            try { Calcula.getUsedRange('Nope'); Calcula.log('no-throw'); }
            catch (e) { Calcula.log('threw:' + (e.message.indexOf('Nope') >= 0)); }
            "#,
            vec![Grid::new(), Grid::new()],
        );
        match result {
            ScriptResult::Success { output, .. } => assert_eq!(
                output.last().map(|i| i.to_text()).as_deref(),
                Some("threw:true")
            ),
            other => panic!("expected success, got {:?}", other),
        }
    }

    // -----------------------------------------------------------------------
    // Wave 4: zoom-as-percent, strict view mode, displayFormulas,
    // ranged applyNamedStyle
    // -----------------------------------------------------------------------

    /// setZoom takes a REAL percent, getZoom answers the same number, and the
    /// deferred action carries it out unchanged — the factor/percent
    /// split-brain is gone in both directions.
    #[test]
    fn zoom_is_a_real_percent_end_to_end() {
        let (result, _) = run(
            "Calcula.setZoom(150); Calcula.log(String(Calcula.getZoom()));",
            ScriptRunOptions::default(),
        );
        match result {
            ScriptResult::Success { output, deferred_actions, .. } => {
                assert_eq!(output.last().map(|i| i.to_text()).as_deref(), Some("150"));
                assert!(
                    deferred_actions.iter().any(|a| matches!(
                        a,
                        crate::types::DeferredAction::SetZoom { percent } if *percent == 150.0
                    )),
                    "SetZoom must carry the percent verbatim: {:?}",
                    deferred_actions
                );
            }
            other => panic!("expected success, got {:?}", other),
        }
    }

    /// Out-of-range zoom THROWS and queues nothing — 1.0 (the old factor form)
    /// is now an invalid percent, which is exactly what catches un-migrated
    /// callers.
    #[test]
    fn zoom_outside_10_to_400_throws() {
        for bad in ["1.0", "9.9", "400.5", "0", "-25", "NaN"] {
            let (result, _) = run(
                &format!(
                    "try {{ Calcula.setZoom({}); Calcula.log('no-throw'); }} \
                     catch (e) {{ Calcula.log('threw:' + (e.message.indexOf('Invalid zoom') >= 0)); }}",
                    bad
                ),
                ScriptRunOptions::default(),
            );
            match result {
                ScriptResult::Success { output, deferred_actions, .. } => {
                    assert_eq!(
                        output.last().map(|i| i.to_text()).as_deref(),
                        Some("threw:true"),
                        "setZoom({}) must throw",
                        bad
                    );
                    assert!(
                        deferred_actions.is_empty(),
                        "a rejected zoom must queue nothing: {:?}",
                        deferred_actions
                    );
                }
                other => panic!("expected success, got {:?}", other),
            }
        }
    }

    /// Boundary percents are accepted (the range is inclusive).
    #[test]
    fn zoom_bounds_are_inclusive() {
        let (result, _) = run(
            "Calcula.setZoom(10); Calcula.setZoom(400); Calcula.log(String(Calcula.getZoom()));",
            ScriptRunOptions::default(),
        );
        match result {
            ScriptResult::Success { output, deferred_actions, .. } => {
                assert_eq!(output.last().map(|i| i.to_text()).as_deref(), Some("400"));
                assert_eq!(deferred_actions.len(), 2);
            }
            other => panic!("expected success, got {:?}", other),
        }
    }

    /// setViewMode accepts exactly the three Core view modes and THROWS on
    /// anything else instead of shipping a silent no-op to the frontend.
    #[test]
    fn view_mode_is_strictly_validated() {
        let (result, _) = run(
            r#"
            Calcula.setViewMode('pageLayout');
            var ok = Calcula.getViewMode();
            var threw = false;
            try { Calcula.setViewMode('slideshow'); }
            catch (e) { threw = e.message.indexOf('Invalid view mode') >= 0; }
            Calcula.log(ok + '|' + threw + '|' + Calcula.getViewMode());
            "#,
            ScriptRunOptions::default(),
        );
        match result {
            ScriptResult::Success { output, deferred_actions, .. } => {
                assert_eq!(
                    output.last().map(|i| i.to_text()).as_deref(),
                    Some("pageLayout|true|pageLayout"),
                    "the rejected mode must not stick"
                );
                let modes: Vec<&String> = deferred_actions
                    .iter()
                    .filter_map(|a| match a {
                        crate::types::DeferredAction::SetViewMode { mode } => Some(mode),
                        _ => None,
                    })
                    .collect();
                assert_eq!(modes, vec!["pageLayout"], "only the valid mode is queued");
            }
            other => panic!("expected success, got {:?}", other),
        }
    }

    /// displayFormulas: read-back defaults to false, the setter round-trips and
    /// queues the deferred toggle for the host.
    #[test]
    fn display_formulas_round_trips() {
        let (result, _) = run(
            "var before = Calcula.getDisplayFormulas(); \
             Calcula.setDisplayFormulas(true); \
             Calcula.log(before + '|' + Calcula.getDisplayFormulas());",
            ScriptRunOptions::default(),
        );
        match result {
            ScriptResult::Success { output, deferred_actions, .. } => {
                assert_eq!(
                    output.last().map(|i| i.to_text()).as_deref(),
                    Some("false|true")
                );
                assert!(deferred_actions.iter().any(|a| matches!(
                    a,
                    crate::types::DeferredAction::SetDisplayFormulas { value: true }
                )));
            }
            other => panic!("expected success, got {:?}", other),
        }
    }

    /// applyNamedStyle: the single-cell form queues no range corner, the
    /// four-corner form queues the inclusive rect, and a half-rect THROWS.
    #[test]
    fn apply_named_style_takes_an_optional_range() {
        let (result, _) = run(
            r#"
            Calcula.applyNamedStyle('Total', 1, 2);
            Calcula.applyNamedStyle('Good', 1, 1, 3, 4);
            var threw = false;
            try { Calcula.applyNamedStyle('Bad', 0, 0, 5); }
            catch (e) { threw = e.message.indexOf('together') >= 0; }
            Calcula.log(String(threw));
            "#,
            ScriptRunOptions::default(),
        );
        match result {
            ScriptResult::Success { output, deferred_actions, .. } => {
                assert_eq!(output.last().map(|i| i.to_text()).as_deref(), Some("true"));
                let styles: Vec<_> = deferred_actions
                    .iter()
                    .filter_map(|a| match a {
                        crate::types::DeferredAction::ApplyNamedStyle {
                            name,
                            row,
                            col,
                            end_row,
                            end_col,
                        } => Some((name.as_str(), *row, *col, *end_row, *end_col)),
                        _ => None,
                    })
                    .collect();
                assert_eq!(
                    styles,
                    vec![
                        ("Total", 1, 2, None, None),
                        ("Good", 1, 1, Some(3), Some(4)),
                    ],
                    "the half-rect call must queue NOTHING"
                );
            }
            other => panic!("expected success, got {:?}", other),
        }
    }
}
