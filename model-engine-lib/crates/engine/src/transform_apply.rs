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

use std::collections::BTreeMap;

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
            &self.step_inputs_for(steps)?,
        )
        .await?;

        let conformed = conform_to_declared(table_name, last_step, &transformed, table.columns())?;
        Ok(vec![conformed])
    }

    /// The other tables a pipeline reads, as rows plus declared columns.
    ///
    /// `engine-core` does no I/O, so the batches are resolved HERE — the one
    /// place that holds both the model and the cache — and handed down. Reads
    /// the CACHE, never the source: a lookup joins the rows the model currently
    /// holds, which is what every query and the grid already show. Refresh
    /// ordering (see `pipeline_refresh_order`) is what makes those rows the
    /// fresh ones.
    ///
    /// A dependency with no cached rows is left OUT rather than erroring here:
    /// evaluation names the step that wanted it, which is a far better message
    /// than one naming the whole pipeline.
    pub(crate) fn step_inputs_for(
        &self,
        steps: &[engine_core::transform::TransformStep],
    ) -> EngineResult<engine_core::transform::StepInputs> {
        let mut inputs = engine_core::transform::StepInputs::none();
        for name in engine_core::transform::pipeline_dependencies(steps) {
            let Ok(table) = self.model.table(&name) else {
                continue;
            };
            // Resolved through the model first, so the cache is asked for the
            // table's CANONICAL name whatever casing the step was written in.
            let Some(batch) = self.cache.get(table.name()) else {
                continue;
            };
            inputs = inputs.with_table(table.name(), batch.clone(), table.columns().to_vec());
        }
        Ok(inputs)
    }

    /// The cache generation of each table `table_name`'s pipeline looks up,
    /// as of right now. A dependency with no cached rows is ABSENT from the
    /// map rather than zero — "had no rows" and "had rows" must compare
    /// unequal, or a lookup that produced all-NULL would never be retried.
    fn current_dep_generations(&self, table_name: &str) -> BTreeMap<String, u64> {
        let mut seen = BTreeMap::new();
        let Ok(table) = self.model.table(table_name) else {
            return seen;
        };
        let Some(binding) = table.source_binding() else {
            return seen;
        };
        for name in engine_core::transform::pipeline_dependencies(&binding.transformations) {
            let Ok(dependency) = self.model.table(&name) else {
                continue;
            };
            if let Some(generation) = self.cache.generation(dependency.name()) {
                seen.insert(dependency.name().to_string(), generation);
            }
        }
        seen
    }

    /// Record which rows `table_name` was just transformed against.
    ///
    /// Called after a successful store. Safe to read the cache here rather
    /// than at transform time: the only entry written in between is
    /// `table_name`'s own, and a pipeline cannot look up its own table.
    pub(crate) fn record_transform_dependencies(&mut self, table_name: &str) {
        let seen = self.current_dep_generations(table_name);
        let key = self
            .model
            .table(table_name)
            .map(|t| t.name().to_string())
            .unwrap_or_else(|_| table_name.to_string());
        if seen.is_empty() {
            // Not merely tidiness: leaving a stale map behind for a table
            // whose pipeline no longer looks anything up would make it
            // permanently stale, and it would refresh on every call forever.
            self.transform_dep_generations.remove(&key);
        } else {
            self.transform_dep_generations.insert(key, seen);
        }
    }

    /// Whether the rows `table_name` looked up have been replaced since it
    /// was last transformed — the staleness no timestamp can see.
    ///
    /// A table with no recorded dependencies answers `false`, which is right
    /// for both the ordinary table (nothing to look up) and the never-yet
    /// transformed one (uncached, so already stale for a plainer reason).
    pub(crate) fn lookup_targets_moved(&self, table_name: &str) -> bool {
        let Ok(table) = self.model.table(table_name) else {
            return false;
        };
        match self.transform_dep_generations.get(table.name()) {
            Some(recorded) => *recorded != self.current_dep_generations(table.name()),
            // Never transformed against anything, or its pipeline has no
            // lookups. Either way this signal has nothing to say.
            None => !self.current_dep_generations(table.name()).is_empty(),
        }
    }
}
