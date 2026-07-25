//! Logical and conditional function parsing (IF, SWITCH, DIVIDE, AND/OR/NOT, ...).

use super::*;

impl Parser {
    /// Parse `IF(condition, then_value, else_value)`.
    pub(super) fn parse_if_call(&mut self) -> EngineResult<Expression> {
        let condition = self.parse_comparison_expr()?;
        self.expect(&Token::Comma)?;
        let then_expr = self.parse_expression()?;
        self.expect(&Token::Comma)?;
        let else_expr = self.parse_expression()?;
        self.expect(&Token::RParen)?;
        Ok(expr::if_expr(condition, then_expr, else_expr))
    }

    /// Parse `SWITCH(expr, val1, result1, val2, result2, ..., [default])`.
    pub(super) fn parse_switch_call(&mut self) -> EngineResult<Expression> {
        let switch_expr = self.parse_expression()?;
        let mut cases = Vec::new();
        let mut default = None;

        while self.peek() == Some(&Token::Comma) {
            self.advance()?; // consume comma

            // Could be the next case value or the default.
            let val = self.parse_expression()?;

            if self.peek() == Some(&Token::Comma) {
                self.advance()?; // consume comma
                let result = self.parse_expression()?;
                cases.push((val, result));
            } else {
                // Last unpaired value is the default.
                default = Some(val);
            }
        }

        self.expect(&Token::RParen)?;
        Ok(expr::switch(switch_expr, cases, default))
    }

    /// Parse `DIVIDE(numerator, denominator [, alternate])`.
    pub(super) fn parse_divide_call(&mut self) -> EngineResult<Expression> {
        let numerator = self.parse_expression()?;
        self.expect(&Token::Comma)?;
        let denominator = self.parse_expression()?;

        let alternate = if self.peek() == Some(&Token::Comma) {
            self.advance()?;
            Some(self.parse_expression()?)
        } else {
            None
        };

        self.expect(&Token::RParen)?;
        Ok(expr::safe_divide(numerator, denominator, alternate))
    }

    /// Parse `BLANK()` — no arguments.
    pub(super) fn parse_blank_call(&mut self) -> EngineResult<Expression> {
        self.expect(&Token::RParen)?;
        Ok(Expression::Blank)
    }

    /// Parse `ISBLANK(expr)`.
    pub(super) fn parse_isblank_call(&mut self) -> EngineResult<Expression> {
        let inner = self.parse_expression()?;
        self.expect(&Token::RParen)?;
        Ok(expr::is_blank(inner))
    }

    /// Parse `COALESCE(expr1, expr2, ...)`.
    pub(super) fn parse_coalesce_call(&mut self) -> EngineResult<Expression> {
        let mut exprs = vec![self.parse_expression()?];
        while self.peek() == Some(&Token::Comma) {
            self.advance()?;
            exprs.push(self.parse_expression()?);
        }
        self.expect(&Token::RParen)?;
        Ok(expr::coalesce(exprs))
    }

    /// Parse `AND(left, right)` — function-call syntax for logical AND.
    pub(super) fn parse_and_call(&mut self) -> EngineResult<Expression> {
        let left = self.parse_comparison_expr()?;
        self.expect(&Token::Comma)?;
        let right = self.parse_comparison_expr()?;
        self.expect(&Token::RParen)?;
        Ok(expr::and(left, right))
    }

    /// Parse `OR(left, right)` — function-call syntax for logical OR.
    pub(super) fn parse_or_call(&mut self) -> EngineResult<Expression> {
        let left = self.parse_comparison_expr()?;
        self.expect(&Token::Comma)?;
        let right = self.parse_comparison_expr()?;
        self.expect(&Token::RParen)?;
        Ok(expr::or(left, right))
    }

    /// Parse `NOT(expr)` — function-call syntax for logical NOT.
    pub(super) fn parse_not_call(&mut self) -> EngineResult<Expression> {
        let inner = self.parse_comparison_expr()?;
        self.expect(&Token::RParen)?;
        Ok(expr::not(inner))
    }

    /// Parse `TRUE()` — boolean literal true.
    pub(super) fn parse_true_call(&mut self) -> EngineResult<Expression> {
        self.expect(&Token::RParen)?;
        Ok(expr::lit_bool(true))
    }

    /// Parse `FALSE()` — boolean literal false.
    pub(super) fn parse_false_call(&mut self) -> EngineResult<Expression> {
        self.expect(&Token::RParen)?;
        Ok(expr::lit_bool(false))
    }

    /// Parse `XOR(left, right)` — logical exclusive OR.
    pub(super) fn parse_xor_call(&mut self) -> EngineResult<Expression> {
        let left = self.parse_comparison_expr()?;
        self.expect(&Token::Comma)?;
        let right = self.parse_comparison_expr()?;
        self.expect(&Token::RParen)?;
        Ok(expr::xor(left, right))
    }

    /// Parse `IFERROR(expr, alternate)`.
    pub(super) fn parse_iferror_call(&mut self) -> EngineResult<Expression> {
        let inner = self.parse_expression()?;
        self.expect(&Token::Comma)?;
        let alternate = self.parse_expression()?;
        self.expect(&Token::RParen)?;
        Ok(expr::if_error(inner, alternate))
    }

    /// Parse `GREATEST(a, b, ...)` — at least 2 args.
    pub(super) fn parse_greatest_call(&mut self) -> EngineResult<Expression> {
        let mut args = vec![self.parse_expression()?];
        while self.peek() == Some(&Token::Comma) {
            self.advance()?;
            args.push(self.parse_expression()?);
        }
        if args.len() < 2 {
            return Err(self.parse_err("GREATEST: expected at least 2 arguments"));
        }
        self.expect(&Token::RParen)?;
        Ok(Expression::Greatest(args))
    }

    /// Parse `LEAST(a, b, ...)` — at least 2 args.
    pub(super) fn parse_least_call(&mut self) -> EngineResult<Expression> {
        let mut args = vec![self.parse_expression()?];
        while self.peek() == Some(&Token::Comma) {
            self.advance()?;
            args.push(self.parse_expression()?);
        }
        if args.len() < 2 {
            return Err(self.parse_err("LEAST: expected at least 2 arguments"));
        }
        self.expect(&Token::RParen)?;
        Ok(Expression::Least(args))
    }

    /// Parse `NULLIF(expr, value)`.
    pub(super) fn parse_nullif_call(&mut self) -> EngineResult<Expression> {
        let expr = self.parse_expression()?;
        self.expect(&Token::Comma)?;
        let value = self.parse_expression()?;
        self.expect(&Token::RParen)?;
        Ok(Expression::NullIf {
            expr: Box::new(expr),
            value: Box::new(value),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_if_simple() {
        let expr =
            parse_measure_expression(r#"IF(SUM(Sales[amount]) > 1000, "High", "Low")"#).unwrap();
        assert_eq!(
            expr.to_sql_string().unwrap(),
            "CASE WHEN (SUM(\"amount\") > 1000) THEN 'High' ELSE 'Low' END"
        );
        assert!(expr.has_aggregate());
    }

    #[test]
    fn parse_if_with_numeric_result() {
        let expr = parse_measure_expression("IF(SUM(S[a]) > 0, SUM(S[a]), 0)").unwrap();
        let sql = expr.to_sql_string().unwrap();
        assert!(sql.starts_with("CASE WHEN"));
        assert!(sql.contains("SUM(\"a\")"));
    }

    #[test]
    fn parse_if_with_isblank() {
        let expr = parse_measure_expression(r#"IF(ISBLANK(SUM(S[a])), 0, SUM(S[a]))"#).unwrap();
        let sql = expr.to_sql_string().unwrap();
        assert!(sql.contains("IS NULL"));
    }

    #[test]
    fn parse_switch() {
        let expr = parse_measure_expression(
            r#"SWITCH(SUM(S[status]), 1, "Active", 2, "Inactive", "Unknown")"#,
        )
        .unwrap();
        let sql = expr.to_sql_string().unwrap();
        assert!(sql.contains("CASE SUM(\"status\")"));
        assert!(sql.contains("WHEN 1 THEN 'Active'"));
        assert!(sql.contains("WHEN 2 THEN 'Inactive'"));
        assert!(sql.contains("ELSE 'Unknown'"));
    }

    #[test]
    fn parse_divide() {
        let expr = parse_measure_expression("DIVIDE(SUM(S[revenue]), COUNT(S[orders]))").unwrap();
        let sql = expr.to_sql_string().unwrap();
        assert!(sql.contains("CASE WHEN"));
        assert!(sql.contains("= 0"));
        assert!(sql.contains("CAST(SUM(\"revenue\") AS DOUBLE) / COUNT(\"orders\")"));
    }

    #[test]
    fn parse_divide_with_alternate() {
        let expr = parse_measure_expression("DIVIDE(SUM(S[a]), SUM(S[b]), 0)").unwrap();
        let sql = expr.to_sql_string().unwrap();
        assert!(sql.contains("THEN 0 ELSE"));
    }

    #[test]
    fn parse_blank() {
        let expr = parse_measure_expression("BLANK()").unwrap();
        assert_eq!(expr.to_sql_string().unwrap(), "NULL");
    }

    #[test]
    fn parse_isblank() {
        let expr = parse_measure_expression("ISBLANK(SUM(S[x]))").unwrap();
        assert_eq!(expr.to_sql_string().unwrap(), "(SUM(\"x\") IS NULL)");
    }

    #[test]
    fn parse_coalesce() {
        let expr = parse_measure_expression("COALESCE(SUM(S[a]), 0)").unwrap();
        assert_eq!(expr.to_sql_string().unwrap(), "COALESCE(SUM(\"a\"), 0)");
    }

    #[test]
    fn parse_coalesce_multiple() {
        let expr = parse_measure_expression("COALESCE(SUM(S[a]), SUM(S[b]), 0)").unwrap();
        assert_eq!(
            expr.to_sql_string().unwrap(),
            "COALESCE(SUM(\"a\"), SUM(\"b\"), 0)"
        );
    }

    #[test]
    fn parse_nested_new_functions() {
        // ROUND(DIVIDE(SUM(S[a]), COUNT(S[b])), 2)
        let expr = parse_measure_expression("ROUND(DIVIDE(SUM(S[a]), COUNT(S[b])), 2)").unwrap();
        let sql = expr.to_sql_string().unwrap();
        assert!(sql.starts_with("ROUND("));
        assert!(sql.contains("CASE WHEN"));
    }

    #[test]
    fn parse_if_with_divide() {
        let expr =
            parse_measure_expression("IF(COUNT(S[b]) > 0, DIVIDE(SUM(S[a]), COUNT(S[b])), 0)")
                .unwrap();
        let sql = expr.to_sql_string().unwrap();
        assert!(sql.starts_with("CASE WHEN"));
        assert!(sql.contains("COUNT(\"b\") > 0"));
    }

    // --- Logical function tests ---

    #[test]
    fn parse_and_function() {
        let expr = parse_measure_expression("IF(AND(SUM(t[a]) > 0, SUM(t[b]) > 0), 1, 0)").unwrap();
        let sql = expr.to_sql_string().unwrap();
        assert!(sql.contains("AND"));
        assert!(sql.contains("SUM(\"a\") > 0"));
        assert!(sql.contains("SUM(\"b\") > 0"));
    }

    #[test]
    fn parse_or_function() {
        let expr =
            parse_measure_expression("IF(OR(SUM(t[a]) > 100, SUM(t[b]) > 100), 1, 0)").unwrap();
        let sql = expr.to_sql_string().unwrap();
        assert!(sql.contains("OR"));
    }

    #[test]
    fn parse_not_function() {
        let expr = parse_measure_expression("IF(NOT(SUM(t[a]) = 0), 1, 0)").unwrap();
        let sql = expr.to_sql_string().unwrap();
        assert!(sql.contains("NOT"));
    }

    #[test]
    fn parse_true_false_function() {
        let expr = parse_measure_expression("IF(SUM(t[a]) > 0, TRUE(), FALSE())").unwrap();
        let sql = expr.to_sql_string().unwrap();
        assert!(sql.contains("TRUE"));
        assert!(sql.contains("FALSE"));
    }

    #[test]
    fn parse_true_false_bare() {
        let expr = parse_measure_expression("IF(SUM(t[a]) > 0, TRUE, FALSE)").unwrap();
        let sql = expr.to_sql_string().unwrap();
        assert!(sql.contains("TRUE"));
        assert!(sql.contains("FALSE"));
    }

    #[test]
    fn parse_xor_function() {
        let expr = parse_measure_expression("IF(XOR(SUM(t[a]) > 0, SUM(t[b]) > 0), 1, 0)").unwrap();
        let sql = expr.to_sql_string().unwrap();
        // XOR renders as (A AND NOT B) OR (NOT A AND B)
        assert!(sql.contains("AND NOT"));
    }

    #[test]
    fn parse_nested_logical_functions() {
        let expr = parse_measure_expression(
            "IF(AND(OR(SUM(t[a]) > 0, SUM(t[b]) > 0), NOT(SUM(t[c]) = 0)), 1, 0)",
        )
        .unwrap();
        let sql = expr.to_sql_string().unwrap();
        assert!(sql.contains("AND"));
        assert!(sql.contains("OR"));
        assert!(sql.contains("NOT"));
    }
}
