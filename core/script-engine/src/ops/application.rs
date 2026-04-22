//! FILENAME: core/script-engine/src/ops/application.rs
//! PURPOSE: Application-level operations for the script engine.
//! CONTEXT: Registers the Calcula.application namespace, modelled after
//! Excel's Application object. Provides read-only app metadata properties,
//! read-write control properties (screenUpdating, enableEvents), and
//! deferred action methods (calculate, goto, statusBar).

use rquickjs::{Function, Object};
use std::cell::RefCell;
use std::rc::Rc;

use crate::types::{DeferredAction, ScriptContext};

/// Register the `Calcula.application` sub-object with Application-level API.
///
/// After creating the object with Rust-backed functions, a small JS snippet
/// is evaluated to wire up getter/setter properties (screenUpdating,
/// enableEvents, statusBar, calculationMode) so scripts can use natural
/// property syntax: `Calcula.application.screenUpdating = false`.
pub fn register_application_ops<'js>(
    ctx: &rquickjs::Ctx<'js>,
    calcula: &Object<'js>,
    shared_ctx: Rc<RefCell<ScriptContext>>,
) -> Result<(), String> {
    let app = Object::new(ctx.clone())
        .map_err(|e| format!("Failed to create application object: {}", e))?;

    // -- Read-only properties (set once) --
    {
        let sc = shared_ctx.borrow();
        app.set("name", sc.app_info.name.clone())
            .map_err(|e| format!("Failed to set application.name: {}", e))?;
        app.set("version", sc.app_info.version.clone())
            .map_err(|e| format!("Failed to set application.version: {}", e))?;
        app.set("operatingSystem", sc.app_info.operating_system.clone())
            .map_err(|e| format!("Failed to set application.operatingSystem: {}", e))?;
        app.set("pathSeparator", sc.app_info.path_separator.clone())
            .map_err(|e| format!("Failed to set application.pathSeparator: {}", e))?;
        app.set("decimalSeparator", sc.app_info.decimal_separator.clone())
            .map_err(|e| format!("Failed to set application.decimalSeparator: {}", e))?;
        app.set("thousandsSeparator", sc.app_info.thousands_separator.clone())
            .map_err(|e| format!("Failed to set application.thousandsSeparator: {}", e))?;
    }

    // -- Internal getter/setter functions for writable properties --
    // These are prefixed with __ and later wired to JS getter/setter properties.

    // screenUpdating
    {
        let sc = shared_ctx.clone();
        let getter = Function::new(ctx.clone(), move || -> bool {
            *sc.borrow().screen_updating.borrow()
        })
        .map_err(|e| format!("Failed to create __getScreenUpdating: {}", e))?;
        app.set("__getScreenUpdating", getter)
            .map_err(|e| format!("Failed to set __getScreenUpdating: {}", e))?;
    }
    {
        let sc = shared_ctx.clone();
        let setter = Function::new(ctx.clone(), move |value: bool| {
            *sc.borrow().screen_updating.borrow_mut() = value;
        })
        .map_err(|e| format!("Failed to create __setScreenUpdating: {}", e))?;
        app.set("__setScreenUpdating", setter)
            .map_err(|e| format!("Failed to set __setScreenUpdating: {}", e))?;
    }

    // enableEvents
    {
        let sc = shared_ctx.clone();
        let getter = Function::new(ctx.clone(), move || -> bool {
            *sc.borrow().enable_events.borrow()
        })
        .map_err(|e| format!("Failed to create __getEnableEvents: {}", e))?;
        app.set("__getEnableEvents", getter)
            .map_err(|e| format!("Failed to set __getEnableEvents: {}", e))?;
    }
    {
        let sc = shared_ctx.clone();
        let setter = Function::new(ctx.clone(), move |value: bool| {
            *sc.borrow().enable_events.borrow_mut() = value;
        })
        .map_err(|e| format!("Failed to create __setEnableEvents: {}", e))?;
        app.set("__setEnableEvents", setter)
            .map_err(|e| format!("Failed to set __setEnableEvents: {}", e))?;
    }

    // statusBar (getter returns string or false, setter accepts string or false)
    {
        let sc = shared_ctx.clone();
        let getter = Function::new(ctx.clone(), move || -> String {
            // Return the last SetStatusBar message, or "false" if none
            let actions = sc.borrow().deferred_actions.borrow().clone();
            for action in actions.iter().rev() {
                if let DeferredAction::SetStatusBar { message } = action {
                    return match message {
                        Some(msg) => msg.clone(),
                        None => "false".to_string(),
                    };
                }
            }
            "false".to_string()
        })
        .map_err(|e| format!("Failed to create __getStatusBar: {}", e))?;
        app.set("__getStatusBar", getter)
            .map_err(|e| format!("Failed to set __getStatusBar: {}", e))?;
    }
    {
        let sc = shared_ctx.clone();
        let setter = Function::new(ctx.clone(), move |value: String| {
            let message = if value == "false" || value.is_empty() {
                None
            } else {
                Some(value)
            };
            sc.borrow()
                .deferred_actions
                .borrow_mut()
                .push(DeferredAction::SetStatusBar { message });
        })
        .map_err(|e| format!("Failed to create __setStatusBar: {}", e))?;
        app.set("__setStatusBar", setter)
            .map_err(|e| format!("Failed to set __setStatusBar: {}", e))?;
    }

    // calculationMode (read-only via getter, but stored as property for consistency)
    {
        let sc = shared_ctx.clone();
        let getter = Function::new(ctx.clone(), move || -> String {
            sc.borrow().app_info.calculation_mode.clone()
        })
        .map_err(|e| format!("Failed to create __getCalculationMode: {}", e))?;
        app.set("__getCalculationMode", getter)
            .map_err(|e| format!("Failed to set __getCalculationMode: {}", e))?;
    }

    // -- Methods --

    // calculate() - request full recalculation after script completes
    {
        let sc = shared_ctx.clone();
        let func = Function::new(ctx.clone(), move || {
            sc.borrow()
                .deferred_actions
                .borrow_mut()
                .push(DeferredAction::Calculate);
        })
        .map_err(|e| format!("Failed to create application.calculate: {}", e))?;
        app.set("calculate", func)
            .map_err(|e| format!("Failed to set application.calculate: {}", e))?;
    }

    // goto(row, col, sheetIndex?) - navigate to a cell after script completes
    {
        let sc = shared_ctx.clone();
        let func = Function::new(
            ctx.clone(),
            move |row: i32, col: i32, sheet_index: rquickjs::function::Opt<i32>| {
                let ctx_ref = sc.borrow();
                let si = match sheet_index.0 {
                    Some(i) if i >= 0 => i as usize,
                    _ => ctx_ref.active_sheet,
                };
                ctx_ref
                    .deferred_actions
                    .borrow_mut()
                    .push(DeferredAction::Goto {
                        row: row.max(0) as u32,
                        col: col.max(0) as u32,
                        sheet_index: si,
                        select: true,
                    });
            },
        )
        .map_err(|e| format!("Failed to create application.goto: {}", e))?;
        app.set("goto", func)
            .map_err(|e| format!("Failed to set application.goto: {}", e))?;
    }

    // Set the application object on Calcula
    calcula
        .set("application", app)
        .map_err(|e| format!("Failed to set Calcula.application: {}", e))?;

    // -- Wire up getter/setter properties via JavaScript --
    // This replaces the __ internal functions with proper get/set property descriptors
    // so scripts can write: Calcula.application.screenUpdating = false
    let define_props_js = r#"
(function() {
    var app = Calcula.application;
    var props = {
        screenUpdating:  { get: app.__getScreenUpdating,  set: app.__setScreenUpdating },
        enableEvents:    { get: app.__getEnableEvents,    set: app.__setEnableEvents },
        statusBar:       { get: app.__getStatusBar,       set: app.__setStatusBar },
        calculationMode: { get: app.__getCalculationMode },
    };
    for (var name in props) {
        var desc = props[name];
        desc.configurable = true;
        desc.enumerable = true;
        Object.defineProperty(app, name, desc);
    }
    // Clean up internal helpers
    delete app.__getScreenUpdating;
    delete app.__setScreenUpdating;
    delete app.__getEnableEvents;
    delete app.__setEnableEvents;
    delete app.__getStatusBar;
    delete app.__setStatusBar;
    delete app.__getCalculationMode;
})();
"#;

    let eval_result: rquickjs::Result<rquickjs::Value> = ctx.eval(define_props_js);
    eval_result.map_err(|e| format!("Failed to define application properties: {}", e))?;

    Ok(())
}
