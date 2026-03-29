//! FILENAME: app/src-tauri/src/commands/print.rs
// PURPOSE: Tauri commands for page setup and print functionality.

use crate::api_types::{PageSetup, PrintData, CellData, MergedRegion, StyleData};
use crate::{AppState, format_cell_value};
use tauri::State;
use std::fs;

/// Get the page setup for the active sheet.
#[tauri::command]
pub fn get_page_setup(state: State<AppState>) -> PageSetup {
    let active_sheet = *state.active_sheet.lock().unwrap();
    let page_setups = state.page_setups.lock().unwrap();
    page_setups
        .get(active_sheet)
        .cloned()
        .unwrap_or_default()
}

/// Set the page setup for the active sheet.
#[tauri::command]
pub fn set_page_setup(
    state: State<AppState>,
    setup: PageSetup,
) -> Result<(), String> {
    let active_sheet = *state.active_sheet.lock().unwrap();
    let mut page_setups = state.page_setups.lock().unwrap();

    // Extend the vector if needed
    while page_setups.len() <= active_sheet {
        page_setups.push(PageSetup::default());
    }

    page_setups[active_sheet] = setup;
    Ok(())
}

/// Get all data needed for printing the active sheet.
/// Returns cell data, styles, dimensions, merged regions, and page setup.
#[tauri::command]
pub fn get_print_data(state: State<AppState>) -> Result<PrintData, String> {
    let active_sheet = *state.active_sheet.lock().unwrap();
    let grid = state.grid.lock().unwrap();
    let styles = state.style_registry.lock().unwrap();
    let merged_regions = state.merged_regions.lock().unwrap();
    let sheet_names = state.sheet_names.lock().unwrap();
    let page_setups = state.page_setups.lock().unwrap();
    let col_widths_map = state.column_widths.lock().unwrap();
    let row_heights_map = state.row_heights.lock().unwrap();

    let sheet_name = sheet_names
        .get(active_sheet)
        .cloned()
        .unwrap_or_else(|| format!("Sheet{}", active_sheet + 1));

    let page_setup = page_setups
        .get(active_sheet)
        .cloned()
        .unwrap_or_default();

    let max_row = grid.max_row;
    let max_col = grid.max_col;

    // Collect all cells with display values
    let mut cells = Vec::new();
    for (&(row, col), cell) in &grid.cells {
        let style = styles.get(cell.style_index);
        let display = format_cell_value(&cell.value, style);
        if display.is_empty() && cell.formula.is_none() {
            continue; // Skip truly empty cells
        }

        // Check merge info
        let merge_info = merged_regions
            .iter()
            .find(|r| r.start_row == row && r.start_col == col);
        let (row_span, col_span) = if let Some(region) = merge_info {
            (
                region.end_row - region.start_row + 1,
                region.end_col - region.start_col + 1,
            )
        } else {
            (1, 1)
        };

        cells.push(CellData {
            row,
            col,
            display,
            display_color: None,
            formula: cell.formula.clone(),
            style_index: cell.style_index,
            row_span,
            col_span,
            sheet_index: None,
        });
    }

    // Collect all styles using the From<&CellStyle> impl
    let style_count = styles.len();
    let mut style_list = Vec::with_capacity(style_count);
    for i in 0..style_count {
        let s = styles.get(i);
        style_list.push(StyleData::from(s));
    }

    // Collect column widths and row heights as arrays
    let mut col_widths = Vec::with_capacity((max_col + 1) as usize);
    for c in 0..=max_col {
        col_widths.push(*col_widths_map.get(&c).unwrap_or(&100.0));
    }

    let mut row_heights = Vec::with_capacity((max_row + 1) as usize);
    for r in 0..=max_row {
        row_heights.push(*row_heights_map.get(&r).unwrap_or(&24.0));
    }

    // Collect merged regions
    let merged: Vec<MergedRegion> = merged_regions
        .iter()
        .map(|r| MergedRegion {
            start_row: r.start_row,
            start_col: r.start_col,
            end_row: r.end_row,
            end_col: r.end_col,
        })
        .collect();

    Ok(PrintData {
        cells,
        styles: style_list,
        col_widths,
        row_heights,
        merged_regions: merged,
        page_setup,
        sheet_name,
        bounds: (max_row, max_col),
    })
}

/// Insert a manual row page break before the specified row.
#[tauri::command]
pub fn insert_row_page_break(state: State<AppState>, row: u32) -> Result<(), String> {
    let active_sheet = *state.active_sheet.lock().unwrap();
    let mut page_setups = state.page_setups.lock().unwrap();

    while page_setups.len() <= active_sheet {
        page_setups.push(PageSetup::default());
    }

    let setup = &mut page_setups[active_sheet];
    if !setup.manual_row_breaks.contains(&row) {
        setup.manual_row_breaks.push(row);
        setup.manual_row_breaks.sort();
    }
    Ok(())
}

/// Remove a manual row page break at the specified row.
#[tauri::command]
pub fn remove_row_page_break(state: State<AppState>, row: u32) -> Result<(), String> {
    let active_sheet = *state.active_sheet.lock().unwrap();
    let mut page_setups = state.page_setups.lock().unwrap();

    while page_setups.len() <= active_sheet {
        page_setups.push(PageSetup::default());
    }

    let setup = &mut page_setups[active_sheet];
    setup.manual_row_breaks.retain(|&r| r != row);
    Ok(())
}

/// Insert a manual column page break before the specified column.
#[tauri::command]
pub fn insert_col_page_break(state: State<AppState>, col: u32) -> Result<(), String> {
    let active_sheet = *state.active_sheet.lock().unwrap();
    let mut page_setups = state.page_setups.lock().unwrap();

    while page_setups.len() <= active_sheet {
        page_setups.push(PageSetup::default());
    }

    let setup = &mut page_setups[active_sheet];
    if !setup.manual_col_breaks.contains(&col) {
        setup.manual_col_breaks.push(col);
        setup.manual_col_breaks.sort();
    }
    Ok(())
}

/// Remove a manual column page break at the specified column.
#[tauri::command]
pub fn remove_col_page_break(state: State<AppState>, col: u32) -> Result<(), String> {
    let active_sheet = *state.active_sheet.lock().unwrap();
    let mut page_setups = state.page_setups.lock().unwrap();

    while page_setups.len() <= active_sheet {
        page_setups.push(PageSetup::default());
    }

    let setup = &mut page_setups[active_sheet];
    setup.manual_col_breaks.retain(|&c| c != col);
    Ok(())
}

/// Remove all manual page breaks for the active sheet.
#[tauri::command]
pub fn reset_all_page_breaks(state: State<AppState>) -> Result<(), String> {
    let active_sheet = *state.active_sheet.lock().unwrap();
    let mut page_setups = state.page_setups.lock().unwrap();

    while page_setups.len() <= active_sheet {
        page_setups.push(PageSetup::default());
    }

    let setup = &mut page_setups[active_sheet];
    setup.manual_row_breaks.clear();
    setup.manual_col_breaks.clear();
    Ok(())
}

/// Write binary data to a file on disk.
/// Used by PDF export to save the generated PDF.
#[tauri::command]
pub fn write_binary_file(path: String, data: Vec<u8>) -> Result<(), String> {
    fs::write(&path, &data).map_err(|e| format!("Failed to write file '{}': {}", path, e))
}
