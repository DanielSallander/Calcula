//! FILENAME: app/src-tauri/src/scripting/application_code_gate_tests.rs
//! PURPOSE: Phase 3 of BUG-0257 -- the run gate for an application's code: the
//! working-copy private-sheet rule, the storage-verified button, and the
//! always-on trail of every run and every refusal.
//! CONTEXT: Three tiers. The pure rule; the button check and the gate over a
//! seeded `AppState` (the `held_button_code_tests::seeded` pattern) with a
//! parsed consent file; and the placement census that pins where `run_script`
//! asks.

use std::collections::HashMap;
use std::path::Path;

use identity::SheetId;

use super::*;
use crate::controls::{
    ControlMetadata, ControlPropertyValue, HELD_FROM_PROPERTY, HELD_MACRO_REF_PROPERTY, MACRO_REF_PROPERTY,
};
use crate::document_effect::test_seed_effect;
use crate::scripting::commands::{MountConsentArtifact, CONSENT_SURFACES, DISTRIBUTED_SCRIPT_NOT_CONSENTED};

const APP: &str = "sales";
const MACRO: &str = "macro-report";
const SRC: &str = "Calcula.setCellValue(0, 0, 'report');";

// ============================================================================
// Fixtures
// ============================================================================

fn sheet_id() -> SheetId {
    SheetId::from_bytes(identity::generate_uuid_v7())
}

fn facts(name: &str, id: SheetId, holds_cells: bool) -> SheetFacts {
    SheetFacts { id, name: name.to_string(), holds_cells }
}

fn link_over(base: &[(SheetId, &str)]) -> calp::WorkingCopyLink {
    calp::WorkingCopyLink::new(
        r"\\server\reports",
        APP,
        "report",
        "1.0.0",
        "2026-09-30T00:00:00Z",
        base.iter()
            .map(|(id, name)| calp::WorkingCopySheetRef { sheet_id: *id, name: name.to_string() })
            .collect(),
    )
}

fn prop(value: &str) -> ControlPropertyValue {
    ControlPropertyValue { value_type: "static".into(), value: value.into() }
}

fn stamp(application: &str) -> String {
    crate::held_button_code::HeldFrom {
        workspace: "ws".into(),
        application: application.into(),
        version: "1.0.0".into(),
        value_types: Default::default(),
    }
    .encode()
}

/// A button control holding its application's link to `macro_id`.
fn held_button(macro_id: &str, application: &str) -> ControlMetadata {
    let mut properties = HashMap::new();
    properties.insert("text".to_string(), prop("Run report"));
    properties.insert(HELD_MACRO_REF_PROPERTY.to_string(), prop(macro_id));
    properties.insert(HELD_FROM_PROPERTY.to_string(), prop(&stamp(application)));
    ControlMetadata { control_type: "button".into(), properties }
}

/// A button control with a live link of the author's own.
fn live_button(macro_id: &str) -> ControlMetadata {
    let mut properties = HashMap::new();
    properties.insert("text".to_string(), prop("Mine"));
    properties.insert(MACRO_REF_PROPERTY.to_string(), prop(macro_id));
    ControlMetadata { control_type: "button".into(), properties }
}

fn button_cell(params: serde_json::Value) -> crate::cell_types::CellTypeAssignment {
    crate::cell_types::CellTypeAssignment {
        type_id: crate::button_cells::BUTTON_CELL_TYPE_ID.to_string(),
        params,
    }
}

/// The workbook a developer checked the application out into: the default
/// "Sheet1" (index 0), the application's "Dashboard" (index 1) with a held
/// button at B2 linking the application's macro, and -- when `private` -- the
/// developer's own "Salaries" (index 2) holding a cell. The workbook is a
/// working copy whose base sheet is Dashboard.
struct WorkingCopy {
    state: crate::AppState,
    dashboard: usize,
    private: Option<usize>,
}

fn working_copy(private: bool) -> WorkingCopy {
    let state = crate::create_app_state();
    let dashboard_id = sheet_id();
    {
        let effect = test_seed_effect();
        let mut grids = state.grids.write(&effect).unwrap();
        let mut names = state.sheet_names.write(&effect).unwrap();
        let mut ids = state.sheet_ids.write(&effect).unwrap();
        let mut dashboard = engine::grid::Grid::new();
        dashboard.set_cell(0, 0, engine::Cell::new_text("Sales".to_string()));
        grids.push(dashboard);
        names.push("Dashboard".to_string());
        ids.push(dashboard_id);
        if private {
            let mut salaries = engine::grid::Grid::new();
            salaries.set_cell(0, 0, engine::Cell::new_number(120_000.0));
            grids.push(salaries);
            names.push("Salaries".to_string());
            ids.push(sheet_id());
        }
    }
    state.controls.write(&test_seed_effect()).unwrap().insert((1, 1, 1), held_button(MACRO, APP));
    *state.working_copy_link.write(&test_seed_effect()).unwrap() = Some(link_over(&[(dashboard_id, "Dashboard")]));
    WorkingCopy { state, dashboard: 1, private: private.then_some(2) }
}

fn scripts() -> Vec<(Option<String>, String, String)> {
    vec![(Some(APP.to_string()), MACRO.to_string(), SRC.to_string())]
}

fn consent() -> serde_json::Value {
    serde_json::json!({
        "version": 1,
        "consents": [{
            "packageName": APP,
            "scripts": [{
                "id": MACRO,
                "sourceHash": calp::integrity::sha256_hex(SRC.as_bytes()),
                "source": SRC,
            }],
            "grantedCapabilities": [],
            "grantedAt": "2026-01-01T00:00:00Z",
        }],
    })
}

fn control_trigger(sheet_index: usize, row: u32, col: u32) -> ScriptRunTrigger {
    ScriptRunTrigger { kind: ScriptRunTriggerKind::ButtonControl, sheet_index, row, col }
}

fn rows(state: &crate::AppState, event: fn(&calp::audit::AuditEvent) -> bool) -> Vec<calp::audit::AuditEntry> {
    state.audit_log.read().unwrap().entries.iter().filter(|e| event(&e.event)).cloned().collect()
}

fn run_rows(state: &crate::AppState) -> Vec<calp::audit::AuditEntry> {
    rows(state, |e| matches!(e, calp::audit::AuditEvent::ApplicationCodeRun))
}

fn refused_rows(state: &crate::AppState) -> Vec<calp::audit::AuditEntry> {
    rows(state, |e| matches!(e, calp::audit::AuditEvent::ApplicationCodeRefused))
}

/// The module-runtime gate as a PERSON's run asks it (owner decision B,
/// follow-up F10): the button door when a click names a button, Developer >
/// Macros > Run otherwise. Every test written before F10 asked as a person --
/// there was no other kind of run -- so they keep asking that way; the tests of
/// F10 itself call `distributed_run_gate` with the starter they are about.
fn gate_as_you(
    state: &crate::AppState,
    scripts: &[(Option<String>, String, String)],
    consent_file: Option<&serde_json::Value>,
    source: &str,
    trigger: Option<&ScriptRunTrigger>,
) -> Result<(), String> {
    let started_by = match trigger {
        Some(_) => RunStartedBy::You { door: RunDoor::Button },
        None => RunStartedBy::You { door: RunDoor::MacrosDialog },
    };
    distributed_run_gate(state, scripts, consent_file, source, trigger, &started_by)
}

// ============================================================================
// 1. The private-sheet rule, pure
// ============================================================================

#[test]
fn private_sheet_refusal_allows_with_no_link() {
    let sheets = vec![facts("Salaries", sheet_id(), true)];
    assert_eq!(private_sheet_refusal(None, &sheets, APP, MACRO), None, "a workbook that is not a working copy");
}

#[test]
fn private_sheet_refusal_allows_when_every_sheet_is_the_applications() {
    let (a, b) = (sheet_id(), sheet_id());
    let link = link_over(&[(a, "Dashboard"), (b, "Data")]);
    let sheets = vec![facts("Dashboard", a, true), facts("Data", b, true)];
    assert_eq!(private_sheet_refusal(Some(&link), &sheets, APP, MACRO), None);
}

/// SABOTAGE: drop the `holds_cells &&` filter in `private_sheets` -- the
/// default blank "Sheet1" of a new workbook then refuses, and the rule's own
/// remedy (open the application in a new workbook) can never work.
#[test]
fn a_blank_sheet_beside_the_application_is_not_a_private_sheet() {
    let a = sheet_id();
    let link = link_over(&[(a, "Dashboard")]);
    let sheets = vec![facts("Sheet1", sheet_id(), false), facts("Dashboard", a, true)];
    assert_eq!(private_sheet_refusal(Some(&link), &sheets, APP, MACRO), None);
    assert!(private_sheets(Some(&link), &sheets).is_empty());
}

/// SABOTAGE: make `private_sheet_refusal` return `None` unconditionally.
#[test]
fn private_sheet_refusal_refuses_naming_the_private_sheets_with_a_cap() {
    let a = sheet_id();
    let link = link_over(&[(a, "Dashboard")]);
    let mut sheets = vec![facts("Dashboard", a, true)];
    for name in ["Salaries", "Bonus", "Notes", "Plans", "Ideas"] {
        sheets.push(facts(name, sheet_id(), true));
    }
    let refusal = private_sheet_refusal(Some(&link), &sheets, APP, MACRO).expect("refused");
    assert!(refusal.starts_with(APPLICATION_CODE_BESIDE_PRIVATE_SHEETS), "{refusal}");
    assert!(refusal.contains(&format!("\"{MACRO}\" came with the application \"{APP}\"")), "{refusal}");
    assert!(refusal.contains("working copy of \"sales\""), "{refusal}");
    assert!(refusal.contains("(Salaries, Bonus, Notes, +2 more)"), "the first three and a count: {refusal}");
    assert!(!refusal.contains("Dashboard"), "an application sheet is not the developer's own: {refusal}");
    assert!(refusal.contains("open the application for editing in a new workbook"), "{refusal}");
}

/// Every surface a mount can name is DECIDED: gated by the private-sheet rule,
/// or exempt with a reason. A new surface fails here until someone decides.
///
/// SABOTAGE: remove `("chart-marks", ...)` from `PRIVATE_SHEET_RULE_EXEMPT`.
#[test]
fn every_consent_surface_decides_the_private_sheet_rule() {
    for surface in CONSENT_SURFACES {
        let gated = PRIVATE_SHEET_RULE_SURFACES.contains(&surface.wire);
        let exempt = PRIVATE_SHEET_RULE_EXEMPT.iter().filter(|(w, _)| *w == surface.wire).count();
        assert!(
            gated ^ (exempt == 1),
            "'{}' must be gated by the private-sheet rule OR exempt with a reason -- exactly one",
            surface.wire
        );
    }
    for wire in PRIVATE_SHEET_RULE_SURFACES.iter().chain(PRIVATE_SHEET_RULE_EXEMPT.iter().map(|(w, _)| w)) {
        assert!(
            CONSENT_SURFACES.iter().any(|s| s.wire == *wire),
            "'{wire}' is decided but is not a surface a mount can name"
        );
    }
    for (wire, why) in PRIVATE_SHEET_RULE_EXEMPT {
        assert!(why.len() > 20, "'{wire}' is exempt without a reason");
    }
    // The two with grid-write reach are the gated ones.
    assert!(private_sheet_rule_gates("object-script") && private_sheet_rule_gates("lib"));
    assert!(!private_sheet_rule_gates("chart-marks"));
}

/// A COMMAND APPROVAL NEVER OPENS A MOUNT (plan_M8 S1). Command approvals live
/// under `button-commands:<application>`, which is no mount surface's key: no
/// `CONSENT_SURFACES` row forms it, for any application. And a workbook whose
/// only record for the application is a command approval -- the command's id
/// at the hash of its own bytes -- does NOT satisfy the object-script mount
/// floor (`consent_record_exists_in`, which admits a mount that names no
/// artifact on ANY non-empty record under the application's bare name). The
/// positive control proves the floor reads that key: the same record under the
/// bare name opens it -- which is why command ids must never go there.
///
/// SABOTAGES: a `CONSENT_SURFACES` row with prefix `button-commands:` -> the
/// census at the end goes red; `button_command_consent_key` returns the bare
/// application name -> the floor admits the command-only record, red (asked
/// first, so it is the floor assertion that bites).
#[test]
fn no_mount_surface_is_judged_under_the_button_command_key() {
    let command_key = crate::button_cells::button_command_consent_key(APP);
    let command = "test.reader.refresh";
    let record = |package: &str| {
        serde_json::json!({
            "version": 2,
            "consents": [{
                "packageName": package,
                "scripts": [{
                    "id": command,
                    "sourceHash": calp::integrity::sha256_hex(command.as_bytes()),
                    "source": command,
                }],
                "grantedCapabilities": [],
                "grantedAt": "2026-10-01T00:00:00Z",
            }],
        })
    };
    let only_commands = record(&command_key);
    let refusal = crate::scripting::commands::distributed_mount_refusal(
        Some(&only_commands),
        APP,
        Some("object-script"),
        None,
    );
    assert!(
        refusal.as_deref().is_some_and(|r| r.starts_with(DISTRIBUTED_SCRIPT_NOT_CONSENTED)),
        "a command approval opened the object-script mount floor: {refusal:?}"
    );
    // Positive control: the floor DOES read the bare key.
    let bare = record(APP);
    assert_eq!(
        crate::scripting::commands::distributed_mount_refusal(Some(&bare), APP, Some("object-script"), None),
        None,
        "the floor no longer reads the application's bare record, so the assertion above proves nothing"
    );
    // ...and no mount surface is ever judged under the command key (asked
    // after the behaviour above, so a key former that returns the bare name
    // fails there, on the floor it would open).
    for surface in CONSENT_SURFACES {
        assert!(
            !surface.prefix.starts_with("button-commands"),
            "'{}' is a mount surface judged under the command approvals' key",
            surface.wire
        );
        assert_ne!(surface.consent_key(APP), command_key, "'{}' forms the command key", surface.wire);
    }
}

/// AN APPLICATION'S NAME NEVER CONTAINS ':' (`calp::workspace::validate_component`
/// refuses it wherever a .calp is taken in), and every surface's consent key is
/// `<prefix><application><suffix>` with a ':'-bearing prefix or suffix. So a
/// mount that NAMES its application `button-commands:<app>` -- or
/// `chart-marks:<app>`, or `<app>::writeback-validators` -- would have the
/// object-script floor (prefix "") answered by another surface's approvals.
/// The renderer names the application, and the renderer can be compromised:
/// the gate refuses the name before it forms any key.
///
/// SABOTAGE: drop the ':' refusal at the top of `distributed_mount_refusal`.
#[test]
fn a_mount_naming_an_application_with_a_colon_is_refused_before_any_key() {
    let record = |package: &str, id: &str| {
        serde_json::json!({
            "version": 2,
            "consents": [{
                "packageName": package,
                "scripts": [{
                    "id": id,
                    "sourceHash": calp::integrity::sha256_hex(id.as_bytes()),
                    "source": id,
                }],
                "grantedCapabilities": [],
                "grantedAt": "2026-10-01T00:00:00Z",
            }],
        })
    };
    let command_key = crate::button_cells::button_command_consent_key(APP);
    let crossings: Vec<(String, serde_json::Value)> = vec![
        // Sales's COMMAND approvals, named as an application.
        (command_key.clone(), record(&command_key, "test.reader.refresh")),
        // Sales's chart-mark approvals.
        (format!("chart-marks:{APP}"), record(&format!("chart-marks:{APP}"), "mark-1")),
        // Sales's writeback-validator approvals.
        (format!("{APP}::writeback-validators"), record(&format!("{APP}::writeback-validators"), "writeback-validator:v")),
    ];
    for (named, file) in &crossings {
        let refusal = crate::scripting::commands::distributed_mount_refusal(Some(file), named, Some("object-script"), None);
        assert!(
            refusal.as_deref().is_some_and(|r| r.starts_with(DISTRIBUTED_SCRIPT_NOT_CONSENTED)),
            "a mount naming the application '{named}' had its floor answered by another surface's approvals: {refusal:?}"
        );
        assert!(refusal.unwrap().contains("':'"), "the refusal says why");
    }
    // Positive control: the same record shape under the application's own
    // name opens the floor, so the refusals above are the ':' rule's.
    assert_eq!(
        crate::scripting::commands::distributed_mount_refusal(
            Some(&record(APP, "test.reader.refresh")),
            APP,
            Some("object-script"),
            None
        ),
        None
    );
}

// ============================================================================
// 2. The button a click claims, against the store
// ============================================================================

/// SABOTAGE: have `verify_trigger` return `Ok` without reading the store (a
/// fabricated attribution) -- the mismatch tests below go red.
#[test]
fn verify_trigger_accepts_a_held_link_of_that_application() {
    let wc = working_copy(false);
    let button = verify_trigger(&wc.state, &control_trigger(wc.dashboard, 1, 1), APP, &[MACRO]).expect("backed");
    assert_eq!(button.cell, "Dashboard!B2");
    assert_eq!(button.caption, "Run report");
    assert_eq!(button.application.as_deref(), Some(APP));
    assert!(button.held);
}

#[test]
fn verify_trigger_accepts_the_authors_own_live_link() {
    let wc = working_copy(false);
    wc.state.controls.write(&test_seed_effect()).unwrap().insert((1, 4, 2), live_button(MACRO));
    let button = verify_trigger(&wc.state, &control_trigger(wc.dashboard, 4, 2), APP, &[MACRO]).expect("backed");
    assert!(!button.held);
    assert_eq!(button.application, None, "the author's own button came with no application");
    assert_eq!(button.cell, "Dashboard!C5");
}

#[test]
fn verify_trigger_refuses_a_stamp_naming_another_application() {
    let wc = working_copy(false);
    wc.state.controls.write(&test_seed_effect()).unwrap().insert((1, 1, 1), held_button(MACRO, "hr"));
    let why = verify_trigger(&wc.state, &control_trigger(wc.dashboard, 1, 1), APP, &[MACRO]).unwrap_err();
    assert!(why.contains("came with the application 'hr'"), "{why}");
    // ...and a held link to ANOTHER macro of the right application.
    wc.state.controls.write(&test_seed_effect()).unwrap().insert((1, 1, 1), held_button("macro-other", APP));
    let why = verify_trigger(&wc.state, &control_trigger(wc.dashboard, 1, 1), APP, &[MACRO]).unwrap_err();
    assert!(why.contains("links the macro 'macro-other'"), "{why}");
    // ...and an unreadable stamp vouches for nothing.
    let mut broken = held_button(MACRO, APP);
    broken.properties.insert(HELD_FROM_PROPERTY.to_string(), prop("{not json"));
    wc.state.controls.write(&test_seed_effect()).unwrap().insert((1, 1, 1), broken);
    let why = verify_trigger(&wc.state, &control_trigger(wc.dashboard, 1, 1), APP, &[MACRO]).unwrap_err();
    assert!(why.contains("missing or unreadable"), "{why}");
}

/// The live link wins, exactly as on the click: a button whose own live link
/// names something else does not back a run of the held macro.
#[test]
fn verify_trigger_reads_the_live_link_before_the_held_one() {
    let wc = working_copy(false);
    let mut both = held_button(MACRO, APP);
    both.properties.insert(MACRO_REF_PROPERTY.to_string(), prop("macro-mine"));
    wc.state.controls.write(&test_seed_effect()).unwrap().insert((1, 1, 1), both);
    let why = verify_trigger(&wc.state, &control_trigger(wc.dashboard, 1, 1), APP, &[MACRO]).unwrap_err();
    assert!(why.contains("links the macro 'macro-mine'"), "{why}");
}

#[test]
fn verify_trigger_refuses_an_empty_cell() {
    let wc = working_copy(false);
    let why = verify_trigger(&wc.state, &control_trigger(wc.dashboard, 9, 9), APP, &[MACRO]).unwrap_err();
    assert!(why.contains("no button control at Dashboard!J10"), "{why}");
    let cell = ScriptRunTrigger { kind: ScriptRunTriggerKind::ButtonCell, sheet_index: wc.dashboard, row: 9, col: 9 };
    let why = verify_trigger(&wc.state, &cell, APP, &[MACRO]).unwrap_err();
    assert!(why.contains("no button cell at Dashboard!J10"), "{why}");
}

#[test]
fn verify_trigger_accepts_a_stamped_button_cell_action() {
    let wc = working_copy(false);
    {
        let mut cells = wc.state.cell_types.write(&test_seed_effect()).unwrap();
        cells.insert((1, 3, 3), button_cell(serde_json::json!({
            "label": "Go",
            "action": { "kind": "script", "scriptId": MACRO },
            "fromApplication": { "workspace": "ws", "application": APP, "version": "1.0.0" }
        })));
        cells.insert((1, 4, 4), button_cell(serde_json::json!({
            "action": { "kind": "script", "scriptId": MACRO },
            "fromApplication": { "workspace": "ws", "application": "hr", "version": "1.0.0" }
        })));
        cells.insert((1, 5, 5), button_cell(serde_json::json!({
            "label": "Mine",
            "action": { "kind": "script", "scriptId": MACRO }
        })));
    }
    let at = |row, col| ScriptRunTrigger { kind: ScriptRunTriggerKind::ButtonCell, sheet_index: wc.dashboard, row, col };
    let button = verify_trigger(&wc.state, &at(3, 3), APP, &[MACRO]).expect("stamped and backed");
    assert_eq!((button.cell.as_str(), button.caption.as_str(), button.application.as_deref()), ("Dashboard!D4", "Go", Some(APP)));
    let why = verify_trigger(&wc.state, &at(4, 4), APP, &[MACRO]).unwrap_err();
    assert!(why.contains("came with the application 'hr'"), "{why}");
    // The author's own unstamped button cell runs what it links, like a
    // control's own live link.
    let own = verify_trigger(&wc.state, &at(5, 5), APP, &[MACRO]).expect("the author's own button");
    assert_eq!(own.application, None);
}

// ============================================================================
// 3. The gate, over a seeded workbook
// ============================================================================

/// THE WORKING-COPY PRIVATE-SHEET RULE. A teammate's approved macro must not run
/// beside the developer's own sheets -- and the refusal is on the trail with
/// auditing OFF, naming the button, the application and the sheets.
///
/// SABOTAGE: drop the `private_sheet_refusal` step from `distributed_run_gate`.
#[test]
fn the_gate_refuses_application_code_beside_a_private_sheet_and_audits_it_with_auditing_off() {
    let wc = working_copy(true);
    assert!(wc.private.is_some());
    assert!(!wc.state.audit_log.read().unwrap().enabled, "precondition: auditing is off");
    let trigger = control_trigger(wc.dashboard, 1, 1);
    let err = gate_as_you(&wc.state, &scripts(), Some(&consent()), SRC, Some(&trigger))
        .expect_err("refused beside a private sheet");
    assert!(err.starts_with(APPLICATION_CODE_BESIDE_PRIVATE_SHEETS), "{err}");
    assert!(err.contains("(Salaries)"), "{err}");
    assert!(run_rows(&wc.state).is_empty(), "a refused run was recorded as a run");
    let refused = refused_rows(&wc.state);
    assert_eq!(refused.len(), 1, "{:?}", wc.state.audit_log.read().unwrap().entries);
    let row = &refused[0];
    assert_eq!(row.extra["reason"], "privateSheets");
    assert_eq!(row.extra["application"], APP);
    assert_eq!(row.extra["macroId"], MACRO);
    assert_eq!(row.extra["privateSheets"], serde_json::json!(["Salaries"]));
    assert_eq!(row.extra["button"]["cell"], "Dashboard!B2", "the button, read from the store");
    assert_eq!(row.extra["button"]["caption"], "Run report");
}

/// ...and once the private sheet is gone the same click runs, leaving ONE run
/// row naming the button and the application.
///
/// SABOTAGE: return before `record_run` in `distributed_run_gate`'s trigger
/// branch (audit only refusals).
#[test]
fn the_gate_admits_it_once_the_private_sheet_is_gone_and_writes_one_application_code_run_row_naming_button_and_application() {
    let wc = working_copy(false);
    let trigger = control_trigger(wc.dashboard, 1, 1);
    gate_as_you(&wc.state, &scripts(), Some(&consent()), SRC, Some(&trigger)).expect("admitted");
    assert!(refused_rows(&wc.state).is_empty());
    let ran = run_rows(&wc.state);
    assert_eq!(ran.len(), 1, "{:?}", wc.state.audit_log.read().unwrap().entries);
    let row = &ran[0];
    assert_eq!(row.extra["surface"], "moduleRuntime");
    assert_eq!(row.extra["application"], APP);
    assert_eq!(row.extra["macroId"], MACRO);
    assert_eq!(row.extra["sourceHash"], calp::integrity::sha256_hex(SRC.as_bytes()));
    assert_eq!(row.extra["button"]["cell"], "Dashboard!B2");
    assert_eq!(row.extra["button"]["application"], APP);
    assert_eq!(row.extra["button"]["held"], true);
    assert!(row.description.contains("Dashboard!B2") && row.description.contains("'sales'"), "{}", row.description);
    // A run nobody clicked a button for is gated and recorded too -- without one.
    gate_as_you(&wc.state, &scripts(), Some(&consent()), SRC, None).expect("admitted");
    let ran = run_rows(&wc.state);
    assert_eq!(ran.len(), 2);
    assert!(ran[1].extra.get("button").is_none());
}

/// A CLICK'S CLAIM THE STORE DOES NOT BACK is refused, and the refusal is on
/// the trail with the claim marked unverified.
///
/// SABOTAGE: skip `verify_trigger` in `distributed_run_gate` (accept the claim
/// as said).
#[test]
fn a_trigger_that_storage_does_not_back_is_refused_and_audited() {
    let wc = working_copy(false);
    // An empty cell, and a button that links another application's macro.
    wc.state.controls.write(&test_seed_effect()).unwrap().insert((1, 6, 6), held_button(MACRO, "hr"));
    for trigger in [control_trigger(wc.dashboard, 9, 9), control_trigger(wc.dashboard, 6, 6)] {
        let err = gate_as_you(&wc.state, &scripts(), Some(&consent()), SRC, Some(&trigger))
            .expect_err("a claim the store does not back");
        assert!(err.starts_with(APPLICATION_CODE_TRIGGER_MISMATCH), "{err}");
    }
    assert!(run_rows(&wc.state).is_empty(), "an unbacked claim ran");
    let refused = refused_rows(&wc.state);
    assert_eq!(refused.len(), 2);
    assert!(refused.iter().all(|r| r.extra["reason"] == "triggerMismatch"));
    assert_eq!(refused[0].extra["claimedTrigger"]["row"], 9, "the unverified claim is recorded as a claim");
    assert!(refused[0].extra.get("button").is_none());
}

/// THE APPROVAL IS UNCHANGED: an unapproved application's macro is refused with
/// the exact text `distributed_module_refusal` gives -- and now also audited.
///
/// SABOTAGE: drop the `record_refused(.., "notConsented", ..)` call.
#[test]
fn an_unconsented_run_is_refused_with_the_unchanged_distributed_script_not_consented_text_and_audited() {
    let wc = working_copy(false);
    let trigger = control_trigger(wc.dashboard, 1, 1);
    let expected = crate::scripting::commands::distributed_module_refusal(&scripts(), None, SRC).expect("refused");
    let err = gate_as_you(&wc.state, &scripts(), None, SRC, Some(&trigger)).expect_err("unapproved");
    assert_eq!(err, expected, "the refusal text changed");
    assert!(err.starts_with(DISTRIBUTED_SCRIPT_NOT_CONSENTED));
    let refused = refused_rows(&wc.state);
    assert_eq!(refused.len(), 1);
    assert_eq!(refused[0].extra["reason"], "notConsented");
    assert_eq!(refused[0].extra["button"]["cell"], "Dashboard!B2");
    assert!(run_rows(&wc.state).is_empty());
}

// ----------------------------------------------------------------------------
// 3b. OWNER DECISION B, follow-up F10: a run a SCRIPT starts never gets an
//     application macro's reach in the module runtime either.
// ----------------------------------------------------------------------------

/// An APPROVED application macro that no person started is refused -- with its
/// own sentinel, a sentence saying how to run it, and one always-on refusal
/// row naming why and who started it -- and nothing is recorded as a run.
///
/// SABOTAGE: drop the `not_started_by_you` step from `distributed_run_gate`
/// -> the script-started run is admitted and recorded as a run.
#[test]
fn an_approved_application_macro_a_script_started_is_refused_and_audited() {
    let wc = working_copy(false);
    // Precondition: the same run, started by you, is admitted.
    distributed_run_gate(
        &wc.state, &scripts(), Some(&consent()), SRC, None, &RunStartedBy::You { door: RunDoor::MacrosDialog },
    )
    .expect("you ran it: admitted");
    assert_eq!(run_rows(&wc.state).len(), 1, "precondition: your run is recorded as a run");

    let err = distributed_run_gate(&wc.state, &scripts(), Some(&consent()), SRC, None, &RunStartedBy::Script)
        .expect_err("a script started it");
    assert!(err.starts_with(APPLICATION_MACRO_NOT_STARTED_BY_YOU), "{err}");
    assert_eq!(err, not_started_by_you_refusal(APP, MACRO));
    assert!(err.contains(&format!("'{MACRO}'")) && err.contains(&format!("'{APP}'")), "{err}");
    assert!(err.contains("Developer > Macros > Run") && err.contains("the command line"), "{err}");
    assert!(err.ends_with("Nothing ran."), "{err}");
    assert_eq!(run_rows(&wc.state).len(), 1, "a refused run was recorded as a run");
    let refused = refused_rows(&wc.state);
    assert_eq!(refused.len(), 1, "{:?}", wc.state.audit_log.read().unwrap().entries);
    assert_eq!(refused[0].extra["reason"], "notStartedByYou");
    assert_eq!(refused[0].extra["startedBy"], "script");
    assert_eq!(refused[0].extra["surface"], "moduleRuntime");
    assert_eq!(refused[0].extra["application"], APP);
    assert_eq!(refused[0].extra["macroId"], MACRO);
    assert!(!wc.state.audit_log.read().unwrap().enabled, "precondition: the row was written with auditing off");
}

/// A person's door must agree with the trigger, as the object-script grant
/// requires: the button door with no button, and another door naming a
/// button, are not a person's act.
///
/// SABOTAGE: reduce `not_started_by_you` to `Script => Some(..), You => None`
/// -> both contradictions are admitted.
#[test]
fn a_door_that_contradicts_the_trigger_is_not_a_persons_act() {
    let wc = working_copy(false);
    let trigger = control_trigger(wc.dashboard, 1, 1);
    let no_button = distributed_run_gate(
        &wc.state, &scripts(), Some(&consent()), SRC, None, &RunStartedBy::You { door: RunDoor::Button },
    )
    .expect_err("the button door with no button");
    assert!(no_button.starts_with(APPLICATION_MACRO_NOT_STARTED_BY_YOU), "{no_button}");
    for door in [RunDoor::MacrosDialog, RunDoor::CommandLine, RunDoor::ViewBookmark] {
        let err = distributed_run_gate(
            &wc.state, &scripts(), Some(&consent()), SRC, Some(&trigger), &RunStartedBy::You { door },
        )
        .expect_err("another door naming a button");
        assert!(err.starts_with(APPLICATION_MACRO_NOT_STARTED_BY_YOU), "{door:?}: {err}");
    }
    assert!(run_rows(&wc.state).is_empty(), "a contradiction ran");
    let refused = refused_rows(&wc.state);
    assert_eq!(refused.len(), 4);
    // `startedBy` is "you" only for a door Rust vouches for (F3); a
    // contradiction keeps the door the page claimed as `claimedDoor`.
    // SABOTAGE: record `("startedBy", door_label(door))` again in
    // `not_started_by_you_fields`.
    assert_eq!(refused[0].extra["startedBy"], "script");
    assert_eq!(refused[0].extra["claimedDoor"], "button");
    assert_eq!(refused[1].extra["claimedDoor"], "macrosDialog");
    // The claimed button is named from the store on the rows that claimed one.
    assert_eq!(refused[1].extra["button"]["cell"], "Dashboard!B2");
    // ...and the button door WITH the button it names runs.
    distributed_run_gate(
        &wc.state, &scripts(), Some(&consent()), SRC, Some(&trigger), &RunStartedBy::You { door: RunDoor::Button },
    )
    .expect("a click on the button that links it");
    assert_eq!(run_rows(&wc.state).len(), 1);
}

/// Every person's door runs an approved macro: the three doors that mint a
/// pass, and the user's own view bookmark (subscriber-local wiring the user
/// activated). Pure table over `not_started_by_you`.
#[test]
fn every_persons_door_runs_and_only_a_script_is_refused() {
    let trigger = control_trigger(1, 1, 1);
    for door in [RunDoor::MacrosDialog, RunDoor::CommandLine, RunDoor::ViewBookmark] {
        assert_eq!(not_started_by_you(&RunStartedBy::You { door }, None), None, "{door:?}");
    }
    assert_eq!(not_started_by_you(&RunStartedBy::You { door: RunDoor::Button }, Some(&trigger)), None);
    assert!(not_started_by_you(&RunStartedBy::Script, None).is_some());
    assert!(not_started_by_you(&RunStartedBy::Script, Some(&trigger)).is_some());
}

/// THE USER'S OWN CODE IS NOT ASKED: a local module and an ad-hoc run started
/// by a script run exactly as before, unrecorded -- F10 is about an
/// application's macro only. And UNAPPROVED code keeps its own refusal (the
/// approval is asked first).
///
/// SABOTAGE: ask `not_started_by_you` before `distributed_owners` decides whose
/// code it is -> the user's own script-started run is refused.
#[test]
fn a_script_starting_the_users_own_code_is_not_asked_and_unapproved_code_keeps_its_refusal() {
    let wc = working_copy(false);
    let local = vec![(None, "macro-mine".to_string(), SRC.to_string())];
    distributed_run_gate(&wc.state, &local, None, SRC, None, &RunStartedBy::Script).expect("the user's own macro runs");
    distributed_run_gate(&wc.state, &scripts(), None, "Calcula.log('ad hoc');", None, &RunStartedBy::Script)
        .expect("an ad-hoc run");
    assert!(wc.state.audit_log.read().unwrap().entries.is_empty(), "the user's own code was recorded");

    let expected = crate::scripting::commands::distributed_module_refusal(&scripts(), None, SRC).expect("refused");
    let err = distributed_run_gate(&wc.state, &scripts(), None, SRC, None, &RunStartedBy::Script)
        .expect_err("unapproved and script-started");
    assert_eq!(err, expected, "unapproved code lost its own refusal");
    assert_eq!(refused_rows(&wc.state)[0].extra["reason"], "notConsented");
}

/// LOCAL AND AD-HOC RUNS ARE THE USER'S OWN: not refused beside private sheets,
/// and not recorded here.
///
/// SABOTAGE: apply the private-sheet rule before `distributed_owners` decides
/// whose code it is.
#[test]
fn private_sheet_refusal_never_applies_to_local_code() {
    let wc = working_copy(true);
    let local = vec![(None, "macro-mine".to_string(), SRC.to_string())];
    gate_as_you(&wc.state, &local, None, SRC, Some(&control_trigger(wc.dashboard, 1, 1)))
        .expect("the user's own macro runs");
    gate_as_you(&wc.state, &scripts(), None, "Calcula.log('ad hoc');", None).expect("an ad-hoc run");
    assert!(wc.state.audit_log.read().unwrap().entries.is_empty(), "the user's own code was recorded");
}

/// THE MOUNT DOOR. The private-sheet rule gates the surfaces whose code can
/// write the grid and no other; a click's mount is verified and recorded; a
/// standing mount (no trigger) records nothing when it passes.
///
/// SABOTAGE: drop the `private_sheet_rule_gates(wire)` step from
/// `mount_run_gate`.
#[test]
fn the_mount_gate_applies_the_private_sheet_rule_to_grid_writing_surfaces_only() {
    let wc = working_copy(true);
    let artifacts = vec![MountConsentArtifact { id: MACRO.to_string(), source: SRC.to_string() }];
    let composed = format!("/* prelude */\n{SRC}");
    let err = mount_run_gate(
        &wc.state, &scripts(), Some(&consent()), APP, &composed, Some("object-script"), Some(&artifacts), None,
        MountGatePhase::Mount,
        None,
    )
    .expect_err("an object script beside a private sheet");
    assert!(err.starts_with(APPLICATION_CODE_BESIDE_PRIVATE_SHEETS), "{err}");
    assert_eq!(refused_rows(&wc.state).len(), 1, "a private-sheet refusal is recorded even without a trigger");

    // A chart mark is exempt: its approval is under its own key.
    let chart_consent = serde_json::json!({ "consents": [{
        "packageName": format!("chart-marks:{APP}"),
        "scripts": [{ "id": "mark", "sourceHash": calp::integrity::sha256_hex(b"paint()") }],
    }] });
    let mark = vec![MountConsentArtifact { id: "mark".to_string(), source: "paint()".to_string() }];
    mount_run_gate(&wc.state, &[], Some(&chart_consent), APP, "composed", Some("chart-marks"), Some(&mark), None, MountGatePhase::Mount, None)
        .expect("a chart mark is not gated by the rule");
    assert_eq!(wc.state.audit_log.read().unwrap().entries.len(), 1, "a passing standing mount recorded a row");

    // Without the private sheet, a click's mount runs and is recorded.
    let clean = working_copy(false);
    let trigger = control_trigger(clean.dashboard, 1, 1);
    mount_run_gate(
        &clean.state, &scripts(), Some(&consent()), APP, &composed, Some("object-script"), Some(&artifacts), Some(&trigger),
        MountGatePhase::RunAdmitted,
        None,
    )
    .expect("admitted");
    let ran = run_rows(&clean.state);
    assert_eq!(ran.len(), 1);
    assert_eq!(ran[0].extra["surface"], "object-script");
    assert_eq!(ran[0].extra["button"]["cell"], "Dashboard!B2");
    // ...and a mount claiming a button that does not link it is refused.
    let err = mount_run_gate(
        &clean.state, &scripts(), Some(&consent()), APP, &composed, Some("object-script"), Some(&artifacts),
        Some(&control_trigger(clean.dashboard, 9, 9)),
        MountGatePhase::RunCheck,
        None,
    )
    .expect_err("unbacked");
    assert!(err.starts_with(APPLICATION_CODE_TRIGGER_MISMATCH), "{err}");
}

/// THE RULE'S ONLY INPUT, read the way the rule needs it. `grid` is the
/// authoritative copy of the ACTIVE sheet and `grids[active]` can lag behind it
/// (BUG-0016), so a developer who has just typed private data into the active
/// sheet must be judged by the mirror -- and a sheet whose grid cannot be found
/// counts as holding cells (the rule fails closed).
///
/// SABOTAGE: drop `|| (i == active && active_holds)` from `workbook_sheet_facts`;
/// or `unwrap_or(true)` -> `unwrap_or(false)` there.
#[test]
fn workbook_sheet_facts_reads_the_active_sheet_mirror_and_fails_closed() {
    // THE MIRROR: Sheet1 (index 0, not an application sheet) is active, and the
    // developer's typing is in `grid` only.
    let wc = working_copy(false);
    *wc.state.active_sheet.write(&test_seed_effect()).unwrap() = 0;
    wc.state.grid.write(&test_seed_effect()).unwrap().set_cell(0, 0, engine::Cell::new_number(120_000.0));
    assert!(wc.state.grids.read().unwrap()[0].cells.is_empty(), "precondition: grids[0] lags the mirror");
    let link = wc.state.working_copy_link.read().unwrap().clone();
    let facts = workbook_sheet_facts(&wc.state).unwrap();
    assert_eq!(private_sheets(link.as_ref(), &facts), vec!["Sheet1".to_string()], "{facts:?}");
    let err = gate_as_you(&wc.state, &scripts(), Some(&consent()), SRC, None)
        .expect_err("application code beside a sheet the developer just typed into");
    assert!(err.starts_with(APPLICATION_CODE_BESIDE_PRIVATE_SHEETS), "{err}");

    // FAIL CLOSED: a sheet with an id and a name but no grid.
    let wc = working_copy(false);
    wc.state.sheet_ids.write(&test_seed_effect()).unwrap().push(sheet_id());
    wc.state.sheet_names.write(&test_seed_effect()).unwrap().push("Orphan".to_string());
    let facts = workbook_sheet_facts(&wc.state).unwrap();
    let orphan = facts.iter().find(|f| f.name == "Orphan").expect("the orphan sheet is listed");
    assert!(orphan.holds_cells, "a sheet whose grid cannot be found must count as holding cells");
    let sheet1 = facts.iter().find(|f| f.name == "Sheet1").unwrap();
    assert!(!sheet1.holds_cells, "the blank default sheet stays blank");
}

/// AN EXPLICIT RUN'S REFUSAL IS ON THE TRAIL -- with the button when a click
/// asked, and without one when Developer > Macros > Run or the CLI did. A
/// STANDING mount refused for consent records nothing (a workbook mounts its
/// approved code on every load).
///
/// SABOTAGE: `if explicit_run || trigger.is_some()` -> `if false` in
/// `mount_run_gate`; or `-> if trigger.is_some()` (the button-only rule this
/// replaced: the no-button run then goes unrecorded).
#[test]
fn an_explicit_run_refused_for_consent_is_audited_and_a_standing_mount_is_not() {
    let wc = working_copy(false);
    let artifacts = vec![MountConsentArtifact { id: MACRO.to_string(), source: SRC.to_string() }];
    let composed = format!("/* prelude */\n{SRC}");
    let click = control_trigger(wc.dashboard, 1, 1);
    let ask = |trigger: Option<&ScriptRunTrigger>, phase: MountGatePhase| {
        mount_run_gate(&wc.state, &scripts(), None, APP, &composed, Some("object-script"), Some(&artifacts), trigger, phase, None)
    };

    let err = ask(Some(&click), MountGatePhase::RunCheck).expect_err("not approved");
    assert!(err.starts_with(DISTRIBUTED_SCRIPT_NOT_CONSENTED), "{err}");
    let refused = refused_rows(&wc.state);
    assert_eq!(refused.len(), 1, "{:?}", wc.state.audit_log.read().unwrap().entries);
    assert_eq!(refused[0].extra["reason"], "notConsented");
    assert_eq!(refused[0].extra["button"]["cell"], "Dashboard!B2");

    ask(None, MountGatePhase::RunCheck).expect_err("not approved");
    let refused = refused_rows(&wc.state);
    assert_eq!(refused.len(), 2, "a run nobody clicked a button for was refused without a trace");
    assert!(refused[1].extra.get("button").is_none() && refused[1].extra.get("claimedTrigger").is_none());

    ask(None, MountGatePhase::Mount).expect_err("not approved");
    assert_eq!(refused_rows(&wc.state).len(), 2, "a standing mount's refusal was recorded");
    assert!(run_rows(&wc.state).is_empty());
}

/// AN EXPLICIT RUN IS RECORDED ONCE IT IS ADMITTED -- and only then. The host
/// asks `runCheck` BEFORE Script Security and `runAdmitted` after it, so a run
/// Script Security then refuses ('disabled', or the prompt declined) leaves no
/// row saying it ran; an admitted run leaves one, button or not.
///
/// SABOTAGE: record the run in `RunCheck` too (`if explicit_run`), or only when
/// a button asked (`if trigger.is_some()`).
#[test]
fn an_explicit_run_is_recorded_only_once_admitted_button_or_not() {
    let wc = working_copy(false);
    let artifacts = vec![MountConsentArtifact { id: MACRO.to_string(), source: SRC.to_string() }];
    let composed = format!("/* prelude */\n{SRC}");
    let click = control_trigger(wc.dashboard, 1, 1);
    let ask = |trigger: Option<&ScriptRunTrigger>, phase: MountGatePhase| {
        mount_run_gate(
            &wc.state, &scripts(), Some(&consent()), APP, &composed, Some("object-script"), Some(&artifacts), trigger, phase,
            None,
        )
    };

    ask(Some(&click), MountGatePhase::RunCheck).expect("approved");
    ask(None, MountGatePhase::RunCheck).expect("approved");
    ask(None, MountGatePhase::Mount).expect("a standing mount");
    assert!(run_rows(&wc.state).is_empty(), "a run was recorded before Script Security admitted it");

    ask(None, MountGatePhase::RunAdmitted).expect("admitted");
    ask(Some(&click), MountGatePhase::RunAdmitted).expect("admitted");
    let ran = run_rows(&wc.state);
    assert_eq!(ran.len(), 2, "{:?}", wc.state.audit_log.read().unwrap().entries);
    assert!(ran[0].extra.get("button").is_none(), "Developer > Macros > Run names no button");
    assert_eq!(ran[0].extra["surface"], "object-script");
    assert_eq!(ran[0].extra["macroId"], MACRO);
    assert_eq!(ran[1].extra["button"]["cell"], "Dashboard!B2");
    assert!(refused_rows(&wc.state).is_empty());
}

/// THE RULE HOLDS WHILE THE CODE RUNS. An object script mounts in a clean
/// working copy; then a private sheet appears (the rule's own remedy, followed
/// by an added sheet). The realm's next act asks `standing` and is refused --
/// recorded once, marked as stopped while running -- without re-asking the
/// consent questions (no modules, no consent file needed). A surface the rule
/// exempts is not stopped, and outside a working copy nothing is.
///
/// SABOTAGE: return `Ok(answer)` for `MountGatePhase::Standing` before the
/// private-sheet rule in `mount_run_gate`.
#[test]
fn a_private_sheet_that_appears_after_the_mount_stops_standing_code() {
    let wc = working_copy(false);
    let artifacts = vec![MountConsentArtifact { id: MACRO.to_string(), source: SRC.to_string() }];
    let composed = format!("/* prelude */\n{SRC}");
    let answer = mount_run_gate(
        &wc.state, &scripts(), Some(&consent()), APP, &composed, Some("object-script"), Some(&artifacts), None,
        MountGatePhase::Mount,
        None,
    )
    .expect("mounts in a clean working copy");
    assert!(answer.recheck_while_running, "the host must be told to keep asking");
    let standing = |state: &crate::AppState, surface: &str| {
        mount_run_gate(state, &[], None, APP, "", Some(surface), None, None, MountGatePhase::Standing, None)
    };
    standing(&wc.state, "object-script").expect("still clean");

    // The developer adds a sheet of their own and types into it.
    {
        let effect = test_seed_effect();
        let mut salaries = engine::grid::Grid::new();
        salaries.set_cell(0, 0, engine::Cell::new_number(120_000.0));
        wc.state.grids.write(&effect).unwrap().push(salaries);
        wc.state.sheet_names.write(&effect).unwrap().push("Salaries".to_string());
        wc.state.sheet_ids.write(&effect).unwrap().push(sheet_id());
    }
    let err = standing(&wc.state, "object-script").expect_err("a private sheet appeared beside running code");
    assert!(err.starts_with(APPLICATION_CODE_BESIDE_PRIVATE_SHEETS), "{err}");
    assert!(err.contains("(Salaries)"), "{err}");
    let refused = refused_rows(&wc.state);
    assert_eq!(refused.len(), 1, "{:?}", wc.state.audit_log.read().unwrap().entries);
    assert_eq!(refused[0].extra["reason"], "privateSheets");
    assert_eq!(refused[0].extra["stoppedWhileRunning"], true);
    assert_eq!(refused[0].extra["surface"], "object-script");

    standing(&wc.state, "lib").expect_err("a library realm is gated too");
    standing(&wc.state, "chart-marks").expect("an exempt surface keeps painting");

    let plain = crate::create_app_state();
    {
        let effect = test_seed_effect();
        plain.grid.write(&effect).unwrap().set_cell(0, 0, engine::Cell::new_number(1.0));
    }
    let answer = standing(&plain, "object-script").expect("not a working copy");
    assert!(!answer.recheck_while_running, "outside a working copy nothing needs re-asking");
    let exempt = standing(&wc.state, "chart-marks").expect("exempt");
    assert!(!exempt.recheck_while_running, "an exempt surface is never re-asked");
}

/// Two branches of the button-CELL claim: a stamped cell that runs ANOTHER
/// macro of the same application does not back this one, and a HELD action
/// with no `fromApplication` stamp backs nothing (a held action exists only
/// under an application's stamp).
///
/// SABOTAGE: add `&& artifact_ids.is_empty()` to the `!artifact_ids.contains`
/// check in `verify_trigger`'s cell branch; or `None if !held` -> `None`.
#[test]
fn verify_trigger_refuses_a_cell_running_another_macro_or_an_unstamped_held_action() {
    let wc = working_copy(false);
    {
        let mut cells = wc.state.cell_types.write(&test_seed_effect()).unwrap();
        cells.insert((1, 6, 6), button_cell(serde_json::json!({
            "label": "Other",
            "action": { "kind": "script", "scriptId": "macro-other" },
            "fromApplication": { "workspace": "ws", "application": APP, "version": "1.0.0" }
        })));
        cells.insert((1, 7, 7), button_cell(serde_json::json!({
            "label": "Held, unstamped",
            "heldAction": { "kind": "script", "scriptId": MACRO }
        })));
    }
    let at = |row, col| ScriptRunTrigger { kind: ScriptRunTriggerKind::ButtonCell, sheet_index: wc.dashboard, row, col };
    let why = verify_trigger(&wc.state, &at(6, 6), APP, &[MACRO]).unwrap_err();
    assert!(why.contains("runs the macro 'macro-other'"), "{why}");
    let why = verify_trigger(&wc.state, &at(7, 7), APP, &[MACRO]).unwrap_err();
    assert!(why.contains("no readable record"), "{why}");
}

/// AN APPROVED NOTEBOOK CELL OF AN APPLICATION is application code with grid
/// write-back: beside a private sheet it is refused and recorded; in a clean
/// working copy it runs and is recorded, like a macro.
///
/// SABOTAGE: return `Ok(())` at the top of `notebook_run_gate`.
#[test]
fn an_applications_approved_notebook_meets_the_private_sheet_rule_and_the_trail() {
    let wc = working_copy(true);
    let err = notebook_run_gate(&wc.state, APP, "notebook:nb-1:c1", "Calcula.log(1)").expect_err("beside a private sheet");
    assert!(err.starts_with(APPLICATION_CODE_BESIDE_PRIVATE_SHEETS), "{err}");
    let refused = refused_rows(&wc.state);
    assert_eq!(refused.len(), 1);
    assert_eq!(refused[0].extra["surface"], "notebook");
    assert_eq!(refused[0].extra["macroId"], "notebook:nb-1:c1");
    assert!(run_rows(&wc.state).is_empty());

    let clean = working_copy(false);
    notebook_run_gate(&clean.state, APP, "notebook:nb-1:c1", "Calcula.log(1)").expect("clean");
    let ran = run_rows(&clean.state);
    assert_eq!(ran.len(), 1);
    assert_eq!(ran[0].extra["application"], APP);
}

// ============================================================================
// 4. Placement
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

/// THE MCP / AI SCRIPT ROUTE ASKS THE RUN GATE AS A SCRIPT-STARTED RUN (review
/// of M6b). Owner decision B: "a run a script starts never gets an application
/// macro's reach". The agent's route (`execute_script`, and the in-app AI
/// chat's `run_script` tool, both through `run_script_isolated`) used to ask
/// only `check_mcp_access`, so an agent could run an application module's
/// source, or a button's held inline code, verbatim -- no approval, no person,
/// no row. It now asks `distributed_run_gate` with `RunStartedBy::Script`
/// (whose refusals the F10 tests above pin), after the access ceiling and
/// before it clones the workbook to run.
///
/// SABOTAGE: delete the `distributed_run_gate(` block from
/// `run_script_isolated`, or pass `RunStartedBy::You { .. }` -> red.
#[test]
fn the_mcp_script_route_asks_the_run_gate_as_a_run_a_script_started() {
    let tools = source("src/mcp/tools.rs");
    let body = body_of(&tools, "pub(crate) async fn run_script_isolated(");
    let access = body.find("check_mcp_access(").expect("the MCP access ceiling is no longer asked");
    let gate = body
        .find("crate::scripting::application_code_gate::distributed_run_gate(")
        .expect("the MCP script route no longer asks the run gate");
    let clone = body.find("state.grids.read()").expect("the workbook clone moved");
    assert!(access < gate && gate < clone, "the gate is not between the access ceiling and the run");
    let call = &body[gate..gate + body[gate..].find(")?;").expect("the gate's refusal is not propagated")];
    assert!(call.contains("&crate::scripting::types::RunStartedBy::Script"), "{call}");
    assert!(call.contains("code,"), "the gate is not asked about the code that runs: {call}");
    // Both MCP entry points and the AI chat tool reach it.
    assert!(body_of(&tools, "async fn run_script_with_model(").contains("run_script_isolated(handle, code"));
}

/// THE CHECKOUT SAYS IN ADVANCE what a click would be refused for: its
/// response's `private_sheets` is the run gate's own rule, computed over the
/// working-copy link the checkout has just written (computed before it, there
/// is no link and the list is always empty).
///
/// SABOTAGE: `private_sheets: Vec::new(),` in the `CheckoutResponse`, or compute
/// it above the link write.
#[test]
fn checkout_reports_the_private_sheets_by_the_gates_own_rule_after_writing_the_link() {
    let cmds = source("src/calp_commands.rs");
    let checkout = body_of(&cmds, "pub fn calp_checkout(");
    let link_written = checkout.find("*link = Some(fresh);").expect("the link write moved");
    let computed = checkout
        .find("application_code_gate::private_sheets(link.as_ref(), &sheets)")
        .expect("the checkout no longer computes the private sheets by the gate's rule");
    assert!(link_written < computed, "the private sheets are computed before the link exists");
    assert!(checkout.contains("application_code_gate::workbook_sheet_facts(&state)"));
    let response = &checkout[checkout.find("Ok(CheckoutResponse {").expect("the response moved")..];
    assert!(response.contains("        private_sheets,\n"), "the response does not carry what was computed");
}

/// `run_script` asks the WHOLE gate -- with the click's trigger -- before it
/// hands the source to the interpreter (which is where the grids are cloned),
/// and the check it asks is the run gate; the mount door asks the mount gate
/// with its trigger.
///
/// SABOTAGE (S3 d): call `run_in_interpreter(` above the
/// `require_distributed_module_consent(` call in `run_script`, or have it call
/// `distributed_module_refusal` directly again.
#[test]
fn run_script_asks_the_gate_before_cloning_the_grids() {
    let cmds = source("src/scripting/commands.rs");
    let run = body_of(&cmds, "pub fn run_script(");
    let gate = run.find("require_distributed_module_consent(").expect("run_script no longer asks the gate");
    let interpreter = run.find("run_in_interpreter(").expect("run_script no longer runs through run_in_interpreter");
    assert!(gate < interpreter, "run_script runs the interpreter before it asks whose code this is");
    // The grid clone lives only inside the interpreter half, after every gate.
    assert!(!run.contains("state.grids.read()"), "run_script clones the grids itself again");
    let clone_home = body_of(&cmds, "pub(crate) fn run_in_interpreter(");
    assert!(clone_home.contains("state.grids.read()"), "the grid clone moved out of run_in_interpreter");
    let call = &run[gate..];
    assert!(call[..call.find(")?;").unwrap()].contains("request.trigger.as_ref()"), "the click's trigger is not passed");
    // Who started the run reaches the gate as the page said it (owner decision
    // B, F10) -- never a constant that would read every run as a person's.
    // SABOTAGE: pass `&RunStartedBy::You { door: RunDoor::MacrosDialog }` there.
    assert!(call[..call.find(")?;").unwrap()].contains("&request.started_by"), "who started the run is not passed");
    let asks_started_by = body_of(&cmds, "fn require_distributed_module_consent(");
    assert!(asks_started_by.contains("started_by,\n    )"), "the module door drops who started the run");
    let asks = body_of(&cmds, "fn require_distributed_module_consent(");
    assert!(asks.contains("application_code_gate::distributed_run_gate("), "the module door skips the run gate");
    let mount = body_of(&cmds, "pub fn check_distributed_mount_consent(");
    assert!(mount.contains("application_code_gate::mount_run_gate("), "the mount door skips the run gate");
    assert!(mount.contains("trigger.as_ref()"), "the mount's trigger is not passed");
}

/// A notebook cell of an application meets the run gate AFTER its approval
/// and before the grids are cloned, on every path (run / run-all / rewind /
/// run-from all funnel through `run_cell_internal`).
///
/// SABOTAGE: drop the `notebook_run_gate(` call from
/// `require_distributed_notebook_consent`.
#[test]
fn an_approved_application_notebook_asks_the_run_gate_before_the_clone() {
    let src = source("src/scripting/notebook_commands.rs");
    let asks = body_of(&src, "fn require_distributed_notebook_consent(");
    let approval = asks.find("distributed_notebook_refusal(").expect("the approval moved");
    let gate = asks.find("application_code_gate::notebook_run_gate(").expect("an approved notebook skips the run gate");
    assert!(approval < gate, "the run gate is asked before the approval");
    let cell = body_of(&src, "async fn run_cell_internal(");
    let consent = cell.find("require_distributed_notebook_consent(").expect("the cell no longer asks");
    let clone = cell.find("app_state.grids.read()").expect("the grid clone moved");
    assert!(consent < clone, "the notebook clones the grids before it asks whose code this is");
}

/// THE WIRE THE PAGE SENDS lands in Rust -- pinned on THIS side too. Every one
/// of these fields is `#[serde(default)]` or optional, so a rename on either
/// side would silently drop the button a click claims (the run is then
/// recorded without it) or the mount's phase (an explicit run then reads as a
/// standing mount and leaves no run row), instead of failing.
///
/// SABOTAGE: `#[serde(rename_all = "snake_case")]` on `ScriptRunTrigger` or
/// `MountGatePhase`.
#[test]
fn the_click_and_the_mount_phase_deserialize_from_the_wire_the_page_sends() {
    let request: crate::scripting::types::RunScriptRequest = serde_json::from_value(serde_json::json!({
        "source": "x",
        "filename": "f.ts",
        "trigger": { "kind": "buttonControl", "sheetIndex": 1, "row": 2, "col": 3 },
    }))
    .unwrap();
    assert_eq!(
        request.trigger,
        Some(ScriptRunTrigger { kind: ScriptRunTriggerKind::ButtonControl, sheet_index: 1, row: 2, col: 3 })
    );
    let cell: ScriptRunTrigger =
        serde_json::from_value(serde_json::json!({ "kind": "buttonCell", "sheetIndex": 0, "row": 4, "col": 5 })).unwrap();
    assert_eq!(cell.kind, ScriptRunTriggerKind::ButtonCell);
    // WHO STARTED IT (owner decision B, F10): a request that says nothing is
    // NOT a person's -- the default refuses an application's macro.
    // SABOTAGE: replace the derived `Default` with an impl returning
    // `RunStartedBy::You { door: RunDoor::MacrosDialog }`.
    assert_eq!(request.started_by, RunStartedBy::Script, "an unspoken starter read as a person");
    for (wire, door) in [
        ("macrosDialog", RunDoor::MacrosDialog),
        ("button", RunDoor::Button),
        ("commandLine", RunDoor::CommandLine),
        ("viewBookmark", RunDoor::ViewBookmark),
    ] {
        let said: crate::scripting::types::RunScriptRequest = serde_json::from_value(serde_json::json!({
            "source": "x",
            "filename": "f.ts",
            "startedBy": { "kind": "you", "door": wire },
        }))
        .unwrap();
        assert_eq!(said.started_by, RunStartedBy::You { door }, "{wire}");
    }
    let script: crate::scripting::types::RunScriptRequest = serde_json::from_value(serde_json::json!({
        "source": "x",
        "filename": "f.ts",
        "startedBy": { "kind": "script" },
    }))
    .unwrap();
    assert_eq!(script.started_by, RunStartedBy::Script);
    // A door this build does not know is a wire error, never a person.
    assert!(serde_json::from_value::<crate::scripting::types::RunScriptRequest>(serde_json::json!({
        "source": "x",
        "filename": "f.ts",
        "startedBy": { "kind": "you", "door": "aiTool" },
    }))
    .is_err());
    for (wire, phase) in [
        ("mount", MountGatePhase::Mount),
        ("runCheck", MountGatePhase::RunCheck),
        ("runAdmitted", MountGatePhase::RunAdmitted),
        ("standing", MountGatePhase::Standing),
    ] {
        assert_eq!(serde_json::from_value::<MountGatePhase>(serde_json::json!(wire)).unwrap(), phase, "{wire}");
    }
    // THE ANSWER the page reads (owner decision B, F3): `cellAccess` and
    // `grantId` by these names, or the page's grant never switches on (an
    // absent field is no grant) and its report names no grant.
    assert_eq!(
        serde_json::to_value(MountGateAnswer { recheck_while_running: true, cell_access: true, grant_id: Some(7) })
            .unwrap(),
        serde_json::json!({ "recheckWhileRunning": true, "cellAccess": true, "grantId": 7 })
    );
    assert_eq!(
        serde_json::to_value(MountGateAnswer::admitted(false)).unwrap(),
        serde_json::json!({ "recheckWhileRunning": false, "cellAccess": false, "grantId": null })
    );
    // THE CLAIM the page sends: the three pass doors, by these names; a view
    // bookmark (a module-runtime door only) or an unknown door is a wire error,
    // never a claim.
    for (wire, door) in [
        ("macrosDialog", ExplicitRunDoor::MacrosDialog),
        ("button", ExplicitRunDoor::Button),
        ("commandLine", ExplicitRunDoor::CommandLine),
    ] {
        let claim: ExplicitRunClaim =
            serde_json::from_value(serde_json::json!({ "door": wire, "macroId": MACRO })).unwrap();
        assert_eq!(claim, ExplicitRunClaim { door, macro_id: MACRO.to_string() }, "{wire}");
    }
    for door in ["viewBookmark", "aiTool"] {
        assert!(
            serde_json::from_value::<ExplicitRunClaim>(serde_json::json!({ "door": door, "macroId": MACRO })).is_err(),
            "{door} read as a person's door"
        );
    }
}

// ============================================================================
// 6. The backstop: held code runs only from its button (M6 S5)
// ============================================================================

/// Held code specific enough for the substring check: at least
/// `HELD_CODE_SUBSTRING_MIN_CHARS` characters over at least
/// `HELD_CODE_SUBSTRING_MIN_LINES` lines.
const HELD_LONG: &str = "Calcula.setCellValue(0, 0, 'the application report, held');\nCalcula.log('the report is done');";

/// ONE ordinary line, long enough for the character threshold: a line a user's
/// own program can share with an application's button.
const HELD_ONE_LINE: &str = "const sheetName = Calcula.getActiveSheet().getName();";

/// A subscriber's workbook whose Dashboard B2 holds an application's inline
/// code (not a working copy).
fn holding(code: &str) -> crate::AppState {
    let state = crate::create_app_state();
    {
        let effect = test_seed_effect();
        let mut dashboard = engine::grid::Grid::new();
        dashboard.set_cell(0, 0, engine::Cell::new_text("Sales".to_string()));
        state.grids.write(&effect).unwrap().push(dashboard);
        state.sheet_names.write(&effect).unwrap().push("Dashboard".to_string());
        state.sheet_ids.write(&effect).unwrap().push(sheet_id());
    }
    let mut properties = HashMap::new();
    properties.insert("text".to_string(), prop("Run report"));
    properties.insert(crate::controls::HELD_ON_SELECT_PROPERTY.to_string(), prop(code));
    properties.insert(HELD_FROM_PROPERTY.to_string(), prop(&stamp(APP)));
    state
        .controls
        .write(&test_seed_effect())
        .unwrap()
        .insert((1, 1, 1), ControlMetadata { control_type: "button".into(), properties });
    state
}

fn outside(result: Result<(), String>) -> String {
    let err = result.expect_err("held code ran outside its button");
    assert!(err.starts_with(APPLICATION_CODE_OUTSIDE_ITS_BUTTON), "{err}");
    err
}

/// SABOTAGE (S5 b): skip the backstop in `distributed_run_gate`'s ad-hoc branch
/// (first confirmed: that branch returns `Ok` for every held source).
#[test]
fn run_script_refuses_held_code_verbatim() {
    let state = holding(HELD_LONG);
    let err = outside(gate_as_you(&state, &[], None, HELD_LONG, None));
    assert!(err.contains("Dashboard!B2") && err.contains(&format!("'{APP}'")), "{err}");
    outside(gate_as_you(&state, &[], None, &format!("\n  {HELD_LONG}  \n"), None));
}

/// SABOTAGE (S5 a): match exactly only (drop the `contains` arm).
#[test]
fn run_script_refuses_held_code_with_one_byte_added() {
    let state = holding(HELD_LONG);
    outside(gate_as_you(&state, &[], None, &format!("{HELD_LONG}x"), None));
    outside(gate_as_you(&state, &[], None, &format!("x{HELD_LONG}"), None));
}

/// The splice the old click route made: the user's own modules wrapped and
/// prepended to the button's code.
#[test]
fn run_script_refuses_held_code_inside_the_old_preamble_composition() {
    let state = holding(HELD_LONG);
    let composed = format!("function Helper() {{\nCalcula.log('mine');\n}}\n{HELD_LONG}");
    outside(gate_as_you(&state, &[], None, &composed, None));
}

/// "Copy it to your own" keeps working: a module of the user's own with the
/// same bytes runs, unrecorded.
#[test]
fn a_local_module_with_the_same_bytes_still_runs() {
    let state = holding(HELD_LONG);
    let scripts = vec![(None, "mine".to_string(), HELD_LONG.to_string())];
    gate_as_you(&state, &scripts, None, HELD_LONG, None).expect("the user's own copy runs");
    assert!(refused_rows(&state).is_empty() && run_rows(&state).is_empty());
}

/// A short held snippet is refused only as the WHOLE source: inside the user's
/// own program it is just a call.
#[test]
fn a_short_held_snippet_inside_unrelated_code_is_not_refused() {
    let state = holding("Report()");
    gate_as_you(&state, &[], None, "Calcula.log(1); Report();", None).expect("the user's own program");
    outside(gate_as_you(&state, &[], None, "Report()", None));
    outside(gate_as_you(&state, &[], None, " Report() \n", None));
}

/// Recorded with auditing OFF, naming the button and the application.
#[test]
fn the_refusal_row_is_written_with_auditing_off() {
    let state = holding(HELD_LONG);
    assert!(!state.audit_log.read().unwrap().enabled, "precondition: auditing is off");
    outside(gate_as_you(&state, &[], None, HELD_LONG, None));
    let rows = refused_rows(&state);
    assert_eq!(rows.len(), 1, "{rows:?}");
    assert_eq!(rows[0].extra["reason"], "heldCodeOutsideButton");
    assert_eq!(rows[0].extra["application"], APP);
    assert_eq!(rows[0].extra["macroId"], crate::scripting::control_action::button_action_consent_id(HELD_LONG));
    assert_eq!(rows[0].extra["button"]["cell"], "Dashboard!B2");
    assert_eq!(rows[0].extra["button"]["held"], true);
}

/// The mount door's application-floor-only branch (no artifacts named) is the
/// other place an unnamed source is let through on an application's approval.
#[test]
fn the_mount_door_refuses_it_too() {
    let state = holding(HELD_LONG);
    let consent = consent();
    let composed = format!("/* prelude */\n{HELD_LONG}");
    for phase in [MountGatePhase::RunCheck, MountGatePhase::Mount] {
        let err = mount_run_gate(&state, &[], Some(&consent), APP, &composed, Some("object-script"), None, None, phase, None)
            .expect_err("a floor-only mount of held code");
        assert!(err.starts_with(APPLICATION_CODE_OUTSIDE_ITS_BUTTON), "{err}");
    }
}

/// SABOTAGE (S5 d): apply the substring check to every source -- an APPROVED
/// application module that merely repeats a line of its button's code is then
/// refused.
#[test]
fn an_approved_application_module_whose_source_contains_a_held_snippet_still_runs() {
    let state = holding(HELD_LONG);
    let module = format!("{HELD_LONG}\nCalcula.log('and more');");
    let scripts = vec![(Some(APP.to_string()), MACRO.to_string(), module.clone())];
    let consent = serde_json::json!({
        "version": 2,
        "consents": [{
            "packageName": APP,
            "scripts": [{ "id": MACRO, "sourceHash": calp::integrity::sha256_hex(module.as_bytes()) }],
            "grantedCapabilities": [],
            "grantedAt": "2026-10-01T00:00:00Z",
        }],
    });
    gate_as_you(&state, &scripts, Some(&consent), &module, None).expect("its own approval admits it");
    assert_eq!(run_rows(&state).len(), 1);
}

/// A mount that NAMES its artifacts is held to their exact hashes, and its
/// realm source is composed (prelude + approved body): a substring match there
/// would refuse only approved code.
#[test]
fn an_approved_object_script_mount_whose_composed_source_contains_a_held_snippet_still_mounts() {
    let state = holding(HELD_LONG);
    let body = format!("function setup(context) {{}}\n// {HELD_LONG}");
    let consent = serde_json::json!({
        "version": 2,
        "consents": [{
            "packageName": APP,
            "scripts": [{ "id": "os-1", "sourceHash": calp::integrity::sha256_hex(body.as_bytes()) }],
            "grantedCapabilities": [],
            "grantedAt": "2026-10-01T00:00:00Z",
        }],
    });
    let artifacts = vec![MountConsentArtifact { id: "os-1".into(), source: body.clone() }];
    let composed = format!("/* prelude */\n{body}");
    mount_run_gate(
        &state,
        &[],
        Some(&consent),
        APP,
        &composed,
        Some("object-script"),
        Some(&artifacts),
        None,
        MountGatePhase::RunCheck,
        None,
    )
    .expect("an approved, named mount");
}

#[test]
fn a_floor_only_mount_carrying_held_code_is_refused() {
    let state = holding(HELD_LONG);
    let consent = consent();
    let err = mount_run_gate(
        &state,
        &[],
        Some(&consent),
        APP,
        &format!("/* prelude */\n{HELD_LONG}\n/* more */"),
        Some("object-script"),
        None,
        None,
        MountGatePhase::RunCheck,
        None,
    )
    .expect_err("refused");
    assert!(err.starts_with(APPLICATION_CODE_OUTSIDE_ITS_BUTTON), "{err}");
    assert_eq!(refused_rows(&state)[0].extra["reason"], "heldCodeOutsideButton");
    // A standing realm's per-call check asks only the private-sheet rule.
    mount_run_gate(&state, &[], None, APP, HELD_LONG, Some("object-script"), None, None, MountGatePhase::Standing, None)
        .expect("standing asks nothing else");
}

/// A PUBLISHER MUST NOT BE ABLE TO REFUSE THE USER'S OWN PROGRAM by shipping a
/// common line as button code. One ordinary line the user's program shares
/// with an application's button is not that button's code; the line run ON
/// ITS OWN still is.
///
/// SABOTAGE: drop the line count from `is_specific_held_code` (the 40-character
/// rule alone).
#[test]
fn a_user_program_sharing_one_line_with_held_code_is_not_refused() {
    assert!(HELD_ONE_LINE.chars().count() >= HELD_CODE_SUBSTRING_MIN_CHARS, "precondition: past the character bar");
    let state = holding(HELD_ONE_LINE);
    let program = format!("let total = 1;\n{HELD_ONE_LINE}\nCalcula.log(sheetName + total);");
    gate_as_you(&state, &[], None, &program, None).expect("the user's own program, sharing one line");
    assert!(refused_rows(&state).is_empty(), "the user's own program left a refusal row");
    let err = outside(gate_as_you(&state, &[], None, HELD_ONE_LINE, None));
    assert!(
        err.contains("deleting the application's button") && err.contains("script of your own"),
        "the refusal names no remedy: {err}"
    );
}

/// HELD CODE ONE OF THE USER'S OWN MODULES CARRIES IS THE USER'S TOO (the
/// copy-it-to-your-own rule, and the remedy the refusal names): the old click
/// route's splice over that module, and the bytes on their own, both run.
///
/// SABOTAGE: drop the `own_sources` exemption from
/// `held_code_outside_its_button`.
#[test]
fn held_code_a_users_own_module_carries_is_the_users_too() {
    let state = holding(HELD_LONG);
    let mine = format!("{HELD_LONG}\nCalcula.log('and mine');");
    let scripts = vec![(None, "mine".to_string(), mine.clone())];
    let composed = format!("function Mine() {{\n{mine}\n}}\nMine();");
    gate_as_you(&state, &scripts, None, &composed, None).expect("a splice over the user's own module");
    gate_as_you(&state, &scripts, None, HELD_LONG, None).expect("bytes the user's own module carries");
    assert!(refused_rows(&state).is_empty());
    // An APPLICATION's module carrying it does not make it the user's.
    let theirs = vec![(Some(APP.to_string()), MACRO.to_string(), mine)];
    outside(gate_as_you(&state, &theirs, None, HELD_LONG, None));
}

/// THE NOTEBOOK ROUTE (M6 review): a cell of the user's own notebook, or of no
/// stored notebook, runs as the user's own ad-hoc code -- exactly the
/// `run_script` case -- so it meets the same backstop, and the refusal is on
/// the trail.
///
/// SABOTAGE: make `own_notebook_cell_backstop` return `Ok(())`.
#[test]
fn a_local_or_unknown_notebook_cell_carrying_held_code_is_refused() {
    let state = holding(HELD_LONG);
    let scripts = crate::scripting::types::ScriptState::new();
    let own_cell = |source: &str| crate::scripting::notebook_commands::own_notebook_cell_backstop(&state, &scripts, source);
    let err = own_cell(HELD_LONG).expect_err("a notebook cell ran an application's held button code");
    assert!(err.starts_with(APPLICATION_CODE_OUTSIDE_ITS_BUTTON) && err.contains("Dashboard!B2"), "{err}");
    let rows = refused_rows(&state);
    assert_eq!(rows.len(), 1, "{rows:?}");
    assert_eq!(rows[0].extra["reason"], "heldCodeOutsideButton");
    assert_eq!(rows[0].extra["surface"], "notebook");
    assert_eq!(rows[0].extra["button"]["cell"], "Dashboard!B2");
    // Positive control: the user's own cell runs.
    own_cell("Calcula.log(1 + 1);").expect("an ordinary cell");
    assert_eq!(refused_rows(&state).len(), 1);
}

// ============================================================================
// 7. OWNER DECISION B, follow-up F3: Rust co-decides cell access for a
//    person's run of an application's object-script macro, and NAMES it on the
//    always-on run row.
// ============================================================================

fn claim(door: ExplicitRunDoor) -> ExplicitRunClaim {
    ExplicitRunClaim { door, macro_id: MACRO.to_string() }
}

fn one_artifact() -> Vec<MountConsentArtifact> {
    vec![MountConsentArtifact { id: MACRO.to_string(), source: SRC.to_string() }]
}

/// THE DECISION, pure: every condition that Rust can see, each one alone.
///
/// SABOTAGE: drop the `artifact.source != source` check from
/// `explicit_run_cell_access` -> the composed-prelude row is granted.
#[test]
fn explicit_run_cell_access_needs_a_claim_one_exact_artifact_and_a_door_that_agrees_with_the_trigger() {
    let one = one_artifact();
    let trigger = control_trigger(1, 1, 1);
    let ask = |claim: Option<&ExplicitRunClaim>,
               wire: &str,
               artifacts: Option<&[MountConsentArtifact]>,
               source: &str,
               trigger: Option<&ScriptRunTrigger>,
               verified: bool| explicit_run_cell_access(claim, wire, artifacts, source, trigger, verified);

    // Granted: the Macros dialog and the command line with no button; the
    // button door with the button the store verified.
    for door in [ExplicitRunDoor::MacrosDialog, ExplicitRunDoor::CommandLine] {
        assert_eq!(ask(Some(&claim(door)), "object-script", Some(&one), SRC, None, false), Ok(door), "{door:?}");
    }
    assert_eq!(
        ask(Some(&claim(ExplicitRunDoor::Button)), "object-script", Some(&one), SRC, Some(&trigger), true),
        Ok(ExplicitRunDoor::Button)
    );

    // Refused, each for its own reason.
    let dialog = claim(ExplicitRunDoor::MacrosDialog);
    assert_eq!(ask(None, "object-script", Some(&one), SRC, None, false), Err(NO_PERSONS_DOOR), "no claim");
    assert!(ask(Some(&dialog), "lib", Some(&one), SRC, None, false).is_err(), "another surface");
    assert!(ask(Some(&dialog), "object-script", None, SRC, None, false).is_err(), "no artifacts");
    let two = vec![one[0].clone(), MountConsentArtifact { id: "macro-other".into(), source: "x".into() }];
    assert!(ask(Some(&dialog), "object-script", Some(&two), SRC, None, false).is_err(), "two artifacts");
    let other = ExplicitRunClaim { door: ExplicitRunDoor::MacrosDialog, macro_id: "macro-other".into() };
    assert!(ask(Some(&other), "object-script", Some(&one), SRC, None, false).is_err(), "a pass for another macro");
    let composed = format!("/* prelude */\n{SRC}");
    assert_eq!(
        ask(Some(&dialog), "object-script", Some(&one), &composed, None, false),
        Err("what was about to run is not exactly the approved macro"),
        "the realm runs bytes the approval was not checked against"
    );
    let button = claim(ExplicitRunDoor::Button);
    assert!(ask(Some(&button), "object-script", Some(&one), SRC, None, false).is_err(), "the button door, no button");
    assert!(ask(Some(&button), "object-script", Some(&one), SRC, Some(&trigger), false).is_err(), "unverified");
    for door in [ExplicitRunDoor::MacrosDialog, ExplicitRunDoor::CommandLine] {
        assert!(
            ask(Some(&claim(door)), "object-script", Some(&one), SRC, Some(&trigger), true).is_err(),
            "{door:?} naming a button"
        );
    }
}

/// THE MOUNT DOOR GRANTS ON `runAdmitted` ONLY, opens the grant, and the run
/// row says so: the door, `cellAccess`, `startedBy`, `grantId`, in words too.
///
/// SABOTAGE: drop the `answer.cell_access = true;` line in `mount_run_gate`
/// -> the admitted Macros-dialog run answers no access (while its row says it
/// had it), and this goes red.
#[test]
fn a_persons_run_is_granted_cell_access_at_run_admitted_and_the_run_row_names_the_door() {
    let wc = working_copy(false);
    let one = one_artifact();
    let grants = ExplicitRunGrants::default();
    let dialog = claim(ExplicitRunDoor::MacrosDialog);
    let ask = |phase: MountGatePhase, trigger: Option<&ScriptRunTrigger>, c: Option<&ExplicitRunClaim>| {
        mount_run_gate(
            &wc.state,
            &scripts(),
            Some(&consent()),
            APP,
            SRC,
            Some("object-script"),
            Some(&one),
            trigger,
            phase,
            c.map(|claim| ExplicitRunAsk { claim, grants: &grants }),
        )
    };

    // Before Script Security, and for a standing mount: never a grant, never a row.
    for phase in [MountGatePhase::RunCheck, MountGatePhase::Mount] {
        let answer = ask(phase, None, Some(&dialog)).expect("approved");
        assert!(!answer.cell_access && answer.grant_id.is_none(), "{phase:?} granted cell access");
    }
    assert_eq!(grants.waiting(), 0, "a grant was opened before the run was admitted");
    assert!(run_rows(&wc.state).is_empty());

    // Admitted: granted, with the id of a grant now waiting for its report.
    let answer = ask(MountGatePhase::RunAdmitted, None, Some(&dialog)).expect("admitted");
    assert!(answer.cell_access, "a person's admitted run was not granted cell access");
    let grant_id = answer.grant_id.expect("a granted run names its grant");
    assert_eq!(grants.waiting(), 1);
    let ran = run_rows(&wc.state);
    assert_eq!(ran.len(), 1);
    assert_eq!(ran[0].extra["cellAccess"], true);
    assert_eq!(ran[0].extra["startedBy"], "you");
    assert_eq!(ran[0].extra["door"], "macrosDialog");
    assert_eq!(ran[0].extra["grantId"], grant_id);
    assert!(
        ran[0].description.contains(
            "you started it from Developer > Macros > Run, so it could read and change cells on any sheet"
        ),
        "{}",
        ran[0].description
    );

    // The button door, with the button the store backs: named on the row too.
    let click = control_trigger(wc.dashboard, 1, 1);
    let answer = ask(MountGatePhase::RunAdmitted, Some(&click), Some(&claim(ExplicitRunDoor::Button))).expect("admitted");
    assert!(answer.cell_access);
    let ran = run_rows(&wc.state);
    assert_eq!(ran[1].extra["door"], "button");
    assert_eq!(ran[1].extra["button"]["cell"], "Dashboard!B2");
    assert!(ran[1].description.contains("(button Dashboard!B2 \"Run report\") -- you started it from its button"), "{}", ran[1].description);
    // Each grant has its own id.
    assert_ne!(answer.grant_id, Some(grant_id));
    assert_eq!(grants.waiting(), 2);
}

/// A RUN WITHOUT A PERSON'S DOOR runs restricted, and its row says so -- with
/// why, and with the door the page claimed when Rust could not honour it.
///
/// SABOTAGE: record the mount door's run row without `access` (`None` in place
/// of `access.as_ref()` at the end of `mount_run_gate`) -> the rows no longer
/// say the runs were restricted, or why.
#[test]
fn a_run_without_a_persons_door_is_recorded_as_restricted_and_says_why() {
    let wc = working_copy(false);
    let one = one_artifact();
    let grants = ExplicitRunGrants::default();
    let click = control_trigger(wc.dashboard, 1, 1);

    // A script's runMacro (no claim).
    let answer = mount_run_gate(
        &wc.state, &scripts(), Some(&consent()), APP, SRC, Some("object-script"), Some(&one), None,
        MountGatePhase::RunAdmitted, None,
    )
    .expect("admitted, restricted");
    assert!(!answer.cell_access && answer.grant_id.is_none());
    // A claim that contradicts the trigger: the Macros dialog naming a button.
    let dialog = claim(ExplicitRunDoor::MacrosDialog);
    let answer = mount_run_gate(
        &wc.state, &scripts(), Some(&consent()), APP, SRC, Some("object-script"), Some(&one), Some(&click),
        MountGatePhase::RunAdmitted, Some(ExplicitRunAsk { claim: &dialog, grants: &grants }),
    )
    .expect("admitted, restricted");
    assert!(!answer.cell_access, "a contradiction was granted");
    assert_eq!(grants.waiting(), 0, "a grant was opened for a run that has none");

    let ran = run_rows(&wc.state);
    assert_eq!(ran.len(), 2);
    for row in &ran {
        assert_eq!(row.extra["cellAccess"], false);
        assert_eq!(row.extra["startedBy"], "script");
        assert!(row.extra.get("grantId").is_none() && row.extra.get("door").is_none());
        assert!(row.description.contains("restricted, without cell access, because"), "{}", row.description);
    }
    assert_eq!(ran[0].extra["noCellAccess"], NO_PERSONS_DOOR);
    assert!(ran[0].extra.get("claimedDoor").is_none());
    assert_eq!(ran[1].extra["claimedDoor"], "macrosDialog");
    assert!(ran[1].description.contains("it names a button, but says it was not started by clicking one"));
}

/// THE MODULE RUNTIME'S RUN ROW NAMES THE DOOR TOO (F3 for the other runtime):
/// an application's macro runs there only when a person started it (F10), so
/// its row can say how.
///
/// SABOTAGE: pass `None` for `access` in either `record_run` call of
/// `distributed_run_gate`.
#[test]
fn the_module_runtime_run_row_names_the_persons_door() {
    let wc = working_copy(false);
    distributed_run_gate(
        &wc.state, &scripts(), Some(&consent()), SRC, None, &RunStartedBy::You { door: RunDoor::CommandLine },
    )
    .expect("you typed it");
    let click = control_trigger(wc.dashboard, 1, 1);
    distributed_run_gate(
        &wc.state, &scripts(), Some(&consent()), SRC, Some(&click), &RunStartedBy::You { door: RunDoor::Button },
    )
    .expect("you clicked it");
    let ran = run_rows(&wc.state);
    assert_eq!(ran.len(), 2);
    assert_eq!(ran[0].extra["startedBy"], "you");
    assert_eq!(ran[0].extra["door"], "commandLine");
    assert!(ran[0].description.ends_with("-- you started it from the command line"), "{}", ran[0].description);
    assert_eq!(ran[1].extra["door"], "button");
    assert!(ran[1].description.ends_with("-- you started it from its button"), "{}", ran[1].description);
    // The module runtime has no grant: its reach is its own.
    assert!(ran[0].extra.get("cellAccess").is_none() && ran[0].extra.get("grantId").is_none());
}

/// THE COMMAND HANDS THE GATE THE CLAIM AND THE LEDGER. A door that dropped
/// either would never grant (the page then runs every application macro
/// restricted) -- a regression only the live journey would see.
///
/// SABOTAGE: pass `None` in place of `claimed` at the end of
/// `check_distributed_mount_consent`.
#[test]
fn the_mount_door_hands_the_gate_the_claim_and_the_ledger() {
    let cmds = source("src/scripting/commands.rs");
    let door = body_of(&cmds, "pub fn check_distributed_mount_consent(");
    assert!(door.contains("explicit_run: Option<super::types::ExplicitRunClaim>,"), "the door takes no claim");
    assert!(door.contains("grants: &script_state.explicit_run_grants,"), "the door hands the gate no ledger");
    assert!(door.contains("        phase,\n        claimed,\n    )"), "the door does not pass the claim on");
}
