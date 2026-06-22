//! The SQL [`Dialect`] trait and its two built-in implementations.
//!
//! A `Dialect` owns every place the generated SQL **text** diverges between
//! execution targets: aggregate spellings, the safe-division cast, percentile
//! syntax, ordered-set aggregates (`FIRST_VALUE`/`MIN`/`ARRAY_AGG`), scalar
//! function rewrites, whether host UDF calls are renderable, and the policy for
//! nodes that must be materialized rather than rendered inline.
//!
//! Promoting this from a closed enum to a trait is what lets a **new database
//! vendor** opt into expression pushdown by supplying one `Dialect` impl — with
//! no change to engine-core, the planner, or the connector registry.
//!
//! Every spelling method returns [`EngineResult`]: a dialect that cannot
//! express a node returns `Err`, which the renderer propagates and the planner
//! turns into local aggregation (fail-soft — never a silently-wrong query).
//! Only [`DataFusionDialect`] (which is never pushed to a source) is allowed to
//! emit the `/* … must be materialized */` placeholder comments; source
//! dialects return `Err` for those nodes.

use crate::compute::aggregate::AggregateOp;
use crate::compute::expression::{validate_call_name, Expression, ScalarFunction};
use crate::error::{EngineError, EngineResult};

/// The SQL-text spellings that differ between execution targets.
///
/// See the [module docs](self) for the design. Implement this on a unit struct
/// to teach the renderer a new vendor's pushdown SQL.
pub trait Dialect {
    /// Render an aggregate over an already-rendered operand fragment.
    fn render_aggregate(&self, op: &AggregateOp, operand_sql: &str) -> EngineResult<String>;

    /// Render an aggregate whose operand is wrapped in `CASE WHEN condition`.
    fn render_aggregate_case_when(
        &self,
        op: &AggregateOp,
        condition: &str,
        operand_sql: &str,
    ) -> EngineResult<String>;

    /// The cast target used for safe division (`DIVIDE`): e.g. `DOUBLE` vs
    /// `DOUBLE PRECISION`.
    fn divide_cast(&self) -> &'static str;

    /// Render a `Date32` literal (days since the Unix epoch) as a date-typed
    /// SQL constant. DataFusion reinterprets an integer cast (`CAST(n AS DATE)`)
    /// as days-since-epoch, but PostgreSQL rejects integer→date casts, so each
    /// dialect spells this differently. Returns `Err` for an out-of-range day
    /// count (fail-soft to local execution).
    fn date_literal(&self, days: i32) -> EngineResult<String>;

    /// Render a plain (non-conditional) `SafeDivide`.
    fn safe_divide(
        &self,
        numerator: &str,
        denominator: &str,
        alternate: &str,
    ) -> EngineResult<String>;

    /// Render a continuous percentile of `operand_sql` at fraction `k_sql`.
    fn percentile(&self, k_sql: &str, operand_sql: &str) -> EngineResult<String>;

    /// Render `FIRSTNONBLANK`-style first-value-by-order.
    fn first_value(&self, column_sql: &str, order_by_sql: &str) -> EngineResult<String>;

    /// Render `MAXX`-by: the value at the row with the maximum sort key.
    fn max_by(&self, value_sql: &str, sort_sql: &str) -> EngineResult<String>;

    /// Render `MINX`-by: the value at the row with the minimum sort key.
    fn min_by(&self, value_sql: &str, sort_sql: &str) -> EngineResult<String>;

    /// Render a scalar function call with already-rendered arguments.
    fn scalar_func(&self, function: &ScalarFunction, mapped: &[String]) -> EngineResult<String>;

    /// Whether this dialect can render a host-registered UDF call. Source
    /// dialects return `false` — UDFs execute only in the local DataFusion
    /// session.
    fn supports_udf_call(&self) -> bool;

    /// Render a node that normally must be materialized rather than rendered
    /// inline (`QUERY`, `WINDOW`/`OFFSET`/`INDEX`, `RANK_WINDOW`).
    ///
    /// The local dialect returns the placeholder `comment`; a source dialect
    /// MUST return `Err` (it cannot represent these inline), so the planner
    /// falls back to local execution rather than emitting broken SQL.
    fn materialized_placeholder(&self, comment: &str, expr: &Expression)
        -> EngineResult<String>;
}

/// DataFusion-compatible SQL for local execution (the engine's internal query
/// engine). Uses `CAST(x AS DOUBLE)`, `approx_percentile_cont`,
/// `FIRST_VALUE(x ORDER BY y)`, and DataFusion aggregate spellings.
#[derive(Debug, Clone, Copy, Default)]
pub struct DataFusionDialect;

impl Dialect for DataFusionDialect {
    fn render_aggregate(&self, op: &AggregateOp, operand_sql: &str) -> EngineResult<String> {
        Ok(op.render_sql(operand_sql))
    }

    fn render_aggregate_case_when(
        &self,
        op: &AggregateOp,
        condition: &str,
        operand_sql: &str,
    ) -> EngineResult<String> {
        Ok(op.render_case_when_sql(condition, operand_sql))
    }

    fn divide_cast(&self) -> &'static str {
        "DOUBLE"
    }

    fn date_literal(&self, days: i32) -> EngineResult<String> {
        // DataFusion's Int→Date32 cast reinterprets the integer as days since
        // the epoch, so the comparison stays Date32-vs-Date32. (Pinned across
        // the renderer tests.)
        Ok(format!("CAST({days} AS DATE)"))
    }

    fn safe_divide(
        &self,
        numerator: &str,
        denominator: &str,
        alternate: &str,
    ) -> EngineResult<String> {
        // DataFusion plain SQL parenthesizes the division.
        Ok(format!(
            "CASE WHEN {denominator} = 0 THEN {alternate} ELSE (CAST({numerator} AS DOUBLE) / {denominator}) END"
        ))
    }

    fn percentile(&self, k_sql: &str, operand_sql: &str) -> EngineResult<String> {
        Ok(format!("approx_percentile_cont({operand_sql}, {k_sql})"))
    }

    fn first_value(&self, column_sql: &str, order_by_sql: &str) -> EngineResult<String> {
        Ok(format!("FIRST_VALUE({column_sql} ORDER BY {order_by_sql})"))
    }

    fn max_by(&self, value_sql: &str, sort_sql: &str) -> EngineResult<String> {
        Ok(format!("FIRST_VALUE({value_sql} ORDER BY {sort_sql} DESC)"))
    }

    fn min_by(&self, value_sql: &str, sort_sql: &str) -> EngineResult<String> {
        Ok(format!("FIRST_VALUE({value_sql} ORDER BY {sort_sql} ASC)"))
    }

    fn scalar_func(&self, function: &ScalarFunction, mapped: &[String]) -> EngineResult<String> {
        Ok(function.to_sql_strs(mapped))
    }

    fn supports_udf_call(&self) -> bool {
        true
    }

    fn materialized_placeholder(
        &self,
        comment: &str,
        _expr: &Expression,
    ) -> EngineResult<String> {
        Ok(comment.to_string())
    }
}

/// PostgreSQL SQL for source pushdown. Uses `CAST(x AS DOUBLE PRECISION)`,
/// `PERCENTILE_CONT(k) WITHIN GROUP (ORDER BY x)`, `::NUMERIC` casts for
/// `ROUND`/`TRUNC`/`LOG`, and PostgreSQL aggregate spellings.
#[derive(Debug, Clone, Copy, Default)]
pub struct PostgresDialect;

impl Dialect for PostgresDialect {
    fn render_aggregate(&self, op: &AggregateOp, operand_sql: &str) -> EngineResult<String> {
        Ok(op.render_postgres_sql(operand_sql))
    }

    fn render_aggregate_case_when(
        &self,
        op: &AggregateOp,
        condition: &str,
        operand_sql: &str,
    ) -> EngineResult<String> {
        Ok(op.render_postgres_case_when_sql(condition, operand_sql))
    }

    fn divide_cast(&self) -> &'static str {
        "DOUBLE PRECISION"
    }

    fn date_literal(&self, days: i32) -> EngineResult<String> {
        // PostgreSQL rejects integer→date casts (`CAST(15857 AS DATE)` →
        // "cannot cast type integer to date"), so spell the actual calendar
        // date as a `DATE 'YYYY-MM-DD'` literal. `NaiveDate::default()` is the
        // Unix epoch (1970-01-01).
        let date = chrono::NaiveDate::default()
            .checked_add_signed(chrono::Duration::days(days as i64))
            .ok_or_else(|| {
                EngineError::InvalidExpression(format!(
                    "Date literal {days} (days since the Unix epoch) is out of range \
                     for PostgreSQL date rendering"
                ))
            })?;
        Ok(format!("DATE '{}'", date.format("%Y-%m-%d")))
    }

    fn safe_divide(
        &self,
        numerator: &str,
        denominator: &str,
        alternate: &str,
    ) -> EngineResult<String> {
        Ok(format!(
            "CASE WHEN {denominator} = 0 THEN {alternate} ELSE CAST({numerator} AS DOUBLE PRECISION) / {denominator} END"
        ))
    }

    fn percentile(&self, k_sql: &str, operand_sql: &str) -> EngineResult<String> {
        Ok(format!(
            "PERCENTILE_CONT({k_sql}) WITHIN GROUP (ORDER BY {operand_sql})"
        ))
    }

    fn first_value(&self, column_sql: &str, _order_by_sql: &str) -> EngineResult<String> {
        // PostgreSQL pushdown simplifies FIRST to MIN (no inline ordered-set
        // FIRST_VALUE aggregate).
        Ok(format!("MIN({column_sql})"))
    }

    fn max_by(&self, value_sql: &str, sort_sql: &str) -> EngineResult<String> {
        Ok(format!(
            "(ARRAY_AGG({value_sql} ORDER BY {sort_sql} DESC NULLS LAST))[1]"
        ))
    }

    fn min_by(&self, value_sql: &str, sort_sql: &str) -> EngineResult<String> {
        Ok(format!(
            "(ARRAY_AGG({value_sql} ORDER BY {sort_sql} ASC NULLS LAST))[1]"
        ))
    }

    fn scalar_func(&self, function: &ScalarFunction, mapped: &[String]) -> EngineResult<String> {
        Ok(match function {
            // PostgreSQL ROUND/TRUNC require numeric, not double precision.
            ScalarFunction::Round | ScalarFunction::RoundUp | ScalarFunction::RoundDown => {
                let digits = mapped.get(1).map(|s| s.as_str()).unwrap_or("0");
                let func = if matches!(function, ScalarFunction::RoundDown) {
                    "TRUNC"
                } else {
                    "ROUND"
                };
                format!("{func}(({})::NUMERIC, {digits})", mapped[0])
            }
            ScalarFunction::Trunc => {
                let digits = mapped.get(1).map(|s| s.as_str()).unwrap_or("0");
                format!("TRUNC(({})::NUMERIC, {digits})", mapped[0])
            }
            // PostgreSQL uses LOG(base, value), not LOG10(value).
            ScalarFunction::Log10 => format!("LOG(10, ({})::NUMERIC)", mapped[0]),
            ScalarFunction::Sign => format!("SIGN({})", mapped[0]),
            ScalarFunction::Mod => format!("MOD({}, {})", mapped[0], mapped[1]),
            _ => function.to_sql_strs(mapped),
        })
    }

    fn supports_udf_call(&self) -> bool {
        false
    }

    fn materialized_placeholder(
        &self,
        _comment: &str,
        expr: &Expression,
    ) -> EngineResult<String> {
        Err(unsupported(expr))
    }
}

/// Error for expression nodes that cannot be rendered in a source dialect.
pub(super) fn unsupported(expr: &Expression) -> EngineError {
    EngineError::InvalidExpression(format!(
        "Expression not supported for source SQL rendering: {expr:?}"
    ))
}

/// The shared UDF-call rejection message used by source dialects (where
/// `supports_udf_call` is `false`).
pub(super) fn udf_call_unsupported(name: &str) -> EngineError {
    EngineError::InvalidExpression(format!(
        "UDF call '{name}' cannot be rendered as source SQL; \
         user-defined functions execute locally only"
    ))
}

/// Re-validate a UDF call name before splicing it unquoted into SQL — a hostile
/// model file that bypassed `Expression::validate` still cannot inject SQL.
/// (Used by the DataFusion call path; lowercase because DataFusion normalizes
/// unquoted function identifiers before registry lookup.)
pub(super) fn render_udf_call(name: &str, mapped: &[String]) -> EngineResult<String> {
    validate_call_name(name)?;
    Ok(format!("{}({})", name.to_lowercase(), mapped.join(", ")))
}
