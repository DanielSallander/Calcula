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
//!     group_by: vec![],
//!     filters: vec![],
//!     lookups: vec![],
//! }).await?;
//! # Ok(())
//! # }
//! ```

mod query_cache;

use std::collections::{BTreeMap, HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use arrow::record_batch::RecordBatch;
use serde::{Deserialize, Serialize};

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
    DataModelBuilder, FilterPropagation, GlobalVariable, Hierarchy, HierarchyLevel, JoinCondition,
    JoinOperator, RaggedBehavior, RefreshStrategy, Relationship, StorageMode, Table, TableVariable,
};
pub use engine_core::model::schema::MODEL_FORMAT_VERSION;
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
// Source-query policy and refresh reporting
// ---------------------------------------------------------------------------

/// Host policy controlling whether model-supplied `SourceQuery` poll SQL may
/// be executed against connectors.
///
/// Model files are shared between users and must be treated as untrusted
/// input. A [`RefreshStrategy::SourceQuery`] embeds SQL in the model file
/// that the engine runs against a registered connector when polling for
/// staleness — on SQL Server such SQL executes as a raw T-SQL batch, so an
/// unvalidated model could carry multi-statement payloads.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
pub enum SourceQueryPolicy {
    /// Never execute model-supplied SQL. `SourceQuery` strategies are
    /// skipped during [`Engine::refresh_stale`] and recorded as poll
    /// failures in the [`RefreshReport`] (not a hard error).
    Disabled,
    /// Execute model-supplied SQL only after validating that it parses as a
    /// single SELECT statement (including CTE-wrapped selects). DML, DDL,
    /// and multi-statement batches are rejected. This is the default: it
    /// preserves legitimate ETL polling while neutering injection payloads.
    #[default]
    ValidatedSelectOnly,
}

/// Outcome of [`Engine::refresh_stale`]: which tables were refreshed and
/// which poll/refresh operations failed.
///
/// A failure on one table never aborts the refresh of the others; all
/// failures are accumulated here. The most recent report is also retained on
/// the engine and accessible via [`Engine::last_refresh_report`].
#[derive(Debug, Clone, Default)]
pub struct RefreshReport {
    /// Names of tables that were successfully refreshed.
    pub refreshed: Vec<String>,
    /// Failures encountered while polling staleness or refreshing tables.
    pub failures: Vec<RefreshFailure>,
}

/// A single failed staleness poll or table refresh.
#[derive(Debug, Clone)]
pub struct RefreshFailure {
    /// The model table the failure relates to.
    pub table: String,
    /// Human-readable description of what failed.
    pub detail: String,
}

// ---------------------------------------------------------------------------
// Disk-cache metadata
// ---------------------------------------------------------------------------

/// Schema of the disk-cache `metadata.json` written by
/// [`Engine::save_cache_to_disk`].
///
/// `saved_at_unix_ms` records the wall-clock save time so that downtime
/// between save and load counts toward each entry's age (otherwise week-old
/// data would look minutes old after a restart and defeat every TTL
/// strategy). Files written before this field existed deserialize with
/// `None` and are treated as saved at load time — i.e. the previous
/// behavior, which is the only sound interpretation available for them.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct CacheMetadata {
    /// Wall-clock save time in milliseconds since the Unix epoch.
    #[serde(default)]
    saved_at_unix_ms: Option<u64>,
    /// Per-table cache metadata, keyed by table name.
    #[serde(default)]
    tables: BTreeMap<String, TableCacheMetadata>,
}

/// Per-table entry in the disk-cache `metadata.json`.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct TableCacheMetadata {
    /// Age of the cached data at save time, in milliseconds. `u64::MAX`
    /// marks an entry that was already maximally stale when saved.
    #[serde(default)]
    age_ms: u64,
    /// Schema hash of the table at save time (see `Table::schema_hash`).
    #[serde(default)]
    schema_hash: String,
    /// Number of rows in the saved batch (diagnostic only).
    #[serde(default)]
    row_count: u64,
    /// Legacy single-slot `SourceQuery` fingerprint written by older engine
    /// versions. Read for backward compatibility, never written.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    fingerprint: Option<String>,
    /// Per-strategy `SourceQuery` fingerprints, keyed by the decimal string
    /// form of [`InMemoryCache::source_query_key`].
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    fingerprints: BTreeMap<String, String>,
    /// Name of the Arrow IPC file inside the cache directory, derived via
    /// [`cache_file_name`] at save time. Stored so that load uses the exact
    /// mapping instead of re-deriving it. Metadata written by older engine
    /// versions lacks this field (empty string); load then falls back to the
    /// legacy `{table_name}.arrow` name, subject to the same containment
    /// check as every other path.
    #[serde(default)]
    file: String,
}

/// Current wall-clock time as milliseconds since the Unix epoch.
///
/// Returns 0 if the system clock reports a time before the epoch (the
/// resulting age inflation only makes caches *more* eager to refresh).
fn now_unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(duration_to_millis_clamped)
        .unwrap_or(0)
}

/// Convert a [`Duration`] to whole milliseconds, clamping to `u64::MAX`
/// instead of truncating on overflow.
fn duration_to_millis_clamped(duration: Duration) -> u64 {
    u64::try_from(duration.as_millis()).unwrap_or(u64::MAX)
}

/// FNV-1a 64-bit hash.
///
/// Implemented locally (instead of `std::hash::DefaultHasher`) because the
/// resulting hex digest is embedded in cache file names that persist on
/// disk across engine upgrades, and `DefaultHasher`'s algorithm is
/// explicitly not guaranteed to be stable across Rust releases.
fn fnv1a_64(bytes: &[u8]) -> u64 {
    const FNV_OFFSET_BASIS: u64 = 0xcbf2_9ce4_8422_2325;
    const FNV_PRIME: u64 = 0x0000_0100_0000_01b3;
    let mut hash = FNV_OFFSET_BASIS;
    for &byte in bytes {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(FNV_PRIME);
    }
    hash
}

/// Maximum length of the sanitized (human-readable) part of a cache file name.
const CACHE_FILE_NAME_MAX_SANITIZED_CHARS: usize = 64;

/// Derive a filesystem-safe Arrow IPC file name for a cached table.
///
/// The name is `{sanitized}_{hash8}.arrow`, where `sanitized` is the table
/// name with every character outside `[A-Za-z0-9_-]` replaced by `_`
/// (truncated to [`CACHE_FILE_NAME_MAX_SANITIZED_CHARS`] characters) and
/// `hash8` is the first 8 hex characters of an FNV-1a hash of the full
/// original name. The hash keeps distinct table names distinct even when
/// they sanitize to the same string (e.g. `Sales/2024` vs `Sales 2024`),
/// and the sanitization guarantees the result is a single, portable path
/// component — a hostile table name like `..\..\evil` cannot escape the
/// cache directory.
fn cache_file_name(table_name: &str) -> String {
    let sanitized: String = table_name
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '_' || c == '-' {
                c
            } else {
                '_'
            }
        })
        .take(CACHE_FILE_NAME_MAX_SANITIZED_CHARS)
        .collect();
    let hash_hex = format!("{:016x}", fnv1a_64(table_name.as_bytes()));
    format!("{sanitized}_{}.arrow", &hash_hex[..8])
}

/// Join `file_name` onto the cache directory, verifying it cannot escape.
///
/// `file_name` must be a single normal path component (no separators, no
/// `..`/root/drive components — on Windows an absolute `Path::join` argument
/// *replaces* the base path entirely). As a belt-and-braces check, the
/// joined path's parent must canonicalize to the canonicalized cache
/// directory itself; the directory is canonicalized rather than the file so
/// that not-yet-written files are handled.
fn safe_cache_path(dir: &Path, file_name: &str) -> EngineResult<PathBuf> {
    use std::path::Component;

    let escape_err = || {
        EngineError::InvalidData(format!(
            "cache file name '{file_name}' would escape the cache directory"
        ))
    };

    let mut components = Path::new(file_name).components();
    let single_normal = matches!(components.next(), Some(Component::Normal(_)));
    if !single_normal || components.next().is_some() {
        return Err(escape_err());
    }

    let joined = dir.join(file_name);
    let canonical_dir = dir.canonicalize().map_err(|e| {
        EngineError::InvalidData(format!(
            "failed to canonicalize cache directory '{}': {e}",
            dir.display()
        ))
    })?;
    let canonical_parent = joined
        .parent()
        .ok_or_else(escape_err)?
        .canonicalize()
        .map_err(|_| escape_err())?;
    if canonical_parent != canonical_dir {
        return Err(escape_err());
    }

    Ok(joined)
}

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
    /// Host policy for executing model-supplied `SourceQuery` poll SQL.
    source_query_policy: SourceQueryPolicy,
    /// Report from the most recent [`Engine::refresh_stale`] run.
    last_refresh_report: Option<RefreshReport>,
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
            source_query_policy: SourceQueryPolicy::default(),
            last_refresh_report: None,
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
            source_query_policy: SourceQueryPolicy::default(),
            last_refresh_report: None,
        }
    }

    /// Set the host policy for executing model-supplied `SourceQuery` poll SQL.
    ///
    /// Defaults to [`SourceQueryPolicy::ValidatedSelectOnly`]. Hosts that
    /// never want model files to trigger SQL execution should set
    /// [`SourceQueryPolicy::Disabled`].
    pub fn set_source_query_policy(&mut self, policy: SourceQueryPolicy) {
        self.source_query_policy = policy;
    }

    /// Returns the current source-query policy.
    pub fn source_query_policy(&self) -> SourceQueryPolicy {
        self.source_query_policy
    }

    /// Returns the report from the most recent
    /// [`refresh_stale`](Self::refresh_stale) run (including runs triggered
    /// by [`query_auto_refresh`](Self::query_auto_refresh)), if any.
    ///
    /// Use this to inspect poll/refresh failures after `query_auto_refresh`,
    /// which proceeds with the query even when some refreshes failed.
    pub fn last_refresh_report(&self) -> Option<&RefreshReport> {
        self.last_refresh_report.as_ref()
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
    /// Returns both the query results and the list of tables that were
    /// refreshed. The query proceeds even when some refreshes failed; the
    /// full [`RefreshReport`] (including failures) is available via
    /// [`Engine::last_refresh_report`].
    pub async fn query_auto_refresh(
        &mut self,
        request: QueryRequest,
    ) -> QueryResult<(Vec<RecordBatch>, Vec<String>)> {
        let refreshed = self
            .refresh_stale()
            .await
            .map_err(crate::QueryError::Engine)?
            .refreshed;

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
    /// A failure on one table (poll error, rejected SQL, refresh error) never
    /// aborts the refresh of the remaining tables: failures are accumulated
    /// in the returned [`RefreshReport`], which is also retained on the
    /// engine (see [`last_refresh_report`](Self::last_refresh_report)). A
    /// table's poll fingerprint is committed only **after** its refresh
    /// succeeds, so a failed refresh stays detectably stale.
    ///
    /// `SourceQuery` SQL is validated before execution (single SELECT
    /// statement only) and is skipped entirely — recorded as a poll failure —
    /// when the policy is [`SourceQueryPolicy::Disabled`].
    pub async fn refresh_stale(&mut self) -> EngineResult<RefreshReport> {
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

        let mut report = RefreshReport::default();
        let mut stale_tables: Vec<String> = Vec::new();
        // Fingerprints observed while polling, committed only after the
        // corresponding table refresh succeeds.
        let mut pending_fingerprints: HashMap<String, Vec<(u64, String)>> = HashMap::new();

        for (table_name, locally_stale, io_strategies) in &candidates {
            if *locally_stale {
                stale_tables.push(table_name.clone());
                continue;
            }

            // Evaluate SourceQuery strategies (requires I/O). All strategies
            // are polled so that a single refresh commits every observed
            // fingerprint (per-strategy keys avoid refresh ping-pong).
            let mut observed: Vec<(u64, String)> = Vec::new();
            let mut changed = false;

            for strategy in io_strategies {
                let RefreshStrategy::SourceQuery { sql, source_table } = strategy else {
                    continue;
                };

                if self.source_query_policy == SourceQueryPolicy::Disabled {
                    report.failures.push(RefreshFailure {
                        table: table_name.clone(),
                        detail: "source-query poll skipped: SourceQueryPolicy::Disabled"
                            .to_string(),
                    });
                    continue;
                }

                let connector_table = source_table.as_deref().unwrap_or(table_name);
                match self.poll_source_query(connector_table, sql).await {
                    Ok(new_fingerprint) => {
                        let key = InMemoryCache::source_query_key(sql);
                        if self.cache.fingerprint(table_name, key) != Some(new_fingerprint.as_str())
                        {
                            // Fingerprint changed (or first poll) → refresh.
                            changed = true;
                        }
                        observed.push((key, new_fingerprint));
                    }
                    Err(e) => {
                        // Poll failed — record it, don't force a refresh.
                        report.failures.push(RefreshFailure {
                            table: table_name.clone(),
                            detail: e.to_string(),
                        });
                    }
                }
            }

            if changed {
                stale_tables.push(table_name.clone());
                pending_fingerprints.insert(table_name.clone(), observed);
            }
        }

        for name in &stale_tables {
            match self.refresh_table(name).await {
                Ok(()) => {
                    // Commit fingerprints only now that the refresh succeeded;
                    // committing earlier would mask staleness after a failure.
                    if let Some(fingerprints) = pending_fingerprints.get(name) {
                        for (key, fingerprint) in fingerprints {
                            self.cache.set_fingerprint(name, *key, fingerprint.clone());
                        }
                    }
                    report.refreshed.push(name.clone());
                }
                Err(e) => report.failures.push(RefreshFailure {
                    table: name.clone(),
                    detail: e.to_string(),
                }),
            }
        }

        self.last_refresh_report = Some(report.clone());
        Ok(report)
    }

    /// Run a `SourceQuery` poll SQL against a connector and return the scalar
    /// result as a string.
    ///
    /// The SQL comes from a model file (a trust boundary), so it is checked
    /// against the engine's [`SourceQueryPolicy`] and validated as a single
    /// SELECT statement before any connector I/O happens.
    async fn poll_source_query(&self, connector_table: &str, sql: &str) -> EngineResult<String> {
        // Defense in depth: never run model-supplied SQL when disabled.
        if self.source_query_policy == SourceQueryPolicy::Disabled {
            return Err(EngineError::SourceQueryRejected {
                table: connector_table.to_string(),
                reason: "source-query polling is disabled by host policy".to_string(),
            });
        }

        // Validate before execution: exactly one statement, SELECT only.
        RefreshStrategy::validate_source_query_sql(connector_table, sql)?;

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
    /// containing `last_refreshed` ages, schema hashes, per-strategy
    /// `SourceQuery` fingerprints, and the wall-clock save time
    /// (`saved_at_unix_ms`). The save time lets
    /// [`load_cache_from_disk`](Self::load_cache_from_disk) count downtime
    /// between save and load toward each entry's age, keeping TTL-based
    /// staleness checks accurate across restarts.
    ///
    /// The `dir` must already exist; the method creates files inside it.
    pub fn save_cache_to_disk(&self, dir: &Path) -> EngineResult<()> {
        use arrow::ipc::writer::{FileWriter, IpcWriteOptions};
        use arrow::ipc::CompressionType;

        let mut tables_meta: BTreeMap<String, TableCacheMetadata> = BTreeMap::new();

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

            // Write Zstd-compressed Arrow IPC file. The file name is a
            // sanitized derivative of the table name (see `cache_file_name`)
            // and is verified to stay inside the cache directory.
            let file_name = cache_file_name(table_name);
            let file_path = safe_cache_path(dir, &file_name)?;
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

            // Record metadata: age in milliseconds, schema hash, and the
            // per-strategy SourceQuery fingerprints.
            let age_ms = if self.cache.is_force_stale(table_name) {
                // The entry was already maximally stale — keep it stale
                // across restarts instead of resetting its age.
                u64::MAX
            } else {
                self.cache
                    .age(table_name)
                    .map(duration_to_millis_clamped)
                    .unwrap_or(0)
            };
            let fingerprints: BTreeMap<String, String> = self
                .cache
                .fingerprints(table_name)
                .map(|m| m.iter().map(|(k, v)| (k.to_string(), v.clone())).collect())
                .unwrap_or_default();

            tables_meta.insert(
                table_name.to_string(),
                TableCacheMetadata {
                    age_ms,
                    schema_hash: table.schema_hash(),
                    row_count: batch.num_rows() as u64,
                    fingerprint: None,
                    fingerprints,
                    file: file_name,
                },
            );
        }

        // Write metadata.json with the wall-clock save time.
        let meta = CacheMetadata {
            saved_at_unix_ms: Some(now_unix_ms()),
            tables: tables_meta,
        };
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
    /// - Otherwise the data is loaded into the cache with an effective age of
    ///   `saved age + downtime since save` (wall clock), so that TTL-based
    ///   staleness checks remain accurate across restarts. Metadata files
    ///   written by older engine versions lack the save timestamp and are
    ///   treated as saved at load time (their previous behavior). Negative
    ///   clock skew is clamped to zero downtime.
    ///
    /// Loading at least one table invalidates the query-result cache, like
    /// every other cache mutation.
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
        let meta: CacheMetadata = serde_json::from_str(&meta_json)
            .map_err(|e| EngineError::InvalidData(format!("metadata parse failed: {e}")))?;

        // Wall-clock downtime between save and load, counted toward each
        // entry's age. Pre-`saved_at_unix_ms` files: zero downtime (see doc).
        let downtime_ms = match meta.saved_at_unix_ms {
            Some(saved_at) => now_unix_ms().saturating_sub(saved_at),
            None => 0,
        };

        let mut loaded = Vec::new();

        for (table_name, entry_meta) in &meta.tables {
            // Check the table still exists in the model and is InMemory.
            let table = match self.model.table(table_name) {
                Ok(t) if t.is_in_memory() => t,
                _ => continue,
            };

            // Validate schema hash.
            if entry_meta.schema_hash != table.schema_hash() {
                continue; // Schema changed — skip, will be re-fetched.
            }

            // Resolve the cache file path. New metadata carries the
            // sanitized file name chosen at save time; legacy metadata
            // (no `file` field) falls back to the historical
            // `{table_name}.arrow`. In both cases the name must stay inside
            // the cache directory — metadata files and table names cross a
            // trust boundary, so an entry that would escape (path
            // separators, `..`, absolute paths) is skipped like any other
            // unusable entry.
            let file_name = if entry_meta.file.is_empty() {
                format!("{table_name}.arrow")
            } else {
                entry_meta.file.clone()
            };
            let file_path = match safe_cache_path(dir, &file_name) {
                Ok(path) => path,
                Err(_) => continue,
            };
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

            // Restore with the effective age: saved age plus downtime.
            // Hostile/corrupted huge ages are handled by `store_with_age`
            // (the entry is stored maximally stale instead of panicking).
            let effective_age_ms = entry_meta.age_ms.saturating_add(downtime_ms);
            let age = std::time::Duration::from_millis(effective_age_ms);

            self.cache.store_with_age(table_name, batch, age)?;

            // Restore per-strategy fingerprints.
            for (key_str, fingerprint) in &entry_meta.fingerprints {
                if let Ok(key) = key_str.parse::<u64>() {
                    self.cache
                        .set_fingerprint(table_name, key, fingerprint.clone());
                }
            }

            // Legacy single-slot fingerprint (older metadata files): attribute
            // it to the table's first SourceQuery strategy, the only possible
            // owner in the old one-slot format.
            if let Some(fingerprint) = &entry_meta.fingerprint {
                if let Some(RefreshStrategy::SourceQuery { sql, .. }) =
                    table.io_refresh_strategies().first().copied()
                {
                    let key = InMemoryCache::source_query_key(sql);
                    if self.cache.fingerprint(table_name, key).is_none() {
                        self.cache
                            .set_fingerprint(table_name, key, fingerprint.clone());
                    }
                }
            }

            loaded.push(table_name.clone());
        }

        if !loaded.is_empty() {
            // Loaded data replaces cache contents — invalidate query results,
            // matching every other cache mutation (refresh/auto-tier).
            self.query_cache.invalidate_all();
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
    ///
    /// The written file always carries the current
    /// [`MODEL_FORMAT_VERSION`](engine_core::model::schema::MODEL_FORMAT_VERSION) —
    /// saving a model that was loaded from a legacy (version `0`) file
    /// upgrades the file to the current format. Saving cannot destroy
    /// content from a *newer* format version: [`Engine::load_model`]
    /// refuses such files up front, so they never reach a save.
    pub fn save_model(&self, path: &Path) -> EngineResult<()> {
        use engine_core::model::schema::MODEL_FORMAT_VERSION;

        let mut value = serde_json::to_value(&self.model)
            .map_err(|e| EngineError::InvalidData(format!("JSON serialization failed: {e}")))?;
        // Normalize the version on the serialized output (legacy 0 → current).
        if let Some(map) = value.as_object_mut() {
            map.insert(
                "format_version".to_string(),
                serde_json::Value::from(MODEL_FORMAT_VERSION),
            );
        }
        let json = serde_json::to_string_pretty(&value)
            .map_err(|e| EngineError::InvalidData(format!("JSON serialization failed: {e}")))?;
        std::fs::write(path, json)
            .map_err(|e| EngineError::InvalidData(format!("failed to write file: {e}")))?;
        Ok(())
    }

    /// Load a data model from a JSON file.
    ///
    /// Loading proceeds in three stages:
    ///
    /// 1. **Version gate.** The file is parsed into a generic JSON value
    ///    and its `format_version` field (missing → `0`, the legacy
    ///    unversioned format) is checked against
    ///    [`MODEL_FORMAT_VERSION`](engine_core::model::schema::MODEL_FORMAT_VERSION)
    ///    *before* any structural deserialization. Files written by a
    ///    newer engine fail with [`EngineError::ModelFormatTooNew`]
    ///    instead of a cryptic serde error on an unknown field or enum
    ///    variant — and because the load refuses them outright, this
    ///    engine can never silently drop their unknown content and then
    ///    destroy it via [`Engine::save_model`].
    /// 2. **Deserialization and measure re-parse.** The model is
    ///    deserialized from the already-parsed value, then every measure
    ///    carrying source text is re-parsed through the current parser
    ///    ([`DataModel::reparse_measures_from_source`]). The source text
    ///    is the authoritative definition, so re-parsing re-applies the
    ///    current parser's grammar and validation; a measure whose source
    ///    no longer parses keeps its stored expression tree (which still
    ///    passes model validation) rather than failing the load.
    /// 3. **Validation.** The resulting model is validated as usual.
    pub fn load_model(path: &Path) -> EngineResult<DataModel> {
        use engine_core::model::schema::MODEL_FORMAT_VERSION;

        let json = std::fs::read_to_string(path)
            .map_err(|e| EngineError::InvalidData(format!("failed to read file: {e}")))?;
        let value: serde_json::Value = serde_json::from_str(&json)
            .map_err(|e| EngineError::InvalidData(format!("JSON parse failed: {e}")))?;

        // Version gate: refuse newer files before attempting to
        // deserialize structures this engine does not know about.
        let found = value
            .get("format_version")
            .and_then(serde_json::Value::as_u64)
            .unwrap_or(0);
        if found > u64::from(MODEL_FORMAT_VERSION) {
            return Err(EngineError::ModelFormatTooNew {
                // Saturate values beyond u32 — the message stays accurate
                // ("newer than supported") without risking a panic.
                found: u32::try_from(found).unwrap_or(u32::MAX),
                supported: MODEL_FORMAT_VERSION,
            });
        }

        let mut model: DataModel = serde_json::from_value(value)
            .map_err(|e| EngineError::InvalidData(format!("JSON parse failed: {e}")))?;
        model.reparse_measures_from_source();
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

    // -- Model format version tests --

    #[test]
    fn load_model_rejects_newer_format_version_before_deserialization() {
        use engine_core::model::schema::MODEL_FORMAT_VERSION;

        let dir = std::env::temp_dir();
        let path = dir.join("calcula_engine_test_too_new.json");

        // The measure expression uses an enum variant unknown to this
        // engine — full deserialization would fail with a serde error, so
        // getting ModelFormatTooNew proves the version gate fires first.
        let json = r#"{
            "format_version": 999,
            "tables": [],
            "relationships": [],
            "measures": [{
                "name": "Future",
                "expression": {"SomeFutureFunction": {"arg": 1}}
            }],
            "calculated_columns": [],
            "measure_groups": []
        }"#;
        std::fs::write(&path, json).unwrap();

        let err = Engine::load_model(&path).unwrap_err();
        match err {
            EngineError::ModelFormatTooNew { found, supported } => {
                assert_eq!(found, 999);
                assert_eq!(supported, MODEL_FORMAT_VERSION);
            }
            other => panic!("expected ModelFormatTooNew, got: {other:?}"),
        }

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn save_model_writes_current_format_version() {
        use engine_core::model::schema::MODEL_FORMAT_VERSION;

        let model = DataModel::builder()
            .add_table(Table::new("Sales", vec![Column::new("amount", DataType::Float64)]).unwrap())
            .build()
            .unwrap();
        let engine = Engine::new(model);

        let dir = std::env::temp_dir();
        let path = dir.join("calcula_engine_test_version_written.json");
        engine.save_model(&path).unwrap();

        let json = std::fs::read_to_string(&path).unwrap();
        let value: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert_eq!(
            value.get("format_version").and_then(|v| v.as_u64()),
            Some(u64::from(MODEL_FORMAT_VERSION))
        );

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn legacy_model_without_version_loads_and_saves_upgraded() {
        use engine_core::model::schema::MODEL_FORMAT_VERSION;

        let dir = std::env::temp_dir();
        let legacy_path = dir.join("calcula_engine_test_legacy_model.json");
        let upgraded_path = dir.join("calcula_engine_test_upgraded_model.json");

        // Legacy file: no format_version field at all.
        let json = r#"{
            "tables": [],
            "relationships": [],
            "measures": [],
            "calculated_columns": [],
            "measure_groups": []
        }"#;
        std::fs::write(&legacy_path, json).unwrap();

        let loaded = Engine::load_model(&legacy_path).unwrap();
        assert_eq!(loaded.format_version(), 0);

        // Saving upgrades the file to the current format version.
        let engine = Engine::new(loaded);
        engine.save_model(&upgraded_path).unwrap();

        let saved = std::fs::read_to_string(&upgraded_path).unwrap();
        let value: serde_json::Value = serde_json::from_str(&saved).unwrap();
        assert_eq!(
            value.get("format_version").and_then(|v| v.as_u64()),
            Some(u64::from(MODEL_FORMAT_VERSION))
        );

        // The upgraded file loads back with the current version.
        let reloaded = Engine::load_model(&upgraded_path).unwrap();
        assert_eq!(reloaded.format_version(), MODEL_FORMAT_VERSION);

        let _ = std::fs::remove_file(&legacy_path);
        let _ = std::fs::remove_file(&upgraded_path);
    }

    // -- Measure source re-parse-on-load tests --

    fn sales_model_with_measure(measure: Measure) -> DataModel {
        DataModel::builder()
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
            .add_measure(measure)
            .build()
            .unwrap()
    }

    #[test]
    fn load_model_reparses_measure_from_source_text() {
        let dir = std::env::temp_dir();
        let path = dir.join("calcula_engine_test_reparse_source.json");

        // The stored AST is SUM(Sales[amount]) but the source text says
        // COUNT(Sales[id]) — after load, the source must win.
        let model = sales_model_with_measure(
            sum_measure("M", "Sales", "amount").with_source("COUNT(Sales[id])"),
        );
        Engine::new(model).save_model(&path).unwrap();

        let loaded = Engine::load_model(&path).unwrap();
        let m = loaded.measure("M").unwrap();
        assert_eq!(m.simple_operation(), Some(AggregateOp::Count));
        assert_eq!(m.simple_column(), Some("id"));
        assert_eq!(m.source(), Some("COUNT(Sales[id])"));

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn load_model_keeps_stored_ast_when_source_is_invalid() {
        let dir = std::env::temp_dir();
        let path = dir.join("calcula_engine_test_invalid_source.json");

        let model = sales_model_with_measure(
            sum_measure("M", "Sales", "amount").with_source("THIS IS NOT ((( VALID"),
        );
        Engine::new(model).save_model(&path).unwrap();

        // The load must succeed and keep the stored AST.
        let loaded = Engine::load_model(&path).unwrap();
        let m = loaded.measure("M").unwrap();
        assert_eq!(m.simple_operation(), Some(AggregateOp::Sum));
        assert_eq!(m.simple_column(), Some("amount"));
        // Source text is preserved so the host can display and fix it.
        assert_eq!(m.source(), Some("THIS IS NOT ((( VALID"));

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn load_model_leaves_measure_without_source_untouched() {
        let dir = std::env::temp_dir();
        let path = dir.join("calcula_engine_test_no_source.json");

        let model = sales_model_with_measure(sum_measure("M", "Sales", "amount"));
        Engine::new(model).save_model(&path).unwrap();

        let loaded = Engine::load_model(&path).unwrap();
        let m = loaded.measure("M").unwrap();
        assert_eq!(m.simple_operation(), Some(AggregateOp::Sum));
        assert_eq!(m.simple_column(), Some("amount"));
        assert_eq!(m.source(), None);

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

        // Verify files exist (table files use the sanitized-name scheme).
        assert!(dir.join(cache_file_name("Products")).exists());
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
        assert!(dir.join(cache_file_name("InMem")).exists());
        assert!(!dir.join(cache_file_name("Direct")).exists());

        let _ = std::fs::remove_dir_all(&dir);
    }

    // -- Source-query policy / refresh report tests --

    /// Model with one InMemory table carrying a single `SourceQuery` strategy.
    fn make_source_query_model(sql: &str) -> DataModel {
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
                .with_refresh_strategy(RefreshStrategy::SourceQuery {
                    sql: sql.to_string(),
                    source_table: None,
                }),
            )
            .build()
            .unwrap()
    }

    #[test]
    fn source_query_policy_defaults_to_validated_select_only() {
        let engine = Engine::new(make_inmemory_model());
        assert_eq!(
            engine.source_query_policy(),
            SourceQueryPolicy::ValidatedSelectOnly
        );
    }

    #[test]
    fn refresh_report_default_is_empty() {
        let report = RefreshReport::default();
        assert!(report.refreshed.is_empty());
        assert!(report.failures.is_empty());
    }

    #[tokio::test]
    async fn refresh_stale_collects_failures_instead_of_aborting() {
        // Two InMemory tables with no source bindings: both refresh attempts
        // fail, both failures are reported, and neither aborts the other.
        let model = DataModel::builder()
            .add_table(
                Table::new("A", vec![Column::new("id", DataType::Int64)])
                    .unwrap()
                    .with_storage_mode(StorageMode::InMemory),
            )
            .add_table(
                Table::new("B", vec![Column::new("id", DataType::Int64)])
                    .unwrap()
                    .with_storage_mode(StorageMode::InMemory),
            )
            .build()
            .unwrap();

        let mut engine = Engine::new(model);
        let report = engine.refresh_stale().await.unwrap();

        assert!(report.refreshed.is_empty());
        assert_eq!(report.failures.len(), 2);
        let mut failed_tables: Vec<&str> =
            report.failures.iter().map(|f| f.table.as_str()).collect();
        failed_tables.sort_unstable();
        assert_eq!(failed_tables, vec!["A", "B"]);

        // The report is also retained on the engine.
        assert_eq!(engine.last_refresh_report().unwrap().failures.len(), 2);
    }

    #[tokio::test]
    async fn refresh_stale_disabled_policy_skips_source_query() {
        let model = make_source_query_model("SELECT MAX(loaded_at) FROM etl_log");
        let mut engine = Engine::new(model);
        // Cached → not locally stale; only the SourceQuery poll applies.
        engine.cache.store("Products", make_test_batch()).unwrap();
        engine.set_source_query_policy(SourceQueryPolicy::Disabled);

        let report = engine.refresh_stale().await.unwrap();
        assert!(report.refreshed.is_empty());
        assert_eq!(report.failures.len(), 1);
        assert_eq!(report.failures[0].table, "Products");
        assert!(report.failures[0].detail.contains("Disabled"));
    }

    #[tokio::test]
    async fn refresh_stale_rejects_multi_statement_source_query() {
        let model = make_source_query_model("SELECT 1; DROP TABLE x;");
        let mut engine = Engine::new(model);
        engine.cache.store("Products", make_test_batch()).unwrap();

        let report = engine.refresh_stale().await.unwrap();
        // Rejected before any connector I/O — recorded, no refresh.
        assert!(report.refreshed.is_empty());
        assert_eq!(report.failures.len(), 1);
        assert!(report.failures[0].detail.contains("rejected"));
    }

    #[tokio::test]
    async fn refresh_stale_rejects_non_select_source_query() {
        let model = make_source_query_model("DROP TABLE x");
        let mut engine = Engine::new(model);
        engine.cache.store("Products", make_test_batch()).unwrap();

        let report = engine.refresh_stale().await.unwrap();
        assert!(report.refreshed.is_empty());
        assert_eq!(report.failures.len(), 1);
        assert!(report.failures[0].detail.contains("rejected"));
    }

    // -- Disk-cache metadata format tests --

    #[test]
    fn cache_metadata_roundtrip_with_saved_at() {
        let mut tables = BTreeMap::new();
        tables.insert(
            "t".to_string(),
            TableCacheMetadata {
                age_ms: 1234,
                schema_hash: "abc".to_string(),
                row_count: 10,
                fingerprint: None,
                fingerprints: BTreeMap::from([("42".to_string(), "fp".to_string())]),
                file: "t_00000000.arrow".to_string(),
            },
        );
        let meta = CacheMetadata {
            saved_at_unix_ms: Some(1_760_000_000_000),
            tables,
        };

        let json = serde_json::to_string(&meta).unwrap();
        let parsed: CacheMetadata = serde_json::from_str(&json).unwrap();

        assert_eq!(parsed.saved_at_unix_ms, Some(1_760_000_000_000));
        let t = &parsed.tables["t"];
        assert_eq!(t.age_ms, 1234);
        assert_eq!(t.schema_hash, "abc");
        assert_eq!(t.row_count, 10);
        assert_eq!(t.fingerprints["42"], "fp");
        assert!(t.fingerprint.is_none());
        assert_eq!(t.file, "t_00000000.arrow");
    }

    #[test]
    fn cache_metadata_parses_legacy_format() {
        // Written by an older engine version: no saved_at_unix_ms, a single
        // fingerprint slot (possibly null), no fingerprints map.
        let json = r#"{
            "tables": {
                "Products": {
                    "age_ms": 500,
                    "schema_hash": "h",
                    "row_count": 3,
                    "fingerprint": "v1"
                },
                "Customers": {
                    "age_ms": 9,
                    "schema_hash": "h2",
                    "row_count": 1,
                    "fingerprint": null
                }
            }
        }"#;
        let parsed: CacheMetadata = serde_json::from_str(json).unwrap();
        assert_eq!(parsed.saved_at_unix_ms, None);
        assert_eq!(parsed.tables["Products"].fingerprint.as_deref(), Some("v1"));
        assert!(parsed.tables["Products"].fingerprints.is_empty());
        assert!(parsed.tables["Customers"].fingerprint.is_none());
        // Legacy entries have no `file` field — empty string after parsing,
        // which triggers the `{name}.arrow` fallback on load.
        assert!(parsed.tables["Products"].file.is_empty());
    }

    #[test]
    fn load_cache_counts_downtime_toward_age() {
        let dir = make_cache_dir("downtime");
        let model = make_inmemory_model(); // 300s refresh interval.

        let mut engine = Engine::new(model.clone());
        engine.cache.store("Products", make_test_batch()).unwrap();
        engine.save_cache_to_disk(&dir).unwrap();

        // Rewind saved_at_unix_ms by 400s to simulate downtime between
        // save and load.
        let meta_path = dir.join("metadata.json");
        let mut value: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&meta_path).unwrap()).unwrap();
        let saved_at = value["saved_at_unix_ms"].as_u64().unwrap();
        value["saved_at_unix_ms"] = serde_json::json!(saved_at - 400_000);
        std::fs::write(&meta_path, serde_json::to_string(&value).unwrap()).unwrap();

        let mut engine2 = Engine::new(model);
        engine2.load_cache_from_disk(&dir).unwrap();

        // Effective age includes the downtime → past the 300s TTL.
        let age = engine2.cache().age("Products").unwrap();
        assert!(age >= std::time::Duration::from_secs(399));
        assert!(engine2.needs_refresh("Products", std::time::Duration::from_secs(300)));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn save_load_roundtrip_per_strategy_fingerprints() {
        let dir = make_cache_dir("fingerprints");
        let sql = "SELECT MAX(loaded_at) FROM etl_log";
        let model = make_source_query_model(sql);

        let mut engine = Engine::new(model.clone());
        engine.cache.store("Products", make_test_batch()).unwrap();
        let key = InMemoryCache::source_query_key(sql);
        engine
            .cache
            .set_fingerprint("Products", key, "fp-1".to_string());
        engine.save_cache_to_disk(&dir).unwrap();

        let mut engine2 = Engine::new(model);
        engine2.load_cache_from_disk(&dir).unwrap();
        assert_eq!(engine2.cache().fingerprint("Products", key), Some("fp-1"));

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn load_cache_migrates_legacy_fingerprint() {
        let dir = make_cache_dir("legacy_fingerprint");
        let sql = "SELECT MAX(loaded_at) FROM etl_log";
        let model = make_source_query_model(sql);

        let mut engine = Engine::new(model.clone());
        engine.cache.store("Products", make_test_batch()).unwrap();
        engine.save_cache_to_disk(&dir).unwrap();

        // Rewrite the metadata into the legacy single-slot shape.
        let meta_path = dir.join("metadata.json");
        let mut value: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&meta_path).unwrap()).unwrap();
        let entry = value["tables"]["Products"].as_object_mut().unwrap();
        entry.remove("fingerprints");
        entry.insert("fingerprint".to_string(), serde_json::json!("legacy-fp"));
        std::fs::write(&meta_path, serde_json::to_string(&value).unwrap()).unwrap();

        let mut engine2 = Engine::new(model);
        engine2.load_cache_from_disk(&dir).unwrap();

        // The legacy value is attributed to the first SourceQuery strategy.
        let key = InMemoryCache::source_query_key(sql);
        assert_eq!(
            engine2.cache().fingerprint("Products", key),
            Some("legacy-fp")
        );

        let _ = std::fs::remove_dir_all(&dir);
    }

    // -- Cache file naming / path containment tests --

    #[test]
    fn cache_file_name_sanitizes_traversal_names() {
        // A hostile table name collapses to a single safe path component.
        // The expected digest is hardcoded: FNV-1a output is embedded in
        // file names that persist on disk, so it must stay stable across
        // engine versions.
        let name = cache_file_name("..\\..\\evil");
        assert_eq!(name, "______evil_2c8e3842.arrow");
        assert!(!name.contains('\\'));
        assert!(!name.contains('/'));
        assert!(!name.contains(".."));
    }

    #[test]
    fn cache_file_name_distinguishes_names_with_same_sanitization() {
        // "Sales/2024" and "Sales 2024" both sanitize to "Sales_2024", but
        // the hash of the full original name keeps the files distinct.
        let a = cache_file_name("Sales/2024");
        let b = cache_file_name("Sales 2024");
        assert!(a.starts_with("Sales_2024_"));
        assert!(b.starts_with("Sales_2024_"));
        assert_ne!(a, b);
    }

    #[test]
    fn cache_file_name_truncates_long_names() {
        let long = "a".repeat(100);
        let name = cache_file_name(&long);
        // 64 sanitized chars + '_' + 8 hex chars + ".arrow".
        assert_eq!(name, format!("{}_2885d0ac.arrow", "a".repeat(64)));
        assert_eq!(name.len(), 64 + 1 + 8 + 6);
    }

    #[test]
    fn safe_cache_path_rejects_traversal_and_absolute_names() {
        let dir = make_cache_dir("safe_path");

        assert!(safe_cache_path(&dir, "ok.arrow").is_ok());

        // Multi-component, parent-relative, and rooted names are rejected
        // on every platform.
        for bad in ["../evil.arrow", "sub/evil.arrow", "..", "/abs/evil.arrow"] {
            assert!(
                safe_cache_path(&dir, bad).is_err(),
                "expected rejection of {bad:?}"
            );
        }

        // Windows-specific separators and drive prefixes. On Windows an
        // absolute argument to Path::join *replaces* the base path, so
        // these are exactly the dangerous inputs.
        #[cfg(windows)]
        for bad in ["..\\evil.arrow", "C:\\evil.arrow", "sub\\evil.arrow"] {
            assert!(
                safe_cache_path(&dir, bad).is_err(),
                "expected rejection of {bad:?}"
            );
        }

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn save_load_roundtrip_with_spaces_and_unicode_table_name() {
        let dir = make_cache_dir("unicode_name");
        let model = DataModel::builder()
            .add_table(
                Table::new(
                    "Försäljning Data",
                    vec![
                        Column::new("id", DataType::Int64),
                        Column::new("price", DataType::Float64),
                    ],
                )
                .unwrap()
                .with_storage_mode(StorageMode::InMemory),
            )
            .build()
            .unwrap();

        let mut engine = Engine::new(model.clone());
        engine
            .cache
            .store("Försäljning Data", make_test_batch())
            .unwrap();
        engine.save_cache_to_disk(&dir).unwrap();

        // The on-disk file uses the sanitized scheme and is recorded in the
        // metadata so load does not have to re-derive it.
        assert!(dir.join(cache_file_name("Försäljning Data")).exists());

        let mut engine2 = Engine::new(model);
        let loaded = engine2.load_cache_from_disk(&dir).unwrap();
        assert_eq!(loaded, vec!["Försäljning Data".to_string()]);
        let cached = engine2.cache().get("Försäljning Data").unwrap();
        assert_eq!(cached.num_rows(), 3);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn load_cache_legacy_metadata_falls_back_to_name_arrow() {
        let dir = make_cache_dir("legacy_file_name");
        let model = make_inmemory_model();

        let mut engine = Engine::new(model.clone());
        engine.cache.store("Products", make_test_batch()).unwrap();
        engine.save_cache_to_disk(&dir).unwrap();

        // Simulate a cache dir written by an older engine version: the table
        // file sits at the legacy `{name}.arrow` and the metadata entry has
        // no `file` field.
        std::fs::rename(
            dir.join(cache_file_name("Products")),
            dir.join("Products.arrow"),
        )
        .unwrap();
        let meta_path = dir.join("metadata.json");
        let mut value: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&meta_path).unwrap()).unwrap();
        value["tables"]["Products"]
            .as_object_mut()
            .unwrap()
            .remove("file");
        std::fs::write(&meta_path, serde_json::to_string(&value).unwrap()).unwrap();

        let mut engine2 = Engine::new(model);
        let loaded = engine2.load_cache_from_disk(&dir).unwrap();
        assert_eq!(loaded, vec!["Products"]);

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn load_cache_skips_metadata_with_escaping_file_entry() {
        let dir = make_cache_dir("hostile_file_field");
        let model = make_inmemory_model();

        let mut engine = Engine::new(model.clone());
        engine.cache.store("Products", make_test_batch()).unwrap();
        engine.save_cache_to_disk(&dir).unwrap();

        // Plant a real, loadable cache file one level above the cache dir
        // and point the metadata `file` entry at it via traversal. If the
        // containment check were missing, the load would succeed.
        let escaped = dir.parent().unwrap().join("escaped_cache_target.arrow");
        std::fs::copy(dir.join(cache_file_name("Products")), &escaped).unwrap();
        let meta_path = dir.join("metadata.json");
        let mut value: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&meta_path).unwrap()).unwrap();
        value["tables"]["Products"]["file"] = serde_json::json!("../escaped_cache_target.arrow");
        std::fs::write(&meta_path, serde_json::to_string(&value).unwrap()).unwrap();
        // Remove the legitimate file so only the traversal target remains.
        std::fs::remove_file(dir.join(cache_file_name("Products"))).unwrap();

        let mut engine2 = Engine::new(model);
        let loaded = engine2.load_cache_from_disk(&dir).unwrap();
        assert!(loaded.is_empty());
        assert!(engine2.cache().get("Products").is_none());

        let _ = std::fs::remove_file(&escaped);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn load_cache_skips_legacy_entry_with_traversal_table_name() {
        // A legacy metadata entry (no `file` field) whose table name
        // contains `..` must not escape the cache directory via the
        // `{name}.arrow` fallback. The model builder rejects such names
        // (fix S4), so construct the hostile model through serde, which a
        // hostile model file could do.
        let base = make_cache_dir("legacy_traversal");
        let cache_dir = base.join("cache");
        std::fs::create_dir_all(&cache_dir).unwrap();

        let clean_model = DataModel::builder()
            .add_table(
                Table::new(
                    "EvilX",
                    vec![
                        Column::new("id", DataType::Int64),
                        Column::new("price", DataType::Float64),
                    ],
                )
                .unwrap()
                .with_storage_mode(StorageMode::InMemory),
            )
            .build()
            .unwrap();
        let hostile_json = serde_json::to_string(&clean_model)
            .unwrap()
            .replace("EvilX", r"..\\evil");
        let hostile_model: DataModel = serde_json::from_str(&hostile_json).unwrap();
        let hostile_name = r"..\evil";
        let schema_hash = hostile_model.table(hostile_name).unwrap().schema_hash();

        // Plant a real, loadable Arrow file at the traversal target
        // (`cache/..\evil.arrow` resolves to `base/evil.arrow` on Windows).
        {
            let batch = make_test_batch();
            let file = std::fs::File::create(base.join("evil.arrow")).unwrap();
            let mut writer =
                arrow::ipc::writer::FileWriter::try_new(file, &batch.schema()).unwrap();
            writer.write(&batch).unwrap();
            writer.finish().unwrap();
        }

        // Legacy-shaped metadata: no `file` field, matching schema hash.
        let meta_json = serde_json::json!({
            "tables": {
                hostile_name: {
                    "age_ms": 0,
                    "schema_hash": schema_hash,
                    "row_count": 3
                }
            }
        });
        std::fs::write(
            cache_dir.join("metadata.json"),
            serde_json::to_string(&meta_json).unwrap(),
        )
        .unwrap();

        let mut engine = Engine::new(hostile_model);
        let loaded = engine.load_cache_from_disk(&cache_dir).unwrap();
        assert!(loaded.is_empty());
        assert!(engine.cache().get(hostile_name).is_none());

        let _ = std::fs::remove_dir_all(&base);
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
