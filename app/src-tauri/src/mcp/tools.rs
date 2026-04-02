//! FILENAME: app/src-tauri/src/mcp/tools.rs
//! Tool helper functions that operate on AppState via the Tauri AppHandle.
//! Each function reads/writes the spreadsheet state and returns a text result.

use tauri::{AppHandle, Manager};
use crate::AppState;
use crate::format_cell_value;
use calcula_format::ai::{AiSerializeOptions, serialize_for_ai, SheetInput};
use super::server::ApplyFormattingParams;

// ============================================================================
// Helpers
// ============================================================================

fn col_letter(col: u32) -> String {
    let mut result = String::new();
    let mut c = col as i64;
    loop {
        result.insert(0, (b'A' + (c % 26) as u8) as char);
        c = c / 26 - 1;
        if c < 0 {
            break;
        }
    }
    result
}

// ============================================================================
// Tool Implementations
// ============================================================================

/// Read cells from a rectangular range and return as a formatted table.
pub fn read_cell_range(
    handle: &AppHandle,
    start_row: u32,
    start_col: u32,
    end_row: u32,
    end_col: u32,
) -> Result<String, String> {
    let state = handle.state::<AppState>();
    let grid = state.grid.lock().map_err(|e| e.to_string())?;
    let styles = state.style_registry.lock().map_err(|e| e.to_string())?;

    let mut table = String::new();
    let mut formulas: Vec<String> = Vec::new();

    for row in start_row..=end_row {
        let mut vals: Vec<String> = Vec::new();
        for col in start_col..=end_col {
            if let Some(cell) = grid.get_cell(row, col) {
                let style = styles.get(cell.style_index);
                let display = format_cell_value(&cell.value, style);
                vals.push(display);
                if let Some(ref f) = cell.formula {
                    formulas.push(format!("{}{}:{}", col_letter(col), row + 1, f));
                }
            } else {
                vals.push(String::new());
            }
        }
        table.push_str(&format!("| {} |\n", vals.join(" | ")));
    }

    if !formulas.is_empty() {
        table.push_str("\nFormulas:\n");
        for f in &formulas {
            table.push_str(&format!("  {}\n", f));
        }
    }

    if table.is_empty() {
        Ok("(empty range)".to_string())
    } else {
        Ok(table)
    }
}

/// Write a single cell value (or formula).
pub fn write_cell(
    handle: &AppHandle,
    row: u32,
    col: u32,
    value: &str,
) -> Result<String, String> {
    // Delegate to the script engine for simplicity - it handles parsing,
    // formula evaluation, and dependency recalculation correctly.
    let script = if value.starts_with('=') {
        // For formulas, we need to set the formula string
        format!(
            "Calcula.setCellValue({}, {}, \"{}\");",
            row,
            col,
            value.replace('\\', "\\\\").replace('"', "\\\"")
        )
    } else {
        // For plain values, try numeric first
        match value.parse::<f64>() {
            Ok(_) => format!("Calcula.setCellValue({}, {}, {});", row, col, value),
            Err(_) => format!(
                "Calcula.setCellValue({}, {}, \"{}\");",
                row,
                col,
                value.replace('\\', "\\\\").replace('"', "\\\"")
            ),
        }
    };

    execute_script(handle, &script)?;
    Ok(format!("Set {}{} = {}", col_letter(col), row + 1, value))
}

/// Write multiple cells at once.
pub fn write_cell_range(
    handle: &AppHandle,
    cells: &[super::server::CellInput],
) -> Result<String, String> {
    let mut script = String::new();
    for cell in cells {
        if cell.value.starts_with('=') {
            script.push_str(&format!(
                "Calcula.setCellValue({}, {}, \"{}\");\n",
                cell.row,
                cell.col,
                cell.value.replace('\\', "\\\\").replace('"', "\\\"")
            ));
        } else {
            match cell.value.parse::<f64>() {
                Ok(_) => {
                    script.push_str(&format!(
                        "Calcula.setCellValue({}, {}, {});\n",
                        cell.row, cell.col, cell.value
                    ));
                }
                Err(_) => {
                    script.push_str(&format!(
                        "Calcula.setCellValue({}, {}, \"{}\");\n",
                        cell.row,
                        cell.col,
                        cell.value.replace('\\', "\\\\").replace('"', "\\\"")
                    ));
                }
            }
        }
    }

    execute_script(handle, &script)?;
    Ok(format!("Set {} cell(s)", cells.len()))
}

/// Get an AI-optimized workbook summary.
pub fn get_sheet_summary(
    handle: &AppHandle,
    max_chars: u32,
) -> Result<String, String> {
    let state = handle.state::<AppState>();
    let grids = state.grids.lock().map_err(|e| e.to_string())?;
    let sheet_names = state.sheet_names.lock().map_err(|e| e.to_string())?;
    let styles = state.style_registry.lock().map_err(|e| e.to_string())?;
    let active_grid = state.grid.lock().map_err(|e| e.to_string())?;
    let active_sheet = *state.active_sheet.lock().map_err(|e| e.to_string())?;

    let options = AiSerializeOptions {
        max_chars: max_chars as usize,
        include_styles: false,
        focus_sheet: None,
        max_sample_rows: 5,
        selection_context: None,
        tables_json: None,
    };

    let mut sheet_inputs: Vec<SheetInput> = Vec::new();
    for (i, name) in sheet_names.iter().enumerate() {
        if i == active_sheet {
            sheet_inputs.push(SheetInput {
                name,
                grid: &active_grid,
                styles: &styles,
            });
        } else if let Some(grid) = grids.get(i) {
            sheet_inputs.push(SheetInput {
                name,
                grid,
                styles: &styles,
            });
        }
    }

    Ok(serialize_for_ai(&sheet_inputs, &options))
}

/// Apply formatting to a range of cells.
pub fn apply_cell_formatting(
    handle: &AppHandle,
    params: &ApplyFormattingParams,
) -> Result<String, String> {
    let state = handle.state::<AppState>();
    let mut grid = state.grid.lock().map_err(|e| e.to_string())?;
    let mut grids = state.grids.lock().map_err(|e| e.to_string())?;
    let active_sheet = *state.active_sheet.lock().map_err(|e| e.to_string())?;
    let mut styles = state.style_registry.lock().map_err(|e| e.to_string())?;

    let mut count = 0u32;
    for row in params.start_row..=params.end_row {
        for col in params.start_col..=params.end_col {
            let old_style_index = grid
                .get_cell(row, col)
                .map(|c| c.style_index)
                .unwrap_or(0);

            let mut new_style = styles.get(old_style_index).clone();

            if let Some(bold) = params.bold {
                new_style.font.bold = bold;
            }
            if let Some(italic) = params.italic {
                new_style.font.italic = italic;
            }
            if let Some(ref color) = params.text_color {
                if let Some(c) = engine::Color::from_hex(color) {
                    new_style.font.color = engine::ThemeColor::Absolute(c);
                }
            }
            if let Some(ref color) = params.background_color {
                if let Some(c) = engine::Color::from_hex(color) {
                    new_style.fill = engine::Fill::Solid { color: engine::ThemeColor::Absolute(c) };
                }
            }
            if let Some(ref fmt) = params.number_format {
                new_style.number_format = engine::NumberFormat::Custom {
                    format: fmt.clone(),
                };
            }
            if let Some(ref align) = params.text_align {
                new_style.text_align = match align.as_str() {
                    "left" => engine::TextAlign::Left,
                    "center" => engine::TextAlign::Center,
                    "right" => engine::TextAlign::Right,
                    _ => engine::TextAlign::General,
                };
            }

            let new_index = styles.get_or_create(new_style);

            if let Some(cell) = grid.get_cell(row, col) {
                let mut updated = cell.clone();
                updated.style_index = new_index;
                grid.set_cell(row, col, updated.clone());
                if active_sheet < grids.len() {
                    grids[active_sheet].set_cell(row, col, updated);
                }
            } else {
                let cell = engine::Cell {
                    value: engine::CellValue::Empty,
                    formula: None,
                    style_index: new_index,
                    rich_text: None,
                    cached_ast: None,
                };
                grid.set_cell(row, col, cell.clone());
                if active_sheet < grids.len() {
                    grids[active_sheet].set_cell(row, col, cell);
                }
            }
            count += 1;
        }
    }

    Ok(format!(
        "Applied formatting to {} cell(s) ({}{}:{}{})",
        count,
        col_letter(params.start_col),
        params.start_row + 1,
        col_letter(params.end_col),
        params.end_row + 1
    ))
}

/// Execute a JavaScript script via the script engine.
pub fn execute_script(
    handle: &AppHandle,
    code: &str,
) -> Result<String, String> {
    let state = handle.state::<AppState>();

    // Clone data for isolated execution (same pattern as scripting/commands.rs)
    let grids = state.grids.lock().map_err(|e| e.to_string())?.clone();
    let style_registry = state.style_registry.lock().map_err(|e| e.to_string())?.clone();
    let sheet_names = state.sheet_names.lock().map_err(|e| e.to_string())?.clone();
    let active_sheet = *state.active_sheet.lock().map_err(|e| e.to_string())?;

    let (result, modified_grids) = script_engine::ScriptEngine::run(
        code,
        "mcp-script.js",
        grids,
        style_registry,
        sheet_names,
        active_sheet,
    );

    match &result {
        script_engine::ScriptResult::Success {
            output,
            cells_modified,
            duration_ms,
        } => {
            // Apply modified grids back to state
            if *cells_modified > 0 && !modified_grids.is_empty() {
                let active_grid_clone = modified_grids.get(active_sheet).cloned();

                let mut app_grids = state.grids.lock().map_err(|e| e.to_string())?;
                *app_grids = modified_grids;
                drop(app_grids);

                if let Some(new_active_grid) = active_grid_clone {
                    let mut grid = state.grid.lock().map_err(|e| e.to_string())?;
                    *grid = new_active_grid;
                }
            }

            let output_text = output.join("\n");
            Ok(format!(
                "Script executed ({}ms, {} cells modified){}",
                duration_ms,
                cells_modified,
                if output_text.is_empty() {
                    String::new()
                } else {
                    format!("\nOutput:\n{}", output_text)
                }
            ))
        }
        script_engine::ScriptResult::Error {
            message,
            output,
            ..
        } => {
            let output_text = output.join("\n");
            Err(format!(
                "Script error: {}{}",
                message,
                if output_text.is_empty() {
                    String::new()
                } else {
                    format!("\nOutput:\n{}", output_text)
                }
            ))
        }
    }
}
