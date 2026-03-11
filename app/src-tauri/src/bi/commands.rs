//! FILENAME: app/src-tauri/src/bi/commands.rs
//! PURPOSE: Tauri commands for the BI extension — load models, connect to
//!          databases, bind tables, execute queries, and manage locked regions.
//! CONTEXT: All async commands use the bi-engine crate (Calcula Engine Lib).

use std::path::Path;

use arrow::array::{
    Array, BooleanArray, Date32Array, Decimal128Array,
    Float32Array, Float64Array, Int16Array, Int32Array, Int64Array,
    StringArray, TimestampMicrosecondArray,
};
use arrow::datatypes::DataType as ArrowDataType;
use tauri::State;

use crate::{
    log_info,
    AppState, Cell, CellStyle, ProtectedRegion,
    NamedRange,
};

use super::types::*;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Convert 0-based column index to Excel-style column letter (0 -> A, 25 -> Z, 26 -> AA).
fn index_to_col(mut idx: u32) -> String {
    let mut result = String::new();
    loop {
        result.insert(0, (b'A' + (idx % 26) as u8) as char);
        if idx < 26 {
            break;
        }
        idx = idx / 26 - 1;
    }
    result
}

/// Build a `BiModelInfo` from an Engine's DataModel.
fn model_to_info(model: &bi_engine::DataModel) -> BiModelInfo {
    let tables = model
        .tables()
        .iter()
        .map(|t| BiTableInfo {
            name: t.name().to_string(),
            columns: t
                .columns()
                .iter()
                .map(|c| BiColumnInfo {
                    name: c.name().to_string(),
                    data_type: format!("{:?}", c.data_type()),
                })
                .collect(),
        })
        .collect();

    let measures = model
        .measures()
        .iter()
        .map(|m| BiMeasureInfo {
            name: m.name().to_string(),
            table: m.table().to_string(),
        })
        .collect();

    let relationships = model
        .relationships()
        .iter()
        .map(|r| BiRelationshipInfo {
            name: r.name().to_string(),
            from_table: r.from_table().to_string(),
            from_column: r.from_column().to_string(),
            to_table: r.to_table().to_string(),
            to_column: r.to_column().to_string(),
        })
        .collect();

    BiModelInfo {
        tables,
        measures,
        relationships,
    }
}

/// Convert `Vec<RecordBatch>` to `BiQueryResult` (columns + string rows).
fn batches_to_result(batches: &[arrow::record_batch::RecordBatch]) -> BiQueryResult {
    if batches.is_empty() {
        return BiQueryResult {
            columns: vec![],
            rows: vec![],
            row_count: 0,
        };
    }

    // Column names from the first batch schema.
    let schema = batches[0].schema();
    let columns: Vec<String> = schema.fields().iter().map(|f| f.name().clone()).collect();

    let mut rows: Vec<Vec<Option<String>>> = Vec::new();

    for batch in batches {
        for row_idx in 0..batch.num_rows() {
            let mut row: Vec<Option<String>> = Vec::with_capacity(batch.num_columns());
            for col_idx in 0..batch.num_columns() {
                let col = batch.column(col_idx);
                row.push(arrow_value_to_string(col, row_idx));
            }
            rows.push(row);
        }
    }

    let row_count = rows.len();
    BiQueryResult {
        columns,
        rows,
        row_count,
    }
}

/// Extract a single cell from an Arrow array as an `Option<String>`.
fn arrow_value_to_string(array: &dyn Array, idx: usize) -> Option<String> {
    if array.is_null(idx) {
        return None;
    }
    match array.data_type() {
        ArrowDataType::Int16 => {
            let a = array.as_any().downcast_ref::<Int16Array>().unwrap();
            Some(a.value(idx).to_string())
        }
        ArrowDataType::Int32 => {
            let a = array.as_any().downcast_ref::<Int32Array>().unwrap();
            Some(a.value(idx).to_string())
        }
        ArrowDataType::Int64 => {
            let a = array.as_any().downcast_ref::<Int64Array>().unwrap();
            Some(a.value(idx).to_string())
        }
        ArrowDataType::Float32 => {
            let a = array.as_any().downcast_ref::<Float32Array>().unwrap();
            Some(a.value(idx).to_string())
        }
        ArrowDataType::Float64 => {
            let a = array.as_any().downcast_ref::<Float64Array>().unwrap();
            Some(a.value(idx).to_string())
        }
        ArrowDataType::Utf8 => {
            let a = array.as_any().downcast_ref::<StringArray>().unwrap();
            Some(a.value(idx).to_string())
        }
        ArrowDataType::Boolean => {
            let a = array.as_any().downcast_ref::<BooleanArray>().unwrap();
            Some(a.value(idx).to_string())
        }
        ArrowDataType::Date32 => {
            let a = array.as_any().downcast_ref::<Date32Array>().unwrap();
            let days = a.value(idx);
            // Convert days since epoch to ISO date string
            let date = chrono::NaiveDate::from_num_days_from_ce_opt(days + 719_163);
            match date {
                Some(d) => Some(d.format("%Y-%m-%d").to_string()),
                None => Some(days.to_string()),
            }
        }
        ArrowDataType::Timestamp(arrow::datatypes::TimeUnit::Microsecond, _) => {
            let a = array
                .as_any()
                .downcast_ref::<TimestampMicrosecondArray>()
                .unwrap();
            let us = a.value(idx);
            let secs = us / 1_000_000;
            let nsecs = ((us % 1_000_000) * 1000) as u32;
            let dt = chrono::DateTime::from_timestamp(secs, nsecs);
            match dt {
                Some(d) => Some(d.format("%Y-%m-%d %H:%M:%S").to_string()),
                None => Some(us.to_string()),
            }
        }
        ArrowDataType::Decimal128(_, scale) => {
            let a = array.as_any().downcast_ref::<Decimal128Array>().unwrap();
            let raw = a.value(idx);
            let scale = *scale as u32;
            if scale == 0 {
                Some(raw.to_string())
            } else {
                let divisor = 10i128.pow(scale);
                let whole = raw / divisor;
                let frac = (raw % divisor).abs();
                Some(format!("{}.{:0>width$}", whole, frac, width = scale as usize))
            }
        }
        _ => {
            // Fallback: show unsupported type
            Some(format!("<unsupported: {:?}>", array.data_type()))
        }
    }
}

/// Try to parse a string value as f64 for numeric cells.
fn try_parse_number(s: &str) -> Option<f64> {
    s.parse::<f64>().ok()
}

// ---------------------------------------------------------------------------
// Tauri Commands
// ---------------------------------------------------------------------------

/// Load a data model JSON file exported from Calcula Studio.
#[tauri::command]
pub async fn bi_load_model(
    bi_state: State<'_, BiState>,
    path: String,
) -> Result<BiModelInfo, String> {
    log_info!("BI", "bi_load_model: path={}", path);

    let model = bi_engine::Engine::load_model(Path::new(&path))
        .map_err(|e| format!("Failed to load model: {}", e))?;

    let info = model_to_info(&model);
    let engine = bi_engine::Engine::new(model);

    let mut eng_lock = bi_state.engine.lock().unwrap();
    *eng_lock = Some(engine);

    // Reset connection state when loading a new model
    *bi_state.connector_index.lock().unwrap() = None;
    *bi_state.connection_string.lock().unwrap() = None;
    *bi_state.active_query.lock().unwrap() = None;

    log_info!(
        "BI",
        "Model loaded: {} tables, {} measures, {} relationships",
        info.tables.len(),
        info.measures.len(),
        info.relationships.len()
    );

    Ok(info)
}

/// Connect to a PostgreSQL database.
#[tauri::command]
pub async fn bi_connect(
    bi_state: State<'_, BiState>,
    request: BiConnectRequest,
) -> Result<String, String> {
    log_info!("BI", "bi_connect: connecting...");

    let config = bi_engine::PostgresConfig::new(&request.connection_string);

    // Take the engine out of the Mutex so the lock is dropped before the async call.
    let mut engine = bi_state.engine.lock().unwrap().take()
        .ok_or("No model loaded. Load a model first.")?;

    let idx = engine
        .add_postgres(config)
        .await
        .map_err(|e| format!("Connection failed: {}", e))?;

    // Put the engine back
    *bi_state.engine.lock().unwrap() = Some(engine);
    *bi_state.connector_index.lock().unwrap() = Some(idx);
    *bi_state.connection_string.lock().unwrap() = Some(request.connection_string.clone());

    log_info!("BI", "Connected to PostgreSQL, connector_index={}", idx);
    Ok(format!("Connected successfully (source index {})", idx))
}

/// Bind a model table to a database schema/table.
#[tauri::command]
pub async fn bi_bind_table(
    bi_state: State<'_, BiState>,
    request: BiBindRequest,
) -> Result<String, String> {
    log_info!(
        "BI",
        "bi_bind_table: {} -> {}.{}",
        request.model_table,
        request.schema,
        request.source_table
    );

    let connector_index = bi_state
        .connector_index
        .lock()
        .unwrap()
        .ok_or("No database connection. Connect first.")?;

    let mut eng_lock = bi_state.engine.lock().unwrap();
    let engine = eng_lock
        .as_mut()
        .ok_or("No model loaded. Load a model first.")?;

    let binding = bi_engine::SourceBinding::new(&request.schema, &request.source_table);
    engine.bind_table(&request.model_table, connector_index, binding);

    Ok(format!(
        "Bound '{}' to {}.{}",
        request.model_table, request.schema, request.source_table
    ))
}

/// Execute a BI query and return results as rows.
#[tauri::command]
pub async fn bi_query(
    bi_state: State<'_, BiState>,
    request: BiQueryRequest,
) -> Result<BiQueryResult, String> {
    log_info!(
        "BI",
        "bi_query: measures={:?}, group_by={:?}",
        request.measures,
        request.group_by.iter().map(|g| format!("{}.{}", g.table, g.column)).collect::<Vec<_>>()
    );

    // Build the Engine query request
    let query_request = bi_engine::QueryRequest {
        measures: request.measures.clone(),
        group_by: request
            .group_by
            .iter()
            .map(|g| bi_engine::ColumnRef::new(&g.table, &g.column))
            .collect(),
        filters: request
            .filters
            .iter()
            .map(|f| {
                bi_engine::FilterCondition {
                    column: f.column.clone(),
                    operator: match f.operator.as_str() {
                        "=" | "eq" => bi_engine::FilterOperator::Equal,
                        "!=" | "ne" => bi_engine::FilterOperator::NotEqual,
                        ">" | "gt" => bi_engine::FilterOperator::GreaterThan,
                        "<" | "lt" => bi_engine::FilterOperator::LessThan,
                        ">=" | "gte" => bi_engine::FilterOperator::GreaterThanOrEqual,
                        "<=" | "lte" => bi_engine::FilterOperator::LessThanOrEqual,
                        _ => bi_engine::FilterOperator::Equal,
                    },
                    value: f.value.clone(),
                }
            })
            .collect(),
        lookups: vec![],
    };

    // Take the engine out for the async query
    let engine = bi_state.engine.lock().unwrap().take()
        .ok_or("No model loaded. Load a model first.")?;

    let batches = engine
        .query(query_request)
        .await
        .map_err(|e| format!("Query failed: {}", e))?;

    // Put engine back
    *bi_state.engine.lock().unwrap() = Some(engine);

    let result = batches_to_result(&batches);
    log_info!("BI", "Query returned {} rows, {} columns", result.row_count, result.columns.len());

    Ok(result)
}

/// Insert the last query result into the grid as a locked region.
#[tauri::command]
pub async fn bi_insert_result(
    state: State<'_, AppState>,
    bi_state: State<'_, BiState>,
    request: BiInsertRequest,
    query_result: BiQueryResult,
    query_request: BiQueryRequest,
) -> Result<BiInsertResponse, String> {
    log_info!(
        "BI",
        "bi_insert_result: sheet={} at ({},{}), {} rows x {} cols",
        request.sheet_index,
        request.start_row,
        request.start_col,
        query_result.row_count,
        query_result.columns.len()
    );

    if query_result.columns.is_empty() {
        return Err("No query result to insert.".to_string());
    }

    let num_cols = query_result.columns.len() as u32;
    let num_data_rows = query_result.row_count as u32;
    let total_rows = num_data_rows + 1; // header + data

    let start_row = request.start_row;
    let start_col = request.start_col;
    let end_row = start_row + total_rows - 1;
    let end_col = start_col + num_cols - 1;

    // Create bold style for headers
    let bold_style_idx = {
        let mut styles = state.style_registry.lock().unwrap();
        let style = CellStyle::new().with_bold(true);
        styles.get_or_create(style)
    };

    // Write cells to grid
    {
        let mut grids = state.grids.lock().unwrap();
        let grid = grids
            .get_mut(request.sheet_index)
            .ok_or("Invalid sheet index")?;

        // Write header row
        for (col_idx, col_name) in query_result.columns.iter().enumerate() {
            let mut cell = Cell::new_text(col_name.clone());
            cell.style_index = bold_style_idx;
            grid.set_cell(start_row, start_col + col_idx as u32, cell);
        }

        // Write data rows
        for (row_idx, row) in query_result.rows.iter().enumerate() {
            let grid_row = start_row + 1 + row_idx as u32;
            for (col_idx, value) in row.iter().enumerate() {
                let grid_col = start_col + col_idx as u32;
                let cell = match value {
                    Some(s) => {
                        if let Some(num) = try_parse_number(s) {
                            Cell::new_number(num)
                        } else {
                            Cell::new_text(s.clone())
                        }
                    }
                    None => Cell::new(),
                };
                grid.set_cell(grid_row, grid_col, cell);
            }
        }
    }

    // Sync to active grid if this is the active sheet
    {
        let active_sheet = *state.active_sheet.lock().unwrap();
        if request.sheet_index == active_sheet {
            let grids = state.grids.lock().unwrap();
            if let Some(src_grid) = grids.get(request.sheet_index) {
                let mut active_grid = state.grid.lock().unwrap();
                for ((r, c), cell) in src_grid.cells.iter() {
                    if *r >= start_row && *r <= end_row && *c >= start_col && *c <= end_col {
                        active_grid.set_cell(*r, *c, cell.clone());
                    }
                }
            }
        }
    }

    // Generate region ID
    let region_id = {
        let mut next_id = bi_state.next_region_id.lock().unwrap();
        let id = *next_id;
        *next_id += 1;
        id
    };

    // Create protected region
    {
        let mut regions = state.protected_regions.lock().unwrap();
        // Remove any existing BI region with this ID
        regions.retain(|r| !(r.region_type == "bi" && r.owner_id == region_id));
        regions.push(ProtectedRegion {
            id: format!("bi-{}", region_id),
            region_type: "bi".to_string(),
            owner_id: region_id,
            sheet_index: request.sheet_index,
            start_row,
            start_col,
            end_row,
            end_col,
        });
    }

    // Create named ranges for each result column
    {
        let sheet_names = state.sheet_names.lock().unwrap();
        let sheet_name = sheet_names
            .get(request.sheet_index)
            .cloned()
            .unwrap_or_else(|| format!("Sheet{}", request.sheet_index + 1));

        let mut named_ranges = state.named_ranges.lock().unwrap();

        for (col_idx, col_name) in query_result.columns.iter().enumerate() {
            // Sanitize column name for use as named range identifier
            let safe_name: String = col_name
                .chars()
                .map(|c| if c.is_alphanumeric() || c == '_' { c } else { '_' })
                .collect();
            let range_name = format!("BIResult.{}", safe_name);
            let col_letter = index_to_col(start_col + col_idx as u32);
            let data_start_row = start_row + 2; // 1-based, skip header
            let data_end_row = end_row + 1; // 1-based
            let refers_to = format!(
                "={}!${}${}:${}${}",
                sheet_name, col_letter, data_start_row, col_letter, data_end_row
            );

            let key = range_name.to_uppercase();
            // Update if exists, create if not
            named_ranges.insert(
                key,
                NamedRange {
                    name: range_name,
                    sheet_index: None, // workbook-scoped
                    refers_to,
                    comment: Some(format!("BI query result column: {}", col_name)),
                    folder: Some("BI Results".to_string()),
                },
            );
        }
    }

    // Store active query for refresh
    {
        let mut aq = bi_state.active_query.lock().unwrap();
        *aq = Some(ActiveQuery {
            request: query_request,
            sheet_index: request.sheet_index,
            start_row,
            start_col,
            end_row,
            end_col,
            region_id,
        });
    }

    let response = BiInsertResponse {
        start_row,
        start_col,
        end_row,
        end_col,
        region_id: format!("bi-{}", region_id),
    };

    log_info!(
        "BI",
        "Inserted BI result region bi-{}: ({},{}) to ({},{})",
        region_id,
        start_row,
        start_col,
        end_row,
        end_col
    );

    Ok(response)
}

/// Refresh the BI query — re-execute and update the locked region in-place.
#[tauri::command]
pub async fn bi_refresh(
    state: State<'_, AppState>,
    bi_state: State<'_, BiState>,
) -> Result<BiQueryResult, String> {
    log_info!("BI", "bi_refresh: re-executing query...");

    // Get the active query metadata
    let active_query = bi_state
        .active_query
        .lock()
        .unwrap()
        .clone()
        .ok_or("No active query to refresh. Insert a result first.")?;

    // Build the Engine query request
    let query_request = bi_engine::QueryRequest {
        measures: active_query.request.measures.clone(),
        group_by: active_query
            .request
            .group_by
            .iter()
            .map(|g| bi_engine::ColumnRef::new(&g.table, &g.column))
            .collect(),
        filters: active_query
            .request
            .filters
            .iter()
            .map(|f| bi_engine::FilterCondition {
                column: f.column.clone(),
                operator: match f.operator.as_str() {
                    "=" | "eq" => bi_engine::FilterOperator::Equal,
                    "!=" | "ne" => bi_engine::FilterOperator::NotEqual,
                    ">" | "gt" => bi_engine::FilterOperator::GreaterThan,
                    "<" | "lt" => bi_engine::FilterOperator::LessThan,
                    ">=" | "gte" => bi_engine::FilterOperator::GreaterThanOrEqual,
                    "<=" | "lte" => bi_engine::FilterOperator::LessThanOrEqual,
                    _ => bi_engine::FilterOperator::Equal,
                },
                value: f.value.clone(),
            })
            .collect(),
        lookups: vec![],
    };

    // Take the engine out for the async query
    let engine = bi_state
        .engine
        .lock()
        .unwrap()
        .take()
        .ok_or("No model loaded.")?;

    let batches = engine
        .query(query_request)
        .await
        .map_err(|e| format!("Refresh query failed: {}", e))?;

    // Put engine back
    *bi_state.engine.lock().unwrap() = Some(engine);

    let result = batches_to_result(&batches);

    let new_num_cols = result.columns.len() as u32;
    let new_num_data_rows = result.row_count as u32;
    let new_total_rows = new_num_data_rows + 1; // header + data

    let start_row = active_query.start_row;
    let start_col = active_query.start_col;
    let new_end_row = start_row + new_total_rows - 1;
    let new_end_col = start_col + new_num_cols - 1;

    // Clear old region cells
    {
        let mut grids = state.grids.lock().unwrap();
        let grid = grids
            .get_mut(active_query.sheet_index)
            .ok_or("Invalid sheet index")?;

        for r in active_query.start_row..=active_query.end_row {
            for c in active_query.start_col..=active_query.end_col {
                grid.set_cell(r, c, Cell::new());
            }
        }
    }

    // Create bold style for headers
    let bold_style_idx = {
        let mut styles = state.style_registry.lock().unwrap();
        let style = CellStyle::new().with_bold(true);
        styles.get_or_create(style)
    };

    // Write new data
    {
        let mut grids = state.grids.lock().unwrap();
        let grid = grids
            .get_mut(active_query.sheet_index)
            .ok_or("Invalid sheet index")?;

        // Header row
        for (col_idx, col_name) in result.columns.iter().enumerate() {
            let mut cell = Cell::new_text(col_name.clone());
            cell.style_index = bold_style_idx;
            grid.set_cell(start_row, start_col + col_idx as u32, cell);
        }

        // Data rows
        for (row_idx, row) in result.rows.iter().enumerate() {
            let grid_row = start_row + 1 + row_idx as u32;
            for (col_idx, value) in row.iter().enumerate() {
                let grid_col = start_col + col_idx as u32;
                let cell = match value {
                    Some(s) => {
                        if let Some(num) = try_parse_number(s) {
                            Cell::new_number(num)
                        } else {
                            Cell::new_text(s.clone())
                        }
                    }
                    None => Cell::new(),
                };
                grid.set_cell(grid_row, grid_col, cell);
            }
        }
    }

    // Sync to active grid
    {
        let active_sheet = *state.active_sheet.lock().unwrap();
        if active_query.sheet_index == active_sheet {
            let grids = state.grids.lock().unwrap();
            if let Some(src_grid) = grids.get(active_query.sheet_index) {
                let mut active_grid = state.grid.lock().unwrap();
                // Clear old area
                for r in active_query.start_row..=active_query.end_row {
                    for c in active_query.start_col..=active_query.end_col {
                        active_grid.set_cell(r, c, Cell::new());
                    }
                }
                // Write new area
                let write_end_row = std::cmp::max(active_query.end_row, new_end_row);
                let write_end_col = std::cmp::max(active_query.end_col, new_end_col);
                for r in start_row..=write_end_row {
                    for c in start_col..=write_end_col {
                        if let Some(cell) = src_grid.cells.get(&(r, c)) {
                            active_grid.set_cell(r, c, cell.clone());
                        }
                    }
                }
            }
        }
    }

    // Update protected region bounds
    {
        let mut regions = state.protected_regions.lock().unwrap();
        if let Some(region) = regions
            .iter_mut()
            .find(|r| r.region_type == "bi" && r.owner_id == active_query.region_id)
        {
            region.end_row = new_end_row;
            region.end_col = new_end_col;
        }
    }

    // Update named ranges
    {
        let sheet_names = state.sheet_names.lock().unwrap();
        let sheet_name = sheet_names
            .get(active_query.sheet_index)
            .cloned()
            .unwrap_or_else(|| format!("Sheet{}", active_query.sheet_index + 1));

        let mut named_ranges = state.named_ranges.lock().unwrap();

        for (col_idx, col_name) in result.columns.iter().enumerate() {
            let safe_name: String = col_name
                .chars()
                .map(|c| if c.is_alphanumeric() || c == '_' { c } else { '_' })
                .collect();
            let range_name = format!("BIResult.{}", safe_name);
            let col_letter = index_to_col(start_col + col_idx as u32);
            let data_start_row = start_row + 2;
            let data_end_row = new_end_row + 1;
            let refers_to = format!(
                "={}!${}${}:${}${}",
                sheet_name, col_letter, data_start_row, col_letter, data_end_row
            );

            let key = range_name.to_uppercase();
            named_ranges.insert(
                key,
                NamedRange {
                    name: range_name,
                    sheet_index: None,
                    refers_to,
                    comment: Some(format!("BI query result column: {}", col_name)),
                    folder: Some("BI Results".to_string()),
                },
            );
        }
    }

    // Update active query metadata
    {
        let mut aq = bi_state.active_query.lock().unwrap();
        if let Some(ref mut q) = *aq {
            q.end_row = new_end_row;
            q.end_col = new_end_col;
        }
    }

    log_info!(
        "BI",
        "Refresh complete: {} rows, region ({},{}) to ({},{})",
        result.row_count,
        start_row,
        start_col,
        new_end_row,
        new_end_col
    );

    Ok(result)
}

/// Return the currently loaded model info, or null if no model is loaded.
#[tauri::command]
pub async fn bi_get_model_info(
    bi_state: State<'_, BiState>,
) -> Result<Option<BiModelInfo>, String> {
    let eng_lock = bi_state.engine.lock().unwrap();
    match eng_lock.as_ref() {
        Some(engine) => Ok(Some(model_to_info(engine.model()))),
        None => Ok(None),
    }
}

/// Check if a cell is within a BI protected region.
#[tauri::command]
pub async fn bi_get_region_at_cell(
    state: State<'_, AppState>,
    row: u32,
    col: u32,
) -> Result<Option<BiRegionInfo>, String> {
    let active_sheet = *state.active_sheet.lock().unwrap();
    let regions = state.protected_regions.lock().unwrap();

    for region in regions.iter() {
        if region.region_type == "bi"
            && region.sheet_index == active_sheet
            && row >= region.start_row
            && row <= region.end_row
            && col >= region.start_col
            && col <= region.end_col
        {
            return Ok(Some(BiRegionInfo {
                region_id: region.id.clone(),
                start_row: region.start_row,
                start_col: region.start_col,
                end_row: region.end_row,
                end_col: region.end_col,
            }));
        }
    }

    Ok(None)
}
