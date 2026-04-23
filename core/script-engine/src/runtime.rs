//! FILENAME: core/script-engine/src/runtime.rs
//! PURPOSE: QuickJS runtime initialization and script execution via rquickjs.
//! CONTEXT: Creates a QuickJS Runtime/Context, registers the Calcula API as
//! global functions, and executes user scripts.

use rquickjs::{Context, Runtime, Function, Object, Value};
use std::cell::RefCell;
use std::rc::Rc;

use crate::types::ScriptContext;
use crate::ops;

/// Execute a JavaScript source string in a QuickJS runtime with Calcula API.
/// The ScriptContext is shared with the runtime so registered functions can access it.
/// After execution, the (possibly mutated) ScriptContext is returned.
pub fn execute_script(
    js_source: &str,
    _filename: &str,
    context: ScriptContext,
) -> Result<ScriptContext, String> {
    let rt = Runtime::new().map_err(|e| format!("Failed to create QuickJS runtime: {}", e))?;
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

        // Execute the user script
        let eval_result: rquickjs::Result<Value> = ctx.eval(js_source);

        eval_result.map(|_| ()).map_err(|e| {
            // Try to get exception details from QuickJS
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

    // Drop the QuickJS context and runtime BEFORE unwrapping the Rc.
    // The JS closures (getCellValue, setCellValue, etc.) each hold an Rc clone;
    // those references are only released when the runtime is dropped.
    drop(qjs_context);
    drop(rt);

    // Extract the ScriptContext back from the Rc<RefCell<>>
    let context = Rc::try_unwrap(shared_ctx)
        .map_err(|_| "Failed to recover script context".to_string())?
        .into_inner();

    result.map(|_| context)
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

    // Bookmark operations
    ops::bookmarks::register_bookmark_ops(ctx, &calcula, shared_ctx.clone())?;

    // Worksheet property operations
    ops::worksheet_props::register_worksheet_props_ops(ctx, &calcula, shared_ctx.clone())?;

    // Extended operations (view, navigation, formatting, data, display)
    ops::extended::register_extended_ops(ctx, &calcula, shared_ctx.clone())?;

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
            ctx_ref.borrow().console_output.borrow_mut().push(message);
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
