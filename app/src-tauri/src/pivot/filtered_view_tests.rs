//! FILENAME: app/src-tauri/src/pivot/filtered_view_tests.rs
//! PURPOSE: P4 S4b -- `run_bi_pivot_filtered_view`, the PAINT-ONLY view of a
//!          BI pivot under a selection made on another visual of its page,
//!          and the member keys a BI pivot's own view carries.
//!
//! What is pinned here, through the REAL command cores over an in-memory
//! model (no database):
//!
//!   1. The filtered view WRITES NOTHING: the pivot's definition, version,
//!      records and cells, the undo stack and the dirty flag are untouched.
//!   2. It keeps everything the pivot already filters by: a level-1 slicer
//!      filter (`hidden_items` on a slicer field), a PINNED model slicer and a
//!      pivot-own engine filter (level 2). With no selection added it shows the
//!      real pivot's grand total and grid shape (the no-divergence pin); with
//!      a tuple selection it narrows further.
//!   3. What a design query cannot reproduce yet is refused with a sentence.
//!   4. Member keys agree (the P2 contract): for a Decimal, a Date and an Int
//!      column, the `groupMembers` key, the header cell's `member.key` and the
//!      model list's key (`bi_get_column_values`) are byte-equal.

use std::collections::{BTreeSet, HashMap, HashSet};
use std::sync::Arc;

use arrow::array::{Date32Array, Decimal128Array, Float64Array, Int64Array, StringArray};
use arrow::datatypes::{DataType as ArrowType, Field, Schema};
use arrow::record_batch::RecordBatch;
use bi_engine::{
    sum_measure, Column, DataModel, DataType, Engine, InMemoryConnector, QueryRequest, SourceBinding,
    StorageMode, Table,
};
use engine::LocaleSettings;
use identity::EntityId;
use tokio::sync::Mutex as TokioMutex;

use super::{bi_pivot_filtered_view, BiPivotFilteredViewRequest, DesignQueryColumn, DesignQueryTupleFilter};
use crate::bi::types::{BiState, Connection, ConnectionId, ConnectionType};
use crate::document_effect::test_seed_effect;
use crate::persistence::{FileState, UserFilesState};
use crate::pivot::commands::{
    apply_pivot_filter_core, design_query_from_bi_pivot, update_bi_pivot_fields_core, PivotCmdCtx,
};
use crate::pivot::types::{
    ApplyPivotFilterRequest, BiFieldRef, BiHierarchyFieldRef, BiPivotMetadata, BiValueFieldRef,
    PivotCellValueData, PivotFilters, PivotManualFilter, PivotState, PivotViewResponse, UpdateBiPivotFieldsRequest,
    CALC_GROUP_TABLE,
};
use crate::slicer::types::{CreateSlicerParams, SlicerState};
use crate::AppState;

fn new_id() -> EntityId {
    EntityId::from_bytes(identity::generate_uuid_v7())
}

fn strings(v: &[&str]) -> Vec<String> {
    v.iter().map(|s| s.to_string()).collect()
}

fn epoch_days(y: i32, m: u32, d: u32) -> i32 {
    let date = chrono::NaiveDate::from_ymd_opt(y, m, d).unwrap();
    (date - chrono::NaiveDate::from_ymd_opt(1970, 1, 1).unwrap()).num_days() as i32
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/// region  year channel amount   price       day        qty
/// East    Y1   Web       10     5.50   2024-01-15     3
/// West    Y1   Store     20    10.00   2024-02-01     5
/// East    Y2   Web       30     5.50   2024-01-15     3
/// North   Y2   Store     40  3578.27   2024-03-01     7
/// West    Y2   Web       50     NULL   2024-03-01  NULL
fn sales_batch() -> RecordBatch {
    let day = |m, d| epoch_days(2024, m, d);
    RecordBatch::try_new(
        Arc::new(Schema::new(vec![
            Field::new("region", ArrowType::Utf8, true),
            Field::new("year", ArrowType::Utf8, true),
            Field::new("channel", ArrowType::Utf8, true),
            Field::new("amount", ArrowType::Float64, true),
            Field::new("price", ArrowType::Decimal128(10, 2), true),
            Field::new("day", ArrowType::Date32, true),
            Field::new("qty", ArrowType::Int64, true),
        ])),
        vec![
            Arc::new(StringArray::from(vec!["East", "West", "East", "North", "West"])),
            Arc::new(StringArray::from(vec!["Y1", "Y1", "Y2", "Y2", "Y2"])),
            Arc::new(StringArray::from(vec!["Web", "Store", "Web", "Store", "Web"])),
            Arc::new(Float64Array::from(vec![10.0, 20.0, 30.0, 40.0, 50.0])),
            Arc::new(
                Decimal128Array::from(vec![Some(550i128), Some(1_000), Some(550), Some(357_827), None])
                    .with_precision_and_scale(10, 2)
                    .unwrap(),
            ),
            Arc::new(Date32Array::from(vec![day(1, 15), day(2, 1), day(1, 15), day(3, 1), day(3, 1)])),
            Arc::new(Int64Array::from(vec![Some(3), Some(5), Some(3), Some(7), None])),
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
                    Column::new("channel", DataType::String),
                    Column::new("amount", DataType::Float64),
                    Column::new("price", DataType::Decimal(10, 2)),
                    Column::new("day", DataType::Date),
                    Column::new("qty", DataType::Int64),
                ],
            )
            .unwrap()
            .with_storage_mode(StorageMode::InMemory),
        )
        .add_measure(sum_measure("Revenue", "Sales", "amount"))
        .add_measure(sum_measure("Money", "Sales", "amount").with_format_string("#,##0.00"))
        .build()
        .unwrap()
}

/// A workbook (one worksheet) with a loaded, cache-warm model connection.
struct Fx {
    state: AppState,
    file: FileState,
    files: UserFilesState,
    slicer: SlicerState,
    pivots: PivotState,
    pane: crate::pane_control::PaneControlState,
    filters: crate::ribbon_filter::RibbonFilterState,
    bi: BiState,
    conn: ConnectionId,
}

impl Fx {
    async fn new() -> Fx {
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
        let conn = new_id();
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
        Fx {
            state: crate::create_app_state(),
            file: FileState::default(),
            files: UserFilesState::default(),
            slicer: SlicerState::new(),
            pivots: PivotState::new(),
            pane: crate::pane_control::PaneControlState::new(),
            filters: crate::ribbon_filter::RibbonFilterState::new(),
            bi,
            conn,
        }
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

    /// A BI pivot on the worksheet at A1, laid out through the REAL update
    /// command with `rows` and Revenue.
    async fn pivot(&self, rows: &[&str]) -> (EntityId, PivotViewResponse) {
        let id = new_id();
        let sheet_name = self.state.sheet_names.read().unwrap()[0].clone();
        let mut def = pivot_engine::PivotDefinition::new(id, (0, 0), (0, 0));
        def.destination_sheet = Some(sheet_name);
        def.name = Some("PivotTable1".to_string());
        let meta = self.meta().await;
        let seed = test_seed_effect();
        self.pivots.pivot_tables.write(&seed).unwrap().insert(id, (def, pivot_engine::PivotCache::new(id, 0)));
        self.pivots.bi_metadata.write(&seed).unwrap().insert(id, meta);
        let response = self.lay_out(id, rows).await;
        (id, response)
    }

    async fn lay_out(&self, pivot: EntityId, rows: &[&str]) -> PivotViewResponse {
        update_bi_pivot_fields_core(&self.ctx(), layout_request(pivot, rows)).await.expect("lay the pivot out")
    }

    async fn filter(&self, pivot: EntityId, key: &str, selected: &[&str], level: u8, slicer: Option<EntityId>) {
        let request = ApplyPivotFilterRequest {
            pivot_id: pivot,
            field_index: None,
            bi_field_key: Some(key.to_string()),
            filters: PivotFilters {
                manual_filter: Some(PivotManualFilter { selected_items: strings(selected) }),
                ..Default::default()
            },
            filter_level: level,
            slicer_id: slicer.map(|s| s.to_string()),
            reconcile: false,
        };
        apply_pivot_filter_core(&self.ctx(), request).await.expect("apply the filter");
    }

    /// The REAL pivot's current view, rendered from clones (nothing stored).
    fn real_view(&self, pivot: EntityId) -> PivotViewResponse {
        let tables = self.pivots.pivot_tables.read().unwrap();
        let (def, cache) = &tables[&pivot];
        let mut cache = cache.clone();
        let view = crate::pivot::operations::safe_calculate_pivot(def, &mut cache);
        crate::pivot::utils::view_to_response(&view, def, &mut cache, &LocaleSettings::invariant())
    }

    async fn filtered(&self, pivot: EntityId, tuples: Vec<DesignQueryTupleFilter>) -> Result<PivotViewResponse, String> {
        let request = BiPivotFilteredViewRequest { pivot_id: pivot, page_filter_fields: Vec::new(), tuple_filters: tuples };
        bi_pivot_filtered_view(&self.bi, &self.pivots, &request, &LocaleSettings::invariant()).await
    }

    fn definition_json(&self, pivot: EntityId) -> String {
        serde_json::to_string(&self.pivots.pivot_tables.read().unwrap()[&pivot].0).unwrap()
    }

    fn records(&self, pivot: EntityId) -> usize {
        self.pivots.pivot_tables.read().unwrap()[&pivot].1.records.len()
    }

    fn cells(&self) -> Vec<Option<String>> {
        let grids = self.state.grids.read().unwrap();
        let grid = self.state.grid.read().unwrap();
        let mut out = Vec::new();
        for r in 0..20u32 {
            for c in 0..8u32 {
                out.push(grids[0].get_cell(r, c).map(|x| x.display_value()));
                out.push(grid.get_cell(r, c).map(|x| x.display_value()));
            }
        }
        out
    }

    fn undo_depth(&self) -> usize {
        self.state.undo_stack.lock().unwrap().undo_depth()
    }
}

fn field(c: &str) -> BiFieldRef {
    BiFieldRef { table: "Sales".into(), column: c.to_string(), is_lookup: false, hidden_items: None }
}

fn layout_request(pivot: EntityId, rows: &[&str]) -> UpdateBiPivotFieldsRequest {
    UpdateBiPivotFieldsRequest {
        pivot_id: pivot,
        row_fields: rows.iter().map(|r| field(r)).collect(),
        column_fields: vec![],
        value_fields: vec![BiValueFieldRef { measure_name: "Revenue".into(), custom_name: None, number_format: None }],
        filter_fields: vec![],
        slicer_fields: None,
        row_hierarchies: vec![],
        column_hierarchies: vec![],
        layout: None,
        lookup_columns: vec![],
        calculated_fields: None,
        value_column_order: None,
        force_requery: false,
    }
}

fn tuple(columns: &[&str], tuples: &[&[&str]]) -> DesignQueryTupleFilter {
    DesignQueryTupleFilter {
        fields: columns.iter().map(|c| DesignQueryColumn { table: "Sales".into(), column: c.to_string() }).collect(),
        tuples: tuples.iter().map(|t| strings(t)).collect(),
        level: None,
    }
}

fn grand_total(response: &PivotViewResponse) -> Option<f64> {
    response
        .rows
        .iter()
        .flat_map(|r| r.cells.iter())
        .find(|c| c.cell_type == pivot_engine::PivotCellType::GrandTotal)
        .and_then(|c| match c.value {
            PivotCellValueData::Number(n) => Some(n),
            _ => None,
        })
}

// ---------------------------------------------------------------------------
// 1. It writes nothing
// ---------------------------------------------------------------------------

#[tokio::test]
async fn the_filtered_view_leaves_the_pivot_its_cells_the_undo_stack_and_the_dirty_flag_untouched() {
    let fx = Fx::new().await;
    let (pivot, real) = fx.pivot(&["year"]).await;
    assert_eq!(grand_total(&real), Some(150.0), "fixture: every row totals 150");
    crate::document_effect::mark_saved(&fx.file);

    let definition = fx.definition_json(pivot);
    let version = fx.pivots.pivot_tables.read().unwrap()[&pivot].0.version;
    let records = fx.records(pivot);
    let cells = fx.cells();
    let depth = fx.undo_depth();

    let response = fx
        .filtered(pivot, vec![tuple(&["year", "region"], &[&["Y2", "West"], &["Y1", "East"]])])
        .await
        .expect("a filtered view of a BI pivot");
    assert_eq!(grand_total(&response), Some(60.0), "Y2/West 50 + Y1/East 10");
    assert_eq!(response.pivot_id, pivot, "the response names the REAL pivot (staleness pairing)");
    assert_eq!(response.version, version, "the response carries the REAL pivot's version");

    assert!(!fx.file.is_dirty(), "a paint-only view dirtied the document");
    assert_eq!(fx.undo_depth(), depth, "a paint-only view recorded an undo step");
    assert_eq!(fx.pivots.pivot_tables.read().unwrap()[&pivot].0.version, version, "the pivot's version moved");
    assert_eq!(fx.definition_json(pivot), definition, "the pivot's definition changed");
    assert_eq!(fx.records(pivot), records, "the pivot's records changed");
    assert_eq!(fx.cells(), cells, "the pivot's cells changed");
    assert_eq!(grand_total(&fx.real_view(pivot)), Some(150.0), "the real pivot now shows the selection");
}

// ---------------------------------------------------------------------------
// 2. It keeps every filter the pivot already has
// ---------------------------------------------------------------------------

/// A level-1 filter on a column the layout does not show lives on a SLICER
/// field (`hidden_items`); the filtered view keeps it, and adds no filter row
/// for it.
#[tokio::test]
async fn the_filtered_view_of_a_pivot_with_a_slicer_filter_keeps_that_filter() {
    let fx = Fx::new().await;
    let (pivot, _) = fx.pivot(&["year"]).await;
    fx.filter(pivot, "Sales.region", &["East"], 1, None).await;
    let real = fx.real_view(pivot);
    assert_eq!(grand_total(&real), Some(40.0), "fixture: East is 10 + 30");
    assert!(
        fx.pivots.pivot_tables.read().unwrap()[&pivot].0.slicer_filters.iter().any(|sf| !sf.hidden_items.is_empty()),
        "fixture: the filter lives on a slicer field"
    );

    let view = fx.filtered(pivot, vec![]).await.unwrap();
    assert_eq!(grand_total(&view), Some(40.0), "the filtered view dropped the slicer filter");
    assert_eq!((view.row_count, view.col_count), (real.row_count, real.col_count), "the grid's shape diverged");
    assert_eq!(view.filter_rows.len(), real.filter_rows.len(), "a slicer field became a filter row");

    let narrowed = fx.filtered(pivot, vec![tuple(&["year", "region"], &[&["Y2", "East"], &["Y2", "West"]])]).await.unwrap();
    assert_eq!(grand_total(&narrowed), Some(30.0), "Y2/East 30; Y2/West is outside the slicer filter");
}

/// A PINNED (level-2) model slicer and a pivot-own engine filter both stay
/// inside the query. With no selection the filtered view IS the real pivot's
/// grid (the no-divergence pin).
#[tokio::test]
async fn the_filtered_view_keeps_a_pinned_model_slicer_and_a_pivot_own_engine_filter() {
    let fx = Fx::new().await;
    let (pivot, _) = fx.pivot(&["year"]).await;

    // The pivot's own pin: region IN (East, West).
    fx.filter(pivot, "Sales.region", &["East", "West"], 2, None).await;
    // A model slicer on the same sheet, pinned at level 2: channel = Web.
    let params: CreateSlicerParams = serde_json::from_value(serde_json::json!({
        "name": "Sales.channel",
        "sheetIndex": 0,
        "x": 400.0, "y": 10.0,
        "sourceType": "biConnection",
        "cacheSourceId": fx.conn.to_string(),
        "fieldName": "Sales.channel",
        "connectedSources": [{ "sourceType": "biConnection", "sourceId": fx.conn.to_string() }]
    }))
    .unwrap();
    let slicer = crate::slicer::commands::create_slicer_core(&fx.state, &fx.file, &fx.slicer, &fx.bi, params).unwrap().id;
    crate::slicer::commands::update_slicer_selection_core(
        &fx.state,
        &fx.file,
        &fx.slicer,
        slicer,
        Some(strings(&["Web"])),
        "Slicer filter change",
    )
    .unwrap();
    crate::slicer::commands::update_slicer_core(
        &fx.state,
        &fx.file,
        &fx.slicer,
        slicer,
        serde_json::from_value(serde_json::json!({ "filterLevel": 2 })).unwrap(),
    )
    .unwrap();
    fx.filter(pivot, "Sales.channel", &["Web"], 2, Some(slicer)).await;

    let pins: Vec<(String, u8)> = fx.pivots.pivot_tables.read().unwrap()[&pivot]
        .0
        .engine_filters
        .iter()
        .map(|ef| (ef.column.clone(), ef.level))
        .collect();
    assert!(
        pins.contains(&("region".to_string(), 2)) && pins.contains(&("channel".to_string(), 2)),
        "fixture: both pins are engine filters: {pins:?}"
    );
    let real = fx.real_view(pivot);
    assert_eq!(grand_total(&real), Some(90.0), "fixture: Web among East/West is 10 + 30 + 50");

    let view = fx.filtered(pivot, vec![]).await.unwrap();
    assert_eq!(grand_total(&view), grand_total(&real), "the filtered view diverged from the real pivot");
    assert_eq!((view.row_count, view.col_count), (real.row_count, real.col_count), "the grid's shape diverged");
    assert_eq!(view.filter_rows.len(), real.filter_rows.len(), "a pin became a filter row");

    let narrowed = fx.filtered(pivot, vec![tuple(&["year", "region"], &[&["Y1", "West"], &["Y2", "West"]])]).await.unwrap();
    assert_eq!(grand_total(&narrowed), Some(50.0), "West/Y1 is Store (outside the pin); West/Y2 Web is 50");
}

// ---------------------------------------------------------------------------
// 3. Refusals
// ---------------------------------------------------------------------------

#[test]
fn a_pivot_a_design_query_cannot_reproduce_is_refused_with_a_sentence() {
    let pivot = new_id();
    let conn = new_id();

    let mut hierarchy = layout_request(pivot, &["year"]);
    hierarchy.row_hierarchies =
        vec![BiHierarchyFieldRef { hierarchy: "Calendar".into(), table: "Sales".into(), expanded: Vec::new() }];
    assert_eq!(
        design_query_from_bi_pivot(&hierarchy, conn, &[]).err().as_deref(),
        Some("This PivotTable uses hierarchies, which a visual's selection cannot filter yet.")
    );
    let mut column_hierarchy = layout_request(pivot, &["year"]);
    column_hierarchy.column_hierarchies =
        vec![BiHierarchyFieldRef { hierarchy: "Calendar".into(), table: "Sales".into(), expanded: Vec::new() }];
    assert!(design_query_from_bi_pivot(&column_hierarchy, conn, &[]).is_err());

    let mut calc_group = layout_request(pivot, &["year"]);
    calc_group.column_fields = vec![BiFieldRef {
        table: CALC_GROUP_TABLE.into(),
        column: "Time Intelligence".into(),
        is_lookup: false,
        hidden_items: None,
    }];
    assert_eq!(
        design_query_from_bi_pivot(&calc_group, conn, &[]).err().as_deref(),
        Some("This PivotTable uses a calculation group, which a visual's selection cannot filter yet.")
    );

    let mut lookup = layout_request(pivot, &["year"]);
    lookup.row_fields[0].is_lookup = true;
    assert_eq!(
        design_query_from_bi_pivot(&lookup, conn, &[]).err().as_deref(),
        Some("This PivotTable uses LOOKUP columns, which a visual's selection cannot filter yet.")
    );

    // The ordinary shape maps: slicer fields and pins are ENGINE-ROUTED.
    let mut ordinary = layout_request(pivot, &["year"]);
    ordinary.slicer_fields = Some(vec![BiFieldRef { hidden_items: Some(strings(&["North"])), ..field("region") }]);
    let pin = pivot_engine::EngineFilter {
        field_name: "channel".into(),
        table: "Sales".into(),
        column: "channel".into(),
        selected_items: strings(&["Web"]),
        level: 3,
        slicer_id: None,
    };
    let query = design_query_from_bi_pivot(&ordinary, conn, &[pin]).unwrap();
    assert!(query.filter_fields.is_empty(), "a slicer field or pin became a FILTERS field");
    assert_eq!(query.page_filter_fields.len(), 2);
    assert_eq!(query.page_filter_fields[0].hidden_items, Some(strings(&["North"])));
    assert_eq!(query.page_filter_fields[1].included_items, Some(strings(&["Web"])));
    assert_eq!(query.page_filter_fields[1].level, Some(3), "a pin keeps its level");
}

/// A BI pivot that does not exist, or a range pivot, is refused.
#[tokio::test]
async fn an_unknown_or_range_pivot_is_refused() {
    let fx = Fx::new().await;
    let err = fx.filtered(new_id(), vec![]).await.err().unwrap();
    assert!(err.contains("not found"), "{err}");
    let range = new_id();
    fx.pivots
        .pivot_tables
        .write(&test_seed_effect())
        .unwrap()
        .insert(range, (pivot_engine::PivotDefinition::new(range, (0, 0), (0, 0)), pivot_engine::PivotCache::new(range, 0)));
    let err = fx.filtered(range, vec![]).await.err().unwrap();
    assert!(err.contains("not a BI-backed pivot"), "{err}");
}

// ---------------------------------------------------------------------------
// 4. Member keys agree (P2 contract)
// ---------------------------------------------------------------------------

/// For a Decimal, a Date and an Int column: the BI pivot's `groupMembers`
/// key, its header cell's `member.key` and the model list's key are
/// byte-equal; the filtered view's `groupMembers` say the same.
#[tokio::test]
async fn member_keys_agree_for_decimal_date_and_int_columns() {
    let fx = Fx::new().await;
    let (pivot, _) = fx.pivot(&["region"]).await;
    for column in ["price", "day", "qty"] {
        let response = fx.lay_out(pivot, &[column]).await;
        let field_key = format!("Sales.{column}");
        let group: Vec<&crate::pivot::types::PivotGroupMembers> =
            response.group_members.iter().filter(|g| g.field_key == field_key).collect();
        assert_eq!(group.len(), 1, "{column}: no groupMembers for the row field: {:?}", response.group_members);
        let gm = group[0];
        let group_keys: BTreeSet<String> = gm.members.iter().map(|(_, k)| k.clone()).collect();

        let mut header_keys: BTreeSet<String> = BTreeSet::new();
        for cell in response.rows.iter().flat_map(|r| r.cells.iter()) {
            let Some(member) = &cell.member else { continue };
            let (fi, vid) = *cell.group_path.last().expect("a member header has a group path");
            assert_eq!(fi, gm.field_index, "{column}");
            let from_group = gm.members.iter().find(|(v, _)| *v == vid).map(|(_, k)| k.as_str());
            assert_eq!(from_group, Some(member.key.as_str()), "{column}: groupMembers and the header's member.key disagree");
            header_keys.insert(member.key.clone());
        }
        let listed: BTreeSet<String> =
            crate::bi::commands::bi_get_column_values_core(&fx.bi, fx.conn, "Sales", column).await.unwrap().into_iter().collect();
        assert_eq!(group_keys, header_keys, "{column}: groupMembers and header keys differ");
        assert_eq!(group_keys, listed, "{column}: groupMembers and the model list's keys differ");

        let view = fx.filtered(pivot, vec![]).await.unwrap();
        let filtered_keys: BTreeSet<String> = view
            .group_members
            .iter()
            .filter(|g| g.field_key == field_key)
            .flat_map(|g| g.members.iter().map(|(_, k)| k.clone()))
            .collect();
        assert_eq!(filtered_keys, group_keys, "{column}: the filtered view's keys differ from the pivot's");
    }
}

// ---------------------------------------------------------------------------
// 5. The filtered view paints the real pivot's number formats
// ---------------------------------------------------------------------------

fn grand_total_cell(response: &PivotViewResponse) -> &crate::pivot::types::PivotCellData {
    response
        .rows
        .iter()
        .flat_map(|r| r.cells.iter())
        .find(|c| c.cell_type == pivot_engine::PivotCellType::GrandTotal && matches!(c.value, PivotCellValueData::Number(_)))
        .expect("a numeric grand-total cell")
}

/// A measure with a MODEL format string: the real pivot adopts it on its
/// update query, and the filtered view (whose rebuilt request leaves an
/// adopted format out) must paint it too, with and without row fields.
#[tokio::test]
async fn the_filtered_view_paints_the_model_format_the_real_pivot_adopted() {
    let fx = Fx::new().await;
    for rows in [&["year"][..], &[][..]] {
        let (pivot, _) = fx.pivot(rows).await;
        let mut request = layout_request(pivot, rows);
        request.value_fields =
            vec![BiValueFieldRef { measure_name: "Money".into(), custom_name: None, number_format: None }];
        update_bi_pivot_fields_core(&fx.ctx(), request).await.expect("lay out Money");
        {
            let tables = fx.pivots.pivot_tables.read().unwrap();
            let vf = &tables[&pivot].0.value_fields[0];
            assert_eq!(vf.number_format.as_deref(), Some("#,##0.00"), "fixture: the pivot adopted the model format");
            assert!(vf.number_format_from_model, "fixture: the format is the model's, not an override");
        }
        let real = fx.real_view(pivot);
        assert_eq!(grand_total_cell(&real).formatted_value, "150.00", "fixture: the real pivot paints the format");

        let unfiltered = fx.filtered(pivot, vec![]).await.unwrap();
        assert_eq!(
            grand_total_cell(&unfiltered).formatted_value,
            grand_total_cell(&real).formatted_value,
            "rows {rows:?}: the filtered view dropped the model format"
        );
        let narrowed = if rows.is_empty() {
            fx.filtered(pivot, vec![tuple(&["region"], &[&["East"]])]).await.unwrap()
        } else {
            fx.filtered(pivot, vec![tuple(&["year", "region"], &[&["Y2", "West"], &["Y1", "East"]])]).await.unwrap()
        };
        let cell = grand_total_cell(&narrowed);
        let expected = if rows.is_empty() { "40.00" } else { "60.00" };
        assert_eq!(cell.formatted_value, expected, "rows {rows:?}: the cross-filtered view painted General");
        assert_eq!(cell.number_format.as_deref(), Some("#,##0.00"), "rows {rows:?}");
    }
}
