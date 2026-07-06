//! End-to-end CLEAR/RESET axis-clearing tests on the LOCAL (in-memory) path.
//!
//! Before the axis-clearing window render, CLEAR/RESET were silently ignored on
//! the local path, so a percent-of-total measure returned 1.0 for every row.
//! These tests pin the corrected behavior: `CLEAR`/`RESET` re-aggregate over the
//! surviving group-by partition (`OVER (PARTITION BY ...)`), giving true
//! percent-of-total; slicer-clearing fails closed; non-additive aggregates under
//! CLEAR fail closed.
//!
//! Fixture (mirrors `having_tests`): `Sales(prod_id, amount)` → `Product(id,
//! name)`. Per product — SUM(amount): Bikes 130, Helmets 60; grand total 190.

#![cfg(test)]

use std::collections::HashMap;
use std::sync::Arc;

use arrow::array::{Array, DictionaryArray, Float64Array, Int64Array, StringArray};
use arrow::datatypes::{DataType as ArrowType, Field, Int32Type, Schema};
use arrow::record_batch::RecordBatch;

use crate::{
    expression_measure, parse_measure, sum_measure, Column, ColumnRef, DataModel, DataType, Engine,
    FilterCondition, FilterOperator, QueryRequest, Relationship, SourceBinding, StorageMode, Table,
    TotalsMode,
};

fn clear_model() -> DataModel {
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
            "PctOfTotal",
            parse_measure("DIVIDE(SUM(Sales[amount]), SUM(Sales[amount], RESET()))").unwrap(),
        ))
        .add_measure(expression_measure(
            "PctOfTotalClear",
            parse_measure("DIVIDE(SUM(Sales[amount]), SUM(Sales[amount], CLEAR(Product)))")
                .unwrap(),
        ))
        .add_measure(expression_measure(
            "GrandTotal",
            parse_measure("SUM(Sales[amount], RESET())").unwrap(),
        ))
        .add_measure(expression_measure(
            "TotalViaClear",
            parse_measure("SUM(Sales[amount], CLEAR(Product))").unwrap(),
        ))
        .add_measure(expression_measure(
            "AvgClear",
            parse_measure("AVG(Sales[amount], CLEAR(Product))").unwrap(),
        ))
        .build()
        .unwrap()
}

fn clear_engine() -> Engine {
    let mut engine = Engine::new(clear_model());
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

fn col_idx(batch: &RecordBatch, name: &str) -> usize {
    batch
        .schema()
        .index_of(name)
        .unwrap_or_else(|_| panic!("column '{name}' not found in {:?}", batch.schema()))
}

fn as_f64(array: &dyn Array, row: usize) -> f64 {
    let a = array
        .as_any()
        .downcast_ref::<Float64Array>()
        .expect("f64 measure column");
    a.value(row)
}

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

fn request(measures: &[&str]) -> QueryRequest {
    QueryRequest {
        measures: measures.iter().map(|s| s.to_string()).collect(),
        group_by: vec![ColumnRef::new("Product", "name")],
        ..Default::default()
    }
}

#[tokio::test]
async fn reset_measure_broadcasts_grand_total_to_every_row() {
    // Regression: the local path used to ignore RESET and return each group's
    // own value. A bare CLEAR/RESET measure now renders as SUM(SUM(x)) OVER (),
    // so the 190 grand total appears in every group row.
    let engine = clear_engine();
    let batches = engine.query(request(&["GrandTotal"])).await.unwrap();
    let gt = grouped(&batches, "GrandTotal");
    assert!((gt["Bikes"] - 190.0).abs() < 1e-9, "got {}", gt["Bikes"]);
    assert!(
        (gt["Helmets"] - 190.0).abs() < 1e-9,
        "got {}",
        gt["Helmets"]
    );
}

#[tokio::test]
async fn clear_dimension_broadcasts_grand_total() {
    // CLEAR(Product) removes the only axis dimension → OVER () → grand total in
    // every row (not each group's own 130/60).
    let engine = clear_engine();
    let batches = engine.query(request(&["TotalViaClear"])).await.unwrap();
    let t = grouped(&batches, "TotalViaClear");
    assert!((t["Bikes"] - 190.0).abs() < 1e-9, "got {}", t["Bikes"]);
    assert!((t["Helmets"] - 190.0).abs() < 1e-9, "got {}", t["Helmets"]);
}

#[tokio::test]
async fn compound_percent_of_grand_total_via_reset() {
    // `DIVIDE(SUM(x), SUM(x, RESET()))` — the RESET grand total is rendered as
    // an uncorrelated scalar subquery, so the ratio is each product's share of
    // 190 (no longer a silent 1.0, and not a DataFusion window-nesting error).
    let engine = clear_engine();
    let batches = engine
        .query(request(&["Revenue", "PctOfTotal"]))
        .await
        .unwrap();
    let pct = grouped(&batches, "PctOfTotal");
    assert!(
        (pct["Bikes"] - 130.0 / 190.0).abs() < 1e-9,
        "Bikes share should be 130/190, got {}",
        pct["Bikes"]
    );
    assert!(
        (pct["Helmets"] - 60.0 / 190.0).abs() < 1e-9,
        "Helmets share should be 60/190, got {}",
        pct["Helmets"]
    );
    assert!(
        (pct["Bikes"] + pct["Helmets"] - 1.0).abs() < 1e-9,
        "shares sum to 1.0 (no longer both 1.0)"
    );
}

#[tokio::test]
async fn reset_with_slicer_on_cleared_table_fails_closed() {
    // A slicer on Product + RESET (which must remove it under REMOVEFILTERS
    // semantics) is not yet supported → typed error, never a silently
    // slicer-respecting number.
    let engine = clear_engine();
    let mut req = request(&["Revenue", "PctOfTotal"]);
    req.filters = vec![FilterCondition::new("name", FilterOperator::Equal, "Bikes")];
    let err = engine.query(req).await;
    assert!(err.is_err(), "RESET over a sliced table must fail closed");
    let msg = format!("{}", err.unwrap_err());
    assert!(
        msg.contains("slicer"),
        "error should mention the slicer restriction, got: {msg}"
    );
}

#[tokio::test]
async fn non_additive_aggregate_under_clear_fails_closed() {
    // AVG cannot be recombined from per-group values over the cleared partition.
    let engine = clear_engine();
    let err = engine.query(request(&["AvgClear"])).await;
    assert!(err.is_err(), "AVG under CLEAR must fail closed");
    let msg = format!("{}", err.unwrap_err());
    assert!(
        msg.to_uppercase().contains("SUM") || msg.contains("recombined"),
        "error should explain the additive-only restriction, got: {msg}"
    );
}

#[tokio::test]
async fn plain_revenue_unaffected_alongside_bare_clear() {
    // A plain measure and a bare CLEAR/RESET measure coexist: Revenue is
    // per-group, GrandTotal is the broadcast total.
    let engine = clear_engine();
    let mut req = request(&["Revenue", "GrandTotal"]);
    req.totals = TotalsMode::None;
    let batches = engine.query(req).await.unwrap();
    let rev = grouped(&batches, "Revenue");
    let gt = grouped(&batches, "GrandTotal");
    assert!((rev["Bikes"] - 130.0).abs() < 1e-9);
    assert!((rev["Helmets"] - 60.0).abs() < 1e-9);
    assert!((gt["Bikes"] - 190.0).abs() < 1e-9);
    assert!((gt["Helmets"] - 190.0).abs() < 1e-9);
}

// --- Percent-of-parent fixture: 3 products across 2 categories -------------
// Product(id, category, name): 1 Bikes/Road, 2 Bikes/Trail, 3 Safety/Helmet.
// Sales SUM(amount): Road 100, Trail 50, Helmet 30.
// Category totals: Bikes 150, Safety 30.

fn parent_engine() -> Engine {
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
                    Column::new("category", DataType::String),
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
            "PctOfParent",
            parse_measure(
                "DIVIDE(SUM(Sales[amount]), \
                 SUM(Sales[amount], CLEAREXCEPT(Product, Product[category])))",
            )
            .unwrap(),
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
                    Arc::new(Int64Array::from(vec![1, 2, 3])),
                    Arc::new(Float64Array::from(vec![100.0, 50.0, 30.0])),
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
                    Field::new("category", ArrowType::Utf8, true),
                    Field::new("name", ArrowType::Utf8, true),
                ])),
                vec![
                    Arc::new(Int64Array::from(vec![1, 2, 3])),
                    Arc::new(StringArray::from(vec!["Bikes", "Bikes", "Safety"])),
                    Arc::new(StringArray::from(vec!["Road", "Trail", "Helmet"])),
                ],
            )
            .unwrap(),
        )
        .unwrap();
    engine
}

#[tokio::test]
async fn percent_of_parent_partitions_by_category() {
    // DIVIDE(SUM(x), SUM(x, CLEAREXCEPT(Product, category))) — each product's
    // share of its CATEGORY total (a partitioned window), via the two-level
    // query. Road 100/150, Trail 50/150, Helmet 30/30.
    let engine = parent_engine();
    let req = QueryRequest {
        measures: vec!["Revenue".into(), "PctOfParent".into()],
        group_by: vec![
            ColumnRef::new("Product", "category"),
            ColumnRef::new("Product", "name"),
        ],
        ..Default::default()
    };
    let batches = engine.query(req).await.unwrap();
    let pct = grouped(&batches, "PctOfParent");
    assert!(
        (pct["Road"] - 100.0 / 150.0).abs() < 1e-9,
        "Road {}",
        pct["Road"]
    );
    assert!(
        (pct["Trail"] - 50.0 / 150.0).abs() < 1e-9,
        "Trail {}",
        pct["Trail"]
    );
    assert!(
        (pct["Helmet"] - 1.0).abs() < 1e-9,
        "Helmet {}",
        pct["Helmet"]
    );
    // The two Bikes products' shares sum to 1.0 within their category.
    assert!((pct["Road"] + pct["Trail"] - 1.0).abs() < 1e-9);
}
