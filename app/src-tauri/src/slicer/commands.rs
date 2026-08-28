//! FILENAME: app/src-tauri/src/slicer/commands.rs
//! PURPOSE: Tauri commands for slicer CRUD and item retrieval.
//! CONTEXT: Manages slicer state and bridges to table/pivot data sources.

use crate::pivot::PivotState;
use crate::slicer::types::*;
use crate::{format_cell_value, AppState};
use std::collections::HashMap;
use tauri::State;

use crate::log_debug;

// ============================================================================
// CRUD COMMANDS
// ============================================================================

/// Create a new slicer.
#[tauri::command]
pub fn create_slicer(
    state: State<AppState>,
    file_state: State<'_, crate::persistence::FileState>,
    slicer_state: State<SlicerState>,
    params: CreateSlicerParams,
) -> Result<Slicer, String> {
    let id = identity::EntityId::from_bytes(identity::generate_uuid_v7());

    let slicer = Slicer {
        id,
        name: params.name,
        header_text: None,
        sheet_index: params.sheet_index,
        x: params.x,
        y: params.y,
        width: params.width.unwrap_or(180.0),
        height: params.height.unwrap_or(240.0),
        source_type: params.source_type,
        cache_source_id: params.cache_source_id,
        field_name: params.field_name,
        selected_items: None, // All selected by default
        show_header: true,
        columns: params.columns.unwrap_or(1),
        style_preset: params.style_preset.unwrap_or_else(|| "SlicerStyleLight1".to_string()),
        selection_mode: SlicerSelectionMode::default(),
        hide_no_data: false,
        indicate_no_data: true,
        sort_no_data_last: true,
        force_selection: false,
        show_select_all: false,
        arrangement: SlicerArrangement::default(),
        rows: 0,
        item_gap: 4.0,
        autogrid: true,
        item_padding: 0.0,
        button_radius: 2.0,
        connected_sources: params.connected_sources,
        filter_level: match params.filter_level {
            Some(level) => {
                crate::slicer::types::validate_filter_level(level)?;
                level
            }
            None => crate::slicer::types::default_filter_level(),
        },
    };

    log_debug!(
        "SLICER",
        "create_slicer id={} name={} source={:?} connected={:?}",
        id,
        slicer.name,
        slicer.source_type,
        slicer.connected_sources
    );

    let result = slicer.clone();
    // Slicers are persisted (`workbook.slicers`); creating one is a document change.
    let effect = crate::document_effect::DocumentEffect::mutates(&file_state);
    slicer_state.slicers.write(&effect).unwrap().insert(id, slicer);

    // Record undo for slicer creation (undo = delete the slicer)
    {
        #[derive(serde::Serialize)]
        struct SlicerCreateSnapshot { slicer_id: identity::EntityId }
        let data = serde_json::to_vec(&SlicerCreateSnapshot { slicer_id: id }).unwrap_or_default();
        let mut undo_stack = state.undo_stack.lock().unwrap();
        undo_stack.begin_transaction("Create slicer");
        undo_stack.record_custom_restore("slicer_create".to_string(), data, "Create slicer");
        undo_stack.commit_transaction();
    }

    Ok(result)
}

/// Delete a slicer.
///
/// §3bn: a slicer is not only a dependent, it is also something depended ON.
/// Ribbon filters name canvas slicers in `crossFilterSlicerTargets`, and a
/// deleted slicer used to stay in those lists forever — every item fetch went
/// on re-evaluating cross-filter candidacy against an id that resolved to
/// nothing. The prune is [`crate::object_deps::cascade_deleted_slicers`], and
/// its restores go into the same transaction as the slicer's own.
#[tauri::command]
pub fn delete_slicer(
    state: State<AppState>,
    file_state: State<'_, crate::persistence::FileState>,
    slicer_state: State<SlicerState>,
    ribbon_filter_state: State<'_, crate::ribbon_filter::RibbonFilterState>,
    slicer_id: identity::EntityId,
) -> Result<(), String> {
    log_debug!("SLICER", "delete_slicer id={}", slicer_id);

    let effect = crate::document_effect::DocumentEffect::mutates(&file_state);
    let removed = {
        let mut slicers = slicer_state.slicers.write(&effect).unwrap();
        slicers
            .remove(&slicer_id)
            .ok_or_else(|| format!("Slicer {} not found", slicer_id))?
    };

    // Filters that cross-filtered this slicer, pruned before the transaction
    // opens (it takes the filter lock; the undo lock is never held across one).
    let pruned_filters = crate::object_deps::cascade_deleted_slicers(
        &ribbon_filter_state,
        &effect,
        &[slicer_id],
    );

    // Record undo for slicer deletion (undo = recreate the slicer), with the
    // pruned filters in the SAME transaction: one Ctrl+Z brings back the slicer
    // AND the cross-filter links that named it.
    {
        #[derive(serde::Serialize)]
        struct SlicerSnapshot {
            slicer_id: identity::EntityId,
            previous: Slicer,
        }
        let data = serde_json::to_vec(&SlicerSnapshot { slicer_id, previous: removed }).unwrap_or_default();
        {
            let mut undo_stack = state.undo_stack.lock().unwrap();
            undo_stack.begin_transaction("Delete slicer");
        }
        // Recorded first, so the reverse replay restores the SLICER first and
        // the filters that point at it second.
        crate::object_deps::record_filter_prune_undo(
            &state,
            &pruned_filters,
            "Restore filter cross-links",
        );
        let mut undo_stack = state.undo_stack.lock().unwrap();
        undo_stack.record_custom_restore("slicer_delete".to_string(), data, "Delete slicer");
        undo_stack.commit_transaction();
    }

    // Computed properties belong to the slicer outright — one helper, shared
    // with the cascade, so "remove a slicer" means the same thing on both paths.
    crate::object_deps::drop_slicer_computed_properties(&slicer_state, &effect, slicer_id);

    // `workbook.slicers` and the pruned object script are both persisted.
    let effect = crate::document_effect::DocumentEffect::mutates(&file_state);
    // C10: a deleted slicer must not leave its object script mounted/persisted.
    crate::scripting::object_script_commands::prune_scripts_for_instance(&state, &effect, &slicer_id.to_string());

    Ok(())
}

/// Update slicer properties (name, header, columns, style).
#[tauri::command]
pub fn update_slicer(
    state: State<AppState>,
    file_state: State<'_, crate::persistence::FileState>,
    slicer_state: State<SlicerState>,
    slicer_id: identity::EntityId,
    params: UpdateSlicerParams,
) -> Result<Slicer, String> {
    log_debug!("SLICER", "update_slicer id={}", slicer_id);

    // Gate before the mutating effect: a misleveled pin silently changes
    // which measures respect the filter, so refuse out-of-range levels.
    if let Some(level) = params.filter_level {
        crate::slicer::types::validate_filter_level(level)?;
    }

    let effect = crate::document_effect::DocumentEffect::mutates(&file_state);
    let mut slicers = slicer_state.slicers.write(&effect).unwrap();
    let slicer = slicers
        .get_mut(&slicer_id)
        .ok_or_else(|| format!("Slicer {} not found", slicer_id))?;

    // Record undo snapshot before property changes
    {
        #[derive(serde::Serialize)]
        struct SlicerSnapshot {
            slicer_id: identity::EntityId,
            previous: Slicer,
        }
        let data = serde_json::to_vec(&SlicerSnapshot { slicer_id, previous: slicer.clone() }).unwrap_or_default();
        let mut undo_stack = state.undo_stack.lock().unwrap();
        undo_stack.begin_transaction("Update slicer");
        undo_stack.record_custom_restore("slicer".to_string(), data, "Update slicer");
        undo_stack.commit_transaction();
    }

    if let Some(name) = params.name {
        slicer.name = name;
    }
    if let Some(header_text) = params.header_text {
        slicer.header_text = header_text;
    }
    if let Some(show_header) = params.show_header {
        slicer.show_header = show_header;
    }
    if let Some(columns) = params.columns {
        slicer.columns = columns.clamp(1, 20);
    }
    if let Some(style_preset) = params.style_preset {
        slicer.style_preset = style_preset;
    }
    if let Some(selection_mode) = params.selection_mode {
        slicer.selection_mode = selection_mode;
    }
    if let Some(hide_no_data) = params.hide_no_data {
        slicer.hide_no_data = hide_no_data;
    }
    if let Some(indicate_no_data) = params.indicate_no_data {
        slicer.indicate_no_data = indicate_no_data;
    }
    if let Some(sort_no_data_last) = params.sort_no_data_last {
        slicer.sort_no_data_last = sort_no_data_last;
    }
    if let Some(force_selection) = params.force_selection {
        slicer.force_selection = force_selection;
    }
    if let Some(show_select_all) = params.show_select_all {
        slicer.show_select_all = show_select_all;
    }
    if let Some(arrangement) = params.arrangement {
        slicer.arrangement = arrangement;
    }
    if let Some(rows) = params.rows {
        slicer.rows = rows;
    }
    if let Some(item_gap) = params.item_gap {
        slicer.item_gap = item_gap.max(0.0).min(50.0);
    }
    if let Some(autogrid) = params.autogrid {
        slicer.autogrid = autogrid;
    }
    if let Some(item_padding) = params.item_padding {
        slicer.item_padding = item_padding.max(0.0).min(30.0);
    }
    if let Some(button_radius) = params.button_radius {
        slicer.button_radius = button_radius.max(0.0).min(20.0);
    }
    if let Some(connected_sources) = params.connected_sources {
        slicer.connected_sources = connected_sources;
    }
    if let Some(filter_level) = params.filter_level {
        slicer.filter_level = filter_level;
    }

    Ok(slicer.clone())
}

/// Update slicer position and size (called after drag/resize).
#[tauri::command]
pub fn update_slicer_position(
    file_state: State<'_, crate::persistence::FileState>,
    slicer_state: State<SlicerState>,
    slicer_id: identity::EntityId,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    let effect = crate::document_effect::DocumentEffect::mutates(&file_state);
    let mut slicers = slicer_state.slicers.write(&effect).unwrap();
    let slicer = slicers
        .get_mut(&slicer_id)
        .ok_or_else(|| format!("Slicer {} not found", slicer_id))?;

    slicer.x = x;
    slicer.y = y;
    slicer.width = width;
    slicer.height = height;
    Ok(())
}

/// Update slicer selection (which items are checked).
#[tauri::command]
pub fn update_slicer_selection(
    state: State<AppState>,
    file_state: State<'_, crate::persistence::FileState>,
    slicer_state: State<SlicerState>,
    slicer_id: identity::EntityId,
    selected_items: Option<Vec<String>>,
) -> Result<(), String> {
    log_debug!(
        "SLICER",
        "update_slicer_selection id={} items={:?}",
        slicer_id,
        selected_items.as_ref().map(|v| v.len())
    );

    let effect = crate::document_effect::DocumentEffect::mutates(&file_state);
    let mut slicers = slicer_state.slicers.write(&effect).unwrap();
    let slicer = slicers
        .get_mut(&slicer_id)
        .ok_or_else(|| format!("Slicer {} not found", slicer_id))?;

    // Record undo snapshot before selection change
    {
        #[derive(serde::Serialize)]
        struct SlicerSnapshot {
            slicer_id: identity::EntityId,
            previous: Slicer,
        }
        let data = serde_json::to_vec(&SlicerSnapshot { slicer_id, previous: slicer.clone() }).unwrap_or_default();
        let mut undo_stack = state.undo_stack.lock().unwrap();
        undo_stack.begin_transaction("Slicer filter change");
        undo_stack.record_custom_restore("slicer".to_string(), data, "Slicer filter change");
        undo_stack.commit_transaction();
    }

    slicer.selected_items = selected_items;
    Ok(())
}

// ============================================================================
// QUERY COMMANDS
// ============================================================================

/// Get a single slicer by ID.
#[tauri::command]
pub fn get_slicer(
    slicer_state: State<SlicerState>,
    slicer_id: identity::EntityId,
) -> Result<Slicer, String> {
    slicer_state
        .slicers
        .read()
        .unwrap()
        .get(&slicer_id)
        .cloned()
        .ok_or_else(|| format!("Slicer {} not found", slicer_id))
}

/// Clear all filter selections on a slicer (set all items to selected).
#[tauri::command]
pub fn clear_slicer_filter(
    state: State<AppState>,
    file_state: State<'_, crate::persistence::FileState>,
    slicer_state: State<SlicerState>,
    slicer_id: identity::EntityId,
) -> Result<(), String> {
    let effect = crate::document_effect::DocumentEffect::mutates(&file_state);
    let mut slicers = slicer_state.slicers.write(&effect).unwrap();
    let slicer = slicers
        .get_mut(&slicer_id)
        .ok_or_else(|| format!("Slicer {} not found", slicer_id))?;

    // Record undo snapshot
    {
        #[derive(serde::Serialize)]
        struct SlicerSnapshot {
            slicer_id: identity::EntityId,
            previous: Slicer,
        }
        let data = serde_json::to_vec(&SlicerSnapshot { slicer_id, previous: slicer.clone() }).unwrap_or_default();
        let mut undo_stack = state.undo_stack.lock().unwrap();
        undo_stack.begin_transaction("Clear slicer filter");
        undo_stack.record_custom_restore("slicer".to_string(), data, "Clear slicer filter");
        undo_stack.commit_transaction();
    }

    slicer.selected_items = None;
    Ok(())
}

/// Toggle a single item's selection state within a slicer.
/// If the slicer currently has all items selected (selectedItems = null),
/// toggling an item OFF creates a selection list with all items except that one.
/// If toggling an item ON completes the full set, clears the filter (null).
#[tauri::command]
pub fn set_slicer_item_selected(
    state: State<AppState>,
    pivot_state: State<'_, crate::pivot::PivotState>,
    file_state: State<'_, crate::persistence::FileState>,
    slicer_state: State<SlicerState>,
    slicer_id: identity::EntityId,
    value: String,
    selected: bool,
) -> Result<(), String> {
    // Record undo snapshot before any selection change
    {
        let slicers = slicer_state.slicers.read().unwrap();
        if let Some(slicer) = slicers.get(&slicer_id) {
            #[derive(serde::Serialize)]
            struct SlicerSnapshot {
                slicer_id: identity::EntityId,
                previous: Slicer,
            }
            let data = serde_json::to_vec(&SlicerSnapshot { slicer_id, previous: slicer.clone() }).unwrap_or_default();
            let mut undo_stack = state.undo_stack.lock().unwrap();
            undo_stack.begin_transaction("Slicer item toggle");
            undo_stack.record_custom_restore("slicer".to_string(), data, "Slicer item toggle");
            undo_stack.commit_transaction();
        }
    }

    // Get the full item list to know when all are selected
    let all_items: Vec<String> = {
        let slicers = slicer_state.slicers.read().unwrap();
        let slicer = slicers
            .get(&slicer_id)
            .ok_or_else(|| format!("Slicer {} not found", slicer_id))?;

        if slicer.source_type == SlicerSourceType::BiConnection {
            // Can't get items synchronously for BI — work with current selection
            let mut current = slicer.selected_items.clone().unwrap_or_default();
            if selected {
                if !current.contains(&value) {
                    current.push(value.clone());
                }
            } else {
                current.retain(|v| v != &value);
            }
            drop(slicers);
    let effect = crate::document_effect::DocumentEffect::mutates(&file_state);
    let mut slicers = slicer_state.slicers.write(&effect).unwrap();
            let slicer = slicers.get_mut(&slicer_id).unwrap();
            slicer.selected_items = if current.is_empty() { None } else { Some(current) };
            return Ok(());
        }

        let source_type = slicer.source_type;
        let cache_source_id = slicer.cache_source_id;
        let field_name = slicer.field_name.clone();
        drop(slicers);

        match source_type {
            SlicerSourceType::Table => {
                get_table_column_values(&state, cache_source_id, &field_name)
                    .unwrap_or_default()
            }
            SlicerSourceType::Pivot => {
                get_pivot_field_values(&pivot_state, cache_source_id, &field_name)
                    .unwrap_or_default()
            }
            SlicerSourceType::BiConnection => unreachable!(),
        }
    };

    // Own commit point: the early-return branch above mints its own token.
    let toggle_effect = crate::document_effect::DocumentEffect::mutates(&file_state);
    let mut slicers = slicer_state.slicers.write(&toggle_effect).unwrap();
    let slicer = slicers
        .get_mut(&slicer_id)
        .ok_or_else(|| format!("Slicer {} not found", slicer_id))?;

    let mut current_selected: std::collections::HashSet<String> = match &slicer.selected_items {
        None => all_items.iter().cloned().collect(),
        Some(items) => items.iter().cloned().collect(),
    };

    if selected {
        current_selected.insert(value);
    } else {
        current_selected.remove(&value);
    }

    // If all items are selected, clear the filter
    if current_selected.len() >= all_items.len() {
        slicer.selected_items = None;
    } else {
        slicer.selected_items = Some(current_selected.into_iter().collect());
    }

    Ok(())
}

/// Get all slicers.
#[tauri::command]
pub fn get_all_slicers(
    slicer_state: State<SlicerState>,
) -> Vec<Slicer> {
    slicer_state
        .slicers
        .read()
        .unwrap()
        .values()
        .cloned()
        .collect()
}

/// Get slicers for a specific sheet.
#[tauri::command]
pub fn get_slicers_for_sheet(
    slicer_state: State<SlicerState>,
    sheet_index: usize,
) -> Vec<Slicer> {
    slicer_state
        .slicers
        .read()
        .unwrap()
        .values()
        .filter(|s| s.sheet_index == sheet_index)
        .cloned()
        .collect()
}

/// Get the unique items for a slicer (reads from the data source).
/// Returns items with their selection state and data availability.
/// Cross-filtering: checks other slicers AND ribbon filters that share
/// connected sources to determine which items still have matching data.
#[tauri::command]
pub async fn get_slicer_items(
    state: State<'_, AppState>,
    pivot_state: State<'_, PivotState>,
    slicer_state: State<'_, SlicerState>,
    ribbon_filter_state: State<'_, crate::ribbon_filter::RibbonFilterState>,
    bi_state: State<'_, crate::bi::types::BiState>,
    slicer_id: identity::EntityId,
) -> Result<Vec<SlicerItem>, String> {
    // Pre-resolve each active ribbon filter's cross-filter candidacy BEFORE
    // taking the slicer lock: its field + selection, whether it explicitly
    // targets this slicer, and its effective target-pivot set. Targets are
    // mode-aware — manual uses the stored list; bySheet/workbook resolve to
    // the pivots of the filter's model connection (mirrors the frontend
    // bridge's resolveTargetPivots, which is where filters actually apply).
    let ribbon_candidates: Vec<(String, Vec<String>, bool, std::collections::HashSet<identity::EntityId>)> = {
        use crate::ribbon_filter::ConnectionMode;
        let snapshot: Vec<_> = {
            let filters = ribbon_filter_state.filters.read().unwrap();
            filters
                .values()
                .filter(|f| f.selected_items.is_some())
                .map(|f| (
                    f.field_name.clone(),
                    f.selected_items.clone().unwrap(),
                    f.cross_filter_slicer_targets.contains(&slicer_id),
                    f.connection_id,
                    f.connection_mode,
                    f.connected_pivots.clone(),
                    f.connected_sheets.clone(),
                ))
                .collect()
        };
        snapshot
            .into_iter()
            .map(|(field, selection, explicit, conn_id, mode, pivots, sheets)| {
                let targets: std::collections::HashSet<identity::EntityId> = match mode {
                    ConnectionMode::Manual => pivots.into_iter().collect(),
                    ConnectionMode::Workbook => {
                        crate::pivot::commands::bi_pivots_for_connection(&state, &pivot_state, conn_id)
                            .into_iter()
                            .map(|p| p.id)
                            .collect()
                    }
                    ConnectionMode::BySheet => {
                        let sheet_set: std::collections::HashSet<usize> = sheets.into_iter().collect();
                        crate::pivot::commands::bi_pivots_for_connection(&state, &pivot_state, conn_id)
                            .into_iter()
                            .filter(|p| sheet_set.contains(&p.sheet_index))
                            .map(|p| p.id)
                            .collect()
                    }
                };
                (field, selection, explicit, targets)
            })
            .collect()
    };

    // Everything lock-holding happens in this block (the command is async —
    // no guard may live across an await). Clones what phase 2 needs.
    let (slicer, unique_values_sync, has_data_set, pinned_bi) = {
    let slicers = slicer_state.slicers.read().unwrap();
    let slicer = slicers
        .get(&slicer_id)
        .ok_or_else(|| format!("Slicer {} not found", slicer_id))?;

    // Items always come from the cache source (the data model), regardless of
    // which pivots the slicer filters via Report Connections.
    let reference_source_id = slicer.cache_source_id;

    // Collect filters from OTHER slicers that share any connected source (cross-filtering).
    let slicer_connected: std::collections::HashSet<identity::EntityId> =
        slicer.connected_sources.iter()
            .filter(|c| c.source_type == slicer.source_type)
            .map(|c| c.source_id)
            .collect();
    let mut sibling_filters: Vec<(String, Vec<String>)> = slicers
        .values()
        .filter(|s| {
            s.id != slicer_id
                && s.selected_items.is_some()
                && s.connected_sources.iter().any(|c| slicer_connected.contains(&c.source_id))
        })
        .map(|s| (s.field_name.clone(), s.selected_items.clone().unwrap()))
        .collect();

    // Also collect cross-filters from ribbon filters.
    // Match if: (a) their effective target pivots overlap this slicer's
    //               connected sources (both filter the same pivot), OR
    //           (b) they explicitly target this slicer via crossFilterSlicerTargets.
    {
        let ribbon_siblings: Vec<(String, Vec<String>)> = ribbon_candidates
            .iter()
            .filter(|(_, _, explicit, targets)| {
                *explicit || targets.iter().any(|p| slicer_connected.contains(p))
            })
            .map(|(field, selection, _, _)| (field.clone(), selection.clone()))
            .collect();
        sibling_filters.extend(ribbon_siblings);
    }

    // A PINNED (level >= 2) pivot slicer's filter is routed INSIDE the BI
    // query, so the pivot cache only holds the SELECTED values — cache
    // uniques would make the unselected items vanish and the slicer could
    // never re-expand. Fetch the full domain from the BI model instead
    // (phase 2, async, after the locks drop).
    let pinned_bi: Option<(crate::bi::types::ConnectionId, String, String)> = if slicer
        .filter_level
        >= 2
        && slicer.source_type == SlicerSourceType::Pivot
    {
        let bi_meta = pivot_state.bi_metadata.read().unwrap();
        bi_meta.get(&reference_source_id).and_then(|meta| {
            let name = slicer.field_name.clone();
            let table_names: Vec<&str> =
                meta.model_tables.iter().map(|t| t.name.as_str()).collect();
            let (table, column) = if name.contains('.') {
                crate::pivot::commands::split_bi_field_key(&name, table_names.iter().copied())
            } else {
                let table_name = meta
                    .model_tables
                    .iter()
                    .find(|t| t.columns.iter().any(|c| c.name == name))
                    .map(|t| t.name.clone())
                    .unwrap_or_default();
                (table_name, name)
            };
            (!table.is_empty()).then(|| (meta.connection_id, table, column))
        })
    } else {
        None
    };

    let unique_values: Option<Vec<String>> = if pinned_bi.is_some() {
        None // fetched async in phase 2
    } else {
        Some(match slicer.source_type {
            SlicerSourceType::Table => get_table_column_values(&state, reference_source_id, &slicer.field_name)?,
            SlicerSourceType::Pivot => get_pivot_field_values(&pivot_state, reference_source_id, &slicer.field_name)?,
            SlicerSourceType::BiConnection => {
                // BI connection items are fetched async via bi_get_column_values on the frontend
                return Err("BiConnection source: use bi_get_column_values instead".to_string());
            }
        })
    };

    // Compute has_data by checking cross-slicer filters. A pinned slicer
    // skips availability shading: its domain comes from the model, not the
    // (already pin-filtered) cache, so cache-based availability would grey
    // every unselected value as "no data".
    let has_data_set = if sibling_filters.is_empty() || pinned_bi.is_some() {
        None // No cross-filtering needed, all items have data
    } else {
        match slicer.source_type {
            SlicerSourceType::Table => {
                Some(get_table_available_values(&state, reference_source_id, &slicer.field_name, &sibling_filters)?)
            }
            SlicerSourceType::Pivot => {
                Some(get_pivot_available_values(&pivot_state, reference_source_id, &slicer.field_name, &sibling_filters)?)
            }
            SlicerSourceType::BiConnection => {
                return Err("BiConnection source: use bi_get_column_available_values instead".to_string());
            }
        }
    };

    (slicer.clone(), unique_values, has_data_set, pinned_bi)
    }; // locks drop here — phase 2 may await

    let unique_values: Vec<String> = match (unique_values_sync, &pinned_bi) {
        (Some(values), _) => values,
        (None, Some((conn_id, table, column))) => {
            crate::bi::commands::bi_get_column_values(
                bi_state,
                *conn_id,
                table.clone(),
                column.clone(),
            )
            .await?
        }
        (None, None) => Vec::new(),
    };

    // Build items with selection state and data availability
    let mut items: Vec<SlicerItem> = unique_values
        .into_iter()
        .map(|value| {
            let selected = match &slicer.selected_items {
                None => true,
                Some(selected) => selected.contains(&value),
            };
            let has_data = match &has_data_set {
                None => true,
                Some(available) => available.contains(&value),
            };
            SlicerItem {
                value,
                selected,
                has_data,
            }
        })
        .collect();

    // Apply display settings
    if slicer.hide_no_data {
        items.retain(|item| item.has_data);
    } else if slicer.sort_no_data_last {
        // Stable sort: items with data first, then items without data
        items.sort_by_key(|item| !item.has_data);
    }

    Ok(items)
}

// ============================================================================
// INTERNAL HELPERS
// ============================================================================

/// Match a slicer field name against a cache field name.
/// Handles "table.column" format: if the slicer field name contains a dot,
/// the cache field name is matched against the part after the last dot.
fn field_name_matches(cache_name: &str, slicer_name: &str) -> bool {
    if cache_name == slicer_name {
        return true;
    }
    // For BI pivots, slicer field name may be "table.column" while
    // cache field name is just "column" (from Arrow schema)
    if let Some(col_part) = slicer_name.rsplit('.').next() {
        if cache_name == col_part {
            return true;
        }
    }
    false
}

/// Get unique values from a table column.
fn get_table_column_values(state: &State<AppState>, source_id: identity::EntityId, field_name: &str) -> Result<Vec<String>, String> {
    // CANONICAL LOCK ORDER: `grids` first (see the note in
    // `state_digest_lock_order_tests`). The recalculation pass holds both grid
    // locks and then takes `tables` on a background thread.
    let grids = state.grids.read().unwrap();
    let style_registry = state.style_registry.read().unwrap();
    let tables = state.tables.read().unwrap();
    let locale = state.locale.lock().unwrap();

    // Find the table
    let table = tables
        .values()
        .flat_map(|sheet_tables| sheet_tables.values())
        .find(|t| t.id == source_id)
        .ok_or_else(|| format!("Table {} not found", source_id))?;

    // Find the column index by name
    let col_offset = table
        .columns
        .iter()
        .position(|c| c.name == field_name)
        .ok_or_else(|| format!("Column '{}' not found in table", field_name))?;

    let abs_col = table.start_col + col_offset as u32;
    let data_start_row = if table.style_options.header_row {
        table.start_row + 1
    } else {
        table.start_row
    };

    if table.sheet_index >= grids.len() {
        return Err("Invalid sheet index".to_string());
    }
    let grid = &grids[table.sheet_index];

    let mut seen = HashMap::new();
    for row in data_start_row..=table.end_row {
        let value = if let Some(cell) = grid.cells.get(&(row, abs_col)) {
            let style = style_registry.get(grid.effective_style_index(row, abs_col));
            format_cell_value(&cell.value, style, &locale)
        } else {
            String::new()
        };
        if !value.is_empty() {
            seen.entry(value).or_insert(());
        }
    }

    let mut values: Vec<String> = seen.into_keys().collect();
    values.sort();
    Ok(values)
}

/// Get values from a table column that still have data given cross-slicer filters.
/// Scans the table rows and checks each row against filters from sibling slicers.
fn get_table_available_values(
    state: &State<AppState>,
    source_id: identity::EntityId,
    field_name: &str,
    sibling_filters: &[(String, Vec<String>)],
) -> Result<std::collections::HashSet<String>, String> {
    // CANONICAL LOCK ORDER: `grids` first (see the note in
    // `state_digest_lock_order_tests`). The recalculation pass holds both grid
    // locks and then takes `tables` on a background thread.
    let grids = state.grids.read().unwrap();
    let style_registry = state.style_registry.read().unwrap();
    let tables = state.tables.read().unwrap();
    let locale = state.locale.lock().unwrap();

    let table = tables
        .values()
        .flat_map(|sheet_tables| sheet_tables.values())
        .find(|t| t.id == source_id)
        .ok_or_else(|| format!("Table {} not found", source_id))?;

    // Find the target column index
    let target_col_offset = table
        .columns
        .iter()
        .position(|c| c.name == field_name)
        .ok_or_else(|| format!("Column '{}' not found", field_name))?;
    let target_abs_col = table.start_col + target_col_offset as u32;

    // Resolve sibling filter column indices
    let filter_cols: Vec<(u32, &Vec<String>)> = sibling_filters
        .iter()
        .filter_map(|(field_name, allowed)| {
            table
                .columns
                .iter()
                .position(|c| &c.name == field_name)
                .map(|offset| (table.start_col + offset as u32, allowed))
        })
        .collect();

    let data_start_row = if table.style_options.header_row {
        table.start_row + 1
    } else {
        table.start_row
    };

    if table.sheet_index >= grids.len() {
        return Err("Invalid sheet index".to_string());
    }
    let grid = &grids[table.sheet_index];

    let mut available = std::collections::HashSet::new();

    for row in data_start_row..=table.end_row {
        // Check if this row passes all sibling filters
        let passes = filter_cols.iter().all(|(col, allowed)| {
            let value = if let Some(cell) = grid.cells.get(&(row, *col)) {
                let style = style_registry.get(grid.effective_style_index(row, *col));
                format_cell_value(&cell.value, style, &locale)
            } else {
                String::new()
            };
            allowed.contains(&value)
        });

        if passes {
            // This row passes all sibling filters — record the target column value
            let value = if let Some(cell) = grid.cells.get(&(row, target_abs_col)) {
                let style = style_registry.get(grid.effective_style_index(row, target_abs_col));
                format_cell_value(&cell.value, style, &locale)
            } else {
                String::new()
            };
            if !value.is_empty() {
                available.insert(value);
            }
        }
    }

    Ok(available)
}

/// Get unique values from a pivot table field.
fn get_pivot_field_values(
    pivot_state: &State<'_, PivotState>,
    source_id: identity::EntityId,
    field_name: &str,
) -> Result<Vec<String>, String> {
    use pivot_engine::VALUE_ID_EMPTY;

    let pivot_id = source_id;
    let mut pivot_tables = pivot_state.pivot_tables.write(&crate::document_effect::DocumentEffect::deliberately_clean(crate::document_effect::CleanReason::DerivedCache)).unwrap();
    let (_def, cache) = pivot_tables
        .get_mut(&pivot_id)
        .ok_or_else(|| format!("Pivot table {} not found", pivot_id))?;

    // Find the field index by name in the cache
    // Supports both "column" and "table.column" format
    let field_index = cache
        .fields
        .iter()
        .position(|f| field_name_matches(&f.name, field_name))
        .ok_or_else(|| format!("Field '{}' not found in pivot cache", field_name))?;

    let field = cache
        .fields
        .get_mut(field_index)
        .ok_or_else(|| format!("Field index {} out of range in cache", field_index))?;

    let sorted_ids = field.sorted_ids().to_vec();
    let unique_values: Vec<String> = sorted_ids
        .iter()
        .filter_map(|&id| {
            if id == VALUE_ID_EMPTY {
                return None;
            }
            field.get_value(id).map(|value| {
                // Convert pivot cache value to string
                match value {
                    pivot_engine::CacheValue::Number(n) => {
                        if n.0.fract() == 0.0 {
                            format!("{}", n.0 as i64)
                        } else {
                            format!("{}", n.0)
                        }
                    }
                    pivot_engine::CacheValue::Text(s) => s.to_string(),
                    pivot_engine::CacheValue::Boolean(b) => {
                        if *b {
                            "TRUE".to_string()
                        } else {
                            "FALSE".to_string()
                        }
                    }
                    pivot_engine::CacheValue::Error(e) => e.to_string(),
                    pivot_engine::CacheValue::Empty => String::new(),
                }
            })
        })
        .filter(|s| !s.is_empty())
        .collect();

    Ok(unique_values)
}

/// Get values from a pivot field that still have data given cross-slicer filters.
/// Scans the cache records and checks each record against sibling slicer filters.
fn get_pivot_available_values(
    pivot_state: &State<'_, PivotState>,
    source_id: identity::EntityId,
    field_name: &str,
    sibling_filters: &[(String, Vec<String>)],
) -> Result<std::collections::HashSet<String>, String> {
    use pivot_engine::VALUE_ID_EMPTY;

    let pivot_id = source_id;
    let mut pivot_tables = pivot_state.pivot_tables.write(&crate::document_effect::DocumentEffect::deliberately_clean(crate::document_effect::CleanReason::DerivedCache)).unwrap();
    let (_def, cache) = pivot_tables
        .get_mut(&pivot_id)
        .ok_or_else(|| format!("Pivot table {} not found", pivot_id))?;

    // Find the target field index (supports "table.column" format)
    let target_field_idx = cache
        .fields
        .iter()
        .position(|f| field_name_matches(&f.name, field_name))
        .ok_or_else(|| format!("Field '{}' not found in pivot cache", field_name))?;

    // Resolve sibling filter field indices and their allowed ValueIds
    let filter_specs: Vec<(usize, std::collections::HashSet<String>)> = sibling_filters
        .iter()
        .filter_map(|(field_name, allowed)| {
            cache
                .fields
                .iter()
                .position(|f| field_name_matches(&f.name, field_name))
                .map(|idx| {
                    let allowed_set: std::collections::HashSet<String> =
                        allowed.iter().cloned().collect();
                    (idx, allowed_set)
                })
        })
        .collect();

    // Helper: convert a cache value to string (same logic as get_pivot_field_values)
    let value_to_string = |field_idx: usize, value_id: pivot_engine::ValueId| -> String {
        if value_id == VALUE_ID_EMPTY {
            return String::new();
        }
        cache
            .fields
            .get(field_idx)
            .and_then(|f| f.get_value(value_id))
            .map(|value| match value {
                pivot_engine::CacheValue::Number(n) => {
                    if n.0.fract() == 0.0 {
                        format!("{}", n.0 as i64)
                    } else {
                        format!("{}", n.0)
                    }
                }
                pivot_engine::CacheValue::Text(s) => s.to_string(),
                pivot_engine::CacheValue::Boolean(b) => {
                    if *b { "TRUE".to_string() } else { "FALSE".to_string() }
                }
                pivot_engine::CacheValue::Error(e) => e.to_string(),
                pivot_engine::CacheValue::Empty => String::new(),
            })
            .unwrap_or_default()
    };

    let mut available = std::collections::HashSet::new();

    for record in &cache.records {
        // Check if this record passes all sibling filters
        let passes = filter_specs.iter().all(|(field_idx, allowed)| {
            if *field_idx >= record.values.len() {
                return false;
            }
            let value_str = value_to_string(*field_idx, record.values[*field_idx]);
            allowed.contains(&value_str)
        });

        if passes {
            if target_field_idx < record.values.len() {
                let value = value_to_string(target_field_idx, record.values[target_field_idx]);
                if !value.is_empty() {
                    available.insert(value);
                }
            }
        }
    }

    Ok(available)
}
