//! FILENAME: app/src-tauri/src/pivot/mask_overlay_tests.rs
//! BUG-0108 end to end: a BI pivot over a real in-memory model, filtered
//! through the commands a slicer click, a field change, an undo and a reopen
//! run (`apply_pivot_filter_core`, `update_bi_pivot_fields_core`,
//! `undo_commands::apply_changes`, `persistence::collect/restore`), and read
//! back from the view the command RENDERED (`PivotState::views`).
//!
//! Fixture (product, region, amount, qty):
//!   Bikes   East 100 10 | Bikes   West 30 2
//!   Helmets East  40  8 | Helmets West 20 1
//!   Locks   East  10  5
//! SUM(amount): Bikes 130, Helmets 60, Locks 10 = 200; East 150, West 50.

use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use arrow::array::{Float64Array, StringArray};
use arrow::datatypes::{DataType as ArrowType, Field, Schema};
use arrow::record_batch::RecordBatch;
use bi_engine::{
    expression_measure, parse_measure, sum_measure, Column, DataModel, DataType, Engine, InMemoryConnector,
    QueryRequest, SourceBinding, StorageMode, Table,
};
use tokio::sync::Mutex as TokioMutex;

use crate::bi::types::{BiState, Connection, ConnectionId, ConnectionType};
use crate::document_effect::test_seed_effect;
use crate::pivot::commands::{
    apply_pivot_filter_core, extract_bi_model_metadata, refresh_bi_pivot_core, update_bi_pivot_fields_core,
    PivotCmdCtx,
};
use crate::pivot::mask_overlay::queries_issued_on_this_thread;
use crate::pivot::types::{
    ApplyPivotFilterRequest, BiFieldRef, BiPivotMetadata, BiValueFieldRef, PivotFilters, PivotManualFilter,
    PivotState, UpdateBiPivotFieldsRequest,
};

fn new_id() -> identity::EntityId {
    identity::EntityId::from_bytes(identity::generate_uuid_v7())
}

fn strings(v: &[&str]) -> Vec<String> {
    v.iter().map(|s| s.to_string()).collect()
}

fn sales_model() -> DataModel {
    let measure = |name: &str, text: &str| {
        expression_measure(name, parse_measure(text).unwrap_or_else(|e| panic!("{name} does not parse: {e}")))
    };
    DataModel::builder()
        .add_table(
            Table::new(
                "Sales",
                vec![
                    Column::new("product", DataType::String),
                    Column::new("region", DataType::String),
                    Column::new("amount", DataType::Float64),
                    Column::new("qty", DataType::Float64),
                ],
            )
            .unwrap()
            .with_storage_mode(StorageMode::InMemory),
        )
        .add_measure(sum_measure("Revenue", "Sales", "amount"))
        // Power BI's share of the VISIBLE total: ALLSELECTED drops the axis
        // and keeps the slicers.
        .add_measure(measure("Share", "DIVIDE(SUM(Sales[amount]), SUM(Sales[amount], ALLSELECTED()))"))
        // A share of the GRAND total: RESET (DAX ALL) drops the slicers too.
        .add_measure(measure("OfAll", "DIVIDE(SUM(Sales[amount]), SUM(Sales[amount], RESET()))"))
        // A plain ratio: no context op, not additive.
        .add_measure(measure("Price", "DIVIDE(SUM(Sales[amount]), SUM(Sales[qty]))"))
        .build()
        .unwrap()
}

fn sales_batch() -> RecordBatch {
    RecordBatch::try_new(
        Arc::new(Schema::new(vec![
            Field::new("product", ArrowType::Utf8, true),
            Field::new("region", ArrowType::Utf8, true),
            Field::new("amount", ArrowType::Float64, true),
            Field::new("qty", ArrowType::Float64, true),
        ])),
        vec![
            Arc::new(StringArray::from(vec!["Bikes", "Bikes", "Helmets", "Helmets", "Locks"])),
            Arc::new(StringArray::from(vec!["East", "West", "East", "West", "East"])),
            Arc::new(Float64Array::from(vec![100.0, 30.0, 40.0, 20.0, 10.0])),
            Arc::new(Float64Array::from(vec![10.0, 2.0, 8.0, 1.0, 5.0])),
        ],
    )
    .unwrap()
}

struct Fx {
    state: crate::AppState,
    file: crate::persistence::FileState,
    files: crate::persistence::UserFilesState,
    slicer: crate::slicer::SlicerState,
    pivots: PivotState,
    pane: crate::pane_control::PaneControlState,
    filters: crate::ribbon_filter::RibbonFilterState,
    timelines: crate::timeline_slicer::TimelineSlicerState,
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
                group_by: vec![bi_engine::ColumnRef::new("Sales", "product")],
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
            file: crate::persistence::FileState::default(),
            files: crate::persistence::UserFilesState::default(),
            slicer: crate::slicer::SlicerState::new(),
            pivots: PivotState::new(),
            pane: crate::pane_control::PaneControlState::new(),
            filters: crate::ribbon_filter::RibbonFilterState::new(),
            timelines: crate::timeline_slicer::TimelineSlicerState::new(),
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

    async fn metadata(&self) -> BiPivotMetadata {
        let engine_arc = self.bi.connections.lock().unwrap()[&self.conn].engine.clone().unwrap();
        let engine = engine_arc.lock().await;
        let (model_tables, measures, hierarchies, calculation_groups, perspectives, cultures) =
            extract_bi_model_metadata(&engine);
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

    /// A BI pivot laid out with `rows` (Sales columns) and `values` (measures).
    async fn pivot(&self, rows: &[&str], values: &[&str]) -> identity::EntityId {
        let id = new_id();
        let sheet_name = self.state.sheet_names.read().unwrap()[0].clone();
        let mut def = pivot_engine::PivotDefinition::new(id, (0, 0), (0, 0));
        def.destination_sheet = Some(sheet_name);
        def.name = Some(format!("Pivot{}", id));
        let meta = self.metadata().await;
        let seed = test_seed_effect();
        self.pivots.pivot_tables.write(&seed).unwrap().insert(id, (def, pivot_engine::PivotCache::new(id, 0)));
        self.pivots.bi_metadata.write(&seed).unwrap().insert(id, meta);
        self.lay_out(id, rows, values).await;
        id
    }

    async fn lay_out(&self, pivot: identity::EntityId, rows: &[&str], values: &[&str]) {
        let request = UpdateBiPivotFieldsRequest {
            pivot_id: pivot,
            row_fields: rows
                .iter()
                .map(|c| BiFieldRef { table: "Sales".into(), column: c.to_string(), is_lookup: false, hidden_items: None })
                .collect(),
            column_fields: vec![],
            value_fields: values
                .iter()
                .map(|m| BiValueFieldRef { measure_name: m.to_string(), custom_name: None, number_format: None })
                .collect(),
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

    fn slicer_request(pivot: identity::EntityId, column: &str, selected: &[&str], reconcile: bool) -> ApplyPivotFilterRequest {
        ApplyPivotFilterRequest {
            pivot_id: pivot,
            field_index: None,
            bi_field_key: Some(format!("Sales.{column}")),
            filters: PivotFilters {
                manual_filter: Some(PivotManualFilter { selected_items: strings(selected) }),
                ..Default::default()
            },
            filter_level: 1,
            slicer_id: None,
            reconcile,
        }
    }

    /// An ordinary (level-1) slicer click on `Sales.<column>`.
    async fn click(&self, pivot: identity::EntityId, column: &str, selected: &[&str]) {
        apply_pivot_filter_core(&self.ctx(), Self::slicer_request(pivot, column, selected, false))
            .await
            .expect("an ordinary slicer click answers");
    }

    /// The Slicer's reconcile after an undo or redo: the restored selection
    /// re-applied, recording nothing.
    async fn reconcile(&self, pivot: identity::EntityId, column: &str, selected: &[&str]) {
        apply_pivot_filter_core(&self.ctx(), Self::slicer_request(pivot, column, selected, true))
            .await
            .expect("the reconcile answers");
    }

    /// The value the LAST RENDER showed for `value_field` on the data row
    /// labelled `row` (`None` = the grand-total row).
    fn shown(&self, pivot: identity::EntityId, row: Option<&str>, value_field: usize) -> Option<f64> {
        let views = self.pivots.views.lock().unwrap();
        let view = views.get(&pivot).expect("the pivot was rendered");
        let r = match row {
            Some(label) => view.rows.iter().position(|d| {
                d.row_type == pivot_engine::PivotRowType::Data
                    && view.cells[d.view_row].first().is_some_and(|c| c.formatted_value == label)
            })?,
            None => view.rows.iter().position(|d| d.row_type == pivot_engine::PivotRowType::GrandTotal)?,
        };
        let row_index = view.rows[r].view_row;
        view.cells[row_index].iter().find_map(|c| match (c.value_field_index, &c.value) {
            (Some(i), pivot_engine::PivotCellValue::Number(n)) if i == value_field => Some(*n),
            _ => None,
        })
    }

    /// The data-row labels the last render showed.
    fn shown_rows(&self, pivot: identity::EntityId) -> Vec<String> {
        let views = self.pivots.views.lock().unwrap();
        let view = views.get(&pivot).expect("the pivot was rendered");
        view.rows
            .iter()
            .filter(|d| d.row_type == pivot_engine::PivotRowType::Data)
            .map(|d| view.cells[d.view_row][0].formatted_value.clone())
            .collect()
    }

    fn undo_once(&self) {
        let transaction = self.state.undo_stack.lock().unwrap().pop_undo().expect("a step to undo");
        crate::undo_commands::apply_changes(
            &self.state, &self.file, &self.files, &self.pivots, &self.slicer, &self.filters, &self.pane,
            &self.timelines, transaction, true,
        );
    }

    fn redo_once(&self) {
        let transaction = self.state.undo_stack.lock().unwrap().pop_redo().expect("a step to redo");
        crate::undo_commands::apply_changes(
            &self.state, &self.file, &self.files, &self.pivots, &self.slicer, &self.filters, &self.pane,
            &self.timelines, transaction, false,
        );
    }
}

#[track_caller]
fn close(actual: Option<f64>, expected: f64, what: &str) {
    let actual = actual.unwrap_or_else(|| panic!("{what}: no number shown"));
    assert!((actual - expected).abs() < 1e-9, "{what}: shown {actual}, expected {expected}");
}

/// THE LEDGER'S REPRO. A share of the visible total, `DIVIDE(SUM(x), SUM(x,
/// ALLSELECTED()))`, by product, with a slicer leaving one product: Power BI
/// shows 1.0 for that product and 1.0 for the grand total -- ALLSELECTED keeps
/// the slicer. The mask showed Bikes' share of ALL products (130 / 200) on both.
///
/// SABOTAGE: `apply_mask_overlay` a no-op (the pivot engine never splices the
/// overlay) -- Bikes reads 0.65.
#[tokio::test]
async fn the_only_product_a_slicer_leaves_is_one_hundred_percent_of_the_visible_total() {
    let fx = Fx::new().await;
    let pivot = fx.pivot(&["product"], &["Share"]).await;
    close(fx.shown(pivot, Some("Bikes"), 0), 130.0 / 200.0, "fixture: unfiltered, Bikes' share of all");
    close(fx.shown(pivot, None, 0), 1.0, "fixture: unfiltered grand total");

    let before = queries_issued_on_this_thread();
    fx.click(pivot, "product", &["Bikes"]).await;
    assert_eq!(fx.shown_rows(pivot), strings(&["Bikes"]), "the slicer leaves Bikes");
    close(fx.shown(pivot, Some("Bikes"), 0), 1.0, "Bikes is all of what the slicer leaves");
    close(fx.shown(pivot, None, 0), 1.0, "and so is the grand total");
    assert!(queries_issued_on_this_thread() > before, "positive control: the overlay asked the engine");

    // Two products: each its share of the two.
    fx.click(pivot, "product", &["Bikes", "Helmets"]).await;
    close(fx.shown(pivot, Some("Bikes"), 0), 130.0 / 190.0, "Bikes of Bikes + Helmets");
    close(fx.shown(pivot, Some("Helmets"), 0), 60.0 / 190.0, "Helmets of Bikes + Helmets");
    close(fx.shown(pivot, None, 0), 1.0, "the grand total of a share of the visible total");
}

/// The slicer on a column the pivot does NOT show (region, products on rows):
/// the first click ADDS the column (a re-query, the update path), the second
/// is a plain mask over the records that now carry it (the click path). Both
/// answer the visible region's shares.
#[tokio::test]
async fn an_off_axis_slicer_gives_each_product_its_share_of_the_visible_region() {
    let fx = Fx::new().await;
    let pivot = fx.pivot(&["product"], &["Share"]).await;

    fx.click(pivot, "region", &["East"]).await;
    close(fx.shown(pivot, Some("Bikes"), 0), 100.0 / 150.0, "Bikes of East");
    close(fx.shown(pivot, Some("Helmets"), 0), 40.0 / 150.0, "Helmets of East");
    close(fx.shown(pivot, Some("Locks"), 0), 10.0 / 150.0, "Locks of East");
    close(fx.shown(pivot, None, 0), 1.0, "East is the whole of what is visible");

    fx.click(pivot, "region", &["West"]).await;
    assert_eq!(fx.shown_rows(pivot), strings(&["Bikes", "Helmets"]), "Locks sold nothing in the West");
    close(fx.shown(pivot, Some("Bikes"), 0), 30.0 / 50.0, "Bikes of West");
    close(fx.shown(pivot, Some("Helmets"), 0), 20.0 / 50.0, "Helmets of West");
    close(fx.shown(pivot, None, 0), 1.0, "the grand total");
}

/// PERFORMANCE: a pivot whose measures are all additive keeps a click free of
/// engine queries -- the masked roll-up IS the answer -- on the click path and
/// on the re-query path alike, and its numbers are the plain masked sums.
///
/// SABOTAGE: `plan` treats every value field as sensitive -- the clicks ask.
#[tokio::test]
async fn a_click_on_a_pivot_of_additive_measures_asks_the_engine_nothing() {
    let fx = Fx::new().await;
    let pivot = fx.pivot(&["product"], &["Revenue"]).await;
    let before = queries_issued_on_this_thread();

    fx.click(pivot, "product", &["Bikes"]).await;
    close(fx.shown(pivot, Some("Bikes"), 0), 130.0, "Bikes");
    close(fx.shown(pivot, None, 0), 130.0, "the masked grand total is exact");

    // An off-axis slicer: the ensure re-queries, then the mask -- still no
    // overlay query on either path.
    fx.click(pivot, "region", &["West"]).await;
    close(fx.shown(pivot, Some("Bikes"), 0), 30.0, "Bikes in the West");
    close(fx.shown(pivot, None, 0), 30.0, "the grand total");
    assert_eq!(
        queries_issued_on_this_thread(),
        before,
        "an all-additive pivot must not pay an engine query per click"
    );
}

/// A plain ratio's totals under a mask are the ENGINE's, never a sum of
/// ratios: by region, with an off-axis slicer keeping Bikes and Helmets, each
/// region's price is ITS amount over ITS quantity (the records are split by
/// product, so even a leaf is a roll-up), and the grand total is 190 / 21.
///
/// SABOTAGE: the overlay never asks for the leaf grain -- East reads the sum
/// of Bikes' and Helmets' prices (10 + 5).
#[tokio::test]
async fn a_ratios_totals_under_a_mask_are_not_summed_additively() {
    let fx = Fx::new().await;
    let pivot = fx.pivot(&["region"], &["Price"]).await;
    close(fx.shown(pivot, None, 0), 200.0 / 26.0, "fixture: the unfiltered grand total is the engine's");

    fx.click(pivot, "product", &["Bikes", "Helmets"]).await;
    close(fx.shown(pivot, Some("East"), 0), 140.0 / 18.0, "East: (100 + 40) / (10 + 8)");
    close(fx.shown(pivot, Some("West"), 0), 50.0 / 3.0, "West: (30 + 20) / (2 + 1)");
    close(fx.shown(pivot, None, 0), 190.0 / 21.0, "the grand total: 190 / 21");
}

/// The compound RESET share -- the measure whose engine routing was a typed
/// REFUSAL under a slicer, the reason that routing was withdrawn -- still
/// answers on a click, and answers what the mask answered (a share of ALL:
/// RESET is DAX's ALL, which drops the slicer). Beside an ALLSELECTED share in
/// the same pivot, the refused measure cannot cost the other its answer: the
/// grain is asked again one measure at a time.
///
/// SABOTAGE: no per-measure retry -- the ALLSELECTED share reads 0.65.
#[tokio::test]
async fn a_reset_share_still_answers_and_cannot_cost_another_measure_its_overlay() {
    let fx = Fx::new().await;
    let pivot = fx.pivot(&["product"], &["OfAll"]).await;
    fx.click(pivot, "product", &["Bikes"]).await;
    close(fx.shown(pivot, Some("Bikes"), 0), 130.0 / 200.0, "a share of ALL ignores the slicer");
    close(fx.shown(pivot, None, 0), 130.0 / 200.0, "and so does its grand total");
    // Excel's Data Model pivot [LIVE]: Bikes + Helmets -> 0.65, 0.30, total 0.95.
    fx.click(pivot, "product", &["Bikes", "Helmets"]).await;
    close(fx.shown(pivot, Some("Helmets"), 0), 60.0 / 200.0, "Helmets of ALL");
    close(fx.shown(pivot, None, 0), 190.0 / 200.0, "the visible products' share of ALL");

    let both = fx.pivot(&["product"], &["OfAll", "Share"]).await;
    let before = queries_issued_on_this_thread();
    fx.click(both, "product", &["Bikes"]).await;
    // Two grains (the leaves, the grand total). The first is refused whole
    // and asked one measure at a time (1 + 2); OfAll refused, so the second
    // asks Share as its batch (1) and OfAll ALONE (1) -- a refusal can depend
    // on the grain (wave 3 verifier), so it is asked again, but never in the
    // batch-then-one-by-one fan-out. It was 1 + 2 at EVERY grain (wave 1
    // verifier), then 4 with OfAll never asked at the second grain.
    // SABOTAGE (pivotfix-sabK): the refused set never consulted -- 6 queries;
    // (piv4-sabO): a refused measure is skipped again -- 4.
    assert_eq!(queries_issued_on_this_thread() - before, 5, "a refused measure is asked alone, never in the fan-out");
    close(fx.shown(both, Some("Bikes"), 0), 130.0 / 200.0, "OfAll: a share of ALL");
    close(fx.shown(both, Some("Bikes"), 1), 1.0, "Share: all of the visible total");
    close(fx.shown(both, None, 1), 1.0, "Share's grand total");
}

/// UNDO AND REDO. The overlays describe the records, keyed by mask: the
/// Slicer's reconcile after an undo returns to a mask evaluated before and
/// renders ITS numbers without asking the engine again, and a real undo of a
/// field change -- which restores the older records from the step's JSON
/// snapshot -- brings their overlays back with them (the undo render is
/// synchronous: it has no engine to ask).
///
/// SABOTAGE: the cache keeps no overlay beyond the newest (`MAX_MASK_OVERLAYS`
/// = 1) -- the reconcile asks again.
#[tokio::test]
async fn undo_and_redo_of_a_slicer_change_show_each_states_own_overlay() {
    let fx = Fx::new().await;
    let pivot = fx.pivot(&["product"], &["Share"]).await;
    fx.click(pivot, "product", &["Bikes"]).await;
    fx.click(pivot, "product", &["Bikes", "Helmets"]).await;
    close(fx.shown(pivot, Some("Bikes"), 0), 130.0 / 190.0, "fixture: two products");

    let before = queries_issued_on_this_thread();
    fx.reconcile(pivot, "product", &["Bikes"]).await;
    close(fx.shown(pivot, Some("Bikes"), 0), 1.0, "undo: one product again, its own overlay");
    close(fx.shown(pivot, None, 0), 1.0, "undo: its grand total");
    fx.reconcile(pivot, "product", &["Bikes", "Helmets"]).await;
    close(fx.shown(pivot, Some("Helmets"), 0), 60.0 / 190.0, "redo: two products, theirs");
    assert_eq!(queries_issued_on_this_thread(), before, "both states were evaluated before");

    // A field change re-queries (new records, a new overlay) and records the
    // old records in its step; its undo restores them -- overlays included.
    fx.lay_out(pivot, &["product"], &["Share", "Revenue"]).await;
    close(fx.shown(pivot, Some("Bikes"), 0), 130.0 / 190.0, "the new records are filtered and overlaid too");
    close(fx.shown(pivot, Some("Bikes"), 1), 130.0, "Revenue keeps its masked sum");
    let before = queries_issued_on_this_thread();
    fx.undo_once();
    close(fx.shown(pivot, Some("Bikes"), 0), 130.0 / 190.0, "undo restores the older records AND their overlay");
    close(fx.shown(pivot, None, 0), 1.0, "and their grand total");
    fx.redo_once();
    close(fx.shown(pivot, Some("Helmets"), 0), 60.0 / 190.0, "redo: the newer records and theirs");
    close(fx.shown(pivot, Some("Helmets"), 1), 60.0, "with Revenue beside it");
    assert_eq!(queries_issued_on_this_thread(), before, "an undo render has no engine to ask");
}

/// A workbook file carries NO overlay: a BI pivot's records are never saved
/// (it reopens with an empty cache), and only its definition is -- filter
/// included. The reopened pivot's first refresh evaluates its own overlay
/// from the model.
///
/// SABOTAGE: the re-query path plans no overlay -- the reopened pivot shows
/// the masked 0.65.
#[tokio::test]
async fn a_saved_workbook_carries_no_overlay_and_a_reopened_pivot_evaluates_its_own() {
    let fx = Fx::new().await;
    let pivot = fx.pivot(&["product"], &["Share"]).await;
    fx.click(pivot, "product", &["Bikes"]).await;
    close(fx.shown(pivot, Some("Bikes"), 0), 1.0, "fixture: overlaid before the save");
    assert!(
        !fx.pivots.pivot_tables.read().unwrap()[&pivot].1.mask_overlays.is_empty(),
        "fixture: the live records carry an overlay"
    );

    let mut saved = ::persistence::Workbook::new();
    crate::persistence::collect_pivot_definitions(&fx.pivots, &fx.state, &mut saved);
    let file_json = serde_json::to_string(&(&saved.pivot_definitions, &saved.bi_pivot_metadata)).unwrap();
    assert!(!file_json.contains("mask_overlay"), "the file carries no overlay: {file_json}");
    assert!(!file_json.contains("mask_sensitivity"), "nor any part of the records");
    assert!(file_json.contains("Helmets"), "the filter itself IS saved (Helmets and Locks hidden)");

    // Reopen into a fresh pivot store: empty records, no overlay.
    let reopened = PivotState::new();
    crate::persistence::restore_pivot_definitions(&saved, &reopened, &fx.state);
    {
        let tables = reopened.pivot_tables.read().unwrap();
        let (definition, cache) = &tables[&pivot];
        assert!(cache.records.is_empty() && cache.mask_overlays.is_empty(), "a BI pivot reopens with no records");
        assert!(
            definition.row_fields[0].hidden_items.iter().any(|h| h == "Helmets"),
            "and with its filter"
        );
    }
    // The connection is re-bound when the user reconnects; then a refresh.
    reopened.bi_metadata.write(&test_seed_effect()).unwrap().get_mut(&pivot).unwrap().connection_id = fx.conn;
    let ctx = PivotCmdCtx { pivot_state: &reopened, ..fx.ctx() };
    refresh_bi_pivot_core(&ctx, pivot).await.expect("the reopened pivot refreshes");
    let views = reopened.views.lock().unwrap();
    let view = views.get(&pivot).expect("rendered");
    let bikes = view
        .cells
        .iter()
        .find(|cells| cells.first().is_some_and(|c| c.formatted_value == "Bikes"))
        .and_then(|cells| {
            cells.iter().find_map(|c| match (c.value_field_index, &c.value) {
                (Some(0), pivot_engine::PivotCellValue::Number(n)) => Some(*n),
                _ => None,
            })
        });
    close(bikes, 1.0, "the reopened pivot evaluated its own overlay");
}

/// A values-only pivot (a KPI: measures and no dimension, its one row the
/// synthetic "Total") under a slicer: that row IS the visible set's grand
/// total, so a share of the visible total is 1.0 and a ratio is the visible
/// set's own -- Excel's Data Model pivot shows 1 and 10.83, then 1 and 9.05,
/// as its grand totals for the same two selections [LIVE].
///
/// SABOTAGE: the synthetic Total row is a layout the overlay does not describe
/// -- the share reads 0.65.
#[tokio::test]
async fn a_values_only_pivot_under_a_slicer_shows_the_visible_sets_own_values() {
    let fx = Fx::new().await;
    let pivot = fx.pivot(&[], &["Share", "Price"]).await;
    fx.click(pivot, "product", &["Bikes"]).await;
    close(fx.shown(pivot, Some("Total"), 0), 1.0, "Share: all of what the slicer leaves");
    close(fx.shown(pivot, Some("Total"), 1), 130.0 / 12.0, "Price of Bikes");
    fx.click(pivot, "product", &["Bikes", "Helmets"]).await;
    close(fx.shown(pivot, Some("Total"), 0), 1.0, "Share of the two products");
    close(fx.shown(pivot, Some("Total"), 1), 190.0 / 21.0, "Price: 190 / 21, not a sum of prices");
}

/// A filter CLEAR renders inside one synchronous critical section, so the
/// state it leaves -- here the region slicer still standing after the product
/// filter is cleared -- gets its overlay afterwards, and the pivot is written
/// again with it: each product's share of East, as Excel shows it [LIVE].
///
/// SABOTAGE: the clear path never re-renders with an overlay -- Bikes reads
/// its share of ALL regions (0.5).
#[tokio::test]
async fn a_clear_that_leaves_another_filter_standing_shows_that_states_overlay() {
    let fx = Fx::new().await;
    let pivot = fx.pivot(&["product"], &["Share"]).await;
    // Product first, then region: the region click ADDS its column (new
    // records), so "East alone" -- what the clear leaves -- is a state these
    // records have never been evaluated in.
    fx.click(pivot, "product", &["Bikes", "Helmets"]).await;
    fx.click(pivot, "region", &["East"]).await;
    close(fx.shown(pivot, Some("Bikes"), 0), 100.0 / 140.0, "fixture: Bikes of East's Bikes + Helmets");

    let clear = crate::pivot::types::ClearPivotFilterRequest {
        pivot_id: pivot,
        field_index: None,
        bi_field_key: Some("Sales.product".to_string()),
        filter_type: None,
        reconcile: false,
    };
    crate::pivot::commands::clear_pivot_filter_core(&fx.ctx(), clear).await.expect("the clear answers");
    assert_eq!(fx.shown_rows(pivot), strings(&["Bikes", "Helmets", "Locks"]), "every product again");
    close(fx.shown(pivot, Some("Bikes"), 0), 100.0 / 150.0, "Bikes of East");
    close(fx.shown(pivot, Some("Locks"), 0), 10.0 / 150.0, "Locks of East");
    close(fx.shown(pivot, None, 0), 1.0, "the grand total");
}

/// Records fetched WHILE filtered carry no engine totals of their own (the
/// totals describe the unfiltered set, so the refresh skipped them). Clearing
/// the filter afterwards must still show the engine's grand total of a ratio,
/// never the sum of the regions' ratios.
///
/// SABOTAGE: the unfiltered state never asks for totals -- the grand total
/// reads East's price plus West's.
#[tokio::test]
async fn unfiltering_records_fetched_while_filtered_shows_the_engines_totals() {
    let fx = Fx::new().await;
    let pivot = fx.pivot(&["region"], &["Price"]).await;
    fx.click(pivot, "product", &["Bikes", "Helmets"]).await;
    // A field change re-queries while the filter stands.
    fx.lay_out(pivot, &["region"], &["Price", "Revenue"]).await;
    close(fx.shown(pivot, None, 0), 190.0 / 21.0, "fixture: the filtered grand total");
    assert!(
        fx.pivots.pivot_tables.read().unwrap()[&pivot].1.total_overrides.is_empty(),
        "fixture: records fetched while filtered carry no unfiltered totals"
    );

    let clear = crate::pivot::types::ClearPivotFilterRequest {
        pivot_id: pivot,
        field_index: None,
        bi_field_key: Some("Sales.product".to_string()),
        filter_type: None,
        reconcile: false,
    };
    crate::pivot::commands::clear_pivot_filter_core(&fx.ctx(), clear).await.expect("the clear answers");
    close(fx.shown(pivot, Some("East"), 0), 150.0 / 23.0, "East");
    close(fx.shown(pivot, None, 0), 200.0 / 26.0, "the unfiltered grand total: 200 / 26");
    close(fx.shown(pivot, None, 1), 200.0, "Revenue's grand total");
}

/// The script route to the same mask (wave 1 pivotmask verifier, CONFIRMED):
/// `api.pivot.setItemVisibility` -- Excel's `PivotItem.Visible` -- hiding
/// Helmets and Locks leaves the state a slicer on Bikes leaves, and shows
/// its numbers: Bikes is all of the visible total. It rendered the masked
/// roll-up only (Bikes' share of ALL products, 0.65).
///
/// SABOTAGE (pivotfix-sabF): `set_pivot_item_visibility_core` returns the
/// masked render without the overlay -- fails at "SCRIPT ROUTE" with 0.65.
#[tokio::test]
async fn hiding_items_from_a_script_shows_the_same_numbers_as_the_slicer() {
    let fx = Fx::new().await;
    let pivot = fx.pivot(&["product"], &["Share"]).await;
    let field_index = fx.pivots.pivot_tables.read().unwrap()[&pivot].0.row_fields[0].source_index;
    for item in ["Helmets", "Locks"] {
        crate::pivot::commands::set_pivot_item_visibility_core(
            &fx.ctx(),
            crate::pivot::types::SetItemVisibilityRequest {
                pivot_id: pivot,
                field_index,
                item_name: item.to_string(),
                visible: false,
            },
        )
        .await
        .expect("the script's visibility change answers");
    }
    assert_eq!(fx.shown_rows(pivot), strings(&["Bikes"]), "the script leaves Bikes");
    close(fx.shown(pivot, Some("Bikes"), 0), 1.0, "SCRIPT ROUTE: Bikes is all of what is visible (as the slicer)");
    close(fx.shown(pivot, None, 0), 1.0, "and so is the grand total");
}

/// The cost of a slicer click, with and without a measure the mask gets
/// wrong, on 100 000 fact rows (50 products x 8 regions). Run on demand:
/// `cargo test mask_overlay_click_cost -- --ignored --nocapture`.
#[tokio::test]
#[ignore]
async fn mask_overlay_click_cost() {
    let n = 100_000usize;
    let products: Vec<String> = (0..n).map(|i| format!("P{:02}", i % 50)).collect();
    let regions: Vec<String> = (0..n).map(|i| format!("R{}", i % 8)).collect();
    let batch = RecordBatch::try_new(
        Arc::new(Schema::new(vec![
            Field::new("product", ArrowType::Utf8, true),
            Field::new("region", ArrowType::Utf8, true),
            Field::new("amount", ArrowType::Float64, true),
            Field::new("qty", ArrowType::Float64, true),
        ])),
        vec![
            Arc::new(StringArray::from(products.iter().map(|s| s.as_str()).collect::<Vec<_>>())),
            Arc::new(StringArray::from(regions.iter().map(|s| s.as_str()).collect::<Vec<_>>())),
            Arc::new(Float64Array::from((0..n).map(|i| (i % 97) as f64 + 1.0).collect::<Vec<_>>())),
            Arc::new(Float64Array::from((0..n).map(|i| (i % 7) as f64 + 1.0).collect::<Vec<_>>())),
        ],
    )
    .unwrap();
    let fx = Fx::new().await;
    {
        let engine_arc = fx.bi.connections.lock().unwrap()[&fx.conn].engine.clone().unwrap();
        let mut engine = engine_arc.lock().await;
        let idx = engine.add_in_memory_source(InMemoryConnector::new().with_table("public", "big", batch));
        engine.bind_table("Sales", idx, SourceBinding::new("public", "big"));
        engine.refresh_table("Sales").await.expect("load the big table");
    }
    for measure in ["Revenue", "Share"] {
        let pivot = fx.pivot(&["product"], &[measure]).await;
        assert_eq!(fx.shown_rows(pivot).len(), 50, "the big table is the one measured");
        // Warm the off-axis column in (the ensure re-query is not the cost
        // being measured).
        fx.click(pivot, "region", &["R0", "R1", "R2", "R3", "R4", "R5", "R6", "R7"]).await;
        let selections: [&[&str]; 4] = [&["R0"], &["R0", "R1"], &["R2", "R3", "R4"], &["R5"]];
        let started = std::time::Instant::now();
        let asked_before = queries_issued_on_this_thread();
        for selected in selections {
            fx.click(pivot, "region", selected).await;
        }
        let per_click = started.elapsed().as_secs_f64() * 1000.0 / selections.len() as f64;
        let asked = queries_issued_on_this_thread() - asked_before;
        // A click back to an evaluated state: the cached overlay.
        let started = std::time::Instant::now();
        fx.click(pivot, "region", &["R0"]).await;
        let cached = started.elapsed().as_secs_f64() * 1000.0;
        println!(
            "MASK_OVERLAY_COST measure={measure} per_click_ms={per_click:.2} overlay_queries={asked} \
             click_back_to_a_cached_state_ms={cached:.2}"
        );
    }
}
