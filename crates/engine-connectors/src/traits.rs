//! Connector trait and supporting types.
//!
//! The [`Connector`] trait defines the interface that all data source
//! connectors must implement. It provides schema introspection and data
//! fetching, returning results as Arrow `RecordBatch` values.

use std::collections::HashMap;
use std::future::Future;
use std::sync::{PoisonError, RwLock};

use arrow::record_batch::RecordBatch;
use engine_core::model::Table;

use crate::error::ConnectorResult;

/// Name of the synthetic grouping-indicator column appended to query results
/// when ROLLUP totals are requested (see [`FetchRequest::rollup_totals`]).
///
/// The column is a 32-bit integer bitmask: bit `i` (least-significant bit =
/// the first `group_by` column) is **set** when that group-by column is
/// rolled up (aggregated away) in the row. Detail rows are `0`; the grand
/// total has all bits set. This matches SQL `GROUPING_ID` semantics and
/// disambiguates subtotal `NULL`s from real `NULL` dimension values.
pub const GROUPING_ID_COLUMN: &str = "__grouping_id";

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

/// Classification of IN-list filter values, controlling how connectors
/// render them in SQL.
///
/// Integer join keys (the common case for surrogate keys) must be rendered
/// as unquoted numeric literals compared against the *uncast* column —
/// casting the fact column to text (`"col"::text IN ('1', ...)`) makes the
/// predicate non-sargable and forces a sequential scan over the fact table.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum InValueKind {
    /// Values are arbitrary strings; connectors escape and quote them.
    #[default]
    Text,
    /// Values are decimal integer literals; connectors render them unquoted
    /// (index-friendly) **after re-validating** that every value parses as
    /// an integer. See [`InFilterCondition::effective_kind`].
    Integer,
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
    /// How the values should be rendered in SQL. Defaults to
    /// [`InValueKind::Text`] (escaped + quoted).
    pub kind: InValueKind,
}

impl InFilterCondition {
    /// Create a text-kind IN filter (values escaped and quoted by the
    /// connector). This is the safe default for arbitrary values.
    pub fn text(column: impl Into<String>, values: Vec<String>) -> Self {
        Self {
            column: column.into(),
            values,
            kind: InValueKind::Text,
        }
    }

    /// The value kind connectors must actually render with.
    ///
    /// Re-validates [`InValueKind::Integer`] defensively: unless **every**
    /// value parses as `i128`, the kind is downgraded to
    /// [`InValueKind::Text`] so that no unvalidated string is ever inlined
    /// unquoted into SQL. Connectors must call this rather than trusting
    /// the `kind` field directly.
    pub fn effective_kind(&self) -> InValueKind {
        match self.kind {
            InValueKind::Text => InValueKind::Text,
            InValueKind::Integer => {
                if self.values.iter().all(|v| v.parse::<i128>().is_ok()) {
                    InValueKind::Integer
                } else {
                    InValueKind::Text
                }
            }
        }
    }
}

/// The sort key of an [`OrderByExpr`] in a pushed query.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OrderByTarget {
    /// A plain column reference. For aggregate requests this must be one of
    /// the `group_by` columns.
    Column(String),
    /// `MIN(column)` — engine sort-by-column substitution. The model sorts a
    /// display column by a different column (e.g. `MonthName` by
    /// `MonthNumber`) that is not part of the GROUP BY clause, so the sort
    /// column must be aggregated. `MIN` is exact under the model's 1:1
    /// display-value-to-sort-value assumption.
    MinColumn(String),
    /// A result-column alias from the SELECT list (e.g. an aggregate alias),
    /// used to order by a measure's value.
    Alias(String),
}

/// A single ORDER BY entry of a [`FetchRequest`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OrderByExpr {
    /// What to sort by.
    pub target: OrderByTarget,
    /// Sort direction; `false` is ascending.
    pub descending: bool,
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
    /// A disjunctive (OR) restriction in DNF, ANDed with `filters`/`in_filters`.
    ///
    /// The outer `Vec` is OR-combined; each inner `Vec` is an AND-group of
    /// conditions: `(g1c1 AND g1c2) OR (g2c1) OR ...`. Used for cross-column OR
    /// slicers and multi-role row-level-security union (one role per group).
    /// All conditions reference columns of this fetch's table. Empty (the
    /// default) adds nothing; an empty AND-group matches everything, so if any
    /// group is empty the whole OR is omitted (no restriction).
    pub or_groups: Vec<Vec<FilterCondition>>,
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
    /// ORDER BY entries applied to the result. Rendered after `GROUP BY` and
    /// combined with the row limit (`LIMIT` on PostgreSQL, `TOP(n)` on SQL
    /// Server — `TOP` with `ORDER BY` returns the first rows of the ordered
    /// result).
    pub order_by: Vec<OrderByExpr>,
    /// Render the aggregation with SQL ROLLUP totals.
    ///
    /// Only meaningful when `aggregates` is non-empty. When set, the
    /// connector renders `GROUP BY ROLLUP (a, b, ...)` instead of a plain
    /// `GROUP BY`, so the result contains the detail rows plus subtotal rows
    /// per group-by prefix and a grand total — all computed at the source in
    /// one query. The result gains a trailing integer column named
    /// [`GROUPING_ID_COLUMN`] whose bitmask identifies the rolled-up columns
    /// (bit `i` set = `group_by[i]` rolled up, LSB = `group_by[0]`). With an
    /// empty `group_by`, the single aggregate row is emitted with a literal
    /// `0` grouping id.
    ///
    /// `limit` (when present) applies to the combined result including the
    /// subtotal rows.
    pub rollup_totals: bool,
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

    /// Discard any cached schema metadata held by this connector.
    ///
    /// Connectors that cache introspection results (see [`SchemaCache`])
    /// serve table schemas from memory after the first lookup and will not
    /// observe DDL changes on the source (`ALTER TABLE`, column type changes,
    /// drops) until invalidated. Host applications that issue or expect DDL —
    /// model designers in particular — should call this afterwards; the next
    /// introspection re-reads the source catalog.
    ///
    /// Default implementation is a no-op for connectors that do not cache.
    fn invalidate_schema_cache(&self) {}
}

/// A read-through cache for introspected table schemas, keyed by
/// `(schema, table)`.
///
/// Schema introspection requires one or more catalog round-trips per table
/// (e.g. `information_schema.columns` plus domain-type resolution on
/// PostgreSQL). Connectors consult this cache so that repeated fetches
/// against the same table pay that cost only once per connector lifetime.
///
/// # Staleness tradeoff
///
/// Entries never expire on their own: a cached schema can go stale if the
/// source table is altered (columns added/removed/retyped) while the
/// connector is alive. Within a typical analytical session schemas
/// essentially never change, so this is the right default — but hosts that
/// run DDL (model designers) must call [`SchemaCache::invalidate_all`]
/// (exposed as `invalidate_schema_cache` on connectors) afterwards.
///
/// # Lock discipline
///
/// Uses a synchronous [`std::sync::RwLock`]: every guard is acquired and
/// released within a single non-async statement, and the loader future in
/// [`SchemaCache::get_or_load`] runs with **no lock held**, so a guard is
/// never held across an `.await` and futures using the cache remain `Send`.
/// Lock poisoning is recovered via [`PoisonError::into_inner`] — the guarded
/// sections only perform `HashMap` operations, so the map cannot be left in
/// a logically inconsistent state.
#[derive(Debug, Default)]
pub struct SchemaCache {
    /// Cached table definitions keyed by `(schema, table)`.
    entries: RwLock<HashMap<(String, String), Table>>,
}

impl SchemaCache {
    /// Create an empty schema cache.
    pub fn new() -> Self {
        Self::default()
    }

    /// Return the cached schema for `(schema, table)`, or run `loader` to
    /// introspect it and cache the result.
    ///
    /// Read-through semantics: the cache is probed under a read lock (guard
    /// dropped immediately); on a miss the `loader` future runs without any
    /// lock held, and the result is inserted under a short write lock.
    /// Loader **errors are not cached** — a failed introspection is retried
    /// on the next call.
    ///
    /// Two concurrent callers missing on the same key may both run the
    /// loader; both then insert the identical schema, so this benign race
    /// costs at most one redundant catalog round-trip and never corrupts
    /// the cache.
    pub async fn get_or_load<F, Fut>(
        &self,
        schema: &str,
        table: &str,
        loader: F,
    ) -> ConnectorResult<Table>
    where
        F: FnOnce() -> Fut,
        Fut: Future<Output = ConnectorResult<Table>>,
    {
        let key = (schema.to_string(), table.to_string());

        // Fast path: probe under a read lock; the guard is dropped at the
        // end of this statement, before any await.
        let cached = self
            .entries
            .read()
            .unwrap_or_else(PoisonError::into_inner)
            .get(&key)
            .cloned();
        if let Some(table) = cached {
            return Ok(table);
        }

        // Miss: run the real introspection with no lock held.
        let loaded = loader().await?;

        self.entries
            .write()
            .unwrap_or_else(PoisonError::into_inner)
            .insert(key, loaded.clone());
        Ok(loaded)
    }

    /// Remove all cached schemas.
    ///
    /// Call after DDL on the source (or whenever stale metadata is
    /// suspected); subsequent lookups re-introspect against the source
    /// catalog.
    pub fn invalidate_all(&self) {
        self.entries
            .write()
            .unwrap_or_else(PoisonError::into_inner)
            .clear();
    }

    /// Number of cached table schemas (diagnostics/testing).
    pub fn len(&self) -> usize {
        self.entries
            .read()
            .unwrap_or_else(PoisonError::into_inner)
            .len()
    }

    /// Whether the cache holds no entries.
    pub fn is_empty(&self) -> bool {
        self.len() == 0
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
        assert!(req.order_by.is_empty());
        assert!(!req.rollup_totals);
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
            kind: InValueKind::Integer,
        };
        assert_eq!(in_filter.column, "date_key");
        assert_eq!(in_filter.values.len(), 3);
        assert_eq!(in_filter.kind, InValueKind::Integer);
    }

    #[test]
    fn in_value_kind_defaults_to_text() {
        assert_eq!(InValueKind::default(), InValueKind::Text);
        let in_filter = InFilterCondition::text("name", vec!["a".into()]);
        assert_eq!(in_filter.kind, InValueKind::Text);
    }

    #[test]
    fn effective_kind_integer_with_valid_values_stays_integer() {
        let in_filter = InFilterCondition {
            column: "product_id".into(),
            values: vec!["1".into(), "-42".into(), "9223372036854775807".into()],
            kind: InValueKind::Integer,
        };
        assert_eq!(in_filter.effective_kind(), InValueKind::Integer);
    }

    #[test]
    fn effective_kind_integer_with_hostile_value_downgrades_to_text() {
        let in_filter = InFilterCondition {
            column: "product_id".into(),
            values: vec!["1".into(), "2); DROP TABLE t; --".into()],
            kind: InValueKind::Integer,
        };
        assert_eq!(in_filter.effective_kind(), InValueKind::Text);
    }

    #[test]
    fn effective_kind_text_stays_text_even_for_numeric_values() {
        let in_filter = InFilterCondition {
            column: "code".into(),
            values: vec!["1".into(), "2".into()],
            kind: InValueKind::Text,
        };
        assert_eq!(in_filter.effective_kind(), InValueKind::Text);
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

    mod schema_cache {
        use std::sync::atomic::{AtomicUsize, Ordering};

        use engine_core::model::Column;
        use engine_core::types::DataType;

        use super::super::SchemaCache;
        use crate::error::{ConnectorError, ConnectorResult};
        use engine_core::model::Table;

        /// Build a minimal table definition for cache tests.
        fn sample_table(name: &str) -> Table {
            Table::new(name, vec![Column::new("id", DataType::Int32)])
                .expect("test table construction cannot fail")
        }

        /// Loader stub that counts invocations and returns `sample_table`.
        async fn counting_loader(counter: &AtomicUsize, name: &str) -> ConnectorResult<Table> {
            counter.fetch_add(1, Ordering::SeqCst);
            Ok(sample_table(name))
        }

        #[tokio::test]
        async fn second_lookup_does_not_reinvoke_loader() {
            let cache = SchemaCache::new();
            let calls = AtomicUsize::new(0);

            let first = cache
                .get_or_load("sales", "orders", || {
                    counting_loader(&calls, "sales.orders")
                })
                .await
                .unwrap();
            let second = cache
                .get_or_load("sales", "orders", || {
                    counting_loader(&calls, "sales.orders")
                })
                .await
                .unwrap();

            assert_eq!(calls.load(Ordering::SeqCst), 1);
            assert_eq!(first.name(), second.name());
            assert_eq!(cache.len(), 1);
        }

        #[tokio::test]
        async fn invalidate_all_clears_entries_and_forces_reload() {
            let cache = SchemaCache::new();
            let calls = AtomicUsize::new(0);

            cache
                .get_or_load("sales", "orders", || {
                    counting_loader(&calls, "sales.orders")
                })
                .await
                .unwrap();
            assert_eq!(cache.len(), 1);

            cache.invalidate_all();
            assert!(cache.is_empty());

            cache
                .get_or_load("sales", "orders", || {
                    counting_loader(&calls, "sales.orders")
                })
                .await
                .unwrap();
            assert_eq!(calls.load(Ordering::SeqCst), 2);
        }

        #[tokio::test]
        async fn distinct_keys_are_loaded_independently() {
            let cache = SchemaCache::new();
            let calls = AtomicUsize::new(0);

            cache
                .get_or_load("sales", "orders", || {
                    counting_loader(&calls, "sales.orders")
                })
                .await
                .unwrap();
            cache
                .get_or_load("sales", "customers", || {
                    counting_loader(&calls, "sales.customers")
                })
                .await
                .unwrap();
            // Same table name in a different schema is a distinct key.
            cache
                .get_or_load("archive", "orders", || {
                    counting_loader(&calls, "archive.orders")
                })
                .await
                .unwrap();

            assert_eq!(calls.load(Ordering::SeqCst), 3);
            assert_eq!(cache.len(), 3);
        }

        #[tokio::test]
        async fn loader_error_is_not_cached() {
            let cache = SchemaCache::new();
            let calls = AtomicUsize::new(0);

            let err = cache
                .get_or_load("sales", "orders", || async {
                    calls.fetch_add(1, Ordering::SeqCst);
                    Err::<Table, _>(ConnectorError::IntrospectionFailed("boom".into()))
                })
                .await
                .unwrap_err();
            assert!(matches!(err, ConnectorError::IntrospectionFailed(_)));
            assert!(cache.is_empty());

            // The failed lookup must be retried, not served from cache.
            cache
                .get_or_load("sales", "orders", || {
                    counting_loader(&calls, "sales.orders")
                })
                .await
                .unwrap();
            assert_eq!(calls.load(Ordering::SeqCst), 2);
            assert_eq!(cache.len(), 1);
        }
    }
}
