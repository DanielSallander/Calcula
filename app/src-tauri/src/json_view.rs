//! FILENAME: app/src-tauri/src/json_view.rs
//! PURPOSE: Tauri commands for the JSON View extension.
//! CONTEXT: Provides generic get/set/list commands for inspecting and editing
//!          any workbook object as JSON. Used by the JsonView extension.

use crate::api_types;
use crate::document_effect::DocumentEffect;
use crate::persistence::FileState;
use crate::AppState;
use serde::{Deserialize, Serialize};
use tauri::State;

// ============================================================================
// Types
// ============================================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ObjectEntry {
    pub object_type: String,
    pub object_id: String,
    pub label: String,
}

// ============================================================================
// get_object_json — Serialize any workbook object to pretty JSON
// ============================================================================

#[tauri::command]
pub fn get_object_json(
    state: State<AppState>,
    slicer_state: State<crate::slicer::SlicerState>,
    ribbon_filter_state: State<crate::ribbon_filter::RibbonFilterState>,
    script_state: State<crate::scripting::ScriptState>,
    timeline_slicer_state: State<crate::timeline_slicer::TimelineSlicerState>,
    pivot_state: State<crate::pivot::PivotState>,
    object_type: String,
    object_id: String,
) -> Result<String, String> {
    match object_type.as_str() {
        "chart" => {
            let id = identity::EntityId::parse(&object_id).ok_or_else(|| "Invalid chart id".to_string())?;
            let charts = state.charts.read().unwrap();
            let entry = charts.iter().find(|c| c.id == id)
                .ok_or_else(|| format!("Chart {} not found", id))?;
            serde_json::to_string_pretty(entry).map_err(|e| e.to_string())
        }
        "table" => {
            let id = identity::EntityId::parse(&object_id).ok_or_else(|| "Invalid table id".to_string())?;
            let tables = state.tables.read().unwrap();
            for sheet_tables in tables.values() {
                if let Some(table) = sheet_tables.get(&id) {
                    return serde_json::to_string_pretty(table).map_err(|e| e.to_string());
                }
            }
            Err(format!("Table {} not found", id))
        }
        "slicer" => {
            let id = identity::EntityId::parse(&object_id).ok_or_else(|| "Invalid slicer id".to_string())?;
            let slicers = slicer_state.slicers.read().unwrap();
            let slicer = slicers.get(&id)
                .ok_or_else(|| format!("Slicer {} not found", id))?;
            serde_json::to_string_pretty(slicer).map_err(|e| e.to_string())
        }
        "ribbon_filter" => {
            let id = identity::EntityId::parse(&object_id).ok_or_else(|| "Invalid ribbon filter id".to_string())?;
            let filters = ribbon_filter_state.filters.read().unwrap();
            let filter = filters.get(&id)
                .ok_or_else(|| format!("Ribbon filter {} not found", id))?;
            serde_json::to_string_pretty(filter).map_err(|e| e.to_string())
        }
        "timeline_slicer" => {
            let id = identity::EntityId::parse(&object_id).ok_or_else(|| "Invalid timeline slicer id".to_string())?;
            let timelines = timeline_slicer_state.timelines.read().unwrap();
            let timeline = timelines.get(&id)
                .ok_or_else(|| format!("Timeline slicer {} not found", id))?;
            serde_json::to_string_pretty(timeline).map_err(|e| e.to_string())
        }
        "sparkline" => {
            let idx: usize = object_id.parse().map_err(|_| "Invalid sparkline index".to_string())?;
            let sparklines = state.sparklines.read().unwrap();
            let entry = sparklines.get(idx)
                .ok_or_else(|| format!("Sparkline entry {} not found", idx))?;
            serde_json::to_string_pretty(entry).map_err(|e| e.to_string())
        }
        "script" => {
            let scripts = script_state.workbook_scripts.read().unwrap();
            let script = scripts.get(&object_id)
                .ok_or_else(|| format!("Script '{}' not found", object_id))?;
            serde_json::to_string_pretty(script).map_err(|e| e.to_string())
        }
        "notebook" => {
            let notebooks = script_state.workbook_notebooks.read().unwrap();
            let notebook = notebooks.get(&object_id)
                .ok_or_else(|| format!("Notebook '{}' not found", object_id))?;
            serde_json::to_string_pretty(notebook).map_err(|e| e.to_string())
        }
        "pivot" => {
            let id: pivot_engine::PivotId = serde_json::from_value(
                serde_json::Value::String(object_id.clone())
            ).map_err(|_| "Invalid pivot id".to_string())?;
            let pivot_tables = pivot_state.pivot_tables.read().unwrap();
            let (definition, _cache) = pivot_tables.get(&id)
                .ok_or_else(|| format!("Pivot {} not found", object_id))?;
            serde_json::to_string_pretty(definition).map_err(|e| e.to_string())
        }
        "pivot_layout" => {
            let id = identity::EntityId::parse(&object_id).ok_or_else(|| "Invalid pivot layout id".to_string())?;
            let layouts = state.pivot_layouts.read().unwrap();
            let layout = layouts.iter().find(|l| l.id == id)
                .ok_or_else(|| format!("Pivot layout {} not found", id))?;
            serde_json::to_string_pretty(layout).map_err(|e| e.to_string())
        }
        "theme" => {
            let theme = state.theme.read().unwrap();
            serde_json::to_string_pretty(&*theme).map_err(|e| e.to_string())
        }
        "properties" => {
            let props = state.workbook_properties.read().unwrap();
            serde_json::to_string_pretty(&*props).map_err(|e| e.to_string())
        }
        "sheet_layout" => {
            let idx: usize = object_id.parse().map_err(|_| "Invalid sheet index".to_string())?;
            // The active sheet's live column/row dimensions live in the primary
            // maps; other sheets are held in the per-sheet vectors. Read the
            // freshest source so the inspector never shows stale widths/heights.
            let active = *state.active_sheet.read().unwrap();
            let layout = if idx == active {
                let cw = state.column_widths.read().unwrap();
                let rh = state.row_heights.read().unwrap();
                calcula_format::sheet_layout::SheetLayout::from_dimensions(&cw, &rh)
            } else {
                let all_cw = state.all_column_widths.read().unwrap();
                let all_rh = state.all_row_heights.read().unwrap();
                if idx >= all_cw.len() || idx >= all_rh.len() {
                    return Err(format!("Sheet {} not found", idx));
                }
                calcula_format::sheet_layout::SheetLayout::from_dimensions(&all_cw[idx], &all_rh[idx])
            };
            serde_json::to_string_pretty(&layout).map_err(|e| e.to_string())
        }
        "sheet_data" => {
            let idx: usize = object_id.parse().map_err(|_| "Invalid sheet index".to_string())?;
            // Cell values are the sparse, A1-keyed grid contents — a structure
            // entirely separate from the layout above (which is only column/row
            // sizes). The active sheet's live cells are in the primary grid;
            // other sheets are held in the per-sheet grids vector (the active
            // slot there is stale). Read the freshest source, then reuse the
            // .cala serializer so the shape matches the on-disk data.json.
            let active = *state.active_sheet.read().unwrap();
            let cells: std::collections::HashMap<(u32, u32), ::persistence::SavedCell> =
                if idx == active {
                    let grid = state.grid.read().unwrap();
                    grid.cells
                        .iter()
                        .map(|(&rc, c)| (rc, ::persistence::SavedCell::from_cell(c)))
                        .collect()
                } else {
                    let grids = state.grids.read().unwrap();
                    let grid = grids
                        .get(idx)
                        .ok_or_else(|| format!("Sheet {} not found", idx))?;
                    grid.cells
                        .iter()
                        .map(|(&rc, c)| (rc, ::persistence::SavedCell::from_cell(c)))
                        .collect()
                };
            let data = calcula_format::sheet_data::cells_to_sheet_data(&cells);
            serde_json::to_string_pretty(&data).map_err(|e| e.to_string())
        }
        _ => Err(format!("Unknown object type: {}", object_type)),
    }
}

// ============================================================================
// set_object_json — Deserialize JSON and replace the workbook object
// ============================================================================

/// Replace a workbook object with the JSON the user edited.
///
/// DIRTY FLAG. This is the widest single mutation surface in the app: one command
/// rewrites charts, tables, slicers, ribbon filters, timeline slicers, sparklines,
/// scripts, notebooks, pivots, pivot layouts, the document theme, workbook properties
/// and sheet layouts -- almost all of which are persisted. It marked nothing dirty.
///
/// The decision is taken on the RESULT rather than per arm, for a reason: some arms
/// (`sheet_layout`) `return` early from the middle of the match, so a mark
/// placed per arm is exactly the kind of thing that gets missed when a new object type
/// is added. Every arm's error path is a refusal that mutated nothing -- an unparseable
/// blob or an id that does not resolve -- so "Ok implies committed" holds uniformly and
/// keeps refusals clean.
///
/// KNOWN OVER-APPROXIMATION: the `timeline_slicer` arm now dirties, but
/// `TimelineSlicerState` is never collected by `assemble_workbook_for_save`, so
/// timeline slicers are lost on save/reload regardless. That is a separate pre-existing
/// persistence gap (census edge case 9); dirtying is the harmless direction of the error
/// (a spurious prompt, not lost work) and must be revisited when timelines are persisted.
#[tauri::command]
pub fn set_object_json(
    state: State<AppState>,
    file_state: State<FileState>,
    slicer_state: State<crate::slicer::SlicerState>,
    ribbon_filter_state: State<crate::ribbon_filter::RibbonFilterState>,
    script_state: State<crate::scripting::ScriptState>,
    timeline_slicer_state: State<crate::timeline_slicer::TimelineSlicerState>,
    pivot_state: State<crate::pivot::PivotState>,
    user_files_state: State<crate::persistence::UserFilesState>,
    pane_control_state: State<crate::pane_control::PaneControlState>,
    object_type: String,
    object_id: String,
    json: String,
    app: tauri::AppHandle,
) -> Result<(), String> {
    // A borrowed handle the `move` closure can capture by value (`&FileState` is Copy)
    // without moving `file_state` itself, which is still needed after the call.
    let fs: &FileState = &file_state;
    // The `script` arm's changed Custom Functions library: the generation the
    // page must re-install (see `set_script_json`), announced after the write.
    let library_generation_cell: std::cell::Cell<Option<u64>> = std::cell::Cell::new(None);
    let library_generation = &library_generation_cell;
    let result = (move || -> Result<(), String> {
    match object_type.as_str() {
        "chart" => {
            let id = identity::EntityId::parse(&object_id).ok_or_else(|| "Invalid chart id".to_string())?;
            let new_entry: api_types::ChartEntry = serde_json::from_str(&json)
                .map_err(|e| format!("Invalid chart JSON: {}", e))?;
            // Resolve under a read guard, then decide, then write -- so an id that
            // does not resolve leaves the document clean.
            if !state.charts.read().unwrap().iter().any(|c| c.id == id) {
                return Err(format!("Chart {} not found", id));
            }
            let effect = DocumentEffect::mutates(fs);
            let mut charts = state.charts.write(&effect).unwrap();
            if let Some(existing) = charts.iter_mut().find(|c| c.id == id) {
                *existing = new_entry;
            }
            Ok(())
        }
        "table" => set_table_json(
            &state,
            fs,
            &user_files_state,
            &pivot_state,
            &pane_control_state,
            &ribbon_filter_state,
            &object_id,
            &json,
        ),
        "slicer" => {
            let id = identity::EntityId::parse(&object_id).ok_or_else(|| "Invalid slicer id".to_string())?;
            let new_slicer: crate::slicer::Slicer = serde_json::from_str(&json)
                .map_err(|e| format!("Invalid slicer JSON: {}", e))?;
            let effect = DocumentEffect::mutates(fs);
            let mut slicers = slicer_state.slicers.write(&effect).unwrap();
            if let Some(existing) = slicers.get_mut(&id) {
                *existing = new_slicer;
                Ok(())
            } else {
                Err(format!("Slicer {} not found", id))
            }
        }
        "ribbon_filter" => {
            let id = identity::EntityId::parse(&object_id).ok_or_else(|| "Invalid ribbon filter id".to_string())?;
            let new_filter: crate::ribbon_filter::RibbonFilter = serde_json::from_str(&json)
                .map_err(|e| format!("Invalid ribbon filter JSON: {}", e))?;
            // Resolve under a read guard, then decide, then write -- so an id that
            // does not resolve leaves the document clean.
            if !ribbon_filter_state.filters.read().unwrap().contains_key(&id) {
                return Err(format!("Ribbon filter {} not found", id));
            }
            let effect = DocumentEffect::mutates(fs);
            let mut filters = ribbon_filter_state.filters.write(&effect).unwrap();
            if let Some(existing) = filters.get_mut(&id) {
                *existing = new_filter;
                Ok(())
            } else {
                Err(format!("Ribbon filter {} not found", id))
            }
        }
        "timeline_slicer" => {
            let id = identity::EntityId::parse(&object_id).ok_or_else(|| "Invalid timeline slicer id".to_string())?;
            let new_timeline: crate::timeline_slicer::TimelineSlicer = serde_json::from_str(&json)
                .map_err(|e| format!("Invalid timeline slicer JSON: {}", e))?;
            // Resolve under a read guard, then decide, then write -- so an id that
            // does not resolve leaves the document clean. Same shape as the
            // ribbon_filter arm above.
            if !timeline_slicer_state.timelines.read().unwrap().contains_key(&id) {
                return Err(format!("Timeline slicer {} not found", id));
            }
            let effect = DocumentEffect::mutates(fs);
            let mut timelines = timeline_slicer_state.timelines.write(&effect).unwrap();
            if let Some(existing) = timelines.get_mut(&id) {
                *existing = new_timeline;
                Ok(())
            } else {
                Err(format!("Timeline slicer {} not found", id))
            }
        }
        "sparkline" => {
            let idx: usize = object_id.parse().map_err(|_| "Invalid sparkline index".to_string())?;
            let new_entry: api_types::SparklineEntry = serde_json::from_str(&json)
                .map_err(|e| format!("Invalid sparkline JSON: {}", e))?;
            if idx >= state.sparklines.read().unwrap().len() {
                return Err(format!("Sparkline entry {} not found", idx));
            }
            let effect = DocumentEffect::mutates(fs);
            state.sparklines.write(&effect).unwrap()[idx] = new_entry;
            Ok(())
        }
        "script" => {
            library_generation.set(set_script_json(&state, fs, &script_state, object_id, &json)?);
            Ok(())
        }
        "notebook" => set_notebook_json(fs, &script_state, object_id, &json),
        "pivot" => {
            let id: pivot_engine::PivotId = serde_json::from_value(
                serde_json::Value::String(object_id.clone())
            ).map_err(|_| "Invalid pivot id".to_string())?;
            let new_definition: pivot_engine::PivotDefinition = serde_json::from_str(&json)
                .map_err(|e| format!("Invalid pivot JSON: {}", e))?;
            // Both refusals (bad id, bad JSON) are above, so the eager token is safe here.
            let effect = DocumentEffect::mutates(fs);
            let mut pivot_tables = pivot_state.pivot_tables.write(&effect).unwrap();
            if let Some((definition, _cache)) = pivot_tables.get_mut(&id) {
                *definition = new_definition;
                Ok(())
            } else {
                Err(format!("Pivot {} not found", object_id))
            }
        }
        "pivot_layout" => {
            let id = identity::EntityId::parse(&object_id).ok_or_else(|| "Invalid pivot layout id".to_string())?;
            let new_layout: ::persistence::SavedPivotLayout = serde_json::from_str(&json)
                .map_err(|e| format!("Invalid pivot layout JSON: {}", e))?;
            if !state.pivot_layouts.read().unwrap().iter().any(|l| l.id == id) {
                return Err(format!("Pivot layout {} not found", id));
            }
            let effect = DocumentEffect::mutates(fs);
            let mut layouts = state.pivot_layouts.write(&effect).unwrap();
            if let Some(existing) = layouts.iter_mut().find(|l| l.id == id) {
                *existing = new_layout;
            }
            Ok(())
        }
        "theme" => {
            let new_theme: engine::ThemeDefinition = serde_json::from_str(&json)
                .map_err(|e| format!("Invalid theme JSON: {}", e))?;
            let effect = DocumentEffect::mutates(fs);
            let mut theme = state.theme.write(&effect).unwrap();
            *theme = new_theme;
            Ok(())
        }
        "properties" => {
            let new_props: api_types::WorkbookProperties = serde_json::from_str(&json)
                .map_err(|e| format!("Invalid properties JSON: {}", e))?;
            let effect = DocumentEffect::mutates(fs);
            let mut props = state.workbook_properties.write(&effect).unwrap();
            *props = new_props;
            Ok(())
        }
        "sheet_layout" => {
            let idx: usize = object_id.parse().map_err(|_| "Invalid sheet index".to_string())?;
            let layout: calcula_format::sheet_layout::SheetLayout = serde_json::from_str(&json)
                .map_err(|e| format!("Invalid sheet layout JSON: {}", e))?;
            let (col_widths, row_heights) = layout.to_dimensions();
            // Write into the per-sheet vectors (growing them if needed) so the
            // change survives a sheet switch, and mirror the active sheet into
            // the live primary maps.
            // `lock_pending` because the bounds check can still REFUSE: minting
            // the effect first would leave a rejected edit with a dirty flag.
            let all_cw = state.all_column_widths.lock_pending().unwrap();
            let all_rh = state.all_row_heights.lock_pending().unwrap();
            if idx >= all_cw.len() || idx >= all_rh.len() {
                return Err(format!("Sheet {} not found", idx));
            }
            let effect = DocumentEffect::mutates(fs);
            {
                let mut all_cw = all_cw.authorize(&effect);
                let mut all_rh = all_rh.authorize(&effect);
                all_cw[idx] = col_widths.clone();
                all_rh[idx] = row_heights.clone();
            }
            if idx == *state.active_sheet.read().unwrap() {
                *state.column_widths.write(&effect).unwrap() = col_widths;
                *state.row_heights.write(&effect).unwrap() = row_heights;
            }
            Ok(())
        }
        _ => Err(format!("Unknown object type: {}", object_type)),
    }
    })();
    if result.is_ok() {
        // Committed: the object was replaced.
        let _effect = DocumentEffect::mutates(&file_state);
    }
    // A Custom Functions library edited here: the page re-installs it, and only
    // then are the held functions' served answers filed again (rev12C).
    if let Some(generation) = library_generation_cell.get() {
        let _ = tauri::Emitter::emit(
            &app,
            "custom-functions:refresh",
            crate::bi::cube::CustomFunctionsRefresh { generation },
        );
    }
    result
}

/// The `table` arm of [`set_object_json`]: replace an EXISTING table from its
/// JSON.
///
/// A NAME change is a Rename Table, never a registry key swap. This arm used to
/// overwrite the table and swap its `table_names` key, asking nothing: a JSON
/// rename to another table's name, to a defined name, or to an invalid name
/// was accepted, and every `=SUM(Old[Col])` was left naming a table the
/// workbook no longer had. It now goes through the one rename route
/// (`tables::rename_table_core`): a valid name, no other table or defined name
/// of that name, an unprotected sheet, every `Old[...]` reference carried over
/// as one undo step. A refusal there applies nothing of the JSON. Both parse
/// refusals and the not-found refusal come before any effect.
#[allow(clippy::too_many_arguments)]
pub(crate) fn set_table_json(
    state: &AppState,
    fs: &FileState,
    user_files_state: &crate::persistence::UserFilesState,
    pivot_state: &crate::pivot::PivotState,
    pane_control_state: &crate::pane_control::PaneControlState,
    ribbon_filter_state: &crate::ribbon_filter::RibbonFilterState,
    object_id: &str,
    json: &str,
) -> Result<(), String> {
    let id = identity::EntityId::parse(object_id).ok_or_else(|| "Invalid table id".to_string())?;
    let new_table: crate::tables::Table =
        serde_json::from_str(json).map_err(|e| format!("Invalid table JSON: {}", e))?;
    let found = state
        .tables
        .read()
        .unwrap()
        .iter()
        .find_map(|(&sheet, sheet_tables)| sheet_tables.get(&id).map(|t| (sheet, t.name.clone())));
    let Some((sheet, old_name)) = found else {
        return Err(format!("Table {} not found", id));
    };
    // The record's identity is not the JSON's to change: a table moved to
    // another id or sheet here would be filed under a key it does not match.
    if new_table.id != id || new_table.sheet_index != sheet {
        return Err(
            "The table's id and sheet cannot be changed here; edit its other fields".to_string(),
        );
    }
    // ONE UNDO STEP for the whole edit (misc19, round 19). The rename recorded
    // its own step and the field replacement none at all, so Ctrl+Z after a
    // range or style change through this view did nothing. The rename joins
    // this transaction (its own begin is an owned one) and records the table as
    // it was; the replacement records the table between the two, so one Ctrl+Z
    // replays both in reverse and lands on the original.
    // The undo lock is taken and RELEASED around the step's begin, its record
    // and its commit: the rename below takes it again itself.
    let transaction = {
        let mut undo_stack = state.undo_stack.lock().unwrap();
        undo_stack.begin_owned_transaction("Edit table")
    };
    let outcome = (|| {
        if old_name != new_table.name {
            let renamed = crate::tables::rename_table_core(
                state,
                fs,
                user_files_state,
                pivot_state,
                pane_control_state,
                ribbon_filter_state,
                sheet,
                id,
                new_table.name.clone(),
            );
            if !renamed.success {
                return Err(renamed.error.unwrap_or_else(|| "Could not rename the table".to_string()));
            }
        }
        // The replacement in ONE critical section: the presence check, the
        // unchanged check and the write share the held guard, and the effect is
        // minted after both refusals. The name is the registry's (set by the
        // rename above); the JSON's other fields replace the table's.
        let tables = state.tables.lock_pending().unwrap();
        let Some(existing) = tables.get(&sheet).and_then(|t| t.get(&id)) else {
            return Err(format!("Table {} not found", id));
        };
        let mut replacement = new_table;
        replacement.name = existing.name.clone();
        let unchanged = serde_json::to_value(existing).ok() == serde_json::to_value(&replacement).ok();
        if unchanged {
            return Ok(());
        }
        let previous = existing.clone();
        let effect = DocumentEffect::mutates(fs);
        let mut tables = tables.authorize(&effect);
        if let Some(slot) = tables.get_mut(&sheet).and_then(|t| t.get_mut(&id)) {
            *slot = replacement;
        }
        drop(tables);
        {
            let mut undo_stack = state.undo_stack.lock().unwrap();
            undo_stack.record_custom_restore(
                "obj_table".to_string(),
                crate::undo_commands::table_snapshot_bytes(sheet, id, Some(previous)),
                "Edit table",
            );
        }
        Ok(())
    })();
    // Committed whatever the outcome: a rename that happened before a refusal
    // is a real change and stays undoable; an edit that changed nothing
    // leaves an empty step, which the stack does not keep.
    {
        let mut undo_stack = state.undo_stack.lock().unwrap();
        undo_stack.commit_owned(transaction);
    }
    outcome
}

/// The `script` arm of [`set_object_json`]: replace an EXISTING script record
/// from its JSON.
///
/// THROUGH THE SCRIPT STORE'S ONE WRITER (rev10B). This arm used to insert the
/// record verbatim, which skipped both rules every other script write obeys:
/// a Custom Functions library edited here kept the old code's answers in every
/// results cache (F9 and the save served them as current), and a distributed
/// module edited with its `sourcePackage` left out lost its provenance stamp
/// -- the laundering `save_script` was hardened against. It now goes through
/// `scripting::commands::update_existing_script_core`: sticky provenance, the
/// custom-function forget, and the not-found refusal under the write's own
/// lock, before the document is dirtied.
///
/// The record's id is its identity: a JSON whose `id` names another record is
/// refused rather than stored under a key it does not match.
///
/// A CHANGED Custom Functions library is also held until the page re-installs
/// it (rev12C): forgetting the old answers was not enough, because the page's
/// old realm kept running the old code and the next calculation filed its
/// answers again as current. Returns `Some(generation)` then, which
/// [`set_object_json`] announces as `custom-functions:refresh`.
pub(crate) fn set_script_json(
    state: &AppState,
    file_state: &FileState,
    script_state: &crate::scripting::ScriptState,
    object_id: String,
    json: &str,
) -> Result<Option<u64>, String> {
    let new_script: crate::scripting::WorkbookScript =
        serde_json::from_str(json).map_err(|e| format!("Invalid script JSON: {}", e))?;
    if new_script.id != object_id {
        return Err(format!(
            "The script's id cannot be changed here: the JSON names '{}', the record is '{}'",
            new_script.id, object_id
        ));
    }
    crate::scripting::commands::update_existing_script_core(state, file_state, script_state, new_script)
}

/// The `notebook` arm of [`set_object_json`]: replace an EXISTING notebook
/// from its JSON, by the same two rules as the `script` arm above.
///
/// This arm used to mint its `DocumentEffect` before its not-found refusal (an
/// edit of a notebook that does not exist dirtied the document) and insert the
/// record verbatim, so a distributed notebook edited with its `sourcePackage`
/// left out became local code -- the laundering `notebook_save` is hardened
/// against. Now: the existence check and the write share ONE critical section
/// (`lock_pending`), the effect is minted after every refusal, and provenance
/// is sticky (`sticky_source_package`: omission means "leave it alone"). A JSON
/// whose `id` names another record is refused, as for a script.
pub(crate) fn set_notebook_json(
    file_state: &FileState,
    script_state: &crate::scripting::ScriptState,
    object_id: String,
    json: &str,
) -> Result<(), String> {
    let mut new_notebook: crate::scripting::NotebookDocument =
        serde_json::from_str(json).map_err(|e| format!("Invalid notebook JSON: {}", e))?;
    if new_notebook.id != object_id {
        return Err(format!(
            "The notebook's id cannot be changed here: the JSON names '{}', the record is '{}'",
            new_notebook.id, object_id
        ));
    }
    let pending = script_state.workbook_notebooks.lock_pending().map_err(|e| e.to_string())?;
    let existing_package = match pending.get(&object_id) {
        Some(existing) => existing.source_package.clone(),
        None => return Err(format!("Notebook '{}' not found", object_id)),
    };
    new_notebook.source_package = crate::scripting::commands::sticky_source_package(
        new_notebook.source_package.take(),
        existing_package.as_deref(),
    );
    let effect = DocumentEffect::mutates(file_state);
    let mut notebooks = pending.authorize(&effect);
    notebooks.insert(object_id, new_notebook);
    Ok(())
}

// ============================================================================
// list_objects — Enumerate all configurable objects in the workbook
// ============================================================================

#[tauri::command]
pub fn list_objects(
    state: State<AppState>,
    slicer_state: State<crate::slicer::SlicerState>,
    ribbon_filter_state: State<crate::ribbon_filter::RibbonFilterState>,
    script_state: State<crate::scripting::ScriptState>,
    timeline_slicer_state: State<crate::timeline_slicer::TimelineSlicerState>,
    pivot_state: State<crate::pivot::PivotState>,
) -> Vec<ObjectEntry> {
    let mut entries = Vec::new();

    // Singleton objects
    entries.push(ObjectEntry {
        object_type: "theme".to_string(),
        object_id: "0".to_string(),
        label: "Document Theme".to_string(),
    });
    entries.push(ObjectEntry {
        object_type: "properties".to_string(),
        object_id: "0".to_string(),
        label: "Workbook Properties".to_string(),
    });

    // Charts
    {
        let charts = state.charts.read().unwrap();
        for chart in charts.iter() {
            entries.push(ObjectEntry {
                object_type: "chart".to_string(),
                object_id: chart.id.to_string(),
                label: format!("Chart {}", chart.id),
            });
        }
    }

    // Tables
    {
        let tables = state.tables.read().unwrap();
        for sheet_tables in tables.values() {
            for table in sheet_tables.values() {
                entries.push(ObjectEntry {
                    object_type: "table".to_string(),
                    object_id: table.id.to_string(),
                    label: format!("Table: {}", table.name),
                });
            }
        }
    }

    // Slicers
    {
        let slicers = slicer_state.slicers.read().unwrap();
        for slicer in slicers.values() {
            entries.push(ObjectEntry {
                object_type: "slicer".to_string(),
                object_id: slicer.id.to_string(),
                label: format!("Slicer: {}", slicer.name),
            });
        }
    }

    // Ribbon filters
    {
        let filters = ribbon_filter_state.filters.read().unwrap();
        for filter in filters.values() {
            entries.push(ObjectEntry {
                object_type: "ribbon_filter".to_string(),
                object_id: filter.id.to_string(),
                label: format!("Ribbon Filter: {}", filter.name),
            });
        }
    }

    // Timeline slicers
    {
        let timelines = timeline_slicer_state.timelines.read().unwrap();
        for timeline in timelines.values() {
            entries.push(ObjectEntry {
                object_type: "timeline_slicer".to_string(),
                object_id: timeline.id.to_string(),
                label: format!("Timeline: {}", timeline.name),
            });
        }
    }

    // Sparklines
    {
        let sparklines = state.sparklines.read().unwrap();
        for (idx, entry) in sparklines.iter().enumerate() {
            entries.push(ObjectEntry {
                object_type: "sparkline".to_string(),
                object_id: idx.to_string(),
                label: format!("Sparklines (Sheet {})", entry.sheet_index),
            });
        }
    }

    // Scripts
    {
        let scripts = script_state.workbook_scripts.read().unwrap();
        for script in scripts.values() {
            entries.push(ObjectEntry {
                object_type: "script".to_string(),
                object_id: script.id.clone(),
                label: format!("Script: {}", script.name),
            });
        }
    }

    // Notebooks
    {
        let notebooks = script_state.workbook_notebooks.read().unwrap();
        for notebook in notebooks.values() {
            entries.push(ObjectEntry {
                object_type: "notebook".to_string(),
                object_id: notebook.id.clone(),
                label: format!("Notebook: {}", notebook.name),
            });
        }
    }

    // Pivot tables
    {
        let pivot_tables = pivot_state.pivot_tables.read().unwrap();
        for (id, (definition, _cache)) in pivot_tables.iter() {
            entries.push(ObjectEntry {
                object_type: "pivot".to_string(),
                object_id: id.to_string(),
                label: format!("Pivot: {}", definition.name.as_deref().unwrap_or("Untitled")),
            });
        }
    }

    // Pivot layouts
    {
        let layouts = state.pivot_layouts.read().unwrap();
        for layout in layouts.iter() {
            entries.push(ObjectEntry {
                object_type: "pivot_layout".to_string(),
                object_id: layout.id.to_string(),
                label: format!("Pivot Layout: {}", layout.name),
            });
        }
    }

    entries
}

// ============================================================================
// get_workbook_tree — Lightweight tree summary of the entire workbook structure
// ============================================================================

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TreeNode {
    pub label: String,
    pub object_type: Option<String>,
    pub object_id: Option<String>,
    pub children: Vec<TreeNode>,
}

#[tauri::command]
pub fn get_workbook_tree(
    state: State<AppState>,
    slicer_state: State<crate::slicer::SlicerState>,
    ribbon_filter_state: State<crate::ribbon_filter::RibbonFilterState>,
    script_state: State<crate::scripting::ScriptState>,
    timeline_slicer_state: State<crate::timeline_slicer::TimelineSlicerState>,
    pivot_state: State<crate::pivot::PivotState>,
) -> TreeNode {
    let mut root = TreeNode {
        label: "Workbook".to_string(),
        object_type: None,
        object_id: None,
        children: Vec::new(),
    };

    // Workbook-level singletons
    {
        let workbook_node = TreeNode {
            label: "Workbook Settings".to_string(),
            object_type: None,
            object_id: None,
            children: vec![
                TreeNode {
                    label: "Document Theme".to_string(),
                    object_type: Some("theme".to_string()),
                    object_id: Some("0".to_string()),
                    children: Vec::new(),
                },
                TreeNode {
                    label: "Workbook Properties".to_string(),
                    object_type: Some("properties".to_string()),
                    object_id: Some("0".to_string()),
                    children: Vec::new(),
                },
            ],
        };
        root.children.push(workbook_node);
    }

    // Sheets
    {
        let sheet_names = state.sheet_names.read().unwrap();
        let mut sheets_node = TreeNode {
            label: format!("Sheets ({})", sheet_names.len()),
            object_type: None,
            object_id: None,
            children: Vec::new(),
        };
        for (idx, name) in sheet_names.iter().enumerate() {
            // Each sheet is a branch with two inspectable facets: its Layout
            // (column/row sizes) and its Cells (the sparse grid contents). The
            // parent row carries no object_type so clicking it only expands.
            sheets_node.children.push(TreeNode {
                label: format!("{} (Sheet {})", name, idx),
                object_type: None,
                object_id: None,
                children: vec![
                    TreeNode {
                        label: "Layout".to_string(),
                        object_type: Some("sheet_layout".to_string()),
                        object_id: Some(idx.to_string()),
                        children: Vec::new(),
                    },
                    TreeNode {
                        label: "Cells".to_string(),
                        object_type: Some("sheet_data".to_string()),
                        object_id: Some(idx.to_string()),
                        children: Vec::new(),
                    },
                ],
            });
        }
        root.children.push(sheets_node);
    }

    // Tables
    {
        let tables = state.tables.read().unwrap();
        let all_tables: Vec<_> = tables.values()
            .flat_map(|sheet_tables| sheet_tables.values())
            .collect();
        if !all_tables.is_empty() {
            let mut node = TreeNode {
                label: format!("Tables ({})", all_tables.len()),
                object_type: None,
                object_id: None,
                children: Vec::new(),
            };
            for table in all_tables {
                node.children.push(TreeNode {
                    label: table.name.clone(),
                    object_type: Some("table".to_string()),
                    object_id: Some(table.id.to_string()),
                    children: Vec::new(),
                });
            }
            root.children.push(node);
        }
    }

    // Charts
    {
        let charts = state.charts.read().unwrap();
        if !charts.is_empty() {
            let mut node = TreeNode {
                label: format!("Charts ({})", charts.len()),
                object_type: None,
                object_id: None,
                children: Vec::new(),
            };
            for chart in charts.iter() {
                node.children.push(TreeNode {
                    label: format!("Chart {}", chart.id),
                    object_type: Some("chart".to_string()),
                    object_id: Some(chart.id.to_string()),
                    children: Vec::new(),
                });
            }
            root.children.push(node);
        }
    }

    // Slicers
    {
        let slicers = slicer_state.slicers.read().unwrap();
        if !slicers.is_empty() {
            let mut node = TreeNode {
                label: format!("Slicers ({})", slicers.len()),
                object_type: None,
                object_id: None,
                children: Vec::new(),
            };
            for slicer in slicers.values() {
                node.children.push(TreeNode {
                    label: slicer.name.clone(),
                    object_type: Some("slicer".to_string()),
                    object_id: Some(slicer.id.to_string()),
                    children: Vec::new(),
                });
            }
            root.children.push(node);
        }
    }

    // Ribbon Filters
    {
        let filters = ribbon_filter_state.filters.read().unwrap();
        if !filters.is_empty() {
            let mut node = TreeNode {
                label: format!("Ribbon Filters ({})", filters.len()),
                object_type: None,
                object_id: None,
                children: Vec::new(),
            };
            for filter in filters.values() {
                node.children.push(TreeNode {
                    label: filter.name.clone(),
                    object_type: Some("ribbon_filter".to_string()),
                    object_id: Some(filter.id.to_string()),
                    children: Vec::new(),
                });
            }
            root.children.push(node);
        }
    }

    // Timeline Slicers
    {
        let timelines = timeline_slicer_state.timelines.read().unwrap();
        if !timelines.is_empty() {
            let mut node = TreeNode {
                label: format!("Timeline Slicers ({})", timelines.len()),
                object_type: None,
                object_id: None,
                children: Vec::new(),
            };
            for timeline in timelines.values() {
                node.children.push(TreeNode {
                    label: timeline.name.clone(),
                    object_type: Some("timeline_slicer".to_string()),
                    object_id: Some(timeline.id.to_string()),
                    children: Vec::new(),
                });
            }
            root.children.push(node);
        }
    }

    // Sparklines
    {
        let sparklines = state.sparklines.read().unwrap();
        if !sparklines.is_empty() {
            let mut node = TreeNode {
                label: format!("Sparklines ({})", sparklines.len()),
                object_type: None,
                object_id: None,
                children: Vec::new(),
            };
            for (idx, entry) in sparklines.iter().enumerate() {
                node.children.push(TreeNode {
                    label: format!("Sheet {}", entry.sheet_index),
                    object_type: Some("sparkline".to_string()),
                    object_id: Some(idx.to_string()),
                    children: Vec::new(),
                });
            }
            root.children.push(node);
        }
    }

    // Scripts
    {
        let scripts = script_state.workbook_scripts.read().unwrap();
        if !scripts.is_empty() {
            let mut node = TreeNode {
                label: format!("Scripts ({})", scripts.len()),
                object_type: None,
                object_id: None,
                children: Vec::new(),
            };
            for script in scripts.values() {
                node.children.push(TreeNode {
                    label: script.name.clone(),
                    object_type: Some("script".to_string()),
                    object_id: Some(script.id.clone()),
                    children: Vec::new(),
                });
            }
            root.children.push(node);
        }
    }

    // Notebooks
    {
        let notebooks = script_state.workbook_notebooks.read().unwrap();
        if !notebooks.is_empty() {
            let mut node = TreeNode {
                label: format!("Notebooks ({})", notebooks.len()),
                object_type: None,
                object_id: None,
                children: Vec::new(),
            };
            for notebook in notebooks.values() {
                node.children.push(TreeNode {
                    label: notebook.name.clone(),
                    object_type: Some("notebook".to_string()),
                    object_id: Some(notebook.id.clone()),
                    children: Vec::new(),
                });
            }
            root.children.push(node);
        }
    }

    // Pivot Tables
    {
        let pivot_tables = pivot_state.pivot_tables.read().unwrap();
        if !pivot_tables.is_empty() {
            let mut node = TreeNode {
                label: format!("Pivot Tables ({})", pivot_tables.len()),
                object_type: None,
                object_id: None,
                children: Vec::new(),
            };
            for (id, (definition, _cache)) in pivot_tables.iter() {
                node.children.push(TreeNode {
                    label: definition.name.clone().unwrap_or_else(|| "Untitled".to_string()),
                    object_type: Some("pivot".to_string()),
                    object_id: Some(id.to_string()),
                    children: Vec::new(),
                });
            }
            root.children.push(node);
        }
    }

    // Pivot Layouts
    {
        let layouts = state.pivot_layouts.read().unwrap();
        if !layouts.is_empty() {
            let mut node = TreeNode {
                label: format!("Pivot Layouts ({})", layouts.len()),
                object_type: None,
                object_id: None,
                children: Vec::new(),
            };
            for layout in layouts.iter() {
                node.children.push(TreeNode {
                    label: layout.name.clone(),
                    object_type: Some("pivot_layout".to_string()),
                    object_id: Some(layout.id.to_string()),
                    children: Vec::new(),
                });
            }
            root.children.push(node);
        }
    }

    root
}

#[cfg(test)]
mod tests {
    //! rev10B: the JSON view's `script` edit goes through the script store's one
    //! writer -- the custom-function forget and sticky provenance included.
    use super::set_script_json;
    use crate::persistence::FileState;
    use crate::scripting::types::{ScriptState, WorkbookScript};

    fn record(id: &str, source: &str, source_package: Option<&str>) -> WorkbookScript {
        WorkbookScript {
            id: id.to_string(),
            name: id.to_string(),
            description: None,
            source: source.to_string(),
            scope: Default::default(),
            source_package: source_package.map(str::to_string),
        }
    }

    fn library(body: &str) -> String {
        serde_json::json!({ "functions": [{ "name": "MYFN", "params": ["x"], "body": body }], "capabilities": [] })
            .to_string()
    }

    /// A Custom Functions library edited in the JSON view kept the old code's
    /// answers in the results cache, so F9 and the save served them as current.
    ///
    /// SABOTAGE: the `script` arm inserts the record directly again.
    #[test]
    fn a_library_edited_as_json_forgets_the_old_codes_answers() {
        let state = crate::create_app_state();
        let file = FileState::default();
        let scripts = ScriptState::new();
        crate::scripting::commands::save_script_core(
            &state,
            &file,
            &scripts,
            record("__calcula_custom_functions__", &library("return x*10;"), None),
        )
        .expect("the library saves");
        let memo = state.grids.read().unwrap()[0].call_memo().clone();
        let call = engine::cube::udf_call_fingerprint("MYFN", &[engine::EvalResult::Number(4.0)]).unwrap();
        memo.remember(call.clone(), &engine::EvalResult::Number(40.0));
        assert_eq!(memo.answer(&call), Some(engine::EvalResult::Number(40.0)), "precondition: remembered");

        assert!(!memo.holds_custom_function("MYFN"), "precondition: the authoring Save holds nothing");

        let json = serde_json::to_string(&record("__calcula_custom_functions__", &library("return x*100;"), None)).unwrap();
        let generation = set_script_json(&state, &file, &scripts, "__calcula_custom_functions__".to_string(), &json)
            .expect("the JSON edit applies");
        assert!(
            scripts.workbook_scripts.read().unwrap()["__calcula_custom_functions__"].source.contains("x*100"),
            "precondition: the new code is stored"
        );
        assert_eq!(memo.answer(&call), None, "the JSON edit kept the OLD code's MYFN(4) = 40");
        // rev12C: the page's OLD realm still runs x*10 until it re-installs, so
        // what it serves next must not be filed -- MYFN is held, and the door
        // hands back the generation `set_object_json` announces as
        // `custom-functions:refresh`.
        assert!(
            memo.holds_custom_function("MYFN"),
            "MYFN is not held: the old realm's next MYFN(4) = 40 would be filed as current"
        );
        // (Process-wide and bumped by parallel tests, so only its presence and
        // order are asserted.)
        assert!(
            generation.is_some_and(|g| g > 0 && g <= crate::bi::cube::custom_function_library_generation()),
            "the JSON edit names no generation for the page to re-install: {generation:?}"
        );
        // An unchanged library re-applied holds nothing new and announces nothing.
        assert_eq!(
            set_script_json(&state, &file, &scripts, "__calcula_custom_functions__".to_string(), &json)
                .expect("the same JSON applies"),
            None
        );
        // ...and the command emits what this door returns.
        let src = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/src/json_view.rs")).unwrap();
        let body = &src[src.find("pub fn set_object_json(").unwrap()..src.find("pub(crate) fn set_script_json(").unwrap()];
        assert!(
            body.contains("\"custom-functions:refresh\"") && body.contains("library_generation.set("),
            "set_object_json no longer announces a library the JSON view changed"
        );
    }

    /// A distributed module edited in the JSON view with its `sourcePackage`
    /// left out became local code -- the laundering `save_script` refuses.
    #[test]
    fn a_distributed_module_edited_as_json_keeps_its_provenance() {
        let state = crate::create_app_state();
        let file = FileState::default();
        let scripts = ScriptState::new();
        crate::scripting::commands::save_script_core(&state, &file, &scripts, record("m1", "a();", Some("sales")))
            .expect("the module saves");
        let json = serde_json::json!({ "id": "m1", "name": "m1", "description": null, "source": "b();" }).to_string();
        set_script_json(&state, &file, &scripts, "m1".to_string(), &json).expect("the JSON edit applies");
        let stored = scripts.workbook_scripts.read().unwrap()["m1"].clone();
        assert_eq!(stored.source, "b();", "precondition: the edit landed");
        assert_eq!(stored.source_package.as_deref(), Some("sales"), "the JSON edit laundered the module into local code");
    }

    /// An id that does not resolve -- or a JSON that renames the record -- is
    /// refused, nothing is written and the document stays clean.
    #[test]
    fn an_unknown_or_renamed_script_is_refused_and_leaves_the_document_clean() {
        let state = crate::create_app_state();
        let scripts = ScriptState::new();
        crate::scripting::commands::save_script_core(&state, &FileState::default(), &scripts, record("m1", "a();", None))
            .expect("the module saves");
        let file = FileState::default();
        let missing = serde_json::to_string(&record("nope", "x();", None)).unwrap();
        let err = set_script_json(&state, &file, &scripts, "nope".to_string(), &missing).unwrap_err();
        assert!(err.contains("not found"), "{err}");
        let renamed = serde_json::to_string(&record("m2", "x();", None)).unwrap();
        let err = set_script_json(&state, &file, &scripts, "m1".to_string(), &renamed).unwrap_err();
        assert!(err.contains("cannot be changed"), "{err}");
        assert!(!file.is_dirty(), "a refused JSON edit dirtied the document");
        let stored = scripts.workbook_scripts.read().unwrap();
        assert_eq!(stored.len(), 1, "a refused JSON edit wrote a record");
        assert_eq!(stored["m1"].source, "a();");
    }

    // ---- the `notebook` arm (calpfg remaining): same two rules ----

    fn notebook_json(id: &str, source: &str, source_package: Option<&str>) -> String {
        let mut v = serde_json::json!({
            "id": id,
            "name": id,
            "cells": [{ "id": format!("{id}-c1"), "source": source, "lastError": null, "executionIndex": null }],
        });
        if let Some(p) = source_package {
            v["sourcePackage"] = serde_json::json!(p);
        }
        v.to_string()
    }

    fn seed_notebook(scripts: &ScriptState, id: &str, source: &str, source_package: Option<&str>) {
        let nb: crate::scripting::NotebookDocument =
            serde_json::from_str(&notebook_json(id, source, source_package)).unwrap();
        scripts
            .workbook_notebooks
            .write(&crate::document_effect::test_seed_effect())
            .unwrap()
            .insert(id.to_string(), nb);
    }

    /// A distributed notebook edited in the JSON view with its `sourcePackage`
    /// left out became local code -- the laundering `notebook_save` refuses.
    ///
    /// SABOTAGE: the `notebook` arm inserts the record verbatim again.
    #[test]
    fn a_distributed_notebook_edited_as_json_keeps_its_provenance() {
        let scripts = ScriptState::new();
        seed_notebook(&scripts, "nb1", "a();", Some("sales"));
        let file = FileState::default();
        super::set_notebook_json(&file, &scripts, "nb1".to_string(), &notebook_json("nb1", "b();", None))
            .expect("the JSON edit applies");
        let stored = scripts.workbook_notebooks.read().unwrap()["nb1"].clone();
        assert_eq!(stored.cells[0].source, "b();", "precondition: the edit landed");
        assert!(file.is_dirty(), "a landed JSON edit dirties the document");
        assert_eq!(
            stored.source_package.as_deref(),
            Some("sales"),
            "the JSON edit laundered the distributed notebook into local code"
        );
    }

    /// An id that does not resolve -- or a JSON that renames the record -- is
    /// refused, nothing is written and the document stays clean.
    ///
    /// SABOTAGE: mint the effect before the not-found refusal again.
    #[test]
    fn an_unknown_or_renamed_notebook_is_refused_and_leaves_the_document_clean() {
        let scripts = ScriptState::new();
        seed_notebook(&scripts, "nb1", "a();", None);
        let file = FileState::default();
        let err = super::set_notebook_json(&file, &scripts, "nope".to_string(), &notebook_json("nope", "x();", None))
            .unwrap_err();
        assert!(err.contains("not found"), "{err}");
        assert!(!file.is_dirty(), "a JSON edit of a notebook that does not exist dirtied the document");
        let err = super::set_notebook_json(&file, &scripts, "nb1".to_string(), &notebook_json("nb2", "x();", None))
            .unwrap_err();
        assert!(err.contains("cannot be changed"), "{err}");
        assert!(!file.is_dirty(), "a refused JSON edit dirtied the document");
        let stored = scripts.workbook_notebooks.read().unwrap();
        assert_eq!(stored.len(), 1, "a refused JSON edit wrote a record");
        assert_eq!(stored["nb1"].cells[0].source, "a();");
    }
}
