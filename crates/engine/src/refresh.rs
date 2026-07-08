//! Table refresh: single-table and bulk refresh into the in-memory cache,
//! strategy-driven staleness evaluation (`refresh_stale`), and the
//! source-query polling policy.

use std::collections::HashMap;

use arrow::record_batch::RecordBatch;
use engine_connectors::{FilterCondition, FilterOperator};
use engine_core::compute::expression::ComparisonOp;
use engine_core::compute::incremental::{
    fold_refresh_filter_now, retain_stable_rows, splice_incremental, RefreshConjunct,
};
use futures::stream::{self, StreamExt};

use crate::{
    Engine, EngineError, EngineResult, FetchRequest, InMemoryCache, OptimizationStats,
    RefreshStrategy, SourceRegistry, MAX_CONCURRENT_FETCHES,
};

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

impl Engine {
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

        // Incremental path: only when the table has an `incremental_refresh`
        // policy AND a cached batch already exists. The first load (empty
        // cache) has no stable rows to retain, so it takes the full path.
        if let Some(incremental) = table.incremental_refresh() {
            if self.cache.get(table_name).is_some() {
                let refresh_filter = incremental.refresh_filter().to_string();
                return self
                    .refresh_table_incremental(table_name, &refresh_filter)
                    .await;
            }
        }

        let batches = Self::fetch_table_batches(&self.registry, table_name).await?;
        self.store_refreshed_table(table_name, batches)
    }

    /// Incrementally refresh a cached in-memory table: re-fetch only the
    /// volatile rows the `refresh_filter` identifies and retain the rest of
    /// the cached rows.
    ///
    /// The "today/now" boundary is evaluated **once** (local time) so the
    /// source fetch (volatile rows) and the cache retention (stable rows) use
    /// the identical boundary. Then:
    ///
    /// 1. fold the filter to concrete `(column, op, value)` conjuncts;
    /// 2. fetch volatile rows from the source with those conjuncts pushed as a
    ///    `WHERE` (only the volatile rows cross the network);
    /// 3. retain the cached rows the filter does NOT match
    ///    (`WHERE NOT(conjunction)`, NULL-safe);
    /// 4. splice retained-stable + fetched-volatile into one batch and store
    ///    it through the same optimize/sort/store tail as a full refresh.
    ///
    /// Caller guarantees the table is `InMemory` and already cached.
    async fn refresh_table_incremental(
        &mut self,
        table_name: &str,
        refresh_filter: &str,
    ) -> EngineResult<OptimizationStats> {
        // Single refresh-time snapshot of "now" in local time (captured inside
        // engine-core) — shared by the source fetch and the cache retention so
        // they agree on the boundary.
        let conjuncts = fold_refresh_filter_now(table_name, refresh_filter)?;

        // 1. Fetch the volatile rows from the source (filters pushed as WHERE).
        let filters: Vec<FilterCondition> = conjuncts.iter().map(conjunct_to_filter).collect();
        let volatile =
            Self::fetch_table_batches_with_filters(&self.registry, table_name, filters).await?;

        // 2. Retain the stable cached rows (those NOT matched by the filter).
        //    The cached batch is present (caller guarantees it).
        let cached = self
            .cache
            .get(table_name)
            .ok_or_else(|| EngineError::TableNotCached(table_name.to_string()))?;
        let stable = retain_stable_rows(cached, &conjuncts).await?;

        // 3. Splice retained-stable + fetched-volatile into one batch, then run
        //    the same optimize/sort/store tail as a full refresh.
        let spliced = splice_incremental(stable, &volatile)?;
        self.store_refreshed_table(table_name, vec![spliced])
    }

    /// Fetch all rows of a table from its source connector.
    ///
    /// Borrows only the [`SourceRegistry`] (not the whole engine) so that
    /// multiple table fetches can run concurrently; the caller performs the
    /// `&mut self` cache insertion afterwards via
    /// [`store_refreshed_table`](Self::store_refreshed_table).
    async fn fetch_table_batches(
        registry: &SourceRegistry,
        table_name: &str,
    ) -> EngineResult<Vec<RecordBatch>> {
        Self::fetch_table_batches_with_filters(registry, table_name, Vec::new()).await
    }

    /// Fetch a table's rows from its source connector, optionally restricted by
    /// pushed `WHERE` filter conditions.
    ///
    /// With an empty `filters` this is a full fetch (the original
    /// [`fetch_table_batches`](Self::fetch_table_batches) behavior). With
    /// filters it fetches only the matching (volatile) rows — used by
    /// [`refresh_table_incremental`](Self::refresh_table_incremental) so only
    /// the volatile rows cross the network.
    async fn fetch_table_batches_with_filters(
        registry: &SourceRegistry,
        table_name: &str,
        filters: Vec<FilterCondition>,
    ) -> EngineResult<Vec<RecordBatch>> {
        let binding = registry
            .binding_for(table_name)
            .map_err(|e| EngineError::InvalidData(e.to_string()))?;
        let request = FetchRequest {
            schema: Some(binding.schema.clone()),
            table: binding.table.clone(),
            source_query: binding.source_query.clone(),
            filters,
            ..Default::default()
        };
        let connector = registry
            .connector_for(table_name)
            .map_err(|e| EngineError::InvalidData(e.to_string()))?;
        connector
            .fetch_data(&request)
            .await
            .map_err(|e| EngineError::InvalidData(e.to_string()))
    }

    /// Optimize, sort, and store fetched batches in the in-memory cache,
    /// invalidating the query-result cache.
    fn store_refreshed_table(
        &mut self,
        table_name: &str,
        batches: Vec<RecordBatch>,
    ) -> EngineResult<OptimizationStats> {
        if batches.is_empty() {
            let table = self.model.table(table_name)?;
            let schema = std::sync::Arc::new(table.to_arrow_schema());
            let batch = RecordBatch::new_empty(schema);
            self.cache.store(table_name, batch)?;
            self.query_cache.lock().invalidate_all();
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
            self.query_cache.lock().invalidate_all();
            Ok(stats)
        }
    }

    /// Refresh all tables configured for in-memory storage.
    ///
    /// Source fetches run concurrently (bounded), then results are inserted
    /// into the cache sequentially in model table order. The first fetch or
    /// store error is returned; as with the previous sequential
    /// implementation, tables ordered before the failing one are stored and
    /// later ones are not.
    pub async fn refresh_all_in_memory(&mut self) -> EngineResult<()> {
        let table_names: Vec<String> = self
            .model
            .tables()
            .iter()
            .filter(|t| t.is_in_memory())
            .map(|t| t.name().to_string())
            .collect();

        // Phase 1: fetch concurrently — futures borrow only the registry.
        let registry = &self.registry;
        let fetched: Vec<(String, EngineResult<Vec<RecordBatch>>)> =
            stream::iter(table_names.into_iter().map(|name| async move {
                let result = Self::fetch_table_batches(registry, &name).await;
                (name, result)
            }))
            .buffered(MAX_CONCURRENT_FETCHES)
            .collect()
            .await;

        // Phase 2: store sequentially (cache insertion needs `&mut self`).
        for (name, result) in fetched {
            self.store_refreshed_table(&name, result?)?;
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
}

/// Convert a folded incremental-refresh conjunct into a connector
/// [`FilterCondition`] (the volatile-row `WHERE` pushed to the source).
///
/// The conjunct's [`ComparisonOp`] maps 1:1 onto a [`FilterOperator`]; the
/// connector quotes/parameterizes the value safely, so no escaping happens
/// here.
fn conjunct_to_filter(conjunct: &RefreshConjunct) -> FilterCondition {
    let operator = match conjunct.op {
        ComparisonOp::Equal => FilterOperator::Equal,
        ComparisonOp::NotEqual => FilterOperator::NotEqual,
        ComparisonOp::GreaterThan => FilterOperator::GreaterThan,
        ComparisonOp::GreaterThanOrEqual => FilterOperator::GreaterThanOrEqual,
        ComparisonOp::LessThan => FilterOperator::LessThan,
        ComparisonOp::LessThanOrEqual => FilterOperator::LessThanOrEqual,
    };
    FilterCondition::new(conjunct.column.clone(), operator, conjunct.value.clone())
}

#[cfg(test)]
mod tests {
    use crate::test_fixtures::{
        make_inmemory_model, make_source_query_model, make_star_schema_model, make_test_batch,
    };
    use crate::{
        Column, DataModel, DataType, Engine, RefreshReport, SourceQueryPolicy, StorageMode, Table,
    };

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

    #[tokio::test]
    async fn refresh_all_in_memory_with_no_in_memory_tables_is_noop() {
        // All tables are DirectQuery — nothing to fetch or store.
        let model = make_star_schema_model();
        let mut engine = Engine::new(model);
        engine.refresh_all_in_memory().await.unwrap();
    }

    #[tokio::test]
    async fn refresh_all_in_memory_propagates_fetch_errors() {
        // An InMemory table with no source binding: the concurrent fetch
        // phase yields an error which the store phase propagates.
        let model = DataModel::builder()
            .add_table(
                Table::new("A", vec![Column::new("id", DataType::Int64)])
                    .unwrap()
                    .with_storage_mode(StorageMode::InMemory),
            )
            .build()
            .unwrap();
        let mut engine = Engine::new(model);
        assert!(engine.refresh_all_in_memory().await.is_err());
    }

    // -----------------------------------------------------------------------
    // Incremental refresh (the headline) — end-to-end through `refresh_table`
    // with an in-process connector that honors FetchRequest.filters.
    // -----------------------------------------------------------------------

    mod incremental {
        use std::sync::Arc;

        use arrow::array::{Date32Array, Float64Array};
        use arrow::datatypes::{DataType as ArrowDataType, Field, Schema as ArrowSchema};
        use arrow::record_batch::RecordBatch;
        use chrono::NaiveDate;

        use crate::{
            Column, DataModel, DataType, Engine, InMemoryConnector, IncrementalRefresh,
            SourceBinding, StorageMode, Table,
        };

        /// Days since the Unix epoch for a calendar date (Date32 value).
        fn days(y: i32, m: u32, d: u32) -> i32 {
            let epoch = NaiveDate::from_ymd_opt(1970, 1, 1).unwrap();
            NaiveDate::from_ymd_opt(y, m, d)
                .unwrap()
                .signed_duration_since(epoch)
                .num_days() as i32
        }

        fn fact_schema() -> Arc<ArrowSchema> {
            Arc::new(ArrowSchema::new(vec![
                Field::new("order_date", ArrowDataType::Date32, true),
                Field::new("amount", ArrowDataType::Float64, true),
            ]))
        }

        fn fact_batch(dates: &[i32], amounts: &[f64]) -> RecordBatch {
            RecordBatch::try_new(
                fact_schema(),
                vec![
                    Arc::new(Date32Array::from(dates.to_vec())),
                    Arc::new(Float64Array::from(amounts.to_vec())),
                ],
            )
            .unwrap()
        }

        /// Build a model with one in-memory fact table carrying an incremental
        /// refresh filter `order_date >= <boundary>`.
        fn incremental_model(filter: &str) -> DataModel {
            DataModel::builder()
                .add_table(
                    Table::new(
                        "fact_orders",
                        vec![
                            Column::new("order_date", DataType::Date),
                            Column::new("amount", DataType::Float64),
                        ],
                    )
                    .unwrap()
                    .with_storage_mode(StorageMode::InMemory)
                    .with_incremental_refresh(IncrementalRefresh::new(filter)),
                )
                .build()
                .unwrap()
        }

        /// Read the (date_days, amount) rows of the cached fact_orders batch,
        /// sorted by date for stable assertions.
        fn cached_rows(engine: &Engine) -> Vec<(i32, f64)> {
            let batch = engine.cache().get("fact_orders").expect("cached batch");
            let dates = batch
                .column(0)
                .as_any()
                .downcast_ref::<Date32Array>()
                .unwrap();
            let amounts = batch
                .column(1)
                .as_any()
                .downcast_ref::<Float64Array>()
                .unwrap();
            let mut rows: Vec<(i32, f64)> = (0..batch.num_rows())
                .map(|i| (dates.value(i), amounts.value(i)))
                .collect();
            rows.sort_by(|a, b| a.0.cmp(&b.0).then(a.1.partial_cmp(&b.1).unwrap()));
            rows
        }

        #[tokio::test]
        async fn incremental_splice_replaces_volatile_keeps_stable() {
            // Boundary 2026-06-06: rows on/after it are volatile.
            let mut engine = Engine::new(incremental_model("order_date >= \"2026-06-06\""));

            // Connector returns the CURRENT source state: the stable row is
            // unchanged (it must NOT be re-fetched), and the volatile row now
            // has a NEW amount (550 instead of the cached 200).
            let source = InMemoryConnector::new().with_table(
                "public",
                "orders",
                fact_batch(&[days(2026, 6, 10)], &[550.0]),
            );
            let idx = engine.add_in_memory_source(source);
            engine.bind_table("fact_orders", idx, SourceBinding::new("public", "orders"));

            // Seed the cache with the OLD state: one stable row (2026-06-01,
            // 100) and one volatile row (2026-06-10, 200 — the stale value).
            engine
                .cache
                .store(
                    "fact_orders",
                    fact_batch(&[days(2026, 6, 1), days(2026, 6, 10)], &[100.0, 200.0]),
                )
                .unwrap();

            engine.refresh_table("fact_orders").await.unwrap();

            // Result = retained stable row (date < boundary, untouched) +
            // fetched volatile row (date >= boundary, replaced).
            let rows = cached_rows(&engine);
            assert_eq!(rows.len(), 2);
            // Stable row's value did NOT change.
            assert_eq!(rows[0], (days(2026, 6, 1), 100.0));
            // Volatile row's value DID change (200 → 550), not duplicated.
            assert_eq!(rows[1], (days(2026, 6, 10), 550.0));
        }

        #[tokio::test]
        async fn first_load_with_empty_cache_does_full_fetch() {
            let mut engine = Engine::new(incremental_model("order_date >= \"2026-06-06\""));

            // Source has BOTH a stable and a volatile row. With an empty cache
            // the filter is ignored and the whole table is fetched.
            let source = InMemoryConnector::new().with_table(
                "public",
                "orders",
                fact_batch(&[days(2026, 6, 1), days(2026, 6, 10)], &[100.0, 200.0]),
            );
            let idx = engine.add_in_memory_source(source);
            engine.bind_table("fact_orders", idx, SourceBinding::new("public", "orders"));

            // No cache seeded → full refresh path.
            engine.refresh_table("fact_orders").await.unwrap();

            let rows = cached_rows(&engine);
            // Both rows present — including the stable one the filter would
            // have excluded had this been incremental.
            assert_eq!(rows.len(), 2);
            assert_eq!(rows[0], (days(2026, 6, 1), 100.0));
            assert_eq!(rows[1], (days(2026, 6, 10), 200.0));
        }

        #[tokio::test]
        async fn volatile_fetch_returning_zero_rows_keeps_only_stable() {
            // All volatile rows were deleted at source: the volatile fetch
            // returns nothing, so only the retained stable rows remain.
            let mut engine = Engine::new(incremental_model("order_date >= \"2026-06-06\""));

            // Source has only the stable row now (volatile rows deleted).
            let source = InMemoryConnector::new().with_table(
                "public",
                "orders",
                fact_batch(&[days(2026, 6, 1)], &[100.0]),
            );
            let idx = engine.add_in_memory_source(source);
            engine.bind_table("fact_orders", idx, SourceBinding::new("public", "orders"));

            // Cache had a stable row and a volatile row.
            engine
                .cache
                .store(
                    "fact_orders",
                    fact_batch(&[days(2026, 6, 1), days(2026, 6, 10)], &[100.0, 200.0]),
                )
                .unwrap();

            engine.refresh_table("fact_orders").await.unwrap();

            // The volatile row is gone (deleted at source, fetch returned 0);
            // the stable row remains untouched.
            let rows = cached_rows(&engine);
            assert_eq!(rows.len(), 1);
            assert_eq!(rows[0], (days(2026, 6, 1), 100.0));
        }

        #[tokio::test]
        async fn non_timestamp_status_filter_replaces_by_status() {
            // A non-date volatile signal: status <> "closed". Volatile = open
            // rows; closed rows are stable.
            let model = DataModel::builder()
                .add_table(
                    Table::new(
                        "fact_tickets",
                        vec![
                            Column::new("id", DataType::Int64),
                            Column::new("status", DataType::String),
                        ],
                    )
                    .unwrap()
                    .with_storage_mode(StorageMode::InMemory)
                    .with_incremental_refresh(IncrementalRefresh::new("status <> \"closed\"")),
                )
                .build()
                .unwrap();
            let mut engine = Engine::new(model);

            use arrow::array::{Int64Array, StringArray};
            let schema = Arc::new(ArrowSchema::new(vec![
                Field::new("id", ArrowDataType::Int64, true),
                Field::new("status", ArrowDataType::Utf8, true),
            ]));
            let batch = |ids: Vec<i64>, statuses: Vec<&str>| {
                RecordBatch::try_new(
                    schema.clone(),
                    vec![
                        Arc::new(Int64Array::from(ids)),
                        Arc::new(StringArray::from(statuses)),
                    ],
                )
                .unwrap()
            };

            // Source CURRENT state: ticket 2 (was "open") is now "pending".
            let source = InMemoryConnector::new().with_table(
                "public",
                "tickets",
                batch(vec![2], vec!["pending"]),
            );
            let idx = engine.add_in_memory_source(source);
            engine.bind_table("fact_tickets", idx, SourceBinding::new("public", "tickets"));

            // Cache: ticket 1 closed (stable), ticket 2 open (volatile).
            engine
                .cache
                .store("fact_tickets", batch(vec![1, 2], vec!["closed", "open"]))
                .unwrap();

            engine.refresh_table("fact_tickets").await.unwrap();

            let out = engine.cache().get("fact_tickets").unwrap();
            let ids = out.column(0).as_any().downcast_ref::<Int64Array>().unwrap();
            let statuses = out
                .column(1)
                .as_any()
                .downcast_ref::<StringArray>()
                .unwrap();
            let mut rows: Vec<(i64, String)> = (0..out.num_rows())
                .map(|i| (ids.value(i), statuses.value(i).to_string()))
                .collect();
            rows.sort_by_key(|r| r.0);

            assert_eq!(rows.len(), 2);
            // Closed ticket retained untouched.
            assert_eq!(rows[0], (1, "closed".to_string()));
            // Open ticket replaced by its new "pending" status.
            assert_eq!(rows[1], (2, "pending".to_string()));
        }

        #[tokio::test]
        async fn injection_value_is_escaped_in_retention_sql() {
            // A refresh_filter value containing a quote/`;` must render escaped
            // in the cache-retention SQL — it cannot break out and inject. We
            // use a status filter whose literal carries the payload; the
            // refresh must run cleanly (no SQL error) and the cache must end up
            // correct, which only happens if the literal stayed quoted.
            let payload = "x'); DROP TABLE _cached; --";
            let filter = format!("status <> \"{payload}\"");
            let model = DataModel::builder()
                .add_table(
                    Table::new(
                        "fact_tickets",
                        vec![
                            Column::new("id", DataType::Int64),
                            Column::new("status", DataType::String),
                        ],
                    )
                    .unwrap()
                    .with_storage_mode(StorageMode::InMemory)
                    .with_incremental_refresh(IncrementalRefresh::new(filter)),
                )
                .build()
                .unwrap();
            let mut engine = Engine::new(model);

            use arrow::array::{Int64Array, StringArray};
            let schema = Arc::new(ArrowSchema::new(vec![
                Field::new("id", ArrowDataType::Int64, true),
                Field::new("status", ArrowDataType::Utf8, true),
            ]));
            let make = |ids: Vec<i64>, statuses: Vec<&str>| {
                RecordBatch::try_new(
                    schema.clone(),
                    vec![
                        Arc::new(Int64Array::from(ids)),
                        Arc::new(StringArray::from(statuses)),
                    ],
                )
                .unwrap()
            };

            // Source returns no volatile rows (nothing currently != payload
            // that the source wants to re-supply).
            let source =
                InMemoryConnector::new().with_table("public", "tickets", make(vec![], vec![]));
            let idx = engine.add_in_memory_source(source);
            engine.bind_table("fact_tickets", idx, SourceBinding::new("public", "tickets"));

            // Cache: one row whose status equals the payload (so it is a
            // "stable" row under `status <> payload`) and must be retained.
            engine
                .cache
                .store("fact_tickets", make(vec![1], vec![payload]))
                .unwrap();

            // If the value were not escaped, the embedded `DROP TABLE` /
            // unbalanced quote would make the retention SQL fail. A clean Ok
            // means it stayed a quoted literal.
            engine.refresh_table("fact_tickets").await.unwrap();

            let out = engine.cache().get("fact_tickets").unwrap();
            // The payload-status row is stable (status == payload, so NOT
            // `status <> payload`) → retained.
            assert_eq!(out.num_rows(), 1);
            let statuses = out
                .column(1)
                .as_any()
                .downcast_ref::<StringArray>()
                .unwrap();
            assert_eq!(statuses.value(0), payload);
        }
    }
}
