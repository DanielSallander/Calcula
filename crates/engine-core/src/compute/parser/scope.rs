//! Measure references, USERELATIONSHIP, ISINSCOPE, and CLEAR_EXCEPT parsing.

use super::context::wrap_context_op;
use super::*;

impl Parser {
    /// Parse `[MeasureName]` or `[MeasureName](context_args...)`.
    ///
    /// A lone `[name]` without a preceding table identifier is a measure reference.
    /// Optional parenthesized context args wrap the reference with context operations.
    pub(super) fn parse_measure_ref(&mut self) -> EngineResult<Expression> {
        self.advance()?; // consume [
        let name = match self.advance()?.clone() {
            Token::Ident(s) => s,
            tok => {
                return Err(
                    self.parse_err_prev(format!("expected measure name inside [], got {tok:?}"))
                );
            }
        };
        self.expect(&Token::RBracket)?;

        let mut result = Expression::MeasureRef(name);

        // Optional context arguments: [MeasureName](KEEP(...), USERELATIONSHIP("rel"), ...)
        if self.peek() == Some(&Token::LParen) {
            self.advance()?; // consume (
            loop {
                let arg_offset = self.offset_at(self.pos);
                let context_arg = self.parse_context_arg()?;
                result = wrap_context_op(result, context_arg, arg_offset)?;
                if self.peek() != Some(&Token::Comma) {
                    break;
                }
                self.advance()?; // consume comma
            }
            self.expect(&Token::RParen)?;
        }

        Ok(result)
    }

    /// Parse `USERELATIONSHIP(expr, "relationship_name")` or
    /// `USERELATIONSHIP("relationship_name")` (as context arg in aggregates).
    pub(super) fn parse_use_relationship_call(&mut self) -> EngineResult<Expression> {
        // First argument: could be a string literal (relationship name when used
        // as context arg) or a full expression (when used as standalone wrapper).
        let first = match self.peek().cloned() {
            Some(Token::StringLit(_)) => {
                // USERELATIONSHIP("rel_name") — context argument form
                let rel_name = match self.advance()?.clone() {
                    Token::StringLit(s) => s,
                    _ => unreachable!(),
                };
                self.expect(&Token::RParen)?;
                return Ok(Expression::UseRelationship {
                    expr: Box::new(expr::lit_int(0)), // placeholder, replaced by wrap_context_op
                    relationship_name: rel_name,
                });
            }
            _ => self.parse_expression()?,
        };
        // USERELATIONSHIP(expr, "rel_name") — standalone wrapper form
        self.expect(&Token::Comma)?;
        let rel_name = match self.advance()?.clone() {
            Token::StringLit(s) => s,
            tok => {
                return Err(self.parse_err_prev(format!(
                    "USERELATIONSHIP: expected string literal for relationship name, got {tok:?}"
                )));
            }
        };
        self.expect(&Token::RParen)?;
        Ok(expr::use_relationship(first, rel_name))
    }

    /// Parse `ISINSCOPE(table[column])`.
    pub(super) fn parse_isinscope_call(&mut self) -> EngineResult<Expression> {
        let table = match self.advance()?.clone() {
            Token::Ident(s) => s,
            tok => {
                return Err(
                    self.parse_err_prev(format!("ISINSCOPE: expected table name, got {tok:?}"))
                );
            }
        };
        self.expect(&Token::LBracket)?;
        let column = match self.advance()?.clone() {
            Token::Ident(s) => s,
            tok => {
                return Err(
                    self.parse_err_prev(format!("ISINSCOPE: expected column name, got {tok:?}"))
                );
            }
        };
        self.expect(&Token::RBracket)?;
        self.expect(&Token::RParen)?;
        Ok(expr::is_in_scope(table, column))
    }

    /// Parse `CLEAREXCEPT(table, col1, col2, ...)` as a context argument.
    ///
    /// Returns a placeholder ClearExcept wrapping Blank — the actual inner
    /// expression is set by `wrap_context_op`.
    pub(super) fn parse_clearexcept_call(&mut self) -> EngineResult<Expression> {
        let table = match self.advance()?.clone() {
            Token::Ident(s) => s,
            tok => {
                return Err(
                    self.parse_err_prev(format!("CLEAREXCEPT: expected table name, got {tok:?}"))
                );
            }
        };
        let mut except_columns = Vec::new();
        while self.peek() == Some(&Token::Comma) {
            self.advance()?; // consume comma
                             // Expect table[column] or just column identifier
            let col_name = match self.advance()?.clone() {
                Token::Ident(s) => {
                    // Could be table[col] or just col
                    if self.peek() == Some(&Token::LBracket) {
                        self.advance()?; // consume [
                        let col = match self.advance()?.clone() {
                            Token::Ident(c) => c,
                            tok => {
                                return Err(self.parse_err_prev(format!(
                                    "CLEAREXCEPT: expected column name, got {tok:?}"
                                )));
                            }
                        };
                        self.expect(&Token::RBracket)?;
                        col
                    } else {
                        s
                    }
                }
                tok => {
                    return Err(self.parse_err_prev(format!(
                        "CLEAREXCEPT: expected column reference, got {tok:?}"
                    )));
                }
            };
            except_columns.push(col_name);
        }
        self.expect(&Token::RParen)?;
        Ok(Expression::ClearExcept {
            expr: Box::new(Expression::Blank),
            table,
            except_columns,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // --- Measure reference tests ---

    #[test]
    fn parse_bare_measure_ref() {
        let expr = parse_measure_expression("[TotalSales]").unwrap();
        assert!(matches!(expr, Expression::MeasureRef(ref name) if name == "TotalSales"));
    }

    #[test]
    fn parse_measure_ref_with_keep() {
        let expr = parse_measure_expression("[TotalSales](KEEP(dim, dim[year] = 2014))").unwrap();
        assert!(matches!(expr, Expression::Keep { .. }));
        if let Expression::Keep { expr: inner, .. } = &expr {
            assert!(matches!(**inner, Expression::MeasureRef(ref n) if n == "TotalSales"));
        }
    }

    #[test]
    fn parse_measure_ref_with_userelationship() {
        let expr = parse_measure_expression("[TotalSales](USERELATIONSHIP(\"Sales_Dates_Ship\"))")
            .unwrap();
        assert!(matches!(expr, Expression::UseRelationship { .. }));
        if let Expression::UseRelationship {
            expr: inner,
            relationship_name,
        } = &expr
        {
            assert!(matches!(**inner, Expression::MeasureRef(ref n) if n == "TotalSales"));
            assert_eq!(relationship_name, "Sales_Dates_Ship");
        }
    }

    #[test]
    fn parse_measure_ref_with_multiple_context_ops() {
        let expr = parse_measure_expression(
            "[TotalSales](USERELATIONSHIP(\"rel\"), KEEP(dim, dim[y] = 2024))",
        )
        .unwrap();
        // Outer should be Keep (last context arg wraps outermost)
        assert!(matches!(expr, Expression::Keep { .. }));
        if let Expression::Keep { expr: inner, .. } = &expr {
            // Inner should be UseRelationship
            assert!(matches!(**inner, Expression::UseRelationship { .. }));
        }
    }

    #[test]
    fn parse_measure_ref_in_arithmetic() {
        let expr = parse_measure_expression("[A] + [B]").unwrap();
        assert!(matches!(expr, Expression::BinaryOp { .. }));
        if let Expression::BinaryOp { left, right, .. } = &expr {
            assert!(matches!(**left, Expression::MeasureRef(ref n) if n == "A"));
            assert!(matches!(**right, Expression::MeasureRef(ref n) if n == "B"));
        }
    }
}
