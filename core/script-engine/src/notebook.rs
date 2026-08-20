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
    /// The QuickJS runtime — kept alive for the session lifetime, must outlive
    /// `context` (drop order matters), and owns the microtask queue that
    /// `run_cell` drains after every cell.
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
    /// Unhandled promise rejections, shared with the runtime's tracker. CLEARED
    /// before every cell: the session outlives any one cell, so a rejection from
    /// cell N must not be reported against cell N+1.
    rejections: Rc<limits::Rejections>,
    /// Set once a JOB was aborted mid-execution — see `is_poisoned`.
    poisoned: std::cell::Cell<bool>,
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
        let (deadline, rejections) = limits::install(&runtime, limits);
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
            rejections,
            poisoned: std::cell::Cell::new(false),
            limits,
        })
    }

    /// This session's runtime is no longer safe to USE **or to DROP**.
    ///
    /// Set when the deadline interrupt aborted a queued JOB mid-execution.
    /// QuickJS is then left holding a bad refcount, and dropping that runtime
    /// trips its own `p->ref_count > 0` assertion and takes the PROCESS down
    /// with `STATUS_STACK_BUFFER_OVERRUN`. Measured 2026-08-20, and the
    /// distinction is sharp: a cell that merely times out during `eval` — no job
    /// ever queued — drops perfectly safely. It is aborting a JOB that corrupts.
    ///
    /// A caller that sees `true` must replace the session AND deliberately LEAK
    /// the old one (`std::mem::forget`) rather than drop it. Leaking one runtime
    /// is the cost of not crashing the app; it is bounded by how often a user's
    /// `async` continuation runs past the cell budget, which is rare and always
    /// user-visible. The real repair is upstream in QuickJS's job unwinding.
    ///
    /// Reachable only because jobs now RUN: before the queue was drained, a
    /// continuation never executed, so it could never be interrupted.
    pub fn is_poisoned(&self) -> bool {
        self.poisoned.get()
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
        // A poisoned session runs NOTHING more. Its queue may still hold jobs the
        // aborted drain abandoned (draining past an abort cannot terminate — see
        // `drain_jobs`), and any call into the runtime could run them against
        // THIS cell's grids and commit under this cell's id. The refusal is what
        // makes stopping the drain on the first job error sound; the host is
        // expected to retire the session (which the notebook executor does, so a
        // user never actually sees this message — it exists for a caller that
        // forgets).
        if self.poisoned.get() {
            return (
                ScriptResult::Error {
                    message: "This notebook session was poisoned by an aborted background job \
                              (a timed-out async continuation) and cannot run further cells. \
                              Reset the notebook to start a fresh session."
                        .to_string(),
                    output: Vec::new(),
                },
                input.grids,
            );
        }

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
        self.rejections.clear();
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
        // Finish what the cell deferred (`async`/`await`, promise chains) before
        // the grids are read back, while the budget is still armed. Runs even
        // when the eval failed: this session is PERSISTENT, and a job left queued
        // by this cell would otherwise run during the next one and mutate ITS
        // grids. See `drain_jobs` for why it cannot go inside the closure above.
        let drain_result = crate::runtime::drain_jobs(&self.runtime, &self.deadline);
        // A job that FAULTED is the uncatchable kind — the deadline interrupt —
        // and it leaves the runtime unsafe to drop. See `is_poisoned`.
        if drain_result.is_err() {
            self.poisoned.set(true);
        }
        self.deadline.disarm();
        // The eval's own error wins: it came first, and a drain error is usually
        // its aftermath rather than a second, independent fault. An unhandled
        // rejection is checked last — it is the quietest of the three, and the
        // only evidence that an `async` body failed rather than did nothing.
        let eval_result = eval_result
            .and_then(|last| drain_result.map(|()| last))
            .and_then(|last| match self.rejections.first() {
                Some(message) => Err(message),
                None => Ok(last),
            });

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
        host.zoom = 175.0;
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
                    Some(r#"175|R1C1|["Heading 1","Total"]|false|true|A1:D10|42|Daniel"#)
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
        first.host_state.zoom = 200.0;
        let (r1, _) = session.run_cell("Calcula.getZoom()", first);
        match r1 {
            ScriptResult::Success { output, .. } => {
                assert_eq!(output.last().map(|i| i.to_text()).as_deref(), Some("200"))
            }
            other => panic!("expected success, got {:?}", other),
        }
        let (r2, _) = session.run_cell("Calcula.getZoom()", input());
        match r2 {
            ScriptResult::Success { output, .. } => {
                assert_eq!(output.last().map(|i| i.to_text()).as_deref(), Some("100"))
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

    /// THE ISOLATION CLAIM, tested directly: a run mutates the grids it was
    /// GIVEN and leaves the caller's own copy alone.
    ///
    /// Everything above the engine assumes this — `run_script_isolated` hands in
    /// a clone and keeps a second clone as a diff baseline, and the L3 dry run
    /// rests entirely on the original being untouched. It had never been
    /// asserted at this level, so when a dry run was observed writing to the
    /// live workbook there was no way to tell whether the engine was the leak or
    /// merely the accused. This test answers that question in milliseconds
    /// instead of a two-minute app launch.
    #[test]
    fn a_run_never_mutates_the_callers_grids() {
        let session = session(None);
        let (grids, reg, names) = fixture();

        // The caller's copy, kept out of the run exactly as run_script_isolated
        // keeps its baseline.
        let baseline = grids.clone();
        let before = baseline[0].get_cell(5, 5).map(|c| cell_value_to_string(&c.value));

        let input = CellRunInput::new(grids, reg, names, 0, "notebook:isolation");
        let (result, modified) = session.run_cell("Calcula.setCellValue(5, 5, 'OVERWRITTEN')", input);
        match result {
            ScriptResult::Success { .. } => {}
            other => panic!("expected success, got {:?}", other),
        }

        // The run's OUTPUT carries the write...
        assert_eq!(
            cell_value_to_string(&modified[0].get_cell(5, 5).expect("written cell").value),
            "OVERWRITTEN",
        );
        // ...and the caller's copy is untouched.
        assert_eq!(
            baseline[0].get_cell(5, 5).map(|c| cell_value_to_string(&c.value)),
            before,
            "the run mutated the caller's grids — every dry run and every diff baseline above \
             this layer is built on that not happening",
        );
    }

    /// An `async` body must FINISH before the grids are read back.
    ///
    /// QuickJS parks everything past the first `await` on a job queue that
    /// nothing drained. The cell below ran as far as its `await`, `eval`
    /// returned, and the run reported `Success` with `cells_modified: 0` and an
    /// untouched grid — a silent no-op that looks exactly like a clean pass.
    /// Discovered while wiring the AI dry run, where "ran fine, changed nothing"
    /// is the single most misleading verdict the checker can produce.
    #[test]
    fn an_async_body_finishes_before_the_grids_are_read_back() {
        let session = session(None);
        let (grids, reg, names) = fixture();
        let input = CellRunInput::new(grids, reg, names, 0, "notebook:async");

        let (result, modified) = session.run_cell(
            "(async () => { await null; Calcula.setCellValue(0, 1, 'ASYNC_RAN'); })();",
            input,
        );

        match result {
            ScriptResult::Success { cells_modified, .. } => assert_eq!(
                cells_modified, 1,
                "the async continuation never ran, so the write never happened",
            ),
            other => panic!("expected success, got {:?}", other),
        }
        assert_eq!(
            modified[0]
                .get_cell(0, 1)
                .map(|c| cell_value_to_string(&c.value)),
            Some("ASYNC_RAN".to_string()),
        );
    }

    /// ...and an `async` body that THROWS must be reported as an error.
    ///
    /// The other half of the same defect: the rejection surfaces only once the
    /// job queue is drained. Undrained, a handler that throws on every input
    /// still reports `Success`, which would let the AI repair loop stop on a
    /// script that cannot work.
    #[test]
    fn an_async_body_that_throws_is_reported_as_an_error() {
        let session = session(None);
        let (grids, reg, names) = fixture();
        let input = CellRunInput::new(grids, reg, names, 0, "notebook:asyncthrow");

        let (result, _) = session.run_cell(
            "(async () => { await null; throw new Error('handler blew up'); })();",
            input,
        );

        match result {
            ScriptResult::Error { message, .. } => assert!(
                message.contains("handler blew up"),
                "the rejection should name the script's own error, got {:?}",
                message,
            ),
            other => panic!("an async body that throws must not report success: {:?}", other),
        }
    }

    /// A rejection the script HANDLES is not an error.
    ///
    /// The guard that matters more than the two above: reporting a working
    /// script as broken is the exact failure this checker exists to prevent, and
    /// a rejection tracker is the easiest way to introduce it. `try/catch` around
    /// an `await` is ordinary, correct code.
    #[test]
    fn a_rejection_the_script_handles_is_not_an_error() {
        let session = session(None);
        let (grids, reg, names) = fixture();
        let input = CellRunInput::new(grids, reg, names, 0, "notebook:caught");

        let (result, _) = session.run_cell(
            "(async () => { try { await Promise.reject(new Error('expected')); } \
             catch (e) { Calcula.setCellValue(0, 0, 'RECOVERED'); } })();",
            input,
        );

        match result {
            ScriptResult::Success { cells_modified, .. } => assert_eq!(cells_modified, 1),
            other => panic!("a handled rejection must not fail the run: {:?}", other),
        }
    }

    /// ...including one handled a microtask LATE, which is the only path that
    /// reaches the tracker's `is_handled` branch.
    #[test]
    fn a_rejection_handled_late_is_not_an_error() {
        let session = session(None);
        let (grids, reg, names) = fixture();
        let input = CellRunInput::new(grids, reg, names, 0, "notebook:caughtlate");

        let (result, _) = session.run_cell(
            "const p = Promise.reject(new Error('late')); \
             Promise.resolve().then(() => p.catch(() => {}));",
            input,
        );

        match result {
            ScriptResult::Success { .. } => {}
            other => panic!("a late-handled rejection must not fail the run: {:?}", other),
        }
    }

    /// A late-handled rejection must not forgive an UNRELATED real failure.
    ///
    /// The tracker used to clear EVERY record when any one rejection was
    /// handled late, so this script reported Success: the late `catch` on `p`
    /// erased the record of the async body that genuinely threw. The
    /// start-several-then-await pattern hits this routinely — it is not a
    /// contrived shape.
    #[test]
    fn a_late_handled_rejection_does_not_forgive_an_unrelated_failure() {
        let session = session(None);
        let (grids, reg, names) = fixture();

        let (result, _) = session.run_cell(
            "(async () => { throw new Error('real failure'); })(); \
             const p = Promise.reject(new Error('handled later')); \
             Promise.resolve().then(() => p.catch(() => {}));",
            CellRunInput::new(grids, reg, names, 0, "notebook:mixed"),
        );

        match result {
            ScriptResult::Error { message, .. } => assert!(
                message.contains("real failure"),
                "the surviving record must be the UNHANDLED failure, got {:?}",
                message,
            ),
            other => panic!(
                "one real unhandled rejection must fail the run even when another \
                 was handled late: {:?}",
                other,
            ),
        }
    }

    /// A rejection from one cell must not be reported against the NEXT one.
    ///
    /// The rejection sink is shared with the runtime, and the runtime outlives
    /// every cell. Without a per-cell reset the first async failure would make
    /// every later cell in the session fail too, each blaming code that is fine.
    #[test]
    fn a_rejection_from_one_cell_is_not_reported_against_the_next() {
        let session = session(None);

        let (grids, reg, names) = fixture();
        let (first, _) = session.run_cell(
            "(async () => { throw new Error('cell one blew up'); })();",
            CellRunInput::new(grids, reg, names, 0, "notebook:carry1"),
        );
        assert!(
            matches!(first, ScriptResult::Error { .. }),
            "precondition: the first cell must actually fail, got {:?}",
            first,
        );

        let (grids2, reg2, names2) = fixture();
        let (second, _) = session.run_cell(
            "1 + 1",
            CellRunInput::new(grids2, reg2, names2, 0, "notebook:carry2"),
        );
        match second {
            ScriptResult::Success { .. } => {}
            other => panic!("the previous cell's rejection failed this one: {:?}", other),
        }
    }

    /// Aborting a JOB poisons the session; an ordinary eval timeout does not.
    ///
    /// The distinction is the whole design. Measured 2026-08-20: a session whose
    /// queued job was interrupted CRASHES the process when dropped
    /// (`p->ref_count > 0` -> STATUS_STACK_BUFFER_OVERRUN), while a session whose
    /// cell merely spun at the top level drops perfectly safely. If this flag
    /// were set for every timeout, the host would leak a runtime for the most
    /// common notebook mistake there is; if it were never set, the host would
    /// drop a corrupted one and take the app down.
    #[test]
    fn a_job_abort_poisons_the_session_and_an_eval_timeout_does_not() {
        // An eval timeout: nothing was ever queued, so nothing was aborted.
        let clean = NotebookSession::new(
            None,
            ScriptLimits::with_timeout_ms(50),
            CellRunInput::new(fixture().0, fixture().1, fixture().2, 0, "notebook:clean"),
        )
        .expect("session");
        let (g, r, n) = fixture();
        let (res, _) = clean.run_cell("for (;;) {}", CellRunInput::new(g, r, n, 0, "notebook:clean1"));
        assert!(
            matches!(res, ScriptResult::Error { .. }),
            "precondition: the cell must time out, got {:?}",
            res,
        );
        assert!(
            !clean.is_poisoned(),
            "an eval timeout aborted no job — poisoning it would leak a runtime for the \
             commonest notebook mistake there is",
        );
        drop(clean); // Safe, and asserted by doing it.

        // A job abort: the continuation spins past the budget.
        let dirty = NotebookSession::new(
            None,
            ScriptLimits::with_timeout_ms(50),
            CellRunInput::new(fixture().0, fixture().1, fixture().2, 0, "notebook:dirty"),
        )
        .expect("session");
        let (g2, r2, n2) = fixture();
        let (res2, _) = dirty.run_cell(
            "(async () => { await null; for (;;) {} })();",
            CellRunInput::new(g2, r2, n2, 0, "notebook:dirty1"),
        );
        assert!(
            matches!(res2, ScriptResult::Error { .. }),
            "precondition: the job must be aborted, got {:?}",
            res2,
        );
        let poisoned = dirty.is_poisoned();
        // NEVER drop it — that is the crash this flag exists to prevent.
        std::mem::forget(dirty);
        assert!(poisoned, "an aborted job left the runtime unsafe to drop, unflagged");
    }

    /// A cell whose JOB was aborted must not hand work to the next one — and the
    /// guarantee is now a REFUSAL, not a completed drain.
    ///
    /// The contract went through three shapes, each refuted by a measurement:
    ///   1. Early-return on the first job error — stranded the rest of the queue,
    ///      and the stranded write was committed under the NEXT cell's id
    ///      (measured: cell two reported `cells_modified: 1`).
    ///   2. Drain past errors to empty — cannot terminate: the interrupt fires on
    ///      a countdown that RESETS per fire, so a job that queues its successor
    ///      and then spins is aborted with the successor already queued, forever
    ///      (the wedge test below).
    ///   3. Current: stop on the first job error, POISON the session, and REFUSE
    ///      every later cell. The abandoned queue can never touch anyone's
    ///      grids because the runtime never runs again.
    ///
    /// The session is deliberately LEAKED at the end: dropping a runtime whose
    /// job was aborted trips QuickJS's `p->ref_count > 0` and takes the process
    /// down before the harness prints a result.
    #[test]
    fn a_timed_out_cell_leaves_no_job_behind_for_the_next_cell() {
        let session = NotebookSession::new(
            None,
            ScriptLimits::with_timeout_ms(50),
            CellRunInput::new(fixture().0, fixture().1, fixture().2, 0, "notebook:timeout-setup"),
        )
        .expect("session");

        let (grids, reg, names) = fixture();
        let (first, _) = session.run_cell(
            "(async () => { await null; for (;;) {} })(); \
             (async () => { await null; Calcula.setCellValue(2, 2, 'FROM_TIMED_OUT'); })();",
            CellRunInput::new(grids, reg, names, 0, "notebook:timeout1"),
        );
        assert!(
            matches!(first, ScriptResult::Error { .. }),
            "precondition: the cell must actually time out, got {:?}",
            first,
        );
        assert!(session.is_poisoned(), "a job abort must poison the session");

        let (grids2, reg2, names2) = fixture();
        let (second, returned) = session.run_cell(
            "Calcula.setCellValue(9, 9, 'SHOULD_NEVER_RUN'); 1 + 1",
            CellRunInput::new(grids2, reg2, names2, 0, "notebook:timeout2"),
        );

        let refused = matches!(&second, ScriptResult::Error { message, .. } if message.contains("poisoned"));
        let stranded = returned[0]
            .get_cell(2, 2)
            .map(|c| cell_value_to_string(&c.value));
        let own_write = returned[0]
            .get_cell(9, 9)
            .map(|c| cell_value_to_string(&c.value));

        // See the doc comment: never drop a poisoned session.
        std::mem::forget(session);

        assert!(
            refused,
            "a poisoned session must refuse the next cell — running it could execute \
             the abandoned queue against this cell's grids: {:?}",
            second,
        );
        assert_eq!(stranded, None, "the aborted cell's stranded write reached the next cell's grids");
        assert_eq!(own_write, None, "the refused cell must not have run at all");
    }

    /// The drain TERMINATES against a job that re-queues itself and then spins.
    ///
    /// The adversarial shape: `Promise.resolve().then(f)` queues the successor in
    /// a handful of interrupt polls; the spin then burns thousands, so once the
    /// deadline has expired EVERY job is aborted mid-spin with its successor
    /// already queued. A drain that runs the queue to empty past errors never
    /// sees an empty queue and wedges the thread forever at 100% CPU — this test
    /// HANGING is the red, which is why the drain stops at the first job error
    /// instead. Reachable from every one-off surface, including the .calp
    /// writeback validator, i.e. code a package AUTHOR wrote and a SUBSCRIBER
    /// runs.
    #[test]
    fn a_self_requeuing_spinner_cannot_wedge_the_drain() {
        let session = NotebookSession::new(
            None,
            ScriptLimits::with_timeout_ms(50),
            CellRunInput::new(fixture().0, fixture().1, fixture().2, 0, "notebook:wedge-setup"),
        )
        .expect("session");

        let (grids, reg, names) = fixture();
        let started = std::time::Instant::now();
        let (result, _) = session.run_cell(
            "(async () => { await null; \
                (function f() { Promise.resolve().then(f); for (;;) {} })(); \
             })();",
            CellRunInput::new(grids, reg, names, 0, "notebook:wedge1"),
        );
        let elapsed = started.elapsed();

        let errored = matches!(result, ScriptResult::Error { .. });
        // The abort corrupts the runtime, so this session too must be leaked.
        std::mem::forget(session);

        assert!(errored, "the wedge script must fail, not succeed");
        assert!(
            elapsed < std::time::Duration::from_secs(20),
            "returning at all is the property; {:?} means the drain is not terminating",
            elapsed,
        );
    }

    /// A job queued by one cell must not run during the NEXT one.
    ///
    /// The session is persistent, so an undrained continuation from cell N would
    /// resume against cell N+1's freshly-swapped grids and write to the wrong
    /// workbook. Draining on the error path too is what prevents it.
    #[test]
    fn a_cell_leaves_no_job_behind_for_the_next_cell() {
        let session = session(None);

        let (grids, reg, names) = fixture();
        let (_, _) = session.run_cell(
            "(async () => { await null; Calcula.setCellValue(9, 9, 'FROM_CELL_ONE'); })(); \
             throw new Error('cell one fails');",
            CellRunInput::new(grids, reg, names, 0, "notebook:leak1"),
        );

        let (grids2, reg2, names2) = fixture();
        let (result, modified) = session.run_cell(
            "1 + 1",
            CellRunInput::new(grids2, reg2, names2, 0, "notebook:leak2"),
        );

        match result {
            ScriptResult::Success { cells_modified, .. } => assert_eq!(
                cells_modified, 0,
                "the previous cell's deferred write landed in this cell's grids",
            ),
            other => panic!("expected success, got {:?}", other),
        }
        assert_eq!(
            modified[0].get_cell(9, 9).map(|c| cell_value_to_string(&c.value)),
            None,
            "cell one's continuation wrote into cell two's workbook",
        );
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
