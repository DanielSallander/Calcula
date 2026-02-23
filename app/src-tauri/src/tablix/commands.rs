//! FILENAME: app/src-tauri/src/tablix/commands.rs
//! Tauri commands for Tablix operations.

use crate::tablix::operations::{
    view_to_response, parse_field_config, parse_data_field_config, parse_layout_config,
};
use crate::tablix::types::*;
use crate::pivot::utils::{parse_range, parse_cell_ref, col_index_to_letter};
use crate::{log_debug, log_info, AppState};
use pivot_engine::{PivotCache, PivotDefinition, CacheValue};
use tablix_engine::{
    calculate_tablix, TablixDefinition, TablixView,
    pivot_to_tablix, tablix_to_pivot,
};
use tauri::State;
use engine::{Cell, CellValue};

// ============================================================================
// CONSTANTS
// ============================================================================

const EMPTY_TABLIX_ROWS: u32 = 18;
const EMPTY_TABLIX_COLS: u32 = 3;

// ============================================================================
// TAURI COMMANDS
// ============================================================================

/// Creates a new tablix from the specified source range.
#[tauri::command]
pub fn create_tablix(
    state: State<AppState>,
    tablix_state: State<'_, TablixState>,
    request: CreateTablixRequest,
) -> Result<TablixViewResponse, String> {
    log_info!("TABLIX", "create_tablix source={} dest={}", request.source_range, request.destination_cell);

    let (source_start, source_end) = parse_range(&request.source_range)?;
    let destination = parse_cell_ref(&request.destination_cell)?;

    let source_sheet_idx = request.source_sheet.unwrap_or_else(|| {
        *state.active_sheet.lock().unwrap()
    });
    let dest_sheet_idx = request.destination_sheet.unwrap_or_else(|| {
        *state.active_sheet.lock().unwrap()
    });

    let grids = state.grids.lock().unwrap();
    let grid = grids
        .get(source_sheet_idx)
        .ok_or_else(|| format!("Sheet index {} not found", source_sheet_idx))?;

    let has_headers = request.has_headers.unwrap_or(true);

    // Build cache from source data (reuses pivot's cache building)
    let (cache, headers) = build_cache_from_grid_for_tablix(
        grid,
        source_start,
        source_end,
        has_headers,
    )?;

    // Assign ID
    let mut next_id = tablix_state.next_tablix_id.lock().unwrap();
    let tablix_id = *next_id;
    *next_id += 1;

    // Create definition
    let mut definition = TablixDefinition::new(tablix_id, source_start, source_end);
    definition.source_has_headers = has_headers;
    definition.destination = destination;
    definition.name = request.name;

    // Calculate empty view
    let view = TablixView::new(tablix_id);
    let response = view_to_response(&view);

    // Register protected region
    let dest_end_row = destination.0 + EMPTY_TABLIX_ROWS;
    let dest_end_col = destination.1 + EMPTY_TABLIX_COLS;

    {
        let mut regions = state.protected_regions.lock().unwrap();
        regions.push(crate::ProtectedRegion {
            id: format!("tablix-{}", tablix_id),
            region_type: "tablix".to_string(),
            owner_id: tablix_id as u64,
            sheet_index: dest_sheet_idx,
            start_row: destination.0,
            start_col: destination.1,
            end_row: dest_end_row,
            end_col: dest_end_col,
        });
    }

    // Store tablix
    let mut tables = tablix_state.tablix_tables.lock().unwrap();
    tables.insert(tablix_id, (definition, cache));
    *tablix_state.active_tablix_id.lock().unwrap() = Some(tablix_id);

    log_info!("TABLIX", "Created tablix {} with {} headers", tablix_id, headers.len());
    Ok(response)
}

/// Updates tablix fields and recalculates.
#[tauri::command]
pub fn update_tablix_fields(
    state: State<AppState>,
    tablix_state: State<'_, TablixState>,
    request: UpdateTablixFieldsRequest,
) -> Result<TablixViewResponse, String> {
    log_info!("TABLIX", "update_tablix_fields id={}", request.tablix_id);

    let mut tables = tablix_state.tablix_tables.lock().unwrap();
    let (definition, cache) = tables
        .get_mut(&request.tablix_id)
        .ok_or_else(|| format!("Tablix {} not found", request.tablix_id))?;

    // Update fields
    if let Some(row_groups) = &request.row_groups {
        definition.row_groups = row_groups.iter().map(parse_field_config).collect();
    }
    if let Some(column_groups) = &request.column_groups {
        definition.column_groups = column_groups.iter().map(parse_field_config).collect();
    }
    if let Some(data_fields) = &request.data_fields {
        definition.data_fields = data_fields.iter().map(parse_data_field_config).collect();
    }
    if let Some(filter_fields) = &request.filter_fields {
        definition.filter_fields = filter_fields.iter().map(|f| {
            let pf = parse_field_config(f);
            pivot_engine::PivotFilter {
                field: pf,
                condition: pivot_engine::FilterCondition::ValueList(Vec::new()),
            }
        }).collect();
    }
    if let Some(layout) = &request.layout {
        definition.layout = parse_layout_config(layout, &definition.layout);
    }

    definition.bump_version();

    // Recalculate
    let has_fields = !definition.row_groups.is_empty()
        || !definition.column_groups.is_empty()
        || !definition.data_fields.is_empty();

    let view = if has_fields {
        calculate_tablix(definition, cache)
    } else {
        TablixView::new(definition.id)
    };

    // Write to grid
    let dest = definition.destination;
    let dest_sheet = state.active_sheet.lock().unwrap().clone();
    write_tablix_view_to_grid(&state, &view, dest, dest_sheet, request.tablix_id)?;

    let response = view_to_response(&view);
    Ok(response)
}

/// Gets the current tablix view.
#[tauri::command]
pub fn get_tablix_view(
    tablix_state: State<'_, TablixState>,
    tablix_id: Option<TablixId>,
) -> Result<TablixViewResponse, String> {
    let id = tablix_id.or_else(|| {
        *tablix_state.active_tablix_id.lock().unwrap()
    }).ok_or("No tablix ID specified and no active tablix")?;

    let mut tables = tablix_state.tablix_tables.lock().unwrap();
    let (definition, cache) = tables
        .get_mut(&id)
        .ok_or_else(|| format!("Tablix {} not found", id))?;

    let has_fields = !definition.row_groups.is_empty()
        || !definition.column_groups.is_empty()
        || !definition.data_fields.is_empty();

    let view = if has_fields {
        calculate_tablix(definition, cache)
    } else {
        TablixView::new(definition.id)
    };

    Ok(view_to_response(&view))
}

/// Deletes a tablix.
#[tauri::command]
pub fn delete_tablix(
    state: State<AppState>,
    tablix_state: State<'_, TablixState>,
    tablix_id: TablixId,
) -> Result<(), String> {
    log_info!("TABLIX", "delete_tablix id={}", tablix_id);

    let mut tables = tablix_state.tablix_tables.lock().unwrap();
    tables.remove(&tablix_id);

    // Remove protected region
    let region_id = format!("tablix-{}", tablix_id);
    let mut regions = state.protected_regions.lock().unwrap();
    regions.retain(|r| r.id != region_id);

    let mut active = tablix_state.active_tablix_id.lock().unwrap();
    if *active == Some(tablix_id) {
        *active = None;
    }

    Ok(())
}

/// Toggle expand/collapse on a tablix group.
#[tauri::command]
pub fn toggle_tablix_group(
    state: State<AppState>,
    tablix_state: State<'_, TablixState>,
    request: ToggleTablixGroupRequest,
) -> Result<TablixViewResponse, String> {
    log_info!("TABLIX", "toggle_tablix_group id={}", request.tablix_id);

    let mut tables = tablix_state.tablix_tables.lock().unwrap();
    let (definition, cache) = tables
        .get_mut(&request.tablix_id)
        .ok_or_else(|| format!("Tablix {} not found", request.tablix_id))?;

    // Toggle collapsed state on the field
    let fields = if request.is_row {
        &mut definition.row_groups
    } else {
        &mut definition.column_groups
    };

    if request.field_index < fields.len() {
        fields[request.field_index].collapsed = !fields[request.field_index].collapsed;
    }

    definition.bump_version();

    let view = calculate_tablix(definition, cache);
    let dest = definition.destination;
    let dest_sheet = *state.active_sheet.lock().unwrap();
    write_tablix_view_to_grid(&state, &view, dest, dest_sheet, request.tablix_id)?;

    Ok(view_to_response(&view))
}

/// Checks if a cell is inside a tablix region.
#[tauri::command]
pub fn get_tablix_at_cell(
    state: State<AppState>,
    tablix_state: State<'_, TablixState>,
    row: u32,
    col: u32,
) -> Result<Option<TablixRegionInfo>, String> {
    let tables = tablix_state.tablix_tables.lock().unwrap();

    for (&tablix_id, (definition, cache)) in tables.iter() {
        let dest = definition.destination;
        let has_fields = !definition.row_groups.is_empty()
            || !definition.column_groups.is_empty()
            || !definition.data_fields.is_empty();

        let (end_row, end_col) = if has_fields {
            // Approximate bounds from definition
            let approx_rows = definition.source_row_count().max(EMPTY_TABLIX_ROWS);
            let approx_cols = (definition.row_groups.len() as u32 + definition.data_fields.len() as u32).max(EMPTY_TABLIX_COLS);
            (dest.0 + approx_rows, dest.1 + approx_cols)
        } else {
            (dest.0 + EMPTY_TABLIX_ROWS, dest.1 + EMPTY_TABLIX_COLS)
        };

        if row >= dest.0 && row <= end_row && col >= dest.1 && col <= end_col {
            // Build source fields info
            let source_fields: Vec<TablixSourceFieldInfo> = cache.fields.iter().map(|fc| {
                let is_numeric = fc.get_value(0)
                    .map(|v| matches!(v, CacheValue::Number(_)))
                    .unwrap_or(false);
                TablixSourceFieldInfo {
                    index: fc.source_index,
                    name: fc.name.clone(),
                    is_numeric,
                }
            }).collect();

            // Build current field configuration
            let field_config = build_field_configuration(definition, cache);

            return Ok(Some(TablixRegionInfo {
                tablix_id,
                is_empty: !has_fields,
                source_fields,
                field_configuration: field_config,
                filter_zones: Vec::new(),
            }));
        }
    }

    Ok(None)
}

/// Gets all tablix regions for the current sheet.
#[tauri::command]
pub fn get_tablix_regions_for_sheet(
    state: State<AppState>,
    tablix_state: State<'_, TablixState>,
) -> Result<Vec<TablixRegionData>, String> {
    let tables = tablix_state.tablix_tables.lock().unwrap();
    let mut regions = Vec::new();

    for (&tablix_id, (definition, _cache)) in tables.iter() {
        let dest = definition.destination;
        let has_fields = !definition.row_groups.is_empty()
            || !definition.column_groups.is_empty()
            || !definition.data_fields.is_empty();

        let (end_row, end_col) = if has_fields {
            let approx_rows = definition.source_row_count().max(EMPTY_TABLIX_ROWS);
            let approx_cols = (definition.row_groups.len() as u32 + definition.data_fields.len() as u32).max(EMPTY_TABLIX_COLS);
            (dest.0 + approx_rows, dest.1 + approx_cols)
        } else {
            (dest.0 + EMPTY_TABLIX_ROWS, dest.1 + EMPTY_TABLIX_COLS)
        };

        regions.push(TablixRegionData {
            tablix_id,
            start_row: dest.0,
            start_col: dest.1,
            end_row,
            end_col,
            is_empty: !has_fields,
        });
    }

    Ok(regions)
}

/// Converts a pivot table to a tablix.
#[tauri::command]
pub fn convert_pivot_to_tablix(
    state: State<AppState>,
    pivot_state: State<'_, crate::pivot::types::PivotState>,
    tablix_state: State<'_, TablixState>,
    request: ConvertRequest,
) -> Result<ConversionResponse, String> {
    log_info!("TABLIX", "convert_pivot_to_tablix pivot_id={}", request.id);

    // Get the pivot definition and cache
    let mut pivot_tables = pivot_state.pivot_tables.lock().unwrap();
    let (pivot_def, pivot_cache) = pivot_tables
        .remove(&request.id)
        .ok_or_else(|| format!("Pivot table {} not found", request.id))?;

    // Convert definition
    let tablix_def = pivot_to_tablix(&pivot_def);
    let tablix_id = tablix_def.id;

    // Store as tablix (reusing the same cache)
    let mut tablix_tables = tablix_state.tablix_tables.lock().unwrap();
    tablix_tables.insert(tablix_id, (tablix_def, pivot_cache));

    // Update protected region ID
    {
        let mut regions = state.protected_regions.lock().unwrap();
        for region in regions.iter_mut() {
            if region.id == format!("pivot-{}", request.id) {
                region.id = format!("tablix-{}", tablix_id);
            }
        }
    }

    Ok(ConversionResponse {
        new_id: tablix_id,
        migrated_detail_fields: Vec::new(), // No migration needed for pivot -> tablix
    })
}

/// Converts a tablix to a pivot table.
#[tauri::command]
pub fn convert_tablix_to_pivot(
    state: State<AppState>,
    pivot_state: State<'_, crate::pivot::types::PivotState>,
    tablix_state: State<'_, TablixState>,
    request: ConvertRequest,
) -> Result<ConversionResponse, String> {
    log_info!("TABLIX", "convert_tablix_to_pivot tablix_id={}", request.id);

    let mut tablix_tables = tablix_state.tablix_tables.lock().unwrap();
    let (tablix_def, tablix_cache) = tablix_tables
        .remove(&request.id)
        .ok_or_else(|| format!("Tablix {} not found", request.id))?;

    // Convert definition (may migrate detail fields to rows)
    let (pivot_def, migrated) = tablix_to_pivot(&tablix_def);
    let pivot_id = pivot_def.id;

    let migrated_names: Vec<String> = migrated.iter().map(|m| m.name.clone()).collect();

    // Store as pivot (reusing the same cache)
    let mut pivot_tables = pivot_state.pivot_tables.lock().unwrap();
    pivot_tables.insert(pivot_id, (pivot_def, tablix_cache));

    // Update protected region ID
    {
        let mut regions = state.protected_regions.lock().unwrap();
        for region in regions.iter_mut() {
            if region.id == format!("tablix-{}", request.id) {
                region.id = format!("pivot-{}", pivot_id);
            }
        }
    }

    Ok(ConversionResponse {
        new_id: pivot_id,
        migrated_detail_fields: migrated_names,
    })
}

/// Refreshes the tablix cache from source data.
#[tauri::command]
pub fn refresh_tablix_cache(
    state: State<AppState>,
    tablix_state: State<'_, TablixState>,
    tablix_id: TablixId,
) -> Result<TablixViewResponse, String> {
    log_info!("TABLIX", "refresh_tablix_cache id={}", tablix_id);

    let source_sheet_idx = *state.active_sheet.lock().unwrap();
    let grids = state.grids.lock().unwrap();
    let grid = grids
        .get(source_sheet_idx)
        .ok_or("Source sheet not found")?;

    let mut tables = tablix_state.tablix_tables.lock().unwrap();
    let (definition, cache) = tables
        .get_mut(&tablix_id)
        .ok_or_else(|| format!("Tablix {} not found", tablix_id))?;

    // Rebuild cache
    let (new_cache, _headers) = build_cache_from_grid_for_tablix(
        grid,
        definition.source_start,
        definition.source_end,
        definition.source_has_headers,
    )?;

    *cache = new_cache;
    definition.bump_version();

    let view = calculate_tablix(definition, cache);
    Ok(view_to_response(&view))
}

/// Gets unique values for a field (for filter dropdowns).
#[tauri::command]
pub fn get_tablix_field_unique_values(
    tablix_state: State<'_, TablixState>,
    tablix_id: TablixId,
    field_index: usize,
) -> Result<TablixFieldUniqueValuesResponse, String> {
    let tables = tablix_state.tablix_tables.lock().unwrap();
    let (_definition, cache) = tables
        .get(&tablix_id)
        .ok_or_else(|| format!("Tablix {} not found", tablix_id))?;

    let field_cache = cache.fields.get(field_index)
        .ok_or_else(|| format!("Field index {} not found", field_index))?;

    let mut unique_values = Vec::new();
    for id in 0..field_cache.unique_count() as pivot_engine::cache::ValueId {
        if let Some(cv) = field_cache.get_value(id) {
            let label = match cv {
                CacheValue::Empty => "(blank)".to_string(),
                CacheValue::Number(n) => format!("{}", n.as_f64()),
                CacheValue::Text(s) => s.clone(),
                CacheValue::Boolean(b) => if *b { "TRUE" } else { "FALSE" }.to_string(),
                CacheValue::Error(e) => format!("#{}", e),
            };
            unique_values.push(label);
        }
    }

    Ok(TablixFieldUniqueValuesResponse {
        field_index,
        field_name: field_cache.name.clone(),
        unique_values,
    })
}

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/// Builds a PivotCache from grid data for tablix use.
fn build_cache_from_grid_for_tablix(
    grid: &engine::Grid,
    start: (u32, u32),
    end: (u32, u32),
    has_headers: bool,
) -> Result<(PivotCache, Vec<String>), String> {
    let (start_row, start_col) = start;
    let (end_row, end_col) = end;
    let col_count = (end_col - start_col + 1) as usize;
    let data_start_row = if has_headers { start_row + 1 } else { start_row };

    let headers: Vec<String> = if has_headers {
        (start_col..=end_col)
            .map(|c| {
                grid.get_cell(start_row, c)
                    .map(|cell| cell.display_value())
                    .unwrap_or_else(|| col_index_to_letter(c - start_col))
            })
            .collect()
    } else {
        (0..col_count)
            .map(|i| col_index_to_letter(i as u32))
            .collect()
    };

    let mut cache = PivotCache::new(0, col_count);
    for (i, header) in headers.iter().enumerate() {
        cache.set_field_name(i, header.clone());
    }

    let row_count = (end_row - data_start_row + 1) as usize;
    cache.reserve(row_count);

    for row in data_start_row..=end_row {
        let values: Vec<CellValue> = (start_col..=end_col)
            .map(|col| {
                grid.get_cell(row, col)
                    .map(|cell| cell.value.clone())
                    .unwrap_or(CellValue::Empty)
            })
            .collect();
        cache.add_record(row - data_start_row, &values);
    }

    cache.stats.total_records = row_count;
    cache.stats.filtered_records = row_count;

    Ok((cache, headers))
}

/// Writes tablix view data to the grid.
fn write_tablix_view_to_grid(
    state: &AppState,
    view: &TablixView,
    dest: (u32, u32),
    sheet_idx: usize,
    tablix_id: TablixId,
) -> Result<(), String> {
    let mut grids = state.grids.lock().unwrap();
    let grid = grids
        .get_mut(sheet_idx)
        .ok_or("Destination sheet not found")?;

    for (view_row, row_cells) in view.cells.iter().enumerate() {
        for (view_col, cell) in row_cells.iter().enumerate() {
            if cell.is_spanned {
                continue; // Don't write spanned cells
            }

            let grid_row = dest.0 + view_row as u32;
            let grid_col = dest.1 + view_col as u32;

            let display = &cell.formatted_value;
            if !display.is_empty() {
                grid.set_cell(grid_row, grid_col, Cell::new_text(display.clone()));
            }
        }
    }

    // Update protected region bounds
    let end_row = dest.0 + view.row_count.max(EMPTY_TABLIX_ROWS as usize) as u32;
    let end_col = dest.1 + view.col_count.max(EMPTY_TABLIX_COLS as usize) as u32;

    let mut regions = state.protected_regions.lock().unwrap();
    for region in regions.iter_mut() {
        if region.id == format!("tablix-{}", tablix_id) {
            region.end_row = end_row;
            region.end_col = end_col;
        }
    }

    Ok(())
}

/// Builds the current field configuration for the editor.
fn build_field_configuration(
    definition: &TablixDefinition,
    cache: &PivotCache,
) -> TablixFieldConfiguration {
    let row_groups = definition.row_groups.iter().map(|f| {
        let is_numeric = cache.fields.get(f.source_index)
            .and_then(|fc| fc.get_value(0))
            .map(|v| matches!(v, CacheValue::Number(_)))
            .unwrap_or(false);
        TablixZoneFieldInfo {
            source_index: f.source_index,
            name: f.name.clone(),
            is_numeric,
            mode: None,
            aggregation: None,
        }
    }).collect();

    let column_groups = definition.column_groups.iter().map(|f| {
        let is_numeric = cache.fields.get(f.source_index)
            .and_then(|fc| fc.get_value(0))
            .map(|v| matches!(v, CacheValue::Number(_)))
            .unwrap_or(false);
        TablixZoneFieldInfo {
            source_index: f.source_index,
            name: f.name.clone(),
            is_numeric,
            mode: None,
            aggregation: None,
        }
    }).collect();

    let data_fields = definition.data_fields.iter().map(|df| {
        let is_numeric = cache.fields.get(df.source_index)
            .and_then(|fc| fc.get_value(0))
            .map(|v| matches!(v, CacheValue::Number(_)))
            .unwrap_or(false);
        let (mode, aggregation) = match &df.mode {
            tablix_engine::DataFieldMode::Detail => ("detail".to_string(), None),
            tablix_engine::DataFieldMode::Aggregated(agg) => {
                let agg_str = format!("{:?}", agg).to_lowercase();
                ("aggregated".to_string(), Some(agg_str))
            }
        };
        TablixZoneFieldInfo {
            source_index: df.source_index,
            name: df.name.clone(),
            is_numeric,
            mode: Some(mode),
            aggregation,
        }
    }).collect();

    let filter_fields = definition.filter_fields.iter().map(|f| {
        let is_numeric = cache.fields.get(f.field.source_index)
            .and_then(|fc| fc.get_value(0))
            .map(|v| matches!(v, CacheValue::Number(_)))
            .unwrap_or(false);
        TablixZoneFieldInfo {
            source_index: f.field.source_index,
            name: f.field.name.clone(),
            is_numeric,
            mode: None,
            aggregation: None,
        }
    }).collect();

    TablixFieldConfiguration {
        row_groups,
        column_groups,
        data_fields,
        filter_fields,
        layout: TablixLayoutConfig {
            show_row_grand_totals: Some(definition.layout.show_row_grand_totals),
            show_column_grand_totals: Some(definition.layout.show_column_grand_totals),
            group_layout: Some(match definition.layout.group_layout {
                tablix_engine::GroupLayout::Stepped => "stepped".to_string(),
                tablix_engine::GroupLayout::Block => "block".to_string(),
            }),
            repeat_group_labels: Some(definition.layout.repeat_group_labels),
            show_empty_groups: Some(definition.layout.show_empty_groups),
        },
    }
}
