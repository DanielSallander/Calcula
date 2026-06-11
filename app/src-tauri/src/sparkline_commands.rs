//! FILENAME: app/src-tauri/src/sparkline_commands.rs
//! Tauri commands for sparkline persistence.
//! Sparkline groups are stored as opaque JSON blobs (SparklineEntry) in AppState,
//! keyed by sheet index.
//! All mutations record obj_sparklines undo snapshots (BUG-0002: sparkline
//! lifecycle used to bypass the undo system entirely).

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
    let sheet_index = entry.sheet_index;
    let previous = {
        let mut sparklines = state.sparklines.lock().map_err(|e| e.to_string())?;
        let previous = sparklines
            .iter()
            .find(|s| s.sheet_index == sheet_index)
            .map(|s| s.groups_json.clone());
        if let Some(existing) = sparklines
            .iter_mut()
            .find(|s| s.sheet_index == sheet_index)
        {
            *existing = entry;
        } else {
            sparklines.push(entry);
        }
        previous
    };
    crate::undo_commands::record_sparklines_undo(&state, sheet_index, previous, "Edit sparklines");
    Ok(())
}

/// Delete sparkline data for a specific sheet.
#[tauri::command]
pub fn delete_sparklines(state: State<AppState>, sheet_index: usize) -> Result<(), String> {
    let previous = {
        let mut sparklines = state.sparklines.lock().map_err(|e| e.to_string())?;
        let previous = sparklines
            .iter()
            .find(|s| s.sheet_index == sheet_index)
            .map(|s| s.groups_json.clone());
        sparklines.retain(|s| s.sheet_index != sheet_index);
        previous
    };
    if previous.is_some() {
        crate::undo_commands::record_sparklines_undo(
            &state,
            sheet_index,
            previous,
            "Delete sparklines",
        );
    }
    Ok(())
}

/// Clear all sparkline data (all sheets).
#[tauri::command]
pub fn clear_all_sparklines(state: State<AppState>) -> Result<(), String> {
    let entries = {
        let mut sparklines = state.sparklines.lock().map_err(|e| e.to_string())?;
        let entries: Vec<SparklineEntry> = sparklines.drain(..).collect();
        entries
    };
    for entry in entries {
        crate::undo_commands::record_sparklines_undo(
            &state,
            entry.sheet_index,
            Some(entry.groups_json),
            "Clear sparklines",
        );
    }
    Ok(())
}
