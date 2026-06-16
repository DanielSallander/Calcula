//! SQL string rendering for expressions.
//!
//! `to_sql_string` is a thin configuration wrapper over the unified
//! [`SqlRenderer`] (DataFusion dialect, unqualified column references). The
//! tests in this file are the pinned-SQL oracle for that configuration.

use super::*;

impl Expression {
    /// Render this expression as a SQL string fragment.
    ///
    /// Column names are double-quoted. Aggregate functions are rendered
    /// as `FUNC(operand)`. `DistinctCount` renders as `COUNT(DISTINCT operand)`.
    ///
    /// Delegates to [`SqlRenderer`] configured with [`SqlDialect::DataFusion`]
    /// and [`BareQualifier`].
    ///
    /// # Errors
    ///
    /// Returns [`EngineError::InvalidExpression`] when the expression contains
    /// nodes that cannot be rendered as scalar SQL:
    ///
    /// - [`Expression::MeasureRef`] — a measure reference must be expanded to
    ///   its underlying expression (by the parser/model) before SQL generation.
    /// - [`Expression::TableRef`] — a bare table reference is not a scalar
    ///   value. Table references are only valid where the surrounding
    ///   construct consumes them before rendering (e.g. `COUNTROWS(table)`,
    ///   context operations, fact-table inference).
    pub fn to_sql_string(&self) -> EngineResult<String> {
        SqlRenderer::new(SqlDialect::DataFusion, &BareQualifier).render(self)
    }

    /// Render this expression as a DataFusion SQL fragment, qualifying each
    /// column reference to the table it belongs to.
    ///
    /// A **bare** reference (`ColumnRef`) is qualified with `host_table` (the
    /// column's host table, supplied already lowercased); a **table-qualified**
    /// reference (`QualifiedColumnRef`) is qualified with its own lowercased
    /// table name. This is the rendering used to inject a context-driven
    /// calculated column's (literal-substituted) CASE expression into a
    /// `GROUP BY` over a joined query: the host table's columns and any
    /// fan-out-safe related table's columns are each qualified correctly, so the
    /// SQL is unambiguous. For a host-table-only column every reference resolves
    /// to `host_table`, identical to a single fixed-alias rendering.
    ///
    /// # Errors
    ///
    /// Same conditions as [`Expression::to_sql_string`]; in particular an
    /// unexpanded [`Expression::MeasureRef`] fails closed.
    pub fn to_qualified_sql(&self, host_table: &str) -> EngineResult<String> {
        SqlRenderer::new(
            SqlDialect::DataFusion,
            &MultiTableQualifier {
                default_table: host_table,
            },
        )
        .render(self)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn column_ref_sql() {
        let expr = col("amount");
        assert_eq!(expr.to_sql_string().unwrap(), "\"amount\"");
    }

    #[test]
    fn literal_sql() {
        assert_eq!(lit(3.25).to_sql_string().unwrap(), "3.25");
        assert_eq!(lit_int(42).to_sql_string().unwrap(), "42");
    }

    #[test]
    fn binary_op_sql() {
        let expr = col("price").multiply(col("quantity"));
        assert_eq!(expr.to_sql_string().unwrap(), "(\"price\" * \"quantity\")");
    }

    #[test]
    fn nested_binary_ops_sql() {
        // (revenue - cost) / quantity
        let expr = col("revenue").subtract(col("cost")).divide(col("quantity"));
        assert_eq!(
            expr.to_sql_string().unwrap(),
            "((\"revenue\" - \"cost\") / \"quantity\")"
        );
    }

    #[test]
    fn simple_aggregate_sql() {
        let expr = agg(AggregateOp::Sum, col("amount"));
        assert_eq!(expr.to_sql_string().unwrap(), "SUM(\"amount\")");
    }

    #[test]
    fn expression_aggregate_sql() {
        let expr = agg(AggregateOp::Sum, col("price").multiply(col("quantity")));
        assert_eq!(
            expr.to_sql_string().unwrap(),
            "SUM((\"price\" * \"quantity\"))"
        );
    }

    #[test]
    fn ratio_measure_sql() {
        let expr = agg(AggregateOp::Sum, col("amount")).divide(agg(AggregateOp::Count, col("id")));
        assert_eq!(
            expr.to_sql_string().unwrap(),
            "(SUM(\"amount\") / COUNT(\"id\"))"
        );
    }

    #[test]
    fn distinct_count_sql() {
        let expr = agg(AggregateOp::DistinctCount, col("product_id"));
        assert_eq!(
            expr.to_sql_string().unwrap(),
            "COUNT(DISTINCT \"product_id\")"
        );
    }

    #[test]
    fn keep_expression_sql_passes_through() {
        let expr = keep(
            col("amount"),
            vec![FilterPredicate::new(
                "Sales",
                "Region",
                ComparisonOp::Equal,
                "US",
            )],
        );
        // SQL rendering passes through to inner expression
        assert_eq!(expr.to_sql_string().unwrap(), "\"amount\"");
    }

    #[test]
    fn keep_with_aggregate_sql() {
        let expr = agg(
            AggregateOp::Sum,
            keep(
                col("amount"),
                vec![FilterPredicate::new(
                    "Calendar",
                    "Year",
                    ComparisonOp::Equal,
                    "2024",
                )],
            ),
        );
        assert_eq!(expr.to_sql_string().unwrap(), "SUM(\"amount\")");
    }

    #[test]
    fn clear_expression_sql_passes_through() {
        let expr = clear(
            col("amount"),
            vec![ClearTarget::Column {
                table: "Sales".into(),
                column: "Region".into(),
            }],
        );
        assert_eq!(expr.to_sql_string().unwrap(), "\"amount\"");
    }

    #[test]
    fn reset_expression_sql_passes_through() {
        let expr = reset(col("amount"));
        assert_eq!(expr.to_sql_string().unwrap(), "\"amount\"");
    }

    #[test]
    fn traverse_expression_sql_passes_through() {
        let expr = traverse(
            col("amount"),
            RelationshipPath::new(vec!["Sales", "Products"]),
        );
        assert_eq!(expr.to_sql_string().unwrap(), "\"amount\"");
    }

    #[test]
    fn using_expression_sql_passes_through() {
        let expr = using(col("amount"), "ctx_2024");
        assert_eq!(expr.to_sql_string().unwrap(), "\"amount\"");
    }

    #[test]
    fn block_expression_sql_inlines_bindings() {
        let expr = block(
            vec![
                ("actual".into(), agg(AggregateOp::Sum, col("amount"))),
                ("total".into(), agg(AggregateOp::Sum, col("amount"))),
            ],
            col("actual").divide(col("total")),
        );
        // Bindings are inlined: actual → SUM("amount"), total → SUM("amount")
        assert_eq!(
            expr.to_sql_string().unwrap(),
            "(SUM(\"amount\") / SUM(\"amount\"))"
        );
    }

    #[test]
    fn table_ref_to_sql_string_returns_error() {
        // A bare table reference is not a scalar value — rendering it used to
        // silently produce an empty string (malformed SQL); it is now an error.
        let expr = table_ref("premium");
        let err = expr.to_sql_string().unwrap_err();
        assert!(matches!(err, EngineError::InvalidExpression(_)));
        assert!(err.to_string().contains("premium"));
    }

    #[test]
    fn measure_ref_to_sql_string_returns_error_not_panic() {
        // Reachable via public APIs: parse_measure_expression("[Total] * 2")
        // then to_sql_string() — this used to panic and abort the host process.
        let expr = Expression::MeasureRef("Total Sales".to_string());
        let err = expr.to_sql_string().unwrap_err();
        assert!(matches!(err, EngineError::InvalidExpression(_)));
        assert!(err.to_string().contains("Total Sales"));
    }

    #[test]
    fn measure_ref_inside_compound_to_sql_string_returns_error() {
        let expr = Expression::MeasureRef("SomeMeasure".to_string()).multiply(lit_int(2));
        assert!(expr.to_sql_string().is_err());
    }

    #[test]
    fn qualified_column_ref_sql() {
        let expr = qualified_col("Products", "category");
        assert_eq!(expr.to_sql_string().unwrap(), "\"category\"");
    }

    #[test]
    fn keep_in_sql_passes_through() {
        let expr = keep_in(col("amount"), vec![InPredicate::new("S", "c", "v", "c2")]);
        assert_eq!(expr.to_sql_string().unwrap(), "\"amount\"");
    }

    #[test]
    fn literal_string_sql() {
        assert_eq!(lit_str("hello").to_sql_string().unwrap(), "'hello'");
        // Escaped single quotes
        assert_eq!(lit_str("it's").to_sql_string().unwrap(), "'it''s'");
    }

    #[test]
    fn blank_sql() {
        assert_eq!(blank().to_sql_string().unwrap(), "NULL");
    }

    #[test]
    fn is_blank_sql() {
        let expr = is_blank(col("amount"));
        assert_eq!(expr.to_sql_string().unwrap(), "(\"amount\" IS NULL)");
    }

    #[test]
    fn comparison_sql() {
        let expr = compare(col("amount"), ComparisonOp::GreaterThan, lit_int(100));
        assert_eq!(expr.to_sql_string().unwrap(), "(\"amount\" > 100)");
    }

    #[test]
    fn and_or_not_sql() {
        let a = compare(col("x"), ComparisonOp::GreaterThan, lit_int(0));
        let b = compare(col("y"), ComparisonOp::LessThan, lit_int(10));
        assert_eq!(
            and(a.clone(), b.clone()).to_sql_string().unwrap(),
            "((\"x\" > 0) AND (\"y\" < 10))"
        );
        assert_eq!(
            or(a.clone(), b.clone()).to_sql_string().unwrap(),
            "((\"x\" > 0) OR (\"y\" < 10))"
        );
        assert_eq!(not(a).to_sql_string().unwrap(), "(NOT (\"x\" > 0))");
    }

    #[test]
    fn if_expr_sql() {
        let expr = if_expr(
            compare(
                agg(AggregateOp::Sum, col("amount")),
                ComparisonOp::GreaterThan,
                lit_int(1000),
            ),
            lit_str("High"),
            lit_str("Low"),
        );
        assert_eq!(
            expr.to_sql_string().unwrap(),
            "CASE WHEN (SUM(\"amount\") > 1000) THEN 'High' ELSE 'Low' END"
        );
    }

    #[test]
    fn switch_sql() {
        let expr = switch(
            col("status"),
            vec![
                (lit_int(1), lit_str("Active")),
                (lit_int(2), lit_str("Inactive")),
            ],
            Some(lit_str("Unknown")),
        );
        assert_eq!(
            expr.to_sql_string().unwrap(),
            "CASE \"status\" WHEN 1 THEN 'Active' WHEN 2 THEN 'Inactive' ELSE 'Unknown' END"
        );
    }

    #[test]
    fn switch_without_default_sql() {
        let expr = switch(col("status"), vec![(lit_int(1), lit_str("Active"))], None);
        assert_eq!(
            expr.to_sql_string().unwrap(),
            "CASE \"status\" WHEN 1 THEN 'Active' END"
        );
    }

    #[test]
    fn safe_divide_sql() {
        let expr = safe_divide(
            agg(AggregateOp::Sum, col("revenue")),
            agg(AggregateOp::Count, col("orders")),
            None,
        );
        assert_eq!(
            expr.to_sql_string().unwrap(),
            "CASE WHEN COUNT(\"orders\") = 0 THEN NULL ELSE (CAST(SUM(\"revenue\") AS DOUBLE) / COUNT(\"orders\")) END"
        );
    }

    #[test]
    fn safe_divide_with_alternate_sql() {
        let expr = safe_divide(col("a"), col("b"), Some(lit_int(0)));
        assert_eq!(
            expr.to_sql_string().unwrap(),
            "CASE WHEN \"b\" = 0 THEN 0 ELSE (CAST(\"a\" AS DOUBLE) / \"b\") END"
        );
    }

    #[test]
    fn coalesce_sql() {
        let expr = coalesce(vec![col("a"), col("b"), lit_int(0)]);
        assert_eq!(expr.to_sql_string().unwrap(), "COALESCE(\"a\", \"b\", 0)");
    }

    #[test]
    fn count_rows_sql() {
        let expr = count_rows();
        assert_eq!(expr.to_sql_string().unwrap(), "COUNT(*)");
        assert!(expr.is_simple_aggregate());
    }

    #[test]
    fn has_one_value_sql() {
        let expr = has_one_value(col("region"));
        assert_eq!(
            expr.to_sql_string().unwrap(),
            "(COUNT(DISTINCT \"region\") = 1)"
        );
    }

    #[test]
    fn selected_value_sql_no_alternate() {
        let expr = selected_value(col("region"), None);
        assert_eq!(
            expr.to_sql_string().unwrap(),
            "CASE WHEN COUNT(DISTINCT \"region\") = 1 THEN MIN(\"region\") ELSE NULL END"
        );
    }

    #[test]
    fn selected_value_sql_with_alternate() {
        let expr = selected_value(col("region"), Some(lit_str("Multiple")));
        assert_eq!(
            expr.to_sql_string().unwrap(),
            "CASE WHEN COUNT(DISTINCT \"region\") = 1 THEN MIN(\"region\") ELSE 'Multiple' END"
        );
    }

    #[test]
    fn first_value_sql() {
        let expr = first_value(col("name"), col("sort_order"));
        assert_eq!(
            expr.to_sql_string().unwrap(),
            "FIRST_VALUE(\"name\" ORDER BY \"sort_order\")"
        );
    }

    #[test]
    fn literal_bool_sql() {
        assert_eq!(lit_bool(true).to_sql_string().unwrap(), "TRUE");
        assert_eq!(lit_bool(false).to_sql_string().unwrap(), "FALSE");
    }

    #[test]
    fn xor_sql() {
        let a = compare(col("x"), ComparisonOp::GreaterThan, lit_int(0));
        let b = compare(col("y"), ComparisonOp::LessThan, lit_int(10));
        assert_eq!(
            xor(a, b).to_sql_string().unwrap(),
            "(((\"x\" > 0) AND NOT (\"y\" < 10)) OR (NOT (\"x\" > 0) AND (\"y\" < 10)))"
        );
    }

    #[test]
    fn complex_expression_pinned_sql() {
        // Equivalence oracle for the unified renderer migration: KEEP + IF +
        // arithmetic + aggregate + literals with embedded quotes. Pinned from
        // the pre-unification implementation — must never change.
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
            agg(AggregateOp::Sum, col("amount")).multiply(lit(0.5)),
        );
        assert_eq!(
            expr.to_sql_string().unwrap(),
            "CASE WHEN (SUM(\"amount\") > 1000) THEN 'it''s high' \
             ELSE (SUM(\"amount\") * 0.5) END"
        );
    }

    #[test]
    fn window_to_sql_placeholder() {
        let w = window_expr(
            agg(AggregateOp::Sum, qualified_col("fact", "amount")),
            AggregateOp::Sum,
            vec![("dim_date".into(), "month".into())],
            vec![],
            None,
        );
        assert!(w.to_sql_string().unwrap().contains("WINDOW"));
    }
}
