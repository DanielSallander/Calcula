//! FILENAME: core/script-engine/src/ops/extended.rs
//! PURPOSE: Extended operations for the script engine.
//! CONTEXT: Registers navigation, view, formatting, calculation, data, and
//! display control methods on the Calcula global object.

use rquickjs::{Ctx, Function, Object, Value};
use std::cell::RefCell;
use std::rc::Rc;

use crate::ops::{resolve_opt_sheet_key, resolve_sheet_key};
use crate::types::{DeferredAction, ScriptContext};

/// Register extended operations on the Calcula object.
pub fn register_extended_ops<'js>(
    ctx: &rquickjs::Ctx<'js>,
    calcula: &Object<'js>,
    shared_ctx: Rc<RefCell<ScriptContext>>,
) -> Result<(), String> {
    // ========================================================================
    // Navigation & View
    // ========================================================================

    // getViewMode() -> "normal" | "pageLayout" | "pageBreakPreview"
    {
        let sc = shared_ctx.clone();
        let func = Function::new(ctx.clone(), move || -> String {
            sc.borrow().host.view_mode.clone()
        })
        .map_err(|e| format!("Failed to create getViewMode: {}", e))?;
        calcula
            .set("getViewMode", func)
            .map_err(|e| format!("Failed to set getViewMode: {}", e))?;
    }

    // setViewMode(mode) — STRICTLY validated: "normal" | "pageLayout" |
    // "pageBreakPreview". Anything else THROWS instead of travelling to the
    // frontend as a silent no-op.
    {
        let sc = shared_ctx.clone();
        let func = Function::new(
            ctx.clone(),
            move |ctx: Ctx<'js>, mode: String| -> rquickjs::Result<()> {
                if !crate::types::VALID_VIEW_MODES.contains(&mode.as_str()) {
                    return Err(rquickjs::Exception::throw_message(
                        &ctx,
                        &format!(
                            "Invalid view mode \"{}\": expected \"normal\", \"pageLayout\", or \"pageBreakPreview\"",
                            mode
                        ),
                    ));
                }
                let mut ctx_ref = sc.borrow_mut();
                ctx_ref.host.view_mode = mode.clone();
                ctx_ref
                    .deferred_actions
                    .borrow_mut()
                    .push(DeferredAction::SetViewMode { mode });
                Ok(())
            },
        )
        .map_err(|e| format!("Failed to create setViewMode: {}", e))?;
        calcula
            .set("setViewMode", func)
            .map_err(|e| format!("Failed to set setViewMode: {}", e))?;
    }

    // getZoom() -> number (REAL percent, 100 = 100%)
    {
        let sc = shared_ctx.clone();
        let func = Function::new(ctx.clone(), move || -> f64 {
            sc.borrow().host.zoom
        })
        .map_err(|e| format!("Failed to create getZoom: {}", e))?;
        calcula
            .set("getZoom", func)
            .map_err(|e| format!("Failed to set getZoom: {}", e))?;
    }

    // setZoom(percent) — REAL percent, validated to [10, 400]; out-of-range or
    // non-finite THROWS. (The parameter was always DOCUMENTED as a percent but
    // used to carry a factor — healed end-to-end, see types.rs HostState.zoom.)
    {
        let sc = shared_ctx.clone();
        let func = Function::new(
            ctx.clone(),
            move |ctx: Ctx<'js>, percent: f64| -> rquickjs::Result<()> {
                if !percent.is_finite()
                    || percent < crate::types::ZOOM_MIN_PERCENT
                    || percent > crate::types::ZOOM_MAX_PERCENT
                {
                    return Err(rquickjs::Exception::throw_message(
                        &ctx,
                        &format!(
                            "Invalid zoom {}: expected a percent between {} and {}",
                            percent,
                            crate::types::ZOOM_MIN_PERCENT,
                            crate::types::ZOOM_MAX_PERCENT
                        ),
                    ));
                }
                let mut ctx_ref = sc.borrow_mut();
                ctx_ref.host.zoom = percent;
                ctx_ref
                    .deferred_actions
                    .borrow_mut()
                    .push(DeferredAction::SetZoom { percent });
                Ok(())
            },
        )
        .map_err(|e| format!("Failed to create setZoom: {}", e))?;
        calcula
            .set("setZoom", func)
            .map_err(|e| format!("Failed to set setZoom: {}", e))?;
    }

    // getReferenceStyle() -> "A1" | "R1C1"
    {
        let sc = shared_ctx.clone();
        let func = Function::new(ctx.clone(), move || -> String {
            sc.borrow().host.reference_style.clone()
        })
        .map_err(|e| format!("Failed to create getReferenceStyle: {}", e))?;
        calcula
            .set("getReferenceStyle", func)
            .map_err(|e| format!("Failed to set getReferenceStyle: {}", e))?;
    }

    // setReferenceStyle(style)
    {
        let sc = shared_ctx.clone();
        let func = Function::new(ctx.clone(), move |style: String| {
            let mut ctx = sc.borrow_mut();
            ctx.host.reference_style = style.clone();
            ctx.deferred_actions
                .borrow_mut()
                .push(DeferredAction::SetReferenceStyle { style });
        })
        .map_err(|e| format!("Failed to create setReferenceStyle: {}", e))?;
        calcula
            .set("setReferenceStyle", func)
            .map_err(|e| format!("Failed to set setReferenceStyle: {}", e))?;
    }

    // ========================================================================
    // Sheet Operations
    // ========================================================================

    // nextSheet() - switch to next sheet (wrapping)
    // Queues the activation as well, so the host follows the script (see
    // ops/sheets.rs setActiveSheet).
    {
        let sc = shared_ctx.clone();
        let func = Function::new(ctx.clone(), move || {
            let mut ctx = sc.borrow_mut();
            let count = ctx.grids.len();
            if count > 0 {
                ctx.active_sheet = (ctx.active_sheet + 1) % count;
                let sheet_index = ctx.active_sheet;
                ctx.deferred_actions
                    .borrow_mut()
                    .push(DeferredAction::ActivateSheet { sheet_index });
            }
        })
        .map_err(|e| format!("Failed to create nextSheet: {}", e))?;
        calcula
            .set("nextSheet", func)
            .map_err(|e| format!("Failed to set nextSheet: {}", e))?;
    }

    // previousSheet() - switch to previous sheet (wrapping)
    {
        let sc = shared_ctx.clone();
        let func = Function::new(ctx.clone(), move || {
            let mut ctx = sc.borrow_mut();
            let count = ctx.grids.len();
            if count > 0 {
                ctx.active_sheet = if ctx.active_sheet == 0 {
                    count - 1
                } else {
                    ctx.active_sheet - 1
                };
                let sheet_index = ctx.active_sheet;
                ctx.deferred_actions
                    .borrow_mut()
                    .push(DeferredAction::ActivateSheet { sheet_index });
            }
        })
        .map_err(|e| format!("Failed to create previousSheet: {}", e))?;
        calcula
            .set("previousSheet", func)
            .map_err(|e| format!("Failed to set previousSheet: {}", e))?;
    }

    // getSheetVisibility(indexOrName) -> "visible" | "hidden" | "veryHidden"
    // Accepts a 0-based index or a sheet name; a miss THROWS (ops/mod.rs).
    {
        let sc = shared_ctx.clone();
        let func = Function::new(
            ctx.clone(),
            move |ctx: Ctx<'js>, key: Value<'js>| -> rquickjs::Result<String> {
                let ctx_ref = sc.borrow();
                let idx = resolve_sheet_key(&ctx, &ctx_ref, &key)?;
                Ok(ctx_ref
                    .host
                    .sheet_visibility
                    .get(idx)
                    .cloned()
                    .unwrap_or_else(|| "visible".to_string()))
            },
        )
        .map_err(|e| format!("Failed to create getSheetVisibility: {}", e))?;
        calcula
            .set("getSheetVisibility", func)
            .map_err(|e| format!("Failed to set getSheetVisibility: {}", e))?;
    }

    // hideSheet(indexOrName, level?) - set sheet visibility to "hidden" or
    // "veryHidden". Accepts a 0-based index or a sheet name; a miss THROWS.
    {
        let sc = shared_ctx.clone();
        let func = Function::new(
            ctx.clone(),
            move |ctx: Ctx<'js>,
                  key: Value<'js>,
                  level: rquickjs::function::Opt<String>|
                  -> rquickjs::Result<()> {
                let idx = resolve_sheet_key(&ctx, &sc.borrow(), &key)?;
                let visibility = level.0.unwrap_or_else(|| "hidden".to_string());
                let mut ctx_ref = sc.borrow_mut();
                // Extend visibility vec if needed
                while ctx_ref.host.sheet_visibility.len() <= idx {
                    ctx_ref.host.sheet_visibility.push("visible".to_string());
                }
                ctx_ref.host.sheet_visibility[idx] = visibility.clone();
                ctx_ref
                    .deferred_actions
                    .borrow_mut()
                    .push(DeferredAction::SetSheetVisibility {
                        sheet_index: idx,
                        visibility,
                    });
                Ok(())
            },
        )
        .map_err(|e| format!("Failed to create hideSheet: {}", e))?;
        calcula
            .set("hideSheet", func)
            .map_err(|e| format!("Failed to set hideSheet: {}", e))?;
    }

    // unhideSheet(indexOrName) - set sheet visibility to "visible".
    // Accepts a 0-based index or a sheet name; a miss THROWS (ops/mod.rs).
    {
        let sc = shared_ctx.clone();
        let func = Function::new(
            ctx.clone(),
            move |ctx: Ctx<'js>, key: Value<'js>| -> rquickjs::Result<()> {
                let idx = resolve_sheet_key(&ctx, &sc.borrow(), &key)?;
                let mut ctx_ref = sc.borrow_mut();
                while ctx_ref.host.sheet_visibility.len() <= idx {
                    ctx_ref.host.sheet_visibility.push("visible".to_string());
                }
                ctx_ref.host.sheet_visibility[idx] = "visible".to_string();
                ctx_ref
                    .deferred_actions
                    .borrow_mut()
                    .push(DeferredAction::SetSheetVisibility {
                        sheet_index: idx,
                        visibility: "visible".to_string(),
                    });
                Ok(())
            },
        )
        .map_err(|e| format!("Failed to create unhideSheet: {}", e))?;
        calcula
            .set("unhideSheet", func)
            .map_err(|e| format!("Failed to set unhideSheet: {}", e))?;
    }

    // ========================================================================
    // Workbook Properties
    // ========================================================================

    // getWorkbookProperty(key) -> string | ""
    {
        let sc = shared_ctx.clone();
        let func = Function::new(ctx.clone(), move |key: String| -> String {
            let ctx = sc.borrow();
            ctx.host
                .workbook_properties
                .get(&key)
                .cloned()
                .unwrap_or_default()
        })
        .map_err(|e| format!("Failed to create getWorkbookProperty: {}", e))?;
        calcula
            .set("getWorkbookProperty", func)
            .map_err(|e| format!("Failed to set getWorkbookProperty: {}", e))?;
    }

    // setWorkbookProperty(key, value)
    //
    // Writes BOTH the in-context copy (so a later getWorkbookProperty in the
    // same script reads back what it wrote) and the changed-properties map that
    // the host applies afterwards. Mutating only the clone — what this used to
    // do — silently dropped the write when the context was discarded.
    {
        let sc = shared_ctx.clone();
        let func = Function::new(ctx.clone(), move |key: String, value: String| {
            let mut ctx = sc.borrow_mut();
            ctx.workbook_properties_changed
                .borrow_mut()
                .insert(key.clone(), value.clone());
            ctx.host.workbook_properties.insert(key, value);
        })
        .map_err(|e| format!("Failed to create setWorkbookProperty: {}", e))?;
        calcula
            .set("setWorkbookProperty", func)
            .map_err(|e| format!("Failed to set setWorkbookProperty: {}", e))?;
    }

    // ========================================================================
    // Formatting & Style
    // ========================================================================

    // getNamedStyles() -> JSON array of style names
    {
        let sc = shared_ctx.clone();
        let func = Function::new(ctx.clone(), move || -> String {
            let ctx = sc.borrow();
            serde_json::to_string(&ctx.host.named_style_names).unwrap_or_else(|_| "[]".to_string())
        })
        .map_err(|e| format!("Failed to create getNamedStyles: {}", e))?;
        calcula
            .set("getNamedStyles", func)
            .map_err(|e| format!("Failed to set getNamedStyles: {}", e))?;
    }

    // applyNamedStyle(styleName, row, col, endRow?, endCol?)
    // Single cell when endRow/endCol are omitted; an INCLUSIVE rect when both
    // are given (Wave 4). Passing exactly one of the two THROWS — a half-rect
    // has no meaning and silently ignoring the stray corner would misformat.
    {
        let sc = shared_ctx.clone();
        let func = Function::new(
            ctx.clone(),
            move |ctx: Ctx<'js>,
                  name: String,
                  row: i32,
                  col: i32,
                  end_row: rquickjs::function::Opt<i32>,
                  end_col: rquickjs::function::Opt<i32>|
                  -> rquickjs::Result<()> {
                let (end_row, end_col) = match (end_row.0, end_col.0) {
                    (Some(er), Some(ec)) => (Some(er.max(0) as u32), Some(ec.max(0) as u32)),
                    (None, None) => (None, None),
                    _ => {
                        return Err(rquickjs::Exception::throw_message(
                            &ctx,
                            "applyNamedStyle: endRow and endCol must be given together",
                        ));
                    }
                };
                sc.borrow()
                    .deferred_actions
                    .borrow_mut()
                    .push(DeferredAction::ApplyNamedStyle {
                        name,
                        row: row.max(0) as u32,
                        col: col.max(0) as u32,
                        end_row,
                        end_col,
                    });
                Ok(())
            },
        )
        .map_err(|e| format!("Failed to create applyNamedStyle: {}", e))?;
        calcula
            .set("applyNamedStyle", func)
            .map_err(|e| format!("Failed to set applyNamedStyle: {}", e))?;
    }

    // ========================================================================
    // Calculation
    // ========================================================================

    // getCalculationState() -> "done" (stub, always returns done)
    {
        let func = Function::new(ctx.clone(), move || -> String {
            "done".to_string()
        })
        .map_err(|e| format!("Failed to create getCalculationState: {}", e))?;
        calcula
            .set("getCalculationState", func)
            .map_err(|e| format!("Failed to set getCalculationState: {}", e))?;
    }

    // getIterationSettings() -> JSON { enabled, maxIterations, maxChange }
    {
        let sc = shared_ctx.clone();
        let func = Function::new(ctx.clone(), move || -> String {
            let ctx = sc.borrow();
            serde_json::json!({
                "enabled": ctx.host.iteration_enabled,
                "maxIterations": ctx.host.iteration_max_count,
                "maxChange": ctx.host.iteration_max_change
            })
            .to_string()
        })
        .map_err(|e| format!("Failed to create getIterationSettings: {}", e))?;
        calcula
            .set("getIterationSettings", func)
            .map_err(|e| format!("Failed to set getIterationSettings: {}", e))?;
    }

    // setIterationSettings(enabled, maxIter, maxChange)
    {
        let sc = shared_ctx.clone();
        let func = Function::new(
            ctx.clone(),
            move |enabled: bool, max_iterations: i32, max_change: f64| {
                let mut ctx = sc.borrow_mut();
                ctx.host.iteration_enabled = enabled;
                ctx.host.iteration_max_count = max_iterations.max(0) as u32;
                ctx.host.iteration_max_change = max_change;
                ctx.deferred_actions
                    .borrow_mut()
                    .push(DeferredAction::SetIterationSettings {
                        enabled,
                        max_iterations: max_iterations.max(0) as u32,
                        max_change,
                    });
            },
        )
        .map_err(|e| format!("Failed to create setIterationSettings: {}", e))?;
        calcula
            .set("setIterationSettings", func)
            .map_err(|e| format!("Failed to set setIterationSettings: {}", e))?;
    }

    // ========================================================================
    // Data
    // ========================================================================

    // fillDown(startRow, startCol, endRow, endCol)
    {
        let sc = shared_ctx.clone();
        let func = Function::new(
            ctx.clone(),
            move |start_row: i32, start_col: i32, end_row: i32, end_col: i32| {
                sc.borrow()
                    .deferred_actions
                    .borrow_mut()
                    .push(DeferredAction::FillDown {
                        start_row: start_row.max(0) as u32,
                        start_col: start_col.max(0) as u32,
                        end_row: end_row.max(0) as u32,
                        end_col: end_col.max(0) as u32,
                    });
            },
        )
        .map_err(|e| format!("Failed to create fillDown: {}", e))?;
        calcula
            .set("fillDown", func)
            .map_err(|e| format!("Failed to set fillDown: {}", e))?;
    }

    // fillRight(startRow, startCol, endRow, endCol)
    {
        let sc = shared_ctx.clone();
        let func = Function::new(
            ctx.clone(),
            move |start_row: i32, start_col: i32, end_row: i32, end_col: i32| {
                sc.borrow()
                    .deferred_actions
                    .borrow_mut()
                    .push(DeferredAction::FillRight {
                        start_row: start_row.max(0) as u32,
                        start_col: start_col.max(0) as u32,
                        end_row: end_row.max(0) as u32,
                        end_col: end_col.max(0) as u32,
                    });
            },
        )
        .map_err(|e| format!("Failed to create fillRight: {}", e))?;
        calcula
            .set("fillRight", func)
            .map_err(|e| format!("Failed to set fillRight: {}", e))?;
    }

    // getCurrentRegion(row, col, sheet?) -> JSON { startRow, startCol, endRow, endCol, empty }
    // Contiguous data block containing (row, col) — Excel's CurrentRegion.
    // The algorithm is engine::navigation::current_region, the SAME function
    // behind the get_current_region Tauri command (zero drift). `empty: true`
    // means the cell is isolated and empty; the box then collapses to the
    // starting cell. `sheet` is a 0-based index or name (ops/mod.rs resolver).
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
                let grid = &ctx_ref.grids[si];

                let row = row.max(0) as u32;
                let col = col.max(0) as u32;

                let json = match engine::navigation::current_region(grid, row, col) {
                    Some((start_row, start_col, end_row, end_col)) => serde_json::json!({
                        "startRow": start_row,
                        "startCol": start_col,
                        "endRow": end_row,
                        "endCol": end_col,
                        "empty": false
                    }),
                    None => serde_json::json!({
                        "startRow": row,
                        "startCol": col,
                        "endRow": row,
                        "endCol": col,
                        "empty": true
                    }),
                };
                Ok(json.to_string())
            },
        )
        .map_err(|e| format!("Failed to create getCurrentRegion: {}", e))?;
        calcula
            .set("getCurrentRegion", func)
            .map_err(|e| format!("Failed to set getCurrentRegion: {}", e))?;
    }

    // getRangeEdge(row, col, direction, sheet?) -> JSON { row, col }
    // Excel Ctrl+Arrow / Range.End edge navigation over the FULL Excel grid
    // bounds. Same engine::navigation::range_edge as the keyboard handler and
    // the get_range_edge Tauri command. `direction` is "up" | "down" | "left"
    // | "right"; anything else THROWS.
    {
        let sc = shared_ctx.clone();
        let func = Function::new(
            ctx.clone(),
            move |ctx: Ctx<'js>,
                  row: i32,
                  col: i32,
                  direction: String,
                  sheet: rquickjs::function::Opt<Value<'js>>|
                  -> rquickjs::Result<String> {
                let ctx_ref = sc.borrow();
                let si = resolve_opt_sheet_key(&ctx, &ctx_ref, sheet.0.as_ref())?;
                let dir = engine::navigation::EdgeDirection::parse(&direction).ok_or_else(|| {
                    rquickjs::Exception::throw_message(
                        &ctx,
                        &format!(
                            "Invalid direction \"{}\": expected \"up\", \"down\", \"left\", or \"right\"",
                            direction
                        ),
                    )
                })?;
                let grid = &ctx_ref.grids[si];
                let (target_row, target_col) = engine::navigation::range_edge(
                    grid,
                    row.max(0) as u32,
                    col.max(0) as u32,
                    dir,
                    engine::navigation::EXCEL_MAX_ROW_INDEX,
                    engine::navigation::EXCEL_MAX_COL_INDEX,
                );
                Ok(serde_json::json!({ "row": target_row, "col": target_col }).to_string())
            },
        )
        .map_err(|e| format!("Failed to create getRangeEdge: {}", e))?;
        calcula
            .set("getRangeEdge", func)
            .map_err(|e| format!("Failed to set getRangeEdge: {}", e))?;
    }

    // getScrollArea() -> string | ""
    {
        let sc = shared_ctx.clone();
        let func = Function::new(ctx.clone(), move || -> String {
            sc.borrow().host.scroll_area.clone().unwrap_or_default()
        })
        .map_err(|e| format!("Failed to create getScrollArea: {}", e))?;
        calcula
            .set("getScrollArea", func)
            .map_err(|e| format!("Failed to set getScrollArea: {}", e))?;
    }

    // setScrollArea(area) - pass empty string to clear
    {
        let sc = shared_ctx.clone();
        let func = Function::new(ctx.clone(), move |area: String| {
            let area_opt = if area.is_empty() { None } else { Some(area) };
            let mut ctx = sc.borrow_mut();
            ctx.host.scroll_area = area_opt.clone();
            ctx.deferred_actions
                .borrow_mut()
                .push(DeferredAction::SetScrollArea { area: area_opt });
        })
        .map_err(|e| format!("Failed to create setScrollArea: {}", e))?;
        calcula
            .set("setScrollArea", func)
            .map_err(|e| format!("Failed to set setScrollArea: {}", e))?;
    }

    // ========================================================================
    // Display
    // ========================================================================

    // setStatusBarText(text) - set the status bar message
    {
        let sc = shared_ctx.clone();
        let func = Function::new(ctx.clone(), move |text: String| {
            sc.borrow()
                .deferred_actions
                .borrow_mut()
                .push(DeferredAction::SetStatusBar {
                    message: Some(text),
                });
        })
        .map_err(|e| format!("Failed to create setStatusBarText: {}", e))?;
        calcula
            .set("setStatusBarText", func)
            .map_err(|e| format!("Failed to set setStatusBarText: {}", e))?;
    }

    // clearStatusBarText() - reset status bar to default
    {
        let sc = shared_ctx.clone();
        let func = Function::new(ctx.clone(), move || {
            sc.borrow()
                .deferred_actions
                .borrow_mut()
                .push(DeferredAction::SetStatusBar { message: None });
        })
        .map_err(|e| format!("Failed to create clearStatusBarText: {}", e))?;
        calcula
            .set("clearStatusBarText", func)
            .map_err(|e| format!("Failed to set clearStatusBarText: {}", e))?;
    }

    // setDisplayGridlines(value)
    {
        let sc = shared_ctx.clone();
        let func = Function::new(ctx.clone(), move |value: bool| {
            let mut ctx = sc.borrow_mut();
            ctx.host.display_gridlines = value;
            ctx.deferred_actions
                .borrow_mut()
                .push(DeferredAction::SetDisplayGridlines { value });
        })
        .map_err(|e| format!("Failed to create setDisplayGridlines: {}", e))?;
        calcula
            .set("setDisplayGridlines", func)
            .map_err(|e| format!("Failed to set setDisplayGridlines: {}", e))?;
    }

    // setDisplayHeadings(value)
    {
        let sc = shared_ctx.clone();
        let func = Function::new(ctx.clone(), move |value: bool| {
            let mut ctx = sc.borrow_mut();
            ctx.host.display_headings = value;
            ctx.deferred_actions
                .borrow_mut()
                .push(DeferredAction::SetDisplayHeadings { value });
        })
        .map_err(|e| format!("Failed to create setDisplayHeadings: {}", e))?;
        calcula
            .set("setDisplayHeadings", func)
            .map_err(|e| format!("Failed to set setDisplayHeadings: {}", e))?;
    }

    // getDisplayGridlines() -> bool
    {
        let sc = shared_ctx.clone();
        let func = Function::new(ctx.clone(), move || -> bool {
            sc.borrow().host.display_gridlines
        })
        .map_err(|e| format!("Failed to create getDisplayGridlines: {}", e))?;
        calcula
            .set("getDisplayGridlines", func)
            .map_err(|e| format!("Failed to set getDisplayGridlines: {}", e))?;
    }

    // getDisplayHeadings() -> bool
    {
        let sc = shared_ctx.clone();
        let func = Function::new(ctx.clone(), move || -> bool {
            sc.borrow().host.display_headings
        })
        .map_err(|e| format!("Failed to create getDisplayHeadings: {}", e))?;
        calcula
            .set("getDisplayHeadings", func)
            .map_err(|e| format!("Failed to set getDisplayHeadings: {}", e))?;
    }

    // getDisplayFormulas() -> bool — whether the grid shows formula text
    // instead of computed values (the app's Ctrl+` formula-view toggle).
    {
        let sc = shared_ctx.clone();
        let func = Function::new(ctx.clone(), move || -> bool {
            sc.borrow().host.display_formulas
        })
        .map_err(|e| format!("Failed to create getDisplayFormulas: {}", e))?;
        calcula
            .set("getDisplayFormulas", func)
            .map_err(|e| format!("Failed to set getDisplayFormulas: {}", e))?;
    }

    // setDisplayFormulas(value)
    {
        let sc = shared_ctx.clone();
        let func = Function::new(ctx.clone(), move |value: bool| {
            let mut ctx = sc.borrow_mut();
            ctx.host.display_formulas = value;
            ctx.deferred_actions
                .borrow_mut()
                .push(DeferredAction::SetDisplayFormulas { value });
        })
        .map_err(|e| format!("Failed to create setDisplayFormulas: {}", e))?;
        calcula
            .set("setDisplayFormulas", func)
            .map_err(|e| format!("Failed to set setDisplayFormulas: {}", e))?;
    }

    Ok(())
}
