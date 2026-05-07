//! Instrumented query execution with execution plan metadata.
//!
//! Provides [`QueryExecutor::execute_explained`], which wraps the standard
//! execution logic and produces a [`PlanNode`] tree describing what happened
//! during execution with timing at each phase.

use std::time::Instant;

use arrow::record_batch::RecordBatch;

use engine_core::compute::plan::{PlanNode, PlanOperation, PlanValue};
use engine_core::model::DataModel;
use engine_core::store::InMemoryCache;

use crate::error::QueryResult;
use crate::planner::QueryPlan;
use crate::registry::SourceRegistry;

impl super::QueryExecutor {
    /// Execute a query plan and produce an execution plan node.
    ///
    /// Returns the query results alongside a [`PlanNode`] tree describing
    /// each execution phase with timing and metadata.
    pub async fn execute_explained(
        plan: &QueryPlan,
        model: &DataModel,
        registry: &SourceRegistry,
        cache: Option<&InMemoryCache>,
        max_inline_in_values: Option<usize>,
    ) -> QueryResult<(Vec<RecordBatch>, PlanNode)> {
        match plan {
            QueryPlan::PushedAggregation {
                source_table,
                request,
            } => {
                let start = Instant::now();
                let connector = registry.connector_for(source_table)?;
                let batches = connector.fetch_data(request).await?;
                let elapsed = start.elapsed();

                let row_count: usize = batches.iter().map(|b| b.num_rows()).sum();

                let mut node = PlanNode::new(
                    PlanOperation::PushedAggregation,
                    format!("Pushed Aggregation: {source_table}"),
                )
                .with_duration(elapsed);

                node.add_property("table", PlanValue::Text(source_table.clone()));
                node.add_property("rows_returned", PlanValue::Number(row_count as f64));
                node.add_property(
                    "aggregates_count",
                    PlanValue::Number(request.aggregates.len() as f64),
                );

                if let Some(schema) = &request.schema {
                    node.add_property("source_schema", PlanValue::Text(schema.clone()));
                }
                node.add_property("source_table", PlanValue::Text(request.table.clone()));

                Ok((batches, node))
            }
            QueryPlan::PushedJoinAggregation {
                source_table,
                request,
            } => {
                let start = Instant::now();
                let connector = registry.connector_for(source_table)?;
                let batches = connector.execute_join_aggregation(request).await?;
                let elapsed = start.elapsed();

                let row_count: usize = batches.iter().map(|b| b.num_rows()).sum();

                let mut node =
                    PlanNode::new(PlanOperation::PushedAggregation, "Pushed Join Aggregation")
                        .with_duration(elapsed);

                node.add_property("rows_returned", PlanValue::Number(row_count as f64));
                node.add_property("source", PlanValue::Text(source_table.clone()));

                Ok((batches, node))
            }
            QueryPlan::LocalAggregation {
                fetches,
                measures,
                group_by,
                lookup_specs,
            } => {
                let start = Instant::now();

                let mut node = PlanNode::new(PlanOperation::LocalAggregation, "Local Aggregation");

                let batches = Self::execute_local_aggregation(
                    fetches,
                    measures,
                    group_by,
                    lookup_specs,
                    model,
                    registry,
                    cache,
                    max_inline_in_values,
                    Some(&mut node),
                )
                .await?;

                node.duration = start.elapsed().into();

                Ok((batches, node))
            }
        }
    }
}
