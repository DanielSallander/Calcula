//! Aggregate function call parsing (SUM, COUNT, COUNTROWS, COUNTIF, LISTAGG, ...).

use super::context::wrap_context_op;
use super::*;

impl Parser {
    /// Parse aggregate: `SUM(operand)` or `SUM(operand, context_op)`.
    pub(super) fn parse_aggregate_call(&mut self, func_upper: &str) -> EngineResult<Expression> {
        let op = match func_upper {
            "SUM" => AggregateOp::Sum,
            "COUNT" => AggregateOp::Count,
            "AVG" | "AVERAGE" => AggregateOp::Average,
            "MIN" => AggregateOp::Min,
            "MAX" => AggregateOp::Max,
            "DISTINCTCOUNT" => AggregateOp::DistinctCount,
            "MEDIAN" => AggregateOp::Median,
            "STDEV" => AggregateOp::StdevSample,
            "STDEVP" => AggregateOp::StdevPop,
            "VARIANCE" => AggregateOp::VarSample,
            "VARIANCEP" => AggregateOp::VarPop,
            "ANY_VALUE" => AggregateOp::AnyValue,
            "MODE" => AggregateOp::Mode,
            _ => unreachable!(),
        };

        // Parse the operand expression (could be `table[col]` or arithmetic like `table[a] * table[b]`).
        let operand = self.parse_expression()?;

        // Check for optional context arguments (variables and/or context ops).
        // Supports multiple comma-separated args:
        //   SUM(t[x], bikes)                     — bare variable name
        //   SUM(t[x], bikes, year_2024)           — multiple variables
        //   SUM(t[x], KEEP(dim, dim[y] = 2024))   — explicit context op
        //   SUM(t[x], bikes, KEEP(dim, dim[y] = 2024)) — mixed
        if self.peek() == Some(&Token::Comma) {
            let mut result = expr::agg(op, operand);
            while self.peek() == Some(&Token::Comma) {
                self.advance()?; // consume comma
                let arg_offset = self.offset_at(self.pos);
                let context_arg = self.parse_context_arg()?;
                result = wrap_context_op(result, context_arg, arg_offset)?;
            }
            self.expect(&Token::RParen)?;
            Ok(result)
        } else {
            self.expect(&Token::RParen)?;
            Ok(expr::agg(op, operand))
        }
    }

    /// Parse `COUNTROWS(table)`.
    pub(super) fn parse_countrows_call(&mut self) -> EngineResult<Expression> {
        // COUNTROWS takes a table name argument.
        let table = match self.advance()?.clone() {
            Token::Ident(s) => s,
            tok => {
                return Err(
                    self.parse_err_prev(format!("COUNTROWS: expected table name, got {tok:?}"))
                );
            }
        };

        // Check for optional context operation argument.
        if self.peek() == Some(&Token::Comma) {
            self.advance()?; // consume comma
            let arg_offset = self.offset_at(self.pos);
            let context_op = self.parse_atom()?;
            self.expect(&Token::RParen)?;
            let cr = Expression::Aggregate {
                operation: AggregateOp::CountRows,
                operand: Box::new(Expression::TableRef(table)),
            };
            Ok(wrap_context_op(cr, context_op, arg_offset)?)
        } else {
            self.expect(&Token::RParen)?;
            Ok(Expression::Aggregate {
                operation: AggregateOp::CountRows,
                operand: Box::new(Expression::TableRef(table)),
            })
        }
    }

    /// Parse `ITERATE(table, expression)`.
    pub(super) fn parse_iterate_call(&mut self) -> EngineResult<Expression> {
        let table = match self.advance()?.clone() {
            Token::Ident(s) => s,
            tok => {
                return Err(
                    self.parse_err_prev(format!("ITERATE: expected table name, got {tok:?}"))
                );
            }
        };
        self.expect(&Token::Comma)?;
        let expression = self.parse_expression()?;
        self.expect(&Token::RParen)?;
        Ok(expr::iterate(table, expression))
    }

    /// Parse `PERCENTILE(operand, k [, context_ops...])`.
    pub(super) fn parse_percentile_call(&mut self) -> EngineResult<Expression> {
        let operand = self.parse_expression()?;
        self.expect(&Token::Comma)?;
        let percentile = self.parse_expression()?;
        // Check for optional context arguments
        let mut result = expr::percentile(operand, percentile);
        while self.peek() == Some(&Token::Comma) {
            self.advance()?;
            let arg_offset = self.offset_at(self.pos);
            let context_arg = self.parse_context_arg()?;
            result = wrap_context_op(result, context_arg, arg_offset)?;
        }
        self.expect(&Token::RParen)?;
        Ok(result)
    }

    /// Parse `COUNTIF(condition)` or `COUNT_IF(condition)`.
    pub(super) fn parse_countif_call(&mut self) -> EngineResult<Expression> {
        let condition = self.parse_condition()?;
        // Check for optional context arguments
        let mut result = Expression::CountIf {
            condition: Box::new(condition),
        };
        while self.peek() == Some(&Token::Comma) {
            self.advance()?;
            let arg_offset = self.offset_at(self.pos);
            let context_arg = self.parse_context_arg()?;
            result = wrap_context_op(result, context_arg, arg_offset)?;
        }
        self.expect(&Token::RParen)?;
        Ok(result)
    }

    /// Parse `LISTAGG(column, delimiter)` or `STRING_AGG(column, delimiter)`.
    pub(super) fn parse_listagg_call(&mut self) -> EngineResult<Expression> {
        let column = self.parse_expression()?;
        self.expect(&Token::Comma)?;
        let delimiter = self.parse_expression()?;
        // Check for optional context arguments
        let mut result = Expression::ListAgg {
            column: Box::new(column),
            delimiter: Box::new(delimiter),
        };
        while self.peek() == Some(&Token::Comma) {
            self.advance()?;
            let arg_offset = self.offset_at(self.pos);
            let context_arg = self.parse_context_arg()?;
            result = wrap_context_op(result, context_arg, arg_offset)?;
        }
        self.expect(&Token::RParen)?;
        Ok(result)
    }

    /// Parse `MAX_BY(value, sort_by)`.
    pub(super) fn parse_maxby_call(&mut self) -> EngineResult<Expression> {
        let value = self.parse_expression()?;
        self.expect(&Token::Comma)?;
        let sort_by = self.parse_expression()?;
        // Check for optional context arguments
        let mut result = Expression::MaxBy {
            value: Box::new(value),
            sort_by: Box::new(sort_by),
        };
        while self.peek() == Some(&Token::Comma) {
            self.advance()?;
            let arg_offset = self.offset_at(self.pos);
            let context_arg = self.parse_context_arg()?;
            result = wrap_context_op(result, context_arg, arg_offset)?;
        }
        self.expect(&Token::RParen)?;
        Ok(result)
    }

    /// Parse `MIN_BY(value, sort_by)`.
    pub(super) fn parse_minby_call(&mut self) -> EngineResult<Expression> {
        let value = self.parse_expression()?;
        self.expect(&Token::Comma)?;
        let sort_by = self.parse_expression()?;
        // Check for optional context arguments
        let mut result = Expression::MinBy {
            value: Box::new(value),
            sort_by: Box::new(sort_by),
        };
        while self.peek() == Some(&Token::Comma) {
            self.advance()?;
            let arg_offset = self.offset_at(self.pos);
            let context_arg = self.parse_context_arg()?;
            result = wrap_context_op(result, context_arg, arg_offset)?;
        }
        self.expect(&Token::RParen)?;
        Ok(result)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_simple_sum() {
        let expr = parse_measure_expression("SUM(Sales[amount])").unwrap();
        assert!(expr.has_aggregate());
        assert_eq!(expr.to_sql_string().unwrap(), "SUM(\"amount\")");
    }

    #[test]
    fn parse_simple_count() {
        let expr = parse_measure_expression("COUNT(Sales[id])").unwrap();
        assert_eq!(expr.to_sql_string().unwrap(), "COUNT(\"id\")");
    }

    #[test]
    fn parse_distinctcount() {
        let expr = parse_measure_expression("DISTINCTCOUNT(Sales[product_id])").unwrap();
        assert_eq!(
            expr.to_sql_string().unwrap(),
            "COUNT(DISTINCT \"product_id\")"
        );
    }

    #[test]
    fn parse_avg() {
        let expr = parse_measure_expression("AVG(Sales[price])").unwrap();
        assert_eq!(expr.to_sql_string().unwrap(), "AVG(\"price\")");
    }

    #[test]
    fn parse_aggregate_over_arithmetic() {
        let expr = parse_measure_expression("SUM(Sales[price] * Sales[quantity])").unwrap();
        assert!(expr.has_aggregate());
    }

    #[tokio::test]
    async fn case_when_sql_with_arithmetic_in_aggregate() {
        use arrow::array::{Float64Array, Int32Array};
        use arrow::datatypes::{DataType, Field, Schema};
        use arrow::record_batch::RecordBatch;
        use datafusion::prelude::SessionContext;
        use std::sync::Arc;

        let input = "DIVIDE(SUM(fact_sales[unitprice] * fact_sales[orderqty]), SUM(fact_sales[orderqty]), 0)";
        let expr = parse_measure_expression(input).unwrap();

        let schema = Arc::new(Schema::new(vec![
            Field::new("unitprice", DataType::Float64, false),
            Field::new("orderqty", DataType::Float64, false),
            Field::new("categoryid", DataType::Int32, false),
        ]));
        let batch = RecordBatch::try_new(
            schema,
            vec![
                Arc::new(Float64Array::from(vec![10.0, 20.0, 30.0])),
                Arc::new(Float64Array::from(vec![1.0, 2.0, 3.0])),
                Arc::new(Int32Array::from(vec![1, 1, 2])),
            ],
        )
        .unwrap();

        let dim_schema = Arc::new(Schema::new(vec![
            Field::new("categoryid", DataType::Int32, false),
            Field::new("categoryname", DataType::Utf8, false),
        ]));
        let dim_batch = RecordBatch::try_new(
            dim_schema,
            vec![
                Arc::new(Int32Array::from(vec![1, 2])),
                Arc::new(arrow::array::StringArray::from(vec!["Bikes", "Parts"])),
            ],
        )
        .unwrap();

        let ctx = SessionContext::new();
        ctx.register_batch("fact_sales", batch).unwrap();
        ctx.register_batch("dim_category", dim_batch).unwrap();

        // to_case_when_sql must qualify columns inside arithmetic operands.
        let case_sql = expr
            .to_case_when_sql("dim_category.\"categoryname\" = 'Bikes'", "fact_sales")
            .unwrap();
        assert!(
            case_sql.contains("fact_sales.\"unitprice\" * fact_sales.\"orderqty\""),
            "columns inside arithmetic should be individually qualified, got: {case_sql}"
        );

        let sql = format!(
            "SELECT dim_category.\"categoryname\", {case_sql} AS result FROM fact_sales \
             JOIN dim_category ON fact_sales.\"categoryid\" = dim_category.\"categoryid\" \
             GROUP BY dim_category.\"categoryname\""
        );
        ctx.sql(&sql).await.unwrap().collect().await.unwrap();
    }

    #[test]
    fn parse_countrows() {
        let expr = parse_measure_expression("COUNTROWS(Sales)").unwrap();
        assert_eq!(expr.to_sql_string().unwrap(), "COUNT(*)");
        assert!(expr.has_aggregate());
        assert!(expr.is_simple_aggregate());
    }

    #[test]
    fn parse_countrows_infer_table() {
        let expr = parse_measure("COUNTROWS(fact_sales)").unwrap();
        assert_eq!(infer_fact_table(&expr), Some("fact_sales".to_string()));
    }

    #[test]
    fn parse_countrows_infer_from_table_ref() {
        // COUNTROWS uses TableRef — infer_fact_table should find it
        let expr = parse_measure_expression("COUNTROWS(fact_sales)").unwrap();
        if let Expression::Aggregate { operand, .. } = &expr {
            assert!(matches!(operand.as_ref(), Expression::TableRef(t) if t == "fact_sales"));
        } else {
            panic!("expected Aggregate");
        }
    }
}
