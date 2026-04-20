//! FILENAME: app/src-tauri/src/pivot/commands.rs
//! PURPOSE: Tauri commands for Pivot Table operations.
//! CONTEXT: Excel-compatible Pivot Table API implementation.

use crate::bi::types::BiState;
use crate::bi::commands::{auto_connect_bi_connection, auto_bind_tables_on_connection};
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

/// Creates a new pivot table from the specified source range
#[tauri::command]
pub fn create_pivot_table(
    state: State<AppState>,
    pivot_state: State<'_, PivotState>,
    request: CreatePivotRequest,
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
    let mut next_id = pivot_state.next_pivot_id.lock().unwrap();
    let pivot_id = *next_id;
    *next_id += 1;
    drop(next_id);

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

    // Calculate initial view (will be empty since no fields are configured)
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
        update_pivot_in_grid(&state, pivot_id, dest_sheet_idx, destination, &view);
        update_pivot_region(&state, pivot_id, dest_sheet_idx, destination, &view);

        Ok(())
    } else {
        // No previous state available — nothing to revert
        Ok(())
    }
}

/// Updates the field configuration of an existing pivot table
#[tauri::command]
pub async fn update_pivot_fields(
    window: tauri::Window,
    state: State<'_, AppState>,
    pivot_state: State<'_, PivotState>,
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
    let response = view_to_response(&view, &definition, &mut cache);
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

    // Clean up cancellation token (keep previous_states for potential revert command)
    pivot_state.cancellation_tokens.lock().unwrap().remove(&pivot_id);

    let total_ms = t_total.elapsed().as_secs_f64() * 1000.0;
    let payload_bytes = serde_json::to_string(&response).map(|s| s.len()).unwrap_or(0);
    let payload_kb = payload_bytes as f64 / 1024.0;

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
            // Update version to match bumped definition
            view.version = definition.version;
            // Update row_count to reflect visible rows
            view.row_count = visible_idx;
            let toggle_ms = t_toggle.elapsed().as_secs_f64() * 1000.0;

            let t_resp = Instant::now();
            let response = view_to_response(view, definition, cache);
            let serialize_ms = t_resp.elapsed().as_secs_f64() * 1000.0;

            // Store updated view
            store_view(&pivot_state, pivot_id, view);
            drop(pivot_tables);

            // Clear old cells and write updated view to grid (prevents orphaned cells
            // when pivot shrinks after collapse)
            update_pivot_in_grid(&state, pivot_id, dest_sheet_idx, destination, view);
            update_pivot_region(&state, pivot_id, dest_sheet_idx, destination, view);

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
    let response = view_to_response(&view, definition, cache);
    let serialize_ms = t_resp.elapsed().as_secs_f64() * 1000.0;

    // Store view for windowed cell fetching
    store_view(&pivot_state, pivot_id, &view);

    drop(pivot_tables);

    // Clear old cells and write updated view to grid, then update region bounds
    update_pivot_in_grid(&state, pivot_id, dest_sheet_idx, destination, &view);
    update_pivot_region(&state, pivot_id, dest_sheet_idx, destination, &view);

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
    let (definition, _) = pivot_tables
        .get(&pivot_id)
        .ok_or_else(|| format!("Pivot table {} not found", pivot_id))?;
    
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
    regions.retain(|r| !(r.region_type == "pivot" && r.owner_id == pivot_id as u64));

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
    pivot_id: PivotId,
) -> Result<PivotViewResponse, String> {
    log_info!("PIVOT", "refresh_pivot_cache pivot_id={}", pivot_id);

    let t_total = Instant::now();

    // Create cancellation token
    let token = CancellationToken::new();
    pivot_state.cancellation_tokens.lock().unwrap().insert(pivot_id, token.clone());

    // 1. Lock briefly: read source info, build new cache from grid, release locks
    let (old_definition, old_cache, new_definition, new_cache, dest_sheet_idx, destination) = {
        let pivot_tables = pivot_state.pivot_tables.lock().unwrap();
        let (definition, cache) = pivot_tables
            .get(&pivot_id)
            .ok_or_else(|| format!("Pivot table {} not found", pivot_id))?;

        let mut source_start = definition.source_start;
        let mut source_end = definition.source_end;
        let has_headers = definition.source_has_headers;
        let destination = definition.destination;
        let dest_sheet_idx = resolve_dest_sheet_index(&state, definition);
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

        // Save old state for reversion on cancel
        let old_definition = definition.clone();
        let old_cache = cache.clone();
        pivot_state.previous_states.lock().unwrap()
            .insert(pivot_id, (old_definition.clone(), old_cache.clone()));

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
    let response = view_to_response(&view, &definition, &mut cache);
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

    // Update pivot in grid
    update_pivot_in_grid(&state, pivot_id, dest_sheet_idx, destination, &view);

    // Update pivot region tracking
    update_pivot_region(&state, pivot_id, dest_sheet_idx, destination, &view);

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
        Some(region) if region.region_type == "pivot" => region.owner_id as PivotId,
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
        }
    }).collect();

    let value_fields: Vec<ZoneFieldInfo> = definition.value_fields.iter().map(|f| {
        let is_numeric = cache.is_numeric_field(f.source_index);
        ZoneFieldInfo {
            source_index: f.source_index,
            name: f.name.clone(),
            is_numeric,
            aggregation: Some(aggregation_to_string(f.aggregation)),
            is_lookup: false,
        }
    }).collect();

    let filter_fields: Vec<ZoneFieldInfo> = definition.filter_fields.iter().map(|f| {
        let is_numeric = cache.is_numeric_field(f.field.source_index);
        ZoneFieldInfo {
            source_index: f.field.source_index,
            name: f.field.name.clone(),
            is_numeric,
            aggregation: None,
            is_lookup: f.field.is_attribute,
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
    
    let field_configuration = PivotFieldConfiguration {
        row_fields,
        column_fields,
        value_fields,
        filter_fields: filter_fields.clone(),
        layout,
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
                "PIVOT",
                "get_pivot_at_cell: BI pivot_id={}, {} tables, {} measures",
                pivot_id,
                meta.model_tables.len(),
                meta.measures.len()
            );
            BiPivotModelInfo {
                connection_id: meta.connection_id,
                tables: meta.model_tables.clone(),
                measures: meta.measures.clone(),
                lookup_columns: meta.lookup_columns.iter().cloned().collect(),
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
    }))
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
            let pid = r.owner_id as PivotId;
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
    update_pivot_in_grid(&state, pivot_id, dest_sheet_idx, destination, &view);
    update_pivot_region(&state, pivot_id, dest_sheet_idx, destination, &view);

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
    let response = view_to_response(&view, &definition, &mut final_cache);

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
    let response = view_to_response(&view, definition, cache);

    // Get destination info
    let destination = definition.destination;
    let pivot_id = definition.id;
    let dest_sheet_idx = resolve_dest_sheet_index(&state, definition);

    drop(pivot_tables);

    // Update pivot in grid
    update_pivot_in_grid(&state, pivot_id, dest_sheet_idx, destination, &view);
    update_pivot_region(&state, pivot_id, dest_sheet_idx, destination, &view);

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

    Ok(PivotHierarchiesInfo {
        hierarchies,
        row_hierarchies,
        column_hierarchies,
        data_hierarchies,
        filter_hierarchies,
    })
}

/// Adds a field to a hierarchy (row, column, data, or filter).
#[tauri::command]
pub fn add_pivot_hierarchy(
    state: State<AppState>,
    pivot_state: State<'_, PivotState>,
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
    let response = view_to_response(&view, definition, cache);

    let destination = definition.destination;
    let pivot_id = definition.id;
    let dest_sheet_idx = resolve_dest_sheet_index(&state, definition);

    drop(pivot_tables);

    update_pivot_in_grid(&state, pivot_id, dest_sheet_idx, destination, &view);
    update_pivot_region(&state, pivot_id, dest_sheet_idx, destination, &view);

    Ok(response)
}

/// Removes a field from a hierarchy.
#[tauri::command]
pub fn remove_pivot_hierarchy(
    state: State<AppState>,
    pivot_state: State<'_, PivotState>,
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
    let response = view_to_response(&view, definition, cache);

    let destination = definition.destination;
    let pivot_id = definition.id;
    let dest_sheet_idx = resolve_dest_sheet_index(&state, definition);

    drop(pivot_tables);

    update_pivot_in_grid(&state, pivot_id, dest_sheet_idx, destination, &view);
    update_pivot_region(&state, pivot_id, dest_sheet_idx, destination, &view);

    Ok(response)
}

/// Moves a field between hierarchies.
#[tauri::command]
pub fn move_pivot_field(
    state: State<AppState>,
    pivot_state: State<'_, PivotState>,
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
    let response = view_to_response(&view, definition, cache);

    let destination = definition.destination;
    let pivot_id = definition.id;
    let dest_sheet_idx = resolve_dest_sheet_index(&state, definition);

    drop(pivot_tables);

    update_pivot_in_grid(&state, pivot_id, dest_sheet_idx, destination, &view);
    update_pivot_region(&state, pivot_id, dest_sheet_idx, destination, &view);

    Ok(response)
}

/// Sets the aggregation function for a value field.
#[tauri::command]
pub fn set_pivot_aggregation(
    state: State<AppState>,
    pivot_state: State<'_, PivotState>,
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
    let response = view_to_response(&view, definition, cache);

    let destination = definition.destination;
    let pivot_id = definition.id;
    let dest_sheet_idx = resolve_dest_sheet_index(&state, definition);

    drop(pivot_tables);

    update_pivot_in_grid(&state, pivot_id, dest_sheet_idx, destination, &view);
    update_pivot_region(&state, pivot_id, dest_sheet_idx, destination, &view);

    Ok(response)
}

/// Sets the number format for a value field.
#[tauri::command]
pub fn set_pivot_number_format(
    state: State<AppState>,
    pivot_state: State<'_, PivotState>,
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
    let response = view_to_response(&view, definition, cache);

    let destination = definition.destination;
    let pivot_id = definition.id;
    let dest_sheet_idx = resolve_dest_sheet_index(&state, definition);

    drop(pivot_tables);

    update_pivot_in_grid(&state, pivot_id, dest_sheet_idx, destination, &view);
    update_pivot_region(&state, pivot_id, dest_sheet_idx, destination, &view);

    Ok(response)
}

/// Applies a filter to a pivot field.
#[tauri::command]
pub fn apply_pivot_filter(
    state: State<AppState>,
    pivot_state: State<'_, PivotState>,
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
    let response = view_to_response(&view, definition, cache);

    let destination = definition.destination;
    let pivot_id = definition.id;
    let dest_sheet_idx = resolve_dest_sheet_index(&state, definition);

    drop(pivot_tables);

    update_pivot_in_grid(&state, pivot_id, dest_sheet_idx, destination, &view);
    update_pivot_region(&state, pivot_id, dest_sheet_idx, destination, &view);

    Ok(response)
}

/// Clears filters from a pivot field.
#[tauri::command]
pub fn clear_pivot_filter(
    state: State<AppState>,
    pivot_state: State<'_, PivotState>,
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
    let response = view_to_response(&view, definition, cache);

    let destination = definition.destination;
    let pivot_id = definition.id;
    let dest_sheet_idx = resolve_dest_sheet_index(&state, definition);

    drop(pivot_tables);

    update_pivot_in_grid(&state, pivot_id, dest_sheet_idx, destination, &view);
    update_pivot_region(&state, pivot_id, dest_sheet_idx, destination, &view);

    Ok(response)
}

/// Sorts a pivot field by labels.
#[tauri::command]
pub fn sort_pivot_field(
    state: State<AppState>,
    pivot_state: State<'_, PivotState>,
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
    let response = view_to_response(&view, definition, cache);

    let destination = definition.destination;
    let pivot_id = definition.id;
    let dest_sheet_idx = resolve_dest_sheet_index(&state, definition);

    drop(pivot_tables);

    update_pivot_in_grid(&state, pivot_id, dest_sheet_idx, destination, &view);
    update_pivot_region(&state, pivot_id, dest_sheet_idx, destination, &view);

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
    let response = view_to_response(&view, definition, cache);

    let destination = definition.destination;
    let pivot_id = definition.id;
    let dest_sheet_idx = resolve_dest_sheet_index(&state, definition);

    drop(pivot_tables);

    update_pivot_in_grid(&state, pivot_id, dest_sheet_idx, destination, &view);
    update_pivot_region(&state, pivot_id, dest_sheet_idx, destination, &view);

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

/// Sets the expand/collapse state of a specific pivot item.
#[tauri::command]
pub fn set_pivot_item_expanded(
    state: State<AppState>,
    pivot_state: State<'_, PivotState>,
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
    let response = view_to_response(&view, definition, cache);

    let destination = definition.destination;
    let pivot_id = definition.id;
    let dest_sheet_idx = resolve_dest_sheet_index(&state, definition);

    drop(pivot_tables);

    update_pivot_in_grid(&state, pivot_id, dest_sheet_idx, destination, &view);
    update_pivot_region(&state, pivot_id, dest_sheet_idx, destination, &view);

    Ok(response)
}

/// Expands or collapses all items at a specific field level.
#[tauri::command]
pub fn expand_collapse_level(
    state: State<AppState>,
    pivot_state: State<'_, PivotState>,
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
    let response = view_to_response(&view, definition, cache);

    let destination = definition.destination;
    let pivot_id = definition.id;
    let dest_sheet_idx = resolve_dest_sheet_index(&state, definition);

    drop(pivot_tables);

    update_pivot_in_grid(&state, pivot_id, dest_sheet_idx, destination, &view);
    update_pivot_region(&state, pivot_id, dest_sheet_idx, destination, &view);

    Ok(response)
}

/// Expands or collapses ALL fields in the entire pivot table.
#[tauri::command]
pub fn expand_collapse_all(
    state: State<AppState>,
    pivot_state: State<'_, PivotState>,
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
    let response = view_to_response(&view, definition, cache);

    let destination = definition.destination;
    let pivot_id = definition.id;
    let dest_sheet_idx = resolve_dest_sheet_index(&state, definition);

    drop(pivot_tables);

    update_pivot_in_grid(&state, pivot_id, dest_sheet_idx, destination, &view);
    update_pivot_region(&state, pivot_id, dest_sheet_idx, destination, &view);

    Ok(response)
}

/// Refreshes all pivot tables in the workbook.
#[tauri::command]
pub async fn refresh_all_pivot_tables(
    window: tauri::Window,
    state: State<'_, AppState>,
    pivot_state: State<'_, PivotState>,
) -> Result<Vec<PivotViewResponse>, String> {
    log_info!("PIVOT", "refresh_all_pivot_tables");

    let pivot_ids: Vec<PivotId> = {
        let pivot_tables = pivot_state.pivot_tables.lock().unwrap();
        pivot_tables.keys().cloned().collect()
    };

    let mut responses = Vec::new();
    for pivot_id in pivot_ids {
        match refresh_pivot_cache(window.clone(), state.clone(), pivot_state.clone(), pivot_id).await {
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
    let response = view_to_response(&view, definition, cache);

    let destination = definition.destination;
    let pivot_id = definition.id;
    let dest_sheet_idx = resolve_dest_sheet_index(&state, definition);

    drop(pivot_tables);

    update_pivot_in_grid(&state, pivot_id, dest_sheet_idx, destination, &view);
    update_pivot_region(&state, pivot_id, dest_sheet_idx, destination, &view);

    Ok(response)
}

/// Creates a manual group on a pivot field (adds items to a named group).
#[tauri::command]
pub fn create_manual_group(
    state: State<AppState>,
    pivot_state: State<'_, PivotState>,
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
    let response = view_to_response(&view, definition, cache);

    let destination = definition.destination;
    let pivot_id = definition.id;
    let dest_sheet_idx = resolve_dest_sheet_index(&state, definition);

    drop(pivot_tables);

    update_pivot_in_grid(&state, pivot_id, dest_sheet_idx, destination, &view);
    update_pivot_region(&state, pivot_id, dest_sheet_idx, destination, &view);

    Ok(response)
}

/// Removes all grouping from a pivot field.
#[tauri::command]
pub fn ungroup_pivot_field(
    state: State<AppState>,
    pivot_state: State<'_, PivotState>,
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
    let response = view_to_response(&view, definition, cache);

    let destination = definition.destination;
    let pivot_id = definition.id;
    let dest_sheet_idx = resolve_dest_sheet_index(&state, definition);

    drop(pivot_tables);

    update_pivot_in_grid(&state, pivot_id, dest_sheet_idx, destination, &view);
    update_pivot_region(&state, pivot_id, dest_sheet_idx, destination, &view);

    Ok(response)
}

/// Performs a drill-through: creates a new sheet with the matching source data rows.
#[tauri::command]
pub fn drill_through_to_sheet(
    state: State<AppState>,
    pivot_state: State<'_, PivotState>,
    request: DrillThroughRequest,
) -> Result<DrillThroughResponse, String> {
    log_info!(
        "PIVOT",
        "drill_through_to_sheet pivot_id={} path_len={}",
        request.pivot_id,
        request.group_path.len()
    );

    let pivot_tables = pivot_state.pivot_tables.lock().unwrap();
    let (definition, cache) = pivot_tables
        .get(&request.pivot_id)
        .ok_or_else(|| format!("Pivot table {} not found", request.pivot_id))?;

    let max = request.max_records.unwrap_or(10000);
    let result = drill_down(definition, cache, &request.group_path, max);

    // Gather header names and source data
    let headers: Vec<String> = cache.fields.iter().map(|f| f.name.clone()).collect();
    let col_count = headers.len();

    // Read source row data from the grid
    let grids = state.grids.lock().unwrap();
    let source_sheet_idx = 0;
    let grid = grids
        .get(source_sheet_idx)
        .ok_or_else(|| "Source sheet not found".to_string())?;

    let (start_row, start_col) = definition.source_start;
    let data_start = if definition.source_has_headers {
        start_row + 1
    } else {
        start_row
    };

    // Build row data as CellValues
    let mut row_data: Vec<Vec<engine::CellValue>> = Vec::with_capacity(result.source_rows.len());
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

    let data_row_count = row_data.len();

    drop(grids);
    drop(pivot_tables);

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
            new_grid.set_cell((r + 1) as u32, c as u32, engine::Cell { formula: None, value: cv.clone(), style_index: 0, rich_text: None, cached_ast: None });
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

// ============================================================================
// BI PIVOT COMMANDS
// ============================================================================

/// Extracts model metadata (tables + measures) from a BI engine.
fn extract_bi_model_metadata(
    engine: &bi_engine::Engine,
) -> (Vec<BiModelTableMeta>, Vec<MeasureFieldInfo>) {
    let model = engine.model();

    let tables: Vec<BiModelTableMeta> = model
        .tables()
        .iter()
        .map(|t| {
            let columns = t
                .columns()
                .iter()
                .map(|c| {
                    let dt = c.data_type();
                    let is_numeric = matches!(
                        dt,
                        bi_engine::DataType::Int32
                            | bi_engine::DataType::Int64
                            | bi_engine::DataType::Float64
                            | bi_engine::DataType::Decimal(_, _)
                    );
                    BiModelColumnMeta {
                        name: c.name().to_string(),
                        data_type: format!("{:?}", dt),
                        is_numeric,
                        lookup_resolution: c.lookup_resolution().map(|s| s.to_string()),
                    }
                })
                .collect();
            BiModelTableMeta {
                name: t.name().to_string(),
                columns,
            }
        })
        .collect();

    let measures: Vec<MeasureFieldInfo> = model
        .measures()
        .iter()
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

    (tables, measures)
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

    // Auto-connect the connection
    auto_connect_bi_connection(&bi_state, connection_id).await?;

    // Extract model metadata from the connection's engine
    let (model_tables, measures) = {
        let connections = bi_state.connections.lock().unwrap();
        let conn = connections.get(&connection_id)
            .ok_or_else(|| format!("Connection {} not found", connection_id))?;
        let engine = conn.engine.as_ref().ok_or("No BI model loaded.")?;
        let result = extract_bi_model_metadata(engine);
        log_info!(
            "PIVOT",
            "extract_bi_model_metadata: {} tables, {} measures",
            result.0.len(),
            result.1.len()
        );
        for t in &result.0 {
            log_info!("PIVOT", "  table: {} ({} columns)", t.name, t.columns.len());
        }
        for m in &result.1 {
            log_info!("PIVOT", "  measure: {} (table={})", m.name, m.table);
        }
        result
    };

    // Auto-bind all model tables
    let table_names: Vec<&str> = model_tables.iter().map(|t| t.name.as_str()).collect();
    auto_bind_tables_on_connection(&bi_state, connection_id, &table_names)?;

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

    // Generate pivot ID
    let mut next_id = pivot_state.next_pivot_id.lock().unwrap();
    let pivot_id = *next_id;
    *next_id += 1;
    drop(next_id);

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
        model_tables,
        measures,
        last_query: None,
        lookup_columns: std::collections::HashSet::new(),
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
    bi_state: State<'_, BiState>,
    request: UpdateBiPivotFieldsRequest,
) -> Result<PivotViewResponse, String> {
    let t_total = Instant::now();
    log_info!("PIVOT", "update_bi_pivot_fields pivot_id={}", request.pivot_id);

    let pivot_id = request.pivot_id;

    // Verify pivot exists and is BI-backed
    {
        let bi_meta = pivot_state.bi_metadata.lock().unwrap();
        if !bi_meta.contains_key(&pivot_id) {
            return Err(format!("Pivot {} is not a BI-backed pivot", pivot_id));
        }
    }

    // Save previous state for revert-on-cancel
    {
        let pivot_tables = pivot_state.pivot_tables.lock().unwrap();
        if let Some((def, cache)) = pivot_tables.get(&pivot_id) {
            pivot_state.previous_states.lock().unwrap()
                .insert(pivot_id, (def.clone(), cache.clone()));
        }
    }

    let has_values = !request.value_fields.is_empty();
    let has_dimensions = !request.row_fields.is_empty() || !request.column_fields.is_empty();
    let has_filters = !request.filter_fields.is_empty();

    // If no fields at all, clear to empty pivot
    if !has_values && !has_dimensions && !has_filters {
        log_info!("PIVOT", "No fields assigned, clearing to empty pivot");
        let mut pivot_tables = pivot_state.pivot_tables.lock().unwrap();
        let (definition, _cache) = pivot_tables
            .get_mut(&pivot_id)
            .ok_or_else(|| format!("Pivot {} not found", pivot_id))?;

        definition.row_fields.clear();
        definition.column_fields.clear();
        definition.value_fields.clear();
        definition.filter_fields.clear();
        definition.bump_version();

        let empty_cache = PivotCache::new(pivot_id, 0);
        let view = create_empty_view(pivot_id, definition.version);
        let response = view_to_response(&view, definition, &mut empty_cache.clone());

        let destination = definition.destination;
        let dest_sheet_idx = resolve_dest_sheet_index(&state, definition);
        drop(pivot_tables);

        // Replace cache with empty
        let mut pt = pivot_state.pivot_tables.lock().unwrap();
        if let Some((_, cache)) = pt.get_mut(&pivot_id) {
            *cache = empty_cache;
        }
        drop(pt);

        update_pivot_in_grid(&state, pivot_id, dest_sheet_idx, destination, &view);
        update_pivot_region(&state, pivot_id, dest_sheet_idx, destination, &view);
        return Ok(response);
    }

    // When there are dimensions/filters but no user-selected measures, inject a
    // synthetic measure so the BI engine query succeeds (it requires >= 1 measure).
    // The synthetic measure column will be present in the cache but NOT mapped to
    // any value_field in the pivot definition, so the engine renders blank data cells
    // — matching Excel's behaviour of showing distinct dimension values without aggregates.
    let synthetic_measure: Option<String> = if !has_values && (has_dimensions || has_filters) {
        let bi_meta = pivot_state.bi_metadata.lock().unwrap();
        bi_meta.get(&pivot_id)
            .and_then(|m| m.measures.first())
            .map(|m| m.name.clone())
    } else {
        None
    };

    // If we need a synthetic measure but the model has none, we can't query the
    // BI engine. Save the field assignments to the definition (so they persist
    // across deselect/reselect) and show an empty pivot.
    if !has_values && synthetic_measure.is_none() && (has_dimensions || has_filters) {
        log_info!("PIVOT", "No measures in model for synthetic query, saving fields only");
        let mut pivot_tables = pivot_state.pivot_tables.lock().unwrap();
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
        let response = view_to_response(&view, definition, &mut empty_cache.clone());
        let destination = definition.destination;
        let dest_sheet_idx = resolve_dest_sheet_index(&state, definition);
        *stored_cache = empty_cache;
        drop(pivot_tables);

        update_pivot_in_grid(&state, pivot_id, dest_sheet_idx, destination, &view);
        update_pivot_region(&state, pivot_id, dest_sheet_idx, destination, &view);
        return Ok(response);
    }

    // Get the connection_id from BI metadata
    let connection_id = {
        let bi_meta = pivot_state.bi_metadata.lock().unwrap();
        bi_meta.get(&pivot_id)
            .map(|m| m.connection_id)
            .ok_or_else(|| format!("No BI metadata for pivot {}", pivot_id))?
    };

    // Auto-connect if needed
    auto_connect_bi_connection(&bi_state, connection_id).await?;

    // Collect table names referenced in fields for auto-binding
    let mut referenced_tables: Vec<String> = Vec::new();
    for f in request.row_fields.iter().chain(request.column_fields.iter()).chain(request.filter_fields.iter()) {
        if !referenced_tables.contains(&f.table) {
            referenced_tables.push(f.table.clone());
        }
    }
    let table_refs: Vec<&str> = referenced_tables.iter().map(|s| s.as_str()).collect();
    auto_bind_tables_on_connection(&bi_state, connection_id, &table_refs)?;

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

    // Build BI engine QueryRequest
    // If no user measures but we have a synthetic one, include it in the query
    // so the BI engine gets a valid request. The synthetic measure column will
    // be in the cache but ignored (no value_field maps to it).
    let query_measures: Vec<String> = if let Some(ref syn) = synthetic_measure {
        vec![syn.clone()]
    } else {
        request.value_fields.iter().map(|v| v.measure_name.clone()).collect()
    };
    let query_group_by: Vec<bi_engine::ColumnRef> = row_group_fields
        .iter()
        .chain(col_group_fields.iter())
        .chain(filter_group_fields.iter())
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

    let query_request = bi_engine::QueryRequest {
        measures: query_measures.clone(),
        group_by: query_group_by,
        filters: vec![],
        lookups: query_lookups,
    };

    log_info!(
        "PIVOT",
        "BI query: measures={:?}, group_by={} dims, lookups={} cols",
        query_measures,
        row_group_fields.len() + col_group_fields.len(),
        row_lookup_fields.len() + col_lookup_fields.len()
    );

    // SAFE ENGINE TAKE: take engine out of connection, drop guard, query, put back
    let t_query = Instant::now();
    let mut engine = {
        let mut connections = bi_state.connections.lock().unwrap();
        let conn = connections.get_mut(&connection_id)
            .ok_or_else(|| format!("Connection {} not found", connection_id))?;
        conn.engine.take().ok_or("No BI model loaded.")?
    };
    // Guard is dropped here — safe to await

    // Auto-refresh in-memory tables that haven't been cached yet.
    // Multi-table queries go through LocalAggregation which reads from the
    // in-memory cache — tables must be refreshed at least once before querying.
    // `needs_refresh(..., Duration::ZERO)` returns true only if the table has
    // NEVER been refreshed, so this is a one-time cost per table per session.
    {
        // Collect all tables referenced by the query (dimensions + measure tables)
        let tables_to_refresh: Vec<String> = {
            let mut tables = referenced_tables.clone();
            let bi_meta = pivot_state.bi_metadata.lock().unwrap();
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

    let query_result = engine.query(query_request).await;
    // PUT BACK before propagating error
    {
        let mut connections = bi_state.connections.lock().unwrap();
        if let Some(conn) = connections.get_mut(&connection_id) {
            conn.engine = Some(engine);
        }
    }
    let batches = match query_result {
        Ok(b) => b,
        Err(e) => {
            // If the query failed and we were using a synthetic measure,
            // save the field assignments anyway so they persist, then return
            // an empty view.
            if synthetic_measure.is_some() {
                log_info!("PIVOT", "Synthetic measure query failed ({}), saving fields only", e);
                let mut pivot_tables = pivot_state.pivot_tables.lock().unwrap();
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
                let response = view_to_response(&view, definition, &mut empty_cache.clone());
                let destination = definition.destination;
                let dest_sheet_idx = resolve_dest_sheet_index(&state, definition);
                *stored_cache = empty_cache;
                drop(pivot_tables);

                update_pivot_in_grid(&state, pivot_id, dest_sheet_idx, destination, &view);
                update_pivot_region(&state, pivot_id, dest_sheet_idx, destination, &view);
                return Ok(response);
            }
            return Err(format!("BI query failed: {}", e));
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
    // [group_by columns (row groups, col groups, filter groups)] [measure columns] [lookup columns]
    // If synthetic dim: [synthetic at 0] [everything shifted by 1]
    let num_group_by = row_group_fields.len() + col_group_fields.len() + filter_group_fields.len();
    let dim_offset: usize = if use_synthetic_dim { 1 } else { 0 };

    // Build a mapping from (table, column) -> cache column index.
    // BI engine result column order: [GROUP BY cols] [Measure cols] [Lookup cols]
    // num_measures reflects actual query columns (includes synthetic if present)
    let num_measures = if synthetic_measure.is_some() { 1 } else { request.value_fields.len() };
    let mut field_to_cache_idx: std::collections::HashMap<(String, String), usize> =
        std::collections::HashMap::new();

    // Group-by cols come first: row groups, then col groups, then filter groups
    let mut cache_idx = dim_offset;
    for f in row_group_fields.iter().chain(col_group_fields.iter()).chain(filter_group_fields.iter()) {
        field_to_cache_idx.insert((f.table.clone(), f.column.clone()), cache_idx);
        cache_idx += 1;
    }
    // Measures come next (after group_by, before lookups)
    let measure_start = num_group_by + dim_offset;
    // Lookup cols come last (after measures)
    let lookup_start = num_group_by + num_measures + dim_offset;
    cache_idx = lookup_start;
    for f in row_lookup_fields.iter().chain(col_lookup_fields.iter()) {
        field_to_cache_idx.insert((f.table.clone(), f.column.clone()), cache_idx);
        cache_idx += 1;
    }

    let mut pivot_tables = pivot_state.pivot_tables.lock().unwrap();
    let (definition, stored_cache) = pivot_tables
        .get_mut(&pivot_id)
        .ok_or_else(|| format!("Pivot {} not found", pivot_id))?;

    // Row fields (preserving collapse state for fields that remain)
    // Lookup fields share the same hierarchy depth as the preceding GROUP field
    // from the same table (they are attributes, not new grouping levels).
    let old_row_fields = definition.row_fields.clone();
    if use_synthetic_dim {
        // Synthetic "Total" dimension as the only row field
        definition.row_fields = vec![PivotField::new(0, "Total".to_string())];
    } else {
        definition.row_fields = request
            .row_fields
            .iter()
            .map(|f| {
                let idx = *field_to_cache_idx
                    .get(&(f.table.clone(), f.column.clone()))
                    .unwrap_or(&0);
                let name = format!("{}.{}", f.table, f.column);
                if f.is_lookup {
                    PivotField::new_attribute(idx, name)
                } else {
                    PivotField::new(idx, name)
                }
            })
            .collect();
    }
    preserve_collapse_state(&mut definition.row_fields, &old_row_fields);

    // Column fields (preserving collapse state for fields that remain)
    let old_col_fields = definition.column_fields.clone();
    definition.column_fields = request
        .column_fields
        .iter()
        .map(|f| {
            let idx = *field_to_cache_idx
                .get(&(f.table.clone(), f.column.clone()))
                    .unwrap_or(&0);
            let name = format!("{}.{}", f.table, f.column);
            if f.is_lookup {
                PivotField::new_attribute(idx, name)
            } else {
                PivotField::new(idx, name)
            }
        })
        .collect();
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
        definition.value_fields = request
            .value_fields
            .iter()
            .enumerate()
            .map(|(i, v)| {
                ValueField::new(
                    measure_start + i,
                    format!("[{}]", v.measure_name),
                    AggregationType::Sum, // SUM of pre-aggregated = identity
                )
            })
            .collect();
    }

    // Filter fields — same as row/column fields, map BiFieldRef to PivotFilter
    let old_filter_fields = definition.filter_fields.clone();
    definition.filter_fields = request
        .filter_fields
        .iter()
        .map(|f| {
            let idx = *field_to_cache_idx
                .get(&(f.table.clone(), f.column.clone()))
                .unwrap_or(&0);
            let name = format!("{}.{}", f.table, f.column);
            let field = if f.is_lookup {
                PivotField::new_attribute(idx, name)
            } else {
                PivotField::new(idx, name)
            };
            // Preserve hidden_items from the old filter field (if same source_index)
            let mut filter = pivot_engine::PivotFilter {
                field,
                condition: pivot_engine::FilterCondition::ValueList(Vec::new()),
            };
            if let Some(old) = old_filter_fields.iter().find(|of| of.field.source_index == idx) {
                filter.field.hidden_items = old.field.hidden_items.clone();
            }
            filter
        })
        .collect();

    // Apply layout
    if let Some(ref layout_config) = request.layout {
        apply_layout_config(&mut definition.layout, layout_config);
    }

    definition.bump_version();

    // Calculate pivot view
    let t_calc = Instant::now();
    *stored_cache = cache;
    let view = safe_calculate_pivot(definition, stored_cache);
    store_view(&pivot_state, pivot_id, &view);
    let calc_ms = t_calc.elapsed().as_secs_f64() * 1000.0;

    let t_resp = Instant::now();
    let response = view_to_response(&view, definition, stored_cache);
    let resp_ms = t_resp.elapsed().as_secs_f64() * 1000.0;
    let destination = definition.destination;
    let auto_fit = definition.layout.auto_fit_column_widths;
    let dest_sheet_idx = resolve_dest_sheet_index(&state, definition);
    drop(pivot_tables);

    // Update grid (clear old region + write new)
    let t_grid = Instant::now();
    update_pivot_in_grid(&state, pivot_id, dest_sheet_idx, destination, &view);
    if auto_fit {
        auto_fit_pivot_columns(&state, destination, &view);
    }
    update_pivot_region(&state, pivot_id, dest_sheet_idx, destination, &view);
    let grid_ms = t_grid.elapsed().as_secs_f64() * 1000.0;

    // Store last query + lookup column set in bi_metadata
    {
        let mut bi_meta = pivot_state.bi_metadata.lock().unwrap();
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
    let response = view_to_response(&view, definition, cache);

    let destination = definition.destination;
    let pivot_id = definition.id;
    let dest_sheet_idx = resolve_dest_sheet_index(&state, definition);

    drop(pivot_tables);

    update_pivot_in_grid(&state, pivot_id, dest_sheet_idx, destination, &view);
    update_pivot_region(&state, pivot_id, dest_sheet_idx, destination, &view);

    Ok(response)
}

/// Updates an existing calculated field.
#[tauri::command]
pub fn update_calculated_field(
    state: State<AppState>,
    pivot_state: State<'_, PivotState>,
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
    let response = view_to_response(&view, definition, cache);

    let destination = definition.destination;
    let pivot_id = definition.id;
    let dest_sheet_idx = resolve_dest_sheet_index(&state, definition);

    drop(pivot_tables);

    update_pivot_in_grid(&state, pivot_id, dest_sheet_idx, destination, &view);
    update_pivot_region(&state, pivot_id, dest_sheet_idx, destination, &view);

    Ok(response)
}

/// Removes a calculated field from a pivot table.
#[tauri::command]
pub fn remove_calculated_field(
    state: State<AppState>,
    pivot_state: State<'_, PivotState>,
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
    let response = view_to_response(&view, definition, cache);

    let destination = definition.destination;
    let pivot_id = definition.id;
    let dest_sheet_idx = resolve_dest_sheet_index(&state, definition);

    drop(pivot_tables);

    update_pivot_in_grid(&state, pivot_id, dest_sheet_idx, destination, &view);
    update_pivot_region(&state, pivot_id, dest_sheet_idx, destination, &view);

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
    let response = view_to_response(&view, definition, cache);

    let destination = definition.destination;
    let pivot_id = definition.id;
    let dest_sheet_idx = resolve_dest_sheet_index(&state, definition);

    drop(pivot_tables);

    update_pivot_in_grid(&state, pivot_id, dest_sheet_idx, destination, &view);
    update_pivot_region(&state, pivot_id, dest_sheet_idx, destination, &view);

    Ok(response)
}

/// Removes a calculated item from a pivot table.
#[tauri::command]
pub fn remove_calculated_item(
    state: State<AppState>,
    pivot_state: State<'_, PivotState>,
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
    let response = view_to_response(&view, definition, cache);

    let destination = definition.destination;
    let pivot_id = definition.id;
    let dest_sheet_idx = resolve_dest_sheet_index(&state, definition);

    drop(pivot_tables);

    update_pivot_in_grid(&state, pivot_id, dest_sheet_idx, destination, &view);
    update_pivot_region(&state, pivot_id, dest_sheet_idx, destination, &view);

    Ok(response)
}