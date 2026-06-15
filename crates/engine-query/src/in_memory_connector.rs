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

/// Render a comparison value: unquoted (a numeric literal) when the target
/// column is numeric and the value parses as a number — otherwise an escaped
/// quoted string. Comparing a numeric column to a quoted string makes DataFusion
/// compare **lexically** (`'100' > '50'` is false), so a numeric column must use
/// an unquoted literal for correct ordering.
fn render_value(value: &str, column: &str, numeric_cols: &std::collections::HashSet<String>) -> String {
    if numeric_cols.contains(column) && value.parse::<f64>().is_ok() {
        value.to_string()
    } else {
        sql_quote_literal(value)
    }
}

/// Render a single scalar [`FilterCondition`] as a safe SQL predicate.
fn render_scalar(
    f: &engine_connectors::FilterCondition,
    numeric_cols: &std::collections::HashSet<String>,
) -> String {
    format!(
        "{} {} {}",
        quote_ident_double(&f.column),
        f.operator.as_sql(),
        render_value(&f.value, &f.column, numeric_cols)
    )
}

/// Apply a fetch request's **full** restriction contract to `batch` via
/// DataFusion: scalar `filters` (ANDed), `in_filters` (`col IN (...)`, ANDed),
/// and `or_groups` (a DNF `(g1) OR (g2) …`, ANDed). A connector that scans local
/// data MUST honor all three — the planner pushes user IN/OR slicers AND the
/// propagated row-level-security / relationship IN-filters here, so dropping any
/// of them would over-return rows (a wrong aggregate, or an RLS leak).
///
/// Every value is rendered with [`sql_quote_literal`] and every column with
/// [`quote_ident_double`], so a hostile value cannot break out of the literal
/// and inject SQL. An **empty** `in_filter` value list matches nothing (`1 = 0`);
/// an `or_groups` term with an empty AND-group imposes no restriction (omitted).
pub(crate) async fn apply_filters(
    batch: &RecordBatch,
    request: &FetchRequest,
) -> ConnectorResult<Vec<RecordBatch>> {
    // Columns whose Arrow type is numeric — their comparison values render as
    // unquoted literals so DataFusion compares numerically, not lexically.
    let numeric_cols: std::collections::HashSet<String> = batch
        .schema()
        .fields()
        .iter()
        .filter(|f| f.data_type().is_numeric())
        .map(|f| f.name().clone())
        .collect();

    let mut conditions: Vec<String> = Vec::new();

    // Scalar filters.
    for f in &request.filters {
        conditions.push(render_scalar(f, &numeric_cols));
    }

    // IN-list filters: `col IN (v1, v2, …)`; empty → matches nothing.
    for in_filter in &request.in_filters {
        if in_filter.values.is_empty() {
            conditions.push("1 = 0".to_string());
            continue;
        }
        let values: Vec<String> = in_filter
            .values
            .iter()
            .map(|v| render_value(v, &in_filter.column, &numeric_cols))
            .collect();
        conditions.push(format!(
            "{} IN ({})",
            quote_ident_double(&in_filter.column),
            values.join(", ")
        ));
    }

    // OR groups (DNF): `((c AND c) OR (c AND c) …)`. An empty AND-group matches
    // everything, so the whole disjunction is vacuously true → omit it.
    if !request.or_groups.is_empty() && !request.or_groups.iter().any(|g| g.is_empty()) {
        let groups: Vec<String> = request
            .or_groups
            .iter()
            .map(|group| {
                let conds: Vec<String> = group.iter().map(|c| render_scalar(c, &numeric_cols)).collect();
                format!("({})", conds.join(" AND "))
            })
            .collect();
        conditions.push(format!("({})", groups.join(" OR ")));
    }

    if conditions.is_empty() {
        return Ok(vec![batch.clone()]);
    }

    let ctx = SessionContext::new();
    ctx.register_batch("_t", batch.clone())
        .map_err(|e| ConnectorError::QueryFailed(e.to_string()))?;
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
        apply_filters(batch, request).await
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
            filters: vec![FilterCondition::new(
                "v",
                FilterOperator::GreaterThanOrEqual,
                "3",
            )],
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
