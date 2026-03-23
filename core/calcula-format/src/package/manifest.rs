//! FILENAME: core/calcula-format/src/package/manifest.rs
//! Package manifest (package.json) — metadata and data source declarations for `.calp` files.

use serde::{Deserialize, Serialize};

/// Root descriptor for a `.calp` package file.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackageManifest {
    /// Unique package identifier, e.g. "com.acme.sales-dashboard".
    pub id: String,
    /// Human-readable package name.
    pub name: String,
    /// Semantic version string, e.g. "1.2.0".
    pub version: String,
    /// Short description of the package.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub description: String,
    /// Author name or identifier.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub author: String,
    /// Searchable tags for discovery.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub tags: Vec<String>,

    /// What objects are included in the package.
    pub contents: Vec<PackageContent>,
    /// Abstract data dependencies that must be bound at import time.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub data_sources: Vec<DataSourceDeclaration>,

    /// Minimum Calcula version required to use this package.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub min_calc_version: Option<String>,
    /// Extensions that must be present for this package to work.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub required_extensions: Vec<String>,
}

/// Describes one object included in the package.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackageContent {
    /// The type of object.
    #[serde(rename = "type")]
    pub content_type: PackageContentType,
    /// Path within the ZIP archive, e.g. "sheets/0_Dashboard" or "tables/table_1.json".
    pub path: String,
    /// Human-readable name for display.
    pub name: String,
    /// Optional description of this object.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
}

/// The type of a packaged object.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PackageContentType {
    Sheet,
    Table,
    Chart,
    Pivot,
    File,
}

/// Declares an abstract data dependency that the package needs.
/// At import time, the user maps each declaration to a local data source.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DataSourceDeclaration {
    /// Logical identifier for this data source within the package.
    pub id: String,
    /// Human-readable name shown in the binding dialog.
    pub name: String,
    /// Description of what data this source should provide.
    #[serde(default, skip_serializing_if = "String::is_empty")]
    pub description: String,
    /// What kind of data source this maps to.
    #[serde(rename = "type")]
    pub source_type: DataSourceType,
    /// Expected column schema (for validation and auto-matching).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub columns: Vec<DataSourceColumn>,
    /// How the package references this source internally.
    /// E.g. "SalesTable", "Sheet1!A1:G100", "bi:SalesConnection".
    pub internal_ref: String,
}

/// The kind of local data source a declaration can bind to.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum DataSourceType {
    /// A cell range (e.g. Sheet1!A1:G100).
    Range,
    /// A named table.
    Table,
    /// A BI engine connection.
    BiConnection,
}

/// Describes an expected column in a data source.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DataSourceColumn {
    /// Column name for auto-matching.
    pub name: String,
    /// Expected data type.
    #[serde(rename = "type")]
    pub column_type: ColumnType,
    /// Whether this column is required for the package to function.
    #[serde(default)]
    pub required: bool,
}

/// Data types for column schema declarations.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ColumnType {
    Text,
    Number,
    Date,
    Boolean,
}

/// Tracks the origin of imported objects within a workbook.
/// Stored as `_meta/provenance.json` inside the `.cala` archive.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PackageProvenance {
    /// Package ID from which objects were imported.
    pub package_id: String,
    /// Version of the package that was imported.
    pub package_version: String,
    /// ISO 8601 timestamp of when the import occurred.
    pub imported_at: String,
    /// Which objects were imported and their local identifiers.
    pub entries: Vec<ProvenanceEntry>,
}

/// Maps a package content item to its local identity after import.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProvenanceEntry {
    /// Type of the imported object.
    #[serde(rename = "type")]
    pub content_type: PackageContentType,
    /// Original name in the package.
    pub package_name: String,
    /// Local name in the workbook (may differ if renamed due to conflicts).
    pub local_name: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_package_manifest_roundtrip() {
        let manifest = PackageManifest {
            id: "com.example.sales-dashboard".to_string(),
            name: "Sales Dashboard".to_string(),
            version: "1.0.0".to_string(),
            description: "Monthly sales overview with charts".to_string(),
            author: "Jane Doe".to_string(),
            tags: vec!["sales".to_string(), "dashboard".to_string()],
            contents: vec![
                PackageContent {
                    content_type: PackageContentType::Sheet,
                    path: "sheets/0_Dashboard".to_string(),
                    name: "Dashboard".to_string(),
                    description: Some("Main dashboard sheet".to_string()),
                },
                PackageContent {
                    content_type: PackageContentType::Table,
                    path: "tables/table_1.json".to_string(),
                    name: "SalesTable".to_string(),
                    description: None,
                },
            ],
            data_sources: vec![DataSourceDeclaration {
                id: "sales_data".to_string(),
                name: "Sales Data".to_string(),
                description: "Raw sales transaction data".to_string(),
                source_type: DataSourceType::Table,
                columns: vec![
                    DataSourceColumn {
                        name: "Date".to_string(),
                        column_type: ColumnType::Date,
                        required: true,
                    },
                    DataSourceColumn {
                        name: "Revenue".to_string(),
                        column_type: ColumnType::Number,
                        required: true,
                    },
                    DataSourceColumn {
                        name: "Region".to_string(),
                        column_type: ColumnType::Text,
                        required: false,
                    },
                ],
                internal_ref: "SalesTable".to_string(),
            }],
            min_calc_version: Some("0.1.0".to_string()),
            required_extensions: vec!["Charts".to_string()],
        };

        let json = serde_json::to_string_pretty(&manifest).unwrap();
        let parsed: PackageManifest = serde_json::from_str(&json).unwrap();

        assert_eq!(parsed.id, "com.example.sales-dashboard");
        assert_eq!(parsed.version, "1.0.0");
        assert_eq!(parsed.contents.len(), 2);
        assert_eq!(parsed.contents[0].content_type, PackageContentType::Sheet);
        assert_eq!(parsed.data_sources.len(), 1);
        assert_eq!(parsed.data_sources[0].columns.len(), 3);
        assert_eq!(parsed.data_sources[0].source_type, DataSourceType::Table);
        assert_eq!(parsed.required_extensions, vec!["Charts"]);
    }

    #[test]
    fn test_minimal_manifest() {
        let manifest = PackageManifest {
            id: "com.example.simple".to_string(),
            name: "Simple Sheet".to_string(),
            version: "0.1.0".to_string(),
            description: String::new(),
            author: String::new(),
            tags: vec![],
            contents: vec![PackageContent {
                content_type: PackageContentType::Sheet,
                path: "sheets/0_Data".to_string(),
                name: "Data".to_string(),
                description: None,
            }],
            data_sources: vec![],
            min_calc_version: None,
            required_extensions: vec![],
        };

        let json = serde_json::to_string_pretty(&manifest).unwrap();
        // Verify optional fields are omitted
        assert!(!json.contains("description"));
        assert!(!json.contains("author"));
        assert!(!json.contains("tags"));
        assert!(!json.contains("dataSources"));
        assert!(!json.contains("minCalcVersion"));
        assert!(!json.contains("requiredExtensions"));

        // Roundtrip still works
        let parsed: PackageManifest = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.id, "com.example.simple");
        assert_eq!(parsed.contents.len(), 1);
    }

    #[test]
    fn test_provenance_roundtrip() {
        let provenance = PackageProvenance {
            package_id: "com.example.sales-dashboard".to_string(),
            package_version: "1.0.0".to_string(),
            imported_at: "2026-03-21T10:00:00Z".to_string(),
            entries: vec![
                ProvenanceEntry {
                    content_type: PackageContentType::Sheet,
                    package_name: "Dashboard".to_string(),
                    local_name: "Dashboard".to_string(),
                },
                ProvenanceEntry {
                    content_type: PackageContentType::Table,
                    package_name: "SalesTable".to_string(),
                    local_name: "SalesTable (2)".to_string(),
                },
            ],
        };

        let json = serde_json::to_string_pretty(&provenance).unwrap();
        let parsed: PackageProvenance = serde_json::from_str(&json).unwrap();

        assert_eq!(parsed.package_id, "com.example.sales-dashboard");
        assert_eq!(parsed.entries.len(), 2);
        assert_eq!(parsed.entries[1].local_name, "SalesTable (2)");
    }

    #[test]
    fn test_data_source_types_serialize() {
        // Verify kebab-case serialization
        let json = serde_json::to_string(&DataSourceType::BiConnection).unwrap();
        assert_eq!(json, "\"bi-connection\"");

        let json = serde_json::to_string(&DataSourceType::Range).unwrap();
        assert_eq!(json, "\"range\"");

        let json = serde_json::to_string(&DataSourceType::Table).unwrap();
        assert_eq!(json, "\"table\"");
    }
}
