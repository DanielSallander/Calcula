//! Source registry: maps data model tables to their data source connectors.

use std::collections::HashMap;

use arrow::record_batch::RecordBatch;
use engine_connectors::auth::{AuthMethodKind, ConnectorAuth};
use engine_connectors::postgres::PostgresConnector;
use engine_connectors::sqlserver::SqlServerConnector;
use engine_connectors::traits::{Connector, FetchRequest, SourceTable};
use engine_connectors::ConnectorResult;
use engine_core::model::Table;

use crate::csv_connector::CsvConnector;
use crate::in_memory_connector::InMemoryConnector;
use crate::parquet_connector::ParquetConnector;

use crate::error::{QueryError, QueryResult};

/// Identifies a table within a data source (schema + table name).
#[derive(Debug, Clone)]
pub struct SourceBinding {
    /// Source schema name (e.g., `"sales"`, `"BI"`).
    pub schema: String,
    /// Source table name (e.g., `"salesorderheader"`).
    pub table: String,
}

impl SourceBinding {
    /// Create a new source binding.
    pub fn new(schema: impl Into<String>, table: impl Into<String>) -> Self {
        Self {
            schema: schema.into(),
            table: table.into(),
        }
    }
}

/// Enum dispatch for connectors, avoiding async trait object issues.
///
/// Each variant wraps a concrete connector type. New connectors are added
/// as variants here.
pub enum AnyConnector {
    /// PostgreSQL connector.
    Postgres(PostgresConnector),
    /// SQL Server connector.
    SqlServer(SqlServerConnector),
    /// In-process connector serving canned Arrow batches (testing and simple
    /// file-less in-memory sources). See [`InMemoryConnector`].
    InMemory(InMemoryConnector),
    /// File-backed connector serving CSV files from a directory. See
    /// [`CsvConnector`].
    Csv(CsvConnector),
    /// File-backed connector serving Apache Parquet files from a directory. See
    /// [`ParquetConnector`].
    Parquet(ParquetConnector),
}

impl AnyConnector {
    /// Fetch data from this connector.
    pub async fn fetch_data(&self, request: &FetchRequest) -> ConnectorResult<Vec<RecordBatch>> {
        match self {
            AnyConnector::Postgres(c) => c.fetch_data(request).await,
            AnyConnector::SqlServer(c) => c.fetch_data(request).await,
            AnyConnector::InMemory(c) => c.fetch_data(request).await,
            AnyConnector::Csv(c) => c.fetch_data(request).await,
            AnyConnector::Parquet(c) => c.fetch_data(request).await,
        }
    }

    /// Execute a raw SQL query.
    pub async fn execute_query(&self, sql: &str) -> ConnectorResult<Vec<RecordBatch>> {
        match self {
            AnyConnector::Postgres(c) => c.execute_query(sql).await,
            AnyConnector::SqlServer(c) => c.execute_query(sql).await,
            AnyConnector::InMemory(c) => c.execute_query(sql).await,
            AnyConnector::Csv(c) => c.execute_query(sql).await,
            AnyConnector::Parquet(c) => c.execute_query(sql).await,
        }
    }

    /// List tables in the data source.
    pub async fn list_tables(&self) -> ConnectorResult<Vec<SourceTable>> {
        match self {
            AnyConnector::Postgres(c) => c.list_tables().await,
            AnyConnector::SqlServer(c) => c.list_tables().await,
            AnyConnector::InMemory(c) => c.list_tables().await,
            AnyConnector::Csv(c) => c.list_tables().await,
            AnyConnector::Parquet(c) => c.list_tables().await,
        }
    }

    /// Introspect a table's schema.
    pub async fn introspect_table(&self, schema: &str, table_name: &str) -> ConnectorResult<Table> {
        match self {
            AnyConnector::Postgres(c) => c.introspect_table(schema, table_name).await,
            AnyConnector::SqlServer(c) => c.introspect_table(schema, table_name).await,
            AnyConnector::InMemory(c) => c.introspect_table(schema, table_name).await,
            AnyConnector::Csv(c) => c.introspect_table(schema, table_name).await,
            AnyConnector::Parquet(c) => c.introspect_table(schema, table_name).await,
        }
    }

    /// Get the row count for a table.
    pub async fn row_count(&self, schema: &str, table_name: &str) -> ConnectorResult<usize> {
        match self {
            AnyConnector::Postgres(c) => c.row_count(schema, table_name).await,
            AnyConnector::SqlServer(c) => c.row_count(schema, table_name).await,
            AnyConnector::InMemory(c) => c.row_count(schema, table_name).await,
            AnyConnector::Csv(c) => c.row_count(schema, table_name).await,
            AnyConnector::Parquet(c) => c.row_count(schema, table_name).await,
        }
    }

    /// Returns the auth methods supported by this connector type.
    ///
    /// When adding a new `AnyConnector` variant, you MUST add a match arm
    /// here. If the new connector does not implement [`ConnectorAuth`], the
    /// code will not compile — this is intentional.
    ///
    /// The in-memory connector is constructed directly from in-process data
    /// (no [`ConnectionTarget`](engine_connectors::auth::ConnectionTarget) /
    /// secrets), so it supports no auth methods.
    pub fn supported_auth_methods(&self) -> Vec<AuthMethodKind> {
        match self {
            AnyConnector::Postgres(_) => PostgresConnector::supported_auth_methods(),
            AnyConnector::SqlServer(_) => SqlServerConnector::supported_auth_methods(),
            AnyConnector::InMemory(_) => Vec::new(),
            AnyConnector::Csv(_) => CsvConnector::supported_auth_methods(),
            AnyConnector::Parquet(_) => ParquetConnector::supported_auth_methods(),
        }
    }

    /// Execute a multi-table aggregation query with JOINs.
    pub async fn execute_join_aggregation(
        &self,
        request: &engine_connectors::JoinAggregationRequest,
    ) -> ConnectorResult<Vec<RecordBatch>> {
        match self {
            AnyConnector::Postgres(c) => c.execute_join_aggregation(request).await,
            AnyConnector::SqlServer(c) => c.execute_join_aggregation(request).await,
            AnyConnector::InMemory(c) => c.execute_join_aggregation(request).await,
            AnyConnector::Csv(c) => c.execute_join_aggregation(request).await,
            AnyConnector::Parquet(c) => c.execute_join_aggregation(request).await,
        }
    }
}

/// Registry that maps data model table names to their connectors and
/// source locations.
///
/// Multiple model tables can share the same connector instance (e.g., all
/// tables from the same PostgreSQL database use one connector).
pub struct SourceRegistry {
    /// Map from model table name to (connector index, source binding).
    bindings: HashMap<String, (usize, SourceBinding)>,
    /// Connectors, referenced by index.
    connectors: Vec<AnyConnector>,
}

impl SourceRegistry {
    /// Create a new empty registry.
    pub fn new() -> Self {
        Self {
            bindings: HashMap::new(),
            connectors: Vec::new(),
        }
    }

    /// Register a connector and return its index.
    pub fn add_connector(&mut self, connector: AnyConnector) -> usize {
        let idx = self.connectors.len();
        self.connectors.push(connector);
        idx
    }

    /// Bind a model table name to a connector and source location.
    pub fn bind(
        &mut self,
        model_table: impl Into<String>,
        connector_index: usize,
        binding: SourceBinding,
    ) {
        self.bindings
            .insert(model_table.into(), (connector_index, binding));
    }

    /// Look up the connector for a model table.
    pub fn connector_for(&self, model_table: &str) -> QueryResult<&AnyConnector> {
        let (idx, _) = self
            .bindings
            .get(model_table)
            .ok_or_else(|| QueryError::SourceNotRegistered(model_table.to_string()))?;
        Ok(&self.connectors[*idx])
    }

    /// Look up a connector by its registration index. Used by host commands that
    /// run a connector-level operation against a known connection (e.g. a
    /// consented script's read-only raw-SQL query), where the index comes from
    /// the connection rather than from a model table binding.
    pub fn connector_by_index(&self, index: usize) -> Option<&AnyConnector> {
        self.connectors.get(index)
    }

    /// Look up the source binding for a model table.
    pub fn binding_for(&self, model_table: &str) -> QueryResult<&SourceBinding> {
        let (_, binding) = self
            .bindings
            .get(model_table)
            .ok_or_else(|| QueryError::SourceNotRegistered(model_table.to_string()))?;
        Ok(binding)
    }

    /// Get the connector index for a model table.
    pub fn connector_index_for(&self, model_table: &str) -> QueryResult<usize> {
        let (idx, _) = self
            .bindings
            .get(model_table)
            .ok_or_else(|| QueryError::SourceNotRegistered(model_table.to_string()))?;
        Ok(*idx)
    }

    /// Check if a model table is registered.
    pub fn has_table(&self, model_table: &str) -> bool {
        self.bindings.contains_key(model_table)
    }
}

impl Default for SourceRegistry {
    fn default() -> Self {
        Self::new()
    }
}
