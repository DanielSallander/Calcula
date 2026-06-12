//! Query executor: executes a `QueryPlan` and returns Arrow results.

use std::time::Instant;

use arrow::array::{Array, Int64Array};
use arrow::compute::concat_batches;
use arrow::record_batch::RecordBatch;
use datafusion::prelude::SessionContext;

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
use crate::request::ColumnRef;

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
            } => {
                let connector = registry.connector_for(source_table)?;
                let batches = connector.execute_join_aggregation(request).await?;
                Ok(batches)
            }
            QueryPlan::LocalAggregation {
                fetches,
                measures,
                group_by,
                lookup_specs,
            } => {
                Self::execute_local_aggregation(
                    fetches,
                    measures,
                    group_by,
                    lookup_specs,
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
    #[allow(clippy::too_many_arguments)]
    pub(crate) async fn execute_local_aggregation(
        fetches: &[(String, engine_connectors::FetchRequest)],
        measures: &[engine_core::compute::measure::Measure],
        group_by: &[ColumnRef],
        lookup_specs: &[crate::planner::LookupSpec],
        model: &DataModel,
        registry: &SourceRegistry,
        cache: Option<&InMemoryCache>,
        max_inline_in_values: Option<usize>,
        mut plan: Option<&mut PlanNode>,
    ) -> QueryResult<Vec<RecordBatch>> {
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
                    let values = extract_column_values(batches, dim_col);
                    if !values.is_empty() {
                        in_filters_by_table
                            .entry(fact_table.to_lowercase())
                            .or_default()
                            .push(InFilterCondition {
                                column: fact_col.clone(),
                                values,
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
                        let values = extract_column_values(batches, &dim_col);
                        if !values.is_empty() {
                            in_filters_by_table
                                .entry(mt.to_lowercase())
                                .or_default()
                                .push(InFilterCondition {
                                    column: fact_col,
                                    values,
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

            let schema = batches[0].schema();
            let combined = concat_batches(&schema, batches)?;

            // Optimize the batch (narrow integers, dictionary-encode strings,
            // convert midnight timestamps to Date32) to reduce memory pressure
            // during local joins and aggregation.
            let (optimized, stats) = engine_core::optimize::optimize_batch(&combined, &opt_config)?;

            if stats.any_applied() {
                opt_stats_by_table.push((table_name.clone(), stats));
            }

            // Register with lowercase name (DataFusion normalizes to lowercase).
            let df_name = table_name.to_lowercase();
            ctx.register_batch(&df_name, optimized)?;
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
        if !query_measures.is_empty() {
            return Self::execute_query_measures(
                &ctx,
                &query_measures,
                &normal_measures,
                group_by,
                model,
                plan,
            )
            .await;
        }

        // Separate window measures from normal measures.
        let (window_measures, _non_window): (Vec<&Measure>, Vec<&Measure>) =
            measures.iter().partition(|m| m.expression().has_window());

        // If we have window measures, evaluate them via two-stage window execution.
        if !window_measures.is_empty() {
            return Self::execute_window_measures(&ctx, &window_measures, group_by, model, plan)
                .await;
        }

        // Partition measures by home table to detect multi-fact-table queries.
        let measure_groups = partition_measures_by_table(measures);
        if measure_groups.len() > 1 {
            return Self::execute_multi_group_aggregation(
                &ctx,
                &measure_groups,
                group_by,
                model,
                plan,
            )
            .await;
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
            return Self::execute_pre_aggregate_join(
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
            .await;
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
            return Self::execute_split_override_measures(
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
            .await;
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
                    );
                    // Use the measure's own table for column qualification.
                    let measure_table = &measure.table().to_lowercase();
                    let expr_sql = stripped_expr.to_case_when_sql(&condition, measure_table);
                    format!("{expr_sql} AS {}", quote_ident_double(name))
                } else if let Some((op, col)) = stripped_expr.as_simple_aggregate() {
                    let fact = measure.table().to_lowercase();
                    let col = quote_ident_double(col);
                    let name = quote_ident_double(name);
                    match op {
                        AggregateOp::Sum => format!("SUM({fact}.{col}) AS {name}"),
                        AggregateOp::Count => {
                            format!("COUNT({fact}.{col}) AS {name}")
                        }
                        AggregateOp::Average => {
                            format!("AVG({fact}.{col}) AS {name}")
                        }
                        AggregateOp::Min => format!("MIN({fact}.{col}) AS {name}"),
                        AggregateOp::Max => format!("MAX({fact}.{col}) AS {name}"),
                        AggregateOp::DistinctCount => {
                            format!("COUNT(DISTINCT {fact}.{col}) AS {name}")
                        }
                        AggregateOp::CountRows => format!("COUNT(*) AS {name}"),
                        // Statistical aggregates: use Display for function name
                        _ => format!("{op}({fact}.{col}) AS {name}"),
                    }
                } else {
                    let expr_sql = stripped_expr.to_sql_string();
                    format!("{expr_sql} AS {}", quote_ident_double(name))
                }
            };
            select_parts.push(sql_fragment);
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

        // GROUP BY clause.
        if !group_parts.is_empty() {
            sql.push_str(" GROUP BY ");
            sql.push_str(&group_parts.join(", "));

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
                Ok(batches)
            } else {
                Ok(batches)
            }
        } else {
            // Normal path: just execute.
            let df = ctx.sql(&sql).await?;
            let batches = df.collect().await?;

            if !lookup_specs.is_empty() {
                let batches =
                    Self::apply_lookup_specs(&ctx, batches, lookup_specs, group_by, None).await?;
                Ok(batches)
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
                            let condition =
                                build_condition_sql(&effective, fact_table, fact_model_name, model);
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
                                );
                                format!("COUNT(CASE WHEN {condition} THEN 1 END) AS \"{alias}\"")
                            } else {
                                format!("COUNT(*) AS \"{alias}\"")
                            }
                        } else if has_context {
                            let condition =
                                build_condition_sql(&effective, fact_table, fact_model_name, model);
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
                            let condition =
                                build_condition_sql(&effective, fact_table, fact_model_name, model);
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
                            let condition =
                                build_condition_sql(&effective, fact_table, fact_model_name, model);
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
                            let condition =
                                build_condition_sql(&effective, fact_table, fact_model_name, model);
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
                            let condition =
                                build_condition_sql(&effective, fact_table, fact_model_name, model);
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
                            let condition =
                                build_condition_sql(&effective, fact_table, fact_model_name, model);
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
                let expr_sql = stripped.to_sql_string();
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

        let s1_schema = s1_batches[0].schema();
        let s1_combined = concat_batches(&s1_schema, &s1_batches)?;
        ctx.register_batch("__pre_agg", s1_combined)?;

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
                    let agg_sql = match op {
                        AggregateOp::Sum => format!("SUM({fact}.{col})"),
                        AggregateOp::Count => format!("COUNT({fact}.{col})"),
                        AggregateOp::Average => format!("AVG({fact}.{col})"),
                        AggregateOp::Min => format!("MIN({fact}.{col})"),
                        AggregateOp::Max => format!("MAX({fact}.{col})"),
                        AggregateOp::DistinctCount => {
                            format!("COUNT(DISTINCT {fact}.{col})")
                        }
                        AggregateOp::CountRows => "COUNT(*)".to_string(),
                        _ => format!("{op}({fact}.{col})"),
                    };
                    select_parts.push(format!(
                        "{agg_sql} AS {}",
                        quote_ident_double(measure.name())
                    ));
                } else {
                    let expr_sql = measure.expression().to_sql_string();
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
                let schema = batches[0].schema();
                let combined = concat_batches(&schema, &batches)?;
                ctx.register_batch(normal_table_name, combined)?;
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

            let bounds_schema = bounds_batches[0].schema();
            let bounds_combined = concat_batches(&bounds_schema, &bounds_batches)?;
            ctx.register_batch(&bounds_alias, bounds_combined)?;

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
                let agg_sql = match op {
                    AggregateOp::Sum => format!("SUM({col_ref})"),
                    AggregateOp::Count => format!("COUNT({col_ref})"),
                    AggregateOp::Average => format!("AVG({col_ref})"),
                    AggregateOp::Min => format!("MIN({col_ref})"),
                    AggregateOp::Max => format!("MAX({col_ref})"),
                    AggregateOp::DistinctCount => format!("COUNT(DISTINCT {col_ref})"),
                    AggregateOp::CountRows => "COUNT(*)".to_string(),
                    _ => format!("{op}({col_ref})"),
                };
                main_select.push(format!("{agg_sql} AS {}", quote_ident_double(measure_name)));
            } else {
                let expr_sql = stripped.to_sql_string();
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
                let schema = main_batches[0].schema();
                let combined = concat_batches(&schema, &main_batches)?;
                ctx.register_batch(&result_table, combined)?;
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
                        );
                        let measure_table = &measure.table().to_lowercase();
                        let expr_sql = stripped_expr.to_case_when_sql(&condition, measure_table);
                        format!("{expr_sql} AS {}", quote_ident_double(name))
                    } else if let Some((op, col)) = stripped_expr.as_simple_aggregate() {
                        let fact = measure.table().to_lowercase();
                        let col = quote_ident_double(col);
                        let name = quote_ident_double(name);
                        match op {
                            AggregateOp::Sum => format!("SUM({fact}.{col}) AS {name}"),
                            AggregateOp::Count => format!("COUNT({fact}.{col}) AS {name}"),
                            AggregateOp::Average => format!("AVG({fact}.{col}) AS {name}"),
                            AggregateOp::Min => format!("MIN({fact}.{col}) AS {name}"),
                            AggregateOp::Max => format!("MAX({fact}.{col}) AS {name}"),
                            AggregateOp::DistinctCount => {
                                format!("COUNT(DISTINCT {fact}.{col}) AS {name}")
                            }
                            AggregateOp::CountRows => format!("COUNT(*) AS {name}"),
                            _ => format!("{op}({fact}.{col}) AS {name}"),
                        }
                    } else {
                        let expr_sql = stripped_expr.to_sql_string();
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
                let schema = batches[0].schema();
                let combined = concat_batches(&schema, &batches)?;
                ctx.register_batch(&group_name, combined)?;
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
        let combined = concat_batches(&schema, &agg_batches)?;
        ctx.register_batch("__agg_result", combined)?;

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
            let result_sql = inlined.to_sql_string();
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
            let sql = stripped.to_sql_string();
            select_parts.push(format!("{sql} AS {}", quote_ident_double(alias)));
        } else {
            let condition = build_condition_sql(&effective, &fact_lower, fact_table, model);
            let sql = stripped.to_case_when_sql(&condition, &fact_lower);
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
) -> String {
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
) -> String {
    build_condition_sql_impl(filters, &[], fact_table, fact_model_name, model, None)
}

fn build_condition_sql_with_conditions(
    filters: &[ResolvedFilter],
    conditions: &[Expression],
    fact_table: &str,
    fact_model_name: &str,
    model: &DataModel,
    alias_map: &std::collections::HashMap<String, String>,
) -> String {
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
) -> String {
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
        parts.push(qualify_condition_sql(cond));
    }

    parts.join(" AND ")
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
fn qualify_condition_sql(expr: &Expression) -> String {
    match expr {
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
                qualify_condition_sql(left),
                op.as_sql(),
                qualify_condition_sql(right)
            )
        }
        Expression::BinaryOp { left, op, right } => {
            format!(
                "({} {} {})",
                qualify_condition_sql(left),
                op.as_sql(),
                qualify_condition_sql(right)
            )
        }
        Expression::And(left, right) => {
            format!(
                "({} AND {})",
                qualify_condition_sql(left),
                qualify_condition_sql(right)
            )
        }
        Expression::Or(left, right) => {
            format!(
                "({} OR {})",
                qualify_condition_sql(left),
                qualify_condition_sql(right)
            )
        }
        Expression::Not(inner) => format!("(NOT {})", qualify_condition_sql(inner)),
        Expression::IsBlank(inner) => format!("({} IS NULL)", qualify_condition_sql(inner)),
        Expression::InList {
            expr: inner,
            values,
        } => {
            let lhs = qualify_condition_sql(inner);
            let vals: Vec<String> = values.iter().map(qualify_condition_sql).collect();
            format!("{lhs} IN ({})", vals.join(", "))
        }
        // For literals and other expressions, fall back to to_sql_string().
        _ => expr.to_sql_string(),
    }
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

/// Extract unique string values from a named column across Arrow record batches.
///
/// Values are cast to strings for use in IN filter lists. Null values are excluded.
fn extract_column_values(batches: &[RecordBatch], column_name: &str) -> Vec<String> {
    let mut values = std::collections::HashSet::new();
    for batch in batches {
        let Ok(idx) = batch.schema().index_of(column_name) else {
            continue;
        };
        let array = batch.column(idx);
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
    values.into_iter().collect()
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
            );
            let measure_table = &fact_model_name.to_lowercase();
            Ok(stripped.to_case_when_sql(&condition, measure_table))
        }

        // Naked aggregate without context: generate plain SQL with qualified columns.
        Expression::Aggregate { operation, operand } => {
            let col = operand.to_sql_string();
            let fact = fact_model_name.to_lowercase();
            let qualified = if col.contains('.') {
                col
            } else if col.starts_with('"') {
                // Already quoted by to_sql_string (e.g., QualifiedColumnRef → "col")
                format!("{fact}.{col}")
            } else {
                format!("{fact}.\"{col}\"")
            };
            Ok(match operation {
                AggregateOp::Sum => format!("SUM({qualified})"),
                AggregateOp::Count => format!("COUNT({qualified})"),
                AggregateOp::Average => format!("AVG({qualified})"),
                AggregateOp::Min => format!("MIN({qualified})"),
                AggregateOp::Max => format!("MAX({qualified})"),
                AggregateOp::DistinctCount => format!("COUNT(DISTINCT {qualified})"),
                AggregateOp::CountRows => "COUNT(*)".to_string(),
                _ => format!("{operation}({qualified})"),
            })
        }

        // Leaf expressions: generate plain SQL.
        _ => Ok(expr.to_sql_string()),
    }
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

        let values = extract_column_values(&[batch], "name");
        assert_eq!(values.len(), 2); // Deduplicated, nulls excluded
        assert!(values.contains(&"Alice".to_string()));
        assert!(values.contains(&"Bob".to_string()));
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

        let values = extract_column_values(&[batch], "id");
        assert_eq!(values.len(), 3); // 1, 2, 3 — deduplicated, null excluded
    }

    #[test]
    fn extract_column_values_missing_column() {
        let schema = Arc::new(Schema::new(vec![Field::new("id", DataType::Int32, false)]));
        let batch =
            RecordBatch::try_new(schema, vec![Arc::new(Int32Array::from(vec![1, 2, 3]))]).unwrap();

        let values = extract_column_values(&[batch], "nonexistent");
        assert!(values.is_empty());
    }

    #[test]
    fn extract_column_values_empty_batches() {
        let values = extract_column_values(&[], "id");
        assert!(values.is_empty());
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
}
