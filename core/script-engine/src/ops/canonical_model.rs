//! FILENAME: core/script-engine/src/ops/canonical_model.rs
//! PURPOSE: Binds Calcula's canonical shared object model (Workbook -> Sheet ->
//! Range -> Cell) as real rquickjs JavaScript objects in the notebook/QuickJS
//! runtime (C3 step 5, the Rust-QuickJS half).
//! CONTEXT: Notebook + one-off scripts get the SAME Workbook/Sheet/Range shape
//! that extensions (api/range.ts, api/objectModel.ts) and object scripts
//! (scriptHost/worker/canonicalModel.ts) already expose. The single source of
//! truth for the member set is api/canonicalModelSpec.ts; the
//! canonicalModelCoverage drift guard pins every surface to it.
//!
//! Unlike the worker/extension surfaces, this runtime is SYNCHRONOUS: methods
//! return values directly (NOT Promises). The model is reached as
//! Calcula.workbook and reads/writes the cloned grids in the shared
//! ScriptContext exactly like the flat Calcula.* ops do (which remain untouched
//! for back-compat).

use rquickjs::{Array, Ctx, Function, Object, Value};
use std::cell::RefCell;
use std::rc::Rc;

use engine::cell::Cell;
use engine::coord::{col_to_index, index_to_col};

use crate::types::{cell_value_to_string, string_to_cell_value, ScriptContext};

/// An inclusive 0-based cell box, the geometry behind a Range.
#[derive(Clone, Copy)]
struct Box {
    start_row: u32,
    start_col: u32,
    end_row: u32,
    end_col: u32,
}

/// Parse an A1 address ("A1", "A1:B5", "$A$1:$B$5"). A leading "Sheet!" prefix
/// is ignored — a range built from a sheet context is bound to THAT sheet
/// (mirrors the worker's parseA1). Returns an error string on a malformed ref.
fn parse_a1(address: &str) -> Result<Box, String> {
    let mut work = address.trim();
    if let Some(bang) = work.find('!') {
        work = &work[bang + 1..];
    }
    let cleaned: String = work.chars().filter(|c| *c != '$').collect();
    let parts: Vec<&str> = cleaned.split(':').collect();
    let (sr, sc) = parse_ref(parts[0])?;
    if parts.len() == 1 {
        return Ok(Box {
            start_row: sr,
            start_col: sc,
            end_row: sr,
            end_col: sc,
        });
    }
    let (er, ec) = parse_ref(parts[1])?;
    Ok(Box {
        start_row: sr.min(er),
        start_col: sc.min(ec),
        end_row: sr.max(er),
        end_col: sc.max(ec),
    })
}

/// Parse a single A1 cell reference ("A1", "AA100") to 0-based (row, col).
fn parse_ref(reference: &str) -> Result<(u32, u32), String> {
    let trimmed = reference.trim();
    let split = trimmed
        .find(|c: char| c.is_ascii_digit())
        .ok_or_else(|| format!("Invalid cell reference: \"{}\"", reference))?;
    let (letters, digits) = trimmed.split_at(split);
    if letters.is_empty() || digits.is_empty() || !letters.chars().all(|c| c.is_ascii_alphabetic())
    {
        return Err(format!("Invalid cell reference: \"{}\"", reference));
    }
    let row_num: u32 = digits
        .parse()
        .map_err(|_| format!("Invalid cell reference: \"{}\"", reference))?;
    if row_num == 0 {
        return Err(format!("Invalid cell reference: \"{}\"", reference));
    }
    let col = col_to_index(letters);
    Ok((row_num - 1, col))
}

/// The A1 address of a box: top-left for a single cell, "A1:B5" otherwise.
fn box_address(b: &Box) -> String {
    let top_left = format!("{}{}", index_to_col(b.start_col), b.start_row + 1);
    if b.start_row == b.end_row && b.start_col == b.end_col {
        top_left
    } else {
        format!(
            "{}:{}{}",
            top_left,
            index_to_col(b.end_col),
            b.end_row + 1
        )
    }
}

/// Throw a JS Error with `message` inside the given context.
fn throw<'js>(ctx: &Ctx<'js>, message: String) -> rquickjs::Error {
    rquickjs::Exception::throw_message(ctx, &message)
}

// ---------------------------------------------------------------------------
// Range
// ---------------------------------------------------------------------------

/// Build a synchronous canonical Range object over `box` on `sheet_index`.
///
/// Captures only Copy geometry (sheet_index + the box) plus `shared_ctx` clones,
/// so the navigation methods (offset/resize/getCell) can recurse cleanly. Each
/// object-creating method receives `Ctx<'js>` as its FIRST parameter (rquickjs
/// injects it) and returns `Object<'js>`/`Value<'js>` — never capturing a `Ctx`
/// or `Object` across calls.
fn make_range<'js>(
    ctx: &Ctx<'js>,
    shared_ctx: Rc<RefCell<ScriptContext>>,
    sheet_index: usize,
    b: Box,
) -> rquickjs::Result<Object<'js>> {
    let obj = Object::new(ctx.clone())?;

    let row_count = b.end_row - b.start_row + 1;
    let col_count = b.end_col - b.start_col + 1;
    let is_single = b.start_row == b.end_row && b.start_col == b.end_col;

    // Data properties.
    obj.set("address", box_address(&b))?;
    obj.set("rowCount", row_count)?;
    obj.set("colCount", col_count)?;
    obj.set("isSingleCell", is_single)?;
    obj.set("startRow", b.start_row)?;
    obj.set("startCol", b.start_col)?;
    obj.set("endRow", b.end_row)?;
    obj.set("endCol", b.end_col)?;

    // offset(dr, dc) -> a new range shifted by (dr, dc), same size.
    {
        let sc = shared_ctx.clone();
        let f = Function::new(
            ctx.clone(),
            move |ctx: Ctx<'js>, dr: i32, dc: i32| -> rquickjs::Result<Object<'js>> {
                let shifted = Box {
                    start_row: (b.start_row as i64 + dr as i64).max(0) as u32,
                    start_col: (b.start_col as i64 + dc as i64).max(0) as u32,
                    end_row: (b.end_row as i64 + dr as i64).max(0) as u32,
                    end_col: (b.end_col as i64 + dc as i64).max(0) as u32,
                };
                make_range(&ctx, sc.clone(), sheet_index, shifted)
            },
        )?;
        obj.set("offset", f)?;
    }

    // resize(rows, cols) -> a new range with the same top-left.
    {
        let sc = shared_ctx.clone();
        let f = Function::new(
            ctx.clone(),
            move |ctx: Ctx<'js>, rows: i32, cols: i32| -> rquickjs::Result<Object<'js>> {
                let rows = rows.max(1) as u32;
                let cols = cols.max(1) as u32;
                let resized = Box {
                    start_row: b.start_row,
                    start_col: b.start_col,
                    end_row: b.start_row + rows - 1,
                    end_col: b.start_col + cols - 1,
                };
                make_range(&ctx, sc.clone(), sheet_index, resized)
            },
        )?;
        obj.set("resize", f)?;
    }

    // getCell(dr, dc) -> single-cell range at the offset; throws if outside.
    {
        let sc = shared_ctx.clone();
        let f = Function::new(
            ctx.clone(),
            move |ctx: Ctx<'js>, dr: i32, dc: i32| -> rquickjs::Result<Object<'js>> {
                let row = b.start_row as i64 + dr as i64;
                let col = b.start_col as i64 + dc as i64;
                if row < b.start_row as i64
                    || col < b.start_col as i64
                    || row > b.end_row as i64
                    || col > b.end_col as i64
                {
                    return Err(throw(
                        &ctx,
                        format!(
                            "Offset ({}, {}) is outside range {}",
                            dr,
                            dc,
                            box_address(&b)
                        ),
                    ));
                }
                let cell = Box {
                    start_row: row as u32,
                    start_col: col as u32,
                    end_row: row as u32,
                    end_col: col as u32,
                };
                make_range(&ctx, sc.clone(), sheet_index, cell)
            },
        )?;
        obj.set("getCell", f)?;
    }

    // getValue() -> top-left cell display string.
    {
        let sc = shared_ctx.clone();
        let f = Function::new(ctx.clone(), move || -> String {
            let ctx = sc.borrow();
            read_cell(&ctx, sheet_index, b.start_row, b.start_col)
        })?;
        obj.set("getValue", f)?;
    }

    // getValues() -> rows x cols grid of display strings (a real JS Array).
    {
        let sc = shared_ctx.clone();
        let f = Function::new(ctx.clone(), move || -> Vec<Vec<String>> {
            let ctx = sc.borrow();
            let mut rows: Vec<Vec<String>> = Vec::new();
            for r in b.start_row..=b.end_row {
                let mut row: Vec<String> = Vec::new();
                for c in b.start_col..=b.end_col {
                    row.push(read_cell(&ctx, sheet_index, r, c));
                }
                rows.push(row);
            }
            rows
        })?;
        obj.set("getValues", f)?;
    }

    // setValue(value) -> write the top-left cell.
    {
        let sc = shared_ctx.clone();
        let f = Function::new(ctx.clone(), move |value: String| {
            let mut ctx = sc.borrow_mut();
            write_cell(&mut ctx, sheet_index, b.start_row, b.start_col, &value);
        })?;
        obj.set("setValue", f)?;
    }

    // setValues(values) -> write each cell, clamped to rowCount/colCount.
    {
        let sc = shared_ctx.clone();
        let f = Function::new(ctx.clone(), move |values: Vec<Vec<String>>| {
            let mut ctx = sc.borrow_mut();
            for (ri, row) in values.iter().enumerate() {
                if ri as u32 >= row_count {
                    break;
                }
                for (ci, val) in row.iter().enumerate() {
                    if ci as u32 >= col_count {
                        break;
                    }
                    write_cell(
                        &mut ctx,
                        sheet_index,
                        b.start_row + ri as u32,
                        b.start_col + ci as u32,
                        val,
                    );
                }
            }
        })?;
        obj.set("setValues", f)?;
    }

    Ok(obj)
}

/// Read a cell's display value from a grid (empty string if absent).
fn read_cell(ctx: &ScriptContext, sheet_index: usize, row: u32, col: u32) -> String {
    ctx.grids
        .get(sheet_index)
        .and_then(|g| g.get_cell(row, col))
        .map(|cell| cell_value_to_string(&cell.value))
        .unwrap_or_default()
}

/// Write a value into a grid cell, preserving the existing style index and
/// bumping the cells-modified counter (mirrors the flat setCellValue op).
fn write_cell(ctx: &mut ScriptContext, sheet_index: usize, row: u32, col: u32, value: &str) {
    if let Some(grid) = ctx.grids.get_mut(sheet_index) {
        let style_index = grid.get_cell(row, col).map(|c| c.style_index).unwrap_or(0);
        let cell = Cell {
            ast: None,
            value: string_to_cell_value(value),
            style_index,
            rich_text: None,
        };
        grid.set_cell(row, col, cell);
        *ctx.cells_modified.borrow_mut() += 1;
    }
}

// ---------------------------------------------------------------------------
// Sheet
// ---------------------------------------------------------------------------

/// Build a synchronous canonical Sheet object for `index`.
fn make_sheet<'js>(
    ctx: &Ctx<'js>,
    shared_ctx: Rc<RefCell<ScriptContext>>,
    index: usize,
) -> rquickjs::Result<Object<'js>> {
    let obj = Object::new(ctx.clone())?;

    let name = shared_ctx
        .borrow()
        .sheet_names
        .get(index)
        .cloned()
        .unwrap_or_default();

    obj.set("index", index as u32)?;
    obj.set("name", name)?;

    // range(address) -> a Range on THIS sheet (A1 parsed; "Sheet!" prefix ignored).
    {
        let sc = shared_ctx.clone();
        let f = Function::new(
            ctx.clone(),
            move |ctx: Ctx<'js>, address: String| -> rquickjs::Result<Object<'js>> {
                let b = parse_a1(&address).map_err(|e| throw(&ctx, e))?;
                make_range(&ctx, sc.clone(), index, b)
            },
        )?;
        obj.set("range", f)?;
    }

    // cell(row, col) -> single-cell Range (0-based) on this sheet.
    {
        let sc = shared_ctx.clone();
        let f = Function::new(
            ctx.clone(),
            move |ctx: Ctx<'js>, row: i32, col: i32| -> rquickjs::Result<Object<'js>> {
                let r = row.max(0) as u32;
                let c = col.max(0) as u32;
                let b = Box {
                    start_row: r,
                    start_col: c,
                    end_row: r,
                    end_col: c,
                };
                make_range(&ctx, sc.clone(), index, b)
            },
        )?;
        obj.set("cell", f)?;
    }

    // activate() -> make this the active sheet.
    {
        let sc = shared_ctx.clone();
        let f = Function::new(ctx.clone(), move || {
            let mut ctx = sc.borrow_mut();
            if index < ctx.grids.len() {
                ctx.active_sheet = index;
            }
        })?;
        obj.set("activate", f)?;
    }

    Ok(obj)
}

// ---------------------------------------------------------------------------
// Workbook
// ---------------------------------------------------------------------------

/// Build the synchronous canonical Workbook object (`Calcula.workbook`).
fn make_workbook<'js>(
    ctx: &Ctx<'js>,
    shared_ctx: Rc<RefCell<ScriptContext>>,
) -> rquickjs::Result<Object<'js>> {
    let obj = Object::new(ctx.clone())?;

    // sheets() -> JS Array of Sheet objects, one per sheet name.
    {
        let sc = shared_ctx.clone();
        let f = Function::new(ctx.clone(), move |ctx: Ctx<'js>| -> rquickjs::Result<Array<'js>> {
            let count = sc.borrow().sheet_names.len();
            let arr = Array::new(ctx.clone())?;
            for i in 0..count {
                let sheet = make_sheet(&ctx, sc.clone(), i)?;
                arr.set(i, sheet)?;
            }
            Ok(arr)
        })?;
        obj.set("sheets", f)?;
    }

    // activeSheet() -> Sheet for the active index (clamped into range).
    {
        let sc = shared_ctx.clone();
        let f = Function::new(ctx.clone(), move |ctx: Ctx<'js>| -> rquickjs::Result<Object<'js>> {
            let idx = {
                let c = sc.borrow();
                let active = c.active_sheet;
                if active < c.sheet_names.len() {
                    active
                } else {
                    0
                }
            };
            make_sheet(&ctx, sc.clone(), idx)
        })?;
        obj.set("activeSheet", f)?;
    }

    // sheet(nameOrIndex) -> Sheet by 0-based index OR exact name; null if absent.
    {
        let sc = shared_ctx.clone();
        let f = Function::new(
            ctx.clone(),
            move |ctx: Ctx<'js>, key: Value<'js>| -> rquickjs::Result<Value<'js>> {
                let count = sc.borrow().sheet_names.len();
                let idx: Option<usize> = if let Some(n) = key.as_number() {
                    if n.fract() == 0.0 && n >= 0.0 {
                        Some(n as usize)
                    } else {
                        None
                    }
                } else if let Some(s) = key.as_string() {
                    let name = s.to_string()?;
                    sc.borrow().sheet_names.iter().position(|n| *n == name)
                } else {
                    None
                };

                match idx {
                    Some(i) if i < count => {
                        let sheet = make_sheet(&ctx, sc.clone(), i)?;
                        Ok(sheet.into_value())
                    }
                    _ => Ok(Value::new_null(ctx.clone())),
                }
            },
        )?;
        obj.set("sheet", f)?;
    }

    Ok(obj)
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

/// Attach the canonical object model as `Calcula.workbook`. The flat `Calcula.*`
/// ops are left untouched; this only ADDS the navigable model.
pub fn register_canonical_model<'js>(
    ctx: &Ctx<'js>,
    calcula: &Object<'js>,
    shared_ctx: Rc<RefCell<ScriptContext>>,
) -> Result<(), String> {
    let workbook = make_workbook(ctx, shared_ctx)
        .map_err(|e| format!("Failed to build canonical workbook: {}", e))?;
    calcula
        .set("workbook", workbook)
        .map_err(|e| format!("Failed to set Calcula.workbook: {}", e))?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use crate::types::{cell_value_to_string, ScriptResult};
    use crate::ScriptEngine;
    use engine::cell::{Cell, CellValue};
    use engine::grid::Grid;
    use engine::style::StyleRegistry;

    /// Build two empty grids with sheet names "Alpha"/"Beta".
    fn two_sheets() -> (Vec<Grid>, StyleRegistry, Vec<String>) {
        let grids = vec![Grid::new(), Grid::new()];
        let registry = StyleRegistry::new();
        let names = vec!["Alpha".to_string(), "Beta".to_string()];
        (grids, registry, names)
    }

    /// Seed a single text cell into a grid.
    fn seed(grid: &mut Grid, row: u32, col: u32, text: &str) {
        grid.set_cell(
            row,
            col,
            Cell {
                ast: None,
                value: CellValue::Text(text.to_string()),
                style_index: 0,
                rich_text: None,
            },
        );
    }

    /// Run `src` through ScriptEngine::run (the one-off-script path) and return
    /// (last_console_line, grids). ScriptEngine::run does NOT capture the final
    /// expression value (only console output), so tests `Calcula.log(...)` their
    /// result and we read the last logged line.
    fn run_logged(
        src: &str,
        grids: Vec<Grid>,
        registry: StyleRegistry,
        names: Vec<String>,
        active: usize,
    ) -> (String, Vec<Grid>) {
        let (result, grids) = ScriptEngine::run(src, "test.js", grids, registry, names, active);
        match result {
            ScriptResult::Success { output, .. } => {
                let last = output.last().cloned().unwrap_or_default();
                (last, grids)
            }
            ScriptResult::Error { message, .. } => panic!("script error: {message}"),
        }
    }

    #[test]
    fn workbook_set_and_get_values_round_trips() {
        let (grids, registry, names) = two_sheets();
        let src = r#"
            Calcula.workbook.sheet(0).range("A1:B2").setValues([["x","y"],["z","w"]]);
            var vals = Calcula.workbook.sheet(0).range("A1:B2").getValues();
            Calcula.log(JSON.stringify(vals));
        "#;
        let (out, grids) = run_logged(src, grids, registry, names, 0);
        assert_eq!(out, r#"[["x","y"],["z","w"]]"#);
        // Grid 0 mutated.
        assert_eq!(
            cell_value_to_string(&grids[0].get_cell(0, 0).unwrap().value),
            "x"
        );
        assert_eq!(
            cell_value_to_string(&grids[0].get_cell(1, 1).unwrap().value),
            "w"
        );
    }

    #[test]
    fn active_sheet_cell_reads_value() {
        let (mut grids, registry, names) = two_sheets();
        seed(&mut grids[1], 0, 0, "hello"); // Beta!A1
        // Active sheet = index 1 (Beta).
        let src = r#"Calcula.log(Calcula.workbook.activeSheet().cell(0,0).getValue());"#;
        let (out, _grids) = run_logged(src, grids, registry, names, 1);
        assert_eq!(out, "hello");
    }

    #[test]
    fn sheet_resolves_by_name_and_index_and_null() {
        let (grids, registry, names) = two_sheets();
        let src = r#"
            var byName = Calcula.workbook.sheet("Beta");
            var byIdx = Calcula.workbook.sheet(0);
            var missingName = Calcula.workbook.sheet("Nope");
            var missingIdx = Calcula.workbook.sheet(99);
            Calcula.log(JSON.stringify([
                byName ? byName.name : null,
                byName ? byName.index : null,
                byIdx ? byIdx.name : null,
                missingName,
                missingIdx
            ]));
        "#;
        let (out, _grids) = run_logged(src, grids, registry, names, 0);
        assert_eq!(out, r#"["Beta",1,"Alpha",null,null]"#);
    }

    #[test]
    fn range_offset_and_address() {
        let (grids, registry, names) = two_sheets();
        let src = r#"Calcula.log(Calcula.workbook.sheet(0).range("A1").offset(1,1).address);"#;
        let (out, _grids) = run_logged(src, grids, registry, names, 0);
        assert_eq!(out, "B2");
    }

    #[test]
    fn range_resize_dimensions() {
        let (grids, registry, names) = two_sheets();
        let src = r#"
            var r = Calcula.workbook.sheet(0).range("A1").resize(3,2);
            Calcula.log(JSON.stringify([r.address, r.rowCount, r.colCount, r.isSingleCell]));
        "#;
        let (out, _grids) = run_logged(src, grids, registry, names, 0);
        assert_eq!(out, r#"["A1:B3",3,2,false]"#);
    }

    #[test]
    fn get_cell_out_of_bounds_throws() {
        let (grids, registry, names) = two_sheets();
        let src = r#"
            try {
                Calcula.workbook.sheet(0).range("A1:B2").getCell(5,5);
                Calcula.log("no-throw");
            } catch (e) {
                Calcula.log("threw:" + (e && e.message ? "msg" : "nomsg"));
            }
        "#;
        let (out, _grids) = run_logged(src, grids, registry, names, 0);
        assert_eq!(out, "threw:msg");
    }

    #[test]
    fn get_cell_in_bounds_returns_single_cell() {
        let (mut grids, registry, names) = two_sheets();
        seed(&mut grids[0], 1, 1, "inner"); // B2
        let src = r#"
            var c = Calcula.workbook.sheet(0).range("A1:C3").getCell(1,1);
            Calcula.log(JSON.stringify([c.address, c.isSingleCell, c.getValue()]));
        "#;
        let (out, _grids) = run_logged(src, grids, registry, names, 0);
        assert_eq!(out, r#"["B2",true,"inner"]"#);
    }

    #[test]
    fn workbook_sheets_lists_all() {
        let (grids, registry, names) = two_sheets();
        let src = r#"
            var s = Calcula.workbook.sheets();
            Calcula.log(JSON.stringify([s.length, s[0].name, s[1].name]));
        "#;
        let (out, _grids) = run_logged(src, grids, registry, names, 0);
        assert_eq!(out, r#"[2,"Alpha","Beta"]"#);
    }

    #[test]
    fn set_values_clamps_to_range_dimensions() {
        let (grids, registry, names) = two_sheets();
        // Range is 1x1 but we pass a 2x2 grid; only A1 should be written.
        let src = r#"
            Calcula.workbook.sheet(0).range("A1").setValues([["a","b"],["c","d"]]);
            Calcula.log(JSON.stringify([
                Calcula.getCellValue(0,0),
                Calcula.getCellValue(0,1),
                Calcula.getCellValue(1,0)
            ]));
        "#;
        let (out, _grids) = run_logged(src, grids, registry, names, 0);
        assert_eq!(out, r#"["a","",""]"#);
    }

    #[test]
    fn activate_changes_active_sheet() {
        let (mut grids, registry, names) = two_sheets();
        seed(&mut grids[1], 0, 0, "onbeta");
        // Start on sheet 0, activate sheet 1, then read active sheet A1.
        let src = r#"
            Calcula.workbook.sheet(1).activate();
            Calcula.log(Calcula.workbook.activeSheet().cell(0,0).getValue());
        "#;
        let (out, _grids) = run_logged(src, grids, registry, names, 0);
        assert_eq!(out, "onbeta");
    }

    #[test]
    fn flat_ops_remain_untouched() {
        // Back-compat: the flat Calcula.* surface still works alongside workbook.
        let (grids, registry, names) = two_sheets();
        let src = r#"
            Calcula.setCellValue(0,0,"flat");
            Calcula.log(Calcula.getCellValue(0,0));
        "#;
        let (out, grids) = run_logged(src, grids, registry, names, 0);
        assert_eq!(out, "flat");
        assert_eq!(
            cell_value_to_string(&grids[0].get_cell(0, 0).unwrap().value),
            "flat"
        );
    }
}
