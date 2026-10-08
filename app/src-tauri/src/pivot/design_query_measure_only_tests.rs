//! FILENAME: app/src-tauri/src/pivot/design_query_measure_only_tests.rs
//! PURPOSE: CONTRACT-CANVAS 4.8, backend half -- a MEASURE-ONLY design query
//!          (`VALUES: [Revenue]`, no ROWS, no COLUMNS) is a Card / Gauge /
//!          KPI fed straight from the model, as Power BI's are.
//!
//! `compute_design_query_view` refused it ("needs at least one dimension").
//! What is pinned here, engine-backed over an in-memory model (no database),
//! like `bi/blank_member_tests.rs`:
//!
//!   1. THE SHAPE the chart reader takes (model lane, `designQueryChartData`):
//!      no data rows and exactly ONE visible GrandTotal row carrying one value
//!      per measure. The response the frontend gets is built from the same
//!      view (`view_to_response`) and says the same.
//!   2. THE NUMBER IS THE ENGINE'S. The page's model slicers arrive as FILTERS
//!      with `includedItems`; on the measure-only path they go to the engine as
//!      level-tagged IN-lists with an EMPTY group-by, so a NON-ADDITIVE
//!      measure (AVERAGE here) under a slicer that keeps SEVERAL items is the
//!      exact average of the kept rows -- not the sum of per-item averages the
//!      grouped path's host-side roll-up would give (model lane, defect 1).
//!   3. Every filter form the DSL says keeps its meaning: an inclusion, an
//!      exclusion (`NOT IN`), the blank member, and `includedItems: []`, which
//!      keeps NOTHING.
//!   4. The refusals that stay: no measure at all; and a GROUPED query is
//!      untouched (positive control for the path split).

use std::collections::HashMap;
use std::sync::Arc;

use arrow::array::{Float64Array, StringArray};
use arrow::datatypes::{DataType as ArrowType, Field, Schema};
use arrow::record_batch::RecordBatch;
use bi_engine::{
    average_measure, expression_measure, parse_measure, sum_measure, Column, DataModel, DataType, Engine,
    InMemoryConnector, QueryRequest, SourceBinding, StorageMode, Table,
};
use tokio::sync::Mutex as TokioMutex;

use super::{compute_design_query_view, DesignQueryFieldRef, DesignQueryRequest};
use crate::bi::types::{BiState, Connection, ConnectionId, ConnectionType};
use crate::pivot::types::BiValueFieldRef;

fn model() -> DataModel {
    DataModel::builder()
        .add_table(
            Table::new(
                "Sales",
                vec![
                    Column::new("region", DataType::String),
                    Column::new("year", DataType::String),
                    Column::new("amount", DataType::Float64),
                    // A FLOAT dimension (a fiscal year stored as a double): the
                    // model's slicer lists "2024", the engine spells "2024.0".
                    Column::new("fy", DataType::Float64),
                ],
            )
            .unwrap()
            .with_storage_mode(StorageMode::InMemory),
        )
        .add_measure(sum_measure("Revenue", "Sales", "amount"))
        .add_measure(average_measure("AvgAmount", "Sales", "amount"))
        // A PLAIN aggregate that clears the table: strips a level-1 slicer,
        // keeps a filter pinned at level 2.
        .add_measure(expression_measure(
            "TotalViaClear",
            parse_measure("SUM(Sales[amount], CLEAR(Sales))").unwrap(),
        ))
        .build()
        .unwrap()
}

/// (East, Y1, 10), (West, Y1, 20), (NULL, Y2, 30), (North, NULL, 40),
/// ("", Y3, 50), (East, Y2, 60) -- East twice, so a per-region roll-up of an
/// AVERAGE differs from the average of the rows.
fn sales() -> RecordBatch {
    RecordBatch::try_new(
        Arc::new(Schema::new(vec![
            Field::new("region", ArrowType::Utf8, true),
            Field::new("year", ArrowType::Utf8, true),
            Field::new("amount", ArrowType::Float64, true),
            Field::new("fy", ArrowType::Float64, true),
        ])),
        vec![
            Arc::new(StringArray::from(vec![Some("East"), Some("West"), None, Some("North"), Some(""), Some("East")])),
            Arc::new(StringArray::from(vec![Some("Y1"), Some("Y1"), Some("Y2"), None, Some("Y3"), Some("Y2")])),
            Arc::new(Float64Array::from(vec![10.0, 20.0, 30.0, 40.0, 50.0, 60.0])),
            Arc::new(Float64Array::from(vec![2024.0, 2025.0, 2024.0, 2025.0, 2.5, 2024.0])),
        ],
    )
    .unwrap()
}

/// A BiState holding one cache-warm connection over the sales rows.
async fn bi() -> (BiState, ConnectionId) {
    let mut engine = Engine::new(model());
    let idx = engine.add_in_memory_source(InMemoryConnector::new().with_table("public", "sales", sales()));
    engine.bind_table("Sales", idx, SourceBinding::new("public", "sales"));
    let _ = engine
        .query_auto_refresh(QueryRequest {
            measures: vec!["Revenue".into()],
            group_by: vec![bi_engine::ColumnRef::new("Sales", "region")],
            ..Default::default()
        })
        .await;
    let conn = identity::EntityId::from_bytes(identity::generate_uuid_v7());
    let connection = Connection {
        id: conn,
        name: "Sales".into(),
        description: String::new(),
        connection_type: ConnectionType::PostgreSQL,
        connection_string: String::new(),
        server: String::new(),
        database: String::new(),
        preferred_auth: "Integrated".into(),
        model_path: None,
        engine: Some(Arc::new(TokioMutex::new(engine))),
        model_key: None,
        connector_index: Some(idx),
        bindings: vec![],
        last_refreshed: None,
        created_at: String::new(),
        is_connected: true,
        active_queries: HashMap::new(),
        package_data_source_id: None,
        active_role: None,
        base_model: None,
        calculated_measures: vec![],
    };
    let bi = BiState::new();
    bi.connections.lock().unwrap().insert(conn, connection);
    (bi, conn)
}

fn measure(name: &str) -> BiValueFieldRef {
    BiValueFieldRef { measure_name: name.to_string(), custom_name: None }
}

fn region(included: Option<&[&str]>, hidden: Option<&[&str]>) -> DesignQueryFieldRef {
    DesignQueryFieldRef {
        table: "Sales".to_string(),
        column: "region".to_string(),
        is_lookup: false,
        hidden_items: hidden.map(|h| h.iter().map(|s| s.to_string()).collect()),
        included_items: included.map(|i| i.iter().map(|s| s.to_string()).collect()),
        level: None,
    }
}

fn year() -> DesignQueryFieldRef {
    DesignQueryFieldRef {
        table: "Sales".to_string(),
        column: "year".to_string(),
        is_lookup: false,
        hidden_items: None,
        included_items: None,
        level: None,
    }
}

fn request(conn: ConnectionId, measures: &[&str], rows: Vec<DesignQueryFieldRef>, filters: Vec<DesignQueryFieldRef>) -> DesignQueryRequest {
    DesignQueryRequest {
        connection_id: conn,
        row_fields: rows,
        column_fields: Vec::new(),
        value_fields: measures.iter().map(|m| measure(m)).collect(),
        filter_fields: filters,
        page_filter_fields: Vec::new(),
        calculated_fields: None,
        value_column_order: None,
        layout: None,
    }
}

/// The numbers of every GrandTotal row, one Vec per row.
fn grand_total_rows(view: &pivot_engine::PivotView) -> Vec<Vec<Option<f64>>> {
    view.rows
        .iter()
        .filter(|r| r.row_type == pivot_engine::PivotRowType::GrandTotal)
        .map(|r| {
            view.cells[r.view_row]
                .iter()
                .skip(view.row_label_col_count)
                .map(|c| match c.value {
                    pivot_engine::PivotCellValue::Number(n) => Some(n),
                    _ => None,
                })
                .collect()
        })
        .collect()
}

fn data_row_count(view: &pivot_engine::PivotView) -> usize {
    view.rows.iter().filter(|r| r.row_type == pivot_engine::PivotRowType::Data).count()
}

/// Run a measure-only query and return its ONE grand-total row, asserting the
/// shape the chart reader takes.
async fn the_one_total(bi: &BiState, req: &DesignQueryRequest) -> Vec<Option<f64>> {
    let (def, mut cache, view) = compute_design_query_view(bi, req).await.expect("a measure-only query runs");
    assert_eq!(data_row_count(&view), 0, "a measure-only view has no data rows");
    let totals = grand_total_rows(&view);
    assert_eq!(totals.len(), 1, "exactly one grand-total row, got {totals:?}");
    assert!(
        view.rows.iter().any(|r| r.row_type == pivot_engine::PivotRowType::GrandTotal && r.visible),
        "the grand-total row is visible"
    );
    // The response the frontend receives says the same.
    let response = crate::pivot::utils::view_to_response(&view, &def, &mut cache);
    let json = serde_json::to_value(&response).unwrap();
    let kinds: Vec<String> = json["rows"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| r["rowType"].as_str().unwrap_or_default().to_string())
        .collect();
    assert_eq!(kinds.iter().filter(|k| k.eq_ignore_ascii_case("grandtotal")).count(), 1, "{kinds:?}");
    assert_eq!(kinds.iter().filter(|k| k.eq_ignore_ascii_case("data")).count(), 0, "{kinds:?}");
    totals.into_iter().next().unwrap()
}

#[tokio::test]
async fn a_measure_only_query_is_one_grand_total_row() {
    let (bi, conn) = bi().await;
    let total = the_one_total(&bi, &request(conn, &["Revenue"], vec![], vec![])).await;
    assert_eq!(total, vec![Some(210.0)], "10+20+30+40+50+60");

    // The header names the measure, so the reader can name the series.
    let (_d, _c, view) = compute_design_query_view(&bi, &request(conn, &["Revenue"], vec![], vec![])).await.unwrap();
    let texts: Vec<String> = view.cells[..view.column_header_row_count]
        .iter()
        .flatten()
        .filter_map(|c| match &c.value {
            pivot_engine::PivotCellValue::Text(t) => Some(t.clone()),
            _ => None,
        })
        .collect();
    assert!(texts.iter().any(|t| t.contains("Revenue")), "the column header names the measure: {texts:?}");

    // Two measures: one row, one value each, in VALUES order.
    let both = the_one_total(&bi, &request(conn, &["Revenue", "AvgAmount"], vec![], vec![])).await;
    assert_eq!(both, vec![Some(210.0), Some(35.0)]);
}

/// THE DEFECT the model lane named: the grouped path puts a FILTERS field into
/// GROUP BY and rolls the groups up host-side, so a non-additive measure under
/// a multi-item slicer came back as the SUM of per-item averages. East has two
/// rows (10, 60) and West one (20): the true average is 30; the roll-up says
/// avg(East)=35 + avg(West)=20 = 55.
#[tokio::test]
async fn a_non_additive_measure_under_a_multi_item_slicer_is_the_engines_exact_answer() {
    let (bi, conn) = bi().await;
    let total = the_one_total(&bi, &request(conn, &["AvgAmount"], vec![], vec![region(Some(&["East", "West"]), None)])).await;
    assert_eq!(total, vec![Some(30.0)], "(10 + 60 + 20) / 3");
    let revenue = the_one_total(&bi, &request(conn, &["Revenue"], vec![], vec![region(Some(&["East", "West"]), None)])).await;
    assert_eq!(revenue, vec![Some(90.0)]);
}

#[tokio::test]
async fn an_exclusion_keeps_everything_else_including_the_blank_rows() {
    let (bi, conn) = bi().await;
    // NOT IN ("West"): East 10 + 60, NULL 30, North 40, "" 50 -- blanks kept,
    // exactly as the pivot's NOT IN keeps them.
    let total = the_one_total(&bi, &request(conn, &["Revenue", "AvgAmount"], vec![], vec![region(None, Some(&["West"]))])).await;
    assert_eq!(total, vec![Some(190.0), Some(38.0)]);
}

#[tokio::test]
async fn the_blank_member_and_an_empty_inclusion_mean_what_they_say() {
    let (bi, conn) = bi().await;
    // Naming the blank member keeps the NULL and the empty region (30 + 50).
    let blank = the_one_total(&bi, &request(conn, &["Revenue"], vec![], vec![region(Some(&["(blank)"]), None)])).await;
    assert_eq!(blank, vec![Some(80.0)]);
    // An inclusion that does NOT name it drops the blank rows.
    let east = the_one_total(&bi, &request(conn, &["Revenue"], vec![], vec![region(Some(&["East"]), None)])).await;
    assert_eq!(east, vec![Some(70.0)]);
    // An inclusion AND an exclusion on one field: kept minus hidden.
    let both = the_one_total(&bi, &request(conn, &["Revenue"], vec![], vec![region(Some(&["East", "West"]), Some(&["West"]))])).await;
    assert_eq!(both, vec![Some(70.0)]);
    // `includedItems: []` keeps NOTHING: still one row, and no number in it.
    let nothing = the_one_total(&bi, &request(conn, &["Revenue"], vec![], vec![region(Some(&[]), None)])).await;
    assert_eq!(nothing, vec![None], "an empty inclusion keeps no row, so the total is BLANK (Power BI's '(Blank)'), not 0");
}

#[tokio::test]
async fn two_filters_on_different_columns_both_apply() {
    let (bi, conn) = bi().await;
    let mut y2 = year();
    y2.included_items = Some(vec!["Y2".to_string()]);
    // Region East AND Year Y2: the one row (East, Y2, 60).
    let total = the_one_total(&bi, &request(conn, &["Revenue"], vec![], vec![region(Some(&["East"]), None), y2])).await;
    assert_eq!(total, vec![Some(60.0)]);
}

#[tokio::test]
async fn a_query_with_no_measure_is_still_refused_and_a_grouped_query_is_unchanged() {
    let (bi, conn) = bi().await;
    let err = compute_design_query_view(&bi, &request(conn, &[], vec![], vec![])).await.expect_err("no measure");
    assert!(err.contains("measure"), "{err}");

    // POSITIVE CONTROL for the path split: ROWS year + FILTERS region = East
    // still groups by year and filters host-side -- data rows, Y1 = 10, Y2 = 60.
    let (_def, _cache, view) = compute_design_query_view(
        &bi,
        &request(conn, &["Revenue"], vec![year()], vec![region(Some(&["East"]), None)]),
    )
    .await
    .expect("a grouped query runs");
    assert!(data_row_count(&view) >= 2, "a grouped query keeps its data rows");
    let numbers: Vec<f64> = view
        .rows
        .iter()
        .filter(|r| r.row_type == pivot_engine::PivotRowType::Data)
        .filter_map(|r| {
            view.cells[r.view_row].iter().skip(view.row_label_col_count).find_map(|c| match c.value {
                pivot_engine::PivotCellValue::Number(n) => Some(n),
                _ => None,
            })
        })
        .collect();
    assert_eq!(numbers, vec![10.0, 60.0], "East's Y1 and Y2");
}

fn fy(included: Option<&[&str]>, hidden: Option<&[&str]>) -> DesignQueryFieldRef {
    DesignQueryFieldRef {
        table: "Sales".to_string(),
        column: "fy".to_string(),
        is_lookup: false,
        hidden_items: hidden.map(|h| h.iter().map(|s| s.to_string()).collect()),
        included_items: included.map(|i| i.iter().map(|s| s.to_string()).collect()),
        level: None,
    }
}

/// The first number of every visible DATA row, in row order.
fn data_numbers(view: &pivot_engine::PivotView) -> Vec<f64> {
    view.rows
        .iter()
        .filter(|r| r.row_type == pivot_engine::PivotRowType::Data && r.visible)
        .filter_map(|r| {
            view.cells[r.view_row].iter().skip(view.row_label_col_count).find_map(|c| match c.value {
                pivot_engine::PivotCellValue::Number(n) => Some(n),
                _ => None,
            })
        })
        .collect()
}

fn close(a: &[f64], b: &[f64]) -> bool {
    a.len() == b.len() && a.iter().zip(b).all(|(x, y)| (x - y).abs() < 1e-9)
}

/// A slicer over a FLOAT column lists its items as the model's value list
/// spells them -- "2024" (f64 Display, `bi_get_column_values_core`) -- and the
/// engine's IN-list matched a Float64 column only as "2024.0". Every
/// measure-only Card on the page answered BLANK on an ordinary click, while a
/// bar chart on the same page (host labels) kept working.
///
/// SABOTAGE: return `kept` un-respelled from `engine_spelling`.
#[tokio::test]
async fn a_float_column_filter_matches_the_items_the_slicer_lists() {
    let (bi, conn) = bi().await;
    let y2024 = the_one_total(&bi, &request(conn, &["Revenue"], vec![], vec![fy(Some(&["2024"]), None)])).await;
    assert_eq!(y2024, vec![Some(100.0)], "10 + 30 + 60; a blank here is the Float64 spelling mismatch");
    let frac = the_one_total(&bi, &request(conn, &["Revenue"], vec![], vec![fy(Some(&["2.5"]), None)])).await;
    assert_eq!(frac, vec![Some(50.0)]);
    // NOT IN: the complement is taken from the model's own list, re-spelled too.
    let not_2024 = the_one_total(&bi, &request(conn, &["Revenue"], vec![], vec![fy(None, Some(&["2024"]))])).await;
    assert_eq!(not_2024, vec![Some(110.0)], "20 + 40 + 50");
}

/// THE HIGH FINDING. A GROUPED design-query chart (a column chart `ROWS:
/// year; VALUES: [AvgAmount]`) under a slicer that keeps two regions: the
/// filter column was put into GROUP BY and the per-region averages were then
/// SUMMED host-side, so Y1 read avg(East) + avg(West) = 10 + 20 = 30 where the
/// model says avg(10, 20) = 15. On the chart route the filter now runs inside
/// the engine query, so every bar is the model's own answer.
///
/// SABOTAGE: route a chart's FILTERS through GROUP BY again (FilterArea).
#[tokio::test]
async fn a_grouped_chart_under_a_multi_item_filter_is_the_engines_answer_per_bar() {
    let (bi, conn) = bi().await;
    let (_d, _c, view) = compute_design_query_view(
        &bi,
        &request(conn, &["AvgAmount"], vec![year()], vec![region(Some(&["East", "West"]), None)]),
    )
    .await
    .expect("a grouped query runs");
    let bars = data_numbers(&view);
    assert!(close(&bars, &[15.0, 60.0]), "Y1 = avg(10, 20), Y2 = avg(60); got {bars:?}");
}

/// The canvas PAGE's slicers arrive as `pageFilterFields`, apart from the
/// query's own FILTERS: on a grouped chart they run inside the engine query,
/// never as a GROUP BY column, so the bars are the model's own averages.
///
/// SABOTAGE: leave `page_filter_fields` out of `engine_fields`.
#[tokio::test]
async fn page_filters_run_inside_the_engine_on_a_grouped_chart() {
    let (bi, conn) = bi().await;
    let mut req = request(conn, &["AvgAmount"], vec![year()], vec![]);
    req.page_filter_fields = vec![region(Some(&["East", "West"]), None)];
    let (_d, _c, view) = compute_design_query_view(&bi, &req).await.expect("runs");
    let bars = data_numbers(&view);
    assert!(close(&bars, &[15.0, 60.0]), "Y1 = avg(10, 20), Y2 = avg(60); got {bars:?}");

    // A GRID REPORT keeps its own FILTERS as a filter area (GROUP BY + mask),
    // but the page filters still never become one.
    let mut report = request(conn, &["Revenue"], vec![year()], vec![region(Some(&["East"]), None)]);
    report.page_filter_fields = vec![fy(Some(&["2024"]), None)];
    let (def, _c, view) = super::compute_design_query_view_for_report(&bi, &report).await.expect("runs");
    assert_eq!(def.filter_fields.len(), 1, "the report's own FILTERS are its filter area, the page filter is not");
    assert_eq!(def.filter_fields[0].field.name, "Sales.region");
    assert!(close(&data_numbers(&view), &[10.0, 60.0]), "East in 2024: Y1 10, Y2 60; got {:?}", data_numbers(&view));
}

/// A page filter carries its LEVEL: a slicer PINNED at level 2 survives a bare
/// `CLEAR`, which removes an ordinary (level-1) one -- so a Card agrees with a
/// BI pivot on the same page about what a pinned slicer means.
///
/// SABOTAGE: always send `LEVEL_SLICER` in `engine_filters`.
#[tokio::test]
async fn a_pinned_page_filter_keeps_its_level_inside_the_engine() {
    let (bi, conn) = bi().await;
    let mut ordinary = request(conn, &["TotalViaClear"], vec![], vec![]);
    ordinary.page_filter_fields = vec![region(Some(&["East", "West"]), None)];
    assert_eq!(the_one_total(&bi, &ordinary).await, vec![Some(210.0)], "CLEAR removes an ordinary slicer");

    let mut pinned = ordinary.clone();
    pinned.page_filter_fields[0].level = Some(2);
    assert_eq!(the_one_total(&bi, &pinned).await, vec![Some(90.0)], "a pinned slicer survives a bare CLEAR");
}

// ============================================================================
// A share of the grand total under a slicer: the host-mask fallback
// ============================================================================

/// A STAR: Sales (prod_id, amount) -> Product (id, name), and a SHARE of the
/// grand total, `DIVIDE(SUM(x), SUM(x, RESET()))` -- a COMPOUND measure whose
/// RESET must remove any slicer, which the engine refuses while a request
/// filter is in play. Product is a dimension table on purpose: the engine
/// cannot GROUP such a measure by a column of the FACT table at all (a
/// DataFusion schema error, `__scalar_sq_1.__clear_scalar`, with no filter
/// anywhere -- a model-engine-lib defect, reported, not this path's), so
/// the fallback is exercised where the engine can answer it.
async fn bi_star() -> (BiState, ConnectionId) {
    use arrow::array::Int64Array;
    let model = DataModel::builder()
        .add_table(
            Table::new("Sales", vec![Column::new("prod_id", DataType::Int64), Column::new("amount", DataType::Float64)])
                .unwrap()
                .with_storage_mode(StorageMode::InMemory),
        )
        .add_table(
            Table::new("Product", vec![Column::new("id", DataType::Int64), Column::new("name", DataType::String)])
                .unwrap()
                .with_storage_mode(StorageMode::InMemory),
        )
        .add_relationship(bi_engine::Relationship::many_to_one("Sales_Product", "Sales", "prod_id", "Product", "id"))
        .add_measure(sum_measure("Revenue", "Sales", "amount"))
        .add_measure(expression_measure(
            "Share",
            parse_measure("DIVIDE(SUM(Sales[amount]), SUM(Sales[amount], RESET()))").unwrap(),
        ))
        .build()
        .unwrap();
    // Bikes 10 + 60, Helmets 20, Locks 30: 120 in all.
    let sales = RecordBatch::try_new(
        Arc::new(Schema::new(vec![
            Field::new("prod_id", ArrowType::Int64, true),
            Field::new("amount", ArrowType::Float64, true),
        ])),
        vec![Arc::new(Int64Array::from(vec![1, 2, 3, 1])), Arc::new(Float64Array::from(vec![10.0, 20.0, 30.0, 60.0]))],
    )
    .unwrap();
    let product = RecordBatch::try_new(
        Arc::new(Schema::new(vec![Field::new("id", ArrowType::Int64, true), Field::new("name", ArrowType::Utf8, true)])),
        vec![Arc::new(Int64Array::from(vec![1, 2, 3])), Arc::new(StringArray::from(vec!["Bikes", "Helmets", "Locks"]))],
    )
    .unwrap();
    let mut engine = Engine::new(model);
    let idx = engine.add_in_memory_source(
        InMemoryConnector::new().with_table("public", "sales", sales).with_table("public", "product", product),
    );
    engine.bind_table("Sales", idx, SourceBinding::new("public", "sales"));
    engine.bind_table("Product", idx, SourceBinding::new("public", "product"));
    let _ = engine
        .query_auto_refresh(QueryRequest {
            measures: vec!["Revenue".into()],
            group_by: vec![bi_engine::ColumnRef::new("Product", "name")],
            ..Default::default()
        })
        .await;
    let (bi, conn) = bi().await;
    bi.connections.lock().unwrap().get_mut(&conn).unwrap().engine = Some(Arc::new(TokioMutex::new(engine)));
    (bi, conn)
}

fn product(included: &[&str]) -> DesignQueryFieldRef {
    DesignQueryFieldRef {
        table: "Product".to_string(),
        column: "name".to_string(),
        is_lookup: false,
        hidden_items: None,
        included_items: Some(included.iter().map(|s| s.to_string()).collect()),
        level: None,
    }
}

/// A SHARE Card under a slicer turned into an ERROR the moment the slicer was
/// clicked: the engine refuses a compound RESET with a request filter in
/// play. The host-mask route answers it, exactly for a share whose numerator
/// is additive: Bikes + Helmets of the grand total, 90 / 120.
///
/// SABOTAGE: make `is_contested_clear_refusal` answer false.
#[tokio::test]
async fn a_share_card_under_a_slicer_is_answered_not_refused() {
    let (bi, conn) = bi_star().await;
    for (label, req) in [
        ("the query's own FILTERS", request(conn, &["Share"], vec![], vec![product(&["Bikes", "Helmets"])])),
        ("a page filter", {
            let mut r = request(conn, &["Share"], vec![], vec![]);
            r.page_filter_fields = vec![product(&["Bikes", "Helmets"])];
            r
        }),
    ] {
        let (_d, _c, view) = compute_design_query_view(&bi, &req)
            .await
            .unwrap_or_else(|e| panic!("{label}: a share under a slicer must answer, not refuse: {e}"));
        let totals = grand_total_rows(&view);
        assert_eq!(totals.len(), 1, "{label}: {totals:?}");
        let share = totals[0][0].expect("a number");
        assert!((share - 90.0 / 120.0).abs() < 1e-9, "{label}: Bikes + Helmets of 120, got {share}");
    }
}

/// The same on a GROUPED chart (`ROWS: Product.name`) under a page slicer on
/// that column: the page filter narrows the ROWS field in place on the mask
/// route, so each kept bar is its share of the grand total.
#[tokio::test]
async fn a_grouped_share_chart_under_a_page_slicer_falls_back_to_the_mask() {
    let (bi, conn) = bi_star().await;
    let name = DesignQueryFieldRef { included_items: None, ..product(&[]) };
    let mut req = request(conn, &["Share"], vec![name], vec![]);
    req.page_filter_fields = vec![product(&["Bikes", "Helmets"])];
    let (_d, _c, view) = compute_design_query_view(&bi, &req).await.expect("a share answers, not refuses");
    let bars = data_numbers(&view);
    assert!(close(&bars, &[70.0 / 120.0, 20.0 / 120.0]), "Bikes 70/120, Helmets 20/120; got {bars:?}");
}
