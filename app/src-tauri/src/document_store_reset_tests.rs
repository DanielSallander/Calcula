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
            &seed(),
        )
        .expect("the reset must not fail on healthy stores");
    }
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
        .lock()
        .unwrap()
        .insert(0, vec![3, 4, 5]);
    assert_eq!(
        s.state.advanced_filter_hidden_rows.lock().unwrap().len(),
        1,
        "precondition: rows really are hidden before the reset"
    );

    s.reset();

    assert!(
        s.state.advanced_filter_hidden_rows.lock().unwrap().is_empty(),
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
/// The counterweight to every test above: a reset that cleared everything would
/// pass all of them and leave the user with no Cell Styles gallery, no locale
/// and no script security setting. The line is "is this the DOCUMENT's?", not
/// "is this stateful?".
#[test]
fn the_reset_leaves_application_state_alone() {
    let s = Stores::new();
    *s.scripts.security_level.lock().unwrap() = "disabled".to_string();
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
        &DocumentEffect::deliberately_clean(CleanReason::LoadingFromDisk),
    )
    .unwrap();

    assert!(
        !file_state.is_dirty(),
        "replacing the document marked it modified"
    );
}
