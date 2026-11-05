//! Tests for the unified SQL renderer: dialect divergence pins, qualifier
//! behavior, and KEEP-as-CASE-WHEN rendering.

use crate::compute::aggregate::AggregateOp;
use crate::compute::expression::{
    agg, blank, call, clear, col, compare, count_rows, has_one_value, if_expr, keep,
    keep_conditions, lit, lit_int, lit_str, percentile, qualified_col, safe_divide, scalar_fn,
    selected_value, ComparisonOp, FilterPredicate, ScalarFunction,
};
use crate::error::{EngineError, EngineResult};

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
    let unified = SqlRenderer::new(DataFusionDialect, &BareQualifier)
        .render(&expr)
        .unwrap();
    assert_eq!(unified, expr.to_sql_string().unwrap());
    assert_eq!(
        unified,
        "CASE WHEN COALESCE((COALESCE(SUM(\"amount\"), 0) > 1000), FALSE) THEN 'it''s high' \
         ELSE (SUM(\"amount\") * 0.5) END"
    );
}

#[test]
fn case_when_mode_matches_to_case_when_sql_on_complex_expression() {
    // Old-vs-new equivalence for the conditional-aggregation mode.
    let expr = complex_expression();
    let condition = "products.\"category\" = 'O''Brien'";
    let unified = SqlRenderer::new(DataFusionDialect, &BareQualifier)
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
        SqlRenderer::new(DataFusionDialect, &BareQualifier)
            .render(&expr)
            .unwrap(),
        "CASE WHEN SUM(\"a\") IS NULL THEN NULL WHEN COALESCE(NULLIF(COUNT(\"b\"), 0), 0) = 0 THEN 0 ELSE (CAST(SUM(\"a\") AS DOUBLE) / NULLIF(COUNT(\"b\"), 0)) END"
    );
    assert_eq!(
        SqlRenderer::new(PostgresDialect, &BareQualifier)
            .render(&expr)
            .unwrap(),
        "CASE WHEN SUM(\"a\") IS NULL THEN NULL WHEN COALESCE(NULLIF(COUNT(\"b\"), 0), 0) = 0 THEN 0 \
         ELSE (CAST(SUM(\"a\") AS DOUBLE PRECISION) / NULLIF(COUNT(\"b\"), 0)) END"
    );
}

#[test]
fn relational_semantics_keep_sql_arithmetic_and_counts() {
    // Round C: a table transformation is Power Query, not DAX -- `null + 5`
    // is `null` and a count of nothing is 0 -- so its renderer keeps the plain
    // operators, while the DAX default reads BLANK as 0 in `+`.
    let expr = agg(AggregateOp::Count, col("a")).add(col("b"));
    assert_eq!(
        SqlRenderer::new(DataFusionDialect, &BareQualifier)
            .with_relational_semantics()
            .render(&expr)
            .unwrap(),
        "(COUNT(\"a\") + \"b\")"
    );
    assert_eq!(
        SqlRenderer::new(DataFusionDialect, &BareQualifier)
            .render(&expr)
            .unwrap(),
        "CASE WHEN NULLIF(COUNT(\"a\"), 0) IS NULL AND \"b\" IS NULL THEN NULL \
         ELSE (COALESCE(NULLIF(COUNT(\"a\"), 0), 0) + COALESCE(\"b\", 0)) END"
    );
}

#[test]
fn dialect_divergence_round_pinned() {
    let expr = scalar_fn(ScalarFunction::Round, vec![col("x"), lit_int(2)]);
    assert_eq!(
        SqlRenderer::new(DataFusionDialect, &BareQualifier)
            .render(&expr)
            .unwrap(),
        "ROUND(\"x\", 2)"
    );
    assert_eq!(
        SqlRenderer::new(PostgresDialect, &BareQualifier)
            .render(&expr)
            .unwrap(),
        "ROUND((\"x\")::NUMERIC, 2)"
    );
}

#[test]
fn dialect_percentile_render_forms_pinned() {
    // The two dialects render Percentile differently — DataFusion has only an
    // APPROXIMATE percentile, Postgres an EXACT ordered-set aggregate. This
    // render-layer divergence is intentional and pinned here, but it is NOT
    // observable at runtime: the pushdown planner forces every Percentile to
    // local execution (`has_unpushable_ops(Percentile) == true`), so a measure
    // is always evaluated via the DataFusion approximate form regardless of
    // whether its source is Postgres. That is what keeps the result from
    // silently changing with query topology. If a future change makes Percentile
    // pushable again, this divergence would become a silently-wrong number — so
    // keep the forced-local gate and this comment in lockstep.
    let expr = percentile(col("x"), lit(0.95));
    assert_eq!(
        SqlRenderer::new(DataFusionDialect, &BareQualifier)
            .render(&expr)
            .unwrap(),
        "approx_percentile_cont(\"x\", 0.95)"
    );
    assert_eq!(
        SqlRenderer::new(PostgresDialect, &BareQualifier)
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
    let sql = SqlRenderer::new(PostgresDialect, &qualifier)
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
    let sql = SqlRenderer::new(DataFusionDialect, &BareQualifier)
        .render(&expr)
        .unwrap();
    assert_eq!(sql, "SUM(\"amount\")");
}

#[test]
fn lowercase_table_qualifier_qualifies_only_qualified_refs() {
    let qualifier = LowercaseTableQualifier;
    let qualified = qualified_col("Products", "category");
    let bare = col("category");
    let renderer = SqlRenderer::new(DataFusionDialect, &qualifier);
    assert_eq!(
        renderer.render(&qualified).unwrap(),
        "products.\"category\""
    );
    assert_eq!(renderer.render(&bare).unwrap(), "\"category\"");
}

#[test]
fn table_alias_qualifier_overrides_existing_qualification() {
    let qualifier = TableAliasQualifier { alias: "dim" };
    let renderer = SqlRenderer::new(DataFusionDialect, &qualifier);
    assert_eq!(
        renderer.render(&qualified_col("Whatever", "name")).unwrap(),
        "dim.\"name\""
    );
    assert_eq!(renderer.render(&col("name")).unwrap(), "dim.\"name\"");
}

#[test]
fn multi_table_qualifier_qualifies_each_ref_to_its_own_table() {
    // Qualified references go to their own lowercased table; bare references go
    // to the host (default) table. This is the context-driven calculated column
    // rendering used for cross-table references.
    let qualifier = MultiTableQualifier {
        default_table: "invoice",
    };
    let renderer = SqlRenderer::new(DataFusionDialect, &qualifier);
    // Host column (qualified with the host table) → host.
    assert_eq!(
        renderer
            .render(&qualified_col("Invoice", "paid_date"))
            .unwrap(),
        "invoice.\"paid_date\""
    );
    // Related table column → its own table.
    assert_eq!(
        renderer.render(&qualified_col("Customer", "tier")).unwrap(),
        "customer.\"tier\""
    );
    // Bare column → the default (host) table.
    assert_eq!(
        renderer.render(&col("paid_date")).unwrap(),
        "invoice.\"paid_date\""
    );
}

#[test]
fn multi_table_qualifier_renders_mixed_case_expression() {
    // A CASE referencing two tables renders each side to its own table.
    let qualifier = MultiTableQualifier {
        default_table: "invoice",
    };
    let expr = if_expr(
        compare(
            qualified_col("Invoice", "paid_date"),
            ComparisonOp::LessThanOrEqual,
            Expression::LiteralDate(19_813),
        ),
        qualified_col("Customer", "tier"),
        lit_str("Unpaid"),
    );
    let sql = SqlRenderer::new(DataFusionDialect, &qualifier)
        .render(&expr)
        .unwrap();
    assert_eq!(
        sql,
        "CASE WHEN COALESCE((invoice.\"paid_date\" <= CAST(19813 AS DATE)), FALSE) \
         THEN customer.\"tier\" ELSE 'Unpaid' END"
    );
}

#[test]
fn dialect_divergence_date_literal_pinned() {
    // A Date32 day count renders differently per dialect: DataFusion
    // reinterprets an integer cast as days-since-epoch, but PostgreSQL rejects
    // integer→date casts and needs an explicit `DATE '…'` literal. 19_813 days
    // since the Unix epoch is 2024-03-31.
    let expr = compare(
        qualified_col("Invoice", "paid_date"),
        ComparisonOp::LessThanOrEqual,
        Expression::LiteralDate(19_813),
    );
    let df = SqlRenderer::new(DataFusionDialect, &BareQualifier)
        .render(&expr)
        .unwrap();
    assert_eq!(df, "(\"paid_date\" <= CAST(19813 AS DATE))");
    let pg = SqlRenderer::new(PostgresDialect, &BareQualifier)
        .render(&expr)
        .unwrap();
    assert_eq!(pg, "(\"paid_date\" <= DATE '2024-03-31')");
}

fn bikes() -> Vec<FilterPredicate> {
    vec![FilterPredicate::new(
        "Products",
        "category",
        ComparisonOp::Equal,
        "Bikes",
    )]
}

fn pushdown(expr: &Expression) -> EngineResult<String> {
    SqlRenderer::new(PostgresDialect, &BareQualifier)
        .with_keep_case_when()
        .render(expr)
}

#[test]
fn countrows_keep_pushdown_renders_the_keep_condition() {
    // Open-ledger round D (NEW-countrows-keep-pushdown): the PostgreSQL
    // pushdown rendered COUNTROWS under a KEEP as a plain `COUNT(*)` -- the
    // filter did not travel, so a pushed filtered count counted EVERY row.
    // This test overrules the former pin
    // `countrows_keep_pushdown_preserves_legacy_count_star` DELIBERATELY.
    // DAX: COUNTROWS counts the rows the filter keeps, and "When the table
    // argument contains no rows, the function returns BLANK" (Microsoft) --
    // `SUM(CASE WHEN c THEN 1 END)` is NULL when no row matches.
    let counted = "SUM(CASE WHEN \"category\" = 'Bikes' THEN 1 END)";
    // `COUNTROWS(KEEP(t, ...))`: the KEEP is the aggregate's operand.
    let operand_keep = Expression::Aggregate {
        operation: AggregateOp::CountRows,
        operand: Box::new(keep(Expression::TableRef("fact_sales".into()), bikes())),
    };
    assert_eq!(pushdown(&operand_keep).unwrap(), counted);
    // `COUNTROWS(t, KEEP(...))`: the parser's shape, a KEEP over the count.
    let wrapping_keep = keep(
        Expression::Aggregate {
            operation: AggregateOp::CountRows,
            operand: Box::new(Expression::TableRef("fact_sales".into())),
        },
        bikes(),
    );
    assert_eq!(pushdown(&wrapping_keep).unwrap(), counted);
    let parsed = crate::compute::parser::parse_measure_expression(
        "COUNTROWS(Sales, KEEP(Products, Products[category] = \"Bikes\"))",
    )
    .unwrap();
    assert_eq!(pushdown(&parsed).unwrap(), counted);
    // In arithmetic too: COUNTROWS(t, KEEP) / COUNTROWS(t).
    let share = wrapping_keep.clone().divide(Expression::Aggregate {
        operation: AggregateOp::CountRows,
        operand: Box::new(Expression::TableRef("fact_sales".into())),
    });
    let sql = pushdown(&share).unwrap();
    assert!(sql.contains(counted), "{sql}");
    assert!(sql.contains("NULLIF(COUNT(*), 0)"), "{sql}");
}

#[test]
fn keep_pushdown_reaches_every_aggregate_beneath_it() {
    // The KEEP condition reached only an aggregate directly under it (and
    // through + - * / DIVIDE); under any other node -- a scalar function, IF,
    // COUNTIF, a nested KEEP -- the aggregates rendered UNFILTERED. A measure
    // reference expands to any expression, so `[Margin](KEEP(...))` is
    // exactly such a shape.
    let c = "\"category\" = 'Bikes'";
    let rounded = keep(
        scalar_fn(
            ScalarFunction::Round,
            vec![agg(AggregateOp::Sum, col("amount")), lit_int(2)],
        ),
        bikes(),
    );
    assert_eq!(
        pushdown(&rounded).unwrap(),
        format!("ROUND((SUM(CASE WHEN {c} THEN \"amount\" END))::NUMERIC, 2)")
    );
    let branch = keep(
        if_expr(
            compare(
                agg(AggregateOp::Sum, col("amount")),
                ComparisonOp::GreaterThan,
                lit_int(0),
            ),
            agg(AggregateOp::Max, col("amount")),
            lit_int(0),
        ),
        bikes(),
    );
    assert_eq!(
        pushdown(&branch).unwrap(),
        format!(
            "CASE WHEN (COALESCE(SUM(CASE WHEN {c} THEN \"amount\" END), 0) > 0) \
             THEN MAX(CASE WHEN {c} THEN \"amount\" END) ELSE 0 END"
        )
    );
    let count_if = keep(
        Expression::CountIf {
            condition: Box::new(compare(col("amount"), ComparisonOp::GreaterThan, lit_int(5))),
        },
        bikes(),
    );
    assert_eq!(
        pushdown(&count_if).unwrap(),
        format!(
            "SUM(CASE WHEN {c} THEN CASE WHEN (COALESCE(\"amount\", 0) > 5) THEN 1 ELSE 0 END END)"
        )
    );
    // A KEEP inside a KEEP (`SUM(x, KEEP(a), KEEP(b))`) keeps BOTH.
    let nested = keep(
        keep(
            agg(AggregateOp::Sum, col("amount")),
            vec![FilterPredicate::new(
                "Products",
                "colour",
                ComparisonOp::Equal,
                "Red",
            )],
        ),
        bikes(),
    );
    assert_eq!(
        pushdown(&nested).unwrap(),
        format!("SUM(CASE WHEN ({c}) AND (\"colour\" = 'Red') THEN \"amount\" END)")
    );
}

#[test]
fn keep_pushdown_refuses_what_it_cannot_carry() {
    // Rendering the inner expression of a context operation the pushed SQL
    // cannot express answered the UNFILTERED / UNCLEARED value. The planner
    // keeps such measures local; the renderer fails closed if one arrives.
    let over_clear = keep(
        clear(
            agg(AggregateOp::Sum, col("amount")),
            vec![crate::model::ClearTarget::Table("Products".into())],
        ),
        bikes(),
    );
    assert!(matches!(
        pushdown(&over_clear),
        Err(EngineError::InvalidExpression(_))
    ));
    let with_condition = keep_conditions(
        agg(AggregateOp::Sum, col("amount")),
        vec![compare(
            qualified_col("Products", "price"),
            ComparisonOp::GreaterThan,
            qualified_col("Products", "cost"),
        )],
    );
    assert!(matches!(
        pushdown(&with_condition),
        Err(EngineError::InvalidExpression(_))
    ));
    // The local renderer still passes context through (the ContextResolver
    // resolves it before local SQL generation).
    assert_eq!(
        SqlRenderer::new(DataFusionDialect, &BareQualifier)
            .render(&over_clear)
            .unwrap(),
        "SUM(\"amount\")"
    );
}

#[test]
fn distinctcount_counts_blank_as_a_value_and_distinctcountnoblank_does_not() {
    // NEW-distinctcount-blank: "The DISTINCTCOUNT function counts the BLANK
    // value. To skip the BLANK value, use the DISTINCTCOUNTNOBLANK function."
    // (Microsoft). SQL's COUNT(DISTINCT x) skips NULL.
    let dc = agg(AggregateOp::DistinctCount, col("x"));
    let expected = "NULLIF((COUNT(DISTINCT \"x\") + MAX(CASE WHEN (\"x\") IS NULL THEN 1 ELSE 0 END)), 0)";
    assert_eq!(dc.to_sql_string().unwrap(), expected);
    assert_eq!(
        SqlRenderer::new(PostgresDialect, &BareQualifier)
            .render(&dc)
            .unwrap(),
        expected
    );
    let nb = agg(AggregateOp::DistinctCountNoBlank, col("x"));
    assert_eq!(nb.to_sql_string().unwrap(), "NULLIF(COUNT(DISTINCT \"x\"), 0)");
    // A table transformation keeps SQL's count.
    assert_eq!(
        SqlRenderer::new(DataFusionDialect, &BareQualifier)
            .with_relational_semantics()
            .render(&dc)
            .unwrap(),
        "COUNT(DISTINCT \"x\")"
    );
    // Under a pushed KEEP only a KEPT row whose value is BLANK adds the
    // BLANK value (a row outside the KEEP renders NULL inside the CASE too).
    assert_eq!(
        pushdown(&keep(dc.clone(), bikes())).unwrap(),
        "NULLIF((COUNT(DISTINCT CASE WHEN \"category\" = 'Bikes' THEN \"x\" END) + \
         MAX(CASE WHEN \"category\" = 'Bikes' THEN CASE WHEN (\"x\") IS NULL THEN 1 ELSE 0 END \
         ELSE 0 END)), 0)"
    );
    // The local conditional mode the same way.
    assert_eq!(
        dc.to_case_when_sql("c = 1", "f").unwrap(),
        "NULLIF((COUNT(DISTINCT CASE WHEN COALESCE(c = 1, FALSE) THEN f.\"x\" END) + \
         MAX(CASE WHEN COALESCE(c = 1, FALSE) THEN CASE WHEN (f.\"x\") IS NULL THEN 1 ELSE 0 END ELSE 0 END)), 0)"
    );
}

/// Run one SQL scalar over the value-test table and return it as `f64`
/// (`None` is BLANK).
async fn scalar_over_fixture(sql: &str) -> Option<f64> {
    use arrow::array::{Array, Float64Array, StringArray};
    use arrow::datatypes::{DataType as ArrowType, Field, Schema};
    use arrow::record_batch::RecordBatch;
    use std::sync::Arc;

    // category / amount: Bikes 10, Bikes BLANK, Helmets 5, Helmets 10, Gloves 7.
    // (No BLANK category: DataFusion 44 answers `CASE WHEN c THEN col END`
    // with `col` when `c` is NULL -- its `case_column_or_null` fast path --
    // so a BLANK filter column would test DataFusion, not this renderer.)
    let batch = RecordBatch::try_new(
        Arc::new(Schema::new(vec![
            Field::new("category", ArrowType::Utf8, true),
            Field::new("amount", ArrowType::Float64, true),
        ])),
        vec![
            Arc::new(StringArray::from(vec![
                Some("Bikes"),
                Some("Bikes"),
                Some("Helmets"),
                Some("Helmets"),
                Some("Gloves"),
            ])),
            Arc::new(Float64Array::from(vec![
                Some(10.0),
                None,
                Some(5.0),
                Some(10.0),
                Some(7.0),
            ])),
        ],
    )
    .unwrap();
    let ctx = datafusion::prelude::SessionContext::new();
    ctx.register_batch("t", batch).unwrap();
    let batches = ctx
        .sql(&format!("SELECT {sql} AS v FROM t"))
        .await
        .unwrap_or_else(|e| panic!("{sql}: {e}"))
        .collect()
        .await
        .unwrap_or_else(|e| panic!("{sql}: {e}"));
    let column = batches[0].column(0);
    if column.is_null(0) {
        return None;
    }
    let as_f64 = arrow::compute::cast(column, &ArrowType::Float64).unwrap();
    Some(as_f64.as_any().downcast_ref::<Float64Array>().unwrap().value(0))
}

#[tokio::test]
async fn a_pushed_keep_answers_what_the_filter_answers() {
    // There is no live PostgreSQL here, so the pushed SQL SHAPE is executed
    // on DataFusion: the CASE-WHEN rendering is the same text in both
    // dialects for these aggregates (asserted below), and its value must
    // equal the same measure over the rows the KEEP filter keeps -- which is
    // how the local path resolves a KEEP (a WHERE on the scan).
    let measures = [
        // (measure, KEEP value, expected DAX answer)
        (count_rows(), "Bikes", Some(2.0)),
        (count_rows(), "Pads", None),
        (agg(AggregateOp::DistinctCount, col("amount")), "Bikes", Some(2.0)),
        (agg(AggregateOp::DistinctCount, col("amount")), "Helmets", Some(2.0)),
        (agg(AggregateOp::DistinctCountNoBlank, col("amount")), "Bikes", Some(1.0)),
        (agg(AggregateOp::Sum, col("amount")), "Helmets", Some(15.0)),
        (
            scalar_fn(
                ScalarFunction::Round,
                vec![agg(AggregateOp::Sum, col("amount")).divide(lit_int(4)), lit_int(1)],
            ),
            "Helmets",
            Some(3.8),
        ),
    ];
    for (measure, value, expected) in measures {
        let filter = vec![FilterPredicate::new(
            "t",
            "category",
            ComparisonOp::Equal,
            value,
        )];
        let pushed_expr = keep(measure.clone(), filter);
        let pushed_df = SqlRenderer::new(DataFusionDialect, &BareQualifier)
            .with_keep_case_when()
            .render(&pushed_expr)
            .unwrap();
        // ROUND is spelled `::NUMERIC` on PostgreSQL; every other measure here
        // is the same text in both dialects, but for DataFusion's
        // `COALESCE(condition, FALSE)` (see
        // `a_null_condition_takes_no_case_branch_on_datafusion`).
        if !matches!(measure, Expression::ScalarFunc { .. }) {
            let condition = format!("\"category\" = '{value}'");
            assert_eq!(
                pushdown(&pushed_expr).unwrap(),
                pushed_df.replace(&format!("COALESCE({condition}, FALSE)"), &condition),
                "{measure:?}"
            );
        }
        let pushed = scalar_over_fixture(&pushed_df).await;
        let local_sql = measure.to_sql_string().unwrap();
        let filtered = scalar_over_fixture(&format!(
            "(SELECT {local_sql} FROM t WHERE \"category\" = '{value}')"
        ))
        .await;
        assert_eq!(pushed, expected, "pushed {pushed_df}");
        assert_eq!(filtered, expected, "filtered {local_sql}");
    }
    // Unfiltered DISTINCTCOUNT over 10, BLANK, 5, 10, 7 is 4 (10, 5, 7 and
    // BLANK); DISTINCTCOUNTNOBLANK is 3.
    let dc = agg(AggregateOp::DistinctCount, col("amount"))
        .to_sql_string()
        .unwrap();
    assert_eq!(scalar_over_fixture(&dc).await, Some(4.0));
    let nb = agg(AggregateOp::DistinctCountNoBlank, col("amount"))
        .to_sql_string()
        .unwrap();
    assert_eq!(scalar_over_fixture(&nb).await, Some(3.0));
}

/// Run one SQL scalar over `category / amount / flag`: `(Bikes, 10, TRUE)`,
/// `(Bikes, BLANK, TRUE)`, `(BLANK, 7, BLANK)`; `None` is BLANK.
async fn scalar_over_blank_category(sql: &str) -> Option<f64> {
    use arrow::array::{Array, BooleanArray, Float64Array, StringArray};
    use arrow::datatypes::{DataType as ArrowType, Field, Schema};
    use arrow::record_batch::RecordBatch;
    use std::sync::Arc;

    let batch = RecordBatch::try_new(
        Arc::new(Schema::new(vec![
            Field::new("category", ArrowType::Utf8, true),
            Field::new("amount", ArrowType::Float64, true),
            Field::new("flag", ArrowType::Boolean, true),
        ])),
        vec![
            Arc::new(StringArray::from(vec![Some("Bikes"), Some("Bikes"), None])),
            Arc::new(Float64Array::from(vec![Some(10.0), None, Some(7.0)])),
            Arc::new(BooleanArray::from(vec![Some(true), Some(true), None])),
        ],
    )
    .unwrap();
    let ctx = datafusion::prelude::SessionContext::new();
    ctx.register_batch("t", batch).unwrap();
    let batches = ctx
        .sql(&format!("SELECT {sql} AS v FROM t"))
        .await
        .unwrap_or_else(|e| panic!("{sql}: {e}"))
        .collect()
        .await
        .unwrap_or_else(|e| panic!("{sql}: {e}"));
    let column = batches[0].column(0);
    if column.is_null(0) {
        return None;
    }
    let as_f64 = arrow::compute::cast(column, &ArrowType::Float64).unwrap();
    Some(as_f64.as_any().downcast_ref::<Float64Array>().unwrap().value(0))
}

#[tokio::test]
async fn a_null_condition_takes_no_case_branch_on_datafusion() {
    // NEW-datafusion-case-null. SQL takes a CASE branch only when its
    // condition is TRUE, and a BLANK never satisfies a DAX filter on a value.
    // DataFusion 44 does not, for `CASE WHEN c THEN col END`: its
    // `case_column_or_null` fast path is `nullif(col, not(c))`, which answers
    // `col` when `c` is NULL. This pins DataFusion's defect itself, so a
    // DataFusion upgrade that fixes it shows up here (the renderer's
    // `COALESCE(c, FALSE)` stays correct either way):
    let bikes_sql = "\"category\" = 'Bikes'";
    assert_eq!(
        scalar_over_blank_category(&format!("COUNT(CASE WHEN {bikes_sql} THEN \"amount\" END)"))
            .await,
        Some(2.0),
        "DataFusion counts the BLANK-category row as a Bikes row"
    );
    assert_eq!(
        scalar_over_blank_category(&format!("SUM(CASE WHEN {bikes_sql} THEN \"amount\" END)"))
            .await,
        Some(17.0)
    );

    // Every renderer of a DataFusion CASE answers what the filter answers:
    // Bikes' amounts are 10 and BLANK.
    let keep_bikes = |measure: Expression| {
        keep(
            measure,
            vec![FilterPredicate::new("t", "category", ComparisonOp::Equal, "Bikes")],
        )
    };
    let df_keep = |e: &Expression| {
        SqlRenderer::new(DataFusionDialect, &BareQualifier)
            .with_keep_case_when()
            .render(e)
            .unwrap()
    };
    let cases: Vec<(String, String, Option<f64>)> = vec![
        // `AggregateOp::render_case_when_sql` (the DataFusion dialect's
        // conditional aggregate, and the table transformations' Group By).
        (
            "render_case_when_sql COUNT".into(),
            AggregateOp::Count.render_case_when_sql(bikes_sql, "\"amount\""),
            Some(1.0),
        ),
        (
            "render_case_when_sql SUM".into(),
            AggregateOp::Sum.render_case_when_sql(bikes_sql, "\"amount\""),
            Some(10.0),
        ),
        // `Expression::to_case_when_sql` (the local pipeline's KEEP columns).
        (
            "to_case_when_sql COUNT".into(),
            agg(AggregateOp::Count, col("amount"))
                .to_case_when_sql(bikes_sql, "t")
                .unwrap(),
            Some(1.0),
        ),
        (
            "to_case_when_sql MIN".into(),
            agg(AggregateOp::Min, col("amount"))
                .to_case_when_sql(bikes_sql, "t")
                .unwrap(),
            Some(10.0),
        ),
        (
            "to_case_when_sql DISTINCTCOUNT".into(),
            agg(AggregateOp::DistinctCount, col("amount"))
                .to_case_when_sql(bikes_sql, "t")
                .unwrap(),
            Some(2.0),
        ),
        (
            "to_case_when_sql SELECTEDVALUE".into(),
            selected_value(col("amount"), None)
                .to_case_when_sql(bikes_sql, "t")
                .unwrap(),
            Some(10.0),
        ),
        // KEEP-as-CASE-WHEN in the DataFusion dialect: the aggregate arm, the
        // DISTINCTCOUNT BLANK flag and `keep_scoped`.
        (
            "KEEP scope SUM".into(),
            df_keep(&keep_bikes(agg(AggregateOp::Sum, col("amount")))),
            Some(10.0),
        ),
        (
            "KEEP scope DISTINCTCOUNT".into(),
            df_keep(&keep_bikes(agg(AggregateOp::DistinctCount, col("amount")))),
            Some(2.0),
        ),
        (
            "KEEP scope SELECTEDVALUE".into(),
            df_keep(&keep_bikes(selected_value(col("amount"), None))),
            Some(10.0),
        ),
        (
            "KEEP scope HASONEVALUE".into(),
            df_keep(&keep_bikes(if_expr(
                has_one_value(col("amount")),
                lit_int(1),
                lit_int(0),
            ))),
            Some(1.0),
        ),
        // A row-level IF with no ELSE (DAX's SUMX(t, IF(t[flag], t[amount]))):
        // a BLANK flag is not TRUE.
        (
            "IF without ELSE".into(),
            agg(AggregateOp::Sum, if_expr(col("flag"), col("amount"), blank()))
                .to_sql_string()
                .unwrap(),
            Some(10.0),
        ),
        // A number used as a condition is cast first (COALESCE would not
        // coerce a number and FALSE): 10 and 7 are TRUE, BLANK is not.
        (
            "IF over a number".into(),
            agg(
                AggregateOp::Sum,
                if_expr(col("amount"), lit_int(1), lit_int(0)),
            )
            .to_sql_string()
            .unwrap(),
            Some(2.0),
        ),
        (
            "COUNTIF".into(),
            Expression::CountIf {
                condition: Box::new(col("flag")),
            }
            .to_sql_string()
            .unwrap(),
            Some(2.0),
        ),
    ];
    for (route, sql, expected) in cases {
        assert_eq!(scalar_over_blank_category(&sql).await, expected, "{route}: {sql}");
    }

    // The source dialects keep the bare condition: PostgreSQL and SQL Server
    // evaluate CASE correctly.
    assert_eq!(
        pushdown(&keep(agg(AggregateOp::Sum, col("amount")), bikes())).unwrap(),
        "SUM(CASE WHEN \"category\" = 'Bikes' THEN \"amount\" END)"
    );
    assert_eq!(
        df_keep(&keep(agg(AggregateOp::Sum, col("amount")), bikes())),
        "SUM(CASE WHEN COALESCE(\"category\" = 'Bikes', FALSE) THEN \"amount\" END)"
    );
}

// --- UDF Call rendering ---

#[test]
fn call_renders_lowercased_in_datafusion_dialect() {
    // The name is lowercased to match DataFusion's normalization of
    // unquoted SQL function identifiers.
    let expr = agg(AggregateOp::Sum, call("Double", vec![col("amount")]));
    let sql = SqlRenderer::new(DataFusionDialect, &BareQualifier)
        .render(&expr)
        .unwrap();
    assert_eq!(sql, "SUM(double(\"amount\"))");
}

#[test]
fn call_renders_multiple_args_in_datafusion_dialect() {
    let expr = call("pct_of", vec![col("part"), col("whole"), lit_int(2)]);
    let sql = SqlRenderer::new(DataFusionDialect, &BareQualifier)
        .render(&expr)
        .unwrap();
    assert_eq!(sql, "pct_of(\"part\", \"whole\", 2)");
}

#[test]
fn call_zero_args_renders_empty_parens() {
    let expr = call("my_constant", vec![]);
    let sql = SqlRenderer::new(DataFusionDialect, &BareQualifier)
        .render(&expr)
        .unwrap();
    assert_eq!(sql, "my_constant()");
}

#[test]
fn call_errors_in_postgres_dialect() {
    // UDFs never push down — the Postgres dialect fails closed.
    let expr = agg(AggregateOp::Sum, call("double", vec![col("amount")]));
    let err = SqlRenderer::new(PostgresDialect, &BareQualifier)
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
    let err = SqlRenderer::new(DataFusionDialect, &BareQualifier)
        .render(&expr)
        .unwrap_err();
    assert!(matches!(err, EngineError::InvalidIdentifier { .. }));
}

#[test]
fn call_case_when_mode_wraps_aggregates_inside_args() {
    // SUM with KEEP over a call operand: the CASE WHEN wraps the aggregate
    // operand, and the call's column args are fact-table qualified.
    let expr = agg(AggregateOp::Sum, call("double", vec![col("amount")]));
    let sql = SqlRenderer::new(DataFusionDialect, &BareQualifier)
        .render_case_when(&expr, "products.\"category\" = 'Bikes'", "fact_sales")
        .unwrap();
    assert_eq!(
        sql,
        "SUM(CASE WHEN COALESCE(products.\"category\" = 'Bikes', FALSE) \
         THEN double(fact_sales.\"amount\") END)"
    );
}

#[test]
fn case_when_mode_reaches_the_aggregates_of_a_comparison() {
    // NEW-keep-in-if-condition (open-ledger round E): a measure-level
    // comparison, AND, SWITCH subject or IN subject fell back to PLAIN
    // rendering, so the aggregates in an IF condition were not filtered.
    let cond = "sales.\"cat\" = 'Bikes'";
    let when = "COALESCE(sales.\"cat\" = 'Bikes', FALSE)";
    let sum = |c: &str| agg(AggregateOp::Sum, col(c));
    let filtered = |c: &str| format!("SUM(CASE WHEN {when} THEN sales.\"{c}\" END)");
    let render = |e: &Expression| {
        SqlRenderer::new(DataFusionDialect, &BareQualifier)
            .render_case_when(e, cond, "sales")
            .unwrap()
    };
    let gt = compare(sum("amount"), ComparisonOp::GreaterThan, sum("qty"));
    assert_eq!(render(&gt), format!("({} > {})", filtered("amount"), filtered("qty")));
    let both = Expression::And(Box::new(gt.clone()), Box::new(gt.clone()));
    let sql = render(&both);
    assert_eq!(sql.matches(&filtered("amount")).count(), 2, "{sql}");
    let iff = if_expr(gt, sum("qty"), blank());
    let sql = render(&iff);
    assert!(sql.contains(&format!("({} > {})", filtered("amount"), filtered("qty"))), "{sql}");
    assert!(!sql.contains("SUM(\"amount\")"), "no unfiltered sum: {sql}");
    // A comparison against a literal keeps DAX's BLANK-as-0 there too.
    let vs_zero = compare(sum("amount"), ComparisonOp::GreaterThan, lit_int(0));
    assert_eq!(render(&vs_zero), format!("(COALESCE({}, 0) > 0)", filtered("amount")));
    let switch = Expression::Switch {
        expr: Box::new(sum("amount")),
        cases: vec![(lit_int(10), lit_str("ten"))],
        default: None,
    };
    let sql = render(&switch);
    assert!(sql.contains(&filtered("amount")), "{sql}");
}
