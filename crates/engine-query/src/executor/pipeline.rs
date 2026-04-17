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
        let fact_table_name = measures[0].table();

        // Resolve in-memory tables from the cache first (no connector needed).
        // If the FetchRequest has filters (e.g., context-pushed filters), apply
        // them to the cached batch locally so that downstream logic (IN-filter
        // propagation, joins) sees the filtered data — not the full table.
        let mut inmemory_results: Vec<(String, Vec<RecordBatch>, usize, std::time::Duration)> =
            Vec::new();
        let mut inmemory_indices: std::collections::HashSet<usize> =
            std::collections::HashSet::new();

        // Track which table (if any) caused an early short-circuit due to
        // 0 rows after filtering. Since all tables are inner-joined, any
        // empty table means the final result is guaranteed to be empty —
        // regardless of whether the table is a fact, dimension, or lookup.
        let mut empty_table: Option<String> = None;

        for (i, (table_name, request)) in fetches.iter().enumerate() {
            let is_in_memory = model.table(table_name).is_ok_and(|t| t.is_in_memory());
            if is_in_memory {
                let batch = cache.and_then(|c| c.get(table_name)).ok_or_else(|| {
                    crate::error::QueryError::Engine(EngineError::TableNotCached(
                        table_name.clone(),
                    ))
                })?;

                let filtered_batch = if request.filters.is_empty() {
                    batch.clone()
                } else {
                    filter_cached_batch(batch, &request.filters).await?
                };

                let row_count = filtered_batch.num_rows();
                inmemory_indices.insert(i);
                inmemory_results.push((
                    table_name.clone(),
                    vec![filtered_batch],
                    row_count,
                    std::time::Duration::ZERO,
                ));

                if row_count == 0 {
                    empty_table = Some(table_name.clone());
                }
            }
        }

        // Early exit: if an in-memory table returned 0 rows after filtering,
        // every inner join is guaranteed empty. Report and return immediately,
        // skipping all connector fetches and DataFusion execution.
        if let Some(ref tbl) = empty_table {
            if let Some(ref mut plan_node) = plan.as_deref_mut() {
                // Report the tables we did resolve before the short-circuit.
                for (table_name, _, row_count, elapsed) in &inmemory_results {
                    let label = format!("Cache: {table_name}");
                    let fetch_node = PlanNode::new(PlanOperation::SourceFetch, label)
                        .with_duration(*elapsed)
                        .with_property("table", PlanValue::Text(table_name.clone()))
                        .with_property("rows_fetched", PlanValue::Number(*row_count as f64))
                        .with_property("source", PlanValue::Text("in_memory_cache".to_string()));
                    plan_node.add_child(fetch_node);
                }
                plan_node.add_child(
                    PlanNode::new(
                        PlanOperation::DataFusionExecution,
                        "Skipped (empty table)".to_string(),
                    )
                    .with_duration(std::time::Duration::ZERO)
                    .with_property("result_rows", PlanValue::Number(0.0))
                    .with_property(
                        "reason",
                        PlanValue::Text(format!(
                            "{tbl} returned 0 rows, all inner joins would be empty"
                        )),
                    ),
                );
            }
            return Ok(vec![]);
        }

        // Find dimension fetches that have context-pushed filters AND a
        // relationship to the measure table (only for connector-fetched tables).
        let mut pre_fetch_indices: Vec<usize> = Vec::new();
        // (pre_fetch_index, dim_join_col, measure_table_join_col)
        let mut propagation_info: Vec<(usize, String, String)> = Vec::new();

        for (i, (table_name, request)) in fetches.iter().enumerate() {
            // Skip in-memory tables (already resolved), the measure table, and
            // tables with no filters.
            if inmemory_indices.contains(&i)
                || table_name.eq_ignore_ascii_case(fact_table_name)
                || request.filters.is_empty()
            {
                continue;
            }
            // Check for a relationship to the measure table.
            // IN-list optimization only works for single-condition equi-joins.
            if let Ok(rel) = model.find_relationship(fact_table_name, table_name) {
                if rel.conditions().len() != 1 || !rel.is_equi_only() {
                    continue;
                }
                let (fact_col, dim_col) = if rel.from_table() == fact_table_name {
                    (rel.from_column().to_string(), rel.to_column().to_string())
                } else {
                    (rel.to_column().to_string(), rel.from_column().to_string())
                };
                pre_fetch_indices.push(i);
                propagation_info.push((i, dim_col, fact_col));
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

        // Check connector pre-fetches for empty tables (same logic: any
        // empty table means every inner join is empty).
        for (_, table_name, _, row_count, _) in &pre_fetch_results {
            if *row_count == 0 {
                empty_table = Some(table_name.clone());
                break;
            }
        }

        if let Some(ref tbl) = empty_table {
            if let Some(ref mut plan_node) = plan.as_deref_mut() {
                for (table_name, _, row_count, elapsed) in &inmemory_results {
                    let label = format!("Cache: {table_name}");
                    let fetch_node = PlanNode::new(PlanOperation::SourceFetch, label)
                        .with_duration(*elapsed)
                        .with_property("table", PlanValue::Text(table_name.clone()))
                        .with_property("rows_fetched", PlanValue::Number(*row_count as f64))
                        .with_property("source", PlanValue::Text("in_memory_cache".to_string()));
                    plan_node.add_child(fetch_node);
                }
                for (_, table_name, _, row_count, elapsed) in &pre_fetch_results {
                    let label = format!("Fetch: {table_name}");
                    let fetch_node = PlanNode::new(PlanOperation::SourceFetch, label)
                        .with_duration(*elapsed)
                        .with_property("table", PlanValue::Text(table_name.clone()))
                        .with_property("rows_fetched", PlanValue::Number(*row_count as f64));
                    plan_node.add_child(fetch_node);
                }
                plan_node.add_child(
                    PlanNode::new(
                        PlanOperation::DataFusionExecution,
                        "Skipped (empty table)".to_string(),
                    )
                    .with_duration(std::time::Duration::ZERO)
                    .with_property("result_rows", PlanValue::Number(0.0))
                    .with_property(
                        "reason",
                        PlanValue::Text(format!(
                            "{tbl} returned 0 rows, all inner joins would be empty"
                        )),
                    ),
                );
            }
            return Ok(vec![]);
        }

        // Extract join key values from pre-fetched dimensions (and in-memory
        // dimensions with filters) and build IN filters for the measure table.
        let mut fact_in_filters: Vec<InFilterCondition> = Vec::new();
        let pre_fetch_set: std::collections::HashSet<usize> =
            pre_fetch_indices.iter().copied().collect();

        // Extract from connector pre-fetches.
        for (idx, _dim_table, ref batches, _, _) in &pre_fetch_results {
            if let Some((_, dim_col, fact_col)) = propagation_info.iter().find(|(i, _, _)| i == idx)
            {
                let values = extract_column_values(batches, dim_col);
                if !values.is_empty() {
                    fact_in_filters.push(InFilterCondition {
                        column: fact_col.clone(),
                        values,
                    });
                }
            }
        }

        // Also extract from in-memory dimension tables that have filter
        // relationships to the measure table.
        for (i, (table_name, request)) in fetches.iter().enumerate() {
            if !inmemory_indices.contains(&i)
                || table_name.eq_ignore_ascii_case(fact_table_name)
                || request.filters.is_empty()
            {
                continue;
            }
            if let Ok(rel) = model.find_relationship(fact_table_name, table_name) {
                if rel.conditions().len() != 1 || !rel.is_equi_only() {
                    continue;
                }
                let (fact_col, dim_col) = if rel.from_table() == fact_table_name {
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
                        fact_in_filters.push(InFilterCondition {
                            column: fact_col,
                            values,
                        });
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
                let in_filters = if table_name.eq_ignore_ascii_case(fact_table_name) {
                    &fact_in_filters
                } else {
                    &[][..]
                };
                async move {
                    let start = Instant::now();
                    let connector = registry.connector_for(table_name)?;
                    // Add IN filters to the measure table fetch if available.
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

        // Check main fetch results for empty tables too.
        for (table_name, _, row_count, _) in &main_fetch_results {
            if *row_count == 0 {
                empty_table = Some(table_name.clone());
                break;
            }
        }

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

        // Build fetch plan nodes if collecting plan data.
        if let Some(ref mut plan_node) = plan.as_deref_mut() {
            for (table_name, _, row_count, elapsed) in &all_fetch_results {
                let is_cached = model.table(table_name).is_ok_and(|t| t.is_in_memory());
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

                // Annotate measure table fetch with propagated IN filter info.
                if table_name.eq_ignore_ascii_case(fact_table_name) && !fact_in_filters.is_empty() {
                    let threshold = max_inline_in_values.unwrap_or(usize::MAX);
                    let in_desc: Vec<String> = fact_in_filters
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

                plan_node.add_child(fetch_node);
            }
        }

        // After all fetches, if any table was empty, short-circuit.
        if let Some(ref tbl) = empty_table {
            if let Some(ref mut plan_node) = plan.as_deref_mut() {
                plan_node.add_child(
                    PlanNode::new(
                        PlanOperation::DataFusionExecution,
                        "Skipped (empty table)".to_string(),
                    )
                    .with_duration(std::time::Duration::ZERO)
                    .with_property("result_rows", PlanValue::Number(0.0))
                    .with_property(
                        "reason",
                        PlanValue::Text(format!(
                            "{tbl} returned 0 rows, all inner joins would be empty"
                        )),
                    ),
                );
            }
            return Ok(vec![]);
        }

        // Register fetched data in DataFusion.
        for (table_name, batches, _, _) in all_fetch_results {
            if batches.is_empty() {
                continue;
            }

            let schema = batches[0].schema();
            let combined = concat_batches(&schema, &batches)?;

            // Register with lowercase name (DataFusion normalizes to lowercase).
            let df_name = table_name.to_lowercase();
            ctx.register_batch(&df_name, combined)?;
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
            )
            .await;
        }

        // Separate window measures from normal measures.
        let (window_measures, _non_window): (Vec<&Measure>, Vec<&Measure>) =
            measures.iter().partition(|m| m.expression().has_window());

        // If we have window measures, evaluate them via two-stage window execution.
        if !window_measures.is_empty() {
            return Self::execute_window_measures(&ctx, &window_measures, group_by, model).await;
        }

        // Build the SQL query for the local aggregation.
        let fact_table = &measures[0].table().to_lowercase();
        let fact_model_name = measures[0].table();

        let mut select_parts: Vec<String> = Vec::new();
        let mut group_parts: Vec<String> = Vec::new();

        for dim in group_by {
            let dim_table = dim.table.to_lowercase();
            let qualified = format!("{dim_table}.\"{}\"", dim.column);
            select_parts.push(qualified.clone());
            group_parts.push(qualified);
        }

        // Resolve context operations for all measures.
        // Per-measure KEEP filters are embedded as CASE WHEN inside the aggregate
        // so they don't affect other measures. Only truly global filters (from
        // query-level WHERE) go into the WHERE clause.
        let resolver = ContextResolver::new(model);
        // Tables that need JOINs due to context filters.
        let mut context_join_tables: Vec<String> = Vec::new();
        // Measures using CASE WHEN filters — need HAVING to exclude NULL groups.
        let mut case_when_measures: Vec<String> = Vec::new();
        // Aliased JOINs from USERELATIONSHIP overrides.
        // Each entry: (alias, on_clause) — added after standard JOINs.
        let mut override_joins: Vec<(String, String)> = Vec::new();

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
                format!("{expr_sql} AS \"{name}\"")
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
                    format!("{expr_sql} AS \"{name}\"")
                } else if let Some((op, col)) = stripped_expr.as_simple_aggregate() {
                    let fact = measure.table().to_lowercase();
                    match op {
                        AggregateOp::Sum => format!("SUM({fact}.\"{col}\") AS \"{name}\""),
                        AggregateOp::Count => {
                            format!("COUNT({fact}.\"{col}\") AS \"{name}\"")
                        }
                        AggregateOp::Average => {
                            format!("AVG({fact}.\"{col}\") AS \"{name}\"")
                        }
                        AggregateOp::Min => format!("MIN({fact}.\"{col}\") AS \"{name}\""),
                        AggregateOp::Max => format!("MAX({fact}.\"{col}\") AS \"{name}\""),
                        AggregateOp::DistinctCount => {
                            format!("COUNT(DISTINCT {fact}.\"{col}\") AS \"{name}\"")
                        }
                        AggregateOp::CountRows => format!("COUNT(*) AS \"{name}\""),
                    }
                } else {
                    let expr_sql = stripped_expr.to_sql_string();
                    format!("{expr_sql} AS \"{name}\"")
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
        for dim_table in &context_join_tables {
            add_join(
                dim_table,
                &mut sql,
                &mut joined_tables,
                &mut join_descriptions,
            )?;
        }

        // Add aliased JOINs from USERELATIONSHIP overrides.
        // These duplicate a dimension table under a different alias with a
        // different ON clause so that measures using the override see the
        // rows matched by the inactive relationship.
        for (alias, on_clause) in &override_joins {
            if !joined_tables.contains(alias) {
                // The source table name is the alias prefix before "__".
                let source_table = alias.split("__").next().unwrap_or(alias);
                sql.push_str(&format!(" JOIN {source_table} AS {alias} ON {on_clause}"));
                join_descriptions.push(on_clause.clone());
                joined_tables.insert(alias.clone());
            }
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
                    .map(|m| format!("\"{m}\" IS NOT NULL"))
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
                let batches =
                    Self::apply_lookup_specs(&ctx, batches, lookup_specs, group_by).await?;
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
                    Self::apply_lookup_specs(&ctx, batches, lookup_specs, group_by).await?;
                Ok(batches)
            } else {
                Ok(batches)
            }
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
            select_parts.push(format!("__agg_result.\"{}\"", field.name()));
        }

        // Add lookup columns with resolution expressions.
        for spec in lookup_specs {
            select_parts.push(format!("{} AS \"{}\"", spec.resolution_sql, spec.column));
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
                " JOIN {dim_lower} ON __agg_result.\"{agg_key_col}\" = {dim_lower}.\"{key_col}\""
            ));
        }

        // GROUP BY all __agg_result columns (since resolution expressions are aggregates).
        let group_parts: Vec<String> = schema
            .fields()
            .iter()
            .map(|f| format!("__agg_result.\"{}\"", f.name()))
            .collect();
        sql.push_str(&format!(" GROUP BY {}", group_parts.join(", ")));

        let df = ctx.sql(&sql).await?;
        let batches = df.collect().await?;
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
                    } else {
                        let batch = materialize_query_in_pipeline(
                            ctx,
                            aggregates,
                            &augmented_gb,
                            fact_table,
                            &source_filters,
                            model,
                        )
                        .await?;
                        let schema = batch.schema();

                        // Store in cache for potential reuse by other measures.
                        query_cache.insert(cache_key, (batch.clone(), schema.clone()));

                        ctx.register_batch(&binding_name.to_lowercase(), batch)?;
                        binding_schemas.insert(binding_name.to_lowercase(), schema);
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
                let qualified = format!("{from_table}.\"{}\"", dim.column);
                select_parts.push(qualified.clone());
                sql_group_parts.push(qualified);
            }

            select_parts.push(format!("{result_sql} AS \"{name}\""));
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

            let df = ctx.sql(&sql).await?;
            let batches = df.collect().await?;
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
            let batch = materialize_query_in_pipeline(
                ctx,
                &agg_pair,
                &stage1_group_by,
                &fact_table.to_lowercase(),
                &[],
                model,
            )
            .await?;
            ctx.register_batch(&base_table_name, batch)?;

            // Stage 2: Build and execute window function SQL.
            let mut select_parts: Vec<String> = Vec::new();

            // Include outer GROUP BY columns in SELECT.
            for dim in group_by {
                let col_lower = dim.column.to_lowercase();
                select_parts.push(format!("\"{col_lower}\""));
            }

            // Build the window function expression.
            let window_sql = build_window_sql(&window_info, &stage1_group_by, group_by, name);
            select_parts.push(window_sql);

            let sql = format!("SELECT {} FROM {base_table_name}", select_parts.join(", "));

            let df = ctx.sql(&sql).await?;
            let batches = df.collect().await?;
            all_batches.extend(batches);
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
        .map(|(_, col)| format!("\"{}\"", col.to_lowercase()))
        .collect();
    let order_sql = order_clause.join(", ");

    // Build PARTITION BY clause (includes outer group-by columns that aren't in ORDER BY).
    let mut partition_cols: Vec<String> = info
        .partition_by
        .iter()
        .map(|(_, col)| format!("\"{}\"", col.to_lowercase()))
        .collect();
    // Add outer group-by columns to PARTITION BY if not already in ORDER BY or PARTITION BY.
    for dim in outer_group_by {
        let col_lower = dim.column.to_lowercase();
        let col_quoted = format!("\"{col_lower}\"");
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
        let func_name = match function {
            AggregateOp::Sum => "SUM",
            AggregateOp::Average => "AVG",
            AggregateOp::Min => "MIN",
            AggregateOp::Max => "MAX",
            AggregateOp::Count => "COUNT",
            AggregateOp::DistinctCount => "COUNT",
            AggregateOp::CountRows => "COUNT",
        };

        let frame_sql = match &info.frame {
            Some(frame) => translate_frame(frame),
            None => "ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW".to_string(),
        };

        format!(
            "{func_name}(\"__val\") OVER ({partition_sql}ORDER BY {order_sql} {frame_sql}) AS \"{measure_name}\""
        )
    } else if let Some(delta) = info.delta {
        // OFFSET: LAG/LEAD("__val", N) OVER (...)
        if delta < 0 {
            format!(
                "LAG(\"__val\", {}) OVER ({partition_sql}ORDER BY {order_sql}) AS \"{measure_name}\"",
                delta.unsigned_abs()
            )
        } else {
            format!(
                "LEAD(\"__val\", {delta}) OVER ({partition_sql}ORDER BY {order_sql}) AS \"{measure_name}\""
            )
        }
    } else if let Some(position) = info.position {
        // INDEX: NTH_VALUE("__val", N) OVER (...) with full frame.
        if position >= 1 {
            format!(
                "NTH_VALUE(\"__val\", {position}) OVER ({partition_sql}ORDER BY {order_sql} ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING) AS \"{measure_name}\""
            )
        } else {
            // Negative position: from end. Use NTH_VALUE with reversed ordering.
            let reverse_order: Vec<String> = info
                .order_by
                .iter()
                .map(|(_, col)| format!("\"{}\" DESC", col.to_lowercase()))
                .collect();
            let rev_order_sql = reverse_order.join(", ");
            let abs_pos = position.unsigned_abs();
            format!(
                "NTH_VALUE(\"__val\", {abs_pos}) OVER ({partition_sql}ORDER BY {rev_order_sql} ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING) AS \"{measure_name}\""
            )
        }
    } else {
        format!("\"__val\" AS \"{measure_name}\"")
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
        let qualified = format!("{tbl}.\"{column}\"");
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
            select_parts.push(format!("{sql} AS \"{alias}\""));
        } else {
            let condition = build_condition_sql(&effective, &fact_lower, fact_table, model);
            let sql = stripped.to_case_when_sql(&condition, &fact_lower);
            select_parts.push(format!("{sql} AS \"{alias}\""));

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
                format!("{tbl}.\"{}\" {op} {val}", f.column)
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
            format!("{tbl}.\"{}\" {op} {val}", f.column)
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
        format!("'{}'", value.replace('\'', "''"))
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
fn build_override_alias_map(
    eval_ctx: &EvaluationContext,
    model: &DataModel,
    fact_model_name: &str,
    fact_table: &str,
    override_joins: &mut Vec<(String, String)>,
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

        // Check if this alias is already queued.
        if !override_joins.iter().any(|(a, _)| a == &alias) {
            override_joins.push((alias.clone(), on_clause));
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
            format!("{tbl}.\"{}\" {op} {val}", f.column)
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
            format!("{tbl}.\"{column}\"")
        }
        Expression::ColumnRef(name) => format!("\"{name}\""),
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
        let escaped = filter.value.replace('\'', "''");
        conditions.push(format!(
            "CAST(\"{}\" AS TEXT) {} '{}'",
            filter.column,
            filter.operator.as_sql(),
            escaped
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
    override_joins: &mut Vec<(String, String)>,
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
            })
        }

        // Leaf expressions: generate plain SQL.
        _ => Ok(expr.to_sql_string()),
    }
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
}
