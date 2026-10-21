//! FILENAME: app/src-tauri/src/pivot/design_query_tuple_tests.rs
//! PURPOSE: P4 S4b -- tuple (OR-of-AND) filters through design queries, and
//!          the member keys a design-query view carries (`group_members`).
//!
//! A NON-rectangular cross-filter selection (Ctrl+click East/Y1 and West/Y2 on
//! a two-field chart) cannot be said as one IN-list per column: (East, West) x
//! (Y1, Y2) also keeps East/Y2 and West/Y1. It travels as a tuple filter, run
//! INSIDE the engine query. What is pinned here, engine-backed over an
//! in-memory model (no database):
//!
//!   1. The tuple passes through: exactly the rows of the named pairs, on a
//!      grouped and on a measure-only query; the blank member's KEY "" (ruling
//!      Q8) matches the NULL rows; a float key is re-spelled for the engine.
//!   2. An engine refusal under a tuple is the visual's ERROR, with the S4b
//!      text -- never an unfiltered answer through the host-mask route, which
//!      cannot express a tuple. (Positive control: the same measure under an
//!      ordinary page filter still answers through the host mask.)
//!   3. A tuple column on a calculation group is refused.
//!   4. `group_members`: every key is `member_key_of` (P2's ONE key function),
//!      the keys do not depend on the app locale, and a windowed response
//!      covers its window only.

use std::collections::HashMap;
use std::sync::Arc;

use arrow::array::{Float64Array, StringArray};
use arrow::datatypes::{DataType as ArrowType, Field, Schema};
use arrow::record_batch::RecordBatch;
use bi_engine::{
    expression_measure, parse_measure, sum_measure, Column, DataModel, DataType, Engine, InMemoryConnector,
    QueryRequest, SourceBinding, StorageMode, Table,
};
use engine::LocaleSettings;
use tokio::sync::Mutex as TokioMutex;

use super::{
    compute_design_query_view, design_query_field_keys, DesignQueryColumn, DesignQueryFieldRef,
    DesignQueryRequest, DesignQueryTupleFilter,
};
use crate::bi::types::{BiState, Connection, ConnectionId, ConnectionType};
use crate::pivot::types::BiValueFieldRef;
use crate::pivot::utils::{fill_group_members, member_key_of, view_to_response};

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

fn model() -> DataModel {
    DataModel::builder()
        .add_table(
            Table::new(
                "Sales",
                vec![
                    Column::new("region", DataType::String),
                    Column::new("year", DataType::String),
                    Column::new("amount", DataType::Float64),
                    Column::new("fy", DataType::Float64),
                ],
            )
            .unwrap()
            .with_storage_mode(StorageMode::InMemory),
        )
        .add_measure(sum_measure("Revenue", "Sales", "amount"))
        // A COMPOUND share: the engine refuses it under a tuple filter (S1).
        .add_measure(expression_measure(
            "Share",
            parse_measure("DIVIDE(SUM(Sales[amount]), SUM(Sales[amount], RESET()))").unwrap(),
        ))
        .build()
        .unwrap()
}

/// (East, Y1, 10, 2024), (West, Y1, 20, 2025), (East, Y2, 30, 2024),
/// (North, Y2, 40, 2025), (West, Y2, 50, 2024), (NULL, Y3, 7, 2026).
fn sales() -> RecordBatch {
    RecordBatch::try_new(
        Arc::new(Schema::new(vec![
            Field::new("region", ArrowType::Utf8, true),
            Field::new("year", ArrowType::Utf8, true),
            Field::new("amount", ArrowType::Float64, true),
            Field::new("fy", ArrowType::Float64, true),
        ])),
        vec![
            Arc::new(StringArray::from(vec![Some("East"), Some("West"), Some("East"), Some("North"), Some("West"), None])),
            Arc::new(StringArray::from(vec![Some("Y1"), Some("Y1"), Some("Y2"), Some("Y2"), Some("Y2"), Some("Y3")])),
            Arc::new(Float64Array::from(vec![10.0, 20.0, 30.0, 40.0, 50.0, 7.0])),
            Arc::new(Float64Array::from(vec![2024.0, 2025.0, 2024.0, 2025.0, 2024.0, 2026.0])),
        ],
    )
    .unwrap()
}

fn connection(engine: Engine, idx: usize) -> (ConnectionId, Connection) {
    let id = identity::EntityId::from_bytes(identity::generate_uuid_v7());
    (
        id,
        Connection {
            id,
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
        },
    )
}

async fn bi_over(model: DataModel, batch: RecordBatch) -> (BiState, ConnectionId) {
    let mut engine = Engine::new(model);
    let idx = engine.add_in_memory_source(InMemoryConnector::new().with_table("public", "sales", batch));
    engine.bind_table("Sales", idx, SourceBinding::new("public", "sales"));
    let _ = engine
        .query_auto_refresh(QueryRequest {
            measures: vec!["Revenue".into()],
            group_by: vec![bi_engine::ColumnRef::new("Sales", "region")],
            ..Default::default()
        })
        .await;
    let (id, conn) = connection(engine, idx);
    let bi = BiState::new();
    bi.connections.lock().unwrap().insert(id, conn);
    (bi, id)
}

async fn bi() -> (BiState, ConnectionId) {
    bi_over(model(), sales()).await
}

fn dim(column: &str) -> DesignQueryFieldRef {
    DesignQueryFieldRef {
        table: "Sales".to_string(),
        column: column.to_string(),
        is_lookup: false,
        hidden_items: None,
        included_items: None,
        level: None,
    }
}

fn col(column: &str) -> DesignQueryColumn {
    DesignQueryColumn { table: "Sales".to_string(), column: column.to_string() }
}

fn tuple_filter(columns: &[&str], tuples: &[&[&str]]) -> DesignQueryTupleFilter {
    DesignQueryTupleFilter {
        fields: columns.iter().map(|c| col(c)).collect(),
        tuples: tuples.iter().map(|t| t.iter().map(|s| s.to_string()).collect()).collect(),
        level: None,
    }
}

fn request(conn: ConnectionId, measures: &[&str], rows: Vec<DesignQueryFieldRef>) -> DesignQueryRequest {
    DesignQueryRequest {
        connection_id: conn,
        row_fields: rows,
        column_fields: Vec::new(),
        value_fields: measures
            .iter()
            .map(|m| BiValueFieldRef { measure_name: m.to_string(), custom_name: None, number_format: None })
            .collect(),
        filter_fields: Vec::new(),
        page_filter_fields: Vec::new(),
        tuple_filters: Vec::new(),
        calculated_fields: None,
        value_column_order: None,
        layout: None,
    }
}

fn number(v: &pivot_engine::PivotCellValue) -> Option<f64> {
    match v {
        pivot_engine::PivotCellValue::Number(n) => Some(*n),
        _ => None,
    }
}

fn grand_total(view: &pivot_engine::PivotView) -> Option<f64> {
    view.cells
        .iter()
        .flatten()
        .find(|c| c.cell_type == pivot_engine::PivotCellType::GrandTotal)
        .and_then(|c| number(&c.value))
}

// ---------------------------------------------------------------------------
// 1. Pass-through
// ---------------------------------------------------------------------------

/// Two tuples give EXACTLY the rows of those two pairs -- not the four of the
/// rectangle a pair of IN-lists would keep.
#[tokio::test]
async fn a_tuple_filter_keeps_exactly_the_named_pairs() {
    let (bi, conn) = bi().await;
    let mut req = request(conn, &["Revenue"], vec![dim("region"), dim("year")]);
    req.tuple_filters = vec![tuple_filter(&["region", "year"], &[&["East", "Y1"], &["West", "Y2"]])];
    let (def, mut cache, view) = compute_design_query_view(&bi, &req).await.expect("a tuple-filtered query runs");

    assert_eq!(grand_total(&view), Some(60.0), "East/Y1 10 + West/Y2 50 (a rectangle would give 110)");

    // The data cells name exactly the two pairs, by their member keys.
    let response = view_to_response(&view, &def, &mut cache, &LocaleSettings::invariant());
    let mut pairs: Vec<(String, String, f64)> = Vec::new();
    for cell in response.rows.iter().flat_map(|r| r.cells.iter()) {
        if cell.cell_type != pivot_engine::PivotCellType::Data || cell.group_path.len() != 2 {
            continue;
        }
        let key = |(fi, vid): (usize, u32)| member_key_of(&cache, fi, vid).unwrap();
        let value = match cell.value {
            crate::pivot::types::PivotCellValueData::Number(n) => n,
            _ => continue,
        };
        pairs.push((key(cell.group_path[0]), key(cell.group_path[1]), value));
    }
    pairs.sort_by(|a, b| a.partial_cmp(b).unwrap());
    assert_eq!(
        pairs,
        vec![("East".to_string(), "Y1".to_string(), 10.0), ("West".to_string(), "Y2".to_string(), 50.0)],
        "the view holds rows outside the selected pairs"
    );

    // Positive control: the same query without the tuple keeps every row.
    let (_d, _c, unfiltered) = compute_design_query_view(&bi, &request(conn, &["Revenue"], vec![dim("region"), dim("year")]))
        .await
        .unwrap();
    assert_eq!(grand_total(&unfiltered), Some(157.0), "fixture: every row totals 157");
}

/// A measure-only query (a Card) under a tuple is the engine's own number.
#[tokio::test]
async fn a_measure_only_query_under_a_tuple_is_the_engines_number() {
    let (bi, conn) = bi().await;
    let mut req = request(conn, &["Revenue"], vec![]);
    req.tuple_filters = vec![tuple_filter(&["region", "year"], &[&["East", "Y1"], &["West", "Y2"]])];
    let (_d, _c, view) = compute_design_query_view(&bi, &req).await.unwrap();
    assert_eq!(grand_total(&view), Some(60.0));

    // An EMPTY tuple list keeps nothing: the Card is BLANK, not the total.
    req.tuple_filters = vec![tuple_filter(&["region", "year"], &[])];
    let (_d, _c, view) = compute_design_query_view(&bi, &req).await.unwrap();
    assert_eq!(grand_total(&view), None, "an empty tuple list answered {:?}", grand_total(&view));
}

/// The blank member's KEY is "" (ruling Q8); the engine names it
/// `BLANK_MEMBER_LABEL`. A raw "" would match only empty-string rows, so the
/// NULL-region row (7) would be lost.
#[tokio::test]
async fn the_blank_key_in_a_tuple_matches_the_null_rows() {
    let (bi, conn) = bi().await;
    let mut req = request(conn, &["Revenue"], vec![]);
    req.tuple_filters = vec![tuple_filter(&["region", "year"], &[&["", "Y3"], &["East", "Y2"]])];
    let (_d, _c, view) = compute_design_query_view(&bi, &req).await.unwrap();
    assert_eq!(grand_total(&view), Some(37.0), "blank/Y3 7 + East/Y2 30");
}

/// A float column's key is the model list's spelling ("2024"); the engine
/// matches its own ("2024.0"). Re-spelled exactly as an IN-list item is.
#[tokio::test]
async fn a_float_key_in_a_tuple_is_spelled_for_the_engine() {
    let (bi, conn) = bi().await;
    let mut req = request(conn, &["Revenue"], vec![]);
    req.tuple_filters = vec![tuple_filter(&["fy", "year"], &[&["2024", "Y2"]])];
    let (_d, _c, view) = compute_design_query_view(&bi, &req).await.unwrap();
    assert_eq!(grand_total(&view), Some(80.0), "East/Y2 30 + West/Y2 50, both fy 2024");
}

// ---------------------------------------------------------------------------
// 2. A refusal is an error, never unfiltered
// ---------------------------------------------------------------------------

/// A STAR, Sales (prod_id, amount) -> Product (id, name), for the compound
/// share: the engine cannot group a compound RESET by a FACT column at all
/// (filed: `__scalar_sq_1.__clear_scalar`, `design_query_measure_only_tests`
/// says the same), so the refusal is exercised on a dimension column, where
/// the host-mask positive control can answer. Bikes 10 + 60, Helmets 20,
/// Locks 30.
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
    let (id, conn) = connection(engine, idx);
    let bi = BiState::new();
    bi.connections.lock().unwrap().insert(id, conn);
    (bi, id)
}

fn product_name() -> DesignQueryFieldRef {
    DesignQueryFieldRef { table: "Product".to_string(), ..dim("name") }
}

/// SABOTAGE: drop the tuple arm in `compute_design_query_view_routed` -- the
/// host-mask route then answers with the tuple silently dropped.
#[tokio::test]
async fn an_engine_refusal_under_a_tuple_is_the_visuals_error_never_an_unfiltered_answer() {
    let (bi, conn) = bi_star().await;
    let mut req = request(conn, &["Share"], vec![product_name()]);
    req.tuple_filters = vec![DesignQueryTupleFilter {
        fields: vec![DesignQueryColumn { table: "Product".into(), column: "name".into() }],
        tuples: vec![vec!["Bikes".into()], vec!["Helmets".into()]],
        level: None,
    }];
    let err = compute_design_query_view(&bi, &req)
        .await
        .err()
        .expect("a compound share under a tuple must be refused, never answered unfiltered");
    assert!(
        err.starts_with("This visual cannot apply the selection from another visual here: "),
        "the refusal text is not the visual's error state: {err}"
    );
    assert!(err.contains(" clears "), "the engine's own reason is kept: {err}");

    // The same with an ordinary page filter alongside: still an error (the
    // host mask would keep the page filter and drop the tuple).
    req.page_filter_fields = vec![DesignQueryFieldRef {
        included_items: Some(vec!["Bikes".into(), "Helmets".into(), "Locks".into()]),
        ..product_name()
    }];
    let err = compute_design_query_view(&bi, &req).await.err().expect("still refused");
    assert!(err.starts_with("This visual cannot apply the selection"), "{err}");

    // Positive control: without the tuple, the page filter answers through
    // the host-mask route (the BUG-0444 fix), so the refusal above is the
    // tuple's, not the measure's.
    req.tuple_filters.clear();
    req.page_filter_fields[0].included_items = Some(vec!["Bikes".into(), "Helmets".into()]);
    let (_d, _c, view) = compute_design_query_view(&bi, &req)
        .await
        .expect("an ordinary page filter answers through the host mask");
    let bars: Vec<f64> = view
        .cells
        .iter()
        .flatten()
        .filter(|c| c.cell_type == pivot_engine::PivotCellType::Data)
        .filter_map(|c| number(&c.value))
        .collect();
    assert_eq!(bars.len(), 2, "Bikes and Helmets: {bars:?}");
    assert!((bars[0] - 70.0 / 120.0).abs() < 1e-9 && (bars[1] - 20.0 / 120.0).abs() < 1e-9, "{bars:?}");
}

// ---------------------------------------------------------------------------
// 3. Validation
// ---------------------------------------------------------------------------

#[tokio::test]
async fn a_tuple_column_on_a_calculation_group_is_refused() {
    let (bi, conn) = bi().await;
    let mut req = request(conn, &["Revenue"], vec![dim("region")]);
    req.tuple_filters = vec![DesignQueryTupleFilter {
        fields: vec![DesignQueryColumn { table: crate::pivot::types::CALC_GROUP_TABLE.to_string(), column: "TI".into() }],
        tuples: vec![vec!["YTD".into()]],
        level: None,
    }];
    let err = compute_design_query_view(&bi, &req).await.err().expect("refused");
    assert!(err.contains("calculation group 'TI'"), "{err}");
}

// ---------------------------------------------------------------------------
// 4. group_members on a design-query view
// ---------------------------------------------------------------------------

/// Every key is `member_key_of`, and the keys do not move with the app
/// locale (the LABELS do).
#[tokio::test]
async fn a_design_query_view_carries_invariant_member_keys() {
    let (bi, conn) = bi().await;
    let req = request(conn, &["Revenue"], vec![dim("region"), dim("fy")]);
    let (def, mut cache, view) = compute_design_query_view(&bi, &req).await.unwrap();
    let field_keys = design_query_field_keys(&def);
    assert_eq!(
        field_keys.iter().map(|(_, k)| k.as_str()).collect::<Vec<_>>(),
        vec!["Sales.region", "Sales.fy"],
        "every placed field is named Table.Column"
    );

    let mut by_locale = Vec::new();
    for locale in [LocaleSettings::invariant(), LocaleSettings::from_locale_id("de-DE"), LocaleSettings::from_locale_id("sv-SE")] {
        let mut response = view_to_response(&view, &def, &mut cache, &locale);
        fill_group_members(&mut response, &field_keys, &cache);
        by_locale.push(response.group_members.clone());
    }
    assert!(by_locale.windows(2).all(|w| w[0] == w[1]), "the member keys moved with the app locale: {by_locale:?}");

    let members = &by_locale[0];
    assert_eq!(members.len(), 2, "{members:?}");
    for gm in members {
        assert!(!gm.members.is_empty());
        assert!(gm.members.windows(2).all(|w| w[0].0 < w[1].0), "not sorted / deduped by valueId: {gm:?}");
        for (vid, key) in &gm.members {
            assert_eq!(member_key_of(&cache, gm.field_index, *vid).as_deref(), Some(key.as_str()));
        }
    }
    let region: Vec<&str> = members[0].members.iter().map(|(_, k)| k.as_str()).collect();
    let mut sorted_region = region.clone();
    sorted_region.sort();
    assert_eq!(sorted_region, vec!["", "East", "North", "West"], "the blank member's key is \"\" (Q8)");
    let fy: Vec<&str> = members[1].members.iter().map(|(_, k)| k.as_str()).collect();
    assert!(fy.contains(&"2024") && !fy.iter().any(|k| k.contains(',')), "fy keys are the model list's: {fy:?}");

    // The model list's keys are the same set (the P2 contract).
    let listed: std::collections::HashSet<String> =
        crate::bi::commands::bi_get_column_values_core(&bi, conn, "Sales", "region").await.unwrap().into_iter().collect();
    let ours: std::collections::HashSet<String> = region.iter().map(|s| s.to_string()).collect();
    assert_eq!(ours, listed);
}

/// A windowed response (more than WINDOW_THRESHOLD visible rows) carries the
/// members of the rows it SENDS, not of the whole view.
#[test]
fn a_windowed_response_covers_its_window_only() {
    let n: usize = 700;
    let mut grid = engine::grid::Grid::new();
    grid.set_cell(0, 0, engine::Cell::new_text("Item".to_string()));
    grid.set_cell(0, 1, engine::Cell::new_text("Amount".to_string()));
    for i in 0..n {
        grid.set_cell(i as u32 + 1, 0, engine::Cell::new_text(format!("item{i:04}")));
        grid.set_cell(i as u32 + 1, 1, engine::Cell::new_number(1.0));
    }
    let mut cache = crate::pivot::operations::build_cache_from_grid(&grid, (0, 0), (n as u32, 1), true).unwrap().0;
    let mut def = pivot_engine::PivotDefinition::new(identity::EntityId::ZERO, (0, 0), (0, 0));
    def.row_fields = vec![pivot_engine::PivotField::new(0, "T.Item".to_string())];
    def.value_fields = vec![pivot_engine::ValueField::new(1, "Sum".to_string(), pivot_engine::AggregationType::Sum)];
    let view = crate::pivot::operations::safe_calculate_pivot(&def, &mut cache);
    let mut response = view_to_response(&view, &def, &mut cache, &LocaleSettings::invariant());
    assert!(response.is_windowed, "fixture: the response must be windowed");

    fill_group_members(&mut response, &design_query_field_keys(&def), &cache);
    let sent: std::collections::BTreeSet<u32> = response
        .rows
        .iter()
        .flat_map(|r| r.cells.iter())
        .flat_map(|c| c.group_path.iter().map(|(_, v)| *v))
        .collect();
    assert_eq!(response.group_members.len(), 1);
    let ids: Vec<u32> = response.group_members[0].members.iter().map(|(v, _)| *v).collect();
    assert_eq!(ids, sent.into_iter().collect::<Vec<_>>(), "the members are not exactly the window's");
    assert!(ids.len() < n, "the members cover rows the window did not send ({} of {n})", ids.len());
    assert_eq!(response.group_members[0].field_key, "T.Item");
    // Text of a member, for the reader: "item0000" is in the first window.
    assert!(response.group_members[0].members.iter().any(|(_, k)| k == "item0000"));
}

/// A view a producer did not fill says nothing on the wire (bytes unchanged
/// for every pivot outside P4).
#[test]
fn an_unfilled_response_writes_no_group_members_key() {
    let mut grid = engine::grid::Grid::new();
    grid.set_cell(0, 0, engine::Cell::new_text("Item".to_string()));
    grid.set_cell(0, 1, engine::Cell::new_text("Amount".to_string()));
    grid.set_cell(1, 0, engine::Cell::new_text("a".to_string()));
    grid.set_cell(1, 1, engine::Cell::new_number(1.0));
    let mut cache = crate::pivot::operations::build_cache_from_grid(&grid, (0, 0), (1, 1), true).unwrap().0;
    let mut def = pivot_engine::PivotDefinition::new(identity::EntityId::ZERO, (0, 0), (0, 0));
    def.row_fields = vec![pivot_engine::PivotField::new(0, "T.Item".to_string())];
    def.value_fields = vec![pivot_engine::ValueField::new(1, "Sum".to_string(), pivot_engine::AggregationType::Sum)];
    let view = crate::pivot::operations::safe_calculate_pivot(&def, &mut cache);
    let mut response = view_to_response(&view, &def, &mut cache, &LocaleSettings::invariant());
    let json = serde_json::to_value(&response).unwrap();
    assert!(json.get("groupMembers").is_none(), "an unfilled response wrote groupMembers");
    fill_group_members(&mut response, &design_query_field_keys(&def), &cache);
    let json = serde_json::to_value(&response).unwrap();
    assert_eq!(json["groupMembers"][0]["fieldKey"], "T.Item");
    assert_eq!(json["groupMembers"][0]["members"][0][1], "a", "members serialize as [valueId, key] pairs");
}

