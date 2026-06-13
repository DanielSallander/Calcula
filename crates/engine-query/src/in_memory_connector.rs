//! In-process connector serving canned Arrow batches.
//!
//! [`InMemoryConnector`] is a connector backed entirely by in-memory
//! [`RecordBatch`] data registered up front — no network, no database. It
//! exists for two purposes:
//!
//! - **Testing**: drives the fetch/refresh paths (including incremental
//!   refresh) deterministically, honoring [`FetchRequest::filters`] so the
//!   "only the volatile rows cross the network" contract can be exercised.
//! - **Simple file-less sources**: a host that already has data in memory (or
//!   loaded it from a file) can serve it through the same connector seam as a
//!   real database, without standing up a server.
//!
//! Filters are applied with DataFusion over the canned batch, using the shared
//! safe-quoting helpers — values and identifiers are never interpolated raw.

use std::collections::HashMap;

use arrow::compute::concat_batches;
use arrow::record_batch::RecordBatch;
use datafusion::prelude::SessionContext;
use engine_connectors::traits::{Connector, FetchRequest, SourceTable};
use engine_connectors::{ConnectorError, ConnectorResult};
use engine_core::compute::sql_util::{quote_ident_double, sql_quote_literal};
use engine_core::model::Table;

/// A connector that serves canned [`RecordBatch`] data from memory.
///
/// Tables are keyed by `(schema, table)`. [`fetch_data`](Self::fetch_data)
/// returns the registered batch, applying any [`FetchRequest::filters`] via
/// DataFusion (other request modifiers — projection, aggregation, ordering —
/// are not applied; this is a minimal scan-with-filters source).
#[derive(Debug, Default)]
pub struct InMemoryConnector {
    tables: HashMap<(String, String), RecordBatch>,
}

impl InMemoryConnector {
    /// Create an empty connector.
    pub fn new() -> Self {
        Self {
            tables: HashMap::new(),
        }
    }

    /// Register (or replace) the canned data for a source table.
    pub fn with_table(
        mut self,
        schema: impl Into<String>,
        table: impl Into<String>,
        batch: RecordBatch,
    ) -> Self {
        self.tables.insert((schema.into(), table.into()), batch);
        self
    }

    /// Look up the registered batch for a request's `(schema, table)`.
    fn batch_for(&self, request: &FetchRequest) -> ConnectorResult<&RecordBatch> {
        let schema = request.schema.clone().unwrap_or_default();
        self.tables
            .get(&(schema.clone(), request.table.clone()))
            .ok_or_else(|| {
                ConnectorError::QueryFailed(format!(
                    "in-memory connector has no table '{}.{}'",
                    schema, request.table
                ))
            })
    }
}

/// Apply a request's filter conditions to `batch` via DataFusion.
///
/// Mirrors the cached-batch filtering in the executor pipeline: every value is
/// rendered with [`sql_quote_literal`] and every column with
/// [`quote_ident_double`], so a hostile filter value cannot break out of the
/// literal and inject SQL.
async fn apply_filters(
    batch: &RecordBatch,
    filters: &[engine_connectors::FilterCondition],
) -> ConnectorResult<Vec<RecordBatch>> {
    if filters.is_empty() {
        return Ok(vec![batch.clone()]);
    }

    let ctx = SessionContext::new();
    ctx.register_batch("_t", batch.clone())
        .map_err(|e| ConnectorError::QueryFailed(e.to_string()))?;

    let conditions: Vec<String> = filters
        .iter()
        .map(|f| {
            format!(
                "{} {} {}",
                quote_ident_double(&f.column),
                f.operator.as_sql(),
                sql_quote_literal(&f.value)
            )
        })
        .collect();
    let sql = format!("SELECT * FROM _t WHERE {}", conditions.join(" AND "));

    let df = ctx
        .sql(&sql)
        .await
        .map_err(|e| ConnectorError::QueryFailed(e.to_string()))?;
    let batches = df
        .collect()
        .await
        .map_err(|e| ConnectorError::QueryFailed(e.to_string()))?;

    if batches.is_empty() {
        Ok(vec![RecordBatch::new_empty(batch.schema())])
    } else {
        let schema = batch.schema();
        Ok(vec![concat_batches(&schema, &batches)
            .map_err(|e| ConnectorError::QueryFailed(e.to_string()))?])
    }
}

impl Connector for InMemoryConnector {
    async fn list_tables(&self) -> ConnectorResult<Vec<SourceTable>> {
        Ok(self
            .tables
            .keys()
            .map(|(schema, name)| SourceTable {
                schema: schema.clone(),
                name: name.clone(),
            })
            .collect())
    }

    async fn introspect_table(&self, schema: &str, table_name: &str) -> ConnectorResult<Table> {
        // Introspection is not modeled for the in-memory connector; hosts build
        // the model directly. Surface a clear error rather than guessing.
        Err(ConnectorError::IntrospectionFailed(format!(
            "in-memory connector does not support introspection (table '{schema}.{table_name}')"
        )))
    }

    async fn fetch_data(&self, request: &FetchRequest) -> ConnectorResult<Vec<RecordBatch>> {
        let batch = self.batch_for(request)?;
        apply_filters(batch, &request.filters).await
    }

    async fn execute_query(&self, _sql: &str) -> ConnectorResult<Vec<RecordBatch>> {
        Err(ConnectorError::UnsupportedOperation(
            "in-memory connector does not execute raw SQL".into(),
        ))
    }

    async fn row_count(&self, schema: &str, table_name: &str) -> ConnectorResult<usize> {
        self.tables
            .get(&(schema.to_string(), table_name.to_string()))
            .map(|b| b.num_rows())
            .ok_or_else(|| {
                ConnectorError::QueryFailed(format!(
                    "in-memory connector has no table '{schema}.{table_name}'"
                ))
            })
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::*;
    use arrow::array::Int64Array;
    use arrow::datatypes::{DataType, Field, Schema};
    use engine_connectors::{FilterCondition, FilterOperator};

    fn batch() -> RecordBatch {
        let schema = Arc::new(Schema::new(vec![Field::new("v", DataType::Int64, true)]));
        RecordBatch::try_new(schema, vec![Arc::new(Int64Array::from(vec![1, 2, 3, 4]))]).unwrap()
    }

    #[tokio::test]
    async fn fetch_without_filters_returns_all_rows() {
        let conn = InMemoryConnector::new().with_table("public", "t", batch());
        let req = FetchRequest {
            schema: Some("public".into()),
            table: "t".into(),
            ..Default::default()
        };
        let out = conn.fetch_data(&req).await.unwrap();
        let total: usize = out.iter().map(|b| b.num_rows()).sum();
        assert_eq!(total, 4);
    }

    #[tokio::test]
    async fn fetch_with_filter_returns_matching_rows() {
        let conn = InMemoryConnector::new().with_table("public", "t", batch());
        let req = FetchRequest {
            schema: Some("public".into()),
            table: "t".into(),
            filters: vec![FilterCondition {
                column: "v".into(),
                operator: FilterOperator::GreaterThanOrEqual,
                value: "3".into(),
            }],
            ..Default::default()
        };
        let out = conn.fetch_data(&req).await.unwrap();
        let total: usize = out.iter().map(|b| b.num_rows()).sum();
        // v >= 3 → rows 3, 4.
        assert_eq!(total, 2);
    }

    #[tokio::test]
    async fn fetch_unknown_table_errors() {
        let conn = InMemoryConnector::new();
        let req = FetchRequest {
            schema: Some("public".into()),
            table: "missing".into(),
            ..Default::default()
        };
        assert!(conn.fetch_data(&req).await.is_err());
    }
}
