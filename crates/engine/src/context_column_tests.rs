//! End-to-end tests for context-driven calculated columns
//! ([`ContextColumn`]).
//!
//! Fixture: an in-memory `Invoice(paid_date, amount)` fact and a **disconnected**
//! `Calendar(date, period)` reference table (no relationship — `Calendar` is the
//! as-of reference, sliced independently). A scalar measure
//! `AsOfDate = MAX(Calendar[date])` and a context column
//! `PaymentStatus = IF(Invoice[paid_date] <= [AsOfDate], "Paid", "Open")`.
//!
//! Invoice rows (paid_date, amount): (2024-01-15, 100), (2024-03-15, 50),
//! (2024-06-15, 30), (2024-12-15, 20). Calendar dates: 2024-01-31 (period 1),
//! 2024-02-29 (period 2), 2024-03-31 (period 3).
//!
//! With no slice, `AsOfDate = 2024-03-31` → Paid = 150 (the first two), Open =
//! 50. Slicing `Calendar[period] = 1` moves `AsOfDate` to 2024-01-31 → Paid =
//! 100, Open = 100 — dynamic segmentation that re-derives from the filters.

#![cfg(test)]

use std::collections::HashMap;
use std::sync::Arc;

use arrow::array::{Array, Date32Array, DictionaryArray, Float64Array, Int32Array, Int64Array,
    StringArray};
use arrow::datatypes::{DataType as ArrowType, Field, Int32Type, Schema};
use arrow::record_batch::RecordBatch;
use chrono::NaiveDate;

use crate::{
    expression as expr, sum_measure, AggregateOp, Column, ColumnRef, ComparisonOp, ContextColumn,
    DataModel, DataType, Engine, Expression, FilterCondition, FilterOperator, InFilter, Measure,
    QueryError, QueryRequest, SourceBinding, StorageMode, Table, TotalsMode,
};

/// Days since the Unix epoch for a calendar date (a `Date32` value).
fn days(y: i32, m: u32, d: u32) -> i32 {
    let epoch = NaiveDate::from_ymd_opt(1970, 1, 1).unwrap();
    NaiveDate::from_ymd_opt(y, m, d)
        .unwrap()
        .signed_duration_since(epoch)
        .num_days() as i32
}

/// `IF(Invoice[paid_date] <= [AsOfDate], "Paid", "Open")`.
fn payment_status_expr() -> Expression {
    expr::if_expr(
        expr::compare(
            expr::qualified_col("Invoice", "paid_date"),
            ComparisonOp::LessThanOrEqual,
            Expression::MeasureRef("AsOfDate".into()),
        ),
        expr::lit_str("Paid"),
        expr::lit_str("Open"),
    )
}

fn ctx_model() -> DataModel {
    let in_mem = |t: Table| t.with_storage_mode(StorageMode::InMemory);
    DataModel::builder()
        .add_table(in_mem(
            Table::new(
                "Invoice",
                vec![
                    Column::new("paid_date", DataType::Date),
                    Column::new("amount", DataType::Float64),
                ],
            )
            .unwrap(),
        ))
        .add_table(in_mem(
            Table::new(
                "Calendar",
                vec![
                    Column::new("date", DataType::Date),
                    Column::new("period", DataType::Int32),
                ],
            )
            .unwrap(),
        ))
        .add_measure(sum_measure("Revenue", "Invoice", "amount"))
        .add_measure(Measure::new(
            "AsOfDate",
            expr::agg(AggregateOp::Max, expr::qualified_col("Calendar", "date")),
        ))
        .add_context_column(
            ContextColumn::new(
                "PaymentStatus",
                "Invoice",
                payment_status_expr(),
                DataType::String,
            )
            .with_description("Paid or Open relative to the as-of date"),
        )
        .build()
        .unwrap()
}

fn ctx_engine() -> Engine {
    let mut engine = Engine::new(ctx_model());
    for t in ["Invoice", "Calendar"] {
        engine.bind_table(t, 0, SourceBinding::new("public", &t.to_lowercase()));
    }
    engine
        .cache
        .store(
            "Invoice",
            RecordBatch::try_new(
                Arc::new(Schema::new(vec![
                    Field::new("paid_date", ArrowType::Date32, true),
                    Field::new("amount", ArrowType::Float64, true),
                ])),
                vec![
                    Arc::new(Date32Array::from(vec![
                        days(2024, 1, 15),
                        days(2024, 3, 15),
                        days(2024, 6, 15),
                        days(2024, 12, 15),
                    ])),
                    Arc::new(Float64Array::from(vec![100.0, 50.0, 30.0, 20.0])),
                ],
            )
            .unwrap(),
        )
        .unwrap();
    engine
        .cache
        .store(
            "Calendar",
            RecordBatch::try_new(
                Arc::new(Schema::new(vec![
                    Field::new("date", ArrowType::Date32, true),
                    Field::new("period", ArrowType::Int32, true),
                ])),
                vec![
                    Arc::new(Date32Array::from(vec![
                        days(2024, 1, 31),
                        days(2024, 2, 29),
                        days(2024, 3, 31),
                    ])),
                    Arc::new(Int32Array::from(vec![1, 2, 3])),
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

/// `PaymentStatus -> Revenue`.
fn by_status(batches: &[RecordBatch]) -> HashMap<String, f64> {
    let mut out = HashMap::new();
    for b in batches {
        let g = b.column(col_idx(b, "PaymentStatus"));
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

fn group_by_status(filters: Vec<FilterCondition>) -> QueryRequest {
    QueryRequest {
        measures: vec!["Revenue".into()],
        group_by: vec![ColumnRef::new("Invoice", "PaymentStatus")],
        filters,
        ..Default::default()
    }
}

#[tokio::test]
async fn segments_by_as_of_date() {
    // No slice: AsOfDate = MAX(Calendar) = 2024-03-31 → Paid = 100 + 50,
    // Open = 30 + 20.
    let engine = ctx_engine();
    let r = by_status(&engine.query(group_by_status(vec![])).await.unwrap());
    assert_eq!(r["Paid"], 150.0);
    assert_eq!(r["Open"], 50.0);
}

#[tokio::test]
async fn segmentation_follows_the_as_of_slice() {
    // Slice Calendar[period] = 1 → AsOfDate = MAX over period 1 = 2024-01-31.
    // Only the 2024-01-15 invoice is Paid (100); the rest are Open (100).
    // Calendar is disconnected from Invoice, so the slice moves the as-of date
    // without restricting the invoices themselves.
    let engine = ctx_engine();
    let r = by_status(
        &engine
            .query(group_by_status(vec![FilterCondition::new(
                "period",
                FilterOperator::Equal,
                "1",
            )]))
            .await
            .unwrap(),
    );
    assert_eq!(r["Paid"], 100.0);
    assert_eq!(r["Open"], 100.0);
}

#[tokio::test]
async fn cache_does_not_serve_a_stale_segmentation() {
    // The same engine answers both slices: the result cache must key on the
    // filters (which determine the as-of scalar), not blindly on the group-by
    // shape. If it served the first answer for the second slice, the split
    // would be wrong.
    let engine = ctx_engine();
    let unsliced = by_status(&engine.query(group_by_status(vec![])).await.unwrap());
    assert_eq!(unsliced["Paid"], 150.0);
    let sliced = by_status(
        &engine
            .query(group_by_status(vec![FilterCondition::new(
                "period",
                FilterOperator::Equal,
                "1",
            )]))
            .await
            .unwrap(),
    );
    assert_eq!(sliced["Paid"], 100.0);
    // And back again — the unsliced answer is still correct (not overwritten).
    let unsliced_again = by_status(&engine.query(group_by_status(vec![])).await.unwrap());
    assert_eq!(unsliced_again["Paid"], 150.0);
    assert_eq!(unsliced_again["Open"], 50.0);
}

#[tokio::test]
async fn in_filter_slice_changes_segmentation_and_is_cache_keyed() {
    // The as-of slice via an IN-list (not a scalar filter) must move the
    // segmentation AND key the cache: in_filters were previously omitted from
    // the cache key, which would have served the unsliced split for the slice.
    let engine = ctx_engine();
    let unsliced = by_status(&engine.query(group_by_status(vec![])).await.unwrap());
    assert_eq!(unsliced["Paid"], 150.0);
    // period IN (1) → AsOfDate = 2024-01-31 → Paid = 100.
    let req = QueryRequest {
        in_filters: vec![InFilter::new("period", ["1"])],
        ..group_by_status(vec![])
    };
    let sliced = by_status(&engine.query(req).await.unwrap());
    assert_eq!(sliced["Paid"], 100.0, "in_filter slice must move the as-of date");
    assert_eq!(sliced["Open"], 100.0);
}

#[tokio::test]
async fn rollup_with_context_column_fails_closed() {
    // ROLLUP subtotals over a per-query, context-resolved axis are not
    // supported in v1 — fail closed rather than return an ill-defined subtotal.
    let engine = ctx_engine();
    let request = QueryRequest {
        totals: TotalsMode::Rollup,
        ..group_by_status(vec![])
    };
    let err = engine.query(request).await.unwrap_err();
    assert!(matches!(err, QueryError::InvalidQuery(_)), "got: {err:?}");
}

#[tokio::test]
async fn metadata_tags_context_column_as_dimension() {
    let engine = ctx_engine();
    let (_b, cols) = engine
        .query_with_meta(group_by_status(vec![]))
        .await
        .unwrap();
    let status = cols
        .iter()
        .find(|c| c.name.eq_ignore_ascii_case("PaymentStatus"))
        .expect("PaymentStatus column");
    assert_eq!(status.source_table.as_deref(), Some("Invoice"));
    assert_eq!(
        status.description.as_deref(),
        Some("Paid or Open relative to the as-of date")
    );
}
