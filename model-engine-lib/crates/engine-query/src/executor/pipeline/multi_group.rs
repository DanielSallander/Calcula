//! Multi-fact-table evaluation: each measure group runs as an independent
//! star query; results are combined via FULL OUTER / CROSS JOIN.

use std::time::Instant;

use arrow::record_batch::RecordBatch;
use datafusion::prelude::SessionContext;

use engine_core::compute::context::ContextResolver;
use engine_core::compute::measure::Measure;
use engine_core::compute::plan::{PlanNode, PlanOperation, PlanValue};
use engine_core::compute::sql_util::quote_ident_double;
use engine_core::model::DataModel;

use crate::error::QueryResult;
use crate::request::ColumnRef;

use super::fetch::register_partitioned_table;
use super::semi_join::{semi_join_sql, take_semi_joins, RequestFiltered, SemiJoin};
use super::sql::{
    axis_clear_partition, build_condition_sql_with_conditions, build_override_alias_map,
    collect_qualified_tables, render_in_filter_conditions, resolve_compound_sql, wrap_axis_clear,
    GroupColumn, OverrideJoinEntry,
};
use super::QueryExecutor;

/// The GROUP DOMAINS registered apart for a multi-fact query: axis table
/// (lowercase model name) -> the registered table holding its rows under its
/// OWN filters and row-level security only (`local_aggregation`'s
/// `domain_candidates`). DAX's SUMMARIZECOLUMNS draws a group-by column's
/// values from its table so restricted -- a filter argument on another table
/// does not shrink them -- and drops the groups whose measures are all BLANK
/// ([LIVE] Excel 16 Data Model, wave 5: by `Sales[cat]` under a Product
/// slicer, B shows with a BLANK `SUM(Sales[amount])` beside `COUNTROWS(Product)`
/// = 1). An axis table with no entry draws its values from its registered
/// rows, which are then its domain.
pub(super) type AxisDomains = std::collections::HashMap<String, String>;

impl QueryExecutor {
    /// Execute measures from multiple independent fact tables.
    ///
    /// Each measure group is evaluated as an independent star-schema query.
    /// Results are combined via FULL OUTER JOIN on shared group-by columns,
    /// or CROSS JOIN when there are no group-by columns -- or, when the axis
    /// is ONE table whose group domain was registered apart
    /// ([`AxisDomains`]), onto that domain.
    ///
    /// A group JOINs only tables it can join without multiplying its fact
    /// rows (BUG-0730): its GROUP BY dimensions reached through a many-to-one
    /// or one-to-one equality relationship, and its KEEP tables key-safe from
    /// the fact (`semi_join::is_key_safe`). A KEEP on any other table is a
    /// per-measure semi-join, and a group whose axis reaches a many-to-many or
    /// range dimension runs through the two-stage pre-aggregation, as a
    /// single-fact query does.
    pub(super) async fn execute_multi_group_aggregation(
        ctx: &SessionContext,
        measure_groups: &[(&str, Vec<&Measure>)],
        group_by: &[ColumnRef],
        model: &DataModel,
        request_filtered: &RequestFiltered,
        axis_domains: &AxisDomains,
        mut plan: Option<&mut PlanNode>,
    ) -> QueryResult<Vec<RecordBatch>> {
        let resolver = ContextResolver::new(model);

        // For each group, determine reachable group-by columns and build SQL.
        let mut group_table_names: Vec<String> = Vec::new();
        // Whether each group's registered table carries its columns (an
        // empty result is registered with no schema at all).
        let mut group_has_columns: Vec<bool> = Vec::new();

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

            // A GROUP BY column reached through a many-to-many or range
            // relationship, or on the MANY side of a one-to-many seen from
            // this fact's ONE side, cannot be JOINed onto this fact without
            // multiplying its rows (every SUM of the group inflated): the
            // group goes through the pre-aggregation's key mapping, exactly as
            // a single-fact query with such an axis does (BUG-0730). The test
            // is direction-aware (`lookup_safe_from`): a one-to-many declared
            // from the dimension is an ordinary many-to-one star from the
            // fact and stays a direct join, with its KEEPs, percent-of-parent
            // clears and USERELATIONSHIP measures.
            let unsafe_dims: Vec<&ColumnRef> = reachable_group_by
                .iter()
                .copied()
                .filter(|dim| {
                    !dim.table.eq_ignore_ascii_case(fact_model_name)
                        && model
                            .find_relationship(fact_model_name, &dim.table)
                            .is_ok_and(|rel| !rel.lookup_safe_from(fact_model_name))
                })
                .collect();
            if !unsafe_dims.is_empty() {
                let owned: Vec<Measure> = measures.iter().map(|m| (*m).clone()).collect();
                let axis: Vec<ColumnRef> =
                    reachable_group_by.iter().map(|c| (*c).clone()).collect();
                let mut group_node = PlanNode::new(
                    PlanOperation::LocalAggregation,
                    format!("Group {group_idx}: {fact_model_name} (pre-aggregated)"),
                )
                .with_property(
                    "measures",
                    PlanValue::List(measures.iter().map(|m| m.name().to_string()).collect()),
                );
                let start = Instant::now();
                let batches = Self::execute_pre_aggregate_join(
                    ctx,
                    &owned,
                    &axis,
                    &[],
                    model,
                    plan.is_some().then_some(&mut group_node),
                    fact_table,
                    fact_model_name,
                    &unsafe_dims,
                    request_filtered,
                    axis_domains,
                )
                .await?;
                group_node.duration = start.elapsed().into();
                if let Some(ref mut plan_node) = plan {
                    plan_node.add_child(group_node);
                }
                let group_name = format!("__group_{group_idx}");
                group_has_columns.push(batches.iter().any(|b| b.num_columns() > 0));
                if batches.iter().any(|b| b.num_columns() > 0) {
                    register_partitioned_table(ctx, &group_name, batches)?;
                } else {
                    let empty = RecordBatch::new_empty(arrow::datatypes::SchemaRef::new(
                        arrow::datatypes::Schema::empty(),
                    ));
                    ctx.register_batch(&group_name, empty)?;
                }
                group_table_names.push(group_name);
                continue;
            }

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
            // Every non-window measure column: a group shows when ANY answers.
            let mut having_measures: Vec<String> = Vec::new();
            let mut override_joins: Vec<OverrideJoinEntry> = Vec::new();
            // Per-measure semi-joins: a KEEP on a table that is not key-safe
            // from this fact (BUG-0763 / BUG-0730, `semi_join`).
            let mut semi_joins: Vec<SemiJoin> = Vec::new();
            let axis_tables: Vec<&str> = reachable_group_by
                .iter()
                .map(|d| d.table.as_str())
                .collect();
            // Grand totals of compound measures as one-row CROSS JOINs
            // (`hoist_clear_scalars`, BUG-0444).
            let mut clear_scalar_joins: Vec<String> = Vec::new();

            for measure in measures {
                let name = measure.name();
                let expr = measure.expression();

                let is_compound_with_context = super::sql::is_compound_with_context(expr);

                let sql_fragment = if is_compound_with_context {
                    case_when_measures.push(name.to_string());
                    having_measures.push(name.to_string());
                    let expr_sql = resolve_compound_sql(
                        expr,
                        model,
                        fact_table,
                        fact_model_name,
                        &group_columns,
                        &mut context_join_tables,
                        &mut override_joins,
                        &mut semi_joins,
                        request_filtered,
                    )?;
                    format!(
                        "{} AS {}",
                        super::sql::hoist_clear_scalars(&expr_sql, &mut clear_scalar_joins),
                        quote_ident_double(name)
                    )
                } else {
                    let (stripped_expr, eval_ctx) = resolver.resolve(expr)?;
                    let in_conditions = render_in_filter_conditions(
                        ctx,
                        &eval_ctx.in_filters,
                        fact_model_name,
                        fact_table,
                        model,
                    )
                    .await?;
                    let mut effective = eval_ctx.effective_filters(&[]);
                    let mut conditions = eval_ctx.conditions.clone();
                    // A KEEP on a table that is not key-safe from this fact is
                    // a semi-join of THIS measure; LEFT JOINed it multiplied
                    // the fact rows of every measure of the group (BUG-0730).
                    let semi_flags = take_semi_joins(
                        &mut effective,
                        &mut conditions,
                        &eval_ctx,
                        model,
                        fact_table,
                        fact_model_name,
                        &axis_tables,
                        request_filtered,
                        &mut semi_joins,
                    )?;

                    for f in &effective {
                        if f.table != *fact_model_name {
                            context_join_tables.push(f.table.clone());
                        }
                    }
                    for cond in &conditions {
                        collect_qualified_tables(cond, fact_model_name, &mut context_join_tables);
                    }

                    let alias_map = build_override_alias_map(
                        &eval_ctx,
                        model,
                        fact_model_name,
                        fact_table,
                        &mut override_joins,
                    );

                    let has_case = !effective.is_empty()
                        || !conditions.is_empty()
                        || !in_conditions.is_empty()
                        || !semi_flags.is_empty();

                    let inner_sql = if has_case {
                        let mut condition = if !effective.is_empty() || !conditions.is_empty() {
                            build_condition_sql_with_conditions(
                                &effective,
                                &conditions,
                                fact_table,
                                fact_model_name,
                                model,
                                &alias_map,
                            )?
                        } else {
                            String::new()
                        };
                        for c in in_conditions.iter().chain(semi_flags.iter()) {
                            if condition.is_empty() {
                                condition = c.clone();
                            } else {
                                condition.push_str(&format!(" AND {c}"));
                            }
                        }
                        let measure_table = &measure.table().to_lowercase();
                        stripped_expr.to_case_when_sql_with_classes(
                            &condition,
                            measure_table,
                            &|t, c| super::sql::model_column_class(model, measure.table(), t, c),
                        )?
                    } else if let Some((op, col)) = stripped_expr.as_simple_aggregate() {
                        let fact = measure.table().to_lowercase();
                        // A count answers BLANK, never 0 (DAX).
                        engine_core::compute::dax_semantics::measure_aggregate_sql(
                            &op,
                            &format!("{fact}.{}", quote_ident_double(col)),
                        )
                    } else {
                        stripped_expr.to_sql_string_with_classes(&|t, c| {
                            super::sql::model_column_class(model, measure.table(), t, c)
                        })?
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
                            having_measures.push(name.to_string());
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
                    // Only a KEY-SAFE table is joined: a many-to-many, range
                    // or one-to-many table multiplied every fact row of the
                    // group (a total of 75 read 110, BUG-0730). A KEEP on one
                    // became a semi-join above, so one reaching here is
                    // refused rather than joined.
                    if !rel.lookup_safe_from(fact_model_name) {
                        return Err(crate::error::QueryError::InvalidQuery(format!(
                            "'{dim_table}' is reached from '{fact_model_name}' through a \
                             many-to-many, range or one-to-many relationship, so it cannot be \
                             joined onto '{fact_model_name}' without multiplying its rows; \
                             filter it with a KEEP predicate of its own"
                        )));
                    }
                    let left_is_from = rel.from_table() == *fact_model_name;
                    let on_clause = rel.build_on_clause(fact_table, &dim_lower, left_is_from);
                    // LEFT: read only by a measure's own CASE WHEN, so a fact
                    // row with no dimension row still counts for every other
                    // measure (open-ledger round E).
                    sql.push_str(&format!(" LEFT JOIN {dim_lower} ON {on_clause}"));
                    joined_tables.insert(dim_lower);
                }
            }
            // The per-measure semi-joins (none can multiply a fact row).
            sql.push_str(&semi_join_sql(&semi_joins));

            // Add aliased JOINs from USERELATIONSHIP overrides. Only an
            // override JOIN-safe from the fact has an entry; any other is a
            // per-measure semi-join (`take_semi_joins`), never the
            // statement-wide EXISTS it used to be.
            for entry in &override_joins {
                if joined_tables.contains(&entry.alias) {
                    continue;
                }
                sql.push_str(&format!(
                    " JOIN {} AS {} ON {}",
                    entry.source_table, entry.alias, entry.on_clause
                ));
                joined_tables.insert(entry.alias.clone());
            }

            // Grand totals of compound measures, after every JOIN (BUG-0444).
            for join in &clear_scalar_joins {
                sql.push(' ');
                sql.push_str(join);
            }

            // GROUP BY clause.
            if !group_parts.is_empty() {
                sql.push_str(" GROUP BY ");
                sql.push_str(&group_parts.join(", "));

                // A group stays when ANY measure answers in it, not only a
                // CASE-WHEN one (open-ledger round E).
                if !case_when_measures.is_empty() {
                    let having_parts: Vec<String> = having_measures
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
            // The group's columns, for an empty result (`collect` then
            // returns no batch at all).
            let group_schema: arrow::datatypes::SchemaRef =
                std::sync::Arc::new(df.schema().as_arrow().clone());
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
                group_has_columns.push(batches.iter().any(|b| b.num_columns() > 0));
                register_partitioned_table(ctx, &group_name, batches)?;
            } else {
                // An empty group keeps its columns, so the joins that combine
                // the groups can still name them (it was registered with no
                // schema at all, and a join on its axis failed).
                group_has_columns.push(group_schema.fields().len() > 0);
                ctx.register_batch(&group_name, RecordBatch::new_empty(group_schema))?;
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

            // ONE axis table whose group domain was registered apart (a
            // slicer on another table narrowed its registered rows): the
            // groups are combined ONTO the domain, as SUMMARIZECOLUMNS does
            // -- every value of the domain (and every value a group produced,
            // a blank member among them) LEFT JOINs each group that has the
            // axis and CROSS JOINs each that has none, and a row whose
            // measures are all BLANK is dropped. See `AxisDomains`.
            let one_table = group_by
                .iter()
                .all(|c| c.table.eq_ignore_ascii_case(&group_by[0].table));
            if let Some(domain) = axis_domains
                .get(&group_by[0].table.to_lowercase())
                .filter(|_| one_table)
            {
                let cols: Vec<String> =
                    group_by.iter().map(|c| quote_ident_double(&c.column)).collect();
                let mut values: Vec<String> =
                    vec![format!("SELECT DISTINCT {} FROM {domain}", cols.join(", "))];
                for (gi, reachable) in group_reachable.iter().enumerate() {
                    if !reachable.is_empty() && group_has_columns[gi] {
                        values.push(format!("SELECT {} FROM __group_{gi}", cols.join(", ")));
                    }
                }
                let mut select_parts: Vec<String> =
                    cols.iter().map(|c| format!("__d.{c} AS {c}")).collect();
                let mut any_measure: Vec<String> = Vec::new();
                for name in &measure_names {
                    let Some(gi) = measure_groups
                        .iter()
                        .position(|(_, measures)| measures.iter().any(|m| m.name() == name))
                    else {
                        continue;
                    };
                    let quoted = quote_ident_double(name);
                    if group_has_columns[gi] {
                        select_parts.push(format!("__group_{gi}.{quoted}"));
                        any_measure.push(format!("__group_{gi}.{quoted} IS NOT NULL"));
                    } else {
                        select_parts.push(format!("CAST(NULL AS DOUBLE) AS {quoted}"));
                    }
                }
                let mut sql = format!(
                    "SELECT {} FROM ({}) AS __d",
                    select_parts.join(", "),
                    values.join(" UNION ")
                );
                for (gi, reachable) in group_reachable.iter().enumerate() {
                    if !group_has_columns[gi] {
                        continue;
                    }
                    if reachable.is_empty() {
                        sql.push_str(&format!(" CROSS JOIN __group_{gi}"));
                    } else {
                        let on: Vec<String> = cols
                            .iter()
                            .map(|c| {
                                format!(
                                    "(__d.{c} = __group_{gi}.{c} OR (__d.{c} IS NULL AND \
                                     __group_{gi}.{c} IS NULL))"
                                )
                            })
                            .collect();
                        sql.push_str(&format!(" LEFT JOIN __group_{gi} ON {}", on.join(" AND ")));
                    }
                }
                if any_measure.is_empty() {
                    sql.push_str(" WHERE FALSE");
                } else {
                    sql.push_str(&format!(" WHERE {}", any_measure.join(" OR ")));
                }

                let combine_start = Instant::now();
                let df = ctx.sql(&sql).await?;
                let batches = df.collect().await?;
                let combine_elapsed = combine_start.elapsed();
                if let Some(ref mut plan_node) = plan {
                    plan_node.add_child(
                        PlanNode::new(
                            PlanOperation::MultiGroupAggregation,
                            "Combine measure groups onto the axis domain",
                        )
                        .with_property("sql", PlanValue::Text(sql.clone()))
                        .with_property("groups", PlanValue::Number(measure_groups.len() as f64))
                        .with_duration(combine_elapsed),
                    );
                }
                return Ok(batches);
            }

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
