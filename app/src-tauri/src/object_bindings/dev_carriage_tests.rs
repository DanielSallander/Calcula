//! FILENAME: app/src-tauri/src/object_bindings/dev_carriage_tests.rs
//! PURPOSE: Object property bindings through a DEV subscription (BUG-0471): a
//! dev subscribe and a dev refresh from a local `.cala` land the source's
//! `bindings.json` rows on the controls and pages they materialized -- the
//! formulas following a collision rename, a refresh REPLACING the dev
//! subscription's bindings and keeping the workbook's own -- and a source saved
//! before bindings existed (a `valueType: "formula"` caption) comes out bound.
//! CONTEXT: Real `.cala` sources on disk, the real window-free dev doors
//! (`dev_subscribe_inner`, `dev_refresh_inner`), and the real evaluator
//! (`resolve_all_core`) for what the caption paints.

use std::collections::BTreeMap;
use std::path::Path;

use tempfile::TempDir;

use engine::cell::Cell;
use persistence::{SavedCell, Sheet, Workbook};

use crate::api_types::{ObjectBindingKind, ObjectBindingRef};

use super::store::{BindingKey, StoredBinding};

fn effect() -> crate::document_effect::DocumentEffect {
    crate::document_effect::DocumentEffect::mutates(&crate::persistence::FileState::default())
}

fn new_entity() -> identity::EntityId {
    identity::EntityId::from_bytes(identity::generate_uuid_v7())
}

fn row(kind: &str, id: &str, path: &str, formula: &str) -> persistence::SavedObjectBinding {
    persistence::SavedObjectBinding {
        object: persistence::SavedObjectRef { kind: kind.to_string(), id: id.to_string() },
        path: path.to_string(),
        formula: formula.to_string(),
        model: None,
    }
}

fn button(uid: &str, row: u32, text: serde_json::Value) -> serde_json::Value {
    serde_json::json!({
        "row": row, "col": 2, "controlType": "button", "uid": uid,
        "properties": { "text": text }
    })
}

fn static_text(value: &str) -> serde_json::Value {
    serde_json::json!({ "valueType": "static", "value": value })
}

fn key(kind: ObjectBindingKind, id: &str, path: &str) -> BindingKey {
    BindingKey { object: ObjectBindingRef { kind, id: id.to_string() }, path: path.to_string() }
}

/// The dev source: "Data" (A1 = 21, A2 = 34), "Report" (a worksheet holding
/// the buttons) and "Page" (a canvas). Each button's caption is bound.
struct Source {
    wb: Workbook,
    page: identity::SheetId,
}

impl Source {
    fn new(buttons: &[(&str, u32)]) -> Self {
        let mut data = Sheet::new("Data".to_string());
        data.cells.insert((0, 0), SavedCell::from_cell(&Cell::new_number(21.0)));
        data.cells.insert((1, 0), SavedCell::from_cell(&Cell::new_number(34.0)));
        let report = Sheet::new("Report".to_string());
        let report_id = report.id;
        let mut page = Sheet::new("Page".to_string());
        page.kind = persistence::SheetKind::new_canvas();
        let page_id = page.id;
        let mut wb = Workbook::default();
        wb.sheets = vec![data, report, page];
        wb.controls = vec![persistence::SavedSheetControls {
            sheet_id: report_id,
            controls: serde_json::Value::Array(
                buttons.iter().map(|(uid, r)| button(uid, *r, static_text(""))).collect(),
            ),
        }];
        wb.object_bindings = buttons
            .iter()
            .map(|(uid, _)| row("control", uid, "/properties/text", "=Data!A1"))
            .chain(std::iter::once(row("canvasPage", &page_id.to_string(), "/background", "=Data!A1")))
            .collect();
        Source { wb, page: page_id }
    }

    fn save(&self, path: &Path) {
        calcula_format::save_calcula(&self.wb, path).expect("save the dev source");
    }
}

struct Harness {
    state: crate::AppState,
    pivot: crate::pivot::types::PivotState,
    ribbon: crate::ribbon_filter::RibbonFilterState,
    pane: crate::pane_control::PaneControlState,
    slicer: crate::slicer::SlicerState,
    timeline: crate::timeline_slicer::TimelineSlicerState,
}

impl Harness {
    fn new() -> Self {
        Self {
            state: crate::create_app_state(),
            pivot: crate::pivot::types::PivotState::new(),
            ribbon: crate::ribbon_filter::RibbonFilterState::new(),
            pane: crate::pane_control::PaneControlState::new(),
            slicer: crate::slicer::SlicerState::new(),
            timeline: crate::timeline_slicer::TimelineSlicerState::new(),
        }
    }

    /// The workbook already has a sheet called "Data" (index 0), so the
    /// source's "Data" arrives as "Data (2)" -- a collision rename.
    fn with_own_data_sheet() -> Self {
        let h = Harness::new();
        h.state.sheet_names.write(&effect()).unwrap()[0] = "Data".to_string();
        h
    }

    fn dev_subscribe(&self, source: &Path) {
        let params = crate::calp_commands::DevSubscribeParams {
            source_path: source.to_string_lossy().to_string(),
            sheet_names: Vec::new(),
        };
        crate::calp_commands::dev_subscribe_inner(
            &self.state,
            &crate::persistence::FileState::default(),
            &self.slicer,
            &self.timeline,
            &self.ribbon,
            &self.pivot,
            &params,
        )
        .expect("dev subscribe");
    }

    fn dev_refresh(&self) {
        crate::calp_commands::dev_refresh_inner(
            &self.state,
            &crate::persistence::FileState::default(),
            &self.slicer,
            &self.timeline,
            &self.ribbon,
            &self.pivot,
        )
        .expect("dev refresh");
    }

    /// The workbook's OWN chart on its sheet 0, with its own binding.
    fn own_bound_chart(&self) -> BindingKey {
        let id = new_entity();
        let spec = serde_json::json!({ "chartId": 9, "name": "Mine", "sheetIndex": 0, "spec": {} });
        self.state.charts.write(&effect()).unwrap().push(crate::api_types::ChartEntry {
            id,
            sheet_index: 0,
            spec_json: spec.to_string(),
        });
        let key = key(ObjectBindingKind::Chart, &id.to_string(), "/spec/title");
        let mut store = self.state.object_bindings.write(&effect()).unwrap();
        store.bindings.insert(key.clone(), StoredBinding { formula: "=Data!B9".to_string(), model: None });
        store.bump_generation();
        key
    }

    fn bindings(&self) -> BTreeMap<BindingKey, StoredBinding> {
        self.state.object_bindings.read().unwrap().bindings.clone()
    }

    fn formula(&self, key: &BindingKey) -> Option<String> {
        self.bindings().get(key).map(|b| b.formula.clone())
    }

    /// What the button `uid` paints as its caption, after the evaluator ran.
    fn painted_text(&self, uid: &str) -> Option<String> {
        let file = crate::persistence::FileState::default();
        let user_files = crate::persistence::UserFilesState::default();
        let cx = super::BindingCx {
            state: &self.state,
            file_state: &file,
            slicers: &self.slicer,
            timelines: &self.timeline,
            pivots: &self.pivot,
            pane: &self.pane,
            ribbon: &self.ribbon,
            user_files: &user_files,
        };
        super::resolve_all_core(&cx);
        let anchor = {
            let controls = self.state.controls.read().unwrap();
            controls.iter().find(|(_, m)| m.uid == uid).map(|(k, _)| *k)?
        };
        crate::controls::resolve_control_properties_core(&self.state, anchor.0, anchor.1, anchor.2)
            .get("text")
            .cloned()
    }
}

/// BUG-0471. A DEV subscribe carried the source's button and not its binding,
/// so a caption that follows `=Data!A1` arrived showing its frozen literal and
/// never moved. It now lands the source's rows on the objects it brought -- the
/// button by its kept uid, the canvas page under its (kept) sheet id -- each
/// formula following the collision rename ("Data" arrived as "Data (2)"), and
/// the caption PAINTS the cell's value. The workbook's own binding is untouched.
///
/// SABOTAGE: drop the `land_dev_pull_bindings` call from `dev_subscribe_inner`
/// -- no row lands and the caption assertion fails; or drop the
/// `rename_binding_formulas` call there -- the caption reads the workbook's OWN
/// "Data" and the renamed-formula assertion fails.
#[test]
fn a_dev_subscribe_lands_the_sources_bindings_and_the_caption_follows_the_cell() {
    let dir = TempDir::new().unwrap();
    let source_path = dir.path().join("source.cala");
    let source = Source::new(&[("dev-btn", 2)]);
    source.save(&source_path);

    let h = Harness::with_own_data_sheet();
    let own = h.own_bound_chart();
    h.dev_subscribe(&source_path);

    assert_eq!(
        h.formula(&key(ObjectBindingKind::Control, "dev-btn", "/properties/text")).as_deref(),
        Some("='Data (2)'!A1"),
        "the button's caption binding landed, following its renamed sheet: {:#?}",
        h.bindings()
    );
    assert_eq!(
        h.formula(&key(ObjectBindingKind::CanvasPage, &source.page.to_string(), "/background")).as_deref(),
        Some("='Data (2)'!A1"),
        "the page row lands under the page's id (a dev pull keeps the source's ids)"
    );
    assert_eq!(h.formula(&own).as_deref(), Some("=Data!B9"), "the workbook's own binding is kept");
    assert_eq!(h.bindings().len(), 3, "{:#?}", h.bindings());
    assert_eq!(h.painted_text("dev-btn").as_deref(), Some("21"), "the caption paints Data!A1, not a frozen literal");
}

/// A DEV REFRESH REPLACES the dev subscription's bindings: a formula the source
/// changed arrives changed (and paints the new cell), a binding the source
/// removed from a button it kept stops binding, the binding of a button the
/// source DELETED goes with it -- and the workbook's own binding survives.
///
/// SABOTAGE: pass an empty `previously_owned` in `dev_refresh_inner`'s landing
/// -- the deleted button's binding survives as an orphan and its assertion
/// fails.
#[test]
fn a_dev_refresh_replaces_the_bindings_and_a_removed_one_disappears() {
    let dir = TempDir::new().unwrap();
    let source_path = dir.path().join("source.cala");
    let mut source = Source::new(&[("dev-btn", 2), ("dev-kept", 4), ("dev-gone", 6)]);
    source.save(&source_path);

    let h = Harness::new();
    let own = h.own_bound_chart();
    h.dev_subscribe(&source_path);
    let gone = key(ObjectBindingKind::Control, "dev-gone", "/properties/text");
    let kept = key(ObjectBindingKind::Control, "dev-kept", "/properties/text");
    assert!(h.bindings().contains_key(&gone), "precondition: v1 bound the button v2 deletes");
    assert!(h.bindings().contains_key(&kept), "precondition: v1 bound the button whose binding v2 drops");
    assert_eq!(h.painted_text("dev-btn").as_deref(), Some("21"));

    // v2: dev-btn reads A2, dev-kept keeps its button and loses its binding,
    // dev-gone is deleted outright.
    source.wb.controls[0].controls = serde_json::json!([
        button("dev-btn", 2, static_text("")),
        button("dev-kept", 4, static_text("Fixed")),
    ]);
    source.wb.object_bindings = vec![
        row("control", "dev-btn", "/properties/text", "=Data!A2"),
        row("canvasPage", &source.page.to_string(), "/background", "=Data!A1"),
    ];
    source.save(&source_path);
    h.dev_refresh();

    assert_eq!(
        h.formula(&key(ObjectBindingKind::Control, "dev-btn", "/properties/text")).as_deref(),
        Some("=Data!A2"),
        "the changed formula arrives: {:#?}",
        h.bindings()
    );
    assert_eq!(h.painted_text("dev-btn").as_deref(), Some("34"), "and the caption follows the new cell");
    assert!(!h.bindings().contains_key(&kept), "a binding the source removed stops binding: {:#?}", h.bindings());
    assert_eq!(h.painted_text("dev-kept").as_deref(), Some("Fixed"), "the kept button paints its literal");
    assert!(
        !h.bindings().contains_key(&gone),
        "the binding of a button the source deleted is gone with it: {:#?}",
        h.bindings()
    );
    assert!(h.bindings().contains_key(&key(ObjectBindingKind::CanvasPage, &source.page.to_string(), "/background")));
    assert_eq!(h.formula(&own).as_deref(), Some("=Data!B9"), "the workbook's own binding survives");
    assert_eq!(h.bindings().len(), 3, "{:#?}", h.bindings());
}

/// A dev source saved BEFORE bindings existed carries the caption as a
/// `valueType: "formula"` property and no `bindings.json`. The dev pull runs the
/// migration a file open runs: the caption becomes a binding of that button
/// (qualified as written), the literal is emptied, and it paints the cell.
///
/// SABOTAGE: drop the `migrate_legacy_formulas` call from
/// `land_dev_pull_bindings` -- no binding appears.
#[test]
fn a_dev_pull_of_a_pre_bindings_source_migrates_its_formula_caption_to_a_binding() {
    let dir = TempDir::new().unwrap();
    let source_path = dir.path().join("source.cala");
    let mut source = Source::new(&[]);
    source.wb.object_bindings.clear();
    source.wb.controls[0].controls = serde_json::json!([button(
        "dev-legacy",
        2,
        serde_json::json!({ "valueType": "formula", "value": "=Data!A1" })
    )]);
    source.save(&source_path);
    let saved = calcula_format::load_calcula(&source_path).expect("reload the source");
    assert!(
        saved.format_version < calcula_format::OBJECT_BINDINGS_MIN_FORMAT_VERSION,
        "precondition: the source is a pre-bindings file (v{})",
        saved.format_version
    );

    let h = Harness::new(); // no "Data" of its own: no collision rename
    h.dev_subscribe(&source_path);

    assert_eq!(
        h.formula(&key(ObjectBindingKind::Control, "dev-legacy", "/properties/text")).as_deref(),
        Some("=Data!A1"),
        "{:#?}",
        h.bindings()
    );
    {
        let controls = h.state.controls.read().unwrap();
        let meta = controls.values().find(|m| m.uid == "dev-legacy").expect("the button landed");
        assert_eq!(meta.properties["text"].value_type, "static");
        assert_eq!(meta.properties["text"].value, "");
    }
    assert_eq!(h.painted_text("dev-legacy").as_deref(), Some("21"));
}

/// The pre-bindings source WITH a collision rename (revC#1): this workbook
/// already has its own "Data" (A1 = 999), so the source's "Data" lands as "Data
/// (2)". The door renames the cell formulas and the `bindings.json` rows -- but
/// a formula-typed caption is neither, and the migration resolves it against
/// THIS workbook's sheets, so `=Data!A1` used to become a binding of the
/// subscriber's OWN "Data" and paint 999: a live, plausible, wrong number
/// beside cells that read 21. The door now renames the old caption text ahead
/// of the migration.
///
/// SABOTAGE: drop the `rename_legacy_control_formulas` call from
/// `dev_subscribe_inner` -- the binding reads `=Data!A1` and the first
/// assertion fails.
#[test]
fn a_pre_bindings_dev_source_whose_sheet_collides_binds_its_caption_to_the_pulled_sheet() {
    let dir = TempDir::new().unwrap();
    let source_path = dir.path().join("source.cala");
    legacy_caption_source().save(&source_path);

    let h = Harness::with_own_data_sheet_reading(999.0);
    h.dev_subscribe(&source_path);

    let caption = key(ObjectBindingKind::Control, "dev-legacy", "/properties/text");
    assert_eq!(
        h.formula(&caption).as_deref(),
        Some("='Data (2)'!A1"),
        "the migrated caption reads the PULLED sheet, under the name it landed as: {:#?}",
        h.bindings()
    );
    assert_eq!(
        h.painted_text("dev-legacy").as_deref(),
        Some("21"),
        "the caption paints the source's value, never the subscriber's own Data!A1 (999)"
    );
}

/// The same on a DEV REFRESH: the button is landed again from the source, its
/// binding REPLACED, and the migration runs again -- after the refresh door's
/// own rename. Whatever the subscribe left, the refresh decides the caption.
///
/// SABOTAGE: drop the `rename_legacy_control_formulas` call from
/// `dev_refresh_inner` -- the refreshed binding reads `=Data!A1`.
#[test]
fn a_dev_refresh_of_a_pre_bindings_source_whose_sheet_collides_binds_its_caption_to_the_pulled_sheet() {
    let dir = TempDir::new().unwrap();
    let source_path = dir.path().join("source.cala");
    legacy_caption_source().save(&source_path);

    let h = Harness::with_own_data_sheet_reading(999.0);
    h.dev_subscribe(&source_path);
    h.dev_refresh();

    let caption = key(ObjectBindingKind::Control, "dev-legacy", "/properties/text");
    assert_eq!(
        h.formula(&caption).as_deref(),
        Some("='Data (2)'!A1"),
        "the refreshed caption reads the PULLED sheet: {:#?}",
        h.bindings()
    );
    assert_eq!(h.painted_text("dev-legacy").as_deref(), Some("21"));
}

/// A source saved before bindings: one button on "Report" whose caption is the
/// old `{valueType: "formula", value: "=Data!A1"}` spelling, no `bindings.json`.
fn legacy_caption_source() -> Source {
    let mut source = Source::new(&[]);
    source.wb.object_bindings.clear();
    source.wb.controls[0].controls = serde_json::json!([button(
        "dev-legacy",
        2,
        serde_json::json!({ "valueType": "formula", "value": "=Data!A1" })
    )]);
    source
}

impl Harness {
    /// [`Harness::with_own_data_sheet`], its own "Data"!A1 holding `value`.
    fn with_own_data_sheet_reading(value: f64) -> Self {
        let h = Harness::with_own_data_sheet();
        {
            let mut grid = h.state.grid.write(&effect()).unwrap();
            let mut grids = h.state.grids.write(&effect()).unwrap();
            grid.set_cell(0, 0, Cell::new_number(value));
            grids[0].set_cell(0, 0, Cell::new_number(value));
        }
        h
    }
}
