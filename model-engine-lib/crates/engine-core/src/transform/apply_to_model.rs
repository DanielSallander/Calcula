//! Installing a pipeline into a [`DataModel`].
//!
//! Setting a table's steps is a **model** operation, not an engine one: it
//! re-derives the table's columns and produces a new model. Keeping it here —
//! I/O-free, in the crate that owns the model — means a host can compute the
//! edit without standing up an engine, and the facade's version is a thin
//! wrapper that adds only the cache invalidation an engine actually owns.

use crate::error::{EngineError, EngineResult};
use crate::model::{Column, DataModel, StorageMode, Table};
use crate::transform::{derive_pipeline_schema, TransformStep};

/// Carry the CURRENT table's per-column presentation metadata onto the newly
/// derived columns, matched by name.
///
/// Derivation works from the recorded source schema, so on its own it produces
/// columns wearing whatever metadata the SOURCE had when the pipeline was first
/// created. Everything the user set afterwards — a display name, a format
/// string, a sort-by, a hidden flag — lives only on the model table, and would
/// therefore be reverted to that anchor-time snapshot by the next steps edit.
///
/// The derived TYPE always wins: a step that retyped a column means it, and the
/// old column's type is not metadata.
fn carry_column_metadata(derived: Vec<Column>, current: &[Column]) -> Vec<Column> {
    derived
        .into_iter()
        .map(|column| {
            let Some(previous) = current.iter().find(|c| c.name() == column.name()) else {
                return column;
            };
            let mut merged = previous.clone().with_data_type(column.data_type().clone());
            merged = merged.with_nullable(column.nullable());
            merged
        })
        .collect()
}

/// Return a copy of `model` with `table`'s transformation pipeline replaced.
///
/// The table's declared columns are **re-derived from the steps**, so callers
/// never compute a schema: passing steps IS the schema change. An empty
/// `steps` clears the pipeline and restores the table to its raw source
/// schema.
///
/// The first pipeline on a table records the schema it has *right now* as the
/// source schema, because that is what the source is currently delivering.
/// Later edits derive from that recorded anchor rather than from the table's
/// (by then transformed) columns — which is what lets someone edit step 1 of
/// an existing pipeline using a column a later step removes.
///
/// The returned model is **not** validated; callers run
/// [`DataModel::validate`] so a pipeline that strands a measure or a
/// relationship is refused with the model untouched.
///
/// # Errors
///
/// [`EngineError::TableNotFound`] for an unknown table,
/// [`EngineError::InvalidTransform`] when the table has no source binding or a
/// step cannot apply to the schema reaching it.
pub fn with_table_transformations(
    model: &DataModel,
    table: &str,
    steps: Vec<TransformStep>,
) -> EngineResult<DataModel> {
    let existing = model.table(table)?;
    let binding = existing
        .source_binding()
        .ok_or_else(|| EngineError::InvalidTransform {
            table: table.to_string(),
            step_index: 0,
            reason: "the table is not bound to a data source, so there is \
                     nothing for transformation steps to transform"
                .to_string(),
        })?;

    let mut binding = binding.clone();
    if binding.source_columns.is_empty() {
        binding.source_columns = existing.columns().to_vec();
    }

    let derived: Vec<Column> = if steps.is_empty() {
        binding.source_columns.clone()
    } else {
        derive_pipeline_schema(table, &binding.source_columns, &steps)?
    };
    // Keep the presentation work the user did on the model table; only the
    // shape comes from derivation.
    let derived = carry_column_metadata(derived, existing.columns());

    // With no steps there is nothing to anchor, and keeping the recorded
    // source schema would leave a stale copy of it in the model file forever.
    if steps.is_empty() {
        binding.source_columns.clear();
    }
    binding.transformations = steps;

    let updated: Vec<Table> = model
        .tables()
        .iter()
        .map(|t| {
            if t.name() != table {
                return Ok(t.clone());
            }
            // A transformed table IS an in-memory table: the pipeline produces
            // rows that exist nowhere but the cache, and model validation
            // refuses any other storage mode outright. Stamping it here is
            // therefore not a preference being overridden — it is the only
            // mode the edit could have succeeded with, and leaving the caller
            // to discover that through a validation error makes a legal edit
            // look like a mistake. Clearing the steps does NOT switch back:
            // by then the mode is the user's to keep.
            let storage_mode = if binding.transformations.is_empty() {
                t.storage_mode().clone()
            } else {
                StorageMode::InMemory
            };
            let mut replacement = Table::new(t.name(), derived.clone())?
                .with_storage_mode(storage_mode)
                .with_source_binding(binding.clone());
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
            Ok(replacement)
        })
        .collect::<EngineResult<Vec<Table>>>()?;

    Ok(model.with_tables(updated))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{
        PersistedAuthKind, PersistedConnection, PersistedSource, SourceKind, StorageMode,
        TableSourceBinding,
    };
    use crate::types::DataType;

    fn source_columns() -> Vec<Column> {
        vec![
            Column::new("id", DataType::Int64),
            Column::new("status", DataType::String),
            Column::new("amount", DataType::Float64),
        ]
    }

    fn model() -> DataModel {
        DataModel::builder()
            .add_source(PersistedSource::new(
                "src",
                SourceKind::InMemory,
                PersistedConnection::default(),
                PersistedAuthKind::Integrated,
            ))
            .add_table(
                Table::new("Orders", source_columns())
                    .unwrap()
                    .with_storage_mode(StorageMode::InMemory)
                    .with_display_name("Sales Orders")
                    .with_description("One row per order")
                    .with_source_binding(TableSourceBinding::new("src", "public", "orders")),
            )
            .build()
            .unwrap()
    }

    fn names(model: &DataModel, table: &str) -> Vec<String> {
        model
            .table(table)
            .unwrap()
            .columns()
            .iter()
            .map(|c| c.name().to_string())
            .collect()
    }

    #[test]
    fn setting_steps_rederives_the_columns_and_records_the_source_schema() {
        let updated = with_table_transformations(
            &model(),
            "Orders",
            vec![TransformStep::RemoveColumns {
                columns: vec!["status".into()],
            }],
        )
        .unwrap();

        assert_eq!(names(&updated, "Orders"), vec!["id", "amount"]);
        let binding = updated.table("Orders").unwrap().source_binding().unwrap();
        assert_eq!(binding.source_columns.len(), 3, "the anchor was captured");
        assert_eq!(binding.transformations.len(), 1);
    }

    #[test]
    fn the_tables_presentation_metadata_survives_the_rebuild() {
        let updated = with_table_transformations(
            &model(),
            "Orders",
            vec![TransformStep::RemoveColumns {
                columns: vec!["status".into()],
            }],
        )
        .unwrap();
        let table = updated.table("Orders").unwrap();
        assert_eq!(table.display_name(), Some("Sales Orders"));
        assert_eq!(table.description(), Some("One row per order"));
        assert_eq!(table.storage_mode(), &StorageMode::InMemory);
    }

    #[test]
    fn a_later_edit_derives_from_the_recorded_source_not_the_transformed_table() {
        // The failure this prevents: editing step 1 of an existing pipeline
        // using a column that a LATER step removes. Deriving from the table's
        // own (already transformed) columns would reject it.
        let once = with_table_transformations(
            &model(),
            "Orders",
            vec![TransformStep::RemoveColumns {
                columns: vec!["status".into()],
            }],
        )
        .unwrap();

        let twice = with_table_transformations(
            &once,
            "Orders",
            vec![
                TransformStep::FilterRows {
                    condition: "status <> \"cancelled\"".into(),
                },
                TransformStep::RemoveColumns {
                    columns: vec!["status".into()],
                },
            ],
        )
        .unwrap();
        assert_eq!(names(&twice, "Orders"), vec!["id", "amount"]);
    }

    #[test]
    fn setting_steps_makes_the_table_in_memory() {
        // REGRESSION: an imported table is DirectQuery by default, and model
        // validation refuses a transformed DirectQuery table — so without this
        // the very first pipeline a user saves on a freshly imported table was
        // rejected, with nothing in the UI explaining what to change.
        let direct = {
            let base = model();
            let mut tables = base.tables().to_vec();
            tables[0].set_storage_mode(StorageMode::DirectQuery);
            base.with_tables(tables)
        };
        assert_eq!(
            direct.table("Orders").unwrap().storage_mode(),
            &StorageMode::DirectQuery
        );

        let updated = with_table_transformations(
            &direct,
            "Orders",
            vec![TransformStep::RemoveColumns {
                columns: vec!["status".into()],
            }],
        )
        .unwrap();
        assert_eq!(
            updated.table("Orders").unwrap().storage_mode(),
            &StorageMode::InMemory
        );
        // And the result is a model that actually validates.
        updated.validate().expect("a transformed table must build");
    }

    #[test]
    fn clearing_the_steps_leaves_the_storage_mode_alone() {
        // The reverse is NOT automatic: once in memory, staying there is the
        // user's call, not something clearing a filter should undo.
        let shaped = with_table_transformations(
            &model(),
            "Orders",
            vec![TransformStep::RemoveColumns {
                columns: vec!["status".into()],
            }],
        )
        .unwrap();
        let cleared = with_table_transformations(&shaped, "Orders", vec![]).unwrap();
        assert_eq!(
            cleared.table("Orders").unwrap().storage_mode(),
            &StorageMode::InMemory
        );
    }

    #[test]
    fn clearing_the_steps_restores_the_source_schema_and_drops_the_anchor() {
        let shaped = with_table_transformations(
            &model(),
            "Orders",
            vec![TransformStep::RemoveColumns {
                columns: vec!["status".into()],
            }],
        )
        .unwrap();
        let cleared = with_table_transformations(&shaped, "Orders", vec![]).unwrap();

        assert_eq!(names(&cleared, "Orders"), vec!["id", "status", "amount"]);
        let binding = cleared.table("Orders").unwrap().source_binding().unwrap();
        assert!(binding.transformations.is_empty());
        assert!(
            binding.source_columns.is_empty(),
            "with no steps there is no anchor to keep"
        );
    }

    #[test]
    fn an_unbound_table_is_refused() {
        let unbound = DataModel::builder()
            .add_table(Table::new("Loose", source_columns()).unwrap())
            .build()
            .unwrap();
        let error = with_table_transformations(&unbound, "Loose", vec![]).unwrap_err();
        assert!(error.to_string().contains("data source"), "got {error}");
    }

    #[test]
    fn an_unknown_table_is_refused() {
        assert!(with_table_transformations(&model(), "Nope", vec![]).is_err());
    }

    #[test]
    fn a_bad_step_is_refused_with_its_index_and_the_model_is_not_returned() {
        let error = with_table_transformations(
            &model(),
            "Orders",
            vec![
                TransformStep::RemoveColumns {
                    columns: vec!["status".into()],
                },
                TransformStep::RemoveColumns {
                    columns: vec!["status".into()],
                },
            ],
        )
        .unwrap_err();
        match error {
            EngineError::InvalidTransform { step_index, .. } => assert_eq!(step_index, 1),
            other => panic!("expected InvalidTransform, got {other:?}"),
        }
    }
}
