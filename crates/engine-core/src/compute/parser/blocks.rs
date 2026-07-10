//! VAR/RETURN block and QUERY expression parsing.

use super::*;

impl Parser {
    /// Parse a QUERY call for two-stage aggregation:
    /// `QUERY(SUM(fact[amount]) AS revenue, COUNT(fact[id]) AS orders BY dim[year], dim[month])`
    ///
    /// Grammar:
    /// ```text
    /// QUERY( agg_expr AS alias [, agg_expr AS alias]* BY table[col] [, table[col]]* )
    /// ```
    pub(super) fn parse_query_call(&mut self) -> EngineResult<Expression> {
        let mut aggregates = Vec::new();

        // Parse aggregate expressions until we hit the BY keyword.
        loop {
            let agg_expr = self.parse_expression()?;

            // Expect AS keyword (parsed as an identifier).
            match self.peek().cloned() {
                Some(Token::Ident(ref s)) if s.eq_ignore_ascii_case("AS") => {
                    self.advance()?;
                }
                other => {
                    return Err(self.parse_err(format!(
                        "expected 'AS' after aggregate expression in QUERY, got {other:?}"
                    )));
                }
            }

            // Parse the alias name.
            let alias = match self.advance()?.clone() {
                Token::Ident(s) => s,
                tok => {
                    return Err(self.parse_err_prev(format!(
                        "expected alias name after AS in QUERY, got {tok:?}"
                    )));
                }
            };

            aggregates.push((agg_expr, alias));

            // Check for BY keyword or comma (more aggregates).
            match self.peek().cloned() {
                Some(Token::Ident(ref s)) if s.eq_ignore_ascii_case("BY") => {
                    self.advance()?; // consume BY
                    break;
                }
                Some(Token::Comma) => {
                    self.advance()?; // consume comma, continue parsing aggregates
                }
                other => {
                    return Err(self.parse_err(format!(
                        "expected ',' or 'BY' after aggregate alias in QUERY, got {other:?}"
                    )));
                }
            }
        }

        // Parse group-by columns: table[column] pairs.
        let mut group_by = Vec::new();
        loop {
            let table = match self.advance()?.clone() {
                Token::Ident(s) => s,
                tok => {
                    return Err(self.parse_err_prev(format!(
                        "expected table name in QUERY BY clause, got {tok:?}"
                    )));
                }
            };
            self.expect(&Token::LBracket)?;
            let column = match self.advance()?.clone() {
                Token::Ident(s) => s,
                tok => {
                    return Err(self.parse_err_prev(format!(
                        "expected column name in QUERY BY clause, got {tok:?}"
                    )));
                }
            };
            self.expect(&Token::RBracket)?;
            group_by.push((table, column));

            // Check for comma (more columns) or closing paren.
            if self.peek() == Some(&Token::Comma) {
                self.advance()?;
            } else {
                break;
            }
        }

        self.expect(&Token::RParen)?;

        if aggregates.is_empty() {
            return Err(self.parse_err("QUERY requires at least one aggregate expression"));
        }
        if group_by.is_empty() {
            return Err(self.parse_err("QUERY requires at least one BY column"));
        }

        Ok(expr::query_expr(aggregates, group_by))
    }

    /// Check if the current token is `VAR` (case-insensitive).
    pub(super) fn peek_is_var(&self) -> bool {
        matches!(self.peek(), Some(Token::Ident(s)) if s.to_uppercase() == "VAR")
    }

    /// Check if the current token is `GVAR` (case-insensitive) — a query-scoped
    /// (global) variable declaration.
    pub(super) fn peek_is_gvar(&self) -> bool {
        matches!(self.peek(), Some(Token::Ident(s)) if s.to_uppercase() == "GVAR")
    }

    /// Check if the input starts with a full `GVAR <name> =` declaration.
    ///
    /// Unlike `VAR`/`RETURN`, `GVAR` is only a keyword in declaration position,
    /// so the top-level parser entry must not hijack an expression that merely
    /// *begins* with an identifier named `gvar` (a column, measure, or model
    /// global variable reference such as `gvar + 1`) — those keep parsing as
    /// ordinary column references, preserving pre-GVAR behavior. The 3-token
    /// lookahead (`GVAR`, name, `=`) distinguishes the two.
    pub(super) fn peek_is_gvar_declaration(&self) -> bool {
        self.peek_is_gvar()
            && matches!(self.peek_at(1), Some(Token::Ident(_)))
            && matches!(self.peek_at(2), Some(Token::Eq))
    }

    /// Check if the current token is `RETURN` (case-insensitive).
    fn peek_is_return(&self) -> bool {
        matches!(self.peek(), Some(Token::Ident(s)) if s.to_uppercase() == "RETURN")
    }

    /// Parse a `VAR` / `GVAR` / `RETURN` block:
    ///
    /// ```text
    /// GVAR maxDate = MAX(dim_date[date])   -- query-scoped (once per query)
    /// VAR  local   = SUM(fact[amount])     -- per-row / per-group
    /// RETURN result_expression
    /// ```
    ///
    /// `VAR` and `GVAR` declarations may be interleaved; `GVAR` bindings are
    /// collected into `query_scoped_bindings` (evaluated once per query context
    /// at the facade), `VAR` bindings into `bindings` (inlined per group).
    /// Produces `Expression::Block { bindings, query_scoped_bindings, result }`.
    pub(super) fn parse_var_return_block(&mut self) -> EngineResult<Expression> {
        let mut bindings = Vec::new();
        let mut query_scoped = Vec::new();

        while self.peek_is_var() || self.peek_is_gvar() {
            let is_global = self.peek_is_gvar();
            let keyword = if is_global { "GVAR" } else { "VAR" };
            self.advance()?; // consume VAR / GVAR

            // Variable name.
            let var_name = match self.advance()?.clone() {
                Token::Ident(s) => {
                    // VAR and RETURN are matched mid-stream (loop condition /
                    // RETURN detection) so they must stay reserved as names.
                    // GVAR is only ever matched at a declaration start (via
                    // `peek_is_gvar`), so — for backward compatibility — it
                    // remains usable as a binding name.
                    let upper = s.to_uppercase();
                    if upper == "VAR" || upper == "RETURN" {
                        return Err(self.parse_err_prev(format!(
                            "'{s}' is a reserved keyword and cannot be used as a variable name"
                        )));
                    }
                    s
                }
                tok => {
                    return Err(self.parse_err_prev(format!(
                        "{keyword}: expected variable name, got {tok:?}"
                    )));
                }
            };

            // Expect `=`.
            self.expect(&Token::Eq)?;

            // Parse the binding expression.
            let binding_expr = self.parse_expression()?;
            if is_global {
                query_scoped.push((var_name, binding_expr));
            } else {
                bindings.push((var_name, binding_expr));
            }
        }

        if bindings.is_empty() && query_scoped.is_empty() {
            return Err(self.parse_err("VAR block must have at least one VAR or GVAR declaration"));
        }

        // Expect RETURN.
        if !self.peek_is_return() {
            return Err(self.parse_err(format!(
                "expected RETURN after VAR/GVAR declarations, got {:?}",
                self.peek()
            )));
        }
        self.advance()?; // consume RETURN

        let result = self.parse_expression()?;

        Ok(expr::block_with_globals(query_scoped, bindings, result))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // --- VAR/RETURN parser tests ---

    #[test]
    fn parse_var_return_simple() {
        let expr = parse_measure_expression("VAR total = SUM(Sales[amount]) RETURN total").unwrap();
        match &expr {
            Expression::Block {
                bindings, result, ..
            } => {
                assert_eq!(bindings.len(), 1);
                assert_eq!(bindings[0].0, "total");
                assert!(bindings[0].1.has_aggregate());
                assert!(matches!(result.as_ref(), Expression::ColumnRef(name) if name == "total"));
            }
            _ => panic!("expected Block, got {expr:?}"),
        }
    }

    #[test]
    fn parse_var_return_multiple_bindings() {
        let expr = parse_measure_expression(
            "VAR revenue = SUM(Sales[amount]) VAR cost = SUM(Sales[cost]) RETURN revenue - cost",
        )
        .unwrap();
        match &expr {
            Expression::Block {
                bindings, result, ..
            } => {
                assert_eq!(bindings.len(), 2);
                assert_eq!(bindings[0].0, "revenue");
                assert_eq!(bindings[1].0, "cost");
                assert!(matches!(result.as_ref(), Expression::BinaryOp { .. }));
            }
            _ => panic!("expected Block"),
        }
    }

    #[test]
    fn parse_var_return_with_divide() {
        let expr = parse_measure_expression(
            "VAR total = SUM(Sales[amount]) VAR cnt = COUNT(Sales[id]) RETURN DIVIDE(total, cnt)",
        )
        .unwrap();
        match &expr {
            Expression::Block {
                bindings, result, ..
            } => {
                assert_eq!(bindings.len(), 2);
                assert!(matches!(result.as_ref(), Expression::SafeDivide { .. }));
            }
            _ => panic!("expected Block"),
        }
    }

    #[test]
    fn parse_var_return_inline_sql() {
        let expr = parse_measure_expression(
            "VAR total = SUM(Sales[amount]) VAR cnt = COUNT(Sales[id]) RETURN total / cnt",
        )
        .unwrap();
        // After inlining, should produce valid SQL.
        let sql = expr.to_sql_string().unwrap();
        assert!(sql.contains("SUM"));
        assert!(sql.contains("COUNT"));
        assert!(sql.contains("/"));
    }

    #[test]
    fn parse_var_return_chained_references() {
        // B references A.
        let expr =
            parse_measure_expression("VAR a = SUM(Sales[amount]) VAR b = a * 2 RETURN b + 1")
                .unwrap();
        let sql = expr.to_sql_string().unwrap();
        // After inlining: (SUM("amount") * 2) + 1
        assert!(sql.contains("SUM"));
        assert!(sql.contains("* 2"));
    }

    #[test]
    fn parse_var_return_with_context_ops() {
        let expr = parse_measure_expression(
            r#"VAR bikes = SUM(Sales[amount], KEEP(Products, Products[category] = "Bikes")) VAR total = SUM(Sales[amount]) RETURN DIVIDE(bikes, total)"#,
        )
        .unwrap();
        match &expr {
            Expression::Block { bindings, .. } => {
                assert_eq!(bindings.len(), 2);
                // First binding should have context ops.
                assert!(bindings[0].1.has_context_ops());
                // Second binding should not.
                assert!(!bindings[1].1.has_context_ops());
            }
            _ => panic!("expected Block"),
        }
    }

    #[test]
    fn parse_var_return_case_insensitive() {
        let expr =
            parse_measure_expression("var total = SUM(Sales[amount]) return total * 2").unwrap();
        assert!(matches!(expr, Expression::Block { .. }));
    }

    #[test]
    fn parse_var_return_infer_table() {
        let expr = parse_measure("VAR total = SUM(Sales[amount]) RETURN total").unwrap();
        assert_eq!(infer_fact_table(&expr), Some("Sales".to_string()));
    }

    #[test]
    fn parse_var_without_return_fails() {
        let result = parse_measure_expression("VAR total = SUM(Sales[amount])");
        assert!(result.is_err());
        let err = result.unwrap_err().to_string();
        assert!(err.contains("RETURN"));
    }

    #[test]
    fn parse_var_reserved_name_fails() {
        let result = parse_measure_expression("VAR RETURN = SUM(Sales[amount]) RETURN RETURN");
        assert!(result.is_err());
        let err = result.unwrap_err().to_string();
        assert!(err.contains("reserved"));
    }

    // --- GVAR (query-scoped variable) parser tests ---

    #[test]
    fn parse_gvar_only_block() {
        let expr =
            parse_measure_expression("GVAR maxDate = MAX(dim_date[date]) RETURN maxDate").unwrap();
        match &expr {
            Expression::Block {
                bindings,
                query_scoped_bindings,
                result,
            } => {
                assert!(bindings.is_empty(), "no VAR bindings");
                assert_eq!(query_scoped_bindings.len(), 1);
                assert_eq!(query_scoped_bindings[0].0, "maxDate");
                assert!(query_scoped_bindings[0].1.has_aggregate());
                assert!(matches!(result.as_ref(), Expression::ColumnRef(n) if n == "maxDate"));
            }
            other => panic!("expected Block, got {other:?}"),
        }
    }

    #[test]
    fn parse_gvar_and_var_interleaved() {
        // Interleaved GVAR/VAR are routed by keyword, not source order.
        let expr = parse_measure_expression(
            "VAR local = SUM(Sales[amount]) \
             GVAR grand = SUM(Sales[amount]) \
             RETURN DIVIDE(local, grand)",
        )
        .unwrap();
        match &expr {
            Expression::Block {
                bindings,
                query_scoped_bindings,
                ..
            } => {
                assert_eq!(bindings.len(), 1);
                assert_eq!(bindings[0].0, "local");
                assert_eq!(query_scoped_bindings.len(), 1);
                assert_eq!(query_scoped_bindings[0].0, "grand");
            }
            other => panic!("expected Block, got {other:?}"),
        }
    }

    #[test]
    fn parse_gvar_case_insensitive() {
        let expr = parse_measure_expression("gvar g = SUM(Sales[amount]) return g * 2").unwrap();
        match &expr {
            Expression::Block {
                query_scoped_bindings,
                ..
            } => assert_eq!(query_scoped_bindings.len(), 1),
            other => panic!("expected Block, got {other:?}"),
        }
    }

    #[test]
    fn parse_gvar_without_return_fails() {
        let result = parse_measure_expression("GVAR g = SUM(Sales[amount])");
        assert!(result.is_err());
        assert!(result.unwrap_err().to_string().contains("RETURN"));
    }

    #[test]
    fn gvar_is_usable_as_a_variable_name() {
        // Backward compatibility: GVAR is only a keyword at a declaration start,
        // so it stays usable as a VAR/GVAR binding name (unlike VAR/RETURN).
        let expr = parse_measure_expression("VAR gvar = SUM(Sales[amount]) RETURN gvar").unwrap();
        assert!(matches!(expr, Expression::Block { .. }));
    }

    #[test]
    fn leading_gvar_identifier_still_parses_as_column_reference() {
        // Backward compatibility: an expression that merely BEGINS with an
        // identifier named `gvar` (a column / measure / model global variable
        // reference) is not hijacked by the GVAR keyword — only the full
        // declaration form `GVAR <name> =` enters the block path.
        let expr = parse_measure_expression("gvar + 1").unwrap();
        assert!(matches!(expr, Expression::BinaryOp { .. }));

        let bare = parse_measure_expression("gvar").unwrap();
        assert!(matches!(bare, Expression::ColumnRef(name) if name == "gvar"));

        // The declaration form still enters the block path.
        let block = parse_measure_expression("GVAR x = 1 RETURN x").unwrap();
        match &block {
            Expression::Block {
                query_scoped_bindings,
                ..
            } => assert_eq!(query_scoped_bindings.len(), 1),
            other => panic!("expected Block, got {other:?}"),
        }
    }

    #[test]
    fn parse_var_return_with_scalar_functions() {
        let expr = parse_measure_expression(
            "VAR avg = DIVIDE(SUM(Sales[amount]), COUNT(Sales[id])) RETURN ROUND(avg, 2)",
        )
        .unwrap();
        let sql = expr.to_sql_string().unwrap();
        assert!(sql.contains("ROUND"));
        assert!(sql.contains("SUM"));
    }

    // --- QUERY parser tests ---

    #[test]
    fn parse_query_simple() {
        let expr = parse_measure_expression(
            "VAR tbl = QUERY(SUM(Sales[amount]) AS revenue BY Date[year]) RETURN AVG(tbl[revenue])",
        )
        .unwrap();
        if let Expression::Block {
            bindings, result, ..
        } = &expr
        {
            assert_eq!(bindings.len(), 1);
            assert_eq!(bindings[0].0, "tbl");
            if let Expression::Query {
                aggregates,
                group_by,
            } = &bindings[0].1
            {
                assert_eq!(aggregates.len(), 1);
                assert_eq!(aggregates[0].1, "revenue");
                assert_eq!(group_by.len(), 1);
                assert_eq!(group_by[0], ("Date".to_string(), "year".to_string()));
            } else {
                panic!("expected Query expression");
            }
            // Result should be AVG(tbl[revenue])
            assert!(result.has_aggregate());
        } else {
            panic!("expected Block expression");
        }
    }

    #[test]
    fn parse_query_multiple_aggregates() {
        let expr = parse_measure_expression(
            "VAR tbl = QUERY(SUM(Sales[amount]) AS rev, COUNT(Sales[id]) AS cnt BY Date[year]) RETURN DIVIDE(AVG(tbl[rev]), AVG(tbl[cnt]))",
        )
        .unwrap();
        if let Expression::Block { bindings, .. } = &expr {
            if let Expression::Query {
                aggregates,
                group_by,
            } = &bindings[0].1
            {
                assert_eq!(aggregates.len(), 2);
                assert_eq!(aggregates[0].1, "rev");
                assert_eq!(aggregates[1].1, "cnt");
                assert_eq!(group_by.len(), 1);
            } else {
                panic!("expected Query expression");
            }
        } else {
            panic!("expected Block expression");
        }
    }

    #[test]
    fn parse_query_multiple_group_by() {
        let expr = parse_measure_expression(
            "VAR monthly = QUERY(SUM(Sales[amount]) AS revenue BY Date[year], Date[month]) RETURN AVG(monthly[revenue])",
        )
        .unwrap();
        if let Expression::Block { bindings, .. } = &expr {
            if let Expression::Query { group_by, .. } = &bindings[0].1 {
                assert_eq!(group_by.len(), 2);
                assert_eq!(group_by[0], ("Date".to_string(), "year".to_string()));
                assert_eq!(group_by[1], ("Date".to_string(), "month".to_string()));
            } else {
                panic!("expected Query expression");
            }
        } else {
            panic!("expected Block expression");
        }
    }

    #[test]
    fn parse_query_case_insensitive() {
        // AS and BY should be case-insensitive
        let expr = parse_measure_expression(
            "VAR t = query(SUM(Sales[amount]) as revenue by Date[year]) RETURN AVG(t[revenue])",
        )
        .unwrap();
        assert!(matches!(&expr, Expression::Block { .. }));
    }

    #[test]
    fn parse_query_missing_as_fails() {
        let result = parse_measure_expression(
            "VAR t = QUERY(SUM(Sales[amount]) revenue BY Date[year]) RETURN AVG(t[revenue])",
        );
        assert!(result.is_err());
    }

    #[test]
    fn parse_query_missing_by_fails() {
        let result = parse_measure_expression(
            "VAR t = QUERY(SUM(Sales[amount]) AS revenue) RETURN AVG(t[revenue])",
        );
        assert!(result.is_err());
    }

    #[test]
    fn parse_query_infer_table() {
        // parse_measure should infer the fact table from the QUERY's aggregate
        let expr = parse_measure(
            "VAR tbl = QUERY(SUM(fact_sales[linetotal]) AS revenue BY dim_date[year]) RETURN AVG(tbl[revenue])",
        )
        .unwrap();
        assert_eq!(infer_fact_table(&expr), Some("fact_sales".to_string()));
    }

    #[test]
    fn parse_query_has_query_bindings() {
        let expr = parse_measure_expression(
            "VAR tbl = QUERY(SUM(Sales[amount]) AS revenue BY Date[year]) RETURN AVG(tbl[revenue])",
        )
        .unwrap();
        assert!(expr.has_query_bindings());
    }

    #[test]
    fn parse_query_is_query_detection() {
        let q = expr::query_expr(
            vec![(
                expr::agg(AggregateOp::Sum, expr::col("amount")),
                "total".into(),
            )],
            vec![("Date".into(), "year".into())],
        );
        assert!(q.is_query());
        assert!(!expr::col("x").is_query());
    }
}
