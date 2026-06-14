//! Window measure evaluation (WINDOW / OFFSET / INDEX) via two-stage
//! materialize-then-window-function execution.

use std::time::Instant;

use arrow::array::{Array, Date32Array, Int64Array, TimestampMicrosecondArray};
use arrow::datatypes::{DataType as ArrowDataType, TimeUnit};
use arrow::record_batch::RecordBatch;
use datafusion::prelude::SessionContext;

use engine_connectors::FilterCondition;
use engine_core::compute::context::ContextResolver;
use engine_core::compute::expression::{DateGranularity, Expression};
use engine_core::compute::measure::Measure;
use engine_core::compute::plan::{PlanNode, PlanOperation, PlanValue};
use engine_core::compute::sql_util::quote_ident_double;
use engine_core::compute::time_intelligence::{
    lower_time_intelligence, lower_time_intelligence_filtered, time_intelligence_route,
    FilterContextPlan, TimeIntelligenceRoute,
};
use engine_core::error::EngineError;
use engine_core::model::{DataModel, DateRole};

use crate::error::{QueryError, QueryResult};
use crate::request::ColumnRef;

use super::query_measures::materialize_query_in_pipeline;
use super::QueryExecutor;

/// Microseconds in one day, for converting a `Timestamp` date key to `Date32`.
const MICROS_PER_DAY: i64 = 86_400_000_000;

impl QueryExecutor {
    /// Evaluate window measures via two-stage execution.
    ///
    /// Stage 1: Materialize inner measure grouped by ORDER BY + PARTITION BY
    ///          columns (+ outer GROUP BY for context propagation).
    /// Stage 2: Apply SQL window function over the materialized result.
    pub(super) async fn execute_window_measures(
        ctx: &SessionContext,
        window_measures: &[&Measure],
        group_by: &[ColumnRef],
        model: &DataModel,
        date_filters: &[FilterCondition],
        mut plan: Option<&mut PlanNode>,
    ) -> QueryResult<Vec<RecordBatch>> {
        let resolver = ContextResolver::new(model);
        let mut all_batches: Vec<RecordBatch> = Vec::new();

        for measure in window_measures {
            let name = measure.name();
            let expr = measure.expression();
            let fact_table = measure.table();

            // Resolve context operations on the inner expression. The KEEP
            // filters on the date table refine the as-of date context for the
            // filter-context path; the axis path ignores them here (they ride
            // through the normal stage-1 materialization).
            let (stripped_expr, eval_ctx) = resolver.resolve(expr)?;

            let group_pairs: Vec<(String, String)> = group_by
                .iter()
                .map(|dim| (dim.table.clone(), dim.column.clone()))
                .collect();

            // Decide the time-intelligence evaluation route. The axis path
            // (v1) is used when the date table's anchor role columns are on the
            // query axis; otherwise we fall back to the filter-context path
            // (v2). Non-time-intelligence window measures route as `None` and
            // take the existing axis lowering (a no-op pass-through).
            let route = time_intelligence_route(&stripped_expr, model, &group_pairs)?;
            if let Some(TimeIntelligenceRoute::FilterContext(plan_info)) = route {
                let batches = Self::execute_filter_context_time_intelligence(
                    ctx,
                    name,
                    &stripped_expr,
                    fact_table,
                    group_by,
                    model,
                    &plan_info,
                    date_filters,
                    &eval_ctx,
                    plan.as_deref_mut(),
                )
                .await?;
                all_batches.extend(batches);
                continue;
            }

            // Axis path (or non-time-intelligence window measure): lower onto
            // the Window/Offset machinery relative to the query's group_by axis
            // and the model's marked date table. Missing prerequisites surface
            // as typed EngineError::TimeIntelligence — never wrong numbers.
            let (lowered_expr, time_intelligence) =
                lower_time_intelligence(&stripped_expr, model, &group_pairs)?;

            // Extract window parameters from the (potentially context-stripped,
            // time-intelligence-lowered) expression.
            let (inner, window_info) = extract_window_info(&lowered_expr)?;

            // Build the group-by columns for stage 1: ORDERBY + PARTITIONBY + outer GROUP BY.
            let mut stage1_group_by: Vec<(String, String)> = Vec::new();
            for (table, column) in &window_info.order_by {
                if !stage1_group_by
                    .iter()
                    .any(|(t, c)| t.eq_ignore_ascii_case(table) && c.eq_ignore_ascii_case(column))
                {
                    stage1_group_by.push((table.clone(), column.clone()));
                }
            }
            for (table, column) in &window_info.partition_by {
                if !stage1_group_by
                    .iter()
                    .any(|(t, c)| t.eq_ignore_ascii_case(table) && c.eq_ignore_ascii_case(column))
                {
                    stage1_group_by.push((table.clone(), column.clone()));
                }
            }
            // Inject outer GROUP BY for context propagation.
            for dim in group_by {
                if !stage1_group_by.iter().any(|(t, c)| {
                    t.eq_ignore_ascii_case(&dim.table) && c.eq_ignore_ascii_case(&dim.column)
                }) {
                    stage1_group_by.push((dim.table.clone(), dim.column.clone()));
                }
            }

            // Apply the measure's resolved KEEP filter context to the inner
            // aggregate's stage-1 materialization. Without this, a window
            // measure wrapped in a KEEP — e.g. `KEEP(YTD(SUM(amount)),
            // region='east')` — would silently drop the filter and accumulate
            // the running total over ALL rows (a wrong number). Simple KEEP
            // filters become the stage-1 WHERE, restricting the rows that feed
            // each per-period aggregate; context this path cannot faithfully
            // apply (boolean conditions, IN filters, CLEAR/RESET, relationship
            // overrides, table-variable traversals) fails closed.
            Self::reject_unapplyable_axis_window_context(name, &eval_ctx)?;
            let context_filters = eval_ctx.effective_filters(&[]);
            let context_filter_refs: Vec<&engine_core::compute::context::ResolvedFilter> =
                context_filters.iter().collect();

            // Stage 1: Materialize inner measure grouped by stage1_group_by.
            let base_table_name = format!("__window_{}", name.to_lowercase());
            let agg_pair = vec![(inner.clone(), "__val".to_string())];
            let s1_start = Instant::now();
            let batch = materialize_query_in_pipeline(
                ctx,
                &agg_pair,
                &stage1_group_by,
                &fact_table.to_lowercase(),
                &context_filter_refs,
                model,
            )
            .await?;
            let s1_elapsed = s1_start.elapsed();
            let s1_rows = batch.num_rows();
            ctx.register_batch(&base_table_name, batch)?;

            // Fail closed on a gapped axis for a positional period shift
            // (PRIORYEAR/PRIORPERIOD → LAG/LEAD). The shift is positional over
            // the periods *present* in the materialized result, so if a period
            // has no fact rows (and is therefore absent from the axis), the LAG
            // would silently read the nearest earlier present period instead of
            // the true prior period — a wrong number with no error. Detect the
            // gap and return a typed error instead. Running ToDate (YTD/QTD/MTD)
            // is unaffected: a missing period simply contributes nothing to the
            // accumulation, which is correct.
            if let Expression::PeriodShift { granularity, .. } = &stripped_expr {
                let partition_cols = window_partition_cols(&window_info, group_by);
                check_period_shift_axis_contiguous(
                    ctx,
                    &base_table_name,
                    &window_info.order_by,
                    &partition_cols,
                    *granularity,
                    name,
                )
                .await?;
            }

            // Stage 2: Build and execute window function SQL.
            let mut select_parts: Vec<String> = Vec::new();

            // Include outer GROUP BY columns in SELECT.
            for dim in group_by {
                let col_lower = dim.column.to_lowercase();
                select_parts.push(quote_ident_double(&col_lower));
            }

            // Build the window function expression.
            let window_sql = build_window_sql(&window_info, &stage1_group_by, group_by, name)?;
            select_parts.push(window_sql);

            let sql = format!("SELECT {} FROM {base_table_name}", select_parts.join(", "));

            let s2_start = Instant::now();
            let df = ctx.sql(&sql).await?;
            let batches = df.collect().await?;
            let s2_elapsed = s2_start.elapsed();
            let s2_rows: usize = batches.iter().map(|b| b.num_rows()).sum();
            all_batches.extend(batches);

            // Record plan nodes for this window measure.
            if let Some(ref mut plan_node) = plan {
                let mut window_node =
                    PlanNode::new(PlanOperation::MeasureEvaluation, format!("Window: {name}"));
                window_node.duration = (s1_elapsed + s2_elapsed).into();

                // Report how time-intelligence sugar was lowered.
                if let Some(description) = time_intelligence {
                    window_node.add_property("time_intelligence", PlanValue::Text(description));
                }

                window_node.add_child(
                    PlanNode::new(
                        PlanOperation::DataFusionExecution,
                        "Materialize Inner (Stage 1)",
                    )
                    .with_property("result_rows", PlanValue::Number(s1_rows as f64))
                    .with_duration(s1_elapsed),
                );
                window_node.add_child(
                    PlanNode::new(
                        PlanOperation::DataFusionExecution,
                        "Window Function (Stage 2)",
                    )
                    .with_property("sql", PlanValue::Text(sql))
                    .with_property("result_rows", PlanValue::Number(s2_rows as f64))
                    .with_duration(s2_elapsed),
                );
                plan_node.add_child(window_node);
            }
        }

        // If multiple window measures, we'd need to join results.
        // For now, return the batches from the last (or only) measure.
        Ok(all_batches)
    }

    /// Evaluate a filter-context time-intelligence measure (date columns NOT on
    /// the query axis): probe the as-of date from the current date context, then
    /// evaluate the inner aggregate over the concrete date range as a normal
    /// context-filtered grouped aggregation.
    ///
    /// Unlike the axis path, the lowered expression is a plain
    /// `Keep(Clear(inner, date cols), [DateKey range])` — a context-wrapped
    /// aggregate, not a window function — so it is materialized through the
    /// ordinary grouped-aggregation path (grouped by the non-date dimensions).
    #[allow(clippy::too_many_arguments)]
    async fn execute_filter_context_time_intelligence(
        ctx: &SessionContext,
        name: &str,
        stripped_expr: &Expression,
        fact_table: &str,
        group_by: &[ColumnRef],
        model: &DataModel,
        plan_info: &FilterContextPlan,
        date_filters: &[FilterCondition],
        eval_ctx: &engine_core::compute::context::EvaluationContext,
        plan: Option<&mut PlanNode>,
    ) -> QueryResult<Vec<RecordBatch>> {
        let probe_start = Instant::now();

        // FAIL CLOSED (Fix A): the filter-context path faithfully applies only
        // the date filter context (the probe WHERE picks up the request's and
        // the measure's date-table filters; the lowered range replaces them).
        // It does NOT re-apply non-date context, so a TI measure wrapped in any
        // context op (KEEP on another table, an inner KEEP, USING/CLEAR/RESET/
        // UseRelationship) would silently drop that context and return a wrong
        // number (e.g. `KEEP(YTD(SUM(amount)), region='east')` would compute
        // YTD over ALL regions). Refuse rather than mislead. (The axis path —
        // date on group_by — handles this differently: it applies simple KEEP
        // filters to the stage-1 aggregate and fails closed on the rest; see
        // `reject_unapplyable_axis_window_context`.)
        Self::reject_unsupported_filter_context_ops(&plan_info.function, eval_ctx, model)?;

        // FAIL CLOSED (Fix: fiscal calendars): the filter-context path computes
        // the window boundary (e.g. start-of-year for YTD) from the Gregorian
        // calendar of the DateKey, whereas the axis path resets on the model's
        // Year/Quarter/Month *role columns*. For a standard calendar these agree;
        // for a NON-Gregorian calendar (a host that puts fiscal period numbers in
        // the role columns), they would disagree — the same YTD measure would
        // return a fiscal window on the axis and a calendar window in a slicer.
        // Refuse rather than return a silently-different number. (A fiscal-aware
        // filter-context window is a planned enhancement.)
        Self::reject_non_gregorian_calendar(ctx, plan_info, model).await?;

        // The as-of date = MAX(date key) under the current date context (the
        // request's date-table filters plus the measure's KEEP filters on the
        // date table). PeriodShift additionally needs the MIN to shift the whole
        // window. The registered date table is already pre-filtered by the
        // request filters; re-applying them in the probe WHERE is idempotent.
        let where_sql = Self::date_context_where_sql(plan_info, date_filters, eval_ctx, model);
        let want_min = plan_info.needs_min_context_date;
        let probe = Self::probe_as_of_date(ctx, plan_info, &where_sql, want_min).await?;
        let probe_elapsed = probe_start.elapsed();

        // No date rows in context (empty table or null max) → blank result.
        let Some((as_of_days, min_days)) = probe else {
            return Ok(Vec::new());
        };

        // Lower to Keep(Clear(inner, date cols), [DateKey >= start, < end]).
        let (lowered_expr, description) =
            lower_time_intelligence_filtered(stripped_expr, model, as_of_days, min_days)?;

        // Evaluate the context-wrapped aggregate grouped by the non-date
        // dimensions (the date columns are not on the axis here). The KEEP
        // range filter becomes a CASE WHEN context filter joined to the fact.
        let outer_group_by: Vec<(String, String)> = group_by
            .iter()
            .map(|dim| (dim.table.clone(), dim.column.clone()))
            .collect();
        let agg_pair = vec![(lowered_expr, name.to_string())];

        let exec_start = Instant::now();
        let batch = materialize_query_in_pipeline(
            ctx,
            &agg_pair,
            &outer_group_by,
            &fact_table.to_lowercase(),
            &[],
            model,
        )
        .await?;
        let exec_elapsed = exec_start.elapsed();
        let result_rows = batch.num_rows();

        if let Some(plan_node) = plan {
            let mut node = PlanNode::new(
                PlanOperation::MeasureEvaluation,
                format!("Filter-context time intelligence: {name}"),
            );
            node.duration = (probe_elapsed + exec_elapsed).into();
            node.add_property("time_intelligence", PlanValue::Text(description));
            node.add_property("result_rows", PlanValue::Number(result_rows as f64));
            plan_node.add_child(node);
        }

        Ok(vec![batch])
    }

    /// Fail closed (Fix A) when a filter-context TI measure's resolved
    /// evaluation context carries anything the filter-context path cannot
    /// faithfully apply to the final aggregation.
    ///
    /// The filter-context path only honours the *date* filter context (probe +
    /// computed range on the date table). Everything else in `eval_ctx` is
    /// dropped by this path, so allowing it through would silently produce a
    /// wrong number. We therefore refuse when the context carries:
    /// - any KEEP filter / boolean condition / IN filter on a table OTHER than
    ///   the date table (a date-table KEEP filter is honoured by the probe), or
    /// - any clear / reset (in any of the both/inner/outer variants), CLEAREXCEPT,
    ///   relationship override (USERELATIONSHIP), table-variable traversal, or
    ///   IN filter — composition with these is not implemented here.
    ///
    /// Returns [`EngineError::TimeIntelligence`] with an actionable message. The
    /// axis path (date on group_by) is unaffected: it never reaches here.
    fn reject_unsupported_filter_context_ops(
        function: &str,
        eval_ctx: &engine_core::compute::context::EvaluationContext,
        model: &DataModel,
    ) -> QueryResult<()> {
        let date_table = model.date_table();
        let is_date_table =
            |table: &str| date_table.is_some_and(|dt| dt.eq_ignore_ascii_case(table));

        // KEEP filters / conditions / IN filters that target a non-date table.
        let non_date_filter = eval_ctx.filters.iter().any(|f| !is_date_table(&f.table));
        let non_date_in_filter = eval_ctx.in_filters.iter().any(|f| !is_date_table(&f.table));
        // Any boolean condition is rejected: it may reference any table and the
        // filter-context aggregation does not apply it.
        let has_conditions = !eval_ctx.conditions.is_empty();

        // Any clear/reset/relationship-override/traversal of any kind.
        let has_clear_or_reset = eval_ctx.is_reset
            || eval_ctx.is_reset_inner
            || eval_ctx.is_reset_outer
            || !eval_ctx.cleared_columns.is_empty()
            || !eval_ctx.cleared_tables.is_empty()
            || !eval_ctx.cleared_inner_columns.is_empty()
            || !eval_ctx.cleared_inner_tables.is_empty()
            || !eval_ctx.cleared_outer_columns.is_empty()
            || !eval_ctx.cleared_outer_tables.is_empty()
            || !eval_ctx.clear_except.is_empty();
        let has_overrides = !eval_ctx.relationship_overrides.is_empty();
        let has_traversals = !eval_ctx.traversals.is_empty();

        if non_date_filter
            || non_date_in_filter
            || has_conditions
            || has_clear_or_reset
            || has_overrides
            || has_traversals
        {
            return Err(QueryError::Engine(EngineError::TimeIntelligence {
                function: function.to_string(),
                reason: "filter-context time intelligence (date not on the query axis) does not \
                         compose with KEEP/USING/CLEAR/RESET context operations; scope the date \
                         via query filters, or put a date column on the group-by axis"
                    .to_string(),
            }));
        }
        Ok(())
    }

    /// Fail closed when an axis-path window measure's resolved context carries
    /// anything the stage-1 materialization cannot faithfully apply.
    ///
    /// The axis (window) path applies the measure's KEEP **filters** to the
    /// stage-1 aggregate as a WHERE clause (via `materialize_query_in_pipeline`'s
    /// `source_filters`), which correctly restricts the rows that feed each
    /// per-period value. It cannot, however, represent boolean conditions, IN
    /// filters, CLEAR/RESET, relationship overrides (USERELATIONSHIP), or
    /// table-variable traversals here — applying only the simple filters and
    /// dropping these would silently return a wrong number. Refuse instead.
    /// (Simple filters — `column op value`, on the fact or any single-hop
    /// dimension — are honoured and do not reach this guard.)
    fn reject_unapplyable_axis_window_context(
        measure_name: &str,
        eval_ctx: &engine_core::compute::context::EvaluationContext,
    ) -> QueryResult<()> {
        let has_conditions = !eval_ctx.conditions.is_empty();
        let has_in_filters = !eval_ctx.in_filters.is_empty();
        let has_clear_or_reset = eval_ctx.is_reset
            || eval_ctx.is_reset_inner
            || eval_ctx.is_reset_outer
            || !eval_ctx.cleared_columns.is_empty()
            || !eval_ctx.cleared_tables.is_empty()
            || !eval_ctx.cleared_inner_columns.is_empty()
            || !eval_ctx.cleared_inner_tables.is_empty()
            || !eval_ctx.cleared_outer_columns.is_empty()
            || !eval_ctx.cleared_outer_tables.is_empty()
            || !eval_ctx.clear_except.is_empty();
        let has_overrides = !eval_ctx.relationship_overrides.is_empty();
        let has_traversals = !eval_ctx.traversals.is_empty();

        if has_conditions || has_in_filters || has_clear_or_reset || has_overrides || has_traversals
        {
            return Err(QueryError::InvalidQuery(format!(
                "window / running / time-intelligence measure '{measure_name}' is wrapped in \
                 context operations that the window path cannot apply (boolean conditions, IN \
                 filters, CLEAR/RESET, USERELATIONSHIP, or table-variable traversal). Only \
                 simple KEEP filters (column op value) compose with a window measure; remove \
                 the others, or compute the measure without the window"
            )));
        }
        Ok(())
    }

    /// Fail closed when the marked date table is not a standard Gregorian
    /// calendar, because the filter-context window math is calendar-based.
    ///
    /// The filter-context path derives the window bounds (start-of-year for YTD,
    /// the prior-year shift, etc.) from the Gregorian calendar of the `DateKey`
    /// via `start_of_period`. The axis path instead resets/partitions on the
    /// model's `Year`/`Quarter`/`Month` *role columns*. These agree only when
    /// those columns hold the Gregorian calendar parts of the DateKey. If a host
    /// models a fiscal (non-January) year by populating the role columns with
    /// fiscal period numbers, the two paths would return *different* windows for
    /// the same measure (fiscal on the axis, calendar in a slicer) — a silent
    /// inconsistency. This check verifies each present role column equals the
    /// calendar part extracted from the DateKey, and refuses otherwise.
    async fn reject_non_gregorian_calendar(
        ctx: &SessionContext,
        plan_info: &FilterContextPlan,
        model: &DataModel,
    ) -> QueryResult<()> {
        let Ok(date_table) = model.table(&plan_info.date_table) else {
            return Ok(());
        };
        let dk = quote_ident_double(&plan_info.date_key_column.to_lowercase());

        // For each present numeric period role column, the calendar part it
        // must equal (NULL DateKey rows compare to NULL and are ignored).
        let mut divergence: Vec<String> = Vec::new();
        for column in date_table.columns() {
            let part = match column.date_role() {
                Some(DateRole::Year) => "year",
                Some(DateRole::Quarter) => "quarter",
                Some(DateRole::Month) => "month",
                _ => continue,
            };
            let col = quote_ident_double(&column.name().to_lowercase());
            divergence.push(format!(
                "CAST({col} AS BIGINT) <> CAST(date_part('{part}', {dk}) AS BIGINT)"
            ));
        }
        if divergence.is_empty() {
            return Ok(());
        }

        let table = quote_ident_double(&plan_info.date_table.to_lowercase());
        let sql = format!(
            "SELECT COUNT(*) FROM {table} WHERE {}",
            divergence.join(" OR ")
        );

        let fiscal_error = |detail: String| -> QueryError {
            EngineError::TimeIntelligence {
                function: plan_info.function.clone(),
                reason: format!(
                    "the date table '{}' is not a standard Gregorian calendar ({detail}), and \
                     filter-context time intelligence (date not on the query axis) only supports \
                     a Gregorian calendar; put a date column on the group-by axis (the axis path \
                     honours the role columns), or use a calendar date table",
                    plan_info.date_table
                ),
            }
            .into()
        };

        let df = ctx.sql(&sql).await.map_err(|e| {
            fiscal_error(format!(
                "its Year/Quarter/Month role columns could not be compared to the date key: {e}"
            ))
        })?;
        let batches = df.collect().await?;
        let diverging = batches
            .first()
            .and_then(|b| b.column(0).as_any().downcast_ref::<Int64Array>())
            .map(|a| if a.is_empty() { 0 } else { a.value(0) })
            .unwrap_or(0);
        if diverging > 0 {
            return Err(fiscal_error(
                "its Year/Quarter/Month role columns do not match the calendar parts of the \
                 date key"
                    .to_string(),
            ));
        }
        Ok(())
    }

    /// Build the WHERE clause (without the `WHERE` keyword) selecting the
    /// current date context on the date table: the request's date-table filters
    /// plus the measure's resolved KEEP filters on the date table. Empty when no
    /// date filter applies (probe runs over the whole date table).
    fn date_context_where_sql(
        plan_info: &FilterContextPlan,
        date_filters: &[FilterCondition],
        eval_ctx: &engine_core::compute::context::EvaluationContext,
        model: &DataModel,
    ) -> String {
        let mut parts: Vec<String> = Vec::new();

        // Request filters were pushed onto the date table's fetch as
        // column/op/value (the table is implicitly the date table).
        for f in date_filters {
            let val = engine_core::compute::context::format_filter_value(
                &plan_info.date_table,
                &f.column,
                &f.value,
                model,
            );
            parts.push(format!(
                "{} {} {val}",
                quote_ident_double(&f.column.to_lowercase()),
                f.operator.as_sql()
            ));
        }

        // The measure's KEEP filters that target the date table.
        for f in eval_ctx
            .filters
            .iter()
            .filter(|f| f.table.eq_ignore_ascii_case(&plan_info.date_table))
        {
            let val = engine_core::compute::context::format_filter_value(
                &f.table, &f.column, &f.value, model,
            );
            parts.push(format!(
                "{} {} {val}",
                quote_ident_double(&f.column.to_lowercase()),
                f.operator.as_sql()
            ));
        }

        parts.join(" AND ")
    }

    /// Probe `MAX(date_key)` (and `MIN(date_key)` when `want_min`) of the date
    /// table under `where_sql`, returning the dates as `Date32` day counts since
    /// the Unix epoch. Returns `Ok(None)` when the max is NULL (no rows / all
    /// null) so the caller yields a blank result.
    async fn probe_as_of_date(
        ctx: &SessionContext,
        plan_info: &FilterContextPlan,
        where_sql: &str,
        want_min: bool,
    ) -> QueryResult<Option<(i32, i32)>> {
        let key_col = quote_ident_double(&plan_info.date_key_column.to_lowercase());
        let table = plan_info.date_table.to_lowercase();
        let select = if want_min {
            format!("MAX({key_col}) AS __max, MIN({key_col}) AS __min")
        } else {
            format!("MAX({key_col}) AS __max")
        };
        let mut sql = format!("SELECT {select} FROM {}", quote_ident_double(&table));
        if !where_sql.is_empty() {
            sql.push_str(" WHERE ");
            sql.push_str(where_sql);
        }

        let df = ctx.sql(&sql).await?;
        let batches = df.collect().await?;
        let combined = match batches.first() {
            Some(b) if b.num_rows() > 0 => b,
            _ => return Ok(None),
        };

        let max_days = match read_date_as_days(combined, "__max")? {
            Some(d) => d,
            None => return Ok(None),
        };
        let min_days = if want_min {
            // A non-null MAX guarantees at least one row, so MIN is non-null too.
            read_date_as_days(combined, "__min")?.unwrap_or(max_days)
        } else {
            max_days
        };
        Ok(Some((max_days, min_days)))
    }
}

/// Read a single-row `Date32`/`Timestamp(Microsecond)` aggregate column as a
/// `Date32` day count since the Unix epoch. `Ok(None)` when the value is null.
fn read_date_as_days(batch: &RecordBatch, column: &str) -> QueryResult<Option<i32>> {
    let idx = batch.schema().index_of(column).map_err(|e| {
        QueryError::InvalidQuery(format!("date probe is missing column '{column}': {e}"))
    })?;
    let array = batch.column(idx);
    if array.is_null(0) {
        return Ok(None);
    }
    match array.data_type() {
        ArrowDataType::Date32 => {
            let arr = array
                .as_any()
                .downcast_ref::<Date32Array>()
                .ok_or_else(|| QueryError::InvalidQuery("date probe: bad Date32 array".into()))?;
            Ok(Some(arr.value(0)))
        }
        ArrowDataType::Timestamp(TimeUnit::Microsecond, _) => {
            let arr = array
                .as_any()
                .downcast_ref::<TimestampMicrosecondArray>()
                .ok_or_else(|| {
                    QueryError::InvalidQuery("date probe: bad Timestamp array".into())
                })?;
            // Floor to the day (Date32 = days since epoch). Negative micros
            // (pre-1970) use floor division so partial days round toward -inf.
            let micros = arr.value(0);
            let days = micros.div_euclid(MICROS_PER_DAY);
            i32::try_from(days).map(Some).map_err(|_| {
                QueryError::InvalidQuery("date probe: timestamp out of Date32 range".into())
            })
        }
        other => Err(QueryError::InvalidQuery(format!(
            "date probe: the DateKey column resolved to {other:?}, expected Date32 or \
             Timestamp(Microsecond); ensure the DateKey column is Date or Timestamp typed"
        ))),
    }
}

/// Extracted window function parameters.
struct WindowInfo {
    /// Window aggregate function (for WINDOW) or None (for OFFSET/INDEX).
    function: Option<engine_core::compute::aggregate::AggregateOp>,
    /// ORDER BY columns.
    order_by: Vec<(String, String)>,
    /// PARTITION BY columns.
    partition_by: Vec<(String, String)>,
    /// Window frame (for WINDOW).
    frame: Option<engine_core::compute::expression::WindowFrame>,
    /// OFFSET delta (for OFFSET).
    delta: Option<i64>,
    /// INDEX position (for INDEX).
    position: Option<i64>,
}

/// Extract window parameters from an expression, returning (inner_measure, window_info).
fn extract_window_info(expr: &Expression) -> QueryResult<(Expression, WindowInfo)> {
    match expr {
        Expression::Window {
            inner,
            function,
            order_by,
            partition_by,
            frame,
        } => Ok((
            *inner.clone(),
            WindowInfo {
                function: Some(*function),
                order_by: order_by.clone(),
                partition_by: partition_by.clone(),
                frame: frame.clone(),
                delta: None,
                position: None,
            },
        )),
        Expression::Offset {
            inner,
            delta,
            order_by,
            partition_by,
        } => Ok((
            *inner.clone(),
            WindowInfo {
                function: None,
                order_by: order_by.clone(),
                partition_by: partition_by.clone(),
                frame: None,
                delta: Some(*delta),
                position: None,
            },
        )),
        Expression::Index {
            inner,
            position,
            order_by,
            partition_by,
        } => Ok((
            *inner.clone(),
            WindowInfo {
                function: None,
                order_by: order_by.clone(),
                partition_by: partition_by.clone(),
                frame: None,
                delta: None,
                position: Some(*position),
            },
        )),
        _ => Err(crate::error::QueryError::InvalidQuery(
            "expected Window, Offset, or Index expression".into(),
        )),
    }
}

/// Build the SQL window function expression for stage 2.
fn build_window_sql(
    info: &WindowInfo,
    _stage1_group_by: &[(String, String)],
    outer_group_by: &[ColumnRef],
    measure_name: &str,
) -> QueryResult<String> {
    use engine_core::compute::aggregate::AggregateOp;

    // Build ORDER BY clause.
    let order_clause: Vec<String> = info
        .order_by
        .iter()
        .map(|(_, col)| quote_ident_double(&col.to_lowercase()))
        .collect();
    let order_sql = order_clause.join(", ");

    // Build PARTITION BY clause (includes outer group-by columns that aren't in ORDER BY).
    let partition_cols = window_partition_cols(info, outer_group_by);
    let partition_sql = if partition_cols.is_empty() {
        String::new()
    } else {
        format!("PARTITION BY {} ", partition_cols.join(", "))
    };

    if let Some(function) = info.function {
        // WINDOW: AGG("__val") OVER (PARTITION BY ... ORDER BY ... ROWS BETWEEN ...)
        //
        // Only the aggregates the parser allows as window functions are
        // supported (SUM/AVG/MIN/MAX/COUNT). Anything else is rejected rather
        // than rendered: a running DISTINCTCOUNT would silently drop the
        // DISTINCT (rendering a plain COUNT — wrong numbers), and the
        // statistical aggregates have no valid window form in DataFusion. This
        // fail-closed guard matters because a measure's `Expression` AST can be
        // deserialized straight from a (shared) model file, bypassing the
        // parser's allow-list.
        let func_name = match function {
            AggregateOp::Sum => "SUM",
            AggregateOp::Average => "AVG",
            AggregateOp::Min => "MIN",
            AggregateOp::Max => "MAX",
            AggregateOp::Count => "COUNT",
            other => {
                return Err(QueryError::InvalidQuery(format!(
                    "aggregate {other:?} is not supported as a window/running calculation; \
                     only SUM, AVERAGE, MIN, MAX, and COUNT can be windowed \
                     (a running DISTINCTCOUNT or statistical aggregate must be computed \
                     as a separate measure)"
                )));
            }
        };

        let frame_sql = match &info.frame {
            Some(frame) => translate_frame(frame),
            None => "ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW".to_string(),
        };

        Ok(format!(
            "{func_name}(\"__val\") OVER ({partition_sql}ORDER BY {order_sql} {frame_sql}) AS {}",
            quote_ident_double(measure_name)
        ))
    } else if let Some(delta) = info.delta {
        // OFFSET: LAG/LEAD("__val", N) OVER (...)
        if delta < 0 {
            Ok(format!(
                "LAG(\"__val\", {}) OVER ({partition_sql}ORDER BY {order_sql}) AS {}",
                delta.unsigned_abs(),
                quote_ident_double(measure_name)
            ))
        } else {
            Ok(format!(
                "LEAD(\"__val\", {delta}) OVER ({partition_sql}ORDER BY {order_sql}) AS {}",
                quote_ident_double(measure_name)
            ))
        }
    } else if let Some(position) = info.position {
        // INDEX: NTH_VALUE("__val", N) OVER (...) with full frame.
        if position >= 1 {
            Ok(format!(
                "NTH_VALUE(\"__val\", {position}) OVER ({partition_sql}ORDER BY {order_sql} ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING) AS {}",
                quote_ident_double(measure_name)
            ))
        } else {
            // Negative position: from end. Use NTH_VALUE with reversed ordering.
            let reverse_order: Vec<String> = info
                .order_by
                .iter()
                .map(|(_, col)| format!("{} DESC", quote_ident_double(&col.to_lowercase())))
                .collect();
            let rev_order_sql = reverse_order.join(", ");
            let abs_pos = position.unsigned_abs();
            Ok(format!(
                "NTH_VALUE(\"__val\", {abs_pos}) OVER ({partition_sql}ORDER BY {rev_order_sql} ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING) AS {}",
                quote_ident_double(measure_name)
            ))
        }
    } else {
        Ok(format!("\"__val\" AS {}", quote_ident_double(measure_name)))
    }
}

/// The PARTITION BY columns (lowercased, quoted) for a window's stage-2 SQL:
/// the explicit `partition_by` plus every outer group-by column that is not
/// already an ORDER BY or PARTITION BY column. Shared by `build_window_sql`
/// (to render the window) and the period-shift contiguity guard (to check
/// contiguity within each partition).
fn window_partition_cols(info: &WindowInfo, outer_group_by: &[ColumnRef]) -> Vec<String> {
    let order_clause: Vec<String> = info
        .order_by
        .iter()
        .map(|(_, col)| quote_ident_double(&col.to_lowercase()))
        .collect();
    let mut partition_cols: Vec<String> = info
        .partition_by
        .iter()
        .map(|(_, col)| quote_ident_double(&col.to_lowercase()))
        .collect();
    for dim in outer_group_by {
        let col_quoted = quote_ident_double(&dim.column.to_lowercase());
        if !partition_cols.contains(&col_quoted) && !order_clause.contains(&col_quoted) {
            partition_cols.push(col_quoted);
        }
    }
    partition_cols
}

/// Fail closed when a positional period shift (`PRIORYEAR`/`PRIORPERIOD`, lowered
/// to `LAG`/`LEAD`) would run over a **gapped** date axis.
///
/// The shift is positional over the periods actually present in the
/// materialized stage-1 result. A correct value-based shift requires the axis
/// to be contiguous at the shift granularity (no missing period within each
/// PARTITION); otherwise the `LAG` reads the nearest earlier present period
/// rather than the true prior period, returning a wrong number for the wrong
/// period with no error. Rather than silently mislead, this verifies contiguity
/// and returns [`EngineError::TimeIntelligence`] on a gap. (A fully value-based
/// shift that tolerates gaps by returning NULL for an absent prior period is a
/// planned enhancement; until then the engine fails closed.)
///
/// Contiguity is checked per PARTITION by comparing the span of the period
/// ordinal (`MAX - MIN + 1`) against the distinct count: they are equal exactly
/// when no period is missing. The ordinal is the Year value (year shift),
/// `year*4 + quarter` (quarter shift), or `year*12 + month` (month shift) — the
/// lowering guarantees these anchor shapes and that the anchor columns carry the
/// extracted numeric period parts.
async fn check_period_shift_axis_contiguous(
    ctx: &SessionContext,
    base_table: &str,
    order_by: &[(String, String)],
    partition_cols: &[String],
    granularity: DateGranularity,
    function_label: &str,
) -> QueryResult<()> {
    let ord_cols: Vec<String> = order_by
        .iter()
        .map(|(_, col)| quote_ident_double(&col.to_lowercase()))
        .collect();
    let ordinal = match (granularity, ord_cols.as_slice()) {
        (DateGranularity::Year, [year]) => format!("CAST({year} AS BIGINT)"),
        (DateGranularity::Quarter, [year, quarter]) => {
            format!("(CAST({year} AS BIGINT) * 4 + CAST({quarter} AS BIGINT))")
        }
        (DateGranularity::Month, [year, month]) => {
            format!("(CAST({year} AS BIGINT) * 12 + CAST({month} AS BIGINT))")
        }
        // The lowering only ever produces these anchor shapes; anything else
        // (an unexpected shape) is left to the existing positional behavior.
        _ => return Ok(()),
    };

    let part_select = if partition_cols.is_empty() {
        String::new()
    } else {
        format!(", {}", partition_cols.join(", "))
    };
    let group_clause = if partition_cols.is_empty() {
        String::new()
    } else {
        format!(" GROUP BY {}", partition_cols.join(", "))
    };
    // Count partitions whose period axis has a gap (span != distinct count).
    let sql = format!(
        "SELECT COUNT(*) FROM (\
            SELECT (MAX(__ord) - MIN(__ord) + 1) AS span, COUNT(DISTINCT __ord) AS cnt \
            FROM (SELECT {ordinal} AS __ord{part_select} FROM {base_table}) t{group_clause}\
         ) g WHERE g.span <> g.cnt"
    );

    let gap_error = |reason: String| -> QueryError {
        EngineError::TimeIntelligence {
            function: function_label.to_string(),
            reason,
        }
        .into()
    };

    let df = ctx.sql(&sql).await.map_err(|e| {
        gap_error(format!(
            "could not verify the date axis is contiguous for a period shift \
             (the {granularity:?} anchor columns must hold numeric period parts): {e}"
        ))
    })?;
    let batches = df.collect().await?;
    let gapped_partitions = batches
        .first()
        .and_then(|b| b.column(0).as_any().downcast_ref::<Int64Array>())
        .map(|a| if a.is_empty() { 0 } else { a.value(0) })
        .unwrap_or(0);

    if gapped_partitions > 0 {
        return Err(gap_error(format!(
            "the date axis has gaps (one or more {granularity:?} periods are absent from the \
             result rows), so a positional period shift would read the wrong period instead of \
             the true prior period. Provide a contiguous date axis — e.g. group by a date \
             dimension that has a row for every period so empty periods still appear — or remove \
             the period shift"
        )));
    }
    Ok(())
}

/// Translate a DAX-style WindowFrame to SQL ROWS BETWEEN clause.
fn translate_frame(frame: &engine_core::compute::expression::WindowFrame) -> String {
    use engine_core::compute::expression::BoundaryType;

    let from_sql = match (frame.from, frame.from_type) {
        (1, BoundaryType::Abs) | (0, BoundaryType::Abs) => "UNBOUNDED PRECEDING".to_string(),
        (0, BoundaryType::Rel) => "CURRENT ROW".to_string(),
        (n, BoundaryType::Rel) if n < 0 => format!("{} PRECEDING", n.unsigned_abs()),
        (n, BoundaryType::Rel) => format!("{n} FOLLOWING"),
        (n, BoundaryType::Abs) if n > 0 => {
            // Absolute position from start — approximate as UNBOUNDED PRECEDING
            // (DataFusion doesn't support absolute row positioning directly).
            "UNBOUNDED PRECEDING".to_string()
        }
        (n, BoundaryType::Abs) if n < 0 => {
            // Absolute from end — approximate as UNBOUNDED FOLLOWING.
            "UNBOUNDED PRECEDING".to_string()
        }
        _ => "CURRENT ROW".to_string(),
    };

    let to_sql = match (frame.to, frame.to_type) {
        (-1, BoundaryType::Abs) | (0, BoundaryType::Abs) => "UNBOUNDED FOLLOWING".to_string(),
        (0, BoundaryType::Rel) => "CURRENT ROW".to_string(),
        (n, BoundaryType::Rel) if n < 0 => format!("{} PRECEDING", n.unsigned_abs()),
        (n, BoundaryType::Rel) => format!("{n} FOLLOWING"),
        (n, BoundaryType::Abs) if n < 0 => "UNBOUNDED FOLLOWING".to_string(),
        (n, BoundaryType::Abs) if n > 0 => "UNBOUNDED FOLLOWING".to_string(),
        _ => "CURRENT ROW".to_string(),
    };

    format!("ROWS BETWEEN {from_sql} AND {to_sql}")
}
