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

pub(super) fn resolve_compound_sql(
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
            )?;
            let measure_table = &fact_model_name.to_lowercase();
            Ok(stripped.to_case_when_sql(&condition, measure_table)?)
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
