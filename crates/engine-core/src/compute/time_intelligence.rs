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
//! Deferred to a future version (full-DAX behavior): filter-context
//! `DATESYTD`-style evaluation without the date axis in group_by, value-based
//! period matching across gaps, `DATEADD` over date keys, fiscal calendars,
//! and composition with totals/hierarchies (the window execution path
//! rejects those today).

use crate::compute::aggregate::AggregateOp;
use crate::compute::expression::{DateGranularity, Expression};
use crate::error::{EngineError, EngineResult};
use crate::model::{DataModel, DateRole};

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

/// Anchor roles for a granularity: the columns that define one period.
fn anchor_roles(granularity: DateGranularity) -> &'static [DateRole] {
    match granularity {
        DateGranularity::Year => &[DateRole::Year],
        DateGranularity::Quarter => &[DateRole::Year, DateRole::Quarter],
        DateGranularity::Month => &[DateRole::Year, DateRole::Month],
    }
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::compute::expression::{self as expr};
    use crate::model::{Column, Table};
    use crate::types::DataType;

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
}
