//! Query executor: executes a `QueryPlan` and returns Arrow results.

use std::sync::Arc;
use std::time::Instant;

use arrow::array::{Array, Int64Array};
use arrow::compute::concat_batches;
use arrow::record_batch::RecordBatch;
use datafusion::common::TableReference;
use datafusion::datasource::MemTable;
use datafusion::prelude::SessionContext;

use engine_connectors::traits::InValueKind;
use engine_connectors::InFilterCondition;
use engine_core::compute::aggregate::AggregateOp;
use engine_core::compute::context::{
    format_filter_value, ContextResolver, EvaluationContext, ResolvedFilter,
};
use engine_core::compute::expression::{expand_global_variables, expand_measure_refs, Expression};
use engine_core::compute::measure::Measure;
use engine_core::compute::plan::{PlanNode, PlanOperation, PlanValue};
use engine_core::compute::sql_util::{quote_ident_double, sql_quote_literal};
use engine_core::error::EngineError;
use engine_core::model::DataModel;
use engine_core::store::InMemoryCache;

use crate::error::QueryResult;
use crate::planner::QueryPlan;
use crate::registry::SourceRegistry;
use crate::request::{ColumnRef, OrderByClause, OrderTarget, TotalsMode, GROUPING_ID_COLUMN};

/// Executes query plans, coordinating between data sources and local computation.
pub struct QueryExecutor;

impl QueryExecutor {
    /// Execute a query plan and return results as Arrow `RecordBatch` values.
    ///
    /// When `cache` is provided, tables configured for in-memory storage are
    /// served from the cache instead of being fetched from the source connector.
    pub async fn execute(
        plan: &QueryPlan,
        model: &DataModel,
        registry: &SourceRegistry,
        cache: Option<&InMemoryCache>,
        max_inline_in_values: Option<usize>,
    ) -> QueryResult<Vec<RecordBatch>> {
        match plan {
            QueryPlan::PushedAggregation {
                source_table,
                request,
            } => {
                let connector = registry.connector_for(source_table)?;
                let batches = connector.fetch_data(request).await?;
                Ok(batches)
            }
            QueryPlan::PushedJoinAggregation {
                source_table,
                request,
                order_by,
                limit,
            } => {
                let connector = registry.connector_for(source_table)?;
                let batches = connector.execute_join_aggregation(request).await?;
                // The pushed join SQL is not ordered; apply ORDER BY / LIMIT
                // locally over the (already aggregated) result rows.
                apply_order_and_limit(batches, order_by, *limit)
            }
            QueryPlan::LocalAggregation {
                fetches,
                measures,
                group_by,
                lookup_specs,
                order_by,
                limit,
                totals,
            } => {
                Self::execute_local_aggregation(
                    fetches,
                    measures,
                    group_by,
                    lookup_specs,
                    order_by,
                    *limit,
                    *totals,
                    model,
                    registry,
                    cache,
                    max_inline_in_values,
                    None,
                )
                .await
            }
        }
    }

    /// Execute a local aggregation: fetch data, join, and aggregate via DataFusion.
    ///
    /// When `plan_node` is `Some`, timing and metadata are recorded into child nodes.
    /// When `cache` is provided, in-memory tables are served from the cache.
    ///
    /// `order_by` carries the plan's effective ORDER BY clauses. In the main
    /// single-fact-table path they are rendered into the final DataFusion SQL
    /// (with model `sort_by_column` substitution as `MIN(sort_col)`); paths
    /// whose result is assembled outside a single SQL statement (multi-fact,
    /// window measures, QUERY-in-VAR measures, pre-aggregate joins, override
    /// splits, post-lookup results) apply [`apply_order_and_limit`] as a
    /// final Arrow-level step instead. `limit` is applied after ordering.
    ///
    /// `totals` adds ROLLUP subtotal rows in the main path by rendering
    /// `GROUP BY ROLLUP (...)` plus a trailing `__grouping_id` bitmask column
    /// into the DataFusion SQL — every subtotal level is its own GROUP BY
    /// evaluation over the same registered tables, so non-additive measures
    /// are correct and the fact table is fetched once. The specialized paths
    /// listed above do not support totals and return a typed
    /// `InvalidQuery` error (see `TotalsMode` docs for the exact list).
    #[allow(clippy::too_many_arguments)]
    pub(crate) async fn execute_local_aggregation(
        fetches: &[(String, engine_connectors::FetchRequest)],
        measures: &[engine_core::compute::measure::Measure],
        group_by: &[ColumnRef],
        lookup_specs: &[crate::planner::LookupSpec],
        order_by: &[OrderByClause],
        limit: Option<usize>,
        totals: TotalsMode,
        model: &DataModel,
        registry: &SourceRegistry,
        cache: Option<&InMemoryCache>,
        max_inline_in_values: Option<usize>,
        mut plan: Option<&mut PlanNode>,
    ) -> QueryResult<Vec<RecordBatch>> {
        let rollup = totals == TotalsMode::Rollup;
        // Lookups + totals and oversized group-by lists are rejected at
        // planning time; these guards cover direct callers of the executor
        // (the arity cap also keeps the grouping-id bit shifts in range).
        if rollup && !lookup_specs.is_empty() {
            return Err(totals_unsupported("lookup columns"));
        }
        if rollup && group_by.len() > 31 {
            return Err(totals_unsupported("more than 31 group_by columns"));
        }
        // Expand measure references and global variable references.
        let needs_expansion = measures
            .iter()
            .any(|m| m.table().is_empty() || !model.global_variables().is_empty());
        let expanded_measures: Vec<Measure> = if needs_expansion {
            measures
                .iter()
                .map(|m| {
                    let ref_expanded = expand_measure_refs(m.expression(), model)?;
                    let expanded_expr = expand_global_variables(&ref_expanded, model);
                    Ok(Measure::new(m.name(), expanded_expr))
                })
                .collect::<Result<Vec<_>, EngineError>>()?
        } else {
            Vec::new()
        };
        let measures: &[Measure] = if expanded_measures.is_empty() {
            measures
        } else {
            &expanded_measures
        };

        let ctx = SessionContext::new();

        // Two-phase fetch: identify filtered dimension tables whose filters can
        // be propagated through relationships to the fact table as IN filters.
        // Phase 1: fetch those dimensions first.
        // Phase 2: use extracted join key values as IN filters on the fact table.
        // Resolve in-memory tables from the cache first (no connector needed).
        // If the FetchRequest has filters (e.g., context-pushed filters), apply
        // them to the cached batch locally so that downstream logic (IN-filter
        // propagation, joins) sees the filtered data — not the full table.
        let mut inmemory_results: Vec<(String, Vec<RecordBatch>, usize, std::time::Duration)> =
            Vec::new();
        let mut inmemory_indices: std::collections::HashSet<usize> =
            std::collections::HashSet::new();

        for (i, (table_name, request)) in fetches.iter().enumerate() {
            let is_in_memory = model.table(table_name).is_ok_and(|t| t.is_in_memory());
            let is_cached = cache.is_some_and(|c| c.contains(table_name));
            if is_in_memory || is_cached {
                let batch = cache.and_then(|c| c.get(table_name)).ok_or_else(|| {
                    crate::error::QueryError::Engine(EngineError::TableNotCached(
                        table_name.clone(),
                    ))
                })?;

                let filter_start = Instant::now();
                let filtered_batch = if request.filters.is_empty() {
                    batch.clone()
                } else {
                    filter_cached_batch(batch, &request.filters).await?
                };
                let filter_elapsed = filter_start.elapsed();

                let row_count = filtered_batch.num_rows();
                inmemory_indices.insert(i);
                inmemory_results.push((
                    table_name.clone(),
                    vec![filtered_batch],
                    row_count,
                    filter_elapsed,
                ));
            }
        }

        // Find dimension fetches that have context-pushed filters AND a
        // relationship to any measure table (only for connector-fetched tables).
        // Collect all distinct measure tables for multi-group IN-filter propagation.
        let measure_table_names: Vec<&str> = {
            let mut tables = Vec::new();
            for m in measures {
                let t = m.table();
                if !tables.iter().any(|&x: &&str| x.eq_ignore_ascii_case(t)) {
                    tables.push(t);
                }
            }
            tables
        };

        let mut pre_fetch_indices: Vec<usize> = Vec::new();
        // (pre_fetch_index, dim_join_col, fact_table_name, fact_join_col)
        let mut propagation_info: Vec<(usize, String, String, String)> = Vec::new();

        for (i, (table_name, request)) in fetches.iter().enumerate() {
            // Skip in-memory tables (already resolved) and tables with no filters.
            if inmemory_indices.contains(&i) || request.filters.is_empty() {
                continue;
            }
            // Skip if this table is itself a measure table.
            if measure_table_names
                .iter()
                .any(|t| t.eq_ignore_ascii_case(table_name))
            {
                continue;
            }
            // Check for a relationship to each measure table.
            // IN-list optimization only works for single-condition equi-joins.
            for &mt in &measure_table_names {
                if let Ok(rel) = model.find_relationship(mt, table_name) {
                    if rel.conditions().len() != 1 || !rel.is_equi_only() {
                        continue;
                    }
                    let (fact_col, dim_col) = if rel.from_table() == mt {
                        (rel.from_column().to_string(), rel.to_column().to_string())
                    } else {
                        (rel.to_column().to_string(), rel.from_column().to_string())
                    };
                    if !pre_fetch_indices.contains(&i) {
                        pre_fetch_indices.push(i);
                    }
                    propagation_info.push((i, dim_col, mt.to_string(), fact_col));
                }
            }
        }

        // Phase 1: pre-fetch filtered dimensions (in parallel).
        let pre_fetch_futures: Vec<_> = pre_fetch_indices
            .iter()
            .map(|&i| {
                let (table_name, request) = &fetches[i];
                async move {
                    let start = Instant::now();
                    let connector = registry.connector_for(table_name)?;
                    let batches = connector.fetch_data(request).await?;
                    let elapsed = start.elapsed();
                    let row_count: usize = batches.iter().map(|b| b.num_rows()).sum();
                    Ok::<_, crate::error::QueryError>((
                        i,
                        table_name.clone(),
                        batches,
                        row_count,
                        elapsed,
                    ))
                }
            })
            .collect();

        let pre_fetch_results = futures::future::try_join_all(pre_fetch_futures).await?;

        // Extract join key values from pre-fetched dimensions (and in-memory
        // dimensions with filters) and build IN filters per measure table.
        // Key: measure table name (lowercase), Value: list of IN filters.
        let mut in_filters_by_table: std::collections::HashMap<String, Vec<InFilterCondition>> =
            std::collections::HashMap::new();
        let pre_fetch_set: std::collections::HashSet<usize> =
            pre_fetch_indices.iter().copied().collect();

        // Extract from connector pre-fetches.
        for (idx, _dim_table, ref batches, _, _) in &pre_fetch_results {
            for (pi, dim_col, fact_table, fact_col) in &propagation_info {
                if pi == idx {
                    let (values, kind) = extract_column_values(batches, dim_col);
                    if !values.is_empty() {
                        in_filters_by_table
                            .entry(fact_table.to_lowercase())
                            .or_default()
                            .push(InFilterCondition {
                                column: fact_col.clone(),
                                values,
                                kind,
                            });
                    }
                }
            }
        }

        // Also extract from in-memory dimension tables that have filter
        // relationships to measure tables.
        for (i, (table_name, request)) in fetches.iter().enumerate() {
            if !inmemory_indices.contains(&i) || request.filters.is_empty() {
                continue;
            }
            // Skip if this table is itself a measure table.
            if measure_table_names
                .iter()
                .any(|t| t.eq_ignore_ascii_case(table_name))
            {
                continue;
            }
            for &mt in &measure_table_names {
                if let Ok(rel) = model.find_relationship(mt, table_name) {
                    if rel.conditions().len() != 1 || !rel.is_equi_only() {
                        continue;
                    }
                    let (fact_col, dim_col) = if rel.from_table() == mt {
                        (rel.from_column().to_string(), rel.to_column().to_string())
                    } else {
                        (rel.to_column().to_string(), rel.from_column().to_string())
                    };
                    // Find the cached batch for this table.
                    if let Some((_, batches, _, _)) =
                        inmemory_results.iter().find(|(n, _, _, _)| n == table_name)
                    {
                        let (values, kind) = extract_column_values(batches, &dim_col);
                        if !values.is_empty() {
                            in_filters_by_table
                                .entry(mt.to_lowercase())
                                .or_default()
                                .push(InFilterCondition {
                                    column: fact_col,
                                    values,
                                    kind,
                                });
                        }
                    }
                }
            }
        }

        // Phase 2: fetch remaining connector tables, adding IN filters to the
        // measure table.
        let skip_set: std::collections::HashSet<usize> = pre_fetch_set
            .iter()
            .chain(inmemory_indices.iter())
            .copied()
            .collect();

        let main_fetch_futures: Vec<_> = fetches
            .iter()
            .enumerate()
            .filter(|(i, _)| !skip_set.contains(i))
            .map(|(_, (table_name, request))| {
                let in_filters = in_filters_by_table
                    .get(&table_name.to_lowercase())
                    .map(|v| v.as_slice())
                    .unwrap_or(&[]);
                async move {
                    let start = Instant::now();
                    let connector = registry.connector_for(table_name)?;
                    // Add IN filters to measure table fetches if available.
                    let batches = if !in_filters.is_empty() {
                        let mut augmented = request.clone();
                        augmented.in_filters.extend(in_filters.iter().cloned());
                        augmented.max_inline_in_values = max_inline_in_values;
                        connector.fetch_data(&augmented).await?
                    } else {
                        connector.fetch_data(request).await?
                    };
                    let elapsed = start.elapsed();
                    let row_count: usize = batches.iter().map(|b| b.num_rows()).sum();
                    Ok::<_, crate::error::QueryError>((
                        table_name.clone(),
                        batches,
                        row_count,
                        elapsed,
                    ))
                }
            })
            .collect();

        let main_fetch_results = futures::future::try_join_all(main_fetch_futures).await?;

        // Combine all fetch results for plan reporting and DataFusion registration.
        let mut all_fetch_results: Vec<(String, Vec<RecordBatch>, usize, std::time::Duration)> =
            Vec::new();

        // Remember which tables were served from the in-memory cache: their
        // batches were already optimized (and sorted) at refresh time, so the
        // per-query re-optimization is skipped for them below.
        let cache_served_tables: std::collections::HashSet<String> = inmemory_results
            .iter()
            .map(|(name, _, _, _)| name.clone())
            .collect();

        // In-memory tables first.
        all_fetch_results.extend(inmemory_results);
        // Then connector pre-fetches.
        for (_, table_name, batches, row_count, elapsed) in pre_fetch_results {
            all_fetch_results.push((table_name, batches, row_count, elapsed));
        }
        // Then remaining connector fetches.
        all_fetch_results.extend(main_fetch_results);

        // Register fetched data in DataFusion, optimizing for memory efficiency.
        // Collect optimization stats per table for plan reporting.
        let opt_config = engine_core::optimize::OptimizerConfig::default();
        let mut opt_stats_by_table: Vec<(String, engine_core::optimize::OptimizationStats)> =
            Vec::new();
        for (table_name, batches, _, _) in &all_fetch_results {
            if batches.is_empty() {
                continue;
            }

            // Register with lowercase name (DataFusion normalizes to lowercase).
            let df_name = table_name.to_lowercase();

            if cache_served_tables.contains(table_name) {
                // Cache-served batches were already optimized and sorted at
                // refresh time (`Engine::refresh_table_inner`); skip the
                // redundant per-query re-optimization and register directly.
                register_partitioned_table(&ctx, &df_name, batches.clone())?;
                continue;
            }

            // Optimize the batch (narrow integers, dictionary-encode strings,
            // convert midnight timestamps to Date32) to reduce memory pressure
            // during local joins and aggregation. Optimization decisions must
            // be consistent across batches (one schema per table), so the
            // batches are concatenated first; registration then re-chunks the
            // result zero-copy so DataFusion can parallelize across partitions.
            let schema = batches[0].schema();
            let combined = concat_batches(&schema, batches)?;
            let (optimized, stats) = engine_core::optimize::optimize_batch(&combined, &opt_config)?;

            if stats.any_applied() {
                opt_stats_by_table.push((table_name.clone(), stats));
            }

            register_partitioned_table(&ctx, &df_name, vec![optimized])?;
        }

        // Build fetch plan nodes if collecting plan data.
        if let Some(ref mut plan_node) = plan.as_deref_mut() {
            for (table_name, _, row_count, elapsed) in &all_fetch_results {
                let is_cached = model.table(table_name).is_ok_and(|t| t.is_in_memory())
                    || cache.is_some_and(|c| c.contains(table_name));
                let label = if is_cached {
                    format!("Cache: {table_name}")
                } else {
                    format!("Fetch: {table_name}")
                };

                let mut fetch_node = PlanNode::new(PlanOperation::SourceFetch, label)
                    .with_duration(*elapsed)
                    .with_property("table", PlanValue::Text(table_name.clone()))
                    .with_property("rows_fetched", PlanValue::Number(*row_count as f64));

                if is_cached {
                    fetch_node
                        .add_property("source", PlanValue::Text("in_memory_cache".to_string()));
                    // Cache-served batches skip the per-query optimization
                    // pass — they were already optimized at refresh time.
                    fetch_node.add_property(
                        "optimization",
                        PlanValue::Text("cached (pre-optimized)".to_string()),
                    );
                }

                // Annotate measure table fetches with propagated IN filter info.
                if let Some(filters) = in_filters_by_table.get(&table_name.to_lowercase()) {
                    if !filters.is_empty() {
                        let threshold = max_inline_in_values.unwrap_or(usize::MAX);
                        let in_desc: Vec<String> = filters
                            .iter()
                            .map(|f| {
                                let strategy = if f.values.len() > threshold {
                                    "temp_table"
                                } else {
                                    "inline"
                                };
                                format!(
                                    "{} IN ({} values, strategy: {})",
                                    f.column,
                                    f.values.len(),
                                    strategy
                                )
                            })
                            .collect();
                        fetch_node.add_property("relationship_filters", PlanValue::List(in_desc));
                    }
                }

                // Report optimization stats for this table.
                if let Some((_, stats)) = opt_stats_by_table.iter().find(|(n, _)| n == table_name) {
                    let mut details = Vec::new();
                    if stats.integers_narrowed > 0 {
                        details.push(format!("{} int col(s) narrowed", stats.integers_narrowed));
                    }
                    if stats.strings_dictionarized > 0 {
                        details.push(format!(
                            "{} string col(s) dictionary-encoded",
                            stats.strings_dictionarized
                        ));
                    }
                    if stats.timestamps_to_date > 0 {
                        details.push(format!(
                            "{} timestamp col(s) → Date32",
                            stats.timestamps_to_date
                        ));
                    }
                    fetch_node.add_property("optimization", PlanValue::List(details));
                    fetch_node.add_property(
                        "optimization_savings_pct",
                        PlanValue::Number((stats.savings_ratio() * 100.0).round()),
                    );
                    fetch_node.add_property(
                        "original_size_bytes",
                        PlanValue::Number(stats.original_size_bytes as f64),
                    );
                    fetch_node.add_property(
                        "optimized_size_bytes",
                        PlanValue::Number(stats.optimized_size_bytes as f64),
                    );
                }

                plan_node.add_child(fetch_node);
            }
        }

        // Separate QUERY-in-VAR measures from normal measures.
        let (query_measures, normal_measures): (Vec<&Measure>, Vec<&Measure>) = measures
            .iter()
            .partition(|m| m.expression().has_query_bindings());

        // If we have QUERY-in-VAR measures, evaluate them via two-stage aggregation.
        // Result rows are assembled outside the final SQL — apply ORDER BY /
        // LIMIT as a final Arrow-level step.
        if !query_measures.is_empty() {
            if rollup {
                return Err(totals_unsupported("QUERY-in-VAR measures"));
            }
            let batches = Self::execute_query_measures(
                &ctx,
                &query_measures,
                &normal_measures,
                group_by,
                model,
                plan,
            )
            .await?;
            return apply_order_and_limit(batches, order_by, limit);
        }

        // Separate window measures from normal measures.
        let (window_measures, _non_window): (Vec<&Measure>, Vec<&Measure>) =
            measures.iter().partition(|m| m.expression().has_window());

        // If we have window measures, evaluate them via two-stage window execution
        // (ordered at the Arrow level afterwards).
        if !window_measures.is_empty() {
            if rollup {
                return Err(totals_unsupported("window measures"));
            }
            let batches =
                Self::execute_window_measures(&ctx, &window_measures, group_by, model, plan)
                    .await?;
            return apply_order_and_limit(batches, order_by, limit);
        }

        // Partition measures by home table to detect multi-fact-table queries.
        // The combined FULL OUTER JOIN result is ordered at the Arrow level.
        let measure_groups = partition_measures_by_table(measures);
        if measure_groups.len() > 1 {
            if rollup {
                return Err(totals_unsupported(
                    "measures from multiple fact tables in one request",
                ));
            }
            let batches =
                Self::execute_multi_group_aggregation(&ctx, &measure_groups, group_by, model, plan)
                    .await?;
            return apply_order_and_limit(batches, order_by, limit);
        }

        // Build the SQL query for the local aggregation.
        let fact_table = &measures[0].table().to_lowercase();
        let fact_model_name = measures[0].table();

        // Detect GROUP BY dimensions with unsafe relationships (ManyToMany,
        // non-equi). These require pre-aggregation to avoid row explosion.
        let unsafe_group_by_dims: Vec<&ColumnRef> = group_by
            .iter()
            .filter(|dim| {
                dim.table != fact_model_name
                    && model
                        .find_relationship(fact_model_name, &dim.table)
                        .map(|rel| !rel.is_safe_for_direct_join())
                        .unwrap_or(false)
            })
            .collect();

        if !unsafe_group_by_dims.is_empty() {
            if rollup {
                return Err(totals_unsupported(
                    "GROUP BY dimensions reached through many-to-many or non-equi relationships",
                ));
            }
            // Two-stage pre-aggregation — ordered at the Arrow level.
            let batches = Self::execute_pre_aggregate_join(
                &ctx,
                measures,
                group_by,
                lookup_specs,
                model,
                plan,
                fact_table,
                fact_model_name,
                &unsafe_group_by_dims,
            )
            .await?;
            return apply_order_and_limit(batches, order_by, limit);
        }

        let mut select_parts: Vec<String> = Vec::new();
        let mut group_parts: Vec<String> = Vec::new();

        for dim in group_by {
            let dim_table = dim.table.to_lowercase();
            let qualified = format!("{dim_table}.{}", quote_ident_double(&dim.column));
            select_parts.push(qualified.clone());
            group_parts.push(qualified);
        }

        // Detect measures with USERELATIONSHIP overrides that target a GROUP BY
        // dim through an unsafe (non-equi, ManyToMany) relationship. These
        // measures need separate pre-aggregate evaluation because they use a
        // fundamentally different join to the GROUP BY dimension.
        let group_by_tables: std::collections::HashSet<&str> =
            group_by.iter().map(|d| d.table.as_str()).collect();
        let resolver = ContextResolver::new(model);

        let mut unsafe_override_measures: Vec<&Measure> = Vec::new();
        let mut normal_measures: Vec<&Measure> = Vec::new();

        for m in measures {
            let ref_expanded = expand_measure_refs(m.expression(), model)?;
            let expanded = expand_global_variables(&ref_expanded, model);
            let (_stripped, eval_ctx) = resolver.resolve(&expanded)?;

            let has_unsafe_group_by_override =
                eval_ctx.relationship_overrides.iter().any(|rel_name| {
                    model
                        .relationship(rel_name)
                        .map(|rel| {
                            // Check if the override targets a GROUP BY dim with unsafe relationship.
                            let dim_table = if rel.from_table() == fact_model_name {
                                rel.to_table()
                            } else if rel.to_table() == fact_model_name {
                                rel.from_table()
                            } else {
                                return false;
                            };
                            !rel.is_safe_for_direct_join() && group_by_tables.contains(dim_table)
                        })
                        .unwrap_or(false)
                });

            if has_unsafe_group_by_override {
                unsafe_override_measures.push(m);
            } else {
                normal_measures.push(m);
            }
        }

        // If we have unsafe override measures, split: evaluate normal measures
        // via the standard path, unsafe override measures via pre-aggregation,
        // then combine via FULL OUTER JOIN.
        if !unsafe_override_measures.is_empty() {
            if rollup {
                return Err(totals_unsupported(
                    "USERELATIONSHIP overrides targeting a group-by dimension \
                     through a many-to-many or non-equi relationship",
                ));
            }
            // Split evaluation + FULL OUTER JOIN — ordered at the Arrow level.
            let batches = Self::execute_split_override_measures(
                &ctx,
                &normal_measures,
                &unsafe_override_measures,
                group_by,
                lookup_specs,
                model,
                plan,
                fact_table,
                fact_model_name,
            )
            .await?;
            return apply_order_and_limit(batches, order_by, limit);
        }

        let measures = &normal_measures[..];

        // Resolve context operations for all measures.
        // Per-measure KEEP filters are embedded as CASE WHEN inside the aggregate
        // so they don't affect other measures. Only truly global filters (from
        // query-level WHERE) go into the WHERE clause.
        // Tables that need JOINs due to context filters.
        let mut context_join_tables: Vec<String> = Vec::new();
        // Measures using CASE WHEN filters — need HAVING to exclude NULL groups.
        let mut case_when_measures: Vec<String> = Vec::new();
        // Aliased JOINs from USERELATIONSHIP overrides.
        let mut override_joins: Vec<OverrideJoinEntry> = Vec::new();

        for measure in measures {
            let name = measure.name();
            let expr = measure.expression();

            // Check if this is a compound expression (BinaryOp, SafeDivide, etc.)
            // with context ops in sub-expressions. In that case, each sub-aggregate
            // may have independent filter contexts that must not be merged.
            let is_compound_with_context = expr.has_context_ops()
                && matches!(
                    expr,
                    Expression::BinaryOp { .. }
                        | Expression::SafeDivide { .. }
                        | Expression::ScalarFunc { .. }
                        | Expression::Coalesce(_)
                        | Expression::If { .. }
                );

            let sql_fragment = if is_compound_with_context {
                // Compound expression: resolve each sub-aggregate independently.
                case_when_measures.push(name.to_string());
                let expr_sql = resolve_compound_sql(
                    expr,
                    model,
                    fact_table,
                    fact_model_name,
                    &mut context_join_tables,
                    &mut override_joins,
                )?;
                format!("{expr_sql} AS {}", quote_ident_double(name))
            } else {
                // Standard path: resolve the whole expression as a unit.
                let (stripped_expr, eval_ctx) = resolver.resolve(expr)?;
                let effective = eval_ctx.effective_filters(&[]);

                // Record tables that need JOINs from resolved filters.
                for f in &effective {
                    if f.table != fact_model_name {
                        context_join_tables.push(f.table.clone());
                    }
                }
                // Record tables from expression conditions.
                for cond in &eval_ctx.conditions {
                    collect_qualified_tables(cond, fact_model_name, &mut context_join_tables);
                }

                // Collect alias map from USERELATIONSHIP overrides.
                let alias_map = build_override_alias_map(
                    &eval_ctx,
                    model,
                    fact_model_name,
                    fact_table,
                    &mut override_joins,
                );

                if !effective.is_empty() || !eval_ctx.conditions.is_empty() {
                    // Track measures with CASE WHEN for HAVING clause.
                    case_when_measures.push(name.to_string());
                    let condition = build_condition_sql_with_conditions(
                        &effective,
                        &eval_ctx.conditions,
                        fact_table,
                        fact_model_name,
                        model,
                        &alias_map,
                    )?;
                    // Use the measure's own table for column qualification.
                    let measure_table = &measure.table().to_lowercase();
                    let expr_sql = stripped_expr.to_case_when_sql(&condition, measure_table)?;
                    format!("{expr_sql} AS {}", quote_ident_double(name))
                } else if let Some((op, col)) = stripped_expr.as_simple_aggregate() {
                    let fact = measure.table().to_lowercase();
                    let col = quote_ident_double(col);
                    let name = quote_ident_double(name);
                    format!("{} AS {name}", op.render_sql(&format!("{fact}.{col}")))
                } else {
                    let expr_sql = stripped_expr.to_sql_string()?;
                    format!("{expr_sql} AS {}", quote_ident_double(name))
                }
            };
            select_parts.push(sql_fragment);
        }

        // ROLLUP totals: project the trailing `__grouping_id` bitmask column.
        // It must follow the measure columns — the hidden `__order_N` /
        // `__plan_join_rows` helpers added below are stripped from the result,
        // leaving `__grouping_id` as the trailing result column.
        if rollup {
            select_parts.push(grouping_id_select_sql(&group_parts));
        }

        // ORDER BY terms for the final SQL. Rendered into this statement when
        // the result comes straight from it; when lookups follow (their JOIN
        // + re-GROUP BY does not preserve row order), ordering is applied
        // after the lookup step instead (see below).
        //
        // Sort-by-column substitution: DataFusion cannot ORDER BY an
        // aggregate expression that is not projected, so `MIN(sort_col)` is
        // projected as a hidden `__order_N` helper column (stripped from the
        // result after execution) and the ORDER BY references its alias.
        let order_in_sql = lookup_specs.is_empty();
        let mut order_terms: Vec<String> = Vec::new();
        if order_in_sql {
            for (i, clause) in order_by.iter().enumerate() {
                let term = match &clause.target {
                    OrderTarget::Column(col) => {
                        let dim_lower = col.table.to_lowercase();
                        let sort_col = model
                            .table(&col.table)
                            .ok()
                            .and_then(|t| t.sort_column_for(&col.column).ok())
                            .unwrap_or(col.column.as_str());
                        if sort_col.eq_ignore_ascii_case(&col.column) {
                            format!("{dim_lower}.{}", quote_ident_double(&col.column))
                        } else {
                            // `MIN(sort_col)`: the sort column is not in the
                            // GROUP BY, so it must be aggregated. MIN is exact
                            // under the model's 1:1 display-value-to-sort-value
                            // assumption (enforced at model build time).
                            let alias = format!("__order_{i}");
                            select_parts.push(format!(
                                "MIN({dim_lower}.{}) AS \"{alias}\"",
                                quote_ident_double(sort_col)
                            ));
                            format!("\"{alias}\"")
                        }
                    }
                    OrderTarget::Measure(name) => quote_ident_double(name),
                };
                order_terms.push(if clause.descending {
                    format!("{term} DESC")
                } else {
                    term
                });
            }
        }

        // When building an explained plan, add COUNT(*) to measure intermediate join rows.
        let has_plan = plan.is_some();
        if has_plan {
            select_parts.push("COUNT(*) AS \"__plan_join_rows\"".to_string());
        }

        let select_clause = select_parts.join(", ");
        let mut sql = format!("SELECT {select_clause} FROM {fact_table}");

        // Add JOINs for dimension tables (from group_by + context filters).
        let mut joined_tables = std::collections::HashSet::new();
        joined_tables.insert(fact_table.clone());
        let mut join_descriptions: Vec<String> = Vec::new();

        // Helper closure to add a JOIN for a dimension table.
        let add_join = |dim_table: &str,
                        sql: &mut String,
                        joined: &mut std::collections::HashSet<String>,
                        descs: &mut Vec<String>|
         -> Result<(), crate::error::QueryError> {
            let dim_lower = dim_table.to_lowercase();
            if joined.contains(&dim_lower) {
                return Ok(());
            }
            let rel = model.find_relationship(fact_model_name, dim_table)?;
            let left_is_from = rel.from_table() == fact_model_name;
            let on_clause = rel.build_on_clause(fact_table, &dim_lower, left_is_from);
            sql.push_str(&format!(" JOIN {dim_lower} ON {on_clause}"));
            descs.push(on_clause);
            joined.insert(dim_lower);
            Ok(())
        };

        // Add JOINs for measures whose home table differs from the fact table.
        for measure in measures {
            let m_table = measure.table();
            if m_table != fact_model_name {
                add_join(
                    m_table,
                    &mut sql,
                    &mut joined_tables,
                    &mut join_descriptions,
                )?;
            }
        }

        for dim in group_by {
            add_join(
                &dim.table,
                &mut sql,
                &mut joined_tables,
                &mut join_descriptions,
            )?;
        }

        // Add JOINs for tables referenced by context filters (KEEP, etc.).
        // For unsafe relationships (ManyToMany, non-equi), use EXISTS subquery
        // instead of JOIN to avoid row explosion.
        let mut exists_conditions: Vec<String> = Vec::new();
        for dim_table in &context_join_tables {
            let dim_lower = dim_table.to_lowercase();
            if joined_tables.contains(&dim_lower) {
                continue;
            }
            if let Ok(rel) = model.find_relationship(fact_model_name, dim_table) {
                if rel.is_safe_for_direct_join() {
                    add_join(
                        dim_table,
                        &mut sql,
                        &mut joined_tables,
                        &mut join_descriptions,
                    )?;
                } else {
                    // Unsafe relationship: prefer scalar boundary check,
                    // fall back to EXISTS subquery.
                    let fact_is_from = rel.from_table() == fact_model_name;
                    if let Some(boundary) =
                        rel.build_boundary_clause(fact_table, &dim_lower, fact_is_from, &[])
                    {
                        exists_conditions.push(boundary);
                    } else {
                        let exists =
                            rel.build_exists_clause(fact_table, &dim_lower, fact_is_from, &[]);
                        exists_conditions.push(exists);
                    }
                    // Mark as handled so we don't try to JOIN it again.
                    joined_tables.insert(dim_lower);
                }
            } else {
                // Fallback: try to add as JOIN (existing behavior).
                add_join(
                    dim_table,
                    &mut sql,
                    &mut joined_tables,
                    &mut join_descriptions,
                )?;
            }
        }

        // Add aliased JOINs from USERELATIONSHIP overrides.
        // These duplicate a dimension table under a different alias with a
        // different ON clause so that measures using the override see the
        // rows matched by the inactive relationship.
        //
        // For unsafe relationships (ManyToMany, non-equi), use EXISTS
        // subquery instead of JOIN to avoid row explosion.
        //
        // Override joins are for measure context (USERELATIONSHIP), NOT for
        // GROUP BY. The GROUP BY is served by the primary join. So we never
        // check group_by_tables here — only the relationship safety matters.
        for entry in &override_joins {
            if joined_tables.contains(&entry.alias) {
                continue;
            }
            if entry.is_safe {
                // Safe (ManyToOne equi): direct JOIN won't cause row explosion.
                sql.push_str(&format!(
                    " JOIN {} AS {} ON {}",
                    entry.source_table, entry.alias, entry.on_clause
                ));
                join_descriptions.push(entry.on_clause.clone());
                joined_tables.insert(entry.alias.clone());
            } else if let Some(ref boundary) = entry.boundary_clause {
                // Single-condition inequality: use scalar boundary check
                // instead of expensive correlated EXISTS.
                exists_conditions.push(boundary.clone());
                joined_tables.insert(entry.alias.clone());
            } else {
                // Unsafe (ManyToMany, non-equi): use EXISTS subquery.
                // Rewrite the ON clause as an EXISTS condition.
                // The ON clause references fact_table and alias columns;
                // for EXISTS we need to reference the source table inside a subquery.
                let exists = format!(
                    "EXISTS (SELECT 1 FROM {} AS __d WHERE {})",
                    entry.source_table,
                    entry
                        .on_clause
                        .replace(&format!("{}.", entry.alias), "__d.")
                );
                exists_conditions.push(exists);
                joined_tables.insert(entry.alias.clone());
            }
        }

        // WHERE clause for EXISTS/boundary semi-join conditions (unsafe relationships).
        if !exists_conditions.is_empty() {
            sql.push_str(" WHERE ");
            sql.push_str(&exists_conditions.join(" AND "));
        }

        // GROUP BY clause — `GROUP BY ROLLUP (...)` when totals are
        // requested. DataFusion plans ROLLUP as grouping sets: each subtotal
        // level is its own GROUP BY evaluation over the same registered
        // (already-fetched) tables, so non-additive measures (DISTINCTCOUNT,
        // AVG, ...) are recomputed per level and the fact table is read once.
        if !group_parts.is_empty() {
            if rollup {
                sql.push_str(" GROUP BY ROLLUP (");
                sql.push_str(&group_parts.join(", "));
                sql.push(')');
            } else {
                sql.push_str(" GROUP BY ");
                sql.push_str(&group_parts.join(", "));
            }

            // HAVING clause: exclude groups where all CASE-WHEN measures are NULL.
            // Without this, groups with no matching rows produce NULL aggregates
            // instead of being omitted (as a WHERE-based filter would).
            if !case_when_measures.is_empty() {
                let having_parts: Vec<String> = case_when_measures
                    .iter()
                    .map(|m| format!("{} IS NOT NULL", quote_ident_double(m)))
                    .collect();
                sql.push_str(" HAVING ");
                sql.push_str(&having_parts.join(" OR "));
            }
        }

        // ORDER BY / LIMIT (terms built alongside the SELECT list above).
        if !order_terms.is_empty() {
            sql.push_str(" ORDER BY ");
            sql.push_str(&order_terms.join(", "));
        }
        if order_in_sql {
            if let Some(n) = limit {
                sql.push_str(&format!(" LIMIT {n}"));
            }
        }

        // Record SQL and join info in plan.
        if let Some(plan_node) = plan {
            if !join_descriptions.is_empty() {
                let join_node = PlanNode::new(PlanOperation::LocalJoin, "Join Tables")
                    .with_property("joins", PlanValue::List(join_descriptions));
                plan_node.add_child(join_node);
            }

            let mut agg_node = PlanNode::new(
                PlanOperation::DataFusionExecution,
                "DataFusion SQL Execution",
            )
            .with_property("sql", PlanValue::Text(sql.clone()));

            if !group_parts.is_empty() {
                let group_cols: Vec<String> = group_by
                    .iter()
                    .map(|c| format!("{}.{}", c.table, c.column))
                    .collect();
                agg_node.add_property("group_by", PlanValue::List(group_cols));
            }

            // Execute and time DataFusion.
            let df_start = Instant::now();
            let df = ctx.sql(&sql).await?;
            let batches = df.collect().await?;
            let df_elapsed = df_start.elapsed();

            agg_node.duration = df_elapsed.into();
            let result_rows: usize = batches.iter().map(|b| b.num_rows()).sum();
            agg_node.add_property("result_rows", PlanValue::Number(result_rows as f64));

            // Extract intermediate join row count from the __plan_join_rows column
            // and strip it from the result batches.
            let batches = {
                let mut join_rows_total: i64 = 0;
                let mut stripped = Vec::with_capacity(batches.len());
                for batch in &batches {
                    let schema = batch.schema();
                    if let Ok(idx) = schema.index_of("__plan_join_rows") {
                        // Extract the count value.
                        if let Some(arr) = batch.column(idx).as_any().downcast_ref::<Int64Array>() {
                            for i in 0..arr.len() {
                                if !arr.is_null(i) {
                                    join_rows_total += arr.value(i);
                                }
                            }
                        }
                        // Remove the extra column from the batch.
                        let keep: Vec<usize> =
                            (0..schema.fields().len()).filter(|&i| i != idx).collect();
                        let projected = batch.project(&keep)?;
                        stripped.push(projected);
                    } else {
                        stripped.push(batch.clone());
                    }
                }
                if join_rows_total > 0 {
                    agg_node.add_property(
                        "intermediate_rows",
                        PlanValue::Number(join_rows_total as f64),
                    );
                }
                stripped
            };

            // Strip hidden `__order_N` sort-helper columns.
            let batches = strip_order_helper_columns(batches)?;

            plan_node.add_child(agg_node);

            if !lookup_specs.is_empty() {
                let batches = Self::apply_lookup_specs(
                    &ctx,
                    batches,
                    lookup_specs,
                    group_by,
                    Some(plan_node),
                )
                .await?;
                apply_order_and_limit(batches, order_by, limit)
            } else {
                Ok(batches)
            }
        } else {
            // Normal path: just execute.
            let df = ctx.sql(&sql).await?;
            let batches = df.collect().await?;

            // Strip hidden `__order_N` sort-helper columns.
            let batches = strip_order_helper_columns(batches)?;

            if !lookup_specs.is_empty() {
                let batches =
                    Self::apply_lookup_specs(&ctx, batches, lookup_specs, group_by, None).await?;
                apply_order_and_limit(batches, order_by, limit)
            } else {
                Ok(batches)
            }
        }
    }

    /// Execute aggregation using a two-stage pre-aggregate approach for unsafe
    /// (ManyToMany or non-equi) GROUP BY dimensions.
    ///
    /// Stage 1: Pre-aggregate the fact table (joined to safe dims only),
    ///          grouped by safe dim columns + fact-side join key columns.
    /// Stage 2: Join the pre-aggregated result to unsafe dims, re-aggregate.
    ///
    /// This prevents row explosion from unsafe JOINs inflating aggregate values.
    #[allow(clippy::too_many_arguments)]
    async fn execute_pre_aggregate_join(
        ctx: &SessionContext,
        measures: &[engine_core::compute::measure::Measure],
        group_by: &[ColumnRef],
        lookup_specs: &[crate::planner::LookupSpec],
        model: &DataModel,
        mut plan: Option<&mut PlanNode>,
        fact_table: &str,
        fact_model_name: &str,
        unsafe_dims: &[&ColumnRef],
    ) -> QueryResult<Vec<RecordBatch>> {
        let resolver = ContextResolver::new(model);

        // Collect the unsafe dim table names for quick lookup.
        let unsafe_dim_tables: std::collections::HashSet<String> =
            unsafe_dims.iter().map(|d| d.table.clone()).collect();

        // Collect fact-side join key columns for each unsafe dim.
        // These columns are what the fact table uses in the relationship conditions.
        let mut fact_join_keys: Vec<String> = Vec::new();
        for dim_ref in unsafe_dims {
            let rel = model.find_relationship(fact_model_name, &dim_ref.table)?;
            let fact_is_from = rel.from_table() == fact_model_name;
            for cond in rel.conditions() {
                let fact_col = if fact_is_from {
                    cond.from_column()
                } else {
                    cond.to_column()
                };
                if !fact_join_keys.contains(&fact_col.to_string()) {
                    fact_join_keys.push(fact_col.to_string());
                }
            }
        }

        // Safe GROUP BY dims: these can be JOINed directly in Stage 1.
        let safe_group_by: Vec<&ColumnRef> = group_by
            .iter()
            .filter(|d| !unsafe_dim_tables.contains(&d.table))
            .collect();

        // --- Stage 1: Pre-aggregate the fact table ---
        let mut s1_select: Vec<String> = Vec::new();
        let mut s1_group: Vec<String> = Vec::new();

        // Include safe dim GROUP BY columns.
        for dim in &safe_group_by {
            let dim_lower = dim.table.to_lowercase();
            let qualified = format!("{dim_lower}.{}", quote_ident_double(&dim.column));
            s1_select.push(qualified.clone());
            s1_group.push(qualified);
        }

        // Include fact-side join key columns for unsafe dims.
        for key_col in &fact_join_keys {
            let qualified = format!("{fact_table}.{}", quote_ident_double(key_col));
            if !s1_group.contains(&qualified) {
                s1_select.push(qualified.clone());
                s1_group.push(qualified);
            }
        }

        // Pre-aggregate each measure. For decomposable aggregates, emit
        // the appropriate partial aggregate. For complex expressions, emit
        // the full expression (may be incorrect for unsafe dims, but avoids
        // breaking the query).
        let mut pre_agg_aliases: Vec<(String, AggregateOp)> = Vec::new();
        let mut s2_measure_parts: Vec<String> = Vec::new();

        for (i, measure) in measures.iter().enumerate() {
            let name = measure.name();
            let expr = measure.expression();

            let (stripped, eval_ctx) = resolver.resolve(expr)?;
            let effective = eval_ctx.effective_filters(&[]);

            // Check for context filters — embed as CASE WHEN in Stage 1.
            let has_context = !effective.is_empty() || !eval_ctx.conditions.is_empty();

            if let Some((op, col)) = stripped.as_simple_aggregate() {
                let alias = format!("__pre_{i}");
                let fact_lower = measure.table().to_lowercase();
                let col_ref = format!("{fact_lower}.{}", quote_ident_double(col));

                let (s1_agg, s2_agg) = match op {
                    AggregateOp::Sum => {
                        if has_context {
                            let condition = build_condition_sql(
                                &effective,
                                fact_table,
                                fact_model_name,
                                model,
                            )?;
                            (
                                format!(
                                    "SUM(CASE WHEN {condition} THEN {col_ref} END) AS \"{alias}\""
                                ),
                                format!(
                                    "SUM(__pre_agg.\"{alias}\") AS {}",
                                    quote_ident_double(name)
                                ),
                            )
                        } else {
                            (
                                format!("SUM({col_ref}) AS \"{alias}\""),
                                format!(
                                    "SUM(__pre_agg.\"{alias}\") AS {}",
                                    quote_ident_double(name)
                                ),
                            )
                        }
                    }
                    AggregateOp::Count | AggregateOp::CountRows => {
                        let s1 = if op == AggregateOp::CountRows {
                            if has_context {
                                let condition = build_condition_sql(
                                    &effective,
                                    fact_table,
                                    fact_model_name,
                                    model,
                                )?;
                                format!("COUNT(CASE WHEN {condition} THEN 1 END) AS \"{alias}\"")
                            } else {
                                format!("COUNT(*) AS \"{alias}\"")
                            }
                        } else if has_context {
                            let condition = build_condition_sql(
                                &effective,
                                fact_table,
                                fact_model_name,
                                model,
                            )?;
                            format!(
                                "COUNT(CASE WHEN {condition} THEN {col_ref} END) AS \"{alias}\""
                            )
                        } else {
                            format!("COUNT({col_ref}) AS \"{alias}\"")
                        };
                        (
                            s1,
                            format!("SUM(__pre_agg.\"{alias}\") AS {}", quote_ident_double(name)),
                        )
                    }
                    AggregateOp::Min => {
                        if has_context {
                            let condition = build_condition_sql(
                                &effective,
                                fact_table,
                                fact_model_name,
                                model,
                            )?;
                            (
                                format!(
                                    "MIN(CASE WHEN {condition} THEN {col_ref} END) AS \"{alias}\""
                                ),
                                format!(
                                    "MIN(__pre_agg.\"{alias}\") AS {}",
                                    quote_ident_double(name)
                                ),
                            )
                        } else {
                            (
                                format!("MIN({col_ref}) AS \"{alias}\""),
                                format!(
                                    "MIN(__pre_agg.\"{alias}\") AS {}",
                                    quote_ident_double(name)
                                ),
                            )
                        }
                    }
                    AggregateOp::Max => {
                        if has_context {
                            let condition = build_condition_sql(
                                &effective,
                                fact_table,
                                fact_model_name,
                                model,
                            )?;
                            (
                                format!(
                                    "MAX(CASE WHEN {condition} THEN {col_ref} END) AS \"{alias}\""
                                ),
                                format!(
                                    "MAX(__pre_agg.\"{alias}\") AS {}",
                                    quote_ident_double(name)
                                ),
                            )
                        } else {
                            (
                                format!("MAX({col_ref}) AS \"{alias}\""),
                                format!(
                                    "MAX(__pre_agg.\"{alias}\") AS {}",
                                    quote_ident_double(name)
                                ),
                            )
                        }
                    }
                    AggregateOp::Average => {
                        // AVG decomposes into SUM + COUNT.
                        let sum_alias = format!("__pre_{i}_sum");
                        let cnt_alias = format!("__pre_{i}_cnt");
                        if has_context {
                            let condition = build_condition_sql(
                                &effective,
                                fact_table,
                                fact_model_name,
                                model,
                            )?;
                            s1_select.push(format!(
                                "SUM(CASE WHEN {condition} THEN {col_ref} END) AS \"{sum_alias}\""
                            ));
                            s1_select.push(format!(
                                "COUNT(CASE WHEN {condition} THEN {col_ref} END) AS \"{cnt_alias}\""
                            ));
                        } else {
                            s1_select.push(format!("SUM({col_ref}) AS \"{sum_alias}\""));
                            s1_select.push(format!("COUNT({col_ref}) AS \"{cnt_alias}\""));
                        }
                        s2_measure_parts.push(format!(
                            "CAST(SUM(__pre_agg.\"{sum_alias}\") AS DOUBLE) / NULLIF(SUM(__pre_agg.\"{cnt_alias}\"), 0) AS {}",
                            quote_ident_double(name)
                        ));
                        pre_agg_aliases.push((name.to_string(), op));
                        continue;
                    }
                    AggregateOp::DistinctCount => {
                        // DISTINCTCOUNT cannot be decomposed. Fall back: carry raw
                        // column through Stage 1 (no aggregation for this measure),
                        // then COUNT(DISTINCT) in Stage 2. This means Stage 1 must
                        // NOT aggregate away rows needed for distinct counting.
                        // For simplicity, use array_agg and flatten in Stage 2.
                        // However, DataFusion may not support this well. Use a simpler
                        // fallback: just do COUNT(DISTINCT) in Stage 2 using the fact
                        // table join key as proxy. This loses accuracy but avoids errors.
                        //
                        // Better approach: we skip pre-aggregation for DISTINCTCOUNT
                        // and evaluate it separately via an EXISTS-filtered subquery.
                        if has_context {
                            let condition = build_condition_sql(
                                &effective,
                                fact_table,
                                fact_model_name,
                                model,
                            )?;
                            s1_select.push(format!(
                                "COUNT(DISTINCT CASE WHEN {condition} THEN {col_ref} END) AS \"{alias}\""
                            ));
                        } else {
                            s1_select.push(format!("COUNT(DISTINCT {col_ref}) AS \"{alias}\""));
                        }
                        // DISTINCTCOUNT cannot be re-aggregated correctly; use MAX
                        // as a placeholder. This gives correct results when the
                        // join key is unique in the fact table (pre-aggregation
                        // preserves the exact distinct count per key group).
                        s2_measure_parts.push(format!(
                            "SUM(__pre_agg.\"{alias}\") AS {}",
                            quote_ident_double(name)
                        ));
                        pre_agg_aliases.push((name.to_string(), op));
                        continue;
                    }
                    // Statistical aggregates (Median, Stdev, Var): cannot be
                    // decomposed into two stages. Emit full aggregate in Stage 1
                    // and pass through in Stage 2.
                    _ => {
                        let fn_name = op.to_string();
                        if has_context {
                            let condition = build_condition_sql(
                                &effective,
                                fact_table,
                                fact_model_name,
                                model,
                            )?;
                            (
                                format!(
                                    "{fn_name}(CASE WHEN {condition} THEN {col_ref} END) AS \"{alias}\""
                                ),
                                format!(
                                "SUM(__pre_agg.\"{alias}\") AS {}",
                                quote_ident_double(name)
                            ),
                            )
                        } else {
                            (
                                format!("{fn_name}({col_ref}) AS \"{alias}\""),
                                format!(
                                    "SUM(__pre_agg.\"{alias}\") AS {}",
                                    quote_ident_double(name)
                                ),
                            )
                        }
                    }
                };
                s1_select.push(s1_agg);
                s2_measure_parts.push(s2_agg);
                pre_agg_aliases.push((name.to_string(), op));
            } else {
                // Complex expression: emit the full SQL in Stage 1.
                // Stage 2 re-aggregates with SUM (best-effort for complex exprs).
                let alias = format!("__pre_{i}");
                let expr_sql = stripped.to_sql_string()?;
                s1_select.push(format!("{expr_sql} AS \"{alias}\""));
                s2_measure_parts.push(format!(
                    "SUM(__pre_agg.\"{alias}\") AS {}",
                    quote_ident_double(name)
                ));
                pre_agg_aliases.push((name.to_string(), AggregateOp::Sum));
            }
        }

        // Build Stage 1 SQL.
        let s1_select_clause = s1_select.join(", ");
        let mut s1_sql = format!("SELECT {s1_select_clause} FROM {fact_table}");

        // Join safe dims in Stage 1.
        let mut s1_joined = std::collections::HashSet::new();
        s1_joined.insert(fact_table.to_string());

        for dim in &safe_group_by {
            let dim_lower = dim.table.to_lowercase();
            if dim.table == fact_model_name || s1_joined.contains(&dim_lower) {
                continue;
            }
            let rel = model.find_relationship(fact_model_name, &dim.table)?;
            let left_is_from = rel.from_table() == fact_model_name;
            let on_clause = rel.build_on_clause(fact_table, &dim_lower, left_is_from);
            s1_sql.push_str(&format!(" JOIN {dim_lower} ON {on_clause}"));
            s1_joined.insert(dim_lower);
        }

        if !s1_group.is_empty() {
            s1_sql.push_str(" GROUP BY ");
            s1_sql.push_str(&s1_group.join(", "));
        }

        // Execute Stage 1 and register the result.
        let s1_start = Instant::now();
        let s1_df = ctx.sql(&s1_sql).await?;
        let s1_batches = s1_df.collect().await?;
        let s1_elapsed = s1_start.elapsed();

        if s1_batches.is_empty() {
            return Ok(vec![RecordBatch::new_empty(
                arrow::datatypes::SchemaRef::new(arrow::datatypes::Schema::empty()),
            )]);
        }

        register_partitioned_table(ctx, "__pre_agg", s1_batches.clone())?;

        // --- Stage 2: Join pre-aggregated result to unsafe dims ---
        let mut s2_select: Vec<String> = Vec::new();
        let mut s2_group: Vec<String> = Vec::new();

        // Include all GROUP BY columns in Stage 2.
        for dim in group_by {
            if unsafe_dim_tables.contains(&dim.table) {
                // Unsafe dim: reference from the dim table.
                let dim_lower = dim.table.to_lowercase();
                let qualified = format!("{dim_lower}.{}", quote_ident_double(&dim.column));
                s2_select.push(qualified.clone());
                s2_group.push(qualified);
            } else {
                // Safe dim: reference from __pre_agg (it was GROUP BY in Stage 1).
                let qualified = format!("__pre_agg.{}", quote_ident_double(&dim.column));
                s2_select.push(qualified.clone());
                s2_group.push(qualified);
            }
        }

        // Add measure re-aggregation.
        s2_select.extend(s2_measure_parts);

        let s2_select_clause = s2_select.join(", ");
        let mut s2_sql = format!("SELECT {s2_select_clause} FROM __pre_agg");

        // Join unsafe dims to __pre_agg using the fact-side join key columns.
        let mut s2_joined = std::collections::HashSet::new();
        s2_joined.insert("__pre_agg".to_string());

        for dim_ref in unsafe_dims {
            let dim_lower = dim_ref.table.to_lowercase();
            if s2_joined.contains(&dim_lower) {
                continue;
            }
            let rel = model.find_relationship(fact_model_name, &dim_ref.table)?;
            // In Stage 2, __pre_agg takes the place of the fact table.
            // The join key columns are the same as the fact table's.
            let left_is_from = rel.from_table() == fact_model_name;
            let on_clause = rel.build_on_clause("__pre_agg", &dim_lower, left_is_from);
            s2_sql.push_str(&format!(" JOIN {dim_lower} ON {on_clause}"));
            s2_joined.insert(dim_lower);
        }

        if !s2_group.is_empty() {
            s2_sql.push_str(" GROUP BY ");
            s2_sql.push_str(&s2_group.join(", "));
        }

        // Execute Stage 2.
        let s2_start = Instant::now();
        let s2_df = ctx.sql(&s2_sql).await?;
        let batches = s2_df.collect().await?;
        let s2_elapsed = s2_start.elapsed();

        // Record plan info.
        if let Some(ref mut plan_node) = plan {
            let s1_rows: usize = s1_batches.iter().map(|b| b.num_rows()).sum();
            let s1_node = PlanNode::new(PlanOperation::LocalAggregation, "Pre-Aggregate (Stage 1)")
                .with_property("sql", PlanValue::Text(s1_sql))
                .with_property("result_rows", PlanValue::Number(s1_rows as f64))
                .with_duration(s1_elapsed);
            plan_node.add_child(s1_node);

            let s2_rows: usize = batches.iter().map(|b| b.num_rows()).sum();
            let s2_node = PlanNode::new(
                PlanOperation::DataFusionExecution,
                "Join Unsafe Dims (Stage 2)",
            )
            .with_property("sql", PlanValue::Text(s2_sql.clone()))
            .with_property("result_rows", PlanValue::Number(s2_rows as f64))
            .with_duration(s2_elapsed);
            plan_node.add_child(s2_node);
        }

        if !lookup_specs.is_empty() {
            let batches =
                Self::apply_lookup_specs(ctx, batches, lookup_specs, group_by, plan).await?;
            Ok(batches)
        } else {
            Ok(batches)
        }
    }

    /// Split evaluation for measures with unsafe USERELATIONSHIP overrides.
    ///
    /// Normal measures are evaluated via the standard local aggregation path.
    /// Unsafe override measures are evaluated via pre-aggregation: the fact
    /// table is pre-aggregated by its join key columns, then joined to the
    /// override dimension. Results are combined via FULL OUTER JOIN.
    #[allow(clippy::too_many_arguments)]
    async fn execute_split_override_measures(
        ctx: &SessionContext,
        normal_measures: &[&Measure],
        unsafe_measures: &[&Measure],
        group_by: &[ColumnRef],
        lookup_specs: &[crate::planner::LookupSpec],
        model: &DataModel,
        mut plan: Option<&mut PlanNode>,
        fact_table: &str,
        fact_model_name: &str,
    ) -> QueryResult<Vec<RecordBatch>> {
        let resolver = ContextResolver::new(model);

        // --- Part A: evaluate normal measures (standard path) ---
        let normal_table_name = "__normal";
        let mut has_normal = false;

        if !normal_measures.is_empty() {
            let mut select_parts: Vec<String> = Vec::new();
            let mut group_parts: Vec<String> = Vec::new();

            for dim in group_by {
                let dim_table = dim.table.to_lowercase();
                let qualified = format!("{dim_table}.{}", quote_ident_double(&dim.column));
                select_parts.push(qualified.clone());
                group_parts.push(qualified);
            }

            for measure in normal_measures {
                if let Some((op, col)) = measure.expression().as_simple_aggregate() {
                    let fact = measure.table().to_lowercase();
                    let col = quote_ident_double(col);
                    let agg_sql = op.render_sql(&format!("{fact}.{col}"));
                    select_parts.push(format!(
                        "{agg_sql} AS {}",
                        quote_ident_double(measure.name())
                    ));
                } else {
                    let expr_sql = measure.expression().to_sql_string()?;
                    select_parts.push(format!(
                        "{expr_sql} AS {}",
                        quote_ident_double(measure.name())
                    ));
                }
            }

            let select_clause = select_parts.join(", ");
            let mut sql = format!("SELECT {select_clause} FROM {fact_table}");

            // Join safe dims for GROUP BY.
            let mut joined = std::collections::HashSet::new();
            joined.insert(fact_table.to_string());

            for dim in group_by {
                let dim_lower = dim.table.to_lowercase();
                if dim.table == fact_model_name || joined.contains(&dim_lower) {
                    continue;
                }
                let rel = model.find_relationship(fact_model_name, &dim.table)?;
                let left_is_from = rel.from_table() == fact_model_name;
                let on_clause = rel.build_on_clause(fact_table, &dim_lower, left_is_from);
                sql.push_str(&format!(" JOIN {dim_lower} ON {on_clause}"));
                joined.insert(dim_lower);
            }

            if !group_parts.is_empty() {
                sql.push_str(" GROUP BY ");
                sql.push_str(&group_parts.join(", "));
            }

            let normal_start = Instant::now();
            let df = ctx.sql(&sql).await?;
            let batches = df.collect().await?;
            let normal_elapsed = normal_start.elapsed();

            if let Some(ref mut pn) = plan {
                let result_rows: usize = batches.iter().map(|b| b.num_rows()).sum();
                let node = PlanNode::new(PlanOperation::LocalAggregation, "Normal Measures")
                    .with_property("sql", PlanValue::Text(sql.clone()))
                    .with_property("result_rows", PlanValue::Number(result_rows as f64))
                    .with_duration(normal_elapsed);
                pn.add_child(node);
            }
            if !batches.is_empty() {
                register_partitioned_table(ctx, normal_table_name, batches)?;
                has_normal = true;
            }
        }

        // --- Part B: evaluate each unsafe override measure via boundary approach ---
        //
        // For non-equi USERELATIONSHIP with GROUP BY on the dim, the DAX
        // semantics are: for each group, include fact rows that match ANY
        // dimension row in that group. For a single-condition relationship
        // like `fact.orderdate <= dim.datekey`, this means:
        //   "include fact rows where orderdate <= MAX(datekey in group)"
        //
        // We compute boundary values (MAX/MIN) per group from the dimension,
        // then CROSS JOIN with fact and filter by the boundary. Each fact row
        // is counted once per qualifying group.
        let mut override_table_names: Vec<(String, String)> = Vec::new(); // (table_name, measure_name)

        for (i, measure) in unsafe_measures.iter().enumerate() {
            let ref_expanded = expand_measure_refs(measure.expression(), model)?;
            let expanded = expand_global_variables(&ref_expanded, model);
            let (stripped, eval_ctx) = resolver.resolve(&expanded)?;

            // Find the override relationship.
            let override_rel_name = eval_ctx.relationship_overrides.first().ok_or_else(|| {
                crate::error::QueryError::Engine(EngineError::InvalidData(
                    "Expected USERELATIONSHIP override".into(),
                ))
            })?;
            let rel = model.relationship(override_rel_name)?;
            let dim_table = if rel.from_table() == fact_model_name {
                rel.to_table()
            } else {
                rel.from_table()
            };
            let dim_lower = dim_table.to_lowercase();
            let fact_is_from = rel.from_table() == fact_model_name;

            // Build boundary query: compute aggregate boundaries per GROUP BY group.
            // For each join condition, compute the boundary (MAX or MIN) of the
            // dim-side column grouped by the GROUP BY columns.
            let bounds_alias = format!("__bounds_{i}");

            let mut bounds_select: Vec<String> = Vec::new();
            let mut bounds_group: Vec<String> = Vec::new();
            let mut where_conditions: Vec<String> = Vec::new();

            // GROUP BY columns from the dim table.
            for dim in group_by {
                if dim.table.eq_ignore_ascii_case(dim_table)
                    || dim.table.eq_ignore_ascii_case(fact_model_name)
                {
                    let tbl = dim.table.to_lowercase();
                    let qualified = format!("{tbl}.{}", quote_ident_double(&dim.column));
                    bounds_select.push(qualified.clone());
                    bounds_group.push(qualified);
                }
            }

            // Boundary aggregates for each join condition.
            for (ci, cond) in rel.conditions().iter().enumerate() {
                let dim_col = if fact_is_from {
                    cond.to_column()
                } else {
                    cond.from_column()
                };
                let fact_col = if fact_is_from {
                    cond.from_column()
                } else {
                    cond.to_column()
                };
                let boundary_agg = cond.operator().boundary_aggregate();
                let boundary_alias = format!("__b_{ci}");
                bounds_select.push(format!(
                    "{boundary_agg}({dim_lower}.{}) AS \"{boundary_alias}\"",
                    quote_ident_double(dim_col)
                ));

                // Build WHERE condition for fact table against boundary.
                let op = cond.operator().as_sql();
                where_conditions.push(format!(
                    "{fact_table}.{} {op} {bounds_alias}.\"{boundary_alias}\"",
                    quote_ident_double(fact_col)
                ));
            }

            let bounds_sql = format!(
                "SELECT {} FROM {dim_lower} GROUP BY {}",
                bounds_select.join(", "),
                bounds_group.join(", ")
            );

            let bounds_start = Instant::now();
            let bounds_df = ctx.sql(&bounds_sql).await?;
            let bounds_batches = bounds_df.collect().await?;
            let bounds_elapsed = bounds_start.elapsed();

            if bounds_batches.is_empty() {
                continue;
            }

            register_partitioned_table(ctx, &bounds_alias, bounds_batches.clone())?;

            // Main query: CROSS JOIN fact with bounds, filter by boundary.
            let mut main_select: Vec<String> = Vec::new();
            let mut main_group: Vec<String> = Vec::new();

            for dim in group_by {
                let qualified = format!("{bounds_alias}.{}", quote_ident_double(&dim.column));
                main_select.push(qualified.clone());
                main_group.push(qualified);
            }

            // Measure aggregate.
            let measure_name = measure.name();
            if let Some((op, col)) = stripped.as_simple_aggregate() {
                let col_ref = format!("{fact_table}.{}", quote_ident_double(col));
                let agg_sql = op.render_sql(&col_ref);
                main_select.push(format!("{agg_sql} AS {}", quote_ident_double(measure_name)));
            } else {
                let expr_sql = stripped.to_sql_string()?;
                main_select.push(format!(
                    "{expr_sql} AS {}",
                    quote_ident_double(measure_name)
                ));
            }

            let main_sql = format!(
                "SELECT {} FROM {fact_table} CROSS JOIN {bounds_alias} WHERE {} GROUP BY {}",
                main_select.join(", "),
                where_conditions.join(" AND "),
                main_group.join(", ")
            );

            let result_table = format!("__override_{i}");
            let main_start = Instant::now();
            let main_df = ctx.sql(&main_sql).await?;
            let main_batches = main_df.collect().await?;
            let main_elapsed = main_start.elapsed();

            if let Some(ref mut pn) = plan {
                let bounds_rows: usize = bounds_batches.iter().map(|b| b.num_rows()).sum();
                let main_rows: usize = main_batches.iter().map(|b| b.num_rows()).sum();
                let mut node = PlanNode::new(
                    PlanOperation::LocalAggregation,
                    format!("Boundary Override: {measure_name}"),
                )
                .with_property("bounds_sql", PlanValue::Text(bounds_sql))
                .with_property("bounds_rows", PlanValue::Number(bounds_rows as f64))
                .with_property("main_sql", PlanValue::Text(main_sql.clone()))
                .with_property("main_rows", PlanValue::Number(main_rows as f64));
                // Report combined time for both stages.
                node.duration = (bounds_elapsed + main_elapsed).into();
                pn.add_child(node);
            }

            if !main_batches.is_empty() {
                register_partitioned_table(ctx, &result_table, main_batches)?;
                override_table_names.push((result_table, measure_name.to_string()));
            }
        }

        // --- Part C: combine via FULL OUTER JOIN ---
        let group_cols: Vec<String> = group_by
            .iter()
            .map(|d| quote_ident_double(&d.column))
            .collect();

        if !has_normal && override_table_names.is_empty() {
            return Ok(vec![RecordBatch::new_empty(
                arrow::datatypes::SchemaRef::new(arrow::datatypes::Schema::empty()),
            )]);
        }

        // Build the combining query.
        let first_table = if has_normal {
            normal_table_name.to_string()
        } else {
            override_table_names[0].0.clone()
        };

        // Select: all group columns from first table + all measure columns.
        let mut combine_select: Vec<String> = group_cols
            .iter()
            .map(|c| format!("{first_table}.{c}"))
            .collect();

        if has_normal {
            for m in normal_measures {
                combine_select.push(format!(
                    "{normal_table_name}.{}",
                    quote_ident_double(m.name())
                ));
            }
        }

        let start_idx = if has_normal { 0 } else { 1 };
        for (tbl, mname) in &override_table_names[start_idx..] {
            combine_select.push(format!("{tbl}.{}", quote_ident_double(mname)));
        }
        if !has_normal && !override_table_names.is_empty() {
            let (tbl, mname) = &override_table_names[0];
            combine_select.push(format!("{tbl}.{}", quote_ident_double(mname)));
        }

        let combine_select_clause = combine_select.join(", ");
        let mut combine_sql = format!("SELECT {combine_select_clause} FROM {first_table}");

        // FULL OUTER JOIN remaining tables.
        let tables_to_join: Vec<&str> = if has_normal {
            override_table_names
                .iter()
                .map(|(t, _)| t.as_str())
                .collect()
        } else {
            override_table_names[1..]
                .iter()
                .map(|(t, _)| t.as_str())
                .collect()
        };

        for join_table in &tables_to_join {
            if group_cols.is_empty() {
                combine_sql.push_str(&format!(" CROSS JOIN {join_table}"));
            } else {
                let join_conds: Vec<String> = group_cols
                    .iter()
                    .map(|c| format!("{first_table}.{c} = {join_table}.{c}"))
                    .collect();
                combine_sql.push_str(&format!(
                    " FULL OUTER JOIN {join_table} ON {}",
                    join_conds.join(" AND ")
                ));
            }
        }

        let combine_start = Instant::now();
        let df = ctx.sql(&combine_sql).await?;
        let batches = df.collect().await?;
        let combine_elapsed = combine_start.elapsed();

        if let Some(ref mut pn) = plan {
            let result_rows: usize = batches.iter().map(|b| b.num_rows()).sum();
            pn.add_child(
                PlanNode::new(
                    PlanOperation::MultiGroupAggregation,
                    "Combine Override Results",
                )
                .with_property("sql", PlanValue::Text(combine_sql))
                .with_property("result_rows", PlanValue::Number(result_rows as f64))
                .with_duration(combine_elapsed),
            );
        }

        if !lookup_specs.is_empty() {
            let batches =
                Self::apply_lookup_specs(ctx, batches, lookup_specs, group_by, plan).await?;
            Ok(batches)
        } else {
            Ok(batches)
        }
    }

    /// Execute measures from multiple independent fact tables.
    ///
    /// Each measure group is evaluated as an independent star-schema query.
    /// Results are combined via FULL OUTER JOIN on shared group-by columns,
    /// or CROSS JOIN when there are no group-by columns.
    async fn execute_multi_group_aggregation(
        ctx: &SessionContext,
        measure_groups: &[(&str, Vec<&Measure>)],
        group_by: &[ColumnRef],
        model: &DataModel,
        mut plan: Option<&mut PlanNode>,
    ) -> QueryResult<Vec<RecordBatch>> {
        let resolver = ContextResolver::new(model);

        // For each group, determine reachable group-by columns and build SQL.
        let mut group_table_names: Vec<String> = Vec::new();

        for (group_idx, (fact_model_name, measures)) in measure_groups.iter().enumerate() {
            let fact_table = &fact_model_name.to_lowercase();

            // Determine which group-by columns are reachable from this fact table.
            let reachable_group_by: Vec<&ColumnRef> = group_by
                .iter()
                .filter(|dim| {
                    dim.table.eq_ignore_ascii_case(fact_model_name)
                        || model.find_relationship(fact_model_name, &dim.table).is_ok()
                })
                .collect();

            let mut select_parts: Vec<String> = Vec::new();
            let mut group_parts: Vec<String> = Vec::new();

            for dim in &reachable_group_by {
                let dim_table = dim.table.to_lowercase();
                let qualified = format!("{dim_table}.{}", quote_ident_double(&dim.column));
                select_parts.push(qualified.clone());
                group_parts.push(qualified);
            }

            // Resolve context operations for measures in this group.
            let mut context_join_tables: Vec<String> = Vec::new();
            let mut case_when_measures: Vec<String> = Vec::new();
            let mut override_joins: Vec<OverrideJoinEntry> = Vec::new();

            for measure in measures {
                let name = measure.name();
                let expr = measure.expression();

                let is_compound_with_context = expr.has_context_ops()
                    && matches!(
                        expr,
                        Expression::BinaryOp { .. }
                            | Expression::SafeDivide { .. }
                            | Expression::ScalarFunc { .. }
                            | Expression::Coalesce(_)
                            | Expression::If { .. }
                    );

                let sql_fragment = if is_compound_with_context {
                    case_when_measures.push(name.to_string());
                    let expr_sql = resolve_compound_sql(
                        expr,
                        model,
                        fact_table,
                        fact_model_name,
                        &mut context_join_tables,
                        &mut override_joins,
                    )?;
                    format!("{expr_sql} AS {}", quote_ident_double(name))
                } else {
                    let (stripped_expr, eval_ctx) = resolver.resolve(expr)?;
                    let effective = eval_ctx.effective_filters(&[]);

                    for f in &effective {
                        if f.table != *fact_model_name {
                            context_join_tables.push(f.table.clone());
                        }
                    }
                    for cond in &eval_ctx.conditions {
                        collect_qualified_tables(cond, fact_model_name, &mut context_join_tables);
                    }

                    let alias_map = build_override_alias_map(
                        &eval_ctx,
                        model,
                        fact_model_name,
                        fact_table,
                        &mut override_joins,
                    );

                    if !effective.is_empty() || !eval_ctx.conditions.is_empty() {
                        case_when_measures.push(name.to_string());
                        let condition = build_condition_sql_with_conditions(
                            &effective,
                            &eval_ctx.conditions,
                            fact_table,
                            fact_model_name,
                            model,
                            &alias_map,
                        )?;
                        let measure_table = &measure.table().to_lowercase();
                        let expr_sql = stripped_expr.to_case_when_sql(&condition, measure_table)?;
                        format!("{expr_sql} AS {}", quote_ident_double(name))
                    } else if let Some((op, col)) = stripped_expr.as_simple_aggregate() {
                        let fact = measure.table().to_lowercase();
                        let col = quote_ident_double(col);
                        let name = quote_ident_double(name);
                        format!("{} AS {name}", op.render_sql(&format!("{fact}.{col}")))
                    } else {
                        let expr_sql = stripped_expr.to_sql_string()?;
                        format!("{expr_sql} AS {}", quote_ident_double(name))
                    }
                };
                select_parts.push(sql_fragment);
            }

            let select_clause = select_parts.join(", ");
            let mut sql = format!("SELECT {select_clause} FROM {fact_table}");

            // Add JOINs for dimension tables.
            let mut joined_tables = std::collections::HashSet::new();
            joined_tables.insert(fact_table.clone());

            let add_join_to = |dim_table: &str,
                               sql: &mut String,
                               joined: &mut std::collections::HashSet<String>|
             -> Result<(), crate::error::QueryError> {
                let dim_lower = dim_table.to_lowercase();
                if joined.contains(&dim_lower) {
                    return Ok(());
                }
                let rel = model.find_relationship(fact_model_name, dim_table)?;
                let left_is_from = rel.from_table() == *fact_model_name;
                let on_clause = rel.build_on_clause(fact_table, &dim_lower, left_is_from);
                sql.push_str(&format!(" JOIN {dim_lower} ON {on_clause}"));
                joined.insert(dim_lower);
                Ok(())
            };

            for dim in &reachable_group_by {
                add_join_to(&dim.table, &mut sql, &mut joined_tables)?;
            }

            for dim_table in &context_join_tables {
                let dim_lower = dim_table.to_lowercase();
                if joined_tables.contains(&dim_lower) {
                    continue;
                }
                if let Ok(rel) = model.find_relationship(fact_model_name, dim_table) {
                    let left_is_from = rel.from_table() == *fact_model_name;
                    let on_clause = rel.build_on_clause(fact_table, &dim_lower, left_is_from);
                    sql.push_str(&format!(" JOIN {dim_lower} ON {on_clause}"));
                    joined_tables.insert(dim_lower);
                }
            }

            // Add aliased JOINs from USERELATIONSHIP overrides.
            // Override joins are for measure context, not GROUP BY — only
            // check relationship safety, not group_by_tables.
            let mut mg_exists_conditions: Vec<String> = Vec::new();
            for entry in &override_joins {
                if joined_tables.contains(&entry.alias) {
                    continue;
                }
                if entry.is_safe {
                    sql.push_str(&format!(
                        " JOIN {} AS {} ON {}",
                        entry.source_table, entry.alias, entry.on_clause
                    ));
                    joined_tables.insert(entry.alias.clone());
                } else if let Some(ref boundary) = entry.boundary_clause {
                    mg_exists_conditions.push(boundary.clone());
                    joined_tables.insert(entry.alias.clone());
                } else {
                    let exists = format!(
                        "EXISTS (SELECT 1 FROM {} AS __d WHERE {})",
                        entry.source_table,
                        entry
                            .on_clause
                            .replace(&format!("{}.", entry.alias), "__d.")
                    );
                    mg_exists_conditions.push(exists);
                    joined_tables.insert(entry.alias.clone());
                }
            }

            // WHERE clause for EXISTS/boundary semi-join conditions.
            if !mg_exists_conditions.is_empty() {
                sql.push_str(" WHERE ");
                sql.push_str(&mg_exists_conditions.join(" AND "));
            }

            // GROUP BY clause.
            if !group_parts.is_empty() {
                sql.push_str(" GROUP BY ");
                sql.push_str(&group_parts.join(", "));

                if !case_when_measures.is_empty() {
                    let having_parts: Vec<String> = case_when_measures
                        .iter()
                        .map(|m| format!("{} IS NOT NULL", quote_ident_double(m)))
                        .collect();
                    sql.push_str(" HAVING ");
                    sql.push_str(&having_parts.join(" OR "));
                }
            }

            // Execute the group query and register result.
            let group_name = format!("__group_{group_idx}");
            let df_start = Instant::now();
            let df = ctx.sql(&sql).await?;
            let batches = df.collect().await?;
            let df_elapsed = df_start.elapsed();

            if let Some(ref mut plan_node) = plan {
                let mut group_node = PlanNode::new(
                    PlanOperation::DataFusionExecution,
                    format!("Group {group_idx}: {fact_model_name}"),
                )
                .with_property("sql", PlanValue::Text(sql.clone()))
                .with_property(
                    "measures",
                    PlanValue::List(measures.iter().map(|m| m.name().to_string()).collect()),
                );
                group_node.duration = df_elapsed.into();
                let result_rows: usize = batches.iter().map(|b| b.num_rows()).sum();
                group_node.add_property("result_rows", PlanValue::Number(result_rows as f64));
                plan_node.add_child(group_node);
            }

            if !batches.is_empty() {
                register_partitioned_table(ctx, &group_name, batches)?;
            } else {
                // Register an empty batch so the FULL OUTER JOIN still works.
                let empty = RecordBatch::new_empty(arrow::datatypes::SchemaRef::new(
                    arrow::datatypes::Schema::empty(),
                ));
                ctx.register_batch(&group_name, empty)?;
            }
            group_table_names.push(group_name);
        }

        // Build the combining query via FULL OUTER JOIN (or CROSS JOIN for scalars).
        let measure_names: Vec<String> = measure_groups
            .iter()
            .flat_map(|(_, measures)| measures.iter().map(|m| m.name().to_string()))
            .collect();

        if group_by.is_empty() {
            // Scalar query: CROSS JOIN all groups.
            let mut select_parts: Vec<String> = Vec::new();
            for name in &measure_names {
                // Find which group table has this measure.
                for (gi, (_, measures)) in measure_groups.iter().enumerate() {
                    if measures.iter().any(|m| m.name() == name) {
                        select_parts.push(format!("__group_{gi}.{}", quote_ident_double(name)));
                        break;
                    }
                }
            }
            let mut sql = format!(
                "SELECT {} FROM {}",
                select_parts.join(", "),
                group_table_names[0]
            );
            for gt in group_table_names.iter().skip(1) {
                sql.push_str(&format!(" CROSS JOIN {gt}"));
            }

            let combine_start = Instant::now();
            let df = ctx.sql(&sql).await?;
            let batches = df.collect().await?;
            let combine_elapsed = combine_start.elapsed();

            if let Some(ref mut plan_node) = plan {
                plan_node.add_child(
                    PlanNode::new(
                        PlanOperation::MultiGroupAggregation,
                        "Combine measure groups (scalar)",
                    )
                    .with_property("sql", PlanValue::Text(sql))
                    .with_property("groups", PlanValue::Number(measure_groups.len() as f64))
                    .with_duration(combine_elapsed),
                );
            }

            Ok(batches)
        } else {
            // Grouped query: FULL OUTER JOIN on shared group-by columns.
            // Determine which group-by columns each group has.
            let group_reachable: Vec<Vec<&ColumnRef>> = measure_groups
                .iter()
                .map(|(fact_name, _)| {
                    group_by
                        .iter()
                        .filter(|dim| {
                            dim.table.eq_ignore_ascii_case(fact_name)
                                || model.find_relationship(fact_name, &dim.table).is_ok()
                        })
                        .collect()
                })
                .collect();

            // Build SELECT: COALESCE group-by cols from all groups that have them,
            // then measure cols from their respective groups.
            let mut select_parts: Vec<String> = Vec::new();

            for dim in group_by {
                let col_name = &dim.column;
                let sources: Vec<String> = group_reachable
                    .iter()
                    .enumerate()
                    .filter(|(_, reachable)| {
                        reachable
                            .iter()
                            .any(|c| c.table == dim.table && c.column == dim.column)
                    })
                    .map(|(gi, _)| format!("__group_{gi}.{}", quote_ident_double(col_name)))
                    .collect();

                if sources.len() == 1 {
                    select_parts.push(format!(
                        "{} AS {}",
                        sources[0],
                        quote_ident_double(col_name)
                    ));
                } else {
                    select_parts.push(format!(
                        "COALESCE({}) AS {}",
                        sources.join(", "),
                        quote_ident_double(col_name)
                    ));
                }
            }

            for name in &measure_names {
                for (gi, (_, measures)) in measure_groups.iter().enumerate() {
                    if measures.iter().any(|m| m.name() == name) {
                        select_parts.push(format!("__group_{gi}.{}", quote_ident_double(name)));
                        break;
                    }
                }
            }

            // Build FROM with FULL OUTER JOINs.
            let mut sql = format!(
                "SELECT {} FROM {}",
                select_parts.join(", "),
                group_table_names[0]
            );

            for (gi, gt) in group_table_names.iter().enumerate().skip(1) {
                // Find group-by columns shared between group 0 (or previous) and this group.
                // Join on all columns that both sides have.
                let prev_reachable = &group_reachable[0];
                let this_reachable = &group_reachable[gi];

                let shared_cols: Vec<&str> = group_by
                    .iter()
                    .filter(|dim| {
                        prev_reachable
                            .iter()
                            .any(|c| c.table == dim.table && c.column == dim.column)
                            && this_reachable
                                .iter()
                                .any(|c| c.table == dim.table && c.column == dim.column)
                    })
                    .map(|dim| dim.column.as_str())
                    .collect();

                if shared_cols.is_empty() {
                    sql.push_str(&format!(" CROSS JOIN {gt}"));
                } else {
                    let on_parts: Vec<String> = shared_cols
                        .iter()
                        .map(|col| {
                            let col = quote_ident_double(col);
                            format!("__group_0.{col} = {gt}.{col}")
                        })
                        .collect();
                    sql.push_str(&format!(
                        " FULL OUTER JOIN {gt} ON {}",
                        on_parts.join(" AND ")
                    ));
                }
            }

            let combine_start = Instant::now();
            let df = ctx.sql(&sql).await?;
            let batches = df.collect().await?;
            let combine_elapsed = combine_start.elapsed();

            if let Some(ref mut plan_node) = plan {
                plan_node.add_child(
                    PlanNode::new(
                        PlanOperation::MultiGroupAggregation,
                        "Combine measure groups",
                    )
                    .with_property("sql", PlanValue::Text(sql.clone()))
                    .with_property("groups", PlanValue::Number(measure_groups.len() as f64))
                    .with_duration(combine_elapsed),
                );
            }

            Ok(batches)
        }
    }

    /// Look up attribute columns by joining aggregated results back to dimension tables.
    ///
    /// The aggregation result only contains GROUP BY and measure columns.
    /// This method registers the result as a temporary table, then JOINs back
    /// to the dimension tables and applies resolution expressions to resolve
    /// lookup column values (which may be 1:many).
    async fn apply_lookup_specs(
        ctx: &SessionContext,
        agg_batches: Vec<RecordBatch>,
        lookup_specs: &[crate::planner::LookupSpec],
        group_by: &[ColumnRef],
        plan: Option<&mut PlanNode>,
    ) -> QueryResult<Vec<RecordBatch>> {
        if agg_batches.is_empty() {
            return Ok(agg_batches);
        }

        // Register aggregation result.
        let schema = agg_batches[0].schema();
        register_partitioned_table(ctx, "__agg_result", agg_batches)?;

        // Collect unique (table, key_column) pairs for JOINs.
        let mut join_keys: Vec<(String, String)> = Vec::new();
        for spec in lookup_specs {
            let pair = (spec.table.to_lowercase(), spec.key_column.clone());
            if !join_keys.iter().any(|j| j.0 == pair.0 && j.1 == pair.1) {
                join_keys.push(pair);
            }
        }

        // Build SELECT clause: all columns from __agg_result, plus lookup resolution expressions.
        let mut select_parts: Vec<String> = Vec::new();

        // Add all existing columns from aggregation result.
        for field in schema.fields() {
            select_parts.push(format!("__agg_result.{}", quote_ident_double(field.name())));
        }

        // Add lookup columns with resolution expressions.
        for spec in lookup_specs {
            select_parts.push(format!(
                "{} AS {}",
                spec.resolution_sql,
                quote_ident_double(&spec.column)
            ));
        }

        let select_clause = select_parts.join(", ");
        let mut sql = format!("SELECT {select_clause} FROM __agg_result");

        // Add JOINs for each unique (table, key) pair.
        for (dim_lower, key_col) in &join_keys {
            let agg_key_col = group_by
                .iter()
                .find(|c| c.table.to_lowercase() == *dim_lower && c.column == *key_col)
                .map(|c| c.column.as_str())
                .unwrap_or(key_col);

            sql.push_str(&format!(
                " JOIN {dim_lower} ON __agg_result.{} = {dim_lower}.{}",
                quote_ident_double(agg_key_col),
                quote_ident_double(key_col)
            ));
        }

        // GROUP BY all __agg_result columns (since resolution expressions are aggregates).
        let group_parts: Vec<String> = schema
            .fields()
            .iter()
            .map(|f| format!("__agg_result.{}", quote_ident_double(f.name())))
            .collect();
        sql.push_str(&format!(" GROUP BY {}", group_parts.join(", ")));

        let lookup_start = Instant::now();
        let df = ctx.sql(&sql).await?;
        let batches = df.collect().await?;
        let lookup_elapsed = lookup_start.elapsed();

        if let Some(plan_node) = plan {
            let result_rows: usize = batches.iter().map(|b| b.num_rows()).sum();
            let lookup_names: Vec<String> = lookup_specs
                .iter()
                .map(|s| format!("{}.{}", s.table, s.column))
                .collect();
            plan_node.add_child(
                PlanNode::new(PlanOperation::DataFusionExecution, "Lookup Resolution")
                    .with_property("sql", PlanValue::Text(sql))
                    .with_property("lookups", PlanValue::List(lookup_names))
                    .with_property("result_rows", PlanValue::Number(result_rows as f64))
                    .with_duration(lookup_elapsed),
            );
        }

        Ok(batches)
    }

    /// Evaluate QUERY-in-VAR measures via two-stage aggregation.
    ///
    /// Stage 1: Materialize each QUERY binding by running grouped aggregation
    ///          SQL against the already-registered source tables.
    /// Stage 2: Run the RETURN expression SQL against the intermediate tables.
    async fn execute_query_measures(
        ctx: &SessionContext,
        query_measures: &[&Measure],
        _normal_measures: &[&Measure],
        group_by: &[ColumnRef],
        model: &DataModel,
        mut plan: Option<&mut PlanNode>,
    ) -> QueryResult<Vec<RecordBatch>> {
        let resolver = ContextResolver::new(model);

        // Cache for materialized QUERY bindings within this query execution.
        // Key: (binding_name, source_filters_repr, augmented_group_by_repr)
        // This allows reuse when multiple measures reference the same global
        // variable with the same effective context.
        let mut query_cache: std::collections::HashMap<
            String,
            (RecordBatch, arrow::datatypes::SchemaRef),
        > = std::collections::HashMap::new();

        // For now, handle measures one at a time and merge results.
        // Each measure gets its own intermediate table evaluation.
        let mut all_batches: Vec<RecordBatch> = Vec::new();

        for measure in query_measures {
            let name = measure.name();
            let expr = measure.expression();
            let fact_table = measure.table();

            // Resolve context operations.
            let (stripped_expr, eval_ctx) = resolver.resolve(expr)?;
            let effective = eval_ctx.effective_filters(&[]);

            let Expression::Block { bindings, .. } = &stripped_expr else {
                return Err(crate::error::QueryError::InvalidQuery(format!(
                    "Expected Block expression for QUERY-in-VAR measure '{name}'"
                )));
            };

            // Collect QUERY binding names for filter partitioning.
            let binding_name_set: std::collections::HashSet<String> = bindings
                .iter()
                .filter(|(_, e)| matches!(e, Expression::Query { .. }))
                .map(|(n, _)| n.to_lowercase())
                .collect();

            // Partition filters into source filters vs intermediate filters.
            let source_filters: Vec<&ResolvedFilter> = effective
                .iter()
                .filter(|f| !binding_name_set.contains(&f.table.to_lowercase()))
                .collect();
            let intermediate_filters: Vec<&ResolvedFilter> = effective
                .iter()
                .filter(|f| binding_name_set.contains(&f.table.to_lowercase()))
                .collect();

            let mut query_binding_names: Vec<String> = Vec::new();
            let mut binding_schemas: std::collections::HashMap<
                String,
                arrow::datatypes::SchemaRef,
            > = std::collections::HashMap::new();

            // Stage 1: Materialize each QUERY binding.
            // Inject outer group-by columns into the QUERY's own group-by so
            // the intermediate table carries dimension columns needed for the
            // final GROUP BY. This implements DAX-style context propagation:
            // the QUERY is effectively re-evaluated per outer group.
            for (binding_name, binding_expr) in bindings {
                if let Expression::Query {
                    aggregates,
                    group_by: qgb,
                } = binding_expr
                {
                    let mut augmented_gb = qgb.clone();
                    for dim in group_by {
                        let already = augmented_gb.iter().any(|(t, c)| {
                            t.eq_ignore_ascii_case(&dim.table)
                                && c.eq_ignore_ascii_case(&dim.column)
                        });
                        if !already {
                            augmented_gb.push((dim.table.clone(), dim.column.clone()));
                        }
                    }

                    // Build a cache key from binding name + filters + group-by.
                    let cache_key =
                        build_query_cache_key(binding_name, &source_filters, &augmented_gb);

                    if let Some((cached_batch, cached_schema)) = query_cache.get(&cache_key) {
                        // Cache hit: reuse the already-materialized batch.
                        ctx.register_batch(&binding_name.to_lowercase(), cached_batch.clone())?;
                        binding_schemas.insert(binding_name.to_lowercase(), cached_schema.clone());

                        if let Some(ref mut plan_node) = plan {
                            plan_node.add_child(
                                PlanNode::new(
                                    PlanOperation::DataFusionExecution,
                                    format!("QUERY {binding_name} (cache hit)"),
                                )
                                .with_property(
                                    "result_rows",
                                    PlanValue::Number(cached_batch.num_rows() as f64),
                                ),
                            );
                        }
                    } else {
                        let mat_start = Instant::now();
                        let batch = materialize_query_in_pipeline(
                            ctx,
                            aggregates,
                            &augmented_gb,
                            fact_table,
                            &source_filters,
                            model,
                        )
                        .await?;
                        let mat_elapsed = mat_start.elapsed();
                        let schema = batch.schema();
                        let mat_rows = batch.num_rows();

                        // Store in cache for potential reuse by other measures.
                        query_cache.insert(cache_key, (batch.clone(), schema.clone()));

                        ctx.register_batch(&binding_name.to_lowercase(), batch)?;
                        binding_schemas.insert(binding_name.to_lowercase(), schema);

                        if let Some(ref mut plan_node) = plan {
                            plan_node.add_child(
                                PlanNode::new(
                                    PlanOperation::DataFusionExecution,
                                    format!("QUERY {binding_name} (materialize)"),
                                )
                                .with_property("result_rows", PlanValue::Number(mat_rows as f64))
                                .with_duration(mat_elapsed),
                            );
                        }
                    }
                    query_binding_names.push(binding_name.clone());
                }
            }

            if query_binding_names.is_empty() {
                return Err(crate::error::QueryError::InvalidQuery(format!(
                    "No QUERY bindings found in measure '{name}'"
                )));
            }

            // Stage 2: Build SQL over the intermediate table(s).
            let inlined = stripped_expr.inline_bindings();
            let result_sql = inlined.to_sql_string()?;
            let from_table = query_binding_names[0].to_lowercase();

            let mut select_parts: Vec<String> = Vec::new();
            let mut sql_group_parts: Vec<String> = Vec::new();

            for dim in group_by {
                let qualified = format!("{from_table}.{}", quote_ident_double(&dim.column));
                select_parts.push(qualified.clone());
                sql_group_parts.push(qualified);
            }

            select_parts.push(format!("{result_sql} AS {}", quote_ident_double(name)));
            let select_clause = select_parts.join(", ");
            let mut sql = format!("SELECT {select_clause} FROM {from_table}");

            // Apply intermediate table filters as WHERE clause.
            let where_clause = build_intermediate_where(&intermediate_filters, &binding_schemas);
            if !where_clause.is_empty() {
                sql.push_str(" WHERE ");
                sql.push_str(&where_clause);
            }

            if !sql_group_parts.is_empty() {
                sql.push_str(" GROUP BY ");
                sql.push_str(&sql_group_parts.join(", "));
            }

            let s2_start = Instant::now();
            let df = ctx.sql(&sql).await?;
            let batches = df.collect().await?;
            let s2_elapsed = s2_start.elapsed();

            if let Some(ref mut plan_node) = plan {
                let result_rows: usize = batches.iter().map(|b| b.num_rows()).sum();
                plan_node.add_child(
                    PlanNode::new(
                        PlanOperation::DataFusionExecution,
                        format!("QUERY RETURN: {name}"),
                    )
                    .with_property("sql", PlanValue::Text(sql))
                    .with_property("result_rows", PlanValue::Number(result_rows as f64))
                    .with_duration(s2_elapsed),
                );
            }

            all_batches.extend(batches);
        }

        Ok(all_batches)
    }

    /// Evaluate window measures via two-stage execution.
    ///
    /// Stage 1: Materialize inner measure grouped by ORDER BY + PARTITION BY
    ///          columns (+ outer GROUP BY for context propagation).
    /// Stage 2: Apply SQL window function over the materialized result.
    async fn execute_window_measures(
        ctx: &SessionContext,
        window_measures: &[&Measure],
        group_by: &[ColumnRef],
        model: &DataModel,
        mut plan: Option<&mut PlanNode>,
    ) -> QueryResult<Vec<RecordBatch>> {
        let resolver = ContextResolver::new(model);
        let mut all_batches: Vec<RecordBatch> = Vec::new();

        for measure in window_measures {
            let name = measure.name();
            let expr = measure.expression();
            let fact_table = measure.table();

            // Resolve context operations on the inner expression.
            let (stripped_expr, _eval_ctx) = resolver.resolve(expr)?;

            // Extract window parameters from the (potentially context-stripped) expression.
            let (inner, window_info) = extract_window_info(&stripped_expr)?;

            // Build the group-by columns for stage 1: ORDERBY + PARTITIONBY + outer GROUP BY.
            let mut stage1_group_by: Vec<(String, String)> = Vec::new();
            for (table, column) in &window_info.order_by {
                if !stage1_group_by
                    .iter()
                    .any(|(t, c)| t.eq_ignore_ascii_case(table) && c.eq_ignore_ascii_case(column))
                {
                    stage1_group_by.push((table.clone(), column.clone()));
                }
            }
            for (table, column) in &window_info.partition_by {
                if !stage1_group_by
                    .iter()
                    .any(|(t, c)| t.eq_ignore_ascii_case(table) && c.eq_ignore_ascii_case(column))
                {
                    stage1_group_by.push((table.clone(), column.clone()));
                }
            }
            // Inject outer GROUP BY for context propagation.
            for dim in group_by {
                if !stage1_group_by.iter().any(|(t, c)| {
                    t.eq_ignore_ascii_case(&dim.table) && c.eq_ignore_ascii_case(&dim.column)
                }) {
                    stage1_group_by.push((dim.table.clone(), dim.column.clone()));
                }
            }

            // Stage 1: Materialize inner measure grouped by stage1_group_by.
            let base_table_name = format!("__window_{}", name.to_lowercase());
            let agg_pair = vec![(inner.clone(), "__val".to_string())];
            let s1_start = Instant::now();
            let batch = materialize_query_in_pipeline(
                ctx,
                &agg_pair,
                &stage1_group_by,
                &fact_table.to_lowercase(),
                &[],
                model,
            )
            .await?;
            let s1_elapsed = s1_start.elapsed();
            let s1_rows = batch.num_rows();
            ctx.register_batch(&base_table_name, batch)?;

            // Stage 2: Build and execute window function SQL.
            let mut select_parts: Vec<String> = Vec::new();

            // Include outer GROUP BY columns in SELECT.
            for dim in group_by {
                let col_lower = dim.column.to_lowercase();
                select_parts.push(quote_ident_double(&col_lower));
            }

            // Build the window function expression.
            let window_sql = build_window_sql(&window_info, &stage1_group_by, group_by, name);
            select_parts.push(window_sql);

            let sql = format!("SELECT {} FROM {base_table_name}", select_parts.join(", "));

            let s2_start = Instant::now();
            let df = ctx.sql(&sql).await?;
            let batches = df.collect().await?;
            let s2_elapsed = s2_start.elapsed();
            let s2_rows: usize = batches.iter().map(|b| b.num_rows()).sum();
            all_batches.extend(batches);

            // Record plan nodes for this window measure.
            if let Some(ref mut plan_node) = plan {
                let mut window_node =
                    PlanNode::new(PlanOperation::MeasureEvaluation, format!("Window: {name}"));
                window_node.duration = (s1_elapsed + s2_elapsed).into();

                window_node.add_child(
                    PlanNode::new(
                        PlanOperation::DataFusionExecution,
                        "Materialize Inner (Stage 1)",
                    )
                    .with_property("result_rows", PlanValue::Number(s1_rows as f64))
                    .with_duration(s1_elapsed),
                );
                window_node.add_child(
                    PlanNode::new(
                        PlanOperation::DataFusionExecution,
                        "Window Function (Stage 2)",
                    )
                    .with_property("sql", PlanValue::Text(sql))
                    .with_property("result_rows", PlanValue::Number(s2_rows as f64))
                    .with_duration(s2_elapsed),
                );
                plan_node.add_child(window_node);
            }
        }

        // If multiple window measures, we'd need to join results.
        // For now, return the batches from the last (or only) measure.
        Ok(all_batches)
    }
}

/// Extracted window function parameters.
struct WindowInfo {
    /// Window aggregate function (for WINDOW) or None (for OFFSET/INDEX).
    function: Option<engine_core::compute::aggregate::AggregateOp>,
    /// ORDER BY columns.
    order_by: Vec<(String, String)>,
    /// PARTITION BY columns.
    partition_by: Vec<(String, String)>,
    /// Window frame (for WINDOW).
    frame: Option<engine_core::compute::expression::WindowFrame>,
    /// OFFSET delta (for OFFSET).
    delta: Option<i64>,
    /// INDEX position (for INDEX).
    position: Option<i64>,
}

/// Extract window parameters from an expression, returning (inner_measure, window_info).
fn extract_window_info(expr: &Expression) -> QueryResult<(Expression, WindowInfo)> {
    match expr {
        Expression::Window {
            inner,
            function,
            order_by,
            partition_by,
            frame,
        } => Ok((
            *inner.clone(),
            WindowInfo {
                function: Some(*function),
                order_by: order_by.clone(),
                partition_by: partition_by.clone(),
                frame: frame.clone(),
                delta: None,
                position: None,
            },
        )),
        Expression::Offset {
            inner,
            delta,
            order_by,
            partition_by,
        } => Ok((
            *inner.clone(),
            WindowInfo {
                function: None,
                order_by: order_by.clone(),
                partition_by: partition_by.clone(),
                frame: None,
                delta: Some(*delta),
                position: None,
            },
        )),
        Expression::Index {
            inner,
            position,
            order_by,
            partition_by,
        } => Ok((
            *inner.clone(),
            WindowInfo {
                function: None,
                order_by: order_by.clone(),
                partition_by: partition_by.clone(),
                frame: None,
                delta: None,
                position: Some(*position),
            },
        )),
        _ => Err(crate::error::QueryError::InvalidQuery(
            "expected Window, Offset, or Index expression".into(),
        )),
    }
}

/// Build the SQL window function expression for stage 2.
fn build_window_sql(
    info: &WindowInfo,
    _stage1_group_by: &[(String, String)],
    outer_group_by: &[ColumnRef],
    measure_name: &str,
) -> String {
    use engine_core::compute::aggregate::AggregateOp;

    // Build ORDER BY clause.
    let order_clause: Vec<String> = info
        .order_by
        .iter()
        .map(|(_, col)| quote_ident_double(&col.to_lowercase()))
        .collect();
    let order_sql = order_clause.join(", ");

    // Build PARTITION BY clause (includes outer group-by columns that aren't in ORDER BY).
    let mut partition_cols: Vec<String> = info
        .partition_by
        .iter()
        .map(|(_, col)| quote_ident_double(&col.to_lowercase()))
        .collect();
    // Add outer group-by columns to PARTITION BY if not already in ORDER BY or PARTITION BY.
    for dim in outer_group_by {
        let col_lower = dim.column.to_lowercase();
        let col_quoted = quote_ident_double(&col_lower);
        if !partition_cols.contains(&col_quoted) && !order_clause.contains(&col_quoted) {
            partition_cols.push(col_quoted);
        }
    }
    let partition_sql = if partition_cols.is_empty() {
        String::new()
    } else {
        format!("PARTITION BY {} ", partition_cols.join(", "))
    };

    if let Some(function) = info.function {
        // WINDOW: AGG("__val") OVER (PARTITION BY ... ORDER BY ... ROWS BETWEEN ...)
        let func_name_owned;
        let func_name = match function {
            AggregateOp::Sum => "SUM",
            AggregateOp::Average => "AVG",
            AggregateOp::Min => "MIN",
            AggregateOp::Max => "MAX",
            AggregateOp::Count => "COUNT",
            AggregateOp::DistinctCount => "COUNT",
            AggregateOp::CountRows => "COUNT",
            other => {
                func_name_owned = other.to_string();
                &func_name_owned
            }
        };

        let frame_sql = match &info.frame {
            Some(frame) => translate_frame(frame),
            None => "ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW".to_string(),
        };

        format!(
            "{func_name}(\"__val\") OVER ({partition_sql}ORDER BY {order_sql} {frame_sql}) AS {}",
            quote_ident_double(measure_name)
        )
    } else if let Some(delta) = info.delta {
        // OFFSET: LAG/LEAD("__val", N) OVER (...)
        if delta < 0 {
            format!(
                "LAG(\"__val\", {}) OVER ({partition_sql}ORDER BY {order_sql}) AS {}",
                delta.unsigned_abs(),
                quote_ident_double(measure_name)
            )
        } else {
            format!(
                "LEAD(\"__val\", {delta}) OVER ({partition_sql}ORDER BY {order_sql}) AS {}",
                quote_ident_double(measure_name)
            )
        }
    } else if let Some(position) = info.position {
        // INDEX: NTH_VALUE("__val", N) OVER (...) with full frame.
        if position >= 1 {
            format!(
                "NTH_VALUE(\"__val\", {position}) OVER ({partition_sql}ORDER BY {order_sql} ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING) AS {}",
                quote_ident_double(measure_name)
            )
        } else {
            // Negative position: from end. Use NTH_VALUE with reversed ordering.
            let reverse_order: Vec<String> = info
                .order_by
                .iter()
                .map(|(_, col)| format!("{} DESC", quote_ident_double(&col.to_lowercase())))
                .collect();
            let rev_order_sql = reverse_order.join(", ");
            let abs_pos = position.unsigned_abs();
            format!(
                "NTH_VALUE(\"__val\", {abs_pos}) OVER ({partition_sql}ORDER BY {rev_order_sql} ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING) AS {}",
                quote_ident_double(measure_name)
            )
        }
    } else {
        format!("\"__val\" AS {}", quote_ident_double(measure_name))
    }
}

/// Translate a DAX-style WindowFrame to SQL ROWS BETWEEN clause.
fn translate_frame(frame: &engine_core::compute::expression::WindowFrame) -> String {
    use engine_core::compute::expression::BoundaryType;

    let from_sql = match (frame.from, frame.from_type) {
        (1, BoundaryType::Abs) | (0, BoundaryType::Abs) => "UNBOUNDED PRECEDING".to_string(),
        (0, BoundaryType::Rel) => "CURRENT ROW".to_string(),
        (n, BoundaryType::Rel) if n < 0 => format!("{} PRECEDING", n.unsigned_abs()),
        (n, BoundaryType::Rel) => format!("{n} FOLLOWING"),
        (n, BoundaryType::Abs) if n > 0 => {
            // Absolute position from start — approximate as UNBOUNDED PRECEDING
            // (DataFusion doesn't support absolute row positioning directly).
            "UNBOUNDED PRECEDING".to_string()
        }
        (n, BoundaryType::Abs) if n < 0 => {
            // Absolute from end — approximate as UNBOUNDED FOLLOWING.
            "UNBOUNDED PRECEDING".to_string()
        }
        _ => "CURRENT ROW".to_string(),
    };

    let to_sql = match (frame.to, frame.to_type) {
        (-1, BoundaryType::Abs) | (0, BoundaryType::Abs) => "UNBOUNDED FOLLOWING".to_string(),
        (0, BoundaryType::Rel) => "CURRENT ROW".to_string(),
        (n, BoundaryType::Rel) if n < 0 => format!("{} PRECEDING", n.unsigned_abs()),
        (n, BoundaryType::Rel) => format!("{n} FOLLOWING"),
        (n, BoundaryType::Abs) if n < 0 => "UNBOUNDED FOLLOWING".to_string(),
        (n, BoundaryType::Abs) if n > 0 => "UNBOUNDED FOLLOWING".to_string(),
        _ => "CURRENT ROW".to_string(),
    };

    format!("ROWS BETWEEN {from_sql} AND {to_sql}")
}

/// Materialize a QUERY binding in the pipeline context.
///
/// Runs a grouped aggregation SQL query using the already-registered tables
/// in the DataFusion SessionContext.
async fn materialize_query_in_pipeline(
    ctx: &SessionContext,
    aggregates: &[(Expression, String)],
    group_by: &[(String, String)],
    fact_table: &str,
    source_filters: &[&ResolvedFilter],
    model: &DataModel,
) -> QueryResult<RecordBatch> {
    let fact_lower = fact_table.to_lowercase();

    let mut select_parts: Vec<String> = Vec::new();
    let mut group_parts: Vec<String> = Vec::new();

    for (table, column) in group_by {
        let tbl = table.to_lowercase();
        let qualified = format!("{tbl}.{}", quote_ident_double(column));
        select_parts.push(qualified.clone());
        group_parts.push(qualified);
    }

    // Resolve context on each aggregate expression, tracking dimension tables
    // needed by context filters (e.g., ctx_bikes → dim_product).
    let resolver = ContextResolver::new(model);
    let mut context_dim_tables: Vec<String> = Vec::new();

    for (agg_expr, alias) in aggregates {
        let (stripped, eval_ctx) = resolver.resolve(agg_expr)?;
        let effective = eval_ctx.effective_filters(&[]);

        if effective.is_empty() {
            let sql = stripped.to_sql_string()?;
            select_parts.push(format!("{sql} AS {}", quote_ident_double(alias)));
        } else {
            let condition = build_condition_sql(&effective, &fact_lower, fact_table, model)?;
            let sql = stripped.to_case_when_sql(&condition, &fact_lower)?;
            select_parts.push(format!("{sql} AS {}", quote_ident_double(alias)));

            // Track dimension tables needed for CASE WHEN filter JOINs.
            for f in &effective {
                if !f.table.eq_ignore_ascii_case(fact_table)
                    && !context_dim_tables
                        .iter()
                        .any(|t| t.eq_ignore_ascii_case(&f.table))
                {
                    context_dim_tables.push(f.table.clone());
                }
            }
        }
    }

    let select_clause = select_parts.join(", ");
    let mut sql = format!("SELECT {select_clause} FROM {fact_lower}");

    // Add JOINs for dimension tables from group-by columns.
    let mut joined = std::collections::HashSet::new();
    joined.insert(fact_lower.clone());

    for (table, _) in group_by {
        let dim_lower = table.to_lowercase();
        if joined.contains(&dim_lower) {
            continue;
        }
        let rel = model.find_relationship(fact_table, table)?;
        let left_is_from = rel.from_table() == fact_table;
        let on_clause = rel.build_on_clause(&fact_lower, &dim_lower, left_is_from);
        sql.push_str(&format!(" JOIN {dim_lower} ON {on_clause}"));
        joined.insert(dim_lower);
    }

    // Add JOINs for source filter dimension tables (must come before WHERE).
    for f in source_filters.iter() {
        let dim_lower = f.table.to_lowercase();
        if joined.contains(&dim_lower) {
            continue;
        }
        if let Ok(rel) = model.find_relationship(fact_table, &f.table) {
            let left_is_from = rel.from_table() == fact_table;
            let on_clause = rel.build_on_clause(&fact_lower, &dim_lower, left_is_from);
            sql.push_str(&format!(" JOIN {dim_lower} ON {on_clause}"));
            joined.insert(dim_lower);
        }
    }

    // Add JOINs for dimension tables needed by inner aggregate context filters.
    for dim in &context_dim_tables {
        let dim_lower = dim.to_lowercase();
        if joined.contains(&dim_lower) {
            continue;
        }
        if let Ok(rel) = model.find_relationship(fact_table, dim) {
            let left_is_from = rel.from_table() == fact_table;
            let on_clause = rel.build_on_clause(&fact_lower, &dim_lower, left_is_from);
            sql.push_str(&format!(" JOIN {dim_lower} ON {on_clause}"));
            joined.insert(dim_lower);
        }
    }

    // Add WHERE clause from source filters.
    if !source_filters.is_empty() {
        let filter_parts: Vec<String> = source_filters
            .iter()
            .map(|f| {
                let tbl = if f.table == fact_table {
                    fact_lower.clone()
                } else {
                    f.table.to_lowercase()
                };
                let op = f.operator.as_sql();
                let val = format_filter_value(&f.table, &f.column, &f.value, model);
                format!("{tbl}.{} {op} {val}", quote_ident_double(&f.column))
            })
            .collect();
        sql.push_str(" WHERE ");
        sql.push_str(&filter_parts.join(" AND "));
    }

    if !group_parts.is_empty() {
        sql.push_str(" GROUP BY ");
        sql.push_str(&group_parts.join(", "));
    }

    let df = ctx.sql(&sql).await?;
    let batches = df.collect().await?;

    if batches.is_empty() {
        return Ok(RecordBatch::new_empty(arrow::datatypes::SchemaRef::new(
            arrow::datatypes::Schema::empty(),
        )));
    }

    let schema = batches[0].schema();
    let combined = concat_batches(&schema, &batches)?;
    Ok(combined)
}

/// Build a WHERE clause for intermediate table filters.
fn build_intermediate_where(
    filters: &[&ResolvedFilter],
    schemas: &std::collections::HashMap<String, arrow::datatypes::SchemaRef>,
) -> String {
    let parts: Vec<String> = filters
        .iter()
        .map(|f| {
            let tbl = f.table.to_lowercase();
            let op = f.operator.as_sql();
            let val = format_intermediate_value(&tbl, &f.column, &f.value, schemas);
            format!("{tbl}.{} {op} {val}", quote_ident_double(&f.column))
        })
        .collect();
    parts.join(" AND ")
}

/// Format a filter value for an intermediate table, using the Arrow schema
/// to determine whether quoting is needed.
fn format_intermediate_value(
    table: &str,
    column: &str,
    value: &str,
    schemas: &std::collections::HashMap<String, arrow::datatypes::SchemaRef>,
) -> String {
    let needs_quoting = schemas
        .get(table)
        .and_then(|schema| schema.field_with_name(column).ok())
        .map(|field| {
            use arrow::datatypes::DataType as ArrowDT;
            matches!(
                field.data_type(),
                ArrowDT::Utf8
                    | ArrowDT::LargeUtf8
                    | ArrowDT::Date32
                    | ArrowDT::Date64
                    | ArrowDT::Timestamp(_, _)
            )
        })
        .unwrap_or(true);
    if needs_quoting {
        sql_quote_literal(value)
    } else {
        value.to_string()
    }
}

/// Build a SQL condition string from resolved filters.
/// Build a map of table name → SQL alias for USERELATIONSHIP overrides.
///
/// For each relationship override, determines which dimension table it affects
/// and creates an aliased JOIN. Returns a map from model table name to the
/// SQL alias that should be used in filter conditions for this measure.
/// Entry for an override JOIN from USERELATIONSHIP.
///
/// Contains the alias, ON clause, source table name, and whether the
/// relationship is safe for a direct JOIN.
struct OverrideJoinEntry {
    alias: String,
    on_clause: String,
    source_table: String,
    is_safe: bool,
    /// Pre-computed scalar boundary clause for single-condition inequality
    /// relationships. `Some(clause)` when the expensive correlated EXISTS can
    /// be replaced by a cheap scalar subquery (e.g., `col <= (SELECT MAX(...))`).
    boundary_clause: Option<String>,
}

fn build_override_alias_map(
    eval_ctx: &EvaluationContext,
    model: &DataModel,
    fact_model_name: &str,
    fact_table: &str,
    override_joins: &mut Vec<OverrideJoinEntry>,
) -> std::collections::HashMap<String, String> {
    let mut alias_map = std::collections::HashMap::new();

    for rel_name in &eval_ctx.relationship_overrides {
        let Ok(rel) = model.relationship(rel_name) else {
            continue;
        };
        // Determine which table is the dimension (not the fact).
        let dim_table = if rel.from_table() == fact_model_name {
            rel.to_table()
        } else if rel.to_table() == fact_model_name {
            rel.from_table()
        } else {
            continue;
        };

        // Create an alias: dim_table__rel_name (lowercased, sanitized).
        let alias = format!(
            "{}__{}",
            dim_table.to_lowercase(),
            rel_name
                .to_lowercase()
                .replace(|c: char| !c.is_alphanumeric(), "_")
        );
        let left_is_from = rel.from_table() == fact_model_name;
        let on_clause = rel.build_on_clause(fact_table, &alias, left_is_from);
        let is_safe = rel.is_safe_for_direct_join();
        let source_table = dim_table.to_lowercase();

        // Pre-compute boundary clause for single-condition inequality
        // relationships. This avoids the expensive correlated EXISTS.
        let boundary_clause = if !is_safe {
            rel.build_boundary_clause(fact_table, &source_table, left_is_from, &[])
        } else {
            None
        };

        // Check if this alias is already queued.
        if !override_joins.iter().any(|e| e.alias == alias) {
            override_joins.push(OverrideJoinEntry {
                alias: alias.clone(),
                on_clause,
                source_table,
                is_safe,
                boundary_clause,
            });
        }
        alias_map.insert(dim_table.to_string(), alias);
    }
    alias_map
}

/// Build SQL conditions, using aliases from USERELATIONSHIP overrides.
fn build_condition_sql_with_aliases(
    filters: &[ResolvedFilter],
    fact_table: &str,
    fact_model_name: &str,
    model: &DataModel,
    alias_map: &std::collections::HashMap<String, String>,
) -> QueryResult<String> {
    build_condition_sql_impl(
        filters,
        &[],
        fact_table,
        fact_model_name,
        model,
        Some(alias_map),
    )
}

fn build_condition_sql(
    filters: &[ResolvedFilter],
    fact_table: &str,
    fact_model_name: &str,
    model: &DataModel,
) -> QueryResult<String> {
    build_condition_sql_impl(filters, &[], fact_table, fact_model_name, model, None)
}

fn build_condition_sql_with_conditions(
    filters: &[ResolvedFilter],
    conditions: &[Expression],
    fact_table: &str,
    fact_model_name: &str,
    model: &DataModel,
    alias_map: &std::collections::HashMap<String, String>,
) -> QueryResult<String> {
    build_condition_sql_impl(
        filters,
        conditions,
        fact_table,
        fact_model_name,
        model,
        Some(alias_map),
    )
}

fn build_condition_sql_impl(
    filters: &[ResolvedFilter],
    conditions: &[Expression],
    fact_table: &str,
    fact_model_name: &str,
    model: &DataModel,
    alias_map: Option<&std::collections::HashMap<String, String>>,
) -> QueryResult<String> {
    let mut parts: Vec<String> = filters
        .iter()
        .map(|f| {
            let tbl = if f.table == fact_model_name {
                fact_table.to_string()
            } else if let Some(map) = alias_map {
                if let Some(alias) = map.get(&f.table) {
                    alias.clone()
                } else {
                    f.table.to_lowercase()
                }
            } else {
                f.table.to_lowercase()
            };
            let op = f.operator.as_sql();
            let val = format_filter_value(&f.table, &f.column, &f.value, model);
            format!("{tbl}.{} {op} {val}", quote_ident_double(&f.column))
        })
        .collect();

    // Render expression-based conditions with table-qualified column references.
    for cond in conditions {
        parts.push(qualify_condition_sql(cond)?);
    }

    Ok(parts.join(" AND "))
}

/// Collect table names from QualifiedColumnRef nodes in an expression,
/// excluding the fact table. Used to determine which dimension tables need JOINs.
fn collect_qualified_tables(expr: &Expression, fact_table: &str, tables: &mut Vec<String>) {
    match expr {
        Expression::QualifiedColumnRef { table_or_var, .. } => {
            if !table_or_var.eq_ignore_ascii_case(fact_table) {
                tables.push(table_or_var.clone());
            }
        }
        Expression::BinaryOp { left, right, .. }
        | Expression::Comparison { left, right, .. }
        | Expression::And(left, right)
        | Expression::Or(left, right) => {
            collect_qualified_tables(left, fact_table, tables);
            collect_qualified_tables(right, fact_table, tables);
        }
        Expression::Not(inner) | Expression::IsBlank(inner) => {
            collect_qualified_tables(inner, fact_table, tables);
        }
        _ => {}
    }
}

/// Render an expression-based condition as SQL with table-qualified column references.
///
/// QualifiedColumnRef nodes are rendered as `table."column"` (lowercased table name).
fn qualify_condition_sql(expr: &Expression) -> QueryResult<String> {
    Ok(match expr {
        Expression::QualifiedColumnRef {
            table_or_var,
            column,
        } => {
            let tbl = table_or_var.to_lowercase();
            format!("{tbl}.{}", quote_ident_double(column))
        }
        Expression::ColumnRef(name) => quote_ident_double(name),
        Expression::Comparison { left, op, right } => {
            format!(
                "({} {} {})",
                qualify_condition_sql(left)?,
                op.as_sql(),
                qualify_condition_sql(right)?
            )
        }
        Expression::BinaryOp { left, op, right } => {
            format!(
                "({} {} {})",
                qualify_condition_sql(left)?,
                op.as_sql(),
                qualify_condition_sql(right)?
            )
        }
        Expression::And(left, right) => {
            format!(
                "({} AND {})",
                qualify_condition_sql(left)?,
                qualify_condition_sql(right)?
            )
        }
        Expression::Or(left, right) => {
            format!(
                "({} OR {})",
                qualify_condition_sql(left)?,
                qualify_condition_sql(right)?
            )
        }
        Expression::Not(inner) => format!("(NOT {})", qualify_condition_sql(inner)?),
        Expression::IsBlank(inner) => format!("({} IS NULL)", qualify_condition_sql(inner)?),
        Expression::InList {
            expr: inner,
            values,
        } => {
            let lhs = qualify_condition_sql(inner)?;
            let vals = values
                .iter()
                .map(qualify_condition_sql)
                .collect::<QueryResult<Vec<String>>>()?;
            format!("{lhs} IN ({})", vals.join(", "))
        }
        // For literals and other expressions, fall back to to_sql_string().
        _ => expr.to_sql_string()?,
    })
}

/// Apply filter conditions to a cached `RecordBatch` using DataFusion.
///
/// This ensures that in-memory tables respect the same filters that would have
/// been pushed to the source connector (e.g., context-pushed KEEP filters on
/// dimension tables). Without this, the full cached batch would be used, leading
/// to incorrect IN-filter propagation and wrong query results.
async fn filter_cached_batch(
    batch: &RecordBatch,
    filters: &[engine_connectors::FilterCondition],
) -> crate::error::QueryResult<RecordBatch> {
    let filter_ctx = SessionContext::new();
    filter_ctx.register_batch("_cached", batch.clone())?;

    let mut conditions = Vec::new();
    for filter in filters {
        // Quote the value as a string literal for the WHERE clause.
        conditions.push(format!(
            "CAST({} AS TEXT) {} {}",
            quote_ident_double(&filter.column),
            filter.operator.as_sql(),
            sql_quote_literal(&filter.value)
        ));
    }

    let sql = format!("SELECT * FROM _cached WHERE {}", conditions.join(" AND "));
    let df = filter_ctx.sql(&sql).await?;
    let batches = df.collect().await?;

    if batches.is_empty() {
        Ok(RecordBatch::new_empty(batch.schema()))
    } else {
        Ok(concat_batches(&batch.schema(), &batches)?)
    }
}

/// Minimum number of rows per partition when re-chunking fetched batches for
/// multi-partition registration. Matches DataFusion's default batch size so
/// small tables stay in a single partition (identical scan behavior to the
/// previous single-batch registration).
const MIN_PARTITION_ROWS: usize = 8192;

/// Split `batches` into up to `max_partitions` partition groups for
/// multi-partition `MemTable` registration.
///
/// DataFusion parallelizes partial aggregation and join probes per partition,
/// so a single-partition table executes on one core regardless of
/// `target_partitions`. Re-chunking uses zero-copy [`RecordBatch::slice`] —
/// no row data is copied. Inputs with fewer than [`MIN_PARTITION_ROWS`] rows
/// per would-be partition stay in a single partition to avoid scheduling
/// overhead on tiny tables.
fn partition_batches(batches: Vec<RecordBatch>, max_partitions: usize) -> Vec<Vec<RecordBatch>> {
    let total_rows: usize = batches.iter().map(|b| b.num_rows()).sum();
    let partition_count = (total_rows / MIN_PARTITION_ROWS).clamp(1, max_partitions.max(1));
    if partition_count <= 1 {
        return vec![batches];
    }

    // Distribute rows evenly: fill each partition up to `rows_per_partition`
    // rows, slicing batches at partition boundaries (zero-copy).
    let rows_per_partition = total_rows.div_ceil(partition_count);
    let mut partitions: Vec<Vec<RecordBatch>> = vec![Vec::new(); partition_count];
    let mut current = 0;
    let mut current_rows = 0;

    for batch in batches {
        let rows = batch.num_rows();
        let mut offset = 0;
        while offset < rows {
            if current_rows >= rows_per_partition && current + 1 < partition_count {
                current += 1;
                current_rows = 0;
            }
            let take = if current + 1 < partition_count {
                (rows - offset).min(rows_per_partition - current_rows)
            } else {
                // The last partition takes everything that remains.
                rows - offset
            };
            partitions[current].push(batch.slice(offset, take));
            offset += take;
            current_rows += take;
        }
    }

    // Drop partitions that received no batches (possible with skewed row
    // counts); `MemTable` accepts any partition count.
    partitions.retain(|p| !p.is_empty());
    partitions
}

/// Register `batches` as an in-memory table, preserving them as multiple
/// `MemTable` partitions instead of concatenating into one giant batch.
///
/// Functionally equivalent to [`SessionContext::register_batch`] (same bare
/// table-name semantics — callers pass lowercase names), but avoids the full
/// extra copy made by `concat_batches` and lets DataFusion parallelize across
/// `target_partitions` cores. An empty batch list registers nothing (matching
/// the previous skip-on-empty behavior); zero-row batches register an empty
/// table with the correct schema.
fn register_partitioned_table(
    ctx: &SessionContext,
    name: &str,
    batches: Vec<RecordBatch>,
) -> QueryResult<()> {
    let Some(first) = batches.first() else {
        return Ok(());
    };
    let schema = first.schema();
    let target_partitions = ctx.copied_config().target_partitions();
    let partitions = partition_batches(batches, target_partitions);
    let table = MemTable::try_new(schema, partitions)?;
    ctx.register_table(TableReference::bare(name), Arc::new(table))?;
    Ok(())
}

/// Whether an Arrow type is an integer family type (including
/// dictionary-encoded integer variants).
///
/// Used to classify IN-filter values: integer join keys are rendered by
/// connectors as unquoted numeric literals so the fact-table FK index stays
/// usable.
fn is_integer_arrow_type(data_type: &arrow::datatypes::DataType) -> bool {
    use arrow::datatypes::DataType as AT;
    match data_type {
        AT::Int8
        | AT::Int16
        | AT::Int32
        | AT::Int64
        | AT::UInt8
        | AT::UInt16
        | AT::UInt32
        | AT::UInt64 => true,
        AT::Dictionary(_, value_type) => is_integer_arrow_type(value_type),
        _ => false,
    }
}

/// Extract unique string values from a named column across Arrow record
/// batches, classifying the source column type for SQL rendering.
///
/// Values are cast to strings for use in IN filter lists; null values are
/// excluded. The returned [`InValueKind`] is [`InValueKind::Integer`] when
/// the source column is an integer family type (including dictionary-encoded
/// integers — the Utf8 cast unpacks the dictionary, so values are plain
/// decimal strings either way) **and** every extracted value parses as
/// `i128`; otherwise [`InValueKind::Text`]. Connectors re-validate before
/// rendering unquoted literals, so a wrong `Integer` classification can cost
/// performance but never correctness.
fn extract_column_values(batches: &[RecordBatch], column_name: &str) -> (Vec<String>, InValueKind) {
    let mut values = std::collections::HashSet::new();
    let mut all_integer_typed = true;
    let mut found_column = false;
    for batch in batches {
        let Ok(idx) = batch.schema().index_of(column_name) else {
            continue;
        };
        let array = batch.column(idx);
        found_column = true;
        // Batches of one table share a schema, but classify every batch
        // defensively: any non-integer occurrence downgrades to Text.
        if !is_integer_arrow_type(array.data_type()) {
            all_integer_typed = false;
        }
        let Ok(string_array) = arrow::compute::cast(array, &arrow::datatypes::DataType::Utf8)
        else {
            continue;
        };
        let str_arr = string_array
            .as_any()
            .downcast_ref::<arrow::array::StringArray>();
        if let Some(str_arr) = str_arr {
            for i in 0..str_arr.len() {
                if !str_arr.is_null(i) {
                    values.insert(str_arr.value(i).to_string());
                }
            }
        }
    }
    let values: Vec<String> = values.into_iter().collect();
    // Defensive validation: Integer kind requires every value to be a clean
    // decimal integer. Data integrity over speed — downgrade to Text if any
    // value fails to parse.
    let kind =
        if found_column && all_integer_typed && values.iter().all(|v| v.parse::<i128>().is_ok()) {
            InValueKind::Integer
        } else {
            InValueKind::Text
        };
    (values, kind)
}

/// Recursively resolve and generate SQL for compound measure expressions
/// where sub-aggregates may have independent filter contexts.
///
/// This handles cases like `ABS(SUM(x, bikes) - SUM(x, acc))` where each
/// sub-aggregate has its own variable/KEEP context. The standard single-context
/// resolver would merge conflicting filters; this function resolves each
/// sub-aggregate independently.
fn resolve_compound_sql(
    expr: &Expression,
    model: &DataModel,
    fact_table: &str,
    fact_model_name: &str,
    context_join_tables: &mut Vec<String>,
    override_joins: &mut Vec<OverrideJoinEntry>,
) -> QueryResult<String> {
    match expr {
        // Compound expressions: recurse into each operand independently.
        Expression::BinaryOp { left, op, right } => {
            let l = resolve_compound_sql(
                left,
                model,
                fact_table,
                fact_model_name,
                context_join_tables,
                override_joins,
            )?;
            let r = resolve_compound_sql(
                right,
                model,
                fact_table,
                fact_model_name,
                context_join_tables,
                override_joins,
            )?;
            Ok(format!("({l} {} {r})", op.as_sql()))
        }
        Expression::SafeDivide {
            numerator,
            denominator,
            alternate,
        } => {
            let n = resolve_compound_sql(
                numerator,
                model,
                fact_table,
                fact_model_name,
                context_join_tables,
                override_joins,
            )?;
            let d = resolve_compound_sql(
                denominator,
                model,
                fact_table,
                fact_model_name,
                context_join_tables,
                override_joins,
            )?;
            let alt = match alternate {
                Some(a) => resolve_compound_sql(
                    a,
                    model,
                    fact_table,
                    fact_model_name,
                    context_join_tables,
                    override_joins,
                )?,
                None => "NULL".to_string(),
            };
            Ok(format!(
                "CASE WHEN {d} = 0 THEN {alt} ELSE CAST({n} AS DOUBLE) / {d} END"
            ))
        }
        Expression::ScalarFunc { function, args } => {
            let mapped = args
                .iter()
                .map(|a| {
                    resolve_compound_sql(
                        a,
                        model,
                        fact_table,
                        fact_model_name,
                        context_join_tables,
                        override_joins,
                    )
                })
                .collect::<QueryResult<Vec<_>>>()?;
            Ok(function.to_sql_strs(&mapped))
        }
        Expression::Coalesce(exprs) => {
            let mapped = exprs
                .iter()
                .map(|e| {
                    resolve_compound_sql(
                        e,
                        model,
                        fact_table,
                        fact_model_name,
                        context_join_tables,
                        override_joins,
                    )
                })
                .collect::<QueryResult<Vec<_>>>()?;
            Ok(format!("COALESCE({})", mapped.join(", ")))
        }
        Expression::If {
            condition,
            then_expr,
            else_expr,
        } => {
            let c = resolve_compound_sql(
                condition,
                model,
                fact_table,
                fact_model_name,
                context_join_tables,
                override_joins,
            )?;
            let t = resolve_compound_sql(
                then_expr,
                model,
                fact_table,
                fact_model_name,
                context_join_tables,
                override_joins,
            )?;
            let e = resolve_compound_sql(
                else_expr,
                model,
                fact_table,
                fact_model_name,
                context_join_tables,
                override_joins,
            )?;
            Ok(format!("CASE WHEN {c} THEN {t} ELSE {e} END"))
        }
        Expression::IsBlank(inner) => {
            let i = resolve_compound_sql(
                inner,
                model,
                fact_table,
                fact_model_name,
                context_join_tables,
                override_joins,
            )?;
            Ok(format!("({i} IS NULL)"))
        }
        Expression::Not(inner) => {
            let i = resolve_compound_sql(
                inner,
                model,
                fact_table,
                fact_model_name,
                context_join_tables,
                override_joins,
            )?;
            Ok(format!("(NOT {i})"))
        }

        // Expressions with context ops: resolve independently via the context resolver.
        _ if expr.has_context_ops() => {
            let resolver = ContextResolver::new(model);
            let (stripped, ctx) = resolver.resolve(expr)?;
            let effective = ctx.effective_filters(&[]);

            for f in &effective {
                if f.table != fact_model_name {
                    context_join_tables.push(f.table.clone());
                }
            }

            // Collect alias map from USERELATIONSHIP overrides.
            let alias_map =
                build_override_alias_map(&ctx, model, fact_model_name, fact_table, override_joins);

            if effective.is_empty() {
                return resolve_compound_sql(
                    &stripped,
                    model,
                    fact_table,
                    fact_model_name,
                    context_join_tables,
                    override_joins,
                );
            }

            let condition = build_condition_sql_with_aliases(
                &effective,
                fact_table,
                fact_model_name,
                model,
                &alias_map,
            )?;
            let measure_table = &fact_model_name.to_lowercase();
            Ok(stripped.to_case_when_sql(&condition, measure_table)?)
        }

        // Naked aggregate without context: generate plain SQL with qualified columns.
        Expression::Aggregate { operation, operand } => {
            // COUNT(*) ignores its operand (a bare table reference, which is
            // not renderable as scalar SQL) — handle it before rendering.
            if matches!(operation, AggregateOp::CountRows) {
                return Ok("COUNT(*)".to_string());
            }
            let col = operand.to_sql_string()?;
            let fact = fact_model_name.to_lowercase();
            let qualified = if col.contains('.') {
                col
            } else if col.starts_with('"') {
                // Already quoted by to_sql_string (e.g., QualifiedColumnRef → "col")
                format!("{fact}.{col}")
            } else {
                format!("{fact}.\"{col}\"")
            };
            Ok(operation.render_sql(&qualified))
        }

        // Leaf expressions: generate plain SQL.
        _ => Ok(expr.to_sql_string()?),
    }
}

/// Remove hidden `__order_N` sort-helper columns from result batches.
///
/// The main local-aggregation SQL projects `MIN(sort_col)` helper columns to
/// implement sort-by-column ordering (DataFusion cannot ORDER BY an
/// unprojected aggregate); they are internal and must not appear in results.
/// Typed error for query shapes that do not support ROLLUP totals yet.
///
/// The unsupported combinations are listed in the `TotalsMode` docs; erroring
/// is deliberate — silently returning detail-only rows (or wrong subtotals)
/// would corrupt pivot output.
fn totals_unsupported(what: &str) -> crate::error::QueryError {
    crate::error::QueryError::InvalidQuery(format!(
        "totals (TotalsMode::Rollup) is not supported with {what} yet"
    ))
}

/// Render the trailing `__grouping_id` SELECT item for a local ROLLUP query.
///
/// `group_terms` are the qualified group-by SQL terms (e.g.
/// `dim_table."col"`) in request order. The bitmask follows the engine
/// contract — bit `i` (LSB = `group_by[0]`) set when that column is rolled
/// up — built from per-column `GROUPING(...)` calls so the bit order is
/// explicit. DataFusion rewrites `GROUPING()` over grouping sets into its
/// internal grouping-id column, so the calls cost nothing at execution time.
/// The `CAST` pins the result type to `Int32` per the contract. With no
/// group-by terms the single aggregate row is its own grand total: literal
/// `0`.
fn grouping_id_select_sql(group_terms: &[String]) -> String {
    if group_terms.is_empty() {
        return format!("CAST(0 AS INT) AS \"{GROUPING_ID_COLUMN}\"");
    }
    let bits: Vec<String> = group_terms
        .iter()
        .enumerate()
        .map(|(i, term)| {
            if i == 0 {
                format!("GROUPING({term})")
            } else {
                format!("GROUPING({term}) * {}", 1u32 << i)
            }
        })
        .collect();
    format!(
        "CAST({} AS INT) AS \"{GROUPING_ID_COLUMN}\"",
        bits.join(" + ")
    )
}

fn strip_order_helper_columns(batches: Vec<RecordBatch>) -> QueryResult<Vec<RecordBatch>> {
    let mut out = Vec::with_capacity(batches.len());
    for batch in batches {
        let schema = batch.schema();
        let keep: Vec<usize> = schema
            .fields()
            .iter()
            .enumerate()
            .filter(|(_, f)| !f.name().starts_with("__order_"))
            .map(|(i, _)| i)
            .collect();
        if keep.len() == schema.fields().len() {
            out.push(batch);
        } else {
            out.push(batch.project(&keep)?);
        }
    }
    Ok(out)
}

/// Apply ORDER BY / LIMIT to already-computed result batches.
///
/// Used by execution paths whose final result is assembled outside a single
/// SQL statement (pushed join aggregation, multi-fact-table combination,
/// window and QUERY-in-VAR measures, two-stage pre-aggregation, post-lookup
/// results). Sorting uses Arrow's lexicographic sort over the **result
/// columns**: dimension targets sort by the group-by output column, measure
/// targets by the measure column (both matched case-insensitively). Model
/// `sort_by_column` substitution does NOT apply here — the sort column is not
/// part of the result; the planner routes substitution-dependent orderings to
/// SQL-ordered paths. Sort keys missing from the result schema are skipped.
///
/// Null ordering matches PostgreSQL/DataFusion defaults: nulls last for
/// ascending keys, nulls first for descending keys.
///
/// `limit` is applied after sorting; `Some(0)` produces an empty result
/// (schema preserved). Batches with differing schemas (e.g. per-measure
/// outputs of window evaluation) are sorted individually.
pub(crate) fn apply_order_and_limit(
    batches: Vec<RecordBatch>,
    order_by: &[OrderByClause],
    limit: Option<usize>,
) -> QueryResult<Vec<RecordBatch>> {
    if (order_by.is_empty() && limit.is_none()) || batches.is_empty() {
        return Ok(batches);
    }

    // Sort. Batches sharing one schema are concatenated so ordering holds
    // across batch boundaries; heterogeneous batches are sorted individually.
    let sorted: Vec<RecordBatch> = if order_by.is_empty() {
        batches
    } else {
        let first_schema = batches[0].schema();
        if batches.len() > 1 && batches.iter().all(|b| b.schema() == first_schema) {
            let combined = concat_batches(&first_schema, &batches)?;
            vec![sort_batch(&combined, order_by)?]
        } else {
            batches
                .iter()
                .map(|b| sort_batch(b, order_by))
                .collect::<QueryResult<Vec<_>>>()?
        }
    };

    // Limit: take rows in order until the cap is reached.
    let Some(n) = limit else {
        return Ok(sorted);
    };
    let mut remaining = n;
    let mut limited = Vec::new();
    for batch in &sorted {
        if remaining == 0 {
            break;
        }
        let take = batch.num_rows().min(remaining);
        limited.push(batch.slice(0, take));
        remaining -= take;
    }
    if limited.is_empty() {
        // LIMIT 0 (or all batches empty): preserve the result schema.
        limited.push(sorted[0].slice(0, 0));
    }
    Ok(limited)
}

/// Sort a single batch by the order-by clauses, matching sort keys against
/// the batch's columns case-insensitively. Missing keys are skipped; when no
/// key resolves the batch is returned unchanged.
fn sort_batch(batch: &RecordBatch, order_by: &[OrderByClause]) -> QueryResult<RecordBatch> {
    use arrow::compute::{lexsort_to_indices, take, SortColumn, SortOptions};

    let schema = batch.schema();
    let mut sort_columns: Vec<SortColumn> = Vec::new();
    for clause in order_by {
        let name = match &clause.target {
            OrderTarget::Column(col) => col.column.as_str(),
            OrderTarget::Measure(measure) => measure.as_str(),
        };
        let Some((idx, _)) = schema
            .fields()
            .iter()
            .enumerate()
            .find(|(_, f)| f.name().eq_ignore_ascii_case(name))
        else {
            continue;
        };
        sort_columns.push(SortColumn {
            values: batch.column(idx).clone(),
            options: Some(SortOptions {
                descending: clause.descending,
                nulls_first: clause.descending,
            }),
        });
    }
    if sort_columns.is_empty() || batch.num_rows() == 0 {
        return Ok(batch.clone());
    }

    let indices = lexsort_to_indices(&sort_columns, None)?;
    let columns = batch
        .columns()
        .iter()
        .map(|c| take(c, &indices, None))
        .collect::<Result<Vec<_>, _>>()?;
    Ok(RecordBatch::try_new(schema, columns)?)
}

/// Partition measures into groups by their home table, preserving insertion order.
///
/// Returns a list of (table_name, measures) groups. Within each group, the
/// measures are in their original order.
fn partition_measures_by_table(measures: &[Measure]) -> Vec<(&str, Vec<&Measure>)> {
    let mut groups: Vec<(&str, Vec<&Measure>)> = Vec::new();
    for m in measures {
        let table = m.table();
        if let Some(group) = groups.iter_mut().find(|(t, _)| *t == table) {
            group.1.push(m);
        } else {
            groups.push((table, vec![m]));
        }
    }
    groups
}

/// Build a cache key for a materialized QUERY binding.
///
/// The key combines the binding name, sorted source filters, and sorted group-by
/// columns into a single string. Two QUERY bindings with the same key will
/// produce identical RecordBatches and can safely share the cached result.
fn build_query_cache_key(
    binding_name: &str,
    source_filters: &[&ResolvedFilter],
    augmented_gb: &[(String, String)],
) -> String {
    use std::fmt::Write;
    let mut key = String::new();
    write!(key, "{}|", binding_name).unwrap();

    // Sorted filters.
    let mut filter_parts: Vec<String> = source_filters
        .iter()
        .map(|f| {
            format!(
                "{}.{}{}'{}'",
                f.table,
                f.column,
                f.operator.as_sql(),
                f.value
            )
        })
        .collect();
    filter_parts.sort();
    write!(key, "F[{}]|", filter_parts.join(",")).unwrap();

    // Sorted group-by.
    let mut gb_parts: Vec<String> = augmented_gb
        .iter()
        .map(|(t, c)| format!("{t}.{c}"))
        .collect();
    gb_parts.sort();
    write!(key, "G[{}]", gb_parts.join(",")).unwrap();

    key
}

#[cfg(test)]
mod tests {
    use super::*;
    use arrow::array::{Int32Array, StringArray};
    use arrow::datatypes::{DataType, Field, Schema};
    use std::sync::Arc;

    #[test]
    fn extract_column_values_from_string_column() {
        let schema = Arc::new(Schema::new(vec![Field::new("name", DataType::Utf8, true)]));
        let batch = RecordBatch::try_new(
            schema,
            vec![Arc::new(StringArray::from(vec![
                Some("Alice"),
                Some("Bob"),
                None,
                Some("Alice"),
            ]))],
        )
        .unwrap();

        let (values, kind) = extract_column_values(&[batch], "name");
        assert_eq!(values.len(), 2); // Deduplicated, nulls excluded
        assert!(values.contains(&"Alice".to_string()));
        assert!(values.contains(&"Bob".to_string()));
        assert_eq!(kind, InValueKind::Text);
    }

    #[test]
    fn extract_column_values_from_int_column() {
        let schema = Arc::new(Schema::new(vec![Field::new("id", DataType::Int32, true)]));
        let batch = RecordBatch::try_new(
            schema,
            vec![Arc::new(Int32Array::from(vec![
                Some(1),
                Some(2),
                Some(3),
                None,
                Some(1),
            ]))],
        )
        .unwrap();

        let (values, kind) = extract_column_values(&[batch], "id");
        assert_eq!(values.len(), 3); // 1, 2, 3 — deduplicated, null excluded
        assert_eq!(kind, InValueKind::Integer);
        // Every extracted value is a clean decimal integer string.
        assert!(values.iter().all(|v| v.parse::<i128>().is_ok()));
    }

    #[test]
    fn extract_column_values_from_dictionary_int_column_is_integer() {
        use arrow::array::{DictionaryArray, Int64Array, Int8Array};

        let keys = Int8Array::from(vec![Some(0), Some(1), None, Some(0)]);
        let dict_values = Int64Array::from(vec![100, 200]);
        let dict = DictionaryArray::new(keys, Arc::new(dict_values) as arrow::array::ArrayRef);
        let schema = Arc::new(Schema::new(vec![Field::new(
            "key",
            dict.data_type().clone(),
            true,
        )]));
        let batch = RecordBatch::try_new(schema, vec![Arc::new(dict)]).unwrap();

        let (values, kind) = extract_column_values(&[batch], "key");
        assert_eq!(kind, InValueKind::Integer);
        assert_eq!(values.len(), 2); // 100, 200 — deduplicated, null excluded
        assert!(values.contains(&"100".to_string()));
        assert!(values.contains(&"200".to_string()));
    }

    #[test]
    fn extract_column_values_from_dictionary_string_column_is_text() {
        use arrow::array::{DictionaryArray, Int32Array as Keys};

        let keys = Keys::from(vec![0, 1, 0]);
        let dict_values = StringArray::from(vec!["red", "blue"]);
        let dict = DictionaryArray::new(keys, Arc::new(dict_values) as arrow::array::ArrayRef);
        let schema = Arc::new(Schema::new(vec![Field::new(
            "color",
            dict.data_type().clone(),
            true,
        )]));
        let batch = RecordBatch::try_new(schema, vec![Arc::new(dict)]).unwrap();

        let (values, kind) = extract_column_values(&[batch], "color");
        assert_eq!(kind, InValueKind::Text);
        assert_eq!(values.len(), 2);
    }

    #[test]
    fn extract_column_values_numeric_looking_strings_stay_text() {
        // A Utf8 column whose values happen to be numeric must remain Text:
        // classification follows the source Arrow type, not value shape.
        let schema = Arc::new(Schema::new(vec![Field::new("code", DataType::Utf8, true)]));
        let batch = RecordBatch::try_new(
            schema,
            vec![Arc::new(StringArray::from(vec!["1", "2", "3"]))],
        )
        .unwrap();

        let (values, kind) = extract_column_values(&[batch], "code");
        assert_eq!(values.len(), 3);
        assert_eq!(kind, InValueKind::Text);
    }

    #[test]
    fn extract_column_values_missing_column() {
        let schema = Arc::new(Schema::new(vec![Field::new("id", DataType::Int32, false)]));
        let batch =
            RecordBatch::try_new(schema, vec![Arc::new(Int32Array::from(vec![1, 2, 3]))]).unwrap();

        let (values, kind) = extract_column_values(&[batch], "nonexistent");
        assert!(values.is_empty());
        assert_eq!(kind, InValueKind::Text);
    }

    #[test]
    fn extract_column_values_empty_batches() {
        let (values, kind) = extract_column_values(&[], "id");
        assert!(values.is_empty());
        assert_eq!(kind, InValueKind::Text);
    }

    #[test]
    fn partition_measures_single_table() {
        let m1 = Measure::simple("m1", "fact_sales", "amount", AggregateOp::Sum);
        let m2 = Measure::simple("m2", "fact_sales", "id", AggregateOp::Count);
        let measures = [m1, m2];
        let groups = partition_measures_by_table(&measures);
        assert_eq!(groups.len(), 1);
        assert_eq!(groups[0].0, "fact_sales");
        assert_eq!(groups[0].1.len(), 2);
    }

    #[test]
    fn partition_measures_two_tables() {
        let m1 = Measure::simple("sales_total", "fact_sales", "amount", AggregateOp::Sum);
        let m2 = Measure::simple(
            "purchase_total",
            "fact_purchasing",
            "amount",
            AggregateOp::Sum,
        );
        let m3 = Measure::simple("sales_count", "fact_sales", "id", AggregateOp::Count);
        let measures = [m1, m2, m3];
        let groups = partition_measures_by_table(&measures);
        assert_eq!(groups.len(), 2);
        assert_eq!(groups[0].0, "fact_sales");
        assert_eq!(groups[0].1.len(), 2); // sales_total + sales_count
        assert_eq!(groups[1].0, "fact_purchasing");
        assert_eq!(groups[1].1.len(), 1); // purchase_total
    }

    #[test]
    fn partition_measures_three_tables() {
        let m1 = Measure::simple("a", "t1", "x", AggregateOp::Sum);
        let m2 = Measure::simple("b", "t2", "x", AggregateOp::Sum);
        let m3 = Measure::simple("c", "t3", "x", AggregateOp::Sum);
        let measures = [m1, m2, m3];
        let groups = partition_measures_by_table(&measures);
        assert_eq!(groups.len(), 3);
        assert_eq!(groups[0].0, "t1");
        assert_eq!(groups[1].0, "t2");
        assert_eq!(groups[2].0, "t3");
    }

    /// Build a single-column Int64 batch with values `start..start + len`.
    fn int64_batch(start: i64, len: usize) -> RecordBatch {
        let schema = Arc::new(Schema::new(vec![Field::new("v", DataType::Int64, false)]));
        RecordBatch::try_new(
            schema,
            vec![Arc::new(Int64Array::from_iter_values(
                start..start + len as i64,
            ))],
        )
        .unwrap()
    }

    #[test]
    fn partition_batches_small_input_stays_single_partition() {
        let batch = int64_batch(0, 100);
        let parts = partition_batches(vec![batch], 8);
        assert_eq!(parts.len(), 1);
        assert_eq!(parts[0].len(), 1);
        assert_eq!(parts[0][0].num_rows(), 100);
    }

    #[test]
    fn partition_batches_rechunks_single_large_batch() {
        let parts = partition_batches(vec![int64_batch(0, 40_000)], 4);
        assert_eq!(parts.len(), 4);
        // Total rows preserved, evenly distributed (ceil(40_000 / 4) max).
        let total: usize = parts.iter().flatten().map(|b| b.num_rows()).sum();
        assert_eq!(total, 40_000);
        for part in &parts {
            let rows: usize = part.iter().map(|b| b.num_rows()).sum();
            assert!(rows <= 10_000);
        }
        // Row order preserved across partitions in sequence.
        let all: Vec<RecordBatch> = parts.into_iter().flatten().collect();
        let combined = concat_batches(&all[0].schema(), &all).unwrap();
        let col = combined
            .column(0)
            .as_any()
            .downcast_ref::<Int64Array>()
            .unwrap();
        assert_eq!(col.value(0), 0);
        assert_eq!(col.value(39_999), 39_999);
    }

    #[test]
    fn partition_batches_respects_max_partitions() {
        let parts = partition_batches(vec![int64_batch(0, 100_000)], 3);
        assert_eq!(parts.len(), 3);
        let total: usize = parts.iter().flatten().map(|b| b.num_rows()).sum();
        assert_eq!(total, 100_000);
    }

    #[test]
    fn partition_batches_slices_share_buffers() {
        let batch = int64_batch(0, 20_000);
        let base_ptr = batch.column(0).to_data().buffers()[0].as_ptr() as usize;
        let end_ptr = base_ptr + 20_000 * std::mem::size_of::<i64>();

        let parts = partition_batches(vec![batch], 2);
        assert_eq!(parts.len(), 2);
        for slice in parts.iter().flatten() {
            // Zero-copy: every slice's value buffer points into the original
            // allocation instead of a fresh copy.
            let ptr = slice.column(0).to_data().buffers()[0].as_ptr() as usize;
            assert!(
                ptr >= base_ptr && ptr < end_ptr,
                "slice buffer was copied instead of shared"
            );
        }
    }

    #[test]
    fn partition_batches_groups_existing_batches() {
        let batches: Vec<RecordBatch> = (0..4).map(|i| int64_batch(i * 8192, 8192)).collect();
        let parts = partition_batches(batches, 2);
        assert_eq!(parts.len(), 2);
        let rows: Vec<usize> = parts
            .iter()
            .map(|p| p.iter().map(|b| b.num_rows()).sum())
            .collect();
        assert_eq!(rows, vec![16_384, 16_384]);
    }

    #[test]
    fn partition_batches_empty_input_single_empty_partition() {
        let parts = partition_batches(vec![], 8);
        assert_eq!(parts.len(), 1);
        assert!(parts[0].is_empty());
    }

    #[test]
    fn partition_batches_zero_row_batch_preserved() {
        let schema = Arc::new(Schema::new(vec![Field::new("v", DataType::Int64, false)]));
        let batch = RecordBatch::new_empty(schema.clone());
        let parts = partition_batches(vec![batch], 8);
        assert_eq!(parts.len(), 1);
        assert_eq!(parts[0].len(), 1);
        assert_eq!(parts[0][0].num_rows(), 0);
        assert_eq!(parts[0][0].schema(), schema);
    }

    #[tokio::test]
    async fn register_partitioned_table_preserves_rows_and_sums() {
        let ctx = SessionContext::new();
        let n = 20_000i64;
        register_partitioned_table(&ctx, "t", vec![int64_batch(0, n as usize)]).unwrap();

        let df = ctx.sql("SELECT COUNT(*) AS c, SUM(v) AS s FROM t").await;
        let out = df.unwrap().collect().await.unwrap();
        let combined = concat_batches(&out[0].schema(), &out).unwrap();
        let count = combined
            .column(0)
            .as_any()
            .downcast_ref::<Int64Array>()
            .unwrap()
            .value(0);
        let sum = combined
            .column(1)
            .as_any()
            .downcast_ref::<Int64Array>()
            .unwrap()
            .value(0);
        assert_eq!(count, n);
        assert_eq!(sum, n * (n - 1) / 2);
    }

    #[tokio::test]
    async fn register_partitioned_table_empty_list_registers_nothing() {
        let ctx = SessionContext::new();
        register_partitioned_table(&ctx, "t", vec![]).unwrap();
        assert!(ctx.sql("SELECT * FROM t").await.is_err());
    }

    #[tokio::test]
    async fn register_partitioned_table_zero_rows_keeps_schema() {
        let ctx = SessionContext::new();
        let schema = Arc::new(Schema::new(vec![Field::new("v", DataType::Int64, false)]));
        register_partitioned_table(&ctx, "t", vec![RecordBatch::new_empty(schema)]).unwrap();

        let out = ctx
            .sql("SELECT v FROM t")
            .await
            .unwrap()
            .collect()
            .await
            .unwrap();
        let rows: usize = out.iter().map(|b| b.num_rows()).sum();
        assert_eq!(rows, 0);
    }

    #[tokio::test]
    async fn cache_served_table_skips_optimization_and_aggregates() {
        use arrow::array::Float64Array;
        use engine_core::model::column::Column;
        use engine_core::model::table::{StorageMode, Table};
        use engine_core::types::DataType as EngineDataType;

        // Model: one in-memory fact table.
        let table = Table::new(
            "fact_sales",
            vec![
                Column::new("id", EngineDataType::Int64),
                Column::new("amount", EngineDataType::Float64),
            ],
        )
        .unwrap()
        .with_storage_mode(StorageMode::InMemory);
        let model = DataModel::builder().add_table(table).build().unwrap();

        // Cache holds the batch (pre-optimized at refresh time in production).
        let schema = Arc::new(Schema::new(vec![
            Field::new("id", DataType::Int64, true),
            Field::new("amount", DataType::Float64, true),
        ]));
        let batch = RecordBatch::try_new(
            schema,
            vec![
                Arc::new(Int64Array::from(vec![1, 2, 3])),
                Arc::new(Float64Array::from(vec![10.0, 20.0, 30.0])),
            ],
        )
        .unwrap();
        let mut cache = InMemoryCache::new();
        cache.store("fact_sales", batch).unwrap();

        // No connector registered: the table must be served from the cache.
        let registry = SourceRegistry::new();
        let fetches = vec![(
            "fact_sales".to_string(),
            engine_connectors::FetchRequest {
                table: "fact_sales".to_string(),
                ..Default::default()
            },
        )];
        let measures = vec![Measure::simple(
            "Total",
            "fact_sales",
            "amount",
            AggregateOp::Sum,
        )];

        let mut plan = PlanNode::new(PlanOperation::LocalAggregation, "test");
        let batches = QueryExecutor::execute_local_aggregation(
            &fetches,
            &measures,
            &[],
            &[],
            &[],
            None,
            TotalsMode::None,
            &model,
            &registry,
            Some(&cache),
            None,
            Some(&mut plan),
        )
        .await
        .unwrap();

        // Result: SUM(amount) = 60.0.
        let combined = concat_batches(&batches[0].schema(), &batches).unwrap();
        let total = combined
            .column(0)
            .as_any()
            .downcast_ref::<Float64Array>()
            .unwrap()
            .value(0);
        assert!((total - 60.0).abs() < 1e-9);

        // The fetch node reports the cache source and the optimization skip.
        let fetch_node = plan
            .children
            .iter()
            .find(|n| n.label == "Cache: fact_sales")
            .expect("cache fetch plan node");
        let prop = |key: &str| {
            fetch_node
                .properties
                .iter()
                .find(|p| p.key == key)
                .map(|p| &p.value)
        };
        match prop("source") {
            Some(PlanValue::Text(s)) => assert_eq!(s, "in_memory_cache"),
            other => panic!("unexpected source property: {other:?}"),
        }
        match prop("optimization") {
            Some(PlanValue::Text(s)) => assert_eq!(s, "cached (pre-optimized)"),
            other => panic!("unexpected optimization property: {other:?}"),
        }
    }
    // --- ORDER BY / LIMIT execution ---

    mod order_and_limit {
        use super::*;
        use crate::planner::PushdownPlanner;
        use crate::registry::SourceBinding;
        use crate::request::{OrderByClause, QueryRequest};
        use arrow::array::Float64Array;
        use arrow::array::StringArray;
        use engine_core::compute::measure::sum_measure;
        use engine_core::model::column::Column;
        use engine_core::model::table::{StorageMode, Table};
        use engine_core::types::DataType as EngineDataType;

        /// In-memory single-table model: regions + months (with sort-by) +
        /// amounts. Per-region totals: East 15.0, West 20.0, South 30.0.
        /// Per-month totals: Jan 15.0, Feb 20.0, Mar 30.0 (alphabetically
        /// Feb < Jan < Mar, but month_number orders Jan, Feb, Mar).
        fn fixture() -> (DataModel, InMemoryCache, SourceRegistry) {
            let table = Table::new(
                "fact_sales",
                vec![
                    Column::new("region", EngineDataType::String),
                    Column::new("month_name", EngineDataType::String).with_sort_by("month_number"),
                    Column::new("month_number", EngineDataType::Int32),
                    Column::new("amount", EngineDataType::Float64),
                ],
            )
            .unwrap()
            .with_storage_mode(StorageMode::InMemory);

            let model = DataModel::builder()
                .add_table(table)
                .add_measure(sum_measure("Total", "fact_sales", "amount"))
                .build()
                .unwrap();

            let schema = Arc::new(Schema::new(vec![
                Field::new("region", DataType::Utf8, true),
                Field::new("month_name", DataType::Utf8, true),
                Field::new("month_number", DataType::Int32, true),
                Field::new("amount", DataType::Float64, true),
            ]));
            let batch = RecordBatch::try_new(
                schema,
                vec![
                    Arc::new(StringArray::from(vec!["West", "East", "South", "East"])),
                    Arc::new(StringArray::from(vec!["Feb", "Jan", "Mar", "Jan"])),
                    Arc::new(Int32Array::from(vec![2, 1, 3, 1])),
                    Arc::new(Float64Array::from(vec![20.0, 10.0, 30.0, 5.0])),
                ],
            )
            .unwrap();
            let mut cache = InMemoryCache::new();
            cache.store("fact_sales", batch).unwrap();

            // Bind the table so the planner accepts it; the in-memory cache
            // serves the data, so no connector is ever contacted.
            let mut registry = SourceRegistry::new();
            registry.bind("fact_sales", 0, SourceBinding::new("public", "fact_sales"));

            (model, cache, registry)
        }

        /// Plan + execute a request against the in-memory fixture.
        async fn run(request: QueryRequest) -> Vec<RecordBatch> {
            let (model, cache, registry) = fixture();
            let plan = PushdownPlanner::plan(&request, &model, &registry).unwrap();
            QueryExecutor::execute(&plan, &model, &registry, Some(&cache), None)
                .await
                .unwrap()
        }

        /// Extract a column as strings (casting through Utf8 to be robust
        /// against dictionary/view encodings of grouped output).
        fn string_column(batches: &[RecordBatch], name: &str) -> Vec<String> {
            let combined = concat_batches(&batches[0].schema(), batches).unwrap();
            let idx = combined.schema().index_of(name).unwrap();
            let cast = arrow::compute::cast(combined.column(idx), &DataType::Utf8).unwrap();
            let arr = cast.as_any().downcast_ref::<StringArray>().unwrap();
            (0..arr.len()).map(|i| arr.value(i).to_string()).collect()
        }

        #[tokio::test]
        async fn order_by_dimension_ascending() {
            let batches = run(QueryRequest {
                measures: vec!["Total".into()],
                group_by: vec![ColumnRef::new("fact_sales", "region")],
                order_by: vec![OrderByClause::column("fact_sales", "region")],
                ..Default::default()
            })
            .await;
            assert_eq!(string_column(&batches, "region"), ["East", "South", "West"]);
        }

        #[tokio::test]
        async fn order_by_dimension_descending() {
            let batches = run(QueryRequest {
                measures: vec!["Total".into()],
                group_by: vec![ColumnRef::new("fact_sales", "region")],
                order_by: vec![OrderByClause::column_desc("fact_sales", "region")],
                ..Default::default()
            })
            .await;
            assert_eq!(string_column(&batches, "region"), ["West", "South", "East"]);
        }

        #[tokio::test]
        async fn top_n_by_measure_descending_with_limit() {
            let batches = run(QueryRequest {
                measures: vec!["Total".into()],
                group_by: vec![ColumnRef::new("fact_sales", "region")],
                order_by: vec![OrderByClause::measure_desc("Total")],
                limit: Some(2),
                ..Default::default()
            })
            .await;
            // Totals: South 30.0, West 20.0, East 15.0 — top 2.
            assert_eq!(string_column(&batches, "region"), ["South", "West"]);
        }

        /// No explicit order_by: the engine defaults to ordering by the
        /// group-by columns — and `month_name` sorts by `month_number`, so
        /// rows come back Jan, Feb, Mar (not alphabetical Feb, Jan, Mar).
        #[tokio::test]
        async fn default_group_by_ordering_applies_sort_by_column() {
            let batches = run(QueryRequest {
                measures: vec!["Total".into()],
                group_by: vec![ColumnRef::new("fact_sales", "month_name")],
                ..Default::default()
            })
            .await;
            assert_eq!(string_column(&batches, "month_name"), ["Jan", "Feb", "Mar"]);
        }

        #[tokio::test]
        async fn explicit_order_by_respects_sort_by_column_descending() {
            let batches = run(QueryRequest {
                measures: vec!["Total".into()],
                group_by: vec![ColumnRef::new("fact_sales", "month_name")],
                order_by: vec![OrderByClause::column_desc("fact_sales", "month_name")],
                ..Default::default()
            })
            .await;
            assert_eq!(string_column(&batches, "month_name"), ["Mar", "Feb", "Jan"]);
        }

        #[tokio::test]
        async fn limit_zero_returns_empty_result() {
            let batches = run(QueryRequest {
                measures: vec!["Total".into()],
                group_by: vec![ColumnRef::new("fact_sales", "region")],
                limit: Some(0),
                ..Default::default()
            })
            .await;
            let rows: usize = batches.iter().map(|b| b.num_rows()).sum();
            assert_eq!(rows, 0);
        }

        // --- apply_order_and_limit (Arrow-level fallback) ---

        /// Two-column result batch: region (Utf8) + Total (Float64).
        fn result_batch(rows: &[(&str, f64)]) -> RecordBatch {
            let schema = Arc::new(Schema::new(vec![
                Field::new("region", DataType::Utf8, true),
                Field::new("Total", DataType::Float64, true),
            ]));
            RecordBatch::try_new(
                schema,
                vec![
                    Arc::new(StringArray::from(
                        rows.iter().map(|(r, _)| *r).collect::<Vec<_>>(),
                    )),
                    Arc::new(Float64Array::from(
                        rows.iter().map(|(_, t)| *t).collect::<Vec<_>>(),
                    )),
                ],
            )
            .unwrap()
        }

        fn regions(batches: &[RecordBatch]) -> Vec<String> {
            string_column(batches, "region")
        }

        #[test]
        fn apply_order_and_limit_sorts_by_measure_desc_and_limits() {
            let batch = result_batch(&[("East", 15.0), ("South", 30.0), ("West", 20.0)]);
            let out = apply_order_and_limit(
                vec![batch],
                &[OrderByClause::measure_desc("Total")],
                Some(2),
            )
            .unwrap();
            assert_eq!(regions(&out), ["South", "West"]);
        }

        #[test]
        fn apply_order_and_limit_sorts_across_batches_with_same_schema() {
            let b1 = result_batch(&[("West", 20.0), ("East", 15.0)]);
            let b2 = result_batch(&[("South", 30.0)]);
            let out = apply_order_and_limit(
                vec![b1, b2],
                &[OrderByClause::column("fact_sales", "region")],
                None,
            )
            .unwrap();
            assert_eq!(regions(&out), ["East", "South", "West"]);
        }

        #[test]
        fn apply_order_and_limit_missing_sort_key_is_skipped() {
            let batch = result_batch(&[("West", 20.0), ("East", 15.0)]);
            let out = apply_order_and_limit(
                vec![batch],
                &[OrderByClause::column("dim", "no_such_column")],
                Some(1),
            )
            .unwrap();
            // Ordering unchanged (key not in result), limit still applied.
            assert_eq!(regions(&out), ["West"]);
        }

        #[test]
        fn apply_order_and_limit_limit_zero_preserves_schema() {
            let batch = result_batch(&[("West", 20.0)]);
            let schema = batch.schema();
            let out =
                apply_order_and_limit(vec![batch], &[OrderByClause::measure("Total")], Some(0))
                    .unwrap();
            let rows: usize = out.iter().map(|b| b.num_rows()).sum();
            assert_eq!(rows, 0);
            assert_eq!(out[0].schema(), schema);
        }

        #[test]
        fn apply_order_and_limit_noop_without_order_or_limit() {
            let batch = result_batch(&[("West", 20.0), ("East", 15.0)]);
            let out = apply_order_and_limit(vec![batch], &[], None).unwrap();
            assert_eq!(regions(&out), ["West", "East"]);
        }
    }

    // --- ROLLUP totals execution ---

    mod totals {
        use super::*;
        use crate::error::QueryError;
        use crate::planner::PushdownPlanner;
        use crate::registry::SourceBinding;
        use crate::request::{LookupColumn, OrderByClause, QueryRequest, TotalsMode};
        use arrow::array::{Float64Array, Int64Array, StringArray};
        use engine_core::compute::expression as expr;
        use engine_core::compute::measure::{
            average_measure, distinct_count_measure, expression_measure, sum_measure, Measure,
        };
        use engine_core::model::column::Column;
        use engine_core::model::table::{StorageMode, Table};
        use engine_core::model::DataModel;
        use engine_core::store::InMemoryCache;
        use engine_core::types::DataType as EngineDataType;

        /// In-memory single-table model with non-additive measures.
        ///
        /// Data is shaped so subtotal levels differ from sums of detail rows:
        /// customer `c1` buys both products in East and `c2` appears in both
        /// East and West, so DISTINCTCOUNT subtotals are smaller than the sum
        /// of the detail counts, and AVG subtotals are not averages of the
        /// detail averages.
        ///
        /// ```text
        /// region product customer amount
        /// East   A       c1       10
        /// East   B       c1       20
        /// East   B       c2       30
        /// West   A       c2       40
        /// West   A       c3       50
        /// ```
        fn fixture() -> (DataModel, InMemoryCache, SourceRegistry) {
            let table = Table::new(
                "fact_sales",
                vec![
                    Column::new("region", EngineDataType::String),
                    Column::new("product", EngineDataType::String),
                    Column::new("customer", EngineDataType::String),
                    Column::new("amount", EngineDataType::Float64),
                ],
            )
            .unwrap()
            .with_storage_mode(StorageMode::InMemory);

            let model = DataModel::builder()
                .add_table(table)
                .add_measure(sum_measure("Total", "fact_sales", "amount"))
                .add_measure(distinct_count_measure(
                    "Customers",
                    "fact_sales",
                    "customer",
                ))
                .add_measure(average_measure("AvgAmount", "fact_sales", "amount"))
                .build()
                .unwrap();

            let schema = Arc::new(Schema::new(vec![
                Field::new("region", DataType::Utf8, true),
                Field::new("product", DataType::Utf8, true),
                Field::new("customer", DataType::Utf8, true),
                Field::new("amount", DataType::Float64, true),
            ]));
            let batch = RecordBatch::try_new(
                schema,
                vec![
                    Arc::new(StringArray::from(vec![
                        "East", "East", "East", "West", "West",
                    ])),
                    Arc::new(StringArray::from(vec!["A", "B", "B", "A", "A"])),
                    Arc::new(StringArray::from(vec!["c1", "c1", "c2", "c2", "c3"])),
                    Arc::new(Float64Array::from(vec![10.0, 20.0, 30.0, 40.0, 50.0])),
                ],
            )
            .unwrap();
            let mut cache = InMemoryCache::new();
            cache.store("fact_sales", batch).unwrap();

            // Bind the table so the planner accepts it; the in-memory cache
            // serves the data, so no connector is ever contacted.
            let mut registry = SourceRegistry::new();
            registry.bind("fact_sales", 0, SourceBinding::new("public", "fact_sales"));

            (model, cache, registry)
        }

        /// Plan + execute a request against the in-memory fixture.
        async fn run(request: QueryRequest) -> QueryResult<Vec<RecordBatch>> {
            let (model, cache, registry) = fixture();
            let plan = PushdownPlanner::plan(&request, &model, &registry)?;
            QueryExecutor::execute(&plan, &model, &registry, Some(&cache), None).await
        }

        /// Combine batches and extract a nullable string column by name.
        fn opt_string_column(combined: &RecordBatch, name: &str) -> Vec<Option<String>> {
            let idx = combined.schema().index_of(name).unwrap();
            let cast = arrow::compute::cast(combined.column(idx), &DataType::Utf8).unwrap();
            let arr = cast.as_any().downcast_ref::<StringArray>().unwrap();
            (0..arr.len())
                .map(|i| (!arr.is_null(i)).then(|| arr.value(i).to_string()))
                .collect()
        }

        fn f64_column(combined: &RecordBatch, name: &str) -> Vec<f64> {
            let idx = combined.schema().index_of(name).unwrap();
            let arr = combined
                .column(idx)
                .as_any()
                .downcast_ref::<Float64Array>()
                .unwrap();
            (0..arr.len()).map(|i| arr.value(i)).collect()
        }

        fn i64_column(combined: &RecordBatch, name: &str) -> Vec<i64> {
            let idx = combined.schema().index_of(name).unwrap();
            let arr = combined
                .column(idx)
                .as_any()
                .downcast_ref::<Int64Array>()
                .unwrap();
            (0..arr.len()).map(|i| arr.value(i)).collect()
        }

        fn grouping_ids(combined: &RecordBatch) -> Vec<i32> {
            let idx = combined.schema().index_of(GROUPING_ID_COLUMN).unwrap();
            let arr = combined
                .column(idx)
                .as_any()
                .downcast_ref::<Int32Array>()
                .unwrap();
            (0..arr.len()).map(|i| arr.value(i)).collect()
        }

        /// Two-dimension rollup: detail rows + per-region subtotals + grand
        /// total, each level recomputed (not summed from details), correct
        /// `__grouping_id` bitmask, default ordering with subtotals after
        /// their group's detail rows.
        #[tokio::test]
        async fn rollup_two_dims_recomputes_each_level() {
            let batches = run(QueryRequest {
                measures: vec!["Total".into(), "Customers".into(), "AvgAmount".into()],
                group_by: vec![
                    ColumnRef::new("fact_sales", "region"),
                    ColumnRef::new("fact_sales", "product"),
                ],
                totals: TotalsMode::Rollup,
                ..Default::default()
            })
            .await
            .unwrap();
            let combined = concat_batches(&batches[0].schema(), &batches).unwrap();

            // Contract: trailing Int32 column named __grouping_id.
            let schema = combined.schema();
            let last = schema.field(schema.fields().len() - 1);
            assert_eq!(last.name(), GROUPING_ID_COLUMN);
            assert_eq!(last.data_type(), &DataType::Int32);

            // Default ordering (region, product ascending, nulls last) puts
            // each region's subtotal after its detail rows and the grand
            // total last.
            let some = |s: &str| Some(s.to_string());
            assert_eq!(
                opt_string_column(&combined, "region"),
                [
                    some("East"),
                    some("East"),
                    some("East"),
                    some("West"),
                    some("West"),
                    None
                ]
            );
            assert_eq!(
                opt_string_column(&combined, "product"),
                [some("A"), some("B"), None, some("A"), None, None]
            );
            // Bitmask: bit 0 = region (group_by[0]), bit 1 = product.
            // Detail = 0; region subtotal rolls up product = 2; grand = 3.
            assert_eq!(grouping_ids(&combined), [0, 0, 2, 0, 2, 3]);

            // SUM is additive — sanity check.
            assert_eq!(
                f64_column(&combined, "Total"),
                [10.0, 50.0, 60.0, 90.0, 90.0, 150.0]
            );

            // DISTINCTCOUNT must be recomputed per level: East subtotal is
            // 2 distinct customers (c1, c2), NOT the detail sum 1 + 2 = 3;
            // the grand total is 3 (c1, c2, c3), NOT 2 + 2 = 4.
            assert_eq!(i64_column(&combined, "Customers"), [1, 2, 2, 2, 2, 3]);

            // AVG must be recomputed per level: East subtotal is
            // (10+20+30)/3 = 20, NOT the average of detail averages
            // (10 + 25) / 2 = 17.5; grand total is 150/5 = 30.
            assert_eq!(
                f64_column(&combined, "AvgAmount"),
                [10.0, 25.0, 20.0, 45.0, 45.0, 30.0]
            );
        }

        #[tokio::test]
        async fn rollup_single_dim_adds_grand_total() {
            let batches = run(QueryRequest {
                measures: vec!["Total".into(), "Customers".into()],
                group_by: vec![ColumnRef::new("fact_sales", "region")],
                totals: TotalsMode::Rollup,
                ..Default::default()
            })
            .await
            .unwrap();
            let combined = concat_batches(&batches[0].schema(), &batches).unwrap();

            let some = |s: &str| Some(s.to_string());
            assert_eq!(
                opt_string_column(&combined, "region"),
                [some("East"), some("West"), None]
            );
            assert_eq!(grouping_ids(&combined), [0, 0, 1]);
            assert_eq!(f64_column(&combined, "Total"), [60.0, 90.0, 150.0]);
            // Grand total: 3 distinct customers, not 2 + 2.
            assert_eq!(i64_column(&combined, "Customers"), [2, 2, 3]);
        }

        /// Totals with an empty group_by: the single aggregate row is both
        /// detail and grand total — `__grouping_id` is 0 (no bits exist).
        #[tokio::test]
        async fn rollup_with_empty_group_by_returns_single_grand_total_row() {
            let batches = run(QueryRequest {
                measures: vec!["Total".into()],
                totals: TotalsMode::Rollup,
                ..Default::default()
            })
            .await
            .unwrap();
            let combined = concat_batches(&batches[0].schema(), &batches).unwrap();

            assert_eq!(combined.num_rows(), 1);
            let schema = combined.schema();
            let last = schema.field(schema.fields().len() - 1);
            assert_eq!(last.name(), GROUPING_ID_COLUMN);
            assert_eq!(last.data_type(), &DataType::Int32);
            assert_eq!(grouping_ids(&combined), [0]);
            assert_eq!(f64_column(&combined, "Total"), [150.0]);
        }

        /// `limit` applies to the combined result including subtotal rows:
        /// ordering by the measure descending puts the grand total first.
        #[tokio::test]
        async fn rollup_limit_applies_after_totals_rows_are_included() {
            let batches = run(QueryRequest {
                measures: vec!["Total".into()],
                group_by: vec![ColumnRef::new("fact_sales", "region")],
                order_by: vec![OrderByClause::measure_desc("Total")],
                limit: Some(1),
                totals: TotalsMode::Rollup,
                ..Default::default()
            })
            .await
            .unwrap();
            let combined = concat_batches(&batches[0].schema(), &batches).unwrap();

            assert_eq!(combined.num_rows(), 1);
            assert_eq!(grouping_ids(&combined), [1]);
            assert_eq!(f64_column(&combined, "Total"), [150.0]);
        }

        #[tokio::test]
        async fn totals_with_window_measure_errors_cleanly() {
            let (model, cache, registry) = fixture();
            let window_measure = expression_measure(
                "RunningTotal",
                expr::Expression::Window {
                    inner: Box::new(expr::agg(
                        AggregateOp::Sum,
                        expr::qualified_col("fact_sales", "amount"),
                    )),
                    function: AggregateOp::Sum,
                    order_by: vec![("fact_sales".into(), "region".into())],
                    partition_by: vec![],
                    frame: None,
                },
            );
            let model = {
                let mut builder = DataModel::builder();
                for table in model.tables() {
                    builder = builder.add_table(table.clone());
                }
                builder.add_measure(window_measure).build().unwrap()
            };

            let request = QueryRequest {
                measures: vec!["RunningTotal".into()],
                group_by: vec![ColumnRef::new("fact_sales", "region")],
                totals: TotalsMode::Rollup,
                ..Default::default()
            };
            let plan = PushdownPlanner::plan(&request, &model, &registry).unwrap();
            let err = QueryExecutor::execute(&plan, &model, &registry, Some(&cache), None)
                .await
                .unwrap_err();
            match err {
                QueryError::InvalidQuery(msg) => {
                    assert!(msg.contains("window measures"), "unexpected message: {msg}");
                }
                other => panic!("expected InvalidQuery, got {other:?}"),
            }
        }

        #[tokio::test]
        async fn totals_with_lookups_errors_cleanly() {
            let err = run(QueryRequest {
                measures: vec!["Total".into()],
                group_by: vec![ColumnRef::new("fact_sales", "region")],
                lookups: vec![LookupColumn::new("fact_sales", "customer")],
                totals: TotalsMode::Rollup,
                ..Default::default()
            })
            .await
            .unwrap_err();
            match err {
                QueryError::InvalidQuery(msg) => {
                    assert!(msg.contains("lookup columns"), "unexpected message: {msg}");
                }
                other => panic!("expected InvalidQuery, got {other:?}"),
            }
        }

        /// Direct executor call with lookups + totals (bypassing the planner
        /// gate) is also rejected.
        #[tokio::test]
        async fn executor_rejects_totals_with_lookup_specs() {
            let (model, cache, registry) = fixture();
            let measures = vec![Measure::simple(
                "Total",
                "fact_sales",
                "amount",
                AggregateOp::Sum,
            )];
            let specs = vec![crate::planner::LookupSpec {
                table: "fact_sales".into(),
                column: "customer".into(),
                key_column: "region".into(),
                resolution_sql: "MIN(fact_sales.\"customer\")".into(),
            }];
            let err = QueryExecutor::execute_local_aggregation(
                &[],
                &measures,
                &[ColumnRef::new("fact_sales", "region")],
                &specs,
                &[],
                None,
                TotalsMode::Rollup,
                &model,
                &registry,
                Some(&cache),
                None,
                None,
            )
            .await
            .unwrap_err();
            assert!(matches!(err, QueryError::InvalidQuery(_)));
        }
    }
}
