//! Materialization of calculated tables.
//!
//! A model calculated table (engine struct: `GlobalVariable`) with
//! `dynamic == false` is backed by a real, derived model [`Table`] (marked
//! `is_calculated`, synthesized at model build/mutation time from the QUERY's
//! inferred output schema). This module produces its DATA: the QUERY is
//! evaluated over the **unfiltered** model — no slicers, no group axis beyond
//! the QUERY's own BY columns, and **no RLS role** (there is no user at
//! refresh time; role filters may instead target the derived table like any
//! table) — and the result is stored as the table's in-memory batch.
//!
//! Execution reuses the ordinary query machinery end to end: each QUERY
//! aggregate becomes an ephemeral overlay measure (same overlay mechanism as
//! calculation groups), the BY columns become the group-by axis, and
//! `plan_and_execute` runs the normal plan → fetch → evaluate pipeline
//! (joins, relationship navigation, pushdown included). The result batches
//! are then conformed to the derived table's declared schema — columns
//! renamed to the QUERY aliases and cast to the inferred types — and stored
//! through the same optimize/sort/cache path as a connector refresh.

use std::sync::Arc;

use arrow::record_batch::RecordBatch;
use engine_core::model::global_variable::GlobalVariable;
use tokio_util::sync::CancellationToken;

use crate::{
    ColumnRef, Engine, EngineError, EngineResult, Expression, Measure, OptimizationStats,
    QueryRequest,
};

impl Engine {
    /// Evaluate a materialized calculated table's QUERY over the model and
    /// store the result as the derived table's in-memory data.
    ///
    /// The tables the QUERY reads from must be queryable first (cached for
    /// `InMemory` tables, connected for `DirectQuery`) — [`refresh_stale`]
    /// (Self::refresh_stale) orders this automatically. Errors if `name` is
    /// not a calculated table or is dynamic (dynamic calculated tables are
    /// evaluated per query and never materialized).
    pub async fn materialize_calculated_table(&mut self, name: &str) -> EngineResult<()> {
        self.materialize_calculated_table_inner(name).await.map(|_| ())
    }

    /// Materialize every materialized calculated table, in dependency order
    /// (model table order — the builder appends each derived table after the
    /// tables it reads from). Returns the names materialized. Fails fast on
    /// the first error; [`refresh_stale`](Self::refresh_stale) is the
    /// failure-accumulating alternative.
    pub async fn materialize_calculated_tables(&mut self) -> EngineResult<Vec<String>> {
        let names: Vec<String> = self
            .model
            .tables()
            .iter()
            .filter(|t| t.is_calculated())
            .map(|t| t.name().to_string())
            .collect();
        for name in &names {
            self.materialize_calculated_table_inner(name).await?;
        }
        Ok(names)
    }

    pub(crate) async fn materialize_calculated_table_inner(
        &mut self,
        name: &str,
    ) -> EngineResult<OptimizationStats> {
        let gv: GlobalVariable = self.model.global_variable(name)?.clone();
        if gv.is_dynamic() {
            return Err(EngineError::MaterializationFailed {
                name: name.to_string(),
                reason: "the calculated table is dynamic (evaluated per query); only \
                         materialized (Dynamic = no) calculated tables can be materialized"
                    .to_string(),
            });
        }
        let Expression::Query {
            aggregates,
            group_by,
        } = gv.expression().clone()
        else {
            return Err(EngineError::MaterializationFailed {
                name: name.to_string(),
                reason: "not a QUERY(...) expression".to_string(),
            });
        };

        // One ephemeral overlay measure per QUERY aggregate (the overlay is a
        // model clone — self.model is untouched). The synthetic names only
        // live inside this request.
        let mut synthetic = Vec::new();
        let mut column_sources: Vec<(String, String)> = Vec::new(); // (target col, result col)
        for (table, column) in &group_by {
            let _ = table;
            column_sources.push((column.clone(), column.clone()));
        }
        for (i, (expr, alias)) in aggregates.iter().enumerate() {
            let measure_name = format!("__materialize__{name}__{i}");
            synthetic.push(Measure::new(&measure_name, expr.clone()));
            column_sources.push((alias.clone(), measure_name.clone()));
        }
        let measure_names: Vec<String> = synthetic.iter().map(|m| m.name().to_string()).collect();
        let overlay = self
            .model
            .with_overlay_measures(synthetic)
            .map_err(|e| EngineError::MaterializationFailed {
                name: name.to_string(),
                reason: e.to_string(),
            })?;

        let request = QueryRequest {
            measures: measure_names,
            group_by: group_by
                .iter()
                .map(|(table, column)| ColumnRef::new(table.clone(), column.clone()))
                .collect(),
            ..Default::default()
        };

        // No role filters: materialization sees the unfiltered model (same
        // posture as Power BI calculated tables — RLS applies to the derived
        // table at query time, not at refresh).
        let batches = self
            .plan_and_execute(&request, &request, &overlay, &[], &CancellationToken::new())
            .await
            .map_err(|e| EngineError::MaterializationFailed {
                name: name.to_string(),
                reason: e.to_string(),
            })?;

        // Conform to the derived table's declared schema: select result
        // columns by name, cast to the inferred types, rename to the aliases.
        let target_schema = Arc::new(self.model.table(name)?.to_arrow_schema());
        let mut conformed = Vec::with_capacity(batches.len());
        for batch in &batches {
            let mut columns = Vec::with_capacity(target_schema.fields().len());
            for (field, (_, result_name)) in target_schema.fields().iter().zip(&column_sources) {
                let index = batch.schema().index_of(result_name).map_err(|_| {
                    EngineError::MaterializationFailed {
                        name: name.to_string(),
                        reason: format!(
                            "result is missing expected column '{result_name}' (have: {:?})",
                            batch
                                .schema()
                                .fields()
                                .iter()
                                .map(|f| f.name().clone())
                                .collect::<Vec<_>>()
                        ),
                    }
                })?;
                let cast = arrow::compute::cast(batch.column(index), field.data_type()).map_err(
                    |e| EngineError::MaterializationFailed {
                        name: name.to_string(),
                        reason: format!(
                            "cannot cast result column '{result_name}' to declared type \
                             {:?}: {e}",
                            field.data_type()
                        ),
                    },
                )?;
                columns.push(cast);
            }
            conformed.push(
                RecordBatch::try_new(Arc::clone(&target_schema), columns).map_err(|e| {
                    EngineError::MaterializationFailed {
                        name: name.to_string(),
                        reason: e.to_string(),
                    }
                })?,
            );
        }

        self.store_refreshed_table(name, conformed)
    }
}
