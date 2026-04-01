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
            rich_text: None,
        });
    }

    // Collect all styles resolved against the active theme
    let theme = state.theme.lock().unwrap();
    let style_count = styles.len();
    let mut style_list = Vec::with_capacity(style_count);
    for i in 0..style_count {
        let s = styles.get(i);
        style_list.push(StyleData::from_cell_style(s, &theme));
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

/// Set the print area from a selection range.
/// Takes start_row, start_col, end_row, end_col (0-based) and converts to "A1:F20" format.
#[tauri::command]
pub fn set_print_area(
    state: State<AppState>,
    start_row: u32,
    start_col: u32,
    end_row: u32,
    end_col: u32,
) -> Result<String, String> {
    if start_row > end_row || start_col > end_col {
        return Err("Invalid range: start must be <= end".to_string());
    }

    let range_str = format!(
        "{}{}:{}{}",
        col_index_to_letter(start_col),
        start_row + 1,
        col_index_to_letter(end_col),
        end_row + 1,
    );

    let active_sheet = *state.active_sheet.lock().unwrap();
    let mut page_setups = state.page_setups.lock().unwrap();

    while page_setups.len() <= active_sheet {
        page_setups.push(PageSetup::default());
    }

    page_setups[active_sheet].print_area = range_str.clone();
    Ok(range_str)
}

/// Clear the print area for the active sheet.
#[tauri::command]
pub fn clear_print_area(state: State<AppState>) -> Result<(), String> {
    let active_sheet = *state.active_sheet.lock().unwrap();
    let mut page_setups = state.page_setups.lock().unwrap();

    while page_setups.len() <= active_sheet {
        page_setups.push(PageSetup::default());
    }

    page_setups[active_sheet].print_area = String::new();
    Ok(())
}

/// Set print title rows (rows to repeat at top of each printed page).
/// Takes start_row and end_row (0-based) and converts to "1:5" format.
#[tauri::command]
pub fn set_print_title_rows(
    state: State<AppState>,
    start_row: u32,
    end_row: u32,
) -> Result<String, String> {
    if start_row > end_row {
        return Err("Invalid range: start_row must be <= end_row".to_string());
    }

    let title_str = format!("{}:{}", start_row + 1, end_row + 1);

    let active_sheet = *state.active_sheet.lock().unwrap();
    let mut page_setups = state.page_setups.lock().unwrap();

    while page_setups.len() <= active_sheet {
        page_setups.push(PageSetup::default());
    }

    page_setups[active_sheet].print_titles_rows = title_str.clone();
    Ok(title_str)
}

/// Clear print title rows for the active sheet.
#[tauri::command]
pub fn clear_print_title_rows(state: State<AppState>) -> Result<(), String> {
    let active_sheet = *state.active_sheet.lock().unwrap();
    let mut page_setups = state.page_setups.lock().unwrap();

    while page_setups.len() <= active_sheet {
        page_setups.push(PageSetup::default());
    }

    page_setups[active_sheet].print_titles_rows = String::new();
    Ok(())
}

/// Set print title columns (columns to repeat at left of each printed page).
/// Takes start_col and end_col (0-based) and converts to "A:C" format.
#[tauri::command]
pub fn set_print_title_cols(
    state: State<AppState>,
    start_col: u32,
    end_col: u32,
) -> Result<String, String> {
    if start_col > end_col {
        return Err("Invalid range: start_col must be <= end_col".to_string());
    }

    let title_str = format!(
        "{}:{}",
        col_index_to_letter(start_col),
        col_index_to_letter(end_col),
    );

    let active_sheet = *state.active_sheet.lock().unwrap();
    let mut page_setups = state.page_setups.lock().unwrap();

    while page_setups.len() <= active_sheet {
        page_setups.push(PageSetup::default());
    }

    page_setups[active_sheet].print_titles_cols = title_str.clone();
    Ok(title_str)
}

/// Clear print title columns for the active sheet.
#[tauri::command]
pub fn clear_print_title_cols(state: State<AppState>) -> Result<(), String> {
    let active_sheet = *state.active_sheet.lock().unwrap();
    let mut page_setups = state.page_setups.lock().unwrap();

    while page_setups.len() <= active_sheet {
        page_setups.push(PageSetup::default());
    }

    page_setups[active_sheet].print_titles_cols = String::new();
    Ok(())
}

/// Move a manual page break from one position to another.
/// Used by the drag-to-move feature in page break preview.
#[tauri::command]
pub fn move_page_break(
    state: State<AppState>,
    direction: String,
    from_index: u32,
    to_index: u32,
) -> Result<(), String> {
    if to_index == 0 {
        return Err("Cannot move page break to position 0".to_string());
    }

    let active_sheet = *state.active_sheet.lock().unwrap();
    let mut page_setups = state.page_setups.lock().unwrap();

    while page_setups.len() <= active_sheet {
        page_setups.push(PageSetup::default());
    }

    let setup = &mut page_setups[active_sheet];

    match direction.as_str() {
        "row" => {
            setup.manual_row_breaks.retain(|&r| r != from_index);
            if !setup.manual_row_breaks.contains(&to_index) {
                setup.manual_row_breaks.push(to_index);
                setup.manual_row_breaks.sort();
            }
        }
        "col" => {
            setup.manual_col_breaks.retain(|&c| c != from_index);
            if !setup.manual_col_breaks.contains(&to_index) {
                setup.manual_col_breaks.push(to_index);
                setup.manual_col_breaks.sort();
            }
        }
        _ => return Err(format!("Invalid direction '{}': must be 'row' or 'col'", direction)),
    }

    Ok(())
}

/// Convert a 0-based column index to letter(s): 0->"A", 25->"Z", 26->"AA", etc.
fn col_index_to_letter(index: u32) -> String {
    let mut result = String::new();
    let mut n = index as i64;
    loop {
        let remainder = (n % 26) as u8;
        result.insert(0, (b'A' + remainder) as char);
        n = n / 26 - 1;
        if n < 0 {
            break;
        }
    }
    result
}

/// Write binary data to a file on disk.
/// Used by PDF export to save the generated PDF.
#[tauri::command]
pub fn write_binary_file(path: String, data: Vec<u8>) -> Result<(), String> {
    fs::write(&path, &data).map_err(|e| format!("Failed to write file '{}': {}", path, e))
}

// ============================================================================
// Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_col_index_to_letter_single() {
        assert_eq!(col_index_to_letter(0), "A");
        assert_eq!(col_index_to_letter(1), "B");
        assert_eq!(col_index_to_letter(25), "Z");
    }

    #[test]
    fn test_col_index_to_letter_double() {
        assert_eq!(col_index_to_letter(26), "AA");
        assert_eq!(col_index_to_letter(27), "AB");
        assert_eq!(col_index_to_letter(51), "AZ");
        assert_eq!(col_index_to_letter(52), "BA");
        assert_eq!(col_index_to_letter(701), "ZZ");
    }

    #[test]
    fn test_col_index_to_letter_triple() {
        assert_eq!(col_index_to_letter(702), "AAA");
        assert_eq!(col_index_to_letter(703), "AAB");
    }

    #[test]
    fn test_page_setup_default() {
        let setup = PageSetup::default();
        assert_eq!(setup.print_area, "");
        assert_eq!(setup.print_titles_rows, "");
        assert_eq!(setup.print_titles_cols, "");
        assert!(setup.manual_row_breaks.is_empty());
        assert!(setup.manual_col_breaks.is_empty());
        assert_eq!(setup.paper_size, "a4");
        assert_eq!(setup.orientation, "portrait");
        assert_eq!(setup.scale, 100);
    }
}
