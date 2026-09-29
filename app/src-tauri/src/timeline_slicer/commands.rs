//! FILENAME: app/src-tauri/src/timeline_slicer/commands.rs
//! PURPOSE: Tauri commands for timeline slicer CRUD and data retrieval.
//! CONTEXT: Manages timeline slicer state, generates timeline periods from
//!          pivot field date values, and bridges selection to pivot filters.

use crate::pivot::PivotState;
use crate::timeline_slicer::types::*;
use pivot_engine::{PivotId, VALUE_ID_EMPTY};
use std::collections::HashSet;
use tauri::State;

use crate::log_debug;

// ============================================================================
// CRUD COMMANDS
// ============================================================================
//
// UNDO (W1, wave C). Every command here records its step through the GUARDED
// JOIN (`undo_commands::record_restores_joining_open_transaction`): a MEMBER
// of the caller's open transaction, or a one-shot step of its own when none is
// open. They used to run an unconditional `begin_transaction` /
// `commit_transaction` pair -- and since `begin` is a no-op while a
// transaction is open but `commit` is NOT, each one COMMITTED the caller's
// transaction halfway through: a timeline selection split from the pivot
// filter it drove (two Ctrl+Z steps, and a decline that had to take the
// selection's step back separately, by its history id -- a way of naming a
// step that is gone now), and a timeline in a canvas-wide Delete split that
// Delete into two steps.
//
// DIRTY FLAG. Every refusal (an unknown id, a protected sheet) runs BEFORE the
// effect, under the same `lock_pending` hold as the write, and a request that
// changes nothing mints no effect and records nothing. The update commands used
// to mint the effect before their id lookup, so an unknown id dirtied the
// document it then refused to change.

/// Create a new timeline slicer.
#[tauri::command]
pub fn create_timeline_slicer(
    state: State<crate::AppState>,
    timeline_state: State<TimelineSlicerState>,
    file_state: State<'_, crate::persistence::FileState>,
    params: CreateTimelineParams,
) -> Result<TimelineSlicer, String> {
    create_timeline_slicer_core(&state, &timeline_state, &file_state, params)
}

/// [`create_timeline_slicer`] over plain references, for the unit tier.
pub(crate) fn create_timeline_slicer_core(
    state: &crate::AppState,
    timeline_state: &TimelineSlicerState,
    file_state: &crate::persistence::FileState,
    params: CreateTimelineParams,
) -> Result<TimelineSlicer, String> {
    let id = identity::EntityId::from_bytes(identity::generate_uuid_v7());

    let timeline = TimelineSlicer {
        id,
        name: params.name,
        header_text: None,
        sheet_index: params.sheet_index,
        x: params.x,
        y: params.y,
        width: params.width.unwrap_or(350.0),
        height: params.height.unwrap_or(100.0),
        source_type: TimelineSourceType::Pivot,
        source_id: params.source_id,
        field_name: params.field_name,
        level: params.level.unwrap_or_default(),
        selection_start: None,
        selection_end: None,
        show_header: true,
        show_level_selector: true,
        show_scrollbar: true,
        style_preset: params
            .style_preset
            .unwrap_or_else(|| "TimelineStyleLight1".to_string()),
        connected_pivot_ids: vec![],
    };

    log_debug!(
        "TIMELINE",
        "create_timeline_slicer id={} name={} source=pivot:{}",
        id,
        timeline.name,
        timeline.source_id
    );

    let result = timeline.clone();
    // Nothing above can still refuse, so the effect is minted here and its
    // existence IS the proof the document was dirtied.
    let effect = crate::document_effect::DocumentEffect::mutates(file_state);
    timeline_state
        .timelines
        .write(&effect)
        .map_err(|e| e.to_string())?
        .insert(id, timeline);

    // Undo of a create is a delete, so only the id is recorded -- after the
    // store guard dropped (never both held).
    crate::undo_commands::record_restores_joining_open_transaction(
        state,
        "Create timeline slicer",
        vec![crate::undo_commands::timeline_create_restore(id)],
    );

    Ok(result)
}

/// Delete a timeline slicer.
///
/// Gated like a slicer's or a chart's delete (`editObjects`), BEFORE the
/// effect: a canvas-wide Delete of a mixed selection relies on each family
/// refusing what the sheet forbids. A MEMBER of an open transaction, so a
/// canvas-wide "Delete Objects" is one Ctrl+Z step with the timelines in it.
#[tauri::command]
pub fn delete_timeline_slicer(
    state: State<crate::AppState>,
    file_state: State<'_, crate::persistence::FileState>,
    timeline_state: State<TimelineSlicerState>,
    timeline_id: identity::EntityId,
) -> Result<(), String> {
    delete_timeline_slicer_core(&state, &timeline_state, &file_state, timeline_id)
}

/// [`delete_timeline_slicer`] over plain references, for the unit tier.
pub(crate) fn delete_timeline_slicer_core(
    state: &crate::AppState,
    timeline_state: &TimelineSlicerState,
    file_state: &crate::persistence::FileState,
    timeline_id: identity::EntityId,
) -> Result<(), String> {
    log_debug!("TIMELINE", "delete_timeline_slicer id={}", timeline_id);

    // Presence and protection can still REFUSE, so both run before the effect,
    // in ONE critical section with the removal -- Tauri dispatches on a thread
    // pool, so read / drop / re-lock would be a TOCTOU window. The protection
    // read is a leaf lock taken under it (as `update_timeline_position_core`).
    let pending = timeline_state
        .timelines
        .lock_pending()
        .map_err(|e| e.to_string())?;
    let sheet_index = pending
        .get(&timeline_id)
        .map(|t| t.sheet_index)
        .ok_or_else(|| format!("Timeline slicer {} not found", timeline_id))?;
    crate::protection::check_sheet_action(state, sheet_index, "editObjects", "delete a timeline")?;
    let effect = crate::document_effect::DocumentEffect::mutates(file_state);
    // BIND the removed value -- undoing a delete needs the whole object.
    let removed = pending.authorize(&effect).remove(&timeline_id);

    if let Some(previous) = removed {
        crate::undo_commands::record_restores_joining_open_transaction(
            state,
            "Delete timeline slicer",
            vec![crate::undo_commands::timeline_delete_restore(timeline_id, previous)],
        );
    }
    // C10: a deleted timeline must not leave its object script mounted/persisted.
    crate::scripting::object_script_commands::prune_scripts_for_instance(state, &effect, &timeline_id.to_string());

    Ok(())
}

/// Update timeline slicer properties.
#[tauri::command]
pub fn update_timeline_slicer(
    state: State<crate::AppState>,
    timeline_state: State<TimelineSlicerState>,
    file_state: State<'_, crate::persistence::FileState>,
    timeline_id: identity::EntityId,
    params: UpdateTimelineParams,
) -> Result<TimelineSlicer, String> {
    update_timeline_slicer_core(&state, &timeline_state, &file_state, timeline_id, params)
}

/// [`update_timeline_slicer`] over plain references, for the unit tier.
pub(crate) fn update_timeline_slicer_core(
    state: &crate::AppState,
    timeline_state: &TimelineSlicerState,
    file_state: &crate::persistence::FileState,
    timeline_id: identity::EntityId,
    params: UpdateTimelineParams,
) -> Result<TimelineSlicer, String> {
    log_debug!("TIMELINE", "update_timeline_slicer id={}", timeline_id);

    let mut next = None;
    let recorded = update_timeline_with(state, timeline_state, file_state, timeline_id, "Update timeline slicer", |tl| {
        if let Some(name) = params.name {
            tl.name = name;
        }
        if let Some(header_text) = params.header_text {
            tl.header_text = header_text;
        }
        if let Some(show_header) = params.show_header {
            tl.show_header = show_header;
        }
        if let Some(show_level_selector) = params.show_level_selector {
            tl.show_level_selector = show_level_selector;
        }
        if let Some(show_scrollbar) = params.show_scrollbar {
            tl.show_scrollbar = show_scrollbar;
        }
        if let Some(level) = params.level {
            tl.level = level;
        }
        if let Some(style_preset) = params.style_preset {
            tl.style_preset = style_preset;
        }
        next = Some(tl.clone());
    });
    recorded?;
    next.ok_or_else(|| format!("Timeline slicer {} not found", timeline_id))
}

/// Resolve timeline `timeline_id`, apply `edit` to a copy of it, and -- when the
/// copy differs -- write it and record the PRE-edit object as ONE undo step
/// labelled `description`, joining an open transaction. An unknown id refuses
/// before anything is written; an edit that changes nothing mints no effect
/// and records nothing (no Ctrl+Z step that restores itself). The store guard
/// drops before the undo stack is taken (never both held).
fn update_timeline_with(
    state: &crate::AppState,
    timeline_state: &TimelineSlicerState,
    file_state: &crate::persistence::FileState,
    timeline_id: identity::EntityId,
    description: &str,
    edit: impl FnOnce(&mut TimelineSlicer),
) -> Result<(), String> {
    let pending = timeline_state
        .timelines
        .lock_pending()
        .map_err(|e| e.to_string())?;
    let pre_edit = pending
        .get(&timeline_id)
        .cloned()
        .ok_or_else(|| format!("Timeline slicer {} not found", timeline_id))?;
    let mut next = pre_edit.clone();
    edit(&mut next);
    if next == pre_edit {
        return Ok(());
    }
    let effect = crate::document_effect::DocumentEffect::mutates(file_state);
    if let Some(tl) = pending.authorize(&effect).get_mut(&timeline_id) {
        *tl = next;
    }
    crate::undo_commands::record_timeline_undo(state, timeline_id, pre_edit, description);
    Ok(())
}

/// Update timeline slicer position and size (drag/resize, and a cross-family
/// arrange).
///
/// A MEMBER of an open transaction: the undo entry goes through the guarded
/// join, so an arrange that wraps this in `begin_undo_transaction` stays ONE
/// Ctrl+Z. It used to run an unconditional `begin`/`commit` pair, and since
/// `begin` is a no-op while a transaction is open but `commit` is not, it
/// committed the CALLER'S outer transaction halfway through the arrange.
///
/// Gated like a chart or slicer move (`editObjects`). The effect is minted only
/// after every refusal (unknown id, protected sheet) and only when a value
/// actually changes -- the id lookup used to run AFTER `mutates`, so an unknown
/// id dirtied the document it then refused to change.
#[tauri::command]
pub fn update_timeline_position(
    state: State<crate::AppState>,
    timeline_state: State<TimelineSlicerState>,
    file_state: State<'_, crate::persistence::FileState>,
    timeline_id: identity::EntityId,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    update_timeline_position_core(&state, &timeline_state, &file_state, timeline_id, x, y, width, height)
}

/// [`update_timeline_position`] over plain references, for the unit tier.
#[allow(clippy::too_many_arguments)]
pub(crate) fn update_timeline_position_core(
    state: &crate::AppState,
    timeline_state: &TimelineSlicerState,
    file_state: &crate::persistence::FileState,
    timeline_id: identity::EntityId,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    // Resolve, gate and decide under one hold of the store, so the pre-edit
    // clone that becomes the undo payload is exactly what the write replaces.
    let pending = timeline_state
        .timelines
        .lock_pending()
        .map_err(|e| e.to_string())?;
    let pre_edit = pending
        .get(&timeline_id)
        .cloned()
        .ok_or_else(|| format!("Timeline slicer {} not found", timeline_id))?;
    crate::protection::check_sheet_action(state, pre_edit.sheet_index, "editObjects", "move or resize a timeline")?;
    if pre_edit.x == x && pre_edit.y == y && pre_edit.width == width && pre_edit.height == height {
        // Nothing moved: no dirty flag, no Ctrl+Z step that restores itself.
        return Ok(());
    }

    let effect = crate::document_effect::DocumentEffect::mutates(file_state);
    {
        let mut timelines = pending.authorize(&effect);
        if let Some(tl) = timelines.get_mut(&timeline_id) {
            tl.x = x;
            tl.y = y;
            tl.width = width;
            tl.height = height;
        }
    }

    // Undo of an update is "put the old object back", so the whole pre-edit
    // object is recorded -- after the store guard drops (never both held).
    crate::undo_commands::record_timeline_undo(state, timeline_id, pre_edit, "Move timeline slicer");
    Ok(())
}

/// Update the selected date range on a timeline slicer.
///
/// A MEMBER of an open transaction (W1): the timeline's selection gesture
/// (`updateTimelineSelectionAsync`) writes the selection and the pivot filters
/// it drives inside ONE frontend transaction, so the selection and its pivots
/// are ONE Ctrl+Z step -- and a declined "overwrite existing data?" takes both
/// back with the step's overwrite token alone.
#[tauri::command]
pub fn update_timeline_selection(
    state: State<crate::AppState>,
    timeline_state: State<TimelineSlicerState>,
    file_state: State<'_, crate::persistence::FileState>,
    params: UpdateTimelineSelectionParams,
) -> Result<(), String> {
    update_timeline_selection_core(&state, &timeline_state, &file_state, params)
}

/// [`update_timeline_selection`] over plain references, for the unit tier.
pub(crate) fn update_timeline_selection_core(
    state: &crate::AppState,
    timeline_state: &TimelineSlicerState,
    file_state: &crate::persistence::FileState,
    params: UpdateTimelineSelectionParams,
) -> Result<(), String> {
    log_debug!(
        "TIMELINE",
        "update_timeline_selection id={} start={:?} end={:?}",
        params.timeline_id,
        params.selection_start,
        params.selection_end
    );
    update_timeline_with(state, timeline_state, file_state, params.timeline_id, "Change timeline selection", |tl| {
        tl.selection_start = params.selection_start;
        tl.selection_end = params.selection_end;
    })
}

/// Update report connections for a timeline slicer.
#[tauri::command]
pub fn update_timeline_connections(
    state: State<crate::AppState>,
    timeline_state: State<TimelineSlicerState>,
    file_state: State<'_, crate::persistence::FileState>,
    params: UpdateTimelineConnectionsParams,
) -> Result<(), String> {
    update_timeline_connections_core(&state, &timeline_state, &file_state, params)
}

/// [`update_timeline_connections`] over plain references, for the unit tier.
pub(crate) fn update_timeline_connections_core(
    state: &crate::AppState,
    timeline_state: &TimelineSlicerState,
    file_state: &crate::persistence::FileState,
    params: UpdateTimelineConnectionsParams,
) -> Result<(), String> {
    log_debug!(
        "TIMELINE",
        "update_timeline_connections id={} pivots={:?}",
        params.timeline_id,
        params.connected_pivot_ids
    );
    update_timeline_with(state, timeline_state, file_state, params.timeline_id, "Change timeline connections", |tl| {
        tl.connected_pivot_ids = params.connected_pivot_ids;
    })
}

// ============================================================================
// QUERY COMMANDS
// ============================================================================

/// Get all timeline slicers.
#[tauri::command]
pub fn get_all_timeline_slicers(
    timeline_state: State<TimelineSlicerState>,
) -> Vec<TimelineSlicer> {
    timeline_state
        .timelines
        .read()
        .expect("timeline store poisoned")
        .values()
        .cloned()
        .collect()
}

/// Get timeline slicers for a specific sheet.
#[tauri::command]
pub fn get_timeline_slicers_for_sheet(
    timeline_state: State<TimelineSlicerState>,
    sheet_index: usize,
) -> Vec<TimelineSlicer> {
    timeline_state
        .timelines
        .read()
        .expect("timeline store poisoned")
        .values()
        .filter(|t| t.sheet_index == sheet_index)
        .cloned()
        .collect()
}

/// Get timeline data: date range and periods at the current level.
/// Returns periods with has_data and is_selected flags.
#[tauri::command]
pub fn get_timeline_data(
    pivot_state: State<'_, PivotState>,
    timeline_state: State<TimelineSlicerState>,
    timeline_id: identity::EntityId,
) -> Result<TimelineDataResponse, String> {
    let timelines = timeline_state
        .timelines
        .read()
        .map_err(|e| e.to_string())?;
    let tl = timelines
        .get(&timeline_id)
        .ok_or_else(|| format!("Timeline slicer {} not found", timeline_id))?;

    let pivot_id = tl.source_id;
    let level = tl.level;
    let sel_start = tl.selection_start.clone();
    let sel_end = tl.selection_end.clone();

    // Get date values from pivot cache
    let dates = get_pivot_date_values(&pivot_state, pivot_id, &tl.field_name)?;

    if dates.is_empty() {
        return Ok(TimelineDataResponse {
            min_date: String::new(),
            max_date: String::new(),
            periods: vec![],
            level,
            total_periods: 0,
        });
    }

    let min_date = dates.iter().min().unwrap().clone();
    let max_date = dates.iter().max().unwrap().clone();

    let dates_set: HashSet<DateTuple> = dates.into_iter().collect();

    let periods = generate_periods(level, &min_date, &max_date, &dates_set, &sel_start, &sel_end);
    let total_periods = periods.len();

    Ok(TimelineDataResponse {
        min_date: format!("{:04}-{:02}-{:02}", min_date.0, min_date.1, min_date.2),
        max_date: format!("{:04}-{:02}-{:02}", max_date.0, max_date.1, max_date.2),
        periods,
        level,
        total_periods,
    })
}

/// Get the list of date values that fall within the timeline's selected range.
/// Used by the filter bridge to determine which items to pass to the pivot filter.
#[tauri::command]
pub fn get_timeline_selected_items(
    pivot_state: State<'_, PivotState>,
    timeline_state: State<TimelineSlicerState>,
    timeline_id: identity::EntityId,
) -> Result<Option<Vec<String>>, String> {
    let timelines = timeline_state
        .timelines
        .read()
        .map_err(|e| e.to_string())?;
    let tl = timelines
        .get(&timeline_id)
        .ok_or_else(|| format!("Timeline slicer {} not found", timeline_id))?;

    // No selection = no filter (all items visible)
    let (sel_start_str, sel_end_str) = match (&tl.selection_start, &tl.selection_end) {
        (Some(s), Some(e)) => (s.clone(), e.clone()),
        _ => return Ok(None),
    };

    let sel_start = parse_iso_date(&sel_start_str)
        .ok_or_else(|| format!("Invalid selection_start: {}", sel_start_str))?;
    let sel_end = parse_iso_date(&sel_end_str)
        .ok_or_else(|| format!("Invalid selection_end: {}", sel_end_str))?;

    let pivot_id = tl.source_id;

    // Get the raw string representations of date values from the pivot cache
    let selected = get_pivot_date_value_strings_in_range(
        &pivot_state,
        pivot_id,
        &tl.field_name,
        &sel_start,
        &sel_end,
    )?;

    Ok(Some(selected))
}

/// Get date field names from a pivot table (fields that contain date values).
/// Used by the InsertTimelineDialog to show available date fields.
#[tauri::command]
pub fn get_pivot_date_fields(
    state: State<'_, crate::AppState>,
    pivot_state: State<'_, PivotState>,
    pivot_id: PivotId,
) -> Result<Vec<String>, String> {
    pivot_date_fields_core(&state, &pivot_state, pivot_id)
}

/// What one cache field's values say about being a date field.
struct DateFieldVotes {
    name: String,
    /// The field's column in the source RANGE (0-based).
    source_index: usize,
    total: usize,
    /// Text values that read as dates ("2026-01-10").
    text_dates: usize,
    /// Numbers that are valid date SERIALS -- which every small number is.
    numeric_serials: usize,
}

/// [`get_pivot_date_fields`] over plain references.
///
/// A NUMBER IS A DATE ONLY WHEN ITS CELL SAYS SO. Every positive number below
/// 2958466 is a valid date serial, so the old rule ("more than half the values
/// parse as dates") offered a Sales column of 10 / 20 / 30 as a date field
/// (found live 2026-09-29, e2e fixall-pivot TL-NUM). A grid-sourced pivot now
/// counts a numeric value only when its source column is date- or
/// time-FORMATTED -- Excel's rule for what a timeline may use. A data-model
/// pivot has no cell formats to ask and keeps the value rule.
pub(crate) fn pivot_date_fields_core(
    state: &crate::AppState,
    pivot_state: &PivotState,
    pivot_id: PivotId,
) -> Result<Vec<String>, String> {
    // Sheet names BEFORE pivot_tables (delete_sheet takes them in that order).
    let sheet_names = crate::pivot::operations::sheet_names_snapshot(state);
    let is_model_pivot = pivot_state.bi_metadata.read().unwrap().contains_key(&pivot_id);

    let (votes, source) = {
        let mut pivot_tables = pivot_state
            .pivot_tables
            .write(&crate::document_effect::DocumentEffect::deliberately_clean(crate::document_effect::CleanReason::DerivedCache))
            .unwrap();
        let (definition, cache) = pivot_tables
            .get_mut(&pivot_id)
            .ok_or_else(|| format!("Pivot table {} not found", pivot_id))?;
        let mut votes = Vec::new();
        for field in &mut cache.fields {
            let mut v = DateFieldVotes {
                name: field.name.clone(),
                source_index: field.source_index,
                total: 0,
                text_dates: 0,
                numeric_serials: 0,
            };
            let sorted_ids = field.sorted_ids().to_vec();
            for &vid in &sorted_ids {
                if vid == VALUE_ID_EMPTY {
                    continue;
                }
                if let Some(value) = field.get_value(vid) {
                    v.total += 1;
                    if pivot_engine::cache::parse_cache_value_as_date(value).is_some() {
                        match value {
                            pivot_engine::CacheValue::Number(_) => v.numeric_serials += 1,
                            _ => v.text_dates += 1,
                        }
                    }
                }
            }
            votes.push(v);
        }
        let source_sheet = definition
            .source_sheet
            .as_deref()
            .and_then(|name| crate::pivot::operations::index_of_sheet(&sheet_names, name));
        let source = source_sheet.map(|sheet| {
            let data_start = definition.source_start.0 + u32::from(definition.source_has_headers);
            (sheet, data_start, definition.source_end.0, definition.source_start.1)
        });
        (votes, source)
    }; // pivot guard released: grids and styles are read with no pivot lock held

    let date_formatted_columns: Option<HashSet<usize>> = if is_model_pivot {
        None
    } else {
        source.map(|(sheet, first_row, last_row, first_col)| {
            let grids = state.grids.read().unwrap();
            let styles = state.style_registry.read().unwrap();
            let mut out = HashSet::new();
            let Some(grid) = grids.get(sheet) else { return out };
            for v in &votes {
                let col = first_col + v.source_index as u32;
                let (mut numbers, mut dated) = (0usize, 0usize);
                for row in first_row..=last_row.min(grid.max_row) {
                    let Some(cell) = grid.get_cell(row, col) else { continue };
                    if !matches!(cell.value, engine::CellValue::Number(_)) {
                        continue;
                    }
                    numbers += 1;
                    if matches!(
                        styles.get(cell.style_index).number_format,
                        engine::NumberFormat::Date { .. } | engine::NumberFormat::Time { .. }
                    ) {
                        dated += 1;
                    }
                }
                if numbers > 0 && dated * 2 >= numbers {
                    out.insert(v.source_index);
                }
            }
            out
        })
    };

    Ok(votes
        .into_iter()
        .filter(|v| {
            let numeric_dates = match &date_formatted_columns {
                // A data-model pivot (or a source that cannot be found): the
                // value rule.
                None => v.numeric_serials,
                Some(formatted) if formatted.contains(&v.source_index) => v.numeric_serials,
                Some(_) => 0,
            };
            // A date field if at least half its values are dates.
            v.total > 0 && (v.text_dates + numeric_dates) * 2 >= v.total
        })
        .map(|v| v.name)
        .collect())
}

// ============================================================================
// INTERNAL HELPERS
// ============================================================================

/// (year, month, day) tuple for date comparisons.
type DateTuple = (i32, u32, u32);

/// Parse an ISO 8601 date string "YYYY-MM-DD" into a DateTuple.
fn parse_iso_date(s: &str) -> Option<DateTuple> {
    let parts: Vec<&str> = s.split('-').collect();
    if parts.len() != 3 {
        return None;
    }
    let y = parts[0].parse::<i32>().ok()?;
    let m = parts[1].parse::<u32>().ok()?;
    let d = parts[2].parse::<u32>().ok()?;
    if m >= 1 && m <= 12 && d >= 1 && d <= 31 {
        Some((y, m, d))
    } else {
        None
    }
}

/// Get all date values from a pivot field as DateTuples.
fn get_pivot_date_values(
    pivot_state: &State<'_, PivotState>,
    pivot_id: PivotId,
    field_name: &str,
) -> Result<Vec<DateTuple>, String> {
    let mut pivot_tables = pivot_state.pivot_tables.write(&crate::document_effect::DocumentEffect::deliberately_clean(crate::document_effect::CleanReason::DerivedCache)).unwrap();
    let (_def, cache) = pivot_tables
        .get_mut(&pivot_id)
        .ok_or_else(|| format!("Pivot table {} not found", pivot_id))?;

    let field = cache
        .fields
        .iter_mut()
        .find(|f| f.name == field_name)
        .ok_or_else(|| format!("Field '{}' not found in pivot cache", field_name))?;

    let mut dates = Vec::new();
    let sorted_ids = field.sorted_ids().to_vec();

    for &vid in &sorted_ids {
        if vid == VALUE_ID_EMPTY {
            continue;
        }
        if let Some(value) = field.get_value(vid) {
            if let Some(parsed) = pivot_engine::cache::parse_cache_value_as_date(value) {
                dates.push((parsed.year, parsed.month, parsed.day));
            }
        }
    }

    Ok(dates)
}

/// Get the string representations of date values that fall within [start, end].
/// These strings are what the pivot filter needs to match against.
fn get_pivot_date_value_strings_in_range(
    pivot_state: &State<'_, PivotState>,
    pivot_id: PivotId,
    field_name: &str,
    start: &DateTuple,
    end: &DateTuple,
) -> Result<Vec<String>, String> {
    let mut pivot_tables = pivot_state.pivot_tables.write(&crate::document_effect::DocumentEffect::deliberately_clean(crate::document_effect::CleanReason::DerivedCache)).unwrap();
    let (_def, cache) = pivot_tables
        .get_mut(&pivot_id)
        .ok_or_else(|| format!("Pivot table {} not found", pivot_id))?;

    let field = cache
        .fields
        .iter_mut()
        .find(|f| f.name == field_name)
        .ok_or_else(|| format!("Field '{}' not found in pivot cache", field_name))?;

    let mut selected = Vec::new();
    let sorted_ids = field.sorted_ids().to_vec();

    for &vid in &sorted_ids {
        if vid == VALUE_ID_EMPTY {
            continue;
        }
        if let Some(value) = field.get_value(vid) {
            if let Some(parsed) = pivot_engine::cache::parse_cache_value_as_date(value) {
                let d = (parsed.year, parsed.month, parsed.day);
                if d >= *start && d <= *end {
                    // Return the string representation that the slicer filter bridge expects
                    let value_str = match value {
                        pivot_engine::CacheValue::Number(n) => {
                            if n.0.fract() == 0.0 {
                                format!("{}", n.0 as i64)
                            } else {
                                format!("{}", n.0)
                            }
                        }
                        pivot_engine::CacheValue::Text(s) => s.to_string(),
                        _ => continue,
                    };
                    selected.push(value_str);
                }
            }
        }
    }

    Ok(selected)
}

/// Generate timeline periods between min_date and max_date at the given level.
fn generate_periods(
    level: TimelineLevel,
    min_date: &DateTuple,
    max_date: &DateTuple,
    dates_with_data: &HashSet<DateTuple>,
    sel_start: &Option<String>,
    sel_end: &Option<String>,
) -> Vec<TimelinePeriod> {
    let sel_start_date = sel_start.as_ref().and_then(|s| parse_iso_date(s));
    let sel_end_date = sel_end.as_ref().and_then(|s| parse_iso_date(s));

    match level {
        TimelineLevel::Years => generate_year_periods(min_date, max_date, dates_with_data, &sel_start_date, &sel_end_date),
        TimelineLevel::Quarters => generate_quarter_periods(min_date, max_date, dates_with_data, &sel_start_date, &sel_end_date),
        TimelineLevel::Months => generate_month_periods(min_date, max_date, dates_with_data, &sel_start_date, &sel_end_date),
        TimelineLevel::Days => generate_day_periods(min_date, max_date, dates_with_data, &sel_start_date, &sel_end_date),
    }
}

fn generate_year_periods(
    min_date: &DateTuple,
    max_date: &DateTuple,
    dates_with_data: &HashSet<DateTuple>,
    sel_start: &Option<DateTuple>,
    sel_end: &Option<DateTuple>,
) -> Vec<TimelinePeriod> {
    let mut periods = Vec::new();
    for year in min_date.0..=max_date.0 {
        let start = (year, 1, 1);
        let end = (year, 12, 31);
        let has_data = dates_with_data.iter().any(|d| d.0 == year);
        let is_selected = match (sel_start, sel_end) {
            (Some(s), Some(e)) => {
                // Period overlaps selection if period_start <= sel_end && period_end >= sel_start
                end >= *s && start <= *e
            }
            _ => false,
        };

        periods.push(TimelinePeriod {
            label: format!("{}", year),
            group_label: String::new(),
            start_date: format!("{:04}-01-01", year),
            end_date: format!("{:04}-12-31", year),
            has_data,
            is_selected,
            index: periods.len(),
        });
    }
    periods
}

fn generate_quarter_periods(
    min_date: &DateTuple,
    max_date: &DateTuple,
    dates_with_data: &HashSet<DateTuple>,
    sel_start: &Option<DateTuple>,
    sel_end: &Option<DateTuple>,
) -> Vec<TimelinePeriod> {
    let mut periods = Vec::new();
    let start_q = quarter_of(min_date.1);
    let end_q = quarter_of(max_date.1);

    for year in min_date.0..=max_date.0 {
        let q_start = if year == min_date.0 { start_q } else { 1 };
        let q_end = if year == max_date.0 { end_q } else { 4 };

        for q in q_start..=q_end {
            let first_month = (q - 1) * 3 + 1;
            let last_month = q * 3;
            let start = (year, first_month, 1);
            let end = (year, last_month, days_in_month(year, last_month));

            let has_data = dates_with_data.iter().any(|d| {
                d.0 == year && quarter_of(d.1) == q
            });

            let is_selected = match (sel_start, sel_end) {
                (Some(s), Some(e)) => end >= *s && start <= *e,
                _ => false,
            };

            periods.push(TimelinePeriod {
                label: format!("Q{}", q),
                group_label: format!("{}", year),
                start_date: format!("{:04}-{:02}-01", year, first_month),
                end_date: format!("{:04}-{:02}-{:02}", year, last_month, days_in_month(year, last_month)),
                has_data,
                is_selected,
                index: periods.len(),
            });
        }
    }
    periods
}

fn generate_month_periods(
    min_date: &DateTuple,
    max_date: &DateTuple,
    dates_with_data: &HashSet<DateTuple>,
    sel_start: &Option<DateTuple>,
    sel_end: &Option<DateTuple>,
) -> Vec<TimelinePeriod> {
    static MONTH_NAMES: [&str; 12] = [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun",
        "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ];

    let mut periods = Vec::new();

    for year in min_date.0..=max_date.0 {
        let m_start = if year == min_date.0 { min_date.1 } else { 1 };
        let m_end = if year == max_date.0 { max_date.1 } else { 12 };

        for month in m_start..=m_end {
            let last_day = days_in_month(year, month);
            let start = (year, month, 1);
            let end = (year, month, last_day);

            let has_data = dates_with_data.iter().any(|d| {
                d.0 == year && d.1 == month
            });

            let is_selected = match (sel_start, sel_end) {
                (Some(s), Some(e)) => end >= *s && start <= *e,
                _ => false,
            };

            periods.push(TimelinePeriod {
                label: MONTH_NAMES[(month - 1) as usize].to_string(),
                group_label: format!("{}", year),
                start_date: format!("{:04}-{:02}-01", year, month),
                end_date: format!("{:04}-{:02}-{:02}", year, month, last_day),
                has_data,
                is_selected,
                index: periods.len(),
            });
        }
    }
    periods
}

fn generate_day_periods(
    min_date: &DateTuple,
    max_date: &DateTuple,
    dates_with_data: &HashSet<DateTuple>,
    sel_start: &Option<DateTuple>,
    sel_end: &Option<DateTuple>,
) -> Vec<TimelinePeriod> {
    static MONTH_NAMES: [&str; 12] = [
        "Jan", "Feb", "Mar", "Apr", "May", "Jun",
        "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
    ];

    let mut periods = Vec::new();
    let mut current = *min_date;

    while current <= *max_date {
        let (y, m, d) = current;
        let date_str = format!("{:04}-{:02}-{:02}", y, m, d);

        let has_data = dates_with_data.contains(&current);
        let is_selected = match (sel_start, sel_end) {
            (Some(s), Some(e)) => current >= *s && current <= *e,
            _ => false,
        };

        periods.push(TimelinePeriod {
            label: format!("{}", d),
            group_label: format!("{} {}", MONTH_NAMES[(m - 1) as usize], y),
            start_date: date_str.clone(),
            end_date: date_str,
            has_data,
            is_selected,
            index: periods.len(),
        });

        // Advance to next day
        current = next_day(current);
    }
    periods
}

// ============================================================================
// DATE MATH HELPERS
// ============================================================================

fn quarter_of(month: u32) -> u32 {
    (month - 1) / 3 + 1
}

fn is_leap_year(year: i32) -> bool {
    (year % 4 == 0 && year % 100 != 0) || (year % 400 == 0)
}

fn days_in_month(year: i32, month: u32) -> u32 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 => if is_leap_year(year) { 29 } else { 28 },
        _ => 30,
    }
}

fn next_day(date: DateTuple) -> DateTuple {
    let (y, m, d) = date;
    let max_d = days_in_month(y, m);
    if d < max_d {
        (y, m, d + 1)
    } else if m < 12 {
        (y, m + 1, 1)
    } else {
        (y + 1, 1, 1)
    }
}
