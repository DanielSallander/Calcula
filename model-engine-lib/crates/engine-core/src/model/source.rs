//! Persisted, source-agnostic descriptors for a model's data sources.
//!
//! These types let a multi-source model record **which source each table comes
//! from** so it can be saved and reopened without the host re-wiring every table
//! at load time. They are deliberately **neutral** — plain strings and enums —
//! because `engine-core` must not depend on `engine-query` or `engine-connectors`
//! (see `CLAUDE.md`, architecture constraint #2). The engine facade translates
//! these descriptors into live `ConnectionTarget` / `AnyConnector` values when it
//! reconnects the sources (`Engine::wire_sources`).
//!
//! # No secrets
//!
//! Like [`crate::model`] as a whole, these types are serialized into model files,
//! which are shared between users. They therefore carry **no credentials** — only
//! a secret-free connection target and a hint about which auth method the author
//! used. The host re-supplies the actual secret at load time.

use serde::{Deserialize, Serialize};

/// Kind of data source backing a model table.
///
/// The variant names mirror `engine-query`'s `AnyConnector` variants 1:1 so the
/// facade can map between them mechanically (a drift is a compile error at the
/// mapping site).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SourceKind {
    /// PostgreSQL database.
    Postgres,
    /// Microsoft SQL Server database.
    SqlServer,
    /// In-process source serving host-supplied Arrow batches. Its data lives in
    /// the host, so it cannot be reconstructed from persisted descriptors alone.
    InMemory,
    /// Directory of CSV files.
    Csv,
    /// Directory of Apache Parquet files.
    Parquet,
}

/// Secret-free hint for which authentication method a source's author used.
///
/// A neutral mirror of `engine-connectors`' `AuthMethodKind` (which `engine-core`
/// cannot reference). This is a **hint only** — never a secret. The host resolves
/// the concrete auth (and any credentials) at load time.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PersistedAuthKind {
    /// Integrated / Windows / Kerberos authentication (no stored credentials).
    Integrated,
    /// Explicit username and password (supplied by the host at load time).
    UsernamePassword,
    /// Environment-variable credential lookup (only variable names are known here).
    EnvironmentVariable,
}

/// Secret-free connection parameters for a persisted source.
///
/// A neutral mirror of the secret-free half of `engine-connectors`'
/// `ConnectionTarget`. For `Csv`/`Parquet` sources, `database` holds the
/// directory path and `default_schema` the cosmetic schema name. For `InMemory`
/// sources every field is empty/`None`.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize)]
pub struct PersistedConnection {
    /// Hostname or IP address (empty for file-based / in-memory sources).
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub host: String,
    /// Port number; the facade applies each connector's default when `None`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub port: Option<u16>,
    /// Database name, or the directory path for file-based sources.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub database: String,
    /// Default schema (e.g. `"public"`, `"dbo"`); the facade applies its own
    /// default when `None`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub default_schema: Option<String>,
    /// Whether to trust the server's TLS certificate without validation.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub trust_server_certificate: bool,
    /// Explicit TLS/SSL mode: `"disable"` | `"prefer"` | `"require"` (or `None`
    /// for the connector default). Lets a model reconnect to a server with no
    /// TLS support. Secret-free.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ssl_mode: Option<String>,
}

/// One persisted data source: a stable id, its kind, where it connects
/// (secret-free), and the auth method the author used (a hint).
///
/// Referenced by [`TableSourceBinding::source_id`]. Carries **no secrets**.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PersistedSource {
    /// Stable identifier referenced by a table's [`TableSourceBinding`].
    pub id: String,
    /// The kind of connector that serves this source.
    pub kind: SourceKind,
    /// Secret-free connection parameters. Empty/default for `InMemory`.
    #[serde(default)]
    pub connection: PersistedConnection,
    /// The auth method the model author used — a hint the host tries first.
    pub preferred_auth: PersistedAuthKind,
    /// Optional human-friendly name shown by host applications.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
}

impl PersistedSource {
    /// Create a persisted source with the minimum required fields.
    pub fn new(
        id: impl Into<String>,
        kind: SourceKind,
        connection: PersistedConnection,
        preferred_auth: PersistedAuthKind,
    ) -> Self {
        Self {
            id: id.into(),
            kind,
            connection,
            preferred_auth,
            display_name: None,
        }
    }

    /// Set the human-friendly display name.
    pub fn with_display_name(mut self, display_name: impl Into<String>) -> Self {
        self.display_name = Some(display_name.into());
        self
    }
}

/// Persisted mapping of a model table to a location within a data source.
///
/// Neutral strings only — no connector index (that is assigned at wire time).
/// Mirrors `engine-query`'s runtime `SourceBinding` plus the owning source id.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TableSourceBinding {
    /// The [`PersistedSource::id`] this table's data comes from.
    pub source_id: String,
    /// Source schema name (e.g. `"sales"`, `"BI"`).
    pub schema: String,
    /// Source table name (e.g. `"salesorderheader"`).
    pub table: String,
}

impl TableSourceBinding {
    /// Create a new persisted table-source binding.
    pub fn new(
        source_id: impl Into<String>,
        schema: impl Into<String>,
        table: impl Into<String>,
    ) -> Self {
        Self {
            source_id: source_id.into(),
            schema: schema.into(),
            table: table.into(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn source_kind_serde_round_trip() {
        for kind in [
            SourceKind::Postgres,
            SourceKind::SqlServer,
            SourceKind::InMemory,
            SourceKind::Csv,
            SourceKind::Parquet,
        ] {
            let json = serde_json::to_string(&kind).unwrap();
            let restored: SourceKind = serde_json::from_str(&json).unwrap();
            assert_eq!(kind, restored);
        }
    }

    #[test]
    fn persisted_auth_kind_serde_round_trip() {
        for kind in [
            PersistedAuthKind::Integrated,
            PersistedAuthKind::UsernamePassword,
            PersistedAuthKind::EnvironmentVariable,
        ] {
            let json = serde_json::to_string(&kind).unwrap();
            let restored: PersistedAuthKind = serde_json::from_str(&json).unwrap();
            assert_eq!(kind, restored);
        }
    }

    #[test]
    fn persisted_connection_omits_empty_fields() {
        let conn = PersistedConnection::default();
        let json = serde_json::to_string(&conn).unwrap();
        // A default (in-memory) connection serializes to an empty object.
        assert_eq!(json, "{}");
    }

    #[test]
    fn persisted_source_serde_round_trip() {
        let source = PersistedSource::new(
            "sales_pg",
            SourceKind::Postgres,
            PersistedConnection {
                host: "db01".into(),
                port: Some(5432),
                database: "warehouse".into(),
                default_schema: Some("sales".into()),
                trust_server_certificate: false,
                ssl_mode: Some("disable".into()),
            },
            PersistedAuthKind::UsernamePassword,
        )
        .with_display_name("Sales (Postgres)");

        let json = serde_json::to_string_pretty(&source).unwrap();
        let restored: PersistedSource = serde_json::from_str(&json).unwrap();
        assert_eq!(source, restored);
    }

    #[test]
    fn persisted_source_stores_no_secrets() {
        // Even a username/password source records only the auth *kind* — the
        // struct has no field that could hold a credential value. Verify
        // structurally: the serialized object exposes only the known keys, and
        // its `connection` sub-object carries no credential fields. (The
        // `preferred_auth` *value* is legitimately `"username_password"`, so a
        // naive substring check for "password" would be a false positive.)
        let source = PersistedSource::new(
            "s",
            SourceKind::Postgres,
            PersistedConnection {
                host: "db01".into(),
                database: "warehouse".into(),
                ..Default::default()
            },
            PersistedAuthKind::UsernamePassword,
        );
        let value: serde_json::Value = serde_json::to_value(&source).unwrap();
        let obj = value.as_object().unwrap();
        // Only these keys may appear on a persisted source.
        for key in obj.keys() {
            assert!(
                matches!(
                    key.as_str(),
                    "id" | "kind" | "connection" | "preferred_auth" | "display_name"
                ),
                "unexpected persisted-source key '{key}'"
            );
        }
        // The connection carries the secret-free target only — no credentials.
        let conn = obj["connection"].as_object().unwrap();
        for key in conn.keys() {
            assert!(
                !matches!(key.as_str(), "username" | "password" | "secret" | "token"),
                "connection must not carry credential key '{key}'"
            );
        }
        assert_eq!(
            obj["preferred_auth"],
            serde_json::json!("username_password")
        );
    }

    #[test]
    fn table_source_binding_serde_round_trip() {
        let binding = TableSourceBinding::new("sales_pg", "sales", "salesorderheader");
        let json = serde_json::to_string(&binding).unwrap();
        let restored: TableSourceBinding = serde_json::from_str(&json).unwrap();
        assert_eq!(binding, restored);
    }
}
