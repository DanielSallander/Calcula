//! Incremental-refresh planning for `InMemory` tables.
//!
//! When an [`InMemory`](crate::model::StorageMode::InMemory) table carries an
//! [`IncrementalRefresh`](crate::model::IncrementalRefresh) policy, a stale
//! refresh re-fetches only the **volatile** rows the author's `refresh_filter`
//! identifies and retains the rest of the cached rows, instead of re-fetching
//! the whole table.
//!
//! This module is the I/O-free heart of that path. It:
//!
//! 1. parses and **validates** a `refresh_filter` into an AND-combination of
//!    simple comparisons `column <op> rhs` (see [`validate_refresh_filter`]);
//! 2. **constant-folds** each comparison's right-hand side to a concrete
//!    literal value at refresh time, using a single injected snapshot of
//!    "today"/"now" so the source fetch and the cache retention share an
//!    identical boundary (see [`fold_refresh_filter_at`]);
//! 3. renders the **negated conjunction** as safe DataFusion SQL and runs it
//!    over the cached batch to keep the stable rows (see
//!    [`retain_stable_rows`]).
//!
//! The actual source fetch of the volatile rows (a connector call) and the
//! final splice live in the `Engine` facade — `engine-core` stays free of any
//! connector dependency.
//!
//! # v1 limitation
//!
//! Only an AND-of-comparisons is accepted, with constant-foldable right-hand
//! sides (a literal, or a date expression over `TODAY()`, `NOW()`,
//! `DATE(y,m,d)`, `DATEADD(…)`, `DATETRUNC(…)`). `OR` / `NOT` / arbitrary
//! boolean predicates and a raw-SQL escape hatch are future work.

use arrow::compute::concat_batches;
use arrow::record_batch::RecordBatch;
use chrono::{Datelike, NaiveDate, NaiveDateTime};
use datafusion::prelude::SessionContext;

use crate::compute::expression::{ComparisonOp, DateTimeFunction, Expression};
use crate::compute::parser::parse_refresh_filter;
use crate::compute::sql_util::{quote_ident_double, sql_quote_literal};
use crate::error::{EngineError, EngineResult};

/// One conjunct of a validated `refresh_filter`, with its right-hand side
/// already folded to a concrete literal value.
///
/// `column` is a column on the refreshed table, `op` is the comparison, and
/// `value` is the folded scalar (a date as `YYYY-MM-DD`, a timestamp as
/// `YYYY-MM-DD HH:MM:SS`, a number, a boolean `true`/`false`, or a string).
/// The engine facade maps each conjunct to a source `FilterCondition` (to
/// fetch the volatile rows) and this module renders the same conjuncts as the
/// negated cache-retention SQL.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RefreshConjunct {
    /// Column on the refreshed table the comparison applies to.
    pub column: String,
    /// Comparison operator.
    pub op: ComparisonOp,
    /// Folded right-hand-side scalar, as a string.
    pub value: String,
}

/// A single comparison conjunct before its right-hand side is folded.
///
/// `rhs` is the raw (parsed) expression; it is folded to a concrete value by
/// [`fold_refresh_filter_at`] and validated as constant-foldable by
/// [`validate_refresh_filter`].
struct RawConjunct {
    column: String,
    op: ComparisonOp,
    rhs: Expression,
}

/// Flatten a parsed `refresh_filter` expression into its comparison conjuncts.
///
/// Accepts a right- or left-leaning chain of [`Expression::And`] whose leaves
/// are [`Expression::Comparison`]s with a column reference on the left
/// (bare `ColumnRef` or `QualifiedColumnRef`) and an arbitrary expression on
/// the right. Anything else — `OR`, `NOT`, a bare boolean, a non-column left
/// side — is rejected with [`EngineError::InvalidData`] naming `table` and the
/// reason. `table`, when the left side is qualified, must match.
fn flatten_conjuncts(table: &str, expr: &Expression) -> EngineResult<Vec<RawConjunct>> {
    let invalid = |reason: String| {
        EngineError::InvalidData(format!(
            "incremental refresh filter on table '{table}' is invalid: {reason}"
        ))
    };

    match expr {
        Expression::And(left, right) => {
            let mut conjuncts = flatten_conjuncts(table, left)?;
            conjuncts.extend(flatten_conjuncts(table, right)?);
            Ok(conjuncts)
        }
        Expression::Comparison { left, op, right } => {
            let column = match left.as_ref() {
                Expression::ColumnRef(c) => c.clone(),
                Expression::QualifiedColumnRef {
                    table_or_var,
                    column,
                } => {
                    if table_or_var != table {
                        return Err(invalid(format!(
                            "left-hand column '{table_or_var}[{column}]' refers to another \
                             table; only columns of '{table}' are allowed (no cross-table refs)"
                        )));
                    }
                    column.clone()
                }
                other => {
                    return Err(invalid(format!(
                        "left-hand side of each comparison must be a column of '{table}', \
                         got {other:?}"
                    )));
                }
            };
            Ok(vec![RawConjunct {
                column,
                op: *op,
                rhs: (**right).clone(),
            }])
        }
        Expression::Or(_, _) => Err(invalid(
            "OR is not supported (v1 accepts only an AND-combination of simple comparisons)"
                .to_string(),
        )),
        Expression::Not(_) => Err(invalid(
            "NOT is not supported (v1 accepts only an AND-combination of simple comparisons)"
                .to_string(),
        )),
        other => Err(invalid(format!(
            "expected a comparison 'column <op> value' (optionally AND-combined), got {other:?}"
        ))),
    }
}

/// Validate an incremental-refresh `refresh_filter` for a table.
///
/// Parses the filter and checks that it is an AND-combination of simple
/// comparisons `column <op> rhs`, where every `column` exists in
/// `table_columns`, `<op>` is a comparison, and every `rhs` is a constant-
/// foldable scalar (a literal, or a date expression over the allowed date
/// functions only — `TODAY()`, `NOW()`, `DATE(y,m,d)`, `DATEADD(…)`,
/// `DATETRUNC(…)` — with no column references, aggregates, context ops,
/// measure refs, or script/UDF calls).
///
/// Returns the number of conjuncts on success. Any violation is reported as
/// [`EngineError::InvalidData`] naming `table` and the reason. Called by the
/// model builder so a bad filter in a shared model file fails at build time
/// rather than at refresh time.
pub fn validate_refresh_filter(
    table: &str,
    refresh_filter: &str,
    table_columns: &[&str],
) -> EngineResult<usize> {
    let invalid = |reason: String| {
        EngineError::InvalidData(format!(
            "incremental refresh filter on table '{table}' is invalid: {reason}"
        ))
    };

    let expr = parse_refresh_filter(refresh_filter)
        .map_err(|e| invalid(format!("does not parse: {e}")))?;
    let conjuncts = flatten_conjuncts(table, &expr)?;
    if conjuncts.is_empty() {
        return Err(invalid("filter has no comparisons".to_string()));
    }

    for conjunct in &conjuncts {
        if !table_columns.contains(&conjunct.column.as_str()) {
            return Err(invalid(format!(
                "comparison references unknown column '{}'",
                conjunct.column
            )));
        }
        // The right-hand side must be constant-foldable. Validating the fold
        // against a fixed reference instant surfaces non-constant right-hand
        // sides (column refs, aggregates, unsupported functions) as errors.
        let reference = NaiveDate::from_ymd_opt(2000, 1, 1)
            .expect("2000-01-01 is a valid date")
            .and_hms_opt(0, 0, 0)
            .expect("00:00:00 is a valid time");
        fold_scalar_at(&conjunct.rhs, reference)
            .map_err(|e| invalid(format!("right-hand side is not a constant value: {e}")))?;
    }

    Ok(conjuncts.len())
}

/// Parse and fold a `refresh_filter` into concrete [`RefreshConjunct`]s at a
/// given `now` snapshot.
///
/// `now` is the single refresh-time snapshot of "today/now" — evaluating it
/// once ensures the source fetch (volatile rows) and the cache retention
/// (stable rows) share an identical boundary. The production caller passes
/// `chrono::Local::now().naive_local()`; tests inject a fixed instant for
/// determinism.
///
/// Returns one [`RefreshConjunct`] per comparison, each with its right-hand
/// side folded to a concrete literal value. The filter must already be
/// well-formed (the model builder validated it via
/// [`validate_refresh_filter`]); a malformed filter here returns an error
/// rather than panicking.
pub fn fold_refresh_filter_at(
    table: &str,
    refresh_filter: &str,
    now: NaiveDateTime,
) -> EngineResult<Vec<RefreshConjunct>> {
    let invalid = |reason: String| {
        EngineError::InvalidData(format!(
            "incremental refresh filter on table '{table}' is invalid: {reason}"
        ))
    };

    let expr = parse_refresh_filter(refresh_filter)
        .map_err(|e| invalid(format!("does not parse: {e}")))?;
    let raw = flatten_conjuncts(table, &expr)?;

    raw.into_iter()
        .map(|c| {
            let value = fold_scalar_at(&c.rhs, now)
                .map_err(|e| invalid(format!("right-hand side is not a constant value: {e}")))?;
            Ok(RefreshConjunct {
                column: c.column,
                op: c.op,
                value: value.into_string(),
            })
        })
        .collect()
}

/// Parse and fold a `refresh_filter` into concrete [`RefreshConjunct`]s using
/// the **current local** "now" as the single refresh-time snapshot.
///
/// Thin wrapper over [`fold_refresh_filter_at`] that captures
/// `chrono::Local::now().naive_local()` once (mirroring the local-time date
/// math in `store::cache`). The engine facade calls this on the incremental
/// path so it does not need a direct `chrono` dependency; tests use the
/// `_at` form with an injected instant for determinism.
pub fn fold_refresh_filter_now(
    table: &str,
    refresh_filter: &str,
) -> EngineResult<Vec<RefreshConjunct>> {
    let now = chrono::Local::now().naive_local();
    fold_refresh_filter_at(table, refresh_filter, now)
}

/// A folded scalar value of a comparison right-hand side.
enum FoldedValue {
    /// A date (rendered `YYYY-MM-DD`).
    Date(NaiveDate),
    /// A timestamp (rendered `YYYY-MM-DD HH:MM:SS`).
    Timestamp(NaiveDateTime),
    /// A numeric literal (integer or float, rendered as written).
    Number(String),
    /// A boolean literal (`true` / `false`).
    Bool(bool),
    /// A string literal (rendered verbatim — quoting happens at the SQL /
    /// filter boundary).
    Text(String),
}

impl FoldedValue {
    /// Render the value as the string stored in a [`RefreshConjunct`].
    ///
    /// Dates and timestamps use ISO-8601 forms; numbers and booleans render as
    /// written; strings render verbatim (the SQL renderer and the connector
    /// quote them safely downstream).
    fn into_string(self) -> String {
        match self {
            FoldedValue::Date(d) => d.format("%Y-%m-%d").to_string(),
            FoldedValue::Timestamp(t) => t.format("%Y-%m-%d %H:%M:%S").to_string(),
            FoldedValue::Number(n) => n,
            FoldedValue::Bool(b) => b.to_string(),
            FoldedValue::Text(s) => s,
        }
    }

    /// The folded value as a date, if it is one (a timestamp truncates to its
    /// date). Used as the operand for date functions.
    fn as_date(&self) -> Option<NaiveDate> {
        match self {
            FoldedValue::Date(d) => Some(*d),
            FoldedValue::Timestamp(t) => Some(t.date()),
            _ => None,
        }
    }
}

/// Constant-fold a comparison right-hand-side expression to a concrete scalar.
///
/// Accepts:
/// - literals: numbers ([`Expression::LiteralInt`] /
///   [`Expression::LiteralFloat`]), strings ([`Expression::LiteralString`] —
///   parsed as an ISO date if it looks like one), and booleans
///   ([`Expression::LiteralBool`]);
/// - the allowed date functions over those: `TODAY()`, `NOW()`,
///   `DATE(y,m,d)`, `DATEADD(<date-expr>, n, "UNIT")`,
///   `DATETRUNC(<date-expr>, "UNIT")`.
///
/// Anything else — column references, aggregates, arithmetic on dates,
/// non-allowed functions — returns an error (it is not a constant the
/// incremental planner can evaluate at refresh time).
fn fold_scalar_at(expr: &Expression, now: NaiveDateTime) -> EngineResult<FoldedValue> {
    let err = |msg: String| EngineError::InvalidData(msg);

    match expr {
        Expression::LiteralInt(n) => Ok(FoldedValue::Number(n.to_string())),
        Expression::LiteralFloat(f) => Ok(FoldedValue::Number(f.to_string())),
        Expression::LiteralBool(b) => Ok(FoldedValue::Bool(*b)),
        Expression::LiteralString(s) => {
            // A string that looks like an ISO date folds to a Date so date
            // functions can operate on it; otherwise it stays text.
            if let Ok(d) = NaiveDate::parse_from_str(s, "%Y-%m-%d") {
                Ok(FoldedValue::Date(d))
            } else {
                Ok(FoldedValue::Text(s.clone()))
            }
        }
        Expression::DateTimeFunc { function, args } => fold_date_function(*function, args, now),
        other => Err(err(format!(
            "unsupported expression {other:?} — only literals and the date functions \
             TODAY/NOW/DATE/DATEADD/DATETRUNC are allowed"
        ))),
    }
}

/// Fold one of the allowed date functions.
fn fold_date_function(
    function: DateTimeFunction,
    args: &[Expression],
    now: NaiveDateTime,
) -> EngineResult<FoldedValue> {
    let err = |msg: String| EngineError::InvalidData(msg);

    match function {
        DateTimeFunction::Today => Ok(FoldedValue::Date(now.date())),
        DateTimeFunction::Now => Ok(FoldedValue::Timestamp(now)),
        DateTimeFunction::Date => {
            // DATE(y, m, d) — all three args must fold to integers.
            if args.len() != 3 {
                return Err(err("DATE() requires exactly 3 arguments".to_string()));
            }
            let y = fold_int_arg(&args[0], now)?;
            let m = fold_int_arg(&args[1], now)?;
            let d = fold_int_arg(&args[2], now)?;
            let (y, m, d) = (
                i32::try_from(y).map_err(|_| err(format!("DATE year {y} out of range")))?,
                u32::try_from(m).map_err(|_| err(format!("DATE month {m} out of range")))?,
                u32::try_from(d).map_err(|_| err(format!("DATE day {d} out of range")))?,
            );
            NaiveDate::from_ymd_opt(y, m, d)
                .map(FoldedValue::Date)
                .ok_or_else(|| err(format!("DATE({y}, {m}, {d}) is not a valid date")))
        }
        DateTimeFunction::DateAdd => {
            // DATEADD(date, n, "UNIT").
            if args.len() != 3 {
                return Err(err("DATEADD() requires exactly 3 arguments".to_string()));
            }
            let base = fold_scalar_at(&args[0], now)?;
            let date = base
                .as_date()
                .ok_or_else(|| err("DATEADD: first argument is not a date".to_string()))?;
            let n = fold_int_arg(&args[1], now)?;
            let unit = fold_interval_keyword(&args[2])?;
            let result = date_add(date, n, &unit)
                .ok_or_else(|| err(format!("DATEADD overflowed for unit '{unit}'")))?;
            Ok(FoldedValue::Date(result))
        }
        DateTimeFunction::DateTrunc => {
            // DATETRUNC(date, "UNIT").
            if args.len() != 2 {
                return Err(err("DATETRUNC() requires exactly 2 arguments".to_string()));
            }
            let base = fold_scalar_at(&args[0], now)?;
            let date = base
                .as_date()
                .ok_or_else(|| err("DATETRUNC: first argument is not a date".to_string()))?;
            let unit = fold_interval_keyword(&args[1])?;
            let result = date_trunc(date, &unit)
                .ok_or_else(|| err(format!("DATETRUNC: unsupported unit '{unit}'")))?;
            Ok(FoldedValue::Date(result))
        }
        other => Err(err(format!(
            "date function {other} is not allowed in an incremental refresh filter \
             (only TODAY, NOW, DATE, DATEADD, DATETRUNC)"
        ))),
    }
}

/// Fold an argument that must reduce to an integer (for `DATE` / `DATEADD`).
fn fold_int_arg(expr: &Expression, now: NaiveDateTime) -> EngineResult<i64> {
    match fold_scalar_at(expr, now)? {
        FoldedValue::Number(n) => n.parse::<i64>().or_else(|_| {
            n.parse::<f64>()
                .map(|f| f as i64)
                .map_err(|_| EngineError::InvalidData(format!("expected an integer, got '{n}'")))
        }),
        other => Err(EngineError::InvalidData(format!(
            "expected an integer argument, got {}",
            other.into_string()
        ))),
    }
}

/// Extract the allow-listed interval keyword of a `DATEADD` / `DATETRUNC`
/// argument (a string literal, case-insensitive).
fn fold_interval_keyword(expr: &Expression) -> EngineResult<String> {
    match expr {
        Expression::LiteralString(s) => Ok(s.to_uppercase()),
        other => Err(EngineError::InvalidData(format!(
            "expected an interval keyword string (e.g. \"DAY\"), got {other:?}"
        ))),
    }
}

/// Add `n` of `unit` to `date`. Returns `None` on overflow or an unknown unit.
fn date_add(date: NaiveDate, n: i64, unit: &str) -> Option<NaiveDate> {
    match unit {
        "DAY" => date.checked_add_signed(chrono::Duration::days(n)),
        "WEEK" => date.checked_add_signed(chrono::Duration::weeks(n)),
        "MONTH" => add_months(date, n),
        "QUARTER" => add_months(date, n.checked_mul(3)?),
        "YEAR" => add_months(date, n.checked_mul(12)?),
        // Sub-day units have no effect on a Date; treat them as no-ops rather
        // than failing (a Date carries no time component).
        "HOUR" | "MINUTE" | "SECOND" => Some(date),
        _ => None,
    }
}

/// Truncate `date` to the start of the period named by `unit`.
fn date_trunc(date: NaiveDate, unit: &str) -> Option<NaiveDate> {
    match unit {
        "DAY" | "HOUR" | "MINUTE" | "SECOND" => Some(date),
        "WEEK" => {
            // Truncate to Monday (ISO week start).
            let weekday_from_monday = date.weekday().num_days_from_monday() as i64;
            date.checked_sub_signed(chrono::Duration::days(weekday_from_monday))
        }
        "MONTH" => NaiveDate::from_ymd_opt(date.year(), date.month(), 1),
        "QUARTER" => {
            let quarter_start_month = (date.month() - 1) / 3 * 3 + 1;
            NaiveDate::from_ymd_opt(date.year(), quarter_start_month, 1)
        }
        "YEAR" => NaiveDate::from_ymd_opt(date.year(), 1, 1),
        _ => None,
    }
}

/// Add `months` calendar months to `date`, clamping the day to the target
/// month's last day (so 2024-01-31 + 1 month = 2024-02-29).
fn add_months(date: NaiveDate, months: i64) -> Option<NaiveDate> {
    let total = i64::from(date.year()) * 12 + i64::from(date.month0()) + months;
    let year = i32::try_from(total.div_euclid(12)).ok()?;
    let month0 = total.rem_euclid(12) as u32;
    let month = month0 + 1;
    let last_day = last_day_of_month(year, month)?;
    let day = date.day().min(last_day);
    NaiveDate::from_ymd_opt(year, month, day)
}

/// Last day (28–31) of the given month.
fn last_day_of_month(year: i32, month: u32) -> Option<u32> {
    let (next_year, next_month) = if month == 12 {
        (year + 1, 1)
    } else {
        (year, month + 1)
    };
    let first_of_next = NaiveDate::from_ymd_opt(next_year, next_month, 1)?;
    Some(first_of_next.pred_opt()?.day())
}

/// Render the SQL boolean that **retains** the stable cached rows: the
/// complement of the volatile-filter conjunction.
///
/// The source re-fetches `WHERE c1 AND c2 AND …` (rows where the conjunction
/// is *true*; NULLs are excluded). The stable rows are therefore everything
/// else — rows where the conjunction is **false or unknown (NULL)**. Rendered
/// as `(<conjunction>) IS NOT TRUE`, which under SQL three-valued logic keeps
/// exactly those rows, so a cached row whose filter column is NULL is retained
/// (it is not re-fetched, so it must not be dropped).
///
/// Every value is rendered with [`sql_quote_literal`] and every identifier
/// with [`quote_ident_double`], so a value or column containing a quote, `;`,
/// etc. cannot break out of the literal/identifier and inject SQL.
pub fn retain_predicate_sql(conjuncts: &[RefreshConjunct]) -> String {
    let conjunction = conjuncts
        .iter()
        .map(|c| {
            format!(
                "{} {} {}",
                quote_ident_double(&c.column),
                c.op.as_sql(),
                sql_quote_literal(&c.value)
            )
        })
        .collect::<Vec<_>>()
        .join(" AND ");
    // `IS NOT TRUE` keeps rows where the conjunction is false OR unknown(NULL).
    format!("({conjunction}) IS NOT TRUE")
}

/// Keep the **stable** rows of a cached batch: those NOT matched by the
/// volatile filter.
///
/// Registers `cached` in a fresh DataFusion [`SessionContext`] and runs
/// `SELECT * FROM t WHERE <retain_predicate_sql>` (mirroring
/// `filter_cached_batch` in the query pipeline). The predicate is built from
/// the same folded conjuncts as the source fetch, so the retained rows are
/// exactly the cached rows the volatile fetch did not re-pull. An empty
/// `conjuncts` slice is treated as "match nothing volatile" and returns the
/// whole batch unchanged.
///
/// Returns one combined batch (possibly zero-row, with the cached schema).
pub async fn retain_stable_rows(
    cached: &RecordBatch,
    conjuncts: &[RefreshConjunct],
) -> EngineResult<RecordBatch> {
    if conjuncts.is_empty() {
        return Ok(cached.clone());
    }

    let ctx = SessionContext::new();
    ctx.register_batch("_cached", cached.clone())?;
    let sql = format!(
        "SELECT * FROM _cached WHERE {}",
        retain_predicate_sql(conjuncts)
    );
    let df = ctx.sql(&sql).await?;
    let batches = df.collect().await?;

    let schema = cached.schema();
    if batches.is_empty() {
        Ok(RecordBatch::new_empty(schema))
    } else {
        Ok(concat_batches(&schema, &batches)?)
    }
}

/// Splice retained stable rows and freshly fetched volatile rows into one
/// batch.
///
/// `stable` (from [`retain_stable_rows`]) and `volatile` (fetched from the
/// source) must share a schema; the volatile batches are concatenated after
/// the stable rows. A schema mismatch is reported as
/// [`EngineError::InvalidData`] naming the difference. An empty `volatile`
/// (all volatile rows deleted at source) yields the stable rows alone.
pub fn splice_incremental(
    stable: RecordBatch,
    volatile: &[RecordBatch],
) -> EngineResult<RecordBatch> {
    let schema = stable.schema();
    for (i, batch) in volatile.iter().enumerate() {
        if batch.schema() != schema {
            return Err(EngineError::InvalidData(format!(
                "incremental refresh schema mismatch: cached/stable schema {:?} differs from \
                 fetched volatile batch {i} schema {:?}",
                schema,
                batch.schema()
            )));
        }
    }
    let mut all: Vec<RecordBatch> = Vec::with_capacity(1 + volatile.len());
    all.push(stable);
    all.extend(volatile.iter().cloned());
    Ok(concat_batches(&schema, &all)?)
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use super::*;
    use arrow::array::{Date32Array, Float64Array, Int64Array, StringArray};
    use arrow::datatypes::{DataType as ArrowDataType, Field, Schema};

    fn dt(y: i32, m: u32, d: u32) -> NaiveDateTime {
        NaiveDate::from_ymd_opt(y, m, d)
            .unwrap()
            .and_hms_opt(12, 30, 0)
            .unwrap()
    }

    // --- Constant folder ---

    #[test]
    fn fold_today_dateadd_minus_7_days() {
        // refresh "now" = 2026-06-13; DATEADD(TODAY(), -7, "DAY") = 2026-06-06.
        let conjuncts = fold_refresh_filter_at(
            "fact",
            "order_date >= DATEADD(TODAY(), -7, \"DAY\")",
            dt(2026, 6, 13),
        )
        .unwrap();
        assert_eq!(conjuncts.len(), 1);
        assert_eq!(conjuncts[0].column, "order_date");
        assert_eq!(conjuncts[0].op, ComparisonOp::GreaterThanOrEqual);
        assert_eq!(conjuncts[0].value, "2026-06-06");
    }

    #[test]
    fn fold_today_bare() {
        let conjuncts =
            fold_refresh_filter_at("fact", "order_date >= TODAY()", dt(2026, 6, 13)).unwrap();
        assert_eq!(conjuncts[0].value, "2026-06-13");
    }

    #[test]
    fn fold_date_literal_constructor() {
        let conjuncts =
            fold_refresh_filter_at("fact", "d >= DATE(2024, 2, 29)", dt(2026, 6, 13)).unwrap();
        assert_eq!(conjuncts[0].value, "2024-02-29");
    }

    #[test]
    fn fold_dateadd_month_clamps_day() {
        // 2024-01-31 + 1 MONTH clamps to 2024-02-29 (leap year).
        let conjuncts = fold_refresh_filter_at(
            "fact",
            "d >= DATEADD(DATE(2024, 1, 31), 1, \"MONTH\")",
            dt(2026, 6, 13),
        )
        .unwrap();
        assert_eq!(conjuncts[0].value, "2024-02-29");
    }

    #[test]
    fn fold_datetrunc_month() {
        let conjuncts = fold_refresh_filter_at(
            "fact",
            "d >= DATETRUNC(DATE(2026, 6, 13), \"MONTH\")",
            dt(2026, 6, 13),
        )
        .unwrap();
        assert_eq!(conjuncts[0].value, "2026-06-01");
    }

    #[test]
    fn fold_datetrunc_year_and_quarter() {
        let q = fold_refresh_filter_at(
            "fact",
            "d >= DATETRUNC(DATE(2026, 6, 13), \"QUARTER\")",
            dt(2026, 6, 13),
        )
        .unwrap();
        assert_eq!(q[0].value, "2026-04-01");
        let y = fold_refresh_filter_at(
            "fact",
            "d >= DATETRUNC(DATE(2026, 6, 13), \"YEAR\")",
            dt(2026, 6, 13),
        )
        .unwrap();
        assert_eq!(y[0].value, "2026-01-01");
    }

    #[test]
    fn fold_dateadd_negative_year_crosses_boundary() {
        // 2026-03-15 - 1 YEAR = 2025-03-15.
        let conjuncts = fold_refresh_filter_at(
            "fact",
            "d >= DATEADD(DATE(2026, 3, 15), -1, \"YEAR\")",
            dt(2026, 6, 13),
        )
        .unwrap();
        assert_eq!(conjuncts[0].value, "2025-03-15");
    }

    #[test]
    fn fold_string_comparison_keeps_text() {
        let conjuncts =
            fold_refresh_filter_at("fact", "status <> \"closed\"", dt(2026, 6, 13)).unwrap();
        assert_eq!(conjuncts[0].column, "status");
        assert_eq!(conjuncts[0].op, ComparisonOp::NotEqual);
        assert_eq!(conjuncts[0].value, "closed");
    }

    #[test]
    fn fold_anded_conjuncts() {
        let conjuncts = fold_refresh_filter_at(
            "fact",
            "order_date >= TODAY() AND status <> \"closed\"",
            dt(2026, 6, 13),
        )
        .unwrap();
        assert_eq!(conjuncts.len(), 2);
        assert_eq!(conjuncts[0].column, "order_date");
        assert_eq!(conjuncts[1].column, "status");
    }

    #[test]
    fn fold_now_renders_timestamp() {
        let conjuncts = fold_refresh_filter_at("fact", "ts >= NOW()", dt(2026, 6, 13)).unwrap();
        assert_eq!(conjuncts[0].value, "2026-06-13 12:30:00");
    }

    // --- Validation ---

    #[test]
    fn validate_accepts_date_window() {
        assert_eq!(
            validate_refresh_filter(
                "fact",
                "order_date >= DATEADD(TODAY(), -7, \"DAY\")",
                &["order_date", "amount"],
            )
            .unwrap(),
            1
        );
    }

    #[test]
    fn validate_accepts_status_filter() {
        assert_eq!(
            validate_refresh_filter("fact", "status <> \"closed\"", &["status"]).unwrap(),
            1
        );
    }

    #[test]
    fn validate_accepts_anded_comparisons() {
        assert_eq!(
            validate_refresh_filter(
                "fact",
                "order_date >= TODAY() AND status <> \"closed\"",
                &["order_date", "status"],
            )
            .unwrap(),
            2
        );
    }

    #[test]
    fn validate_rejects_unknown_column() {
        let err = validate_refresh_filter("fact", "ghost >= TODAY()", &["order_date"]).unwrap_err();
        assert!(matches!(err, EngineError::InvalidData(ref m) if m.contains("unknown column")));
    }

    #[test]
    fn validate_rejects_cross_table_column() {
        let err = validate_refresh_filter("fact", "other[d] >= TODAY()", &["d"]).unwrap_err();
        assert!(matches!(err, EngineError::InvalidData(ref m) if m.contains("another")));
    }

    #[test]
    fn validate_rejects_or() {
        let err = validate_refresh_filter(
            "fact",
            "status <> \"closed\" OR amount > 0",
            &["status", "amount"],
        )
        .unwrap_err();
        assert!(
            matches!(err, EngineError::InvalidData(ref m) if m.contains("OR is not supported"))
        );
    }

    #[test]
    fn validate_rejects_non_comparison_bare_column() {
        // A bare boolean column with no comparison is not a simple comparison.
        let err = validate_refresh_filter("fact", "is_active", &["is_active"]).unwrap_err();
        assert!(matches!(err, EngineError::InvalidData(_)));
    }

    #[test]
    fn validate_rejects_column_ref_rhs() {
        // RHS references another column → not constant-foldable.
        let err = validate_refresh_filter("fact", "price > cost", &["price", "cost"]).unwrap_err();
        assert!(
            matches!(err, EngineError::InvalidData(ref m) if m.contains("not a constant value"))
        );
    }

    #[test]
    fn validate_rejects_aggregate_rhs() {
        let err =
            validate_refresh_filter("fact", "amount > SUM(fact[amount])", &["amount"]).unwrap_err();
        assert!(
            matches!(err, EngineError::InvalidData(ref m) if m.contains("not a constant value"))
        );
    }

    #[test]
    fn validate_rejects_disallowed_date_function_rhs() {
        // YEAR() is a date function but not one of the allowed constant-folders.
        let err = validate_refresh_filter("fact", "d >= YEAR(TODAY())", &["d"]).unwrap_err();
        assert!(
            matches!(err, EngineError::InvalidData(ref m) if m.contains("not a constant value"))
        );
    }

    // --- Retain predicate SQL (injection safety) ---

    #[test]
    fn retain_predicate_is_not_true_complement() {
        let conjuncts = vec![RefreshConjunct {
            column: "order_date".to_string(),
            op: ComparisonOp::GreaterThanOrEqual,
            value: "2026-06-06".to_string(),
        }];
        let sql = retain_predicate_sql(&conjuncts);
        assert_eq!(sql, "(\"order_date\" >= '2026-06-06') IS NOT TRUE");
    }

    #[test]
    fn retain_predicate_quotes_values_and_identifiers() {
        let conjuncts = vec![RefreshConjunct {
            column: "sta\"tus".to_string(),
            op: ComparisonOp::NotEqual,
            value: "x'); DROP TABLE t; --".to_string(),
        }];
        let sql = retain_predicate_sql(&conjuncts);
        // Identifier quote doubled, value single-quote doubled — no break-out.
        assert!(sql.contains("\"sta\"\"tus\""));
        assert!(sql.contains("'x''); DROP TABLE t; --'"));
        assert!(!sql.contains("'x');"));
    }

    // --- retain_stable_rows + splice over real batches ---

    fn date_batch(dates: &[i32], amounts: &[f64]) -> RecordBatch {
        let schema = Arc::new(Schema::new(vec![
            Field::new("order_date", ArrowDataType::Date32, true),
            Field::new("amount", ArrowDataType::Float64, true),
        ]));
        RecordBatch::try_new(
            schema,
            vec![
                Arc::new(Date32Array::from(dates.to_vec())),
                Arc::new(Float64Array::from(amounts.to_vec())),
            ],
        )
        .unwrap()
    }

    /// Days since epoch for a Date32 value.
    fn days(y: i32, m: u32, d: u32) -> i32 {
        let epoch = NaiveDate::from_ymd_opt(1970, 1, 1).unwrap();
        NaiveDate::from_ymd_opt(y, m, d)
            .unwrap()
            .signed_duration_since(epoch)
            .num_days() as i32
    }

    #[tokio::test]
    async fn retain_stable_rows_drops_volatile_keeps_stable() {
        // Cached: one stable row (2026-06-01) and one volatile row (2026-06-10).
        let cached = date_batch(&[days(2026, 6, 1), days(2026, 6, 10)], &[100.0, 200.0]);
        let conjuncts = vec![RefreshConjunct {
            column: "order_date".to_string(),
            op: ComparisonOp::GreaterThanOrEqual,
            value: "2026-06-06".to_string(),
        }];
        let stable = retain_stable_rows(&cached, &conjuncts).await.unwrap();
        assert_eq!(stable.num_rows(), 1);
        let amt = stable
            .column(1)
            .as_any()
            .downcast_ref::<Float64Array>()
            .unwrap();
        // Only the stable row (amount 100, date 2026-06-01) is retained.
        assert_eq!(amt.value(0), 100.0);
    }

    #[tokio::test]
    async fn retain_stable_rows_keeps_null_filter_column() {
        // A cached row with a NULL filter column is not re-fetched by the
        // source, so it must be retained (IS NOT TRUE keeps NULL rows).
        let schema = Arc::new(Schema::new(vec![
            Field::new("order_date", ArrowDataType::Date32, true),
            Field::new("amount", ArrowDataType::Float64, true),
        ]));
        let cached = RecordBatch::try_new(
            schema,
            vec![
                Arc::new(Date32Array::from(vec![Some(days(2026, 6, 10)), None])),
                Arc::new(Float64Array::from(vec![200.0, 999.0])),
            ],
        )
        .unwrap();
        let conjuncts = vec![RefreshConjunct {
            column: "order_date".to_string(),
            op: ComparisonOp::GreaterThanOrEqual,
            value: "2026-06-06".to_string(),
        }];
        let stable = retain_stable_rows(&cached, &conjuncts).await.unwrap();
        // The volatile dated row is dropped; the NULL-date row is retained.
        assert_eq!(stable.num_rows(), 1);
        let amt = stable
            .column(1)
            .as_any()
            .downcast_ref::<Float64Array>()
            .unwrap();
        assert_eq!(amt.value(0), 999.0);
    }

    #[tokio::test]
    async fn splice_concatenates_stable_and_volatile() {
        let stable = date_batch(&[days(2026, 6, 1)], &[100.0]);
        let volatile = date_batch(&[days(2026, 6, 10)], &[250.0]);
        let spliced = splice_incremental(stable, &[volatile]).unwrap();
        assert_eq!(spliced.num_rows(), 2);
    }

    #[tokio::test]
    async fn splice_empty_volatile_keeps_only_stable() {
        let stable = date_batch(&[days(2026, 6, 1)], &[100.0]);
        let spliced = splice_incremental(stable, &[]).unwrap();
        assert_eq!(spliced.num_rows(), 1);
    }

    #[test]
    fn splice_schema_mismatch_errors() {
        let stable = date_batch(&[days(2026, 6, 1)], &[100.0]);
        let other_schema = Arc::new(Schema::new(vec![Field::new(
            "id",
            ArrowDataType::Int64,
            true,
        )]));
        let volatile =
            RecordBatch::try_new(other_schema, vec![Arc::new(Int64Array::from(vec![1]))]).unwrap();
        let err = splice_incremental(stable, &[volatile]).unwrap_err();
        assert!(matches!(err, EngineError::InvalidData(ref m) if m.contains("schema mismatch")));
    }

    #[test]
    fn fold_used_by_string_column_unaffected() {
        // Sanity: a plain text value passes through (StringArray case used by
        // the status filter).
        let _ = StringArray::from(vec!["open"]);
    }
}
