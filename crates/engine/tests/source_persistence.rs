//! Integration tests for persisted multi-source bindings (model format v14).
//!
//! Deterministic: everything runs over an [`InMemoryConnector`] (no Docker, no
//! network). They prove a composite model can be authored, saved, reopened, and
//! reconnected — and then queried — **without any manual `bind_table` call**,
//! and that the persisted descriptors carry no secrets.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use arrow::array::Float64Array;
use arrow::datatypes::{DataType as ArrowType, Field, Schema};
use arrow::record_batch::RecordBatch;

use bi_engine::{
    sum_measure, AuthMethod, Column, DataModel, DataType, Engine, InMemoryConnector,
    PersistedAuthKind, PersistedConnection, PersistedSource, QueryError, QueryRequest,
    SourceCredential, SourceKind, StorageMode, Table, TableSourceBinding, MODEL_FORMAT_VERSION,
};

/// A unique temp-file path so parallel tests never collide.
fn temp_model_path(name: &str) -> PathBuf {
    let path = std::env::temp_dir().join(format!("calcula_source_persist_{name}.model.json"));
    let _ = std::fs::remove_file(&path);
    path
}

/// `Sales(amount)` batch summing to 190.0.
fn sales_batch() -> RecordBatch {
    RecordBatch::try_new(
        Arc::new(Schema::new(vec![Field::new(
            "amount",
            ArrowType::Float64,
            true,
        )])),
        vec![Arc::new(Float64Array::from(vec![100.0, 40.0, 30.0, 20.0]))],
    )
    .unwrap()
}

/// A fresh in-memory connector serving the `Sales` batch at `public.sales`.
/// The data lives in the host, so it must be re-supplied at wire time.
fn sales_connector() -> InMemoryConnector {
    InMemoryConnector::new().with_table("public", "sales", sales_batch())
}

/// Model with one in-memory `Sales` table and a `Revenue = SUM(Sales[amount])`
/// measure. No source binding yet — the composite API adds it.
fn sales_model() -> DataModel {
    DataModel::builder()
        .add_table(
            Table::new("Sales", vec![Column::new("amount", DataType::Float64)])
                .unwrap()
                .with_storage_mode(StorageMode::InMemory),
        )
        .add_measure(sum_measure("Revenue", "Sales", "amount"))
        .build()
        .unwrap()
}

/// Read the single scalar `Revenue` value from a no-group-by result.
fn scalar_revenue(batches: &[RecordBatch]) -> f64 {
    let batch = &batches[0];
    let idx = batch.schema().index_of("Revenue").unwrap();
    batch
        .column(idx)
        .as_any()
        .downcast_ref::<Float64Array>()
        .expect("Revenue is Float64")
        .value(0)
}

#[test]
fn builder_save_load_round_trips_sources_and_binding() {
    let model = DataModel::builder()
        .add_table(
            Table::new("Sales", vec![Column::new("amount", DataType::Float64)])
                .unwrap()
                .with_source_binding(TableSourceBinding::new(
                    "sales_pg",
                    "sales",
                    "salesorderheader",
                )),
        )
        .add_source(PersistedSource::new(
            "sales_pg",
            SourceKind::Postgres,
            PersistedConnection {
                host: "db01".into(),
                port: Some(5432),
                database: "warehouse".into(),
                default_schema: Some("sales".into()),
                trust_server_certificate: false,
            },
            PersistedAuthKind::UsernamePassword,
        ))
        .build()
        .unwrap();

    let engine = Engine::new(model);
    let path = temp_model_path("round_trip");
    engine.save_model(&path).unwrap();

    // The on-disk file records the source and binding — but no credentials.
    // (The auth *kind* hint is legitimately "username_password"; assert there is
    // no quoted `"password"` / `"username"` key or value carrying a secret.)
    let json = std::fs::read_to_string(&path).unwrap();
    assert!(json.contains("sales_pg"));
    assert!(json.contains("salesorderheader"));
    assert!(
        json.contains("username_password"),
        "auth kind hint is recorded"
    );
    assert!(!json.contains("\"password\""));
    assert!(!json.contains("\"username\""));

    let loaded = Engine::load_model(&path).unwrap();
    assert_eq!(loaded.format_version(), MODEL_FORMAT_VERSION);
    assert_eq!(loaded.sources().len(), 1);
    let src = loaded.source("sales_pg").expect("source preserved");
    assert_eq!(src.kind, SourceKind::Postgres);
    assert_eq!(src.connection.database, "warehouse");
    assert_eq!(src.preferred_auth, PersistedAuthKind::UsernamePassword);
    let binding = loaded.table("Sales").unwrap().source_binding().unwrap();
    assert_eq!(binding.source_id, "sales_pg");
    assert_eq!(binding.schema, "sales");
    assert_eq!(binding.table, "salesorderheader");

    let _ = std::fs::remove_file(&path);
}

#[test]
fn pre_v14_model_without_sources_loads_with_empty_catalog() {
    // A file predating the sources catalog: no `sources` key, table has no
    // `source_binding`. Additive fields default, so it loads unchanged.
    let path = temp_model_path("pre_v14");
    let json = r#"{
        "format_version": 13,
        "tables": [{ "name": "Sales", "columns": [
            { "name": "amount", "data_type": "Float64", "nullable": true }
        ]}],
        "relationships": [],
        "measures": [],
        "calculated_columns": [],
        "measure_groups": []
    }"#;
    std::fs::write(&path, json).unwrap();

    let loaded = Engine::load_model(&path).unwrap();
    assert_eq!(loaded.format_version(), 13);
    assert!(loaded.sources().is_empty());
    assert!(loaded.table("Sales").unwrap().source_binding().is_none());

    let _ = std::fs::remove_file(&path);
}

#[tokio::test]
async fn composite_api_wire_and_query_without_manual_bind() {
    // Author: register an in-memory source under an id and bind the table
    // through the composite API (records the persisted catalog + binding).
    let mut engine = Engine::new(sales_model());
    engine
        .add_in_memory_source_with_id("sales_mem", sales_connector())
        .unwrap();
    engine
        .bind_source_table("sales_mem", "public", "sales", Some("Sales"))
        .unwrap();

    let path = temp_model_path("wire_query");
    engine.save_model(&path).unwrap();

    // Reopen in a fresh engine: load carries the catalog + binding, but opens
    // no connection. wire_sources reconnects (host re-supplies the data).
    let model = Engine::load_model(&path).unwrap();
    let mut reopened = Engine::new(model);
    let report = reopened
        .wire_sources(|src| {
            assert_eq!(src.id, "sales_mem");
            SourceCredential::Connector(sales_connector().into())
        })
        .await
        .unwrap();
    assert_eq!(report.wired, vec!["sales_mem".to_string()]);
    assert_eq!(report.bound_tables, vec!["Sales".to_string()]);
    assert!(report.unbound_tables.is_empty());

    // Refresh the in-memory table from its wired connector, then query — no
    // manual bind_table anywhere in this test.
    reopened.refresh_table("Sales").await.unwrap();
    let result = reopened
        .query(QueryRequest {
            measures: vec!["Revenue".into()],
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(scalar_revenue(&result), 190.0);

    let _ = std::fs::remove_file(&path);
}

#[tokio::test]
async fn skipped_source_leaves_table_unbound_and_fails_closed() {
    let mut engine = Engine::new(sales_model());
    engine
        .add_in_memory_source_with_id("sales_mem", sales_connector())
        .unwrap();
    engine
        .bind_source_table("sales_mem", "public", "sales", Some("Sales"))
        .unwrap();
    let path = temp_model_path("skip");
    engine.save_model(&path).unwrap();

    let model = Engine::load_model(&path).unwrap();
    let mut reopened = Engine::new(model);
    let report = reopened
        .wire_sources(|_src| SourceCredential::Skip)
        .await
        .unwrap();
    assert_eq!(report.skipped, vec!["sales_mem".to_string()]);
    assert_eq!(report.unbound_tables, vec!["Sales".to_string()]);
    assert!(report.bound_tables.is_empty());

    // Querying the unbound table fails closed rather than returning wrong data.
    let err = reopened
        .query(QueryRequest {
            measures: vec!["Revenue".into()],
            ..Default::default()
        })
        .await
        .unwrap_err();
    assert!(
        matches!(err, QueryError::SourceNotRegistered(ref t) if t == "Sales"),
        "expected SourceNotRegistered(Sales), got {err:?}"
    );

    let _ = std::fs::remove_file(&path);
}

#[test]
fn duplicate_source_id_is_rejected() {
    let mut engine = Engine::new(sales_model());
    engine
        .add_in_memory_source_with_id("dup", sales_connector())
        .unwrap();
    let err = engine
        .add_in_memory_source_with_id("dup", sales_connector())
        .unwrap_err();
    assert!(
        matches!(err, bi_engine::EngineError::DuplicateName(_)),
        "expected DuplicateName, got {err:?}"
    );
}

#[tokio::test]
async fn wire_sources_with_auth_skips_in_memory_source() {
    let mut engine = Engine::new(sales_model());
    engine
        .add_in_memory_source_with_id("sales_mem", sales_connector())
        .unwrap();
    engine
        .bind_source_table("sales_mem", "public", "sales", Some("Sales"))
        .unwrap();
    let path = temp_model_path("with_auth");
    engine.save_model(&path).unwrap();

    let model = Engine::load_model(&path).unwrap();
    let mut reopened = Engine::new(model);
    // An in-memory source cannot be rebuilt from auth — it is skipped and
    // reported, never errored.
    let auth: HashMap<String, AuthMethod> = HashMap::new();
    let report = reopened.wire_sources_with_auth(&auth).await.unwrap();
    assert_eq!(report.skipped, vec!["sales_mem".to_string()]);
    assert!(report.wired.is_empty());

    let _ = std::fs::remove_file(&path);
}
