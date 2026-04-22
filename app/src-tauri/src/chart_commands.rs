//! FILENAME: app/src-tauri/src/chart_commands.rs
//! Tauri commands for chart persistence.
//! Charts are stored as opaque JSON blobs (ChartEntry) in AppState.

use crate::api_types::ChartEntry;
use crate::AppState;
use tauri::State;

/// Get all chart entries.
#[tauri::command]
pub fn get_charts(state: State<AppState>) -> Vec<ChartEntry> {
    state.charts.lock().unwrap().clone()
}

/// Save (create) a new chart entry.
#[tauri::command]
pub fn save_chart(state: State<AppState>, entry: ChartEntry) -> Result<(), String> {
    let mut charts = state.charts.lock().map_err(|e| e.to_string())?;
    // Replace if already exists (upsert), otherwise push
    if let Some(existing) = charts.iter_mut().find(|c| c.id == entry.id) {
        *existing = entry;
    } else {
        charts.push(entry);
    }
    Ok(())
}

/// Update an existing chart entry.
#[tauri::command]
pub fn update_chart(state: State<AppState>, entry: ChartEntry) -> Result<(), String> {
    let mut charts = state.charts.lock().map_err(|e| e.to_string())?;
    if let Some(existing) = charts.iter_mut().find(|c| c.id == entry.id) {
        *existing = entry;
        Ok(())
    } else {
        Err(format!("Chart with id {} not found", entry.id))
    }
}

/// Delete a chart entry by ID.
#[tauri::command]
pub fn delete_chart(state: State<AppState>, id: u32) -> Result<(), String> {
    let mut charts = state.charts.lock().map_err(|e| e.to_string())?;
    let len_before = charts.len();
    charts.retain(|c| c.id != id);
    if charts.len() == len_before {
        Err(format!("Chart with id {} not found", id))
    } else {
        Ok(())
    }
}
