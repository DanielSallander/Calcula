//! Condition and compound-expression SQL rendering shared by the local
//! aggregation paths, including USERELATIONSHIP override JOIN bookkeeping.

use engine_core::compute::aggregate::AggregateOp;
use engine_core::compute::context::{
    format_filter_value, ContextResolver, EvaluationContext, ResolvedFilter,
};
use engine_core::compute::expression::{
    DataFusionDialect, Expression, LowercaseTableQualifier, SqlRenderer,
};
use engine_core::compute::sql_util::quote_ident_double;
use engine_core::model::DataModel;

use crate::error::QueryResult;

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
pub(super) struct OverrideJoinEntry {
    pub(super) alias: String,
    pub(super) on_clause: String,
    pub(super) source_table: String,
    pub(super) is_safe: bool,
    /// Pre-computed scalar boundary clause for single-condition inequality
    /// relationships. `Some(clause)` when the expensive correlated EXISTS can
    /// be replaced by a cheap scalar subquery (e.g., `col <= (SELECT MAX(...))`).
    pub(super) boundary_clause: Option<String>,
}

pub(super) fn build_override_alias_map(
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

pub(super) fn build_condition_sql(
    filters: &[ResolvedFilter],
    fact_table: &str,
    fact_model_name: &str,
    model: &DataModel,
) -> QueryResult<String> {
    build_condition_sql_impl(filters, &[], fact_table, fact_model_name, model, None)
}

pub(super) fn build_condition_sql_with_conditions(
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
pub(super) fn collect_qualified_tables(
    expr: &Expression,
    fact_table: &str,
    tables: &mut Vec<String>,
) {
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
/// QualifiedColumnRef nodes are rendered as `table."column"` (lowercased table
/// name); bare column references stay unqualified. Delegates to the unified
/// [`SqlRenderer`] (DataFusion dialect, [`LowercaseTableQualifier`]).
fn qualify_condition_sql(expr: &Expression) -> QueryResult<String> {
    Ok(SqlRenderer::new(DataFusionDialect, &LowercaseTableQualifier).render(expr)?)
}

/// Recursively resolve and generate SQL for compound measure expressions
/// where sub-aggregates may have independent filter contexts.
///
/// This handles cases like `ABS(SUM(x, bikes) - SUM(x, acc))` where each
/// sub-aggregate has its own variable/KEEP context. The standard single-context
/// resolver would merge conflicting filters; this function resolves each
/// sub-aggregate independently.
///
/// NOT unified into [`SqlRenderer`]: this is not a pure expression renderer —
/// each recursion step may run the `ContextResolver` and accumulate side
/// effects (`context_join_tables`, `override_joins`) that drive JOIN
/// construction. Leaf rendering already delegates to the unified renderer via
/// `to_sql_string`/`to_case_when_sql`.
/// Fail closed when a resolved context carries `KEEP(... IN variable[column])`
/// membership filters (`eval_ctx.in_filters`) that the local aggregation render
/// cannot apply.
///
/// The CASE-WHEN render paths only consult `effective_filters()` plus boolean
/// `conditions`; an `in_filter` would be silently dropped, returning an
/// unfiltered — wrong — number (the TREATAS / set-membership footgun). The
/// pushed connector path and the engine-core scalar `MeasureEngine` DO apply
/// them; only this path cannot yet, so we refuse rather than mislead.
pub(super) fn reject_unconsumed_in_filters(
    label: &str,
    ctx: &EvaluationContext,
) -> QueryResult<()> {
    if !ctx.in_filters.is_empty() {
        return Err(crate::error::QueryError::InvalidQuery(format!(
            "measure '{label}' uses a KEEP(... IN variable[column]) membership filter, which \
             is not yet applied on the local aggregation path and would otherwise be silently \
             ignored (returning an unfiltered result). Express the set membership via a \
             request-level in_filters slicer, or query a source that pushes the IN subquery."
        )));
    }
    Ok(())
}

/// A group-by column paired with its rendered SQL, used to build the
/// `PARTITION BY` list when a measure clears the group-by axis.
#[derive(Clone)]
pub(super) struct GroupColumn {
    pub table_lc: String,
    pub column_lc: String,
    pub sql: String,
}

fn lc_has(set: &std::collections::HashSet<String>, target_lc: &str) -> bool {
    set.iter().any(|s| s.eq_ignore_ascii_case(target_lc))
}

fn lc_pair_has(
    set: &std::collections::HashSet<(String, String)>,
    t_lc: &str,
    c_lc: &str,
) -> bool {
    set.iter()
        .any(|(t, c)| t.eq_ignore_ascii_case(t_lc) && c.eq_ignore_ascii_case(c_lc))
}

/// Does `ctx` clear the group-by AXIS filter on `(table, column)`? Both-source
/// (`CLEAR`/`CLEAREXCEPT`) and inner (`CLEAR_INNER`) clears remove the axis
/// grouping; outer clears (`CLEAR_OUTER`) target only slicers and never touch
/// the partition.
fn column_axis_cleared(ctx: &EvaluationContext, t_lc: &str, c_lc: &str) -> bool {
    lc_has(&ctx.cleared_tables, t_lc)
        || lc_has(&ctx.cleared_inner_tables, t_lc)
        || lc_pair_has(&ctx.cleared_columns, t_lc, c_lc)
        || lc_pair_has(&ctx.cleared_inner_columns, t_lc, c_lc)
        || ctx.clear_except.iter().any(|(et, preserved)| {
            et.eq_ignore_ascii_case(t_lc) && !preserved.iter().any(|p| p.eq_ignore_ascii_case(c_lc))
        })
}

/// If `ctx` clears the group-by axis, return the surviving `PARTITION BY`
/// columns for a windowed re-aggregation; `None` means no axis clearing (render
/// normally). An empty vec means every axis column was cleared → `OVER ()`,
/// a single grand-total partition.
pub(super) fn axis_clear_partition(
    ctx: &EvaluationContext,
    group_columns: &[GroupColumn],
) -> Option<Vec<String>> {
    let axis_clearing = ctx.is_reset
        || ctx.is_reset_inner
        || !ctx.cleared_tables.is_empty()
        || !ctx.cleared_columns.is_empty()
        || !ctx.cleared_inner_tables.is_empty()
        || !ctx.cleared_inner_columns.is_empty()
        || !ctx.clear_except.is_empty();
    if !axis_clearing {
        return None;
    }
    if ctx.is_reset || ctx.is_reset_inner {
        return Some(Vec::new());
    }
    Some(
        group_columns
            .iter()
            .filter(|g| !column_axis_cleared(ctx, &g.table_lc, &g.column_lc))
            .map(|g| g.sql.clone())
            .collect(),
    )
}

/// The window re-aggregation function for a CLEAR'd aggregate. `SUM` re-sums
/// additive aggregates (SUM/COUNT/COUNTROWS) over the partition; MIN/MAX carry
/// through; other aggregates (AVG/DISTINCTCOUNT/MEDIAN/STDEV/…) cannot be
/// recombined from per-group values, so they must fail closed.
fn clear_reagg_fn(op: AggregateOp) -> Option<&'static str> {
    match op {
        AggregateOp::Sum | AggregateOp::Count | AggregateOp::CountRows => Some("SUM"),
        AggregateOp::Min => Some("MIN"),
        AggregateOp::Max => Some("MAX"),
        _ => None,
    }
}

/// Wrap an inner aggregate SQL string in the windowed re-aggregation implied by
/// an axis-clearing context: `<reagg>(inner) OVER (PARTITION BY partition)`.
/// `stripped` is the aggregate the context wrapped — its op picks the
/// re-aggregation function (and fails closed for non-recombinable aggregates).
pub(super) fn wrap_axis_clear(
    inner_sql: String,
    stripped: &Expression,
    partition: &[String],
    label: &str,
) -> QueryResult<String> {
    let op = match stripped {
        Expression::Aggregate { operation, .. } => *operation,
        _ => {
            return Err(crate::error::QueryError::InvalidQuery(format!(
                "{label} applies CLEAR/RESET around a non-aggregate expression, which cannot be \
                 recombined over the cleared partition"
            )))
        }
    };
    let reagg = clear_reagg_fn(op).ok_or_else(|| {
        crate::error::QueryError::InvalidQuery(format!(
            "{label} applies CLEAR/RESET around a {op:?} aggregate, which cannot be recombined \
             from per-group values over the cleared partition; CLEAR/RESET currently supports \
             SUM, COUNT, COUNTROWS, MIN, and MAX"
        ))
    })?;
    let over = if partition.is_empty() {
        "OVER ()".to_string()
    } else {
        format!("OVER (PARTITION BY {})", partition.join(", "))
    };
    Ok(format!("{reagg}({inner_sql}) {over}"))
}

pub(super) fn resolve_compound_sql(
    expr: &Expression,
    model: &DataModel,
    fact_table: &str,
    fact_model_name: &str,
    group_columns: &[GroupColumn],
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
                group_columns,
                context_join_tables,
                override_joins,
            )?;
            let r = resolve_compound_sql(
                right,
                model,
                fact_table,
                fact_model_name,
                group_columns,
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
                group_columns,
                context_join_tables,
                override_joins,
            )?;
            let d = resolve_compound_sql(
                denominator,
                model,
                fact_table,
                fact_model_name,
                group_columns,
                context_join_tables,
                override_joins,
            )?;
            let alt = match alternate {
                Some(a) => resolve_compound_sql(
                    a,
                    model,
                    fact_table,
                    fact_model_name,
                    group_columns,
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
                        group_columns,
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
                        group_columns,
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
                group_columns,
                context_join_tables,
                override_joins,
            )?;
            let t = resolve_compound_sql(
                then_expr,
                model,
                fact_table,
                fact_model_name,
                group_columns,
                context_join_tables,
                override_joins,
            )?;
            let e = resolve_compound_sql(
                else_expr,
                model,
                fact_table,
                fact_model_name,
                group_columns,
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
                group_columns,
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
                group_columns,
                context_join_tables,
                override_joins,
            )?;
            Ok(format!("(NOT {i})"))
        }

        // Expressions with context ops: resolve independently via the context resolver.
        _ if expr.has_context_ops() => {
            let resolver = ContextResolver::new(model);
            let (stripped, ctx) = resolver.resolve(expr)?;
            reject_unconsumed_in_filters("a compound context expression", &ctx)?;
            let effective = ctx.effective_filters(&[]);

            for f in &effective {
                if f.table != fact_model_name {
                    context_join_tables.push(f.table.clone());
                }
            }

            // Collect alias map from USERELATIONSHIP overrides.
            let alias_map =
                build_override_alias_map(&ctx, model, fact_model_name, fact_table, override_joins);

            // Inner aggregate SQL: CASE WHEN when KEEP filters are present, else
            // the plain aggregate (recurse into the stripped expression).
            let inner_sql = if effective.is_empty() {
                resolve_compound_sql(
                    &stripped,
                    model,
                    fact_table,
                    fact_model_name,
                    group_columns,
                    context_join_tables,
                    override_joins,
                )?
            } else {
                let condition = build_condition_sql_with_aliases(
                    &effective,
                    fact_table,
                    fact_model_name,
                    model,
                    &alias_map,
                )?;
                let measure_table = &fact_model_name.to_lowercase();
                stripped.to_case_when_sql(&condition, measure_table)?
            };

            // If the context clears the group-by axis, it must re-aggregate over
            // the surviving partition. Inside a compound expression (e.g. the
            // DIVIDE of a percent-of-total) DataFusion's physical planner rejects
            // a window function (`SUM(inner) OVER (...)`) nested in a scalar
            // expression, so we cannot use the windowed form here.
            match axis_clear_partition(&ctx, group_columns) {
                None => Ok(inner_sql),
                // Grand-total clear (RESET, or CLEAR of every axis dimension →
                // empty partition) over a fact-only aggregate: an UNCORRELATED
                // scalar subquery gives the same total and DataFusion CAN nest
                // it inside the surrounding expression. Restricted to the
                // no-extra-JOIN case (effective/conditions empty) so the
                // subquery's `FROM <fact>` has every column it references; the
                // registered fact batch is already slicer/RLS-filtered, so RESET
                // still cannot strip RLS (correct) and Step A guarantees no
                // report slicer remains to clear.
                Some(partition)
                    if partition.is_empty()
                        && effective.is_empty()
                        && ctx.conditions.is_empty() =>
                {
                    // Alias the subquery's aggregate to a name the outer query
                    // does not use — otherwise DataFusion's scalar-subquery
                    // decorrelation sees two `sum(...)` columns and reports an
                    // ambiguous reference.
                    let fact_lc = fact_model_name.to_lowercase();
                    Ok(format!(
                        "(SELECT {inner_sql} AS __clear_scalar FROM {fact_lc})"
                    ))
                }
                // Partitioned (percent-of-parent) or a cleared aggregate that
                // needs a JOIN: still needs the two-level-query rendering. Fail
                // closed with guidance rather than emit SQL DataFusion cannot run.
                Some(_) => Err(crate::error::QueryError::InvalidQuery(
                    "CLEAR/RESET that keeps a surviving group-by column in the partition (for \
                     example percent-of-parent with CLEAREXCEPT), or clears a joined aggregate, \
                     inside a compound expression is not yet supported on the local (in-memory) \
                     path. Compute the cleared total as its own measure (e.g. \
                     `Total = SUM(x, RESET())`) and divide in the host, or run the model against \
                     a PostgreSQL source."
                        .into(),
                )),
            }
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

#[cfg(test)]
mod tests {
    use super::*;
    use engine_core::compute::expression::{
        and, compare, is_blank, lit_str, not, qualified_col, ComparisonOp,
    };

    #[test]
    fn qualify_condition_complex_pinned() {
        // Equivalence oracle for the unified renderer migration: AND + NOT +
        // ISBLANK + comparison over table-qualified columns with a quoted
        // literal. Pinned from the pre-unification implementation — must
        // never change.
        let cond = and(
            compare(
                qualified_col("Products", "category"),
                ComparisonOp::Equal,
                lit_str("O'Brien"),
            ),
            not(is_blank(qualified_col("Dates", "year"))),
        );
        assert_eq!(
            qualify_condition_sql(&cond).unwrap(),
            "((products.\"category\" = 'O''Brien') AND (NOT (dates.\"year\" IS NULL)))"
        );
    }
}
