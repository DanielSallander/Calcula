//! FILENAME: app/src-tauri/src/chart_commands.rs
//! Tauri commands for chart persistence.
//! Charts are stored as opaque JSON blobs (ChartEntry) in AppState.
//! All mutations record obj_chart undo snapshots (BUG-0001: chart lifecycle
//! used to bypass the undo system entirely).

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
    // allowEditObjects option gate, same as update_chart/delete_chart — this is
    // an UPSERT, so without it "save" was a full bypass of the other two gates.
    crate::protection::check_sheet_action(
        &state, entry.sheet_index, "editObjects", "edit objects",
    )?;
    let previous = {
        let mut charts = state.charts.lock().map_err(|e| e.to_string())?;
        let previous = charts.iter().find(|c| c.id == entry.id).cloned();
        // Replace if already exists (upsert), otherwise push
        if let Some(existing) = charts.iter_mut().find(|c| c.id == entry.id) {
            *existing = entry.clone();
        } else {
            charts.push(entry.clone());
        }
        previous
    };
    let description = if previous.is_some() { "Edit chart" } else { "Insert chart" };
    crate::undo_commands::record_chart_undo(&state, entry.id, previous, description);
    Ok(())
}

/// Update an existing chart entry.
#[tauri::command]
pub fn update_chart(state: State<AppState>, entry: ChartEntry) -> Result<(), String> {
    // allowEditObjects option gate — charts are the "objects" the flag names.
    crate::protection::check_sheet_action(
        &state, entry.sheet_index, "editObjects", "edit objects",
    )?;
    let previous = {
        let mut charts = state.charts.lock().map_err(|e| e.to_string())?;
        let previous = charts.iter().find(|c| c.id == entry.id).cloned();
        if let Some(existing) = charts.iter_mut().find(|c| c.id == entry.id) {
            *existing = entry.clone();
        } else {
            return Err(format!("Chart with id {} not found", entry.id));
        }
        previous
    };
    crate::undo_commands::record_chart_undo(&state, entry.id, previous, "Edit chart");
    Ok(())
}

/// Delete a chart entry by ID.
#[tauri::command]
pub fn delete_chart(state: State<AppState>, id: identity::EntityId) -> Result<(), String> {
    // allowEditObjects option gate. The sheet comes from the chart itself, so
    // this is resolved before any mutation.
    {
        let sheet = state.charts.lock().map_err(|e| e.to_string())?
            .iter().find(|c| c.id == id).map(|c| c.sheet_index);
        if let Some(sheet_index) = sheet {
            crate::protection::check_sheet_action(&state, sheet_index, "editObjects", "delete objects")?;
        }
    }
    let previous = {
        let mut charts = state.charts.lock().map_err(|e| e.to_string())?;
        let previous = charts.iter().find(|c| c.id == id).cloned();
        let len_before = charts.len();
        charts.retain(|c| c.id != id);
        if charts.len() == len_before {
            return Err(format!("Chart with id {} not found", id));
        }
        previous
    };
    crate::undo_commands::record_chart_undo(&state, id, previous, "Delete chart");
    // C10: a deleted chart must not leave its object script mounted/persisted.
    crate::scripting::object_script_commands::prune_scripts_for_instance(&state, &id.to_string());
    Ok(())
}
