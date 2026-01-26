// PURPOSE: Managing row heights and column widths.

use crate::api_types::DimensionData;
use crate::AppState;
use tauri::State;

/// Set a column width.
#[tauri::command]
pub fn set_column_width(state: State<AppState>, col: u32, width: f64) {
    let mut widths = state.column_widths.lock().unwrap();
    let mut undo_stack = state.undo_stack.lock().unwrap();

    // Record previous state for undo
    let previous_width = widths.get(&col).copied();

    if width > 0.0 {
        widths.insert(col, width);
    } else {
        widths.remove(&col);
    }

    // Record undo
    undo_stack.record_column_width_change(col, previous_width);
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
    let mut undo_stack = state.undo_stack.lock().unwrap();

    // Record previous state for undo
    let previous_height = heights.get(&row).copied();

    if height > 0.0 {
        heights.insert(row, height);
    } else {
        heights.remove(&row);
    }

    // Record undo
    undo_stack.record_row_height_change(row, previous_height);
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