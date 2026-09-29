//! End-to-end tests for the BLANK member in a scoped IN-list slicer
//! (`QueryRequest.scoped_in_filters`, [`crate::BLANK_MEMBER_LABEL`]).
//!
//! A host lists a column's members with its blank (NULL / empty) member as
//! the label `(blank)`, and a slicer selection made from that list arrives as
//! a scoped IN-list naming it. Before the label was understood, `col IN
//! ('East', '(blank)')` matched no NULL row: a PINNED selection that kept the
//! blank member silently dropped the blank rows from every measure.
//!
//! Fixture: one table `Sales(region, code, amount)` with a NULL region, an
//! EMPTY region, a NULL code:
//!   (East, 1, 10) (West, 2, 20) (NULL, NULL, 30) (North, 3, 40) ("", 4, 50)
//! served three ways: from the in-memory cache, through a connector fetch
//! (DirectQuery over an in-memory source), and as a CONTESTED filter (a
//! measure clears it, so the others apply it per measure).

#![cfg(test)]

use std::sync::Arc;

use arrow::array::{Array, Float64Array, Int64Array, StringArray};
use arrow::datatypes::{DataType as ArrowType, Field, Schema};
use arrow::record_batch::RecordBatch;

use crate::{
    expression_measure, parse_measure, sum_measure, Column, DataModel, DataType, Engine, InFilter,
    InMemoryConnector, QueryRequest, ScopedInFilter, SourceBinding, StorageMode, Table,
    BLANK_MEMBER_LABEL,
};

fn model(storage: StorageMode) -> DataModel {
    DataModel::builder()
        .add_table(
            Table::new(
                "Sales",
                vec![
                    Column::new("region", DataType::String),
                    Column::new("code", DataType::Int64),
                    Column::new("amount", DataType::Float64),
                ],
            )
            .unwrap()
            .with_storage_mode(storage),
        )
        .add_measure(sum_measure("Revenue", "Sales", "amount"))
        .add_measure(expression_measure(
            "TotalBust",
            parse_measure("SUM(Sales[amount], CLEAR(Sales, LEVEL 2))").unwrap(),
        ))
        .build()
        .unwrap()
}

fn sales() -> RecordBatch {
    RecordBatch::try_new(
        Arc::new(Schema::new(vec![
            Field::new("region", ArrowType::Utf8, true),
            Field::new("code", ArrowType::Int64, true),
            Field::new("amount", ArrowType::Float64, true),
        ])),
        vec![
            Arc::new(StringArray::from(vec![
                Some("East"),
                Some("West"),
                None,
                Some("North"),
                Some(""),
            ])),
            Arc::new(Int64Array::from(vec![Some(1), Some(2), None, Some(3), Some(4)])),
            Arc::new(Float64Array::from(vec![10.0, 20.0, 30.0, 40.0, 50.0])),
        ],
    )
    .unwrap()
}

/// Served from the in-memory CACHE.
fn cached_engine() -> Engine {
    let mut engine = Engine::new(model(StorageMode::InMemory));
    engine.bind_table("Sales", 0, SourceBinding::new("public", "sales"));
    engine.cache.store("Sales", sales()).unwrap();
    engine
}

/// Fetched through a CONNECTOR on every query (DirectQuery over an in-memory
/// source), so the IN-list is applied by the connector's own filter path.
fn connector_engine() -> Engine {
    let mut engine = Engine::new(model(StorageMode::DirectQuery));
    let idx = engine.add_in_memory_source(InMemoryConnector::new().with_table("public", "sales", sales()));
    engine.bind_table("Sales", idx, SourceBinding::new("public", "sales"));
    engine
}

fn pinned(column: &str, values: &[&str], level: u8) -> ScopedInFilter {
    ScopedInFilter {
        table: Some("Sales".into()),
        filter: InFilter::new(column, values.iter().copied()),
        level,
    }
}

/// The scalar value of `measure` in a one-row result.
fn scalar(batches: &[RecordBatch], measure: &str) -> f64 {
    let mut total = 0.0;
    for b in batches {
        let idx = b.schema().index_of(measure).unwrap_or_else(|_| panic!("no {measure}"));
        let col = b.column(idx);
        for r in 0..b.num_rows() {
            if col.is_null(r) {
                continue;
            }
            total += if let Some(a) = col.as_any().downcast_ref::<Float64Array>() {
                a.value(r)
            } else if let Some(a) = col.as_any().downcast_ref::<Int64Array>() {
                a.value(r) as f64
            } else {
                panic!("unexpected measure type {:?}", col.data_type())
            };
        }
    }
    total
}

async fn revenue(engine: &Engine, filter: ScopedInFilter) -> f64 {
    let batches = engine
        .query(QueryRequest {
            measures: vec!["Revenue".into()],
            scoped_in_filters: vec![filter],
            ..Default::default()
        })
        .await
        .expect("the query");
    scalar(&batches, "Revenue")
}

#[test]
fn the_blank_member_label_is_the_hosts_spelling() {
    assert_eq!(BLANK_MEMBER_LABEL, "(blank)");
}

#[tokio::test]
async fn a_cached_scoped_in_list_naming_the_blank_member_keeps_null_and_empty_rows() {
    let engine = cached_engine();
    for level in [1u8, 2] {
        assert_eq!(
            revenue(&engine, pinned("region", &["East", BLANK_MEMBER_LABEL], level)).await,
            90.0,
            "level {level}: East (10) + the NULL region (30) + the empty region (50)"
        );
    }
    // Any case, as the host spells it back.
    assert_eq!(revenue(&engine, pinned("region", &["East", "(Blank)"], 2)).await, 90.0);
    // The blank member alone.
    assert_eq!(revenue(&engine, pinned("region", &[BLANK_MEMBER_LABEL], 2)).await, 80.0);
    // A list NOT naming it keeps excluding the blank rows.
    assert_eq!(revenue(&engine, pinned("region", &["East"], 2)).await, 10.0);
}

#[tokio::test]
async fn a_connector_fetched_scoped_in_list_naming_the_blank_member_keeps_null_and_empty_rows() {
    let engine = connector_engine();
    assert_eq!(
        revenue(&engine, pinned("region", &["East", BLANK_MEMBER_LABEL], 2)).await,
        90.0,
        "the connector's IN-list dropped the blank rows"
    );
    assert_eq!(revenue(&engine, pinned("region", &["East"], 2)).await, 10.0);
}

#[tokio::test]
async fn the_blank_member_of_an_integer_column_is_its_null_rows() {
    for engine in [cached_engine(), connector_engine()] {
        assert_eq!(
            revenue(&engine, pinned("code", &["1", BLANK_MEMBER_LABEL], 2)).await,
            40.0,
            "code 1 (10) + the NULL code (30)"
        );
        assert_eq!(revenue(&engine, pinned("code", &["1"], 2)).await, 10.0);
    }
}

/// CONTESTED: `TotalBust` clears the level-2 pin, so the pin is applied per
/// measure -- `Revenue` honors it (blank rows included), `TotalBust` does not.
#[tokio::test]
async fn a_contested_scoped_in_list_naming_the_blank_member_keeps_its_rows() {
    let engine = cached_engine();
    let batches = engine
        .query(QueryRequest {
            measures: vec!["Revenue".into(), "TotalBust".into()],
            scoped_in_filters: vec![pinned("region", &["East", BLANK_MEMBER_LABEL], 2)],
            ..Default::default()
        })
        .await
        .expect("the contested query");
    assert_eq!(scalar(&batches, "Revenue"), 90.0, "the contested pin dropped the blank rows");
    assert_eq!(scalar(&batches, "TotalBust"), 150.0, "the busting measure must see every row");

    // ...and a contested list that does NOT name the blank member keeps
    // excluding the blank rows.
    let batches = engine
        .query(QueryRequest {
            measures: vec!["Revenue".into(), "TotalBust".into()],
            scoped_in_filters: vec![pinned("region", &["East"], 2)],
            ..Default::default()
        })
        .await
        .expect("the contested query");
    assert_eq!(scalar(&batches, "Revenue"), 10.0, "a contested pin NOT naming the blank member kept the blank rows");
    assert_eq!(scalar(&batches, "TotalBust"), 150.0, "the busting measure must see every row");
}
