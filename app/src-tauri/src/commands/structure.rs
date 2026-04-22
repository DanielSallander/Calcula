//! FILENAME: app/src-tauri/src/commands/structure.rs
// PURPOSE: Complex logic for inserting and deleting rows/columns and updating references.

use crate::api_types::CellData;
use crate::commands::utils::get_cell_internal_with_merge;
use crate::AppState;
use crate::persistence::FileState;
use crate::pivot::types::PivotState;
use engine::{Cell, GridSnapshot, UndoMergeRegion};
use once_cell::sync::Lazy;
use pivot_engine::PivotId;
use regex::Regex;
use std::collections::{HashMap, HashSet};
use tauri::State;

// Pre-compiled regexes for formula reference shifting (avoids ~2.6ms per Regex::new call)
static CELL_REF_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(\$?)([A-Za-z]+)(\$?)(\d+)").unwrap());
static ROW_RANGE_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(\$?)(\d+):(\$?)(\d+)").unwrap());
static COL_RANGE_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(\$?)([A-Za-z]+):(\$?)([A-Za-z]+)").unwrap());
static CELL_RANGE_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(\$?)([A-Za-z]+)(\$?)(\d+):(\$?)([A-Za-z]+)(\$?)(\d+)").unwrap());

/// Capture a snapshot of the current grid state for undo.
fn capture_grid_snapshot(state: &AppState) -> GridSnapshot {
    let grid = state.grid.lock().unwrap();
    let row_heights = state.row_heights.lock().unwrap();
    let column_widths = state.column_widths.lock().unwrap();
    let merged_regions = state.merged_regions.lock().unwrap();

    GridSnapshot {
        cells: grid.cells.clone(),
        row_heights: row_heights.clone(),
        column_widths: column_widths.clone(),
        merged_regions: merged_regions
            .iter()
            .map(|r| UndoMergeRegion {
                start_row: r.start_row,
                start_col: r.start_col,
                end_row: r.end_row,
                end_col: r.end_col,
            })
            .collect(),
        max_row: grid.max_row,
        max_col: grid.max_col,
    }
}

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

/// ============================================================================
// TABLE BOUNDARY SHIFT HELPERS
// ============================================================================

/// Shift table boundaries when rows are inserted.
/// Tables entirely below the insertion point are shifted down.
/// Tables spanning the insertion point (including at start_row) expand.
fn shift_table_boundaries_for_row_insert(state: &AppState, from_row: u32, count: u32, sheet_index: usize) {
    let mut tables = state.tables.lock().unwrap();

    if let Some(sheet_tables) = tables.get_mut(&sheet_index) {
        for table in sheet_tables.values_mut() {
            if table.start_row > from_row {
                // Insertion is strictly before the table - shift entire table down
                table.start_row += count;
                table.end_row += count;
            } else if table.end_row >= from_row {
                // Insertion is inside the table (including at start_row) - expand
                table.end_row += count;
            }
        }
    }
}

/// Shift table boundaries when columns are inserted.
/// Tables entirely to the right of the insertion point are shifted right.
/// Tables spanning the insertion point (including at start_col) expand.
fn shift_table_boundaries_for_col_insert(state: &AppState, from_col: u32, count: u32, sheet_index: usize) {
    let mut tables = state.tables.lock().unwrap();

    if let Some(sheet_tables) = tables.get_mut(&sheet_index) {
        for table in sheet_tables.values_mut() {
            if table.start_col > from_col {
                // Insertion is strictly before the table - shift entire table right
                table.start_col += count;
                table.end_col += count;
            } else if table.end_col >= from_col {
                // Insertion is inside the table (including at start_col) - expand
                table.end_col += count;
            }
        }
    }
}

/// Shift table boundaries when rows are deleted.
/// Tables fully within the deleted range are removed.
fn shift_table_boundaries_for_row_delete(state: &AppState, from_row: u32, count: u32, sheet_index: usize) {
    let mut tables = state.tables.lock().unwrap();
    let mut table_names = state.table_names.lock().unwrap();

    let delete_end = from_row + count;

    if let Some(sheet_tables) = tables.get_mut(&sheet_index) {
        // Collect IDs of tables to remove (fully within deleted range)
        let to_remove: Vec<u64> = sheet_tables
            .values()
            .filter(|t| t.start_row >= from_row && t.end_row < delete_end)
            .map(|t| t.id)
            .collect();

        // Remove from name registry
        for id in &to_remove {
            if let Some(table) = sheet_tables.get(id) {
                table_names.remove(&table.name.to_uppercase());
            }
        }

        // Remove fully deleted tables
        for id in &to_remove {
            sheet_tables.remove(id);
        }

        // Shift remaining table boundaries
        for table in sheet_tables.values_mut() {
            if table.start_row >= delete_end {
                // Entire table is below deleted range - shift up
                table.start_row -= count;
                table.end_row -= count;
            } else if table.start_row >= from_row {
                // Table starts within deleted range but extends beyond - shrink from top
                table.start_row = from_row;
                table.end_row -= count;
            } else if table.end_row >= delete_end {
                // Table spans entire deleted range - shrink
                table.end_row -= count;
            } else if table.end_row >= from_row {
                // Table end is within deleted range - shrink from bottom
                table.end_row = from_row.saturating_sub(1);
            }
        }
    }
}

/// Shift table boundaries when columns are deleted.
/// Tables fully within the deleted range are removed.
fn shift_table_boundaries_for_col_delete(state: &AppState, from_col: u32, count: u32, sheet_index: usize) {
    let mut tables = state.tables.lock().unwrap();
    let mut table_names = state.table_names.lock().unwrap();

    let delete_end = from_col + count;

    if let Some(sheet_tables) = tables.get_mut(&sheet_index) {
        // Collect IDs of tables to remove (fully within deleted range)
        let to_remove: Vec<u64> = sheet_tables
            .values()
            .filter(|t| t.start_col >= from_col && t.end_col < delete_end)
            .map(|t| t.id)
            .collect();

        // Remove from name registry
        for id in &to_remove {
            if let Some(table) = sheet_tables.get(id) {
                table_names.remove(&table.name.to_uppercase());
            }
        }

        // Remove fully deleted tables
        for id in &to_remove {
            sheet_tables.remove(id);
        }

        // Shift remaining table boundaries and truncate columns
        for table in sheet_tables.values_mut() {
            if table.start_col >= delete_end {
                // Entire table is right of deleted range - shift left
                table.start_col -= count;
                table.end_col -= count;
            } else if table.start_col >= from_col {
                // Table starts within deleted range but extends beyond - shrink from left
                let cols_removed = (delete_end - table.start_col) as usize;
                // Remove columns from the beginning
                for _ in 0..cols_removed.min(table.columns.len()) {
                    table.columns.remove(0);
                }
                table.start_col = from_col;
                table.end_col -= count;
            } else if table.end_col >= delete_end {
                // Table spans entire deleted range - shrink and remove middle columns
                let first_col_idx = (from_col - table.start_col) as usize;
                let cols_to_remove = count as usize;
                for _ in 0..cols_to_remove.min(table.columns.len().saturating_sub(first_col_idx)) {
                    if first_col_idx < table.columns.len() {
                        table.columns.remove(first_col_idx);
                    }
                }
                table.end_col -= count;
            } else if table.end_col >= from_col {
                // Table end is within deleted range - shrink from right
                let cols_to_remove = (table.end_col - from_col + 1) as usize;
                let keep_count = table.columns.len().saturating_sub(cols_to_remove);
                table.columns.truncate(keep_count);
                table.end_col = from_col.saturating_sub(1);
            }
        }
    }
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
/// Uses snapshot-based undo to restore the full grid state on undo.
#[tauri::command]
pub fn insert_rows(
    state: State<AppState>,
    file_state: State<FileState>,
    pivot_state: State<'_, PivotState>,
    row: u32,
    count: u32,
) -> Result<Vec<CellData>, String> {
    // Capture snapshot BEFORE acquiring other locks (helper acquires its own locks)
    let snapshot = capture_grid_snapshot(&state);

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

    // Record snapshot for undo
    undo_stack.begin_transaction(format!("Insert {} row(s)", count));
    undo_stack.record_snapshot(snapshot);
    undo_stack.commit_transaction();
    
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

    // === UPDATE TABLE BOUNDARIES ===
    shift_table_boundaries_for_row_insert(&state, row, count, active_sheet);

    // Re-acquire locks for result building
    let grid = state.grid.lock().map_err(|e| e.to_string())?;
    let styles = state.style_registry.lock().map_err(|e| e.to_string())?;
    let merged_regions = state.merged_regions.lock().map_err(|e| e.to_string())?;
    let locale = state.locale.lock().map_err(|e| e.to_string())?;

    // Return updated cells with merge info
    let mut result: Vec<CellData> = Vec::new();
    for r in 0..=grid.max_row {
        for c in 0..=grid.max_col {
            if let Some(cell_data) = get_cell_internal_with_merge(&grid, &styles, &merged_regions, r, c, &locale) {
                result.push(cell_data);
            }
        }
    }
    
    // Mark workbook as dirty
    if let Ok(mut modified) = file_state.is_modified.lock() { *modified = true; }

    Ok(result)
}

/// Insert columns at the specified position, shifting existing columns right.
/// Uses snapshot-based undo to restore the full grid state on undo.
#[tauri::command]
pub fn insert_columns(
    state: State<AppState>,
    file_state: State<FileState>,
    pivot_state: State<'_, PivotState>,
    col: u32,
    count: u32,
) -> Result<Vec<CellData>, String> {
    // Capture snapshot BEFORE acquiring other locks
    let snapshot = capture_grid_snapshot(&state);

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

    // Record snapshot for undo
    undo_stack.begin_transaction(format!("Insert {} column(s)", count));
    undo_stack.record_snapshot(snapshot);
    undo_stack.commit_transaction();
    
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

    // === UPDATE TABLE BOUNDARIES ===
    shift_table_boundaries_for_col_insert(&state, col, count, active_sheet);

    // Re-acquire locks for result building
    let grid = state.grid.lock().map_err(|e| e.to_string())?;
    let styles = state.style_registry.lock().map_err(|e| e.to_string())?;
    let merged_regions = state.merged_regions.lock().map_err(|e| e.to_string())?;
    let locale = state.locale.lock().map_err(|e| e.to_string())?;

    // Return updated cells with merge info
    let mut result: Vec<CellData> = Vec::new();
    for r in 0..=grid.max_row {
        for c in 0..=grid.max_col {
            if let Some(cell_data) = get_cell_internal_with_merge(&grid, &styles, &merged_regions, r, c, &locale) {
                result.push(cell_data);
            }
        }
    }

    // Mark workbook as dirty
    if let Ok(mut modified) = file_state.is_modified.lock() { *modified = true; }

    Ok(result)
}

// ============================================================================
// FORMULA REFERENCE SHIFTING (respects $ absolute markers)
// ============================================================================

/// Shift row references in a formula by a given amount.
/// Respects $ absolute markers - $5 won't be shifted, but 5 will.
pub fn shift_formula_row_references(formula: &str, from_row: u32, delta: i32) -> String {
    // Handle cell references (e.g., A5, $A$5, A$5, $A5)
    let result = CELL_REF_RE.replace_all(formula, |caps: &regex::Captures| {
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
    ROW_RANGE_RE.replace_all(&result, |caps: &regex::Captures| {
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
    let result = CELL_REF_RE.replace_all(formula, |caps: &regex::Captures| {
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
    COL_RANGE_RE.replace_all(&result, |caps: &regex::Captures| {
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

/// Convert a column letter string (e.g., "A", "AA", "AZ") to a 0-based index.
/// Extracted as a shared helper for formula manipulation functions.
fn col_letters_to_index(col: &str) -> u32 {
    let mut index: u32 = 0;
    for ch in col.to_uppercase().chars() {
        index = index * 26 + (ch as u32 - 'A' as u32 + 1);
    }
    index - 1
}

/// Normalize inverted ranges in a formula after reference shifting.
///
/// During fill operations, a relative reference can shift past an absolute
/// anchor, producing an inverted range where start > end. For example:
///   =SUM(I10:$I$11)  filled down by 3  -->  =SUM(I13:$I$11)   [row 13 > 11]
///
/// This function detects such inversions and swaps the two cell references
/// so the range is valid:
///   =SUM(I13:$I$11)  -->  =SUM($I$11:I13)
///
/// The $ (absolute) markers travel with their original reference, preserving
/// fill semantics for any future operations on the result.
fn normalize_inverted_ranges(formula: &str) -> String {
    CELL_RANGE_RE.replace_all(formula, |caps: &regex::Captures| {
        let s_col_abs = &caps[1];
        let s_col     = &caps[2];
        let s_row_abs = &caps[3];
        let s_row: u32 = caps[4].parse().unwrap_or(0);

        let e_col_abs = &caps[5];
        let e_col     = &caps[6];
        let e_row_abs = &caps[7];
        let e_row: u32 = caps[8].parse().unwrap_or(0);

        let s_col_idx = col_letters_to_index(s_col);
        let e_col_idx = col_letters_to_index(e_col);

        let row_inverted = s_row > e_row;
        let col_inverted = s_col_idx > e_col_idx;

        if row_inverted || col_inverted {
            // Swap the entire start and end cell references.
            //
            // During fill, only one axis shifts at a time (rows for vertical,
            // cols for horizontal), so inversion only occurs on one axis while
            // the other stays equal or correctly ordered.  A full swap is safe
            // because the non-inverted axis either:
            //   (a) has identical start/end values (e.g., I:I), or
            //   (b) was already correctly ordered and stays that way.
            //
            // The $ markers travel with their original reference, which is
            // correct: the fixed (absolute) part becomes the new start, and
            // the moving (relative) part becomes the new end.
            format!("{}{}{}{}:{}{}{}{}",
                e_col_abs, e_col, e_row_abs, e_row,
                s_col_abs, s_col, s_row_abs, s_row)
        } else {
            // Range is correctly ordered -- keep as-is
            caps[0].to_string()
        }
    }).to_string()
}

/// Shift formula references for fill handle operation.
/// This shifts references based on the fill direction and offset.
/// After shifting, inverted ranges (where start > end due to a relative
/// reference crossing past an absolute anchor) are normalized.
/// Exported for use by fill handle command.
#[tauri::command]
pub fn shift_formula_for_fill(
    formula: String,
    row_delta: i32,
    col_delta: i32,
) -> Result<String, String> {
    Ok(shift_formula_internal(&formula, row_delta, col_delta))
}

/// Internal function to shift a single formula (no Result wrapper).
fn shift_formula_internal(formula: &str, row_delta: i32, col_delta: i32) -> String {
    let mut result = formula.to_string();

    // Shift rows if there's a row delta
    if row_delta != 0 {
        result = shift_formula_row_references_for_fill(&result, row_delta);
    }

    // Shift columns if there's a column delta
    if col_delta != 0 {
        result = shift_formula_col_references_for_fill(&result, col_delta);
    }

    // Normalize any ranges that became inverted after shifting.
    // Example: I10:$I$11 shifted by +3 rows --> I13:$I$11 --> $I$11:I13
    normalize_inverted_ranges(&result)
}

/// Batch shift multiple formulas at once for fill operations.
/// This is significantly faster than calling shift_formula_for_fill multiple times
/// because it processes all formulas in a single IPC call.
#[tauri::command]
pub fn shift_formulas_batch(
    inputs: Vec<crate::api_types::FormulaShiftInput>,
) -> crate::api_types::FormulaShiftResult {
    let t0 = std::time::Instant::now();
    let formulas: Vec<String> = inputs
        .iter()
        .map(|input| shift_formula_internal(&input.formula, input.row_delta, input.col_delta))
        .collect();
    let dt = t0.elapsed();

    crate::logging::log_perf!("SHIFT",
        "shift_formulas_batch(N={}) | process={:.2}ms",
        inputs.len(), dt.as_secs_f64() * 1000.0
    );

    crate::api_types::FormulaShiftResult { formulas }
}

/// Shift row references for fill operation (all non-absolute refs shift).
fn shift_formula_row_references_for_fill(formula: &str, delta: i32) -> String {
    CELL_REF_RE.replace_all(formula, |caps: &regex::Captures| {
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
    
    CELL_REF_RE.replace_all(formula, |caps: &regex::Captures| {
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
/// Uses snapshot-based undo to restore the full grid state on undo.
#[tauri::command]
pub fn delete_rows(
    state: State<AppState>,
    file_state: State<FileState>,
    pivot_state: State<'_, PivotState>,
    row: u32,
    count: u32,
) -> Result<Vec<CellData>, String> {
    // Capture snapshot BEFORE acquiring other locks
    let snapshot = capture_grid_snapshot(&state);

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

    // Record snapshot for undo
    undo_stack.begin_transaction(format!("Delete {} row(s)", count));
    undo_stack.record_snapshot(snapshot);
    undo_stack.commit_transaction();
    
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

    // === UPDATE TABLE BOUNDARIES ===
    shift_table_boundaries_for_row_delete(&state, row, count, active_sheet);

    // Re-acquire locks for result building
    let grid = state.grid.lock().map_err(|e| e.to_string())?;
    let styles = state.style_registry.lock().map_err(|e| e.to_string())?;
    let merged_regions = state.merged_regions.lock().map_err(|e| e.to_string())?;
    let locale = state.locale.lock().map_err(|e| e.to_string())?;
    
    // Return updated cells with merge info
    let mut result: Vec<CellData> = Vec::new();
    for r in 0..=grid.max_row {
        for c in 0..=grid.max_col {
            if let Some(cell_data) = get_cell_internal_with_merge(&grid, &styles, &merged_regions, r, c, &locale) {
                result.push(cell_data);
            }
        }
    }
    
    // Mark workbook as dirty
    if let Ok(mut modified) = file_state.is_modified.lock() { *modified = true; }

    Ok(result)
}

/// Delete columns at the specified position, shifting remaining columns left.
/// Uses snapshot-based undo to restore the full grid state on undo.
#[tauri::command]
pub fn delete_columns(
    state: State<AppState>,
    file_state: State<FileState>,
    pivot_state: State<'_, PivotState>,
    col: u32,
    count: u32,
) -> Result<Vec<CellData>, String> {
    // Capture snapshot BEFORE acquiring other locks
    let snapshot = capture_grid_snapshot(&state);

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

    // Record snapshot for undo
    undo_stack.begin_transaction(format!("Delete {} column(s)", count));
    undo_stack.record_snapshot(snapshot);
    undo_stack.commit_transaction();
    
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

    // === UPDATE TABLE BOUNDARIES ===
    shift_table_boundaries_for_col_delete(&state, col, count, active_sheet);

    // Re-acquire locks for result building
    let grid = state.grid.lock().map_err(|e| e.to_string())?;
    let styles = state.style_registry.lock().map_err(|e| e.to_string())?;
    let merged_regions = state.merged_regions.lock().map_err(|e| e.to_string())?;
    let locale = state.locale.lock().map_err(|e| e.to_string())?;

    // Return updated cells with merge info
    let mut result: Vec<CellData> = Vec::new();
    for r in 0..=grid.max_row {
        for c in 0..=grid.max_col {
            if let Some(cell_data) = get_cell_internal_with_merge(&grid, &styles, &merged_regions, r, c, &locale) {
                result.push(cell_data);
            }
        }
    }

    // Mark workbook as dirty
    if let Ok(mut modified) = file_state.is_modified.lock() { *modified = true; }

    Ok(result)
}

// ============================================================================
// CELL REFERENCE RELOCATION (for drag-move operations)
// ============================================================================

/// Helper: convert a 0-based column index to letters (e.g., 0 -> "A", 25 -> "Z", 26 -> "AA").
fn index_to_col_letters(mut idx: u32) -> String {
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

/// Rewrite formula references that point into the source range so they point
/// to the destination range instead.  References outside the source range are
/// left untouched.  Absolute markers ($) are preserved.
///
/// `src_min_row` / `src_min_col` are 0-indexed grid coordinates.
/// Formula row numbers are 1-indexed (A1 style), so we add 1 when comparing.
fn relocate_references_in_formula(
    formula: &str,
    src_min_row: u32,
    src_min_col: u32,
    src_max_row: u32,
    src_max_col: u32,
    delta_row: i32,
    delta_col: i32,
) -> String {
    // First pass: cell range references (A1:B5) — must run before single cell refs
    let result = CELL_RANGE_RE.replace_all(formula, |caps: &regex::Captures| {
        let s_col_abs = &caps[1];
        let s_col = &caps[2];
        let s_row_abs = &caps[3];
        let s_row: u32 = caps[4].parse().unwrap_or(0);

        let e_col_abs = &caps[5];
        let e_col = &caps[6];
        let e_row_abs = &caps[7];
        let e_row: u32 = caps[8].parse().unwrap_or(0);

        let s_col_idx = col_letters_to_index(s_col);
        let e_col_idx = col_letters_to_index(e_col);

        // Check if both corners of the range are inside the source range
        // Row numbers in formulas are 1-indexed, grid is 0-indexed
        let s_in_range = s_row >= src_min_row + 1 && s_row <= src_max_row + 1
            && s_col_idx >= src_min_col && s_col_idx <= src_max_col;
        let e_in_range = e_row >= src_min_row + 1 && e_row <= src_max_row + 1
            && e_col_idx >= src_min_col && e_col_idx <= src_max_col;

        let new_s_row = if s_in_range { ((s_row as i32) + delta_row).max(1) as u32 } else { s_row };
        let new_s_col = if s_in_range { index_to_col_letters(((s_col_idx as i32) + delta_col).max(0) as u32) } else { s_col.to_string() };
        let new_e_row = if e_in_range { ((e_row as i32) + delta_row).max(1) as u32 } else { e_row };
        let new_e_col = if e_in_range { index_to_col_letters(((e_col_idx as i32) + delta_col).max(0) as u32) } else { e_col.to_string() };

        if !s_in_range && !e_in_range {
            caps[0].to_string()
        } else {
            format!("{}{}{}{}:{}{}{}{}",
                s_col_abs, new_s_col, s_row_abs, new_s_row,
                e_col_abs, new_e_col, e_row_abs, new_e_row)
        }
    }).to_string();

    // Second pass: single cell references (A1, $B$5, etc.)
    CELL_REF_RE.replace_all(&result, |caps: &regex::Captures| {
        let col_abs = &caps[1];
        let col_letters = &caps[2];
        let row_abs = &caps[3];
        let row_num: u32 = caps[4].parse().unwrap_or(0);

        let col_idx = col_letters_to_index(col_letters);

        // Check if this reference is inside the source range (row is 1-indexed)
        let in_range = row_num >= src_min_row + 1 && row_num <= src_max_row + 1
            && col_idx >= src_min_col && col_idx <= src_max_col;

        if in_range {
            let new_row = ((row_num as i32) + delta_row).max(1) as u32;
            let new_col = index_to_col_letters(((col_idx as i32) + delta_col).max(0) as u32);
            format!("{}{}{}{}", col_abs, new_col, row_abs, new_row)
        } else {
            caps[0].to_string()
        }
    }).to_string()
}

/// Relocate all formula references in the current sheet that point into the
/// source range, making them point to the destination instead.
///
/// This is called after a drag-move operation: the cell data has already been
/// moved from `(src_start_row, src_start_col)` to `(dest_start_row, dest_start_col)`,
/// but formulas on the sheet still reference the old coordinates.
///
/// Returns the list of cells whose formulas were rewritten (with updated values).
#[tauri::command]
pub fn relocate_cell_references(
    state: State<AppState>,
    user_files_state: State<crate::UserFilesState>,
    src_start_row: u32,
    src_start_col: u32,
    src_end_row: u32,
    src_end_col: u32,
    dest_start_row: u32,
    dest_start_col: u32,
) -> Result<Vec<CellData>, String> {
    let src_min_row = src_start_row.min(src_end_row);
    let src_max_row = src_start_row.max(src_end_row);
    let src_min_col = src_start_col.min(src_end_col);
    let src_max_col = src_start_col.max(src_end_col);

    let delta_row = dest_start_row as i32 - src_min_row as i32;
    let delta_col = dest_start_col as i32 - src_min_col as i32;

    if delta_row == 0 && delta_col == 0 {
        return Ok(Vec::new());
    }

    let sheet_names = state.sheet_names.lock().unwrap();
    let mut grid = state.grid.lock().unwrap();
    let mut grids = state.grids.lock().unwrap();
    let active_sheet = *state.active_sheet.lock().unwrap();
    let styles = state.style_registry.lock().unwrap();
    let merged_regions = state.merged_regions.lock().unwrap();
    let user_files = user_files_state.files.lock().unwrap();
    let mut dependents_map = state.dependents.lock().unwrap();
    let mut dependencies_map = state.dependencies.lock().unwrap();
    let mut column_dependents_map = state.column_dependents.lock().unwrap();
    let mut column_dependencies_map = state.column_dependencies.lock().unwrap();
    let mut row_dependents_map = state.row_dependents.lock().unwrap();
    let mut row_dependencies_map = state.row_dependencies.lock().unwrap();
    let mut cross_sheet_dependents_map = state.cross_sheet_dependents.lock().unwrap();
    let mut cross_sheet_dependencies_map = state.cross_sheet_dependencies.lock().unwrap();
    let mut undo_stack = state.undo_stack.lock().unwrap();
    let locale = state.locale.lock().unwrap();

    // Collect cells whose formulas reference the source range
    let dest_max_row = dest_start_row + (src_max_row - src_min_row);
    let dest_max_col = dest_start_col + (src_max_col - src_min_col);
    let mut rewrites: Vec<(u32, u32, String)> = Vec::new();

    for r in 0..=grid.max_row {
        for c in 0..=grid.max_col {
            // Skip cells that are IN the destination range (they were just written)
            if r >= dest_start_row && r <= dest_max_row
                && c >= dest_start_col && c <= dest_max_col
            {
                continue;
            }

            if let Some(cell) = grid.get_cell(r, c) {
                if let Some(ref formula) = cell.formula {
                    let new_formula = relocate_references_in_formula(
                        formula,
                        src_min_row,
                        src_min_col,
                        src_max_row,
                        src_max_col,
                        delta_row,
                        delta_col,
                    );
                    if new_formula != *formula {
                        rewrites.push((r, c, new_formula));
                    }
                }
            }
        }
    }

    // Apply rewrites
    let mut result: Vec<CellData> = Vec::new();

    for (r, c, new_formula) in &rewrites {
        // Record undo
        let prev = grid.get_cell(*r, *c).cloned();
        undo_stack.record_cell_change(*r, *c, prev.clone());

        // Preserve existing style
        let existing_style_index = prev.as_ref().map_or(0, |c| c.style_index);

        // Evaluate the new formula
        let cell_value = crate::evaluate_formula_multi_sheet_with_files(
            &grids,
            &sheet_names,
            active_sheet,
            new_formula,
            &user_files,
        );

        // Build new cell
        let mut new_cell = Cell {
            formula: Some(new_formula.clone()),
            value: cell_value,
            style_index: existing_style_index,
            rich_text: prev.as_ref().and_then(|c| c.rich_text.clone()),
            cached_ast: None,
        };

        // Parse the formula to extract references for dependency tracking
        if let Ok(parsed) = parser::parse(new_formula) {
            let refs = crate::extract_all_references(&parsed, &grid);

            crate::update_dependencies((*r, *c), refs.cells, &mut dependencies_map, &mut dependents_map);
            crate::update_column_dependencies((*r, *c), refs.columns, &mut column_dependencies_map, &mut column_dependents_map);
            crate::update_row_dependencies((*r, *c), refs.rows, &mut row_dependencies_map, &mut row_dependents_map);

            // Normalize cross-sheet refs
            let normalized_cross: HashSet<(String, u32, u32)> = refs
                .cross_sheet_cells
                .iter()
                .filter_map(|(parsed_name, cr, cc)| {
                    let normalized = sheet_names
                        .iter()
                        .find(|name| name.eq_ignore_ascii_case(parsed_name))
                        .cloned()
                        .unwrap_or_else(|| parsed_name.clone());
                    Some((normalized, *cr, *cc))
                })
                .collect();
            crate::update_cross_sheet_dependencies(
                (active_sheet, *r, *c),
                normalized_cross,
                &mut cross_sheet_dependencies_map,
                &mut cross_sheet_dependents_map,
            );

            // Cache the AST
            let engine_ast = crate::convert_expr(&parsed);
            new_cell.set_cached_ast(engine_ast);
        }

        grid.set_cell(*r, *c, new_cell.clone());
        if active_sheet < grids.len() {
            grids[active_sheet].set_cell(*r, *c, new_cell);
        }

        // Build CellData for result
        if let Some(cd) = get_cell_internal_with_merge(&grid, &styles, &merged_regions, *r, *c, &locale) {
            result.push(cd);
        }
    }

    Ok(result)
}