//! FILENAME: app/src-tauri/src/object_bindings/carriage_tests.rs
//! PURPOSE: Object property bindings through a `.calp` (WP-D S6, D §3.14):
//! a subscribe, a checkout and a refresh land the application's
//! `bindings.json` on the objects they materialized -- ids mapped, rows of
//! objects that did not land dropped, a refresh REPLACING the application's
//! bindings and keeping the subscriber's -- and the push carrier collects them.
//! CONTEXT: Real publishes into a temp workspace, real pulls, and the real
//! window-free materializers (`materialize_pull_result`,
//! `prepare_refresh_payloads` + `apply_refresh_payloads`).

use std::collections::BTreeMap;
use std::path::Path;

use tempfile::TempDir;

use calp::publish::{self, PublishRequest, PushMode};
use calp::version::{SemVer, VersionPin};
use engine::cell::Cell;
use persistence::{SavedCell, Sheet, Workbook};

use crate::api_types::{ObjectBindingKind, ObjectBindingRef};
use crate::calp_commands::{materialize_pull_result, MaterializeMode};

use super::store::{BindingKey, StoredBinding};

const PKG: &str = "bound";

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

fn chart_on(sheet: identity::SheetId, id: identity::EntityId, name: &str) -> persistence::SavedChart {
    persistence::SavedChart {
        id,
        sheet_id: sheet,
        spec: serde_json::json!({ "chartId": 1, "name": name, "sheetIndex": 1, "spec": { "mark": "bar" } }),
    }
}

/// The application: "Data" (a worksheet, A1 = 21) and "Dashboard" (a CANVAS)
/// holding the chart "Sales", a button `app-btn`, and every one of them bound.
struct App {
    wb: Workbook,
    dashboard: identity::SheetId,
    chart: identity::EntityId,
}

impl App {
    fn new() -> Self {
        let mut data = Sheet::new("Data".to_string());
        data.cells.insert((0, 0), SavedCell::from_cell(&Cell::new_number(21.0)));
        let mut dashboard = Sheet::new("Dashboard".to_string());
        dashboard.kind = persistence::SheetKind::new_canvas();
        let dashboard_id = dashboard.id;
        let chart = new_entity();
        let mut wb = Workbook::default();
        wb.sheets = vec![data, dashboard];
        wb.charts = vec![chart_on(dashboard_id, chart, "Sales")];
        wb.controls = vec![persistence::SavedSheetControls {
            sheet_id: dashboard_id,
            controls: serde_json::json!([{
                "row": 2, "col": 2, "controlType": "button", "uid": "app-btn",
                "properties": { "text": { "valueType": "static", "value": "" } }
            }]),
        }];
        wb.object_bindings = vec![
            row("canvasPage", &dashboard_id.to_string(), "/background", "=Data!A1"),
            row("chart", &chart.to_string(), "/spec/title", "=Data!A1"),
            row("chart", &chart.to_string(), "/spec/subtitle", "=Data!A1*2"),
            row("control", "app-btn", "/properties/text", "=Data!A1"),
        ];
        App { wb, dashboard: dashboard_id, chart }
    }

    fn publish(&self, dir: &TempDir, prof: &Path, version: (u32, u32, u32), base: Option<(u32, u32, u32)>) {
        let reg = calp::workspace::LocalWorkspace::open(dir.path()).unwrap();
        let mode = match base {
            None => PushMode::CreateNew,
            Some((a, b, c)) => PushMode::Update { expected_base: SemVer::new(a, b, c) },
        };
        let request = PublishRequest {
            workbook: &self.wb,
            package_name: PKG.to_string(),
            version: SemVer::new(version.0, version.1, version.2),
            kind: "report".to_string(),
            mode,
            change_summary: format!("v{}.{}.{}", version.0, version.1, version.2),
            sheet_indices: (0..self.wb.sheets.len()).collect(),
            now: "2026-10-15T00:00:00Z".to_string(),
            published_by: "author".to_string(),
            writeback_regions: None,
            model_writebacks: None,
            object_scripts: None,
            module_scripts: None,
            notebooks: None,
            data_sources: Vec::new(),
            excluded_regions: Vec::new(),
            custom_objects: Vec::new(),
            include_comments: false,
            min_app_version: String::new(),
        };
        publish::publish(&reg, &request, prof).expect("publish failed");
    }
}

fn subscribe_pull(dir: &TempDir, prof: &Path) -> calp::pull::PullResult {
    let reg = calp::workspace::LocalWorkspace::open(dir.path()).unwrap();
    let scope = calp::workspace_scope(dir.path().to_str().unwrap()).unwrap();
    calp::pull::pull(
        &reg,
        &calp::pull::PullRequest {
            package_name: PKG.to_string(),
            target: calp::manifest::SubscriptionTarget::Line(VersionPin::Latest),
            now: "2026-10-15T01:00:00Z".to_string(),
        },
        &scope,
        prof,
        calp::integrity::PinPolicy::PinOnFirstUse,
    )
    .expect("pull failed")
}

fn checkout_pull(dir: &TempDir, prof: &Path) -> calp::pull::PullResult {
    let reg = calp::workspace::LocalWorkspace::open(dir.path()).unwrap();
    let scope = calp::workspace_scope(dir.path().to_str().unwrap()).unwrap();
    calp::checkout::checkout(&reg, PKG, None, "2026-10-15T01:00:00Z", &scope, prof)
        .expect("checkout failed")
        .pulled
}

struct Harness {
    state: crate::AppState,
    pivot: crate::pivot::types::PivotState,
    bi: crate::bi::types::BiState,
    scripts: crate::scripting::types::ScriptState,
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
            bi: crate::bi::types::BiState::new(),
            scripts: crate::scripting::types::ScriptState::new(),
            ribbon: crate::ribbon_filter::RibbonFilterState::new(),
            pane: crate::pane_control::PaneControlState::new(),
            slicer: crate::slicer::SlicerState::new(),
            timeline: crate::timeline_slicer::TimelineSlicerState::new(),
        }
    }

    /// The subscriber already has a sheet called "Data" (index 0), so the
    /// application's "Data" arrives as "Data (2)" -- a collision rename.
    fn with_own_data_sheet() -> Self {
        let h = Harness::new();
        h.state.sheet_names.write(&effect()).unwrap()[0] = "Data".to_string();
        h
    }

    fn materialize(&self, result: calp::pull::PullResult, mode: MaterializeMode) {
        materialize_pull_result(
            &self.state,
            &effect(),
            &self.pivot,
            &self.bi,
            &self.scripts,
            &self.ribbon,
            &self.pane,
            &self.slicer,
            &self.timeline,
            result,
            mode,
            None,
        )
        .expect("materialization failed");
    }

    fn refresh(&self, pulled: calp::pull::PullResult) {
        let mut payloads = vec![calp::refresh::RefreshPayload { subscription_index: 0, pull_result: pulled }];
        let names = crate::calp_commands::prepare_refresh_payloads(&self.state, &mut payloads)
            .expect("the refresh's pre-effect pass refused");
        crate::calp_commands::apply_refresh_payloads(
            &self.state,
            &effect(),
            &crate::persistence::UserFilesState::default(),
            &self.pivot,
            &self.scripts,
            &self.bi,
            &self.ribbon,
            &self.pane,
            &self.slicer,
            &self.timeline,
            payloads,
            names,
            &[],
            "2026-10-15T02:00:00Z",
            None,
        )
        .expect("refresh failed");
    }

    /// The subscriber's OWN chart on its sheet 0, with its own binding.
    fn own_bound_chart(&self, id: identity::EntityId) -> BindingKey {
        let spec = serde_json::json!({ "chartId": 9, "name": "Mine", "sheetIndex": 0, "spec": {} });
        self.state.charts.write(&effect()).unwrap().push(crate::api_types::ChartEntry {
            id,
            sheet_index: 0,
            spec_json: spec.to_string(),
        });
        let key = BindingKey {
            object: ObjectBindingRef { kind: ObjectBindingKind::Chart, id: id.to_string() },
            path: "/spec/title".to_string(),
        };
        let mut store = self.state.object_bindings.write(&effect()).unwrap();
        store.bindings.insert(key.clone(), StoredBinding { formula: "=Data!B9".to_string(), model: None });
        store.bump_generation();
        key
    }

    fn bindings(&self) -> BTreeMap<BindingKey, StoredBinding> {
        self.state.object_bindings.read().unwrap().bindings.clone()
    }

    fn generation(&self) -> u64 {
        self.state.object_bindings.read().unwrap().generation
    }

    fn sheet_id_named(&self, name: &str) -> identity::SheetId {
        let names = self.state.sheet_names.read().unwrap().clone();
        let idx = names.iter().position(|n| n == name).unwrap_or_else(|| panic!("no sheet {name} in {names:?}"));
        self.state.sheet_ids.read().unwrap()[idx]
    }
}

fn key(kind: ObjectBindingKind, id: &str, path: &str) -> BindingKey {
    BindingKey { object: ObjectBindingRef { kind, id: id.to_string() }, path: path.to_string() }
}

/// A SUBSCRIBE lands every row of the objects it brought: the canvas page's
/// row under the page's LOCAL sheet id (a subscriber's sheets are its own),
/// the chart's and the button's under their kept ids, every formula following
/// the collision rename ("Data" arrived as "Data (2)"). The subscriber's own
/// binding is untouched.
///
/// SABOTAGE: drop the canvas-page id mapping in `PulledBindings::from_pull`
/// (keep `row.clone()`) -- the page row lands under the PUBLISHER's sheet id,
/// names no object here, and the page assertion fails.
#[test]
fn a_subscribe_lands_the_bindings_on_the_objects_it_brought() {
    let dir = TempDir::new().unwrap();
    let prof = TempDir::new().unwrap();
    let app = App::new();
    app.publish(&dir, prof.path(), (1, 0, 0), None);

    let h = Harness::with_own_data_sheet();
    let own = h.own_bound_chart(new_entity());
    let generation_before = h.generation();
    h.materialize(subscribe_pull(&dir, prof.path()), MaterializeMode::Subscribe);

    let page = h.sheet_id_named("Dashboard");
    assert_ne!(page, app.dashboard, "a subscribe mints its own sheet ids");
    let renamed = "='Data (2)'!A1".to_string();
    let b = h.bindings();
    assert_eq!(
        b.get(&key(ObjectBindingKind::CanvasPage, &page.to_string(), "/background")).map(|s| &s.formula),
        Some(&renamed),
        "the page row lives under the LOCAL page id: {b:#?}"
    );
    assert!(
        !b.keys().any(|k| k.object.id == app.dashboard.to_string()),
        "no row may name the publisher's sheet id: {b:#?}"
    );
    let chart = app.chart.to_string();
    assert_eq!(b.get(&key(ObjectBindingKind::Chart, &chart, "/spec/title")).map(|s| &s.formula), Some(&renamed));
    assert_eq!(
        b.get(&key(ObjectBindingKind::Chart, &chart, "/spec/subtitle")).map(|s| s.formula.as_str()),
        Some("='Data (2)'!A1*2")
    );
    assert_eq!(
        b.get(&key(ObjectBindingKind::Control, "app-btn", "/properties/text")).map(|s| &s.formula),
        Some(&renamed)
    );
    assert_eq!(b.get(&own).map(|s| s.formula.as_str()), Some("=Data!B9"), "the subscriber's own binding is kept");
    assert_eq!(b.len(), 5);
    assert!(h.generation() > generation_before, "the runtime must rebuild");
}

/// A pulled chart the subscriber ALREADY has by id is skipped by the chart
/// materializer -- and so are its bindings: the application's row for that id
/// must not land on the SUBSCRIBER's chart, which sits on the subscriber's own
/// sheet. The subscriber's binding on it is left exactly as it was.
///
/// SABOTAGE: drop the `landed_sheets` condition in `land_pulled_bindings` --
/// the application's title lands on the subscriber's chart.
#[test]
fn a_binding_of_an_object_that_did_not_land_is_not_installed() {
    let dir = TempDir::new().unwrap();
    let prof = TempDir::new().unwrap();
    let app = App::new();
    app.publish(&dir, prof.path(), (1, 0, 0), None);

    let h = Harness::with_own_data_sheet();
    // The subscriber's own chart happens to carry the application's chart id.
    let own = h.own_bound_chart(app.chart);
    h.materialize(subscribe_pull(&dir, prof.path()), MaterializeMode::Subscribe);

    let b = h.bindings();
    assert_eq!(b.get(&own).map(|s| s.formula.as_str()), Some("=Data!B9"), "the subscriber's binding is untouched");
    assert!(
        b.get(&key(ObjectBindingKind::Chart, &app.chart.to_string(), "/spec/subtitle")).is_none(),
        "the application's subtitle binding must not land on the subscriber's chart: {b:#?}"
    );
    // ...while the objects that did land got theirs.
    assert!(b.contains_key(&key(ObjectBindingKind::Control, "app-btn", "/properties/text")));
}

/// A CHECKOUT keeps the application's sheet ids, so the page row lands under
/// the very id it was published with -- an untouched push then republishes the
/// same bytes.
#[test]
fn a_checkout_lands_the_bindings_under_the_applications_own_ids() {
    let dir = TempDir::new().unwrap();
    let prof = TempDir::new().unwrap();
    let app = App::new();
    app.publish(&dir, prof.path(), (1, 0, 0), None);

    let h = Harness::new();
    {
        let e = effect();
        *h.state.grid.write(&e).unwrap() = engine::grid::Grid::new();
        *h.state.active_sheet.write(&e).unwrap() = 0;
        h.state.grids.write(&e).unwrap().clear();
        h.state.sheet_names.write(&e).unwrap().clear();
        h.state.sheet_ids.write(&e).unwrap().clear();
        h.state.all_column_widths.write(&e).unwrap().clear();
        h.state.all_row_heights.write(&e).unwrap().clear();
    }
    h.materialize(checkout_pull(&dir, prof.path()), MaterializeMode::Checkout);

    let b = h.bindings();
    assert_eq!(
        b.get(&key(ObjectBindingKind::CanvasPage, &app.dashboard.to_string(), "/background")).map(|s| s.formula.as_str()),
        Some("=Data!A1"),
        "{b:#?}"
    );
    assert_eq!(b.len(), 4, "every published row: {b:#?}");
}

/// A REFRESH REPLACES the application's bindings: a formula the publisher
/// changed arrives changed, a binding the publisher removed is gone, the
/// bindings of a chart the new version no longer has are gone with it -- and
/// the subscriber's own binding survives.
///
/// SABOTAGE: pass an empty `previously_owned` in the refresh's landing -- the
/// removed chart's binding survives as an orphan and the last assertion fails;
/// or drop the `retain` in `land_pulled_bindings` -- the removed subtitle
/// survives.
#[test]
fn a_refresh_replaces_the_applications_bindings_and_keeps_the_subscribers() {
    let dir = TempDir::new().unwrap();
    let prof = TempDir::new().unwrap();
    let mut app = App::new();
    let gone = new_entity();
    app.wb.charts.push(chart_on(app.dashboard, gone, "Gone"));
    app.wb.object_bindings.push(row("chart", &gone.to_string(), "/spec/title", "=Data!A1"));
    app.publish(&dir, prof.path(), (1, 0, 0), None);

    let h = Harness::with_own_data_sheet();
    let own = h.own_bound_chart(new_entity());
    h.materialize(subscribe_pull(&dir, prof.path()), MaterializeMode::Subscribe);
    assert!(
        h.bindings().contains_key(&key(ObjectBindingKind::Chart, &gone.to_string(), "/spec/title")),
        "precondition: v1 bound the chart v2 removes"
    );

    // v2: the title reads A2, the subtitle binding is gone, and so is "Gone".
    app.wb.charts.retain(|c| c.id != gone);
    app.wb.object_bindings = vec![
        row("canvasPage", &app.dashboard.to_string(), "/background", "=Data!A1"),
        row("chart", &app.chart.to_string(), "/spec/title", "=Data!A2"),
        row("control", "app-btn", "/properties/text", "=Data!A1"),
    ];
    app.publish(&dir, prof.path(), (1, 1, 0), Some((1, 0, 0)));
    h.refresh(subscribe_pull(&dir, prof.path()));

    let b = h.bindings();
    let chart = app.chart.to_string();
    assert_eq!(
        b.get(&key(ObjectBindingKind::Chart, &chart, "/spec/title")).map(|s| s.formula.as_str()),
        Some("='Data (2)'!A2"),
        "the changed formula arrives (renamed): {b:#?}"
    );
    assert!(
        !b.contains_key(&key(ObjectBindingKind::Chart, &chart, "/spec/subtitle")),
        "a binding the publisher removed stops binding: {b:#?}"
    );
    let page = h.sheet_id_named("Dashboard");
    assert!(b.contains_key(&key(ObjectBindingKind::CanvasPage, &page.to_string(), "/background")));
    assert!(b.contains_key(&key(ObjectBindingKind::Control, "app-btn", "/properties/text")));
    assert_eq!(b.get(&own).map(|s| s.formula.as_str()), Some("=Data!B9"), "the subscriber's binding survives");
    assert!(
        !b.contains_key(&key(ObjectBindingKind::Chart, &gone.to_string(), "/spec/title")),
        "the binding of a chart v2 removed is gone with it: {b:#?}"
    );
    assert_eq!(b.len(), 4, "{b:#?}");
}

/// An application published BEFORE bindings existed still carries a button
/// whose caption is a `valueType: "formula"` property. The pull runs the same
/// migration a file open does: the caption becomes a binding of that button,
/// and the literal is emptied.
///
/// SABOTAGE: drop the `migrate_legacy_formulas` call from
/// `materialize_pull_result` -- no binding appears.
#[test]
fn a_pulled_legacy_formula_property_becomes_a_binding() {
    let dir = TempDir::new().unwrap();
    let prof = TempDir::new().unwrap();
    let mut app = App::new();
    app.wb.object_bindings.clear();
    app.wb.controls[0].controls = serde_json::json!([{
        "row": 2, "col": 2, "controlType": "button", "uid": "app-btn",
        "properties": { "text": { "valueType": "formula", "value": "=Data!A1" } }
    }]);
    app.publish(&dir, prof.path(), (1, 0, 0), None);

    let h = Harness::new(); // no "Data" of its own: no collision rename
    h.materialize(subscribe_pull(&dir, prof.path()), MaterializeMode::Subscribe);

    let b = h.bindings();
    assert_eq!(
        b.get(&key(ObjectBindingKind::Control, "app-btn", "/properties/text")).map(|s| s.formula.as_str()),
        Some("=Data!A1"),
        "{b:#?}"
    );
    let controls = h.state.controls.read().unwrap();
    let meta = controls.values().find(|m| m.uid == "app-btn").expect("the button landed");
    assert_eq!(meta.properties["text"].value_type, "static");
    assert_eq!(meta.properties["text"].value, "");
}

/// A pulled application chart and the subscriber's OWN chart whose titles are
/// the LITERAL text `=...` (a bindings-era literal, stored through a script
/// `setLiteral` or MCP) keep that text through a subscribe and a refresh: the
/// pull's migration is controls-only, so no binding appears on either chart.
///
/// SABOTAGE: pass `ChartTextFields::LegacyCellReferences` in
/// `materialize_pull_result` -- both titles become bindings.
#[test]
fn a_literal_equals_chart_title_survives_a_pull_and_a_refresh() {
    let dir = TempDir::new().unwrap();
    let prof = TempDir::new().unwrap();
    let mut app = App::new();
    app.wb.object_bindings.clear();
    app.wb.charts[0].spec["spec"]["title"] = serde_json::json!("=Data!A1");
    app.publish(&dir, prof.path(), (1, 0, 0), None);

    let h = Harness::new();
    let mine = new_entity();
    let spec = serde_json::json!({ "chartId": 9, "name": "Mine", "sheetIndex": 0, "spec": { "mark": "bar", "title": "=B2" } });
    h.state.charts.write(&effect()).unwrap().push(crate::api_types::ChartEntry {
        id: mine,
        sheet_index: 0,
        spec_json: spec.to_string(),
    });
    let title_of = |id: identity::EntityId| -> serde_json::Value {
        let charts = h.state.charts.read().unwrap();
        let entry = charts.iter().find(|c| c.id == id).expect("chart present");
        serde_json::from_str::<serde_json::Value>(&entry.spec_json).unwrap()["spec"]["title"].clone()
    };

    h.materialize(subscribe_pull(&dir, prof.path()), MaterializeMode::Subscribe);
    assert!(h.bindings().is_empty(), "no binding nobody created: {:#?}", h.bindings());
    assert_eq!(title_of(mine), serde_json::json!("=B2"), "the subscriber's literal is text");
    assert_eq!(title_of(app.chart), serde_json::json!("=Data!A1"), "the application's literal is text");

    app.publish(&dir, prof.path(), (1, 1, 0), Some((1, 0, 0)));
    h.refresh(subscribe_pull(&dir, prof.path()));
    assert!(h.bindings().is_empty(), "a refresh migrates no literal either: {:#?}", h.bindings());
    assert_eq!(title_of(mine), serde_json::json!("=B2"));
}

/// A Page Navigator's per-button binding names its page IN THE PATH
/// (`/properties/pageOverrides/<sheetId>/text`, D §3.18a). A subscribe mints
/// its own sheet ids, so the path's page segment is remapped to the LOCAL
/// Dashboard -- the same id WP-B's `PageTargetRemap` gives the literal's entry
/// -- and the pulled binding paints on the pulled navigator's button.
///
/// SABOTAGE: return false at the top of `carriage::remap_per_button_page` --
/// the binding lands under the publisher's page id, which names no page here.
#[test]
fn a_pulled_navigator_binding_follows_its_page_to_the_local_id() {
    let dir = TempDir::new().unwrap();
    let prof = TempDir::new().unwrap();
    let mut app = App::new();
    let dash = app.dashboard.to_string();
    let overrides = format!(r##"[{{"sheetId":"{dash}","sheetName":"Dashboard","fill":"#123"}}]"##);
    app.wb.controls[0].controls = serde_json::json!([
        {
            "row": 2, "col": 2, "controlType": "button", "uid": "app-btn",
            "properties": { "text": { "valueType": "static", "value": "" } }
        },
        {
            "row": 4, "col": 2, "controlType": "pageNavigator", "uid": "app-nav",
            "properties": {
                "orientation": { "valueType": "static", "value": "horizontal" },
                "pageOverrides": { "valueType": "static", "value": overrides }
            }
        }
    ]);
    let published_path = format!("/properties/pageOverrides/{dash}/text");
    app.wb.object_bindings.push(row("control", "app-nav", &published_path, "=Data!A1"));
    app.publish(&dir, prof.path(), (1, 0, 0), None);

    let h = Harness::new();
    h.materialize(subscribe_pull(&dir, prof.path()), MaterializeMode::Subscribe);

    let local = h.sheet_id_named("Dashboard").to_string();
    assert_ne!(local, dash, "a subscribe mints its own sheet ids");
    let b = h.bindings();
    let local_path = format!("/properties/pageOverrides/{local}/text");
    assert_eq!(
        b.get(&key(ObjectBindingKind::Control, "app-nav", &local_path)).map(|s| s.formula.as_str()),
        Some("=Data!A1"),
        "the binding's page segment is the LOCAL page: {b:#?}"
    );
    assert!(!b.keys().any(|k| k.path.contains(&dash)), "no path names the publisher's page: {b:#?}");
    let (anchor, literal) = {
        let controls = h.state.controls.read().unwrap();
        let (anchor, meta) = controls.iter().find(|(_, m)| m.uid == "app-nav").expect("the navigator landed");
        (*anchor, meta.properties["pageOverrides"].value.clone())
    };
    assert!(literal.contains(&local), "the literal's entry names the same local page: {literal}");

    // ...so the binding patches THAT entry: Data!A1 (21) paints as the caption.
    let file = crate::persistence::FileState::default();
    let cx = super::BindingCx {
        state: &h.state,
        file_state: &file,
        slicers: &h.slicer,
        timelines: &h.timeline,
        pivots: &h.pivot,
        pane: &h.pane,
        ribbon: &h.ribbon,
    };
    super::resolve_all_core(&cx);
    let painted = crate::controls::resolve_control_properties_core(&h.state, anchor.0, anchor.1, anchor.2);
    let painted = calcula_format::page_navigator::parse_page_overrides(&painted["pageOverrides"]).expect("parses");
    assert_eq!(painted.len(), 1, "the pulled entry is patched, not duplicated: {painted:?}");
    assert_eq!((painted[0].sheet_id.as_str(), painted[0].text.as_deref()), (local.as_str(), Some("21")));
    assert_eq!(painted[0].fill.as_deref(), Some("#123"));
}

/// The PUSH carrier collects the bindings BEFORE the collision rename is
/// undone, so `restore_published_sheet_references` puts the application's
/// sheet names back in their formulas too; collected after it, a working copy
/// would ship "Data (2)" in every binding.
///
/// SABOTAGE: move the `collect_bindings_for_save` block below the
/// `restore_published_sheet_references` call -- the order assertion fails.
#[test]
fn the_push_carrier_collects_bindings_before_the_rename_is_undone() {
    let src = std::fs::read_to_string(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src/calp_commands.rs"),
    )
    .expect("calp_commands.rs");
    let start = src.find("fn assemble_publish_workbook(").expect("the assembly");
    let body = &src[start..];
    let body = &body[..body.find("\n}\n").expect("the end of the assembly")];
    let collect = body.find("collect_bindings_for_save(").expect("the assembly collects the bindings");
    let restore = body
        .find("restore_published_sheet_references(&mut workbook")
        .expect("the assembly restores the published names");
    assert!(collect < restore, "the bindings must be on the carrier before the published names are restored");
}
