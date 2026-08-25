//! Applying a table's transformation pipeline between fetch and store.
//!
//! # Why this is the only place it happens
//!
//! Every connector — SQL, file, REST, or host-fed — returns
//! [`RecordBatch`]es through one trait, and every in-memory table lands
//! through [`store_refreshed_table`](crate::Engine::store_refreshed_table).
//! Applying the pipeline in the gap between those two facts makes it work for
//! every source that exists and every source that will exist, with no
//! per-connector code. A pipeline defined against a CSV import behaves
//! identically when the table is re-pointed at PostgreSQL.

use arrow::datatypes::{Field, Schema};
use arrow::record_batch::RecordBatch;

use engine_core::error::EngineResult;
use engine_core::model::Column;
use engine_core::transform::{apply_steps, conform_to_declared};

use crate::Engine;

/// The Arrow schema of a bare column list (the pipeline's declared input).
fn arrow_schema_of(columns: &[Column]) -> Schema {
    Schema::new(
        columns
            .iter()
            .map(|c| Field::new(c.name(), c.data_type().to_arrow(), c.nullable()))
            .collect::<Vec<_>>(),
    )
}

impl Engine {
    /// Run `table_name`'s transformation pipeline over freshly fetched batches.
    ///
    /// Returns `batches` untouched for a table with no pipeline, which is
    /// every ordinary table — so this sits on the refresh path at no cost to
    /// models that do not use the feature.
    ///
    /// The result is **conformed to the table's declared columns**: selected
    /// by name, cast to the declared types, in the declared order. That last
    /// step is what turns a source that quietly changed shape into a named
    /// error instead of a cache full of the wrong columns.
    pub(crate) async fn apply_table_transforms(
        &self,
        table_name: &str,
        batches: Vec<RecordBatch>,
    ) -> EngineResult<Vec<RecordBatch>> {
        let table = self.model.table(table_name)?;
        let Some(binding) = table.source_binding() else {
            return Ok(batches);
        };
        if !binding.has_transformations() {
            return Ok(batches);
        }

        let steps = &binding.transformations;
        let last_step = steps.len().saturating_sub(1);

        // The pipeline evaluates over one batch. An empty fetch still has to
        // carry the SOURCE schema — the pipeline's input — or the first step
        // would be handed a batch with no columns and fail for the wrong
        // reason.
        let input = if batches.is_empty() {
            RecordBatch::new_empty(std::sync::Arc::new(arrow_schema_of(
                &binding.source_columns,
            )))
        } else {
            let schema = batches[0].schema();
            arrow::compute::concat_batches(&schema, &batches)?
        };

        let transformed = apply_steps(
            table_name,
            input,
            &binding.source_columns,
            steps,
            steps.len(),
            // The effective registry, so a step's expression may call a model
            // script function exactly as a measure can.
            self.effective_udfs.as_ref(),
        )
        .await?;

        let conformed = conform_to_declared(table_name, last_step, &transformed, table.columns())?;
        Ok(vec![conformed])
    }
}
