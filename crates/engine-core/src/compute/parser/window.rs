//! Window function parsing (WINDOW, OFFSET, INDEX, RANK) and clause helpers.

use super::*;

impl Parser {
    /// Parse `table[column]` pairs for ORDERBY/PARTITIONBY clauses.
    fn parse_table_column_pairs(&mut self) -> EngineResult<Vec<(String, String)>> {
        let mut pairs = Vec::new();
        loop {
            let table = match self.advance()?.clone() {
                Token::Ident(s) => s,
                tok => {
                    return Err(self.parse_err_prev(format!("expected table name, got {tok:?}")));
                }
            };
            self.expect(&Token::LBracket)?;
            let column = match self.advance()?.clone() {
                Token::Ident(s) => s,
                tok => {
                    return Err(self.parse_err_prev(format!("expected column name, got {tok:?}")));
                }
            };
            self.expect(&Token::RBracket)?;
            pairs.push((table, column));

            if self.peek() == Some(&Token::Comma) {
                self.advance()?;
            } else {
                break;
            }
        }
        Ok(pairs)
    }

    /// Parse `ORDERBY(table[col], ...)` clause.
    fn parse_orderby_clause(&mut self) -> EngineResult<Vec<(String, String)>> {
        self.expect(&Token::LParen)?;
        let pairs = self.parse_table_column_pairs()?;
        self.expect(&Token::RParen)?;
        if pairs.is_empty() {
            return Err(self.parse_err("ORDERBY requires at least one column"));
        }
        Ok(pairs)
    }

    /// Parse `PARTITIONBY(table[col], ...)` clause.
    fn parse_partitionby_clause(&mut self) -> EngineResult<Vec<(String, String)>> {
        self.expect(&Token::LParen)?;
        let pairs = self.parse_table_column_pairs()?;
        self.expect(&Token::RParen)?;
        if pairs.is_empty() {
            return Err(self.parse_err("PARTITIONBY requires at least one column"));
        }
        Ok(pairs)
    }

    /// Parse `ROWS(from, from_type, to, to_type)` frame specification.
    fn parse_rows_clause(&mut self) -> EngineResult<WindowFrame> {
        use crate::compute::expression::BoundaryType;

        self.expect(&Token::LParen)?;

        // Parse `from` (integer).
        let from = match self.advance()?.clone() {
            Token::Number(v) => v as i64,
            Token::Minus => {
                let v = match self.advance()?.clone() {
                    Token::Number(v) => v as i64,
                    tok => {
                        return Err(self.parse_err_prev(format!(
                            "expected integer after '-' in ROWS, got {tok:?}"
                        )));
                    }
                };
                -v
            }
            tok => {
                return Err(
                    self.parse_err_prev(format!("expected integer for ROWS from, got {tok:?}"))
                );
            }
        };

        self.expect(&Token::Comma)?;

        // Parse `from_type` (REL or ABS).
        let from_type = match self.advance()?.clone() {
            Token::Ident(ref s) if s.eq_ignore_ascii_case("REL") => BoundaryType::Rel,
            Token::Ident(ref s) if s.eq_ignore_ascii_case("ABS") => BoundaryType::Abs,
            tok => {
                return Err(self.parse_err_prev(format!(
                    "expected REL or ABS for ROWS from_type, got {tok:?}"
                )));
            }
        };

        self.expect(&Token::Comma)?;

        // Parse `to` (integer).
        let to = match self.advance()?.clone() {
            Token::Number(v) => v as i64,
            Token::Minus => {
                let v = match self.advance()?.clone() {
                    Token::Number(v) => v as i64,
                    tok => {
                        return Err(self.parse_err_prev(format!(
                            "expected integer after '-' in ROWS, got {tok:?}"
                        )));
                    }
                };
                -v
            }
            tok => {
                return Err(
                    self.parse_err_prev(format!("expected integer for ROWS to, got {tok:?}"))
                );
            }
        };

        self.expect(&Token::Comma)?;

        // Parse `to_type` (REL or ABS).
        let to_type = match self.advance()?.clone() {
            Token::Ident(ref s) if s.eq_ignore_ascii_case("REL") => BoundaryType::Rel,
            Token::Ident(ref s) if s.eq_ignore_ascii_case("ABS") => BoundaryType::Abs,
            tok => {
                return Err(self
                    .parse_err_prev(format!("expected REL or ABS for ROWS to_type, got {tok:?}")));
            }
        };

        self.expect(&Token::RParen)?;

        Ok(WindowFrame {
            from,
            from_type,
            to,
            to_type,
        })
    }

    /// Parse `WINDOW(inner, agg_func, ORDERBY(...), [PARTITIONBY(...)], [ROWS(...)])`.
    pub(super) fn parse_window_call(&mut self) -> EngineResult<Expression> {
        // Parse inner measure expression.
        let inner = self.parse_expression()?;
        self.expect(&Token::Comma)?;

        // Parse window aggregate function name.
        let func = match self.advance()?.clone() {
            Token::Ident(ref s) => match s.to_uppercase().as_str() {
                "SUM" => AggregateOp::Sum,
                "AVG" | "AVERAGE" => AggregateOp::Average,
                "MIN" => AggregateOp::Min,
                "MAX" => AggregateOp::Max,
                "COUNT" => AggregateOp::Count,
                other => {
                    return Err(self.parse_err_prev(format!(
                        "unsupported window aggregate function: {other}"
                    )));
                }
            },
            tok => {
                return Err(self.parse_err_prev(format!(
                    "expected aggregate function name in WINDOW, got {tok:?}"
                )));
            }
        };

        self.expect(&Token::Comma)?;

        // Expect ORDERBY keyword.
        match self.advance()?.clone() {
            Token::Ident(ref s) if s.eq_ignore_ascii_case("ORDERBY") => {}
            tok => {
                return Err(self.parse_err_prev(format!("expected ORDERBY in WINDOW, got {tok:?}")));
            }
        }
        let order_by = self.parse_orderby_clause()?;

        // Optional PARTITIONBY and ROWS clauses.
        let mut partition_by = Vec::new();
        let mut frame = None;

        while self.peek() == Some(&Token::Comma) {
            self.advance()?; // consume comma
            match self.peek().cloned() {
                Some(Token::Ident(ref s)) if s.eq_ignore_ascii_case("PARTITIONBY") => {
                    self.advance()?;
                    partition_by = self.parse_partitionby_clause()?;
                }
                Some(Token::Ident(ref s)) if s.eq_ignore_ascii_case("ROWS") => {
                    self.advance()?;
                    frame = Some(self.parse_rows_clause()?);
                }
                other => {
                    return Err(self.parse_err(format!(
                        "expected PARTITIONBY or ROWS in WINDOW, got {other:?}"
                    )));
                }
            }
        }

        self.expect(&Token::RParen)?;

        Ok(expr::window_expr(
            inner,
            func,
            order_by,
            partition_by,
            frame,
        ))
    }

    /// Parse `OFFSET(inner, delta, ORDERBY(...), [PARTITIONBY(...)])`.
    pub(super) fn parse_offset_call(&mut self) -> EngineResult<Expression> {
        let inner = self.parse_expression()?;
        self.expect(&Token::Comma)?;

        // Parse delta (integer, possibly negative).
        let delta = match self.advance()?.clone() {
            Token::Number(v) => v as i64,
            Token::Minus => {
                let v = match self.advance()?.clone() {
                    Token::Number(v) => v as i64,
                    tok => {
                        return Err(self.parse_err_prev(format!(
                            "expected integer after '-' in OFFSET delta, got {tok:?}"
                        )));
                    }
                };
                -v
            }
            tok => {
                return Err(
                    self.parse_err_prev(format!("expected integer for OFFSET delta, got {tok:?}"))
                );
            }
        };

        self.expect(&Token::Comma)?;

        // Expect ORDERBY.
        match self.advance()?.clone() {
            Token::Ident(ref s) if s.eq_ignore_ascii_case("ORDERBY") => {}
            tok => {
                return Err(self.parse_err_prev(format!("expected ORDERBY in OFFSET, got {tok:?}")));
            }
        }
        let order_by = self.parse_orderby_clause()?;

        // Optional PARTITIONBY.
        let mut partition_by = Vec::new();
        if self.peek() == Some(&Token::Comma) {
            self.advance()?;
            match self.advance()?.clone() {
                Token::Ident(ref s) if s.eq_ignore_ascii_case("PARTITIONBY") => {
                    partition_by = self.parse_partitionby_clause()?;
                }
                tok => {
                    return Err(
                        self.parse_err_prev(format!("expected PARTITIONBY in OFFSET, got {tok:?}"))
                    );
                }
            }
        }

        self.expect(&Token::RParen)?;

        Ok(expr::offset_expr(inner, delta, order_by, partition_by))
    }

    /// Parse `INDEX(inner, position, ORDERBY(...), [PARTITIONBY(...)])`.
    pub(super) fn parse_index_call(&mut self) -> EngineResult<Expression> {
        let inner = self.parse_expression()?;
        self.expect(&Token::Comma)?;

        // Parse position (integer, possibly negative).
        let position = match self.advance()?.clone() {
            Token::Number(v) => v as i64,
            Token::Minus => {
                let v = match self.advance()?.clone() {
                    Token::Number(v) => v as i64,
                    tok => {
                        return Err(self.parse_err_prev(format!(
                            "expected integer after '-' in INDEX position, got {tok:?}"
                        )));
                    }
                };
                -v
            }
            tok => {
                return Err(self
                    .parse_err_prev(format!("expected integer for INDEX position, got {tok:?}")));
            }
        };

        self.expect(&Token::Comma)?;

        // Expect ORDERBY.
        match self.advance()?.clone() {
            Token::Ident(ref s) if s.eq_ignore_ascii_case("ORDERBY") => {}
            tok => {
                return Err(self.parse_err_prev(format!("expected ORDERBY in INDEX, got {tok:?}")));
            }
        }
        let order_by = self.parse_orderby_clause()?;

        // Optional PARTITIONBY.
        let mut partition_by = Vec::new();
        if self.peek() == Some(&Token::Comma) {
            self.advance()?;
            match self.advance()?.clone() {
                Token::Ident(ref s) if s.eq_ignore_ascii_case("PARTITIONBY") => {
                    partition_by = self.parse_partitionby_clause()?;
                }
                tok => {
                    return Err(
                        self.parse_err_prev(format!("expected PARTITIONBY in INDEX, got {tok:?}"))
                    );
                }
            }
        }

        self.expect(&Token::RParen)?;

        Ok(expr::index_expr(inner, position, order_by, partition_by))
    }

    /// Parse ranking window: `ROW_NUMBER(ORDERBY(...), [PARTITIONBY(...)])` etc.
    pub(super) fn parse_rank_window_call(
        &mut self,
        function: expr::RankFunction,
    ) -> EngineResult<Expression> {
        // Parse ORDERBY clause — required.
        match self.advance()?.clone() {
            Token::Ident(ref s) if s.eq_ignore_ascii_case("ORDERBY") => {}
            tok => {
                return Err(
                    self.parse_err_prev(format!("{function}: expected ORDERBY, got {tok:?}"))
                );
            }
        }
        let order_by = self.parse_orderby_clause()?;

        // Optional PARTITIONBY clause.
        let mut partition_by = Vec::new();
        if self.peek() == Some(&Token::Comma) {
            self.advance()?;
            match self.peek().cloned() {
                Some(Token::Ident(ref s)) if s.eq_ignore_ascii_case("PARTITIONBY") => {
                    self.advance()?;
                    partition_by = self.parse_partitionby_clause()?;
                }
                other => {
                    return Err(
                        self.parse_err(format!("{function}: expected PARTITIONBY, got {other:?}"))
                    );
                }
            }
        }

        self.expect(&Token::RParen)?;
        Ok(Expression::RankWindow {
            function,
            order_by,
            partition_by,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // --- Window function parser tests ---

    #[test]
    fn parse_window_basic() {
        let expr =
            parse_measure_expression("WINDOW(SUM(fact[amount]), SUM, ORDERBY(dim_date[month]))")
                .unwrap();
        if let Expression::Window {
            inner,
            function,
            order_by,
            partition_by,
            frame,
        } = &expr
        {
            assert!(matches!(**inner, Expression::Aggregate { .. }));
            assert_eq!(*function, AggregateOp::Sum);
            assert_eq!(order_by, &[("dim_date".to_string(), "month".to_string())]);
            assert!(partition_by.is_empty());
            assert!(frame.is_none());
        } else {
            panic!("expected Window, got {expr:?}");
        }
    }

    #[test]
    fn parse_window_with_partitionby() {
        let expr = parse_measure_expression(
            "WINDOW(SUM(fact[amount]), AVG, ORDERBY(dim_date[month]), PARTITIONBY(dim_date[year]))",
        )
        .unwrap();
        if let Expression::Window {
            function,
            order_by,
            partition_by,
            ..
        } = &expr
        {
            assert_eq!(*function, AggregateOp::Average);
            assert_eq!(order_by.len(), 1);
            assert_eq!(
                partition_by,
                &[("dim_date".to_string(), "year".to_string())]
            );
        } else {
            panic!("expected Window");
        }
    }

    #[test]
    fn parse_window_with_rows() {
        let expr = parse_measure_expression(
            "WINDOW(SUM(fact[amount]), AVG, ORDERBY(dim[month]), ROWS(-2, REL, 0, REL))",
        )
        .unwrap();
        if let Expression::Window { frame, .. } = &expr {
            let f = frame.as_ref().expect("frame should be present");
            assert_eq!(f.from, -2);
            assert_eq!(f.from_type, crate::compute::expression::BoundaryType::Rel);
            assert_eq!(f.to, 0);
            assert_eq!(f.to_type, crate::compute::expression::BoundaryType::Rel);
        } else {
            panic!("expected Window");
        }
    }

    #[test]
    fn parse_window_with_partitionby_and_rows() {
        let expr = parse_measure_expression(
            "WINDOW(SUM(fact[x]), SUM, ORDERBY(d[m]), PARTITIONBY(d[y]), ROWS(1, ABS, 0, REL))",
        )
        .unwrap();
        if let Expression::Window {
            partition_by,
            frame,
            ..
        } = &expr
        {
            assert_eq!(partition_by.len(), 1);
            let f = frame.as_ref().unwrap();
            assert_eq!(f.from, 1);
            assert_eq!(f.from_type, crate::compute::expression::BoundaryType::Abs);
        } else {
            panic!("expected Window");
        }
    }

    #[test]
    fn parse_offset_basic() {
        let expr =
            parse_measure_expression("OFFSET(SUM(fact[amount]), -1, ORDERBY(dim_date[month]))")
                .unwrap();
        if let Expression::Offset {
            delta,
            order_by,
            partition_by,
            ..
        } = &expr
        {
            assert_eq!(*delta, -1);
            assert_eq!(order_by.len(), 1);
            assert!(partition_by.is_empty());
        } else {
            panic!("expected Offset, got {expr:?}");
        }
    }

    #[test]
    fn parse_offset_with_partitionby() {
        let expr =
            parse_measure_expression("OFFSET(SUM(fact[x]), -1, ORDERBY(d[m]), PARTITIONBY(d[y]))")
                .unwrap();
        if let Expression::Offset {
            delta,
            partition_by,
            ..
        } = &expr
        {
            assert_eq!(*delta, -1);
            assert_eq!(partition_by.len(), 1);
        } else {
            panic!("expected Offset");
        }
    }

    #[test]
    fn parse_offset_positive_delta() {
        let expr = parse_measure_expression("OFFSET(SUM(fact[x]), 2, ORDERBY(d[m]))").unwrap();
        if let Expression::Offset { delta, .. } = &expr {
            assert_eq!(*delta, 2);
        } else {
            panic!("expected Offset");
        }
    }

    #[test]
    fn parse_index_basic() {
        let expr =
            parse_measure_expression("INDEX(SUM(fact[amount]), 1, ORDERBY(dim_date[month]))")
                .unwrap();
        if let Expression::Index {
            position,
            order_by,
            partition_by,
            ..
        } = &expr
        {
            assert_eq!(*position, 1);
            assert_eq!(order_by.len(), 1);
            assert!(partition_by.is_empty());
        } else {
            panic!("expected Index, got {expr:?}");
        }
    }

    #[test]
    fn parse_index_negative_position() {
        let expr = parse_measure_expression("INDEX(SUM(fact[x]), -1, ORDERBY(d[m]))").unwrap();
        if let Expression::Index { position, .. } = &expr {
            assert_eq!(*position, -1);
        } else {
            panic!("expected Index");
        }
    }

    #[test]
    fn parse_index_with_partitionby() {
        let expr =
            parse_measure_expression("INDEX(SUM(fact[x]), 1, ORDERBY(d[m]), PARTITIONBY(d[y]))")
                .unwrap();
        if let Expression::Index { partition_by, .. } = &expr {
            assert_eq!(partition_by.len(), 1);
        } else {
            panic!("expected Index");
        }
    }

    #[test]
    fn parse_window_multiple_orderby_cols() {
        let expr = parse_measure_expression("WINDOW(SUM(f[x]), SUM, ORDERBY(d[y], d[m]))").unwrap();
        if let Expression::Window { order_by, .. } = &expr {
            assert_eq!(order_by.len(), 2);
            assert_eq!(order_by[0], ("d".to_string(), "y".to_string()));
            assert_eq!(order_by[1], ("d".to_string(), "m".to_string()));
        } else {
            panic!("expected Window");
        }
    }
}
