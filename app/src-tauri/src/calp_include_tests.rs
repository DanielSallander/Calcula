//! FILENAME: app/src-tauri/src/calp_include_tests.rs
//! PURPOSE: M4, the two prerequisites of macro-linked buttons that work:
//!
//! * "INCLUDE IN APPLICATION" (plan S4). A macro, notebook or name the author
//!   creates in a working copy is theirs, so a push withholds it -- and a button
//!   linked to that macro then shipped dead. The push dialog can now ADD such an
//!   item, with its code on screen: the request names the hash Rust computed of
//!   what was shown, and a push whose item changed since is refused
//!   (`CALP_PUSH_INCLUDED_CHANGED`). Once shipped, the link records it, so the
//!   next push keeps it without a tick.
//! * A BUTTON THAT RUNS A MACRO THE PUSH DOES NOT PUBLISH IS REFUSED (plan S5),
//!   with the remedy that works -- include your own macro, unlink another
//!   application's, restore a missing one (`CALP_PUSH_BUTTON_MACRO_NOT_SHIPPED`).
//!   It used to be a warning core publish printed AFTER writing the version.
//!
//! CONTEXT: `calp_publish` needs Tauri state and a window, so -- the house
//! pattern (`held_button_code_tests`, `calp_developer_anchor_tests`) -- the
//! gates are exercised through the functions `calp_publish` calls, over a
//! carrier built the way `assemble_publish_workbook` builds it from a REAL
//! checkout of a REAL signed workspace, and placement censuses pin where
//! `calp_publish` calls them.

use std::path::Path;

use tempfile::TempDir;

use calp::publish::{self, PublishCustomObject, PublishRequest, PushMode};
use calp::version::SemVer;
use calp::workspace::LocalWorkspace;
use engine::cell::Cell;
use persistence::{SavedCell, SavedScript, SavedScriptScope, SavedSheetControls, Sheet, Workbook};

use crate::calp_commands::{materialize_pull_result, MaterializeMode, PublishAssembly};
use crate::calp_push_scope::{
    shipped_content, withhold_content_not_in_application, IncludedItem, PushContent, PushScope,
};
use crate::controls::{ControlMetadata, ControlPropertyValue};
use crate::document_effect::test_seed_effect;
use crate::held_button_code::{
    refuse_push_on_changed_inclusion, refuse_push_on_unshipped_macros, MacroLinkKind,
    MacroLinkRemedy, SignedBase,
};
use crate::persistence::FileState;
use crate::scripting::types::WorkbookScript;

/// A name no real application uses: the authorised reader consults this
/// machine's pin store (read-only), and a unique name keeps that out of play.
const PKG: &str = "m4-include-in-application";
const NOW: &str = "2026-09-30T00:00:00Z";

// ============================================================================
// Fixtures
// ============================================================================

/// The application: "Dashboard" with one button at B2 linked to the
/// application's own macro `macro-report`, which it ships.
fn application() -> Workbook {
    let mut sheet = Sheet::new("Dashboard".to_string());
    sheet
        .cells
        .insert((0, 0), SavedCell::from_cell(&Cell::new_text("Sales".to_string())));
    let mut wb = Workbook::default();
    wb.controls = vec![SavedSheetControls {
        sheet_id: sheet.id,
        controls: serde_json::json!([
            { "row": 1, "col": 1, "controlType": "button", "properties": {
                "macroRef": { "valueType": "static", "value": "macro-report" },
                "text": { "valueType": "static", "value": "Run report" }
            } }
        ]),
    }];
    wb.scripts = vec![SavedScript {
        id: "macro-report".to_string(),
        name: "Report".to_string(),
        description: None,
        source: "Report();".to_string(),
        scope: SavedScriptScope::Workbook,
        source_package: None,
    }];
    wb.sheets = vec![sheet];
    wb
}

fn publish_version(reg: &LocalWorkspace, prof: &Path, wb: &Workbook, version: SemVer, mode: PushMode) {
    let request = PublishRequest {
        workbook: wb,
        package_name: PKG.to_string(),
        version,
        kind: "report".to_string(),
        mode,
        change_summary: "a change".to_string(),
        sheet_indices: vec![0],
        now: NOW.to_string(),
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
    publish::publish(reg, &request, prof).expect("publish failed");
}

fn location(dir: &TempDir) -> String {
    dir.path().to_string_lossy().to_string()
}

/// The stores `materialize_pull_result` writes into.
struct Stores {
    state: crate::AppState,
    pivot: crate::pivot::types::PivotState,
    bi: crate::bi::types::BiState,
    scripts: crate::scripting::types::ScriptState,
    ribbon: crate::ribbon_filter::RibbonFilterState,
    pane: crate::pane_control::PaneControlState,
    slicer: crate::slicer::SlicerState,
    timeline: crate::timeline_slicer::TimelineSlicerState,
}

impl Stores {
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
}

/// A workspace where the author published `application()` as 1.0.0, checked
/// out into a fresh workbook (checkout is ADDITIVE: the application lands
/// beside Sheet1), with the working-copy link `calp_checkout` records --
/// including the record of what the base carried.
struct WorkingCopy {
    dir: TempDir,
    author: TempDir,
    stores: Stores,
    app: Workbook,
    /// Where "Dashboard" landed in the working copy.
    dashboard: usize,
}

fn check_out() -> WorkingCopy {
    let dir = TempDir::new().unwrap();
    let author = TempDir::new().unwrap();
    let reg = LocalWorkspace::open(dir.path()).unwrap();
    let app = application();
    publish_version(&reg, author.path(), &app, SemVer::new(1, 0, 0), PushMode::CreateNew);

    let scope = calp::workspace_scope(&location(&dir)).unwrap();
    let checked_out = calp::checkout::checkout(&reg, PKG, Some(SemVer::new(1, 0, 0)), NOW, &scope, author.path())
        .expect("checkout");
    let stores = Stores::new();
    let base_sheets = checked_out
        .pulled
        .sheets
        .iter()
        .map(|s| calp::WorkingCopySheetRef { sheet_id: s.package_sheet_id, name: s.name.clone() })
        .collect();
    let effect = crate::document_effect::DocumentEffect::mutates(&FileState::default());
    materialize_pull_result(
        &stores.state,
        &effect,
        &stores.pivot,
        &stores.bi,
        &stores.scripts,
        &stores.ribbon,
        &stores.pane,
        &stores.slicer,
        &stores.timeline,
        checked_out.pulled,
        MaterializeMode::Checkout,
        None,
    )
    .expect("materialization failed");
    let mut link = calp::WorkingCopyLink::new(&location(&dir), PKG, "report", "1.0.0", NOW, base_sheets);
    link.record_content(calp::WorkingCopyContent {
        script_ids: vec!["macro-report".to_string()],
        ..calp::WorkingCopyContent::default()
    });
    *stores.state.working_copy_link.write(&test_seed_effect()).unwrap() = Some(link);
    let dashboard = stores
        .state
        .sheet_ids
        .read()
        .unwrap()
        .iter()
        .position(|s| *s == app.sheets[0].id)
        .expect("the application's sheet is in the workbook");
    WorkingCopy { dir, author, stores, app, dashboard }
}

impl WorkingCopy {
    fn reg(&self) -> LocalWorkspace {
        LocalWorkspace::open(self.dir.path()).unwrap()
    }

    /// The author writes a macro of their own IN the working copy.
    fn record_macro(&self, id: &str, name: &str, source: &str) {
        self.stores.scripts.workbook_scripts.write(&test_seed_effect()).unwrap().insert(
            id.to_string(),
            WorkbookScript {
                id: id.to_string(),
                name: name.to_string(),
                description: None,
                source: source.to_string(),
                scope: Default::default(),
                source_package: None,
            },
        );
    }

    /// The author adds a button of their own on the Dashboard, linked to `macro_id`.
    fn link_new_button(&self, row: u32, col: u32, macro_id: &str) {
        let props = [("macroRef", macro_id), ("text", "New button")]
            .into_iter()
            .map(|(k, v)| (k.to_string(), ControlPropertyValue { value_type: "static".into(), value: v.into() }))
            .collect();
        self.stores
            .state
            .controls
            .write(&test_seed_effect())
            .unwrap()
            .insert((self.dashboard, row, col), ControlMetadata { control_type: "button".into(), properties: props });
    }

    /// The publish carrier as `assemble_publish_workbook` builds it for this
    /// push -- the live controls and module scripts, then THE SAME
    /// `filter_and_release` the assembly calls (with the request's inclusions)
    /// -- publishing the Dashboard (carrier index 0).
    fn assemble(&self, included: &[IncludedItem]) -> PublishAssembly {
        let mut workbook = self.app.clone();
        workbook.controls = crate::controls::collect_controls_for_save(
            &self.stores.state.controls.read().unwrap(),
            &self.stores.state.sheet_ids.read().unwrap(),
        );
        let mut scripts: Vec<SavedScript> = self
            .stores
            .scripts
            .workbook_scripts
            .read()
            .unwrap()
            .values()
            .map(|s| SavedScript {
                id: s.id.clone(),
                name: s.name.clone(),
                description: s.description.clone(),
                source: s.source.clone(),
                scope: SavedScriptScope::Workbook,
                source_package: s.source_package.clone(),
            })
            .collect();
        scripts.sort_by(|a, b| a.id.cmp(&b.id));
        workbook.scripts = scripts;

        // THE PRODUCTION COMPOSITION -- the filter (with the request's
        // inclusions) and the release, exactly as `assemble_publish_workbook`
        // runs them -- so these tests prove the push, not a re-implementation.
        let mut object_scripts = None;
        let base = SignedBase::new(&location(&self.dir), PKG);
        let (PushContent { withheld, added }, button_code) = crate::calp_commands::filter_and_release(
            &self.stores.state,
            &mut workbook,
            &mut object_scripts,
            &location(&self.dir),
            PKG,
            &[0],
            included,
            &base,
        )
        .expect("filter and release");
        assembly(workbook, withheld, added, button_code, object_scripts, Vec::new())
    }

    fn versions(&self) -> usize {
        self.reg().get_application_manifest(PKG).unwrap().versions.len()
    }
}

fn assembly(
    workbook: Workbook,
    withheld: Vec<crate::calp_push_scope::WithheldContent>,
    added: Vec<crate::calp_push_scope::WithheldContent>,
    button_code: crate::held_button_code::ButtonCodeRelease,
    object_scripts: Option<Vec<persistence::SavedObjectScript>>,
    cell_type_objects: Vec<PublishCustomObject>,
) -> PublishAssembly {
    PublishAssembly {
        workbook,
        writeback_regions: None,
        object_scripts,
        data_sources: Vec::new(),
        model_writebacks: Vec::new(),
        excluded_regions: Vec::new(),
        withheld,
        added_to_application: added,
        button_code,
        cell_type_objects,
    }
}

fn include_of(item: &crate::calp_push_scope::WithheldContent) -> IncludedItem {
    IncludedItem { kind: item.kind, id: item.id.clone(), hash: item.content_hash.clone() }
}

/// The ButtonCodeRefused rows the audit log holds.
fn refusal_rows(state: &crate::AppState) -> Vec<calp::audit::AuditEntry> {
    state
        .audit_log
        .read()
        .unwrap()
        .entries
        .iter()
        .filter(|e| matches!(e.event, calp::audit::AuditEvent::ButtonCodeRefused))
        .cloned()
        .collect()
}

// ============================================================================
// S4: "Include in application"
// ============================================================================

/// THE REMEDY WORKS. A macro the author recorded in the working copy is
/// withheld by default, offered with its code and hash; a push that includes
/// that hash publishes it (`modules/{id}.json` in the new version), the link
/// records it, and the NEXT push keeps it with no tick at all.
///
/// SABOTAGE: `PushScope::includes` returns `false` (the inclusion is ignored).
#[test]
fn a_push_that_includes_a_new_macro_publishes_it_and_the_link_records_it() {
    let wc = check_out();
    wc.record_macro("macro-new", "New report", "NewReport();");

    let preview = wc.assemble(&[]);
    let offered = preview.withheld.iter().find(|w| w.id == "macro-new").expect("the new macro is withheld by default");
    assert!(offered.includable, "{offered:?}");
    assert_eq!(offered.code, "NewReport();", "the dialog is shown exactly what is hashed");
    let included = [include_of(offered)];

    let push = wc.assemble(&included);
    assert_eq!(push.added_to_application.iter().map(|a| a.id.as_str()).collect::<Vec<_>>(), vec!["macro-new"]);
    refuse_push_on_changed_inclusion(&wc.stores.state, &push, &included, &location(&wc.dir), PKG)
        .expect("an inclusion that matches what was shown passes");
    refuse_push_on_unshipped_macros(&wc.stores.state, &push, &[0], &location(&wc.dir), PKG)
        .expect("every linked macro ships");
    assert!(push.button_code.refusal().is_none(), "{:?}", push.button_code.refused);

    publish_version(
        &wc.reg(),
        wc.author.path(),
        &push.workbook,
        SemVer::new(1, 0, 1),
        PushMode::Update { expected_base: SemVer::new(1, 0, 0) },
    );
    let module = wc
        .reg()
        .read_artifact(PKG, "1.0.1", "modules/macro-new.json")
        .unwrap()
        .expect("the included macro is in the new version");
    assert!(String::from_utf8_lossy(&module).contains("NewReport();"));

    // What `calp_publish` records after the push lands.
    {
        let mut link = wc.stores.state.working_copy_link.write(&test_seed_effect()).unwrap();
        let link = link.as_mut().unwrap();
        let sheets = link.base_sheets.clone();
        link.record_push("1.0.1", NOW, sheets, shipped_content(&push.workbook));
        assert!(link.base_script_ids.contains(&"macro-new".to_string()), "{:?}", link.base_script_ids);
    }

    // The next push keeps it without being asked.
    let next = wc.assemble(&[]);
    assert!(next.workbook.scripts.iter().any(|s| s.id == "macro-new"), "the second push dropped it");
    assert!(next.withheld.iter().all(|w| w.id != "macro-new"), "{:?}", next.withheld);
    assert!(next.added_to_application.is_empty(), "it is the application's now, not an addition");
}

/// A TICK FOR CODE THAT CHANGED SINCE IT WAS READ REFUSES THE PUSH, by name,
/// before anything is written -- and leaves an always-on `ButtonCodeRefused`
/// row (reason "includedChanged") with collaboration auditing OFF. The filter
/// already kept the changed macro out; this is what turns that silent drop
/// into a refusal the author can act on.
///
/// SABOTAGE: make `refuse_push_on_changed_inclusion` return `Ok(())` at once.
#[test]
fn an_inclusion_whose_code_changed_since_the_preview_is_refused_before_any_write() {
    let wc = check_out();
    wc.record_macro("macro-new", "New report", "NewReport();");
    let shown = include_of(
        wc.assemble(&[]).withheld.iter().find(|w| w.id == "macro-new").expect("offered"),
    );
    // Edited after the author read it (or a crafted file swapped the bytes).
    wc.record_macro("macro-new", "New report", "fetch('https://example.invalid');");

    let push = wc.assemble(std::slice::from_ref(&shown));
    assert!(push.workbook.scripts.iter().all(|s| s.id != "macro-new"), "changed code rode a stale tick");
    assert!(!wc.stores.state.audit_log.read().unwrap().enabled, "precondition: auditing is off");
    let err = refuse_push_on_changed_inclusion(&wc.stores.state, &push, &[shown], &location(&wc.dir), PKG)
        .expect_err("a changed inclusion must refuse the push");
    assert!(err.starts_with("CALP_PUSH_INCLUDED_CHANGED:"), "{err}");
    assert!(err.contains("'New report': it changed since you reviewed it"), "{err}");
    assert!(err.contains("Nothing was pushed"), "{err}");
    assert_eq!(wc.versions(), 1, "a refusal published nothing");

    let rows = refusal_rows(&wc.stores.state);
    assert_eq!(rows.len(), 1, "{rows:?}");
    assert_eq!(rows[0].extra["door"], "push");
    assert_eq!(rows[0].extra["reason"], "includedChanged");
    assert_eq!(rows[0].extra["items"][0]["id"], "macro-new");
}

// ============================================================================
// S5: a button whose macro the push does not publish
// ============================================================================

/// THE AUTHOR'S NEW BUTTON, LINKED TO THEIR NEW MACRO. Without the macro the
/// push refuses, naming the button and the remedy -- include it -- and leaves an
/// always-on row with auditing off. The SAME push with the macro included
/// passes: the remedy works.
///
/// SABOTAGE: make `refuse_push_on_unshipped_macros` return `Ok(())` at once;
/// or build the shipped set from the carrier BEFORE the filter (the
/// withheld macro then counts as shipped).
#[test]
fn a_push_whose_button_links_the_authors_unincluded_macro_is_refused_with_the_include_remedy() {
    let wc = check_out();
    wc.record_macro("macro-new", "New report", "NewReport();");
    wc.link_new_button(4, 1, "macro-new");

    let push = wc.assemble(&[]);
    assert!(!wc.stores.state.audit_log.read().unwrap().enabled, "precondition: auditing is off");
    let err = refuse_push_on_unshipped_macros(&wc.stores.state, &push, &[0], &location(&wc.dir), PKG)
        .expect_err("a button that runs a macro the push leaves behind must refuse it");
    assert!(err.starts_with("CALP_PUSH_BUTTON_MACRO_NOT_SHIPPED:"), "{err}");
    assert!(err.contains("the button at Dashboard!B5 runs your macro \"New report\" (macro-new)"), "{err}");
    assert!(err.contains("tick Include in application"), "the refusal names the remedy that works: {err}");
    assert_eq!(wc.versions(), 1);

    let rows = refusal_rows(&wc.stores.state);
    assert_eq!(rows.len(), 1, "{rows:?}");
    assert_eq!(rows[0].extra["reason"], "unshippedMacro");
    assert_eq!(rows[0].extra["cells"][0]["cell"], "Dashboard!B5");
    assert_eq!(rows[0].extra["cells"][0]["remedy"], "include");

    // The remedy: include the macro, as shown.
    let offered = push.withheld.iter().find(|w| w.id == "macro-new").expect("offered");
    let included = [include_of(offered)];
    let fixed = wc.assemble(&included);
    refuse_push_on_unshipped_macros(&wc.stores.state, &fixed, &[0], &location(&wc.dir), PKG)
        .expect("once the macro is included the button ships working");
}

/// The APPLICATION'S OWN LINK, held at checkout and restored at push, to a
/// macro the application ships, is not refused -- the positive control for
/// every refusal here, through a real checkout and release.
#[test]
fn a_restored_held_link_to_a_shipped_macro_is_not_refused() {
    let wc = check_out();
    let push = wc.assemble(&[]);
    assert_eq!(push.button_code.restored.len(), 1, "the application's link came back: {:?}", push.button_code);
    assert!(push.workbook.scripts.iter().any(|s| s.id == "macro-report"));
    refuse_push_on_unshipped_macros(&wc.stores.state, &push, &[0], &location(&wc.dir), PKG)
        .expect("an untouched working copy pushes");
    assert!(refusal_rows(&wc.stores.state).is_empty());
}

/// A carrier with one "Dashboard" sheet whose button at B2 links `macro_id`,
/// holding `scripts`, filtered for a working copy of PKG whose base carried no
/// scripts. Pure -- no workspace.
fn filtered(macro_id: &str, scripts: Vec<SavedScript>) -> (PublishAssembly, crate::AppState) {
    let mut wb = application();
    wb.controls[0].controls[0]["properties"]["macroRef"]["value"] = serde_json::json!(macro_id);
    wb.scripts = scripts;
    let mut link = calp::WorkingCopyLink::new(r"\\server\apps", PKG, "report", "1.0.0", NOW, Vec::new());
    link.record_content(calp::WorkingCopyContent::default());
    let content = withhold_content_not_in_application(
        &mut wb,
        &mut None,
        &PushScope {
            registry_path: r"\\server\apps",
            package_name: PKG,
            link: Some(&link),
            subscriptions: &[],
            published_sheets: &[0],
            included: &[],
        },
    );
    (
        assembly(wb, content.withheld, content.added, Default::default(), None, Vec::new()),
        crate::create_app_state(),
    )
}

/// ANOTHER APPLICATION'S MACRO. It can never be included (it is not the
/// author's to sign), so the remedy is to unlink the button -- or copy the macro.
///
/// SABOTAGE: classify every withheld module as `Include` in
/// `held_button_code::unshipped_macro_links`.
#[test]
fn a_link_to_another_applications_macro_is_refused_with_the_unlink_remedy() {
    let theirs = SavedScript {
        id: "macro-fin".to_string(),
        name: "Close the month".to_string(),
        description: None,
        source: "Close();".to_string(),
        scope: SavedScriptScope::Workbook,
        source_package: Some("finance".to_string()),
    };
    let (push, state) = filtered("macro-fin", vec![theirs]);
    let err = refuse_push_on_unshipped_macros(&state, &push, &[0], r"\\server\apps", PKG)
        .expect_err("another application's macro does not ship");
    assert!(err.contains("belongs to the application 'finance'"), "{err}");
    assert!(err.contains("unlink it, or copy the macro to your own and include the copy"), "{err}");
    assert!(!err.contains("tick Include"), "another application's macro is never includable: {err}");
    let links = crate::held_button_code::unshipped_macro_links(&push, &[0]);
    assert_eq!(links[0].remedy, MacroLinkRemedy::OtherApplication);
    assert_eq!(links[0].owner, "finance");
}

/// A MACRO THAT DOES NOT EXIST in the workbook at all.
#[test]
fn a_link_to_a_missing_macro_is_refused() {
    let (push, state) = filtered("macro-gone", Vec::new());
    let err = refuse_push_on_unshipped_macros(&state, &push, &[0], r"\\server\apps", PKG)
        .expect_err("a dead link does not ship");
    assert!(err.contains("the button at Dashboard!B2 runs the macro 'macro-gone'"), "{err}");
    assert!(err.contains("unlink the button, or restore the macro"), "{err}");
    let rows = refusal_rows(&state);
    assert_eq!(rows[0].extra["cells"][0]["remedy"], "missing");
}

/// A BUTTON CELL is the other channel a button's macro travels by
/// (BUG-0260): its script action naming a macro the push leaves behind refuses
/// the push the same way.
///
/// SABOTAGE: drop the `cells` half (`unshipped_cell_macro_links`) from
/// `held_button_code::unshipped_macro_links`.
#[test]
fn a_button_cell_naming_an_unshipped_macro_refuses_too() {
    let (mut push, state) = filtered("macro-report", vec![application().scripts[0].clone()]);
    // The base carried no scripts, so macro-report is the author's own here --
    // withheld; the control's link and the cell's action both name it.
    push.cell_type_objects = vec![PublishCustomObject {
        kind: "cellType".to_string(),
        id: "cell-types".to_string(),
        name: "Dashboard".to_string(),
        sheet_id: Some(push.workbook.sheets[0].id),
        payload: serde_json::json!([
            { "row": 3, "col": 2, "typeId": "calcula.button", "params": {
                "label": "Go", "action": { "kind": "script", "scriptId": "macro-gone" } } },
            { "row": 5, "col": 2, "typeId": "calcula.button", "params": {
                "label": "Cmd", "action": { "kind": "command", "commandId": "format.bold" } } }
        ]),
    }];
    let links = crate::held_button_code::unshipped_macro_links(&push, &[0]);
    let got: Vec<(&str, MacroLinkKind, MacroLinkRemedy)> =
        links.iter().map(|l| (l.cell.as_str(), l.kind, l.remedy)).collect();
    assert_eq!(
        got,
        vec![
            ("Dashboard!B2", MacroLinkKind::Control, MacroLinkRemedy::Include),
            ("Dashboard!C4", MacroLinkKind::Cell, MacroLinkRemedy::Missing),
        ],
        "a command action names no macro and is not this check's business"
    );
    let err = refuse_push_on_unshipped_macros(&state, &push, &[0], r"\\server\apps", PKG).unwrap_err();
    assert!(err.contains("the button cell at Dashboard!C4 runs the macro 'macro-gone'"), "{err}");
}

/// THE PREVIEW REPORTS, NEVER REFUSES. The push report carries every such
/// button with its remedy (the same classifier the refusal runs) and what the
/// push adds, on the wire the dialog reads; neither preview command, nor the
/// in-memory preview publish, calls a refusing gate.
///
/// SABOTAGE: build the report with `unshipped_macro_links: Vec::new()`.
#[test]
fn the_preview_reports_unshipped_links_without_refusing() {
    let (push, state) = filtered("macro-gone", Vec::new());
    let report = crate::calp_commands::compute_publish_report(
        &push,
        &state,
        &[0],
        false,
        &crate::calp_commands::PublishSelection::default(),
    );
    assert_eq!(report.unshipped_macro_links.len(), 1, "{:?}", report.unshipped_macro_links);
    let json = serde_json::to_value(&report).unwrap();
    assert_eq!(
        json["unshippedMacroLinks"][0],
        serde_json::json!({
            "cell": "Dashboard!B2",
            "kind": "control",
            "macroId": "macro-gone",
            "macroName": "",
            "remedy": "missing",
            "owner": "",
        })
    );
    assert!(json["addedToApplication"].as_array().is_some_and(|a| a.is_empty()), "{json}");
    assert!(refusal_rows(&state).is_empty(), "the report refused something");

    let cmds = source("src/calp_commands.rs");
    for door in ["pub fn calp_publish_preview(", "pub(crate) fn publish_into_for_preview("] {
        let body = body_of(&cmds, door);
        for gate in ["refuse_push_on_unshipped_macros(", "refuse_push_on_changed_inclusion(", "macro_reference_warnings"] {
            assert!(!body.contains(gate), "{door} calls {gate} -- a preview must never refuse");
        }
    }
    let core = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/../../core/calp/src/publish.rs"))
        .unwrap();
    assert!(!core.contains("macro_reference_warnings"), "core publish still carries the old warning");
}

// ============================================================================
// Placement: where calp_publish asks
// ============================================================================

/// Comment-stripped source of one file.
fn source(rel: &str) -> String {
    std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join(rel))
        .unwrap()
        .lines()
        .map(|l| l.split("//").next().unwrap_or(""))
        .collect::<Vec<_>>()
        .join("\n")
}

fn body_of<'a>(src: &'a str, signature: &str) -> &'a str {
    let start = src.find(signature).unwrap_or_else(|| panic!("`{signature}` moved or was renamed"));
    let rest = &src[start..];
    &rest[..rest.find("\n}\n").unwrap_or(rest.len())]
}

/// Both new gates run on the ASSEMBLED carrier, before core publish writes a
/// version and before the push's one `DocumentEffect` -- the inclusion gate
/// right after the assembly, the macro-link gate after the button-code gate --
/// and each is handed the request's own list.
///
/// SABOTAGE: move `refuse_push_on_unshipped_macros(` below
/// `calp::publish::publish(`.
#[test]
fn the_push_asks_both_gates_after_the_assembly_and_before_anything_is_written() {
    let cmds = source("src/calp_commands.rs");
    let publish = body_of(&cmds, "pub fn calp_publish(");
    let at = |needle: &str| publish.find(needle).unwrap_or_else(|| panic!("`{needle}` moved out of calp_publish"));
    let assembly = at("assemble_publish_workbook(");
    let inclusion = at("refuse_push_on_changed_inclusion(");
    let button_code = at("refuse_push_on_button_code(");
    let macros = at("refuse_push_on_unshipped_macros(");
    let core = at("calp::publish::publish(");
    let effect = at("DocumentEffect::mutates(");
    assert!(assembly < inclusion && inclusion < button_code, "the inclusion gate follows the assembly");
    assert!(button_code < macros, "the macro-link gate follows the button-code gate");
    for gate in [inclusion, macros] {
        assert!(gate < core && gate < effect, "a gate runs after the version is written");
    }
    let call = &publish[inclusion..];
    assert!(
        call[..call.find(")?;").unwrap()].contains("&params.include_in_application,"),
        "the inclusion gate is not handed the request's own list"
    );
    let call = &publish[assembly..];
    assert!(
        call[..call.find(")?;").unwrap()].contains("&params.include_in_application,"),
        "the assembly does not filter with the request's inclusions"
    );
    // ...and each gate is handed what it judges: the dead-link gate the sheets
    // THIS push publishes (an empty list silently turns off its button-control
    // half), the button-code gate the assembly's release and the request's
    // acknowledgements.
    let call = &publish[macros..];
    let call = &call[..call.find(")?;").unwrap()];
    assert!(
        call.contains("&assembly,\n        &sheet_indices,\n"),
        "the dead-link gate does not judge the sheets this push publishes: {call}"
    );
    let call = &publish[button_code..];
    let call = &call[..call.find(")?;").unwrap()];
    assert!(
        call.contains("&assembly.button_code,\n        &params.acknowledged_button_code,\n"),
        "the button-code gate does not judge the assembly's release against the request: {call}"
    );
}

/// Every door into the assembly says what it includes: the push dialog's
/// publish, preview and diff pass the request's list; the merge passes none.
#[test]
fn every_assembly_door_passes_its_inclusions() {
    let cmds = source("src/calp_commands.rs");
    let preview = body_of(&cmds, "pub fn calp_publish_preview(");
    let call = &preview[preview.find("assemble_publish_workbook(").unwrap()..];
    assert!(call[..call.find(")?;").unwrap()].contains("&params.include_in_application,"));
    // The assembly hands its inclusions to the ONE composition the include
    // tests drive (`filter_and_release`): passing it none would drop every
    // ticked item from every push with those tests still green.
    let assembly = body_of(&cmds, "fn assemble_publish_workbook(");
    let call = &assembly[assembly.find("filter_and_release(").expect("the assembly no longer filters")..];
    assert!(
        call[..call.find(")?;").unwrap()].contains("\n        included,\n"),
        "the assembly does not filter with its inclusions"
    );
    let into = body_of(&cmds, "pub(crate) fn publish_into_for_preview(");
    let call = &into[into.find("assemble_publish_workbook(").unwrap()..];
    assert!(call[..call.find(")?;").unwrap()].contains("included,"));

    let diff = source("src/calp_diff.rs");
    let call = &diff[diff.find("publish_into_for_preview(").unwrap()..];
    assert!(call[..call.find(")?;").unwrap()].contains("&params.include_in_application,"), "the diff drops the inclusions");
    let merge = source("src/calp_merge.rs");
    let call = &merge[merge.find("publish_into_for_preview(").unwrap()..];
    assert!(call[..call.find(")?;").unwrap()].trim_end().ends_with("&[],"), "the merge must include nothing");
}

/// "INCLUDE IN APPLICATION" LANDS IN EVERY DOOR THAT TAKES IT -- pinned on the
/// Rust side. The field is `#[serde(default)]` on all three, so a rename on
/// either side would silently drop every inclusion (and the push would then be
/// refused, or the preview lie) instead of failing to parse.
///
/// SABOTAGE: rename `include_in_application` on `PublishParams` (e.g. to
/// `included_in_application`).
#[test]
fn include_in_application_deserializes_into_every_door_that_takes_it() {
    let items = serde_json::json!([{ "kind": "moduleScript", "id": "macro-mine", "hash": "abc" }]);
    let expected = vec![IncludedItem {
        kind: crate::calp_push_scope::WithheldKind::ModuleScript,
        id: "macro-mine".to_string(),
        hash: "abc".to_string(),
    }];
    let publish: crate::calp_commands::PublishParams = serde_json::from_value(serde_json::json!({
        "registryPath": "C:/ws",
        "packageName": PKG,
        "version": "1.1.0",
        "kind": "report",
        "sheetIndices": [0],
        "publishedBy": "",
        "includeInApplication": items,
    }))
    .unwrap();
    assert_eq!(publish.include_in_application, expected);
    let preview: crate::calp_commands::PublishPreviewParams =
        serde_json::from_value(serde_json::json!({ "includeInApplication": items })).unwrap();
    assert_eq!(preview.include_in_application, expected);
    let diff: crate::calp_diff::DiffWorkingCopyParams =
        serde_json::from_value(serde_json::json!({ "includeInApplication": items })).unwrap();
    assert_eq!(diff.include_in_application, expected);
}
