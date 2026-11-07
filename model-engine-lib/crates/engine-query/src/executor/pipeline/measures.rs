//! Split evaluation for measures with unsafe USERELATIONSHIP overrides, and
//! measure partitioning by home table.

use std::time::Instant;

use arrow::record_batch::RecordBatch;
use datafusion::prelude::SessionContext;

use engine_core::compute::context::ContextResolver;
use engine_core::compute::expression::{expand_global_variables, expand_measure_refs};
use engine_core::compute::measure::Measure;
use engine_core::compute::plan::{PlanNode, PlanOperation, PlanValue};
use engine_core::compute::sql_util::{null_is_false_condition, quote_ident_double};
use engine_core::error::EngineError;
use engine_core::model::DataModel;

use crate::error::{QueryError, QueryResult};
use crate::request::ColumnRef;

use super::fetch::register_partitioned_table;
use super::sql::{build_condition_sql_with_conditions, model_column_class, reject_unconsumed_in_filters};
use super::QueryExecutor;

impl QueryExecutor {
    /// Split evaluation for measures with unsafe USERELATIONSHIP overrides.
    ///
    /// Normal measures are evaluated via the standard local aggregation path.
    /// Each unsafe override measure reads the fact rows through a DISTINCT
    /// mapping from the fact's relationship keys to the group values the
    /// override relates them to (Part B). Results are combined via FULL OUTER
    /// JOIN.
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
                    // A count answers BLANK, never 0 (DAX).
                    let agg_sql = engine_core::compute::dax_semantics::measure_aggregate_sql(
                        &op,
                        &format!("{fact}.{col}"),
                    );
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

        // --- Part B: each unsafe override measure through a DISTINCT mapping ---
        //
        // DAX: USERELATIONSHIP makes the override the relationship between the
        // fact and the GROUP BY dimension for this measure, so a group reads
        // the fact rows that SOME of its dimension rows relate to through the
        // override -- each fact row ONCE per group however many of the group's
        // rows match it (a many-to-many relationship is "limited": INNER JOIN
        // semantics, no blank row; its groups are non-additive -- Microsoft,
        // "Model relationships in Power BI Desktop", "Many-to-many
        // relationship guidance").
        //
        // The mapping holds one row per (fact key tuple, group values) the
        // override relates, read off the fact's DISTINCT relationship keys and
        // the (request-filtered) dimension, so joining it back on the fact's
        // keys can never meet a fact row twice in one group. Until wave 4 each
        // group was bounded by the MAX / MIN of each condition's dimension key
        // (`fact.k <= MAX(dim.k)` per condition), which is right for ONE range
        // condition only: an equality many-to-many kept the group's largest
        // key alone (odd products 1 and 3 read product 3's rows), a BETWEEN
        // pair widened every group to its outermost bounds, and a KEEP of the
        // measure was dropped.
        let mut override_table_names: Vec<(String, String)> = Vec::new(); // (table_name, measure_name)

        for (i, measure) in unsafe_measures.iter().enumerate() {
            let ref_expanded = expand_measure_refs(measure.expression(), model)?;
            let expanded = expand_global_variables(&ref_expanded, model);
            if expanded.has_query_scoped_bindings() {
                return Err(QueryError::InvalidQuery(format!(
                    "internal: measure '{}' reached the executor with an unresolved query-scoped \
                     (GVAR) binding (it must be resolved at the Engine facade)",
                    measure.name()
                )));
            }
            let (stripped, eval_ctx) = resolver.resolve(&expanded)?;
            let measure_name = measure.name();

            // The override that reaches a GROUP BY table through an unsafe
            // relationship (the one that sent the measure here).
            let rel = eval_ctx
                .relationship_overrides
                .iter()
                .filter_map(|name| model.relationship(name).ok())
                .find(|rel| {
                    let other = if rel.from_table().eq_ignore_ascii_case(fact_model_name) {
                        rel.to_table()
                    } else if rel.to_table().eq_ignore_ascii_case(fact_model_name) {
                        rel.from_table()
                    } else {
                        return false;
                    };
                    !rel.join_safe_from(fact_model_name)
                        && group_by.iter().any(|g| g.table.eq_ignore_ascii_case(other))
                })
                .ok_or_else(|| {
                    QueryError::Engine(EngineError::InvalidData(
                        "Expected a USERELATIONSHIP override to a group-by table".into(),
                    ))
                })?;
            let fact_is_from = rel.from_table().eq_ignore_ascii_case(fact_model_name);
            let dim_table = if fact_is_from {
                rel.to_table()
            } else {
                rel.from_table()
            };
            let dim_lower = dim_table.to_lowercase();
            if eval_ctx.relationship_overrides.len() > 1 {
                return Err(QueryError::InvalidQuery(format!(
                    "measure '{measure_name}' combines a USERELATIONSHIP to the group-by table \
                     '{dim_table}' with another USERELATIONSHIP, which the local path does not \
                     support yet; request the measure grouped by another column"
                )));
            }
            reject_unconsumed_in_filters(measure_name, &eval_ctx)?;

            // Every GROUP BY column must be the dimension's or the fact's own.
            for g in group_by {
                if !g.table.eq_ignore_ascii_case(dim_table)
                    && !g.table.eq_ignore_ascii_case(fact_model_name)
                {
                    return Err(QueryError::InvalidQuery(format!(
                        "measure '{measure_name}' uses USERELATIONSHIP to the group-by table \
                         '{dim_table}', which cannot be grouped together with '{}[{}]' on the \
                         local path yet; group by columns of '{dim_table}' and '{fact_model_name}' \
                         only",
                        g.table, g.column
                    )));
                }
            }

            // The measure's own KEEPs: on the dimension they restrict the
            // mapping's rows (the same row as the group, as DAX intersects
            // filters on one table); on the fact they are the aggregate's
            // condition. A KEEP on any other table has no rendering here.
            let effective = eval_ctx.effective_filters(&[]);
            let (on_dim, on_fact): (Vec<_>, Vec<_>) = effective
                .into_iter()
                .partition(|f| f.table.eq_ignore_ascii_case(dim_table));
            if let Some(f) = on_fact
                .iter()
                .find(|f| !f.table.eq_ignore_ascii_case(fact_model_name))
            {
                return Err(QueryError::InvalidQuery(format!(
                    "measure '{measure_name}' uses USERELATIONSHIP to the group-by table \
                     '{dim_table}' and filters '{}', which the local path does not support yet",
                    f.table
                )));
            }
            let mut dim_conditions: Vec<engine_core::compute::expression::Expression> =
                Vec::new();
            let mut fact_conditions: Vec<engine_core::compute::expression::Expression> =
                Vec::new();
            for cond in &eval_ctx.conditions {
                let tables: Vec<&str> = cond
                    .qualified_column_references()
                    .into_iter()
                    .map(|(t, _)| t)
                    .collect();
                if !tables.is_empty() && tables.iter().all(|t| t.eq_ignore_ascii_case(dim_table)) {
                    dim_conditions.push(cond.clone());
                } else if tables.iter().all(|t| t.eq_ignore_ascii_case(fact_model_name)) {
                    fact_conditions.push(cond.clone());
                } else {
                    return Err(QueryError::InvalidQuery(format!(
                        "measure '{measure_name}' uses USERELATIONSHIP to the group-by table \
                         '{dim_table}' with a KEEP condition across tables, which the local path \
                         does not support yet"
                    )));
                }
            }
            let no_aliases = std::collections::HashMap::new();
            let dim_where = if on_dim.is_empty() && dim_conditions.is_empty() {
                String::new()
            } else {
                // Rendered against the dimension: `dim_lower` is its table.
                let sql = build_condition_sql_with_conditions(
                    &on_dim,
                    &dim_conditions,
                    &dim_lower,
                    dim_table,
                    model,
                    &no_aliases,
                )?;
                format!(" WHERE {}", null_is_false_condition(&sql, true))
            };
            let fact_condition = if on_fact.is_empty() && fact_conditions.is_empty() {
                String::new()
            } else {
                build_condition_sql_with_conditions(
                    &on_fact,
                    &fact_conditions,
                    fact_table,
                    fact_model_name,
                    model,
                    &no_aliases,
                )?
            };

            // The fact's relationship columns, each once (a BETWEEN pair names
            // its fact column twice).
            let mut fact_keys: Vec<&str> = Vec::new();
            for c in rel.conditions() {
                let k = if fact_is_from {
                    c.from_column()
                } else {
                    c.to_column()
                };
                if !fact_keys.contains(&k) {
                    fact_keys.push(k);
                }
            }
            let map_alias = format!("__om_{i}");
            let on = rel.build_on_clause("__k", &dim_lower, fact_is_from);
            let mut map_select: Vec<String> = fact_keys
                .iter()
                .enumerate()
                .map(|(j, k)| format!("__k.{} AS \"__k{j}\"", quote_ident_double(k)))
                .collect();
            for g in group_by {
                if g.table.eq_ignore_ascii_case(dim_table) {
                    map_select.push(format!("{dim_lower}.{}", quote_ident_double(&g.column)));
                }
            }
            let distinct_keys: Vec<String> = fact_keys
                .iter()
                .map(|k| format!("{fact_table}.{}", quote_ident_double(k)))
                .collect();
            let mapping = format!(
                "(SELECT DISTINCT {} FROM (SELECT DISTINCT {} FROM {fact_table}) AS __k JOIN \
                 {dim_lower} ON {on}{dim_where})",
                map_select.join(", "),
                distinct_keys.join(", ")
            );
            let back: Vec<String> = fact_keys
                .iter()
                .enumerate()
                .map(|(j, k)| {
                    format!(
                        "{fact_table}.{} = {map_alias}.\"__k{j}\"",
                        quote_ident_double(k)
                    )
                })
                .collect();

            // Main query: the fact rows through the mapping, grouped.
            let mut main_select: Vec<String> = Vec::new();
            let mut main_group: Vec<String> = Vec::new();
            for g in group_by {
                let source = if g.table.eq_ignore_ascii_case(dim_table) {
                    map_alias.as_str()
                } else {
                    fact_table
                };
                let qualified = format!("{source}.{}", quote_ident_double(&g.column));
                main_select.push(format!("{qualified} AS {}", quote_ident_double(&g.column)));
                main_group.push(qualified);
            }
            let fact_lc = fact_model_name.to_lowercase();
            let agg_sql = if !fact_condition.is_empty() {
                stripped.to_case_when_sql_with_classes(&fact_condition, &fact_lc, &|t, c| {
                    model_column_class(model, fact_model_name, t, c)
                })?
            } else if let Some((op, col)) = stripped.as_simple_aggregate() {
                let col_ref = format!("{fact_table}.{}", quote_ident_double(col));
                // A count answers BLANK, never 0 (DAX).
                engine_core::compute::dax_semantics::measure_aggregate_sql(&op, &col_ref)
            } else {
                stripped.to_sql_string()?
            };
            main_select.push(format!("{agg_sql} AS {}", quote_ident_double(measure_name)));

            let main_sql = format!(
                "SELECT {} FROM {fact_table} JOIN {mapping} AS {map_alias} ON {} GROUP BY {}",
                main_select.join(", "),
                back.join(" AND "),
                main_group.join(", ")
            );
            // A group whose measure is BLANK is no row (SUMMARIZECOLUMNS).
            let main_sql = format!(
                "SELECT * FROM ({main_sql}) AS __ov WHERE __ov.{} IS NOT NULL",
                quote_ident_double(measure_name)
            );

            let result_table = format!("__override_{i}");
            let main_start = Instant::now();
            let main_df = ctx.sql(&main_sql).await?;
            let main_schema = main_df.schema().inner().clone();
            let mut main_batches = main_df.collect().await?;
            // No group answers: keep the columns, so the measure is still a
            // (BLANK) column of the combined result.
            if main_batches.is_empty() {
                main_batches.push(RecordBatch::new_empty(main_schema));
            }
            let main_elapsed = main_start.elapsed();

            if let Some(ref mut pn) = plan {
                let main_rows: usize = main_batches.iter().map(|b| b.num_rows()).sum();
                let node = PlanNode::new(
                    PlanOperation::LocalAggregation,
                    format!("Override Mapping: {measure_name}"),
                )
                .with_property("main_sql", PlanValue::Text(main_sql.clone()))
                .with_property("main_rows", PlanValue::Number(main_rows as f64))
                .with_duration(main_elapsed);
                pn.add_child(node);
            }

            register_partitioned_table(ctx, &result_table, main_batches)?;
            override_table_names.push((result_table, measure_name.to_string()));
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
            override_table_names
                .iter()
                .map(|(t, _)| t.clone())
                .collect()
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
                    let parts: Vec<String> = all_group_tables
                        .iter()
                        .map(|t| format!("{t}.{c}"))
                        .collect();
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
