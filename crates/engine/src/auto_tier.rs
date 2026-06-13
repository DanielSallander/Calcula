//! Automatic dimension-table caching (auto-tiering): configuration, runtime
//! state, candidate selection, per-query tiering, deferred pre-warm, and
//! TTL-based refresh of auto-tiered tables.

use std::collections::HashSet;
use std::time::Duration;

use arrow::record_batch::RecordBatch;
use futures::stream::{self, StreamExt};

use crate::{
    query_cache, Cardinality, Engine, EngineError, EngineResult, FetchRequest, PushdownPlanner,
    QueryError, QueryExecutor, QueryRequest, QueryResult, SourceRegistry, MAX_CONCURRENT_FETCHES,
};

// ---------------------------------------------------------------------------
// Auto-tier configuration and state
// ---------------------------------------------------------------------------

/// Configuration for automatic dimension table caching.
///
/// When enabled, the engine automatically caches dimension tables (the "one"
/// side of many-to-one relationships) that are below a configurable row count
/// threshold. This happens lazily on first query; remaining eligible tables
/// can be pre-warmed afterwards by calling
/// [`Engine::auto_tier_remaining`] off the query's critical path.
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
pub(crate) struct AutoTierState {
    /// Tables that have been auto-tiered (successfully cached).
    cached: HashSet<String>,
    /// Tables that were checked and rejected (too large). Not re-checked
    /// until the engine is restarted or the model changes.
    rejected: HashSet<String>,
}

impl Engine {
    /// Set the auto-tier configuration for automatic dimension caching.
    ///
    /// When enabled, dimension tables (the "one" side of many-to-one
    /// relationships) are automatically cached when first needed by a query,
    /// provided they are below the configured row threshold. Remaining
    /// eligible tables can be pre-warmed afterwards via
    /// [`auto_tier_remaining`](Self::auto_tier_remaining).
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

    /// Returns the names of dimension tables that are currently eligible for
    /// auto-tiering but have not been cached (or rejected) yet.
    ///
    /// Hosts can use this to decide whether a deferred pre-warm pass is
    /// worthwhile: when this returns an empty list,
    /// [`auto_tier_remaining`](Self::auto_tier_remaining) is a no-op.
    pub fn auto_tier_pending(&self) -> Vec<String> {
        self.auto_tier_candidates()
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
        let batches = Self::fetch_auto_tier_batches(
            &self.registry,
            table_name,
            self.auto_tier_config.max_rows,
        )
        .await?;
        self.store_auto_tier_result(table_name, batches)
    }

    /// Fetch up to `max_rows + 1` rows of an auto-tier candidate from its
    /// source connector (one extra row so the row-count check can detect
    /// oversized tables).
    ///
    /// Borrows only the [`SourceRegistry`] (not the whole engine) so that
    /// multiple candidate fetches can run concurrently; the caller performs
    /// the `&mut self` bookkeeping afterwards via
    /// [`store_auto_tier_result`](Self::store_auto_tier_result).
    async fn fetch_auto_tier_batches(
        registry: &SourceRegistry,
        table_name: &str,
        max_rows: usize,
    ) -> EngineResult<Vec<RecordBatch>> {
        let binding = registry
            .binding_for(table_name)
            .map_err(|e| EngineError::InvalidData(e.to_string()))?;
        let request = FetchRequest {
            schema: Some(binding.schema.clone()),
            table: binding.table.clone(),
            limit: Some(max_rows + 1),
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

    /// Apply the auto-tier row-count check to fetched batches, caching the
    /// table if it qualifies and recording the rejection if it does not.
    ///
    /// Returns `true` if the table was cached, `false` if rejected (too many
    /// rows). On success the query-result cache is invalidated, exactly as
    /// when the fetch and store ran as one step.
    fn store_auto_tier_result(
        &mut self,
        table_name: &str,
        batches: Vec<RecordBatch>,
    ) -> EngineResult<bool> {
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
        self.query_cache.lock().invalidate_all();
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

    /// Cache all remaining eligible dimension tables (deferred pre-warm).
    ///
    /// [`query_auto_tier`](Self::query_auto_tier) only caches the dimension
    /// tables a query actually touches; this method caches every other
    /// eligible candidate (see
    /// [`auto_tier_pending`](Self::auto_tier_pending)). Call it **after**
    /// rendering query results so the pre-warm cost stays off the query's
    /// critical path — for example from a background task that owns the
    /// `Engine`:
    ///
    /// ```rust,no_run
    /// # use bi_engine::*;
    /// # async fn example(mut engine: Engine, request: QueryRequest)
    /// # -> Result<(), Box<dyn std::error::Error>> {
    /// let (batches, tiered) = engine.query_auto_tier(request).await?;
    /// // ... render `batches` to the user first ...
    /// # let _ = (&batches, &tiered);
    /// // Then pre-warm the remaining dimension tables:
    /// let warmed = engine.auto_tier_remaining().await?;
    /// println!("pre-warmed: {warmed:?}");
    /// # Ok(())
    /// # }
    /// ```
    ///
    /// Candidate tables are fetched from their sources concurrently
    /// (bounded), then inserted into the cache sequentially. A table whose
    /// fetch fails is skipped — it stays a candidate and is retried on the
    /// next call.
    ///
    /// Returns the names of tables that were successfully cached.
    pub async fn auto_tier_remaining(&mut self) -> EngineResult<Vec<String>> {
        if !self.auto_tier_config.enabled {
            return Ok(Vec::new());
        }

        let candidates = self.auto_tier_candidates();
        let max_rows = self.auto_tier_config.max_rows;

        // Phase 1: fetch concurrently — futures borrow only the registry.
        let registry = &self.registry;
        let fetched: Vec<(String, EngineResult<Vec<RecordBatch>>)> =
            stream::iter(candidates.into_iter().map(|name| async move {
                let result = Self::fetch_auto_tier_batches(registry, &name, max_rows).await;
                (name, result)
            }))
            .buffered(MAX_CONCURRENT_FETCHES)
            .collect()
            .await;

        // Phase 2: store sequentially (cache insertion needs `&mut self`).
        let mut tiered = Vec::new();
        for (name, result) in fetched {
            match result.and_then(|batches| self.store_auto_tier_result(&name, batches)) {
                Ok(true) => tiered.push(name),
                Ok(false) => {} // Rejected (too large).
                Err(_) => {}    // Fetch or store failed — skip, will retry next time.
            }
        }
        Ok(tiered)
    }

    /// Execute a query with automatic dimension caching.
    ///
    /// Before executing the query, dimension tables needed by **this** query
    /// that are eligible for auto-tiering are cached, and stale auto-tiered
    /// tables are refreshed. The query is then served from the query-result
    /// cache when possible, otherwise executed against the sources.
    ///
    /// Returns the query results and the names of tables that were
    /// auto-tiered for this query.
    ///
    /// # Behavior change: pre-warming is no longer inline
    ///
    /// Earlier versions awaited
    /// [`auto_tier_remaining`](Self::auto_tier_remaining) before returning —
    /// despite documenting it as a background pre-warm — so the first query
    /// paid for fetching every remaining candidate dimension it did not
    /// need, even on a query-cache hit. This method now returns as soon as
    /// the results are available and never fetches unrelated candidates.
    /// Consequently the returned table list contains only tables tiered for
    /// this query, no longer ones pre-warmed afterwards.
    ///
    /// To pre-warm the remaining candidates, call
    /// [`auto_tier_remaining`](Self::auto_tier_remaining) after rendering
    /// the results — e.g. from a background task that owns the `Engine`:
    ///
    /// ```rust,no_run
    /// # use bi_engine::*;
    /// # async fn example(mut engine: Engine, request: QueryRequest)
    /// # -> Result<(), Box<dyn std::error::Error>> {
    /// let (batches, tiered) = engine.query_auto_tier(request).await?;
    /// println!("{} batches; auto-tiered for query: {tiered:?}", batches.len());
    /// // Render results first, then pre-warm off the critical path:
    /// let warmed = engine.auto_tier_remaining().await?;
    /// println!("pre-warmed afterwards: {warmed:?}");
    /// # Ok(())
    /// # }
    /// ```
    ///
    /// # Concurrency
    ///
    /// Takes `&mut self` (unlike [`query`](Self::query)) because auto-tiering
    /// stores fetched dimension tables into the engine's in-memory cache
    /// mid-query. Hosts that share the engine as `Arc<Engine>` should use
    /// the plain [`query`](Self::query) path for concurrent execution and
    /// run auto-tiering from the task that owns the engine exclusively.
    pub async fn query_auto_tier(
        &mut self,
        request: QueryRequest,
    ) -> QueryResult<(Vec<RecordBatch>, Vec<String>)> {
        // Fail fast (with a clear error) on unregistered UDF calls.
        self.validate_request_udfs(&request)?;

        // Auto-tier tables needed by this specific query. Remaining
        // candidates are deliberately NOT fetched here — hosts pre-warm them
        // via `auto_tier_remaining()` after rendering the results.
        let tiered = self
            .auto_tier_for_query(&request)
            .await
            .map_err(QueryError::Engine)?;

        // Also refresh stale auto-tiered tables.
        self.refresh_stale_auto_tiered()
            .await
            .map_err(QueryError::Engine)?;

        // Check query cache. The guard is dropped before any await.
        let (cache_key, cached) = {
            let mut query_cache = self.query_cache.lock();
            let key = query_cache::query_cache_key(
                &request,
                query_cache.model_version(),
                self.effective_udfs.identity_hash(),
            );
            let cached = query_cache.get(key);
            (key, cached)
        };
        if let Some(cached) = cached {
            return Ok((cached, tiered));
        }

        // Execute the query — tell the planner that auto-tiered tables are local.
        let plan = PushdownPlanner::plan_with_cached(
            &request,
            &self.model,
            &self.registry,
            &self.auto_tier_state.cached,
        )?;
        let batches = crate::map_script_error(
            QueryExecutor::execute(
                &plan,
                &self.model,
                &self.registry,
                Some(&self.cache),
                Some(self.max_inline_in_values),
                Some(self.effective_udfs.as_ref()),
            )
            .await,
        )?;

        self.query_cache.lock().put(cache_key, batches.clone());

        Ok((batches, tiered))
    }

    /// Refresh auto-tiered tables that have exceeded their TTL.
    ///
    /// Stale tables are re-fetched from their sources concurrently
    /// (bounded), then re-cached sequentially.
    async fn refresh_stale_auto_tiered(&mut self) -> EngineResult<()> {
        let ttl = Duration::from_secs(self.auto_tier_config.default_ttl_secs);
        let stale: Vec<String> = self
            .auto_tier_state
            .cached
            .iter()
            .filter(|name| self.cache.is_stale(name, ttl))
            .cloned()
            .collect();

        let max_rows = self.auto_tier_config.max_rows;

        // Phase 1: fetch concurrently — futures borrow only the registry.
        let registry = &self.registry;
        let fetched: Vec<(String, EngineResult<Vec<RecordBatch>>)> =
            stream::iter(stale.into_iter().map(|name| async move {
                let result = Self::fetch_auto_tier_batches(registry, &name, max_rows).await;
                (name, result)
            }))
            .buffered(MAX_CONCURRENT_FETCHES)
            .collect()
            .await;

        // Phase 2: re-cache sequentially. If a table fails or is now too
        // large, remove it from auto-tier.
        for (name, result) in fetched {
            match result.and_then(|batches| self.store_auto_tier_result(&name, batches)) {
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
}

#[cfg(test)]
mod tests {
    use crate::test_fixtures::{make_star_schema_model, make_test_batch};
    use crate::{
        query_cache, sum_measure, AutoTierConfig, Column, DataModel, DataType, Engine,
        QueryCacheConfig, QueryRequest, Relationship, SourceBinding, StorageMode, Table,
    };

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

    // -- Deferred pre-warm tests --

    #[tokio::test]
    async fn query_auto_tier_cache_hit_skips_remaining_candidate_fetches() {
        // dim_products and dim_customers are auto-tier candidates with
        // bindings but NO registered connector, so any fetch attempt would
        // blow up. A query-cache hit must return without touching them:
        // pre-warming is deferred to an explicit auto_tier_remaining() call.
        let model = make_star_schema_model();
        let mut engine = Engine::new(model);
        engine.set_auto_tier_config(AutoTierConfig {
            enabled: true,
            ..Default::default()
        });
        engine.set_query_cache_config(QueryCacheConfig {
            enabled: true,
            ..Default::default()
        });
        engine
            .registry
            .bind("dim_products", 0, SourceBinding::new("public", "products"));
        engine.registry.bind(
            "dim_customers",
            0,
            SourceBinding::new("public", "customers"),
        );

        // Seed the query cache so the request below is a hit.
        let request = QueryRequest {
            measures: vec!["Revenue".into()],
            ..Default::default()
        };
        let key = query_cache::query_cache_key(
            &request,
            engine.query_cache.lock().model_version(),
            engine.effective_udfs.identity_hash(),
        );
        engine.query_cache.lock().put(key, vec![make_test_batch()]);

        let (batches, tiered) = engine.query_auto_tier(request).await.unwrap();

        // Served from cache; no remaining candidate was fetched, tiered, or
        // rejected.
        assert_eq!(batches.len(), 1);
        assert_eq!(batches[0].num_rows(), 3);
        assert!(tiered.is_empty());
        assert!(engine.auto_tiered_tables().is_empty());
        assert!(engine.auto_tier_rejected_tables().is_empty());

        // Both dimensions remain pending for a deferred pre-warm.
        let mut pending = engine.auto_tier_pending();
        pending.sort();
        assert_eq!(pending, vec!["dim_customers", "dim_products"]);
    }

    #[test]
    fn auto_tier_pending_lists_uncached_candidates() {
        let model = make_star_schema_model();
        let mut engine = Engine::new(model);
        engine.set_auto_tier_config(AutoTierConfig {
            enabled: true,
            ..Default::default()
        });
        engine
            .registry
            .bind("dim_products", 0, SourceBinding::new("public", "products"));

        assert_eq!(engine.auto_tier_pending(), vec!["dim_products"]);

        // Once cached, the table is no longer pending.
        engine
            .auto_tier_state
            .cached
            .insert("dim_products".to_string());
        assert!(engine.auto_tier_pending().is_empty());
    }

    #[tokio::test]
    async fn auto_tier_remaining_disabled_returns_empty() {
        let model = make_star_schema_model();
        let mut engine = Engine::new(model);
        // Auto-tier disabled (default): no candidates, no fetch attempts.
        let tiered = engine.auto_tier_remaining().await.unwrap();
        assert!(tiered.is_empty());
    }
}
