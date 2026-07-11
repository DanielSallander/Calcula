//! End-to-end tests for PLAIN (static, row-level) calculated columns through
//! `Engine::query` — measures over them and grouping by them, served from the
//! in-memory cache via the local-aggregation path.
//!
//! Fixture: `Sales(prod_id, amount)` with calculated columns
//! `double_amount = Sales[amount] * 2` and `size = IF(amount >= 50, "big",
//! "small")`. Rows: (1, 100), (2, 40), (1, 30), (2, 20).

use std::collections::HashMap;
use std::sync::Arc;

use arrow::array::{Array, DictionaryArray, Float64Array, Int64Array, StringArray};
use arrow::datatypes::{DataType as ArrowType, Field, Int32Type, Schema};
use arrow::record_batch::RecordBatch;

use crate::{
    parse_measure_expression, CalculatedColumn, Column, ColumnRef, DataModel, DataType, Engine,
    Measure, QueryRequest, Relationship, SourceBinding, StorageMode, Table,
};

fn model() -> DataModel {
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
        .add_calculated_column(CalculatedColumn::new(
            "double_amount",
            "Sales",
            parse_measure_expression("Sales[amount] * 2").unwrap(),
            DataType::Float64,
        ))
        .add_calculated_column(CalculatedColumn::new(
            "size",
            "Sales",
            parse_measure_expression("IF(Sales[amount] >= 50, \"big\", \"small\")").unwrap(),
            DataType::String,
        ))
        .add_measure(Measure::new(
            "DoubleTotal",
            parse_measure_expression("SUM(Sales[double_amount])").unwrap(),
        ))
        .add_measure(Measure::new(
            "Revenue",
            parse_measure_expression("SUM(Sales[amount])").unwrap(),
        ))
        .build()
        .unwrap()
}

fn engine() -> Engine {
    let mut engine = Engine::new(model());
    engine.bind_table("Sales", 0, SourceBinding::new("public", "sales"));
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

fn grouped(batches: &[RecordBatch], group_col: &str, measure_col: &str) -> HashMap<String, f64> {
    let mut out = HashMap::new();
    for b in batches {
        let gi = b.schema().index_of(group_col).unwrap();
        let mi = b.schema().index_of(measure_col).unwrap();
        let g = b.column(gi);
        let m = b.column(mi);
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

// ---- Cross-table calculated columns (RELATED + LOOKUPVALUE) ----

/// Sales(prod_id, amount) -> Product(id, name) via relationship, plus a
/// relationship-LESS Rates(pid, rate) table for LOOKUPVALUE:
/// - `pname = RELATED(Product[name])` — relationship dereference;
/// - `rate = LOOKUPVALUE(Rates[rate], Rates[pid], Sales[prod_id])` — keyed
///   match without a relationship. Rates has a DUPLICATE pid=2 row (10.0 and
///   99.0): the deduplicated lookup join must keep Sales at 4 rows and
///   resolve the tie to MIN (10.0).
fn cross_table_model() -> DataModel {
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
        .add_table(
            Table::new(
                "Rates",
                vec![
                    Column::new("pid", DataType::Int64),
                    Column::new("rate", DataType::Float64),
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
        .add_calculated_column(CalculatedColumn::new(
            "pname",
            "Sales",
            parse_measure_expression("RELATED(Product[name])").unwrap(),
            DataType::String,
        ))
        .add_calculated_column(CalculatedColumn::new(
            "rate",
            "Sales",
            parse_measure_expression("LOOKUPVALUE(Rates[rate], Rates[pid], Sales[prod_id])")
                .unwrap(),
            DataType::Float64,
        ))
        .add_measure(Measure::new(
            "Revenue",
            parse_measure_expression("SUM(Sales[amount])").unwrap(),
        ))
        .add_measure(Measure::new(
            "RateTotal",
            parse_measure_expression("SUM(Sales[rate])").unwrap(),
        ))
        .add_measure(Measure::new(
            "SalesRows",
            parse_measure_expression("COUNTROWS(Sales)").unwrap(),
        ))
        .build()
        .unwrap()
}

fn cross_table_engine() -> Engine {
    let mut engine = Engine::new(cross_table_model());
    engine.bind_table("Sales", 0, SourceBinding::new("public", "sales"));
    engine.bind_table("Product", 0, SourceBinding::new("public", "product"));
    engine.bind_table("Rates", 0, SourceBinding::new("public", "rates"));
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
        .cache
        .store(
            "Rates",
            RecordBatch::try_new(
                Arc::new(Schema::new(vec![
                    Field::new("pid", ArrowType::Int64, true),
                    Field::new("rate", ArrowType::Float64, true),
                ])),
                vec![
                    Arc::new(Int64Array::from(vec![1, 2, 2])),
                    Arc::new(Float64Array::from(vec![2.0, 10.0, 99.0])),
                ],
            )
            .unwrap(),
        )
        .unwrap();
    engine
}

#[tokio::test]
async fn related_calculated_column_groups_by_dereferenced_value() {
    let engine = cross_table_engine();
    let batches = engine
        .query(QueryRequest {
            measures: vec!["Revenue".into()],
            group_by: vec![ColumnRef::new("Sales", "pname")],
            ..Default::default()
        })
        .await
        .unwrap();
    let by_name = grouped(&batches, "pname", "Revenue");
    assert_eq!(by_name.get("Bikes"), Some(&130.0));
    assert_eq!(by_name.get("Helmets"), Some(&60.0));
}

#[tokio::test]
async fn lookupvalue_calculated_column_dedups_and_preserves_rows() {
    let engine = cross_table_engine();
    // Per-row rates: 2, 10, 2, 10 (duplicate Rates key resolves to MIN(10)).
    let batches = engine
        .query(QueryRequest {
            measures: vec!["RateTotal".into(), "SalesRows".into()],
            ..Default::default()
        })
        .await
        .unwrap();
    let b = &batches[0];
    let rate_idx = b.schema().index_of("RateTotal").unwrap();
    let rows_idx = b.schema().index_of("SalesRows").unwrap();
    assert_eq!(as_f64(b.column(rate_idx).as_ref(), 0), 24.0);
    // The duplicate lookup key must NOT multiply Sales rows.
    assert_eq!(as_f64(b.column(rows_idx).as_ref(), 0), 4.0);
}

#[tokio::test]
async fn cross_table_validation_fails_closed() {
    // Cross-table ref without any relationship: rejected at build.
    let err = DataModel::builder()
        .add_table(
            Table::new("A", vec![Column::new("x", DataType::Int64)]).unwrap(),
        )
        .add_table(
            Table::new("B", vec![Column::new("y", DataType::Int64)]).unwrap(),
        )
        .add_calculated_column(CalculatedColumn::new(
            "bad",
            "A",
            parse_measure_expression("RELATED(B[y])").unwrap(),
            DataType::Int64,
        ))
        .build()
        .unwrap_err()
        .to_string();
    assert!(err.contains("fan-out-safe"), "got: {err}");

    // LOOKUPVALUE in a measure: rejected with guidance.
    let err = DataModel::builder()
        .add_table(
            Table::new("A", vec![Column::new("x", DataType::Int64)]).unwrap(),
        )
        .add_measure(Measure::new(
            "Bad",
            parse_measure_expression("SUM(A[x]) + LOOKUPVALUE(A[x], A[x], 1)").unwrap(),
        ))
        .build()
        .unwrap_err()
        .to_string();
    assert!(err.contains("calculated columns"), "got: {err}");
}

#[tokio::test]
async fn measure_over_calculated_column() {
    let engine = engine();
    let batches = engine
        .query(QueryRequest {
            measures: vec!["DoubleTotal".into()],
            ..Default::default()
        })
        .await
        .unwrap();
    // 2 * (100 + 40 + 30 + 20) = 380.
    assert_eq!(as_f64(batches[0].column(0).as_ref(), 0), 380.0);
}

#[tokio::test]
async fn group_by_calculated_column() {
    let engine = engine();
    let batches = engine
        .query(QueryRequest {
            measures: vec!["Revenue".into()],
            group_by: vec![ColumnRef::new("Sales", "size")],
            ..Default::default()
        })
        .await
        .unwrap();
    let by_size = grouped(&batches, "size", "Revenue");
    // big: 100; small: 40 + 30 + 20 = 90.
    assert_eq!(by_size.get("big"), Some(&100.0));
    assert_eq!(by_size.get("small"), Some(&90.0));
}
