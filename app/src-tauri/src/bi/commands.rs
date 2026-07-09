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

use engine::{Cell, CellStyle};
use crate::{
    log_info,
    AppState, ProtectedRegion,
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

/// Parse a connection string (PostgreSQL URL or key=value format) into
/// `ConnectionTarget` + `AuthMethod` for the new engine auth API.
pub(crate) fn parse_connection_string(conn_str: &str) -> (bi_engine::ConnectionTarget, bi_engine::AuthMethod) {
    // Try URL format: postgresql://user:pass@host:port/database
    if conn_str.starts_with("postgresql://") || conn_str.starts_with("postgres://") {
        // Simple URL parsing without pulling in the url crate
        let rest = conn_str.splitn(2, "://").nth(1).unwrap_or("");
        let (userinfo, hostpath) = if let Some(at_pos) = rest.rfind('@') {
            (&rest[..at_pos], &rest[at_pos + 1..])
        } else {
            ("", rest)
        };
        let (username, password) = if let Some(colon_pos) = userinfo.find(':') {
            (&userinfo[..colon_pos], &userinfo[colon_pos + 1..])
        } else {
            (userinfo, "")
        };
        let (hostport, database) = if let Some(slash_pos) = hostpath.find('/') {
            (&hostpath[..slash_pos], &hostpath[slash_pos + 1..])
        } else {
            (hostpath, "")
        };
        // Strip query params from database
        let database = database.split('?').next().unwrap_or(database);
        let (host, port) = if let Some(colon_pos) = hostport.rfind(':') {
            (&hostport[..colon_pos], hostport[colon_pos + 1..].parse::<u16>().ok())
        } else {
            (hostport, None)
        };

        let mut target = bi_engine::ConnectionTarget::new(host, database);
        if let Some(p) = port {
            target = target.with_port(p);
        }
        let auth = if !username.is_empty() {
            bi_engine::AuthMethod::UsernamePassword {
                username: username.to_string(),
                password: password.to_string(),
            }
        } else {
            bi_engine::AuthMethod::Integrated
        };
        (target, auth)
    } else {
        // Key=value format: host=... dbname=... user=... password=...
        let mut host = "localhost".to_string();
        let mut port: Option<u16> = None;
        let mut dbname = String::new();
        let mut user = String::new();
        let mut password = String::new();
        let mut schema: Option<String> = None;

        for part in conn_str.split_whitespace() {
            if let Some((key, value)) = part.split_once('=') {
                match key.to_lowercase().as_str() {
                    "host" | "server" => host = value.to_string(),
                    "port" => port = value.parse().ok(),
                    "dbname" | "database" => dbname = value.to_string(),
                    "user" | "username" => user = value.to_string(),
                    "password" => password = value.to_string(),
                    "schema" | "search_path" | "options" => schema = Some(value.to_string()),
                    _ => {}
                }
            }
        }

        let mut target = bi_engine::ConnectionTarget::new(&host, &dbname);
        if let Some(p) = port {
            target = target.with_port(p);
        }
        if let Some(s) = schema {
            target = target.with_default_schema(&s);
        }
        let auth = if !user.is_empty() {
            bi_engine::AuthMethod::UsernamePassword {
                username: user,
                password,
            }
        } else {
            bi_engine::AuthMethod::Integrated
        };
        (target, auth)
    }
}

/// Build a `ConnectionTarget` from server and database strings.
fn build_target_from_connection_info(server: &str, database: &str) -> bi_engine::ConnectionTarget {
    let (host, port) = if let Some(colon_pos) = server.rfind(':') {
        (&server[..colon_pos], server[colon_pos + 1..].parse::<u16>().ok())
    } else {
        (server, None)
    };
    let mut target = bi_engine::ConnectionTarget::new(
        if host.is_empty() { "localhost" } else { host },
        if database.is_empty() { "postgres" } else { database },
    );
    if let Some(p) = port {
        target = target.with_port(p);
    }
    target
}

/// Deterministic, stable id for a data source derived from its kind + target.
/// Two connections to the same kind+server+database share one `PersistedSource`
/// id, so the model's source catalog never duplicates a source.
pub(crate) fn source_id_for(
    connection_type: &ConnectionType,
    server: &str,
    database: &str,
) -> String {
    let raw = format!(
        "{}|{}|{}",
        connection_type.as_str(),
        server.trim(),
        database.trim()
    );
    let sanitized: String = raw
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c.to_ascii_lowercase() } else { '_' })
        .collect();
    format!("src_{}", sanitized)
}

/// Map the app's preferred-auth string to the engine's secret-free auth hint.
pub(crate) fn persisted_auth_kind(preferred_auth: &str) -> bi_engine::PersistedAuthKind {
    match preferred_auth.trim().to_ascii_lowercase().as_str() {
        "integrated" | "windows" | "kerberos" => bi_engine::PersistedAuthKind::Integrated,
        "environmentvariable" | "environment" | "env" => {
            bi_engine::PersistedAuthKind::EnvironmentVariable
        }
        _ => bi_engine::PersistedAuthKind::UsernamePassword,
    }
}

/// The secret-free [`bi_engine::PersistedSource`] descriptor for a connection,
/// recorded in the model's catalog so its tables bind to it and survive
/// save/export/publish (`SourceKind` mirrors the connection type).
pub(crate) fn persisted_source_for(conn: &Connection) -> bi_engine::PersistedSource {
    let kind = match conn.connection_type {
        ConnectionType::PostgreSQL => bi_engine::SourceKind::Postgres,
        ConnectionType::SqlServer => bi_engine::SourceKind::SqlServer,
    };
    let target = build_target_from_connection_info(&conn.server, &conn.database);
    let connection = bi_engine::PersistedConnection {
        host: target.host.clone(),
        port: target.port,
        database: target.database.clone(),
        default_schema: target.default_schema.clone(),
        trust_server_certificate: target.trust_server_certificate,
    };
    let id = source_id_for(&conn.connection_type, &conn.server, &conn.database);
    let mut src = bi_engine::PersistedSource::new(
        id,
        kind,
        connection,
        persisted_auth_kind(&conn.preferred_auth),
    );
    if !conn.name.trim().is_empty() {
        src = src.with_display_name(conn.name.clone());
    }
    src
}

/// Map an engine KPI status to its wire string.
fn kpi_status_str(s: bi_engine::KpiStatus) -> String {
    match s {
        bi_engine::KpiStatus::OffTrack => "OffTrack",
        bi_engine::KpiStatus::AtRisk => "AtRisk",
        bi_engine::KpiStatus::OnTrack => "OnTrack",
    }
    .to_string()
}

/// Build a `BiModelInfo` from an Engine's DataModel.
pub(crate) fn model_to_info(model: &bi_engine::DataModel) -> BiModelInfo {
    let tables = model
        .tables()
        .iter()
        .map(|t| {
            let mut columns: Vec<BiColumnInfo> = t
                .columns()
                .iter()
                .map(|c| BiColumnInfo {
                    name: c.name().to_string(),
                    data_type: format!("{:?}", c.data_type()),
                    is_context_column: false,
                })
                .collect();
            // Context columns: Studio-authored dynamic-segmentation columns,
            // groupable like ordinary dimensions (the engine computes them).
            for cc in model.context_columns_for_table(t.name()) {
                columns.push(BiColumnInfo {
                    name: cc.name().to_string(),
                    data_type: format!("{:?}", cc.data_type()),
                    is_context_column: true,
                });
            }
            BiTableInfo {
                name: t.name().to_string(),
                columns,
            }
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

    let hierarchies = model
        .hierarchies()
        .iter()
        .map(|h| {
            use crate::pivot::types::{BiHierarchyMeta, BiHierarchyLevelMeta, BiRaggedBehavior};
            let levels = h.levels().iter().map(|l| BiHierarchyLevelMeta {
                column: l.column().to_string(),
                display_name: l.display_name().map(|s| s.to_string()),
                optional: l.is_optional(),
            }).collect();
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

    let kpis = model
        .kpis()
        .iter()
        .map(|k| {
            let (target_kind, target_value, target_measure) = match k.target() {
                bi_engine::KpiTarget::Constant(v) => ("constant".to_string(), Some(*v), None),
                bi_engine::KpiTarget::Measure(m) => {
                    ("measure".to_string(), None, Some(m.clone()))
                }
            };
            crate::bi::types::BiKpiInfo {
                name: k.name().to_string(),
                base_measure: k.base_measure().to_string(),
                target_kind,
                target_value,
                target_measure,
                status_bands: k
                    .status_bands()
                    .iter()
                    .map(|b| crate::bi::types::BiStatusBand {
                        threshold: b.threshold,
                        status: kpi_status_str(b.status),
                    })
                    .collect(),
                description: k.description().map(|s| s.to_string()),
            }
        })
        .collect();

    let security_roles = model
        .security_roles()
        .iter()
        .map(|r| {
            let table_filters: Vec<crate::bi::types::BiFilterPredicateInfo> = r
                .table_filters()
                .iter()
                .map(|p| crate::bi::types::BiFilterPredicateInfo {
                    table: p.table.clone(),
                    column: p.column.clone(),
                    operator: format!("{:?}", p.operator),
                    value: p.value.clone(),
                    // None for static; Debug of DynamicValue ("Username"/"CustomData")
                    // for a dynamic (identity-resolved) predicate.
                    dynamic: p.dynamic.as_ref().map(|d| format!("{:?}", d)),
                })
                .collect();
            let is_dynamic = table_filters.iter().any(|f| f.dynamic.is_some());
            crate::bi::types::BiSecurityRoleInfo {
                name: r.name().to_string(),
                table_filters,
                is_dynamic,
            }
        })
        .collect();

    let calculation_groups = model
        .calculation_groups()
        .iter()
        .map(|g| crate::pivot::types::BiCalcGroupMeta {
            name: g.name().to_string(),
            items: g
                .items()
                .iter()
                .map(|i| crate::pivot::types::BiCalcGroupItemMeta {
                    name: i.name().to_string(),
                    source: i.source().map(|s| s.to_string()),
                })
                .collect(),
        })
        .collect();

    BiModelInfo {
        tables,
        measures,
        relationships,
        hierarchies,
        kpis,
        security_roles,
        calculation_groups,
    }
}

/// Convert `Vec<RecordBatch>` to `BiQueryResult` (columns + string rows).
pub fn batches_to_result(batches: &[arrow::record_batch::RecordBatch]) -> BiQueryResult {
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
        ArrowDataType::Dictionary(key_type, _) => {
            // Dictionary-encoded columns (e.g. Dictionary(Int32, Utf8))
            // Decode the dictionary index to the actual string value.
            use arrow::datatypes::DataType;
            match key_type.as_ref() {
                DataType::Int8 => {
                    let dict = array.as_any().downcast_ref::<arrow::array::DictionaryArray<arrow::datatypes::Int8Type>>().unwrap();
                    let values = arrow::array::cast::as_string_array(dict.values());
                    let key = dict.keys().value(idx) as usize;
                    Some(values.value(key).to_string())
                }
                DataType::Int16 => {
                    let dict = array.as_any().downcast_ref::<arrow::array::DictionaryArray<arrow::datatypes::Int16Type>>().unwrap();
                    let values = arrow::array::cast::as_string_array(dict.values());
                    let key = dict.keys().value(idx) as usize;
                    Some(values.value(key).to_string())
                }
                DataType::Int32 => {
                    let dict = array.as_any().downcast_ref::<arrow::array::DictionaryArray<arrow::datatypes::Int32Type>>().unwrap();
                    let values = arrow::array::cast::as_string_array(dict.values());
                    let key = dict.keys().value(idx) as usize;
                    Some(values.value(key).to_string())
                }
                DataType::Int64 => {
                    let dict = array.as_any().downcast_ref::<arrow::array::DictionaryArray<arrow::datatypes::Int64Type>>().unwrap();
                    let values = arrow::array::cast::as_string_array(dict.values());
                    let key = dict.keys().value(idx) as usize;
                    Some(values.value(key).to_string())
                }
                _ => Some(format!("<unsupported dict key: {:?}>", key_type)),
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
pub(crate) fn build_engine_query(request: &BiQueryRequest) -> bi_engine::QueryRequest {
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
            .map(|f| {
                // Use the constructor so engine-lib additions to FilterCondition
                // (e.g. the `kind` value-rendering field) get their documented
                // defaults; the planner upgrades the kind when it can.
                let operator = match f.operator.as_str() {
                    "=" | "eq" => bi_engine::FilterOperator::Equal,
                    "!=" | "ne" => bi_engine::FilterOperator::NotEqual,
                    ">" | "gt" => bi_engine::FilterOperator::GreaterThan,
                    "<" | "lt" => bi_engine::FilterOperator::LessThan,
                    ">=" | "gte" => bi_engine::FilterOperator::GreaterThanOrEqual,
                    "<=" | "lte" => bi_engine::FilterOperator::LessThanOrEqual,
                    _ => bi_engine::FilterOperator::Equal,
                };
                bi_engine::FilterCondition::new(f.column.clone(), operator, f.value.clone())
            })
            .collect(),
        lookups: vec![],
        // Defaults absorb engine-lib additions (order_by/limit/totals, ...).
        ..Default::default()
    }
}

/// Helper: get the engine Arc from a connection by ID.
/// Briefly locks the connections mutex, clones the Arc, then releases.
pub(crate) fn get_engine_arc(
    bi_state: &BiState,
    connection_id: ConnectionId,
) -> Result<Arc<TokioMutex<bi_engine::Engine>>, String> {
    let connections = bi_state.connections.lock().unwrap();
    let conn = connections.get(&connection_id)
        .ok_or_else(|| format!("Connection {} not found", connection_id))?;
    conn.engine.clone()
        .ok_or_else(|| "No model loaded.".to_string())
}

/// Read this connection's chosen "view as" RLS role and apply it on the locked
/// engine, immediately before a query. MUST be called inside the engine lock.
///
/// Connections that share a model also share ONE engine (the registry dedups by
/// model_path) and `set_active_role` is sticky engine state, so this is called
/// on EVERY query path: it sets the chosen role, OR clears (`None`) any role a
/// sibling connection left on the shared engine — without it, connection A's
/// role would leak into connection B's results. Re-setting the same role is
/// cheap (the engine no-ops and keeps its role-keyed cache when unchanged).
/// v1 applies at most one role.
pub(crate) fn apply_connection_role(
    engine: &mut bi_engine::Engine,
    bi_state: &BiState,
    connection_id: ConnectionId,
) {
    let role = {
        let connections = bi_state.connections.lock().unwrap();
        connections
            .get(&connection_id)
            .and_then(|c| c.active_role.clone())
    };
    engine.set_active_role(role);
}

/// True if every named table is already present in this connection's engine
/// cache (i.e. servable offline with no DB connector). False when the list is
/// empty, the connection/engine is missing, or any table is cold. Used to skip
/// auto-connect/auto-bind on a cache-warm connection so restored pivots are
/// interactive offline.
pub(crate) async fn bi_tables_cache_warm(
    bi_state: &BiState,
    connection_id: ConnectionId,
    tables: &[&str],
) -> bool {
    if tables.is_empty() {
        return false;
    }
    let engine_arc = {
        let connections = match bi_state.connections.lock() {
            Ok(c) => c,
            Err(_) => return false,
        };
        connections.get(&connection_id).and_then(|c| c.engine.clone())
    };
    match engine_arc {
        Some(arc) => {
            let guard = arc.lock().await;
            tables.iter().all(|t| guard.cache().contains(t))
        }
        None => false,
    }
}

/// Map a BI query error to a user-facing message. Row-level-security failures
/// get a friendly, actionable hint (the engine's raw variant is otherwise
/// opaque to an end user); everything else keeps the caller's `context` prefix
/// plus the engine detail.
pub(crate) fn friendly_bi_query_error(context: &str, e: &impl std::fmt::Display) -> String {
    let s = e.to_string();
    if s.contains("SecurityRoleNotFound") {
        "The selected security role no longer exists in this model. Pick a different \
         role in \"View as\"."
            .to_string()
    } else if s.contains("RowLevelSecurityNotEnforceable") {
        "This security role can't be applied to this view — its row filters can't be \
         enforced through the model's relationships. Try a different role, or clear the \
         role in \"View as\"."
            .to_string()
    } else {
        format!("{}: {}", context, s)
    }
}

/// Capture per-connection "view as" RLS roles for saving into the workbook.
/// Merges the pending (loaded-but-not-yet-realized) roles with the live
/// connections' current roles — live wins, and a cleared role drops the entry.
/// Keyed by package data source id, else model path.
pub(crate) fn collect_bi_connection_roles(
    bi_state: &BiState,
) -> Vec<persistence::SavedBiConnectionRole> {
    let mut merged: std::collections::HashMap<String, String> =
        bi_state.pending_roles.lock().unwrap().clone();
    let connections = bi_state.connections.lock().unwrap();
    for conn in connections.values() {
        // Key precedence: package data source id, model path, else the
        // synthetic "local:{id}" identity of a path-less embedded-model
        // connection (stable across restore — the original id is reused).
        let key = conn
            .package_data_source_id
            .clone()
            .or_else(|| conn.model_path.clone())
            .or_else(|| Some(format!("local:{}", conn.id)));
        if let Some(key) = key {
            match &conn.active_role {
                Some(role) => {
                    merged.insert(key, role.clone());
                }
                None => {
                    merged.remove(&key);
                }
            }
        }
    }
    merged
        .into_iter()
        .map(|(connection_key, active_role)| persistence::SavedBiConnectionRole {
            connection_key,
            active_role,
        })
        .collect()
}

/// Load saved per-connection RLS roles into the pending map so they re-attach
/// when a matching connection is (re)created (re-pull / reconnect), and apply
/// them to any connections that already exist in this session.
pub(crate) fn load_pending_roles(
    bi_state: &BiState,
    saved: &[persistence::SavedBiConnectionRole],
) {
    let mut pending = bi_state.pending_roles.lock().unwrap();
    pending.clear();
    for r in saved {
        pending.insert(r.connection_key.clone(), r.active_role.clone());
    }
    let mut connections = bi_state.connections.lock().unwrap();
    for conn in connections.values_mut() {
        let key = conn
            .package_data_source_id
            .clone()
            .or_else(|| conn.model_path.clone())
            .or_else(|| Some(format!("local:{}", conn.id)));
        if let Some(role) = key.and_then(|k| pending.get(&k).cloned()) {
            conn.active_role = Some(role);
        }
    }
}

/// Build an Engine from a model with Calcula's standard auto-tier + query-cache
/// configuration. Shared by connection-create and workbook reconstruct so both
/// behave identically.
pub(crate) fn build_configured_engine(model: bi_engine::DataModel) -> bi_engine::Engine {
    let mut engine = bi_engine::Engine::new(model);
    engine.set_auto_tier_config(bi_engine::AutoTierConfig {
        enabled: true,
        max_rows: 100_000,
        default_ttl_secs: 3600,
    });
    engine.set_query_cache_config(bi_engine::QueryCacheConfig {
        enabled: true,
        max_entries: 256,
        max_memory_bytes: 64 * 1024 * 1024, // 64 MB
        ttl_secs: 300,
    });
    engine
}

/// Capture locally-authored BI connections for embedding in the workbook
/// (model + spec + bindings; NEVER credentials). Package-subscribed connections
/// are skipped — those reconstruct from the .calp on re-pull.
pub(crate) fn capture_local_bi_connections(
    bi_state: &BiState,
) -> Vec<persistence::SavedBiConnection> {
    let connections = bi_state.connections.lock().unwrap();
    let mut saved = Vec::new();
    for conn in connections.values() {
        if conn.package_data_source_id.is_some() {
            continue; // package connection — reconstructs from the .calp, not here
        }
        let engine_arc = match &conn.engine {
            Some(arc) => arc,
            None => continue,
        };
        // Persist the BASE model (without workbook-local calculated measures) so
        // restore can re-apply the measures as an overlay without double-adding.
        // For locally-authored connections base_model is owned data (no lock).
        // Otherwise serialize the live model (try_lock; fall back to the file).
        let model_json = if let Some(base) = &conn.base_model {
            match serde_json::to_value(base) {
                Ok(mut v) => {
                    stamp_feature_format_version(base, &mut v);
                    v
                }
                Err(e) => {
                    crate::log_warn!(
                        "BI",
                        "skip persisting connection {}: base model serialize failed: {}",
                        conn.id, e
                    );
                    continue;
                }
            }
        } else {
            match engine_arc.try_lock() {
                Ok(engine) => match serde_json::to_value(engine.model()) {
                    Ok(mut v) => {
                        stamp_feature_format_version(engine.model(), &mut v);
                        v
                    }
                    Err(e) => {
                        crate::log_warn!(
                            "BI",
                            "skip persisting connection {}: model serialize failed: {}",
                            conn.id, e
                        );
                        continue;
                    }
                },
                Err(_) => match conn
                    .model_path
                    .as_ref()
                    .and_then(|p| std::fs::read_to_string(p).ok())
                    .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
                {
                    Some(v) => v,
                    None => {
                        crate::log_warn!(
                            "BI",
                            "skip persisting connection {}: engine busy and no model file",
                            conn.id
                        );
                        continue;
                    }
                },
            }
        };
        saved.push(persistence::SavedBiConnection {
            id: conn.id.to_string(),
            name: conn.name.clone(),
            description: conn.description.clone(),
            connection_type: conn.connection_type.as_str().to_string(),
            server: conn.server.clone(),
            database: conn.database.clone(),
            preferred_auth: conn.preferred_auth.clone(),
            model_path: conn.model_path.clone(),
            model_json,
            bindings: conn
                .bindings
                .iter()
                .map(|b| persistence::SavedBiBinding {
                    model_table: b.model_table.clone(),
                    schema: b.schema.clone(),
                    source_table: b.source_table.clone(),
                    source_query: b.source_query.clone(),
                })
                .collect(),
            calculated_measures: conn
                .calculated_measures
                .iter()
                .map(|m| persistence::SavedCalculatedMeasure {
                    name: m.name.clone(),
                    expression: m.expression.clone(),
                })
                .collect(),
        });
    }
    saved
}

/// Flush + collect each LOCAL BI connection's on-disk cache for embedding in
/// the workbook (cross-machine offline data). Sync + non-blocking (try_lock);
/// skips package connections and any connection over the size caps. A
/// connection's cache is embedded all-or-nothing and only when metadata.json is
/// present (the engine needs it to reload the .arrow files).
pub(crate) fn collect_local_bi_caches(
    bi_state: &BiState,
) -> std::collections::HashMap<String, std::collections::HashMap<String, Vec<u8>>> {
    const PER_CONN_CAP: u64 = 100 * 1024 * 1024; // 100 MB / connection
    const GLOBAL_CAP: u64 = 500 * 1024 * 1024; // 500 MB total
    let mut out: std::collections::HashMap<String, std::collections::HashMap<String, Vec<u8>>> =
        std::collections::HashMap::new();
    let mut total: u64 = 0;
    let connections = bi_state.connections.lock().unwrap();
    for conn in connections.values() {
        if conn.package_data_source_id.is_some() {
            continue; // package connection — reconstructs from the .calp
        }
        let (engine_arc, model_key) = match (&conn.engine, &conn.model_key) {
            (Some(e), Some(k)) => (e, k),
            _ => continue,
        };
        let cache_dir = EngineRegistry::cache_dir_for(model_key);
        // Flush the in-memory cache to disk so the embedded bytes are current.
        // A busy engine simply embeds whatever is already on disk.
        if let Ok(engine) = engine_arc.try_lock() {
            EngineRegistry::save_cache_sync(&engine, &cache_dir);
        }
        if !cache_dir.exists() {
            continue;
        }
        let mut files: std::collections::HashMap<String, Vec<u8>> = std::collections::HashMap::new();
        let mut conn_bytes: u64 = 0;
        let mut over = false;
        if let Ok(rd) = std::fs::read_dir(&cache_dir) {
            for entry in rd.flatten() {
                let p = entry.path();
                if !p.is_file() {
                    continue;
                }
                let rel = match p.file_name().and_then(|s| s.to_str()) {
                    Some(r) => r.to_string(),
                    None => continue,
                };
                match std::fs::read(&p) {
                    Ok(bytes) => {
                        conn_bytes += bytes.len() as u64;
                        if conn_bytes > PER_CONN_CAP || total + conn_bytes > GLOBAL_CAP {
                            crate::log_warn!(
                                "BI",
                                "skip embedding cache for connection {}: exceeds size cap",
                                conn.id
                            );
                            over = true;
                            break;
                        }
                        files.insert(rel, bytes);
                    }
                    Err(e) => crate::log_warn!(
                        "BI",
                        "cache file {} read failed (skipped): {}",
                        p.display(),
                        e
                    ),
                }
            }
        }
        if over || files.is_empty() {
            continue;
        }
        // metadata.json is required to reload — without it the .arrow files are
        // unusable, so embed all-or-nothing per connection.
        if !files.contains_key("metadata.json") {
            crate::log_warn!(
                "BI",
                "skip embedding cache for connection {}: no metadata.json",
                conn.id
            );
            continue;
        }
        total += conn_bytes;
        out.insert(conn.id.to_string(), files);
    }
    out
}

/// Reconstruct locally-authored BI connections from the workbook on open.
/// Each is rebuilt with its ORIGINAL id (so pivots' `data_source_id` keeps
/// matching across save/open cycles), the embedded model goes into a fresh
/// engine, bindings are restored, and credentials are left empty (resolved via
/// the credential cache / Connect). Returns a map of saved id -> live
/// ConnectionId for pivot remapping. RLS roles are applied separately by
/// `load_pending_roles`.
pub(crate) fn restore_local_bi_connections(
    bi_state: &BiState,
    saved: &[persistence::SavedBiConnection],
    caches: &std::collections::HashMap<String, std::collections::HashMap<String, Vec<u8>>>,
) -> std::collections::HashMap<String, ConnectionId> {
    let mut id_map = std::collections::HashMap::new();
    for sc in saved {
        // Unwrap a ModelBundle wrapper (`{ formatVersion, model }`) if present.
        let model_value = if sc.model_json.get("formatVersion").is_some() {
            match sc.model_json.get("model") {
                Some(m) => m.clone(),
                None => {
                    crate::log_warn!("BI", "restore connection {}: bundle missing 'model'", sc.id);
                    continue;
                }
            }
        } else {
            sc.model_json.clone()
        };
        let model: bi_engine::DataModel = match serde_json::from_value(model_value) {
            Ok(m) => m,
            Err(e) => {
                crate::log_warn!("BI", "restore connection {}: model parse failed: {}", sc.id, e);
                continue;
            }
        };
        let conn_id = ConnectionId::parse(&sc.id)
            .unwrap_or_else(|| identity::EntityId::from_bytes(identity::generate_uuid_v7()));
        // Re-key the engine to the ORIGINAL model path so it finds the on-disk
        // cache from the prior session (offline data, same machine). The path
        // string keys the cache; the file itself need not exist (model is
        // embedded). Fall back to a synthetic per-connection key when unknown.
        let model_key = match sc.model_path.as_deref().filter(|p| !p.is_empty()) {
            Some(p) => ModelKey::from_model_path(p),
            None => ModelKey::from_model_path(&format!("local:{}", sc.id)),
        };
        let base_model = model.clone();
        let engine = build_configured_engine(model);
        let (engine_arc, was_existing, cache_dir) =
            bi_state.engine_registry.get_or_create(&model_key, engine);
        if !was_existing {
            // Materialize embedded offline cache blobs into this engine's
            // cache_dir BEFORE load_cache (on another machine the dir won't
            // pre-exist). Only for a freshly-created engine — a reused one
            // already holds its (possibly warmer) cache.
            if let Some(files) = caches.get(&sc.id) {
                match std::fs::create_dir_all(&cache_dir) {
                    Ok(()) => {
                        let mut n = 0usize;
                        for (rel, bytes) in files {
                            // rel is a sanitized single cache file name; guard anyway.
                            if rel.contains('/') || rel.contains('\\') || rel.contains("..") {
                                continue;
                            }
                            match std::fs::write(cache_dir.join(rel), bytes) {
                                Ok(()) => n += 1,
                                Err(e) => crate::log_warn!(
                                    "BI", "restore {}: write cache file {} failed: {}", sc.id, rel, e
                                ),
                            }
                        }
                        if n > 0 {
                            crate::log_info!(
                                "BI", "restore {}: materialized {} embedded cache files", sc.id, n
                            );
                        }
                    }
                    Err(e) => crate::log_warn!(
                        "BI", "restore {}: create cache_dir failed: {}", sc.id, e
                    ),
                }
            }
            // Load the disk cache (including any blobs just materialized) so
            // queries serve offline until a refresh. Fresh engine -> try_lock ok.
            if let Ok(mut guard) = engine_arc.try_lock() {
                let loaded = EngineRegistry::load_cache(&mut guard, &cache_dir);
                if !loaded.is_empty() {
                    crate::log_info!(
                        "BI",
                        "restore connection {}: loaded {} cached tables from disk",
                        sc.id, loaded.len()
                    );
                }
            }
        }
        let bindings: Vec<BiBindRequest> = sc
            .bindings
            .iter()
            .map(|b| BiBindRequest {
                model_table: b.model_table.clone(),
                schema: b.schema.clone(),
                source_table: b.source_table.clone(),
                source_query: b.source_query.clone(),
            })
            .collect();
        let connection = Connection {
            id: conn_id,
            name: sc.name.clone(),
            description: sc.description.clone(),
            connection_type: ConnectionType::parse_or_default(&sc.connection_type),
            connection_string: String::new(), // creds via credential cache / Connect
            server: sc.server.clone(),
            database: sc.database.clone(),
            preferred_auth: sc.preferred_auth.clone(),
            model_path: sc.model_path.clone(),
            engine: Some(engine_arc),
            model_key: Some(model_key),
            connector_index: None,
            bindings,
            last_refreshed: None,
            created_at: now_iso(),
            is_connected: false,
            active_queries: std::collections::HashMap::new(),
            package_data_source_id: None,
            active_role: None, // applied by load_pending_roles
            base_model: Some(base_model),
            calculated_measures: sc
                .calculated_measures
                .iter()
                .map(|m| crate::bi::types::CalculatedMeasure {
                    name: m.name.clone(),
                    expression: m.expression.clone(),
                })
                .collect(),
        };
        bi_state.connections.lock().unwrap().insert(conn_id, connection);
        id_map.insert(sc.id.clone(), conn_id);
    }
    // Re-apply workbook-local calculated measures to each restored engine
    // (base + union of measures for the model). Fresh engines -> try_lock ok.
    super::measures::reapply_all_calculated_measures(bi_state);
    id_map
}

/// Set the active "view as" RLS role for a connection (`None` = unrestricted).
/// The role is validated against the model up front for an immediate friendly
/// error; the engine re-validates and fails closed at query time. v1 refuses
/// dynamic (USERNAME/CUSTOMDATA) roles until runtime-identity wiring lands.
#[tauri::command]
pub async fn bi_set_active_role(
    bi_state: State<'_, BiState>,
    connection_id: ConnectionId,
    role: Option<String>,
    window: tauri::Window,
) -> Result<(), String> {
    crate::security::window_guard::require_label(
        &window,
        crate::security::window_guard::MAIN,
    )?;

    if let Some(name) = &role {
        let engine_arc = get_engine_arc(&bi_state, connection_id)?;
        let engine = engine_arc.lock().await;
        let security_role = engine
            .model()
            .security_role(name)
            .map_err(|_| format!("Security role '{}' not found in this model.", name))?;
        if security_role
            .table_filters()
            .iter()
            .any(|p| p.dynamic.is_some())
        {
            return Err(format!(
                "Role '{}' uses a dynamic identity (USERNAME/CUSTOMDATA), which is not \
                 supported yet.",
                name
            ));
        }
    }

    let mut connections = bi_state.connections.lock().unwrap();
    let conn = connections
        .get_mut(&connection_id)
        .ok_or_else(|| format!("Connection {} not found", connection_id))?;
    conn.active_role = role;
    Ok(())
}

/// Get the active "view as" RLS role for a connection (`None` = unrestricted).
#[tauri::command]
pub async fn bi_get_active_role(
    bi_state: State<'_, BiState>,
    connection_id: ConnectionId,
) -> Result<Option<String>, String> {
    let connections = bi_state.connections.lock().unwrap();
    Ok(connections
        .get(&connection_id)
        .and_then(|c| c.active_role.clone()))
}

// ---------------------------------------------------------------------------
// Tauri Commands — Connection Management
// ---------------------------------------------------------------------------

/// Reject a data model whose schema `format_version` exceeds what this app's
/// bundled engine supports, with an "update the app" message -- instead of
/// silently deserializing (serde drops unknown fields) and quietly losing the
/// newer features. `model_json` is the unwrapped DataModel JSON (NOT the
/// ModelBundle wrapper). Matters across `.calp` distribution: a subscriber on an
/// older Calcula opening a publisher's newer-format model.
pub fn check_model_format_version(model_json: &serde_json::Value) -> Result<(), String> {
    let found = model_json
        .get("format_version")
        .and_then(|v| v.as_u64())
        .unwrap_or(0) as u32;
    if found > bi_engine::MODEL_FORMAT_VERSION {
        return Err(format!(
            "This report needs a newer version of Calcula. Its data model uses format v{} but this app supports up to v{}. Please update Calcula.",
            found, bi_engine::MODEL_FORMAT_VERSION
        ));
    }
    Ok(())
}

/// Minimum schema `format_version` required by a query-scoped (`GVAR`) measure.
/// A pre-v13 engine silently drops the `query_scoped_bindings` field and
/// miscomputes, so a model that uses `GVAR` must be stamped >= 13.
const GVAR_MIN_FORMAT_VERSION: u64 = 13;

/// Bump a serialized model's `format_version` up to the minimum its features
/// require before persisting it (`.cala` save / `.calp` publish).
///
/// Calcula serializes a `DataModel` with serde, which round-trips
/// `format_version` exactly as loaded — unlike `Engine::save_model`, which
/// always stamps `MODEL_FORMAT_VERSION`. So a model that was loaded at an older
/// version and then given a `GVAR` measure in-app would otherwise persist
/// under-stamped, defeating [`check_model_format_version`] for a subscriber on an
/// older engine. This raises (never lowers) the stamp when the model uses `GVAR`.
pub fn stamp_feature_format_version(
    model: &bi_engine::DataModel,
    model_json: &mut serde_json::Value,
) {
    let uses_gvar = model
        .measures()
        .iter()
        .any(|m| m.expression().has_query_scoped_bindings());
    if !uses_gvar {
        return;
    }
    if let Some(obj) = model_json.as_object_mut() {
        let current = obj
            .get("format_version")
            .and_then(|v| v.as_u64())
            .unwrap_or(0);
        if current < GVAR_MIN_FORMAT_VERSION {
            obj.insert(
                "format_version".to_string(),
                serde_json::Value::from(GVAR_MIN_FORMAT_VERSION),
            );
        }
    }
}

#[cfg(test)]
mod format_gate_tests {
    use super::*;

    #[test]
    fn accepts_current_missing_and_older_formats() {
        // Missing format_version defaults to 0 (legacy), current is accepted.
        assert!(check_model_format_version(&serde_json::json!({})).is_ok());
        assert!(check_model_format_version(&serde_json::json!({ "format_version": 0 })).is_ok());
        assert!(check_model_format_version(
            &serde_json::json!({ "format_version": bi_engine::MODEL_FORMAT_VERSION })
        )
        .is_ok());
    }

    #[test]
    fn rejects_newer_format_with_update_message() {
        let too_new =
            serde_json::json!({ "format_version": bi_engine::MODEL_FORMAT_VERSION as u64 + 1 });
        let err = check_model_format_version(&too_new).unwrap_err();
        assert!(err.contains("newer version of Calcula"), "unexpected: {err}");
    }

    /// A one-table model with a single measure built from `formula`.
    fn model_with_measure(name: &str, formula: &str) -> bi_engine::DataModel {
        let expr = bi_engine::parse_measure_expression(formula).unwrap();
        bi_engine::DataModel::builder()
            .add_table(
                bi_engine::Table::new(
                    "Sales",
                    vec![bi_engine::Column::new("amount", bi_engine::DataType::Int64)],
                )
                .unwrap(),
            )
            .add_measure(bi_engine::Measure::new(name, expr))
            .build()
            .unwrap()
    }

    #[test]
    fn stamps_gvar_model_up_to_min_version() {
        let model = model_with_measure(
            "Share",
            "GVAR grand = SUM(Sales[amount]) RETURN DIVIDE(SUM(Sales[amount]), grand)",
        );
        // Simulate a model whose serialized stamp is older than the GVAR minimum
        // (Calcula's serde round-trip preserves format_version as-loaded).
        let mut json = serde_json::to_value(&model).unwrap();
        json.as_object_mut()
            .unwrap()
            .insert("format_version".into(), serde_json::Value::from(5u64));
        stamp_feature_format_version(&model, &mut json);
        assert_eq!(
            json.get("format_version").and_then(|v| v.as_u64()),
            Some(GVAR_MIN_FORMAT_VERSION)
        );
    }

    #[test]
    fn leaves_non_gvar_model_version_untouched() {
        let model = model_with_measure("Total", "SUM(Sales[amount])");
        let mut json = serde_json::to_value(&model).unwrap();
        json.as_object_mut()
            .unwrap()
            .insert("format_version".into(), serde_json::Value::from(5u64));
        stamp_feature_format_version(&model, &mut json);
        // No GVAR → the stamp is left exactly as-is (never lowered or raised).
        assert_eq!(json.get("format_version").and_then(|v| v.as_u64()), Some(5));
    }
}

#[cfg(test)]
mod rls_mapping_tests {
    use super::*;

    /// A model with one static role and one dynamic (USERNAME) role.
    fn model_with_roles() -> bi_engine::DataModel {
        bi_engine::DataModel::builder()
            .add_table(
                bi_engine::Table::new(
                    "Geography",
                    vec![
                        bi_engine::Column::new("id", bi_engine::DataType::Int64),
                        bi_engine::Column::new("region", bi_engine::DataType::String),
                    ],
                )
                .unwrap(),
            )
            .add_security_role(bi_engine::SecurityRole::new("WestOnly").with_filter(
                "Geography",
                "region",
                bi_engine::ComparisonOp::Equal,
                "West",
            ))
            .add_security_role(
                bi_engine::SecurityRole::new("MyRows").with_filters(vec![
                    bi_engine::FilterPredicate::username(
                        "Geography",
                        "region",
                        bi_engine::ComparisonOp::Equal,
                    ),
                ]),
            )
            .build()
            .expect("model with roles should build")
    }

    #[test]
    fn maps_static_role_predicates() {
        let info = model_to_info(&model_with_roles());
        assert_eq!(info.security_roles.len(), 2);

        let west = info
            .security_roles
            .iter()
            .find(|r| r.name == "WestOnly")
            .expect("WestOnly role present");
        assert!(!west.is_dynamic, "static role must not be flagged dynamic");
        assert_eq!(west.table_filters.len(), 1);
        let f = &west.table_filters[0];
        assert_eq!(f.table, "Geography");
        assert_eq!(f.column, "region");
        assert_eq!(f.operator, "Equal");
        assert_eq!(f.value, "West");
        assert!(f.dynamic.is_none());
    }

    #[test]
    fn flags_and_labels_dynamic_role() {
        let info = model_to_info(&model_with_roles());
        let dyn_role = info
            .security_roles
            .iter()
            .find(|r| r.name == "MyRows")
            .expect("MyRows role present");
        assert!(dyn_role.is_dynamic, "USERNAME() role must be flagged dynamic");
        assert_eq!(
            dyn_role.table_filters[0].dynamic.as_deref(),
            Some("Username")
        );
    }

    #[test]
    fn empty_when_model_has_no_roles() {
        let model = bi_engine::DataModel::builder()
            .add_table(
                bi_engine::Table::new(
                    "T",
                    vec![bi_engine::Column::new("c", bi_engine::DataType::Int64)],
                )
                .unwrap(),
            )
            .build()
            .unwrap();
        assert!(model_to_info(&model).security_roles.is_empty());
    }
}

#[cfg(test)]
mod calc_group_mapping_tests {
    use super::*;

    fn model_with_calc_group() -> bi_engine::DataModel {
        bi_engine::DataModel::builder()
            .add_table(
                bi_engine::Table::new(
                    "Sales",
                    vec![bi_engine::Column::new("amount", bi_engine::DataType::Float64)],
                )
                .unwrap(),
            )
            .add_measure(bi_engine::sum_measure("Revenue", "Sales", "amount"))
            .add_calculation_group(bi_engine::CalculationGroup::new(
                "Time",
                vec![
                    bi_engine::CalculationItem::from_text("Current", "SELECTEDMEASURE()")
                        .unwrap(),
                    bi_engine::CalculationItem::from_text("Doubled", "SELECTEDMEASURE() * 2")
                        .unwrap(),
                ],
            ))
            .build()
            .expect("model with a calc group should build")
    }

    #[test]
    fn maps_calculation_groups_and_items() {
        let info = model_to_info(&model_with_calc_group());
        assert_eq!(info.calculation_groups.len(), 1);
        let g = &info.calculation_groups[0];
        assert_eq!(g.name, "Time");
        assert_eq!(g.items.len(), 2);
        assert_eq!(g.items[0].name, "Current");
        assert_eq!(g.items[1].name, "Doubled");
        // Source text is retained from `from_text` and surfaced for display.
        assert_eq!(g.items[0].source.as_deref(), Some("SELECTEDMEASURE()"));
    }

    #[test]
    fn empty_when_model_has_no_calc_groups() {
        let model = bi_engine::DataModel::builder()
            .add_table(
                bi_engine::Table::new(
                    "T",
                    vec![bi_engine::Column::new("c", bi_engine::DataType::Int64)],
                )
                .unwrap(),
            )
            .build()
            .unwrap();
        assert!(model_to_info(&model).calculation_groups.is_empty());
    }
}

/// Create a new connection: loads the model, registers in the shared engine registry,
/// loads disk cache, and refreshes stale tables.
/// Does NOT connect to the database yet — call `bi_connect` for that.
#[tauri::command]
pub async fn bi_create_connection(
    bi_state: State<'_, BiState>,
    request: CreateConnectionRequest,
    window: tauri::Window,
) -> Result<ConnectionInfo, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;
    log_info!("BI", "bi_create_connection: name={}", request.name);

    // Model source: inline JSON (embedded-model-first — no filesystem
    // identity) or a .json file path (interchange only).
    let json_value: serde_json::Value = match (&request.model_json, request.model_path.as_deref())
    {
        // Both provided is ambiguous: content would come from the inline JSON
        // while the engine/cache identity would key by the path — silently
        // diverging live queries from the persisted model. Reject it.
        (Some(_), Some(path)) if !path.is_empty() => {
            return Err("Provide either modelJson or modelPath, not both".to_string())
        }
        (Some(value), _) => value.clone(),
        (None, Some(path)) if !path.is_empty() => {
            let json_str = std::fs::read_to_string(Path::new(path))
                .map_err(|e| format!("Failed to read file: {}", e))?;
            serde_json::from_str(&json_str)
                .map_err(|e| format!("Failed to parse JSON: {}", e))?
        }
        _ => return Err("Provide either modelJson or modelPath".to_string()),
    };

    create_connection_core(
        &bi_state,
        request.name,
        request.description,
        request.connection_string,
        request.model_path.filter(|p| !p.is_empty()),
        json_value,
    )
    .await
}

/// Create a connection from INLINE model JSON (no filesystem identity). The
/// public door for programmatic creators (blank models from the Model Editor).
pub(crate) async fn create_connection_from_json(
    bi_state: &BiState,
    name: String,
    description: Option<String>,
    connection_string: String,
    json_value: serde_json::Value,
) -> Result<ConnectionInfo, String> {
    create_connection_core(bi_state, name, description, connection_string, None, json_value).await
}

/// Shared core of connection creation: parse/validate the model, key the
/// shared engine (path or "local:{id}"), load caches, adopt sibling state,
/// and register the Connection.
async fn create_connection_core(
    bi_state: &BiState,
    name: String,
    description: Option<String>,
    connection_string: String,
    model_path: Option<String>,
    json_value: serde_json::Value,
) -> Result<ConnectionInfo, String> {
    // Extract connectionSpecs from ModelBundle (if present) for server/database info
    let model_conn_spec = crate::calp_commands::extract_connection_spec_info(&json_value);

    // Detect ModelBundle format (has "formatVersion" at top level)
    let model_json = if json_value.get("formatVersion").is_some() {
        log_info!("BI", "Detected Calcula Studio ModelBundle format");
        json_value.get("model")
            .ok_or_else(|| "ModelBundle missing 'model' field".to_string())?
            .clone()
    } else {
        json_value
    };

    check_model_format_version(&model_json)?;
    let model: bi_engine::DataModel = serde_json::from_value(model_json)
        .map_err(|e| format!("Failed to parse model: {}", e))?;
    model.validate().map_err(|e| format!("Model validation failed: {}", e))?;

    // Generated up front: the path-less cache key derives from it.
    let id = identity::EntityId::from_bytes(identity::generate_uuid_v7());

    // Cache/engine identity: the model path when created from a file (reuses
    // that model's prior on-disk cache), otherwise a synthetic per-connection
    // key — the same "local:{id}" convention the .cala restore path uses for
    // path-less embedded models.
    let model_key = match model_path.as_deref() {
        Some(path) => ModelKey::from_model_path(path),
        None => ModelKey::from_model_path(&format!("local:{}", id)),
    };

    // Keep the base model (no workbook-local measures) so calculated measures
    // can be applied later as `base + measures` via engine.set_model.
    let base_model = model.clone();

    // Get or create shared engine via the registry (standard auto-tier +
    // query-cache config; shared with workbook reconstruct).
    let engine = build_configured_engine(model);

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

    // Prefer connectionSpecs from model, fall back to parsing the connection string
    let (target, _auth) = parse_connection_string(&connection_string);
    let server = if !model_conn_spec.server.is_empty() { model_conn_spec.server } else { target.host.clone() };
    let database = if !model_conn_spec.database.is_empty() { model_conn_spec.database } else { target.database.clone() };
    let preferred_auth = if !model_conn_spec.preferred_auth.is_empty() { model_conn_spec.preferred_auth } else { "UsernamePassword".to_string() };
    // Honor the model's declared connector type — hardcoding PostgreSQL here
    // would defeat the not-yet-supported guards at the connect sites.
    let connection_type = ConnectionType::parse_or_default(&model_conn_spec.connector_type);
    // Restore a saved "view as" RLS role for this local connection (keyed by
    // model path when file-created; path-less connections have no persisted
    // role yet — their role key is minted at save via the "local:{id}" key).
    let active_role = bi_state.pending_role_for(None, model_path.as_deref());
    // Calculated measures AND the base model belong to the MODEL. When reusing
    // a shared engine, inherit BOTH from a sibling connection: the sibling's
    // base_model may carry in-app Model Editor edits that the on-disk file
    // does not — re-reading the file here would resurrect the stale model and
    // (via the editor's model-wide mirroring) silently destroy those edits.
    let (seed_measures, sibling_base): (
        Vec<crate::bi::types::CalculatedMeasure>,
        Option<bi_engine::DataModel>,
    ) = if was_existing {
        let conns = bi_state.connections.lock().unwrap();
        conns
            .values()
            .find(|c| c.model_key.as_ref() == Some(&model_key))
            .map(|c| (c.calculated_measures.clone(), c.base_model.clone()))
            .unwrap_or_default()
    } else {
        (Vec::new(), None)
    };
    // Rebuild the app-side table→source bindings from the model's persisted
    // source catalog (engine format v14). This is what makes an imported or
    // reopened model's tables BOUND: create_connection previously left bindings
    // empty, so a model that arrived via export→import (or a dataset .calp
    // whose bindings weren't carried) had no source mapping and showed every
    // table as "unbound". Each table that names a source in its persisted
    // source_binding becomes an app binding here.
    let derived_bindings: Vec<BiBindRequest> = sibling_base
        .as_ref()
        .unwrap_or(&base_model)
        .tables()
        .iter()
        .filter_map(|t| {
            t.source_binding().map(|sb| BiBindRequest {
                model_table: t.name().to_string(),
                schema: sb.schema.clone(),
                source_table: sb.table.clone(),
                source_query: None,
            })
        })
        .collect();
    let connection = Connection {
        id,
        name,
        description: description.unwrap_or_default(),
        connection_type,
        connection_string,
        server,
        database,
        preferred_auth,
        model_path,
        engine: Some(engine_arc),
        model_key: Some(model_key),
        connector_index: None,
        bindings: derived_bindings,
        last_refreshed: None,
        created_at: now_iso(),
        is_connected: false,
        active_queries: std::collections::HashMap::new(),
        package_data_source_id: None,
        active_role,
        // Sibling base first (carries in-app model edits); the freshly-parsed
        // file model only seeds the FIRST connection for a model.
        base_model: sibling_base.or(Some(base_model)),
        calculated_measures: seed_measures,
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

    let (model_key, is_local, region_ids) = {
        let mut connections = bi_state.connections.lock().unwrap();
        let conn = connections.remove(&connection_id)
            .ok_or_else(|| format!("Connection {} not found", connection_id))?;

        let region_ids: Vec<identity::EntityId> = conn.active_queries.keys().copied().collect();
        (conn.model_key, conn.model_path.is_none(), region_ids)
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
        let removed = bi_state.engine_registry.release(&key);
        if removed && is_local {
            // A path-less connection's synthetic "local:{id}" key can never
            // be recreated after deletion — without this, the cache the
            // release just flushed would sit orphaned on disk forever (and
            // keep the "deleted" connection's row data around). Restoring an
            // older .cala that still references the id simply re-fetches.
            let _ = std::fs::remove_dir_all(EngineRegistry::cache_dir_for(&key));
        }
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

/// Get all connections. Guarded: ConnectionInfo carries the raw connection
/// string, and the only legitimate callers are the main window and the Model
/// Editor window — the inert secondary editors must not enumerate it.
#[tauri::command]
pub async fn bi_get_connections(
    bi_state: State<'_, BiState>,
    window: tauri::Window,
) -> Result<Vec<ConnectionInfo>, String> {
    crate::security::window_guard::require_label(
        &window,
        crate::security::window_guard::MAIN_AND_MODEL_EDITOR,
    )?;
    let connections = bi_state.connections.lock().unwrap();
    let mut infos: Vec<ConnectionInfo> = connections.values().map(|c| c.to_info()).collect();
    infos.sort_by_key(|c| c.id);
    Ok(infos)
}

/// Get a single connection by ID. Guarded like bi_get_connections.
#[tauri::command]
pub async fn bi_get_connection(
    bi_state: State<'_, BiState>,
    connection_id: ConnectionId,
    window: tauri::Window,
) -> Result<ConnectionInfo, String> {
    crate::security::window_guard::require_label(
        &window,
        crate::security::window_guard::MAIN_AND_MODEL_EDITOR,
    )?;
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
    window: tauri::Window,
) -> Result<ConnectionInfo, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;
    let connection_id = request.connection_id;
    log_info!("CALP-DIAG", "bi_connect called: connection_id={}", connection_id);

    // Get the engine Arc, connection string, and server/database/auth info
    let (engine_arc, conn_str, server, database, preferred_auth) = {
        let connections = bi_state.connections.lock().unwrap();
        let conn = connections.get(&connection_id)
            .ok_or_else(|| format!("Connection {} not found", connection_id))?;
        let engine_arc = conn.engine.clone()
            .ok_or("No model loaded for this connection.")?;
        (engine_arc, conn.connection_string.clone(), conn.server.clone(), conn.database.clone(), conn.preferred_auth.clone())
    };

    log_info!("CALP-DIAG", "bi_connect: conn_str='{}', server='{}', database='{}', preferred_auth='{}'",
        if conn_str.starts_with("__PASSWORD_ONLY__") { "__PASSWORD_ONLY__:***" } else { &conn_str },
        server, database, preferred_auth);

    // Build ConnectionTarget + AuthMethod
    let (target, auth) = if conn_str.starts_with("__PASSWORD_ONLY__:") {
        // Password-only mode: use OS username + server/database from model
        let password = conn_str.trim_start_matches("__PASSWORD_ONLY__:");
        let os_user = std::env::var("USERNAME")
            .unwrap_or_else(|_| "postgres".to_string());
        let target = build_target_from_connection_info(&server, &database);
        let auth = bi_engine::AuthMethod::UsernamePassword {
            username: os_user.clone(),
            password: password.to_string(),
        };
        // Update the stored connection string to the resolved form
        {
            let mut connections = bi_state.connections.lock().unwrap();
            if let Some(conn) = connections.get_mut(&connection_id) {
                conn.connection_string = format!(
                    "host={} dbname={} user={} password={}",
                    server, database, os_user, password
                );
            }
        }
        (target, auth)
    } else if !conn_str.is_empty() {
        // Explicit connection string provided — parse it
        parse_connection_string(&conn_str)
    } else if preferred_auth == "Integrated" {
        // Integrated auth: use server/database from model, no credentials needed
        let target = build_target_from_connection_info(&server, &database);
        (target, bi_engine::AuthMethod::Integrated)
    } else if !server.is_empty() && !database.is_empty() {
        // Server/database known — try cached credentials
        if let Some((cached_user, cached_pass)) =
            super::credential_cache::get_credentials(&server, &database)
        {
            log_info!("CALP-DIAG", "bi_connect: using cached credentials for {}:{}", server, database);
            let target = build_target_from_connection_info(&server, &database);
            let auth = bi_engine::AuthMethod::UsernamePassword {
                username: cached_user.clone(),
                password: cached_pass.clone(),
            };
            // Store the resolved connection string
            {
                let mut connections = bi_state.connections.lock().unwrap();
                if let Some(conn) = connections.get_mut(&connection_id) {
                    conn.connection_string = format!(
                        "host={} dbname={} user={} password={}",
                        server, database, cached_user, cached_pass
                    );
                }
            }
            (target, auth)
        } else {
            return Err(format!(
                "Not connected. Open Data > Connections and click Connect on '{}' to provide credentials.",
                if database.is_empty() { &server } else { &database }
            ));
        }
    } else {
        return Err("No database URL configured. Use 'Add Connection' with a PostgreSQL connection string to enable live data refresh.".to_string());
    };

    // Live connect currently supports PostgreSQL only. SqlServer-typed
    // connections (from package manifests/models) are stored faithfully but
    // cannot connect yet — fail clearly instead of misrouting to PostgreSQL.
    {
        let connections = bi_state.connections.lock().unwrap();
        if let Some(conn) = connections.get(&connection_id) {
            if conn.connection_type != ConnectionType::PostgreSQL {
                return Err(format!(
                    "Connection type '{}' is not yet supported for live connect (PostgreSQL only).",
                    conn.connection_type.as_str()
                ));
            }
        }
    }

    // Lock the shared engine for async database connection
    let idx = {
        let mut engine = engine_arc.lock().await;
        engine.add_postgres(target, auth).await
            .map_err(|e| format!("Connection failed: {}", e))?
    };

    // After connecting, refresh stale tables (if any were loaded from disk cache)
    {
        let mut engine = engine_arc.lock().await;
        match engine.refresh_stale().await {
            Ok(report) => {
                if !report.refreshed.is_empty() {
                    log_info!("BI", "Refreshed stale tables after connect: {}", report.refreshed.join(", "));
                }
                for failure in &report.failures {
                    log_info!("BI", "Stale-table refresh failed for {}: {}", failure.table, failure.detail);
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

    // Cache credentials for future auto-connect (keyed by server+database)
    if !server.is_empty() && !database.is_empty() {
        let stored_conn_str = bi_state.connections.lock().unwrap()
            .get(&connection_id)
            .map(|c| c.connection_string.clone())
            .unwrap_or_default();
        log_info!("CALP-DIAG", "bi_connect: saving credentials, server='{}', database='{}', conn_str_len={}",
            server, database, stored_conn_str.len());
        let (_, auth_for_cache) = parse_connection_string(&stored_conn_str);
        match auth_for_cache {
            bi_engine::AuthMethod::UsernamePassword { ref username, ref password } => {
                super::credential_cache::save_credentials(&server, &database, username, password);
                log_info!("CALP-DIAG", "Cached credentials for {}:{} user={}", server, database, username);
            }
            _ => {
                log_info!("CALP-DIAG", "bi_connect: auth method is not UsernamePassword, skipping cache");
            }
        }
    }

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
    window: tauri::Window,
) -> Result<String, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;
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
        let binding = match &request.source_query {
            Some(sql) => bi_engine::SourceBinding::new_query(&request.model_table, sql),
            None => bi_engine::SourceBinding::new(&request.schema, &request.source_table),
        };
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
    cap_store: State<'_, crate::scripting::CapabilityStore>,
    app_state: State<'_, crate::AppState>,
    connection_id: ConnectionId,
    request: BiQueryRequest,
    script_id: Option<String>,
    window: tauri::Window,
) -> Result<BiQueryResult, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;
    // Authoritative capability re-check (A3). A broker-routed call on behalf of a
    // sandboxed script carries a script_id and MUST have been granted bi.query
    // (mirrored to the store on consent-grant); a trusted main-window direct
    // call (a built-in feature) carries no script_id and is allowed. The
    // renderer can be compromised, so the broker's TS check is not sufficient.
    if let Some(sid) = script_id.as_deref() {
        if !cap_store.is_bi_granted(sid, "bi.query") {
            crate::log_warn!("SECURITY", "bi_query DENIED (bi.query not granted): script={}", sid);
            crate::net_commands::record_capability_call(&app_state.audit_log, "bi.query", sid, false, None, Some("bi.query not granted"));
            return Err("PermissionDenied: bi.query not granted for this script".to_string());
        }
    }
    log_info!(
        "BI",
        "bi_query: conn={}, measures={:?}, group_by={:?}",
        connection_id,
        request.measures,
        request.group_by.iter().map(|g| format!("{}.{}", g.table, g.column)).collect::<Vec<_>>()
    );

    let result = bi_query_core(&bi_state, connection_id.clone(), &request).await?;

    // Audit (unified trail): persist a script-attributed bi.query call (success).
    // Trusted built-in callers carry no script_id and are not audited (avoid
    // flooding the trail with the app's own feature queries).
    if let Some(sid) = script_id.as_deref() {
        crate::net_commands::record_capability_call(
            &app_state.audit_log,
            "bi.query",
            sid,
            true,
            Some(&format!("connection {}", connection_id)),
            None,
        );
    }

    Ok(result)
}

/// Gate-free core of `bi_query`: RLS role application, auto-refresh query,
/// cache save, last_refreshed bump, string-grid conversion. EVERY structured
/// query surface (the bi_query command, the notebook model.* provider) runs
/// through here, so RLS cannot be bypassed by a new path. Callers own their
/// own capability gating + audit.
pub(crate) async fn bi_query_core(
    bi_state: &BiState,
    connection_id: ConnectionId,
    request: &BiQueryRequest,
) -> Result<BiQueryResult, String> {
    let query_request = build_engine_query(request);
    let engine_arc = get_engine_arc(bi_state, connection_id.clone())?;

    let (batches, refreshed_tables, refresh_failures) = {
        let mut engine = engine_arc.lock().await;
        // Apply this connection's RLS role (or clear a sibling's) before querying.
        apply_connection_role(&mut engine, bi_state, connection_id.clone());
        let (b, rt) = engine.query_auto_refresh(query_request).await
            .map_err(|e| friendly_bi_query_error("Query failed", &e))?;
        // Capture partial refresh failures so they aren't silently swallowed
        // (query_auto_refresh proceeds despite per-table failures and serves
        // possibly-stale data for the failed tables).
        let failures: Vec<String> = engine
            .last_refresh_report()
            .map(|r| {
                r.failures
                    .iter()
                    .map(|f| format!("{}: {}", f.table, f.detail))
                    .collect()
            })
            .unwrap_or_default();
        (b, rt, failures)
    };

    if !refresh_failures.is_empty() {
        crate::log_warn!(
            "BI",
            "bi_query: {} table(s) failed to refresh (serving possibly-stale data): {}",
            refresh_failures.len(),
            refresh_failures.join("; ")
        );
    }

    // DEV: Log data source (cache vs database)
    if refreshed_tables.is_empty() {
        log_info!("BI", "bi_query: data served from CACHE (no tables refreshed)");
    } else {
        log_info!("BI", "bi_query: data fetched from DATABASE for: {}", refreshed_tables.join(", "));
        // Save cache after auto-refresh (crash protection)
        save_cache_for_connection(bi_state, connection_id.clone()).await;
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

/// Run a CONSENTED, read-only RAW SQL query against a connection's connector
/// (Wave 3 — the higher-trust `bi.sql` capability). Unlike the structured
/// `bi_query`, this can read any table the connection's credentials reach, so it
/// is gated by a SEPARATE capability (`bi.sql`) on the frontend (broker +
/// explicit consent). Re-validated read-only here as defense in depth; the
/// connector executes it.
#[tauri::command]
pub async fn script_bi_sql(
    bi_state: State<'_, BiState>,
    cap_store: State<'_, crate::scripting::CapabilityStore>,
    app_state: State<'_, crate::AppState>,
    connection_id: ConnectionId,
    sql: String,
    script_id: Option<String>,
    window: tauri::Window,
) -> Result<BiQueryResult, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;
    // Authoritative capability re-check (A3): a broker-routed sandboxed call
    // carries a script_id and MUST have been granted the higher-trust bi.sql; a
    // trusted main-window direct call carries none. Defense in depth above the
    // TS broker (the renderer may be compromised).
    if let Some(sid) = script_id.as_deref() {
        if !cap_store.is_bi_granted(sid, "bi.sql") {
            crate::log_warn!("SECURITY", "script_bi_sql DENIED (bi.sql not granted): script={}", sid);
            crate::net_commands::record_capability_call(&app_state.audit_log, "bi.sql", sid, false, None, Some("bi.sql not granted"));
            return Err("PermissionDenied: bi.sql not granted for this script".to_string());
        }
    }
    let result = bi_sql_core(&bi_state, connection_id.clone(), &sql).await?;
    log_info!("BI", "script_bi_sql: conn={}, returned {} rows", connection_id, result.row_count);

    // Audit (unified trail): persist a script-attributed bi.sql call (success).
    // Record a short SQL PREFIX for forensic context, never the full query.
    if let Some(sid) = script_id.as_deref() {
        let sql_prefix: String = sql.trim().chars().take(60).collect();
        crate::net_commands::record_capability_call(
            &app_state.audit_log,
            "bi.sql",
            sid,
            true,
            Some(&format!("connection {} — {}", connection_id, sql_prefix)),
            None,
        );
    }

    Ok(result)
}

/// Gate-free core of `script_bi_sql`: read-only validation, auto-connect,
/// connector execution, 100k row cap. EVERY raw-SQL surface (the script_bi_sql
/// command, the notebook model.* provider) runs through here, so the read-only
/// validation cannot be bypassed by a new path. Callers own their own
/// capability gating + audit.
pub(crate) async fn bi_sql_core(
    bi_state: &BiState,
    connection_id: ConnectionId,
    sql: &str,
) -> Result<BiQueryResult, String> {
    validate_readonly_sql(sql)?;

    auto_connect_bi_connection(bi_state, connection_id.clone()).await?;

    let (engine_arc, connector_index) = {
        let connections = bi_state.connections.lock().unwrap();
        let conn = connections
            .get(&connection_id)
            .ok_or_else(|| format!("Connection {} not found", connection_id))?;
        let connector_index = conn
            .connector_index
            .ok_or("Not connected to a database. Connect first.")?;
        let engine_arc = conn.engine.clone().ok_or("No model loaded.")?;
        (engine_arc, connector_index)
    };

    let batches = {
        let engine = engine_arc.lock().await;
        let connector = engine
            .registry()
            .connector_by_index(connector_index)
            .ok_or("Connector not found for this connection")?;
        connector
            .execute_query(sql)
            .await
            .map_err(|e| format!("SQL query failed: {}", e))?
    };

    let mut result = batches_to_result(&batches);
    const MAX_ROWS: usize = 100_000;
    if result.rows.len() > MAX_ROWS {
        result.rows.truncate(MAX_ROWS);
        result.row_count = MAX_ROWS;
    }
    Ok(result)
}

/// Defense-in-depth read-only validation for script raw SQL: a single SELECT/WITH
/// statement, no embedded statement separators. The frontend (vBiSql) validates
/// too; this never trusts that.
fn validate_readonly_sql(sql: &str) -> Result<(), String> {
    let trimmed = sql.trim();
    if trimmed.is_empty() {
        return Err("Empty SQL".to_string());
    }
    if trimmed.len() > 100_000 {
        return Err("SQL too long (max 100k chars)".to_string());
    }
    let lowered = trimmed.to_lowercase();
    if !lowered.starts_with("select") && !lowered.starts_with("with") {
        return Err("Only read-only queries are allowed (SELECT / WITH)".to_string());
    }
    // Reject multiple statements: strip one trailing ';', then reject any ';'.
    let body = trimmed.trim_end().strip_suffix(';').unwrap_or(trimmed);
    if body.contains(';') {
        return Err("Only a single statement is allowed (no embedded ';')".to_string());
    }
    Ok(())
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

    // Auto-bind ALL model tables — the query planner may need fact tables for
    // measure computation even when we only group by a dimension column. Skip
    // connect+bind when every table is already cache-warm (offline slicer values).
    let all_tables: Vec<String> = {
        let engine_arc = get_engine_arc(&bi_state, connection_id)?;
        let engine = engine_arc.lock().await;
        engine.model().tables().iter()
            .map(|t| t.name().to_string())
            .collect()
    };
    let table_refs: Vec<&str> = all_tables.iter().map(|s| s.as_str()).collect();
    if !bi_tables_cache_warm(&bi_state, connection_id, &table_refs).await {
        auto_connect_bi_connection(&bi_state, connection_id).await?;
        auto_bind_tables_on_connection(&bi_state, connection_id, &table_refs).await?;
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
        ..Default::default()
    };

    let engine_arc = get_engine_arc(&bi_state, connection_id)?;
    let (batches, refreshed_tables) = {
        let mut engine = engine_arc.lock().await;
        apply_connection_role(&mut engine, &bi_state, connection_id);
        engine.query_auto_refresh(query_request).await
            .map_err(|e| friendly_bi_query_error("Query failed", &e))?
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
    // Auto-connect + auto-bind, unless every table is already cache-warm (offline).
    let all_tables: Vec<String> = {
        let engine_arc = get_engine_arc(&bi_state, connection_id)?;
        let engine = engine_arc.lock().await;
        engine.model().tables().iter()
            .map(|t| t.name().to_string())
            .collect()
    };
    let table_refs: Vec<&str> = all_tables.iter().map(|s| s.as_str()).collect();
    if !bi_tables_cache_warm(&bi_state, connection_id, &table_refs).await {
        auto_connect_bi_connection(&bi_state, connection_id).await?;
        auto_bind_tables_on_connection(&bi_state, connection_id, &table_refs).await?;
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
        ..Default::default()
    };

    let engine_arc = get_engine_arc(&bi_state, connection_id)?;
    let (batches, refreshed_tables) = {
        let mut engine = engine_arc.lock().await;
        apply_connection_role(&mut engine, &bi_state, connection_id);
        engine.query_auto_refresh(query_request).await
            .map_err(|e| friendly_bi_query_error("Query failed", &e))?
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
    let region_id = identity::EntityId::from_bytes(identity::generate_uuid_v7());

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
    window: tauri::Window,
) -> Result<Vec<BiQueryResult>, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;
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

    // Clear query cache so refreshed queries hit the database for fresh data
    {
        let engine = engine_arc.lock().await;
        engine.clear_query_cache();
    }

    for active_query in &active_queries {
        let query_request = build_engine_query(&active_query.request);

        let (batches, refreshed_tables) = {
            let mut engine = engine_arc.lock().await;
            apply_connection_role(&mut engine, &bi_state, connection_id);
            engine.query_auto_refresh(query_request).await
                .map_err(|e| friendly_bi_query_error("Refresh query failed", &e))?
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
        engine.clear_query_cache();
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
    let (already_connected, conn_str, server, database) = {
        let connections = bi_state.connections.lock().unwrap();
        let conn = connections.get(&connection_id)
            .ok_or_else(|| format!("Connection {} not found", connection_id))?;
        (conn.is_connected, conn.connection_string.clone(), conn.server.clone(), conn.database.clone())
    };

    log_info!("CALP-DIAG", "auto_connect: conn_id={}, already_connected={}, conn_str='{}', server='{}', database='{}'",
        connection_id, already_connected,
        if conn_str.starts_with("__PASSWORD_ONLY__") { "__PASSWORD_ONLY__:***".to_string() }
        else if conn_str.is_empty() { "(empty)".to_string() }
        else { format!("(len={})", conn_str.len()) },
        server, database);

    if already_connected {
        return Ok(());
    }

    // Resolve the connection string — handle __PASSWORD_ONLY__ format
    let mut resolved_conn_str = if conn_str.starts_with("__PASSWORD_ONLY__:") {
        let password = conn_str.trim_start_matches("__PASSWORD_ONLY__:");
        let os_user = std::env::var("USERNAME")
            .unwrap_or_else(|_| "postgres".to_string());
        let full = format!("host={} dbname={} user={} password={}", server, database, os_user, password);
        // Store the resolved connection string
        {
            let mut connections = bi_state.connections.lock().unwrap();
            if let Some(conn) = connections.get_mut(&connection_id) {
                conn.connection_string = full.clone();
            }
        }
        full
    } else {
        conn_str
    };

    if resolved_conn_str.is_empty() {
        // Try cached credentials before failing
        if let Some((cached_user, cached_pass)) =
            super::credential_cache::get_credentials(&server, &database)
        {
            log_info!("BI", "auto_connect: using cached credentials for {}:{}", server, database);
            let full = format!("host={} dbname={} user={} password={}", server, database, cached_user, cached_pass);
            {
                let mut connections = bi_state.connections.lock().unwrap();
                if let Some(conn) = connections.get_mut(&connection_id) {
                    conn.connection_string = full.clone();
                }
            }
            resolved_conn_str = full;
        } else {
            return Err(format!(
                "Not connected. Open Data > Connections and click Connect on '{}' to provide credentials.",
                if !database.is_empty() { &database } else { "the data source" }
            ));
        }
    }

    log_info!("BI", "auto_connect: conn_id={}, connecting...", connection_id);

    let engine_arc = {
        let connections = bi_state.connections.lock().unwrap();
        let conn = connections.get(&connection_id)
            .ok_or_else(|| format!("Connection {} not found", connection_id))?;
        if conn.connection_type != ConnectionType::PostgreSQL {
            return Err(format!(
                "Connection type '{}' is not yet supported for live connect (PostgreSQL only).",
                conn.connection_type.as_str()
            ));
        }
        conn.engine.clone()
            .ok_or("No model loaded for this connection.")?
    };

    let idx = {
        let mut engine = engine_arc.lock().await;
        let (target, auth) = parse_connection_string(&resolved_conn_str);
        engine.add_postgres(target, auth).await
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

    // Read stored bindings from the connection (populated from package/model)
    let stored_bindings: Vec<BiBindRequest> = {
        let connections = bi_state.connections.lock().unwrap();
        connections.get(&connection_id)
            .map(|c| c.bindings.clone())
            .unwrap_or_default()
    };

    let mut engine = engine_arc.lock().await;
    for table_name in table_names {
        if !engine.registry().has_table(table_name) {
            // Check stored bindings first for the correct schema/source_table
            // (or a SQL-query source, which binds as a wrapped subquery).
            let stored = stored_bindings
                .iter()
                .find(|b| b.model_table.eq_ignore_ascii_case(table_name));
            let binding = match stored.and_then(|b| b.source_query.clone()) {
                Some(sql) => {
                    log_info!("BI", "auto_bind: conn={}, {} -> (sql source)", connection_id, table_name);
                    bi_engine::SourceBinding::new_query(*table_name, sql)
                }
                None => {
                    let (schema, source_table) = stored
                        .map(|b| (b.schema.as_str(), b.source_table.as_str()))
                        .unwrap_or(("BI", *table_name));
                    let source_table_lower = source_table.to_lowercase();
                    log_info!("BI", "auto_bind: conn={}, {} -> {}.{}", connection_id, table_name, schema, source_table_lower);
                    bi_engine::SourceBinding::new(schema, &source_table_lower)
                }
            };
            engine.bind_table(*table_name, connector_index, binding);
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
