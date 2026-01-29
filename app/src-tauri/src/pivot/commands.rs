//! FILENAME: app/src-tauri/src/pivot/commands.rs
use crate::pivot::operations::*;
use crate::pivot::types::*;
use crate::pivot::utils::*;
use crate::{log_debug, log_info, AppState};
use engine::pivot::{drill_down, CacheValue, PivotDefinition, PivotId, VALUE_ID_EMPTY};
use tauri::State;

// ============================================================================
// TAURI COMMANDS
// ============================================================================

/// Creates a new pivot table from the specified source range
#[tauri::command]
pub fn create_pivot_table(
    state: State<AppState>,
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
    let mut next_id = state.next_pivot_id.lock().unwrap();
    let pivot_id = *next_id;
    *next_id += 1;
    drop(next_id);

    // Create definition - START EMPTY (no auto-population)
    let mut definition = PivotDefinition::new(pivot_id, source_start, source_end);
    definition.source_has_headers = has_headers;
    definition.destination = destination;

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
    let response = view_to_response(&view);

    // Update pivot region tracking (tracks even empty pivots with reserved space)
    update_pivot_region(&state, pivot_id, dest_sheet_idx, destination, &view);

    // Write pivot output to destination grid (empty for now, but reserves the space)
    {
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
            write_pivot_to_grid(dest_grid, &view, destination);
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
    let mut pivot_tables = state.pivot_tables.lock().unwrap();
    pivot_tables.insert(pivot_id, (definition, cache_mut));

    // Set as active pivot
    let mut active = state.active_pivot_id.lock().unwrap();
    *active = Some(pivot_id);

    log_info!("PIVOT", "created pivot_id={} rows={} (empty - awaiting field configuration)", pivot_id, response.row_count);

    Ok(response)
}

/// Updates the field configuration of an existing pivot table
#[tauri::command]
pub fn update_pivot_fields(
    state: State<AppState>,
    request: UpdatePivotFieldsRequest,
) -> Result<PivotViewResponse, String> {
    log_info!("PIVOT", "update_pivot_fields pivot_id={}", request.pivot_id);

    let mut pivot_tables = state.pivot_tables.lock().unwrap();
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

    // Recalculate view
    let view = safe_calculate_pivot(definition, cache);
    
    // Get destination info before dropping pivot_tables lock
    let destination = definition.destination;
    let pivot_id = definition.id;
    
    // Resolve destination sheet index from definition
    let dest_sheet_idx = resolve_dest_sheet_index(&state, definition);
    
    drop(pivot_tables);
    
    // Update pivot in grid (clears old region, writes new view)
    update_pivot_in_grid(&state, pivot_id, dest_sheet_idx, destination, &view);
    
    // Update pivot region tracking
    update_pivot_region(&state, pivot_id, dest_sheet_idx, destination, &view);
    
    let response = view_to_response(&view);

    log_info!(
        "PIVOT",
        "updated pivot_id={} version={} rows={} cols={}",
        request.pivot_id,
        response.version,
        response.row_count,
        response.col_count
    );

    Ok(response)
}

/// Toggles the expand/collapse state of a pivot group
#[tauri::command]
pub fn toggle_pivot_group(
    state: State<AppState>,
    request: ToggleGroupRequest,
) -> Result<PivotViewResponse, String> {
    log_info!(
        "PIVOT",
        "toggle_pivot_group pivot_id={} is_row={} field_idx={}",
        request.pivot_id,
        request.is_row,
        request.field_index
    );

    let mut pivot_tables = state.pivot_tables.lock().unwrap();
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
    field.collapsed = !field.collapsed;

    log_debug!(
        "PIVOT",
        "toggled field {} collapsed={}",
        field.name,
        field.collapsed
    );

    // Bump version
    definition.bump_version();

    // Recalculate view
    let view = safe_calculate_pivot(definition, cache);
    
    // Get destination info
    let destination = definition.destination;
    let pivot_id = definition.id;
    
    // Resolve destination sheet index from definition
    let dest_sheet_idx = resolve_dest_sheet_index(&state, definition);
    
    drop(pivot_tables);
    
    // Update pivot in grid (clears old region, writes new view)
    update_pivot_in_grid(&state, pivot_id, dest_sheet_idx, destination, &view);
    
    // Update pivot region tracking
    update_pivot_region(&state, pivot_id, dest_sheet_idx, destination, &view);
    
    let response = view_to_response(&view);

    Ok(response)
}

/// Gets the current view of a pivot table
#[tauri::command]
pub fn get_pivot_view(
    state: State<AppState>,
    pivot_id: Option<PivotId>,
) -> Result<PivotViewResponse, String> {
    // Use provided ID or active pivot
    let id = match pivot_id {
        Some(id) => id,
        None => {
            let active = state.active_pivot_id.lock().unwrap();
            active.ok_or_else(|| "No active pivot table".to_string())?
        }
    };

    log_debug!("PIVOT", "get_pivot_view pivot_id={}", id);

    let mut pivot_tables = state.pivot_tables.lock().unwrap();
    let (definition, cache) = pivot_tables
        .get_mut(&id)
        .ok_or_else(|| format!("Pivot table {} not found", id))?;

    let view = safe_calculate_pivot(definition, cache);
    Ok(view_to_response(&view))
}

/// Deletes a pivot table
#[tauri::command]
pub fn delete_pivot_table(state: State<AppState>, pivot_id: PivotId) -> Result<(), String> {
    log_info!("PIVOT", "delete_pivot_table pivot_id={}", pivot_id);

    // Get pivot info before removing
    let pivot_tables = state.pivot_tables.lock().unwrap();
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
    let mut pivot_tables = state.pivot_tables.lock().unwrap();
    pivot_tables.remove(&pivot_id);

    // Clear active if this was the active pivot
    let mut active = state.active_pivot_id.lock().unwrap();
    if *active == Some(pivot_id) {
        *active = None;
    }
    
    // Remove pivot region tracking
    let mut regions = state.pivot_regions.lock().unwrap();
    regions.retain(|r| r.pivot_id != pivot_id);

    Ok(())
}

/// Gets source data for drill-down (detail view)
#[tauri::command]
pub fn get_pivot_source_data(
    state: State<AppState>,
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

    let pivot_tables = state.pivot_tables.lock().unwrap();
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
    pivot_id: PivotId,
) -> Result<PivotViewResponse, String> {
    log_info!("PIVOT", "refresh_pivot_cache pivot_id={}", pivot_id);

    // First, get the definition to know the source range
    let pivot_tables = state.pivot_tables.lock().unwrap();
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
    let mut pivot_tables = state.pivot_tables.lock().unwrap();
    let (definition, cache) = pivot_tables
        .get_mut(&pivot_id)
        .ok_or_else(|| format!("Pivot table {} not found", pivot_id))?;

    *cache = new_cache;
    definition.bump_version();

    let view = safe_calculate_pivot(definition, cache);
    
    drop(pivot_tables);
    
    // Update pivot in grid (clears old region, writes new view)
    update_pivot_in_grid(&state, pivot_id, dest_sheet_idx, destination, &view);
    
    // Update pivot region tracking
    update_pivot_region(&state, pivot_id, dest_sheet_idx, destination, &view);
    
    let response = view_to_response(&view);

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
    row: u32,
    col: u32,
) -> Result<Option<PivotRegionInfo>, String> {
    use crate::pivot::utils::{aggregation_to_string, report_layout_to_string, values_position_to_string};
    
    let active_sheet = *state.active_sheet.lock().unwrap();
    
    // Check if cell is in any pivot region
    let pivot_id = match state.is_cell_in_pivot_region(active_sheet, row, col) {
        Some(id) => id,
        None => return Ok(None),
    };
    
    log_debug!("PIVOT", "get_pivot_at_cell ({},{}) found pivot_id={}", row, col, pivot_id);
    
    // Get pivot info
    let pivot_tables = state.pivot_tables.lock().unwrap();
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
) -> Vec<PivotRegionData> {
    let active_sheet = *state.active_sheet.lock().unwrap();
    let regions = state.pivot_regions.lock().unwrap();
    let pivot_tables = state.pivot_tables.lock().unwrap();

    regions
        .iter()
        .filter(|r| r.sheet_index == active_sheet)
        .map(|r| {
            let is_empty = pivot_tables
                .get(&r.pivot_id)
                .map(|(def, _)| !has_fields_configured(def))
                .unwrap_or(true);

            PivotRegionData {
                pivot_id: r.pivot_id,
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
    pivot_id: PivotId,
    field_index: usize,
) -> Result<FieldUniqueValuesResponse, String> {
    log_debug!(
        "PIVOT",
        "get_pivot_field_unique_values pivot_id={} field_index={}",
        pivot_id,
        field_index
    );

    let mut pivot_tables = state.pivot_tables.lock().unwrap();
    let (_, cache) = pivot_tables
        .get_mut(&pivot_id)
        .ok_or_else(|| format!("Pivot table {} not found", pivot_id))?;

    // Get field cache
    let field = cache.fields
        .get_mut(field_index)
        .ok_or_else(|| format!("Field index {} out of range", field_index))?;

    let field_name = field.name.clone();

    // Collect unique values as strings
    // 'sorted_ids()' borrows 'field' mutably. If we iterate the result directly,
    // the mutable borrow persists through the loop, preventing us from calling
    // 'field.get_value()' (an immutable borrow) inside the closure.
    // Cloning the IDs ends the mutable borrow immediately.
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

/// Convert a CacheValue to a display string
fn cache_value_to_string(value: &CacheValue) -> String {
    match value {
        CacheValue::Empty => "(Blank)".to_string(),
        CacheValue::Number(n) => {
            let f = n.as_f64();
            if f.fract() == 0.0 {
                format!("{}", f as i64)
            } else {
                format!("{}", f)
            }
        }
        CacheValue::Text(s) => s.clone(),
        CacheValue::Boolean(b) => if *b { "TRUE".to_string() } else { "FALSE".to_string() },
        CacheValue::Error(e) => format!("#{}", e),
    }
}