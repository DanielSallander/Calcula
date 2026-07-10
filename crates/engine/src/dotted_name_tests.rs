//! Regression tests for DOTTED model table names in the local compute path.
//!
//! Imports historically named model tables `"<schema>.<table>"` (e.g.
//! `BI.fact_sales`). The local pipeline interpolates the lowercased name
//! UNQUOTED into DataFusion SQL, where the dot parses as a `schema.table`
//! qualification — so a bare registration of the dotted string never resolved
//! and any locally-computed query (most visibly ROLLUP totals, which force
//! local compute) failed with "table 'datafusion.bi.fact_sales' not found".
//! `register_partitioned_table` now registers single-dotted names as
//! schema-qualified in-memory tables, which these tests lock in end to end.
//!
//! Fixture (in-memory, served from the cache like `having_tests`):
//! `BI.fact_sales(prod_id, amount)` → `dim_product(id, name)`.
//! Revenue = SUM(amount): Bikes 130, Helmets 60; grand total 190.

#![cfg(test)]

use std::sync::Arc;

use arrow::array::{Array, Float64Array, Int64Array, StringArray};
use arrow::datatypes::{DataType as ArrowType, Field, Schema};
use arrow::record_batch::RecordBatch;

use crate::{
    sum_measure, Column, ColumnRef, DataModel, DataType, Engine, QueryRequest, Relationship,
    SourceBinding, StorageMode, Table, TotalsMode,
};

fn dotted_model() -> DataModel {
    DataModel::builder()
        .add_table(
            Table::new(
                "BI.fact_sales",
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
                "dim_product",
                vec![
                    Column::new("id", DataType::Int64),
                    Column::new("name", DataType::String),
                ],
            )
            .unwrap()
            .with_storage_mode(StorageMode::InMemory),
        )
        .add_relationship(Relationship::many_to_one(
            "fact_product",
            "BI.fact_sales",
            "prod_id",
            "dim_product",
            "id",
        ))
        .add_measure(sum_measure("Revenue", "BI.fact_sales", "amount"))
        .build()
        .unwrap()
}

fn dotted_engine() -> Engine {
    let mut engine = Engine::new(dotted_model());
    engine.bind_table("BI.fact_sales", 0, SourceBinding::new("BI", "fact_sales"));
    engine.bind_table("dim_product", 0, SourceBinding::new("BI", "dim_product"));
    engine
        .cache
        .store(
            "BI.fact_sales",
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
            "dim_product",
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

/// The exact user-visible failure: a grouped ROLLUP query over a dotted fact
/// table ("Error during planning: table 'datafusion.bi.fact_sales' not found").
#[tokio::test]
async fn rollup_totals_work_over_a_dotted_fact_table_name() {
    let engine = dotted_engine();
    let batches = engine
        .query(QueryRequest {
            measures: vec!["Revenue".into()],
            group_by: vec![ColumnRef::new("dim_product", "name")],
            totals: TotalsMode::Rollup,
            ..Default::default()
        })
        .await
        .expect("rollup over a dotted fact table must plan and execute");

    // Two detail rows + one grand total, with the grouping-id column appended.
    let rows: usize = batches.iter().map(|b| b.num_rows()).sum();
    assert_eq!(rows, 3, "2 detail rows + 1 grand total");
    let batch = &batches[0];
    let gid_idx = batch.schema().index_of("__grouping_id").unwrap();
    let revenue_idx = batch.schema().index_of("Revenue").unwrap();
    let gids = batch
        .column(gid_idx)
        .as_any()
        .downcast_ref::<arrow::array::Int32Array>()
        .unwrap()
        .iter()
        .flatten()
        .collect::<Vec<_>>();
    assert!(gids.contains(&1), "grand-total row present (bit 0 set)");
    // The grand total sums everything: 100 + 40 + 30 + 20.
    let revenues = batch
        .column(revenue_idx)
        .as_any()
        .downcast_ref::<Float64Array>()
        .unwrap();
    let total_row = gids.iter().position(|g| *g == 1).unwrap();
    assert_eq!(revenues.value(total_row), 190.0);
}

/// The plain grouped query takes the same local path when served from cache —
/// it must work with the dotted name too.
#[tokio::test]
async fn grouped_query_works_over_a_dotted_fact_table_name() {
    let engine = dotted_engine();
    let batches = engine
        .query(QueryRequest {
            measures: vec!["Revenue".into()],
            group_by: vec![ColumnRef::new("dim_product", "name")],
            ..Default::default()
        })
        .await
        .expect("grouped query over a dotted fact table must plan and execute");
    let rows: usize = batches.iter().map(|b| b.num_rows()).sum();
    assert_eq!(rows, 2, "one row per product");
}

/// Ungrouped (grand-total only) queries exercise the scalar path.
#[tokio::test]
async fn ungrouped_query_works_over_a_dotted_fact_table_name() {
    let engine = dotted_engine();
    let batches = engine
        .query(QueryRequest {
            measures: vec!["Revenue".into()],
            ..Default::default()
        })
        .await
        .expect("ungrouped query over a dotted fact table must plan and execute");
    let batch = &batches[0];
    let revenue_idx = batch.schema().index_of("Revenue").unwrap();
    let revenues = batch
        .column(revenue_idx)
        .as_any()
        .downcast_ref::<Float64Array>()
        .unwrap();
    assert_eq!(revenues.value(0), 190.0);
}
