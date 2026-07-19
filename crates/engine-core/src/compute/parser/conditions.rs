//! Condition and comparison expression parsing (including IN lists).

use super::*;

impl Parser {
    /// Parse `KEEP(table, table[col] = value, ...)`.
    /// Parse a boolean condition: `expr op expr` with optional AND/OR.
    ///
    /// This extends `parse_expression` with comparison and logical operators,
    /// used for KEEP condition arguments.
    ///
    /// Depth-guarded: AND/OR chaining recurses directly into `parse_condition`
    /// without passing through `parse_atom`, so it needs its own guard
    /// (see [`Parser::enter_recursion`]).
    pub(super) fn parse_condition(&mut self) -> EngineResult<Expression> {
        self.enter_recursion()?;
        let result = self.parse_condition_inner();
        self.exit_recursion();
        result
    }

    fn parse_condition_inner(&mut self) -> EngineResult<Expression> {
        let left = self.parse_expression()?;

        // Check for IN keyword: `table[col] IN {val1, val2}` or `table[col] IN var[col]`.
        if matches!(self.peek().cloned(), Some(Token::Ident(ref s)) if s.eq_ignore_ascii_case("IN"))
        {
            self.advance()?; // consume IN
            return self.parse_in_rhs(left, false);
        }
        // `NOT IN` — anti-membership. A postfix `NOT` here can only start
        // `NOT IN` (prefix NOT(...) is a function call parsed earlier).
        if matches!(self.peek().cloned(), Some(Token::Ident(ref s)) if s.eq_ignore_ascii_case("NOT"))
        {
            self.advance()?; // consume NOT
            if !matches!(self.peek().cloned(), Some(Token::Ident(ref s)) if s.eq_ignore_ascii_case("IN"))
            {
                return Err(self.parse_err("expected IN after NOT in a condition"));
            }
            self.advance()?; // consume IN
            return self.parse_in_rhs(left, true);
        }

        // Check for comparison operator.
        let op = match self.peek() {
            Some(Token::Eq) => Some(ComparisonOp::Equal),
            Some(Token::Neq) => Some(ComparisonOp::NotEqual),
            Some(Token::Gt) => Some(ComparisonOp::GreaterThan),
            Some(Token::Gte) => Some(ComparisonOp::GreaterThanOrEqual),
            Some(Token::Lt) => Some(ComparisonOp::LessThan),
            Some(Token::Lte) => Some(ComparisonOp::LessThanOrEqual),
            _ => None,
        };

        if let Some(op) = op {
            self.advance()?; // consume operator
            let right = self.parse_expression()?;
            let comparison = Expression::Comparison {
                left: Box::new(left),
                op,
                right: Box::new(right),
            };

            // Check for AND/OR chaining.
            match self.peek().cloned() {
                Some(Token::Ident(ref s)) if s.eq_ignore_ascii_case("AND") => {
                    self.advance()?;
                    let right_cond = self.parse_condition()?;
                    Ok(Expression::And(Box::new(comparison), Box::new(right_cond)))
                }
                Some(Token::Ident(ref s)) if s.eq_ignore_ascii_case("OR") => {
                    self.advance()?;
                    let right_cond = self.parse_condition()?;
                    Ok(Expression::Or(Box::new(comparison), Box::new(right_cond)))
                }
                _ => Ok(comparison),
            }
        } else {
            Ok(left)
        }
    }

    /// Parse the right-hand side of an IN / NOT IN expression.
    ///
    /// Two forms:
    /// - `{val1, val2, ...}` → InList expression (literal value set)
    /// - `var[col]` → InPredicate (membership in table variable)
    fn parse_in_rhs(&mut self, left: Expression, negated: bool) -> EngineResult<Expression> {
        if self.peek() == Some(&Token::LBrace) {
            // Literal value list: {val1, val2, ...}
            self.advance()?; // consume {
            let mut values = Vec::new();
            loop {
                let val = self.parse_expression()?;
                values.push(val);
                if self.peek() == Some(&Token::Comma) {
                    self.advance()?;
                } else {
                    break;
                }
            }
            self.expect(&Token::RBrace)?;

            if values.is_empty() {
                return Err(self.parse_err("IN list must contain at least one value"));
            }

            Ok(Expression::InList {
                expr: Box::new(left),
                values,
                negated,
            })
        } else {
            // Variable reference: var[col]
            // Left must be QualifiedColumnRef.
            let (table, column) = match &left {
                Expression::QualifiedColumnRef {
                    table_or_var,
                    column,
                } => (table_or_var.clone(), column.clone()),
                _ => {
                    return Err(
                        self.parse_err("IN with variable requires table[column] on both sides")
                    );
                }
            };

            let var_name = match self.advance()?.clone() {
                Token::Ident(s) => s,
                tok => {
                    return Err(
                        self.parse_err_prev(format!("IN: expected variable name, got {tok:?}"))
                    );
                }
            };
            self.expect(&Token::LBracket)?;
            let var_column = match self.advance()?.clone() {
                Token::Ident(s) => s,
                tok => {
                    return Err(
                        self.parse_err_prev(format!("IN: expected column name, got {tok:?}"))
                    );
                }
            };
            self.expect(&Token::RBracket)?;

            use crate::compute::expression::InPredicate;

            // Return a special marker that parse_keep_call will collect.
            Ok(Expression::KeepIn {
                expr: Box::new(expr::lit_int(0)), // placeholder
                predicates: vec![
                    InPredicate::new(table, column, var_name, var_column).with_negated(negated)
                ],
            })
        }
    }

    /// Parse a comparison expression (for IF conditions).
    ///
    /// Supports: `expr op expr`, `expr op expr && expr op expr`, `expr op expr || expr op expr`.
    pub(super) fn parse_comparison_expr(&mut self) -> EngineResult<Expression> {
        let mut left = self.parse_comparison_term()?;

        while let Some(tok) = self.peek() {
            match tok {
                Token::Ident(s) if s.to_uppercase() == "AND" => {
                    self.advance()?;
                    let right = self.parse_comparison_term()?;
                    left = expr::and(left, right);
                }
                Token::Ident(s) if s.to_uppercase() == "OR" => {
                    self.advance()?;
                    let right = self.parse_comparison_term()?;
                    left = expr::or(left, right);
                }
                _ => break,
            }
        }

        Ok(left)
    }

    /// Parse a single comparison: `expr op expr` or a boolean function like `ISBLANK(...)`.
    fn parse_comparison_term(&mut self) -> EngineResult<Expression> {
        let left = self.parse_expression()?;

        // Check for comparison operator.
        if let Some(tok) = self.peek() {
            let op = match tok {
                Token::Eq => Some(ComparisonOp::Equal),
                Token::Neq => Some(ComparisonOp::NotEqual),
                Token::Gt => Some(ComparisonOp::GreaterThan),
                Token::Gte => Some(ComparisonOp::GreaterThanOrEqual),
                Token::Lt => Some(ComparisonOp::LessThan),
                Token::Lte => Some(ComparisonOp::LessThanOrEqual),
                _ => None,
            };
            if let Some(comp_op) = op {
                self.advance()?;
                let right = self.parse_expression()?;
                return Ok(expr::compare(left, comp_op, right));
            }
        }

        // No comparison operator — return as-is (e.g., ISBLANK(...) as boolean).
        Ok(left)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // --- KEEP expression condition tests ---

    #[test]
    fn parse_keep_simple_filter_still_works() {
        // Existing simple filter syntax should still produce FilterPredicate.
        let expr =
            parse_measure_expression("SUM(fact[amount], KEEP(dim, dim[year] = 2024))").unwrap();
        if let Expression::Keep {
            filters,
            conditions,
            ..
        } = &expr
        {
            assert_eq!(filters.len(), 1);
            assert_eq!(filters[0].column, "year");
            assert_eq!(filters[0].value, "2024");
            assert!(conditions.is_empty());
        } else {
            panic!("expected Keep, got {expr:?}");
        }
    }

    #[test]
    fn parse_keep_expression_condition_column_vs_column() {
        let expr = parse_measure_expression("SUM(fact[amount], KEEP(dim, dim[price] > dim[cost]))")
            .unwrap();
        if let Expression::Keep {
            filters,
            conditions,
            ..
        } = &expr
        {
            // dim[price] > dim[cost] has an expression on the right, not a literal
            assert!(filters.is_empty());
            assert_eq!(conditions.len(), 1);
            assert!(matches!(&conditions[0], Expression::Comparison { .. }));
        } else {
            panic!("expected Keep, got {expr:?}");
        }
    }

    #[test]
    fn parse_keep_expression_condition_with_arithmetic() {
        let expr =
            parse_measure_expression("SUM(fact[amount], KEEP(dim, dim[price] > dim[cost] * 1.5))")
                .unwrap();
        if let Expression::Keep {
            filters,
            conditions,
            ..
        } = &expr
        {
            assert!(filters.is_empty());
            assert_eq!(conditions.len(), 1);
        } else {
            panic!("expected Keep");
        }
    }

    #[test]
    fn parse_keep_mixed_simple_and_expression() {
        let expr =
            parse_measure_expression("SUM(fact[x], KEEP(d, d[year] = 2024, d[price] > d[cost]))")
                .unwrap();
        if let Expression::Keep {
            filters,
            conditions,
            ..
        } = &expr
        {
            // d[year] = 2024 → FilterPredicate (literal on right)
            assert_eq!(filters.len(), 1);
            assert_eq!(filters[0].column, "year");
            // d[price] > d[cost] → expression condition
            assert_eq!(conditions.len(), 1);
        } else {
            panic!("expected Keep");
        }
    }

    #[test]
    fn parse_keep_string_filter_still_works() {
        let expr =
            parse_measure_expression("SUM(fact[x], KEEP(dim, dim[name] = \"Bikes\"))").unwrap();
        if let Expression::Keep {
            filters,
            conditions,
            ..
        } = &expr
        {
            assert_eq!(filters.len(), 1);
            assert_eq!(filters[0].value, "Bikes");
            assert!(conditions.is_empty());
        } else {
            panic!("expected Keep");
        }
    }

    // --- KEEP with IN operator tests ---

    #[test]
    fn parse_keep_in_literal_list() {
        let expr = parse_measure_expression(
            "SUM(fact[amount], KEEP(dim, dim[color] IN {\"Blue\", \"Red\", \"Black\"}))",
        )
        .unwrap();
        if let Expression::Keep { conditions, .. } = &expr {
            assert_eq!(conditions.len(), 1);
            if let Expression::InList {
                expr: inner,
                values,
                ..
            } = &conditions[0]
            {
                assert!(matches!(**inner, Expression::QualifiedColumnRef { .. }));
                assert_eq!(values.len(), 3);
            } else {
                panic!("expected InList condition, got {:?}", conditions[0]);
            }
        } else {
            panic!("expected Keep, got {expr:?}");
        }
    }

    #[test]
    fn parse_keep_in_numeric_list() {
        let expr =
            parse_measure_expression("SUM(fact[x], KEEP(dim, dim[year] IN {2020, 2021, 2022}))")
                .unwrap();
        if let Expression::Keep { conditions, .. } = &expr {
            assert_eq!(conditions.len(), 1);
            if let Expression::InList { values, .. } = &conditions[0] {
                assert_eq!(values.len(), 3);
            } else {
                panic!("expected InList");
            }
        } else {
            panic!("expected Keep");
        }
    }

    #[test]
    fn parse_keep_in_variable() {
        let expr = parse_measure_expression(
            "SUM(fact[amount], KEEP(dim, fact[product_id] IN premium[id]))",
        )
        .unwrap();
        if let Expression::Keep { in_predicates, .. } = &expr {
            assert_eq!(in_predicates.len(), 1);
            assert_eq!(in_predicates[0].table, "fact");
            assert_eq!(in_predicates[0].column, "product_id");
            assert_eq!(in_predicates[0].var_name, "premium");
            assert_eq!(in_predicates[0].var_column, "id");
        } else {
            panic!("expected Keep with in_predicates, got {expr:?}");
        }
    }

    #[test]
    fn parse_keep_mixed_filter_and_in_list() {
        let expr = parse_measure_expression(
            "SUM(fact[x], KEEP(d, d[year] = 2024, d[color] IN {\"Blue\", \"Red\"}))",
        )
        .unwrap();
        if let Expression::Keep {
            filters,
            conditions,
            ..
        } = &expr
        {
            assert_eq!(filters.len(), 1);
            assert_eq!(filters[0].column, "year");
            assert_eq!(conditions.len(), 1);
            assert!(matches!(&conditions[0], Expression::InList { .. }));
        } else {
            panic!("expected Keep");
        }
    }

    // --- NOT IN (anti-membership) tests ---

    #[test]
    fn parse_keep_not_in_literal_list() {
        let expr = parse_measure_expression(
            "SUM(fact[amount], KEEP(dim, dim[color] NOT IN {\"Blue\", \"Red\"}))",
        )
        .unwrap();
        if let Expression::Keep { conditions, .. } = &expr {
            assert_eq!(conditions.len(), 1);
            match &conditions[0] {
                Expression::InList {
                    values, negated, ..
                } => {
                    assert!(*negated, "NOT IN must set negated");
                    assert_eq!(values.len(), 2);
                }
                other => panic!("expected InList, got {other:?}"),
            }
        } else {
            panic!("expected Keep, got {expr:?}");
        }
    }

    #[test]
    fn parse_keep_not_in_variable() {
        let expr = parse_measure_expression(
            "SUM(fact[amount], KEEP(dim, fact[product_id] NOT IN premium[id]))",
        )
        .unwrap();
        if let Expression::Keep { in_predicates, .. } = &expr {
            assert_eq!(in_predicates.len(), 1);
            assert!(in_predicates[0].negated, "NOT IN must set negated");
            assert_eq!(in_predicates[0].var_name, "premium");
        } else {
            panic!("expected Keep with in_predicates, got {expr:?}");
        }
    }

    #[test]
    fn parse_not_without_in_is_error() {
        let err =
            parse_measure_expression("SUM(fact[x], KEEP(d, d[color] NOT {\"Blue\"}))").unwrap_err();
        assert!(
            err.to_string().contains("expected IN after NOT"),
            "got: {err}"
        );
    }

    #[test]
    fn not_in_list_sql_rendering() {
        let inlist = Expression::InList {
            expr: Box::new(expr::qualified_col("dim", "color")),
            values: vec![
                Expression::LiteralString("Blue".into()),
                Expression::LiteralString("Red".into()),
            ],
            negated: true,
        };
        assert_eq!(
            inlist.to_sql_string().unwrap(),
            "\"color\" NOT IN ('Blue', 'Red')"
        );
    }

    #[test]
    fn not_in_renders_in_formula_text() {
        // (The KEEP display uses the KEEP-outer form, which predates this
        // feature and does not re-parse for aggregate-wrapped shapes — so
        // assert the rendered predicate spelling rather than a full
        // round-trip.)
        let expr = parse_measure_expression(
            "SUM(fact[amount], KEEP(dim, fact[product_id] NOT IN premium[id]))",
        )
        .unwrap();
        let text = crate::compute::expression::expression_to_formula(&expr, "");
        assert!(
            text.contains("fact[product_id] NOT IN premium[id]"),
            "got: {text}"
        );
        let expr =
            parse_measure_expression("SUM(fact[amount], KEEP(dim, dim[color] NOT IN {\"Blue\"}))")
                .unwrap();
        let text = crate::compute::expression::expression_to_formula(&expr, "");
        assert!(text.contains("NOT IN {\"Blue\"}"), "got: {text}");
    }

    #[test]
    fn parse_keep_in_list_sql_rendering() {
        let inlist = Expression::InList {
            expr: Box::new(expr::qualified_col("dim", "color")),
            values: vec![
                Expression::LiteralString("Blue".into()),
                Expression::LiteralString("Red".into()),
            ],
            negated: false,
        };
        assert_eq!(
            inlist.to_sql_string().unwrap(),
            "\"color\" IN ('Blue', 'Red')"
        );
    }
}
