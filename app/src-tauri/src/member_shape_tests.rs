//! FILENAME: app/src-tauri/src/member_shape_tests.rs
//! PURPOSE: THE member shape at the Rust boundary (P2 S4, app locale
//!          everywhere): `MemberRef { key, label }`.
//!
//! - The KEY is the invariant canonical text (`arrow_value_to_string` for a
//!   model value, `FieldCache::member_key` for a pivot member). Selections,
//!   filters, page filters, GETPIVOTDATA and cross-filter tuples match on it,
//!   and ONLY on it. It never depends on the app locale.
//! - The LABEL is the app-locale display, written from the locale-free source
//!   (`engine::member_label`), never parsed back.
//! - The BLANK member is key "" and label "(Blank)" (ruling Q8).
//!
//! Every locale here is a PARAMETER (`view_to_response(.., &locale)`) or the
//! AppState's own `state.locale` -- no process-wide global is touched, so the
//! tests are safe in parallel.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use arrow::array::{Array, Date32Array, Decimal128Array, Float64Array, StringArray};
use arrow::datatypes::{DataType as ArrowType, Field, Schema};
use arrow::record_batch::RecordBatch;
use bi_engine::{
    sum_measure, Column, DataModel, DataType, Engine, InMemoryConnector, QueryRequest, SourceBinding,
    StorageMode, Table,
};
use engine::{CellValue, LocaleSettings};
use pivot_engine::{
    AggregationType, DateGroupLevel, FieldGrouping, PivotCache, PivotCellType, PivotDefinition, PivotField,
    PivotId, ValueField,
};
use serde_json::{json, Value};
use tokio::sync::Mutex as TokioMutex;

use crate::api_types::MemberRef;
use crate::bi::types::{BiState, Connection, ConnectionId, ConnectionType};
use crate::document_effect::test_seed_effect;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

fn de() -> LocaleSettings {
    LocaleSettings::from_locale_id("de-DE")
}

fn sv() -> LocaleSettings {
    LocaleSettings::from_locale_id("sv-SE")
}

fn new_id() -> identity::EntityId {
    identity::EntityId::from_bytes(identity::generate_uuid_v7())
}

fn strings(v: &[&str]) -> Vec<String> {
    v.iter().map(|s| s.to_string()).collect()
}

/// Days since 1970-01-01 (Arrow Date32) of a calendar day.
fn epoch_days(y: i32, m: u32, d: u32) -> i32 {
    let date = chrono::NaiveDate::from_ymd_opt(y, m, d).unwrap();
    (date - chrono::NaiveDate::from_ymd_opt(1970, 1, 1).unwrap()).num_days() as i32
}

/// Sales(region Utf8, day Date32, price Decimal128(10,2), amount Float64):
///   East  2024-01-15  3578.27  1234.5
///   West  2024-02-01    10.00  2000
///   North 2024-01-15     5.50  4000
///   NULL  2024-03-01     1.00   100
///   ""    2024-03-01     1.00   200
fn sales_batch() -> RecordBatch {
    let day = |m, d| epoch_days(2024, m, d);
    RecordBatch::try_new(
        Arc::new(Schema::new(vec![
            Field::new("region", ArrowType::Utf8, true),
            Field::new("day", ArrowType::Date32, true),
            Field::new("price", ArrowType::Decimal128(10, 2), true),
            Field::new("amount", ArrowType::Float64, true),
        ])),
        vec![
            Arc::new(StringArray::from(vec![Some("East"), Some("West"), Some("North"), None, Some("")])),
            Arc::new(Date32Array::from(vec![day(1, 15), day(2, 1), day(1, 15), day(3, 1), day(3, 1)])),
            Arc::new(
                Decimal128Array::from(vec![357_827i128, 1_000, 550, 100, 100])
                    .with_precision_and_scale(10, 2)
                    .unwrap(),
            ),
            Arc::new(Float64Array::from(vec![1234.5, 2000.0, 4000.0, 100.0, 200.0])),
        ],
    )
    .unwrap()
}

fn sales_model() -> DataModel {
    DataModel::builder()
        .add_table(
            Table::new(
                "Sales",
                vec![
                    Column::new("region", DataType::String),
                    Column::new("day", DataType::Date),
                    Column::new("price", DataType::Decimal(10, 2)),
                    Column::new("amount", DataType::Float64),
                ],
            )
            .unwrap()
            .with_storage_mode(StorageMode::InMemory),
        )
        .add_measure(sum_measure("Revenue", "Sales", "amount").with_format_string("#,##0.0"))
        .build()
        .unwrap()
}

/// A cache-warm connection over [`sales_batch`] (no database).
async fn sales_connection() -> Connection {
    let mut engine = Engine::new(sales_model());
    let idx = engine.add_in_memory_source(InMemoryConnector::new().with_table("public", "sales", sales_batch()));
    engine.bind_table("Sales", idx, SourceBinding::new("public", "sales"));
    let _ = engine
        .query_auto_refresh(QueryRequest {
            measures: vec!["Revenue".into()],
            group_by: vec![bi_engine::ColumnRef::new("Sales", "region")],
            ..Default::default()
        })
        .await;
    Connection {
        id: new_id(),
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
    }
}

async fn bi_over_sales() -> (BiState, ConnectionId) {
    let conn = sales_connection().await;
    let id = conn.id;
    let bi = BiState::new();
    bi.connections.lock().unwrap().insert(id, conn);
    (bi, id)
}

fn keys(members: &[MemberRef]) -> Vec<&str> {
    members.iter().map(|m| m.key.as_str()).collect()
}

fn labels(members: &[MemberRef]) -> Vec<&str> {
    members.iter().map(|m| m.label.as_str()).collect()
}

// ---------------------------------------------------------------------------
// 1. BI members: key = the machine text, label = the app locale
// ---------------------------------------------------------------------------

/// The Arrow-level member of one value, with no engine in between: the key is
/// exactly `arrow_value_to_string`, the label is written from the TYPE.
#[test]
fn an_arrow_member_keys_the_machine_text_and_labels_the_typed_value() {
    let batch = sales_batch();
    let member = |col: usize, row: usize, locale: &LocaleSettings| {
        crate::bi::member::arrow_member(batch.column(col).as_ref(), row, locale)
    };
    for col in 0..batch.num_columns() {
        for row in 0..batch.num_rows() {
            let machine = crate::bi::commands::arrow_value_to_string(batch.column(col).as_ref(), row);
            let key = member(col, row, &de()).map(|m| m.key);
            match machine {
                Some(text) if !text.is_empty() => assert_eq!(key, Some(text), "col {col} row {row}: the key moved"),
                _ => assert_eq!(key, None, "col {col} row {row}: the blank is folded by the caller"),
            }
        }
    }
    assert_eq!(member(2, 0, &de()), Some(MemberRef { key: "3578.27".into(), label: "3578,27".into() }));
    assert_eq!(member(1, 0, &de()), Some(MemberRef { key: "2024-01-15".into(), label: "15.01.2024".into() }));
    assert_eq!(member(3, 0, &de()), Some(MemberRef { key: "1234.5".into(), label: "1234,5".into() }));
    // The invariant locale writes the key back as its own label.
    assert_eq!(member(3, 0, &LocaleSettings::invariant()).unwrap().label, "1234.5");
    assert_eq!(member(1, 0, &sv()).unwrap().label, "2024-01-15");
}

/// The model value list (`bi_get_column_values` -> `MemberRef[]`): under
/// de-DE the keys are what `arrow_value_to_string` gave before, the labels are
/// German, the order is by KEY (locale-independent) and the blank member is
/// last, key "" and label "(Blank)".
async fn column_members(bi: &BiState, conn: ConnectionId, column: &str, locale: LocaleSettings) -> Vec<MemberRef> {
    crate::bi::commands::bi_get_column_members_core(bi, conn, "Sales", column, &locale).await.unwrap()
}

#[tokio::test]
async fn a_model_value_list_keys_machine_text_and_labels_the_app_locale() {
    let (bi, conn) = bi_over_sales().await;
    let members = |column: &'static str, locale: LocaleSettings| column_members(&bi, conn, column, locale);

    let price = members("price", de()).await;
    assert_eq!(keys(&price), vec!["1.00", "10.00", "3578.27", "5.50"], "keys sorted as text, as before");
    assert_eq!(labels(&price), vec!["1", "10", "3578,27", "5,5"]);

    let day = members("day", de()).await;
    assert_eq!(keys(&day), vec!["2024-01-15", "2024-02-01", "2024-03-01"]);
    assert_eq!(labels(&day), vec!["15.01.2024", "01.02.2024", "01.03.2024"]);

    let amount = members("amount", de()).await;
    assert!(amount.contains(&MemberRef { key: "1234.5".into(), label: "1234,5".into() }), "{amount:?}");

    let region = members("region", de()).await;
    assert_eq!(keys(&region), vec!["East", "North", "West", ""], "one blank member, last, keyed \"\"");
    assert_eq!(region.last().unwrap().label, "(Blank)");

    // The keys and their order never depend on the locale.
    for column in ["region", "day", "price", "amount"] {
        let a = members(column, de()).await;
        let b = members(column, LocaleSettings::invariant()).await;
        assert_eq!(keys(&a), keys(&b), "{column}: a locale moved a key");
        let projected = crate::bi::commands::bi_get_column_values_core(&bi, conn, "Sales", column).await.unwrap();
        assert_eq!(projected, keys(&a), "{column}: the key projection is not the members' keys");
    }
}

// ---------------------------------------------------------------------------
// 2. A model slicer selects by KEY, never by label (BUG-0166)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn a_model_slicer_selection_by_key_selects_and_by_label_selects_nothing() {
    let (bi, conn) = bi_over_sales().await;
    let state = crate::create_app_state();
    *state.locale.lock().unwrap() = de();
    let file = crate::persistence::FileState::default();
    let slicers = crate::slicer::SlicerState::new();
    let pivots = crate::pivot::types::PivotState::new();
    let filters = crate::ribbon_filter::RibbonFilterState::new();
    let params: crate::slicer::types::CreateSlicerParams = serde_json::from_value(json!({
        "name": "Day", "sheetIndex": 0, "x": 10.0, "y": 10.0,
        "sourceType": "biConnection", "cacheSourceId": conn.to_string(), "fieldName": "Sales.day",
        "connectedSources": [{ "sourceType": "biConnection", "sourceId": conn.to_string() }]
    }))
    .unwrap();
    let slicer = crate::slicer::commands::create_slicer_core(&state, &file, &slicers, &bi, params).unwrap().id;
    let select = |items: &[&str]| {
        slicers.slicers.write(&test_seed_effect()).unwrap().get_mut(&slicer).unwrap().selected_items =
            Some(strings(items));
    };
    let items = || crate::slicer::commands::get_slicer_items_core(&state, &pivots, &slicers, &filters, &bi, slicer, None);

    select(&["2024-01-15"]);
    let listed = items().await.unwrap();
    let shown: Vec<(&str, &str, bool)> =
        listed.iter().map(|i| (i.key.as_str(), i.label.as_str(), i.selected)).collect();
    assert_eq!(
        shown,
        vec![
            ("2024-01-15", "15.01.2024", true),
            ("2024-02-01", "01.02.2024", false),
            ("2024-03-01", "01.03.2024", false),
        ],
        "a selection by KEY selects its item, labelled in the app locale"
    );

    select(&["15.01.2024"]);
    let listed = items().await.unwrap();
    assert!(listed.iter().all(|i| !i.selected), "a LABEL selected an item: {listed:?}");

    // The wire shape: key + label, never the old `value`.
    let wire = serde_json::to_value(&listed[0]).unwrap();
    assert_eq!(wire["key"], json!("2024-01-15"));
    assert_eq!(wire["label"], json!("15.01.2024"));
    assert!(wire.get("value").is_none(), "{wire}");
}

/// The pure rule under it: the blank member by either of its spellings.
#[test]
fn a_slicer_item_is_held_by_its_key_and_the_blank_by_either_spelling() {
    use crate::slicer::commands::selection_holds_item;
    assert!(selection_holds_item(&strings(&["2024-01-15"]), "2024-01-15"));
    assert!(!selection_holds_item(&strings(&["15.01.2024"]), "2024-01-15"));
    assert!(selection_holds_item(&strings(&[""]), ""));
    assert!(selection_holds_item(&strings(&["(blank)"]), ""), "a stored legacy spelling");
    assert!(selection_holds_item(&strings(&["(Blank)"]), ""), "any case");
    assert!(!selection_holds_item(&strings(&["East"]), ""));
}

// ---------------------------------------------------------------------------
// 3 + 4. Pivot JSON: members on headers only; formatted values in the
//        locale the CALLER passes
// ---------------------------------------------------------------------------

fn pid() -> PivotId {
    new_id()
}

/// Region (text) on rows, Sum of Amount formatted "#,##0" (total 1,234,567).
fn region_pivot() -> (PivotDefinition, PivotCache) {
    let mut cache = PivotCache::new(pid(), 2);
    cache.set_field_name(0, "Region".to_string());
    cache.set_field_name(1, "Amount".to_string());
    let rows = [("East", 1_000_000.0), ("West", 234_567.0)];
    for (i, (region, amount)) in rows.iter().enumerate() {
        cache.add_record(i as u32, &[CellValue::Text(region.to_string()), CellValue::Number(*amount)]);
    }
    let mut def = PivotDefinition::new(pid(), (0, 0), (0, 0));
    def.row_fields = vec![PivotField::new(0, "Region".to_string())];
    let mut vf = ValueField::new(1, "Sum of Amount".to_string(), AggregationType::Sum);
    vf.number_format = Some("#,##0".to_string());
    def.value_fields = vec![vf];
    (def, cache)
}

#[test]
fn pivot_headers_carry_a_member_data_cells_do_not_and_numbers_follow_the_passed_locale() {
    let (def, mut cache) = region_pivot();
    let view = crate::pivot::operations::safe_calculate_pivot(&def, &mut cache);

    let grand_total = |locale: &LocaleSettings, cache: &mut PivotCache| -> String {
        let response = crate::pivot::utils::view_to_response(&view, &def, cache, locale);
        response
            .rows
            .iter()
            .flat_map(|r| r.cells.iter())
            .filter(|c| c.cell_type == PivotCellType::GrandTotal || c.cell_type == PivotCellType::GrandTotalRow)
            .map(|c| c.formatted_value.clone())
            .find(|t| !t.is_empty())
            .expect("a formatted grand total")
    };
    assert_eq!(grand_total(&de(), &mut cache), "1.234.567");
    assert_eq!(grand_total(&LocaleSettings::invariant(), &mut cache), "1,234,567");

    let response = crate::pivot::utils::view_to_response(&view, &def, &mut cache, &de());
    let cells: Vec<_> = response.rows.iter().flat_map(|r| r.cells.iter()).collect();
    let headers: Vec<&MemberRef> = cells.iter().filter_map(|c| c.member.as_ref()).collect();
    assert_eq!(
        headers,
        vec![
            &MemberRef { key: "East".into(), label: "East".into() },
            &MemberRef { key: "West".into(), label: "West".into() },
        ],
        "every member header carries its member, and only those"
    );
    for cell in &cells {
        if cell.member.is_some() {
            assert_eq!(cell.cell_type, PivotCellType::RowHeader, "a member on a non-header cell: {cell:?}");
        }
        if matches!(cell.cell_type, PivotCellType::Data | PivotCellType::GrandTotal | PivotCellType::GrandTotalRow) {
            assert!(cell.member.is_none(), "a data/total cell carries a member: {cell:?}");
        }
    }

    // The JSON: `member` is present on header cells and ABSENT (not null) on
    // every other cell.
    let json = serde_json::to_value(&response).unwrap();
    let mut with_member = 0;
    for row in json["rows"].as_array().unwrap() {
        for cell in row["cells"].as_array().unwrap() {
            match cell.get("member") {
                Some(m) => {
                    with_member += 1;
                    assert!(m.get("key").is_some() && m.get("label").is_some(), "{m}");
                    assert_eq!(cell["cellType"], json!("RowHeader"), "{cell}");
                }
                None => {}
            }
        }
    }
    assert_eq!(with_member, 2);

    // The extract-window path converts through the same function.
    let window = crate::pivot::utils::extract_cell_window(&view, 0, view.rows.len(), &de());
    let window_members: Vec<MemberRef> =
        window.iter().flat_map(|r| r.cells.iter()).filter_map(|c| c.member.clone()).collect();
    assert_eq!(window_members.len(), 2);
}

/// The filter-area list carries members (key + label) and the selected KEYS;
/// a single kept member shows its LABEL in the filter cell.
#[test]
fn a_pivot_filter_row_lists_members_and_selects_keys() {
    let mut cache = PivotCache::new(pid(), 2);
    cache.set_field_name(0, "Price".to_string());
    cache.set_field_name(1, "Amount".to_string());
    for (i, (price, amount)) in [(1234.5, 1.0), (2.25, 2.0)].iter().enumerate() {
        cache.add_record(i as u32, &[CellValue::Number(*price), CellValue::Number(*amount)]);
    }
    cache.add_record(2, &[CellValue::Empty, CellValue::Number(3.0)]);
    let mut def = PivotDefinition::new(pid(), (0, 0), (0, 0));
    let mut filter_field = PivotField::new(0, "Price".to_string());
    filter_field.hidden_items = strings(&["2.25", "(blank)"]);
    def.filter_fields = vec![pivot_engine::PivotFilter {
        field: filter_field,
        condition: pivot_engine::FilterCondition::ValueList(Vec::new()),
    }];
    def.value_fields = vec![ValueField::new(1, "Sum of Amount".to_string(), AggregationType::Sum)];
    let view = crate::pivot::operations::safe_calculate_pivot(&def, &mut cache);
    let response = crate::pivot::utils::view_to_response(&view, &def, &mut cache, &de());
    let row = &response.filter_rows[0];
    assert_eq!(
        row.members,
        vec![
            MemberRef { key: "2.25".into(), label: "2,25".into() },
            MemberRef { key: "1234.5".into(), label: "1234,5".into() },
            MemberRef::blank(),
        ]
    );
    assert_eq!(row.selected_values, strings(&["1234.5"]), "selected KEYS; the blank hidden by its legacy spelling");
    assert_eq!(row.display_value, "1234,5", "a single kept member shows its label");
}

// ---------------------------------------------------------------------------
// 5. A month-grouped pivot under sv-SE
// ---------------------------------------------------------------------------

#[test]
fn a_month_grouped_pivot_labels_swedish_months_and_keys_and_getpivotdata_stay_invariant() {
    let mut cache = PivotCache::new(pid(), 2);
    cache.set_field_name(0, "Date".to_string());
    cache.set_field_name(1, "Amount".to_string());
    for m in 1..=12 {
        cache.add_record(
            m as u32,
            &[CellValue::Number(engine::date_serial::date_to_serial(2024, m, 15)), CellValue::Number(m as f64)],
        );
    }
    let pivot_id = pid();
    let mut def = PivotDefinition::new(pivot_id, (0, 0), (0, 0));
    let mut field = PivotField::new(0, "Date".to_string());
    field.grouping = FieldGrouping::DateGrouping { levels: vec![DateGroupLevel::Month] };
    def.row_fields = vec![field];
    def.value_fields = vec![ValueField::new(1, "Sum of Amount".to_string(), AggregationType::Sum)];
    let view = crate::pivot::operations::safe_calculate_pivot(&def, &mut cache);
    let response = crate::pivot::utils::view_to_response(&view, &def, &mut cache, &sv());

    let members: Vec<MemberRef> =
        response.rows.iter().flat_map(|r| r.cells.iter()).filter_map(|c| c.member.clone()).collect();
    let english = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    assert_eq!(members.iter().map(|m| m.key.as_str()).collect::<Vec<_>>(), english.to_vec(), "keys stay invariant");
    let swedish: Vec<&str> = (1..=12).map(|m| sv().calendar().month_short(m)).collect();
    assert_eq!(members.iter().map(|m| m.label.as_str()).collect::<Vec<_>>(), swedish);
    assert_eq!(members[0].label, "jan");
    assert_eq!(members[11].label, "dec");

    // GETPIVOTDATA names the KEY: the January data cell's pair reads "Jan".
    let jan_row = view
        .cells
        .iter()
        .position(|row| row.iter().any(|c| c.member_source.is_some() && matches!(&c.value, pivot_engine::PivotCellValue::Text(s) if s == "Jan")))
        .expect("the Jan row");
    let data_col = view.cells[jan_row]
        .iter()
        .position(|c| c.cell_type == PivotCellType::Data)
        .expect("a data cell in the Jan row");
    let mut tables = HashMap::new();
    tables.insert(pivot_id, (def.clone(), cache.clone()));
    let mut views = HashMap::new();
    views.insert(pivot_id, view.clone());
    let formula = crate::pivot::operations::resolve_pivot_data_formula(&tables, &views, pivot_id, jan_row as u32, data_col as u32)
        .expect("a GETPIVOTDATA for the Jan cell");
    assert!(
        formula.field_item_pairs.iter().any(|(_, item)| item == "Jan"),
        "GETPIVOTDATA does not name the invariant key: {:?}",
        formula.field_item_pairs
    );
}

// ---------------------------------------------------------------------------
// 6. Timeline labels in the app locale; the keys stay ISO
// ---------------------------------------------------------------------------

#[test]
fn timeline_periods_are_labelled_from_the_locale_calendar_and_keyed_by_iso_dates() {
    use crate::timeline_slicer::commands::generate_periods;
    use crate::timeline_slicer::types::TimelineLevel;
    let data: HashSet<(i32, u32, u32)> = [(2024, 1, 15), (2024, 11, 2)].into_iter().collect();
    let periods = |level, locale: &LocaleSettings| {
        generate_periods(level, &(2024, 1, 1), &(2024, 12, 31), &data, &None, &None, locale)
    };

    let months = periods(TimelineLevel::Months, &sv());
    let labels: Vec<&str> = months.iter().map(|p| p.label.as_str()).collect();
    assert_eq!(labels, vec!["jan", "feb", "mar", "apr", "maj", "jun", "jul", "aug", "sep", "okt", "nov", "dec"]);
    assert_eq!(months[0].start_date, "2024-01-01", "the key stays ISO");

    let quarters = periods(TimelineLevel::Quarters, &sv());
    assert_eq!(quarters.iter().map(|p| p.label.as_str()).collect::<Vec<_>>(), vec!["Kv1", "Kv2", "Kv3", "Kv4"]);
    let quarters_en = periods(TimelineLevel::Quarters, &LocaleSettings::invariant());
    assert_eq!(quarters_en.iter().map(|p| p.label.as_str()).collect::<Vec<_>>(), vec!["Q1", "Q2", "Q3", "Q4"]);

    let days = generate_periods(TimelineLevel::Days, &(2024, 1, 30), &(2024, 2, 1), &data, &None, &None, &sv());
    assert_eq!(days[0].group_label, "jan 2024");
    assert_eq!(days[2].group_label, "feb 2024");
    assert_eq!(days[0].start_date, "2024-01-30");
}

// ---------------------------------------------------------------------------
// 7. A page filter matches KEYS: a [Measure] binding under a Date32 filter
// ---------------------------------------------------------------------------

const REPORT: usize = 1;

struct BindingFx {
    state: crate::AppState,
    file: crate::persistence::FileState,
    slicers: crate::slicer::SlicerState,
    timelines: crate::timeline_slicer::TimelineSlicerState,
    pivots: crate::pivot::types::PivotState,
    pane: crate::pane_control::PaneControlState,
    ribbon: crate::ribbon_filter::RibbonFilterState,
    bi: BiState,
    conn: ConnectionId,
}

impl BindingFx {
    async fn new(locale: LocaleSettings) -> BindingFx {
        let state = crate::create_app_state();
        let seed = test_seed_effect();
        let ids: Vec<identity::SheetId> =
            (0..2).map(|_| identity::SheetId::from_bytes(identity::generate_uuid_v7())).collect();
        *state.sheet_names.write(&seed).unwrap() = strings(&["Data", "Report"]);
        *state.sheet_ids.write(&seed).unwrap() = ids;
        *state.sheet_kinds.write(&seed).unwrap() =
            vec![::persistence::SheetKind::Worksheet, ::persistence::SheetKind::new_canvas()];
        *state.sheet_visibility.write(&seed).unwrap() = vec!["visible".to_string(); 2];
        *state.grids.write(&seed).unwrap() = vec![engine::Grid::new(), engine::Grid::new()];
        *state.locale.lock().unwrap() = locale;
        let (bi, conn) = bi_over_sales().await;
        BindingFx {
            state,
            file: crate::persistence::FileState::default(),
            slicers: crate::slicer::SlicerState::new(),
            timelines: crate::timeline_slicer::TimelineSlicerState::new(),
            pivots: crate::pivot::types::PivotState::new(),
            pane: crate::pane_control::PaneControlState::new(),
            ribbon: crate::ribbon_filter::RibbonFilterState::new(),
            bi,
            conn,
        }
    }

    fn cx(&self) -> crate::object_bindings::BindingCx<'_> {
        crate::object_bindings::BindingCx {
            state: &self.state,
            file_state: &self.file,
            slicers: &self.slicers,
            timelines: &self.timelines,
            pivots: &self.pivots,
            pane: &self.pane,
            ribbon: &self.ribbon,
            user_files: Box::leak(Box::new(crate::persistence::UserFilesState::default())),
        }
    }

    async fn send(&self, request: Value) -> crate::api_types::ObjectBindingsResponse {
        let request: crate::api_types::ObjectBindingsRequest = serde_json::from_value(request).unwrap();
        crate::object_bindings::handle_request_async(&self.cx(), &self.bi, request).await.expect("the request").response
    }

    /// A Card on the Report canvas reading `VALUES: [Revenue]`.
    fn card(&self) -> crate::api_types::ObjectBindingRef {
        let id = new_id();
        let envelope = json!({
            "chartId": id.to_string(), "name": "Revenue card", "sheetIndex": REPORT,
            "spec": { "mark": "card", "data": { "type": "designQuery", "connectionId": self.conn.to_string(), "dslText": "VALUES: [Revenue]" } }
        });
        self.state.charts.write(&test_seed_effect()).unwrap().push(crate::api_types::ChartEntry {
            id,
            sheet_index: REPORT,
            spec_json: envelope.to_string(),
        });
        crate::api_types::ObjectBindingRef { kind: crate::api_types::ObjectBindingKind::Chart, id: id.to_string() }
    }

    async fn day_filter(&self, items: &[&str]) {
        self.send(json!({
            "op": "setPageFilters",
            "pages": [{
                "sheetId": self.state.sheet_ids.read().unwrap()[REPORT].to_string(),
                "connectionId": self.conn.to_string(),
                "filters": [{ "field": "Sales.day", "includedItems": items, "filterLevel": 1 }]
            }]
        }))
        .await;
    }

    fn resolved(&self, key: &crate::object_bindings::store::BindingKey) -> crate::api_types::ResolvedBinding {
        self.state.object_binding_runtime.lock().unwrap().resolved.get(key).cloned().expect("a resolved value")
    }
}

#[tokio::test]
async fn a_page_filter_on_a_date_column_matches_keys_under_a_german_app_locale() {
    let fx = BindingFx::new(de()).await;
    let card = fx.card();
    fx.send(json!({ "op": "set", "object": card, "path": "/spec/markOptions/goal", "formula": "=[Revenue]", "invariant": true }))
        .await;
    let key = crate::object_bindings::store::BindingKey { object: card.clone(), path: "/spec/markOptions/goal".into() };
    assert_eq!(fx.resolved(&key).value, json!(7534.5), "fixture: every row");

    // By the KEY a model list hands out for 2024-01-15: East 1234.5 + North 4000.
    fx.day_filter(&["2024-01-15"]).await;
    let r = fx.resolved(&key);
    assert_eq!(r.value, json!(5234.5), "a page filter by KEY under de-DE: {r:?}");
    assert!(!r.pending && r.error.is_none(), "{r:?}");

    // By the de-DE LABEL of the same day: no row is that key.
    fx.day_filter(&["15.01.2024"]).await;
    let r = fx.resolved(&key);
    assert_ne!(r.value, json!(5234.5), "a LABEL matched like a key: {r:?}");
    assert_ne!(r.value, json!(7534.5), "a LABEL left the page unfiltered: {r:?}");
}

// ---------------------------------------------------------------------------
// 8. member_key_of == the header's member.key == the model list's key
//    (a Decimal column broke it: BUG-0518)
// ---------------------------------------------------------------------------

#[tokio::test]
async fn member_key_of_equals_every_bi_header_members_key_and_the_model_lists_keys() {
    let batch = sales_batch();
    for (column, field_index) in [("region", 0usize), ("day", 1), ("price", 2)] {
        let mut cache = crate::pivot::operations::build_cache_from_arrow_batches(pid(), &[batch.clone()]).unwrap();
        let mut def = PivotDefinition::new(pid(), (0, 0), (0, 0));
        def.row_fields = vec![PivotField::new(field_index, column.to_string())];
        def.value_fields = vec![ValueField::new(3, "Sum of amount".to_string(), AggregationType::Sum)];
        let view = crate::pivot::operations::safe_calculate_pivot(&def, &mut cache);
        let response = crate::pivot::utils::view_to_response(&view, &def, &mut cache, &de());

        let mut header_keys: Vec<String> = Vec::new();
        for (row, cells) in response.rows.iter().zip(view.cells.iter()) {
            for (wire, engine_cell) in row.cells.iter().zip(cells.iter()) {
                let Some(member) = &wire.member else { continue };
                let (fi, vid) = *engine_cell.group_path.last().expect("a member header has a group path");
                assert_eq!(
                    crate::pivot::utils::member_key_of(&cache, fi, vid).as_deref(),
                    Some(member.key.as_str()),
                    "{column}: member_key_of and the header's member.key disagree"
                );
                header_keys.push(member.key.clone());
            }
        }
        assert!(!header_keys.is_empty(), "{column}: no member headers");

        // The model list's keys are the same set (P4 pins it byte for byte).
        let (bi, conn) = bi_over_sales().await;
        let listed: HashSet<String> =
            crate::bi::commands::bi_get_column_values_core(&bi, conn, "Sales", column).await.unwrap().into_iter().collect();
        let headers: HashSet<String> = header_keys.into_iter().collect();
        assert_eq!(headers, listed, "{column}: the pivot's member keys are not the model list's keys");
    }

    // The ISO day keys are labelled as dates (the cache builder declared them).
    let mut cache = crate::pivot::operations::build_cache_from_arrow_batches(pid(), &[batch]).unwrap();
    let mut def = PivotDefinition::new(pid(), (0, 0), (0, 0));
    def.row_fields = vec![PivotField::new(1, "day".to_string())];
    def.value_fields = vec![ValueField::new(3, "Sum of amount".to_string(), AggregationType::Sum)];
    let view = crate::pivot::operations::safe_calculate_pivot(&def, &mut cache);
    let response = crate::pivot::utils::view_to_response(&view, &def, &mut cache, &de());
    let first = response.rows.iter().flat_map(|r| r.cells.iter()).find_map(|c| c.member.clone()).unwrap();
    assert_eq!(first, MemberRef { key: "2024-01-15".into(), label: "15.01.2024".into() });
}

// ---------------------------------------------------------------------------
// The pivot's own list (Q8): one blank member, keyed ""
// ---------------------------------------------------------------------------

#[test]
fn a_pivots_own_value_list_offers_one_blank_member_keyed_empty() {
    let mut cache = crate::pivot::operations::build_cache_from_arrow_batches(pid(), &[sales_batch()]).unwrap();
    let members = crate::pivot::utils::field_members(&mut cache, 0, &de());
    assert_eq!(keys(&members), vec!["East", "North", "West", ""], "NULL and \"\" fold into ONE member, last");
    assert_eq!(members.last().unwrap(), &MemberRef::blank());
    let prices = crate::pivot::utils::field_members(&mut cache, 2, &de());
    assert_eq!(labels(&prices), vec!["1", "5,5", "10", "3578,27"], "number members in cache order, German");
}

// ---------------------------------------------------------------------------
// The decimal KEY keeps its sign (BUG-0517, found while pinning the key)
// ---------------------------------------------------------------------------

/// A decimal between -1 and 0 is keyed with its sign: `raw / divisor` is 0
/// there, so -0.50 used to read "0.50" -- the same member key as +0.50, and
/// a selection of one selected both. The model pivot keys it the same way.
#[test]
fn a_negative_fractional_decimal_keeps_its_sign_in_the_key() {
    let prices = Decimal128Array::from(vec![-50i128, 50, -150, 0]).with_precision_and_scale(10, 2).unwrap();
    let texts: Vec<Option<String>> =
        (0..prices.len()).map(|i| crate::bi::commands::arrow_value_to_string(&prices, i)).collect();
    assert_eq!(
        texts,
        vec![Some("-0.50".into()), Some("0.50".into()), Some("-1.50".into()), Some("0.00".into())]
    );
    let member = crate::bi::member::arrow_member(&prices, 0, &de()).unwrap();
    assert_eq!(member, MemberRef { key: "-0.50".into(), label: "-0,5".into() });

    let batch = RecordBatch::try_new(
        Arc::new(Schema::new(vec![
            Field::new("price", ArrowType::Decimal128(10, 2), true),
            Field::new("amount", ArrowType::Float64, true),
        ])),
        vec![Arc::new(prices), Arc::new(Float64Array::from(vec![1.0, 2.0, 3.0, 4.0]))],
    )
    .unwrap();
    let cache = crate::pivot::operations::build_cache_from_arrow_batches(pid(), &[batch]).unwrap();
    let field = &cache.fields[0];
    let mut pivot_keys: Vec<String> = (0..field.unique_count() as pivot_engine::ValueId).map(|id| field.member_key(id)).collect();
    pivot_keys.sort();
    assert_eq!(pivot_keys, strings(&["-0.50", "-1.50", "0.00", "0.50"]), "the model pivot keys decimals like the list");
}

// ---------------------------------------------------------------------------
// GETPIVOTDATA on a model Decimal member names the KEY (BUG-0539)
// ---------------------------------------------------------------------------

/// BUG-0518 gave a model Decimal member its scale in the KEY ("5.50"), but
/// GETPIVOTDATA kept writing and matching the cache's f64 label ("5.5"): a
/// formula that named the member by its key -- the spelling the value list,
/// the slicers and the cross-filter carry -- answered #REF!. The pick now
/// writes the key, and the lookup accepts the key AND the older label
/// spelling, so a formula written before the fix keeps its value.
#[test]
fn getpivotdata_on_a_decimal_member_writes_the_key_and_reads_key_and_label() {
    let mut cache = crate::pivot::operations::build_cache_from_arrow_batches(pid(), &[sales_batch()]).unwrap();
    let pivot_id = pid();
    let mut def = PivotDefinition::new(pivot_id, (0, 0), (0, 0));
    def.row_fields = vec![PivotField::new(2, "price".to_string())];
    def.value_fields = vec![ValueField::new(3, "Sum of amount".to_string(), AggregationType::Sum)];
    let view = crate::pivot::operations::safe_calculate_pivot(&def, &mut cache);

    let row = view
        .cells
        .iter()
        .position(|cells| {
            cells.iter().any(|c| {
                c.cell_type == PivotCellType::RowHeader
                    && c.group_path.last().map(|&(fi, vid)| crate::pivot::utils::member_key_of(&cache, fi, vid).as_deref() == Some("5.50")) == Some(true)
            })
        })
        .expect("the 5.50 row");
    let col = view.cells[row].iter().position(|c| c.cell_type == PivotCellType::Data).expect("a data cell in the 5.50 row");

    let mut tables = HashMap::new();
    tables.insert(pivot_id, (def.clone(), cache.clone()));
    let mut views = HashMap::new();
    views.insert(pivot_id, view.clone());

    let formula = crate::pivot::operations::resolve_pivot_data_formula(&tables, &views, pivot_id, row as u32, col as u32)
        .expect("a GETPIVOTDATA for the 5.50 cell");
    assert_eq!(formula.field_item_pairs, vec![("price".to_string(), "5.50".to_string())], "the pick names the member KEY");

    for item in ["5.50", "5.5"] {
        let got = crate::pivot::operations::lookup_pivot_data(&tables, &views, "Sum of amount", None, 0, 0, &[("price", item)]);
        assert_eq!(got, Some(4000.0), "GETPIVOTDATA(.., \"price\", \"{item}\") did not find the 5.50 member");
    }
    let wrong = crate::pivot::operations::lookup_pivot_data(&tables, &views, "Sum of amount", None, 0, 0, &[("price", "5,5")]);
    assert_eq!(wrong, None, "a LOCALE label (de-DE \"5,5\") must never match");
}
