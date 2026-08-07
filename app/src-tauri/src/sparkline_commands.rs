//! FILENAME: app/src-tauri/src/sparkline_commands.rs
//! Tauri commands for sparkline persistence.
//! Sparkline groups are stored as opaque JSON blobs (SparklineEntry) in AppState,
//! keyed by sheet index.
//! All mutations record obj_sparklines undo snapshots (BUG-0002: sparkline
//! lifecycle used to bypass the undo system entirely).

use crate::api_types::SparklineEntry;
use crate::document_effect::DocumentEffect;
use crate::persistence::FileState;
use crate::AppState;
use tauri::State;

// SPARKLINES ARE PERSISTED (`workbook.sparklines`), so all three mutators dirty the
// document. Like charts they already recorded undo entries -- an unambiguous
// declaration that the change is user-meaningful and must survive -- while marking
// nothing dirty, so drawing a sparkline group and closing lost it with no prompt, and
// AutoRecover declined to snapshot it either.
//
// ORDERING: `DocumentEffect::mutates` sets the flag in its constructor, so the
// "is there anything to change?" question is answered under a READ guard first.
// A delete/clear that finds nothing then returns having touched nothing and having
// left the document exactly as clean as it was.

/// Get all sparkline entries (all sheets).
#[tauri::command]
pub fn get_sparklines(state: State<AppState>) -> Vec<SparklineEntry> {
    state.sparklines.read().unwrap().clone()
}

/// Save sparkline groups for a specific sheet (upsert by sheet_index).
#[tauri::command]
pub fn save_sparklines(
    state: State<AppState>,
    file_state: State<FileState>,
    entry: SparklineEntry,
) -> Result<(), String> {
    save_sparklines_impl(&state, &file_state, entry)
}

/// Command body over plain references (see `document_effect_wave2_tests`).
pub(crate) fn save_sparklines_impl(
    state: &AppState,
    file_state: &FileState,
    entry: SparklineEntry,
) -> Result<(), String> {
    let sheet_index = entry.sheet_index;
    // An upsert always commits, so the decision can be made up front.
    let effect = DocumentEffect::mutates(&file_state);
    let previous = {
        let mut sparklines = state.sparklines.write(&effect).map_err(|e| e.to_string())?;
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
pub fn delete_sparklines(
    state: State<AppState>,
    file_state: State<FileState>,
    sheet_index: usize,
) -> Result<(), String> {
    delete_sparklines_impl(&state, &file_state, sheet_index)
}

/// Command body over plain references, so the "a delete that finds nothing stays clean"
/// contract is unit-testable (see `document_effect_wave2_tests`).
pub(crate) fn delete_sparklines_impl(
    state: &AppState,
    file_state: &FileState,
    sheet_index: usize,
) -> Result<(), String> {
    // Resolve under a read guard first: deleting sparklines from a sheet that has
    // none changes nothing and must not dirty the document.
    let previous = {
        let sparklines = state.sparklines.read().map_err(|e| e.to_string())?;
        sparklines
            .iter()
            .find(|s| s.sheet_index == sheet_index)
            .map(|s| s.groups_json.clone())
    };
    let Some(previous) = previous else {
        return Ok(());
    };
    let effect = DocumentEffect::mutates(&file_state);
    {
        let mut sparklines = state.sparklines.write(&effect).map_err(|e| e.to_string())?;
        sparklines.retain(|s| s.sheet_index != sheet_index);
    }
    crate::undo_commands::record_sparklines_undo(
        &state,
        sheet_index,
        Some(previous),
        "Delete sparklines",
    );
    Ok(())
}

/// Clear all sparkline data (all sheets).
#[tauri::command]
pub fn clear_all_sparklines(
    state: State<AppState>,
    file_state: State<FileState>,
) -> Result<(), String> {
    // Same read-first ordering: clearing an already-empty store is a no-op.
    if state.sparklines.read().map_err(|e| e.to_string())?.is_empty() {
        return Ok(());
    }
    let effect = DocumentEffect::mutates(&file_state);
    let entries = {
        let mut sparklines = state.sparklines.write(&effect).map_err(|e| e.to_string())?;
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
