//! FILENAME: core/script-engine/src/ops/cells.rs
//! PURPOSE: Cell read/write operations for the script engine.
//! CONTEXT: Registers getCellValue, setCellValue, getRange, setRange, and
//! getCellFormula methods on the Calcula global object.

use rquickjs::{Function, Object};
use std::cell::RefCell;
use std::rc::Rc;

use crate::types::{ScriptContext, cell_value_to_string, string_to_cell_value};
use engine::cell::Cell;

/// Resolve sheet index: negative means active sheet.
fn resolve_sheet(ctx: &ScriptContext, sheet_index: i32) -> usize {
    if sheet_index < 0 {
        ctx.active_sheet
    } else {
        sheet_index as usize
    }
}

/// Register cell operations on the Calcula object.
pub fn register_cell_ops<'js>(
    ctx: &rquickjs::Ctx<'js>,
    calcula: &Object<'js>,
    shared_ctx: Rc<RefCell<ScriptContext>>,
) -> Result<(), String> {
    // getCellValue(row, col, sheetIndex?)
    {
        let sc = shared_ctx.clone();
        let func = Function::new(
            ctx.clone(),
            move |row: i32, col: i32, sheet_index: rquickjs::function::Opt<i32>| -> String {
                let ctx = sc.borrow();
                let si = resolve_sheet(&ctx, sheet_index.0.unwrap_or(-1));
                if let Some(grid) = ctx.grids.get(si) {
                    if let Some(cell) = grid.get_cell(row as u32, col as u32) {
                        return cell_value_to_string(&cell.value);
                    }
                }
                String::new()
            },
        )
        .map_err(|e| format!("Failed to create getCellValue: {}", e))?;
        calcula
            .set("getCellValue", func)
            .map_err(|e| format!("Failed to set getCellValue: {}", e))?;
    }

    // setCellValue(row, col, value, sheetIndex?)
    {
        let sc = shared_ctx.clone();
        let func = Function::new(
            ctx.clone(),
            move |row: i32,
                  col: i32,
                  value: String,
                  sheet_index: rquickjs::function::Opt<i32>| {
                let mut ctx = sc.borrow_mut();
                let si = resolve_sheet(&ctx, sheet_index.0.unwrap_or(-1));
                if let Some(grid) = ctx.grids.get_mut(si) {
                    let cell_value = string_to_cell_value(&value);
                    let style_index = grid
                        .get_cell(row as u32, col as u32)
                        .map(|c| c.style_index)
                        .unwrap_or(0);
                    let cell = Cell {
                        formula: None,
                        value: cell_value,
                        style_index,
                        rich_text: None,
                        cached_ast: None,
                    };
                    grid.set_cell(row as u32, col as u32, cell);
                    *ctx.cells_modified.borrow_mut() += 1;
                }
            },
        )
        .map_err(|e| format!("Failed to create setCellValue: {}", e))?;
        calcula
            .set("setCellValue", func)
            .map_err(|e| format!("Failed to set setCellValue: {}", e))?;
    }

    // getRange(startRow, startCol, endRow, endCol, sheetIndex?)
    {
        let sc = shared_ctx.clone();
        let func = Function::new(
            ctx.clone(),
            move |start_row: i32,
                  start_col: i32,
                  end_row: i32,
                  end_col: i32,
                  sheet_index: rquickjs::function::Opt<i32>|
                  -> String {
                let ctx = sc.borrow();
                let si = resolve_sheet(&ctx, sheet_index.0.unwrap_or(-1));
                let mut result: Vec<Vec<String>> = Vec::new();

                if let Some(grid) = ctx.grids.get(si) {
                    for r in start_row..=end_row {
                        let mut row_values: Vec<String> = Vec::new();
                        for c in start_col..=end_col {
                            let val = grid
                                .get_cell(r as u32, c as u32)
                                .map(|cell| cell_value_to_string(&cell.value))
                                .unwrap_or_default();
                            row_values.push(val);
                        }
                        result.push(row_values);
                    }
                }

                serde_json::to_string(&result).unwrap_or_else(|_| "[]".to_string())
            },
        )
        .map_err(|e| format!("Failed to create getRange: {}", e))?;
        calcula
            .set("getRange", func)
            .map_err(|e| format!("Failed to set getRange: {}", e))?;
    }

    // setRange(startRow, startCol, valuesJson, sheetIndex?)
    {
        let sc = shared_ctx.clone();
        let func = Function::new(
            ctx.clone(),
            move |start_row: i32,
                  start_col: i32,
                  values_json: String,
                  sheet_index: rquickjs::function::Opt<i32>| {
                let values: Vec<Vec<String>> = match serde_json::from_str(&values_json) {
                    Ok(v) => v,
                    Err(_) => return,
                };

                let mut ctx = sc.borrow_mut();
                let si = resolve_sheet(&ctx, sheet_index.0.unwrap_or(-1));
                let mut modified_count: u32 = 0;
                if let Some(grid) = ctx.grids.get_mut(si) {
                    for (ri, row_values) in values.iter().enumerate() {
                        for (ci, val) in row_values.iter().enumerate() {
                            let r = start_row as u32 + ri as u32;
                            let c = start_col as u32 + ci as u32;
                            let cell_value = string_to_cell_value(val);
                            let style_index =
                                grid.get_cell(r, c).map(|cell| cell.style_index).unwrap_or(0);
                            let cell = Cell {
                                formula: None,
                                value: cell_value,
                                style_index,
                                rich_text: None,
                                cached_ast: None,
                            };
                            grid.set_cell(r, c, cell);
                            modified_count += 1;
                        }
                    }
                }
                *ctx.cells_modified.borrow_mut() += modified_count;
            },
        )
        .map_err(|e| format!("Failed to create setRange: {}", e))?;
        calcula
            .set("setRange", func)
            .map_err(|e| format!("Failed to set setRange: {}", e))?;
    }

    // getCellFormula(row, col, sheetIndex?)
    {
        let sc = shared_ctx.clone();
        let func = Function::new(
            ctx.clone(),
            move |row: i32, col: i32, sheet_index: rquickjs::function::Opt<i32>| -> String {
                let ctx = sc.borrow();
                let si = resolve_sheet(&ctx, sheet_index.0.unwrap_or(-1));
                if let Some(grid) = ctx.grids.get(si) {
                    if let Some(cell) = grid.get_cell(row as u32, col as u32) {
                        return cell.formula.clone().unwrap_or_default();
                    }
                }
                String::new()
            },
        )
        .map_err(|e| format!("Failed to create getCellFormula: {}", e))?;
        calcula
            .set("getCellFormula", func)
            .map_err(|e| format!("Failed to set getCellFormula: {}", e))?;
    }

    Ok(())
}
