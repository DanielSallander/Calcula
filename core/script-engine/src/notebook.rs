//! FILENAME: core/script-engine/src/notebook.rs
//! PURPOSE: Persistent QuickJS runtime for notebook-style multi-cell execution.
//! CONTEXT: Unlike ScriptEngine::run() which creates and destroys a runtime per
//! execution, NotebookSession keeps the runtime alive so JavaScript variables
//! persist across cell executions (like Jupyter notebooks).

use rquickjs::{Context, Function, Object, Runtime, Value};
use std::cell::RefCell;
use std::rc::Rc;
use std::time::Instant;

use engine::grid::Grid;
use engine::style::StyleRegistry;

use crate::limits::{self, Deadline, ScriptLimits};
use crate::ops;
use crate::types::{AppInfo, HostState, ScriptContext, ScriptResult};

/// Everything the host feeds into ONE cell run.
///
/// The workbook data AND the live host state are re-supplied on every run: a
/// notebook session outlives any single cell, so the locale, calculation mode,
/// named styles and view state it sees must be re-read each time or the session
/// answers with whatever was true when it was created.
pub struct CellRunInput {
    /// Cloned grids (one per sheet) for this run.
    pub grids: Vec<Grid>,
    /// Cloned style registry for this run.
    pub style_registry: StyleRegistry,
    /// Sheet names for this run.
    pub sheet_names: Vec<String>,
    /// Active sheet index.
    pub active_sheet: usize,
    /// Script-surface id attributing provider calls ("notebook:nb-123").
    pub surface_id: String,
    /// Application metadata (version, locale separators, calculation mode).
    pub app_info: AppInfo,
    /// Live workbook/view state backing the `Calcula.*` getters.
    pub host_state: HostState,
}

impl CellRunInput {
    /// A minimal input carrying only workbook data — application metadata and
    /// host state fall back to engine defaults. For tests and for hosts that
    /// have no state to feed.
    pub fn new(
        grids: Vec<Grid>,
        style_registry: StyleRegistry,
        sheet_names: Vec<String>,
        active_sheet: usize,
        surface_id: impl Into<String>,
    ) -> Self {
        CellRunInput {
            grids,
            style_registry,
            sheet_names,
            active_sheet,
            surface_id: surface_id.into(),
            app_info: AppInfo::default(),
            host_state: HostState::default(),
        }
    }
}

/// A persistent notebook session that keeps the QuickJS runtime alive
/// across multiple cell executions. JavaScript variables defined in one
/// cell are visible in subsequent cells.
///
/// # Thread Safety
/// QuickJS Runtime is `!Send` and `!Sync`. The NotebookSession must be
/// used from a single thread. In the Tauri command layer, use
/// `tokio::task::spawn_blocking` or a dedicated thread.
pub struct NotebookSession {
    /// The QuickJS runtime — kept alive for the session lifetime.
    /// Not directly read, but must outlive `context` (drop order matters).
    #[allow(dead_code)]
    runtime: Runtime,
    /// The QuickJS context — global JS scope lives here.
    context: Context,
    /// Shared script context accessible by registered Calcula.* closures.
    /// Before each cell execution, the inner ScriptContext is replaced with
    /// fresh grid data. After execution, modified grids are extracted.
    shared_ctx: Rc<RefCell<ScriptContext>>,
    /// Wall-clock deadline shared with the runtime's interrupt handler. The
    /// handler is installed once for the session; this is RE-ARMED per cell so
    /// the budget is per EXECUTION, not per session.
    deadline: Rc<Deadline>,
    /// Limits profile in force for this session (notebook profile by default).
    limits: ScriptLimits,
}

impl NotebookSession {
    /// Create a new notebook session with an initialized QuickJS runtime.
    ///
    /// The runtime is set up with Calcula.* and console.* APIs, and with the
    /// memory/stack ceilings + interrupt handler from `limits`. The initial
    /// ScriptContext is seeded from `initial`, and replaced before each cell
    /// execution. `model_provider` (host-injected) enables the read-only
    /// `model.*` API; None leaves it raising a clear "not available" error.
    pub fn new(
        model_provider: Option<Rc<dyn crate::model_provider::ModelDataProvider>>,
        limits: ScriptLimits,
        initial: CellRunInput,
    ) -> Result<Self, String> {
        let runtime = Runtime::new()
            .map_err(|e| format!("Failed to create QuickJS runtime: {}", e))?;
        // Ceilings + interrupt handler installed before any code runs. The
        // deadline starts disarmed; run_cell arms it per execution.
        let deadline = limits::install(&runtime, limits);
        let context = Context::full(&runtime)
            .map_err(|e| format!("Failed to create QuickJS context: {}", e))?;

        let mut initial_ctx = ScriptContext::new(
            initial.grids,
            initial.style_registry,
            initial.sheet_names,
            initial.active_sheet,
            initial.app_info,
            initial.host_state,
        )
        .with_model_provider(model_provider);
        initial_ctx.surface_id = initial.surface_id;

        let shared_ctx = Rc::new(RefCell::new(initial_ctx));

        // Register Calcula.* and console.* APIs in the JS global scope.
        // These closures capture the shared_ctx Rc and will survive across
        // cell executions since the context is never dropped.
        context.with(|ctx| -> Result<(), String> {
            let globals = ctx.globals();
            register_calcula_api(&ctx, &globals, shared_ctx.clone())?;
            register_console(&ctx, &globals, shared_ctx.clone())?;
            crate::display::register_display(&ctx, &globals, shared_ctx.clone())?;
            crate::ops::model::register_model_ops(&ctx, &globals, shared_ctx.clone())?;
            Ok(())
        })?;

        Ok(NotebookSession {
            runtime,
            context,
            shared_ctx,
            deadline,
            limits,
        })
    }

    /// Execute a single notebook cell.
    ///
    /// Before execution the shared ScriptContext is refreshed from `input`:
    /// grid data (so the cell sees the current spreadsheet state) AND the live
    /// host state + application info (so a locale, calculation-mode or named-
    /// style change made mid-session is picked up on the very next cell). After
    /// execution the modified grids are extracted and returned.
    ///
    /// JavaScript global variables from previous cells remain accessible.
    pub fn run_cell(&self, source: &str, input: CellRunInput) -> (ScriptResult, Vec<Grid>) {
        let start = Instant::now();

        // Swap in fresh grid data + host state for this cell execution
        {
            let mut ctx = self.shared_ctx.borrow_mut();
            ctx.grids = input.grids;
            ctx.style_registry = input.style_registry;
            ctx.sheet_names = input.sheet_names;
            ctx.active_sheet = input.active_sheet;
            ctx.surface_id = input.surface_id;
            ctx.app_info = input.app_info;
            ctx.host = input.host_state;
            // Reset per-cell counters
            *ctx.console_output.borrow_mut() = Vec::new();
            *ctx.cells_modified.borrow_mut() = 0;
            *ctx.deferred_actions.borrow_mut() = Vec::new();
            *ctx.bookmark_mutations.borrow_mut() = Vec::new();
            *ctx.workbook_properties_changed.borrow_mut() = std::collections::HashMap::new();
        }

        // Execute the cell source in the persistent JS context, under a FRESH
        // wall-clock budget (the session is long-lived; the budget is not).
        // Like a REPL / Jupyter notebook, the value of the last expression is
        // captured and displayed as output (unless it is undefined).
        self.deadline.arm(self.limits.timeout_ms);
        let eval_result = self
            .context
            .with(|ctx| -> Result<Option<crate::types::ScriptOutputItem>, String> {
            let result: rquickjs::Result<Value> = ctx.eval(source);
            match result {
                Ok(val) => {
                    let repr = value_to_display_item(&ctx, &val);
                    Ok(repr)
                }
                Err(e) => Err(crate::runtime::describe_error(&ctx, e, &self.deadline)),
            }
        });
        self.deadline.disarm();

        let duration_ms = start.elapsed().as_millis() as u64;

        match eval_result {
            Ok(last_value) => {
                let ctx = self.shared_ctx.borrow();
                let mut output = ctx.console_output.borrow().clone();
                // Append the last expression value (REPL-style), like Jupyter's Out[N]
                if let Some(item) = last_value {
                    output.push(item);
                }
                let cells_modified = *ctx.cells_modified.borrow();
                let grids = ctx.grids.clone();
                let bookmark_mutations = ctx.bookmark_mutations.borrow().clone();
                let deferred_actions = ctx.deferred_actions.borrow().clone();
                let workbook_properties_changed = ctx.workbook_properties_changed.borrow().clone();
                let screen_updating = *ctx.screen_updating.borrow();
                let result = ScriptResult::Success {
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
                // On error, still return partial output and current grids
                let ctx = self.shared_ctx.borrow();
                let output = ctx.console_output.borrow().clone();
                let grids = ctx.grids.clone();
                let result = ScriptResult::Error {
                    message: msg,
                    output,
                };
                (result, grids)
            }
        }
    }
}

// ============================================================================
// API Registration (mirrors runtime.rs but for notebook sessions)
// ============================================================================

/// Register the `Calcula` global object with all spreadsheet API methods.
fn register_calcula_api<'js>(
    ctx: &rquickjs::Ctx<'js>,
    globals: &Object<'js>,
    shared_ctx: Rc<RefCell<ScriptContext>>,
) -> Result<(), String> {
    let calcula = Object::new(ctx.clone())
        .map_err(|e| format!("Failed to create Calcula object: {}", e))?;

    ops::cells::register_cell_ops(ctx, &calcula, shared_ctx.clone())?;
    ops::sheets::register_sheet_ops(ctx, &calcula, shared_ctx.clone())?;
    ops::utility::register_utility_ops(ctx, &calcula, shared_ctx.clone())?;
    // NOT registered here, deliberately: ops::bookmarks. Bookmarks are frontend
    // state owned by the CellBookmarks extension — the one-off surface only sees
    // them because `run_script`'s caller serializes its collections into the
    // request. The notebook host has no such caller (cells run from the
    // notebook panel), so `Calcula.bookmarks.list()` would answer "[]" and
    // every mutation would be dropped on the floor. An ABSENT API beats one
    // that silently does nothing; wiring it needs an @api bookmark accessor
    // first, then `bookmark_mutations` on NotebookCellResponse.
    ops::worksheet_props::register_worksheet_props_ops(ctx, &calcula, shared_ctx.clone())?;
    ops::extended::register_extended_ops(ctx, &calcula, shared_ctx.clone())?;

    // Canonical shared object model (Calcula.workbook -> Sheet -> Range).
    ops::canonical_model::register_canonical_model(ctx, &calcula, shared_ctx.clone())?;

    globals
        .set("Calcula", calcula)
        .map_err(|e| format!("Failed to set Calcula global: {}", e))?;

    // Application ops must be registered after Calcula is on globals
    // (the JS defineProperty snippet references Calcula.application)
    let calcula_ref: Object = globals
        .get("Calcula")
        .map_err(|e| format!("Failed to get Calcula global: {}", e))?;
    ops::application::register_application_ops(ctx, &calcula_ref, shared_ctx.clone())?;

    Ok(())
}

/// Convert a QuickJS Value to a display output item (REPL-style).
/// Returns `None` for `undefined` (so that statements like `let x = 1` don't
/// produce spurious output). Table-shaped objects (`{columns, rows}`, e.g.
/// future model-query results) render as Table items; other objects/arrays
/// as pretty-printed JSON text.
fn value_to_display_item<'js>(
    ctx: &rquickjs::Ctx<'js>,
    val: &Value<'js>,
) -> Option<crate::types::ScriptOutputItem> {
    use crate::types::ScriptOutputItem;

    if val.is_undefined() {
        return None;
    }
    if val.is_null() {
        return Some(ScriptOutputItem::text("null"));
    }
    if let Some(b) = val.as_bool() {
        return Some(ScriptOutputItem::text(if b { "true" } else { "false" }));
    }
    if let Some(n) = val.as_int() {
        return Some(ScriptOutputItem::text(n.to_string()));
    }
    if let Some(n) = val.as_float() {
        // Format like JS: no trailing ".0" for integers stored as f64
        if n.fract() == 0.0 && n.is_finite() {
            return Some(ScriptOutputItem::text(format!("{}", n as i64)));
        }
        return Some(ScriptOutputItem::text(format!("{}", n)));
    }
    if let Some(s) = val.as_string() {
        if let Ok(s) = s.to_string() {
            return Some(ScriptOutputItem::text(format!("\"{}\"", s)));
        }
    }
    // For objects/arrays, use JSON.stringify for a readable representation
    if val.is_object() {
        let json_stringify: rquickjs::Result<rquickjs::Function> = ctx
            .globals()
            .get::<_, Object>("JSON")
            .and_then(|json| json.get("stringify"));
        if let Ok(stringify) = json_stringify {
            // Compact stringify first: table-shape detection needs the JSON
            let compact: rquickjs::Result<Option<String>> =
                stringify.call((val.clone(),));
            if let Ok(Some(compact_json)) = compact {
                if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(&compact_json) {
                    if let Some(table) = crate::display::detect_table_shape(&parsed) {
                        return Some(table);
                    }
                }
            }
            // JSON.stringify(value, null, 2) for pretty-printing
            let result: rquickjs::Result<Option<String>> =
                stringify.call((val.clone(), Value::new_null(ctx.clone()), 2i32));
            if let Ok(Some(s)) = result {
                return Some(ScriptOutputItem::text(s));
            }
        }
    }
    // Fallback: show the type name
    Some(ScriptOutputItem::text(format!("[{}]", val.type_name())))
}

/// Register `console` global object with log/warn/error/info methods.
fn register_console<'js>(
    ctx: &rquickjs::Ctx<'js>,
    globals: &Object<'js>,
    shared_ctx: Rc<RefCell<ScriptContext>>,
) -> Result<(), String> {
    let console = Object::new(ctx.clone())
        .map_err(|e| format!("Failed to create console object: {}", e))?;

    let log_fn = {
        let ctx_ref = shared_ctx.clone();
        Function::new(ctx.clone(), move |args: rquickjs::function::Rest<String>| {
            let message = args.0.join(" ");
            ctx_ref
                .borrow()
                .console_output
                .borrow_mut()
                .push(crate::types::ScriptOutputItem::text(message));
        })
        .map_err(|e| format!("Failed to create console.log: {}", e))?
    };

    console
        .set("log", log_fn.clone())
        .map_err(|e| format!("Failed to set console.log: {}", e))?;
    console
        .set("warn", log_fn.clone())
        .map_err(|e| format!("Failed to set console.warn: {}", e))?;
    console
        .set("error", log_fn.clone())
        .map_err(|e| format!("Failed to set console.error: {}", e))?;
    console
        .set("info", log_fn)
        .map_err(|e| format!("Failed to set console.info: {}", e))?;

    globals
        .set("console", console)
        .map_err(|e| format!("Failed to set console global: {}", e))?;

    Ok(())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::{CellRunInput, NotebookSession};
    use crate::limits::ScriptLimits;
    use crate::model_provider::{
        ModelDataProvider, ModelProviderError, ModelProviderErrorKind, ModelQuerySpec, ModelTable,
    };
    use crate::types::{cell_value_to_string, AppInfo, HostState, ScriptOutputItem, ScriptResult};
    use engine::grid::Grid;
    use engine::style::StyleRegistry;
    use std::rc::Rc;

    fn fixture() -> (Vec<Grid>, StyleRegistry, Vec<String>) {
        (vec![Grid::new()], StyleRegistry::new(), vec!["Sheet1".to_string()])
    }

    /// A default cell input over the standard one-sheet fixture.
    fn input() -> CellRunInput {
        let (grids, reg, names) = fixture();
        CellRunInput::new(grids, reg, names, 0, "notebook:test-nb")
    }

    /// A session over the fixture with the given provider and notebook limits.
    fn session(provider: Option<Rc<dyn ModelDataProvider>>) -> NotebookSession {
        NotebookSession::new(provider, ScriptLimits::notebook(), input()).expect("session")
    }

    /// Canned provider: query returns a 2x2 table (with a null), value returns
    /// 42, and everything records the surface it was called with. `granted =
    /// false` simulates a missing capability grant (ConsentRequired).
    struct MockProvider {
        granted: bool,
        calls: std::cell::RefCell<Vec<String>>,
    }

    impl MockProvider {
        fn new(granted: bool) -> Self {
            MockProvider { granted, calls: std::cell::RefCell::new(Vec::new()) }
        }
        fn gate(&self, surface: &str, method: &str) -> Result<(), ModelProviderError> {
            self.calls.borrow_mut().push(format!("{}:{}", method, surface));
            if !self.granted {
                return Err(ModelProviderError::new(
                    ModelProviderErrorKind::ConsentRequired,
                    "bi.query",
                ));
            }
            Ok(())
        }
        fn table() -> ModelTable {
            ModelTable {
                columns: vec!["Country".to_string(), "Revenue".to_string()],
                rows: vec![
                    vec![Some("Sweden".to_string()), Some("100".to_string())],
                    vec![Some("Norway".to_string()), None],
                ],
                total_rows: 2,
                truncated: false,
            }
        }
    }

    impl ModelDataProvider for MockProvider {
        fn connections(&self, surface: &str) -> Result<String, ModelProviderError> {
            self.gate(surface, "connections")?;
            Ok(r#"[{"id":"c1","name":"Sales"}]"#.to_string())
        }
        fn model_info(&self, surface: &str, _c: &str) -> Result<String, ModelProviderError> {
            self.gate(surface, "info")?;
            Ok(r#"{"tables":[],"measures":[]}"#.to_string())
        }
        fn query(
            &self,
            surface: &str,
            _c: &str,
            _spec: &ModelQuerySpec,
        ) -> Result<ModelTable, ModelProviderError> {
            self.gate(surface, "query")?;
            Ok(Self::table())
        }
        fn sql(&self, surface: &str, _c: &str, _s: &str) -> Result<ModelTable, ModelProviderError> {
            self.gate(surface, "sql")?;
            Ok(Self::table())
        }
        fn cube_value(
            &self,
            surface: &str,
            _c: &str,
            _m: &[String],
        ) -> Result<Option<f64>, ModelProviderError> {
            self.gate(surface, "value")?;
            Ok(Some(42.0))
        }
        fn cube_members(
            &self,
            surface: &str,
            _c: &str,
            _l: &str,
        ) -> Result<Vec<String>, ModelProviderError> {
            self.gate(surface, "members")?;
            Ok(vec!["Sweden".to_string(), "Norway".to_string()])
        }
        fn cube_kpi(
            &self,
            surface: &str,
            _c: &str,
            _k: &str,
            _p: i64,
        ) -> Result<Option<f64>, ModelProviderError> {
            self.gate(surface, "kpi")?;
            Ok(None)
        }
    }

    fn run(session: &NotebookSession, src: &str) -> (ScriptResult, Vec<Grid>) {
        session.run_cell(src, input())
    }

    #[test]
    fn model_query_result_reaches_js_and_autorenders_as_table() {
        let provider = Rc::new(MockProvider::new(true));
        let session = session(Some(provider.clone()));

        let (result, _) = run(&session, "model.query('Sales', {measures: ['Revenue']})");
        match result {
            ScriptResult::Success { output, .. } => {
                assert_eq!(output.len(), 1, "one auto-rendered table: {:?}", output);
                match &output[0] {
                    ScriptOutputItem::Table { columns, rows, truncated, total_rows } => {
                        assert_eq!(columns, &vec!["Country".to_string(), "Revenue".to_string()]);
                        // null cell renders as ""
                        assert_eq!(rows[1], vec!["Norway".to_string(), String::new()]);
                        assert!(!truncated);
                        assert_eq!(*total_rows, 2);
                    }
                    other => panic!("expected table item, got {:?}", other),
                }
            }
            other => panic!("expected success, got {:?}", other),
        }
        // The surface id was threaded through to the provider.
        assert!(provider
            .calls
            .borrow()
            .iter()
            .any(|c| c == "query:notebook:test-nb"));
    }

    #[test]
    fn model_result_objects_and_togrid_mutate_cloned_grids() {
        let session = session(Some(Rc::new(MockProvider::new(true))));

        let (result, out_grids) = run(
            &session,
            "const r = model.sql('Sales', 'SELECT 1');\n\
             const objs = r.objects();\n\
             const extent = r.toGrid(0, 0);\n\
             console.log(objs[0].Country + '|' + extent.rows + 'x' + extent.cols);",
        );
        match result {
            ScriptResult::Success { output, cells_modified, .. } => {
                assert_eq!(
                    output.last().map(|i| i.to_text()),
                    Some("Sweden|3x2".to_string())
                );
                // header row (2) + 2 data rows x 2 cols, minus the null cell
                // (setCellValue with "" still counts as a write in the flat API).
                assert!(cells_modified > 0, "toGrid must count as grid mutation");
            }
            other => panic!("expected success, got {:?}", other),
        }
        // Values landed in the CLONED grid returned to the host.
        let cell = out_grids[0].get_cell(0, 0).expect("header cell");
        assert_eq!(cell_value_to_string(&cell.value), "Country");
        let cell = out_grids[0].get_cell(1, 0).expect("data cell");
        assert_eq!(cell_value_to_string(&cell.value), "Sweden");
    }

    #[test]
    fn consent_required_propagates_the_sentinel() {
        let session = session(Some(Rc::new(MockProvider::new(false))));

        let (result, _) = run(&session, "model.query('Sales', {measures: ['x']})");
        match result {
            ScriptResult::Error { message, .. } => {
                assert!(
                    message.contains("BI_CONSENT_REQUIRED capability=bi.query surface=notebook:test-nb"),
                    "sentinel missing: {}",
                    message
                );
            }
            other => panic!("expected error, got {:?}", other),
        }
    }

    #[test]
    fn absent_provider_gives_clear_surface_error() {
        let session = session(None);
        let (result, _) = run(&session, "model.connections()");
        match result {
            ScriptResult::Error { message, .. } => {
                assert!(
                    message.contains("Model API is not available on this surface"),
                    "unexpected: {}",
                    message
                );
            }
            other => panic!("expected error, got {:?}", other),
        }
    }

    #[test]
    fn cube_parity_helpers_round_trip() {
        let session = session(Some(Rc::new(MockProvider::new(true))));
        let (result, _) = run(
            &session,
            "model.value('Sales', '[Revenue]') + '|' + model.members('Sales', 'Geo[Country]').join(',') + '|' + model.kpi('Sales', 'Margin', 3)",
        );
        match result {
            ScriptResult::Success { output, .. } => {
                assert_eq!(
                    output.last().map(|i| i.to_text()),
                    Some("\"42|Sweden,Norway|null\"".to_string())
                );
            }
            other => panic!("expected success, got {:?}", other),
        }
    }

    // -----------------------------------------------------------------------
    // Runtime safety limits
    // -----------------------------------------------------------------------

    /// An infinite loop must be aborted by the wall-clock deadline with a clear
    /// message — not wedge the executor thread forever.
    #[test]
    fn runaway_loop_hits_the_time_budget() {
        let session = NotebookSession::new(None, ScriptLimits::with_timeout_ms(150), input())
            .expect("session");
        let started = std::time::Instant::now();
        let (result, _) = run(&session, "while (true) {}");
        match result {
            ScriptResult::Error { message, .. } => {
                assert!(
                    message.contains("exceeded its time budget"),
                    "unexpected message: {}",
                    message
                );
            }
            other => panic!("expected a timeout error, got {:?}", other),
        }
        assert!(
            started.elapsed() < std::time::Duration::from_secs(10),
            "the deadline did not actually stop the script"
        );
    }

    /// The budget is per CELL, not per session: after a cell is killed by the
    /// deadline, the session is still usable and the next cell gets a fresh
    /// budget (and JS globals from before the runaway cell survive).
    #[test]
    fn time_budget_is_rearmed_per_cell() {
        let session = NotebookSession::new(None, ScriptLimits::with_timeout_ms(150), input())
            .expect("session");
        let (ok, _) = run(&session, "var keep = 7; keep");
        assert!(matches!(ok, ScriptResult::Success { .. }), "setup cell: {:?}", ok);

        let (killed, _) = run(&session, "for (;;) {}");
        assert!(matches!(killed, ScriptResult::Error { .. }), "expected abort");

        let (after, _) = run(&session, "keep + 1");
        match after {
            ScriptResult::Success { output, .. } => {
                assert_eq!(output.last().map(|i| i.to_text()).as_deref(), Some("8"));
            }
            other => panic!("session unusable after a timeout: {:?}", other),
        }
    }

    /// Output printed before the runaway loop survives the abort — it is the
    /// only clue the user has about where the cell got stuck.
    #[test]
    fn partial_output_survives_a_timeout() {
        let session = NotebookSession::new(None, ScriptLimits::with_timeout_ms(150), input())
            .expect("session");
        let (result, _) = run(&session, "console.log('before the loop'); while (true) {}");
        match result {
            ScriptResult::Error { output, .. } => {
                assert_eq!(
                    output.first().map(|i| i.to_text()).as_deref(),
                    Some("before the loop")
                );
            }
            other => panic!("expected error, got {:?}", other),
        }
    }

    /// A runaway allocation trips the heap ceiling instead of consuming all
    /// available memory. The deadline is a backstop so the test cannot hang.
    #[test]
    fn allocation_bomb_hits_the_memory_limit() {
        let limits = ScriptLimits {
            timeout_ms: 10_000,
            memory_bytes: 16 * 1024 * 1024,
            ..ScriptLimits::default()
        };
        let session = NotebookSession::new(None, limits, input()).expect("session");
        let (result, _) = run(
            &session,
            "var hold = []; for (;;) { hold.push(new Array(200000).fill(7)); }",
        );
        match result {
            ScriptResult::Error { message, .. } => {
                let lowered = message.to_lowercase();
                assert!(
                    lowered.contains("memory"),
                    "expected an out-of-memory error, got: {}",
                    message
                );
            }
            other => panic!("expected the allocation bomb to fail, got {:?}", other),
        }
    }

    // -----------------------------------------------------------------------
    // Real host state
    // -----------------------------------------------------------------------

    /// Host state feeds the Calcula getters that used to answer with canned
    /// defaults regardless of what the app actually held.
    #[test]
    fn host_state_backs_the_getters() {
        let session = session(None);
        let mut host = HostState::default();
        host.zoom = 1.75;
        host.reference_style = "R1C1".to_string();
        host.named_style_names = vec!["Heading 1".to_string(), "Total".to_string()];
        host.display_gridlines = false;
        host.is_dirty = true;
        host.scroll_area = Some("A1:D10".to_string());
        host.iteration_enabled = true;
        host.iteration_max_count = 42;
        host.workbook_properties
            .insert("author".to_string(), "Daniel".to_string());

        let mut run_input = input();
        run_input.host_state = host;

        // console.log (not the REPL value) so the assertion reads as plain text.
        let (result, _) = session.run_cell(
            "console.log([Calcula.getZoom(), Calcula.getReferenceStyle(), \
             Calcula.getNamedStyles(), Calcula.getDisplayGridlines(), Calcula.isDirty(), \
             Calcula.getScrollArea(), JSON.parse(Calcula.getIterationSettings()).maxIterations, \
             Calcula.getWorkbookProperty('author')].join('|'))",
            run_input,
        );
        match result {
            ScriptResult::Success { output, .. } => {
                assert_eq!(
                    output.first().map(|i| i.to_text()).as_deref(),
                    Some(r#"1.75|R1C1|["Heading 1","Total"]|false|true|A1:D10|42|Daniel"#)
                );
            }
            other => panic!("expected success, got {:?}", other),
        }
    }

    /// A locale/calculation-mode change mid-session is picked up on the next
    /// cell: the Application metadata is read per run, not frozen at session
    /// creation (a sv-SE user must not see "." as their decimal separator).
    #[test]
    fn app_info_is_reapplied_per_cell() {
        let session = session(None);

        let (first, _) = session.run_cell(
            "Calcula.application.decimalSeparator + Calcula.application.calculationMode",
            input(),
        );
        match first {
            ScriptResult::Success { output, .. } => assert_eq!(
                output.last().map(|i| i.to_text()).as_deref(),
                Some("\".automatic\"")
            ),
            other => panic!("expected success, got {:?}", other),
        }

        let mut swedish = input();
        swedish.app_info = AppInfo {
            decimal_separator: ",".to_string(),
            thousands_separator: " ".to_string(),
            calculation_mode: "manual".to_string(),
            ..AppInfo::default()
        };
        let (second, _) = session.run_cell(
            "Calcula.application.decimalSeparator + Calcula.application.calculationMode",
            swedish,
        );
        match second {
            ScriptResult::Success { output, .. } => assert_eq!(
                output.last().map(|i| i.to_text()).as_deref(),
                Some("\",manual\"")
            ),
            other => panic!("expected success, got {:?}", other),
        }
    }

    /// Host state is likewise re-applied per cell — the second cell must not
    /// see the first cell's zoom.
    #[test]
    fn host_state_is_reapplied_per_cell() {
        let session = session(None);
        let mut first = input();
        first.host_state.zoom = 2.0;
        let (r1, _) = session.run_cell("Calcula.getZoom()", first);
        match r1 {
            ScriptResult::Success { output, .. } => {
                assert_eq!(output.last().map(|i| i.to_text()).as_deref(), Some("2"))
            }
            other => panic!("expected success, got {:?}", other),
        }
        let (r2, _) = session.run_cell("Calcula.getZoom()", input());
        match r2 {
            ScriptResult::Success { output, .. } => {
                assert_eq!(output.last().map(|i| i.to_text()).as_deref(), Some("1"))
            }
            other => panic!("expected success, got {:?}", other),
        }
    }

    // -----------------------------------------------------------------------
    // Write-back + effective cells_modified
    // -----------------------------------------------------------------------

    /// setWorkbookProperty surfaces on the result so the host can persist it,
    /// and reads back within the same cell.
    #[test]
    fn workbook_property_writes_surface_on_the_result() {
        let session = session(None);
        let (result, _) = run(
            &session,
            "Calcula.setWorkbookProperty('title', 'Q3 Report'); Calcula.getWorkbookProperty('title')",
        );
        match result {
            ScriptResult::Success { output, workbook_properties_changed, .. } => {
                assert_eq!(
                    output.last().map(|i| i.to_text()).as_deref(),
                    Some("\"Q3 Report\"")
                );
                assert_eq!(
                    workbook_properties_changed.get("title").map(String::as_str),
                    Some("Q3 Report")
                );
            }
            other => panic!("expected success, got {:?}", other),
        }
    }

    /// The changed-properties map is per CELL: a cell that writes nothing
    /// reports nothing, even after an earlier cell wrote.
    #[test]
    fn workbook_property_changes_reset_between_cells() {
        let session = session(None);
        let _ = run(&session, "Calcula.setWorkbookProperty('title', 'first')");
        let (result, _) = run(&session, "1 + 1");
        match result {
            ScriptResult::Success { workbook_properties_changed, .. } => {
                assert!(
                    workbook_properties_changed.is_empty(),
                    "stale writes leaked into the next cell: {:?}",
                    workbook_properties_changed
                );
            }
            other => panic!("expected success, got {:?}", other),
        }
    }

    /// cells_modified counts EFFECTIVE changes: rewriting a cell with the value
    /// it already holds is not a modification.
    #[test]
    fn cells_modified_counts_effective_changes_only() {
        let session = session(None);
        let (first, grids) = run(&session, "Calcula.setCellValue(0, 0, 'x')");
        match first {
            ScriptResult::Success { cells_modified, .. } => assert_eq!(cells_modified, 1),
            other => panic!("expected success, got {:?}", other),
        }
        assert_eq!(
            cell_value_to_string(&grids[0].get_cell(0, 0).expect("written cell").value),
            "x"
        );

        // Feed the mutated grid back in and write the SAME value again.
        let mut again = input();
        again.grids = grids;
        let (second, _) = session.run_cell(
            "Calcula.setCellValue(0, 0, 'x'); Calcula.setCellValue(0, 1, 'new')",
            again,
        );
        match second {
            ScriptResult::Success { cells_modified, .. } => assert_eq!(
                cells_modified, 1,
                "only the genuinely new value counts"
            ),
            other => panic!("expected success, got {:?}", other),
        }
    }
}
