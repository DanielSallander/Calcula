//! FILENAME: app/src-tauri/src/sparkline_commands.rs
//! Tauri commands for sparkline persistence.
//! Sparkline groups are stored as opaque JSON blobs (SparklineEntry) in AppState,
//! keyed by sheet index.

use crate::api_types::SparklineEntry;
use crate::AppState;
use tauri::State;

/// Get all sparkline entries (all sheets).
#[tauri::command]
pub fn get_sparklines(state: State<AppState>) -> Vec<SparklineEntry> {
    state.sparklines.lock().unwrap().clone()
}

/// Save sparkline groups for a specific sheet (upsert by sheet_index).
#[tauri::command]
pub fn save_sparklines(state: State<AppState>, entry: SparklineEntry) -> Result<(), String> {
    let mut sparklines = state.sparklines.lock().map_err(|e| e.to_string())?;
    if let Some(existing) = sparklines
        .iter_mut()
        .find(|s| s.sheet_index == entry.sheet_index)
    {
        *existing = entry;
    } else {
        sparklines.push(entry);
    }
    Ok(())
}

/// Delete sparkline data for a specific sheet.
#[tauri::command]
pub fn delete_sparklines(state: State<AppState>, sheet_index: usize) -> Result<(), String> {
    let mut sparklines = state.sparklines.lock().map_err(|e| e.to_string())?;
    sparklines.retain(|s| s.sheet_index != sheet_index);
    Ok(())
}

/// Clear all sparkline data (all sheets).
#[tauri::command]
pub fn clear_all_sparklines(state: State<AppState>) -> Result<(), String> {
    let mut sparklines = state.sparklines.lock().map_err(|e| e.to_string())?;
    sparklines.clear();
    Ok(())
}
