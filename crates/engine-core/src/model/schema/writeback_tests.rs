//! Writeback-column synthesis at model build: store tables + generated
//! lookup column, idempotent reconcile, and the validation gates.

use crate::model::column::Column;
use crate::model::table::{StorageMode, Table};
use crate::model::writeback_column::{WritebackColumn, WritebackProjection};
use crate::model::DataModel;
use crate::types::DataType;

fn host_table() -> Table {
    Table::new(
        "dim_customer",
        vec![
            Column::new("ID", DataType::Int64),
            Column::new("Name", DataType::String),
            Column::new("Rating", DataType::Float64),
        ],
    )
    .unwrap()
    .with_storage_mode(StorageMode::InMemory)
}

fn wb() -> WritebackColumn {
    WritebackColumn::new(
        "wb-forecast-1",
        "Forecast",
        "dim_customer",
        DataType::Float64,
        vec!["ID".to_string()],
    )
}

#[test]
fn build_synthesizes_stores_and_generated_column() {
    let model = DataModel::builder()
        .add_table(host_table())
        .add_writeback_column(wb())
        .build()
        .unwrap();

    // Both store tables exist, marked + hidden, InMemory (names use the
    // hyphen-stripped id so they stay single parser tokens).
    let hist = model.table("__wb_wbforecast1_hist").unwrap();
    assert!(hist.is_writeback_store() && hist.is_hidden() && hist.is_in_memory());
    let hist_cols: Vec<&str> = hist.columns().iter().map(|c| c.name()).collect();
    assert_eq!(
        hist_cols,
        vec![
            "ID",
            "value",
            "submitter_id",
            "submitter_name",
            "submitted_at",
            "state"
        ]
    );
    let cur = model.table("__wb_wbforecast1").unwrap();
    assert!(cur.is_writeback_store() && cur.is_hidden());
    let cur_cols: Vec<&str> = cur.columns().iter().map(|c| c.name()).collect();
    assert_eq!(cur_cols, vec!["ID", "value"]);

    // The generated lookup column exists on the host, marked generated_by.
    let generated = model
        .calculated_columns()
        .iter()
        .find(|c| c.name() == "Forecast")
        .expect("generated column present");
    assert_eq!(generated.table(), "dim_customer");
    assert_eq!(generated.generated_by(), Some("wb-forecast-1"));
    assert!(generated.is_cross_table());

    // The definition round-trips serde and the model still validates
    // (idempotent replay: validate() re-runs synthesis via the builder).
    let json = serde_json::to_string(&model).unwrap();
    let back: DataModel = serde_json::from_str(&json).unwrap();
    back.validate().unwrap();
    assert_eq!(back.writeback_columns().len(), 1);
    assert!(back.table("__wb_wbforecast1_hist").is_ok());
}

#[test]
fn expose_history_unhides_with_display_name() {
    let model = DataModel::builder()
        .add_table(host_table())
        .add_writeback_column(wb().with_expose_history(true))
        .build()
        .unwrap();
    let hist = model.table("__wb_wbforecast1_hist").unwrap();
    assert!(!hist.is_hidden());
    assert_eq!(hist.display_name(), Some("dim_customer Forecast History"));
    // The current table stays hidden regardless.
    assert!(model.table("__wb_wbforecast1").unwrap().is_hidden());
}

#[test]
fn with_writeback_columns_reconciles_add_and_remove() {
    let model = DataModel::builder()
        .add_table(host_table())
        .build()
        .unwrap();

    let with = model.with_writeback_columns(vec![wb()]).unwrap();
    with.validate().unwrap();
    assert!(with.table("__wb_wbforecast1").is_ok());
    assert!(with
        .calculated_columns()
        .iter()
        .any(|c| c.generated_by() == Some("wb-forecast-1")));

    // Removing the definition drops the synthesized artifacts.
    let without = with.with_writeback_columns(Vec::new()).unwrap();
    without.validate().unwrap();
    assert!(without.table("__wb_wbforecast1").is_err());
    assert!(without.table("__wb_wbforecast1_hist").is_err());
    assert!(!without
        .calculated_columns()
        .iter()
        .any(|c| c.generated_by().is_some()));
    assert!(without.writeback_columns().is_empty());
}

#[test]
fn validation_gates() {
    // Host table must exist.
    assert!(DataModel::builder()
        .add_writeback_column(wb())
        .build()
        .is_err());

    // Host must be InMemory (v1).
    let dq_host = Table::new("dim_customer", vec![Column::new("ID", DataType::Int64)])
        .unwrap()
        .with_storage_mode(StorageMode::DirectQuery);
    assert!(DataModel::builder()
        .add_table(dq_host)
        .add_writeback_column(wb())
        .build()
        .is_err());

    // Key column must exist on the host.
    let mut missing_key = wb();
    missing_key = WritebackColumn::new(
        missing_key.id(),
        missing_key.name(),
        missing_key.table(),
        DataType::Float64,
        vec!["NoSuchColumn".to_string()],
    );
    assert!(DataModel::builder()
        .add_table(host_table())
        .add_writeback_column(missing_key)
        .build()
        .is_err());

    // Key columns are Int64/String only in v1 (Rating is Float64).
    let float_key = WritebackColumn::new(
        "wb-float-key",
        "Forecast",
        "dim_customer",
        DataType::Float64,
        vec!["Rating".to_string()],
    );
    assert!(DataModel::builder()
        .add_table(host_table())
        .add_writeback_column(float_key)
        .build()
        .is_err());

    // The column name must not collide with a physical host column.
    let collision = WritebackColumn::new(
        "wb-collide",
        "Name",
        "dim_customer",
        DataType::String,
        vec!["ID".to_string()],
    );
    assert!(DataModel::builder()
        .add_table(host_table())
        .add_writeback_column(collision)
        .build()
        .is_err());

    // Duplicate ids collide on store-table names.
    assert!(DataModel::builder()
        .add_table(host_table())
        .add_writeback_column(wb())
        .add_writeback_column(wb().with_projection(WritebackProjection::Blank))
        .build()
        .is_err());
}
