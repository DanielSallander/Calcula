//! FILENAME: app/src-tauri/src/chart_commands.rs
//! Tauri commands for chart persistence.
//! Charts are stored as opaque JSON blobs (ChartEntry) in AppState.
//! All mutations record obj_chart undo snapshots (BUG-0001: chart lifecycle
//! used to bypass the undo system entirely).

use crate::api_types::ChartEntry;
use crate::document_effect::DocumentEffect;
use crate::persistence::FileState;
use crate::AppState;
use tauri::State;

// CHARTS ARE PERSISTED (`workbook.charts`), so all three mutators dirty the document.
// They already recorded undo entries -- an unambiguous declaration that the change is
// user-meaningful and must survive -- while marking nothing dirty, so inserting a chart
// and closing lost it with no prompt.
//
// Each effect is constructed after the `editObjects` protection gate AND after the
// "not found" checks, so a refused or no-op call leaves the document clean.

/// Get all chart entries.
#[tauri::command]
pub fn get_charts(state: State<AppState>) -> Vec<ChartEntry> {
    state.charts.read().unwrap().clone()
}

/// Save (create) a new chart entry.
#[tauri::command]
pub fn save_chart(
    state: State<AppState>,
    file_state: State<FileState>,
    entry: ChartEntry,
) -> Result<(), String> {
    // allowEditObjects option gate, same as update_chart/delete_chart — this is
    // an UPSERT, so without it "save" was a full bypass of the other two gates.
    crate::protection::check_sheet_action(
        &state, entry.sheet_index, "editObjects", "edit objects",
    )?;
    // Gate passed; an upsert always commits.
    let effect = DocumentEffect::mutates(&file_state);
    let previous = {
        let mut charts = state.charts.write(&effect).map_err(|e| e.to_string())?;
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
pub fn update_chart(
    state: State<AppState>,
    file_state: State<FileState>,
    entry: ChartEntry,
) -> Result<(), String> {
    // allowEditObjects option gate — charts are the "objects" the flag names.
    crate::protection::check_sheet_action(
        &state, entry.sheet_index, "editObjects", "edit objects",
    )?;
    // RESOLVE FIRST, THEN DECIDE, THEN MUTATE.
    // `DocumentEffect::mutates` sets the dirty flag in its constructor, and
    // `Persisted::write` will not hand out a mutable guard without one -- so the
    // "does this chart exist?" question has to be answered under a READ guard, before
    // the decision. That ordering is the point: a missing id returns Err having
    // touched nothing and having left the document exactly as clean as it was.
    let previous = {
        let charts = state.charts.read().map_err(|e| e.to_string())?;
        charts
            .iter()
            .find(|c| c.id == entry.id)
            .cloned()
            .ok_or_else(|| format!("Chart with id {} not found", entry.id))?
    };
    let effect = DocumentEffect::mutates(&file_state);
    {
        let mut charts = state.charts.write(&effect).map_err(|e| e.to_string())?;
        if let Some(existing) = charts.iter_mut().find(|c| c.id == entry.id) {
            *existing = entry.clone();
        }
    }
    crate::undo_commands::record_chart_undo(&state, entry.id, Some(previous), "Edit chart");
    Ok(())
}

/// Delete a chart entry by ID.
#[tauri::command]
pub fn delete_chart(
    state: State<AppState>,
    file_state: State<FileState>,
    id: identity::EntityId,
) -> Result<(), String> {
    // allowEditObjects option gate. The sheet comes from the chart itself, so
    // this is resolved before any mutation.
    {
        let sheet = state.charts.read().map_err(|e| e.to_string())?
            .iter().find(|c| c.id == id).map(|c| c.sheet_index);
        if let Some(sheet_index) = sheet {
            crate::protection::check_sheet_action(&state, sheet_index, "editObjects", "delete objects")?;
        }
    }
    // Resolve under a read guard first (see `update_chart`): "no such chart" must not
    // dirty the document.
    let previous = {
        let charts = state.charts.read().map_err(|e| e.to_string())?;
        charts
            .iter()
            .find(|c| c.id == id)
            .cloned()
            .ok_or_else(|| format!("Chart with id {} not found", id))?
    };
    let effect = DocumentEffect::mutates(&file_state);
    {
        let mut charts = state.charts.write(&effect).map_err(|e| e.to_string())?;
        charts.retain(|c| c.id != id);
    }
    crate::undo_commands::record_chart_undo(&state, id, Some(previous), "Delete chart");
    // C10: a deleted chart must not leave its object script mounted/persisted.
    crate::scripting::object_script_commands::prune_scripts_for_instance(&state, &effect, &id.to_string());
    Ok(())
}
