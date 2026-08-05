//! FILENAME: core/script-engine/src/ops/cells.rs
//! PURPOSE: Cell read/write operations for the script engine.
//! CONTEXT: Registers getCellValue, setCellValue, getRange, setRange, and
//! getCellFormula methods on the Calcula global object.
//!
//! Sheet parameters accept a 0-based index OR a sheet name and THROW on a
//! miss (see ops/mod.rs resolve_opt_sheet_key). Writes are TYPED: a JS
//! number lands as a numeric cell, a boolean as a boolean cell, and `null`
//! CLEARS the cell; strings go through the same keystroke-style coercion as
//! before ("5" becomes numeric, "TRUE" boolean) — mirroring the worker-side
//! (TS) script surface.

use rquickjs::{Ctx, Function, Object, Value};
use std::cell::RefCell;
use std::rc::Rc;

use crate::ops::resolve_opt_sheet_key;
use crate::types::{
    cell_value_to_string, string_to_cell_value, write_is_effective, ScriptContext,
};
use engine::cell::{Cell, CellValue};

/// Convert a JS value to a CellValue with the typed-write semantics:
/// `null`/`undefined` clear, numbers land numeric, booleans stay boolean,
/// strings coerce like a keystroke. Anything else (object, array, function)
/// throws — silently stringifying `[object Object]` into the grid is a bug,
/// not a write.
pub(crate) fn js_value_to_cell_value<'js>(
    ctx: &Ctx<'js>,
    value: &Value<'js>,
) -> rquickjs::Result<CellValue> {
    if value.is_undefined() || value.is_null() {
        return Ok(CellValue::Empty);
    }
    if let Some(b) = value.as_bool() {
        return Ok(CellValue::Boolean(b));
    }
    if let Some(n) = value.as_number() {
        // Reject NaN/Infinity like the worker-realm validator does ("value
        // must be a finite number") — a grid cell holding NaN is corruption,
        // not a write.
        if !n.is_finite() {
            return Err(rquickjs::Exception::throw_message(
                ctx,
                "Cell values must be finite numbers (got NaN or Infinity)",
            ));
        }
        return Ok(CellValue::Number(n));
    }
    if let Some(s) = value.as_string() {
        return Ok(string_to_cell_value(&s.to_string()?));
    }
    Err(rquickjs::Exception::throw_message(
        ctx,
        "Cell values must be a string, number, boolean, or null (null clears the cell)",
    ))
}

/// Convert a serde_json value (from a JSON-string `setRange` payload) to a
/// CellValue with the SAME typed-write semantics as js_value_to_cell_value.
fn json_value_to_cell_value(value: &serde_json::Value) -> Result<CellValue, String> {
    match value {
        serde_json::Value::Null => Ok(CellValue::Empty),
        serde_json::Value::Bool(b) => Ok(CellValue::Boolean(*b)),
        serde_json::Value::Number(n) => n
            .as_f64()
            .map(CellValue::Number)
            .ok_or_else(|| format!("Unrepresentable number in setRange values: {}", n)),
        serde_json::Value::String(s) => Ok(string_to_cell_value(s)),
        other => Err(format!(
            "setRange values must be strings, numbers, booleans, or null — got {}",
            match other {
                serde_json::Value::Array(_) => "a nested array",
                _ => "an object",
            }
        )),
    }
}

/// Write a typed value into a grid cell, preserving the existing style index.
/// Returns true when the write was EFFECTIVE (actually changed the grid).
pub(crate) fn write_typed_cell(
    ctx: &mut ScriptContext,
    sheet_index: usize,
    row: u32,
    col: u32,
    new_value: CellValue,
) -> bool {
    if let Some(grid) = ctx.grids.get_mut(sheet_index) {
        let existing = grid.get_cell(row, col);
        let style_index = existing.map(|c| c.style_index).unwrap_or(0);
        // Count EFFECTIVE changes only: writing the value a cell already
        // holds is not a modification.
        let effective = write_is_effective(existing, &new_value);
        let cell = Cell {
            ast: None,
            value: new_value,
            style_index,
            rich_text: None,
        };
        grid.set_cell(row, col, cell);
        effective
    } else {
        false
    }
}

/// Register cell operations on the Calcula object.
pub fn register_cell_ops<'js>(
    ctx: &rquickjs::Ctx<'js>,
    calcula: &Object<'js>,
    shared_ctx: Rc<RefCell<ScriptContext>>,
) -> Result<(), String> {
    // getCellValue(row, col, sheet?) — sheet is an index or a name.
    {
        let sc = shared_ctx.clone();
        let func = Function::new(
            ctx.clone(),
            move |ctx: Ctx<'js>,
                  row: i32,
                  col: i32,
                  sheet: rquickjs::function::Opt<Value<'js>>|
                  -> rquickjs::Result<String> {
                let ctx_ref = sc.borrow();
                let si = resolve_opt_sheet_key(&ctx, &ctx_ref, sheet.0.as_ref())?;
                if let Some(grid) = ctx_ref.grids.get(si) {
                    if let Some(cell) = grid.get_cell(row as u32, col as u32) {
                        return Ok(cell_value_to_string(&cell.value));
                    }
                }
                Ok(String::new())
            },
        )
        .map_err(|e| format!("Failed to create getCellValue: {}", e))?;
        calcula
            .set("getCellValue", func)
            .map_err(|e| format!("Failed to set getCellValue: {}", e))?;
    }

    // setCellValue(row, col, value, sheet?) — typed write; sheet is an index
    // or a name.
    {
        let sc = shared_ctx.clone();
        let func = Function::new(
            ctx.clone(),
            move |ctx: Ctx<'js>,
                  row: i32,
                  col: i32,
                  value: Value<'js>,
                  sheet: rquickjs::function::Opt<Value<'js>>|
                  -> rquickjs::Result<()> {
                let cell_value = js_value_to_cell_value(&ctx, &value)?;
                let si = resolve_opt_sheet_key(&ctx, &sc.borrow(), sheet.0.as_ref())?;
                let mut ctx_ref = sc.borrow_mut();
                if write_typed_cell(&mut ctx_ref, si, row as u32, col as u32, cell_value) {
                    *ctx_ref.cells_modified.borrow_mut() += 1;
                }
                Ok(())
            },
        )
        .map_err(|e| format!("Failed to create setCellValue: {}", e))?;
        calcula
            .set("setCellValue", func)
            .map_err(|e| format!("Failed to set setCellValue: {}", e))?;
    }

    // getRange(startRow, startCol, endRow, endCol, sheet?) — sheet is an
    // index or a name.
    {
        let sc = shared_ctx.clone();
        let func = Function::new(
            ctx.clone(),
            move |ctx: Ctx<'js>,
                  start_row: i32,
                  start_col: i32,
                  end_row: i32,
                  end_col: i32,
                  sheet: rquickjs::function::Opt<Value<'js>>|
                  -> rquickjs::Result<String> {
                let ctx_ref = sc.borrow();
                let si = resolve_opt_sheet_key(&ctx, &ctx_ref, sheet.0.as_ref())?;
                let mut result: Vec<Vec<String>> = Vec::new();

                if let Some(grid) = ctx_ref.grids.get(si) {
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

                Ok(serde_json::to_string(&result).unwrap_or_else(|_| "[]".to_string()))
            },
        )
        .map_err(|e| format!("Failed to create getRange: {}", e))?;
        calcula
            .set("getRange", func)
            .map_err(|e| format!("Failed to set getRange: {}", e))?;
    }

    // setRange(startRow, startCol, values, sheet?) — typed write. `values`
    // is a 2D JS array (string|number|boolean|null cells) or, equivalently,
    // its JSON.stringify'd form. A malformed payload THROWS — it used to
    // silently write nothing.
    {
        let sc = shared_ctx.clone();
        let func = Function::new(
            ctx.clone(),
            move |ctx: Ctx<'js>,
                  start_row: i32,
                  start_col: i32,
                  values: Value<'js>,
                  sheet: rquickjs::function::Opt<Value<'js>>|
                  -> rquickjs::Result<()> {
                // Normalize both accepted shapes into typed CellValues first,
                // so a malformed payload throws BEFORE any cell is touched.
                let mut typed: Vec<Vec<CellValue>> = Vec::new();
                if let Some(s) = values.as_string() {
                    let json = s.to_string()?;
                    let parsed: Vec<Vec<serde_json::Value>> = serde_json::from_str(&json)
                        .map_err(|e| {
                            rquickjs::Exception::throw_message(
                                &ctx,
                                &format!("setRange values must be a 2D array (JSON parse failed: {})", e),
                            )
                        })?;
                    for row in &parsed {
                        let mut out_row: Vec<CellValue> = Vec::with_capacity(row.len());
                        for v in row {
                            out_row.push(json_value_to_cell_value(v).map_err(|msg| {
                                rquickjs::Exception::throw_message(&ctx, &msg)
                            })?);
                        }
                        typed.push(out_row);
                    }
                } else if let Some(arr) = values.as_array() {
                    for row_val in arr.iter::<Value<'js>>() {
                        let row_val = row_val?;
                        let row_arr = row_val.as_array().ok_or_else(|| {
                            rquickjs::Exception::throw_message(
                                &ctx,
                                "setRange values must be a 2D array (an array of row arrays)",
                            )
                        })?;
                        let mut out_row: Vec<CellValue> = Vec::with_capacity(row_arr.len() as usize);
                        for cell_val in row_arr.iter::<Value<'js>>() {
                            out_row.push(js_value_to_cell_value(&ctx, &cell_val?)?);
                        }
                        typed.push(out_row);
                    }
                } else {
                    return Err(rquickjs::Exception::throw_message(
                        &ctx,
                        "setRange values must be a 2D array (or its JSON string form)",
                    ));
                }

                let si = resolve_opt_sheet_key(&ctx, &sc.borrow(), sheet.0.as_ref())?;
                let mut ctx_ref = sc.borrow_mut();
                let mut modified_count: u32 = 0;
                for (ri, row_values) in typed.into_iter().enumerate() {
                    for (ci, cell_value) in row_values.into_iter().enumerate() {
                        let r = start_row as u32 + ri as u32;
                        let c = start_col as u32 + ci as u32;
                        // Effective-change counting (see setCellValue):
                        // rewriting a range with identical values reports 0.
                        if write_typed_cell(&mut ctx_ref, si, r, c, cell_value) {
                            modified_count += 1;
                        }
                    }
                }
                *ctx_ref.cells_modified.borrow_mut() += modified_count;
                Ok(())
            },
        )
        .map_err(|e| format!("Failed to create setRange: {}", e))?;
        calcula
            .set("setRange", func)
            .map_err(|e| format!("Failed to set setRange: {}", e))?;
    }

    // getCellFormula(row, col, sheet?) — sheet is an index or a name.
    {
        let sc = shared_ctx.clone();
        let func = Function::new(
            ctx.clone(),
            move |ctx: Ctx<'js>,
                  row: i32,
                  col: i32,
                  sheet: rquickjs::function::Opt<Value<'js>>|
                  -> rquickjs::Result<String> {
                let ctx_ref = sc.borrow();
                let si = resolve_opt_sheet_key(&ctx, &ctx_ref, sheet.0.as_ref())?;
                if let Some(grid) = ctx_ref.grids.get(si) {
                    if let Some(cell) = grid.get_cell(row as u32, col as u32) {
                        return Ok(cell.formula_string().unwrap_or_default());
                    }
                }
                Ok(String::new())
            },
        )
        .map_err(|e| format!("Failed to create getCellFormula: {}", e))?;
        calcula
            .set("getCellFormula", func)
            .map_err(|e| format!("Failed to set getCellFormula: {}", e))?;
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use crate::types::ScriptResult;
    use crate::ScriptEngine;
    use engine::cell::{Cell, CellValue};
    use engine::grid::Grid;
    use engine::style::StyleRegistry;

    /// Three empty grids named "Alpha"/"Beta"/"Data Two".
    fn three_sheets() -> (Vec<Grid>, StyleRegistry, Vec<String>) {
        let grids = vec![Grid::new(), Grid::new(), Grid::new()];
        let registry = StyleRegistry::new();
        let names = vec![
            "Alpha".to_string(),
            "Beta".to_string(),
            "Data Two".to_string(),
        ];
        (grids, registry, names)
    }

    fn run(
        src: &str,
        grids: Vec<Grid>,
        registry: StyleRegistry,
        names: Vec<String>,
        active: usize,
    ) -> (ScriptResult, Vec<Grid>) {
        ScriptEngine::run(src, "test.js", grids, registry, names, active)
    }

    fn expect_success(result: &ScriptResult) {
        if let ScriptResult::Error { message, .. } = result {
            panic!("script error: {message}");
        }
    }

    fn expect_error(result: &ScriptResult) -> String {
        match result {
            ScriptResult::Error { message, .. } => message.clone(),
            ScriptResult::Success { .. } => panic!("expected the script to throw"),
        }
    }

    #[test]
    fn set_cell_value_accepts_sheet_name() {
        let (grids, registry, names) = three_sheets();
        let (result, grids) = run(
            r#"Calcula.setCellValue(0, 0, "on-beta", "Beta");"#,
            grids,
            registry,
            names,
            0,
        );
        expect_success(&result);
        assert_eq!(
            grids[1].get_cell(0, 0).unwrap().value,
            CellValue::Text("on-beta".to_string())
        );
        assert!(grids[0].get_cell(0, 0).is_none(), "Alpha must be untouched");
    }

    #[test]
    fn sheet_name_resolves_case_insensitively_when_unique() {
        let (grids, registry, names) = three_sheets();
        let (result, grids) = run(
            r#"Calcula.setCellValue(0, 0, "x", "beta"); Calcula.setCellValue(1, 0, "y", "DATA TWO");"#,
            grids,
            registry,
            names,
            0,
        );
        expect_success(&result);
        assert!(grids[1].get_cell(0, 0).is_some());
        assert!(grids[2].get_cell(1, 0).is_some());
    }

    #[test]
    fn unknown_sheet_name_throws_listing_sheets() {
        let (grids, registry, names) = three_sheets();
        let (result, grids) = run(
            r#"Calcula.setCellValue(0, 0, "x", "Nope");"#,
            grids,
            registry,
            names,
            0,
        );
        let msg = expect_error(&result);
        assert!(msg.contains("No sheet named \"Nope\""), "{msg}");
        assert!(msg.contains("\"Alpha\""), "{msg}");
        assert!(msg.contains("\"Beta\""), "{msg}");
        assert!(msg.contains("\"Data Two\""), "{msg}");
        assert!(grids.iter().all(|g| g.get_cell(0, 0).is_none()));
    }

    #[test]
    fn out_of_range_sheet_index_throws() {
        let (grids, registry, names) = three_sheets();
        let (result, _grids) = run(
            r#"Calcula.getCellValue(0, 0, 99);"#,
            grids,
            registry,
            names,
            0,
        );
        let msg = expect_error(&result);
        assert!(msg.contains("out of range"), "{msg}");
    }

    #[test]
    fn negative_sheet_index_still_means_active_sheet() {
        let (grids, registry, names) = three_sheets();
        let (result, grids) = run(
            r#"Calcula.setCellValue(0, 0, "here", -1);"#,
            grids,
            registry,
            names,
            1,
        );
        expect_success(&result);
        assert!(grids[1].get_cell(0, 0).is_some());
    }

    #[test]
    fn typed_writes_land_typed() {
        let (grids, registry, names) = three_sheets();
        let (result, grids) = run(
            r#"
                Calcula.setCellValue(0, 0, 42);
                Calcula.setCellValue(0, 1, 1.5);
                Calcula.setCellValue(0, 2, true);
                Calcula.setCellValue(0, 3, "text");
                Calcula.setCellValue(0, 4, "7");
            "#,
            grids,
            registry,
            names,
            0,
        );
        expect_success(&result);
        let g = &grids[0];
        assert_eq!(g.get_cell(0, 0).unwrap().value, CellValue::Number(42.0));
        assert_eq!(g.get_cell(0, 1).unwrap().value, CellValue::Number(1.5));
        assert_eq!(g.get_cell(0, 2).unwrap().value, CellValue::Boolean(true));
        assert_eq!(
            g.get_cell(0, 3).unwrap().value,
            CellValue::Text("text".to_string())
        );
        // String input keeps the keystroke coercion: "7" is numeric.
        assert_eq!(g.get_cell(0, 4).unwrap().value, CellValue::Number(7.0));
    }

    #[test]
    fn null_clears_the_cell() {
        let (mut grids, registry, names) = three_sheets();
        grids[0].set_cell(
            0,
            0,
            Cell {
                ast: None,
                value: CellValue::Text("old".to_string()),
                style_index: 0,
                rich_text: None,
            },
        );
        let (result, grids) = run(
            r#"Calcula.setCellValue(0, 0, null);"#,
            grids,
            registry,
            names,
            0,
        );
        expect_success(&result);
        assert_eq!(grids[0].get_cell(0, 0).unwrap().value, CellValue::Empty);
    }

    #[test]
    fn set_cell_value_rejects_objects() {
        let (grids, registry, names) = three_sheets();
        let (result, _grids) = run(
            r#"Calcula.setCellValue(0, 0, { a: 1 });"#,
            grids,
            registry,
            names,
            0,
        );
        let msg = expect_error(&result);
        assert!(msg.contains("string, number, boolean, or null"), "{msg}");
    }

    #[test]
    fn set_range_accepts_a_real_js_array_with_typed_values() {
        let (grids, registry, names) = three_sheets();
        let (result, grids) = run(
            r#"Calcula.setRange(0, 0, [[1, "two"], [true, null]], "Beta");"#,
            grids,
            registry,
            names,
            0,
        );
        expect_success(&result);
        let g = &grids[1];
        assert_eq!(g.get_cell(0, 0).unwrap().value, CellValue::Number(1.0));
        assert_eq!(
            g.get_cell(0, 1).unwrap().value,
            CellValue::Text("two".to_string())
        );
        assert_eq!(g.get_cell(1, 0).unwrap().value, CellValue::Boolean(true));
        // null wrote Empty into an absent cell: nothing materializes.
        assert!(
            g.get_cell(1, 1).is_none()
                || g.get_cell(1, 1).unwrap().value == CellValue::Empty
        );
    }

    #[test]
    fn set_range_json_string_form_keeps_types() {
        let (grids, registry, names) = three_sheets();
        let (result, grids) = run(
            r#"Calcula.setRange(0, 0, JSON.stringify([[3, false, null, "x"]]));"#,
            grids,
            registry,
            names,
            0,
        );
        expect_success(&result);
        let g = &grids[0];
        assert_eq!(g.get_cell(0, 0).unwrap().value, CellValue::Number(3.0));
        assert_eq!(g.get_cell(0, 1).unwrap().value, CellValue::Boolean(false));
        assert_eq!(
            g.get_cell(0, 3).unwrap().value,
            CellValue::Text("x".to_string())
        );
    }

    #[test]
    fn set_range_malformed_payload_throws_and_writes_nothing() {
        let (grids, registry, names) = three_sheets();
        let (result, grids) = run(
            r#"Calcula.setRange(0, 0, "not json at all");"#,
            grids,
            registry,
            names,
            0,
        );
        let msg = expect_error(&result);
        assert!(msg.contains("2D array"), "{msg}");
        // On the error path the engine returns no grids to apply; if it ever
        // starts returning them, the target cell must still be untouched.
        assert!(grids.iter().all(|g| g.get_cell(0, 0).is_none()));
    }

    #[test]
    fn get_cell_value_and_formula_accept_sheet_name() {
        let (mut grids, registry, names) = three_sheets();
        grids[1].set_cell(
            0,
            0,
            Cell {
                ast: None,
                value: CellValue::Number(9.0),
                style_index: 0,
                rich_text: None,
            },
        );
        let (result, _grids) = run(
            r#"
                var v = Calcula.getCellValue(0, 0, "Beta");
                if (v !== "9") throw new Error("expected 9, got " + v);
                var f = Calcula.getCellFormula(0, 0, "Beta");
                if (f !== "") throw new Error("expected empty formula");
                var r = JSON.parse(Calcula.getRange(0, 0, 0, 0, "Beta"));
                if (r[0][0] !== "9") throw new Error("range read failed");
            "#,
            grids,
            registry,
            names,
            0,
        );
        expect_success(&result);
    }
}
