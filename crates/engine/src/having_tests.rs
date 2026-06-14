//! End-to-end measure-value filter (`HAVING`) tests.
//!
//! Built over an in-memory star-schema fixture served from the cache so the
//! whole facade path is exercised: the underlying query runs without the filter
//! (and without the row limit), then result rows are filtered by measure value
//! and the limit is applied — composing with `order_by` + `limit` into
//! top-N-over-threshold. Stored directly into `self.cache` (a crate-private
//! field), which is why this lives in the crate rather than `tests/`.
//!
//! Fixture: `Sales(prod_id, amount, cost)` → `Product(id, name)`.
//! Per product — Revenue = SUM(amount): Bikes 130, Helmets 60;
//! Cost = SUM(cost): Bikes 75, Helmets 35.

#![cfg(test)]

use std::collections::HashMap;
use std::sync::Arc;

use arrow::array::{Array, DictionaryArray, Float64Array, Int64Array, StringArray};
use arrow::datatypes::{DataType as ArrowType, Field, Int32Type, Schema};
use arrow::record_batch::RecordBatch;

use crate::{
    sum_measure, Column, ColumnRef, DataModel, DataType, Engine, FilterOperator, MeasureFilter,
    OrderByClause, QueryError, QueryRequest, Relationship, SourceBinding, StorageMode, Table,
    TotalsMode,
};

fn having_model() -> DataModel {
    DataModel::builder()
        .add_table(
            Table::new(
                "Sales",
                vec![
                    Column::new("prod_id", DataType::Int64),
                    Column::new("amount", DataType::Float64),
                    Column::new("cost", DataType::Float64),
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
        .add_measure(sum_measure("Cost", "Sales", "cost"))
        .build()
        .unwrap()
}

fn having_engine() -> Engine {
    let mut engine = Engine::new(having_model());
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
                    Field::new("cost", ArrowType::Float64, true),
                ])),
                vec![
                    Arc::new(Int64Array::from(vec![1, 2, 1, 2])),
                    Arc::new(Float64Array::from(vec![100.0, 40.0, 30.0, 20.0])),
                    Arc::new(Float64Array::from(vec![60.0, 25.0, 15.0, 10.0])),
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

fn col_idx(batch: &RecordBatch, name: &str) -> usize {
    batch
        .schema()
        .index_of(name)
        .unwrap_or_else(|_| panic!("column '{name}' not found in {:?}", batch.schema()))
}

fn as_f64(array: &dyn Array, row: usize) -> f64 {
    if let Some(a) = array.as_any().downcast_ref::<Float64Array>() {
        a.value(row)
    } else if let Some(a) = array.as_any().downcast_ref::<Int64Array>() {
        a.value(row) as f64
    } else {
        panic!("unexpected measure array type: {:?}", array.data_type());
    }
}

/// `name -> Revenue` over all result rows (handles dictionary-encoded names).
fn grouped(batches: &[RecordBatch], measure_col: &str) -> HashMap<String, f64> {
    let mut out = HashMap::new();
    for b in batches {
        let g = b.column(col_idx(b, "name"));
        let m = b.column(col_idx(b, measure_col));
        for row in 0..b.num_rows() {
            let key = if let Some(a) = g.as_any().downcast_ref::<StringArray>() {
                a.value(row).to_string()
            } else if let Some(a) = g.as_any().downcast_ref::<DictionaryArray<Int32Type>>() {
                let values = a.values().as_any().downcast_ref::<StringArray>().unwrap();
                values.value(a.key(row).unwrap()).to_string()
            } else {
                panic!("unexpected group array type: {:?}", g.data_type());
            };
            out.insert(key, as_f64(m.as_ref(), row));
        }
    }
    out
}

fn request_with(measure_filters: Vec<MeasureFilter>) -> QueryRequest {
    QueryRequest {
        measures: vec!["Revenue".into()],
        group_by: vec![ColumnRef::new("Product", "name")],
        measure_filters,
        ..Default::default()
    }
}

#[tokio::test]
async fn measure_filter_keeps_only_rows_above_threshold() {
    // Revenue: Bikes 130, Helmets 60. Filter Revenue > 100 keeps only Bikes.
    let engine = having_engine();
    let batches = engine
        .query(request_with(vec![MeasureFilter::new(
            "Revenue",
            FilterOperator::GreaterThan,
            100.0,
        )]))
        .await
        .unwrap();
    let result = grouped(&batches, "Revenue");
    assert_eq!(result.len(), 1, "only Bikes passes Revenue > 100");
    assert!((result["Bikes"] - 130.0).abs() < 1e-9);
}

#[tokio::test]
async fn measure_filter_at_boundary_uses_strict_comparison() {
    // Revenue >= 60 keeps both; Revenue > 60 drops Helmets (exactly 60).
    let engine = having_engine();

    let both = engine
        .query(request_with(vec![MeasureFilter::new(
            "Revenue",
            FilterOperator::GreaterThanOrEqual,
            60.0,
        )]))
        .await
        .unwrap();
    assert_eq!(grouped(&both, "Revenue").len(), 2);

    let strict = engine
        .query(request_with(vec![MeasureFilter::new(
            "Revenue",
            FilterOperator::GreaterThan,
            60.0,
        )]))
        .await
        .unwrap();
    let r = grouped(&strict, "Revenue");
    assert_eq!(r.len(), 1, "Helmets (exactly 60) is dropped by > 60");
    assert!(r.contains_key("Bikes"));
}

#[tokio::test]
async fn empty_result_when_nothing_passes() {
    let engine = having_engine();
    let batches = engine
        .query(request_with(vec![MeasureFilter::new(
            "Revenue",
            FilterOperator::GreaterThan,
            1000.0,
        )]))
        .await
        .unwrap();
    assert_eq!(
        batches.iter().map(|b| b.num_rows()).sum::<usize>(),
        0,
        "no product exceeds 1000"
    );
}

#[tokio::test]
async fn top_n_over_threshold_orders_then_filters_then_limits() {
    // order by Revenue desc, limit 1, Revenue > 50 → the single highest product
    // among those above 50 = Bikes (130). (Both pass > 50; limit picks the top.)
    let engine = having_engine();
    let batches = engine
        .query(QueryRequest {
            measures: vec!["Revenue".into()],
            group_by: vec![ColumnRef::new("Product", "name")],
            order_by: vec![OrderByClause::measure_desc("Revenue")],
            limit: Some(1),
            measure_filters: vec![MeasureFilter::new(
                "Revenue",
                FilterOperator::GreaterThan,
                50.0,
            )],
            ..Default::default()
        })
        .await
        .unwrap();
    let r = grouped(&batches, "Revenue");
    assert_eq!(r.len(), 1, "limit 1");
    assert!((r["Bikes"] - 130.0).abs() < 1e-9, "highest passing product");
}

#[tokio::test]
async fn measure_filter_on_unrequested_measure_fails_closed() {
    // Filter references Cost, which is not in the request's measures.
    let engine = having_engine();
    let err = engine
        .query(request_with(vec![MeasureFilter::new(
            "Cost",
            FilterOperator::GreaterThan,
            10.0,
        )]))
        .await
        .unwrap_err();
    let QueryError::InvalidQuery(msg) = &err else {
        panic!("expected InvalidQuery, got {err:?}");
    };
    assert!(msg.contains("not in the request"), "got: {msg}");
}

#[tokio::test]
async fn measure_filter_with_rollup_totals_fails_closed() {
    let engine = having_engine();
    let err = engine
        .query(QueryRequest {
            measures: vec!["Revenue".into()],
            group_by: vec![ColumnRef::new("Product", "name")],
            totals: TotalsMode::Rollup,
            measure_filters: vec![MeasureFilter::new(
                "Revenue",
                FilterOperator::GreaterThan,
                1.0,
            )],
            ..Default::default()
        })
        .await
        .unwrap_err();
    let QueryError::InvalidQuery(msg) = &err else {
        panic!("expected InvalidQuery, got {err:?}");
    };
    assert!(msg.contains("ROLLUP"), "got: {msg}");
}
