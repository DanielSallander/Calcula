//! FILENAME: core/script-engine/src/runtime.rs
//! PURPOSE: QuickJS runtime initialization and script execution via rquickjs.
//! CONTEXT: Creates a QuickJS Runtime/Context, applies the runtime safety
//! limits (memory / stack / wall-clock deadline — see limits.rs), registers the
//! Calcula API as global functions, and executes user scripts.

use rquickjs::{Context, Runtime, Function, Object, Value};
use std::cell::RefCell;
use std::rc::Rc;

use crate::limits::{self, Deadline, ScriptLimits};
use crate::types::ScriptContext;
use crate::ops;

/// The outcome of one execution: the (possibly mutated) ScriptContext, plus the
/// script's error message when it failed.
///
/// The context comes back on BOTH paths on purpose — a failed script has still
/// written console output (and possibly grid cells) that the caller must be
/// able to show. Only an infrastructure failure (runtime creation, context
/// recovery) surfaces as `Err` from `execute_script`.
pub struct ExecutionOutcome {
    /// The context after execution, with output/counters/queued actions.
    pub context: ScriptContext,
    /// The script's error message, or None when it completed normally.
    pub error: Option<String>,
}

/// Execute a JavaScript source string in a QuickJS runtime with Calcula API.
/// The ScriptContext is shared with the runtime so registered functions can access it.
///
/// `limits` caps the runtime's heap and JS stack and arms a wall-clock deadline
/// for the user script (the API-registration evals run BEFORE the deadline is
/// armed, so setup can never be charged to the script's budget).
pub fn execute_script(
    js_source: &str,
    _filename: &str,
    context: ScriptContext,
    limits: ScriptLimits,
) -> Result<ExecutionOutcome, String> {
    let rt = Runtime::new().map_err(|e| format!("Failed to create QuickJS runtime: {}", e))?;
    // Memory + stack ceilings and the interrupt handler go on before ANY code
    // runs in this runtime.
    let (deadline, rejections) = limits::install(&rt, limits);
    let qjs_context = Context::full(&rt)
        .map_err(|e| format!("Failed to create context: {}", e))?;

    // Wrap ScriptContext in Rc<RefCell<>> so closures can share it
    let shared_ctx = Rc::new(RefCell::new(context));

    // Execute within the QuickJS context
    let result = qjs_context.with(|ctx| -> Result<(), String> {
        let globals = ctx.globals();

        // Register the Calcula namespace object with all API methods
        register_calcula_api(&ctx, &globals, shared_ctx.clone())?;

        // Register console.log
        register_console(&ctx, &globals, shared_ctx.clone())?;

        // Register the display global (display.table -> Table output items)
        crate::display::register_display(&ctx, &globals, shared_ctx.clone())?;

        // Register the model global (read-only BI model access; throws a clear
        // "not available on this surface" error when no provider is injected)
        crate::ops::model::register_model_ops(&ctx, &globals, shared_ctx.clone())?;

        // Execute the user script under the wall-clock budget. The budget stays
        // ARMED past this closure: the microtasks the script queued have not run
        // yet, and they are drained below, still on this script's clock.
        deadline.arm(limits.timeout_ms);
        let eval_result: rquickjs::Result<Value> = ctx.eval(js_source);

        eval_result.map(|_| ()).map_err(|e| describe_error(&ctx, e, &deadline))
    });

    // Finish what the script deferred (`async`/`await`, promise chains) before
    // anything reads its grids back. Outside the `with` above by necessity — see
    // `drain_jobs`. An eval error wins over a drain error: it came first and it
    // is the one that explains the rest.
    let drain = drain_jobs(&rt, &deadline);
    deadline.disarm();
    // A drain error means a JOB was aborted mid-execution (the uncatchable
    // deadline interrupt) — the same condition `NotebookSession::is_poisoned`
    // flags, and it makes this runtime unsafe to DROP: QuickJS is left holding
    // a bad refcount, and freeing it trips `p->ref_count > 0` and takes the
    // PROCESS down with STATUS_STACK_BUFFER_OVERRUN. Measured on this very
    // path 2026-08-20: `(async () => { await null; for (;;) {} })();` through
    // any one-off surface — MCP execute_script, the chat's run_script, the AI
    // dry run — crashed the app on the `drop(rt)` below. Before jobs were
    // drained the continuation never ran, so it could never be aborted; the
    // drain made this reachable and the notebook fix alone did not cover it.
    let poisoned = drain.is_err();
    let result = result
        .and_then(|()| drain)
        .and_then(|()| match rejections.first() {
            Some(message) => Err(message),
            None => Ok(()),
        });

    if poisoned {
        // Recover the caller's ScriptContext WITHOUT dropping the runtime: the
        // JS closures hold Rc clones of `shared_ctx`, so `Rc::try_unwrap` can
        // never succeed while the runtime is leaked — but replacing the
        // RefCell's CONTENTS hands the real context out by value and leaves the
        // leaked closures holding an empty placeholder. The caller still gets
        // its grids and console output; only the runtime is abandoned. Leaking
        // is bounded by how often a script's async continuation outruns the
        // budget — rare, and always surfaced as the error below.
        let placeholder = ScriptContext::new(
            Vec::new(),
            engine::style::StyleRegistry::new(),
            Vec::new(),
            0,
            crate::types::AppInfo::default(),
            crate::types::HostState::default(),
        );
        let context = shared_ctx.replace(placeholder);
        std::mem::forget(qjs_context);
        std::mem::forget(rt);
        return Ok(ExecutionOutcome {
            context,
            error: result.err(),
        });
    }

    // Drop the QuickJS context and runtime BEFORE unwrapping the Rc.
    // The JS closures (getCellValue, setCellValue, etc.) each hold an Rc clone;
    // those references are only released when the runtime is dropped.
    drop(qjs_context);
    drop(rt);

    // Extract the ScriptContext back from the Rc<RefCell<>>
    let context = Rc::try_unwrap(shared_ctx)
        .map_err(|_| "Failed to recover script context".to_string())?
        .into_inner();

    Ok(ExecutionOutcome {
        context,
        error: result.err(),
    })
}

/// Run every microtask the script left queued, so `async`/`await` and promise
/// chains finish before the caller reads the grids back.
///
/// QuickJS parks a function's continuation past its first `await` on a job queue
/// that nothing drains on its own. Left undrained, an async body runs as far as
/// that first `await`, `eval` returns, the grids are read back UNCHANGED, and the
/// run reports `Success` with `cells_modified: 0` — a silent no-op wearing a
/// clean bill of health. That is the worst answer a verifier can give, so this is
/// correctness, not polish. A rejected promise becomes the run's error here for
/// the same reason: an async body that throws must not report success.
///
/// Two call-site requirements, both load-bearing:
///   * Call it from OUTSIDE any `Context::with` closure — `with` holds the very
///     runtime lock `execute_pending_job` needs, so calling it inside deadlocks.
///   * Call it while the deadline is still ARMED. The interrupt handler fires
///     inside job execution too, and it is the ONLY thing that stops a promise
///     chain which re-queues itself forever; there is deliberately no iteration
///     cap here, because a cap would cut a long-but-finite chain short and call
///     it a failure.
///
/// Draining also matters for the PERSISTENT notebook session specifically: jobs
/// left behind by cell N would otherwise run during cell N+1 and mutate the
/// wrong grids.
///
/// **The FIRST failing job ends the drain**, and that is a termination
/// requirement, not a shortcut. An intermediate version ran the queue to empty
/// past errors, reasoning that an aborted job "never runs far enough to queue
/// another" — refuted by this session's adversarial review: QuickJS polls the
/// interrupt handler on a countdown counter that RESETS each time it fires, so a
/// job that queues its successor FIRST and spins SECOND is aborted mid-spin with
/// the successor already queued (`Promise.resolve().then(f)` costs a handful of
/// polls; the spin costs thousands). Every iteration then errs with the queue
/// still non-empty, and a drain with no cap loops forever — wedging the
/// notebook-executor thread, or the synchronous Tauri command thread under MCP
/// `execute_script` / the AI dry run / the .calp writeback validator, at 100%
/// CPU. Exactly the "never wedge the thread" guarantee `limits` exists to give.
///
/// Stopping is safe ONLY because every caller treats an erred drain as POISON:
/// the one-off path leaks its runtime (see `execute_script`), and
/// `NotebookSession` sets `is_poisoned` and refuses every later cell, so the
/// jobs left on an abandoned queue can never run against anyone's grids.
pub(crate) fn drain_jobs(rt: &Runtime, deadline: &Deadline) -> Result<(), String> {
    loop {
        match rt.execute_pending_job() {
            Ok(true) => continue,
            Ok(false) => return Ok(()),
            Err(exception) => {
                return Err(exception
                    .0
                    .with(|ctx| describe_error(&ctx, rquickjs::Error::Exception, deadline)));
            }
        }
    }
}

/// Turn a failed `ctx.eval` into a user-facing message.
///
/// A deadline abort takes priority: QuickJS reports it as an UNCATCHABLE
/// "InternalError: interrupted", which tells the user nothing about what
/// actually happened, so the deadline's own message replaces it.
pub(crate) fn describe_error<'js>(
    ctx: &rquickjs::Ctx<'js>,
    err: rquickjs::Error,
    deadline: &Deadline,
) -> String {
    // Clear the pending exception either way so the runtime is not left holding it.
    let caught = ctx.catch();
    if deadline.tripped() {
        return deadline.timeout_message();
    }
    if let Some(exc) = caught.as_exception() {
        let msg = exc.message().unwrap_or_default();
        let stack = exc.stack().unwrap_or_default();
        if msg.is_empty() && stack.is_empty() {
            // An exception with nothing readable on it (can happen when the
            // heap is exhausted): fall back to the rquickjs error kind.
            return format!("Script error: {}", err);
        }
        if stack.is_empty() {
            return msg;
        }
        return format!("{}\n{}", msg, stack);
    }
    format!("Script error: {}", err)
}

/// Register the `Calcula` global object with all spreadsheet API methods.
fn register_calcula_api<'js>(
    ctx: &rquickjs::Ctx<'js>,
    globals: &Object<'js>,
    shared_ctx: Rc<RefCell<ScriptContext>>,
) -> Result<(), String> {
    let calcula = Object::new(ctx.clone())
        .map_err(|e| format!("Failed to create Calcula object: {}", e))?;

    // Cell operations
    ops::cells::register_cell_ops(ctx, &calcula, shared_ctx.clone())?;

    // Sheet operations
    ops::sheets::register_sheet_ops(ctx, &calcula, shared_ctx.clone())?;

    // Utility operations (log)
    ops::utility::register_utility_ops(ctx, &calcula, shared_ctx.clone())?;

    // Text operations (Calcula.text.parseCsv / toCsv) — pure compute, no
    // ScriptContext needed.
    ops::text::register_text_ops(ctx, &calcula)?;

    // Bookmark operations
    ops::bookmarks::register_bookmark_ops(ctx, &calcula, shared_ctx.clone())?;

    // Worksheet property operations
    ops::worksheet_props::register_worksheet_props_ops(ctx, &calcula, shared_ctx.clone())?;

    // Extended operations (view, navigation, formatting, data, display)
    ops::extended::register_extended_ops(ctx, &calcula, shared_ctx.clone())?;

    // Canonical shared object model (Calcula.workbook -> Sheet -> Range).
    // Must be attached before Calcula goes on globals.
    ops::canonical_model::register_canonical_model(ctx, &calcula, shared_ctx.clone())?;

    // Set Calcula on globals BEFORE application ops (application.rs uses eval
    // that references the global Calcula object for defineProperty wiring)
    globals
        .set("Calcula", calcula)
        .map_err(|e| format!("Failed to set Calcula global: {}", e))?;

    // Application operations (must be registered AFTER Calcula is on globals
    // because the JS defineProperty snippet references Calcula.application)
    let calcula_ref: Object = globals
        .get("Calcula")
        .map_err(|e| format!("Failed to get Calcula global: {}", e))?;
    ops::application::register_application_ops(ctx, &calcula_ref, shared_ctx.clone())?;

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

    // All console methods map to the same output
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

    console.set("log", log_fn.clone())
        .map_err(|e| format!("Failed to set console.log: {}", e))?;
    console.set("warn", log_fn.clone())
        .map_err(|e| format!("Failed to set console.warn: {}", e))?;
    console.set("error", log_fn.clone())
        .map_err(|e| format!("Failed to set console.error: {}", e))?;
    console.set("info", log_fn)
        .map_err(|e| format!("Failed to set console.info: {}", e))?;

    globals
        .set("console", console)
        .map_err(|e| format!("Failed to set console global: {}", e))?;

    Ok(())
}
