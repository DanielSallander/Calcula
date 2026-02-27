//! FILENAME: app/src-tauri/src/pivot/commands.rs
//! PURPOSE: Tauri commands for Pivot Table operations.
//! CONTEXT: Excel-compatible Pivot Table API implementation.

use crate::pivot::operations::*;
use crate::pivot::types::*;
use crate::pivot::utils::*;
use crate::{log_debug, log_info, log_perf, AppState};
use crate::pivot::types::PivotState;
use pivot_engine::{drill_down, CacheValue, PivotDefinition, PivotId, VALUE_ID_EMPTY};
use crate::sheets::FreezeConfig;
use std::time::Instant;
use tauri::State;

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
    let (source_start, source_end) = parse_range(&request.source_range)?;
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
            write_pivot_to_grid(dest_grid, &view, destination, &mut styles);
            log_info!(
                "PIVOT",
                "wrote pivot output to grids[{}] at ({},{}) size {}x{}",
                dest_sheet_idx,
                destination.0,
                destination.1,
                view.row_count,
                view.col_count
            );
            
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

/// Updates the field configuration of an existing pivot table
#[tauri::command]
pub fn update_pivot_fields(
    state: State<AppState>,
    pivot_state: State<'_, PivotState>,
    request: UpdatePivotFieldsRequest,
) -> Result<PivotViewResponse, String> {
    log_info!("PIVOT", "update_pivot_fields pivot_id={}", request.pivot_id);

    let mut pivot_tables = pivot_state.pivot_tables.lock().unwrap();
    let (definition, cache) = pivot_tables
        .get_mut(&request.pivot_id)
        .ok_or_else(|| format!("Pivot table {} not found", request.pivot_id))?;

    // Update row fields
    if let Some(ref row_configs) = request.row_fields {
        definition.row_fields = row_configs
            .iter()
            .map(config_to_pivot_field)
            .collect();
    }

    // Update column fields
    if let Some(ref col_configs) = request.column_fields {
        definition.column_fields = col_configs
            .iter()
            .map(config_to_pivot_field)
            .collect();
    }

    // Update value fields
    if let Some(ref value_configs) = request.value_fields {
        definition.value_fields = value_configs
            .iter()
            .map(config_to_value_field)
            .collect();
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

    let t_total = Instant::now();

    // Recalculate view
    let t0 = Instant::now();
    let view = safe_calculate_pivot(definition, cache);
    let calc_ms = t0.elapsed().as_secs_f64() * 1000.0;

    let t1 = Instant::now();
    let response = view_to_response(&view, definition, cache);
    let serialize_ms = t1.elapsed().as_secs_f64() * 1000.0;

    // Get destination info before dropping pivot_tables lock
    let destination = definition.destination;
    let pivot_id = definition.id;

    // Resolve destination sheet index from definition
    let dest_sheet_idx = resolve_dest_sheet_index(&state, definition);

    drop(pivot_tables);

    // Update pivot in grid (clears old region, writes new view)
    let t2 = Instant::now();
    update_pivot_in_grid(&state, pivot_id, dest_sheet_idx, destination, &view);
    let grid_write_ms = t2.elapsed().as_secs_f64() * 1000.0;

    // Update pivot region tracking
    let t3 = Instant::now();
    update_pivot_region(&state, pivot_id, dest_sheet_idx, destination, &view);
    let region_ms = t3.elapsed().as_secs_f64() * 1000.0;

    let total_ms = t_total.elapsed().as_secs_f64() * 1000.0;

    log_perf!(
        "PIVOT",
        "update_pivot_fields pivot_id={} rows={}x{} | calc={:.1}ms serialize={:.1}ms grid_write={:.1}ms region={:.1}ms TOTAL={:.1}ms",
        request.pivot_id,
        response.row_count,
        response.col_count,
        calc_ms,
        serialize_ms,
        grid_write_ms,
        region_ms,
        total_ms
    );

    Ok(response)
}

/// Toggles the expand/collapse state of a pivot group
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

    let mut pivot_tables = pivot_state.pivot_tables.lock().unwrap();
    let (definition, cache) = pivot_tables
        .get_mut(&request.pivot_id)
        .ok_or_else(|| format!("Pivot table {} not found", request.pivot_id))?;

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
        // Path-specific toggle: use the full group path as key so that
        // e.g. "Female under Gothenburg" is independent of "Female under Stockholm".
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
        // Keep field.collapsed unchanged: collapsed_items acts as an
        // exception list relative to the field-level state.

        log_debug!(
            "PIVOT",
            "toggled path '{}' in field {} collapsed={} (collapsed_items count={})",
            path_key,
            field.name,
            field.collapsed,
            field.collapsed_items.len()
        );
    } else if let Some(ref item_name) = request.value {
        // Legacy per-item toggle: toggle a specific item in collapsed_items
        if field.collapsed_items.contains(item_name) {
            field.collapsed_items.retain(|s| s != item_name);
        } else {
            field.collapsed_items.push(item_name.clone());
        }
        // Keep field.collapsed unchanged: collapsed_items acts as an
        // exception list relative to the field-level state.

        log_debug!(
            "PIVOT",
            "toggled item '{}' in field {} (collapsed_items count={})",
            item_name,
            field.name,
            field.collapsed_items.len()
        );
    } else {
        // Field-level toggle: toggle all items, clear per-item overrides
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

    let t_total = Instant::now();

    // Recalculate view
    let t0 = Instant::now();
    let view = safe_calculate_pivot(definition, cache);
    let calc_ms = t0.elapsed().as_secs_f64() * 1000.0;

    let t1 = Instant::now();
    let response = view_to_response(&view, definition, cache);
    let serialize_ms = t1.elapsed().as_secs_f64() * 1000.0;

    // Get destination info
    let destination = definition.destination;
    let pivot_id = definition.id;

    // Resolve destination sheet index from definition
    let dest_sheet_idx = resolve_dest_sheet_index(&state, definition);

    drop(pivot_tables);

    // Update pivot in grid (clears old region, writes new view)
    let t2 = Instant::now();
    update_pivot_in_grid(&state, pivot_id, dest_sheet_idx, destination, &view);
    let grid_write_ms = t2.elapsed().as_secs_f64() * 1000.0;

    // Update pivot region tracking
    update_pivot_region(&state, pivot_id, dest_sheet_idx, destination, &view);

    let total_ms = t_total.elapsed().as_secs_f64() * 1000.0;

    log_perf!(
        "PIVOT",
        "toggle_pivot_group pivot_id={} rows={}x{} | calc={:.1}ms serialize={:.1}ms grid_write={:.1}ms TOTAL={:.1}ms",
        request.pivot_id,
        response.row_count,
        response.col_count,
        calc_ms,
        serialize_ms,
        grid_write_ms,
        total_ms
    );

    Ok(response)
}

/// Gets the current view of a pivot table
#[tauri::command]
pub fn get_pivot_view(
    state: State<AppState>,
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
pub fn refresh_pivot_cache(
    state: State<AppState>,
    pivot_state: State<'_, PivotState>,
    pivot_id: PivotId,
) -> Result<PivotViewResponse, String> {
    log_info!("PIVOT", "refresh_pivot_cache pivot_id={}", pivot_id);

    // First, get the definition to know the source range
    let pivot_tables = pivot_state.pivot_tables.lock().unwrap();
    let (definition, _) = pivot_tables
        .get(&pivot_id)
        .ok_or_else(|| format!("Pivot table {} not found", pivot_id))?;

    let source_start = definition.source_start;
    let source_end = definition.source_end;
    let has_headers = definition.source_has_headers;
    let destination = definition.destination;
    
    // Resolve destination sheet index from definition
    let dest_sheet_idx = resolve_dest_sheet_index(&state, definition);
    
    drop(pivot_tables);

    // Get fresh data from grid
    let grids = state.grids.lock().unwrap();
    let source_sheet_idx = 0; // TODO: resolve from definition.source_sheet
    let grid = grids
        .get(source_sheet_idx)
        .ok_or_else(|| "Source sheet not found".to_string())?;

    let (new_cache, _headers) = build_cache_from_grid(grid, source_start, source_end, has_headers)?;
    drop(grids);

    // Update the stored cache
    let mut pivot_tables = pivot_state.pivot_tables.lock().unwrap();
    let (definition, cache) = pivot_tables
        .get_mut(&pivot_id)
        .ok_or_else(|| format!("Pivot table {} not found", pivot_id))?;

    *cache = new_cache;
    definition.bump_version();

    let view = safe_calculate_pivot(definition, cache);
    let response = view_to_response(&view, definition, cache);
    
    drop(pivot_tables);
    
    // Update pivot in grid (clears old region, writes new view)
    update_pivot_in_grid(&state, pivot_id, dest_sheet_idx, destination, &view);
    
    // Update pivot region tracking
    update_pivot_region(&state, pivot_id, dest_sheet_idx, destination, &view);

    log_info!(
        "PIVOT",
        "refreshed pivot_id={} version={} rows={}",
        pivot_id,
        response.version,
        response.row_count
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
        }
    }).collect();
    
    let column_fields: Vec<ZoneFieldInfo> = definition.column_fields.iter().map(|f| {
        let is_numeric = cache.is_numeric_field(f.source_index);
        ZoneFieldInfo {
            source_index: f.source_index,
            name: f.name.clone(),
            is_numeric,
            aggregation: None,
        }
    }).collect();
    
    let value_fields: Vec<ZoneFieldInfo> = definition.value_fields.iter().map(|f| {
        let is_numeric = cache.is_numeric_field(f.source_index);
        ZoneFieldInfo {
            source_index: f.source_index,
            name: f.name.clone(),
            is_numeric,
            aggregation: Some(aggregation_to_string(f.aggregation)),
        }
    }).collect();
    
    let filter_fields: Vec<ZoneFieldInfo> = definition.filter_fields.iter().map(|f| {
        let is_numeric = cache.is_numeric_field(f.field.source_index);
        ZoneFieldInfo {
            source_index: f.field.source_index,
            name: f.field.name.clone(),
            is_numeric,
            aggregation: None,
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

    Ok(Some(PivotRegionInfo {
        pivot_id,
        is_empty,
        source_fields,
        field_configuration,
        filter_zones,
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
    state: State<AppState>,
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
    state: State<AppState>,
    pivot_state: State<'_, PivotState>,
    pivot_id: PivotId,
) -> Result<PivotTableInfo, String> {
    log_debug!("PIVOT", "get_pivot_table_info pivot_id={}", pivot_id);

    let pivot_tables = pivot_state.pivot_tables.lock().unwrap();
    let (definition, _) = pivot_tables
        .get(&pivot_id)
        .ok_or_else(|| format!("Pivot table {} not found", pivot_id))?;

    let source_range = format_range(definition.source_start, definition.source_end);
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
    })
}

/// Updates pivot table properties.
#[tauri::command]
pub fn update_pivot_properties(
    state: State<AppState>,
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

    let source_range = format_range(definition.source_start, definition.source_end);
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
    })
}

/// Gets pivot layout ranges (data body, row labels, column labels, filter axis).
#[tauri::command]
pub fn get_pivot_layout_ranges(
    state: State<AppState>,
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
    state: State<AppState>,
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
            show_as: show_values_as_to_api(f.show_values_as),
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
    }

    if !found {
        log_debug!("PIVOT", "Field {} not found in any hierarchy, filter not applied", request.field_index);
    }

    definition.bump_version();

    let view = safe_calculate_pivot(definition, cache);
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

    definition.bump_version();

    let view = safe_calculate_pivot(definition, cache);
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
    state: State<AppState>,
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

    // Get hidden items from definition
    let hidden_items: Vec<String> = definition.row_fields.iter()
        .chain(definition.column_fields.iter())
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
    state: State<AppState>,
    pivot_state: State<'_, PivotState>,
) -> Vec<PivotTableInfo> {
    log_debug!("PIVOT", "get_all_pivot_tables");

    let pivot_tables = pivot_state.pivot_tables.lock().unwrap();

    pivot_tables.iter()
        .map(|(id, (definition, _))| {
            let source_range = format_range(definition.source_start, definition.source_end);
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
pub fn refresh_all_pivot_tables(
    state: State<AppState>,
    pivot_state: State<'_, PivotState>,
) -> Result<Vec<PivotViewResponse>, String> {
    log_info!("PIVOT", "refresh_all_pivot_tables");

    let pivot_ids: Vec<PivotId> = {
        let pivot_tables = pivot_state.pivot_tables.lock().unwrap();
        pivot_tables.keys().cloned().collect()
    };

    let mut responses = Vec::new();
    for pivot_id in pivot_ids {
        match refresh_pivot_cache(state.clone(), pivot_state.clone(), pivot_id) {
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
fn show_values_as_to_api(show_as: pivot_engine::ShowValuesAs) -> Option<ShowAsRule> {
    let calculation = match show_as {
        pivot_engine::ShowValuesAs::Normal => return None,
        pivot_engine::ShowValuesAs::PercentOfGrandTotal => ShowAsCalculation::PercentOfGrandTotal,
        pivot_engine::ShowValuesAs::PercentOfRowTotal => ShowAsCalculation::PercentOfRowTotal,
        pivot_engine::ShowValuesAs::PercentOfColumnTotal => ShowAsCalculation::PercentOfColumnTotal,
        pivot_engine::ShowValuesAs::PercentOfParentRow => ShowAsCalculation::PercentOfParentRowTotal,
        pivot_engine::ShowValuesAs::PercentOfParentColumn => ShowAsCalculation::PercentOfParentColumnTotal,
        pivot_engine::ShowValuesAs::Difference => ShowAsCalculation::DifferenceFrom,
        pivot_engine::ShowValuesAs::PercentDifference => ShowAsCalculation::PercentDifferenceFrom,
        pivot_engine::ShowValuesAs::RunningTotal => ShowAsCalculation::RunningTotal,
        pivot_engine::ShowValuesAs::Index => ShowAsCalculation::Index,
    };
    Some(ShowAsRule {
        calculation,
        base_field: None,
        base_item: None,
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
            new_grid.set_cell((r + 1) as u32, c as u32, engine::Cell { formula: None, value: cv.clone(), style_index: 0, cached_ast: None });
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