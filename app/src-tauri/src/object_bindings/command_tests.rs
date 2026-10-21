//! FILENAME: app/src-tauri/src/object_bindings/command_tests.rs
// PURPOSE: The `object_bindings` command (D §3.9-§3.11, WP-D S3b): Set / Clear
//          dirty the document and record ONE undo step only when something
//          changes; a refusal leaves the document clean; undo/redo restore the
//          store through the SEQUENCE snapshot; a binding is never a laxer door
//          than its literal; subscribed sheets, code paths and the restricted
//          clamp are refused at the Rust door; script/AI edits are audited;
//          SetLiteral writes through each family's own core; the wire shapes;
//          and two source censuses (who may call `reevaluate`, and that every
//          store writer announces a reload).

use std::collections::{HashMap, HashSet};

use engine::{Cell, CellChange};
use serde_json::{json, Value};

use super::store::{BindingKey, BindingStoreSnapshot};
use super::*;
use crate::api_types::{
    BindingEditSource, BindingModelMeasures, ObjectBindingKind, ObjectBindingRef, ObjectBindingsRequest,
    ObjectBindingsResponse,
};
use crate::document_effect::test_seed_effect;
use crate::persistence::{FileState, UserFilesState};

const DATA: usize = 0;
const INPUTS: usize = 1;
const REPORT: usize = 2;

fn new_id() -> [u8; 16] {
    identity::generate_uuid_v7()
}

fn entity() -> identity::EntityId {
    identity::EntityId::from_bytes(new_id())
}

/// Data and Inputs are worksheets (Data active), Report is a canvas page.
struct Wb {
    state: AppState,
    file: FileState,
    files: UserFilesState,
    slicers: crate::slicer::SlicerState,
    timelines: crate::timeline_slicer::TimelineSlicerState,
    pivots: crate::pivot::types::PivotState,
    pane: crate::pane_control::PaneControlState,
    ribbon: crate::ribbon_filter::RibbonFilterState,
    ids: Vec<identity::SheetId>,
}

impl Wb {
    fn new() -> Wb {
        let state = crate::create_app_state();
        let seed = test_seed_effect();
        let ids: Vec<identity::SheetId> = (0..3).map(|_| identity::SheetId::from_bytes(new_id())).collect();
        *state.sheet_names.write(&seed).unwrap() =
            vec!["Data".to_string(), "Inputs".to_string(), "Report".to_string()];
        *state.sheet_ids.write(&seed).unwrap() = ids.clone();
        *state.sheet_kinds.write(&seed).unwrap() = vec![
            ::persistence::SheetKind::Worksheet,
            ::persistence::SheetKind::Worksheet,
            ::persistence::SheetKind::new_canvas(),
        ];
        *state.sheet_visibility.write(&seed).unwrap() = vec!["visible".to_string(); 3];
        *state.grids.write(&seed).unwrap() = vec![engine::Grid::new(), engine::Grid::new(), engine::Grid::new()];
        Wb {
            state,
            file: FileState::default(),
            files: UserFilesState::default(),
            slicers: crate::slicer::SlicerState::new(),
            timelines: crate::timeline_slicer::TimelineSlicerState::new(),
            pivots: crate::pivot::types::PivotState::new(),
            pane: crate::pane_control::PaneControlState::new(),
            ribbon: crate::ribbon_filter::RibbonFilterState::new(),
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
            user_files: &self.files,
        }
    }

    /// Send one request in its WIRE spelling (so every test also exercises the
    /// request's serde shape).
    fn send(&self, request: Value) -> Result<ObjectBindingsResponse, String> {
        self.send_with(&[], request)
    }

    fn send_with(&self, models: &[BindingModelMeasures], request: Value) -> Result<ObjectBindingsResponse, String> {
        let request: ObjectBindingsRequest =
            serde_json::from_value(request.clone()).unwrap_or_else(|e| panic!("{request} does not deserialize: {e}"));
        handle_request(&self.cx(), models, request).map(|h| h.response)
    }

    fn send_handled(&self, request: Value) -> Result<Handled, String> {
        let request: ObjectBindingsRequest = serde_json::from_value(request).expect("request");
        handle_request(&self.cx(), &[], request)
    }

    /// Write a cell the way the app keeps it (the active sheet's live mirror too).
    fn set_cell(&self, sheet: usize, row: u32, col: u32, cell: Cell) {
        let seed = test_seed_effect();
        if sheet == DATA {
            self.state.grid.write(&seed).unwrap().set_cell(row, col, cell.clone());
        }
        self.state.grids.write(&seed).unwrap()[sheet].set_cell(row, col, cell);
    }

    fn chart(&self, sheet: usize, spec: Value) -> ObjectBindingRef {
        let id = entity();
        let envelope = json!({ "chartId": id.to_string(), "name": "Revenue chart", "sheetIndex": sheet, "spec": spec });
        self.state.charts.write(&test_seed_effect()).unwrap().push(crate::api_types::ChartEntry {
            id,
            sheet_index: sheet,
            spec_json: envelope.to_string(),
        });
        ObjectBindingRef { kind: ObjectBindingKind::Chart, id: id.to_string() }
    }

    fn chart_spec(&self, object: &ObjectBindingRef) -> Value {
        let charts = self.state.charts.read().unwrap();
        let entry = charts.iter().find(|c| c.id.to_string() == object.id).expect("the chart");
        serde_json::from_str(&entry.spec_json).unwrap()
    }

    fn slicer(&self, sheet: usize) -> ObjectBindingRef {
        let id = entity();
        let slicer: crate::slicer::Slicer = serde_json::from_value(json!({
            "id": id.to_string(), "name": "Region", "headerText": "Pick a region",
            "sheetIndex": sheet, "x": 0.0, "y": 0.0, "width": 100.0, "height": 200.0,
            "sourceType": "table", "cacheSourceId": entity().to_string(), "fieldName": "Region",
            "selectedItems": null, "showHeader": true, "columns": 1, "stylePreset": "SlicerStyleLight1"
        }))
        .expect("a minimal slicer");
        self.slicers.slicers.write(&test_seed_effect()).unwrap().insert(id, slicer);
        ObjectBindingRef { kind: ObjectBindingKind::Slicer, id: id.to_string() }
    }

    fn timeline(&self, sheet: usize) -> ObjectBindingRef {
        let id = entity();
        let timeline: crate::timeline_slicer::TimelineSlicer = serde_json::from_value(json!({
            "id": id.to_string(), "name": "Order date", "sheetIndex": sheet,
            "x": 0.0, "y": 0.0, "width": 300.0, "height": 120.0,
            "sourceType": "pivot", "sourceId": entity().to_string(), "fieldName": "OrderDate",
            "showHeader": true, "showLevelSelector": true, "showScrollbar": true, "stylePreset": "TimeSlicerStyleLight1"
        }))
        .expect("a minimal timeline");
        self.timelines.timelines.write(&test_seed_effect()).unwrap().insert(id, timeline);
        ObjectBindingRef { kind: ObjectBindingKind::TimelineSlicer, id: id.to_string() }
    }

    fn page(&self) -> ObjectBindingRef {
        ObjectBindingRef { kind: ObjectBindingKind::CanvasPage, id: self.ids[REPORT].to_string() }
    }

    fn canvas_layout(&self) -> ::persistence::CanvasLayout {
        self.state.sheet_kinds.read().unwrap()[REPORT].canvas_layout().cloned().expect("Report is a canvas")
    }

    fn dirty(&self) -> bool {
        self.file.is_dirty()
    }

    fn clean(&self) {
        crate::document_effect::mark_saved(&self.file);
    }

    fn depth(&self) -> usize {
        self.state.undo_stack.lock().unwrap().undo_depth()
    }

    fn undo_description(&self) -> Option<String> {
        self.state.undo_stack.lock().unwrap().undo_description().map(str::to_string)
    }

    fn apply(&self, transaction: engine::Transaction, is_undo: bool) {
        crate::undo_commands::apply_changes(
            &self.state,
            &self.file,
            &self.files,
            &self.pivots,
            &self.slicers,
            &self.ribbon,
            &self.pane,
            &self.timelines,
            transaction,
            is_undo,
        );
    }

    fn undo(&self) {
        let t = self.state.undo_stack.lock().unwrap().pop_undo().expect("nothing to undo");
        self.apply(t, true);
    }

    fn redo(&self) {
        let t = self.state.undo_stack.lock().unwrap().pop_redo().expect("nothing to redo");
        self.apply(t, false);
    }

    fn rows(&self) -> Vec<::persistence::SavedObjectBinding> {
        self.state.object_bindings.read().unwrap().snapshot().rows
    }

    fn generation(&self) -> u64 {
        self.state.object_bindings.read().unwrap().generation
    }

    fn protect(&self, sheet: usize) {
        self.state.sheet_protection.write(&test_seed_effect()).unwrap().insert(
            sheet,
            crate::protection::SheetProtection { protected: true, ..Default::default() },
        );
    }

    fn lock_objects(&self, sheet: usize) {
        let mut kinds = self.state.sheet_kinds.write(&test_seed_effect()).unwrap();
        if let ::persistence::SheetKind::Canvas(layout) = &mut kinds[sheet] {
            layout.objects_locked = true;
        } else {
            panic!("sheet {sheet} is not a canvas");
        }
    }

    /// Record that sheet `index` came from a subscribed application.
    fn subscribe(&self, index: usize) {
        let seed = test_seed_effect();
        let name = self.state.sheet_names.read().unwrap()[index].clone();
        let mut subs = self.state.subscriptions.write(&seed).unwrap();
        subs.subscriptions.push(calp::manifest::Subscription {
            package_name: "sales.report".to_string(),
            registry_url: "C:/workspace".to_string(),
            version_pin: "latest".to_string(),
            resolved_version: "1.0.0".to_string(),
            resolved_at: "2026-10-15T00:00:00Z".to_string(),
            sheets: vec![calp::manifest::SubscribedSheet {
                package_sheet_id: identity::SheetId::from_bytes(new_id()),
                local_sheet_id: self.ids[index],
                local_name: name,
                extra: HashMap::new(),
            }],
            environment: None,
            data_source_configs: Vec::new(),
            objects: Vec::new(),
            detached_sheets: Vec::new(),
            detached_local_sheets: Vec::new(),
            upstream_removed_sheets: Vec::new(),
            extra: HashMap::new(),
        });
    }

    fn audit_rows(&self) -> Vec<calp::audit::AuditEntry> {
        self.state.audit_log.read().unwrap().entries.clone()
    }
}

fn set_req(object: &ObjectBindingRef, path: &str, formula: &str) -> Value {
    json!({ "op": "set", "object": object, "path": path, "formula": formula, "invariant": true })
}

fn set_req_from(object: &ObjectBindingRef, path: &str, formula: &str, source: Value) -> Value {
    json!({ "op": "set", "object": object, "path": path, "formula": formula, "invariant": true, "source": source })
}

fn clear_req(object: &ObjectBindingRef, path: &str) -> Value {
    json!({ "op": "clear", "object": object, "path": path })
}

fn literal_req(object: &ObjectBindingRef, path: &str, value: Value) -> Value {
    json!({ "op": "setLiteral", "object": object, "path": path, "value": value })
}

fn binding_of(response: ObjectBindingsResponse) -> crate::api_types::ObjectBindingInfo {
    match response {
        ObjectBindingsResponse::Binding { binding } => binding,
        other => panic!("expected a binding, got {other:?}"),
    }
}

fn domains_of(response: ObjectBindingsResponse) -> Vec<String> {
    match response {
        ObjectBindingsResponse::LiteralSet { domains } => domains,
        other => panic!("expected literalSet, got {other:?}"),
    }
}

fn one_model() -> Vec<BindingModelMeasures> {
    vec![BindingModelMeasures {
        model_key: "aw-model".to_string(),
        connection_id: entity().to_string(),
        name: "AW".to_string(),
        measures: vec!["Revenue".to_string(), "% Revenue of Total".to_string()],
        is_default: true,
    }]
}

// ===========================================================================
// Set / Clear: dirty, undo, and the no-op and refusal paths
// ===========================================================================

#[test]
fn set_marks_dirty_and_records_one_undo_step() {
    let wb = Wb::new();
    wb.set_cell(DATA, 0, 0, Cell::new_text("Revenue".to_string()));
    let chart = wb.chart(DATA, json!({ "title": "static" }));
    assert!(!wb.dirty() && wb.depth() == 0, "precondition: a clean workbook with no history");

    let info = binding_of(wb.send(set_req(&chart, "/spec/title", "=Data!A1")).expect("set"));
    assert_eq!(info.formula, "=Data!A1");
    assert_eq!(info.display_formula, "=Data!A1");
    assert_eq!(info.resolved.as_ref().map(|r| r.value.clone()), Some(json!("Revenue")), "{info:?}");

    assert!(wb.dirty(), "a new binding is a document edit");
    assert_eq!(wb.depth(), 1, "exactly one undo step");
    assert_eq!(wb.undo_description().as_deref(), Some("Bind property"));
    assert_eq!(wb.rows().len(), 1);
    assert_eq!(wb.chart_spec(&chart)["spec"]["title"], "static", "the LITERAL is untouched: one spelling per fact");
}

#[test]
fn setting_the_same_formula_twice_changes_nothing() {
    let wb = Wb::new();
    let chart = wb.chart(DATA, json!({}));
    wb.send(set_req(&chart, "/spec/title", "=Data!A1")).unwrap();
    wb.clean();
    let (depth, generation) = (wb.depth(), wb.generation());

    // The same formula -- and a spelling that NORMALISES to it (unqualified on
    // the chart's own worksheet).
    wb.send(set_req(&chart, "/spec/title", "=Data!A1")).unwrap();
    wb.send(set_req(&chart, "/spec/title", "=A1")).unwrap();
    assert!(!wb.dirty(), "setting what is already stored is not an edit");
    assert_eq!(wb.depth(), depth, "and records no undo step");
    assert_eq!(wb.generation(), generation, "and does not even touch the store");
}

#[test]
fn a_refused_set_leaves_the_document_clean() {
    let wb = Wb::new();
    let chart = wb.chart(DATA, json!({}));
    let refusals = [
        ("/spec/mark", "=Data!A1", "not a bindable property"),
        ("/spec/title", "=SUM(", "could not be read"),
        ("/spec/title", "=Nowhere!A1", "no sheet named"),
        ("/spec/title", "Data!A1", "starts with '='"),
        ("/spec/title", "=[Revenue]", "no data model"),
    ];
    for (path, formula, needle) in refusals {
        let err = wb.send(set_req(&chart, path, formula)).unwrap_err();
        assert!(err.contains(needle), "{path} {formula}: {err}");
    }
    let missing = ObjectBindingRef { kind: ObjectBindingKind::Chart, id: entity().to_string() };
    assert!(wb.send(set_req(&missing, "/spec/title", "=Data!A1")).unwrap_err().contains("There is no chart"));
    assert!(!wb.dirty(), "no refusal may dirty the document");
    assert_eq!(wb.depth(), 0, "no refusal may record an undo step");
    assert!(wb.rows().is_empty());
}

#[test]
fn clear_removes_the_binding_and_records_one_step() {
    let wb = Wb::new();
    let chart = wb.chart(DATA, json!({}));
    wb.send(set_req(&chart, "/spec/title", "=Data!A1")).unwrap();
    wb.clean();
    let depth = wb.depth();

    let removed = wb.send(clear_req(&chart, "/spec/title")).unwrap();
    assert!(matches!(removed, ObjectBindingsResponse::Cleared { removed: true }), "{removed:?}");
    assert!(wb.rows().is_empty());
    assert!(wb.dirty());
    assert_eq!(wb.depth(), depth + 1);
    assert_eq!(wb.undo_description().as_deref(), Some("Remove property binding"));
    assert!(
        wb.state.object_binding_runtime.lock().unwrap().resolved.is_empty(),
        "a removed binding leaves no resolved value behind"
    );
}

#[test]
fn clear_of_an_absent_binding_changes_nothing() {
    let wb = Wb::new();
    let chart = wb.chart(DATA, json!({}));
    let r = wb.send(clear_req(&chart, "/spec/title")).unwrap();
    assert!(matches!(r, ObjectBindingsResponse::Cleared { removed: false }));
    assert!(!wb.dirty());
    assert_eq!(wb.depth(), 0);
}

#[test]
fn clear_of_an_orphan_skips_the_object_gates() {
    let wb = Wb::new();
    let chart = wb.chart(DATA, json!({}));
    wb.send(set_req(&chart, "/spec/title", "=Data!A1")).unwrap();
    // The chart goes away (a cascade is S5b's); its sheet becomes protected.
    wb.state.charts.write(&test_seed_effect()).unwrap().clear();
    wb.protect(DATA);
    let r = wb.send(clear_req(&chart, "/spec/title")).expect("an orphan can always be cleared");
    assert!(matches!(r, ObjectBindingsResponse::Cleared { removed: true }));
}

// ===========================================================================
// Undo / redo through the SEQUENCE snapshot (D §3.10)
// ===========================================================================

#[test]
fn bindings_undo_snapshot_round_trips() {
    let wb = Wb::new();
    let chart = wb.chart(DATA, json!({}));
    wb.send(set_req(&chart, "/spec/title", "=Data!A1")).unwrap();
    let after_set = wb.rows();
    assert_eq!(after_set.len(), 1);

    // The recorded restore is the obj_bindings kind and its bytes are a
    // NON-EMPTY delta naming ONLY the key the step changed, with its value
    // before the step (empty bytes would be a silently dead step).
    let transaction = wb.state.undo_stack.lock().unwrap().pop_undo().expect("a step");
    let restores: Vec<(&String, &Vec<u8>)> = transaction
        .changes
        .iter()
        .filter_map(|c| match c {
            CellChange::CustomRestore { kind, data } => Some((kind, data)),
            _ => None,
        })
        .collect();
    assert_eq!(restores.len(), 1, "{restores:?}");
    assert_eq!(restores[0].0, "obj_bindings");
    assert!(!restores[0].1.is_empty(), "the snapshot bytes must not be empty");
    let decoded: super::store::BindingDelta = serde_json::from_slice(restores[0].1).expect("a binding delta");
    assert_eq!(decoded.rows.len(), 1, "only the key the set changed: {decoded:?}");
    assert_eq!(decoded.rows[0].key.path, "/spec/title");
    assert_eq!(decoded.rows[0].previous, None, "the restore holds the key as it was BEFORE the set: unbound");

    let generation = wb.generation();
    wb.apply(transaction, true);
    assert!(wb.rows().is_empty(), "undo removes the binding");
    assert!(wb.generation() > generation, "the undo arm bumps the generation (the runtime rebuilds)");

    wb.redo();
    assert_eq!(wb.rows(), after_set, "redo restores the edit exactly");
    wb.undo();
    assert!(wb.rows().is_empty());
}

#[test]
fn undo_of_a_clear_brings_the_binding_back() {
    let wb = Wb::new();
    let chart = wb.chart(DATA, json!({}));
    wb.send(set_req(&chart, "/spec/title", "=Data!A1")).unwrap();
    let rows = wb.rows();
    wb.send(clear_req(&chart, "/spec/title")).unwrap();
    wb.undo();
    assert_eq!(wb.rows(), rows);
}

#[test]
fn set_joins_an_open_transaction() {
    let wb = Wb::new();
    let chart = wb.chart(DATA, json!({}));
    wb.state.undo_stack.lock().unwrap().begin_transaction("Format pane".to_string());
    wb.send(set_req(&chart, "/spec/title", "=Data!A1")).unwrap();
    wb.send(set_req(&chart, "/spec/xAxis/title", "=Data!A2")).unwrap();
    wb.state.undo_stack.lock().unwrap().commit_transaction();
    assert_eq!(wb.depth(), 1, "two binds inside one transaction are ONE undo step");
    wb.undo();
    assert!(wb.rows().is_empty(), "and one Ctrl+Z takes both back");
}

// ===========================================================================
// A binding is never a laxer door than its literal (invariant 9)
// ===========================================================================

/// The (Set, SetLiteral, Clear) outcomes for one path, compared: refused
/// together with the SAME sentence, or allowed together.
fn assert_same_door(wb: &Wb, object: &ObjectBindingRef, path: &str, formula: &str, literal: Value, refused: bool) {
    // The binding Clear needs a binding to exist: made while the gate is off.
    let set = wb.send(set_req(object, path, formula));
    let lit = wb.send(literal_req(object, path, literal));
    assert_eq!(set.is_err(), refused, "Set {path}: {set:?}");
    assert_eq!(lit.is_err(), refused, "SetLiteral {path}: {lit:?}");
    if refused {
        assert_eq!(set.unwrap_err(), lit.unwrap_err(), "the binding refuses with the family's own sentence");
    }
}

#[test]
fn a_binding_is_never_a_laxer_door_than_its_literal() {
    // Chart title on a sheet protected without editObjects: both refused.
    let wb = Wb::new();
    let chart = wb.chart(DATA, json!({ "mark": "bar", "data": "Data!A1:B3", "series": [] }));
    wb.send(set_req(&chart, "/spec/title", "=Data!A1")).expect("allowed while unprotected");
    wb.protect(DATA);
    wb.clean();
    assert_same_door(&wb, &chart, "/spec/title", "=Data!A2", json!("Literal"), true);
    let clear = wb.send(clear_req(&chart, "/spec/title")).unwrap_err();
    assert!(clear.contains("protected sheet"), "Clear changes what is painted: gated too: {clear}");
    assert!(!wb.dirty() && wb.rows().len() == 1, "nothing changed");

    // Canvas page background on a protected canvas: both refused.
    let wb = Wb::new();
    let page = wb.page();
    wb.send(set_req(&page, "/background", "=Inputs!B3")).expect("allowed while unprotected");
    wb.protect(REPORT);
    assert_same_door(&wb, &page, "/background", "=Inputs!B4", json!("#112233"), true);
    assert!(wb.send(clear_req(&page, "/background")).unwrap_err().contains("protected sheet"));

    // A slicer's header has NO editObjects gate on its literal door
    // (update_slicer_core), so the binding has none either: both allowed.
    let wb = Wb::new();
    let slicer = wb.slicer(REPORT);
    wb.protect(REPORT);
    assert_same_door(&wb, &slicer, "/headerText", "=Inputs!B1", json!("Region"), false);

    // A timeline likewise.
    let wb = Wb::new();
    let timeline = wb.timeline(REPORT);
    wb.protect(REPORT);
    assert_same_door(&wb, &timeline, "/showHeader", "=Inputs!B1>0", json!(false), false);

    // Unprotected, everything is allowed (non-vacuity of the refusals above).
    let wb = Wb::new();
    let chart = wb.chart(DATA, json!({ "mark": "bar", "data": "Data!A1:B3", "series": [] }));
    assert_same_door(&wb, &chart, "/spec/title", "=Data!A2", json!("Literal"), false);
    let page = wb.page();
    assert_same_door(&wb, &page, "/background", "=Inputs!B4", json!("#112233"), false);
}

/// The CONTROL half of the laxer-door test (rotation on an editObjects-
/// protected sheet; width on a Lock-Objects canvas; rotation on a Lock-Objects
/// canvas allowed for both). A control is named by its stable `uid` (WP-D S5a).
#[test]
fn a_control_binding_is_never_a_laxer_door_than_its_literal() {
    let make = |wb: &Wb| -> ObjectBindingRef {
        let meta: crate::controls::ControlMetadata = serde_json::from_value(json!({
            "controlType": "shape",
            "uid": "control-uid-1",
            "properties": {
                "rotation": { "valueType": "static", "value": "0" },
                "width": { "valueType": "static", "value": "120" },
                "pinToGrid": { "valueType": "static", "value": "false" }
            }
        }))
        .expect("a control");
        assert_eq!(super::object_json::control_uid(&meta), Some("control-uid-1"), "controls carry a uid");
        wb.state.controls.write(&test_seed_effect()).unwrap().insert((REPORT, 0, 0), meta);
        ObjectBindingRef { kind: ObjectBindingKind::Control, id: "control-uid-1".to_string() }
    };

    let wb = Wb::new();
    let control = make(&wb);
    wb.protect(REPORT);
    assert_same_door(&wb, &control, "/properties/rotation", "=Inputs!B1", json!(45), true);

    let wb = Wb::new();
    let control = make(&wb);
    wb.lock_objects(REPORT);
    assert_same_door(&wb, &control, "/properties/width", "=Inputs!B1", json!(200), true);
    assert_same_door(&wb, &control, "/properties/rotation", "=Inputs!B1", json!(45), false);

    // SetLiteral on a control records ONE undo step (the arm's own record).
    let wb = Wb::new();
    let control = make(&wb);
    let depth = wb.depth();
    wb.send(literal_req(&control, "/properties/fill", json!("#FF0000"))).unwrap();
    assert_eq!(wb.depth(), depth + 1);
    assert_eq!(wb.undo_description().as_deref(), Some("Set property"));
}

#[test]
fn binding_refused_on_a_subscribed_sheet() {
    let wb = Wb::new();
    let chart = wb.chart(INPUTS, json!({}));
    wb.subscribe(INPUTS);
    let err = wb.send(set_req(&chart, "/spec/title", "=Inputs!A1")).unwrap_err();
    assert!(err.contains("sales.report") && err.contains("Detach"), "{err}");
    assert!(wb.send(clear_req(&chart, "/spec/title")).unwrap_err().contains("sales.report"));
    assert!(!wb.dirty() && wb.depth() == 0);

    // The same chart on an unsubscribed sheet is fine (non-vacuity).
    let wb = Wb::new();
    let chart = wb.chart(INPUTS, json!({}));
    wb.send(set_req(&chart, "/spec/title", "=Inputs!A1")).expect("unsubscribed");
}

#[test]
fn executable_and_action_paths_refused_at_the_rust_door() {
    let wb = Wb::new();
    let control = ObjectBindingRef { kind: ObjectBindingKind::Control, id: "any".to_string() };
    for (path, needle) in [
        ("/properties/onSelect", "is code"),
        ("/properties/macroRef", "is code"),
        ("/properties/heldOnSelect", "code compartment"),
        ("/properties/action", "action wiring"),
        ("/properties/actionTarget", "action wiring"),
        ("/properties/x", "position is not bindable"),
        ("/properties/name", "identity"),
    ] {
        let set = wb.send(set_req(&control, path, "=Data!A1")).unwrap_err();
        assert!(set.contains(needle), "Set {path}: {set}");
        let lit = wb.send(literal_req(&control, path, json!("x"))).unwrap_err();
        assert!(lit.contains(needle), "SetLiteral {path}: {lit}");
    }
    assert!(!wb.dirty() && wb.depth() == 0);
}

// ===========================================================================
// Restricted clamp (defence in depth) and audit rows
// ===========================================================================

#[test]
fn restricted_script_source_is_clamped_in_rust() {
    let wb = Wb::new();
    let chart = wb.chart(DATA, json!({}));
    let restricted = json!({ "kind": "script", "scriptId": "s-1", "unlocked": false });
    // Data is the active sheet.
    // `'*'!A1` is the all-sheets wildcard: it names no sheet but reads them all.
    for formula in ["=Inputs!B1", "=Rate*2", "=INDIRECT(\"Data!A1\")", "=SUM(Data!A1, Inputs!A1)", "=SUM('*'!A1)"] {
        let err = wb.send(set_req_from(&chart, "/spec/title", formula, restricted.clone())).unwrap_err();
        assert_eq!(err, RESTRICTED_BINDING_CLAMP_MESSAGE, "{formula}");
    }
    assert!(wb.rows().is_empty() && !wb.dirty(), "a clamped set changes nothing");

    // Cells of the sheet in front of the user are fine, qualified or not.
    wb.send(set_req_from(&chart, "/spec/title", "=Data!A1", restricted.clone())).expect("own sheet");
    wb.send(set_req_from(&chart, "/spec/xAxis/title", "=A2", restricted)).expect("own sheet, unqualified");
    // An UNLOCKED script may read any sheet.
    let unlocked = json!({ "kind": "script", "scriptId": "s-1", "unlocked": true });
    wb.send(set_req_from(&chart, "/spec/yAxis/title", "=Inputs!B1", unlocked)).expect("unlocked");
}

fn rows_with_surface(wb: &Wb, surface: &str) -> Vec<calp::audit::AuditEntry> {
    wb.audit_rows().into_iter().filter(|e| e.extra.get("surface") == Some(&json!(surface))).collect()
}

#[test]
fn script_and_ai_binding_edits_are_audited_accepted_or_refused() {
    let wb = Wb::new();
    let chart = wb.chart(DATA, json!({}));
    let script = json!({ "kind": "script", "scriptId": "s-9", "unlocked": false });
    wb.send(set_req_from(&chart, "/spec/title", "=Data!A1", script.clone())).unwrap();
    wb.send(set_req_from(&chart, "/spec/title", "=Inputs!A1", script.clone())).unwrap_err();
    wb.send(json!({ "op": "clear", "object": chart, "path": "/spec/title", "source": script })).unwrap();

    let rows = rows_with_surface(&wb, audit::SCRIPT_BINDING_SURFACE);
    assert_eq!(rows.len(), 3, "{rows:?}");
    assert_eq!(rows[0].extra["op"], "bindingSet");
    assert_eq!(rows[0].extra["ok"], true);
    assert_eq!(rows[0].extra["formula"], "=Data!A1");
    assert_eq!(rows[0].extra["scriptId"], "s-9");
    assert_eq!(rows[1].extra["ok"], false, "a refused attempt is recorded too");
    assert_eq!(rows[1].extra["error"], RESTRICTED_BINDING_CLAMP_MESSAGE);
    assert_eq!(rows[2].extra["op"], "bindingClear");
    assert_eq!(rows[2].extra["formula"], "=Data!A1", "the clear names what it removed");

    let ai = json!({ "kind": "ai", "tool": "set_object_binding" });
    wb.send(set_req_from(&chart, "/spec/title", "=Inputs!A1", ai.clone())).unwrap();
    wb.send(set_req_from(&chart, "/spec/mark", "=Inputs!A1", ai)).unwrap_err();
    let mcp = rows_with_surface(&wb, "mcp");
    assert_eq!(mcp.len(), 2, "{mcp:?}");
    assert!(mcp.iter().all(|r| r.extra["tool"] == "set_object_binding"));
    assert_eq!((mcp[0].extra["ok"].clone(), mcp[1].extra["ok"].clone()), (json!(true), json!(false)));

    // An ordinary user edit records nothing.
    let before = wb.audit_rows().len();
    wb.send(set_req(&chart, "/spec/xAxis/title", "=Data!A1")).unwrap();
    assert_eq!(wb.audit_rows().len(), before);
}

// ===========================================================================
// SetLiteral through each family's own core
// ===========================================================================

#[test]
fn set_literal_on_a_chart_writes_the_spec_through_update_chart() {
    let wb = Wb::new();
    let chart = wb.chart(DATA, json!({ "title": "Old", "series": [{ "name": "2024" }] }));
    let domains = domains_of(wb.send(literal_req(&chart, "/spec/title", json!("New"))).unwrap());
    assert_eq!(domains, vec!["objects".to_string()]);
    assert_eq!(wb.chart_spec(&chart)["spec"]["title"], "New");
    assert!(wb.dirty());
    assert_eq!(wb.undo_description().as_deref(), Some("Edit chart"), "the family core's own undo");

    // A missing parent object is created; a missing ARRAY item is refused.
    wb.send(literal_req(&chart, "/spec/xAxis/min", json!(5))).unwrap();
    assert_eq!(wb.chart_spec(&chart)["spec"]["xAxis"]["min"], 5.0);
    let err = wb.send(literal_req(&chart, "/spec/series/3/name", json!("x"))).unwrap_err();
    assert!(err.contains("does not exist"), "{err}");
    wb.send(literal_req(&chart, "/spec/series/0/name", json!("2025"))).unwrap();
    assert_eq!(wb.chart_spec(&chart)["spec"]["series"][0]["name"], "2025");

    // The same value again is no edit at all.
    wb.clean();
    let depth = wb.depth();
    assert!(domains_of(wb.send(literal_req(&chart, "/spec/title", json!("New"))).unwrap()).is_empty());
    assert!(!wb.dirty() && wb.depth() == depth);

    // A value of the wrong type is refused before anything is written.
    let err = wb.send(literal_req(&chart, "/spec/xAxis/max", json!("lots"))).unwrap_err();
    assert!(err.contains("takes a number"), "{err}");
    let err = wb.send(literal_req(&chart, "/spec/markOptions/displayUnits", json!("zillions"))).unwrap_err();
    assert!(err.contains("is not one of"), "{err}");
    assert!(!wb.dirty());
}

#[test]
fn set_literal_on_a_slicer_and_a_timeline_goes_through_their_cores() {
    let wb = Wb::new();
    let slicer = wb.slicer(REPORT);
    let domains = domains_of(wb.send(literal_req(&slicer, "/headerText", json!("Territory"))).unwrap());
    assert_eq!(domains, vec!["slicer".to_string()]);
    let id = identity::EntityId::parse(&slicer.id).unwrap();
    assert_eq!(wb.slicers.slicers.read().unwrap()[&id].header_text.as_deref(), Some("Territory"));
    assert_eq!(wb.undo_description().as_deref(), Some("Update slicer"));
    wb.send(literal_req(&slicer, "/showHeader", json!(false))).unwrap();
    assert!(!wb.slicers.slicers.read().unwrap()[&id].show_header);

    let timeline = wb.timeline(REPORT);
    let depth = wb.depth();
    wb.send(literal_req(&timeline, "/showHeader", json!(false))).unwrap();
    let tid = identity::EntityId::parse(&timeline.id).unwrap();
    assert!(!wb.timelines.timelines.read().unwrap()[&tid].show_header);
    assert_eq!(wb.depth(), depth + 1);
    assert_eq!(wb.undo_description().as_deref(), Some("Update timeline slicer"));
    wb.send(literal_req(&timeline, "/headerText", json!("When"))).unwrap();
    assert_eq!(wb.timelines.timelines.read().unwrap()[&tid].header_text.as_deref(), Some("When"));
}

#[test]
fn set_literal_on_a_canvas_page_announces_its_layout() {
    let wb = Wb::new();
    let page = wb.page();
    let handled = wb.send_handled(literal_req(&page, "/background", json!("#112233"))).unwrap();
    assert!(matches!(&handled.response, ObjectBindingsResponse::LiteralSet { domains } if domains == &["sheets"]));
    let layout = handled.layout.expect("a page write owes the canvas-layout announcement");
    assert_eq!(layout.layout.background, "#112233");
    assert_eq!(wb.canvas_layout().background, "#112233");
    assert!(wb.dirty());

    // "" restores the theme's colour; an invalid colour is refused.
    wb.send(literal_req(&page, "/background", json!(""))).unwrap();
    assert_eq!(wb.canvas_layout().background, "");
    assert!(wb.send(literal_req(&page, "/wallpaper", json!("blue-ish"))).unwrap_err().contains("is not a colour"));
}

#[test]
fn coerce_literal_references_media_never_introduces_it() {
    use super::catalog::BindableValueType as T;
    use super::literal::coerce_literal;
    let hash = "a".repeat(64);
    let exists = |h: &str| h == "a".repeat(64);
    assert_eq!(coerce_literal(T::Media, &json!(format!("media:{hash}")), &exists).unwrap(), json!(format!("media:{hash}")));
    assert_eq!(coerce_literal(T::Media, &json!(""), &exists).unwrap(), json!(""));
    assert!(coerce_literal(T::Media, &json!("data:image/png;base64,AAAA"), &exists).unwrap_err().contains("data: URI"));
    assert!(coerce_literal(T::Media, &json!(format!("media:{}", "b".repeat(64))), &exists).unwrap_err().contains("names no media"));
    assert!(coerce_literal(T::Integer, &json!(2.5), &exists).is_err());
    assert_eq!(coerce_literal(T::Integer, &json!(3.0), &exists).unwrap(), json!(3));
    assert_eq!(coerce_literal(T::Enum(&["left", "center"]), &json!("CENTER"), &exists).unwrap(), json!("center"));
    assert!(coerce_literal(T::Text, &json!("x".repeat(9_000)), &exists).is_err());
    assert_eq!(coerce_literal(T::Text, &Value::Null, &exists).unwrap(), Value::Null);
    assert_eq!(super::literal::control_property_string(&json!(1.0)), "1");
    assert_eq!(super::literal::control_property_string(&json!(1.25)), "1.25");
    assert_eq!(super::literal::control_property_string(&json!(true)), "true");
}

// ===========================================================================
// Reads and runtime-only ops
// ===========================================================================

#[test]
fn list_returns_bindings_with_their_values_and_display_formula() {
    let wb = Wb::new();
    *wb.state.locale.lock().unwrap() = engine::LocaleSettings::from_locale_id("sv-SE");
    wb.set_cell(DATA, 0, 0, Cell::new_number(1.26));
    let chart = wb.chart(DATA, json!({}));
    // A PERSON's text (no invariant flag) in sv-SE: ';' separates arguments.
    let request = json!({ "op": "set", "object": chart, "path": "/spec/xAxis/min", "formula": "=ROUND(Data!A1;1)" });
    let info = binding_of(wb.send(request).unwrap());
    assert_eq!(info.formula, "=ROUND(Data!A1,1)", "stored INVARIANT");
    assert_eq!(info.display_formula, "=ROUND(Data!A1;1)", "shown in the person's locale");

    let other = wb.chart(DATA, json!({}));
    wb.send(set_req(&other, "/spec/title", "=Data!A1")).unwrap();
    let all = match wb.send(json!({ "op": "list" })).unwrap() {
        ObjectBindingsResponse::Bindings { bindings } => bindings,
        r => panic!("{r:?}"),
    };
    assert_eq!(all.len(), 2);
    let one = match wb.send(json!({ "op": "list", "object": chart })).unwrap() {
        ObjectBindingsResponse::Bindings { bindings } => bindings,
        r => panic!("{r:?}"),
    };
    assert_eq!(one.len(), 1);
    assert_eq!(one[0].resolved.as_ref().unwrap().value, json!(1.3));
}

/// P2 S5: a computed (not single-cell) binding's DISPLAY is General in the
/// APP locale -- a de-DE title reads "1234,5", never the invariant "1234.5".
/// The typed value stays the number.
#[test]
fn a_computed_bindings_display_reads_in_the_app_locale() {
    let wb = Wb::new();
    *wb.state.locale.lock().unwrap() = engine::LocaleSettings::from_locale_id("de-DE");
    let chart = wb.chart(DATA, json!({}));
    // No separator in the formula, so it parses the same in every locale.
    let info = binding_of(wb.send(set_req(&chart, "/spec/xAxis/min", "=12345/10")).unwrap());
    let resolved = info.resolved.expect("the binding resolves");
    assert_eq!(resolved.value, json!(1234.5));
    assert_eq!(resolved.display, "1234,5", "General in the app locale");

    *wb.state.locale.lock().unwrap() = engine::LocaleSettings::invariant();
    let all = match wb.send(json!({ "op": "resolveAll" })).unwrap() {
        ObjectBindingsResponse::Resolved { values } => values,
        r => panic!("{r:?}"),
    };
    assert_eq!(all[0].display, "1234.5");
}

#[test]
fn runtime_ops_never_dirty_and_never_record_undo() {
    let wb = Wb::new();
    wb.set_cell(INPUTS, 0, 0, Cell::new_number(1.0));
    let chart = wb.chart(DATA, json!({}));
    wb.send(set_req(&chart, "/spec/xAxis/min", "=Inputs!A1")).unwrap();
    wb.clean();
    let depth = wb.depth();

    wb.set_cell(INPUTS, 0, 0, Cell::new_number(2.0));
    let changed = match wb.send(json!({ "op": "cellsChanged", "cells": [{ "sheetIndex": INPUTS, "row": 0, "col": 0 }] })).unwrap() {
        ObjectBindingsResponse::Resolved { values } => values,
        r => panic!("{r:?}"),
    };
    assert_eq!(changed.len(), 1, "the binding that reads Inputs!A1 moved");
    assert_eq!(changed[0].value, json!(2.0));

    let all = match wb.send(json!({ "op": "resolveAll" })).unwrap() {
        ObjectBindingsResponse::Resolved { values } => values,
        r => panic!("{r:?}"),
    };
    assert_eq!(all.len(), 1, "ResolveAll answers with EVERY value");
    wb.send(json!({ "op": "cellsChanged", "cells": null })).unwrap();
    wb.send(json!({ "op": "refreshMeasures", "sheetIndex": REPORT })).unwrap();
    wb.send(json!({ "op": "refreshMeasures" })).unwrap();
    wb.send(json!({ "op": "setPageFilters", "pages": [
        { "sheetId": wb.ids[REPORT].to_string(), "connectionId": "c-1", "filters": [{ "field": "BI.dim_territory.territorygroup", "includedItems": ["Europe"], "filterLevel": 1 }] }
    ] }))
    .unwrap();
    assert!(!wb.dirty(), "resolved values and the page-filter mirror are transient");
    assert_eq!(wb.depth(), depth, "and never enter undo");
}

#[test]
fn set_page_filters_replaces_the_mirror_and_reports_changed_pages() {
    let wb = Wb::new();
    let page = |items: &[&str]| -> Vec<crate::api_types::PageFilterPageWire> {
        vec![crate::api_types::PageFilterPageWire {
            sheet_id: wb.ids[REPORT],
            connection_id: "c-1".to_string(),
            filters: vec![crate::api_types::PageFilterWire {
                field: "BI.dim_territory.territorygroup".to_string(),
                included_items: items.iter().map(|s| s.to_string()).collect(),
                filter_level: 1,
            }],
            tuple_filters: Vec::new(),
            objects: Vec::new(),
        }]
    };
    assert_eq!(set_page_filters_core(&wb.cx(), page(&["Europe"])), vec![wb.ids[REPORT]]);
    assert!(set_page_filters_core(&wb.cx(), page(&["Europe"])).is_empty(), "the same snapshot changes no page");
    assert_eq!(set_page_filters_core(&wb.cx(), page(&["Pacific"])), vec![wb.ids[REPORT]]);
    assert_eq!(set_page_filters_core(&wb.cx(), Vec::new()), vec![wb.ids[REPORT]], "a page whose filters went away changed");
    assert!(wb.state.object_binding_runtime.lock().unwrap().page_filters.is_empty(), "the snapshot REPLACES the mirror");
}

#[test]
fn analyze_reports_a_refusal_inside_the_analysis() {
    let wb = Wb::new();
    let chart = wb.chart(REPORT, json!({}));
    let ok = match wb.send_with(&one_model(), json!({ "op": "analyze", "object": chart, "formula": "=Inputs!B1&TEXT([Revenue],\"#,##0\")", "invariant": true })).unwrap() {
        ObjectBindingsResponse::Analysis { analysis } => analysis,
        r => panic!("{r:?}"),
    };
    assert_eq!(ok.error, None);
    assert_eq!(ok.measure_refs, vec!["Revenue".to_string()]);
    assert_eq!(ok.model.as_deref(), Some("aw-model"));
    assert_eq!(ok.sheets, vec![INPUTS]);

    let refused = match wb.send_with(&one_model(), json!({ "op": "analyze", "object": chart, "formula": "=[Profit]", "invariant": true })).unwrap() {
        ObjectBindingsResponse::Analysis { analysis } => analysis,
        r => panic!("{r:?}"),
    };
    assert!(refused.error.as_deref().unwrap().contains("There is no measure [Profit]"), "{refused:?}");
    assert_eq!(refused.normalized, "=[Profit]");
    assert!(!wb.dirty() && wb.rows().is_empty(), "Analyze is a read");

    let missing = ObjectBindingRef { kind: ObjectBindingKind::Chart, id: entity().to_string() };
    assert!(wb.send(json!({ "op": "analyze", "object": missing, "formula": "=1" })).is_err());
}

/// The analysis a caller GATES on (the script executor decides `bi.query` and
/// the restricted clamp from it, D §3.19) must be the one `Set` applies. On a
/// page offering two models, `[Revenue]` with no model is "say which one";
/// the same formula analysed with the model `Set` will be given is not.
#[test]
fn analyze_takes_the_model_set_would_be_given() {
    let wb = Wb::new();
    let chart = wb.chart(REPORT, json!({}));
    let mut models = one_model();
    models[0].is_default = false;
    models.push(BindingModelMeasures {
        model_key: "second-model".to_string(),
        connection_id: entity().to_string(),
        name: "Second".to_string(),
        measures: vec!["Revenue".to_string()],
        is_default: false,
    });
    let analysis_of = |request: Value| match wb.send_with(&models, request).unwrap() {
        ObjectBindingsResponse::Analysis { analysis } => analysis,
        r => panic!("{r:?}"),
    };

    let unnamed = analysis_of(json!({ "op": "analyze", "object": chart, "formula": "=[Revenue]", "invariant": true }));
    assert!(unnamed.error.as_deref().unwrap_or("").contains("say which one"), "{unnamed:?}");

    let named = analysis_of(json!({
        "op": "analyze", "object": chart, "formula": "=[Revenue]", "invariant": true, "model": "second-model"
    }));
    assert_eq!(named.error, None, "{named:?}");
    assert_eq!(named.model.as_deref(), Some("second-model"));
    assert_eq!(named.measure_refs, vec!["Revenue".to_string()]);

    // A null model is the page's own -- the wire shape the seam sends when the
    // caller names none.
    let null_model = analysis_of(json!({
        "op": "analyze", "object": chart, "formula": "=[Revenue]", "invariant": true, "model": null
    }));
    assert_eq!(null_model.error, unnamed.error);
}

#[test]
fn a_measure_binding_is_stored_with_its_model_and_resolves_pending() {
    let wb = Wb::new();
    let chart = wb.chart(REPORT, json!({}));
    let info = binding_of(wb.send_with(&one_model(), set_req(&chart, "/spec/markOptions/goal", "=[revenue]*1.1")).unwrap());
    assert_eq!(info.formula, "=[Revenue]*1.1", "the measure's canonical spelling is stored");
    assert_eq!(info.model.as_deref(), Some("aw-model"));
    let resolved = info.resolved.expect("a resolved entry");
    assert!(resolved.pending && resolved.value.is_null() && resolved.error.is_none(), "never a stale number: {resolved:?}");

    let models = match wb.send_with(&one_model(), json!({ "op": "measures", "object": chart })).unwrap() {
        ObjectBindingsResponse::Measures { models } => models,
        r => panic!("{r:?}"),
    };
    assert_eq!(models.len(), 1);
    assert!(models[0].is_default);
}

#[test]
fn object_json_op_returns_the_document_the_paths_address() {
    let wb = Wb::new();
    let chart = wb.chart(DATA, json!({ "title": "T" }));
    let json = match wb.send(json!({ "op": "objectJson", "object": chart })).unwrap() {
        ObjectBindingsResponse::ObjectJson { json } => json,
        r => panic!("{r:?}"),
    };
    assert_eq!(json.pointer("/spec/title"), Some(&json!("T")));
}

// ===========================================================================
// Wire shapes
// ===========================================================================

#[test]
fn request_and_response_wire_shapes_are_camel_case() {
    let set: ObjectBindingsRequest = serde_json::from_value(json!({
        "op": "set", "object": { "kind": "timelineSlicer", "id": "t" }, "path": "/headerText", "formula": "=A1"
    }))
    .unwrap();
    match set {
        ObjectBindingsRequest::Set { object, invariant, source, model, .. } => {
            assert_eq!(object.kind, ObjectBindingKind::TimelineSlicer);
            assert_eq!((invariant, source, model), (None, None, None), "optional fields default to absent");
        }
        other => panic!("{other:?}"),
    }
    let lit: ObjectBindingsRequest = serde_json::from_value(json!({
        "op": "setLiteral", "object": { "kind": "canvasPage", "id": "p" }, "path": "/background", "value": "#fff",
        "source": { "kind": "script", "scriptId": "s1", "unlocked": false }
    }))
    .unwrap();
    assert!(matches!(
        lit,
        ObjectBindingsRequest::SetLiteral { source: Some(BindingEditSource::Script { ref script_id, unlocked: false }), .. } if script_id == "s1"
    ));
    let refresh: ObjectBindingsRequest =
        serde_json::from_value(json!({ "op": "refreshMeasures", "sheetIndex": 2 })).unwrap();
    assert!(matches!(refresh, ObjectBindingsRequest::RefreshMeasures { sheet_index: Some(2) }));
    for op in ["resolveAll", "list"] {
        serde_json::from_value::<ObjectBindingsRequest>(json!({ "op": op })).unwrap_or_else(|e| panic!("{op}: {e}"));
    }

    let r = serde_json::to_value(ObjectBindingsResponse::LiteralSet { domains: vec!["sheets".to_string()] }).unwrap();
    assert_eq!(r, json!({ "kind": "literalSet", "domains": ["sheets"] }));
    assert_eq!(serde_json::to_value(ObjectBindingsResponse::Ack).unwrap(), json!({ "kind": "ack" }));
    assert_eq!(
        serde_json::to_value(ObjectBindingsResponse::Cleared { removed: true }).unwrap(),
        json!({ "kind": "cleared", "removed": true })
    );
    let wb = Wb::new();
    let chart = wb.chart(DATA, json!({}));
    let v = serde_json::to_value(wb.send(set_req(&chart, "/spec/title", "=Data!A1")).unwrap()).unwrap();
    assert_eq!(v["kind"], "binding");
    assert_eq!(v["binding"]["displayFormula"], "=Data!A1");
    assert_eq!(v["binding"]["object"]["kind"], "chart");
}

// ===========================================================================
// Source censuses (D §3.7): comment-stripped, needles assembled at run time
// ===========================================================================

/// Every non-test `.rs` file of the app crate, as (path relative to src with
/// `/` separators, text).
fn crate_sources() -> Vec<(String, String)> {
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut out = Vec::new();
    let mut stack = vec![root.clone()];
    while let Some(dir) = stack.pop() {
        for entry in std::fs::read_dir(&dir).expect("readable src dir").flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
                continue;
            }
            let name = path.file_name().unwrap().to_string_lossy().to_string();
            if !name.ends_with(".rs") || name.ends_with("_tests.rs") || name == "tests.rs" {
                continue;
            }
            let rel = path
                .strip_prefix(&root)
                .unwrap()
                .components()
                .map(|c| c.as_os_str().to_string_lossy().to_string())
                .collect::<Vec<_>>()
                .join("/");
            out.push((rel, std::fs::read_to_string(&path).unwrap_or_default()));
        }
    }
    assert!(out.len() > 100, "the crate scan found only {} files", out.len());
    out
}

/// The CALLS of `name(` in comment-stripped `code`: an identifier boundary
/// before it and not a definition (`fn name(`).
fn calls_of(code: &str, name: &str) -> usize {
    let needle = format!("{name}(");
    let mut n = 0;
    let mut from = 0;
    while let Some(at) = code[from..].find(&needle) {
        let i = from + at;
        let before = code[..i].chars().next_back();
        let boundary = !before.is_some_and(|c| c.is_ascii_alphanumeric() || c == '_');
        let definition = code[..i].trim_end().ends_with("fn");
        if boundary && !definition {
            n += 1;
        }
        from = i + needle.len();
    }
    n
}

/// D §3.7: THE ONE re-evaluation entry point has a pinned caller list -- the
/// command module and (from WP-D S10) the MCP binding tool. Never a cell
/// command, the load path, the undo arm, a cascade or a structural shift.
#[test]
fn reevaluate_has_only_the_declared_callers() {
    let declared = ["object_bindings/mod.rs", "mcp/bindings.rs"];
    let name = ["re", "evaluate"].concat();
    let mut callers: Vec<(String, usize)> = Vec::new();
    for (file, text) in crate_sources() {
        let n = calls_of(&super::eval_tests::strip_comments(&text), &name);
        if n > 0 {
            callers.push((file, n));
        }
    }
    let undeclared: Vec<&(String, usize)> = callers.iter().filter(|(f, _)| !declared.contains(&f.as_str())).collect();
    assert!(
        undeclared.is_empty(),
        "only {declared:?} may call {name}() (D §3.7); also called from {undeclared:?}. A writer that holds \
         canonical locks bumps the generation and announces a reload instead."
    );
    let in_mod = callers.iter().find(|(f, _)| f == "object_bindings/mod.rs").map_or(0, |(_, n)| *n);
    assert!(in_mod >= 6, "the command's ops call it {in_mod} time(s) -- the census is not seeing them");
}

#[test]
fn the_caller_counter_skips_definitions_and_longer_names() {
    let code = "pub fn reevaluate(a: u8) {}\nlet x = eval::reevaluate(1);\nre_evaluate_for_changed_cells(2);\nmy_reevaluate(3);\n";
    assert_eq!(calls_of(code, "reevaluate"), 1);
}

/// The needles that WRITE the persisted binding store.
fn store_write_needles() -> Vec<String> {
    let store = ["object", "_bindings"].concat();
    ["write(", "lock_pending(", "replace("].iter().map(|op| format!("{store}.{op}")).collect()
}

/// The functions that write the store without announcing a reload, as
/// "file::fn" -- empty for a correct crate.
fn silent_writers(sources: &[(String, String)]) -> (usize, Vec<String>) {
    // File > New / Open: the seam resets its own cache on AFTER_NEW /
    // AFTER_OPEN, and an open then announces through restore_bindings_from_disk.
    let exempt = [("persistence.rs", "reset_document_scoped_stores")];
    let needles = store_write_needles();
    let mut writers = 0usize;
    let mut silent = Vec::new();
    for (file, text) in sources {
        for (name, body) in super::eval_tests::functions(text) {
            if !needles.iter().any(|n| body.contains(n.as_str())) {
                continue;
            }
            writers += 1;
            let announces = body.contains("announce_reload(") || body.contains("announce(");
            if !announces && !exempt.contains(&(file.as_str(), name.as_str())) {
                silent.push(format!("{file}::{name}"));
            }
        }
    }
    (writers, silent)
}

/// D §3.3/§3.7: every path that changes the binding SET announces a reload, so
/// the seam re-lists and re-resolves -- the store has no MutationDomain, its
/// own event is the only way the frontend hears of it.
#[test]
fn set_writers_announce_reload() {
    let (writers, silent) = silent_writers(&crate_sources());
    assert!(writers >= 4, "only {writers} store writer(s) found -- the census is not seeing them");
    assert!(
        silent.is_empty(),
        "these functions write the binding store but never announce a reload (announce_reload()):\n{}",
        silent.join("\n")
    );
}

#[test]
fn the_silent_writer_detector_fires_on_a_planted_body() {
    let planted = vec![(
        "planted.rs".to_string(),
        "fn sneaky(state: &AppState) {\n    let mut s = state.object_bindings.write(&e).unwrap();\n    s.bump_generation();\n}\n\
         fn loud(state: &AppState) {\n    let mut s = state.object_bindings.lock_pending().unwrap();\n    announce_reload();\n}\n"
            .to_string(),
    )];
    let (writers, silent) = silent_writers(&planted);
    assert_eq!(writers, 2);
    assert_eq!(silent, vec!["planted.rs::sneaky".to_string()]);
}

#[test]
fn every_store_key_in_a_delta_round_trips() {
    // The undo bytes are a SEQUENCE delta: against an EMPTY previous store,
    // every key of a store holding several kinds is in it, and the bytes
    // survive a serialise/deserialise unchanged.
    let wb = Wb::new();
    let chart = wb.chart(DATA, json!({}));
    let page = wb.page();
    wb.send(set_req(&chart, "/spec/title", "=Data!A1")).unwrap();
    wb.send(set_req(&page, "/background", "=Inputs!B3")).unwrap();
    let bytes = crate::undo_commands::bindings_restore_bytes(&wb.state, &BindingStoreSnapshot::default());
    let back: super::store::BindingDelta = serde_json::from_slice(&bytes).unwrap();
    let keys: HashSet<BindingKey> = back.rows.iter().map(|r| r.key.clone()).collect();
    assert_eq!(keys.len(), 2);
    assert!(back.rows.iter().all(|r| r.previous.is_none()), "nothing was bound before");
    let again: super::store::BindingDelta = serde_json::from_slice(&serde_json::to_vec(&back).unwrap()).unwrap();
    assert_eq!(again, back);
}

/// A binding step's undo restores ONLY the keys that step changed. Bindings
/// another writer changed in between WITHOUT recording undo -- a `.calp`
/// refresh replacing the application's rows (`land_pulled_bindings`) -- are
/// left exactly as that writer left them: Ctrl+Z of the user's own bind must
/// not bring back a binding the publisher removed nor drop the one it added.
///
/// SABOTAGE (confirmed): make `BindingDelta::between` return every key of the
/// previous AND current store (a whole-store restore) -- B comes back and C
/// is lost on undo.
#[test]
fn undoing_a_bind_never_reverts_a_binding_a_refresh_landed_in_between() {
    let wb = Wb::new();
    let app_b = wb.chart(DATA, json!({}));
    let app_c = wb.chart(DATA, json!({}));
    let mine = wb.chart(DATA, json!({}));
    let key_of = |object: &ObjectBindingRef| BindingKey { object: object.clone(), path: "/spec/title".to_string() };
    let stored = |f: &str| super::store::StoredBinding { formula: f.to_string(), model: None };
    // v1 of the application bound B (as a pull lands it: no undo step).
    {
        let mut store = wb.state.object_bindings.write(&test_seed_effect()).unwrap();
        store.bindings.insert(key_of(&app_b), stored("=Data!A1"));
        store.bump_generation();
    }
    // The user binds their own chart: one undo step.
    wb.send(set_req(&mine, "/spec/title", "=Data!A2")).unwrap();
    // A refresh to v2 removes B and adds C, recording nothing.
    {
        let mut store = wb.state.object_bindings.write(&test_seed_effect()).unwrap();
        store.bindings.remove(&key_of(&app_b));
        store.bindings.insert(key_of(&app_c), stored("=Data!A3"));
        store.bump_generation();
    }

    wb.undo();
    let after_undo = wb.state.object_bindings.read().unwrap().bindings.clone();
    assert!(!after_undo.contains_key(&key_of(&mine)), "the user's bind is undone: {after_undo:#?}");
    assert!(!after_undo.contains_key(&key_of(&app_b)), "a binding the refresh removed stays removed: {after_undo:#?}");
    assert_eq!(after_undo.get(&key_of(&app_c)), Some(&stored("=Data!A3")), "the refresh's binding stays");

    wb.redo();
    let after_redo = wb.state.object_bindings.read().unwrap().bindings.clone();
    assert_eq!(after_redo.get(&key_of(&mine)).map(|b| b.formula.as_str()), Some("=Data!A2"), "redo rebinds");
    assert!(!after_redo.contains_key(&key_of(&app_b)));
    assert_eq!(after_redo.get(&key_of(&app_c)), Some(&stored("=Data!A3")));
}

// ===========================================================================
// P4 S4a: a canvas page's `/interactions` -- a literal, never a binding
// ===========================================================================

fn interactions_value(source: &ObjectBindingRef, target: &ObjectBindingRef, mode: &str) -> Value {
    json!({
        "defaultMode": "filter",
        "pairs": [{
            "source": { "kind": source.kind.wire_name(), "id": source.id },
            "target": { "kind": target.kind.wire_name(), "id": target.id },
            "mode": mode
        }]
    })
}

impl Wb {
    /// Send one request through the ASYNC dispatcher (the command's own), with
    /// an empty BI state: the door every `/interactions` write takes (P4 S4d).
    async fn send_async(&self, request: Value) -> Result<ObjectBindingsResponse, String> {
        let request: ObjectBindingsRequest = serde_json::from_value(request).expect("request");
        let bi = crate::bi::types::BiState::new();
        let cx = self.cx();
        handle_request_async(&cx, &bi, request).await.map(|h| h.response)
    }
}

/// The SYNCHRONOUS literal door refuses `/interactions` (P4 S4d): the write
/// can need a pivot re-fold, which only the async door can run.
#[test]
fn the_sync_literal_door_refuses_interactions() {
    let wb = Wb::new();
    let page = wb.page();
    let slicer = wb.slicer(REPORT);
    let chart = wb.chart(REPORT, json!({}));
    wb.clean();
    let err = wb
        .send(literal_req(&page, "/interactions", interactions_value(&slicer, &chart, "none")))
        .expect_err("the sync door does not write interactions");
    assert_eq!(err, super::literal::INTERACTIONS_NEED_THE_ASYNC_DOOR);
    let err = crate::mcp::bindings::set_object_property_core(
        &wb.cx(),
        "canvasPage",
        &page.id,
        "/interactions",
        interactions_value(&slicer, &chart, "none"),
    )
    .expect_err("nor does the sync MCP core");
    assert_eq!(err, super::literal::INTERACTIONS_NEED_THE_ASYNC_DOOR);
    assert!(wb.canvas_layout().interactions.is_default() && !wb.dirty(), "nothing changed");
}

/// MCP `set_object_property` writes a page's interactions WHOLE through the
/// layout core: one undo step that Ctrl+Z takes back, the document dirtied,
/// and a re-send of the same value changes nothing.
#[tokio::test]
async fn set_object_property_writes_a_pages_interactions_as_one_undo_step() {
    let wb = Wb::new();
    let page = wb.page();
    let slicer = wb.slicer(REPORT);
    let chart = wb.chart(REPORT, json!({}));
    wb.clean();
    let depth = wb.depth();

    let value = interactions_value(&slicer, &chart, "none");
    let bi = crate::bi::types::BiState::new();
    let cx = wb.cx();
    let written =
        crate::mcp::bindings::set_object_property_async_core(&cx, &bi, "canvasPage", &page.id, "/interactions", value.clone())
            .await
            .expect("a page's interactions are writable");
    assert!(written.reply.contains("one undo step"), "{}", written.reply);
    assert!(written.layout.is_some(), "the layout change is announced to the canvas");
    let layout = wb.canvas_layout();
    assert_eq!(layout.interactions.default_mode, Some(::persistence::VisualInteractionMode::Filter));
    assert_eq!(layout.interactions.pairs.len(), 1);
    assert_eq!(layout.interactions.pairs[0].source.id, slicer.id);
    assert_eq!(layout.interactions.pairs[0].target.id, chart.id);
    assert_eq!(layout.interactions.pairs[0].mode, ::persistence::VisualInteractionMode::None);
    assert!(wb.dirty(), "an interactions edit is a document change");
    assert_eq!(wb.depth(), depth + 1, "ONE undo step");
    assert_eq!(wb.undo_description().as_deref(), Some("Change visual interaction"));

    let same = crate::mcp::bindings::set_object_property_async_core(&cx, &bi, "canvasPage", &page.id, "/interactions", value)
        .await
        .expect("re-sending is not an error");
    assert!(same.reply.contains("nothing changed"), "{}", same.reply);
    assert_eq!(wb.depth(), depth + 1, "a re-send records nothing");

    wb.undo();
    assert!(wb.canvas_layout().interactions.is_default(), "Ctrl+Z takes the interactions back");
}

/// Every ref must name an interaction-capable object ON THIS PAGE: an unknown
/// id and an object on another sheet are refused naming the ref, before the
/// effect.
#[tokio::test]
async fn set_literal_interactions_refuses_a_ref_that_is_not_on_the_page() {
    let wb = Wb::new();
    let page = wb.page();
    let slicer = wb.slicer(REPORT);
    let elsewhere = wb.chart(DATA, json!({}));
    wb.clean();
    let depth = wb.depth();

    let ghost = ObjectBindingRef { kind: ObjectBindingKind::Chart, id: entity().to_string() };
    for target in [&ghost, &elsewhere] {
        let err = wb
            .send_async(literal_req(&page, "/interactions", interactions_value(&slicer, target, "none")))
            .await
            .expect_err("a ref that is not on the page is refused");
        assert!(err.contains(&target.id), "the refusal names the ref: {err}");
        assert!(err.contains("not an object on this canvas page"), "{err}");
    }
    let err = wb
        .send_async(literal_req(&page, "/interactions", json!({ "pairs": "nope" })))
        .await
        .expect_err("a malformed value is refused");
    assert!(err.contains("Interactions are an object"), "{err}");
    assert!(wb.canvas_layout().interactions.is_default(), "nothing was written");
    assert!(!wb.dirty(), "a refusal leaves the document clean");
    assert_eq!(wb.depth(), depth, "a refusal records no step");
}

#[tokio::test]
async fn set_literal_interactions_is_refused_on_a_protected_page() {
    let wb = Wb::new();
    let page = wb.page();
    let slicer = wb.slicer(REPORT);
    let chart = wb.chart(REPORT, json!({}));
    wb.protect(REPORT);
    wb.clean();
    let err = wb
        .send_async(literal_req(&page, "/interactions", interactions_value(&slicer, &chart, "highlight")))
        .await
        .expect_err("a protected page refuses an interactions edit");
    assert!(err.contains("protected sheet"), "the layout core's own protection sentence: {err}");
    assert!(wb.canvas_layout().interactions.is_default() && !wb.dirty(), "nothing changed");
}

/// No catalog row (P4 DC-6): a BINDING on `/interactions` is refused by name,
/// through the Set door and through the catalog itself.
#[test]
fn interactions_are_refused_as_a_binding_by_name() {
    let wb = Wb::new();
    let page = wb.page();
    wb.clean();
    let err = wb.send(set_req(&page, "/interactions", "=Inputs!B1")).expect_err("not bindable");
    assert_eq!(err, super::catalog::INTERACTIONS_NOT_BINDABLE);
    let err = super::catalog::match_path(ObjectBindingKind::CanvasPage, "/interactions/pairs/0/mode").unwrap_err();
    assert_eq!(err, super::catalog::INTERACTIONS_NOT_BINDABLE, "a deeper pointer is refused the same way");
    assert!(wb.rows().is_empty() && !wb.dirty(), "nothing was bound");
}
