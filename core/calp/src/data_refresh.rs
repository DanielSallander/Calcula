//! FILENAME: core/calp/src/data_refresh.rs
//! PURPOSE: Connection helpers for live .calp packages.
//! CONTEXT: When a subscriber refreshes data sources, the Tauri layer
//! resolves database connections (saved config -> SSPI -> prompt fallback)
//! and verifies them against the embedded BI model. BI data reaches the grid
//! through pivots (and CUBE formulas, planned) — the former query-region
//! re-execution path was decommissioned.

// ---------------------------------------------------------------------------
// Connection helpers
// ---------------------------------------------------------------------------

/// Build the SSPI connection string from package-level server/database hints.
pub fn build_sspi_connection_string(server: &str, database: &str) -> String {
    format!(
        "host={} dbname={} sslmode=prefer",
        server, database,
    )
}

/// Read the embedded DataModel JSON from the registry.
pub fn read_model_json(model_path: &std::path::Path) -> Result<serde_json::Value, crate::CalpError> {
    let json_str = std::fs::read_to_string(model_path)?;
    let value: serde_json::Value = serde_json::from_str(&json_str)?;
    Ok(value)
}
