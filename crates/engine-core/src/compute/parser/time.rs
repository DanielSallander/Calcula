//! Time-intelligence function parsing: `YTD`, `QTD`, `MTD`, `WTD`,
//! `PRIORYEAR`, `SAMEPERIODLASTYEAR`, `PRIORPERIOD`, `DATESINPERIOD`,
//! `DATESBETWEEN`.
//!
//! These parse to the [`Expression::ToDate`] / [`Expression::PeriodShift`] /
//! [`Expression::DatesInPeriod`] / [`Expression::DatesBetween`] sugar
//! variants, which the engine lowers onto the Window/Offset machinery (axis
//! path) or a concrete date-range filter (filter-context path) at execution
//! time (see `compute::time_intelligence`).

use chrono::NaiveDate;

use crate::compute::expression::DateGranularity;

use super::*;

impl Parser {
    /// Parse `YTD(expr)` / `QTD(expr)` / `MTD(expr)` / `WTD(expr)` (the
    /// opening `(` has been consumed by the function-call dispatcher).
    pub(super) fn parse_to_date_call(
        &mut self,
        granularity: DateGranularity,
    ) -> EngineResult<Expression> {
        let inner = self.parse_expression()?;
        self.expect(&Token::RParen)?;
        Ok(expr::to_date(inner, granularity))
    }

    /// Parse `PRIORYEAR(expr)` — sugar for `PRIORPERIOD(expr, -1, YEAR)`.
    ///
    /// `SAMEPERIODLASTYEAR(expr)` is a synonym: it dispatches here and produces
    /// the identical `PeriodShift { offset: -1, granularity: Year }`. In the
    /// filter-context path a year shift moves the *entire* current date window
    /// back one year, which is exactly the "same period, last year" semantics.
    pub(super) fn parse_prioryear_call(&mut self) -> EngineResult<Expression> {
        let inner = self.parse_expression()?;
        self.expect(&Token::RParen)?;
        Ok(expr::period_shift(inner, -1, DateGranularity::Year))
    }

    /// Parse `CLOSINGBALANCE(expr)` / `OPENINGBALANCE(expr)` — a single-argument
    /// semi-additive balance pinned to the last (closing) / first (opening) date
    /// of the current context.
    pub(super) fn parse_balance_call(&mut self, opening: bool) -> EngineResult<Expression> {
        let inner = self.parse_expression()?;
        self.expect(&Token::RParen)?;
        Ok(if opening {
            expr::opening_balance(inner)
        } else {
            expr::closing_balance(inner)
        })
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
                "WEEK" => DateGranularity::Week,
                _ => {
                    return Err(self.parse_err_prev(format!(
                        "PRIORPERIOD: invalid interval '{s}' — expected YEAR, QUARTER, MONTH, \
                         or WEEK"
                    )));
                }
            },
            tok => {
                return Err(self.parse_err_prev(format!(
                    "PRIORPERIOD: expected interval keyword (YEAR, QUARTER, MONTH, or WEEK), \
                     got {tok:?}"
                )));
            }
        };

        self.expect(&Token::RParen)?;
        Ok(expr::period_shift(inner, offset, granularity))
    }

    /// Parse `DATESINPERIOD(expr, intervals, YEAR|QUARTER|MONTH)`.
    ///
    /// `intervals` is a (typically negative) integer count of periods in a
    /// trailing window ending at the current context's as-of date — e.g.
    /// `DATESINPERIOD(SUM(Sales[amount]), -12, MONTH)` is the trailing 12
    /// months. The interval keyword is allow-listed like `PRIORPERIOD`'s.
    pub(super) fn parse_dates_in_period_call(&mut self) -> EngineResult<Expression> {
        let inner = self.parse_expression()?;
        self.expect(&Token::Comma)?;

        // Interval count: integer, possibly negative.
        let intervals = match self.advance()?.clone() {
            Token::Number(v) => v as i64,
            Token::Minus => {
                let v = match self.advance()?.clone() {
                    Token::Number(v) => v as i64,
                    tok => {
                        return Err(self.parse_err_prev(format!(
                            "DATESINPERIOD: expected integer after '-' for the interval count, \
                             got {tok:?}"
                        )));
                    }
                };
                -v
            }
            tok => {
                return Err(self.parse_err_prev(format!(
                    "DATESINPERIOD: expected an integer interval count, got {tok:?}"
                )));
            }
        };

        self.expect(&Token::Comma)?;

        let granularity = match self.advance()?.clone() {
            Token::Ident(s) | Token::StringLit(s) => match s.to_uppercase().as_str() {
                "YEAR" => DateGranularity::Year,
                "QUARTER" => DateGranularity::Quarter,
                "MONTH" => DateGranularity::Month,
                "WEEK" => DateGranularity::Week,
                _ => {
                    return Err(self.parse_err_prev(format!(
                        "DATESINPERIOD: invalid interval '{s}' — expected YEAR, QUARTER, MONTH, \
                         or WEEK"
                    )));
                }
            },
            tok => {
                return Err(self.parse_err_prev(format!(
                    "DATESINPERIOD: expected interval keyword (YEAR, QUARTER, MONTH, or WEEK), \
                     got {tok:?}"
                )));
            }
        };

        self.expect(&Token::RParen)?;
        Ok(expr::dates_in_period(inner, intervals, granularity))
    }

    /// Parse `DATESBETWEEN(expr, "start", "end")`.
    ///
    /// Both bounds are REQUIRED quoted ISO `YYYY-MM-DD` string literals (an
    /// unquoted date literal would lex as arithmetic). Both must parse as
    /// calendar dates and `start` must not be after `end` — violations are
    /// parse errors, never a silently-empty range.
    pub(super) fn parse_dates_between_call(&mut self) -> EngineResult<Expression> {
        let inner = self.parse_expression()?;
        self.expect(&Token::Comma)?;
        let start = self.parse_dates_between_bound("start")?;
        self.expect(&Token::Comma)?;
        let end = self.parse_dates_between_bound("end")?;

        // Both bounds parsed above; compare as dates, not strings.
        let start_date = NaiveDate::parse_from_str(&start, "%Y-%m-%d").expect("validated");
        let end_date = NaiveDate::parse_from_str(&end, "%Y-%m-%d").expect("validated");
        if start_date > end_date {
            return Err(self.parse_err_prev(format!(
                "DATESBETWEEN: start date \"{start}\" is after end date \"{end}\""
            )));
        }

        self.expect(&Token::RParen)?;
        Ok(expr::dates_between(inner, start, end))
    }

    /// Parse one `DATESBETWEEN` bound: a quoted ISO `YYYY-MM-DD` string
    /// literal, validated as a real calendar date.
    fn parse_dates_between_bound(&mut self, which: &str) -> EngineResult<String> {
        let s = match self.advance()?.clone() {
            Token::StringLit(s) => s,
            tok => {
                return Err(self.parse_err_prev(format!(
                    "DATESBETWEEN: expected a quoted ISO {which} date (\"YYYY-MM-DD\"), \
                     got {tok:?}"
                )));
            }
        };
        if NaiveDate::parse_from_str(&s, "%Y-%m-%d").is_err() {
            return Err(self.parse_err_prev(format!(
                "DATESBETWEEN: invalid {which} date \"{s}\" — expected an ISO calendar date \
                 (YYYY-MM-DD)"
            )));
        }
        Ok(s)
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
    fn parse_closing_and_opening_balance() {
        let closing = parse_measure_expression("CLOSINGBALANCE(SUM(fact_sales[amount]))").unwrap();
        let Expression::SemiAdditiveBalance { opening, .. } = &closing else {
            panic!("expected SemiAdditiveBalance, got {closing:?}");
        };
        assert!(!*opening, "CLOSINGBALANCE is a closing (last-date) balance");

        let opening_expr =
            parse_measure_expression("OPENINGBALANCE(SUM(fact_sales[amount]))").unwrap();
        let Expression::SemiAdditiveBalance { opening, .. } = &opening_expr else {
            panic!("expected SemiAdditiveBalance, got {opening_expr:?}");
        };
        assert!(
            *opening,
            "OPENINGBALANCE is an opening (first-date) balance"
        );
    }

    #[test]
    fn parse_sameperiodlastyear_equals_prioryear() {
        // SAMEPERIODLASTYEAR is a synonym for PRIORYEAR: same PeriodShift node
        // (Expression has no PartialEq, so compare the structural fields).
        let sply = parse_measure_expression("SAMEPERIODLASTYEAR(SUM(fact_sales[amount]))").unwrap();
        let py = parse_measure_expression("PRIORYEAR(SUM(fact_sales[amount]))").unwrap();
        let Expression::PeriodShift {
            offset: sply_offset,
            granularity: sply_gran,
            ..
        } = &sply
        else {
            panic!("expected PeriodShift, got {sply:?}");
        };
        let Expression::PeriodShift {
            offset: py_offset,
            granularity: py_gran,
            ..
        } = &py
        else {
            panic!("expected PeriodShift, got {py:?}");
        };
        assert_eq!(*sply_offset, -1);
        assert_eq!(*sply_gran, DateGranularity::Year);
        assert_eq!(sply_offset, py_offset, "same offset as PRIORYEAR");
        assert_eq!(sply_gran, py_gran, "same granularity as PRIORYEAR");
        assert!(sply.has_window(), "time intel must route as window-ish");
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
    fn parse_parallelperiod_is_a_period_shift() {
        let expr = parse_measure_expression("PARALLELPERIOD(SUM(f[x]), -2, MONTH)").unwrap();
        assert!(
            matches!(
                expr,
                Expression::PeriodShift {
                    offset: -2,
                    granularity: DateGranularity::Month,
                    ..
                }
            ),
            "PARALLELPERIOD should parse to a PeriodShift, got {expr:?}"
        );
    }

    #[test]
    fn parse_dates_in_period() {
        let expr =
            parse_measure_expression("DATESINPERIOD(SUM(fact_sales[amount]), -12, MONTH)").unwrap();
        let Expression::DatesInPeriod {
            intervals,
            granularity,
            ..
        } = &expr
        else {
            panic!("expected DatesInPeriod, got {expr:?}");
        };
        assert_eq!(*intervals, -12);
        assert_eq!(*granularity, DateGranularity::Month);
        assert!(expr.has_window(), "DATESINPERIOD must route as window-ish");
        assert!(expr.validate().is_ok());
    }

    #[test]
    fn parse_dates_in_period_quoted_quarter() {
        let expr = parse_measure_expression("DATESINPERIOD(SUM(f[x]), -4, \"quarter\")").unwrap();
        assert!(matches!(
            expr,
            Expression::DatesInPeriod {
                intervals: -4,
                granularity: DateGranularity::Quarter,
                ..
            }
        ));
    }

    #[test]
    fn parse_dates_in_period_bad_interval_errors() {
        let err = parse_measure_expression("DATESINPERIOD(SUM(f[x]), -1, FORTNIGHT)").unwrap_err();
        let EngineError::ParseError { message, .. } = err else {
            panic!("expected ParseError, got {err:?}");
        };
        assert!(
            message.contains("invalid interval 'FORTNIGHT'"),
            "got: {message}"
        );
    }

    #[test]
    fn parse_wtd_is_week_to_date() {
        let expr = parse_measure_expression("WTD(SUM(fact_sales[amount]))").unwrap();
        let Expression::ToDate {
            expr: inner,
            granularity,
        } = &expr
        else {
            panic!("expected ToDate, got {expr:?}");
        };
        assert_eq!(*granularity, DateGranularity::Week);
        assert!(matches!(inner.as_ref(), Expression::Aggregate { .. }));
        assert!(expr.has_window(), "time intel must route as window-ish");
        assert!(expr.validate().is_ok());
    }

    #[test]
    fn parse_week_interval_in_priorperiod_and_datesinperiod() {
        let pp = parse_measure_expression("PRIORPERIOD(SUM(f[x]), -1, WEEK)").unwrap();
        assert!(matches!(
            pp,
            Expression::PeriodShift {
                offset: -1,
                granularity: DateGranularity::Week,
                ..
            }
        ));
        let dip = parse_measure_expression("DATESINPERIOD(SUM(f[x]), -4, \"week\")").unwrap();
        assert!(matches!(
            dip,
            Expression::DatesInPeriod {
                intervals: -4,
                granularity: DateGranularity::Week,
                ..
            }
        ));
    }

    #[test]
    fn parse_dates_between() {
        let expr = parse_measure_expression(
            "DATESBETWEEN(SUM(fact_sales[amount]), \"2024-01-01\", \"2024-06-30\")",
        )
        .unwrap();
        let Expression::DatesBetween {
            expr: inner,
            start,
            end,
        } = &expr
        else {
            panic!("expected DatesBetween, got {expr:?}");
        };
        assert_eq!(start, "2024-01-01");
        assert_eq!(end, "2024-06-30");
        assert!(matches!(inner.as_ref(), Expression::Aggregate { .. }));
        assert!(expr.has_window(), "DATESBETWEEN must route as window-ish");
        assert!(expr.validate().is_ok());
    }

    #[test]
    fn parse_dates_between_same_day_range_is_valid() {
        // A single-day range (start == end) is a legal inclusive range.
        let expr =
            parse_measure_expression("DATESBETWEEN(SUM(f[x]), \"2024-03-15\", \"2024-03-15\")")
                .unwrap();
        assert!(matches!(expr, Expression::DatesBetween { .. }));
    }

    #[test]
    fn parse_dates_between_invalid_date_positions_error() {
        let input = "DATESBETWEEN(SUM(f[x]), \"2024-02-30\", \"2024-12-31\")";
        let err = parse_measure_expression(input).unwrap_err();
        let EngineError::ParseError { message, .. } = err else {
            panic!("expected ParseError, got {err:?}");
        };
        assert!(
            message.contains("invalid start date \"2024-02-30\""),
            "got: {message}"
        );
    }

    #[test]
    fn parse_dates_between_inverted_range_errors() {
        let err =
            parse_measure_expression("DATESBETWEEN(SUM(f[x]), \"2024-12-31\", \"2024-01-01\")")
                .unwrap_err();
        let EngineError::ParseError { message, .. } = err else {
            panic!("expected ParseError, got {err:?}");
        };
        assert!(message.contains("after end date"), "got: {message}");
    }

    #[test]
    fn parse_dates_between_unquoted_date_errors() {
        // An unquoted date literal lexes as arithmetic — rejected with a
        // message pointing at the quoted-ISO requirement.
        let err = parse_measure_expression("DATESBETWEEN(SUM(f[x]), 2024-01-01, \"2024-12-31\")")
            .unwrap_err();
        let EngineError::ParseError { message, .. } = err else {
            panic!("expected ParseError, got {err:?}");
        };
        assert!(
            message.contains("quoted ISO start date"),
            "got: {message}"
        );
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
