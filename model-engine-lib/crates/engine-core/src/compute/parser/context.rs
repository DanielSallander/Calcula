//! Context operation parsing (KEEP, CLEAR, RESET, USING, context definitions).

use super::*;

impl Parser {
    /// Parse a context argument inside an aggregate call.
    ///
    /// This can be:
    /// - A bare identifier (table variable name): `bikes` → `TableRef("bikes")`
    /// - A context function call: `KEEP(...)`, `CLEAR(...)`, `RESET(...)`, etc.
    pub(super) fn parse_context_arg(&mut self) -> EngineResult<Expression> {
        match self.peek().cloned() {
            Some(Token::Ident(ref name)) => {
                let upper = name.to_uppercase();
                // If followed by `(`, it's a function call (KEEP, CLEAR, etc.)
                // Check by looking at position + 1.
                let is_func = matches!(
                    upper.as_str(),
                    "KEEP"
                        | "CLEAR"
                        | "CLEAR_INNER"
                        | "CLEAR_OUTER"
                        | "CLEAREXCEPT"
                        | "CLEAR_EXCEPT"
                        | "RESET"
                        | "RESET_INNER"
                        | "RESET_OUTER"
                        | "ALLSELECTED"
                        | "TREATAS"
                        | "USING"
                        | "USERELATIONSHIP"
                );
                if is_func {
                    // Delegate to the normal atom parser which handles function calls.
                    self.parse_atom()
                } else {
                    // Bare identifier — table variable reference.
                    let name = name.clone();
                    self.advance()?; // consume identifier
                    Ok(expr::table_ref(name))
                }
            }
            Some(tok) => Err(self.parse_err(format!(
                "expected variable name or context function, got {tok:?}"
            ))),
            None => Err(self.parse_err("unexpected end of expression after comma in aggregate")),
        }
    }

    pub(super) fn parse_keep_call(&mut self) -> EngineResult<Expression> {
        // First argument: table name (ignored as dimension target, filters carry table info).
        let _dim_table = match self.advance()?.clone() {
            Token::Ident(s) => s,
            tok => {
                return Err(self.parse_err_prev(format!("KEEP: expected table name, got {tok:?}")));
            }
        };

        let mut filters = Vec::new();
        let mut conditions = Vec::new();
        let mut in_preds = Vec::new();

        while self.peek() == Some(&Token::Comma) {
            self.advance()?; // consume comma

            // Parse as a full condition expression (handles comparisons and IN).
            let condition_expr = self.parse_condition()?;

            // Route the parsed condition to the right bucket:
            // - Simple Comparison(QualifiedColumnRef, op, literal) → FilterPredicate
            // - KeepIn (from IN var[col] syntax) → in_predicates
            // - Everything else (InList, complex comparison) → conditions
            if let Expression::KeepIn { predicates, .. } = condition_expr {
                in_preds.extend(predicates);
            } else if let Some(pred) = try_as_filter_predicate(&condition_expr) {
                filters.push(pred);
            } else {
                conditions.push(condition_expr);
            }
        }

        self.expect(&Token::RParen)?;

        // Return a sentinel expression that carry_context_op will unwrap.
        Ok(Expression::Keep {
            expr: Box::new(expr::lit_int(0)), // placeholder
            filters,
            variables: Vec::new(),
            conditions,
            in_predicates: in_preds,
        })
    }

    /// Parse `TREATAS(source_table[column], target_table[column])` — the
    /// DAX-compatible virtual-relationship filter: the target column is
    /// restricted to the set of values of the source column (as the query's
    /// own filters leave it), with no model relationship required. Sugar for
    /// a KEEP with a single IN-membership predicate whose set provider is
    /// the raw source table.
    pub(super) fn parse_treatas_call(&mut self) -> EngineResult<Expression> {
        let (src_table, src_column) = self.parse_bracketed_column("TREATAS")?;
        self.expect(&Token::Comma)?;
        let (tgt_table, tgt_column) = self.parse_bracketed_column("TREATAS")?;
        self.expect(&Token::RParen)?;
        Ok(Expression::Keep {
            expr: Box::new(expr::lit_int(0)), // placeholder
            filters: Vec::new(),
            variables: Vec::new(),
            conditions: Vec::new(),
            in_predicates: vec![crate::compute::expression::InPredicate::new(
                tgt_table, tgt_column, src_table, src_column,
            )],
        })
    }

    /// Parse `CLEAR(table)` or `CLEAR(table[column])`.
    pub(super) fn parse_clear_call(&mut self) -> EngineResult<Expression> {
        let targets = self.parse_clear_targets()?;
        self.expect(&Token::RParen)?;
        Ok(Expression::Clear {
            expr: Box::new(expr::lit_int(0)), // placeholder
            targets,
        })
    }

    /// Parse `CLEAR_INNER(table)` or `CLEAR_INNER(table[column])`.
    pub(super) fn parse_clear_inner_call(&mut self) -> EngineResult<Expression> {
        let targets = self.parse_clear_targets()?;
        self.expect(&Token::RParen)?;
        Ok(Expression::ClearInner {
            expr: Box::new(expr::lit_int(0)),
            targets,
        })
    }

    /// Parse `CLEAR_OUTER(table)` or `CLEAR_OUTER(table[column])`.
    pub(super) fn parse_clear_outer_call(&mut self) -> EngineResult<Expression> {
        let targets = self.parse_clear_targets()?;
        self.expect(&Token::RParen)?;
        Ok(Expression::ClearOuter {
            expr: Box::new(expr::lit_int(0)),
            targets,
        })
    }

    /// Parse RESET() — no arguments.
    pub(super) fn parse_reset_call(&mut self) -> EngineResult<Expression> {
        self.expect(&Token::RParen)?;
        Ok(Expression::Reset {
            expr: Box::new(expr::lit_int(0)),
        })
    }

    /// Parse RESET_INNER() — no arguments.
    pub(super) fn parse_reset_inner_call(&mut self) -> EngineResult<Expression> {
        self.expect(&Token::RParen)?;
        Ok(Expression::ResetInner {
            expr: Box::new(expr::lit_int(0)),
        })
    }

    /// Parse RESET_OUTER() — no arguments.
    pub(super) fn parse_reset_outer_call(&mut self) -> EngineResult<Expression> {
        self.expect(&Token::RParen)?;
        Ok(Expression::ResetOuter {
            expr: Box::new(expr::lit_int(0)),
        })
    }

    /// Parse `ALLSELECTED()` / `ALLSELECTED(table)` / `ALLSELECTED(table[column])`
    /// — the DAX-compatible spelling of the inner-clear family. The bare form
    /// removes every group-axis (visual) filter while keeping query-level
    /// slicers — exactly `RESET_INNER()`; the targeted forms do the same for
    /// specific tables/columns — exactly `CLEAR_INNER(...)`. Parsed straight
    /// to those variants, so evaluation, rendering, and persistence are
    /// shared (a round-tripped formula renders as RESET_INNER/CLEAR_INNER).
    pub(super) fn parse_allselected_call(&mut self) -> EngineResult<Expression> {
        if self.peek() == Some(&Token::RParen) {
            self.advance()?; // consume ')'
            return Ok(Expression::ResetInner {
                expr: Box::new(expr::lit_int(0)),
            });
        }
        let targets = self.parse_clear_targets()?;
        self.expect(&Token::RParen)?;
        Ok(Expression::ClearInner {
            expr: Box::new(expr::lit_int(0)),
            targets,
        })
    }

    /// Parse USING(context_name).
    pub(super) fn parse_using_call(&mut self) -> EngineResult<Expression> {
        let name = match self.advance()?.clone() {
            Token::Ident(s) => s,
            tok => {
                return Err(
                    self.parse_err_prev(format!("USING: expected context name, got {tok:?}"))
                );
            }
        };
        self.expect(&Token::RParen)?;
        Ok(Expression::Using {
            expr: Box::new(expr::lit_int(0)), // placeholder
            context_name: name,
        })
    }

    /// Parse one or more clear targets (table or table[column]), comma-separated.
    fn parse_clear_targets(&mut self) -> EngineResult<Vec<ClearTarget>> {
        let mut targets = Vec::new();
        loop {
            let table = match self.advance()?.clone() {
                Token::Ident(s) => s,
                tok => {
                    return Err(
                        self.parse_err_prev(format!("CLEAR: expected table name, got {tok:?}"))
                    );
                }
            };

            if self.peek() == Some(&Token::LBracket) {
                self.advance()?;
                let col = match self.advance()?.clone() {
                    Token::Ident(s) => s,
                    tok => {
                        return Err(self
                            .parse_err_prev(format!("CLEAR: expected column name, got {tok:?}")));
                    }
                };
                self.expect(&Token::RBracket)?;
                targets.push(ClearTarget::Column { table, column: col });
            } else {
                targets.push(ClearTarget::Table(table));
            }

            if self.peek() != Some(&Token::Comma) {
                break;
            }
            // Peek ahead: is the next comma followed by another clear target or is it
            // part of the outer context? We only consume if there's an ident after comma.
            if self.pos + 1 < self.tokens.len() {
                if let Token::Ident(_) = &self.tokens[self.pos + 1] {
                    self.advance()?; // consume comma
                } else {
                    break;
                }
            } else {
                break;
            }
        }
        Ok(targets)
    }

    /// Parse `table[column] op value`.
    pub(super) fn parse_filter_predicate(&mut self) -> EngineResult<FilterPredicate> {
        let table = match self.advance()?.clone() {
            Token::Ident(s) => s,
            tok => {
                return Err(
                    self.parse_err_prev(format!("filter: expected table name, got {tok:?}"))
                );
            }
        };
        self.expect(&Token::LBracket)?;
        let column = match self.advance()?.clone() {
            Token::Ident(s) => s,
            tok => {
                return Err(
                    self.parse_err_prev(format!("filter: expected column name, got {tok:?}"))
                );
            }
        };
        self.expect(&Token::RBracket)?;

        let operator = match self.advance()?.clone() {
            Token::Eq => ComparisonOp::Equal,
            Token::Neq => ComparisonOp::NotEqual,
            Token::Gt => ComparisonOp::GreaterThan,
            Token::Gte => ComparisonOp::GreaterThanOrEqual,
            Token::Lt => ComparisonOp::LessThan,
            Token::Lte => ComparisonOp::LessThanOrEqual,
            tok => {
                return Err(self
                    .parse_err_prev(format!("filter: expected comparison operator, got {tok:?}")));
            }
        };

        let value = match self.advance()?.clone() {
            Token::Number(n) => {
                // Format without trailing .0 for integers.
                if n.fract() == 0.0 && n.abs() < i64::MAX as f64 {
                    format!("{}", n as i64)
                } else {
                    format!("{n}")
                }
            }
            Token::StringLit(s) => s,
            Token::Ident(s) => s,
            tok => {
                return Err(self.parse_err_prev(format!("filter: expected value, got {tok:?}")));
            }
        };

        Ok(FilterPredicate::new(table, column, operator, value))
    }

    /// Parse a single context operation (KEEP, CLEAR, RESET, or bare name)
    /// within a context DEFINITION, appending the result to `ops`.
    ///
    /// Takes an out-vec rather than returning one op because a single
    /// `KEEP(...)` may mix plain filters and IN-memberships, which map to two
    /// distinct [`ContextOp`] variants (`Keep` + `KeepIn`).
    pub(super) fn parse_context_op(&mut self, ops: &mut Vec<ContextOp>) -> EngineResult<()> {
        let name = match self.peek().cloned() {
            Some(Token::Ident(s)) => s,
            other => {
                return Err(
                    self.parse_err(format!("expected context operation or name, got {other:?}"))
                );
            }
        };

        let upper = name.to_uppercase();
        let op = match upper.as_str() {
            "KEEP" => {
                self.advance()?;
                self.expect(&Token::LParen)?;
                // First arg: table name (for grouping; filters carry actual table info).
                let _dim_table = match self.advance()?.clone() {
                    Token::Ident(s) => s,
                    tok => {
                        return Err(
                            self.parse_err_prev(format!("KEEP: expected table name, got {tok:?}"))
                        );
                    }
                };
                let mut filters = Vec::new();
                let mut in_preds = Vec::new();
                while self.peek() == Some(&Token::Comma) {
                    self.advance()?;
                    self.parse_context_def_keep_item(&mut filters, &mut in_preds)?;
                }
                self.expect(&Token::RParen)?;
                // A mixed KEEP emits Keep before KeepIn — the order the
                // serializer also uses, so definitions round-trip stably.
                let empty = filters.is_empty() && in_preds.is_empty();
                if !filters.is_empty() {
                    ops.push(ContextOp::Keep(filters));
                }
                if !in_preds.is_empty() {
                    ops.push(ContextOp::KeepIn(in_preds));
                }
                if empty {
                    // KEEP(table) with no predicates — an explicit no-op.
                    ops.push(ContextOp::Keep(Vec::new()));
                }
                return Ok(());
            }
            "CLEAR" => {
                self.advance()?;
                self.expect(&Token::LParen)?;
                let targets = self.parse_clear_targets()?;
                self.expect(&Token::RParen)?;
                ContextOp::Clear(targets)
            }
            "CLEAR_INNER" | "CLEARINNER" => {
                self.advance()?;
                self.expect(&Token::LParen)?;
                let targets = self.parse_clear_targets()?;
                self.expect(&Token::RParen)?;
                ContextOp::ClearInner(targets)
            }
            "CLEAR_OUTER" | "CLEAROUTER" => {
                self.advance()?;
                self.expect(&Token::LParen)?;
                let targets = self.parse_clear_targets()?;
                self.expect(&Token::RParen)?;
                ContextOp::ClearOuter(targets)
            }
            "RESET" => {
                self.advance()?;
                self.expect(&Token::LParen)?;
                self.expect(&Token::RParen)?;
                ContextOp::Reset
            }
            "RESET_INNER" | "RESETINNER" => {
                self.advance()?;
                self.expect(&Token::LParen)?;
                self.expect(&Token::RParen)?;
                ContextOp::ResetInner
            }
            "RESET_OUTER" | "RESETOUTER" => {
                self.advance()?;
                self.expect(&Token::LParen)?;
                self.expect(&Token::RParen)?;
                ContextOp::ResetOuter
            }
            "USERELATIONSHIP" => {
                self.advance()?;
                self.expect(&Token::LParen)?;
                let rel_name = match self.advance()?.clone() {
                    Token::StringLit(s) => s,
                    tok => {
                        return Err(self.parse_err_prev(format!(
                            "USERELATIONSHIP: expected string literal, got {tok:?}"
                        )));
                    }
                };
                self.expect(&Token::RParen)?;
                ContextOp::UseRelationship(rel_name)
            }
            _ => {
                // Bare name — inherit from another context.
                self.advance()?;
                ContextOp::Inherit(name)
            }
        };
        ops.push(op);
        Ok(())
    }

    /// Parse one comma-separated item inside a context-definition `KEEP(...)`:
    /// either a filter predicate (`table[col] op value` where the value may
    /// also be the dynamic `USERNAME()` / `CUSTOMDATA()`), or an IN-membership
    /// (`table[col] IN var[col]`, optionally `NOT IN`).
    fn parse_context_def_keep_item(
        &mut self,
        filters: &mut Vec<FilterPredicate>,
        in_preds: &mut Vec<crate::compute::expression::InPredicate>,
    ) -> EngineResult<()> {
        use crate::compute::expression::InPredicate;

        let table = match self.advance()?.clone() {
            Token::Ident(s) => s,
            tok => {
                return Err(
                    self.parse_err_prev(format!("KEEP: expected table[column], got {tok:?}"))
                );
            }
        };
        self.expect(&Token::LBracket)?;
        let column = match self.advance()?.clone() {
            Token::Ident(s) => s,
            tok => {
                return Err(
                    self.parse_err_prev(format!("KEEP: expected column name, got {tok:?}"))
                );
            }
        };
        self.expect(&Token::RBracket)?;

        // IN / NOT IN membership in a table variable.
        let negated = if matches!(self.peek(), Some(Token::Ident(s)) if s.eq_ignore_ascii_case("NOT"))
        {
            self.advance()?;
            if !matches!(self.peek(), Some(Token::Ident(s)) if s.eq_ignore_ascii_case("IN")) {
                return Err(self.parse_err("expected IN after NOT"));
            }
            Some(true)
        } else if matches!(self.peek(), Some(Token::Ident(s)) if s.eq_ignore_ascii_case("IN")) {
            Some(false)
        } else {
            None
        };
        if let Some(negated) = negated {
            self.advance()?; // consume IN
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
            in_preds
                .push(InPredicate::new(table, column, var_name, var_column).with_negated(negated));
            return Ok(());
        }

        // Comparison filter.
        let operator = match self.advance()?.clone() {
            Token::Eq => ComparisonOp::Equal,
            Token::Neq => ComparisonOp::NotEqual,
            Token::Gt => ComparisonOp::GreaterThan,
            Token::Gte => ComparisonOp::GreaterThanOrEqual,
            Token::Lt => ComparisonOp::LessThan,
            Token::Lte => ComparisonOp::LessThanOrEqual,
            tok => {
                return Err(self.parse_err_prev(format!(
                    "KEEP: expected comparison operator or IN, got {tok:?}"
                )));
            }
        };

        let filter = match self.advance()?.clone() {
            // Dynamic RLS-style values: USERNAME() / CUSTOMDATA().
            Token::Ident(s)
                if s.eq_ignore_ascii_case("USERNAME") && self.peek() == Some(&Token::LParen) =>
            {
                self.advance()?; // consume '('
                self.expect(&Token::RParen)?;
                FilterPredicate::username(table, column, operator)
            }
            Token::Ident(s)
                if s.eq_ignore_ascii_case("CUSTOMDATA") && self.peek() == Some(&Token::LParen) =>
            {
                self.advance()?; // consume '('
                self.expect(&Token::RParen)?;
                FilterPredicate::custom_data(table, column, operator)
            }
            Token::Number(n) => {
                // Format without trailing .0 for integers.
                let value = if n.fract() == 0.0 && n.abs() < i64::MAX as f64 {
                    format!("{}", n as i64)
                } else {
                    format!("{n}")
                };
                FilterPredicate::new(table, column, operator, value)
            }
            Token::StringLit(s) | Token::Ident(s) => {
                FilterPredicate::new(table, column, operator, s)
            }
            tok => {
                return Err(self.parse_err_prev(format!("KEEP: expected value, got {tok:?}")));
            }
        };
        filters.push(filter);
        Ok(())
    }
}

/// Wrap an aggregate expression with a context operation.
///
/// The context op was parsed as a placeholder Expression; here we extract
/// the context info and apply it to the real aggregate expression.
///
/// `position` is the byte offset where the context argument started in the
/// input text, used to position the error when the argument turns out not to
/// be a context operation.
pub(super) fn wrap_context_op(
    aggregate: Expression,
    context_op: Expression,
    position: usize,
) -> EngineResult<Expression> {
    match context_op {
        Expression::Keep {
            filters,
            variables,
            conditions,
            in_predicates,
            ..
        } => Ok(Expression::Keep {
            expr: Box::new(aggregate),
            filters,
            variables,
            conditions,
            in_predicates,
        }),
        Expression::TableRef(name) => Ok(expr::keep_vars(aggregate, vec![name])),
        Expression::Clear { targets, .. } => Ok(expr::clear(aggregate, targets)),
        Expression::Reset { .. } => Ok(expr::reset(aggregate)),
        Expression::ClearInner { targets, .. } => Ok(expr::clear_inner(aggregate, targets)),
        Expression::ClearOuter { targets, .. } => Ok(expr::clear_outer(aggregate, targets)),
        Expression::ResetInner { .. } => Ok(expr::reset_inner(aggregate)),
        Expression::ResetOuter { .. } => Ok(expr::reset_outer(aggregate)),
        Expression::Using { context_name, .. } => Ok(expr::using(aggregate, context_name)),
        Expression::UseRelationship {
            relationship_name, ..
        } => Ok(expr::use_relationship(aggregate, relationship_name)),
        Expression::ClearExcept {
            table,
            except_columns,
            ..
        } => Ok(expr::clear_except(aggregate, table, except_columns)),
        _ => Err(EngineError::ParseError {
            position,
            message:
                "expected context operation (KEEP, CLEAR, RESET, USING, USERELATIONSHIP, etc.)"
                    .into(),
        }),
    }
}

/// Parse a measure expression from text into an `Expression` tree.
///
/// # Syntax
///
/// ```text
/// SUM(table[column])
/// SUM(table[column], KEEP(dim, dim[year] = 2024))
/// SUM(table[a]) / COUNT(table[b])
/// SUM(table[price] * table[quantity])
/// ```
///
/// # Errors
///
/// Returns `EngineError::ParseError` for syntax errors, with a byte offset
/// into the input text where the error was detected.
///
/// # Example
///
/// ```
/// use engine_core::compute::parser::parse_measure_expression;
///
/// let expr = parse_measure_expression("SUM(fact_sales[linetotal])").unwrap();
/// ```
/// Try to downgrade a Comparison expression to a simple FilterPredicate.
///
/// Returns `Some(FilterPredicate)` if the expression is `QualifiedColumnRef op literal`,
/// which is the common case for KEEP filters. Otherwise returns `None`,
/// indicating the expression should be stored as a condition.
fn try_as_filter_predicate(expr: &Expression) -> Option<FilterPredicate> {
    if let Expression::Comparison { left, op, right } = expr {
        // Left must be a QualifiedColumnRef (table[column]).
        let (table, column) = match left.as_ref() {
            Expression::QualifiedColumnRef {
                table_or_var,
                column,
            } => (table_or_var.clone(), column.clone()),
            _ => return None,
        };

        // Right must be a literal value.
        let value = match right.as_ref() {
            Expression::LiteralFloat(v) => {
                if v.fract() == 0.0 && v.abs() < i64::MAX as f64 {
                    format!("{}", *v as i64)
                } else {
                    format!("{v}")
                }
            }
            Expression::LiteralInt(v) => format!("{v}"),
            Expression::LiteralString(s) => s.clone(),
            Expression::ColumnRef(s) => s.clone(), // bare identifier as value
            _ => return None,
        };

        Some(FilterPredicate::new(table, column, *op, value))
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_keep_context() {
        let expr = parse_measure_expression(
            "SUM(fact_sales[linetotal], KEEP(dim_date, dim_date[year] = 2014))",
        )
        .unwrap();
        assert!(expr.has_context_ops());
        assert!(expr.has_aggregate());
    }

    #[test]
    fn parse_keep_multiple_filters() {
        let expr = parse_measure_expression(
            "SUM(Sales[amount], KEEP(dim, dim[year] = 2024, dim[month] = 1))",
        )
        .unwrap();
        assert!(expr.has_context_ops());
        // Verify filters are captured.
        if let Expression::Keep { filters, .. } = &expr {
            assert_eq!(filters.len(), 2);
            assert_eq!(filters[0].table, "dim");
            assert_eq!(filters[0].column, "year");
            assert_eq!(filters[0].value, "2024");
            assert_eq!(filters[1].column, "month");
            assert_eq!(filters[1].value, "1");
        } else {
            panic!("expected Keep expression");
        }
    }

    #[test]
    fn parse_keep_with_string_value() {
        let expr = parse_measure_expression(
            r#"SUM(Sales[amount], KEEP(Products, Products[color] = "Red"))"#,
        )
        .unwrap();
        if let Expression::Keep { filters, .. } = &expr {
            assert_eq!(filters[0].value, "Red");
        } else {
            panic!("expected Keep expression");
        }
    }

    #[test]
    fn parse_keep_with_comparison_operators() {
        let expr =
            parse_measure_expression("SUM(Sales[amount], KEEP(dim, dim[year] >= 2020))").unwrap();
        if let Expression::Keep { filters, .. } = &expr {
            assert_eq!(filters[0].operator, ComparisonOp::GreaterThanOrEqual);
        } else {
            panic!("expected Keep expression");
        }
    }

    #[test]
    fn parse_clear_table() {
        let expr = parse_measure_expression("SUM(Sales[amount], CLEAR(Calendar))").unwrap();
        assert!(expr.has_context_ops());
        if let Expression::Clear { targets, .. } = &expr {
            assert_eq!(targets.len(), 1);
            assert!(matches!(&targets[0], ClearTarget::Table(t) if t == "Calendar"));
        } else {
            panic!("expected Clear expression");
        }
    }

    #[test]
    fn parse_clear_column() {
        let expr = parse_measure_expression("SUM(Sales[amount], CLEAR(Calendar[year]))").unwrap();
        if let Expression::Clear { targets, .. } = &expr {
            assert_eq!(targets.len(), 1);
            assert!(
                matches!(&targets[0], ClearTarget::Column { table, column } if table == "Calendar" && column == "year")
            );
        } else {
            panic!("expected Clear expression");
        }
    }

    #[test]
    fn parse_reset() {
        let expr = parse_measure_expression("SUM(Sales[amount], RESET())").unwrap();
        assert!(expr.has_context_ops());
        if let Expression::Reset { .. } = &expr {
            // ok
        } else {
            panic!("expected Reset expression");
        }
    }

    #[test]
    fn parse_using() {
        let expr = parse_measure_expression("SUM(Sales[amount], USING(bikes_2024))").unwrap();
        if let Expression::Using { context_name, .. } = &expr {
            assert_eq!(context_name, "bikes_2024");
        } else {
            panic!("expected Using expression");
        }
    }

    #[test]
    fn context_filter_tables_from_parsed_keep() {
        let expr = parse_measure_expression(
            "SUM(fact_sales[linetotal], KEEP(dim_date, dim_date[year] = 2014))",
        )
        .unwrap();
        let tables = expr.context_filter_tables();
        assert!(tables.contains(&"dim_date"));
    }

    // --- Bare variable name as context argument ---

    #[test]
    fn parse_aggregate_with_bare_variable() {
        let expr = parse_measure_expression("SUM(fact_sales[linetotal], bikes)").unwrap();
        assert!(expr.has_context_ops());
        assert!(expr.has_aggregate());
        if let Expression::Keep {
            variables, filters, ..
        } = &expr
        {
            assert_eq!(variables.len(), 1);
            assert_eq!(variables[0], "bikes");
            assert!(filters.is_empty());
        } else {
            panic!("expected Keep expression wrapping aggregate, got {expr:?}");
        }
    }

    #[test]
    fn parse_aggregate_with_multiple_bare_variables() {
        let expr =
            parse_measure_expression("SUM(fact_sales[linetotal], bikes, year_2024)").unwrap();
        assert!(expr.has_context_ops());
        // Outer Keep should have year_2024, inner Keep should have bikes.
        if let Expression::Keep {
            variables,
            expr: inner,
            ..
        } = &expr
        {
            assert_eq!(variables, &["year_2024"]);
            if let Expression::Keep {
                variables: inner_vars,
                ..
            } = inner.as_ref()
            {
                assert_eq!(inner_vars, &["bikes"]);
            } else {
                panic!("expected nested Keep for first variable");
            }
        } else {
            panic!("expected Keep expression");
        }
    }

    #[test]
    fn parse_aggregate_with_variable_and_keep() {
        let expr = parse_measure_expression(
            r#"SUM(fact_sales[linetotal], bikes, KEEP(dim_date, dim_date[year] = 2024))"#,
        )
        .unwrap();
        assert!(expr.has_context_ops());
        // Outer should be Keep with explicit filters (from KEEP(...)).
        if let Expression::Keep {
            filters,
            variables,
            expr: inner,
            ..
        } = &expr
        {
            assert_eq!(filters.len(), 1);
            assert_eq!(filters[0].column, "year");
            assert!(variables.is_empty());
            // Inner should be Keep with variable "bikes".
            if let Expression::Keep {
                variables: inner_vars,
                ..
            } = inner.as_ref()
            {
                assert_eq!(inner_vars, &["bikes"]);
            } else {
                panic!("expected nested Keep for variable");
            }
        } else {
            panic!("expected Keep expression");
        }
    }

    // --- parse_context tests ---

    #[test]
    fn parse_context_single_keep() {
        let ctx = parse_context(
            "ctx_bikes",
            r#"KEEP(dim_product, dim_product[categoryname] = "Bikes")"#,
        )
        .unwrap();
        assert_eq!(ctx.name(), "ctx_bikes");
        assert_eq!(ctx.operations().len(), 1);
        match &ctx.operations()[0] {
            ContextOp::Keep(filters) => {
                assert_eq!(filters.len(), 1);
                assert_eq!(filters[0].table, "dim_product");
                assert_eq!(filters[0].column, "categoryname");
                assert_eq!(filters[0].value, "Bikes");
            }
            _ => panic!("expected Keep"),
        }
    }

    #[test]
    fn parse_context_multiple_keeps() {
        let ctx = parse_context(
            "ctx_bikes_2024",
            r#"KEEP(dim_product, dim_product[categoryname] = "Bikes"), KEEP(dim_date, dim_date[year] = 2024)"#,
        )
        .unwrap();
        assert_eq!(ctx.name(), "ctx_bikes_2024");
        assert_eq!(ctx.operations().len(), 2);
        assert!(matches!(&ctx.operations()[0], ContextOp::Keep(_)));
        assert!(matches!(&ctx.operations()[1], ContextOp::Keep(_)));
    }

    #[test]
    fn parse_context_inherit_and_keep() {
        let ctx = parse_context(
            "ctx_derived",
            r#"ctx_base, KEEP(dim_date, dim_date[year] = 2024)"#,
        )
        .unwrap();
        assert_eq!(ctx.operations().len(), 2);
        assert_eq!(ctx.operations()[0], ContextOp::Inherit("ctx_base".into()));
        assert!(matches!(&ctx.operations()[1], ContextOp::Keep(_)));
    }

    #[test]
    fn parse_context_clear() {
        let ctx = parse_context("all_time", "CLEAR(dim_date)").unwrap();
        assert_eq!(ctx.operations().len(), 1);
        match &ctx.operations()[0] {
            ContextOp::Clear(targets) => {
                assert_eq!(targets.len(), 1);
                assert!(matches!(&targets[0], ClearTarget::Table(t) if t == "dim_date"));
            }
            _ => panic!("expected Clear"),
        }
    }

    #[test]
    fn parse_context_clear_column() {
        let ctx = parse_context("no_year", "CLEAR(dim_date[year])").unwrap();
        match &ctx.operations()[0] {
            ContextOp::Clear(targets) => {
                assert!(matches!(
                    &targets[0],
                    ClearTarget::Column { table, column } if table == "dim_date" && column == "year"
                ));
            }
            _ => panic!("expected Clear"),
        }
    }

    #[test]
    fn parse_context_reset() {
        let ctx = parse_context("no_filters", "RESET()").unwrap();
        assert_eq!(ctx.operations().len(), 1);
        assert_eq!(ctx.operations()[0], ContextOp::Reset);
    }

    #[test]
    fn parse_context_clear_inner_outer() {
        let ctx = parse_context("test", "CLEAR_INNER(dim_date), CLEAR_OUTER(dim_product)").unwrap();
        assert_eq!(ctx.operations().len(), 2);
        assert!(matches!(&ctx.operations()[0], ContextOp::ClearInner(_)));
        assert!(matches!(&ctx.operations()[1], ContextOp::ClearOuter(_)));
    }

    #[test]
    fn parse_context_reset_inner_outer() {
        let ctx = parse_context("test", "RESET_INNER(), RESET_OUTER()").unwrap();
        assert_eq!(ctx.operations().len(), 2);
        assert_eq!(ctx.operations()[0], ContextOp::ResetInner);
        assert_eq!(ctx.operations()[1], ContextOp::ResetOuter);
    }

    #[test]
    fn parse_context_multiple_inherits() {
        let ctx = parse_context("combined", "ctx_bikes, ctx_2024").unwrap();
        assert_eq!(ctx.operations().len(), 2);
        assert_eq!(ctx.operations()[0], ContextOp::Inherit("ctx_bikes".into()));
        assert_eq!(ctx.operations()[1], ContextOp::Inherit("ctx_2024".into()));
    }

    #[test]
    fn parse_context_empty_input_fails() {
        assert!(parse_context("empty", "").is_err());
    }

    #[test]
    fn parse_context_keep_multiple_filters() {
        let ctx = parse_context(
            "road_bikes",
            r#"KEEP(dim_product, dim_product[categoryname] = "Bikes", dim_product[subcategoryname] = "Road Bikes")"#,
        )
        .unwrap();
        match &ctx.operations()[0] {
            ContextOp::Keep(filters) => {
                assert_eq!(filters.len(), 2);
                assert_eq!(filters[0].column, "categoryname");
                assert_eq!(filters[1].column, "subcategoryname");
            }
            _ => panic!("expected Keep"),
        }
    }

    #[test]
    fn parse_context_keep_in_membership() {
        let ctx = parse_context(
            "premium_only",
            "KEEP(fact_sales, fact_sales[productid] IN premium[id])",
        )
        .unwrap();
        assert_eq!(ctx.operations().len(), 1);
        match &ctx.operations()[0] {
            ContextOp::KeepIn(preds) => {
                assert_eq!(preds.len(), 1);
                assert_eq!(preds[0].table, "fact_sales");
                assert_eq!(preds[0].column, "productid");
                assert_eq!(preds[0].var_name, "premium");
                assert_eq!(preds[0].var_column, "id");
                assert!(!preds[0].negated);
            }
            _ => panic!("expected KeepIn"),
        }
    }

    #[test]
    fn parse_context_keep_not_in_membership() {
        let ctx = parse_context(
            "non_premium",
            "KEEP(fact_sales, fact_sales[productid] NOT IN premium[id])",
        )
        .unwrap();
        match &ctx.operations()[0] {
            ContextOp::KeepIn(preds) => assert!(preds[0].negated),
            _ => panic!("expected KeepIn"),
        }
    }

    #[test]
    fn parse_context_keep_mixed_filters_and_in() {
        // One KEEP mixing a comparison filter and an IN membership yields a
        // Keep op followed by a KeepIn op.
        let ctx = parse_context(
            "mixed",
            r#"KEEP(fact_sales, fact_sales[year] = 2024, fact_sales[productid] IN premium[id])"#,
        )
        .unwrap();
        assert_eq!(ctx.operations().len(), 2);
        assert!(matches!(&ctx.operations()[0], ContextOp::Keep(f) if f.len() == 1));
        assert!(matches!(&ctx.operations()[1], ContextOp::KeepIn(p) if p.len() == 1));
    }

    #[test]
    fn parse_context_keep_dynamic_username() {
        let ctx = parse_context(
            "own_rows",
            "KEEP(dim_user, dim_user[login] = USERNAME())",
        )
        .unwrap();
        match &ctx.operations()[0] {
            ContextOp::Keep(filters) => {
                assert_eq!(
                    filters[0].dynamic,
                    Some(crate::compute::expression::DynamicValue::Username)
                );
            }
            _ => panic!("expected Keep"),
        }
    }

    #[test]
    fn parse_context_keep_dynamic_customdata() {
        let ctx = parse_context(
            "tenant_rows",
            "KEEP(dim_tenant, dim_tenant[key] = CUSTOMDATA())",
        )
        .unwrap();
        match &ctx.operations()[0] {
            ContextOp::Keep(filters) => {
                assert_eq!(
                    filters[0].dynamic,
                    Some(crate::compute::expression::DynamicValue::CustomData)
                );
            }
            _ => panic!("expected Keep"),
        }
    }

    #[test]
    fn parse_context_userelationship() {
        let ctx = parse_context("ship_dates", r#"USERELATIONSHIP("ShipDate")"#).unwrap();
        assert_eq!(
            ctx.operations()[0],
            ContextOp::UseRelationship("ShipDate".into())
        );
    }

    #[test]
    fn context_definition_to_text_round_trips() {
        use crate::compute::expression::InPredicate;
        use crate::model::context::ClearTarget;

        let ctx = ContextDefinition::new(
            "everything",
            vec![
                ContextOp::Inherit("ctx_base".into()),
                ContextOp::Keep(vec![
                    FilterPredicate::new("dim_product", "categoryname", ComparisonOp::Equal, "Bikes"),
                    FilterPredicate::new("dim_date", "year", ComparisonOp::GreaterThanOrEqual, "2024"),
                    FilterPredicate::username("dim_user", "login", ComparisonOp::Equal),
                    FilterPredicate::custom_data("dim_tenant", "key", ComparisonOp::Equal),
                ]),
                ContextOp::KeepIn(vec![
                    InPredicate::new("fact_sales", "productid", "premium", "id"),
                    InPredicate::new("fact_sales", "customerid", "vips", "id").with_negated(true),
                ]),
                ContextOp::Clear(vec![
                    ClearTarget::Column {
                        table: "dim_date".into(),
                        column: "year".into(),
                    },
                    ClearTarget::Table("dim_geo".into()),
                ]),
                ContextOp::ClearInner(vec![ClearTarget::Table("dim_date".into())]),
                ContextOp::ClearOuter(vec![ClearTarget::Column {
                    table: "fact_sales".into(),
                    column: "region".into(),
                }]),
                ContextOp::Reset,
                ContextOp::ResetInner,
                ContextOp::ResetOuter,
                ContextOp::UseRelationship("ShipDate".into()),
            ],
        );

        let text = ctx.to_text();
        let reparsed = parse_context("everything", &text)
            .unwrap_or_else(|e| panic!("serialized text failed to parse: {e}\ntext: {text}"));
        assert_eq!(&ctx, &reparsed, "round-trip mismatch for: {text}");
    }

    #[test]
    fn context_to_text_quotes_strings_and_bares_numbers() {
        let ctx = ContextDefinition::new(
            "vals",
            vec![ContextOp::Keep(vec![
                FilterPredicate::new("t", "a", ComparisonOp::Equal, "Bikes"),
                FilterPredicate::new("t", "b", ComparisonOp::Equal, "2024"),
                FilterPredicate::new("t", "c", ComparisonOp::Equal, "1.5"),
                // Not the canonical number form — must stay quoted to survive.
                FilterPredicate::new("t", "d", ComparisonOp::Equal, "007"),
            ])],
        );
        let text = ctx.to_text();
        assert_eq!(
            text,
            r#"KEEP(t, t[a] = "Bikes", t[b] = 2024, t[c] = 1.5, t[d] = "007")"#
        );
        assert_eq!(parse_context("vals", &text).unwrap(), ctx);
    }

    #[test]
    fn context_to_text_drops_empty_ops() {
        let ctx = ContextDefinition::new(
            "sparse",
            vec![
                ContextOp::Keep(Vec::new()),
                ContextOp::Reset,
                ContextOp::Clear(Vec::new()),
            ],
        );
        assert_eq!(ctx.to_text(), "RESET()");
    }
}
