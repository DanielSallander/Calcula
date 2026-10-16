//! FILENAME: app/src-tauri/src/object_bindings/measures_tests.rs
// PURPOSE: The measure pass and the page-filter mirror (D §3.8, WP-D S4),
//          engine-backed over an in-memory model (no database), through the
//          command's own async dispatcher (`handle_request_async`):
//          - a bound `[Measure]` equals the Card's measure-only query under the
//            same page filters, formatted with the measure's format string;
//          - the filter SIGNATURE keys the cache: after a filter change a
//            measure is pending until its new value arrives, never the previous
//            filter's number, and back-and-forth answers each filter's own;
//          - one unknown measure in a batch fails only its binding;
//          - a package model key resolves by its data-source id;
//          - no connection -> "(model not connected)"; a security refusal ->
//            "(Refused)" (typed, positive control included);
//          - a literal CUBEVALUE is served and NOT filtered by the page;
//          - the page's models, falling back to the workbook's.
//
// Model: Sales(region, year, amount); Revenue = SUM(amount) formatted "#,##0".
// Rows: East 1000, West 2000, East 3000, North 4000 -> total 10,000,
// East 4,000, West 2,000.

use std::collections::HashMap;
use std::sync::Arc;

use arrow::array::{Float64Array, StringArray};
use arrow::datatypes::{DataType as ArrowType, Field, Schema};
use arrow::record_batch::RecordBatch;
use bi_engine::{
    sum_measure, Column, DataModel, DataType, Engine, InMemoryConnector, QueryRequest, SourceBinding, StorageMode,
    Table,
};
use serde_json::{json, Value};
use tokio::sync::Mutex as TokioMutex;

use super::eval::{MODEL_NOT_CONNECTED_DISPLAY, REFUSED_DISPLAY};
use super::measures::{self, FetchScope};
use super::object_json::ObjectStores;
use super::store::{BindingKey, StoredBinding};
use super::*;
use crate::api_types::{ObjectBindingKind, ObjectBindingRef, ObjectBindingsRequest, ObjectBindingsResponse, ResolvedBinding};
use crate::bi::types::{BiState, Connection, ConnectionId, ConnectionType};
use crate::document_effect::test_seed_effect;
use crate::persistence::FileState;
use crate::pivot::headless::{compute_design_query_view, DesignQueryFieldRef, DesignQueryRequest};
use crate::pivot::types::BiValueFieldRef;

const DATA: usize = 0;
const REPORT: usize = 1;
const OTHER: usize = 2;

fn new_id() -> [u8; 16] {
    identity::generate_uuid_v7()
}

fn sales_batch() -> RecordBatch {
    RecordBatch::try_new(
        Arc::new(Schema::new(vec![
            Field::new("region", ArrowType::Utf8, true),
            Field::new("year", ArrowType::Utf8, true),
            Field::new("amount", ArrowType::Float64, true),
        ])),
        vec![
            Arc::new(StringArray::from(vec!["East", "West", "East", "North"])),
            Arc::new(StringArray::from(vec!["Y1", "Y1", "Y2", "Y2"])),
            Arc::new(Float64Array::from(vec![1000.0, 2000.0, 3000.0, 4000.0])),
        ],
    )
    .unwrap()
}

fn sales_table() -> Table {
    Table::new(
        "Sales",
        vec![
            Column::new("region", DataType::String),
            Column::new("year", DataType::String),
            Column::new("amount", DataType::Float64),
        ],
    )
    .unwrap()
    .with_storage_mode(StorageMode::InMemory)
}

fn sales_model() -> DataModel {
    DataModel::builder()
        .add_table(sales_table())
        .add_measure(sum_measure("Revenue", "Sales", "amount").with_format_string("#,##0"))
        .build()
        .unwrap()
}

/// The same model with an `Analyst` role that denies the column Revenue reads.
fn denied_model() -> DataModel {
    DataModel::builder()
        .add_table(sales_table())
        .add_measure(sum_measure("Revenue", "Sales", "amount").with_format_string("#,##0"))
        .add_security_role(
            bi_engine::SecurityRole::new("Analyst").with_denied_columns(vec!["Sales[amount]".to_string()]),
        )
        .build()
        .unwrap()
}

/// A cache-warm connection named `name` over the sales rows.
async fn connection(name: &str, model: DataModel, package_ds: Option<&str>, role: Option<&str>) -> Connection {
    let mut engine = Engine::new(model);
    let idx = engine.add_in_memory_source(InMemoryConnector::new().with_table("public", "sales", sales_batch()));
    engine.bind_table("Sales", idx, SourceBinding::new("public", "sales"));
    // Warm the in-memory cache so the cache-warm check skips the database
    // auto-connect (there is no database here).
    let _ = engine
        .query_auto_refresh(QueryRequest {
            measures: vec!["Revenue".into()],
            group_by: vec![bi_engine::ColumnRef::new("Sales", "region")],
            ..Default::default()
        })
        .await;
    Connection {
        id: identity::EntityId::from_bytes(new_id()),
        name: name.into(),
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
        package_data_source_id: package_ds.map(str::to_string),
        active_role: role.map(str::to_string),
        base_model: None,
        calculated_measures: vec![],
    }
}

/// Data is a worksheet (active); Report and Other are canvas pages. One model
/// connection, "Sales".
struct Fx {
    state: AppState,
    file: FileState,
    slicers: crate::slicer::SlicerState,
    timelines: crate::timeline_slicer::TimelineSlicerState,
    pivots: crate::pivot::types::PivotState,
    pane: crate::pane_control::PaneControlState,
    ribbon: crate::ribbon_filter::RibbonFilterState,
    bi: BiState,
    conn: ConnectionId,
    ids: Vec<identity::SheetId>,
}

impl Fx {
    async fn new() -> Fx {
        Fx::with(connection("Sales", sales_model(), None, None).await).await
    }

    async fn with(conn: Connection) -> Fx {
        let state = crate::create_app_state();
        let seed = test_seed_effect();
        let ids: Vec<identity::SheetId> = (0..3).map(|_| identity::SheetId::from_bytes(new_id())).collect();
        *state.sheet_names.write(&seed).unwrap() = vec!["Data".to_string(), "Report".to_string(), "Other".to_string()];
        *state.sheet_ids.write(&seed).unwrap() = ids.clone();
        *state.sheet_kinds.write(&seed).unwrap() = vec![
            ::persistence::SheetKind::Worksheet,
            ::persistence::SheetKind::new_canvas(),
            ::persistence::SheetKind::new_canvas(),
        ];
        *state.sheet_visibility.write(&seed).unwrap() = vec!["visible".to_string(); 3];
        *state.grids.write(&seed).unwrap() = vec![engine::Grid::new(), engine::Grid::new(), engine::Grid::new()];
        // Formatting is locale-dependent; the expected texts are en-US.
        *state.locale.lock().unwrap() = engine::LocaleSettings::invariant();
        let id = conn.id;
        let bi = BiState::new();
        bi.connections.lock().unwrap().insert(id, conn);
        Fx {
            state,
            file: FileState::default(),
            slicers: crate::slicer::SlicerState::new(),
            timelines: crate::timeline_slicer::TimelineSlicerState::new(),
            pivots: crate::pivot::types::PivotState::new(),
            pane: crate::pane_control::PaneControlState::new(),
            ribbon: crate::ribbon_filter::RibbonFilterState::new(),
            bi,
            conn: id,
            ids,
        }
    }

    fn cx(&self) -> BindingCx<'_> {
        BindingCx {
            state: &self.state,
            file_state: &self.file,
            slicers: &self.slicers,
            timelines: &self.timelines,
            pivots: &self.pivots,
            pane: &self.pane,
            ribbon: &self.ribbon,
        }
    }

    fn stores(&self) -> ObjectStores<'_> {
        ObjectStores { state: &self.state, slicers: &self.slicers, timelines: &self.timelines, pivots: &self.pivots }
    }

    /// Send one request in its WIRE spelling through the command's dispatcher.
    async fn send(&self, request: Value) -> Result<ObjectBindingsResponse, String> {
        let request: ObjectBindingsRequest =
            serde_json::from_value(request.clone()).unwrap_or_else(|e| panic!("{request} does not deserialize: {e}"));
        // NOT boxed here on purpose: the dispatcher boxes its own measure
        // pass, and these tests run it on a 2 MB test thread -- the size of a
        // tokio worker's stack, which is where the command runs.
        handle_request_async(&self.cx(), &self.bi, request).await.map(|h| h.response)
    }

    /// A Card on `sheet` reading `VALUES: [Revenue]` from `conn` -- so the page
    /// USES that model.
    fn card(&self, sheet: usize, conn: ConnectionId) -> ObjectBindingRef {
        let id = identity::EntityId::from_bytes(new_id());
        let envelope = json!({
            "chartId": id.to_string(), "name": "Revenue card", "sheetIndex": sheet,
            "spec": { "mark": "card", "data": { "type": "designQuery", "connectionId": conn.to_string(), "dslText": "VALUES: [Revenue]" } }
        });
        self.state.charts.write(&test_seed_effect()).unwrap().push(crate::api_types::ChartEntry {
            id,
            sheet_index: sheet,
            spec_json: envelope.to_string(),
        });
        ObjectBindingRef { kind: ObjectBindingKind::Chart, id: id.to_string() }
    }

    /// Store a row directly (a load, or a row Set would refuse).
    fn store(&self, object: &ObjectBindingRef, path: &str, formula: &str, model: Option<&str>) -> BindingKey {
        let key = BindingKey { object: object.clone(), path: path.to_string() };
        let mut store = self.state.object_bindings.write(&test_seed_effect()).unwrap();
        store
            .bindings
            .insert(key.clone(), StoredBinding { formula: formula.to_string(), model: model.map(str::to_string) });
        store.bump_generation();
        key
    }

    fn resolved(&self, key: &BindingKey) -> ResolvedBinding {
        self.state
            .object_binding_runtime
            .lock()
            .unwrap()
            .resolved
            .get(key)
            .cloned()
            .unwrap_or_else(|| panic!("no resolved value for {key:?}"))
    }

    /// The page-filter snapshot `Sales.region IN items` on Report (none = no
    /// filters at all).
    fn region_filter(&self, items: Option<&[&str]>) -> Value {
        let pages = match items {
            None => json!([]),
            Some(items) => json!([{
                "sheetIndex": REPORT, "connectionId": self.conn.to_string(),
                "filters": [{ "field": "Sales.region", "includedItems": items, "filterLevel": 1 }]
            }]),
        };
        json!({ "op": "setPageFilters", "pages": pages })
    }

    async fn filter(&self, items: Option<&[&str]>) {
        self.send(self.region_filter(items)).await.expect("setPageFilters");
    }

    async fn refresh(&self) {
        self.send(json!({ "op": "refreshMeasures", "sheetIndex": null })).await.expect("refreshMeasures");
    }

    /// The ORACLE: an independent measure-only design query, built by hand the
    /// way the Card reader builds one, under the same region filter.
    async fn oracle(&self, items: Option<&[&str]>) -> f64 {
        let request = DesignQueryRequest {
            connection_id: self.conn,
            row_fields: Vec::new(),
            column_fields: Vec::new(),
            value_fields: vec![BiValueFieldRef { measure_name: "Revenue".to_string(), custom_name: None, number_format: None }],
            filter_fields: Vec::new(),
            page_filter_fields: items
                .map(|items| {
                    vec![DesignQueryFieldRef {
                        table: "Sales".to_string(),
                        column: "region".to_string(),
                        is_lookup: false,
                        hidden_items: None,
                        included_items: Some(items.iter().map(|s| s.to_string()).collect()),
                        level: None,
                    }]
                })
                .unwrap_or_default(),
            calculated_fields: None,
            value_column_order: None,
            layout: None,
        };
        let (_def, _cache, view) =
            Box::pin(compute_design_query_view(&self.bi, &request)).await.expect("the oracle query");
        view.rows
            .iter()
            .find(|r| r.row_type == pivot_engine::PivotRowType::GrandTotal)
            .and_then(|r| {
                view.cells[r.view_row].iter().find_map(|c| match c.value {
                    pivot_engine::PivotCellValue::Number(n) if c.value_field_index.is_some() => Some(n),
                    _ => None,
                })
            })
            .expect("the oracle's grand total")
    }
}

fn binding_of(response: ObjectBindingsResponse) -> ObjectBindingInfo {
    match response {
        ObjectBindingsResponse::Binding { binding } => binding,
        r => panic!("expected a binding, got {r:?}"),
    }
}

fn set_goal(card: &ObjectBindingRef, formula: &str) -> Value {
    json!({ "op": "set", "object": card, "path": "/spec/markOptions/goal", "formula": formula, "invariant": true })
}

// ---------------------------------------------------------------------------
// The value is the Card's
// ---------------------------------------------------------------------------

#[tokio::test]
async fn a_bound_measure_equals_the_cards_measure_only_query_under_the_same_filters() {
    let fx = Fx::new().await;
    let card = fx.card(REPORT, fx.conn);

    // Set fetches its page before answering: the value, not `pending`.
    let info = binding_of(fx.send(set_goal(&card, "=[Revenue]")).await.unwrap());
    assert_eq!(info.model.as_deref(), Some(fx.conn.to_string().as_str()), "the page's only model is the default");
    let r = info.resolved.expect("a resolved value");
    assert!(!r.pending, "Set fetched the page's measures first: {r:?}");
    let total = fx.oracle(None).await;
    assert_eq!(total, 10_000.0, "fixture: 1000 + 2000 + 3000 + 4000");
    assert_eq!(r.value, json!(total));
    assert_eq!(r.display, "10,000", "formatted with the measure's own format string");

    fx.filter(Some(&["East"])).await;
    let key = BindingKey { object: card.clone(), path: "/spec/markOptions/goal".to_string() };
    let east = fx.oracle(Some(&["East"])).await;
    assert_eq!(east, 4_000.0, "fixture: East is 1000 + 3000");
    let r = fx.resolved(&key);
    assert_eq!((r.value.clone(), r.display.as_str(), r.pending), (json!(east), "4,000", false), "{r:?}");

    // Arithmetic over a measure keeps the value, not the text.
    let info = binding_of(fx.send(set_goal(&card, "=[Revenue]*1.1")).await.unwrap());
    assert_eq!(info.resolved.unwrap().value, json!(east * 1.1));
}

#[tokio::test]
async fn the_filter_signature_keys_the_cache_and_a_moved_filter_is_never_served_stale() {
    let fx = Fx::new().await;
    let card = fx.card(REPORT, fx.conn);
    binding_of(fx.send(set_goal(&card, "=[Revenue]")).await.unwrap());
    let key = BindingKey { object: card.clone(), path: "/spec/markOptions/goal".to_string() };

    fx.filter(Some(&["East"])).await;
    assert_eq!(fx.resolved(&key).value, json!(4_000.0));

    // The mirror moves to West WITHOUT the measure pass (the unit-tier op):
    // nothing is cached under West's signature, so the value is PENDING --
    // East's 4,000 must not be shown as West's.
    let west = serde_json::from_value(fx.region_filter(Some(&["West"]))["pages"].clone()).unwrap();
    let changed = set_page_filters_core(&fx.cx(), west);
    assert_eq!(changed, vec![fx.ids[REPORT]]);
    let r = fx.resolved(&key);
    assert!(r.pending && r.value.is_null() && r.error.is_none(), "a stale number under a new filter: {r:?}");

    // The pass fills West.
    fx.send(json!({ "op": "refreshMeasures", "sheetIndex": REPORT })).await.unwrap();
    assert_eq!(fx.resolved(&key).value, json!(2_000.0));

    // Back and forth: each filter answers its own number.
    fx.filter(Some(&["East"])).await;
    assert_eq!(fx.resolved(&key).value, json!(4_000.0), "back to East");
    fx.filter(Some(&["West"])).await;
    assert_eq!(fx.resolved(&key).value, json!(2_000.0), "West again");
    fx.filter(None).await;
    assert_eq!(fx.resolved(&key).value, json!(10_000.0), "the filter withdrawn: the unfiltered total");
}

#[test]
fn the_signature_ignores_the_order_of_filters_and_items() {
    use crate::api_types::PageFilterWire;
    let f = |field: &str, items: &[&str], level: u8| PageFilterWire {
        field: field.to_string(),
        included_items: items.iter().map(|s| s.to_string()).collect(),
        filter_level: level,
    };
    let a = [f("Sales.region", &["East", "West"], 1), f("Sales.year", &["Y1"], 1)];
    let b = [f("Sales.year", &["Y1"], 1), f("Sales.region", &["West", "East"], 1)];
    assert_eq!(measures::filter_signature(&a), measures::filter_signature(&b));
    assert_ne!(measures::filter_signature(&a), measures::filter_signature(&a[..1]), "a filter less is another page state");
    assert_ne!(
        measures::filter_signature(&[f("Sales.region", &["East"], 1)]),
        measures::filter_signature(&[f("Sales.region", &["East"], 2)]),
        "a pinned filter is another state"
    );
    assert_ne!(measures::filter_signature(&[]), measures::filter_signature(&[f("Sales.region", &[], 1)]), "keeps-nothing is a filter");
}

#[test]
fn page_filter_fields_split_against_the_models_tables_and_skip_an_unknown_one() {
    use crate::api_types::PageFilterWire;
    let tables = vec!["Sales".to_string(), "BI.dim_territory".to_string()];
    let filters = vec![
        PageFilterWire { field: "Sales.region".into(), included_items: vec!["East".into()], filter_level: 1 },
        PageFilterWire { field: "BI.dim_territory.Region".into(), included_items: vec!["Europe".into()], filter_level: 3 },
        PageFilterWire { field: "Nowhere.x".into(), included_items: vec!["a".into()], filter_level: 1 },
    ];
    let fields = measures::page_filter_fields(&filters, &tables);
    let shape: Vec<(String, String, Option<Vec<String>>, Option<u8>)> = fields
        .into_iter()
        .map(|f| (f.table, f.column, f.included_items, f.level))
        .collect();
    assert_eq!(
        shape,
        vec![
            ("Sales".to_string(), "region".to_string(), Some(vec!["East".to_string()]), None),
            ("BI.dim_territory".to_string(), "Region".to_string(), Some(vec!["Europe".to_string()]), Some(3)),
        ],
        "a dotted table name splits on the TABLE; a field naming no table is skipped, not sent"
    );
}

// ---------------------------------------------------------------------------
// Failures fail only what they reach
// ---------------------------------------------------------------------------

#[tokio::test]
async fn an_unknown_measure_in_a_batch_fails_only_its_binding() {
    let fx = Fx::new().await;
    let card = fx.card(REPORT, fx.conn);
    let model = fx.conn.to_string();
    // Set refuses an unknown measure; a row can still arrive (a model that
    // dropped the measure since, a hand-edited file), so it is stored directly.
    let good = fx.store(&card, "/spec/markOptions/goal", "=[Revenue]", Some(&model));
    let bad = fx.store(&card, "/spec/markOptions/min", "=[Ghost]", Some(&model));

    fx.refresh().await;

    let g = fx.resolved(&good);
    assert_eq!((g.value.clone(), g.error.clone(), g.pending), (json!(10_000.0), None, false), "{g:?}");
    let b = fx.resolved(&bad);
    assert_eq!((b.display.as_str(), b.pending), ("#N/A", false), "{b:?}");
    assert!(b.error.as_deref().is_some_and(|e| !e.is_empty()), "the failure says why: {b:?}");
}

#[tokio::test]
async fn a_model_key_that_names_no_connection_reads_model_not_connected() {
    let fx = Fx::new().await;
    let card = fx.card(REPORT, fx.conn);
    let key = fx.store(&card, "/spec/markOptions/goal", "=[Revenue]", Some("gone-model"));

    fx.refresh().await;

    let r = fx.resolved(&key);
    assert_eq!((r.display.as_str(), r.value.clone(), r.pending), (MODEL_NOT_CONNECTED_DISPLAY, Value::Null, false), "{r:?}");
    assert!(r.error.as_deref().unwrap().contains("gone-model"), "the sentence names the model: {r:?}");
}

#[tokio::test]
async fn a_security_refusal_reads_refused_and_the_same_measure_without_the_role_answers() {
    let fx = Fx::with(connection("Sales", denied_model(), None, Some("Analyst")).await).await;
    let card = fx.card(REPORT, fx.conn);
    let key = fx.store(&card, "/spec/markOptions/goal", "=[Revenue]", Some(&fx.conn.to_string()));

    fx.refresh().await;
    let r = fx.resolved(&key);
    assert_eq!((r.display.as_str(), r.pending), (REFUSED_DISPLAY, false), "{r:?}");
    assert!(r.error.is_some(), "the refusal says why: {r:?}");

    // Positive control: the role cleared, the same binding answers.
    fx.bi.connections.lock().unwrap().get_mut(&fx.conn).unwrap().active_role = None;
    fx.refresh().await;
    assert_eq!(fx.resolved(&key).value, json!(10_000.0));
}

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

#[tokio::test]
async fn a_package_model_key_resolves_by_its_data_source_id() {
    let fx = Fx::with(connection("Sales", sales_model(), Some("aw-ds"), None).await).await;
    let card = fx.card(REPORT, fx.conn);

    assert_eq!(measures::resolve_model(&fx.bi, "aw-ds"), Some(fx.conn));
    assert_eq!(measures::resolve_model(&fx.bi, &fx.conn.to_string()), Some(fx.conn), "the session id still names it");
    assert_eq!(measures::resolve_model(&fx.bi, "nope"), None);

    let info = binding_of(fx.send(set_goal(&card, "=[Revenue]")).await.unwrap());
    assert_eq!(info.model.as_deref(), Some("aw-ds"), "the STABLE key is stored, never the session uuid");
    assert_eq!(info.resolved.unwrap().value, json!(10_000.0));
}

#[tokio::test]
async fn the_page_models_come_first_and_the_workbook_is_the_fallback() {
    let fx = Fx::new().await;
    let budget = connection("Budget", sales_model(), None, None).await;
    let budget_id = budget.id;
    fx.bi.connections.lock().unwrap().insert(budget_id, budget);
    fx.card(REPORT, fx.conn);

    let on_report = Box::pin(measures::page_models(&fx.stores(), &fx.bi, REPORT)).await;
    assert_eq!(on_report.len(), 1, "Report uses only Sales: {on_report:?}");
    assert_eq!(on_report[0].model_key, fx.conn.to_string());
    assert!(on_report[0].is_default);
    assert_eq!(on_report[0].measures, vec!["Revenue".to_string()]);

    let on_other = Box::pin(measures::page_models(&fx.stores(), &fx.bi, OTHER)).await;
    let mut names: Vec<&str> = on_other.iter().map(|m| m.name.as_str()).collect();
    names.sort();
    assert_eq!(names, vec!["Budget", "Sales"], "a page with no model objects offers the workbook's");
    assert!(on_other.iter().all(|m| !m.is_default), "two models: a formula must say which");

    // The measure picker answers the same list through the command.
    let card_on_other = fx.card(OTHER, budget_id);
    match fx.send(json!({ "op": "measures", "object": card_on_other })).await.unwrap() {
        ObjectBindingsResponse::Measures { models } => {
            assert_eq!(models.len(), 1, "Other now uses Budget: {models:?}");
            assert_eq!(models[0].model_key, budget_id.to_string());
        }
        r => panic!("{r:?}"),
    }
    assert!(measures::page_connection_ids(&fx.stores(), DATA).is_empty());
}

// ---------------------------------------------------------------------------
// CUBE
// ---------------------------------------------------------------------------

#[tokio::test]
async fn a_literal_cubevalue_is_served_and_is_not_filtered_by_the_page() {
    let fx = Fx::new().await;
    let card = fx.card(REPORT, fx.conn);
    let cube = fx.store(&card, "/spec/markOptions/goal", r#"=CUBEVALUE("Sales","[Revenue]")"#, None);
    let measure = fx.store(&card, "/spec/markOptions/min", "=[Revenue]", Some(&fx.conn.to_string()));

    // Before any fetch the CUBE value is pending -- never a #N/A it does not mean.
    resolve_all_core(&fx.cx());
    let r = fx.resolved(&cube);
    assert!(r.pending && r.error.is_none(), "{r:?}");

    fx.filter(Some(&["East"])).await;
    fx.refresh().await;
    let c = fx.resolved(&cube);
    assert_eq!((c.value.clone(), c.error.clone(), c.pending), (json!(10_000.0), None, false), "{c:?}");
    assert_eq!(fx.resolved(&measure).value, json!(4_000.0), "[Revenue] follows the page's slicer; CUBEVALUE does not");
}

#[tokio::test]
async fn resolve_all_fetches_what_a_reload_left_missing() {
    let fx = Fx::new().await;
    let card = fx.card(REPORT, fx.conn);
    let key = fx.store(&card, "/spec/markOptions/goal", "=[Revenue]", Some(&fx.conn.to_string()));
    let cube = fx.store(&card, "/spec/markOptions/max", r#"=CUBEVALUE("Sales","[Revenue]")"#, None);

    let values = match fx.send(json!({ "op": "resolveAll" })).await.unwrap() {
        ObjectBindingsResponse::Resolved { values } => values,
        r => panic!("{r:?}"),
    };
    assert_eq!(values.len(), 2);
    assert!(values.iter().all(|v| !v.pending && v.value == json!(10_000.0)), "{values:?}");
    assert_eq!(fx.resolved(&key).display, "10,000");
    assert_eq!(fx.resolved(&cube).value, json!(10_000.0));
}

#[tokio::test]
async fn a_measure_pass_never_dirties_the_document_or_records_undo() {
    let fx = Fx::new().await;
    let card = fx.card(REPORT, fx.conn);
    fx.store(&card, "/spec/markOptions/goal", "=[Revenue]", Some(&fx.conn.to_string()));
    let depth = fx.state.undo_stack.lock().unwrap().undo_depth();
    let generation = fx.state.object_bindings.read().unwrap().generation;

    fx.filter(Some(&["East"])).await;
    fx.refresh().await;
    fx.send(json!({ "op": "resolveAll" })).await.unwrap();
    assert!(
        Box::pin(measures::refresh_measures(&fx.stores(), &fx.bi, &FetchScope::refresh(None))).await,
        "precondition: there was something to fetch"
    );

    assert!(!fx.file.is_dirty(), "resolved values are transient (D §2 invariant 3)");
    assert_eq!(fx.state.undo_stack.lock().unwrap().undo_depth(), depth);
    assert_eq!(fx.state.object_bindings.read().unwrap().generation, generation, "the persisted store is never written");
}

