//! Table refresh: single-table and bulk refresh into the in-memory cache,
//! strategy-driven staleness evaluation (`refresh_stale`), and the
//! source-query polling policy.

use std::collections::HashMap;

use arrow::record_batch::RecordBatch;
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

        let batches = Self::fetch_table_batches(&self.registry, table_name).await?;
        self.store_refreshed_table(table_name, batches)
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
        let binding = registry
            .binding_for(table_name)
            .map_err(|e| EngineError::InvalidData(e.to_string()))?;
        let request = FetchRequest {
            schema: Some(binding.schema.clone()),
            table: binding.table.clone(),
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
}
