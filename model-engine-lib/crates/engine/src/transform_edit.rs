//! Editing a table's transformation pipeline.
//!
//! Setting steps is a **model edit**, not a data operation: it changes what
//! the table's columns are, so it re-derives the declared schema, revalidates
//! the whole model against the new shape, and only then installs it. A pipeline
//! that would strand a measure or a relationship is refused here, with the
//! model untouched.

use engine_core::error::{EngineError, EngineResult};
use engine_core::model::{Column, Table};
use engine_core::transform::{derive_pipeline_schema, with_table_transformations, TransformStep};

use crate::Engine;

/// What re-reading a source's schema changed.
///
/// Returned by [`Engine::refresh_source_schema`] so a host can tell the user
/// what moved underneath their pipeline instead of only reporting that a step
/// stopped working.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct SourceSchemaDiff {
    /// Columns the source has now that the model had not recorded.
    pub added: Vec<String>,
    /// Columns the model recorded that the source no longer has.
    pub removed: Vec<String>,
    /// Columns whose type changed, as `(column, before, after)` renderings.
    pub retyped: Vec<(String, String, String)>,
}

impl SourceSchemaDiff {
    /// Returns `true` when the source schema is unchanged.
    pub fn is_empty(&self) -> bool {
        self.added.is_empty() && self.removed.is_empty() && self.retyped.is_empty()
    }
}

/// Compare two schemas by name and type.
fn diff_schemas(before: &[Column], after: &[Column]) -> SourceSchemaDiff {
    let mut diff = SourceSchemaDiff::default();
    for column in after {
        match before.iter().find(|c| c.name() == column.name()) {
            None => diff.added.push(column.name().to_string()),
            Some(previous) if previous.data_type() != column.data_type() => {
                diff.retyped.push((
                    column.name().to_string(),
                    format!("{:?}", previous.data_type()),
                    format!("{:?}", column.data_type()),
                ));
            }
            Some(_) => {}
        }
    }
    for column in before {
        if !after.iter().any(|c| c.name() == column.name()) {
            diff.removed.push(column.name().to_string());
        }
    }
    diff
}

impl Engine {
    /// Replace `table`'s transformation pipeline.
    ///
    /// The table's declared columns are re-derived from the steps, so the
    /// caller does not compute them — passing steps IS the schema change.
    /// Passing an empty `steps` clears the pipeline and restores the table to
    /// its raw source schema.
    ///
    /// Synchronous and I/O-free: nothing is fetched, and the table's cache is
    /// dropped so the next query re-fetches through the new pipeline.
    ///
    /// # Errors
    ///
    /// - [`EngineError::TableNotFound`] for an unknown table.
    /// - [`EngineError::InvalidTransform`] when the table has no source
    ///   binding, has no recorded source columns, or a step cannot apply.
    /// - Any model-validation error the new shape causes — for instance a
    ///   measure or relationship left referring to a column the pipeline
    ///   removes. The model is left untouched in every failure case.
    pub fn set_table_transformations(
        &mut self,
        table: &str,
        steps: Vec<TransformStep>,
    ) -> EngineResult<()> {
        // The model half is I/O-free and lives in engine-core, so a host can
        // compute the same edit without standing up an engine. What an engine
        // adds is the two things only it owns: validation against the live
        // model, and cache invalidation.
        let new_model = with_table_transformations(&self.model, table, steps)?;
        new_model.validate()?;

        // `set_model` INSTALLS the model and only then returns any deferred
        // script-build error (a model script colliding with a native UDF name).
        // A `?` here would therefore leave the new pipeline installed over the
        // OLD pipeline's cached rows while telling the caller the edit failed —
        // the worst of both. Finish the transaction, then surface the error.
        let deferred = self.set_model(new_model);

        // The cached rows were produced by the OLD pipeline, so they are the
        // wrong rows now. Dropping them is what makes the edit take effect on
        // the next query rather than at some later refresh.
        self.drop_table_cache(table);
        deferred
    }

    /// Returns `table`'s transformation pipeline.
    pub fn table_transformations(&self, table: &str) -> EngineResult<&[TransformStep]> {
        Ok(self
            .model
            .table(table)?
            .source_binding()
            .map(|b| b.transformations.as_slice())
            .unwrap_or(&[]))
    }

    /// Returns the source schema `table`'s pipeline derives from.
    pub fn table_source_columns(&self, table: &str) -> EngineResult<&[Column]> {
        Ok(self
            .model
            .table(table)?
            .source_binding()
            .map(|b| b.source_columns.as_slice())
            .unwrap_or(&[]))
    }

    /// Re-introspect `table`'s source and update the recorded source schema,
    /// re-deriving the table's declared columns through its existing steps.
    ///
    /// The recovery path when a source changes shape: the refresh's conform
    /// step reports the drift, and this adopts it.
    ///
    /// # Errors
    ///
    /// Introspection failures, plus everything
    /// [`set_table_transformations`](Self::set_table_transformations) can
    /// raise — in particular, a step that the *new* source schema cannot
    /// support. The model is left untouched on failure, so a drift that breaks
    /// a step leaves the previous (working) definition in place.
    pub async fn refresh_source_schema(&mut self, table: &str) -> EngineResult<SourceSchemaDiff> {
        let binding = self
            .model
            .table(table)?
            .source_binding()
            .ok_or_else(|| EngineError::InvalidTransform {
                table: table.to_string(),
                step_index: 0,
                reason: "the table is not bound to a data source".to_string(),
            })?
            .clone();

        let connector = self
            .registry
            .connector_for(table)
            .map_err(|e| EngineError::InvalidData(e.to_string()))?;
        let introspected = connector
            .introspect_table(&binding.schema, &binding.table)
            .await
            .map_err(|e| EngineError::InvalidData(e.to_string()))?;
        let fresh = introspected.columns().to_vec();

        // For a table with NO pipeline the anchor is empty by convention
        // (there is nothing to anchor), so diffing against it would report
        // every column as newly added. What such a table can meaningfully be
        // compared against is what it currently declares.
        let baseline: Vec<Column> = if binding.source_columns.is_empty() {
            self.model.table(table)?.columns().to_vec()
        } else {
            binding.source_columns.clone()
        };
        let diff = diff_schemas(&baseline, &fresh);
        if diff.is_empty() {
            return Ok(diff);
        }

        // Re-derive through the existing steps against the new source schema.
        let derived = if binding.transformations.is_empty() {
            fresh.clone()
        } else {
            derive_pipeline_schema(table, &fresh, &binding.transformations)?
        };

        let mut updated_binding = binding.clone();
        updated_binding.source_columns = if binding.transformations.is_empty() {
            Vec::new()
        } else {
            fresh
        };

        let updated: Vec<Table> = self
            .model
            .tables()
            .iter()
            .map(|t| {
                if t.name() != table {
                    return t.clone();
                }
                let mut replacement = match Table::new(t.name(), derived.clone()) {
                    Ok(replacement) => replacement,
                    Err(_) => t.clone(),
                };
                replacement = replacement
                    .with_storage_mode(t.storage_mode().clone())
                    .with_source_binding(updated_binding.clone());
                // Presentation metadata is the user's work, not the source's:
                // adopting a schema change must not quietly discard it. Mirrors
                // `with_table_transformations`, which is pinned by its own test.
                if let Some(display) = t.display_name() {
                    replacement = replacement.with_display_name(display);
                }
                if let Some(description) = t.description() {
                    replacement = replacement.with_description(description);
                }
                if t.is_hidden() {
                    replacement = replacement.hidden();
                }
                replacement.set_refresh_strategies(t.refresh_strategies().to_vec());
                replacement.set_incremental_refresh(t.incremental_refresh().cloned());
                replacement
            })
            .collect();

        let new_model = self.model.with_tables(updated);
        new_model.validate()?;
        // Same ordering rule as `set_table_transformations`: install, finish,
        // then surface any deferred script error.
        let deferred = self.set_model(new_model);
        self.drop_table_cache(table);
        deferred.map(|()| diff)
    }
}
