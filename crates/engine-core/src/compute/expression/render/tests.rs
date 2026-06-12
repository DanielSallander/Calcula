//! Tests for the unified SQL renderer: dialect divergence pins, qualifier
//! behavior, and KEEP-as-CASE-WHEN rendering.

use crate::compute::aggregate::AggregateOp;
use crate::compute::expression::{
    agg, call, col, compare, if_expr, keep, lit, lit_int, lit_str, percentile, qualified_col,
    safe_divide, scalar_fn, ComparisonOp, FilterPredicate, ScalarFunction,
};
use crate::error::EngineError;

use super::*;

/// The representative complex expression used across the equivalence tests:
/// KEEP + IF + arithmetic + aggregate + literals with embedded quotes.
fn complex_expression() -> Expression {
    if_expr(
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
        agg(AggregateOp::Sum, col("amount")).multiply(lit(0.5)),
    )
}

#[test]
fn datafusion_bare_matches_to_sql_string_on_complex_expression() {
    // Old-vs-new equivalence: the unified renderer configured like
    // to_sql_string must produce byte-identical SQL.
    let expr = complex_expression();
    let unified = SqlRenderer::new(SqlDialect::DataFusion, &BareQualifier)
        .render(&expr)
        .unwrap();
    assert_eq!(unified, expr.to_sql_string().unwrap());
    assert_eq!(
        unified,
        "CASE WHEN (SUM(\"amount\") > 1000) THEN 'it''s high' \
         ELSE (SUM(\"amount\") * 0.5) END"
    );
}

#[test]
fn case_when_mode_matches_to_case_when_sql_on_complex_expression() {
    // Old-vs-new equivalence for the conditional-aggregation mode.
    let expr = complex_expression();
    let condition = "products.\"category\" = 'O''Brien'";
    let unified = SqlRenderer::new(SqlDialect::DataFusion, &BareQualifier)
        .render_case_when(&expr, condition, "fact_sales")
        .unwrap();
    assert_eq!(
        unified,
        expr.to_case_when_sql(condition, "fact_sales").unwrap()
    );
}

#[test]
fn dialect_divergence_safe_divide_pinned() {
    // Same expression, both dialects, both pinned: cast target and
    // parenthesization differ.
    let expr = safe_divide(
        agg(AggregateOp::Sum, col("a")),
        agg(AggregateOp::Count, col("b")),
        Some(lit_int(0)),
    );
    assert_eq!(
        SqlRenderer::new(SqlDialect::DataFusion, &BareQualifier)
            .render(&expr)
            .unwrap(),
        "CASE WHEN COUNT(\"b\") = 0 THEN 0 ELSE (CAST(SUM(\"a\") AS DOUBLE) / COUNT(\"b\")) END"
    );
    assert_eq!(
        SqlRenderer::new(SqlDialect::Postgres, &BareQualifier)
            .render(&expr)
            .unwrap(),
        "CASE WHEN COUNT(\"b\") = 0 THEN 0 \
         ELSE CAST(SUM(\"a\") AS DOUBLE PRECISION) / COUNT(\"b\") END"
    );
}

#[test]
fn dialect_divergence_round_pinned() {
    let expr = scalar_fn(ScalarFunction::Round, vec![col("x"), lit_int(2)]);
    assert_eq!(
        SqlRenderer::new(SqlDialect::DataFusion, &BareQualifier)
            .render(&expr)
            .unwrap(),
        "ROUND(\"x\", 2)"
    );
    assert_eq!(
        SqlRenderer::new(SqlDialect::Postgres, &BareQualifier)
            .render(&expr)
            .unwrap(),
        "ROUND((\"x\")::NUMERIC, 2)"
    );
}

#[test]
fn dialect_divergence_percentile_pinned() {
    let expr = percentile(col("x"), lit(0.95));
    assert_eq!(
        SqlRenderer::new(SqlDialect::DataFusion, &BareQualifier)
            .render(&expr)
            .unwrap(),
        "approx_percentile_cont(\"x\", 0.95)"
    );
    assert_eq!(
        SqlRenderer::new(SqlDialect::Postgres, &BareQualifier)
            .render(&expr)
            .unwrap(),
        "PERCENTILE_CONT(0.95) WITHIN GROUP (ORDER BY \"x\")"
    );
}

#[test]
fn keep_case_when_mode_renders_condition_with_qualifier() {
    // The pushdown configuration: KEEP inside the aggregate operand becomes
    // conditional aggregation, with the filter column qualified.
    let expr = agg(
        AggregateOp::Sum,
        keep(
            col("amount"),
            vec![FilterPredicate::new(
                "Products",
                "category",
                ComparisonOp::Equal,
                "Bikes",
            )],
        ),
    );
    let qualifier = TableAliasQualifier { alias: "t" };
    let sql = SqlRenderer::new(SqlDialect::Postgres, &qualifier)
        .with_keep_case_when()
        .render(&expr)
        .unwrap();
    assert_eq!(
        sql,
        "SUM(CASE WHEN t.\"category\" = 'Bikes' THEN t.\"amount\" END)"
    );
}

#[test]
fn keep_pass_through_mode_ignores_filters() {
    let expr = agg(
        AggregateOp::Sum,
        keep(
            col("amount"),
            vec![FilterPredicate::new(
                "Products",
                "category",
                ComparisonOp::Equal,
                "Bikes",
            )],
        ),
    );
    let sql = SqlRenderer::new(SqlDialect::DataFusion, &BareQualifier)
        .render(&expr)
        .unwrap();
    assert_eq!(sql, "SUM(\"amount\")");
}

#[test]
fn lowercase_table_qualifier_qualifies_only_qualified_refs() {
    let qualifier = LowercaseTableQualifier;
    let qualified = qualified_col("Products", "category");
    let bare = col("category");
    let renderer = SqlRenderer::new(SqlDialect::DataFusion, &qualifier);
    assert_eq!(
        renderer.render(&qualified).unwrap(),
        "products.\"category\""
    );
    assert_eq!(renderer.render(&bare).unwrap(), "\"category\"");
}

#[test]
fn table_alias_qualifier_overrides_existing_qualification() {
    let qualifier = TableAliasQualifier { alias: "dim" };
    let renderer = SqlRenderer::new(SqlDialect::DataFusion, &qualifier);
    assert_eq!(
        renderer.render(&qualified_col("Whatever", "name")).unwrap(),
        "dim.\"name\""
    );
    assert_eq!(renderer.render(&col("name")).unwrap(), "dim.\"name\"");
}

#[test]
fn countrows_keep_pushdown_preserves_legacy_count_star() {
    // Legacy PostgreSQL pushdown rendered COUNTROWS with a KEEP operand as a
    // plain COUNT(*) (the filter does not travel) — preserved byte-for-byte.
    let expr = Expression::Aggregate {
        operation: AggregateOp::CountRows,
        operand: Box::new(keep(
            Expression::TableRef("fact_sales".into()),
            vec![FilterPredicate::new(
                "Products",
                "category",
                ComparisonOp::Equal,
                "Bikes",
            )],
        )),
    };
    let sql = SqlRenderer::new(SqlDialect::Postgres, &BareQualifier)
        .with_keep_case_when()
        .render(&expr)
        .unwrap();
    assert_eq!(sql, "COUNT(*)");
}

// --- UDF Call rendering ---

#[test]
fn call_renders_lowercased_in_datafusion_dialect() {
    // The name is lowercased to match DataFusion's normalization of
    // unquoted SQL function identifiers.
    let expr = agg(AggregateOp::Sum, call("Double", vec![col("amount")]));
    let sql = SqlRenderer::new(SqlDialect::DataFusion, &BareQualifier)
        .render(&expr)
        .unwrap();
    assert_eq!(sql, "SUM(double(\"amount\"))");
}

#[test]
fn call_renders_multiple_args_in_datafusion_dialect() {
    let expr = call("pct_of", vec![col("part"), col("whole"), lit_int(2)]);
    let sql = SqlRenderer::new(SqlDialect::DataFusion, &BareQualifier)
        .render(&expr)
        .unwrap();
    assert_eq!(sql, "pct_of(\"part\", \"whole\", 2)");
}

#[test]
fn call_zero_args_renders_empty_parens() {
    let expr = call("my_constant", vec![]);
    let sql = SqlRenderer::new(SqlDialect::DataFusion, &BareQualifier)
        .render(&expr)
        .unwrap();
    assert_eq!(sql, "my_constant()");
}

#[test]
fn call_errors_in_postgres_dialect() {
    // UDFs never push down — the Postgres dialect fails closed.
    let expr = agg(AggregateOp::Sum, call("double", vec![col("amount")]));
    let err = SqlRenderer::new(SqlDialect::Postgres, &BareQualifier)
        .with_keep_case_when()
        .render(&expr)
        .unwrap_err();
    assert!(matches!(err, EngineError::InvalidExpression(_)));
    assert!(err.to_string().contains("double"), "got: {err}");
}

#[test]
fn call_with_hostile_name_fails_closed_at_render_time() {
    // Even if Expression::validate was bypassed (hand-built tree), the
    // renderer must reject an injection-shaped name.
    let expr = call("f(); DROP TABLE x; --", vec![col("amount")]);
    let err = SqlRenderer::new(SqlDialect::DataFusion, &BareQualifier)
        .render(&expr)
        .unwrap_err();
    assert!(matches!(err, EngineError::InvalidIdentifier { .. }));
}

#[test]
fn call_case_when_mode_wraps_aggregates_inside_args() {
    // SUM with KEEP over a call operand: the CASE WHEN wraps the aggregate
    // operand, and the call's column args are fact-table qualified.
    let expr = agg(AggregateOp::Sum, call("double", vec![col("amount")]));
    let sql = SqlRenderer::new(SqlDialect::DataFusion, &BareQualifier)
        .render_case_when(&expr, "products.\"category\" = 'Bikes'", "fact_sales")
        .unwrap();
    assert_eq!(
        sql,
        "SUM(CASE WHEN products.\"category\" = 'Bikes' \
         THEN double(fact_sales.\"amount\") END)"
    );
}
