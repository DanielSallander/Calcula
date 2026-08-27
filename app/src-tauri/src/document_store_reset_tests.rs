//! FILENAME: app/src-tauri/src/document_store_reset_tests.rs
//! PURPOSE: The BEHAVIOUR half of the document-scoped store census — the reset
//!          really empties the stores the census says it does.
//! CONTEXT: `document_store_census_tests.rs` is a source-level check: it proves
//!          every save source is MENTIONED in the reset and that both
//!          document-replacing commands call it. That is exactly the assertion
//!          a wrong `clear()` on the wrong field would satisfy. These tests run
//!          the real `reset_document_scoped_stores` over populated stores and
//!          assert emptiness afterwards, so text and behaviour are pinned
//!          independently.
//!
//! Every test here follows the same shape as the reproduction that found the
//! defect: POPULATE (the "workbook A" half), assert the store really is
//! populated (a reset test that passes on an empty store proves nothing), RESET,
//! assert empty.
//!
//! The byte-level half — that a workbook saved after File ▸ New physically
//! contains none of the previous one's entries — is `app/e2e/journeys/
//! document-store-leak.spec.ts`, because `save_file` and
//! `assemble_workbook_for_save` are `#[tauri::command]`s and cannot be reached
//! from a unit test.

use crate::document_effect::{CleanReason, DocumentEffect};
use crate::{create_app_state, AppState};

use crate::bi::types::{BiState, Connection, ConnectionType};
use crate::pane_control::PaneControlState;
use crate::persistence::{reset_document_scoped_stores, UserFilesState};
use crate::pivot::types::PivotState;
use crate::ribbon_filter::RibbonFilterState;
use crate::scripting::types::ScriptState;
use crate::slicer::SlicerState;
use crate::timeline_slicer::TimelineSlicerState;

/// Everything `reset_document_scoped_stores` takes, built fresh.
struct Stores {
    state: AppState,
    user_files: UserFilesState,
    slicers: SlicerState,
    ribbon_filters: RibbonFilterState,
    pane_controls: PaneControlState,
    scripts: ScriptState,
    pivots: PivotState,
    bi: BiState,
    timelines: TimelineSlicerState,
}

impl Stores {
    fn new() -> Self {
        Stores {
            state: create_app_state(),
            user_files: UserFilesState::default(),
            slicers: SlicerState::new(),
            ribbon_filters: RibbonFilterState::new(),
            pane_controls: PaneControlState::new(),
            scripts: ScriptState::new(),
            pivots: PivotState::new(),
            bi: BiState::new(),
            timelines: TimelineSlicerState::new(),
        }
    }

    /// Run the real reset — the same call `new_file` and `open_file` make.
    fn reset(&self) {
        reset_document_scoped_stores(
            &self.state,
            &self.user_files,
            &self.slicers,
            &self.ribbon_filters,
            &self.pane_controls,
            &self.scripts,
            &self.pivots,
            &self.bi,
            &self.timelines,
            &seed(),
        )
        .expect("the reset must not fail on healthy stores");
    }
}

/// A cell holding one text value — the "workbook A" side of every before-image
/// in this file. `Cell::new()` takes no arguments and starts empty, so the value
/// is assigned rather than passed.
fn probe_cell(text: &str) -> engine::Cell {
    let mut cell = engine::Cell::new();
    cell.value = engine::CellValue::Text(text.to_string());
    cell
}

/// Seeding a store directly, and the reset itself: neither is an edit TO a
/// document, which is why both callers pass a deliberately-clean effect.
fn seed() -> DocumentEffect {
    DocumentEffect::deliberately_clean(CleanReason::LoadingFromDisk)
}

/// A minimal but REAL model, built the way the product builds one. The engine's
/// `DataModel` has no `Default` on purpose — a model is validated as it is
/// built — so the probe goes through the builder rather than around it.
fn probe_model() -> bi_engine::DataModel {
    bi_engine::DataModel::builder()
        .build()
        .expect("an empty model must build")
}

// ===========================================================================
// The three stores §2w named
// ===========================================================================

/// WORKBOOK A'S PIVOT DOES NOT SURVIVE INTO WORKBOOK B.
///
/// `collect_pivot_definitions` serializes the whole live `pivot_tables` map with
/// no document scoping, so a pivot left resident is a pivot written into the
/// next `.cala` the user saves.
#[test]
fn a_pivot_does_not_survive_the_document_it_belongs_to() {
    use pivot_engine::{PivotCache, PivotDefinition};

    let s = Stores::new();
    let pivot_id = identity::EntityId::from_bytes(identity::generate_uuid_v7());
    let mut def = PivotDefinition::new(pivot_id, (0, 0), (10, 3));
    def.name = Some("LEAK PROBE PIVOT".to_string());
    let cache = PivotCache::new(pivot_id, 4);
    s.pivots
        .pivot_tables
        .write(&seed())
        .unwrap()
        .insert(pivot_id, (def, cache));

    assert_eq!(
        s.pivots.pivot_tables.read().unwrap().len(),
        1,
        "precondition: the pivot really is live before the reset"
    );

    s.reset();

    assert!(
        s.pivots.pivot_tables.read().unwrap().is_empty(),
        "the previous document's pivot is still live after the reset, so the \
         next save writes a `pivot_definitions/def_*.json` the user never \
         authored"
    );
    assert!(
        s.pivots.bi_metadata.read().unwrap().is_empty(),
        "the pivots' BI metadata outlived the pivots"
    );
    assert!(
        s.pivots.views.lock().unwrap().is_empty()
            && s.pivots.cancellation_tokens.lock().unwrap().is_empty()
            && s.pivots.previous_states.lock().unwrap().is_empty()
            && s.pivots.active_pivot_id.lock().unwrap().is_none(),
        "the session caches keyed by pivot id still name pivots the new \
         document has never heard of"
    );
}

/// WORKBOOK A'S RIBBON FILTER DOES NOT SURVIVE INTO WORKBOOK B.
#[test]
fn a_ribbon_filter_does_not_survive_the_document_it_belongs_to() {
    let s = Stores::new();
    let id = identity::EntityId::from_bytes(identity::generate_uuid_v7());
    // Built from JSON rather than a 20-field literal: every optional field
    // carries a serde default, and the point of the fixture is that the map is
    // non-empty, not which display mode it uses.
    let filter: crate::ribbon_filter::RibbonFilter = serde_json::from_value(serde_json::json!({
        "id": id,
        "name": "LEAK PROBE FILTER",
        "connectionId": identity::EntityId::from_bytes(identity::generate_uuid_v7()),
        "fieldName": "Sales.Region",
        "selectedItems": ["North"],
    }))
    .expect("the probe filter must deserialize");
    s.ribbon_filters.filters.write(&seed()).unwrap().insert(id, filter);

    assert_eq!(
        s.ribbon_filters.filters.read().unwrap().len(),
        1,
        "precondition: the ribbon filter really is live before the reset"
    );

    s.reset();

    assert!(
        s.ribbon_filters.filters.read().unwrap().is_empty(),
        "the previous document's ribbon filter is still live after the reset, \
         so the next save writes a `ribbon_filters/filter_*.json` the user \
         never authored"
    );
}

/// WORKBOOK A'S MODEL CONNECTION DOES NOT SURVIVE INTO WORKBOOK B — and the
/// engine behind it is torn down, not merely forgotten.
///
/// This is the one with the confidentiality edge: `capture_local_bi_connections`
/// embeds the connection's WHOLE model (tables, bindings, measures, source
/// catalog) into `bi_connections/conn_N.json`, so a workbook the user sends
/// somebody carried an unrelated project's semantic model.
///
/// It is also the one where `clear()` would not have been enough. A `Connection`
/// holds an `Arc<TokioMutex<Engine>>` counted by the shared `EngineRegistry`;
/// dropping the map without releasing the reference leaves the engine — its
/// model, its cached batches, its connectors — resident for the life of the
/// process. So this asserts the REGISTRY is empty too, which is what
/// distinguishes a teardown from a forget.
#[test]
fn a_model_connection_does_not_survive_the_document_it_belongs_to() {
    use crate::bi::engine_registry::ModelKey;

    let s = Stores::new();
    let conn_id = identity::EntityId::from_bytes(identity::generate_uuid_v7());
    let model_key = ModelKey::from_model_path(&format!("local:{}", conn_id));
    let engine = crate::bi::commands::build_configured_engine(probe_model());
    let (engine_arc, was_existing, _cache_dir) =
        s.bi.engine_registry.get_or_create(&model_key, engine);
    assert!(!was_existing, "precondition: a fresh engine was registered");

    s.bi.connections.lock().unwrap().insert(
        conn_id,
        Connection {
            id: conn_id,
            name: "LEAK PROBE MODEL".to_string(),
            description: String::new(),
            connection_type: ConnectionType::PostgreSQL,
            connection_string: String::new(),
            server: String::new(),
            database: String::new(),
            preferred_auth: String::new(),
            model_path: None,
            engine: Some(engine_arc),
            model_key: Some(model_key.clone()),
            connector_index: None,
            bindings: Vec::new(),
            last_refreshed: None,
            created_at: chrono::Utc::now().to_rfc3339(),
            is_connected: false,
            active_queries: std::collections::HashMap::new(),
            package_data_source_id: None,
            active_role: None,
            base_model: Some(probe_model()),
            calculated_measures: Vec::new(),
        },
    );
    s.bi
        .pending_roles
        .lock()
        .unwrap()
        .insert("local:probe".to_string(), "Manager".to_string());

    assert_eq!(
        s.bi.connections.lock().unwrap().len(),
        1,
        "precondition: the connection really is live before the reset"
    );
    assert!(
        s.bi.engine_registry.has_engine(&model_key),
        "precondition: the shared registry really is holding the engine"
    );

    s.reset();

    assert!(
        s.bi.connections.lock().unwrap().is_empty(),
        "the previous document's model connection is still live after the \
         reset. This is the accumulating one: nothing anywhere used to clear \
         the map, so connections piled up for the life of the process and \
         EVERY save embedded all of them."
    );
    assert!(
        !s.bi.engine_registry.has_engine(&model_key),
        "the connection was dropped but its engine was left in the shared \
         registry with a reference count that can never reach zero — the model, \
         its cached batches and its open connectors stay resident for the life \
         of the process. Tear down, do not `clear()`."
    );
    assert!(
        s.bi.pending_roles.lock().unwrap().is_empty(),
        "the previous document's saved 'view as' RLS roles are still waiting to \
         re-attach to a connection in the new one"
    );
}

/// The teardown is safe while a query is in flight: an in-flight caller holds
/// its own clone of the engine `Arc`, so the reset can neither block on it nor
/// pull the engine out from under it.
///
/// Pinned because the obvious "correct" teardown — lock the engine and shut it
/// down — would deadlock exactly here, and the failure would only appear under
/// a concurrent refresh.
#[test]
fn the_teardown_does_not_block_on_an_engine_that_is_busy() {
    use crate::bi::engine_registry::ModelKey;

    let s = Stores::new();
    let conn_id = identity::EntityId::from_bytes(identity::generate_uuid_v7());
    let model_key = ModelKey::from_model_path(&format!("local:{}", conn_id));
    let engine = crate::bi::commands::build_configured_engine(probe_model());
    let (engine_arc, _, _) = s.bi.engine_registry.get_or_create(&model_key, engine);

    // The established async pattern: clone the Arc out from under the
    // `connections` lock, then hold the engine while the work runs.
    let in_flight = engine_arc.clone();
    let guard = in_flight.blocking_lock();

    s.bi.connections.lock().unwrap().insert(
        conn_id,
        Connection {
            id: conn_id,
            name: "BUSY".to_string(),
            description: String::new(),
            connection_type: ConnectionType::PostgreSQL,
            connection_string: String::new(),
            server: String::new(),
            database: String::new(),
            preferred_auth: String::new(),
            model_path: None,
            engine: Some(engine_arc),
            model_key: Some(model_key.clone()),
            connector_index: None,
            bindings: Vec::new(),
            last_refreshed: None,
            created_at: chrono::Utc::now().to_rfc3339(),
            is_connected: false,
            active_queries: std::collections::HashMap::new(),
            package_data_source_id: None,
            active_role: None,
            base_model: None,
            calculated_measures: Vec::new(),
        },
    );

    // Must return rather than hang.
    s.reset();

    assert!(
        s.bi.connections.lock().unwrap().is_empty(),
        "the connection was not removed while its engine was busy"
    );
    // The query still owns a live engine and can finish against it.
    drop(guard);
    assert_eq!(
        std::sync::Arc::strong_count(&in_flight),
        1,
        "after the reset the in-flight caller holds the LAST reference — the \
         engine outlives the document exactly as long as the work using it, and \
         no longer"
    );
}

// ===========================================================================
// The stores the ENUMERATION turned up, which §2w had not measured
// ===========================================================================

/// A BLANK DOCUMENT GETS A FRESH SHEET IDENTITY.
///
/// `build_workbook_for_save` reads `sheet_ids[i]`, and `new_file` never reset
/// it. So File ▸ New handed the new document the PREVIOUS document's SheetId —
/// the key every `.calp` override, subscription ledger entry and writeback
/// region is filed under. Two unrelated workbooks then claimed the same sheet,
/// which is worse than a leak: it is a collision no later save can detect.
#[test]
fn a_blank_document_does_not_inherit_the_previous_documents_sheet_identity() {
    let s = Stores::new();
    let old: Vec<identity::SheetId> = vec![
        identity::SheetId::from_bytes(identity::generate_uuid_v7()),
        identity::SheetId::from_bytes(identity::generate_uuid_v7()),
        identity::SheetId::from_bytes(identity::generate_uuid_v7()),
    ];
    *s.state.sheet_ids.write(&seed()).unwrap() = old.clone();

    s.reset();

    let now = s.state.sheet_ids.read().unwrap().clone();
    assert_eq!(
        now.len(),
        1,
        "a blank document has exactly one sheet, so it must have exactly one \
         sheet id — a longer vector is the previous document's sheet count \
         showing through"
    );
    assert!(
        !old.contains(&now[0]),
        "the blank document reused a SheetId from the document just closed"
    );
    assert_eq!(
        s.state.sheet_names.read().unwrap().len(),
        now.len(),
        "sheet names and sheet ids must agree — `build_workbook_for_save` \
         indexes one by the other"
    );
}

/// The writeback COLUMN history is a save source (`model_writeback_values.json`)
/// that `new_file` never reset, so a blank document saved the previous
/// workbook's submitted values.
#[test]
fn the_model_writeback_history_does_not_survive_the_document_it_belongs_to() {
    let s = Stores::new();
    {
        let mut store = s.state.model_writeback.write(&seed()).unwrap();
        store.entries.insert(
            "Sales.Comment".to_string(),
            vec![serde_json::from_value(serde_json::json!({
                "key": ["42"],
                "value": { "type": "text", "value": "LEAK PROBE VALUE" },
                "submitterId": "probe",
                "submitterName": "Probe",
                "submittedAt": "2026-08-09T00:00:00Z",
                "state": "approved",
            }))
            .expect("the probe entry must deserialize")],
        );
    }
    assert_eq!(
        s.state.model_writeback.read().unwrap().entries.len(),
        1,
        "precondition: the writeback history really is populated"
    );

    s.reset();

    assert!(
        s.state.model_writeback.read().unwrap().entries.is_empty(),
        "the previous document's writeback COLUMN history is still live, so the \
         blank document's next save writes another workbook's submitted values"
    );
}

/// The advanced-filter hidden rows are folded into every sheet's persisted
/// `hidden_rows`, and `open_file` never cleared them — so rows an advanced
/// filter had hidden in the PREVIOUS document were written out as hidden in the
/// one just opened.
#[test]
fn advanced_filter_hidden_rows_do_not_survive_the_document_they_belong_to() {
    let s = Stores::new();
    s.state
        .advanced_filter_hidden_rows
        .write(&crate::document_effect::test_seed_effect())
        .unwrap()
        .insert(0, vec![3, 4, 5]);
    assert_eq!(
        s.state.advanced_filter_hidden_rows.write(&crate::document_effect::test_seed_effect()).unwrap().len(),
        1,
        "precondition: rows really are hidden before the reset"
    );

    s.reset();

    assert!(
        s.state.advanced_filter_hidden_rows.write(&crate::document_effect::test_seed_effect()).unwrap().is_empty(),
        "rows hidden by the previous document's advanced filter would be \
         written into the next document's saved `hidden_rows`"
    );
}

// ===========================================================================
// The class sweep: the stores named alongside the three
// ===========================================================================

/// `ScriptState` and `PaneControlState` were named elsewhere as ungated stores.
/// They are save sources too, so the same question applies to them, and the
/// answer must be the same.
#[test]
fn scripts_notebooks_and_pane_controls_do_not_survive_the_document() {
    let s = Stores::new();

    s.scripts.workbook_scripts.write(&seed()).unwrap().insert(
        "probe".to_string(),
        crate::scripting::types::WorkbookScript {
            id: "probe".to_string(),
            name: "LEAK PROBE SCRIPT".to_string(),
            description: None,
            source: "export function run() {}".to_string(),
            scope: crate::scripting::types::ScriptScope::Workbook,
            source_package: None,
        },
    );
    s.pane_controls.controls.lock().unwrap().insert(
        identity::EntityId::from_bytes(identity::generate_uuid_v7()),
        serde_json::from_value(serde_json::json!({
            "id": identity::EntityId::from_bytes(identity::generate_uuid_v7()),
            "name": "LEAK PROBE CONTROL",
            "controlType": "button",
            "config": { "type": "button", "label": "Probe" },
            "value": null,
        }))
        .expect("the probe control must deserialize"),
    );
    s.user_files
        .files
        .lock()
        .unwrap()
        .insert("probe.txt".to_string(), b"LEAK PROBE FILE".to_vec());

    assert!(
        !s.scripts.workbook_scripts.read().unwrap().is_empty()
            && !s.pane_controls.controls.lock().unwrap().is_empty()
            && !s.user_files.files.lock().unwrap().is_empty(),
        "precondition: all three stores really are populated"
    );

    s.reset();

    assert!(
        s.scripts.workbook_scripts.read().unwrap().is_empty(),
        "the previous document's workbook scripts are still live"
    );
    assert!(
        s.scripts.workbook_notebooks.read().unwrap().is_empty(),
        "the previous document's notebooks are still live"
    );
    assert!(
        s.pane_controls.controls.lock().unwrap().is_empty(),
        "the previous document's pane controls are still live"
    );
    assert!(
        s.user_files.files.lock().unwrap().is_empty(),
        "the previous document's virtual files are still live"
    );
}

/// The distribution stores — subscriptions, overrides, the audit log, the
/// writeback layer and the draft regions — all reach the archive, and all reset.
#[test]
fn the_distribution_stores_do_not_survive_the_document() {
    let s = Stores::new();
    s.state
        .subscriptions
        .write(&seed())
        .unwrap()
        .subscriptions
        .push(serde_json::from_value(serde_json::json!({
            "packageName": "leak-probe",
            "registryUrl": "C:/probe",
            "versionPin": "*",
            "resolvedVersion": "1.0.0",
            "resolvedAt": "2026-08-09T00:00:00Z",
            "sheets": [],
        }))
        .expect("the probe subscription must deserialize"));
    s.state.audit_log.write(&seed()).unwrap().enabled = true;

    assert!(
        !s.state.subscriptions.read().unwrap().subscriptions.is_empty(),
        "precondition: the subscription really is recorded"
    );

    s.reset();

    assert!(
        s.state.subscriptions.read().unwrap().subscriptions.is_empty(),
        "the previous document's .calp subscriptions are still live, so the \
         blank document saves a `subscriptions.json` claiming a package it \
         never pulled"
    );
    assert!(
        !s.state.audit_log.read().unwrap().enabled
            && s.state.audit_log.read().unwrap().entries.is_empty(),
        "the previous document's audit log is still live"
    );
    assert!(
        s.state.override_layer.read().unwrap().overrides.is_empty(),
        "the previous document's override layer is still live"
    );
    assert!(
        s.state.writeback_draft_regions.read().unwrap().is_empty(),
        "the previous document's writeback draft regions are still live"
    );
}

// ===========================================================================
// DEFECT 4a — document-scoped state that is NOT a save source
//
// Everything below was invisible to the save-path census by construction: none
// of it is serialised, so enumerating what `assemble_workbook_for_save` reads
// could never have named any of it. `new_file` cleared it inline and
// `open_file` did not clear it at all, so every one of these stores survived a
// File ▸ Open into a document that had never seen it.
// ===========================================================================

/// THE 4a DEFECT ITSELF: the undo stack does not outlive its document.
///
/// A `Transaction` records (sheet, row, col) and the BEFORE value, and names no
/// document. Left across a File ▸ Open, the first Ctrl+Z applies workbook A's
/// before-image at workbook B's coordinates — measured, cold, on the bytes:
/// open A (A1 = "A-ORIGINAL"), edit a cell, open B (same cell = "B-ORIGINAL"),
/// press Ctrl+Z once, save B, and the saved `.cala` contains "A-ORIGINAL".
/// The user spends one undo they never earned and loses a cell they never
/// touched, in a document that had no history to spend.
///
/// The byte-level half of this is `document-store-leak.spec.ts`; this is the
/// store-level half, and it is the one that fails the moment the reset is
/// removed rather than the moment somebody runs the app.
#[test]
fn the_undo_stack_does_not_survive_the_document_it_belongs_to() {
    let s = Stores::new();
    {
        let mut stack = s.state.undo_stack.lock().unwrap();
        stack.record_cell_change(
            0,
            0,
            105,
            Some(probe_cell("A-ORIGINAL")),
        );
        assert!(
            stack.can_undo() && stack.undo_depth() == 1,
            "precondition: workbook A's edit really is on the stack"
        );
    }

    s.reset();

    let stack = s.state.undo_stack.lock().unwrap();
    assert!(
        !stack.can_undo(),
        "the previous document's undo stack survived. One Ctrl+Z in the newly \
         opened workbook now applies THAT document's before-image at these \
         coordinates — a silent overwrite of a cell the user never edited, \
         which the next save writes to disk"
    );
    assert_eq!(stack.undo_depth(), 0, "undo depth must be zero");
    assert_eq!(stack.redo_depth(), 0, "redo depth must be zero");
    // ...and the ids do not restart. A transaction id names a point in ONE
    // document's history; if the counter restarted, a marker remembered in
    // workbook A could be matched by an unrelated transaction in workbook B —
    // the same document-blindness as the before-image above, one level up.
    drop(stack);
    {
        let mut stack = s.state.undo_stack.lock().unwrap();
        stack.record_cell_change(0, 0, 105, None);
        assert!(
            stack.undo_seqs() > vec![1],
            "the id counter restarted with the new document: {:?}",
            stack.undo_seqs()
        );
    }
    let stack = s.state.undo_stack.lock().unwrap();
    assert!(
        !stack.has_open_transaction(),
        "an open transaction from the previous document would swallow the new \
         document's first edit into a batch that describes neither"
    );
}

/// The spill maps do not outlive their document — and this one DESTROYS cells.
///
/// `spill_ranges` (origin -> spilled coordinates) and `spill_hosts` (spilled
/// coordinate -> origin) are keyed by bare `(sheet_index, row, col)`. Both
/// consequences of leaving them across a File ▸ Open are live:
///
/// * `check_spill_protection` reads `spill_hosts` and REFUSES the edit — "The
///   value contained in this cell is spilled from the formula in A1" — naming a
///   formula in a workbook that is no longer open. Those cells stay uneditable
///   for the rest of the session.
/// * clearing the stale ORIGIN takes the `spill_ranges` branch that runs
///   `grid.cells.remove(...)` over every coordinate the PREVIOUS document's
///   spill covered. That deletes cells of the open document, and the undo
///   entry records only the cell the user actually touched.
#[test]
fn the_spill_maps_do_not_survive_the_document_they_belong_to() {
    let s = Stores::new();
    // Workbook A: `=SEQUENCE(4)` in A1, spilling A1:A4.
    s.state
        .spill_ranges
        .write(&crate::document_effect::test_seed_effect())
        .unwrap()
        .insert((0, 0, 0), vec![(1, 0), (2, 0), (3, 0)]);
    {
        let mut hosts = s.state.spill_hosts.lock().unwrap();
        hosts.insert((0, 1, 0), (0, 0));
        hosts.insert((0, 2, 0), (0, 0));
        hosts.insert((0, 3, 0), (0, 0));
    }
    assert_eq!(
        s.state.spill_ranges.write(&crate::document_effect::test_seed_effect()).unwrap().len(),
        1,
        "precondition: workbook A's spill really is tracked"
    );
    assert_eq!(
        s.state.spill_hosts.lock().unwrap().len(),
        3,
        "precondition: the spilled cells really are claimed"
    );

    s.reset();

    assert!(
        s.state.spill_ranges.write(&crate::document_effect::test_seed_effect()).unwrap().is_empty(),
        "the previous document's spill RANGE survived. Clearing A1 in the newly \
         opened workbook now walks these coordinates and deletes the cells it \
         finds there — data the user never touched, with no undo entry for it"
    );
    assert!(
        s.state.spill_hosts.lock().unwrap().is_empty(),
        "the previous document's spill HOSTS survived. Every one of those \
         coordinates is now an uneditable cell in the open workbook, refused \
         with a message naming a formula in a document that is closed"
    );
}

/// The dependency graph does not outlive its document.
///
/// Rebuilt from the grid by `rebuild_all_dependencies`, in every direction it is
/// indexed — including the DEFINED-NAME edges, without which a name the previous
/// workbook defined keeps its dependents pointed at coordinates that mean
/// nothing here (D2: a formula stores the NAME, not the reference).
#[test]
fn the_dependency_graph_does_not_survive_the_document() {
    let s = Stores::new();
    s.state
        .dependents
        .lock()
        .unwrap()
        .entry((0, 0))
        .or_default()
        .insert((5, 5));
    s.state
        .dependencies
        .lock()
        .unwrap()
        .entry((5, 5))
        .or_default()
        .insert((0, 0));
    s.state
        .column_dependents
        .lock()
        .unwrap()
        .entry(3)
        .or_default()
        .insert((7, 7));
    s.state
        .row_dependents
        .lock()
        .unwrap()
        .entry(3)
        .or_default()
        .insert((7, 7));
    s.state
        .column_dependencies
        .lock()
        .unwrap()
        .entry((7, 7))
        .or_default()
        .insert(3);
    s.state
        .row_dependencies
        .lock()
        .unwrap()
        .entry((7, 7))
        .or_default()
        .insert(3);
    s.state
        .name_dependents
        .lock()
        .unwrap()
        .entry("BUDGETTOTAL".to_string())
        .or_default()
        .insert((9, 9));
    s.state
        .name_dependencies
        .lock()
        .unwrap()
        .entry((9, 9))
        .or_default()
        .insert("BUDGETTOTAL".to_string());
    s.state
        .cross_sheet_dependents
        .lock()
        .unwrap()
        .entry(("Sheet2".to_string(), 1, 1))
        .or_default()
        .insert((0, 2, 2));
    s.state
        .cross_sheet_dependencies
        .lock()
        .unwrap()
        .entry((0, 2, 2))
        .or_default()
        .insert(("Sheet2".to_string(), 1, 1));

    assert!(
        !s.state.dependents.lock().unwrap().is_empty()
            && !s.state.name_dependents.lock().unwrap().is_empty()
            && !s.state.cross_sheet_dependents.lock().unwrap().is_empty(),
        "precondition: the previous document's graph really is populated"
    );

    s.reset();

    assert!(s.state.dependents.lock().unwrap().is_empty(), "cell dependents survived");
    assert!(s.state.dependencies.lock().unwrap().is_empty(), "cell dependencies survived");
    assert!(s.state.column_dependents.lock().unwrap().is_empty(), "column dependents survived");
    assert!(s.state.row_dependents.lock().unwrap().is_empty(), "row dependents survived");
    assert!(s.state.column_dependencies.lock().unwrap().is_empty(), "column dependencies survived");
    assert!(s.state.row_dependencies.lock().unwrap().is_empty(), "row dependencies survived");
    assert!(
        s.state.name_dependents.lock().unwrap().is_empty(),
        "the previous document's DEFINED-NAME edges survived, so re-pointing a \
         name in the new document would recalculate cells that do not exist"
    );
    assert!(s.state.name_dependencies.lock().unwrap().is_empty(), "name dependencies survived");
    assert!(s.state.cross_sheet_dependents.lock().unwrap().is_empty(), "cross-sheet dependents survived");
    assert!(
        s.state.cross_sheet_dependencies.lock().unwrap().is_empty(),
        "cross-sheet dependencies survived"
    );
}

/// Workbook structure protection — and its PASSWORD HASH — does not outlive its
/// document.
///
/// A save source that the census could not see: `collect_protection_for_save`
/// reads it through a method chain wrapped across lines, which the census's
/// line-at-a-time scan skipped (see `join_method_chains`). `new_file` reset it
/// inline, so the leak was latent rather than live — but "latent" was one
/// refactor away from a blank document carrying another workbook's password.
#[test]
fn workbook_structure_protection_does_not_survive_the_document() {
    let s = Stores::new();
    {
        let mut prot = s.state.workbook_protection.write(&seed()).unwrap();
        prot.protected = true;
        prot.password_hash = Some("LEAK-PROBE-HASH".to_string());
    }
    assert!(
        s.state.workbook_protection.read().unwrap().protected,
        "precondition: workbook A really is structure-protected"
    );

    s.reset();

    let prot = s.state.workbook_protection.read().unwrap();
    assert!(
        !prot.protected,
        "the previous workbook's structure protection survived, so the new \
         document refuses sheet add/delete/rename for a password its author \
         never set"
    );
    assert!(
        prot.password_hash.is_none(),
        "the previous workbook's PASSWORD HASH survived, and protection is \
         persisted — the next save writes another document's secret into this \
         one"
    );
}

/// The subscription writeback bookkeeping does not outlive its document.
#[test]
fn the_writeback_bookkeeping_does_not_survive_the_document() {
    let s = Stores::new();
    let sheet_id = identity::SheetId::from_bytes(identity::generate_uuid_v7());
    let declaration: calp::WritebackRegionDeclaration = serde_json::from_value(serde_json::json!({
        "id": "leak-probe-region",
        "selector": {
            "sheetId": sheet_id,
            "rowStart": 0, "rowEnd": 4, "colStart": 0, "colEnd": 2,
        },
    }))
    .expect("the probe declaration must deserialize");
    *s.state.writeback_index.lock().unwrap() =
        calp::WritebackIndex::from_declarations(std::slice::from_ref(&declaration))
            .expect("the probe index must build");
    s.state.writeback_declarations.lock().unwrap().push(declaration);
    s.state
        .model_writeback_declarations
        .lock()
        .unwrap()
        .push(
            serde_json::from_value(serde_json::json!({
                "id": "leak-probe-column",
                "dataSourceId": "ds-1",
                "table": "Sales",
                "column": "Forecast",
                "keyColumns": ["Id"],
            }))
            .expect("the probe model column must deserialize"),
        );
    s.state
        .writeback_rebuild_skips
        .lock()
        .unwrap()
        .push(crate::calp_commands::WritebackRebuildSkip {
            package_name: "leak-probe".to_string(),
            registry_url: "C:/probe".to_string(),
            reason: "unreachable".to_string(),
            detail: "the registry path does not exist".to_string(),
        });

    assert!(
        s.state.writeback_index.lock().unwrap().contains(sheet_id, 0, 0),
        "precondition: workbook A's writeback region really is indexed"
    );

    s.reset();

    assert!(
        !s.state.writeback_index.lock().unwrap().contains(sheet_id, 0, 0),
        "the previous document's writeback INDEX survived, so cells of the \
         newly opened workbook are treated as publisher-designated writeback \
         cells belonging to a package it never subscribed to"
    );
    assert!(
        s.state.writeback_declarations.lock().unwrap().is_empty(),
        "the previous document's writeback declarations survived"
    );
    assert!(
        s.state.model_writeback_declarations.lock().unwrap().is_empty(),
        "the previous document's MODEL writeback columns survived, so the next \
         refresh diff reports that workbook's columns as removed from this one"
    );
    assert!(
        s.state.writeback_rebuild_skips.lock().unwrap().is_empty(),
        "the previous document's rebuild skips survived, and they are shown to \
         the user verbatim — blaming the open workbook for another one's \
         unreachable registry"
    );
}

/// The GATHER pre-fetch map does not outlive its document.
///
/// `build_gather_data` runs on every recalculation and serves whatever is in
/// here even past its TTL, precisely so that it never does registry I/O on the
/// edit path. That makes a stale map worse than a slow one: the previous
/// document's collected submissions are fed straight into this document's
/// GATHER formulas, and the result looks like a computed answer.
#[test]
fn the_gather_cache_does_not_survive_the_document() {
    let s = Stores::new();
    let mut regions = std::collections::HashMap::new();
    regions.insert(
        "leak-probe-region".to_string(),
        engine::GatherRegionData::default(),
    );
    *s.state.gather_cache.lock().unwrap() = Some((std::time::Instant::now(), regions));
    assert!(
        s.state.gather_cache.lock().unwrap().is_some(),
        "precondition: workbook A's gathered data really is cached"
    );

    s.reset();

    assert!(
        s.state.gather_cache.lock().unwrap().is_none(),
        "the previous document's GATHER data survived, so this document's \
         GATHER formulas answer with another workbook's collected submissions"
    );
}

/// The cell-identity registry does not outlive its document.
///
/// `open_file` re-seeds it from the restored override layer AFTER the reset, so
/// the identities the new document needs are rebuilt. Nothing ever emptied it,
/// so it accumulated every cell identity of every workbook opened in the
/// session.
#[test]
fn the_cell_identity_registry_does_not_survive_the_document() {
    let s = Stores::new();
    let sheet_id = identity::SheetId::from_bytes(identity::generate_uuid_v7());
    {
        let mut registry = s.state.id_registry.lock().unwrap();
        registry.register_sheet_with_id("Sheet1", sheet_id);
        registry.cell_id_at(sheet_id, (3, 4));
        assert!(
            registry.lookup_cell_id(sheet_id, (3, 4)).is_some(),
            "precondition: workbook A's cell really has an identity"
        );
    }

    s.reset();

    assert!(
        s.state
            .id_registry
            .lock()
            .unwrap()
            .lookup_cell_id(sheet_id, (3, 4))
            .is_none(),
        "the previous document's cell identities survived; the registry grows \
         for the life of the process and hands the new document ids minted for \
         a workbook it has never seen"
    );
}

/// The cancelled-recalculation marker does not outlive its document.
///
/// Another save source the wrapped-chain blind spot hid
/// (`attach_pending_recalc_for_save`). `open_file` restores it from the file;
/// `new_file` used to leave the previous document's "these cells were never
/// calculated" claim standing over a blank grid — and SAVE it there.
#[test]
fn the_pending_recalc_marker_does_not_survive_the_document() {
    use crate::eval_budget::{PendingCell, PendingRecalc};

    let s = Stores::new();
    *s.state.pending_recalc.write(&crate::document_effect::test_seed_effect()).unwrap() = Some(PendingRecalc {
        sheet_index: 0,
        cells: vec![PendingCell { row: 12, col: 3 }],
    });
    assert!(
        s.state.pending_recalc.write(&crate::document_effect::test_seed_effect()).unwrap().is_some(),
        "precondition: workbook A really has a cancelled pass on record"
    );

    s.reset();

    assert!(
        s.state.pending_recalc.write(&crate::document_effect::test_seed_effect()).unwrap().is_none(),
        "the previous document's cancelled-recalculation marker survived: the \
         new document reports cells as never-calculated on coordinates it has \
         never evaluated, and writes that claim into the next save"
    );
}

/// Animation/simulation transient snapshots do not outlive their document.
///
/// Each entry is the PRIOR `Cell` values a running playback must restore on
/// stop. Those cells belong to the document being replaced, so a playback
/// stopped after the swap writes them into the new one — the undo defect with a
/// different verb, and with no undo entry at all, because the whole point of the
/// transient-write pattern is that it never touches the undo stack.
#[test]
fn animation_snapshots_do_not_survive_the_document() {
    let s = Stores::new();
    s.state.animation_snapshots.lock().unwrap().insert(
        "leak-probe-token".to_string(),
        vec![((0, 0), Some(probe_cell("A-ORIGINAL")))],
    );
    assert_eq!(
        s.state.animation_snapshots.lock().unwrap().len(),
        1,
        "precondition: workbook A's playback snapshot really is held"
    );

    s.reset();

    assert!(
        s.state.animation_snapshots.lock().unwrap().is_empty(),
        "the previous document's animation snapshots survived: stopping that \
         playback restores its cells into the workbook now on screen, without \
         an undo entry, because transient writes never make one"
    );
}

/// The notebook runtime does not outlive its document — and it carries WHOLE
/// GRIDS.
///
/// `NotebookRuntime.checkpoints[i].grids` and `.baseline` are `Vec<Grid>`
/// snapshots of the document that ran the cells, and `notebook_rewind` assigns
/// one of them straight over `AppState.grids`. A checkpoint that outlives its
/// document is therefore a one-click replacement of the open workbook with a
/// closed one — the same shape as the undo entry, at whole-workbook scale.
#[test]
fn the_notebook_runtime_does_not_survive_the_document() {
    use crate::scripting::types::GridCheckpoint;

    let s = Stores::new();
    {
        let mut runtime = s.scripts.notebook_runtime.lock().unwrap();
        let mut snapshot = engine::grid::Grid::new();
        snapshot.set_cell(0, 0, probe_cell("A-ORIGINAL"));
        runtime.checkpoints.push(GridCheckpoint {
            cell_id: "cell-1".to_string(),
            grids: vec![snapshot.clone()],
        });
        runtime.baseline = Some(vec![snapshot]);
        runtime.execution_counter = 7;
    }
    assert_eq!(
        s.scripts.notebook_runtime.lock().unwrap().checkpoints.len(),
        1,
        "precondition: workbook A's notebook checkpoint really is held"
    );

    s.reset();

    let runtime = s.scripts.notebook_runtime.lock().unwrap();
    assert!(
        runtime.checkpoints.is_empty(),
        "the previous document's notebook CHECKPOINTS survived — each one is a \
         full `Vec<Grid>`, and a rewind writes it straight over the open \
         workbook's grids"
    );
    assert!(
        runtime.baseline.is_none(),
        "the previous document's notebook BASELINE survived: a full-rewind now \
         restores a closed workbook over the open one"
    );
    assert_eq!(
        runtime.execution_counter, 0,
        "the execution counter belongs to the notebook run that is over"
    );
}

/// Protected regions belong to the document that registered them.
///
/// Not a save source, so outside the census's invariant — but `open_file` never
/// cleared this at all, so the previous workbook's pivot, report and BI-query
/// regions went on refusing edits to cells in the workbook just opened. Both
/// callers re-register their own regions after the reset returns.
#[test]
fn protected_regions_do_not_survive_the_document_that_registered_them() {
    let s = Stores::new();
    s.state.protected_regions.lock().unwrap().push(crate::ProtectedRegion {
        id: "probe-1".to_string(),
        region_type: "bi".to_string(),
        owner_id: identity::EntityId::from_bytes(identity::generate_uuid_v7()),
        sheet_index: 0,
        start_row: 0,
        start_col: 0,
        end_row: 4,
        end_col: 4,
    });
    assert_eq!(
        s.state.protected_regions.lock().unwrap().len(),
        1,
        "precondition: a region really is registered"
    );

    s.reset();

    assert!(
        s.state.protected_regions.lock().unwrap().is_empty(),
        "the previous document's protected regions are still registered — they \
         name a pivot, report or BI query that no longer exists, and they lock \
         cells in a workbook that never had them"
    );
}

/// The reset does not empty the app's own state along with the document's.
///
/// THE COUNTERWEIGHT to every test above, and the reason it matters is not
/// symmetry: a reset that cleared everything would pass all of them. It would
/// also leave the user with no Cell Styles gallery, a reset locale — and, worst
/// of all, script execution re-armed. The line is "is this the DOCUMENT's?",
/// never "is this stateful?", and the undo stack and `permission_grants` are the
/// two ends of it: both look exactly like session state, and only one of them is.
///
/// Every field asserted here is an entry in the census's `SESSION_SCOPED` list,
/// which is where the WRITTEN reason for each lives. This is the behaviour half:
/// the list says what the decision was, this proves the code made it.
#[test]
fn the_reset_leaves_application_state_alone() {
    let s = Stores::new();
    *s.scripts.security_level.lock().unwrap() = "disabled".to_string();
    *s.scripts.mcp_access_level.lock().unwrap() = "read".to_string();
    s.scripts.permission_grants.lock().unwrap().insert(
        "script-the-user-approved".to_string(),
        vec!["net.fetch".to_string()],
    );
    *s.state.calculation_mode.lock().unwrap() = "manual".to_string();
    *s.state.precision_as_displayed.lock().unwrap() = true;
    *s.state.calculate_before_save.lock().unwrap() = false;
    *s.state.auto_recover_enabled.lock().unwrap() = false;
    *s.state.auto_recover_interval_ms.lock().unwrap() = 60_000;
    *s.state.max_iterations.lock().unwrap() = 250;
    *s.state.max_change.lock().unwrap() = 0.5;
    *s.state.subscriber_identity.lock().unwrap() = Some(
        serde_json::from_value(serde_json::json!({
            "id": "identity-probe",
            "displayName": "The Person At This Machine",
        }))
        .expect("the probe identity must deserialize"),
    );
    let locale_before = format!("{:?}", *s.state.locale.lock().unwrap());
    let reference_style_before = s.state.reference_style.lock().unwrap().clone();
    let iteration_before = *s.state.iteration_enabled.lock().unwrap();

    s.reset();

    assert_eq!(
        *s.scripts.security_level.lock().unwrap(),
        "disabled",
        "Script Security is a machine setting, not a property of the open \
         document — resetting it on File > New would silently re-enable script \
         execution the user had turned off"
    );
    assert_eq!(
        *s.scripts.mcp_access_level.lock().unwrap(),
        "read",
        "the AI tool-surface ceiling is a machine setting for the same reason \
         as Script Security: a document must not be able to widen it by being \
         opened"
    );
    assert_eq!(
        s.scripts
            .permission_grants
            .lock()
            .unwrap()
            .get("script-the-user-approved")
            .map(|g| g.as_slice()),
        Some(["net.fetch".to_string()].as_slice()),
        "THE DANGEROUS ONE. `permission_grants` holds the SESSION-scoped execute \
         approval. Clearing it looks like tidying up and is actually a security \
         decision reversed in the unsafe direction, with no prompt: the user's \
         withdrawal of consent would be silently undone by opening a file"
    );
    assert_eq!(
        *s.state.calculation_mode.lock().unwrap(),
        "manual",
        "Automatic vs Manual is the user's choice about their session; nothing \
         serialises it, and putting a user who switched to Manual back on \
         Automatic at every File > Open would undo the choice they made because \
         recalculation was too slow"
    );
    assert!(
        *s.state.precision_as_displayed.lock().unwrap(),
        "precision-as-displayed is destructive when on, so flipping it as a \
         side effect of opening a file is the one behaviour worse than leaving \
         it alone"
    );
    assert!(
        !*s.state.calculate_before_save.lock().unwrap(),
        "recalculate-before-save is a preference about what saving does, not a \
         property of the thing being saved"
    );
    assert!(
        !*s.state.auto_recover_enabled.lock().unwrap(),
        "AutoRecover is a machine-level safety net; a setting that turns itself \
         back on because a file was opened is not a setting"
    );
    assert_eq!(
        *s.state.auto_recover_interval_ms.lock().unwrap(),
        60_000,
        "the AutoRecover period travels with the AutoRecover switch"
    );
    assert_eq!(
        *s.state.max_iterations.lock().unwrap(),
        250,
        "the iteration limit is part of the iterative-calculation preference"
    );
    assert_eq!(
        *s.state.max_change.lock().unwrap(),
        0.5,
        "the convergence threshold is part of the same preference"
    );
    assert!(
        s.state.subscriber_identity.lock().unwrap().is_some(),
        "the subscriber identity is the person at this machine, loaded from the \
         Calcula profile directory — not something the open document supplies"
    );
    assert_eq!(
        format!("{:?}", *s.state.locale.lock().unwrap()),
        locale_before,
        "the locale is an application preference"
    );
    assert_eq!(
        s.state.reference_style.lock().unwrap().clone(),
        reference_style_before,
        "A1 vs R1C1 is an application preference"
    );
    assert_eq!(
        *s.state.iteration_enabled.lock().unwrap(),
        iteration_before,
        "iterative calculation is an application preference"
    );
    assert!(
        !s.state.named_styles.read().unwrap().is_empty(),
        "the Cell Styles gallery is the APP's, not the document's: the reset \
         drops the document's custom styles and must re-seed the built-ins, or \
         File > New hands the user an empty gallery"
    );
    assert!(
        s.state
            .named_styles
            .read()
            .unwrap()
            .values()
            .all(|ns| ns.built_in),
        "a custom named style from the previous document survived"
    );
}

/// WORKBOOK A'S PROMPTS DO NOT SURVIVE INTO WORKBOOK B.
///
/// `script_authoring.json` is a save source (`persist_script_authoring`), so a
/// log left resident is one workbook's prompts written into the next `.cala` the
/// user saves — attributed to a different document's script ids. This is the §2w
/// leak class with the user's own words as the payload: a prompt says what the
/// author was trying to do with their data, and a workbook you send someone must
/// not carry it out of an unrelated one.
///
/// POPULATE / assert-populated / RESET / assert-empty, because a reset test that
/// passes on an empty store proves nothing.
#[test]
fn an_authoring_transcript_does_not_survive_the_document_it_belongs_to() {
    use calcula_format::features::script_authoring::{AuthoringRun, ScriptAuthoringLog};

    let s = Stores::new();
    let mut log = ScriptAuthoringLog::new();
    log.insert(
        "obj-1".to_string(),
        vec![AuthoringRun {
            run_id: "r1".to_string(),
            kind: "edit".to_string(),
            outcome: "unchanged".to_string(),
            decision: Some("rejected".to_string()),
            decided_at: Some("2026-08-26T10:00:05Z".to_string()),
            started_at: "2026-08-26T10:00:00Z".to_string(),
            elapsed_ms: 5_000,
            instruction: "LEAK PROBE: flag the customers who are behind on payments".to_string(),
            object_type: "button".to_string(),
            provider_id: "ollama".to_string(),
            model: "qwen3:8b".to_string(),
            tier: "restricted".to_string(),
            surface_tokens: 3_200,
            surface_truncated: false,
            summary: "returned unchanged".to_string(),
            attempts: Vec::new(),
            notices: Vec::new(),
            changed_nothing: true,
            unexercised_hooks: Vec::new(),
            elided: None,
        }],
    );
    *s.state.script_authoring.write(&seed()).unwrap() = log;

    assert_eq!(
        s.state.script_authoring.read().unwrap().len(),
        1,
        "precondition: the transcript really is live before the reset"
    );

    s.reset();

    assert!(
        s.state.script_authoring.read().unwrap().is_empty(),
        "the previous document's prompts are still live after the reset, so the \
         next save writes a `script_authoring.json` naming scripts this workbook \
         does not have and words its author never typed here"
    );
}

/// The reset does not dirty the document.
///
/// Both callers assign "saved" as their last act, so a reset that marked the
/// document modified would make every File ▸ New and every freshly-opened
/// workbook prompt to save. That is what the `deliberately_clean` effect the
/// callers pass is for, and this is the test that it is really what arrives.
#[test]
fn the_reset_does_not_mark_the_document_modified() {
    let file_state = crate::persistence::FileState::default();
    assert!(
        !file_state.is_dirty(),
        "precondition: a fresh FileState is clean"
    );

    let s = Stores::new();
    reset_document_scoped_stores(
        &s.state,
        &s.user_files,
        &s.slicers,
        &s.ribbon_filters,
        &s.pane_controls,
        &s.scripts,
        &s.pivots,
        &s.bi,
        &s.timelines,
        &DocumentEffect::deliberately_clean(CleanReason::LoadingFromDisk),
    )
    .unwrap();

    assert!(
        !file_state.is_dirty(),
        "replacing the document marked it modified"
    );
}
