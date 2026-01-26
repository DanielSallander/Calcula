// PURPOSE: Helper functions shared between different command modules.

use crate::api_types::{CellData, MergedRegion};
use crate::format_cell_value;
use engine::{Grid, StyleRegistry};
use std::collections::HashSet;

/// Internal helper for getting cell data with merge span information.
/// Shared across data, structure, and style commands.
pub(crate) fn get_cell_internal_with_merge(
    grid: &Grid,
    styles: &StyleRegistry,
    merged_regions: &HashSet<MergedRegion>,
    row: u32,
    col: u32,
) -> Option<CellData> {
    // Check if this cell is the master of a merged region
    let merge_info = merged_regions.iter().find(|r| r.start_row == row && r.start_col == col);
    
    let (row_span, col_span) = if let Some(region) = merge_info {
        (
            region.end_row - region.start_row + 1,
            region.end_col - region.start_col + 1,
        )
    } else {
        (1, 1)
    };

    // For master cells, get the cell data
    // For cells that don't exist but are masters of empty merges, return empty display
    let cell = grid.get_cell(row, col);
    
    if cell.is_none() && row_span == 1 && col_span == 1 {
        // No cell and not a merge master - return None
        return None;
    }

    let (display, formula, style_index) = if let Some(c) = cell {
        let style = styles.get(c.style_index);
        (format_cell_value(&c.value, style), c.formula.clone(), c.style_index)
    } else {
        // Empty merge master
        (String::new(), None, 0)
    };

    Some(CellData {
        row,
        col,
        display,
        formula,
        style_index,
        row_span,
        col_span,
    })
}