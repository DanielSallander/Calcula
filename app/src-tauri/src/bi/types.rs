//! FILENAME: app/src-tauri/src/bi/types.rs
//! PURPOSE: BI state and serializable request/response types for Tauri commands.
//! CONTEXT: Multi-connection model. Each connection wraps a BI engine, database
//!          connection, table bindings, and metadata. All serializable types use
//!          #[serde(rename_all = "camelCase")] for automatic snake_case <-> camelCase.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tokio::sync::Mutex as TokioMutex;

use super::engine_registry::{EngineRegistry, ModelKey};

// ---------------------------------------------------------------------------
// Connection ID
// ---------------------------------------------------------------------------

pub type ConnectionId = u64;

// ---------------------------------------------------------------------------
// BI Application State (multi-connection)
// ---------------------------------------------------------------------------

/// Managed state for the BI extension, stored alongside AppState in Tauri.
/// Supports multiple named connections, each with its own engine instance.
/// The EngineRegistry provides shared engines across connections using the same model.
pub struct BiState {
    /// All connections, keyed by ConnectionId.
    pub connections: Mutex<HashMap<ConnectionId, Connection>>,
    /// Auto-incrementing ID for new connections.
    pub next_connection_id: Mutex<ConnectionId>,
    /// Auto-incrementing ID for BI regions (grid-inserted query results).
    pub next_region_id: Mutex<u64>,
    /// Shared engine registry — multiple connections using the same model share one Engine.
    pub engine_registry: EngineRegistry,
}

impl BiState {
    pub fn new() -> Self {
        Self {
            connections: Mutex::new(HashMap::new()),
            next_connection_id: Mutex::new(1),
            next_region_id: Mutex::new(1),
            engine_registry: EngineRegistry::new(),
        }
    }
}

// ---------------------------------------------------------------------------
// Connection (internal, not serialized directly to frontend)
// ---------------------------------------------------------------------------

/// A single BI data connection — wraps a model, engine, database link, and metadata.
pub struct Connection {
    /// Unique identifier.
    pub id: ConnectionId,
    /// User-facing name (e.g., "Sales Database").
    pub name: String,
    /// Optional description.
    pub description: String,
    /// Connection type (currently only PostgreSQL).
    pub connection_type: ConnectionType,
    /// Database connection string.
    pub connection_string: String,
    /// Path to the loaded model JSON file.
    pub model_path: Option<String>,
    /// The shared BI Engine instance (Arc for sharing across connections with the same model).
    /// None until a model is loaded.
    pub engine: Option<Arc<TokioMutex<bi_engine::Engine>>>,
    /// The model key for the shared engine registry.
    pub model_key: Option<ModelKey>,
    /// Index of the connected database source within the Engine registry.
    pub connector_index: Option<usize>,
    /// Table bindings for re-connect scenarios.
    pub bindings: Vec<BiBindRequest>,
    /// ISO 8601 timestamp of last successful refresh/query.
    pub last_refreshed: Option<String>,
    /// ISO 8601 timestamp of creation.
    pub created_at: String,
    /// Whether the database is currently connected.
    pub is_connected: bool,
    /// Active queries inserted into the grid from this connection.
    pub active_queries: HashMap<u64, ActiveQuery>,
}

/// Supported connection types.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum ConnectionType {
    PostgreSQL,
}

impl ConnectionType {
    pub fn as_str(&self) -> &str {
        match self {
            ConnectionType::PostgreSQL => "PostgreSQL",
        }
    }
}

impl std::fmt::Display for ConnectionType {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.as_str())
    }
}

// ---------------------------------------------------------------------------
// ConnectionInfo (serializable summary sent to frontend)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionInfo {
    pub id: u64,
    pub name: String,
    pub description: String,
    pub connection_type: String,
    pub connection_string: String,
    pub model_path: Option<String>,
    pub last_refreshed: Option<String>,
    pub is_connected: bool,
    pub table_count: usize,
    pub measure_count: usize,
}

impl Connection {
    /// Build a ConnectionInfo summary for the frontend.
    /// Note: this uses try_lock since we're often inside a std::sync::Mutex on connections.
    pub fn to_info(&self) -> ConnectionInfo {
        let (table_count, measure_count) = match &self.engine {
            Some(engine_arc) => {
                match engine_arc.try_lock() {
                    Ok(engine) => {
                        let model = engine.model();
                        (model.tables().len(), model.measures().len())
                    }
                    Err(_) => (0, 0), // Engine is busy, return zeros
                }
            }
            None => (0, 0),
        };

        ConnectionInfo {
            id: self.id,
            name: self.name.clone(),
            description: self.description.clone(),
            connection_type: self.connection_type.as_str().to_string(),
            connection_string: self.connection_string.clone(),
            model_path: self.model_path.clone(),
            last_refreshed: self.last_refreshed.clone(),
            is_connected: self.is_connected,
            table_count,
            measure_count,
        }
    }
}

// ---------------------------------------------------------------------------
// ActiveQuery (tracks grid-inserted query results for refresh)
// ---------------------------------------------------------------------------

/// Tracks the last inserted query result so Refresh can re-execute and update.
#[derive(Debug, Clone)]
pub struct ActiveQuery {
    /// The query request that produced the result.
    pub request: BiQueryRequest,
    /// Sheet where the result was inserted.
    pub sheet_index: usize,
    /// Top-left cell of the inserted region.
    pub start_row: u32,
    pub start_col: u32,
    /// Bottom-right cell of the inserted region.
    pub end_row: u32,
    pub end_col: u32,
    /// The region owner ID for ProtectedRegion lookup.
    pub region_id: u64,
}

// ---------------------------------------------------------------------------
// Request Types (from TypeScript)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateConnectionRequest {
    pub name: String,
    pub description: Option<String>,
    pub connection_string: String,
    pub model_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateConnectionRequest {
    pub id: u64,
    pub name: Option<String>,
    pub description: Option<String>,
    pub connection_string: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BiConnectRequest {
    pub connection_id: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BiBindRequest {
    pub model_table: String,
    pub schema: String,
    pub source_table: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BiQueryRequest {
    pub measures: Vec<String>,
    pub group_by: Vec<BiColumnRef>,
    pub filters: Vec<BiFilter>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BiColumnRef {
    pub table: String,
    pub column: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BiFilter {
    pub column: String,
    pub table: String,
    pub operator: String,
    pub value: String,
}

/// A cross-filter constraint: only include rows where the given column's value
/// is in the provided list. Used for cross-filtering between ribbon filters.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BiCrossFilter {
    pub table: String,
    pub column: String,
    pub values: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BiInsertRequest {
    pub connection_id: u64,
    pub sheet_index: usize,
    pub start_row: u32,
    pub start_col: u32,
}

// ---------------------------------------------------------------------------
// Response Types (to TypeScript)
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BiModelInfo {
    pub tables: Vec<BiTableInfo>,
    pub measures: Vec<BiMeasureInfo>,
    pub relationships: Vec<BiRelationshipInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BiTableInfo {
    pub name: String,
    pub columns: Vec<BiColumnInfo>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BiColumnInfo {
    pub name: String,
    pub data_type: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BiMeasureInfo {
    pub name: String,
    pub table: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BiRelationshipInfo {
    pub name: String,
    pub from_table: String,
    pub from_column: String,
    pub to_table: String,
    pub to_column: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BiQueryResult {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<Option<String>>>,
    pub row_count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BiInsertResponse {
    pub start_row: u32,
    pub start_col: u32,
    pub end_row: u32,
    pub end_col: u32,
    pub region_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BiRegionInfo {
    pub region_id: String,
    pub start_row: u32,
    pub start_col: u32,
    pub end_row: u32,
    pub end_col: u32,
}
