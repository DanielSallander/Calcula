//! FILENAME: app/src-tauri/src/commands/structure.rs
// PURPOSE: Complex logic for inserting and deleting rows/columns and updating references.

use crate::api_types::CellData;
use crate::commands::utils::get_cell_internal_with_merge;
use crate::AppState;
use crate::pivot::types::PivotState;
use engine::Cell;
use pivot_engine::PivotId;
use std::collections::{HashMap, HashSet};
use tauri::State;

/// ============================================================================
// PROTECTED REGION SHIFT HELPERS
// ============================================================================

/// Shift protected regions when rows are inserted.
/// Coordinate shifts apply to ALL regions; pivot definition updates apply only to pivot regions.
fn shift_pivot_regions_for_row_insert(state: &AppState, pivot_state: &PivotState, from_row: u32, count: u32, sheet_index: usize) {
    let mut regions = state.protected_regions.lock().unwrap();
    let mut pivot_tables = pivot_state.pivot_tables.lock().unwrap();

    for region in regions.iter_mut() {
        if region.sheet_index != sheet_index {
            continue;
        }

        // Shift region coordinates if at or below insertion point (generic for all regions)
        if region.start_row >= from_row {
            region.start_row += count;
            region.end_row += count;
        } else if region.end_row >= from_row {
            // Region spans the insertion point - expand it
            region.end_row += count;
        }

        // Pivot-specific: also update the pivot definition's destination
        if region.region_type == "pivot" {
            let pid = region.owner_id as PivotId;
            if let Some((definition, _)) = pivot_tables.get_mut(&pid) {
                let (dest_row, dest_col) = definition.destination;
                if dest_row >= from_row {
                    definition.destination = (dest_row + count, dest_col);
                }

                let (src_start_row, src_start_col) = definition.source_start;
                let (src_end_row, src_end_col) = definition.source_end;

                if src_start_row >= from_row {
                    definition.source_start = (src_start_row + count, src_start_col);
                }
                if src_end_row >= from_row {
                    definition.source_end = (src_end_row + count, src_end_col);
                } else if src_end_row >= from_row {
                    definition.source_end = (src_end_row + count, src_end_col);
                }
            }
        }
    }
}

/// Shift protected regions when columns are inserted.
fn shift_pivot_regions_for_col_insert(state: &AppState, pivot_state: &PivotState, from_col: u32, count: u32, sheet_index: usize) {
    let mut regions = state.protected_regions.lock().unwrap();
    let mut pivot_tables = pivot_state.pivot_tables.lock().unwrap();

    for region in regions.iter_mut() {
        if region.sheet_index != sheet_index {
            continue;
        }

        // Shift region coordinates (generic for all regions)
        if region.start_col >= from_col {
            region.start_col += count;
            region.end_col += count;
        } else if region.end_col >= from_col {
            region.end_col += count;
        }

        // Pivot-specific: update the pivot definition's destination
        if region.region_type == "pivot" {
            let pid = region.owner_id as PivotId;
            if let Some((definition, _)) = pivot_tables.get_mut(&pid) {
                let (dest_row, dest_col) = definition.destination;
                if dest_col >= from_col {
                    definition.destination = (dest_row, dest_col + count);
                }

                let (src_start_row, src_start_col) = definition.source_start;
                let (src_end_row, src_end_col) = definition.source_end;

                if src_start_col >= from_col {
                    definition.source_start = (src_start_row, src_start_col + count);
                }
                if src_end_col >= from_col {
                    definition.source_end = (src_end_row, src_end_col + count);
                } else if src_end_col >= from_col {
                    definition.source_end = (src_end_row, src_end_col + count);
                }
            }
        }
    }
}

/// Shift protected regions when rows are deleted.
fn shift_pivot_regions_for_row_delete(state: &AppState, pivot_state: &PivotState, from_row: u32, count: u32, sheet_index: usize) {
    let mut regions = state.protected_regions.lock().unwrap();
    let mut pivot_tables = pivot_state.pivot_tables.lock().unwrap();

    // Collect IDs of regions fully within the deleted range
    let mut regions_to_remove: Vec<String> = Vec::new();

    for region in regions.iter_mut() {
        if region.sheet_index != sheet_index {
            continue;
        }

        let delete_end = from_row + count;

        // Check if region is fully within deleted range
        if region.start_row >= from_row && region.end_row < delete_end {
            regions_to_remove.push(region.id.clone());
            continue;
        }

        // Shift region coordinates (generic for all regions)
        if region.start_row >= delete_end {
            region.start_row -= count;
            region.end_row -= count;
        } else if region.start_row >= from_row {
            region.start_row = from_row;
            region.end_row -= count;
        } else if region.end_row >= delete_end {
            region.end_row -= count;
        } else if region.end_row >= from_row {
            region.end_row = from_row.saturating_sub(1);
        }

        // Pivot-specific: update definition
        if region.region_type == "pivot" {
            let pid = region.owner_id as PivotId;
            if let Some((definition, _)) = pivot_tables.get_mut(&pid) {
                let (dest_row, dest_col) = definition.destination;
                if dest_row >= delete_end {
                    definition.destination = (dest_row - count, dest_col);
                } else if dest_row >= from_row {
                    definition.destination = (from_row, dest_col);
                }

                let (src_start_row, src_start_col) = definition.source_start;
                let (src_end_row, src_end_col) = definition.source_end;

                let new_start_row = if src_start_row >= delete_end {
                    src_start_row - count
                } else if src_start_row >= from_row {
                    from_row
                } else {
                    src_start_row
                };

                let new_end_row = if src_end_row >= delete_end {
                    src_end_row - count
                } else if src_end_row >= from_row {
                    from_row.saturating_sub(1).max(new_start_row)
                } else {
                    src_end_row
                };

                definition.source_start = (new_start_row, src_start_col);
                definition.source_end = (new_end_row, src_end_col);
            }
        }
    }

    // Remove fully deleted regions and their associated pivot data
    for region_id in &regions_to_remove {
        if let Some(region) = regions.iter().find(|r| &r.id == region_id) {
            if region.region_type == "pivot" {
                let pid = region.owner_id as PivotId;
                pivot_tables.remove(&pid);
            }
        }
    }
    regions.retain(|r| !regions_to_remove.contains(&r.id));
}

/// Shift protected regions when columns are deleted.
fn shift_pivot_regions_for_col_delete(state: &AppState, pivot_state: &PivotState, from_col: u32, count: u32, sheet_index: usize) {
    let mut regions = state.protected_regions.lock().unwrap();
    let mut pivot_tables = pivot_state.pivot_tables.lock().unwrap();

    let mut regions_to_remove: Vec<String> = Vec::new();

    for region in regions.iter_mut() {
        if region.sheet_index != sheet_index {
            continue;
        }

        let delete_end = from_col + count;

        // Check if region is fully within deleted range
        if region.start_col >= from_col && region.end_col < delete_end {
            regions_to_remove.push(region.id.clone());
            continue;
        }

        // Shift region coordinates (generic for all regions)
        if region.start_col >= delete_end {
            region.start_col -= count;
            region.end_col -= count;
        } else if region.start_col >= from_col {
            region.start_col = from_col;
            region.end_col -= count;
        } else if region.end_col >= delete_end {
            region.end_col -= count;
        } else if region.end_col >= from_col {
            region.end_col = from_col.saturating_sub(1);
        }

        // Pivot-specific: update definition
        if region.region_type == "pivot" {
            let pid = region.owner_id as PivotId;
            if let Some((definition, _)) = pivot_tables.get_mut(&pid) {
                let (dest_row, dest_col) = definition.destination;
                if dest_col >= delete_end {
                    definition.destination = (dest_row, dest_col - count);
                } else if dest_col >= from_col {
                    definition.destination = (dest_row, from_col);
                }

                let (src_start_row, src_start_col) = definition.source_start;
                let (src_end_row, src_end_col) = definition.source_end;

                let new_start_col = if src_start_col >= delete_end {
                    src_start_col - count
                } else if src_start_col >= from_col {
                    from_col
                } else {
                    src_start_col
                };

                let new_end_col = if src_end_col >= delete_end {
                    src_end_col - count
                } else if src_end_col >= from_col {
                    from_col.saturating_sub(1).max(new_start_col)
                } else {
                    src_end_col
                };

                definition.source_start = (src_start_row, new_start_col);
                definition.source_end = (src_end_row, new_end_col);
            }
        }
    }

    // Remove fully deleted regions and their associated pivot data
    for region_id in &regions_to_remove {
        if let Some(region) = regions.iter().find(|r| &r.id == region_id) {
            if region.region_type == "pivot" {
                let pid = region.owner_id as PivotId;
                pivot_tables.remove(&pid);
            }
        }
    }
    regions.retain(|r| !regions_to_remove.contains(&r.id));
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
/// NOTE: insert_rows does NOT support undo currently due to complexity of structural changes.
/// This could be added in a future version.
#[tauri::command]
pub fn insert_rows(
    state: State<AppState>,
    pivot_state: State<'_, PivotState>,
    row: u32,
    count: u32,
) -> Result<Vec<CellData>, String> {
    let mut grid = state.grid.lock().map_err(|e| e.to_string())?;
    let mut grids = state.grids.lock().map_err(|e| e.to_string())?;
    let styles = state.style_registry.lock().map_err(|e| e.to_string())?;
    let mut row_heights = state.row_heights.lock().map_err(|e| e.to_string())?;
    let active_sheet = *state.active_sheet.lock().map_err(|e| e.to_string())?;
    let mut undo_stack = state.undo_stack.lock().map_err(|e| e.to_string())?;
    let merged_regions = state.merged_regions.lock().map_err(|e| e.to_string())?;
    
    // Lock all dependency maps
    let mut dependents_map = state.dependents.lock().map_err(|e| e.to_string())?;
    let mut dependencies_map = state.dependencies.lock().map_err(|e| e.to_string())?;
    let mut column_dependents_map = state.column_dependents.lock().map_err(|e| e.to_string())?;
    let mut column_dependencies_map = state.column_dependencies.lock().map_err(|e| e.to_string())?;
    let mut row_dependents_map = state.row_dependents.lock().map_err(|e| e.to_string())?;
    let mut row_dependencies_map = state.row_dependencies.lock().map_err(|e| e.to_string())?;

    // Clear undo history for structural changes (complex to reverse)
    undo_stack.clear();
    
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
    
    // Drop locks before calling pivot region shift (which needs its own locks)
    drop(dependents_map);
    drop(dependencies_map);
    drop(column_dependents_map);
    drop(column_dependencies_map);
    drop(row_dependents_map);
    drop(row_dependencies_map);
    drop(undo_stack);
    drop(row_heights);
    drop(merged_regions);
    drop(styles);
    drop(grids);
    drop(grid);
    
    // === UPDATE PIVOT REGIONS ===
    shift_pivot_regions_for_row_insert(&state, &pivot_state, row, count, active_sheet);
    
    // Re-acquire locks for result building
    let grid = state.grid.lock().map_err(|e| e.to_string())?;
    let styles = state.style_registry.lock().map_err(|e| e.to_string())?;
    let merged_regions = state.merged_regions.lock().map_err(|e| e.to_string())?;
    
    // Return updated cells with merge info
    let mut result: Vec<CellData> = Vec::new();
    for r in 0..=grid.max_row {
        for c in 0..=grid.max_col {
            if let Some(cell_data) = get_cell_internal_with_merge(&grid, &styles, &merged_regions, r, c) {
                result.push(cell_data);
            }
        }
    }
    
    Ok(result)
}

/// Insert columns at the specified position, shifting existing columns right.
/// NOTE: insert_columns does NOT support undo currently due to complexity of structural changes.
#[tauri::command]
pub fn insert_columns(
    state: State<AppState>,
    pivot_state: State<'_, PivotState>,
    col: u32,
    count: u32,
) -> Result<Vec<CellData>, String> {
    let mut grid = state.grid.lock().map_err(|e| e.to_string())?;
    let mut grids = state.grids.lock().map_err(|e| e.to_string())?;
    let styles = state.style_registry.lock().map_err(|e| e.to_string())?;
    let mut column_widths = state.column_widths.lock().map_err(|e| e.to_string())?;
    let active_sheet = *state.active_sheet.lock().map_err(|e| e.to_string())?;
    let mut undo_stack = state.undo_stack.lock().map_err(|e| e.to_string())?;
    let merged_regions = state.merged_regions.lock().map_err(|e| e.to_string())?;
    
    // Lock all dependency maps
    let mut dependents_map = state.dependents.lock().map_err(|e| e.to_string())?;
    let mut dependencies_map = state.dependencies.lock().map_err(|e| e.to_string())?;
    let mut column_dependents_map = state.column_dependents.lock().map_err(|e| e.to_string())?;
    let mut column_dependencies_map = state.column_dependencies.lock().map_err(|e| e.to_string())?;
    let mut row_dependents_map = state.row_dependents.lock().map_err(|e| e.to_string())?;
    let mut row_dependencies_map = state.row_dependencies.lock().map_err(|e| e.to_string())?;

    // Clear undo history for structural changes
    undo_stack.clear();
    
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
    
    // Drop locks before calling pivot region shift
    drop(dependents_map);
    drop(dependencies_map);
    drop(column_dependents_map);
    drop(column_dependencies_map);
    drop(row_dependents_map);
    drop(row_dependencies_map);
    drop(undo_stack);
    drop(column_widths);
    drop(merged_regions);
    drop(styles); 
    drop(grids);
    drop(grid);
    
    // === UPDATE PIVOT REGIONS ===
    shift_pivot_regions_for_col_insert(&state, &pivot_state, col, count, active_sheet);
    
    // Re-acquire locks for result building
    let grid = state.grid.lock().map_err(|e| e.to_string())?;
    let styles = state.style_registry.lock().map_err(|e| e.to_string())?;
    let merged_regions = state.merged_regions.lock().map_err(|e| e.to_string())?;
    
    // Return updated cells with merge info
    let mut result: Vec<CellData> = Vec::new();
    for r in 0..=grid.max_row {
        for c in 0..=grid.max_col {
            if let Some(cell_data) = get_cell_internal_with_merge(&grid, &styles, &merged_regions, r, c) {
                result.push(cell_data);
            }
        }
    }
    
    Ok(result)
}

// ============================================================================
// FORMULA REFERENCE SHIFTING (respects $ absolute markers)
// ============================================================================

/// Shift row references in a formula by a given amount.
/// Respects $ absolute markers - $5 won't be shifted, but 5 will.
pub fn shift_formula_row_references(formula: &str, from_row: u32, delta: i32) -> String {
    use regex::Regex;
    
    // Handle cell references (e.g., A5, $A$5, A$5, $A5)
    // Pattern: optional $ + letters + optional $ + digits
    let cell_re = Regex::new(r"(\$?)([A-Za-z]+)(\$?)(\d+)").unwrap();
    
    let result = cell_re.replace_all(formula, |caps: &regex::Captures| {
        let col_abs = &caps[1];
        let col_letters = &caps[2];
        let row_abs = &caps[3];
        let row_num: u32 = caps[4].parse().unwrap_or(0);
        
        // Only shift if row is NOT absolute (no $) and row is at or after from_row
        // from_row is 0-indexed, row_num is 1-indexed
        let new_row = if row_abs.is_empty() && row_num > from_row {
            ((row_num as i32) + delta).max(1) as u32
        } else {
            row_num
        };
        
        format!("{}{}{}{}", col_abs, col_letters, row_abs, new_row)
    }).to_string();
    
    // Handle row-only references (e.g., 5:5, $2:$10, 2:$10)
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
/// Respects $ absolute markers - $A won't be shifted, but A will.
pub fn shift_formula_col_references(formula: &str, from_col: u32, delta: i32) -> String {
    use regex::Regex;
    
    fn col_to_index(col: &str) -> u32 {
        let mut index: u32 = 0;
        for ch in col.to_uppercase().chars() {
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
    
    // Handle cell references (e.g., C5, $C$5, C$5, $C5)
    let cell_re = Regex::new(r"(\$?)([A-Za-z]+)(\$?)(\d+)").unwrap();
    
    let result = cell_re.replace_all(formula, |caps: &regex::Captures| {
        let col_abs = &caps[1];
        let col_letters = &caps[2];
        let row_abs = &caps[3];
        let row_num = &caps[4];
        
        let col_index = col_to_index(col_letters);
        
        // Only shift if column is NOT absolute (no $) and col is at or after from_col
        let new_col_index = if col_abs.is_empty() && col_index >= from_col {
            ((col_index as i32) + delta).max(0) as u32
        } else {
            col_index
        };
        
        let new_col_letters = index_to_col(new_col_index);
        
        format!("{}{}{}{}", col_abs, new_col_letters, row_abs, row_num)
    }).to_string();
    
    // Handle column-only references (e.g., B:B, $A:$C, A:$C)
    let col_re = Regex::new(r"(\$?)([A-Za-z]+):(\$?)([A-Za-z]+)").unwrap();
    
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

/// Shift formula references for fill handle operation.
/// This shifts references based on the fill direction and offset.
/// Exported for use by fill handle command.
#[tauri::command]
pub fn shift_formula_for_fill(
    formula: String,
    row_delta: i32,
    col_delta: i32,
) -> Result<String, String> {
    let mut result = formula;
    
    // Shift rows if there's a row delta
    if row_delta != 0 {
        // For fill, we shift all non-absolute rows by the delta
        // Use from_row=0 so all rows >= 1 are considered for shifting
        result = shift_formula_row_references_for_fill(&result, row_delta);
    }
    
    // Shift columns if there's a column delta
    if col_delta != 0 {
        result = shift_formula_col_references_for_fill(&result, col_delta);
    }
    
    Ok(result)
}

/// Shift row references for fill operation (all non-absolute refs shift).
fn shift_formula_row_references_for_fill(formula: &str, delta: i32) -> String {
    use regex::Regex;
    
    let cell_re = Regex::new(r"(\$?)([A-Za-z]+)(\$?)(\d+)").unwrap();
    
    cell_re.replace_all(formula, |caps: &regex::Captures| {
        let col_abs = &caps[1];
        let col_letters = &caps[2];
        let row_abs = &caps[3];
        let row_num: u32 = caps[4].parse().unwrap_or(0);
        
        // Only shift if row is NOT absolute (no $)
        let new_row = if row_abs.is_empty() {
            ((row_num as i32) + delta).max(1) as u32
        } else {
            row_num
        };
        
        format!("{}{}{}{}", col_abs, col_letters, row_abs, new_row)
    }).to_string()
}

/// Shift column references for fill operation (all non-absolute refs shift).
fn shift_formula_col_references_for_fill(formula: &str, delta: i32) -> String {
    use regex::Regex;
    
    fn col_to_index(col: &str) -> u32 {
        let mut index: u32 = 0;
        for ch in col.to_uppercase().chars() {
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
    
    let cell_re = Regex::new(r"(\$?)([A-Za-z]+)(\$?)(\d+)").unwrap();
    
    cell_re.replace_all(formula, |caps: &regex::Captures| {
        let col_abs = &caps[1];
        let col_letters = &caps[2];
        let row_abs = &caps[3];
        let row_num = &caps[4];
        
        let col_index = col_to_index(col_letters);
        
        // Only shift if column is NOT absolute (no $)
        let new_col_index = if col_abs.is_empty() {
            ((col_index as i32) + delta).max(0) as u32
        } else {
            col_index
        };
        
        let new_col_letters = index_to_col(new_col_index);
        
        format!("{}{}{}{}", col_abs, new_col_letters, row_abs, row_num)
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
/// NOTE: delete_rows does NOT support undo currently due to complexity of structural changes.
#[tauri::command]
pub fn delete_rows(
    state: State<AppState>,
    pivot_state: State<'_, PivotState>,
    row: u32,
    count: u32,
) -> Result<Vec<CellData>, String> {
    let mut grid = state.grid.lock().map_err(|e| e.to_string())?;
    let mut grids = state.grids.lock().map_err(|e| e.to_string())?;
    let styles = state.style_registry.lock().map_err(|e| e.to_string())?;
    let mut row_heights = state.row_heights.lock().map_err(|e| e.to_string())?;
    let active_sheet = *state.active_sheet.lock().map_err(|e| e.to_string())?;
    let mut undo_stack = state.undo_stack.lock().map_err(|e| e.to_string())?;
    let merged_regions = state.merged_regions.lock().map_err(|e| e.to_string())?;
    
    // Lock all dependency maps
    let mut dependents_map = state.dependents.lock().map_err(|e| e.to_string())?;
    let mut dependencies_map = state.dependencies.lock().map_err(|e| e.to_string())?;
    let mut column_dependents_map = state.column_dependents.lock().map_err(|e| e.to_string())?;
    let mut column_dependencies_map = state.column_dependencies.lock().map_err(|e| e.to_string())?;
    let mut row_dependents_map = state.row_dependents.lock().map_err(|e| e.to_string())?;
    let mut row_dependencies_map = state.row_dependencies.lock().map_err(|e| e.to_string())?;

    // Clear undo history for structural changes
    undo_stack.clear();
    
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
    
    // Drop locks before calling pivot region shift
    drop(dependents_map);
    drop(dependencies_map);
    drop(column_dependents_map);
    drop(column_dependencies_map);
    drop(row_dependents_map);
    drop(row_dependencies_map);
    drop(undo_stack);
    drop(row_heights);
    drop(merged_regions);
    drop(styles);
    drop(grids);
    drop(grid);
    
    // === UPDATE PIVOT REGIONS ===
    shift_pivot_regions_for_row_delete(&state, &pivot_state, row, count, active_sheet);
    
    // Re-acquire locks for result building
    let grid = state.grid.lock().map_err(|e| e.to_string())?;
    let styles = state.style_registry.lock().map_err(|e| e.to_string())?;
    let merged_regions = state.merged_regions.lock().map_err(|e| e.to_string())?;
    
    // Return updated cells with merge info
    let mut result: Vec<CellData> = Vec::new();
    for r in 0..=grid.max_row {
        for c in 0..=grid.max_col {
            if let Some(cell_data) = get_cell_internal_with_merge(&grid, &styles, &merged_regions, r, c) {
                result.push(cell_data);
            }
        }
    }
    
    Ok(result)
}

/// Delete columns at the specified position, shifting remaining columns left.
/// NOTE: delete_columns does NOT support undo currently due to complexity of structural changes.
#[tauri::command]
pub fn delete_columns(
    state: State<AppState>,
    pivot_state: State<'_, PivotState>,
    col: u32,
    count: u32,
) -> Result<Vec<CellData>, String> {
    let mut grid = state.grid.lock().map_err(|e| e.to_string())?;
    let mut grids = state.grids.lock().map_err(|e| e.to_string())?;
    let styles = state.style_registry.lock().map_err(|e| e.to_string())?;
    let mut column_widths = state.column_widths.lock().map_err(|e| e.to_string())?;
    let active_sheet = *state.active_sheet.lock().map_err(|e| e.to_string())?;
    let mut undo_stack = state.undo_stack.lock().map_err(|e| e.to_string())?;
    let merged_regions = state.merged_regions.lock().map_err(|e| e.to_string())?;
    
    // Lock all dependency maps
    let mut dependents_map = state.dependents.lock().map_err(|e| e.to_string())?;
    let mut dependencies_map = state.dependencies.lock().map_err(|e| e.to_string())?;
    let mut column_dependents_map = state.column_dependents.lock().map_err(|e| e.to_string())?;
    let mut column_dependencies_map = state.column_dependencies.lock().map_err(|e| e.to_string())?;
    let mut row_dependents_map = state.row_dependents.lock().map_err(|e| e.to_string())?;
    let mut row_dependencies_map = state.row_dependencies.lock().map_err(|e| e.to_string())?;

    // Clear undo history for structural changes
    undo_stack.clear();
    
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
    
    // Drop locks before calling pivot region shift
    drop(dependents_map);
    drop(dependencies_map);
    drop(column_dependents_map);
    drop(column_dependencies_map);
    drop(row_dependents_map);
    drop(row_dependencies_map);
    drop(undo_stack);
    drop(column_widths);
    drop(merged_regions);
    drop(styles);
    drop(grids);
    drop(grid);
    
    // === UPDATE PIVOT REGIONS ===
    shift_pivot_regions_for_col_delete(&state, &pivot_state, col, count, active_sheet);
    
    // Re-acquire locks for result building
    let grid = state.grid.lock().map_err(|e| e.to_string())?;
    let styles = state.style_registry.lock().map_err(|e| e.to_string())?;
    let merged_regions = state.merged_regions.lock().map_err(|e| e.to_string())?;
    
    // Return updated cells with merge info
    let mut result: Vec<CellData> = Vec::new();
    for r in 0..=grid.max_row {
        for c in 0..=grid.max_col {
            if let Some(cell_data) = get_cell_internal_with_merge(&grid, &styles, &merged_regions, r, c) {
                result.push(cell_data);
            }
        }
    }
    
    Ok(result)
}