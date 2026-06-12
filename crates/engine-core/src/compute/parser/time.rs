//! Time-intelligence function parsing: `YTD`, `QTD`, `MTD`, `PRIORYEAR`,
//! `PRIORPERIOD`.
//!
//! These parse to the [`Expression::ToDate`] / [`Expression::PeriodShift`]
//! sugar variants, which the engine lowers onto the Window/Offset machinery
//! at execution time (see `compute::time_intelligence`).

use crate::compute::expression::DateGranularity;

use super::*;

impl Parser {
    /// Parse `YTD(expr)` / `QTD(expr)` / `MTD(expr)` (the opening `(` has
    /// been consumed by the function-call dispatcher).
    pub(super) fn parse_to_date_call(
        &mut self,
        granularity: DateGranularity,
    ) -> EngineResult<Expression> {
        let inner = self.parse_expression()?;
        self.expect(&Token::RParen)?;
        Ok(expr::to_date(inner, granularity))
    }

    /// Parse `PRIORYEAR(expr)` — sugar for `PRIORPERIOD(expr, -1, YEAR)`.
    pub(super) fn parse_prioryear_call(&mut self) -> EngineResult<Expression> {
        let inner = self.parse_expression()?;
        self.expect(&Token::RParen)?;
        Ok(expr::period_shift(inner, -1, DateGranularity::Year))
    }

    /// Parse `PRIORPERIOD(expr, n, YEAR|QUARTER|MONTH)`.
    ///
    /// `n` is an integer shift: negative = earlier periods, positive =
    /// later. The interval keyword is allow-listed (like `DATEADD`'s) and
    /// may be written bare (`YEAR`) or quoted (`"YEAR"`), case-insensitive.
    pub(super) fn parse_priorperiod_call(&mut self) -> EngineResult<Expression> {
        let inner = self.parse_expression()?;
        self.expect(&Token::Comma)?;

        // Shift amount: integer, possibly negative.
        let offset = match self.advance()?.clone() {
            Token::Number(v) => v as i64,
            Token::Minus => {
                let v = match self.advance()?.clone() {
                    Token::Number(v) => v as i64,
                    tok => {
                        return Err(self.parse_err_prev(format!(
                            "PRIORPERIOD: expected integer after '-' for shift, got {tok:?}"
                        )));
                    }
                };
                -v
            }
            tok => {
                return Err(self
                    .parse_err_prev(format!("PRIORPERIOD: expected integer shift, got {tok:?}")));
            }
        };

        self.expect(&Token::Comma)?;

        // Interval keyword (bare identifier or string literal), allow-listed.
        let granularity = match self.advance()?.clone() {
            Token::Ident(s) | Token::StringLit(s) => match s.to_uppercase().as_str() {
                "YEAR" => DateGranularity::Year,
                "QUARTER" => DateGranularity::Quarter,
                "MONTH" => DateGranularity::Month,
                _ => {
                    return Err(self.parse_err_prev(format!(
                        "PRIORPERIOD: invalid interval '{s}' — expected YEAR, QUARTER, or MONTH"
                    )));
                }
            },
            tok => {
                return Err(self.parse_err_prev(format!(
                    "PRIORPERIOD: expected interval keyword (YEAR, QUARTER, or MONTH), \
                     got {tok:?}"
                )));
            }
        };

        self.expect(&Token::RParen)?;
        Ok(expr::period_shift(inner, offset, granularity))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::compute::expression::DateGranularity;

    #[test]
    fn parse_ytd_basic() {
        let expr = parse_measure_expression("YTD(SUM(fact_sales[amount]))").unwrap();
        let Expression::ToDate {
            expr: inner,
            granularity,
        } = &expr
        else {
            panic!("expected ToDate, got {expr:?}");
        };
        assert_eq!(*granularity, DateGranularity::Year);
        assert!(matches!(inner.as_ref(), Expression::Aggregate { .. }));
        assert!(expr.has_window(), "time intel must route as window-ish");
    }

    #[test]
    fn parse_qtd_and_mtd() {
        let qtd = parse_measure_expression("QTD(SUM(f[x]))").unwrap();
        assert!(matches!(
            qtd,
            Expression::ToDate {
                granularity: DateGranularity::Quarter,
                ..
            }
        ));
        let mtd = parse_measure_expression("mtd(SUM(f[x]))").unwrap();
        assert!(matches!(
            mtd,
            Expression::ToDate {
                granularity: DateGranularity::Month,
                ..
            }
        ));
    }

    #[test]
    fn parse_prioryear() {
        let expr = parse_measure_expression("PRIORYEAR(SUM(fact_sales[amount]))").unwrap();
        let Expression::PeriodShift {
            offset,
            granularity,
            ..
        } = &expr
        else {
            panic!("expected PeriodShift, got {expr:?}");
        };
        assert_eq!(*offset, -1);
        assert_eq!(*granularity, DateGranularity::Year);
    }

    #[test]
    fn parse_priorperiod_bare_interval() {
        let expr = parse_measure_expression("PRIORPERIOD(SUM(f[x]), -2, QUARTER)").unwrap();
        let Expression::PeriodShift {
            offset,
            granularity,
            ..
        } = &expr
        else {
            panic!("expected PeriodShift, got {expr:?}");
        };
        assert_eq!(*offset, -2);
        assert_eq!(*granularity, DateGranularity::Quarter);
    }

    #[test]
    fn parse_priorperiod_quoted_interval_case_insensitive() {
        let expr = parse_measure_expression("PRIORPERIOD(SUM(f[x]), 1, \"month\")").unwrap();
        let Expression::PeriodShift {
            offset,
            granularity,
            ..
        } = &expr
        else {
            panic!("expected PeriodShift");
        };
        assert_eq!(*offset, 1);
        assert_eq!(*granularity, DateGranularity::Month);
    }

    #[test]
    fn parse_priorperiod_bad_interval_positions_error() {
        let input = "PRIORPERIOD(SUM(f[x]), -1, FORTNIGHT)";
        let err = parse_measure_expression(input).unwrap_err();
        let EngineError::ParseError { position, message } = err else {
            panic!("expected ParseError, got {err:?}");
        };
        assert!(
            message.contains("invalid interval 'FORTNIGHT'"),
            "got: {message}"
        );
        // Positioned on the interval token itself.
        assert_eq!(position, input.find("FORTNIGHT").unwrap());
    }

    #[test]
    fn parse_priorperiod_missing_shift_errors() {
        assert!(parse_measure_expression("PRIORPERIOD(SUM(f[x]), YEAR)").is_err());
    }

    #[test]
    fn parse_ytd_missing_paren_errors() {
        assert!(parse_measure_expression("YTD(SUM(f[x])").is_err());
    }

    #[test]
    fn ytd_round_trips_through_measure_source_reparse() {
        // YTD survives the parse → validate path used by model loading.
        let expr = parse_measure_expression("YTD(SUM(fact_sales[amount]))").unwrap();
        assert!(expr.validate().is_ok());
    }
}
