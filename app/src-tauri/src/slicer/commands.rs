//! FILENAME: app/src-tauri/src/slicer/commands.rs
//! PURPOSE: Tauri commands for slicer CRUD and item retrieval.
//! CONTEXT: Manages slicer state and bridges to table/pivot data sources.

use crate::pivot::PivotState;
use crate::slicer::types::*;
use crate::{format_cell_value, AppState};
use pivot_engine::PivotId;
use std::collections::HashMap;
use tauri::State;

use crate::log_debug;

// ============================================================================
// CRUD COMMANDS
// ============================================================================

/// Create a new slicer.
#[tauri::command]
pub fn create_slicer(
    slicer_state: State<SlicerState>,
    params: CreateSlicerParams,
) -> Result<Slicer, String> {
    let mut next_id = slicer_state.next_id.lock().unwrap();
    let id = *next_id;
    *next_id += 1;

    let slicer = Slicer {
        id,
        name: params.name,
        sheet_index: params.sheet_index,
        x: params.x,
        y: params.y,
        width: params.width.unwrap_or(180.0),
        height: params.height.unwrap_or(240.0),
        source_type: params.source_type,
        source_id: params.source_id,
        field_name: params.field_name,
        selected_items: None, // All selected by default
        show_header: true,
        columns: params.columns.unwrap_or(1),
        style_preset: params.style_preset.unwrap_or_else(|| "SlicerStyleLight1".to_string()),
    };

    log_debug!(
        "SLICER",
        "create_slicer id={} name={} source={:?}:{}",
        id,
        slicer.name,
        slicer.source_type,
        slicer.source_id
    );

    let result = slicer.clone();
    slicer_state.slicers.lock().unwrap().insert(id, slicer);

    Ok(result)
}

/// Delete a slicer.
#[tauri::command]
pub fn delete_slicer(
    slicer_state: State<SlicerState>,
    slicer_id: u64,
) -> Result<(), String> {
    log_debug!("SLICER", "delete_slicer id={}", slicer_id);

    let mut slicers = slicer_state.slicers.lock().unwrap();
    slicers
        .remove(&slicer_id)
        .ok_or_else(|| format!("Slicer {} not found", slicer_id))?;
    Ok(())
}

/// Update slicer properties (name, header, columns, style).
#[tauri::command]
pub fn update_slicer(
    slicer_state: State<SlicerState>,
    slicer_id: u64,
    params: UpdateSlicerParams,
) -> Result<Slicer, String> {
    log_debug!("SLICER", "update_slicer id={}", slicer_id);

    let mut slicers = slicer_state.slicers.lock().unwrap();
    let slicer = slicers
        .get_mut(&slicer_id)
        .ok_or_else(|| format!("Slicer {} not found", slicer_id))?;

    if let Some(name) = params.name {
        slicer.name = name;
    }
    if let Some(show_header) = params.show_header {
        slicer.show_header = show_header;
    }
    if let Some(columns) = params.columns {
        slicer.columns = columns.clamp(1, 5);
    }
    if let Some(style_preset) = params.style_preset {
        slicer.style_preset = style_preset;
    }

    Ok(slicer.clone())
}

/// Update slicer position and size (called after drag/resize).
#[tauri::command]
pub fn update_slicer_position(
    slicer_state: State<SlicerState>,
    slicer_id: u64,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    let mut slicers = slicer_state.slicers.lock().unwrap();
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
    slicer_state: State<SlicerState>,
    slicer_id: u64,
    selected_items: Option<Vec<String>>,
) -> Result<(), String> {
    log_debug!(
        "SLICER",
        "update_slicer_selection id={} items={:?}",
        slicer_id,
        selected_items.as_ref().map(|v| v.len())
    );

    let mut slicers = slicer_state.slicers.lock().unwrap();
    let slicer = slicers
        .get_mut(&slicer_id)
        .ok_or_else(|| format!("Slicer {} not found", slicer_id))?;

    slicer.selected_items = selected_items;
    Ok(())
}

// ============================================================================
// QUERY COMMANDS
// ============================================================================

/// Get all slicers.
#[tauri::command]
pub fn get_all_slicers(
    slicer_state: State<SlicerState>,
) -> Vec<Slicer> {
    slicer_state
        .slicers
        .lock()
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
        .lock()
        .unwrap()
        .values()
        .filter(|s| s.sheet_index == sheet_index)
        .cloned()
        .collect()
}

/// Get the unique items for a slicer (reads from the data source).
/// Returns items with their selection state and data availability.
#[tauri::command]
pub fn get_slicer_items(
    state: State<AppState>,
    pivot_state: State<'_, PivotState>,
    slicer_state: State<SlicerState>,
    slicer_id: u64,
) -> Result<Vec<SlicerItem>, String> {
    let slicers = slicer_state.slicers.lock().unwrap();
    let slicer = slicers
        .get(&slicer_id)
        .ok_or_else(|| format!("Slicer {} not found", slicer_id))?;

    let unique_values = match slicer.source_type {
        SlicerSourceType::Table => get_table_column_values(&state, slicer)?,
        SlicerSourceType::Pivot => get_pivot_field_values(&pivot_state, slicer)?,
    };

    // Build items with selection state
    let items: Vec<SlicerItem> = unique_values
        .into_iter()
        .map(|value| {
            let selected = match &slicer.selected_items {
                None => true, // All selected
                Some(selected) => selected.contains(&value),
            };
            SlicerItem {
                value,
                selected,
                has_data: true, // For now, all items have data
            }
        })
        .collect();

    Ok(items)
}

// ============================================================================
// INTERNAL HELPERS
// ============================================================================

/// Get unique values from a table column.
fn get_table_column_values(state: &State<AppState>, slicer: &Slicer) -> Result<Vec<String>, String> {
    let tables = state.tables.lock().unwrap();
    let grids = state.grids.lock().unwrap();
    let style_registry = state.style_registry.lock().unwrap();

    // Find the table
    let table = tables
        .values()
        .flat_map(|sheet_tables| sheet_tables.values())
        .find(|t| t.id == slicer.source_id)
        .ok_or_else(|| format!("Table {} not found", slicer.source_id))?;

    // Find the column index by name
    let col_offset = table
        .columns
        .iter()
        .position(|c| c.name == slicer.field_name)
        .ok_or_else(|| format!("Column '{}' not found in table", slicer.field_name))?;

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
            format_cell_value(&cell.value, style)
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

/// Get unique values from a pivot table field.
fn get_pivot_field_values(
    pivot_state: &State<'_, PivotState>,
    slicer: &Slicer,
) -> Result<Vec<String>, String> {
    use pivot_engine::VALUE_ID_EMPTY;

    let pivot_id = slicer.source_id as PivotId;
    let mut pivot_tables = pivot_state.pivot_tables.lock().unwrap();
    let (_def, cache) = pivot_tables
        .get_mut(&pivot_id)
        .ok_or_else(|| format!("Pivot table {} not found", pivot_id))?;

    // Find the field index by name in the cache
    let field_index = cache
        .fields
        .iter()
        .position(|f| f.name == slicer.field_name)
        .ok_or_else(|| format!("Field '{}' not found in pivot cache", slicer.field_name))?;

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
