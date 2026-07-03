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

use crate::ops;
use crate::types::{ScriptContext, ScriptResult};

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
}

impl NotebookSession {
    /// Create a new notebook session with an initialized QuickJS runtime.
    ///
    /// The runtime is set up with Calcula.* and console.* APIs. The initial
    /// ScriptContext contains the provided grid data, which will be swapped
    /// before each cell execution. `model_provider` (host-injected) enables
    /// the read-only `model.*` API; None leaves it raising a clear
    /// "not available" error.
    pub fn new(
        grids: Vec<Grid>,
        style_registry: StyleRegistry,
        sheet_names: Vec<String>,
        active_sheet: usize,
        model_provider: Option<Rc<dyn crate::model_provider::ModelDataProvider>>,
    ) -> Result<Self, String> {
        let runtime = Runtime::new()
            .map_err(|e| format!("Failed to create QuickJS runtime: {}", e))?;
        let context = Context::full(&runtime)
            .map_err(|e| format!("Failed to create QuickJS context: {}", e))?;

        let initial_ctx = ScriptContext {
            grids,
            style_registry,
            sheet_names,
            active_sheet,
            console_output: RefCell::new(Vec::new()),
            cells_modified: RefCell::new(0),
            cell_bookmarks_json: "[]".to_string(),
            view_bookmarks_json: "[]".to_string(),
            bookmark_mutations: RefCell::new(Vec::new()),
            app_info: crate::types::AppInfo::default(),
            screen_updating: RefCell::new(true),
            enable_events: RefCell::new(true),
            deferred_actions: RefCell::new(Vec::new()),
            display_zeros: true,
            is_dirty: false,
            view_mode: "normal".to_string(),
            zoom: 1.0,
            reference_style: "A1".to_string(),
            sheet_visibility: Vec::new(),
            workbook_properties: std::collections::HashMap::new(),
            named_style_names: Vec::new(),
            iteration_enabled: false,
            iteration_max_count: 100,
            iteration_max_change: 0.001,
            scroll_area: None,
            display_gridlines: true,
            display_headings: true,
            model_provider,
            surface_id: String::new(),
        };

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
        })
    }

    /// Execute a single notebook cell.
    ///
    /// Before execution, the shared ScriptContext is updated with the provided
    /// grid data (so the cell sees the current spreadsheet state). After execution,
    /// the modified grids are extracted and returned.
    ///
    /// JavaScript global variables from previous cells remain accessible.
    /// `surface_id` attributes model-provider calls (capability grants +
    /// audit) to the calling notebook, e.g. "notebook:nb-123".
    pub fn run_cell(
        &self,
        source: &str,
        grids: Vec<Grid>,
        style_registry: StyleRegistry,
        sheet_names: Vec<String>,
        active_sheet: usize,
        surface_id: &str,
    ) -> (ScriptResult, Vec<Grid>) {
        let start = Instant::now();

        // Swap in fresh grid data for this cell execution
        {
            let mut ctx = self.shared_ctx.borrow_mut();
            ctx.grids = grids;
            ctx.style_registry = style_registry;
            ctx.sheet_names = sheet_names;
            ctx.active_sheet = active_sheet;
            ctx.surface_id = surface_id.to_string();
            // Reset per-cell counters
            *ctx.console_output.borrow_mut() = Vec::new();
            *ctx.cells_modified.borrow_mut() = 0;
            *ctx.deferred_actions.borrow_mut() = Vec::new();
        }

        // Execute the cell source in the persistent JS context.
        // Like a REPL / Jupyter notebook, the value of the last expression is
        // captured and displayed as output (unless it is undefined).
        let eval_result = self
            .context
            .with(|ctx| -> Result<Option<crate::types::ScriptOutputItem>, String> {
            let result: rquickjs::Result<Value> = ctx.eval(source);
            match result {
                Ok(val) => {
                    let repr = value_to_display_item(&ctx, &val);
                    Ok(repr)
                }
                Err(e) => {
                    let caught = ctx.catch();
                    if let Some(exc) = caught.as_exception() {
                        let msg = exc.message().unwrap_or_default();
                        let stack = exc.stack().unwrap_or_default();
                        if stack.is_empty() {
                            return Err(msg);
                        }
                        return Err(format!("{}\n{}", msg, stack));
                    }
                    Err(format!("Script error: {}", e))
                }
            }
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
                let screen_updating = *ctx.screen_updating.borrow();
                let enable_events = *ctx.enable_events.borrow();
                let result = ScriptResult::Success {
                    output,
                    cells_modified,
                    duration_ms,
                    bookmark_mutations,
                    deferred_actions,
                    screen_updating,
                    enable_events,
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

    /// Reset the JS runtime — clears all global variables.
    /// This is used when rewinding: after restoring a snapshot, we reset
    /// the runtime and replay cells 1..N-1 to rebuild JS variable state.
    ///
    /// Returns a new NotebookSession (since we must recreate the runtime).
    pub fn reset(
        self,
        grids: Vec<Grid>,
        style_registry: StyleRegistry,
        sheet_names: Vec<String>,
        active_sheet: usize,
    ) -> Result<NotebookSession, String> {
        // Carry the host-injected provider over to the fresh session.
        let model_provider = self.shared_ctx.borrow().model_provider.clone();
        // Drop the old session (runtime + context + closures)
        drop(self);
        // Create a fresh one
        NotebookSession::new(grids, style_registry, sheet_names, active_sheet, model_provider)
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
    use super::NotebookSession;
    use crate::model_provider::{
        ModelDataProvider, ModelProviderError, ModelProviderErrorKind, ModelQuerySpec, ModelTable,
    };
    use crate::types::{cell_value_to_string, ScriptOutputItem, ScriptResult};
    use engine::grid::Grid;
    use engine::style::StyleRegistry;
    use std::rc::Rc;

    fn fixture() -> (Vec<Grid>, StyleRegistry, Vec<String>) {
        (vec![Grid::new()], StyleRegistry::new(), vec!["Sheet1".to_string()])
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
        let (grids, reg, names) = fixture();
        session.run_cell(src, grids, reg, names, 0, "notebook:test-nb")
    }

    #[test]
    fn model_query_result_reaches_js_and_autorenders_as_table() {
        let (grids, reg, names) = fixture();
        let provider = Rc::new(MockProvider::new(true));
        let session =
            NotebookSession::new(grids, reg, names, 0, Some(provider.clone())).expect("session");

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
        let (grids, reg, names) = fixture();
        let session =
            NotebookSession::new(grids, reg, names, 0, Some(Rc::new(MockProvider::new(true))))
                .expect("session");

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
        let (grids, reg, names) = fixture();
        let session =
            NotebookSession::new(grids, reg, names, 0, Some(Rc::new(MockProvider::new(false))))
                .expect("session");

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
        let (grids, reg, names) = fixture();
        let session = NotebookSession::new(grids, reg, names, 0, None).expect("session");
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
        let (grids, reg, names) = fixture();
        let session =
            NotebookSession::new(grids, reg, names, 0, Some(Rc::new(MockProvider::new(true))))
                .expect("session");
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
}
