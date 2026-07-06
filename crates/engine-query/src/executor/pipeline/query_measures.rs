//! QUERY-in-VAR two-stage evaluation: materialize QUERY bindings, then run
//! the RETURN expression over the intermediate tables.

use std::time::Instant;

use arrow::compute::concat_batches;
use arrow::record_batch::RecordBatch;
use datafusion::prelude::SessionContext;

use engine_core::compute::context::{format_filter_value, ContextResolver, ResolvedFilter};
use engine_core::compute::expression::Expression;
use engine_core::compute::measure::Measure;
use engine_core::compute::plan::{PlanNode, PlanOperation, PlanValue};
use engine_core::compute::sql_util::{quote_ident_double, sql_quote_literal};
use engine_core::model::DataModel;

use crate::error::QueryResult;
use crate::planner::HierarchySpec;
use crate::request::ColumnRef;

use super::hierarchy::hierarchy_display_sql;
use super::order_limit::grouping_id_select_sql;
use super::sql::build_condition_sql;
use super::QueryExecutor;

impl QueryExecutor {
    /// Evaluate QUERY-in-VAR measures via two-stage aggregation.
    ///
    /// Stage 1: Materialize each QUERY binding by running grouped aggregation
    ///          SQL against the already-registered source tables.
    /// Stage 2: Run the RETURN expression SQL against the intermediate tables.
    pub(super) async fn execute_query_measures(
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
            // Only simple `alias[col] op literal` KEEP predicates compose with
            // the two-stage QUERY path (they flow through `effective` below).
            // Expression conditions (column-vs-column/expression) and KEEP-IN
            // membership filters are NOT applied here — fail closed rather than
            // silently drop them and return an unfiltered aggregate.
            if !eval_ctx.conditions.is_empty() || !eval_ctx.in_filters.is_empty() {
                return Err(crate::error::QueryError::InvalidQuery(format!(
                    "QUERY-in-VAR measure '{name}' uses a KEEP with an expression condition \
                     (column vs column/expression) or an IN-variable membership filter that the \
                     two-stage aggregation path does not apply. Only simple `alias[column] op \
                     value` KEEP predicates on the intermediate are supported — rewrite the \
                     filter in that form, or precompute the compared quantity as an aliased \
                     QUERY column and filter on it."
                )));
            }
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
                            false,
                            None,
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
}

/// Materialize a QUERY binding in the pipeline context.
///
/// Runs a grouped aggregation SQL query using the already-registered tables
/// in the DataFusion SessionContext.
#[allow(clippy::too_many_arguments)]
pub(super) async fn materialize_query_in_pipeline(
    ctx: &SessionContext,
    aggregates: &[(Expression, String)],
    group_by: &[(String, String)],
    fact_table: &str,
    source_filters: &[&ResolvedFilter],
    model: &DataModel,
    rollup: bool,
    hier: Option<&HierarchySpec>,
) -> QueryResult<RecordBatch> {
    let fact_lower = fact_table.to_lowercase();

    let mut select_parts: Vec<String> = Vec::new();
    let mut group_parts: Vec<String> = Vec::new();

    for (table, column) in group_by {
        let tbl = table.to_lowercase();
        // A hierarchy level with an active ragged transform groups ON the
        // transformed expression (stopper NULLIF / parent COALESCE / leaf CASE),
        // aliased to the plain column name (so the result schema is unchanged);
        // other columns group on the raw column. Mirrors the main aggregation path.
        let col_ref = ColumnRef::new(table.clone(), column.clone());
        match hier.and_then(|h| hierarchy_display_sql(h, &col_ref)) {
            Some(expr) => {
                select_parts.push(format!("{expr} AS {}", quote_ident_double(column)));
                group_parts.push(expr);
            }
            None => {
                let qualified = format!("{tbl}.{}", quote_ident_double(column));
                select_parts.push(qualified.clone());
                group_parts.push(qualified);
            }
        }
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

    // ROLLUP: append the trailing __grouping_id bitmask column (LSB = group_by[0],
    // bit set = rolled up). With no group_by, this is the literal-0 grand total.
    if rollup {
        select_parts.push(grouping_id_select_sql(&group_parts));
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

    if rollup && !group_parts.is_empty() {
        // ROLLUP totals: one pass yields detail rows + every group_by-prefix
        // subtotal + the grand total. DataFusion rewrites this into GROUPING SETS,
        // so each level re-evaluates the aggregate from scratch over its own row
        // set — exactly what a non-additive measure (and a lowered filter-context
        // time-intelligence aggregate) needs to be correct per level.
        sql.push_str(" GROUP BY ROLLUP (");
        sql.push_str(&group_parts.join(", "));
        sql.push(')');
    } else if !group_parts.is_empty() {
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
