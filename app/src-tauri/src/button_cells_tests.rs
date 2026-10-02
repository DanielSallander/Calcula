//! FILENAME: app/src-tauri/src/button_cells_tests.rs
//! PURPOSE: BUG-0260 -- a button CELL from an application runs only a macro that
//! application brought into the workbook, never a command, and never the
//! subscriber's (or, at a checkout, the developer's) own macro of the same id.
//! CONTEXT: Four tiers. The pure admission; the doors (subscribe, checkout,
//! refresh) through the real materializers over a real signed workspace; the
//! push release, whose untouched round trip must republish the cell-type payload
//! byte for byte; and the placement census that pins the order the doors run in.

use std::collections::{HashMap, HashSet};
use std::path::Path;

use serde_json::{json, Value};
use tempfile::TempDir;

use calp::publish::{self, PublishCustomObject, PublishRequest, PushMode};
use calp::version::{SemVer, VersionPin};
use calp::workspace::LocalWorkspace;
use persistence::{SavedScript, SavedScriptScope, SavedSheetCellTypes, Sheet, Workbook};

use super::*;
use crate::calp_commands::{materialize_pull_result, MaterializeMode};
use crate::cell_types::SavedCellTypeEntry;
use crate::document_effect::test_seed_effect;
use crate::held_button_code::HeldFrom;
use crate::persistence::FileState;
use crate::scripting::types::{ScriptScope, WorkbookScript};

/// A name no real application uses: the authorised reader consults this
/// machine's pin store (read-only), and a unique name keeps that out of play.
const PKG: &str = "bug0260-button-cells";

// ============================================================================
// Fixtures
// ============================================================================

fn script_action(id: &str) -> Value {
    json!({ "kind": "script", "scriptId": id })
}

fn button(row: u32, col: u32, action: Option<Value>) -> SavedCellTypeEntry {
    let mut params = serde_json::Map::new();
    params.insert("label".to_string(), json!(format!("Button {row}")));
    if let Some(action) = action {
        params.insert("action".to_string(), action);
    }
    SavedCellTypeEntry { row, col, type_id: BUTTON_CELL_TYPE_ID.to_string(), params: Value::Object(params) }
}

/// The payload exactly as the host's collector writes it: sorted by (row, col),
/// each entry through `SavedCellTypeEntry`.
fn payload(mut entries: Vec<SavedCellTypeEntry>) -> Value {
    entries.sort_by_key(|e| (e.row, e.col));
    serde_json::to_value(entries).unwrap()
}

/// "Dashboard"'s buttons:
/// * B2 runs `macro-app`, which the application ships;
/// * C3 runs `macro-report`, which it does NOT ship (the subscriber has one);
/// * D4 runs the command `format.bold`;
/// * E5 runs `macro-shared`, which it ships -- but the subscriber already has a
///   `macro-shared` of their own, so the pull SKIPS it;
/// * F6 has no action; G7 is a checkbox.
fn dashboard_cells() -> Vec<SavedCellTypeEntry> {
    vec![
        button(1, 1, Some(script_action("macro-app"))),
        button(2, 2, Some(json!({ "kind": "script", "scriptId": "macro-report", "functionName": "Exfiltrate" }))),
        button(3, 3, Some(json!({ "kind": "command", "commandId": "format.bold" }))),
        button(4, 4, Some(script_action("macro-shared"))),
        button(5, 5, None),
        SavedCellTypeEntry {
            row: 6,
            col: 6,
            type_id: "calcula.checkbox".to_string(),
            params: json!({}),
        },
    ]
}

fn module(id: &str, source: &str) -> SavedScript {
    SavedScript {
        id: id.to_string(),
        name: id.to_string(),
        description: None,
        source: source.to_string(),
        scope: SavedScriptScope::Workbook,
        source_package: None,
    }
}

/// The application: one sheet "Dashboard", its two macros, its cell types.
fn application(cells: Vec<SavedCellTypeEntry>) -> (Workbook, Vec<PublishCustomObject>) {
    let sheet = Sheet::new("Dashboard".to_string());
    let object = PublishCustomObject {
        kind: "cellType".to_string(),
        id: format!("cellType-{}", sheet.id),
        name: "Cell Types".to_string(),
        sheet_id: Some(sheet.id),
        payload: payload(cells),
    };
    let mut wb = Workbook::default();
    wb.sheets = vec![sheet];
    wb.scripts = vec![
        module("macro-app", "Calcula.log('the application');"),
        module("macro-shared", "Calcula.log('the application shared');"),
    ];
    (wb, vec![object])
}

fn publish_as(
    dir: &TempDir,
    prof: &Path,
    wb: &Workbook,
    objects: Vec<PublishCustomObject>,
    version: SemVer,
    mode: PushMode,
) {
    let reg = LocalWorkspace::open(dir.path()).unwrap();
    let request = PublishRequest {
        workbook: wb,
        package_name: PKG.to_string(),
        version,
        kind: "report".to_string(),
        mode,
        change_summary: "a change".to_string(),
        sheet_indices: vec![0],
        now: "2026-09-30T00:00:00Z".to_string(),
        published_by: "author".to_string(),
        writeback_regions: None,
        model_writebacks: None,
        object_scripts: None,
        module_scripts: None,
        notebooks: None,
        data_sources: Vec::new(),
        excluded_regions: Vec::new(),
        custom_objects: objects,
        include_comments: false,
        min_app_version: String::new(),
    };
    publish::publish(&reg, &request, prof).expect("publish failed");
}

fn location(dir: &TempDir) -> String {
    dir.path().to_string_lossy().to_string()
}

fn artifact(dir: &TempDir, version: &str, rel: &str) -> Option<Vec<u8>> {
    let reg = LocalWorkspace::open(dir.path()).unwrap();
    reg.read_artifact(PKG, version, rel).unwrap()
}

fn pull_latest(dir: &TempDir, prof: &Path) -> calp::pull::PullResult {
    let reg = LocalWorkspace::open(dir.path()).unwrap();
    let scope = calp::workspace_scope(&location(dir)).unwrap();
    calp::pull::pull(
        &reg,
        &calp::pull::PullRequest {
            package_name: PKG.to_string(),
            target: calp::manifest::SubscriptionTarget::Line(VersionPin::Latest),
            now: "2026-09-30T01:00:00Z".to_string(),
        },
        &scope,
        prof,
        calp::integrity::PinPolicy::PinOnFirstUse,
    )
    .expect("pull failed")
}

/// The stores the materializers write into.
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
    /// A workbook whose owner has LOCAL macros `macro-report` and
    /// `macro-shared` -- the ids an application's buttons must never reach.
    fn with_own_macros() -> Self {
        let stores = Self {
            state: crate::create_app_state(),
            pivot: crate::pivot::types::PivotState::new(),
            bi: crate::bi::types::BiState::new(),
            scripts: crate::scripting::types::ScriptState::new(),
            ribbon: crate::ribbon_filter::RibbonFilterState::new(),
            pane: crate::pane_control::PaneControlState::new(),
            slicer: crate::slicer::SlicerState::new(),
            timeline: crate::timeline_slicer::TimelineSlicerState::new(),
        };
        {
            let mut scripts = stores.scripts.workbook_scripts.write(&test_seed_effect()).unwrap();
            for (id, source) in [
                ("macro-report", "Calcula.log('MY OWN report macro');"),
                ("macro-shared", "Calcula.log('MY OWN shared macro');"),
            ] {
                scripts.insert(
                    id.to_string(),
                    WorkbookScript {
                        id: id.to_string(),
                        name: id.to_string(),
                        description: None,
                        source: source.to_string(),
                        scope: ScriptScope::Workbook,
                        source_package: None,
                    },
                );
            }
        }
        stores
    }

    fn materialize(&self, result: calp::pull::PullResult, mode: MaterializeMode) -> crate::calp_commands::PullResponse {
        let effect = crate::document_effect::DocumentEffect::mutates(&FileState::default());
        materialize_pull_result(
            &self.state,
            &effect,
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
        .expect("materialization failed")
    }

    fn refresh(&self, result: calp::pull::PullResult) -> calp::refresh::RefreshResult {
        let mut payloads = vec![calp::refresh::RefreshPayload { subscription_index: 0, pull_result: result }];
        let names = crate::calp_commands::prepare_refresh_payloads(&self.state, &mut payloads)
            .expect("the refresh's pre-effect pass refused");
        crate::calp_commands::apply_refresh_payloads(
            &self.state,
            &crate::document_effect::DocumentEffect::mutates(&FileState::default()),
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
            "2026-09-30T02:00:00Z",
            None,
        )
        .expect("refresh failed")
    }

    fn index_of(&self, name: &str) -> usize {
        self.state.sheet_names.read().unwrap().iter().position(|n| n == name).expect("the sheet")
    }

    fn params(&self, sheet: usize, row: u32, col: u32) -> serde_json::Map<String, Value> {
        self.state.cell_types.read().unwrap()[&(sheet, row, col)]
            .params
            .as_object()
            .cloned()
            .unwrap_or_default()
    }

    fn local_macro_source(&self, id: &str) -> (String, Option<String>) {
        let scripts = self.scripts.workbook_scripts.read().unwrap();
        let s = &scripts[id];
        (s.source.clone(), s.source_package.clone())
    }
}

fn origin() -> HeldFrom {
    HeldFrom {
        workspace: "ws".into(),
        application: "sales".into(),
        version: "1.2.0".into(),
        value_types: Default::default(),
    }
}

fn saved(cells: Vec<SavedCellTypeEntry>) -> (identity::SheetId, Vec<SavedSheetCellTypes>) {
    let sheet = identity::SheetId::from_bytes(identity::generate_uuid_v7());
    (sheet, vec![SavedSheetCellTypes { sheet_id: sheet, cells: payload(cells) }])
}

fn entry_params(out: &[SavedSheetCellTypes], row: u32, col: u32) -> serde_json::Map<String, Value> {
    out[0]
        .cells
        .as_array()
        .unwrap()
        .iter()
        .find(|e| e["row"] == row && e["col"] == col)
        .and_then(|e| e["params"].as_object().cloned())
        .unwrap_or_default()
}

// ============================================================================
// 1. The admission (pure)
// ============================================================================

/// SABOTAGE: have `judge_action` accept every `"script"` action (drop the
/// `applied.contains(id)` guard).
#[test]
fn a_subscribe_keeps_only_an_action_naming_a_macro_the_pull_applied() {
    let (sheet, input) = saved(dashboard_cells());
    let applied: HashSet<String> = ["macro-app".to_string()].into();
    let names: HashMap<_, _> = [(sheet, "Dashboard".to_string())].into();
    let (out, report) = admit_button_cells(
        &input,
        &ButtonCellDoor { from: origin(), applied_modules: &applied, allowed_commands: DISTRIBUTABLE_BUTTON_COMMANDS, wiring: CellActionWiring::Remove, sheet_names: &names },
    );

    let kept = entry_params(&out, 1, 1);
    assert_eq!(kept["action"], script_action("macro-app"), "the application's own macro stays wired");
    assert_eq!(kept[FROM_APPLICATION_PARAM]["application"], "sales");
    assert_eq!(kept[FROM_APPLICATION_PARAM]["version"], "1.2.0");
    for (row, col) in [(2, 2), (3, 3), (4, 4)] {
        let p = entry_params(&out, row, col);
        assert!(!p.contains_key("action"), "B{row}: an action the pull did not earn arrived: {p:?}");
        assert!(!p.contains_key(HELD_ACTION_PARAM), "a subscribe holds nothing");
        assert_eq!(p[FROM_APPLICATION_PARAM]["application"], "sales", "every button is stamped");
    }
    let bare = entry_params(&out, 5, 5);
    assert!(!bare.contains_key("action"));
    assert_eq!(bare[FROM_APPLICATION_PARAM]["application"], "sales");
    // Other cell types pass through byte for byte.
    let checkbox = entry_params(&out, 6, 6);
    assert!(checkbox.is_empty(), "{checkbox:?}");

    assert_eq!(report.kept, 1);
    assert!(report.held.is_empty());
    assert_eq!(report.removed.len(), 3, "{:?}", report.removed);
    assert!(report.removed.iter().any(|n| n.starts_with("Dashboard!C3") && n.contains("macro-report")));
    assert!(report.removed.iter().any(|n| n.starts_with("Dashboard!D4") && n.contains("format.bold")));
    assert!(report.removed.iter().any(|n| n.starts_with("Dashboard!E5") && n.contains("macro-shared")));
}

/// SABOTAGE: make the `Hold` arm drop the action (`CellActionWiring::Hold =>
/// report.removed.push(notice)`).
#[test]
fn a_checkout_holds_what_it_may_not_keep_where_no_click_reads_it() {
    let (sheet, input) = saved(dashboard_cells());
    let applied: HashSet<String> = ["macro-app".to_string()].into();
    let names: HashMap<_, _> = [(sheet, "Dashboard".to_string())].into();
    let (out, report) = admit_button_cells(
        &input,
        &ButtonCellDoor { from: origin(), applied_modules: &applied, allowed_commands: DISTRIBUTABLE_BUTTON_COMMANDS, wiring: CellActionWiring::Hold, sheet_names: &names },
    );
    let held = entry_params(&out, 2, 2);
    assert!(!held.contains_key("action"), "no click may read a held action: {held:?}");
    assert_eq!(
        held[HELD_ACTION_PARAM],
        json!({ "kind": "script", "scriptId": "macro-report", "functionName": "Exfiltrate" }),
        "held byte for byte, so the push can restore it"
    );
    assert_eq!(entry_params(&out, 3, 3)[HELD_ACTION_PARAM]["commandId"], "format.bold");
    assert_eq!(entry_params(&out, 4, 4)[HELD_ACTION_PARAM]["scriptId"], "macro-shared");
    assert_eq!(entry_params(&out, 1, 1)["action"], script_action("macro-app"));
    assert_eq!(report.held.len(), 3);
    assert!(report.removed.is_empty());
}

/// A package never carries the admission's keys, on either door: a held action
/// that arrived would be restored at the developer's next push, and a stamp is
/// what the click trusts.
#[test]
fn a_packages_own_held_action_and_stamp_are_discarded_on_every_door() {
    let forged = json!({ "workspace": "ws", "application": "sales", "version": "1.2.0" });
    let entry = SavedCellTypeEntry {
        row: 0,
        col: 0,
        type_id: BUTTON_CELL_TYPE_ID.to_string(),
        params: json!({
            "heldAction": { "kind": "script", "scriptId": "macro-report" },
            "fromApplication": { "workspace": "elsewhere", "application": "someone-else", "version": "9.9.9" },
            "label": "Go"
        }),
    };
    let (sheet, input) = saved(vec![entry]);
    let names: HashMap<_, _> = [(sheet, "S".to_string())].into();
    for wiring in [CellActionWiring::Remove, CellActionWiring::Hold] {
        let applied = HashSet::new();
        let (out, report) = admit_button_cells(
            &input,
            &ButtonCellDoor { from: origin(), applied_modules: &applied, allowed_commands: DISTRIBUTABLE_BUTTON_COMMANDS, wiring, sheet_names: &names },
        );
        let p = entry_params(&out, 0, 0);
        assert!(!p.contains_key(HELD_ACTION_PARAM), "{wiring:?} admitted a package's held action");
        assert_eq!(p[FROM_APPLICATION_PARAM], forged, "{wiring:?} kept the package's own stamp");
        assert_eq!(report.discarded_claims, 2);
    }
}

#[test]
fn a_button_with_no_params_object_is_left_byte_for_byte() {
    let raw = json!([{ "row": 0, "col": 0, "typeId": BUTTON_CELL_TYPE_ID, "params": null }]);
    let input = vec![SavedSheetCellTypes { sheet_id: identity::SheetId::from_bytes(identity::generate_uuid_v7()), cells: raw.clone() }];
    let applied = HashSet::new();
    let names = HashMap::new();
    let (out, _) = admit_button_cells(
        &input,
        &ButtonCellDoor { from: origin(), applied_modules: &applied, allowed_commands: DISTRIBUTABLE_BUTTON_COMMANDS, wiring: CellActionWiring::Remove, sheet_names: &names },
    );
    assert_eq!(out[0].cells, raw);
}

// ----------------------------------------------------------------------------
// 1b. Commands: Calcula's list (plan_M8 S1)
// ----------------------------------------------------------------------------

/// A command an application's button may run, for the unit tier only: the
/// production list is empty (see `the_production_list_is_empty_until_the_owner_opts_a_command_in`).
const LISTED: &str = "test.reader.refresh";

/// A command ON THE LIST is kept LIVE and stamped on every door -- subscribe
/// and refresh (`Remove`) and checkout (`Hold`): it is not held at a checkout,
/// because it is no longer anything a click may not run. A command NOT on the
/// list beside it is still removed (or held) exactly as before.
///
/// SABOTAGE: `judge_action` ignores the list and refuses every command -> the
/// listed command is removed / held, red.
#[test]
fn an_allowed_command_is_kept_live_and_stamped_on_every_door() {
    let listed = json!({ "kind": "command", "commandId": LISTED });
    let (sheet, input) = saved(vec![
        button(1, 1, Some(listed.clone())),
        button(3, 3, Some(json!({ "kind": "command", "commandId": "format.bold" }))),
    ]);
    let applied = HashSet::new();
    let names: HashMap<_, _> = [(sheet, "Dashboard".to_string())].into();
    for wiring in [CellActionWiring::Remove, CellActionWiring::Hold] {
        let (out, report) = admit_button_cells(
            &input,
            &ButtonCellDoor { from: origin(), applied_modules: &applied, allowed_commands: &[LISTED], wiring, sheet_names: &names },
        );
        let kept = entry_params(&out, 1, 1);
        assert_eq!(kept.get("action"), Some(&listed), "{wiring:?}: a listed command did not stay live: {kept:?}");
        assert!(!kept.contains_key(HELD_ACTION_PARAM), "{wiring:?}: a listed command was held");
        assert_eq!(kept[FROM_APPLICATION_PARAM]["application"], "sales", "{wiring:?}: not stamped");
        assert_eq!(report.kept, 1, "{wiring:?}");
        // The command beside it is not on the list: removed, or held.
        let other = entry_params(&out, 3, 3);
        assert!(!other.contains_key("action"), "{wiring:?}: an unlisted command stayed live");
        match wiring {
            CellActionWiring::Remove => {
                assert_eq!(report.removed.len(), 1, "{:?}", report.removed);
                assert!(report.held.is_empty());
            }
            CellActionWiring::Hold => {
                assert_eq!(other[HELD_ACTION_PARAM]["commandId"], "format.bold");
                assert_eq!(report.held.len(), 1, "{:?}", report.held);
                assert!(report.removed.is_empty());
            }
        }
    }
}

/// A command NOT on the list is removed (subscribe, refresh) or held
/// (checkout) and named as such: the notice says it is not on Calcula's list,
/// no longer that commands are "switched off until" one exists.
///
/// SABOTAGE: `judge_action` answers Ok for every command -> the existing
/// `format.bold` cases above (and this one) go red.
#[test]
fn a_command_not_on_the_list_is_still_removed_and_named_as_such() {
    let (sheet, input) = saved(vec![button(3, 3, Some(json!({ "kind": "command", "commandId": "format.bold" })))]);
    let applied = HashSet::new();
    let names: HashMap<_, _> = [(sheet, "Dashboard".to_string())].into();
    for (wiring, allowed) in [
        (CellActionWiring::Remove, DISTRIBUTABLE_BUTTON_COMMANDS),
        (CellActionWiring::Hold, DISTRIBUTABLE_BUTTON_COMMANDS),
        (CellActionWiring::Remove, &[LISTED][..]),
    ] {
        let (out, report) = admit_button_cells(
            &input,
            &ButtonCellDoor { from: origin(), applied_modules: &applied, allowed_commands: allowed, wiring, sheet_names: &names },
        );
        assert!(!entry_params(&out, 3, 3).contains_key("action"), "{wiring:?} kept an unlisted command live");
        let notices: Vec<&String> = report.removed.iter().chain(report.held.iter()).collect();
        assert_eq!(notices.len(), 1, "{wiring:?}: {notices:?}");
        assert_eq!(
            notices[0],
            "Dashboard!D4: runs the command 'format.bold', which is not on Calcula's list of commands a button from \
             an application may run"
        );
    }
}

/// THE OWNER DECISION, pinned: the list ships EMPTY (plan_M8 S1 -- none of the
/// commands a button can reach is worth running for a report reader). Adding an
/// id changes this test AND the TypeScript drift test that holds the list
/// equal to the commands registered with `distributableTrigger: true`.
#[test]
fn the_production_list_is_empty_until_the_owner_opts_a_command_in() {
    assert!(
        DISTRIBUTABLE_BUTTON_COMMANDS.is_empty(),
        "a command was added to Calcula's list without the owner decision this test pins: {DISTRIBUTABLE_BUTTON_COMMANDS:?}"
    );
}

/// A command approval is recorded under its OWN key, never an application's
/// bare one (the object-script mount floor's key).
#[test]
fn the_command_consent_key_is_never_an_applications_bare_key() {
    assert_eq!(button_command_consent_key("sales"), "button-commands:sales");
    assert_ne!(button_command_consent_key("sales"), "sales");
    assert_eq!(BUTTON_COMMAND_CONSENT_PREFIX, "button-commands:");
}

// ============================================================================
// 2. The doors, over a real signed workspace
// ============================================================================

/// THE PROOF (BUG-0260). The subscriber owns `macro-report` and
/// `macro-shared`. The application's button cells name both -- one the
/// application never shipped, one it shipped but the pull SKIPPED because the
/// id was already the subscriber's -- plus a command. After the subscribe, no
/// such action is in the store, each is named in the response, and the
/// subscriber's own macros are exactly as they were.
///
/// SABOTAGE 1: drop the admission's `applied.contains(id)` guard -> C3 keeps
/// `macro-report`. SABOTAGE 2: feed the admission `result.module_scripts` ids
/// instead of the APPLIED list -> E5 keeps `macro-shared` (the collision case).
#[test]
fn the_subscribers_own_macro_is_never_what_an_applications_button_cell_runs() {
    let dir = TempDir::new().unwrap();
    let alice = TempDir::new().unwrap();
    let subscriber = TempDir::new().unwrap();
    let (wb, objects) = application(dashboard_cells());
    publish_as(&dir, alice.path(), &wb, objects, SemVer::new(1, 0, 0), PushMode::CreateNew);

    let stores = Stores::with_own_macros();
    let response = stores.materialize(pull_latest(&dir, subscriber.path()), MaterializeMode::Subscribe);
    let sheet = stores.index_of("Dashboard");

    // First, the one that matters: no button of the application's names the
    // subscriber's own macro any more.
    for (row, col, id) in [(2, 2, "macro-report"), (4, 4, "macro-shared")] {
        let p = stores.params(sheet, row, col);
        assert!(
            p.get("action").is_none(),
            "{row},{col}: the application's button still names the subscriber's own '{id}': {p:?}"
        );
        assert!(p.get(HELD_ACTION_PARAM).is_none(), "a subscriber holds nothing");
    }
    assert!(stores.params(sheet, 3, 3).get("action").is_none(), "a command survived");

    let kept = stores.params(sheet, 1, 1);
    assert_eq!(kept["action"], script_action("macro-app"));
    assert_eq!(kept.get(FROM_APPLICATION_PARAM).map(|s| s["application"].clone()), Some(json!(PKG)));

    assert_eq!(response.button_actions_removed.len(), 3, "{:?}", response.button_actions_removed);
    assert!(response.button_actions_removed.iter().any(|n| n.contains("Dashboard!C3") && n.contains("macro-report")));
    assert!(response.button_actions_removed.iter().any(|n| n.contains("Dashboard!E5") && n.contains("macro-shared")));
    assert!(response.button_actions_held.is_empty());

    // The subscriber's macros are untouched, and still theirs.
    assert_eq!(stores.local_macro_source("macro-report"), ("Calcula.log('MY OWN report macro');".to_string(), None));
    assert_eq!(stores.local_macro_source("macro-shared"), ("Calcula.log('MY OWN shared macro');".to_string(), None));
    // ...and the application's own macro landed, owned by the application.
    assert_eq!(stores.local_macro_source("macro-app").1.as_deref(), Some(PKG));
}

/// The same at a CHECKOUT: the developer owns `macro-report`; the action that
/// names it is HELD (inert: `action` is gone), not run, not dropped.
#[test]
fn a_checkout_holds_the_action_that_names_the_developers_own_macro() {
    let wc = check_out();
    let held = wc.stores.params(wc.sheet, 2, 2);
    assert!(held.get("action").is_none(), "the developer's own macro is one click away: {held:?}");
    assert_eq!(held[HELD_ACTION_PARAM]["scriptId"], "macro-report");
    assert_eq!(held[FROM_APPLICATION_PARAM]["application"], PKG);
    assert_eq!(held[FROM_APPLICATION_PARAM]["version"], "1.0.0");
    assert!(wc.stores.params(wc.sheet, 4, 4).get("action").is_none(), "the collision case");
    assert_eq!(wc.stores.params(wc.sheet, 1, 1)["action"], script_action("macro-app"));
    assert_eq!(wc.response.button_actions_held.len(), 3, "{:?}", wc.response.button_actions_held);
    assert!(wc.response.button_actions_removed.is_empty());
}

/// A REFRESH is a subscriber's door too: the new version's button that names a
/// macro the refresh did not apply, and its command, are removed and named in
/// the result.
///
/// SABOTAGE: pass `CellActionWiring::Hold` on the refresh door, or skip the
/// refresh admission -> the actions arrive.
#[test]
fn a_refresh_removes_an_action_naming_a_macro_the_refresh_did_not_apply() {
    let dir = TempDir::new().unwrap();
    let alice = TempDir::new().unwrap();
    let subscriber = TempDir::new().unwrap();
    let (wb, objects) = application(vec![button(1, 1, Some(script_action("macro-app")))]);
    publish_as(&dir, alice.path(), &wb, objects, SemVer::new(1, 0, 0), PushMode::CreateNew);
    let stores = Stores::with_own_macros();
    let first = stores.materialize(pull_latest(&dir, subscriber.path()), MaterializeMode::Subscribe);
    assert!(first.button_actions_removed.is_empty(), "{:?}", first.button_actions_removed);

    // v1.1.0 adds a button naming the subscriber's macro, and a command.
    let v2 = wb.clone();
    let objects = vec![PublishCustomObject {
        kind: "cellType".to_string(),
        id: format!("cellType-{}", wb.sheets[0].id),
        name: "Cell Types".to_string(),
        sheet_id: Some(wb.sheets[0].id),
        payload: payload(vec![
            button(1, 1, Some(script_action("macro-app"))),
            button(2, 2, Some(script_action("macro-report"))),
            button(3, 3, Some(json!({ "kind": "command", "commandId": "format.bold" }))),
        ]),
    }];
    publish_as(&dir, alice.path(), &v2, objects, SemVer::new(1, 1, 0), PushMode::Update { expected_base: SemVer::new(1, 0, 0) });

    let result = stores.refresh(pull_latest(&dir, subscriber.path()));
    let sheet = stores.index_of("Dashboard");
    assert_eq!(stores.params(sheet, 1, 1)["action"], script_action("macro-app"), "an applied module keeps its button");
    assert_eq!(stores.params(sheet, 1, 1)[FROM_APPLICATION_PARAM]["version"], "1.1.0");
    assert!(stores.params(sheet, 2, 2).get("action").is_none(), "the refresh armed the subscriber's own macro");
    assert!(stores.params(sheet, 2, 2).get(HELD_ACTION_PARAM).is_none());
    assert!(stores.params(sheet, 3, 3).get("action").is_none(), "the refresh armed a command");
    assert_eq!(result.button_actions_removed.len(), 2, "{:?}", result.button_actions_removed);
    assert!(result.button_actions_removed.iter().any(|n| n.contains("Dashboard!C3")));
}

// ============================================================================
// 3. The push release
// ============================================================================

struct CheckedOut {
    dir: TempDir,
    alice: TempDir,
    stores: Stores,
    app: Workbook,
    sheet: usize,
    response: crate::calp_commands::PullResponse,
}

/// Alice publishes the application as 1.0.0; a developer who owns
/// `macro-report` and `macro-shared` checks it out into their workbook.
fn check_out() -> CheckedOut {
    let dir = TempDir::new().unwrap();
    let alice = TempDir::new().unwrap();
    let reg = LocalWorkspace::open(dir.path()).unwrap();
    let (app, objects) = application(dashboard_cells());
    publish_as(&dir, alice.path(), &app, objects, SemVer::new(1, 0, 0), PushMode::CreateNew);

    let scope = calp::workspace_scope(&location(&dir)).unwrap();
    let checked_out = calp::checkout::checkout(
        &reg,
        PKG,
        Some(SemVer::new(1, 0, 0)),
        "2026-09-30T01:00:00Z",
        &scope,
        alice.path(),
    )
    .expect("checkout");
    let stores = Stores::with_own_macros();
    let base_sheets = checked_out
        .pulled
        .sheets
        .iter()
        .map(|s| calp::WorkingCopySheetRef { sheet_id: s.package_sheet_id, name: s.name.clone() })
        .collect();
    let response = stores.materialize(checked_out.pulled, MaterializeMode::Checkout);
    *stores.state.working_copy_link.write(&test_seed_effect()).unwrap() = Some(calp::WorkingCopyLink::new(
        &location(&dir),
        PKG,
        "report",
        "1.0.0",
        "2026-09-30T01:00:00Z",
        base_sheets,
    ));
    let sheet = stores.index_of("Dashboard");
    CheckedOut { dir, alice, stores, app, sheet, response }
}

impl CheckedOut {
    /// Collect and release the carrier's cell-type objects exactly as
    /// `assemble_publish_workbook` does.
    fn release(&self) -> (Vec<PublishCustomObject>, crate::held_button_code::ButtonCodeRelease) {
        let mut objects =
            crate::calp_commands::collect_cell_type_custom_objects(&self.stores.state, &[self.sheet]).unwrap();
        let names: HashMap<_, _> = [(self.app.sheets[0].id, "Dashboard".to_string())].into();
        let base = crate::held_button_code::SignedBase::new(&location(&self.dir), PKG);
        let release = release_cell_buttons_for_push(&self.stores.state, &mut objects, &names, &location(&self.dir), PKG, &base)
            .expect("release");
        (objects, release)
    }

    fn set_params(&self, row: u32, col: u32, params: Value) {
        let mut store = self.stores.state.cell_types.write(&test_seed_effect()).unwrap();
        store.get_mut(&(self.sheet, row, col)).expect("the cell").params = params;
    }
}

/// THE ROUND TRIP. Check out, push untouched: the published cell-type payload is
/// the base's, byte for byte -- the held actions restored, the kept one kept,
/// and not one stamp shipped.
///
/// SABOTAGE: make the checkout door `Remove` instead of `Hold` (the held
/// actions are then gone and the payload differs), or drop the restore in
/// `release_button_cells_for_publish`.
#[test]
fn an_untouched_push_republishes_the_cell_type_payload_byte_for_byte() {
    let wc = check_out();
    let (objects, release) = wc.release();
    assert!(release.refusal().is_none(), "{:?}", release.refused);
    assert_eq!(release.restored.len(), 3, "{:?}", release.restored);
    assert!(release.restored.iter().all(|i| i.slot == CELL_ACTION_SLOT && i.application == PKG));
    publish_as(
        &wc.dir,
        wc.alice.path(),
        &wc.app,
        objects,
        SemVer::new(1, 0, 1),
        PushMode::Update { expected_base: SemVer::new(1, 0, 0) },
    );
    let before = artifact(&wc.dir, "1.0.0", "custom_objects/0.json").expect("1.0.0 carries cell types");
    let after = artifact(&wc.dir, "1.0.1", "custom_objects/0.json").expect("1.0.1 carries cell types");
    assert_eq!(
        String::from_utf8(after).unwrap(),
        String::from_utf8(before).unwrap(),
        "an untouched push changed the application's button cells"
    );
}

#[test]
fn the_stamp_and_the_held_action_never_ship() {
    let wc = check_out();
    let (objects, _) = wc.release();
    let text = serde_json::to_string(&objects[0].payload).unwrap();
    assert!(!text.contains(FROM_APPLICATION_PARAM), "{text}");
    assert!(!text.contains(HELD_ACTION_PARAM), "{text}");
}

/// A working copy is a `.cala`, and a crafted one can carry any held action with
/// any stamp: an action the signed base does not carry, or one stamped with
/// another application, REFUSES the push and names the cell.
///
/// SABOTAGE: make `judge_held` accept an unknown hash (drop the base check).
#[test]
fn a_held_action_the_signed_base_does_not_carry_refuses_the_push() {
    let wc = check_out();
    let stamp = json!({ "workspace": calp::workspace_scope(&location(&wc.dir)).unwrap().id, "application": PKG, "version": "1.0.0" });
    wc.set_params(2, 2, json!({
        "label": "Button 2",
        "heldAction": { "kind": "script", "scriptId": "macro-steal" },
        "fromApplication": stamp,
    }));
    wc.set_params(3, 3, json!({
        "label": "Button 3",
        "heldAction": { "kind": "command", "commandId": "format.bold" },
        "fromApplication": { "workspace": "elsewhere", "application": "another-app", "version": "1.0.0" },
    }));
    let (objects, release) = wc.release();
    let cells: Vec<&str> = release.refused.iter().map(|i| i.cell.as_str()).collect();
    assert_eq!(cells, vec!["Dashboard!C3", "Dashboard!D4"], "{:?}", release.refused);
    assert!(release.refused[0].reason.contains("does not match"), "{}", release.refused[0].reason);
    assert!(release.refusal().expect("the push refuses").contains("CALP_PUSH_HELD_CODE_UNVERIFIED"));
    // Never restored onto the carrier.
    let text = serde_json::to_string(&objects[0].payload).unwrap();
    assert!(!text.contains("macro-steal"), "{text}");
}

/// A live action the author gave a button replaces the held one: the release
/// leaves it alone and restores nothing over it.
#[test]
fn a_live_action_of_the_authors_own_wins_over_a_held_one() {
    let wc = check_out();
    wc.set_params(2, 2, json!({
        "label": "Mine",
        "action": { "kind": "script", "scriptId": "macro-report" },
        "heldAction": { "kind": "script", "scriptId": "macro-report", "functionName": "Exfiltrate" },
    }));
    let (objects, release) = wc.release();
    assert!(release.refused.is_empty(), "{:?}", release.refused);
    let entry = objects[0].payload.as_array().unwrap().iter().find(|e| e["row"] == 2).unwrap().clone();
    assert_eq!(entry["params"]["action"], script_action("macro-report"));
    assert!(entry["params"].get(HELD_ACTION_PARAM).is_none());
}

// ============================================================================
// 4. The write doors, and where the doors run
// ============================================================================

#[test]
fn the_cell_type_write_doors_refuse_a_held_action_by_name() {
    let err = refuse_held_action_write(Some(&json!({ "heldAction": { "kind": "command" } }))).unwrap_err();
    assert!(err.contains("CELL_TYPE_HELD_ACTION"), "{err}");
    assert!(refuse_held_action_write(Some(&json!({ "action": { "kind": "command" } }))).is_ok());
    // The stamp only narrows what a click runs, so a paste may carry it.
    assert!(refuse_held_action_write(Some(&json!({ "fromApplication": { "application": "x" } }))).is_ok());
    assert!(refuse_held_action_write(None).is_ok());

    // Both Tauri doors call it BEFORE their effect (a refused write leaves a
    // clean document clean).
    let cell_types = source("src/cell_types.rs");
    for door in ["pub fn set_cell_type(", "pub fn set_cell_type_range("] {
        let body = body_of(&cell_types, door);
        let refused = body.find("refuse_held_action_write(").unwrap_or_else(|| panic!("{door} no longer refuses"));
        let effect = body.find("DocumentEffect::mutates(").expect("the effect moved");
        assert!(refused < effect, "{door} refuses after dirtying the document");
    }
}

fn source(rel: &str) -> String {
    std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join(rel))
        .unwrap()
        .lines()
        .map(|l| l.split("//").next().unwrap_or(""))
        .collect::<Vec<_>>()
        .join("\n")
}

fn body_of<'a>(src: &'a str, signature: &str) -> &'a str {
    let start = src.find(signature).unwrap_or_else(|| panic!("`{signature}` moved"));
    let rest = &src[start..];
    &rest[..rest.find("\n}\n").unwrap_or(rest.len())]
}

fn in_order(body: &str, needles: &[&str], door: &str) {
    let mut last = 0usize;
    for needle in needles {
        let at = body[last..]
            .find(needle)
            .map(|i| i + last)
            .unwrap_or_else(|| panic!("{door}: `{needle}` is missing or out of order"));
        last = at + needle.len();
    }
}

/// BOTH DOORS materialize the script maps BEFORE the controls and the cell
/// types: the applied module list exists before any button -- a control's
/// macro link (phase 3 of BUG-0257) or a button cell's action (BUG-0260) -- is
/// admitted. The pull door runs the script maps -> media -> controls -> cell
/// types, the refresh door the script maps -> controls -> cell types, each call
/// ONCE, and every lock is taken and released on its own: the script maps
/// inside `materialize_distributed_scripts`, which is a top-level statement of
/// each body (not inside a block that holds another guard). Every
/// materialization of cell types in the collaboration commands goes through
/// the admission.
///
/// SABOTAGE: move `materialize_distributed_scripts(` back below the controls
/// in `materialize_pull_result` (the positive subscriber test in
/// `held_button_code_tests` then goes red too: the landed set is empty).
#[test]
fn both_doors_materialize_scripts_before_controls_and_cell_types_one_lock_at_a_time() {
    let cmds = source("src/calp_commands.rs");
    let pull = body_of(&cmds, "pub(crate) fn materialize_pull_result(");
    in_order(
        pull,
        &[
            "materialize_distributed_scripts(",
            "merge_pulled_media(",
            "admit_distributed_controls(",
            "state.controls.write(",
            "admit_button_cells(",
            "state.cell_types.write(",
            "materialize_saved_cell_types(",
        ],
        "materialize_pull_result",
    );
    let refresh = body_of(&cmds, "pub(crate) fn apply_refresh_payloads(");
    in_order(
        refresh,
        &[
            "materialize_distributed_scripts(",
            "admit_distributed_controls(",
            "state.controls.write(",
            "admit_button_cells(",
            "materialize_saved_cell_types(",
        ],
        "apply_refresh_payloads",
    );
    // ONE LOCK AT A TIME: the script maps' call site holds no other guard.
    // Every guard these bodies take is bound inside a `{ ... }` block (or a
    // loop), so the call must sit exactly at the body's own top level -- a
    // `let` statement at four spaces on the pull door, and at eight inside the
    // refresh door's per-payload `for` -- never deeper.
    for (door, body, expected) in [("materialize_pull_result", pull, 4usize), ("apply_refresh_payloads", refresh, 8usize)] {
        assert_eq!(body.matches("materialize_distributed_scripts(").count(), 1, "{door}: the script maps land more than once");
        let at = body.find("materialize_distributed_scripts(").unwrap();
        let line_start = body[..at].rfind('\n').map_or(0, |i| i + 1);
        let statement_start = body[..line_start].rfind(";\n").map_or(0, |i| i + 2);
        let statement = &body[statement_start..at];
        let indent = statement.lines().find(|l| !l.trim().is_empty()).map_or(0, |l| l.len() - l.trim_start().len());
        assert_eq!(indent, expected, "{door}: the script maps are materialized inside a nested block:\n{statement}");
    }
    assert_eq!(
        cmds.matches("materialize_saved_cell_types(").count(),
        cmds.matches("admit_button_cells(").count(),
        "a cell-type materialization in the collaboration commands skips the admission"
    );
    // A dev pull carries no cell types; if it ever does, it must be admitted.
    let dev = std::fs::read_to_string(
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../core/calp/src/dev_mode.rs"),
    )
    .unwrap();
    let result = body_of(&dev, "pub struct DevPullResult {");
    assert!(
        !result.contains("custom_objects") && !result.contains("cell_types"),
        "a dev pull now carries cell types: run them through button_cells::admit_button_cells"
    );
}

/// BOTH ADMISSION DOORS PASS THE PRODUCTION LIST, and nothing else: every
/// `ButtonCellDoor {` literal in the collaboration commands -- the pull door
/// (subscribe, checkout) and the refresh door -- carries exactly
/// `allowed_commands: crate::button_cells::DISTRIBUTABLE_BUTTON_COMMANDS`. A
/// literal list there would be a second list the click gate does not read.
///
/// SABOTAGE: one door passes `&[]` (or a literal list) -> red.
#[test]
fn both_doors_pass_the_production_list() {
    let cmds = source("src/calp_commands.rs");
    let doors: Vec<&str> = cmds.match_indices("ButtonCellDoor {").map(|(at, _)| &cmds[at..]).collect();
    assert_eq!(doors.len(), 2, "the admission doors changed: re-decide what each passes");
    for (i, door) in doors.iter().enumerate() {
        let literal = &door[..door.find("\n                },").unwrap_or_else(|| panic!("door {i}: literal end moved"))];
        let lines: Vec<&str> = literal.lines().filter(|l| l.contains("allowed_commands")).collect();
        assert_eq!(
            lines,
            vec!["                    allowed_commands: crate::button_cells::DISTRIBUTABLE_BUTTON_COMMANDS,"],
            "door {i} does not pass the production list:\n{literal}"
        );
    }
    for body in ["pub(crate) fn materialize_pull_result(", "pub(crate) fn apply_refresh_payloads("] {
        assert_eq!(body_of(&cmds, body).matches("ButtonCellDoor {").count(), 1, "{body}: its door moved");
    }
}

/// The frontend reads and refuses the same spellings.
#[test]
fn the_frontend_spells_the_params_as_rust_does() {
    let held = std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("../src/api/heldButtonCode.ts")).unwrap();
    assert!(held.contains(&format!("CELL_BUTTON_HELD_ACTION_PARAM = \"{HELD_ACTION_PARAM}\"")));
    assert!(held.contains(&format!("CELL_BUTTON_FROM_APPLICATION_PARAM = \"{FROM_APPLICATION_PARAM}\"")));
    let validators =
        std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("../src/api/scriptHost/validators.ts")).unwrap();
    let line = validators
        .lines()
        .find(|l| l.contains("export const SCRIPT_REFUSED_CELL_TYPE_PARAMS"))
        .expect("the script door's refused cell-type params moved");
    for key in ADMISSION_OWNED_PARAMS {
        assert!(line.contains(&format!("\"{key}\"")), "scripts may write '{key}': {line}");
    }
}

// ============================================================================
// 5. Review findings (2026-09-30)
// ============================================================================

/// THE SIGNED BASE IS READ THROUGH THE AUTHORISED READER for button cells too:
/// a base a key that is not an authorised publisher re-signed cannot vouch for
/// a held action.
///
/// SABOTAGE: `SignedBase::open` reads through `open_verified_content`.
#[test]
fn a_base_an_unauthorised_key_signed_cannot_vouch_for_a_held_cell_action() {
    let dir = TempDir::new().unwrap();
    let alice = TempDir::new().unwrap();
    let mallory = TempDir::new().unwrap();
    let reg = LocalWorkspace::open(dir.path()).unwrap();
    let (app, objects) = application(dashboard_cells());
    let again: Vec<PublishCustomObject> = objects
        .iter()
        .map(|o| PublishCustomObject { kind: o.kind.clone(), id: o.id.clone(), name: o.name.clone(), sheet_id: o.sheet_id, payload: o.payload.clone() })
        .collect();
    publish_as(&dir, alice.path(), &app, again, SemVer::new(1, 0, 0), PushMode::CreateNew);
    publish_as(&dir, alice.path(), &app, objects, SemVer::new(1, 1, 0), PushMode::Update { expected_base: SemVer::new(1, 0, 0) });
    let scope = calp::workspace_scope(&location(&dir)).unwrap();
    let checked_out = calp::checkout::checkout(&reg, PKG, Some(SemVer::new(1, 1, 0)), "2026-09-30T01:00:00Z", &scope, alice.path())
        .expect("checkout");
    let stores = Stores::with_own_macros();
    let base_sheets = checked_out
        .pulled
        .sheets
        .iter()
        .map(|s| calp::WorkingCopySheetRef { sheet_id: s.package_sheet_id, name: s.name.clone() })
        .collect();
    stores.materialize(checked_out.pulled, MaterializeMode::Checkout);
    *stores.state.working_copy_link.write(&test_seed_effect()).unwrap() = Some(calp::WorkingCopyLink::new(
        &location(&dir), PKG, "report", "1.1.0", "2026-09-30T01:00:00Z", base_sheets));
    let sheet = stores.index_of("Dashboard");
    let names: HashMap<_, _> = [(app.sheets[0].id, "Dashboard".to_string())].into();
    let release = |stores: &Stores| {
        let mut objects = crate::calp_commands::collect_cell_type_custom_objects(&stores.state, &[sheet]).unwrap();
        let base = crate::held_button_code::SignedBase::new(&location(&dir), PKG);
        release_cell_buttons_for_push(&stores.state, &mut objects, &names, &location(&dir), PKG, &base).unwrap()
    };
    let ok = release(&stores);
    assert_eq!(ok.restored.len(), 3, "positive control: {ok:?}");
    // Mallory re-signs the BASE.
    let kp = calp::signing::PublisherKeypair::load_or_create(mallory.path()).unwrap();
    let mut ver = reg.get_version_manifest(PKG, "1.1.0").unwrap();
    ver.publisher_key = kp.public_key_hex();
    ver.publisher_name = "mallory".to_string();
    reg.write_version_manifest(PKG, "1.1.0", &ver).unwrap();
    let vdir = reg.version_dir(PKG, "1.1.0").unwrap();
    let bytes = std::fs::read(vdir.join(calp::integrity::VERSION_MANIFEST_FILE)).unwrap();
    std::fs::write(vdir.join(calp::integrity::VERSION_MANIFEST_SIG_FILE), kp.sign(&bytes)).unwrap();
    let refused = release(&stores);
    assert!(refused.restored.is_empty(), "a base signed by an unauthorised key vouched for a held action: {refused:?}");
    assert_eq!(refused.refused.len(), 3, "{refused:?}");
    assert!(refused.refused[0].reason.contains("not an authorised publisher"), "{}", refused.refused[0].reason);
}

/// A NEW OR RE-POINTED LIVE ACTION needs an acknowledgement, with the action on
/// screen, like a button control's new code ("any other new button code needs
/// an explicit acknowledgement"). A working copy could otherwise re-point an
/// application button at a different application macro and push it under the
/// developer's key without anybody reading it. An action the signed base
/// carries needs none.
///
/// SABOTAGE: `continue` instead of pushing to `release.unreviewed` in
/// `release_button_cells_for_publish`.
#[test]
fn a_new_live_button_cell_action_needs_an_acknowledgement() {
    let wc = check_out();
    // Untouched: the kept action (macro-app) is in the signed base.
    let (_, untouched) = wc.release();
    assert!(untouched.unreviewed.is_empty(), "{:?}", untouched.unreviewed);

    // F6 had no action; the developer gives it one that calls another function.
    wc.set_params(5, 5, json!({
        "label": "Mine",
        "action": { "kind": "script", "scriptId": "macro-app", "functionName": "Other" },
        "fromApplication": { "workspace": "ws", "application": PKG, "version": "1.0.0" },
    }));
    let (objects, release) = wc.release();
    assert_eq!(release.unreviewed.len(), 1, "{:?}", release.unreviewed);
    let item = &release.unreviewed[0];
    assert_eq!(item.cell, "Dashboard!F6");
    assert_eq!(item.slot, CELL_ACTION_SLOT);
    assert!(item.code.contains("\"functionName\":\"Other\""), "the action is shown exactly: {}", item.code);
    assert_eq!(item.hash, cell_action_hash(&json!({ "kind": "script", "scriptId": "macro-app", "functionName": "Other" })));
    let refusal = release.acknowledgement_refusal(&[]).expect("unacknowledged");
    assert!(refusal.contains("CALP_PUSH_BUTTON_CODE_UNREVIEWED") && refusal.contains("Dashboard!F6"), "{refusal}");
    assert!(release.acknowledgement_refusal(&[item.hash.clone()]).is_none());
    // The live action itself still ships (it is the author's, once acknowledged).
    let entry = objects[0].payload.as_array().unwrap().iter().find(|e| e["row"] == 5).unwrap().clone();
    assert_eq!(entry["params"]["action"]["functionName"], "Other");
    assert!(entry["params"].get(FROM_APPLICATION_PARAM).is_none(), "the stamp never ships");
}

/// A PUSH THAT IS NOT OF THE WORKING COPY'S APPLICATION withholds held actions
/// by name instead of refusing (it restores nothing, so there is nothing to
/// prove).
///
/// SABOTAGE: drop the `target.is_none()` withhold branch in
/// `release_button_cells_for_publish`.
#[test]
fn a_push_that_is_not_its_working_copys_withholds_held_actions_by_name() {
    let wc = check_out();
    let mut objects =
        crate::calp_commands::collect_cell_type_custom_objects(&wc.stores.state, &[wc.sheet]).unwrap();
    let names: HashMap<_, _> = [(wc.app.sheets[0].id, "Dashboard".to_string())].into();
    let release = release_button_cells_for_publish(&mut objects, &names, None);
    assert!(release.refused.is_empty(), "{:?}", release.refused);
    assert!(release.restored.is_empty());
    let cells: Vec<&str> = release.withheld.iter().map(|i| i.cell.as_str()).collect();
    assert_eq!(cells, vec!["Dashboard!C3", "Dashboard!D4", "Dashboard!E5"], "{:?}", release.withheld);
    assert!(release.withheld.iter().all(|i| i.reason.contains("not a push of")));
    let text = serde_json::to_string(&objects[0].payload).unwrap();
    assert!(!text.contains(HELD_ACTION_PARAM) && !text.contains("Exfiltrate"), "{text}");
}

/// A CLICK'S REFUSAL IS AUDITED. The click side refuses in the page; this is its
/// always-on trail, and the application it names is read from the cell's own
/// stamp in the backend store -- never taken from the page. A cell that is not
/// a stamped button cell records nothing.
///
/// SABOTAGE: return `Ok(())` before `record_audit_event_with_extra` in
/// `audit_button_refusal_core`.
#[test]
fn a_clicks_refusal_of_an_application_button_cell_is_audited() {
    use crate::held_button_code::MacroLinkKind;
    let wc = check_out();
    assert!(!wc.stores.state.audit_log.read().unwrap().enabled, "precondition: auditing is off");
    audit_button_refusal_core(&wc.stores.state, MacroLinkKind::Cell, wc.sheet, 1, 1, "the command format.bold", "command")
        .expect("a stamped button cell");
    let log = wc.stores.state.audit_log.read().unwrap();
    let rows: Vec<&calp::audit::AuditEntry> = log
        .entries
        .iter()
        .filter(|e| matches!(e.event, calp::audit::AuditEvent::ButtonCodeRefused))
        .collect();
    assert_eq!(rows.len(), 1, "{:?}", log.entries);
    assert_eq!(rows[0].extra["door"], "click");
    assert_eq!(rows[0].extra["kind"], "cell");
    assert_eq!(rows[0].extra["application"], PKG, "the application comes from the cell's stamp");
    assert_eq!(rows[0].extra["cells"][0], "Dashboard!B2");
    assert_eq!(rows[0].extra["refused"], "the command format.bold");
    drop(log);
    // Not a button cell / not stamped: refused, nothing recorded.
    assert!(audit_button_refusal_core(&wc.stores.state, MacroLinkKind::Cell, wc.sheet, 6, 6, "x", "command").is_err());
    assert!(audit_button_refusal_core(&wc.stores.state, MacroLinkKind::Cell, wc.sheet, 40, 40, "x", "command").is_err());
    assert_eq!(wc.stores.state.audit_log.read().unwrap().entries.len(), 1);
}

/// A BUTTON CONTROL'S refusal (phase 3): the application is read from the
/// control's own `heldFrom` in the backend store -- never from the page -- and
/// a control whose stamp cannot be read (exactly what a click refuses it for)
/// is still recorded, saying so. A control of the author's own, with nothing
/// held, records nothing.
///
/// SABOTAGE: have `clicked_button_origin` read the application from anywhere
/// but the store (e.g. return `Ok(Some((String::new(), String::new())))` for
/// every control).
#[test]
fn audit_button_refusal_reads_a_controls_application_from_storage() {
    use crate::controls::{ControlMetadata, ControlPropertyValue, HELD_FROM_PROPERTY, HELD_MACRO_REF_PROPERTY};
    use crate::held_button_code::MacroLinkKind;
    let state = crate::create_app_state();
    let prop = |v: &str| ControlPropertyValue { value_type: "static".into(), value: v.into() };
    let stamp = HeldFrom { workspace: "ws".into(), application: "sales".into(), version: "1.2.0".into(), value_types: Default::default() };
    {
        let mut controls = state.controls.write(&test_seed_effect()).unwrap();
        let mut held = HashMap::new();
        held.insert(HELD_MACRO_REF_PROPERTY.to_string(), prop("macro-report"));
        held.insert(HELD_FROM_PROPERTY.to_string(), prop(&stamp.encode()));
        controls.insert((0, 1, 1), ControlMetadata { control_type: "button".into(), properties: held });
        let mut unreadable = HashMap::new();
        unreadable.insert(HELD_MACRO_REF_PROPERTY.to_string(), prop("macro-report"));
        unreadable.insert(HELD_FROM_PROPERTY.to_string(), prop("{not json"));
        controls.insert((0, 2, 2), ControlMetadata { control_type: "button".into(), properties: unreadable });
        let mut own = HashMap::new();
        own.insert("macroRef".to_string(), prop("macro-mine"));
        controls.insert((0, 3, 3), ControlMetadata { control_type: "button".into(), properties: own });
    }
    audit_button_refusal_core(&state, MacroLinkKind::Control, 0, 1, 1, "the macro \"Report\"", "refused").expect("a stamped control");
    audit_button_refusal_core(&state, MacroLinkKind::Control, 0, 2, 2, "the macro \"Report\"", "stampUnreadable")
        .expect("an application's control whose stamp is unreadable is still recorded");
    assert!(audit_button_refusal_core(&state, MacroLinkKind::Control, 0, 3, 3, "x", "refused").is_err(), "the author's own button");
    assert!(audit_button_refusal_core(&state, MacroLinkKind::Control, 0, 9, 9, "x", "refused").is_err(), "no control");
    let log = state.audit_log.read().unwrap();
    assert_eq!(log.entries.len(), 2, "{:?}", log.entries);
    assert_eq!(log.entries[0].extra["kind"], "control");
    assert_eq!(log.entries[0].extra["application"], "sales", "the application comes from the control's stamp");
    assert_eq!(log.entries[0].extra["version"], "1.2.0");
    assert_eq!(log.entries[0].extra["cells"][0], "Sheet1!B2");
    assert_eq!(log.entries[1].extra["application"], "");
    assert_eq!(log.entries[1].extra["stampUnreadable"], true);
    assert!(log.entries[1].description.contains("unreadable"), "{}", log.entries[1].description);
}

/// THE REFUSAL NAMES THE BUTTON'S OWN SHEET. The click records its refusal
/// after several awaits; reading the ACTIVE sheet in the command then looked the
/// button up wherever the user had switched to (or at an index that is not the
/// button's), found nothing, and the refusal of an application's code went
/// unrecorded -- with the page only logging the error. The command takes the
/// sheet the click happened on, as the run's trigger does, and a button on a
/// sheet that is NOT the active one is still found and recorded.
///
/// SABOTAGE: read `state.active_sheet` in `audit_button_refusal` again instead
/// of the `sheet_index` argument.
#[test]
fn a_click_refusal_is_recorded_on_the_buttons_own_sheet_not_the_active_one() {
    use crate::controls::{ControlMetadata, ControlPropertyValue, HELD_FROM_PROPERTY, HELD_MACRO_REF_PROPERTY};
    use crate::held_button_code::MacroLinkKind;

    let production = include_str!("button_cells.rs").split("#[cfg(test)]").next().unwrap().to_string();
    let start = production.find("pub fn audit_button_refusal(").expect("the command moved");
    let command = &production[start..];
    let command = &command[..command.find("\n}\n").unwrap()];
    assert!(command.contains("    sheet_index: usize,"), "the command does not take the button's sheet");
    assert!(!command.contains("active_sheet"), "the command reads the ACTIVE sheet again: {command}");
    assert!(
        command.contains("audit_button_refusal_core(&state, kind, sheet_index, row, col,"),
        "the command does not look the button up on the sheet it was told"
    );

    // Behaviourally, on the unit tier: a stamped control on sheet 1 while the
    // active sheet is 0.
    let state = crate::create_app_state();
    assert_eq!(*state.active_sheet.read().unwrap(), 0, "precondition: sheet 0 is active");
    let prop = |v: &str| ControlPropertyValue { value_type: "static".into(), value: v.into() };
    let stamp = HeldFrom { workspace: "ws".into(), application: "sales".into(), version: "1.2.0".into(), value_types: Default::default() };
    {
        let mut held = HashMap::new();
        held.insert(HELD_MACRO_REF_PROPERTY.to_string(), prop("macro-report"));
        held.insert(HELD_FROM_PROPERTY.to_string(), prop(&stamp.encode()));
        state
            .controls
            .write(&test_seed_effect())
            .unwrap()
            .insert((1, 4, 2), ControlMetadata { control_type: "button".into(), properties: held });
    }
    assert!(
        audit_button_refusal_core(&state, MacroLinkKind::Control, 0, 4, 2, "x", "refused").is_err(),
        "the active sheet holds no such button"
    );
    audit_button_refusal_core(&state, MacroLinkKind::Control, 1, 4, 2, "the macro \"Report\"", "refused")
        .expect("the button's own sheet");
    let log = state.audit_log.read().unwrap();
    assert_eq!(log.entries.len(), 1, "{:?}", log.entries);
    assert_eq!(log.entries[0].extra["application"], "sales");
}
