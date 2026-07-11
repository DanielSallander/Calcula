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
    Measure, QueryRequest, SourceBinding, StorageMode, Table,
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
