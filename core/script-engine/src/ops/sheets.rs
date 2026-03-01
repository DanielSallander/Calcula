//! FILENAME: core/script-engine/src/ops/sheets.rs
//! PURPOSE: Sheet-related operations for the script engine.
//! CONTEXT: Registers getActiveSheet, getSheetNames, setActiveSheet, and
//! getSheetCount methods on the Calcula global object.

use rquickjs::{Function, Object};
use std::cell::RefCell;
use std::rc::Rc;

use crate::types::ScriptContext;

/// Register sheet operations on the Calcula object.
pub fn register_sheet_ops<'js>(
    ctx: &rquickjs::Ctx<'js>,
    calcula: &Object<'js>,
    shared_ctx: Rc<RefCell<ScriptContext>>,
) -> Result<(), String> {
    // getActiveSheet() -> { index, name }
    {
        let sc = shared_ctx.clone();
        let func = Function::new(ctx.clone(), move || -> String {
            let ctx = sc.borrow();
            let index = ctx.active_sheet;
            let name = ctx
                .sheet_names
                .get(index)
                .cloned()
                .unwrap_or_else(|| format!("Sheet{}", index + 1));
            serde_json::json!({
                "index": index,
                "name": name
            })
            .to_string()
        })
        .map_err(|e| format!("Failed to create getActiveSheet: {}", e))?;
        calcula
            .set("getActiveSheet", func)
            .map_err(|e| format!("Failed to set getActiveSheet: {}", e))?;
    }

    // getSheetNames() -> string[]
    {
        let sc = shared_ctx.clone();
        let func = Function::new(ctx.clone(), move || -> String {
            let ctx = sc.borrow();
            serde_json::to_string(&ctx.sheet_names).unwrap_or_else(|_| "[]".to_string())
        })
        .map_err(|e| format!("Failed to create getSheetNames: {}", e))?;
        calcula
            .set("getSheetNames", func)
            .map_err(|e| format!("Failed to set getSheetNames: {}", e))?;
    }

    // setActiveSheet(index)
    {
        let sc = shared_ctx.clone();
        let func = Function::new(ctx.clone(), move |index: i32| {
            let mut ctx = sc.borrow_mut();
            if (index as usize) < ctx.grids.len() {
                ctx.active_sheet = index as usize;
            }
        })
        .map_err(|e| format!("Failed to create setActiveSheet: {}", e))?;
        calcula
            .set("setActiveSheet", func)
            .map_err(|e| format!("Failed to set setActiveSheet: {}", e))?;
    }

    // getSheetCount() -> number
    {
        let sc = shared_ctx.clone();
        let func = Function::new(ctx.clone(), move || -> i32 {
            let ctx = sc.borrow();
            ctx.grids.len() as i32
        })
        .map_err(|e| format!("Failed to create getSheetCount: {}", e))?;
        calcula
            .set("getSheetCount", func)
            .map_err(|e| format!("Failed to set getSheetCount: {}", e))?;
    }

    Ok(())
}
