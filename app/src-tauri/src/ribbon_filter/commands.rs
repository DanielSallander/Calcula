//! FILENAME: app/src-tauri/src/ribbon_filter/commands.rs
//! PURPOSE: Tauri commands for ribbon filter CRUD and item retrieval.
//! CONTEXT: Manages ribbon filter state and bridges to table/pivot data sources.

use crate::pivot::PivotState;
use crate::ribbon_filter::types::*;
use crate::slicer::types::{SlicerItem, SlicerSourceType};
use crate::{format_cell_value, AppState};
use pivot_engine::PivotId;
use std::collections::HashMap;
use tauri::State;

use crate::log_debug;

// ============================================================================
// CRUD COMMANDS
// ============================================================================

/// Create a new ribbon filter.
#[tauri::command]
pub fn create_ribbon_filter(
    ribbon_filter_state: State<RibbonFilterState>,
    params: CreateRibbonFilterParams,
) -> Result<RibbonFilter, String> {
    let mut next_id = ribbon_filter_state.next_id.lock().unwrap();
    let id = *next_id;
    *next_id += 1;

    let filter = RibbonFilter {
        id,
        name: params.name,
        scope: params.scope,
        sheet_index: params.sheet_index,
        source_type: params.source_type,
        cache_source_id: params.cache_source_id,
        field_name: params.field_name,
        connected_sources: params.connected_sources,
        display_mode: params.display_mode.unwrap_or_default(),
        selected_items: None,
        cross_filter_enabled: true,
        collapsed: false,
        order: params.order.unwrap_or(0),
        button_columns: 2,
        button_rows: 0,
    };

    log_debug!(
        "RIBBON_FILTER",
        "create_ribbon_filter id={} name={} scope={:?} field={}",
        id,
        filter.name,
        filter.scope,
        filter.field_name
    );

    let result = filter.clone();
    ribbon_filter_state.filters.lock().unwrap().insert(id, filter);

    Ok(result)
}

/// Delete a ribbon filter.
#[tauri::command]
pub fn delete_ribbon_filter(
    ribbon_filter_state: State<RibbonFilterState>,
    filter_id: u64,
) -> Result<(), String> {
    log_debug!("RIBBON_FILTER", "delete_ribbon_filter id={}", filter_id);

    ribbon_filter_state
        .filters
        .lock()
        .unwrap()
        .remove(&filter_id)
        .ok_or_else(|| format!("Ribbon filter {} not found", filter_id))?;

    Ok(())
}

/// Update ribbon filter properties.
#[tauri::command]
pub fn update_ribbon_filter(
    ribbon_filter_state: State<RibbonFilterState>,
    filter_id: u64,
    params: UpdateRibbonFilterParams,
) -> Result<RibbonFilter, String> {
    log_debug!("RIBBON_FILTER", "update_ribbon_filter id={}", filter_id);

    let mut filters = ribbon_filter_state.filters.lock().unwrap();
    let filter = filters
        .get_mut(&filter_id)
        .ok_or_else(|| format!("Ribbon filter {} not found", filter_id))?;

    if let Some(name) = params.name {
        filter.name = name;
    }
    if let Some(scope) = params.scope {
        filter.scope = scope;
    }
    if let Some(sheet_index) = params.sheet_index {
        filter.sheet_index = sheet_index;
    }
    if let Some(display_mode) = params.display_mode {
        filter.display_mode = display_mode;
    }
    if let Some(collapsed) = params.collapsed {
        filter.collapsed = collapsed;
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
    if let Some(cross_filter_enabled) = params.cross_filter_enabled {
        filter.cross_filter_enabled = cross_filter_enabled;
    }
    if let Some(connected_sources) = params.connected_sources {
        filter.connected_sources = connected_sources;
    }

    Ok(filter.clone())
}

/// Update ribbon filter selection (which items are checked).
#[tauri::command]
pub fn update_ribbon_filter_selection(
    ribbon_filter_state: State<RibbonFilterState>,
    filter_id: u64,
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

/// Get ribbon filters by scope (workbook or sheet).
#[tauri::command]
pub fn get_ribbon_filters_by_scope(
    ribbon_filter_state: State<RibbonFilterState>,
    scope: RibbonFilterScope,
    sheet_index: Option<usize>,
) -> Vec<RibbonFilter> {
    ribbon_filter_state
        .filters
        .lock()
        .unwrap()
        .values()
        .filter(|f| {
            f.scope == scope
                && (scope == RibbonFilterScope::Workbook || f.sheet_index == sheet_index)
        })
        .cloned()
        .collect()
}

/// Get the unique items for a ribbon filter (reads from the data source).
/// Returns items with their selection state and data availability.
/// Cross-filtering: checks sibling ribbon filters and canvas slicers that share
/// connected sources to determine which items still have matching data.
#[tauri::command]
pub fn get_ribbon_filter_items(
    state: State<AppState>,
    pivot_state: State<'_, PivotState>,
    slicer_state: State<crate::slicer::SlicerState>,
    ribbon_filter_state: State<RibbonFilterState>,
    filter_id: u64,
) -> Result<Vec<SlicerItem>, String> {
    let filters = ribbon_filter_state.filters.lock().unwrap();
    let filter = filters
        .get(&filter_id)
        .ok_or_else(|| format!("Ribbon filter {} not found", filter_id))?;

    let reference_source_id = filter.cache_source_id;

    // Collect cross-filters from sibling ribbon filters
    let filter_connected: std::collections::HashSet<u64> =
        filter.connected_sources.iter()
            .filter(|c| c.source_type == filter.source_type)
            .map(|c| c.source_id)
            .collect();

    let mut sibling_filters: Vec<(String, Vec<String>)> = filters
        .values()
        .filter(|f| {
            f.id != filter_id
                && f.selected_items.is_some()
                && f.connected_sources.iter().any(|c| filter_connected.contains(&c.source_id))
        })
        .map(|f| (f.field_name.clone(), f.selected_items.clone().unwrap()))
        .collect();

    // Also collect cross-filters from canvas slicers (if cross_filter_enabled)
    if filter.cross_filter_enabled {
        let slicers = slicer_state.slicers.lock().unwrap();
        let slicer_siblings: Vec<(String, Vec<String>)> = slicers
            .values()
            .filter(|s| {
                s.selected_items.is_some()
                    && s.connected_sources.iter().any(|c| filter_connected.contains(&c.source_id))
            })
            .map(|s| (s.field_name.clone(), s.selected_items.clone().unwrap()))
            .collect();
        sibling_filters.extend(slicer_siblings);
    }

    let unique_values = match filter.source_type {
        SlicerSourceType::Table => get_table_column_values(&state, reference_source_id, &filter.field_name)?,
        SlicerSourceType::Pivot => get_pivot_field_values(&pivot_state, reference_source_id, &filter.field_name)?,
        SlicerSourceType::BiConnection => {
            // BI connection items are fetched async via bi_get_column_values on the frontend
            return Err("BiConnection source: use bi_get_column_values instead".to_string());
        }
    };

    // Compute has_data by checking cross-filter state
    let has_data_set = if sibling_filters.is_empty() {
        None
    } else {
        match filter.source_type {
            SlicerSourceType::Table => {
                Some(get_table_available_values(&state, reference_source_id, &filter.field_name, &sibling_filters)?)
            }
            SlicerSourceType::Pivot => {
                Some(get_pivot_available_values(&pivot_state, reference_source_id, &filter.field_name, &sibling_filters)?)
            }
            SlicerSourceType::BiConnection => {
                return Err("BiConnection source: use bi_get_column_available_values instead".to_string());
            }
        }
    };

    // Build items with selection state and data availability
    let items: Vec<SlicerItem> = unique_values
        .into_iter()
        .map(|value| {
            let selected = match &filter.selected_items {
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

    Ok(items)
}

// ============================================================================
// INTERNAL HELPERS (shared with slicer — will be extracted to filter_common in Phase 3)
// ============================================================================

/// Match a filter field name against a cache field name.
fn field_name_matches(cache_name: &str, filter_name: &str) -> bool {
    if cache_name == filter_name {
        return true;
    }
    if let Some(col_part) = filter_name.rsplit('.').next() {
        if cache_name == col_part {
            return true;
        }
    }
    false
}

/// Get unique values from a table column.
fn get_table_column_values(state: &State<AppState>, source_id: u64, field_name: &str) -> Result<Vec<String>, String> {
    let tables = state.tables.lock().unwrap();
    let grids = state.grids.lock().unwrap();
    let style_registry = state.style_registry.lock().unwrap();
    let locale = state.locale.lock().unwrap();

    let table = tables
        .values()
        .flat_map(|sheet_tables| sheet_tables.values())
        .find(|t| t.id == source_id)
        .ok_or_else(|| format!("Table {} not found", source_id))?;

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
            let style = style_registry.get(cell.style_index);
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

/// Get values from a table column that still have data given cross-filter state.
fn get_table_available_values(
    state: &State<AppState>,
    source_id: u64,
    field_name: &str,
    sibling_filters: &[(String, Vec<String>)],
) -> Result<std::collections::HashSet<String>, String> {
    let tables = state.tables.lock().unwrap();
    let grids = state.grids.lock().unwrap();
    let style_registry = state.style_registry.lock().unwrap();
    let locale = state.locale.lock().unwrap();

    let table = tables
        .values()
        .flat_map(|sheet_tables| sheet_tables.values())
        .find(|t| t.id == source_id)
        .ok_or_else(|| format!("Table {} not found", source_id))?;

    let target_col_offset = table
        .columns
        .iter()
        .position(|c| c.name == field_name)
        .ok_or_else(|| format!("Column '{}' not found", field_name))?;
    let target_abs_col = table.start_col + target_col_offset as u32;

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
        let passes = filter_cols.iter().all(|(col, allowed)| {
            let value = if let Some(cell) = grid.cells.get(&(row, *col)) {
                let style = style_registry.get(cell.style_index);
                format_cell_value(&cell.value, style, &locale)
            } else {
                String::new()
            };
            allowed.contains(&value)
        });

        if passes {
            let value = if let Some(cell) = grid.cells.get(&(row, target_abs_col)) {
                let style = style_registry.get(cell.style_index);
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
    source_id: u64,
    field_name: &str,
) -> Result<Vec<String>, String> {
    use pivot_engine::VALUE_ID_EMPTY;

    let pivot_id = source_id as PivotId;
    let mut pivot_tables = pivot_state.pivot_tables.lock().unwrap();
    let (_def, cache) = pivot_tables
        .get_mut(&pivot_id)
        .ok_or_else(|| format!("Pivot table {} not found", pivot_id))?;

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
            field.get_value(id).map(|value| match value {
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
        })
        .filter(|s| !s.is_empty())
        .collect();

    Ok(unique_values)
}

/// Get values from a pivot field that still have data given cross-filter state.
fn get_pivot_available_values(
    pivot_state: &State<'_, PivotState>,
    source_id: u64,
    field_name: &str,
    sibling_filters: &[(String, Vec<String>)],
) -> Result<std::collections::HashSet<String>, String> {
    use pivot_engine::VALUE_ID_EMPTY;

    let pivot_id = source_id as PivotId;
    let mut pivot_tables = pivot_state.pivot_tables.lock().unwrap();
    let (_def, cache) = pivot_tables
        .get_mut(&pivot_id)
        .ok_or_else(|| format!("Pivot table {} not found", pivot_id))?;

    let target_field_idx = cache
        .fields
        .iter()
        .position(|f| field_name_matches(&f.name, field_name))
        .ok_or_else(|| format!("Field '{}' not found in pivot cache", field_name))?;

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
