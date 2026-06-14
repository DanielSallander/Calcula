//! Source-dialect SQL rendering for pushed expressions and construction of
//! multi-table join aggregation requests.

use engine_connectors::{AggregateFunction, FilterCondition};
use engine_core::compute::expression::{ColumnQualifier, Expression, SqlDialect, SqlRenderer};
use engine_core::compute::measure::Measure;
use engine_core::compute::sql_util::quote_ident_double;
use engine_core::error::{EngineError, EngineResult};
use engine_core::model::DataModel;

use crate::error::{QueryError, QueryResult};
use crate::registry::SourceRegistry;
use crate::request::ColumnRef;

/// Convert an engine-core `AggregateOp` to a connector `AggregateFunction`.
///
/// Returns `None` for statistical aggregates (Median, StdevSample, etc.)
/// that cannot be pushed to data sources and must be computed locally.
pub(super) fn aggregate_op_to_function(
    op: engine_core::compute::aggregate::AggregateOp,
) -> Option<AggregateFunction> {
    match op {
        engine_core::compute::aggregate::AggregateOp::Sum => Some(AggregateFunction::Sum),
        engine_core::compute::aggregate::AggregateOp::Count => Some(AggregateFunction::Count),
        engine_core::compute::aggregate::AggregateOp::Average => Some(AggregateFunction::Avg),
        engine_core::compute::aggregate::AggregateOp::Min => Some(AggregateFunction::Min),
        engine_core::compute::aggregate::AggregateOp::Max => Some(AggregateFunction::Max),
        engine_core::compute::aggregate::AggregateOp::DistinctCount => {
            Some(AggregateFunction::CountDistinct)
        }
        engine_core::compute::aggregate::AggregateOp::CountRows => {
            Some(AggregateFunction::CountAll)
        }
        // Statistical aggregates are computed locally, not pushed to sources.
        engine_core::compute::aggregate::AggregateOp::Median
        | engine_core::compute::aggregate::AggregateOp::StdevSample
        | engine_core::compute::aggregate::AggregateOp::StdevPop
        | engine_core::compute::aggregate::AggregateOp::VarSample
        | engine_core::compute::aggregate::AggregateOp::VarPop => None,
        // AnyValue, Mode: computed locally.
        engine_core::compute::aggregate::AggregateOp::AnyValue
        | engine_core::compute::aggregate::AggregateOp::Mode => None,
    }
}

/// Check if an expression contains RESET, UseRelationship, or other context ops
/// that cannot be pushed to a source. KEEP and CLEAR are pushable.
pub(super) fn has_unpushable_ops(expr: &Expression) -> bool {
    match expr {
        Expression::ClearInner { .. }
        | Expression::ClearOuter { .. }
        | Expression::Reset { .. }
        | Expression::ResetInner { .. }
        | Expression::ResetOuter { .. }
        | Expression::UseRelationship { .. }
        | Expression::Traverse { .. }
        | Expression::Using { .. }
        | Expression::KeepIn { .. } => true,
        Expression::Clear { expr, .. } | Expression::ClearExcept { expr, .. } => {
            has_unpushable_ops(expr)
        }
        Expression::Keep {
            expr,
            variables,
            conditions,
            in_predicates,
            ..
        } => {
            // KEEP with variables, expression conditions, or IN predicates
            // requires local context resolution — not pushable.
            !variables.is_empty()
                || !conditions.is_empty()
                || !in_predicates.is_empty()
                || has_unpushable_ops(expr)
        }
        Expression::Iterate { expression, .. } => has_unpushable_ops(expression),
        Expression::IfError { expr, alternate } => {
            has_unpushable_ops(expr) || has_unpushable_ops(alternate)
        }
        Expression::DateTimeFunc { args, .. } => args.iter().any(has_unpushable_ops),
        Expression::IsInScope { .. } => false,
        // Percentile renders to an EXACT `PERCENTILE_CONT(...) WITHIN GROUP` in
        // the Postgres dialect but only an APPROXIMATE `approx_percentile_cont`
        // in the local DataFusion dialect (DataFusion 44 ships no exact
        // non-median percentile UDAF). If a bare Percentile were pushable, the
        // SAME measure would return an exact value when single-source-pushed to
        // Postgres and an approximate value whenever topology forced local
        // execution (a cross-source join, an in-memory/cached table, or a
        // co-measure that must run locally) — a number that silently changes
        // with query shape, the engine's #1 forbidden failure. Force Percentile
        // local on every path so the result is consistently the local
        // approximation regardless of topology. (Percentile is documented as
        // approximate on the public surface.)
        Expression::Percentile { .. } => true,
        Expression::HasOneValue { column } | Expression::FirstValue { column, .. } => {
            has_unpushable_ops(column)
        }
        Expression::SelectedValue { column, alternate } => {
            has_unpushable_ops(column) || alternate.as_ref().is_some_and(|a| has_unpushable_ops(a))
        }
        Expression::BinaryOp { left, right, .. }
        | Expression::Comparison { left, right, .. }
        | Expression::And(left, right)
        | Expression::Or(left, right)
        | Expression::Xor(left, right) => has_unpushable_ops(left) || has_unpushable_ops(right),
        Expression::SafeDivide {
            numerator,
            denominator,
            alternate,
        } => {
            has_unpushable_ops(numerator)
                || has_unpushable_ops(denominator)
                || alternate.as_ref().is_some_and(|a| has_unpushable_ops(a))
        }
        Expression::Not(inner) | Expression::IsBlank(inner) => has_unpushable_ops(inner),
        Expression::Aggregate { operand, .. } => has_unpushable_ops(operand),
        Expression::If {
            condition,
            then_expr,
            else_expr,
        } => {
            has_unpushable_ops(condition)
                || has_unpushable_ops(then_expr)
                || has_unpushable_ops(else_expr)
        }
        Expression::Coalesce(exprs) => exprs.iter().any(has_unpushable_ops),
        Expression::ScalarFunc { args, .. } | Expression::TextFunc { args, .. } => {
            args.iter().any(has_unpushable_ops)
        }
        // Block with QUERY bindings requires two-stage evaluation — not pushable.
        Expression::Block { bindings, .. }
            if bindings
                .iter()
                .any(|(_, e)| matches!(e, Expression::Query { .. })) =>
        {
            true
        }
        Expression::Block { bindings, result } => {
            bindings.iter().any(|(_, e)| has_unpushable_ops(e)) || has_unpushable_ops(result)
        }
        Expression::Switch {
            expr,
            cases,
            default,
        } => {
            has_unpushable_ops(expr)
                || cases
                    .iter()
                    .any(|(v, r)| has_unpushable_ops(v) || has_unpushable_ops(r))
                || default.as_ref().is_some_and(|d| has_unpushable_ops(d))
        }
        // New pushable expression types.
        Expression::Greatest(args) | Expression::Least(args) => args.iter().any(has_unpushable_ops),
        Expression::NullIf { expr, value } => has_unpushable_ops(expr) || has_unpushable_ops(value),
        Expression::CountIf { condition } => has_unpushable_ops(condition),
        Expression::ListAgg { column, delimiter } => {
            has_unpushable_ops(column) || has_unpushable_ops(delimiter)
        }
        Expression::MaxBy { value, sort_by } | Expression::MinBy { value, sort_by } => {
            has_unpushable_ops(value) || has_unpushable_ops(sort_by)
        }
        // Window/rank functions and QUERY require two-stage evaluation — not pushable.
        // Time-intelligence sugar (ToDate/PeriodShift) lowers to window
        // functions and rides the same local-only gate.
        Expression::Offset { .. }
        | Expression::Index { .. }
        | Expression::Window { .. }
        | Expression::RankWindow { .. }
        | Expression::ToDate { .. }
        | Expression::PeriodShift { .. }
        | Expression::Query { .. } => true,
        // Host-registered UDFs have no source-SQL equivalent — they exist
        // only in the local DataFusion session, so any expression containing
        // a call must be evaluated locally.
        Expression::Call { .. } => true,
        // SELECTEDMEASURE() is a calculation-item placeholder. It is always
        // substituted away before planning, but if one ever reached here it
        // must never be pushed to a source unexpanded — fail closed to local.
        Expression::SelectedMeasure => true,
        _ => false,
    }
}

/// Column qualifier that renders table-qualified references through the
/// source registry: `"source_table"."column"`.
struct RegistryQualifier<'a> {
    registry: &'a SourceRegistry,
}

impl ColumnQualifier for RegistryQualifier<'_> {
    fn column(&self, table_or_var: Option<&str>, column: &str) -> EngineResult<String> {
        match table_or_var {
            None => Ok(quote_ident_double(column)),
            Some(table) => {
                let binding = self
                    .registry
                    .binding_for(table)
                    .map_err(|e| EngineError::InvalidExpression(e.to_string()))?;
                Ok(format!(
                    "{}.{}",
                    quote_ident_double(&binding.table),
                    quote_ident_double(column)
                ))
            }
        }
    }
}

/// Convert an expression to SQL with table-qualified column references for pushdown.
///
/// Uses source bindings to translate model column refs into `"source_table"."column"`.
/// Delegates to the unified [`SqlRenderer`] (Postgres dialect, registry
/// qualifier, KEEP rendered as conditional aggregation).
#[allow(dead_code)]
fn expression_to_source_sql(expr: &Expression, registry: &SourceRegistry) -> QueryResult<String> {
    let qualifier = RegistryQualifier { registry };
    Ok(SqlRenderer::new(SqlDialect::Postgres, &qualifier)
        .with_keep_case_when()
        .render(expr)?)
}

/// Generate SQL for an expression that may contain CLEAR context ops.
///
/// CLEAR is translated to a window function: the inner aggregate result is
/// wrapped in `SUM(inner_agg) OVER (PARTITION BY non-cleared-columns)`.
/// This produces the aggregate value ignoring the cleared dimension's grouping.
///
/// NOT unified into [`SqlRenderer`]: the CLEAR-to-window translation depends
/// on the query's `group_by` column set (to compute the PARTITION BY), which
/// is planner state rather than expression-rendering configuration. Non-CLEAR
/// subtrees delegate to the unified renderer via `expression_to_source_sql`.
#[allow(dead_code)]
fn expression_to_source_sql_with_clear(
    expr: &Expression,
    registry: &SourceRegistry,
    group_by: &[ColumnRef],
) -> QueryResult<String> {
    use engine_core::model::ClearTarget;

    match expr {
        Expression::Clear {
            expr: inner,
            targets,
        } => {
            // Generate the inner expression SQL (may have KEEP → CASE WHEN).
            let inner_sql = expression_to_source_sql_with_clear(inner, registry, group_by)?;

            // Compute PARTITION BY: group_by columns minus cleared targets.
            let partition_cols: Vec<String> = group_by
                .iter()
                .filter(|col_ref| {
                    !targets.iter().any(|t| match t {
                        ClearTarget::Table(table) => col_ref.table == *table,
                        ClearTarget::Column { table, column } => {
                            col_ref.table == *table && col_ref.column == *column
                        }
                    })
                })
                .map(|col_ref| {
                    registry.binding_for(&col_ref.table).map(|b| {
                        format!(
                            "{}.{}",
                            quote_ident_double(&b.table),
                            quote_ident_double(&col_ref.column)
                        )
                    })
                })
                .collect::<QueryResult<Vec<_>>>()?;

            let over_clause = if partition_cols.is_empty() {
                "OVER ()".to_string()
            } else {
                format!("OVER (PARTITION BY {})", partition_cols.join(", "))
            };

            // Wrap in SUM(...) OVER (...) — works for SUM and COUNT aggregates.
            // For SUM: SUM(SUM(x)) OVER (...) = total sum ignoring cleared groups
            // For COUNT: SUM(COUNT(x)) OVER (...) = total count
            Ok(format!("SUM({inner_sql}) {over_clause}"))
        }
        Expression::SafeDivide {
            numerator,
            denominator,
            alternate,
        } => {
            // Recurse: either side may contain CLEAR.
            let n = expression_to_source_sql_with_clear(numerator, registry, group_by)?;
            let d = expression_to_source_sql_with_clear(denominator, registry, group_by)?;
            let alt = match alternate {
                Some(a) => expression_to_source_sql_with_clear(a, registry, group_by)?,
                None => "NULL".to_string(),
            };
            Ok(format!(
                "CASE WHEN {d} = 0 THEN {alt} ELSE CAST({n} AS DOUBLE PRECISION) / {d} END"
            ))
        }
        Expression::ClearExcept {
            expr: inner,
            table,
            except_columns,
        } => {
            // ClearExcept: keep only the listed columns from the specified table.
            let inner_sql = expression_to_source_sql_with_clear(inner, registry, group_by)?;

            // PARTITION BY: group_by columns that are either:
            // - NOT from the cleared table, OR
            // - In the except_columns list
            let partition_cols: Vec<String> = group_by
                .iter()
                .filter(|col_ref| {
                    if col_ref.table != *table {
                        true // different table — keep
                    } else {
                        except_columns.contains(&col_ref.column)
                    }
                })
                .map(|col_ref| {
                    registry.binding_for(&col_ref.table).map(|b| {
                        format!(
                            "{}.{}",
                            quote_ident_double(&b.table),
                            quote_ident_double(&col_ref.column)
                        )
                    })
                })
                .collect::<QueryResult<Vec<_>>>()?;

            let over_clause = if partition_cols.is_empty() {
                "OVER ()".to_string()
            } else {
                format!("OVER (PARTITION BY {})", partition_cols.join(", "))
            };

            Ok(format!("SUM({inner_sql}) {over_clause}"))
        }
        Expression::BinaryOp { left, op, right } => {
            let l = expression_to_source_sql_with_clear(left, registry, group_by)?;
            let r = expression_to_source_sql_with_clear(right, registry, group_by)?;
            Ok(format!("({l} {} {r})", op.as_sql()))
        }
        Expression::If {
            condition,
            then_expr,
            else_expr,
        } => {
            let c = expression_to_source_sql_with_clear(condition, registry, group_by)?;
            let t = expression_to_source_sql_with_clear(then_expr, registry, group_by)?;
            let e = expression_to_source_sql_with_clear(else_expr, registry, group_by)?;
            Ok(format!("CASE WHEN {c} THEN {t} ELSE {e} END"))
        }
        Expression::Coalesce(exprs) => {
            let parts: Vec<String> = exprs
                .iter()
                .map(|e| expression_to_source_sql_with_clear(e, registry, group_by))
                .collect::<QueryResult<Vec<_>>>()?;
            Ok(format!("COALESCE({})", parts.join(", ")))
        }
        Expression::Block { .. } => {
            let inlined = expr.inline_bindings();
            expression_to_source_sql_with_clear(&inlined, registry, group_by)
        }
        // For non-CLEAR expressions, delegate to the standard function.
        _ => expression_to_source_sql(expr, registry),
    }
}

/// Build a SQL query with JOINs for multi-table same-source pushdown.
///
/// Generates: SELECT dim.col, AGG(fact.col) AS alias, ...
///            FROM fact JOIN dim ON ... GROUP BY dim.col
pub(super) fn build_join_aggregation_request(
    measures: &[Measure],
    group_by: &[ColumnRef],
    filters: &[FilterCondition],
    all_tables: &[&str],
    model: &DataModel,
    registry: &SourceRegistry,
) -> QueryResult<engine_connectors::JoinAggregationRequest> {
    use engine_connectors::{JoinAggregationRequest, JoinClause, MeasureExpr, QualifiedColumn};

    let fact_table = measures[0].table();
    let fact_binding = registry.binding_for(fact_table)?;

    // Build table map: model name → source table name.
    let mut table_map: Vec<(String, String)> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for t in all_tables {
        if seen.insert(*t) {
            let binding = registry.binding_for(t)?;
            table_map.push((t.to_string(), binding.table.clone()));
        }
    }

    // Build group_by as QualifiedColumn (using source table names).
    let qualified_group_by: Vec<QualifiedColumn> = group_by
        .iter()
        .map(|c| {
            let binding = registry.binding_for(&c.table)?;
            Ok(QualifiedColumn {
                table: binding.table.clone(),
                column: c.column.clone(),
            })
        })
        .collect::<QueryResult<Vec<_>>>()?;

    // Build measure expressions.
    let measure_exprs: Vec<MeasureExpr> = measures
        .iter()
        .map(|m| MeasureExpr {
            expression: m.expression().clone(),
            alias: m.name().to_string(),
        })
        .collect();

    // Build JOINs.
    let mut joins: Vec<JoinClause> = Vec::new();
    let mut joined = std::collections::HashSet::new();
    joined.insert(fact_table.to_string());

    for t in all_tables {
        if *t == fact_table || joined.contains(*t) {
            continue;
        }
        let rel = model.find_relationship(fact_table, t).map_err(|_| {
            QueryError::InvalidQuery(format!("No relationship between '{fact_table}' and '{t}'"))
        })?;
        let dim_binding = registry.binding_for(t)?;
        let (fact_col, dim_col) = if rel.from_table() == fact_table {
            (rel.from_column().to_string(), rel.to_column().to_string())
        } else {
            (rel.to_column().to_string(), rel.from_column().to_string())
        };
        joins.push(JoinClause {
            dim_schema: dim_binding.schema.clone(),
            dim_table: dim_binding.table.clone(),
            fact_column: fact_col,
            dim_column: dim_col,
        });
        joined.insert(t.to_string());
    }

    Ok(JoinAggregationRequest {
        fact_schema: fact_binding.schema.clone(),
        fact_table: fact_binding.table.clone(),
        joins,
        measures: measure_exprs,
        group_by: qualified_group_by,
        filters: filters.to_vec(),
        table_map,
    })
}

#[cfg(test)]
mod tests {
    use super::super::test_util::mock_registry_star;
    use super::*;
    use engine_core::compute::expression::{ComparisonOp, FilterPredicate};

    #[test]
    fn keep_filter_value_injection_is_escaped_in_source_sql() {
        use engine_core::compute::aggregate::AggregateOp;

        let registry = mock_registry_star(0);

        let expr = Expression::Aggregate {
            operation: AggregateOp::Sum,
            operand: Box::new(Expression::Keep {
                expr: Box::new(Expression::ColumnRef("amount".into())),
                filters: vec![FilterPredicate::new(
                    "Products",
                    "category",
                    ComparisonOp::Equal,
                    "x'); DROP TABLE t; --",
                )],
                variables: vec![],
                conditions: vec![],
                in_predicates: vec![],
            }),
        };

        let sql = expression_to_source_sql(&expr, &registry).unwrap();
        // The embedded quote is doubled so the literal cannot terminate early.
        assert!(sql.contains("'x''); DROP TABLE t; --'"), "{sql}");
        assert!(!sql.contains("= 'x');"), "{sql}");
    }

    #[test]
    fn complex_expression_pinned_source_sql() {
        // Equivalence oracle for the unified renderer migration: KEEP + IF +
        // SAFE DIVIDE + aggregates + literals with embedded quotes, rendered
        // with registry-qualified column references. Pinned from the
        // pre-unification implementation — must never change.
        use engine_core::compute::aggregate::AggregateOp;
        use engine_core::compute::expression::{
            agg, col, compare, if_expr, keep, lit_int, lit_str, safe_divide,
        };

        let registry = mock_registry_star(0);

        let expr = if_expr(
            compare(
                agg(
                    AggregateOp::Sum,
                    keep(
                        col("amount"),
                        vec![FilterPredicate::new(
                            "Products",
                            "category",
                            ComparisonOp::Equal,
                            "O'Brien",
                        )],
                    ),
                ),
                ComparisonOp::GreaterThan,
                lit_int(1000),
            ),
            lit_str("it's high"),
            safe_divide(
                agg(AggregateOp::Sum, col("amount")),
                agg(AggregateOp::Count, col("id")),
                None,
            ),
        );

        let sql = expression_to_source_sql(&expr, &registry).unwrap();
        assert_eq!(
            sql,
            "CASE WHEN (SUM(CASE WHEN \"product\".\"category\" = 'O''Brien' \
             THEN \"amount\" END) > 1000) THEN 'it''s high' \
             ELSE CASE WHEN COUNT(\"id\") = 0 THEN NULL \
             ELSE CAST(SUM(\"amount\") AS DOUBLE PRECISION) / COUNT(\"id\") END END"
        );
    }

    #[test]
    fn identifier_with_embedded_quote_is_escaped_in_source_sql() {
        let registry = mock_registry_star(0);

        let expr = Expression::ColumnRef("evil\"name".into());
        let sql = expression_to_source_sql(&expr, &registry).unwrap();
        assert_eq!(sql, "\"evil\"\"name\"");
    }

    #[test]
    fn percentile_is_forced_local_even_with_simple_operands() {
        // Regression: a bare Percentile over plain columns must be reported as
        // unpushable so it is always computed via the local DataFusion
        // approximate form. If it were pushable, a single-Postgres-source query
        // would return the exact `PERCENTILE_CONT` while any local-forcing
        // topology (cross-source join, in-memory table) would return the
        // approximation — the same measure silently changing value. Force local.
        use engine_core::compute::expression::{col, lit, percentile};

        let expr = percentile(col("latency"), lit(0.95));
        assert!(
            has_unpushable_ops(&expr),
            "Percentile must be unpushable (forced local) to avoid exact/approx \
             divergence across query topologies"
        );

        // Also unpushable when nested inside a compound measure, so the whole
        // measure runs locally rather than pushing the Postgres-exact form.
        use engine_core::compute::expression::lit_int;
        let compound = percentile(col("latency"), lit(0.95)).multiply(lit_int(2));
        assert!(has_unpushable_ops(&compound));
    }
}
