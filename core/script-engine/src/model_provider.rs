//! FILENAME: core/script-engine/src/model_provider.rs
//! PURPOSE: Host-provided READ-ONLY access to BI data models for scripts.
//! CONTEXT: The script engine defines this contract; the app implements it
//! over BiState (app/src-tauri/src/bi/script_provider.rs) and injects it into
//! ScriptContext. Surfaces without model access (one-off run_script, MCP
//! execute_script) leave it None — the ops layer then raises a clear
//! "not available on this surface" error. All methods are BLOCKING from the
//! engine's perspective (QuickJS eval is synchronous); the host bridges to
//! async internally and enforces capability consent + audit per call.

use serde::{Deserialize, Serialize};

/// A structured model query (mirrors the app's BiQueryRequest wire shape so
/// snippets port between the notebook and worker-realm script surfaces).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelQuerySpec {
    #[serde(default)]
    pub measures: Vec<String>,
    #[serde(default)]
    pub group_by: Vec<ModelColumnRef>,
    #[serde(default)]
    pub filters: Vec<ModelFilterSpec>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelColumnRef {
    pub table: String,
    pub column: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelFilterSpec {
    pub table: String,
    pub column: String,
    pub operator: String,
    pub value: String,
}

/// A tabular query result. `rows` cells are display strings (None = null).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelTable {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<Option<String>>>,
    /// Row count before any host-side truncation.
    pub total_rows: usize,
    /// True when rows were dropped to fit the host's row cap.
    pub truncated: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ModelProviderErrorKind {
    /// The capability (named in `message`) has not been granted for this
    /// surface. The ops layer surfaces this with the BI_CONSENT_REQUIRED
    /// sentinel so the frontend can prompt and retry.
    ConsentRequired,
    /// Model access is not available (no such connection, no model loaded).
    NotAvailable,
    /// Connection / data-source failure.
    Connection,
    /// The query itself failed.
    Query,
    /// The host-side timeout elapsed.
    Timeout,
}

#[derive(Debug, Clone)]
pub struct ModelProviderError {
    pub kind: ModelProviderErrorKind,
    pub message: String,
}

impl ModelProviderError {
    pub fn new(kind: ModelProviderErrorKind, message: impl Into<String>) -> Self {
        ModelProviderError {
            kind,
            message: message.into(),
        }
    }
}

/// Host-provided read-only access to BI models. `surface` is the calling
/// script surface id (e.g. "notebook:nb-123") — the host keys capability
/// grants and audit records by it.
pub trait ModelDataProvider {
    /// Whitelisted connection summaries as a JSON array string (the engine
    /// never interprets it; ops hand it to JS via JSON.parse).
    fn connections(&self, surface: &str) -> Result<String, ModelProviderError>;

    /// Model metadata (tables/columns/measures/relationships/KPIs/roles) for
    /// one connection, as a JSON object string. `connection` is a name or id.
    fn model_info(&self, surface: &str, connection: &str) -> Result<String, ModelProviderError>;

    /// Structured model-scoped query (bi.query trust class).
    fn query(
        &self,
        surface: &str,
        connection: &str,
        spec: &ModelQuerySpec,
    ) -> Result<ModelTable, ModelProviderError>;

    /// Read-only raw SQL (the higher-trust bi.sql class).
    fn sql(&self, surface: &str, connection: &str, sql: &str)
        -> Result<ModelTable, ModelProviderError>;

    /// CUBE parity: scalar measure value under member filters (bi.query).
    fn cube_value(
        &self,
        surface: &str,
        connection: &str,
        members: &[String],
    ) -> Result<Option<f64>, ModelProviderError>;

    /// CUBE parity: distinct members of a `Table[Column]` level (bi.query).
    fn cube_members(
        &self,
        surface: &str,
        connection: &str,
        level: &str,
    ) -> Result<Vec<String>, ModelProviderError>;

    /// CUBE parity: KPI value/goal/status (property 1/2/3) (bi.query).
    fn cube_kpi(
        &self,
        surface: &str,
        connection: &str,
        kpi: &str,
        property: i64,
    ) -> Result<Option<f64>, ModelProviderError>;
}
