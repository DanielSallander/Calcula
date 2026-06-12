//! CASE WHEN SQL rendering for conditional aggregation over a fact table.

use super::*;

impl Expression {
    /// Render this expression as SQL with the aggregate operand wrapped in CASE WHEN.
    ///
    /// Used when a measure has per-measure context filters (KEEP) that must be
    /// scoped to the aggregate rather than applied as a global WHERE clause.
    ///
    /// For `SUM(col)` with condition `dim_date."year" = 2014`, produces:
    /// `SUM(CASE WHEN dim_date."year" = 2014 THEN col END)`.
    ///
    /// The `fact_table` parameter is the lowercase fact table name used to
    /// qualify column references in the operand.
    ///
    /// # Errors
    ///
    /// Returns [`EngineError::InvalidExpression`] when the expression contains
    /// nodes that cannot be rendered as scalar SQL — see
    /// [`Expression::to_sql_string`] for the cases (`MeasureRef`, bare
    /// `TableRef`). `COUNTROWS` is exempt: its table-reference operand is
    /// consumed before rendering.
    pub fn to_case_when_sql(&self, condition: &str, fact_table: &str) -> EngineResult<String> {
        SqlRenderer::new(SqlDialect::DataFusion, &BareQualifier)
            .render_case_when(self, condition, fact_table)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn measure_ref_to_case_when_sql_returns_error_not_panic() {
        let expr = Expression::MeasureRef("Total Sales".to_string());
        assert!(expr
            .to_case_when_sql("dim.\"year\" = 2014", "fact")
            .is_err());
    }

    #[test]
    fn complex_expression_pinned_case_when_sql() {
        // Equivalence oracle for the unified renderer migration: KEEP + IF +
        // arithmetic + aggregate + literals with embedded quotes. Pinned from
        // the pre-unification implementation — must never change. Note the
        // legacy quirk this locks in: the IF condition's aggregate falls back
        // to plain rendering (no CASE WHEN wrap), while the ELSE branch's
        // aggregate is wrapped and fact-qualified.
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
            expr.to_case_when_sql("products.\"category\" = 'O''Brien'", "fact_sales")
                .unwrap(),
            "CASE WHEN (SUM(\"amount\") > 1000) THEN 'it''s high' \
             ELSE (SUM(CASE WHEN products.\"category\" = 'O''Brien' \
             THEN fact_sales.\"amount\" END) * 0.5) END"
        );
    }

    #[test]
    fn countrows_to_case_when_sql_skips_table_ref_operand() {
        // COUNTROWS carries a bare TableRef operand; to_case_when_sql must
        // consume it before rendering rather than returning an error.
        let expr = Expression::Aggregate {
            operation: AggregateOp::CountRows,
            operand: Box::new(table_ref("fact_sales")),
        };
        assert_eq!(
            expr.to_case_when_sql("dim.\"year\" = 2014", "fact_sales")
                .unwrap(),
            "SUM(CASE WHEN dim.\"year\" = 2014 THEN 1 END)"
        );
    }
}
