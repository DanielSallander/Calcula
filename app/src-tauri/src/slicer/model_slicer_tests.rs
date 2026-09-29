//! FILENAME: app/src-tauri/src/slicer/model_slicer_tests.rs
//! PURPOSE: MODEL slicers (a slicer bound straight to a Calcula model
//!          connection) and the server-side filter path they need.
//! CONTEXT: The owner inserted a slicer on a canvas holding a model and no
//!          pivot and got "No Tables or PivotTables found" -- the BiConnection
//!          slicer was half built: `get_slicer_items` returned Err for it,
//!          `create_slicer` validated nothing, nothing re-bound it by a stable
//!          id, and the frontend "ensure a BI field" recipe that filtering
//!          depends on existed in three drifted, LOSSY copies. Owner decisions
//!          2026-09-27: a model slicer filters every pivot of its model on its
//!          own sheet (page rule, incl. pivots added later); deleting ANY
//!          slicer removes its filter, one Ctrl+Z restores both.
//!
//! Every engine-backed test runs the REAL commands' cores over an in-memory
//! model (no database): `Sales(region, year, amount)`, `Revenue = SUM(amount)`.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use arrow::array::{Float64Array, StringArray};
use arrow::datatypes::{DataType as ArrowType, Field, Schema};
use arrow::record_batch::RecordBatch;
use bi_engine::{
    sum_measure, Column, DataModel, DataType, Engine, InMemoryConnector, QueryRequest, SourceBinding,
    StorageMode, Table,
};
use identity::EntityId;
use tokio::sync::Mutex as TokioMutex;

use crate::bi::types::{BiState, Connection, ConnectionId, ConnectionType};
use crate::document_effect::test_seed_effect;
use crate::persistence::{FileState, UserFilesState};
use crate::pivot::commands::{
    apply_pivot_filter_core, bi_request_from_definition, clear_pivot_filter_core, page_model_slicers,
    slicer_fields_from_definition, update_bi_pivot_fields_core, PivotCmdCtx,
};
use crate::pivot::types::{
    ApplyPivotFilterRequest, BiFieldRef, BiPivotMetadata, BiValueFieldRef, ClearPivotFilterRequest,
    PivotFilters, PivotManualFilter, PivotState, UpdateBiPivotFieldsRequest,
};
use crate::slicer::commands::{
    create_slicer_core, delete_slicer_core, get_slicer_items_core, model_slicer_cross_filters,
    toggled_selection, update_slicer_core, update_slicer_selection_core, RibbonCrossCandidate,
};
use crate::slicer::types::*;
use crate::AppState;

fn new_id() -> EntityId {
    EntityId::from_bytes(identity::generate_uuid_v7())
}

// ============================================================================
// FIXTURES
// ============================================================================

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
            Arc::new(Float64Array::from(vec![10.0, 20.0, 30.0, 40.0])),
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
                    Column::new("year", DataType::String),
                    Column::new("amount", DataType::Float64),
                ],
            )
            .unwrap()
            .with_storage_mode(StorageMode::InMemory),
        )
        .add_measure(sum_measure("Revenue", "Sales", "amount"))
        .build()
        .unwrap()
}

fn bare_connection(id: ConnectionId, engine: Option<Arc<TokioMutex<Engine>>>, package_ds: Option<&str>) -> Connection {
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
        engine,
        model_key: None,
        connector_index: None,
        bindings: vec![],
        last_refreshed: None,
        created_at: String::new(),
        is_connected: true,
        active_queries: HashMap::new(),
        package_data_source_id: package_ds.map(|s| s.to_string()),
        active_role: None,
        base_model: None,
        calculated_measures: vec![],
    }
}

/// A workbook with a loaded, cache-warm model connection.
struct Fx {
    state: AppState,
    file: FileState,
    files: UserFilesState,
    slicer: SlicerState,
    pivots: PivotState,
    pane: crate::pane_control::PaneControlState,
    filters: crate::ribbon_filter::RibbonFilterState,
    timelines: crate::timeline_slicer::TimelineSlicerState,
    bi: BiState,
    conn: ConnectionId,
}

impl Fx {
    /// Sheet 0 is the workbook's worksheet; `canvases` canvases follow it.
    async fn new(canvases: usize) -> Fx {
        Fx::with_model(canvases, sales_model(), vec![("Sales", "sales", sales_batch())], &[("Sales", "region")]).await
    }

    /// A workbook over any in-memory model: `tables` binds each model table to
    /// a source table holding `batch`; every `warm` (table, column) is queried
    /// once so every table is cache-warm (there is no database to connect to).
    async fn with_model(
        canvases: usize,
        model: DataModel,
        tables: Vec<(&str, &str, RecordBatch)>,
        warm: &[(&str, &str)],
    ) -> Fx {
        let mut engine = Engine::new(model);
        let mut connector = InMemoryConnector::new();
        for (_, source, batch) in &tables {
            connector = connector.with_table("public", *source, batch.clone());
        }
        let idx = engine.add_in_memory_source(connector);
        for (table, source, _) in &tables {
            engine.bind_table(*table, idx, SourceBinding::new("public", *source));
        }
        // Warm the in-memory cache so the cache-warm check skips the DB
        // auto-connect (there is no database here).
        for (table, column) in warm {
            let _ = engine
                .query_auto_refresh(QueryRequest {
                    measures: vec!["Revenue".into()],
                    group_by: vec![bi_engine::ColumnRef::new(*table, *column)],
                    ..Default::default()
                })
                .await;
        }
        let conn = new_id();
        let mut connection = bare_connection(conn, Some(Arc::new(TokioMutex::new(engine))), None);
        connection.connector_index = Some(idx);
        let bi = BiState::new();
        bi.connections.lock().unwrap().insert(conn, connection);

        let fx = Fx {
            state: crate::create_app_state(),
            file: FileState::default(),
            files: UserFilesState::default(),
            slicer: SlicerState::new(),
            pivots: PivotState::new(),
            pane: crate::pane_control::PaneControlState::new(),
            filters: crate::ribbon_filter::RibbonFilterState::new(),
            timelines: crate::timeline_slicer::TimelineSlicerState::new(),
            bi,
            conn,
        };
        for _ in 0..canvases {
            crate::sheets::add_sheet_inner(&fx.state, &fx.file, None, ::persistence::SheetKind::new_canvas())
                .expect("add a canvas");
        }
        fx
    }

    fn ctx(&self) -> PivotCmdCtx<'_> {
        PivotCmdCtx {
            state: &self.state,
            file_state: &self.file,
            pivot_state: &self.pivots,
            pane_control_state: &self.pane,
            ribbon_filter_state: &self.filters,
            user_files_state: &self.files,
            bi_state: &self.bi,
            slicer_state: &self.slicer,
            record_undo: true,
        }
    }

    async fn meta(&self) -> BiPivotMetadata {
        let engine_arc = self.bi.connections.lock().unwrap()[&self.conn].engine.clone().unwrap();
        let engine = engine_arc.lock().await;
        let (model_tables, measures, hierarchies, calculation_groups, perspectives, cultures) =
            crate::pivot::commands::extract_bi_model_metadata(&engine);
        BiPivotMetadata {
            connection_id: self.conn,
            data_source_id: Some(self.conn.to_string()),
            model_tables,
            measures,
            hierarchies,
            calculation_groups,
            data_as_of: None,
            last_query: None,
            lookup_columns: HashSet::new(),
            drill_through: None,
            perspectives,
            selected_perspective: None,
            cultures,
        }
    }

    /// An EMPTY BI pivot, as `create_pivot_from_bi_model` leaves one. A canvas
    /// destination gets a frame and the next free canvas block.
    async fn add_bi_pivot(&self, sheet: usize) -> EntityId {
        let id = new_id();
        let sheet_name = self.state.sheet_names.read().unwrap()[sheet].clone();
        let is_canvas = crate::sheets::is_canvas_sheet(&self.state.sheet_kinds.read().unwrap(), sheet);
        let mut def = pivot_engine::PivotDefinition::new(id, (0, 0), (0, 0));
        def.destination_sheet = Some(sheet_name);
        def.name = Some(format!("Pivot{}", id));
        if is_canvas {
            def.canvas_frame =
                Some(pivot_engine::CanvasFrame { x: 40.0, y: 60.0, width: 320.0, height: 200.0, frozen_headers: false });
            def.destination = crate::pivot::operations::allocate_canvas_pivot_anchor(&self.state, sheet).unwrap();
        } else {
            // Side by side, far apart, so two worksheet pivots never overlap.
            let n = self.pivots.pivot_tables.read().unwrap().len() as u32;
            def.destination = (0, n * 20);
        }
        let meta = self.meta().await;
        let seed = test_seed_effect();
        self.pivots.pivot_tables.write(&seed).unwrap().insert(id, (def, pivot_engine::PivotCache::new(id, 0)));
        self.pivots.bi_metadata.write(&seed).unwrap().insert(id, meta);
        id
    }

    /// Place fields through the REAL update command (no slicer fields sent,
    /// exactly like the field list).
    async fn lay_out(&self, pivot: EntityId, rows: &[&str], columns: &[&str]) {
        let field = |c: &&str| BiFieldRef { table: "Sales".into(), column: c.to_string(), is_lookup: false, hidden_items: None };
        let request = UpdateBiPivotFieldsRequest {
            pivot_id: pivot,
            row_fields: rows.iter().map(field).collect(),
            column_fields: columns.iter().map(field).collect(),
            value_fields: vec![BiValueFieldRef { measure_name: "Revenue".into(), custom_name: None }],
            filter_fields: vec![],
            slicer_fields: None,
            row_hierarchies: vec![],
            column_hierarchies: vec![],
            layout: None,
            lookup_columns: vec![],
            calculated_fields: None,
            value_column_order: None,
            force_requery: false,
        };
        update_bi_pivot_fields_core(&self.ctx(), request).await.expect("lay the pivot out");
    }

    fn model_slicer(&self, sheet: usize, field: &str, selected: Option<Vec<&str>>) -> EntityId {
        let slicer = create_slicer_core(
            &self.state,
            &self.file,
            &self.slicer,
            &self.bi,
            model_params(self.conn, sheet, field),
        )
        .expect("create a model slicer");
        if let Some(sel) = selected {
            update_slicer_selection_core(
                &self.state,
                &self.file,
                &self.slicer,
                slicer.id,
                Some(sel.iter().map(|s| s.to_string()).collect()),
                "Slicer filter change",
            )
            .unwrap();
        }
        slicer.id
    }

    async fn click(&self, pivot: EntityId, key: &str, selected: &[&str]) {
        apply_pivot_filter_core(&self.ctx(), apply(pivot, key, selected)).await.expect("apply the filter");
    }

    fn definition(&self, pivot: EntityId) -> pivot_engine::PivotDefinition {
        self.pivots.pivot_tables.read().unwrap()[&pivot].0.clone()
    }

    fn cache_names(&self, pivot: EntityId) -> Vec<String> {
        let tables = self.pivots.pivot_tables.read().unwrap();
        let cache = &tables[&pivot].1;
        (0..cache.fields.len()).filter_map(|i| cache.field_name(i)).collect()
    }

    /// What the pivot hides on model column `column`, wherever it lives
    /// (a zone field or a slicer filter).
    fn hidden_on(&self, pivot: EntityId, column: &str) -> Option<Vec<String>> {
        let tables = self.pivots.pivot_tables.read().unwrap();
        let (def, cache) = &tables[&pivot];
        let key = format!("Sales.{column}");
        for f in def.row_fields.iter().chain(def.column_fields.iter()) {
            if f.name == key {
                return Some(sorted(f.hidden_items.clone()));
            }
        }
        for f in &def.filter_fields {
            if f.field.name == key {
                return Some(sorted(f.field.hidden_items.clone()));
            }
        }
        for sf in &def.slicer_filters {
            let name = cache.field_name(sf.source_index).unwrap_or_default();
            if name == column || name == key {
                return Some(sorted(sf.hidden_items.clone()));
            }
        }
        None
    }

    fn undo_depth(&self) -> usize {
        self.state.undo_stack.lock().unwrap().undo_depth()
    }

    fn undo_once(&self) {
        let transaction = self.state.undo_stack.lock().unwrap().pop_undo().expect("a step to undo");
        crate::undo_commands::apply_changes(
            &self.state, &self.file, &self.files, &self.pivots, &self.slicer, &self.filters, &self.pane,
            &self.timelines, transaction, true,
        );
    }
}

fn sorted(mut v: Vec<String>) -> Vec<String> {
    v.sort();
    v
}

fn strings(v: &[&str]) -> Vec<String> {
    v.iter().map(|s| s.to_string()).collect()
}

fn model_params(conn: ConnectionId, sheet: usize, field: &str) -> CreateSlicerParams {
    serde_json::from_value(serde_json::json!({
        "name": field,
        "sheetIndex": sheet,
        "x": 10.0, "y": 10.0,
        "sourceType": "biConnection",
        "cacheSourceId": conn.to_string(),
        "fieldName": field,
        "connectedSources": [{ "sourceType": "biConnection", "sourceId": conn.to_string() }]
    }))
    .expect("model slicer params")
}

fn apply(pivot: EntityId, key: &str, selected: &[&str]) -> ApplyPivotFilterRequest {
    ApplyPivotFilterRequest {
        pivot_id: pivot,
        field_index: None,
        bi_field_key: Some(key.to_string()),
        filters: PivotFilters {
            manual_filter: Some(PivotManualFilter { selected_items: strings(selected) }),
            ..Default::default()
        },
        filter_level: 1,
        slicer_id: None,
        reconcile: false,
    }
}

// ============================================================================
// CREATE (tests 1-2)
// ============================================================================

/// Test 1. A model slicer on a connection that does not exist is refused
/// BEFORE anything is written: no slicer, a clean document, no undo step.
#[test]
fn a_model_slicer_on_an_unknown_connection_is_refused_and_leaves_the_document_clean() {
    let state = crate::create_app_state();
    let file = FileState::default();
    let slicers = SlicerState::new();
    let bi = BiState::new();
    let depth = state.undo_stack.lock().unwrap().undo_depth();

    let err = create_slicer_core(&state, &file, &slicers, &bi, model_params(new_id(), 0, "Sales.region"))
        .expect_err("a slicer on a connection that does not exist must be refused");
    assert!(err.contains("not found"), "got: {err}");
    assert!(slicers.slicers.read().unwrap().is_empty(), "a refused create still inserted a slicer");
    assert!(!file.is_dirty(), "a refused create dirtied the document");
    assert_eq!(state.undo_stack.lock().unwrap().undo_depth(), depth, "a refused create pushed an undo step");
}

/// Test 2. A package connection's stable data-source id is stamped on the
/// slicer (package connections mint a fresh uuid on every pull), and the
/// Report Connections are the page, whatever the caller sent.
#[test]
fn a_model_slicer_on_a_package_connection_stamps_its_data_source_id() {
    let state = crate::create_app_state();
    let file = FileState::default();
    let slicers = SlicerState::new();
    let bi = BiState::new();
    let conn = new_id();
    bi.connections.lock().unwrap().insert(conn, bare_connection(conn, None, Some("ds-1")));

    let mut params = model_params(conn, 0, "Sales.region");
    params.connected_sources = vec![SlicerConnection { source_type: SlicerSourceType::Pivot, source_id: new_id() }];
    let slicer = create_slicer_core(&state, &file, &slicers, &bi, params).expect("create");
    assert_eq!(slicer.data_source_id.as_deref(), Some("ds-1"));
    assert_eq!(slicer.connected_sources.len(), 1);
    assert_eq!(slicer.connected_sources[0].source_type, SlicerSourceType::BiConnection);
    assert_eq!(slicer.connected_sources[0].source_id, conn);

    // A LOCAL connection's id is already stable: nothing to stamp.
    let local = new_id();
    bi.connections.lock().unwrap().insert(local, bare_connection(local, None, None));
    let slicer = create_slicer_core(&state, &file, &slicers, &bi, model_params(local, 0, "Sales.region")).unwrap();
    assert_eq!(slicer.data_source_id, None);
}

/// A model slicer's reach is its page: editing its Report Connections is
/// refused before anything is written.
#[test]
fn a_model_slicers_report_connections_cannot_be_edited() {
    let state = crate::create_app_state();
    let file = FileState::default();
    let slicers = SlicerState::new();
    let bi = BiState::new();
    let conn = new_id();
    bi.connections.lock().unwrap().insert(conn, bare_connection(conn, None, None));
    let slicer = create_slicer_core(&state, &file, &slicers, &bi, model_params(conn, 0, "Sales.region")).unwrap();
    let file = FileState::default();

    let params: UpdateSlicerParams = serde_json::from_value(serde_json::json!({
        "connectedSources": [{ "sourceType": "pivot", "sourceId": new_id().to_string() }]
    }))
    .unwrap();
    let err = update_slicer_core(&state, &file, &slicers, slicer.id, params).expect_err("refused");
    assert!(err.contains("report connections"), "got: {err}");
    assert!(!file.is_dirty(), "a refused update dirtied the document");
    assert_eq!(slicers.slicers.read().unwrap()[&slicer.id].connected_sources[0].source_id, conn);

    // Re-sending the canonical list (what a generic properties save does) is fine.
    let params: UpdateSlicerParams = serde_json::from_value(serde_json::json!({
        "name": "Region",
        "connectedSources": [{ "sourceType": "biConnection", "sourceId": conn.to_string() }]
    }))
    .unwrap();
    update_slicer_core(&state, &file, &slicers, slicer.id, params).expect("canonical list accepted");
}

// ============================================================================
// SELECTION UNDO (CHANGE UNDO)
// ============================================================================

/// A slicer click is the selection plus the applies, wrapped by the frontend
/// in ONE transaction: the selection recorder must JOIN it. The plain
/// begin/commit it used to record closed the outer transaction early.
#[test]
fn a_selection_change_joins_an_open_transaction() {
    let state = crate::create_app_state();
    let file = FileState::default();
    let slicers = SlicerState::new();
    let bi = BiState::new();
    let conn = new_id();
    bi.connections.lock().unwrap().insert(conn, bare_connection(conn, None, None));
    let slicer = create_slicer_core(&state, &file, &slicers, &bi, model_params(conn, 0, "Sales.region")).unwrap();

    let depth = state.undo_stack.lock().unwrap().undo_depth();
    state.undo_stack.lock().unwrap().begin_transaction("Slicer click");
    update_slicer_selection_core(&state, &file, &slicers, slicer.id, Some(strings(&["East"])), "Slicer filter change")
        .unwrap();
    assert!(
        state.undo_stack.lock().unwrap().has_open_transaction(),
        "the selection change committed the click's transaction early"
    );
    crate::slicer::commands::update_slicer_selection_core(&state, &file, &slicers, slicer.id, None, "Clear slicer filter")
        .unwrap();
    assert!(state.undo_stack.lock().unwrap().has_open_transaction(), "the clear committed it early");
    state.undo_stack.lock().unwrap().commit_transaction();
    assert_eq!(state.undo_stack.lock().unwrap().undo_depth(), depth + 1, "the click is ONE step");

    // A no-op (the selection is already that) records nothing and stays clean.
    let file = FileState::default();
    let depth = state.undo_stack.lock().unwrap().undo_depth();
    update_slicer_selection_core(&state, &file, &slicers, slicer.id, None, "Slicer filter change").unwrap();
    assert_eq!(state.undo_stack.lock().unwrap().undo_depth(), depth);
    assert!(!file.is_dirty());

    // Refusal-first: an unknown slicer leaves the document clean.
    let err = update_slicer_selection_core(&state, &file, &slicers, new_id(), None, "x").expect_err("unknown");
    assert!(err.contains("not found"));
    assert!(!file.is_dirty(), "a refused selection change dirtied the document");
}

/// `set_slicer_item_selected`'s decision, now shared by every source type:
/// unchecking one item while ALL are selected keeps the others. The old
/// model-slicer branch worked on the current list only, so this produced an
/// empty selection -- i.e. did nothing.
#[test]
fn unchecking_one_item_while_all_are_selected_keeps_the_others() {
    let all = strings(&["East", "North", "West"]);
    assert_eq!(toggled_selection(&all, None, "North", false), Some(strings(&["East", "West"])));
    assert_eq!(
        toggled_selection(&all, Some(&strings(&["East", "West"])), "North", true),
        None,
        "re-checking the last item clears the filter"
    );
    assert_eq!(toggled_selection(&all, Some(&strings(&["East"])), "West", true), Some(strings(&["East", "West"])));
}

// ============================================================================
// CROSS FILTERS (test 4)
// ============================================================================

fn slicer_on(sheet: usize, conn: EntityId, field: &str, selected: Option<&[&str]>) -> Slicer {
    let mut s: Slicer = serde_json::from_value(serde_json::json!({
        "id": new_id().to_string(),
        "name": field,
        "sheetIndex": sheet,
        "x": 0.0, "y": 0.0, "width": 180.0, "height": 240.0,
        "sourceType": "biConnection",
        "cacheSourceId": conn.to_string(),
        "fieldName": field,
        "selectedItems": null,
        "showHeader": true,
        "columns": 1,
        "stylePreset": "SlicerStyleLight1",
        "connectedSources": [{ "sourceType": "biConnection", "sourceId": conn.to_string() }]
    }))
    .unwrap();
    s.selected_items = selected.map(strings);
    s
}

fn ribbon(conn: EntityId, field: &str, mode: crate::ribbon_filter::ConnectionMode) -> RibbonCrossCandidate {
    RibbonCrossCandidate {
        field_name: field.to_string(),
        selection: strings(&["Y1"]),
        explicit: false,
        connection_id: conn,
        mode,
        sheets: vec![],
        targets: HashSet::new(),
    }
}

/// Test 4. A model slicer's has-data shading honours only what reaches its
/// PAGE. The generic sibling path would have made every model slicer of the
/// connection on ANY sheet a sibling, because they all carry the same
/// `[{biConnection, C}]` connection.
#[test]
fn model_slicer_cross_filters_are_page_scoped() {
    use crate::ribbon_filter::ConnectionMode;
    let conn = new_id();
    let other_conn = new_id();
    let me = slicer_on(2, conn, "Sales.region", None);
    let same_page = slicer_on(2, conn, "Sales.year", Some(&["Y1"]));
    let other_page = slicer_on(3, conn, "Sales.year", Some(&["Y2"]));
    let other_model = slicer_on(2, other_conn, "Sales.year", Some(&["Y2"]));
    let unselected = slicer_on(2, conn, "Sales.amount", None);
    let slicers = vec![me.clone(), same_page.clone(), other_page, other_model, unselected];

    let got = model_slicer_cross_filters(&me, slicers.iter(), &[], &HashSet::new());
    assert_eq!(got, vec![("Sales.year".to_string(), strings(&["Y1"]))], "only the same-page, same-model slicer");

    // Ribbon filters.
    let page_pivot = new_id();
    let pivots_on_page: HashSet<EntityId> = [page_pivot].into_iter().collect();
    let mut by_sheet = ribbon(conn, "Sales.year", ConnectionMode::BySheet);
    by_sheet.sheets = vec![2];
    let mut by_other_sheet = ribbon(conn, "Sales.year", ConnectionMode::BySheet);
    by_other_sheet.sheets = vec![3];
    let workbook = ribbon(conn, "Sales.year", ConnectionMode::Workbook);
    let manual_elsewhere = ribbon(conn, "Sales.year", ConnectionMode::Manual);
    let mut manual_here = ribbon(conn, "Sales.year", ConnectionMode::Manual);
    manual_here.targets = pivots_on_page.clone();
    let mut explicit = ribbon(conn, "Sales.year", ConnectionMode::Manual);
    explicit.explicit = true;
    let other_model_ribbon = ribbon(other_conn, "Sales.year", ConnectionMode::Workbook);

    let reach = |r: RibbonCrossCandidate| !model_slicer_cross_filters(&me, std::iter::empty(), &[r], &pivots_on_page).is_empty();
    assert!(reach(by_sheet), "a By-sheet filter on this sheet reaches the page");
    assert!(!reach(by_other_sheet), "a By-sheet filter on ANOTHER sheet does not");
    assert!(reach(workbook), "a Workbook filter reaches every page");
    assert!(!reach(manual_elsewhere), "a Manual filter with no pivot on this page does not");
    assert!(reach(manual_here), "a Manual filter targeting a pivot on this page does");
    assert!(reach(explicit), "a filter that names this slicer does");
    assert!(!reach(other_model_ribbon), "another model's filter does not");
}

// ============================================================================
// PURE RECONSTRUCTION (test 5 + the refresh losses)
// ============================================================================

fn pure_meta() -> BiPivotMetadata {
    let model_tables: Vec<crate::pivot::types::BiModelTableMeta> = serde_json::from_value(serde_json::json!([
        { "name": "Sales", "columns": [
            { "name": "region", "dataType": "string", "isNumeric": false },
            { "name": "year", "dataType": "string", "isNumeric": false },
            { "name": "city", "dataType": "string", "isNumeric": false }
        ]}
    ]))
    .unwrap();
    let hierarchies: Vec<crate::pivot::types::BiHierarchyMeta> = serde_json::from_value(serde_json::json!([
        { "name": "Geo", "table": "Sales", "levels": [ { "column": "region" }, { "column": "city" } ] }
    ]))
    .unwrap();
    BiPivotMetadata {
        connection_id: new_id(),
        data_source_id: None,
        model_tables,
        measures: vec![],
        hierarchies,
        calculation_groups: vec![],
        data_as_of: None,
        last_query: None,
        lookup_columns: HashSet::new(),
        drill_through: None,
        perspectives: vec![],
        selected_perspective: None,
        cultures: vec![],
    }
}

/// Test 5 (helper half). The KEEP arm of `slicer_fields: None` reads the
/// pivot's slicer filters back as refs WITH their hidden items.
#[test]
fn slicer_fields_from_definition_keeps_hidden_items() {
    let id = new_id();
    let meta = pure_meta();
    let mut cache = pivot_engine::PivotCache::new(id, 3);
    cache.set_field_name(0, "year".to_string());
    cache.set_field_name(1, "region".to_string());
    cache.set_field_name(2, "Revenue".to_string());
    let mut def = pivot_engine::PivotDefinition::new(id, (0, 0), (0, 0));
    def.row_fields.push(pivot_engine::PivotField::new(0, "Sales.year".to_string()));
    def.slicer_filters.push(pivot_engine::SlicerFilter { source_index: 1, hidden_items: strings(&["West"]), model_key: None });

    let got = slicer_fields_from_definition(&def, &cache, &meta);
    assert_eq!(got.len(), 1);
    assert_eq!((got[0].table.as_str(), got[0].column.as_str()), ("Sales", "region"));
    assert_eq!(got[0].hidden_items, Some(strings(&["West"])));
}

/// The refresh reconstruction used to rebuild rows and columns with NO hidden
/// items and NO hierarchies, so every refresh (and every frontend ensure built
/// the same way) dropped a row-field filter and flattened a hierarchy.
#[test]
fn the_refresh_reconstruction_keeps_dimension_hidden_items_and_hierarchies() {
    let id = new_id();
    let meta = pure_meta();
    let mut cache = pivot_engine::PivotCache::new(id, 4);
    for (i, n) in ["year", "region", "city", "Revenue"].iter().enumerate() {
        cache.set_field_name(i, n.to_string());
    }
    let mut def = pivot_engine::PivotDefinition::new(id, (0, 0), (0, 0));
    let mut year = pivot_engine::PivotField::new(0, "Sales.year".to_string());
    year.hidden_items = strings(&["Y2"]);
    def.row_fields.push(year);
    def.row_fields.push(pivot_engine::PivotField::new(1, "Sales.region".to_string()));
    def.row_fields.push(pivot_engine::PivotField::new(2, "Sales.city".to_string()));
    def.hierarchy_configs.push(pivot_engine::HierarchyConfig {
        name: "Geo".to_string(),
        field_start: 1,
        field_count: 2,
        is_row: true,
        ragged_behavior: pivot_engine::RaggedBehavior::ShowBlanks,
    });

    let request = bi_request_from_definition(id, &def, &cache, &meta);
    assert_eq!(request.row_fields.len(), 1, "the hierarchy levels fold back into their hierarchy");
    assert_eq!(request.row_fields[0].column, "year");
    assert_eq!(request.row_fields[0].hidden_items, Some(strings(&["Y2"])), "a row field's filter survived the rebuild");
    assert_eq!(request.row_hierarchies.len(), 1);
    assert_eq!(request.row_hierarchies[0].hierarchy, "Geo");
    assert_eq!(request.slicer_fields.as_ref().map(|v| v.len()), Some(0));
}

/// The page rule, pure: same connection, same sheet, a selection, a column of
/// the pivot's model.
#[test]
fn page_model_slicers_follow_the_page_rule() {
    let mut meta = pure_meta();
    let conn = meta.connection_id;
    meta.data_source_id = Some("ds-9".to_string());
    let here = slicer_on(1, conn, "Sales.region", Some(&["East"]));
    let there = slicer_on(2, conn, "Sales.region", Some(&["East"]));
    let idle = slicer_on(1, conn, "Sales.year", None);
    let not_a_column = slicer_on(1, conn, "Sales.nope", Some(&["x"]));
    let mut rebound_later = slicer_on(1, new_id(), "Sales.year", Some(&["Y1"]));
    rebound_later.data_source_id = Some("ds-9".to_string());
    let all = vec![here.clone(), there, idle, not_a_column, rebound_later.clone()];

    let got = page_model_slicers(all.iter(), &meta, 1);
    let ids: HashSet<EntityId> = got.iter().map(|p| p.slicer_id).collect();
    assert_eq!(ids, [here.id, rebound_later.id].into_iter().collect::<HashSet<_>>());
}

// ============================================================================
// ENGINE-BACKED: items (the owner's failure)
// ============================================================================

/// THE OWNER'S CASE, backend half: a model slicer lists every value of its
/// column from the model. Before, `get_slicer_items` returned Err for a
/// BiConnection source and the slicer came up empty.
#[tokio::test]
async fn a_model_slicer_lists_every_value_of_its_model_column() {
    let fx = Fx::new(1).await;
    let slicer = fx.model_slicer(1, "Sales.region", None);
    let items = get_slicer_items_core(&fx.state, &fx.pivots, &fx.slicer, &fx.filters, &fx.bi, slicer)
        .await
        .expect("a model slicer's items");
    let values: Vec<&str> = items.iter().map(|i| i.value.as_str()).collect();
    assert_eq!(values, vec!["East", "North", "West"]);
    assert!(items.iter().all(|i| i.selected && i.has_data));
}

/// Reviewer's test: a model slicer on ANOTHER sheet never shades this one.
#[tokio::test]
async fn a_model_slicer_on_another_sheet_is_excluded_from_has_data() {
    let fx = Fx::new(2).await;
    let region = fx.model_slicer(1, "Sales.region", None);
    // Another canvas: Y2 only (East + North). Must NOT grey West here.
    fx.model_slicer(2, "Sales.year", Some(vec!["Y2"]));
    let items = get_slicer_items_core(&fx.state, &fx.pivots, &fx.slicer, &fx.filters, &fx.bi, region).await.unwrap();
    assert!(items.iter().all(|i| i.has_data), "a slicer on another page cross-filtered this one: {items:?}");

    // The same slicer on THIS page does shade it (positive control).
    fx.model_slicer(1, "Sales.year", Some(vec!["Y2"]));
    let items = get_slicer_items_core(&fx.state, &fx.pivots, &fx.slicer, &fx.filters, &fx.bi, region).await.unwrap();
    let no_data: Vec<&str> = items.iter().filter(|i| !i.has_data).map(|i| i.value.as_str()).collect();
    assert_eq!(no_data, vec!["West"], "a same-page slicer must shade the values it leaves without rows");
}

// ============================================================================
// ENGINE-BACKED: the server-side ensure and the kept fields
// ============================================================================

/// Test 5 (command half) / P1. A field-list edit sends no slicer fields; the
/// slicer's filter must survive it. It used to be cleared.
#[tokio::test]
async fn a_field_list_edit_keeps_a_slicer_filter() {
    let fx = Fx::new(1).await;
    let pivot = fx.add_bi_pivot(1).await;
    fx.lay_out(pivot, &["year"], &[]).await;
    fx.click(pivot, "Sales.region", &["East"]).await;
    assert_eq!(fx.hidden_on(pivot, "region"), Some(strings(&["North", "West"])), "precondition: the ensure + filter");

    // The field list moves year to columns (no slicerFields sent).
    fx.lay_out(pivot, &[], &["year"]).await;
    assert_eq!(
        fx.hidden_on(pivot, "region"),
        Some(strings(&["North", "West"])),
        "a layout edit silently dropped the slicer's filter (P1)"
    );

    // Some([]) is the explicit clear.
    let def = fx.definition(pivot);
    assert!(!def.slicer_filters.is_empty());
    let meta = fx.meta().await;
    let cache = fx.pivots.pivot_tables.read().unwrap()[&pivot].1.clone();
    let mut request = bi_request_from_definition(pivot, &def, &cache, &meta);
    request.slicer_fields = Some(vec![]);
    update_bi_pivot_fields_core(&fx.ctx(), request).await.unwrap();
    assert_eq!(fx.hidden_on(pivot, "region"), None, "Some([]) must clear the slicer fields");
}

/// Reviewer's test: two model slicers, one column a ROW field. Click A (the
/// row field), then B (not in the pivot: an ensure). The ensure's rebuild
/// must keep A's hidden items on the row field.
#[tokio::test]
async fn the_second_slicers_ensure_keeps_the_first_slicers_row_field_filter() {
    let fx = Fx::new(1).await;
    let pivot = fx.add_bi_pivot(1).await;
    fx.lay_out(pivot, &["region"], &[]).await;
    fx.click(pivot, "Sales.region", &["East"]).await;
    assert_eq!(fx.hidden_on(pivot, "region"), Some(strings(&["North", "West"])));

    fx.click(pivot, "Sales.year", &["Y1"]).await;
    assert!(fx.cache_names(pivot).iter().any(|n| n == "year"), "the ensure added the year column");
    assert_eq!(fx.hidden_on(pivot, "year"), Some(strings(&["Y2"])));
    assert_eq!(
        fx.hidden_on(pivot, "region"),
        Some(strings(&["North", "West"])),
        "the ensure for Year wiped Region's filter on the row field"
    );
}

/// Reviewer's test: dragging the slicer's own column onto Rows keeps the
/// filter -- the slicer field merges into the row field with its hidden items.
#[tokio::test]
async fn dragging_the_slicer_column_onto_rows_keeps_the_filter() {
    let fx = Fx::new(1).await;
    let pivot = fx.add_bi_pivot(1).await;
    fx.lay_out(pivot, &["year"], &[]).await;
    fx.click(pivot, "Sales.region", &["East"]).await;

    fx.lay_out(pivot, &["year", "region"], &[]).await;
    let def = fx.definition(pivot);
    let row = def.row_fields.iter().find(|f| f.name == "Sales.region").expect("region is a row field");
    assert_eq!(sorted(row.hidden_items.clone()), strings(&["North", "West"]), "the filter disappeared on the drag");
    assert!(
        def.slicer_filters.iter().all(|sf| sf.source_index != row.source_index),
        "the column is carried once, by the row field"
    );
}

/// An ensure on a pivot with no fields leaves it untouched (and clean);
/// a clear of a column the pivot lacks never ADDS it (P4); a key that is not
/// a column of the model is refused.
#[tokio::test]
async fn an_ensure_never_touches_an_empty_pivot_and_a_clear_never_adds_a_field() {
    let fx = Fx::new(1).await;
    let pivot = fx.add_bi_pivot(1).await;
    let file = FileState::default();
    let ctx = PivotCmdCtx { file_state: &file, ..fx.ctx() };
    apply_pivot_filter_core(&ctx, apply(pivot, "Sales.region", &["East"])).await.expect("a no-op, not an error");
    assert!(!file.is_dirty(), "an ensure on an empty pivot dirtied the document");
    assert!(fx.definition(pivot).slicer_filters.is_empty());

    fx.lay_out(pivot, &["year"], &[]).await;
    let file = FileState::default();
    let ctx = PivotCmdCtx { file_state: &file, ..fx.ctx() };
    let clear = ClearPivotFilterRequest {
        pivot_id: pivot,
        field_index: None,
        bi_field_key: Some("Sales.region".to_string()),
        filter_type: None,
        reconcile: false,
    };
    clear_pivot_filter_core(&ctx, clear).await.expect("a no-op");
    assert!(!file.is_dirty(), "clearing a column the pivot lacks dirtied the document");
    assert!(!fx.cache_names(pivot).iter().any(|n| n == "region"), "a clear ADDED the column (P4)");

    let err = apply_pivot_filter_core(&ctx, apply(pivot, "Sales.nope", &["x"])).await.expect_err("refused");
    assert!(err.contains("not a column"), "got: {err}");
    assert!(!file.is_dirty(), "a refused apply dirtied the document");
}

/// Reviewer's test (CHANGE UNDO): a click that needed an ensure -- selection
/// + apply inside one transaction -- is ONE step, and ONE Ctrl+Z restores both
/// the slicer and the pivot.
#[tokio::test]
async fn a_click_that_needed_an_ensure_is_one_undo_step() {
    let fx = Fx::new(1).await;
    let pivot = fx.add_bi_pivot(1).await;
    fx.lay_out(pivot, &["year"], &[]).await;
    let slicer = fx.model_slicer(1, "Sales.region", None);

    let depth = fx.undo_depth();
    fx.state.undo_stack.lock().unwrap().begin_transaction("Slicer filter change");
    update_slicer_selection_core(&fx.state, &fx.file, &fx.slicer, slicer, Some(strings(&["East"])), "Slicer filter change")
        .unwrap();
    fx.click(pivot, "Sales.region", &["East"]).await;
    fx.state.undo_stack.lock().unwrap().commit_transaction();
    assert_eq!(fx.undo_depth(), depth + 1, "the click must be ONE undo step");
    assert_eq!(fx.hidden_on(pivot, "region"), Some(strings(&["North", "West"])));

    fx.undo_once();
    assert_eq!(fx.slicer.slicers.read().unwrap()[&slicer].selected_items, None, "the slicer came back");
    assert_eq!(fx.hidden_on(pivot, "region"), None, "one Ctrl+Z left the pivot filtered");
    assert!(!fx.cache_names(pivot).iter().any(|n| n == "region"), "the ensure's column is gone again");
}

// ============================================================================
// ENGINE-BACKED: the page fold (owner decision 2)
// ============================================================================

/// A pivot BUILT on a filtered page comes out filtered in the same command;
/// a pivot of the same model on another sheet does not (negative control).
#[tokio::test]
async fn a_pivot_built_on_a_filtered_page_is_filtered_and_other_pages_are_not() {
    let fx = Fx::new(2).await;
    fx.model_slicer(1, "Sales.region", Some(vec!["East"]));

    let on_page = fx.add_bi_pivot(1).await;
    fx.lay_out(on_page, &["year"], &[]).await;
    assert_eq!(
        fx.hidden_on(on_page, "region"),
        Some(strings(&["North", "West"])),
        "a pivot added to the slicer's page was not filtered"
    );

    let elsewhere = fx.add_bi_pivot(2).await;
    fx.lay_out(elsewhere, &["year"], &[]).await;
    assert_eq!(fx.hidden_on(elsewhere, "region"), None, "a pivot on ANOTHER page was filtered");

    let on_worksheet = fx.add_bi_pivot(0).await;
    fx.lay_out(on_worksheet, &["year"], &[]).await;
    assert_eq!(fx.hidden_on(on_worksheet, "region"), None, "a worksheet pivot was filtered by a canvas slicer");
}

// ============================================================================
// ENGINE-BACKED: delete (owner decision 3)
// ============================================================================

/// Deleting a model slicer removes ITS page's filter and nothing else; ONE
/// Ctrl+Z brings back both the slicer and the filter. The neighbour page's
/// own slicer keeps its pivot filtered (the reviewer's shifted-index case,
/// server side: the page is resolved here, from the live slicer).
#[tokio::test]
async fn deleting_a_model_slicer_clears_only_its_page_and_one_undo_restores_both() {
    let fx = Fx::new(2).await;
    let p1 = fx.add_bi_pivot(1).await;
    fx.lay_out(p1, &["year"], &[]).await;
    let p2 = fx.add_bi_pivot(2).await;
    fx.lay_out(p2, &["year"], &[]).await;
    let s1 = fx.model_slicer(1, "Sales.region", Some(vec!["East"]));
    fx.model_slicer(2, "Sales.region", Some(vec!["West"]));
    fx.click(p1, "Sales.region", &["East"]).await;
    fx.click(p2, "Sales.region", &["West"]).await;

    let depth = fx.undo_depth();
    delete_slicer_core(&fx.ctx(), s1).await.expect("delete");
    assert_eq!(fx.undo_depth(), depth + 1, "the delete is ONE step");
    assert!(!fx.slicer.slicers.read().unwrap().contains_key(&s1));
    assert!(
        fx.hidden_on(p1, "region").map_or(true, |h| h.is_empty()),
        "the deleted slicer's filter stayed on its pivot"
    );
    assert_eq!(fx.hidden_on(p2, "region"), Some(strings(&["East", "North"])), "the NEIGHBOUR page lost its filter");

    fx.undo_once();
    assert!(fx.slicer.slicers.read().unwrap().contains_key(&s1), "the slicer came back");
    assert_eq!(fx.hidden_on(p1, "region"), Some(strings(&["North", "West"])), "one Ctrl+Z did not bring the filter back");
}

/// A PIVOT slicer too (owner decision 3 covers ANY slicer) -- and a slicer
/// with no selection filtered nothing, so its delete leaves a filter someone
/// else set on the same column alone.
#[tokio::test]
async fn deleting_a_pivot_slicer_clears_its_filter_but_an_idle_slicer_clears_nothing() {
    let fx = Fx::new(1).await;
    let pivot = fx.add_bi_pivot(1).await;
    fx.lay_out(pivot, &["region"], &[]).await;
    fx.click(pivot, "Sales.region", &["East"]).await;

    let pivot_slicer = |selected: Option<Vec<String>>| -> EntityId {
        let mut s = slicer_on(1, pivot, "Sales.region", None);
        s.source_type = SlicerSourceType::Pivot;
        s.connected_sources = vec![SlicerConnection { source_type: SlicerSourceType::Pivot, source_id: pivot }];
        s.selected_items = selected;
        let id = s.id;
        fx.slicer.slicers.write(&test_seed_effect()).unwrap().insert(id, s);
        id
    };

    let idle = pivot_slicer(None);
    delete_slicer_core(&fx.ctx(), idle).await.unwrap();
    assert_eq!(fx.hidden_on(pivot, "region"), Some(strings(&["North", "West"])), "an idle slicer's delete wiped a filter");

    let active = pivot_slicer(Some(strings(&["East"])));
    delete_slicer_core(&fx.ctx(), active).await.unwrap();
    assert!(
        fx.hidden_on(pivot, "region").map_or(true, |h| h.is_empty()),
        "a pivot slicer's delete left its filter on the pivot"
    );
}

// ============================================================================
// COLLABORATION RE-BIND (test 3)
// ============================================================================

/// Test 3. After a reload a package connection has a FRESH uuid; the slicer
/// re-binds by its stable data-source id -- cache source AND its
/// biConnection report connection.
#[test]
fn a_model_slicer_rebinds_by_data_source_id_after_a_fresh_uuid() {
    let slicers = SlicerState::new();
    let (u1, u2) = (new_id(), new_id());
    let mut s = slicer_on(0, u1, "Sales.region", None);
    s.data_source_id = Some("ds-1".to_string());
    let id = s.id;
    slicers.slicers.write(&test_seed_effect()).unwrap().insert(id, s);

    let ds: HashMap<String, EntityId> = [("ds-1".to_string(), u2)].into_iter().collect();
    crate::calp_commands::remap_slicer_bi_connections(&test_seed_effect(), &slicers, &ds);

    let got = slicers.slicers.read().unwrap()[&id].clone();
    assert_eq!(got.cache_source_id, u2, "the slicer still points at the dead uuid");
    assert_eq!(got.connected_sources[0].source_id, u2);
}

/// The working-copy case: the slicer's stamped id is the ORIGINAL package id,
/// but publish keyed the data source by the working copy's connection uuid.
/// The string fallback on `cache_source_id` still binds it (the ribbon filter's
/// skip would have dropped it), and the key that worked is remembered.
#[test]
fn a_working_copy_slicer_rebinds_by_its_connection_uuid_and_remembers_it() {
    let slicers = SlicerState::new();
    let (u2, u3) = (new_id(), new_id());
    let mut s = slicer_on(0, u2, "Sales.region", None);
    s.data_source_id = Some("original-ds".to_string());
    let id = s.id;
    slicers.slicers.write(&test_seed_effect()).unwrap().insert(id, s);

    let ds: HashMap<String, EntityId> = [(u2.to_string(), u3)].into_iter().collect();
    crate::calp_commands::remap_slicer_bi_connections(&test_seed_effect(), &slicers, &ds);

    let got = slicers.slicers.read().unwrap()[&id].clone();
    assert_eq!(got.cache_source_id, u3);
    assert_eq!(got.connected_sources[0].source_id, u3);
    assert_eq!(got.data_source_id.as_deref(), Some(u2.to_string().as_str()), "the working key is remembered");
}

/// A pulled model slicer is stamped with its effective data-source id when it
/// is materialized, so the next reload re-binds it.
#[test]
fn a_pulled_model_slicer_is_stamped_with_its_effective_data_source_id() {
    let state = crate::create_app_state();
    let slicers = SlicerState::new();
    let conn = new_id();
    let s = slicer_on(0, conn, "Sales.region", None);
    let sheet_id = state.sheet_ids.read().unwrap()[0];
    let saved = ::persistence::SavedSlicer {
        id: s.id,
        name: s.name.clone(),
        header_text: None,
        sheet_id,
        x: 0.0,
        y: 0.0,
        width: 180.0,
        height: 240.0,
        source_type: ::persistence::SavedSlicerSourceType::BiConnection,
        cache_source_id: conn,
        field_name: "Sales.region".to_string(),
        selected_items: None,
        show_header: true,
        columns: 1,
        style_preset: "SlicerStyleLight1".to_string(),
        selection_mode: ::persistence::SavedSlicerSelectionMode::Standard,
        hide_no_data: false,
        indicate_no_data: true,
        sort_no_data_last: true,
        force_selection: false,
        show_select_all: false,
        arrangement: ::persistence::SavedSlicerArrangement::Vertical,
        rows: 0,
        item_gap: 4.0,
        autogrid: true,
        item_padding: 0.0,
        button_radius: 2.0,
        computed_properties: vec![],
        connected_sources: vec![::persistence::SavedSlicerConnection {
            source_type: ::persistence::SavedSlicerSourceType::BiConnection,
            source_id: conn,
        }],
        filter_level: 1,
        data_source_id: None,
    };
    crate::calp_commands::materialize_pulled_slicers(&test_seed_effect(), &state, &slicers, &[saved], |_| Some(0))
        .unwrap();
    assert_eq!(slicers.slicers.read().unwrap()[&s.id].data_source_id.as_deref(), Some(conn.to_string().as_str()));
}

// ============================================================================
// SERDE (test 7)
// ============================================================================

/// Test 7. `dataSourceId` on the wire, omitted when None, and carried by the
/// persistence converters and the `.cala` `SlicerDef`.
#[test]
fn data_source_id_serializes_camel_case_and_round_trips() {
    let mut s = slicer_on(0, new_id(), "Sales.region", None);
    let json = serde_json::to_string(&s).unwrap();
    assert!(!json.contains("dataSourceId"), "None must be omitted: {json}");
    s.data_source_id = Some("ds-7".to_string());
    let json = serde_json::to_string(&s).unwrap();
    assert!(json.contains("\"dataSourceId\":\"ds-7\""), "{json}");
    let back: Slicer = serde_json::from_str(&json).unwrap();
    assert_eq!(back.data_source_id.as_deref(), Some("ds-7"));

    // Live -> saved -> .cala def -> saved -> live.
    let state = crate::create_app_state();
    let sheet_ids = state.sheet_ids.read().unwrap().clone();
    let saved = crate::persistence::slicer_to_saved(&s, &sheet_ids).expect("saved");
    assert_eq!(saved.data_source_id.as_deref(), Some("ds-7"));
    let def = calcula_format::features::slicers::SlicerDef::from(&saved);
    let def_json = serde_json::to_string(&def).unwrap();
    assert!(def_json.contains("\"dataSourceId\":\"ds-7\""), "{def_json}");
    let saved_back = ::persistence::SavedSlicer::from(&serde_json::from_str::<calcula_format::features::slicers::SlicerDef>(&def_json).unwrap());
    let live = crate::persistence::saved_slicer_to_slicer_at(&saved_back, 0);
    assert_eq!(live.data_source_id.as_deref(), Some("ds-7"));
}

// ============================================================================
// ENGINE-BACKED: a PINNED model slicer (level 2+)
// ============================================================================

/// A pinned model slicer's selection travels INSIDE the query (no host mask),
/// survives a field-list edit through the page fold, and its delete takes the
/// pin out and re-queries -- matched by its model column, so a pin whose
/// stored name is the bare cache column cannot outlive the slicer.
#[tokio::test]
async fn a_pinned_model_slicer_rides_the_query_survives_a_layout_edit_and_leaves_with_its_delete() {
    let fx = Fx::new(1).await;
    let pivot = fx.add_bi_pivot(1).await;
    fx.lay_out(pivot, &["year"], &[]).await;
    let slicer = fx.model_slicer(1, "Sales.region", Some(vec!["East"]));
    update_slicer_core(
        &fx.state,
        &fx.file,
        &fx.slicer,
        slicer,
        serde_json::from_value(serde_json::json!({ "filterLevel": 2 })).unwrap(),
    )
    .unwrap();

    let mut request = apply(pivot, "Sales.region", &["East"]);
    request.filter_level = 2;
    request.slicer_id = Some(slicer.to_string());
    apply_pivot_filter_core(&fx.ctx(), request).await.expect("a pinned apply");

    let region_values = |fx: &Fx| -> Vec<String> {
        let mut tables = fx.pivots.pivot_tables.write(&test_seed_effect()).unwrap();
        let cache = &mut tables.get_mut(&pivot).unwrap().1;
        let idx = (0..cache.fields.len()).find(|&i| cache.field_name(i).as_deref() == Some("region")).expect("region column");
        let field = cache.fields.get_mut(idx).unwrap();
        let ids = field.sorted_ids().to_vec();
        let mut out: Vec<String> = ids
            .iter()
            .filter_map(|&id| field.get_value(id).map(|v| format!("{v:?}")))
            .filter(|s| !s.contains("Empty"))
            .collect();
        out.sort();
        out
    };
    let pinned = |fx: &Fx| fx.definition(pivot).engine_filters.iter().any(|ef| ef.column == "region");
    assert!(pinned(&fx), "the pin was not routed into the definition's engine filters");
    assert_eq!(region_values(&fx).len(), 1, "the query was not filtered by the pin: {:?}", region_values(&fx));
    assert!(
        fx.hidden_on(pivot, "region").map_or(true, |h| h.is_empty()),
        "a pinned filter must not also mask host-side"
    );

    // A field-list edit (no slicer fields sent): the fold keeps the pin.
    fx.lay_out(pivot, &[], &["year"]).await;
    assert!(pinned(&fx), "a layout edit dropped the pinned model slicer's filter");
    assert_eq!(region_values(&fx).len(), 1);

    // Deleting the slicer removes the pin and re-queries: every region is back.
    delete_slicer_core(&fx.ctx(), slicer).await.unwrap();
    assert!(!pinned(&fx), "the pin outlived its slicer");
    assert!(
        !fx.cache_names(pivot).iter().any(|n| n == "region") || region_values(&fx).len() == 3,
        "the pivot still shows only the pinned region"
    );
}

// ============================================================================
// REVIEW 2 (slicer backend): the defects an adversarial review confirmed in
// the model-slicer work, each pinned by a test that fails without its fix.
// ============================================================================

impl Fx {
    /// Place fields by (table, column) through the REAL update command, with no
    /// slicer fields and no hidden items sent -- exactly what the field list
    /// sends for fields it did not edit.
    async fn lay_out_on(&self, pivot: EntityId, rows: &[(&str, &str)], columns: &[(&str, &str)]) {
        let field = |(t, c): &(&str, &str)| BiFieldRef {
            table: t.to_string(),
            column: c.to_string(),
            is_lookup: false,
            hidden_items: None,
        };
        let request = UpdateBiPivotFieldsRequest {
            pivot_id: pivot,
            row_fields: rows.iter().map(field).collect(),
            column_fields: columns.iter().map(field).collect(),
            value_fields: vec![BiValueFieldRef { measure_name: "Revenue".into(), custom_name: None }],
            filter_fields: vec![],
            slicer_fields: None,
            row_hierarchies: vec![],
            column_hierarchies: vec![],
            layout: None,
            lookup_columns: vec![],
            calculated_fields: None,
            value_column_order: None,
            force_requery: false,
        };
        update_bi_pivot_fields_core(&self.ctx(), request).await.expect("lay the pivot out");
    }

    /// What the pivot hides on model column `key` ("Table.Column"): a zone
    /// field of that name, or the slicer filter STAMPED with that key.
    fn hidden_on_key(&self, pivot: EntityId, key: &str) -> Option<Vec<String>> {
        let tables = self.pivots.pivot_tables.read().unwrap();
        let def = &tables[&pivot].0;
        for f in def.row_fields.iter().chain(def.column_fields.iter()) {
            if f.name == key {
                return Some(sorted(f.hidden_items.clone()));
            }
        }
        for f in &def.filter_fields {
            if f.field.name == key {
                return Some(sorted(f.field.hidden_items.clone()));
            }
        }
        def.slicer_filters
            .iter()
            .find(|sf| sf.model_key.as_deref() == Some(key))
            .map(|sf| sorted(sf.hidden_items.clone()))
    }

    fn clear_request(pivot: EntityId, key: &str) -> ClearPivotFilterRequest {
        ClearPivotFilterRequest {
            pivot_id: pivot,
            field_index: None,
            bi_field_key: Some(key.to_string()),
            filter_type: None,
            reconcile: false,
        }
    }
}

/// Customers(name) and Products(name, category) -- two tables sharing the
/// column name "name" -- with a Sales fact related to both.
fn star_model() -> DataModel {
    DataModel::builder()
        .add_table(
            Table::new("Customers", vec![Column::new("name", DataType::String)])
                .unwrap()
                .with_storage_mode(StorageMode::InMemory),
        )
        .add_table(
            Table::new(
                "Products",
                vec![Column::new("name", DataType::String), Column::new("category", DataType::String)],
            )
            .unwrap()
            .with_storage_mode(StorageMode::InMemory),
        )
        .add_table(
            Table::new(
                "Sales",
                vec![
                    Column::new("customer", DataType::String),
                    Column::new("product", DataType::String),
                    Column::new("amount", DataType::Float64),
                ],
            )
            .unwrap()
            .with_storage_mode(StorageMode::InMemory),
        )
        .add_relationship(bi_engine::Relationship::many_to_one(
            "Sales_Customers", "Sales", "customer", "Customers", "name",
        ))
        .add_relationship(bi_engine::Relationship::many_to_one(
            "Sales_Products", "Sales", "product", "Products", "name",
        ))
        .add_measure(sum_measure("Revenue", "Sales", "amount"))
        .build()
        .unwrap()
}

async fn star_fx() -> Fx {
    let customers = RecordBatch::try_new(
        Arc::new(Schema::new(vec![Field::new("name", ArrowType::Utf8, true)])),
        vec![Arc::new(StringArray::from(vec!["Acme", "Beta"]))],
    )
    .unwrap();
    let products = RecordBatch::try_new(
        Arc::new(Schema::new(vec![
            Field::new("name", ArrowType::Utf8, true),
            Field::new("category", ArrowType::Utf8, true),
        ])),
        vec![
            Arc::new(StringArray::from(vec!["Widget", "Gadget"])),
            Arc::new(StringArray::from(vec!["Tools", "Toys"])),
        ],
    )
    .unwrap();
    let sales = RecordBatch::try_new(
        Arc::new(Schema::new(vec![
            Field::new("customer", ArrowType::Utf8, true),
            Field::new("product", ArrowType::Utf8, true),
            Field::new("amount", ArrowType::Float64, true),
        ])),
        vec![
            Arc::new(StringArray::from(vec!["Acme", "Beta", "Acme", "Beta"])),
            Arc::new(StringArray::from(vec!["Widget", "Widget", "Gadget", "Gadget"])),
            Arc::new(Float64Array::from(vec![10.0, 20.0, 30.0, 40.0])),
        ],
    )
    .unwrap();
    Fx::with_model(
        1,
        star_model(),
        vec![("Customers", "customers", customers), ("Products", "products", products), ("Sales", "sales", sales)],
        &[("Customers", "name"), ("Products", "category"), ("Products", "name"), ("Sales", "customer")],
    )
    .await
}

/// FINDING 1. Two model tables share the column name "name"; the BI cache
/// names both columns "name". A filter on Customers.name must not be matched
/// to, cleared as, or re-attributed onto Products.name -- it used to resolve to
/// the Products column (the first bare-name match), hide every PRODUCT except
/// "Acme" (i.e. all of them) and empty the pivot.
#[tokio::test]
async fn two_tables_sharing_a_column_name_keep_their_own_filters() {
    let fx = star_fx().await;
    let pivot = fx.add_bi_pivot(1).await;
    fx.lay_out_on(pivot, &[("Products", "category")], &[]).await;

    fx.click(pivot, "Products.name", &["Widget"]).await;
    assert_eq!(fx.hidden_on_key(pivot, "Products.name"), Some(strings(&["Gadget"])), "precondition");

    fx.click(pivot, "Customers.name", &["Acme"]).await;
    assert_eq!(
        fx.hidden_on_key(pivot, "Customers.name"),
        Some(strings(&["Beta"])),
        "the Customers filter did not land on its own column"
    );
    assert_eq!(
        fx.hidden_on_key(pivot, "Products.name"),
        Some(strings(&["Gadget"])),
        "the Customers click overwrote the Products filter"
    );

    // A clear of one leaves the other intact.
    clear_pivot_filter_core(&fx.ctx(), Fx::clear_request(pivot, "Customers.name")).await.unwrap();
    assert!(
        fx.hidden_on_key(pivot, "Customers.name").map_or(true, |h| h.is_empty()),
        "the Customers filter survived its clear"
    );
    assert_eq!(fx.hidden_on_key(pivot, "Products.name"), Some(strings(&["Gadget"])), "clearing Customers cleared Products");

    // A KEEP field-list edit keeps both filters on their own tables.
    fx.click(pivot, "Customers.name", &["Acme"]).await;
    fx.lay_out_on(pivot, &[], &[("Products", "category")]).await;
    assert_eq!(fx.hidden_on_key(pivot, "Products.name"), Some(strings(&["Gadget"])), "a layout edit moved Products' filter");
    assert_eq!(fx.hidden_on_key(pivot, "Customers.name"), Some(strings(&["Beta"])), "a layout edit moved Customers' filter");
}

/// FINDING 1 (pure half). A bare cache name is attributed to a table only when
/// ONE table owns such a column; a stamped model key always wins.
#[test]
fn a_bare_cache_name_is_attributed_only_when_one_table_owns_it() {
    use crate::pivot::commands::{bi_cache_name_matches, resolve_bi_cache_name, slicer_filter_model_column};
    let mut meta = pure_meta();
    let extra: Vec<crate::pivot::types::BiModelTableMeta> = serde_json::from_value(serde_json::json!([
        { "name": "Stores", "columns": [ { "name": "region", "dataType": "string", "isNumeric": false } ] }
    ]))
    .unwrap();
    meta.model_tables.extend(extra);

    // "region": Sales AND Stores own it -> no attribution, no match.
    assert_eq!(resolve_bi_cache_name("region", &meta), None);
    assert!(!bi_cache_name_matches("region", "Sales", "region", &meta));
    assert!(!bi_cache_name_matches("region", "Stores", "region", &meta));
    // "year": only Sales.
    assert_eq!(resolve_bi_cache_name("year", &meta), Some(("Sales".to_string(), "year".to_string())));
    assert!(bi_cache_name_matches("year", "Sales", "year", &meta));

    let id = new_id();
    let mut cache = pivot_engine::PivotCache::new(id, 1);
    cache.set_field_name(0, "region".to_string());
    let keyed = pivot_engine::SlicerFilter {
        source_index: 0,
        hidden_items: vec![],
        model_key: Some("Stores.region".to_string()),
    };
    assert_eq!(
        slicer_filter_model_column(&keyed, &cache, &meta),
        Some(("Stores".to_string(), "region".to_string())),
        "the stamped key names the column"
    );
    let unkeyed = pivot_engine::SlicerFilter { source_index: 0, hidden_items: vec![], model_key: None };
    assert_eq!(slicer_filter_model_column(&unkeyed, &cache, &meta), None, "an ambiguous bare name was guessed");
}

/// FINDING 2. A column added to the LIVE model after the pivot was created
/// (the Model Editor's `set_model`) is filterable: the apply used to refuse it
/// ("not a column of this pivot's model") against the creation-time snapshot,
/// while the slicer and ribbon-filter dialogs listed it -- and the page fold
/// silently dropped it.
#[tokio::test]
async fn a_column_added_to_the_live_model_after_the_pivot_can_be_filtered() {
    // The SOURCE already has a `channel` column the first model does not list.
    let batch = RecordBatch::try_new(
        Arc::new(Schema::new(vec![
            Field::new("region", ArrowType::Utf8, true),
            Field::new("year", ArrowType::Utf8, true),
            Field::new("amount", ArrowType::Float64, true),
            Field::new("channel", ArrowType::Utf8, true),
        ])),
        vec![
            Arc::new(StringArray::from(vec!["East", "West", "East", "North"])),
            Arc::new(StringArray::from(vec!["Y1", "Y1", "Y2", "Y2"])),
            Arc::new(Float64Array::from(vec![10.0, 20.0, 30.0, 40.0])),
            Arc::new(StringArray::from(vec!["Web", "Shop", "Web", "Shop"])),
        ],
    )
    .unwrap();
    let fx = Fx::with_model(1, sales_model(), vec![("Sales", "sales", batch)], &[("Sales", "region")]).await;
    let pivot = fx.add_bi_pivot(1).await;
    fx.lay_out(pivot, &["year"], &[]).await;

    // The Model Editor adds Sales.channel to the live model.
    let with_channel = DataModel::builder()
        .add_table(
            Table::new(
                "Sales",
                vec![
                    Column::new("region", DataType::String),
                    Column::new("year", DataType::String),
                    Column::new("amount", DataType::Float64),
                    Column::new("channel", DataType::String),
                ],
            )
            .unwrap()
            .with_storage_mode(StorageMode::InMemory),
        )
        .add_measure(sum_measure("Revenue", "Sales", "amount"))
        .build()
        .unwrap();
    {
        let engine_arc = fx.bi.connections.lock().unwrap()[&fx.conn].engine.clone().unwrap();
        let mut engine = engine_arc.lock().await;
        engine.set_model(with_channel).expect("set the live model");
        let _ = engine
            .query_auto_refresh(QueryRequest {
                measures: vec!["Revenue".into()],
                group_by: vec![bi_engine::ColumnRef::new("Sales", "channel")],
                ..Default::default()
            })
            .await;
    }

    fx.click(pivot, "Sales.channel", &["Web"]).await;
    assert_eq!(fx.hidden_on(pivot, "channel"), Some(strings(&["Shop"])), "the new column was refused or not masked");

    // The page fold resolves it too (a model slicer on the new column).
    let meta = fx.pivots.bi_metadata.read().unwrap()[&pivot].clone();
    let slicer = slicer_on(1, fx.conn, "Sales.channel", Some(&["Web"]));
    let got = page_model_slicers([slicer].iter(), &meta, 1);
    assert_eq!(got.len(), 1, "the page fold dropped the model slicer on the new column");
}

/// FINDING 3. A level-1 selection spelled the MODEL's way (booleans "true",
/// decimals "12.50") masks the cache's spelling ("TRUE", 12.5): with the old
/// exact match, selecting "true" hid BOTH booleans and emptied the pivot, and
/// a selected 12.50 silently disappeared.
#[test]
fn a_model_spelled_selection_masks_boolean_and_decimal_cache_values() {
    use arrow::array::{BooleanArray, Decimal128Array};
    let batch = RecordBatch::try_new(
        Arc::new(Schema::new(vec![
            Field::new("active", ArrowType::Boolean, true),
            Field::new("price", ArrowType::Decimal128(10, 2), true),
        ])),
        vec![
            Arc::new(BooleanArray::from(vec![true, false])),
            Arc::new(Decimal128Array::from(vec![1250_i128, 1255]).with_precision_and_scale(10, 2).unwrap()),
        ],
    )
    .unwrap();
    // The selection exactly as a model slicer's items spell it.
    let bool_true = crate::bi::commands::arrow_value_to_string(batch.column(0).as_ref(), 0).unwrap();
    let price_1250 = crate::bi::commands::arrow_value_to_string(batch.column(1).as_ref(), 0).unwrap();
    assert_eq!((bool_true.as_str(), price_1250.as_str()), ("true", "12.50"), "fixture: the model's spelling");

    let mut cache = crate::pivot::operations::build_cache_from_arrow_batches(new_id(), &[batch]).unwrap();
    assert_eq!(
        crate::pivot::commands::hidden_for_selection(&mut cache, 0, &[bool_true], true),
        strings(&["FALSE"]),
        "selecting \"true\" must hide only FALSE"
    );
    assert_eq!(
        crate::pivot::commands::hidden_for_selection(&mut cache, 1, &[price_1250], true),
        strings(&["12.55"]),
        "selecting \"12.50\" must hide only 12.55"
    );
}

/// FINDING 3 (both sites). The apply and the page fold share the
/// spelling-tolerant rule: a boolean model column, selected as "true" the way
/// a model slicer spells it, hides only FALSE -- on a click AND when a pivot is
/// (re)built on a page that has such a slicer.
#[tokio::test]
async fn a_boolean_model_column_filters_by_the_models_spelling_on_apply_and_fold() {
    use arrow::array::BooleanArray;
    let model = DataModel::builder()
        .add_table(
            Table::new(
                "Sales",
                vec![
                    Column::new("region", DataType::String),
                    Column::new("active", DataType::Boolean),
                    Column::new("amount", DataType::Float64),
                ],
            )
            .unwrap()
            .with_storage_mode(StorageMode::InMemory),
        )
        .add_measure(sum_measure("Revenue", "Sales", "amount"))
        .build()
        .unwrap();
    let batch = RecordBatch::try_new(
        Arc::new(Schema::new(vec![
            Field::new("region", ArrowType::Utf8, true),
            Field::new("active", ArrowType::Boolean, true),
            Field::new("amount", ArrowType::Float64, true),
        ])),
        vec![
            Arc::new(StringArray::from(vec!["East", "West", "East", "North"])),
            Arc::new(BooleanArray::from(vec![true, false, true, false])),
            Arc::new(Float64Array::from(vec![10.0, 20.0, 30.0, 40.0])),
        ],
    )
    .unwrap();
    let fx = Fx::with_model(2, model, vec![("Sales", "sales", batch)], &[("Sales", "region"), ("Sales", "active")]).await;

    // The apply site.
    let clicked = fx.add_bi_pivot(1).await;
    fx.lay_out(clicked, &["region"], &[]).await;
    fx.click(clicked, "Sales.active", &["true"]).await;
    assert_eq!(fx.hidden_on(clicked, "active"), Some(strings(&["FALSE"])), "the apply hid the selected value too");

    // The page fold.
    fx.model_slicer(2, "Sales.active", Some(vec!["true"]));
    let folded = fx.add_bi_pivot(2).await;
    fx.lay_out(folded, &["region"], &[]).await;
    assert_eq!(fx.hidden_on(folded, "active"), Some(strings(&["FALSE"])), "the page fold hid the selected value too");
}

/// FINDINGS 4 + 10: the three states of a request's hidden items. ABSENT
/// carries what the column hides NOW (so a field list that did not edit a
/// field neither drops a slicer's mask nor resurrects a cleared one); `[]` is
/// an explicit clear -- the Pivot Layout DSL deleting its `NOT IN (...)` clause
/// -- which used to read as "keep" and brought the removed filter straight back.
#[tokio::test]
async fn an_explicit_empty_hidden_list_clears_a_row_filter_and_an_absent_one_keeps_the_current_state() {
    let fx = Fx::new(1).await;
    let pivot = fx.add_bi_pivot(1).await;
    fx.lay_out(pivot, &["region"], &[]).await;
    let region_index = |fx: &Fx| {
        fx.definition(pivot).row_fields.iter().find(|f| f.name == "Sales.region").unwrap().source_index
    };
    let header_filter = |idx: usize, selected: &[&str]| ApplyPivotFilterRequest {
        pivot_id: pivot,
        field_index: Some(idx),
        bi_field_key: None,
        filters: PivotFilters {
            manual_filter: Some(PivotManualFilter { selected_items: strings(selected) }),
            ..Default::default()
        },
        filter_level: 1,
        slicer_id: None,
        reconcile: false,
    };
    apply_pivot_filter_core(&fx.ctx(), header_filter(region_index(&fx), &["East", "North"])).await.unwrap();
    assert_eq!(fx.hidden_on(pivot, "region"), Some(strings(&["West"])), "precondition");

    // A layout edit that did not touch region (absent) keeps West hidden.
    fx.lay_out(pivot, &["region"], &["year"]).await;
    assert_eq!(fx.hidden_on(pivot, "region"), Some(strings(&["West"])), "an absent list dropped the filter");

    // The DSL removes the clause: `Some([])` is authoritative.
    let request = UpdateBiPivotFieldsRequest {
        pivot_id: pivot,
        row_fields: vec![BiFieldRef {
            table: "Sales".into(),
            column: "region".into(),
            is_lookup: false,
            hidden_items: Some(vec![]),
        }],
        column_fields: vec![BiFieldRef { table: "Sales".into(), column: "year".into(), is_lookup: false, hidden_items: None }],
        value_fields: vec![BiValueFieldRef { measure_name: "Revenue".into(), custom_name: None }],
        filter_fields: vec![],
        slicer_fields: None,
        row_hierarchies: vec![],
        column_hierarchies: vec![],
        layout: None,
        lookup_columns: vec![],
        calculated_fields: None,
        value_column_order: None,
        force_requery: false,
    };
    update_bi_pivot_fields_core(&fx.ctx(), request).await.unwrap();
    assert_eq!(fx.hidden_on(pivot, "region"), Some(vec![]), "an explicit [] did not clear the row filter");

    // Hide West again, clear it out of band (the header dropdown's Clear);
    // the field list's next edit sends nothing for region and must not bring
    // anything back.
    apply_pivot_filter_core(&fx.ctx(), header_filter(region_index(&fx), &["East", "North"])).await.unwrap();
    let clear = ClearPivotFilterRequest { pivot_id: pivot, field_index: Some(region_index(&fx)), bi_field_key: None, filter_type: None, reconcile: false };
    clear_pivot_filter_core(&fx.ctx(), clear).await.unwrap();
    fx.lay_out(pivot, &["region"], &[]).await;
    assert_eq!(fx.hidden_on(pivot, "region"), Some(vec![]), "a cleared filter came back on a layout edit");
}

/// FINDING 5. A pivot slicer's (or ribbon filter's) mask that lives on a ZONE
/// field survives that field LEAVING the layout -- Excel and Power BI keep a
/// slicer's filter when its field is taken off the pivot -- in ONE undo step.
/// A plain header-dropdown filter on such a field is dropped, as in Excel.
#[tokio::test]
async fn an_external_filter_survives_its_field_leaving_the_layout_but_a_header_filter_does_not() {
    let fx = Fx::new(1).await;

    // (a) a PIVOT slicer connected to the pivot.
    let with_slicer = fx.add_bi_pivot(1).await;
    fx.lay_out(with_slicer, &["year"], &[]).await;
    let mut s = slicer_on(1, with_slicer, "Sales.region", Some(&["East"]));
    s.source_type = SlicerSourceType::Pivot;
    s.connected_sources = vec![SlicerConnection { source_type: SlicerSourceType::Pivot, source_id: with_slicer }];
    fx.slicer.slicers.write(&test_seed_effect()).unwrap().insert(s.id, s);
    fx.click(with_slicer, "Sales.region", &["East"]).await;
    fx.lay_out(with_slicer, &["year", "region"], &[]).await; // the dedupe moves the mask onto the row field
    let depth = fx.undo_depth();
    fx.lay_out(with_slicer, &["year"], &[]).await;
    assert_eq!(
        fx.hidden_on(with_slicer, "region"),
        Some(strings(&["North", "West"])),
        "the slicer's filter was dropped when its field left the layout"
    );
    assert_eq!(fx.undo_depth(), depth + 1, "the layout edit is ONE undo step");

    // (b) an active ribbon filter, bySheet on the pivot's sheet (1), on the
    //     pivot's connection.
    let with_ribbon = fx.add_bi_pivot(1).await;
    fx.lay_out(with_ribbon, &["year", "region"], &[]).await;
    let ribbon_filter: crate::ribbon_filter::RibbonFilter = serde_json::from_value(serde_json::json!({
        "id": new_id().to_string(),
        "name": "Region",
        "connectionId": fx.conn.to_string(),
        "fieldName": "Sales.region",
        "connectionMode": "bySheet",
        "connectedSheets": [1],
        "selectedItems": ["East"]
    }))
    .expect("a ribbon filter");
    fx.filters.filters.write(&test_seed_effect()).unwrap().insert(ribbon_filter.id, ribbon_filter);
    fx.click(with_ribbon, "Sales.region", &["East"]).await;
    fx.lay_out(with_ribbon, &["year"], &[]).await;
    assert_eq!(
        fx.hidden_on(with_ribbon, "region"),
        Some(strings(&["North", "West"])),
        "the ribbon filter's mask was dropped when its field left the layout"
    );

    // (c) a header-dropdown filter only (sheet 0: no slicer or ribbon filter
    //     reaches it): dropped with its field, as in Excel.
    let plain = fx.add_bi_pivot(0).await;
    fx.lay_out(plain, &["year", "region"], &[]).await;
    let idx = fx.definition(plain).row_fields.iter().find(|f| f.name == "Sales.region").unwrap().source_index;
    let header = ApplyPivotFilterRequest {
        pivot_id: plain,
        field_index: Some(idx),
        bi_field_key: None,
        filters: PivotFilters {
            manual_filter: Some(PivotManualFilter { selected_items: strings(&["East"]) }),
            ..Default::default()
        },
        filter_level: 1,
        slicer_id: None,
        reconcile: false,
    };
    apply_pivot_filter_core(&fx.ctx(), header).await.unwrap();
    fx.lay_out(plain, &["year"], &[]).await;
    assert_eq!(fx.hidden_on(plain, "region"), None, "a header filter outlived its field");
}

/// FINDING 6. `bi_pivots_for_connection` must not hold the pivot locks while
/// it waits for `sheet_names`: `delete_sheet` holds `sheet_names` and then
/// takes `pivot_tables`, so resolving under the pivot locks was an ABBA hang,
/// reached on every model slicer's item fetch and every slicer delete.
#[test]
fn resolving_a_connections_pivots_never_holds_the_pivot_locks_while_it_waits_for_sheet_names() {
    let state = crate::create_app_state();
    let pivots = PivotState::new();
    let meta = pure_meta();
    let conn = meta.connection_id;
    let id = new_id();
    let mut def = pivot_engine::PivotDefinition::new(id, (0, 0), (0, 0));
    def.destination_sheet = Some(state.sheet_names.read().unwrap()[0].clone());
    pivots.pivot_tables.write(&test_seed_effect()).unwrap().insert(id, (def, pivot_engine::PivotCache::new(id, 0)));
    pivots.bi_metadata.write(&test_seed_effect()).unwrap().insert(id, meta);

    let reached_pivot_tables = std::thread::scope(|scope| {
        // `delete_sheet` step 1: it holds sheet_names...
        let names_guard = state.sheet_names.write(&test_seed_effect()).unwrap();
        let resolver = scope.spawn(|| crate::pivot::commands::bi_pivots_for_connection(&state, &pivots, conn));
        std::thread::sleep(std::time::Duration::from_millis(250)); // the resolver now waits on sheet_names
        // ...step 2: it takes pivot_tables. That must not wait on the resolver.
        let (tx, rx) = std::sync::mpsc::channel();
        let pivots_ref = &pivots;
        let taker = scope.spawn(move || {
            let _guard = pivots_ref.pivot_tables.write(&test_seed_effect()).unwrap();
            let _ = tx.send(());
        });
        let reached = rx.recv_timeout(std::time::Duration::from_secs(3)).is_ok();
        drop(names_guard); // let both finish, whatever happened
        let found = resolver.join().unwrap();
        taker.join().unwrap();
        assert_eq!(found.len(), 1, "fixture: the pivot is found");
        reached
    });
    assert!(
        reached_pivot_tables,
        "bi_pivots_for_connection held pivot_tables while waiting for sheet_names (ABBA against delete_sheet)"
    );
}

/// A worksheet table "Sales" at A1:A5 (header "Region", then East, West,
/// East, North) owning the sheet's AutoFilter, filtered to East -- what a
/// table slicer's click leaves behind -- and a table slicer on it.
fn seed_filtered_table(fx: &Fx, selected: Option<&[&str]>) -> (EntityId, EntityId) {
    let seed = test_seed_effect();
    {
        let mut grids = fx.state.grids.write(&seed).unwrap();
        let mut grid = fx.state.grid.write(&seed).unwrap();
        for (row, text) in ["Region", "East", "West", "East", "North"].iter().enumerate() {
            grids[0].set_cell(row as u32, 0, engine::Cell::new_text(text.to_string()));
            grid.set_cell(row as u32, 0, engine::Cell::new_text(text.to_string()));
        }
    }
    let mut af = crate::autofilter::AutoFilter::new(0, 0, 4, 0);
    af.column_filters.insert(
        0,
        crate::autofilter::ColumnFilter {
            column_index: 0,
            criteria: crate::autofilter::FilterCriteria {
                filter_on: crate::autofilter::FilterOn::Values,
                values: strings(&["East"]),
                filter_out_blanks: true,
                ..Default::default()
            },
        },
    );
    af.hidden_rows = [2u32, 4].into_iter().collect();
    let table = crate::tables::Table {
        id: new_id(),
        name: "Sales".to_string(),
        sheet_index: 0,
        start_row: 0,
        start_col: 0,
        end_row: 4,
        end_col: 0,
        columns: vec![crate::tables::TableColumn::new(new_id(), "Region".to_string())],
        style_options: Default::default(),
        style_name: "TableStyleMedium2".to_string(),
        auto_filter_id: Some(af.id),
    };
    fx.state.auto_filters.write(&seed).unwrap().insert(0, af);
    fx.state.tables.write(&seed).unwrap().entry(0).or_default().insert(table.id, table.clone());

    let mut s = slicer_on(0, table.id, "Region", selected);
    s.source_type = SlicerSourceType::Table;
    s.connected_sources = vec![SlicerConnection { source_type: SlicerSourceType::Table, source_id: table.id }];
    let slicer_id = s.id;
    fx.slicer.slicers.write(&seed).unwrap().insert(slicer_id, s);
    (table.id, slicer_id)
}

fn table_filter_state(fx: &Fx) -> (bool, Vec<u32>) {
    let filters = fx.state.auto_filters.read().unwrap();
    let af = &filters[&0];
    let mut hidden: Vec<u32> = af.hidden_rows.iter().copied().collect();
    hidden.sort();
    (af.column_filters.contains_key(&0), hidden)
}

/// FINDINGS 7 + 9 (owner decision 3, TABLE slicers). Deleting a table slicer
/// with a selection clears the AutoFilter column it set, in the SAME undo step
/// as the delete: one Ctrl+Z brings back the slicer AND the filter. An idle
/// table slicer's delete leaves a filter set from the table's own dropdown.
#[tokio::test]
async fn deleting_a_table_slicer_clears_its_autofilter_column_and_one_undo_restores_both() {
    let fx = Fx::new(0).await;
    let (_table, slicer) = seed_filtered_table(&fx, Some(&["East"]));
    assert_eq!(table_filter_state(&fx), (true, vec![2, 4]), "precondition");

    let depth = fx.undo_depth();
    delete_slicer_core(&fx.ctx(), slicer).await.expect("delete");
    assert!(!fx.slicer.slicers.read().unwrap().contains_key(&slicer));
    assert_eq!(table_filter_state(&fx), (false, vec![]), "the table stayed filtered after its slicer was deleted");
    assert_eq!(fx.undo_depth(), depth + 1, "the delete and the filter clear are ONE step");

    fx.undo_once();
    assert!(fx.slicer.slicers.read().unwrap().contains_key(&slicer), "the slicer came back");
    assert_eq!(table_filter_state(&fx), (true, vec![2, 4]), "one Ctrl+Z did not bring the filter back");

    // An idle table slicer filtered nothing: its delete clears nothing.
    let fx = Fx::new(0).await;
    let (_table, idle) = seed_filtered_table(&fx, None);
    delete_slicer_core(&fx.ctx(), idle).await.expect("delete");
    assert_eq!(table_filter_state(&fx), (true, vec![2, 4]), "an idle slicer's delete wiped the dropdown's filter");
}

/// The `delete_sheet` command's three steps, in its order: resolve the doomed
/// slicers' targets, delete the sheet, clear. Returns the pivots it hands to
/// the background re-query. (`the_delete_sheet_command_clears_the_filters_of_its_slicers`
/// pins that the command body really runs these steps.)
fn delete_sheet_as_the_command_does(fx: &Fx, index: usize) -> Vec<EntityId> {
    let doomed = crate::slicer::commands::filter_targets_of_slicers_on_sheet(&fx.state, &fx.pivots, &fx.slicer, index);
    crate::sheets::delete_sheet_impl(
        &fx.state, &fx.file, &fx.pivots, &fx.files, &fx.pane, &fx.filters, &fx.slicer, &fx.timelines, index, false,
    )
    .expect("delete the dashboard sheet");
    crate::slicer::commands::clear_filters_of_deleted_slicers(
        &fx.state,
        &fx.file,
        &fx.pivots,
        crate::pivot::operations::PivotRecalcStates { pane: &fx.pane, ribbon: &fx.filters, user_files: &fx.files },
        &doomed,
    )
}

/// The Tauri command cannot be driven here (no tauri harness), so its WIRING
/// is pinned from the source: resolve before the delete, clear after it, hand
/// the pins to the background re-query.
#[test]
fn the_delete_sheet_command_clears_the_filters_of_its_slicers() {
    let src = include_str!("../sheets.rs");
    let start = src.find("pub fn delete_sheet(").expect("the command");
    let body = &src[start..start + src[start..].find("
}
").expect("its end")];
    let at = |needle: &str| body.find(needle).unwrap_or_else(|| panic!("delete_sheet no longer calls {needle}"));
    let resolve = at("filter_targets_of_slicers_on_sheet(");
    let delete = at("delete_sheet_impl(");
    let clear = at("clear_filters_of_deleted_slicers(");
    let requery = at("spawn_quiet_bi_requery(");
    assert!(resolve < delete && delete < clear && clear < requery, "the steps are out of order");
}

/// FINDING 8. A slicer removed WITH ITS SHEET takes its filter with it: a
/// pivot slicer on a dashboard sheet driving a BI pivot on another sheet used
/// to leave its mask -- on a column in no zone, so nothing on screen showed or
/// could clear it, and the history is gone after a sheet delete.
#[tokio::test]
async fn deleting_the_sheet_a_slicer_lives_on_clears_its_filter_on_pivots_elsewhere() {
    let fx = Fx::new(2).await;
    let pivot = fx.add_bi_pivot(1).await;
    fx.lay_out(pivot, &["year"], &[]).await;

    let mut s = slicer_on(2, pivot, "Sales.region", Some(&["East"]));
    s.source_type = SlicerSourceType::Pivot;
    s.connected_sources = vec![SlicerConnection { source_type: SlicerSourceType::Pivot, source_id: pivot }];
    let slicer = s.id;
    fx.slicer.slicers.write(&test_seed_effect()).unwrap().insert(slicer, s);
    fx.click(pivot, "Sales.region", &["East"]).await;
    assert_eq!(fx.hidden_on(pivot, "region"), Some(strings(&["North", "West"])), "precondition");

    let requery = delete_sheet_as_the_command_does(&fx, 2);
    assert!(!fx.slicer.slicers.read().unwrap().contains_key(&slicer), "fixture: the slicer went with its sheet");
    assert!(
        fx.hidden_on(pivot, "region").map_or(true, |h| h.is_empty()),
        "the deleted slicer's filter stayed on a pivot on another sheet"
    );
    assert!(requery.is_empty(), "a host-side mask needs no re-query");
}

/// FINDING 8 (pins). A PINNED filter of a slicer removed with its sheet lives
/// inside the pivot's query: the sheet delete drops the pin and hands the
/// pivot back for a re-query, which brings every region back.
#[tokio::test]
async fn a_pin_of_a_slicer_removed_with_its_sheet_is_dropped_and_requeried() {
    let fx = Fx::new(2).await;
    let pivot = fx.add_bi_pivot(1).await;
    fx.lay_out(pivot, &["year"], &[]).await;
    let mut s = slicer_on(2, pivot, "Sales.region", Some(&["East"]));
    s.source_type = SlicerSourceType::Pivot;
    s.connected_sources = vec![SlicerConnection { source_type: SlicerSourceType::Pivot, source_id: pivot }];
    s.filter_level = 2;
    let slicer = s.id;
    fx.slicer.slicers.write(&test_seed_effect()).unwrap().insert(slicer, s);
    let mut request = apply(pivot, "Sales.region", &["East"]);
    request.filter_level = 2;
    request.slicer_id = Some(slicer.to_string());
    apply_pivot_filter_core(&fx.ctx(), request).await.expect("a pinned apply");
    let owned_pin = |fx: &Fx| {
        fx.definition(pivot).engine_filters.iter().any(|ef| ef.slicer_id.as_deref() == Some(slicer.to_string().as_str()))
    };
    assert!(owned_pin(&fx), "precondition: the pin");

    let requery = delete_sheet_as_the_command_does(&fx, 2);
    assert!(!owned_pin(&fx), "the pin outlived its slicer's sheet");
    assert_eq!(requery, vec![pivot], "a dropped pin changes the query: the pivot must be re-queried");

    // What the command's background task runs.
    let quiet = PivotCmdCtx { record_undo: false, ..fx.ctx() };
    crate::pivot::commands::refresh_bi_pivot_core(&quiet, pivot).await.expect("re-query");
    let regions = {
        let mut tables = fx.pivots.pivot_tables.write(&test_seed_effect()).unwrap();
        let cache = &mut tables.get_mut(&pivot).unwrap().1;
        match (0..cache.fields.len()).find(|&i| cache.field_name(i).as_deref() == Some("region")) {
            Some(idx) => crate::pivot::commands::hidden_for_selection(cache, idx, &[], true).len(),
            None => 3, // the column left the query with its pin: every region is back
        }
    };
    assert_eq!(regions, 3, "the re-queried pivot still shows only the pinned region");
}

/// FINDING 11. `delete_slicer` must not hold the GLOBAL undo transaction open
/// while it waits on the BI engine: a concurrent edit was folded into "Delete
/// slicer", or a concurrent paste committed it half-built. The step is
/// recorded once, at the end -- still ONE Ctrl+Z restoring slicer and filter.
#[tokio::test]
async fn deleting_a_slicer_holds_no_undo_transaction_open_while_it_waits_on_the_engine() {
    let fx = Fx::new(1).await;
    let pivot = fx.add_bi_pivot(1).await;
    fx.lay_out(pivot, &["year"], &[]).await;
    let slicer = fx.model_slicer(1, "Sales.region", Some(vec!["East"]));
    update_slicer_core(
        &fx.state,
        &fx.file,
        &fx.slicer,
        slicer,
        serde_json::from_value(serde_json::json!({ "filterLevel": 2 })).unwrap(),
    )
    .unwrap();
    let mut request = apply(pivot, "Sales.region", &["East"]);
    request.filter_level = 2;
    request.slicer_id = Some(slicer.to_string());
    apply_pivot_filter_core(&fx.ctx(), request).await.expect("a pinned apply");
    let pinned = |fx: &Fx| fx.definition(pivot).engine_filters.iter().any(|ef| ef.column == "region");
    assert!(pinned(&fx), "precondition");

    let depth = fx.undo_depth();
    let engine_arc = fx.bi.connections.lock().unwrap()[&fx.conn].engine.clone().unwrap();
    let busy = engine_arc.lock().await; // the engine is busy with someone else's query
    let ctx = fx.ctx();
    let mut delete = Box::pin(delete_slicer_core(&ctx, slicer));
    let waited = tokio::time::timeout(std::time::Duration::from_millis(150), &mut delete).await;
    assert!(waited.is_err(), "fixture: the delete must be waiting on the engine");
    assert!(
        !fx.state.undo_stack.lock().unwrap().has_open_transaction(),
        "delete_slicer held the global undo transaction open across a BI await"
    );
    drop(busy);
    delete.await.expect("delete");
    assert!(!pinned(&fx), "the pin outlived its slicer");
    assert_eq!(fx.undo_depth(), depth + 1, "the delete is ONE step");

    fx.undo_once();
    assert!(fx.slicer.slicers.read().unwrap().contains_key(&slicer), "the slicer came back");
    assert!(pinned(&fx), "one Ctrl+Z did not bring the pin back");
}

// ============================================================================
// THE LIVE DEFECT (journey canvas.spec.ts #11): reopen, then refresh
// ============================================================================

/// Save a workbook's pivots, reopen them (the load path rebuilds the pivot
/// store from the file; the grid keeps the saved output cells), and re-bind
/// the model connection the way reconnecting does.
fn save_and_reopen_pivots(fx: &Fx, drop_extent: bool) {
    let mut workbook = ::persistence::Workbook::new();
    crate::persistence::collect_pivot_definitions(&fx.pivots, &fx.state, &mut workbook);
    if drop_extent {
        // What an OLDER build wrote (and what an older reader keeps): no extent.
        for meta in workbook.bi_pivot_metadata.iter_mut() {
            if let Some(obj) = meta.as_object_mut() {
                obj.remove("outputExtent");
            }
        }
    } else {
        assert!(
            workbook.bi_pivot_metadata.iter().all(|m| m.get("outputExtent").is_some()),
            "the save must record every BI pivot's output extent"
        );
    }
    crate::persistence::restore_pivot_definitions(&workbook, &fx.pivots, &fx.state);
    for meta in fx.pivots.bi_metadata.write(&test_seed_effect()).unwrap().values_mut() {
        meta.connection_id = fx.conn;
    }
}

/// After File > Open a BI pivot has an EMPTY cache; its protected region was
/// registered from that empty view, smaller than the output it wrote last
/// session, so the first refresh counted the pivot's OWN saved rows as foreign
/// data and the frontend asked "A PivotTable report will overwrite existing
/// data" -- on a worksheet and on a canvas.
#[tokio::test]
async fn a_reopened_bi_pivot_refreshes_without_counting_its_own_output_as_foreign_data() {
    let fx = Fx::new(1).await;
    let on_worksheet = fx.add_bi_pivot(0).await;
    fx.lay_out(on_worksheet, &["region"], &["year"]).await;
    let on_canvas = fx.add_bi_pivot(1).await;
    fx.lay_out(on_canvas, &["region"], &["year"]).await;

    save_and_reopen_pivots(&fx, false);

    let worksheet = crate::pivot::commands::refresh_bi_pivot_core(&fx.ctx(), on_worksheet).await.unwrap();
    assert_eq!(worksheet.overwritten_cell_count, 0, "a worksheet pivot's refresh after reopen counted its own rows");
    let canvas = crate::pivot::commands::refresh_bi_pivot_core(&fx.ctx(), on_canvas).await.unwrap();
    assert_eq!(canvas.overwritten_cell_count, 0, "a canvas pivot's refresh after reopen counted its own rows");
}

/// The canvas half on its own: a canvas's hidden grid holds only pivot
/// output (one pivot per block), so even a file from an older build -- no
/// saved extent, so the region is the empty placeholder -- never counts
/// "existing data" there. The worksheet pivot in the same file is the
/// positive control: it DOES count (the older-reader nuisance the extent
/// removes).
#[tokio::test]
async fn a_canvas_pivot_never_counts_overwritten_cells_even_without_a_saved_extent() {
    let fx = Fx::new(1).await;
    let on_worksheet = fx.add_bi_pivot(0).await;
    fx.lay_out(on_worksheet, &["region"], &["year"]).await;
    let on_canvas = fx.add_bi_pivot(1).await;
    fx.lay_out(on_canvas, &["region"], &["year"]).await;

    save_and_reopen_pivots(&fx, true);

    let worksheet = crate::pivot::commands::refresh_bi_pivot_core(&fx.ctx(), on_worksheet).await.unwrap();
    assert!(worksheet.overwritten_cell_count > 0, "fixture: without an extent the worksheet region is too small");
    let canvas = crate::pivot::commands::refresh_bi_pivot_core(&fx.ctx(), on_canvas).await.unwrap();
    assert_eq!(canvas.overwritten_cell_count, 0, "a canvas pivot counted overwritten cells");
}

// ============================================================================
// FIX ROUND 3: the reconcile's re-apply must not re-add a column the pivot's
// records already carry, and a re-querying filter edit must record the state
// from BEFORE its own in-place edit.
// ============================================================================

impl Fx {
    fn redo_depth(&self) -> usize {
        self.state.undo_stack.lock().unwrap().redo_depth()
    }

    fn redo_once(&self) {
        let transaction = self.state.undo_stack.lock().unwrap().pop_redo().expect("a step to redo");
        crate::undo_commands::apply_changes(
            &self.state, &self.file, &self.files, &self.pivots, &self.slicer, &self.filters, &self.pane,
            &self.timelines, transaction, false,
        );
    }

    /// What `runInUndoTransaction` does around a gesture: the backend's
    /// `begin_undo_transaction` / `commit_undo_transaction`.
    fn begin(&self, description: &str) {
        self.state.undo_stack.lock().unwrap().begin_transaction(description);
    }

    fn commit(&self) {
        self.state.undo_stack.lock().unwrap().commit_transaction();
    }

    /// A slicer selection change, recorded into the open transaction.
    fn select(&self, slicer: EntityId, selected: Option<&[&str]>) {
        update_slicer_selection_core(
            &self.state,
            &self.file,
            &self.slicer,
            slicer,
            selected.map(strings),
            "Slicer Selection",
        )
        .unwrap();
    }

    fn selected(&self, slicer: EntityId) -> Option<Vec<String>> {
        self.slicer.slicers.read().unwrap()[&slicer].selected_items.clone()
    }

    fn set_level(&self, slicer: EntityId, level: u8) {
        update_slicer_core(
            &self.state,
            &self.file,
            &self.slicer,
            slicer,
            serde_json::from_value(serde_json::json!({ "filterLevel": level })).unwrap(),
        )
        .unwrap();
    }

    /// Every value the pivot's RECORDS hold on Sales.region (sorted), or
    /// `None` when the records have no such column: what the view can show.
    fn cached_regions(&self, pivot: EntityId) -> Option<Vec<String>> {
        let mut tables = self.pivots.pivot_tables.write(&test_seed_effect()).unwrap();
        let cache = &mut tables.get_mut(&pivot).unwrap().1;
        let idx = (0..cache.fields.len()).find(|&i| cache.field_name(i).as_deref() == Some("region"))?;
        Some(sorted(crate::pivot::commands::hidden_for_selection(cache, idx, &[], true)))
    }

    /// The pin on Sales.region, as its selected items.
    fn region_pin(&self, pivot: EntityId) -> Option<Vec<String>> {
        self.definition(pivot)
            .engine_filters
            .iter()
            .find(|ef| ef.table == "Sales" && ef.column == "region")
            .map(|ef| sorted(ef.selected_items.clone()))
    }

    async fn pinned_click(&self, pivot: EntityId, slicer: EntityId, selected: &[&str]) {
        let mut request = apply(pivot, "Sales.region", selected);
        request.filter_level = 2;
        request.slicer_id = Some(slicer.to_string());
        apply_pivot_filter_core(&self.ctx(), request).await.expect("a pinned apply");
    }
}

/// FINDING 1 (slicer frontend review 2), the backend half. A level-1 Clear
/// drops the column's slicer filter but never re-queries, so the records keep
/// the column. The next apply on that column must RE-USE it: re-adding it
/// through the ensure re-queried the model and recorded a "Pivot table field
/// change" step, and any new step clears the redo stack.
#[tokio::test]
async fn reapplying_a_cleared_column_the_records_still_carry_records_no_step_and_keeps_redo() {
    let fx = Fx::new(1).await;
    let pivot = fx.add_bi_pivot(1).await;
    fx.lay_out(pivot, &["year"], &[]).await;
    assert_eq!(fx.cached_regions(pivot), None, "fixture: region is on no axis and not in the query");

    // The first apply ADDS the column: the ensure's one step.
    let depth = fx.undo_depth();
    fx.click(pivot, "Sales.region", &["East"]).await;
    assert_eq!(fx.undo_depth(), depth + 1, "fixture: the ensure records one step");

    // Clear: the filter goes, the records keep the column.
    clear_pivot_filter_core(&fx.ctx(), Fx::clear_request(pivot, "Sales.region")).await.unwrap();
    assert_eq!(fx.hidden_on(pivot, "region"), None, "fixture: the clear dropped the column's filter");
    assert_eq!(
        fx.cached_regions(pivot),
        Some(strings(&["East", "North", "West"])),
        "fixture: a level-1 clear does not re-query"
    );

    // Something to redo, which any NEW step would wipe.
    fx.state.undo_stack.lock().unwrap().push_redo(engine::Transaction::new("something to redo"));
    let depth = fx.undo_depth();

    fx.click(pivot, "Sales.region", &["East"]).await;
    assert_eq!(fx.undo_depth(), depth, "re-applying a column the records carry recorded an undo step");
    assert_eq!(fx.redo_depth(), 1, "re-applying a column the records carry cleared the redo stack");
    assert_eq!(fx.hidden_on(pivot, "region"), Some(strings(&["North", "West"])), "the pivot does not show East only");
}

/// The same, end to end as the frontend drives it: click East, Clear, Ctrl+Z
/// (the slicer is back at [East]), then the reconcile's re-apply. It must
/// record nothing, the pivot must show East again, and Ctrl+Y must still
/// redo the Clear.
#[tokio::test]
async fn the_reconcile_after_undoing_a_clear_records_nothing_and_the_clear_can_still_be_redone() {
    let fx = Fx::new(1).await;
    let pivot = fx.add_bi_pivot(1).await;
    fx.lay_out(pivot, &["year"], &[]).await;
    let slicer = fx.model_slicer(1, "Sales.region", None);

    // Click East: one "Slicer Selection" step (the selection + the ensure).
    fx.begin("Slicer Selection");
    fx.select(slicer, Some(&["East"]));
    fx.click(pivot, "Sales.region", &["East"]).await;
    fx.commit();
    assert_eq!(fx.hidden_on(pivot, "region"), Some(strings(&["North", "West"])), "fixture: filtered to East");

    // Clear.
    fx.begin("Slicer Selection");
    fx.select(slicer, None);
    clear_pivot_filter_core(&fx.ctx(), Fx::clear_request(pivot, "Sales.region")).await.unwrap();
    fx.commit();
    assert_eq!(fx.hidden_on(pivot, "region"), None, "fixture: the Clear unfiltered the pivot");

    // Ctrl+Z restores the slicer; the pivot is re-derived by the reconcile.
    fx.undo_once();
    assert_eq!(fx.selected(slicer), Some(strings(&["East"])), "fixture: the undo restored the selection");
    assert_eq!(fx.redo_depth(), 1, "fixture: the Clear can be redone");
    let depth = fx.undo_depth();

    // The reconcile's re-apply (no transaction is open during the undo fan-out).
    fx.click(pivot, "Sales.region", &["East"]).await;
    assert_eq!(fx.undo_depth(), depth, "the reconcile's re-apply recorded an undo step");
    assert_eq!(fx.redo_depth(), 1, "the reconcile's re-apply wiped the redo of the Clear");
    assert_eq!(fx.hidden_on(pivot, "region"), Some(strings(&["North", "West"])), "the pivot does not show East again");

    // Ctrl+Y redoes the Clear.
    fx.redo_once();
    assert_eq!(fx.selected(slicer), None, "Ctrl+Y did not redo the Clear");
}

/// FINDING 3 (slicer frontend review 2), case (a). A level-1 slicer on East
/// is switched to level 2 in Slicer Settings: ONE step holds the level change
/// and the pinned apply. Ctrl+Z must bring back the level-1 state -- no pin,
/// the host-side mask, every region in the records. The pinned apply's own
/// re-query snapshotted the definition AFTER its in-place edit, so the undo
/// restored the pin against the unpinned records and showed every region.
#[tokio::test]
async fn undoing_a_level_change_to_pinned_restores_the_mask() {
    let fx = Fx::new(1).await;
    let pivot = fx.add_bi_pivot(1).await;
    fx.lay_out(pivot, &["year"], &[]).await;
    let slicer = fx.model_slicer(1, "Sales.region", Some(vec!["East"]));
    fx.click(pivot, "Sales.region", &["East"]).await;
    assert_eq!(fx.hidden_on(pivot, "region"), Some(strings(&["North", "West"])), "fixture: a level-1 mask");
    assert_eq!(fx.region_pin(pivot), None, "fixture: no pin at level 1");

    // Slicer Settings > level 2 > OK.
    fx.begin("Slicer Settings");
    fx.set_level(slicer, 2);
    fx.pinned_click(pivot, slicer, &["East"]).await;
    fx.commit();
    assert_eq!(fx.region_pin(pivot), Some(strings(&["East"])), "fixture: pinned");
    assert_eq!(fx.cached_regions(pivot), Some(strings(&["East"])), "fixture: the query is pinned");

    fx.undo_once();
    assert_eq!(fx.region_pin(pivot), None, "undo kept the pin");
    assert!(fx.definition(pivot).engine_filters.is_empty(), "undo left engine filters behind");
    assert_eq!(
        fx.hidden_on(pivot, "region"),
        Some(strings(&["North", "West"])),
        "undo did not restore the level-1 mask"
    );
    assert_eq!(
        fx.cached_regions(pivot),
        Some(strings(&["East", "North", "West"])),
        "undo did not restore the unpinned records"
    );
    assert_eq!(fx.slicer.slicers.read().unwrap()[&slicer].filter_level, 1, "fixture: the slicer is back at level 1");

    // Ctrl+Y: pinned again.
    fx.redo_once();
    assert_eq!(fx.region_pin(pivot), Some(strings(&["East"])), "redo did not bring the pin back");
    assert_eq!(fx.cached_regions(pivot), Some(strings(&["East"])), "redo did not bring the pinned records back");
}

/// FINDING 3, case (b). A level-2 slicer clicked from East to West, then
/// Ctrl+Z: the pin must be [East] again, not only the view. The undo used to
/// restore pin=[West] against the East records -- right on screen, wrong in
/// the saved definition, and the next refresh showed West.
#[tokio::test]
async fn undoing_a_pinned_apply_restores_the_pre_pin_definition() {
    let fx = Fx::new(1).await;
    let pivot = fx.add_bi_pivot(1).await;
    fx.lay_out(pivot, &["year"], &[]).await;
    let slicer = fx.model_slicer(1, "Sales.region", Some(vec!["East"]));
    fx.set_level(slicer, 2);
    fx.pinned_click(pivot, slicer, &["East"]).await;
    assert_eq!(fx.region_pin(pivot), Some(strings(&["East"])), "fixture: pinned to East");

    // Click West: one "Slicer Selection" step.
    fx.begin("Slicer Selection");
    fx.select(slicer, Some(&["West"]));
    fx.pinned_click(pivot, slicer, &["West"]).await;
    fx.commit();
    assert_eq!(fx.region_pin(pivot), Some(strings(&["West"])), "fixture: pinned to West");
    assert_eq!(fx.cached_regions(pivot), Some(strings(&["West"])), "fixture: the query shows West");

    fx.undo_once();
    assert_eq!(fx.region_pin(pivot), Some(strings(&["East"])), "undo left the pin at West");
    assert_eq!(fx.cached_regions(pivot), Some(strings(&["East"])), "undo does not show East");
    assert_eq!(fx.selected(slicer), Some(strings(&["East"])), "fixture: the slicer is back on East");

    fx.redo_once();
    assert_eq!(fx.region_pin(pivot), Some(strings(&["West"])), "redo did not bring the West pin back");
    assert_eq!(fx.cached_regions(pivot), Some(strings(&["West"])), "redo does not show West");
}

/// FINDING 3 on the CLEAR path: clearing a pinned slicer drops the pin and
/// re-queries (`engine_filter_dropped`); Ctrl+Z must bring the pin and the
/// pinned records back, and Ctrl+Y must clear it again.
#[tokio::test]
async fn undoing_a_pinned_clear_restores_the_pin() {
    let fx = Fx::new(1).await;
    let pivot = fx.add_bi_pivot(1).await;
    fx.lay_out(pivot, &["year"], &[]).await;
    let slicer = fx.model_slicer(1, "Sales.region", Some(vec!["East"]));
    fx.set_level(slicer, 2);
    fx.pinned_click(pivot, slicer, &["East"]).await;
    assert_eq!(fx.region_pin(pivot), Some(strings(&["East"])), "fixture: pinned to East");

    // Clear: one "Slicer Selection" step.
    fx.begin("Slicer Selection");
    fx.select(slicer, None);
    clear_pivot_filter_core(&fx.ctx(), Fx::clear_request(pivot, "Sales.region")).await.unwrap();
    fx.commit();
    assert_eq!(fx.region_pin(pivot), None, "fixture: the clear dropped the pin");

    fx.undo_once();
    assert_eq!(fx.region_pin(pivot), Some(strings(&["East"])), "undo did not bring the pin back");
    assert_eq!(fx.cached_regions(pivot), Some(strings(&["East"])), "undo does not show East");

    fx.redo_once();
    assert_eq!(fx.region_pin(pivot), None, "redo did not clear the pin again");
}

/// The pre-edit step is recorded ONCE, AFTER the re-query, never by holding
/// the global undo transaction open across the BI await (a concurrent cell
/// edit would be swallowed into "Filter pivot", `delete_slicer_core`'s rule);
/// with no outer transaction it is a step of its own.
#[tokio::test]
async fn a_pinned_apply_holds_no_undo_transaction_open_while_it_waits_on_the_engine() {
    let fx = Fx::new(1).await;
    let pivot = fx.add_bi_pivot(1).await;
    fx.lay_out(pivot, &["year"], &[]).await;
    let slicer = fx.model_slicer(1, "Sales.region", Some(vec!["East"]));
    fx.set_level(slicer, 2);
    fx.pinned_click(pivot, slicer, &["East"]).await;
    assert_eq!(fx.region_pin(pivot), Some(strings(&["East"])), "fixture: pinned to East");

    let depth = fx.undo_depth();
    let engine_arc = fx.bi.connections.lock().unwrap()[&fx.conn].engine.clone().unwrap();
    let busy = engine_arc.lock().await; // the engine is busy with someone else's query
    let ctx = fx.ctx();
    // By cache INDEX (a header-dropdown shape), so the first engine wait is
    // the RE-QUERY's -- a biFieldKey would wait in the ensure first, before
    // anything was edited.
    let region_idx = {
        let tables = fx.pivots.pivot_tables.read().unwrap();
        let cache = &tables[&pivot].1;
        (0..cache.fields.len()).find(|&i| cache.field_name(i).as_deref() == Some("region")).expect("region column")
    };
    let mut request = apply(pivot, "Sales.region", &["West"]);
    request.bi_field_key = None;
    request.field_index = Some(region_idx);
    request.filter_level = 2;
    request.slicer_id = Some(slicer.to_string());
    let mut click = Box::pin(apply_pivot_filter_core(&ctx, request));
    let waited = tokio::time::timeout(std::time::Duration::from_millis(150), &mut click).await;
    assert!(waited.is_err(), "fixture: the apply must be waiting on the engine");
    assert!(
        !fx.state.undo_stack.lock().unwrap().has_open_transaction(),
        "a pinned apply held the global undo transaction open across a BI await"
    );
    drop(busy);
    click.await.expect("the pinned apply");
    assert_eq!(fx.undo_depth(), depth + 1, "the pinned apply is ONE step of its own");
    fx.undo_once();
    assert_eq!(fx.region_pin(pivot), Some(strings(&["East"])), "its one step did not restore the East pin");
}

// ============================================================================
// FIX ROUND 3, T4: no filter path holds `pivot_tables` while it waits for
// `sheet_names`. `delete_sheet` and the calculation pass (`calculate_now`, an
// async command, so off the main thread) both hold `sheet_names` and then
// take `pivot_tables`; a filter apply/clear that resolved its destination
// sheet under the pivot guard closed the cycle.
// ============================================================================

/// Drive `command` (run on its own thread) into the window between its pivot
/// write guard and its destination-sheet resolution, with `sheet_names` held
/// the way `delete_sheet` holds it; then take `pivot_tables` as the delete's
/// next step does. `true` = the pivot lock was reachable (no ABBA).
///
/// How it gets there deterministically: the filter paths read `bi_metadata`
/// INSIDE their pivot guard, after every sheet read of their pre-checks (and
/// the undo restore stores its view under the guard). So this thread holds
/// that PARKING lock first, waits until the command is parked on it (holding
/// `pivot_tables`, which the fixture check proves), takes `sheet_names`, and
/// only then releases the parking lock.
enum Park {
    BiMetadata,
    Views,
}

fn pivot_lock_reachable_while_sheet_names_is_held<R: Send>(
    fx: &Fx,
    park: Park,
    command: impl FnOnce() -> R + Send,
) -> (bool, R) {
    std::thread::scope(|scope| {
        let mut meta_guard =
            matches!(park, Park::BiMetadata).then(|| fx.pivots.bi_metadata.write(&test_seed_effect()).unwrap());
        let mut views_guard = matches!(park, Park::Views).then(|| fx.pivots.views.lock().unwrap());
        let runner = scope.spawn(command);
        std::thread::sleep(std::time::Duration::from_millis(200));
        // Fixture: the command now holds the pivot guard, parked on bi_metadata.
        let (held_tx, held_rx) = std::sync::mpsc::channel();
        let pivots = &fx.pivots;
        let early_probe = scope.spawn(move || {
            let _g = pivots.pivot_tables.read().unwrap();
            let _ = held_tx.send(());
        });
        let pivot_lock_free_too_early =
            held_rx.recv_timeout(std::time::Duration::from_millis(300)).is_ok();
        // `delete_sheet` step 1: it holds sheet_names...
        let names_guard = fx.state.sheet_names.write(&test_seed_effect()).unwrap();
        drop(meta_guard.take()); // ...the command runs on to its sheet resolution...
        drop(views_guard.take());
        std::thread::sleep(std::time::Duration::from_millis(250));
        // ...step 2: it takes pivot_tables. That must not wait on the command.
        let (tx, rx) = std::sync::mpsc::channel();
        let taker = scope.spawn(move || {
            let _g = pivots.pivot_tables.write(&test_seed_effect()).unwrap();
            let _ = tx.send(());
        });
        let reached = rx.recv_timeout(std::time::Duration::from_secs(3)).is_ok();
        drop(names_guard); // let everyone finish, whatever happened
        let result = runner.join().unwrap();
        early_probe.join().unwrap();
        taker.join().unwrap();
        assert!(
            !pivot_lock_free_too_early,
            "fixture: the command was not holding the pivot guard while parked on bi_metadata"
        );
        (reached, result)
    })
}

impl Fx {
    /// A header-dropdown apply by cache index: no ensure, no engine wait.
    fn header_apply(pivot: EntityId, field_index: usize, selected: &[&str]) -> ApplyPivotFilterRequest {
        ApplyPivotFilterRequest {
            pivot_id: pivot,
            field_index: Some(field_index),
            bi_field_key: None,
            filters: PivotFilters {
                manual_filter: Some(PivotManualFilter { selected_items: strings(selected) }),
                ..Default::default()
            },
            filter_level: 1,
            slicer_id: None,
            reconcile: false,
        }
    }

    fn row_field_index(&self, pivot: EntityId) -> usize {
        self.definition(pivot).row_fields[0].source_index
    }
}

#[test]
fn a_filter_apply_never_holds_the_pivot_lock_while_it_waits_for_sheet_names() {
    let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
    let (fx, pivot) = rt.block_on(async {
        let fx = Fx::new(1).await;
        let pivot = fx.add_bi_pivot(1).await;
        fx.lay_out(pivot, &["region"], &["year"]).await;
        (fx, pivot)
    });
    let idx = fx.row_field_index(pivot);
    let (reached, result) = pivot_lock_reachable_while_sheet_names_is_held(&fx, Park::BiMetadata, || {
        let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
        let ctx = fx.ctx();
        rt.block_on(apply_pivot_filter_core(&ctx, Fx::header_apply(pivot, idx, &["East"])))
    });
    result.expect("the apply");
    assert_eq!(fx.hidden_on(pivot, "region"), Some(strings(&["North", "West"])), "fixture: the apply filtered");
    assert!(
        reached,
        "apply_pivot_filter held pivot_tables while waiting for sheet_names (ABBA against delete_sheet \
         and the calculation pass)"
    );
}

#[test]
fn a_filter_clear_never_holds_the_pivot_lock_while_it_waits_for_sheet_names() {
    let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
    let (fx, pivot) = rt.block_on(async {
        let fx = Fx::new(1).await;
        let pivot = fx.add_bi_pivot(1).await;
        fx.lay_out(pivot, &["region"], &["year"]).await;
        (fx, pivot)
    });
    let idx = fx.row_field_index(pivot);
    rt.block_on(apply_pivot_filter_core(&fx.ctx(), Fx::header_apply(pivot, idx, &["East"]))).expect("apply");
    assert_eq!(fx.hidden_on(pivot, "region"), Some(strings(&["North", "West"])), "fixture: filtered");
    let (reached, result) = pivot_lock_reachable_while_sheet_names_is_held(&fx, Park::BiMetadata, || {
        crate::pivot::commands::clear_pivot_filter_local(
            &fx.state,
            &fx.file,
            &fx.pivots,
            crate::pivot::operations::PivotRecalcStates {
                pane: &fx.pane,
                ribbon: &fx.filters,
                user_files: &fx.files,
            },
            pivot,
            idx,
            None,
        )
    });
    assert!(
        matches!(result, Ok(crate::pivot::commands::FilterStep::Local(..))),
        "fixture: a host-side clear"
    );
    assert_eq!(fx.hidden_on(pivot, "region"), Some(Vec::new()), "fixture: the clear unfiltered");
    assert!(
        reached,
        "clear_pivot_filter held pivot_tables while waiting for sheet_names (ABBA against delete_sheet \
         and the calculation pass)"
    );
}

/// The undo of a pivot field change (`apply_pivot_definition_restore`)
/// resolved both its inverse's sheet and the restored one's under the pivot
/// guard; `undo` runs on the main thread, and an F9 on the async pool holds
/// `sheet_names` while it takes `pivot_tables`.
#[test]
fn undoing_a_pivot_change_never_holds_the_pivot_lock_while_it_waits_for_sheet_names() {
    let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().unwrap();
    let (fx, pivot) = rt.block_on(async {
        let fx = Fx::new(1).await;
        let pivot = fx.add_bi_pivot(1).await;
        fx.lay_out(pivot, &["region"], &["year"]).await;
        fx.lay_out(pivot, &["year"], &[]).await;
        (fx, pivot)
    });
    assert!(
        fx.definition(pivot).row_fields.iter().any(|f| f.name == "Sales.year"),
        "fixture: the second layout"
    );
    let (reached, ()) = pivot_lock_reachable_while_sheet_names_is_held(&fx, Park::Views, || fx.undo_once());
    assert!(
        fx.definition(pivot).row_fields.iter().any(|f| f.name == "Sales.region"),
        "fixture: the undo restored the first layout"
    );
    assert!(
        reached,
        "undoing a pivot change held pivot_tables while waiting for sheet_names (ABBA against the \
         calculation pass)"
    );
}

// ============================================================================
// FIX ROUND 3 (review): the re-apply after a Clear must re-use a column the
// records carry even when two model tables share its NAME, and a level-1
// selection that replaces a pin must be masked against the records the
// re-query fetches, not the pinned ones.
// ============================================================================

/// T1, the shared-name case. Customers.name and Products.name are both "name"
/// in the cache; the ensure's scan matched a bare name only when ONE table
/// owns it, so after a Clear the re-apply on Customers.name could not find the
/// column its records still carried, re-queried, recorded a "Pivot table field
/// change" step and wiped the redo stack -- the original finding, for every
/// star-schema column called Name, Code, Date or Year. Each cache column now
/// carries its "Table.Column" key. The ensure step is undone and redone first,
/// so the key must also survive the JSON undo snapshot the records come back
/// from.
#[tokio::test]
async fn reapplying_a_cleared_column_whose_name_two_tables_share_records_no_step_and_keeps_redo() {
    let fx = star_fx().await;
    let pivot = fx.add_bi_pivot(1).await;
    fx.lay_out_on(pivot, &[("Products", "category")], &[]).await;
    fx.click(pivot, "Customers.name", &["Acme"]).await;
    fx.click(pivot, "Products.name", &["Widget"]).await;
    let names = fx.cache_names(pivot);
    assert_eq!(names.iter().filter(|n| *n == "name").count(), 2, "fixture: two cache columns called name: {names:?}");

    // The records come back from the undo snapshots.
    fx.undo_once();
    fx.redo_once();
    assert_eq!(fx.hidden_on_key(pivot, "Customers.name"), Some(strings(&["Beta"])), "fixture: Customers filtered");
    assert_eq!(fx.hidden_on_key(pivot, "Products.name"), Some(strings(&["Gadget"])), "fixture: Products filtered");

    // Clear Customers.name: its filter goes, the records keep the column.
    clear_pivot_filter_core(&fx.ctx(), Fx::clear_request(pivot, "Customers.name")).await.unwrap();
    assert_eq!(fx.hidden_on_key(pivot, "Customers.name"), None, "fixture: the clear dropped the filter");
    assert_eq!(
        fx.cache_names(pivot).iter().filter(|n| *n == "name").count(),
        2,
        "fixture: a level-1 clear does not re-query"
    );

    fx.state.undo_stack.lock().unwrap().push_redo(engine::Transaction::new("something to redo"));
    let depth = fx.undo_depth();
    fx.click(pivot, "Customers.name", &["Acme"]).await;
    assert_eq!(fx.undo_depth(), depth, "re-applying a shared-name column the records carry recorded an undo step");
    assert_eq!(fx.redo_depth(), 1, "re-applying a shared-name column the records carry wiped the redo stack");
    assert_eq!(
        fx.hidden_on_key(pivot, "Customers.name"),
        Some(strings(&["Beta"])),
        "the re-apply did not filter Customers.name to Acme"
    );
    assert_eq!(
        fx.hidden_on_key(pivot, "Products.name"),
        Some(strings(&["Gadget"])),
        "the re-apply landed on Products.name"
    );
}

/// A pin that no model slicer owns (a Report Connections slicer, a ribbon or
/// header filter at level 2): the page fold cannot re-derive its column's
/// mask, so the apply that drops it must.
async fn pinned_by_a_non_model_filter(fx: &Fx, pivot: EntityId, selected: &[&str]) {
    let mut request = apply(pivot, "Sales.region", selected);
    request.filter_level = 2;
    request.slicer_id = Some(new_id().to_string()); // in no slicer store
    apply_pivot_filter_core(&fx.ctx(), request).await.expect("a pinned apply");
}

/// FINDING 2 (review 3). A level-1 selection on a column that held a pin
/// computed its mask against the PINNED records -- they hold only the pinned
/// values, so nothing outside the pin was ever hidden: pin [East], then a
/// level-1 [East, West] showed North as well, and [East] alone showed every
/// region. The selection is masked against the records the re-query fetches.
#[tokio::test]
async fn a_selection_that_drops_a_pin_is_masked_against_the_requeried_records() {
    let fx = Fx::new(1).await;
    let pivot = fx.add_bi_pivot(1).await;
    fx.lay_out(pivot, &["year"], &[]).await;
    pinned_by_a_non_model_filter(&fx, pivot, &["East"]).await;
    assert_eq!(fx.region_pin(pivot), Some(strings(&["East"])), "fixture: pinned");
    assert_eq!(fx.cached_regions(pivot), Some(strings(&["East"])), "fixture: the pinned records");

    let depth = fx.undo_depth();
    fx.click(pivot, "Sales.region", &["East", "West"]).await;
    assert_eq!(fx.region_pin(pivot), None, "fixture: the pin was dropped");
    assert_eq!(fx.cached_regions(pivot), Some(strings(&["East", "North", "West"])), "fixture: re-queried");
    assert_eq!(
        fx.hidden_on(pivot, "region"),
        Some(strings(&["North"])),
        "the pivot shows North, which was not selected"
    );
    assert_eq!(fx.undo_depth(), depth + 1, "fixture: the pin drop is one step");

    // Ctrl+Z: the pin and its records; Ctrl+Y: the mask again.
    fx.undo_once();
    assert_eq!(fx.region_pin(pivot), Some(strings(&["East"])), "undo did not restore the pin");
    assert_eq!(fx.cached_regions(pivot), Some(strings(&["East"])), "undo did not restore the pinned records");
    fx.redo_once();
    assert_eq!(fx.region_pin(pivot), None, "redo kept the pin");
    assert_eq!(fx.hidden_on(pivot, "region"), Some(strings(&["North"])), "redo lost the mask");
}

/// The same with the pin's own value alone: [East] must hide North and West.
#[tokio::test]
async fn reselecting_a_pins_own_value_at_level_1_still_hides_the_rest() {
    let fx = Fx::new(1).await;
    let pivot = fx.add_bi_pivot(1).await;
    fx.lay_out(pivot, &["year"], &[]).await;
    pinned_by_a_non_model_filter(&fx, pivot, &["East"]).await;

    fx.click(pivot, "Sales.region", &["East"]).await;
    assert_eq!(fx.region_pin(pivot), None, "fixture: the pin was dropped");
    assert_eq!(
        fx.hidden_on(pivot, "region"),
        Some(strings(&["North", "West"])),
        "the pivot shows every region although only East is selected"
    );
}

/// The control for the fix above: a MODEL slicer's level change 2 -> 1 in one
/// Slicer Settings step, where the page fold re-derives the same mask from the
/// slicer store. The gesture's own mask must agree with it, and the one step
/// must undo and redo.
#[tokio::test]
async fn a_model_slicers_level_change_from_pinned_to_level_1_round_trips() {
    let fx = Fx::new(1).await;
    let pivot = fx.add_bi_pivot(1).await;
    fx.lay_out(pivot, &["year"], &[]).await;
    let slicer = fx.model_slicer(1, "Sales.region", Some(vec!["East"]));
    fx.set_level(slicer, 2);
    fx.pinned_click(pivot, slicer, &["East"]).await;
    assert_eq!(fx.region_pin(pivot), Some(strings(&["East"])), "fixture: pinned");

    fx.begin("Slicer Settings");
    fx.set_level(slicer, 1);
    fx.click(pivot, "Sales.region", &["East"]).await;
    fx.commit();
    assert_eq!(fx.region_pin(pivot), None, "the pin was not dropped");
    assert_eq!(fx.hidden_on(pivot, "region"), Some(strings(&["North", "West"])), "the level-1 mask is wrong");

    fx.undo_once();
    assert_eq!(fx.region_pin(pivot), Some(strings(&["East"])), "undo did not restore the pin");
    assert_eq!(fx.cached_regions(pivot), Some(strings(&["East"])), "undo did not restore the pinned records");
    fx.redo_once();
    assert_eq!(fx.region_pin(pivot), None, "redo kept the pin");
    assert_eq!(fx.hidden_on(pivot, "region"), Some(strings(&["North", "West"])), "redo lost the mask");
}

// ============================================================================
// FIX ROUND 4, B5: every refusal of a PINNED apply comes before the document
// effect. `pivot_write` minted the document-modified token first, and the
// pinned branch's refusals (an invalid level, no item selection, not a BI
// pivot, an unknown field index, a column no single table owns) ran after it
// -- so a refused pin marked the document changed when nothing had.
// ============================================================================

impl Fx {
    /// Assert that `request` is REFUSED and leaves the document exactly as it
    /// was: clean, the same definition, the same records, no undo step.
    async fn assert_refused_and_clean(&self, label: &str, pivot: EntityId, request: ApplyPivotFilterRequest) {
        crate::document_effect::mark_saved(&self.file);
        let before = serde_json::to_value(self.definition(pivot)).unwrap();
        let names = self.cache_names(pivot);
        let depth = self.undo_depth();
        let err = match apply_pivot_filter_core(&self.ctx(), request).await {
            Ok(_) => panic!("{label}: the pinned apply was not refused"),
            Err(e) => e,
        };
        assert!(!self.file.is_dirty(), "{label}: a REFUSED pinned apply marked the document changed ({err})");
        assert_eq!(serde_json::to_value(self.definition(pivot)).unwrap(), before, "{label}: the definition changed");
        assert_eq!(self.cache_names(pivot), names, "{label}: the records changed");
        assert_eq!(self.undo_depth(), depth, "{label}: an undo step was recorded");
    }
}

fn pinned(mut request: ApplyPivotFilterRequest, level: u8) -> ApplyPivotFilterRequest {
    request.filter_level = level;
    request
}

#[tokio::test]
async fn every_refused_pinned_apply_leaves_the_document_clean() {
    let fx = Fx::new(1).await;
    let pivot = fx.add_bi_pivot(1).await;
    fx.lay_out(pivot, &["region"], &[]).await;
    let region = fx.row_field_index(pivot);

    fx.assert_refused_and_clean(
        "an invalid level",
        pivot,
        pinned(Fx::header_apply(pivot, region, &["East"]), 10),
    )
    .await;

    let mut no_items = pinned(Fx::header_apply(pivot, region, &["East"]), 2);
    no_items.filters.manual_filter = None;
    fx.assert_refused_and_clean("no item selection", pivot, no_items).await;

    // By MODEL KEY, on a column the pivot does not carry yet: the ensure
    // would ADD `Sales.year` (a query, a step, a dirty document) before the
    // refusal, so the request checks have to come before the ensure too.
    let mut no_items_by_key = pinned(apply(pivot, "Sales.year", &["Y1"]), 2);
    no_items_by_key.filters.manual_filter = None;
    fx.assert_refused_and_clean("no item selection, on a column the pivot does not carry", pivot, no_items_by_key)
        .await;

    fx.assert_refused_and_clean(
        "an unknown field index",
        pivot,
        pinned(Fx::header_apply(pivot, 99, &["East"]), 2),
    )
    .await;

    // A range pivot: no engine query to route a pin into.
    let range_pivot = new_id();
    {
        let mut def = pivot_engine::PivotDefinition::new(range_pivot, (0, 0), (2, 0));
        def.destination = (40, 40);
        def.row_fields.push(pivot_engine::PivotField::new(0, "Region".to_string()));
        let mut grid = engine::grid::Grid::new();
        for (r, v) in ["Region", "East", "West"].iter().enumerate() {
            grid.set_cell(r as u32, 0, engine::Cell::new_text(v.to_string()));
        }
        let (mut cache, headers) =
            crate::pivot::operations::build_cache_from_grid(&grid, (0, 0), (2, 0), true).expect("the cache");
        for (i, h) in headers.iter().enumerate() {
            cache.set_field_name(i, h.clone());
        }
        fx.pivots.pivot_tables.write(&test_seed_effect()).unwrap().insert(range_pivot, (def, cache));
    }
    fx.assert_refused_and_clean(
        "not a BI pivot",
        range_pivot,
        pinned(Fx::header_apply(range_pivot, 0, &["East"]), 2),
    )
    .await;
}

/// The fifth refusal: a header-dropdown pin (by cache index) on a column
/// whose NAME two model tables share cannot be attributed to either, and
/// fails closed -- before the effect.
#[tokio::test]
async fn a_refused_pin_on_a_column_two_tables_share_leaves_the_document_clean() {
    let fx = star_fx().await;
    let pivot = fx.add_bi_pivot(1).await;
    fx.lay_out_on(pivot, &[("Products", "category")], &[]).await;
    fx.click(pivot, "Customers.name", &["Acme"]).await;
    fx.click(pivot, "Products.name", &["Widget"]).await;
    let names = fx.cache_names(pivot);
    let shared = names.iter().position(|n| n == "name").expect("fixture: a cache column called name");
    assert_eq!(names.iter().filter(|n| *n == "name").count(), 2, "fixture: two cache columns called name: {names:?}");

    fx.assert_refused_and_clean(
        "a column no single table owns",
        pivot,
        pinned(Fx::header_apply(pivot, shared, &["Acme"]), 2),
    )
    .await;
}

// ============================================================================
// FIX ROUND 5 (P1): a LEVEL-1 filter that grows a WORKSHEET pivot over the
// user's cells. It recorded no undo step, so the cells were gone for good, and
// the header dropdown's Cancel (`undo_pivot_overwrite`) popped whatever step
// was on top -- the user's previous, unrelated edit -- and restored nothing.
// ============================================================================

impl Fx {
    /// A worksheet BI pivot on Sales.region, level-1 filtered to East -- so it
    /// is SHORTER than its unfiltered layout -- and a cell the unfiltered
    /// layout covers but the filtered one does not: where the user can type
    /// a value that the next "show everything" filter grows over.
    async fn shrunk_worksheet_pivot(&self) -> (EntityId, (u32, u32)) {
        let pivot = self.add_bi_pivot(0).await;
        self.lay_out(pivot, &["region"], &[]).await;
        let full = crate::pivot::operations::get_pivot_region(&self.state, pivot).expect("fixture: a region");
        self.click(pivot, "Sales.region", &["East"]).await;
        let small = crate::pivot::operations::get_pivot_region(&self.state, pivot).expect("fixture: a region");
        assert!(small.end_row < full.end_row, "fixture: filtering to East did not shrink the pivot");
        (pivot, (full.end_row, full.start_col))
    }

    /// Put a value in a cell WITHOUT an undo step (it was typed long ago).
    fn put_text(&self, (row, col): (u32, u32), text: &str) {
        let seed = test_seed_effect();
        let mut grid = self.state.grid.write(&seed).unwrap();
        let mut grids = self.state.grids.write(&seed).unwrap();
        grids[0].set_cell(row, col, engine::Cell::new_text(text.to_string()));
        grid.set_cell(row, col, engine::Cell::new_text(text.to_string()));
    }

    /// A user edit that records its own undo step, as `update_cell` does.
    fn user_edit(&self, cell: (u32, u32), text: &str) {
        self.put_text(cell, text);
        self.state.undo_stack.lock().unwrap().record_cell_change(0, cell.0, cell.1, None);
    }

    /// The text in a worksheet cell (sheet 0), `None` when it is empty.
    fn text_at(&self, (row, col): (u32, u32)) -> Option<String> {
        let grids = self.state.grids.read().unwrap();
        grids[0]
            .get_cell(row, col)
            .filter(|c| !matches!(c.value, engine::CellValue::Empty))
            .map(|c| c.display_value())
    }
}

/// Ctrl+Z after a level-1 filter that grew the pivot over the user's cell C
/// must bring C back; the SECOND Ctrl+Z undoes the user's earlier edit X.
/// Before round 5 the filter recorded no step: the first Ctrl+Z took X back
/// and C stayed overwritten.
#[tokio::test]
async fn ctrl_z_after_a_level_one_filter_that_overwrote_a_cell_restores_it() {
    let fx = Fx::new(0).await;
    let (pivot, c) = fx.shrunk_worksheet_pivot().await;
    fx.put_text(c, "V");
    let x = (40, 40);
    fx.user_edit(x, "X");
    let depth = fx.undo_depth();

    let response = apply_pivot_filter_core(&fx.ctx(), apply(pivot, "Sales.region", &["East", "North", "West"]))
        .await
        .expect("the filter applies");
    assert!(response.overwritten_cell_count >= 1, "fixture: the filter did not grow the pivot over C");
    assert_ne!(fx.text_at(c).as_deref(), Some("V"), "fixture: C was not overwritten");
    assert_eq!(fx.undo_depth(), depth + 1, "the filter that overwrote C recorded no undo step");
    assert!(response.overwrite_token.is_some(), "the response does not name the step a Cancel may take back");

    fx.undo_once();
    assert_eq!(fx.text_at(c).as_deref(), Some("V"), "Ctrl+Z did not put the user's value back in C");
    assert_eq!(fx.text_at(x).as_deref(), Some("X"), "the first Ctrl+Z took back the user's earlier edit X");
    assert_eq!(fx.hidden_on(pivot, "region"), Some(strings(&["North", "West"])), "Ctrl+Z did not restore the East filter");

    fx.undo_once();
    assert_eq!(fx.text_at(x), None, "the second Ctrl+Z did not undo X");
}

impl Fx {
    /// The header dropdown's Cancel: `undo_pivot_overwrite`'s core.
    fn cancel_overwrite(&self, tokens: &[u64]) -> Result<(Vec<crate::undo_commands::UndoResult>, bool), String> {
        crate::pivot::commands::undo_pivot_overwrite_core(
            &self.state, &self.file, &self.files, &self.pivots, &self.slicer, &self.filters, &self.pane,
            &self.timelines, tokens,
        )
    }

    fn undo_seqs(&self) -> Vec<u64> {
        self.state.undo_stack.lock().unwrap().undo_seqs()
    }

    /// The header dropdown's apply: a level-1 selection on Sales.region, by
    /// its CACHE INDEX (no model key), as the pivot's own dropdown sends it.
    async fn header_select(&self, pivot: EntityId, selected: &[&str]) -> crate::pivot::types::PivotViewResponse {
        let idx = self.definition(pivot).row_fields.iter().find(|f| f.name == "Sales.region").unwrap().source_index;
        apply_pivot_filter_core(&self.ctx(), Fx::header_apply(pivot, idx, selected)).await.expect("the header apply")
    }
}

/// The header dropdown's Cancel after a level-1 filter that grew over C:
/// C comes back, the filter comes back, the user's earlier edit X is still
/// the next step on the stack, and Ctrl+Y has nothing to re-apply. It used to
/// pop X, restore nothing and leave C overwritten.
#[tokio::test]
async fn cancelling_a_level_one_overwrite_restores_the_cell_and_keeps_the_earlier_step() {
    let fx = Fx::new(0).await;
    let (pivot, c) = fx.shrunk_worksheet_pivot().await;
    fx.put_text(c, "V");
    let x = (40, 40);
    fx.user_edit(x, "X");
    let before = fx.undo_seqs();

    let response = fx.header_select(pivot, &["East", "North", "West"]).await;
    assert!(response.overwritten_cell_count >= 1, "fixture: the filter did not grow over C");
    let token = response.overwrite_token.expect("the response names its overwrite step");

    let (undone, complete) = fx.cancel_overwrite(&[token]).expect("the Cancel takes the step back");
    assert_eq!(undone.len(), 1, "the Cancel took back more or less than the one overwrite step");
    assert!(complete, "the Cancel reported a step it left behind");
    assert_eq!(fx.text_at(c).as_deref(), Some("V"), "the Cancel did not put the user's value back in C");
    assert_eq!(fx.hidden_on(pivot, "region"), Some(strings(&["North", "West"])), "the Cancel did not restore the East filter");
    assert_eq!(fx.undo_seqs(), before, "the Cancel disturbed the steps below its own (X must be next)");
    assert_eq!(fx.text_at(x).as_deref(), Some("X"), "the Cancel undid the user's earlier edit");
    assert_eq!(fx.redo_depth(), 0, "a declined change was left on the redo stack for Ctrl+Y to re-apply");

    // X is still undoable, as the step it always was.
    fx.undo_once();
    assert_eq!(fx.text_at(x), None, "X's step no longer undoes X");
}

/// A Cancel whose step is NOT on top -- anything landed after it, or the
/// command recorded no step at all -- is REFUSED and pops nothing.
#[tokio::test]
async fn a_cancel_whose_step_is_not_on_top_refuses_and_pops_nothing() {
    let fx = Fx::new(0).await;
    let (pivot, c) = fx.shrunk_worksheet_pivot().await;
    fx.put_text(c, "V");
    let response = fx.header_select(pivot, &["East", "North", "West"]).await;
    let token = response.overwrite_token.expect("fixture: an overwrite step");
    // Something unrelated lands on top of it.
    let y = (41, 41);
    fx.user_edit(y, "Y");
    let seqs = fx.undo_seqs();
    let redo = fx.redo_depth();

    let err = fx.cancel_overwrite(&[token]).expect_err("a Cancel under an unrelated step must refuse");
    assert_eq!(err, crate::pivot::commands::OVERWRITE_STEP_NOT_ON_TOP);
    assert_eq!(fx.undo_seqs(), seqs, "a refused Cancel changed the undo stack");
    assert_eq!(fx.redo_depth(), redo, "a refused Cancel changed the redo stack");
    assert_eq!(fx.text_at(y).as_deref(), Some("Y"), "a refused Cancel undid the unrelated edit");

    // No token at all -- the command recorded no step -- takes nothing either.
    let err = fx.cancel_overwrite(&[]).expect_err("a Cancel with no step must refuse");
    assert_eq!(err, crate::pivot::commands::NO_OVERWRITE_STEP);
    assert_eq!(fx.undo_seqs(), seqs, "a Cancel with no step popped something");

    // A token no step on the stack carries (a stale one) is refused too.
    let err = fx.cancel_overwrite(&[token + 1_000_000]).expect_err("a stale token must refuse");
    assert_eq!(err, crate::pivot::commands::OVERWRITE_STEP_NOT_ON_TOP);
    assert_eq!(fx.undo_seqs(), seqs, "a stale-token Cancel popped something");
}

/// The Slicer's reconcile re-applies a selection an undo just restored. It
/// must record NOTHING, even when its apply grows the pivot over cells: a
/// step recorded after an undo wipes the redo stack.
#[tokio::test]
async fn the_reconcile_re_apply_records_nothing_even_when_it_overwrites() {
    let fx = Fx::new(0).await;
    let (pivot, c) = fx.shrunk_worksheet_pivot().await;
    fx.put_text(c, "V");
    fx.user_edit((40, 40), "X");
    fx.undo_once(); // something to redo
    let seqs = fx.undo_seqs();
    assert_eq!(fx.redo_depth(), 1, "fixture: one step to redo");

    let mut request = apply(pivot, "Sales.region", &["East", "North", "West"]);
    request.reconcile = true;
    let response = apply_pivot_filter_core(&fx.ctx(), request).await.expect("the reconcile applies");
    assert!(response.overwritten_cell_count >= 1, "fixture: the re-apply grew over C");
    assert_eq!(fx.undo_seqs(), seqs, "the reconcile's re-apply recorded an undo step");
    assert_eq!(fx.redo_depth(), 1, "the reconcile's re-apply wiped the redo stack");
    assert_eq!(response.overwrite_token, None, "the reconcile's response names a step it did not record");

    // The CLEAR side of the reconcile, too.
    fx.click(pivot, "Sales.region", &["East"]).await;
    fx.put_text(c, "V");
    let seqs = fx.undo_seqs();
    let mut clear = Fx::clear_request(pivot, "Sales.region");
    clear.reconcile = true;
    let cleared = clear_pivot_filter_core(&fx.ctx(), clear).await.expect("the reconcile clears");
    assert!(cleared.overwritten_cell_count >= 1, "fixture: the re-clear grew over C");
    assert_eq!(fx.undo_seqs(), seqs, "the reconcile's re-clear recorded an undo step");
    assert_eq!(fx.redo_depth(), 1, "the reconcile's re-clear wiped the redo stack");
}

/// A level-1 CLEAR that grows the pivot over C records the same one step as
/// an apply, and its Cancel takes back exactly it.
#[tokio::test]
async fn a_level_one_clear_that_overwrites_is_one_step_and_its_cancel_restores_the_cell() {
    let fx = Fx::new(0).await;
    let (pivot, c) = fx.shrunk_worksheet_pivot().await;
    fx.put_text(c, "V");
    let seqs = fx.undo_seqs();

    let cleared = clear_pivot_filter_core(&fx.ctx(), Fx::clear_request(pivot, "Sales.region")).await.unwrap();
    assert!(cleared.overwritten_cell_count >= 1, "fixture: the clear grew over C");
    assert_eq!(fx.undo_seqs().len(), seqs.len() + 1, "the clear that overwrote C recorded no step");
    let token = cleared.overwrite_token.expect("the clear names its overwrite step");

    fx.cancel_overwrite(&[token]).expect("the Cancel takes the clear back");
    assert_eq!(fx.text_at(c).as_deref(), Some("V"), "the Cancel did not put C back");
    assert_eq!(fx.hidden_on(pivot, "region"), Some(strings(&["North", "West"])), "the Cancel did not restore the filter");
    assert_eq!(fx.undo_seqs(), seqs, "the Cancel disturbed the steps below its own");
}

/// A SLICER CLICK that grows the pivot over C: the overwrite step JOINS the
/// click's transaction -- ONE step with the slicer's own record -- so Ctrl+Z
/// brings back the slicer's selection AND the cell, and the click's Cancel
/// (by its token, once committed) takes back exactly that whole step.
#[tokio::test]
async fn a_slicer_click_that_overwrites_is_one_step_with_the_slicers_own_record() {
    let fx = Fx::new(0).await;
    let (pivot, c) = fx.shrunk_worksheet_pivot().await;
    let slicer = fx.model_slicer(0, "Sales.region", Some(vec!["East"]));
    fx.put_text(c, "V");
    let seqs = fx.undo_seqs();

    let click = |fx: &Fx| {
        fx.begin("Slicer Selection");
        fx.select(slicer, Some(&["East", "North", "West"]));
    };
    click(&fx);
    let mut request = apply(pivot, "Sales.region", &["East", "North", "West"]);
    request.slicer_id = Some(slicer.to_string());
    let response = apply_pivot_filter_core(&fx.ctx(), request).await.unwrap();
    fx.commit();
    assert!(response.overwritten_cell_count >= 1, "fixture: the click grew over C");
    assert_eq!(fx.undo_seqs().len(), seqs.len() + 1, "the click is not ONE step");
    {
        let stack = fx.state.undo_stack.lock().unwrap();
        assert_eq!(stack.undo_description(), Some("Slicer Selection"), "the overwrite did not join the click's step");
    }

    fx.undo_once();
    assert_eq!(fx.text_at(c).as_deref(), Some("V"), "Ctrl+Z of the click did not put C back");
    assert_eq!(fx.selected(slicer), Some(strings(&["East"])), "Ctrl+Z of the click did not restore the slicer");
    assert_eq!(fx.undo_seqs(), seqs, "Ctrl+Z of the click took back more than the click");

    // The same click again, declined: the Cancel takes back the WHOLE click.
    fx.put_text(c, "V");
    click(&fx);
    let mut request = apply(pivot, "Sales.region", &["East", "North", "West"]);
    request.slicer_id = Some(slicer.to_string());
    let response = apply_pivot_filter_core(&fx.ctx(), request).await.unwrap();
    fx.commit();
    let token = response.overwrite_token.expect("the click's apply names its overwrite step");
    fx.cancel_overwrite(&[token]).expect("the click's Cancel");
    assert_eq!(fx.text_at(c).as_deref(), Some("V"), "the click's Cancel did not put C back");
    assert_eq!(fx.selected(slicer), Some(strings(&["East"])), "the click's Cancel left the slicer on the declined selection");
    assert_eq!(fx.undo_seqs(), seqs, "the click's Cancel took back more than the click");
    assert_eq!(fx.redo_depth(), 0, "the declined click was left for Ctrl+Y");
}

/// Undo, redo, undo of an overwriting filter: the second undo must still put
/// C back. The restore's inverse carried no cells ("captured when redo runs"
/// -- it was not), so after a redo the next undo had nothing to restore.
#[tokio::test]
async fn undo_redo_undo_of_an_overwriting_filter_still_restores_the_cell() {
    let fx = Fx::new(0).await;
    let (pivot, c) = fx.shrunk_worksheet_pivot().await;
    fx.put_text(c, "V");
    fx.click(pivot, "Sales.region", &["East", "North", "West"]).await;
    assert_ne!(fx.text_at(c).as_deref(), Some("V"), "fixture: C overwritten");

    fx.undo_once();
    assert_eq!(fx.text_at(c).as_deref(), Some("V"), "fixture: the undo restores C");
    fx.redo_once();
    assert_ne!(fx.text_at(c).as_deref(), Some("V"), "the redo did not grow the pivot over C again");
    fx.undo_once();
    assert_eq!(fx.text_at(c).as_deref(), Some("V"), "undo after a redo did not put C back");
}

/// A PINNED (level 2) apply re-queries; when the re-query grows the pivot over
/// C, its one pre-state step carries C and its token, so the Cancel restores C
/// and the previous pin.
#[tokio::test]
async fn a_pinned_apply_that_overwrites_is_restorable_and_its_cancel_is_recognised() {
    let fx = Fx::new(0).await;
    let pivot = fx.add_bi_pivot(0).await;
    fx.lay_out(pivot, &["region"], &[]).await;
    let full = crate::pivot::operations::get_pivot_region(&fx.state, pivot).unwrap();
    let slicer = fx.model_slicer(0, "Sales.region", Some(vec!["East"]));
    fx.set_level(slicer, 2);
    fx.pinned_click(pivot, slicer, &["East"]).await;
    let small = crate::pivot::operations::get_pivot_region(&fx.state, pivot).unwrap();
    assert!(small.end_row < full.end_row, "fixture: the East pin did not shrink the pivot");
    let c = (full.end_row, full.start_col);
    fx.put_text(c, "V");
    let seqs = fx.undo_seqs();

    // The click: the slicer's selection and the pinned apply, one step (the
    // re-query folds the page's model slicers in, so the selection goes first).
    fx.begin("Slicer Selection");
    fx.select(slicer, Some(&["East", "North", "West"]));
    let mut request = apply(pivot, "Sales.region", &["East", "North", "West"]);
    request.filter_level = 2;
    request.slicer_id = Some(slicer.to_string());
    let response = apply_pivot_filter_core(&fx.ctx(), request).await.unwrap();
    fx.commit();
    assert!(response.overwritten_cell_count >= 1, "fixture: the pinned re-query grew over C");
    assert_eq!(fx.undo_seqs().len(), seqs.len() + 1, "the pinned click is not ONE step");
    let token = response.overwrite_token.expect("the pinned apply names its overwrite step");

    fx.cancel_overwrite(&[token]).expect("the pinned Cancel");
    assert_eq!(fx.text_at(c).as_deref(), Some("V"), "the pinned Cancel did not put C back");
    assert_eq!(fx.region_pin(pivot), Some(strings(&["East"])), "the pinned Cancel did not restore the East pin");
    assert_eq!(fx.selected(slicer), Some(strings(&["East"])), "the pinned Cancel did not restore the slicer");
    assert_eq!(fx.undo_seqs(), seqs, "the pinned Cancel disturbed the steps below its own");
}

/// A gesture that recorded its overwrite steps SEPARATELY (applies with no
/// transaction around them) is taken back step by step, while each next step
/// carries one of its tokens -- and it STOPS there: the step beneath them (a
/// user's edit, or any step of another caller's) carries none, so it stays,
/// and nothing can name it by its history id (wave E, Y1).
#[tokio::test]
async fn a_cancel_walks_back_every_step_of_its_gesture_and_stops_at_the_first_step_not_its_own() {
    let fx = Fx::new(0).await;
    let (a, ca) = fx.shrunk_worksheet_pivot().await;
    let (b, cb) = fx.shrunk_worksheet_pivot().await;
    fx.put_text(ca, "VA");
    fx.put_text(cb, "VB");
    fx.user_edit((40, 40), "X");
    // A step beneath the pivots' that is not the gesture's.
    fx.user_edit((41, 41), "S");
    let beneath = fx.undo_seqs();

    let ra = apply_pivot_filter_core(&fx.ctx(), apply(a, "Sales.region", &["East", "North", "West"])).await.unwrap();
    let rb = apply_pivot_filter_core(&fx.ctx(), apply(b, "Sales.region", &["East", "North", "West"])).await.unwrap();
    let tokens = [ra.overwrite_token.expect("A's step"), rb.overwrite_token.expect("B's step")];

    let (undone, complete) = fx.cancel_overwrite(&tokens).expect("the Cancel");
    assert_eq!(undone.len(), 2, "the Cancel did not take back exactly both pivot steps");
    assert!(complete, "the Cancel reported a step it left");
    assert_eq!(fx.text_at(ca).as_deref(), Some("VA"), "A's cell is not back");
    assert_eq!(fx.text_at(cb).as_deref(), Some("VB"), "B's cell is not back");
    assert_eq!(fx.text_at((41, 41)).as_deref(), Some("S"), "the Cancel took back the step beneath its own");
    assert_eq!(fx.undo_seqs(), beneath, "the Cancel went past its own steps");
    assert_eq!(fx.text_at((40, 40)).as_deref(), Some("X"), "the Cancel undid the user's earlier edit");
}

/// Deleting a slicer takes its filter off (owner decision 3) in its quiet
/// clears. When that grows a WORKSHEET pivot over C, the delete's ONE step
/// must carry C: undoing the delete brought the slicer and its filter back
/// and left C overwritten.
#[tokio::test]
async fn undoing_a_slicer_delete_whose_clear_overwrote_a_cell_restores_it() {
    let fx = Fx::new(0).await;
    let (pivot, c) = fx.shrunk_worksheet_pivot().await;
    let slicer = fx.model_slicer(0, "Sales.region", Some(vec!["East"]));
    fx.put_text(c, "V");
    let seqs = fx.undo_seqs();

    delete_slicer_core(&fx.ctx(), slicer).await.expect("the delete");
    assert_ne!(fx.text_at(c).as_deref(), Some("V"), "fixture: the delete's clear did not grow over C");
    assert_eq!(fx.undo_seqs().len(), seqs.len() + 1, "fixture: the delete is not one step");

    fx.undo_once();
    assert_eq!(fx.text_at(c).as_deref(), Some("V"), "undoing the delete did not put C back");
    assert!(fx.slicer.slicers.read().unwrap().contains_key(&slicer), "fixture: the slicer is back");
    assert_eq!(fx.hidden_on(pivot, "region"), Some(strings(&["North", "West"])), "fixture: the filter is back");
}

/// A CANVAS pivot's hidden grid holds only output: a filter that grows it
/// counts nothing, records nothing and names no step -- even over a cell of
/// that hidden grid that holds a value (stale output; nobody typed it).
#[tokio::test]
async fn a_canvas_pivot_filter_never_counts_or_records_an_overwrite() {
    let fx = Fx::new(1).await;
    let pivot = fx.add_bi_pivot(1).await;
    fx.lay_out(pivot, &["region"], &[]).await;
    let full = crate::pivot::operations::get_pivot_region(&fx.state, pivot).expect("fixture: a region");
    fx.click(pivot, "Sales.region", &["East"]).await;
    {
        // A value where the unfiltered layout reaches (the canvas is sheet 1,
        // not the active sheet, so only its stored grid holds it).
        let seed = test_seed_effect();
        let mut grids = fx.state.grids.write(&seed).unwrap();
        grids[1].set_cell(full.end_row, full.start_col, engine::Cell::new_text("stale".to_string()));
    }
    let seqs = fx.undo_seqs();
    let response = apply_pivot_filter_core(&fx.ctx(), apply(pivot, "Sales.region", &["East", "North", "West"]))
        .await
        .unwrap();
    assert_eq!(response.overwritten_cell_count, 0, "a canvas pivot counted overwritten cells");
    assert_eq!(response.overwrite_token, None, "a canvas pivot named an overwrite step");
    assert_eq!(fx.undo_seqs(), seqs, "a canvas filter recorded a step");
}

// ============================================================================
// WAVE B (A1, A2): the BLANK item. Blank cells are not interned values, so the
// level-1 mask rule and the item lists were built from the non-empty values
// alone: selecting "East" kept every blank-member row, and a pivot field's
// filter could neither show nor hide `(blank)`.
// ============================================================================

/// Sales with one NULL region (the blank member), cache-warm.
async fn fx_with_a_blank_region() -> Fx {
    let batch = RecordBatch::try_new(
        Arc::new(Schema::new(vec![
            Field::new("region", ArrowType::Utf8, true),
            Field::new("year", ArrowType::Utf8, true),
            Field::new("amount", ArrowType::Float64, true),
        ])),
        vec![
            Arc::new(StringArray::from(vec![Some("East"), Some("West"), None, Some("North")])),
            Arc::new(StringArray::from(vec!["Y1", "Y1", "Y2", "Y2"])),
            Arc::new(Float64Array::from(vec![10.0, 20.0, 30.0, 40.0])),
        ],
    )
    .unwrap();
    Fx::with_model(0, sales_model(), vec![("Sales", "sales", batch)], &[("Sales", "region")]).await
}

/// A1. The level-1 mask hides the blank item unless the selection names it
/// (`(blank)` in any case, or the empty string a model spells NULL with) --
/// and only when the list the selection was made from OFFERED it: a selection
/// from a list without the blank item never hides it (the review of A1).
#[test]
fn a_level_one_selection_hides_the_blank_item_unless_it_names_it() {
    let batch = RecordBatch::try_new(
        Arc::new(Schema::new(vec![Field::new("region", ArrowType::Utf8, true)])),
        vec![Arc::new(StringArray::from(vec![Some("East"), None, Some("West")]))],
    )
    .unwrap();
    let mut cache = crate::pivot::operations::build_cache_from_arrow_batches(new_id(), &[batch]).unwrap();
    assert!(cache.has_blank_values(0), "fixture: the column has a blank record");
    let hide = |cache: &mut pivot_engine::PivotCache, selected: &[&str]| {
        sorted(crate::pivot::commands::hidden_for_selection(cache, 0, &strings(selected), true))
    };
    assert_eq!(hide(&mut cache, &["East"]), strings(&["(blank)", "West"]), "selecting East kept the blank rows");
    assert_eq!(hide(&mut cache, &["East", "(Blank)"]), strings(&["West"]), "a selection naming (Blank) hid it");
    assert_eq!(hide(&mut cache, &["East", ""]), strings(&["West"]), "a model's NULL spelling did not name the blank item");
    assert_eq!(
        sorted(crate::pivot::commands::hidden_for_selection(&mut cache, 0, &strings(&["East"]), false)),
        strings(&["West"]),
        "a selection from a list that never offered the blank item hid it"
    );
}

/// A1, end to end: a PIVOT slicer's level-1 click on "East" hides the
/// blank-member rows of the pivot it filters -- its list offers the blank
/// item, so a selection that does not name it means "not the blanks". (A
/// MODEL list offers it too since W6: see
/// `a_model_slicers_selection_hides_the_blank_rows_unless_it_names_the_blank`.)
#[tokio::test]
async fn a_level_one_click_hides_the_blank_member_rows() {
    let fx = fx_with_a_blank_region().await;
    let pivot = fx.add_bi_pivot(0).await;
    fx.lay_out(pivot, &["region"], &[]).await;
    let slicer = fx.pivot_slicer(pivot, "Sales.region");
    fx.slicer_click(slicer, pivot, "Sales.region", &["East"]).await;
    let hidden = fx.hidden_on(pivot, "region").expect("the region field carries the mask");
    assert!(
        hidden.iter().any(|h| pivot_engine::is_blank_item_label(h)),
        "selecting East kept the blank-member rows: hidden = {hidden:?}"
    );
}

/// A2. A pivot field's item lists show the blank item LAST: the field
/// dropdown's (`get_pivot_field_unique_values`) and a filter-zone cell's, and
/// the filter cell reads a hidden `(Blank)` as the blank item unselected.
#[tokio::test]
async fn a_pivot_fields_item_lists_include_the_blank_item() {
    let fx = fx_with_a_blank_region().await;
    let pivot = fx.add_bi_pivot(0).await;
    let region = |hidden: Option<Vec<String>>| BiFieldRef {
        table: "Sales".into(),
        column: "region".into(),
        is_lookup: false,
        hidden_items: hidden,
    };
    let request = |hidden: Option<Vec<String>>| UpdateBiPivotFieldsRequest {
        pivot_id: pivot,
        row_fields: vec![BiFieldRef { table: "Sales".into(), column: "year".into(), is_lookup: false, hidden_items: None }],
        column_fields: vec![],
        value_fields: vec![BiValueFieldRef { measure_name: "Revenue".into(), custom_name: None }],
        filter_fields: vec![region(hidden)],
        slicer_fields: None,
        row_hierarchies: vec![],
        column_hierarchies: vec![],
        layout: None,
        lookup_columns: vec![],
        calculated_fields: None,
        value_column_order: None,
        force_requery: false,
    };
    let response = update_bi_pivot_fields_core(&fx.ctx(), request(None)).await.expect("lay the pivot out");
    let filter_row = response.filter_rows.first().expect("the region filter cell");
    assert_eq!(filter_row.unique_values.last().map(String::as_str), Some("(blank)"), "{:?}", filter_row.unique_values);

    let idx = filter_row.field_index;
    let listed = crate::pivot::commands::pivot_field_unique_values_core(&fx.pivots, pivot, idx).expect("the list");
    assert_eq!(listed.unique_values.last().map(String::as_str), Some("(blank)"), "{:?}", listed.unique_values);

    let response = update_bi_pivot_fields_core(&fx.ctx(), request(Some(strings(&["(Blank)"])))).await.expect("hide it");
    let filter_row = response.filter_rows.first().expect("the region filter cell");
    assert!(
        !filter_row.selected_values.iter().any(|v| pivot_engine::is_blank_item_label(v)),
        "a hidden (Blank) still reads as selected: {:?}",
        filter_row.selected_values
    );
    assert_eq!(filter_row.selected_values.len(), 3, "{:?}", filter_row.selected_values);
}

/// A3 (the BUG-0184 class on BI pivots). A field-list edit rebuilds every
/// field from `PivotField::new` over the NEW cache: a sort, a subtotal
/// setting, show-all-items or a grouping the user put on a field was reset by
/// the next edit of the layout -- also when the field moved to another zone.
#[tokio::test]
async fn a_bi_field_list_edit_keeps_each_fields_own_settings() {
    let fx = Fx::new(0).await;
    let pivot = fx.add_bi_pivot(0).await;
    fx.lay_out(pivot, &["region", "year"], &[]).await;
    let grouping = pivot_engine::FieldGrouping::ManualGrouping {
        groups: vec![pivot_engine::ManualGroup { name: "EastWest".into(), members: strings(&["East", "West"]) }],
        ungrouped_name: "Other".into(),
    };
    {
        // What sort / subtotal / show-all / grouping commands leave on the field.
        let mut tables = fx.pivots.pivot_tables.write(&test_seed_effect()).unwrap();
        let def = &mut tables.get_mut(&pivot).unwrap().0;
        let region = def.row_fields.iter_mut().find(|f| f.name == "Sales.region").unwrap();
        region.sort_order = pivot_engine::SortOrder::Descending;
        region.show_subtotals = false;
        region.show_all_items = true;
        region.grouping = grouping.clone();
    }
    let json = |g: &pivot_engine::FieldGrouping| serde_json::to_value(g).unwrap();
    let region_of = |fx: &Fx| {
        let def = fx.definition(pivot);
        def.row_fields
            .iter()
            .chain(def.column_fields.iter())
            .find(|f| f.name == "Sales.region")
            .cloned()
            .expect("the region field")
    };

    // An edit of the layout: another field on Columns.
    fx.lay_out(pivot, &["region"], &["year"]).await;
    let region = region_of(&fx);
    assert_eq!(region.sort_order, pivot_engine::SortOrder::Descending, "the edit reset the field's sort");
    assert!(!region.show_subtotals, "the edit reset the field's subtotals");
    assert!(region.show_all_items, "the edit reset show-all-items");
    assert_eq!(json(&region.grouping), json(&grouping), "the edit dropped the field's grouping");

    // The field dragged to Columns is the same field: its settings go with it.
    fx.lay_out(pivot, &["year"], &["region"]).await;
    let region = region_of(&fx);
    assert_eq!(region.sort_order, pivot_engine::SortOrder::Descending, "the move to Columns reset the sort");
    assert_eq!(json(&region.grouping), json(&grouping), "the move to Columns dropped the grouping");
}

// ============================================================================
// WAVE B (S1, BUG-0187; S2, BUG-0200): a slicer click / ribbon filter change
// is ONE backend command that records ONE step at the end -- no undo
// transaction is held open across its model re-query -- and the backend knows
// when a step absorbed ANOTHER caller's begin.
// ============================================================================

use crate::pivot::types::{
    FilterGestureStep, FilterGestureStepOutcome, PivotFilterGesture, PivotFilterGestureResponse, PivotFilterWrite,
};

impl Fx {
    /// A slicer CLICK through the one backend command: the selection plus an
    /// apply of `selected` on `pivot` by the slicer's model column.
    async fn gesture_click(
        &self,
        slicer: EntityId,
        pivot: EntityId,
        selected: &[&str],
        step: FilterGestureStep,
    ) -> PivotFilterGestureResponse {
        let mut request = apply(pivot, "Sales.region", selected);
        request.slicer_id = Some(slicer.to_string());
        let gesture = PivotFilterGesture { writes: vec![PivotFilterWrite { apply: Some(request), clear: None }], step };
        crate::slicer::commands::apply_slicer_selection_core(&self.ctx(), slicer, Some(strings(selected)), gesture)
            .await
            .expect("the click")
            .gesture
    }

    /// The Tauri `begin_undo_transaction` door (a script's `beginBatch`, the
    /// frontend's own transaction): true when it OPENED the transaction.
    fn begin_from_caller(&self, description: &str) -> bool {
        self.state.undo_stack.lock().unwrap().begin_transaction_from_caller(description)
    }

    fn transaction_open(&self) -> bool {
        self.state.undo_stack.lock().unwrap().has_open_transaction()
    }
}

/// S1 (BUG-0187). A MODEL slicer click whose pivot lacks the column (so the
/// apply re-queries the model) holds NO undo transaction open while it waits
/// on the engine, and an unrelated edit made meanwhile is a step of its OWN:
/// Ctrl+Z takes back the click alone, and the edit stays. The click used to
/// be a frontend transaction around the re-query -- the edit joined it and
/// one Ctrl+Z undid both.
#[tokio::test]
async fn a_slicer_click_holds_no_transaction_open_across_its_requery_and_an_edit_made_meanwhile_is_its_own_step() {
    let fx = Fx::new(1).await;
    let pivot = fx.add_bi_pivot(1).await;
    fx.lay_out(pivot, &["year"], &[]).await;
    let slicer = fx.model_slicer(1, "Sales.region", None);
    let depth = fx.undo_depth();

    let engine_arc = fx.bi.connections.lock().unwrap()[&fx.conn].engine.clone().unwrap();
    let busy = engine_arc.lock().await; // the engine is busy with someone else's query
    let mut request = apply(pivot, "Sales.region", &["East"]);
    request.slicer_id = Some(slicer.to_string());
    let gesture = PivotFilterGesture {
        writes: vec![PivotFilterWrite { apply: Some(request), clear: None }],
        step: FilterGestureStep::Own,
    };
    let ctx = fx.ctx();
    let mut click = Box::pin(crate::slicer::commands::apply_slicer_selection_core(
        &ctx,
        slicer,
        Some(strings(&["East"])),
        gesture,
    ));
    let waited = tokio::time::timeout(std::time::Duration::from_millis(150), &mut click).await;
    assert!(waited.is_err(), "fixture: the click must be waiting on the engine");
    assert!(!fx.transaction_open(), "the click held the global undo transaction open across a BI await");
    fx.user_edit((40, 40), "X"); // an unrelated edit, made while the click waits
    drop(busy);
    let response = click.await.expect("the click").gesture;
    assert_eq!(response.step, FilterGestureStepOutcome::Pushed, "the click is not a step of its own");
    assert!(response.failures.is_empty(), "the click's apply refused: {:?}", response.failures);
    assert_eq!(fx.undo_depth(), depth + 2, "the edit and the click are not two separate steps");
    assert_eq!(fx.hidden_on(pivot, "region"), Some(strings(&["North", "West"])), "fixture: the click filtered");

    fx.undo_once();
    assert_eq!(fx.selected(slicer), None, "Ctrl+Z did not take the click's selection back");
    assert_eq!(fx.hidden_on(pivot, "region"), None, "Ctrl+Z did not take back the column the click added");
    assert_eq!(fx.text_at((40, 40)).as_deref(), Some("X"), "Ctrl+Z of the click took the unrelated edit back too");
    fx.undo_once();
    assert_eq!(fx.text_at((40, 40)), None, "the edit is not a step of its own");
}

/// S1. A click that grows a worksheet pivot over the user's cell C: ONE step
/// (the slicer's selection AND the cells), and its Cancel -- by the token the
/// response names -- takes back the WHOLE click and nothing else.
#[tokio::test]
async fn a_click_that_overwrites_is_one_step_and_its_cancel_takes_back_exactly_it() {
    let fx = Fx::new(0).await;
    let (pivot, c) = fx.shrunk_worksheet_pivot().await;
    let slicer = fx.model_slicer(0, "Sales.region", Some(vec!["East"]));
    fx.put_text(c, "V");
    fx.user_edit((40, 40), "X");
    let seqs = fx.undo_seqs();

    let response = fx.gesture_click(slicer, pivot, &["East", "North", "West"], FilterGestureStep::Own).await;
    assert_ne!(fx.text_at(c).as_deref(), Some("V"), "fixture: the click did not grow over C");
    assert_eq!(fx.undo_seqs().len(), seqs.len() + 1, "the click is not ONE step");
    assert_eq!(response.step_seq, fx.undo_seqs().last().copied(), "the response does not name the click's step");
    let token = response.overwrite_token.expect("the click names its overwrite step");
    assert!(
        response.responses.iter().any(|r| r.overwrite_token == Some(token)),
        "the pivot response that overwrote C does not carry the click's token"
    );

    fx.cancel_overwrite(&[token]).expect("the click's Cancel");
    assert_eq!(fx.text_at(c).as_deref(), Some("V"), "the Cancel did not put C back");
    assert_eq!(fx.selected(slicer), Some(strings(&["East"])), "the Cancel left the declined selection");
    assert_eq!(fx.undo_seqs(), seqs, "the Cancel took back more (or less) than the click");
    assert_eq!(fx.text_at((40, 40)).as_deref(), Some("X"), "the Cancel undid the earlier edit");
}

/// S2 (BUG-0200). A user click made while a SCRIPT BATCH is open that has
/// recorded NOTHING yet is a step of its OWN -- beneath the batch, which stays
/// open, untouched, and holds only what the script writes AFTER the click (so
/// the history stays in time order). While the batch is open the click's step
/// is on top, so its Cancel takes back the click alone; the script's writes
/// are never touched. (A batch that already HOLDS writes is joined instead:
/// `a_click_during_a_script_batch_that_already_wrote_joins_it_and_undoes_in_order`.)
#[tokio::test]
async fn a_click_made_during_a_script_batch_is_its_own_step_and_never_joins_the_batch() {
    let fx = Fx::new(0).await;
    let (pivot, c) = fx.shrunk_worksheet_pivot().await;
    let slicer = fx.model_slicer(0, "Sales.region", Some(vec!["East"]));
    fx.put_text(c, "V");
    let seqs = fx.undo_seqs();
    assert!(fx.begin_from_caller("Script batch"), "fixture: the script opens its batch");

    let response = fx.gesture_click(slicer, pivot, &["East", "North", "West"], FilterGestureStep::Own).await;
    assert_eq!(response.step, FilterGestureStepOutcome::Pushed, "the click joined the script's batch");
    assert!(fx.transaction_open(), "the click closed the script's batch");
    fx.user_edit((40, 40), "S"); // the script writes after the click
    let token = response.overwrite_token.expect("fixture: the click overwrote C");

    fx.cancel_overwrite(&[token]).expect("the click's Cancel");
    assert_eq!(fx.text_at(c).as_deref(), Some("V"), "the Cancel did not put C back");
    assert_eq!(fx.text_at((40, 40)).as_deref(), Some("S"), "the Cancel took the script's write back");
    assert!(fx.transaction_open(), "the Cancel disturbed the script's open batch");

    fx.commit(); // the script commits its batch: ONE step holding S only
    assert_eq!(fx.undo_seqs().len(), seqs.len() + 1, "the script's batch is not one step of its own");
    fx.undo_once();
    assert_eq!(fx.text_at((40, 40)), None, "the script's step does not hold S");
    assert_eq!(fx.selected(slicer), Some(strings(&["East"])), "the script's step held the click");
}

/// S2 (BUG-0200). The mirror image: a script's `beginBatch` arrives while a
/// FRONTEND gesture's step is open (a Slicer Settings save). The backend has
/// one slot, so the script's write joins the step -- but the step now says
/// so, and the gesture's Cancel REFUSES to take it back (it would take the
/// script's write back too) and pops nothing. The positive control: the same
/// gesture with no script is taken back.
#[tokio::test]
async fn a_cancel_refuses_a_step_that_absorbed_a_script_batch() {
    let fx = Fx::new(0).await;
    let (pivot, c) = fx.shrunk_worksheet_pivot().await;
    fx.put_text(c, "V");
    let seqs = fx.undo_seqs();

    let gesture = |fx: &Fx| fx.begin_from_caller("Slicer Settings");
    assert!(gesture(&fx), "fixture: the gesture opens its step");
    let response = apply_pivot_filter_core(&fx.ctx(), apply(pivot, "Sales.region", &["East", "North", "West"]))
        .await
        .expect("the apply");
    assert!(!fx.begin_from_caller("Script batch"), "fixture: the script's begin joins");
    fx.user_edit((40, 40), "S");
    fx.commit();
    let token = response.overwrite_token.expect("fixture: an overwrite step");
    let after = fx.undo_seqs();

    let err = fx.cancel_overwrite(&[token]).expect_err("a Cancel of a step holding a script's write must refuse");
    assert_eq!(err, crate::pivot::commands::OVERWRITE_STEP_SHARED);
    assert_eq!(fx.undo_seqs(), after, "a refused Cancel changed the undo stack");
    assert_eq!(fx.text_at((40, 40)).as_deref(), Some("S"), "the Cancel took the script's write back");

    // Positive control: the same gesture with no script is taken back.
    fx.undo_once();
    assert_eq!(fx.undo_seqs(), seqs, "fixture: back to the start");
    fx.put_text(c, "V");
    assert!(gesture(&fx));
    let response = apply_pivot_filter_core(&fx.ctx(), apply(pivot, "Sales.region", &["East", "North", "West"]))
        .await
        .expect("the apply");
    fx.commit();
    let token = response.overwrite_token.expect("an overwrite step");
    fx.cancel_overwrite(&[token]).expect("an unshared step is taken back");
    assert_eq!(fx.text_at(c).as_deref(), Some("V"));
}

/// A4. A canvas-wide Delete that removes a pivot box with a chart and a slicer
/// is ONE step: `delete_pivot_table` joins an open transaction and never
/// commits one it did not open (its unconditional begin/commit pair committed
/// the caller's transaction half-way). A Tauri command with nine `State`
/// handles cannot run in process, so the rule is read from its body.
#[test]
fn deleting_a_pivot_never_commits_a_transaction_it_did_not_open() {
    let src = include_str!("../pivot/commands.rs").replace("\r\n", "\n");
    let at = src.find("pub fn delete_pivot_table(").expect("the delete command");
    let body = &src[at..at + src[at..].find("\n}\n").expect("its body")];
    let commit = body.find("commit_transaction()").expect("the delete records a step");
    let guard = body[..commit]
        .rfind("if opened {")
        .expect("delete_pivot_table commits a transaction it did not open");
    assert!(
        body[guard..commit].lines().count() <= 2,
        "the commit is not the one `if opened` guards:\n{}",
        &body[guard..commit]
    );
    assert!(body.contains("let opened = !undo_stack.has_open_transaction();"), "the delete no longer asks whether a transaction is open");
}

/// S2. The Tauri `begin_undo_transaction` door is the one that MARKS: every
/// frontend begin goes through it, and a command's internal begin must not.
#[test]
fn the_tauri_begin_door_marks_a_joined_transaction() {
    let src = include_str!("../undo_commands.rs");
    let at = src.find("pub fn begin_undo_transaction(").expect("the Tauri begin command");
    let body = &src[at..at + src[at..].find("\n}").expect("its body")];
    assert!(
        body.contains("begin_transaction_from_caller("),
        "the Tauri begin no longer marks a transaction another caller joined:\n{body}"
    );
}

/// S2. A script's OWN slicer call (inside the batch it opened) JOINS the
/// batch: ONE step for the script, the selection and the pivot.
#[tokio::test]
async fn a_scripts_slicer_call_joins_the_batch_it_opened() {
    let fx = Fx::new(0).await;
    let (pivot, _c) = fx.shrunk_worksheet_pivot().await;
    let slicer = fx.model_slicer(0, "Sales.region", Some(vec!["East"]));
    let depth = fx.undo_depth();
    assert!(fx.begin_from_caller("Script batch"));
    fx.user_edit((40, 40), "S");
    let response = fx.gesture_click(slicer, pivot, &["West"], FilterGestureStep::Join).await;
    assert_eq!(response.step, FilterGestureStepOutcome::Joined, "the script's call did not join its batch");
    assert_eq!(response.step_seq, None);
    fx.commit();
    assert_eq!(fx.undo_depth(), depth + 1, "the script's batch is not ONE step");
    fx.undo_once();
    assert_eq!(fx.selected(slicer), Some(strings(&["East"])), "the batch's step does not hold the selection");
    assert_eq!(fx.text_at((40, 40)), None, "the batch's step does not hold the script's write");
}

/// W2 (wave C; wb-slicer needs 3). A table slicer's click on `slicer`
/// selecting `selected`, the way the frontend sends it: no pivot writes (a
/// table slicer reaches no pivot), the backend filters the table itself.
async fn table_click(
    fx: &Fx,
    slicer: EntityId,
    selected: Option<&[&str]>,
    step: FilterGestureStep,
) -> crate::slicer::types::SlicerSelectionGestureResponse {
    let gesture = PivotFilterGesture { writes: vec![], step };
    crate::slicer::commands::apply_slicer_selection_core(&fx.ctx(), slicer, selected.map(strings), gesture)
        .await
        .expect("the table slicer's click")
}

/// W2. A click whose TABLE targets used to be filtered by the FRONTEND after
/// the command held its step open for them (a mode since removed): every edit
/// the user made in that window joined the click's Ctrl+Z step. The backend now
/// filters the table in the SAME command, so the step lands whole and nothing
/// is ever left open: ONE Ctrl+Z restores the selection AND the table's
/// filter, and Ctrl+Y puts both back.
#[tokio::test]
async fn a_table_slicer_click_filters_its_table_inside_its_one_step() {
    let fx = Fx::new(0).await;
    let (_table, slicer) = seed_filtered_table(&fx, Some(&["East"]));
    assert_eq!(table_filter_state(&fx), (true, vec![2, 4]), "precondition: filtered to East");
    let depth = fx.undo_depth();

    let response = table_click(&fx, slicer, Some(&["West"]), FilterGestureStep::Own).await;
    assert_eq!(response.gesture.step, FilterGestureStepOutcome::Pushed, "the click is not a step of its own");
    assert!(!fx.transaction_open(), "the click left a step open for writes that no longer exist");
    assert!(response.table_failures.is_empty(), "the table refused: {:?}", response.table_failures);
    assert_eq!(response.table_sheets, vec![0], "the response does not name the sheet whose rows moved");
    assert_eq!(table_filter_state(&fx), (true, vec![1, 3, 4]), "the table was not filtered to West");
    assert_eq!(fx.undo_depth(), depth + 1, "the selection and its table filter are not ONE step");

    fx.undo_once();
    assert_eq!(fx.selected(slicer), Some(strings(&["East"])), "Ctrl+Z did not take the selection back");
    assert_eq!(table_filter_state(&fx), (true, vec![2, 4]), "Ctrl+Z did not take the table's filter back");
    fx.redo_once();
    assert_eq!(fx.selected(slicer), Some(strings(&["West"])));
    assert_eq!(table_filter_state(&fx), (true, vec![1, 3, 4]), "Ctrl+Y did not put the table's filter back");

    // A CLEAR (Clear Filter / no selection) takes the column's criteria off,
    // in its own one step.
    let response = table_click(&fx, slicer, None, FilterGestureStep::Own).await;
    assert_eq!(response.gesture.step, FilterGestureStepOutcome::Pushed);
    assert_eq!(table_filter_state(&fx), (false, vec![]), "the clear left the table filtered");
    fx.undo_once();
    assert_eq!(table_filter_state(&fx), (true, vec![1, 3, 4]), "Ctrl+Z did not put the filter back");

    // The same selection again writes nothing and records nothing.
    let depth = fx.undo_depth();
    crate::document_effect::mark_saved(&fx.file);
    let response = table_click(&fx, slicer, Some(&["West"]), FilterGestureStep::Own).await;
    assert_eq!(
        response.gesture.step,
        FilterGestureStepOutcome::Nothing,
        "a click that changed nothing recorded a step (the unchanged table filter was rewritten)"
    );
    assert!(response.table_sheets.is_empty(), "an unchanged table filter was reported as moved");
    assert_eq!(fx.undo_depth(), depth, "a click that changed nothing recorded a step");
    assert!(!fx.file.is_dirty(), "a click that changed nothing dirtied the document");
}

/// W2. With a STRANGER's transaction open (a script's `beginBatch` that has
/// written nothing yet) the user's click is a step of its own beneath it --
/// tables included, since nothing follows the command any more -- and the
/// stranger's transaction stays open for its owner. One that already HOLDS
/// changes is joined (marked shared), so undoing replays in time order.
#[tokio::test]
async fn a_table_slicer_click_during_a_strangers_transaction_is_never_split_or_left_open() {
    let fx = Fx::new(0).await;
    let (_table, slicer) = seed_filtered_table(&fx, Some(&["East"]));
    let depth = fx.undo_depth();

    assert!(fx.begin_from_caller("Script batch"), "fixture: a stranger's empty transaction is open");
    let response = table_click(&fx, slicer, Some(&["West"]), FilterGestureStep::Own).await;
    assert_eq!(response.gesture.step, FilterGestureStepOutcome::Pushed, "the click joined an EMPTY stranger's step");
    assert!(fx.transaction_open(), "the stranger's transaction was closed by the click");
    assert_eq!(fx.undo_depth(), depth + 1, "the click is not ONE step of its own");
    let step = fx.state.undo_stack.lock().unwrap().pop_undo().expect("the click's step");
    let kinds = Fx::restore_kinds(&step);
    assert!(
        kinds.iter().any(|k| k == "slicer") && kinds.iter().any(|k| k == "obj_autofilter"),
        "the click's selection and its table filter are not in one step: {kinds:?}"
    );
    fx.commit(); // the stranger's (still empty) batch

    // A stranger's transaction that already holds a write is JOINED, marked.
    assert!(fx.begin_from_caller("Script batch"));
    fx.user_edit((40, 40), "S");
    let response = table_click(&fx, slicer, Some(&["North"]), FilterGestureStep::Own).await;
    assert_eq!(response.gesture.step, FilterGestureStepOutcome::Joined);
    assert!(fx.state.undo_stack.lock().unwrap().open_transaction_absorbed_begin(), "the joined step is not marked");
    fx.commit();
    let step = fx.state.undo_stack.lock().unwrap().pop_undo().expect("the joined step");
    assert!(
        Fx::restore_kinds(&step).iter().any(|k| k == "obj_autofilter"),
        "the table filter did not land in the step the click joined"
    );
}

/// W2. A SCRIPT's call joins the batch it opened -- tables included -- and
/// one Ctrl+Z of the batch restores the selection and the table filter.
#[tokio::test]
async fn a_scripts_table_slicer_call_joins_its_batch_with_the_table_filter() {
    let fx = Fx::new(0).await;
    let (_table, slicer) = seed_filtered_table(&fx, Some(&["East"]));
    let depth = fx.undo_depth();
    assert!(fx.begin_from_caller("Script batch"));
    let response = table_click(&fx, slicer, Some(&["West"]), FilterGestureStep::Join).await;
    assert_eq!(response.gesture.step, FilterGestureStepOutcome::Joined, "the script's call left its own batch");
    assert!(fx.transaction_open(), "the script's call closed its own batch");
    fx.commit();
    assert_eq!(fx.undo_depth(), depth + 1);
    fx.undo_once();
    assert_eq!(fx.selected(slicer), Some(strings(&["East"])));
    assert_eq!(table_filter_state(&fx), (true, vec![2, 4]), "the batch's step does not hold the table filter");
}

/// W2. A table that cannot take the filter is REPORTED (the frontend tells
/// the user once) and changes nothing; a CLEAR there is silent -- there is no
/// filter of this slicer's to take off.
#[tokio::test]
async fn a_table_that_cannot_take_the_slicer_filter_is_reported_and_left_alone() {
    let fx = Fx::new(0).await;
    let (_table, slicer) = seed_filtered_table(&fx, Some(&["East"]));
    // The sheet forbids AutoFilter use.
    fx.state.sheet_protection.write(&test_seed_effect()).unwrap().insert(
        0,
        crate::protection::SheetProtection { protected: true, ..Default::default() },
    );
    let response = table_click(&fx, slicer, Some(&["West"]), FilterGestureStep::Own).await;
    assert_eq!(response.table_failures.len(), 1, "the refusal was not reported");
    assert!(!response.table_failures[0].clearing);
    assert!(
        response.table_failures[0].message.contains("protected"),
        "the refusal does not say why: {}",
        response.table_failures[0].message
    );
    assert!(response.table_sheets.is_empty());
    assert_eq!(table_filter_state(&fx), (true, vec![2, 4]), "a refused table was filtered anyway");
    fx.state.sheet_protection.write(&test_seed_effect()).unwrap().clear();

    // The sheet's AutoFilter now belongs to ANOTHER table: an apply refuses
    // (never filters someone else's columns), a clear is silent.
    fx.state.auto_filters.write(&test_seed_effect()).unwrap().get_mut(&0).unwrap().id = new_id();
    let response = table_click(&fx, slicer, Some(&["North"]), FilterGestureStep::Own).await;
    assert_eq!(response.table_failures.len(), 1);
    assert!(response.table_failures[0].message.contains("another table"), "{:?}", response.table_failures);
    assert_eq!(table_filter_state(&fx), (true, vec![2, 4]), "another table's filter was changed");
    let response = table_click(&fx, slicer, None, FilterGestureStep::Own).await;
    assert!(response.table_failures.is_empty(), "a clear with nothing of this slicer's to take off was reported");
    assert_eq!(table_filter_state(&fx), (true, vec![2, 4]));
}

/// S1. A click that changes nothing (the same selection, a mask the pivot
/// already has) records nothing and leaves the document clean.
#[tokio::test]
async fn a_click_that_changes_nothing_records_nothing() {
    let fx = Fx::new(0).await;
    let (pivot, _c) = fx.shrunk_worksheet_pivot().await;
    let slicer = fx.model_slicer(0, "Sales.region", Some(vec!["East"]));
    let seqs = fx.undo_seqs();
    let response = fx.gesture_click(slicer, pivot, &["East"], FilterGestureStep::Own).await;
    assert_eq!(response.step, FilterGestureStepOutcome::Nothing, "a no-op click recorded a step");
    assert_eq!(fx.undo_seqs(), seqs);
}

/// S2 (BUG-0200, "verify"). The undo/redo RECONCILE re-applies a restored
/// selection; it must never ADD a column the pivot does not carry. An undo
/// that removed the column the step had added came back with it, re-queried
/// and unrecorded.
#[tokio::test]
async fn a_reconcile_apply_never_adds_a_column_the_pivot_does_not_carry() {
    let fx = Fx::new(1).await;
    let pivot = fx.add_bi_pivot(1).await;
    fx.lay_out(pivot, &["year"], &[]).await;
    let before = fx.cache_names(pivot);
    let seqs = fx.undo_seqs();
    let mut request = apply(pivot, "Sales.region", &["East"]);
    request.reconcile = true;
    apply_pivot_filter_core(&fx.ctx(), request).await.expect("a reconcile is a no-op, not an error");
    assert_eq!(fx.cache_names(pivot), before, "a reconcile re-queried the pivot to add a column");
    assert_eq!(fx.hidden_on(pivot, "region"), None, "a reconcile added a column");
    assert_eq!(fx.undo_seqs(), seqs);
    // A user apply still adds it (the ensure), as ONE step.
    fx.click(pivot, "Sales.region", &["East"]).await;
    assert_eq!(fx.hidden_on(pivot, "region"), Some(strings(&["North", "West"])));
}

/// S1 + S2 for the RIBBON filter: its change is ONE step -- the filter's
/// selection AND its pivots -- whose Cancel takes back both; and a ribbon
/// SETTINGS update inside an open transaction JOINS it instead of committing
/// it half-way.
#[tokio::test]
async fn a_ribbon_filter_change_is_one_step_and_its_settings_update_joins_an_open_transaction() {
    let fx = Fx::new(0).await;
    let (pivot, c) = fx.shrunk_worksheet_pivot().await;
    let filter_id = new_id();
    {
        let filter: crate::ribbon_filter::RibbonFilter = serde_json::from_value(serde_json::json!({
            "id": filter_id.to_string(),
            "name": "Region",
            "connectionId": fx.conn.to_string(),
            "fieldName": "Sales.region",
            "fieldDataType": "text",
            "connectionMode": "workbook",
            "connectedPivots": [],
            "connectedSheets": [],
            "displayMode": "checklist",
            "selectedItems": ["East"],
            "crossFilterTargets": [],
            "crossFilterSlicerTargets": [],
            "order": 0,
            "buttonColumns": 2,
            "buttonRows": 0,
            "filterLevel": 1
        }))
        .expect("a ribbon filter");
        fx.filters.filters.write(&test_seed_effect()).unwrap().insert(filter_id, filter);
    }
    fx.put_text(c, "V");
    let seqs = fx.undo_seqs();
    let request = apply(pivot, "Sales.region", &["East", "North", "West"]);
    let gesture = PivotFilterGesture {
        writes: vec![PivotFilterWrite { apply: Some(request), clear: None }],
        step: FilterGestureStep::Own,
    };
    let response = crate::ribbon_filter::commands::apply_ribbon_filter_selection_core(
        &fx.ctx(),
        filter_id,
        Some(strings(&["East", "North", "West"])),
        gesture,
    )
    .await
    .expect("the change");
    assert_eq!(fx.undo_seqs().len(), seqs.len() + 1, "the ribbon change is not ONE step");
    let token = response.overwrite_token.expect("the change overwrote C");
    fx.cancel_overwrite(&[token]).expect("the change's Cancel");
    assert_eq!(fx.text_at(c).as_deref(), Some("V"), "the Cancel did not put C back");
    let selection = fx.filters.filters.read().unwrap()[&filter_id].selected_items.clone();
    assert_eq!(selection, Some(strings(&["East"])), "the Cancel left the declined selection on the filter");
    assert_eq!(fx.undo_seqs(), seqs, "the Cancel took back more or less than the change");

    // The settings update joins an open transaction and does not commit it.
    fx.begin("Filter settings");
    crate::ribbon_filter::commands::update_ribbon_filter_core(
        &fx.state,
        &fx.file,
        &fx.filters,
        filter_id,
        serde_json::from_value(serde_json::json!({ "filterLevel": 2 })).unwrap(),
    )
    .expect("the settings update");
    assert!(fx.transaction_open(), "the ribbon settings update committed the caller's transaction");
    fx.commit();
    assert_eq!(fx.undo_seqs().len(), seqs.len() + 1, "the settings update is not in the caller's step");
}

// ============================================================================
// WAVE B FIX-UP (the review of WP-SLICER): the ORDER and OWNERSHIP of a
// gesture's one step, the blank item every level-1 list must OFFER before a
// selection may hide it, and the protection gate a canvas-wide Delete relies
// on.
// ============================================================================

impl Fx {
    /// A write recorded into whatever transaction is open, with the cell's
    /// previous text (what `update_cell` records).
    fn recorded_write(&self, cell: (u32, u32), text: &str, previous: &str) {
        self.put_text(cell, text);
        self.state
            .undo_stack
            .lock()
            .unwrap()
            .record_cell_change(0, cell.0, cell.1, Some(engine::Cell::new_text(previous.to_string())));
    }

    /// The kinds of the custom restores a step holds, in recording order.
    fn restore_kinds(step: &engine::Transaction) -> Vec<String> {
        step.changes
            .iter()
            .filter_map(|ch| match ch {
                engine::CellChange::CustomRestore { kind, .. } => Some(kind.clone()),
                _ => None,
            })
            .collect()
    }

    /// A PIVOT slicer on `field` of `pivot`: its items are the pivot's own
    /// cache values (`get_pivot_field_values`).
    fn pivot_slicer(&self, pivot: EntityId, field: &str) -> EntityId {
        let mut s = slicer_on(0, pivot, field, None);
        s.source_type = SlicerSourceType::Pivot;
        s.connected_sources = vec![SlicerConnection { source_type: SlicerSourceType::Pivot, source_id: pivot }];
        let id = s.id;
        self.slicer.slicers.write(&test_seed_effect()).unwrap().insert(id, s);
        id
    }

    /// The values a slicer lists, in its order.
    async fn slicer_values(&self, slicer: EntityId) -> Vec<String> {
        get_slicer_items_core(&self.state, &self.pivots, &self.slicer, &self.filters, &self.bi, slicer)
            .await
            .expect("the slicer's items")
            .into_iter()
            .map(|i| i.value)
            .collect()
    }

    /// A slicer's level-1 click on `pivot` as the frontend sends it: by the
    /// model key, naming the slicer.
    async fn slicer_click(&self, slicer: EntityId, pivot: EntityId, key: &str, selected: &[&str]) {
        let mut request = apply(pivot, key, selected);
        request.slicer_id = Some(slicer.to_string());
        apply_pivot_filter_core(&self.ctx(), request).await.expect("the slicer's click");
    }

    /// Protect sheet `sheet`, with `options` deciding what stays allowed.
    fn protect_sheet(&self, sheet: usize, options: impl FnOnce(&mut crate::protection::SheetProtectionOptions)) {
        let mut p = crate::protection::SheetProtection::default();
        p.protected = true;
        options(&mut p.options);
        self.state.sheet_protection.write(&test_seed_effect()).unwrap().insert(sheet, p);
    }
}

/// R1 (review of S1/S2). A user click made while a script batch is open that
/// has ALREADY recorded a change JOINS the batch (marked as shared) instead of
/// being pushed BENEATH it. Beneath it, the older batch landed ON TOP of the
/// newer click: undoing both wrote the batch's pre-state into the pivot's
/// output first and then the click's saved cells over it, so C came back as
/// the script's value instead of the user's. Joined, the reverse replay runs
/// in time order and one Ctrl+Z brings C back to what it held before either.
#[tokio::test]
async fn a_click_during_a_script_batch_that_already_wrote_joins_it_and_undoes_in_order() {
    let fx = Fx::new(0).await;
    let (pivot, c) = fx.shrunk_worksheet_pivot().await;
    let slicer = fx.model_slicer(0, "Sales.region", Some(vec!["East"]));
    fx.put_text(c, "V");
    let seqs = fx.undo_seqs();
    assert!(fx.begin_from_caller("Script batch"), "fixture: the script opens its batch");
    fx.recorded_write(c, "S", "V"); // the script writes C before the click

    let response = fx.gesture_click(slicer, pivot, &["East", "North", "West"], FilterGestureStep::Own).await;
    assert_ne!(fx.text_at(c).as_deref(), Some("S"), "fixture: the click grew over C");
    assert_eq!(
        response.step,
        FilterGestureStepOutcome::Joined,
        "the click was pushed BENEATH a batch that had already written"
    );
    assert!(
        fx.state.undo_stack.lock().unwrap().open_transaction_absorbed_begin(),
        "the joined batch does not say it holds a user's click too"
    );
    fx.commit(); // the script commits its batch
    assert_eq!(fx.undo_seqs().len(), seqs.len() + 1, "the batch and the click are not ONE step");
    fx.undo_once();
    assert_eq!(
        fx.text_at(c).as_deref(),
        Some("V"),
        "undoing the batch and the click did not bring C back to its value before either"
    );
    assert_eq!(fx.selected(slicer), Some(strings(&["East"])), "the Ctrl+Z did not take the click's selection back");
}

/// R4 (review of S2). A script's slicer call is sent "join" and joins WHATEVER
/// is open -- here a USER gesture's frontend step (a Slicer Settings save that
/// grew a pivot over C). The join now MARKS the step, so the user's Cancel
/// refuses to take it back (it would take the script's selection back too) and
/// pops nothing; Ctrl+Z still takes both back together.
#[tokio::test]
async fn a_scripts_call_that_joins_a_users_open_step_marks_it_and_the_users_cancel_refuses() {
    let fx = Fx::new(0).await;
    let (pivot, c) = fx.shrunk_worksheet_pivot().await;
    let slicer = fx.model_slicer(0, "Sales.region", Some(vec!["East"]));
    fx.put_text(c, "V");
    assert!(fx.begin_from_caller("Slicer Settings"), "fixture: the user's save opens its step");
    let response = apply_pivot_filter_core(&fx.ctx(), apply(pivot, "Sales.region", &["East", "North", "West"]))
        .await
        .expect("the save's apply");
    let token = response.overwrite_token.expect("fixture: the save overwrote C");
    // Meanwhile a script sets the slicer's selection: its call joins.
    let gesture = PivotFilterGesture { writes: vec![], step: FilterGestureStep::Join };
    let joined = crate::slicer::commands::apply_slicer_selection_core(&fx.ctx(), slicer, Some(strings(&["West"])), gesture)
        .await
        .expect("the script's call")
        .gesture;
    assert_eq!(joined.step, FilterGestureStepOutcome::Joined, "fixture: the script's call joined");
    fx.commit(); // the user's save commits
    let after = fx.undo_seqs();

    let cancel = fx.cancel_overwrite(&[token]);
    assert_eq!(
        cancel.as_ref().err().map(String::as_str),
        Some(crate::pivot::commands::OVERWRITE_STEP_SHARED),
        "the user's Cancel took back a step a script's call had joined"
    );
    assert_eq!(fx.selected(slicer), Some(strings(&["West"])), "the Cancel took the script's selection back");
    assert_eq!(fx.undo_seqs(), after, "a refused Cancel changed the history");
}

/// R3 (review of A4). A canvas-wide Delete relies on each family REFUSING
/// what a protected sheet forbids -- a chart's delete refuses, a control's
/// does -- and a slicer's did not: moving it was refused, deleting it was
/// not. Refused BEFORE the document is marked changed.
#[tokio::test]
async fn deleting_a_slicer_on_a_sheet_protected_against_object_edits_is_refused_and_clean() {
    let fx = Fx::new(0).await;
    let slicer = fx.model_slicer(0, "Sales.region", Some(vec!["East"]));
    fx.protect_sheet(0, |o| o.allow_edit_objects = false);
    crate::document_effect::mark_saved(&fx.file);
    assert!(
        crate::slicer::commands::update_slicer_position_core(&fx.state, &fx.file, &fx.slicer, slicer, 5.0, 5.0, 100.0, 100.0)
            .is_err(),
        "fixture: a move on the protected sheet is refused"
    );
    let err = delete_slicer_core(&fx.ctx(), slicer)
        .await
        .expect_err("a slicer on a sheet protected against object edits was deleted");
    assert!(err.contains("protected"), "the refusal does not say why: {err}");
    assert!(fx.slicer.slicers.read().unwrap().contains_key(&slicer), "the refused delete removed the slicer");
    assert!(!fx.file.is_dirty(), "a refused delete dirtied the document");

    // Positive control: with object edits allowed it deletes.
    fx.protect_sheet(0, |o| o.allow_edit_objects = true);
    delete_slicer_core(&fx.ctx(), slicer).await.expect("an allowed delete");
    assert!(!fx.slicer.slicers.read().unwrap().contains_key(&slicer));
}

/// R6 (review of A1). The level-1 mask hides the blank member unless the
/// selection NAMES it, so every list a selection is made from must OFFER the
/// blank item. A pivot slicer lists it (last): deselecting ONE item from
/// "all" keeps the blank rows, and selecting one item alone still hides them.
#[tokio::test]
async fn a_pivot_slicer_lists_the_blank_item_and_deselecting_one_item_keeps_the_blank_rows() {
    let fx = fx_with_a_blank_region().await;
    let pivot = fx.add_bi_pivot(0).await;
    fx.lay_out(pivot, &["region"], &[]).await;
    let slicer = fx.pivot_slicer(pivot, "Sales.region");
    let values = fx.slicer_values(slicer).await;
    assert_eq!(
        values.last().map(String::as_str),
        Some(pivot_engine::BLANK_ITEM_LABEL),
        "the pivot slicer does not offer the blank item: {values:?}"
    );
    // Ctrl+click West from "all": every listed item but West.
    let next: Vec<&str> = values.iter().map(String::as_str).filter(|v| *v != "West").collect();
    fx.slicer_click(slicer, pivot, "Sales.region", &next).await;
    assert_eq!(
        fx.hidden_on(pivot, "region"),
        Some(strings(&["West"])),
        "deselecting West alone hid the blank rows too"
    );
    // A plain click on East: the blank rows go (A1).
    fx.slicer_click(slicer, pivot, "Sales.region", &["East"]).await;
    assert_eq!(
        fx.hidden_on(pivot, "region"),
        Some(strings(&["(blank)", "North", "West"])),
        "selecting East alone kept the blank rows"
    );
}

/// R6, a sibling: a pivot slicer that selects the blank item keeps the
/// records whose value is blank, and the other slicer's "has data" follows
/// them (a blank record never matched a sibling's selection before).
#[tokio::test]
async fn a_sibling_slicer_selecting_the_blank_item_keeps_its_records_available() {
    let fx = fx_with_a_blank_region().await;
    let pivot = fx.add_bi_pivot(0).await;
    fx.lay_out(pivot, &["region", "year"], &[]).await;
    let region = fx.pivot_slicer(pivot, "Sales.region");
    let year = fx.pivot_slicer(pivot, "Sales.year");
    fx.slicer.slicers.write(&test_seed_effect()).unwrap().get_mut(&region).unwrap().selected_items =
        Some(strings(&["(blank)"]));
    let items = get_slicer_items_core(&fx.state, &fx.pivots, &fx.slicer, &fx.filters, &fx.bi, year).await.unwrap();
    let with_data: Vec<&str> = items.iter().filter(|i| i.has_data).map(|i| i.value.as_str()).collect();
    assert_eq!(with_data, vec!["Y2"], "the blank-region record's year is not available: {items:?}");
}

/// R6, the MODEL lists -- after W6 (wave C): a model slicer's (and a ribbon
/// filter's) items come from the model's value list, which now OFFERS the
/// blank (NULL) member as `(blank)`, last (`MODEL_VALUE_LISTS_NAME_THE_BLANK`
/// flipped with it). A selection made from such a list says whether the blank
/// rows show: naming `(blank)` keeps them, leaving it out hides them -- through
/// the click AND through the page fold of every later re-query. (Before W6 the
/// list could not offer it, so such a selection had to leave the blank rows
/// showing; this test pinned that and failed the moment W6 landed.)
#[tokio::test]
async fn a_model_slicers_selection_hides_the_blank_rows_unless_it_names_the_blank() {
    let fx = fx_with_a_blank_region().await;
    let pivot = fx.add_bi_pivot(0).await;
    fx.lay_out(pivot, &["region"], &[]).await;
    let slicer = fx.model_slicer(0, "Sales.region", None);
    let values = fx.slicer_values(slicer).await;
    assert!(
        values.last().is_some_and(|v| pivot_engine::is_blank_item_label(v)),
        "the model slicer's list does not offer the blank member last: {values:?}"
    );
    let blank_hidden = |hidden: &Option<Vec<String>>| {
        hidden.as_ref().is_some_and(|h| h.iter().any(|v| pivot_engine::is_blank_item_label(v)))
    };
    let named_hidden = |hidden: &Option<Vec<String>>| -> Vec<String> {
        hidden
            .clone()
            .unwrap_or_default()
            .into_iter()
            .filter(|v| !pivot_engine::is_blank_item_label(v))
            .collect()
    };

    // Deselect West from the list: `(blank)` stays selected, its rows stay.
    let next: Vec<&str> = values.iter().map(String::as_str).filter(|v| *v != "West").collect();
    fx.slicer_click(slicer, pivot, "Sales.region", &next).await;
    let hidden = fx.hidden_on(pivot, "region");
    assert_eq!(named_hidden(&hidden), strings(&["West"]), "deselecting West hid more than West: {hidden:?}");
    assert!(!blank_hidden(&hidden), "a selection that names (blank) hid the blank rows: {hidden:?}");

    // A ribbon filter's write (a model key, no slicer) lists from the model
    // too: East alone hides the blank rows.
    fx.click(pivot, "Sales.region", &["East"]).await;
    let hidden = fx.hidden_on(pivot, "region");
    assert_eq!(named_hidden(&hidden), strings(&["North", "West"]));
    assert!(blank_hidden(&hidden), "a ribbon filter's East kept the blank rows its list offered: {hidden:?}");

    // The page fold of a re-query folds the model slicer by the same rule.
    fx.select(slicer, Some(&["East"]));
    fx.lay_out(pivot, &["region"], &["year"]).await;
    let hidden = fx.hidden_on(pivot, "region");
    assert_eq!(named_hidden(&hidden), strings(&["North", "West"]));
    assert!(
        blank_hidden(&hidden),
        "the page fold of a re-query kept the blank rows the model slicer's East left out: {hidden:?}"
    );
}

impl Fx {
    /// Ctrl+Z as the `undo` command decides it: refused while a gesture that
    /// pushes its step when it lands is in flight (`history_move_refusal`,
    /// asked under the pop's lock), otherwise one step. True when it undid.
    fn ctrl_z(&self) -> bool {
        let transaction = {
            let mut stack = self.state.undo_stack.lock().unwrap();
            if crate::undo_commands::history_move_refusal(&stack).is_some() {
                return false;
            }
            match stack.pop_undo() {
                Some(t) => t,
                None => return false,
            }
        };
        crate::undo_commands::apply_changes(
            &self.state, &self.file, &self.files, &self.pivots, &self.slicer, &self.filters, &self.pane,
            &self.timelines, transaction, true,
        );
        true
    }

    /// Whether an undo or a redo would be refused right now.
    fn history_move_refused(&self) -> bool {
        crate::undo_commands::history_move_refusal(&self.state.undo_stack.lock().unwrap()).is_some()
    }

    /// A workbook-mode ribbon filter on Sales.region of this connection.
    fn ribbon_filter(&self, selected: Option<&[&str]>) -> EntityId {
        let filter_id = new_id();
        let filter: crate::ribbon_filter::RibbonFilter = serde_json::from_value(serde_json::json!({
            "id": filter_id.to_string(),
            "name": "Region",
            "connectionId": self.conn.to_string(),
            "fieldName": "Sales.region",
            "fieldDataType": "text",
            "connectionMode": "workbook",
            "connectedPivots": [],
            "connectedSheets": [],
            "displayMode": "checklist",
            "selectedItems": selected.map(strings),
            "crossFilterTargets": [],
            "crossFilterSlicerTargets": [],
            "order": 0,
            "buttonColumns": 2,
            "buttonRows": 0,
            "filterLevel": 1
        }))
        .expect("a ribbon filter");
        self.filters.filters.write(&test_seed_effect()).unwrap().insert(filter_id, filter);
        filter_id
    }

    fn ribbon_selection(&self, filter_id: EntityId) -> Option<Vec<String>> {
        self.filters.filters.read().unwrap()[&filter_id].selected_items.clone()
    }
}

/// R7 + R2 (review of S1; BUG-0187's second symptom). A Ctrl+Z pressed while a
/// click waits on the engine is REFUSED -- the history stays whole -- and once
/// the click lands, Ctrl+Z takes back THE CLICK (Excel's order: the click came
/// first) and Ctrl+Y can put it back. It used to take back the step BEFORE the
/// click: the slicer went back to "all" under the click's new selection, the
/// click's pivot writes landed with West anyway (slicer and pivot disagreed),
/// and the click's push then cleared that Ctrl+Z's redo.
#[tokio::test]
async fn a_ctrl_z_while_a_click_waits_on_the_engine_is_refused_and_the_history_stays_whole() {
    let fx = Fx::new(1).await;
    let pivot = fx.add_bi_pivot(1).await;
    fx.lay_out(pivot, &["year"], &[]).await;
    let slicer = fx.model_slicer(1, "Sales.region", None);
    let first = fx.gesture_click(slicer, pivot, &["East"], FilterGestureStep::Own).await;
    assert_eq!(first.step, FilterGestureStepOutcome::Pushed, "fixture: click 1 is a step");
    let depth = fx.undo_depth();

    let engine_arc = fx.bi.connections.lock().unwrap()[&fx.conn].engine.clone().unwrap();
    let busy = engine_arc.lock().await; // the engine is busy with someone else's query
    let mut request = apply(pivot, "Sales.region", &["West"]);
    request.slicer_id = Some(slicer.to_string());
    let gesture = PivotFilterGesture { writes: vec![PivotFilterWrite { apply: Some(request), clear: None }], step: FilterGestureStep::Own };
    let ctx = fx.ctx();
    let mut click = Box::pin(crate::slicer::commands::apply_slicer_selection_core(
        &ctx,
        slicer,
        Some(strings(&["West"])),
        gesture,
    ));
    let waited = tokio::time::timeout(std::time::Duration::from_millis(150), &mut click).await;
    assert!(waited.is_err(), "fixture: click 2 must be waiting on the engine");
    assert!(!fx.ctrl_z(), "a Ctrl+Z pressed mid-click took back the step BEFORE the click");
    assert!(fx.history_move_refused(), "a Ctrl+Y pressed mid-click would move the history under the click");
    assert_eq!(fx.undo_depth(), depth, "the refused Ctrl+Z changed the history");
    drop(busy);
    let second = click.await.expect("click 2").gesture;
    assert_eq!(second.step, FilterGestureStepOutcome::Pushed, "click 2 is not a step of its own");
    assert!(!fx.history_move_refused(), "the click landed and still reads as in flight");
    assert_eq!(fx.selected(slicer), Some(strings(&["West"])), "the slicer does not select what its pivot shows");
    assert_eq!(fx.hidden_on(pivot, "region"), Some(strings(&["East", "North"])), "the pivot does not show the slicer's West");

    assert!(fx.ctrl_z(), "Ctrl+Z after the click landed was refused");
    assert_eq!(fx.selected(slicer), Some(strings(&["East"])), "Ctrl+Z did not take back the click that landed");
    assert_eq!(fx.redo_depth(), 1, "undoing the click left nothing to redo");
    fx.redo_once();
    assert_eq!(fx.selected(slicer), Some(strings(&["West"])), "Ctrl+Y did not put the click back");
}

/// The review of S1, the other two gestures that push their step when they
/// land: a ribbon filter change waiting on its model re-query, and a slicer
/// delete waiting on its pinned clear, each refuse an undo or redo meanwhile.
#[tokio::test]
async fn a_ribbon_change_and_a_slicer_delete_refuse_a_history_move_while_they_wait_on_the_engine() {
    let fx = Fx::new(1).await;
    let pivot = fx.add_bi_pivot(1).await;
    fx.lay_out(pivot, &["year"], &[]).await;
    let filter_id = fx.ribbon_filter(None);
    let engine_arc = fx.bi.connections.lock().unwrap()[&fx.conn].engine.clone().unwrap();
    {
        let busy = engine_arc.lock().await;
        let gesture = PivotFilterGesture {
            writes: vec![PivotFilterWrite { apply: Some(apply(pivot, "Sales.region", &["East"])), clear: None }],
            step: FilterGestureStep::Own,
        };
        let ctx = fx.ctx();
        let mut change = Box::pin(crate::ribbon_filter::commands::apply_ribbon_filter_selection_core(
            &ctx,
            filter_id,
            Some(strings(&["East"])),
            gesture,
        ));
        let waited = tokio::time::timeout(std::time::Duration::from_millis(150), &mut change).await;
        assert!(waited.is_err(), "fixture: the ribbon change must be waiting on the engine");
        assert!(fx.history_move_refused(), "an undo was allowed while a ribbon change waited on the engine");
        drop(busy);
        change.await.expect("the ribbon change");
    }
    assert!(!fx.history_move_refused(), "the ribbon change landed and still reads as in flight");

    // A PINNED slicer: its delete's clear re-queries.
    let slicer = fx.model_slicer(1, "Sales.region", Some(vec!["East"]));
    fx.set_level(slicer, 2);
    fx.pinned_click(pivot, slicer, &["East"]).await;
    let busy = engine_arc.lock().await;
    let ctx = fx.ctx();
    let mut delete = Box::pin(delete_slicer_core(&ctx, slicer));
    let waited = tokio::time::timeout(std::time::Duration::from_millis(150), &mut delete).await;
    assert!(waited.is_err(), "fixture: the delete must be waiting on the engine");
    assert!(fx.history_move_refused(), "an undo was allowed while a slicer delete waited on the engine");
    drop(busy);
    delete.await.expect("the delete");
    assert!(!fx.history_move_refused(), "the delete landed and still reads as in flight");
}

/// W4 (wave C; wb-slicer new 9). A SINGLE pivot filter command that records
/// at its END -- an ensure, a pin, a pinned clear -- waits on the engine for
/// as long as the model takes, and was invisible to the in-flight count: a
/// Ctrl+Z pressed meanwhile took back the step BEFORE it, the command's own
/// step then landed on top (clearing that undo's redo), and the slicer or
/// header dropdown that drove the filter disagreed with the pivot. Counted
/// now like a slicer click. A RECONCILE (the re-apply right after an undo)
/// records nothing and must never refuse the next Ctrl+Z.
#[tokio::test]
async fn a_single_pivot_filter_command_waiting_on_the_engine_refuses_a_history_move() {
    let fx = Fx::new(1).await;
    let pivot = fx.add_bi_pivot(1).await;
    fx.lay_out(pivot, &["year"], &[]).await;
    let slicer = fx.model_slicer(1, "Sales.region", Some(vec!["East"]));
    let engine_arc = fx.bi.connections.lock().unwrap()[&fx.conn].engine.clone().unwrap();
    let wait = std::time::Duration::from_millis(150);

    // 1. An ENSURE: the pivot does not carry region yet, so the apply adds it
    //    (a re-query) and pushes its step when it lands.
    let depth = fx.undo_depth();
    {
        let busy = engine_arc.lock().await;
        let ctx = fx.ctx();
        let mut ensure = Box::pin(apply_pivot_filter_core(&ctx, apply(pivot, "Sales.region", &["East"])));
        assert!(tokio::time::timeout(wait, &mut ensure).await.is_err(), "fixture: the ensure must wait on the engine");
        assert!(fx.history_move_refused(), "an undo was allowed while an ensure waited on the engine");
        assert!(!fx.ctrl_z(), "a Ctrl+Z pressed mid-ensure took back the step BEFORE it");
        drop(busy);
        ensure.await.expect("the ensure");
    }
    assert!(!fx.history_move_refused(), "the ensure landed and still reads as in flight");
    assert_eq!(fx.undo_depth(), depth + 1, "fixture: the ensure records one step");

    // 2. A PIN: routed inside the engine query, re-queried, recorded at the end.
    {
        let busy = engine_arc.lock().await;
        let mut request = apply(pivot, "Sales.region", &["East"]);
        request.filter_level = 2;
        request.slicer_id = Some(slicer.to_string());
        let ctx = fx.ctx();
        let mut pin = Box::pin(apply_pivot_filter_core(&ctx, request));
        assert!(tokio::time::timeout(wait, &mut pin).await.is_err(), "fixture: the pin must wait on the engine");
        assert!(fx.history_move_refused(), "an undo was allowed while a pin waited on the engine");
        drop(busy);
        pin.await.expect("the pin");
    }
    assert!(!fx.history_move_refused(), "the pin landed and still reads as in flight");

    // 3. A pinned CLEAR: dropping the pin re-queries too.
    {
        let busy = engine_arc.lock().await;
        let request = ClearPivotFilterRequest {
            pivot_id: pivot,
            field_index: None,
            bi_field_key: Some("Sales.region".to_string()),
            filter_type: None,
            reconcile: false,
        };
        let ctx = fx.ctx();
        let mut clear = Box::pin(clear_pivot_filter_core(&ctx, request));
        assert!(tokio::time::timeout(wait, &mut clear).await.is_err(), "fixture: the clear must wait on the engine");
        assert!(fx.history_move_refused(), "an undo was allowed while a pinned clear waited on the engine");
        drop(busy);
        clear.await.expect("the clear");
    }
    assert!(!fx.history_move_refused(), "the clear landed and still reads as in flight");

    // 4. A RECONCILE records nothing: never counted, even while it waits.
    {
        let busy = engine_arc.lock().await;
        let mut request = apply(pivot, "Sales.region", &["West"]);
        request.reconcile = true;
        let ctx = fx.ctx();
        let mut reconcile = Box::pin(apply_pivot_filter_core(&ctx, request));
        assert!(tokio::time::timeout(wait, &mut reconcile).await.is_err(), "fixture: the reconcile must wait on the engine");
        assert!(
            !fx.history_move_refused(),
            "a reconcile (the re-apply right after an undo) refused the user's next Ctrl+Z"
        );
        drop(busy);
        reconcile.await.expect("the reconcile");
    }

    // Once everything landed, Ctrl+Z takes back the last step and Ctrl+Y can
    // put it back: nothing cleared the redo underneath.
    assert!(fx.ctrl_z(), "Ctrl+Z after the commands landed was refused");
    assert_eq!(fx.redo_depth(), 1, "undoing the clear left nothing to redo");
}

/// The `undo` and `redo` COMMANDS ask the refusal, under the lock their pop
/// takes, before they pop. (They need a `tauri::AppHandle` and eight `State`
/// handles, so the wiring is read from their bodies; the rule itself is
/// exercised by `a_ctrl_z_while_a_click_waits_on_the_engine_...`.)
#[test]
fn the_undo_and_redo_commands_refuse_while_a_gesture_lands() {
    let src = include_str!("../undo_commands.rs").replace("\r\n", "\n");
    for (name, pop) in [("pub fn undo(", "undo_stack.pop_undo()"), ("pub fn redo(", "undo_stack.pop_redo()")] {
        let at = src.find(name).expect("the command");
        let body = &src[at..at + src[at..].find("\n}\n").expect("its body")];
        let lock = body.find("state.undo_stack.lock()").expect("the pop's lock");
        let ask = body
            .find("history_move_refusal(&undo_stack)")
            .unwrap_or_else(|| panic!("`{name}` never asks whether a gesture is landing"));
        let popped = body.find(pop).expect("the pop");
        assert!(lock < ask && ask < popped, "`{name}` does not ask under its pop's lock, before the pop");
    }
}

/// R3 (review of A4), the PIVOT box. A worksheet pivot on a sheet protected
/// against PivotTable changes, and a pivot box on a canvas protected against
/// object edits, refuse their delete -- before anything is written.
#[tokio::test]
async fn deleting_a_pivot_on_a_sheet_protected_against_it_is_refused() {
    let fx = Fx::new(1).await;
    let on_sheet = fx.add_bi_pivot(0).await;
    let on_canvas = fx.add_bi_pivot(1).await;
    let gate = |fx: &Fx, pivot| crate::pivot::commands::refuse_a_protected_pivot_delete(&fx.state, &fx.pivots, pivot);
    assert!(gate(&fx, on_sheet).is_ok() && gate(&fx, on_canvas).is_ok(), "fixture: unprotected sheets refuse nothing");

    fx.protect_sheet(0, |o| o.allow_pivot_tables = false);
    let err = gate(&fx, on_sheet).expect_err("a pivot on a sheet protected against PivotTable changes may be deleted");
    assert!(err.contains("protected"), "the refusal does not say why: {err}");
    fx.protect_sheet(0, |o| o.allow_pivot_tables = true);
    assert!(gate(&fx, on_sheet).is_ok(), "allowing PivotTable changes still refused the delete");

    fx.protect_sheet(1, |o| {
        o.allow_edit_objects = false;
        o.allow_pivot_tables = true;
    });
    assert!(gate(&fx, on_canvas).is_err(), "a pivot BOX on a canvas protected against object edits may be deleted");
    fx.protect_sheet(1, |o| {
        o.allow_edit_objects = true;
        o.allow_pivot_tables = false;
    });
    assert!(gate(&fx, on_canvas).is_ok(), "a canvas box's delete is an object edit, not a PivotTable change");
    assert!(gate(&fx, new_id()).is_ok(), "an unknown pivot is the existence check's to refuse");
}

/// The delete COMMAND asks the gate before it mints its effect (a refused
/// delete leaves the document clean). It needs nine `State` handles, so the
/// order is read from its body.
#[test]
fn the_pivot_delete_command_asks_the_protection_gate_before_anything_is_written() {
    let src = include_str!("../pivot/commands.rs").replace("\r\n", "\n");
    let at = src.find("pub fn delete_pivot_table(").expect("the delete command");
    let body = &src[at..at + src[at..].find("\n}\n").expect("its body")];
    let gate = body.find("refuse_a_protected_pivot_delete(").expect("delete_pivot_table never asks the protection gate");
    let effect = body.find("pivot_exists_token(").expect("the effect");
    assert!(gate < effect, "delete_pivot_table mints its effect before the protection gate");
}

/// The review of A1: the mask rule's model-list flag
/// (`MODEL_VALUE_LISTS_NAME_THE_BLANK`) agrees with what the model's value
/// list -- the one model slicers and ribbon filters list -- actually offers.
/// When that list starts offering the blank (NULL) member, this fails until
/// the flag is flipped, and model selections may hide the blank rows again.
#[tokio::test]
async fn model_value_lists_name_the_blank_exactly_when_the_mask_rule_says_so() {
    let fx = fx_with_a_blank_region().await;
    let values = crate::bi::commands::bi_get_column_values_core(&fx.bi, fx.conn, "Sales", "region")
        .await
        .expect("the model's values");
    let offers = values.iter().any(|v| v.is_empty() || pivot_engine::is_blank_item_label(v));
    assert_eq!(
        offers,
        crate::pivot::commands::MODEL_VALUE_LISTS_NAME_THE_BLANK,
        "the model's value list {} the blank member but the mask rule says it {}: {values:?}",
        if offers { "offers" } else { "does not offer" },
        if offers { "does not" } else { "does" }
    );
}

/// The review of A2: the header dropdown's CHECKED set (`get_pivot_field_info`)
/// lists the blank item too -- last, visible unless a hidden item names it (in
/// any spelling), and in the manual filter's selection when visible. It showed
/// `(blank)` UNCHECKED while its rows were visible, and any OK then hid them.
#[tokio::test]
async fn a_pivot_fields_info_lists_the_blank_item_and_reads_its_visibility() {
    let fx = fx_with_a_blank_region().await;
    let pivot = fx.add_bi_pivot(0).await;
    fx.lay_out(pivot, &["region"], &[]).await;
    let idx = fx.row_field_index(pivot);
    let blank_of = |info: &crate::pivot::types::PivotFieldInfo| {
        info.items.last().filter(|i| pivot_engine::is_blank_item_label(&i.name)).map(|i| i.visible)
    };
    let info = crate::pivot::commands::pivot_field_info_core(&fx.pivots, pivot, idx).expect("the info");
    assert_eq!(blank_of(&info), Some(true), "the blank item is not listed last as visible: {:?}", info.items);

    // Everything but West (the blank item included), from the header's own list.
    fx.header_select(pivot, &["East", "North", "(blank)"]).await;
    assert_eq!(fx.hidden_on(pivot, "region"), Some(strings(&["West"])), "fixture: only West is hidden");
    let info = crate::pivot::commands::pivot_field_info_core(&fx.pivots, pivot, idx).expect("the info");
    assert_eq!(blank_of(&info), Some(true), "(blank) reads UNCHECKED although its rows are visible");
    let selected = info.filters.manual_filter.expect("a filtered field").selected_items;
    assert!(
        selected.iter().any(|s| pivot_engine::is_blank_item_label(s)) && !selected.iter().any(|s| s == "West"),
        "the selection the dropdown starts from would hide the blank rows on OK: {selected:?}"
    );

    // Hidden by another spelling of its label.
    {
        let mut tables = fx.pivots.pivot_tables.write(&test_seed_effect()).unwrap();
        let def = &mut tables.get_mut(&pivot).unwrap().0;
        def.row_fields.iter_mut().find(|f| f.source_index == idx).unwrap().hidden_items = strings(&["(Blank)"]);
    }
    let info = crate::pivot::commands::pivot_field_info_core(&fx.pivots, pivot, idx).expect("the info");
    assert_eq!(blank_of(&info), Some(false), "a hidden (Blank) reads as visible");
}

/// The review of S2: a ribbon item toggle DECIDES from the stored selection
/// under the same hold of the store that writes it -- it read under one lock
/// and wrote under another, so a concurrent change in between was lost. The
/// toggles themselves: on appends, off removes, empty clears; each a step.
#[tokio::test]
async fn a_ribbon_item_toggle_decides_and_writes_under_one_hold_of_the_store() {
    let src = include_str!("../ribbon_filter/commands.rs").replace("\r\n", "\n");
    let at = src.find("pub(crate) fn set_ribbon_filter_item_selected_core(").expect("the toggle's core");
    let body = &src[at..at + src[at..].find("\n}\n").expect("its body")];
    assert!(
        body.contains("write_ribbon_filter_selection_with(") && !body.contains(".read()"),
        "the toggle reads the store outside the hold that writes it:\n{body}"
    );
    let cmd_at = src.find("pub fn set_ribbon_filter_item_selected(").expect("the command");
    let cmd = &src[cmd_at..cmd_at + src[cmd_at..].find("\n}\n").expect("its body")];
    assert!(cmd.contains("set_ribbon_filter_item_selected_core("), "the command does not run the core");

    let fx = Fx::new(0).await;
    let filter_id = fx.ribbon_filter(Some(&["East"]));
    let depth = fx.undo_depth();
    let toggle = |value: &str, selected: bool| {
        crate::ribbon_filter::commands::set_ribbon_filter_item_selected_core(
            &fx.state,
            &fx.file,
            &fx.filters,
            filter_id,
            value.to_string(),
            selected,
        )
        .expect("the toggle")
    };
    toggle("West", true);
    assert_eq!(fx.ribbon_selection(filter_id), Some(strings(&["East", "West"])));
    toggle("East", false);
    assert_eq!(fx.ribbon_selection(filter_id), Some(strings(&["West"])));
    toggle("West", false);
    assert_eq!(fx.ribbon_selection(filter_id), None, "an empty selection is not the cleared filter");
    assert_eq!(fx.undo_depth(), depth + 3, "each toggle is not a step");
    toggle("West", false);
    assert_eq!(fx.undo_depth(), depth + 3, "a toggle that changed nothing recorded a step");
}

/// R1, the generic path and the empty cell. A pivot write that JOINS a step
/// which already wrote its cell -- here an ordinary apply (no gesture) inside
/// a script batch, recorded through `record_restores_joining_open_transaction`
/// -- is fitted to the step the same way: a C that was EMPTY when the step
/// began comes back empty, not with the script's value (the pivot restores of
/// a step replay after its cell restores).
#[tokio::test]
async fn a_pivot_write_joining_a_step_that_wrote_its_cell_undoes_to_the_steps_start() {
    let fx = Fx::new(0).await;
    let (pivot, c) = fx.shrunk_worksheet_pivot().await;
    assert_eq!(fx.text_at(c), None, "fixture: C starts empty");
    assert!(fx.begin_from_caller("Script batch"), "fixture: the script opens its batch");
    fx.put_text(c, "S");
    fx.state.undo_stack.lock().unwrap().record_cell_change(0, c.0, c.1, None); // C was empty
    apply_pivot_filter_core(&fx.ctx(), apply(pivot, "Sales.region", &["East", "North", "West"]))
        .await
        .expect("the apply");
    assert_ne!(fx.text_at(c).as_deref(), Some("S"), "fixture: the pivot grew over C");
    fx.commit();
    fx.undo_once();
    assert_eq!(fx.text_at(c), None, "undoing the step left the script's value in a cell that was empty when it began");
}
