//! Connector trait and supporting types.
//!
//! The [`Connector`] trait defines the interface that all data source
//! connectors must implement. It provides schema introspection and data
//! fetching, returning results as Arrow `RecordBatch` values.

use arrow::record_batch::RecordBatch;
use engine_core::model::Table;

use crate::error::ConnectorResult;

/// Metadata about a table discovered from a data source.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SourceTable {
    /// Schema name (e.g., `"sales"`, `"public"`).
    pub schema: String,
    /// Table name (e.g., `"salesorderheader"`).
    pub name: String,
}

/// Comparison operators for filter conditions.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FilterOperator {
    /// `=`
    Equal,
    /// `!=` / `<>`
    NotEqual,
    /// `>`
    GreaterThan,
    /// `<`
    LessThan,
    /// `>=`
    GreaterThanOrEqual,
    /// `<=`
    LessThanOrEqual,
}

impl FilterOperator {
    /// Returns the SQL representation of this operator.
    pub fn as_sql(&self) -> &'static str {
        match self {
            Self::Equal => "=",
            Self::NotEqual => "<>",
            Self::GreaterThan => ">",
            Self::LessThan => "<",
            Self::GreaterThanOrEqual => ">=",
            Self::LessThanOrEqual => "<=",
        }
    }
}

/// Aggregation functions supported by connectors for pushdown.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AggregateFunction {
    /// `SUM`
    Sum,
    /// `COUNT`
    Count,
    /// `AVG`
    Avg,
    /// `MIN`
    Min,
    /// `MAX`
    Max,
    /// `COUNT(DISTINCT ...)`
    CountDistinct,
    /// `COUNT(*)` — count all rows including nulls.
    CountAll,
}

impl AggregateFunction {
    /// Returns the SQL function name.
    ///
    /// For `CountDistinct`, returns `"COUNT"` — the `DISTINCT` keyword is
    /// handled in the SQL template by the connector.
    pub fn as_sql(&self) -> &'static str {
        match self {
            Self::Sum => "SUM",
            Self::Count => "COUNT",
            Self::Avg => "AVG",
            Self::Min => "MIN",
            Self::Max => "MAX",
            Self::CountDistinct => "COUNT",
            Self::CountAll => "COUNT",
        }
    }
}

/// An aggregation expression to push down to a data source.
#[derive(Debug, Clone)]
pub struct AggregateExpr {
    /// Column to aggregate.
    pub column: String,
    /// Aggregation function.
    pub function: AggregateFunction,
    /// Optional alias for the result column.
    pub alias: Option<String>,
}

/// A simple filter condition for basic query pushdown.
#[derive(Debug, Clone)]
pub struct FilterCondition {
    /// Column name to filter on.
    pub column: String,
    /// Comparison operator.
    pub operator: FilterOperator,
    /// Value to compare against (string representation; connector handles
    /// quoting and parameterization).
    pub value: String,
}

/// An IN-list filter condition: `column IN (v1, v2, ...)`.
///
/// Used for relationship-based filter propagation: when a dimension table is
/// fetched with a filter, the matching join key values can be pushed as an
/// IN filter on the fact table's foreign key column.
#[derive(Debug, Clone)]
pub struct InFilterCondition {
    /// Column name to filter on (typically a foreign key).
    pub column: String,
    /// Values to include (string representations; connector handles quoting).
    pub values: Vec<String>,
}

/// A request to fetch data from a source table.
///
/// All fields are optional modifiers on a base `SELECT` from the table.
/// When `aggregates` is non-empty, the connector generates a `GROUP BY` query
/// instead of a plain `SELECT`.
#[derive(Debug, Clone, Default)]
pub struct FetchRequest {
    /// Schema name (e.g., `"sales"`). If `None`, uses the table name unqualified.
    pub schema: Option<String>,
    /// Table name.
    pub table: String,
    /// Columns to select. Empty means `SELECT *`. Ignored when `aggregates` is non-empty.
    pub columns: Vec<String>,
    /// Filter conditions, combined with `AND`.
    pub filters: Vec<FilterCondition>,
    /// IN-list filter conditions, combined with `AND` (and with `filters`).
    ///
    /// Each entry produces a `column IN (v1, v2, ...)` clause. Used for
    /// relationship-based filter propagation from dimension tables.
    pub in_filters: Vec<InFilterCondition>,
    /// Maximum number of rows to return.
    pub limit: Option<usize>,
    /// Columns to group by. When non-empty, `aggregates` must also be non-empty.
    pub group_by: Vec<String>,
    /// Aggregations to compute. When non-empty, the result contains the
    /// `group_by` columns followed by one column per aggregate expression.
    pub aggregates: Vec<AggregateExpr>,
    /// Maximum number of IN-filter values to inline in SQL before switching
    /// to a temp-table strategy. `None` means always inline.
    pub max_inline_in_values: Option<usize>,
}

/// A join condition for multi-table aggregation pushdown.
#[derive(Debug, Clone)]
pub struct JoinClause {
    /// Source schema + table of the dimension being joined.
    pub dim_schema: String,
    /// Source table name of the dimension being joined.
    pub dim_table: String,
    /// Column on the fact (left) side of the join.
    pub fact_column: String,
    /// Column on the dimension (right) side of the join.
    pub dim_column: String,
}

/// A column reference in a multi-table query (source table + column).
#[derive(Debug, Clone)]
pub struct QualifiedColumn {
    /// Source table name (as registered in the data source).
    pub table: String,
    /// Column name.
    pub column: String,
}

/// A measure expression for multi-table aggregation pushdown.
///
/// Carries the engine Expression tree so each connector can render
/// it using its own SQL dialect.
#[derive(Debug, Clone)]
pub struct MeasureExpr {
    /// The engine expression tree (aggregates, arithmetic, CASE WHEN, etc.).
    pub expression: engine_core::compute::expression::Expression,
    /// Output alias for this measure.
    pub alias: String,
}

/// A request for multi-table aggregation with JOINs.
///
/// This is the structured, dialect-neutral representation of a pushed
/// join query. Each connector translates it to its own SQL syntax.
#[derive(Debug, Clone)]
pub struct JoinAggregationRequest {
    /// Fact table schema.
    pub fact_schema: String,
    /// Fact table name.
    pub fact_table: String,
    /// JOIN clauses to dimension tables.
    pub joins: Vec<JoinClause>,
    /// Measure expressions to compute.
    pub measures: Vec<MeasureExpr>,
    /// Columns to GROUP BY.
    pub group_by: Vec<QualifiedColumn>,
    /// Optional WHERE filter conditions.
    pub filters: Vec<FilterCondition>,
    /// Mapping from model table names to source table names.
    /// Used by the connector to qualify column references in expressions.
    pub table_map: Vec<(String, String)>,
}

/// Trait for data source connectors.
///
/// Implementations provide access to external databases, translating
/// between the engine's type system and the source's native types.
/// Results are always returned as Arrow `RecordBatch` values.
///
/// Connection setup is connector-specific — each implementation has its
/// own constructor (e.g., `PostgresConnector::connect`).
#[allow(async_fn_in_trait)]
pub trait Connector {
    /// List all user tables available in the data source.
    ///
    /// Excludes system tables and internal schemas.
    async fn list_tables(&self) -> ConnectorResult<Vec<SourceTable>>;

    /// Introspect a table's schema, returning an engine [`Table`] definition.
    ///
    /// Maps source column types to engine `DataType` values.
    async fn introspect_table(&self, schema: &str, table_name: &str) -> ConnectorResult<Table>;

    /// Fetch data from a source table as Arrow `RecordBatch` values.
    ///
    /// The [`FetchRequest`] can specify column selection, filters, and a row
    /// limit for basic pushdown.
    async fn fetch_data(&self, request: &FetchRequest) -> ConnectorResult<Vec<RecordBatch>>;

    /// Execute a raw SQL query and return results as Arrow `RecordBatch` values.
    ///
    /// This is an escape hatch for advanced use cases and testing.
    async fn execute_query(&self, sql: &str) -> ConnectorResult<Vec<RecordBatch>>;

    /// Get the total row count for a table (pushes `COUNT(*)` to the source).
    async fn row_count(&self, schema: &str, table_name: &str) -> ConnectorResult<usize>;

    /// Execute a multi-table aggregation query with JOINs.
    ///
    /// Each connector translates the structured [`JoinAggregationRequest`]
    /// to its own SQL dialect (PostgreSQL, SQL Server, etc.) and executes it.
    ///
    /// Default implementation returns an error — connectors that support
    /// join pushdown override this.
    async fn execute_join_aggregation(
        &self,
        _request: &JoinAggregationRequest,
    ) -> ConnectorResult<Vec<RecordBatch>> {
        Err(crate::error::ConnectorError::UnsupportedOperation(
            "join aggregation pushdown not supported by this connector".into(),
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fetch_request_default_has_no_filters() {
        let req = FetchRequest::default();
        assert!(req.schema.is_none());
        assert!(req.table.is_empty());
        assert!(req.columns.is_empty());
        assert!(req.filters.is_empty());
        assert!(req.in_filters.is_empty());
        assert!(req.limit.is_none());
        assert!(req.group_by.is_empty());
        assert!(req.aggregates.is_empty());
        assert!(req.max_inline_in_values.is_none());
    }

    #[test]
    fn aggregate_function_as_sql() {
        assert_eq!(AggregateFunction::Sum.as_sql(), "SUM");
        assert_eq!(AggregateFunction::Count.as_sql(), "COUNT");
        assert_eq!(AggregateFunction::Avg.as_sql(), "AVG");
        assert_eq!(AggregateFunction::Min.as_sql(), "MIN");
        assert_eq!(AggregateFunction::Max.as_sql(), "MAX");
        assert_eq!(AggregateFunction::CountDistinct.as_sql(), "COUNT");
    }

    #[test]
    fn in_filter_condition_construction() {
        let in_filter = InFilterCondition {
            column: "date_key".into(),
            values: vec!["1".into(), "2".into(), "3".into()],
        };
        assert_eq!(in_filter.column, "date_key");
        assert_eq!(in_filter.values.len(), 3);
    }

    #[test]
    fn filter_operator_as_sql() {
        assert_eq!(FilterOperator::Equal.as_sql(), "=");
        assert_eq!(FilterOperator::NotEqual.as_sql(), "<>");
        assert_eq!(FilterOperator::GreaterThan.as_sql(), ">");
        assert_eq!(FilterOperator::LessThan.as_sql(), "<");
        assert_eq!(FilterOperator::GreaterThanOrEqual.as_sql(), ">=");
        assert_eq!(FilterOperator::LessThanOrEqual.as_sql(), "<=");
    }
}
