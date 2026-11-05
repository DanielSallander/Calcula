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
/// The decision is taken PER ARM, inside the critical section that writes: each arm
/// resolves its object, runs every gate, compares the replacement with what is stored
/// (`json_differs`), and only then mints its `DocumentEffect` -- so a refusal AND an
/// apply that changes nothing (the user pressed Apply on the JSON they were shown)
/// both leave the document clean. The command used to mint one more effect on EVERY
/// `Ok` (rev-backend-3), which dirtied the workbook for an unchanged table or script
/// although those arms had decided not to write. A new arm therefore owns its effect:
/// `every_arm_leaves_an_unchanged_apply_clean_and_dirties_a_changed_one` drives every
/// arm both ways, so an arm that forgets to mint fails it (lost work is the worse
/// direction), and so does a blanket mint coming back.
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
    let stores = ObjectJsonStores {
        state: &state,
        file_state: &file_state,
        slicer_state: &slicer_state,
        ribbon_filter_state: &ribbon_filter_state,
        script_state: &script_state,
        timeline_slicer_state: &timeline_slicer_state,
        pivot_state: &pivot_state,
        user_files_state: &user_files_state,
        pane_control_state: &pane_control_state,
    };
    // A Custom Functions library edited here: the page re-installs it, and only
    // then are the held functions' served answers filed again (rev12C).
    if let Some(generation) = apply_object_json(&stores, &object_type, &object_id, &json)? {
        let _ = tauri::Emitter::emit(
            &app,
            "custom-functions:refresh",
            crate::bi::cube::CustomFunctionsRefresh { generation },
        );
    }
    Ok(())
}

/// The stores [`set_object_json`] reaches, as plain references, so the whole
/// dispatch -- every arm -- can be driven by a test without a Tauri runtime.
pub(crate) struct ObjectJsonStores<'a> {
    pub(crate) state: &'a AppState,
    pub(crate) file_state: &'a FileState,
    pub(crate) slicer_state: &'a crate::slicer::SlicerState,
    pub(crate) ribbon_filter_state: &'a crate::ribbon_filter::RibbonFilterState,
    pub(crate) script_state: &'a crate::scripting::ScriptState,
    pub(crate) timeline_slicer_state: &'a crate::timeline_slicer::TimelineSlicerState,
    pub(crate) pivot_state: &'a crate::pivot::PivotState,
    pub(crate) user_files_state: &'a crate::persistence::UserFilesState,
    pub(crate) pane_control_state: &'a crate::pane_control::PaneControlState,
}

/// The body of [`set_object_json`]: dispatch to the object type's arm. Each
/// arm mints its OWN `DocumentEffect`, after its gates and only when the
/// replacement changes what is stored; nothing here mints one (rev-backend-3).
/// Returns the `script` arm's changed Custom Functions library generation, the
/// one the command announces as `custom-functions:refresh`.
pub(crate) fn apply_object_json(
    stores: &ObjectJsonStores<'_>,
    object_type: &str,
    object_id: &str,
    json: &str,
) -> Result<Option<u64>, String> {
    let state = stores.state;
    let fs = stores.file_state;
    let none = |r: Result<(), String>| r.map(|()| None);
    match object_type {
        "chart" => none(set_chart_json(state, fs, object_id, json)),
        "table" => none(set_table_json(
            state,
            fs,
            stores.user_files_state,
            stores.pivot_state,
            stores.pane_control_state,
            stores.ribbon_filter_state,
            object_id,
            json,
        )),
        "slicer" => none(set_slicer_json(state, fs, stores.slicer_state, object_id, json)),
        "ribbon_filter" => none(set_ribbon_filter_json(fs, stores.ribbon_filter_state, object_id, json)),
        "timeline_slicer" => none(set_timeline_json(state, fs, stores.timeline_slicer_state, object_id, json)),
        "sparkline" => none(set_sparkline_json(state, fs, object_id, json)),
        "script" => set_script_json(state, fs, stores.script_state, object_id.to_string(), json),
        "notebook" => none(set_notebook_json(fs, stores.script_state, object_id.to_string(), json)),
        "pivot" => none(set_pivot_json(state, fs, stores.pivot_state, object_id, json)),
        "pivot_layout" => none(set_pivot_layout_json(state, fs, object_id, json)),
        "theme" => {
            let new_theme: engine::ThemeDefinition =
                serde_json::from_str(json).map_err(|e| format!("Invalid theme JSON: {}", e))?;
            let pending = state.theme.lock_pending().map_err(|e| e.to_string())?;
            if !json_differs(&*pending, &new_theme) {
                return Ok(None);
            }
            let effect = DocumentEffect::mutates(fs);
            *pending.authorize(&effect) = new_theme;
            Ok(None)
        }
        "properties" => {
            let new_props: api_types::WorkbookProperties =
                serde_json::from_str(json).map_err(|e| format!("Invalid properties JSON: {}", e))?;
            let pending = state.workbook_properties.lock_pending().map_err(|e| e.to_string())?;
            if !json_differs(&*pending, &new_props) {
                return Ok(None);
            }
            let effect = DocumentEffect::mutates(fs);
            *pending.authorize(&effect) = new_props;
            Ok(None)
        }
        "sheet_layout" => none(set_sheet_layout_json(state, fs, object_id, json)),
        _ => Err(format!("Unknown object type: {}", object_type)),
    }
}

/// Does a JSON replacement change the stored object? Compared as the JSON
/// values this view shows and edits, so key order and whitespace are not a
/// change. A value that cannot be serialized counts as changed: the write then
/// goes ahead and dirties the document, the safe direction of the error.
pub(crate) fn json_differs<A: Serialize + ?Sized, B: Serialize + ?Sized>(existing: &A, replacement: &B) -> bool {
    match (serde_json::to_value(existing), serde_json::to_value(replacement)) {
        (Ok(a), Ok(b)) => a != b,
        _ => true,
    }
}

// The three arms below used to resolve under a read guard, DROP it, then take
// the write guard (rev-backend-4): a sparkline vector that shrank in between
// made `sparklines[idx] = ...` panic, and a filter or layout deleted in
// between was answered "not found" after the document had been dirtied. Each
// now resolves, compares and writes under ONE hold (`lock_pending`), the
// discipline of the chart, slicer, timeline and pivot arms.

/// The `ribbon_filter` arm of [`set_object_json`]: replace an EXISTING ribbon
/// filter.
pub(crate) fn set_ribbon_filter_json(
    fs: &FileState,
    ribbon_filter_state: &crate::ribbon_filter::RibbonFilterState,
    object_id: &str,
    json: &str,
) -> Result<(), String> {
    let id = identity::EntityId::parse(object_id).ok_or_else(|| "Invalid ribbon filter id".to_string())?;
    let new_filter: crate::ribbon_filter::RibbonFilter =
        serde_json::from_str(json).map_err(|e| format!("Invalid ribbon filter JSON: {}", e))?;
    let pending = ribbon_filter_state.filters.lock_pending().map_err(|e| e.to_string())?;
    let existing = pending.get(&id).ok_or_else(|| format!("Ribbon filter {} not found", id))?;
    if !json_differs(existing, &new_filter) {
        return Ok(());
    }
    let effect = DocumentEffect::mutates(fs);
    let mut filters = pending.authorize(&effect);
    filters.insert(id, new_filter);
    Ok(())
}

/// The `sparkline` arm of [`set_object_json`]: replace an EXISTING sparkline
/// entry, addressed by its index.
pub(crate) fn set_sparkline_json(state: &AppState, fs: &FileState, object_id: &str, json: &str) -> Result<(), String> {
    let idx: usize = object_id.parse().map_err(|_| "Invalid sparkline index".to_string())?;
    let new_entry: api_types::SparklineEntry =
        serde_json::from_str(json).map_err(|e| format!("Invalid sparkline JSON: {}", e))?;
    let pending = state.sparklines.lock_pending().map_err(|e| e.to_string())?;
    let existing = pending.get(idx).ok_or_else(|| format!("Sparkline entry {} not found", idx))?;
    if !json_differs(existing, &new_entry) {
        return Ok(());
    }
    let effect = DocumentEffect::mutates(fs);
    let mut sparklines = pending.authorize(&effect);
    sparklines[idx] = new_entry;
    Ok(())
}

/// The `pivot_layout` arm of [`set_object_json`]: replace an EXISTING saved
/// pivot layout.
pub(crate) fn set_pivot_layout_json(state: &AppState, fs: &FileState, object_id: &str, json: &str) -> Result<(), String> {
    let id = identity::EntityId::parse(object_id).ok_or_else(|| "Invalid pivot layout id".to_string())?;
    let new_layout: ::persistence::SavedPivotLayout =
        serde_json::from_str(json).map_err(|e| format!("Invalid pivot layout JSON: {}", e))?;
    let pending = state.pivot_layouts.lock_pending().map_err(|e| e.to_string())?;
    let slot = pending
        .iter()
        .position(|l| l.id == id)
        .ok_or_else(|| format!("Pivot layout {} not found", id))?;
    if !json_differs(&pending[slot], &new_layout) {
        return Ok(());
    }
    let effect = DocumentEffect::mutates(fs);
    let mut layouts = pending.authorize(&effect);
    layouts[slot] = new_layout;
    Ok(())
}

/// The `sheet_layout` arm of [`set_object_json`]: replace a sheet's column
/// widths and row heights.
///
/// Written into the per-sheet vectors (so the change survives a sheet switch)
/// and, for the active sheet, mirrored into the live primary maps. UNCHANGED
/// is judged against what `get_object_json` showed: the live maps for the
/// active sheet (its per-sheet slot is stale by design), the per-sheet slot for
/// any other. The live maps are copied out one lock at a time and released
/// before the per-sheet vectors are taken, as the write below does, so no new
/// lock nesting is introduced.
pub(crate) fn set_sheet_layout_json(state: &AppState, fs: &FileState, object_id: &str, json: &str) -> Result<(), String> {
    let idx: usize = object_id.parse().map_err(|_| "Invalid sheet index".to_string())?;
    let layout: calcula_format::sheet_layout::SheetLayout =
        serde_json::from_str(json).map_err(|e| format!("Invalid sheet layout JSON: {}", e))?;
    let (col_widths, row_heights) = layout.to_dimensions();
    let shown_active = *state.active_sheet.read().unwrap() == idx;
    let live_unchanged = shown_active.then(|| {
        let cw = state.column_widths.read().unwrap().clone();
        let rh = state.row_heights.read().unwrap().clone();
        !json_differs(&calcula_format::sheet_layout::SheetLayout::from_dimensions(&cw, &rh), &layout)
    });
    // `lock_pending` because the bounds check can still REFUSE: minting
    // the effect first would leave a rejected edit with a dirty flag.
    let all_cw = state.all_column_widths.lock_pending().unwrap();
    let all_rh = state.all_row_heights.lock_pending().unwrap();
    if idx >= all_cw.len() || idx >= all_rh.len() {
        return Err(format!("Sheet {} not found", idx));
    }
    let unchanged = live_unchanged.unwrap_or_else(|| {
        !json_differs(
            &calcula_format::sheet_layout::SheetLayout::from_dimensions(&all_cw[idx], &all_rh[idx]),
            &layout,
        )
    });
    if unchanged {
        return Ok(());
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

// ============================================================================
// The object arms and LOCK OBJECTS (BUG-0656)
// ============================================================================
//
// The JSON object editor IS a user edit: what it replaces is what the user
// typed. So on a canvas page whose Lock Objects is on
// (`CanvasLayout::objects_locked`), a replacement that MOVES or RESIZES the
// object -- or takes it to another sheet -- is refused exactly as the geometry
// doors refuse it, with the same message, and a replacement that keeps the
// placement (a title, a colour, a field) goes through. Each arm resolves,
// decides and writes under ONE hold of its store (`lock_pending`), the
// BUG-0443 discipline every geometry door keeps, and every refusal -- an id
// that does not resolve, the lock -- comes before the `DocumentEffect`, so it
// leaves the document clean. (Undo and redo are NOT asked: restoring a state
// from history is not a user move -- see `sheets::ensure_canvas_objects_unlocked`.)

/// Does a JSON replacement move a slicer or a timeline: another sheet, or
/// another rectangle?
fn box_moves(before: (usize, f64, f64, f64, f64), after: (usize, f64, f64, f64, f64)) -> bool {
    before != after
}

/// The `chart` arm of [`set_object_json`]: replace an EXISTING chart.
pub(crate) fn set_chart_json(state: &AppState, fs: &FileState, object_id: &str, json: &str) -> Result<(), String> {
    let id = identity::EntityId::parse(object_id).ok_or_else(|| "Invalid chart id".to_string())?;
    let new_entry: api_types::ChartEntry =
        serde_json::from_str(json).map_err(|e| format!("Invalid chart JSON: {}", e))?;
    let pending = state.charts.lock_pending().map_err(|e| e.to_string())?;
    let slot = pending.iter().position(|c| c.id == id).ok_or_else(|| format!("Chart {} not found", id))?;
    if !json_differs(&pending[slot], &new_entry) {
        return Ok(());
    }
    if crate::chart_commands::chart_moves(&pending[slot], &new_entry) {
        crate::sheets::ensure_canvas_objects_unlocked(state, pending[slot].sheet_index, "move or resize a chart")?;
    }
    let effect = DocumentEffect::mutates(fs);
    let mut charts = pending.authorize(&effect);
    charts[slot] = new_entry;
    Ok(())
}

/// The `slicer` arm of [`set_object_json`]: replace an EXISTING slicer.
pub(crate) fn set_slicer_json(
    state: &AppState,
    fs: &FileState,
    slicer_state: &crate::slicer::SlicerState,
    object_id: &str,
    json: &str,
) -> Result<(), String> {
    let id = identity::EntityId::parse(object_id).ok_or_else(|| "Invalid slicer id".to_string())?;
    let new_slicer: crate::slicer::Slicer =
        serde_json::from_str(json).map_err(|e| format!("Invalid slicer JSON: {}", e))?;
    let pending = slicer_state.slicers.lock_pending().map_err(|e| e.to_string())?;
    let before = pending.get(&id).ok_or_else(|| format!("Slicer {} not found", id))?;
    if !json_differs(before, &new_slicer) {
        return Ok(());
    }
    if box_moves(
        (before.sheet_index, before.x, before.y, before.width, before.height),
        (new_slicer.sheet_index, new_slicer.x, new_slicer.y, new_slicer.width, new_slicer.height),
    ) {
        crate::sheets::ensure_canvas_objects_unlocked(state, before.sheet_index, "move or resize a slicer")?;
    }
    let effect = DocumentEffect::mutates(fs);
    let mut slicers = pending.authorize(&effect);
    slicers.insert(id, new_slicer);
    Ok(())
}

/// The `timeline_slicer` arm of [`set_object_json`]: replace an EXISTING
/// timeline slicer.
pub(crate) fn set_timeline_json(
    state: &AppState,
    fs: &FileState,
    timeline_state: &crate::timeline_slicer::TimelineSlicerState,
    object_id: &str,
    json: &str,
) -> Result<(), String> {
    let id = identity::EntityId::parse(object_id).ok_or_else(|| "Invalid timeline slicer id".to_string())?;
    let new_timeline: crate::timeline_slicer::TimelineSlicer =
        serde_json::from_str(json).map_err(|e| format!("Invalid timeline slicer JSON: {}", e))?;
    let pending = timeline_state.timelines.lock_pending().map_err(|e| e.to_string())?;
    let before = pending.get(&id).ok_or_else(|| format!("Timeline slicer {} not found", id))?;
    if !json_differs(before, &new_timeline) {
        return Ok(());
    }
    if box_moves(
        (before.sheet_index, before.x, before.y, before.width, before.height),
        (new_timeline.sheet_index, new_timeline.x, new_timeline.y, new_timeline.width, new_timeline.height),
    ) {
        crate::sheets::ensure_canvas_objects_unlocked(state, before.sheet_index, "move or resize a timeline")?;
    }
    let effect = DocumentEffect::mutates(fs);
    let mut timelines = pending.authorize(&effect);
    timelines.insert(id, new_timeline);
    Ok(())
}

/// The `pivot` arm of [`set_object_json`]: replace an EXISTING pivot's
/// definition. Lock Objects asks about its canvas BOX (`canvas_frame`): a
/// frame that appears, disappears, moves or resizes on a locked page is
/// refused; everything else in the definition is the pivot's content.
pub(crate) fn set_pivot_json(
    state: &AppState,
    fs: &FileState,
    pivot_state: &crate::pivot::PivotState,
    object_id: &str,
    json: &str,
) -> Result<(), String> {
    let id: pivot_engine::PivotId = serde_json::from_value(serde_json::Value::String(object_id.to_string()))
        .map_err(|_| "Invalid pivot id".to_string())?;
    let new_definition: pivot_engine::PivotDefinition =
        serde_json::from_str(json).map_err(|e| format!("Invalid pivot JSON: {}", e))?;
    // The box's page, resolved while `pivot_tables` is released (it takes the
    // sheet-name lock), as `update_bi_pivot`'s frame door resolves it.
    let page = {
        let current = pivot_state.pivot_tables.read().map_err(|e| e.to_string())?.get(&id).map(|(d, _)| d.clone());
        current.map(|d| crate::pivot::operations::resolve_dest_sheet_index(state, &d))
    };
    let pending = pivot_state.pivot_tables.lock_pending().map_err(|e| e.to_string())?;
    let (definition, _cache) = pending.get(&id).ok_or_else(|| format!("Pivot {} not found", object_id))?;
    if !json_differs(definition, &new_definition) {
        return Ok(());
    }
    let frame_moves = match (definition.canvas_frame.as_ref(), new_definition.canvas_frame.as_ref()) {
        (Some(old), Some(new)) => old.geometry_differs(new),
        (None, None) => false,
        _ => true,
    };
    if frame_moves {
        if let Some(page) = page {
            crate::sheets::ensure_canvas_objects_unlocked(state, page, "move or resize a PivotTable box")?;
        }
    }
    let effect = DocumentEffect::mutates(fs);
    let mut pivot_tables = pending.authorize(&effect);
    if let Some((definition, _cache)) = pivot_tables.get_mut(&id) {
        *definition = new_definition;
    }
    Ok(())
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
    // UNCHANGED is not an edit (rev-backend-3): the record as the store's one
    // writer would leave it (provenance is sticky) equals what is stored, so
    // nothing is written, nothing is forgotten and the document stays clean.
    // Decided under a read guard and answered with no write, so a concurrent
    // writer simply lands after this no-op.
    {
        let scripts = script_state.workbook_scripts.read().map_err(|e| e.to_string())?;
        if let Some(existing) = scripts.get(&object_id) {
            let mut candidate = new_script.clone();
            candidate.source_package = crate::scripting::commands::sticky_source_package(
                candidate.source_package.take(),
                existing.source_package.as_deref(),
            );
            if !json_differs(existing, &candidate) {
                return Ok(None);
            }
        }
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
    if pending.get(&object_id).is_some_and(|existing| !json_differs(existing, &new_notebook)) {
        return Ok(());
    }
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
            body.contains("\"custom-functions:refresh\"")
                && body.contains("if let Some(generation) = apply_object_json(")
                && body.contains("\"script\" => set_script_json("),
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

    // ---- rev-backend-3: every arm owns its dirty decision ----

    /// The stores `set_object_json` reaches, seeded with one object of every
    /// type the view edits.
    struct Fixture {
        state: crate::AppState,
        slicer: crate::slicer::SlicerState,
        filters: crate::ribbon_filter::RibbonFilterState,
        scripts: ScriptState,
        timelines: crate::timeline_slicer::TimelineSlicerState,
        pivots: crate::pivot::PivotState,
        files: crate::persistence::UserFilesState,
        pane: crate::pane_control::PaneControlState,
    }

    fn new_id() -> identity::EntityId {
        identity::EntityId::from_bytes(identity::generate_uuid_v7())
    }

    impl Fixture {
        fn apply(&self, file: &FileState, object_type: &str, object_id: &str, json: &str) -> Result<Option<u64>, String> {
            let stores = super::ObjectJsonStores {
                state: &self.state,
                file_state: file,
                slicer_state: &self.slicer,
                ribbon_filter_state: &self.filters,
                script_state: &self.scripts,
                timeline_slicer_state: &self.timelines,
                pivot_state: &self.pivots,
                user_files_state: &self.files,
                pane_control_state: &self.pane,
            };
            super::apply_object_json(&stores, object_type, object_id, json)
        }
    }

    /// One case: the object's type and id, the JSON the view SHOWS (applying
    /// it back changes nothing), an edited JSON, and how to read the stored
    /// object back.
    struct Case {
        object_type: &'static str,
        object_id: String,
        shown: String,
        edited: String,
        stored: Box<dyn Fn(&Fixture) -> serde_json::Value>,
    }

    fn pretty<T: serde::Serialize>(value: &T) -> String {
        serde_json::to_string_pretty(value).unwrap()
    }

    fn edited<T: serde::Serialize>(value: &T, edit: impl FnOnce(&mut serde_json::Value)) -> String {
        let mut v = serde_json::to_value(value).unwrap();
        edit(&mut v);
        serde_json::to_string_pretty(&v).unwrap()
    }

    fn seeded() -> (Fixture, Vec<Case>) {
        let seed = crate::document_effect::test_seed_effect();
        let fx = Fixture {
            state: crate::create_app_state(),
            slicer: crate::slicer::SlicerState::new(),
            filters: crate::ribbon_filter::RibbonFilterState::new(),
            scripts: ScriptState::new(),
            timelines: crate::timeline_slicer::TimelineSlicerState::new(),
            pivots: crate::pivot::PivotState::new(),
            files: crate::persistence::UserFilesState::default(),
            pane: crate::pane_control::PaneControlState::new(),
        };
        let mut cases = Vec::new();

        let chart = crate::api_types::ChartEntry {
            id: new_id(),
            sheet_index: 0,
            spec_json: serde_json::json!({ "name": "Chart 1", "x": 10.0, "y": 20.0, "width": 300.0, "height": 200.0, "spec": { "title": "Sales" } })
                .to_string(),
        };
        fx.state.charts.write(&seed).unwrap().push(chart.clone());
        let chart_id = chart.id;
        cases.push(Case {
            object_type: "chart",
            object_id: chart.id.to_string(),
            shown: pretty(&chart),
            edited: edited(&chart, |v| v["specJson"] = serde_json::json!(chart.spec_json.replace("Sales", "Revenue"))),
            stored: Box::new(move |fx| serde_json::to_value(fx.state.charts.read().unwrap().iter().find(|c| c.id == chart_id).unwrap()).unwrap()),
        });

        let table = crate::tables::Table {
            id: new_id(),
            name: "Sales".to_string(),
            sheet_index: 0,
            start_row: 0,
            start_col: 0,
            end_row: 3,
            end_col: 1,
            columns: vec![],
            style_options: crate::tables::TableStyleOptions::default(),
            style_name: "TableStyleMedium2".to_string(),
            auto_filter_id: None,
        };
        fx.state.tables.write(&seed).unwrap().entry(0).or_default().insert(table.id, table.clone());
        fx.state.table_names.write(&seed).unwrap().insert("SALES".to_string(), (0, table.id));
        let table_id = table.id;
        cases.push(Case {
            object_type: "table",
            object_id: table.id.to_string(),
            shown: pretty(&table),
            edited: edited(&table, |v| v["styleName"] = serde_json::json!("TableStyleMedium9")),
            stored: Box::new(move |fx| serde_json::to_value(&fx.state.tables.read().unwrap()[&0][&table_id]).unwrap()),
        });

        let slicer_id = new_id();
        let slicer: crate::slicer::Slicer = serde_json::from_value(serde_json::json!({
            "id": slicer_id.to_string(), "name": "Region", "sheetIndex": 0,
            "x": 10.0, "y": 300.0, "width": 180.0, "height": 240.0,
            "sourceType": "pivot", "cacheSourceId": slicer_id.to_string(), "fieldName": "Region",
            "selectedItems": null, "showHeader": true, "columns": 1,
            "stylePreset": "SlicerStyleLight1", "connectedSources": []
        }))
        .unwrap();
        fx.slicer.slicers.write(&seed).unwrap().insert(slicer_id, slicer.clone());
        cases.push(Case {
            object_type: "slicer",
            object_id: slicer_id.to_string(),
            shown: pretty(&slicer),
            edited: edited(&slicer, |v| v["name"] = serde_json::json!("Area")),
            stored: Box::new(move |fx| serde_json::to_value(&fx.slicer.slicers.read().unwrap()[&slicer_id]).unwrap()),
        });

        let filter = crate::ribbon_filter::RibbonFilter {
            id: new_id(),
            name: "Region".to_string(),
            connection_id: new_id(),
            data_source_id: None,
            field_name: "Sales.Region".to_string(),
            field_data_type: "text".to_string(),
            connection_mode: crate::ribbon_filter::ConnectionMode::Manual,
            connected_pivots: vec![],
            connected_sheets: vec![],
            connected_visuals: vec![],
            display_mode: Default::default(),
            selected_items: None,
            dependent_filters: vec![],
            dependent_slicers: vec![],
            advanced_filter: None,
            hide_no_data: false,
            indicate_no_data: true,
            sort_no_data_last: true,
            show_select_all: false,
            single_select: false,
            order: 0,
            button_columns: 2,
            button_rows: 0,
            filter_level: 1,
        };
        fx.filters.filters.write(&seed).unwrap().insert(filter.id, filter.clone());
        let filter_id = filter.id;
        cases.push(Case {
            object_type: "ribbon_filter",
            object_id: filter.id.to_string(),
            shown: pretty(&filter),
            edited: edited(&filter, |v| v["name"] = serde_json::json!("Area")),
            stored: Box::new(move |fx| serde_json::to_value(&fx.filters.filters.read().unwrap()[&filter_id]).unwrap()),
        });

        let timeline = crate::timeline_slicer::TimelineSlicer {
            id: new_id(),
            name: "Order Date".to_string(),
            header_text: None,
            sheet_index: 0,
            x: 10.0,
            y: 20.0,
            width: 350.0,
            height: 100.0,
            source_type: crate::timeline_slicer::TimelineSourceType::Pivot,
            source_id: new_id(),
            field_name: "OrderDate".to_string(),
            level: crate::timeline_slicer::TimelineLevel::Months,
            selection_start: None,
            selection_end: None,
            show_header: true,
            show_level_selector: true,
            show_scrollbar: true,
            style_preset: "TimelineStyleLight1".to_string(),
            connected_pivot_ids: vec![],
            container: None,
        };
        fx.timelines.timelines.write(&seed).unwrap().insert(timeline.id, timeline.clone());
        let timeline_id = timeline.id;
        cases.push(Case {
            object_type: "timeline_slicer",
            object_id: timeline.id.to_string(),
            shown: pretty(&timeline),
            edited: edited(&timeline, |v| v["name"] = serde_json::json!("Ship Date")),
            stored: Box::new(move |fx| serde_json::to_value(&fx.timelines.timelines.read().unwrap()[&timeline_id]).unwrap()),
        });

        let sparkline = crate::api_types::SparklineEntry { sheet_index: 0, groups_json: "[]".to_string() };
        fx.state.sparklines.write(&seed).unwrap().push(sparkline.clone());
        cases.push(Case {
            object_type: "sparkline",
            object_id: "0".to_string(),
            shown: pretty(&sparkline),
            edited: edited(&sparkline, |v| v["groupsJson"] = serde_json::json!("[{\"type\":\"line\"}]")),
            stored: Box::new(|fx| serde_json::to_value(&fx.state.sparklines.read().unwrap()[0]).unwrap()),
        });

        let script = record("m1", "a();", Some("sales"));
        crate::scripting::commands::save_script_core(&fx.state, &FileState::default(), &fx.scripts, script.clone())
            .expect("the module saves");
        cases.push(Case {
            object_type: "script",
            object_id: "m1".to_string(),
            shown: pretty(&script),
            edited: edited(&script, |v| v["source"] = serde_json::json!("b();")),
            stored: Box::new(|fx| serde_json::to_value(&fx.scripts.workbook_scripts.read().unwrap()["m1"]).unwrap()),
        });

        seed_notebook(&fx.scripts, "nb1", "a();", None);
        let notebook = fx.scripts.workbook_notebooks.read().unwrap()["nb1"].clone();
        cases.push(Case {
            object_type: "notebook",
            object_id: "nb1".to_string(),
            shown: pretty(&notebook),
            edited: edited(&notebook, |v| v["cells"][0]["source"] = serde_json::json!("b();")),
            stored: Box::new(|fx| serde_json::to_value(&fx.scripts.workbook_notebooks.read().unwrap()["nb1"]).unwrap()),
        });

        let pivot_id = new_id();
        let definition = pivot_engine::PivotDefinition::new(pivot_id, (0, 0), (2, 1));
        fx.pivots.pivot_tables.write(&seed).unwrap().insert(pivot_id, (definition.clone(), pivot_engine::PivotCache::new(pivot_id, 0)));
        cases.push(Case {
            object_type: "pivot",
            object_id: pivot_id.to_string(),
            shown: pretty(&definition),
            edited: edited(&definition, |v| v["name"] = serde_json::json!("Sales by region")),
            stored: Box::new(move |fx| serde_json::to_value(&fx.pivots.pivot_tables.read().unwrap()[&pivot_id].0).unwrap()),
        });

        let layout = ::persistence::SavedPivotLayout {
            id: new_id(),
            name: "Layout 1".to_string(),
            dsl_text: "ROWS: Region".to_string(),
            description: None,
            source_type: "table".to_string(),
            source_table_name: Some("Sales".to_string()),
            source_bi_tables: vec![],
            source_bi_measures: vec![],
            created_at: 1.0,
            updated_at: 1.0,
        };
        fx.state.pivot_layouts.write(&seed).unwrap().push(layout.clone());
        let layout_id = layout.id;
        cases.push(Case {
            object_type: "pivot_layout",
            object_id: layout.id.to_string(),
            shown: pretty(&layout),
            edited: edited(&layout, |v| v["name"] = serde_json::json!("Layout 2")),
            stored: Box::new(move |fx| {
                serde_json::to_value(fx.state.pivot_layouts.read().unwrap().iter().find(|l| l.id == layout_id).unwrap()).unwrap()
            }),
        });

        let theme = fx.state.theme.read().unwrap().clone();
        cases.push(Case {
            object_type: "theme",
            object_id: String::new(),
            shown: pretty(&theme),
            edited: edited(&theme, |v| v["name"] = serde_json::json!("My theme")),
            stored: Box::new(|fx| serde_json::to_value(&*fx.state.theme.read().unwrap()).unwrap()),
        });

        let props = fx.state.workbook_properties.read().unwrap().clone();
        cases.push(Case {
            object_type: "properties",
            object_id: String::new(),
            shown: pretty(&props),
            edited: edited(&props, |v| v["title"] = serde_json::json!("Budget")),
            stored: Box::new(|fx| serde_json::to_value(&*fx.state.workbook_properties.read().unwrap()).unwrap()),
        });

        // Sheet 0 (active: the live maps) and sheet 1 (its per-sheet slot).
        fx.state.column_widths.write(&seed).unwrap().insert(2, 90.0);
        fx.state.all_column_widths.write(&seed).unwrap().push(std::collections::HashMap::from([(4, 70.0)]));
        fx.state.all_row_heights.write(&seed).unwrap().push(std::collections::HashMap::new());
        let wider = calcula_format::sheet_layout::SheetLayout::from_dimensions(
            &std::collections::HashMap::from([(2, 90.0), (3, 120.0)]),
            &std::collections::HashMap::new(),
        );
        let active_shown = calcula_format::sheet_layout::SheetLayout::from_dimensions(
            &fx.state.column_widths.read().unwrap().clone(),
            &fx.state.row_heights.read().unwrap().clone(),
        );
        cases.push(Case {
            object_type: "sheet_layout",
            object_id: "0".to_string(),
            shown: pretty(&active_shown),
            edited: pretty(&wider),
            stored: Box::new(|fx| {
                let cw = fx.state.column_widths.read().unwrap().clone();
                let rh = fx.state.row_heights.read().unwrap().clone();
                serde_json::to_value(calcula_format::sheet_layout::SheetLayout::from_dimensions(&cw, &rh)).unwrap()
            }),
        });
        let other_shown = calcula_format::sheet_layout::SheetLayout::from_dimensions(
            &std::collections::HashMap::from([(4, 70.0)]),
            &std::collections::HashMap::new(),
        );
        cases.push(Case {
            object_type: "sheet_layout",
            object_id: "1".to_string(),
            shown: pretty(&other_shown),
            edited: pretty(&wider),
            stored: Box::new(|fx| {
                let cw = fx.state.all_column_widths.read().unwrap()[1].clone();
                let rh = fx.state.all_row_heights.read().unwrap()[1].clone();
                serde_json::to_value(calcula_format::sheet_layout::SheetLayout::from_dimensions(&cw, &rh)).unwrap()
            }),
        });
        (fx, cases)
    }

    /// rev-backend-3: `set_object_json` minted a `DocumentEffect` on EVERY
    /// `Ok`, so pressing Apply on the JSON the view showed -- an unchanged
    /// table or script, whose arms had decided not to write -- dirtied the
    /// workbook. Each arm now decides for itself: an unchanged apply leaves
    /// the document clean, and a changed one still dirties it (an arm that
    /// forgot to mint would lose the edit at the close prompt -- the worse
    /// direction).
    ///
    /// SABOTAGE: mint a blanket effect on `Ok` in `apply_object_json` again
    /// (every arm's unchanged apply dirties); separately, make the sparkline
    /// arm mint a clean effect (its changed apply stays clean).
    #[test]
    fn every_arm_leaves_an_unchanged_apply_clean_and_dirties_a_changed_one() {
        let (fx, cases) = seeded();
        let types: std::collections::BTreeSet<&str> = cases.iter().map(|c| c.object_type).collect();
        assert_eq!(types.len(), 13, "every object type the view writes has a case: {types:?}");
        let mut failures: Vec<String> = Vec::new();
        for case in &cases {
            let what = format!("{} {:?}", case.object_type, case.object_id);
            let before = (case.stored)(&fx);
            let clean = FileState::default();
            match fx.apply(&clean, case.object_type, &case.object_id, &case.shown) {
                Ok(_) => {}
                Err(e) => failures.push(format!("{what}: the shown JSON was refused: {e}")),
            }
            if clean.is_dirty() {
                failures.push(format!("{what}: applying the JSON the view showed dirtied the workbook"));
            }
            if (case.stored)(&fx) != before {
                failures.push(format!("{what}: an unchanged apply changed the stored object"));
            }
            let dirty = FileState::default();
            match fx.apply(&dirty, case.object_type, &case.object_id, &case.edited) {
                Ok(_) => {}
                Err(e) => failures.push(format!("{what}: the edited JSON was refused: {e}")),
            }
            let wanted: serde_json::Value = serde_json::from_str(&case.edited).unwrap();
            let stored = (case.stored)(&fx);
            if stored != wanted {
                failures.push(format!("{what}: the edit did not land: {stored} != {wanted}"));
            }
            if !dirty.is_dirty() {
                failures.push(format!("{what}: a CHANGED apply left the workbook clean -- the edit would be lost at close"));
            }
        }
        assert!(failures.is_empty(), "{failures:#?}");
    }

    /// rev-backend-4: the ribbon_filter, sparkline and pivot_layout arms
    /// resolved under a read guard, DROPPED it, then wrote -- a sparkline
    /// vector that shrank in between made `sparklines[idx] = ...` panic. Each
    /// now resolves, compares and writes under ONE `lock_pending` hold.
    ///
    /// SABOTAGE: give the sparkline arm its read-check-drop-write again.
    #[test]
    fn the_filter_sparkline_and_layout_arms_resolve_and_write_under_one_hold() {
        // The source as COMPILED into this test, not as it is on disk when it runs.
        let src = include_str!("json_view.rs");
        for door in [
            "pub(crate) fn set_ribbon_filter_json(",
            "pub(crate) fn set_sparkline_json(",
            "pub(crate) fn set_pivot_layout_json(",
        ] {
            let start = src.find(door).unwrap_or_else(|| panic!("{door} is gone"));
            let body = &src[start..];
            let body = &body[..body.find("\n}\n").unwrap()];
            assert!(
                body.contains(".lock_pending()") && body.contains("pending.authorize(&effect)"),
                "{door} no longer decides and writes under one held lock"
            );
            assert!(
                !body.contains(".read()") && !body.contains(".write(&effect)"),
                "{door} resolves under one guard and writes under another again (a TOCTOU window)"
            );
        }
        // And the dispatch reaches each of them.
        let dispatch = &src[src.find("pub(crate) fn apply_object_json(").unwrap()..];
        let dispatch = &dispatch[..dispatch.find("\n}\n").unwrap()];
        for arm in ["set_ribbon_filter_json(", "set_sparkline_json(", "set_pivot_layout_json("] {
            assert!(dispatch.contains(arm), "apply_object_json no longer dispatches to {arm}");
        }
        // An index past the end is a refusal, never a panic.
        let (fx, _) = seeded();
        let file = FileState::default();
        let entry = serde_json::json!({ "sheetIndex": 0, "groupsJson": "[]" }).to_string();
        let err = fx.apply(&file, "sparkline", "7", &entry).unwrap_err();
        assert!(err.contains("not found"), "{err}");
        assert!(!file.is_dirty(), "a refused sparkline edit dirtied the document");
    }
}
