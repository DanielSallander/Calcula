//! FILENAME: app/src-tauri/src/ribbon_filter/commands.rs
//! PURPOSE: Tauri commands for ribbon filter CRUD.
//! CONTEXT: Ribbon filters are always sourced from a Calcula model (BI)
//!          connection. Item values are fetched by the frontend through the
//!          BI engine (bi_get_column_values / bi_get_column_available_values);
//!          this module owns filter definitions and selections.

use crate::ribbon_filter::types::*;
use crate::AppState;
use tauri::State;

use crate::log_debug;

// RIBBON FILTERS ARE PERSISTED (`workbook.ribbon_filters`), so every mutator dirties.
//
// The census singled this file out for a specific reason: the near-identical
// `pane_control` family -- same shape, same kind of entity, same save path -- has
// always marked the document dirty, and this one never did. Two modules that do the
// same thing disagreeing about the dirty flag is exactly the "unpredictable mix" that
// destroys trust in the close prompt, because the user cannot tell which control they
// just touched.

// ============================================================================
// CRUD COMMANDS
// ============================================================================

/// Create a new ribbon filter sourced from a Calcula model connection.
#[tauri::command]
pub fn create_ribbon_filter(
    state: State<AppState>,
    file_state: State<crate::persistence::FileState>,
    bi_state: State<crate::bi::BiState>,
    ribbon_filter_state: State<RibbonFilterState>,
    params: CreateRibbonFilterParams,
) -> Result<RibbonFilter, String> {
    // Filters may only be sourced from an existing model connection. For
    // package connections, carry the stable data-source id so the filter
    // re-binds after reload/re-pull (see RibbonFilter::data_source_id).
    let data_source_id = {
        let connections = bi_state.connections.lock().unwrap();
        match connections.get(&params.connection_id) {
            Some(conn) => conn.package_data_source_id.clone(),
            None => {
                return Err(format!(
                    "Calcula model connection {} not found — ribbon filters must be sourced from a model connection",
                    params.connection_id
                ));
            }
        }
    };

    let id = identity::EntityId::from_bytes(identity::generate_uuid_v7());

    let filter = RibbonFilter {
        id,
        name: params.name,
        connection_id: params.connection_id,
        data_source_id,
        field_name: params.field_name,
        field_data_type: params.field_data_type,
        connection_mode: params.connection_mode,
        // Manual-mode-only: bySheet/workbook targets resolve dynamically
        connected_pivots: if params.connection_mode == ConnectionMode::Manual {
            params.connected_pivots
        } else {
            vec![]
        },
        connected_sheets: params.connected_sheets,
        display_mode: params.display_mode.unwrap_or_default(),
        selected_items: None,
        cross_filter_targets: vec![],
        cross_filter_slicer_targets: vec![],
        advanced_filter: None,
        hide_no_data: false,
        indicate_no_data: true,
        sort_no_data_last: true,
        show_select_all: false,
        single_select: false,
        order: params.order.unwrap_or(0),
        button_columns: 2,
        button_rows: 0,
        filter_level: crate::ribbon_filter::types::default_filter_level(),
    };

    log_debug!(
        "RIBBON_FILTER",
        "create_ribbon_filter id={} name={} mode={:?} field={} connection={}",
        id,
        filter.name,
        filter.connection_mode,
        filter.field_name,
        filter.connection_id
    );

    let result = filter.clone();
    // Past the model-connection validation above, which can still refuse.
    let effect = crate::document_effect::DocumentEffect::mutates(&file_state);
    ribbon_filter_state.filters.write(&effect).unwrap().insert(id, filter);

    // Record undo for ribbon filter creation (undo = delete), JOINING an open
    // transaction: every recorder in this file used to begin and commit its
    // own, and that commit closed a caller's outer transaction half-way
    // (BUG-0200).
    {
        #[derive(serde::Serialize)]
        struct RibbonFilterCreateSnapshot { filter_id: identity::EntityId }
        let data = serde_json::to_vec(&RibbonFilterCreateSnapshot { filter_id: id }).unwrap_or_default();
        crate::undo_commands::record_restores_joining_open_transaction(
            &state,
            "Create ribbon filter",
            vec![("ribbon_filter_create", data)],
        );
    }

    Ok(result)
}

/// Delete a ribbon filter.
///
/// §3bn: filters cross-filter EACH OTHER — `cross_filter_targets` holds sibling
/// FILTER ids, not pivots — so deleting one left every sibling that named it
/// holding a dead id, which the item-fetch path then re-resolved on every
/// selection change. The prune is
/// [`crate::object_deps::cascade_deleted_filters`], recorded into the same undo
/// transaction so one Ctrl+Z restores the filter and the links to it together.
#[tauri::command]
pub fn delete_ribbon_filter(
    state: State<AppState>,
    file_state: State<crate::persistence::FileState>,
    ribbon_filter_state: State<RibbonFilterState>,
    filter_id: identity::EntityId,
) -> Result<(), String> {
    log_debug!("RIBBON_FILTER", "delete_ribbon_filter id={}", filter_id);

    // Ribbon filters live in `workbook.ribbon_filters`; deleting one changes what a
    // save writes. (The sibling pane_control family has always done this.) The
    // unknown-id refusal runs BEFORE the effect, so it leaves the document clean.
    let pending = ribbon_filter_state.filters.lock_pending().map_err(|e| e.to_string())?;
    if !pending.contains_key(&filter_id) {
        return Err(format!("Ribbon filter {} not found", filter_id));
    }
    let effect = crate::document_effect::DocumentEffect::mutates(&file_state);
    let removed = {
        let mut filters = pending.authorize(&effect);
        filters.remove(&filter_id).ok_or_else(|| format!("Ribbon filter {} not found", filter_id))?
    };

    let pruned_siblings = crate::object_deps::cascade_deleted_filters(
        &ribbon_filter_state,
        &effect,
        &[filter_id],
    );

    // Record undo for ribbon filter deletion (undo = recreate): the pruned
    // cross-links and the filter as ONE step, JOINING an open transaction.
    {
        let mut restores = crate::object_deps::encode_filter_prune_restores(&pruned_siblings);
        let (_, data) = crate::undo_commands::ribbon_filter_restore(filter_id, removed);
        restores.push(("ribbon_filter_delete", data));
        crate::undo_commands::record_restores_joining_open_transaction(&state, "Delete ribbon filter", restores);
    }

    Ok(())
}

/// Update ribbon filter properties.
#[tauri::command]
pub fn update_ribbon_filter(
    state: State<AppState>,
    file_state: State<crate::persistence::FileState>,
    ribbon_filter_state: State<RibbonFilterState>,
    filter_id: identity::EntityId,
    params: UpdateRibbonFilterParams,
) -> Result<RibbonFilter, String> {
    update_ribbon_filter_core(&state, &file_state, &ribbon_filter_state, filter_id, params)
}

/// [`update_ribbon_filter`] over plain references, for the unit tier.
pub(crate) fn update_ribbon_filter_core(
    state: &AppState,
    file_state: &crate::persistence::FileState,
    ribbon_filter_state: &RibbonFilterState,
    filter_id: identity::EntityId,
    params: UpdateRibbonFilterParams,
) -> Result<RibbonFilter, String> {
    log_debug!("RIBBON_FILTER", "update_ribbon_filter id={}", filter_id);

    // Gate before the mutating effect: a misleveled pin silently changes
    // which measures respect the filter, so refuse out-of-range levels.
    if let Some(level) = params.filter_level {
        crate::slicer::types::validate_filter_level(level)?;
    }

    // Refusal (unknown id) BEFORE the effect; the store guard is dropped
    // before the undo stack is taken (never both), and the step JOINS an open
    // transaction -- the FilterDropdown's "level change + apply" and its
    // Report Connections save are ONE step, so their overwrite question can
    // take back exactly that step (BUG-0200). This used to begin and commit its
    // own transaction, which closed the caller's half-way.
    let pending = ribbon_filter_state.filters.lock_pending().map_err(|e| e.to_string())?;
    let previous = pending
        .get(&filter_id)
        .cloned()
        .ok_or_else(|| format!("Ribbon filter {} not found", filter_id))?;
    let effect = crate::document_effect::DocumentEffect::mutates(file_state);
    let mut filters = pending.authorize(&effect);
    let filter = filters
        .get_mut(&filter_id)
        .ok_or_else(|| format!("Ribbon filter {} not found", filter_id))?;

    if let Some(name) = params.name {
        filter.name = name;
    }
    if let Some(display_mode) = params.display_mode {
        filter.display_mode = display_mode;
    }
    if let Some(order) = params.order {
        filter.order = order;
    }
    if let Some(button_columns) = params.button_columns {
        filter.button_columns = button_columns.clamp(1, 10);
    }
    if let Some(button_rows) = params.button_rows {
        filter.button_rows = button_rows;
    }
    if let Some(connection_mode) = params.connection_mode {
        filter.connection_mode = connection_mode;
    }
    if let Some(connected_pivots) = params.connected_pivots {
        filter.connected_pivots = connected_pivots;
    }
    // Manual-mode-only invariant: a stale manual list must not survive a
    // switch to bySheet/workbook (it would keep driving slicer cross-filtering
    // and get persisted).
    if filter.connection_mode != ConnectionMode::Manual {
        filter.connected_pivots.clear();
    }
    if let Some(connected_sheets) = params.connected_sheets {
        filter.connected_sheets = connected_sheets;
    }
    if let Some(cross_filter_targets) = params.cross_filter_targets {
        filter.cross_filter_targets = cross_filter_targets;
    }
    if let Some(cross_filter_slicer_targets) = params.cross_filter_slicer_targets {
        filter.cross_filter_slicer_targets = cross_filter_slicer_targets;
    }
    if let Some(advanced_filter) = params.advanced_filter {
        filter.advanced_filter = advanced_filter;
    }
    if let Some(hide_no_data) = params.hide_no_data {
        filter.hide_no_data = hide_no_data;
    }
    if let Some(indicate_no_data) = params.indicate_no_data {
        filter.indicate_no_data = indicate_no_data;
    }
    if let Some(sort_no_data_last) = params.sort_no_data_last {
        filter.sort_no_data_last = sort_no_data_last;
    }
    if let Some(show_select_all) = params.show_select_all {
        filter.show_select_all = show_select_all;
    }
    if let Some(single_select) = params.single_select {
        filter.single_select = single_select;
    }
    if let Some(filter_level) = params.filter_level {
        filter.filter_level = filter_level;
    }

    let updated = filter.clone();
    drop(filters);
    crate::undo_commands::record_restores_joining_open_transaction(
        state,
        "Update ribbon filter",
        vec![crate::undo_commands::ribbon_filter_restore(filter_id, previous)],
    );
    Ok(updated)
}

/// Update ribbon filter selection (which items are checked).
///
/// Without `gesture`: the selection alone, recorded JOINING an open
/// transaction (it used to begin and commit its own, which closed any open
/// transaction and made the selection a step of its own BENEATH the pivots'
/// step -- BUG-0200).
///
/// With `gesture` -- a ribbon filter CHANGE: the selection AND every pivot
/// write the frontend resolved for it (this filter on each target pivot, plus
/// the other active filters that reach the same pivots), as ONE backend
/// command that records ONE step at the end ([`apply_ribbon_filter_selection_core`]).
/// The change used to hold a frontend transaction open across the model
/// re-queries, so an unrelated edit made meanwhile joined its step (BUG-0187).
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn update_ribbon_filter_selection(
    state: State<'_, AppState>,
    file_state: State<'_, crate::persistence::FileState>,
    ribbon_filter_state: State<'_, RibbonFilterState>,
    pivot_state: State<'_, crate::pivot::types::PivotState>,
    pane_control_state: State<'_, crate::pane_control::PaneControlState>,
    user_files_state: State<'_, crate::persistence::UserFilesState>,
    bi_state: State<'_, crate::bi::types::BiState>,
    slicer_state: State<'_, crate::slicer::SlicerState>,
    filter_id: identity::EntityId,
    selected_items: Option<Vec<String>>,
    gesture: Option<crate::pivot::types::PivotFilterGesture>,
) -> Result<Option<crate::pivot::types::PivotFilterGestureResponse>, String> {
    log_debug!(
        "RIBBON_FILTER",
        "update_ribbon_filter_selection id={} items={:?} gesture={}",
        filter_id,
        selected_items.as_ref().map(|v| v.len()),
        gesture.is_some()
    );
    let Some(gesture) = gesture else {
        if let Some(previous) =
            write_ribbon_filter_selection_unrecorded(&file_state, &ribbon_filter_state, filter_id, selected_items)?
        {
            crate::undo_commands::record_restores_joining_open_transaction(
                &state,
                "Ribbon filter change",
                vec![crate::undo_commands::ribbon_filter_restore(filter_id, previous)],
            );
        }
        return Ok(None);
    };
    let ctx = crate::pivot::commands::PivotCmdCtx {
        state: &state,
        file_state: &file_state,
        pivot_state: &pivot_state,
        pane_control_state: &pane_control_state,
        ribbon_filter_state: &ribbon_filter_state,
        user_files_state: &user_files_state,
        bi_state: &bi_state,
        slicer_state: &slicer_state,
        record_undo: true,
    };
    apply_ribbon_filter_selection_core(&ctx, filter_id, selected_items, gesture).await.map(Some)
}

/// A ribbon filter CHANGE as ONE command (BUG-0187): the selection, then every
/// pivot write, then ONE undo step -- the pivots first, the filter LAST (so
/// the reverse replay restores the filter first), the way `gesture.step` says
/// (a user change is a step of its own even while an EMPTY script batch is
/// open; one that already holds writes is joined -- `GestureStepMode::Own`).
/// Refusal first: an unknown filter writes and records nothing. In flight
/// from the selection write to the push, like a slicer click: an undo or redo
/// asked for meanwhile is refused (`undo_commands::history_move_refusal`).
pub(crate) async fn apply_ribbon_filter_selection_core(
    ctx: &crate::pivot::commands::PivotCmdCtx<'_>,
    filter_id: identity::EntityId,
    selected_items: Option<Vec<String>>,
    gesture: crate::pivot::types::PivotFilterGesture,
) -> Result<crate::pivot::types::PivotFilterGestureResponse, String> {
    let _in_flight = crate::undo_commands::PendingGesture::begin(ctx.state);
    let previous = write_ribbon_filter_selection_unrecorded(
        ctx.file_state,
        ctx.ribbon_filter_state,
        filter_id,
        selected_items,
    )?;
    let mut run = crate::pivot::commands::run_pivot_filter_gesture(ctx, gesture.writes).await;
    let mut restores = std::mem::take(&mut run.restores);
    if let Some(previous) = previous {
        restores.push(crate::undo_commands::ribbon_filter_restore(filter_id, previous));
    }
    let outcome = crate::undo_commands::record_gesture_step(
        ctx.state,
        "Ribbon filter change",
        restores,
        crate::slicer::commands::gesture_step_mode(gesture.step),
    );
    Ok(crate::slicer::commands::gesture_response(run, outcome))
}

/// Write a ribbon filter's selection WITHOUT recording it, handing back the
/// filter as it was, or `None` when the selection already was that (nothing
/// written, the document left clean). An unknown filter is refused first.
pub(crate) fn write_ribbon_filter_selection_unrecorded(
    file_state: &crate::persistence::FileState,
    ribbon_filter_state: &RibbonFilterState,
    filter_id: identity::EntityId,
    selected_items: Option<Vec<String>>,
) -> Result<Option<RibbonFilter>, String> {
    write_ribbon_filter_selection_with(file_state, ribbon_filter_state, filter_id, |_| selected_items)
}

/// [`write_ribbon_filter_selection_unrecorded`] whose new selection is
/// DECIDED from the stored one, under the same hold of the store that writes
/// it (`lock_pending`): a toggle read under one lock and written under
/// another lost a concurrent change made in between (the review of S2 --
/// `update_ribbon_filter_selection` runs on the worker pool).
pub(crate) fn write_ribbon_filter_selection_with(
    file_state: &crate::persistence::FileState,
    ribbon_filter_state: &RibbonFilterState,
    filter_id: identity::EntityId,
    decide: impl FnOnce(&Option<Vec<String>>) -> Option<Vec<String>>,
) -> Result<Option<RibbonFilter>, String> {
    let pending = ribbon_filter_state.filters.lock_pending().map_err(|e| e.to_string())?;
    let previous = pending
        .get(&filter_id)
        .cloned()
        .ok_or_else(|| format!("Ribbon filter {} not found", filter_id))?;
    let selected_items = decide(&previous.selected_items);
    if previous.selected_items == selected_items {
        return Ok(None);
    }
    let effect = crate::document_effect::DocumentEffect::mutates(file_state);
    let mut filters = pending.authorize(&effect);
    if let Some(filter) = filters.get_mut(&filter_id) {
        filter.selected_items = selected_items;
    }
    Ok(Some(previous))
}

// ============================================================================
// QUERY COMMANDS
// ============================================================================

/// Get all ribbon filters.
#[tauri::command]
pub fn get_all_ribbon_filters(
    ribbon_filter_state: State<RibbonFilterState>,
) -> Vec<RibbonFilter> {
    ribbon_filter_state
        .filters
        .read()
        .unwrap()
        .values()
        .cloned()
        .collect()
}


/// Get a single ribbon filter by ID.
#[tauri::command]
pub fn get_ribbon_filter(
    ribbon_filter_state: State<RibbonFilterState>,
    filter_id: identity::EntityId,
) -> Result<RibbonFilter, String> {
    ribbon_filter_state
        .filters
        .read()
        .unwrap()
        .get(&filter_id)
        .cloned()
        .ok_or_else(|| format!("Ribbon filter {} not found", filter_id))
}

/// Clear all filter selections (set all items to selected).
/// Convenience wrapper for update_ribbon_filter_selection(id, null).
#[tauri::command]
pub fn clear_ribbon_filter(
    state: State<AppState>,
    file_state: State<crate::persistence::FileState>,
    ribbon_filter_state: State<RibbonFilterState>,
    filter_id: identity::EntityId,
) -> Result<(), String> {
    log_debug!("RIBBON_FILTER", "clear_ribbon_filter id={}", filter_id);

    // Joining an open transaction (see `update_ribbon_filter_selection`); a
    // filter that is already clear records nothing.
    if let Some(previous) = write_ribbon_filter_selection_unrecorded(&file_state, &ribbon_filter_state, filter_id, None)? {
        crate::undo_commands::record_restores_joining_open_transaction(
            &state,
            "Clear ribbon filter",
            vec![crate::undo_commands::ribbon_filter_restore(filter_id, previous)],
        );
    }
    Ok(())
}

/// Toggle a single item's selection state within a ribbon filter.
/// The full item list lives in the BI engine (fetched async by the frontend),
/// so this operates on the current selection list only: toggling ON appends,
/// toggling OFF removes, and an empty result clears the filter (None).
#[tauri::command]
pub fn set_ribbon_filter_item_selected(
    state: State<AppState>,
    file_state: State<crate::persistence::FileState>,
    ribbon_filter_state: State<RibbonFilterState>,
    filter_id: identity::EntityId,
    value: String,
    selected: bool,
) -> Result<(), String> {
    log_debug!(
        "RIBBON_FILTER",
        "set_ribbon_filter_item_selected id={} value={} selected={}",
        filter_id,
        value,
        selected
    );

    set_ribbon_filter_item_selected_core(&state, &file_state, &ribbon_filter_state, filter_id, value, selected)
}

/// [`set_ribbon_filter_item_selected`] over plain references. The toggle is
/// DECIDED from the stored selection under the one hold of the store that
/// writes it ([`write_ribbon_filter_selection_with`]) -- read, drop, write
/// lost a concurrent change -- then recorded joining an open transaction;
/// refusal first, and a toggle that changes nothing records nothing.
pub(crate) fn set_ribbon_filter_item_selected_core(
    state: &AppState,
    file_state: &crate::persistence::FileState,
    ribbon_filter_state: &RibbonFilterState,
    filter_id: identity::EntityId,
    value: String,
    selected: bool,
) -> Result<(), String> {
    let toggle = |current: &Option<Vec<String>>| {
        let mut next = current.clone().unwrap_or_default();
        if selected {
            if !next.contains(&value) {
                next.push(value);
            }
        } else {
            next.retain(|v| v != &value);
        }
        if next.is_empty() {
            None
        } else {
            Some(next)
        }
    };
    if let Some(previous) = write_ribbon_filter_selection_with(file_state, ribbon_filter_state, filter_id, toggle)? {
        crate::undo_commands::record_restores_joining_open_transaction(
            state,
            "Ribbon filter item toggle",
            vec![crate::undo_commands::ribbon_filter_restore(filter_id, previous)],
        );
    }
    Ok(())
}

// ============================================================================
// CONNECTION RE-BINDING
// ============================================================================

/// Re-bind filters to freshly materialized package connections. A package
/// connection mints a NEW uuid on every pull, so filters saved against the
/// previous session's uuid re-attach via their stable package data-source id
/// (mirrors the pivot bi_metadata remap in restore_pulled_pivots).
pub fn remap_ribbon_filter_connections(
    ribbon_filter_state: &RibbonFilterState,
    effect: &crate::document_effect::DocumentEffect,
    ds_to_conn: &std::collections::HashMap<String, identity::EntityId>,
) {
    let mut filters = ribbon_filter_state.filters.write(effect).unwrap();
    for filter in filters.values_mut() {
        if let Some(conn_id) = filter
            .data_source_id
            .as_deref()
            .and_then(|ds| ds_to_conn.get(ds))
        {
            filter.connection_id = *conn_id;
        }
    }
}
