//! Post-aggregation lookup-column resolution (JOIN back + re-GROUP-BY).

use std::time::Instant;

use arrow::record_batch::RecordBatch;
use datafusion::prelude::SessionContext;

use engine_core::compute::plan::{PlanNode, PlanOperation, PlanValue};
use engine_core::compute::sql_util::quote_ident_double;

use crate::error::QueryResult;
use crate::request::ColumnRef;

use super::fetch::register_partitioned_table;
use super::QueryExecutor;

impl QueryExecutor {
    /// Look up attribute columns by joining aggregated results back to dimension tables.
    ///
    /// The aggregation result only contains GROUP BY and measure columns.
    /// This method registers the result as a temporary table, then JOINs back
    /// to the dimension tables and applies resolution expressions to resolve
    /// lookup column values (which may be 1:many).
    pub(super) async fn apply_lookup_specs(
        ctx: &SessionContext,
        agg_batches: Vec<RecordBatch>,
        lookup_specs: &[crate::planner::LookupSpec],
        group_by: &[ColumnRef],
        plan: Option<&mut PlanNode>,
    ) -> QueryResult<Vec<RecordBatch>> {
        if agg_batches.is_empty() {
            return Ok(agg_batches);
        }

        // Register aggregation result.
        let schema = agg_batches[0].schema();
        register_partitioned_table(ctx, "__agg_result", agg_batches)?;

        // Collect unique (table, key_column) pairs for JOINs.
        let mut join_keys: Vec<(String, String)> = Vec::new();
        for spec in lookup_specs {
            let pair = (spec.table.to_lowercase(), spec.key_column.clone());
            if !join_keys.iter().any(|j| j.0 == pair.0 && j.1 == pair.1) {
                join_keys.push(pair);
            }
        }

        // Build SELECT clause: all columns from __agg_result, plus lookup resolution expressions.
        let mut select_parts: Vec<String> = Vec::new();

        // Add all existing columns from aggregation result.
        for field in schema.fields() {
            select_parts.push(format!("__agg_result.{}", quote_ident_double(field.name())));
        }

        // Add lookup columns with resolution expressions.
        for spec in lookup_specs {
            select_parts.push(format!(
                "{} AS {}",
                spec.resolution_sql,
                quote_ident_double(&spec.column)
            ));
        }

        let select_clause = select_parts.join(", ");
        let mut sql = format!("SELECT {select_clause} FROM __agg_result");

        // Add JOINs for each unique (table, key) pair.
        for (dim_lower, key_col) in &join_keys {
            let agg_key_col = group_by
                .iter()
                .find(|c| c.table.to_lowercase() == *dim_lower && c.column == *key_col)
                .map(|c| c.column.as_str())
                .unwrap_or(key_col);

            sql.push_str(&format!(
                " JOIN {dim_lower} ON __agg_result.{} = {dim_lower}.{}",
                quote_ident_double(agg_key_col),
                quote_ident_double(key_col)
            ));
        }

        // GROUP BY all __agg_result columns (since resolution expressions are aggregates).
        let group_parts: Vec<String> = schema
            .fields()
            .iter()
            .map(|f| format!("__agg_result.{}", quote_ident_double(f.name())))
            .collect();
        sql.push_str(&format!(" GROUP BY {}", group_parts.join(", ")));

        let lookup_start = Instant::now();
        let df = ctx.sql(&sql).await?;
        let batches = df.collect().await?;
        let lookup_elapsed = lookup_start.elapsed();

        if let Some(plan_node) = plan {
            let result_rows: usize = batches.iter().map(|b| b.num_rows()).sum();
            let lookup_names: Vec<String> = lookup_specs
                .iter()
                .map(|s| format!("{}.{}", s.table, s.column))
                .collect();
            plan_node.add_child(
                PlanNode::new(PlanOperation::DataFusionExecution, "Lookup Resolution")
                    .with_property("sql", PlanValue::Text(sql))
                    .with_property("lookups", PlanValue::List(lookup_names))
                    .with_property("result_rows", PlanValue::Number(result_rows as f64))
                    .with_duration(lookup_elapsed),
            );
        }

        Ok(batches)
    }
}
