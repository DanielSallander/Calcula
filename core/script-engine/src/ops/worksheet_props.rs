//! FILENAME: core/script-engine/src/ops/worksheet_props.rs
//! PURPOSE: Worksheet-level property operations for the script engine.
//! CONTEXT: Registers getUsedRange, getDisplayZeros, setDisplayZeros,
//! isDirty, and product methods on the Calcula global object.

use rquickjs::{Function, Object};
use std::cell::RefCell;
use std::rc::Rc;

use crate::types::{DeferredAction, ScriptContext};

/// Register worksheet property operations on the Calcula object.
pub fn register_worksheet_props_ops<'js>(
    ctx: &rquickjs::Ctx<'js>,
    calcula: &Object<'js>,
    shared_ctx: Rc<RefCell<ScriptContext>>,
) -> Result<(), String> {
    // getUsedRange() -> { startRow, startCol, endRow, endCol, empty }
    {
        let sc = shared_ctx.clone();
        let func = Function::new(ctx.clone(), move || -> String {
            let ctx = sc.borrow();
            let grid = &ctx.grids[ctx.active_sheet];

            if grid.cells.is_empty() {
                return serde_json::json!({
                    "startRow": 0,
                    "startCol": 0,
                    "endRow": 0,
                    "endCol": 0,
                    "empty": true
                })
                .to_string();
            }

            let mut min_row = u32::MAX;
            let mut min_col = u32::MAX;
            let mut max_row = 0u32;
            let mut max_col = 0u32;

            for &(row, col) in grid.cells.keys() {
                if row < min_row {
                    min_row = row;
                }
                if row > max_row {
                    max_row = row;
                }
                if col < min_col {
                    min_col = col;
                }
                if col > max_col {
                    max_col = col;
                }
            }

            serde_json::json!({
                "startRow": min_row,
                "startCol": min_col,
                "endRow": max_row,
                "endCol": max_col,
                "empty": false
            })
            .to_string()
        })
        .map_err(|e| format!("Failed to create getUsedRange: {}", e))?;
        calcula
            .set("getUsedRange", func)
            .map_err(|e| format!("Failed to set getUsedRange: {}", e))?;
    }

    // getDisplayZeros() -> bool
    {
        let sc = shared_ctx.clone();
        let func = Function::new(ctx.clone(), move || -> bool {
            sc.borrow().display_zeros
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
            ctx.display_zeros = value;
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
            sc.borrow().is_dirty
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
