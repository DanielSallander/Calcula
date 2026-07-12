//! FILENAME: app/src-tauri/src/pivot/commands.rs
//! PURPOSE: Tauri commands for Pivot Table operations.
//! CONTEXT: Excel-compatible Pivot Table API implementation.

use crate::bi::types::BiState;
use crate::bi::commands::{auto_connect_bi_connection, auto_bind_tables_on_connection, bi_tables_cache_warm};
use crate::pivot::operations::*;
use crate::pivot::types::*;
use crate::pivot::utils::*;
use crate::{log_debug, log_info, log_perf, AppState};
use crate::pivot::types::PivotState;
use pivot_engine::{
    drill_down, AggregationType, PivotCache, PivotDefinition, PivotField, PivotId,
    PivotView, ValueField, VALUE_ID_EMPTY,
};
use crate::sheets::FreezeConfig;
use std::time::Instant;
use tauri::{Emitter, State};

// ============================================================================
// HELPERS
// ============================================================================

/// Store a computed PivotView for later windowed cell fetching.
fn store_view(pivot_state: &PivotState, pivot_id: PivotId, view: &PivotView) {
    pivot_state.views.lock().unwrap().insert(pivot_id, view.clone());
}

/// Record a pivot definition undo snapshot.
/// `saved_cells` are cells that were overwritten by the pivot expansion
/// (so that `undo_pivot_overwrite` can restore them when the user cancels).
fn record_pivot_definition_undo(
    state: &AppState,
    pivot_id: PivotId,
    definition: PivotDefinition,
    overwritten_cells: Vec<crate::pivot::operations::SavedCell>,
    dest_sheet_idx: usize,
    description: &str,
) {
    #[derive(serde::Serialize)]
    struct PivotDefinitionSnapshot {
        pivot_id: PivotId,
        definition: PivotDefinition,
        overwritten_cells: Vec<crate::pivot::operations::SavedCell>,
        dest_sheet_idx: usize,
    }
    let snapshot = PivotDefinitionSnapshot {
        pivot_id,
        definition,
        overwritten_cells,
        dest_sheet_idx,
    };
    let data = serde_json::to_vec(&snapshot).unwrap_or_default();
    let mut undo_stack = state.undo_stack.lock().unwrap();
    undo_stack.begin_transaction(description);
    undo_stack.record_custom_restore("pivot_definition".to_string(), data, description);
    undo_stack.commit_transaction();
}

/// Populate children_indices from parent_index on a PivotView.
/// The engine sets parent_index but leaves children_indices empty.
/// This is needed for toggle_collapse to find child rows.
fn ensure_children_indices(view: &mut PivotView) {
    // Clear existing children
    for row in &mut view.rows {
        row.children_indices.clear();
    }
    // Build from parent_index
    let parents: Vec<Option<usize>> = view.rows.iter().map(|r| r.parent_index).collect();
    for (idx, parent) in parents.iter().enumerate() {
        if let Some(p) = parent {
            if *p < view.rows.len() {
                view.rows[*p].children_indices.push(idx);
            }
        }
    }
}

/// Find the row index in a PivotView that matches a ToggleGroupRequest.
/// Scans expandable cells for matching group_path or value.
fn find_toggle_row(view: &PivotView, request: &ToggleGroupRequest) -> Option<usize> {
    // Build the target path key the same way the definition stores it
    if let Some(ref group_path) = request.group_path {
        let target_path: Vec<(usize, u32)> = group_path.clone();
        // Find row with an expandable cell whose group_path matches
        for (row_idx, row_cells) in view.cells.iter().enumerate() {
            for cell in row_cells {
                if cell.is_expandable && cell.group_path == target_path {
                    return Some(row_idx);
                }
            }
        }
    } else if let Some(ref item_name) = request.value {
        // Match by formatted value on expandable cells at the correct field level
        for (row_idx, row_cells) in view.cells.iter().enumerate() {
            for cell in row_cells {
                if cell.is_expandable && cell.formatted_value == *item_name {
                    return Some(row_idx);
                }
            }
        }
    } else {
        // Toggle all items in the field — not a single-row toggle.
        // Fall back to slow path (full recalculation needed).
        return None;
    }
    None
}

// ============================================================================
// TAURI COMMANDS
// ============================================================================

/// Resolve pivot field NAMES to their 0-based source-column indices against the
/// available column names. Errors (listing the available names) if any name is
/// not found. Pure — unit-tested.
pub(crate) fn resolve_field_indices(
    names: &[String],
    available: &[String],
) -> Result<Vec<usize>, String> {
    names
        .iter()
        .map(|name| {
            available
                .iter()
                .position(|n| n == name)
                .ok_or_else(|| {
                    format!(
                        "Pivot field '{}' not found. Available columns: [{}]",
                        name,
                        available.join(", ")
                    )
                })
        })
        .collect()
}

/// Human label for an aggregation, used to build a value-field display name
/// like "Sum of Revenue".
fn agg_label(agg: AggregationType) -> &'static str {
    match agg {
        AggregationType::Sum => "Sum",
        AggregationType::Count => "Count",
        AggregationType::Average => "Average",
        AggregationType::Min => "Min",
        AggregationType::Max => "Max",
        AggregationType::CountNumbers => "CountNumbers",
        AggregationType::StdDev => "StdDev",
        AggregationType::StdDevP => "StdDevP",
        AggregationType::Var => "Var",
        AggregationType::VarP => "VarP",
        AggregationType::Product => "Product",
    }
}

/// Creates a new pivot table from the specified source range (UI path: starts
/// EMPTY, fields are configured later via update_pivot_fields).
#[tauri::command]
pub fn create_pivot_table(
    state: State<AppState>,
    pivot_state: State<'_, PivotState>,
    request: CreatePivotRequest,
) -> Result<PivotViewResponse, String> {
    create_pivot_inner(state, pivot_state, request, Vec::new(), Vec::new())
}

/// Core pivot creation, optionally with row/value fields configured UP FRONT so
/// the whole creation is a SINGLE undoable step (used by the MCP create_pivot
/// tool; create_pivot_table passes empty field lists). Field NAMES are resolved
/// to source-column indices against the freshly built cache.
pub fn create_pivot_inner(
    state: State<AppState>,
    pivot_state: State<'_, PivotState>,
    request: CreatePivotRequest,
    row_field_names: Vec<String>,
    value_specs: Vec<(String, AggregationType)>,
) -> Result<PivotViewResponse, String> {
    log_info!(
        "PIVOT",
        "create_pivot_table source={} dest={} dest_sheet={:?}",
        request.source_range,
        request.destination_cell,
        request.destination_sheet
    );

    // Parse ranges
    let (source_start, mut source_end) = parse_range(&request.source_range)?;
    let destination = parse_cell_ref(&request.destination_cell)?;

    // Get source sheet
    let source_sheet_idx = request.source_sheet.unwrap_or_else(|| {
        *state.active_sheet.lock().unwrap()
    });

    // Get destination sheet - use provided value or fall back to active sheet
    let dest_sheet_idx = request.destination_sheet.unwrap_or_else(|| {
        *state.active_sheet.lock().unwrap()
    });

    log_info!(
        "PIVOT",
        "source_sheet_idx={} dest_sheet_idx={}",
        source_sheet_idx,
        dest_sheet_idx
    );

    // Check that destination doesn't overlap an existing pivot table
    check_pivot_overlap(&state, dest_sheet_idx, destination)?;

    // Get grid data for source
    let grids = state.grids.lock().unwrap();
    let grid = grids
        .get(source_sheet_idx)
        .ok_or_else(|| format!("Sheet index {} not found", source_sheet_idx))?;

    // Clamp source_end row to the grid's actual data extent.
    // This handles full-column selections (e.g. A:D -> A1:D1048576) by
    // trimming to only the populated rows, matching Excel's behaviour.
    if source_end.0 > grid.max_row {
        log_info!(
            "PIVOT",
            "clamping source end_row from {} to {} (grid.max_row)",
            source_end.0,
            grid.max_row
        );
        source_end.0 = grid.max_row;
    }

    let has_headers = request.has_headers.unwrap_or(true);

    // Build cache from grid
    let (cache, _headers) = build_cache_from_grid(grid, source_start, source_end, has_headers)?;
    drop(grids); // Release lock early

    // Generate new pivot ID
    let pivot_id = identity::EntityId::from_bytes(identity::generate_uuid_v7());

    // Create definition - START EMPTY (no auto-population)
    let mut definition = PivotDefinition::new(pivot_id, source_start, source_end);
    definition.source_has_headers = has_headers;
    definition.destination = destination;
    definition.name = request.name.or_else(|| Some(format!("PivotTable{}", pivot_id)));
    // If linked to a table, display the table name; otherwise use the raw range
    definition.source_range_display = Some(
        request.source_table_name.clone().unwrap_or_else(|| request.source_range.clone())
    );
    definition.source_table_name = request.source_table_name.clone();

    // Store destination sheet in definition
    {
        let sheet_names = state.sheet_names.lock().unwrap();
        if dest_sheet_idx < sheet_names.len() {
            definition.destination_sheet = Some(sheet_names[dest_sheet_idx].clone());
        }
    }

    // C1: resolve requested field NAMES -> source indices and configure the
    // definition BEFORE the first calc, so an MCP-created pivot is a SINGLE
    // undoable step (no empty-then-update). Empty for the UI create path.
    if !row_field_names.is_empty() || !value_specs.is_empty() {
        let available: Vec<String> = (0..cache.field_count())
            .filter_map(|i| cache.field_name(i))
            .collect();
        let row_idx = resolve_field_indices(&row_field_names, &available)?;
        for (name, idx) in row_field_names.iter().zip(row_idx) {
            definition.row_fields.push(PivotField::new(idx, name.clone()));
        }
        for (field, agg) in &value_specs {
            let idx = resolve_field_indices(std::slice::from_ref(field), &available)?[0];
            definition.value_fields.push(ValueField::new(
                idx,
                format!("{} of {}", agg_label(*agg), field),
                *agg,
            ));
        }
    }

    // The undo snapshot stores the CLEAN (pre-calc) cache: a CONFIGURED pivot's
    // post-calc cache contains computed maps serde_json cannot serialize
    // (non-string keys), which would make the undo snapshot empty and break
    // delete-on-undo. The clean source cache serializes, and redo recomputes the
    // view from it (apply_pivot_delete_restore re-runs safe_calculate_pivot).
    let undo_cache = cache.clone();

    // Calculate initial view (empty only if no fields were configured)
    let mut cache_mut = cache;
    let view = safe_calculate_pivot(&definition, &mut cache_mut);
    store_view(&pivot_state, pivot_id, &view);
    let response = view_to_response(&view, &definition, &mut cache_mut);

    // Update pivot region tracking (tracks even empty pivots with reserved space)
    update_pivot_region(&state, pivot_id, dest_sheet_idx, destination, &view);

    // Write pivot output to destination grid (empty for now, but reserves the space)
    {
        let mut styles = state.style_registry.lock().unwrap();
        let mut grids = state.grids.lock().unwrap();

        // Verify destination sheet exists
        if dest_sheet_idx >= grids.len() {
            return Err(format!(
                "Destination sheet index {} does not exist (only {} sheets available)",
                dest_sheet_idx,
                grids.len()
            ));
        }

        if let Some(dest_grid) = grids.get_mut(dest_sheet_idx) {
            let pivot_merges = write_pivot_to_grid(dest_grid, None, &view, destination, &mut styles);
            log_info!(
                "PIVOT",
                "wrote pivot output to grids[{}] at ({},{}) size {}x{}",
                dest_sheet_idx,
                destination.0,
                destination.1,
                view.row_count,
                view.col_count
            );

            // Insert pivot merge regions
            if !pivot_merges.is_empty() {
                let mut merged = state.merged_regions.lock().unwrap();
                for mr in pivot_merges {
                    merged.insert(mr);
                }
            }

            // IMPORTANT: If dest_sheet is the currently active sheet, sync state.grid
            let active_sheet = *state.active_sheet.lock().unwrap();
            if dest_sheet_idx == active_sheet {
                let mut grid = state.grid.lock().unwrap();
                // Copy the cells we just wrote to state.grid as well
                for ((r, c), cell) in dest_grid.cells.iter() {
                    grid.set_cell(*r, *c, cell.clone());
                }
                grid.recalculate_bounds();
                log_info!("PIVOT", "synced pivot cells to state.grid (active sheet)");
            }
        } else {
            log_info!("PIVOT", "WARNING: destination sheet {} not found", dest_sheet_idx);
        }
    }

    // Store pivot table
    let mut pivot_tables = pivot_state.pivot_tables.lock().unwrap();
    pivot_tables.insert(pivot_id, (definition, cache_mut));

    // Set as active pivot
    let mut active = pivot_state.active_pivot_id.lock().unwrap();
    *active = Some(pivot_id);

    // Record undo snapshot for pivot creation (undo = delete the pivot)
    {
        #[derive(serde::Serialize)]
        struct PivotFullSnapshot {
            pivot_id: PivotId,
            definition: PivotDefinition,
            cache: PivotCache,
        }
        let (def, _post_calc_cache) = pivot_tables.get(&pivot_id).unwrap();
        let snapshot = PivotFullSnapshot {
            pivot_id,
            definition: def.clone(),
            cache: undo_cache, // clean pre-calc cache (serializable; redo recomputes)
        };
        let data = serde_json::to_vec(&snapshot).unwrap_or_default();
        let mut undo_stack = state.undo_stack.lock().unwrap();
        undo_stack.begin_transaction("Create pivot table");
        undo_stack.record_custom_restore("pivot_create".to_string(), data, "Create pivot table");
        undo_stack.commit_transaction();
    }

    log_info!("PIVOT", "created pivot_id={} rows={} (empty - awaiting field configuration)", pivot_id, response.row_count);

    Ok(response)
}

/// Helper: emit a pivot progress event (best-effort, ignores errors).
fn emit_pivot_progress(window: &tauri::Window, pivot_id: PivotId, stage: &str, stage_index: u32, total_stages: u32) {
    let _ = window.emit("pivot:progress", PivotProgressEvent {
        pivot_id,
        stage: stage.into(),
        stage_index,
        total_stages,
    });
}

/// Cancels an in-progress pivot operation (if any).
/// The operation will be aborted between pipeline stages and the pivot reverts to its previous state.
#[tauri::command]
pub fn cancel_pivot_operation(
    pivot_state: State<'_, PivotState>,
    pivot_id: PivotId,
) -> Result<(), String> {
    let tokens = pivot_state.cancellation_tokens.lock().unwrap();
    if let Some(token) = tokens.get(&pivot_id) {
        log_info!("PIVOT", "cancel_pivot_operation pivot_id={}", pivot_id);
        token.cancel();
        Ok(())
    } else {
        // No active operation — silently succeed (not an error)
        Ok(())
    }
}

/// Reverts a pivot to its pre-operation state.
/// Called by the frontend when the user cancels AFTER the backend already completed.
/// Restores the previous definition + cache and re-writes the grid.
#[tauri::command]
pub fn revert_pivot_operation(
    state: State<AppState>,
    pivot_state: State<'_, PivotState>,
    pane_control_state: State<'_, crate::pane_control::PaneControlState>,
    ribbon_filter_state: State<'_, crate::ribbon_filter::RibbonFilterState>,
    pivot_id: PivotId,
) -> Result<(), String> {
    let prev = pivot_state.previous_states.lock().unwrap().remove(&pivot_id);
    if let Some((old_def, old_cache)) = prev {
        log_info!("PIVOT", "revert_pivot_operation pivot_id={}", pivot_id);

        let dest_sheet_idx = resolve_dest_sheet_index(&state, &old_def);
        let destination = old_def.destination;

        // Recalculate the old view
        let mut cache = old_cache;
        let view = safe_calculate_pivot(&old_def, &mut cache);
        store_view(&pivot_state, pivot_id, &view);

        // Restore definition + cache
        {
            let mut pivot_tables = pivot_state.pivot_tables.lock().unwrap();
            if let Some((def, c)) = pivot_tables.get_mut(&pivot_id) {
                *def = old_def;
                *c = cache;
            }
        }

        // Re-write grid with the old view
        finalize_pivot_update(&state, &pivot_state, pivot_id, dest_sheet_idx, destination, &view, Some((&*pane_control_state, &*ribbon_filter_state)));

        Ok(())
    } else {
        // No previous state available — nothing to revert
        Ok(())
    }
}

/// Undoes the last pivot operation that overwrote existing cells.
/// Called by the frontend when the user declines the "overwrite data?" dialog.
///
/// This bypasses the normal undo system (`apply_changes`) because that function
/// holds grid/style/merge locks and then re-acquires them inside the pivot
/// restore handler, causing a deadlock.  Instead, this command directly:
///   1. Pops the last undo entry (so Ctrl+Z doesn't replay it)
///   2. Extracts the pivot definition from the undo snapshot
///   3. Restores the definition, recalculates the view, and rewrites the grid
#[tauri::command]
pub fn undo_pivot_overwrite(
    state: State<AppState>,
    pivot_state: State<'_, PivotState>,
    pane_control_state: State<'_, crate::pane_control::PaneControlState>,
    ribbon_filter_state: State<'_, crate::ribbon_filter::RibbonFilterState>,
    pivot_id: PivotId,
) -> Result<(), String> {
    log_info!("PIVOT", "undo_pivot_overwrite pivot_id={}", pivot_id);

    // 1. Pop the undo entry so Ctrl+Z doesn't replay it
    let transaction = {
        let mut undo_stack = state.undo_stack.lock().unwrap();
        undo_stack.pop_undo()
    };

    // 2. Find the pivot definition snapshot in the transaction
    if let Some(txn) = transaction {
        for change in &txn.changes {
            if let crate::CellChange::CustomRestore { kind, data } = change {
                if kind == "pivot_definition" {
                    #[derive(serde::Deserialize)]
                    struct PivotDefinitionSnapshot {
                        pivot_id: PivotId,
                        definition: PivotDefinition,
                        #[serde(default)]
                        overwritten_cells: Vec<crate::pivot::operations::SavedCell>,
                        #[serde(default)]
                        dest_sheet_idx: usize,
                    }
                    if let Ok(snapshot) = serde_json::from_slice::<PivotDefinitionSnapshot>(data) {
                        if snapshot.pivot_id == pivot_id {
                            let dest_sheet_idx = resolve_dest_sheet_index(&state, &snapshot.definition);
                            let destination = snapshot.definition.destination;

                            // Restore definition and recalculate
                            let mut pivot_tables = pivot_state.pivot_tables.lock().unwrap();
                            if let Some((def, cache)) = pivot_tables.get_mut(&pivot_id) {
                                *def = snapshot.definition;
                                let view = safe_calculate_pivot(def, cache);
                                store_view(&pivot_state, pivot_id, &view);
                                drop(pivot_tables);

                                finalize_pivot_update(&state, &pivot_state, pivot_id, dest_sheet_idx, destination, &view, Some((&*pane_control_state, &*ribbon_filter_state)));

                                // Restore cells that were overwritten by the pivot expansion
                                if !snapshot.overwritten_cells.is_empty() {
                                    let mut grids = state.grids.lock().unwrap();
                                    if let Some(dest_grid) = grids.get_mut(snapshot.dest_sheet_idx) {
                                        for sc in &snapshot.overwritten_cells {
                                            dest_grid.set_cell(sc.row, sc.col, sc.cell.clone());
                                        }
                                    }
                                    let active_sheet = *state.active_sheet.lock().unwrap();
                                    if snapshot.dest_sheet_idx == active_sheet {
                                        let mut grid = state.grid.lock().unwrap();
                                        for sc in &snapshot.overwritten_cells {
                                            grid.set_cell(sc.row, sc.col, sc.cell.clone());
                                        }
                                    }
                                }

                                return Ok(());
                            }
                        }
                    }
                }
            }
        }
    }

    // No matching undo entry found — silently succeed
    Ok(())
}

/// Updates the field configuration of an existing pivot table
#[tauri::command]
pub async fn update_pivot_fields(
    window: tauri::Window,
    state: State<'_, AppState>,
    pivot_state: State<'_, PivotState>,
    pane_control_state: State<'_, crate::pane_control::PaneControlState>,
    ribbon_filter_state: State<'_, crate::ribbon_filter::RibbonFilterState>,
    request: UpdatePivotFieldsRequest,
) -> Result<PivotViewResponse, String> {
    log_info!("PIVOT", "update_pivot_fields pivot_id={}", request.pivot_id);

    let t_total = Instant::now();

    let pivot_id = request.pivot_id;

    // Create cancellation token
    let token = CancellationToken::new();
    pivot_state.cancellation_tokens.lock().unwrap().insert(pivot_id, token.clone());

    // 1. Lock briefly: apply field updates, clone old + new state, release lock
    let (old_definition, old_cache, new_definition, new_cache, dest_sheet_idx) = {
        let mut pivot_tables = pivot_state.pivot_tables.lock().unwrap();
        let (definition, cache) = pivot_tables
            .get_mut(&pivot_id)
            .ok_or_else(|| format!("Pivot table {} not found", pivot_id))?;

        // Save old state for reversion on cancel (both in-flight and post-completion)
        let old_definition = definition.clone();
        let old_cache = cache.clone();
        pivot_state.previous_states.lock().unwrap()
            .insert(pivot_id, (old_definition.clone(), old_cache.clone()));

        // Update row fields (preserving collapse state for fields that remain)
        if let Some(ref row_configs) = request.row_fields {
            let old_row_fields = definition.row_fields.clone();
            definition.row_fields = row_configs
                .iter()
                .map(config_to_pivot_field)
                .collect();
            preserve_collapse_state(&mut definition.row_fields, &old_row_fields);
        }

        // Update column fields (preserving collapse state for fields that remain)
        if let Some(ref col_configs) = request.column_fields {
            let old_col_fields = definition.column_fields.clone();
            definition.column_fields = col_configs
                .iter()
                .map(config_to_pivot_field)
                .collect();
            preserve_collapse_state(&mut definition.column_fields, &old_col_fields);
        }

        // Update value fields
        if let Some(ref value_configs) = request.value_fields {
            definition.value_fields = value_configs
                .iter()
                .map(config_to_value_field)
                .collect();

            // Resolve base_field name -> base_field_index for ShowValuesAs calculations
            resolve_base_field_indices(&mut definition.value_fields, value_configs, &definition.row_fields, &definition.column_fields);
        }

        // Update filter fields
        if let Some(ref filter_configs) = request.filter_fields {
            definition.filter_fields = filter_configs
                .iter()
                .map(config_to_pivot_filter)
                .collect();
        }

        // Update layout
        if let Some(ref layout_config) = request.layout {
            apply_layout_config(&mut definition.layout, layout_config);
        }

        // Update calculated fields. The Design-view DSL has no number-format
        // syntax, so an incoming def without one keeps the existing format
        // for the same-named field instead of silently wiping it.
        if let Some(ref calc_fields) = request.calculated_fields {
            let existing = std::mem::take(&mut definition.calculated_fields);
            definition.calculated_fields = calc_fields
                .iter()
                .map(|cf| pivot_engine::CalculatedField {
                    name: cf.name.clone(),
                    formula: cf.formula.clone(),
                    number_format: cf.number_format.clone().or_else(|| {
                        existing
                            .iter()
                            .find(|e| e.name == cf.name)
                            .and_then(|e| e.number_format.clone())
                    }),
                })
                .collect();
        }

        // Update value column order
        if let Some(ref order) = request.value_column_order {
            definition.value_column_order = order
                .iter()
                .map(|r| match r {
                    ValueColumnRefDef::Value { index } => pivot_engine::ValueColumnRef::Value(*index),
                    ValueColumnRefDef::Calculated { index } => pivot_engine::ValueColumnRef::Calculated(*index),
                })
                .collect();
        }

        // Bump version for cache invalidation
        definition.bump_version();

        let dest_sheet_idx = resolve_dest_sheet_index(&state, definition);
        let new_def = definition.clone();
        let new_cache = cache.clone();
        (old_definition, old_cache, new_def, new_cache, dest_sheet_idx)
    };
    // pivot_tables lock released here — UI is unblocked

    // 2. Emit progress: calculating (stage 2 of 4)
    emit_pivot_progress(&window, pivot_id, "Calculating...", 1, 4);

    // 3. Heavy computation on blocking thread pool (does not hold any Mutex)
    let definition = new_definition;
    let mut cache = new_cache;
    let calc_result = tokio::task::spawn_blocking(move || {
        let t0 = Instant::now();
        let view = safe_calculate_pivot(&definition, &mut cache);
        let calc_ms = t0.elapsed().as_secs_f64() * 1000.0;
        (view, definition, cache, calc_ms)
    })
    .await
    .map_err(|e| format!("Pivot computation failed: {}", e))?;

    let (view, definition, mut cache, calc_ms) = calc_result;

    // Check cancellation after computation
    if token.is_cancelled() {
        log_info!("PIVOT", "update_pivot_fields pivot_id={} CANCELLED after calculation", pivot_id);
        {
            let mut pivot_tables = pivot_state.pivot_tables.lock().unwrap();
            if let Some((def, c)) = pivot_tables.get_mut(&pivot_id) {
                *def = old_definition;
                *c = old_cache;
            }
        }
        pivot_state.cancellation_tokens.lock().unwrap().remove(&pivot_id);
        return Err("Pivot operation cancelled".into());
    }

    // 4. Emit progress: preparing response (stage 3 of 4)
    emit_pivot_progress(&window, pivot_id, "Preparing response...", 2, 4);

    let t1 = Instant::now();
    let mut response = view_to_response(&view, &definition, &mut cache);
    let serialize_ms = t1.elapsed().as_secs_f64() * 1000.0;
    let auto_fit = definition.layout.auto_fit_column_widths;
    let destination = definition.destination;

    // 5. Put updated definition + cache back
    {
        let mut pivot_tables = pivot_state.pivot_tables.lock().unwrap();
        if let Some((def, c)) = pivot_tables.get_mut(&pivot_id) {
            *def = definition;
            *c = cache;
        }
    }

    // Store view for windowed cell fetching
    store_view(&pivot_state, pivot_id, &view);

    // 6. Emit progress: writing to grid (stage 4 of 4)
    emit_pivot_progress(&window, pivot_id, "Updating grid...", 3, 4);

    // Check cancellation before grid write
    if token.is_cancelled() {
        log_info!("PIVOT", "update_pivot_fields pivot_id={} CANCELLED before grid write", pivot_id);
        {
            let mut pivot_tables = pivot_state.pivot_tables.lock().unwrap();
            if let Some((def, c)) = pivot_tables.get_mut(&pivot_id) {
                *def = old_definition;
                *c = old_cache;
            }
        }
        pivot_state.cancellation_tokens.lock().unwrap().remove(&pivot_id);
        return Err("Pivot operation cancelled".into());
    }

    // Save overwritten cells + count BEFORE writing pivot to grid
    let saved_cells = save_overwritten_cells(&state, pivot_id, dest_sheet_idx, destination, &view);
    response.overwritten_cell_count = saved_cells.len() as u32;

    // Update pivot in grid (clears old region, writes new view)
    let t2 = Instant::now();
    update_pivot_in_grid(&state, pivot_id, dest_sheet_idx, destination, &view);
    let grid_write_ms = t2.elapsed().as_secs_f64() * 1000.0;

    // Auto-fit column widths if enabled
    if auto_fit {
        auto_fit_pivot_columns(&state, destination, &view);
    }

    // Update pivot region tracking
    let t3 = Instant::now();
    update_pivot_region(&state, pivot_id, dest_sheet_idx, destination, &view);
    let region_ms = t3.elapsed().as_secs_f64() * 1000.0;

    // Recalculate formulas referencing pivot cells
    recalculate_sheet_formulas(&state, &pivot_state, Some((&*pane_control_state, &*ribbon_filter_state)));

    // Clean up cancellation token (keep previous_states for potential revert command)
    pivot_state.cancellation_tokens.lock().unwrap().remove(&pivot_id);

    let total_ms = t_total.elapsed().as_secs_f64() * 1000.0;
    let payload_bytes = serde_json::to_string(&response).map(|s| s.len()).unwrap_or(0);
    let payload_kb = payload_bytes as f64 / 1024.0;

    // Record undo snapshot AFTER successful completion (not before, to avoid
    // stale entries when the operation is cancelled).
    // Include saved overwritten cells so undo_pivot_overwrite can restore them.
    record_pivot_definition_undo(&state, pivot_id, old_definition, saved_cells, dest_sheet_idx, "Pivot table field change");

    log_perf!(
        "PIVOT",
        "update_pivot_fields pivot_id={} rows={}x{} auto_fit={} | calc={:.1}ms serialize={:.1}ms grid_write={:.1}ms region={:.1}ms TOTAL={:.1}ms | payload={:.1}KB",
        pivot_id,
        response.row_count,
        response.col_count,
        auto_fit,
        calc_ms,
        serialize_ms,
        grid_write_ms,
        region_ms,
        total_ms,
        payload_kb
    );

    Ok(response)
}

/// Toggles the expand/collapse state of a pivot group.
/// This is deliberately kept synchronous — toggle is a fast operation that
/// only re-renders already-cached data with a different collapsed state.
/// Making it async added 3× PivotCache clones per toggle, causing noticeable lag.
#[tauri::command]
pub fn toggle_pivot_group(
    state: State<AppState>,
    pivot_state: State<'_, PivotState>,
    pane_control_state: State<'_, crate::pane_control::PaneControlState>,
    ribbon_filter_state: State<'_, crate::ribbon_filter::RibbonFilterState>,
    request: ToggleGroupRequest,
) -> Result<PivotViewResponse, String> {
    log_info!(
        "PIVOT",
        "toggle_pivot_group pivot_id={} is_row={} field_idx={}",
        request.pivot_id,
        request.is_row,
        request.field_index
    );

    let t_total = Instant::now();
    let pivot_id = request.pivot_id;

    let mut pivot_tables = pivot_state.pivot_tables.lock().unwrap();
    let (definition, cache) = pivot_tables
        .get_mut(&pivot_id)
        .ok_or_else(|| format!("Pivot table {} not found", pivot_id))?;

    // Save old definition for undo (before toggle modifies it)
    let old_definition_for_undo = definition.clone();

    // Get the appropriate field list
    let fields = if request.is_row {
        &mut definition.row_fields
    } else {
        &mut definition.column_fields
    };

    // Find and toggle the field
    if request.field_index >= fields.len() {
        return Err(format!(
            "Field index {} out of range (max {})",
            request.field_index,
            fields.len().saturating_sub(1)
        ));
    }

    let field = &mut fields[request.field_index];

    if let Some(ref group_path) = request.group_path {
        let path_key = group_path
            .iter()
            .map(|(fi, vi)| format!("{}:{}", fi, vi))
            .collect::<Vec<_>>()
            .join("/");

        if field.collapsed_items.contains(&path_key) {
            field.collapsed_items.retain(|s| s != &path_key);
        } else {
            field.collapsed_items.push(path_key.clone());
        }

        log_debug!(
            "PIVOT",
            "toggled path '{}' in field {} collapsed={} (collapsed_items count={})",
            path_key,
            field.name,
            field.collapsed,
            field.collapsed_items.len()
        );
    } else if let Some(ref item_name) = request.value {
        if field.collapsed_items.contains(item_name) {
            field.collapsed_items.retain(|s| s != item_name);
        } else {
            field.collapsed_items.push(item_name.clone());
        }

        log_debug!(
            "PIVOT",
            "toggled item '{}' in field {} (collapsed_items count={})",
            item_name,
            field.name,
            field.collapsed_items.len()
        );
    } else {
        field.collapsed = !field.collapsed;
        field.collapsed_items.clear();

        log_debug!(
            "PIVOT",
            "toggled field {} collapsed={}",
            field.name,
            field.collapsed
        );
    }

    // Bump version
    definition.bump_version();

    let destination = definition.destination;
    let dest_sheet_idx = resolve_dest_sheet_index(&state, definition);

    // FAST PATH: Toggle visibility on the stored view instead of re-running
    // calculate_pivot (which takes ~2s for 98K rows). The view already contains
    // all rows with parent-child relationships; we just flip visibility flags.
    let mut fast_view = {
        let views = pivot_state.views.lock().unwrap();
        views.get(&pivot_id).cloned()
    };

    if let Some(ref mut view) = fast_view {
        // Ensure children_indices are populated (engine leaves them empty)
        ensure_children_indices(view);
        // Find the row to toggle by matching expandable cells against the request
        let target_row = find_toggle_row(view, &request);
        if let Some(row_idx) = target_row {
            let old_visible_count = view.rows.iter().filter(|r| r.visible).count();
            let t_toggle = Instant::now();
            view.toggle_collapse(row_idx);
            // Re-assign sequential view_row to visible rows (eliminate gaps)
            let mut visible_idx = 0;
            for row in &mut view.rows {
                if row.visible {
                    row.view_row = visible_idx;
                    visible_idx += 1;
                }
            }

            // If the visible row count didn't change, the toggle had no effect.
            // This happens when child rows don't exist in the view (e.g., hierarchy
            // fields with field-level collapsed=true). Fall through to the SLOW path
            // which does a full recalculation with the updated definition.
            if visible_idx == old_visible_count {
                log_info!("PIVOT", "toggle_pivot_group: FAST path had no effect (children not in view), falling through to SLOW path");
                drop(pivot_tables);
                // Re-acquire for the SLOW path below
                let mut pivot_tables = pivot_state.pivot_tables.lock()
                    .map_err(|e| format!("pivot_tables lock poisoned: {}", e))?;
                let (definition, cache) = pivot_tables
                    .get_mut(&pivot_id)
                    .ok_or_else(|| format!("Pivot {} not found", pivot_id))?;

                let t_calc = Instant::now();
                let view = safe_calculate_pivot(definition, cache);
                let calc_ms = t_calc.elapsed().as_secs_f64() * 1000.0;

                let t_resp = Instant::now();
                let mut response = view_to_response(&view, definition, cache);
                let serialize_ms = t_resp.elapsed().as_secs_f64() * 1000.0;

                store_view(&pivot_state, pivot_id, &view);
                let destination = definition.destination;
                let dest_sheet_idx = resolve_dest_sheet_index(&state, definition);
                drop(pivot_tables);

                let saved_cells = save_overwritten_cells(&state, pivot_id, dest_sheet_idx, destination, &view);
                response.overwritten_cell_count = saved_cells.len() as u32;
                finalize_pivot_update(&state, &pivot_state, pivot_id, dest_sheet_idx, destination, &view, Some((&*pane_control_state, &*ribbon_filter_state)));
                record_pivot_definition_undo(&state, pivot_id, old_definition_for_undo.clone(), saved_cells, dest_sheet_idx, "Pivot expand/collapse");

                let total_ms = t_total.elapsed().as_secs_f64() * 1000.0;
                log_perf!(
                    "PIVOT",
                    "toggle_pivot_group pivot_id={} rows={}x{} | FAST->SLOW calc={:.1}ms serialize={:.1}ms TOTAL={:.1}ms",
                    pivot_id,
                    response.row_count,
                    response.col_count,
                    calc_ms,
                    serialize_ms,
                    total_ms
                );
                return Ok(response);
            }

            // Update version to match bumped definition
            view.version = definition.version;
            // Update row_count to reflect visible rows
            view.row_count = visible_idx;
            let toggle_ms = t_toggle.elapsed().as_secs_f64() * 1000.0;

            let t_resp = Instant::now();
            let mut response = view_to_response(view, definition, cache);
            let serialize_ms = t_resp.elapsed().as_secs_f64() * 1000.0;

            // Store updated view
            store_view(&pivot_state, pivot_id, view);
            drop(pivot_tables);

            // Clear old cells and write updated view to grid (prevents orphaned cells
            // when pivot shrinks after collapse)
            let saved_cells = save_overwritten_cells(&state, pivot_id, dest_sheet_idx, destination, view);
            response.overwritten_cell_count = saved_cells.len() as u32;
            finalize_pivot_update(&state, &pivot_state, pivot_id, dest_sheet_idx, destination, view, Some((&*pane_control_state, &*ribbon_filter_state)));
            record_pivot_definition_undo(&state, pivot_id, old_definition_for_undo.clone(), saved_cells, dest_sheet_idx, "Pivot expand/collapse");

            let total_ms = t_total.elapsed().as_secs_f64() * 1000.0;
            log_perf!(
                "PIVOT",
                "toggle_pivot_group pivot_id={} rows={}x{} | FAST toggle={:.1}ms serialize={:.1}ms TOTAL={:.1}ms",
                pivot_id,
                response.row_count,
                response.col_count,
                toggle_ms,
                serialize_ms,
                total_ms
            );
            return Ok(response);
        }
    }

    // SLOW PATH: No stored view or couldn't find the target row — full recalculation
    let t_calc = Instant::now();
    let view = safe_calculate_pivot(definition, cache);
    let calc_ms = t_calc.elapsed().as_secs_f64() * 1000.0;

    let t_resp = Instant::now();
    let mut response = view_to_response(&view, definition, cache);
    let serialize_ms = t_resp.elapsed().as_secs_f64() * 1000.0;

    // Store view for windowed cell fetching
    store_view(&pivot_state, pivot_id, &view);

    drop(pivot_tables);

    // Clear old cells and write updated view to grid, then update region bounds
    let saved_cells = save_overwritten_cells(&state, pivot_id, dest_sheet_idx, destination, &view);
    response.overwritten_cell_count = saved_cells.len() as u32;
    finalize_pivot_update(&state, &pivot_state, pivot_id, dest_sheet_idx, destination, &view, Some((&*pane_control_state, &*ribbon_filter_state)));
    record_pivot_definition_undo(&state, pivot_id, old_definition_for_undo, saved_cells, dest_sheet_idx, "Pivot expand/collapse");

    let total_ms = t_total.elapsed().as_secs_f64() * 1000.0;

    log_perf!(
        "PIVOT",
        "toggle_pivot_group pivot_id={} rows={}x{} | SLOW calc={:.1}ms serialize={:.1}ms TOTAL={:.1}ms",
        pivot_id,
        response.row_count,
        response.col_count,
        calc_ms,
        serialize_ms,
        total_ms
    );

    Ok(response)
}

/// Gets the current view of a pivot table
#[tauri::command]
pub fn get_pivot_view(
    _state: State<AppState>,
    pivot_state: State<'_, PivotState>,
    pivot_id: Option<PivotId>,
) -> Result<PivotViewResponse, String> {
    // Use provided ID or active pivot
    let id = match pivot_id {
        Some(id) => id,
        None => {
            let active = pivot_state.active_pivot_id.lock().unwrap();
            active.ok_or_else(|| "No active pivot table".to_string())?
        }
    };

    log_debug!("PIVOT", "get_pivot_view pivot_id={}", id);

    let mut pivot_tables = pivot_state.pivot_tables.lock().unwrap();
    let (definition, cache) = pivot_tables
        .get_mut(&id)
        .ok_or_else(|| format!("Pivot table {} not found", id))?;

    let t0 = Instant::now();
    let view = safe_calculate_pivot(definition, cache);
    store_view(&pivot_state, id, &view);
    let calc_ms = t0.elapsed().as_secs_f64() * 1000.0;

    let t1 = Instant::now();
    let response = view_to_response(&view, definition, cache);
    let serialize_ms = t1.elapsed().as_secs_f64() * 1000.0;

    log_perf!(
        "PIVOT",
        "get_pivot_view pivot_id={} rows={}x{} | calc={:.1}ms serialize={:.1}ms TOTAL={:.1}ms",
        id,
        response.row_count,
        response.col_count,
        calc_ms,
        serialize_ms,
        calc_ms + serialize_ms
    );

    Ok(response)
}

/// Fetches a window of cell data from a stored PivotView (for scroll-triggered loading).
#[tauri::command]
pub fn get_pivot_cell_window(
    pivot_state: State<'_, PivotState>,
    pivot_id: PivotId,
    start_row: usize,
    row_count: usize,
) -> Result<PivotCellWindowResponse, String> {
    let views = pivot_state.views.lock().unwrap();
    let view = views
        .get(&pivot_id)
        .ok_or_else(|| format!("No cached view for pivot {}", pivot_id))?;

    if start_row >= view.rows.len() {
        return Ok(PivotCellWindowResponse {
            pivot_id,
            version: view.version,
            start_row,
            rows: Vec::new(),
        });
    }

    let rows = extract_cell_window(view, start_row, row_count);
    let version = view.version;
    drop(views);

    Ok(PivotCellWindowResponse {
        pivot_id,
        version,
        start_row,
        rows,
    })
}

/// Deletes a pivot table
#[tauri::command]
pub fn delete_pivot_table(state: State<AppState>, pivot_state: State<'_, PivotState>, pivot_id: PivotId) -> Result<(), String> {
    log_info!("PIVOT", "delete_pivot_table pivot_id={}", pivot_id);

    // Get pivot info before removing
    let pivot_tables = pivot_state.pivot_tables.lock().unwrap();
    let (definition, cache) = pivot_tables
        .get(&pivot_id)
        .ok_or_else(|| format!("Pivot table {} not found", pivot_id))?;

    // Record undo snapshot for pivot deletion (undo = recreate the pivot)
    {
        #[derive(serde::Serialize)]
        struct PivotFullSnapshot {
            pivot_id: PivotId,
            definition: PivotDefinition,
            cache: PivotCache,
        }
        let snapshot = PivotFullSnapshot {
            pivot_id,
            definition: definition.clone(),
            cache: cache.clone(),
        };
        let data = serde_json::to_vec(&snapshot).unwrap_or_default();
        let mut undo_stack = state.undo_stack.lock().unwrap();
        undo_stack.begin_transaction("Delete pivot table");
        undo_stack.record_custom_restore("pivot_delete".to_string(), data, "Delete pivot table");
        undo_stack.commit_transaction();
    }

    let dest_sheet_idx = resolve_dest_sheet_index(&state, definition);
    drop(pivot_tables);
    
    // Get the region to clear
    let old_region = get_pivot_region(&state, pivot_id);
    
    // Clear the pivot area from the grid
    if let Some(ref region) = old_region {
        let mut grids = state.grids.lock().unwrap();
        if let Some(dest_grid) = grids.get_mut(dest_sheet_idx) {
            clear_pivot_region_from_grid(
                dest_grid,
                region.start_row,
                region.start_col,
                region.end_row,
                region.end_col,
            );
            
            // Sync to state.grid if this is the active sheet
            let active_sheet = *state.active_sheet.lock().unwrap();
            if dest_sheet_idx == active_sheet {
                let mut grid = state.grid.lock().unwrap();
                for row in region.start_row..=region.end_row {
                    for col in region.start_col..=region.end_col {
                        grid.clear_cell(row, col);
                    }
                }
                grid.recalculate_bounds();
            }
        }
    }

    // Remove pivot table
    let mut pivot_tables = pivot_state.pivot_tables.lock().unwrap();
    pivot_tables.remove(&pivot_id);

    // Remove cached view
    pivot_state.views.lock().unwrap().remove(&pivot_id);

    // Clear active if this was the active pivot
    let mut active = pivot_state.active_pivot_id.lock().unwrap();
    if *active == Some(pivot_id) {
        *active = None;
    }
    
    // Remove pivot region tracking (via generic protected region system)
    let mut regions = state.protected_regions.lock().unwrap();
    regions.retain(|r| !(r.region_type == "pivot" && r.owner_id == pivot_id));
    drop(regions);

    // C10: a deleted pivot must not leave its object script mounted/persisted.
    crate::scripting::object_script_commands::prune_scripts_for_instance(&state, &pivot_id.to_string());

    Ok(())
}

/// Relocate a pivot table to a new destination cell.
/// Updates the definition, recalculates, rewrites grid cells, and updates region tracking.
#[tauri::command]
pub fn relocate_pivot(
    state: State<AppState>,
    pivot_state: State<'_, PivotState>,
    pane_control_state: State<'_, crate::pane_control::PaneControlState>,
    ribbon_filter_state: State<'_, crate::ribbon_filter::RibbonFilterState>,
    pivot_id: PivotId,
    new_row: u32,
    new_col: u32,
) -> Result<(), String> {
    log_info!("PIVOT", "relocate_pivot pivot_id={} to ({},{})", pivot_id, new_row, new_col);

    // 1. Update the definition's destination
    let view = {
        let mut pivot_tables = pivot_state.pivot_tables.lock().unwrap();
        let (definition, cache) = pivot_tables
            .get_mut(&pivot_id)
            .ok_or_else(|| format!("Pivot table {} not found", pivot_id))?;

        let old_dest = definition.destination;
        if old_dest == (new_row, new_col) {
            return Ok(()); // No-op if destination unchanged
        }

        definition.destination = (new_row, new_col);

        // 2. Recalculate the view at the new destination
        safe_calculate_pivot(definition, cache)
    };

    // 3. Resolve sheet index
    let dest_sheet_idx = {
        let pivot_tables = pivot_state.pivot_tables.lock().unwrap();
        let (definition, _) = pivot_tables.get(&pivot_id).unwrap();
        resolve_dest_sheet_index(&state, definition)
    };

    // 4. Clear old region and write new cells at new destination
    update_pivot_in_grid(&state, pivot_id, dest_sheet_idx, (new_row, new_col), &view);

    // 5. Update protected region tracking
    update_pivot_region(&state, pivot_id, dest_sheet_idx, (new_row, new_col), &view);

    // 5b. Recalculate formulas referencing pivot cells
    recalculate_sheet_formulas(&state, &pivot_state, Some((&*pane_control_state, &*ribbon_filter_state)));

    // 6. Store the updated view
    store_view(&pivot_state, pivot_id, &view);

    log_info!("PIVOT", "relocate_pivot pivot_id={} complete", pivot_id);
    Ok(())
}

/// Gets source data for drill-down (detail view)
#[tauri::command]
pub fn get_pivot_source_data(
    state: State<AppState>,
    pivot_state: State<'_, PivotState>,
    pivot_id: PivotId,
    group_path: Vec<(usize, u32)>,
    max_records: Option<usize>,
) -> Result<SourceDataResponse, String> {
    log_info!(
        "PIVOT",
        "get_pivot_source_data pivot_id={} path_len={}",
        pivot_id,
        group_path.len()
    );

    let pivot_tables = pivot_state.pivot_tables.lock().unwrap();
    let (definition, cache) = pivot_tables
        .get(&pivot_id)
        .ok_or_else(|| format!("Pivot table {} not found", pivot_id))?;

    let max = max_records.unwrap_or(1000);
    let result = drill_down(definition, cache, &group_path, max);

    // Convert source rows to formatted strings
    let grids = state.grids.lock().unwrap();
    let source_sheet_idx = 0; // TODO: use definition's source sheet
    let grid = grids
        .get(source_sheet_idx)
        .ok_or_else(|| "Source sheet not found".to_string())?;

    let (start_row, start_col) = definition.source_start;
    let (_, end_col) = definition.source_end;
    let data_start = if definition.source_has_headers {
        start_row + 1
    } else {
        start_row
    };

    let rows: Vec<Vec<String>> = result
        .source_rows
        .iter()
        .map(|&src_row| {
            let grid_row = data_start + src_row;
            (start_col..=end_col)
                .map(|c| {
                    grid.get_cell(grid_row, c)
                        .map(|cell| cell.display_value())
                        .unwrap_or_default()
                })
                .collect()
        })
        .collect();

    Ok(SourceDataResponse {
        pivot_id,
        headers: result.headers,
        rows,
        total_count: result.total_count,
        is_truncated: result.is_truncated,
    })
}

/// Refreshes the pivot cache from current grid data
#[tauri::command]
pub async fn refresh_pivot_cache(
    window: tauri::Window,
    state: State<'_, AppState>,
    pivot_state: State<'_, PivotState>,
    pane_control_state: State<'_, crate::pane_control::PaneControlState>,
    ribbon_filter_state: State<'_, crate::ribbon_filter::RibbonFilterState>,
    bi_state: State<'_, crate::bi::types::BiState>,
    pivot_id: PivotId,
) -> Result<PivotViewResponse, String> {
    log_info!("PIVOT", "refresh_pivot_cache pivot_id={}", pivot_id);

    let t_total = Instant::now();

    // Create cancellation token
    let token = CancellationToken::new();
    pivot_state.cancellation_tokens.lock().unwrap().insert(pivot_id, token.clone());

    // Check if this is a BI-backed pivot. BI pivots re-query the live database
    // via update_bi_pivot_fields rather than rebuilding from grid cells.
    let is_bi_pivot = pivot_state.bi_metadata.lock().unwrap().contains_key(&pivot_id);

    if is_bi_pivot {
        log_info!("CALP-DIAG", "refresh_pivot_cache: BI pivot {} — re-querying live database", pivot_id);
        // Reconstruct an UpdateBiPivotFieldsRequest from the stored definition
        let bi_request = {
            let pivot_tables = pivot_state.pivot_tables.lock().unwrap();
            let (definition, cache) = pivot_tables
                .get(&pivot_id)
                .ok_or_else(|| format!("Pivot table {} not found", pivot_id))?;
            let bi_meta = pivot_state.bi_metadata.lock().unwrap();
            let meta = bi_meta.get(&pivot_id)
                .ok_or_else(|| format!("No BI metadata for pivot {}", pivot_id))?;

            // Parse "Table.Column" field names back into BiFieldRef
            let parse_field = |name: &str, is_lookup: bool| -> super::types::BiFieldRef {
                let (table, column) = name.split_once('.')
                    .map(|(t, c)| (t.to_string(), c.to_string()))
                    .unwrap_or_else(|| (String::new(), name.to_string()));
                super::types::BiFieldRef { table, column, is_lookup, hidden_items: Vec::new() }
            };

            let row_fields: Vec<super::types::BiFieldRef> = definition.row_fields.iter()
                .map(|f| parse_field(&f.name, f.is_attribute))
                .collect();
            let column_fields: Vec<super::types::BiFieldRef> = definition.column_fields.iter()
                .map(|f| parse_field(&f.name, f.is_attribute))
                .collect();
            // Collapse any calculation-group expansion back to the base measures
            // (one BiValueFieldRef per base measure) and strip the "[...]" display
            // wrapper to recover the clean measure name; update_bi_pivot_fields
            // re-applies the calculation group from meta.applied_calc_group.
            let value_fields: Vec<super::types::BiValueFieldRef> = {
                let mut seen_calc: std::collections::HashSet<String> =
                    std::collections::HashSet::new();
                definition.value_fields.iter()
                    .filter(|v| v.calc_item.is_none() || seen_calc.insert(v.name.clone()))
                    .map(|v| super::types::BiValueFieldRef {
                        measure_name: v.name
                            .trim_start_matches('[')
                            .trim_end_matches(']')
                            .to_string(),
                        custom_name: if v.calc_item.is_some() {
                            None
                        } else {
                            v.custom_name.clone()
                        },
                    })
                    .collect()
            };
            let filter_fields: Vec<super::types::BiFieldRef> = definition.filter_fields.iter()
                .map(|f| {
                    let mut field = parse_field(&f.field.name, f.field.is_attribute);
                    field.hidden_items = f.field.hidden_items.clone();
                    field
                })
                .collect();
            // Slicer filters store source_index — resolve to Table.Column
            // names from the cache so they are included in the BI GROUP BY query.
            let slicer_fields: Vec<super::types::BiFieldRef> = definition.slicer_filters.iter()
                .filter_map(|sf| {
                    cache.field_name(sf.source_index).and_then(|name| {
                        // Field names are "Table.Column" in the definition or
                        // bare "Column" from the Arrow schema.
                        let (table, column) = name.split_once('.')
                            .map(|(t, c)| (t.to_string(), c.to_string()))
                            .unwrap_or_else(|| {
                                // Bare column name — look up table from BI metadata
                                let table_name = meta.model_tables.iter()
                                    .find(|t| t.columns.iter().any(|c| c.name == name))
                                    .map(|t| t.name.clone())
                                    .unwrap_or_default();
                                (table_name, name)
                            });
                        if table.is_empty() {
                            None
                        } else {
                            Some(super::types::BiFieldRef {
                                table,
                                column,
                                is_lookup: false,
                                hidden_items: sf.hidden_items.clone(),
                            })
                        }
                    })
                })
                .collect();
            let calc_fields: Option<Vec<super::types::CalculatedFieldDef>> = if definition.calculated_fields.is_empty() {
                None
            } else {
                Some(definition.calculated_fields.iter().map(|cf| {
                    super::types::CalculatedFieldDef {
                        name: cf.name.clone(),
                        formula: cf.formula.clone(),
                        number_format: cf.number_format.clone(),
                    }
                }).collect())
            };
            let value_column_order = if definition.value_column_order.is_empty() {
                None
            } else {
                Some(definition.value_column_order.iter().map(|v| {
                    match v {
                        pivot_engine::ValueColumnRef::Value(i) => super::types::ValueColumnRefDef::Value { index: *i },
                        pivot_engine::ValueColumnRef::Calculated(i) => super::types::ValueColumnRefDef::Calculated { index: *i },
                    }
                }).collect())
            };

            super::types::UpdateBiPivotFieldsRequest {
                pivot_id,
                row_fields,
                column_fields,
                value_fields,
                filter_fields,
                slicer_fields,
                row_hierarchies: Vec::new(),
                column_hierarchies: Vec::new(),
                layout: None, // keep current layout
                lookup_columns: meta.lookup_columns.iter().cloned().collect(),
                calculated_fields: calc_fields,
                value_column_order,
                calculation_group: meta.applied_calc_group.clone(),
            }
        };

        log_info!("CALP-DIAG", "refresh_pivot_cache: reconstructed BI request: rows={}, cols={}, values={}, filters={}",
            bi_request.row_fields.len(), bi_request.column_fields.len(),
            bi_request.value_fields.len(), bi_request.filter_fields.len());
        for (i, f) in bi_request.row_fields.iter().enumerate() {
            log_info!("CALP-DIAG", "  row_field[{}]: {}.{} (lookup={})", i, f.table, f.column, f.is_lookup);
        }
        for (i, f) in bi_request.value_fields.iter().enumerate() {
            log_info!("CALP-DIAG", "  value_field[{}]: {}", i, f.measure_name);
        }

        // Delegate to update_bi_pivot_fields which handles the full BI query flow
        return update_bi_pivot_fields(state, pivot_state, pane_control_state, ribbon_filter_state, bi_state, bi_request).await;
    }

    // 1. Lock briefly: read source info, build new cache from grid, release locks
    let (old_definition, old_cache, new_definition, new_cache, dest_sheet_idx, destination) = {
        let pivot_tables = pivot_state.pivot_tables.lock().unwrap();
        let (definition, cache) = pivot_tables
            .get(&pivot_id)
            .ok_or_else(|| format!("Pivot table {} not found", pivot_id))?;

        let destination = definition.destination;
        let dest_sheet_idx = resolve_dest_sheet_index(&state, definition);

        // Save old state for reversion on cancel
        let old_definition = definition.clone();
        let old_cache = cache.clone();
        pivot_state.previous_states.lock().unwrap()
            .insert(pivot_id, (old_definition.clone(), old_cache.clone()));

        {
            // Grid pivot: rebuild cache from source grid data
            let mut source_start = definition.source_start;
            let mut source_end = definition.source_end;
            let has_headers = definition.source_has_headers;
            let source_table_name = definition.source_table_name.clone();

            // If the pivot is linked to a table, resolve its current range
            let mut source_sheet_idx: usize = 0; // TODO: resolve from definition.source_sheet
            if let Some(ref table_name) = source_table_name {
                let table_names = state.table_names.lock().unwrap();
                if let Some((sheet_index, table_id)) = table_names.get(&table_name.to_uppercase()) {
                    let tables = state.tables.lock().unwrap();
                    if let Some(sheet_tables) = tables.get(sheet_index) {
                        if let Some(table) = sheet_tables.get(table_id) {
                            source_start = (table.start_row, table.start_col);
                            source_end = (table.end_row, table.end_col);
                            source_sheet_idx = table.sheet_index;
                            log_info!(
                                "PIVOT",
                                "resolved table '{}' -> ({},{})..({},{}) on sheet {}",
                                table_name, source_start.0, source_start.1,
                                source_end.0, source_end.1, source_sheet_idx
                            );
                        }
                    }
                }
            }

            drop(pivot_tables);

            // Get fresh data from grid (needs grids lock, but briefly)
            let grids = state.grids.lock().unwrap();
            let grid = grids
                .get(source_sheet_idx)
                .ok_or_else(|| "Source sheet not found".to_string())?;

            // Clamp source_end row to grid's actual data extent (handles full-column refs)
            if source_end.0 > grid.max_row {
                source_end.0 = grid.max_row;
            }

            let (fresh_cache, _headers) = build_cache_from_grid(grid, source_start, source_end, has_headers)?;
            drop(grids);

            // Update stored cache + bump version
            let mut pivot_tables = pivot_state.pivot_tables.lock().unwrap();
            let (definition, cache) = pivot_tables
                .get_mut(&pivot_id)
                .ok_or_else(|| format!("Pivot table {} not found", pivot_id))?;

            *cache = fresh_cache;
            // Update stored source coordinates (may have changed if linked to a table)
            definition.source_start = source_start;
            definition.source_end = source_end;
            definition.bump_version();

            let new_def = definition.clone();
            let new_cache = cache.clone();
            (old_definition, old_cache, new_def, new_cache, dest_sheet_idx, destination)
        }
    };

    // 2. Emit progress: calculating (stage 2 of 4)
    emit_pivot_progress(&window, pivot_id, "Calculating...", 1, 4);

    // 3. Heavy computation on blocking thread pool
    let definition = new_definition;
    let mut cache = new_cache;
    let calc_result = tokio::task::spawn_blocking(move || {
        let t0 = Instant::now();
        let view = safe_calculate_pivot(&definition, &mut cache);
        let calc_ms = t0.elapsed().as_secs_f64() * 1000.0;
        (view, definition, cache, calc_ms)
    })
    .await
    .map_err(|e| format!("Pivot computation failed: {}", e))?;

    let (view, definition, mut cache, calc_ms) = calc_result;

    // Check cancellation after computation
    if token.is_cancelled() {
        log_info!("PIVOT", "refresh_pivot_cache pivot_id={} CANCELLED after calculation", pivot_id);
        {
            let mut pivot_tables = pivot_state.pivot_tables.lock().unwrap();
            if let Some((def, c)) = pivot_tables.get_mut(&pivot_id) {
                *def = old_definition;
                *c = old_cache;
            }
        }
        pivot_state.cancellation_tokens.lock().unwrap().remove(&pivot_id);
        return Err("Pivot operation cancelled".into());
    }

    // 4. Emit progress: preparing response (stage 3 of 4)
    emit_pivot_progress(&window, pivot_id, "Preparing response...", 2, 4);

    let t1 = Instant::now();
    let mut response = view_to_response(&view, &definition, &mut cache);
    let serialize_ms = t1.elapsed().as_secs_f64() * 1000.0;

    // 5. Put updated definition + cache back
    {
        let mut pivot_tables = pivot_state.pivot_tables.lock().unwrap();
        if let Some((def, c)) = pivot_tables.get_mut(&pivot_id) {
            *def = definition;
            *c = cache;
        }
    }

    // Store view for windowed cell fetching
    store_view(&pivot_state, pivot_id, &view);

    // 6. Emit progress: writing to grid (stage 4 of 4)
    emit_pivot_progress(&window, pivot_id, "Updating grid...", 3, 4);

    // Check cancellation before grid write
    if token.is_cancelled() {
        log_info!("PIVOT", "refresh_pivot_cache pivot_id={} CANCELLED before grid write", pivot_id);
        {
            let mut pivot_tables = pivot_state.pivot_tables.lock().unwrap();
            if let Some((def, c)) = pivot_tables.get_mut(&pivot_id) {
                *def = old_definition;
                *c = old_cache;
            }
        }
        pivot_state.cancellation_tokens.lock().unwrap().remove(&pivot_id);
        return Err("Pivot operation cancelled".into());
    }

    // Count overwritten cells before writing pivot to grid
    response.overwritten_cell_count = count_overwritten_cells(&state, pivot_id, dest_sheet_idx, destination, &view);

    // Update pivot in grid
    update_pivot_in_grid(&state, pivot_id, dest_sheet_idx, destination, &view);

    // Update pivot region tracking
    update_pivot_region(&state, pivot_id, dest_sheet_idx, destination, &view);

    // Recalculate formulas referencing pivot cells
    recalculate_sheet_formulas(&state, &pivot_state, Some((&*pane_control_state, &*ribbon_filter_state)));

    // Clean up cancellation token
    pivot_state.cancellation_tokens.lock().unwrap().remove(&pivot_id);

    let total_ms = t_total.elapsed().as_secs_f64() * 1000.0;

    log_perf!(
        "PIVOT",
        "refresh_pivot_cache pivot_id={} version={} rows={} | calc={:.1}ms serialize={:.1}ms TOTAL={:.1}ms",
        pivot_id,
        response.version,
        response.row_count,
        calc_ms,
        serialize_ms,
        total_ms
    );

    Ok(response)
}

/// Check if a cell is within a pivot region and return pivot info if so
#[tauri::command]
pub fn get_pivot_at_cell(
    state: State<AppState>,
    pivot_state: State<'_, PivotState>,
    row: u32,
    col: u32,
) -> Result<Option<PivotRegionInfo>, String> {
    use crate::pivot::utils::{aggregation_to_string, report_layout_to_string, values_position_to_string};
    
    let active_sheet = *state.active_sheet.lock().unwrap();
    
    // Check if cell is in any pivot region (via the generic protected region system)
    let pivot_id = match state.get_region_at_cell(active_sheet, row, col) {
        Some(region) if region.region_type == "pivot" => region.owner_id,
        _ => return Ok(None),
    };
    
    log_debug!("PIVOT", "get_pivot_at_cell ({},{}) found pivot_id={}", row, col, pivot_id);
    
    // Get pivot info
    let pivot_tables = pivot_state.pivot_tables.lock().unwrap();
    let (definition, cache) = match pivot_tables.get(&pivot_id) {
        Some(t) => t,
        None => return Ok(None),
    };
    
    let is_empty = !has_fields_configured(definition);
    
    // Build source field info from cache
    let field_count = cache.field_count();
    let source_fields: Vec<SourceFieldInfo> = (0..field_count)
        .map(|i| {
            let name = cache.field_name(i).unwrap_or_else(|| format!("Field{}", i + 1));
            let is_numeric = cache.is_numeric_field(i);
            SourceFieldInfo {
                index: i,
                name,
                is_numeric,
                table_name: None,
            }
        })
        .collect();
    
    // Build current field configuration from definition
    let row_fields: Vec<ZoneFieldInfo> = definition.row_fields.iter().map(|f| {
        let is_numeric = cache.is_numeric_field(f.source_index);
        ZoneFieldInfo {
            source_index: f.source_index,
            name: f.name.clone(),
            is_numeric,
            aggregation: None,
            is_lookup: f.is_attribute,
            hidden_items: None,
            custom_name: None,
        }
    }).collect();

    let column_fields: Vec<ZoneFieldInfo> = definition.column_fields.iter().map(|f| {
        let is_numeric = cache.is_numeric_field(f.source_index);
        ZoneFieldInfo {
            source_index: f.source_index,
            name: f.name.clone(),
            is_numeric,
            aggregation: None,
            is_lookup: f.is_attribute,
            hidden_items: None,
            custom_name: None,
        }
    }).collect();

    // Collapse calculation-group expansion: a calc group renders M base measures
    // as M*K value fields (one per item), all sharing the base measure's `name`.
    // The editor's Values zone shows the K base measures (the applied group is a
    // separate control), so emit one zone entry per base measure and drop the
    // item-specific custom_name.
    let value_fields: Vec<ZoneFieldInfo> = {
        let mut seen_calc: std::collections::HashSet<String> = std::collections::HashSet::new();
        definition.value_fields.iter().filter_map(|f| {
            if f.calc_item.is_some() && !seen_calc.insert(f.name.clone()) {
                return None;
            }
            let is_numeric = cache.is_numeric_field(f.source_index);
            Some(ZoneFieldInfo {
                source_index: f.source_index,
                name: f.name.clone(),
                is_numeric,
                aggregation: Some(aggregation_to_string(f.aggregation)),
                is_lookup: false,
                hidden_items: None,
                custom_name: if f.calc_item.is_some() { None } else { f.custom_name.clone() },
            })
        }).collect()
    };

    let filter_fields: Vec<ZoneFieldInfo> = definition.filter_fields.iter().map(|f| {
        let is_numeric = cache.is_numeric_field(f.field.source_index);
        let hidden = if f.field.hidden_items.is_empty() {
            None
        } else {
            Some(f.field.hidden_items.clone())
        };
        ZoneFieldInfo {
            source_index: f.field.source_index,
            name: f.field.name.clone(),
            is_numeric,
            aggregation: None,
            is_lookup: f.field.is_attribute,
            hidden_items: hidden,
            custom_name: None,
        }
    }).collect();
    
    let layout = LayoutConfig {
        show_row_grand_totals: Some(definition.layout.show_row_grand_totals),
        show_column_grand_totals: Some(definition.layout.show_column_grand_totals),
        report_layout: Some(report_layout_to_string(definition.layout.report_layout)),
        repeat_row_labels: Some(definition.layout.repeat_row_labels),
        show_empty_rows: Some(definition.layout.show_empty_rows),
        show_empty_cols: Some(definition.layout.show_empty_cols),
        values_position: Some(values_position_to_string(definition.layout.values_position)),
        auto_format: None,
        preserve_formatting: None,
        show_field_headers: None,
        enable_field_list: None,
        empty_cell_text: None,
        fill_empty_cells: None,
        subtotal_location: None,
        alt_text_title: None,
        alt_text_description: None,
        auto_fit_column_widths: Some(definition.layout.auto_fit_column_widths),
    };
    
    let calc_fields: Vec<CalculatedFieldDef> = definition.calculated_fields.iter().map(|cf| {
        CalculatedFieldDef {
            name: cf.name.clone(),
            formula: cf.formula.clone(),
            number_format: cf.number_format.clone(),
        }
    }).collect();

    let hierarchy_configs: Vec<HierarchyConfigInfo> = definition.hierarchy_configs
        .iter()
        .map(|hc| HierarchyConfigInfo {
            name: hc.name.clone(),
            field_start: hc.field_start,
            field_count: hc.field_count,
            is_row: hc.is_row,
        })
        .collect();

    let field_configuration = PivotFieldConfiguration {
        row_fields,
        column_fields,
        value_fields,
        filter_fields: filter_fields.clone(),
        layout,
        calculated_fields: calc_fields,
        hierarchy_configs,
    };

    // Calculate filter zones from filter field configuration
    // Filter fields are rendered at the top of the pivot:
    // Each filter field occupies one row with label in col 0 and dropdown in col 1
    let destination = definition.destination;
    let filter_zones: Vec<FilterZoneInfo> = filter_fields
        .iter()
        .enumerate()
        .map(|(idx, field)| FilterZoneInfo {
            row: destination.0 + idx as u32,      // Row relative to pivot start
            col: destination.1 + 1,               // Dropdown is in column 1 (after label)
            field_index: field.source_index,
            field_name: field.name.clone(),
        })
        .collect();

    // Check if this is a BI-backed pivot and populate bi_model
    let bi_model = {
        let bi_meta = pivot_state.bi_metadata.lock().unwrap();
        bi_meta.get(&pivot_id).map(|meta| {
            log_info!(
                "CALP-DIAG",
                "get_pivot_at_cell: BI pivot_id={}, connection_id={}, {} tables, {} measures, row_fields={}, col_fields={}, val_fields={}",
                pivot_id,
                meta.connection_id,
                meta.model_tables.len(),
                meta.measures.len(),
                field_configuration.row_fields.len(),
                field_configuration.column_fields.len(),
                field_configuration.value_fields.len()
            );
            BiPivotModelInfo {
                connection_id: meta.connection_id,
                tables: meta.model_tables.clone(),
                measures: meta.measures.clone(),
                lookup_columns: meta.lookup_columns.iter().cloned().collect(),
                hierarchies: meta.hierarchies.clone(),
                calculation_groups: meta.calculation_groups.clone(),
                applied_calculation_group: meta.applied_calc_group.clone(),
                data_as_of: meta.data_as_of.clone(),
            }
        })
    };

    // For BI pivots, filter out the synthetic "Total" row field
    // (it's an internal implementation detail, not a user-visible field)
    let field_configuration = if bi_model.is_some() {
        PivotFieldConfiguration {
            row_fields: field_configuration.row_fields.into_iter()
                .filter(|f| f.name != "Total")
                .collect(),
            ..field_configuration
        }
    } else {
        field_configuration
    };

    Ok(Some(PivotRegionInfo {
        pivot_id,
        is_empty,
        source_fields,
        field_configuration,
        filter_zones,
        bi_model,
        source_table_name: definition.source_table_name.clone(),
    }))
}

/// Resolve a grid cell into GETPIVOTDATA formula arguments.
/// Returns the data field name and field/item pairs for the cell.
#[tauri::command]
pub fn get_pivot_data_formula(
    state: State<AppState>,
    pivot_state: State<'_, PivotState>,
    row: u32,
    col: u32,
) -> Result<Option<super::types::GetPivotDataFormulaResult>, String> {
    let active_sheet = *state.active_sheet.lock().unwrap();

    // Check if cell is in a pivot region
    let _pivot_id = match state.get_region_at_cell(active_sheet, row, col) {
        Some(region) if region.region_type == "pivot" => region.owner_id,
        _ => return Ok(None),
    };

    let pivot_tables = pivot_state.pivot_tables.lock().unwrap();
    let pivot_views = pivot_state.views.lock().unwrap();

    Ok(crate::pivot::operations::resolve_pivot_data_formula(
        &pivot_tables,
        &pivot_views,
        row,
        col,
    ))
}

/// Get all pivot regions for the current sheet (for rendering placeholders)
#[tauri::command]
pub fn get_pivot_regions_for_sheet(
    state: State<AppState>,
    pivot_state: State<'_, PivotState>,
) -> Vec<PivotRegionData> {
    let active_sheet = *state.active_sheet.lock().unwrap();
    let regions = state.protected_regions.lock().unwrap();
    let pivot_tables = pivot_state.pivot_tables.lock().unwrap();

    regions
        .iter()
        .filter(|r| r.region_type == "pivot" && r.sheet_index == active_sheet)
        .map(|r| {
            let pid = r.owner_id;
            let (is_empty, name) = pivot_tables
                .get(&pid)
                .map(|(def, _)| (
                    !has_fields_configured(def),
                    def.name.clone().unwrap_or_else(|| format!("PivotTable{}", pid)),
                ))
                .unwrap_or_else(|| (true, format!("PivotTable{}", pid)));

            PivotRegionData {
                pivot_id: pid,
                name,
                start_row: r.start_row,
                start_col: r.start_col,
                end_row: r.end_row,
                end_col: r.end_col,
                is_empty,
            }
        })
        .collect()
}

/// Get unique values for a pivot field (for filter dropdowns)
#[tauri::command]
pub fn get_pivot_field_unique_values(
    _state: State<AppState>,
    pivot_state: State<'_, PivotState>,
    pivot_id: PivotId,
    field_index: usize,
) -> Result<FieldUniqueValuesResponse, String> {
    log_debug!(
        "PIVOT",
        "get_pivot_field_unique_values pivot_id={} field_index={}",
        pivot_id,
        field_index
    );

    let mut pivot_tables = pivot_state.pivot_tables.lock().unwrap();
    let (_, cache) = pivot_tables
        .get_mut(&pivot_id)
        .ok_or_else(|| format!("Pivot table {} not found", pivot_id))?;

    // Get field cache
    let field = cache.fields
        .get_mut(field_index)
        .ok_or_else(|| format!("Field index {} out of range", field_index))?;

    let field_name = field.name.clone();

    // Collect unique values as strings
    // Clone sorted_ids to end the mutable borrow before calling get_value
    let sorted_ids = field.sorted_ids().to_vec();
    
    let unique_values: Vec<String> = sorted_ids
        .iter()
        .filter_map(|&id| {
            if id == VALUE_ID_EMPTY {
                return None;
            }
            field.get_value(id).map(|value| cache_value_to_string(value))
        })
        .collect();

    log_debug!(
        "PIVOT",
        "get_pivot_field_unique_values returning {} unique values for field '{}'",
        unique_values.len(),
        field_name
    );

    Ok(FieldUniqueValuesResponse {
        field_index,
        field_name,
        unique_values,
    })
}

// ============================================================================
// NEW EXCEL-COMPATIBLE COMMANDS
// ============================================================================

/// Gets pivot table properties and info.
#[tauri::command]
pub fn get_pivot_table_info(
    _state: State<AppState>,
    pivot_state: State<'_, PivotState>,
    pivot_id: PivotId,
) -> Result<PivotTableInfo, String> {
    log_debug!("PIVOT", "get_pivot_table_info pivot_id={}", pivot_id);

    let pivot_tables = pivot_state.pivot_tables.lock().unwrap();
    let (definition, _) = pivot_tables
        .get(&pivot_id)
        .ok_or_else(|| format!("Pivot table {} not found", pivot_id))?;

    let source_range = definition.source_range_display.clone()
        .unwrap_or_else(|| format_range(definition.source_start, definition.source_end));
    let destination = format_cell(definition.destination);

    Ok(PivotTableInfo {
        id: definition.id,
        name: definition.name.clone().unwrap_or_else(|| format!("PivotTable{}", pivot_id)),
        source_range,
        destination,
        allow_multiple_filters_per_field: definition.allow_multiple_filters_per_field,
        enable_data_value_editing: definition.enable_data_value_editing,
        refresh_on_open: definition.refresh_on_open,
        use_custom_sort_lists: definition.use_custom_sort_lists,
        has_headers: definition.source_has_headers,
        source_table_name: definition.source_table_name.clone(),
    })
}

/// Updates pivot table properties.
#[tauri::command]
pub fn update_pivot_properties(
    _state: State<AppState>,
    pivot_state: State<'_, PivotState>,
    request: UpdatePivotPropertiesRequest,
) -> Result<PivotTableInfo, String> {
    log_info!("PIVOT", "update_pivot_properties pivot_id={}", request.pivot_id);

    let mut pivot_tables = pivot_state.pivot_tables.lock().unwrap();
    let (definition, _) = pivot_tables
        .get_mut(&request.pivot_id)
        .ok_or_else(|| format!("Pivot table {} not found", request.pivot_id))?;

    // Update properties
    if let Some(name) = request.name {
        definition.name = Some(name);
    }
    if let Some(v) = request.allow_multiple_filters_per_field {
        definition.allow_multiple_filters_per_field = v;
    }
    if let Some(v) = request.enable_data_value_editing {
        definition.enable_data_value_editing = v;
    }
    if let Some(v) = request.refresh_on_open {
        definition.refresh_on_open = v;
    }
    if let Some(v) = request.use_custom_sort_lists {
        definition.use_custom_sort_lists = v;
    }

    let source_range = definition.source_range_display.clone()
        .unwrap_or_else(|| format_range(definition.source_start, definition.source_end));
    let destination = format_cell(definition.destination);

    Ok(PivotTableInfo {
        id: definition.id,
        name: definition.name.clone().unwrap_or_else(|| format!("PivotTable{}", request.pivot_id)),
        source_range,
        destination,
        allow_multiple_filters_per_field: definition.allow_multiple_filters_per_field,
        enable_data_value_editing: definition.enable_data_value_editing,
        refresh_on_open: definition.refresh_on_open,
        use_custom_sort_lists: definition.use_custom_sort_lists,
        has_headers: definition.source_has_headers,
        source_table_name: definition.source_table_name.clone(),
    })
}

/// Changes the source data range of an existing pivot table.
/// Parses the new range, rebuilds the cache from the grid, and recalculates.
#[tauri::command]
pub async fn change_pivot_data_source(
    window: tauri::Window,
    state: State<'_, AppState>,
    pivot_state: State<'_, PivotState>,
    pane_control_state: State<'_, crate::pane_control::PaneControlState>,
    ribbon_filter_state: State<'_, crate::ribbon_filter::RibbonFilterState>,
    request: ChangePivotDataSourceRequest,
) -> Result<PivotViewResponse, String> {
    let pivot_id = request.pivot_id;
    log_info!(
        "PIVOT",
        "change_pivot_data_source pivot_id={} new_range={}",
        pivot_id,
        request.source_range
    );

    // Parse the new range
    let (source_start, mut source_end) = parse_range(&request.source_range)?;

    // Get source sheet
    let source_sheet_idx = request.source_sheet.unwrap_or_else(|| {
        *state.active_sheet.lock().unwrap()
    });

    // Clamp source_end to grid's actual data extent (handles full-column refs)
    {
        let grids = state.grids.lock().unwrap();
        let grid = grids
            .get(source_sheet_idx)
            .ok_or_else(|| format!("Sheet index {} not found", source_sheet_idx))?;

        if source_end.0 > grid.max_row {
            log_info!(
                "PIVOT",
                "clamping source end_row from {} to {} (grid.max_row)",
                source_end.0,
                grid.max_row
            );
            source_end.0 = grid.max_row;
        }
    }

    // Update definition and rebuild cache
    let (definition, cache, dest_sheet_idx, destination) = {
        let mut pivot_tables = pivot_state.pivot_tables.lock().unwrap();
        let (definition, _cache) = pivot_tables
            .get_mut(&pivot_id)
            .ok_or_else(|| format!("Pivot table {} not found", pivot_id))?;

        // Update source range in definition
        definition.source_start = source_start;
        definition.source_end = source_end;
        definition.source_range_display = Some(request.source_range.clone());
        definition.bump_version();

        let has_headers = definition.source_has_headers;
        let destination = definition.destination;
        let dest_sheet_idx = resolve_dest_sheet_index(&state, definition);

        drop(pivot_tables);

        // Build new cache from grid
        let grids = state.grids.lock().unwrap();
        let grid = grids
            .get(source_sheet_idx)
            .ok_or_else(|| format!("Sheet index {} not found", source_sheet_idx))?;

        let (fresh_cache, _headers) =
            build_cache_from_grid(grid, source_start, source_end, has_headers)?;
        drop(grids);

        // Store the new cache
        let mut pivot_tables = pivot_state.pivot_tables.lock().unwrap();
        let (definition, cache) = pivot_tables
            .get_mut(&pivot_id)
            .ok_or_else(|| format!("Pivot table {} not found", pivot_id))?;
        *cache = fresh_cache;

        (definition.clone(), cache.clone(), dest_sheet_idx, destination)
    };

    // Recalculate pivot
    emit_pivot_progress(&window, pivot_id, "Calculating...", 1, 4);
    let mut cache_mut = cache;
    let mut view = safe_calculate_pivot(&definition, &mut cache_mut);
    ensure_children_indices(&mut view);
    store_view(&pivot_state, pivot_id, &view);

    // Write to grid
    emit_pivot_progress(&window, pivot_id, "Updating grid...", 3, 4);
    let overwritten = count_overwritten_cells(&state, pivot_id, dest_sheet_idx, destination, &view);
    finalize_pivot_update(&state, &pivot_state, pivot_id, dest_sheet_idx, destination, &view, Some((&*pane_control_state, &*ribbon_filter_state)));

    // Store updated cache
    {
        let mut pivot_tables = pivot_state.pivot_tables.lock().unwrap();
        if let Some((_def, cache)) = pivot_tables.get_mut(&pivot_id) {
            *cache = cache_mut;
        }
    }

    let mut final_cache = {
        let pivot_tables = pivot_state.pivot_tables.lock().unwrap();
        let (_def, cache) = pivot_tables.get(&pivot_id).unwrap();
        cache.clone()
    };
    let mut response = view_to_response(&view, &definition, &mut final_cache);
    response.overwritten_cell_count = overwritten;

    log_info!(
        "PIVOT",
        "change_pivot_data_source complete: pivot_id={} new_source={}:{} rows={}",
        pivot_id,
        format_cell(source_start),
        format_cell(source_end),
        response.row_count
    );

    Ok(response)
}

/// Gets pivot layout ranges (data body, row labels, column labels, filter axis).
#[tauri::command]
pub fn get_pivot_layout_ranges(
    _state: State<AppState>,
    pivot_state: State<'_, PivotState>,
    pivot_id: PivotId,
) -> Result<PivotLayoutRanges, String> {
    log_debug!("PIVOT", "get_pivot_layout_ranges pivot_id={}", pivot_id);

    let mut pivot_tables = pivot_state.pivot_tables.lock().unwrap();
    let (definition, cache) = pivot_tables
        .get_mut(&pivot_id)
        .ok_or_else(|| format!("Pivot table {} not found", pivot_id))?;

    // Calculate view to get accurate ranges
    let view = safe_calculate_pivot(definition, cache);
    store_view(&pivot_state, pivot_id, &view);
    let (dest_row, dest_col) = definition.destination;

    // If view is empty, return empty ranges
    if view.row_count == 0 || view.col_count == 0 {
        return Ok(PivotLayoutRanges {
            range: None,
            data_body_range: None,
            column_label_range: None,
            row_label_range: None,
            filter_axis_range: None,
        });
    }

    // Full range (excluding filter area)
    let filter_rows = view.filter_row_count;
    let range_start_row = dest_row + filter_rows as u32;
    let range = Some(RangeInfo {
        start_row: range_start_row,
        start_col: dest_col,
        end_row: dest_row + view.row_count as u32 - 1,
        end_col: dest_col + view.col_count as u32 - 1,
        address: format_range(
            (range_start_row, dest_col),
            (dest_row + view.row_count as u32 - 1, dest_col + view.col_count as u32 - 1),
        ),
    });

    // Data body range (values only, after headers)
    let data_start_row = dest_row + filter_rows as u32 + view.column_header_row_count as u32;
    let data_start_col = dest_col + view.row_label_col_count as u32;
    let data_body_range = if view.row_count > view.column_header_row_count
        && view.col_count > view.row_label_col_count {
        Some(RangeInfo {
            start_row: data_start_row,
            start_col: data_start_col,
            end_row: dest_row + view.row_count as u32 - 1,
            end_col: dest_col + view.col_count as u32 - 1,
            address: format_range(
                (data_start_row, data_start_col),
                (dest_row + view.row_count as u32 - 1, dest_col + view.col_count as u32 - 1),
            ),
        })
    } else {
        None
    };

    // Column label range (header rows, data columns only)
    let column_label_range = if view.column_header_row_count > 0 && view.col_count > view.row_label_col_count {
        Some(RangeInfo {
            start_row: range_start_row,
            start_col: data_start_col,
            end_row: data_start_row - 1,
            end_col: dest_col + view.col_count as u32 - 1,
            address: format_range(
                (range_start_row, data_start_col),
                (data_start_row - 1, dest_col + view.col_count as u32 - 1),
            ),
        })
    } else {
        None
    };

    // Row label range (all data rows, label columns only)
    let row_label_range = if view.row_label_col_count > 0 && view.row_count > view.column_header_row_count {
        Some(RangeInfo {
            start_row: data_start_row,
            start_col: dest_col,
            end_row: dest_row + view.row_count as u32 - 1,
            end_col: data_start_col - 1,
            address: format_range(
                (data_start_row, dest_col),
                (dest_row + view.row_count as u32 - 1, data_start_col - 1),
            ),
        })
    } else {
        None
    };

    // Filter axis range
    let filter_axis_range = if filter_rows > 0 {
        Some(RangeInfo {
            start_row: dest_row,
            start_col: dest_col,
            end_row: dest_row + filter_rows as u32 - 1,
            end_col: dest_col + 1, // Label and dropdown columns
            address: format_range(
                (dest_row, dest_col),
                (dest_row + filter_rows as u32 - 1, dest_col + 1),
            ),
        })
    } else {
        None
    };

    Ok(PivotLayoutRanges {
        range,
        data_body_range,
        column_label_range,
        row_label_range,
        filter_axis_range,
    })
}

/// Updates pivot layout properties.
#[tauri::command]
pub fn update_pivot_layout(
    state: State<AppState>,
    pivot_state: State<'_, PivotState>,
    pane_control_state: State<'_, crate::pane_control::PaneControlState>,
    ribbon_filter_state: State<'_, crate::ribbon_filter::RibbonFilterState>,
    request: UpdatePivotLayoutRequest,
) -> Result<PivotViewResponse, String> {
    log_info!("PIVOT", "update_pivot_layout pivot_id={}", request.pivot_id);

    let mut pivot_tables = pivot_state.pivot_tables.lock().unwrap();
    let (definition, cache) = pivot_tables
        .get_mut(&request.pivot_id)
        .ok_or_else(|| format!("Pivot table {} not found", request.pivot_id))?;

    // Apply layout configuration
    apply_layout_config(&mut definition.layout, &request.layout);

    // Apply new Excel-compatible layout properties
    if let Some(v) = request.layout.auto_format {
        definition.layout.auto_format = v;
    }
    if let Some(v) = request.layout.preserve_formatting {
        definition.layout.preserve_formatting = v;
    }
    if let Some(v) = request.layout.show_field_headers {
        definition.layout.show_field_headers = v;
    }
    if let Some(v) = request.layout.enable_field_list {
        definition.layout.enable_field_list = v;
    }
    if let Some(ref text) = request.layout.empty_cell_text {
        definition.layout.empty_cell_text = Some(text.clone());
    }
    if let Some(v) = request.layout.fill_empty_cells {
        definition.layout.fill_empty_cells = v;
    }
    if let Some(ref title) = request.layout.alt_text_title {
        definition.layout.alt_text_title = Some(title.clone());
    }
    if let Some(ref desc) = request.layout.alt_text_description {
        definition.layout.alt_text_description = Some(desc.clone());
    }
    if let Some(ref loc) = request.layout.subtotal_location {
        definition.layout.subtotal_location = api_subtotal_location_to_engine(loc);
    }

    // Bump version
    definition.bump_version();

    // Recalculate view
    let view = safe_calculate_pivot(definition, cache);
    store_view(&pivot_state, request.pivot_id, &view);
    let mut response = view_to_response(&view, definition, cache);

    // Get destination info
    let destination = definition.destination;
    let pivot_id = definition.id;
    let dest_sheet_idx = resolve_dest_sheet_index(&state, definition);

    drop(pivot_tables);

    // Update pivot in grid
    response.overwritten_cell_count = count_overwritten_cells(&state, pivot_id, dest_sheet_idx, destination, &view);
    finalize_pivot_update(&state, &pivot_state, pivot_id, dest_sheet_idx, destination, &view, Some((&*pane_control_state, &*ribbon_filter_state)));

    Ok(response)
}

/// Gets all hierarchies info for a pivot table.
#[tauri::command]
pub fn get_pivot_hierarchies(
    _state: State<AppState>,
    pivot_state: State<'_, PivotState>,
    pivot_id: PivotId,
) -> Result<PivotHierarchiesInfo, String> {
    log_debug!("PIVOT", "get_pivot_hierarchies pivot_id={}", pivot_id);

    let pivot_tables = pivot_state.pivot_tables.lock().unwrap();
    let (definition, cache) = pivot_tables
        .get(&pivot_id)
        .ok_or_else(|| format!("Pivot table {} not found", pivot_id))?;

    // Build source field info from cache
    let field_count = cache.field_count();
    let hierarchies: Vec<SourceFieldInfo> = (0..field_count)
        .map(|i| {
            let name = cache.field_name(i).unwrap_or_else(|| format!("Field{}", i + 1));
            let is_numeric = cache.is_numeric_field(i);
            SourceFieldInfo {
                index: i,
                name,
                is_numeric,
                table_name: None,
            }
        })
        .collect();

    // Row hierarchies
    let row_hierarchies: Vec<RowColumnHierarchyInfo> = definition.row_fields
        .iter()
        .enumerate()
        .map(|(pos, f)| RowColumnHierarchyInfo {
            id: f.source_index,
            name: f.name.clone(),
            field_index: f.source_index,
            position: pos,
        })
        .collect();

    // Column hierarchies
    let column_hierarchies: Vec<RowColumnHierarchyInfo> = definition.column_fields
        .iter()
        .enumerate()
        .map(|(pos, f)| RowColumnHierarchyInfo {
            id: f.source_index,
            name: f.name.clone(),
            field_index: f.source_index,
            position: pos,
        })
        .collect();

    // Collect all pivot fields for base_field name resolution
    let all_fields: Vec<pivot_engine::PivotField> = definition.row_fields.iter()
        .chain(definition.column_fields.iter())
        .chain(definition.filter_fields.iter().map(|f| &f.field))
        .cloned()
        .collect();

    // Data hierarchies
    let data_hierarchies: Vec<DataHierarchyInfo> = definition.value_fields
        .iter()
        .enumerate()
        .map(|(pos, f)| DataHierarchyInfo {
            id: f.source_index,
            name: f.name.clone(),
            field_index: f.source_index,
            summarize_by: aggregation_type_to_api(f.aggregation),
            number_format: f.number_format.clone(),
            position: pos,
            show_as: show_values_as_to_api(f, &all_fields),
        })
        .collect();

    // Filter hierarchies
    let filter_hierarchies: Vec<RowColumnHierarchyInfo> = definition.filter_fields
        .iter()
        .enumerate()
        .map(|(pos, f)| RowColumnHierarchyInfo {
            id: f.field.source_index,
            name: f.field.name.clone(),
            field_index: f.field.source_index,
            position: pos,
        })
        .collect();

    // Check if this is a BI-backed pivot and include bi_model
    let bi_model = {
        let bi_meta = pivot_state.bi_metadata.lock().unwrap();
        bi_meta.get(&pivot_id).map(|meta| {
            BiPivotModelInfo {
                connection_id: meta.connection_id,
                tables: meta.model_tables.clone(),
                measures: meta.measures.clone(),
                lookup_columns: meta.lookup_columns.iter().cloned().collect(),
                hierarchies: meta.hierarchies.clone(),
                calculation_groups: meta.calculation_groups.clone(),
                applied_calculation_group: meta.applied_calc_group.clone(),
                data_as_of: meta.data_as_of.clone(),
            }
        })
    };

    // Slicer filter field names (resolve source_index to name from cache)
    let slicer_filter_fields: Vec<String> = definition.slicer_filters.iter()
        .filter_map(|sf| {
            cache.field_name(sf.source_index).map(|name| {
                // If the cache field name is bare "column", try to resolve
                // to "table.column" using the definition field names as reference.
                if !name.contains('.') {
                    // Search all definition fields for one that ends with this column name
                    let all_def_names: Vec<&str> = definition.row_fields.iter()
                        .chain(definition.column_fields.iter())
                        .chain(definition.filter_fields.iter().map(|f| &f.field))
                        .map(|f| f.name.as_str())
                        .collect();
                    // Check if the column belongs to any known table in BI metadata
                    let bi_meta = pivot_state.bi_metadata.lock().unwrap();
                    if let Some(meta) = bi_meta.get(&pivot_id) {
                        for t in &meta.model_tables {
                            if t.columns.iter().any(|c| c.name == name) {
                                return format!("{}.{}", t.name, name);
                            }
                        }
                    }
                    // If we can't find the table, check if any definition field has
                    // this column name as a suffix
                    for def_name in &all_def_names {
                        if def_name.ends_with(&format!(".{}", name)) {
                            return def_name.to_string();
                        }
                    }
                }
                name
            })
        })
        .collect();

    Ok(PivotHierarchiesInfo {
        hierarchies,
        row_hierarchies,
        column_hierarchies,
        data_hierarchies,
        filter_hierarchies,
        slicer_filter_fields,
        bi_model,
    })
}

/// Adds a field to a hierarchy (row, column, data, or filter).
#[tauri::command]
pub fn add_pivot_hierarchy(
    state: State<AppState>,
    pivot_state: State<'_, PivotState>,
    pane_control_state: State<'_, crate::pane_control::PaneControlState>,
    ribbon_filter_state: State<'_, crate::ribbon_filter::RibbonFilterState>,
    request: AddHierarchyRequest,
) -> Result<PivotViewResponse, String> {
    log_info!(
        "PIVOT",
        "add_pivot_hierarchy pivot_id={} field={} axis={:?}",
        request.pivot_id,
        request.field_index,
        request.axis
    );

    let mut pivot_tables = pivot_state.pivot_tables.lock().unwrap();
    let (definition, cache) = pivot_tables
        .get_mut(&request.pivot_id)
        .ok_or_else(|| format!("Pivot table {} not found", request.pivot_id))?;

    // Get field name from cache
    let field_name = request.name.clone()
        .or_else(|| cache.field_name(request.field_index))
        .unwrap_or_else(|| format!("Field{}", request.field_index + 1));

    match request.axis {
        PivotAxis::Row => {
            let field = pivot_engine::PivotField::new(request.field_index, field_name);
            let position = request.position.unwrap_or(definition.row_fields.len());
            if position <= definition.row_fields.len() {
                definition.row_fields.insert(position, field);
            } else {
                definition.row_fields.push(field);
            }
        }
        PivotAxis::Column => {
            let field = pivot_engine::PivotField::new(request.field_index, field_name);
            let position = request.position.unwrap_or(definition.column_fields.len());
            if position <= definition.column_fields.len() {
                definition.column_fields.insert(position, field);
            } else {
                definition.column_fields.push(field);
            }
        }
        PivotAxis::Data => {
            let aggregation = request.aggregation
                .map(api_to_aggregation_type)
                .unwrap_or(pivot_engine::AggregationType::Sum);
            let field = pivot_engine::ValueField::new(request.field_index, field_name, aggregation);
            let position = request.position.unwrap_or(definition.value_fields.len());
            if position <= definition.value_fields.len() {
                definition.value_fields.insert(position, field);
            } else {
                definition.value_fields.push(field);
            }
        }
        PivotAxis::Filter => {
            let field = pivot_engine::PivotField::new(request.field_index, field_name);
            let filter = pivot_engine::PivotFilter {
                field,
                condition: pivot_engine::FilterCondition::ValueList(Vec::new()),
            };
            let position = request.position.unwrap_or(definition.filter_fields.len());
            if position <= definition.filter_fields.len() {
                definition.filter_fields.insert(position, filter);
            } else {
                definition.filter_fields.push(filter);
            }
        }
        PivotAxis::Unknown => {
            return Err("Cannot add to Unknown axis".to_string());
        }
    }

    definition.bump_version();

    // Recalculate view
    let view = safe_calculate_pivot(definition, cache);
    store_view(&pivot_state, request.pivot_id, &view);
    let mut response = view_to_response(&view, definition, cache);

    let destination = definition.destination;
    let pivot_id = definition.id;
    let dest_sheet_idx = resolve_dest_sheet_index(&state, definition);

    drop(pivot_tables);

    response.overwritten_cell_count = count_overwritten_cells(&state, pivot_id, dest_sheet_idx, destination, &view);
    finalize_pivot_update(&state, &pivot_state, pivot_id, dest_sheet_idx, destination, &view, Some((&*pane_control_state, &*ribbon_filter_state)));

    Ok(response)
}

/// Removes a field from a hierarchy.
#[tauri::command]
pub fn remove_pivot_hierarchy(
    state: State<AppState>,
    pivot_state: State<'_, PivotState>,
    pane_control_state: State<'_, crate::pane_control::PaneControlState>,
    ribbon_filter_state: State<'_, crate::ribbon_filter::RibbonFilterState>,
    request: RemoveHierarchyRequest,
) -> Result<PivotViewResponse, String> {
    log_info!(
        "PIVOT",
        "remove_pivot_hierarchy pivot_id={} axis={:?} pos={}",
        request.pivot_id,
        request.axis,
        request.position
    );

    let mut pivot_tables = pivot_state.pivot_tables.lock().unwrap();
    let (definition, cache) = pivot_tables
        .get_mut(&request.pivot_id)
        .ok_or_else(|| format!("Pivot table {} not found", request.pivot_id))?;

    match request.axis {
        PivotAxis::Row => {
            if request.position < definition.row_fields.len() {
                definition.row_fields.remove(request.position);
            } else {
                return Err(format!("Position {} out of range for row fields", request.position));
            }
        }
        PivotAxis::Column => {
            if request.position < definition.column_fields.len() {
                definition.column_fields.remove(request.position);
            } else {
                return Err(format!("Position {} out of range for column fields", request.position));
            }
        }
        PivotAxis::Data => {
            if request.position < definition.value_fields.len() {
                definition.value_fields.remove(request.position);
            } else {
                return Err(format!("Position {} out of range for value fields", request.position));
            }
        }
        PivotAxis::Filter => {
            if request.position < definition.filter_fields.len() {
                definition.filter_fields.remove(request.position);
            } else {
                return Err(format!("Position {} out of range for filter fields", request.position));
            }
        }
        PivotAxis::Unknown => {
            return Err("Cannot remove from Unknown axis".to_string());
        }
    }

    definition.bump_version();

    let view = safe_calculate_pivot(definition, cache);
    store_view(&pivot_state, request.pivot_id, &view);
    let mut response = view_to_response(&view, definition, cache);

    let destination = definition.destination;
    let pivot_id = definition.id;
    let dest_sheet_idx = resolve_dest_sheet_index(&state, definition);

    drop(pivot_tables);

    response.overwritten_cell_count = count_overwritten_cells(&state, pivot_id, dest_sheet_idx, destination, &view);
    finalize_pivot_update(&state, &pivot_state, pivot_id, dest_sheet_idx, destination, &view, Some((&*pane_control_state, &*ribbon_filter_state)));

    Ok(response)
}

/// Moves a field between hierarchies.
#[tauri::command]
pub fn move_pivot_field(
    state: State<AppState>,
    pivot_state: State<'_, PivotState>,
    pane_control_state: State<'_, crate::pane_control::PaneControlState>,
    ribbon_filter_state: State<'_, crate::ribbon_filter::RibbonFilterState>,
    request: MoveFieldRequest,
) -> Result<PivotViewResponse, String> {
    log_info!(
        "PIVOT",
        "move_pivot_field pivot_id={} field={} target={:?}",
        request.pivot_id,
        request.field_index,
        request.target_axis
    );

    let mut pivot_tables = pivot_state.pivot_tables.lock().unwrap();
    let (definition, cache) = pivot_tables
        .get_mut(&request.pivot_id)
        .ok_or_else(|| format!("Pivot table {} not found", request.pivot_id))?;

    // Find and remove field from its current location
    let mut field_name = String::new();
    let mut found = false;

    // Check row fields
    if let Some(pos) = definition.row_fields.iter().position(|f| f.source_index == request.field_index) {
        field_name = definition.row_fields[pos].name.clone();
        definition.row_fields.remove(pos);
        found = true;
    }
    // Check column fields
    if !found {
        if let Some(pos) = definition.column_fields.iter().position(|f| f.source_index == request.field_index) {
            field_name = definition.column_fields[pos].name.clone();
            definition.column_fields.remove(pos);
            found = true;
        }
    }
    // Check value fields
    if !found {
        if let Some(pos) = definition.value_fields.iter().position(|f| f.source_index == request.field_index) {
            field_name = definition.value_fields[pos].name.clone();
            definition.value_fields.remove(pos);
            found = true;
        }
    }
    // Check filter fields
    if !found {
        if let Some(pos) = definition.filter_fields.iter().position(|f| f.field.source_index == request.field_index) {
            field_name = definition.filter_fields[pos].field.name.clone();
            definition.filter_fields.remove(pos);
            found = true;
        }
    }

    // If not found, get name from cache
    if !found {
        field_name = cache.field_name(request.field_index)
            .unwrap_or_else(|| format!("Field{}", request.field_index + 1));
    }

    // Add to target axis
    match request.target_axis {
        PivotAxis::Row => {
            let field = pivot_engine::PivotField::new(request.field_index, field_name);
            let position = request.position.unwrap_or(definition.row_fields.len());
            if position <= definition.row_fields.len() {
                definition.row_fields.insert(position, field);
            } else {
                definition.row_fields.push(field);
            }
        }
        PivotAxis::Column => {
            let field = pivot_engine::PivotField::new(request.field_index, field_name);
            let position = request.position.unwrap_or(definition.column_fields.len());
            if position <= definition.column_fields.len() {
                definition.column_fields.insert(position, field);
            } else {
                definition.column_fields.push(field);
            }
        }
        PivotAxis::Data => {
            let field = pivot_engine::ValueField::new(
                request.field_index,
                field_name,
                pivot_engine::AggregationType::Sum,
            );
            let position = request.position.unwrap_or(definition.value_fields.len());
            if position <= definition.value_fields.len() {
                definition.value_fields.insert(position, field);
            } else {
                definition.value_fields.push(field);
            }
        }
        PivotAxis::Filter => {
            let field = pivot_engine::PivotField::new(request.field_index, field_name);
            let filter = pivot_engine::PivotFilter {
                field,
                condition: pivot_engine::FilterCondition::ValueList(Vec::new()),
            };
            let position = request.position.unwrap_or(definition.filter_fields.len());
            if position <= definition.filter_fields.len() {
                definition.filter_fields.insert(position, filter);
            } else {
                definition.filter_fields.push(filter);
            }
        }
        PivotAxis::Unknown => {
            // Just remove from all hierarchies, don't add anywhere
        }
    }

    definition.bump_version();

    let view = safe_calculate_pivot(definition, cache);
    store_view(&pivot_state, request.pivot_id, &view);
    let mut response = view_to_response(&view, definition, cache);

    let destination = definition.destination;
    let pivot_id = definition.id;
    let dest_sheet_idx = resolve_dest_sheet_index(&state, definition);

    drop(pivot_tables);

    response.overwritten_cell_count = count_overwritten_cells(&state, pivot_id, dest_sheet_idx, destination, &view);
    finalize_pivot_update(&state, &pivot_state, pivot_id, dest_sheet_idx, destination, &view, Some((&*pane_control_state, &*ribbon_filter_state)));

    Ok(response)
}

/// Sets the aggregation function for a value field.
#[tauri::command]
pub fn set_pivot_aggregation(
    state: State<AppState>,
    pivot_state: State<'_, PivotState>,
    pane_control_state: State<'_, crate::pane_control::PaneControlState>,
    ribbon_filter_state: State<'_, crate::ribbon_filter::RibbonFilterState>,
    request: SetAggregationRequest,
) -> Result<PivotViewResponse, String> {
    log_info!(
        "PIVOT",
        "set_pivot_aggregation pivot_id={} field={} func={:?}",
        request.pivot_id,
        request.value_field_index,
        request.summarize_by
    );

    let mut pivot_tables = pivot_state.pivot_tables.lock().unwrap();
    let (definition, cache) = pivot_tables
        .get_mut(&request.pivot_id)
        .ok_or_else(|| format!("Pivot table {} not found", request.pivot_id))?;

    if request.value_field_index >= definition.value_fields.len() {
        return Err(format!(
            "Value field index {} out of range (max {})",
            request.value_field_index,
            definition.value_fields.len().saturating_sub(1)
        ));
    }

    definition.value_fields[request.value_field_index].aggregation =
        api_to_aggregation_type(request.summarize_by);

    definition.bump_version();

    let view = safe_calculate_pivot(definition, cache);
    store_view(&pivot_state, request.pivot_id, &view);
    let mut response = view_to_response(&view, definition, cache);

    let destination = definition.destination;
    let pivot_id = definition.id;
    let dest_sheet_idx = resolve_dest_sheet_index(&state, definition);

    drop(pivot_tables);

    response.overwritten_cell_count = count_overwritten_cells(&state, pivot_id, dest_sheet_idx, destination, &view);
    finalize_pivot_update(&state, &pivot_state, pivot_id, dest_sheet_idx, destination, &view, Some((&*pane_control_state, &*ribbon_filter_state)));

    Ok(response)
}

/// Sets the number format for a value field.
#[tauri::command]
pub fn set_pivot_number_format(
    state: State<AppState>,
    pivot_state: State<'_, PivotState>,
    pane_control_state: State<'_, crate::pane_control::PaneControlState>,
    ribbon_filter_state: State<'_, crate::ribbon_filter::RibbonFilterState>,
    request: SetNumberFormatRequest,
) -> Result<PivotViewResponse, String> {
    log_info!(
        "PIVOT",
        "set_pivot_number_format pivot_id={} field={} format={}",
        request.pivot_id,
        request.value_field_index,
        request.number_format
    );

    let mut pivot_tables = pivot_state.pivot_tables.lock().unwrap();
    let (definition, cache) = pivot_tables
        .get_mut(&request.pivot_id)
        .ok_or_else(|| format!("Pivot table {} not found", request.pivot_id))?;

    if request.value_field_index >= definition.value_fields.len() {
        return Err(format!(
            "Value field index {} out of range",
            request.value_field_index
        ));
    }

    definition.value_fields[request.value_field_index].number_format =
        Some(request.number_format);

    definition.bump_version();

    let view = safe_calculate_pivot(definition, cache);
    store_view(&pivot_state, request.pivot_id, &view);
    let mut response = view_to_response(&view, definition, cache);

    let destination = definition.destination;
    let pivot_id = definition.id;
    let dest_sheet_idx = resolve_dest_sheet_index(&state, definition);

    drop(pivot_tables);

    response.overwritten_cell_count = count_overwritten_cells(&state, pivot_id, dest_sheet_idx, destination, &view);
    finalize_pivot_update(&state, &pivot_state, pivot_id, dest_sheet_idx, destination, &view, Some((&*pane_control_state, &*ribbon_filter_state)));

    Ok(response)
}

/// Applies a filter to a pivot field.
#[tauri::command]
pub fn apply_pivot_filter(
    state: State<AppState>,
    pivot_state: State<'_, PivotState>,
    pane_control_state: State<'_, crate::pane_control::PaneControlState>,
    ribbon_filter_state: State<'_, crate::ribbon_filter::RibbonFilterState>,
    request: ApplyPivotFilterRequest,
) -> Result<PivotViewResponse, String> {
    log_info!(
        "PIVOT",
        "apply_pivot_filter pivot_id={} field={}",
        request.pivot_id,
        request.field_index
    );

    let mut pivot_tables = pivot_state.pivot_tables.lock().unwrap();
    let (definition, cache) = pivot_tables
        .get_mut(&request.pivot_id)
        .ok_or_else(|| format!("Pivot table {} not found", request.pivot_id))?;

    // Find the field in row, column, or filter fields and update hidden_items
    let mut found = false;

    // Apply manual filter as hidden items
    if let Some(ref manual) = request.filters.manual_filter {
        // Get all unique values for this field
        let all_values: Vec<String> = if let Some(field_cache) = cache.fields.get_mut(request.field_index) {
            let sorted_ids = field_cache.sorted_ids().to_vec();
            sorted_ids.iter()
                .filter_map(|&id| {
                    if id == VALUE_ID_EMPTY {
                        return None;
                    }
                    field_cache.get_value(id).map(cache_value_to_string)
                })
                .collect()
        } else {
            Vec::new()
        };

        // Hidden items = all items - selected items
        let hidden_items: Vec<String> = all_values.iter()
            .filter(|v| !manual.selected_items.contains(v))
            .cloned()
            .collect();

        // Update row fields
        for field in &mut definition.row_fields {
            if field.source_index == request.field_index {
                field.hidden_items = hidden_items.clone();
                found = true;
            }
        }

        // Update column fields
        for field in &mut definition.column_fields {
            if field.source_index == request.field_index {
                field.hidden_items = hidden_items.clone();
                found = true;
            }
        }

        // Update filter fields
        for filter in &mut definition.filter_fields {
            if filter.field.source_index == request.field_index {
                filter.field.hidden_items = hidden_items.clone();
                found = true;
            }
        }

        if !found {
            // Field not in any zone — add as slicer filter (external, no UI).
            // This filters data without adding a visible filter dropdown row.
            log_debug!("PIVOT", "Field {} not in any zone, adding as slicer filter", request.field_index);

            // Check if a slicer filter for this field already exists
            if let Some(sf) = definition.slicer_filters.iter_mut()
                .find(|sf| sf.source_index == request.field_index)
            {
                sf.hidden_items = hidden_items;
            } else {
                definition.slicer_filters.push(pivot_engine::SlicerFilter {
                    source_index: request.field_index,
                    hidden_items,
                });
            }
        }
    }

    definition.bump_version();

    let view = safe_calculate_pivot(definition, cache);
    store_view(&pivot_state, request.pivot_id, &view);
    let mut response = view_to_response(&view, definition, cache);

    let destination = definition.destination;
    let pivot_id = definition.id;
    let dest_sheet_idx = resolve_dest_sheet_index(&state, definition);

    drop(pivot_tables);

    response.overwritten_cell_count = count_overwritten_cells(&state, pivot_id, dest_sheet_idx, destination, &view);
    finalize_pivot_update(&state, &pivot_state, pivot_id, dest_sheet_idx, destination, &view, Some((&*pane_control_state, &*ribbon_filter_state)));

    Ok(response)
}

/// Clears filters from a pivot field.
#[tauri::command]
pub fn clear_pivot_filter(
    state: State<AppState>,
    pivot_state: State<'_, PivotState>,
    pane_control_state: State<'_, crate::pane_control::PaneControlState>,
    ribbon_filter_state: State<'_, crate::ribbon_filter::RibbonFilterState>,
    request: ClearPivotFilterRequest,
) -> Result<PivotViewResponse, String> {
    log_info!(
        "PIVOT",
        "clear_pivot_filter pivot_id={} field={}",
        request.pivot_id,
        request.field_index
    );

    let mut pivot_tables = pivot_state.pivot_tables.lock().unwrap();
    let (definition, cache) = pivot_tables
        .get_mut(&request.pivot_id)
        .ok_or_else(|| format!("Pivot table {} not found", request.pivot_id))?;

    // Clear hidden items from all matching fields
    for field in &mut definition.row_fields {
        if field.source_index == request.field_index {
            field.hidden_items.clear();
        }
    }
    for field in &mut definition.column_fields {
        if field.source_index == request.field_index {
            field.hidden_items.clear();
        }
    }
    for filter in &mut definition.filter_fields {
        if filter.field.source_index == request.field_index {
            filter.field.hidden_items.clear();
        }
    }
    // Also remove any slicer filters for this field
    definition.slicer_filters.retain(|sf| sf.source_index != request.field_index);

    definition.bump_version();

    let view = safe_calculate_pivot(definition, cache);
    store_view(&pivot_state, request.pivot_id, &view);
    let mut response = view_to_response(&view, definition, cache);

    let destination = definition.destination;
    let pivot_id = definition.id;
    let dest_sheet_idx = resolve_dest_sheet_index(&state, definition);

    drop(pivot_tables);

    response.overwritten_cell_count = count_overwritten_cells(&state, pivot_id, dest_sheet_idx, destination, &view);
    finalize_pivot_update(&state, &pivot_state, pivot_id, dest_sheet_idx, destination, &view, Some((&*pane_control_state, &*ribbon_filter_state)));

    Ok(response)
}

/// Sorts a pivot field by labels.
#[tauri::command]
pub fn sort_pivot_field(
    state: State<AppState>,
    pivot_state: State<'_, PivotState>,
    pane_control_state: State<'_, crate::pane_control::PaneControlState>,
    ribbon_filter_state: State<'_, crate::ribbon_filter::RibbonFilterState>,
    request: SortPivotFieldRequest,
) -> Result<PivotViewResponse, String> {
    log_info!(
        "PIVOT",
        "sort_pivot_field pivot_id={} field={} by={:?}",
        request.pivot_id,
        request.field_index,
        request.sort_by
    );

    let mut pivot_tables = pivot_state.pivot_tables.lock().unwrap();
    let (definition, cache) = pivot_tables
        .get_mut(&request.pivot_id)
        .ok_or_else(|| format!("Pivot table {} not found", request.pivot_id))?;

    let sort_order = match request.sort_by {
        SortBy::Ascending => pivot_engine::SortOrder::Ascending,
        SortBy::Descending => pivot_engine::SortOrder::Descending,
    };

    // Update sort order for matching fields
    for field in &mut definition.row_fields {
        if field.source_index == request.field_index {
            field.sort_order = sort_order;
        }
    }
    for field in &mut definition.column_fields {
        if field.source_index == request.field_index {
            field.sort_order = sort_order;
        }
    }

    definition.bump_version();

    let view = safe_calculate_pivot(definition, cache);
    store_view(&pivot_state, request.pivot_id, &view);
    let mut response = view_to_response(&view, definition, cache);

    let destination = definition.destination;
    let pivot_id = definition.id;
    let dest_sheet_idx = resolve_dest_sheet_index(&state, definition);

    drop(pivot_tables);

    response.overwritten_cell_count = count_overwritten_cells(&state, pivot_id, dest_sheet_idx, destination, &view);
    finalize_pivot_update(&state, &pivot_state, pivot_id, dest_sheet_idx, destination, &view, Some((&*pane_control_state, &*ribbon_filter_state)));

    Ok(response)
}

/// Gets pivot field info including items and filters.
#[tauri::command]
pub fn get_pivot_field_info(
    _state: State<AppState>,
    pivot_state: State<'_, PivotState>,
    pivot_id: PivotId,
    field_index: usize,
) -> Result<PivotFieldInfo, String> {
    log_debug!("PIVOT", "get_pivot_field_info pivot_id={} field={}", pivot_id, field_index);

    let mut pivot_tables = pivot_state.pivot_tables.lock().unwrap();
    let (definition, cache) = pivot_tables
        .get_mut(&pivot_id)
        .ok_or_else(|| format!("Pivot table {} not found", pivot_id))?;

    // Get field name from cache
    let field_name = cache.field_name(field_index)
        .unwrap_or_else(|| format!("Field{}", field_index + 1));

    // Get hidden items from definition (search row, column, AND filter fields)
    let hidden_items: Vec<String> = definition.row_fields.iter()
        .chain(definition.column_fields.iter())
        .chain(definition.filter_fields.iter().map(|f| &f.field))
        .find(|f| f.source_index == field_index)
        .map(|f| f.hidden_items.clone())
        .unwrap_or_default();

    let show_all_items = hidden_items.is_empty();
    let is_filtered = !hidden_items.is_empty();

    // Get unique values and build items
    let items: Vec<PivotItemInfo> = if let Some(field_cache) = cache.fields.get_mut(field_index) {
        let sorted_ids = field_cache.sorted_ids().to_vec();
        sorted_ids.iter()
            .filter_map(|&id| {
                if id == VALUE_ID_EMPTY {
                    return None;
                }
                field_cache.get_value(id).map(|value| {
                    let name = cache_value_to_string(value);
                    let visible = !hidden_items.contains(&name);
                    PivotItemInfo {
                        id,
                        name,
                        is_expanded: true, // Default to expanded
                        visible,
                    }
                })
            })
            .collect()
    } else {
        Vec::new()
    };

    // Build manual filter from hidden items
    let manual_filter = if !hidden_items.is_empty() {
        let selected: Vec<String> = items.iter()
            .filter(|i| i.visible)
            .map(|i| i.name.clone())
            .collect();
        Some(PivotManualFilter { selected_items: selected })
    } else {
        None
    };

    Ok(PivotFieldInfo {
        id: field_index,
        name: field_name,
        show_all_items,
        filters: PivotFilters {
            date_filter: None,
            label_filter: None,
            manual_filter,
            value_filter: None,
        },
        is_filtered,
        subtotals: Subtotals::default(),
        items,
    })
}

/// Sets a pivot item's visibility.
#[tauri::command]
pub fn set_pivot_item_visibility(
    state: State<AppState>,
    pivot_state: State<'_, PivotState>,
    pane_control_state: State<'_, crate::pane_control::PaneControlState>,
    ribbon_filter_state: State<'_, crate::ribbon_filter::RibbonFilterState>,
    request: SetItemVisibilityRequest,
) -> Result<PivotViewResponse, String> {
    log_info!(
        "PIVOT",
        "set_pivot_item_visibility pivot_id={} field={} item={} visible={}",
        request.pivot_id,
        request.field_index,
        request.item_name,
        request.visible
    );

    let mut pivot_tables = pivot_state.pivot_tables.lock().unwrap();
    let (definition, cache) = pivot_tables
        .get_mut(&request.pivot_id)
        .ok_or_else(|| format!("Pivot table {} not found", request.pivot_id))?;

    // Update hidden_items for matching fields
    for field in &mut definition.row_fields {
        if field.source_index == request.field_index {
            if request.visible {
                field.hidden_items.retain(|item| item != &request.item_name);
            } else if !field.hidden_items.contains(&request.item_name) {
                field.hidden_items.push(request.item_name.clone());
            }
        }
    }
    for field in &mut definition.column_fields {
        if field.source_index == request.field_index {
            if request.visible {
                field.hidden_items.retain(|item| item != &request.item_name);
            } else if !field.hidden_items.contains(&request.item_name) {
                field.hidden_items.push(request.item_name.clone());
            }
        }
    }
    for filter in &mut definition.filter_fields {
        if filter.field.source_index == request.field_index {
            if request.visible {
                filter.field.hidden_items.retain(|item| item != &request.item_name);
            } else if !filter.field.hidden_items.contains(&request.item_name) {
                filter.field.hidden_items.push(request.item_name.clone());
            }
        }
    }

    definition.bump_version();

    let view = safe_calculate_pivot(definition, cache);
    store_view(&pivot_state, request.pivot_id, &view);
    let mut response = view_to_response(&view, definition, cache);

    let destination = definition.destination;
    let pivot_id = definition.id;
    let dest_sheet_idx = resolve_dest_sheet_index(&state, definition);

    drop(pivot_tables);

    response.overwritten_cell_count = count_overwritten_cells(&state, pivot_id, dest_sheet_idx, destination, &view);
    finalize_pivot_update(&state, &pivot_state, pivot_id, dest_sheet_idx, destination, &view, Some((&*pane_control_state, &*ribbon_filter_state)));

    Ok(response)
}

/// Gets a list of all pivot tables in the workbook.
#[tauri::command]
pub fn get_all_pivot_tables(
    _state: State<AppState>,
    pivot_state: State<'_, PivotState>,
) -> Vec<PivotTableInfo> {
    log_debug!("PIVOT", "get_all_pivot_tables");

    let pivot_tables = pivot_state.pivot_tables.lock().unwrap();

    pivot_tables.iter()
        .map(|(id, (definition, _))| {
            let source_range = definition.source_range_display.clone()
                .unwrap_or_else(|| format_range(definition.source_start, definition.source_end));
            let destination = format_cell(definition.destination);
            PivotTableInfo {
                id: *id,
                name: definition.name.clone().unwrap_or_else(|| format!("PivotTable{}", id)),
                source_range,
                destination,
                allow_multiple_filters_per_field: definition.allow_multiple_filters_per_field,
                enable_data_value_editing: definition.enable_data_value_editing,
                refresh_on_open: definition.refresh_on_open,
                use_custom_sort_lists: definition.use_custom_sort_lists,
                has_headers: definition.source_has_headers,
                source_table_name: definition.source_table_name.clone(),
            }
        })
        .collect()
}

/// Get BI metadata for a pivot table (connection ID, sheet index).
/// Returns null if the pivot is not BI-backed.
#[tauri::command]
pub fn get_pivot_bi_metadata(
    state: State<AppState>,
    pivot_state: State<'_, PivotState>,
    pivot_id: PivotId,
) -> Option<serde_json::Value> {
    // Lock order: pivot_tables before bi_metadata (canonical — see
    // bi_pivots_for_connection).
    let pivot_tables = pivot_state.pivot_tables.lock().unwrap();
    let bi_meta = pivot_state.bi_metadata.lock().unwrap();

    if let Some(meta) = bi_meta.get(&pivot_id) {
        // Get the sheet index from the pivot definition
        let sheet_index = pivot_tables
            .get(&pivot_id)
            .map(|(def, _)| resolve_dest_sheet_index(&state, def))
            .unwrap_or(0);

        Some(serde_json::json!({
            "connectionId": meta.connection_id,
            "sheetIndex": sheet_index,
            // Model tables/columns + measures so callers (e.g. the drill-through
            // behavior dialog) can offer a column/attribute picker.
            "tables": meta.model_tables,
            "measures": meta.measures,
        }))
    } else {
        None
    }
}

/// List the BI-backed pivots that belong to a given model connection.
/// Matches on the live connection id, falling back to the stable package
/// data-source id (which equals the connection UUID for locally created
/// connections) so targets resolve right after load, before the runtime
/// connection_id is re-bound.
pub(crate) fn bi_pivots_for_connection(
    state: &AppState,
    pivot_state: &PivotState,
    connection_id: identity::EntityId,
) -> Vec<super::types::BiConnectionPivot> {
    // Lock order: pivot_tables BEFORE bi_metadata — the order every site that
    // holds both uses (refresh_pivot_cache, collect_pivot_definitions); the
    // reverse order would be an ABBA deadlock.
    let pivot_tables = pivot_state.pivot_tables.lock().unwrap();
    let bi_meta = pivot_state.bi_metadata.lock().unwrap();
    let connection_key = connection_id.to_string();

    bi_meta
        .iter()
        .filter(|(_, meta)| {
            meta.connection_id == connection_id
                || meta.data_source_id.as_deref() == Some(connection_key.as_str())
        })
        .filter_map(|(pivot_id, _)| {
            pivot_tables.get(pivot_id).map(|(def, _)| super::types::BiConnectionPivot {
                id: *pivot_id,
                name: def.name.clone().unwrap_or_else(|| format!("PivotTable{}", pivot_id)),
                sheet_index: resolve_dest_sheet_index(state, def),
            })
        })
        .collect()
}

#[tauri::command]
pub fn get_pivots_for_bi_connection(
    state: State<AppState>,
    pivot_state: State<'_, PivotState>,
    connection_id: identity::EntityId,
) -> Vec<super::types::BiConnectionPivot> {
    bi_pivots_for_connection(&state, &pivot_state, connection_id)
}

/// Sets the expand/collapse state of a specific pivot item.
#[tauri::command]
pub fn set_pivot_item_expanded(
    state: State<AppState>,
    pivot_state: State<'_, PivotState>,
    pane_control_state: State<'_, crate::pane_control::PaneControlState>,
    ribbon_filter_state: State<'_, crate::ribbon_filter::RibbonFilterState>,
    request: SetItemExpandedRequest,
) -> Result<PivotViewResponse, String> {
    log_info!(
        "PIVOT",
        "set_pivot_item_expanded pivot_id={} field_idx={} item='{}' expanded={}",
        request.pivot_id,
        request.field_index,
        request.item_name,
        request.is_expanded
    );

    let mut pivot_tables = pivot_state.pivot_tables.lock().unwrap();
    let (definition, cache) = pivot_tables
        .get_mut(&request.pivot_id)
        .ok_or_else(|| format!("Pivot table {} not found", request.pivot_id))?;

    // Search in both row_fields and column_fields for the matching field_index
    let mut found = false;
    for field in definition.row_fields.iter_mut().chain(definition.column_fields.iter_mut()) {
        if field.source_index == request.field_index {
            if request.is_expanded {
                field.collapsed_items.retain(|s| s != &request.item_name);
            } else if !field.collapsed_items.contains(&request.item_name) {
                field.collapsed_items.push(request.item_name.clone());
            }
            // Clear field-level collapse when setting per-item state
            field.collapsed = false;
            found = true;
            break;
        }
    }

    if !found {
        return Err(format!(
            "Field with source_index {} not found in row or column fields",
            request.field_index
        ));
    }

    definition.bump_version();

    let view = safe_calculate_pivot(definition, cache);
    store_view(&pivot_state, request.pivot_id, &view);
    let mut response = view_to_response(&view, definition, cache);

    let destination = definition.destination;
    let pivot_id = definition.id;
    let dest_sheet_idx = resolve_dest_sheet_index(&state, definition);

    drop(pivot_tables);

    response.overwritten_cell_count = count_overwritten_cells(&state, pivot_id, dest_sheet_idx, destination, &view);
    finalize_pivot_update(&state, &pivot_state, pivot_id, dest_sheet_idx, destination, &view, Some((&*pane_control_state, &*ribbon_filter_state)));

    Ok(response)
}

/// Expands or collapses all items at a specific field level.
#[tauri::command]
pub fn expand_collapse_level(
    state: State<AppState>,
    pivot_state: State<'_, PivotState>,
    pane_control_state: State<'_, crate::pane_control::PaneControlState>,
    ribbon_filter_state: State<'_, crate::ribbon_filter::RibbonFilterState>,
    request: ExpandCollapseLevelRequest,
) -> Result<PivotViewResponse, String> {
    log_info!(
        "PIVOT",
        "expand_collapse_level pivot_id={} is_row={} field_idx={} expand={}",
        request.pivot_id,
        request.is_row,
        request.field_index,
        request.expand
    );

    let mut pivot_tables = pivot_state.pivot_tables.lock().unwrap();
    let (definition, cache) = pivot_tables
        .get_mut(&request.pivot_id)
        .ok_or_else(|| format!("Pivot table {} not found", request.pivot_id))?;

    let fields = if request.is_row {
        &mut definition.row_fields
    } else {
        &mut definition.column_fields
    };

    // Match by source_index (the value from groupPath), not positional index
    let field = fields
        .iter_mut()
        .find(|f| f.source_index == request.field_index)
        .ok_or_else(|| {
            format!(
                "Field with source_index {} not found in {} fields",
                request.field_index,
                if request.is_row { "row" } else { "column" }
            )
        })?;
    field.collapsed = !request.expand;
    field.collapsed_items.clear();

    definition.bump_version();

    let view = safe_calculate_pivot(definition, cache);
    store_view(&pivot_state, request.pivot_id, &view);
    let mut response = view_to_response(&view, definition, cache);

    let destination = definition.destination;
    let pivot_id = definition.id;
    let dest_sheet_idx = resolve_dest_sheet_index(&state, definition);

    drop(pivot_tables);

    response.overwritten_cell_count = count_overwritten_cells(&state, pivot_id, dest_sheet_idx, destination, &view);
    finalize_pivot_update(&state, &pivot_state, pivot_id, dest_sheet_idx, destination, &view, Some((&*pane_control_state, &*ribbon_filter_state)));

    Ok(response)
}

/// Expands or collapses ALL fields in the entire pivot table.
#[tauri::command]
pub fn expand_collapse_all(
    state: State<AppState>,
    pivot_state: State<'_, PivotState>,
    pane_control_state: State<'_, crate::pane_control::PaneControlState>,
    ribbon_filter_state: State<'_, crate::ribbon_filter::RibbonFilterState>,
    request: ExpandCollapseAllRequest,
) -> Result<PivotViewResponse, String> {
    log_info!(
        "PIVOT",
        "expand_collapse_all pivot_id={} expand={}",
        request.pivot_id,
        request.expand
    );

    let mut pivot_tables = pivot_state.pivot_tables.lock().unwrap();
    let (definition, cache) = pivot_tables
        .get_mut(&request.pivot_id)
        .ok_or_else(|| format!("Pivot table {} not found", request.pivot_id))?;

    for field in definition.row_fields.iter_mut().chain(definition.column_fields.iter_mut()) {
        field.collapsed = !request.expand;
        field.collapsed_items.clear();
    }

    definition.bump_version();

    let view = safe_calculate_pivot(definition, cache);
    store_view(&pivot_state, request.pivot_id, &view);
    let mut response = view_to_response(&view, definition, cache);

    let destination = definition.destination;
    let pivot_id = definition.id;
    let dest_sheet_idx = resolve_dest_sheet_index(&state, definition);

    drop(pivot_tables);

    response.overwritten_cell_count = count_overwritten_cells(&state, pivot_id, dest_sheet_idx, destination, &view);
    finalize_pivot_update(&state, &pivot_state, pivot_id, dest_sheet_idx, destination, &view, Some((&*pane_control_state, &*ribbon_filter_state)));

    Ok(response)
}

/// Refreshes all pivot tables in the workbook.
#[tauri::command]
pub async fn refresh_all_pivot_tables(
    window: tauri::Window,
    state: State<'_, AppState>,
    pivot_state: State<'_, PivotState>,
    pane_control_state: State<'_, crate::pane_control::PaneControlState>,
    ribbon_filter_state: State<'_, crate::ribbon_filter::RibbonFilterState>,
    bi_state: State<'_, crate::bi::types::BiState>,
) -> Result<Vec<PivotViewResponse>, String> {
    log_info!("PIVOT", "refresh_all_pivot_tables");

    let pivot_ids: Vec<PivotId> = {
        let pivot_tables = pivot_state.pivot_tables.lock().unwrap();
        pivot_tables.keys().cloned().collect()
    };

    let mut responses = Vec::new();
    for pivot_id in pivot_ids {
        match refresh_pivot_cache(window.clone(), state.clone(), pivot_state.clone(), pane_control_state.clone(), ribbon_filter_state.clone(), bi_state.clone(), pivot_id).await {
            Ok(response) => responses.push(response),
            Err(e) => log_debug!("PIVOT", "Failed to refresh pivot {}: {}", pivot_id, e),
        }
    }

    Ok(responses)
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/// Formats a cell reference from (row, col) to A1 notation.
fn format_cell(pos: (u32, u32)) -> String {
    let (row, col) = pos;
    format!("{}{}", col_index_to_letter(col), row + 1)
}

/// Formats a range from ((start_row, start_col), (end_row, end_col)) to A1:B2 notation.
fn format_range(start: (u32, u32), end: (u32, u32)) -> String {
    format!("{}:{}", format_cell(start), format_cell(end))
}

/// Converts API AggregationFunction to engine AggregationType.
fn api_to_aggregation_type(func: AggregationFunction) -> pivot_engine::AggregationType {
    match func {
        AggregationFunction::Automatic => pivot_engine::AggregationType::Sum,
        AggregationFunction::Sum => pivot_engine::AggregationType::Sum,
        AggregationFunction::Count => pivot_engine::AggregationType::Count,
        AggregationFunction::Average => pivot_engine::AggregationType::Average,
        AggregationFunction::Max => pivot_engine::AggregationType::Max,
        AggregationFunction::Min => pivot_engine::AggregationType::Min,
        AggregationFunction::Product => pivot_engine::AggregationType::Product,
        AggregationFunction::CountNumbers => pivot_engine::AggregationType::CountNumbers,
        AggregationFunction::StandardDeviation => pivot_engine::AggregationType::StdDev,
        AggregationFunction::StandardDeviationP => pivot_engine::AggregationType::StdDevP,
        AggregationFunction::Variance => pivot_engine::AggregationType::Var,
        AggregationFunction::VarianceP => pivot_engine::AggregationType::VarP,
    }
}

/// Resolves base_field names to base_field_index on value fields.
/// Called after value fields are created from config, to fill in the index
/// that the engine needs for Difference/RunningTotal/Rank calculations.
fn resolve_base_field_indices(
    value_fields: &mut [pivot_engine::ValueField],
    configs: &[ValueFieldConfig],
    row_fields: &[pivot_engine::PivotField],
    col_fields: &[pivot_engine::PivotField],
) {
    for (vf, cfg) in value_fields.iter_mut().zip(configs.iter()) {
        let base_field_name = cfg.show_as.as_ref()
            .and_then(|rule| rule.base_field.as_ref());

        if let Some(name) = base_field_name {
            // Search row fields, then column fields
            let found = row_fields.iter().chain(col_fields.iter())
                .find(|f| &f.name == name)
                .map(|f| f.source_index);
            vf.base_field_index = found;
        }
    }
}

/// Converts engine AggregationType to API AggregationFunction.
fn aggregation_type_to_api(agg: pivot_engine::AggregationType) -> AggregationFunction {
    match agg {
        pivot_engine::AggregationType::Sum => AggregationFunction::Sum,
        pivot_engine::AggregationType::Count => AggregationFunction::Count,
        pivot_engine::AggregationType::Average => AggregationFunction::Average,
        pivot_engine::AggregationType::Max => AggregationFunction::Max,
        pivot_engine::AggregationType::Min => AggregationFunction::Min,
        pivot_engine::AggregationType::Product => AggregationFunction::Product,
        pivot_engine::AggregationType::CountNumbers => AggregationFunction::CountNumbers,
        pivot_engine::AggregationType::StdDev => AggregationFunction::StandardDeviation,
        pivot_engine::AggregationType::StdDevP => AggregationFunction::StandardDeviationP,
        pivot_engine::AggregationType::Var => AggregationFunction::Variance,
        pivot_engine::AggregationType::VarP => AggregationFunction::VarianceP,
    }
}

/// Converts engine ShowValuesAs to API ShowAsRule.
fn show_values_as_to_api(vf: &pivot_engine::ValueField, fields: &[pivot_engine::PivotField]) -> Option<ShowAsRule> {
    let calculation = match vf.show_values_as {
        pivot_engine::ShowValuesAs::Normal => return None,
        pivot_engine::ShowValuesAs::PercentOfGrandTotal => ShowAsCalculation::PercentOfGrandTotal,
        pivot_engine::ShowValuesAs::PercentOfRowTotal => ShowAsCalculation::PercentOfRowTotal,
        pivot_engine::ShowValuesAs::PercentOfColumnTotal => ShowAsCalculation::PercentOfColumnTotal,
        pivot_engine::ShowValuesAs::PercentOfParentRow => ShowAsCalculation::PercentOfParentRowTotal,
        pivot_engine::ShowValuesAs::PercentOfParentColumn => ShowAsCalculation::PercentOfParentColumnTotal,
        pivot_engine::ShowValuesAs::Difference => ShowAsCalculation::DifferenceFrom,
        pivot_engine::ShowValuesAs::PercentDifference => ShowAsCalculation::PercentDifferenceFrom,
        pivot_engine::ShowValuesAs::RunningTotal => ShowAsCalculation::RunningTotal,
        pivot_engine::ShowValuesAs::PercentOfRunningTotal => ShowAsCalculation::PercentOfRunningTotal,
        pivot_engine::ShowValuesAs::RankAscending => ShowAsCalculation::RankAscending,
        pivot_engine::ShowValuesAs::RankDescending => ShowAsCalculation::RankDescending,
        pivot_engine::ShowValuesAs::Index => ShowAsCalculation::Index,
    };

    // Resolve base_field name from index
    let base_field = vf.base_field_index.and_then(|fi| {
        fields.iter().find(|f| f.source_index == fi).map(|f| f.name.clone())
    });

    Some(ShowAsRule {
        calculation,
        base_field,
        base_item: vf.base_item.clone(),
    })
}

// ============================================================================
// GROUPING COMMANDS
// ============================================================================

/// Applies grouping (date, number binning, or manual) to a pivot field.
#[tauri::command]
pub fn group_pivot_field(
    state: State<AppState>,
    pivot_state: State<'_, PivotState>,
    pane_control_state: State<'_, crate::pane_control::PaneControlState>,
    ribbon_filter_state: State<'_, crate::ribbon_filter::RibbonFilterState>,
    request: GroupFieldRequest,
) -> Result<PivotViewResponse, String> {
    log_info!(
        "PIVOT",
        "group_pivot_field pivot_id={} field_index={} grouping={:?}",
        request.pivot_id,
        request.field_index,
        request.grouping
    );

    let mut pivot_tables = pivot_state.pivot_tables.lock().unwrap();
    let (definition, cache) = pivot_tables
        .get_mut(&request.pivot_id)
        .ok_or_else(|| format!("Pivot table {} not found", request.pivot_id))?;

    // Find the field in row_fields or column_fields by source_index
    let field = definition
        .row_fields
        .iter_mut()
        .chain(definition.column_fields.iter_mut())
        .find(|f| f.source_index == request.field_index);

    let field = match field {
        Some(f) => f,
        None => return Err(format!("Field with source_index {} not found", request.field_index)),
    };

    // Apply the grouping configuration
    field.grouping = api_grouping_config_to_engine(&request.grouping);

    definition.bump_version();

    let view = safe_calculate_pivot(definition, cache);
    store_view(&pivot_state, request.pivot_id, &view);
    let mut response = view_to_response(&view, definition, cache);

    let destination = definition.destination;
    let pivot_id = definition.id;
    let dest_sheet_idx = resolve_dest_sheet_index(&state, definition);

    drop(pivot_tables);

    response.overwritten_cell_count = count_overwritten_cells(&state, pivot_id, dest_sheet_idx, destination, &view);
    finalize_pivot_update(&state, &pivot_state, pivot_id, dest_sheet_idx, destination, &view, Some((&*pane_control_state, &*ribbon_filter_state)));

    Ok(response)
}

/// Creates a manual group on a pivot field (adds items to a named group).
#[tauri::command]
pub fn create_manual_group(
    state: State<AppState>,
    pivot_state: State<'_, PivotState>,
    pane_control_state: State<'_, crate::pane_control::PaneControlState>,
    ribbon_filter_state: State<'_, crate::ribbon_filter::RibbonFilterState>,
    request: CreateManualGroupRequest,
) -> Result<PivotViewResponse, String> {
    log_info!(
        "PIVOT",
        "create_manual_group pivot_id={} field_index={} group_name={} members={:?}",
        request.pivot_id,
        request.field_index,
        request.group_name,
        request.member_items
    );

    let mut pivot_tables = pivot_state.pivot_tables.lock().unwrap();
    let (definition, cache) = pivot_tables
        .get_mut(&request.pivot_id)
        .ok_or_else(|| format!("Pivot table {} not found", request.pivot_id))?;

    // Find the field in row_fields or column_fields by source_index
    let field = definition
        .row_fields
        .iter_mut()
        .chain(definition.column_fields.iter_mut())
        .find(|f| f.source_index == request.field_index);

    let field = match field {
        Some(f) => f,
        None => return Err(format!("Field with source_index {} not found", request.field_index)),
    };

    // Initialize or extend manual grouping
    match &mut field.grouping {
        pivot_engine::FieldGrouping::ManualGrouping { groups, .. } => {
            // Add to existing manual grouping
            groups.push(pivot_engine::ManualGroup {
                name: request.group_name,
                members: request.member_items,
            });
        }
        _ => {
            // Create new manual grouping
            field.grouping = pivot_engine::FieldGrouping::ManualGrouping {
                groups: vec![pivot_engine::ManualGroup {
                    name: request.group_name,
                    members: request.member_items,
                }],
                ungrouped_name: "Other".to_string(),
            };
        }
    }

    definition.bump_version();

    let view = safe_calculate_pivot(definition, cache);
    store_view(&pivot_state, request.pivot_id, &view);
    let mut response = view_to_response(&view, definition, cache);

    let destination = definition.destination;
    let pivot_id = definition.id;
    let dest_sheet_idx = resolve_dest_sheet_index(&state, definition);

    drop(pivot_tables);

    response.overwritten_cell_count = count_overwritten_cells(&state, pivot_id, dest_sheet_idx, destination, &view);
    finalize_pivot_update(&state, &pivot_state, pivot_id, dest_sheet_idx, destination, &view, Some((&*pane_control_state, &*ribbon_filter_state)));

    Ok(response)
}

/// Removes all grouping from a pivot field.
#[tauri::command]
pub fn ungroup_pivot_field(
    state: State<AppState>,
    pivot_state: State<'_, PivotState>,
    pane_control_state: State<'_, crate::pane_control::PaneControlState>,
    ribbon_filter_state: State<'_, crate::ribbon_filter::RibbonFilterState>,
    request: UngroupFieldRequest,
) -> Result<PivotViewResponse, String> {
    log_info!(
        "PIVOT",
        "ungroup_pivot_field pivot_id={} field_index={}",
        request.pivot_id,
        request.field_index
    );

    let mut pivot_tables = pivot_state.pivot_tables.lock().unwrap();
    let (definition, cache) = pivot_tables
        .get_mut(&request.pivot_id)
        .ok_or_else(|| format!("Pivot table {} not found", request.pivot_id))?;

    // Find the field in row_fields or column_fields by source_index
    let field = definition
        .row_fields
        .iter_mut()
        .chain(definition.column_fields.iter_mut())
        .find(|f| f.source_index == request.field_index);

    let field = match field {
        Some(f) => f,
        None => return Err(format!("Field with source_index {} not found", request.field_index)),
    };

    // Reset grouping to None
    field.grouping = pivot_engine::FieldGrouping::None;

    definition.bump_version();

    let view = safe_calculate_pivot(definition, cache);
    store_view(&pivot_state, request.pivot_id, &view);
    let mut response = view_to_response(&view, definition, cache);

    let destination = definition.destination;
    let pivot_id = definition.id;
    let dest_sheet_idx = resolve_dest_sheet_index(&state, definition);

    drop(pivot_tables);

    response.overwritten_cell_count = count_overwritten_cells(&state, pivot_id, dest_sheet_idx, destination, &view);
    finalize_pivot_update(&state, &pivot_state, pivot_id, dest_sheet_idx, destination, &view, Some((&*pane_control_state, &*ribbon_filter_state)));

    Ok(response)
}

/// Map a drill-override filter operator string to a `bi_engine::FilterOperator`
/// (mirrors the BI query builder; unknown operators default to Equal).
fn drill_filter_op(op: &str) -> bi_engine::FilterOperator {
    match op {
        "!=" | "ne" => bi_engine::FilterOperator::NotEqual,
        ">" | "gt" => bi_engine::FilterOperator::GreaterThan,
        "<" | "lt" => bi_engine::FilterOperator::LessThan,
        ">=" | "gte" => bi_engine::FilterOperator::GreaterThanOrEqual,
        "<=" | "lte" => bi_engine::FilterOperator::LessThanOrEqual,
        _ => bi_engine::FilterOperator::Equal,
    }
}

/// Build an engine drillthrough request (`DetailRequest`) for a BI-backed pivot
/// cell, identified by its `group_path` of (cache field index, value id) pairs.
/// Each pair becomes an equality filter on that dimension column, so the engine
/// returns only the RLS-enforced raw fact rows behind the drilled cell. A
/// grand-total cell (empty `group_path`) yields no filters and drills the whole
/// fact table (capped by `limit`).
///
/// When `include_dimension_attrs` is set, the pivot's related-dimension fields
/// (group-by + lookup columns whose table is *not* the fact table, and which the
/// drilled cell does not already pin to a constant) are appended as
/// `dimension_columns` — readable labels (`Customer.name`, `Product.category`)
/// looked up beside each raw fact row. Returns the request plus the number of
/// attached attributes, so the caller can build a bare fallback: the engine
/// fails the whole request closed if any attribute's relationship is not
/// single-hop active equi, and degrading to raw fact rows beats erroring.
fn build_bi_detail_request(
    meta: &super::types::BiPivotMetadata,
    definition: &PivotDefinition,
    cache: &PivotCache,
    group_path: &[(usize, u32)],
    default_limit: usize,
    override_: Option<&super::types::DrillQueryOverride>,
    include_dimension_attrs: bool,
) -> Result<(bi_engine::DetailRequest, usize), String> {
    // The detail (fact) table is the home table of the pivot's measures. v1
    // drills the first measure's table; a pivot mixing measures from multiple
    // fact tables drills the first (documented limitation).
    let fact_table = meta
        .measures
        .first()
        .map(|m| m.table.clone())
        .ok_or_else(|| {
            "BI pivot has no measures; cannot determine a detail table to drill".to_string()
        })?;

    // Each group_path entry pins one dimension to the drilled cell's value.
    let mut filters: Vec<bi_engine::FilterCondition> = Vec::with_capacity(group_path.len());
    let mut pinned: std::collections::HashSet<(String, String)> = std::collections::HashSet::new();
    for &(field_index, value_id) in group_path {
        // Pivot field names are "Table.Column"; the engine resolves a filter by
        // the bare column name against the owning table (then propagates it to
        // the fact over a single hop), so pass the column part.
        let field_name = definition
            .row_fields
            .iter()
            .find(|f| f.source_index == field_index)
            .map(|f| f.name.clone())
            .or_else(|| {
                definition
                    .column_fields
                    .iter()
                    .find(|f| f.source_index == field_index)
                    .map(|f| f.name.clone())
            })
            .or_else(|| cache.field_name(field_index))
            .unwrap_or_default();
        let (dim_table, column) = match field_name.rsplit_once('.') {
            Some((t, c)) => (t.to_string(), c.to_string()),
            None => (String::new(), field_name.clone()),
        };
        pinned.insert((dim_table, column.clone()));
        let value = cache.get_value_label(field_index, value_id).unwrap_or_default();
        filters.push(bi_engine::FilterCondition::new(
            column,
            bi_engine::FilterOperator::Equal,
            value,
        ));
    }

    // Extra filters from a declarative override, ANDed with the cell filters.
    if let Some(ov) = override_ {
        for f in &ov.filters {
            filters.push(bi_engine::FilterCondition::new(
                f.column.clone(),
                drill_filter_op(&f.operator),
                f.value.clone(),
            ));
        }
    }

    // Append readable dimension attributes the pivot already uses, skipping the
    // fact's own columns (returned anyway via SELECT *) and any dimension the
    // drilled cell already pins to a single value (a constant column adds noise).
    let mut dimension_columns: Vec<bi_engine::ColumnRef> = Vec::new();
    if include_dimension_attrs {
        match override_ {
            // Declarative override: attach exactly the publisher-chosen attrs.
            Some(ov) => {
                for c in &ov.dimension_columns {
                    dimension_columns.push(bi_engine::ColumnRef::new(&c.table, &c.column));
                }
            }
            // Builtin: auto-derive from the pivot's own related-dimension fields.
            None => {
                if let Some(last) = &meta.last_query {
                    let mut seen: std::collections::HashSet<(String, String)> =
                        std::collections::HashSet::new();
                    for f in last.group_by.iter().chain(last.lookups.iter()) {
                        if f.table == fact_table {
                            continue;
                        }
                        let key = (f.table.clone(), f.column.clone());
                        if pinned.contains(&key) || !seen.insert(key) {
                            continue;
                        }
                        dimension_columns.push(bi_engine::ColumnRef::new(&f.table, &f.column));
                    }
                }
            }
        }
    }
    let n_dims = dimension_columns.len();

    let limit = override_.and_then(|o| o.limit).unwrap_or(default_limit);
    let mut request = bi_engine::DetailRequest::new(fact_table, limit)
        .with_filters(filters)
        .with_dimension_columns(dimension_columns);
    // Declarative override: detail columns + ordering.
    if let Some(ov) = override_ {
        if !ov.columns.is_empty() {
            request = request.with_columns(ov.columns.clone());
        }
        if !ov.order_by.is_empty() {
            let order: Vec<bi_engine::OrderByClause> = ov
                .order_by
                .iter()
                .map(|o| {
                    if o.descending {
                        bi_engine::OrderByClause::column_desc(&o.table, &o.column)
                    } else {
                        bi_engine::OrderByClause::column(&o.table, &o.column)
                    }
                })
                .collect();
            request = request.with_order_by(order);
        }
    }
    Ok((request, n_dims))
}

/// Convert one drillthrough cell (an `Option<String>` from `batches_to_result`)
/// into a grid `CellValue`: nulls become empty, numeric text becomes a number,
/// everything else stays text.
fn detail_value_to_cell(value: Option<String>) -> engine::CellValue {
    match value {
        None => engine::CellValue::Empty,
        Some(s) => match s.parse::<f64>() {
            Ok(n) => engine::CellValue::Number(n),
            Err(_) => engine::CellValue::Text(s),
        },
    }
}

/// Performs a drill-through: creates a new sheet with the detail rows behind a
/// pivot cell. A BI-backed pivot uses the engine's RLS-enforced `query_rows`
/// (secured server-side fact rows); a grid-backed pivot uses its original
/// source range.
#[tauri::command]
pub async fn drill_through_to_sheet(
    state: State<'_, AppState>,
    pivot_state: State<'_, PivotState>,
    bi_state: State<'_, crate::bi::types::BiState>,
    request: DrillThroughRequest,
) -> Result<DrillThroughResponse, String> {
    log_info!(
        "PIVOT",
        "drill_through_to_sheet pivot_id={} path_len={}",
        request.pivot_id,
        request.group_path.len()
    );

    let max = request.max_records.unwrap_or(10000);

    // Gather the detail rows. A BI-backed pivot builds an engine DetailRequest
    // here (while the pivot locks are held) and runs it after they drop; a
    // grid-backed pivot reads its source rows from the grid now.
    let mut headers: Vec<String> = Vec::new();
    let mut row_data: Vec<Vec<engine::CellValue>> = Vec::new();
    let bi_drill: Option<(
        crate::bi::types::ConnectionId,
        bi_engine::DetailRequest,
        Option<bi_engine::DetailRequest>,
        // (has_query_override, first measure name) — drives DETAILROWS below.
        bool,
        String,
    )> = {
        let bi_meta = pivot_state
            .bi_metadata
            .lock()
            .map_err(|e| format!("bi_metadata lock poisoned: {}", e))?;
        let pivot_tables = pivot_state
            .pivot_tables
            .lock()
            .map_err(|e| format!("pivot_tables lock poisoned: {}", e))?;
        let (definition, cache) = pivot_tables
            .get(&request.pivot_id)
            .ok_or_else(|| format!("Pivot table {} not found", request.pivot_id))?;

        if let Some(meta) = bi_meta.get(&request.pivot_id) {
            // A `Query`-mode behavior overrides the detail query declaratively;
            // builtin / None uses the default (auto dimension attributes).
            let override_ref = match &meta.drill_through {
                Some(b) if b.kind == super::types::DrillThroughKind::Query => b.query.as_ref(),
                _ => None,
            };
            let (detail, n_dims) = build_bi_detail_request(
                meta,
                definition,
                cache,
                &request.group_path,
                max,
                override_ref,
                true,
            )?;
            // Bare fallback (no dimension attributes) for the case where an
            // attribute's relationship is not single-hop and the engine rejects
            // the enriched request — the drill still returns raw fact rows.
            let fallback = if n_dims > 0 {
                Some(
                    build_bi_detail_request(
                        meta,
                        definition,
                        cache,
                        &request.group_path,
                        max,
                        override_ref,
                        false,
                    )?
                    .0,
                )
            } else {
                None
            };
            Some((
                meta.connection_id,
                detail,
                fallback,
                override_ref.is_some(),
                meta.measures.first().map(|m| m.name.clone()).unwrap_or_default(),
            ))
        } else {
            // Grid-backed pivot — read the matching source rows from the grid.
            let result = drill_down(definition, cache, &request.group_path, max);
            headers = cache.fields.iter().map(|f| f.name.clone()).collect();
            let col_count = headers.len();

            let grids = state
                .grids
                .lock()
                .map_err(|e| format!("grids lock poisoned: {}", e))?;
            let grid = grids
                .get(0)
                .ok_or_else(|| "Source sheet not found".to_string())?;

            let (start_row, start_col) = definition.source_start;
            let data_start = if definition.source_has_headers {
                start_row + 1
            } else {
                start_row
            };

            for &src_row in &result.source_rows {
                let grid_row = data_start + src_row;
                let mut row = Vec::with_capacity(col_count);
                for c in 0..col_count {
                    let col = start_col + c as u32;
                    let cv = grid
                        .get_cell(grid_row, col)
                        .map(|cell| cell.value.clone())
                        .unwrap_or(engine::CellValue::Empty);
                    row.push(cv);
                }
                row_data.push(row);
            }
            None
        }
    };

    // BI-backed pivot: run the secured drillthrough now the pivot locks are free.
    if let Some((connection_id, mut detail, mut fallback, has_query_override, first_measure)) =
        bi_drill
    {
        let engine_arc = {
            let connections = bi_state
                .connections
                .lock()
                .map_err(|e| format!("connections lock poisoned: {}", e))?;
            let conn = connections
                .get(&connection_id)
                .ok_or_else(|| format!("BI connection {} not found", connection_id))?;
            conn.engine.clone().ok_or("No BI model loaded.")?
        };
        let batches = {
            let mut engine = engine_arc.lock().await;
            // DETAILROWS: when the drilled measure defines its own drill
            // projection in the model, it replaces the auto-derived builtin
            // one (fact refs → detail columns, other-table refs → dimension
            // attributes). An explicit Query-mode override still wins.
            if !has_query_override {
                let detail_refs = engine
                    .model()
                    .measure(&first_measure)
                    .ok()
                    .and_then(|m| m.detail_rows().map(|r| r.to_vec()));
                if let Some(refs) = detail_refs {
                    let mut columns: Vec<String> = Vec::new();
                    let mut dims: Vec<bi_engine::ColumnRef> = Vec::new();
                    for r in &refs {
                        // Builder-validated shape: `Table[column]`.
                        let r = r.trim();
                        let Some(open) = r.find('[') else { continue };
                        let Some(body) = r.strip_suffix(']') else { continue };
                        let t = body[..open].trim();
                        let c = body[open + 1..].trim();
                        if t.eq_ignore_ascii_case(&detail.table) {
                            columns.push(c.to_string());
                        } else {
                            dims.push(bi_engine::ColumnRef::new(t, c));
                        }
                    }
                    let has_dims = !dims.is_empty();
                    detail.columns = columns.clone();
                    detail.dimension_columns = dims;
                    match fallback.as_mut() {
                        Some(bare) => bare.columns = columns,
                        // The builtin path had no dimension attributes, but the
                        // measure's projection adds some — give it the same
                        // bare fallback the auto-derived path gets.
                        None if has_dims => {
                            let mut bare = detail.clone();
                            bare.dimension_columns = Vec::new();
                            fallback = Some(bare);
                        }
                        None => {}
                    }
                }
            }
            // Apply this connection's RLS role (or clear a sibling's) so drilled
            // detail rows are restricted to what the active role permits.
            crate::bi::commands::apply_connection_role(&mut engine, &bi_state, connection_id);
            match engine.query_rows(detail).await {
                Ok(b) => b,
                Err(e) => match fallback {
                    // Retry without dimension attributes — the enriched request
                    // hit a non-single-hop relationship the engine rejects.
                    Some(bare) => {
                        log_info!(
                            "PIVOT",
                            "drillthrough with dimension attributes failed ({}); retrying without",
                            e
                        );
                        engine
                            .query_rows(bare)
                            .await
                            .map_err(|err| crate::bi::commands::friendly_bi_query_error("BI drillthrough failed", &err))?
                    }
                    None => return Err(crate::bi::commands::friendly_bi_query_error("BI drillthrough failed", &e)),
                },
            }
        };
        let result = crate::bi::commands::batches_to_result(&batches);
        headers = result.columns;
        row_data = result
            .rows
            .into_iter()
            .map(|r| r.into_iter().map(detail_value_to_cell).collect())
            .collect();
    }

    let data_row_count = row_data.len();
    let col_count = headers.len();

    // Create new sheet
    let mut sheet_names = state.sheet_names.lock().unwrap();
    let mut grids = state.grids.lock().unwrap();
    let mut active_sheet = state.active_sheet.lock().unwrap();
    let mut current_grid = state.grid.lock().unwrap();
    let mut freeze_configs = state.freeze_configs.lock().unwrap();

    // Generate a unique sheet name
    let base_name = "DrillThrough";
    let sheet_name = {
        let mut counter = 1;
        loop {
            let candidate = if counter == 1 {
                base_name.to_string()
            } else {
                format!("{}{}", base_name, counter)
            };
            if !sheet_names.contains(&candidate) {
                break candidate;
            }
            counter += 1;
        }
    };

    // Save current active grid
    let old_index = *active_sheet;
    if old_index < grids.len() {
        grids[old_index] = current_grid.clone();
    }

    // Create and populate the new grid
    let mut new_grid = engine::grid::Grid::new();

    // Write headers
    for (c, header) in headers.iter().enumerate() {
        new_grid.set_cell(0, c as u32, engine::Cell::new_text(header.clone()));
    }

    // Write data rows
    for (r, row) in row_data.iter().enumerate() {
        for (c, cv) in row.iter().enumerate() {
            new_grid.set_cell((r + 1) as u32, c as u32, engine::Cell { ast: None, value: cv.clone(), style_index: 0, rich_text: None });
        }
    }

    sheet_names.push(sheet_name.clone());
    grids.push(new_grid.clone());
    freeze_configs.push(FreezeConfig::default());

    let new_index = sheet_names.len() - 1;
    *active_sheet = new_index;
    *current_grid = new_grid;

    Ok(DrillThroughResponse {
        sheet_name,
        sheet_index: new_index,
        row_count: data_row_count,
        col_count,
    })
}

/// Set (or clear, with `None`) a BI pivot's drill-through behavior. Persists in
/// the pivot's BI metadata; saved with the workbook and carried into `.calp`.
#[tauri::command]
pub fn set_pivot_drill_behavior(
    pivot_state: State<'_, PivotState>,
    pivot_id: PivotId,
    behavior: Option<super::types::DrillThroughBehavior>,
) -> Result<(), String> {
    let mut bi_meta = pivot_state
        .bi_metadata
        .lock()
        .map_err(|e| format!("bi_metadata lock poisoned: {}", e))?;
    let meta = bi_meta
        .get_mut(&pivot_id)
        .ok_or_else(|| format!("Pivot {} is not a BI-backed pivot", pivot_id))?;
    meta.drill_through = behavior;
    Ok(())
}

/// Get a BI pivot's current drill-through behavior (`None` = default builtin).
#[tauri::command]
pub fn get_pivot_drill_behavior(
    pivot_state: State<'_, PivotState>,
    pivot_id: PivotId,
) -> Result<Option<super::types::DrillThroughBehavior>, String> {
    let bi_meta = pivot_state
        .bi_metadata
        .lock()
        .map_err(|e| format!("bi_metadata lock poisoned: {}", e))?;
    Ok(bi_meta.get(&pivot_id).and_then(|m| m.drill_through.clone()))
}

// ============================================================================
// BI PIVOT COMMANDS
// ============================================================================

/// Extracts model metadata (tables + measures) from a BI engine.
/// Expand a BI pivot's value fields by an applied calculation group's items.
///
/// With no items (`item_names` empty), this is one value field per base measure
/// (the ordinary case). With K items, it produces M base measures x K items in
/// **measures-outer / items-inner** order to match the engine's synthetic
/// column order (`M1[I1], M1[I2], M2[I1], ...`). Each field keeps the clean
/// `[Measure]` key as its `name` so it round-trips to the base measure, carries
/// the item in `calc_item` (so the editor/refresh can collapse it back), and
/// shows `Measure [Item]` as its `custom_name`. Indices are contiguous from
/// `measure_start`, matching the cache value block.
pub(crate) fn expand_bi_value_fields(
    value_fields: &[BiValueFieldRef],
    item_names: &[String],
    measure_start: usize,
    value_col_idx: &std::collections::HashMap<(String, Option<String>), usize>,
) -> Vec<pivot_engine::ValueField> {
    // Prefer the engine-reported column index for (measure, item); fall back to
    // the positional index when metadata is absent (e.g. an empty result set).
    let resolve = |measure: &str, item: Option<&str>, positional: usize| -> usize {
        value_col_idx
            .get(&(measure.to_string(), item.map(|s| s.to_string())))
            .copied()
            .unwrap_or(positional)
    };
    if item_names.is_empty() {
        return value_fields
            .iter()
            .enumerate()
            .map(|(i, v)| {
                let mut vf = ValueField::new(
                    resolve(&v.measure_name, None, measure_start + i),
                    format!("[{}]", v.measure_name),
                    AggregationType::Sum, // SUM of pre-aggregated = identity
                );
                vf.custom_name = v.custom_name.clone();
                vf
            })
            .collect();
    }
    let k = item_names.len();
    let mut vfs = Vec::with_capacity(value_fields.len() * k);
    for (m_idx, v) in value_fields.iter().enumerate() {
        for (i_idx, item) in item_names.iter().enumerate() {
            let mut vf = ValueField::new(
                resolve(&v.measure_name, Some(item), measure_start + m_idx * k + i_idx),
                format!("[{}]", v.measure_name),
                AggregationType::Sum,
            );
            vf.calc_item = Some(item.clone());
            vf.custom_name = Some(match &v.custom_name {
                Some(c) => format!("{} [{}]", c, item),
                None => format!("{} [{}]", v.measure_name, item),
            });
            vfs.push(vf);
        }
    }
    vfs
}

#[cfg(test)]
mod calc_group_expand_tests {
    use super::*;
    use std::collections::HashMap;

    #[test]
    fn resolve_field_indices_maps_names_and_errors_on_missing() {
        let available = vec![
            "Region".to_string(),
            "Revenue".to_string(),
            "Quarter".to_string(),
        ];
        // Names resolve to their 0-based positions, preserving order.
        assert_eq!(
            resolve_field_indices(&["Revenue".to_string(), "Region".to_string()], &available).unwrap(),
            vec![1, 0]
        );
        // A missing name errors and lists the available columns.
        let err = resolve_field_indices(&["Nope".to_string()], &available).unwrap_err();
        assert!(err.contains("Nope"));
        assert!(err.contains("Region"), "error lists available columns");
        // Empty input -> empty output.
        assert!(resolve_field_indices(&[], &available).unwrap().is_empty());
    }

    fn vf(name: &str) -> crate::pivot::types::BiValueFieldRef {
        crate::pivot::types::BiValueFieldRef {
            measure_name: name.to_string(),
            custom_name: None,
        }
    }

    /// Empty metadata map => expand falls back to positional indices.
    fn no_meta() -> HashMap<(String, Option<String>), usize> {
        HashMap::new()
    }

    #[test]
    fn no_calc_group_one_field_per_measure() {
        let fields = vec![vf("Revenue"), vf("Cost")];
        let out = expand_bi_value_fields(&fields, &[], 3, &no_meta());
        assert_eq!(out.len(), 2);
        assert_eq!(out[0].source_index, 3);
        assert_eq!(out[0].name, "[Revenue]");
        assert!(out[0].calc_item.is_none());
        assert_eq!(out[1].source_index, 4);
        assert_eq!(out[1].name, "[Cost]");
        assert!(out[1].calc_item.is_none());
    }

    #[test]
    fn calc_group_expands_measures_outer_items_inner() {
        let fields = vec![vf("Revenue"), vf("Cost")];
        let items = vec!["Current".to_string(), "YTD".to_string(), "PY".to_string()];
        let out = expand_bi_value_fields(&fields, &items, 2, &no_meta());
        // 2 measures x 3 items = 6 fields, contiguous from measure_start = 2.
        assert_eq!(out.len(), 6);
        let cols: Vec<usize> = out.iter().map(|f| f.source_index).collect();
        assert_eq!(cols, vec![2, 3, 4, 5, 6, 7]);
        // measures-outer / items-inner ordering.
        assert_eq!(out[0].name, "[Revenue]");
        assert_eq!(out[0].calc_item.as_deref(), Some("Current"));
        assert_eq!(out[0].custom_name.as_deref(), Some("Revenue [Current]"));
        assert_eq!(out[2].calc_item.as_deref(), Some("PY"));
        assert_eq!(out[3].name, "[Cost]");
        assert_eq!(out[3].calc_item.as_deref(), Some("Current"));
        assert_eq!(out[3].custom_name.as_deref(), Some("Cost [Current]"));
    }

    #[test]
    fn custom_base_name_combines_with_item_and_keeps_clean_key() {
        let mut f = vf("Revenue");
        f.custom_name = Some("Sales".to_string());
        let out = expand_bi_value_fields(&[f], &["YTD".to_string()], 0, &no_meta());
        assert_eq!(out[0].custom_name.as_deref(), Some("Sales [YTD]"));
        // name stays the clean base measure key so it round-trips to the measure.
        assert_eq!(out[0].name, "[Revenue]");
        assert_eq!(out[0].calc_item.as_deref(), Some("YTD"));
    }

    #[test]
    fn metadata_index_overrides_positional_order() {
        // Engine reports the (measure, item) columns in a DIFFERENT order than the
        // positional measures-outer/items-inner layout. The value fields must
        // follow the engine metadata, not the positional arithmetic.
        let fields = vec![vf("Revenue"), vf("Cost")];
        let items = vec!["Current".to_string(), "YTD".to_string()];
        // Shuffled column indices (measure_start would be 2 -> positional 2,3,4,5).
        let mut meta: HashMap<(String, Option<String>), usize> = HashMap::new();
        meta.insert(("Revenue".to_string(), Some("Current".to_string())), 7);
        meta.insert(("Revenue".to_string(), Some("YTD".to_string())), 5);
        meta.insert(("Cost".to_string(), Some("Current".to_string())), 4);
        meta.insert(("Cost".to_string(), Some("YTD".to_string())), 6);
        let out = expand_bi_value_fields(&fields, &items, 2, &meta);
        // Order of value FIELDS is unchanged (measures-outer/items-inner), but each
        // field's source_index comes from the metadata, not the positional guess.
        assert_eq!(out[0].calc_item.as_deref(), Some("Current"));
        assert_eq!(out[0].source_index, 7); // Revenue/Current
        assert_eq!(out[1].source_index, 5); // Revenue/YTD
        assert_eq!(out[2].source_index, 4); // Cost/Current
        assert_eq!(out[3].source_index, 6); // Cost/YTD
    }

    #[test]
    fn metadata_index_used_without_calc_group() {
        let fields = vec![vf("Revenue"), vf("Cost")];
        let mut meta: HashMap<(String, Option<String>), usize> = HashMap::new();
        meta.insert(("Revenue".to_string(), None), 9);
        meta.insert(("Cost".to_string(), None), 8);
        let out = expand_bi_value_fields(&fields, &[], 1, &meta);
        assert_eq!(out[0].source_index, 9);
        assert_eq!(out[1].source_index, 8);
    }
}

pub(crate) fn extract_bi_model_metadata(
    engine: &bi_engine::Engine,
) -> (
    Vec<BiModelTableMeta>,
    Vec<MeasureFieldInfo>,
    Vec<BiHierarchyMeta>,
    Vec<BiCalcGroupMeta>,
) {
    let model = engine.model();

    // Object-level security: when the engine's ACTIVE role denies tables or
    // columns, hide them from the field list. Presentation-side only — the
    // engine's own OLS query gate is the authoritative (fail-closed) control.
    let mut ols_denied_tables: Vec<String> = Vec::new();
    let mut ols_denied_cols: Vec<(String, String)> = Vec::new();
    for role_name in engine.active_roles() {
        let Ok(role) = model.security_role(role_name) else {
            continue;
        };
        ols_denied_tables.extend(role.denied_tables().iter().cloned());
        for r in role.denied_columns() {
            let r = r.trim();
            let Some(open) = r.find('[') else { continue };
            let Some(body) = r.strip_suffix(']') else { continue };
            ols_denied_cols.push((
                body[..open].trim().to_string(),
                body[open + 1..].trim().to_string(),
            ));
        }
    }
    let table_denied = |t: &str| {
        ols_denied_tables.iter().any(|d| d.eq_ignore_ascii_case(t))
    };
    let col_denied = |t: &str, c: &str| {
        table_denied(t)
            || ols_denied_cols
                .iter()
                .any(|(dt, dc)| dt.eq_ignore_ascii_case(t) && dc.eq_ignore_ascii_case(c))
    };

    let tables: Vec<BiModelTableMeta> = model
        .tables()
        .iter()
        .filter(|t| !table_denied(t.name()))
        .map(|t| {
            let is_numeric_dt = |dt: &bi_engine::DataType| {
                matches!(
                    dt,
                    bi_engine::DataType::Int32
                        | bi_engine::DataType::Int64
                        | bi_engine::DataType::Float64
                        | bi_engine::DataType::Decimal(_, _)
                )
            };
            let mut columns: Vec<BiModelColumnMeta> = t
                .columns()
                .iter()
                .filter(|c| !col_denied(t.name(), c.name()))
                .map(|c| {
                    let dt = c.data_type();
                    BiModelColumnMeta {
                        name: c.name().to_string(),
                        data_type: format!("{:?}", dt),
                        is_numeric: is_numeric_dt(dt),
                        lookup_resolution: c.lookup_resolution().map(|s| s.to_string()),
                        sort_by_column: c.sort_by_column().map(|s| s.to_string()),
                        is_context_column: false,
                        description: c.description().map(|s| s.to_string()),
                    }
                })
                .collect();
            // Context columns: Studio-authored dynamic-segmentation columns. They
            // are not physical columns but ARE groupable like ordinary dimensions
            // (the engine computes them when they appear in group_by), so surface
            // them in the field list alongside the table's columns.
            for cc in model.context_columns_for_table(t.name()) {
                if col_denied(t.name(), cc.name()) {
                    continue;
                }
                let dt = cc.data_type();
                columns.push(BiModelColumnMeta {
                    name: cc.name().to_string(),
                    data_type: format!("{:?}", dt),
                    is_numeric: is_numeric_dt(dt),
                    lookup_resolution: None,
                    sort_by_column: None,
                    is_context_column: true,
                    description: cc.description().map(|s| s.to_string()),
                });
            }
            BiModelTableMeta {
                name: t.name().to_string(),
                columns,
            }
        })
        .collect();

    let measures: Vec<MeasureFieldInfo> = model
        .measures()
        .iter()
        .filter(|m| !table_denied(m.table()))
        .map(|m| {
            let source_column = m.simple_column().unwrap_or("").to_string();
            let aggregation = m
                .simple_operation()
                .map(|op| format!("{:?}", op).to_lowercase())
                .unwrap_or_else(|| "expression".to_string());
            MeasureFieldInfo {
                name: m.name().to_string(),
                table: m.table().to_string(),
                source_column,
                aggregation,
            }
        })
        .collect();

    let hierarchies: Vec<BiHierarchyMeta> = model
        .hierarchies()
        .iter()
        .filter(|h| {
            !table_denied(h.table())
                && !h.levels().iter().any(|l| col_denied(h.table(), l.column()))
        })
        .map(|h| {
            let levels = h
                .levels()
                .iter()
                .map(|l| BiHierarchyLevelMeta {
                    column: l.column().to_string(),
                    display_name: l.display_name().map(|s| s.to_string()),
                    optional: l.is_optional(),
                })
                .collect();
            let ragged_behavior = match h.ragged_behavior() {
                bi_engine::RaggedBehavior::ShowBlanks => BiRaggedBehavior::ShowBlanks,
                bi_engine::RaggedBehavior::HideMembers => BiRaggedBehavior::HideMembers,
                bi_engine::RaggedBehavior::RepeatParent => BiRaggedBehavior::RepeatParent,
                bi_engine::RaggedBehavior::ShowAsLeaf => BiRaggedBehavior::ShowAsLeaf,
            };
            BiHierarchyMeta {
                name: h.name().to_string(),
                table: h.table().to_string(),
                levels,
                ragged_behavior,
            }
        })
        .collect();

    // Calculation groups: Studio-authored measure templates. Surfaced read-only
    // in the field list; applying one (multiplying the Values axis) is a later
    // slice. They are model-global (no per-table binding in the engine model).
    let calculation_groups: Vec<BiCalcGroupMeta> = model
        .calculation_groups()
        .iter()
        .map(|g| BiCalcGroupMeta {
            name: g.name().to_string(),
            items: g
                .items()
                .iter()
                .map(|i| BiCalcGroupItemMeta {
                    name: i.name().to_string(),
                    source: i.source().map(|s| s.to_string()),
                })
                .collect(),
        })
        .collect();

    (tables, measures, hierarchies, calculation_groups)
}

/// Creates an empty BI pivot from the full model (all tables + measures).
/// No data query is executed — the field list comes from model metadata.
#[tauri::command]
pub async fn create_pivot_from_bi_model(
    state: State<'_, AppState>,
    pivot_state: State<'_, PivotState>,
    bi_state: State<'_, BiState>,
    request: CreatePivotFromBiModelRequest,
) -> Result<PivotViewResponse, String> {
    let connection_id = request.connection_id;
    log_info!(
        "PIVOT",
        "create_pivot_from_bi_model dest={} dest_sheet={:?} conn_id={}",
        request.destination_cell,
        request.destination_sheet,
        connection_id
    );

    // Extract model metadata from the connection's engine (reads the in-memory
    // model; no DB connection required, so this works offline).
    let (model_tables, measures, hierarchies, calc_groups) = {
        let engine_arc = {
            let connections = bi_state.connections.lock().unwrap();
            let conn = connections.get(&connection_id)
                .ok_or_else(|| format!("Connection {} not found", connection_id))?;
            conn.engine.clone().ok_or("No BI model loaded.")?
        };
        let mut engine = engine_arc.lock().await;
        // Sync the connection's active RLS role onto the engine so the OLS
        // field-list filtering inside extract_bi_model_metadata sees it.
        crate::bi::commands::apply_connection_role(&mut engine, &bi_state, connection_id);
        let result = extract_bi_model_metadata(&engine);
        log_info!(
            "PIVOT",
            "extract_bi_model_metadata: {} tables, {} measures, {} hierarchies",
            result.0.len(),
            result.1.len(),
            result.2.len()
        );
        for t in &result.0 {
            log_info!("PIVOT", "  table: {} ({} columns)", t.name, t.columns.len());
        }
        for m in &result.1 {
            log_info!("PIVOT", "  measure: {} (table={})", m.name, m.table);
        }
        for h in &result.2 {
            log_info!("PIVOT", "  hierarchy: {} (table={}, {} levels)", h.name, h.table, h.levels.len());
        }
        result
    };

    // Connect + bind only when the model's tables aren't already cache-warm.
    // Offline (a restored connection with embedded cache) this is skipped so a
    // pivot can be created and queried without a live DB.
    let table_names: Vec<&str> = model_tables.iter().map(|t| t.name.as_str()).collect();
    if !bi_tables_cache_warm(&bi_state, connection_id, &table_names).await {
        auto_connect_bi_connection(&bi_state, connection_id).await?;
        auto_bind_tables_on_connection(&bi_state, connection_id, &table_names).await?;
    }

    log_info!(
        "PIVOT",
        "BI model: {} tables, {} measures",
        model_tables.len(),
        measures.len()
    );

    // Parse destination
    let destination = parse_cell_ref(&request.destination_cell)?;
    let dest_sheet_idx = request.destination_sheet.unwrap_or_else(|| {
        *state.active_sheet.lock().unwrap()
    });

    // Check that destination doesn't overlap an existing pivot table
    check_pivot_overlap(&state, dest_sheet_idx, destination)?;

    // Generate pivot ID
    let pivot_id = identity::EntityId::from_bytes(identity::generate_uuid_v7());

    // Create empty definition (no fields yet)
    let mut definition = PivotDefinition::new(pivot_id, (0, 0), (0, 0));
    definition.destination = destination;
    definition.name = request.name.or_else(|| Some(format!("PivotTable{}", pivot_id)));
    {
        let sheet_names = state.sheet_names.lock().unwrap();
        if dest_sheet_idx < sheet_names.len() {
            definition.destination_sheet = Some(sheet_names[dest_sheet_idx].clone());
        }
    }

    // Create empty cache (0 fields)
    let cache = PivotCache::new(pivot_id, 0);

    // Calculate initial view (will be empty)
    let mut cache_mut = cache;
    let view = safe_calculate_pivot(&definition, &mut cache_mut);
    store_view(&pivot_state, pivot_id, &view);
    let response = view_to_response(&view, &definition, &mut cache_mut);

    // Update pivot region tracking
    update_pivot_region(&state, pivot_id, dest_sheet_idx, destination, &view);

    // Write empty pivot placeholder to grid
    {
        let mut styles = state.style_registry.lock().unwrap();
        let mut grids = state.grids.lock().unwrap();
        if let Some(dest_grid) = grids.get_mut(dest_sheet_idx) {
            let active_sheet = *state.active_sheet.lock().unwrap();
            let pivot_merges = if dest_sheet_idx == active_sheet {
                let mut grid = state.grid.lock().unwrap();
                let merges = write_pivot_to_grid(dest_grid, Some(&mut grid), &view, destination, &mut styles);
                grid.recalculate_bounds();
                merges
            } else {
                write_pivot_to_grid(dest_grid, None, &view, destination, &mut styles)
            };

            // Update merge regions
            if !pivot_merges.is_empty() {
                let mut merged = state.merged_regions.lock().unwrap();
                // Clear merges in pivot region first
                let (dr, dc) = destination;
                let er = dr + view.row_count.max(1) as u32 - 1;
                let ec = dc + view.col_count.max(1) as u32 - 1;
                merged.retain(|m| {
                    !(m.start_row >= dr && m.end_row <= er && m.start_col >= dc && m.end_col <= ec)
                });
                for mr in pivot_merges {
                    merged.insert(mr);
                }
            }
        }
    }

    // Store pivot
    let mut pivot_tables = pivot_state.pivot_tables.lock().unwrap();
    pivot_tables.insert(pivot_id, (definition, cache_mut));
    drop(pivot_tables);

    // Set as active pivot
    *pivot_state.active_pivot_id.lock().unwrap() = Some(pivot_id);

    // Store BI metadata
    let bi_meta = BiPivotMetadata {
        connection_id,
        // On the authoring machine the live connection UUID is the package
        // data source id used at publish time.
        data_source_id: Some(connection_id.to_string()),
        model_tables,
        measures,
        hierarchies,
        calculation_groups: calc_groups,
        applied_calc_group: None,
        data_as_of: None,
        last_query: None,
        lookup_columns: std::collections::HashSet::new(),
        drill_through: None,
    };
    pivot_state
        .bi_metadata
        .lock()
        .unwrap()
        .insert(pivot_id, bi_meta);

    log_info!(
        "PIVOT",
        "created BI pivot_id={} conn_id={} (empty - awaiting field configuration)",
        pivot_id,
        connection_id
    );

    Ok(response)
}

/// Updates field assignments on a BI-backed pivot, re-querying the BI engine.
#[tauri::command]
pub async fn update_bi_pivot_fields(
    state: State<'_, AppState>,
    pivot_state: State<'_, PivotState>,
    pane_control_state: State<'_, crate::pane_control::PaneControlState>,
    ribbon_filter_state: State<'_, crate::ribbon_filter::RibbonFilterState>,
    bi_state: State<'_, BiState>,
    request: UpdateBiPivotFieldsRequest,
) -> Result<PivotViewResponse, String> {
    let t_total = Instant::now();
    log_info!("PIVOT", "update_bi_pivot_fields pivot_id={}", request.pivot_id);

    let pivot_id = request.pivot_id;

    // Verify pivot exists and is BI-backed
    {
        let bi_meta = pivot_state.bi_metadata.lock()
            .map_err(|e| format!("bi_metadata lock poisoned: {}", e))?;
        if !bi_meta.contains_key(&pivot_id) {
            return Err(format!("Pivot {} is not a BI-backed pivot", pivot_id));
        }
    }

    // Save previous state for revert-on-cancel
    {
        let pivot_tables = pivot_state.pivot_tables.lock()
            .map_err(|e| format!("pivot_tables lock poisoned: {}", e))?;
        if let Some((def, cache)) = pivot_tables.get(&pivot_id) {
            if let Ok(mut prev) = pivot_state.previous_states.lock() {
                prev.insert(pivot_id, (def.clone(), cache.clone()));
            }
        }
    }

    // Fast path: if only custom_name changed on value fields (no structural
    // changes to dimensions, measures, filters, layout, etc.), skip the
    // expensive BI query and just recalculate the view from the existing cache.
    {
        let mut pivot_tables = pivot_state.pivot_tables.lock()
            .map_err(|e| format!("pivot_tables lock poisoned: {}", e))?;
        if let Some((definition, stored_cache)) = pivot_tables.get_mut(&pivot_id) {
            let cosmetic_only = is_bi_cosmetic_only_change(definition, &request);
            if cosmetic_only {
                log_info!("PIVOT", "update_bi_pivot_fields: cosmetic-only change, skipping BI query");
                // Update custom names on existing value fields
                for (vf, req_vf) in definition.value_fields.iter_mut().zip(request.value_fields.iter()) {
                    vf.custom_name = req_vf.custom_name.clone();
                }
                // Apply layout if provided
                if let Some(ref layout_config) = request.layout {
                    apply_layout_config(&mut definition.layout, layout_config);
                }
                definition.bump_version();

                let view = safe_calculate_pivot(definition, stored_cache);
                store_view(&pivot_state, pivot_id, &view);
                let mut response = view_to_response(&view, definition, stored_cache);
                let destination = definition.destination;
                let auto_fit = definition.layout.auto_fit_column_widths;
                let dest_sheet_idx = resolve_dest_sheet_index(&state, definition);
                drop(pivot_tables);

                response.overwritten_cell_count = count_overwritten_cells(&state, pivot_id, dest_sheet_idx, destination, &view);
                update_pivot_in_grid(&state, pivot_id, dest_sheet_idx, destination, &view);
                if auto_fit {
                    auto_fit_pivot_columns(&state, destination, &view);
                }
                update_pivot_region(&state, pivot_id, dest_sheet_idx, destination, &view);
                recalculate_sheet_formulas(&state, &pivot_state, Some((&*pane_control_state, &*ribbon_filter_state)));

                let total_ms = t_total.elapsed().as_secs_f64() * 1000.0;
                log_perf!("PIVOT", "update_bi_pivot_fields (cosmetic) pivot_id={} | TOTAL={:.1}ms", pivot_id, total_ms);

                return Ok(response);
            }
        }
        drop(pivot_tables);
    }

    let has_values = !request.value_fields.is_empty();
    let has_dimensions = !request.row_fields.is_empty() || !request.column_fields.is_empty()
        || !request.row_hierarchies.is_empty() || !request.column_hierarchies.is_empty();
    let has_filters = !request.filter_fields.is_empty();
    let has_slicer_fields = !request.slicer_fields.is_empty();

    // If no fields at all, clear to empty pivot
    if !has_values && !has_dimensions && !has_filters && !has_slicer_fields {
        log_info!("PIVOT", "No fields assigned, clearing to empty pivot");
        let mut pivot_tables = pivot_state.pivot_tables.lock()
            .map_err(|e| format!("pivot_tables lock poisoned: {}", e))?;
        let (definition, _cache) = pivot_tables
            .get_mut(&pivot_id)
            .ok_or_else(|| format!("Pivot {} not found", pivot_id))?;

        definition.row_fields.clear();
        definition.column_fields.clear();
        definition.value_fields.clear();
        definition.filter_fields.clear();
        definition.calculated_fields.clear();
        definition.value_column_order.clear();
        definition.slicer_filters.clear();
        definition.bump_version();

        let empty_cache = PivotCache::new(pivot_id, 0);
        let view = create_empty_view(pivot_id, definition.version);
        let mut response = view_to_response(&view, definition, &mut empty_cache.clone());

        let destination = definition.destination;
        let dest_sheet_idx = resolve_dest_sheet_index(&state, definition);
        drop(pivot_tables);

        // Replace cache with empty
        let mut pt = pivot_state.pivot_tables.lock()
            .map_err(|e| format!("pivot_tables lock poisoned: {}", e))?;
        if let Some((_, cache)) = pt.get_mut(&pivot_id) {
            *cache = empty_cache;
        }
        drop(pt);

        response.overwritten_cell_count = count_overwritten_cells(&state, pivot_id, dest_sheet_idx, destination, &view);
        finalize_pivot_update(&state, &pivot_state, pivot_id, dest_sheet_idx, destination, &view, Some((&*pane_control_state, &*ribbon_filter_state)));
        return Ok(response);
    }

    // When there are dimensions/filters but no user-selected measures, inject a
    // synthetic measure so the BI engine query succeeds (it requires >= 1 measure).
    // The synthetic measure column will be present in the cache but NOT mapped to
    // any value_field in the pivot definition, so the engine renders blank data cells
    // — matching Excel's behaviour of showing distinct dimension values without aggregates.
    let synthetic_measure: Option<String> = if !has_values && (has_dimensions || has_filters || has_slicer_fields) {
        let bi_meta = pivot_state.bi_metadata.lock()
            .map_err(|e| format!("bi_metadata lock poisoned: {}", e))?;
        bi_meta.get(&pivot_id)
            .and_then(|m| m.measures.first())
            .map(|m| m.name.clone())
    } else {
        None
    };

    // If we need a synthetic measure but the model has none, we can't query the
    // BI engine. Save the field assignments to the definition (so they persist
    // across deselect/reselect) and show an empty pivot.
    if !has_values && synthetic_measure.is_none() && (has_dimensions || has_filters || has_slicer_fields) {
        log_info!("PIVOT", "No measures in model for synthetic query, saving fields only");
        let mut pivot_tables = pivot_state.pivot_tables.lock()
            .map_err(|e| format!("pivot_tables lock poisoned: {}", e))?;
        let (definition, stored_cache) = pivot_tables
            .get_mut(&pivot_id)
            .ok_or_else(|| format!("Pivot {} not found", pivot_id))?;

        // Save field assignments (even though we can't compute)
        definition.row_fields = request.row_fields.iter()
            .map(|f| PivotField::new(0, format!("{}.{}", f.table, f.column)))
            .collect();
        definition.column_fields = request.column_fields.iter()
            .map(|f| PivotField::new(0, format!("{}.{}", f.table, f.column)))
            .collect();
        definition.value_fields.clear();
        definition.calculated_fields.clear();
        definition.value_column_order.clear();
        definition.filter_fields = request.filter_fields.iter()
            .map(|f| {
                let field = PivotField::new(0, format!("{}.{}", f.table, f.column));
                pivot_engine::PivotFilter {
                    field,
                    condition: pivot_engine::FilterCondition::ValueList(Vec::new()),
                }
            })
            .collect();
        definition.bump_version();

        let empty_cache = PivotCache::new(pivot_id, 0);
        let view = create_empty_view(pivot_id, definition.version);
        let mut response = view_to_response(&view, definition, &mut empty_cache.clone());
        let destination = definition.destination;
        let dest_sheet_idx = resolve_dest_sheet_index(&state, definition);
        *stored_cache = empty_cache;
        drop(pivot_tables);

        response.overwritten_cell_count = count_overwritten_cells(&state, pivot_id, dest_sheet_idx, destination, &view);
        finalize_pivot_update(&state, &pivot_state, pivot_id, dest_sheet_idx, destination, &view, Some((&*pane_control_state, &*ribbon_filter_state)));
        return Ok(response);
    }

    // Get the connection_id from BI metadata
    let connection_id = {
        let bi_meta = pivot_state.bi_metadata.lock()
            .map_err(|e| format!("bi_metadata lock poisoned: {}", e))?;
        let meta = bi_meta.get(&pivot_id);
        log_info!("CALP-DIAG", "update_bi_pivot_fields: pivot_id={}, bi_metadata exists={}, connection_id={:?}",
            pivot_id, meta.is_some(), meta.map(|m| m.connection_id));
        meta.map(|m| m.connection_id)
            .ok_or_else(|| format!("No BI metadata for pivot {}", pivot_id))?
    };

    // Collect table names referenced in fields (for the cache-warmth check below
    // and for auto-binding when online).
    let mut referenced_tables: Vec<String> = Vec::new();
    for f in request.row_fields.iter()
        .chain(request.column_fields.iter())
        .chain(request.filter_fields.iter())
        .chain(request.slicer_fields.iter())
    {
        if !referenced_tables.contains(&f.table) {
            referenced_tables.push(f.table.clone());
        }
    }
    // Also include tables referenced by measures (e.g., fact_sales for SUM(fact_sales[linetotal]))
    {
        let bi_meta = pivot_state.bi_metadata.lock()
            .map_err(|e| format!("bi_metadata lock poisoned: {}", e))?;
        if let Some(meta) = bi_meta.get(&pivot_id) {
            for measure_name in request.value_fields.iter().map(|v| &v.measure_name) {
                if let Some(m) = meta.measures.iter().find(|m| m.name == *measure_name) {
                    if !m.table.is_empty() && !referenced_tables.contains(&m.table) {
                        referenced_tables.push(m.table.clone());
                    }
                }
            }
            // Also add ALL model tables — the BI engine may need any table for
            // relationships, calculated columns, or measure expressions
            for t in &meta.model_tables {
                if !referenced_tables.contains(&t.name) {
                    referenced_tables.push(t.name.clone());
                }
            }
        }
    }
    let table_refs: Vec<&str> = referenced_tables.iter().map(|s| s.as_str()).collect();

    // Offline fast path: if every referenced table is already warm in this
    // engine's cache, serve straight from cache and skip the connector — the
    // query path (engine.query_with_meta below) is cache-only. This makes a
    // restored pivot interactive offline (cross-machine, from embedded cache).
    // Only reach for the network when a table is genuinely cold.
    let all_warm = bi_tables_cache_warm(&bi_state, connection_id, &table_refs).await;
    if all_warm {
        log_info!("BI", "update_bi_pivot_fields: {} table(s) cache-warm — serving offline (no connect)", table_refs.len());
    } else {
        log_info!("CALP-DIAG", "update_bi_pivot_fields: calling auto_connect for connection_id={}", connection_id);
        auto_connect_bi_connection(&bi_state, connection_id).await?;
        auto_bind_tables_on_connection(&bi_state, connection_id, &table_refs).await?;
    }

    // Guardrail: a LOOKUP field must follow at least one GROUP field from the same table.
    // Check across all zones (row + column fields combined for GROUP coverage).
    let all_group_tables: std::collections::HashSet<&str> = request
        .row_fields
        .iter()
        .chain(request.column_fields.iter())
        .filter(|f| !f.is_lookup)
        .map(|f| f.table.as_str())
        .collect();

    for f in request.row_fields.iter().chain(request.column_fields.iter()) {
        if f.is_lookup && !all_group_tables.contains(f.table.as_str()) {
            return Err(format!(
                "LOOKUP field '{}.{}' requires at least one GROUP field from table '{}'",
                f.table, f.column, f.table
            ));
        }
    }

    // Separate GROUP fields from LOOKUP fields across all zones
    let row_group_fields: Vec<&BiFieldRef> = request.row_fields.iter().filter(|f| !f.is_lookup).collect();
    let row_lookup_fields: Vec<&BiFieldRef> = request.row_fields.iter().filter(|f| f.is_lookup).collect();
    let col_group_fields: Vec<&BiFieldRef> = request.column_fields.iter().filter(|f| !f.is_lookup).collect();
    let col_lookup_fields: Vec<&BiFieldRef> = request.column_fields.iter().filter(|f| f.is_lookup).collect();
    // Filter fields are always GROUP BY (not lookups) — they need cache columns
    // so the pivot engine can read their unique values and apply hidden_items.
    let filter_group_fields: Vec<&BiFieldRef> = request.filter_fields.iter().collect();
    // Slicer fields: included in GROUP BY so their values appear in the cache,
    // but mapped to slicer_filters instead of filter_fields (no visible filter row).
    let slicer_group_fields: Vec<&BiFieldRef> = request.slicer_fields.iter().collect();

    // Expand hierarchy fields into GROUP BY columns.
    // ALL levels are included in the query — the pivot engine's collapse mechanism
    // controls which levels are visible. This avoids re-querying on expand/collapse.
    let mut hierarchy_row_fields: Vec<BiFieldRef> = Vec::new();
    let mut hierarchy_col_fields: Vec<BiFieldRef> = Vec::new();

    // Track hierarchy metadata for setting up HierarchyConfig on the definition.
    // (name, table, field_count, ragged_behavior, is_row)
    struct HierarchyMeta {
        name: String,
        field_count: usize,
        ragged_behavior: BiRaggedBehavior,
        is_row: bool,
    }
    let mut hierarchy_metas: Vec<HierarchyMeta> = Vec::new();

    {
        let bi_meta = pivot_state.bi_metadata.lock()
            .map_err(|e| format!("bi_metadata lock poisoned: {}", e))?;
        let meta = bi_meta.get(&pivot_id);

        for href in &request.row_hierarchies {
            if let Some(meta) = meta {
                if let Some(h) = meta.hierarchies.iter().find(|h| h.name == href.hierarchy && h.table == href.table) {
                    hierarchy_metas.push(HierarchyMeta {
                        name: h.name.clone(),
                        field_count: h.levels.len(),
                        ragged_behavior: h.ragged_behavior.clone(),
                        is_row: true,
                    });
                    for level in &h.levels {
                        hierarchy_row_fields.push(BiFieldRef {
                            table: href.table.clone(),
                            column: level.column.clone(),
                            is_lookup: false,
                            hidden_items: Vec::new(),
                        });
                    }
                }
            }
        }

        for href in &request.column_hierarchies {
            if let Some(meta) = meta {
                if let Some(h) = meta.hierarchies.iter().find(|h| h.name == href.hierarchy && h.table == href.table) {
                    hierarchy_metas.push(HierarchyMeta {
                        name: h.name.clone(),
                        field_count: h.levels.len(),
                        ragged_behavior: h.ragged_behavior.clone(),
                        is_row: false,
                    });
                    for level in &h.levels {
                        hierarchy_col_fields.push(BiFieldRef {
                            table: href.table.clone(),
                            column: level.column.clone(),
                            is_lookup: false,
                            hidden_items: Vec::new(),
                        });
                    }
                }
            }
        }
    }
    let hierarchy_row_refs: Vec<&BiFieldRef> = hierarchy_row_fields.iter().collect();
    let hierarchy_col_refs: Vec<&BiFieldRef> = hierarchy_col_fields.iter().collect();

    // Collect hidden sort-by columns: for each GROUP BY field that has a
    // sort_by_column configured in the BI model, we need that sort column
    // in the cache. Add it as an extra GROUP BY column if not already present.
    // Since sort-by has a 1:1 mapping with the display column, this doesn't
    // change the number of groups.
    let mut sort_by_extra_fields: Vec<BiFieldRef> = Vec::new();
    {
        let bi_meta = pivot_state.bi_metadata.lock()
            .map_err(|e| format!("bi_metadata lock poisoned: {}", e))?;
        if let Some(meta) = bi_meta.get(&pivot_id) {
            // Collect all (table, column) pairs already in group_by
            let mut existing_group_by: std::collections::HashSet<(String, String)> =
                std::collections::HashSet::new();
            for f in row_group_fields.iter()
                .chain(hierarchy_row_refs.iter())
                .chain(col_group_fields.iter())
                .chain(hierarchy_col_refs.iter())
                .chain(filter_group_fields.iter())
                .chain(slicer_group_fields.iter())
            {
                existing_group_by.insert((f.table.clone(), f.column.clone()));
            }

            // For each group-by field, check if it has a sort_by_column
            let all_group_fields: Vec<&BiFieldRef> = row_group_fields.iter()
                .chain(hierarchy_row_refs.iter())
                .chain(col_group_fields.iter())
                .chain(hierarchy_col_refs.iter())
                .chain(filter_group_fields.iter())
                .chain(slicer_group_fields.iter())
                .copied()
                .collect();
            for f in &all_group_fields {
                if let Some(table_meta) = meta.model_tables.iter().find(|t| t.name == f.table) {
                    if let Some(col_meta) = table_meta.columns.iter().find(|c| c.name == f.column) {
                        if let Some(ref sort_col) = col_meta.sort_by_column {
                            let key = (f.table.clone(), sort_col.clone());
                            if !existing_group_by.contains(&key) {
                                existing_group_by.insert(key);
                                sort_by_extra_fields.push(BiFieldRef {
                                    table: f.table.clone(),
                                    column: sort_col.clone(),
                                    is_lookup: false,
                                    hidden_items: Vec::new(),
                                });
                            }
                        }
                    }
                }
            }
        }
    }

    // Build BI engine QueryRequest
    // If no user measures but we have a synthetic one, include it in the query
    // so the BI engine gets a valid request. The synthetic measure column will
    // be in the cache but ignored (no value_field maps to it).
    let query_measures: Vec<String> = if let Some(ref syn) = synthetic_measure {
        vec![syn.clone()]
    } else {
        request.value_fields.iter().map(|v| v.measure_name.clone()).collect()
    };
    let sort_by_extra_refs: Vec<&BiFieldRef> = sort_by_extra_fields.iter().collect();
    let query_group_by: Vec<bi_engine::ColumnRef> = row_group_fields
        .iter()
        .chain(hierarchy_row_refs.iter())
        .chain(col_group_fields.iter())
        .chain(hierarchy_col_refs.iter())
        .chain(filter_group_fields.iter())
        .chain(slicer_group_fields.iter())
        .chain(sort_by_extra_refs.iter())
        .map(|f| bi_engine::ColumnRef::new(&f.table, &f.column))
        .collect();

    // Build lookups from LOOKUP fields. For each lookup, try to auto-infer
    // the key column (the BI engine handles this when exactly one group_by
    // column is from the same table). If multiple group_by cols from same
    // table, the first one is used as explicit key.
    let query_lookups: Vec<bi_engine::LookupColumn> = row_lookup_fields
        .iter()
        .chain(col_lookup_fields.iter())
        .map(|f| {
            // Check how many group_by columns are from the same table
            let same_table_group_count = query_group_by
                .iter()
                .filter(|g| g.table == f.table)
                .count();
            if same_table_group_count == 1 {
                // Auto-infer key (exactly one group_by from same table)
                bi_engine::LookupColumn::new(&f.table, &f.column)
            } else {
                // Multiple group_by cols from same table — use first as explicit key
                let key = query_group_by
                    .iter()
                    .find(|g| g.table == f.table)
                    .map(|g| g.column.clone())
                    .unwrap_or_default();
                bi_engine::LookupColumn::with_key(&f.table, &f.column, &key)
            }
        })
        .collect();

    // ---- Calculation group resolution (Slice 2) ----
    // Resolve request.calculation_group into an engine application + the ordered
    // list of item names actually applied (empty selection = all items, in
    // declaration order). The item list drives the M*K value-field expansion and
    // the cache index math below. Skipped when there are no real value fields
    // (a synthetic dimensions-only pivot has no measure to multiply).
    let (calc_group_app, calc_item_names): (
        Option<bi_engine::CalculationGroupApplication>,
        Vec<String>,
    ) = match request.calculation_group.as_ref().filter(|_| synthetic_measure.is_none()) {
        Some(cg) => {
            // v1: calculation groups cannot combine with lookup columns (the
            // engine allows it but the combination is unvalidated; fail closed).
            if !query_lookups.is_empty() {
                return Err(
                    "Calculation groups can't be combined with lookup columns yet. \
                     Remove the lookup column(s) or the calculation group."
                        .to_string(),
                );
            }
            // Resolve the group's declared item list to validate the selection
            // and expand an empty selection to all items in declaration order.
            let all_items: Vec<String> = {
                let bi_meta = pivot_state.bi_metadata.lock()
                    .map_err(|e| format!("bi_metadata lock poisoned: {}", e))?;
                let meta = bi_meta.get(&pivot_id)
                    .ok_or_else(|| format!("No BI metadata for pivot {}", pivot_id))?;
                let group = meta.calculation_groups.iter()
                    .find(|g| g.name == cg.group)
                    .ok_or_else(|| format!(
                        "Calculation group '{}' not found in this model.", cg.group
                    ))?;
                group.items.iter().map(|i| i.name.clone()).collect()
            };
            let resolved: Vec<String> = if cg.items.is_empty() {
                all_items
            } else {
                for it in &cg.items {
                    if !all_items.iter().any(|a| a == it) {
                        return Err(format!(
                            "Calculation item '{}' not found in group '{}'.", it, cg.group
                        ));
                    }
                }
                // Preserve declaration order, restricted to the selected items.
                all_items.into_iter().filter(|a| cg.items.contains(a)).collect()
            };
            if resolved.is_empty() {
                return Err(format!("Calculation group '{}' has no items.", cg.group));
            }
            (
                Some(bi_engine::CalculationGroupApplication::new(
                    cg.group.clone(),
                    resolved.clone(),
                )),
                resolved,
            )
        }
        None => (None, Vec::new()),
    };

    let query_request = bi_engine::QueryRequest {
        measures: query_measures.clone(),
        group_by: query_group_by,
        filters: vec![],
        lookups: query_lookups,
        calculation_group: calc_group_app,
        ..Default::default()
    };

    log_info!(
        "PIVOT",
        "BI query: measures={:?}, group_by={} dims, lookups={} cols",
        query_measures,
        row_group_fields.len() + col_group_fields.len(),
        row_lookup_fields.len() + col_lookup_fields.len()
    );

    // Get the shared engine Arc for async query
    let t_query = Instant::now();
    let engine_arc = {
        let connections = bi_state.connections.lock()
            .map_err(|e| format!("connections lock poisoned: {}", e))?;
        let conn = connections.get(&connection_id)
            .ok_or_else(|| format!("Connection {} not found", connection_id))?;
        conn.engine.clone().ok_or("No BI model loaded.")?
    };

    // Auto-refresh in-memory tables that haven't been cached yet.
    // Multi-table queries go through LocalAggregation which reads from the
    // in-memory cache — tables must be refreshed at least once before querying.
    // `needs_refresh(..., Duration::ZERO)` returns true only if the table has
    // NEVER been refreshed, so this is a one-time cost per table per session.
    {
        // Collect all tables referenced by the query (dimensions + measure tables)
        let tables_to_refresh: Vec<String> = {
            let mut tables = referenced_tables.clone();
            let bi_meta = pivot_state.bi_metadata.lock()
                .map_err(|e| format!("bi_metadata lock poisoned: {}", e))?;
            if let Some(meta) = bi_meta.get(&pivot_id) {
                for measure_name in &query_measures {
                    if let Some(m) = meta.measures.iter().find(|m| m.name == *measure_name) {
                        if !tables.contains(&m.table) {
                            tables.push(m.table.clone());
                        }
                    }
                }
            }
            tables
        }; // bi_meta lock released here

        let mut engine = engine_arc.lock().await;
        for table_name in &tables_to_refresh {
            if engine.needs_refresh(table_name, std::time::Duration::from_secs(0)) {
                log_info!("PIVOT", "Auto-refreshing in-memory table '{}'", table_name);
                if let Err(e) = engine.refresh_table(table_name).await {
                    // Not all tables are in-memory — ignore errors for non-in-memory tables
                    log_info!("PIVOT", "refresh_table('{}') skipped: {}", table_name, e);
                }
            }
        }
    }

    let query_result = {
        let mut engine = engine_arc.lock().await;
        // Apply this connection's RLS role (or clear a sibling's) before querying.
        crate::bi::commands::apply_connection_role(&mut engine, &bi_state, connection_id);
        // query_with_meta returns per-column metadata (measure + calculation item
        // attribution) so the value-field -> cache-column mapping is driven by the
        // engine's own column identity rather than fragile positional arithmetic.
        engine.query_with_meta(query_request).await
    };
    let (batches, result_columns) = match query_result {
        Ok((b, m)) => (b, m),
        Err(e) => {
            // If the query failed and we were using a synthetic measure,
            // save the field assignments anyway so they persist, then return
            // an empty view.
            if synthetic_measure.is_some() {
                log_info!("PIVOT", "Synthetic measure query failed ({}), saving fields only", e);
                let mut pivot_tables = pivot_state.pivot_tables.lock()
                    .map_err(|e| format!("pivot_tables lock poisoned: {}", e))?;
                let (definition, stored_cache) = pivot_tables
                    .get_mut(&pivot_id)
                    .ok_or_else(|| format!("Pivot {} not found", pivot_id))?;

                definition.row_fields = request.row_fields.iter()
                    .map(|f| PivotField::new(0, format!("{}.{}", f.table, f.column)))
                    .collect();
                definition.column_fields = request.column_fields.iter()
                    .map(|f| PivotField::new(0, format!("{}.{}", f.table, f.column)))
                    .collect();
                definition.value_fields.clear();
                definition.calculated_fields.clear();
                definition.value_column_order.clear();
                definition.filter_fields = request.filter_fields.iter()
                    .map(|f| {
                        let field = PivotField::new(0, format!("{}.{}", f.table, f.column));
                        pivot_engine::PivotFilter {
                            field,
                            condition: pivot_engine::FilterCondition::ValueList(Vec::new()),
                        }
                    })
                    .collect();
                if let Some(ref layout_config) = request.layout {
                    apply_layout_config(&mut definition.layout, layout_config);
                }
                definition.bump_version();

                let empty_cache = PivotCache::new(pivot_id, 0);
                let view = create_empty_view(pivot_id, definition.version);
                let mut response = view_to_response(&view, definition, &mut empty_cache.clone());
                let destination = definition.destination;
                let dest_sheet_idx = resolve_dest_sheet_index(&state, definition);
                *stored_cache = empty_cache;
                drop(pivot_tables);

                response.overwritten_cell_count = count_overwritten_cells(&state, pivot_id, dest_sheet_idx, destination, &view);
                finalize_pivot_update(&state, &pivot_state, pivot_id, dest_sheet_idx, destination, &view, Some((&*pane_control_state, &*ribbon_filter_state)));
                return Ok(response);
            }
            return Err(crate::bi::commands::friendly_bi_query_error("BI query failed", &e));
        }
    };
    let query_ms = t_query.elapsed().as_secs_f64() * 1000.0;

    log_info!(
        "PIVOT",
        "BI query returned {} batches, query_ms={:.1}",
        batches.len(),
        query_ms
    );

    // Build PivotCache from Arrow results
    let t_cache = Instant::now();
    let mut cache = build_cache_from_arrow_batches(pivot_id, &batches)?;

    // Handle synthetic dimension for values-only case
    let use_synthetic_dim = has_values && !has_dimensions;
    if use_synthetic_dim {
        log_info!("PIVOT", "Values-only: injecting synthetic 'Total' dimension");
        // Rebuild cache with synthetic "Total" column prepended
        cache = build_cache_with_synthetic_dim(pivot_id, &batches)?;
    }
    let cache_ms = t_cache.elapsed().as_secs_f64() * 1000.0;

    // Build PivotDefinition field mappings
    //
    // Cache layout (BI engine result column order):
    // [group_by columns (row groups, col groups, filter groups, slicer groups)] [measure columns] [lookup columns]
    // If synthetic dim: [synthetic at 0] [everything shifted by 1]
    let num_group_by = row_group_fields.len() + hierarchy_row_refs.len()
        + col_group_fields.len() + hierarchy_col_refs.len()
        + filter_group_fields.len() + slicer_group_fields.len()
        + sort_by_extra_fields.len();
    let dim_offset: usize = if use_synthetic_dim { 1 } else { 0 };

    // Build a mapping from (table, column) -> cache column index.
    // BI engine result column order: [GROUP BY cols] [Measure cols] [Lookup cols]
    // num_measures reflects actual query columns (includes synthetic if present)
    let num_measures = if synthetic_measure.is_some() { 1 } else { request.value_fields.len() };
    // With a calculation group, the engine multiplies the measure block: each
    // base measure expands into one synthetic column per applied item, so the
    // value block is num_measures * num_items wide (measures-outer/items-inner).
    let num_items = if calc_item_names.is_empty() { 1 } else { calc_item_names.len() };
    let mut field_to_cache_idx: std::collections::HashMap<(String, String), usize> =
        std::collections::HashMap::new();

    // Group-by cols come first: row groups, hierarchy rows, col groups, hierarchy cols,
    // filter groups, slicer groups, then hidden sort-by columns
    let mut cache_idx = dim_offset;
    for f in row_group_fields.iter()
        .chain(hierarchy_row_refs.iter())
        .chain(col_group_fields.iter())
        .chain(hierarchy_col_refs.iter())
        .chain(filter_group_fields.iter())
        .chain(slicer_group_fields.iter())
        .chain(sort_by_extra_refs.iter())
    {
        field_to_cache_idx.insert((f.table.clone(), f.column.clone()), cache_idx);
        cache_idx += 1;
    }
    // Measures come next (after group_by, before lookups)
    let measure_start = num_group_by + dim_offset;
    // Lookup cols come last (after the expanded measure block)
    let lookup_start = num_group_by + num_measures * num_items + dim_offset;
    cache_idx = lookup_start;
    for f in row_lookup_fields.iter().chain(col_lookup_fields.iter()) {
        field_to_cache_idx.insert((f.table.clone(), f.column.clone()), cache_idx);
        cache_idx += 1;
    }

    // Build sort-by resolution map: (table, column) -> cache_index_of_sort_by_column.
    // Used to set sort_by_field_index on PivotField for BI columns with sort_by_column.
    let sort_by_resolution: std::collections::HashMap<(String, String), usize> = {
        let bi_meta = pivot_state.bi_metadata.lock()
            .map_err(|e| format!("bi_metadata lock poisoned: {}", e))?;
        let mut map = std::collections::HashMap::new();
        if let Some(meta) = bi_meta.get(&pivot_id) {
            for table_meta in &meta.model_tables {
                for col_meta in &table_meta.columns {
                    if let Some(ref sort_col) = col_meta.sort_by_column {
                        if let Some(&sort_cache_idx) = field_to_cache_idx.get(
                            &(table_meta.name.clone(), sort_col.clone())
                        ) {
                            map.insert(
                                (table_meta.name.clone(), col_meta.name.clone()),
                                sort_cache_idx,
                            );
                        }
                    }
                }
            }
        }
        map
    };

    // Helper: resolve sort_by_field_index for a BiFieldRef
    let resolve_sort_by = |f: &BiFieldRef| -> Option<usize> {
        sort_by_resolution.get(&(f.table.clone(), f.column.clone())).copied()
    };

    let mut pivot_tables = pivot_state.pivot_tables.lock()
        .map_err(|e| format!("pivot_tables lock poisoned: {}", e))?;
    let (definition, stored_cache) = pivot_tables
        .get_mut(&pivot_id)
        .ok_or_else(|| format!("Pivot {} not found", pivot_id))?;

    // Dimension number formats from the model column (query_with_meta populates
    // ResultColumn.format_string for dimension columns). Keyed case-insensitively
    // by (table, column); applied to each row/column field so its header/item
    // values render with the model-defined format.
    let dim_format: std::collections::HashMap<(String, String), String> = result_columns
        .iter()
        .filter(|rc| matches!(rc.kind, bi_engine::ResultColumnKind::Dimension))
        .filter_map(|rc| {
            Some((
                (
                    rc.source_table.clone()?.to_lowercase(),
                    rc.source_column.clone()?.to_lowercase(),
                ),
                rc.format_string.clone()?,
            ))
        })
        .collect();
    let dim_format_for = |table: &str, column: &str| -> Option<String> {
        dim_format
            .get(&(table.to_lowercase(), column.to_lowercase()))
            .cloned()
    };

    // Row fields (preserving collapse state for fields that remain)
    // Lookup fields share the same hierarchy depth as the preceding GROUP field
    // from the same table (they are attributes, not new grouping levels).
    let old_row_fields = definition.row_fields.clone();
    let hierarchy_row_start;
    if use_synthetic_dim {
        // Synthetic "Total" dimension as the only row field
        definition.row_fields = vec![PivotField::new(0, "Total".to_string())];
        hierarchy_row_start = 1;
    } else {
        let mut row_fields_vec: Vec<PivotField> = request
            .row_fields
            .iter()
            .map(|f| {
                let idx = *field_to_cache_idx
                    .get(&(f.table.clone(), f.column.clone()))
                    .unwrap_or(&0);
                let name = format!("{}.{}", f.table, f.column);
                let mut pf = if f.is_lookup {
                    PivotField::new_attribute(idx, name)
                } else {
                    PivotField::new(idx, name)
                };
                pf.sort_by_field_index = resolve_sort_by(f);
                pf.number_format = dim_format_for(&f.table, &f.column);
                pf
            })
            .collect();
        // Append hierarchy level fields as row dimensions.
        // All levels start collapsed so the user expands via toggle_pivot_group.
        hierarchy_row_start = row_fields_vec.len();
        for f in hierarchy_row_fields.iter() {
            let idx = *field_to_cache_idx
                .get(&(f.table.clone(), f.column.clone()))
                .unwrap_or(&0);
            let name = format!("{}.{}", f.table, f.column);
            let mut pf = PivotField::new(idx, name);
            pf.collapsed = true;
            pf.sort_by_field_index = resolve_sort_by(f);
            row_fields_vec.push(pf);
        }
        definition.row_fields = row_fields_vec;
    }
    preserve_collapse_state(&mut definition.row_fields, &old_row_fields);

    // Column fields (preserving collapse state for fields that remain)
    let old_col_fields = definition.column_fields.clone();
    let mut col_fields_vec: Vec<PivotField> = request
        .column_fields
        .iter()
        .map(|f| {
            let idx = *field_to_cache_idx
                .get(&(f.table.clone(), f.column.clone()))
                    .unwrap_or(&0);
            let name = format!("{}.{}", f.table, f.column);
            let mut pf = if f.is_lookup {
                PivotField::new_attribute(idx, name)
            } else {
                PivotField::new(idx, name)
            };
            pf.sort_by_field_index = resolve_sort_by(f);
            pf.number_format = dim_format_for(&f.table, &f.column);
            pf
        })
        .collect();
    // Append hierarchy level fields as column dimensions.
    let hierarchy_col_start = col_fields_vec.len();
    for f in hierarchy_col_fields.iter() {
        let idx = *field_to_cache_idx
            .get(&(f.table.clone(), f.column.clone()))
            .unwrap_or(&0);
        let name = format!("{}.{}", f.table, f.column);
        let mut pf = PivotField::new(idx, name);
        pf.collapsed = true;
        pf.sort_by_field_index = resolve_sort_by(f);
        col_fields_vec.push(pf);
    }
    definition.column_fields = col_fields_vec;
    preserve_collapse_state(&mut definition.column_fields, &old_col_fields);

    // Value fields — measures map to cache columns right after group_by columns
    // (before lookup columns). BI engine result order: [group_by] [measures] [lookups].
    // Use "[MeasureName]" format so the frontend can extract the measure name
    // consistently via toBiValueFieldRef. The BI engine handles aggregation,
    // so we use Sum as an identity operation on pre-aggregated data.
    // When using a synthetic measure (dimensions-only), leave value_fields empty
    // so the pivot engine renders blank data cells for each dimension combination.
    if synthetic_measure.is_some() {
        definition.value_fields = Vec::new();
    } else {
        // Map each measure value column to its cache index from the engine's
        // per-column metadata (base measure + applied calculation item), so the
        // value-field mapping follows the engine's actual column identity rather
        // than positional arithmetic. Empty/absent metadata -> positional fallback.
        let value_col_idx: std::collections::HashMap<(String, Option<String>), usize> =
            result_columns
                .iter()
                .enumerate()
                .filter(|(_, rc)| matches!(rc.kind, bi_engine::ResultColumnKind::Measure))
                .filter_map(|(i, rc)| rc.measure.clone().map(|m| ((m, rc.calculation_item.clone()), i)))
                .collect();
        definition.value_fields = expand_bi_value_fields(
            &request.value_fields,
            &calc_item_names,
            measure_start,
            &value_col_idx,
        );

        // Adopt each measure's model number format (from query_with_meta) so BI
        // value cells render with the model-defined format (currency, %, etc.)
        // rather than raw numbers. Keyed by (base measure, calculation item);
        // for a calc-group column the format is carried from the base measure.
        let format_by_key: std::collections::HashMap<(String, Option<String>), String> =
            result_columns
                .iter()
                .filter(|rc| matches!(rc.kind, bi_engine::ResultColumnKind::Measure))
                .filter_map(|rc| {
                    let m = rc.measure.clone()?;
                    let f = rc.format_string.clone()?;
                    Some(((m, rc.calculation_item.clone()), f))
                })
                .collect();
        if !format_by_key.is_empty() {
            for vf in definition.value_fields.iter_mut() {
                let measure = vf.name.trim_start_matches('[').trim_end_matches(']').to_string();
                if let Some(fmt) = format_by_key.get(&(measure, vf.calc_item.clone())) {
                    vf.number_format = Some(fmt.clone());
                }
            }
        }
    }

    // Filter fields — same as row/column fields, map BiFieldRef to PivotFilter.
    // If the request carries hidden_items (from DSL editor), apply them.
    // Otherwise, preserve hidden_items from the old definition (from filter dropdown).
    let old_filter_fields = definition.filter_fields.clone();
    definition.filter_fields = request
        .filter_fields
        .iter()
        .map(|f| {
            let idx = *field_to_cache_idx
                .get(&(f.table.clone(), f.column.clone()))
                .unwrap_or(&0);
            let name = format!("{}.{}", f.table, f.column);
            let mut field = if f.is_lookup {
                PivotField::new_attribute(idx, name)
            } else {
                PivotField::new(idx, name)
            };
            field.sort_by_field_index = resolve_sort_by(f);
            let mut filter = pivot_engine::PivotFilter {
                field,
                condition: pivot_engine::FilterCondition::ValueList(Vec::new()),
            };
            if !f.hidden_items.is_empty() {
                // Request explicitly provides hidden_items (e.g., from DSL editor)
                filter.field.hidden_items = f.hidden_items.clone();
            } else if let Some(old) = old_filter_fields.iter().find(|of| of.field.source_index == idx) {
                // Preserve from previous definition (filter dropdown applies via regular updateFields)
                filter.field.hidden_items = old.field.hidden_items.clone();
            }
            filter
        })
        .collect();

    // Slicer fields — map to slicer_filters (no visible filter row).
    // When slicer_fields are provided, create new slicer_filters entries.
    // When empty (e.g. Pivot editor updates), clear slicer_filters since the
    // slicer extension will lazily re-add fields via ensureBiFieldInPivotCache.
    if !request.slicer_fields.is_empty() {
        // Build a name->old_hidden_items map so we can preserve filter state
        // across cache rebuilds (source_index may shift).
        let old_slicer_hidden: std::collections::HashMap<String, Vec<String>> = {
            let old_cache_fields = &stored_cache.fields; // old cache before replacement
            definition.slicer_filters.iter().filter_map(|sf| {
                old_cache_fields.get(sf.source_index)
                    .map(|fc| (fc.name.clone(), sf.hidden_items.clone()))
            }).collect()
        };
        definition.slicer_filters = request
            .slicer_fields
            .iter()
            .map(|f| {
                let idx = *field_to_cache_idx
                    .get(&(f.table.clone(), f.column.clone()))
                    .unwrap_or(&0);
                // Preserve hidden_items from the old slicer filter (matched by field name)
                let hidden_items = old_slicer_hidden.get(&f.column)
                    .or_else(|| old_slicer_hidden.get(&format!("{}.{}", f.table, f.column)))
                    .cloned()
                    .unwrap_or_default();
                pivot_engine::SlicerFilter {
                    source_index: idx,
                    hidden_items,
                }
            })
            .collect();
    } else {
        // No slicer_fields in request — clear stale slicer_filters whose
        // source_index would be invalid in the new cache.
        definition.slicer_filters.clear();
    }

    // Apply layout
    if let Some(ref layout_config) = request.layout {
        apply_layout_config(&mut definition.layout, layout_config);
    }

    // Grand/sub-totals are computed by summing the value columns over the axis,
    // which is not meaningful per calculation item (e.g. a YTD or ratio item
    // summed across rows is wrong). While a calculation group is applied, force
    // totals off so we never render a misleading total. Authoritative here so it
    // holds across the editor, the DSL, refresh, and .calp.
    if !calc_item_names.is_empty() {
        definition.layout.show_row_grand_totals = false;
        definition.layout.show_column_grand_totals = false;
        for f in definition.row_fields.iter_mut().chain(definition.column_fields.iter_mut()) {
            f.show_subtotals = false;
        }
    }

    // Update calculated fields. The Design-view DSL has no number-format
    // syntax, so an incoming def without one keeps the existing format
    // for the same-named field instead of silently wiping it.
    if let Some(ref calc_fields) = request.calculated_fields {
        let existing = std::mem::take(&mut definition.calculated_fields);
        definition.calculated_fields = calc_fields
            .iter()
            .map(|cf| pivot_engine::CalculatedField {
                name: cf.name.clone(),
                formula: cf.formula.clone(),
                number_format: cf.number_format.clone().or_else(|| {
                    existing
                        .iter()
                        .find(|e| e.name == cf.name)
                        .and_then(|e| e.number_format.clone())
                }),
            })
            .collect();
    }

    // Update value column order
    if let Some(ref order) = request.value_column_order {
        definition.value_column_order = order
            .iter()
            .map(|r| match r {
                ValueColumnRefDef::Value { index } => pivot_engine::ValueColumnRef::Value(*index),
                ValueColumnRefDef::Calculated { index } => pivot_engine::ValueColumnRef::Calculated(*index),
            })
            .collect();
    }

    // Set up hierarchy configs for ragged behavior support in the pivot engine.
    {
        definition.hierarchy_configs.clear();
        let mut row_offset = hierarchy_row_start;
        let mut col_offset = hierarchy_col_start;
        for hm in &hierarchy_metas {
            let ragged = match hm.ragged_behavior {
                BiRaggedBehavior::ShowBlanks => pivot_engine::RaggedBehavior::ShowBlanks,
                BiRaggedBehavior::HideMembers => pivot_engine::RaggedBehavior::HideMembers,
                BiRaggedBehavior::RepeatParent => pivot_engine::RaggedBehavior::RepeatParent,
                BiRaggedBehavior::ShowAsLeaf => pivot_engine::RaggedBehavior::ShowAsLeaf,
            };
            if hm.is_row {
                definition.hierarchy_configs.push(pivot_engine::HierarchyConfig {
                    name: hm.name.clone(),
                    field_start: row_offset,
                    field_count: hm.field_count,
                    is_row: true,
                    ragged_behavior: ragged,
                });
                row_offset += hm.field_count;
            } else {
                definition.hierarchy_configs.push(pivot_engine::HierarchyConfig {
                    name: hm.name.clone(),
                    field_start: col_offset,
                    field_count: hm.field_count,
                    is_row: false,
                    ragged_behavior: ragged,
                });
                col_offset += hm.field_count;
            }
        }
    }

    definition.bump_version();

    // Calculate pivot view
    let t_calc = Instant::now();
    *stored_cache = cache;
    let view = safe_calculate_pivot(definition, stored_cache);
    store_view(&pivot_state, pivot_id, &view);
    let calc_ms = t_calc.elapsed().as_secs_f64() * 1000.0;

    let t_resp = Instant::now();
    let mut response = view_to_response(&view, definition, stored_cache);
    let resp_ms = t_resp.elapsed().as_secs_f64() * 1000.0;
    let destination = definition.destination;
    let auto_fit = definition.layout.auto_fit_column_widths;
    let dest_sheet_idx = resolve_dest_sheet_index(&state, definition);
    drop(pivot_tables);

    // Update grid (clear old region + write new)
    let t_grid = Instant::now();
    response.overwritten_cell_count = count_overwritten_cells(&state, pivot_id, dest_sheet_idx, destination, &view);
    update_pivot_in_grid(&state, pivot_id, dest_sheet_idx, destination, &view);
    if auto_fit {
        auto_fit_pivot_columns(&state, destination, &view);
    }
    update_pivot_region(&state, pivot_id, dest_sheet_idx, destination, &view);
    recalculate_sheet_formulas(&state, &pivot_state, Some((&*pane_control_state, &*ribbon_filter_state)));
    let grid_ms = t_grid.elapsed().as_secs_f64() * 1000.0;

    // Store last query + lookup column set in bi_metadata
    {
        let mut bi_meta = pivot_state.bi_metadata.lock()
            .map_err(|e| format!("bi_metadata lock poisoned: {}", e))?;
        if let Some(meta) = bi_meta.get_mut(&pivot_id) {
            let group_fields: Vec<BiFieldRef> = request
                .row_fields
                .iter()
                .chain(request.column_fields.iter())
                .filter(|f| !f.is_lookup)
                .cloned()
                .collect();
            let lookup_fields: Vec<BiFieldRef> = request
                .row_fields
                .iter()
                .chain(request.column_fields.iter())
                .filter(|f| f.is_lookup)
                .cloned()
                .collect();
            meta.last_query = Some(BiPivotQuery {
                measures: request.value_fields.iter().map(|v| v.measure_name.clone()).collect(),
                group_by: group_fields,
                lookups: lookup_fields,
            });
            // Remember the applied calculation group (the user's selection) so
            // refresh re-applies it and the editor reflects it. None when no
            // group was effectively applied.
            meta.applied_calc_group =
                request.calculation_group.clone().filter(|_| !calc_item_names.is_empty());
            // Record the data snapshot time only when we actually went to the
            // database (online). When served purely from cache (all_warm, e.g.
            // offline), keep the existing timestamp so "Data as of …" reflects
            // when the data was truly fetched, not when the layout last changed.
            if !all_warm {
                meta.data_as_of = Some(chrono::Utc::now().to_rfc3339());
            }
            // Persist full lookup column set (including fields not in zones)
            meta.lookup_columns = request.lookup_columns.into_iter().collect();
        }
    }

    let total_ms = t_total.elapsed().as_secs_f64() * 1000.0;
    let payload_bytes = serde_json::to_string(&response).map(|s| s.len()).unwrap_or(0);
    let payload_kb = payload_bytes as f64 / 1024.0;
    log_perf!(
        "PIVOT",
        "update_bi_pivot_fields pivot_id={} rows={}x{} | query={:.1}ms cache={:.1}ms calc={:.1}ms resp={:.1}ms grid={:.1}ms TOTAL={:.1}ms | payload={:.1}KB",
        pivot_id,
        response.row_count,
        response.col_count,
        query_ms,
        cache_ms,
        calc_ms,
        resp_ms,
        grid_ms,
        total_ms,
        payload_kb
    );

    Ok(response)
}

/// Persists the set of LOOKUP columns for a BI pivot without re-querying.
/// This is a lightweight call that only updates metadata — no BI query,
/// no pivot recalculation, no grid update.
#[tauri::command]
pub fn set_bi_lookup_columns(
    pivot_state: State<'_, PivotState>,
    pivot_id: PivotId,
    lookup_columns: Vec<String>,
) -> Result<(), String> {
    let mut bi_meta = pivot_state.bi_metadata.lock().unwrap();
    let meta = bi_meta
        .get_mut(&pivot_id)
        .ok_or_else(|| format!("No BI metadata for pivot {}", pivot_id))?;
    meta.lookup_columns = lookup_columns.into_iter().collect();
    Ok(())
}

// ============================================================================
// REPORT FILTER PAGES
// ============================================================================

/// Generates one sheet per unique value of a filter field.
/// Each sheet contains a static copy of the pivot table filtered to that value.
#[tauri::command]
pub fn show_report_filter_pages(
    state: State<AppState>,
    pivot_state: State<'_, PivotState>,
    pivot_id: PivotId,
    filter_field_index: usize,
) -> Result<Vec<String>, String> {
    log_info!(
        "PIVOT",
        "show_report_filter_pages pivot_id={} filter_field={}",
        pivot_id,
        filter_field_index
    );

    let pivot_tables = pivot_state.pivot_tables.lock().unwrap();
    let (definition, cache) = pivot_tables
        .get(&pivot_id)
        .ok_or_else(|| format!("Pivot table {} not found", pivot_id))?;

    if filter_field_index >= definition.filter_fields.len() {
        return Err(format!(
            "Filter field index {} out of range (max {})",
            filter_field_index,
            definition.filter_fields.len().saturating_sub(1)
        ));
    }

    let filter_field = &definition.filter_fields[filter_field_index];
    let field_index = filter_field.field.source_index;

    // Get unique values for this filter field
    let unique_values = cache.get_unique_values_for_filter(field_index);
    if unique_values.is_empty() {
        return Ok(Vec::new());
    }

    let mut created_sheets = Vec::new();

    for (_vid, value_label) in &unique_values {
        if value_label.is_empty() {
            continue;
        }

        // Clone definition and apply the filter for this value
        let mut filtered_def = definition.clone();

        // Set the filter to show only this value (hide all others)
        let all_labels: Vec<String> = unique_values.iter()
            .map(|(_, l)| l.clone())
            .collect();
        let hidden: Vec<String> = all_labels.iter()
            .filter(|l| l.as_str() != value_label.as_str())
            .cloned()
            .collect();
        filtered_def.filter_fields[filter_field_index].field.hidden_items = hidden;

        // Compute the filtered pivot view
        let mut cache_clone = cache.clone();
        let view = safe_calculate_pivot(&filtered_def, &mut cache_clone);

        // Create a new sheet with this value's name
        let sheet_name = sanitize_sheet_name(value_label);

        // Use AppState to create the sheet and write the pivot view
        let mut sheet_names = state.sheet_names.lock().unwrap();
        let mut grids = state.grids.lock().unwrap();

        // Skip if sheet already exists
        if sheet_names.contains(&sheet_name) {
            continue;
        }

        let new_grid = engine::Grid::new();
        sheet_names.push(sheet_name.clone());
        grids.push(new_grid);

        let sheet_idx = grids.len() - 1;

        // Write the pivot view to the new sheet as static cells
        let mut styles = state.style_registry.lock().unwrap();
        if let Some(grid) = grids.get_mut(sheet_idx) {
            let _ = crate::pivot::operations::write_pivot_to_grid(
                grid,
                None,
                &view,
                (0, 0),
                &mut styles,
            );
        }

        drop(styles);
        drop(grids);
        drop(sheet_names);

        created_sheets.push(sheet_name);
    }

    Ok(created_sheets)
}

/// Sanitizes a string for use as a sheet name.
fn sanitize_sheet_name(name: &str) -> String {
    let sanitized: String = name
        .chars()
        .map(|c| match c {
            '/' | '\\' | '?' | '*' | '[' | ']' | ':' => '_',
            _ => c,
        })
        .take(31) // Excel limit
        .collect();
    if sanitized.is_empty() {
        "Sheet".to_string()
    } else {
        sanitized
    }
}

// ============================================================================
// CALCULATED FIELD COMMANDS
// ============================================================================

/// Adds a calculated field to a pivot table.
#[tauri::command]
pub fn add_calculated_field(
    state: State<AppState>,
    pivot_state: State<'_, PivotState>,
    pane_control_state: State<'_, crate::pane_control::PaneControlState>,
    ribbon_filter_state: State<'_, crate::ribbon_filter::RibbonFilterState>,
    request: CalculatedFieldRequest,
) -> Result<PivotViewResponse, String> {
    log_info!(
        "PIVOT",
        "add_calculated_field pivot_id={} name={} formula={}",
        request.pivot_id,
        request.name,
        request.formula
    );

    // Validate the formula parses correctly
    pivot_engine::calculated::parse_calc_formula(&request.formula)
        .map_err(|e| format!("Invalid formula: {}", e))?;

    let mut pivot_tables = pivot_state.pivot_tables.lock().unwrap();
    let (definition, cache) = pivot_tables
        .get_mut(&request.pivot_id)
        .ok_or_else(|| format!("Pivot table {} not found", request.pivot_id))?;

    definition.calculated_fields.push(pivot_engine::CalculatedField {
        name: request.name,
        formula: request.formula,
        number_format: request.number_format,
    });

    definition.bump_version();

    let view = safe_calculate_pivot(definition, cache);
    store_view(&pivot_state, request.pivot_id, &view);
    let mut response = view_to_response(&view, definition, cache);

    let destination = definition.destination;
    let pivot_id = definition.id;
    let dest_sheet_idx = resolve_dest_sheet_index(&state, definition);

    drop(pivot_tables);

    response.overwritten_cell_count = count_overwritten_cells(&state, pivot_id, dest_sheet_idx, destination, &view);
    finalize_pivot_update(&state, &pivot_state, pivot_id, dest_sheet_idx, destination, &view, Some((&*pane_control_state, &*ribbon_filter_state)));

    Ok(response)
}

/// Updates an existing calculated field.
#[tauri::command]
pub fn update_calculated_field(
    state: State<AppState>,
    pivot_state: State<'_, PivotState>,
    pane_control_state: State<'_, crate::pane_control::PaneControlState>,
    ribbon_filter_state: State<'_, crate::ribbon_filter::RibbonFilterState>,
    request: UpdateCalculatedFieldRequest,
) -> Result<PivotViewResponse, String> {
    log_info!(
        "PIVOT",
        "update_calculated_field pivot_id={} index={} name={} formula={}",
        request.pivot_id,
        request.field_index,
        request.name,
        request.formula
    );

    pivot_engine::calculated::parse_calc_formula(&request.formula)
        .map_err(|e| format!("Invalid formula: {}", e))?;

    let mut pivot_tables = pivot_state.pivot_tables.lock().unwrap();
    let (definition, cache) = pivot_tables
        .get_mut(&request.pivot_id)
        .ok_or_else(|| format!("Pivot table {} not found", request.pivot_id))?;

    if request.field_index >= definition.calculated_fields.len() {
        return Err(format!(
            "Calculated field index {} out of range (max {})",
            request.field_index,
            definition.calculated_fields.len().saturating_sub(1)
        ));
    }

    definition.calculated_fields[request.field_index] = pivot_engine::CalculatedField {
        name: request.name,
        formula: request.formula,
        number_format: request.number_format,
    };

    definition.bump_version();

    let view = safe_calculate_pivot(definition, cache);
    store_view(&pivot_state, request.pivot_id, &view);
    let mut response = view_to_response(&view, definition, cache);

    let destination = definition.destination;
    let pivot_id = definition.id;
    let dest_sheet_idx = resolve_dest_sheet_index(&state, definition);

    drop(pivot_tables);

    response.overwritten_cell_count = count_overwritten_cells(&state, pivot_id, dest_sheet_idx, destination, &view);
    finalize_pivot_update(&state, &pivot_state, pivot_id, dest_sheet_idx, destination, &view, Some((&*pane_control_state, &*ribbon_filter_state)));

    Ok(response)
}

/// Removes a calculated field from a pivot table.
#[tauri::command]
pub fn remove_calculated_field(
    state: State<AppState>,
    pivot_state: State<'_, PivotState>,
    pane_control_state: State<'_, crate::pane_control::PaneControlState>,
    ribbon_filter_state: State<'_, crate::ribbon_filter::RibbonFilterState>,
    request: RemoveCalculatedFieldRequest,
) -> Result<PivotViewResponse, String> {
    log_info!(
        "PIVOT",
        "remove_calculated_field pivot_id={} index={}",
        request.pivot_id,
        request.field_index
    );

    let mut pivot_tables = pivot_state.pivot_tables.lock().unwrap();
    let (definition, cache) = pivot_tables
        .get_mut(&request.pivot_id)
        .ok_or_else(|| format!("Pivot table {} not found", request.pivot_id))?;

    if request.field_index >= definition.calculated_fields.len() {
        return Err(format!(
            "Calculated field index {} out of range (max {})",
            request.field_index,
            definition.calculated_fields.len().saturating_sub(1)
        ));
    }

    definition.calculated_fields.remove(request.field_index);
    definition.bump_version();

    let view = safe_calculate_pivot(definition, cache);
    store_view(&pivot_state, request.pivot_id, &view);
    let mut response = view_to_response(&view, definition, cache);

    let destination = definition.destination;
    let pivot_id = definition.id;
    let dest_sheet_idx = resolve_dest_sheet_index(&state, definition);

    drop(pivot_tables);

    response.overwritten_cell_count = count_overwritten_cells(&state, pivot_id, dest_sheet_idx, destination, &view);
    finalize_pivot_update(&state, &pivot_state, pivot_id, dest_sheet_idx, destination, &view, Some((&*pane_control_state, &*ribbon_filter_state)));

    Ok(response)
}

// ============================================================================
// CALCULATED ITEM COMMANDS
// ============================================================================

/// Adds a calculated item to a pivot field.
#[tauri::command]
pub fn add_calculated_item(
    state: State<AppState>,
    pivot_state: State<'_, PivotState>,
    pane_control_state: State<'_, crate::pane_control::PaneControlState>,
    ribbon_filter_state: State<'_, crate::ribbon_filter::RibbonFilterState>,
    request: CalculatedItemRequest,
) -> Result<PivotViewResponse, String> {
    log_info!(
        "PIVOT",
        "add_calculated_item pivot_id={} field_index={} name={} formula={}",
        request.pivot_id,
        request.field_index,
        request.name,
        request.formula
    );

    pivot_engine::calculated::parse_calc_formula(&request.formula)
        .map_err(|e| format!("Invalid formula: {}", e))?;

    let mut pivot_tables = pivot_state.pivot_tables.lock().unwrap();
    let (definition, cache) = pivot_tables
        .get_mut(&request.pivot_id)
        .ok_or_else(|| format!("Pivot table {} not found", request.pivot_id))?;

    definition.calculated_items.push(pivot_engine::CalculatedItem {
        field_index: request.field_index,
        name: request.name,
        formula: request.formula,
    });

    definition.bump_version();

    let view = safe_calculate_pivot(definition, cache);
    store_view(&pivot_state, request.pivot_id, &view);
    let mut response = view_to_response(&view, definition, cache);

    let destination = definition.destination;
    let pivot_id = definition.id;
    let dest_sheet_idx = resolve_dest_sheet_index(&state, definition);

    drop(pivot_tables);

    response.overwritten_cell_count = count_overwritten_cells(&state, pivot_id, dest_sheet_idx, destination, &view);
    finalize_pivot_update(&state, &pivot_state, pivot_id, dest_sheet_idx, destination, &view, Some((&*pane_control_state, &*ribbon_filter_state)));

    Ok(response)
}

/// Removes a calculated item from a pivot table.
#[tauri::command]
pub fn remove_calculated_item(
    state: State<AppState>,
    pivot_state: State<'_, PivotState>,
    pane_control_state: State<'_, crate::pane_control::PaneControlState>,
    ribbon_filter_state: State<'_, crate::ribbon_filter::RibbonFilterState>,
    request: RemoveCalculatedItemRequest,
) -> Result<PivotViewResponse, String> {
    log_info!(
        "PIVOT",
        "remove_calculated_item pivot_id={} index={}",
        request.pivot_id,
        request.item_index
    );

    let mut pivot_tables = pivot_state.pivot_tables.lock().unwrap();
    let (definition, cache) = pivot_tables
        .get_mut(&request.pivot_id)
        .ok_or_else(|| format!("Pivot table {} not found", request.pivot_id))?;

    if request.item_index >= definition.calculated_items.len() {
        return Err(format!(
            "Calculated item index {} out of range (max {})",
            request.item_index,
            definition.calculated_items.len().saturating_sub(1)
        ));
    }

    definition.calculated_items.remove(request.item_index);
    definition.bump_version();

    let view = safe_calculate_pivot(definition, cache);
    store_view(&pivot_state, request.pivot_id, &view);
    let mut response = view_to_response(&view, definition, cache);

    let destination = definition.destination;
    let pivot_id = definition.id;
    let dest_sheet_idx = resolve_dest_sheet_index(&state, definition);

    drop(pivot_tables);

    response.overwritten_cell_count = count_overwritten_cells(&state, pivot_id, dest_sheet_idx, destination, &view);
    finalize_pivot_update(&state, &pivot_state, pivot_id, dest_sheet_idx, destination, &view, Some((&*pane_control_state, &*ribbon_filter_state)));

    Ok(response)
}