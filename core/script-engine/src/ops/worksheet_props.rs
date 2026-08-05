//! FILENAME: core/script-engine/src/ops/worksheet_props.rs
//! PURPOSE: Worksheet-level property operations for the script engine.
//! CONTEXT: Registers getUsedRange, getDisplayZeros, setDisplayZeros,
//! isDirty, and product methods on the Calcula global object.

use rquickjs::{Ctx, Function, Object, Value};
use std::cell::RefCell;
use std::rc::Rc;

use crate::ops::resolve_opt_sheet_key;
use crate::types::{DeferredAction, ScriptContext};

/// Register worksheet property operations on the Calcula object.
pub fn register_worksheet_props_ops<'js>(
    ctx: &rquickjs::Ctx<'js>,
    calcula: &Object<'js>,
    shared_ctx: Rc<RefCell<ScriptContext>>,
) -> Result<(), String> {
    // getUsedRange(sheet?) -> { startRow, startCol, endRow, endCol, empty }
    // The algorithm is engine::navigation::used_range, the SAME function
    // behind the get_used_range Tauri command. `sheet` is a 0-based index or
    // a sheet name (ops/mod.rs resolver); absent = the active sheet.
    {
        let sc = shared_ctx.clone();
        let func = Function::new(
            ctx.clone(),
            move |ctx: Ctx<'js>,
                  sheet: rquickjs::function::Opt<Value<'js>>|
                  -> rquickjs::Result<String> {
                let ctx_ref = sc.borrow();
                let si = resolve_opt_sheet_key(&ctx, &ctx_ref, sheet.0.as_ref())?;
                let grid = &ctx_ref.grids[si];

                let json = match engine::navigation::used_range(grid) {
                    Some((start_row, start_col, end_row, end_col)) => serde_json::json!({
                        "startRow": start_row,
                        "startCol": start_col,
                        "endRow": end_row,
                        "endCol": end_col,
                        "empty": false
                    }),
                    None => serde_json::json!({
                        "startRow": 0,
                        "startCol": 0,
                        "endRow": 0,
                        "endCol": 0,
                        "empty": true
                    }),
                };
                Ok(json.to_string())
            },
        )
        .map_err(|e| format!("Failed to create getUsedRange: {}", e))?;
        calcula
            .set("getUsedRange", func)
            .map_err(|e| format!("Failed to set getUsedRange: {}", e))?;
    }

    // getDisplayZeros() -> bool
    {
        let sc = shared_ctx.clone();
        let func = Function::new(ctx.clone(), move || -> bool {
            sc.borrow().host.display_zeros
        })
        .map_err(|e| format!("Failed to create getDisplayZeros: {}", e))?;
        calcula
            .set("getDisplayZeros", func)
            .map_err(|e| format!("Failed to set getDisplayZeros: {}", e))?;
    }

    // setDisplayZeros(value) - updates local state and queues a deferred action
    {
        let sc = shared_ctx.clone();
        let func = Function::new(ctx.clone(), move |value: bool| {
            let mut ctx = sc.borrow_mut();
            ctx.host.display_zeros = value;
            ctx.deferred_actions
                .borrow_mut()
                .push(DeferredAction::SetDisplayZeros { value });
        })
        .map_err(|e| format!("Failed to create setDisplayZeros: {}", e))?;
        calcula
            .set("setDisplayZeros", func)
            .map_err(|e| format!("Failed to set setDisplayZeros: {}", e))?;
    }

    // isDirty() -> bool
    {
        let sc = shared_ctx.clone();
        let func = Function::new(ctx.clone(), move || -> bool {
            sc.borrow().host.is_dirty
        })
        .map_err(|e| format!("Failed to create isDirty: {}", e))?;
        calcula
            .set("isDirty", func)
            .map_err(|e| format!("Failed to set isDirty: {}", e))?;
    }

    // scrollToCell(row, col) - scroll the grid to make the specified cell visible (without selecting)
    {
        let sc = shared_ctx.clone();
        let func = Function::new(ctx.clone(), move |row: i32, col: i32| {
            let ctx_ref = sc.borrow();
            ctx_ref
                .deferred_actions
                .borrow_mut()
                .push(DeferredAction::Goto {
                    row: row.max(0) as u32,
                    col: col.max(0) as u32,
                    end_row: None,
                    end_col: None,
                    sheet_index: ctx_ref.active_sheet,
                    select: false,
                });
        })
        .map_err(|e| format!("Failed to create scrollToCell: {}", e))?;
        calcula
            .set("scrollToCell", func)
            .map_err(|e| format!("Failed to set scrollToCell: {}", e))?;
    }

    // product(valuesJson) -> number
    // Takes a JSON array string of numbers and returns their product.
    {
        let func = Function::new(ctx.clone(), move |values_json: String| -> f64 {
            let values: Vec<f64> = match serde_json::from_str(&values_json) {
                Ok(v) => v,
                Err(_) => return f64::NAN,
            };
            if values.is_empty() {
                return 0.0;
            }
            values.iter().fold(1.0, |acc, &v| acc * v)
        })
        .map_err(|e| format!("Failed to create product: {}", e))?;
        calcula
            .set("product", func)
            .map_err(|e| format!("Failed to set product: {}", e))?;
    }

    Ok(())
}
