//! GROUP BY a dimension reached through an UNSAFE relationship: a
//! many-to-many cardinality (an equality bridge) or a range (non-equi)
//! relationship, which a JOIN would multiply fact rows through (BUG-0764).
//!
//! DAX reads a group of such a dimension as the fact rows that SOME of its
//! rows relate to, each counted ONCE for the group however many of its rows
//! relate to it. A many-to-many relationship is "limited" -- "Table joins
//! are achieved by using INNER JOIN semantics, and for this reason, blank
//! virtual rows aren't added" (Microsoft, "Model relationships in Power BI
//! Desktop") -- and its groups are non-additive: "Each customer balance can
//! represent the addition of multiple account balances, and so the customer
//! balances are non-additive" (Microsoft, "Many-to-many relationship
//! guidance": each account's transactions count once for every customer of
//! the account, never once per bridge row). The filter runs from the
//! dimension to the fact, the direction a dimension filters a fact.
//!
//! A GROUP BY on the MANY side of a one-to-many seen from the fact's ONE side
//! (`COUNTROWS(Product)` by `Sales[cat]`) comes here too (wave 3): it follows
//! the relationship's cross-filter direction. Single-direction filters run
//! from the one side to the many side only, so the group does not filter the
//! fact and every group repeats the ungrouped value (its mapping is a CROSS
//! JOIN of the group values); `FilterPropagation::Both` filters back, through
//! the DISTINCT key mapping below. A group whose every measure is BLANK is not
//! a row, as on the main route (SUMMARIZECOLUMNS).
//!
//! Both routes read the dimension through a DISTINCT MAPPING from the fact's
//! relationship keys to the dimension's GROUP BY values -- one row per (key
//! tuple, group values), however many dimension rows produce it -- so a key
//! meets each group at most once:
//!
//! - Every measure a plain DECOMPOSABLE aggregate (SUM, COUNT, COUNTROWS,
//!   MIN, MAX, ANY_VALUE, and AVERAGE carried as a sum and a count), with or
//!   without KEEP filters: TWO STAGES in one statement. Stage 1
//!   pre-aggregates the fact by its safe GROUP BY columns and its
//!   relationship keys; Stage 2 joins the mapping and re-aggregates the
//!   partials -- a SUM of sums, a SUM of counts (a count of nothing BLANK), a
//!   MIN of minimums, a MAX of maximums, a sum of sums over a sum of counts.
//! - Anything else -- DISTINCTCOUNT, DISTINCTCOUNTNOBLANK, MEDIAN, STDEV, VAR,
//!   MODE, PERCENTILE, an expression of aggregates, a measure whose operands
//!   carry their own KEEPs, a RESET grand total: FINE GRAIN. The fact rows
//!   themselves join the mapping (each at most once per group) and every
//!   measure is rendered as the main path renders a compound measure
//!   (`resolve_compound_sql`), so no value is ever recombined from per-key
//!   partials.
//!
//! Until this rewrite Stage 2 joined the dimension table itself (a bridge
//! holding a key twice counted that key's rows twice: a SUM of 35 read 55)
//! and re-aggregated every non-decomposable partial with SUM, even without a
//! KEEP: a MEDIAN of 10 read 47.5, a DISTINCTCOUNT of 1 read 3, and `SUM /
//! COUNTROWS` of 11.67 read 47.5.
//!
//! Refused with a typed `InvalidQuery`, never answered wrong: a measure that
//! clears part of the axis (a percent-of-parent CLEAR), a USERELATIONSHIP
//! measure (it would be grouped through the default relationship), a KEEP
//! IN-set membership, a KEEP on the unsafe GROUP BY dimension itself (it must
//! test the same dimension row as the group), and a KEEP condition that
//! compares a semi-joined table with another table.

use std::time::Instant;

use arrow::record_batch::RecordBatch;
use datafusion::prelude::SessionContext;

use engine_core::compute::aggregate::AggregateOp;
use engine_core::compute::context::ContextResolver;
use engine_core::compute::measure::Measure;
use engine_core::compute::plan::{PlanNode, PlanOperation, PlanValue};
use engine_core::compute::sql_util::{null_is_false_condition, quote_ident_double};
use engine_core::model::{Cardinality, DataModel, FilterPropagation, Relationship};

use crate::error::{QueryError, QueryResult};
use crate::request::ColumnRef;

use super::semi_join::{
    is_key_safe, semi_join_sql, take_semi_joins, RequestFiltered, SemiJoin,
};
use super::sql::{
    axis_clear_partition, build_condition_sql_with_conditions, collect_qualified_tables,
    hoist_clear_scalars, reject_unconsumed_in_filters, resolve_compound_sql, GroupColumn,
    OverrideJoinEntry,
};
use super::multi_group::AxisDomains;
use super::QueryExecutor;

/// A GROUP BY dimension reached from the fact through an unsafe relationship.
struct UnsafeDimension<'m> {
    /// The table, as the axis names it.
    table: String,
    relationship: &'m Relationship,
    /// The fact's relationship columns, each once (a range relationship
    /// names its fact column in two conditions).
    fact_keys: Vec<String>,
    /// Does a group of this dimension filter the fact? Always for a
    /// many-to-many or range relationship. For a one-to-many seen from its
    /// ONE side (the fact is the one side, the axis column is on the many
    /// side) only when the relationship cross-filters in BOTH directions:
    /// a single-direction relationship filters from the one side to the many
    /// side, never back, so every group shows the fact's ungrouped value
    /// (DAX: "Filters propagate ... from the one side to the many side" for
    /// a single cross-filter direction; Microsoft, "Model relationships in
    /// Power BI Desktop", Cross filter direction).
    filters_fact: bool,
}

/// Does a filter on the other table of `rel` -- a group of it, or a request
/// filter (slicer) on one of its columns -- reach the rows of
/// `fact_model_name`? Not when the fact is the ONE side of an equality
/// one-to-many and the relationship cross-filters in a single direction: the
/// filter runs from the one side to the many side only. See
/// [`UnsafeDimension::filters_fact`]; the fetch's IN-propagation of request
/// filters follows the same rule (wave 4: a Sales[cat] slicer counted the
/// two products with a category-A sale, where Power BI counts all three).
/// A ROW-LEVEL-SECURITY restriction never does: it propagates in either
/// direction ([`crate::security_filter::role_restriction_propagates`], owner
/// decision 2026-11-06), so this rule must never gate a role predicate.
pub(super) fn filter_reaches_fact(rel: &Relationship, fact_model_name: &str) -> bool {
    let fact_on_one_side = rel.is_equi_only()
        && match rel.cardinality() {
            Cardinality::OneToMany => rel.from_table().eq_ignore_ascii_case(fact_model_name),
            Cardinality::ManyToOne => rel.to_table().eq_ignore_ascii_case(fact_model_name),
            Cardinality::OneToOne | Cardinality::ManyToMany => false,
        };
    !fact_on_one_side || rel.propagation() == FilterPropagation::Both
}

/// A plain decomposable aggregate's two-stage rendering.
struct Decomposed {
    /// Stage 1 partial columns (`... AS "__pre_N"`).
    stage1: Vec<String>,
    /// The Stage 2 re-aggregation (`... AS "<measure>"`).
    stage2: String,
}

/// The partials of a decomposable `op` over `operand` under the (already
/// NULL-safe) `condition`, or `None` when `op` cannot be recombined from
/// per-key partials (DISTINCTCOUNT, MEDIAN, STDEV, VAR, MODE).
fn decompose(
    op: AggregateOp,
    operand: &str,
    condition: &str,
    alias: &str,
    stage1_table: &str,
    name: &str,
) -> Option<Decomposed> {
    let arg = |value: &str| {
        if condition.is_empty() {
            value.to_string()
        } else {
            format!("CASE WHEN {condition} THEN {value} END")
        }
    };
    let partial = |part: &str| format!("{stage1_table}.\"{part}\"");
    let out = quote_ident_double(name);
    let simple = |s1: String, s2: String| Decomposed {
        stage1: vec![s1],
        stage2: s2,
    };
    Some(match op {
        AggregateOp::Sum => simple(
            format!("SUM({}) AS \"{alias}\"", arg(operand)),
            format!("SUM({}) AS {out}", partial(alias)),
        ),
        // A count of nothing is BLANK, never 0 (DAX): the partial counts
        // re-aggregate with SUM, then 0 reads NULL.
        AggregateOp::Count => simple(
            format!("COUNT({}) AS \"{alias}\"", arg(operand)),
            format!("NULLIF(SUM({}), 0) AS {out}", partial(alias)),
        ),
        AggregateOp::CountRows => simple(
            if condition.is_empty() {
                format!("COUNT(*) AS \"{alias}\"")
            } else {
                format!("COUNT({}) AS \"{alias}\"", arg("1"))
            },
            format!("NULLIF(SUM({}), 0) AS {out}", partial(alias)),
        ),
        // ANY_VALUE renders as MIN.
        AggregateOp::Min | AggregateOp::AnyValue => simple(
            format!("MIN({}) AS \"{alias}\"", arg(operand)),
            format!("MIN({}) AS {out}", partial(alias)),
        ),
        AggregateOp::Max => simple(
            format!("MAX({}) AS \"{alias}\"", arg(operand)),
            format!("MAX({}) AS {out}", partial(alias)),
        ),
        // AVERAGE = the sum of the partial sums over the sum of the partial
        // counts of non-BLANK values.
        AggregateOp::Average => {
            let sum = format!("{alias}_sum");
            let cnt = format!("{alias}_cnt");
            Decomposed {
                stage1: vec![
                    format!("SUM({}) AS \"{sum}\"", arg(operand)),
                    format!("COUNT({}) AS \"{cnt}\"", arg(operand)),
                ],
                stage2: format!(
                    "CAST(SUM({}) AS DOUBLE) / NULLIF(SUM({}), 0) AS {out}",
                    partial(&sum),
                    partial(&cnt)
                ),
            }
        }
        AggregateOp::DistinctCount
        | AggregateOp::DistinctCountNoBlank
        | AggregateOp::Median
        | AggregateOp::StdevSample
        | AggregateOp::StdevPop
        | AggregateOp::VarSample
        | AggregateOp::VarPop
        | AggregateOp::Mode => return None,
    })
}

/// ` JOIN (<distinct mapping>) AS __mmN ON <left>."k" = __mmN."__k0" ...`:
/// one row per (fact key tuple, `columns` values) the dimension relates,
/// read off the fact's distinct keys, so a key meets each group once.
fn mapping_join(
    dim: &UnsafeDimension,
    index: usize,
    columns: &[&ColumnRef],
    fact_table: &str,
    fact_model_name: &str,
    left: &str,
    axis_domains: &AxisDomains,
) -> String {
    let alias = format!("__mm{index}");
    let dim_lower = dim.table.to_lowercase();
    if !dim.filters_fact {
        // The group does not filter the fact: every fact row (or partial)
        // meets every group value once. The values are the dimension's
        // GROUP DOMAIN when one was registered apart (a slicer on another
        // table narrowed its registered rows; `AxisDomains`): by Sales[cat]
        // under a Product slicer, COUNTROWS(Product) is 1 for B too.
        let select: Vec<String> = columns
            .iter()
            .map(|c| format!("{dim_lower}.{}", quote_ident_double(&c.column)))
            .collect();
        let source = match axis_domains.get(&dim_lower) {
            Some(domain) => format!("{domain} AS {dim_lower}"),
            None => dim_lower.clone(),
        };
        return format!(
            " CROSS JOIN (SELECT DISTINCT {} FROM {source}) AS {alias}",
            select.join(", ")
        );
    }
    let fact_is_from = dim
        .relationship
        .from_table()
        .eq_ignore_ascii_case(fact_model_name);
    let on = dim
        .relationship
        .build_on_clause("__k", &dim_lower, fact_is_from);
    let keys: Vec<String> = dim
        .fact_keys
        .iter()
        .map(|k| format!("{fact_table}.{}", quote_ident_double(k)))
        .collect();
    let mut select: Vec<String> = dim
        .fact_keys
        .iter()
        .enumerate()
        .map(|(i, k)| format!("__k.{} AS \"__k{i}\"", quote_ident_double(k)))
        .collect();
    for c in columns {
        select.push(format!("{dim_lower}.{}", quote_ident_double(&c.column)));
    }
    let back: Vec<String> = dim
        .fact_keys
        .iter()
        .enumerate()
        .map(|(i, k)| format!("{left}.{} = {alias}.\"__k{i}\"", quote_ident_double(k)))
        .collect();
    format!(
        " JOIN (SELECT DISTINCT {} FROM (SELECT DISTINCT {} FROM {fact_table}) AS __k JOIN \
         {dim_lower} ON {on}) AS {alias} ON {}",
        select.join(", "),
        keys.join(", "),
        back.join(" AND ")
    )
}

/// The refusal for a KEEP on a table the statement cannot join onto the fact.
fn unjoinable_keep(dim_table: &str, is_axis: bool) -> QueryError {
    if is_axis {
        QueryError::InvalidQuery(format!(
            "a KEEP filter on '{dim_table}', reached through a many-to-many or non-equi \
             relationship, combined with a group-by through such a relationship on the same \
             table is not supported on the local path yet (the filter must test the same \
             '{dim_table}' row as the group)"
        ))
    } else {
        QueryError::InvalidQuery(format!(
            "a KEEP filter on '{dim_table}' cannot be joined onto the fact without multiplying \
             its rows, and was not applied as a semi-join; this combination is not supported on \
             the local path yet"
        ))
    }
}

impl QueryExecutor {
    /// Aggregate grouped by `unsafe_dims` (GROUP BY columns reached through a
    /// many-to-many or non-equi relationship) and the rest of `group_by`,
    /// through a DISTINCT key mapping per unsafe dimension: two stages when
    /// every measure is a decomposable plain aggregate, the fine grain
    /// otherwise (see the module docs).
    #[allow(clippy::too_many_arguments)]
    pub(super) async fn execute_pre_aggregate_join(
        ctx: &SessionContext,
        measures: &[Measure],
        group_by: &[ColumnRef],
        lookup_specs: &[crate::planner::LookupSpec],
        model: &DataModel,
        mut plan: Option<&mut PlanNode>,
        fact_table: &str,
        fact_model_name: &str,
        unsafe_dims: &[&ColumnRef],
        request_filtered: &RequestFiltered,
        axis_domains: &AxisDomains,
    ) -> QueryResult<Vec<RecordBatch>> {
        let resolver = ContextResolver::new(model);

        // The unsafe dimensions (one per table) with their fact-side keys.
        let mut dims: Vec<UnsafeDimension> = Vec::new();
        for d in unsafe_dims {
            if dims.iter().any(|u| u.table.eq_ignore_ascii_case(&d.table)) {
                continue;
            }
            let relationship = model.find_relationship(fact_model_name, &d.table)?;
            let fact_is_from = relationship
                .from_table()
                .eq_ignore_ascii_case(fact_model_name);
            let mut fact_keys: Vec<String> = Vec::new();
            for c in relationship.conditions() {
                let k = if fact_is_from {
                    c.from_column()
                } else {
                    c.to_column()
                };
                if !fact_keys.iter().any(|x| x == k) {
                    fact_keys.push(k.to_string());
                }
            }
            dims.push(UnsafeDimension {
                table: d.table.clone(),
                relationship,
                fact_keys,
                filters_fact: filter_reaches_fact(relationship, fact_model_name),
            });
        }
        let unsafe_index = |table: &str| {
            dims.iter()
                .position(|u| u.table.eq_ignore_ascii_case(table))
        };
        let columns_of = |index: usize| -> Vec<&ColumnRef> {
            group_by
                .iter()
                .filter(|g| g.table.eq_ignore_ascii_case(&dims[index].table))
                .collect()
        };
        let axis_tables: Vec<&str> = group_by.iter().map(|g| g.table.as_str()).collect();

        // Every GROUP BY column with the SQL that reads it on the fine grain
        // (the safe ones off the fact or its joined dimension, the unsafe ones
        // off their mapping), for the axis-clear checks too.
        let fine_sql = |g: &ColumnRef| match unsafe_index(&g.table) {
            Some(i) => format!("__mm{i}.{}", quote_ident_double(&g.column)),
            None => format!(
                "{}.{}",
                g.table.to_lowercase(),
                quote_ident_double(&g.column)
            ),
        };
        let group_columns: Vec<GroupColumn> = group_by
            .iter()
            .map(|g| GroupColumn {
                table_lc: g.table.to_lowercase(),
                column_lc: g.column.to_lowercase(),
                sql: fine_sql(g),
            })
            .collect();

        // Classify the measures: refuse what neither route can answer, and
        // take the two stages only when EVERY measure decomposes.
        let stage1_table = "__pre_agg";
        let mut decomposed: Vec<Option<Decomposed>> = Vec::with_capacity(measures.len());
        let mut s1_semi_joins: Vec<SemiJoin> = Vec::new();
        let mut s1_context_tables: Vec<String> = Vec::new();
        for (i, measure) in measures.iter().enumerate() {
            let name = measure.name();
            let (stripped, eval_ctx) = resolver.resolve(measure.expression())?;
            // A KEEP(... IN set[col]) membership has no rendering here: refuse
            // rather than answer the unfiltered value.
            reject_unconsumed_in_filters(name, &eval_ctx)?;
            if !eval_ctx.relationship_overrides.is_empty() {
                return Err(QueryError::InvalidQuery(format!(
                    "measure '{name}' uses USERELATIONSHIP, which a group-by through a \
                     many-to-many or non-equi relationship does not support on the local path yet \
                     (the measure would be grouped through the default relationship)"
                )));
            }
            // A clear that removes part of the axis needs the cleared total;
            // a clear of no axis column changes nothing here.
            let axis_effect = axis_clear_partition(&eval_ctx, &group_columns)
                .is_some_and(|p| p.len() != group_columns.len());
            let simple = stripped.as_simple_aggregate();
            let candidate = match simple {
                Some((op, col))
                    if !axis_effect
                        && !super::sql::is_compound_with_context(measure.expression()) =>
                {
                    Some((op, col.to_string()))
                }
                _ => None,
            };
            let Some((op, col)) = candidate else {
                decomposed.push(None);
                continue;
            };
            let mut effective = eval_ctx.effective_filters(&[]);
            let mut conditions = eval_ctx.conditions.clone();
            // A KEEP on a table off the axis that is not key-safe: a
            // semi-join of this measure, in Stage 1 (it keys on fact columns).
            let flags = take_semi_joins(
                &mut effective,
                &mut conditions,
                &eval_ctx,
                model,
                fact_table,
                fact_model_name,
                &axis_tables,
                request_filtered,
                &mut s1_semi_joins,
            )?;
            for f in &effective {
                if !f.table.eq_ignore_ascii_case(fact_model_name) {
                    s1_context_tables.push(f.table.clone());
                }
            }
            for cond in &conditions {
                collect_qualified_tables(cond, fact_model_name, &mut s1_context_tables);
            }
            let mut condition = if effective.is_empty() && conditions.is_empty() {
                String::new()
            } else {
                build_condition_sql_with_conditions(
                    &effective,
                    &conditions,
                    fact_table,
                    fact_model_name,
                    model,
                    &std::collections::HashMap::new(),
                )?
            };
            for flag in &flags {
                if condition.is_empty() {
                    condition = flag.clone();
                } else {
                    condition.push_str(&format!(" AND {flag}"));
                }
            }
            // On DataFusion a NULL CASE condition must read FALSE
            // (`null_is_false_condition`).
            let condition = if condition.is_empty() {
                condition
            } else {
                null_is_false_condition(&condition, true)
            };
            let operand = format!(
                "{}.{}",
                measure.table().to_lowercase(),
                quote_ident_double(&col)
            );
            decomposed.push(decompose(
                op,
                &operand,
                &condition,
                &format!("__pre_{i}"),
                stage1_table,
                name,
            ));
        }
        let two_stage = decomposed.iter().all(|d| d.is_some());

        // JOINs of the safe GROUP BY dimensions (INNER, as the main path) and
        // the key-safe KEEP dimensions (LEFT).
        let safe_dimension_joins = |context_tables: &[String]| -> QueryResult<String> {
            let mut sql = String::new();
            let mut joined: Vec<String> = vec![fact_table.to_string()];
            for g in group_by {
                let lower = g.table.to_lowercase();
                if unsafe_index(&g.table).is_some()
                    || g.table.eq_ignore_ascii_case(fact_model_name)
                    || joined.contains(&lower)
                {
                    continue;
                }
                let rel = model.find_relationship(fact_model_name, &g.table)?;
                let left_is_from = rel.from_table().eq_ignore_ascii_case(fact_model_name);
                let on = rel.build_on_clause(fact_table, &lower, left_is_from);
                sql.push_str(&format!(" JOIN {lower} ON {on}"));
                joined.push(lower);
            }
            for t in context_tables {
                let lower = t.to_lowercase();
                if joined.contains(&lower) {
                    continue;
                }
                // Only a KEY-SAFE table can be joined without multiplying
                // fact rows; a KEEP on the unsafe axis dimension itself must
                // test the group's own row.
                if unsafe_index(t).is_some() || !is_key_safe(model, fact_model_name, t) {
                    return Err(unjoinable_keep(t, unsafe_index(t).is_some()));
                }
                let rel = model.find_relationship(fact_model_name, t)?;
                let left_is_from = rel.from_table().eq_ignore_ascii_case(fact_model_name);
                let on = rel.build_on_clause(fact_table, &lower, left_is_from);
                sql.push_str(&format!(" LEFT JOIN {lower} ON {on}"));
                joined.push(lower);
            }
            Ok(sql)
        };

        let (sql, route) = if two_stage {
            // --- Stage 1: the fact by its safe GROUP BY columns + keys ---
            let mut s1_select: Vec<String> = Vec::new();
            let mut s1_group: Vec<String> = Vec::new();
            for (j, g) in group_by.iter().enumerate() {
                if unsafe_index(&g.table).is_some() {
                    continue;
                }
                let expr = format!(
                    "{}.{}",
                    g.table.to_lowercase(),
                    quote_ident_double(&g.column)
                );
                s1_select.push(format!("{expr} AS \"__g{j}\""));
                if !s1_group.contains(&expr) {
                    s1_group.push(expr);
                }
            }
            let mut keys: Vec<&str> = Vec::new();
            for d in &dims {
                for k in &d.fact_keys {
                    if !keys.contains(&k.as_str()) {
                        keys.push(k);
                    }
                }
            }
            for k in &keys {
                let expr = format!("{fact_table}.{}", quote_ident_double(k));
                s1_select.push(expr.clone());
                if !s1_group.contains(&expr) {
                    s1_group.push(expr);
                }
            }
            let mut s2_measures: Vec<String> = Vec::new();
            for d in decomposed.into_iter().flatten() {
                s1_select.extend(d.stage1);
                s2_measures.push(d.stage2);
            }
            let mut stage1 = format!("SELECT {} FROM {fact_table}", s1_select.join(", "));
            stage1.push_str(&safe_dimension_joins(&s1_context_tables)?);
            stage1.push_str(&semi_join_sql(&s1_semi_joins));
            stage1.push_str(" GROUP BY ");
            stage1.push_str(&s1_group.join(", "));

            // --- Stage 2: the partials through each dimension's mapping ---
            let mut s2_select: Vec<String> = Vec::new();
            let mut s2_group: Vec<String> = Vec::new();
            for (j, g) in group_by.iter().enumerate() {
                let expr = match unsafe_index(&g.table) {
                    Some(i) => format!("__mm{i}.{}", quote_ident_double(&g.column)),
                    None => format!("{stage1_table}.\"__g{j}\""),
                };
                s2_select.push(format!("{expr} AS {}", quote_ident_double(&g.column)));
                s2_group.push(expr);
            }
            s2_select.extend(s2_measures);
            let mut sql = format!(
                "SELECT {} FROM ({stage1}) AS {stage1_table}",
                s2_select.join(", ")
            );
            for (i, d) in dims.iter().enumerate() {
                sql.push_str(&mapping_join(
                    d,
                    i,
                    &columns_of(i),
                    fact_table,
                    fact_model_name,
                    stage1_table,
                    axis_domains,
                ));
            }
            if !s2_group.is_empty() {
                sql.push_str(" GROUP BY ");
                sql.push_str(&s2_group.join(", "));
            }
            (sql, "two-stage")
        } else {
            // --- Fine grain: the fact rows through each mapping ---
            let mut context_join_tables: Vec<String> = Vec::new();
            let mut override_joins: Vec<OverrideJoinEntry> = Vec::new();
            let mut semi_joins: Vec<SemiJoin> = Vec::new();
            let mut clear_scalar_joins: Vec<String> = Vec::new();
            let mut select: Vec<String> = group_columns
                .iter()
                .zip(group_by)
                .map(|(gc, g)| format!("{} AS {}", gc.sql, quote_ident_double(&g.column)))
                .collect();
            for measure in measures {
                if super::sql::contains_partitioned_clear(
                    measure.expression(),
                    model,
                    &group_columns,
                )? {
                    return Err(QueryError::InvalidQuery(format!(
                        "measure '{}' clears part of the group-by axis (a percent-of-parent \
                         CLEAR), which a group-by through a many-to-many or non-equi \
                         relationship does not support on the local path yet",
                        measure.name()
                    )));
                }
                let expr_sql = resolve_compound_sql(
                    measure.expression(),
                    model,
                    fact_table,
                    fact_model_name,
                    &group_columns,
                    &mut context_join_tables,
                    &mut override_joins,
                    &mut semi_joins,
                    request_filtered,
                )?;
                select.push(format!(
                    "{} AS {}",
                    hoist_clear_scalars(&expr_sql, &mut clear_scalar_joins),
                    quote_ident_double(measure.name())
                ));
            }
            if !override_joins.is_empty() {
                return Err(QueryError::InvalidQuery(
                    "USERELATIONSHIP is not supported together with a group-by through a \
                     many-to-many or non-equi relationship on the local path yet"
                        .into(),
                ));
            }
            // The safe GROUP BY dimensions and the key-safe KEEP dimensions
            // (a KEEP on an unsafe axis table refused), each mapping, the
            // semi-joins, then the grand totals.
            let mut sql = format!("SELECT {} FROM {fact_table}", select.join(", "));
            sql.push_str(&safe_dimension_joins(&context_join_tables)?);
            for (i, d) in dims.iter().enumerate() {
                sql.push_str(&mapping_join(
                    d,
                    i,
                    &columns_of(i),
                    fact_table,
                    fact_model_name,
                    fact_table,
                    axis_domains,
                ));
            }
            sql.push_str(&semi_join_sql(&semi_joins));
            for join in &clear_scalar_joins {
                sql.push(' ');
                sql.push_str(join);
            }
            let group_exprs: Vec<String> = group_columns.iter().map(|g| g.sql.clone()).collect();
            if !group_exprs.is_empty() {
                sql.push_str(" GROUP BY ");
                sql.push_str(&group_exprs.join(", "));
            }
            (sql, "fine grain")
        };

        // A group shows when ANY measure answers in it, as on the main route
        // (its HAVING) and in DAX (SUMMARIZECOLUMNS drops a row whose every
        // measure is BLANK). Without this a tag whose related rows the KEEP
        // of every measure rejected came back as an all-BLANK row.
        let sql = if group_by.is_empty() || measures.is_empty() {
            sql
        } else {
            let any_answers: Vec<String> = measures
                .iter()
                .map(|m| format!("__pa.{} IS NOT NULL", quote_ident_double(m.name())))
                .collect();
            format!(
                "SELECT * FROM ({sql}) AS __pa WHERE {}",
                any_answers.join(" OR ")
            )
        };

        let start = Instant::now();
        let frame = ctx.sql(&sql).await?;
        let schema = frame.schema().inner().clone();
        let mut batches = frame.collect().await?;
        // No group answers: keep the result's columns, so a multi-fact
        // caller can still join this group by them.
        if batches.is_empty() {
            batches.push(RecordBatch::new_empty(schema));
        }
        let elapsed = start.elapsed();

        if let Some(ref mut plan_node) = plan {
            let rows: usize = batches.iter().map(|b| b.num_rows()).sum();
            let label = if two_stage {
                "Pre-Aggregate + Join Unsafe Dims (two stages)"
            } else {
                "Join Unsafe Dims (fine grain)"
            };
            plan_node.add_child(
                PlanNode::new(PlanOperation::LocalAggregation, label)
                    .with_property("sql", PlanValue::Text(sql.clone()))
                    .with_property("route", PlanValue::Text(route.to_string()))
                    .with_property("result_rows", PlanValue::Number(rows as f64))
                    .with_duration(elapsed),
            );
        }

        if !lookup_specs.is_empty() {
            Self::apply_lookup_specs(ctx, batches, lookup_specs, group_by, plan).await
        } else {
            Ok(batches)
        }
    }
}
