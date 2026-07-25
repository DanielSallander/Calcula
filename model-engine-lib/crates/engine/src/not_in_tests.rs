//! End-to-end `NOT IN` tests — anti-membership in KEEP conditions
//! (`col NOT IN {literals}`) and KEEP predicates (`col NOT IN var[col]`),
//! exercised through the full local-aggregation path against cached
//! in-memory batches.
//!
//! Fixture (same shape as `calc_group_tests`): fact `Sales(prod_id, amount)`
//! related to `Product(id, name)`. Rows: prod 1 → 100, prod 2 → 40,
//! prod 1 → 30, prod 2 → 20. Grand total 190; Bikes (prod 1) = 130,
//! Helmets (prod 2) = 60.

use std::sync::Arc;

use arrow::array::{Array, Float64Array, Int64Array, StringArray};
use arrow::datatypes::{DataType as ArrowType, Field, Schema};
use arrow::record_batch::RecordBatch;

use crate::{
    expression_measure, parse_measure, sum_measure, Column, ComparisonOp, DataModel, DataType,
    Engine, FilterPredicate, QueryRequest, Relationship, SourceBinding, StorageMode, Table,
    TableVariable,
};

fn model(measure_text: &str) -> DataModel {
    DataModel::builder()
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
        .add_measure(sum_measure("Revenue", "Sales", "amount"))
        .add_measure(expression_measure(
            "Filtered",
            parse_measure(measure_text).unwrap(),
        ))
        // The "premium" set: products named Bikes (id 1).
        .add_table_variable(TableVariable::new(
            "premium",
            "Product",
            vec![FilterPredicate::new(
                "Product",
                "name",
                ComparisonOp::Equal,
                "Bikes",
            )],
        ))
        .build()
        .unwrap()
}

fn engine(measure_text: &str) -> Engine {
    let mut engine = Engine::new(model(measure_text));
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
                    Arc::new(Int64Array::from(vec![1, 2, 1, 2])),
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
}

async fn scalar_value(engine: &Engine, measure: &str) -> f64 {
    let batches = engine
        .query(QueryRequest {
            measures: vec![measure.into()],
            ..Default::default()
        })
        .await
        .unwrap();
    let b = &batches[0];
    let idx = b.schema().index_of(measure).unwrap();
    let col = b.column(idx);
    if let Some(a) = col.as_any().downcast_ref::<Float64Array>() {
        a.value(0)
    } else if let Some(a) = col.as_any().downcast_ref::<Int64Array>() {
        a.value(0) as f64
    } else {
        panic!("unexpected type {:?}", col.data_type());
    }
}

// --- NOT IN {literal list} (KEEP condition / InList) ---
//
// The list conditions target FACT columns: an expression condition on a
// dimension column requires the dimension in the query shape (pre-existing
// behavior, loud error otherwise) and is orthogonal to the negation.

#[tokio::test]
async fn keep_in_literal_list_baseline() {
    let engine = engine("SUM(Sales[amount], KEEP(Sales, Sales[prod_id] IN {1}))");
    assert!((scalar_value(&engine, "Filtered").await - 130.0).abs() < 1e-9);
}

#[tokio::test]
async fn keep_not_in_literal_list_is_complement() {
    let engine = engine("SUM(Sales[amount], KEEP(Sales, Sales[prod_id] NOT IN {1}))");
    assert!((scalar_value(&engine, "Filtered").await - 60.0).abs() < 1e-9);
}

#[tokio::test]
async fn keep_not_in_multi_value_list() {
    let engine = engine("SUM(Sales[amount], KEEP(Sales, Sales[prod_id] NOT IN {1, 2}))");
    // Everything excluded.
    let batches = engine
        .query(QueryRequest {
            measures: vec!["Filtered".into()],
            ..Default::default()
        })
        .await
        .unwrap();
    let b = &batches[0];
    let idx = b.schema().index_of("Filtered").unwrap();
    let col = b.column(idx);
    let a = col.as_any().downcast_ref::<Float64Array>().unwrap();
    assert!(
        b.num_rows() == 0 || a.is_null(0) || a.value(0) == 0.0,
        "expected empty/NULL total, got {:?}",
        a.value(0)
    );
}

// --- NOT IN var[col] (KEEP predicate / InPredicate anti-join) ---

#[tokio::test]
async fn keep_in_variable_baseline() {
    let engine = engine("SUM(Sales[amount], KEEP(Product, Sales[prod_id] IN premium[id]))");
    assert!((scalar_value(&engine, "Filtered").await - 130.0).abs() < 1e-9);
}

#[tokio::test]
async fn keep_not_in_variable_is_anti_join() {
    let engine = engine("SUM(Sales[amount], KEEP(Product, Sales[prod_id] NOT IN premium[id]))");
    assert!((scalar_value(&engine, "Filtered").await - 60.0).abs() < 1e-9);
}

#[tokio::test]
async fn not_in_composes_with_group_by() {
    let engine = engine("SUM(Sales[amount], KEEP(Product, Sales[prod_id] NOT IN premium[id]))");
    let batches = engine
        .query(QueryRequest {
            group_by: vec![crate::ColumnRef::new("Product", "name")],
            measures: vec!["Filtered".into(), "Revenue".into()],
            ..Default::default()
        })
        .await
        .unwrap();
    // Bikes row: Filtered is NULL/0 (all its rows excluded); Helmets: 60.
    let mut helmets_filtered = None;
    for b in &batches {
        let name_idx = b.schema().index_of("name").unwrap();
        let f_idx = b.schema().index_of("Filtered").unwrap();
        let names = b.column(name_idx);
        let f = b.column(f_idx);
        for row in 0..b.num_rows() {
            let name = if let Some(a) = names.as_any().downcast_ref::<StringArray>() {
                a.value(row).to_string()
            } else if let Some(a) = names
                .as_any()
                .downcast_ref::<arrow::array::DictionaryArray<arrow::datatypes::Int32Type>>()
            {
                let values = a.values().as_any().downcast_ref::<StringArray>().unwrap();
                values.value(a.key(row).unwrap()).to_string()
            } else {
                panic!("unexpected group type {:?}", names.data_type());
            };
            let fa = f.as_any().downcast_ref::<Float64Array>().unwrap();
            if name == "Helmets" {
                helmets_filtered = Some(fa.value(row));
            }
        }
    }
    assert!(
        (helmets_filtered.expect("Helmets row present") - 60.0).abs() < 1e-9,
        "NOT IN must keep the non-premium product"
    );
}
