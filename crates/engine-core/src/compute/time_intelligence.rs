//! Time-intelligence lowering: rewrites the `ToDate` (`YTD`/`QTD`/`MTD`) and
//! `PeriodShift` (`PRIORYEAR`/`PRIORPERIOD`) expression sugar onto the
//! existing Window/Offset machinery.
//!
//! # v1 semantics contract (query-axis time intelligence)
//!
//! Time intelligence v1 deliberately uses **query-axis semantics**, not full
//! DAX filter-context semantics:
//!
//! - The date axis is taken from the **query's group_by columns** that belong
//!   to the model's marked date table (`DataModelBuilder::mark_date_table`)
//!   and carry a [`DateRole`]. A measure like `YTD(SUM(fact[amount]))` only
//!   computes when the needed date columns are on the result axis — it does
//!   not conjure a hidden date context the way DAX `DATESYTD` does.
//! - `ToDate` lowers to a running [`Expression::Window`] aggregate:
//!   `PARTITION BY` the anchor role columns (Year for YTD; Year+Quarter for
//!   QTD; Year+Month for MTD), `ORDER BY` the finer date-role columns present
//!   in group_by (coarse→fine), frame = unbounded preceding..current row.
//!   Non-date group_by dimensions partition the window (handled by the
//!   window executor's group-by injection).
//! - `PeriodShift` lowers to an [`Expression::Offset`] (SQL `LAG`/`LEAD`)
//!   ordered along the anchor role columns. The shift is **positional over
//!   the sorted distinct axis values present in the result**: if year 2012
//!   has no data, `PRIORYEAR` for 2013 returns the nearest earlier year
//!   present rather than NULL. This is the documented v1 contract; value-
//!   based matching is future work.
//! - Missing prerequisites are **typed errors**
//!   ([`EngineError::TimeIntelligence`]) with corrective guidance — never
//!   silently wrong numbers.
//!
//! # v2 semantics contract (filter-context time intelligence)
//!
//! When the date table's anchor role columns are **not** on the query axis,
//! the engine can no longer accumulate a running total along the result rows.
//! Instead it evaluates the measure against the current **date filter
//! context** (DAX `DATESYTD` / `SAMEPERIODLASTYEAR` semantics):
//!
//! - The **as-of date** is the MAX date-key in the current date context (the
//!   query's filters on the date table plus the measure's resolved KEEP
//!   filters on the date table). The host probes this MAX at execution time
//!   and feeds it back here as a concrete day count.
//! - `ToDate` (YTD/QTD/MTD) is rewritten to
//!   `Keep(Clear(inner, <date-table date columns>), [DateKey >= start-of-period,
//!   DateKey < as_of + 1 day])`. CLEAR removes any existing date filter on the
//!   date table; KEEP installs the concrete half-open range on the date-key
//!   column. The upper bound is **half-open** (`< as_of + 1 day`) so a
//!   `Timestamp`-typed date key with a time component on the as-of day is still
//!   included — the same SQL is correct for `Date` and `Timestamp` keys.
//! - `PeriodShift` (PRIORYEAR / SAMEPERIODLASTYEAR) shifts the *entire* current
//!   date window `[min-context-date, as-of]` back by `offset` × granularity and
//!   installs that shifted half-open range. Shifting the whole window back one
//!   year is exactly "the same period, last year", so PRIORYEAR and
//!   SAMEPERIODLASTYEAR are the same lowering.
//!
//! ## Contiguous-calendar requirement (Fix D)
//!
//! In the filter-context path the window's lower bound is derived from the
//! **minimum DateKey present** under the context (a `MIN` probe), not from the
//! date predicate itself. For a **contiguous** context — every date-table row in
//! the window's `[min, max]` span is in the context, which DAX time intelligence
//! also requires — the whole-window shift is exact. If the context filter punches
//! an internal hole (a slicer that keeps Jan and Mar but not Feb), the shifted
//! *range* still spans the hole and would silently over-count. The **executor
//! verifies this for a `PeriodShift`** before lowering (`check_filter_context_
//! window_contiguous` in the window pipeline) and **fails closed** on a gap —
//! restoring the same guarantee the axis path gives via
//! `check_period_shift_axis_contiguous`. `ToDate`/`DATESINPERIOD` build their
//! range purely from the as-of date (a hole simply contributes nothing), so they
//! are unaffected. The residual assumption — a calendar uniform across the
//! shifted span (e.g. the same months present in the current and prior period) —
//! is documented, not checked.
//!
//! PRIORYEAR is implemented as a **whole-window-back-one-year shift**, which is
//! identical to SAMEPERIODLASTYEAR. This differs from DAX `PREVIOUSYEAR`'s
//! "the entire prior year" when the context is a *partial* year (e.g. Jan–Jun):
//! PRIORYEAR here returns the same partial window shifted, not all of the prior
//! year. Present this function to hosts with **SAMEPERIODLASTYEAR semantics**.
//!
//! Only the calendar-correct cases are emitted; everything the engine cannot
//! compute exactly (unsupported inner aggregate, `QTD`/`MTD` *shifts* by
//! quarter/month in filter context, missing date table or DateKey role) is a
//! typed [`EngineError::TimeIntelligence`] — never a plausibly-wrong number.
//!
//! `TotalsMode::Rollup` and ragged hierarchies compose with the **filter-context**
//! families — `ToDate` (YTD/QTD/MTD), `DatesInPeriod`, `SemiAdditiveBalance`,
//! `PeriodShift` (PRIORYEAR/PRIORPERIOD/PARALLELPERIOD), and compound forms
//! (YoY = `YTD − PRIORYEAR`): each lowers to an ordinary `Keep(Clear(inner),
//! [range])` aggregate, so `GROUP BY ROLLUP` (and the hierarchy level transforms)
//! recompute it per level — a subtotal / grand total / rolled-up level is the
//! measure re-evaluated over the rolled-up row set, never a sum of detail values.
//! The AXIS route (a date column on the group-by axis), `Window`/`Offset`/`Index`
//! frames, and ranking still reject ROLLUP / hierarchies.
//!
//! Fiscal (non-Gregorian) calendars are supported for filter-context `ToDate`
//! (YTD/QTD/MTD) — the period start is read from the date table's role columns
//! (see the executor's `probe_fiscal_period_start`) rather than the Gregorian
//! parts of the key — and for `SemiAdditiveBalance` (boundary-day, so calendar-
//! agnostic). Deferred to a future version (full-DAX behavior): value-based
//! period matching across gaps, `DATEADD` over date keys, **fiscal** period shifts
//! / `DATESINPERIOD`, and axis-mode windows/period-shifts × totals (the window
//! execution path rejects those today).

use chrono::{Datelike, NaiveDate};

use crate::compute::aggregate::AggregateOp;
use crate::compute::expression::{
    self as expr, ComparisonOp, DateGranularity, Expression, FilterPredicate,
};
use crate::error::{EngineError, EngineResult};
use crate::model::context::ClearTarget;
use crate::model::{DataModel, DateRole};
use crate::types::DataType;

/// Lower top-level time-intelligence sugar in `expr` onto Window/Offset.
///
/// `group_by` is the query's result axis as `(table, column)` pairs (after
/// hierarchy expansion, when applicable). Returns the rewritten expression
/// plus a human-readable description of the lowering for plan reporting
/// (`None` when `expr` contains no top-level time-intelligence node).
///
/// Only top-level `ToDate`/`PeriodShift` nodes are lowered — matching the
/// window execution path's contract that a window-family function must be
/// the outermost expression of a measure.
pub fn lower_time_intelligence(
    expr: &Expression,
    model: &DataModel,
    group_by: &[(String, String)],
) -> EngineResult<(Expression, Option<String>)> {
    match expr {
        Expression::ToDate {
            expr: inner,
            granularity,
        } => {
            let (lowered, description) = lower_to_date(inner, *granularity, model, group_by)?;
            Ok((lowered, Some(description)))
        }
        Expression::PeriodShift {
            expr: inner,
            offset,
            granularity,
        } => {
            let (lowered, description) =
                lower_period_shift(inner, *offset, *granularity, model, group_by)?;
            Ok((lowered, Some(description)))
        }
        _ => Ok((expr.clone(), None)),
    }
}

/// The display name used in errors and plan output for a `ToDate` node.
fn to_date_name(granularity: DateGranularity) -> &'static str {
    match granularity {
        DateGranularity::Year => "YTD",
        DateGranularity::Quarter => "QTD",
        DateGranularity::Month => "MTD",
        DateGranularity::Week => "WTD",
        // Not produced by the parser (a day-to-date is the day itself);
        // reachable only from a hand-built AST.
        DateGranularity::Day => "TODATE(Day)",
    }
}

/// The display name used in errors and plan output for a `PeriodShift` node.
fn period_shift_name(offset: i64, granularity: DateGranularity) -> &'static str {
    if offset == -1 && granularity == DateGranularity::Year {
        "PRIORYEAR"
    } else {
        "PRIORPERIOD"
    }
}

/// The display name for a `SemiAdditiveBalance` node in errors and plan
/// output, covering all four spellings the parser produces.
pub fn balance_function_name(opening: bool, shift_days: i64, non_blank: bool) -> &'static str {
    match (opening, shift_days, non_blank) {
        (_, _, true) if opening => "FIRSTNONBLANK",
        (_, _, true) => "LASTNONBLANK",
        (true, -1, _) => "PREVIOUSDAY",
        (false, 1, _) => "NEXTDAY",
        (true, _, _) => "OPENINGBALANCE",
        (false, _, _) => "CLOSINGBALANCE",
    }
}

/// Anchor roles for a granularity: the columns that define one period.
///
/// Week is filter-context only in v1 (`reject_week_on_axis` fails the axis
/// path before anchors are resolved); its anchors are listed for completeness
/// (an ISO week does not nest in a year, so a Year+Week axis window would be
/// wrong at year boundaries).
fn anchor_roles(granularity: DateGranularity) -> &'static [DateRole] {
    match granularity {
        DateGranularity::Year => &[DateRole::Year],
        DateGranularity::Quarter => &[DateRole::Year, DateRole::Quarter],
        DateGranularity::Month => &[DateRole::Year, DateRole::Month],
        DateGranularity::Week => &[DateRole::Year, DateRole::Week],
        // Day has no role anchor (the DateKey itself is the period); the
        // axis path fails closed before anchors are resolved
        // (`reject_week_on_axis`).
        DateGranularity::Day => &[],
    }
}

/// Fail closed for `Week`/`Day` granularity on the AXIS path (a date column
/// on the query axis): ISO weeks cross year boundaries, so the Year-anchored
/// window partitioning the axis path uses would silently mis-bucket the
/// year-spanning week; a Day period has no role anchor at all. Week and Day
/// time intelligence are filter-context only in v1.
fn reject_week_on_axis(
    function: &str,
    granularity: DateGranularity,
    group_by: &[(String, String)],
) -> EngineResult<()> {
    if !matches!(granularity, DateGranularity::Week | DateGranularity::Day) {
        return Ok(());
    }
    Err(time_intelligence_error(
        function,
        format!(
            "{function} (Week granularity) is not supported with a date column on the query \
             axis ({}); remove the date column from group_by to evaluate it from the current \
             date filter context",
            format_group_by(group_by)
        ),
    ))
}

/// Date-table columns present in the query's group_by, with their roles,
/// sorted coarse→fine.
struct DateAxis {
    /// The date table's name as written in the group_by entries (falls back
    /// to the model's spelling when the table is absent from group_by).
    table: String,
    /// `(role, column)` pairs present in group_by, sorted by role rank.
    present: Vec<(DateRole, String)>,
}

/// Format a group_by axis for error messages: `dim_date[year], region`.
fn format_group_by(group_by: &[(String, String)]) -> String {
    if group_by.is_empty() {
        return "(empty)".to_string();
    }
    group_by
        .iter()
        .map(|(t, c)| format!("{t}[{c}]"))
        .collect::<Vec<_>>()
        .join(", ")
}

fn time_intelligence_error(function: &str, reason: String) -> EngineError {
    EngineError::TimeIntelligence {
        function: function.to_string(),
        reason,
    }
}

/// Resolve the model's date table and collect its role columns present in
/// the group_by axis.
///
/// Errors (all actionable):
/// - no date table marked on the model,
/// - a date-table group_by column without a date role (the engine cannot
///   tell whether it is finer or coarser than the window axis, and a wrong
///   guess silently breaks the partitioning).
fn resolve_date_axis(
    function: &str,
    model: &DataModel,
    group_by: &[(String, String)],
) -> EngineResult<DateAxis> {
    let date_table_name = model.date_table().ok_or_else(|| {
        time_intelligence_error(
            function,
            "no date table is marked on the model; mark the calendar dimension with \
             DataModelBuilder::mark_date_table(\"<table>\") and assign date roles to its \
             columns with Column::with_date_role"
                .to_string(),
        )
    })?;
    // The date table exists — enforced by model validation at build time.
    let date_table = model.table(date_table_name)?;

    let mut table_as_written = date_table_name.to_string();
    let mut present: Vec<(DateRole, String)> = Vec::new();
    for (gb_table, gb_column) in group_by {
        if !gb_table.eq_ignore_ascii_case(date_table_name) {
            continue;
        }
        table_as_written = gb_table.clone();
        let column = date_table
            .columns()
            .iter()
            .find(|c| c.name().eq_ignore_ascii_case(gb_column))
            .ok_or_else(|| EngineError::ColumnNotFound {
                table: date_table_name.to_string(),
                column: gb_column.clone(),
            })?;
        let Some(role) = column.date_role() else {
            return Err(time_intelligence_error(
                function,
                format!(
                    "group_by column '{gb_table}[{gb_column}]' is on the date table but has \
                     no date role, so {function} cannot place it on the window axis; assign \
                     a role with Column::with_date_role or remove it from group_by"
                ),
            ));
        };
        if !present.iter().any(|(r, _)| *r == role) {
            present.push((role, gb_column.clone()));
        }
    }
    present.sort_by_key(|(role, _)| role.rank());

    Ok(DateAxis {
        table: table_as_written,
        present,
    })
}

/// Find the date table's column for an anchor role and require it on the
/// group_by axis.
fn require_anchor(
    function: &str,
    model: &DataModel,
    axis: &DateAxis,
    role: DateRole,
    group_by: &[(String, String)],
) -> EngineResult<String> {
    if let Some((_, column)) = axis.present.iter().find(|(r, _)| *r == role) {
        return Ok(column.clone());
    }
    // Distinguish "the model lacks the role" from "the query lacks the column".
    // The date table name is validated at build time, so the lookup succeeds.
    let date_table_name = model.date_table().unwrap_or_default();
    let date_table = model.table(date_table_name)?;
    match date_table
        .columns()
        .iter()
        .find(|c| c.date_role() == Some(role))
    {
        Some(column) => Err(time_intelligence_error(
            function,
            format!(
                "{function} requires the date table's {role} column \
                 '{date_table_name}[{}]' in the query's group_by; got {}",
                column.name(),
                format_group_by(group_by)
            ),
        )),
        None => Err(time_intelligence_error(
            function,
            format!(
                "the date table '{date_table_name}' has no column with the {role} role; \
                 assign it with Column::with_date_role(DateRole::{role})"
            ),
        )),
    }
}

/// Map the inner aggregate of a `ToDate` to the window aggregate that
/// composes correctly from per-period values.
///
/// Running SUM of per-period SUMs/COUNTs and running MIN/MAX of per-period
/// MINs/MAXs are exact. AVERAGE, DISTINCTCOUNT, MEDIAN, and the other
/// statistical aggregates do **not** compose from per-period values, so v1
/// rejects them instead of producing wrong numbers.
fn running_window_function(function: &str, inner: &Expression) -> EngineResult<AggregateOp> {
    let Expression::Aggregate { operation, .. } = inner else {
        return Err(time_intelligence_error(
            function,
            format!(
                "{function} requires its argument to be a single SUM, COUNT, COUNTROWS, \
                 MIN, or MAX aggregate in v1 (arithmetic over aggregates cannot be \
                 accumulated as a running total)"
            ),
        ));
    };
    match operation {
        AggregateOp::Sum => Ok(AggregateOp::Sum),
        // A running count is the sum of the per-period counts.
        AggregateOp::Count | AggregateOp::CountRows => Ok(AggregateOp::Sum),
        AggregateOp::Min => Ok(AggregateOp::Min),
        AggregateOp::Max => Ok(AggregateOp::Max),
        other => Err(time_intelligence_error(
            function,
            format!(
                "{function} over {other:?} is not supported in v1: it does not compose \
                 from per-period values (the running aggregate would be wrong); supported \
                 aggregates: SUM, COUNT, COUNTROWS, MIN, MAX"
            ),
        )),
    }
}

/// Lower `ToDate` to a running window aggregate.
fn lower_to_date(
    inner: &Expression,
    granularity: DateGranularity,
    model: &DataModel,
    group_by: &[(String, String)],
) -> EngineResult<(Expression, String)> {
    let function = to_date_name(granularity);
    reject_week_on_axis(function, granularity, group_by)?;
    let axis = resolve_date_axis(function, model, group_by)?;

    // Anchors: the period columns the running total resets on.
    let mut partition_by: Vec<(String, String)> = Vec::new();
    let mut finest_anchor_rank = 0u8;
    for role in anchor_roles(granularity) {
        let column = require_anchor(function, model, &axis, *role, group_by)?;
        finest_anchor_rank = finest_anchor_rank.max(role.rank());
        partition_by.push((axis.table.clone(), column));
    }

    // Ordering: every finer date-role column present, coarse→fine.
    let order_by: Vec<(String, String)> = axis
        .present
        .iter()
        .filter(|(role, _)| role.rank() > finest_anchor_rank)
        .map(|(_, column)| (axis.table.clone(), column.clone()))
        .collect();
    if order_by.is_empty() {
        return Err(time_intelligence_error(
            function,
            format!(
                "{function} requires a date column finer than {} (one of {}) in the \
                 query's group_by to order the running total; got {}",
                anchor_roles(granularity).last().expect("non-empty"),
                finer_roles_list(granularity),
                format_group_by(group_by)
            ),
        ));
    }

    let window_function = running_window_function(function, inner)?;

    let describe = |pairs: &[(String, String)]| {
        pairs
            .iter()
            .map(|(t, c)| format!("{t}.{c}"))
            .collect::<Vec<_>>()
            .join(", ")
    };
    let description = format!(
        "{function} lowered to running {window_function:?} window: PARTITION BY {} \
         ORDER BY {} (frame: unbounded preceding..current row)",
        describe(&partition_by),
        describe(&order_by)
    );

    Ok((
        Expression::Window {
            inner: Box::new(inner.clone()),
            function: window_function,
            order_by,
            partition_by,
            // None = unbounded preceding..current row (running total).
            frame: None,
        },
        description,
    ))
}

/// Human list of the roles accepted as "finer" for a granularity.
fn finer_roles_list(granularity: DateGranularity) -> &'static str {
    match granularity {
        DateGranularity::Year => "Quarter, Month, Week, Day, DateKey",
        DateGranularity::Quarter => "Month, Week, Day, DateKey",
        DateGranularity::Month => "Week, Day, DateKey",
        DateGranularity::Week => "Day, DateKey",
        DateGranularity::Day => "DateKey",
    }
}

/// Lower `PeriodShift` to an Offset (LAG/LEAD) along the anchor columns.
fn lower_period_shift(
    inner: &Expression,
    offset: i64,
    granularity: DateGranularity,
    model: &DataModel,
    group_by: &[(String, String)],
) -> EngineResult<(Expression, String)> {
    let function = period_shift_name(offset, granularity);
    reject_week_on_axis(function, granularity, group_by)?;
    let axis = resolve_date_axis(function, model, group_by)?;

    let mut order_by: Vec<(String, String)> = Vec::new();
    let mut finest_anchor_rank = 0u8;
    for role in anchor_roles(granularity) {
        let column = require_anchor(function, model, &axis, *role, group_by)?;
        finest_anchor_rank = finest_anchor_rank.max(role.rank());
        order_by.push((axis.table.clone(), column));
    }

    // Finer date columns on the axis are only well-defined for year shifts:
    // shifting (2024, May) back one year preserves May, so finer columns
    // partition the LAG. A quarter/month shift cannot preserve a finer
    // column (the prior quarter contains different months) — reject instead
    // of silently shifting along the wrong axis. The finer columns reach
    // PARTITION BY automatically via the window executor's group-by
    // injection, so nothing is added here.
    if granularity != DateGranularity::Year {
        let finer: Vec<&str> = axis
            .present
            .iter()
            .filter(|(role, _)| role.rank() > finest_anchor_rank)
            .map(|(_, column)| column.as_str())
            .collect();
        if !finer.is_empty() {
            return Err(time_intelligence_error(
                function,
                format!(
                    "{function} at {granularity} granularity cannot be combined with finer \
                     date columns in group_by ({}); a shifted {granularity} period does not \
                     contain the same finer periods — group at {granularity} granularity \
                     or shift by YEAR instead",
                    finer.join(", ")
                ),
            ));
        }
    }

    let axis_desc = order_by
        .iter()
        .map(|(t, c)| format!("{t}.{c}"))
        .collect::<Vec<_>>()
        .join(", ");
    let description = format!(
        "{function} lowered to OFFSET({offset}) along {axis_desc} (positional shift over \
         the axis values present in the result)"
    );

    Ok((
        Expression::Offset {
            inner: Box::new(inner.clone()),
            delta: offset,
            order_by,
            partition_by: Vec::new(),
        },
        description,
    ))
}

// ===========================================================================
// Filter-context time intelligence (v2): date columns NOT on the query axis.
// ===========================================================================

/// Which evaluation strategy a top-level time-intelligence node needs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TimeIntelligenceRoute {
    /// The date table's anchor role columns are on the query axis: use the v1
    /// Window/Offset lowering ([`lower_time_intelligence`]).
    Axis,
    /// The date columns are not on the axis: evaluate from the date filter
    /// context. The host must probe the as-of (and, for shifts, the minimum)
    /// date and call [`lower_time_intelligence_filtered`].
    FilterContext(FilterContextPlan),
}

/// Everything the host needs to probe the date context and lower a
/// filter-context time-intelligence node.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FilterContextPlan {
    /// Display name of the function (`YTD`, `PRIORYEAR`, …) for plan/errors.
    pub function: String,
    /// The date table, spelled as the model defines it.
    pub date_table: String,
    /// The `DateRole::DateKey` column on the date table (the column the
    /// concrete range filter is installed on).
    pub date_key_column: String,
    /// Whether a `Shift` plan needs the *minimum* context date (to shift the
    /// whole window) in addition to the as-of date. `ToDate` only needs as-of.
    pub needs_min_context_date: bool,
}

/// Classify a top-level time-intelligence node into its evaluation route.
///
/// Returns `Ok(None)` when `expr` is not a top-level time-intelligence node
/// (the caller should leave it untouched). For a time-intelligence node it
/// returns [`TimeIntelligenceRoute::Axis`] when the v1 query-axis path applies
/// (the required anchor role columns are in `group_by`), or
/// [`TimeIntelligenceRoute::FilterContext`] otherwise.
///
/// This validates the *route-independent* prerequisites up front so both paths
/// fail closed with the same actionable errors:
/// - a date table must be marked and carry the required anchor roles,
/// - the date table must have a `DateRole::DateKey` column of `Date`/`Timestamp`
///   type (the filter-context range is installed on it),
/// - the inner aggregate must be one v1 supports (SUM/COUNT/COUNTROWS/MIN/MAX).
pub fn time_intelligence_route(
    expr: &Expression,
    model: &DataModel,
    group_by: &[(String, String)],
) -> EngineResult<Option<TimeIntelligenceRoute>> {
    // DATESINPERIOD (trailing window) is filter-context only: it has no
    // per-axis-row moving-window form in v1, so a date column on the axis fails
    // closed rather than silently computing a whole-context window per row.
    if let Expression::DatesInPeriod { intervals, .. } = expr {
        let function = "DATESINPERIOD";
        if *intervals >= 0 {
            return Err(time_intelligence_error(
                function,
                format!(
                    "DATESINPERIOD requires a negative interval count — a trailing window, e.g. \
                     -12 for the last 12 periods; got {intervals}"
                ),
            ));
        }
        let axis = resolve_date_axis(function, model, group_by)?;
        if !axis.present.is_empty() {
            return Err(time_intelligence_error(
                function,
                format!(
                    "DATESINPERIOD (a trailing window) is not supported with a date column on \
                     the query axis ({}); remove the date column from group_by to evaluate it \
                     as a trailing window from the current context, or use a running total \
                     (YTD/QTD/MTD)",
                    format_group_by(group_by)
                ),
            ));
        }
        let (date_table, date_key_column) = require_date_key(function, model)?;
        return Ok(Some(TimeIntelligenceRoute::FilterContext(
            FilterContextPlan {
                function: function.to_string(),
                date_table,
                date_key_column,
                needs_min_context_date: false,
            },
        )));
    }

    // DATESBETWEEN (absolute inclusive date range) is filter-context only: the
    // range is fixed, so a date column on the axis fails closed rather than
    // silently computing the same whole-range value on every axis row.
    if let Expression::DatesBetween { .. } = expr {
        let function = "DATESBETWEEN";
        let axis = resolve_date_axis(function, model, group_by)?;
        if !axis.present.is_empty() {
            return Err(time_intelligence_error(
                function,
                format!(
                    "DATESBETWEEN (an absolute date range) is not supported with a date column \
                     on the query axis ({}); remove the date column from group_by to evaluate \
                     it over the fixed range from the current context",
                    format_group_by(group_by)
                ),
            ));
        }
        let (date_table, date_key_column) = require_date_key(function, model)?;
        return Ok(Some(TimeIntelligenceRoute::FilterContext(
            FilterContextPlan {
                function: function.to_string(),
                date_table,
                date_key_column,
                // The range is absolute: as-of/min probes are ignored.
                needs_min_context_date: false,
            },
        )));
    }

    // CLOSINGBALANCE / OPENINGBALANCE: a semi-additive balance pinned to a single
    // boundary date of the current context. Filter-context only — a date on the
    // axis fails closed (the per-row balance is the AXIS LAST/FIRST primitive,
    // deferred). OPENINGBALANCE needs the min context date (the first day).
    if let Expression::SemiAdditiveBalance { opening, .. } = expr {
        let function = if *opening {
            "OPENINGBALANCE"
        } else {
            "CLOSINGBALANCE"
        };
        let axis = resolve_date_axis(function, model, group_by)?;
        if !axis.present.is_empty() {
            return Err(time_intelligence_error(
                function,
                format!(
                    "{function} (a single-boundary balance) is not supported with a date column \
                     on the query axis ({}); remove the date column from group_by to evaluate it \
                     from the current context",
                    format_group_by(group_by)
                ),
            ));
        }
        let (date_table, date_key_column) = require_date_key(function, model)?;
        return Ok(Some(TimeIntelligenceRoute::FilterContext(
            FilterContextPlan {
                function: function.to_string(),
                date_table,
                date_key_column,
                needs_min_context_date: *opening,
            },
        )));
    }

    let (function, granularity, is_shift) = match expr {
        Expression::ToDate {
            expr: _,
            granularity,
        } => (to_date_name(*granularity), *granularity, false),
        Expression::PeriodShift {
            expr: _,
            offset,
            granularity,
        } => (period_shift_name(*offset, *granularity), *granularity, true),
        _ => return Ok(None),
    };

    // The filter-context path applies ONLY when the date table contributes no
    // columns to the query axis at all. If any date-table column is on the axis
    // (even a finer one without the anchor), the query is in axis mode: v1
    // owns it and reports the missing-anchor error itself. This keeps the v1
    // contract intact (e.g. "month on axis but no year" stays a typed v1
    // error rather than silently switching semantics).
    let axis = resolve_date_axis(function, model, group_by)?;
    if !axis.present.is_empty() {
        // Week granularity has no axis form in v1 — fail closed here instead
        // of handing it to the axis lowering (see `reject_week_on_axis`).
        reject_week_on_axis(function, granularity, group_by)?;
        return Ok(Some(TimeIntelligenceRoute::Axis));
    }

    // Filter-context path: resolve the date-key column. Unlike the AXIS
    // (positional running-window) path, there is NO compose-ability restriction
    // on the inner aggregate here: both ToDate and PeriodShift lower to a single
    // evaluation of the inner measure over a date *range*
    // (`Keep(Clear(inner), [DateKey in range])`), so any range-computable
    // aggregate is exact — including AVERAGE / DISTINCTCOUNT / MEDIAN, which the
    // axis path must still reject because they cannot be accumulated from
    // per-period values.
    let (date_table, date_key_column) = require_date_key(function, model)?;

    // A filter-context shift (PRIORYEAR/PRIORPERIOD/DATEADD/PARALLELPERIOD) moves
    // the WHOLE current date window by `offset` periods (Year, Quarter, or
    // Month). For a context that spans exactly one period this equals "the prior
    // period"; for a wider context it is a whole-window shift — the only
    // well-defined shift when no date column is on the axis. (The positional
    // per-period shift is the AXIS path; put a date column on the group-by axis
    // for that.)

    Ok(Some(TimeIntelligenceRoute::FilterContext(
        FilterContextPlan {
            function: function.to_string(),
            date_table,
            date_key_column,
            needs_min_context_date: is_shift,
        },
    )))
}

/// Resolve the date table's `DateRole::DateKey` column, requiring it to be a
/// `Date` or `Timestamp` column. Returns `(date_table_name, datekey_column)`.
fn require_date_key(function: &str, model: &DataModel) -> EngineResult<(String, String)> {
    let date_table_name = model.date_table().ok_or_else(|| {
        time_intelligence_error(
            function,
            "no date table is marked on the model; mark the calendar dimension with \
             DataModelBuilder::mark_date_table(\"<table>\") and assign date roles to its \
             columns with Column::with_date_role"
                .to_string(),
        )
    })?;
    let date_table = model.table(date_table_name)?;
    let datekey = date_table
        .columns()
        .iter()
        .find(|c| c.date_role() == Some(DateRole::DateKey))
        .ok_or_else(|| {
            time_intelligence_error(
                function,
                format!(
                    "{function} in filter context needs the date table '{date_table_name}' to \
                     have a column with the DateKey role (a Date/Timestamp calendar key); \
                     assign it with Column::with_date_role(DateRole::DateKey)"
                ),
            )
        })?;
    match datekey.data_type() {
        DataType::Date | DataType::Timestamp => {}
        other => {
            return Err(time_intelligence_error(
                function,
                format!(
                    "{function} in filter context requires the DateKey column \
                     '{date_table_name}[{}]' to be Date or Timestamp typed (so the date range \
                     filter is exact); it is {other:?}",
                    datekey.name()
                ),
            ));
        }
    }
    Ok((date_table_name.to_string(), datekey.name().to_string()))
}

/// The date-table columns (by name) that the filter-context CLEAR must strip,
/// so the concrete range replaces any existing date filter on the date table.
///
/// Every `DateRole`-tagged column on the date table is cleared (Year, Quarter,
/// Month, Week, Day, DateKey): a slicer might filter on any of them, and the
/// concrete `DateKey` range is the single source of truth for the window.
fn date_role_columns(model: &DataModel, date_table: &str) -> EngineResult<Vec<String>> {
    let table = model.table(date_table)?;
    Ok(table
        .columns()
        .iter()
        .filter(|c| c.date_role().is_some())
        .map(|c| c.name().to_string())
        .collect())
}

/// Lower a filter-context time-intelligence node to a concrete
/// `Keep(Clear(inner, date columns), [DateKey >= start, DateKey < end])`.
///
/// `as_of_days` and `min_context_days` are days since the Unix epoch
/// (1970-01-01), i.e. Arrow `Date32` semantics — the host extracts them from a
/// `MAX`/`MIN` probe of the date-key column under the current date filter
/// context. `min_context_days` is only read for `PeriodShift` plans (where
/// `needs_min_context_date` is true); pass `as_of_days` otherwise.
///
/// The produced range is **half-open**: `>= start AND < end_exclusive`, where
/// `end_exclusive = as_of_day + 1 day`. This is exact for both `Date` and
/// `Timestamp` date keys (a timestamp anywhere on the as-of day is included).
///
/// # Contiguous-calendar requirement (Fix D)
///
/// For a `PeriodShift`, the window's lower bound is `min_context_days` — the
/// **minimum DateKey present** under the context (a `MIN` probe), not the date
/// predicate's lower bound. This is exact only for a **contiguous** context
/// (no in-span date row excluded by the filter — which DAX time intelligence
/// also requires). The executor verifies this before calling here and fails
/// closed on a gap (see the module-level "Contiguous-calendar requirement"); the
/// math here is correct under that verified assumption. PRIORYEAR is a
/// whole-window-back-one-year shift, i.e.
/// SAMEPERIODLASTYEAR semantics (it differs from DAX `PREVIOUSYEAR` for a
/// partial-year context — see the module docs).
pub fn lower_time_intelligence_filtered(
    expr: &Expression,
    model: &DataModel,
    as_of_days: i32,
    min_context_days: i32,
) -> EngineResult<(Expression, String)> {
    // DATESINPERIOD: a trailing window of |intervals| periods ending at the
    // as-of date — [as_of − |intervals| periods + 1 day, as_of].
    if let Expression::DatesInPeriod {
        expr: inner,
        intervals,
        granularity,
    } = expr
    {
        let function = "DATESINPERIOD";
        let (date_table, date_key_column) = require_date_key(function, model)?;
        let as_of = date32_to_naive(as_of_days).ok_or_else(|| {
            time_intelligence_error(
                function,
                format!("the as-of date probe returned an out-of-range value ({as_of_days} days)"),
            )
        })?;
        let start = shift_periods(as_of, *intervals, *granularity)
            .and_then(|d| d.succ_opt())
            .ok_or_else(|| {
                time_intelligence_error(
                    function,
                    format!("sizing the trailing window ending {as_of} overflowed the calendar"),
                )
            })?;
        let description = format!(
            "DATESINPERIOD (filter context) trailing {} {granularity}(s) → range [{start}..{as_of}] \
             on {date_table}.{date_key_column}",
            intervals.unsigned_abs()
        );
        return build_filtered_range_keep(
            inner,
            model,
            &date_table,
            &date_key_column,
            start,
            as_of,
            description,
        );
    }

    // DATESBETWEEN: an ABSOLUTE inclusive [start, end] range. The bounds were
    // validated at parse/build; re-parse defensively (the AST can arrive
    // deserialized from a model file). The as-of/min probes are ignored — the
    // range does not depend on the current date context.
    if let Expression::DatesBetween {
        expr: inner,
        start,
        end,
    } = expr
    {
        let function = "DATESBETWEEN";
        let (date_table, date_key_column) = require_date_key(function, model)?;
        let start_date = NaiveDate::parse_from_str(start, "%Y-%m-%d").map_err(|_| {
            time_intelligence_error(
                function,
                format!(
                    "invalid start date \"{start}\" — expected an ISO calendar date (YYYY-MM-DD)"
                ),
            )
        })?;
        let end_date = NaiveDate::parse_from_str(end, "%Y-%m-%d").map_err(|_| {
            time_intelligence_error(
                function,
                format!("invalid end date \"{end}\" — expected an ISO calendar date (YYYY-MM-DD)"),
            )
        })?;
        if start_date > end_date {
            return Err(time_intelligence_error(
                function,
                format!("start date \"{start}\" is after end date \"{end}\""),
            ));
        }
        let description = format!(
            "DATESBETWEEN (filter context) absolute range [{start_date}..{end_date}] on \
             {date_table}.{date_key_column}"
        );
        return build_filtered_range_keep(
            inner,
            model,
            &date_table,
            &date_key_column,
            start_date,
            end_date,
            description,
        );
    }

    // CLOSINGBALANCE / OPENINGBALANCE (and the boundary-adjacent PREVIOUSDAY /
    // NEXTDAY and non-blank FIRSTNONBLANK / LASTNONBLANK forms): pin the inner
    // measure to a single boundary day of the context — the LAST day (closing)
    // or the FIRST day (opening), plus the optional day offset — by installing
    // a single-day `DateKey = boundary` filter (a [boundary, boundary] range).
    // The boundary day is supplied by the host's MIN/MAX probe of the context:
    // `as_of_days` is the last day; `min_context_days` is the first. For the
    // non-blank forms the host probes the fact instead (the first/last date
    // WITH data) and passes those days here — the lowering is identical.
    if let Expression::SemiAdditiveBalance {
        expr: inner,
        opening,
        shift_days,
        non_blank,
    } = expr
    {
        let function = balance_function_name(*opening, *shift_days, *non_blank);
        let (date_table, date_key_column) = require_date_key(function, model)?;
        let base_days = if *opening {
            min_context_days
        } else {
            as_of_days
        };
        let boundary_days = i64::from(base_days)
            .checked_add(*shift_days)
            .and_then(|d| i32::try_from(d).ok())
            .ok_or_else(|| {
                time_intelligence_error(
                    function,
                    format!(
                        "shifting the boundary date by {shift_days} day(s) overflowed the \
                         calendar"
                    ),
                )
            })?;
        let boundary = date32_to_naive(boundary_days).ok_or_else(|| {
            time_intelligence_error(
                function,
                format!("the date probe returned an out-of-range value ({boundary_days} days)"),
            )
        })?;
        let description = format!(
            "{function} (filter context) at the {} date {boundary} on \
             {date_table}.{date_key_column}",
            if *opening { "first" } else { "last" }
        );
        return build_filtered_range_keep(
            inner,
            model,
            &date_table,
            &date_key_column,
            boundary,
            boundary,
            description,
        );
    }

    let (inner, function, granularity, offset, is_shift) = match expr {
        Expression::ToDate {
            expr: inner,
            granularity,
        } => (
            inner.as_ref(),
            to_date_name(*granularity),
            *granularity,
            0i64,
            false,
        ),
        Expression::PeriodShift {
            expr: inner,
            offset,
            granularity,
        } => (
            inner.as_ref(),
            period_shift_name(*offset, *granularity),
            *granularity,
            *offset,
            true,
        ),
        other => {
            return Err(time_intelligence_error(
                "time intelligence",
                format!("expected a top-level ToDate/PeriodShift node, got {other:?}"),
            ));
        }
    };

    // Resolve the date-key column. No compose-ability restriction on the inner
    // aggregate here: the filter-context lowering evaluates it once over a date
    // range (see `time_intelligence_route`).
    let (date_table, date_key_column) = require_date_key(function, model)?;

    let as_of = date32_to_naive(as_of_days).ok_or_else(|| {
        time_intelligence_error(
            function,
            format!("the as-of date probe returned an out-of-range value ({as_of_days} days)"),
        )
    })?;

    // Compute the inclusive [start, end] date window, then make it half-open.
    let (start, end_inclusive, description) = if is_shift {
        // PeriodShift / DATEADD / PARALLELPERIOD: shift the whole current window
        // [min_ctx, as_of] by `offset` periods. The shift is by calendar months
        // (offset × months-per-period) for YEAR/QUARTER/MONTH and by whole
        // 7-day weeks for WEEK; for a context that already spans exactly one
        // period this equals "the prior period".
        let min_ctx = date32_to_naive(min_context_days).ok_or_else(|| {
            time_intelligence_error(
                function,
                format!(
                    "the minimum-context-date probe returned an out-of-range value \
                     ({min_context_days} days)"
                ),
            )
        })?;
        let start = shift_periods(min_ctx, offset, granularity).ok_or_else(|| {
            time_intelligence_error(
                function,
                format!("shifting {min_ctx} by {offset} {granularity}(s) overflowed the calendar"),
            )
        })?;
        let end = shift_periods(as_of, offset, granularity).ok_or_else(|| {
            time_intelligence_error(
                function,
                format!("shifting {as_of} by {offset} {granularity}(s) overflowed the calendar"),
            )
        })?;
        let desc = format!(
            "{function} (filter context) shifted window [{min_ctx}..{as_of}] by {offset} \
             {granularity}(s) to [{start}..{end}] on {date_table}.{date_key_column}"
        );
        (start, end, desc)
    } else {
        // ToDate: [start-of-period(as_of), as_of].
        let start = start_of_period(as_of, granularity, model.fiscal_year_end_month()).ok_or_else(
            || {
                time_intelligence_error(
                    function,
                    format!("computing the start of the {granularity} for {as_of} overflowed"),
                )
            },
        )?;
        let desc = format!(
            "{function} (filter context) range [{start}..{as_of}] on \
             {date_table}.{date_key_column}"
        );
        (start, as_of, desc)
    };

    build_filtered_range_keep(
        inner,
        model,
        &date_table,
        &date_key_column,
        start,
        end_inclusive,
        description,
    )
}

/// Build `Keep(Clear(inner, <date role columns>), [DateKey >= start, DateKey <
/// end_inclusive + 1 day])` — the shared tail of every filter-context
/// time-intelligence lowering (a half-open `DateKey` range that replaces any
/// existing date filter on the date table).
fn build_filtered_range_keep(
    inner: &Expression,
    model: &DataModel,
    date_table: &str,
    date_key_column: &str,
    start: NaiveDate,
    end_inclusive: NaiveDate,
    description: String,
) -> EngineResult<(Expression, String)> {
    let end_exclusive = end_inclusive.succ_opt().ok_or_else(|| {
        time_intelligence_error(
            "time intelligence",
            "the as-of date is the maximum representable date".to_string(),
        )
    })?;

    let clear_targets: Vec<ClearTarget> = date_role_columns(model, date_table)?
        .into_iter()
        .map(|column| ClearTarget::Column {
            table: date_table.to_string(),
            column,
        })
        .collect();
    let cleared = expr::clear(inner.clone(), clear_targets);

    let filters = vec![
        FilterPredicate::new(
            date_table.to_string(),
            date_key_column.to_string(),
            ComparisonOp::GreaterThanOrEqual,
            naive_to_iso(start),
        ),
        FilterPredicate::new(
            date_table.to_string(),
            date_key_column.to_string(),
            ComparisonOp::LessThan,
            naive_to_iso(end_exclusive),
        ),
    ];
    Ok((expr::keep(cleared, filters), description))
}

/// Build the **value-based** (gap-tolerant) filter-context period-shift
/// lowering: `Keep(Clear(inner, <date role columns>), [DateKey >= min,
/// DateKey < max + 1 day] + condition DateKey IN (<shifted set>))`.
///
/// Used when the current date context has an internal hole (e.g. a slicer
/// keeps Jan and Mar but not Feb): the whole-window algebraic shift would
/// span the hole, so instead every distinct context date is shifted
/// **individually** (see [`shift_date_value`], with the DAX `DATEADD`
/// end-of-month snap) and the lowered filter keeps exactly the shifted set.
/// The bounding range predicates are emitted alongside the set condition so
/// the ordinary machinery (date-table join, fetch narrowing) sees a plain
/// range like the contiguous path's; the set condition then excludes the
/// hole. `shifted_days` must be sorted, deduplicated, non-empty `Date32` day
/// counts — the caller (the executor) probes and shifts them.
pub fn lower_period_shift_value_based(
    inner: &Expression,
    model: &DataModel,
    date_table: &str,
    date_key_column: &str,
    shifted_days: &[i32],
    description: String,
) -> EngineResult<(Expression, String)> {
    let (Some(first), Some(last)) = (shifted_days.first(), shifted_days.last()) else {
        return Err(time_intelligence_error(
            "PRIORPERIOD",
            "the value-based shift produced an empty date set (internal error — an empty \
             context yields a blank result before lowering)"
                .to_string(),
        ));
    };
    let start = date32_to_naive(*first).ok_or_else(|| {
        time_intelligence_error(
            "PRIORPERIOD",
            format!("shifted date set start is out of range ({first} days)"),
        )
    })?;
    let end_inclusive = date32_to_naive(*last).ok_or_else(|| {
        time_intelligence_error(
            "PRIORPERIOD",
            format!("shifted date set end is out of range ({last} days)"),
        )
    })?;
    let end_exclusive = end_inclusive.succ_opt().ok_or_else(|| {
        time_intelligence_error(
            "PRIORPERIOD",
            "the shifted end date is the maximum representable date".to_string(),
        )
    })?;

    let clear_targets: Vec<ClearTarget> = date_role_columns(model, date_table)?
        .into_iter()
        .map(|column| ClearTarget::Column {
            table: date_table.to_string(),
            column,
        })
        .collect();
    let cleared = expr::clear(inner.clone(), clear_targets);

    let filters = vec![
        FilterPredicate::new(
            date_table.to_string(),
            date_key_column.to_string(),
            ComparisonOp::GreaterThanOrEqual,
            naive_to_iso(start),
        ),
        FilterPredicate::new(
            date_table.to_string(),
            date_key_column.to_string(),
            ComparisonOp::LessThan,
            naive_to_iso(end_exclusive),
        ),
    ];
    let set_condition = Expression::InList {
        expr: Box::new(Expression::QualifiedColumnRef {
            table_or_var: date_table.to_string(),
            column: date_key_column.to_string(),
        }),
        values: shifted_days
            .iter()
            .map(|d| Expression::LiteralDate(*d))
            .collect(),
        negated: false,
    };
    Ok((
        Expression::Keep {
            expr: Box::new(cleared),
            filters,
            variables: Vec::new(),
            conditions: vec![set_condition],
            in_predicates: Vec::new(),
        },
        description,
    ))
}

/// Build a filter-context `ToDate` (YTD/QTD/MTD) lowering with an **explicit**
/// period start, rather than the Gregorian-algebraic `start_of_period`.
///
/// The host probes the period start from the date table's role columns — e.g.
/// the first `DateKey` of the **fiscal** year/quarter/month containing the as-of
/// date — so this works for a non-Gregorian calendar (where the role columns,
/// not the Gregorian parts of the key, define the periods). `start_days` and
/// `as_of_days` are `Date32` day counts; the produced range is the same half-open
/// `[start, as_of + 1 day)` `Keep(Clear(inner),…)` the Gregorian path emits.
pub fn lower_to_date_explicit_range(
    inner: &Expression,
    model: &DataModel,
    date_table: &str,
    date_key_column: &str,
    start_days: i32,
    as_of_days: i32,
    description: String,
) -> EngineResult<(Expression, String)> {
    let start = date32_to_naive(start_days).ok_or_else(|| {
        time_intelligence_error(
            "time intelligence",
            format!("the period-start probe returned an out-of-range value ({start_days} days)"),
        )
    })?;
    let end = date32_to_naive(as_of_days).ok_or_else(|| {
        time_intelligence_error(
            "time intelligence",
            format!("the as-of date probe returned an out-of-range value ({as_of_days} days)"),
        )
    })?;
    build_filtered_range_keep(
        inner,
        model,
        date_table,
        date_key_column,
        start,
        end,
        description,
    )
}

/// Convert a `Date32` value (days since 1970-01-01) to a [`NaiveDate`].
fn date32_to_naive(days: i32) -> Option<NaiveDate> {
    NaiveDate::from_ymd_opt(1970, 1, 1)?.checked_add_signed(chrono::Duration::days(days as i64))
}

/// Render a [`NaiveDate`] as an ISO `YYYY-MM-DD` string (the filter value;
/// `format_filter_value` quotes it for Date/Timestamp columns).
fn naive_to_iso(date: NaiveDate) -> String {
    date.format("%Y-%m-%d").to_string()
}

/// Start of the period containing `date` for the given granularity.
///
/// `fiscal_year_end_month` (the model's [`DataModel::fiscal_year_end_month`])
/// moves the Year and Quarter boundaries to the fiscal calendar: the fiscal
/// year starts the month AFTER the fiscal year end (e.g. `Some(6)` = June 30
/// year end → years start July 1), and fiscal quarters are 3-month blocks
/// from that start. `None` means calendar years (Dec 31 year end), which
/// reduces exactly to the old Gregorian behavior. Month and Week (the Monday
/// of the date's ISO week) are unaffected by the fiscal setting.
fn start_of_period(
    date: NaiveDate,
    granularity: DateGranularity,
    fiscal_year_end_month: Option<u32>,
) -> Option<NaiveDate> {
    match granularity {
        DateGranularity::Year => {
            let start_month = fiscal_start_month(fiscal_year_end_month);
            let year = if date.month() >= start_month {
                date.year()
            } else {
                date.year() - 1
            };
            NaiveDate::from_ymd_opt(year, start_month, 1)
        }
        DateGranularity::Quarter => {
            // Quarters are 3-month blocks from the fiscal year start: floor
            // the months-since-fiscal-year-start to a multiple of 3.
            let fiscal_year_start =
                start_of_period(date, DateGranularity::Year, fiscal_year_end_month)?;
            let months_since = i64::from(date.year() - fiscal_year_start.year()) * 12
                + i64::from(date.month())
                - i64::from(fiscal_year_start.month());
            shift_months(fiscal_year_start, (months_since / 3) * 3)
        }
        DateGranularity::Month => NaiveDate::from_ymd_opt(date.year(), date.month(), 1),
        DateGranularity::Week => {
            // The Monday of the date's ISO week.
            date.checked_sub_signed(chrono::Duration::days(i64::from(
                date.weekday().num_days_from_monday(),
            )))
        }
        // A day period starts on the day itself.
        DateGranularity::Day => Some(date),
    }
}

/// First month (1-12) of the fiscal year: the month after the fiscal year
/// end. `None` = calendar years, i.e. January.
fn fiscal_start_month(fiscal_year_end_month: Option<u32>) -> u32 {
    match fiscal_year_end_month {
        Some(fye) => (fye % 12) + 1,
        None => 1,
    }
}

/// Shift `date` by `months` calendar months (negative = earlier), clamping the
/// day to the last valid day of the target month (e.g. Mar 31 − 1 month →
/// Feb 28/29). Used by `DATESINPERIOD` to size a trailing window.
fn shift_months(date: NaiveDate, months: i64) -> Option<NaiveDate> {
    let total = i64::from(date.year()) * 12 + i64::from(date.month0()) + months;
    let year = i32::try_from(total.div_euclid(12)).ok()?;
    let month = total.rem_euclid(12) as u32 + 1;
    // The largest valid day-of-month not exceeding the source day.
    (1..=date.day())
        .rev()
        .find_map(|d| NaiveDate::from_ymd_opt(year, month, d))
}

/// Shift `date` by `offset` periods of the given granularity (negative =
/// earlier): whole 7-day weeks for `Week`, calendar months (`offset` ×
/// months-per-period, day clamped via [`shift_months`]) otherwise. Used by
/// `DATESINPERIOD` window sizing and the filter-context `PeriodShift`.
fn shift_periods(date: NaiveDate, offset: i64, granularity: DateGranularity) -> Option<NaiveDate> {
    match granularity {
        DateGranularity::Week => {
            date.checked_add_signed(chrono::Duration::days(offset.checked_mul(7)?))
        }
        DateGranularity::Day => date.checked_add_signed(chrono::Duration::days(offset)),
        _ => shift_months(date, offset.checked_mul(months_per_period(granularity))?),
    }
}

/// Shift a single date **value** by `offset` periods — the per-date shift used
/// by the value-based (gap-tolerant) filter-context period shift.
///
/// Differs from the window-boundary [`shift_periods`] in one way: month-based
/// shifts (Year/Quarter/Month) apply the DAX `DATEADD` **end-of-month snap** —
/// a date that is the last day of its month shifts to the last day of the
/// target month (Apr 30 + 1 month → May 31, Feb 28 + 12 months → Feb 29 in a
/// leap year). Without the snap, a full-month context would map to a
/// truncated target month (Apr 1..30 + 1 month → May 1..30, silently missing
/// May 31). Week and Day shifts are exact day arithmetic and need no snap.
pub fn shift_date_value(
    date: NaiveDate,
    offset: i64,
    granularity: DateGranularity,
) -> Option<NaiveDate> {
    match granularity {
        DateGranularity::Week | DateGranularity::Day => shift_periods(date, offset, granularity),
        _ => {
            let shifted = shift_months(date, offset.checked_mul(months_per_period(granularity))?)?;
            let is_input_month_end = date
                .succ_opt()
                .is_none_or(|next| next.month() != date.month());
            if is_input_month_end {
                last_day_of_month(shifted)
            } else {
                Some(shifted)
            }
        }
    }
}

/// Shift a `Date32` day count by `offset` periods via [`shift_date_value`],
/// returning the shifted `Date32` day count. `None` on calendar overflow.
pub fn shift_date32_value(days: i32, offset: i64, granularity: DateGranularity) -> Option<i32> {
    let date = date32_to_naive(days)?;
    let shifted = shift_date_value(date, offset, granularity)?;
    let epoch = NaiveDate::from_ymd_opt(1970, 1, 1)?;
    i32::try_from(shifted.signed_duration_since(epoch).num_days()).ok()
}

/// The last calendar day of `date`'s month.
fn last_day_of_month(date: NaiveDate) -> Option<NaiveDate> {
    let first_of_next = if date.month() == 12 {
        NaiveDate::from_ymd_opt(date.year().checked_add(1)?, 1, 1)
    } else {
        NaiveDate::from_ymd_opt(date.year(), date.month() + 1, 1)
    }?;
    first_of_next.pred_opt()
}

/// Months per `DateGranularity` period (for month-based period shifts; `Week`
/// and `Day` have no whole-month size and are handled by [`shift_periods`]
/// directly).
fn months_per_period(granularity: DateGranularity) -> i64 {
    match granularity {
        DateGranularity::Year => 12,
        DateGranularity::Quarter => 3,
        DateGranularity::Month => 1,
        // Unreachable via shift_periods (Week/Day shift by days); a bare
        // caller would treat a week as its containing month, so keep them out
        // of the month math entirely.
        DateGranularity::Week | DateGranularity::Day => {
            unreachable!("Week/Day periods are day-based, not month-based")
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shift_date_value_applies_end_of_month_snap() {
        let d = |y, m, dd| NaiveDate::from_ymd_opt(y, m, dd).unwrap();
        // Month-end input snaps to the target month end (DAX DATEADD).
        assert_eq!(
            shift_date_value(d(2024, 4, 30), 1, DateGranularity::Month),
            Some(d(2024, 5, 31))
        );
        assert_eq!(
            shift_date_value(d(2023, 2, 28), 1, DateGranularity::Year),
            Some(d(2024, 2, 29)),
            "non-leap Feb end shifts to leap Feb end"
        );
        // Non-month-end input shifts plainly (with day clamping).
        assert_eq!(
            shift_date_value(d(2024, 3, 15), -1, DateGranularity::Month),
            Some(d(2024, 2, 15))
        );
        assert_eq!(
            shift_date_value(d(2024, 3, 30), -1, DateGranularity::Month),
            Some(d(2024, 2, 29)),
            "day clamps to the target month length"
        );
        // Week/Day shifts are exact day arithmetic — no snap.
        assert_eq!(
            shift_date_value(d(2024, 1, 31), 1, DateGranularity::Week),
            Some(d(2024, 2, 7))
        );
        assert_eq!(
            shift_date_value(d(2024, 3, 1), -1, DateGranularity::Day),
            Some(d(2024, 2, 29))
        );
    }

    #[test]
    fn shift_date32_value_round_trips_day_counts() {
        // 2024-02-10 is day 19763; -1 day = 19762.
        let base = 19763;
        assert_eq!(
            shift_date32_value(base, -1, DateGranularity::Day),
            Some(base - 1)
        );
        assert_eq!(
            shift_date32_value(base, 1, DateGranularity::Week),
            Some(base + 7)
        );
    }

    #[test]
    fn balance_function_names_cover_all_spellings() {
        assert_eq!(balance_function_name(true, 0, false), "OPENINGBALANCE");
        assert_eq!(balance_function_name(false, 0, false), "CLOSINGBALANCE");
        assert_eq!(balance_function_name(true, -1, false), "PREVIOUSDAY");
        assert_eq!(balance_function_name(false, 1, false), "NEXTDAY");
        assert_eq!(balance_function_name(true, 0, true), "FIRSTNONBLANK");
        assert_eq!(balance_function_name(false, 0, true), "LASTNONBLANK");
    }
    use crate::model::{Column, Table};

    /// fact_sales + dim_date model with the standard date roles; `dim_date`
    /// is marked as the date table. `month_name` deliberately has no role.
    fn model() -> DataModel {
        let dim_date = Table::new(
            "dim_date",
            vec![
                Column::new("datekey", DataType::Date).with_date_role(DateRole::DateKey),
                Column::new("year", DataType::Int32).with_date_role(DateRole::Year),
                Column::new("quarter", DataType::Int32).with_date_role(DateRole::Quarter),
                Column::new("month", DataType::Int32).with_date_role(DateRole::Month),
                Column::new("day", DataType::Int32).with_date_role(DateRole::Day),
                Column::new("month_name", DataType::String),
            ],
        )
        .unwrap();
        let fact = Table::new(
            "fact_sales",
            vec![
                Column::new("amount", DataType::Float64),
                Column::new("region", DataType::String),
            ],
        )
        .unwrap();
        DataModel::builder()
            .add_table(dim_date)
            .add_table(fact)
            .mark_date_table("dim_date")
            .build()
            .unwrap()
    }

    fn pairs(items: &[(&str, &str)]) -> Vec<(String, String)> {
        items
            .iter()
            .map(|(t, c)| (t.to_string(), c.to_string()))
            .collect()
    }

    fn sum_amount() -> Expression {
        expr::agg(
            AggregateOp::Sum,
            expr::qualified_col("fact_sales", "amount"),
        )
    }

    #[test]
    fn ytd_lowers_to_running_sum_window() {
        let model = model();
        let ytd = expr::to_date(sum_amount(), DateGranularity::Year);
        let group_by = pairs(&[("dim_date", "year"), ("dim_date", "month")]);

        let (lowered, description) = lower_time_intelligence(&ytd, &model, &group_by).unwrap();

        let Expression::Window {
            inner,
            function,
            order_by,
            partition_by,
            frame,
        } = &lowered
        else {
            panic!("expected Window, got {lowered:?}");
        };
        assert!(matches!(
            inner.as_ref(),
            Expression::Aggregate {
                operation: AggregateOp::Sum,
                ..
            }
        ));
        assert_eq!(*function, AggregateOp::Sum);
        assert_eq!(
            partition_by,
            &[("dim_date".to_string(), "year".to_string())]
        );
        assert_eq!(order_by, &[("dim_date".to_string(), "month".to_string())]);
        assert!(frame.is_none(), "default frame = running total");
        assert!(description.unwrap().contains("YTD"));
    }

    #[test]
    fn ytd_orders_finer_columns_coarse_to_fine() {
        let model = model();
        let ytd = expr::to_date(sum_amount(), DateGranularity::Year);
        // Deliberately scrambled group_by order: month, day, year, quarter.
        let group_by = pairs(&[
            ("dim_date", "month"),
            ("dim_date", "day"),
            ("dim_date", "year"),
            ("dim_date", "quarter"),
        ]);

        let (lowered, _) = lower_time_intelligence(&ytd, &model, &group_by).unwrap();
        let Expression::Window { order_by, .. } = &lowered else {
            panic!("expected Window");
        };
        assert_eq!(
            order_by,
            &[
                ("dim_date".to_string(), "quarter".to_string()),
                ("dim_date".to_string(), "month".to_string()),
                ("dim_date".to_string(), "day".to_string()),
            ]
        );
    }

    #[test]
    fn qtd_partitions_by_year_and_quarter() {
        let model = model();
        let qtd = expr::to_date(sum_amount(), DateGranularity::Quarter);
        let group_by = pairs(&[
            ("dim_date", "year"),
            ("dim_date", "quarter"),
            ("dim_date", "month"),
        ]);

        let (lowered, _) = lower_time_intelligence(&qtd, &model, &group_by).unwrap();
        let Expression::Window {
            partition_by,
            order_by,
            ..
        } = &lowered
        else {
            panic!("expected Window");
        };
        assert_eq!(
            partition_by,
            &[
                ("dim_date".to_string(), "year".to_string()),
                ("dim_date".to_string(), "quarter".to_string()),
            ]
        );
        assert_eq!(order_by, &[("dim_date".to_string(), "month".to_string())]);
    }

    #[test]
    fn mtd_partitions_by_year_and_month() {
        let model = model();
        let mtd = expr::to_date(sum_amount(), DateGranularity::Month);
        let group_by = pairs(&[
            ("dim_date", "year"),
            ("dim_date", "month"),
            ("dim_date", "day"),
        ]);

        let (lowered, _) = lower_time_intelligence(&mtd, &model, &group_by).unwrap();
        let Expression::Window {
            partition_by,
            order_by,
            ..
        } = &lowered
        else {
            panic!("expected Window");
        };
        assert_eq!(
            partition_by,
            &[
                ("dim_date".to_string(), "year".to_string()),
                ("dim_date".to_string(), "month".to_string()),
            ]
        );
        assert_eq!(order_by, &[("dim_date".to_string(), "day".to_string())]);
    }

    #[test]
    fn ytd_count_lowers_to_sum_window() {
        let model = model();
        let ytd = expr::to_date(expr::count_rows(), DateGranularity::Year);
        let group_by = pairs(&[("dim_date", "year"), ("dim_date", "month")]);

        let (lowered, _) = lower_time_intelligence(&ytd, &model, &group_by).unwrap();
        let Expression::Window { function, .. } = &lowered else {
            panic!("expected Window");
        };
        // Running count = SUM of per-period counts.
        assert_eq!(*function, AggregateOp::Sum);
    }

    #[test]
    fn ytd_min_max_keep_their_window_function() {
        let model = model();
        let group_by = pairs(&[("dim_date", "year"), ("dim_date", "month")]);
        for (op, expected) in [
            (AggregateOp::Min, AggregateOp::Min),
            (AggregateOp::Max, AggregateOp::Max),
        ] {
            let ytd = expr::to_date(
                expr::agg(op, expr::qualified_col("fact_sales", "amount")),
                DateGranularity::Year,
            );
            let (lowered, _) = lower_time_intelligence(&ytd, &model, &group_by).unwrap();
            let Expression::Window { function, .. } = &lowered else {
                panic!("expected Window");
            };
            assert_eq!(*function, expected);
        }
    }

    #[test]
    fn ytd_average_is_rejected() {
        let model = model();
        let ytd = expr::to_date(
            expr::agg(
                AggregateOp::Average,
                expr::qualified_col("fact_sales", "amount"),
            ),
            DateGranularity::Year,
        );
        let group_by = pairs(&[("dim_date", "year"), ("dim_date", "month")]);

        let err = lower_time_intelligence(&ytd, &model, &group_by).unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("Average"), "got: {msg}");
        assert!(msg.contains("not supported in v1"), "got: {msg}");
    }

    #[test]
    fn ytd_arithmetic_inner_is_rejected() {
        let model = model();
        let ratio = expr::agg(AggregateOp::Sum, expr::col("a"))
            .divide(expr::agg(AggregateOp::Count, expr::col("b")));
        let ytd = expr::to_date(ratio, DateGranularity::Year);
        let group_by = pairs(&[("dim_date", "year"), ("dim_date", "month")]);

        let err = lower_time_intelligence(&ytd, &model, &group_by).unwrap_err();
        assert!(
            err.to_string().contains("single SUM, COUNT, COUNTROWS"),
            "got: {err}"
        );
    }

    #[test]
    fn ytd_without_date_table_names_the_fix() {
        let no_date_table = DataModel::builder()
            .add_table(
                Table::new("fact_sales", vec![Column::new("amount", DataType::Float64)]).unwrap(),
            )
            .build()
            .unwrap();
        let ytd = expr::to_date(sum_amount(), DateGranularity::Year);

        let err = lower_time_intelligence(&ytd, &no_date_table, &[]).unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("mark_date_table"), "got: {msg}");
        assert!(matches!(err, EngineError::TimeIntelligence { .. }));
    }

    #[test]
    fn ytd_missing_year_in_group_by_lists_axis() {
        let model = model();
        let ytd = expr::to_date(sum_amount(), DateGranularity::Year);
        let group_by = pairs(&[("dim_date", "month"), ("fact_sales", "region")]);

        let err = lower_time_intelligence(&ytd, &model, &group_by).unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("Year column 'dim_date[year]'"), "got: {msg}");
        assert!(
            msg.contains("dim_date[month], fact_sales[region]"),
            "got: {msg}"
        );
    }

    #[test]
    fn ytd_without_finer_column_is_rejected() {
        let model = model();
        let ytd = expr::to_date(sum_amount(), DateGranularity::Year);
        let group_by = pairs(&[("dim_date", "year")]);

        let err = lower_time_intelligence(&ytd, &model, &group_by).unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("finer than Year"), "got: {msg}");
        assert!(
            msg.contains("Quarter, Month, Week, Day, DateKey"),
            "got: {msg}"
        );
    }

    #[test]
    fn ytd_with_unroled_date_table_column_is_rejected() {
        let model = model();
        let ytd = expr::to_date(sum_amount(), DateGranularity::Year);
        let group_by = pairs(&[
            ("dim_date", "year"),
            ("dim_date", "month"),
            ("dim_date", "month_name"),
        ]);

        let err = lower_time_intelligence(&ytd, &model, &group_by).unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("month_name"), "got: {msg}");
        assert!(msg.contains("with_date_role"), "got: {msg}");
    }

    #[test]
    fn qtd_missing_role_on_date_table_names_the_role() {
        // Date table without a Quarter column at all.
        let dim_date = Table::new(
            "dim_date",
            vec![
                Column::new("year", DataType::Int32).with_date_role(DateRole::Year),
                Column::new("month", DataType::Int32).with_date_role(DateRole::Month),
            ],
        )
        .unwrap();
        let model = DataModel::builder()
            .add_table(dim_date)
            .mark_date_table("dim_date")
            .build()
            .unwrap();
        let qtd = expr::to_date(sum_amount(), DateGranularity::Quarter);
        let group_by = pairs(&[("dim_date", "year"), ("dim_date", "month")]);

        let err = lower_time_intelligence(&qtd, &model, &group_by).unwrap_err();
        let msg = err.to_string();
        assert!(
            msg.contains("no column with the Quarter role"),
            "got: {msg}"
        );
    }

    #[test]
    fn prioryear_lowers_to_offset_along_year() {
        let model = model();
        let py = expr::period_shift(sum_amount(), -1, DateGranularity::Year);
        let group_by = pairs(&[("dim_date", "year"), ("dim_date", "month")]);

        let (lowered, description) = lower_time_intelligence(&py, &model, &group_by).unwrap();
        let Expression::Offset {
            inner,
            delta,
            order_by,
            partition_by,
        } = &lowered
        else {
            panic!("expected Offset, got {lowered:?}");
        };
        assert!(matches!(inner.as_ref(), Expression::Aggregate { .. }));
        assert_eq!(*delta, -1);
        assert_eq!(order_by, &[("dim_date".to_string(), "year".to_string())]);
        // Finer/other dimensions reach PARTITION BY via the window
        // executor's outer group-by injection, not here.
        assert!(partition_by.is_empty());
        assert!(description.unwrap().contains("PRIORYEAR"));
    }

    #[test]
    fn prioryear_allows_arithmetic_inner() {
        // PeriodShift shifts the computed value, so any inner measure works.
        let model = model();
        let ratio = expr::agg(AggregateOp::Sum, expr::col("a"))
            .divide(expr::agg(AggregateOp::Count, expr::col("b")));
        let py = expr::period_shift(ratio, -1, DateGranularity::Year);
        let group_by = pairs(&[("dim_date", "year"), ("dim_date", "month")]);

        let (lowered, _) = lower_time_intelligence(&py, &model, &group_by).unwrap();
        assert!(matches!(lowered, Expression::Offset { .. }));
    }

    #[test]
    fn priorperiod_quarter_orders_by_year_and_quarter() {
        let model = model();
        let pp = expr::period_shift(sum_amount(), -2, DateGranularity::Quarter);
        let group_by = pairs(&[("dim_date", "year"), ("dim_date", "quarter")]);

        let (lowered, _) = lower_time_intelligence(&pp, &model, &group_by).unwrap();
        let Expression::Offset {
            delta, order_by, ..
        } = &lowered
        else {
            panic!("expected Offset");
        };
        assert_eq!(*delta, -2);
        assert_eq!(
            order_by,
            &[
                ("dim_date".to_string(), "year".to_string()),
                ("dim_date".to_string(), "quarter".to_string()),
            ]
        );
    }

    #[test]
    fn priorperiod_quarter_with_finer_axis_is_rejected() {
        let model = model();
        let pp = expr::period_shift(sum_amount(), -1, DateGranularity::Quarter);
        let group_by = pairs(&[
            ("dim_date", "year"),
            ("dim_date", "quarter"),
            ("dim_date", "month"),
        ]);

        let err = lower_time_intelligence(&pp, &model, &group_by).unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("finer date columns"), "got: {msg}");
        assert!(msg.contains("month"), "got: {msg}");
    }

    #[test]
    fn non_time_intelligence_passes_through_unchanged() {
        let model = model();
        let plain = sum_amount();
        let group_by = pairs(&[("dim_date", "year")]);

        let (lowered, description) = lower_time_intelligence(&plain, &model, &group_by).unwrap();
        assert!(description.is_none());
        assert!(matches!(lowered, Expression::Aggregate { .. }));
    }

    #[test]
    fn date_table_match_is_case_insensitive() {
        let model = model();
        let ytd = expr::to_date(sum_amount(), DateGranularity::Year);
        let group_by = pairs(&[("DIM_DATE", "YEAR"), ("DIM_DATE", "MONTH")]);

        let (lowered, _) = lower_time_intelligence(&ytd, &model, &group_by).unwrap();
        let Expression::Window { partition_by, .. } = &lowered else {
            panic!("expected Window");
        };
        // Spelled as written in the group_by request.
        assert_eq!(
            partition_by,
            &[("DIM_DATE".to_string(), "YEAR".to_string())]
        );
    }

    // ----- Filter-context (v2) path -----------------------------------------

    /// Days since the Unix epoch for a calendar date (Arrow `Date32`).
    fn days(y: i32, m: u32, d: u32) -> i32 {
        let epoch = NaiveDate::from_ymd_opt(1970, 1, 1).unwrap();
        NaiveDate::from_ymd_opt(y, m, d)
            .unwrap()
            .signed_duration_since(epoch)
            .num_days() as i32
    }

    #[test]
    fn route_is_axis_when_anchor_columns_present() {
        let model = model();
        let ytd = expr::to_date(sum_amount(), DateGranularity::Year);
        // Year (anchor) is present → axis path.
        let group_by = pairs(&[("dim_date", "year"), ("dim_date", "month")]);
        let route = time_intelligence_route(&ytd, &model, &group_by).unwrap();
        assert_eq!(route, Some(TimeIntelligenceRoute::Axis));
    }

    #[test]
    fn route_is_filter_context_when_no_date_on_axis() {
        let model = model();
        let ytd = expr::to_date(sum_amount(), DateGranularity::Year);
        // No date column on the axis → filter-context path.
        let group_by = pairs(&[("fact_sales", "region")]);
        let route = time_intelligence_route(&ytd, &model, &group_by).unwrap();
        let Some(TimeIntelligenceRoute::FilterContext(plan)) = route else {
            panic!("expected FilterContext, got {route:?}");
        };
        assert_eq!(plan.function, "YTD");
        assert_eq!(plan.date_table, "dim_date");
        assert_eq!(plan.date_key_column, "datekey");
        assert!(!plan.needs_min_context_date, "ToDate needs only as-of");
    }

    #[test]
    fn route_filter_context_prioryear_needs_min_context() {
        let model = model();
        let py = expr::period_shift(sum_amount(), -1, DateGranularity::Year);
        let group_by = pairs(&[("fact_sales", "region")]);
        let route = time_intelligence_route(&py, &model, &group_by).unwrap();
        let Some(TimeIntelligenceRoute::FilterContext(plan)) = route else {
            panic!("expected FilterContext, got {route:?}");
        };
        assert_eq!(plan.function, "PRIORYEAR");
        assert!(plan.needs_min_context_date, "PeriodShift shifts the window");
    }

    #[test]
    fn route_non_time_intelligence_is_none() {
        let model = model();
        let route = time_intelligence_route(&sum_amount(), &model, &[]).unwrap();
        assert_eq!(route, None);
    }

    #[test]
    fn route_filter_context_quarter_shift_is_a_window_shift() {
        // PRIORPERIOD/DATEADD/PARALLELPERIOD(..., -1, QUARTER) with date NOT on
        // the axis now routes to the filter-context path as a whole-window
        // shift (no longer rejected).
        let model = model();
        let pp = expr::period_shift(sum_amount(), -1, DateGranularity::Quarter);
        let group_by = pairs(&[("fact_sales", "region")]);
        let route = time_intelligence_route(&pp, &model, &group_by).unwrap();
        assert!(
            matches!(route, Some(TimeIntelligenceRoute::FilterContext(_))),
            "got: {route:?}"
        );
    }

    #[test]
    fn route_filter_context_average_is_accepted() {
        // In FILTER-CONTEXT mode (no date on the axis), YTD lowers to a single
        // range evaluation, so AVERAGE is exact and must route — unlike the AXIS
        // path (see `ytd_average_is_rejected`), which still rejects it.
        let model = model();
        let ytd = expr::to_date(
            expr::agg(
                AggregateOp::Average,
                expr::qualified_col("fact_sales", "amount"),
            ),
            DateGranularity::Year,
        );
        let group_by = pairs(&[("fact_sales", "region")]);
        let route = time_intelligence_route(&ytd, &model, &group_by).unwrap();
        assert!(
            matches!(route, Some(TimeIntelligenceRoute::FilterContext(_))),
            "got: {route:?}"
        );
    }

    #[test]
    fn route_filter_context_without_datekey_role_is_rejected() {
        // Date table with role columns but NO DateKey column.
        let dim_date = Table::new(
            "dim_date",
            vec![
                Column::new("year", DataType::Int32).with_date_role(DateRole::Year),
                Column::new("month", DataType::Int32).with_date_role(DateRole::Month),
            ],
        )
        .unwrap();
        let model = DataModel::builder()
            .add_table(dim_date)
            .mark_date_table("dim_date")
            .build()
            .unwrap();
        let ytd = expr::to_date(sum_amount(), DateGranularity::Year);
        let group_by = pairs(&[("fact_sales", "region")]);
        let err = time_intelligence_route(&ytd, &model, &group_by).unwrap_err();
        assert!(err.to_string().contains("DateKey role"), "got: {err}");
    }

    #[test]
    fn filtered_ytd_builds_half_open_range_to_start_of_year() {
        let model = model();
        let ytd = expr::to_date(sum_amount(), DateGranularity::Year);
        // As-of = 2024-06-15. YTD range = [2024-01-01, 2024-06-16).
        let as_of = days(2024, 6, 15);
        let (lowered, desc) = lower_time_intelligence_filtered(&ytd, &model, as_of, as_of).unwrap();

        let Expression::Keep {
            expr: inner,
            filters,
            ..
        } = &lowered
        else {
            panic!("expected Keep, got {lowered:?}");
        };
        // Inner is a Clear over the date-role columns.
        let Expression::Clear { targets, .. } = inner.as_ref() else {
            panic!("expected Clear inside Keep");
        };
        assert!(
            targets.iter().any(|t| matches!(
                t,
                ClearTarget::Column { column, .. } if column == "datekey"
            )),
            "datekey must be cleared"
        );
        assert_eq!(filters.len(), 2);
        assert_eq!(filters[0].operator, ComparisonOp::GreaterThanOrEqual);
        assert_eq!(filters[0].value, "2024-01-01");
        assert_eq!(filters[1].operator, ComparisonOp::LessThan);
        assert_eq!(filters[1].value, "2024-06-16");
        assert!(desc.contains("YTD"));
    }

    #[test]
    fn filtered_qtd_uses_start_of_quarter() {
        let model = model();
        let qtd = expr::to_date(sum_amount(), DateGranularity::Quarter);
        // As-of = 2024-05-10 → Q2 starts 2024-04-01; range = [04-01, 05-11).
        let as_of = days(2024, 5, 10);
        let (lowered, _) = lower_time_intelligence_filtered(&qtd, &model, as_of, as_of).unwrap();
        let Expression::Keep { filters, .. } = &lowered else {
            panic!("expected Keep");
        };
        assert_eq!(filters[0].value, "2024-04-01");
        assert_eq!(filters[1].value, "2024-05-11");
    }

    #[test]
    fn filtered_mtd_uses_start_of_month() {
        let model = model();
        let mtd = expr::to_date(sum_amount(), DateGranularity::Month);
        let as_of = days(2024, 7, 20);
        let (lowered, _) = lower_time_intelligence_filtered(&mtd, &model, as_of, as_of).unwrap();
        let Expression::Keep { filters, .. } = &lowered else {
            panic!("expected Keep");
        };
        assert_eq!(filters[0].value, "2024-07-01");
        assert_eq!(filters[1].value, "2024-07-21");
    }

    #[test]
    fn filtered_prioryear_shifts_whole_window_back_one_year() {
        let model = model();
        let py = expr::period_shift(sum_amount(), -1, DateGranularity::Year);
        // Current window = [2024-02-01, 2024-06-15]; shifted = [2023-02-01, 2023-06-15];
        // half-open upper bound = 2023-06-16.
        let min_ctx = days(2024, 2, 1);
        let as_of = days(2024, 6, 15);
        let (lowered, _) = lower_time_intelligence_filtered(&py, &model, as_of, min_ctx).unwrap();
        let Expression::Keep { filters, .. } = &lowered else {
            panic!("expected Keep");
        };
        assert_eq!(filters[0].operator, ComparisonOp::GreaterThanOrEqual);
        assert_eq!(filters[0].value, "2023-02-01");
        assert_eq!(filters[1].operator, ComparisonOp::LessThan);
        assert_eq!(filters[1].value, "2023-06-16");
    }

    #[test]
    fn shift_months_clamps_leap_day() {
        // 2024-02-29 shifted back twelve months (one year) → 2023-02-28
        // (2023 is not a leap year). A whole-year shift is just 12 months.
        let d = NaiveDate::from_ymd_opt(2024, 2, 29).unwrap();
        assert_eq!(
            shift_months(d, -12).unwrap(),
            NaiveDate::from_ymd_opt(2023, 2, 28).unwrap()
        );
    }

    #[test]
    fn start_of_period_quarter_boundaries() {
        // Each month maps to the first month of its quarter (calendar years).
        for (m, q_start) in [
            (1, 1),
            (3, 1),
            (4, 4),
            (6, 4),
            (7, 7),
            (9, 7),
            (10, 10),
            (12, 10),
        ] {
            let d = NaiveDate::from_ymd_opt(2024, m, 15).unwrap();
            assert_eq!(
                start_of_period(d, DateGranularity::Quarter, None).unwrap(),
                NaiveDate::from_ymd_opt(2024, q_start, 1).unwrap(),
                "month {m}"
            );
        }
    }

    #[test]
    fn start_of_period_fiscal_year_and_quarter() {
        // Fiscal year end June 30 → fiscal years start July 1.
        let fye = Some(6);
        // 2024-08-15 is in the fiscal year starting 2024-07-01.
        let d = NaiveDate::from_ymd_opt(2024, 8, 15).unwrap();
        assert_eq!(
            start_of_period(d, DateGranularity::Year, fye).unwrap(),
            NaiveDate::from_ymd_opt(2024, 7, 1).unwrap()
        );
        // 2024-03-10 is still in the fiscal year that started 2023-07-01.
        let d = NaiveDate::from_ymd_opt(2024, 3, 10).unwrap();
        assert_eq!(
            start_of_period(d, DateGranularity::Year, fye).unwrap(),
            NaiveDate::from_ymd_opt(2023, 7, 1).unwrap()
        );
        // Fiscal quarters are 3-month blocks from July: Jul-Sep, Oct-Dec,
        // Jan-Mar, Apr-Jun. 2024-08-15 → Q starting 2024-07-01; 2024-03-10 →
        // Q starting 2024-01-01; 2024-05-01 → Q starting 2024-04-01.
        let d = NaiveDate::from_ymd_opt(2024, 8, 15).unwrap();
        assert_eq!(
            start_of_period(d, DateGranularity::Quarter, fye).unwrap(),
            NaiveDate::from_ymd_opt(2024, 7, 1).unwrap()
        );
        let d = NaiveDate::from_ymd_opt(2024, 3, 10).unwrap();
        assert_eq!(
            start_of_period(d, DateGranularity::Quarter, fye).unwrap(),
            NaiveDate::from_ymd_opt(2024, 1, 1).unwrap()
        );
        let d = NaiveDate::from_ymd_opt(2024, 5, 1).unwrap();
        assert_eq!(
            start_of_period(d, DateGranularity::Quarter, fye).unwrap(),
            NaiveDate::from_ymd_opt(2024, 4, 1).unwrap()
        );
    }

    #[test]
    fn start_of_period_fiscal_december_end_equals_calendar() {
        // A December year end is exactly the calendar year: Some(12) == None.
        for m in 1u32..=12 {
            let d = NaiveDate::from_ymd_opt(2024, m, 15).unwrap();
            for g in [
                DateGranularity::Year,
                DateGranularity::Quarter,
                DateGranularity::Month,
                DateGranularity::Week,
            ] {
                assert_eq!(
                    start_of_period(d, g, Some(12)),
                    start_of_period(d, g, None),
                    "month {m}, {g}"
                );
            }
        }
    }

    #[test]
    fn start_of_period_week_is_monday_of_iso_week() {
        // 2024-07-10 is a Wednesday → its ISO week starts Monday 2024-07-08.
        let d = NaiveDate::from_ymd_opt(2024, 7, 10).unwrap();
        assert_eq!(
            start_of_period(d, DateGranularity::Week, None).unwrap(),
            NaiveDate::from_ymd_opt(2024, 7, 8).unwrap()
        );
        // A Monday is its own week start.
        let d = NaiveDate::from_ymd_opt(2024, 7, 8).unwrap();
        assert_eq!(start_of_period(d, DateGranularity::Week, None).unwrap(), d);
        // A Sunday belongs to the week that started six days earlier — even
        // across a month boundary (2024-06-30 → Monday 2024-06-24).
        let d = NaiveDate::from_ymd_opt(2024, 6, 30).unwrap();
        assert_eq!(
            start_of_period(d, DateGranularity::Week, None).unwrap(),
            NaiveDate::from_ymd_opt(2024, 6, 24).unwrap()
        );
    }

    #[test]
    fn shift_periods_week_moves_whole_weeks() {
        let d = NaiveDate::from_ymd_opt(2024, 7, 10).unwrap();
        assert_eq!(
            shift_periods(d, -2, DateGranularity::Week).unwrap(),
            NaiveDate::from_ymd_opt(2024, 6, 26).unwrap()
        );
        // Month-based granularities defer to shift_months.
        assert_eq!(
            shift_periods(d, -1, DateGranularity::Quarter).unwrap(),
            shift_months(d, -3).unwrap()
        );
    }

    #[test]
    fn filtered_wtd_uses_monday_of_iso_week() {
        let model = model();
        let wtd = expr::to_date(sum_amount(), DateGranularity::Week);
        // As-of = 2024-07-10 (Wednesday) → range [2024-07-08, 2024-07-11).
        let as_of = days(2024, 7, 10);
        let (lowered, desc) = lower_time_intelligence_filtered(&wtd, &model, as_of, as_of).unwrap();
        let Expression::Keep { filters, .. } = &lowered else {
            panic!("expected Keep");
        };
        assert_eq!(filters[0].value, "2024-07-08");
        assert_eq!(filters[1].value, "2024-07-11");
        assert!(desc.contains("WTD"));
    }

    #[test]
    fn wtd_on_axis_fails_closed() {
        let model = model();
        let wtd = expr::to_date(sum_amount(), DateGranularity::Week);
        let group_by = pairs(&[("dim_date", "year"), ("dim_date", "month")]);

        // Route: a date column on the axis must be a typed error, not Axis.
        let err = time_intelligence_route(&wtd, &model, &group_by).unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("WTD"), "got: {msg}");
        assert!(msg.contains("filter context"), "got: {msg}");

        // The direct axis lowering fails closed the same way.
        let err = lower_time_intelligence(&wtd, &model, &group_by).unwrap_err();
        assert!(err.to_string().contains("WTD"), "got: {err}");
    }

    #[test]
    fn filtered_fiscal_ytd_starts_at_fiscal_year_start() {
        // Model with fiscal year end June 30: YTD at 2024-08-15 runs from
        // 2024-07-01 (fiscal), not 2024-01-01 (calendar).
        let fiscal_model = model().with_fiscal_year_end_month(Some(6));
        let ytd = expr::to_date(sum_amount(), DateGranularity::Year);
        let as_of = days(2024, 8, 15);
        let (lowered, _) =
            lower_time_intelligence_filtered(&ytd, &fiscal_model, as_of, as_of).unwrap();
        let Expression::Keep { filters, .. } = &lowered else {
            panic!("expected Keep");
        };
        assert_eq!(filters[0].value, "2024-07-01");
        assert_eq!(filters[1].value, "2024-08-16");

        // The calendar model differs: start = 2024-01-01.
        let (calendar, _) = lower_time_intelligence_filtered(&ytd, &model(), as_of, as_of).unwrap();
        let Expression::Keep { filters, .. } = &calendar else {
            panic!("expected Keep");
        };
        assert_eq!(filters[0].value, "2024-01-01");
    }

    #[test]
    fn filtered_dates_between_builds_absolute_half_open_range() {
        let model = model();
        let db = expr::dates_between(sum_amount(), "2024-02-01", "2024-06-15");
        // The probes are ignored: pass an unrelated as-of date.
        let as_of = days(2025, 12, 31);
        let (lowered, desc) = lower_time_intelligence_filtered(&db, &model, as_of, as_of).unwrap();
        let Expression::Keep {
            expr: inner,
            filters,
            ..
        } = &lowered
        else {
            panic!("expected Keep, got {lowered:?}");
        };
        let Expression::Clear { targets, .. } = inner.as_ref() else {
            panic!("expected Clear inside Keep");
        };
        assert!(
            targets.iter().any(|t| matches!(
                t,
                ClearTarget::Column { column, .. } if column == "datekey"
            )),
            "datekey must be cleared"
        );
        assert_eq!(filters[0].operator, ComparisonOp::GreaterThanOrEqual);
        assert_eq!(filters[0].value, "2024-02-01");
        assert_eq!(filters[1].operator, ComparisonOp::LessThan);
        assert_eq!(filters[1].value, "2024-06-16");
        assert!(desc.contains("DATESBETWEEN"));
    }

    #[test]
    fn route_dates_between_is_filter_context_only() {
        let model = model();
        let db = expr::dates_between(sum_amount(), "2024-02-01", "2024-06-15");

        // No date column on the axis → filter-context plan, no min probe.
        let route =
            time_intelligence_route(&db, &model, &pairs(&[("fact_sales", "region")])).unwrap();
        let Some(TimeIntelligenceRoute::FilterContext(plan)) = route else {
            panic!("expected FilterContext, got {route:?}");
        };
        assert_eq!(plan.function, "DATESBETWEEN");
        assert!(!plan.needs_min_context_date, "the range is absolute");

        // A date column on the axis fails closed with a typed error.
        let err =
            time_intelligence_route(&db, &model, &pairs(&[("dim_date", "year")])).unwrap_err();
        let msg = err.to_string();
        assert!(msg.contains("DATESBETWEEN"), "got: {msg}");
        assert!(msg.contains("query axis"), "got: {msg}");
    }

    #[test]
    fn filtered_dates_between_rejects_inverted_range() {
        let model = model();
        let db = expr::dates_between(sum_amount(), "2024-06-15", "2024-02-01");
        let as_of = days(2024, 12, 31);
        let err = lower_time_intelligence_filtered(&db, &model, as_of, as_of).unwrap_err();
        assert!(err.to_string().contains("after end date"), "got: {err}");
    }
}
