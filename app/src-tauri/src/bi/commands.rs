//! FILENAME: app/src-tauri/src/bi/commands.rs
//! PURPOSE: Tauri commands for the BI extension — multi-connection model.
//!          Create/delete/manage connections, load models, connect to databases,
//!          bind tables, execute queries, and manage locked regions.
//! CONTEXT: All async commands use the bi-engine crate (Calcula Engine Lib).
//!          Engines are shared via Arc<TokioMutex<Engine>> through the EngineRegistry.

use std::path::Path;
use std::sync::Arc;
use tokio::sync::Mutex as TokioMutex;

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
use super::engine_registry::{EngineRegistry, ModelKey};

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
            Some(format!("<unsupported: {:?}>", array.data_type()))
        }
    }
}

/// Try to parse a string value as f64 for numeric cells.
fn try_parse_number(s: &str) -> Option<f64> {
    s.parse::<f64>().ok()
}

/// Get current ISO 8601 timestamp.
fn now_iso() -> String {
    chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string()
}

/// Build an engine QueryRequest from BiQueryRequest.
fn build_engine_query(request: &BiQueryRequest) -> bi_engine::QueryRequest {
    bi_engine::QueryRequest {
        measures: request.measures.clone(),
        group_by: request
            .group_by
            .iter()
            .map(|g| bi_engine::ColumnRef::new(&g.table, &g.column))
            .collect(),
        filters: request
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
    }
}

/// Helper: get the engine Arc from a connection by ID.
/// Briefly locks the connections mutex, clones the Arc, then releases.
fn get_engine_arc(
    bi_state: &BiState,
    connection_id: ConnectionId,
) -> Result<Arc<TokioMutex<bi_engine::Engine>>, String> {
    let connections = bi_state.connections.lock().unwrap();
    let conn = connections.get(&connection_id)
        .ok_or_else(|| format!("Connection {} not found", connection_id))?;
    conn.engine.clone()
        .ok_or_else(|| "No model loaded.".to_string())
}

// ---------------------------------------------------------------------------
// Tauri Commands — Connection Management
// ---------------------------------------------------------------------------

/// Create a new connection: loads the model, registers in the shared engine registry,
/// loads disk cache, and refreshes stale tables.
/// Does NOT connect to the database yet — call `bi_connect` for that.
#[tauri::command]
pub async fn bi_create_connection(
    bi_state: State<'_, BiState>,
    request: CreateConnectionRequest,
) -> Result<ConnectionInfo, String> {
    log_info!("BI", "bi_create_connection: name={}", request.name);

    // Load model from file
    let json_str = std::fs::read_to_string(Path::new(&request.model_path))
        .map_err(|e| format!("Failed to read file: {}", e))?;

    let json_value: serde_json::Value = serde_json::from_str(&json_str)
        .map_err(|e| format!("Failed to parse JSON: {}", e))?;

    // Detect ModelBundle format (has "formatVersion" at top level)
    let model_json = if json_value.get("formatVersion").is_some() {
        log_info!("BI", "Detected Calcula Studio ModelBundle format");
        json_value.get("model")
            .ok_or_else(|| "ModelBundle missing 'model' field".to_string())?
            .clone()
    } else {
        json_value
    };

    let model: bi_engine::DataModel = serde_json::from_value(model_json)
        .map_err(|e| format!("Failed to parse model: {}", e))?;
    model.validate().map_err(|e| format!("Model validation failed: {}", e))?;

    let model_key = ModelKey::from_model_path(&request.model_path);

    // Get or create shared engine via the registry
    let engine = bi_engine::Engine::new(model);
    let (engine_arc, was_existing, cache_dir) =
        bi_state.engine_registry.get_or_create(&model_key, engine);

    // If this is a new engine (not reused), load disk cache and refresh stale tables
    if !was_existing {
        let mut engine_guard = engine_arc.lock().await;

        // Step 1: Load disk cache (fast, from local files)
        // DEV: Log disk cache load results
        let cached_tables = EngineRegistry::load_cache(&mut engine_guard, &cache_dir);
        if !cached_tables.is_empty() {
            log_info!("BI", "Startup: loaded {} tables from DISK CACHE: {}", cached_tables.len(), cached_tables.join(", "));
        } else {
            log_info!("BI", "Startup: no DISK CACHE found, all tables will be fetched from DATABASE on first query");
        }

        // Step 2: refresh_stale requires a database connection, so we defer it.
        // It will happen automatically via query_auto_refresh on first query.
        // If the user explicitly connects (bi_connect), we can refresh then.

        drop(engine_guard);
    }

    // Generate ID
    let id = {
        let mut next_id = bi_state.next_connection_id.lock().unwrap();
        let id = *next_id;
        *next_id += 1;
        id
    };

    let connection = Connection {
        id,
        name: request.name,
        description: request.description.unwrap_or_default(),
        connection_type: ConnectionType::PostgreSQL,
        connection_string: request.connection_string,
        model_path: Some(request.model_path),
        engine: Some(engine_arc),
        model_key: Some(model_key),
        connector_index: None,
        bindings: Vec::new(),
        last_refreshed: None,
        created_at: now_iso(),
        is_connected: false,
        active_queries: std::collections::HashMap::new(),
    };

    let info = connection.to_info();
    bi_state.connections.lock().unwrap().insert(id, connection);

    log_info!(
        "BI",
        "Connection created: id={}, tables={}, measures={}",
        id,
        info.table_count,
        info.measure_count
    );

    Ok(info)
}

/// Delete a connection by ID.
/// Releases the shared engine reference; saves cache if this was the last reference.
#[tauri::command]
pub async fn bi_delete_connection(
    bi_state: State<'_, BiState>,
    state: State<'_, AppState>,
    connection_id: ConnectionId,
) -> Result<(), String> {
    log_info!("BI", "bi_delete_connection: id={}", connection_id);

    let (model_key, region_ids) = {
        let mut connections = bi_state.connections.lock().unwrap();
        let conn = connections.remove(&connection_id)
            .ok_or_else(|| format!("Connection {} not found", connection_id))?;

        let region_ids: Vec<u64> = conn.active_queries.keys().copied().collect();
        (conn.model_key, region_ids)
    };

    // Remove any protected regions owned by this connection's queries
    if !region_ids.is_empty() {
        let mut regions = state.protected_regions.lock().unwrap();
        regions.retain(|r| {
            !(r.region_type == "bi" && region_ids.contains(&r.owner_id))
        });
    }

    // Release the shared engine reference (saves cache if last ref)
    if let Some(key) = model_key {
        bi_state.engine_registry.release(&key);
    }

    Ok(())
}

/// Update connection name/description/connection_string.
#[tauri::command]
pub async fn bi_update_connection(
    bi_state: State<'_, BiState>,
    request: UpdateConnectionRequest,
) -> Result<ConnectionInfo, String> {
    log_info!("BI", "bi_update_connection: id={}", request.id);

    let mut connections = bi_state.connections.lock().unwrap();
    let conn = connections.get_mut(&request.id)
        .ok_or_else(|| format!("Connection {} not found", request.id))?;

    if let Some(name) = request.name {
        conn.name = name;
    }
    if let Some(desc) = request.description {
        conn.description = desc;
    }
    if let Some(cs) = request.connection_string {
        conn.connection_string = cs;
        // Changing connection string invalidates the database connection
        conn.connector_index = None;
        conn.is_connected = false;
    }

    Ok(conn.to_info())
}

/// Get all connections.
#[tauri::command]
pub async fn bi_get_connections(
    bi_state: State<'_, BiState>,
) -> Result<Vec<ConnectionInfo>, String> {
    let connections = bi_state.connections.lock().unwrap();
    let mut infos: Vec<ConnectionInfo> = connections.values().map(|c| c.to_info()).collect();
    infos.sort_by_key(|c| c.id);
    Ok(infos)
}

/// Get a single connection by ID.
#[tauri::command]
pub async fn bi_get_connection(
    bi_state: State<'_, BiState>,
    connection_id: ConnectionId,
) -> Result<ConnectionInfo, String> {
    let connections = bi_state.connections.lock().unwrap();
    let conn = connections.get(&connection_id)
        .ok_or_else(|| format!("Connection {} not found", connection_id))?;
    Ok(conn.to_info())
}

// ---------------------------------------------------------------------------
// Tauri Commands — Connect / Disconnect / Bind
// ---------------------------------------------------------------------------

/// Connect a connection to its PostgreSQL database, then refresh stale cached tables.
#[tauri::command]
pub async fn bi_connect(
    bi_state: State<'_, BiState>,
    request: BiConnectRequest,
) -> Result<ConnectionInfo, String> {
    let connection_id = request.connection_id;
    log_info!("BI", "bi_connect: connection_id={}", connection_id);

    // Get the engine Arc and connection string
    let (engine_arc, conn_str) = {
        let connections = bi_state.connections.lock().unwrap();
        let conn = connections.get(&connection_id)
            .ok_or_else(|| format!("Connection {} not found", connection_id))?;
        let engine_arc = conn.engine.clone()
            .ok_or("No model loaded for this connection.")?;
        (engine_arc, conn.connection_string.clone())
    };

    // Lock the shared engine for async database connection
    let idx = {
        let mut engine = engine_arc.lock().await;
        let config = bi_engine::PostgresConfig::new(&conn_str);
        engine.add_postgres(config).await
            .map_err(|e| format!("Connection failed: {}", e))?
    };

    // After connecting, refresh stale tables (if any were loaded from disk cache)
    {
        let mut engine = engine_arc.lock().await;
        match engine.refresh_stale().await {
            Ok(refreshed) => {
                if !refreshed.is_empty() {
                    log_info!("BI", "Refreshed stale tables after connect: {}", refreshed.join(", "));
                }
            }
            Err(e) => {
                log_info!("BI", "refresh_stale after connect failed (non-fatal): {}", e);
            }
        }
    }

    // Update connection state
    let info = {
        let mut connections = bi_state.connections.lock().unwrap();
        let conn = connections.get_mut(&connection_id)
            .ok_or_else(|| format!("Connection {} not found", connection_id))?;
        conn.connector_index = Some(idx);
        conn.is_connected = true;
        conn.to_info()
    };

    // Save cache to disk after successful refresh (crash protection)
    save_cache_for_connection(&bi_state, connection_id).await;

    log_info!("BI", "Connected: id={}, connector_index={}", connection_id, idx);
    Ok(info)
}

/// Disconnect a connection (drops the database link but keeps the engine/model).
#[tauri::command]
pub async fn bi_disconnect(
    bi_state: State<'_, BiState>,
    connection_id: ConnectionId,
) -> Result<ConnectionInfo, String> {
    log_info!("BI", "bi_disconnect: connection_id={}", connection_id);

    let mut connections = bi_state.connections.lock().unwrap();
    let conn = connections.get_mut(&connection_id)
        .ok_or_else(|| format!("Connection {} not found", connection_id))?;

    conn.connector_index = None;
    conn.is_connected = false;

    Ok(conn.to_info())
}

/// Bind a model table to a database schema/table on a specific connection.
#[tauri::command]
pub async fn bi_bind_table(
    bi_state: State<'_, BiState>,
    connection_id: ConnectionId,
    request: BiBindRequest,
) -> Result<String, String> {
    log_info!(
        "BI",
        "bi_bind_table: conn={}, {} -> {}.{}",
        connection_id,
        request.model_table,
        request.schema,
        request.source_table
    );

    let (engine_arc, connector_index) = {
        let connections = bi_state.connections.lock().unwrap();
        let conn = connections.get(&connection_id)
            .ok_or_else(|| format!("Connection {} not found", connection_id))?;
        let connector_index = conn.connector_index
            .ok_or("Not connected to a database. Connect first.")?;
        let engine_arc = conn.engine.clone()
            .ok_or("No model loaded.")?;
        (engine_arc, connector_index)
    };

    {
        let mut engine = engine_arc.lock().await;
        let binding = bi_engine::SourceBinding::new(&request.schema, &request.source_table);
        engine.bind_table(&request.model_table, connector_index, binding);
    }

    // Store binding for potential re-connect
    {
        let mut connections = bi_state.connections.lock().unwrap();
        if let Some(conn) = connections.get_mut(&connection_id) {
            conn.bindings.push(request.clone());
        }
    }

    Ok(format!(
        "Bound '{}' to {}.{}",
        request.model_table, request.schema, request.source_table
    ))
}

// ---------------------------------------------------------------------------
// Tauri Commands — Query & Insert
// ---------------------------------------------------------------------------

/// Execute a BI query on a specific connection and return results as rows.
#[tauri::command]
pub async fn bi_query(
    bi_state: State<'_, BiState>,
    connection_id: ConnectionId,
    request: BiQueryRequest,
) -> Result<BiQueryResult, String> {
    log_info!(
        "BI",
        "bi_query: conn={}, measures={:?}, group_by={:?}",
        connection_id,
        request.measures,
        request.group_by.iter().map(|g| format!("{}.{}", g.table, g.column)).collect::<Vec<_>>()
    );

    let query_request = build_engine_query(&request);
    let engine_arc = get_engine_arc(&bi_state, connection_id)?;

    let (batches, refreshed_tables) = {
        let mut engine = engine_arc.lock().await;
        engine.query_auto_refresh(query_request).await
            .map_err(|e| format!("Query failed: {}", e))?
    };

    // DEV: Log data source (cache vs database)
    if refreshed_tables.is_empty() {
        log_info!("BI", "bi_query: data served from CACHE (no tables refreshed)");
    } else {
        log_info!("BI", "bi_query: data fetched from DATABASE for: {}", refreshed_tables.join(", "));
        // Save cache after auto-refresh (crash protection)
        save_cache_for_connection(&bi_state, connection_id).await;
    }

    // Update last_refreshed timestamp
    {
        let mut connections = bi_state.connections.lock().unwrap();
        if let Some(conn) = connections.get_mut(&connection_id) {
            conn.last_refreshed = Some(now_iso());
        }
    }

    let result = batches_to_result(&batches);
    log_info!("BI", "Query returned {} rows, {} columns", result.row_count, result.columns.len());

    Ok(result)
}

/// Get distinct values for a column from a BI connection.
/// Executes a GROUP BY query with no measures to retrieve unique values.
/// Used by slicers and ribbon filters that connect directly to a BI model.
/// Auto-connects and auto-binds the table if needed.
#[tauri::command]
pub async fn bi_get_column_values(
    bi_state: State<'_, BiState>,
    connection_id: ConnectionId,
    table: String,
    column: String,
) -> Result<Vec<String>, String> {
    log_info!(
        "BI",
        "bi_get_column_values: conn={}, {}.{}",
        connection_id,
        table,
        column
    );

    // Auto-connect if not already connected
    auto_connect_bi_connection(&bi_state, connection_id).await?;

    // Auto-bind ALL model tables — the query planner may need fact tables
    // for measure computation even when we only group by a dimension column.
    {
        let engine_arc = get_engine_arc(&bi_state, connection_id)?;
        let all_tables: Vec<String> = {
            let engine = engine_arc.lock().await;
            engine.model().tables().iter()
                .map(|t| t.name().to_string())
                .collect()
        };
        auto_bind_tables_on_connection(
            &bi_state,
            connection_id,
            &all_tables.iter().map(|s| s.as_str()).collect::<Vec<_>>(),
        ).await?;
    }

    // The BI engine requires at least one measure. Pick the first available.
    let first_measure = {
        let engine_arc = get_engine_arc(&bi_state, connection_id)?;
        let engine = engine_arc.lock().await;
        engine.model().measures().first()
            .map(|m| m.name().to_string())
            .ok_or_else(|| "No measures in model -- cannot query column values".to_string())?
    };

    let query_request = bi_engine::QueryRequest {
        measures: vec![first_measure],
        group_by: vec![bi_engine::ColumnRef::new(&table, &column)],
        filters: vec![],
        lookups: vec![],
    };

    let engine_arc = get_engine_arc(&bi_state, connection_id)?;
    let (batches, refreshed_tables) = {
        let mut engine = engine_arc.lock().await;
        engine.query_auto_refresh(query_request).await
            .map_err(|e| format!("Query failed: {}", e))?
    };

    // DEV: Log data source (cache vs database)
    if refreshed_tables.is_empty() {
        log_info!("BI", "bi_get_column_values: data served from CACHE");
    } else {
        log_info!("BI", "bi_get_column_values: data fetched from DATABASE for: {}", refreshed_tables.join(", "));
    }

    // Extract unique values from the first column (group_by column)
    let mut values: Vec<String> = Vec::new();
    for batch in &batches {
        if batch.num_columns() == 0 {
            continue;
        }
        let col = batch.column(0);
        for row_idx in 0..batch.num_rows() {
            if let Some(v) = arrow_value_to_string(col, row_idx) {
                if !v.is_empty() {
                    values.push(v);
                }
            }
        }
    }

    values.sort();
    values.dedup();

    log_info!(
        "BI",
        "bi_get_column_values: returned {} unique values",
        values.len()
    );

    Ok(values)
}

/// Get distinct values for a column, filtered by cross-filter constraints.
#[tauri::command]
pub async fn bi_get_column_available_values(
    bi_state: State<'_, BiState>,
    connection_id: ConnectionId,
    table: String,
    column: String,
    cross_filters: Vec<BiCrossFilter>,
) -> Result<Vec<String>, String> {
    // Auto-connect + auto-bind
    auto_connect_bi_connection(&bi_state, connection_id).await?;
    {
        let engine_arc = get_engine_arc(&bi_state, connection_id)?;
        let all_tables: Vec<String> = {
            let engine = engine_arc.lock().await;
            engine.model().tables().iter()
                .map(|t| t.name().to_string())
                .collect()
        };
        auto_bind_tables_on_connection(
            &bi_state,
            connection_id,
            &all_tables.iter().map(|s| s.as_str()).collect::<Vec<_>>(),
        ).await?;
    }

    let first_measure = {
        let engine_arc = get_engine_arc(&bi_state, connection_id)?;
        let engine = engine_arc.lock().await;
        engine.model().measures().first()
            .map(|m| m.name().to_string())
            .ok_or_else(|| "No measures in model".to_string())?
    };

    // Build GROUP BY: target column + all cross-filter columns
    let mut group_by = vec![bi_engine::ColumnRef::new(&table, &column)];
    for cf in &cross_filters {
        group_by.push(bi_engine::ColumnRef::new(&cf.table, &cf.column));
    }

    let query_request = bi_engine::QueryRequest {
        measures: vec![first_measure],
        group_by,
        filters: vec![],
        lookups: vec![],
    };

    let engine_arc = get_engine_arc(&bi_state, connection_id)?;
    let (batches, refreshed_tables) = {
        let mut engine = engine_arc.lock().await;
        engine.query_auto_refresh(query_request).await
            .map_err(|e| format!("Query failed: {}", e))?
    };

    // DEV: Log data source (cache vs database)
    if refreshed_tables.is_empty() {
        log_info!("BI", "bi_get_column_available_values: data served from CACHE");
    } else {
        log_info!("BI", "bi_get_column_available_values: data fetched from DATABASE for: {}", refreshed_tables.join(", "));
    }

    // Post-filter: for each row, check if all cross-filter columns match
    let mut values = std::collections::HashSet::new();

    for batch in &batches {
        if batch.num_columns() == 0 {
            continue;
        }

        let allowed: Vec<std::collections::HashSet<&str>> = cross_filters
            .iter()
            .map(|cf| cf.values.iter().map(|v| v.as_str()).collect())
            .collect();

        for row_idx in 0..batch.num_rows() {
            let mut passes = true;
            for (cf_idx, allowed_set) in allowed.iter().enumerate() {
                let col_idx = 1 + cf_idx;
                if col_idx < batch.num_columns() {
                    let val = arrow_value_to_string(batch.column(col_idx), row_idx)
                        .unwrap_or_default();
                    if !allowed_set.contains(val.as_str()) {
                        passes = false;
                        break;
                    }
                }
            }

            if passes {
                if let Some(v) = arrow_value_to_string(batch.column(0), row_idx) {
                    if !v.is_empty() {
                        values.insert(v);
                    }
                }
            }
        }
    }

    let mut result: Vec<String> = values.into_iter().collect();
    result.sort();
    Ok(result)
}

/// Insert query results into the grid as a locked region.
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
        "bi_insert_result: conn={}, sheet={} at ({},{}), {} rows x {} cols",
        request.connection_id,
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
            let safe_name: String = col_name
                .chars()
                .map(|c| if c.is_alphanumeric() || c == '_' { c } else { '_' })
                .collect();
            let range_name = format!("BIResult.{}", safe_name);
            let col_letter = index_to_col(start_col + col_idx as u32);
            let data_start_row = start_row + 2;
            let data_end_row = end_row + 1;
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

    // Store active query on the connection for refresh
    {
        let mut connections = bi_state.connections.lock().unwrap();
        if let Some(conn) = connections.get_mut(&request.connection_id) {
            conn.active_queries.insert(region_id, ActiveQuery {
                request: query_request,
                sheet_index: request.sheet_index,
                start_row,
                start_col,
                end_row,
                end_col,
                region_id,
            });
        }
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

/// Refresh all queries on a connection — re-execute and update locked regions.
#[tauri::command]
pub async fn bi_refresh_connection(
    state: State<'_, AppState>,
    bi_state: State<'_, BiState>,
    connection_id: ConnectionId,
) -> Result<Vec<BiQueryResult>, String> {
    log_info!("BI", "bi_refresh_connection: id={}", connection_id);

    // Collect active queries
    let active_queries: Vec<ActiveQuery> = {
        let connections = bi_state.connections.lock().unwrap();
        let conn = connections.get(&connection_id)
            .ok_or_else(|| format!("Connection {} not found", connection_id))?;
        conn.active_queries.values().cloned().collect()
    };

    if active_queries.is_empty() {
        return Err("No active queries to refresh.".to_string());
    }

    let engine_arc = get_engine_arc(&bi_state, connection_id)?;
    let mut any_refreshed = false;
    let mut results = Vec::new();

    for active_query in &active_queries {
        let query_request = build_engine_query(&active_query.request);

        let (batches, refreshed_tables) = {
            let mut engine = engine_arc.lock().await;
            engine.query_auto_refresh(query_request).await
                .map_err(|e| format!("Refresh query failed: {}", e))?
        };

        // DEV: Log data source (cache vs database)
        if refreshed_tables.is_empty() {
            log_info!("BI", "bi_refresh_connection: query data served from CACHE");
        } else {
            log_info!("BI", "bi_refresh_connection: query data fetched from DATABASE for: {}", refreshed_tables.join(", "));
            any_refreshed = true;
        }

        let result = batches_to_result(&batches);

        let new_num_cols = result.columns.len() as u32;
        let new_num_data_rows = result.row_count as u32;
        let new_total_rows = new_num_data_rows + 1;

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

            for (col_idx, col_name) in result.columns.iter().enumerate() {
                let mut cell = Cell::new_text(col_name.clone());
                cell.style_index = bold_style_idx;
                grid.set_cell(start_row, start_col + col_idx as u32, cell);
            }

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
                    for r in active_query.start_row..=active_query.end_row {
                        for c in active_query.start_col..=active_query.end_col {
                            active_grid.set_cell(r, c, Cell::new());
                        }
                    }
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

        // Update active query metadata on the connection
        {
            let mut connections = bi_state.connections.lock().unwrap();
            if let Some(conn) = connections.get_mut(&connection_id) {
                if let Some(aq) = conn.active_queries.get_mut(&active_query.region_id) {
                    aq.end_row = new_end_row;
                    aq.end_col = new_end_col;
                }
                conn.last_refreshed = Some(now_iso());
            }
        }

        log_info!(
            "BI",
            "Refreshed query region_id={}: {} rows",
            active_query.region_id,
            result.row_count
        );

        results.push(result);
    }

    // Save cache after refresh if any tables were actually refreshed
    if any_refreshed {
        save_cache_for_connection(&bi_state, connection_id).await;
    }

    Ok(results)
}

/// Refresh all in-memory tables on a connection, regardless of TTL.
/// Call this on workbook open or when the user explicitly requests a full refresh.
/// Returns the names of tables that were refreshed.
#[tauri::command]
pub async fn bi_refresh_all_in_memory(
    bi_state: State<'_, BiState>,
    connection_id: ConnectionId,
) -> Result<Vec<String>, String> {
    log_info!("BI", "bi_refresh_all_in_memory: conn={}", connection_id);

    let engine_arc = get_engine_arc(&bi_state, connection_id)?;

    {
        let mut engine = engine_arc.lock().await;
        engine.refresh_all_in_memory().await
            .map_err(|e| format!("Refresh failed: {}", e))?;
    }

    // Update timestamp
    {
        let mut connections = bi_state.connections.lock().unwrap();
        if let Some(conn) = connections.get_mut(&connection_id) {
            conn.last_refreshed = Some(now_iso());
        }
    }

    // Return names of all in-memory tables
    let table_names: Vec<String> = {
        let engine = engine_arc.lock().await;
        engine.model().tables().iter()
            .filter(|t| t.is_in_memory())
            .map(|t| t.name().to_string())
            .collect()
    };

    // Save cache after full refresh
    save_cache_for_connection(&bi_state, connection_id).await;

    log_info!("BI", "Refreshed {} in-memory tables", table_names.len());
    Ok(table_names)
}

// ---------------------------------------------------------------------------
// Tauri Commands — Model Info & Region Check
// ---------------------------------------------------------------------------

/// Return model info for a specific connection.
#[tauri::command]
pub async fn bi_get_model_info(
    bi_state: State<'_, BiState>,
    connection_id: ConnectionId,
) -> Result<Option<BiModelInfo>, String> {
    let engine_arc = {
        let connections = bi_state.connections.lock().unwrap();
        let conn = connections.get(&connection_id)
            .ok_or_else(|| format!("Connection {} not found", connection_id))?;
        conn.engine.clone()
    };

    match engine_arc {
        Some(arc) => {
            let engine = arc.lock().await;
            Ok(Some(model_to_info(engine.model())))
        }
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

// ---------------------------------------------------------------------------
// Tauri Commands — Cache Management
// ---------------------------------------------------------------------------

/// Save all engine caches to disk (e.g., before shutdown or on demand).
#[tauri::command]
pub async fn bi_save_all_caches(
    bi_state: State<'_, BiState>,
) -> Result<usize, String> {
    let saved = bi_state.engine_registry.save_all_caches();
    log_info!("BI", "bi_save_all_caches: saved {} engines", saved);
    Ok(saved)
}

// ---------------------------------------------------------------------------
// Public helpers used by pivot commands
// ---------------------------------------------------------------------------

/// Auto-connect a specific connection to its database (if not already connected).
pub async fn auto_connect_bi_connection(
    bi_state: &BiState,
    connection_id: ConnectionId,
) -> Result<(), String> {
    let (already_connected, conn_str) = {
        let connections = bi_state.connections.lock().unwrap();
        let conn = connections.get(&connection_id)
            .ok_or_else(|| format!("Connection {} not found", connection_id))?;
        (conn.is_connected, conn.connection_string.clone())
    };

    if already_connected {
        return Ok(());
    }

    if conn_str.is_empty() {
        return Err("No connection string configured.".to_string());
    }

    log_info!("BI", "auto_connect: conn_id={}, connecting...", connection_id);

    let engine_arc = {
        let connections = bi_state.connections.lock().unwrap();
        let conn = connections.get(&connection_id)
            .ok_or_else(|| format!("Connection {} not found", connection_id))?;
        conn.engine.clone()
            .ok_or("No model loaded for this connection.")?
    };

    let idx = {
        let mut engine = engine_arc.lock().await;
        let config = bi_engine::PostgresConfig::new(&conn_str);
        engine.add_postgres(config).await
            .map_err(|e| format!("Auto-connect failed: {}", e))?
    };

    let mut connections = bi_state.connections.lock().unwrap();
    let conn = connections.get_mut(&connection_id)
        .ok_or_else(|| format!("Connection {} not found", connection_id))?;
    conn.connector_index = Some(idx);
    conn.is_connected = true;

    log_info!("BI", "auto_connect: conn_id={}, connector_index={}", connection_id, idx);
    Ok(())
}

/// Auto-bind model tables on a specific connection.
pub async fn auto_bind_tables_on_connection(
    bi_state: &BiState,
    connection_id: ConnectionId,
    table_names: &[&str],
) -> Result<(), String> {
    let (engine_arc, connector_index) = {
        let connections = bi_state.connections.lock().unwrap();
        let conn = connections.get(&connection_id)
            .ok_or_else(|| format!("Connection {} not found", connection_id))?;
        let connector_index = conn.connector_index
            .ok_or("No database connection.")?;
        let engine_arc = conn.engine.clone()
            .ok_or("No model loaded.")?;
        (engine_arc, connector_index)
    };

    let mut engine = engine_arc.lock().await;
    for table_name in table_names {
        if !engine.registry().has_table(table_name) {
            let source_table = table_name.to_lowercase();
            let binding = bi_engine::SourceBinding::new("BI", &source_table);
            engine.bind_table(*table_name, connector_index, binding);
            log_info!("BI", "auto_bind: conn={}, {} -> BI.{}", connection_id, table_name, source_table);
        }
    }

    Ok(())
}

/// Extract model metadata from a connection's engine.
pub async fn extract_connection_model_info(
    bi_state: &BiState,
    connection_id: ConnectionId,
) -> Result<BiModelInfo, String> {
    let engine_arc = {
        let connections = bi_state.connections.lock().unwrap();
        let conn = connections.get(&connection_id)
            .ok_or_else(|| format!("Connection {} not found", connection_id))?;
        conn.engine.clone()
            .ok_or("No model loaded.")?
    };
    let engine = engine_arc.lock().await;
    Ok(model_to_info(engine.model()))
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/// Save disk cache for a connection's engine (non-fatal on failure).
/// Called after refreshes for crash protection.
async fn save_cache_for_connection(bi_state: &BiState, connection_id: ConnectionId) {
    let (engine_arc, model_key) = {
        let connections = bi_state.connections.lock().unwrap();
        match connections.get(&connection_id) {
            Some(conn) => (conn.engine.clone(), conn.model_key.clone()),
            None => return,
        }
    };

    if let (Some(arc), Some(key)) = (engine_arc, model_key) {
        let cache_dir = EngineRegistry::cache_dir_for(&key);
        let engine = arc.lock().await;
        EngineRegistry::save_cache_sync(&engine, &cache_dir);
    }
}
