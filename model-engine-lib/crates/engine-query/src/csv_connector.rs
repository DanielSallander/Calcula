//! File-backed connector serving CSV files as source tables.
//!
//! [`CsvConnector`] reads CSV files from a directory — one file per source
//! table (`<dir>/<table>.csv`) — and serves them through the same
//! [`Connector`] seam as a real database. It lets a host (the spreadsheet
//! especially) load flat-file data with zero database setup, and gives the test
//! suite a real file-backed source.
//!
//! Reading and schema inference use DataFusion's CSV support (already a
//! dependency); the request's restriction contract — scalar `filters`,
//! `in_filters`, and `or_groups` — is applied with the same safe-quoting filter
//! path as the in-memory connector (honoring all three is mandatory: the planner
//! pushes user IN/OR slicers **and** the propagated row-level-security /
//! relationship IN-filters here). The engine performs aggregation, joins, and
//! ordering locally.
//!
//! # Authentication
//!
//! CSV files are local, so the only meaningful auth is the running process's own
//! file-system access — modeled as [`AuthMethod::Integrated`]. Credential-based
//! methods return [`ConnectorError::AuthMethodNotSupported`].

use std::path::{Path, PathBuf};

use arrow::record_batch::RecordBatch;
use datafusion::prelude::{CsvReadOptions, SessionContext};
use engine_connectors::auth::{AuthMethod, AuthMethodKind, ConnectionTarget, ConnectorAuth};
use engine_connectors::traits::{Connector, FetchRequest, SourceTable};
use engine_connectors::{ConnectorError, ConnectorResult};
use engine_core::model::{Column, Table};
use engine_core::types::DataType;

use crate::in_memory_connector::apply_filters;

/// A connector that serves CSV files from a directory as source tables.
///
/// Each table `t` is the file `<directory>/<t>.csv` (header row required). The
/// schema is inferred from the file. See the [module docs](self).
#[derive(Debug, Clone)]
pub struct CsvConnector {
    directory: PathBuf,
    schema: String,
}

impl CsvConnector {
    /// Create a CSV connector over `directory`, serving tables under the source
    /// schema name `schema` (cosmetic — used in [`SourceTable`] listings; the
    /// file path ignores it).
    pub fn new(directory: impl Into<PathBuf>, schema: impl Into<String>) -> Self {
        Self {
            directory: directory.into(),
            schema: schema.into(),
        }
    }

    /// Build a CSV connector from a [`ConnectionTarget`] + [`AuthMethod`]
    /// (the auth checklist constructor).
    ///
    /// The target's `database` field is the **directory** holding the CSV
    /// files; `default_schema` (default `"public"`) is the cosmetic source
    /// schema. Only [`AuthMethod::Integrated`] (local file access via the
    /// process identity) is accepted; credential methods return
    /// [`ConnectorError::AuthMethodNotSupported`].
    pub fn from_target(target: ConnectionTarget, auth: AuthMethod) -> ConnectorResult<Self> {
        match auth {
            AuthMethod::Integrated => {}
            AuthMethod::UsernamePassword { .. } => {
                return Err(ConnectorError::AuthMethodNotSupported(
                    "CSV connector: username/password authentication is not applicable to local \
                     files; use AuthMethod::Integrated (the process's file-system access)"
                        .into(),
                ));
            }
            AuthMethod::EnvironmentVariable { .. } => {
                return Err(ConnectorError::AuthMethodNotSupported(
                    "CSV connector: environment-variable credentials are not applicable to local \
                     files; use AuthMethod::Integrated"
                        .into(),
                ));
            }
            // `AuthMethod` is `#[non_exhaustive]`: any future credential method
            // is likewise not applicable to local files.
            _ => {
                return Err(ConnectorError::AuthMethodNotSupported(
                    "CSV connector: only AuthMethod::Integrated (local file access) is supported"
                        .into(),
                ));
            }
        }
        let directory = PathBuf::from(&target.database);
        if !directory.is_dir() {
            return Err(ConnectorError::ConnectionFailed(format!(
                "CSV connector: '{}' is not a directory",
                directory.display()
            )));
        }
        let schema = target
            .default_schema
            .clone()
            .unwrap_or_else(|| "public".to_string());
        Ok(Self { directory, schema })
    }

    /// Resolve a table name to its `<dir>/<table>.csv` path, rejecting any name
    /// that is not a single safe filename (path separators or `..` could escape
    /// the configured directory).
    fn file_path(&self, table: &str) -> ConnectorResult<PathBuf> {
        let invalid = table.is_empty()
            || table.contains('/')
            || table.contains('\\')
            || table.contains("..")
            || Path::new(table).components().count() != 1;
        if invalid {
            return Err(ConnectorError::QueryFailed(format!(
                "CSV connector: '{table}' is not a valid table name (must be a plain file stem)"
            )));
        }
        let path = self.directory.join(format!("{table}.csv"));
        if !path.is_file() {
            return Err(ConnectorError::QueryFailed(format!(
                "CSV connector: no file '{}'",
                path.display()
            )));
        }
        Ok(path)
    }

    /// Read a CSV file into a single concatenated [`RecordBatch`] (header +
    /// inferred schema) via DataFusion.
    async fn read_table(&self, table: &str) -> ConnectorResult<RecordBatch> {
        let path = self.file_path(table)?;
        let path_str = path.to_string_lossy().to_string();
        let ctx = SessionContext::new();
        let df = ctx
            .read_csv(path_str, CsvReadOptions::new())
            .await
            .map_err(|e| ConnectorError::QueryFailed(format!("CSV read '{table}': {e}")))?;
        let schema = df.schema().inner().clone();
        let batches = df
            .collect()
            .await
            .map_err(|e| ConnectorError::QueryFailed(format!("CSV collect '{table}': {e}")))?;
        if batches.is_empty() {
            return Ok(RecordBatch::new_empty(schema));
        }
        arrow::compute::concat_batches(&batches[0].schema(), &batches)
            .map_err(|e| ConnectorError::QueryFailed(e.to_string()))
    }
}

/// Map an Arrow type to the engine [`DataType`] for introspection (best-effort;
/// unmapped types fall back to `String`, the lossless CSV representation).
fn arrow_to_data_type(arrow: &arrow::datatypes::DataType) -> DataType {
    use arrow::datatypes::DataType as A;
    match arrow {
        A::Int8 | A::Int16 | A::Int32 | A::UInt8 | A::UInt16 | A::UInt32 => DataType::Int32,
        A::Int64 | A::UInt64 => DataType::Int64,
        A::Float16 | A::Float32 | A::Float64 => DataType::Float64,
        A::Decimal128(p, s) => DataType::Decimal(*p, *s),
        A::Boolean => DataType::Boolean,
        A::Date32 | A::Date64 => DataType::Date,
        A::Timestamp(_, _) => DataType::Timestamp,
        A::Dictionary(_, value) => arrow_to_data_type(value),
        _ => DataType::String,
    }
}

impl ConnectorAuth for CsvConnector {
    fn supported_auth_methods() -> Vec<AuthMethodKind> {
        vec![AuthMethodKind::Integrated]
    }
}

impl Connector for CsvConnector {
    async fn list_tables(&self) -> ConnectorResult<Vec<SourceTable>> {
        let entries = std::fs::read_dir(&self.directory).map_err(|e| {
            ConnectorError::ConnectionFailed(format!(
                "CSV connector: cannot read directory '{}': {e}",
                self.directory.display()
            ))
        })?;
        let mut tables = Vec::new();
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) == Some("csv") {
                if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
                    tables.push(SourceTable {
                        schema: self.schema.clone(),
                        name: stem.to_string(),
                    });
                }
            }
        }
        tables.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(tables)
    }

    async fn introspect_table(&self, _schema: &str, table_name: &str) -> ConnectorResult<Table> {
        let batch = self.read_table(table_name).await?;
        let columns: Vec<Column> = batch
            .schema()
            .fields()
            .iter()
            .map(|f| Column::new(f.name(), arrow_to_data_type(f.data_type())))
            .collect();
        Table::new(table_name, columns).map_err(|e| {
            ConnectorError::IntrospectionFailed(format!("CSV table '{table_name}': {e}"))
        })
    }

    async fn fetch_data(&self, request: &FetchRequest) -> ConnectorResult<Vec<RecordBatch>> {
        let batch = self.read_table(&request.table).await?;
        apply_filters(&batch, request).await
    }

    async fn execute_query(&self, _sql: &str) -> ConnectorResult<Vec<RecordBatch>> {
        Err(ConnectorError::UnsupportedOperation(
            "CSV connector does not execute raw SQL".into(),
        ))
    }

    async fn row_count(&self, _schema: &str, table_name: &str) -> ConnectorResult<usize> {
        Ok(self.read_table(table_name).await?.num_rows())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;
    use std::sync::atomic::{AtomicU64, Ordering};

    /// A unique temp directory that removes itself on drop (no external
    /// temp-dir crate needed).
    struct TempDir(PathBuf);
    impl TempDir {
        fn path(&self) -> &Path {
            &self.0
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    static COUNTER: AtomicU64 = AtomicU64::new(0);

    /// Write a temp directory with one CSV file and return (guard, connector).
    fn fixture() -> (TempDir, CsvConnector) {
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        let dir = std::env::temp_dir().join(format!("calcula_csv_test_{}_{n}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let mut f = std::fs::File::create(dir.join("sales.csv")).unwrap();
        writeln!(f, "region,amount").unwrap();
        writeln!(f, "East,100").unwrap();
        writeln!(f, "West,30").unwrap();
        writeln!(f, "East,40").unwrap();
        let conn = CsvConnector::new(&dir, "public");
        (TempDir(dir), conn)
    }

    #[tokio::test]
    async fn lists_csv_files_as_tables() {
        let (_dir, conn) = fixture();
        let tables = conn.list_tables().await.unwrap();
        assert_eq!(tables.len(), 1);
        assert_eq!(tables[0].name, "sales");
        assert_eq!(tables[0].schema, "public");
    }

    #[tokio::test]
    async fn introspects_inferred_schema() {
        let (_dir, conn) = fixture();
        let table = conn.introspect_table("public", "sales").await.unwrap();
        assert_eq!(table.columns().len(), 2);
        assert_eq!(
            table.column("region").unwrap().data_type(),
            &DataType::String
        );
        // amount infers to an integer type.
        assert_eq!(
            table.column("amount").unwrap().data_type(),
            &DataType::Int64
        );
    }

    #[tokio::test]
    async fn fetch_returns_all_rows_then_filters() {
        let (_dir, conn) = fixture();
        let all = conn
            .fetch_data(&FetchRequest {
                schema: Some("public".into()),
                table: "sales".into(),
                ..Default::default()
            })
            .await
            .unwrap();
        assert_eq!(all.iter().map(|b| b.num_rows()).sum::<usize>(), 3);

        let east = conn
            .fetch_data(&FetchRequest {
                schema: Some("public".into()),
                table: "sales".into(),
                filters: vec![engine_connectors::FilterCondition::new(
                    "region",
                    engine_connectors::FilterOperator::Equal,
                    "East",
                )],
                ..Default::default()
            })
            .await
            .unwrap();
        assert_eq!(east.iter().map(|b| b.num_rows()).sum::<usize>(), 2);
    }

    #[tokio::test]
    async fn fetch_honors_in_filters_and_empty_in_matches_nothing() {
        use engine_connectors::traits::{InFilterCondition, InValueKind};
        let (_dir, conn) = fixture();
        // region IN ('West') → 1 row.
        let west = conn
            .fetch_data(&FetchRequest {
                schema: Some("public".into()),
                table: "sales".into(),
                in_filters: vec![InFilterCondition {
                    column: "region".into(),
                    values: vec!["West".into()],
                    kind: InValueKind::Text,
                }],
                ..Default::default()
            })
            .await
            .unwrap();
        assert_eq!(west.iter().map(|b| b.num_rows()).sum::<usize>(), 1);

        // An empty IN-list matches nothing (an RLS-restricted dimension with no
        // permitted keys must restrict the fact to zero rows, never all).
        let none = conn
            .fetch_data(&FetchRequest {
                schema: Some("public".into()),
                table: "sales".into(),
                in_filters: vec![InFilterCondition {
                    column: "region".into(),
                    values: vec![],
                    kind: InValueKind::Text,
                }],
                ..Default::default()
            })
            .await
            .unwrap();
        assert_eq!(none.iter().map(|b| b.num_rows()).sum::<usize>(), 0);
    }

    #[tokio::test]
    async fn fetch_honors_or_groups() {
        use engine_connectors::{FilterCondition, FilterOperator};
        let (_dir, conn) = fixture();
        // (region = 'West') OR (amount > 50) → West/30 + East/100 = 2 rows.
        let rows = conn
            .fetch_data(&FetchRequest {
                schema: Some("public".into()),
                table: "sales".into(),
                or_groups: vec![
                    vec![FilterCondition::new(
                        "region",
                        FilterOperator::Equal,
                        "West",
                    )],
                    vec![FilterCondition::new(
                        "amount",
                        FilterOperator::GreaterThan,
                        "50",
                    )],
                ],
                ..Default::default()
            })
            .await
            .unwrap();
        assert_eq!(rows.iter().map(|b| b.num_rows()).sum::<usize>(), 2);
    }

    #[tokio::test]
    async fn row_count_reads_the_file() {
        let (_dir, conn) = fixture();
        assert_eq!(conn.row_count("public", "sales").await.unwrap(), 3);
    }

    #[tokio::test]
    async fn unknown_table_and_traversal_fail_closed() {
        let (_dir, conn) = fixture();
        assert!(conn.row_count("public", "missing").await.is_err());
        // Path traversal in the table name is rejected.
        assert!(conn.file_path("../etc/passwd").is_err());
        assert!(conn.file_path("sub/sales").is_err());
    }

    #[test]
    fn from_target_rejects_credential_auth() {
        let target = ConnectionTarget::new("localhost", "/tmp/does-not-matter");
        let err = CsvConnector::from_target(
            target,
            AuthMethod::UsernamePassword {
                username: "u".into(),
                password: "p".into(),
            },
        )
        .unwrap_err();
        assert!(matches!(err, ConnectorError::AuthMethodNotSupported(_)));
    }

    #[test]
    fn supported_auth_is_integrated_only() {
        assert_eq!(
            CsvConnector::supported_auth_methods(),
            vec![AuthMethodKind::Integrated]
        );
    }
}
