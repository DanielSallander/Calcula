//! Scalar, text, date/time, and value function call parsing.

use super::*;

impl Parser {
    /// Parse `HASONEVALUE(table[column])`.
    pub(super) fn parse_hasonevalue_call(&mut self) -> EngineResult<Expression> {
        let column = self.parse_expression()?;
        self.expect(&Token::RParen)?;
        Ok(expr::has_one_value(column))
    }

    /// Parse `SELECTEDVALUE(table[column] [, alternate])`.
    pub(super) fn parse_selectedvalue_call(&mut self) -> EngineResult<Expression> {
        let column = self.parse_expression()?;
        let alternate = if self.peek() == Some(&Token::Comma) {
            self.advance()?;
            Some(self.parse_expression()?)
        } else {
            None
        };
        self.expect(&Token::RParen)?;
        Ok(expr::selected_value(column, alternate))
    }

    /// Parse `FIRST(table[column], ORDER BY table[sort_col])`.
    ///
    /// Simplified from DAX: no axis, no reset, no blanks parameter.
    /// Syntax: `FIRST(column_expr, ORDER BY order_expr)` or `FIRST(column_expr, order_expr)`.
    pub(super) fn parse_first_call(&mut self) -> EngineResult<Expression> {
        let column = self.parse_expression()?;

        if self.peek() != Some(&Token::Comma) {
            return Err(
                self.parse_err("FIRST requires two arguments: FIRST(column, ORDER BY sort_column)")
            );
        }
        self.advance()?; // consume comma

        // Optional ORDER BY keywords (skip if present).
        if let Some(Token::Ident(kw)) = self.peek() {
            if kw.eq_ignore_ascii_case("ORDER") {
                self.advance()?; // consume ORDER
                if let Some(Token::Ident(by)) = self.peek() {
                    if by.eq_ignore_ascii_case("BY") {
                        self.advance()?; // consume BY
                    }
                }
            }
        }

        let order_by = self.parse_expression()?;
        self.expect(&Token::RParen)?;
        Ok(expr::first_value(column, order_by))
    }

    /// Parse a scalar function call with `min_args` required and optional extra args.
    pub(super) fn parse_scalar_call(
        &mut self,
        function: ScalarFunction,
        min_args: usize,
    ) -> EngineResult<Expression> {
        // Handle zero-arg functions like PI()
        if min_args == 0 && self.peek() == Some(&Token::RParen) {
            self.advance()?; // consume RParen
            return Ok(expr::scalar_fn(function, vec![]));
        }
        let mut args = vec![self.parse_expression()?];
        while self.peek() == Some(&Token::Comma) {
            self.advance()?;
            args.push(self.parse_expression()?);
        }
        if args.len() < min_args {
            return Err(self.parse_err(format!(
                "{function}: expected at least {min_args} arguments, got {}",
                args.len()
            )));
        }
        self.expect(&Token::RParen)?;
        Ok(expr::scalar_fn(function, args))
    }

    /// Parse a text function call with `min_args` required and optional extra args.
    pub(super) fn parse_text_call(
        &mut self,
        function: TextFunction,
        min_args: usize,
    ) -> EngineResult<Expression> {
        let mut args = vec![self.parse_expression()?];
        while self.peek() == Some(&Token::Comma) {
            self.advance()?;
            args.push(self.parse_expression()?);
        }
        if args.len() < min_args {
            return Err(self.parse_err(format!(
                "{function}: expected at least {min_args} arguments, got {}",
                args.len()
            )));
        }
        self.expect(&Token::RParen)?;
        Ok(expr::text_fn(function, args))
    }

    /// Parse a date/time function call with `min_args` required and optional extra args.
    pub(super) fn parse_datetime_call(
        &mut self,
        function: DateTimeFunction,
        min_args: usize,
    ) -> EngineResult<Expression> {
        if min_args == 0 {
            // Zero-arg functions like TODAY(), NOW()
            self.expect(&Token::RParen)?;
            return Ok(expr::datetime_fn(function, vec![]));
        }
        let mut args = vec![self.parse_expression()?];
        while self.peek() == Some(&Token::Comma) {
            self.advance()?;
            args.push(self.parse_expression()?);
        }
        if args.len() < min_args {
            return Err(self.parse_err(format!(
                "{function}: expected at least {min_args} arguments, got {}",
                args.len()
            )));
        }
        self.expect(&Token::RParen)?;
        Ok(expr::datetime_fn(function, args))
    }

    /// Parse `DATEDIFF(start, end, interval)` where interval is DAY/MONTH/YEAR/QUARTER.
    pub(super) fn parse_datediff_call(&mut self) -> EngineResult<Expression> {
        let start = self.parse_expression()?;
        self.expect(&Token::Comma)?;
        let end = self.parse_expression()?;
        self.expect(&Token::Comma)?;
        // The interval is an identifier keyword: DAY, MONTH, YEAR, QUARTER
        let interval = match self.advance()?.clone() {
            Token::Ident(s) => {
                let upper = s.to_uppercase();
                match upper.as_str() {
                    "DAY" | "MONTH" | "YEAR" | "QUARTER" | "HOUR" | "MINUTE" | "SECOND" => upper,
                    _ => {
                        return Err(self.parse_err_prev(format!(
                            "DATEDIFF: invalid interval '{s}', expected DAY, MONTH, YEAR, or QUARTER"
                        )));
                    }
                }
            }
            tok => {
                return Err(self.parse_err_prev(format!(
                    "DATEDIFF: expected interval (DAY/MONTH/YEAR/QUARTER), got {tok:?}"
                )));
            }
        };
        self.expect(&Token::RParen)?;
        Ok(expr::datetime_fn(
            DateTimeFunction::DateDiff,
            vec![start, end, Expression::LiteralString(interval)],
        ))
    }

    /// Parse `DATEADD(date, n, interval)` where interval is DAY/MONTH/YEAR/QUARTER/HOUR/MINUTE/SECOND.
    pub(super) fn parse_dateadd_call(&mut self) -> EngineResult<Expression> {
        let date = self.parse_expression()?;
        self.expect(&Token::Comma)?;
        let n = self.parse_expression()?;
        self.expect(&Token::Comma)?;
        let interval = match self.advance()?.clone() {
            Token::Ident(s) => {
                let upper = s.to_uppercase();
                match upper.as_str() {
                    "DAY" | "MONTH" | "YEAR" | "QUARTER" | "HOUR" | "MINUTE" | "SECOND" => upper,
                    _ => {
                        return Err(self.parse_err_prev(format!("DATEADD: invalid interval '{s}'")));
                    }
                }
            }
            tok => {
                return Err(
                    self.parse_err_prev(format!("DATEADD: expected interval keyword, got {tok:?}"))
                );
            }
        };
        self.expect(&Token::RParen)?;
        Ok(expr::datetime_fn(
            DateTimeFunction::DateAdd,
            vec![date, n, Expression::LiteralString(interval)],
        ))
    }

    /// Parse `DATE_TRUNC(date, interval)` where interval is YEAR/QUARTER/MONTH/WEEK/DAY/HOUR/MINUTE/SECOND.
    pub(super) fn parse_datetrunc_call(&mut self) -> EngineResult<Expression> {
        let date = self.parse_expression()?;
        self.expect(&Token::Comma)?;
        let interval = match self.advance()?.clone() {
            Token::Ident(s) => {
                let upper = s.to_uppercase();
                match upper.as_str() {
                    "YEAR" | "QUARTER" | "MONTH" | "WEEK" | "DAY" | "HOUR" | "MINUTE"
                    | "SECOND" => upper,
                    _ => {
                        return Err(
                            self.parse_err_prev(format!("DATE_TRUNC: invalid interval '{s}'"))
                        );
                    }
                }
            }
            tok => {
                return Err(self.parse_err_prev(format!(
                    "DATE_TRUNC: expected interval keyword, got {tok:?}"
                )));
            }
        };
        self.expect(&Token::RParen)?;
        Ok(expr::datetime_fn(
            DateTimeFunction::DateTrunc,
            vec![date, Expression::LiteralString(interval)],
        ))
    }

    /// Parse `LAST_DAY(date [, interval])` where optional interval defaults to MONTH.
    pub(super) fn parse_lastday_call(&mut self) -> EngineResult<Expression> {
        let date = self.parse_expression()?;
        let interval = if self.peek() == Some(&Token::Comma) {
            self.advance()?;
            match self.advance()?.clone() {
                Token::Ident(s) => {
                    let upper = s.to_uppercase();
                    match upper.as_str() {
                        "YEAR" | "QUARTER" | "MONTH" | "WEEK" => upper,
                        _ => {
                            return Err(
                                self.parse_err_prev(format!("LAST_DAY: invalid interval '{s}'"))
                            );
                        }
                    }
                }
                tok => {
                    return Err(self.parse_err_prev(format!(
                        "LAST_DAY: expected interval keyword, got {tok:?}"
                    )));
                }
            }
        } else {
            "MONTH".to_string()
        };
        self.expect(&Token::RParen)?;
        Ok(expr::datetime_fn(
            DateTimeFunction::LastDay,
            vec![date, Expression::LiteralString(interval)],
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_abs() {
        let expr = parse_measure_expression("ABS(SUM(S[diff]))").unwrap();
        assert_eq!(expr.to_sql_string().unwrap(), "ABS(SUM(\"diff\"))");
    }

    #[test]
    fn parse_round() {
        let expr = parse_measure_expression("ROUND(SUM(S[price]), 2)").unwrap();
        assert_eq!(expr.to_sql_string().unwrap(), "ROUND(SUM(\"price\"), 2)");
    }

    #[test]
    fn parse_int() {
        let expr = parse_measure_expression("INT(SUM(S[value]))").unwrap();
        assert_eq!(expr.to_sql_string().unwrap(), "FLOOR(SUM(\"value\"))");
    }

    #[test]
    fn parse_sqrt() {
        let expr = parse_measure_expression("SQRT(SUM(S[x]))").unwrap();
        assert_eq!(expr.to_sql_string().unwrap(), "SQRT(SUM(\"x\"))");
    }

    #[test]
    fn parse_power() {
        let expr = parse_measure_expression("POWER(SUM(S[x]), 2)").unwrap();
        assert_eq!(expr.to_sql_string().unwrap(), "POWER(SUM(\"x\"), 2)");
    }

    #[test]
    fn parse_hasonevalue() {
        let expr = parse_measure_expression("HASONEVALUE(Products[category])").unwrap();
        assert_eq!(
            expr.to_sql_string().unwrap(),
            "(COUNT(DISTINCT \"category\") = 1)"
        );
    }

    #[test]
    fn parse_selectedvalue_no_alternate() {
        let expr = parse_measure_expression("SELECTEDVALUE(Products[category])").unwrap();
        assert_eq!(
            expr.to_sql_string().unwrap(),
            "CASE WHEN COUNT(DISTINCT \"category\") = 1 THEN MIN(\"category\") ELSE NULL END"
        );
    }

    #[test]
    fn parse_selectedvalue_with_alternate() {
        let expr =
            parse_measure_expression("SELECTEDVALUE(Products[category], \"Multiple\")").unwrap();
        assert_eq!(
            expr.to_sql_string().unwrap(),
            "CASE WHEN COUNT(DISTINCT \"category\") = 1 THEN MIN(\"category\") ELSE 'Multiple' END"
        );
    }

    #[test]
    fn parse_first_with_order_by() {
        let expr = parse_measure_expression("FIRST(Products[name], ORDER BY Products[sort_order])")
            .unwrap();
        assert_eq!(
            expr.to_sql_string().unwrap(),
            "FIRST_VALUE(\"name\" ORDER BY \"sort_order\")"
        );
    }

    #[test]
    fn parse_first_without_order_by_keywords() {
        let expr = parse_measure_expression("FIRST(Products[name], Products[sort_order])").unwrap();
        assert_eq!(
            expr.to_sql_string().unwrap(),
            "FIRST_VALUE(\"name\" ORDER BY \"sort_order\")"
        );
    }

    #[test]
    fn parse_hasonevalue_in_if() {
        let expr = parse_measure_expression(
            "IF(HASONEVALUE(Calendar[year]), SELECTEDVALUE(Calendar[year]), \"All\")",
        )
        .unwrap();
        let sql = expr.to_sql_string().unwrap();
        assert!(sql.starts_with("CASE WHEN"));
        assert!(sql.contains("COUNT(DISTINCT \"year\") = 1"));
    }

    #[test]
    fn parse_selectedvalue_with_blank() {
        let expr = parse_measure_expression("SELECTEDVALUE(Calendar[year], BLANK())").unwrap();
        assert_eq!(
            expr.to_sql_string().unwrap(),
            "CASE WHEN COUNT(DISTINCT \"year\") = 1 THEN MIN(\"year\") ELSE NULL END"
        );
    }

    // --- Text function parser tests ---

    #[test]
    fn parse_upper() {
        let expr = parse_measure_expression("UPPER(t[name])").unwrap();
        assert_eq!(expr.to_sql_string().unwrap(), "UPPER(\"name\")");
    }

    #[test]
    fn parse_lower() {
        let expr = parse_measure_expression("LOWER(t[name])").unwrap();
        assert_eq!(expr.to_sql_string().unwrap(), "LOWER(\"name\")");
    }

    #[test]
    fn parse_trim() {
        let expr = parse_measure_expression("TRIM(t[name])").unwrap();
        assert_eq!(expr.to_sql_string().unwrap(), "TRIM(\"name\")");
    }

    #[test]
    fn parse_len() {
        let expr = parse_measure_expression("LEN(t[name])").unwrap();
        assert_eq!(expr.to_sql_string().unwrap(), "LENGTH(\"name\")");
    }

    #[test]
    fn parse_left_right() {
        let expr = parse_measure_expression("LEFT(t[name], 3)").unwrap();
        assert_eq!(expr.to_sql_string().unwrap(), "LEFT(\"name\", 3)");

        let expr = parse_measure_expression("RIGHT(t[name], 2)").unwrap();
        assert_eq!(expr.to_sql_string().unwrap(), "RIGHT(\"name\", 2)");
    }

    #[test]
    fn parse_mid() {
        let expr = parse_measure_expression("MID(t[name], 2, 4)").unwrap();
        assert_eq!(
            expr.to_sql_string().unwrap(),
            "SUBSTRING(\"name\" FROM 2 FOR 4)"
        );
    }

    #[test]
    fn parse_concatenate_variadic() {
        let expr = parse_measure_expression("CONCATENATE(t[first], \" \", t[last])").unwrap();
        let sql = expr.to_sql_string().unwrap();
        assert_eq!(sql, "CONCAT(\"first\", ' ', \"last\")");
    }

    #[test]
    fn parse_combinevalues() {
        let expr = parse_measure_expression("COMBINEVALUES(\"-\", t[a], t[b], t[c])").unwrap();
        assert_eq!(
            expr.to_sql_string().unwrap(),
            "CONCAT_WS('-', \"a\", \"b\", \"c\")"
        );
    }

    #[test]
    fn parse_find() {
        let expr = parse_measure_expression("FIND(\"x\", t[text])").unwrap();
        assert_eq!(expr.to_sql_string().unwrap(), "STRPOS(\"text\", 'x')");
    }

    #[test]
    fn parse_search() {
        let expr = parse_measure_expression("SEARCH(\"x\", t[text])").unwrap();
        assert_eq!(
            expr.to_sql_string().unwrap(),
            "STRPOS(LOWER(\"text\"), LOWER('x'))"
        );
    }

    #[test]
    fn parse_substitute() {
        let expr = parse_measure_expression("SUBSTITUTE(t[text], \"old\", \"new\")").unwrap();
        assert_eq!(
            expr.to_sql_string().unwrap(),
            "REPLACE(\"text\", 'old', 'new')"
        );
    }

    #[test]
    fn parse_replace() {
        let expr = parse_measure_expression("REPLACE(t[text], 3, 2, \"XX\")").unwrap();
        assert_eq!(
            expr.to_sql_string().unwrap(),
            "OVERLAY(\"text\" PLACING 'XX' FROM 3 FOR 2)"
        );
    }

    #[test]
    fn parse_rept() {
        let expr = parse_measure_expression("REPT(\"ab\", 3)").unwrap();
        assert_eq!(expr.to_sql_string().unwrap(), "REPEAT('ab', 3)");
    }

    #[test]
    fn parse_exact() {
        let expr = parse_measure_expression("EXACT(t[a], t[b])").unwrap();
        assert_eq!(expr.to_sql_string().unwrap(), "(\"a\" = \"b\")");
    }

    #[test]
    fn parse_value() {
        let expr = parse_measure_expression("VALUE(t[price_text])").unwrap();
        assert_eq!(
            expr.to_sql_string().unwrap(),
            "CAST(\"price_text\" AS DOUBLE)"
        );
    }

    #[test]
    fn parse_fixed() {
        let expr = parse_measure_expression("FIXED(SUM(t[amount]), 2)").unwrap();
        assert_eq!(
            expr.to_sql_string().unwrap(),
            "CAST(ROUND(SUM(\"amount\"), 2) AS VARCHAR)"
        );
    }

    #[test]
    fn parse_unichar_unicode() {
        let expr = parse_measure_expression("UNICHAR(65)").unwrap();
        assert_eq!(expr.to_sql_string().unwrap(), "CHR(65)");

        let expr = parse_measure_expression("UNICODE(\"A\")").unwrap();
        assert_eq!(expr.to_sql_string().unwrap(), "ASCII('A')");
    }

    #[test]
    fn parse_ltrim_rtrim() {
        let expr = parse_measure_expression("LTRIM(t[name])").unwrap();
        assert_eq!(expr.to_sql_string().unwrap(), "LTRIM(\"name\")");
        let expr = parse_measure_expression("LTRIM(t[name], \"0#\")").unwrap();
        assert_eq!(expr.to_sql_string().unwrap(), "LTRIM(\"name\", '0#')");
        let expr = parse_measure_expression("RTRIM(t[price], \"0.\")").unwrap();
        assert_eq!(expr.to_sql_string().unwrap(), "RTRIM(\"price\", '0.')");
    }

    #[test]
    fn parse_lpad_rpad() {
        let expr = parse_measure_expression("LPAD(t[id], 5, \"0\")").unwrap();
        assert_eq!(expr.to_sql_string().unwrap(), "LPAD(\"id\", 5, '0')");
        let expr = parse_measure_expression("RPAD(t[code], 10)").unwrap();
        assert_eq!(expr.to_sql_string().unwrap(), "RPAD(\"code\", 10)");
    }

    #[test]
    fn parse_reverse() {
        let expr = parse_measure_expression("REVERSE(t[name])").unwrap();
        assert_eq!(expr.to_sql_string().unwrap(), "REVERSE(\"name\")");
    }

    #[test]
    fn parse_split() {
        let expr = parse_measure_expression("SPLIT(t[path], \"/\", 2)").unwrap();
        assert_eq!(
            expr.to_sql_string().unwrap(),
            "SPLIT_PART(\"path\", '/', 2)"
        );
    }

    #[test]
    fn parse_text_in_if() {
        let expr =
            parse_measure_expression("IF(LEN(t[name]) > 10, LEFT(t[name], 10), t[name])").unwrap();
        let sql = expr.to_sql_string().unwrap();
        assert!(sql.contains("LENGTH"));
        assert!(sql.contains("LEFT"));
    }
}
