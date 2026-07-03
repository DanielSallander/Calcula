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

// ============================================================================
// CRUD COMMANDS
// ============================================================================

/// Create a new ribbon filter sourced from a Calcula model connection.
#[tauri::command]
pub fn create_ribbon_filter(
    state: State<AppState>,
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
    ribbon_filter_state.filters.lock().unwrap().insert(id, filter);

    // Record undo for ribbon filter creation (undo = delete)
    {
        #[derive(serde::Serialize)]
        struct RibbonFilterCreateSnapshot { filter_id: identity::EntityId }
        let data = serde_json::to_vec(&RibbonFilterCreateSnapshot { filter_id: id }).unwrap_or_default();
        let mut undo_stack = state.undo_stack.lock().unwrap();
        undo_stack.begin_transaction("Create ribbon filter");
        undo_stack.record_custom_restore("ribbon_filter_create".to_string(), data, "Create ribbon filter");
        undo_stack.commit_transaction();
    }

    Ok(result)
}

/// Delete a ribbon filter.
#[tauri::command]
pub fn delete_ribbon_filter(
    state: State<AppState>,
    ribbon_filter_state: State<RibbonFilterState>,
    filter_id: identity::EntityId,
) -> Result<(), String> {
    log_debug!("RIBBON_FILTER", "delete_ribbon_filter id={}", filter_id);

    let removed = ribbon_filter_state
        .filters
        .lock()
        .unwrap()
        .remove(&filter_id)
        .ok_or_else(|| format!("Ribbon filter {} not found", filter_id))?;

    // Record undo for ribbon filter deletion (undo = recreate)
    {
        #[derive(serde::Serialize)]
        struct RibbonFilterSnapshot {
            filter_id: identity::EntityId,
            previous: RibbonFilter,
        }
        let data = serde_json::to_vec(&RibbonFilterSnapshot { filter_id, previous: removed }).unwrap_or_default();
        let mut undo_stack = state.undo_stack.lock().unwrap();
        undo_stack.begin_transaction("Delete ribbon filter");
        undo_stack.record_custom_restore("ribbon_filter_delete".to_string(), data, "Delete ribbon filter");
        undo_stack.commit_transaction();
    }

    Ok(())
}

/// Update ribbon filter properties.
#[tauri::command]
pub fn update_ribbon_filter(
    state: State<AppState>,
    ribbon_filter_state: State<RibbonFilterState>,
    filter_id: identity::EntityId,
    params: UpdateRibbonFilterParams,
) -> Result<RibbonFilter, String> {
    log_debug!("RIBBON_FILTER", "update_ribbon_filter id={}", filter_id);

    let mut filters = ribbon_filter_state.filters.lock().unwrap();
    let filter = filters
        .get_mut(&filter_id)
        .ok_or_else(|| format!("Ribbon filter {} not found", filter_id))?;

    // Record undo snapshot before property changes
    {
        #[derive(serde::Serialize)]
        struct RibbonFilterSnapshot {
            filter_id: identity::EntityId,
            previous: RibbonFilter,
        }
        let data = serde_json::to_vec(&RibbonFilterSnapshot { filter_id, previous: filter.clone() }).unwrap_or_default();
        let mut undo_stack = state.undo_stack.lock().unwrap();
        undo_stack.begin_transaction("Update ribbon filter");
        undo_stack.record_custom_restore("ribbon_filter".to_string(), data, "Update ribbon filter");
        undo_stack.commit_transaction();
    }

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

    Ok(filter.clone())
}

/// Update ribbon filter selection (which items are checked).
#[tauri::command]
pub fn update_ribbon_filter_selection(
    state: State<AppState>,
    ribbon_filter_state: State<RibbonFilterState>,
    filter_id: identity::EntityId,
    selected_items: Option<Vec<String>>,
) -> Result<(), String> {
    log_debug!(
        "RIBBON_FILTER",
        "update_ribbon_filter_selection id={} items={:?}",
        filter_id,
        selected_items.as_ref().map(|v| v.len())
    );

    let mut filters = ribbon_filter_state.filters.lock().unwrap();
    let filter = filters
        .get_mut(&filter_id)
        .ok_or_else(|| format!("Ribbon filter {} not found", filter_id))?;

    // Record undo snapshot before selection change
    {
        #[derive(serde::Serialize)]
        struct RibbonFilterSnapshot {
            filter_id: identity::EntityId,
            previous: RibbonFilter,
        }
        let data = serde_json::to_vec(&RibbonFilterSnapshot { filter_id, previous: filter.clone() }).unwrap_or_default();
        let mut undo_stack = state.undo_stack.lock().unwrap();
        undo_stack.begin_transaction("Ribbon filter change");
        undo_stack.record_custom_restore("ribbon_filter".to_string(), data, "Ribbon filter change");
        undo_stack.commit_transaction();
    }

    filter.selected_items = selected_items;
    Ok(())
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
        .lock()
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
        .lock()
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
    ribbon_filter_state: State<RibbonFilterState>,
    filter_id: identity::EntityId,
) -> Result<(), String> {
    log_debug!("RIBBON_FILTER", "clear_ribbon_filter id={}", filter_id);

    let mut filters = ribbon_filter_state.filters.lock().unwrap();
    let filter = filters
        .get_mut(&filter_id)
        .ok_or_else(|| format!("Ribbon filter {} not found", filter_id))?;

    // Record undo snapshot
    {
        #[derive(serde::Serialize)]
        struct RibbonFilterSnapshot {
            filter_id: identity::EntityId,
            previous: RibbonFilter,
        }
        let data = serde_json::to_vec(&RibbonFilterSnapshot { filter_id, previous: filter.clone() }).unwrap_or_default();
        let mut undo_stack = state.undo_stack.lock().unwrap();
        undo_stack.begin_transaction("Clear ribbon filter");
        undo_stack.record_custom_restore("ribbon_filter".to_string(), data, "Clear ribbon filter");
        undo_stack.commit_transaction();
    }

    filter.selected_items = None;
    Ok(())
}

/// Toggle a single item's selection state within a ribbon filter.
/// The full item list lives in the BI engine (fetched async by the frontend),
/// so this operates on the current selection list only: toggling ON appends,
/// toggling OFF removes, and an empty result clears the filter (None).
#[tauri::command]
pub fn set_ribbon_filter_item_selected(
    state: State<AppState>,
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

    let mut filters = ribbon_filter_state.filters.lock().unwrap();
    let filter = filters
        .get_mut(&filter_id)
        .ok_or_else(|| format!("Ribbon filter {} not found", filter_id))?;

    // Record undo snapshot before the selection change
    {
        #[derive(serde::Serialize)]
        struct RibbonFilterSnapshot {
            filter_id: identity::EntityId,
            previous: RibbonFilter,
        }
        let data = serde_json::to_vec(&RibbonFilterSnapshot { filter_id, previous: filter.clone() }).unwrap_or_default();
        let mut undo_stack = state.undo_stack.lock().unwrap();
        undo_stack.begin_transaction("Ribbon filter item toggle");
        undo_stack.record_custom_restore("ribbon_filter".to_string(), data, "Ribbon filter item toggle");
        undo_stack.commit_transaction();
    }

    let mut current = filter.selected_items.clone().unwrap_or_default();
    if selected {
        if !current.contains(&value) {
            current.push(value);
        }
    } else {
        current.retain(|v| v != &value);
    }
    filter.selected_items = if current.is_empty() { None } else { Some(current) };

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
    ds_to_conn: &std::collections::HashMap<String, identity::EntityId>,
) {
    let mut filters = ribbon_filter_state.filters.lock().unwrap();
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
