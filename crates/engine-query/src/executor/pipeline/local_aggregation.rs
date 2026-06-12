//! The main `LocalAggregation` execution path: two-phase fetch with IN-filter
//! propagation, DataFusion registration, and single-fact-table SQL assembly.

use std::time::Instant;

use arrow::array::{Array, Int64Array};
use arrow::compute::concat_batches;
use arrow::record_batch::RecordBatch;
use datafusion::prelude::SessionContext;
use tokio_util::sync::CancellationToken;

use engine_connectors::InFilterCondition;
use engine_core::compute::context::ContextResolver;
use engine_core::compute::expression::{expand_global_variables, expand_measure_refs, Expression};
use engine_core::compute::measure::Measure;
use engine_core::compute::plan::{PlanNode, PlanOperation, PlanValue};
use engine_core::compute::sql_util::quote_ident_double;
use engine_core::error::EngineError;
use engine_core::model::DataModel;
use engine_core::store::InMemoryCache;

use crate::error::QueryResult;
use crate::executor::cancel::{check_cancelled, race_cancelled};
use crate::registry::SourceRegistry;
use crate::request::{ColumnRef, OrderByClause, OrderTarget, TotalsMode};

use super::bidirectional::{compute_bidirectional_filters, filter_batches_by_in_values};
use super::fetch::{extract_column_values, filter_cached_batch, register_partitioned_table};
use super::hierarchy::{apply_hide_members_filter, hierarchy_display_sql, hierarchy_unsupported};
use super::measures::partition_measures_by_table;
use super::order_limit::{
    apply_order_and_limit, grouping_id_select_sql, strip_order_helper_columns, totals_unsupported,
};
use super::sql::{
    build_condition_sql_with_conditions, build_override_alias_map, collect_qualified_tables,
    resolve_compound_sql, OverrideJoinEntry,
};
use super::QueryExecutor;

impl QueryExecutor {
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
    ///
    /// `hierarchy` carries the planner-resolved hierarchy group-by spec.
    /// When its ragged behavior needs local work
    /// ([`HierarchySpec::needs_local`](crate::planner::HierarchySpec)), the
    /// level transforms are rendered into the main-path SQL (grouping
    /// happens on the transformed values) and HideMembers is applied as a
    /// post-aggregation Arrow filter (with `limit` applied after the
    /// filter). The specialized two-stage paths listed above do not support
    /// the transforms and return a typed `InvalidQuery` error.
    ///
    /// `udfs` carries host-registered UDFs into the DataFusion session that
    /// runs the measure SQL (and every two-stage path that reuses it), so
    /// `Expression::Call` nodes resolve.
    ///
    /// `token` enables cooperative cancellation: it is checked at phase
    /// boundaries and raced against the connector fetches and the final
    /// DataFusion execution (see
    /// [`QueryExecutor::execute_with_cancellation`](super::QueryExecutor::execute_with_cancellation)).
    #[allow(clippy::too_many_arguments)]
    pub(crate) async fn execute_local_aggregation(
        fetches: &[(String, engine_connectors::FetchRequest)],
        measures: &[engine_core::compute::measure::Measure],
        group_by: &[ColumnRef],
        lookup_specs: &[crate::planner::LookupSpec],
        order_by: &[OrderByClause],
        limit: Option<usize>,
        totals: TotalsMode,
        hierarchy: Option<&crate::planner::HierarchySpec>,
        model: &DataModel,
        registry: &SourceRegistry,
        cache: Option<&InMemoryCache>,
        max_inline_in_values: Option<usize>,
        udfs: Option<&engine_core::compute::udf::UdfRegistry>,
        mut plan: Option<&mut PlanNode>,
        token: &CancellationToken,
    ) -> QueryResult<Vec<RecordBatch>> {
        // Cancellation checkpoint: before any work (covers pre-cancelled
        // tokens — no fetch is ever issued).
        check_cancelled(token)?;
        let rollup = totals == TotalsMode::Rollup;
        // Hierarchy transforms only apply when the ragged behavior needs
        // local work; a stopper-free ShowBlanks hierarchy expanded to plain
        // group-by columns needs nothing here.
        let hier = hierarchy.filter(|h| h.needs_local());
        let hide_members =
            hier.is_some_and(|h| h.behavior == engine_core::model::RaggedBehavior::HideMembers);
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

        // The session that runs the measure SQL (and that the two-stage
        // QUERY/window/multi-group/lookup paths reuse). Host-registered UDFs
        // are installed up front so Expression::Call nodes resolve anywhere
        // expression SQL executes.
        let ctx = match udfs {
            Some(registry) => engine_core::compute::udf::session_context_with_udfs(registry),
            None => SessionContext::new(),
        };

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

        // Raced against cancellation: dropping the join cancels all
        // in-flight connector fetches client-side.
        let mut pre_fetch_results =
            race_cancelled(token, futures::future::try_join_all(pre_fetch_futures)).await?;

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

        // Phase 1.5: reverse (fact → dimension) propagation for relationships
        // explicitly marked FilterPropagation::Both. With the fact side's
        // filters now fully known (its own pushed filters plus the phase-1
        // dimension IN filters), each Both relationship contributes an IN
        // filter on the dimension's join key built from the filtered fact's
        // distinct key values. One round only — reverse-filtered dimensions
        // do not re-propagate (multi-hop bidirectional chains are not
        // transitive). Auto/None relationships are unaffected.
        // See `bidirectional.rs` for the full semantics contract.
        let bidirectional_filters = compute_bidirectional_filters(
            fetches,
            &measure_table_names,
            &in_filters_by_table,
            &inmemory_results,
            model,
            registry,
            max_inline_in_values,
            token,
        )
        .await?;

        // Apply reverse filters to dimensions that are already materialized
        // locally: cache-served tables (their batches never see remote IN
        // filters) and phase-1 pre-fetched dimensions (already fetched with
        // their own filters; the reverse filter refines them in place, no
        // re-fetch). Dimensions still pending fetch get the filter pushed
        // into their phase-2 FetchRequest below.
        if !bidirectional_filters.is_empty() {
            for (table_name, batches, row_count, _) in inmemory_results.iter_mut() {
                if let Some(filters) = bidirectional_filters.get(&table_name.to_lowercase()) {
                    for bf in filters {
                        *batches = filter_batches_by_in_values(
                            batches,
                            &bf.in_filter.column,
                            &bf.in_filter.values,
                        )?;
                    }
                    *row_count = batches.iter().map(|b| b.num_rows()).sum();
                }
            }
            for (_, table_name, batches, row_count, _) in pre_fetch_results.iter_mut() {
                if let Some(filters) = bidirectional_filters.get(&table_name.to_lowercase()) {
                    for bf in filters {
                        *batches = filter_batches_by_in_values(
                            batches,
                            &bf.in_filter.column,
                            &bf.in_filter.values,
                        )?;
                    }
                    *row_count = batches.iter().map(|b| b.num_rows()).sum();
                }
            }
        }

        // Phase 2: fetch remaining connector tables, adding IN filters to the
        // measure table (and reverse Both-filters to dimension tables).
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
                // Reverse (Both) filters targeting this table, if any.
                let reverse_filters = bidirectional_filters
                    .get(&table_name.to_lowercase())
                    .map(|v| v.as_slice())
                    .unwrap_or(&[]);
                async move {
                    let start = Instant::now();
                    let connector = registry.connector_for(table_name)?;
                    // Add IN filters to measure table fetches and reverse
                    // Both-filters to dimension fetches, if available.
                    let batches = if !in_filters.is_empty() || !reverse_filters.is_empty() {
                        let mut augmented = request.clone();
                        augmented.in_filters.extend(in_filters.iter().cloned());
                        augmented
                            .in_filters
                            .extend(reverse_filters.iter().map(|bf| bf.in_filter.clone()));
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

        let main_fetch_results =
            race_cancelled(token, futures::future::try_join_all(main_fetch_futures)).await?;

        // Cancellation checkpoint: all source data fetched, before DataFusion
        // registration and local evaluation.
        check_cancelled(token)?;

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
            // Tables pre-fetched in phase 1: reverse Both-filters were
            // applied to their batches locally (no re-fetch).
            let pre_fetched_tables: std::collections::HashSet<&str> = pre_fetch_indices
                .iter()
                .map(|&i| fetches[i].0.as_str())
                .collect();
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

                // Annotate dimension fetches with reverse (Both) filter info.
                // Mirrors `relationship_filters`; strategy "local" means the
                // filter was applied to already-materialized batches
                // (cache-served or phase-1 pre-fetched tables) instead of
                // being pushed into the source SQL.
                if let Some(filters) = bidirectional_filters.get(&table_name.to_lowercase()) {
                    if !filters.is_empty() {
                        let applied_locally = cache_served_tables.contains(table_name)
                            || pre_fetched_tables.contains(table_name.as_str());
                        let threshold = max_inline_in_values.unwrap_or(usize::MAX);
                        let desc: Vec<String> = filters
                            .iter()
                            .map(|bf| {
                                let strategy = if applied_locally {
                                    "local"
                                } else if bf.in_filter.values.len() > threshold {
                                    "temp_table"
                                } else {
                                    "inline"
                                };
                                format!(
                                    "{} IN ({} values, via {}, strategy: {})",
                                    bf.in_filter.column,
                                    bf.in_filter.values.len(),
                                    bf.via_fact,
                                    strategy
                                )
                            })
                            .collect();
                        fetch_node.add_property("bidirectional_filters", PlanValue::List(desc));
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
            if hier.is_some() {
                return Err(hierarchy_unsupported("QUERY-in-VAR measures"));
            }
            // Cancellation checkpoint: before QUERY-in-VAR evaluation.
            check_cancelled(token)?;
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
            if hier.is_some() {
                return Err(hierarchy_unsupported("window measures"));
            }
            // Cancellation checkpoint: before window-measure evaluation.
            check_cancelled(token)?;
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
            if hier.is_some() {
                return Err(hierarchy_unsupported(
                    "measures from multiple fact tables in one request",
                ));
            }
            // Cancellation checkpoint: before multi-fact-table evaluation.
            check_cancelled(token)?;
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
            if hier.is_some() {
                return Err(hierarchy_unsupported(
                    "GROUP BY dimensions reached through many-to-many or non-equi relationships",
                ));
            }
            // Cancellation checkpoint: before pre-aggregate evaluation.
            check_cancelled(token)?;
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
            // Hierarchy levels with active ragged transforms group ON the
            // transformed expression (stopper NULLIF / parent COALESCE /
            // leaf CASE), aliased to the plain column name so the result
            // schema is unchanged. Other columns group on the raw column.
            match hier.and_then(|h| hierarchy_display_sql(h, dim)) {
                Some(expr) => {
                    select_parts.push(format!("{expr} AS {}", quote_ident_double(&dim.column)));
                    group_parts.push(expr);
                }
                None => {
                    let qualified = format!("{dim_table}.{}", quote_ident_double(&dim.column));
                    select_parts.push(qualified.clone());
                    group_parts.push(qualified);
                }
            }
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
            if hier.is_some() {
                return Err(hierarchy_unsupported(
                    "USERELATIONSHIP overrides targeting a group-by dimension \
                     through a many-to-many or non-equi relationship",
                ));
            }
            // Cancellation checkpoint: before split-override evaluation.
            check_cancelled(token)?;
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
                            // Hierarchy levels grouped on a transformed
                            // expression must order by the same expression
                            // (the raw column is not a grouping key).
                            hier.and_then(|h| hierarchy_display_sql(h, col))
                                .unwrap_or(format!(
                                    "{dim_lower}.{}",
                                    quote_ident_double(&col.column)
                                ))
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
        // With a HideMembers post-filter, ORDER BY stays in the SQL (the
        // Arrow filter preserves row order) but LIMIT must wait until after
        // filtering — otherwise hidden rows would consume the row budget.
        if !order_terms.is_empty() {
            sql.push_str(" ORDER BY ");
            sql.push_str(&order_terms.join(", "));
        }
        if order_in_sql && !hide_members {
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

            // Cancellation checkpoint: before the final SQL execution.
            check_cancelled(token)?;

            // Execute and time DataFusion (raced against cancellation).
            let df_start = Instant::now();
            let batches =
                race_cancelled(token, async { Ok(ctx.sql(&sql).await?.collect().await?) }).await?;
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

            // HideMembers: drop rows with blank (NULL/stopper) included
            // levels post-aggregation; the SQL ORDER BY order is preserved.
            let batches = match hier.filter(|_| hide_members) {
                Some(spec) => apply_hide_members_filter(batches, spec, group_by, rollup)?,
                None => batches,
            };

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
            } else if hide_members {
                // LIMIT was withheld from the SQL — apply it after the
                // filter (rows are already ordered).
                apply_order_and_limit(batches, &[], limit)
            } else {
                Ok(batches)
            }
        } else {
            // Cancellation checkpoint: before the final SQL execution.
            check_cancelled(token)?;

            // Normal path: just execute (raced against cancellation).
            let batches =
                race_cancelled(token, async { Ok(ctx.sql(&sql).await?.collect().await?) }).await?;

            // Strip hidden `__order_N` sort-helper columns.
            let batches = strip_order_helper_columns(batches)?;

            // HideMembers: drop rows with blank (NULL/stopper) included
            // levels post-aggregation; the SQL ORDER BY order is preserved.
            let batches = match hier.filter(|_| hide_members) {
                Some(spec) => apply_hide_members_filter(batches, spec, group_by, rollup)?,
                None => batches,
            };

            if !lookup_specs.is_empty() {
                let batches =
                    Self::apply_lookup_specs(&ctx, batches, lookup_specs, group_by, None).await?;
                apply_order_and_limit(batches, order_by, limit)
            } else if hide_members {
                // LIMIT was withheld from the SQL — apply it after the
                // filter (rows are already ordered).
                apply_order_and_limit(batches, &[], limit)
            } else {
                Ok(batches)
            }
        }
    }
}
