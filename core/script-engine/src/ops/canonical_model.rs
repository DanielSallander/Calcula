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

use engine::coord::{col_to_index, index_to_col};

use crate::types::{cell_value_to_string, ScriptContext};

/// An inclusive 0-based cell box, the geometry behind a Range.
#[derive(Clone, Copy)]
pub(crate) struct Box {
    pub(crate) start_row: u32,
    pub(crate) start_col: u32,
    pub(crate) end_row: u32,
    pub(crate) end_col: u32,
}

/// Parse an A1 address ("A1", "A1:B5", "$A$1:$B$5", "Sheet2!A1",
/// "'My Sheet'!A1:B5") against the sheet the range is being built FROM.
///
/// A leading "Sheet!" prefix is resolved, never silently dropped (dropping it
/// sent a `sheet("Alpha").range("Beta!A1")` write to Alpha — the WRONG sheet):
/// - prefix naming the bound sheet: fine, stays on the bound sheet;
/// - prefix naming ANOTHER existing sheet: the range REBINDS to that sheet
///   (`sheet.range()` returns a fresh Range carrying its own sheet index, so
///   the call shape allows it);
/// - prefix naming NO sheet: error listing the workbook's sheet names.
///
/// Returns (box, resolved sheet index), or an error string on a malformed ref.
/// pub(crate): the A1 form of `application.goto` (ops/application.rs) reuses
/// this parser so goto and Range addresses can never diverge.
pub(crate) fn parse_a1(
    address: &str,
    sheet_names: &[String],
    bound_sheet: usize,
) -> Result<(Box, usize), String> {
    let mut work = address.trim();
    let mut resolved_sheet = bound_sheet;
    if let Some(bang) = work.find('!') {
        let (raw_prefix, rest) = work.split_at(bang);
        // Unquote 'Sheet Name' (Excel quoting; '' escapes a literal quote).
        let trimmed = raw_prefix.trim();
        let name = if trimmed.len() >= 2 && trimmed.starts_with('\'') && trimmed.ends_with('\'') {
            trimmed[1..trimmed.len() - 1].replace("''", "'")
        } else {
            trimmed.to_string()
        };
        resolved_sheet = crate::ops::resolve_sheet_name(sheet_names, &name)?;
        work = &rest[1..];
    }
    let cleaned: String = work.chars().filter(|c| *c != '$').collect();
    let parts: Vec<&str> = cleaned.split(':').collect();
    let (sr, sc) = parse_ref(parts[0])?;
    if parts.len() == 1 {
        return Ok((
            Box {
                start_row: sr,
                start_col: sc,
                end_row: sr,
                end_col: sc,
            },
            resolved_sheet,
        ));
    }
    let (er, ec) = parse_ref(parts[1])?;
    Ok((
        Box {
            start_row: sr.min(er),
            start_col: sc.min(ec),
            end_row: sr.max(er),
            end_col: sc.max(ec),
        },
        resolved_sheet,
    ))
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

    // setValue(value) -> write the top-left cell. TYPED like the flat
    // setCellValue op: numbers land numeric, booleans boolean, null/undefined
    // clears, strings coerce like a keystroke — the same contract the worker
    // realm's ScriptRange.setValue promises, so `range.setValue(42)` means the
    // NUMBER 42 in both realms.
    {
        let sc = shared_ctx.clone();
        let f = Function::new(
            ctx.clone(),
            move |ctx: Ctx<'js>, value: Value<'js>| -> rquickjs::Result<()> {
                let cell_value = crate::ops::cells::js_value_to_cell_value(&ctx, &value)?;
                let mut ctx_ref = sc.borrow_mut();
                if crate::ops::cells::write_typed_cell(
                    &mut ctx_ref,
                    sheet_index,
                    b.start_row,
                    b.start_col,
                    cell_value,
                ) {
                    *ctx_ref.cells_modified.borrow_mut() += 1;
                }
                Ok(())
            },
        )?;
        obj.set("setValue", f)?;
    }

    // setValues(values) -> write each cell, clamped to rowCount/colCount.
    // Typed like setValue; the whole payload is converted BEFORE any cell is
    // written, so a malformed row throws without a partial write.
    {
        let sc = shared_ctx.clone();
        let f = Function::new(
            ctx.clone(),
            move |ctx: Ctx<'js>, values: Value<'js>| -> rquickjs::Result<()> {
                let arr = values.as_array().ok_or_else(|| {
                    rquickjs::Exception::throw_message(
                        &ctx,
                        "setValues expects a 2D array (an array of row arrays)",
                    )
                })?;
                let mut typed: Vec<Vec<engine::cell::CellValue>> = Vec::new();
                for row_val in arr.iter::<Value<'_>>() {
                    let row_val = row_val?;
                    let row_arr = row_val.as_array().ok_or_else(|| {
                        rquickjs::Exception::throw_message(
                            &ctx,
                            "setValues expects a 2D array (an array of row arrays)",
                        )
                    })?;
                    let mut out_row: Vec<engine::cell::CellValue> = Vec::new();
                    for cell_val in row_arr.iter::<Value<'_>>() {
                        out_row
                            .push(crate::ops::cells::js_value_to_cell_value(&ctx, &cell_val?)?);
                    }
                    typed.push(out_row);
                }
                let mut ctx_ref = sc.borrow_mut();
                let mut modified: u32 = 0;
                for (ri, row) in typed.into_iter().enumerate() {
                    if ri as u32 >= row_count {
                        break;
                    }
                    for (ci, cell_value) in row.into_iter().enumerate() {
                        if ci as u32 >= col_count {
                            break;
                        }
                        if crate::ops::cells::write_typed_cell(
                            &mut ctx_ref,
                            sheet_index,
                            b.start_row + ri as u32,
                            b.start_col + ci as u32,
                            cell_value,
                        ) {
                            modified += 1;
                        }
                    }
                }
                *ctx_ref.cells_modified.borrow_mut() += modified;
                Ok(())
            },
        )?;
        obj.set("setValues", f)?;
    }

    // end(direction) -> single-cell Range at the Ctrl+Arrow target from this
    // range's TOP-LEFT cell (VBA Range.End operates on the range's first
    // cell). Direction is "up" | "down" | "left" | "right"; anything else
    // throws. Bounds are the full Excel grid, matching the keyboard handler.
    {
        let sc = shared_ctx.clone();
        let f = Function::new(
            ctx.clone(),
            move |ctx: Ctx<'js>, direction: String| -> rquickjs::Result<Object<'js>> {
                let dir = engine::navigation::EdgeDirection::parse(&direction).ok_or_else(|| {
                    throw(
                        &ctx,
                        format!(
                            "Invalid direction \"{}\": expected \"up\", \"down\", \"left\", or \"right\"",
                            direction
                        ),
                    )
                })?;
                let (target_row, target_col) = {
                    let ctx_ref = sc.borrow();
                    let grid = ctx_ref.grids.get(sheet_index).ok_or_else(|| {
                        throw(&ctx, format!("Sheet index {} is out of range", sheet_index))
                    })?;
                    engine::navigation::range_edge(
                        grid,
                        b.start_row,
                        b.start_col,
                        dir,
                        engine::navigation::EXCEL_MAX_ROW_INDEX,
                        engine::navigation::EXCEL_MAX_COL_INDEX,
                    )
                };
                let cell = Box {
                    start_row: target_row,
                    start_col: target_col,
                    end_row: target_row,
                    end_col: target_col,
                };
                make_range(&ctx, sc.clone(), sheet_index, cell)
            },
        )?;
        obj.set("end", f)?;
    }

    // contains(row, col) -> true when the 0-based cell lies inside this range.
    {
        let f = Function::new(ctx.clone(), move |row: i32, col: i32| -> bool {
            row >= 0
                && col >= 0
                && (row as u32) >= b.start_row
                && (row as u32) <= b.end_row
                && (col as u32) >= b.start_col
                && (col as u32) <= b.end_col
        })?;
        obj.set("contains", f)?;
    }

    // intersect(other) -> the overlapping Range, or null when disjoint.
    // Pure coordinate math: max of the starts, min of the ends. The result is
    // bound to THIS range's sheet.
    {
        let sc = shared_ctx.clone();
        let f = Function::new(
            ctx.clone(),
            move |ctx: Ctx<'js>, other: Value<'js>| -> rquickjs::Result<Value<'js>> {
                let o = box_from_range_value(&ctx, &other, "intersect")?;
                let start_row = b.start_row.max(o.start_row);
                let start_col = b.start_col.max(o.start_col);
                let end_row = b.end_row.min(o.end_row);
                let end_col = b.end_col.min(o.end_col);
                if start_row > end_row || start_col > end_col {
                    return Ok(Value::new_null(ctx.clone()));
                }
                let range = make_range(
                    &ctx,
                    sc.clone(),
                    sheet_index,
                    Box {
                        start_row,
                        start_col,
                        end_row,
                        end_col,
                    },
                )?;
                Ok(range.into_value())
            },
        )?;
        obj.set("intersect", f)?;
    }

    // boundingUnion(other) -> the smallest single rectangle covering both
    // ranges (min of the starts, max of the ends). Named honestly: this is
    // NOT VBA Union's multi-area result — gaps between the inputs are
    // included. Bound to THIS range's sheet.
    {
        let sc = shared_ctx.clone();
        let f = Function::new(
            ctx.clone(),
            move |ctx: Ctx<'js>, other: Value<'js>| -> rquickjs::Result<Object<'js>> {
                let o = box_from_range_value(&ctx, &other, "boundingUnion")?;
                make_range(
                    &ctx,
                    sc.clone(),
                    sheet_index,
                    Box {
                        start_row: b.start_row.min(o.start_row),
                        start_col: b.start_col.min(o.start_col),
                        end_row: b.end_row.max(o.end_row),
                        end_col: b.end_col.max(o.end_col),
                    },
                )
            },
        )?;
        obj.set("boundingUnion", f)?;
    }

    Ok(obj)
}

/// Read another Range's geometry off a JS value: any object exposing numeric
/// `startRow`/`startCol`/`endRow`/`endCol` (every canonical Range does).
fn box_from_range_value<'js>(
    ctx: &Ctx<'js>,
    value: &Value<'js>,
    method: &str,
) -> rquickjs::Result<Box> {
    let err = || {
        throw(
            ctx,
            format!(
                "{} expects a Range (an object with startRow/startCol/endRow/endCol)",
                method
            ),
        )
    };
    let obj = value.as_object().ok_or_else(err)?;
    let start_row: Option<u32> = obj.get("startRow").ok();
    let start_col: Option<u32> = obj.get("startCol").ok();
    let end_row: Option<u32> = obj.get("endRow").ok();
    let end_col: Option<u32> = obj.get("endCol").ok();
    match (start_row, start_col, end_row, end_col) {
        (Some(start_row), Some(start_col), Some(end_row), Some(end_col)) => Ok(Box {
            start_row,
            start_col,
            end_row,
            end_col,
        }),
        _ => Err(err()),
    }
}

/// Read a cell's display value from a grid (empty string if absent).
fn read_cell(ctx: &ScriptContext, sheet_index: usize, row: u32, col: u32) -> String {
    ctx.grids
        .get(sheet_index)
        .and_then(|g| g.get_cell(row, col))
        .map(|cell| cell_value_to_string(&cell.value))
        .unwrap_or_default()
}

// (Cell writes go through crate::ops::cells::write_typed_cell — the ONE typed
// write shared with the flat setCellValue/setRange ops, so style preservation
// and effective-change counting mean the same thing on every surface.)

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

    // range(address) -> a Range on THIS sheet. A "Sheet!" prefix must resolve:
    // it stays here if it names THIS sheet, REBINDS the range if it names
    // another existing sheet, and throws (listing the sheet names) otherwise.
    {
        let sc = shared_ctx.clone();
        let f = Function::new(
            ctx.clone(),
            move |ctx: Ctx<'js>, address: String| -> rquickjs::Result<Object<'js>> {
                let (b, target) = {
                    let ctx_ref = sc.borrow();
                    parse_a1(&address, &ctx_ref.sheet_names, index).map_err(|e| throw(&ctx, e))?
                };
                make_range(&ctx, sc.clone(), target, b)
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
                let last = output.last().map(|i| i.to_text()).unwrap_or_default();
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
    fn range_prefix_naming_the_bound_sheet_stays_bound() {
        let (grids, registry, names) = two_sheets();
        let src = r#"
            Calcula.workbook.sheet("Alpha").range("Alpha!A1").setValue("here");
            Calcula.log(Calcula.workbook.sheet(0).cell(0,0).getValue());
        "#;
        let (out, grids) = run_logged(src, grids, registry, names, 0);
        assert_eq!(out, "here");
        assert!(grids[1].get_cell(0, 0).is_none(), "Beta must be untouched");
    }

    #[test]
    fn range_prefix_naming_another_sheet_rebinds() {
        let (grids, registry, names) = two_sheets();
        // Built FROM Alpha, but the address names Beta: the write must land on
        // Beta — silently dropping the prefix put it on Alpha.
        let src = r#"
            var r = Calcula.workbook.sheet("Alpha").range("Beta!A1:B1");
            r.setValues([["b1","b2"]]);
            Calcula.log(r.address);
        "#;
        let (out, grids) = run_logged(src, grids, registry, names, 0);
        assert_eq!(out, "A1:B1");
        assert!(grids[0].get_cell(0, 0).is_none(), "Alpha must be untouched");
        assert_eq!(
            cell_value_to_string(&grids[1].get_cell(0, 0).unwrap().value),
            "b1"
        );
        assert_eq!(
            cell_value_to_string(&grids[1].get_cell(0, 1).unwrap().value),
            "b2"
        );
    }

    #[test]
    fn canonical_range_set_value_writes_typed() {
        let (mut grids, registry, names) = two_sheets();
        seed(&mut grids[0], 0, 2, "old"); // A cell for null to clear.
        let src = r#"
            var s = Calcula.workbook.sheet(0);
            s.range("A1").setValue(42.5);
            s.range("B1").setValue(true);
            s.range("C1").setValue(null);
            s.range("D1").setValue("7");
            Calcula.log("done");
        "#;
        let (out, grids) = run_logged(src, grids, registry, names, 0);
        assert_eq!(out, "done");
        assert_eq!(grids[0].get_cell(0, 0).unwrap().value, CellValue::Number(42.5));
        assert_eq!(grids[0].get_cell(0, 1).unwrap().value, CellValue::Boolean(true));
        // null cleared the seeded cell.
        assert!(
            grids[0].get_cell(0, 2).is_none()
                || grids[0].get_cell(0, 2).unwrap().value == CellValue::Empty
        );
        // Strings keep keystroke coercion: "7" lands numeric.
        assert_eq!(grids[0].get_cell(0, 3).unwrap().value, CellValue::Number(7.0));
    }

    #[test]
    fn canonical_range_set_values_writes_typed_grid() {
        let (grids, registry, names) = two_sheets();
        let src = r#"
            Calcula.workbook.sheet(0).range("A1:B2")
                .setValues([[1, true], ["x", null]]);
            Calcula.log("done");
        "#;
        let (out, grids) = run_logged(src, grids, registry, names, 0);
        assert_eq!(out, "done");
        assert_eq!(grids[0].get_cell(0, 0).unwrap().value, CellValue::Number(1.0));
        assert_eq!(grids[0].get_cell(0, 1).unwrap().value, CellValue::Boolean(true));
        assert_eq!(
            grids[0].get_cell(1, 0).unwrap().value,
            CellValue::Text("x".to_string())
        );
        assert!(
            grids[0].get_cell(1, 1).is_none()
                || grids[0].get_cell(1, 1).unwrap().value == CellValue::Empty
        );
    }

    #[test]
    fn canonical_range_set_value_rejects_nan_and_objects() {
        let (grids, registry, names) = two_sheets();
        let src = r#"
            var s = Calcula.workbook.sheet(0);
            var msgs = [];
            try { s.range("A1").setValue(0/0); msgs.push("nan-ok"); }
            catch (e) { msgs.push("nan-threw"); }
            try { s.range("A1").setValue({}); msgs.push("obj-ok"); }
            catch (e) { msgs.push("obj-threw"); }
            Calcula.log(msgs.join(","));
        "#;
        let (out, grids) = run_logged(src, grids, registry, names, 0);
        assert_eq!(out, "nan-threw,obj-threw");
        assert!(grids[0].get_cell(0, 0).is_none(), "no write may have landed");
    }

    #[test]
    fn canonical_range_set_values_malformed_throws_before_any_write() {
        let (grids, registry, names) = two_sheets();
        // Second row is not an array: the whole call must throw with NO cell
        // written (conversion happens before the first write).
        let src = r#"
            try {
                Calcula.workbook.sheet(0).range("A1:B2").setValues([["a","b"], "nope"]);
                Calcula.log("no-throw");
            } catch (e) {
                Calcula.log("threw");
            }
        "#;
        let (out, grids) = run_logged(src, grids, registry, names, 0);
        assert_eq!(out, "threw");
        assert!(grids[0].get_cell(0, 0).is_none(), "row 1 must not be written");
    }

    #[test]
    fn range_prefix_supports_quoted_sheet_names() {
        let (grids, registry, names) = two_sheets();
        let src = r#"
            Calcula.workbook.sheet("Alpha").range("'Beta'!B2").setValue("q");
            Calcula.log(Calcula.workbook.sheet("Beta").cell(1,1).getValue());
        "#;
        let (out, _grids) = run_logged(src, grids, registry, names, 0);
        assert_eq!(out, "q");
    }

    #[test]
    fn range_prefix_naming_no_sheet_throws_listing_names() {
        let (grids, registry, names) = two_sheets();
        let src = r#"
            try {
                Calcula.workbook.sheet(0).range("Nope!A1");
                Calcula.log("no-throw");
            } catch (e) {
                Calcula.log("threw:" + e.message);
            }
        "#;
        let (out, _grids) = run_logged(src, grids, registry, names, 0);
        assert!(out.starts_with("threw:"), "{out}");
        assert!(out.contains("No sheet named \"Nope\""), "{out}");
        assert!(out.contains("\"Alpha\""), "{out}");
        assert!(out.contains("\"Beta\""), "{out}");
    }

    #[test]
    fn range_end_navigates_ctrl_arrow_style() {
        let (mut grids, registry, names) = two_sheets();
        // Data block A1:A4 on Alpha.
        for r in 0..4 {
            seed(&mut grids[0], r, 0, "x");
        }
        let src = r#"
            var s = Calcula.workbook.sheet(0);
            Calcula.log(JSON.stringify([
                s.range("A1").end("down").address,      // block end
                s.range("A10").end("up").address,       // gap jump back to data
                s.range("A2:C9").end("up").address,     // multi-cell: from TOP-LEFT
                s.range("B1").end("down").address       // empty column -> grid edge
            ]));
        "#;
        let (out, _grids) = run_logged(src, grids, registry, names, 0);
        assert_eq!(out, r#"["A4","A4","A1","B1048576"]"#);
    }

    #[test]
    fn range_end_rejects_a_bad_direction() {
        let (grids, registry, names) = two_sheets();
        let src = r#"
            try {
                Calcula.workbook.sheet(0).range("A1").end("xlUp");
                Calcula.log("no-throw");
            } catch (e) {
                Calcula.log("threw:" + (e.message.indexOf("xlUp") >= 0));
            }
        "#;
        let (out, _grids) = run_logged(src, grids, registry, names, 0);
        assert_eq!(out, "threw:true");
    }

    #[test]
    fn range_contains_checks_inclusive_bounds() {
        let (grids, registry, names) = two_sheets();
        let src = r#"
            var r = Calcula.workbook.sheet(0).range("B2:C4"); // rows 1..3, cols 1..2
            Calcula.log(JSON.stringify([
                r.contains(1, 1), r.contains(3, 2),  // corners
                r.contains(2, 2),                     // inside
                r.contains(0, 1), r.contains(4, 1),  // above / below
                r.contains(1, 3),                     // right of
                r.contains(-1, -1)                    // negative
            ]));
        "#;
        let (out, _grids) = run_logged(src, grids, registry, names, 0);
        assert_eq!(out, "[true,true,true,false,false,false,false]");
    }

    #[test]
    fn range_intersect_is_max_starts_min_ends_or_null() {
        let (grids, registry, names) = two_sheets();
        let src = r#"
            var s = Calcula.workbook.sheet(0);
            var a = s.range("A1:C3");
            var overlap = a.intersect(s.range("B2:D4"));
            var contained = a.intersect(s.range("B2"));
            var disjoint = a.intersect(s.range("E5:F6"));
            var touchingIsDisjoint = a.intersect(s.range("D1:E3"));
            Calcula.log(JSON.stringify([
                overlap.address, contained.address, disjoint, touchingIsDisjoint
            ]));
        "#;
        let (out, _grids) = run_logged(src, grids, registry, names, 0);
        assert_eq!(out, r#"["B2:C3","B2",null,null]"#);
    }

    #[test]
    fn range_bounding_union_covers_both_including_the_gap() {
        let (grids, registry, names) = two_sheets();
        let src = r#"
            var s = Calcula.workbook.sheet(0);
            var u = s.range("A1:B2").boundingUnion(s.range("D4:E5"));
            Calcula.log(JSON.stringify([u.address, u.rowCount, u.colCount]));
        "#;
        let (out, _grids) = run_logged(src, grids, registry, names, 0);
        assert_eq!(out, r#"["A1:E5",5,5]"#);
    }

    #[test]
    fn range_algebra_rejects_a_non_range_argument() {
        let (grids, registry, names) = two_sheets();
        let src = r#"
            var r = Calcula.workbook.sheet(0).range("A1:B2");
            var msgs = [];
            try { r.intersect(42); msgs.push("num-ok"); } catch (e) { msgs.push("num-threw"); }
            try { r.boundingUnion({}); msgs.push("obj-ok"); } catch (e) { msgs.push("obj-threw"); }
            Calcula.log(msgs.join(","));
        "#;
        let (out, _grids) = run_logged(src, grids, registry, names, 0);
        assert_eq!(out, "num-threw,obj-threw");
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
