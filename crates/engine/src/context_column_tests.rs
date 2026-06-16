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
    DataModel, DataType, DetailRequest, Engine, Expression, FilterCondition, FilterOperator,
    InFilter, Measure, QueryError, QueryRequest, Relationship, SecurityRole, SourceBinding,
    StorageMode, Table, TotalsMode,
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

// ---- interdependent (DAG) context columns ----

/// `PaymentStatus` (Paid/Open as of 2024-03-31) plus `PaidTier`, which
/// **references** PaymentStatus: BigPaid when Paid and amount >= 50, else Other.
fn dag_model() -> DataModel {
    let in_mem = |t: Table| t.with_storage_mode(StorageMode::InMemory);
    let paid_tier = expr::if_expr(
        expr::and(
            expr::compare(
                expr::qualified_col("Invoice", "PaymentStatus"),
                ComparisonOp::Equal,
                expr::lit_str("Paid"),
            ),
            expr::compare(
                expr::qualified_col("Invoice", "amount"),
                ComparisonOp::GreaterThanOrEqual,
                expr::lit(50.0),
            ),
        ),
        expr::lit_str("BigPaid"),
        expr::lit_str("Other"),
    );
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
            Table::new("Calendar", vec![Column::new("date", DataType::Date)]).unwrap(),
        ))
        .add_measure(sum_measure("Revenue", "Invoice", "amount"))
        .add_measure(Measure::new(
            "AsOfDate",
            expr::agg(AggregateOp::Max, expr::qualified_col("Calendar", "date")),
        ))
        .add_context_column(ContextColumn::new(
            "PaymentStatus",
            "Invoice",
            payment_status_expr(),
            DataType::String,
        ))
        .add_context_column(ContextColumn::new(
            "PaidTier",
            "Invoice",
            paid_tier,
            DataType::String,
        ))
        .build()
        .unwrap()
}

fn dag_engine(model: DataModel) -> Engine {
    let mut engine = Engine::new(model);
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
                Arc::new(Schema::new(vec![Field::new("date", ArrowType::Date32, true)])),
                vec![Arc::new(Date32Array::from(vec![days(2024, 3, 31)]))],
            )
            .unwrap(),
        )
        .unwrap();
    engine
}

#[tokio::test]
async fn context_column_references_another_context_column() {
    // PaidTier inlines PaymentStatus. Paid (as of 2024-03-31): 100, 50; of
    // those amount >= 50 -> BigPaid (150). The rest -> Other (30 + 20).
    let engine = dag_engine(dag_model());
    let batches = engine
        .query(QueryRequest {
            measures: vec!["Revenue".into()],
            group_by: vec![ColumnRef::new("Invoice", "PaidTier")],
            ..Default::default()
        })
        .await
        .unwrap();
    // Reuse by_status by reading the PaidTier column.
    let mut out = HashMap::new();
    for b in &batches {
        let g = b.column(col_idx(b, "PaidTier"));
        let m = b.column(col_idx(b, "Revenue"));
        let amt = m.as_any().downcast_ref::<Float64Array>().unwrap();
        for row in 0..b.num_rows() {
            out.insert(str_key(g.as_ref(), row), amt.value(row));
        }
    }
    assert_eq!(out["BigPaid"], 150.0);
    assert_eq!(out["Other"], 50.0);
}

#[tokio::test]
async fn circular_context_column_references_fail_closed() {
    // A references B, B references A. The model builds (cycles are caught at
    // query time), but querying either fails closed rather than recursing.
    let in_mem = |t: Table| t.with_storage_mode(StorageMode::InMemory);
    let a = expr::if_expr(
        expr::compare(
            expr::qualified_col("Invoice", "B"),
            ComparisonOp::Equal,
            expr::lit_str("x"),
        ),
        expr::lit_str("a1"),
        expr::lit_str("a2"),
    );
    let b = expr::if_expr(
        expr::compare(
            expr::qualified_col("Invoice", "A"),
            ComparisonOp::Equal,
            expr::lit_str("y"),
        ),
        expr::lit_str("b1"),
        expr::lit_str("b2"),
    );
    let model = DataModel::builder()
        .add_table(in_mem(
            Table::new("Invoice", vec![Column::new("amount", DataType::Float64)]).unwrap(),
        ))
        .add_measure(sum_measure("Revenue", "Invoice", "amount"))
        .add_context_column(ContextColumn::new("A", "Invoice", a, DataType::String))
        .add_context_column(ContextColumn::new("B", "Invoice", b, DataType::String))
        .build()
        .unwrap();
    let engine = {
        let mut e = Engine::new(model);
        e.bind_table("Invoice", 0, SourceBinding::new("public", "invoice"));
        e.cache
            .store(
                "Invoice",
                RecordBatch::try_new(
                    Arc::new(Schema::new(vec![Field::new("amount", ArrowType::Float64, true)])),
                    vec![Arc::new(Float64Array::from(vec![1.0]))],
                )
                .unwrap(),
            )
            .unwrap();
        e
    };
    let err = engine
        .query(QueryRequest {
            measures: vec!["Revenue".into()],
            group_by: vec![ColumnRef::new("Invoice", "A")],
            ..Default::default()
        })
        .await
        .unwrap_err();
    assert!(
        matches!(err, QueryError::Engine(_) | QueryError::InvalidQuery(_)),
        "got: {err:?}"
    );
}

// ---- drillthrough: context columns as detail outputs ----

/// `amount -> PaymentStatus` across raw detail rows.
fn detail_amount_status(batches: &[RecordBatch]) -> HashMap<i64, String> {
    let mut out = HashMap::new();
    for b in batches {
        let a = b.column(col_idx(b, "amount"));
        let s = b.column(col_idx(b, "PaymentStatus"));
        let amounts = a.as_any().downcast_ref::<Float64Array>().expect("amount f64");
        for row in 0..b.num_rows() {
            out.insert(amounts.value(row) as i64, str_key(s.as_ref(), row));
        }
    }
    out
}

#[tokio::test]
async fn drillthrough_computes_context_column_per_row() {
    // Drill into the Paid/Open segmentation: each raw invoice row gets its
    // PaymentStatus as of 2024-03-31. 100 + 50 paid; 30 + 20 open.
    let engine = ctx_engine();
    let req = DetailRequest::new("Invoice", 10)
        .with_context_columns(vec![ColumnRef::new("Invoice", "PaymentStatus")]);
    let batches = engine.query_rows(req).await.unwrap();
    let row_count: usize = batches.iter().map(|b| b.num_rows()).sum();
    assert_eq!(row_count, 4, "limit not exceeded, no rows dropped or added");
    let m = detail_amount_status(&batches);
    assert_eq!(m[&100], "Paid");
    assert_eq!(m[&50], "Paid");
    assert_eq!(m[&30], "Open");
    assert_eq!(m[&20], "Open");
}

#[tokio::test]
async fn drillthrough_context_column_under_role_no_leak() {
    // A role restricts Invoice to amount >= 30 (excludes the 20 row). A
    // drillthrough with the PaymentStatus context column must return only the
    // permitted rows, each correctly labeled, and never leak the excluded row.
    let mut engine = Engine::new(
        DataModel::builder()
            .add_table(
                Table::new(
                    "Invoice",
                    vec![
                        Column::new("paid_date", DataType::Date),
                        Column::new("amount", DataType::Float64),
                    ],
                )
                .unwrap()
                .with_storage_mode(StorageMode::InMemory),
            )
            .add_table(
                Table::new("Calendar", vec![Column::new("date", DataType::Date)])
                    .unwrap()
                    .with_storage_mode(StorageMode::InMemory),
            )
            .add_measure(sum_measure("Revenue", "Invoice", "amount"))
            .add_measure(Measure::new(
                "AsOfDate",
                expr::agg(AggregateOp::Max, expr::qualified_col("Calendar", "date")),
            ))
            .add_context_column(ContextColumn::new(
                "PaymentStatus",
                "Invoice",
                payment_status_expr(),
                DataType::String,
            ))
            .add_security_role(SecurityRole::new("Big").with_filter(
                "Invoice",
                "amount",
                ComparisonOp::GreaterThanOrEqual,
                "30",
            ))
            .build()
            .unwrap(),
    );
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
                Arc::new(Schema::new(vec![Field::new("date", ArrowType::Date32, true)])),
                vec![Arc::new(Date32Array::from(vec![days(2024, 3, 31)]))],
            )
            .unwrap(),
        )
        .unwrap();
    engine.set_active_role(Some("Big".into()));

    let req = DetailRequest::new("Invoice", 10)
        .with_context_columns(vec![ColumnRef::new("Invoice", "PaymentStatus")]);
    let batches = engine.query_rows(req).await.unwrap();
    let row_count: usize = batches.iter().map(|b| b.num_rows()).sum();
    assert_eq!(row_count, 3, "role excludes the amount=20 row");
    let m = detail_amount_status(&batches);
    assert_eq!(m[&100], "Paid");
    assert_eq!(m[&50], "Paid");
    assert_eq!(m[&30], "Open");
    assert!(!m.contains_key(&20), "excluded row must not leak: {m:?}");
}

#[tokio::test]
async fn drillthrough_rejects_unknown_context_column() {
    let engine = ctx_engine();
    let req = DetailRequest::new("Invoice", 10)
        .with_context_columns(vec![ColumnRef::new("Invoice", "amount")]); // physical, not a ctx col
    let err = engine.query_rows(req).await.unwrap_err();
    assert!(matches!(err, QueryError::InvalidQuery(_)), "got: {err:?}");
}

// ---- v2: cross-table references ----
//
// Invoice (paid_date, amount, customer_id) -> Customer (id, tier) ManyToOne,
// plus the disconnected Calendar. Context column:
//   PaidTier = IF(Invoice[paid_date] <= [AsOfDate], Customer[tier], "Unpaid")
// Paid invoices are segmented by their customer's tier; unpaid ones lumped.

/// `Revenue` summed across all rows (any group), to test row integrity.
fn total_revenue(batches: &[RecordBatch]) -> f64 {
    let mut sum = 0.0;
    for b in batches {
        let m = b.column(col_idx(b, "Revenue"));
        for row in 0..b.num_rows() {
            if let Some(a) = m.as_any().downcast_ref::<Float64Array>() {
                if !a.is_null(row) {
                    sum += a.value(row);
                }
            }
        }
    }
    sum
}

/// `PaidTier -> Revenue` (NULL group key folded to "(null)").
fn by_paid_tier(batches: &[RecordBatch]) -> HashMap<String, f64> {
    let mut out = HashMap::new();
    for b in batches {
        let g = b.column(col_idx(b, "PaidTier"));
        let m = b.column(col_idx(b, "Revenue"));
        for row in 0..b.num_rows() {
            let key = if g.is_null(row) {
                "(null)".to_string()
            } else {
                str_key(g.as_ref(), row)
            };
            let v = m
                .as_any()
                .downcast_ref::<Float64Array>()
                .map(|a| a.value(row))
                .expect("float measure");
            *out.entry(key).or_insert(0.0) += v;
        }
    }
    out
}

fn cross_table_model() -> DataModel {
    let in_mem = |t: Table| t.with_storage_mode(StorageMode::InMemory);
    let paid_tier = expr::if_expr(
        expr::compare(
            expr::qualified_col("Invoice", "paid_date"),
            ComparisonOp::LessThanOrEqual,
            Expression::MeasureRef("AsOfDate".into()),
        ),
        expr::qualified_col("Customer", "tier"),
        expr::lit_str("Unpaid"),
    );
    DataModel::builder()
        .add_table(in_mem(
            Table::new(
                "Invoice",
                vec![
                    Column::new("paid_date", DataType::Date),
                    Column::new("amount", DataType::Float64),
                    Column::new("customer_id", DataType::Int64),
                ],
            )
            .unwrap(),
        ))
        .add_table(in_mem(
            Table::new(
                "Customer",
                vec![
                    Column::new("id", DataType::Int64),
                    Column::new("tier", DataType::String),
                ],
            )
            .unwrap(),
        ))
        .add_table(in_mem(
            Table::new(
                "Calendar",
                vec![Column::new("date", DataType::Date)],
            )
            .unwrap(),
        ))
        .add_relationship(Relationship::many_to_one(
            "Invoice_Customer",
            "Invoice",
            "customer_id",
            "Customer",
            "id",
        ))
        .add_measure(sum_measure("Revenue", "Invoice", "amount"))
        .add_measure(Measure::new(
            "AsOfDate",
            expr::agg(AggregateOp::Max, expr::qualified_col("Calendar", "date")),
        ))
        .add_context_column(ContextColumn::new(
            "PaidTier",
            "Invoice",
            paid_tier,
            DataType::String,
        ))
        .build()
        .unwrap()
}

/// `with_orphan` adds a 5th invoice whose customer_id (99) has no Customer row.
fn cross_table_engine(with_orphan: bool) -> Engine {
    let mut engine = Engine::new(cross_table_model());
    for t in ["Invoice", "Customer", "Calendar"] {
        engine.bind_table(t, 0, SourceBinding::new("public", &t.to_lowercase()));
    }
    let (mut dates, mut amounts, mut custs) = (
        vec![days(2024, 1, 15), days(2024, 3, 15), days(2024, 6, 15), days(2024, 12, 15)],
        vec![100.0, 50.0, 30.0, 20.0],
        vec![1i64, 2, 1, 2],
    );
    if with_orphan {
        dates.push(days(2024, 2, 15));
        amounts.push(70.0);
        custs.push(99);
    }
    engine
        .cache
        .store(
            "Invoice",
            RecordBatch::try_new(
                Arc::new(Schema::new(vec![
                    Field::new("paid_date", ArrowType::Date32, true),
                    Field::new("amount", ArrowType::Float64, true),
                    Field::new("customer_id", ArrowType::Int64, true),
                ])),
                vec![
                    Arc::new(Date32Array::from(dates)),
                    Arc::new(Float64Array::from(amounts)),
                    Arc::new(Int64Array::from(custs)),
                ],
            )
            .unwrap(),
        )
        .unwrap();
    engine
        .cache
        .store(
            "Customer",
            RecordBatch::try_new(
                Arc::new(Schema::new(vec![
                    Field::new("id", ArrowType::Int64, true),
                    Field::new("tier", ArrowType::Utf8, true),
                ])),
                vec![
                    Arc::new(Int64Array::from(vec![1i64, 2])),
                    Arc::new(StringArray::from(vec!["Gold", "Silver"])),
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
                Arc::new(Schema::new(vec![Field::new("date", ArrowType::Date32, true)])),
                vec![Arc::new(Date32Array::from(vec![
                    days(2024, 1, 31),
                    days(2024, 2, 29),
                    days(2024, 3, 31),
                ]))],
            )
            .unwrap(),
        )
        .unwrap();
    engine
}

fn group_by_paid_tier() -> QueryRequest {
    QueryRequest {
        measures: vec!["Revenue".into()],
        group_by: vec![ColumnRef::new("Invoice", "PaidTier")],
        ..Default::default()
    }
}

#[tokio::test]
async fn cross_table_segmentation_by_customer_tier() {
    // AsOfDate = 2024-03-31. Paid invoices: 100 (Gold), 50 (Silver). Unpaid:
    // 30 + 20.
    let engine = cross_table_engine(false);
    let r = by_paid_tier(&engine.query(group_by_paid_tier()).await.unwrap());
    assert_eq!(r["Gold"], 100.0);
    assert_eq!(r["Silver"], 50.0);
    assert_eq!(r["Unpaid"], 50.0);
}

/// Like `cross_table_model` but with a security role restricting Customer to
/// the `Gold` tier (so only customer 1 is visible).
fn rls_cross_table_model() -> DataModel {
    let in_mem = |t: Table| t.with_storage_mode(StorageMode::InMemory);
    let paid_tier = expr::if_expr(
        expr::compare(
            expr::qualified_col("Invoice", "paid_date"),
            ComparisonOp::LessThanOrEqual,
            Expression::MeasureRef("AsOfDate".into()),
        ),
        expr::qualified_col("Customer", "tier"),
        expr::lit_str("Unpaid"),
    );
    DataModel::builder()
        .add_table(in_mem(
            Table::new(
                "Invoice",
                vec![
                    Column::new("paid_date", DataType::Date),
                    Column::new("amount", DataType::Float64),
                    Column::new("customer_id", DataType::Int64),
                ],
            )
            .unwrap(),
        ))
        .add_table(in_mem(
            Table::new(
                "Customer",
                vec![
                    Column::new("id", DataType::Int64),
                    Column::new("tier", DataType::String),
                ],
            )
            .unwrap(),
        ))
        .add_table(in_mem(
            Table::new("Calendar", vec![Column::new("date", DataType::Date)]).unwrap(),
        ))
        .add_relationship(Relationship::many_to_one(
            "Invoice_Customer",
            "Invoice",
            "customer_id",
            "Customer",
            "id",
        ))
        .add_measure(sum_measure("Revenue", "Invoice", "amount"))
        .add_measure(Measure::new(
            "AsOfDate",
            expr::agg(AggregateOp::Max, expr::qualified_col("Calendar", "date")),
        ))
        .add_context_column(ContextColumn::new(
            "PaidTier",
            "Invoice",
            paid_tier,
            DataType::String,
        ))
        .add_security_role(SecurityRole::new("GoldOnly").with_filter(
            "Customer",
            "tier",
            ComparisonOp::Equal,
            "Gold",
        ))
        .build()
        .unwrap()
}

#[tokio::test]
async fn rls_on_referenced_table_restricts_the_fact_no_leak() {
    // Role GoldOnly restricts Customer to tier='Gold' (customer 1). A context
    // column references Customer[tier]. The role MUST restrict the fact to
    // customer 1's invoices — inv1 (100, Paid→Gold) and inv3 (30, Unpaid) —
    // NOT leak customer 2's invoices (Silver 50, Unpaid 20). Total = 130.
    let mut engine = Engine::new(rls_cross_table_model());
    for t in ["Invoice", "Customer", "Calendar"] {
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
                    Field::new("customer_id", ArrowType::Int64, true),
                ])),
                vec![
                    Arc::new(Date32Array::from(vec![
                        days(2024, 1, 15),
                        days(2024, 3, 15),
                        days(2024, 6, 15),
                        days(2024, 12, 15),
                    ])),
                    Arc::new(Float64Array::from(vec![100.0, 50.0, 30.0, 20.0])),
                    Arc::new(Int64Array::from(vec![1i64, 2, 1, 2])),
                ],
            )
            .unwrap(),
        )
        .unwrap();
    engine
        .cache
        .store(
            "Customer",
            RecordBatch::try_new(
                Arc::new(Schema::new(vec![
                    Field::new("id", ArrowType::Int64, true),
                    Field::new("tier", ArrowType::Utf8, true),
                ])),
                vec![
                    Arc::new(Int64Array::from(vec![1i64, 2])),
                    Arc::new(StringArray::from(vec!["Gold", "Silver"])),
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
                Arc::new(Schema::new(vec![Field::new("date", ArrowType::Date32, true)])),
                vec![Arc::new(Date32Array::from(vec![
                    days(2024, 1, 31),
                    days(2024, 3, 31),
                ]))],
            )
            .unwrap(),
        )
        .unwrap();
    engine.set_active_role(Some("GoldOnly".into()));

    let batches = engine.query(group_by_paid_tier()).await.unwrap();
    let total = total_revenue(&batches);
    assert_eq!(
        total, 130.0,
        "role must restrict the fact to Gold-customer invoices (100+30), got {total}"
    );
    let r = by_paid_tier(&batches);
    assert_eq!(r.get("Gold"), Some(&100.0));
    assert_eq!(r.get("Unpaid"), Some(&30.0));
    assert!(r.get("Silver").is_none(), "Silver-customer rows must not leak: {r:?}");
}

#[tokio::test]
async fn left_join_keeps_unmatched_fact_rows_without_inflation() {
    // The Customer LEFT JOIN must keep an invoice whose customer is missing
    // (orphan FK) — an INNER JOIN would drop its $70 — and must not multiply
    // any fact row. Total revenue = 100+50+30+20+70 = 270 either way it must
    // hold; the orphan lands in the NULL-tier group.
    let engine = cross_table_engine(true);
    let batches = engine.query(group_by_paid_tier()).await.unwrap();
    assert_eq!(total_revenue(&batches), 270.0, "no rows dropped or duplicated");
    let r = by_paid_tier(&batches);
    assert_eq!(r["Gold"], 100.0);
    assert_eq!(r["Silver"], 50.0);
    assert_eq!(r["Unpaid"], 50.0);
    assert_eq!(r["(null)"], 70.0, "orphan-FK paid invoice kept with NULL tier");
}
