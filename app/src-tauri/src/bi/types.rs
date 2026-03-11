//! FILENAME: app/src-tauri/src/bi/types.rs
//! PURPOSE: BI state and serializable request/response types for Tauri commands.
//! CONTEXT: All types use #[serde(rename_all = "camelCase")] for automatic
//!          snake_case (Rust) <-> camelCase (TypeScript) conversion.

use serde::{Deserialize, Serialize};
use std::sync::Mutex;

// ---------------------------------------------------------------------------
// BI Application State
// ---------------------------------------------------------------------------

/// Managed state for the BI extension, stored alongside AppState in Tauri.
pub struct BiState {
    /// The Engine Lib instance. None until a model is loaded.
    pub engine: Mutex<Option<bi_engine::Engine>>,
    /// Index of the connected database source within the Engine registry.
    pub connector_index: Mutex<Option<usize>>,
    /// Connection string for display/reconnect purposes.
    pub connection_string: Mutex<Option<String>>,
    /// Metadata about the last query that was inserted into the grid.
    pub active_query: Mutex<Option<ActiveQuery>>,
    /// Auto-incrementing ID for BI regions.
    pub next_region_id: Mutex<u64>,
}

impl BiState {
    pub fn new() -> Self {
        Self {
            engine: Mutex::new(None),
            connector_index: Mutex::new(None),
            connection_string: Mutex::new(None),
            active_query: Mutex::new(None),
            next_region_id: Mutex::new(1),
        }
    }
}

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
pub struct BiConnectRequest {
    pub connection_string: String,
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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BiInsertRequest {
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
