//! FILENAME: app/src-tauri/src/bi/script_source.rs
//! PURPOSE: Script-fed data sources (model-extensibility Phase 3). A sandboxed
//!          connector SCRIPT fetches external rows (net.fetch, host-held
//!          secrets); the TRUSTED frontend connector host hands them here; this
//!          module materializes them as an ordinary in-memory engine source —
//!          the engine never calls into JS.
//!
//!          Shape (mirrors the writeback source, `writeback_source.rs`):
//!          rows -> Arrow batch -> `InMemoryConnector` swapped in under the
//!          stable source id (replace semantics) -> re-bind + refresh each
//!          bound table. The BINDING ("source S is fed by script X, tables T,
//!          secret slots L") persists in the model's `extension_data` under
//!          `calcula.scriptConnectors` — zero engine changes, and it travels
//!          inside dataset packages automatically.
//!
//! SECURITY: every op carrying a script_id re-checks the `bi.connector` grant
//!          against the authoritative Rust CapabilityStore and lands in the
//!          always-on audit trail. Data volume is hard-capped (a script cannot
//!          feed unbounded rows). Secrets never transit this module — they are
//!          resolved server-side inside the net-fetch gate (net_commands.rs).

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use arrow::array::{ArrayRef, BooleanArray, Date32Array, Float64Array, StringArray};
use arrow::datatypes::{DataType as ArrowDataType, Field, Schema};
use arrow::record_batch::RecordBatch;
use serde::{Deserialize, Serialize};
use tauri::State;

use super::engine_registry::ModelKey;
use super::model_editor::{
    apply_model_edit, editable_base, emit_refresh_completed, RefreshCompletedTable,
};
use super::types::{BiState, ConnectionId};
use crate::persistence::FileState;

/// The extension-data key the connector bindings live under (the reserved
/// `calcula.` namespace).
pub const SCRIPT_CONNECTORS_EXT_KEY: &str = "calcula.scriptConnectors";
/// The cosmetic schema script-fed tables are bound under.
const SCRIPT_SOURCE_SCHEMA: &str = "script";
/// Required prefix for script source ids (keeps them collision-free against
/// user-authored source ids in the model catalog).
const SCRIPT_SOURCE_ID_PREFIX: &str = "script:";

/// Hard caps for one feed (the open question in the design doc, resolved
/// conservatively: enough for real API datasets, hostile to unbounded feeds).
const MAX_FEED_ROWS: usize = 500_000;
const MAX_FEED_CELLS: usize = 5_000_000;

// ---------------------------------------------------------------------------
// Binding records (opaque JSON inside model extension_data)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScriptSourceColumn {
    pub name: String,
    /// "string" | "number" | "boolean" | "date"
    pub data_type: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScriptSourceTableDef {
    pub name: String,
    pub columns: Vec<ScriptSourceColumn>,
    /// Connector-defined parameters passed back to fetchTable(request).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub params: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScriptConnectorBinding {
    pub source_id: String,
    /// The owning connector script (script-registry id). Only this script's
    /// grants authorize feeds/secret use for this source.
    pub script_id: String,
    pub tables: Vec<ScriptSourceTableDef>,
    /// Declared secret slots (names only — values live in the OS credential
    /// store and never travel with the model).
    #[serde(default)]
    pub secret_slots: Vec<String>,
    /// Host-scheduler refresh interval. None = manual refresh only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub refresh_every_secs: Option<u64>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScriptConnectorBag {
    #[serde(default)]
    pub sources: Vec<ScriptConnectorBinding>,
}

/// Parse the connector bag out of a model's extension data (missing/invalid ->
/// empty; the bag is opaque JSON, so tolerate garbage instead of bricking).
pub fn connector_bag(model: &bi_engine::DataModel) -> ScriptConnectorBag {
    model
        .extension_data()
        .get(SCRIPT_CONNECTORS_EXT_KEY)
        .cloned()
        .and_then(|v| serde_json::from_value(v).ok())
        .unwrap_or_default()
}

/// Find the binding for `source_id` across every open connection's model.
/// Used by the net-fetch gate to verify a secret slot's OWNER script.
pub fn find_binding_owner(bi_state: &BiState, source_id: &str) -> Option<String> {
    let conns = bi_state.connections.lock().ok()?;
    for conn in conns.values() {
        if let Some(base) = &conn.base_model {
            if let Some(b) = connector_bag(base)
                .sources
                .iter()
                .find(|b| b.source_id == source_id)
            {
                return Some(b.script_id.clone());
            }
        }
    }
    None
}

// ---------------------------------------------------------------------------
// Fed-batch store: the latest rows per (model, source, table). Feeding one
// table must not wipe the source's other tables when the connector is rebuilt
// (add_connector_with_id has REPLACE semantics), so the full set is kept here.
// ---------------------------------------------------------------------------

type BatchKey = (Option<ModelKey>, String);

fn batch_store() -> &'static Mutex<HashMap<BatchKey, HashMap<String, RecordBatch>>> {
    static STORE: OnceLock<Mutex<HashMap<BatchKey, HashMap<String, RecordBatch>>>> =
        OnceLock::new();
    STORE.get_or_init(|| Mutex::new(HashMap::new()))
}

// ---------------------------------------------------------------------------
// JSON rows -> Arrow batch
// ---------------------------------------------------------------------------

fn model_data_type(dt: &str) -> Result<bi_engine::DataType, String> {
    match dt {
        "string" => Ok(bi_engine::DataType::String),
        "number" => Ok(bi_engine::DataType::Float64),
        "boolean" => Ok(bi_engine::DataType::Boolean),
        "date" => Ok(bi_engine::DataType::Date),
        other => Err(format!(
            "Unsupported column type '{}' (expected string|number|boolean|date)",
            other
        )),
    }
}

/// Days since 1970-01-01 for an ISO "YYYY-MM-DD" (or RFC3339 prefix) string.
fn iso_to_days(s: &str) -> Option<i32> {
    let date_part = s.get(0..10)?;
    let d = chrono::NaiveDate::parse_from_str(date_part, "%Y-%m-%d").ok()?;
    let epoch = chrono::NaiveDate::from_ymd_opt(1970, 1, 1)?;
    Some((d - epoch).num_days() as i32)
}

fn rows_to_batch(
    columns: &[ScriptSourceColumn],
    rows: &[Vec<serde_json::Value>],
) -> Result<RecordBatch, String> {
    if columns.is_empty() {
        return Err("At least one column is required".to_string());
    }
    if rows.len() > MAX_FEED_ROWS {
        return Err(format!(
            "Feed of {} rows exceeds the {} row cap",
            rows.len(),
            MAX_FEED_ROWS
        ));
    }
    if rows.len().saturating_mul(columns.len()) > MAX_FEED_CELLS {
        return Err(format!(
            "Feed of {} cells exceeds the {} cell cap",
            rows.len() * columns.len(),
            MAX_FEED_CELLS
        ));
    }
    for (i, r) in rows.iter().enumerate() {
        if r.len() != columns.len() {
            return Err(format!(
                "Row {} has {} values but {} columns are declared",
                i,
                r.len(),
                columns.len()
            ));
        }
    }

    let mut fields: Vec<Field> = Vec::with_capacity(columns.len());
    let mut arrays: Vec<ArrayRef> = Vec::with_capacity(columns.len());
    for (ci, col) in columns.iter().enumerate() {
        match col.data_type.as_str() {
            "number" => {
                let vals: Vec<Option<f64>> = rows
                    .iter()
                    .map(|r| match &r[ci] {
                        serde_json::Value::Number(n) => n.as_f64(),
                        serde_json::Value::String(s) => s.parse::<f64>().ok(),
                        serde_json::Value::Bool(b) => Some(if *b { 1.0 } else { 0.0 }),
                        _ => None,
                    })
                    .collect();
                fields.push(Field::new(&col.name, ArrowDataType::Float64, true));
                arrays.push(std::sync::Arc::new(Float64Array::from(vals)));
            }
            "boolean" => {
                let vals: Vec<Option<bool>> = rows
                    .iter()
                    .map(|r| match &r[ci] {
                        serde_json::Value::Bool(b) => Some(*b),
                        serde_json::Value::Number(n) => n.as_f64().map(|f| f != 0.0),
                        serde_json::Value::String(s) => match s.to_ascii_lowercase().as_str() {
                            "true" | "1" => Some(true),
                            "false" | "0" => Some(false),
                            _ => None,
                        },
                        _ => None,
                    })
                    .collect();
                fields.push(Field::new(&col.name, ArrowDataType::Boolean, true));
                arrays.push(std::sync::Arc::new(BooleanArray::from(vals)));
            }
            "date" => {
                let vals: Vec<Option<i32>> = rows
                    .iter()
                    .map(|r| match &r[ci] {
                        serde_json::Value::String(s) => iso_to_days(s),
                        _ => None,
                    })
                    .collect();
                fields.push(Field::new(&col.name, ArrowDataType::Date32, true));
                arrays.push(std::sync::Arc::new(Date32Array::from(vals)));
            }
            // "string" (validated by model_data_type before we get here)
            _ => {
                let vals: Vec<Option<String>> = rows
                    .iter()
                    .map(|r| match &r[ci] {
                        serde_json::Value::Null => None,
                        serde_json::Value::String(s) => Some(s.clone()),
                        other => Some(other.to_string()),
                    })
                    .collect();
                fields.push(Field::new(&col.name, ArrowDataType::Utf8, true));
                arrays.push(std::sync::Arc::new(StringArray::from(vals)));
            }
        }
    }
    RecordBatch::try_new(std::sync::Arc::new(Schema::new(fields)), arrays)
        .map_err(|e| format!("Failed to build batch: {}", e))
}

// ---------------------------------------------------------------------------
// The multiplexed command
// ---------------------------------------------------------------------------

fn validate_source_id(source_id: &str) -> Result<(), String> {
    if !source_id.starts_with(SCRIPT_SOURCE_ID_PREFIX) || source_id.len() <= SCRIPT_SOURCE_ID_PREFIX.len() {
        return Err(format!(
            "Script source ids must be namespaced '{}<name>' (got '{}')",
            SCRIPT_SOURCE_ID_PREFIX, source_id
        ));
    }
    Ok(())
}

/// Install / feed / remove a script-fed data source. One multiplexed command
/// (stack-headroom budget): `op: "install" | "feedRows" | "removeBind"`.
///
/// Caller tiers: the trusted connector host (@api scriptConnectors) drives all
/// three ops on behalf of the OWNING script and always passes its script_id,
/// so the `bi.connector` grant is re-checked authoritatively here for every
/// op — revoking the capability stops installs AND refreshes.
#[tauri::command]
pub async fn bi_script_source(
    bi_state: State<'_, BiState>,
    file_state: State<'_, FileState>,
    cap_store: State<'_, crate::scripting::CapabilityStore>,
    app_state: State<'_, crate::AppState>,
    connection_id: ConnectionId,
    script_id: String,
    op: String,
    source_id: String,
    tables: Option<Vec<ScriptSourceTableDef>>,
    secret_slots: Option<Vec<String>>,
    refresh_every_secs: Option<u64>,
    table: Option<String>,
    rows: Option<Vec<Vec<serde_json::Value>>>,
    window: tauri::Window,
) -> Result<serde_json::Value, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;

    // Authoritative grant re-check for the OWNING script.
    if !cap_store.is_bi_granted(&script_id, "bi.connector") {
        crate::log_warn!(
            "SECURITY",
            "bi_script_source DENIED (bi.connector not granted): script={} op={}",
            script_id,
            op
        );
        crate::net_commands::record_capability_call(
            &app_state.audit_log,
            "bi.connector",
            &script_id,
            false,
            Some(&op),
            Some("bi.connector not granted"),
        );
        return Err("PermissionDenied: bi.connector not granted for this script".to_string());
    }
    validate_source_id(&source_id)?;

    let result = match op.as_str() {
        "install" => {
            op_install(
                &bi_state,
                &file_state,
                connection_id.clone(),
                &script_id,
                &source_id,
                tables.unwrap_or_default(),
                secret_slots.unwrap_or_default(),
                refresh_every_secs,
            )
            .await
        }
        "feedRows" => {
            op_feed_rows(
                &bi_state,
                connection_id.clone(),
                &script_id,
                &source_id,
                table.ok_or("'feedRows' requires a table")?,
                rows.unwrap_or_default(),
            )
            .await
        }
        "removeBind" => {
            op_remove_bind(
                &bi_state,
                &file_state,
                connection_id.clone(),
                &script_id,
                &source_id,
            )
            .await
        }
        other => Err(format!(
            "Unknown op '{}' (expected install|feedRows|removeBind)",
            other
        )),
    };

    // Always-on audit, success + failure.
    match &result {
        Ok(_) => crate::net_commands::record_capability_call(
            &app_state.audit_log,
            "bi.connector",
            &script_id,
            true,
            Some(&format!("{} {} — connection {}", op, source_id, connection_id)),
            None,
        ),
        Err(e) => crate::net_commands::record_capability_call(
            &app_state.audit_log,
            "bi.connector",
            &script_id,
            false,
            Some(&format!("{} {} — connection {}", op, source_id, connection_id)),
            Some(e),
        ),
    }
    result
}

/// Install: register the source in the model catalog, create the model tables
/// (bound to the source), and persist the binding record in extension_data —
/// ONE model edit through the funnel (undo + bi:model-changed ride along).
async fn op_install(
    bi_state: &BiState,
    file_state: &FileState,
    connection_id: ConnectionId,
    script_id: &str,
    source_id: &str,
    tables: Vec<ScriptSourceTableDef>,
    secret_slots: Vec<String>,
    refresh_every_secs: Option<u64>,
) -> Result<serde_json::Value, String> {
    if tables.is_empty() {
        return Err("'install' requires at least one table".to_string());
    }
    for t in &tables {
        if t.name.trim().is_empty() {
            return Err("Table names cannot be empty".to_string());
        }
        if t.columns.is_empty() {
            return Err(format!("Table '{}' declares no columns", t.name));
        }
        for c in &t.columns {
            model_data_type(&c.data_type)?;
        }
    }
    let _ = editable_base(bi_state, connection_id.clone())?;

    let sid = script_id.to_string();
    let src_id = source_id.to_string();
    let tables_for_edit = tables.clone();
    apply_model_edit(bi_state, connection_id.clone(), move |base, _calculated| {
        // 1. Source catalog entry (idempotent).
        let mut edited = base.clone();
        if edited.source(&src_id).is_none() {
            let src = bi_engine::PersistedSource::new(
                src_id.clone(),
                bi_engine::SourceKind::InMemory,
                Default::default(),
                bi_engine::PersistedAuthKind::Integrated,
            )
            .with_display_name(format!("Script connector ({})", src_id));
            edited.push_source(src).map_err(|e| format!("{}", e))?;
        }

        // 2. Model tables. A name collision with a table NOT bound to this
        //    source is an error; re-installing this source's own table
        //    replaces its definition (idempotent reinstall).
        let mut model_tables: Vec<bi_engine::Table> = edited.tables().to_vec();
        for def in &tables_for_edit {
            if let Some(existing) = model_tables.iter().find(|t| t.name() == def.name) {
                let ours = existing
                    .source_binding()
                    .map(|b| b.source_id == src_id)
                    .unwrap_or(false);
                if !ours {
                    return Err(format!(
                        "The model already has a table named '{}' (not fed by this connector)",
                        def.name
                    ));
                }
                model_tables.retain(|t| t.name() != def.name);
            }
            let columns: Vec<bi_engine::Column> = def
                .columns
                .iter()
                .map(|c| Ok(bi_engine::Column::new(&c.name, model_data_type(&c.data_type)?)))
                .collect::<Result<Vec<_>, String>>()?;
            let mut t =
                bi_engine::Table::new(&def.name, columns).map_err(|e| format!("{}", e))?;
            t.set_storage_mode(bi_engine::StorageMode::InMemory);
            let t = t.with_source_binding(bi_engine::TableSourceBinding::new(
                &src_id,
                SCRIPT_SOURCE_SCHEMA,
                &def.name,
            ));
            model_tables.push(t);
        }
        let edited = edited.with_tables(model_tables);

        // 3. Binding record in extension_data (upsert by source id).
        let mut bag = connector_bag(&edited);
        bag.sources.retain(|b| b.source_id != src_id);
        bag.sources.push(ScriptConnectorBinding {
            source_id: src_id.clone(),
            script_id: sid.clone(),
            tables: tables_for_edit.clone(),
            secret_slots: secret_slots.clone(),
            refresh_every_secs,
        });
        let mut data = edited.extension_data().clone();
        data.insert(
            SCRIPT_CONNECTORS_EXT_KEY.to_string(),
            serde_json::to_value(&bag).map_err(|e| e.to_string())?,
        );
        let edited = edited.with_extension_data(data);
        edited.validate().map_err(|e| format!("{}", e))?;
        Ok(edited)
    })
    .await?;
    *file_state.is_modified.lock().map_err(|e| e.to_string())? = true;
    crate::log_info!(
        "BI",
        "script source '{}' installed ({} table(s), conn {})",
        source_id,
        tables.len(),
        connection_id
    );
    Ok(serde_json::Value::Null)
}

/// Feed rows for ONE table: update the fed-batch store, rebuild the source's
/// connector from ALL its stored batches (replace semantics), re-bind + refresh
/// every bound table, and emit bi:refresh-completed.
async fn op_feed_rows(
    bi_state: &BiState,
    connection_id: ConnectionId,
    script_id: &str,
    source_id: &str,
    table: String,
    rows: Vec<Vec<serde_json::Value>>,
) -> Result<serde_json::Value, String> {
    // The binding is the authorization record: only a pre-installed source
    // accepts data, only for its declared tables, only from its OWNER script.
    let (engine_arc, model_key, binding) = {
        let conns = bi_state.connections.lock().unwrap();
        let conn = conns.get(&connection_id).ok_or("Connection not found")?;
        let base = conn
            .base_model
            .as_ref()
            .ok_or("This connection has no model loaded")?;
        let binding = connector_bag(base)
            .sources
            .into_iter()
            .find(|b| b.source_id == source_id)
            .ok_or_else(|| format!("No script connector '{}' installed on this model", source_id))?;
        (
            conn.engine
                .clone()
                .ok_or("No engine for this connection")?,
            conn.model_key.clone(),
            binding,
        )
    };
    if binding.script_id != script_id {
        return Err(format!(
            "PermissionDenied: connector '{}' is owned by another script",
            source_id
        ));
    }
    let table_def = binding
        .tables
        .iter()
        .find(|t| t.name == table)
        .ok_or_else(|| format!("Connector '{}' declares no table '{}'", source_id, table))?;

    let batch = rows_to_batch(&table_def.columns, &rows)?;
    let row_count = batch.num_rows();

    // Update the store, snapshot the source's full batch set.
    let batches: HashMap<String, RecordBatch> = {
        let mut store = batch_store().lock().unwrap();
        let entry = store
            .entry((model_key.clone(), source_id.to_string()))
            .or_default();
        entry.insert(table.clone(), batch);
        entry.clone()
    };

    // Swap the connector in and refresh (writeback_source pattern).
    let started = std::time::Instant::now();
    let mut engine = engine_arc.lock().await;
    let mut connector = bi_engine::InMemoryConnector::new();
    for (t, b) in &batches {
        connector = connector.with_table(SCRIPT_SOURCE_SCHEMA, t.clone(), b.clone());
    }
    let idx = engine
        .registry_mut()
        .add_connector_with_id(Some(source_id.to_string()), connector.into());
    let mut results: Vec<RefreshCompletedTable> = Vec::new();
    for t in batches.keys() {
        engine.registry_mut().bind(
            t.clone(),
            idx,
            bi_engine::SourceBinding::new(SCRIPT_SOURCE_SCHEMA, t),
        );
        match engine.refresh_table(t).await {
            Ok(()) => results.push(RefreshCompletedTable { name: t.clone(), ok: true, error: None }),
            Err(e) => results.push(RefreshCompletedTable {
                name: t.clone(),
                ok: false,
                error: Some(format!("{}", e)),
            }),
        }
    }
    drop(engine);
    emit_refresh_completed(&connection_id, results, started.elapsed().as_millis() as u64);
    crate::log_info!(
        "BI",
        "script source '{}': fed {} rows into '{}' (conn {})",
        source_id,
        row_count,
        table,
        connection_id
    );
    Ok(serde_json::json!({ "rowCount": row_count }))
}

/// Remove the binding, its tables, and the catalog entry — one model edit.
/// Dependents (measures on the fed tables) fail validate() with a clear error,
/// so removal never silently breaks the model.
async fn op_remove_bind(
    bi_state: &BiState,
    file_state: &FileState,
    connection_id: ConnectionId,
    script_id: &str,
    source_id: &str,
) -> Result<serde_json::Value, String> {
    let _ = editable_base(bi_state, connection_id.clone())?;
    let src_id = source_id.to_string();
    let sid = script_id.to_string();
    let model_key = {
        let conns = bi_state.connections.lock().unwrap();
        conns
            .get(&connection_id)
            .ok_or("Connection not found")?
            .model_key
            .clone()
    };
    apply_model_edit(bi_state, connection_id.clone(), move |base, _calculated| {
        let bag = connector_bag(base);
        let binding = bag
            .sources
            .iter()
            .find(|b| b.source_id == src_id)
            .ok_or_else(|| format!("No script connector '{}' installed on this model", src_id))?;
        if binding.script_id != sid {
            return Err(format!(
                "PermissionDenied: connector '{}' is owned by another script",
                src_id
            ));
        }
        // Drop the fed tables + catalog entry + binding record.
        let tables: Vec<bi_engine::Table> = base
            .tables()
            .iter()
            .filter(|t| {
                t.source_binding()
                    .map(|b| b.source_id != src_id)
                    .unwrap_or(true)
            })
            .cloned()
            .collect();
        let sources: Vec<bi_engine::PersistedSource> = base
            .sources()
            .iter()
            .filter(|s| s.id != src_id)
            .cloned()
            .collect();
        let mut bag = bag;
        bag.sources.retain(|b| b.source_id != src_id);
        let mut data = base.extension_data().clone();
        if bag.sources.is_empty() {
            data.remove(SCRIPT_CONNECTORS_EXT_KEY);
        } else {
            data.insert(
                SCRIPT_CONNECTORS_EXT_KEY.to_string(),
                serde_json::to_value(&bag).map_err(|e| e.to_string())?,
            );
        }
        let edited = base
            .with_tables(tables)
            .with_sources(sources)
            .with_extension_data(data);
        edited.validate().map_err(|e| format!("{}", e))?;
        Ok(edited)
    })
    .await?;
    // Clear the fed batches.
    batch_store()
        .lock()
        .unwrap()
        .remove(&(model_key, source_id.to_string()));
    *file_state.is_modified.lock().map_err(|e| e.to_string())? = true;
    crate::log_info!(
        "BI",
        "script source '{}' removed (conn {})",
        source_id,
        connection_id
    );
    Ok(serde_json::Value::Null)
}

// ---------------------------------------------------------------------------
// Connector secrets (host-held; the script never reads them)
// ---------------------------------------------------------------------------

/// The "server" half of the credential-cache target for a connector secret —
/// the pair (connector-source-id, slot) maps onto the existing
/// (server, database) target scheme: `Calcula:connector/<sourceId>|<slot>`.
fn secret_server_key(source_id: &str) -> String {
    format!("connector/{}", source_id)
}

/// Resolve a connector secret (used ONLY by the net-fetch gate for
/// server-side header injection — never returned to any frontend caller).
pub fn resolve_connector_secret(source_id: &str, slot: &str) -> Option<String> {
    super::credential_cache::get_credentials(&secret_server_key(source_id), slot)
        .map(|(_user, secret)| secret)
}

/// Manage connector secrets — PRIVILEGED, user-UI only (the `credentials`
/// denylist group; the broker never routes here). `op: "list" | "set" |
/// "delete"`. `list` returns the binding's DECLARED slots with an isSet flag —
/// never values; there is no op that reads a value out.
#[tauri::command]
pub fn connector_secrets(
    bi_state: State<'_, BiState>,
    op: String,
    source_id: String,
    slot: Option<String>,
    value: Option<String>,
    window: tauri::Window,
) -> Result<serde_json::Value, String> {
    crate::security::window_guard::require_label(&window, crate::security::window_guard::MAIN)?;
    validate_source_id(&source_id)?;

    match op.as_str() {
        "list" => {
            // Declared slots come from the binding (any open connection's model).
            let declared: Vec<String> = {
                let conns = bi_state.connections.lock().unwrap();
                conns
                    .values()
                    .filter_map(|c| c.base_model.as_ref())
                    .flat_map(|m| connector_bag(m).sources)
                    .find(|b| b.source_id == source_id)
                    .map(|b| b.secret_slots)
                    .unwrap_or_default()
            };
            let entries: Vec<serde_json::Value> = declared
                .iter()
                .map(|s| {
                    serde_json::json!({
                        "slot": s,
                        "isSet": resolve_connector_secret(&source_id, s).is_some(),
                    })
                })
                .collect();
            Ok(serde_json::Value::Array(entries))
        }
        "set" => {
            let slot = slot.ok_or("'set' requires a slot")?;
            let value = value.ok_or("'set' requires a value")?;
            if slot.trim().is_empty() {
                return Err("Slot names cannot be empty".to_string());
            }
            super::credential_cache::save_credentials(
                &secret_server_key(&source_id),
                &slot,
                "secret",
                &value,
            );
            crate::log_info!("BI", "connector secret set: {} / {}", source_id, slot);
            Ok(serde_json::Value::Null)
        }
        "delete" => {
            let slot = slot.ok_or("'delete' requires a slot")?;
            super::credential_cache::delete_credentials(&secret_server_key(&source_id), &slot);
            Ok(serde_json::Value::Null)
        }
        other => Err(format!("Unknown op '{}' (expected list|set|delete)", other)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rows_to_batch_types_and_caps() {
        let cols = vec![
            ScriptSourceColumn { name: "name".into(), data_type: "string".into() },
            ScriptSourceColumn { name: "amount".into(), data_type: "number".into() },
            ScriptSourceColumn { name: "active".into(), data_type: "boolean".into() },
            ScriptSourceColumn { name: "day".into(), data_type: "date".into() },
        ];
        let rows = vec![
            vec![
                serde_json::json!("widget"),
                serde_json::json!(12.5),
                serde_json::json!(true),
                serde_json::json!("2026-07-15"),
            ],
            vec![
                serde_json::json!(null),
                serde_json::json!("7"),
                serde_json::json!(0),
                serde_json::json!("2026-07-15T10:00:00Z"),
            ],
        ];
        let batch = rows_to_batch(&cols, &rows).unwrap();
        assert_eq!(batch.num_rows(), 2);
        assert_eq!(batch.num_columns(), 4);

        // Ragged rows are rejected with a clear message.
        let bad = vec![vec![serde_json::json!("x")]];
        let err = rows_to_batch(&cols, &bad).unwrap_err();
        assert!(err.contains("1 values but 4 columns"), "got: {err}");
    }

    #[test]
    fn source_id_namespace_is_enforced() {
        assert!(validate_source_id("script:crm").is_ok());
        assert!(validate_source_id("crm").is_err());
        assert!(validate_source_id("script:").is_err());
    }

    #[test]
    fn connector_bag_tolerates_missing_and_garbage() {
        let model = bi_engine::DataModel::builder().build().unwrap();
        assert!(connector_bag(&model).sources.is_empty());
        let mut data = std::collections::BTreeMap::new();
        data.insert(
            SCRIPT_CONNECTORS_EXT_KEY.to_string(),
            serde_json::json!("not an object"),
        );
        let tagged = model.with_extension_data(data);
        assert!(connector_bag(&tagged).sources.is_empty());
    }
}
