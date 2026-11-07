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
    FilterCondition, FilterOperator, QueryRequest, Relationship, ScopedFilter, SourceBinding,
    StorageMode, Table, TotalsMode,
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
        // A second share measure (a bare division, no DIVIDE): BUG-0444's
        // two-subqueries-in-one-query case.
        .add_measure(expression_measure(
            "ShareRatio",
            parse_measure("SUM(Sales[amount]) / SUM(Sales[amount], RESET())").unwrap(),
        ))
        .add_measure(expression_measure(
            "GrandTotal",
            parse_measure("SUM(Sales[amount], RESET())").unwrap(),
        ))
        .add_measure(expression_measure(
            "TotalViaClear",
            parse_measure("SUM(Sales[amount], CLEAR(Product))").unwrap(),
        ))
        // Escalated clear: reaches filters pinned at level 2.
        .add_measure(expression_measure(
            "TotalBustPin",
            parse_measure("SUM(Sales[amount], CLEAR(Product, LEVEL 2))").unwrap(),
        ))
        .add_measure(expression_measure(
            "AvgClear",
            parse_measure("AVG(Sales[amount], CLEAR(Product))").unwrap(),
        ))
        // DAX-compatible alias: parses to RESET_INNER (drop the group axis,
        // keep query-level slicers).
        .add_measure(expression_measure(
            "TotalAllSelected",
            parse_measure("SUM(Sales[amount], ALLSELECTED())").unwrap(),
        ))
        // ISFILTERED marker: folded to a literal per request at the facade.
        .add_measure(expression_measure(
            "NameFilteredFlag",
            parse_measure("IF(ISFILTERED(Product[name]), SUM(Sales[amount]), 0.0 - 1.0)").unwrap(),
        ))
        // DYNAMIC format string: evaluated once per query under the outer
        // filter context; overrides the static format in result metadata.
        .add_measure(
            expression_measure("FmtRevenue", parse_measure("SUM(Sales[amount])").unwrap())
                .with_format_string("static-fmt")
                .with_format_string_expression(
                    "IF(SUM(Sales[amount]) > 150, \"big-fmt\", \"small-fmt\")",
                ),
        )
        .build()
        .unwrap()
}

#[tokio::test]
async fn treatas_applies_disconnected_table_as_virtual_filter() {
    // Fact(currency, amount) + a DISCONNECTED Curr(code) table (no
    // relationship). TREATAS(Curr[code], Fact[currency]) restricts the fact
    // to the currencies visible in Curr — including a slicer on Curr[code].
    let model = DataModel::builder()
        .add_table(
            Table::new(
                "Fact",
                vec![
                    Column::new("currency", DataType::String),
                    Column::new("amount", DataType::Float64),
                ],
            )
            .unwrap()
            .with_storage_mode(StorageMode::InMemory),
        )
        .add_table(
            Table::new("Curr", vec![Column::new("code", DataType::String)])
                .unwrap()
                .with_storage_mode(StorageMode::InMemory),
        )
        .add_measure(expression_measure(
            "SelectedRevenue",
            parse_measure("SUM(Fact[amount], TREATAS(Curr[code], Fact[currency]))").unwrap(),
        ))
        .build()
        .unwrap();
    let mut engine = Engine::new(model);
    engine.bind_table("Fact", 0, SourceBinding::new("public", "fact"));
    engine.bind_table("Curr", 0, SourceBinding::new("public", "curr"));
    engine
        .cache
        .store(
            "Fact",
            RecordBatch::try_new(
                Arc::new(Schema::new(vec![
                    Field::new("currency", ArrowType::Utf8, true),
                    Field::new("amount", ArrowType::Float64, true),
                ])),
                vec![
                    Arc::new(StringArray::from(vec!["EUR", "USD", "EUR", "SEK"])),
                    Arc::new(Float64Array::from(vec![100.0, 40.0, 30.0, 20.0])),
                ],
            )
            .unwrap(),
        )
        .unwrap();
    engine
        .cache
        .store(
            "Curr",
            RecordBatch::try_new(
                Arc::new(Schema::new(vec![Field::new("code", ArrowType::Utf8, true)])),
                vec![Arc::new(StringArray::from(vec!["EUR", "USD"]))],
            )
            .unwrap(),
        )
        .unwrap();

    // No slicer: Curr lists EUR + USD -> 100 + 40 + 30 = 170 (SEK excluded).
    let batches = engine
        .query(QueryRequest {
            measures: vec!["SelectedRevenue".into()],
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(as_f64(batches[0].column(0).as_ref(), 0), 170.0);

    // Slicer on the DISCONNECTED table: only EUR -> 130.
    let batches = engine
        .query(QueryRequest {
            measures: vec!["SelectedRevenue".into()],
            filters: vec![FilterCondition::new("code", FilterOperator::Equal, "EUR")],
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(as_f64(batches[0].column(0).as_ref(), 0), 130.0);
}

#[tokio::test]
async fn dynamic_format_string_follows_outer_context() {
    let engine = clear_engine();

    // Unfiltered: outer total 190 > 150 -> "big-fmt" (overrides the static).
    let (_batches, meta) = engine
        .query_with_meta(QueryRequest {
            measures: vec!["FmtRevenue".into()],
            group_by: vec![ColumnRef::new("Product", "name")],
            ..Default::default()
        })
        .await
        .unwrap();
    let col = meta
        .iter()
        .find(|c| c.measure.as_deref() == Some("FmtRevenue"))
        .unwrap();
    assert_eq!(col.format_string.as_deref(), Some("big-fmt"));

    // Sliced to Bikes: outer total 130 <= 150 -> "small-fmt".
    let (_batches, meta) = engine
        .query_with_meta(QueryRequest {
            measures: vec!["FmtRevenue".into()],
            group_by: vec![ColumnRef::new("Product", "name")],
            filters: vec![FilterCondition::new("name", FilterOperator::Equal, "Bikes")],
            ..Default::default()
        })
        .await
        .unwrap();
    let col = meta
        .iter()
        .find(|c| c.measure.as_deref() == Some("FmtRevenue"))
        .unwrap();
    assert_eq!(col.format_string.as_deref(), Some("small-fmt"));

    // A measure WITHOUT a dynamic format keeps its static metadata path.
    let (_batches, meta) = engine
        .query_with_meta(QueryRequest {
            measures: vec!["Revenue".into()],
            ..Default::default()
        })
        .await
        .unwrap();
    let col = meta
        .iter()
        .find(|c| c.measure.as_deref() == Some("Revenue"))
        .unwrap();
    assert_eq!(col.format_string, None);
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
    // a one-row cross-joined total (`hoist_clear_scalars`, BUG-0444), so the
    // ratio is each product's share of
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
    // A slicer on Product + a COMPOUND measure whose RESET must remove it
    // (REMOVEFILTERS semantics): per-measure filter removal does not yet
    // thread through compound sub-expression contexts → typed error, never a
    // silently slicer-respecting number.
    let engine = clear_engine();
    let mut req = request(&["Revenue", "PctOfTotal"]);
    req.filters = vec![FilterCondition::new("name", FilterOperator::Equal, "Bikes")];
    let err = engine.query(req).await;
    assert!(err.is_err(), "RESET over a sliced table must fail closed");
    let msg = format!("{}", err.unwrap_err());
    assert!(
        msg.contains("per-measure filter removal") || msg.contains("clears request filter"),
        "error should explain the contested-filter restriction, got: {msg}"
    );
}

#[tokio::test]
async fn scalar_clear_now_strips_the_slicer() {
    // NEW with filter levels: a plain aggregate measure whose CLEAR covers an
    // ordinary (level-1) slicer evaluates WITHOUT it — the filter is hoisted
    // out of the fetch WHERE and applied per measure. Scalar (no group_by)
    // request: Revenue honors the slicer (130), TotalViaClear ignores it and
    // returns the true grand total (190) — a query that previously refused.
    let engine = clear_engine();
    let req = QueryRequest {
        measures: vec!["Revenue".into(), "TotalViaClear".into()],
        filters: vec![FilterCondition::new("name", FilterOperator::Equal, "Bikes")],
        ..Default::default()
    };
    let batches = engine.query(req).await.unwrap();
    assert_eq!(batches[0].num_rows(), 1);
    let revenue = as_f64(batches[0].column(0).as_ref(), 0);
    let cleared = as_f64(batches[0].column(1).as_ref(), 0);
    assert!((revenue - 130.0).abs() < 1e-9, "Revenue got {revenue}");
    assert!(
        (cleared - 190.0).abs() < 1e-9,
        "TotalViaClear must ignore the slicer, got {cleared}"
    );
}

#[tokio::test]
async fn grouped_axis_spanning_clear_with_slicer_still_fails_closed() {
    // Grouped by Product[name], the same clearing measure would broadcast via
    // a window over the row-domain-filtered groups — which would produce the
    // VISIBLE total (130), not the cleared total (190). Fail closed rather
    // than return the wrong number.
    let engine = clear_engine();
    let mut req = request(&["Revenue", "TotalViaClear"]);
    req.filters = vec![FilterCondition::new("name", FilterOperator::Equal, "Bikes")];
    let err = engine.query(req).await;
    assert!(
        err.is_err(),
        "axis-spanning contested clear must fail closed"
    );
    let msg = format!("{}", err.unwrap_err());
    assert!(
        msg.contains("axis") || msg.contains("per-measure filter removal"),
        "got: {msg}"
    );
}

#[tokio::test]
async fn pinned_filter_survives_bare_clear_end_to_end() {
    // THE pin scenario: the same filter, pinned at level 2 (a scoped filter),
    // is OUT OF RANGE of bare CLEAR ([0,1]) — the measure that previously
    // required CLEAREXCEPT boilerplate (or failed closed) now just works,
    // and the "total" respects the pin: 130, not 190.
    let engine = clear_engine();
    let mut req = request(&["Revenue", "TotalViaClear"]);
    req.scoped_filters = vec![ScopedFilter {
        table: Some("Product".into()),
        condition: FilterCondition::new("name", FilterOperator::Equal, "Bikes"),
        level: 2,
    }];
    let batches = engine.query(req).await.unwrap();
    let rev = grouped(&batches, "Revenue");
    let tot = grouped(&batches, "TotalViaClear");
    assert_eq!(rev.get("Bikes"), Some(&130.0));
    assert_eq!(
        tot.get("Bikes"),
        Some(&130.0),
        "bare CLEAR must NOT strip a level-2 pinned filter"
    );
    assert!(
        !rev.contains_key("Helmets"),
        "the pinned filter restricts the row domain"
    );
}

#[tokio::test]
async fn clear_level_busts_the_pin() {
    // CLEAR(Product, LEVEL 2) reaches the level-2 pin: the pinned filter is
    // contested and hoisted; the escalated measure returns the true grand
    // total while Revenue still honors the pin. (Scalar request — the
    // axis-spanning grouped form fails closed, tested above.)
    let engine = clear_engine();
    let req = QueryRequest {
        measures: vec!["Revenue".into(), "TotalBustPin".into()],
        scoped_filters: vec![ScopedFilter {
            table: Some("Product".into()),
            condition: FilterCondition::new("name", FilterOperator::Equal, "Bikes"),
            level: 2,
        }],
        ..Default::default()
    };
    let batches = engine.query(req).await.unwrap();
    let revenue = as_f64(batches[0].column(0).as_ref(), 0);
    let busted = as_f64(batches[0].column(1).as_ref(), 0);
    assert!((revenue - 130.0).abs() < 1e-9, "Revenue got {revenue}");
    assert!(
        (busted - 190.0).abs() < 1e-9,
        "CLEAR(…, LEVEL 2) must strip the level-2 pin, got {busted}"
    );
}

#[tokio::test]
async fn pin_level_out_of_range_fails_closed() {
    // A scoped filter with an invalid level (0 = the axis, or above the
    // maximum) must refuse — a silently misleveled pin would change which
    // measures respect it.
    let engine = clear_engine();
    for bad_level in [0u8, 10] {
        let mut req = request(&["Revenue"]);
        req.scoped_filters = vec![ScopedFilter {
            table: Some("Product".into()),
            condition: FilterCondition::new("name", FilterOperator::Equal, "Bikes"),
            level: bad_level,
        }];
        let err = engine.query(req).await;
        assert!(err.is_err(), "level {bad_level} must be refused");
    }
    // An unknown table on a scoped filter fails closed too (a filter applied
    // to nothing would silently widen the result).
    let mut req = request(&["Revenue"]);
    req.scoped_filters = vec![ScopedFilter {
        table: Some("Prodcut".into()), // misspelled
        condition: FilterCondition::new("name", FilterOperator::Equal, "Bikes"),
        level: 2,
    }];
    assert!(engine.query(req).await.is_err());
}

#[tokio::test]
async fn isfiltered_resolves_from_axis_and_slicers() {
    let engine = clear_engine();

    // Grouped by Product[name]: the column is on the axis -> TRUE branch
    // (the per-group revenue).
    let batches = engine
        .query(request(&["Revenue", "NameFilteredFlag"]))
        .await
        .unwrap();
    let flag = grouped(&batches, "NameFilteredFlag");
    assert_eq!(flag.get("Bikes"), Some(&130.0));
    assert_eq!(flag.get("Helmets"), Some(&60.0));

    // Ungrouped, no filter: FALSE branch (-1).
    let batches = engine
        .query(QueryRequest {
            measures: vec!["NameFilteredFlag".into()],
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(as_f64(batches[0].column(0).as_ref(), 0), -1.0);

    // Ungrouped but with a query filter on the column: TRUE branch (the
    // filtered total).
    let batches = engine
        .query(QueryRequest {
            measures: vec!["NameFilteredFlag".into()],
            filters: vec![FilterCondition::new("name", FilterOperator::Equal, "Bikes")],
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(as_f64(batches[0].column(0).as_ref(), 0), 130.0);
}

#[tokio::test]
async fn allselected_drops_axis_and_keeps_slicers() {
    let engine = clear_engine();

    // No slicer: ALLSELECTED() broadcasts the grand total (the group axis is
    // dropped) — identical to RESET_INNER, which it aliases.
    let batches = engine
        .query(request(&["Revenue", "TotalAllSelected"]))
        .await
        .unwrap();
    let tot = grouped(&batches, "TotalAllSelected");
    assert_eq!(tot.get("Bikes"), Some(&190.0));
    assert_eq!(tot.get("Helmets"), Some(&190.0));

    // With a slicer: the slicer is PRESERVED — the "total" is the visible
    // (Bikes) total, not the grand total. (Contrast RESET over a sliced
    // table, which fails closed — see reset_with_slicer_on_cleared_table.)
    let mut req = request(&["Revenue", "TotalAllSelected"]);
    req.filters = vec![FilterCondition::new("name", FilterOperator::Equal, "Bikes")];
    let batches = engine.query(req).await.unwrap();
    let tot = grouped(&batches, "TotalAllSelected");
    assert_eq!(tot.get("Bikes"), Some(&130.0));
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

/// Group a batch by an Int64 column (a FACT key such as `prod_id`).
fn grouped_i64(batches: &[RecordBatch], key_col: &str, measure_col: &str) -> HashMap<i64, f64> {
    let mut out = HashMap::new();
    for b in batches {
        let g = b
            .column(col_idx(b, key_col))
            .as_any()
            .downcast_ref::<Int64Array>()
            .expect("i64 group column")
            .clone();
        let m = b.column(col_idx(b, measure_col));
        for row in 0..b.num_rows() {
            out.insert(g.value(row), as_f64(m.as_ref(), row));
        }
    }
    out
}

#[tokio::test]
async fn compound_reset_share_groups_by_a_fact_column() {
    // BUG-0444: `DIVIDE(SUM(x), SUM(x, RESET()))` grouped by a column OF THE
    // FACT TABLE (here Sales[prod_id]) failed with DataFusion's
    // "No field named __scalar_sq_1.__clear_scalar" -- the RESET scalar
    // subquery and the outer query both read `FROM sales`, and grouping by a
    // fact column made the decorrelated subquery's alias collide. Per prod_id:
    // 1 -> 130, 2 -> 60; grand total 190.
    let engine = clear_engine();
    let req = QueryRequest {
        measures: vec!["Revenue".into(), "PctOfTotal".into()],
        group_by: vec![ColumnRef::new("Sales", "prod_id")],
        ..Default::default()
    };
    let batches = engine
        .query(req)
        .await
        .expect("a compound RESET share must group by a fact column");
    let pct = grouped_i64(&batches, "prod_id", "PctOfTotal");
    assert!(
        (pct[&1] - 130.0 / 190.0).abs() < 1e-9,
        "prod 1 share should be 130/190, got {}",
        pct[&1]
    );
    assert!(
        (pct[&2] - 60.0 / 190.0).abs() < 1e-9,
        "prod 2 share should be 60/190, got {}",
        pct[&2]
    );
}

#[tokio::test]
async fn compound_reset_share_groups_by_fact_and_dimension_columns() {
    // BUG-0444, mixed axis: a fact column AND a dimension column on the same
    // axis. Each (prod_id, name) row is still its share of the 190 total.
    let engine = clear_engine();
    let req = QueryRequest {
        measures: vec!["PctOfTotal".into()],
        group_by: vec![
            ColumnRef::new("Product", "name"),
            ColumnRef::new("Sales", "prod_id"),
        ],
        ..Default::default()
    };
    let batches = engine
        .query(req)
        .await
        .expect("a compound RESET share must group by fact + dimension columns");
    let pct = grouped(&batches, "PctOfTotal");
    assert!((pct["Bikes"] - 130.0 / 190.0).abs() < 1e-9, "Bikes {}", pct["Bikes"]);
    assert!(
        (pct["Helmets"] - 60.0 / 190.0).abs() < 1e-9,
        "Helmets {}",
        pct["Helmets"]
    );
}

#[tokio::test]
async fn two_compound_reset_shares_group_by_a_fact_column() {
    // BUG-0444: two share measures in ONE query (each its own grand-total
    // subquery) grouped by a fact column.
    let engine = clear_engine();
    let req = QueryRequest {
        measures: vec!["ShareRatio".into(), "PctOfTotal".into()],
        group_by: vec![ColumnRef::new("Sales", "prod_id")],
        ..Default::default()
    };
    let batches = engine
        .query(req)
        .await
        .expect("two compound RESET shares must group by a fact column");
    let ratio = grouped_i64(&batches, "prod_id", "ShareRatio");
    let pct = grouped_i64(&batches, "prod_id", "PctOfTotal");
    for (k, want) in [(1_i64, 130.0 / 190.0), (2, 60.0 / 190.0)] {
        assert!((ratio[&k] - want).abs() < 1e-9, "ShareRatio {k}: {}", ratio[&k]);
        assert!((pct[&k] - want).abs() < 1e-9, "PctOfTotal {k}: {}", pct[&k]);
    }
}

#[tokio::test]
async fn bare_division_reset_share_groups_by_a_fact_column() {
    // BUG-0444 isolation: ONE grand-total subquery, no DIVIDE repetition.
    let engine = clear_engine();
    let req = QueryRequest {
        measures: vec!["ShareRatio".into()],
        group_by: vec![ColumnRef::new("Sales", "prod_id")],
        ..Default::default()
    };
    let batches = engine
        .query(req)
        .await
        .expect("a bare-division RESET share must group by a fact column");
    let ratio = grouped_i64(&batches, "prod_id", "ShareRatio");
    assert!((ratio[&1] - 130.0 / 190.0).abs() < 1e-9, "{}", ratio[&1]);
    assert!((ratio[&2] - 60.0 / 190.0).abs() < 1e-9, "{}", ratio[&2]);
}

/// The clear fixture plus a SECOND fact, `Returns(prod_id, qty)` -> Product
/// (Bikes 1, Helmets 2 + 3), so a query holding a Returns measure beside the
/// Sales shares takes the MULTI-FACT route (`execute_multi_group_aggregation`),
/// which renders its compound measures on its own.
fn multi_fact_engine() -> Engine {
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
                    Column::new("name", DataType::String),
                ],
            )
            .unwrap()
            .with_storage_mode(StorageMode::InMemory),
        )
        .add_table(
            Table::new(
                "Returns",
                vec![
                    Column::new("prod_id", DataType::Int64),
                    Column::new("qty", DataType::Float64),
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
        .add_relationship(Relationship::many_to_one(
            "Returns_Product",
            "Returns",
            "prod_id",
            "Product",
            "id",
        ))
        .add_measure(expression_measure(
            "PctOfTotal",
            parse_measure("DIVIDE(SUM(Sales[amount]), SUM(Sales[amount], RESET()))").unwrap(),
        ))
        .add_measure(expression_measure(
            "ShareRatio",
            parse_measure("SUM(Sales[amount]) / SUM(Sales[amount], RESET())").unwrap(),
        ))
        .add_measure(sum_measure("ReturnQty", "Returns", "qty"))
        .build()
        .unwrap();
    let mut engine = Engine::new(model);
    for t in ["Sales", "Product", "Returns"] {
        engine.bind_table(t, 0, SourceBinding::new("public", &t.to_lowercase()));
    }
    let base = clear_engine();
    for t in ["Sales", "Product"] {
        engine
            .cache
            .store(t, base.cache.get(t).expect("fixture batch").clone())
            .unwrap();
    }
    engine
        .cache
        .store(
            "Returns",
            RecordBatch::try_new(
                Arc::new(Schema::new(vec![
                    Field::new("prod_id", ArrowType::Int64, true),
                    Field::new("qty", ArrowType::Float64, true),
                ])),
                vec![
                    Arc::new(Int64Array::from(vec![1, 2, 2])),
                    Arc::new(Float64Array::from(vec![1.0, 2.0, 3.0])),
                ],
            )
            .unwrap(),
        )
        .unwrap();
    engine
}

#[tokio::test]
async fn compound_reset_share_groups_by_a_fact_column_on_the_multi_fact_route() {
    // BUG-0444's compound RESET shape on the MULTI-FACT route (BUG-0730):
    // `DIVIDE(SUM(x), SUM(x, RESET()))` grouped by a FACT column, beside a
    // second fact's measure. The route repeats the share in its HAVING, so an
    // inline grand-total subquery failed there exactly as on the single-fact
    // route ("No field named __scalar_sq_1.__clear_scalar"). Returns does not
    // reach Sales[prod_id], so its total (6) repeats on every row.
    let engine = multi_fact_engine();
    for measures in [
        vec!["PctOfTotal", "ReturnQty"],
        vec!["ShareRatio", "PctOfTotal", "ReturnQty"],
    ] {
        let req = QueryRequest {
            measures: measures.iter().map(|m| m.to_string()).collect(),
            group_by: vec![ColumnRef::new("Sales", "prod_id")],
            ..Default::default()
        };
        let batches = engine.query(req).await.unwrap_or_else(|e| {
            panic!("{measures:?} by Sales[prod_id] on the multi-fact route: {e}")
        });
        let returns = grouped_i64(&batches, "prod_id", "ReturnQty");
        for share in measures.iter().filter(|m| **m != "ReturnQty") {
            let got = grouped_i64(&batches, "prod_id", share);
            for (k, want) in [(1_i64, 130.0 / 190.0), (2, 60.0 / 190.0)] {
                assert!((got[&k] - want).abs() < 1e-9, "{share} {k}: {}", got[&k]);
                assert_eq!(returns[&k], 6.0, "ReturnQty broadcast to prod_id {k}");
            }
        }
    }
    // A fact column AND a dimension column: the Returns group is grouped by
    // the dimension it reaches and combined on it.
    let req = QueryRequest {
        measures: vec!["PctOfTotal".into(), "ReturnQty".into()],
        group_by: vec![
            ColumnRef::new("Product", "name"),
            ColumnRef::new("Sales", "prod_id"),
        ],
        ..Default::default()
    };
    let batches = engine
        .query(req)
        .await
        .expect("a compound RESET share by fact + dimension columns on the multi-fact route");
    let pct = grouped(&batches, "PctOfTotal");
    let returns = grouped(&batches, "ReturnQty");
    assert!(
        (pct["Bikes"] - 130.0 / 190.0).abs() < 1e-9,
        "Bikes {}",
        pct["Bikes"]
    );
    assert!(
        (pct["Helmets"] - 60.0 / 190.0).abs() < 1e-9,
        "Helmets {}",
        pct["Helmets"]
    );
    assert_eq!(returns["Bikes"], 1.0);
    assert_eq!(returns["Helmets"], 5.0);
}

fn format_engine() -> Engine {
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
                    Column::new("name", DataType::String),
                ],
            )
            .unwrap()
            .with_storage_mode(StorageMode::InMemory),
        )
        .add_relationship(Relationship::many_to_one("Sales_Product", "Sales", "prod_id", "Product", "id"))
        .add_measure(expression_measure(
            "Fmt",
            parse_measure("FORMAT(SUM(Sales[amount]) * 10, \"#,0.00\")").unwrap(),
        ))
        .add_measure(expression_measure(
            "FmtCurrency",
            parse_measure("FORMAT(SUM(Sales[amount]) * 10, \"Currency\")").unwrap(),
        ))
        .add_measure(expression_measure(
            "FmtPct",
            parse_measure("FORMAT(SUM(Sales[amount]) / 190, \"0.0%\")").unwrap(),
        ))
        .build()
        .unwrap();
    let mut engine = Engine::new(model);
    engine.bind_table("Sales", 0, SourceBinding::new("public", "sales"));
    engine.bind_table("Product", 0, SourceBinding::new("public", "product"));
    let base = clear_engine();
    for table in ["Sales", "Product"] {
        let batch = base.cache.get(table).expect("fixture batch").clone();
        engine.cache.store(table, batch).unwrap();
    }
    engine
}

fn grouped_text(batches: &[RecordBatch], measure_col: &str) -> HashMap<String, String> {
    let mut out = HashMap::new();
    for b in batches {
        let g = b.column(col_idx(b, "name"));
        let m = b.column(col_idx(b, measure_col));
        let m = arrow::compute::cast(m, &ArrowType::Utf8).unwrap();
        let m = m.as_any().downcast_ref::<StringArray>().unwrap().clone();
        for row in 0..b.num_rows() {
            let key = if let Some(a) = g.as_any().downcast_ref::<StringArray>() {
                a.value(row).to_string()
            } else if let Some(a) = g.as_any().downcast_ref::<DictionaryArray<Int32Type>>() {
                let values = a.values().as_any().downcast_ref::<StringArray>().unwrap();
                values.value(a.key(row).unwrap()).to_string()
            } else {
                panic!("unexpected group array type: {:?}", g.data_type());
            };
            out.insert(key, m.value(row).to_string());
        }
    }
    out
}

#[tokio::test]
async fn dax_format_writes_the_format_string_in_the_engines_culture() {
    // BUG-0522: FORMAT compiled to SQL TO_CHAR, which does not read DAX's
    // format strings at all. Bikes 130 * 10 = 1300, Helmets 600.
    let mut engine = format_engine();
    let req = QueryRequest {
        measures: vec!["Fmt".into(), "FmtCurrency".into(), "FmtPct".into()],
        group_by: vec![ColumnRef::new("Product", "name")],
        ..Default::default()
    };
    let batches = engine.query(req.clone()).await.expect("FORMAT under en-US");
    let fmt = grouped_text(&batches, "Fmt");
    assert_eq!(fmt["Bikes"], "1,300.00");
    assert_eq!(fmt["Helmets"], "600.00");
    assert_eq!(grouped_text(&batches, "FmtCurrency")["Bikes"], "$1,300.00");
    assert_eq!(grouped_text(&batches, "FmtPct")["Bikes"], "68.4%");

    // The same engine under sv-SE: the cache must not serve the en-US text.
    engine.set_format_culture(crate::FormatCulture::sv_se());
    let batches = engine.query(req).await.expect("FORMAT under sv-SE");
    assert_eq!(grouped_text(&batches, "Fmt")["Bikes"], "1\u{a0}300,00");
    // [LIVE] Excel 16's data model under sv-SE: a plain space before "kr"
    // (the no-break space is the group separator only; BUG-0731).
    assert_eq!(grouped_text(&batches, "FmtCurrency")["Bikes"], "1\u{a0}300,00 kr");
    assert_eq!(grouped_text(&batches, "FmtPct")["Bikes"], "68,4%");
}


/// One ungrouped measure's answer over `engine`, as text (`None` = NULL).
async fn scalar_text(engine: &Engine, measure: &str) -> Result<Option<String>, String> {
    let batches = engine
        .query(QueryRequest {
            measures: vec![measure.into()],
            ..Default::default()
        })
        .await
        .map_err(|e| e.to_string())?;
    assert_eq!(batches.iter().map(|b| b.num_rows()).sum::<usize>(), 1, "{measure}: one row");
    let column = batches[0].column(0);
    Ok((!column.is_null(0)).then(|| arrow::util::display::array_value_to_string(column, 0).unwrap()))
}

#[tokio::test]
async fn a_reset_total_over_an_empty_fact_table_is_blank() {
    // rev-backend-7: `hoist_clear_scalars` (BUG-0444) moved a compound
    // measure's RESET total into `FROM fact CROSS JOIN (one row)`, which has
    // NO rows when the fact table is empty, so an ungrouped query reads the
    // total as NULL (BLANK) where the inline subquery read the empty set's
    // COUNT, 0. BLANK is kept: it is DAX's answer (COUNTROWS of an empty
    // table is BLANK, and BLANK / BLANK is BLANK), and the 0 made the share
    // 0 / 0 -- an integer divide-by-zero that failed the whole query.
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
        .add_measure(expression_measure(
            "RowShare",
            parse_measure("COUNTROWS(Sales) / COUNTROWS(Sales, RESET())").unwrap(),
        ))
        .add_measure(expression_measure(
            "RowShareDivide",
            parse_measure("DIVIDE(COUNTROWS(Sales), COUNTROWS(Sales, RESET()))").unwrap(),
        ))
        .add_measure(expression_measure(
            "AmountShare",
            parse_measure("SUM(Sales[amount]) / SUM(Sales[amount], RESET())").unwrap(),
        ))
        .build()
        .unwrap();
    let mut engine = Engine::new(model);
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
                    Arc::new(Int64Array::from(Vec::<i64>::new())),
                    Arc::new(Float64Array::from(Vec::<f64>::new())),
                ],
            )
            .unwrap(),
        )
        .unwrap();

    assert_eq!(
        scalar_text(&engine, "RowShare").await,
        Ok(None),
        "COUNTROWS(Sales) / COUNTROWS(Sales, RESET()) over an empty table is BLANK"
    );
    assert_eq!(scalar_text(&engine, "RowShareDivide").await, Ok(None), "DIVIDE of the same is BLANK");
    assert_eq!(scalar_text(&engine, "AmountShare").await, Ok(None), "a SUM share is BLANK too");
}

