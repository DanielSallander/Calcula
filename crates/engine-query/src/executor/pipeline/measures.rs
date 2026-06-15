//! Split evaluation for measures with unsafe USERELATIONSHIP overrides, and
//! measure partitioning by home table.

use std::time::Instant;

use arrow::record_batch::RecordBatch;
use datafusion::prelude::SessionContext;

use engine_core::compute::context::ContextResolver;
use engine_core::compute::expression::{expand_global_variables, expand_measure_refs};
use engine_core::compute::measure::Measure;
use engine_core::compute::plan::{PlanNode, PlanOperation, PlanValue};
use engine_core::compute::sql_util::quote_ident_double;
use engine_core::error::EngineError;
use engine_core::model::DataModel;

use crate::error::QueryResult;
use crate::request::ColumnRef;

use super::fetch::register_partitioned_table;
use super::QueryExecutor;

impl QueryExecutor {
    /// Split evaluation for measures with unsafe USERELATIONSHIP overrides.
    ///
    /// Normal measures are evaluated via the standard local aggregation path.
    /// Unsafe override measures are evaluated via pre-aggregation: the fact
    /// table is pre-aggregated by its join key columns, then joined to the
    /// override dimension. Results are combined via FULL OUTER JOIN.
    #[allow(clippy::too_many_arguments)]
    pub(super) async fn execute_split_override_measures(
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

        // The tables FULL OUTER JOINed after the first.
        let tables_to_join: Vec<String> = if has_normal {
            override_table_names.iter().map(|(t, _)| t.clone()).collect()
        } else {
            override_table_names[1..]
                .iter()
                .map(|(t, _)| t.clone())
                .collect()
        };

        // Select: each group column COALESCEd across every combined table, then
        // all measure columns. A non-equi USERELATIONSHIP override aggregates a
        // different fact-row set, so a group can exist only on a later table; the
        // FULL OUTER JOIN then leaves the first table's key NULL — COALESCE keeps
        // the real key instead of blanking it.
        let all_group_tables: Vec<&str> = std::iter::once(first_table.as_str())
            .chain(tables_to_join.iter().map(|s| s.as_str()))
            .collect();
        let mut combine_select: Vec<String> = group_cols
            .iter()
            .map(|c| {
                if all_group_tables.len() == 1 {
                    format!("{first_table}.{c}")
                } else {
                    let parts: Vec<String> =
                        all_group_tables.iter().map(|t| format!("{t}.{c}")).collect();
                    format!("COALESCE({}) AS {c}", parts.join(", "))
                }
            })
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

        for join_table in &tables_to_join {
            if group_cols.is_empty() {
                combine_sql.push_str(&format!(" CROSS JOIN {join_table}"));
            } else {
                // NULL-safe: a NULL group-by member must unify across the
                // normal and override sides (plain `=` yields NULL for
                // NULL = NULL, splitting the group into half-blank rows). OR
                // form, not `IS NOT DISTINCT FROM` (uncompilable on DataFusion 44).
                let join_conds: Vec<String> = group_cols
                    .iter()
                    .map(|c| {
                        format!(
                            "({first_table}.{c} = {join_table}.{c} OR \
                             ({first_table}.{c} IS NULL AND {join_table}.{c} IS NULL))"
                        )
                    })
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
}

/// Partition measures into groups by their home table, preserving insertion order.
///
/// Returns a list of (table_name, measures) groups. Within each group, the
/// measures are in their original order.
pub(super) fn partition_measures_by_table(measures: &[Measure]) -> Vec<(&str, Vec<&Measure>)> {
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

#[cfg(test)]
mod tests {
    use super::*;
    use engine_core::compute::aggregate::AggregateOp;

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
