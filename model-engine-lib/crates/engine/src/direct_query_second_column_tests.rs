//! A DirectQuery table grouped by its SECOND column answers with that column.
//!
//! Found live 2026-09-29 by the host's e2e (fixall-pivot W4): on a DirectQuery
//! CSV table `Sales(Region, Year, Amount)`, a model slicer on `Sales.Year`
//! listed East / North / South / West. The host asks for a column's members as
//! a one-measure query grouped by that column (`distinct_values_request`).
//! These tests put that request, and the pivot query before it, through a
//! connector-fetched table (the same filter path the CSV connector uses).

use std::sync::Arc;

use arrow::array::{Array, Float64Array, Int64Array, StringArray};
use arrow::datatypes::{DataType as ArrowType, Field, Schema};
use arrow::record_batch::RecordBatch;

use crate::{
    sum_measure, Column, ColumnRef, DataModel, DataType, Engine, InMemoryConnector, QueryRequest,
    SourceBinding, StorageMode, Table,
};

fn model(storage: StorageMode) -> DataModel {
    DataModel::builder()
        .add_table(
            Table::new(
                "Sales",
                vec![
                    Column::new("Region", DataType::String),
                    Column::new("Year", DataType::Int64),
                    Column::new("Amount", DataType::Float64),
                ],
            )
            .unwrap()
            .with_storage_mode(storage),
        )
        .add_measure(sum_measure("Revenue", "Sales", "Amount"))
        .build()
        .unwrap()
}

fn sales() -> RecordBatch {
    RecordBatch::try_new(
        Arc::new(Schema::new(vec![
            Field::new("Region", ArrowType::Utf8, true),
            Field::new("Year", ArrowType::Int64, false),
            Field::new("Amount", ArrowType::Float64, false),
        ])),
        vec![
            Arc::new(StringArray::from(vec!["East", "West", "North", "South", "East", "West", "North", "South"])),
            Arc::new(Int64Array::from(vec![2024, 2024, 2024, 2024, 2025, 2025, 2025, 2025])),
            Arc::new(Float64Array::from(vec![1.0; 8])),
        ],
    )
    .unwrap()
}

fn engine(storage: StorageMode) -> Engine {
    let in_memory = storage == StorageMode::InMemory;
    let mut engine = Engine::new(model(storage));
    if in_memory {
        engine.bind_table("Sales", 0, SourceBinding::new("public", "sales"));
        engine.cache.store("Sales", sales()).unwrap();
    } else {
        let idx = engine.add_in_memory_source(InMemoryConnector::new().with_table("public", "sales", sales()));
        engine.bind_table("Sales", idx, SourceBinding::new("public", "sales"));
    }
    engine
}

/// The members of `column` as the host lists them: one measure, grouped by it.
async fn members(engine: &Engine, column: &str) -> Vec<String> {
    let batches = engine
        .query(QueryRequest {
            measures: vec!["Revenue".into()],
            group_by: vec![ColumnRef::new("Sales", column)],
            ..Default::default()
        })
        .await
        .expect("the members query");
    let mut out = Vec::new();
    for b in &batches {
        let idx = b.schema().index_of(column).unwrap_or_else(|_| panic!("the result has no column {column}: {:?}", b.schema()));
        let col = b.column(idx);
        for r in 0..b.num_rows() {
            if col.is_null(r) {
                continue;
            }
            out.push(if let Some(s) = col.as_any().downcast_ref::<StringArray>() {
                s.value(r).to_string()
            } else if let Some(i) = col.as_any().downcast_ref::<Int64Array>() {
                i.value(r).to_string()
            } else {
                panic!("unexpected type {:?}", col.data_type())
            });
        }
    }
    out.sort();
    out
}

#[tokio::test]
async fn a_direct_query_table_grouped_by_its_second_column_lists_that_column() {
    for storage in [StorageMode::InMemory, StorageMode::DirectQuery] {
        let engine = engine(storage.clone());
        // The pivot's query first, as in the host: grouped by Region.
        assert_eq!(members(&engine, "Region").await, vec!["East", "North", "South", "West"], "{storage:?}");
        assert_eq!(members(&engine, "Year").await, vec!["2024", "2025"], "{storage:?}: Year listed another column's values");
    }
}
