//! FILENAME: core/calp/src/data_refresh.rs
//! PURPOSE: Connection resolution and data refresh for live .calp packages.
//! CONTEXT: When a subscriber clicks "Refresh Data", this module handles
//! resolving database connections (SSPI -> prompt fallback) and orchestrating
//! query re-execution against the BI engine.

use serde::{Deserialize, Serialize};

use crate::manifest::{PackageDataSource, SubscriberDataSourceConfig};

// ---------------------------------------------------------------------------
// Connection resolution
// ---------------------------------------------------------------------------

/// Result of attempting to resolve a connection for a data source.
#[derive(Debug, Clone)]
pub enum ConnectionResolution {
    /// Successfully resolved to a connection string (from saved config or SSPI).
    Resolved { connection_string: String },
    /// Need subscriber input (saved config absent, SSPI not available).
    NeedsConfiguration {
        data_source_id: String,
        server: String,
        database: String,
        connection_type: String,
    },
}

/// Build the SSPI connection string from package-level server/database hints.
pub fn build_sspi_connection_string(server: &str, database: &str) -> String {
    format!(
        "host={} dbname={} sslmode=prefer",
        server, database,
    )
}

/// Attempt to resolve a connection for a single data source.
///
/// Resolution order:
/// 1. Check saved subscriber config (from .cala)
/// 2. Return NeedsConfiguration (caller must try SSPI or prompt)
///
/// Note: Actual SSPI connection testing is done at the Tauri layer (requires
/// async engine setup), so this function only checks saved configs. The Tauri
/// command handles the SSPI-then-prompt fallback logic.
pub fn resolve_connection(
    data_source: &PackageDataSource,
    saved_configs: &[SubscriberDataSourceConfig],
) -> ConnectionResolution {
    // Check for saved subscriber config
    if let Some(config) = saved_configs.iter().find(|c| c.data_source_id == data_source.id) {
        if !config.connection_string.is_empty() {
            return ConnectionResolution::Resolved {
                connection_string: config.connection_string.clone(),
            };
        }
    }

    // No saved config — caller must try SSPI or prompt
    ConnectionResolution::NeedsConfiguration {
        data_source_id: data_source.id.clone(),
        server: data_source.server.clone(),
        database: data_source.database.clone(),
        connection_type: data_source.connection_type.clone(),
    }
}

// ---------------------------------------------------------------------------
// Data refresh result
// ---------------------------------------------------------------------------

/// Result of a data refresh operation.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DataRefreshResult {
    /// Number of data sources refreshed.
    pub sources_refreshed: usize,
    /// Number of queries executed.
    pub queries_executed: usize,
    /// Number of cells updated.
    pub cells_updated: usize,
    /// Data sources that need manual configuration (SSPI failed).
    pub needs_configuration: Vec<DataSourceConnectionNeeded>,
}

/// A data source that could not be auto-connected.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DataSourceConnectionNeeded {
    pub data_source_id: String,
    pub name: String,
    pub server: String,
    pub database: String,
    pub connection_type: String,
}

/// Read the embedded DataModel JSON from the registry.
pub fn read_model_json(model_path: &std::path::Path) -> Result<serde_json::Value, crate::CalpError> {
    let json_str = std::fs::read_to_string(model_path)?;
    let value: serde_json::Value = serde_json::from_str(&json_str)?;
    Ok(value)
}
