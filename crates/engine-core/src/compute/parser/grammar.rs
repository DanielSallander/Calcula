//! Core grammar: expressions, terms, atoms, and function-call dispatch.

use super::*;

impl Parser {
    /// Parse a full expression (top level): handles `+`, `-` (additive).
    pub(super) fn parse_expression(&mut self) -> EngineResult<Expression> {
        let mut left = self.parse_term()?;

        while let Some(tok) = self.peek() {
            match tok {
                Token::Plus => {
                    self.advance()?;
                    let right = self.parse_term()?;
                    left = left.add(right);
                }
                Token::Minus => {
                    self.advance()?;
                    let right = self.parse_term()?;
                    left = left.subtract(right);
                }
                _ => break,
            }
        }

        Ok(left)
    }

    /// Parse a term: handles `*`, `/` (multiplicative).
    fn parse_term(&mut self) -> EngineResult<Expression> {
        let mut left = self.parse_atom()?;

        while let Some(tok) = self.peek() {
            match tok {
                Token::Star => {
                    self.advance()?;
                    let right = self.parse_atom()?;
                    left = left.multiply(right);
                }
                Token::Slash => {
                    self.advance()?;
                    let right = self.parse_atom()?;
                    left = left.divide(right);
                }
                _ => break,
            }
        }

        Ok(left)
    }

    /// Parse an atom: number, string, parenthesized expression, column ref, or function call.
    ///
    /// Depth-guarded: all mutually recursive grammar productions re-enter the
    /// parser through this function, so the guard here bounds nesting for the
    /// whole grammar (see [`Parser::enter_recursion`]).
    pub(super) fn parse_atom(&mut self) -> EngineResult<Expression> {
        self.enter_recursion()?;
        let result = self.parse_atom_inner();
        self.exit_recursion();
        result
    }

    fn parse_atom_inner(&mut self) -> EngineResult<Expression> {
        match self.peek().cloned() {
            // Unary minus: a leading `-` (start of expression, or after `(`,
            // `,`, an operator, etc.) negates the following atom. Binary
            // subtraction is handled in `parse_expression`, which consumes the
            // `-` before recursing here, so this only fires for a genuine
            // prefix minus (e.g. the negative `n` in `DATEADD(d, -7, "DAY")`).
            Some(Token::Minus) => {
                self.advance()?;
                let operand = self.parse_atom()?;
                // Fold a negated numeric literal to a literal so callers that
                // expect a constant (the incremental-refresh folder) see one.
                match operand {
                    Expression::LiteralInt(v) => Ok(expr::lit_int(-v)),
                    Expression::LiteralFloat(v) => Ok(expr::lit(-v)),
                    other => Ok(expr::lit_int(0).subtract(other)),
                }
            }
            Some(Token::Number(n)) => {
                self.advance()?;
                // Decide int vs float.
                if n.fract() == 0.0 && n.abs() < i64::MAX as f64 {
                    Ok(expr::lit_int(n as i64))
                } else {
                    Ok(expr::lit(n))
                }
            }
            Some(Token::StringLit(s)) => {
                self.advance()?;
                Ok(expr::lit_str(s))
            }
            Some(Token::LParen) => {
                self.advance()?;
                let inner = self.parse_expression()?;
                self.expect(&Token::RParen)?;
                Ok(inner)
            }
            Some(Token::Ident(_)) => self.parse_ident_or_call(),
            Some(Token::LBracket) => self.parse_measure_ref(),
            Some(tok) => Err(self.parse_err(format!("unexpected token: {tok:?}"))),
            None => Err(self.parse_err("unexpected end of expression")),
        }
    }

    /// Parse an identifier which could be:
    /// - A function call: `SUM(...)`, `KEEP(...)`, etc.
    /// - A column reference: `table[column]`
    fn parse_ident_or_call(&mut self) -> EngineResult<Expression> {
        let ident = match self.advance()?.clone() {
            Token::Ident(s) => s,
            tok => {
                return Err(self.parse_err_prev(format!("expected identifier, got {tok:?}")));
            }
        };

        let upper = ident.to_uppercase();

        // Check for function call: ident followed by `(`.
        if self.peek() == Some(&Token::LParen) {
            return self.parse_function_call(&ident, &upper);
        }

        // Check for column reference: ident followed by `[`.
        if self.peek() == Some(&Token::LBracket) {
            return self.parse_column_ref(&ident);
        }

        // Bare TRUE / FALSE — boolean literals without parentheses.
        if upper == "TRUE" {
            return Ok(expr::lit_bool(true));
        }
        if upper == "FALSE" {
            return Ok(expr::lit_bool(false));
        }

        // Bare identifier — treat as column name (unqualified).
        Ok(expr::col(&ident))
    }

    /// Parse `table[column]`.
    fn parse_column_ref(&mut self, table: &str) -> EngineResult<Expression> {
        self.expect(&Token::LBracket)?;
        let column = match self.advance()?.clone() {
            Token::Ident(s) => s,
            tok => {
                return Err(self.parse_err_prev(format!("expected column name, got {tok:?}")));
            }
        };
        self.expect(&Token::RBracket)?;
        Ok(expr::qualified_col(table, &column))
    }

    /// Parse a function call: aggregate, context op, scalar, conditional, etc.
    fn parse_function_call(&mut self, name: &str, upper: &str) -> EngineResult<Expression> {
        // Offset of the function-name token, which the caller consumed
        // immediately before calling us. Used to position "unknown function"
        // errors on the name itself rather than the opening parenthesis.
        let name_offset = self.offset_at(self.pos.saturating_sub(1));
        self.expect(&Token::LParen)?;

        match upper {
            "SUM" | "COUNT" | "AVG" | "AVERAGE" | "MIN" | "MAX" | "DISTINCTCOUNT" | "MEDIAN"
            | "STDEV" | "STDEVP" | "VARIANCE" | "VARIANCEP" => self.parse_aggregate_call(upper),
            "COUNTROWS" => self.parse_countrows_call(),
            "KEEP" => self.parse_keep_call(),
            "CLEAR" => self.parse_clear_call(),
            "RESET" => self.parse_reset_call(),
            "CLEAR_INNER" | "CLEARINNER" => self.parse_clear_inner_call(),
            "CLEAR_OUTER" | "CLEAROUTER" => self.parse_clear_outer_call(),
            "RESET_INNER" | "RESETINNER" => self.parse_reset_inner_call(),
            "RESET_OUTER" | "RESETOUTER" => self.parse_reset_outer_call(),
            "ALLSELECTED" => self.parse_allselected_call(),
            "USING" => self.parse_using_call(),
            "USERELATIONSHIP" => self.parse_use_relationship_call(),
            // Logical functions (function-call syntax)
            "AND" => self.parse_and_call(),
            "OR" => self.parse_or_call(),
            "NOT" => self.parse_not_call(),
            "TRUE" => self.parse_true_call(),
            "FALSE" => self.parse_false_call(),
            "XOR" => self.parse_xor_call(),
            // Conditional / null handling
            "IF" => self.parse_if_call(),
            "SWITCH" => self.parse_switch_call(),
            "DIVIDE" => self.parse_divide_call(),
            "BLANK" => self.parse_blank_call(),
            "ISBLANK" => self.parse_isblank_call(),
            "COALESCE" => self.parse_coalesce_call(),
            // Conditional: GREATEST, LEAST, NULLIF
            "GREATEST" => self.parse_greatest_call(),
            "LEAST" => self.parse_least_call(),
            "NULLIF" => self.parse_nullif_call(),
            // Aggregation: COUNTIF, ANY_VALUE, MODE, LISTAGG, MAX_BY, MIN_BY
            "COUNTIF" | "COUNT_IF" => self.parse_countif_call(),
            "ANY_VALUE" | "ANYVALUE" => self.parse_aggregate_call("ANY_VALUE"),
            "MODE" => self.parse_aggregate_call("MODE"),
            "LISTAGG" | "STRING_AGG" => self.parse_listagg_call(),
            "MAX_BY" | "MAXBY" => self.parse_maxby_call(),
            "MIN_BY" | "MINBY" => self.parse_minby_call(),
            // Table-producing query
            "QUERY" => self.parse_query_call(),
            // Window functions
            "WINDOW" => self.parse_window_call(),
            "OFFSET" => self.parse_offset_call(),
            "INDEX" => self.parse_index_call(),
            // Time-intelligence functions: parse to ToDate/PeriodShift sugar,
            // lowered onto the Window/Offset machinery at execution time
            // using the model's date table (see compute::time_intelligence).
            "YTD" => self.parse_to_date_call(crate::compute::expression::DateGranularity::Year),
            "QTD" => self.parse_to_date_call(crate::compute::expression::DateGranularity::Quarter),
            "MTD" => self.parse_to_date_call(crate::compute::expression::DateGranularity::Month),
            "PRIORYEAR" => self.parse_prioryear_call(),
            // SAMEPERIODLASTYEAR is a synonym for PRIORYEAR (shift -1 YEAR).
            "SAMEPERIODLASTYEAR" => self.parse_prioryear_call(),
            "PRIORPERIOD" => self.parse_priorperiod_call(),
            // PARALLELPERIOD shifts the whole window by `n` periods — the same
            // `PeriodShift` node as PRIORPERIOD. (DAX `DATEADD` is taken here by
            // the scalar single-date `DATEADD(date, n, unit)` function.)
            "PARALLELPERIOD" => self.parse_priorperiod_call(),
            "DATESINPERIOD" => self.parse_dates_in_period_call(),
            // Semi-additive balances: the measure pinned to the last (closing)
            // or first (opening) date of the current context.
            "CLOSINGBALANCE" => self.parse_balance_call(false),
            "OPENINGBALANCE" => self.parse_balance_call(true),
            // Ranking window functions
            "ROW_NUMBER" | "ROWNUMBER" => {
                self.parse_rank_window_call(expr::RankFunction::RowNumber)
            }
            "RANK" => self.parse_rank_window_call(expr::RankFunction::Rank),
            "DENSE_RANK" | "DENSERANK" => {
                self.parse_rank_window_call(expr::RankFunction::DenseRank)
            }
            // Value inspection functions
            "HASONEVALUE" => self.parse_hasonevalue_call(),
            "SELECTEDVALUE" => self.parse_selectedvalue_call(),
            "SELECTEDMEASURE" => self.parse_selectedmeasure_call(),
            "FIRST" => self.parse_first_call(),
            // Scalar math functions
            "ABS" => self.parse_scalar_call(ScalarFunction::Abs, 1),
            "ROUND" => self.parse_scalar_call(ScalarFunction::Round, 2),
            "ROUNDUP" => self.parse_scalar_call(ScalarFunction::RoundUp, 2),
            "ROUNDDOWN" => self.parse_scalar_call(ScalarFunction::RoundDown, 2),
            "INT" => self.parse_scalar_call(ScalarFunction::Int, 1),
            "TRUNC" => self.parse_scalar_call(ScalarFunction::Trunc, 1),
            "CEILING" => self.parse_scalar_call(ScalarFunction::Ceiling, 1),
            "FLOOR" => self.parse_scalar_call(ScalarFunction::Floor, 1),
            "MOD" => self.parse_scalar_call(ScalarFunction::Mod, 2),
            "POWER" => self.parse_scalar_call(ScalarFunction::Power, 2),
            "SQRT" => self.parse_scalar_call(ScalarFunction::Sqrt, 1),
            "LN" => self.parse_scalar_call(ScalarFunction::Ln, 1),
            "LOG10" => self.parse_scalar_call(ScalarFunction::Log10, 1),
            "SIGN" => self.parse_scalar_call(ScalarFunction::Sign, 1),
            "EXP" => self.parse_scalar_call(ScalarFunction::Exp, 1),
            "LOG" => self.parse_scalar_call(ScalarFunction::Log, 1),
            "PI" => self.parse_scalar_call(ScalarFunction::Pi, 0),
            // Date/time functions
            "YEAR" => self.parse_datetime_call(DateTimeFunction::Year, 1),
            "MONTH" => self.parse_datetime_call(DateTimeFunction::Month, 1),
            "DAY" => self.parse_datetime_call(DateTimeFunction::Day, 1),
            "QUARTER" => self.parse_datetime_call(DateTimeFunction::Quarter, 1),
            "DATE" => self.parse_datetime_call(DateTimeFunction::Date, 3),
            "DATEDIFF" => self.parse_datediff_call(),
            "TODAY" => self.parse_datetime_call(DateTimeFunction::Today, 0),
            "NOW" => self.parse_datetime_call(DateTimeFunction::Now, 0),
            "DATEADD" => self.parse_dateadd_call(),
            "DATE_TRUNC" | "DATETRUNC" => self.parse_datetrunc_call(),
            "LAST_DAY" | "LASTDAY" => self.parse_lastday_call(),
            "EOMONTH" => self.parse_datetime_call(DateTimeFunction::EoMonth, 1),
            "DAYOFWEEK" => self.parse_datetime_call(DateTimeFunction::DayOfWeek, 1),
            "DAYOFYEAR" => self.parse_datetime_call(DateTimeFunction::DayOfYear, 1),
            "WEEKNUM" => self.parse_datetime_call(DateTimeFunction::WeekNum, 1),
            "DAYNAME" => self.parse_datetime_call(DateTimeFunction::DayName, 1),
            "MONTHNAME" => self.parse_datetime_call(DateTimeFunction::MonthName, 1),
            "MONTHS_BETWEEN" | "MONTHSBETWEEN" => {
                self.parse_datetime_call(DateTimeFunction::MonthsBetween, 2)
            }
            // Error handling
            "IFERROR" => self.parse_iferror_call(),
            // Scope check
            "ISINSCOPE" => self.parse_isinscope_call(),
            "ISFILTERED" => self.parse_isfiltered_call(),
            // Context operations
            "CLEAREXCEPT" | "CLEAR_EXCEPT" => self.parse_clearexcept_call(),
            // Iterator
            "ITERATE" => self.parse_iterate_call(),
            // Explicit relationship traversal
            "TRAVERSE" => self.parse_traverse_call(),
            // Percentile
            "PERCENTILE" => self.parse_percentile_call(),
            // Text functions
            "CONCATENATE" => self.parse_text_call(TextFunction::Concatenate, 1),
            "COMBINEVALUES" => self.parse_text_call(TextFunction::CombineValues, 2),
            "EXACT" => self.parse_text_call(TextFunction::Exact, 2),
            "FIND" => self.parse_text_call(TextFunction::Find, 2),
            "FIXED" => self.parse_text_call(TextFunction::Fixed, 1),
            "LEFT" => self.parse_text_call(TextFunction::Left, 1),
            "LEN" => self.parse_text_call(TextFunction::Len, 1),
            "LOWER" => self.parse_text_call(TextFunction::Lower, 1),
            "MID" => self.parse_text_call(TextFunction::Mid, 3),
            "REPLACE" => self.parse_text_call(TextFunction::Replace, 4),
            "REPT" => self.parse_text_call(TextFunction::Rept, 2),
            "RIGHT" => self.parse_text_call(TextFunction::Right, 1),
            "SEARCH" => self.parse_text_call(TextFunction::Search, 2),
            "SUBSTITUTE" => self.parse_text_call(TextFunction::Substitute, 3),
            "TRIM" => self.parse_text_call(TextFunction::Trim, 1),
            "UNICHAR" => self.parse_text_call(TextFunction::Unichar, 1),
            "UNICODE" => self.parse_text_call(TextFunction::Unicode, 1),
            "UPPER" => self.parse_text_call(TextFunction::Upper, 1),
            "VALUE" => self.parse_text_call(TextFunction::Value, 1),
            "LTRIM" => self.parse_text_call(TextFunction::Ltrim, 1),
            "RTRIM" => self.parse_text_call(TextFunction::Rtrim, 1),
            "LPAD" => self.parse_text_call(TextFunction::Lpad, 2),
            "RPAD" => self.parse_text_call(TextFunction::Rpad, 2),
            "REVERSE" => self.parse_text_call(TextFunction::Reverse, 1),
            "SPLIT" => self.parse_text_call(TextFunction::Split, 3),
            "FORMAT" => self.parse_text_call(TextFunction::Format, 2),
            "CONTAINS" => self.parse_text_call(TextFunction::Contains, 2),
            "STARTSWITH" => self.parse_text_call(TextFunction::StartsWith, 2),
            "ENDSWITH" => self.parse_text_call(TextFunction::EndsWith, 2),
            "INITCAP" => self.parse_text_call(TextFunction::InitCap, 1),
            // Unrecognized name: if it is a valid call identifier, parse it
            // as a call to a host-registered UDF (`Expression::Call`).
            //
            // Trade-off (documented): a typo in a built-in name (`SUMM(...)`)
            // now parses successfully as a UDF call and surfaces later as an
            // "unknown function or unregistered UDF" error at validation /
            // query time instead of a parse error. This is the price of
            // supporting host-registered functions the parser cannot know
            // about. Malformed identifiers still fail here with a positioned
            // parse error.
            _ => {
                if expr::is_valid_call_name(name) {
                    self.parse_udf_call(name)
                } else {
                    Err(EngineError::ParseError {
                        position: name_offset,
                        message: format!("unknown function: {name}"),
                    })
                }
            }
        }
    }

    /// Parse the argument list of a host-registered UDF call:
    /// `name(arg1, arg2, ...)` — each argument is a full expression; zero
    /// arguments (`name()`) are allowed.
    ///
    /// The opening parenthesis has already been consumed by
    /// [`Parser::parse_function_call`]; the name has already passed
    /// [`expr::is_valid_call_name`].
    fn parse_udf_call(&mut self, name: &str) -> EngineResult<Expression> {
        let mut args = Vec::new();
        if self.peek() != Some(&Token::RParen) {
            args.push(self.parse_expression()?);
            while self.peek() == Some(&Token::Comma) {
                self.advance()?;
                args.push(self.parse_expression()?);
            }
        }
        self.expect(&Token::RParen)?;
        Ok(expr::call(name, args))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_arithmetic_aggregates() {
        let expr = parse_measure_expression("SUM(Sales[amount]) / COUNT(Sales[id])").unwrap();
        assert_eq!(
            expr.to_sql_string().unwrap(),
            "(SUM(\"amount\") / COUNT(\"id\"))"
        );
    }

    #[test]
    fn parse_addition_subtraction() {
        let expr =
            parse_measure_expression("SUM(Sales[a]) + SUM(Sales[b]) - SUM(Sales[c])").unwrap();
        let sql = expr.to_sql_string().unwrap();
        assert!(sql.contains("SUM(\"a\")"));
        assert!(sql.contains("SUM(\"b\")"));
        assert!(sql.contains("SUM(\"c\")"));
    }

    #[test]
    fn parse_parenthesized_arithmetic() {
        let expr = parse_measure_expression("(SUM(Sales[a]) + SUM(Sales[b])) * 100").unwrap();
        let sql = expr.to_sql_string().unwrap();
        assert!(sql.contains("100"));
    }

    #[test]
    fn parse_numeric_literal() {
        let expr = parse_measure_expression("SUM(Sales[a]) * 100").unwrap();
        let sql = expr.to_sql_string().unwrap();
        assert!(sql.contains("100"));
    }

    #[test]
    fn parse_float_literal() {
        let expr = parse_measure_expression("SUM(Sales[a]) * 1.5").unwrap();
        let sql = expr.to_sql_string().unwrap();
        assert!(sql.contains("1.5"));
    }

    #[test]
    fn unknown_function_parses_as_udf_call() {
        // Unrecognized-but-well-formed names parse as UDF calls now; they
        // surface as "unregistered UDF" errors at validation / query time.
        let expr = parse_measure_expression("BOGUS(Sales[a])").unwrap();
        match &expr {
            Expression::Call { name, args } => {
                assert_eq!(name, "BOGUS");
                assert_eq!(args.len(), 1);
            }
            other => panic!("expected Call, got {other:?}"),
        }
    }

    #[test]
    fn udf_call_parses_with_multiple_args() {
        let expr = parse_measure_expression("MYFUNC(t[a], 2)").unwrap();
        match &expr {
            Expression::Call { name, args } => {
                assert_eq!(name, "MYFUNC");
                assert_eq!(args.len(), 2);
                assert!(matches!(args[0], Expression::QualifiedColumnRef { .. }));
                assert!(matches!(args[1], Expression::LiteralInt(2)));
            }
            other => panic!("expected Call, got {other:?}"),
        }
    }

    #[test]
    fn udf_call_parses_with_nested_aggregate_arg() {
        let expr = parse_measure_expression("MYFUNC(SUM(t[a]))").unwrap();
        match &expr {
            Expression::Call { name, args } => {
                assert_eq!(name, "MYFUNC");
                assert_eq!(args.len(), 1);
                assert!(matches!(args[0], Expression::Aggregate { .. }));
            }
            other => panic!("expected Call, got {other:?}"),
        }
        assert!(expr.has_aggregate());
    }

    #[test]
    fn udf_call_parses_with_zero_args() {
        let expr = parse_measure_expression("MY_CONSTANT()").unwrap();
        match &expr {
            Expression::Call { name, args } => {
                assert_eq!(name, "MY_CONSTANT");
                assert!(args.is_empty());
            }
            other => panic!("expected Call, got {other:?}"),
        }
    }

    #[test]
    fn aggregate_over_udf_call_parses() {
        let expr = parse_measure_expression("SUM(DOUBLE(fact_sales[amount]))").unwrap();
        match &expr {
            Expression::Aggregate { operand, .. } => {
                assert!(matches!(operand.as_ref(), Expression::Call { .. }));
            }
            other => panic!("expected Aggregate, got {other:?}"),
        }
        assert_eq!(
            crate::compute::expression::infer_fact_table(&expr),
            Some("fact_sales".to_string())
        );
    }

    #[test]
    fn malformed_function_name_still_errors() {
        // Non-ASCII identifiers fail the call-name rule and keep the
        // positioned parse error.
        let err = parse_measure_expression("BÖGUS(Sales[a])").unwrap_err();
        match err {
            EngineError::ParseError { message, .. } => {
                assert!(message.contains("unknown function"), "got: {message}");
            }
            other => panic!("expected ParseError, got {other:?}"),
        }
    }

    #[test]
    fn udf_call_with_unbalanced_args_errors() {
        assert!(parse_measure_expression("MYFUNC(t[a],").is_err());
        assert!(parse_measure_expression("MYFUNC(t[a]").is_err());
    }

    #[test]
    fn unterminated_bracket_returns_error() {
        assert!(parse_measure_expression("SUM(Sales[amount)").is_err());
    }

    // -----------------------------------------------------------------------
    // Recursion depth limit (DoS protection against hostile model files)
    // -----------------------------------------------------------------------

    #[test]
    fn parse_deeply_nested_parens_returns_error_instead_of_stack_overflow() {
        // A hostile model file can embed ~100k nested parens in a
        // lookup_resolution string parsed lazily at query time; this must
        // fail cleanly with an error, not abort the host process.
        let n = 100_000;
        let input = format!("{}1{}", "(".repeat(n), ")".repeat(n));
        let err =
            parse_measure_expression(&input).expect_err("deeply nested parens must be rejected");
        assert!(
            err.to_string().contains("nesting too deep"),
            "unexpected error: {err}"
        );
    }

    #[test]
    fn parse_deeply_nested_function_calls_return_error_instead_of_stack_overflow() {
        // Function-argument parsing is a distinct re-entry path from parens.
        let n = 100_000;
        let input = format!("{}SUM(t[c]){}", "ABS(".repeat(n), ")".repeat(n));
        let err = parse_measure_expression(&input)
            .expect_err("deeply nested function calls must be rejected");
        assert!(
            err.to_string().contains("nesting too deep"),
            "unexpected error: {err}"
        );
    }

    #[test]
    fn parse_deep_and_chain_in_keep_returns_error_instead_of_stack_overflow() {
        // AND/OR chaining recurses through parse_condition, not parse_atom,
        // so it exercises the second guard point.
        let n = 100_000;
        let chain = vec!["d[y] = 1"; n].join(" AND ");
        let input = format!("SUM(f[x], KEEP(d, {chain}))");
        let err = parse_measure_expression(&input).expect_err("deep AND chain must be rejected");
        assert!(
            err.to_string().contains("nesting too deep"),
            "unexpected error: {err}"
        );
    }

    #[test]
    fn parse_nesting_just_below_limit_succeeds() {
        let n = 50;
        let input = format!("{}SUM(t[c]){}", "(".repeat(n), ")".repeat(n));
        let expr = parse_measure_expression(&input).unwrap();
        assert!(matches!(expr, Expression::Aggregate { .. }));
    }

    #[test]
    fn parse_realistic_expression_unaffected_by_depth_limit() {
        let expr = parse_measure_expression(
            "SUM(Sales[amount], KEEP(dim, dim[year] = 2024, dim[month] = 1))",
        )
        .unwrap();
        assert!(expr.has_context_ops());
        if let Expression::Keep { filters, .. } = &expr {
            assert_eq!(filters.len(), 2);
        } else {
            panic!("expected Keep expression");
        }
    }
}
