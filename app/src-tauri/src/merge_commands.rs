//! FILENAME: app/src-tauri/src/merge_commands.rs
// PURPOSE: Tauri commands for cell merge operations.
// CONTEXT: Handles merging and unmerging cells in the spreadsheet.

use crate::api_types::{CellData, MergedRegion, MergeResult};
use crate::{format_cell_value, AppState};
use std::collections::HashSet;
use tauri::State;

/// Merge cells in the specified range.
/// The top-left cell becomes the "master" cell containing the merged content.
/// All other cells in the range are cleared.
#[tauri::command]
pub fn merge_cells(
    state: State<AppState>,
    start_row: u32,
    start_col: u32,
    end_row: u32,
    end_col: u32,
) -> Result<MergeResult, String> {
    let mut grid = state.grid.lock().map_err(|e| e.to_string())?;
    let mut grids = state.grids.lock().map_err(|e| e.to_string())?;
    let active_sheet = *state.active_sheet.lock().map_err(|e| e.to_string())?;
    let styles = state.style_registry.lock().map_err(|e| e.to_string())?;
    let mut merged_regions = state.merged_regions.lock().map_err(|e| e.to_string())?;

    // Normalize coordinates (ensure start <= end)
    let min_row = start_row.min(end_row);
    let max_row = start_row.max(end_row);
    let min_col = start_col.min(end_col);
    let max_col = start_col.max(end_col);

    // Check if single cell - nothing to merge
    if min_row == max_row && min_col == max_col {
        return Ok(MergeResult {
            success: false,
            merged_regions: merged_regions.iter().cloned().collect(),
            updated_cells: Vec::new(),
        });
    }

    // Check for overlapping merges
    for region in merged_regions.iter() {
        let overlaps = !(max_row < region.start_row
            || min_row > region.end_row
            || max_col < region.start_col
            || min_col > region.end_col);
        if overlaps {
            return Err("Cannot merge: selection overlaps with existing merged region".to_string());
        }
    }

    // Create the new merged region
    let new_region = MergedRegion {
        start_row: min_row,
        start_col: min_col,
        end_row: max_row,
        end_col: max_col,
    };

    // Get the master cell content (top-left)
    let master_cell = grid.get_cell(min_row, min_col).cloned();
    let master_style_index = master_cell.as_ref().map(|c| c.style_index).unwrap_or(0);

    // Clear all cells in the range except the master
    let mut updated_cells = Vec::new();
    for row in min_row..=max_row {
        for col in min_col..=max_col {
            if row == min_row && col == min_col {
                // Master cell - keep content, will be returned with spans
                continue;
            }
            // Clear slave cells
            grid.clear_cell(row, col);
            if active_sheet < grids.len() {
                grids[active_sheet].clear_cell(row, col);
            }
        }
    }

    // Add the merged region
    merged_regions.insert(new_region.clone());

    // Return the master cell with span info
    let style = styles.get(master_style_index);
    let display = master_cell
        .as_ref()
        .map(|c| format_cell_value(&c.value, style))
        .unwrap_or_default();

    updated_cells.push(CellData {
        row: min_row,
        col: min_col,
        display,
        formula: master_cell.as_ref().and_then(|c| c.formula.clone()),
        style_index: master_style_index,
        row_span: max_row - min_row + 1,
        col_span: max_col - min_col + 1,
        sheet_index: None,
    });

    Ok(MergeResult {
        success: true,
        merged_regions: merged_regions.iter().cloned().collect(),
        updated_cells,
    })
}

/// Unmerge cells at the specified position.
/// If the cell is part of a merged region, the region is dissolved.
#[tauri::command]
pub fn unmerge_cells(
    state: State<AppState>,
    row: u32,
    col: u32,
) -> Result<MergeResult, String> {
    let grid = state.grid.lock().map_err(|e| e.to_string())?;
    let styles = state.style_registry.lock().map_err(|e| e.to_string())?;
    let mut merged_regions = state.merged_regions.lock().map_err(|e| e.to_string())?;

    // Find the merged region containing this cell
    let region_to_remove = merged_regions
        .iter()
        .find(|r| row >= r.start_row && row <= r.end_row && col >= r.start_col && col <= r.end_col)
        .cloned();

    if let Some(region) = region_to_remove {
        merged_regions.remove(&region);

        // Return the master cell with span reset to 1
        let master_cell = grid.get_cell(region.start_row, region.start_col).cloned();
        let master_style_index = master_cell.as_ref().map(|c| c.style_index).unwrap_or(0);
        let style = styles.get(master_style_index);
        let display = master_cell
            .as_ref()
            .map(|c| format_cell_value(&c.value, style))
            .unwrap_or_default();

        let updated_cells = vec![CellData {
            row: region.start_row,
            col: region.start_col,
            display,
            formula: master_cell.as_ref().and_then(|c| c.formula.clone()),
            style_index: master_style_index,
            row_span: 1,
            col_span: 1,
            sheet_index: None,
        }];

        Ok(MergeResult {
            success: true,
            merged_regions: merged_regions.iter().cloned().collect(),
            updated_cells,
        })
    } else {
        Ok(MergeResult {
            success: false,
            merged_regions: merged_regions.iter().cloned().collect(),
            updated_cells: Vec::new(),
        })
    }
}

/// Get all merged regions for the current sheet.
#[tauri::command]
pub fn get_merged_regions(state: State<AppState>) -> Result<Vec<MergedRegion>, String> {
    let merged_regions = state.merged_regions.lock().map_err(|e| e.to_string())?;
    Ok(merged_regions.iter().cloned().collect())
}

/// Check if a cell is part of a merged region.
/// Returns the master cell's coordinates and span if it is.
#[tauri::command]
pub fn get_merge_info(
    state: State<AppState>,
    row: u32,
    col: u32,
) -> Result<Option<MergedRegion>, String> {
    let merged_regions = state.merged_regions.lock().map_err(|e| e.to_string())?;

    let region = merged_regions
        .iter()
        .find(|r| row >= r.start_row && row <= r.end_row && col >= r.start_col && col <= r.end_col)
        .cloned();

    Ok(region)
}