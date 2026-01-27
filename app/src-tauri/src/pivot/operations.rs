//! FILENAME: app/src-tauri/src/pivot/operations.rs
use crate::pivot::utils::col_index_to_letter;
use crate::{log_debug, log_info, AppState, PivotRegion};
use engine::pivot::{calculate_pivot, PivotCache, PivotDefinition, PivotId, PivotView};
use engine::{Cell, CellValue};

// ============================================================================
// CONSTANTS
// ============================================================================

/// Minimum reserved rows for an empty pivot table placeholder
const EMPTY_PIVOT_ROWS: u32 = 18;
/// Minimum reserved columns for an empty pivot table placeholder
const EMPTY_PIVOT_COLS: u32 = 3;

// ============================================================================
// GRID & LOGIC OPERATIONS
// ============================================================================

/// Creates an empty pivot view for when no fields are configured
pub(crate) fn create_empty_view(pivot_id: PivotId, version: u64) -> PivotView {
    PivotView {
        pivot_id,
        version,
        row_count: 0,
        col_count: 0,
        row_label_col_count: 0,
        column_header_row_count: 0,
        cells: Vec::new(),
        rows: Vec::new(),
        columns: Vec::new(),
        is_windowed: false,
        total_row_count: None,
        window_start_row: None,
    }
}

/// Check if the pivot definition has any fields configured
pub(crate) fn has_fields_configured(definition: &PivotDefinition) -> bool {
    !definition.row_fields.is_empty() 
        || !definition.column_fields.is_empty() 
        || !definition.value_fields.is_empty()
}

/// Safely calculate pivot - returns empty view if no fields configured
pub(crate) fn safe_calculate_pivot(definition: &PivotDefinition, cache: &mut PivotCache) -> PivotView {
    if !has_fields_configured(definition) {
        log_debug!("PIVOT", "No fields configured, returning empty view");
        return create_empty_view(definition.id, definition.version);
    }
    calculate_pivot(definition, cache)
}

/// Builds a PivotCache from grid data
pub(crate) fn build_cache_from_grid(
    grid: &engine::Grid,
    start: (u32, u32),
    end: (u32, u32),
    has_headers: bool,
) -> Result<(PivotCache, Vec<String>), String> {
    let (start_row, start_col) = start;
    let (end_row, end_col) = end;
    
    let col_count = (end_col - start_col + 1) as usize;
    let data_start_row = if has_headers { start_row + 1 } else { start_row };
    
    // Extract headers
    let headers: Vec<String> = if has_headers {
        (start_col..=end_col)
            .map(|c| {
                grid.get_cell(start_row, c)
                    .map(|cell| cell.display_value())
                    .unwrap_or_else(|| col_index_to_letter(c - start_col))
            })
            .collect()
    } else {
        (0..col_count)
            .map(|i| col_index_to_letter(i as u32))
            .collect()
    };
    
    // Create cache
    let mut cache = PivotCache::new(1, col_count);
    
    // Set field names
    for (i, name) in headers.iter().enumerate() {
        cache.set_field_name(i, name.clone());
    }
    
    // Add records
    for row in data_start_row..=end_row {
        let mut values: Vec<CellValue> = Vec::with_capacity(col_count);
        
        for col in start_col..=end_col {
            let value = grid
                .get_cell(row, col)
                .map(|cell| cell.value.clone())
                .unwrap_or(CellValue::Empty);
            values.push(value);
        }
        
        // source_row is u32
        cache.add_record(row - data_start_row, &values);
    }
    
    Ok((cache, headers))
}

/// Resolves the destination sheet index from a pivot definition.
/// Falls back to active sheet if destination_sheet is not set or not found.
pub(crate) fn resolve_dest_sheet_index(state: &AppState, definition: &PivotDefinition) -> usize {
    if let Some(ref sheet_name) = definition.destination_sheet {
        let sheet_names = state.sheet_names.lock().unwrap();
        for (idx, name) in sheet_names.iter().enumerate() {
            if name == sheet_name {
                return idx;
            }
        }
    }
    // Fallback to active sheet
    *state.active_sheet.lock().unwrap()
}

/// Clears cells in a pivot region from the grid.
pub(crate) fn clear_pivot_region_from_grid(
    grid: &mut engine::Grid,
    start_row: u32,
    start_col: u32,
    end_row: u32,
    end_col: u32,
) {
    log_debug!(
        "PIVOT",
        "clear_pivot_region_from_grid: ({},{}) to ({},{})",
        start_row,
        start_col,
        end_row,
        end_col
    );
    
    for row in start_row..=end_row {
        for col in start_col..=end_col {
            grid.clear_cell(row, col);
        }
    }
}

/// Gets the current pivot region for a pivot ID, if it exists.
pub(crate) fn get_pivot_region(state: &AppState, pivot_id: PivotId) -> Option<PivotRegion> {
    let regions = state.pivot_regions.lock().unwrap();
    regions.iter().find(|r| r.pivot_id == pivot_id).cloned()
}

/// Writes pivot view cells to the destination grid
pub(crate) fn write_pivot_to_grid(
    grid: &mut engine::Grid,
    view: &PivotView,
    destination: (u32, u32),
) {
    let (dest_row, dest_col) = destination;
    
    log_debug!(
        "PIVOT",
        "write_pivot_to_grid: dest=({},{}) view_size={}x{}",
        dest_row,
        dest_col,
        view.row_count,
        view.col_count
    );
    
    // If view is empty, nothing to write
    if view.row_count == 0 || view.col_count == 0 {
        log_debug!("PIVOT", "Empty view, nothing to write to grid");
        return;
    }
    
    // Iterate through all rows (not just visible, since we need grid positions to be correct)
    for (row_idx, row_descriptor) in view.rows.iter().enumerate() {
        if !row_descriptor.visible {
            continue;
        }
        
        // Get the cells for this row
        if row_idx >= view.cells.len() {
            continue;
        }
        let row_cells = &view.cells[row_idx];
        
        for (col_idx, pivot_cell) in row_cells.iter().enumerate() {
            let grid_row = dest_row + row_idx as u32;
            let grid_col = dest_col + col_idx as u32;
            
            // Use formatted_value for display if available, otherwise use the raw value
            let display_text = if !pivot_cell.formatted_value.is_empty() {
                pivot_cell.formatted_value.clone()
            } else {
                match &pivot_cell.value {
                    engine::pivot::PivotCellValue::Empty => String::new(),
                    engine::pivot::PivotCellValue::Number(n) => n.to_string(),
                    engine::pivot::PivotCellValue::Text(s) => s.clone(),
                    engine::pivot::PivotCellValue::Boolean(b) => if *b { "TRUE".to_string() } else { "FALSE".to_string() },
                    engine::pivot::PivotCellValue::Error(e) => format!("#{}", e),
                }
            };
            
            // Create the cell - for now we use text cells with the formatted value
            let cell = if display_text.is_empty() {
                Cell::new()
            } else {
                Cell::new_text(display_text)
            };
            
            grid.set_cell(grid_row, grid_col, cell);
        }
    }
    
    log_debug!(
        "PIVOT",
        "write_pivot_to_grid: wrote {} rows to grid",
        view.rows.iter().filter(|r| r.visible).count()
    );
}

/// Updates the pivot region tracking for a pivot table.
pub(crate) fn update_pivot_region(
    state: &AppState,
    pivot_id: PivotId,
    sheet_index: usize,
    destination: (u32, u32),
    view: &PivotView,
) {
    let mut regions = state.pivot_regions.lock().unwrap();
    
    // Remove any existing region for this pivot
    regions.retain(|r| r.pivot_id != pivot_id);
    
    let (dest_row, dest_col) = destination;
    
    // Calculate region size - use actual view size or minimum reserved size for empty pivots
    let (end_row, end_col) = if view.row_count > 0 && view.col_count > 0 {
        // Count all rows in the view (headers + data)
        let total_rows = view.row_count as u32;
        let total_cols = view.col_count as u32;
        (
            dest_row + total_rows.saturating_sub(1),
            dest_col + total_cols.saturating_sub(1),
        )
    } else {
        // Empty pivot - reserve minimum space for placeholder
        (
            dest_row + EMPTY_PIVOT_ROWS - 1,
            dest_col + EMPTY_PIVOT_COLS - 1,
        )
    };
    
    regions.push(PivotRegion {
        pivot_id,
        sheet_index,
        start_row: dest_row,
        start_col: dest_col,
        end_row,
        end_col,
    });
    
    log_debug!(
        "PIVOT",
        "updated pivot region: id={} sheet={} ({},{}) to ({},{}) empty={}",
        pivot_id,
        sheet_index,
        dest_row,
        dest_col,
        end_row,
        end_col,
        view.row_count == 0
    );
}

/// Clears the old pivot region and writes the new view to the grid.
/// Also syncs to state.grid if needed.
pub(crate) fn update_pivot_in_grid(
    state: &AppState,
    pivot_id: PivotId,
    dest_sheet_idx: usize,
    destination: (u32, u32),
    view: &PivotView,
) {
    // Get old region before writing new data
    let old_region = get_pivot_region(state, pivot_id);
    
    let mut grids = state.grids.lock().unwrap();
    if let Some(dest_grid) = grids.get_mut(dest_sheet_idx) {
        // Clear old pivot area first if it exists
        if let Some(ref region) = old_region {
            if region.sheet_index == dest_sheet_idx {
                clear_pivot_region_from_grid(
                    dest_grid,
                    region.start_row,
                    region.start_col,
                    region.end_row,
                    region.end_col,
                );
            }
        }
        
        // Write new pivot data
        write_pivot_to_grid(dest_grid, view, destination);
        
        // Sync to state.grid if this is the active sheet
        let active_sheet = *state.active_sheet.lock().unwrap();
        if dest_sheet_idx == active_sheet {
            let mut grid = state.grid.lock().unwrap();
            
            // If we cleared old region, clear it from state.grid too
            if let Some(ref region) = old_region {
                if region.sheet_index == dest_sheet_idx {
                    for row in region.start_row..=region.end_row {
                        for col in region.start_col..=region.end_col {
                            grid.clear_cell(row, col);
                        }
                    }
                }
            }
            
            // Copy new cells to state.grid
            for ((r, c), cell) in dest_grid.cells.iter() {
                grid.set_cell(*r, *c, cell.clone());
            }
            grid.recalculate_bounds();
            log_debug!("PIVOT", "synced pivot cells to state.grid (active sheet)");
        }
    }
}