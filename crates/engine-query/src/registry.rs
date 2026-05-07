//! Source registry: maps data model tables to their data source connectors.

use std::collections::HashMap;

use arrow::record_batch::RecordBatch;
use engine_connectors::postgres::PostgresConnector;
use engine_connectors::sqlserver::SqlServerConnector;
use engine_connectors::traits::{Connector, FetchRequest, SourceTable};
use engine_connectors::ConnectorResult;
use engine_core::model::Table;

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
}

impl AnyConnector {
    /// Fetch data from this connector.
    pub async fn fetch_data(&self, request: &FetchRequest) -> ConnectorResult<Vec<RecordBatch>> {
        match self {
            AnyConnector::Postgres(c) => c.fetch_data(request).await,
            AnyConnector::SqlServer(c) => c.fetch_data(request).await,
        }
    }

    /// Execute a raw SQL query.
    pub async fn execute_query(&self, sql: &str) -> ConnectorResult<Vec<RecordBatch>> {
        match self {
            AnyConnector::Postgres(c) => c.execute_query(sql).await,
            AnyConnector::SqlServer(c) => c.execute_query(sql).await,
        }
    }

    /// List tables in the data source.
    pub async fn list_tables(&self) -> ConnectorResult<Vec<SourceTable>> {
        match self {
            AnyConnector::Postgres(c) => c.list_tables().await,
            AnyConnector::SqlServer(c) => c.list_tables().await,
        }
    }

    /// Introspect a table's schema.
    pub async fn introspect_table(&self, schema: &str, table_name: &str) -> ConnectorResult<Table> {
        match self {
            AnyConnector::Postgres(c) => c.introspect_table(schema, table_name).await,
            AnyConnector::SqlServer(c) => c.introspect_table(schema, table_name).await,
        }
    }

    /// Get the row count for a table.
    pub async fn row_count(&self, schema: &str, table_name: &str) -> ConnectorResult<usize> {
        match self {
            AnyConnector::Postgres(c) => c.row_count(schema, table_name).await,
            AnyConnector::SqlServer(c) => c.row_count(schema, table_name).await,
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
