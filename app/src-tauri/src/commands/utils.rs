//! FILENAME: app/src-tauri/src/commands/utils.rs
// PURPOSE: Helper functions shared between different command modules.

use crate::api_types::{AccountingLayout, CellData, MergedRegion};
use crate::format_cell_value_with_color;
use engine::{Grid, LocaleSettings, StyleRegistry, localize_formula};
use std::collections::HashSet;

/// Internal helper for getting cell data with merge span information.
/// Shared across data, structure, and style commands.
pub(crate) fn get_cell_internal_with_merge(
    grid: &Grid,
    styles: &StyleRegistry,
    merged_regions: &HashSet<MergedRegion>,
    row: u32,
    col: u32,
    locale: &LocaleSettings,
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

    // The style that actually applies here, honouring the row/column tiers.
    // Resolved once and used for BOTH value formatting and the index handed to
    // the frontend, so callers stay unaware of the tiers.
    let effective_style_index = grid.effective_style_index(row, col);

    if cell.is_none() && row_span == 1 && col_span == 1 && effective_style_index == 0 {
        // No cell, not a merge master, and no row/column style gives it an
        // appearance - return None
        return None;
    }

    let (display, display_color, formula, style_index, rich_text, accounting_layout) = if let Some(c) = cell {
        let style = styles.get(effective_style_index);
        let result = format_cell_value_with_color(&c.value, style, locale);
        let rt = c
            .rich_text
            .as_ref()
            .map(|runs| crate::api_types::rich_text_runs_to_data(runs));
        let acct = result.accounting.map(|a| AccountingLayout {
            symbol: a.symbol,
            symbol_before: a.symbol_before,
            value: a.value,
        });
        let localized_formula = c.formula_string().map(|f| format!("={}", localize_formula(&f, locale)));
        (result.text, result.color, localized_formula, effective_style_index, rt, acct)
    } else {
        // Empty merge master, or an empty cell that a row/column style reaches
        (String::new(), None, None, effective_style_index, None, None)
    };

    Some(CellData {
        row,
        col,
        display,
        display_color,
        formula,
        style_index,
        row_span,
        col_span,
        sheet_index: None,
        rich_text,
        accounting_layout,
    })
}
