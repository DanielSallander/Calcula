// PURPOSE: Core operations for reading and writing cell data.

use crate::api_types::CellData;
use crate::commands::utils::get_cell_internal_with_merge;
use crate::{
    evaluate_formula_multi_sheet, extract_all_references, format_cell_value,
    get_column_row_dependents, get_recalculation_order, parse_cell_input,
    update_column_dependencies, update_cross_sheet_dependencies, update_dependencies,
    update_row_dependencies, AppState,
};
use engine::{Grid, StyleRegistry};
use std::collections::HashSet;
use tauri::State;

// Note: Assuming parser is available in the crate root based on usage context
// If 'parser' is a module, ensure it is imported via `use crate::parser;` if needed.

/// Get cells for a viewport range.
/// Now includes merged cell span information.
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
    let merged_regions = state.merged_regions.lock().unwrap();
    let mut cells = Vec::new();

    // Track which cells are "slave" cells (part of a merge but not the master)
    let mut slave_cells: HashSet<(u32, u32)> = HashSet::new();
    
    // First pass: identify all slave cells within the viewport
    for region in merged_regions.iter() {
        // Check if this region overlaps with the viewport
        if region.end_row < start_row || region.start_row > end_row ||
           region.end_col < start_col || region.start_col > end_col {
            continue;
        }
        
        // Mark all cells except the master as slaves
        for r in region.start_row..=region.end_row {
            for c in region.start_col..=region.end_col {
                if r == region.start_row && c == region.start_col {
                    continue; // Skip master cell
                }
                slave_cells.insert((r, c));
            }
        }
    }

    for row in start_row..=end_row {
        for col in start_col..=end_col {
            // Skip slave cells - they shouldn't be returned
            if slave_cells.contains(&(row, col)) {
                continue;
            }
            
            if let Some(cell_data) = get_cell_internal_with_merge(&grid, &styles, &merged_regions, row, col) {
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
    let merged_regions = state.merged_regions.lock().unwrap();
    get_cell_internal_with_merge(&grid, &styles, &merged_regions, row, col)
}

/// Internal helper for getting cell data without merge info (for backward compatibility).
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
        row_span: 1,
        col_span: 1,
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
    // Check if cell is in a pivot region - pivot cells cannot be edited directly
    let active_sheet_for_pivot_check = *state.active_sheet.lock().unwrap();
    if let Some(pivot_id) = state.is_cell_in_pivot_region(active_sheet_for_pivot_check, row, col) {
        return Err(format!(
            "Cannot edit cell ({}, {}): it is part of pivot table {}. Use the pivot pane to modify pivot tables.",
            row + 1, col + 1, pivot_id
        ));
    }

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
    let mut undo_stack = state.undo_stack.lock().unwrap();
    let merged_regions = state.merged_regions.lock().unwrap();

    let current_sheet_name = sheet_names.get(active_sheet).cloned().unwrap_or_default();

    let mut updated_cells = Vec::new();

    // Record previous state for undo BEFORE making any changes
    let previous_cell = grid.get_cell(row, col).cloned();

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
        
        // Get merge span info for the cleared cell
        let merge_info = merged_regions.iter().find(|r| r.start_row == row && r.start_col == col);
        let (row_span, col_span) = if let Some(region) = merge_info {
            (region.end_row - region.start_row + 1, region.end_col - region.start_col + 1)
        } else {
            (1, 1)
        };
        
        updated_cells.push(CellData {
            row,
            col,
            display: String::new(),
            formula: None,
            style_index: 0,
            row_span,
            col_span,
        });

        // Record undo after successful change
        undo_stack.record_cell_change(row, col, previous_cell);

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

    // Get merge span info
    let merge_info = merged_regions.iter().find(|r| r.start_row == row && r.start_col == col);
    let (row_span, col_span) = if let Some(region) = merge_info {
        (region.end_row - region.start_row + 1, region.end_col - region.start_col + 1)
    } else {
        (1, 1)
    };

    updated_cells.push(CellData {
        row,
        col,
        display,
        formula: cell.formula.clone(),
        style_index: cell.style_index,
        row_span,
        col_span,
    });

    // Record undo after successful change
    undo_stack.record_cell_change(row, col, previous_cell);

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

                    // Get merge span info for dependent
                    let dep_merge_info = merged_regions.iter().find(|r| r.start_row == dep_row && r.start_col == dep_col);
                    let (dep_row_span, dep_col_span) = if let Some(region) = dep_merge_info {
                        (region.end_row - region.start_row + 1, region.end_col - region.start_col + 1)
                    } else {
                        (1, 1)
                    };

                    updated_cells.push(CellData {
                        row: dep_row,
                        col: dep_col,
                        display: dep_display,
                        formula: updated_dep.formula.clone(),
                        style_index: updated_dep.style_index,
                        row_span: dep_row_span,
                        col_span: dep_col_span,
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
    let mut undo_stack = state.undo_stack.lock().unwrap();

    // Record previous state for undo
    let previous_cell = grid.get_cell(row, col).cloned();

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

    // Record undo if there was actually a cell to clear
    if previous_cell.is_some() {
        undo_stack.record_cell_change(row, col, previous_cell);
    }
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
    let mut undo_stack = state.undo_stack.lock().unwrap();

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

    // Begin undo transaction for batch operation
    if count > 0 {
        undo_stack.begin_transaction(format!(
            "Clear range ({},{}) to ({},{})",
            start_row, start_col, end_row, end_col
        ));
    }

    // Clear each cell
    for (row, col) in cells_to_clear {
        // Record previous state for undo
        let previous_cell = grid.get_cell(row, col).cloned();
        if previous_cell.is_some() {
            undo_stack.record_cell_change(row, col, previous_cell);
        }

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

    // Commit undo transaction
    if count > 0 {
        undo_stack.commit_transaction();
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