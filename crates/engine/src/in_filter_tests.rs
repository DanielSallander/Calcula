//! End-to-end multi-select IN-list slicer tests (`QueryRequest.in_filters`).
//!
//! Built over an in-memory star schema served from the cache. Fixture:
//! `Sales(prod_id, region_id, amount)` → `Product(id, name)` and `Region(id,
//! name)`. Sales rows (prod, region, amount): (Bikes, East, 100),
//! (Helmets, East, 40), (Bikes, West, 30), (Helmets, West, 20).
//! Revenue by product (all regions): Bikes 130, Helmets 60.

#![cfg(test)]

use std::collections::HashMap;
use std::sync::Arc;

use arrow::array::{Array, DictionaryArray, Float64Array, Int64Array, StringArray};
use arrow::datatypes::{DataType as ArrowType, Field, Int32Type, Schema};
use arrow::record_batch::RecordBatch;

use crate::{
    sum_measure, Column, ColumnRef, DataModel, DataType, Engine, InFilter, QueryRequest,
    Relationship, SourceBinding, StorageMode, Table,
};

fn slicer_model() -> DataModel {
    let in_mem = |t: Table| t.with_storage_mode(StorageMode::InMemory);
    DataModel::builder()
        .add_table(in_mem(
            Table::new(
                "Sales",
                vec![
                    Column::new("prod_id", DataType::Int64),
                    Column::new("region_id", DataType::Int64),
                    Column::new("amount", DataType::Float64),
                ],
            )
            .unwrap(),
        ))
        .add_table(in_mem(
            Table::new(
                "Product",
                vec![
                    Column::new("id", DataType::Int64),
                    Column::new("name", DataType::String),
                ],
            )
            .unwrap(),
        ))
        .add_table(in_mem(
            Table::new(
                "Region",
                vec![
                    Column::new("id", DataType::Int64),
                    Column::new("region", DataType::String),
                ],
            )
            .unwrap(),
        ))
        .add_relationship(Relationship::many_to_one(
            "Sales_Product",
            "Sales",
            "prod_id",
            "Product",
            "id",
        ))
        .add_relationship(Relationship::many_to_one(
            "Sales_Region",
            "Sales",
            "region_id",
            "Region",
            "id",
        ))
        .add_measure(sum_measure("Revenue", "Sales", "amount"))
        .build()
        .unwrap()
}

fn slicer_engine() -> Engine {
    let mut engine = Engine::new(slicer_model());
    for t in ["Sales", "Product", "Region"] {
        engine.bind_table(t, 0, SourceBinding::new("public", &t.to_lowercase()));
    }
    engine
        .cache
        .store(
            "Sales",
            RecordBatch::try_new(
                Arc::new(Schema::new(vec![
                    Field::new("prod_id", ArrowType::Int64, true),
                    Field::new("region_id", ArrowType::Int64, true),
                    Field::new("amount", ArrowType::Float64, true),
                ])),
                vec![
                    Arc::new(Int64Array::from(vec![1, 2, 1, 2])),
                    Arc::new(Int64Array::from(vec![1, 1, 2, 2])),
                    Arc::new(Float64Array::from(vec![100.0, 40.0, 30.0, 20.0])),
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
                    Arc::new(Int64Array::from(vec![1, 2])),
                    Arc::new(StringArray::from(vec!["Bikes", "Helmets"])),
                ],
            )
            .unwrap(),
        )
        .unwrap();
    engine
        .cache
        .store(
            "Region",
            RecordBatch::try_new(
                Arc::new(Schema::new(vec![
                    Field::new("id", ArrowType::Int64, true),
                    Field::new("region", ArrowType::Utf8, true),
                ])),
                vec![
                    Arc::new(Int64Array::from(vec![1, 2])),
                    Arc::new(StringArray::from(vec!["East", "West"])),
                ],
            )
            .unwrap(),
        )
        .unwrap();
    engine
}

fn col_idx(batch: &RecordBatch, name: &str) -> usize {
    batch
        .schema()
        .index_of(name)
        .unwrap_or_else(|_| panic!("column '{name}' not found in {:?}", batch.schema()))
}

fn str_key(array: &dyn Array, row: usize) -> String {
    if let Some(a) = array.as_any().downcast_ref::<StringArray>() {
        a.value(row).to_string()
    } else if let Some(a) = array.as_any().downcast_ref::<DictionaryArray<Int32Type>>() {
        let values = a.values().as_any().downcast_ref::<StringArray>().unwrap();
        values.value(a.key(row).unwrap()).to_string()
    } else {
        panic!("unexpected group array type: {:?}", array.data_type());
    }
}

/// `name -> Revenue`, grouped by Product name.
fn by_product(batches: &[RecordBatch]) -> HashMap<String, f64> {
    let mut out = HashMap::new();
    for b in batches {
        let g = b.column(col_idx(b, "name"));
        let m = b.column(col_idx(b, "Revenue"));
        for row in 0..b.num_rows() {
            let v = if let Some(a) = m.as_any().downcast_ref::<Float64Array>() {
                a.value(row)
            } else if let Some(a) = m.as_any().downcast_ref::<Int64Array>() {
                a.value(row) as f64
            } else {
                panic!("unexpected measure type");
            };
            out.insert(str_key(g.as_ref(), row), v);
        }
    }
    out
}

fn group_by_product(in_filters: Vec<InFilter>) -> QueryRequest {
    QueryRequest {
        measures: vec!["Revenue".into()],
        group_by: vec![ColumnRef::new("Product", "name")],
        in_filters,
        ..Default::default()
    }
}

#[tokio::test]
async fn no_in_filter_returns_all() {
    let engine = slicer_engine();
    let r = by_product(&engine.query(group_by_product(vec![])).await.unwrap());
    assert_eq!(r["Bikes"], 130.0);
    assert_eq!(r["Helmets"], 60.0);
}

#[tokio::test]
async fn in_filter_on_filter_only_dimension_restricts_the_fact() {
    // Slice Region IN ('East') while grouping by Product (Region not on the
    // axis). East-only Revenue: Bikes 100, Helmets 40.
    let engine = slicer_engine();
    let r = by_product(
        &engine
            .query(group_by_product(vec![InFilter::new("region", ["East"])]))
            .await
            .unwrap(),
    );
    assert_eq!(r["Bikes"], 100.0, "East-only Bikes");
    assert_eq!(r["Helmets"], 40.0, "East-only Helmets");
}

#[tokio::test]
async fn multi_value_in_filter_keeps_all_listed() {
    // Region IN ('East', 'West') = every region → unchanged totals.
    let engine = slicer_engine();
    let r = by_product(
        &engine
            .query(group_by_product(vec![InFilter::new(
                "region",
                ["East", "West"],
            )]))
            .await
            .unwrap(),
    );
    assert_eq!(r["Bikes"], 130.0);
    assert_eq!(r["Helmets"], 60.0);
}

#[tokio::test]
async fn in_filter_on_group_by_dimension() {
    // Slice Product.name IN ('Bikes') → only the Bikes row, all regions.
    let engine = slicer_engine();
    let r = by_product(
        &engine
            .query(group_by_product(vec![InFilter::new("name", ["Bikes"])]))
            .await
            .unwrap(),
    );
    assert_eq!(r.len(), 1);
    assert_eq!(r["Bikes"], 130.0);
}

#[tokio::test]
async fn in_filter_on_integer_fact_column() {
    // region_id IN ('1') on the fact (integer column) → East only.
    let engine = slicer_engine();
    let r = by_product(
        &engine
            .query(group_by_product(vec![InFilter::new("region_id", ["1"])]))
            .await
            .unwrap(),
    );
    assert_eq!(r["Bikes"], 100.0);
    assert_eq!(r["Helmets"], 40.0);
}

#[tokio::test]
async fn empty_in_filter_matches_nothing() {
    let engine = slicer_engine();
    let batches = engine
        .query(group_by_product(vec![InFilter::new(
            "region",
            Vec::<String>::new(),
        )]))
        .await
        .unwrap();
    assert_eq!(
        batches.iter().map(|b| b.num_rows()).sum::<usize>(),
        0,
        "an empty IN-list matches nothing, never everything"
    );
}
