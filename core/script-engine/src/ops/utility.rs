//! FILENAME: core/script-engine/src/ops/utility.rs
//! PURPOSE: Utility operations for the script engine (Calcula.log).
//! CONTEXT: Provides logging capability for script debugging output.

use rquickjs::{Function, Object};
use std::cell::RefCell;
use std::rc::Rc;

use crate::types::ScriptContext;

/// Register utility operations on the Calcula object.
pub fn register_utility_ops<'js>(
    ctx: &rquickjs::Ctx<'js>,
    calcula: &Object<'js>,
    shared_ctx: Rc<RefCell<ScriptContext>>,
) -> Result<(), String> {
    // log(...args) - same as console.log
    {
        let sc = shared_ctx.clone();
        let func = Function::new(
            ctx.clone(),
            move |args: rquickjs::function::Rest<String>| {
                let message = args.0.join(" ");
                sc.borrow().console_output.borrow_mut().push(message);
            },
        )
        .map_err(|e| format!("Failed to create Calcula.log: {}", e))?;
        calcula
            .set("log", func)
            .map_err(|e| format!("Failed to set Calcula.log: {}", e))?;
    }

    Ok(())
}
