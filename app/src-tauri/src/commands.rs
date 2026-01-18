// FILENAME: src-tauri/src/commands.rs
// PURPOSE: Tauri command handlers for grid operations.
// CONTEXT: These commands are called from the frontend via Tauri IPC.

use crate::api_types::{CellData, DimensionData, FormattingParams, FormattingResult, StyleData, StyleEntry};
use crate::{
    create_app_state, evaluate_formula, evaluate_formula_multi_sheet, extract_references,
    extract_all_references, format_cell_value, get_recalculation_order, get_column_row_dependents,
    parse_cell_input, update_dependencies, update_column_dependencies, update_row_dependencies,
    update_cross_sheet_dependencies, AppState,
};
use engine::{
    Cell, CellStyle, CellValue, Color, Grid, NumberFormat, StyleRegistry, TextAlign, TextRotation,
    VerticalAlign, CurrencyPosition,
};
use std::collections::{HashMap, HashSet};
use tauri::State;

// ============================================================================
// GRID DATA COMMANDS
// ============================================================================

/// Get cells for a viewport range.
#[tauri::command]
pub fn get_viewport_cells(
    state: State<AppState>,
    start_row: u32,
    start_col: u32,
    end_row: u32,
    end_col: u32,
) -> Vec<CellData> {
    let grid = state.grid.lock().unwrap();
    let styles = state.style_registry.lock().unwrap();
    let mut cells = Vec::new();

    for row in start_row..=end_row {
        for col in start_col..=end_col {
            if let Some(cell_data) = get_cell_internal(&grid, &styles, row, col) {
                cells.push(cell_data);
            }
        }
    }

    cells
}

/// Get a single cell's data.
#[tauri::command]
pub fn get_cell(state: State<AppState>, row: u32, col: u32) -> Option<CellData> {
    let grid = state.grid.lock().unwrap();
    let styles = state.style_registry.lock().unwrap();
    get_cell_internal(&grid, &styles, row, col)
}

/// Internal helper for getting cell data.
fn get_cell_internal(grid: &Grid, styles: &StyleRegistry, row: u32, col: u32) -> Option<CellData> {
    let cell = grid.get_cell(row, col)?;
    let style = styles.get(cell.style_index);
    let display = format_cell_value(&cell.value, style);

    Some(CellData {
        row,
        col,
        display,
        formula: cell.formula.clone(),
        style_index: cell.style_index,
    })
}

/// Update a cell with new content.
/// Returns all cells that were updated (including dependent cells).
#[tauri::command]
pub fn update_cell(
    state: State<AppState>,
    row: u32,
    col: u32,
    value: String,
) -> Result<Vec<CellData>, String> {
    let sheet_names = state.sheet_names.lock().unwrap();
    let mut grid = state.grid.lock().unwrap();
    let mut grids = state.grids.lock().unwrap();
    let active_sheet = *state.active_sheet.lock().unwrap();
    let styles = state.style_registry.lock().unwrap();
    let mut dependents_map = state.dependents.lock().unwrap();
    let mut dependencies_map = state.dependencies.lock().unwrap();
    let mut column_dependents_map = state.column_dependents.lock().unwrap();
    let mut column_dependencies_map = state.column_dependencies.lock().unwrap();
    let mut row_dependents_map = state.row_dependents.lock().unwrap();
    let mut row_dependencies_map = state.row_dependencies.lock().unwrap();
    let mut cross_sheet_dependents_map = state.cross_sheet_dependents.lock().unwrap();
    let mut cross_sheet_dependencies_map = state.cross_sheet_dependencies.lock().unwrap();
    let calc_mode = state.calculation_mode.lock().unwrap();

    let current_sheet_name = sheet_names.get(active_sheet).cloned().unwrap_or_default();

    let mut updated_cells = Vec::new();

    // Handle empty value - clear the cell
    if value.trim().is_empty() {
        grid.clear_cell(row, col);
        // Also update the grids vector
        if active_sheet < grids.len() {
            grids[active_sheet].clear_cell(row, col);
        }
        // Clear cross-sheet dependencies for this cell
        update_cross_sheet_dependencies(
            (active_sheet, row, col),
            HashSet::new(),
            &mut cross_sheet_dependencies_map,
            &mut cross_sheet_dependents_map,
        );
        update_dependencies(
            (row, col),
            HashSet::new(),
            &mut dependencies_map,
            &mut dependents_map,
        );
        update_column_dependencies(
            (row, col),
            HashSet::new(),
            &mut column_dependencies_map,
            &mut column_dependents_map,
        );
        update_row_dependencies(
            (row, col),
            HashSet::new(),
            &mut row_dependencies_map,
            &mut row_dependents_map,
        );
        updated_cells.push(CellData {
            row,
            col,
            display: String::new(),
            formula: None,
            style_index: 0,
        });
        return Ok(updated_cells);
    }

    // Parse the input
    let mut cell = parse_cell_input(&value);

    // Preserve existing style
    if let Some(existing) = grid.get_cell(row, col) {
        cell.style_index = existing.style_index;
    }

    // If it's a formula, evaluate it using multi-sheet context
    if let Some(ref formula) = cell.formula {
        // Extract references for dependency tracking
        if let Ok(parsed) = parser::parse(formula) {
            let refs = extract_all_references(&parsed, &grid);
            update_dependencies((row, col), refs.cells, &mut dependencies_map, &mut dependents_map);
            update_column_dependencies((row, col), refs.columns, &mut column_dependencies_map, &mut column_dependents_map);
            update_row_dependencies((row, col), refs.rows, &mut row_dependencies_map, &mut row_dependents_map);
            
            // Track cross-sheet dependencies
            update_cross_sheet_dependencies(
                (active_sheet, row, col),
                refs.cross_sheet_cells,
                &mut cross_sheet_dependencies_map,
                &mut cross_sheet_dependents_map,
            );
        }

        // Evaluate using multi-sheet context for cross-sheet reference support
        let result = evaluate_formula_multi_sheet(
            &grids,
            &sheet_names,
            active_sheet,
            formula,
        );
        cell.value = result;
    } else {
        // Clear dependencies for non-formula cells
        update_dependencies(
            (row, col),
            HashSet::new(),
            &mut dependencies_map,
            &mut dependents_map,
        );
        // Clear cross-sheet dependencies for non-formula cells
        update_cross_sheet_dependencies(
            (active_sheet, row, col),
            HashSet::new(),
            &mut cross_sheet_dependencies_map,
            &mut cross_sheet_dependents_map,
        );
        update_column_dependencies(
            (row, col),
            HashSet::new(),
            &mut column_dependencies_map,
            &mut column_dependents_map,
        );
        update_row_dependencies(
            (row, col),
            HashSet::new(),
            &mut row_dependencies_map,
            &mut row_dependents_map,
        );
    }

    // Store the cell
    grid.set_cell(row, col, cell.clone());
    // Also update the grids vector to keep them in sync
    if active_sheet < grids.len() {
        grids[active_sheet].set_cell(row, col, cell.clone());
    }

    // Get the display value
    let style = styles.get(cell.style_index);
    let display = format_cell_value(&cell.value, style);

    updated_cells.push(CellData {
        row,
        col,
        display,
        formula: cell.formula.clone(),
        style_index: cell.style_index,
    });

    // Recalculate dependents if automatic mode
    if *calc_mode == "automatic" {
        // Get direct cell dependents
        let mut recalc_order = get_recalculation_order((row, col), &dependents_map);
        
        // Also get column/row dependents (formulas with column or row references)
        let col_row_deps = get_column_row_dependents((row, col), &column_dependents_map, &row_dependents_map);
        for dep in col_row_deps {
            if !recalc_order.contains(&dep) {
                recalc_order.push(dep);
            }
        }

        for (dep_row, dep_col) in recalc_order {
            if let Some(dep_cell) = grid.get_cell(dep_row, dep_col) {
                if let Some(ref formula) = dep_cell.formula {
                    // Evaluate dependent using multi-sheet context
                    let result = evaluate_formula_multi_sheet(
                        &grids,
                        &sheet_names,
                        active_sheet,
                        formula,
                    );

                    let mut updated_dep = dep_cell.clone();
                    updated_dep.value = result;
                    grid.set_cell(dep_row, dep_col, updated_dep.clone());
                    
                    // Also update the grids vector
                    if active_sheet < grids.len() {
                        grids[active_sheet].set_cell(dep_row, dep_col, updated_dep.clone());
                    }

                    let dep_style = styles.get(updated_dep.style_index);
                    let dep_display = format_cell_value(&updated_dep.value, dep_style);

                    updated_cells.push(CellData {
                        row: dep_row,
                        col: dep_col,
                        display: dep_display,
                        formula: updated_dep.formula.clone(),
                        style_index: updated_dep.style_index,
                    });
                }
            }
        }
        
        // Also recalculate cross-sheet dependents (formulas on OTHER sheets that reference this cell)
        let cross_sheet_key = (current_sheet_name.clone(), row, col);
        if let Some(cross_deps) = cross_sheet_dependents_map.get(&cross_sheet_key) {
            for (dep_sheet_idx, dep_row, dep_col) in cross_deps.iter() {
                // Skip if it's on the current sheet (already handled above)
                if *dep_sheet_idx == active_sheet {
                    continue;
                }
                
                // Get the dependent cell from its sheet
                if *dep_sheet_idx < grids.len() {
                    if let Some(dep_cell) = grids[*dep_sheet_idx].get_cell(*dep_row, *dep_col) {
                        if let Some(ref formula) = dep_cell.formula {
                            // Evaluate the formula in context of its own sheet
                            let result = evaluate_formula_multi_sheet(
                                &grids,
                                &sheet_names,
                                *dep_sheet_idx,
                                formula,
                            );

                            let mut updated_dep = dep_cell.clone();
                            updated_dep.value = result;
                            grids[*dep_sheet_idx].set_cell(*dep_row, *dep_col, updated_dep.clone());

                            // Note: We don't add these to updated_cells since they're on different sheets
                            // The frontend will need to refresh when switching sheets
                            // But we log it for debugging
                            let _dep_sheet_name = sheet_names.get(*dep_sheet_idx).unwrap_or(&String::new());
                        }
                    }
                }
            }
        }
    }

    Ok(updated_cells)
}

/// Clear a cell.
#[tauri::command]
pub fn clear_cell(state: State<AppState>, row: u32, col: u32) {
    let mut grid = state.grid.lock().unwrap();
    let mut grids = state.grids.lock().unwrap();
    let active_sheet = *state.active_sheet.lock().unwrap();
    let mut dependents_map = state.dependents.lock().unwrap();
    let mut dependencies_map = state.dependencies.lock().unwrap();
    let mut column_dependents_map = state.column_dependents.lock().unwrap();
    let mut column_dependencies_map = state.column_dependencies.lock().unwrap();
    let mut row_dependents_map = state.row_dependents.lock().unwrap();
    let mut row_dependencies_map = state.row_dependencies.lock().unwrap();
    let mut cross_sheet_dependents_map = state.cross_sheet_dependents.lock().unwrap();
    let mut cross_sheet_dependencies_map = state.cross_sheet_dependencies.lock().unwrap();

    grid.clear_cell(row, col);
    // Also update the grids vector
    if active_sheet < grids.len() {
        grids[active_sheet].clear_cell(row, col);
    }
    
    // Clear cross-sheet dependencies
    update_cross_sheet_dependencies(
        (active_sheet, row, col),
        HashSet::new(),
        &mut cross_sheet_dependencies_map,
        &mut cross_sheet_dependents_map,
    );
    
    update_dependencies(
        (row, col),
        HashSet::new(),
        &mut dependencies_map,
        &mut dependents_map,
    );
    update_column_dependencies(
        (row, col),
        HashSet::new(),
        &mut column_dependencies_map,
        &mut column_dependents_map,
    );
    update_row_dependencies(
        (row, col),
        HashSet::new(),
        &mut row_dependencies_map,
        &mut row_dependents_map,
    );
}

/// Clear a range of cells efficiently.
/// Only clears cells that actually exist within the range.
#[tauri::command]
pub fn clear_range(
    state: State<AppState>,
    start_row: u32,
    start_col: u32,
    end_row: u32,
    end_col: u32,
) -> u32 {
    let mut grid = state.grid.lock().unwrap();
    let mut grids = state.grids.lock().unwrap();
    let active_sheet = *state.active_sheet.lock().unwrap();
    let mut dependents_map = state.dependents.lock().unwrap();
    let mut dependencies_map = state.dependencies.lock().unwrap();
    let mut column_dependents_map = state.column_dependents.lock().unwrap();
    let mut column_dependencies_map = state.column_dependencies.lock().unwrap();
    let mut row_dependents_map = state.row_dependents.lock().unwrap();
    let mut row_dependencies_map = state.row_dependencies.lock().unwrap();
    let mut cross_sheet_dependents_map = state.cross_sheet_dependents.lock().unwrap();
    let mut cross_sheet_dependencies_map = state.cross_sheet_dependencies.lock().unwrap();

    // Clamp to grid bounds to avoid iterating beyond used range
    let effective_end_row = end_row.min(grid.max_row);
    let effective_end_col = end_col.min(grid.max_col);

    // Collect cells to clear (we need to collect first to avoid borrow issues)
    let cells_to_clear: Vec<(u32, u32)> = grid
        .cells
        .keys()
        .filter(|(r, c)| {
            *r >= start_row && *r <= effective_end_row && *c >= start_col && *c <= effective_end_col
        })
        .cloned()
        .collect();

    let count = cells_to_clear.len() as u32;

    // Clear each cell
    for (row, col) in cells_to_clear {
        grid.clear_cell(row, col);
        
        if active_sheet < grids.len() {
            grids[active_sheet].clear_cell(row, col);
        }

        // Clear dependencies
        update_cross_sheet_dependencies(
            (active_sheet, row, col),
            HashSet::new(),
            &mut cross_sheet_dependencies_map,
            &mut cross_sheet_dependents_map,
        );
        update_dependencies(
            (row, col),
            HashSet::new(),
            &mut dependencies_map,
            &mut dependents_map,
        );
        update_column_dependencies(
            (row, col),
            HashSet::new(),
            &mut column_dependencies_map,
            &mut column_dependents_map,
        );
        update_row_dependencies(
            (row, col),
            HashSet::new(),
            &mut row_dependencies_map,
            &mut row_dependents_map,
        );
    }

    count
}

/// Get the grid bounds (max row and col with data).
#[tauri::command]
pub fn get_grid_bounds(state: State<AppState>) -> (u32, u32) {
    let grid = state.grid.lock().unwrap();
    (grid.max_row, grid.max_col)
}

/// Get the total number of non-empty cells.
#[tauri::command]
pub fn get_cell_count(state: State<AppState>) -> usize {
    let grid = state.grid.lock().unwrap();
    grid.cells.len()
}

// ============================================================================
// NAVIGATION COMMANDS
// ============================================================================

/// Find the target cell for Ctrl+Arrow navigation (Excel-like behavior).
/// 
/// Excel's Ctrl+Arrow behavior:
/// - If current cell is empty: jump to the next non-empty cell (or edge if none)
/// - If current cell has content AND next cell is empty: jump to next non-empty (or edge)
/// - If current cell has content AND next cell has content: jump to end of contiguous block
#[tauri::command]
pub fn find_ctrl_arrow_target(
    state: State<AppState>,
    row: u32,
    col: u32,
    direction: String,
    max_row: u32,
    max_col: u32,
) -> (u32, u32) {
    let grid = state.grid.lock().unwrap();
    
    // Determine direction deltas
    let (d_row, d_col): (i32, i32) = match direction.as_str() {
        "up" => (-1, 0),
        "down" => (1, 0),
        "left" => (0, -1),
        "right" => (0, 1),
        _ => return (row, col),
    };
    
    // Helper to check if a cell has content
    let is_non_empty = |r: u32, c: u32| -> bool {
        grid.get_cell(r, c)
            .map(|cell| !matches!(cell.value, CellValue::Empty))
            .unwrap_or(false)
    };
    
    // Helper to check bounds
    let is_in_bounds = |r: i32, c: i32| -> bool {
        r >= 0 && r <= max_row as i32 && c >= 0 && c <= max_col as i32
    };
    
    let current_has_content = is_non_empty(row, col);
    
    // Check the next cell in direction
    let next_r = row as i32 + d_row;
    let next_c = col as i32 + d_col;
    
    // If already at edge, stay in place
    if !is_in_bounds(next_r, next_c) {
        return (row, col);
    }
    
    let next_has_content = is_non_empty(next_r as u32, next_c as u32);
    
    if current_has_content && next_has_content {
        // CASE 1: Both current and next have content
        // Find the end of the contiguous non-empty block
        let mut r = next_r;
        let mut c = next_c;
        
        loop {
            let peek_r = r + d_row;
            let peek_c = c + d_col;
            
            // If peek is out of bounds or empty, current position is the target
            if !is_in_bounds(peek_r, peek_c) || !is_non_empty(peek_r as u32, peek_c as u32) {
                return (r as u32, c as u32);
            }
            
            // Continue to next cell
            r = peek_r;
            c = peek_c;
        }
    } else {
        // CASE 2: Current is empty OR next is empty
        // Find the next non-empty cell (or jump to edge if none found)
        
        // Special case: current is empty but next is non-empty -> return next
        if !current_has_content && next_has_content {
            return (next_r as u32, next_c as u32);
        }
        
        // Search starting from after the next cell
        let mut r = next_r;
        let mut c = next_c;
        
        loop {
            r += d_row;
            c += d_col;
            
            // Hit the edge without finding a non-empty cell
            if !is_in_bounds(r, c) {
                // Return the edge position
                let edge_r = if d_row < 0 { 0 } else if d_row > 0 { max_row as i32 } else { row as i32 };
                let edge_c = if d_col < 0 { 0 } else if d_col > 0 { max_col as i32 } else { col as i32 };
                return (edge_r as u32, edge_c as u32);
            }
            
            // Found a non-empty cell
            if is_non_empty(r as u32, c as u32) {
                return (r as u32, c as u32);
            }
        }
    }
}

// ============================================================================
// DIMENSION COMMANDS
// ============================================================================

/// Set a column width.
#[tauri::command]
pub fn set_column_width(state: State<AppState>, col: u32, width: f64) {
    let mut widths = state.column_widths.lock().unwrap();
    if width > 0.0 {
        widths.insert(col, width);
    } else {
        widths.remove(&col);
    }
}

/// Get a column width.
#[tauri::command]
pub fn get_column_width(state: State<AppState>, col: u32) -> Option<f64> {
    let widths = state.column_widths.lock().unwrap();
    widths.get(&col).copied()
}

/// Get all column widths.
#[tauri::command]
pub fn get_all_column_widths(state: State<AppState>) -> Vec<DimensionData> {
    let widths = state.column_widths.lock().unwrap();
    widths
        .iter()
        .map(|(&index, &size)| DimensionData { index, size })
        .collect()
}

/// Set a row height.
#[tauri::command]
pub fn set_row_height(state: State<AppState>, row: u32, height: f64) {
    let mut heights = state.row_heights.lock().unwrap();
    if height > 0.0 {
        heights.insert(row, height);
    } else {
        heights.remove(&row);
    }
}

/// Get a row height.
#[tauri::command]
pub fn get_row_height(state: State<AppState>, row: u32) -> Option<f64> {
    let heights = state.row_heights.lock().unwrap();
    heights.get(&row).copied()
}

/// Get all row heights.
#[tauri::command]
pub fn get_all_row_heights(state: State<AppState>) -> Vec<DimensionData> {
    let heights = state.row_heights.lock().unwrap();
    heights
        .iter()
        .map(|(&index, &size)| DimensionData { index, size })
        .collect()
}

// ============================================================================
// STYLE COMMANDS
// ============================================================================

/// Get a style by index.
#[tauri::command]
pub fn get_style(state: State<AppState>, index: usize) -> StyleData {
    let styles = state.style_registry.lock().unwrap();
    StyleData::from(styles.get(index))
}

/// Get all styles.
#[tauri::command]
pub fn get_all_styles(state: State<AppState>) -> Vec<StyleData> {
    let styles = state.style_registry.lock().unwrap();
    styles.all_styles().iter().map(StyleData::from).collect()
}

/// Set a cell's style index.
#[tauri::command]
pub fn set_cell_style(
    state: State<AppState>,
    row: u32,
    col: u32,
    style_index: usize,
) -> Option<CellData> {
    let mut grid = state.grid.lock().unwrap();
    let mut grids = state.grids.lock().unwrap();
    let active_sheet = *state.active_sheet.lock().unwrap();
    let styles = state.style_registry.lock().unwrap();

    if let Some(cell) = grid.get_cell(row, col) {
        let mut updated_cell = cell.clone();
        updated_cell.style_index = style_index;
        grid.set_cell(row, col, updated_cell.clone());
        
        if active_sheet < grids.len() {
            grids[active_sheet].set_cell(row, col, updated_cell.clone());
        }

        let style = styles.get(style_index);
        let display = format_cell_value(&updated_cell.value, style);

        Some(CellData {
            row,
            col,
            display,
            formula: updated_cell.formula,
            style_index,
        })
    } else {
        // Create a new empty cell with the style
        let cell = Cell {
            value: CellValue::Empty,
            formula: None,
            style_index,
        };
        grid.set_cell(row, col, cell.clone());
        
        if active_sheet < grids.len() {
            grids[active_sheet].set_cell(row, col, cell);
        }

        Some(CellData {
            row,
            col,
            display: String::new(),
            formula: None,
            style_index,
        })
    }
}

/// Apply formatting to a range of cells.
#[tauri::command]
pub fn apply_formatting(
    state: State<AppState>,
    params: FormattingParams,
) -> Result<FormattingResult, String> {
    let mut grid = state.grid.lock().unwrap();
    let mut grids = state.grids.lock().unwrap();
    let active_sheet = *state.active_sheet.lock().unwrap();
    let mut styles = state.style_registry.lock().unwrap();

    let mut updated_cells = Vec::new();
    let mut updated_styles = Vec::new();

    // Iterate over all row/col combinations from the params
    for row in &params.rows {
        for col in &params.cols {
            let row = *row;
            let col = *col;
            
            // Get or create cell
            let (cell, old_style_index) = if let Some(existing) = grid.get_cell(row, col) {
                (existing.clone(), existing.style_index)
            } else {
                (
                    Cell {
                        value: CellValue::Empty,
                        formula: None,
                        style_index: 0,
                    },
                    0,
                )
            };

            // Get base style
            let mut new_style = styles.get(old_style_index).clone();

            // Apply formatting changes
            if let Some(bold) = params.bold {
                new_style.font.bold = bold;
            }
            if let Some(italic) = params.italic {
                new_style.font.italic = italic;
            }
            if let Some(underline) = params.underline {
                new_style.font.underline = underline;
            }
            if let Some(font_size) = params.font_size {
                new_style.font.size = font_size;
            }
            if let Some(ref font_family) = params.font_family {
                new_style.font.family = font_family.clone();
            }
            if let Some(ref text_color) = params.text_color {
                if let Some(color) = Color::from_hex(text_color) {
                    new_style.font.color = color;
                }
            }
            if let Some(ref bg_color) = params.background_color {
                if let Some(color) = Color::from_hex(bg_color) {
                    new_style.background = color;
                }
            }
            if let Some(ref align) = params.text_align {
                new_style.text_align = match align.as_str() {
                    "left" => TextAlign::Left,
                    "center" => TextAlign::Center,
                    "right" => TextAlign::Right,
                    _ => TextAlign::General,
                };
            }
            if let Some(ref valign) = params.vertical_align {
                new_style.vertical_align = match valign.as_str() {
                    "top" => VerticalAlign::Top,
                    "middle" => VerticalAlign::Middle,
                    "bottom" => VerticalAlign::Bottom,
                    _ => VerticalAlign::Middle,
                };
            }
            if let Some(wrap) = params.wrap_text {
                new_style.wrap_text = wrap;
            }
            if let Some(ref rotation) = params.text_rotation {
                new_style.text_rotation = parse_text_rotation(rotation);
            }
            if let Some(ref format) = params.number_format {
                new_style.number_format = parse_number_format(format);
            }

            // Get or create style index
            let new_style_index = styles.get_or_create(new_style.clone());

            // Update cell
            let mut updated_cell = cell;
            updated_cell.style_index = new_style_index;
            grid.set_cell(row, col, updated_cell.clone());
            
            if active_sheet < grids.len() {
                grids[active_sheet].set_cell(row, col, updated_cell.clone());
            }

            let display = format_cell_value(&updated_cell.value, &new_style);

            updated_cells.push(CellData {
                row,
                col,
                display,
                formula: updated_cell.formula,
                style_index: new_style_index,
            });
        }
    }

    // Collect all styles
    for (index, style) in styles.all_styles().iter().enumerate() {
        updated_styles.push(StyleEntry {
            index,
            style: StyleData::from(style),
        });
    }

    Ok(FormattingResult {
        cells: updated_cells,
        styles: updated_styles,
    })
}

/// Parse a number format string.
fn parse_number_format(format: &str) -> NumberFormat {
    match format.to_lowercase().as_str() {
        "general" => NumberFormat::General,
        "number" => NumberFormat::Number {
            decimal_places: 2,
            use_thousands_separator: false,
        },
        "number_sep" => NumberFormat::Number {
            decimal_places: 2,
            use_thousands_separator: true,
        },
        "currency_usd" => NumberFormat::Currency {
            decimal_places: 2,
            symbol: "$".to_string(),
            symbol_position: CurrencyPosition::Before,
        },
        "currency_eur" => NumberFormat::Currency {
            decimal_places: 2,
            symbol: "EUR".to_string(),
            symbol_position: CurrencyPosition::Before,
        },
        "currency_sek" => NumberFormat::Currency {
            decimal_places: 2,
            symbol: "kr".to_string(),
            symbol_position: CurrencyPosition::After,
        },
        "percentage" => NumberFormat::Percentage { decimal_places: 2 },
        "scientific" => NumberFormat::Scientific { decimal_places: 2 },
        "date_iso" => NumberFormat::Date {
            format: "yyyy-mm-dd".to_string(),
        },
        "date_us" => NumberFormat::Date {
            format: "mm/dd/yyyy".to_string(),
        },
        "date_eu" => NumberFormat::Date {
            format: "dd/mm/yyyy".to_string(),
        },
        "time_24h" => NumberFormat::Time {
            format: "hh:mm:ss".to_string(),
        },
        "time_12h" => NumberFormat::Time {
            format: "hh:mm:ss AM/PM".to_string(),
        },
        _ => NumberFormat::General,
    }
}

/// Parse a text rotation string.
fn parse_text_rotation(rotation: &str) -> TextRotation {
    match rotation.to_lowercase().as_str() {
        "none" | "0" => TextRotation::None,
        "90" | "up" => TextRotation::Rotate90,
        "270" | "-90" | "down" => TextRotation::Rotate270,
        _ => {
            // Try to parse as a number
            if let Ok(angle) = rotation.parse::<i16>() {
                let clamped = angle.clamp(-90, 90);
                if clamped == 0 {
                    TextRotation::None
                } else if clamped == 90 {
                    TextRotation::Rotate90
                } else if clamped == -90 {
                    TextRotation::Rotate270
                } else {
                    TextRotation::Custom(clamped)
                }
            } else {
                TextRotation::None
            }
        }
    }
}

/// Get the total number of styles.
#[tauri::command]
pub fn get_style_count(state: State<AppState>) -> usize {
    let styles = state.style_registry.lock().unwrap();
    styles.len()
}

// ============================================================================
// ROW/COLUMN INSERTION WITH DEPENDENCY MAP UPDATES
// ============================================================================

/// Shift all cell positions in a HashMap where the key is (row, col)
fn shift_cell_positions_for_row_insert<V: Clone>(
    map: &mut HashMap<(u32, u32), V>,
    from_row: u32,
    count: u32,
) {
    let entries: Vec<_> = map.drain().collect();
    for ((r, c), v) in entries {
        let new_r = if r >= from_row { r + count } else { r };
        map.insert((new_r, c), v);
    }
}

/// Shift all cell positions in a HashMap where the key is (row, col)
fn shift_cell_positions_for_col_insert<V: Clone>(
    map: &mut HashMap<(u32, u32), V>,
    from_col: u32,
    count: u32,
) {
    let entries: Vec<_> = map.drain().collect();
    for ((r, c), v) in entries {
        let new_c = if c >= from_col { c + count } else { c };
        map.insert((r, new_c), v);
    }
}

/// Shift cell references inside a HashSet<(u32, u32)>
fn shift_cell_set_for_row_insert(set: &HashSet<(u32, u32)>, from_row: u32, count: u32) -> HashSet<(u32, u32)> {
    set.iter()
        .map(|(r, c)| {
            let new_r = if *r >= from_row { *r + count } else { *r };
            (new_r, *c)
        })
        .collect()
}

fn shift_cell_set_for_col_insert(set: &HashSet<(u32, u32)>, from_col: u32, count: u32) -> HashSet<(u32, u32)> {
    set.iter()
        .map(|(r, c)| {
            let new_c = if *c >= from_col { *c + count } else { *c };
            (*r, new_c)
        })
        .collect()
}

/// Shift row indices in row_dependents map
fn shift_row_indices(map: &mut HashMap<u32, HashSet<(u32, u32)>>, from_row: u32, count: u32) {
    let entries: Vec<_> = map.drain().collect();
    for (row_idx, cell_set) in entries {
        let new_row_idx = if row_idx >= from_row { row_idx + count } else { row_idx };
        // Also shift the cell positions in the set
        let new_set = shift_cell_set_for_row_insert(&cell_set, from_row, count);
        map.insert(new_row_idx, new_set);
    }
}

/// Shift column indices in column_dependents map
fn shift_col_indices(map: &mut HashMap<u32, HashSet<(u32, u32)>>, from_col: u32, count: u32) {
    let entries: Vec<_> = map.drain().collect();
    for (col_idx, cell_set) in entries {
        let new_col_idx = if col_idx >= from_col { col_idx + count } else { col_idx };
        // Also shift the cell positions in the set
        let new_set = shift_cell_set_for_col_insert(&cell_set, from_col, count);
        map.insert(new_col_idx, new_set);
    }
}

/// Shift row dependencies (cell -> set of row indices)
fn shift_row_dependencies_map(map: &mut HashMap<(u32, u32), HashSet<u32>>, from_row: u32, count: u32) {
    let entries: Vec<_> = map.drain().collect();
    for ((r, c), row_set) in entries {
        let new_r = if r >= from_row { r + count } else { r };
        let new_row_set: HashSet<u32> = row_set
            .iter()
            .map(|row_idx| if *row_idx >= from_row { *row_idx + count } else { *row_idx })
            .collect();
        map.insert((new_r, c), new_row_set);
    }
}

/// Shift column dependencies (cell -> set of col indices)
fn shift_col_dependencies_map(map: &mut HashMap<(u32, u32), HashSet<u32>>, from_col: u32, count: u32) {
    let entries: Vec<_> = map.drain().collect();
    for ((r, c), col_set) in entries {
        let new_c = if c >= from_col { c + count } else { c };
        let new_col_set: HashSet<u32> = col_set
            .iter()
            .map(|col_idx| if *col_idx >= from_col { *col_idx + count } else { *col_idx })
            .collect();
        map.insert((r, new_c), new_col_set);
    }
}

/// Insert rows at the specified position, shifting existing rows down.
#[tauri::command]
pub fn insert_rows(
    state: State<AppState>,
    row: u32,
    count: u32,
) -> Result<Vec<CellData>, String> {
    let mut grid = state.grid.lock().map_err(|e| e.to_string())?;
    let mut grids = state.grids.lock().map_err(|e| e.to_string())?;
    let styles = state.style_registry.lock().map_err(|e| e.to_string())?;
    let mut row_heights = state.row_heights.lock().map_err(|e| e.to_string())?;
    let active_sheet = *state.active_sheet.lock().map_err(|e| e.to_string())?;
    
    // Lock all dependency maps
    let mut dependents_map = state.dependents.lock().map_err(|e| e.to_string())?;
    let mut dependencies_map = state.dependencies.lock().map_err(|e| e.to_string())?;
    let mut column_dependents_map = state.column_dependents.lock().map_err(|e| e.to_string())?;
    let mut column_dependencies_map = state.column_dependencies.lock().map_err(|e| e.to_string())?;
    let mut row_dependents_map = state.row_dependents.lock().map_err(|e| e.to_string())?;
    let mut row_dependencies_map = state.row_dependencies.lock().map_err(|e| e.to_string())?;
    
    // First, update formula references in ALL cells that reference rows at or after the insertion point
    let all_cells: Vec<((u32, u32), Cell)> = grid.cells.iter()
        .map(|(&pos, cell)| (pos, cell.clone()))
        .collect();
    
    for ((r, c), cell) in &all_cells {
        if let Some(formula) = &cell.formula {
            let updated_formula = shift_formula_row_references(formula, row, count as i32);
            if updated_formula != *formula {
                let mut updated_cell = cell.clone();
                updated_cell.formula = Some(updated_formula);
                grid.cells.insert((*r, *c), updated_cell);
            }
        }
    }
    
    // Collect all cells that need to be moved (from row onwards)
    let mut cells_to_move: Vec<((u32, u32), Cell)> = Vec::new();
    for (&(r, c), cell) in grid.cells.iter() {
        if r >= row {
            cells_to_move.push(((r, c), cell.clone()));
        }
    }
    
    // Sort by row descending so we move from bottom to top
    cells_to_move.sort_by(|a, b| b.0 .0.cmp(&a.0 .0));
    
    // Remove old cells and insert at new positions
    for ((r, c), cell) in cells_to_move {
        grid.cells.remove(&(r, c));
        grid.cells.insert((r + count, c), cell);
    }
    
    // Update row heights
    let old_heights: Vec<(u32, f64)> = row_heights.iter().map(|(&r, &h)| (r, h)).collect();
    row_heights.clear();
    for (r, height) in old_heights {
        if r >= row {
            row_heights.insert(r + count, height);
        } else {
            row_heights.insert(r, height);
        }
    }
    
    // === UPDATE DEPENDENCY MAPS ===
    
    // Update dependents map: shift keys and values
    let deps_entries: Vec<_> = dependents_map.drain().collect();
    for ((r, c), dep_set) in deps_entries {
        let new_r = if r >= row { r + count } else { r };
        let new_set = shift_cell_set_for_row_insert(&dep_set, row, count);
        dependents_map.insert((new_r, c), new_set);
    }
    
    // Update dependencies map: shift keys and values
    let deps_entries: Vec<_> = dependencies_map.drain().collect();
    for ((r, c), ref_set) in deps_entries {
        let new_r = if r >= row { r + count } else { r };
        let new_set = shift_cell_set_for_row_insert(&ref_set, row, count);
        dependencies_map.insert((new_r, c), new_set);
    }
    
    // Update column_dependents: shift cell positions in values
    for (_col, cell_set) in column_dependents_map.iter_mut() {
        *cell_set = shift_cell_set_for_row_insert(cell_set, row, count);
    }
    
    // Update column_dependencies: shift keys only (cell positions)
    shift_cell_positions_for_row_insert(&mut column_dependencies_map, row, count);
    
    // Update row_dependents: shift both keys (row indices) and values (cell positions)
    shift_row_indices(&mut row_dependents_map, row, count);
    
    // Update row_dependencies: shift keys (cell positions) and values (row indices)
    shift_row_dependencies_map(&mut row_dependencies_map, row, count);
    
    // Recalculate grid bounds
    grid.recalculate_bounds();
    
    // Sync grids vector
    if active_sheet < grids.len() {
        grids[active_sheet].cells = grid.cells.clone();
        grids[active_sheet].max_row = grid.max_row;
        grids[active_sheet].max_col = grid.max_col;
    }
    
    // Return updated cells
    let mut result: Vec<CellData> = Vec::new();
    for r in 0..=grid.max_row {
        for c in 0..=grid.max_col {
            if let Some(cell_data) = get_cell_internal(&grid, &styles, r, c) {
                result.push(cell_data);
            }
        }
    }
    
    Ok(result)
}

/// Insert columns at the specified position, shifting existing columns right.
#[tauri::command]
pub fn insert_columns(
    state: State<AppState>,
    col: u32,
    count: u32,
) -> Result<Vec<CellData>, String> {
    let mut grid = state.grid.lock().map_err(|e| e.to_string())?;
    let mut grids = state.grids.lock().map_err(|e| e.to_string())?;
    let styles = state.style_registry.lock().map_err(|e| e.to_string())?;
    let mut column_widths = state.column_widths.lock().map_err(|e| e.to_string())?;
    let active_sheet = *state.active_sheet.lock().map_err(|e| e.to_string())?;
    
    // Lock all dependency maps
    let mut dependents_map = state.dependents.lock().map_err(|e| e.to_string())?;
    let mut dependencies_map = state.dependencies.lock().map_err(|e| e.to_string())?;
    let mut column_dependents_map = state.column_dependents.lock().map_err(|e| e.to_string())?;
    let mut column_dependencies_map = state.column_dependencies.lock().map_err(|e| e.to_string())?;
    let mut row_dependents_map = state.row_dependents.lock().map_err(|e| e.to_string())?;
    let mut row_dependencies_map = state.row_dependencies.lock().map_err(|e| e.to_string())?;
    
    // First, update formula references in ALL cells
    let all_cells: Vec<((u32, u32), Cell)> = grid.cells.iter()
        .map(|(&pos, cell)| (pos, cell.clone()))
        .collect();
    
    for ((r, c), cell) in &all_cells {
        if let Some(formula) = &cell.formula {
            let updated_formula = shift_formula_col_references(formula, col, count as i32);
            if updated_formula != *formula {
                let mut updated_cell = cell.clone();
                updated_cell.formula = Some(updated_formula);
                grid.cells.insert((*r, *c), updated_cell);
            }
        }
    }
    
    // Collect all cells that need to be moved (from col onwards)
    let mut cells_to_move: Vec<((u32, u32), Cell)> = Vec::new();
    for (&(r, c), cell) in grid.cells.iter() {
        if c >= col {
            cells_to_move.push(((r, c), cell.clone()));
        }
    }
    
    // Sort by column descending so we move from right to left
    cells_to_move.sort_by(|a, b| b.0 .1.cmp(&a.0 .1));
    
    // Remove old cells and insert at new positions
    for ((r, c), cell) in cells_to_move {
        grid.cells.remove(&(r, c));
        grid.cells.insert((r, c + count), cell);
    }
    
    // Update column widths
    let old_widths: Vec<(u32, f64)> = column_widths.iter().map(|(&c, &w)| (c, w)).collect();
    column_widths.clear();
    for (c, width) in old_widths {
        if c >= col {
            column_widths.insert(c + count, width);
        } else {
            column_widths.insert(c, width);
        }
    }
    
    // === UPDATE DEPENDENCY MAPS ===
    
    // Update dependents map: shift keys and values
    let deps_entries: Vec<_> = dependents_map.drain().collect();
    for ((r, c), dep_set) in deps_entries {
        let new_c = if c >= col { c + count } else { c };
        let new_set = shift_cell_set_for_col_insert(&dep_set, col, count);
        dependents_map.insert((r, new_c), new_set);
    }
    
    // Update dependencies map: shift keys and values
    let deps_entries: Vec<_> = dependencies_map.drain().collect();
    for ((r, c), ref_set) in deps_entries {
        let new_c = if c >= col { c + count } else { c };
        let new_set = shift_cell_set_for_col_insert(&ref_set, col, count);
        dependencies_map.insert((r, new_c), new_set);
    }
    
    // Update column_dependents: shift both keys (col indices) and values (cell positions)
    shift_col_indices(&mut column_dependents_map, col, count);
    
    // Update column_dependencies: shift keys (cell positions) and values (col indices)
    shift_col_dependencies_map(&mut column_dependencies_map, col, count);
    
    // Update row_dependents: shift cell positions in values only
    for (_row, cell_set) in row_dependents_map.iter_mut() {
        *cell_set = shift_cell_set_for_col_insert(cell_set, col, count);
    }
    
    // Update row_dependencies: shift keys only (cell positions)
    shift_cell_positions_for_col_insert(&mut row_dependencies_map, col, count);
    
    // Recalculate grid bounds
    grid.recalculate_bounds();
    
    // Sync grids vector
    if active_sheet < grids.len() {
        grids[active_sheet].cells = grid.cells.clone();
        grids[active_sheet].max_row = grid.max_row;
        grids[active_sheet].max_col = grid.max_col;
    }
    
    // Return updated cells
    let mut result: Vec<CellData> = Vec::new();
    for r in 0..=grid.max_row {
        for c in 0..=grid.max_col {
            if let Some(cell_data) = get_cell_internal(&grid, &styles, r, c) {
                result.push(cell_data);
            }
        }
    }
    
    Ok(result)
}

/// Shift row references in a formula by a given amount.
fn shift_formula_row_references(formula: &str, from_row: u32, delta: i32) -> String {
    use regex::Regex;
    
    // Handle cell references (e.g., A5, $A$5)
    let cell_re = Regex::new(r"(\$?)([A-Z]+)(\$?)(\d+)").unwrap();
    
    let result = cell_re.replace_all(formula, |caps: &regex::Captures| {
        let col_abs = &caps[1];
        let col_letters = &caps[2];
        let row_abs = &caps[3];
        let row_num: u32 = caps[4].parse().unwrap_or(0);
        
        // Only shift if row is at or after from_row and not absolute
        // from_row is 0-indexed, row_num is 1-indexed
        let new_row = if row_abs.is_empty() && row_num > from_row {
            ((row_num as i32) + delta).max(1) as u32
        } else {
            row_num
        };
        
        format!("{}{}{}{}", col_abs, col_letters, row_abs, new_row)
    }).to_string();
    
    // Handle row-only references (e.g., 5:5, $2:$10)
    let row_re = Regex::new(r"(\$?)(\d+):(\$?)(\d+)").unwrap();
    
    row_re.replace_all(&result, |caps: &regex::Captures| {
        let start_abs = &caps[1];
        let start_row: u32 = caps[2].parse().unwrap_or(0);
        let end_abs = &caps[3];
        let end_row: u32 = caps[4].parse().unwrap_or(0);
        
        let new_start = if start_abs.is_empty() && start_row > from_row {
            ((start_row as i32) + delta).max(1) as u32
        } else {
            start_row
        };
        
        let new_end = if end_abs.is_empty() && end_row > from_row {
            ((end_row as i32) + delta).max(1) as u32
        } else {
            end_row
        };
        
        format!("{}{}:{}{}", start_abs, new_start, end_abs, new_end)
    }).to_string()
}

/// Shift column references in a formula by a given amount.
fn shift_formula_col_references(formula: &str, from_col: u32, delta: i32) -> String {
    use regex::Regex;
    
    fn col_to_index(col: &str) -> u32 {
        let mut index: u32 = 0;
        for ch in col.chars() {
            index = index * 26 + (ch as u32 - 'A' as u32 + 1);
        }
        index - 1
    }
    
    fn index_to_col(mut idx: u32) -> String {
        let mut result = String::new();
        loop {
            result.insert(0, (b'A' + (idx % 26) as u8) as char);
            if idx < 26 {
                break;
            }
            idx = idx / 26 - 1;
        }
        result
    }
    
    // Handle cell references (e.g., C5, $C$5)
    let cell_re = Regex::new(r"(\$?)([A-Z]+)(\$?)(\d+)").unwrap();
    
    let result = cell_re.replace_all(formula, |caps: &regex::Captures| {
        let col_abs = &caps[1];
        let col_letters = &caps[2];
        let row_abs = &caps[3];
        let row_num = &caps[4];
        
        let col_index = col_to_index(col_letters);
        
        let new_col_index = if col_abs.is_empty() && col_index >= from_col {
            ((col_index as i32) + delta).max(0) as u32
        } else {
            col_index
        };
        
        let new_col_letters = index_to_col(new_col_index);
        
        format!("{}{}{}{}", col_abs, new_col_letters, row_abs, row_num)
    }).to_string();
    
    // Handle column-only references (e.g., B:B, $A:$C)
    let col_re = Regex::new(r"(\$?)([A-Z]+):(\$?)([A-Z]+)").unwrap();
    
    col_re.replace_all(&result, |caps: &regex::Captures| {
        let start_abs = &caps[1];
        let start_col = &caps[2];
        let end_abs = &caps[3];
        let end_col = &caps[4];
        
        let start_index = col_to_index(start_col);
        let end_index = col_to_index(end_col);
        
        let new_start_index = if start_abs.is_empty() && start_index >= from_col {
            ((start_index as i32) + delta).max(0) as u32
        } else {
            start_index
        };
        
        let new_end_index = if end_abs.is_empty() && end_index >= from_col {
            ((end_index as i32) + delta).max(0) as u32
        } else {
            end_index
        };
        
        let new_start_col = index_to_col(new_start_index);
        let new_end_col = index_to_col(new_end_index);
        
        format!("{}{}:{}{}", start_abs, new_start_col, end_abs, new_end_col)
    }).to_string()
}

// ============================================================================
// ROW/COLUMN DELETION WITH DEPENDENCY MAP UPDATES
// ============================================================================

/// Shift cell positions for row deletion (move cells up)
fn shift_cell_positions_for_row_delete<V: Clone>(
    map: &mut HashMap<(u32, u32), V>,
    from_row: u32,
    count: u32,
) {
    let entries: Vec<_> = map.drain().collect();
    for ((r, c), v) in entries {
        // Skip cells in the deleted range
        if r >= from_row && r < from_row + count {
            continue;
        }
        let new_r = if r >= from_row + count { r - count } else { r };
        map.insert((new_r, c), v);
    }
}

/// Shift cell positions for column deletion (move cells left)
fn shift_cell_positions_for_col_delete<V: Clone>(
    map: &mut HashMap<(u32, u32), V>,
    from_col: u32,
    count: u32,
) {
    let entries: Vec<_> = map.drain().collect();
    for ((r, c), v) in entries {
        // Skip cells in the deleted range
        if c >= from_col && c < from_col + count {
            continue;
        }
        let new_c = if c >= from_col + count { c - count } else { c };
        map.insert((r, new_c), v);
    }
}

/// Shift cell references inside a HashSet for row deletion
fn shift_cell_set_for_row_delete(set: &HashSet<(u32, u32)>, from_row: u32, count: u32) -> HashSet<(u32, u32)> {
    set.iter()
        .filter(|(r, _)| *r < from_row || *r >= from_row + count)
        .map(|(r, c)| {
            let new_r = if *r >= from_row + count { *r - count } else { *r };
            (new_r, *c)
        })
        .collect()
}

/// Shift cell references inside a HashSet for column deletion
fn shift_cell_set_for_col_delete(set: &HashSet<(u32, u32)>, from_col: u32, count: u32) -> HashSet<(u32, u32)> {
    set.iter()
        .filter(|(_, c)| *c < from_col || *c >= from_col + count)
        .map(|(r, c)| {
            let new_c = if *c >= from_col + count { *c - count } else { *c };
            (*r, new_c)
        })
        .collect()
}

/// Shift row indices in row_dependents map for deletion
fn shift_row_indices_for_delete(map: &mut HashMap<u32, HashSet<(u32, u32)>>, from_row: u32, count: u32) {
    let entries: Vec<_> = map.drain().collect();
    for (row_idx, cell_set) in entries {
        // Skip rows in the deleted range
        if row_idx >= from_row && row_idx < from_row + count {
            continue;
        }
        let new_row_idx = if row_idx >= from_row + count { row_idx - count } else { row_idx };
        let new_set = shift_cell_set_for_row_delete(&cell_set, from_row, count);
        if !new_set.is_empty() {
            map.insert(new_row_idx, new_set);
        }
    }
}

/// Shift column indices in column_dependents map for deletion
fn shift_col_indices_for_delete(map: &mut HashMap<u32, HashSet<(u32, u32)>>, from_col: u32, count: u32) {
    let entries: Vec<_> = map.drain().collect();
    for (col_idx, cell_set) in entries {
        // Skip columns in the deleted range
        if col_idx >= from_col && col_idx < from_col + count {
            continue;
        }
        let new_col_idx = if col_idx >= from_col + count { col_idx - count } else { col_idx };
        let new_set = shift_cell_set_for_col_delete(&cell_set, from_col, count);
        if !new_set.is_empty() {
            map.insert(new_col_idx, new_set);
        }
    }
}

/// Shift row dependencies for deletion
fn shift_row_dependencies_map_for_delete(map: &mut HashMap<(u32, u32), HashSet<u32>>, from_row: u32, count: u32) {
    let entries: Vec<_> = map.drain().collect();
    for ((r, c), row_set) in entries {
        // Skip cells in the deleted range
        if r >= from_row && r < from_row + count {
            continue;
        }
        let new_r = if r >= from_row + count { r - count } else { r };
        let new_row_set: HashSet<u32> = row_set
            .iter()
            .filter(|row_idx| **row_idx < from_row || **row_idx >= from_row + count)
            .map(|row_idx| if *row_idx >= from_row + count { *row_idx - count } else { *row_idx })
            .collect();
        if !new_row_set.is_empty() {
            map.insert((new_r, c), new_row_set);
        }
    }
}

/// Shift column dependencies for deletion
fn shift_col_dependencies_map_for_delete(map: &mut HashMap<(u32, u32), HashSet<u32>>, from_col: u32, count: u32) {
    let entries: Vec<_> = map.drain().collect();
    for ((r, c), col_set) in entries {
        // Skip cells in the deleted range
        if c >= from_col && c < from_col + count {
            continue;
        }
        let new_c = if c >= from_col + count { c - count } else { c };
        let new_col_set: HashSet<u32> = col_set
            .iter()
            .filter(|col_idx| **col_idx < from_col || **col_idx >= from_col + count)
            .map(|col_idx| if *col_idx >= from_col + count { *col_idx - count } else { *col_idx })
            .collect();
        if !new_col_set.is_empty() {
            map.insert((r, new_c), new_col_set);
        }
    }
}

/// Delete rows at the specified position, shifting remaining rows up.
#[tauri::command]
pub fn delete_rows(
    state: State<AppState>,
    row: u32,
    count: u32,
) -> Result<Vec<CellData>, String> {
    let mut grid = state.grid.lock().map_err(|e| e.to_string())?;
    let mut grids = state.grids.lock().map_err(|e| e.to_string())?;
    let styles = state.style_registry.lock().map_err(|e| e.to_string())?;
    let mut row_heights = state.row_heights.lock().map_err(|e| e.to_string())?;
    let active_sheet = *state.active_sheet.lock().map_err(|e| e.to_string())?;
    
    // Lock all dependency maps
    let mut dependents_map = state.dependents.lock().map_err(|e| e.to_string())?;
    let mut dependencies_map = state.dependencies.lock().map_err(|e| e.to_string())?;
    let mut column_dependents_map = state.column_dependents.lock().map_err(|e| e.to_string())?;
    let mut column_dependencies_map = state.column_dependencies.lock().map_err(|e| e.to_string())?;
    let mut row_dependents_map = state.row_dependents.lock().map_err(|e| e.to_string())?;
    let mut row_dependencies_map = state.row_dependencies.lock().map_err(|e| e.to_string())?;
    
    // First, remove cells in the deleted rows
    let cells_to_delete: Vec<(u32, u32)> = grid.cells.keys()
        .filter(|(r, _)| *r >= row && *r < row + count)
        .cloned()
        .collect();
    
    for pos in cells_to_delete {
        grid.cells.remove(&pos);
    }
    
    // Update formula references in remaining cells (shift up = negative delta)
    let all_cells: Vec<((u32, u32), Cell)> = grid.cells.iter()
        .map(|(&pos, cell)| (pos, cell.clone()))
        .collect();
    
    for ((r, c), cell) in &all_cells {
        if let Some(formula) = &cell.formula {
            let updated_formula = shift_formula_row_references(formula, row, -(count as i32));
            if updated_formula != *formula {
                let mut updated_cell = cell.clone();
                updated_cell.formula = Some(updated_formula);
                grid.cells.insert((*r, *c), updated_cell);
            }
        }
    }
    
    // Move remaining cells up
    let mut cells_to_move: Vec<((u32, u32), Cell)> = Vec::new();
    for (&(r, c), cell) in grid.cells.iter() {
        if r >= row + count {
            cells_to_move.push(((r, c), cell.clone()));
        }
    }
    
    // Sort by row ascending so we move from top to bottom
    cells_to_move.sort_by(|a, b| a.0 .0.cmp(&b.0 .0));
    
    // Remove old cells and insert at new positions
    for ((r, c), cell) in cells_to_move {
        grid.cells.remove(&(r, c));
        grid.cells.insert((r - count, c), cell);
    }
    
    // Update row heights
    let old_heights: Vec<(u32, f64)> = row_heights.iter().map(|(&r, &h)| (r, h)).collect();
    row_heights.clear();
    for (r, height) in old_heights {
        if r >= row && r < row + count {
            // Skip deleted rows
            continue;
        }
        if r >= row + count {
            row_heights.insert(r - count, height);
        } else {
            row_heights.insert(r, height);
        }
    }
    
    // === UPDATE DEPENDENCY MAPS ===
    
    // Update dependents map
    let deps_entries: Vec<_> = dependents_map.drain().collect();
    for ((r, c), dep_set) in deps_entries {
        if r >= row && r < row + count {
            continue; // Skip deleted rows
        }
        let new_r = if r >= row + count { r - count } else { r };
        let new_set = shift_cell_set_for_row_delete(&dep_set, row, count);
        if !new_set.is_empty() {
            dependents_map.insert((new_r, c), new_set);
        }
    }
    
    // Update dependencies map
    let deps_entries: Vec<_> = dependencies_map.drain().collect();
    for ((r, c), ref_set) in deps_entries {
        if r >= row && r < row + count {
            continue; // Skip deleted rows
        }
        let new_r = if r >= row + count { r - count } else { r };
        let new_set = shift_cell_set_for_row_delete(&ref_set, row, count);
        if !new_set.is_empty() {
            dependencies_map.insert((new_r, c), new_set);
        }
    }
    
    // Update column_dependents: shift cell positions in values
    for (_col, cell_set) in column_dependents_map.iter_mut() {
        *cell_set = shift_cell_set_for_row_delete(cell_set, row, count);
    }
    
    // Update column_dependencies: shift keys (cell positions)
    shift_cell_positions_for_row_delete(&mut column_dependencies_map, row, count);
    
    // Update row_dependents: shift both keys (row indices) and values (cell positions)
    shift_row_indices_for_delete(&mut row_dependents_map, row, count);
    
    // Update row_dependencies: shift keys (cell positions) and values (row indices)
    shift_row_dependencies_map_for_delete(&mut row_dependencies_map, row, count);
    
    // Recalculate grid bounds
    grid.recalculate_bounds();
    
    // Sync grids vector
    if active_sheet < grids.len() {
        grids[active_sheet].cells = grid.cells.clone();
        grids[active_sheet].max_row = grid.max_row;
        grids[active_sheet].max_col = grid.max_col;
    }
    
    // Return updated cells
    let mut result: Vec<CellData> = Vec::new();
    for r in 0..=grid.max_row {
        for c in 0..=grid.max_col {
            if let Some(cell_data) = get_cell_internal(&grid, &styles, r, c) {
                result.push(cell_data);
            }
        }
    }
    
    Ok(result)
}

/// Delete columns at the specified position, shifting remaining columns left.
#[tauri::command]
pub fn delete_columns(
    state: State<AppState>,
    col: u32,
    count: u32,
) -> Result<Vec<CellData>, String> {
    let mut grid = state.grid.lock().map_err(|e| e.to_string())?;
    let mut grids = state.grids.lock().map_err(|e| e.to_string())?;
    let styles = state.style_registry.lock().map_err(|e| e.to_string())?;
    let mut column_widths = state.column_widths.lock().map_err(|e| e.to_string())?;
    let active_sheet = *state.active_sheet.lock().map_err(|e| e.to_string())?;
    
    // Lock all dependency maps
    let mut dependents_map = state.dependents.lock().map_err(|e| e.to_string())?;
    let mut dependencies_map = state.dependencies.lock().map_err(|e| e.to_string())?;
    let mut column_dependents_map = state.column_dependents.lock().map_err(|e| e.to_string())?;
    let mut column_dependencies_map = state.column_dependencies.lock().map_err(|e| e.to_string())?;
    let mut row_dependents_map = state.row_dependents.lock().map_err(|e| e.to_string())?;
    let mut row_dependencies_map = state.row_dependencies.lock().map_err(|e| e.to_string())?;
    
    // First, remove cells in the deleted columns
    let cells_to_delete: Vec<(u32, u32)> = grid.cells.keys()
        .filter(|(_, c)| *c >= col && *c < col + count)
        .cloned()
        .collect();
    
    for pos in cells_to_delete {
        grid.cells.remove(&pos);
    }
    
    // Update formula references in remaining cells (shift left = negative delta)
    let all_cells: Vec<((u32, u32), Cell)> = grid.cells.iter()
        .map(|(&pos, cell)| (pos, cell.clone()))
        .collect();
    
    for ((r, c), cell) in &all_cells {
        if let Some(formula) = &cell.formula {
            let updated_formula = shift_formula_col_references(formula, col, -(count as i32));
            if updated_formula != *formula {
                let mut updated_cell = cell.clone();
                updated_cell.formula = Some(updated_formula);
                grid.cells.insert((*r, *c), updated_cell);
            }
        }
    }
    
    // Move remaining cells left
    let mut cells_to_move: Vec<((u32, u32), Cell)> = Vec::new();
    for (&(r, c), cell) in grid.cells.iter() {
        if c >= col + count {
            cells_to_move.push(((r, c), cell.clone()));
        }
    }
    
    // Sort by column ascending so we move from left to right
    cells_to_move.sort_by(|a, b| a.0 .1.cmp(&b.0 .1));
    
    // Remove old cells and insert at new positions
    for ((r, c), cell) in cells_to_move {
        grid.cells.remove(&(r, c));
        grid.cells.insert((r, c - count), cell);
    }
    
    // Update column widths
    let old_widths: Vec<(u32, f64)> = column_widths.iter().map(|(&c, &w)| (c, w)).collect();
    column_widths.clear();
    for (c, width) in old_widths {
        if c >= col && c < col + count {
            // Skip deleted columns
            continue;
        }
        if c >= col + count {
            column_widths.insert(c - count, width);
        } else {
            column_widths.insert(c, width);
        }
    }
    
    // === UPDATE DEPENDENCY MAPS ===
    
    // Update dependents map
    let deps_entries: Vec<_> = dependents_map.drain().collect();
    for ((r, c), dep_set) in deps_entries {
        if c >= col && c < col + count {
            continue; // Skip deleted columns
        }
        let new_c = if c >= col + count { c - count } else { c };
        let new_set = shift_cell_set_for_col_delete(&dep_set, col, count);
        if !new_set.is_empty() {
            dependents_map.insert((r, new_c), new_set);
        }
    }
    
    // Update dependencies map
    let deps_entries: Vec<_> = dependencies_map.drain().collect();
    for ((r, c), ref_set) in deps_entries {
        if c >= col && c < col + count {
            continue; // Skip deleted columns
        }
        let new_c = if c >= col + count { c - count } else { c };
        let new_set = shift_cell_set_for_col_delete(&ref_set, col, count);
        if !new_set.is_empty() {
            dependencies_map.insert((r, new_c), new_set);
        }
    }
    
    // Update column_dependents: shift both keys (col indices) and values (cell positions)
    shift_col_indices_for_delete(&mut column_dependents_map, col, count);
    
    // Update column_dependencies: shift keys (cell positions) and values (col indices)
    shift_col_dependencies_map_for_delete(&mut column_dependencies_map, col, count);
    
    // Update row_dependents: shift cell positions in values only
    for (_row, cell_set) in row_dependents_map.iter_mut() {
        *cell_set = shift_cell_set_for_col_delete(cell_set, col, count);
    }
    
    // Update row_dependencies: shift keys only (cell positions)
    shift_cell_positions_for_col_delete(&mut row_dependencies_map, col, count);
    
    // Recalculate grid bounds
    grid.recalculate_bounds();
    
    // Sync grids vector
    if active_sheet < grids.len() {
        grids[active_sheet].cells = grid.cells.clone();
        grids[active_sheet].max_row = grid.max_row;
        grids[active_sheet].max_col = grid.max_col;
    }
    
    // Return updated cells
    let mut result: Vec<CellData> = Vec::new();
    for r in 0..=grid.max_row {
        for c in 0..=grid.max_col {
            if let Some(cell_data) = get_cell_internal(&grid, &styles, r, c) {
                result.push(cell_data);
            }
        }
    }
    
    Ok(result)
}