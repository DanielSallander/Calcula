//! Scalar and date/time function enums, their SQL rendering, and interval allow-lists.

use super::*;

/// Scalar math functions for use in expressions.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ScalarFunction {
    /// Absolute value: `ABS(x)`.
    Abs,
    /// Round to N decimal places: `ROUND(x, n)`.
    Round,
    /// Round up (away from zero): `ROUNDUP(x, n)`.
    RoundUp,
    /// Round down (toward zero): `ROUNDDOWN(x, n)`.
    RoundDown,
    /// Truncate to integer: `INT(x)` (equivalent to `FLOOR`).
    Int,
    /// Truncate fractional part: `TRUNC(x [, n])`.
    Trunc,
    /// Round up to nearest multiple: `CEILING(x, significance)`.
    Ceiling,
    /// Round down to nearest multiple: `FLOOR(x, significance)`.
    Floor,
    /// Modulo: `MOD(x, y)`.
    Mod,
    /// Power: `POWER(x, y)`.
    Power,
    /// Square root: `SQRT(x)`.
    Sqrt,
    /// Natural logarithm: `LN(x)`.
    Ln,
    /// Base-10 logarithm: `LOG10(x)`.
    Log10,
    /// Sign: `SIGN(x)`.
    Sign,
    /// Exponential: `EXP(x)` — e^x.
    Exp,
    /// Logarithm with custom base: `LOG(x, base)`.
    Log,
    /// Pi constant: `PI()` — returns 3.14159...
    Pi,
}

/// Date/time functions for use in expressions.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum DateTimeFunction {
    /// Extract year from date: `YEAR(date)`.
    Year,
    /// Extract month from date: `MONTH(date)`.
    Month,
    /// Extract day from date: `DAY(date)`.
    Day,
    /// Extract quarter from date: `QUARTER(date)`.
    Quarter,
    /// Construct a date from parts: `DATE(year, month, day)`.
    Date,
    /// Difference between dates: `DATEDIFF(start, end, interval_string)`.
    /// Interval is passed as a `LiteralString`: `"DAY"`, `"MONTH"`, `"YEAR"`, `"QUARTER"`.
    DateDiff,
    /// Current date: `TODAY()`.
    Today,
    /// Current date and time: `NOW()`.
    Now,
    /// Add an interval to a date: `DATEADD(date, n, "DAY")`.
    /// Interval: DAY, MONTH, YEAR, QUARTER, HOUR, MINUTE, SECOND.
    DateAdd,
    /// Truncate date to period boundary: `DATE_TRUNC(date, "MONTH")`.
    DateTrunc,
    /// Last day of the period containing date: `LAST_DAY(date [, "MONTH"])`.
    LastDay,
    /// End of month with optional offset: `EOMONTH(date [, months])`.
    EoMonth,
    /// Day of the week (0=Sunday..6=Saturday): `DAYOFWEEK(date)`.
    DayOfWeek,
    /// Day of the year (1–366): `DAYOFYEAR(date)`.
    DayOfYear,
    /// ISO week number: `WEEKNUM(date)`.
    WeekNum,
    /// Name of the day: `DAYNAME(date)` — returns text.
    DayName,
    /// Name of the month: `MONTHNAME(date)` — returns text.
    MonthName,
    /// Months between two dates: `MONTHS_BETWEEN(start, end)`.
    MonthsBetween,
}

// --- Date/time interval keyword allow-lists ---
//
// The SQL renderers in [`DateTimeFunction::to_sql_strs`] interpolate these
// interval keywords into SQL **raw** (unquoted), so only allow-listed
// keywords are safe. The parser enforces the same lists inline in
// `parser.rs` (`parse_datediff_call`, `parse_dateadd_call`,
// `parse_datetrunc_call`, `parse_lastday_call`); it matches the keywords
// literally, so the lists are duplicated there. When adding a keyword,
// update BOTH locations — the
// `validate_interval_allow_lists_match_parser` test exercises the sync.

/// Interval keywords accepted by `DATEDIFF(start, end, interval)`.
///
/// Mirrors the parser allow-list in `parser.rs::parse_datediff_call`.
///
/// HOUR/MINUTE/SECOND are deliberately excluded: the SQL renderer
/// (`DateTimeFunction::DateDiff`) has no arms for sub-day intervals, so
/// accepting them would silently fall through to the DAY formula and return
/// days for an hour/minute/second request. Failing closed at parse/validate
/// time keeps the documented DAY/MONTH/YEAR/QUARTER contract honest.
pub(crate) const DATEDIFF_INTERVALS: [&str; 4] = ["DAY", "MONTH", "YEAR", "QUARTER"];

/// Interval keywords accepted by `DATEADD(date, n, interval)`.
///
/// Mirrors the parser allow-list in `parser.rs::parse_dateadd_call`.
pub(crate) const DATEADD_INTERVALS: [&str; 7] = [
    "DAY", "MONTH", "YEAR", "QUARTER", "HOUR", "MINUTE", "SECOND",
];

/// Interval keywords accepted by `DATE_TRUNC(date, interval)`.
///
/// Mirrors the parser allow-list in `parser.rs::parse_datetrunc_call`.
pub(crate) const DATE_TRUNC_INTERVALS: [&str; 8] = [
    "YEAR", "QUARTER", "MONTH", "WEEK", "DAY", "HOUR", "MINUTE", "SECOND",
];

/// Interval keywords accepted by `LAST_DAY(date [, interval])`.
///
/// Mirrors the parser allow-list in `parser.rs::parse_lastday_call`.
pub(crate) const LAST_DAY_INTERVALS: [&str; 4] = ["YEAR", "QUARTER", "MONTH", "WEEK"];

/// Check the interval argument of a date/time function against its
/// allow-list.
///
/// The interval must be a `LiteralString` matching one of the allowed
/// keywords (case-insensitive), because the renderers interpolate it into
/// SQL raw. A missing argument is fine — the renderers fall back to a
/// built-in default keyword.
pub(super) fn validate_interval_keyword(
    function: DateTimeFunction,
    args: &[Expression],
    interval_index: usize,
    allowed: &[&str],
) -> EngineResult<()> {
    match args.get(interval_index) {
        None => Ok(()),
        Some(Expression::LiteralString(s)) if allowed.iter().any(|a| a.eq_ignore_ascii_case(s)) => {
            Ok(())
        }
        Some(Expression::LiteralString(s)) => Err(EngineError::InvalidExpression(format!(
            "{function}: invalid interval '{s}' — expected one of {}",
            allowed.join(", ")
        ))),
        Some(_) => Err(EngineError::InvalidExpression(format!(
            "{function}: interval argument must be a literal keyword (one of {})",
            allowed.join(", ")
        ))),
    }
}

impl ScalarFunction {
    /// Render as a SQL function call with the given arguments.
    ///
    /// # Errors
    ///
    /// Returns an error if any argument cannot be rendered as scalar SQL
    /// (see [`Expression::to_sql_string`]).
    pub fn to_sql(&self, args: &[Expression]) -> EngineResult<String> {
        let strs = args
            .iter()
            .map(|a| a.to_sql_string())
            .collect::<EngineResult<Vec<String>>>()?;
        Ok(self.to_sql_strs(&strs))
    }

    /// Render as a SQL function call with pre-rendered string arguments.
    pub fn to_sql_strs(&self, args: &[String]) -> String {
        match self {
            Self::Abs => format!("ABS({})", args[0]),
            Self::Round => {
                let digits = args.get(1).map(|s| s.as_str()).unwrap_or("0");
                format!("ROUND({}, {digits})", args[0])
            }
            Self::RoundUp => {
                let digits = args.get(1).map(|s| s.as_str()).unwrap_or("0");
                format!("ROUND({}, {digits})", args[0])
            }
            Self::RoundDown => {
                let digits = args.get(1).map(|s| s.as_str()).unwrap_or("0");
                format!("TRUNC({}, {digits})", args[0])
            }
            Self::Int => format!("FLOOR({})", args[0]),
            Self::Trunc => {
                let digits = args.get(1).map(|s| s.as_str()).unwrap_or("0");
                format!("TRUNC({}, {digits})", args[0])
            }
            Self::Ceiling => {
                let sig = args.get(1).map(|s| s.as_str()).unwrap_or("1");
                format!("CEILING({} / {sig}) * {sig}", args[0])
            }
            Self::Floor => {
                let sig = args.get(1).map(|s| s.as_str()).unwrap_or("1");
                format!("FLOOR({} / {sig}) * {sig}", args[0])
            }
            Self::Mod => format!("({} % {})", args[0], args[1]),
            Self::Power => format!("POWER({}, {})", args[0], args[1]),
            Self::Sqrt => format!("SQRT({})", args[0]),
            Self::Ln => format!("LN({})", args[0]),
            Self::Log10 => format!("LOG10({})", args[0]),
            Self::Sign => format!("signum({})", args[0]),
            Self::Exp => format!("EXP({})", args[0]),
            Self::Log => {
                let base = args.get(1).map(|s| s.as_str()).unwrap_or("10");
                format!("LOG({}, {})", args[0], base)
            }
            Self::Pi => "PI()".to_string(),
        }
    }
}

impl std::fmt::Display for ScalarFunction {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Abs => write!(f, "ABS"),
            Self::Round => write!(f, "ROUND"),
            Self::RoundUp => write!(f, "ROUNDUP"),
            Self::RoundDown => write!(f, "ROUNDDOWN"),
            Self::Int => write!(f, "INT"),
            Self::Trunc => write!(f, "TRUNC"),
            Self::Ceiling => write!(f, "CEILING"),
            Self::Floor => write!(f, "FLOOR"),
            Self::Mod => write!(f, "MOD"),
            Self::Power => write!(f, "POWER"),
            Self::Sqrt => write!(f, "SQRT"),
            Self::Ln => write!(f, "LN"),
            Self::Log10 => write!(f, "LOG10"),
            Self::Sign => write!(f, "SIGN"),
            Self::Exp => write!(f, "EXP"),
            Self::Log => write!(f, "LOG"),
            Self::Pi => write!(f, "PI"),
        }
    }
}

impl DateTimeFunction {
    /// Render as a SQL function call with the given arguments.
    ///
    /// # Errors
    ///
    /// Returns an error if any argument cannot be rendered as scalar SQL
    /// (see [`Expression::to_sql_string`]).
    pub fn to_sql(&self, args: &[Expression]) -> EngineResult<String> {
        let strs = args
            .iter()
            .map(|a| a.to_sql_string())
            .collect::<EngineResult<Vec<String>>>()?;
        Ok(self.to_sql_strs(&strs))
    }

    /// Render as a SQL function call with pre-rendered string arguments.
    pub fn to_sql_strs(&self, args: &[String]) -> String {
        match self {
            Self::Year => format!("date_part('year', {})", args[0]),
            Self::Month => format!("date_part('month', {})", args[0]),
            Self::Day => format!("date_part('day', {})", args[0]),
            Self::Quarter => format!("date_part('quarter', {})", args[0]),
            Self::Date => format!("make_date({}, {}, {})", args[0], args[1], args[2]),
            Self::DateDiff => {
                // Third arg is the interval string literal (e.g. 'DAY').
                // Strip surrounding quotes if present for matching.
                let interval_raw = args
                    .get(2)
                    .map(|s| s.trim_matches('\'').to_uppercase())
                    .unwrap_or_else(|| "DAY".to_string());
                let start = &args[0];
                let end = &args[1];
                match interval_raw.as_str() {
                    "DAY" => {
                        format!("CAST(CAST({end} AS DATE) - CAST({start} AS DATE) AS INTEGER)")
                    }
                    "MONTH" => format!(
                        "CAST((date_part('year', {end}) - date_part('year', {start})) * 12 \
                         + date_part('month', {end}) - date_part('month', {start}) AS INTEGER)"
                    ),
                    "YEAR" => format!(
                        "CAST(date_part('year', {end}) - date_part('year', {start}) AS INTEGER)"
                    ),
                    "QUARTER" => format!(
                        "CAST((date_part('year', {end}) - date_part('year', {start})) * 4 \
                         + date_part('quarter', {end}) - date_part('quarter', {start}) AS INTEGER)"
                    ),
                    _ => format!("CAST(CAST({end} AS DATE) - CAST({start} AS DATE) AS INTEGER)"),
                }
            }
            Self::Today => "CURRENT_DATE".to_string(),
            Self::Now => "NOW()".to_string(),
            Self::DateAdd => {
                // DATEADD(date, n, interval) → (date + INTERVAL '1 <interval>' * n)
                let interval_raw = args
                    .get(2)
                    .map(|s| s.trim_matches('\'').to_uppercase())
                    .unwrap_or_else(|| "DAY".to_string());
                let date = &args[0];
                let n = &args[1];
                format!("({date} + INTERVAL '1 {interval_raw}' * {n})")
            }
            Self::DateTrunc => {
                let interval_raw = args
                    .get(1)
                    .map(|s| s.trim_matches('\'').to_lowercase())
                    .unwrap_or_else(|| "month".to_string());
                format!("DATE_TRUNC('{interval_raw}', {})", args[0])
            }
            Self::LastDay => {
                let interval_raw = args
                    .get(1)
                    .map(|s| s.trim_matches('\'').to_lowercase())
                    .unwrap_or_else(|| "month".to_string());
                // last day = truncate to next period - 1 day
                format!(
                    "CAST(DATE_TRUNC('{interval_raw}', {}) + INTERVAL '1 {interval_raw}' - INTERVAL '1 day' AS DATE)",
                    args[0]
                )
            }
            Self::EoMonth => {
                let months = args.get(1).map(|s| s.as_str()).unwrap_or("0");
                // end of month: add months, then last day of that month
                format!(
                    "CAST(DATE_TRUNC('month', {} + INTERVAL '1 month' * {months}) + INTERVAL '1 month' - INTERVAL '1 day' AS DATE)",
                    args[0]
                )
            }
            Self::DayOfWeek => format!("EXTRACT(DOW FROM {})", args[0]),
            Self::DayOfYear => format!("EXTRACT(DOY FROM {})", args[0]),
            Self::WeekNum => format!("EXTRACT(WEEK FROM {})", args[0]),
            Self::DayName => format!("TRIM(TO_CHAR({}, 'Day'))", args[0]),
            Self::MonthName => format!("TRIM(TO_CHAR({}, 'Month'))", args[0]),
            Self::MonthsBetween => {
                let start = &args[0];
                let end = &args[1];
                format!(
                    "((date_part('year', {end}) - date_part('year', {start})) * 12 \
                     + date_part('month', {end}) - date_part('month', {start}))"
                )
            }
        }
    }
}

impl std::fmt::Display for DateTimeFunction {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Year => write!(f, "YEAR"),
            Self::Month => write!(f, "MONTH"),
            Self::Day => write!(f, "DAY"),
            Self::Quarter => write!(f, "QUARTER"),
            Self::Date => write!(f, "DATE"),
            Self::DateDiff => write!(f, "DATEDIFF"),
            Self::Today => write!(f, "TODAY"),
            Self::Now => write!(f, "NOW"),
            Self::DateAdd => write!(f, "DATEADD"),
            Self::DateTrunc => write!(f, "DATE_TRUNC"),
            Self::LastDay => write!(f, "LAST_DAY"),
            Self::EoMonth => write!(f, "EOMONTH"),
            Self::DayOfWeek => write!(f, "DAYOFWEEK"),
            Self::DayOfYear => write!(f, "DAYOFYEAR"),
            Self::WeekNum => write!(f, "WEEKNUM"),
            Self::DayName => write!(f, "DAYNAME"),
            Self::MonthName => write!(f, "MONTHNAME"),
            Self::MonthsBetween => write!(f, "MONTHS_BETWEEN"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scalar_abs_sql() {
        let expr = scalar_fn(ScalarFunction::Abs, vec![col("value")]);
        assert_eq!(expr.to_sql_string().unwrap(), "ABS(\"value\")");
    }

    #[test]
    fn scalar_round_sql() {
        let expr = scalar_fn(ScalarFunction::Round, vec![col("price"), lit_int(2)]);
        assert_eq!(expr.to_sql_string().unwrap(), "ROUND(\"price\", 2)");
    }

    #[test]
    fn scalar_int_sql() {
        let expr = scalar_fn(ScalarFunction::Int, vec![col("value")]);
        assert_eq!(expr.to_sql_string().unwrap(), "FLOOR(\"value\")");
    }

    #[test]
    fn scalar_sqrt_sql() {
        let expr = scalar_fn(ScalarFunction::Sqrt, vec![col("value")]);
        assert_eq!(expr.to_sql_string().unwrap(), "SQRT(\"value\")");
    }

    #[test]
    fn scalar_mod_sql() {
        let expr = scalar_fn(ScalarFunction::Mod, vec![col("a"), col("b")]);
        assert_eq!(expr.to_sql_string().unwrap(), "(\"a\" % \"b\")");
    }

    #[test]
    fn validate_interval_allow_lists_match_parser() {
        // Every keyword in the validator allow-lists must be accepted by the
        // parser, and every parsed expression must pass validation. If the
        // parser's inline lists in parser.rs gain a keyword, add it to the
        // consts in this file too.
        use crate::compute::parser::parse_measure_expression;

        for kw in DATEDIFF_INTERVALS {
            let text = format!("MAX(DATEDIFF(fact[d1], fact[d2], {kw}))");
            let parsed = parse_measure_expression(&text)
                .unwrap_or_else(|e| panic!("parser rejected DATEDIFF interval {kw}: {e}"));
            assert!(
                parsed.validate().is_ok(),
                "validator rejected DATEDIFF {kw}"
            );
        }
        for kw in DATEADD_INTERVALS {
            let text = format!("MAX(DATEADD(fact[d], 1, {kw}))");
            let parsed = parse_measure_expression(&text)
                .unwrap_or_else(|e| panic!("parser rejected DATEADD interval {kw}: {e}"));
            assert!(parsed.validate().is_ok(), "validator rejected DATEADD {kw}");
        }
        for kw in DATE_TRUNC_INTERVALS {
            let text = format!("MAX(DATE_TRUNC(fact[d], {kw}))");
            let parsed = parse_measure_expression(&text)
                .unwrap_or_else(|e| panic!("parser rejected DATE_TRUNC interval {kw}: {e}"));
            assert!(
                parsed.validate().is_ok(),
                "validator rejected DATE_TRUNC {kw}"
            );
        }
        for kw in LAST_DAY_INTERVALS {
            let text = format!("MAX(LAST_DAY(fact[d], {kw}))");
            let parsed = parse_measure_expression(&text)
                .unwrap_or_else(|e| panic!("parser rejected LAST_DAY interval {kw}: {e}"));
            assert!(
                parsed.validate().is_ok(),
                "validator rejected LAST_DAY {kw}"
            );
        }
    }

    #[test]
    fn datediff_rejects_sub_day_intervals() {
        // HOUR/MINUTE/SECOND have no renderer arm and would silently return
        // days — the parser must reject them so no wrong number can ship.
        use crate::compute::parser::parse_measure_expression;

        for kw in ["HOUR", "MINUTE", "SECOND"] {
            let text = format!("MAX(DATEDIFF(fact[d1], fact[d2], {kw}))");
            assert!(
                parse_measure_expression(&text).is_err(),
                "DATEDIFF must reject sub-day interval {kw}"
            );
            // DATEADD/DATE_TRUNC still accept them (they render via INTERVAL).
            let add = format!("MAX(DATEADD(fact[d], 1, {kw}))");
            assert!(
                parse_measure_expression(&add).is_ok(),
                "DATEADD should still accept {kw}"
            );
        }
    }
}
