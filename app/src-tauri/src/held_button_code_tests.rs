//! FILENAME: app/src-tauri/src/held_button_code_tests.rs
//! PURPOSE: BUG-0257 -- a working copy keeps its application's button code in
//! the HELD compartment, and a push republishes it only when the signed base
//! carries those exact bytes.
//! CONTEXT: Three tiers. The pure admission and release; the write doors that
//! must never write (or lose) held code; and the round trip through a real
//! signed workspace -- publish, check out, push untouched -- whose
//! `controls.json` must come back byte for byte.

use std::collections::{HashMap, HashSet};
use std::path::Path;

use tempfile::TempDir;

use calp::publish::{self, PublishRequest, PushMode};
use calp::version::SemVer;
use calp::workspace::LocalWorkspace;
use engine::cell::Cell;
use persistence::{SavedCell, SavedSheetControls, Sheet, Workbook};

use super::*;
use crate::calp_commands::{materialize_pull_result, MaterializeMode};
use crate::controls::{
    ControlMetadata, ControlPropertyValue, HELD_MACRO_REF_PROPERTY, HELD_ON_SELECT_PROPERTY,
    MACRO_REF_PROPERTY, ON_SELECT_PROPERTY,
};
use crate::document_effect::test_seed_effect;
use crate::persistence::FileState;

/// A name no real application uses: the authorised reader consults this
/// machine's pin store (read-only), and a unique name keeps that out of play.
const PKG: &str = "bug0257-held-button-code";

// ============================================================================
// Fixtures
// ============================================================================

/// "Dashboard" with three buttons: B2 runs inline code, C3 links a macro, D4 is
/// the recipe button with an EMPTY onSelect (not code).
fn dashboard() -> Workbook {
    let mut sheet = Sheet::new("Dashboard".to_string());
    sheet
        .cells
        .insert((0, 0), SavedCell::from_cell(&Cell::new_text("Sales".to_string())));
    let controls = serde_json::json!([
        { "row": 1, "col": 1, "controlType": "button", "properties": {
            "onSelect": { "valueType": "static", "value": "Report();" },
            "text": { "valueType": "static", "value": "Run report" },
            "pinToGrid": { "valueType": "static", "value": "false" }
        } },
        { "row": 2, "col": 2, "controlType": "button", "properties": {
            "macroRef": { "valueType": "static", "value": "macro-report" },
            "text": { "valueType": "static", "value": "Macro" }
        } },
        { "row": 3, "col": 3, "controlType": "button", "properties": {
            "onSelect": { "valueType": "static", "value": "" },
            "text": { "valueType": "static", "value": "Empty" }
        } }
    ]);
    let mut wb = Workbook::default();
    wb.controls = vec![SavedSheetControls { sheet_id: sheet.id, controls }];
    wb.sheets = vec![sheet];
    wb
}

/// A module-script record: the application's when published, the user's own
/// when seeded into a workbook.
fn macro_module(id: &str, source: &str) -> persistence::SavedScript {
    persistence::SavedScript {
        id: id.to_string(),
        name: id.to_string(),
        description: None,
        source: source.to_string(),
        scope: persistence::SavedScriptScope::Workbook,
        source_package: None,
    }
}

/// `dashboard()` whose application SHIPS the macro C3 links (phase 3: the
/// Macro Recorder writes `macroRef`, and the macro travels as a module).
fn dashboard_shipping_its_macro() -> Workbook {
    let mut wb = dashboard();
    wb.scripts = vec![macro_module("macro-report", "Calcula.log('the application report');")];
    wb
}

fn subscribe_pull(dir: &TempDir, version: &str) -> calp::pull::PullResult {
    let reg = LocalWorkspace::open(dir.path()).unwrap();
    let bob = TempDir::new().unwrap();
    let scope = calp::workspace_scope(&location(dir)).unwrap();
    calp::pull::pull(
        &reg,
        &calp::pull::PullRequest {
            package_name: PKG.to_string(),
            target: calp::manifest::SubscriptionTarget::Line(calp::version::VersionPin::Exact(
                SemVer::parse(version).unwrap(),
            )),
            now: "2026-09-30T02:00:00Z".to_string(),
        },
        &scope,
        bob.path(),
        calp::integrity::PinPolicy::PinOnFirstUse,
    )
    .expect("subscribe")
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
        now: "2026-09-30T00:00:00Z".to_string(),
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

fn artifact(dir: &TempDir, version: &str, rel: &str) -> Option<Vec<u8>> {
    let reg = LocalWorkspace::open(dir.path()).unwrap();
    reg.read_artifact(PKG, version, rel).unwrap()
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

    /// Where the application's Dashboard landed.
    fn sheet_index_of(&self, id: identity::SheetId) -> usize {
        self.state
            .sheet_ids
            .read()
            .unwrap()
            .iter()
            .position(|s| *s == id)
            .expect("the application's sheet is in the workbook")
    }

    fn control(&self, sheet: usize, row: u32, col: u32) -> ControlMetadata {
        self.state.controls.read().unwrap()[&(sheet, row, col)].clone()
    }

    /// A refresh of subscription 0 to `result`, through the real apply.
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
            "2026-09-30T03:00:00Z",
            None,
        )
        .expect("refresh failed")
    }

    /// Where the subscriber's "Dashboard" landed (a subscriber's sheets carry
    /// fresh local ids, so it is found by name).
    fn dashboard_index(&self) -> usize {
        self.state.sheet_names.read().unwrap().iter().position(|n| n == "Dashboard").expect("the sheet")
    }

    /// Give this workbook a macro of the user's OWN.
    fn with_own_macro(self, id: &str, source: &str) -> Self {
        self.scripts.workbook_scripts.write(&test_seed_effect()).unwrap().insert(
            id.to_string(),
            crate::scripting::types::WorkbookScript {
                id: id.to_string(),
                name: id.to_string(),
                description: None,
                source: source.to_string(),
                scope: crate::scripting::types::ScriptScope::Workbook,
                source_package: None,
            },
        );
        self
    }

    /// The live store as a publish carrier: the application's sheets, this
    /// workbook's controls -- exactly what `build_workbook_for_save` collects.
    fn carrier(&self, application: &Workbook) -> Workbook {
        let mut carrier = application.clone();
        carrier.controls = crate::controls::collect_controls_for_save(
            &self.state.controls.read().unwrap(),
            &self.state.sheet_ids.read().unwrap(),
        );
        carrier
    }
}

/// A workspace where alice published `dashboard()` as 1.0.0, checked out into
/// a fresh workbook (checkout is ADDITIVE: the app lands beside Sheet1), with
/// the working-copy link `calp_checkout` records.
struct CheckedOut {
    dir: TempDir,
    alice: TempDir,
    stores: Stores,
    app: Workbook,
    sheet: usize,
    response: crate::calp_commands::PullResponse,
}

fn check_out() -> CheckedOut {
    let dir = TempDir::new().unwrap();
    let alice = TempDir::new().unwrap();
    let reg = LocalWorkspace::open(dir.path()).unwrap();
    let app = dashboard();
    publish_version(&reg, alice.path(), &app, SemVer::new(1, 0, 0), PushMode::CreateNew);

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
    let stores = Stores::new();
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
    let sheet = stores.sheet_index_of(app.sheets[0].id);
    CheckedOut { dir, alice, stores, app, sheet, response }
}

impl CheckedOut {
    /// Release the held compartment on a carrier of the live store, exactly as
    /// `assemble_publish_workbook` does.
    fn release(&self) -> (Workbook, ButtonCodeRelease) {
        let mut carrier = self.stores.carrier(&self.app);
        let base = SignedBase::new(&location(&self.dir), PKG);
        let release = release_for_push(&self.stores.state, &mut carrier, &[0], &location(&self.dir), PKG, &base)
            .expect("release");
        (carrier, release)
    }

    /// Push the released carrier as 1.0.1 and return its `controls.json`.
    fn push_untouched(&self) -> Vec<u8> {
        let (carrier, release) = self.release();
        assert!(release.refusal().is_none(), "{:?}", release.refused);
        assert!(release.acknowledgement_refusal(&[]).is_none(), "{:?}", release.unreviewed);
        let reg = LocalWorkspace::open(self.dir.path()).unwrap();
        publish_version(
            &reg,
            self.alice.path(),
            &carrier,
            SemVer::new(1, 0, 1),
            PushMode::Update { expected_base: SemVer::new(1, 0, 0) },
        );
        artifact(&self.dir, "1.0.1", "controls.json").expect("the push carries controls")
    }
}

fn prop(value: &str) -> ControlPropertyValue {
    ControlPropertyValue { value_type: "static".into(), value: value.into() }
}

/// A control slot as (valueType, value); ("", "") when absent.
fn slot<'a>(meta: &'a ControlMetadata, key: &str) -> (&'a str, &'a str) {
    meta.properties.get(key).map_or(("", ""), |p| (p.value_type.as_str(), p.value.as_str()))
}

fn stamp() -> HeldFrom {
    HeldFrom {
        workspace: "ws".into(),
        application: "sales".into(),
        version: "1.2.0".into(),
        value_types: Default::default(),
    }
}

// ============================================================================
// 1. Admission
// ============================================================================

/// SABOTAGE: make the `Hold` arm of `admit_wiring` take the strip branch.
#[test]
fn a_checkout_moves_button_code_into_the_held_slots_and_stamps_it() {
    let saved = vec![SavedSheetControls {
        sheet_id: identity::SheetId::from_bytes(identity::generate_uuid_v7()),
        controls: serde_json::json!([
            { "row": 0, "col": 0, "controlType": "button", "properties": {
                "onSelect": { "valueType": "static", "value": "Report();" },
                "macroRef": { "valueType": "formula", "value": "=A1" },
                "text": { "valueType": "static", "value": "Go" }
            } },
            { "row": 1, "col": 0, "controlType": "button", "properties": {
                "onSelect": { "valueType": "static", "value": "" }
            } }
        ]),
    }];
    let (out, report) = admit_wiring(&saved, &DistributedWiring::Hold(stamp()));
    assert_eq!(report.held, 2);
    let props = out[0].controls[0]["properties"].as_object().unwrap();
    assert!(!props.contains_key(ON_SELECT_PROPERTY), "no click may read held code: {props:?}");
    assert!(!props.contains_key(MACRO_REF_PROPERTY));
    assert_eq!(props[HELD_ON_SELECT_PROPERTY]["value"], "Report();");
    // A held slot is ALWAYS static: nothing evaluates it for display, and the
    // type the package gave it is kept in the stamp.
    assert_eq!(props[HELD_MACRO_REF_PROPERTY]["valueType"], "static");
    assert_eq!(props[HELD_MACRO_REF_PROPERTY]["value"], "=A1");
    let from = HeldFrom::decode(props[HELD_FROM_PROPERTY]["value"].as_str().unwrap()).expect("stamp");
    assert_eq!(from.application, "sales");
    assert_eq!(from.value_type_of(MACRO_REF_PROPERTY), "formula");
    assert_eq!(from.value_type_of(ON_SELECT_PROPERTY), "static");
    assert_eq!(props["text"]["value"], "Go");
    // The recipe button's empty slot is not code: it stays live, unstamped.
    let empty = out[0].controls[1]["properties"].as_object().unwrap();
    assert_eq!(empty[ON_SELECT_PROPERTY]["value"], "");
    assert!(!empty.contains_key(HELD_FROM_PROPERTY));
}

/// A package never carries a held key -- on EITHER door. One that arrived
/// would be restored at the developer's next push, under their key.
#[test]
fn a_packages_own_held_keys_are_discarded_on_every_door() {
    let forged = HeldFrom { application: "sales".into(), ..stamp() };
    let saved = vec![SavedSheetControls {
        sheet_id: identity::SheetId::from_bytes(identity::generate_uuid_v7()),
        controls: serde_json::json!([
            { "row": 0, "col": 0, "controlType": "button", "properties": {
                "heldOnSelect": { "valueType": "static", "value": "Evil();" },
                "heldMacroRef": { "valueType": "static", "value": "macro-evil" },
                "heldFrom": { "valueType": "static", "value": forged.encode() },
                "text": { "valueType": "static", "value": "Go" }
            } }
        ]),
    }];
    for wiring in [DistributedWiring::Strip, DistributedWiring::Hold(stamp())] {
        let (out, report) = admit_wiring(&saved, &wiring);
        let props = out[0].controls[0]["properties"].as_object().unwrap();
        for key in HELD_CONTROL_PROPERTIES {
            assert!(!props.contains_key(*key), "{wiring:?} admitted a package's '{key}'");
        }
        assert_eq!(report.discarded_held_keys, 3);
        assert_eq!(report.held, 0);
    }
    // The subscriber's strip is the same function (`sanitize_distributed_controls`).
    let stripped = crate::controls::sanitize_distributed_controls(&saved);
    assert!(stripped[0].controls[0]["properties"].get(HELD_ON_SELECT_PROPERTY).is_none());
}

// ============================================================================
// 2. Release
// ============================================================================

fn held_payload(sheet: identity::SheetId, code: &str, from: &HeldFrom) -> Vec<SavedSheetControls> {
    vec![SavedSheetControls {
        sheet_id: sheet,
        controls: serde_json::json!([
            { "row": 1, "col": 1, "controlType": "button", "properties": {
                "heldOnSelect": { "valueType": "static", "value": code },
                "heldFrom": { "valueType": "static", "value": from.encode() },
                "text": { "valueType": "static", "value": "Go" }
            } }
        ]),
    }]
}

fn target(sheet: identity::SheetId, known: &[(&str, &str)]) -> HeldTarget {
    HeldTarget {
        workspace: "ws".into(),
        application: "sales".into(),
        base_version: "1.2.0".into(),
        base_sheets: [sheet].into_iter().collect(),
        base_code: Ok(known.iter().map(|(t, v)| executable_value_hash(t, v)).collect()),
    }
}

fn names(sheet: identity::SheetId) -> HashMap<identity::SheetId, String> {
    [(sheet, "Dashboard".to_string())].into_iter().collect()
}

#[test]
fn held_code_the_signed_base_carries_goes_back_live_on_the_carrier_only() {
    let sheet = identity::SheetId::from_bytes(identity::generate_uuid_v7());
    let mut carrier = held_payload(sheet, "Report();", &stamp());
    let published: HashSet<_> = [sheet].into_iter().collect();
    let release = release_held_code_for_publish(
        &mut carrier,
        &published,
        &names(sheet),
        Some(&target(sheet, &[("static", "Report();")])),
    );
    assert_eq!(release.restored.len(), 1, "{release:?}");
    assert!(release.refused.is_empty() && release.unreviewed.is_empty(), "{release:?}");
    let props = carrier[0].controls[0]["properties"].as_object().unwrap();
    assert_eq!(props[ON_SELECT_PROPERTY], serde_json::json!({ "valueType": "static", "value": "Report();" }));
    for key in HELD_CONTROL_PROPERTIES {
        assert!(!props.contains_key(*key), "a held key reached the carrier: {key}");
    }
}

/// THE CRAFTED WORKING COPY. A `.cala` can carry any held bytes with any stamp;
/// only the signed base decides whether they are the application's.
///
/// SABOTAGE: have `judge_held` return `Ok(())` when the hash is unknown.
#[test]
fn held_code_the_signed_base_does_not_carry_refuses_the_push_and_names_the_button() {
    let sheet = identity::SheetId::from_bytes(identity::generate_uuid_v7());
    let mut carrier = held_payload(sheet, "Evil();", &stamp());
    let published: HashSet<_> = [sheet].into_iter().collect();
    let release = release_held_code_for_publish(
        &mut carrier,
        &published,
        &names(sheet),
        Some(&target(sheet, &[("static", "Report();")])),
    );
    assert!(release.restored.is_empty());
    let refusal = release.refusal().expect("the push is refused");
    assert!(refusal.contains("CALP_PUSH_HELD_CODE_UNVERIFIED"), "{refusal}");
    assert!(refusal.contains("Dashboard!B2"), "the refusal names the button: {refusal}");
    assert!(refusal.contains("does not match any button code in the signed v1.2.0"), "{refusal}");
    // Not restored, and no held key left behind either.
    let props = carrier[0].controls[0]["properties"].as_object().unwrap();
    assert!(!props.contains_key(ON_SELECT_PROPERTY) && !props.contains_key(HELD_ON_SELECT_PROPERTY));
}

/// Every other condition refuses too: a stamp for another application or
/// workspace, a later version, a sheet the base never had, no stamp, and an
/// unreadable base. (A push that is not a working-copy push at all WITHHOLDS
/// instead -- see the next test.)
#[test]
fn every_unproven_held_slot_refuses() {
    let sheet = identity::SheetId::from_bytes(identity::generate_uuid_v7());
    let published: HashSet<_> = [sheet].into_iter().collect();
    let known = [("static", "Report();")];
    let refused = |from: &HeldFrom, t: Option<&HeldTarget>| {
        let mut carrier = held_payload(sheet, "Report();", from);
        release_held_code_for_publish(&mut carrier, &published, &names(sheet), t)
    };
    let cases: Vec<(&str, HeldFrom, Option<HeldTarget>)> = vec![
        ("other application", HeldFrom { application: "hr".into(), ..stamp() }, Some(target(sheet, &known))),
        ("other workspace", HeldFrom { workspace: "elsewhere".into(), ..stamp() }, Some(target(sheet, &known))),
        ("later version", HeldFrom { version: "9.0.0".into(), ..stamp() }, Some(target(sheet, &known))),
        (
            "sheet not in the base",
            stamp(),
            Some(HeldTarget { base_sheets: HashSet::new(), ..target(sheet, &known) }),
        ),
        (
            "unreadable base",
            stamp(),
            Some(HeldTarget { base_code: Err("offline".into()), ..target(sheet, &known) }),
        ),
    ];
    for (why, from, t) in cases {
        let release = refused(&from, t.as_ref());
        assert_eq!(release.refused.len(), 1, "{why}: {release:?}");
        assert!(release.restored.is_empty(), "{why} restored held code");
    }
    // No stamp at all.
    let mut carrier = held_payload(sheet, "Report();", &stamp());
    carrier[0].controls[0]["properties"].as_object_mut().unwrap().remove(HELD_FROM_PROPERTY);
    let release =
        release_held_code_for_publish(&mut carrier, &published, &names(sheet), Some(&target(sheet, &known)));
    assert_eq!(release.refused.len(), 1, "a held slot without its stamp: {release:?}");
}

/// A PUSH THAT IS NOT OF THE WORKING COPY'S APPLICATION -- a publish as a new
/// application, which `CALP_PUSH_WRONG_TARGET` itself recommends, or a scripted
/// publish -- restores nothing, and REFUSES nothing: the held code is listed as
/// withheld, by name, and the button goes out without it. It used to refuse
/// every held slot on a published sheet with a remedy (re-open, or replace the
/// code) that does not apply to such a push.
///
/// SABOTAGE: drop the `target.is_none()` withhold branch in
/// `release_held_code_for_publish` (the slot then reaches `judge_held`, which
/// refuses it).
#[test]
fn a_push_that_is_not_its_working_copys_withholds_held_code_by_name() {
    let sheet = identity::SheetId::from_bytes(identity::generate_uuid_v7());
    let published: HashSet<_> = [sheet].into_iter().collect();
    let mut carrier = held_payload(sheet, "Report();", &stamp());
    let release = release_held_code_for_publish(&mut carrier, &published, &names(sheet), None);
    assert!(release.refused.is_empty(), "a push that restores nothing refused: {release:?}");
    assert!(release.refusal().is_none());
    assert!(release.restored.is_empty());
    assert_eq!(release.withheld.len(), 1, "{release:?}");
    let item = &release.withheld[0];
    assert_eq!((item.cell.as_str(), item.code.as_str(), item.application.as_str()), ("Dashboard!B2", "Report();", "sales"));
    assert!(item.reason.contains("not a push of 'sales' from its working copy"), "{}", item.reason);
    let props = carrier[0].controls[0]["properties"].as_object().unwrap();
    assert!(!props.contains_key(ON_SELECT_PROPERTY), "withheld code went out live");
    for key in HELD_CONTROL_PROPERTIES {
        assert!(!props.contains_key(*key), "a held key reached the carrier: {key}");
    }
    // The wire carries it.
    let json = serde_json::to_value(&release).unwrap();
    assert_eq!(json["withheld"][0]["cell"], "Dashboard!B2");
}

/// Held keys never leave, even on a sheet the push does not publish.
#[test]
fn held_keys_are_removed_from_unpublished_sheets_too() {
    let sheet = identity::SheetId::from_bytes(identity::generate_uuid_v7());
    let mut carrier = held_payload(sheet, "Report();", &stamp());
    let release =
        release_held_code_for_publish(&mut carrier, &HashSet::new(), &names(sheet), Some(&target(sheet, &[])));
    assert_eq!(release, ButtonCodeRelease::default(), "an unpublished sheet is not judged");
    let props = carrier[0].controls[0]["properties"].as_object().unwrap();
    for key in HELD_CONTROL_PROPERTIES {
        assert!(!props.contains_key(*key));
    }
}

/// Live code the signed base does not carry needs an acknowledgement BY HASH.
#[test]
fn live_code_the_base_does_not_carry_is_unreviewed_until_acknowledged() {
    let sheet = identity::SheetId::from_bytes(identity::generate_uuid_v7());
    let mut carrier = vec![SavedSheetControls {
        sheet_id: sheet,
        controls: serde_json::json!([
            { "row": 0, "col": 0, "controlType": "button", "properties": {
                "onSelect": { "valueType": "static", "value": "Report();" } } },
            { "row": 4, "col": 1, "controlType": "button", "properties": {
                "onSelect": { "valueType": "static", "value": "Mine();" } } }
        ]),
    }];
    let published: HashSet<_> = [sheet].into_iter().collect();
    let release = release_held_code_for_publish(
        &mut carrier,
        &published,
        &names(sheet),
        Some(&target(sheet, &[("static", "Report();")])),
    );
    assert_eq!(release.unreviewed.len(), 1, "code the base has needs no review: {release:?}");
    let item = &release.unreviewed[0];
    assert_eq!((item.cell.as_str(), item.code.as_str()), ("Dashboard!B5", "Mine();"));
    let refusal = release.acknowledgement_refusal(&[]).expect("unacknowledged");
    assert!(refusal.contains("CALP_PUSH_BUTTON_CODE_UNREVIEWED") && refusal.contains("Dashboard!B5"), "{refusal}");
    assert!(release.acknowledgement_refusal(&["not-the-hash".into()]).is_some());
    assert!(release.acknowledgement_refusal(&[item.hash.clone()]).is_none());
    // Without a target (a first publish), live code is the author's workbook
    // and is not gated here.
    let mut carrier2 = carrier.clone();
    let none = release_held_code_for_publish(&mut carrier2, &published, &names(sheet), None);
    assert!(none.unreviewed.is_empty());
}

/// The type is part of the code's identity: the same text as a formula is not
/// the same code.
#[test]
fn the_code_hash_covers_the_value_type() {
    assert_ne!(executable_value_hash("static", "=A1"), executable_value_hash("formula", "=A1"));
    assert_eq!(executable_value_hash("static", "x"), executable_value_hash("static", "x"));
}

// ============================================================================
// 3. The write doors
// ============================================================================

fn held_button() -> ControlMetadata {
    let mut properties = HashMap::new();
    properties.insert("text".to_string(), prop("Go"));
    properties.insert(HELD_ON_SELECT_PROPERTY.to_string(), prop("Report();"));
    properties.insert(HELD_MACRO_REF_PROPERTY.to_string(), prop("macro-report"));
    properties.insert(HELD_FROM_PROPERTY.to_string(), prop(&stamp().encode()));
    ControlMetadata { control_type: "button".into(), properties }
}

fn seeded(meta: ControlMetadata) -> crate::AppState {
    let state = crate::create_app_state();
    state.controls.write(&test_seed_effect()).unwrap().insert((0, 2, 1), meta);
    state
}

fn undo_depth(state: &crate::AppState) -> usize {
    state.undo_stack.lock().unwrap().undo_depth()
}

/// Ctrl+Z, through the real restore (`apply_changes`), with no Tauri runtime.
fn undo_once(state: &crate::AppState) {
    let transaction = state.undo_stack.lock().unwrap().pop_undo().expect("nothing to undo");
    crate::undo_commands::apply_changes(
        state,
        &FileState::default(),
        &crate::persistence::UserFilesState::default(),
        &crate::pivot::types::PivotState::new(),
        &crate::slicer::SlicerState::new(),
        &crate::ribbon_filter::RibbonFilterState::new(),
        &crate::pane_control::PaneControlState::new(),
        &crate::timeline_slicer::TimelineSlicerState::new(),
        transaction,
        true,
    );
}

/// A SCRIPT (or anything else) writing a held key would stage code the next
/// push publishes under the pusher's key. The validator refuses it in the
/// sandbox (`SCRIPT_REFUSED_SHAPE_PROPERTY_KEYS`); the Rust door refuses it too.
///
/// SABOTAGE: drop the `is_held_property` refusal in `set_control_property_core`.
#[test]
fn nothing_may_write_a_held_key_by_name() {
    let state = seeded(held_button());
    let file = FileState::default();
    for key in HELD_CONTROL_PROPERTIES {
        let refused = crate::controls::set_control_property_core(
            &state, &file, 0, 2, 1, "".into(), key.to_string(), "static".into(), "Evil();".into(),
        );
        assert!(refused.is_err_and(|e| e.contains("nothing may write it")), "'{key}' was writable");
    }
    assert_eq!(state.controls.read().unwrap()[&(0, 2, 1)].properties[HELD_ON_SELECT_PROPERTY].value, "Report();");
    assert!(!file.is_dirty());
}

/// THE TAB-THROUGH. The Properties pane commits its code field on blur, and on
/// a held button that field reads "": the write must change nothing.
///
/// SABOTAGE: drop the `tab_through` no-op in `set_control_property_core`.
#[test]
fn an_empty_write_to_an_absent_code_slot_of_a_held_button_changes_nothing() {
    let state = seeded(held_button());
    let file = FileState::default();
    let depth = undo_depth(&state);
    let out = crate::controls::set_control_property_core(
        &state, &file, 0, 2, 1, "".into(), ON_SELECT_PROPERTY.into(), "static".into(), "".into(),
    )
    .expect("a no-op, not an error");
    assert!(out.properties.contains_key(HELD_ON_SELECT_PROPERTY));
    let stored = state.controls.read().unwrap()[&(0, 2, 1)].clone();
    assert!(!stored.properties.contains_key(ON_SELECT_PROPERTY), "an empty slot was written");
    assert_eq!(stored.properties[HELD_ON_SELECT_PROPERTY].value, "Report();", "the application's code was lost");
    assert!(!file.is_dirty(), "a no-op dirtied the document");
    assert_eq!(undo_depth(&state), depth, "a no-op recorded an undo step");
}

/// The author's own code replaces the application's WHOLE -- both held slots and
/// the stamp -- and Ctrl+Z brings the application's code back.
#[test]
fn the_authors_code_replaces_the_held_code_and_undo_brings_it_back() {
    let state = seeded(held_button());
    let file = FileState::default();
    let depth = undo_depth(&state);
    crate::controls::set_control_property_core(
        &state, &file, 0, 2, 1, "".into(), ON_SELECT_PROPERTY.into(), "static".into(), "Mine();".into(),
    )
    .unwrap();
    let stored = state.controls.read().unwrap()[&(0, 2, 1)].clone();
    assert_eq!(stored.properties[ON_SELECT_PROPERTY].value, "Mine();");
    for key in HELD_CONTROL_PROPERTIES {
        assert!(!stored.properties.contains_key(*key), "'{key}' survived the author's replacement");
    }
    assert_eq!(undo_depth(&state), depth + 1, "a code write is undoable");
    undo_once(&state);
    let restored = state.controls.read().unwrap()[&(0, 2, 1)].clone();
    assert_eq!(restored.properties[HELD_ON_SELECT_PROPERTY].value, "Report();", "undo lost the held code");
    assert!(!restored.properties.contains_key(ON_SELECT_PROPERTY));
}

/// Paste and duplicate re-create a button through the metadata door: the copy
/// is the author's, without the application's code.
///
/// SABOTAGE: drop the held-key strip in `set_control_metadata_core`.
#[test]
fn a_pasted_copy_of_a_held_button_holds_no_code() {
    let state = crate::create_app_state();
    let file = FileState::default();
    let stored = crate::controls::set_control_metadata_core(&state, &file, 0, 5, 5, held_button()).unwrap();
    for key in HELD_CONTROL_PROPERTIES {
        assert!(!stored.properties.contains_key(*key), "a copy carried '{key}'");
        assert!(!state.controls.read().unwrap()[&(0, 5, 5)].properties.contains_key(*key));
    }
    assert_eq!(stored.properties["text"].value, "Go", "the rest of the button is copied");
}

/// A MOVE keeps the button's code: the floating/in-cell toggle goes through it.
///
/// SABOTAGE: strip the held keys from `moved` in `move_control_core`.
#[test]
fn moving_a_held_button_carries_its_code_as_one_undo_step() {
    let state = seeded(held_button());
    let file = FileState::default();
    let depth = undo_depth(&state);
    let overrides: HashMap<String, ControlPropertyValue> =
        [("embedded".to_string(), prop("true")), ("pinToGrid".to_string(), prop("true"))].into_iter().collect();
    let moved = crate::controls::move_control_core(&state, &file, 0, (2, 1), (6, 3), overrides).unwrap();
    assert_eq!(moved.properties[HELD_ON_SELECT_PROPERTY].value, "Report();");
    let store = state.controls.read().unwrap();
    assert!(!store.contains_key(&(0, 2, 1)));
    let at = &store[&(0, 6, 3)];
    for key in HELD_CONTROL_PROPERTIES {
        assert!(at.properties.contains_key(*key), "the move lost '{key}'");
    }
    assert_eq!(at.properties["embedded"].value, "true");
    drop(store);
    assert_eq!(undo_depth(&state), depth + 1, "one move, one undo step");
    assert!(file.is_dirty());
}

#[test]
fn a_move_never_writes_code_or_overwrites_another_control() {
    let state = seeded(held_button());
    let file = FileState::default();
    for key in [ON_SELECT_PROPERTY, MACRO_REF_PROPERTY, HELD_ON_SELECT_PROPERTY, HELD_FROM_PROPERTY] {
        let overrides: HashMap<String, ControlPropertyValue> = [(key.to_string(), prop("x"))].into_iter().collect();
        assert!(crate::controls::move_control_core(&state, &file, 0, (2, 1), (6, 3), overrides).is_err(), "{key}");
    }
    state.controls.write(&test_seed_effect()).unwrap().insert((0, 6, 3), held_button());
    let refused = crate::controls::move_control_core(&state, &file, 0, (2, 1), (6, 3), HashMap::new());
    assert!(refused.is_err_and(|e| e.contains("Another control")));
    assert!(crate::controls::move_control_core(&state, &file, 0, (9, 9), (6, 4), HashMap::new()).is_err());
    assert!(!file.is_dirty(), "a refused move dirtied the document");
}

/// Deleting a macro warns about the application's held links to it.
///
/// SABOTAGE: drop the `HELD_MACRO_REF_PROPERTY` branch of
/// `controls_referencing_macro`.
#[test]
fn the_delete_a_macro_scan_names_held_links() {
    let state = seeded(held_button());
    let found = crate::controls::controls_referencing_macro(&state, "macro-report");
    assert_eq!(found.len(), 1, "{found:?}");
    assert_eq!(found[0].held_by.as_deref(), Some("sales"));
    assert!(crate::controls::controls_referencing_macro(&state, "macro-other").is_empty());
}

// ============================================================================
// 4. The round trip through a signed workspace
// ============================================================================

/// THE BUG. Publish, check out, push untouched: the application's buttons keep
/// their code, byte for byte.
///
/// SABOTAGE: make `materialize_pull_result` pass `DistributedWiring::Strip` for
/// `MaterializeMode::Checkout` -- today's BUG-0257, reproduced: v1.0.1's
/// controls.json has no code.
#[test]
fn an_untouched_push_republishes_the_applications_button_code_byte_for_byte() {
    let wc = check_out();
    assert_eq!(wc.response.button_code_held, 2, "B2's inline code and C3's macro link are held");

    // In the working copy, no click can run it: the live slots are absent.
    let b2 = wc.stores.control(wc.sheet, 1, 1);
    assert!(!b2.properties.contains_key(ON_SELECT_PROPERTY), "live code in a working copy");
    assert_eq!(b2.properties[HELD_ON_SELECT_PROPERTY].value, "Report();");
    let from = HeldFrom::decode(&b2.properties[HELD_FROM_PROPERTY].value).expect("stamped");
    assert_eq!((from.application.as_str(), from.version.as_str()), (PKG, "1.0.0"));
    // The recipe button's empty slot is not code and stays live.
    assert_eq!(wc.stores.control(wc.sheet, 3, 3).properties[ON_SELECT_PROPERTY].value, "");

    let pushed = wc.push_untouched();
    let base = artifact(&wc.dir, "1.0.0", "controls.json").unwrap();
    assert_eq!(
        String::from_utf8_lossy(&pushed),
        String::from_utf8_lossy(&base),
        "an untouched push changed the application's controls"
    );
    assert!(!String::from_utf8_lossy(&pushed).contains("held"), "a held key reached controls.json");

    // The working copy itself is still disarmed after the push.
    assert!(!wc.stores.control(wc.sheet, 1, 1).properties.contains_key(ON_SELECT_PROPERTY));
}

/// THE TOGGLE. Floating -> in-cell re-anchors the button; its code must go with
/// it, and the push must publish exactly the base with that move applied.
///
/// SABOTAGE: strip the held keys from `moved` in `move_control_core` (the old
/// set-then-remove route did exactly that).
#[test]
fn a_toggled_held_button_is_pushed_with_its_code() {
    let wc = check_out();
    let overrides: HashMap<String, ControlPropertyValue> =
        [("embedded".to_string(), prop("true")), ("pinToGrid".to_string(), prop("true"))].into_iter().collect();
    crate::controls::move_control_core(&wc.stores.state, &FileState::default(), wc.sheet, (1, 1), (5, 4), overrides)
        .expect("the toggle's move");
    let pushed = wc.push_untouched();

    // Expected: the base's controls.json with exactly that move applied.
    let base = artifact(&wc.dir, "1.0.0", "controls.json").unwrap();
    let mut expected: Vec<SavedSheetControls> = serde_json::from_slice(&base).unwrap();
    let entries = expected[0].controls.as_array_mut().unwrap();
    for entry in entries.iter_mut() {
        if entry["row"] == 1 && entry["col"] == 1 {
            entry["row"] = 5.into();
            entry["col"] = 4.into();
            entry["properties"]["embedded"] = serde_json::json!({ "valueType": "static", "value": "true" });
            entry["properties"]["pinToGrid"] = serde_json::json!({ "valueType": "static", "value": "true" });
        }
    }
    entries.sort_by_key(|e| (e["row"].as_u64(), e["col"].as_u64()));
    let expected = serde_json::to_string_pretty(&expected.iter().collect::<Vec<_>>()).unwrap();
    assert_eq!(String::from_utf8_lossy(&pushed), expected, "the toggled button lost its code");
}

/// SAVE AND REOPEN keeps the held code inert (still no live slot) and a later
/// push still restores it.
#[test]
fn a_saved_and_reopened_working_copy_keeps_its_held_code_inert() {
    let wc = check_out();
    let tmp = TempDir::new().unwrap();
    let path = tmp.path().join("working-copy.cala");
    let mut file = wc.stores.carrier(&wc.app);
    file.sheets = wc.app.sheets.clone();
    calcula_format::save_calcula(&file, &path).unwrap();
    let reopened = calcula_format::load_calcula(&path).unwrap();

    let mut store: crate::controls::ControlStorage = HashMap::new();
    crate::controls::materialize_saved_controls(&reopened.controls, &mut store, |_| Some(0));
    let b2 = &store[&(0, 1, 1)];
    assert!(!b2.properties.contains_key(ON_SELECT_PROPERTY), "a reopen armed held code");
    assert_eq!(b2.properties[HELD_ON_SELECT_PROPERTY].value, "Report();");
    assert_eq!(store[&(0, 2, 2)].properties[HELD_MACRO_REF_PROPERTY].value, "macro-report");

    // The reopened carrier releases exactly like the live one.
    let mut carrier = reopened;
    let base = SignedBase::new(&location(&wc.dir), PKG);
    let release = release_for_push(&wc.stores.state, &mut carrier, &[0], &location(&wc.dir), PKG, &base).unwrap();
    assert_eq!(release.restored.len(), 2, "{release:?}");
    assert!(release.refused.is_empty());
}

/// PHASE 3. A SUBSCRIBER keeps an application's LINK to a macro the pull landed
/// -- HELD, stamped with the application, never live -- so the click can run
/// it only as that application's macro, after its approval. Inline code still
/// arrives removed, and nothing a package calls "held" is taken at its word.
///
/// SABOTAGE: `MaterializeMode::Subscribe => DistributedWiring::Strip` in
/// `materialize_pull_result` (the pre-phase-3 subscribe).
#[test]
fn a_subscriber_keeps_a_landed_macro_link_held_and_stamped() {
    let dir = TempDir::new().unwrap();
    let alice = TempDir::new().unwrap();
    let reg = LocalWorkspace::open(dir.path()).unwrap();
    let app = dashboard_shipping_its_macro();
    publish_version(&reg, alice.path(), &app, SemVer::new(1, 0, 0), PushMode::CreateNew);

    let subscriber = Stores::new();
    let response = subscriber.materialize(subscribe_pull(&dir, "1.0.0"), MaterializeMode::Subscribe);
    let sheet = subscriber.dashboard_index();
    assert_eq!(subscriber.state.controls.read().unwrap().len(), 3, "the application's buttons arrived");

    let c3 = subscriber.control(sheet, 2, 2);
    assert!(!c3.properties.contains_key(MACRO_REF_PROPERTY), "a subscriber's link arrived LIVE");
    assert_eq!(slot(&c3, HELD_MACRO_REF_PROPERTY), ("static", "macro-report"), "the landed link is held, static");
    let from = HeldFrom::decode(&c3.properties[HELD_FROM_PROPERTY].value).expect("stamped");
    assert_eq!(from.application, PKG);
    assert_eq!(from.version, "1.0.0");
    assert_eq!(from.workspace, calp::workspace_scope(&location(&dir)).unwrap().id);

    // Phase 4: B2's inline code is HELD and stamped too -- never live
    // (`a_subscriber_holds_inline_code_stamped_and_nothing_live`).
    let b2 = subscriber.control(sheet, 1, 1);
    assert!(!b2.properties.contains_key(ON_SELECT_PROPERTY), "inline code arrived LIVE");
    assert_eq!(slot(&b2, HELD_ON_SELECT_PROPERTY), ("static", "Report();"));
    let d4 = subscriber.control(sheet, 3, 3);
    assert!(!d4.properties.contains_key(HELD_FROM_PROPERTY), "a button with nothing held is not stamped");

    assert_eq!(response.button_links_held, 1);
    assert!(response.button_links_removed.is_empty(), "{:?}", response.button_links_removed);
    assert_eq!(response.button_code_held, 0, "button_code_held is a checkout's count");
    // The macro landed as the application's.
    assert_eq!(
        subscriber.scripts.workbook_scripts.read().unwrap()["macro-report"].source_package.as_deref(),
        Some(PKG)
    );

    // A crafted version whose controls carry held keys outright: discarded.
    let mut crafted = app.clone();
    crafted.controls[0].controls[0]["properties"]["heldOnSelect"] =
        serde_json::json!({ "valueType": "static", "value": "Evil();" });
    crafted.controls[0].controls[2]["properties"]["heldMacroRef"] =
        serde_json::json!({ "valueType": "static", "value": "macro-report" });
    publish_version(&reg, alice.path(), &crafted, SemVer::new(1, 0, 1), PushMode::Update { expected_base: SemVer::new(1, 0, 0) });
    let other = Stores::new();
    other.materialize(subscribe_pull(&dir, "1.0.1"), MaterializeMode::Subscribe);
    let sheet = other.dashboard_index();
    assert_eq!(
        slot(&other.control(sheet, 1, 1), HELD_ON_SELECT_PROPERTY),
        ("static", "Report();"),
        "a package's own held code was taken at its word instead of the published onSelect"
    );
    let d4 = other.control(sheet, 3, 3);
    assert!(!d4.properties.contains_key(HELD_MACRO_REF_PROPERTY), "a package's own 'held' link was taken at its word");
    assert!(!d4.properties.contains_key(HELD_FROM_PROPERTY));
}

/// THE CONFUSED DEPUTY, on the button-control channel. The subscriber already
/// owns a `macro-report` of their own; the application ships one too, so the
/// pull SKIPS the application's -- and the application's button that links
/// `macro-report` must not arrive pointing at the subscriber's macro. The link
/// is removed, named in the response, and the subscriber's macro is untouched.
///
/// SABOTAGE: feed the admission `result.module_scripts` ids instead of the
/// APPLIED list (`landed_macros: applied_module_ids`).
#[test]
fn a_subscribers_own_same_id_macro_never_receives_the_link() {
    let dir = TempDir::new().unwrap();
    let alice = TempDir::new().unwrap();
    let reg = LocalWorkspace::open(dir.path()).unwrap();
    publish_version(&reg, alice.path(), &dashboard_shipping_its_macro(), SemVer::new(1, 0, 0), PushMode::CreateNew);

    let subscriber = Stores::new().with_own_macro("macro-report", "Calcula.log('MY OWN report');");
    let response = subscriber.materialize(subscribe_pull(&dir, "1.0.0"), MaterializeMode::Subscribe);
    let c3 = subscriber.control(subscriber.dashboard_index(), 2, 2);
    assert!(!c3.properties.contains_key(HELD_MACRO_REF_PROPERTY), "the link reached the subscriber's own macro");
    assert!(!c3.properties.contains_key(MACRO_REF_PROPERTY));
    assert_eq!(response.button_links_held, 0);
    assert_eq!(response.button_links_removed.len(), 1, "{:?}", response.button_links_removed);
    let notice = &response.button_links_removed[0];
    assert!(notice.starts_with("Dashboard!C3: links the macro \"macro-report\""), "{notice}");
    assert!(notice.contains("did not bring") && notice.contains("the link was removed"), "{notice}");
    let own = &subscriber.scripts.workbook_scripts.read().unwrap()["macro-report"];
    assert_eq!((own.source.as_str(), own.source_package.as_deref()), ("Calcula.log('MY OWN report');", None));
}

/// A link to a macro the application never shipped is removed with a notice
/// on a subscribe (the push would refuse it; a crafted or older version can
/// still carry one).
///
/// SABOTAGE: in `admit_wiring`'s `LinkLanded` arm, hold every link
/// (`Some(from)` without the `landed_macros` check).
#[test]
fn a_link_to_a_macro_the_application_does_not_ship_is_removed_with_a_notice() {
    let dir = TempDir::new().unwrap();
    let alice = TempDir::new().unwrap();
    let reg = LocalWorkspace::open(dir.path()).unwrap();
    publish_version(&reg, alice.path(), &dashboard(), SemVer::new(1, 0, 0), PushMode::CreateNew);
    let subscriber = Stores::new();
    // Collaboration auditing on, so the (opt-in) Subscribe row is kept.
    subscriber.state.audit_log.write(&test_seed_effect()).unwrap().enabled = true;
    let response = subscriber.materialize(subscribe_pull(&dir, "1.0.0"), MaterializeMode::Subscribe);
    let c3 = subscriber.control(subscriber.dashboard_index(), 2, 2);
    for key in [MACRO_REF_PROPERTY, HELD_MACRO_REF_PROPERTY, HELD_FROM_PROPERTY] {
        assert!(!c3.properties.contains_key(key), "'{key}' survived: {c3:?}");
    }
    assert_eq!(response.button_links_removed.len(), 1, "{:?}", response.button_links_removed);
    assert!(response.button_links_removed[0].contains("Dashboard!C3") && response.button_links_removed[0].contains("macro-report"));
    // The subscribe's audit row counts what happened to the links.
    // SABOTAGE: drop the link counts from the Subscribe description.
    let log = subscriber.state.audit_log.read().unwrap();
    let row = log
        .entries
        .iter()
        .find(|e| matches!(e.event, calp::audit::AuditEvent::Subscribe))
        .expect("the subscribe row");
    assert!(
        row.description.contains("0 button macro link(s) held for approval and 1 removed"),
        "{}",
        row.description
    );
}

/// A REFRESH keeps a link whose macro the new version still ships (restamped
/// with the new version) and drops one whose macro left, naming it.
///
/// SABOTAGE: pass `DistributedWiring::Strip` on the refresh door (the pre-phase-3
/// refresh) -- the kept link is lost.
#[test]
fn a_refresh_keeps_a_landed_link_and_drops_one_whose_macro_left() {
    let dir = TempDir::new().unwrap();
    let alice = TempDir::new().unwrap();
    let reg = LocalWorkspace::open(dir.path()).unwrap();
    let mut v1 = dashboard_shipping_its_macro();
    v1.scripts.push(macro_module("macro-extra", "Calcula.log('extra');"));
    v1.controls[0].controls.as_array_mut().unwrap().push(serde_json::json!(
        { "row": 5, "col": 1, "controlType": "button", "properties": {
            "macroRef": { "valueType": "static", "value": "macro-extra" },
            "text": { "valueType": "static", "value": "Extra" }
        } }
    ));
    publish_version(&reg, alice.path(), &v1, SemVer::new(1, 0, 0), PushMode::CreateNew);
    let subscriber = Stores::new();
    let first = subscriber.materialize(subscribe_pull(&dir, "1.0.0"), MaterializeMode::Subscribe);
    assert_eq!(first.button_links_held, 2);

    // v1.1.0 no longer ships macro-extra; its button still links it.
    let mut v2 = v1.clone();
    v2.scripts.retain(|s| s.id != "macro-extra");
    publish_version(&reg, alice.path(), &v2, SemVer::new(1, 1, 0), PushMode::Update { expected_base: SemVer::new(1, 0, 0) });
    subscriber.state.audit_log.write(&test_seed_effect()).unwrap().enabled = true;
    let result = subscriber.refresh(subscribe_pull(&dir, "1.1.0"));
    let sheet = subscriber.dashboard_index();

    let c3 = subscriber.control(sheet, 2, 2);
    assert_eq!(slot(&c3, HELD_MACRO_REF_PROPERTY), ("static", "macro-report"), "the refresh lost a landed link");
    let from = HeldFrom::decode(&c3.properties[HELD_FROM_PROPERTY].value).expect("stamped");
    assert_eq!(from.version, "1.1.0", "the stamp names the version the link came with");
    let b6 = subscriber.control(sheet, 5, 1);
    assert!(!b6.properties.contains_key(HELD_MACRO_REF_PROPERTY), "a link outlived its macro");
    assert_eq!(result.button_links_removed.len(), 1, "{:?}", result.button_links_removed);
    assert!(result.button_links_removed[0].starts_with("Dashboard!B6: links the macro \"macro-extra\""));
    assert!(!subscriber.scripts.workbook_scripts.read().unwrap().contains_key("macro-extra"), "removal-on-refresh");
    // The refresh's audit row counts the removed link.
    // SABOTAGE: drop the link count from the Refresh description.
    let refreshed = subscriber
        .state
        .audit_log
        .read()
        .unwrap()
        .entries
        .iter()
        .find(|e| matches!(e.event, calp::audit::AuditEvent::Refresh))
        .map(|e| e.description.clone())
        .expect("the refresh row");
    assert!(refreshed.contains("1 button macro link(s) removed"), "{refreshed}");
}

/// A CHECKOUT still holds EVERY link -- a landed one and one whose macro the
/// application does not ship -- for push fidelity. The unlanded one can never
/// run (the click requires the macro to have come with the stamp's
/// application) and the push refuses it by name
/// (`refuse_push_on_unshipped_macros`).
#[test]
fn a_checkout_still_holds_every_link() {
    let wc = check_out();
    assert_eq!(wc.response.button_links_held, 1, "C3's link to an unshipped macro is held");
    assert!(wc.response.button_links_removed.is_empty(), "a checkout removes nothing");
    let c3 = wc.stores.control(wc.sheet, 2, 2);
    assert_eq!(slot(&c3, HELD_MACRO_REF_PROPERTY), ("static", "macro-report"));
    assert!(!c3.properties.contains_key(MACRO_REF_PROPERTY));
}

/// A CRAFTED WORKING COPY: held bytes the signed base does not carry, under a
/// valid stamp. The push is refused and names the button.
#[test]
fn a_working_copy_with_forged_held_code_is_refused_by_name() {
    let wc = check_out();
    wc.stores
        .state
        .controls
        .write(&test_seed_effect())
        .unwrap()
        .get_mut(&(wc.sheet, 1, 1))
        .unwrap()
        .properties
        .insert(HELD_ON_SELECT_PROPERTY.to_string(), prop("Exfiltrate();"));
    let (carrier, release) = wc.release();
    let refusal = release.refusal().expect("refused");
    assert!(refusal.contains("Dashboard!B2"), "{refusal}");
    assert!(!serde_json::to_string(&carrier.controls).unwrap().contains("Exfiltrate"), "forged code on the carrier");
    // C3's genuine held link still restores; it is only the forged slot that fails.
    assert_eq!(release.restored.len(), 1, "{release:?}");
}

/// The author's own new code goes out only with an acknowledgement.
#[test]
fn the_authors_new_button_code_needs_an_acknowledgement() {
    let wc = check_out();
    crate::controls::set_control_property_core(
        &wc.stores.state,
        &FileState::default(),
        wc.sheet,
        3,
        3,
        "".into(),
        ON_SELECT_PROPERTY.into(),
        "static".into(),
        "Mine();".into(),
    )
    .unwrap();
    let (_, release) = wc.release();
    assert_eq!(release.restored.len(), 2);
    assert_eq!(release.unreviewed.len(), 1, "{release:?}");
    assert_eq!(release.unreviewed[0].cell, "Dashboard!D4");
    assert!(release.acknowledgement_refusal(&[]).is_some());
    assert!(release.acknowledgement_refusal(&[release.unreviewed[0].hash.clone()]).is_none());
}

// ============================================================================
// 5. Placement
// ============================================================================

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

/// The release runs in the ONE assembly publish, preview and diff share; the
/// publish gates on it before core publish; and checkout is the only mode that
/// holds.
///
/// SABOTAGE: move `.refusal()` below `calp::publish::publish(`, or drop the
/// `release_for_push(` call from the assembly.
#[test]
fn the_release_and_its_gates_sit_where_every_push_passes() {
    let cmds = source("src/calp_commands.rs");
    let assembly = body_of(&cmds, "fn assemble_publish_workbook(");
    // The release sits in the ONE filter-then-release composition the assembly
    // calls (and the include tests drive).
    assert!(assembly.contains("filter_and_release("), "the assembly no longer filters and releases");
    let composition = body_of(&cmds, "pub(crate) fn filter_and_release(");
    assert!(composition.contains("held_button_code::release_for_push("), "the assembly no longer releases held code");
    // ONE signed base, shared by both channels' releases.
    assert_eq!(assembly.matches("SignedBase::new(").count(), 1, "the signed base is opened more than once");
    assert_eq!(assembly.matches("&signed_base,").count(), 2, "a release reads its own signed base again");
    let publish = body_of(&cmds, "pub fn calp_publish(");
    let gate = publish.find("refuse_push_on_button_code(").expect("the button-code gate moved");
    let core = publish.find("calp::publish::publish(").expect("core publish moved");
    let effect = publish.find("DocumentEffect::mutates(").expect("the push's effect moved");
    assert!(gate < core && gate < effect, "the button-code gate runs before core publish and the effect");
    // Acknowledgements come from the push REQUEST, which only the push dialog
    // fills with the code on screen -- never from anywhere else.
    let call = &publish[gate..];
    let call = &call[..call.find(")?;").expect("the gate call")];
    assert!(call.contains("&params.acknowledged_button_code,"), "the gate is not handed the request's own list: {call}");
    let gate_body = body_of(&source("src/held_button_code.rs"), "pub(crate) fn refuse_push_on_button_code(").to_string();
    assert!(gate_body.contains(".refusal()") && gate_body.contains(".acknowledgement_refusal(acknowledged)"));
    let materializer = body_of(&cmds, "pub(crate) fn materialize_pull_result(");
    // Phase 3: a subscribe holds a LANDED link, fed the APPLIED module ids.
    assert!(
        materializer.contains("MaterializeMode::Subscribe => crate::held_button_code::DistributedWiring::LinkLanded {"),
        "a subscribe no longer holds only landed links"
    );
    assert!(materializer.contains("landed_macros: applied_module_ids.clone(),"), "the subscribe's landed set is not the applied list");
    assert_eq!(
        cmds.matches("DistributedWiring::Hold(").count(),
        1,
        "only the checkout arm of the materializer holds"
    );
    // The refresh holds a landed link too, per payload, from its applied list.
    let refresh = body_of(&cmds, "pub(crate) fn apply_refresh_payloads(");
    assert!(refresh.contains("DistributedWiring::LinkLanded {") && refresh.contains("landed_macros: applied.clone(),"));
    assert_eq!(cmds.matches("DistributedWiring::LinkLanded {").count(), 2, "only subscribe and refresh hold landed links");
    // A dev pull brings no modules, so it strips.
    let dev = body_of(&cmds, "fn materialize_dev_controls(");
    assert!(dev.contains("DistributedWiring::Strip"), "a dev pull no longer strips");
}

// ============================================================================
// 6. Review findings (2026-09-30)
// ============================================================================

/// Re-sign `version` as `name` with the key in `prof` -- how someone who can
/// write to the share plants a version (valid signature, unauthorised key).
fn resign(reg: &LocalWorkspace, version: &str, prof: &Path, name: &str) {
    let kp = calp::signing::PublisherKeypair::load_or_create(prof).unwrap();
    let mut ver = reg.get_version_manifest(PKG, version).unwrap();
    ver.publisher_key = kp.public_key_hex();
    ver.publisher_name = name.to_string();
    reg.write_version_manifest(PKG, version, &ver).unwrap();
    let dir = reg.version_dir(PKG, version).unwrap();
    let bytes = std::fs::read(dir.join(calp::integrity::VERSION_MANIFEST_FILE)).unwrap();
    std::fs::write(dir.join(calp::integrity::VERSION_MANIFEST_SIG_FILE), kp.sign(&bytes)).unwrap();
}

/// THE SIGNED BASE IS READ THROUGH THE AUTHORISED READER. A working-copy link
/// naming a base that a key which is NOT an authorised publisher re-signed must
/// not vouch for held code -- otherwise a planted head (and a crafted working
/// copy based on it) gets its code republished under the developer's key, and
/// the preview shows no change because the carrier matches the planted head.
///
/// SABOTAGE: `SignedBase::open` reads through `open_verified_content` instead
/// of `open_authorized_content` (same signature, no signer check).
#[test]
fn a_base_an_unauthorised_key_signed_cannot_vouch_for_held_code() {
    let dir = TempDir::new().unwrap();
    let alice = TempDir::new().unwrap();
    let mallory = TempDir::new().unwrap();
    let reg = LocalWorkspace::open(dir.path()).unwrap();
    let app = dashboard();
    publish_version(&reg, alice.path(), &app, SemVer::new(1, 0, 0), PushMode::CreateNew);
    publish_version(&reg, alice.path(), &app, SemVer::new(1, 1, 0), PushMode::Update { expected_base: SemVer::new(1, 0, 0) });
    let scope = calp::workspace_scope(&location(&dir)).unwrap();
    let checked_out = calp::checkout::checkout(&reg, PKG, Some(SemVer::new(1, 1, 0)), "2026-09-30T01:00:00Z", &scope, alice.path())
        .expect("checkout");
    let stores = Stores::new();
    let base_sheets = checked_out
        .pulled
        .sheets
        .iter()
        .map(|s| calp::WorkingCopySheetRef { sheet_id: s.package_sheet_id, name: s.name.clone() })
        .collect();
    stores.materialize(checked_out.pulled, MaterializeMode::Checkout);
    *stores.state.working_copy_link.write(&test_seed_effect()).unwrap() = Some(calp::WorkingCopyLink::new(
        &location(&dir), PKG, "report", "1.1.0", "2026-09-30T01:00:00Z", base_sheets));
    // Positive control: the genuine base vouches for both held slots.
    let mut carrier = stores.carrier(&app);
    let base = SignedBase::new(&location(&dir), PKG);
    let ok = release_for_push(&stores.state, &mut carrier, &[0], &location(&dir), PKG, &base).unwrap();
    assert_eq!(ok.restored.len(), 2, "{ok:?}");
    // Mallory re-signs the BASE (not the root): the authorised reader refuses it.
    resign(&reg, "1.1.0", mallory.path(), "mallory");
    let mut carrier = stores.carrier(&app);
    let base = SignedBase::new(&location(&dir), PKG);
    let release = release_for_push(&stores.state, &mut carrier, &[0], &location(&dir), PKG, &base).unwrap();
    assert!(release.restored.is_empty(), "a base signed by an unauthorised key vouched for held code: {release:?}");
    assert_eq!(release.refused.len(), 2, "{release:?}");
    assert!(release.refused[0].reason.contains("not an authorised publisher"), "{}", release.refused[0].reason);
}

/// Both readers of the signed base go through the ONE authorised opener, and
/// neither re-opens the version itself. A reader that opened it with the plain
/// verified reader would launder a planted base.
///
/// SABOTAGE: have `signed_base_code` open the version itself with
/// `open_verified_content(`.
#[test]
fn both_signed_base_readers_go_through_the_authorised_opener() {
    let held = source("src/held_button_code.rs");
    let production = held.split("#[cfg(test)]").next().unwrap();
    assert!(!production.contains("open_verified_content("), "a held-code reader skips the signer check");
    let open = body_of(production, "fn open(&self, base_version: &str)");
    assert!(open.contains("crate::calp_inspector::open_authorized_content("), "the signed base is opened without the signer check");
    for reader in ["pub(crate) fn signed_base_code(", "pub(crate) fn signed_base_cell_actions("] {
        let src = if reader.contains("cell") { source("src/button_cells.rs") } else { held.clone() };
        let body = body_of(&src, reader).to_string();
        assert!(body.contains("base: &SignedBase"), "{reader} no longer reads through the shared signed base");
        assert!(!body.contains("open_verified_content(") && !body.contains("open_authorized_content("), "{reader} opens the version itself");
    }
    assert!(!source("src/button_cells.rs").split("#[cfg(test)]").next().unwrap().contains("open_verified_content("));
}

/// A slot the package gave a non-static type is restored EXACTLY: the held copy
/// is always static, and the stamp remembers the type. Restored as `static`, a
/// formula-typed slot fails the hash check and an untouched push of that
/// application is refused instead of republished.
///
/// SABOTAGE: the release uses "static" instead of `from.value_type_of(live_key)`.
#[test]
fn a_formula_typed_held_slot_goes_back_with_its_type() {
    let sheet = identity::SheetId::from_bytes(identity::generate_uuid_v7());
    let saved = vec![SavedSheetControls {
        sheet_id: sheet,
        controls: serde_json::json!([
            { "row": 1, "col": 1, "controlType": "button", "properties": {
                "macroRef": { "valueType": "formula", "value": "=A1" } } }
        ]),
    }];
    let (mut carrier, _) = admit_wiring(&saved, &DistributedWiring::Hold(stamp()));
    let published: HashSet<_> = [sheet].into_iter().collect();
    let release = release_held_code_for_publish(
        &mut carrier, &published, &names(sheet), Some(&target(sheet, &[("formula", "=A1")])));
    assert_eq!(release.restored.len(), 1, "{release:?}");
    assert_eq!(
        carrier[0].controls[0]["properties"][MACRO_REF_PROPERTY],
        serde_json::json!({ "valueType": "formula", "value": "=A1" })
    );
}

/// Re-committing a code slot's own value changes nothing: no dirty flag, no
/// "Change button code" step for a Ctrl+Z that undoes nothing.
///
/// SABOTAGE: `let unchanged = false && ...` in `set_control_property_with`.
#[test]
fn an_unchanged_code_write_changes_nothing() {
    let mut properties = HashMap::new();
    properties.insert(ON_SELECT_PROPERTY.to_string(), prop("Mine();"));
    let state = seeded(ControlMetadata { control_type: "button".into(), properties });
    let file = FileState::default();
    let depth = undo_depth(&state);
    crate::controls::set_control_property_core(
        &state, &file, 0, 2, 1, "".into(), ON_SELECT_PROPERTY.into(), "static".into(), "Mine();".into(),
    )
    .unwrap();
    assert!(!file.is_dirty(), "an unchanged code write dirtied the document");
    assert_eq!(undo_depth(&state), depth, "an unchanged code write recorded an undo step");
}

/// "REMOVE THE APPLICATION'S CODE" is a real edit. With the flag (sent only
/// after the Properties pane's confirm showed the held code), an empty write to
/// a held button's code slot discards the whole held compartment as ONE
/// undoable "Change button code" step. Without some such gesture a developer
/// could not remove an application button's action at all: the empty write was
/// the tab-through no-op, and the next push restored the code.
///
/// SABOTAGE: drop `!removes_held &&` from the no-op guard in
/// `set_control_property_with`.
#[test]
fn the_remove_step_discards_the_held_code_as_one_undoable_step() {
    let state = seeded(held_button());
    let file = FileState::default();
    let depth = undo_depth(&state);
    let out = crate::controls::set_control_property_with(
        &state, &file, 0, 2, 1, "".into(), ON_SELECT_PROPERTY.into(), "static".into(), "".into(), true,
    )
    .expect("the remove step");
    for key in HELD_CONTROL_PROPERTIES {
        assert!(!out.properties.contains_key(*key), "'{key}' survived the remove step");
    }
    assert_eq!(out.properties[ON_SELECT_PROPERTY].value, "", "the button is left with no code");
    assert!(file.is_dirty());
    assert_eq!(undo_depth(&state), depth + 1, "one undoable step");
    undo_once(&state);
    let back = state.controls.read().unwrap()[&(0, 2, 1)].clone();
    assert_eq!(back.properties[HELD_ON_SELECT_PROPERTY].value, "Report();", "undo brought the code back");

    // The flag on a button that holds NOTHING is an ordinary write (here, an
    // unchanged one: nothing happens).
    let mut plain = HashMap::new();
    plain.insert(ON_SELECT_PROPERTY.to_string(), prop(""));
    let state = seeded(ControlMetadata { control_type: "button".into(), properties: plain });
    let file = FileState::default();
    crate::controls::set_control_property_with(
        &state, &file, 0, 2, 1, "".into(), ON_SELECT_PROPERTY.into(), "static".into(), "".into(), true,
    )
    .unwrap();
    assert!(!file.is_dirty(), "the flag turned a no-op into an edit on a button with no held code");
}

/// A MOVED BUTTON'S OBJECT SCRIPTS FOLLOW IT, and Ctrl+Z puts the binding back.
/// A button's scripts find it by its anchor-derived id; the toggle's move left
/// them bound to the old, empty cell, so the next push shipped them unbound.
///
/// SABOTAGE: skip `rekey_control_bindings` in `move_control_core`.
#[test]
fn a_moved_buttons_object_scripts_move_with_it_and_undo_puts_them_back() {
    let state = seeded(held_button());
    let script = |id: &str, instance: &str| persistence::SavedObjectScript {
        id: id.to_string(),
        name: id.to_string(),
        object_type: persistence::ScriptableObjectType::Button,
        instance_id: Some(instance.to_string()),
        source: "// click".to_string(),
        access_level: persistence::ScriptAccessLevel::Restricted,
        description: None,
        provenance: persistence::ScriptProvenance::Local,
        package_name: None,
        package_version: None,
        declared_capabilities: Vec::new(),
    };
    *state.object_scripts.write(&test_seed_effect()).unwrap() =
        vec![script("os-moved", "control-0-2-1"), script("os-other", "control-0-9-9")];
    let file = FileState::default();
    crate::controls::move_control_core(&state, &file, 0, (2, 1), (6, 3), HashMap::new()).unwrap();
    let bindings = |state: &crate::AppState| -> Vec<(String, Option<String>)> {
        state.object_scripts.read().unwrap().iter().map(|s| (s.id.clone(), s.instance_id.clone())).collect()
    };
    assert_eq!(
        bindings(&state),
        vec![
            ("os-moved".to_string(), Some("control-0-6-3".to_string())),
            ("os-other".to_string(), Some("control-0-9-9".to_string())),
        ],
        "the script stayed at the old anchor"
    );
    undo_once(&state);
    assert_eq!(bindings(&state)[0].1.as_deref(), Some("control-0-2-1"), "undo left the binding at the new cell");
    assert!(state.controls.read().unwrap().contains_key(&(0, 2, 1)), "undo put the button back");
}

/// THE DELETE-A-MACRO SCAN names BUTTON CELLS too -- a live action that runs the
/// macro, and a working copy's HELD one, which the next push publishes.
///
/// SABOTAGE: drop the cell-type loop from `controls_referencing_macro`.
#[test]
fn the_delete_a_macro_scan_names_button_cells_too() {
    let state = crate::create_app_state();
    {
        let mut cells = state.cell_types.write(&test_seed_effect()).unwrap();
        let assignment = |params: serde_json::Value| crate::cell_types::CellTypeAssignment {
            type_id: crate::button_cells::BUTTON_CELL_TYPE_ID.to_string(),
            params,
        };
        cells.insert((0, 1, 1), assignment(serde_json::json!({ "action": { "kind": "script", "scriptId": "macro-report" } })));
        cells.insert((0, 2, 2), assignment(serde_json::json!({
            "heldAction": { "kind": "script", "scriptId": "macro-report", "functionName": "Go" },
            "fromApplication": { "workspace": "ws", "application": "sales", "version": "1.0.0" }
        })));
        cells.insert((0, 3, 3), assignment(serde_json::json!({ "action": { "kind": "command", "commandId": "macro-report" } })));
        cells.insert((0, 4, 4), crate::cell_types::CellTypeAssignment {
            type_id: "calcula.checkbox".to_string(),
            params: serde_json::json!({ "action": { "kind": "script", "scriptId": "macro-report" } }),
        });
    }
    let found = crate::controls::controls_referencing_macro(&state, "macro-report");
    let got: Vec<((u32, u32), Option<&str>)> = found.iter().map(|c| ((c.row, c.col), c.held_by.as_deref())).collect();
    assert_eq!(got, vec![((1, 1), None), ((2, 2), Some("sales"))], "{found:?}");
    assert!(crate::controls::controls_referencing_macro(&state, "macro-other").is_empty());
}

/// THE APPROVAL SCREEN'S "Buttons that run this macro" (phase 3) reads the same
/// scan: each row says what kind of button it is, what it says on screen, and
/// which application it CAME WITH -- from this machine's stamp: a held control
/// link names its `heldFrom`, a stamped button cell its `fromApplication`
/// (live or held), and the author's own live link names none.
///
/// SABOTAGE: set `application: None` for the held control link in
/// `controls_referencing_macro`.
#[test]
fn list_controls_referencing_macro_reports_kind_caption_and_application() {
    let state = seeded(held_button());
    {
        let mut controls = state.controls.write(&test_seed_effect()).unwrap();
        let mut own = HashMap::new();
        own.insert("text".to_string(), prop("Mine"));
        own.insert(MACRO_REF_PROPERTY.to_string(), prop("macro-report"));
        controls.insert((0, 7, 7), ControlMetadata { control_type: "button".into(), properties: own });
        let mut cells = state.cell_types.write(&test_seed_effect()).unwrap();
        cells.insert((0, 4, 4), crate::cell_types::CellTypeAssignment {
            type_id: crate::button_cells::BUTTON_CELL_TYPE_ID.to_string(),
            params: serde_json::json!({
                "label": "Landed",
                "action": { "kind": "script", "scriptId": "macro-report" },
                "fromApplication": { "workspace": "ws", "application": "sales", "version": "1.2.0" }
            }),
        });
    }
    let found = crate::controls::controls_referencing_macro(&state, "macro-report");
    let got: Vec<((u32, u32), MacroLinkKind, &str, Option<&str>)> = found
        .iter()
        .map(|c| ((c.row, c.col), c.kind, c.caption.as_str(), c.application.as_deref()))
        .collect();
    assert_eq!(
        got,
        vec![
            ((2, 1), MacroLinkKind::Control, "Go", Some("sales")),
            ((4, 4), MacroLinkKind::Cell, "Landed", Some("sales")),
            ((7, 7), MacroLinkKind::Control, "Mine", None),
        ],
        "{found:?}"
    );
    // The wire carries them camelCased.
    let json = serde_json::to_value(&found[1]).unwrap();
    assert_eq!((json["kind"].as_str(), json["caption"].as_str(), json["application"].as_str()), (Some("cell"), Some("Landed"), Some("sales")));
}

/// LOCK ORDER. The scan reads the sheet names FIRST and releases them before it
/// takes any object store: `delete_sheet_impl` holds `sheet_names.write` while
/// it takes `controls.write` (`remap_sheet_keyed_stores`), so the scan's old
/// controls-then-sheet-names order could deadlock a delete-a-macro warning
/// against a sheet delete.
///
/// SABOTAGE: swap the two reads at the top of `controls_referencing_macro`.
#[test]
fn the_delete_a_macro_scan_takes_sheet_names_before_controls() {
    let controls = source("src/controls.rs");
    let body = body_of(&controls, "pub(crate) fn controls_referencing_macro(");
    let names = body.find("state.sheet_names.read()").expect("the sheet-name read moved");
    let store = body.find("state.controls.read()").expect("the controls read moved");
    assert!(names < store, "controls are locked before the sheet names (the reverse of the canonical order)");
    let names_stmt = &body[names..];
    assert!(
        names_stmt[..names_stmt.find(';').unwrap()].contains(".clone()"),
        "the sheet names are held across the store reads instead of cloned out"
    );
}

/// EVERY REFUSAL OF APPLICATION CODE IS AUDITED. A push refused over held code
/// the signed base does not carry -- a forged working copy -- leaves an
/// always-on `ButtonCodeRefused` row (auditing is OFF by default) naming the
/// application and the cell; so does a push refused for unacknowledged code.
///
/// SABOTAGE: drop the `record_push_refusal(` calls from
/// `refuse_push_on_button_code`.
#[test]
fn a_refused_push_leaves_a_button_code_refused_row_even_with_auditing_off() {
    let wc = check_out();
    wc.stores
        .state
        .controls
        .write(&test_seed_effect())
        .unwrap()
        .get_mut(&(wc.sheet, 1, 1))
        .unwrap()
        .properties
        .insert(HELD_ON_SELECT_PROPERTY.to_string(), prop("Exfiltrate();"));
    let (_, release) = wc.release();
    assert!(!wc.stores.state.audit_log.read().unwrap().enabled, "precondition: auditing is off");
    let err = refuse_push_on_button_code(&wc.stores.state, &release, &[], &location(&wc.dir), PKG)
        .expect_err("a forged working copy is refused");
    assert!(err.contains("CALP_PUSH_HELD_CODE_UNVERIFIED"), "{err}");

    // The author's own new code, not acknowledged.
    crate::controls::set_control_property_core(
        &wc.stores.state, &FileState::default(), wc.sheet, 3, 3, "".into(),
        ON_SELECT_PROPERTY.into(), "static".into(), "Mine();".into(),
    )
    .unwrap();
    wc.stores
        .state
        .controls
        .write(&test_seed_effect())
        .unwrap()
        .get_mut(&(wc.sheet, 1, 1))
        .unwrap()
        .properties
        .insert(HELD_ON_SELECT_PROPERTY.to_string(), prop("Report();"));
    let (_, release) = wc.release();
    assert!(release.refusal().is_none(), "{:?}", release.refused);
    let err = refuse_push_on_button_code(&wc.stores.state, &release, &[], &location(&wc.dir), PKG)
        .expect_err("unacknowledged code is refused");
    assert!(err.contains("CALP_PUSH_BUTTON_CODE_UNREVIEWED"), "{err}");
    // ...and an acknowledged push passes, recording nothing more.
    let acked: Vec<String> = release.unreviewed.iter().map(|i| i.hash.clone()).collect();
    refuse_push_on_button_code(&wc.stores.state, &release, &acked, &location(&wc.dir), PKG).expect("acknowledged");

    let log = wc.stores.state.audit_log.read().unwrap();
    let rows: Vec<&calp::audit::AuditEntry> = log
        .entries
        .iter()
        .filter(|e| matches!(e.event, calp::audit::AuditEvent::ButtonCodeRefused))
        .collect();
    assert_eq!(rows.len(), 2, "{:?}", log.entries);
    assert_eq!(rows[0].extra["door"], "push");
    assert_eq!(rows[0].extra["application"], PKG);
    assert_eq!(rows[0].extra["reason"], "heldCodeUnverified");
    assert_eq!(rows[0].extra["baseVersion"], "1.0.0");
    assert_eq!(rows[0].extra["cells"][0]["cell"], "Dashboard!B2");
    assert_eq!(rows[1].extra["reason"], "unreviewed");
    assert_eq!(rows[1].extra["cells"][0]["cell"], "Dashboard!D4");
}

/// CHECKOUT REPORTS HOW MANY values over 64 KiB it cleared (BUG-0263): a
/// button whose caption is 70,000 characters arrives with the caption cleared
/// on every door, and the checkout's response counts it.
///
/// SABOTAGE: set `oversized_values_cleared = 0` instead of `admitted.oversized`
/// in `materialize_pull_result`.
#[test]
fn a_checkout_reports_how_many_oversized_values_it_cleared() {
    let dir = TempDir::new().unwrap();
    let alice = TempDir::new().unwrap();
    let reg = LocalWorkspace::open(dir.path()).unwrap();
    let mut app = dashboard();
    app.controls[0].controls[2]["properties"]["text"] =
        serde_json::json!({ "valueType": "static", "value": "x".repeat(70_000) });
    publish_version(&reg, alice.path(), &app, SemVer::new(1, 0, 0), PushMode::CreateNew);
    let scope = calp::workspace_scope(&location(&dir)).unwrap();

    let checked_out = calp::checkout::checkout(&reg, PKG, Some(SemVer::new(1, 0, 0)), "2026-09-30T01:00:00Z", &scope, alice.path())
        .expect("checkout");
    let developer = Stores::new();
    let response = developer.materialize(checked_out.pulled, MaterializeMode::Checkout);
    assert_eq!(response.oversized_values_cleared, 1, "the checkout did not count the value it cleared");
    let sheet = developer.sheet_index_of(app.sheets[0].id);
    assert_eq!(developer.control(sheet, 3, 3).properties["text"].value, "", "the oversized value arrived");

    let bob = TempDir::new().unwrap();
    let pulled = calp::pull::pull(
        &reg,
        &calp::pull::PullRequest {
            package_name: PKG.to_string(),
            target: calp::manifest::SubscriptionTarget::Line(calp::version::VersionPin::Latest),
            now: "2026-09-30T02:00:00Z".to_string(),
        },
        &scope,
        bob.path(),
        calp::integrity::PinPolicy::PinOnFirstUse,
    )
    .expect("subscribe");
    let subscriber = Stores::new();
    subscriber.materialize(pulled, MaterializeMode::Subscribe);
    // A subscriber's sheets carry fresh local ids: found by name.
    let sheet = subscriber.state.sheet_names.read().unwrap().iter().position(|n| n == "Dashboard").expect("the sheet");
    assert_eq!(subscriber.control(sheet, 3, 3).properties["text"].value, "", "a subscriber received it");
}

// ============================================================================
// 7. M6: the reserved `buttonAction:` prefix (S5)
// ============================================================================

/// What a planted reserved id looks like: the approval id of some button code.
fn reserved_id() -> String {
    format!("{}{}", crate::scripting::control_action::BUTTON_ACTION_CONSENT_PREFIX, "0".repeat(64))
}

/// Plant `id` into a pull as the given kind of code an approval can name.
fn plant(pulled: &mut calp::pull::PullResult, kind: &str, id: &str) {
    match kind {
        "object script" => pulled.object_scripts.push(persistence::SavedObjectScript {
            id: id.to_string(),
            name: "planted".to_string(),
            object_type: persistence::ScriptableObjectType::Workbook,
            instance_id: None,
            source: "function setup(context) {}".to_string(),
            access_level: persistence::ScriptAccessLevel::Restricted,
            description: None,
            provenance: persistence::ScriptProvenance::Distributed,
            package_name: Some(PKG.to_string()),
            package_version: Some("1.0.0".to_string()),
            declared_capabilities: Vec::new(),
        }),
        "module" => {
            let mut module = macro_module(id, "Calcula.log('planted');");
            module.source_package = Some(PKG.to_string());
            pulled.module_scripts.push(module);
        }
        "notebook" => pulled.notebooks.push(persistence::SavedNotebook {
            id: id.to_string(),
            name: "planted".to_string(),
            cells: Vec::new(),
            source_package: Some(PKG.to_string()),
        }),
        other => panic!("unknown kind {other}"),
    }
}

fn assert_reserved_refusal(kind: &str, door: &str, err: &str) {
    assert!(err.starts_with("CALP_RESERVED_SCRIPT_ID"), "{kind} at {door}: {err}");
    assert!(err.contains("'buttonAction:'") && err.contains(&reserved_id()[..20]), "{kind} at {door}: {err}");
    assert!(err.contains("approvals of button code") && err.contains("Nothing was imported"), "{kind} at {door}: {err}");
}

/// The approval of inline button code is recorded under `buttonAction:<hash>`
/// in the application's bare record, where the first claim on an id wins. An
/// application's object script, module or notebook carrying such an id could
/// block that approval or be approved under a button-code label, so every
/// door refuses the whole application.
///
/// SABOTAGE (S5 c): reserve the prefix for modules only (drop the notebook and
/// object-script chains) -- the object-script and notebook rows go red.
#[test]
fn an_application_object_script_module_or_notebook_with_a_button_action_id_is_refused_at_subscribe_checkout_and_refresh() {
    let dir = TempDir::new().unwrap();
    let alice = TempDir::new().unwrap();
    let reg = LocalWorkspace::open(dir.path()).unwrap();
    publish_version(&reg, alice.path(), &dashboard_shipping_its_macro(), SemVer::new(1, 0, 0), PushMode::CreateNew);
    let id = reserved_id();
    for kind in ["object script", "module", "notebook"] {
        for (door, mode) in [("subscribe", MaterializeMode::Subscribe), ("checkout", MaterializeMode::Checkout)] {
            let mut pulled = subscribe_pull(&dir, "1.0.0");
            plant(&mut pulled, kind, &id);
            let stores = Stores::new();
            let refused = materialize_pull_result(
                &stores.state,
                &crate::document_effect::DocumentEffect::mutates(&FileState::default()),
                &stores.pivot,
                &stores.bi,
                &stores.scripts,
                &stores.ribbon,
                &stores.pane,
                &stores.slicer,
                &stores.timeline,
                pulled,
                mode,
                None,
            );
            let err = match refused {
                Err(err) => err,
                Ok(_) => panic!("a {kind} claiming {id} was admitted at the {door}"),
            };
            assert_reserved_refusal(kind, door, &err);
            assert!(stores.state.controls.read().unwrap().is_empty(), "{kind} at {door}: something landed");
            assert!(stores.scripts.workbook_scripts.read().unwrap().is_empty(), "{kind} at {door}: a module landed");
        }
        // A refresh: the pre-effect pass refuses it.
        let subscriber = Stores::new();
        subscriber.materialize(subscribe_pull(&dir, "1.0.0"), MaterializeMode::Subscribe);
        let mut pulled = subscribe_pull(&dir, "1.0.0");
        plant(&mut pulled, kind, &id);
        let mut payloads = vec![calp::refresh::RefreshPayload { subscription_index: 0, pull_result: pulled }];
        let err = crate::calp_commands::prepare_refresh_payloads(&subscriber.state, &mut payloads)
            .map(|_| ())
            .expect_err("a refresh admitted a reserved id");
        assert_reserved_refusal(kind, "refresh", &err);
    }
    // An id merely CONTAINING the prefix later on is not refused: it is a prefix test.
    let mut pulled = subscribe_pull(&dir, "1.0.0");
    plant(&mut pulled, "object script", &format!("my-{id}"));
    Stores::new().materialize(pulled, MaterializeMode::Subscribe);
}

/// Every door refuses the reserved ids of ALL three kinds before its effect --
/// the doors' own calls, not only the inner one, carry the object scripts.
#[test]
fn every_door_refuses_reserved_ids_of_object_scripts_before_its_effect() {
    let cmds = source("src/calp_commands.rs");
    for (door, carried) in [
        ("pub fn calp_pull(", "&result.object_scripts,"),
        ("pub fn calp_checkout(", "&result.object_scripts,"),
        ("pub(crate) fn prepare_refresh_payloads(", "&payload.pull_result.object_scripts,"),
        ("pub(crate) fn materialize_pull_result(", "&result.object_scripts,"),
    ] {
        let body = body_of(&cmds, door);
        let at = body.find("refuse_reserved_distributed_script_ids(").unwrap_or_else(|| panic!("{door} no longer refuses reserved ids"));
        let call = &body[at..at + body[at..].find(")?;").expect("the call")];
        assert!(call.contains(carried), "{door} does not refuse its object scripts' reserved ids: {call}");
        if let Some(effect) = body.find("DocumentEffect::mutates(") {
            assert!(at < effect, "{door} refuses after its effect");
        }
    }
    let gate = body_of(&cmds, "fn refuse_reserved_distributed_script_ids(");
    assert!(gate.contains("BUTTON_ACTION_CONSENT_PREFIX"), "the prefix is re-typed instead of read from its one spelling");
}

// ============================================================================
// 8. M6: "Make this my own" (S6)
// ============================================================================

/// The workbook's stored modules as `(application, id)`: the application's
/// `macro-report`, the macro the held button links.
fn modules() -> Vec<(Option<String>, String)> {
    vec![(Some("sales".to_string()), "macro-report".to_string())]
}

/// The held button at Sheet1!B3 (`seeded`), adopted as the dialog showed it.
fn adopt(
    state: &crate::AppState,
    file: &FileState,
    shown_on_select: Option<&str>,
    shown_macro_ref: Option<&str>,
) -> Result<ControlMetadata, String> {
    crate::controls::adopt_held_button_code_core(state, file, &modules(), 0, (2, 1), shown_on_select, shown_macro_ref)
}

fn snapshot(state: &crate::AppState) -> serde_json::Value {
    serde_json::to_value(&state.controls.read().unwrap()[&(0, 2, 1)]).unwrap()
}

fn adopted_rows(state: &crate::AppState) -> Vec<calp::audit::AuditEntry> {
    state
        .audit_log
        .read()
        .unwrap()
        .entries
        .iter()
        .filter(|e| matches!(e.event, calp::audit::AuditEvent::ButtonCodeAdopted))
        .cloned()
        .collect()
}

/// SABOTAGE (S6 a): copy instead of move (leave the held keys in place).
#[test]
fn adopting_moves_both_slots_live_with_their_types_and_drops_the_stamp() {
    let mut button = held_button();
    // The package typed the link as a formula: the stamp kept that type.
    let typed = HeldFrom {
        value_types: [(MACRO_REF_PROPERTY.to_string(), "formula".to_string())].into_iter().collect(),
        ..stamp()
    };
    button.properties.insert(HELD_FROM_PROPERTY.to_string(), prop(&typed.encode()));
    let state = seeded(button);
    let file = FileState::default();
    let adopted = adopt(&state, &file, Some("Report();"), Some("macro-report")).expect("adopted");
    let meta = state.controls.read().unwrap()[&(0, 2, 1)].clone();
    assert_eq!(slot(&meta, ON_SELECT_PROPERTY), ("static", "Report();"));
    assert_eq!(slot(&meta, MACRO_REF_PROPERTY), ("formula", "macro-report"), "the type the stamp kept");
    for key in HELD_CONTROL_PROPERTIES {
        assert!(!meta.properties.contains_key(*key), "'{key}' was left behind: a copy, not a move");
    }
    assert_eq!(slot(&meta, "text"), ("static", "Go"), "the rest of the button is untouched");
    assert_eq!(serde_json::to_value(&adopted).unwrap(), serde_json::to_value(&meta).unwrap());
    assert!(file.is_dirty(), "control metadata is persisted");
}

#[test]
fn one_ctrl_z_brings_the_held_code_back() {
    let state = seeded(held_button());
    let before = snapshot(&state);
    let depth = undo_depth(&state);
    adopt(&state, &FileState::default(), Some("Report();"), Some("macro-report")).expect("adopted");
    assert_eq!(undo_depth(&state), depth + 1, "one undo step");
    undo_once(&state);
    assert_eq!(snapshot(&state), before, "Ctrl+Z puts the application's code back in the held compartment");
}

/// THE TOCTOU the shown texts close: the code changed after the dialog showed
/// it (another window, a refresh), so what would be adopted is not what the
/// user said yes to.
///
/// SABOTAGE (S6 b): skip the shown-text compare.
/// SABOTAGE (S6 c): construct the effect before the gates -- `FileState` is
/// then dirty after a refusal.
#[test]
fn adopting_refuses_when_the_code_is_not_what_was_shown() {
    let state = seeded(held_button());
    let file = FileState::default();
    let before = snapshot(&state);
    for (on_select, macro_ref) in [
        (Some("Report(); "), Some("macro-report")),
        (Some("Report();"), None),
        (None, Some("macro-report")),
        (Some("Report();"), Some("macro-other")),
    ] {
        let err = adopt(&state, &file, on_select, macro_ref).expect_err("adopted what was not shown");
        assert!(err.contains("changed after it was shown") && err.contains("Sheet1!B3"), "{err}");
    }
    assert_eq!(snapshot(&state), before, "a refusal changes nothing");
    assert!(!file.is_dirty(), "a refusal dirtied the document");
    assert!(adopted_rows(&state).is_empty());
}

#[test]
fn adopting_refuses_when_nothing_is_held() {
    let mut own = held_button();
    for key in HELD_CONTROL_PROPERTIES {
        own.properties.remove(*key);
    }
    let state = seeded(own);
    let file = FileState::default();
    let err = adopt(&state, &file, Some("Report();"), None).expect_err("nothing to adopt");
    assert!(err.contains("holds no code that came with an application"), "{err}");
    let err = crate::controls::adopt_held_button_code_core(&state, &file, &modules(), 0, (9, 9), None, None)
        .expect_err("no control");
    assert!(err.contains("There is no control"), "{err}");
    assert!(!file.is_dirty());
}

/// Owner decision Q4: "Make this my own" is for button CONTROLS. The admission
/// holds ANY control's code (a faithful push), but a shape's held code is not
/// moved into its live slot, and its stamp stays.
///
/// SABOTAGE: drop the control-type check from `adopt_held_button_code_core`.
#[test]
fn adopting_refuses_a_control_that_is_not_a_button() {
    let mut shape = held_button();
    shape.control_type = "shape".into();
    let state = seeded(shape);
    let file = FileState::default();
    let before = snapshot(&state);
    let err = adopt(&state, &file, Some("Report();"), Some("macro-report")).expect_err("a shape's code was adopted");
    assert!(err.contains("Sheet1!B3") && err.contains("'shape'") && err.contains("not a button"), "{err}");
    assert_eq!(snapshot(&state), before, "a refusal changed the shape");
    assert!(!file.is_dirty(), "a refusal dirtied the document");
    assert!(adopted_rows(&state).is_empty(), "a refusal wrote an adoption row");
}

#[test]
fn adopting_refuses_when_live_code_exists() {
    let mut both = held_button();
    both.properties.insert(ON_SELECT_PROPERTY.to_string(), prop("Mine();"));
    let state = seeded(both);
    let file = FileState::default();
    let before = snapshot(&state);
    let err = adopt(&state, &file, Some("Report();"), Some("macro-report")).expect_err("over live code");
    assert!(err.contains("already runs code of your own"), "{err}");
    assert_eq!(snapshot(&state), before);
    assert!(!file.is_dirty());
}

/// A HELD LINK STAYS THE APPLICATION'S MACRO (review of M6b). Adopted, a link is
/// live, and a live link runs whatever module carries its id with no
/// application asked for -- and at a checkout EVERY link is held, ids the
/// application never shipped included. So a held link is adopted only when it
/// names a macro of the STAMP'S application in this workbook; otherwise the
/// confirm's promise ("the macro it runs stays the application's, and still
/// runs only after you approve the application's code") would be false, and
/// the developer's own macro of that id would run with no approval.
///
/// SABOTAGE: drop the `held_link_refusal` gate from
/// `adopt_held_button_code_core` -> each case below is adopted.
#[test]
fn adopting_a_held_link_refuses_one_that_does_not_name_the_applications_macro() {
    for (modules, why) in [
        (Vec::new(), "no macro of the application 'sales' with that id is in this workbook"),
        (vec![(None, "macro-report".to_string())], "which is a macro of your own"),
        (vec![(Some("other".to_string()), "macro-report".to_string())], "which came with the application 'other'"),
    ] {
        let state = seeded(held_button());
        let file = FileState::default();
        let before = snapshot(&state);
        let err = crate::controls::adopt_held_button_code_core(
            &state,
            &file,
            &modules,
            0,
            (2, 1),
            Some("Report();"),
            Some("macro-report"),
        )
        .expect_err("a link to a macro that is not the application's was adopted");
        assert!(err.contains("Sheet1!B3") && err.contains("'macro-report'") && err.contains(why), "{err}");
        assert!(err.contains("with no approval") && err.contains("nothing was changed"), "{err}");
        assert_eq!(snapshot(&state), before, "a refusal changed the button");
        assert!(!file.is_dirty(), "a refusal dirtied the document");
        assert!(adopted_rows(&state).is_empty(), "a refusal wrote an adoption row");
    }
    // A stamp that cannot be read vouches for no application.
    let mut unreadable = held_button();
    unreadable.properties.insert(HELD_FROM_PROPERTY.to_string(), prop("not a stamp"));
    let state = seeded(unreadable);
    let err = adopt(&state, &FileState::default(), Some("Report();"), Some("macro-report")).expect_err("unreadable stamp");
    assert!(err.contains("cannot be read"), "{err}");
    // CONTROL: a button holding only inline code needs no macro of anyone's.
    let mut inline_only = held_button();
    inline_only.properties.remove(HELD_MACRO_REF_PROPERTY);
    let state = seeded(inline_only);
    crate::controls::adopt_held_button_code_core(&state, &FileState::default(), &[], 0, (2, 1), Some("Report();"), None)
        .expect("inline code is adopted with no macro in the workbook");
}

/// SABOTAGE (S6 d): drop `ButtonCodeAdopted` from `is_always_recorded`.
#[test]
fn the_adoption_is_audited_with_auditing_off() {
    let state = seeded(held_button());
    assert!(!state.audit_log.read().unwrap().enabled, "precondition: auditing is off");
    adopt(&state, &FileState::default(), Some("Report();"), Some("macro-report")).expect("adopted");
    let rows = adopted_rows(&state);
    assert_eq!(rows.len(), 1, "the adoption left no trail");
    let row = &rows[0];
    assert_eq!(serde_json::to_string(&row.event).unwrap(), "\"button_code_adopted\"");
    assert_eq!(row.extra["application"], "sales");
    assert_eq!(row.extra["version"], "1.2.0");
    assert_eq!(row.extra["cell"], "Sheet1!B3");
    assert_eq!(row.extra["caption"], "Go");
    assert_eq!(row.extra["moved"][0]["slot"], ON_SELECT_PROPERTY);
    assert_eq!(row.extra["moved"][0]["sha256"], calp::integrity::sha256_hex(b"Report();"));
    assert_eq!(row.extra["moved"][1]["slot"], MACRO_REF_PROPERTY);
    assert!(row.description.contains("Sheet1!B3") && row.description.contains("'sales'"), "{}", row.description);
}

/// After adoption the code is the user's own: the button door plans it with no
/// approval and writes no application row. Before it, the same click is
/// refused until approved.
#[test]
fn after_adoption_the_door_plans_it_as_the_users_own_code() {
    let mut inline_only = held_button();
    inline_only.properties.remove(HELD_MACRO_REF_PROPERTY);
    let state = seeded(inline_only);
    let scripts = crate::scripting::types::ScriptState::new();
    *scripts.security_level.lock().unwrap() = "enabled".to_string();
    let files = crate::persistence::UserFilesState::default();
    let click = || {
        crate::scripting::control_action::run_control_action_core(
            &state,
            &scripts,
            &files,
            &crate::scripting::types::RunControlActionRequest {
                kind: crate::scripting::types::ControlActionKind::Control,
                sheet_index: 0,
                row: 2,
                col: 1,
                view_state: None,
            },
        )
        .expect("answered")
    };
    match click() {
        crate::scripting::control_action::DoorAnswer::Answer(crate::scripting::types::ControlActionOutcome::Refused {
            reason,
            ..
        }) => assert_eq!(reason, "notConsented"),
        other => panic!("held code ran unapproved: {other:?}"),
    }
    adopt(&state, &FileState::default(), Some("Report();"), None).expect("adopted");
    let before = state.audit_log.read().unwrap().entries.len();
    match click() {
        crate::scripting::control_action::DoorAnswer::Run(run) => assert_eq!(run.source, "Report();"),
        other => panic!("the user's own code did not run: {other:?}"),
    }
    let after: Vec<calp::audit::AuditEntry> = state.audit_log.read().unwrap().entries[before..].to_vec();
    assert!(
        after.iter().all(|e| !matches!(
            e.event,
            calp::audit::AuditEvent::ApplicationCodeRun | calp::audit::AuditEvent::ApplicationCodeRefused
        )),
        "the user's own code wrote an application row: {after:?}"
    );
}

// ============================================================================
// 9. M6: admission HOLDS an application's static inline code (S7)
// ============================================================================

/// `wb` (a `dashboard()`, or a later version of the same one -- the SAME sheet
/// id, so a refresh updates the sheet rather than replacing it) with B2's
/// inline action replaced.
fn with_inline(wb: &Workbook, value_type: &str, code: &str) -> Workbook {
    let mut wb = wb.clone();
    wb.controls[0].controls[0]["properties"]["onSelect"] = serde_json::json!({ "valueType": value_type, "value": code });
    wb
}

/// THE SUBSCRIBER'S SIDE OF PHASE 4. Inline code travels: B2's `onSelect`
/// arrives HELD and stamped -- never live -- and runs only through the button
/// door after the approval screen has shown those exact bytes.
///
/// SABOTAGE (S7 a): put `LinkLanded`'s `onSelect` arm back to `None` (the
/// phase-3 strip).
#[test]
fn a_subscriber_holds_inline_code_stamped_and_nothing_live() {
    let dir = TempDir::new().unwrap();
    let alice = TempDir::new().unwrap();
    let reg = LocalWorkspace::open(dir.path()).unwrap();
    publish_version(&reg, alice.path(), &dashboard(), SemVer::new(1, 0, 0), PushMode::CreateNew);
    let subscriber = Stores::new();
    subscriber.state.audit_log.write(&test_seed_effect()).unwrap().enabled = true;
    let response = subscriber.materialize(subscribe_pull(&dir, "1.0.0"), MaterializeMode::Subscribe);
    let sheet = subscriber.dashboard_index();

    let b2 = subscriber.control(sheet, 1, 1);
    assert!(!b2.properties.contains_key(ON_SELECT_PROPERTY), "inline code arrived LIVE: {b2:?}");
    assert_eq!(slot(&b2, HELD_ON_SELECT_PROPERTY), ("static", "Report();"), "the published bytes, held");
    let from = HeldFrom::decode(&b2.properties[HELD_FROM_PROPERTY].value).expect("stamped");
    assert_eq!(from.application, PKG);
    assert_eq!(from.version, "1.0.0");
    assert_eq!(from.workspace, calp::workspace_scope(&location(&dir)).unwrap().id);
    assert!(from.value_types.is_empty(), "static code needs no type in the stamp");
    assert_eq!(response.inline_button_code_held, 1);
    assert!(response.inline_button_code_removed.is_empty(), "{:?}", response.inline_button_code_removed);
    assert_eq!(response.button_code_held, 0, "button_code_held is a checkout's count");
    // The recipe's EMPTY onSelect is not code: it stays live and empty, unstamped.
    let d4 = subscriber.control(sheet, 3, 3);
    assert_eq!(slot(&d4, ON_SELECT_PROPERTY), ("static", ""));
    assert!(!d4.properties.contains_key(HELD_FROM_PROPERTY));
    // The subscribe's audit row counts it.
    let log = subscriber.state.audit_log.read().unwrap();
    let row = log.entries.iter().find(|e| matches!(e.event, calp::audit::AuditEvent::Subscribe)).expect("the row");
    assert!(row.description.contains("1 inline button action(s) held for approval and 0 removed"), "{}", row.description);
}

/// A REFRESH re-holds changed inline code under the NEW version: changed code
/// is new code, approved by its own hash.
///
/// SABOTAGE (S7 c): pass `DistributedWiring::Strip` on the refresh door.
#[test]
fn a_refresh_re_holds_changed_inline_code_under_the_new_version() {
    let dir = TempDir::new().unwrap();
    let alice = TempDir::new().unwrap();
    let reg = LocalWorkspace::open(dir.path()).unwrap();
    let v1 = dashboard();
    publish_version(&reg, alice.path(), &v1, SemVer::new(1, 0, 0), PushMode::CreateNew);
    let subscriber = Stores::new();
    subscriber.materialize(subscribe_pull(&dir, "1.0.0"), MaterializeMode::Subscribe);
    let v2 = with_inline(&v1, "static", "Report2();");
    publish_version(&reg, alice.path(), &v2, SemVer::new(1, 1, 0), PushMode::Update { expected_base: SemVer::new(1, 0, 0) });
    subscriber.state.audit_log.write(&test_seed_effect()).unwrap().enabled = true;
    let result = subscriber.refresh(subscribe_pull(&dir, "1.1.0"));
    let b2 = subscriber.control(subscriber.dashboard_index(), 1, 1);
    assert!(!b2.properties.contains_key(ON_SELECT_PROPERTY), "a refresh landed inline code LIVE");
    assert_eq!(slot(&b2, HELD_ON_SELECT_PROPERTY), ("static", "Report2();"), "the refresh lost the inline code");
    let from = HeldFrom::decode(&b2.properties[HELD_FROM_PROPERTY].value).expect("stamped");
    assert_eq!(from.version, "1.1.0", "the stamp names the version the code came with");
    assert!(result.inline_button_code_removed.is_empty());
    let refreshed = subscriber
        .state
        .audit_log
        .read()
        .unwrap()
        .entries
        .iter()
        .find(|e| matches!(e.event, calp::audit::AuditEvent::Refresh))
        .map(|e| e.description.clone())
        .expect("the refresh row");
    assert!(refreshed.contains("0 inline button action(s) removed"), "{refreshed}");
}

/// Only STATIC code is approvable (an approval is of exact bytes that run as
/// themselves): a formula-typed inline action is removed at a subscribe and at
/// a refresh, and named -- never held, never live.
///
/// SABOTAGE (S7 b): hold formula-typed code too (drop the `value_type ==
/// "static"` test).
#[test]
fn a_formula_typed_inline_action_is_removed_and_named() {
    let dir = TempDir::new().unwrap();
    let alice = TempDir::new().unwrap();
    let reg = LocalWorkspace::open(dir.path()).unwrap();
    let v1 = with_inline(&dashboard(), "formula", "=A1");
    publish_version(&reg, alice.path(), &v1, SemVer::new(1, 0, 0), PushMode::CreateNew);
    let subscriber = Stores::new();
    subscriber.state.audit_log.write(&test_seed_effect()).unwrap().enabled = true;
    let response = subscriber.materialize(subscribe_pull(&dir, "1.0.0"), MaterializeMode::Subscribe);
    let sheet = subscriber.dashboard_index();
    let b2 = subscriber.control(sheet, 1, 1);
    for key in [ON_SELECT_PROPERTY, HELD_ON_SELECT_PROPERTY, HELD_FROM_PROPERTY] {
        assert!(!b2.properties.contains_key(key), "'{key}' survived: {b2:?}");
    }
    assert_eq!(response.inline_button_code_held, 0);
    assert_eq!(
        response.inline_button_code_removed,
        vec!["Dashboard!B2: its action is a formula, which Calcula does not run as button code; it was removed".to_string()]
    );
    let row = subscriber
        .state
        .audit_log
        .read()
        .unwrap()
        .entries
        .iter()
        .find(|e| matches!(e.event, calp::audit::AuditEvent::Subscribe))
        .map(|e| e.description.clone())
        .expect("the row");
    assert!(row.contains("0 inline button action(s) held for approval and 1 removed"), "{row}");
    // ...and at a refresh.
    publish_version(
        &reg,
        alice.path(),
        &with_inline(&v1, "formula", "=B1"),
        SemVer::new(1, 1, 0),
        PushMode::Update { expected_base: SemVer::new(1, 0, 0) },
    );
    let result = subscriber.refresh(subscribe_pull(&dir, "1.1.0"));
    assert_eq!(result.inline_button_code_removed.len(), 1, "{:?}", result.inline_button_code_removed);
    assert!(result.inline_button_code_removed[0].starts_with("Dashboard!B2: its action is a formula"));
    assert!(!subscriber.control(sheet, 1, 1).properties.contains_key(HELD_ON_SELECT_PROPERTY));
}

/// A dev pull brings no signed application an approval could name, so it
/// still STRIPS inline code (and every link).
#[test]
fn the_dev_pull_still_strips_inline_code() {
    let app = dashboard_shipping_its_macro();
    let (admitted, report) = admit_wiring(&app.controls, &DistributedWiring::Strip);
    let entries = admitted[0].controls.as_array().unwrap();
    let props = |i: usize| entries[i]["properties"].as_object().unwrap().clone();
    for key in [ON_SELECT_PROPERTY, HELD_ON_SELECT_PROPERTY, HELD_FROM_PROPERTY] {
        assert!(!props(0).contains_key(key), "B2 kept '{key}'");
    }
    assert!(!props(1).contains_key(HELD_MACRO_REF_PROPERTY) && !props(1).contains_key(MACRO_REF_PROPERTY));
    assert_eq!((report.held, report.inline_held, report.stripped), (0, 0, 2));
}

/// THE ORDERING HAZARD, pinned. Holding inline code at a subscriber is safe
/// ONLY while the button door exists to run it after its approval, and the
/// backstop stops `run_script` (which runs any source no stored module
/// carries, as the user's own) and the mount floor from running the landed
/// bytes. Holding without them would make every subscriber's workbook carry
/// code any page could run unapproved.
///
/// SABOTAGE (S7 d): remove the `run_control_action` registration from lib.rs.
#[test]
fn a_subscriber_holds_inline_code_only_while_the_door_and_the_backstop_exist() {
    let held = source("src/held_button_code.rs");
    let admit = body_of(&held, "pub fn admit_wiring(");
    let landed = &admit[admit.find("DistributedWiring::LinkLanded {").expect("the subscribe arm")..];
    assert!(
        landed.contains("if *key == ON_SELECT_PROPERTY {"),
        "precondition: a subscribe holds inline code (phase 4)"
    );
    let lib = source("src/lib.rs");
    assert!(
        lib.contains("scripting::control_action::run_control_action,"),
        "a subscriber holds inline code, but there is no door to run it through"
    );
    let gate = source("src/scripting/application_code_gate.rs");
    for door in ["pub(crate) fn distributed_run_gate(", "pub(crate) fn mount_run_gate("] {
        assert!(
            body_of(&gate, door).contains("refuse_held_code_outside_its_button("),
            "{door} lets held code run as ad hoc"
        );
    }
    assert!(body_of(&gate, "fn refuse_held_code_outside_its_button(").contains("held_code_outside_its_button("));
    // The third route that runs an unnamed source as the user's own: a cell of
    // the user's own notebook (or of no stored notebook). Its backstop sits
    // where that cell is let through -- before the consent file is read.
    let notebooks = source("src/scripting/notebook_commands.rs");
    let gate = body_of(&notebooks, "fn require_distributed_notebook_consent(");
    let backstop = gate
        .find("own_notebook_cell_backstop(")
        .expect("a cell of the user's own notebook lets held code run as ad hoc");
    let consent = gate.find("read_script_consent_file(").expect("the notebook gate reads the consent file");
    assert!(backstop < consent, "the user's own cell is let through before its backstop");
    assert!(
        body_of(&notebooks, "pub(crate) fn own_notebook_cell_backstop(").contains("refuse_held_code_outside_its_button("),
        "the notebook backstop asks nothing"
    );
}

/// THE ROUND TRIP at the unit tier: a subscribe lands B2's inline code held;
/// the door refuses it; `run_script` refuses the landed bytes as ad hoc; once
/// the approval of exactly those bytes is sealed on this computer, the door's
/// decision runs exactly the landed bytes.
#[test]
fn a_subscribed_inline_button_runs_through_the_door_only_after_its_bytes_are_approved() {
    let dir = TempDir::new().unwrap();
    let alice = TempDir::new().unwrap();
    let reg = LocalWorkspace::open(dir.path()).unwrap();
    publish_version(&reg, alice.path(), &dashboard(), SemVer::new(1, 0, 0), PushMode::CreateNew);
    let subscriber = Stores::new();
    *subscriber.scripts.security_level.lock().unwrap() = "enabled".to_string();
    subscriber.materialize(subscribe_pull(&dir, "1.0.0"), MaterializeMode::Subscribe);
    let files = crate::persistence::UserFilesState::default();
    let request = crate::scripting::types::RunControlActionRequest {
        kind: crate::scripting::types::ControlActionKind::Control,
        sheet_index: subscriber.dashboard_index(),
        row: 1,
        col: 1,
        view_state: None,
    };
    let click = || {
        crate::scripting::control_action::run_control_action_core(&subscriber.state, &subscriber.scripts, &files, &request)
            .expect("answered")
    };
    match click() {
        crate::scripting::control_action::DoorAnswer::Answer(crate::scripting::types::ControlActionOutcome::Refused {
            reason,
            ..
        }) => assert_eq!(reason, "notConsented"),
        other => panic!("the landed code ran unapproved: {other:?}"),
    }
    let err = crate::scripting::application_code_gate::distributed_run_gate(
        &subscriber.state,
        &[],
        None,
        "Report();",
        None,
        &crate::scripting::types::RunStartedBy::You { door: crate::scripting::types::RunDoor::MacrosDialog },
    )
    .expect_err("run_script ran the landed bytes as ad hoc");
    assert!(err.starts_with(crate::scripting::application_code_gate::APPLICATION_CODE_OUTSIDE_ITS_BUTTON), "{err}");

    crate::consent_seal::record_script_consent_core(
        &files,
        &FileState::default(),
        crate::consent_seal::RecordScriptConsentRequest {
            package_name: PKG.to_string(),
            scripts: vec![crate::consent_seal::ConsentScriptInput {
                id: crate::scripting::control_action::button_action_consent_id("Report();"),
                source: "Report();".to_string(),
            }],
            granted_capabilities: Vec::new(),
        },
    )
    .expect("sealed");
    match click() {
        crate::scripting::control_action::DoorAnswer::Run(run) => assert_eq!(run.source, "Report();"),
        other => panic!("the approved code did not run: {other:?}"),
    }
}
