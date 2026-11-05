//! Condition and compound-expression SQL rendering shared by the local
//! aggregation paths, including USERELATIONSHIP override JOIN bookkeeping.

use datafusion::prelude::SessionContext;
use engine_core::compute::aggregate::AggregateOp;
use engine_core::compute::dax_semantics::{self, DivideStyle};
use engine_core::compute::context::{
    format_filter_value, ContextResolver, EvaluationContext, ResolvedFilter, LEVEL_AXIS,
};
use engine_core::compute::expression::{
    DataFusionDialect, Expression, LowercaseTableQualifier, SqlRenderer,
};
use engine_core::compute::sql_util::{null_is_false_condition, quote_ident_double};
use engine_core::model::DataModel;

use crate::error::QueryResult;

/// The alias `resolve_compound_sql` gives the aggregate of a grand-total
/// (RESET / full-axis CLEAR) scalar subquery -- the mark
/// [`hoist_clear_scalars`] finds it by.
const CLEAR_SCALAR_ALIAS: &str = "__clear_scalar";

/// Move every grand-total scalar subquery of a finished compound-measure SQL
/// fragment out of the expression and into a one-row `CROSS JOIN` derived
/// table, returning the rewritten fragment (BUG-0444).
///
/// `resolve_compound_sql` renders a RESET / full-axis-CLEAR total inside a
/// compound measure as an uncorrelated scalar subquery,
/// `(SELECT <agg> AS __clear_scalar FROM <fact>)`. DataFusion (44) cannot plan
/// that subquery once it ALSO appears in the HAVING clause -- and it always
/// does: the grouped query's `HAVING ("<measure>" IS NOT NULL)` expands the
/// alias back into the expression, so the subquery is decorrelated twice
/// (`__scalar_sq_1`, `__scalar_sq_2`) and, when the query reads only the fact
/// table (grouped by a FACT column), `optimize_projections` drops one of the
/// two while the plan still names it: "No field named
/// `__scalar_sq_1.__clear_scalar`". A cross-joined one-row table is the same
/// number with no subquery left in the expression: each occurrence becomes
/// `MAX(__csN.__clear_scalar)` (the column is constant, and `MAX` makes it
/// legal in a grouped SELECT and HAVING), and `joins` receives one
/// `CROSS JOIN (SELECT ...) AS __csN` per DISTINCT subquery, for the caller to
/// append after its own JOINs. Whenever the fact table has a row, the two are
/// equivalent row for row: the derived table has exactly one row (an
/// aggregate without GROUP BY), so it neither multiplies nor removes a fact
/// row, and it reads the same registered fact batch the scalar subquery read.
///
/// NOT over an EMPTY fact table. `FROM <fact> CROSS JOIN <one row>` then has
/// no rows, so an ungrouped query (or a ROLLUP grand-total row) aggregates
/// `MAX(__csN.__clear_scalar)` over nothing and reads the total as NULL
/// (BLANK), where the inline subquery read the empty set's aggregate. For SUM,
/// AVG, MIN, MAX and the statistical aggregates that was NULL already; for the
/// COUNT family it was 0. BLANK is kept deliberately (rev-backend-7): it is
/// DAX's own answer -- COUNTROWS, COUNT and DISTINCTCOUNT of an empty table
/// are BLANK -- and it makes the share `COUNTROWS(f) / COUNTROWS(f, RESET())`
/// BLANK, as BLANK / BLANK is in DAX, where 0 / 0 is an integer divide-by-zero
/// that fails the whole query. Pinned end to end by
/// `clear_reset_tests::a_reset_total_over_an_empty_fact_table_is_blank`.
///
/// The scan honours single-quoted literals and double-quoted identifiers, so
/// a parenthesis inside a filter value never unbalances it.
pub(super) fn hoist_clear_scalars(sql: &str, joins: &mut Vec<String>) -> String {
    let tail = format!(" AS {CLEAR_SCALAR_ALIAS} FROM ");
    // (start of '(', index of the matching ')') of each grand-total subquery.
    let mut ranges: Vec<(usize, usize)> = Vec::new();
    let mut open: Vec<usize> = Vec::new();
    let bytes = sql.as_bytes();
    let mut quote: Option<u8> = None;
    for (i, &b) in bytes.iter().enumerate() {
        if let Some(q) = quote {
            // A doubled quote ('' or "") toggles out and straight back in.
            if b == q {
                quote = None;
            }
            continue;
        }
        match b {
            b'\'' | b'"' => quote = Some(b),
            b'(' => open.push(i),
            b')' => {
                if let Some(start) = open.pop() {
                    let content = &sql[start + 1..i];
                    let is_clear_scalar = content.starts_with("SELECT ")
                        && content.rfind(&tail).is_some_and(|p| {
                            let table = &content[p + tail.len()..];
                            !table.is_empty()
                                && table
                                    .bytes()
                                    .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'.')
                        });
                    if is_clear_scalar {
                        ranges.push((start, i));
                    }
                }
            }
            _ => {}
        }
    }
    if ranges.is_empty() {
        return sql.to_string();
    }
    ranges.sort_unstable();
    let mut out = String::with_capacity(sql.len());
    let mut cursor = 0;
    for (start, end) in ranges {
        if start < cursor {
            // Nested inside a range already replaced (cannot happen: the inner
            // aggregate of a grand-total subquery is a plain aggregate).
            continue;
        }
        let subquery = &sql[start..=end];
        let join = format!("CROSS JOIN {subquery} AS __cs");
        let idx = match joins.iter().position(|j| j.starts_with(&join)) {
            Some(idx) => idx,
            None => {
                joins.push(format!("{join}{}", joins.len()));
                joins.len() - 1
            }
        };
        out.push_str(&sql[cursor..start]);
        out.push_str(&format!("MAX(__cs{idx}.{CLEAR_SCALAR_ALIAS})"));
        cursor = end + 1;
    }
    out.push_str(&sql[cursor..]);
    out
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
/// Cap on IN-membership set sizes rendered as inline literal lists.
const MAX_IN_SET_VALUES: usize = 50_000;

/// Render resolved IN-membership filters (`KEEP(... IN set[col])` and
/// TREATAS) as SQL conditions. DataFusion cannot execute an IN-subquery
/// inside a CASE expression, so the set is materialized FIRST — a
/// `SELECT DISTINCT` probe against the registered set-provider batch — and
/// rendered as an inline literal list: `target."col" IN ('a', 'b', ...)`.
/// An empty set renders `FALSE` (no row matches, DAX-blank semantics).
/// The set-provider base table must be fetched/registered — the planner adds
/// it to the fetch set.
pub(super) async fn render_in_filter_conditions(
    ctx: &SessionContext,
    in_filters: &[engine_core::compute::context::ResolvedInFilter],
    fact_model_name: &str,
    fact_table: &str,
    model: &DataModel,
) -> QueryResult<Vec<String>> {
    use datafusion::common::ScalarValue;
    use engine_core::compute::sql_util::sql_quote_literal;

    let mut out = Vec::new();
    for inf in in_filters {
        let base = inf.var_base_table.to_lowercase();
        let mut probe = format!(
            "SELECT DISTINCT {base}.{c} FROM {base}",
            c = quote_ident_double(&inf.var_column)
        );
        if !inf.var_filters.is_empty() {
            let parts: Vec<String> = inf
                .var_filters
                .iter()
                .map(|f| {
                    let val = format_filter_value(&f.table, &f.column, &f.value, model);
                    format!(
                        "{base}.{} {} {}",
                        quote_ident_double(&f.column),
                        f.operator.as_sql(),
                        val
                    )
                })
                .collect();
            probe.push_str(&format!(" WHERE {}", parts.join(" AND ")));
        }
        let batches = ctx.sql(&probe).await?.collect().await?;

        let mut values: Vec<String> = Vec::new();
        for batch in &batches {
            let col = batch.column(0);
            for row in 0..batch.num_rows() {
                let mut sv = ScalarValue::try_from_array(col, row)?;
                if let ScalarValue::Dictionary(_, inner) = sv {
                    sv = *inner;
                }
                match sv {
                    ScalarValue::Utf8(Some(s)) | ScalarValue::LargeUtf8(Some(s)) => {
                        values.push(sql_quote_literal(&s));
                    }
                    ScalarValue::Int8(Some(v)) => values.push(v.to_string()),
                    ScalarValue::Int16(Some(v)) => values.push(v.to_string()),
                    ScalarValue::Int32(Some(v)) => values.push(v.to_string()),
                    ScalarValue::Int64(Some(v)) => values.push(v.to_string()),
                    ScalarValue::UInt32(Some(v)) => values.push(v.to_string()),
                    ScalarValue::UInt64(Some(v)) => values.push(v.to_string()),
                    ScalarValue::Float32(Some(v)) => values.push(v.to_string()),
                    ScalarValue::Float64(Some(v)) => values.push(v.to_string()),
                    // NULL set members never match an IN list — skip.
                    sv if sv.is_null() => {}
                    other => {
                        return Err(crate::error::QueryError::InvalidQuery(format!(
                            "TREATAS / KEEP-IN set '{}[{}]' has an unsupported value type \
                             ({:?}); use a text or numeric column",
                            inf.var_base_table,
                            inf.var_column,
                            other.data_type()
                        )));
                    }
                }
                if values.len() > MAX_IN_SET_VALUES {
                    return Err(crate::error::QueryError::InvalidQuery(format!(
                        "TREATAS / KEEP-IN set '{}[{}]' exceeds {MAX_IN_SET_VALUES} distinct \
                         values",
                        inf.var_base_table, inf.var_column
                    )));
                }
            }
        }

        let target = if inf.table.eq_ignore_ascii_case(fact_model_name) {
            fact_table.to_string()
        } else {
            inf.table.to_lowercase()
        };
        // NOT IN complements the membership: an empty set matches every row
        // (NULL set members are already skipped above, so the SQL NOT-IN
        // NULL trap cannot occur). A BLANK fact value satisfies neither
        // form — SQL `<>` semantics.
        out.push(match (values.is_empty(), inf.negated) {
            (true, false) => "FALSE".to_string(),
            (true, true) => "TRUE".to_string(),
            (false, negated) => format!(
                "{target}.{} {} ({})",
                quote_ident_double(&inf.column),
                if negated { "NOT IN" } else { "IN" },
                values.join(", ")
            ),
        });
    }
    Ok(out)
}

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

/// Does `ctx` clear the group-by AXIS filter on `(table, column)`? Any clear
/// whose level range includes [`LEVEL_AXIS`] (`CLEAR`/`CLEAR_INNER`/
/// `CLEAREXCEPT`) removes the axis grouping; outer clears (`CLEAR_OUTER`,
/// range `[1,…]`) target only slicers and never touch the partition.
fn column_axis_cleared(ctx: &EvaluationContext, t_lc: &str, c_lc: &str) -> bool {
    ctx.table_cleared_at_ci(t_lc, LEVEL_AXIS)
        || ctx.column_cleared_at_ci(t_lc, c_lc, LEVEL_AXIS)
        || ctx.clear_except_clears_ci(t_lc, c_lc)
}

/// If `ctx` clears the group-by axis, return the surviving `PARTITION BY`
/// columns for a windowed re-aggregation; `None` means no axis clearing (render
/// normally). An empty vec means every axis column was cleared → `OVER ()`,
/// a single grand-total partition.
pub(super) fn axis_clear_partition(
    ctx: &EvaluationContext,
    group_columns: &[GroupColumn],
) -> Option<Vec<String>> {
    let axis_clearing = ctx.reset_at(LEVEL_AXIS)
        || ctx.cleared_tables.values().any(|r| r.contains(LEVEL_AXIS))
        || ctx.cleared_columns.values().any(|r| r.contains(LEVEL_AXIS))
        || !ctx.clear_except.is_empty();
    if !axis_clearing {
        return None;
    }
    if ctx.reset_at(LEVEL_AXIS) {
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

/// Is `expr` a compound measure whose sub-aggregates may carry INDEPENDENT
/// contexts -- a combinator `resolve_compound_sql` / `hoist_measure_sql`
/// recurse through -- holding a context operation? Such a measure must not be
/// resolved as one context (which merges, or drops, its subterms' KEEPs). A
/// measure-level comparison / logical node joined the list in the open-ledger
/// round E: resolved as a unit, `SUM(x, KEEP(...)) > SUM(y)` lost its KEEP.
pub(super) fn is_compound_with_context(expr: &Expression) -> bool {
    expr.has_context_ops()
        && matches!(
            expr,
            Expression::BinaryOp { .. }
                | Expression::SafeDivide { .. }
                | Expression::ScalarFunc { .. }
                | Expression::Coalesce(_)
                | Expression::If { .. }
                | Expression::Comparison { .. }
                | Expression::And(..)
                | Expression::Or(..)
                | Expression::Xor(..)
                | Expression::Not(_)
                | Expression::IsBlank(_)
        )
}

/// `AND` / `OR` / `XOR` of two rendered operands (`expr` says which).
fn logical_sql(expr: &Expression, l: &str, r: &str) -> String {
    match expr {
        Expression::Or(..) => format!("({l} OR {r})"),
        Expression::Xor(..) => format!("(({l} AND NOT {r}) OR (NOT {l} AND {r}))"),
        _ => format!("({l} AND {r})"),
    }
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
        // Compound expressions: recurse into each operand independently, with
        // DAX BLANK arithmetic (`engine_core::compute::dax_semantics`).
        Expression::BinaryOp { .. } => dax_semantics::render_binary(
            expr,
            DivideStyle::Ieee,
            &mut |e| {
                resolve_compound_sql(
                    e,
                    model,
                    fact_table,
                    fact_model_name,
                    group_columns,
                    context_join_tables,
                    override_joins,
                )
            },
        ),
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
            Ok(dax_semantics::safe_divide_sql(&n, &d, &alt, "DOUBLE"))
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
            let c = null_is_false_condition(&c, condition.is_boolean_predicate());
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
        // A measure-level comparison / AND / OR / XOR: each operand resolves
        // its own context, so `IF(SUM(x, KEEP(...)) > SUM(y), ...)` filters
        // only the left sum. Resolved as ONE context (the arm below) the KEEP
        // reached the conditional renderer's comparison fallback and was
        // dropped (NEW-keep-in-if-condition, open-ledger round E).
        Expression::Comparison { left, op, right } => {
            let mut recurse = |e: &Expression| {
                resolve_compound_sql(
                    e,
                    model,
                    fact_table,
                    fact_model_name,
                    group_columns,
                    context_join_tables,
                    override_joins,
                )
            };
            let l = dax_semantics::comparison_operand(recurse(left)?, left, right);
            let r = dax_semantics::comparison_operand(recurse(right)?, right, left);
            Ok(format!("({l} {} {r})", op.as_sql()))
        }
        Expression::And(left, right) | Expression::Or(left, right) | Expression::Xor(left, right) => {
            let mut recurse = |e: &Expression| {
                resolve_compound_sql(
                    e,
                    model,
                    fact_table,
                    fact_model_name,
                    group_columns,
                    context_join_tables,
                    override_joins,
                )
            };
            let l = recurse(left)?;
            let r = recurse(right)?;
            Ok(logical_sql(expr, &l, &r))
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
            // A KEEP's expression conditions (`IN {...}`, column-vs-column)
            // filter the aggregate too; they were ignored here.
            for cond in &ctx.conditions {
                collect_qualified_tables(cond, fact_model_name, context_join_tables);
            }

            // Collect alias map from USERELATIONSHIP overrides.
            let alias_map =
                build_override_alias_map(&ctx, model, fact_model_name, fact_table, override_joins);

            // Inner aggregate SQL: CASE WHEN when KEEP filters are present, else
            // the plain aggregate (recurse into the stripped expression).
            let inner_sql = if effective.is_empty() && ctx.conditions.is_empty() {
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
                let condition = build_condition_sql_with_conditions(
                    &effective,
                    &ctx.conditions,
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
                    //
                    // The caller moves this subquery into a CROSS JOIN with
                    // `hoist_clear_scalars` (BUG-0444): left inline, DataFusion
                    // cannot plan it once HAVING repeats the measure.
                    let fact_lc = fact_model_name.to_lowercase();
                    Ok(format!(
                        "(SELECT {inner_sql} AS {CLEAR_SCALAR_ALIAS} FROM {fact_lc})"
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
            // A count answers BLANK, never 0 (DAX).
            if matches!(operation, AggregateOp::CountRows) {
                return Ok(dax_semantics::blank_zero_count(
                    operation,
                    "COUNT(*)".to_string(),
                ));
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
            Ok(dax_semantics::measure_aggregate_sql(operation, &qualified))
        }

        // Leaf expressions: generate plain SQL.
        _ => Ok(expr.to_sql_string()?),
    }
}

/// Does `expr` contain a CLEAR/RESET that leaves a NON-empty group-by partition
/// (percent-of-parent, e.g. `CLEAREXCEPT(dim, dim[keepcol])`)? Such a measure
/// needs the two-level-query wrapper (`hoist_measure_sql`) — a window aggregate
/// over a partition cannot be a scalar subquery, nor nested in an expression.
///
/// Walks the compound combinators to the leaf context-op sub-expressions and
/// resolves each independently (mirroring `resolve_compound_sql`'s dispatch).
pub(super) fn contains_partitioned_clear(
    expr: &Expression,
    model: &DataModel,
    group_columns: &[GroupColumn],
) -> QueryResult<bool> {
    let any = |es: &[&Expression]| -> QueryResult<bool> {
        for e in es {
            if contains_partitioned_clear(e, model, group_columns)? {
                return Ok(true);
            }
        }
        Ok(false)
    };
    match expr {
        Expression::BinaryOp { left, right, .. } => any(&[left, right]),
        Expression::SafeDivide {
            numerator,
            denominator,
            alternate,
        } => match alternate {
            Some(a) => any(&[numerator, denominator, a]),
            None => any(&[numerator, denominator]),
        },
        Expression::ScalarFunc { args, .. } => any(&args.iter().collect::<Vec<_>>()),
        Expression::Coalesce(exprs) => any(&exprs.iter().collect::<Vec<_>>()),
        Expression::If {
            condition,
            then_expr,
            else_expr,
        } => any(&[condition, then_expr, else_expr]),
        Expression::IsBlank(inner) | Expression::Not(inner) => {
            contains_partitioned_clear(inner, model, group_columns)
        }
        Expression::Comparison { left, right, .. }
        | Expression::And(left, right)
        | Expression::Or(left, right)
        | Expression::Xor(left, right) => any(&[left, right]),
        _ if expr.has_context_ops() => {
            let (_, ctx) = ContextResolver::new(model).resolve(expr)?;
            Ok(axis_clear_partition(&ctx, group_columns).is_some_and(|p| !p.is_empty()))
        }
        _ => Ok(false),
    }
}

/// Push an inner-query column and return a reference to it (`__hN`).
fn push_hoist(hoist: &mut Vec<(String, String)>, sql: String) -> String {
    let name = format!("__h{}", hoist.len());
    hoist.push((name.clone(), sql));
    name
}

/// Render a compound measure that clears a PARTITIONED group-by axis
/// (percent-of-parent) for the two-level query: every leaf aggregate and every
/// windowed clear is pushed to `hoist` as an inner-query column (a top-level
/// SELECT item, which DataFusion supports), and the returned string is the
/// OUTER expression referencing those columns by their `__hN` names.
#[allow(clippy::too_many_arguments)]
pub(super) fn hoist_measure_sql(
    expr: &Expression,
    model: &DataModel,
    fact_table: &str,
    fact_model_name: &str,
    group_columns: &[GroupColumn],
    context_join_tables: &mut Vec<String>,
    override_joins: &mut Vec<OverrideJoinEntry>,
    hoist: &mut Vec<(String, String)>,
) -> QueryResult<String> {
    macro_rules! recurse {
        ($e:expr) => {
            hoist_measure_sql(
                $e,
                model,
                fact_table,
                fact_model_name,
                group_columns,
                context_join_tables,
                override_joins,
                hoist,
            )?
        };
    }
    match expr {
        Expression::BinaryOp { .. } => dax_semantics::render_binary(
            expr,
            DivideStyle::Ieee,
            &mut |e| {
                hoist_measure_sql(
                    e,
                    model,
                    fact_table,
                    fact_model_name,
                    group_columns,
                    context_join_tables,
                    override_joins,
                    hoist,
                )
            },
        ),
        Expression::SafeDivide {
            numerator,
            denominator,
            alternate,
        } => {
            let n = recurse!(numerator);
            let d = recurse!(denominator);
            let alt = match alternate {
                Some(a) => recurse!(a),
                None => "NULL".to_string(),
            };
            Ok(dax_semantics::safe_divide_sql(&n, &d, &alt, "DOUBLE"))
        }
        Expression::ScalarFunc { function, args } => {
            let mut mapped = Vec::with_capacity(args.len());
            for a in args {
                mapped.push(recurse!(a));
            }
            Ok(function.to_sql_strs(&mapped))
        }
        Expression::Coalesce(exprs) => {
            let mut mapped = Vec::with_capacity(exprs.len());
            for e in exprs {
                mapped.push(recurse!(e));
            }
            Ok(format!("COALESCE({})", mapped.join(", ")))
        }
        Expression::If {
            condition,
            then_expr,
            else_expr,
        } => {
            let c = recurse!(condition);
            let t = recurse!(then_expr);
            let e = recurse!(else_expr);
            let c = null_is_false_condition(&c, condition.is_boolean_predicate());
            Ok(format!("CASE WHEN {c} THEN {t} ELSE {e} END"))
        }
        Expression::IsBlank(inner) => {
            let i = recurse!(inner);
            Ok(format!("({i} IS NULL)"))
        }
        Expression::Not(inner) => {
            let i = recurse!(inner);
            Ok(format!("(NOT {i})"))
        }
        // Each operand of a measure-level comparison / AND / OR / XOR keeps
        // its own context (mirrors `resolve_compound_sql`).
        Expression::Comparison { left, op, right } => {
            let l = dax_semantics::comparison_operand(recurse!(left), left, right);
            let r = dax_semantics::comparison_operand(recurse!(right), right, left);
            Ok(format!("({l} {} {r})", op.as_sql()))
        }
        Expression::And(left, right) | Expression::Or(left, right) | Expression::Xor(left, right) => {
            let l = recurse!(left);
            let r = recurse!(right);
            Ok(logical_sql(expr, &l, &r))
        }
        // A context-op aggregate: render its inner aggregate (CASE WHEN for KEEP,
        // else the plain aggregate), wrap in the window if it clears the axis,
        // and hoist the whole thing as one inner column.
        _ if expr.has_context_ops() => {
            let (stripped, ctx) = ContextResolver::new(model).resolve(expr)?;
            reject_unconsumed_in_filters("a compound context expression", &ctx)?;
            let effective = ctx.effective_filters(&[]);
            for f in &effective {
                if f.table != fact_model_name {
                    context_join_tables.push(f.table.clone());
                }
            }
            for cond in &ctx.conditions {
                collect_qualified_tables(cond, fact_model_name, context_join_tables);
            }
            let alias_map =
                build_override_alias_map(&ctx, model, fact_model_name, fact_table, override_joins);
            let inner_sql = if effective.is_empty() && ctx.conditions.is_empty() {
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
                let condition = build_condition_sql_with_conditions(
                    &effective,
                    &ctx.conditions,
                    fact_table,
                    fact_model_name,
                    model,
                    &alias_map,
                )?;
                stripped.to_case_when_sql(&condition, &fact_model_name.to_lowercase())?
            };
            let col_sql = match axis_clear_partition(&ctx, group_columns) {
                Some(partition) => wrap_axis_clear(
                    inner_sql,
                    &stripped,
                    &partition,
                    "a percent-of-parent measure",
                )?,
                None => inner_sql,
            };
            Ok(push_hoist(hoist, col_sql))
        }
        // A bare aggregate: hoist its per-group value as an inner column.
        Expression::Aggregate { .. } => {
            let sql = resolve_compound_sql(
                expr,
                model,
                fact_table,
                fact_model_name,
                group_columns,
                context_join_tables,
                override_joins,
            )?;
            Ok(push_hoist(hoist, sql))
        }
        // Leaves (literals, etc.): inline into the outer expression.
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
    fn hoist_clear_scalars_moves_each_distinct_total_into_one_cross_join() {
        // BUG-0444: DIVIDE repeats its denominator; both copies read ONE
        // cross-joined total, and a parenthesis inside a quoted literal or
        // identifier never unbalances the scan.
        let sub = "(SELECT SUM(sales.\"amount\") AS __clear_scalar FROM sales)";
        let sql = format!(
            "CASE WHEN {sub} = 0 THEN NULL ELSE CAST(SUM(CASE WHEN sales.\"n\" = 'a(b' \
             THEN sales.\"x)\" END) AS DOUBLE) / {sub} END"
        );
        let mut joins = Vec::new();
        let out = hoist_clear_scalars(&sql, &mut joins);
        assert_eq!(
            out,
            "CASE WHEN MAX(__cs0.__clear_scalar) = 0 THEN NULL ELSE CAST(SUM(CASE WHEN \
             sales.\"n\" = 'a(b' THEN sales.\"x)\" END) AS DOUBLE) / MAX(__cs0.__clear_scalar) END"
        );
        assert_eq!(joins, vec![format!("CROSS JOIN {sub} AS __cs0")]);

        // A second measure's DIFFERENT total gets its own join; the same total
        // reuses the first. A COUNT total is read like any other: over an
        // EMPTY fact table it is BLANK, DAX's answer (rev-backend-7, pinned
        // end to end by `a_reset_total_over_an_empty_fact_table_is_blank`).
        let other = "(SELECT COUNT(*) AS __clear_scalar FROM sales)";
        let out2 = hoist_clear_scalars(&format!("({sub} + {other})"), &mut joins);
        assert_eq!(out2, "(MAX(__cs0.__clear_scalar) + MAX(__cs1.__clear_scalar))");
        assert_eq!(joins.len(), 2);
        assert_eq!(joins[1], format!("CROSS JOIN {other} AS __cs1"));

        // No grand total: the fragment is returned unchanged.
        let plain = "SUM(sales.\"amount\")";
        assert_eq!(hoist_clear_scalars(plain, &mut joins), plain);
        assert_eq!(joins.len(), 2);
    }

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
        // Re-pinned DELIBERATELY (open-ledger round D): a BLANK row compares
        // as "" against a text literal (DAX), so the column is COALESCEd.
        assert_eq!(
            qualify_condition_sql(&cond).unwrap(),
            "((COALESCE(products.\"category\", '') = 'O''Brien') AND (NOT (dates.\"year\" IS NULL)))"
        );
    }
}
