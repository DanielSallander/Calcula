//! Window measure evaluation (WINDOW / OFFSET / INDEX) via two-stage
//! materialize-then-window-function execution.

use std::time::Instant;

use arrow::record_batch::RecordBatch;
use datafusion::prelude::SessionContext;

use engine_core::compute::context::ContextResolver;
use engine_core::compute::expression::Expression;
use engine_core::compute::measure::Measure;
use engine_core::compute::plan::{PlanNode, PlanOperation, PlanValue};
use engine_core::compute::sql_util::quote_ident_double;
use engine_core::compute::time_intelligence::lower_time_intelligence;
use engine_core::model::DataModel;

use crate::error::QueryResult;
use crate::request::ColumnRef;

use super::query_measures::materialize_query_in_pipeline;
use super::QueryExecutor;

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
        mut plan: Option<&mut PlanNode>,
    ) -> QueryResult<Vec<RecordBatch>> {
        let resolver = ContextResolver::new(model);
        let mut all_batches: Vec<RecordBatch> = Vec::new();

        for measure in window_measures {
            let name = measure.name();
            let expr = measure.expression();
            let fact_table = measure.table();

            // Resolve context operations on the inner expression.
            let (stripped_expr, _eval_ctx) = resolver.resolve(expr)?;

            // Lower time-intelligence sugar (YTD/QTD/MTD/PRIORYEAR/
            // PRIORPERIOD) onto the Window/Offset machinery, relative to the
            // query's group_by axis and the model's marked date table.
            // Missing prerequisites surface as typed EngineError::
            // TimeIntelligence — never silently wrong numbers.
            let group_pairs: Vec<(String, String)> = group_by
                .iter()
                .map(|dim| (dim.table.clone(), dim.column.clone()))
                .collect();
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

            // Stage 1: Materialize inner measure grouped by stage1_group_by.
            let base_table_name = format!("__window_{}", name.to_lowercase());
            let agg_pair = vec![(inner.clone(), "__val".to_string())];
            let s1_start = Instant::now();
            let batch = materialize_query_in_pipeline(
                ctx,
                &agg_pair,
                &stage1_group_by,
                &fact_table.to_lowercase(),
                &[],
                model,
            )
            .await?;
            let s1_elapsed = s1_start.elapsed();
            let s1_rows = batch.num_rows();
            ctx.register_batch(&base_table_name, batch)?;

            // Stage 2: Build and execute window function SQL.
            let mut select_parts: Vec<String> = Vec::new();

            // Include outer GROUP BY columns in SELECT.
            for dim in group_by {
                let col_lower = dim.column.to_lowercase();
                select_parts.push(quote_ident_double(&col_lower));
            }

            // Build the window function expression.
            let window_sql = build_window_sql(&window_info, &stage1_group_by, group_by, name);
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
) -> String {
    use engine_core::compute::aggregate::AggregateOp;

    // Build ORDER BY clause.
    let order_clause: Vec<String> = info
        .order_by
        .iter()
        .map(|(_, col)| quote_ident_double(&col.to_lowercase()))
        .collect();
    let order_sql = order_clause.join(", ");

    // Build PARTITION BY clause (includes outer group-by columns that aren't in ORDER BY).
    let mut partition_cols: Vec<String> = info
        .partition_by
        .iter()
        .map(|(_, col)| quote_ident_double(&col.to_lowercase()))
        .collect();
    // Add outer group-by columns to PARTITION BY if not already in ORDER BY or PARTITION BY.
    for dim in outer_group_by {
        let col_lower = dim.column.to_lowercase();
        let col_quoted = quote_ident_double(&col_lower);
        if !partition_cols.contains(&col_quoted) && !order_clause.contains(&col_quoted) {
            partition_cols.push(col_quoted);
        }
    }
    let partition_sql = if partition_cols.is_empty() {
        String::new()
    } else {
        format!("PARTITION BY {} ", partition_cols.join(", "))
    };

    if let Some(function) = info.function {
        // WINDOW: AGG("__val") OVER (PARTITION BY ... ORDER BY ... ROWS BETWEEN ...)
        let func_name_owned;
        let func_name = match function {
            AggregateOp::Sum => "SUM",
            AggregateOp::Average => "AVG",
            AggregateOp::Min => "MIN",
            AggregateOp::Max => "MAX",
            AggregateOp::Count => "COUNT",
            AggregateOp::DistinctCount => "COUNT",
            AggregateOp::CountRows => "COUNT",
            other => {
                func_name_owned = other.to_string();
                &func_name_owned
            }
        };

        let frame_sql = match &info.frame {
            Some(frame) => translate_frame(frame),
            None => "ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW".to_string(),
        };

        format!(
            "{func_name}(\"__val\") OVER ({partition_sql}ORDER BY {order_sql} {frame_sql}) AS {}",
            quote_ident_double(measure_name)
        )
    } else if let Some(delta) = info.delta {
        // OFFSET: LAG/LEAD("__val", N) OVER (...)
        if delta < 0 {
            format!(
                "LAG(\"__val\", {}) OVER ({partition_sql}ORDER BY {order_sql}) AS {}",
                delta.unsigned_abs(),
                quote_ident_double(measure_name)
            )
        } else {
            format!(
                "LEAD(\"__val\", {delta}) OVER ({partition_sql}ORDER BY {order_sql}) AS {}",
                quote_ident_double(measure_name)
            )
        }
    } else if let Some(position) = info.position {
        // INDEX: NTH_VALUE("__val", N) OVER (...) with full frame.
        if position >= 1 {
            format!(
                "NTH_VALUE(\"__val\", {position}) OVER ({partition_sql}ORDER BY {order_sql} ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING) AS {}",
                quote_ident_double(measure_name)
            )
        } else {
            // Negative position: from end. Use NTH_VALUE with reversed ordering.
            let reverse_order: Vec<String> = info
                .order_by
                .iter()
                .map(|(_, col)| format!("{} DESC", quote_ident_double(&col.to_lowercase())))
                .collect();
            let rev_order_sql = reverse_order.join(", ");
            let abs_pos = position.unsigned_abs();
            format!(
                "NTH_VALUE(\"__val\", {abs_pos}) OVER ({partition_sql}ORDER BY {rev_order_sql} ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING) AS {}",
                quote_ident_double(measure_name)
            )
        }
    } else {
        format!("\"__val\" AS {}", quote_ident_double(measure_name))
    }
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
