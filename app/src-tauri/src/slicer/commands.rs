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
        header_text: None,
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

    // Clean up computed properties for this slicer
    let mut computed_props = slicer_state.computed_properties.lock().unwrap();
    if let Some(props) = computed_props.remove(&slicer_id) {
        let mut deps = slicer_state.computed_prop_dependencies.lock().unwrap();
        let mut rev_deps = slicer_state.computed_prop_dependents.lock().unwrap();
        for prop in &props {
            if let Some(old_cells) = deps.remove(&prop.id) {
                for cell in &old_cells {
                    if let Some(prop_set) = rev_deps.get_mut(cell) {
                        prop_set.remove(&prop.id);
                        if prop_set.is_empty() {
                            rev_deps.remove(cell);
                        }
                    }
                }
            }
        }
    }

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
/// Cross-slicer filtering: checks other slicers on the same source to
/// determine which items still have matching data.
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

    // Collect filters from OTHER slicers on the same source (cross-filtering)
    let sibling_filters: Vec<(String, Vec<String>)> = slicers
        .values()
        .filter(|s| {
            s.id != slicer_id
                && s.source_type == slicer.source_type
                && s.source_id == slicer.source_id
                && s.selected_items.is_some()
        })
        .map(|s| (s.field_name.clone(), s.selected_items.clone().unwrap()))
        .collect();

    let unique_values = match slicer.source_type {
        SlicerSourceType::Table => get_table_column_values(&state, slicer)?,
        SlicerSourceType::Pivot => get_pivot_field_values(&pivot_state, slicer)?,
    };

    // Compute has_data by checking cross-slicer filters
    let has_data_set = if sibling_filters.is_empty() {
        None // No cross-filtering needed, all items have data
    } else {
        match slicer.source_type {
            SlicerSourceType::Table => {
                Some(get_table_available_values(&state, slicer, &sibling_filters)?)
            }
            SlicerSourceType::Pivot => {
                Some(get_pivot_available_values(&pivot_state, slicer, &sibling_filters)?)
            }
        }
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

/// Get unique values from a table column.
fn get_table_column_values(state: &State<AppState>, slicer: &Slicer) -> Result<Vec<String>, String> {
    let tables = state.tables.lock().unwrap();
    let grids = state.grids.lock().unwrap();
    let style_registry = state.style_registry.lock().unwrap();
    let locale = state.locale.lock().unwrap();

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
    slicer: &Slicer,
    sibling_filters: &[(String, Vec<String>)],
) -> Result<std::collections::HashSet<String>, String> {
    let tables = state.tables.lock().unwrap();
    let grids = state.grids.lock().unwrap();
    let style_registry = state.style_registry.lock().unwrap();
    let locale = state.locale.lock().unwrap();

    let table = tables
        .values()
        .flat_map(|sheet_tables| sheet_tables.values())
        .find(|t| t.id == slicer.source_id)
        .ok_or_else(|| format!("Table {} not found", slicer.source_id))?;

    // Find the target column index
    let target_col_offset = table
        .columns
        .iter()
        .position(|c| c.name == slicer.field_name)
        .ok_or_else(|| format!("Column '{}' not found", slicer.field_name))?;
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
                let style = style_registry.get(cell.style_index);
                format_cell_value(&cell.value, style, &locale)
            } else {
                String::new()
            };
            allowed.contains(&value)
        });

        if passes {
            // This row passes all sibling filters — record the target column value
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

/// Get values from a pivot field that still have data given cross-slicer filters.
/// Scans the cache records and checks each record against sibling slicer filters.
fn get_pivot_available_values(
    pivot_state: &State<'_, PivotState>,
    slicer: &Slicer,
    sibling_filters: &[(String, Vec<String>)],
) -> Result<std::collections::HashSet<String>, String> {
    use pivot_engine::VALUE_ID_EMPTY;

    let pivot_id = slicer.source_id as PivotId;
    let mut pivot_tables = pivot_state.pivot_tables.lock().unwrap();
    let (_def, cache) = pivot_tables
        .get_mut(&pivot_id)
        .ok_or_else(|| format!("Pivot table {} not found", pivot_id))?;

    // Find the target field index
    let target_field_idx = cache
        .fields
        .iter()
        .position(|f| f.name == slicer.field_name)
        .ok_or_else(|| format!("Field '{}' not found in pivot cache", slicer.field_name))?;

    // Resolve sibling filter field indices and their allowed ValueIds
    let filter_specs: Vec<(usize, std::collections::HashSet<String>)> = sibling_filters
        .iter()
        .filter_map(|(field_name, allowed)| {
            cache
                .fields
                .iter()
                .position(|f| &f.name == field_name)
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
