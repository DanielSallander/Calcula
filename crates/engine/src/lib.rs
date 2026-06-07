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
//! use engine::*;
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
//!     group_by: vec![],
//!     filters: vec![],
//!     lookups: vec![],
//! }).await?;
//! # Ok(())
//! # }
//! ```

mod query_cache;

use std::collections::HashSet;
use std::path::Path;
use std::time::{Duration, Instant};

use arrow::record_batch::RecordBatch;

pub use query_cache::{QueryCacheConfig, QueryCacheStats};

// --- Re-exports from engine-core ---

pub use engine_core::catalog::{function_catalog, FunctionInfo};
pub use engine_core::compute::aggregate::AggregateOp;
pub use engine_core::compute::context::{
    ContextResolver, EvaluationContext, FilterSource, ResolvedFilter, ResolvedInFilter,
};
pub use engine_core::compute::expression::{
    self, expand_global_variables, infer_fact_table, ArithmeticOp, ComparisonOp, Expression,
    FilterPredicate, InPredicate, RelationshipPath,
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
pub use engine_core::error::{EngineError, EngineResult};
pub use engine_core::model::{
    CalculatedColumn, Cardinality, ClearTarget, Column, ContextDefinition, ContextOp, DataModel,
    DataModelBuilder, FilterPropagation, GlobalVariable, JoinCondition, JoinOperator,
    RefreshStrategy, Relationship, StorageMode, Table, TableVariable,
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
    SourceTable,
};
pub use engine_connectors::{ConnectorError, ConnectorResult};

// --- Re-exports from engine-query ---

pub use engine_query::error::{QueryError, QueryResult};
pub use engine_query::registry::{AnyConnector, SourceBinding, SourceRegistry};
pub use engine_query::request::{ColumnRef, LookupColumn, QueryRequest};
pub use engine_query::{LookupSpec, PushdownPlanner, QueryExecutor, QueryPlan};

// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Auto-tier configuration and state
// ---------------------------------------------------------------------------

/// Configuration for automatic dimension table caching.
///
/// When enabled, the engine automatically caches dimension tables (the "one"
/// side of many-to-one relationships) that are below a configurable row count
/// threshold. This happens lazily on first query, and remaining eligible
/// tables are pre-warmed in the background after the query returns.
///
/// Tables with explicit [`StorageMode::InMemory`] or [`StorageMode::DirectQuery`]
/// set by the user are never affected by auto-tiering.
#[derive(Debug, Clone)]
pub struct AutoTierConfig {
    /// Enable or disable auto-tiering entirely. Default: `false`.
    pub enabled: bool,
    /// Maximum row count for a table to qualify for auto-tiering. Default: 100,000.
    pub max_rows: usize,
    /// TTL in seconds before auto-tiered data is considered stale and
    /// re-fetched. Default: 3600 (1 hour).
    pub default_ttl_secs: u64,
}

impl Default for AutoTierConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            max_rows: 100_000,
            default_ttl_secs: 3600,
        }
    }
}

/// Tracks auto-tier state for the engine.
#[derive(Debug, Default)]
struct AutoTierState {
    /// Tables that have been auto-tiered (successfully cached).
    cached: HashSet<String>,
    /// Tables that were checked and rejected (too large). Not re-checked
    /// until the engine is restarted or the model changes.
    rejected: HashSet<String>,
}

/// High-level engine facade coordinating model, sources, and queries.
///
/// The `Engine` owns a [`DataModel`], a [`SourceRegistry`], and an
/// [`InMemoryCache`] for tables configured with [`StorageMode::InMemory`].
/// Default threshold for inline IN-filter values before switching to temp tables.
const DEFAULT_MAX_INLINE_IN_VALUES: usize = 1000;

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
    auto_tier_state: AutoTierState,
    /// LRU cache for query results.
    query_cache: query_cache::QueryCache,
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
            query_cache: query_cache::QueryCache::new(QueryCacheConfig::default()),
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
            query_cache: query_cache::QueryCache::new(QueryCacheConfig::default()),
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

    /// Set the auto-tier configuration for automatic dimension caching.
    ///
    /// When enabled, dimension tables (the "one" side of many-to-one
    /// relationships) are automatically cached when first needed by a query,
    /// provided they are below the configured row threshold. Remaining
    /// eligible tables are pre-warmed in the background after the query
    /// completes.
    pub fn set_auto_tier_config(&mut self, config: AutoTierConfig) {
        self.auto_tier_config = config;
    }

    /// Returns the current auto-tier configuration.
    pub fn auto_tier_config(&self) -> &AutoTierConfig {
        &self.auto_tier_config
    }

    /// Returns the names of tables that have been auto-tiered (cached
    /// automatically as dimension tables).
    pub fn auto_tiered_tables(&self) -> Vec<&str> {
        self.auto_tier_state
            .cached
            .iter()
            .map(|s| s.as_str())
            .collect()
    }

    /// Returns the names of tables that were evaluated for auto-tiering
    /// but rejected (too many rows).
    pub fn auto_tier_rejected_tables(&self) -> Vec<&str> {
        self.auto_tier_state
            .rejected
            .iter()
            .map(|s| s.as_str())
            .collect()
    }

    /// Set the query-result cache configuration.
    ///
    /// When enabled, query results are cached and served from memory
    /// when the same query is re-executed within the TTL. The cache is
    /// invalidated on model changes and data refreshes.
    pub fn set_query_cache_config(&mut self, config: QueryCacheConfig) {
        self.query_cache.set_config(config);
    }

    /// Returns the current query cache configuration.
    pub fn query_cache_config(&self) -> &QueryCacheConfig {
        self.query_cache.config()
    }

    /// Returns query cache statistics (hits, misses, entries, memory usage).
    pub fn query_cache_stats(&self) -> QueryCacheStats {
        self.query_cache.stats()
    }

    /// Clear all cached query results.
    pub fn clear_query_cache(&mut self) {
        self.query_cache.invalidate_all();
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
    pub async fn query(&mut self, request: QueryRequest) -> QueryResult<Vec<RecordBatch>> {
        // Check the query cache first.
        let cache_key = query_cache::query_cache_key(&request, self.query_cache.model_version());
        if let Some(cached) = self.query_cache.get(cache_key) {
            return Ok(cached);
        }

        let plan = PushdownPlanner::plan(&request, &self.model, &self.registry)?;
        let batches = QueryExecutor::execute(
            &plan,
            &self.model,
            &self.registry,
            Some(&self.cache),
            Some(self.max_inline_in_values),
        )
        .await?;

        self.query_cache.put(cache_key, batches.clone());
        Ok(batches)
    }

    /// Execute a query, automatically refreshing any stale in-memory tables first.
    ///
    /// This is equivalent to calling [`Engine::refresh_stale`] followed by
    /// [`Engine::query`]. Tables whose cached data has exceeded their configured
    /// `refresh_interval` are re-fetched from their source before the query runs.
    ///
    /// Returns both the query results and the list of tables that were refreshed.
    pub async fn query_auto_refresh(
        &mut self,
        request: QueryRequest,
    ) -> QueryResult<(Vec<RecordBatch>, Vec<String>)> {
        let refreshed = self
            .refresh_stale()
            .await
            .map_err(crate::QueryError::Engine)?;

        // Check query cache (after refresh — stale data was already invalidated).
        let cache_key = query_cache::query_cache_key(&request, self.query_cache.model_version());
        if let Some(cached) = self.query_cache.get(cache_key) {
            return Ok((cached, refreshed));
        }

        let plan = PushdownPlanner::plan(&request, &self.model, &self.registry)?;
        let batches = QueryExecutor::execute(
            &plan,
            &self.model,
            &self.registry,
            Some(&self.cache),
            Some(self.max_inline_in_values),
        )
        .await?;

        self.query_cache.put(cache_key, batches.clone());
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
        let start = Instant::now();

        let (query_plan, pushdown_node) =
            PushdownPlanner::plan_explained(&request, &self.model, &self.registry)?;
        let (batches, exec_node) = QueryExecutor::execute_explained(
            &query_plan,
            &self.model,
            &self.registry,
            Some(&self.cache),
            Some(self.max_inline_in_values),
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

    /// Refresh an in-memory table by fetching all data from its source connector.
    ///
    /// Returns an error if the table is not configured for `InMemory` storage,
    /// has no registered source, or if the fetched data would exceed the memory
    /// budget.
    pub async fn refresh_table(&mut self, table_name: &str) -> EngineResult<()> {
        self.refresh_table_inner(table_name).await.map(|_| ())
    }

    /// Refresh an in-memory table and return optimization statistics.
    ///
    /// Like [`refresh_table`](Self::refresh_table), but also returns details
    /// about what the batch optimizer did (columns narrowed, dictionary-encoded,
    /// bytes saved). Useful for diagnostics and monitoring.
    pub async fn refresh_table_explained(
        &mut self,
        table_name: &str,
    ) -> EngineResult<OptimizationStats> {
        self.refresh_table_inner(table_name).await
    }

    async fn refresh_table_inner(&mut self, table_name: &str) -> EngineResult<OptimizationStats> {
        let table = self.model.table(table_name)?;
        if !table.is_in_memory() {
            return Err(EngineError::TableNotInMemory(table_name.to_string()));
        }

        let binding = self
            .registry
            .binding_for(table_name)
            .map_err(|e| EngineError::InvalidData(e.to_string()))?;
        let request = FetchRequest {
            schema: Some(binding.schema.clone()),
            table: binding.table.clone(),
            ..Default::default()
        };
        let connector = self
            .registry
            .connector_for(table_name)
            .map_err(|e| EngineError::InvalidData(e.to_string()))?;
        let batches = connector
            .fetch_data(&request)
            .await
            .map_err(|e| EngineError::InvalidData(e.to_string()))?;

        if batches.is_empty() {
            let schema = std::sync::Arc::new(table.to_arrow_schema());
            let batch = RecordBatch::new_empty(schema);
            self.cache.store(table_name, batch)?;
            self.query_cache.invalidate_all();
            Ok(OptimizationStats::default())
        } else {
            let schema = batches[0].schema();
            let combined = arrow::compute::concat_batches(&schema, &batches)?;
            let (optimized, stats) =
                engine_core::optimize::optimize_batch(&combined, &self.optimizer_config)?;
            // Sort by the table's primary join key for better join/filter locality.
            let sorted = if let Some(sort_col) =
                engine_core::optimize::infer_sort_column(table_name, self.model.relationships())
            {
                engine_core::optimize::sort_batch_by_column(&optimized, sort_col)?
            } else {
                optimized
            };
            self.cache.store(table_name, sorted)?;
            self.query_cache.invalidate_all();
            Ok(stats)
        }
    }

    /// Refresh all tables configured for in-memory storage.
    pub async fn refresh_all_in_memory(&mut self) -> EngineResult<()> {
        let table_names: Vec<String> = self
            .model
            .tables()
            .iter()
            .filter(|t| t.is_in_memory())
            .map(|t| t.name().to_string())
            .collect();
        for name in table_names {
            self.refresh_table(&name).await?;
        }
        Ok(())
    }

    /// Refresh all in-memory tables whose configured refresh strategies
    /// indicate staleness.
    ///
    /// For each in-memory table, its [`RefreshStrategy`] list is evaluated
    /// against the cache. If **any** strategy signals staleness, the table
    /// is refreshed. [`SourceQuery`](RefreshStrategy::SourceQuery) strategies
    /// are evaluated by running the configured SQL against the source and
    /// comparing the result with the stored fingerprint.
    ///
    /// Tables without strategies are only refreshed if they have never been
    /// cached.
    ///
    /// Returns the names of tables that were refreshed.
    pub async fn refresh_stale(&mut self) -> EngineResult<Vec<String>> {
        // Collect in-memory tables with their staleness info.
        let candidates: Vec<(String, bool, Vec<RefreshStrategy>)> = self
            .model
            .tables()
            .iter()
            .filter(|t| t.is_in_memory())
            .map(|t| {
                let strategies = t.refresh_strategies();
                let locally_stale = if strategies.is_empty() {
                    !self.cache.contains(t.name())
                } else {
                    self.cache.should_refresh(t.name(), strategies)
                };
                let io_strategies: Vec<RefreshStrategy> =
                    t.io_refresh_strategies().into_iter().cloned().collect();
                (t.name().to_string(), locally_stale, io_strategies)
            })
            .collect();

        let mut stale_tables = Vec::new();

        for (table_name, locally_stale, io_strategies) in &candidates {
            if *locally_stale {
                stale_tables.push(table_name.clone());
                continue;
            }

            // Evaluate SourceQuery strategies (requires I/O).
            for strategy in io_strategies {
                if let RefreshStrategy::SourceQuery { sql, source_table } = strategy {
                    let connector_table = source_table.as_deref().unwrap_or(table_name);
                    match self.poll_source_query(connector_table, sql).await {
                        Ok(new_fingerprint) => {
                            let old_fingerprint = self.cache.fingerprint(table_name);
                            if old_fingerprint.is_none_or(|old| old != new_fingerprint) {
                                // Fingerprint changed (or first poll) → refresh.
                                stale_tables.push(table_name.clone());
                                // Store the new fingerprint after refresh.
                                self.cache.set_fingerprint(table_name, new_fingerprint);
                                break; // No need to check more strategies.
                            }
                        }
                        Err(_) => {
                            // Poll failed — skip this strategy, don't force refresh.
                            continue;
                        }
                    }
                }
            }
        }

        for name in &stale_tables {
            self.refresh_table(name).await?;
        }
        Ok(stale_tables)
    }

    /// Run a `SourceQuery` poll SQL against a connector and return the scalar
    /// result as a string.
    async fn poll_source_query(&self, connector_table: &str, sql: &str) -> EngineResult<String> {
        let connector = self
            .registry
            .connector_for(connector_table)
            .map_err(|e| EngineError::InvalidData(e.to_string()))?;
        let batches = connector
            .execute_query(sql)
            .await
            .map_err(|e| EngineError::InvalidData(e.to_string()))?;

        // Extract the first column of the first row as a string.
        let batch = batches
            .first()
            .ok_or_else(|| EngineError::InvalidData("poll query returned no results".into()))?;
        if batch.num_rows() == 0 || batch.num_columns() == 0 {
            return Err(EngineError::InvalidData(
                "poll query returned no rows or columns".into(),
            ));
        }

        let col = batch.column(0);
        let value = arrow::util::display::array_value_to_string(col, 0)
            .map_err(|e| EngineError::InvalidData(format!("poll result conversion failed: {e}")))?;
        Ok(value)
    }

    // --- Auto-tier implementation ---

    /// Identify dimension tables eligible for auto-tiering.
    ///
    /// A table is eligible if:
    /// - It appears as the "to" (one/dimension) side of a `ManyToOne` relationship
    /// - It does NOT have an explicit `StorageMode::InMemory` (already cached)
    /// - It has not been rejected previously (too many rows)
    /// - It has not already been auto-tiered
    /// - It has a registered source binding
    fn auto_tier_candidates(&self) -> Vec<String> {
        if !self.auto_tier_config.enabled {
            return Vec::new();
        }

        let mut candidates = Vec::new();
        let mut dimension_tables: HashSet<&str> = HashSet::new();

        // Find all "to" tables in ManyToOne relationships.
        for rel in self.model.relationships() {
            if rel.cardinality() == Cardinality::ManyToOne {
                dimension_tables.insert(rel.to_table());
            }
        }

        for dim_name in dimension_tables {
            // Skip if already explicitly InMemory.
            if let Ok(table) = self.model.table(dim_name) {
                if table.is_in_memory() {
                    continue;
                }
            }
            // Skip if already auto-tiered or rejected.
            if self.auto_tier_state.cached.contains(dim_name) {
                continue;
            }
            if self.auto_tier_state.rejected.contains(dim_name) {
                continue;
            }
            // Skip if no source binding registered.
            if self.registry.binding_for(dim_name).is_err() {
                continue;
            }
            candidates.push(dim_name.to_string());
        }

        candidates
    }

    /// Try to auto-tier a single table: fetch it, check row count, cache if eligible.
    ///
    /// Returns `true` if the table was cached, `false` if rejected (too many rows).
    async fn try_auto_tier_table(&mut self, table_name: &str) -> EngineResult<bool> {
        let binding = self
            .registry
            .binding_for(table_name)
            .map_err(|e| EngineError::InvalidData(e.to_string()))?;
        let request = FetchRequest {
            schema: Some(binding.schema.clone()),
            table: binding.table.clone(),
            limit: Some(self.auto_tier_config.max_rows + 1),
            ..Default::default()
        };
        let connector = self
            .registry
            .connector_for(table_name)
            .map_err(|e| EngineError::InvalidData(e.to_string()))?;
        let batches = connector
            .fetch_data(&request)
            .await
            .map_err(|e| EngineError::InvalidData(e.to_string()))?;

        let total_rows: usize = batches.iter().map(|b| b.num_rows()).sum();

        if total_rows > self.auto_tier_config.max_rows {
            self.auto_tier_state.rejected.insert(table_name.to_string());
            return Ok(false);
        }

        // Table qualifies — optimize, sort, and cache it.
        if batches.is_empty() {
            let table = self.model.table(table_name)?;
            let schema = std::sync::Arc::new(table.to_arrow_schema());
            let batch = RecordBatch::new_empty(schema);
            self.cache.store(table_name, batch)?;
        } else {
            let schema = batches[0].schema();
            let combined = arrow::compute::concat_batches(&schema, &batches)?;
            let (optimized, _) =
                engine_core::optimize::optimize_batch(&combined, &self.optimizer_config)?;
            let sorted = if let Some(sort_col) =
                engine_core::optimize::infer_sort_column(table_name, self.model.relationships())
            {
                engine_core::optimize::sort_batch_by_column(&optimized, sort_col)?
            } else {
                optimized
            };
            self.cache.store(table_name, sorted)?;
        }

        self.auto_tier_state.cached.insert(table_name.to_string());
        self.query_cache.invalidate_all();
        Ok(true)
    }

    /// Auto-tier tables that are needed by a specific query.
    ///
    /// Identifies which dimension tables in the query's group_by or filter
    /// context are auto-tier candidates, and caches them before execution.
    /// Returns the names of tables that were auto-tiered.
    async fn auto_tier_for_query(&mut self, request: &QueryRequest) -> EngineResult<Vec<String>> {
        if !self.auto_tier_config.enabled {
            return Ok(Vec::new());
        }

        let candidates = self.auto_tier_candidates();
        if candidates.is_empty() {
            return Ok(Vec::new());
        }

        // Determine which candidates are touched by this query.
        let query_tables: HashSet<&str> = request
            .group_by
            .iter()
            .map(|col| col.table.as_str())
            .collect();

        let mut tiered = Vec::new();
        for candidate in &candidates {
            if query_tables.contains(candidate.as_str())
                && self.try_auto_tier_table(candidate).await?
            {
                tiered.push(candidate.clone());
            }
        }
        Ok(tiered)
    }

    /// Cache all remaining eligible dimension tables.
    ///
    /// Call this after the first query returns to pre-warm the cache in the
    /// background. The host app can spawn this as a background task:
    ///
    /// ```rust,ignore
    /// let results = engine.query_auto_tier(request).await?;
    /// // Fire-and-forget background pre-warm:
    /// tokio::spawn(async move { engine.auto_tier_remaining().await });
    /// ```
    ///
    /// Returns the names of tables that were successfully cached.
    pub async fn auto_tier_remaining(&mut self) -> EngineResult<Vec<String>> {
        if !self.auto_tier_config.enabled {
            return Ok(Vec::new());
        }

        let candidates = self.auto_tier_candidates();
        let mut tiered = Vec::new();
        for candidate in candidates {
            match self.try_auto_tier_table(&candidate).await {
                Ok(true) => tiered.push(candidate),
                Ok(false) => {} // Rejected (too large).
                Err(_) => {}    // Fetch failed — skip, will retry next time.
            }
        }
        Ok(tiered)
    }

    /// Execute a query with automatic dimension caching.
    ///
    /// Before executing the query, checks if any dimension tables needed by the
    /// query are eligible for auto-tiering and caches them. After the query
    /// completes, remaining eligible dimensions are pre-warmed in the background.
    ///
    /// Returns the query results and the list of tables that were auto-tiered
    /// (both during the query and in the background pre-warm).
    pub async fn query_auto_tier(
        &mut self,
        request: QueryRequest,
    ) -> QueryResult<(Vec<RecordBatch>, Vec<String>)> {
        // Phase 1: Auto-tier tables needed by this specific query.
        let mut tiered = self
            .auto_tier_for_query(&request)
            .await
            .map_err(QueryError::Engine)?;

        // Also refresh stale auto-tiered tables.
        self.refresh_stale_auto_tiered()
            .await
            .map_err(QueryError::Engine)?;

        // Check query cache.
        let cache_key = query_cache::query_cache_key(&request, self.query_cache.model_version());
        if let Some(cached) = self.query_cache.get(cache_key) {
            // Still pre-warm remaining in background.
            if let Ok(more) = self.auto_tier_remaining().await {
                tiered.extend(more);
            }
            return Ok((cached, tiered));
        }

        // Execute the query — tell the planner that auto-tiered tables are local.
        let plan = PushdownPlanner::plan_with_cached(
            &request,
            &self.model,
            &self.registry,
            &self.auto_tier_state.cached,
        )?;
        let batches = QueryExecutor::execute(
            &plan,
            &self.model,
            &self.registry,
            Some(&self.cache),
            Some(self.max_inline_in_values),
        )
        .await?;

        self.query_cache.put(cache_key, batches.clone());

        // Phase 2: Pre-warm remaining candidates.
        if let Ok(more) = self.auto_tier_remaining().await {
            tiered.extend(more);
        }

        Ok((batches, tiered))
    }

    /// Refresh auto-tiered tables that have exceeded their TTL.
    async fn refresh_stale_auto_tiered(&mut self) -> EngineResult<()> {
        let ttl = Duration::from_secs(self.auto_tier_config.default_ttl_secs);
        let stale: Vec<String> = self
            .auto_tier_state
            .cached
            .iter()
            .filter(|name| self.cache.is_stale(name, ttl))
            .cloned()
            .collect();

        for name in stale {
            // Re-fetch and re-cache. If it fails or is now too large, remove from auto-tier.
            match self.try_auto_tier_table(&name).await {
                Ok(true) => {} // Still cached.
                Ok(false) => {
                    // Grew beyond threshold — evict and reject.
                    self.cache.evict(&name);
                    self.auto_tier_state.cached.remove(&name);
                }
                Err(_) => {
                    // Fetch failed — leave stale data in cache for now.
                }
            }
        }
        Ok(())
    }

    /// Returns when the table was last refreshed, if it is cached.
    pub fn last_refreshed(&self, table_name: &str) -> Option<std::time::Instant> {
        self.cache.last_refreshed(table_name)
    }

    /// Returns `true` if the table's cache is older than `max_age` or not yet
    /// cached.
    pub fn needs_refresh(&self, table_name: &str, max_age: std::time::Duration) -> bool {
        self.cache.is_stale(table_name, max_age)
    }

    /// Returns `true` if the table should be refreshed according to its
    /// local (non-I/O) strategies.
    ///
    /// `SourceQuery` strategies are not evaluated here (they require async
    /// I/O). Use [`refresh_stale`](Self::refresh_stale) for full evaluation.
    pub fn needs_refresh_by_strategy(&self, table_name: &str) -> bool {
        match self.model.table(table_name) {
            Ok(t) if t.is_in_memory() => {
                let strategies = t.refresh_strategies();
                if strategies.is_empty() {
                    !self.cache.contains(table_name)
                } else {
                    self.cache.should_refresh(table_name, strategies)
                }
            }
            _ => false,
        }
    }

    /// Returns a reference to the in-memory cache for inspection.
    pub fn cache(&self) -> &InMemoryCache {
        &self.cache
    }

    /// Save all cached in-memory table data to disk.
    ///
    /// Writes each cached table as an Arrow IPC file plus a `metadata.json`
    /// containing `last_refreshed` ages and schema hashes. The host app
    /// should call this on shutdown (or periodically) so that
    /// [`load_cache_from_disk`](Self::load_cache_from_disk) can restore the
    /// cache on next startup without re-fetching from the source.
    ///
    /// The `dir` must already exist; the method creates files inside it.
    pub fn save_cache_to_disk(&self, dir: &Path) -> EngineResult<()> {
        use arrow::ipc::writer::{FileWriter, IpcWriteOptions};
        use arrow::ipc::CompressionType;
        use serde_json::{json, Map};

        let mut tables_meta = Map::new();

        // Use Zstd compression for disk cache files.
        let write_options = IpcWriteOptions::default()
            .try_with_compression(Some(CompressionType::ZSTD))
            .map_err(|e| EngineError::InvalidData(format!("IPC compression init failed: {e}")))?;

        for table_name in self.cache.table_names() {
            // Only persist tables that are in the model and marked InMemory.
            let table = match self.model.table(table_name) {
                Ok(t) if t.is_in_memory() => t,
                _ => continue,
            };

            let batch = match self.cache.get(table_name) {
                Some(b) => b,
                None => continue,
            };

            // Write Zstd-compressed Arrow IPC file.
            let file_path = dir.join(format!("{table_name}.arrow"));
            let file = std::fs::File::create(&file_path).map_err(|e| {
                EngineError::InvalidData(format!(
                    "failed to create cache file '{}': {e}",
                    file_path.display()
                ))
            })?;
            let mut writer =
                FileWriter::try_new_with_options(file, &batch.schema(), write_options.clone())
                    .map_err(|e| {
                        EngineError::InvalidData(format!("Arrow IPC writer init failed: {e}"))
                    })?;
            writer
                .write(batch)
                .map_err(|e| EngineError::InvalidData(format!("Arrow IPC write failed: {e}")))?;
            writer
                .finish()
                .map_err(|e| EngineError::InvalidData(format!("Arrow IPC finish failed: {e}")))?;

            // Record metadata: age in milliseconds, schema hash, and fingerprint.
            let age_ms = self
                .cache
                .age(table_name)
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);
            let fingerprint = self.cache.fingerprint(table_name);

            tables_meta.insert(
                table_name.to_string(),
                json!({
                    "age_ms": age_ms,
                    "schema_hash": table.schema_hash(),
                    "row_count": batch.num_rows(),
                    "fingerprint": fingerprint,
                }),
            );
        }

        // Write metadata.json.
        let meta = json!({ "tables": tables_meta });
        let meta_path = dir.join("metadata.json");
        let meta_json = serde_json::to_string_pretty(&meta)
            .map_err(|e| EngineError::InvalidData(format!("metadata serialization failed: {e}")))?;
        std::fs::write(&meta_path, meta_json).map_err(|e| {
            EngineError::InvalidData(format!(
                "failed to write metadata '{}': {e}",
                meta_path.display()
            ))
        })?;

        Ok(())
    }

    /// Restore cached in-memory table data from disk.
    ///
    /// Reads Arrow IPC files and `metadata.json` previously written by
    /// [`save_cache_to_disk`](Self::save_cache_to_disk). For each table:
    ///
    /// - If the table is no longer in the model or not `InMemory`, it is skipped.
    /// - If the schema hash differs from the current model, the file is skipped
    ///   (the table will be re-fetched on next refresh).
    /// - Otherwise the data is loaded into the cache with its original age so
    ///   that TTL-based staleness checks remain accurate.
    ///
    /// Returns the names of tables that were successfully loaded.
    pub fn load_cache_from_disk(&mut self, dir: &Path) -> EngineResult<Vec<String>> {
        use arrow::ipc::reader::FileReader;

        let meta_path = dir.join("metadata.json");
        if !meta_path.exists() {
            return Ok(Vec::new());
        }

        let meta_json = std::fs::read_to_string(&meta_path).map_err(|e| {
            EngineError::InvalidData(format!(
                "failed to read metadata '{}': {e}",
                meta_path.display()
            ))
        })?;
        let meta: serde_json::Value = serde_json::from_str(&meta_json)
            .map_err(|e| EngineError::InvalidData(format!("metadata parse failed: {e}")))?;

        let tables_meta = match meta.get("tables").and_then(|v| v.as_object()) {
            Some(m) => m,
            None => return Ok(Vec::new()),
        };

        let mut loaded = Vec::new();

        for (table_name, entry_meta) in tables_meta {
            // Check the table still exists in the model and is InMemory.
            let table = match self.model.table(table_name) {
                Ok(t) if t.is_in_memory() => t,
                _ => continue,
            };

            // Validate schema hash.
            let stored_hash = entry_meta
                .get("schema_hash")
                .and_then(|v| v.as_str())
                .unwrap_or("");
            if stored_hash != table.schema_hash() {
                continue; // Schema changed — skip, will be re-fetched.
            }

            // Read Arrow IPC file.
            let file_path = dir.join(format!("{table_name}.arrow"));
            if !file_path.exists() {
                continue;
            }

            let file = std::fs::File::open(&file_path).map_err(|e| {
                EngineError::InvalidData(format!(
                    "failed to open cache file '{}': {e}",
                    file_path.display()
                ))
            })?;
            let reader = FileReader::try_new(file, None).map_err(|e| {
                EngineError::InvalidData(format!(
                    "Arrow IPC read failed for '{}': {e}",
                    file_path.display()
                ))
            })?;

            let schema = reader.schema();
            let batches: Vec<RecordBatch> = reader
                .into_iter()
                .collect::<Result<Vec<_>, _>>()
                .map_err(|e| {
                    EngineError::InvalidData(format!(
                        "Arrow IPC batch read failed for '{table_name}': {e}"
                    ))
                })?;

            let batch = if batches.is_empty() {
                RecordBatch::new_empty(schema)
            } else {
                arrow::compute::concat_batches(&schema, &batches)?
            };

            // Restore with original age.
            let age_ms = entry_meta
                .get("age_ms")
                .and_then(|v| v.as_u64())
                .unwrap_or(0);
            let age = std::time::Duration::from_millis(age_ms);

            self.cache.store_with_age(table_name, batch, age)?;

            // Restore fingerprint if present.
            if let Some(fp) = entry_meta.get("fingerprint").and_then(|v| v.as_str()) {
                self.cache.set_fingerprint(table_name, fp.to_string());
            }

            loaded.push(table_name.clone());
        }

        Ok(loaded)
    }

    /// Replace the data model, keeping the source registry and cache intact.
    ///
    /// Existing table bindings remain valid as long as the new model contains
    /// the same table names. Cached in-memory tables are preserved.
    pub fn set_model(&mut self, model: DataModel) {
        self.model = model;
        self.query_cache.invalidate_all();
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

    /// Save the data model to a JSON file.
    pub fn save_model(&self, path: &Path) -> EngineResult<()> {
        let json = serde_json::to_string_pretty(&self.model)
            .map_err(|e| EngineError::InvalidData(format!("JSON serialization failed: {e}")))?;
        std::fs::write(path, json)
            .map_err(|e| EngineError::InvalidData(format!("failed to write file: {e}")))?;
        Ok(())
    }

    /// Load a data model from a JSON file.
    ///
    /// Validates the model after loading. Returns an error if the file
    /// cannot be read, the JSON is invalid, or the model fails validation.
    pub fn load_model(path: &Path) -> EngineResult<DataModel> {
        let json = std::fs::read_to_string(path)
            .map_err(|e| EngineError::InvalidData(format!("failed to read file: {e}")))?;
        let model: DataModel = serde_json::from_str(&json)
            .map_err(|e| EngineError::InvalidData(format!("JSON parse failed: {e}")))?;
        model.validate()?;
        Ok(model)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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

    #[test]
    fn save_and_load_model_roundtrip() {
        let model = DataModel::builder()
            .add_table(
                Table::new(
                    "Sales",
                    vec![
                        Column::new("id", DataType::Int64),
                        Column::new("amount", DataType::Float64),
                    ],
                )
                .unwrap(),
            )
            .add_measure(sum_measure("Revenue", "Sales", "amount"))
            .build()
            .unwrap();

        let engine = Engine::new(model);

        let dir = std::env::temp_dir();
        let path = dir.join("calcula_engine_test_model.json");
        engine.save_model(&path).unwrap();

        let loaded = Engine::load_model(&path).unwrap();
        assert_eq!(loaded.tables().len(), 1);
        assert_eq!(loaded.measures().len(), 1);
        assert_eq!(loaded.measures()[0].name(), "Revenue");

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn load_model_validates() {
        let dir = std::env::temp_dir();
        let path = dir.join("calcula_engine_test_invalid.json");

        // Write invalid JSON (relationship to missing table).
        let json = r#"{
            "tables": [],
            "relationships": [{
                "name": "Bad",
                "from_table": "Missing",
                "from_column": "id",
                "to_table": "Also_Missing",
                "to_column": "id",
                "cardinality": "ManyToOne"
            }],
            "measures": [],
            "calculated_columns": [],
            "measure_groups": []
        }"#;
        std::fs::write(&path, json).unwrap();

        let result = Engine::load_model(&path);
        assert!(result.is_err());

        let _ = std::fs::remove_file(&path);
    }

    // -- Disk cache tests --

    use arrow::array::{Float64Array, Int64Array};
    use arrow::datatypes::{DataType as ArrowDataType, Field, Schema as ArrowSchema};
    use std::sync::Arc;

    fn make_inmemory_model() -> DataModel {
        DataModel::builder()
            .add_table(
                Table::new(
                    "Products",
                    vec![
                        Column::new("id", DataType::Int64),
                        Column::new("price", DataType::Float64),
                    ],
                )
                .unwrap()
                .with_storage_mode(StorageMode::InMemory)
                .with_refresh_interval(std::time::Duration::from_secs(300)),
            )
            .build()
            .unwrap()
    }

    fn make_test_batch() -> RecordBatch {
        let schema = Arc::new(ArrowSchema::new(vec![
            Field::new("id", ArrowDataType::Int64, true),
            Field::new("price", ArrowDataType::Float64, true),
        ]));
        RecordBatch::try_new(
            schema,
            vec![
                Arc::new(Int64Array::from(vec![1, 2, 3])),
                Arc::new(Float64Array::from(vec![9.99, 19.99, 29.99])),
            ],
        )
        .unwrap()
    }

    fn make_cache_dir(test_name: &str) -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("calcula_cache_test_{test_name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn save_and_load_cache_roundtrip() {
        let dir = make_cache_dir("roundtrip");
        let model = make_inmemory_model();

        // Save.
        let mut engine = Engine::new(model.clone());
        engine.cache.store("Products", make_test_batch()).unwrap();
        engine.save_cache_to_disk(&dir).unwrap();

        // Verify files exist.
        assert!(dir.join("Products.arrow").exists());
        assert!(dir.join("metadata.json").exists());

        // Load into a fresh engine.
        let mut engine2 = Engine::new(model);
        let loaded = engine2.load_cache_from_disk(&dir).unwrap();
        assert_eq!(loaded, vec!["Products"]);

        let cached = engine2.cache().get("Products").unwrap();
        assert_eq!(cached.num_rows(), 3);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn load_cache_preserves_age() {
        let dir = make_cache_dir("age");
        let model = make_inmemory_model();

        // Store with a known age.
        let mut engine = Engine::new(model.clone());
        engine
            .cache
            .store_with_age(
                "Products",
                make_test_batch(),
                std::time::Duration::from_secs(200),
            )
            .unwrap();
        engine.save_cache_to_disk(&dir).unwrap();

        // Load and check the age is preserved (approximately).
        let mut engine2 = Engine::new(model);
        engine2.load_cache_from_disk(&dir).unwrap();

        let age = engine2.cache().age("Products").unwrap();
        // Should be ~200s (allow small margin for test execution time).
        assert!(age >= std::time::Duration::from_secs(199));

        // With 300s TTL and 200s age, should not be stale yet.
        assert!(!engine2.needs_refresh("Products", std::time::Duration::from_secs(300)));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn load_cache_skips_schema_mismatch() {
        let dir = make_cache_dir("schema_mismatch");

        // Save with original schema.
        let model_v1 = make_inmemory_model();
        let mut engine = Engine::new(model_v1);
        engine.cache.store("Products", make_test_batch()).unwrap();
        engine.save_cache_to_disk(&dir).unwrap();

        // Create model v2 with a different column.
        let model_v2 = DataModel::builder()
            .add_table(
                Table::new(
                    "Products",
                    vec![
                        Column::new("id", DataType::Int64),
                        Column::new("cost", DataType::Float64), // was "price"
                    ],
                )
                .unwrap()
                .with_storage_mode(StorageMode::InMemory),
            )
            .build()
            .unwrap();

        let mut engine2 = Engine::new(model_v2);
        let loaded = engine2.load_cache_from_disk(&dir).unwrap();
        // Should skip — schema hash mismatch.
        assert!(loaded.is_empty());
        assert!(engine2.cache().get("Products").is_none());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn load_cache_skips_direct_query_tables() {
        let dir = make_cache_dir("direct_query");

        // Save with InMemory mode.
        let model_im = make_inmemory_model();
        let mut engine = Engine::new(model_im);
        engine.cache.store("Products", make_test_batch()).unwrap();
        engine.save_cache_to_disk(&dir).unwrap();

        // Load with DirectQuery mode (table is no longer InMemory).
        let model_dq = DataModel::builder()
            .add_table(
                Table::new(
                    "Products",
                    vec![
                        Column::new("id", DataType::Int64),
                        Column::new("price", DataType::Float64),
                    ],
                )
                .unwrap(), // default: DirectQuery
            )
            .build()
            .unwrap();

        let mut engine2 = Engine::new(model_dq);
        let loaded = engine2.load_cache_from_disk(&dir).unwrap();
        assert!(loaded.is_empty());

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn load_cache_returns_empty_for_missing_dir() {
        let model = make_inmemory_model();
        let mut engine = Engine::new(model);
        let loaded = engine
            .load_cache_from_disk(Path::new("/nonexistent/path"))
            .unwrap();
        assert!(loaded.is_empty());
    }

    #[test]
    fn save_cache_only_persists_inmemory_tables() {
        let dir = make_cache_dir("only_inmemory");

        let model = DataModel::builder()
            .add_table(
                Table::new("InMem", vec![Column::new("id", DataType::Int64)])
                    .unwrap()
                    .with_storage_mode(StorageMode::InMemory),
            )
            .add_table(Table::new("Direct", vec![Column::new("id", DataType::Int64)]).unwrap())
            .build()
            .unwrap();

        let mut engine = Engine::new(model);

        let schema = Arc::new(ArrowSchema::new(vec![Field::new(
            "id",
            ArrowDataType::Int64,
            true,
        )]));
        let batch =
            RecordBatch::try_new(schema, vec![Arc::new(Int64Array::from(vec![1]))]).unwrap();
        engine.cache.store("InMem", batch.clone()).unwrap();
        engine.cache.store("Direct", batch).unwrap();

        engine.save_cache_to_disk(&dir).unwrap();

        // Only InMem should have an arrow file.
        assert!(dir.join("InMem.arrow").exists());
        assert!(!dir.join("Direct.arrow").exists());

        let _ = std::fs::remove_dir_all(&dir);
    }

    // -- Auto-tier tests --

    fn make_star_schema_model() -> DataModel {
        DataModel::builder()
            .add_table(
                Table::new(
                    "fact_sales",
                    vec![
                        Column::new("id", DataType::Int64),
                        Column::new("product_id", DataType::Int64),
                        Column::new("customer_id", DataType::Int64),
                        Column::new("amount", DataType::Float64),
                    ],
                )
                .unwrap(),
            )
            .add_table(
                Table::new(
                    "dim_products",
                    vec![
                        Column::new("id", DataType::Int64),
                        Column::new("name", DataType::String),
                    ],
                )
                .unwrap(),
            )
            .add_table(
                Table::new(
                    "dim_customers",
                    vec![
                        Column::new("id", DataType::Int64),
                        Column::new("name", DataType::String),
                    ],
                )
                .unwrap(),
            )
            .add_relationship(Relationship::many_to_one(
                "sales_products",
                "fact_sales",
                "product_id",
                "dim_products",
                "id",
            ))
            .add_relationship(Relationship::many_to_one(
                "sales_customers",
                "fact_sales",
                "customer_id",
                "dim_customers",
                "id",
            ))
            .add_measure(sum_measure("Revenue", "fact_sales", "amount"))
            .build()
            .unwrap()
    }

    #[test]
    fn auto_tier_candidates_disabled_returns_empty() {
        let model = make_star_schema_model();
        let engine = Engine::new(model);
        // Disabled by default.
        assert!(engine.auto_tier_candidates().is_empty());
    }

    #[test]
    fn auto_tier_candidates_finds_dimension_tables() {
        let model = make_star_schema_model();
        let mut engine = Engine::new(model);
        engine.set_auto_tier_config(AutoTierConfig {
            enabled: true,
            max_rows: 100_000,
            default_ttl_secs: 3600,
        });
        // No bindings registered → no candidates (need source binding).
        assert!(engine.auto_tier_candidates().is_empty());

        // Register bindings for dims.
        engine
            .registry
            .bind("dim_products", 0, SourceBinding::new("public", "products"));
        engine.registry.bind(
            "dim_customers",
            0,
            SourceBinding::new("public", "customers"),
        );

        let mut candidates = engine.auto_tier_candidates();
        candidates.sort();
        assert_eq!(candidates, vec!["dim_customers", "dim_products"]);
    }

    #[test]
    fn auto_tier_candidates_skips_explicit_inmemory() {
        let model = DataModel::builder()
            .add_table(
                Table::new(
                    "fact_sales",
                    vec![
                        Column::new("product_id", DataType::Int64),
                        Column::new("amount", DataType::Float64),
                    ],
                )
                .unwrap(),
            )
            .add_table(
                Table::new("dim_products", vec![Column::new("id", DataType::Int64)])
                    .unwrap()
                    .with_storage_mode(StorageMode::InMemory),
            )
            .add_relationship(Relationship::many_to_one(
                "sales_products",
                "fact_sales",
                "product_id",
                "dim_products",
                "id",
            ))
            .add_measure(sum_measure("Revenue", "fact_sales", "amount"))
            .build()
            .unwrap();

        let mut engine = Engine::new(model);
        engine.set_auto_tier_config(AutoTierConfig {
            enabled: true,
            ..Default::default()
        });
        engine
            .registry
            .bind("dim_products", 0, SourceBinding::new("public", "products"));

        // Already InMemory → not a candidate.
        assert!(engine.auto_tier_candidates().is_empty());
    }

    #[test]
    fn auto_tier_candidates_skips_rejected() {
        let model = make_star_schema_model();
        let mut engine = Engine::new(model);
        engine.set_auto_tier_config(AutoTierConfig {
            enabled: true,
            ..Default::default()
        });
        engine
            .registry
            .bind("dim_products", 0, SourceBinding::new("public", "products"));

        // Mark as rejected.
        engine
            .auto_tier_state
            .rejected
            .insert("dim_products".to_string());

        assert!(engine.auto_tier_candidates().is_empty());
    }

    #[test]
    fn auto_tier_candidates_skips_already_cached() {
        let model = make_star_schema_model();
        let mut engine = Engine::new(model);
        engine.set_auto_tier_config(AutoTierConfig {
            enabled: true,
            ..Default::default()
        });
        engine
            .registry
            .bind("dim_products", 0, SourceBinding::new("public", "products"));

        // Mark as already cached.
        engine
            .auto_tier_state
            .cached
            .insert("dim_products".to_string());

        assert!(engine.auto_tier_candidates().is_empty());
    }

    #[test]
    fn auto_tiered_tables_returns_cached_set() {
        let model = make_star_schema_model();
        let mut engine = Engine::new(model);
        engine.set_auto_tier_config(AutoTierConfig {
            enabled: true,
            ..Default::default()
        });

        assert!(engine.auto_tiered_tables().is_empty());

        engine
            .auto_tier_state
            .cached
            .insert("dim_products".to_string());
        assert_eq!(engine.auto_tiered_tables(), vec!["dim_products"]);
    }

    #[test]
    fn auto_tier_rejected_tables_returns_rejected_set() {
        let model = make_star_schema_model();
        let mut engine = Engine::new(model);

        engine
            .auto_tier_state
            .rejected
            .insert("big_table".to_string());
        assert_eq!(engine.auto_tier_rejected_tables(), vec!["big_table"]);
    }

    #[test]
    fn auto_tier_config_defaults() {
        let config = AutoTierConfig::default();
        assert!(!config.enabled);
        assert_eq!(config.max_rows, 100_000);
        assert_eq!(config.default_ttl_secs, 3600);
    }
}
