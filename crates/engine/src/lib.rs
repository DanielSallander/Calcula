//! # Calcula Engine
//!
//! Unified API for the Calcula analytical engine library.
//!
//! This crate re-exports key types from `engine-core`, `engine-connectors`,
//! and `engine-query`, and provides a high-level [`Engine`] struct that
//! coordinates data model management, source registration, and query
//! execution.
//!
//! # Example
//!
//! ```rust,no_run
//! use bi_engine::*;
//!
//! # async fn example() -> Result<(), Box<dyn std::error::Error>> {
//! let model = DataModel::builder()
//!     .add_table(Table::new("Sales", vec![
//!         Column::new("id", DataType::Int64),
//!         Column::new("amount", DataType::Float64),
//!     ])?)
//!     .add_measure(sum_measure("Revenue", "Sales", "amount"))
//!     .build()?;
//!
//! let mut engine = Engine::new(model);
//! let target = ConnectionTarget::new("localhost", "db").with_port(5432);
//! let auth = AuthMethod::UsernamePassword {
//!     username: "user".into(),
//!     password: "pass".into(),
//! };
//! let pg_idx = engine.add_postgres(target, auth).await?;
//! engine.bind_table("Sales", pg_idx, SourceBinding::new("public", "sales"));
//!
//! let results = engine.query(QueryRequest {
//!     measures: vec!["Revenue".into()],
//!     ..Default::default()
//! }).await?;
//! # Ok(())
//! # }
//! ```
//!
//! # Time intelligence
//!
//! Mark a date table and assign [`DateRole`]s to its columns to enable
//! `YTD`/`QTD`/`MTD`/`PRIORYEAR`/`PRIORPERIOD` measures. The functions use
//! **query-axis semantics**: the date table's role columns must be in the
//! query's `group_by` (Year plus a finer column for YTD), and the engine
//! lowers the measure onto a SQL window function over that axis.
//!
//! ```rust
//! use bi_engine::*;
//!
//! # fn example() -> Result<(), Box<dyn std::error::Error>> {
//! let model = DataModel::builder()
//!     .add_table(Table::new("dim_date", vec![
//!         Column::new("date_id", DataType::Int64),
//!         Column::new("year", DataType::Int32).with_date_role(DateRole::Year),
//!         Column::new("month", DataType::Int32).with_date_role(DateRole::Month),
//!     ])?)
//!     .add_table(Table::new("fact_sales", vec![
//!         Column::new("date_id", DataType::Int64),
//!         Column::new("amount", DataType::Float64),
//!     ])?)
//!     .add_relationship(Relationship::many_to_one(
//!         "sales_date", "fact_sales", "date_id", "dim_date", "date_id",
//!     ))
//!     .mark_date_table("dim_date")
//!     .add_measure(expression_measure(
//!         "Revenue YTD",
//!         parse_measure_expression("YTD(SUM(fact_sales[amount]))")?,
//!     ))
//!     .build()?;
//!
//! // Query with group_by = [dim_date.year, dim_date.month] → running
//! // total per month that resets at each year boundary. PRIORYEAR works
//! // the same way: PRIORYEAR(SUM(fact_sales[amount])) reads the value of
//! // the same month one year earlier (blank for the first year).
//! # let _ = model;
//! # Ok(())
//! # }
//! ```

mod auto_tier;
mod disk_cache;
mod model_io;
mod query_cache;
mod refresh;

#[cfg(test)]
mod disk_cache_tests;
#[cfg(test)]
mod test_fixtures;

use std::sync::Arc;
use std::time::Instant;

use arrow::record_batch::RecordBatch;
use parking_lot::Mutex;

use auto_tier::AutoTierState;

pub use auto_tier::AutoTierConfig;
pub use query_cache::{QueryCacheConfig, QueryCacheStats};
pub use refresh::{RefreshFailure, RefreshReport, SourceQueryPolicy};

/// Cancellation token for [`Engine::query_with_cancellation`] (re-exported
/// from `tokio_util` so hosts don't need a direct dependency).
pub use tokio_util::sync::CancellationToken;

// --- Re-exports from engine-core ---

pub use engine_core::catalog::{function_catalog, FunctionInfo};
pub use engine_core::compute::aggregate::AggregateOp;
pub use engine_core::compute::context::{
    ContextResolver, EvaluationContext, FilterSource, ResolvedFilter, ResolvedInFilter,
};
pub use engine_core::compute::expression::{
    self, expand_global_variables, infer_fact_table, ArithmeticOp, ComparisonOp, DateGranularity,
    Expression, FilterPredicate, InPredicate, RelationshipPath,
};
pub use engine_core::compute::measure::{
    average_measure, count_measure, distinct_count_measure, expression_measure, sum_measure,
    Measure, MeasureGroup,
};
pub use engine_core::compute::measure_engine::MeasureEngine;
pub use engine_core::compute::parser::{
    parse_context, parse_global, parse_measure, parse_measure_expression, parse_table_variable,
};
pub use engine_core::compute::plan::{
    ExecutionPlan, PlanDuration, PlanNode, PlanOperation, PlanProperty, PlanValue,
};
pub use engine_core::compute::udf::{
    create_udf, ColumnarValue, ScalarUDF, UdfRegistry, Volatility,
};
pub use engine_core::error::{EngineError, EngineResult};
pub use engine_core::model::schema::MODEL_FORMAT_VERSION;
pub use engine_core::model::{
    CalculatedColumn, Cardinality, ClearTarget, Column, ContextDefinition, ContextOp, DataModel,
    DataModelBuilder, DateRole, FilterPropagation, GlobalVariable, Hierarchy, HierarchyLevel,
    JoinCondition, JoinOperator, RaggedBehavior, RefreshStrategy, Relationship, StorageMode, Table,
    TableVariable,
};
pub use engine_core::optimize::{OptimizationStats, OptimizerConfig};
pub use engine_core::store::{ColumnStore, InMemoryCache, TableData};
pub use engine_core::types::{DataType, TableColumn, Value};

// --- Re-exports from engine-connectors ---

pub use engine_connectors::auth::{
    AuthMethod, AuthMethodKind, ConnectionSpec, ConnectionTarget, ConnectorAuth,
};
pub use engine_connectors::postgres::PostgresConnector;
pub use engine_connectors::sqlserver::SqlServerConnector;
pub use engine_connectors::traits::{
    AggregateExpr, AggregateFunction, Connector, FetchRequest, FilterCondition, FilterOperator,
    OrderByExpr, OrderByTarget, SourceTable,
};
pub use engine_connectors::{ConnectorError, ConnectorResult};

// --- Re-exports from engine-query ---

pub use engine_query::error::{QueryError, QueryResult};
pub use engine_query::registry::{AnyConnector, SourceBinding, SourceRegistry};
pub use engine_query::request::{
    ColumnRef, HierarchyGroupBy, LookupColumn, OrderByClause, OrderTarget, QueryRequest,
    TotalsMode, GROUPING_ID_COLUMN,
};
pub use engine_query::{
    effective_group_by, HierarchyLevelSpec, HierarchySpec, LookupSpec, PushdownPlanner,
    QueryExecutor, QueryPlan,
};

// ---------------------------------------------------------------------------

/// High-level engine facade coordinating model, sources, and queries.
///
/// The `Engine` owns a [`DataModel`], a [`SourceRegistry`], and an
/// [`InMemoryCache`] for tables configured with [`StorageMode::InMemory`].
/// Default threshold for inline IN-filter values before switching to temp tables.
const DEFAULT_MAX_INLINE_IN_VALUES: usize = 1000;

/// Maximum number of source fetches that run concurrently during bulk
/// refresh and auto-tier pre-warm operations. Bounded so that a model with
/// many tables does not open an unbounded number of simultaneous source
/// queries.
const MAX_CONCURRENT_FETCHES: usize = 4;

pub struct Engine {
    model: DataModel,
    registry: SourceRegistry,
    cache: InMemoryCache,
    /// Maximum number of IN-filter values to inline in SQL before switching
    /// to a temp-table strategy. Default: 1000.
    max_inline_in_values: usize,
    /// Configuration for automatic batch optimization on ingest.
    optimizer_config: OptimizerConfig,
    /// Configuration for automatic dimension caching.
    auto_tier_config: AutoTierConfig,
    /// Runtime state for auto-tiering (which tables are cached/rejected).
    /// Mutated only by `&mut self` paths ([`Engine::query_auto_tier`],
    /// [`Engine::auto_tier_remaining`]), so no interior mutability is needed.
    auto_tier_state: AutoTierState,
    /// LRU cache for query results.
    ///
    /// Behind a [`Mutex`] so the `&self` query paths can record hits and
    /// store results while the engine is shared across tasks
    /// (`Arc<Engine>`). Lock discipline: guards are held for synchronous
    /// cache operations only and are always dropped before any `.await`.
    query_cache: Mutex<query_cache::QueryCache>,
    /// Host policy for executing model-supplied `SourceQuery` poll SQL.
    source_query_policy: SourceQueryPolicy,
    /// Report from the most recent [`Engine::refresh_stale`] run.
    last_refresh_report: Option<RefreshReport>,
    /// Host-registered scalar UDFs (see [`Engine::register_udf`]). Shared
    /// with the query pipeline; rebuilt (copy-on-write) on registration.
    udfs: Arc<UdfRegistry>,
}

impl Engine {
    /// Create a new engine with the given data model.
    ///
    /// Uses the default memory budget (256 MB) for the in-memory cache.
    pub fn new(model: DataModel) -> Self {
        Self {
            model,
            registry: SourceRegistry::new(),
            cache: InMemoryCache::new(),
            max_inline_in_values: DEFAULT_MAX_INLINE_IN_VALUES,
            optimizer_config: OptimizerConfig::default(),
            auto_tier_config: AutoTierConfig::default(),
            auto_tier_state: AutoTierState::default(),
            query_cache: Mutex::new(query_cache::QueryCache::new(QueryCacheConfig::default())),
            source_query_policy: SourceQueryPolicy::default(),
            last_refresh_report: None,
            udfs: Arc::new(UdfRegistry::new()),
        }
    }

    /// Create a new engine with a custom memory budget for in-memory tables.
    pub fn with_memory_budget(model: DataModel, budget_bytes: usize) -> Self {
        Self {
            model,
            registry: SourceRegistry::new(),
            cache: InMemoryCache::with_budget(budget_bytes),
            max_inline_in_values: DEFAULT_MAX_INLINE_IN_VALUES,
            optimizer_config: OptimizerConfig::default(),
            auto_tier_config: AutoTierConfig::default(),
            auto_tier_state: AutoTierState::default(),
            query_cache: Mutex::new(query_cache::QueryCache::new(QueryCacheConfig::default())),
            source_query_policy: SourceQueryPolicy::default(),
            last_refresh_report: None,
            udfs: Arc::new(UdfRegistry::new()),
        }
    }

    /// Set a custom optimizer configuration for batch ingest.
    ///
    /// The optimizer runs automatically when tables are refreshed into
    /// the in-memory cache, applying type narrowing, dictionary encoding,
    /// and timestamp-to-date conversion.
    pub fn set_optimizer_config(&mut self, config: OptimizerConfig) {
        self.optimizer_config = config;
    }

    /// Returns the current optimizer configuration.
    pub fn optimizer_config(&self) -> &OptimizerConfig {
        &self.optimizer_config
    }

    /// Set the maximum number of IN-filter values to inline in SQL.
    ///
    /// When a relationship filter propagation produces more values than this
    /// threshold, the connector uses a server-side temp table instead of an
    /// inline `IN (...)` list. Default: 1000.
    pub fn set_max_inline_in_values(&mut self, max: usize) {
        self.max_inline_in_values = max;
    }

    /// Returns the current maximum inline IN-filter values threshold.
    pub fn max_inline_in_values(&self) -> usize {
        self.max_inline_in_values
    }

    /// Set the query-result cache configuration.
    ///
    /// When enabled, query results are cached and served from memory
    /// when the same query is re-executed within the TTL. The cache is
    /// invalidated on model changes and data refreshes.
    pub fn set_query_cache_config(&mut self, config: QueryCacheConfig) {
        self.query_cache.lock().set_config(config);
    }

    /// Returns the current query cache configuration.
    pub fn query_cache_config(&self) -> QueryCacheConfig {
        self.query_cache.lock().config().clone()
    }

    /// Returns query cache statistics (hits, misses, entries, memory usage).
    pub fn query_cache_stats(&self) -> QueryCacheStats {
        self.query_cache.lock().stats()
    }

    /// Clear all cached query results.
    ///
    /// Takes `&self`: the result cache uses interior mutability, so hosts
    /// holding the engine in an `Arc` can invalidate it without exclusive
    /// access. Queries running concurrently are unaffected (a result they
    /// store afterwards is keyed under the old cache version and can never
    /// be served).
    pub fn clear_query_cache(&self) {
        self.query_cache.lock().invalidate_all();
    }

    /// Register a PostgreSQL data source and return its connector index.
    ///
    /// The connection target (host, port, database) and authentication method
    /// are separate, enabling models to store only the target while auth
    /// resolves from the user's environment.
    pub async fn add_postgres(
        &mut self,
        target: ConnectionTarget,
        auth: AuthMethod,
    ) -> ConnectorResult<usize> {
        let connector = PostgresConnector::connect(target, auth).await?;
        let idx = self
            .registry
            .add_connector(AnyConnector::Postgres(connector));
        Ok(idx)
    }

    /// Register a SQL Server data source and return its connector index.
    ///
    /// See [`add_postgres`](Self::add_postgres) for rationale on the
    /// target/auth separation.
    pub async fn add_sqlserver(
        &mut self,
        target: ConnectionTarget,
        auth: AuthMethod,
    ) -> ConnectorResult<usize> {
        let connector = SqlServerConnector::connect(target, auth).await?;
        let idx = self
            .registry
            .add_connector(AnyConnector::SqlServer(connector));
        Ok(idx)
    }

    /// Register a host-provided scalar UDF, replacing any UDF with the same
    /// name.
    ///
    /// Measures and calculated columns may then call it by name:
    /// `SUM(pct_of(Sales[amount], Sales[total]))`. UDFs execute **locally
    /// only** — expressions calling them are never pushed down to data
    /// sources.
    ///
    /// Register UDFs **before** querying: [`Engine::query`] fails with
    /// [`EngineError::UnknownFunction`] when a requested measure calls an
    /// unregistered name.
    ///
    /// `version` is the host's cache-identity for the (opaque) function
    /// body: bump it whenever the function's behavior changes, so cached
    /// query results computed with the old behavior are not served.
    /// Registration always invalidates the query-result cache.
    ///
    /// UDF names must be lowercase (`[a-z_][a-z0-9_]{0,63}`) because
    /// DataFusion resolves unquoted SQL function identifiers in lowercase;
    /// measure text may spell calls in any case.
    ///
    /// # Examples
    ///
    /// ```
    /// use std::sync::Arc;
    ///
    /// use arrow::array::Float64Array;
    /// use arrow::datatypes::DataType as ArrowDataType;
    /// use bi_engine::{
    ///     create_udf, Column, ColumnarValue, DataModel, DataType, Engine, Table, Volatility,
    /// };
    ///
    /// # fn main() -> Result<(), Box<dyn std::error::Error>> {
    /// let model = DataModel::builder()
    ///     .add_table(Table::new(
    ///         "Sales",
    ///         vec![
    ///             Column::new("amount", DataType::Float64),
    ///             Column::new("total", DataType::Float64),
    ///         ],
    ///     )?)
    ///     .build()?;
    /// let mut engine = Engine::new(model);
    ///
    /// // pct_of(part, whole) = part / whole * 100, NULL-safe.
    /// let pct_of = create_udf(
    ///     "pct_of",
    ///     vec![ArrowDataType::Float64, ArrowDataType::Float64],
    ///     ArrowDataType::Float64,
    ///     Volatility::Immutable,
    ///     Arc::new(|args: &[ColumnarValue]| {
    ///         let arrays = ColumnarValue::values_to_arrays(args)?;
    ///         let part = arrays[0]
    ///             .as_any()
    ///             .downcast_ref::<Float64Array>()
    ///             .expect("Float64 enforced by the UDF signature");
    ///         let whole = arrays[1]
    ///             .as_any()
    ///             .downcast_ref::<Float64Array>()
    ///             .expect("Float64 enforced by the UDF signature");
    ///         let out: Float64Array = part
    ///             .iter()
    ///             .zip(whole.iter())
    ///             .map(|(p, w)| match (p, w) {
    ///                 (Some(p), Some(w)) if w != 0.0 => Some(p / w * 100.0),
    ///                 _ => None,
    ///             })
    ///             .collect();
    ///         Ok(ColumnarValue::Array(Arc::new(out)))
    ///     }),
    /// );
    /// engine.register_udf(pct_of, 1)?;
    ///
    /// // Measure text can now call it (in any case):
    /// let measure = bi_engine::parse_measure("SUM(PCT_OF(Sales[amount], Sales[total]))")?;
    /// assert_eq!(engine.registered_udfs(), vec!["pct_of".to_string()]);
    /// # let _ = measure;
    /// # Ok(())
    /// # }
    /// ```
    ///
    /// # Errors
    ///
    /// Returns [`EngineError::InvalidIdentifier`] when the UDF's name is not
    /// lowercase `[a-z_][a-z0-9_]{0,63}`.
    pub fn register_udf(&mut self, udf: ScalarUDF, version: u64) -> EngineResult<()> {
        let mut registry = (*self.udfs).clone();
        registry.register(udf, version)?;
        self.udfs = Arc::new(registry);
        // The new/replaced function may compute different values than
        // whatever produced the cached results; this also bumps the model
        // version that feeds the query-cache key.
        self.query_cache.lock().invalidate_all();
        Ok(())
    }

    /// Names of all registered UDFs, sorted.
    pub fn registered_udfs(&self) -> Vec<String> {
        self.udfs.names()
    }

    /// Verify that every UDF called by the request's measures is registered.
    ///
    /// Called by the query entry points before planning so an unregistered
    /// (or typo'd) function name fails fast with a clear
    /// [`EngineError::UnknownFunction`] instead of a DataFusion error
    /// mid-execution. Unknown measure names are skipped here — the planner
    /// reports those with its own error.
    pub(crate) fn validate_request_udfs(&self, request: &QueryRequest) -> QueryResult<()> {
        for measure_name in &request.measures {
            let Ok(measure) = self.model.measure(measure_name) else {
                continue;
            };
            // Measure references are expanded so calls inside referenced
            // measures are covered too. Expansion failures (e.g. a missing
            // reference) are reported by model validation / the planner.
            let expression = if expression::has_measure_ref(measure.expression()) {
                match expression::expand_measure_refs(measure.expression(), &self.model) {
                    Ok(expanded) => std::borrow::Cow::Owned(expanded),
                    Err(_) => continue,
                }
            } else {
                std::borrow::Cow::Borrowed(measure.expression())
            };
            for name in expression.call_names() {
                if self.udfs.get(name).is_none() {
                    return Err(QueryError::Engine(EngineError::UnknownFunction {
                        name: name.to_string(),
                        referenced_by: format!("measure '{measure_name}'"),
                    }));
                }
            }
        }
        Ok(())
    }

    /// Bind a model table name to a registered connector and source location.
    pub fn bind_table(
        &mut self,
        model_table: impl Into<String>,
        connector_index: usize,
        binding: SourceBinding,
    ) {
        self.registry.bind(model_table, connector_index, binding);
    }

    /// Execute a query against the model using registered data sources.
    ///
    /// The query planner decides what to push down and what to compute locally.
    /// Tables configured for in-memory storage are served from the cache.
    /// If query caching is enabled, repeated identical queries are served
    /// from the result cache.
    ///
    /// # Result ordering
    ///
    /// Results honor [`QueryRequest::order_by`] and [`QueryRequest::limit`].
    /// When `order_by` is empty and `group_by` is non-empty, rows are ordered
    /// by the group-by columns in declaration order (ascending), so grouped
    /// (pivot) output is always deterministic — previously row order was
    /// whatever the source or DataFusion happened to return. Dimension
    /// ordering respects each column's model-declared `sort_by_column` in the
    /// SQL-ordered execution paths (pushed single-table aggregation and local
    /// aggregation); see [`QueryRequest`] for details.
    ///
    /// # Totals (ROLLUP subtotals)
    ///
    /// When [`QueryRequest::totals`] is [`TotalsMode::Rollup`], the result
    /// contains the detail rows plus subtotal rows per group-by prefix and a
    /// grand total — all computed in **one** query (one fact-table
    /// scan/fetch; each subtotal level is recomputed at that level, so
    /// non-additive measures like DISTINCTCOUNT and AVG are correct). The
    /// result gains a trailing `Int32` column named [`GROUPING_ID_COLUMN`]
    /// (`"__grouping_id"`): a bitmask with bit `i` (LSB = `group_by[0]`) set
    /// when `group_by[i]` is rolled up in that row — `0` for detail rows,
    /// all bits set for the grand total. Subtotal `NULL` dimension values
    /// are thereby distinguishable from real `NULL`s. With an empty
    /// `group_by` the result is the single grand-total row with
    /// `__grouping_id` = 0. Ordering defaults are unchanged (subtotal rows
    /// sort after their group's detail rows under the default ascending
    /// group-by ordering); `limit` applies after subtotal rows are included.
    /// See [`TotalsMode`] for the unsupported query shapes (lookups, window
    /// measures, QUERY-in-VAR, multi-fact-table requests, unsafe group-by
    /// relationships), which return a typed error rather than wrong totals.
    ///
    /// # Hierarchy drill-down
    ///
    /// Set [`QueryRequest::hierarchy_group_by`] to group by the levels of a
    /// model-defined [`Hierarchy`]: the level columns (in drill order, up to
    /// the requested depth) are appended to `group_by` and behave like
    /// ordinary group-by columns from there — including for ROLLUP totals
    /// (each level becomes a drill subtotal) and default ordering. The
    /// hierarchy's [`RaggedBehavior`] is applied to the result; level cells
    /// equal to a level's `stopper_value` are treated as NULL-equivalent.
    /// See [`HierarchyGroupBy`] for depth semantics and validation rules.
    ///
    /// ```rust,no_run
    /// # use bi_engine::*;
    /// # async fn example(engine: Engine) -> Result<(), Box<dyn std::error::Error>> {
    /// // Drill two levels into the Geography hierarchy:
    /// // Revenue by country, state (state blanks per the model's RaggedBehavior).
    /// let batches = engine
    ///     .query(QueryRequest {
    ///         measures: vec!["Revenue".into()],
    ///         hierarchy_group_by: Some(HierarchyGroupBy::new("Geography", 2)),
    ///         ..Default::default()
    ///     })
    ///     .await?;
    /// # Ok(())
    /// # }
    /// ```
    ///
    /// # Concurrency
    ///
    /// Takes `&self`: the engine is `Send + Sync`, so hosts can share it as
    /// `Arc<Engine>` and run multiple queries concurrently. This and
    /// [`query_explained`](Self::query_explained) /
    /// [`query_with_cancellation`](Self::query_with_cancellation) are the
    /// concurrent-safe query paths; [`query_auto_refresh`](Self::query_auto_refresh)
    /// and [`query_auto_tier`](Self::query_auto_tier) mutate the in-memory
    /// table cache and therefore keep `&mut self`.
    pub async fn query(&self, request: QueryRequest) -> QueryResult<Vec<RecordBatch>> {
        self.query_with_cancellation(request, CancellationToken::new())
            .await
    }

    /// Execute a query that can be cancelled from another task.
    ///
    /// Like [`query`](Self::query), but stops with [`QueryError::Cancelled`]
    /// when `token` is cancelled. Cancellation is cooperative: the token is
    /// checked at execution phase boundaries (before fetches, before local
    /// registration, before each measure-evaluation block, before the final
    /// SQL) and raced against the long-lived awaits (connector fetches,
    /// DataFusion execution), so a slow DirectQuery fetch is abandoned
    /// promptly.
    ///
    /// # Limitation
    ///
    /// Cancelling drops the in-flight connector futures, which stops the
    /// client-side work — but the database server may continue executing an
    /// already-submitted statement to completion. Cancellation releases the
    /// caller; it does not guarantee the source stops working.
    ///
    /// ```rust,no_run
    /// # use std::sync::Arc;
    /// # use bi_engine::*;
    /// # async fn example(engine: Arc<Engine>, request: QueryRequest)
    /// # -> Result<(), Box<dyn std::error::Error>> {
    /// let token = CancellationToken::new();
    /// let cancel_handle = token.clone();
    /// let task = tokio::spawn({
    ///     let engine = Arc::clone(&engine);
    ///     async move { engine.query_with_cancellation(request, token).await }
    /// });
    /// // ... user navigates away:
    /// cancel_handle.cancel();
    /// assert!(matches!(task.await?, Err(QueryError::Cancelled)));
    /// # Ok(())
    /// # }
    /// ```
    pub async fn query_with_cancellation(
        &self,
        request: QueryRequest,
        token: CancellationToken,
    ) -> QueryResult<Vec<RecordBatch>> {
        // A pre-cancelled token never executes anything (not even a cache
        // lookup) — the caller already walked away from the result.
        if token.is_cancelled() {
            return Err(QueryError::Cancelled);
        }

        // Fail fast (with a clear error) on unregistered UDF calls.
        self.validate_request_udfs(&request)?;

        // Check the query cache first. The guard is dropped before any
        // await: key computation and lookup are synchronous.
        let (cache_key, cache_version, cached) = {
            let mut query_cache = self.query_cache.lock();
            let version = query_cache.model_version();
            let key = query_cache::query_cache_key(&request, version, self.udfs.identity_hash());
            let cached = query_cache.get(key);
            (key, version, cached)
        };
        if let Some(cached) = cached {
            return Ok(cached);
        }

        let plan = PushdownPlanner::plan(&request, &self.model, &self.registry)?;
        let batches = QueryExecutor::execute_with_cancellation(
            &plan,
            &self.model,
            &self.registry,
            Some(&self.cache),
            Some(self.max_inline_in_values),
            Some(self.udfs.as_ref()),
            &token,
        )
        .await?;

        // Store the result unless the cache version moved while executing
        // (a concurrent `clear_query_cache`): a stale-keyed entry could
        // never be served, but skipping it avoids dead weight in the LRU.
        {
            let mut query_cache = self.query_cache.lock();
            if query_cache.model_version() == cache_version {
                query_cache.put(cache_key, batches.clone());
            }
        }
        Ok(batches)
    }

    /// Execute a query, automatically refreshing any stale in-memory tables first.
    ///
    /// This is equivalent to calling [`Engine::refresh_stale`] followed by
    /// [`Engine::query`]. Tables whose cached data has exceeded their configured
    /// `refresh_interval` are re-fetched from their source before the query runs.
    ///
    /// Returns both the query results and the list of tables that were
    /// refreshed. The query proceeds even when some refreshes failed; the
    /// full [`RefreshReport`] (including failures) is available via
    /// [`Engine::last_refresh_report`].
    ///
    /// Takes `&mut self` because the refresh step replaces in-memory table
    /// data; [`query`](Self::query) is the concurrent-safe (`&self`) path.
    pub async fn query_auto_refresh(
        &mut self,
        request: QueryRequest,
    ) -> QueryResult<(Vec<RecordBatch>, Vec<String>)> {
        self.validate_request_udfs(&request)?;

        let refreshed = self
            .refresh_stale()
            .await
            .map_err(crate::QueryError::Engine)?
            .refreshed;

        // Check query cache (after refresh — stale data was already
        // invalidated). The guard is dropped before any await.
        let (cache_key, cached) = {
            let mut query_cache = self.query_cache.lock();
            let key = query_cache::query_cache_key(
                &request,
                query_cache.model_version(),
                self.udfs.identity_hash(),
            );
            let cached = query_cache.get(key);
            (key, cached)
        };
        if let Some(cached) = cached {
            return Ok((cached, refreshed));
        }

        let plan = PushdownPlanner::plan(&request, &self.model, &self.registry)?;
        let batches = QueryExecutor::execute(
            &plan,
            &self.model,
            &self.registry,
            Some(&self.cache),
            Some(self.max_inline_in_values),
            Some(self.udfs.as_ref()),
        )
        .await?;

        self.query_cache.lock().put(cache_key, batches.clone());
        Ok((batches, refreshed))
    }

    /// Execute a query and return results with an execution plan.
    ///
    /// Like [`Engine::query`], but also returns an [`ExecutionPlan`] describing
    /// each phase of execution with timing and decision metadata.
    pub async fn query_explained(
        &self,
        request: QueryRequest,
    ) -> QueryResult<(Vec<RecordBatch>, ExecutionPlan)> {
        self.validate_request_udfs(&request)?;

        let start = Instant::now();

        let (query_plan, pushdown_node) =
            PushdownPlanner::plan_explained(&request, &self.model, &self.registry)?;
        let (batches, exec_node) = QueryExecutor::execute_explained(
            &query_plan,
            &self.model,
            &self.registry,
            Some(&self.cache),
            Some(self.max_inline_in_values),
            Some(self.udfs.as_ref()),
        )
        .await?;

        let total_duration = start.elapsed();

        // Build summary.
        let measures_str = request.measures.join(", ");
        let summary = if request.group_by.is_empty() {
            format!("Query: [{measures_str}]")
        } else {
            let dims: Vec<String> = request
                .group_by
                .iter()
                .map(|c| format!("{}.{}", c.table, c.column))
                .collect();
            format!("Query: [{measures_str}] grouped by [{}]", dims.join(", "))
        };

        let root = PlanNode::new(PlanOperation::Planning, "Query Execution")
            .with_duration(total_duration)
            .with_child(pushdown_node)
            .with_child(exec_node);

        let plan = ExecutionPlan {
            summary,
            total_duration: total_duration.into(),
            root,
        };

        Ok((batches, plan))
    }

    /// Returns a reference to the in-memory cache for inspection.
    pub fn cache(&self) -> &InMemoryCache {
        &self.cache
    }

    /// Replace the data model, keeping the source registry and cache intact.
    ///
    /// Existing table bindings remain valid as long as the new model contains
    /// the same table names. Cached in-memory tables are preserved.
    pub fn set_model(&mut self, model: DataModel) {
        self.model = model;
        self.query_cache.lock().invalidate_all();
    }

    /// Returns a reference to the data model.
    pub fn model(&self) -> &DataModel {
        &self.model
    }

    /// Returns a reference to the source registry.
    pub fn registry(&self) -> &SourceRegistry {
        &self.registry
    }

    /// Returns a mutable reference to the source registry.
    pub fn registry_mut(&mut self) -> &mut SourceRegistry {
        &mut self.registry
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use arrow::array::Float64Array;
    use arrow::datatypes::DataType as ArrowDataType;

    use crate::test_fixtures::make_test_batch;
    use crate::{
        create_udf, parse_measure, sum_measure, CancellationToken, Column, ColumnarValue,
        DataModel, DataType, Engine, EngineError, Measure, QueryError, QueryRequest, ScalarUDF,
        SourceBinding, StorageMode, Table, Volatility,
    };

    #[test]
    fn engine_new_creates_empty_registry() {
        let model = DataModel::builder()
            .add_table(Table::new("Sales", vec![Column::new("amount", DataType::Float64)]).unwrap())
            .build()
            .unwrap();

        let engine = Engine::new(model);
        assert_eq!(engine.model().tables().len(), 1);
        assert!(!engine.registry().has_table("Sales"));
    }

    // --- UDF registration and query-time validation ---

    /// `double(x) = x * 2` over Float64.
    fn double_udf() -> ScalarUDF {
        create_udf(
            "double",
            vec![ArrowDataType::Float64],
            ArrowDataType::Float64,
            Volatility::Immutable,
            Arc::new(|args: &[ColumnarValue]| {
                let arrays = ColumnarValue::values_to_arrays(args)?;
                let input = arrays[0]
                    .as_any()
                    .downcast_ref::<Float64Array>()
                    .expect("Float64 enforced by the UDF signature");
                let out: Float64Array = input.iter().map(|v| v.map(|x| x * 2.0)).collect();
                Ok(ColumnarValue::Array(Arc::new(out)))
            }),
        )
    }

    /// Model with measure `Doubled = SUM(double(Sales[amount]))`.
    fn model_with_udf_measure() -> DataModel {
        DataModel::builder()
            .add_table(Table::new("Sales", vec![Column::new("amount", DataType::Float64)]).unwrap())
            .add_measure(Measure::new(
                "Doubled",
                parse_measure("SUM(double(Sales[amount]))").unwrap(),
            ))
            .build()
            .unwrap()
    }

    #[test]
    fn register_udf_lists_and_replaces() {
        let mut engine = Engine::new(model_with_udf_measure());
        assert!(engine.registered_udfs().is_empty());

        engine.register_udf(double_udf(), 1).unwrap();
        assert_eq!(engine.registered_udfs(), vec!["double".to_string()]);

        // Same name re-registers (replaces), no duplicate.
        engine.register_udf(double_udf(), 2).unwrap();
        assert_eq!(engine.registered_udfs(), vec!["double".to_string()]);
    }

    #[test]
    fn register_udf_rejects_invalid_name() {
        let mut engine = Engine::new(model_with_udf_measure());
        let bad = create_udf(
            "Bad Name",
            vec![],
            ArrowDataType::Float64,
            Volatility::Immutable,
            Arc::new(|_| {
                Ok(ColumnarValue::Array(Arc::new(Float64Array::from(
                    Vec::<f64>::new(),
                ))))
            }),
        );
        assert!(matches!(
            engine.register_udf(bad, 1),
            Err(EngineError::InvalidIdentifier { .. })
        ));
    }

    #[tokio::test]
    async fn query_with_unregistered_udf_fails_with_clear_error() {
        let engine = Engine::new(model_with_udf_measure());

        let err = engine
            .query(QueryRequest {
                measures: vec!["Doubled".into()],
                ..Default::default()
            })
            .await
            .unwrap_err();

        match err {
            QueryError::Engine(EngineError::UnknownFunction {
                name,
                referenced_by,
            }) => {
                assert_eq!(name, "double");
                assert!(referenced_by.contains("Doubled"));
            }
            other => panic!("expected UnknownFunction, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn query_after_registration_passes_udf_validation() {
        let mut engine = Engine::new(model_with_udf_measure());
        engine.register_udf(double_udf(), 1).unwrap();

        // UDF validation passes; the query then fails on the (intentionally)
        // missing source binding — NOT on the function name.
        let err = engine
            .query(QueryRequest {
                measures: vec!["Doubled".into()],
                ..Default::default()
            })
            .await
            .unwrap_err();
        assert!(
            matches!(err, QueryError::SourceNotRegistered(_)),
            "expected SourceNotRegistered, got {err:?}"
        );
    }

    #[test]
    fn register_udf_changes_cache_identity_and_bumps_model_version() {
        let mut engine = Engine::new(model_with_udf_measure());
        let hash0 = engine.udfs.identity_hash();
        let version0 = engine.query_cache.lock().model_version();

        engine.register_udf(double_udf(), 1).unwrap();
        let hash1 = engine.udfs.identity_hash();
        assert_ne!(hash0, hash1, "registering a UDF must change the identity");
        assert!(
            engine.query_cache.lock().model_version() > version0,
            "registration must invalidate the query cache"
        );

        // Re-registering with a bumped version changes the identity again —
        // and with it every query-cache key.
        engine.register_udf(double_udf(), 2).unwrap();
        let hash2 = engine.udfs.identity_hash();
        assert_ne!(hash1, hash2);

        let request = QueryRequest {
            measures: vec!["Doubled".into()],
            ..Default::default()
        };
        assert_ne!(
            crate::query_cache::query_cache_key(&request, 0, hash1),
            crate::query_cache::query_cache_key(&request, 0, hash2),
            "query-cache key must change when the UDF version changes"
        );
    }

    // --- Concurrency and cancellation ---

    /// Engine over one in-memory table (`Products`, served from the cache —
    /// no connector registered) with `TotalPrice = SUM(Products[price])`.
    /// Prices: 9.99 + 19.99 + 29.99 = 59.97.
    fn make_concurrent_engine() -> Engine {
        let model = DataModel::builder()
            .add_table(
                Table::new(
                    "Products",
                    vec![
                        Column::new("id", DataType::Int64),
                        Column::new("price", DataType::Float64),
                    ],
                )
                .unwrap()
                .with_storage_mode(StorageMode::InMemory),
            )
            .add_measure(sum_measure("TotalPrice", "Products", "price"))
            .build()
            .unwrap();

        let mut engine = Engine::new(model);
        // Bind so the planner accepts the table; the in-memory cache serves
        // the data, so the (nonexistent) connector is never contacted.
        engine.bind_table("Products", 0, SourceBinding::new("public", "products"));
        engine.cache.store("Products", make_test_batch()).unwrap();
        engine
    }

    fn total_price_request() -> QueryRequest {
        QueryRequest {
            measures: vec!["TotalPrice".into()],
            ..Default::default()
        }
    }

    /// Extract the single scalar result of a `TotalPrice` query.
    fn scalar_total(batches: &[arrow::record_batch::RecordBatch]) -> f64 {
        batches[0]
            .column(0)
            .as_any()
            .downcast_ref::<Float64Array>()
            .expect("TotalPrice is Float64")
            .value(0)
    }

    #[test]
    fn engine_is_send_and_sync() {
        // Compile-time assertion: `query(&self)` is only useful across tasks
        // if the engine can be shared (`Arc<Engine>`) between threads.
        fn assert_send_sync<T: Send + Sync>() {}
        assert_send_sync::<Engine>();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn concurrent_queries_through_shared_engine() {
        let engine = Arc::new(make_concurrent_engine());

        let first = tokio::spawn({
            let engine = Arc::clone(&engine);
            async move { engine.query(total_price_request()).await }
        });
        let second = tokio::spawn({
            let engine = Arc::clone(&engine);
            async move { engine.query(total_price_request()).await }
        });

        let first = first.await.unwrap().unwrap();
        let second = second.await.unwrap().unwrap();
        assert!((scalar_total(&first) - 59.97).abs() < 1e-9);
        assert!((scalar_total(&second) - 59.97).abs() < 1e-9);
    }

    #[tokio::test]
    async fn pre_cancelled_token_returns_cancelled_without_executing() {
        let engine = make_concurrent_engine();

        let token = CancellationToken::new();
        token.cancel();
        let err = engine
            .query_with_cancellation(total_price_request(), token)
            .await
            .unwrap_err();

        // The in-memory model would produce a successful result if execution
        // had proceeded (and no connector exists to fetch from), so a
        // `Cancelled` error proves the query stopped before doing any work.
        assert!(matches!(err, QueryError::Cancelled), "got: {err:?}");
    }

    #[tokio::test]
    async fn query_with_cancellation_uncancelled_token_completes() {
        let engine = make_concurrent_engine();

        let batches = engine
            .query_with_cancellation(total_price_request(), CancellationToken::new())
            .await
            .unwrap();
        assert!((scalar_total(&batches) - 59.97).abs() < 1e-9);
    }
}
