//! Facade-level tests for table transformations: refresh, editing, preview.
//!
//! `engine-core` proves each step derives and evaluates correctly in
//! isolation. These tests prove the pipeline is actually *reached* — that a
//! refresh applies it before caching, that editing it re-derives the table and
//! drops stale rows, and that a preview runs candidate steps without touching
//! the model.

use std::sync::Arc;

use arrow::array::{Array, Float64Array, Int64Array, StringArray};
use arrow::datatypes::{DataType as ArrowType, Field, Schema as ArrowSchema};
use arrow::record_batch::RecordBatch;
use engine_query::registry::SourceBinding;
use tokio_util::sync::CancellationToken;

use crate::{
    derive_pipeline_schema, sum_measure, Column, ColumnRename, DataModel, DataType, Engine,
    InMemoryConnector, PersistedAuthKind, PersistedConnection, PersistedSource, SourceKind,
    StorageMode, Table, TableSourceBinding, TransformPreviewRequest, TransformStep,
};

/// The source's own schema: what the connector delivers.
fn source_columns() -> Vec<Column> {
    vec![
        Column::new("id", DataType::Int64),
        Column::new("status", DataType::String),
        Column::new("amount", DataType::Float64),
    ]
}

/// Four orders, one of them cancelled.
fn source_batch() -> RecordBatch {
    let schema = Arc::new(ArrowSchema::new(vec![
        Field::new("id", ArrowType::Int64, true),
        Field::new("status", ArrowType::Utf8, true),
        Field::new("amount", ArrowType::Float64, true),
    ]));
    RecordBatch::try_new(
        schema,
        vec![
            Arc::new(Int64Array::from(vec![1, 2, 3, 4])),
            Arc::new(StringArray::from(vec![
                "open",
                "cancelled",
                "open",
                "closed",
            ])),
            Arc::new(Float64Array::from(vec![10.0, 20.0, 30.0, 40.0])),
        ],
    )
    .unwrap()
}

/// A model with one `Orders` table carrying `steps`, whose declared columns
/// are derived from them.
fn model_with_steps(steps: Vec<TransformStep>) -> DataModel {
    let derived = derive_pipeline_schema(
        "Orders",
        &source_columns(),
        &steps,
        &engine_core::transform::NoOtherTables,
    )
    .expect("test steps must derive");
    let mut binding = TableSourceBinding::new("src", "public", "orders");
    if !steps.is_empty() {
        binding = binding
            .with_source_columns(source_columns())
            .with_transformations(steps);
    }
    DataModel::builder()
        .add_source(PersistedSource::new(
            "src",
            SourceKind::InMemory,
            PersistedConnection::default(),
            PersistedAuthKind::Integrated,
        ))
        .add_table(
            Table::new("Orders", derived)
                .unwrap()
                .with_storage_mode(StorageMode::InMemory)
                .with_source_binding(binding),
        )
        .build()
        .expect("test model must build")
}

/// An engine over `steps`, wired to an in-memory source serving
/// [`source_batch`].
fn engine_with_steps(steps: Vec<TransformStep>) -> Engine {
    let mut engine = Engine::new(model_with_steps(steps));
    let source = InMemoryConnector::new().with_table("public", "orders", source_batch());
    let idx = engine.add_in_memory_source(source);
    engine.bind_table("Orders", idx, SourceBinding::new("public", "orders"));
    engine
}

/// The cached column names of `Orders`.
fn cached_columns(engine: &Engine) -> Vec<String> {
    engine
        .cache()
        .get("Orders")
        .expect("Orders must be cached")
        .schema()
        .fields()
        .iter()
        .map(|f| f.name().clone())
        .collect()
}

// --- Refresh ---

#[tokio::test]
async fn refresh_applies_the_pipeline_before_caching() {
    let mut engine = engine_with_steps(vec![
        TransformStep::FilterRows {
            condition: "status <> \"cancelled\"".into(),
        },
        TransformStep::RenameColumns {
            renames: vec![ColumnRename::new("amount", "net")],
        },
    ]);

    engine.refresh_table("Orders").await.unwrap();

    let batch = engine.cache().get("Orders").unwrap();
    assert_eq!(batch.num_rows(), 3, "the cancelled row must not be cached");
    assert_eq!(cached_columns(&engine), vec!["id", "status", "net"]);
}

#[tokio::test]
async fn refresh_of_a_table_without_a_pipeline_is_unchanged() {
    // The regression guard: adding this feature must not alter what an
    // ordinary table caches.
    let mut engine = engine_with_steps(vec![]);
    engine.refresh_table("Orders").await.unwrap();

    let batch = engine.cache().get("Orders").unwrap();
    assert_eq!(batch.num_rows(), 4);
    assert_eq!(cached_columns(&engine), vec!["id", "status", "amount"]);
}

#[tokio::test]
async fn refresh_all_in_memory_transforms_the_table_too() {
    // `refresh_all_in_memory` fetches concurrently and stores in a second
    // phase; the pipeline must be applied on that path as well, not only on
    // the single-table one.
    let mut engine = engine_with_steps(vec![TransformStep::FilterRows {
        condition: "status = \"open\"".into(),
    }]);

    engine.refresh_all_in_memory().await.unwrap();
    assert_eq!(engine.cache().get("Orders").unwrap().num_rows(), 2);
}

#[tokio::test]
async fn a_source_that_lost_a_column_fails_loudly() {
    // Source drift: the model expects `status`, the source no longer has it.
    let mut engine = engine_with_steps(vec![TransformStep::RenameColumns {
        renames: vec![ColumnRename::new("amount", "net")],
    }]);

    let narrowed_schema = Arc::new(ArrowSchema::new(vec![
        Field::new("id", ArrowType::Int64, true),
        Field::new("amount", ArrowType::Float64, true),
    ]));
    let narrowed = RecordBatch::try_new(
        narrowed_schema,
        vec![
            Arc::new(Int64Array::from(vec![1, 2])),
            Arc::new(Float64Array::from(vec![10.0, 20.0])),
        ],
    )
    .unwrap();
    let source = InMemoryConnector::new().with_table("public", "orders", narrowed);
    let idx = engine.add_in_memory_source(source);
    engine.bind_table("Orders", idx, SourceBinding::new("public", "orders"));

    let error = engine.refresh_table("Orders").await.unwrap_err();
    let message = error.to_string();
    assert!(
        message.contains("status"),
        "must name the column: {message}"
    );
}

#[tokio::test]
async fn incremental_refresh_is_refused_for_a_transformed_table() {
    // Model validation rejects the combination, so reaching this needs a
    // hand-assembled engine — which is exactly the case the defensive guard
    // in `refresh_table_incremental` exists for.
    let mut engine = engine_with_steps(vec![TransformStep::FilterRows {
        condition: "status <> \"cancelled\"".into(),
    }]);
    engine.refresh_table("Orders").await.unwrap();

    let mut tables = engine.model().tables().to_vec();
    tables[0].set_incremental_refresh(Some(crate::IncrementalRefresh::new("id > 0")));
    let tampered = engine.model().with_tables(tables);
    // `set_model` deliberately does not re-validate, which is the only way to
    // reach this state — exactly as a hand-edited model file would.
    engine.set_model(tampered).unwrap();

    let error = engine.refresh_table("Orders").await.unwrap_err();
    assert!(error.to_string().contains("incremental"), "got {error}");
}

// --- Editing ---

#[tokio::test]
async fn setting_steps_rederives_the_tables_columns() {
    let mut engine = engine_with_steps(vec![]);

    engine
        .set_table_transformations(
            "Orders",
            vec![TransformStep::RemoveColumns {
                columns: vec!["status".into()],
            }],
        )
        .unwrap();

    let names: Vec<&str> = engine
        .model()
        .table("Orders")
        .unwrap()
        .columns()
        .iter()
        .map(|c| c.name())
        .collect();
    assert_eq!(names, vec!["id", "amount"]);
    // The source schema was captured so later edits derive from it.
    assert_eq!(engine.table_source_columns("Orders").unwrap().len(), 3);
}

#[tokio::test]
async fn setting_steps_drops_rows_the_old_pipeline_produced() {
    let mut engine = engine_with_steps(vec![]);
    engine.refresh_table("Orders").await.unwrap();
    assert!(engine.cache().get("Orders").is_some());

    engine
        .set_table_transformations(
            "Orders",
            vec![TransformStep::FilterRows {
                condition: "status = \"open\"".into(),
            }],
        )
        .unwrap();

    assert!(
        engine.cache().get("Orders").is_none(),
        "cached rows produced by the OLD definition must not survive the edit"
    );

    // And the next refresh produces rows the NEW definition describes.
    engine.refresh_table("Orders").await.unwrap();
    assert_eq!(engine.cache().get("Orders").unwrap().num_rows(), 2);
}

#[tokio::test]
async fn clearing_the_pipeline_restores_the_source_schema() {
    let mut engine = engine_with_steps(vec![TransformStep::RemoveColumns {
        columns: vec!["status".into()],
    }]);

    engine.set_table_transformations("Orders", vec![]).unwrap();

    let names: Vec<&str> = engine
        .model()
        .table("Orders")
        .unwrap()
        .columns()
        .iter()
        .map(|c| c.name())
        .collect();
    assert_eq!(names, vec!["id", "status", "amount"]);
    assert!(engine.table_transformations("Orders").unwrap().is_empty());
    assert!(
        engine.table_source_columns("Orders").unwrap().is_empty(),
        "with no steps there is no anchor to keep"
    );
}

#[tokio::test]
async fn a_pipeline_that_strands_a_measure_is_refused_and_changes_nothing() {
    let model = {
        let base = model_with_steps(vec![]);
        let tables = base.tables().to_vec();
        DataModel::builder()
            .add_source(base.sources()[0].clone())
            .add_table(tables[0].clone())
            .add_measure(sum_measure("Revenue", "Orders", "amount"))
            .build()
            .unwrap()
    };
    let mut engine = Engine::new(model);

    let error = engine
        .set_table_transformations(
            "Orders",
            vec![TransformStep::RemoveColumns {
                columns: vec!["amount".into()],
            }],
        )
        .unwrap_err();
    assert!(
        error.to_string().to_lowercase().contains("amount"),
        "got {error}"
    );

    // The model must be untouched — a refused edit is not a partial edit.
    let names: Vec<&str> = engine
        .model()
        .table("Orders")
        .unwrap()
        .columns()
        .iter()
        .map(|c| c.name())
        .collect();
    assert_eq!(names, vec!["id", "status", "amount"]);
    assert!(engine.table_transformations("Orders").unwrap().is_empty());
}

#[tokio::test]
async fn setting_steps_on_an_unbound_table_is_refused() {
    let model = DataModel::builder()
        .add_table(
            Table::new("Loose", vec![Column::new("id", DataType::Int64)])
                .unwrap()
                .with_storage_mode(StorageMode::InMemory),
        )
        .build()
        .unwrap();
    let mut engine = Engine::new(model);

    let error = engine
        .set_table_transformations(
            "Loose",
            vec![TransformStep::RemoveColumns {
                columns: vec!["id".into()],
            }],
        )
        .unwrap_err();
    assert!(error.to_string().contains("data source"), "got {error}");
}

#[tokio::test]
async fn an_invalid_step_is_refused_with_its_index() {
    let mut engine = engine_with_steps(vec![]);
    let error = engine
        .set_table_transformations(
            "Orders",
            vec![TransformStep::RemoveColumns {
                columns: vec!["nope".into()],
            }],
        )
        .unwrap_err();
    match error {
        crate::EngineError::InvalidTransform { step_index, .. } => assert_eq!(step_index, 0),
        other => panic!("expected InvalidTransform, got {other:?}"),
    }
}

// --- Preview ---

#[tokio::test]
async fn preview_runs_candidate_steps_without_touching_the_model() {
    let engine = engine_with_steps(vec![]);
    let candidate = vec![TransformStep::FilterRows {
        condition: "status = \"open\"".into(),
    }];

    let preview = engine
        .preview_transformations(
            &TransformPreviewRequest::new("Orders", candidate),
            &CancellationToken::new(),
        )
        .await
        .unwrap();

    assert_eq!(preview.batch.num_rows(), 2);
    // The candidate steps were never saved.
    assert!(engine.table_transformations("Orders").unwrap().is_empty());
    assert!(engine.cache().get("Orders").is_none());
}

#[tokio::test]
async fn preview_upto_shows_the_pipeline_as_of_a_step() {
    let engine = engine_with_steps(vec![]);
    let candidate = vec![
        TransformStep::FilterRows {
            condition: "status <> \"cancelled\"".into(),
        },
        TransformStep::RemoveColumns {
            columns: vec!["status".into()],
        },
    ];
    let request = TransformPreviewRequest::new("Orders", candidate);

    // Step 0 = the raw source, which is what a step list's "Source" row shows.
    let source = engine
        .preview_transformations(&request.clone().upto(0), &CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(source.batch.num_rows(), 4);
    assert_eq!(source.batch.num_columns(), 3);

    let after_filter = engine
        .preview_transformations(&request.clone().upto(1), &CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(after_filter.batch.num_rows(), 3);
    assert_eq!(after_filter.batch.num_columns(), 3);

    let all = engine
        .preview_transformations(&request, &CancellationToken::new())
        .await
        .unwrap();
    assert_eq!(all.batch.num_rows(), 3);
    assert_eq!(all.batch.num_columns(), 2);
}

#[tokio::test]
async fn preview_reports_a_bad_step_before_fetching_anything() {
    let engine = engine_with_steps(vec![]);
    let error = engine
        .preview_transformations(
            &TransformPreviewRequest::new(
                "Orders",
                vec![TransformStep::FilterRows {
                    condition: "SUM(amount) > 0".into(),
                }],
            ),
            &CancellationToken::new(),
        )
        .await
        .unwrap_err();
    assert!(error.to_string().contains("aggregation"), "got {error}");
}

#[tokio::test]
async fn a_cancelled_preview_does_not_return_data() {
    let engine = engine_with_steps(vec![]);
    let token = CancellationToken::new();
    token.cancel();

    let error = engine
        .preview_transformations(&TransformPreviewRequest::new("Orders", vec![]), &token)
        .await
        .unwrap_err();
    assert!(error.to_string().contains("cancelled"), "got {error}");
}

#[tokio::test]
async fn preview_clamps_an_absurd_row_limit() {
    let engine = engine_with_steps(vec![]);
    let preview = engine
        .preview_transformations(
            &TransformPreviewRequest::new("Orders", vec![]).with_row_limit(usize::MAX),
            &CancellationToken::new(),
        )
        .await
        .unwrap();
    // The fixture only has four rows; the point is that clamping does not
    // panic or refuse.
    assert_eq!(preview.batch.num_rows(), 4);
    assert!(
        !preview.source_truncated,
        "the whole source fit in the sample"
    );
}

#[tokio::test]
async fn a_preview_reports_when_it_only_saw_part_of_the_source() {
    // The distinction a caller cannot infer: a filtering pipeline can leave an
    // output far under the cap even when the source was truncated, so judging
    // "is this a sample?" from the output row count under-reports exactly when
    // an aggregate is most likely to mislead.
    let engine = engine_with_steps(vec![]);

    let full = engine
        .preview_transformations(
            &TransformPreviewRequest::new("Orders", vec![]).with_row_limit(10),
            &CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(full.source_rows, 4);
    assert!(!full.source_truncated);

    // A limit below the source's four rows: the sample is partial, and a
    // filter that leaves one row must not disguise that.
    let partial = engine
        .preview_transformations(
            &TransformPreviewRequest::new(
                "Orders",
                vec![TransformStep::FilterRows {
                    condition: "id = 1".into(),
                }],
            )
            .with_row_limit(2),
            &CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(partial.source_rows, 2, "the probe row is trimmed back off");
    assert!(
        partial.source_truncated,
        "the source had more rows than were sampled"
    );
    assert_eq!(
        partial.batch.num_rows(),
        1,
        "the output is small, which is exactly why it cannot be the signal"
    );
}

// --- Interactions with the rest of the engine ---

#[tokio::test]
async fn a_transformed_table_cannot_be_direct_query() {
    // Auto-tiering probes DirectQuery dimensions and caches the rows it reads —
    // which would bypass the pipeline entirely. What keeps it away from a
    // transformed table is that such a table CANNOT be DirectQuery, so that is
    // what this asserts: model validation refuses the combination outright.
    //
    // (Asserting only `is_in_memory()` on a fixture that sets InMemory itself,
    // as this test first did, pins nothing — it would stay green if the rule
    // were removed. `auto_tier_candidates_skips_explicit_inmemory` covers the
    // skip itself against the real candidate-selection API.)
    let base = model_with_steps(vec![TransformStep::FilterRows {
        condition: "status = \"open\"".into(),
    }]);
    let mut tables = base.tables().to_vec();
    tables[0].set_storage_mode(StorageMode::DirectQuery);

    let error = base
        .with_tables(tables)
        .validate()
        .expect_err("a transformed DirectQuery table must be refused");
    let message = error.to_string();
    assert!(
        message.contains("InMemory"),
        "must say what is required: {message}"
    );
}

#[tokio::test]
async fn editing_steps_changes_the_tables_cache_identity() {
    // The disk cache keys on the schema hash; a values-only edit must still
    // change it, or yesterday's file would be reloaded for today's pipeline.
    let mut engine = engine_with_steps(vec![TransformStep::FilterRows {
        condition: "amount > 0".into(),
    }]);
    let before = engine.model().table("Orders").unwrap().schema_hash();

    engine
        .set_table_transformations(
            "Orders",
            vec![TransformStep::FilterRows {
                condition: "amount > 25".into(),
            }],
        )
        .unwrap();
    let after = engine.model().table("Orders").unwrap().schema_hash();
    assert_ne!(before, after);
}

#[tokio::test]
async fn a_step_expression_may_call_a_model_script_function() {
    // The escape hatch for logic the catalog cannot express must actually
    // reach the pipeline — which means the evaluator has to be handed the
    // engine's EFFECTIVE udf registry, not an empty one.
    let steps = vec![TransformStep::AddColumn {
        name: "doubled".into(),
        expression: "double_it(amount)".into(),
        data_type: Some(DataType::Float64),
    }];
    let derived = derive_pipeline_schema(
        "Orders",
        &source_columns(),
        &steps,
        &engine_core::transform::NoOtherTables,
    )
    .unwrap();
    let model = DataModel::builder()
        .add_source(PersistedSource::new(
            "src",
            SourceKind::InMemory,
            PersistedConnection::default(),
            PersistedAuthKind::Integrated,
        ))
        .add_table(
            Table::new("Orders", derived)
                .unwrap()
                .with_storage_mode(StorageMode::InMemory)
                .with_source_binding(
                    TableSourceBinding::new("src", "public", "orders")
                        .with_source_columns(source_columns())
                        .with_transformations(steps),
                ),
        )
        .add_script_function(
            crate::ScriptFunction::builder("double_it")
                .param("x", crate::ScriptType::Float)
                .returns(crate::ScriptType::Float)
                .body("x * 2.0")
                .build(),
        )
        .build()
        .unwrap();

    let mut engine = Engine::new(model);
    let source = InMemoryConnector::new().with_table("public", "orders", source_batch());
    let idx = engine.add_in_memory_source(source);
    engine.bind_table("Orders", idx, SourceBinding::new("public", "orders"));

    engine.refresh_table("Orders").await.unwrap();
    let batch = engine.cache().get("Orders").unwrap();
    let index = batch.schema().index_of("doubled").unwrap();
    let doubled = batch
        .column(index)
        .as_any()
        .downcast_ref::<Float64Array>()
        .expect("float column");
    assert_eq!(doubled.value(0), 20.0);
}

#[test]
fn wiring_restores_a_sql_source_query_from_the_model() {
    // Before the persisted binding carried `source_query`, reopening a model
    // with a SQL-source table silently re-pointed it at `schema.table`.
    let model = DataModel::builder()
        .add_source(PersistedSource::new(
            "src",
            SourceKind::InMemory,
            PersistedConnection::default(),
            PersistedAuthKind::Integrated,
        ))
        .add_table(
            Table::new("Recent", vec![Column::new("id", DataType::Int64)])
                .unwrap()
                .with_storage_mode(StorageMode::InMemory)
                .with_source_binding(
                    TableSourceBinding::new("src", "", "Recent")
                        .with_source_query("SELECT * FROM orders WHERE id > 2"),
                ),
        )
        .build()
        .unwrap();

    let json = serde_json::to_string(&model).unwrap();
    let reloaded: DataModel = serde_json::from_str(&json).unwrap();
    let binding = reloaded.table("Recent").unwrap().source_binding().unwrap();
    assert_eq!(
        binding.source_query.as_deref(),
        Some("SELECT * FROM orders WHERE id > 2")
    );
}

#[tokio::test]
async fn a_preview_of_a_transformed_table_derives_from_the_recorded_source_schema() {
    // A saved pipeline's preview must start from the SOURCE schema, not from
    // the table's (already transformed) columns — otherwise editing step 1 of
    // an existing pipeline would fail on columns it legitimately still has.
    let engine = engine_with_steps(vec![TransformStep::RemoveColumns {
        columns: vec!["status".into()],
    }]);

    let preview = engine
        .preview_transformations(
            &TransformPreviewRequest::new(
                "Orders",
                vec![
                    TransformStep::FilterRows {
                        // `status` exists in the SOURCE, though the saved
                        // pipeline removes it.
                        condition: "status <> \"cancelled\"".into(),
                    },
                    TransformStep::RemoveColumns {
                        columns: vec!["status".into()],
                    },
                ],
            ),
            &CancellationToken::new(),
        )
        .await
        .unwrap();
    assert_eq!(preview.batch.num_rows(), 3);
    assert_eq!(preview.batch.num_columns(), 2);
}

// --- Regressions for the adversarial review -------------------------------

#[tokio::test]
async fn rebinding_a_table_keeps_its_pipeline() {
    // REGRESSION: `bind_source_table` built a FRESH TableSourceBinding, which
    // zeroed transformations/source_columns/source_query. The stripped model
    // still validated (a table with no steps skips the pipeline checks), so the
    // next refresh silently served raw source rows in place of shaped ones.
    // `bind_source_table` needs the source registered under its catalog id, so
    // this fixture registers the connector by id rather than anonymously.
    let mut engine = Engine::new(model_with_steps(vec![TransformStep::FilterRows {
        condition: "status <> \"cancelled\"".into(),
    }]));
    let source = InMemoryConnector::new().with_table("public", "orders", source_batch());
    let idx = engine
        .registry_mut()
        .add_connector_with_id(Some("src".to_string()), source.into());
    engine.bind_table("Orders", idx, SourceBinding::new("public", "orders"));
    assert_eq!(engine.table_transformations("Orders").unwrap().len(), 1);
    let columns_before: Vec<String> = engine
        .model()
        .table("Orders")
        .unwrap()
        .columns()
        .iter()
        .map(|c| c.name().to_string())
        .collect();

    engine
        .bind_source_table("src", "public", "orders", Some("Orders"))
        .unwrap();

    assert_eq!(
        engine.table_transformations("Orders").unwrap().len(),
        1,
        "re-pointing a table at its source must not discard its steps"
    );
    assert!(
        !engine.table_source_columns("Orders").unwrap().is_empty(),
        "the pipeline's source anchor must survive too, or it cannot be checked"
    );
    let columns_after: Vec<String> = engine
        .model()
        .table("Orders")
        .unwrap()
        .columns()
        .iter()
        .map(|c| c.name().to_string())
        .collect();
    assert_eq!(columns_before, columns_after);

    // And the pipeline still actually runs.
    engine.refresh_table("Orders").await.unwrap();
    assert_eq!(engine.cache().get("Orders").unwrap().num_rows(), 3);
}

#[tokio::test]
async fn a_second_steps_edit_keeps_column_presentation_metadata() {
    // REGRESSION: derivation works from the recorded SOURCE schema, so metadata
    // the user set on the model table AFTER the pipeline existed was reverted
    // to the anchor-time snapshot by the next steps edit.
    let mut engine = engine_with_steps(vec![TransformStep::FilterRows {
        condition: "status <> \"cancelled\"".into(),
    }]);

    // Decorate a surviving column, the way the Tables tab does.
    let mut tables = engine.model().tables().to_vec();
    for column in tables[0].columns_mut() {
        if column.name() == "amount" {
            column.set_display_name(Some("Order Amount".to_string()));
            column.set_format_string(Some("#,##0.00".to_string()));
        }
    }
    let decorated = engine.model().with_tables(tables);
    engine.set_model(decorated).unwrap();

    // A SECOND edit to the pipeline.
    engine
        .set_table_transformations(
            "Orders",
            vec![
                TransformStep::FilterRows {
                    condition: "status <> \"cancelled\"".into(),
                },
                TransformStep::Sort {
                    by: vec![crate::SortKey::ascending("id")],
                },
            ],
        )
        .unwrap();

    let table = engine.model().table("Orders").unwrap();
    let amount = table.column("amount").unwrap();
    assert_eq!(
        amount.display_name(),
        Some("Order Amount"),
        "the user's display name must survive a later steps edit"
    );
    assert_eq!(amount.format_string(), Some("#,##0.00"));
}

#[tokio::test]
async fn a_preview_conforms_to_the_schema_its_steps_derive() {
    // REGRESSION: the preview returned raw pipeline output while a refresh
    // conforms, so an aggregate coming back wider than the step declares
    // rendered differently in the preview than it would once stored.
    let engine = engine_with_steps(vec![]);
    let candidate = vec![TransformStep::GroupBy {
        group_by: vec!["status".into()],
        aggregates: vec![crate::GroupAggregate::new(
            "amount",
            crate::AggregateOp::Median,
            "mid",
        )],
    }];
    let derived = crate::derive_pipeline_schema(
        "Orders",
        &source_columns(),
        &candidate,
        &engine_core::transform::NoOtherTables,
    )
    .unwrap();

    let preview = engine
        .preview_transformations(
            &TransformPreviewRequest::new("Orders", candidate),
            &CancellationToken::new(),
        )
        .await
        .unwrap();

    for (index, column) in derived.iter().enumerate() {
        let field = preview.batch.schema().field(index).clone();
        assert_eq!(field.name(), column.name());
        assert_eq!(
            field.data_type(),
            &column.data_type().to_arrow(),
            "preview column '{}' does not match the type its step derives",
            column.name()
        );
    }
}

// ---------------------------------------------------------------------------
// Cross-table lookups: refresh ordering, invalidation, failure isolation
// ---------------------------------------------------------------------------

/// `Customers`' declared columns.
fn customer_columns() -> Vec<Column> {
    vec![
        Column::new("customer_id", DataType::Int64),
        Column::new("customer_name", DataType::String),
    ]
}

/// Three customers, ids 1..3 — so `Orders` id 4 has no match.
fn customer_batch(names: [&str; 3]) -> RecordBatch {
    let schema = Arc::new(ArrowSchema::new(vec![
        Field::new("customer_id", ArrowType::Int64, true),
        Field::new("customer_name", ArrowType::Utf8, true),
    ]));
    RecordBatch::try_new(
        schema,
        vec![
            Arc::new(Int64Array::from(vec![1, 2, 3])),
            Arc::new(StringArray::from(names.to_vec())),
        ],
    )
    .unwrap()
}

fn lookup_step() -> TransformStep {
    TransformStep::LookupColumn {
        table: "Customers".into(),
        keys: vec![engine_core::transform::LookupKey::new("id", "customer_id")],
        takes: vec![engine_core::transform::LookupTake::new("customer_name")],
    }
}

/// A `Customers` table bound to the in-memory source.
fn customers_table() -> Table {
    Table::new("Customers", customer_columns())
        .unwrap()
        .with_storage_mode(StorageMode::InMemory)
        .with_source_binding(TableSourceBinding::new("src", "public", "customers"))
}

/// A model where `Orders` looks up `Customers`.
///
/// `Orders` is added FIRST on purpose: model order is then the WRONG refresh
/// order, so anything that walks tables as declared reads an empty target.
fn model_with_lookup(steps: Vec<TransformStep>) -> DataModel {
    let customers = customers_table();
    let catalog = vec![customers.clone()];
    let derived = derive_pipeline_schema(
        "Orders",
        &source_columns(),
        &steps,
        &engine_core::transform::ModelTableSchemas::new(&catalog),
    )
    .expect("test steps must derive");
    let binding = TableSourceBinding::new("src", "public", "orders")
        .with_source_columns(source_columns())
        .with_transformations(steps);
    DataModel::builder()
        .add_source(PersistedSource::new(
            "src",
            SourceKind::InMemory,
            PersistedConnection::default(),
            PersistedAuthKind::Integrated,
        ))
        .add_table(
            Table::new("Orders", derived)
                .unwrap()
                .with_storage_mode(StorageMode::InMemory)
                .with_source_binding(binding),
        )
        .add_table(customers)
        .build()
        .expect("test model must build")
}

/// An engine over the two-table model, both tables served in-memory.
fn engine_with_lookup(names: [&str; 3]) -> Engine {
    let mut engine = Engine::new(model_with_lookup(vec![lookup_step()]));
    bind_both(&mut engine, names);
    engine
}

/// Point both tables at one in-memory connector.
fn bind_both(engine: &mut Engine, names: [&str; 3]) {
    let source = InMemoryConnector::new()
        .with_table("public", "orders", source_batch())
        .with_table("public", "customers", customer_batch(names));
    let idx = engine.add_in_memory_source(source);
    engine.bind_table("Orders", idx, SourceBinding::new("public", "orders"));
    engine.bind_table("Customers", idx, SourceBinding::new("public", "customers"));
}

/// The joined `customer_name` column of the cached `Orders`.
fn joined_names(engine: &Engine) -> Vec<Option<String>> {
    let batch = engine.cache().get("Orders").expect("Orders must be cached");
    let index = batch
        .schema()
        .index_of("customer_name")
        .expect("the lookup must have added the column");
    let column = batch.column(index);
    // `optimize_batch` may dictionary-encode a low-cardinality string column,
    // so read through a cast rather than downcasting to StringArray.
    let plain = arrow::compute::cast(column, &ArrowType::Utf8).unwrap();
    let values = plain.as_any().downcast_ref::<StringArray>().unwrap();
    (0..values.len())
        .map(|i| {
            if values.is_null(i) {
                None
            } else {
                Some(values.value(i).to_string())
            }
        })
        .collect()
}

/// Eight customers whose names repeat across only three distinct values, so
/// the optimizer's cardinality ratio (3/8) is under its 0.5 threshold and the
/// column is actually dictionary-encoded on the way into the cache.
fn low_cardinality_customers() -> RecordBatch {
    let schema = Arc::new(ArrowSchema::new(vec![
        Field::new("customer_id", ArrowType::Int64, true),
        Field::new("customer_name", ArrowType::Utf8, true),
    ]));
    RecordBatch::try_new(
        schema,
        vec![
            Arc::new(Int64Array::from(vec![1, 2, 3, 4, 5, 6, 7, 8])),
            Arc::new(StringArray::from(vec![
                "open",
                "cancelled",
                "open",
                "closed",
                "open",
                "cancelled",
                "closed",
                "open",
            ])),
        ],
    )
    .unwrap()
}

#[tokio::test]
async fn a_lookup_matches_on_a_dictionary_encoded_key() {
    // The cached target is NOT the batch that was fetched: `optimize_batch`
    // narrows and dictionary-encodes it on the way into the cache. So the join
    // runs against a physically different array type than any engine-core unit
    // test ever sees, and a key comparison that only worked on plain Utf8
    // would fail here and nowhere else.
    //
    // The optimizer skips batches under 1024 rows, so the threshold is lowered
    // rather than the fixture inflated to four figures — inflating it would
    // hide WHICH property the test depends on.
    let mut engine = Engine::new(model_with_lookup(vec![TransformStep::LookupColumn {
        table: "Customers".into(),
        // A STRING key, so the encoding is on the column being MATCHED rather
        // than only on one carried across.
        keys: vec![engine_core::transform::LookupKey::new(
            "status",
            "customer_name",
        )],
        takes: vec![engine_core::transform::LookupTake::renamed(
            "customer_id",
            "status_code",
        )],
    }]));
    engine.set_optimizer_config(crate::OptimizerConfig {
        min_rows_to_analyze: 1,
        ..Default::default()
    });
    let source = InMemoryConnector::new()
        .with_table("public", "orders", source_batch())
        .with_table("public", "customers", low_cardinality_customers());
    let idx = engine.add_in_memory_source(source);
    engine.bind_table("Orders", idx, SourceBinding::new("public", "orders"));
    engine.bind_table("Customers", idx, SourceBinding::new("public", "customers"));

    engine.refresh_all_in_memory().await.unwrap();

    // Non-vacuity: if the optimizer ever stopped encoding this column, the
    // test would silently go back to proving what engine-core already proves.
    let cached = engine.cache().get("Customers").unwrap();
    let index = cached.schema().index_of("customer_name").unwrap();
    assert!(
        matches!(
            cached.schema().field(index).data_type(),
            ArrowType::Dictionary(_, _)
        ),
        "the target's key column must actually be dictionary-encoded here, or \
         this test proves nothing: {:?}",
        cached.schema().field(index).data_type()
    );

    let batch = engine.cache().get("Orders").unwrap();
    let column = batch
        .schema()
        .index_of("status_code")
        .expect("the lookup must have added the column");
    let plain = arrow::compute::cast(batch.column(column), &ArrowType::Int64).unwrap();
    let values = plain.as_any().downcast_ref::<Int64Array>().unwrap();
    // Each status matches several customers, so MIN decides: open -> 1,
    // cancelled -> 2, closed -> 4. Orders read open, cancelled, open, closed.
    assert_eq!(batch.num_rows(), 4, "dedup must survive the encoding too");
    assert_eq!(
        (0..values.len())
            .map(|i| values.value(i))
            .collect::<Vec<_>>(),
        vec![1, 2, 1, 4]
    );
}

#[tokio::test]
async fn a_refresh_joins_the_other_tables_rows() {
    let mut engine = engine_with_lookup(["Ann", "Bob", "Cal"]);
    engine.refresh_all_in_memory().await.unwrap();

    assert_eq!(
        joined_names(&engine),
        vec![
            Some("Ann".to_string()),
            Some("Bob".to_string()),
            Some("Cal".to_string()),
            None
        ],
        "order 4 has no customer, so its name is null — not a dropped row"
    );
    assert_eq!(engine.cache().get("Orders").unwrap().num_rows(), 4);
}

#[tokio::test]
async fn refresh_all_stores_the_target_before_the_dependent_transforms() {
    // The ordering guard. `Orders` is declared BEFORE `Customers`, so a phase
    // that walks model order transforms `Orders` while `Customers` is still
    // uncached — and a lookup with no target rows yields all-NULL, silently.
    let mut engine = engine_with_lookup(["Ann", "Bob", "Cal"]);
    assert_eq!(
        engine
            .model()
            .tables()
            .iter()
            .map(|t| t.name())
            .collect::<Vec<_>>(),
        vec!["Orders", "Customers"],
        "the fixture must declare the dependent first or this proves nothing"
    );

    // Not unwrapped: out of order the dependent transforms against a target
    // that is not in the cache yet, and `step_inputs_for` leaves an uncached
    // dependency OUT — so the failure arrives as "unknown lookup table",
    // which an unwrap would report as a bare panic rather than as this.
    let outcome = engine.refresh_all_in_memory().await;
    assert!(
        outcome.is_ok(),
        "the target must be stored before the dependent transforms, but the \
         refresh failed: {:?}",
        outcome.err()
    );
    assert!(
        joined_names(&engine).iter().any(Option::is_some),
        "the target's rows must be the ones joined, not an empty target"
    );
}

#[tokio::test]
async fn refreshing_only_the_dependent_loads_an_uncached_target() {
    // The owner's decision: a cold target is fetched depth-first rather than
    // joined as nothing. Otherwise the first refresh after opening a file
    // produces a column of NULLs that looks exactly like real "no match" data.
    let mut engine = engine_with_lookup(["Ann", "Bob", "Cal"]);
    assert!(engine.cache().get("Customers").is_none());

    engine.refresh_table("Orders").await.unwrap();

    assert!(
        engine.cache().get("Customers").is_some(),
        "the target must have been fetched on the way"
    );
    assert_eq!(joined_names(&engine)[0], Some("Ann".to_string()));
}

#[tokio::test]
async fn refresh_stale_recomputes_a_dependent_after_the_target_moved_in_an_earlier_call() {
    // Cross-run staleness. `Orders`' own source never changes and it has no
    // refresh strategies, so every timestamp and fingerprint says "fresh".
    // Only the target's cache GENERATION can reveal that its joined column is
    // now wrong — and the in-run "refreshed just now" set is long gone.
    let mut engine = engine_with_lookup(["Ann", "Bob", "Cal"]);
    engine.refresh_all_in_memory().await.unwrap();
    assert_eq!(joined_names(&engine)[0], Some("Ann".to_string()));

    // A separate call refreshes ONLY the target, with new names.
    bind_both(&mut engine, ["Ada", "Bo", "Cy"]);
    engine.refresh_table("Customers").await.unwrap();
    assert_eq!(
        joined_names(&engine)[0],
        Some("Ann".to_string()),
        "Orders still holds the old join at this point"
    );

    let report = engine.refresh_stale().await.unwrap();
    assert!(
        report.refreshed.iter().any(|t| t == "Orders"),
        "Orders must be recomputed: {:?}",
        report.refreshed
    );
    assert_eq!(joined_names(&engine)[0], Some("Ada".to_string()));
}

#[tokio::test]
async fn refresh_stale_leaves_an_ordinary_table_alone_once_it_is_fresh() {
    // The non-vacuity companion to the test above: the generation check must
    // not make every lookup table permanently stale, or refresh_stale would
    // re-fetch the whole chain on every call forever.
    let mut engine = engine_with_lookup(["Ann", "Bob", "Cal"]);
    engine.refresh_all_in_memory().await.unwrap();

    let report = engine.refresh_stale().await.unwrap();
    assert!(
        report.refreshed.is_empty(),
        "nothing changed, so nothing should refresh: {:?}",
        report.refreshed
    );
    assert!(report.skipped.is_empty());
}

/// The same two-table model, but `Customers` is bound to a source table that
/// does not exist — so its refresh fails while `Orders`' own fetch works.
fn engine_with_a_broken_target() -> Engine {
    let mut engine = Engine::new(model_with_lookup(vec![lookup_step()]));
    let source = InMemoryConnector::new()
        .with_table("public", "orders", source_batch())
        .with_table("public", "customers", customer_batch(["Ann", "Bob", "Cal"]));
    let idx = engine.add_in_memory_source(source);
    engine.bind_table("Orders", idx, SourceBinding::new("public", "orders"));
    engine.bind_table("Customers", idx, SourceBinding::new("public", "missing"));
    engine
}

#[tokio::test]
async fn a_target_that_fails_makes_its_dependent_a_named_skip_not_a_silent_success() {
    // Failure isolation, inverted. Refreshing `Orders` against the target's
    // PREVIOUS rows would succeed and be reported as refreshed — a wrong
    // answer wearing a green badge. It must be skipped, and the report must
    // name the table holding it back.
    let mut engine = engine_with_a_broken_target();

    let report = engine.refresh_stale().await.unwrap();

    assert!(
        report.failures.iter().any(|f| f.table == "Customers"),
        "the target's own failure must be reported: {:?}",
        report.failures
    );
    assert!(
        !report.refreshed.iter().any(|t| t == "Orders"),
        "Orders must NOT be reported refreshed: {:?}",
        report.refreshed
    );
    let skip = report
        .skipped
        .iter()
        .find(|s| s.table == "Orders")
        .expect("Orders must be reported as skipped, not merely absent");
    assert_eq!(skip.blocked_by, "Customers");
    assert!(
        skip.detail.contains("Customers"),
        "the reason must name the blocking table: {}",
        skip.detail
    );
}

#[tokio::test]
async fn a_target_that_succeeds_lets_its_dependent_refresh() {
    // The positive control for the test above: the skip must come from the
    // failure, not from having a lookup at all.
    let mut engine = engine_with_lookup(["Ann", "Bob", "Cal"]);
    let report = engine.refresh_stale().await.unwrap();

    assert!(report.failures.is_empty(), "{:?}", report.failures);
    assert!(report.skipped.is_empty(), "{:?}", report.skipped);
    assert!(report.refreshed.iter().any(|t| t == "Orders"));
    assert!(report.refreshed.iter().any(|t| t == "Customers"));
    assert_eq!(joined_names(&engine)[0], Some("Ann".to_string()));
}

#[tokio::test]
async fn editing_a_targets_pipeline_drops_the_dependents_cache_too() {
    // `Orders`' cached rows were computed FROM `Customers`. Reshaping
    // `Customers` makes them the wrong rows, not merely stale ones, so they
    // must go — otherwise a query keeps serving a join against a shape that
    // no longer exists.
    let mut engine = engine_with_lookup(["Ann", "Bob", "Cal"]);
    engine.refresh_all_in_memory().await.unwrap();
    assert!(engine.cache().get("Orders").is_some());
    assert!(engine.cache().get("Customers").is_some());

    engine
        .set_table_transformations(
            "Customers",
            vec![TransformStep::RenameColumns {
                renames: vec![ColumnRename::new("customer_name", "customer_name")],
            }],
        )
        .expect("a no-op rename is still an edit");

    assert!(
        engine.cache().get("Customers").is_none(),
        "the edited table's own cache must go"
    );
    assert!(
        engine.cache().get("Orders").is_none(),
        "and so must every table computed from it"
    );
}

/// A three-table chain: `Summary` looks up `Orders`, which looks up
/// `Customers`. Declared in exactly the wrong order, worst-first.
fn model_with_lookup_chain() -> DataModel {
    let customers = customers_table();
    let orders_steps = vec![lookup_step()];
    let orders_columns = derive_pipeline_schema(
        "Orders",
        &source_columns(),
        &orders_steps,
        &engine_core::transform::ModelTableSchemas::new(std::slice::from_ref(&customers)),
    )
    .unwrap();
    let orders = Table::new("Orders", orders_columns)
        .unwrap()
        .with_storage_mode(StorageMode::InMemory)
        .with_source_binding(
            TableSourceBinding::new("src", "public", "orders")
                .with_source_columns(source_columns())
                .with_transformations(orders_steps),
        );

    let summary_steps = vec![TransformStep::LookupColumn {
        table: "Orders".into(),
        keys: vec![engine_core::transform::LookupKey::new("id", "id")],
        takes: vec![engine_core::transform::LookupTake::new("customer_name")],
    }];
    let catalog = vec![customers.clone(), orders.clone()];
    let summary_columns = derive_pipeline_schema(
        "Summary",
        &source_columns(),
        &summary_steps,
        &engine_core::transform::ModelTableSchemas::new(&catalog),
    )
    .unwrap();
    let summary = Table::new("Summary", summary_columns)
        .unwrap()
        .with_storage_mode(StorageMode::InMemory)
        .with_source_binding(
            TableSourceBinding::new("src", "public", "orders")
                .with_source_columns(source_columns())
                .with_transformations(summary_steps),
        );

    DataModel::builder()
        .add_source(PersistedSource::new(
            "src",
            SourceKind::InMemory,
            PersistedConnection::default(),
            PersistedAuthKind::Integrated,
        ))
        .add_table(summary)
        .add_table(orders)
        .add_table(customers)
        .build()
        .expect("a chain is not a cycle")
}

fn engine_with_lookup_chain() -> Engine {
    let mut engine = Engine::new(model_with_lookup_chain());
    let source = InMemoryConnector::new()
        .with_table("public", "orders", source_batch())
        .with_table("public", "customers", customer_batch(["Ann", "Bob", "Cal"]));
    let idx = engine.add_in_memory_source(source);
    engine.bind_table("Orders", idx, SourceBinding::new("public", "orders"));
    engine.bind_table("Summary", idx, SourceBinding::new("public", "orders"));
    engine.bind_table("Customers", idx, SourceBinding::new("public", "customers"));
    engine
}

#[tokio::test]
async fn a_two_hop_chain_refreshes_bottom_up() {
    // Declared Summary, Orders, Customers — the exact reverse of the order
    // they must run in. A single reverse-edge hop is not enough here: the
    // walk has to reach all the way down.
    let mut engine = engine_with_lookup_chain();
    let outcome = engine.refresh_all_in_memory().await;
    assert!(outcome.is_ok(), "{:?}", outcome.err());

    for table in ["Customers", "Orders", "Summary"] {
        assert!(
            engine.cache().get(table).is_some(),
            "{table} must be cached"
        );
    }
    // The name travelled two hops: Customers -> Orders -> Summary.
    let summary = engine.cache().get("Summary").unwrap();
    let index = summary.schema().index_of("customer_name").unwrap();
    let plain = arrow::compute::cast(summary.column(index), &ArrowType::Utf8).unwrap();
    let values = plain.as_any().downcast_ref::<StringArray>().unwrap();
    assert_eq!(values.value(0), "Ann");
}

#[tokio::test]
async fn editing_the_bottom_of_a_chain_invalidates_every_table_above_it() {
    // The transitivity guard. Editing `Customers` makes `Orders`' cached rows
    // wrong, which makes `Summary`'s cached rows wrong in turn. A drop walk
    // that follows one reverse edge and stops leaves `Summary` serving a join
    // against a shape that no longer exists.
    let mut engine = engine_with_lookup_chain();
    engine.refresh_all_in_memory().await.unwrap();

    engine
        .set_table_transformations(
            "Customers",
            vec![TransformStep::RenameColumns {
                renames: vec![ColumnRename::new("customer_name", "customer_name")],
            }],
        )
        .expect("a no-op rename is still an edit");

    assert!(
        engine.cache().get("Customers").is_none(),
        "the edited table"
    );
    assert!(engine.cache().get("Orders").is_none(), "one hop up");
    assert!(
        engine.cache().get("Summary").is_none(),
        "TWO hops up — the reverse-edge walk must be transitive, not one-step"
    );
}

#[tokio::test]
async fn an_edit_that_closes_a_cycle_is_refused_and_the_old_model_stands() {
    // `Orders` already looks up `Customers`. Pointing `Customers` back at
    // `Orders` closes the loop — neither could ever be refreshed first.
    let mut engine = engine_with_lookup(["Ann", "Bob", "Cal"]);
    engine.refresh_all_in_memory().await.unwrap();

    let error = engine
        .set_table_transformations(
            "Customers",
            vec![TransformStep::LookupColumn {
                table: "Orders".into(),
                keys: vec![engine_core::transform::LookupKey::new("customer_id", "id")],
                takes: vec![engine_core::transform::LookupTake::new("status")],
            }],
        )
        .unwrap_err()
        .to_string();

    assert!(error.contains("cycle"), "must say what is wrong: {error}");
    assert!(
        error.contains("Orders") && error.contains("Customers"),
        "must name the members: {error}"
    );

    // "The model is left untouched in every failure case" is the documented
    // contract, and the cache is part of what untouched means.
    assert!(
        engine
            .table_transformations("Customers")
            .unwrap()
            .is_empty(),
        "the refused pipeline must not be installed"
    );
    assert!(
        engine.cache().get("Orders").is_some(),
        "a refused edit must not invalidate anything"
    );
    assert_eq!(joined_names(&engine)[0], Some("Ann".to_string()));
}

#[test]
fn a_model_whose_pipelines_form_a_cycle_fails_to_build() {
    // The load-time gate. A hand-edited or hostile model file must be refused
    // outright rather than half-refreshed — `refresh_all_in_memory` would
    // otherwise have no first table to start from.
    let a_columns = vec![
        Column::new("id", DataType::Int64),
        Column::new("b_value", DataType::String),
    ];
    let b_columns = vec![
        Column::new("id", DataType::Int64),
        Column::new("a_value", DataType::String),
    ];
    let a = Table::new("A", a_columns.clone())
        .unwrap()
        .with_storage_mode(StorageMode::InMemory)
        .with_source_binding(
            TableSourceBinding::new("src", "public", "a")
                .with_source_columns(vec![Column::new("id", DataType::Int64)])
                .with_transformations(vec![TransformStep::LookupColumn {
                    table: "B".into(),
                    keys: vec![engine_core::transform::LookupKey::new("id", "id")],
                    takes: vec![engine_core::transform::LookupTake::renamed(
                        "a_value", "b_value",
                    )],
                }]),
        );
    let b = Table::new("B", b_columns)
        .unwrap()
        .with_storage_mode(StorageMode::InMemory)
        .with_source_binding(
            TableSourceBinding::new("src", "public", "b")
                .with_source_columns(vec![Column::new("id", DataType::Int64)])
                .with_transformations(vec![TransformStep::LookupColumn {
                    table: "A".into(),
                    keys: vec![engine_core::transform::LookupKey::new("id", "id")],
                    takes: vec![engine_core::transform::LookupTake::renamed(
                        "b_value", "a_value",
                    )],
                }]),
        );

    let error = DataModel::builder()
        .add_source(PersistedSource::new(
            "src",
            SourceKind::InMemory,
            PersistedConnection::default(),
            PersistedAuthKind::Integrated,
        ))
        .add_table(a)
        .add_table(b)
        .build()
        .expect_err("a cycle must not build")
        .to_string();
    assert!(error.contains('A') && error.contains('B'), "{error}");
}
