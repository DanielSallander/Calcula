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

pub type ConnectionId = identity::EntityId;

// ---------------------------------------------------------------------------
// BI Application State (multi-connection)
// ---------------------------------------------------------------------------

/// Managed state for the BI extension, stored alongside AppState in Tauri.
/// Supports multiple named connections, each with its own engine instance.
/// The EngineRegistry provides shared engines across connections using the same model.
pub struct BiState {
    /// All connections, keyed by ConnectionId.
    pub connections: Mutex<HashMap<ConnectionId, Connection>>,
    /// Shared engine registry — multiple connections using the same model share one Engine.
    pub engine_registry: EngineRegistry,
    /// Saved "view as" RLS roles awaiting their connection, keyed by a stable
    /// connection identity (package data source id, or model path for a local
    /// connection). Loaded from the workbook on open; consumed when a matching
    /// connection is (re)created so the chosen role survives save/reload + re-pull.
    pub pending_roles: Mutex<HashMap<String, String>>,
}

impl BiState {
    pub fn new() -> Self {
        Self {
            connections: Mutex::new(HashMap::new()),
            engine_registry: EngineRegistry::new(),
            pending_roles: Mutex::new(HashMap::new()),
        }
    }

    /// Resolve the saved RLS role for a connection about to be created, by its
    /// stable identity (package data source id preferred, then model path).
    pub fn pending_role_for(
        &self,
        package_data_source_id: Option<&str>,
        model_path: Option<&str>,
    ) -> Option<String> {
        let pending = self.pending_roles.lock().unwrap();
        package_data_source_id
            .and_then(|k| pending.get(k).cloned())
            .or_else(|| model_path.and_then(|k| pending.get(k).cloned()))
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
    /// Database server host (or host:port). No credentials. From model connectionSpecs.
    pub server: String,
    /// Database name. From model connectionSpecs.
    pub database: String,
    /// Preferred authentication method from model connectionSpecs.
    /// "Integrated" = Windows/SSPI, "UsernamePassword" = prompt for creds.
    pub preferred_auth: String,
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
    pub active_queries: HashMap<identity::EntityId, ActiveQuery>,
    /// For connections materialized from a pulled .calp package: the package
    /// data source id this connection represents. Lets the subscription
    /// machinery (verify/save credentials) find and configure the SAME
    /// connection that pivots query. None for locally created connections.
    pub package_data_source_id: Option<String>,
    /// The active "view as" row-level-security role for this connection, or
    /// None for unrestricted. v1: at most ONE role — every Calcula query path
    /// (bi_query / column-values / refresh go through query_auto_refresh, and
    /// drill-through uses query_rows) fails closed under multiple roles, so a
    /// single-role model keeps all paths uniformly enforceable. Re-applied on
    /// the (possibly shared) engine inside the query lock before every query so
    /// a sibling connection's role can never leak into this one's results.
    /// In-memory for now; not yet persisted across app restarts.
    pub active_role: Option<String>,
    /// The model as originally loaded (no workbook-local calculated measures).
    /// Kept so calculated measures can be (re)applied as `base + measures` via
    /// `engine.set_model(...)` without re-reading the source. Schema-only (small).
    pub base_model: Option<bi_engine::DataModel>,
    /// Workbook-local calculated measures defined for this connection's model
    /// (e.g. `[Profit Margin] = [Profit]/[Revenue]`). Persisted in the workbook;
    /// applied to the engine's model so CUBE formulas + pivots can use them.
    pub calculated_measures: Vec<CalculatedMeasure>,
}

/// A workbook-local calculated measure: a name + an engine measure expression.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CalculatedMeasure {
    pub name: String,
    pub expression: String,
}

/// Supported connection types.
/// SqlServer connections are stored faithfully (the type from a package
/// manifest or model spec is preserved), but live connect support currently
/// exists for PostgreSQL only — connect attempts on other types surface a
/// clear error instead of silently treating them as PostgreSQL.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum ConnectionType {
    PostgreSQL,
    SqlServer,
}

impl ConnectionType {
    pub fn as_str(&self) -> &str {
        match self {
            ConnectionType::PostgreSQL => "PostgreSQL",
            ConnectionType::SqlServer => "SqlServer",
        }
    }

    /// Parse a connection type string (from a package manifest or a model's
    /// connectionSpecs connectorType). Unknown values default to PostgreSQL.
    pub fn parse_or_default(s: &str) -> Self {
        match s.trim().to_ascii_lowercase().as_str() {
            "sqlserver" | "sql server" | "mssql" => ConnectionType::SqlServer,
            _ => ConnectionType::PostgreSQL,
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
    pub id: ConnectionId,
    pub name: String,
    pub description: String,
    pub connection_type: String,
    pub connection_string: String,
    pub server: String,
    pub database: String,
    pub preferred_auth: String,
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
            server: self.server.clone(),
            database: self.database.clone(),
            preferred_auth: self.preferred_auth.clone(),
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
    pub region_id: identity::EntityId,
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
    /// Path to a model .json file. Optional when `model_json` carries the
    /// model inline — the loose file is interchange, not identity.
    #[serde(default)]
    pub model_path: Option<String>,
    /// Inline model JSON (a raw DataModel or a Studio ModelBundle wrapper).
    /// When present the connection is created without touching the
    /// filesystem; the embedded model is authoritative (path-identity
    /// removal — models live in workbooks/packages, files are import/export).
    #[serde(default)]
    pub model_json: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateConnectionRequest {
    pub id: ConnectionId,
    pub name: Option<String>,
    pub description: Option<String>,
    pub connection_string: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BiConnectRequest {
    pub connection_id: ConnectionId,
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
    pub connection_id: ConnectionId,
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
    #[serde(default)]
    pub hierarchies: Vec<crate::pivot::types::BiHierarchyMeta>,
    /// KPIs the model defines (Studio-authored). Presentation metadata: the host
    /// renders the status indicator from a base-measure value, the target, and
    /// the bands; the engine does not compute the status.
    #[serde(default)]
    pub kpis: Vec<BiKpiInfo>,
    /// Row-level-security roles the model defines (Studio-authored). The host
    /// surfaces them in a "View as role" selector; the engine enforces the row
    /// filters when a role is activated on the connection.
    #[serde(default)]
    pub security_roles: Vec<BiSecurityRoleInfo>,
    /// Calculation groups the model defines (Studio-authored). Read-only here;
    /// items are measure templates applied on the Values axis in a pivot, not
    /// groupable dimensions.
    #[serde(default)]
    pub calculation_groups: Vec<crate::pivot::types::BiCalcGroupMeta>,
}

/// A row-level-security role surfaced to the frontend (mirrors the engine
/// `SecurityRole`). The host renders the role name + a filter summary; the
/// engine enforces the filters as sealed pre-aggregation restrictions when the
/// role is activated.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BiSecurityRoleInfo {
    /// The role's unique name (the key the host activates).
    pub name: String,
    /// Per-table row filters this role applies (presentation/diagnostic).
    pub table_filters: Vec<BiFilterPredicateInfo>,
    /// True if ANY predicate is dynamic (USERNAME()/CUSTOMDATA()). v1 disables
    /// selecting a dynamic role until runtime-identity wiring lands.
    pub is_dynamic: bool,
}

/// A single row filter predicate within a security role (`Table.Column op value`).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BiFilterPredicateInfo {
    pub table: String,
    pub column: String,
    /// Debug form of the engine `ComparisonOp` (e.g. "Equal", "GreaterThan").
    pub operator: String,
    pub value: String,
    /// `None` for a static predicate; "Username" | "CustomData" for a dynamic one.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dynamic: Option<String>,
}

/// A KPI surfaced to the frontend (mirrors the engine `Kpi`). Status is computed
/// host-side from a base-measure value vs the target across the status bands.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BiKpiInfo {
    pub name: String,
    /// The measure whose value drives this KPI.
    pub base_measure: String,
    /// "constant" (fixed goal) or "measure" (goal supplied per row by a measure).
    pub target_kind: String,
    /// The fixed goal, when `target_kind == "constant"`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_value: Option<f64>,
    /// The goal measure name, when `target_kind == "measure"`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_measure: Option<String>,
    /// Status bands, ascending by `threshold` over the base/target ratio.
    pub status_bands: Vec<BiStatusBand>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

/// One KPI status band: a base/target ratio at or above `threshold` (and below
/// the next band) maps to `status` ("OffTrack" | "AtRisk" | "OnTrack").
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BiStatusBand {
    pub threshold: f64,
    pub status: String,
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
    /// True for a Studio-authored CONTEXT column (dynamic segmentation). Not a
    /// physical column, but groupable like an ordinary dimension.
    #[serde(default)]
    pub is_context_column: bool,
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
