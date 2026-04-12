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
    /// before each cell execution.
    pub fn new(
        grids: Vec<Grid>,
        style_registry: StyleRegistry,
        sheet_names: Vec<String>,
        active_sheet: usize,
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
        };

        let shared_ctx = Rc::new(RefCell::new(initial_ctx));

        // Register Calcula.* and console.* APIs in the JS global scope.
        // These closures capture the shared_ctx Rc and will survive across
        // cell executions since the context is never dropped.
        context.with(|ctx| -> Result<(), String> {
            let globals = ctx.globals();
            register_calcula_api(&ctx, &globals, shared_ctx.clone())?;
            register_console(&ctx, &globals, shared_ctx.clone())?;
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
    pub fn run_cell(
        &self,
        source: &str,
        grids: Vec<Grid>,
        style_registry: StyleRegistry,
        sheet_names: Vec<String>,
        active_sheet: usize,
    ) -> (ScriptResult, Vec<Grid>) {
        let start = Instant::now();

        // Swap in fresh grid data for this cell execution
        {
            let mut ctx = self.shared_ctx.borrow_mut();
            ctx.grids = grids;
            ctx.style_registry = style_registry;
            ctx.sheet_names = sheet_names;
            ctx.active_sheet = active_sheet;
            // Reset per-cell counters
            *ctx.console_output.borrow_mut() = Vec::new();
            *ctx.cells_modified.borrow_mut() = 0;
        }

        // Execute the cell source in the persistent JS context
        let eval_result = self.context.with(|ctx| -> Result<(), String> {
            let result: rquickjs::Result<Value> = ctx.eval(source);
            result.map(|_| ()).map_err(|e| {
                let caught = ctx.catch();
                if let Some(exc) = caught.as_exception() {
                    let msg = exc.message().unwrap_or_default();
                    let stack = exc.stack().unwrap_or_default();
                    if stack.is_empty() {
                        return msg;
                    }
                    return format!("{}\n{}", msg, stack);
                }
                format!("Script error: {}", e)
            })
        });

        let duration_ms = start.elapsed().as_millis() as u64;

        match eval_result {
            Ok(()) => {
                let ctx = self.shared_ctx.borrow();
                let output = ctx.console_output.borrow().clone();
                let cells_modified = *ctx.cells_modified.borrow();
                let grids = ctx.grids.clone();
                let bookmark_mutations = ctx.bookmark_mutations.borrow().clone();
                let result = ScriptResult::Success {
                    output,
                    cells_modified,
                    duration_ms,
                    bookmark_mutations,
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
        // Drop the old session (runtime + context + closures)
        drop(self);
        // Create a fresh one
        NotebookSession::new(grids, style_registry, sheet_names, active_sheet)
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

    globals
        .set("Calcula", calcula)
        .map_err(|e| format!("Failed to set Calcula global: {}", e))?;

    Ok(())
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
            ctx_ref.borrow().console_output.borrow_mut().push(message);
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
