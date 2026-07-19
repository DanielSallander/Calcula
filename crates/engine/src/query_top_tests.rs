//! End-to-end `QUERY(... TOP n BY alias)` tests — tie-inclusive top-N over a
//! materialized QUERY intermediate, consumed by the RETURN aggregate
//! ("revenue of the top-N categories" measures).
//!
//! Fixture: fact `Sales(prod_id, amount)` → `Product(id, name)`.
//! Per-product totals: Bikes 130, Helmets 60, Tires 60 (a tie).

use std::sync::Arc;

use arrow::array::{Float64Array, Int64Array, StringArray};
use arrow::datatypes::{DataType as ArrowType, Field, Schema};
use arrow::record_batch::RecordBatch;

use crate::{
    expression_measure, parse_measure, Column, DataModel, DataType, Engine, QueryRequest,
    Relationship, SourceBinding, StorageMode, Table,
};

fn engine(measure_text: &str) -> Engine {
    let model = DataModel::builder()
        .add_table(
            Table::new(
                "Sales",
                vec![
                    Column::new("prod_id", DataType::Int64),
                    Column::new("amount", DataType::Float64),
                ],
            )
            .unwrap()
            .with_storage_mode(StorageMode::InMemory),
        )
        .add_table(
            Table::new(
                "Product",
                vec![
                    Column::new("id", DataType::Int64),
                    Column::new("name", DataType::String),
                ],
            )
            .unwrap()
            .with_storage_mode(StorageMode::InMemory),
        )
        .add_relationship(Relationship::many_to_one(
            "Sales_Product",
            "Sales",
            "prod_id",
            "Product",
            "id",
        ))
        .add_measure(expression_measure(
            "TopMeasure",
            parse_measure(measure_text).unwrap(),
        ))
        .build()
        .unwrap();
    let mut engine = Engine::new(model);
    engine.bind_table("Sales", 0, SourceBinding::new("public", "sales"));
    engine.bind_table("Product", 0, SourceBinding::new("public", "product"));
    engine
        .cache
        .store(
            "Sales",
            RecordBatch::try_new(
                Arc::new(Schema::new(vec![
                    Field::new("prod_id", ArrowType::Int64, true),
                    Field::new("amount", ArrowType::Float64, true),
                ])),
                vec![
                    Arc::new(Int64Array::from(vec![1, 2, 1, 2, 3])),
                    Arc::new(Float64Array::from(vec![100.0, 40.0, 30.0, 20.0, 60.0])),
                ],
            )
            .unwrap(),
        )
        .unwrap();
    engine
        .cache
        .store(
            "Product",
            RecordBatch::try_new(
                Arc::new(Schema::new(vec![
                    Field::new("id", ArrowType::Int64, true),
                    Field::new("name", ArrowType::Utf8, true),
                ])),
                vec![
                    Arc::new(Int64Array::from(vec![1, 2, 3])),
                    Arc::new(StringArray::from(vec!["Bikes", "Helmets", "Tires"])),
                ],
            )
            .unwrap(),
        )
        .unwrap();
    engine
}

async fn scalar(engine: &Engine) -> f64 {
    let batches = engine
        .query(QueryRequest {
            measures: vec!["TopMeasure".into()],
            ..Default::default()
        })
        .await
        .unwrap();
    let b = &batches[0];
    let idx = b.schema().index_of("TopMeasure").unwrap();
    b.column(idx)
        .as_any()
        .downcast_ref::<Float64Array>()
        .unwrap()
        .value(0)
}

#[tokio::test]
async fn query_top_sums_top_n_groups() {
    // TOP 1: only Bikes (130).
    let engine = engine(
        "VAR t = QUERY(SUM(Sales[amount]) AS a BY Product[name] TOP 1 BY a) RETURN SUM(t[a])",
    );
    assert!((scalar(&engine).await - 130.0).abs() < 1e-9);
}

#[tokio::test]
async fn query_top_is_tie_inclusive() {
    // TOP 2 by amount: Bikes 130 + BOTH tied 60s (Helmets, Tires) = 250.
    let engine = engine(
        "VAR t = QUERY(SUM(Sales[amount]) AS a BY Product[name] TOP 2 BY a) RETURN SUM(t[a])",
    );
    assert!((scalar(&engine).await - 250.0).abs() < 1e-9);
}

#[tokio::test]
async fn query_top_ascending_is_bottom_n() {
    // TOP 1 ASC: boundary 60 is tied → both Helmets and Tires = 120.
    let engine = engine(
        "VAR t = QUERY(SUM(Sales[amount]) AS a BY Product[name] TOP 1 BY a ASC) RETURN SUM(t[a])",
    );
    assert!((scalar(&engine).await - 120.0).abs() < 1e-9);
}

#[tokio::test]
async fn query_without_top_still_sums_everything() {
    // Baseline (no TOP): all three groups → 130 + 60 + 60 = 250.
    let engine = engine("VAR t = QUERY(SUM(Sales[amount]) AS a BY Product[name]) RETURN SUM(t[a])");
    assert!((scalar(&engine).await - 250.0).abs() < 1e-9);
}
