//! Multi-fact-table evaluation: each measure group runs as an independent
//! star query; results are combined via FULL OUTER / CROSS JOIN.

use std::time::Instant;

use arrow::record_batch::RecordBatch;
use datafusion::prelude::SessionContext;

use engine_core::compute::context::ContextResolver;
use engine_core::compute::expression::Expression;
use engine_core::compute::measure::Measure;
use engine_core::compute::plan::{PlanNode, PlanOperation, PlanValue};
use engine_core::compute::sql_util::quote_ident_double;
use engine_core::model::DataModel;

use crate::error::QueryResult;
use crate::request::ColumnRef;

use super::fetch::register_partitioned_table;
use super::sql::{
    axis_clear_partition, build_condition_sql_with_conditions, build_override_alias_map,
    collect_qualified_tables, reject_unconsumed_in_filters, resolve_compound_sql, wrap_axis_clear,
    GroupColumn, OverrideJoinEntry,
};
use super::QueryExecutor;

impl QueryExecutor {
    /// Execute measures from multiple independent fact tables.
    ///
    /// Each measure group is evaluated as an independent star-schema query.
    /// Results are combined via FULL OUTER JOIN on shared group-by columns,
    /// or CROSS JOIN when there are no group-by columns.
    pub(super) async fn execute_multi_group_aggregation(
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

            // Group-by columns paired with their SQL, for CLEAR/RESET window
            // partitions (index-aligned with the loop above).
            let group_columns: Vec<GroupColumn> = reachable_group_by
                .iter()
                .zip(group_parts.iter())
                .map(|(dim, sql)| GroupColumn {
                    table_lc: dim.table.to_lowercase(),
                    column_lc: dim.column.to_lowercase(),
                    sql: sql.clone(),
                })
                .collect();

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
                        &group_columns,
                        &mut context_join_tables,
                        &mut override_joins,
                    )?;
                    format!("{expr_sql} AS {}", quote_ident_double(name))
                } else {
                    let (stripped_expr, eval_ctx) = resolver.resolve(expr)?;
                    reject_unconsumed_in_filters(name, &eval_ctx)?;
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

                    let has_case = !effective.is_empty() || !eval_ctx.conditions.is_empty();

                    let inner_sql = if has_case {
                        let condition = build_condition_sql_with_conditions(
                            &effective,
                            &eval_ctx.conditions,
                            fact_table,
                            fact_model_name,
                            model,
                            &alias_map,
                        )?;
                        let measure_table = &measure.table().to_lowercase();
                        stripped_expr.to_case_when_sql(&condition, measure_table)?
                    } else if let Some((op, col)) = stripped_expr.as_simple_aggregate() {
                        let fact = measure.table().to_lowercase();
                        op.render_sql(&format!("{fact}.{}", quote_ident_double(col)))
                    } else {
                        stripped_expr.to_sql_string()?
                    };

                    match axis_clear_partition(&eval_ctx, &group_columns) {
                        Some(partition) => {
                            let wrapped =
                                wrap_axis_clear(inner_sql, &stripped_expr, &partition, name)?;
                            format!("{wrapped} AS {}", quote_ident_double(name))
                        }
                        None => {
                            if has_case {
                                case_when_measures.push(name.to_string());
                            }
                            format!("{inner_sql} AS {}", quote_ident_double(name))
                        }
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

            // Join each subsequent group to whichever ALREADY-JOINED groups
            // actually share each group-by column — not a hardcoded group 0.
            // For 3+ facts where a conformed dimension is reachable from later
            // facts but not the first, joining only against group 0 finds no
            // shared column and falls back to a CROSS JOIN, exploding the result
            // into a cartesian product (a silently-wrong, inflated total).
            // Tracking per-column ownership across the join chain fixes this: a
            // CROSS JOIN now happens only for a group that genuinely shares no
            // group-by column with any joined group — a scalar-measure broadcast
            // or independent dimensions, both correct rather than a fan-out.
            //
            // Each equality's left side COALESCEs every already-joined group
            // that carries the column, so a value contributed only by a later
            // group (NULL on an earlier group's side of a FULL OUTER JOIN) still
            // matches.
            let mut joined: Vec<usize> = vec![0];
            for (gi, gt) in group_table_names.iter().enumerate().skip(1) {
                let this_reachable = &group_reachable[gi];
                let mut on_parts: Vec<String> = Vec::new();

                for dim in group_by {
                    let this_has = this_reachable
                        .iter()
                        .any(|c| c.table == dim.table && c.column == dim.column);
                    if !this_has {
                        continue;
                    }
                    let owners: Vec<usize> = joined
                        .iter()
                        .copied()
                        .filter(|&gj| {
                            group_reachable[gj]
                                .iter()
                                .any(|c| c.table == dim.table && c.column == dim.column)
                        })
                        .collect();
                    if owners.is_empty() {
                        continue;
                    }
                    let col = quote_ident_double(&dim.column);
                    let lhs = if owners.len() == 1 {
                        format!("__group_{}.{col}", owners[0])
                    } else {
                        let parts: Vec<String> = owners
                            .iter()
                            .map(|gj| format!("__group_{gj}.{col}"))
                            .collect();
                        format!("COALESCE({})", parts.join(", "))
                    };
                    // NULL-safe: a NULL conformed-dimension member must unify
                    // across facts. Plain `=` yields NULL for NULL = NULL,
                    // splitting one NULL group into two half-blank rows. (The OR
                    // form, not `IS NOT DISTINCT FROM`, which does not compile
                    // under DataFusion 44.)
                    let rhs = format!("{gt}.{col}");
                    on_parts.push(format!(
                        "({lhs} = {rhs} OR ({lhs} IS NULL AND {rhs} IS NULL))"
                    ));
                }

                if on_parts.is_empty() {
                    sql.push_str(&format!(" CROSS JOIN {gt}"));
                } else {
                    sql.push_str(&format!(
                        " FULL OUTER JOIN {gt} ON {}",
                        on_parts.join(" AND ")
                    ));
                }
                joined.push(gi);
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
}
