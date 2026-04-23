//! FILENAME: core/script-engine/src/ops/extended.rs
//! PURPOSE: Extended operations for the script engine.
//! CONTEXT: Registers navigation, view, formatting, calculation, data, and
//! display control methods on the Calcula global object.

use rquickjs::{Function, Object};
use std::cell::RefCell;
use std::rc::Rc;

use crate::types::{cell_value_to_string, DeferredAction, ScriptContext};

/// Register extended operations on the Calcula object.
pub fn register_extended_ops<'js>(
    ctx: &rquickjs::Ctx<'js>,
    calcula: &Object<'js>,
    shared_ctx: Rc<RefCell<ScriptContext>>,
) -> Result<(), String> {
    // ========================================================================
    // Navigation & View
    // ========================================================================

    // getViewMode() -> "normal" | "pageBreakPreview"
    {
        let sc = shared_ctx.clone();
        let func = Function::new(ctx.clone(), move || -> String {
            sc.borrow().view_mode.clone()
        })
        .map_err(|e| format!("Failed to create getViewMode: {}", e))?;
        calcula
            .set("getViewMode", func)
            .map_err(|e| format!("Failed to set getViewMode: {}", e))?;
    }

    // setViewMode(mode)
    {
        let sc = shared_ctx.clone();
        let func = Function::new(ctx.clone(), move |mode: String| {
            let mut ctx = sc.borrow_mut();
            ctx.view_mode = mode.clone();
            ctx.deferred_actions
                .borrow_mut()
                .push(DeferredAction::SetViewMode { mode });
        })
        .map_err(|e| format!("Failed to create setViewMode: {}", e))?;
        calcula
            .set("setViewMode", func)
            .map_err(|e| format!("Failed to set setViewMode: {}", e))?;
    }

    // getZoom() -> number (percentage as decimal, e.g. 1.0 = 100%)
    {
        let sc = shared_ctx.clone();
        let func = Function::new(ctx.clone(), move || -> f64 {
            sc.borrow().zoom
        })
        .map_err(|e| format!("Failed to create getZoom: {}", e))?;
        calcula
            .set("getZoom", func)
            .map_err(|e| format!("Failed to set getZoom: {}", e))?;
    }

    // setZoom(percent)
    {
        let sc = shared_ctx.clone();
        let func = Function::new(ctx.clone(), move |percent: f64| {
            let mut ctx = sc.borrow_mut();
            ctx.zoom = percent;
            ctx.deferred_actions
                .borrow_mut()
                .push(DeferredAction::SetZoom { percent });
        })
        .map_err(|e| format!("Failed to create setZoom: {}", e))?;
        calcula
            .set("setZoom", func)
            .map_err(|e| format!("Failed to set setZoom: {}", e))?;
    }

    // getReferenceStyle() -> "A1" | "R1C1"
    {
        let sc = shared_ctx.clone();
        let func = Function::new(ctx.clone(), move || -> String {
            sc.borrow().reference_style.clone()
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
            ctx.reference_style = style.clone();
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
    {
        let sc = shared_ctx.clone();
        let func = Function::new(ctx.clone(), move || {
            let mut ctx = sc.borrow_mut();
            let count = ctx.grids.len();
            if count > 0 {
                ctx.active_sheet = (ctx.active_sheet + 1) % count;
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
            }
        })
        .map_err(|e| format!("Failed to create previousSheet: {}", e))?;
        calcula
            .set("previousSheet", func)
            .map_err(|e| format!("Failed to set previousSheet: {}", e))?;
    }

    // getSheetVisibility(index) -> "visible" | "hidden" | "veryHidden"
    {
        let sc = shared_ctx.clone();
        let func = Function::new(ctx.clone(), move |index: i32| -> String {
            let ctx = sc.borrow();
            ctx.sheet_visibility
                .get(index as usize)
                .cloned()
                .unwrap_or_else(|| "visible".to_string())
        })
        .map_err(|e| format!("Failed to create getSheetVisibility: {}", e))?;
        calcula
            .set("getSheetVisibility", func)
            .map_err(|e| format!("Failed to set getSheetVisibility: {}", e))?;
    }

    // hideSheet(index, level?) - set sheet visibility to "hidden" or "veryHidden"
    {
        let sc = shared_ctx.clone();
        let func = Function::new(
            ctx.clone(),
            move |index: i32, level: rquickjs::function::Opt<String>| {
                let visibility = level.0.unwrap_or_else(|| "hidden".to_string());
                let mut ctx = sc.borrow_mut();
                let idx = index as usize;
                // Extend visibility vec if needed
                while ctx.sheet_visibility.len() <= idx {
                    ctx.sheet_visibility.push("visible".to_string());
                }
                ctx.sheet_visibility[idx] = visibility.clone();
                ctx.deferred_actions
                    .borrow_mut()
                    .push(DeferredAction::SetSheetVisibility {
                        sheet_index: idx,
                        visibility,
                    });
            },
        )
        .map_err(|e| format!("Failed to create hideSheet: {}", e))?;
        calcula
            .set("hideSheet", func)
            .map_err(|e| format!("Failed to set hideSheet: {}", e))?;
    }

    // unhideSheet(index) - set sheet visibility to "visible"
    {
        let sc = shared_ctx.clone();
        let func = Function::new(ctx.clone(), move |index: i32| {
            let mut ctx = sc.borrow_mut();
            let idx = index as usize;
            while ctx.sheet_visibility.len() <= idx {
                ctx.sheet_visibility.push("visible".to_string());
            }
            ctx.sheet_visibility[idx] = "visible".to_string();
            ctx.deferred_actions
                .borrow_mut()
                .push(DeferredAction::SetSheetVisibility {
                    sheet_index: idx,
                    visibility: "visible".to_string(),
                });
        })
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
            ctx.workbook_properties
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
    {
        let sc = shared_ctx.clone();
        let func = Function::new(ctx.clone(), move |key: String, value: String| {
            let mut ctx = sc.borrow_mut();
            ctx.workbook_properties.insert(key, value);
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
            serde_json::to_string(&ctx.named_style_names).unwrap_or_else(|_| "[]".to_string())
        })
        .map_err(|e| format!("Failed to create getNamedStyles: {}", e))?;
        calcula
            .set("getNamedStyles", func)
            .map_err(|e| format!("Failed to set getNamedStyles: {}", e))?;
    }

    // applyNamedStyle(styleName, row, col)
    {
        let sc = shared_ctx.clone();
        let func = Function::new(ctx.clone(), move |name: String, row: i32, col: i32| {
            sc.borrow()
                .deferred_actions
                .borrow_mut()
                .push(DeferredAction::ApplyNamedStyle {
                    name,
                    row: row.max(0) as u32,
                    col: col.max(0) as u32,
                });
        })
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
                "enabled": ctx.iteration_enabled,
                "maxIterations": ctx.iteration_max_count,
                "maxChange": ctx.iteration_max_change
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
                ctx.iteration_enabled = enabled;
                ctx.iteration_max_count = max_iterations.max(0) as u32;
                ctx.iteration_max_change = max_change;
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

    // getCurrentRegion(row, col) -> JSON { startRow, startCol, endRow, endCol }
    // Scans the active grid for a contiguous block of non-empty cells containing (row, col)
    {
        let sc = shared_ctx.clone();
        let func = Function::new(ctx.clone(), move |row: i32, col: i32| -> String {
            let ctx = sc.borrow();
            let grid = &ctx.grids[ctx.active_sheet];

            let row = row.max(0) as u32;
            let col = col.max(0) as u32;

            // Expand outward from (row, col) to find contiguous data region
            let has_data = |r: u32, c: u32| -> bool {
                grid.get_cell(r, c)
                    .map(|cell| !cell_value_to_string(&cell.value).is_empty())
                    .unwrap_or(false)
            };

            // Check if any cell in a row within the column range has data
            let row_has_data = |r: u32, min_c: u32, max_c: u32| -> bool {
                (min_c..=max_c).any(|c| has_data(r, c))
            };

            // Check if any cell in a column within the row range has data
            let col_has_data = |c: u32, min_r: u32, max_r: u32| -> bool {
                (min_r..=max_r).any(|r| has_data(r, c))
            };

            let mut min_row = row;
            let mut max_row = row;
            let mut min_col = col;
            let mut max_col = col;

            // Iteratively expand until stable
            let mut changed = true;
            while changed {
                changed = false;
                // Expand up
                if min_row > 0 && row_has_data(min_row - 1, min_col, max_col) {
                    min_row -= 1;
                    changed = true;
                }
                // Expand down
                if row_has_data(max_row + 1, min_col, max_col) {
                    max_row += 1;
                    changed = true;
                }
                // Expand left
                if min_col > 0 && col_has_data(min_col - 1, min_row, max_row) {
                    min_col -= 1;
                    changed = true;
                }
                // Expand right
                if col_has_data(max_col + 1, min_row, max_row) {
                    max_col += 1;
                    changed = true;
                }
            }

            serde_json::json!({
                "startRow": min_row,
                "startCol": min_col,
                "endRow": max_row,
                "endCol": max_col
            })
            .to_string()
        })
        .map_err(|e| format!("Failed to create getCurrentRegion: {}", e))?;
        calcula
            .set("getCurrentRegion", func)
            .map_err(|e| format!("Failed to set getCurrentRegion: {}", e))?;
    }

    // getScrollArea() -> string | ""
    {
        let sc = shared_ctx.clone();
        let func = Function::new(ctx.clone(), move || -> String {
            sc.borrow().scroll_area.clone().unwrap_or_default()
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
            ctx.scroll_area = area_opt.clone();
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
            ctx.display_gridlines = value;
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
            ctx.display_headings = value;
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
            sc.borrow().display_gridlines
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
            sc.borrow().display_headings
        })
        .map_err(|e| format!("Failed to create getDisplayHeadings: {}", e))?;
        calcula
            .set("getDisplayHeadings", func)
            .map_err(|e| format!("Failed to set getDisplayHeadings: {}", e))?;
    }

    Ok(())
}
