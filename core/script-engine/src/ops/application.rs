//! FILENAME: core/script-engine/src/ops/application.rs
//! PURPOSE: Application-level operations for the script engine.
//! CONTEXT: Registers the Calcula.application namespace, modelled after
//! Excel's Application object. Provides read-only app metadata properties,
//! read-write control properties (screenUpdating, statusBar), and
//! deferred action methods (calculate, goto, statusBar).

use rquickjs::{Ctx, Function, Object, Value};
use std::cell::RefCell;
use std::rc::Rc;

use crate::ops::resolve_opt_sheet_key;
use crate::types::{DeferredAction, ScriptContext};

/// Register the `Calcula.application` sub-object with Application-level API.
///
/// After creating the object with Rust-backed functions, a small JS snippet
/// is evaluated to wire up getter/setter properties (screenUpdating,
/// statusBar, calculationMode) so scripts can use natural
/// property syntax: `Calcula.application.screenUpdating = false`.
pub fn register_application_ops<'js>(
    ctx: &rquickjs::Ctx<'js>,
    calcula: &Object<'js>,
    shared_ctx: Rc<RefCell<ScriptContext>>,
) -> Result<(), String> {
    let app = Object::new(ctx.clone())
        .map_err(|e| format!("Failed to create application object: {}", e))?;

    // -- Read-only properties --
    //
    // Backed by GETTERS, not values snapshotted at registration time: a
    // notebook session registers this object once but lives across many cell
    // runs, and the host re-applies `app_info` before each run. Freezing the
    // values here would pin a sv-SE user's `decimalSeparator` to whatever was
    // true when the session started (and, for a session created before the app
    // finished hydrating, to the "." default forever).
    {
        let read_only: [(&str, fn(&crate::types::AppInfo) -> String); 6] = [
            ("name", |a| a.name.clone()),
            ("version", |a| a.version.clone()),
            ("operatingSystem", |a| a.operating_system.clone()),
            ("pathSeparator", |a| a.path_separator.clone()),
            ("decimalSeparator", |a| a.decimal_separator.clone()),
            ("thousandsSeparator", |a| a.thousands_separator.clone()),
        ];
        for (name, pick) in read_only {
            let sc = shared_ctx.clone();
            let getter = Function::new(ctx.clone(), move || -> String {
                pick(&sc.borrow().app_info)
            })
            .map_err(|e| format!("Failed to create __get_{}: {}", name, e))?;
            app.set(format!("__get_{}", name), getter)
                .map_err(|e| format!("Failed to set __get_{}: {}", name, e))?;
        }
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

    // enableEvents IS DELIBERATELY ABSENT — do not re-add it without wiring it.
    //
    // It used to exist here: readable, writable, reported on the run result, and
    // consumed by NOBODY. `Application.EnableEvents = False` means one thing to
    // a VBA author — "do not let my writes trigger anybody's change handlers" —
    // and Calcula could not honour it, because this surface has no event
    // delivery to suppress. Cell writes from a QuickJS run are applied by the
    // host and announced with a bare grid repaint; they do not travel through
    // the cell-event bus that object-script handlers listen on, so there was
    // never a storm for the flag to prevent. A property that always answers
    // "yes, events are on" while promising it can turn them off is worse than a
    // missing one: it makes a script author believe they are protected.
    //
    // The re-entrancy this flag exists to prevent IS handled in Calcula, but
    // structurally rather than by a switch: the object-script broker attributes
    // every write to the script that made it and suppresses that script's own
    // echo (see `recordScriptWrite` / `isOwnScriptWrite` in
    // app/src/api/scriptHost/host.ts). That guard cannot be forgotten, cannot be
    // left switched off by a script that faulted halfway through, and does not
    // need the author to know it exists.
    //
    // If a future surface DOES deliver events to these scripts, the flag can
    // come back — but only together with the code that reads it, and only once
    // "which events, for how long" has an answer written down.

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

    // goto(row, col, sheet?) - navigate to a cell after script completes.
    // goto(address)         - A1 form: "B3", "A1:C5", "Sheet2!A1:B2",
    //                         "'My Sheet'!A1". A range address selects the
    //                         WHOLE range (endRow/endCol on the action); the
    //                         sheet comes from the address prefix (or the
    //                         active sheet without one). Extra arguments after
    //                         an address THROW instead of being ignored.
    // `sheet` is a 0-based index or a sheet name; a miss THROWS (ops/mod.rs).
    {
        let sc = shared_ctx.clone();
        let func = Function::new(
            ctx.clone(),
            move |ctx: Ctx<'js>,
                  first: Value<'js>,
                  col: rquickjs::function::Opt<Value<'js>>,
                  sheet: rquickjs::function::Opt<Value<'js>>|
                  -> rquickjs::Result<()> {
                let ctx_ref = sc.borrow();
                if let Some(s) = first.as_string() {
                    // A1 form.
                    let address = s.to_string()?;
                    let extra_arg_given = col
                        .0
                        .as_ref()
                        .map(|v| !v.is_undefined() && !v.is_null())
                        .unwrap_or(false)
                        || sheet
                            .0
                            .as_ref()
                            .map(|v| !v.is_undefined() && !v.is_null())
                            .unwrap_or(false);
                    if extra_arg_given {
                        return Err(rquickjs::Exception::throw_message(
                            &ctx,
                            "goto(address) takes no additional arguments - put the sheet in the address prefix (e.g. \"Sheet2!A1:B5\")",
                        ));
                    }
                    let (b, target_sheet) = crate::ops::canonical_model::parse_a1(
                        &address,
                        &ctx_ref.sheet_names,
                        ctx_ref.active_sheet,
                    )
                    .map_err(|e| rquickjs::Exception::throw_message(&ctx, &e))?;
                    let is_single = b.start_row == b.end_row && b.start_col == b.end_col;
                    ctx_ref
                        .deferred_actions
                        .borrow_mut()
                        .push(DeferredAction::Goto {
                            row: b.start_row,
                            col: b.start_col,
                            end_row: if is_single { None } else { Some(b.end_row) },
                            end_col: if is_single { None } else { Some(b.end_col) },
                            sheet_index: target_sheet,
                            select: true,
                        });
                    return Ok(());
                }

                // Numeric form: goto(row, col, sheet?).
                let row = first.as_number().ok_or_else(|| {
                    rquickjs::Exception::throw_message(
                        &ctx,
                        "goto expects (row, col, sheet?) or an A1 address string",
                    )
                })?;
                let col_num = col.0.as_ref().and_then(|v| v.as_number()).ok_or_else(|| {
                    rquickjs::Exception::throw_message(
                        &ctx,
                        "goto expects (row, col, sheet?) or an A1 address string",
                    )
                })?;
                let si = resolve_opt_sheet_key(&ctx, &ctx_ref, sheet.0.as_ref())?;
                ctx_ref
                    .deferred_actions
                    .borrow_mut()
                    .push(DeferredAction::Goto {
                        row: (row as i64).max(0) as u32,
                        col: (col_num as i64).max(0) as u32,
                        end_row: None,
                        end_col: None,
                        sheet_index: si,
                        select: true,
                    });
                Ok(())
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
        statusBar:       { get: app.__getStatusBar,       set: app.__setStatusBar },
        calculationMode: { get: app.__getCalculationMode },
    };
    // Read-only app metadata: same getter treatment, so each read sees the
    // host state re-applied for the CURRENT run.
    var readOnly = ['name', 'version', 'operatingSystem', 'pathSeparator',
                    'decimalSeparator', 'thousandsSeparator'];
    for (var i = 0; i < readOnly.length; i++) {
        props[readOnly[i]] = { get: app['__get_' + readOnly[i]] };
    }
    for (var name in props) {
        var desc = props[name];
        desc.configurable = true;
        desc.enumerable = true;
        Object.defineProperty(app, name, desc);
    }
    // Clean up internal helpers
    delete app.__getScreenUpdating;
    delete app.__setScreenUpdating;
    delete app.__getStatusBar;
    delete app.__setStatusBar;
    delete app.__getCalculationMode;
    for (var j = 0; j < readOnly.length; j++) {
        delete app['__get_' + readOnly[j]];
    }
})();
"#;

    let eval_result: rquickjs::Result<rquickjs::Value> = ctx.eval(define_props_js);
    eval_result.map_err(|e| format!("Failed to define application properties: {}", e))?;

    Ok(())
}
