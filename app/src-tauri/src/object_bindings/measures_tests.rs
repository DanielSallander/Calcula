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
            user_files: Box::leak(Box::new(crate::persistence::UserFilesState::default())),
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
                "sheetId": self.ids[REPORT].to_string(), "connectionId": self.conn.to_string(),
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
            tuple_filters: Vec::new(),
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
    let sig = |filters: &[PageFilterWire]| measures::filter_signature(&measures::PageFilterSet::new(filters.to_vec(), Vec::new()));
    let a = [f("Sales.region", &["East", "West"], 1), f("Sales.year", &["Y1"], 1)];
    let b = [f("Sales.year", &["Y1"], 1), f("Sales.region", &["West", "East"], 1)];
    assert_eq!(sig(&a), sig(&b));
    assert_ne!(sig(&a), sig(&a[..1]), "a filter less is another page state");
    assert_ne!(
        sig(&[f("Sales.region", &["East"], 1)]),
        sig(&[f("Sales.region", &["East"], 2)]),
        "a pinned filter is another state"
    );
    assert_ne!(sig(&[]), sig(&[f("Sales.region", &[], 1)]), "keeps-nothing is a filter");
}

/// P4: the signature HASHES TUPLES too -- order of tuples is not meaning, but
/// which tuples, which fields and an empty tuple list are.
#[test]
fn the_signature_hashes_tuple_filters_and_ignores_their_order() {
    use crate::api_types::TupleFilterWire;
    let t = |fields: &[&str], tuples: &[&[&str]]| TupleFilterWire {
        fields: fields.iter().map(|s| s.to_string()).collect(),
        tuples: tuples.iter().map(|row| row.iter().map(|s| s.to_string()).collect()).collect(),
    };
    let sig = |tuples: Vec<TupleFilterWire>| measures::filter_signature(&measures::PageFilterSet::new(Vec::new(), tuples));
    let fields = ["Sales.region", "Sales.year"];
    let one = sig(vec![t(&fields, &[&["East", "Y1"], &["North", "Y2"]])]);
    assert_eq!(one, sig(vec![t(&fields, &[&["North", "Y2"], &["East", "Y1"]])]), "tuple order is not meaning");
    assert_ne!(one, sig(vec![t(&fields, &[&["East", "Y2"], &["North", "Y1"]])]), "the same members, other pairs");
    assert_ne!(one, sig(vec![t(&fields, &[&["East", "Y1"]])]), "a tuple less");
    assert_ne!(sig(Vec::new()), sig(vec![t(&fields, &[])]), "an empty tuple list keeps nothing: a filter");
    assert_ne!(one, measures::filter_signature(&measures::PageFilterSet::default()), "a selection is a page state");
}

#[test]
fn tuple_filter_fields_split_against_the_models_tables_and_skip_an_unknown_tuple_whole() {
    use crate::api_types::TupleFilterWire;
    let tables = vec!["Sales".to_string(), "BI.dim_territory".to_string()];
    let tuples = vec![
        TupleFilterWire {
            fields: vec!["Sales.region".into(), "BI.dim_territory.Region".into()],
            tuples: vec![vec!["East".into(), "".into()]],
        },
        // One column the model does not have: the WHOLE tuple filter is
        // skipped -- dropping the column would widen the selection.
        TupleFilterWire { fields: vec!["Sales.region".into(), "Nowhere.x".into()], tuples: vec![vec!["East".into(), "a".into()]] },
    ];
    let out = measures::tuple_filter_fields(&tuples, &tables);
    assert_eq!(out.len(), 1, "{out:?}");
    let columns: Vec<(String, String)> = out[0].fields.iter().map(|c| (c.table.clone(), c.column.clone())).collect();
    assert_eq!(
        columns,
        vec![("Sales".to_string(), "region".to_string()), ("BI.dim_territory".to_string(), "Region".to_string())]
    );
    assert_eq!(out[0].tuples, vec![vec!["East".to_string(), String::new()]], "keys go in as KEYS: the blank key stays \"\"");
    assert_eq!(out[0].level, None);
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


/// P2 S5: a measure with NO format string shows General in the APP locale
/// ("1234,5" under de-DE), as a formatted one already did. It used to fall
/// back to the invariant `format_cell_value_simple`, so the same Card read
/// "1.234,50" with a format and "1234.5" without one.
#[test]
fn an_unformatted_measure_reads_in_the_app_locale() {
    let de = engine::LocaleSettings::from_locale_id("de-DE");
    assert_eq!(measures::format_measure(1234.5, None, &de), "1234,5");
    assert_eq!(measures::format_measure(1234.5, Some("  "), &de), "1234,5", "a blank code is no code");
    assert_eq!(measures::format_measure(1234.5, None, &engine::LocaleSettings::invariant()), "1234.5");
    assert_eq!(measures::format_measure(1234.5, Some("#,##0.00"), &de), "1.234,50");
}

// ---------------------------------------------------------------------------
// P4 S4c: per-object overrides and tuple filters
// ---------------------------------------------------------------------------

impl Fx {
    /// The snapshot of Report: `Sales.region IN page_items` for every object,
    /// and each `(object, items)` in `overrides` reading `Sales.region IN items`
    /// instead (`None` = the object reads NO filter -- a `none` pair).
    fn snapshot(&self, page_items: &[&str], overrides: &[(&ObjectBindingRef, Option<&[&str]>)]) -> Value {
        let region = |items: &[&str]| json!([{ "field": "Sales.region", "includedItems": items, "filterLevel": 1 }]);
        let objects: Vec<Value> = overrides
            .iter()
            .map(|(object, items)| {
                json!({ "object": object, "filters": items.map(region).unwrap_or_else(|| json!([])), "tupleFilters": [] })
            })
            .collect();
        json!({ "op": "setPageFilters", "pages": [{
            "sheetId": self.ids[REPORT].to_string(), "connectionId": self.conn.to_string(),
            "filters": region(page_items), "tupleFilters": [], "objects": objects
        }] })
    }

    /// Two Cards on Report, each with `=[Revenue]` bound (the first is the
    /// "sibling", the second the object that gets an override).
    async fn two_cards(&self) -> (BindingKey, BindingKey) {
        let a = self.card(REPORT, self.conn);
        let b = self.card(REPORT, self.conn);
        binding_of(self.send(set_goal(&a, "=[Revenue]")).await.unwrap());
        binding_of(self.send(set_goal(&b, "=[Revenue]")).await.unwrap());
        let key = |o: &ObjectBindingRef| BindingKey { object: o.clone(), path: "/spec/markOptions/goal".to_string() };
        (key(&a), key(&b))
    }
}

/// SABOTAGE: make `BindingRuntime::effective_filters` ignore `object_filters`
/// -- the overridden Card then reads the page's 4,000 and this fails.
#[tokio::test]
async fn an_object_override_gives_that_objects_measure_its_own_value_while_a_sibling_reads_the_page() {
    let fx = Fx::new().await;
    let (sibling, own) = fx.two_cards().await;

    // The page is filtered to East; the second Card's pair is `none`: it reads
    // no filter at all.
    fx.send(fx.snapshot(&["East"], &[(&own.object, None)])).await.unwrap();
    let s = fx.resolved(&sibling);
    let o = fx.resolved(&own);
    assert_eq!((s.value.clone(), s.pending), (json!(fx.oracle(Some(&["East"])).await), false), "sibling: {s:?}");
    assert_eq!((o.value.clone(), o.pending), (json!(fx.oracle(None).await), false), "override: {o:?}");
    assert_eq!((s.value, o.value), (json!(4_000.0), json!(10_000.0)), "fixture: East 4,000, all 10,000");

    // An override can FILTER differently too, not only clear.
    fx.send(fx.snapshot(&["East"], &[(&own.object, Some(&["West"]))])).await.unwrap();
    assert_eq!(fx.resolved(&sibling).value, json!(4_000.0));
    assert_eq!(fx.resolved(&own).value, json!(2_000.0), "West");
}

#[tokio::test]
async fn an_override_removed_falls_back_to_the_page_set() {
    let fx = Fx::new().await;
    let (sibling, own) = fx.two_cards().await;
    fx.send(fx.snapshot(&["East"], &[(&own.object, None)])).await.unwrap();
    assert_eq!(fx.resolved(&own).value, json!(10_000.0), "precondition: the override applies");

    // The next snapshot carries no override: the Card reads its page again.
    fx.send(fx.snapshot(&["East"], &[])).await.unwrap();
    let o = fx.resolved(&own);
    assert_eq!((o.value.clone(), o.pending), (json!(4_000.0), false), "{o:?}");
    assert_eq!(fx.resolved(&sibling).value, json!(4_000.0));
    assert!(fx.state.object_binding_runtime.lock().unwrap().object_filters.is_empty(), "the snapshot REPLACES the overrides");
}

#[tokio::test]
async fn a_tuple_filter_reaches_the_measure_query() {
    let fx = Fx::new().await;
    let card = fx.card(REPORT, fx.conn);
    binding_of(fx.send(set_goal(&card, "=[Revenue]")).await.unwrap());
    let key = BindingKey { object: card.clone(), path: "/spec/markOptions/goal".to_string() };

    // (East, Y1) OR (North, Y2): 1000 + 4000. The rectangle region IN (East,
    // North) x year IN (Y1, Y2) would read 8,000 -- a tuple is not two IN-lists.
    let tuples = |rows: Value| {
        json!({ "op": "setPageFilters", "pages": [{
            "sheetId": fx.ids[REPORT].to_string(), "connectionId": fx.conn.to_string(), "filters": [],
            "tupleFilters": [{ "fields": ["Sales.region", "Sales.year"], "tuples": rows }], "objects": []
        }] })
    };
    fx.send(tuples(json!([["East", "Y1"], ["North", "Y2"]]))).await.unwrap();
    let r = fx.resolved(&key);
    assert_eq!((r.value.clone(), r.pending, r.error.clone()), (json!(5_000.0), false, None), "{r:?}");

    // An empty tuple list keeps nothing: a blank total, not the unfiltered 10,000.
    fx.send(tuples(json!([]))).await.unwrap();
    let r = fx.resolved(&key);
    assert_ne!(r.value, json!(10_000.0), "an empty selection must not read as no selection: {r:?}");
    assert!(!r.pending, "{r:?}");

    // A tuple filter inside an object's override reaches that object's query.
    fx.send(json!({ "op": "setPageFilters", "pages": [{
        "sheetId": fx.ids[REPORT].to_string(), "connectionId": fx.conn.to_string(), "filters": [], "tupleFilters": [],
        "objects": [{ "object": card, "filters": [],
            "tupleFilters": [{ "fields": ["Sales.region", "Sales.year"], "tuples": [["West", "Y1"]] }] }]
    }] }))
    .await
    .unwrap();
    assert_eq!(fx.resolved(&key).value, json!(2_000.0), "(West, Y1) through the override");
}

/// The `eval.rs` rule "a filter change shows pending, never the old number",
/// PER OBJECT: the mirror moves without the measure pass (the unit-tier op).
#[tokio::test]
async fn a_filter_change_shows_pending_per_object_never_the_old_number() {
    let fx = Fx::new().await;
    let (sibling, own) = fx.two_cards().await;
    fx.send(fx.snapshot(&["East"], &[])).await.unwrap();
    assert_eq!(fx.resolved(&own).value, json!(4_000.0));

    // Only the second Card's filters move (an override appears): it is PENDING,
    // and its sibling -- whose filters did not move -- keeps its value.
    let pages = serde_json::from_value(fx.snapshot(&["East"], &[(&own.object, Some(&["West"]))])["pages"].clone()).unwrap();
    assert_eq!(set_page_filters_core(&fx.cx(), pages), vec![fx.ids[REPORT]], "an override that appeared changes its page");
    let o = fx.resolved(&own);
    assert!(o.pending && o.value.is_null(), "East's 4,000 shown under West: {o:?}");
    let s = fx.resolved(&sibling);
    assert_eq!((s.value.clone(), s.pending), (json!(4_000.0), false), "the sibling's filters did not move: {s:?}");

    // The same snapshot again changes nothing.
    let pages = serde_json::from_value(fx.snapshot(&["East"], &[(&own.object, Some(&["West"]))])["pages"].clone()).unwrap();
    assert!(set_page_filters_core(&fx.cx(), pages).is_empty(), "the same snapshot changes no page");

    // The pass fills the override's value.
    fx.send(json!({ "op": "refreshMeasures", "sheetIndex": REPORT })).await.unwrap();
    assert_eq!(fx.resolved(&own).value, json!(2_000.0));
    assert_eq!(fx.resolved(&sibling).value, json!(4_000.0));

    // The PAGE moves while the override holds: the sibling is pending, the
    // override's object is not.
    let pages = serde_json::from_value(fx.snapshot(&["North"], &[(&own.object, Some(&["West"]))])["pages"].clone()).unwrap();
    set_page_filters_core(&fx.cx(), pages);
    assert!(fx.resolved(&sibling).pending, "{:?}", fx.resolved(&sibling));
    assert_eq!(fx.resolved(&own).value, json!(2_000.0), "the override did not move");

    // The override goes away: the object is pending under the page's set...
    let pages = serde_json::from_value(fx.snapshot(&["North"], &[])["pages"].clone()).unwrap();
    assert_eq!(set_page_filters_core(&fx.cx(), pages), vec![fx.ids[REPORT]], "an override that went away changes its page");
    assert!(fx.resolved(&own).pending, "{:?}", fx.resolved(&own));
    // ...until the pass brings North's number for both.
    fx.send(json!({ "op": "refreshMeasures", "sheetIndex": REPORT })).await.unwrap();
    assert_eq!((fx.resolved(&own).value, fx.resolved(&sibling).value), (json!(4_000.0), json!(4_000.0)), "North");
}

/// One install keeps every signature CURRENT for some object on the page: a
/// pass for the page must not evict the overridden object's value (or the
/// page's) just because they read different sets.
#[tokio::test]
async fn one_pass_keeps_the_values_of_every_current_signature_on_the_page() {
    let fx = Fx::new().await;
    let (sibling, own) = fx.two_cards().await;
    fx.send(fx.snapshot(&["East"], &[(&own.object, Some(&["West"]))])).await.unwrap();
    fx.send(json!({ "op": "refreshMeasures", "sheetIndex": REPORT })).await.unwrap();
    fx.send(json!({ "op": "resolveAll" })).await.unwrap();
    assert_eq!((fx.resolved(&sibling).value, fx.resolved(&own).value), (json!(4_000.0), json!(2_000.0)));
    let runtime = fx.state.object_binding_runtime.lock().unwrap();
    let signatures: std::collections::HashSet<u64> = runtime.measure_cache.keys().map(|(_, _, _, s)| *s).collect();
    assert_eq!(signatures.len(), 2, "East (the page) and West (the override), nothing else: {signatures:?}");
}

/// `SetPageFilters` with overrides and tuples is still deliberately clean:
/// the mirror is a runtime copy (B3 precedent).
#[tokio::test]
async fn set_page_filters_with_overrides_and_tuples_never_dirties_the_document() {
    let fx = Fx::new().await;
    let (_sibling, own) = fx.two_cards().await;
    let depth = fx.state.undo_stack.lock().unwrap().undo_depth();
    // Set wrote the persisted store (dirty); a save clears it, so what
    // follows is measured from a clean document.
    crate::document_effect::mark_saved(&fx.file);
    assert!(!fx.file.is_dirty(), "precondition");
    fx.send(fx.snapshot(&["East"], &[(&own.object, None)])).await.unwrap();
    fx.send(json!({ "op": "setPageFilters", "pages": [{
        "sheetId": fx.ids[REPORT].to_string(), "connectionId": fx.conn.to_string(), "filters": [],
        "tupleFilters": [{ "fields": ["Sales.region", "Sales.year"], "tuples": [["East", "Y1"]] }], "objects": []
    }] }))
    .await
    .unwrap();
    assert!(!fx.file.is_dirty(), "the page-filter mirror is transient");
    assert_eq!(fx.state.undo_stack.lock().unwrap().undo_depth(), depth, "and never enters undo");
}

/// A snapshot naming a sheet id this workbook does not have is inert: no page
/// is evaluated under it, and it is not an error.
#[tokio::test]
async fn a_snapshot_for_an_unknown_sheet_id_reaches_no_binding() {
    let fx = Fx::new().await;
    let card = fx.card(REPORT, fx.conn);
    binding_of(fx.send(set_goal(&card, "=[Revenue]")).await.unwrap());
    let key = BindingKey { object: card.clone(), path: "/spec/markOptions/goal".to_string() };
    let stranger = identity::SheetId::from_bytes(new_id());
    fx.send(json!({ "op": "setPageFilters", "pages": [{
        "sheetId": stranger.to_string(), "connectionId": fx.conn.to_string(),
        "filters": [{ "field": "Sales.region", "includedItems": ["East"], "filterLevel": 1 }]
    }] }))
    .await
    .unwrap();
    assert_eq!(fx.resolved(&key).value, json!(10_000.0), "Report's Card is not filtered by another sheet's filters");
    assert!(
        fx.state.object_binding_runtime.lock().unwrap().warned_unknown_sheets.contains(&stranger),
        "the stranger is said in the log once"
    );
}
