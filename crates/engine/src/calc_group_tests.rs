//! End-to-end calculation-group tests.
//!
//! These build the engine over an in-memory star-schema fixture served from
//! the cache (no connector), so the whole calculation-group path is exercised
//! against real data: application expansion to synthetic measures, the
//! overlay model, the `"{measure} [{item}]"` result-column naming, ordering
//! (measures-outer / items-inner), composition with `group_by`, and the
//! typed errors for unknown group / item / measure. Stored directly into
//! `self.cache` (a crate-private field), which is why this lives in the crate
//! rather than `tests/`.
//!
//! Fixture: a fact `Sales(prod_id, amount)` related to `Product(id, name)`.
//! Rows: prod 1 → 100, prod 2 → 40, prod 1 → 30, prod 2 → 20.
//! Revenue grand total = 190; per product: 1 → 130, 2 → 60.

use std::collections::HashMap;
use std::sync::Arc;

use arrow::array::{Array, DictionaryArray, Float64Array, Int64Array, StringArray};
use arrow::datatypes::{DataType as ArrowType, Field, Int32Type, Schema};
use arrow::record_batch::RecordBatch;

use crate::{
    sum_measure, CalculationGroup, CalculationGroupApplication, CalculationItem, Column, ColumnRef,
    DataModel, DataType, Engine, QueryCacheConfig, QueryError, QueryRequest, Relationship,
    SourceBinding, StorageMode, Table,
};

// --- Fixtures ---

fn calc_group_model() -> DataModel {
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
        .add_calculation_group(CalculationGroup::new(
            "Time",
            vec![
                CalculationItem::from_text("Current", "SELECTEDMEASURE()").unwrap(),
                CalculationItem::from_text("Doubled", "SELECTEDMEASURE() * 2").unwrap(),
            ],
        ))
        .build()
        .unwrap()
}

fn sales_batch() -> RecordBatch {
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
    .unwrap()
}

fn product_batch() -> RecordBatch {
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
    .unwrap()
}

fn calc_group_engine() -> Engine {
    let mut engine = Engine::new(calc_group_model());
    engine.bind_table("Sales", 0, SourceBinding::new("public", "sales"));
    engine.bind_table("Product", 0, SourceBinding::new("public", "product"));
    engine.cache.store("Sales", sales_batch()).unwrap();
    engine.cache.store("Product", product_batch()).unwrap();
    engine
}

// --- Result extraction helpers ---

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

fn scalar(batches: &[RecordBatch], col: &str) -> f64 {
    assert!(!batches.is_empty(), "no batches");
    let b = &batches[0];
    assert!(b.num_rows() >= 1, "no rows");
    as_f64(b.column(col_idx(b, col)).as_ref(), 0)
}

fn grouped(batches: &[RecordBatch], group_col: &str, measure_col: &str) -> HashMap<String, f64> {
    let mut out = HashMap::new();
    for b in batches {
        let g = b.column(col_idx(b, group_col));
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

// --- Tests ---

#[tokio::test]
async fn applies_items_to_single_measure_scalar() {
    let engine = calc_group_engine();
    let batches = engine
        .query(QueryRequest {
            measures: vec!["Revenue".into()],
            calculation_group: Some(CalculationGroupApplication::new(
                "Time",
                vec!["Current".into(), "Doubled".into()],
            )),
            ..Default::default()
        })
        .await
        .unwrap();

    // Two result value columns, named "{measure} [{item}]".
    assert!((scalar(&batches, "Revenue [Current]") - 190.0).abs() < 1e-9);
    assert!((scalar(&batches, "Revenue [Doubled]") - 380.0).abs() < 1e-9);
}

// The auto-tier query path must also expand calc groups — otherwise a
// calc-group request through query_auto_tier would silently return only the
// base measures.
#[tokio::test]
async fn query_auto_tier_expands_calculation_group() {
    let mut engine = calc_group_engine();
    let (batches, _tiered) = engine
        .query_auto_tier(QueryRequest {
            measures: vec!["Revenue".into()],
            calculation_group: Some(CalculationGroupApplication::new(
                "Time",
                vec!["Current".into(), "Doubled".into()],
            )),
            ..Default::default()
        })
        .await
        .unwrap();
    assert!((scalar(&batches, "Revenue [Current]") - 190.0).abs() < 1e-9);
    assert!((scalar(&batches, "Revenue [Doubled]") - 380.0).abs() < 1e-9);
}

#[tokio::test]
async fn empty_items_means_all_items_in_declaration_order() {
    let engine = calc_group_engine();
    let batches = engine
        .query(QueryRequest {
            measures: vec!["Revenue".into()],
            // Empty item list = all items in declaration order.
            calculation_group: Some(CalculationGroupApplication::new("Time", vec![])),
            ..Default::default()
        })
        .await
        .unwrap();
    let b = &batches[0];
    // Both Current and Doubled columns are present.
    assert!(b.schema().index_of("Revenue [Current]").is_ok());
    assert!(b.schema().index_of("Revenue [Doubled]").is_ok());
}

#[tokio::test]
async fn composes_with_group_by() {
    let engine = calc_group_engine();
    let batches = engine
        .query(QueryRequest {
            measures: vec!["Revenue".into()],
            group_by: vec![ColumnRef::new("Product", "name")],
            calculation_group: Some(CalculationGroupApplication::new(
                "Time",
                vec!["Current".into(), "Doubled".into()],
            )),
            ..Default::default()
        })
        .await
        .unwrap();

    let current = grouped(&batches, "name", "Revenue [Current]");
    let doubled = grouped(&batches, "name", "Revenue [Doubled]");
    assert!((current["Bikes"] - 130.0).abs() < 1e-9);
    assert!((current["Helmets"] - 60.0).abs() < 1e-9);
    assert!((doubled["Bikes"] - 260.0).abs() < 1e-9);
    assert!((doubled["Helmets"] - 120.0).abs() < 1e-9);
}

#[tokio::test]
async fn multiple_measures_are_measures_outer_items_inner() {
    let engine = calc_group_engine();
    let batches = engine
        .query(QueryRequest {
            measures: vec!["Revenue".into(), "Cost".into()],
            calculation_group: Some(CalculationGroupApplication::new(
                "Time",
                vec!["Current".into(), "Doubled".into()],
            )),
            ..Default::default()
        })
        .await
        .unwrap();
    let b = &batches[0];
    let names: Vec<String> = b
        .schema()
        .fields()
        .iter()
        .map(|f| f.name().clone())
        .collect();
    // Measures-outer / items-inner ordering of the value columns.
    assert_eq!(
        names,
        vec![
            "Revenue [Current]",
            "Revenue [Doubled]",
            "Cost [Current]",
            "Cost [Doubled]",
        ]
    );
    // Cost grand total = 60+25+15+10 = 110; Doubled = 220.
    assert!((scalar(&batches, "Cost [Current]") - 110.0).abs() < 1e-9);
    assert!((scalar(&batches, "Cost [Doubled]") - 220.0).abs() < 1e-9);
}

#[tokio::test]
async fn unknown_group_is_typed_error() {
    let engine = calc_group_engine();
    let err = engine
        .query(QueryRequest {
            measures: vec!["Revenue".into()],
            calculation_group: Some(CalculationGroupApplication::new("Nope", vec![])),
            ..Default::default()
        })
        .await
        .unwrap_err();
    assert!(matches!(
        err,
        QueryError::Engine(crate::EngineError::CalculationGroupNotFound(_))
    ));
}

#[tokio::test]
async fn unknown_item_is_typed_error() {
    let engine = calc_group_engine();
    let err = engine
        .query(QueryRequest {
            measures: vec!["Revenue".into()],
            calculation_group: Some(CalculationGroupApplication::new(
                "Time",
                vec!["Nope".into()],
            )),
            ..Default::default()
        })
        .await
        .unwrap_err();
    assert!(matches!(
        err,
        QueryError::Engine(crate::EngineError::InvalidData(_))
    ));
}

#[tokio::test]
async fn unknown_measure_is_typed_error() {
    let engine = calc_group_engine();
    let err = engine
        .query(QueryRequest {
            measures: vec!["Nope".into()],
            calculation_group: Some(CalculationGroupApplication::new("Time", vec![])),
            ..Default::default()
        })
        .await
        .unwrap_err();
    assert!(matches!(
        err,
        QueryError::Engine(crate::EngineError::MeasureNotFound(_))
    ));
}

// --- Cache-key sensitivity ---

#[tokio::test]
async fn cache_serves_same_application_and_distinguishes_different_ones() {
    let mut engine = calc_group_engine();
    engine.set_query_cache_config(QueryCacheConfig {
        enabled: true,
        ..Default::default()
    });

    let req = |items: Vec<String>| QueryRequest {
        measures: vec!["Revenue".into()],
        calculation_group: Some(CalculationGroupApplication::new("Time", items)),
        ..Default::default()
    };

    // First run (miss), second identical run (hit).
    let _ = engine.query(req(vec!["Current".into()])).await.unwrap();
    let stats_before = engine.query_cache_stats();
    let _ = engine.query(req(vec!["Current".into()])).await.unwrap();
    let stats_after = engine.query_cache_stats();
    assert_eq!(
        stats_after.hits,
        stats_before.hits + 1,
        "identical application should hit the cache"
    );

    // A different item selection must not be served the prior result: it
    // misses and produces its own column.
    let batches = engine.query(req(vec!["Doubled".into()])).await.unwrap();
    assert!(batches[0].schema().index_of("Revenue [Doubled]").is_ok());
    // The original cache entry for [Current] is still independently valid.
    let batches_current = engine.query(req(vec!["Current".into()])).await.unwrap();
    assert!(batches_current[0]
        .schema()
        .index_of("Revenue [Current]")
        .is_ok());
}
