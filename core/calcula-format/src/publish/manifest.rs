//! FILENAME: core/calcula-format/src/publish/manifest.rs
//! Publish manifest — describes what sheets are published to a shared directory.

use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Root manifest for a publication directory (publish-manifest.json).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishManifest {
    /// Format version (currently 1).
    pub format_version: u32,
    /// Human-readable name for this publication (e.g., "Sales Reports").
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub name: String,
    /// ISO 8601 timestamp of the most recent publish action.
    pub published_at: String,
    /// Author who last published.
    pub published_by: String,
    /// All published sheets.
    pub sheets: Vec<PublishedSheet>,
    /// BI connections used by published sheets (auto-extracted on publish).
    /// Connection strings are parameterized with `${PARAM}` placeholders.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub connections: Vec<PublishedConnection>,
    /// Connection parameters extracted from connection strings.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub parameters: Vec<ConnectionParameter>,
    /// Named environment profiles with pre-filled parameter values.
    /// Key is the environment name (e.g., "DEV", "TEST", "PROD").
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pub environments: HashMap<String, HashMap<String, String>>,
}

/// A single published sheet entry in the manifest.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishedSheet {
    /// Stable identifier that survives renames and version bumps.
    pub id: String,
    /// Display name of the sheet.
    pub name: String,
    /// Folder name inside sheets/ (e.g., "0_Dashboard").
    pub folder: String,
    /// Human-readable description.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub description: String,
    /// ISO 8601 timestamp when this sheet was last published.
    pub published_at: String,
    /// Monotonically increasing version number.
    pub version: u64,
    /// Hash digest of data.json content (for change detection).
    pub checksum: String,
}

/// A BI connection published alongside sheets.
/// The connection string is parameterized — actual values come from environments.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishedConnection {
    /// Connection name (e.g., "Sales Database").
    pub name: String,
    /// Connection type (e.g., "PostgreSQL").
    pub connection_type: String,
    /// Parameterized connection string (e.g., "postgresql://${DB_USER}:${DB_PASS}@${DB_HOST}:${DB_PORT}/${DB_NAME}").
    pub connection_string_template: String,
    /// Path to the BI model file, if any. May contain parameters.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model_path: Option<String>,
}

/// A parameter extracted from a connection string.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionParameter {
    /// Parameter name (e.g., "DB_HOST").
    pub name: String,
    /// Human-readable description.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub description: String,
    /// Whether this is a sensitive value (password, token).
    #[serde(default)]
    pub secret: bool,
}

impl PublishManifest {
    /// Create a new empty manifest.
    pub fn new(published_by: String, now: String) -> Self {
        PublishManifest {
            format_version: 1,
            name: String::new(),
            published_at: now,
            published_by,
            sheets: Vec::new(),
            connections: Vec::new(),
            parameters: Vec::new(),
            environments: HashMap::new(),
        }
    }

    /// Find a published sheet by its stable ID.
    pub fn find_sheet(&self, id: &str) -> Option<&PublishedSheet> {
        self.sheets.iter().find(|s| s.id == id)
    }

    /// Find a published sheet by its stable ID (mutable).
    pub fn find_sheet_mut(&mut self, id: &str) -> Option<&mut PublishedSheet> {
        self.sheets.iter_mut().find(|s| s.id == id)
    }

    /// Resolve a parameterized connection string using the given environment.
    /// Replaces all `${PARAM}` placeholders with values from the environment map.
    pub fn resolve_connection_string(
        template: &str,
        env_values: &HashMap<String, String>,
    ) -> String {
        let mut result = template.to_string();
        for (key, value) in env_values {
            let placeholder = format!("${{{}}}", key);
            result = result.replace(&placeholder, value);
        }
        result
    }
}

/// Parse a PostgreSQL connection string into named parameters.
/// Returns a list of (parameter_name, value, is_secret) tuples.
///
/// Input:  `postgresql://user:pass@host:5432/dbname`
/// Output: `[("DB_USER","user",false), ("DB_PASS","pass",true), ("DB_HOST","host",false), ("DB_PORT","5432",false), ("DB_NAME","dbname",false)]`
pub fn parse_connection_params(conn_str: &str) -> Vec<(String, String, bool)> {
    let mut params = Vec::new();

    // Strip the scheme prefix
    let rest = if let Some(stripped) = conn_str.strip_prefix("postgresql://") {
        stripped
    } else if let Some(stripped) = conn_str.strip_prefix("postgres://") {
        stripped
    } else {
        // Unknown scheme — return the whole thing as a single param
        params.push(("CONNECTION_STRING".to_string(), conn_str.to_string(), false));
        return params;
    };

    // Split into credentials@host/database parts
    // Format: user:pass@host:port/dbname
    if let Some((credentials, host_and_db)) = rest.split_once('@') {
        // Parse user:pass
        if let Some((user, pass)) = credentials.split_once(':') {
            params.push(("DB_USER".to_string(), user.to_string(), false));
            params.push(("DB_PASS".to_string(), pass.to_string(), true));
        } else {
            params.push(("DB_USER".to_string(), credentials.to_string(), false));
        }

        // Parse host:port/dbname
        if let Some((host_port, dbname)) = host_and_db.split_once('/') {
            if let Some((host, port)) = host_port.split_once(':') {
                params.push(("DB_HOST".to_string(), host.to_string(), false));
                params.push(("DB_PORT".to_string(), port.to_string(), false));
            } else {
                params.push(("DB_HOST".to_string(), host_port.to_string(), false));
            }
            // Database name might have query params
            let db = dbname.split('?').next().unwrap_or(dbname);
            params.push(("DB_NAME".to_string(), db.to_string(), false));
        } else {
            // No database in URL
            if let Some((host, port)) = host_and_db.split_once(':') {
                params.push(("DB_HOST".to_string(), host.to_string(), false));
                params.push(("DB_PORT".to_string(), port.to_string(), false));
            } else {
                params.push(("DB_HOST".to_string(), host_and_db.to_string(), false));
            }
        }
    } else {
        // No @ sign — just host/db
        if let Some((host_port, dbname)) = rest.split_once('/') {
            if let Some((host, port)) = host_port.split_once(':') {
                params.push(("DB_HOST".to_string(), host.to_string(), false));
                params.push(("DB_PORT".to_string(), port.to_string(), false));
            } else {
                params.push(("DB_HOST".to_string(), host_port.to_string(), false));
            }
            let db = dbname.split('?').next().unwrap_or(dbname);
            params.push(("DB_NAME".to_string(), db.to_string(), false));
        }
    }

    params
}

/// Build a parameterized connection string template from the original and extracted params.
/// Replaces each extracted value with its `${PARAM}` placeholder.
pub fn build_connection_template(conn_str: &str, params: &[(String, String, bool)]) -> String {
    let mut template = conn_str.to_string();
    // Replace longest values first to avoid partial replacements
    let mut sorted_params: Vec<_> = params.iter().collect();
    sorted_params.sort_by(|a, b| b.1.len().cmp(&a.1.len()));

    for (name, value, _) in sorted_params {
        if !value.is_empty() {
            let placeholder = format!("${{{}}}", name);
            template = template.replace(value.as_str(), &placeholder);
        }
    }
    template
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_manifest_roundtrip() {
        let mut envs = HashMap::new();
        envs.insert(
            "DEV".to_string(),
            [
                ("DB_HOST".to_string(), "devserver".to_string()),
                ("DB_NAME".to_string(), "SalesDB_Dev".to_string()),
            ]
            .into_iter()
            .collect(),
        );

        let manifest = PublishManifest {
            format_version: 1,
            name: "Sales Reports".to_string(),
            published_at: "2026-04-09T12:00:00Z".to_string(),
            published_by: "jane.doe".to_string(),
            sheets: vec![PublishedSheet {
                id: "sales-dashboard".to_string(),
                name: "Sales Dashboard".to_string(),
                folder: "0_SalesDashboard".to_string(),
                description: "Monthly revenue breakdown".to_string(),
                published_at: "2026-04-09T12:00:00Z".to_string(),
                version: 1,
                checksum: "hash:abc123".to_string(),
            }],
            connections: vec![PublishedConnection {
                name: "Sales DB".to_string(),
                connection_type: "PostgreSQL".to_string(),
                connection_string_template:
                    "postgresql://${DB_USER}:${DB_PASS}@${DB_HOST}:5432/${DB_NAME}".to_string(),
                model_path: None,
            }],
            parameters: vec![
                ConnectionParameter {
                    name: "DB_HOST".to_string(),
                    description: "Database server".to_string(),
                    secret: false,
                },
                ConnectionParameter {
                    name: "DB_PASS".to_string(),
                    description: "Database password".to_string(),
                    secret: true,
                },
            ],
            environments: envs,
        };

        let json = serde_json::to_string_pretty(&manifest).unwrap();
        let parsed: PublishManifest = serde_json::from_str(&json).unwrap();

        assert_eq!(parsed.format_version, 1);
        assert_eq!(parsed.name, "Sales Reports");
        assert_eq!(parsed.sheets.len(), 1);
        assert_eq!(parsed.connections.len(), 1);
        assert_eq!(parsed.parameters.len(), 2);
        assert!(parsed.parameters[1].secret);
        assert_eq!(parsed.environments.len(), 1);
        assert_eq!(
            parsed.environments["DEV"]["DB_HOST"],
            "devserver"
        );
    }

    #[test]
    fn test_parse_connection_params() {
        let params =
            parse_connection_params("postgresql://analyst:secret@devserver:5432/SalesDB");

        assert_eq!(params.len(), 5);
        assert_eq!(params[0], ("DB_USER".to_string(), "analyst".to_string(), false));
        assert_eq!(params[1], ("DB_PASS".to_string(), "secret".to_string(), true));
        assert_eq!(params[2], ("DB_HOST".to_string(), "devserver".to_string(), false));
        assert_eq!(params[3], ("DB_PORT".to_string(), "5432".to_string(), false));
        assert_eq!(params[4], ("DB_NAME".to_string(), "SalesDB".to_string(), false));
    }

    #[test]
    fn test_parse_connection_params_no_port() {
        let params = parse_connection_params("postgresql://user:pass@myhost/mydb");
        assert_eq!(params.len(), 4);
        assert_eq!(params[2], ("DB_HOST".to_string(), "myhost".to_string(), false));
        assert_eq!(params[3], ("DB_NAME".to_string(), "mydb".to_string(), false));
    }

    #[test]
    fn test_parse_connection_params_unknown_scheme() {
        let params = parse_connection_params("mysql://host/db");
        assert_eq!(params.len(), 1);
        assert_eq!(params[0].0, "CONNECTION_STRING");
    }

    #[test]
    fn test_build_connection_template() {
        let params = vec![
            ("DB_USER".to_string(), "analyst".to_string(), false),
            ("DB_PASS".to_string(), "secret".to_string(), true),
            ("DB_HOST".to_string(), "devserver".to_string(), false),
            ("DB_PORT".to_string(), "5432".to_string(), false),
            ("DB_NAME".to_string(), "SalesDB".to_string(), false),
        ];

        let template = build_connection_template(
            "postgresql://analyst:secret@devserver:5432/SalesDB",
            &params,
        );

        assert_eq!(
            template,
            "postgresql://${DB_USER}:${DB_PASS}@${DB_HOST}:${DB_PORT}/${DB_NAME}"
        );
    }

    #[test]
    fn test_resolve_connection_string() {
        let env: HashMap<String, String> = [
            ("DB_USER".to_string(), "testuser".to_string()),
            ("DB_PASS".to_string(), "testpass".to_string()),
            ("DB_HOST".to_string(), "testserver".to_string()),
            ("DB_PORT".to_string(), "5432".to_string()),
            ("DB_NAME".to_string(), "SalesDB_Test".to_string()),
        ]
        .into_iter()
        .collect();

        let resolved = PublishManifest::resolve_connection_string(
            "postgresql://${DB_USER}:${DB_PASS}@${DB_HOST}:${DB_PORT}/${DB_NAME}",
            &env,
        );

        assert_eq!(
            resolved,
            "postgresql://testuser:testpass@testserver:5432/SalesDB_Test"
        );
    }

    #[test]
    fn test_find_sheet() {
        let manifest = PublishManifest {
            format_version: 1,
            name: String::new(),
            published_at: "2026-01-01T00:00:00Z".to_string(),
            published_by: "test".to_string(),
            sheets: vec![
                PublishedSheet {
                    id: "sheet-a".to_string(),
                    name: "Sheet A".to_string(),
                    folder: "0_SheetA".to_string(),
                    description: String::new(),
                    published_at: "2026-01-01T00:00:00Z".to_string(),
                    version: 1,
                    checksum: "abc".to_string(),
                },
                PublishedSheet {
                    id: "sheet-b".to_string(),
                    name: "Sheet B".to_string(),
                    folder: "1_SheetB".to_string(),
                    description: String::new(),
                    published_at: "2026-01-01T00:00:00Z".to_string(),
                    version: 2,
                    checksum: "def".to_string(),
                },
            ],
            connections: Vec::new(),
            parameters: Vec::new(),
            environments: HashMap::new(),
        };

        assert!(manifest.find_sheet("sheet-a").is_some());
        assert!(manifest.find_sheet("sheet-b").is_some());
        assert!(manifest.find_sheet("nonexistent").is_none());
    }

    #[test]
    fn test_empty_connections_omitted_from_json() {
        let manifest = PublishManifest::new("test".to_string(), "2026-01-01T00:00:00Z".to_string());
        let json = serde_json::to_string(&manifest).unwrap();
        assert!(!json.contains("connections"));
        assert!(!json.contains("parameters"));
        assert!(!json.contains("environments"));
    }
}
