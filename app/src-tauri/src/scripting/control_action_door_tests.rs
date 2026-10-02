//! FILENAME: app/src-tauri/src/scripting/control_action_door_tests.rs
//! PURPOSE: The Rust button door (M6, phase 4 of BUG-0257): `run_control_action`
//! reads a clicked button's code from the backend's own store, asks whose code
//! it is, asks the approval that showed exactly those bytes, applies the
//! working-copy private-sheet rule, and writes a row for every run and refusal
//! of an application's code -- and only then asks Script Security and hands the
//! source to the interpreter.
//! CONTEXT: The unit tier drives `run_control_action_core` over a seeded
//! `AppState` (the `application_code_gate_tests` pattern) with approvals SEALED
//! through the real writer (`consent_seal::record_script_consent_core`) and read
//! through the real verified reader, so "approved on another computer" is a
//! behaviour here, not a census. The interpreter itself needs Tauri `State`
//! handles and is not run: the door's answer for a run is the exact source it
//! would hand over, which is what the approval is about.

use std::collections::HashMap;
use std::path::Path;

use identity::SheetId;
use serde_json::{json, Value};
use tempfile::TempDir;

use super::*;
use crate::consent_seal::{ConsentScriptInput, RecordScriptConsentRequest};
use crate::controls::{
    ControlMetadata, ControlPropertyValue, HELD_FROM_PROPERTY, HELD_MACRO_REF_PROPERTY, HELD_ON_SELECT_PROPERTY,
    MACRO_REF_PROPERTY, ON_SELECT_PROPERTY,
};
use crate::document_effect::test_seed_effect;
use crate::held_button_code::HeldFrom;
use crate::button_cells::button_command_consent_key;
use crate::persistence::{FileState, UserFilesState};
use crate::scripting::application_code_gate::{
    APPLICATION_CODE_BESIDE_PRIVATE_SHEETS, APPLICATION_CODE_TRIGGER_MISMATCH, APPLICATION_COMMAND_NOT_ALLOWED,
    APPLICATION_COMMAND_NOT_APPROVED,
};
use crate::scripting::commands::{DISTRIBUTED_SCRIPT_NOT_CONSENTED, SCRIPTS_DISABLED, SCRIPT_PROMPT_REQUIRED};
use crate::scripting::types::{
    AuthorizeButtonCommandRequest, ControlActionKind, ControlActionOutcome, RunControlActionRequest, RunScriptResponse,
    ScriptScope, ScriptState, WorkbookScript,
};

const APP: &str = "sales";
const HELD: &str = "Calcula.setCellValue(0, 0, 'from the application');";
const REPORT_ID: &str = "pkg-report";
const REPORT_SRC: &str = "Calcula.setCellValue(1, 1, 'the application report');";

// ============================================================================
// Fixtures
// ============================================================================

/// A workbook with the default blank "Sheet1" (index 0) and the application's
/// "Dashboard" (index 1, holding a cell), its modules, and its user files.
struct Book {
    state: crate::AppState,
    scripts: ScriptState,
    files: UserFilesState,
    dashboard_id: SheetId,
}

fn book() -> Book {
    let state = crate::create_app_state();
    let dashboard_id = SheetId::from_bytes(identity::generate_uuid_v7());
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
    }
    let scripts = ScriptState::new();
    *scripts.security_level.lock().unwrap() = "enabled".to_string();
    Book { state, scripts, files: UserFilesState::default(), dashboard_id }
}

fn prop(value: &str) -> ControlPropertyValue {
    ControlPropertyValue { value_type: "static".into(), value: value.into() }
}

fn stamp_of(application: &str, value_types: &[(&str, &str)]) -> String {
    HeldFrom {
        workspace: "ws".into(),
        application: application.into(),
        version: "1.0.0".into(),
        value_types: value_types.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect(),
    }
    .encode()
}

/// A button control holding its application's inline code.
fn held_button(code: &str, application: &str) -> ControlMetadata {
    let mut properties = HashMap::new();
    properties.insert("text".to_string(), prop("Run report"));
    properties.insert(ON_SELECT_PROPERTY.to_string(), prop(""));
    properties.insert(HELD_ON_SELECT_PROPERTY.to_string(), prop(code));
    properties.insert(HELD_FROM_PROPERTY.to_string(), prop(&stamp_of(application, &[])));
    ControlMetadata { control_type: "button".into(), properties }
}

/// A button control with inline code of the user's own.
fn own_button(code: &str) -> ControlMetadata {
    let mut properties = HashMap::new();
    properties.insert("text".to_string(), prop("Mine"));
    properties.insert(ON_SELECT_PROPERTY.to_string(), prop(code));
    ControlMetadata { control_type: "button".into(), properties }
}

impl Book {
    fn control(&self, row: u32, col: u32, meta: ControlMetadata) {
        self.state.controls.write(&test_seed_effect()).unwrap().insert((1, row, col), meta);
    }

    fn cell(&self, row: u32, col: u32, params: Value) {
        self.state.cell_types.write(&test_seed_effect()).unwrap().insert(
            (1, row, col),
            crate::cell_types::CellTypeAssignment { type_id: crate::button_cells::BUTTON_CELL_TYPE_ID.to_string(), params },
        );
    }

    fn module(&self, id: &str, name: &str, source: &str, package: Option<&str>, description: Option<&str>) {
        self.scripts.workbook_scripts.write(&test_seed_effect()).unwrap().insert(
            id.to_string(),
            WorkbookScript {
                id: id.to_string(),
                name: name.to_string(),
                description: description.map(str::to_string),
                source: source.to_string(),
                scope: ScriptScope::Workbook,
                source_package: package.map(str::to_string),
            },
        );
    }

    /// Approve, through the REAL sealed writer on this computer (the test
    /// process's profile, or the one `with_test_profile` names).
    fn approve(&self, application: &str, items: &[(&str, &str)]) {
        crate::consent_seal::record_script_consent_core(
            &self.files,
            &FileState::default(),
            RecordScriptConsentRequest {
                package_name: application.to_string(),
                scripts: items
                    .iter()
                    .map(|(id, source)| ConsentScriptInput { id: id.to_string(), source: source.to_string() })
                    .collect(),
                granted_capabilities: Vec::new(),
            },
        )
        .expect("the approval is sealed");
    }

    /// Approve an application's button COMMANDS, as the approval screen does:
    /// under `button-commands:<application>` (read through the key former, so a
    /// sabotaged key reaches this record too), each id with its own bytes.
    fn approve_commands(&self, application: &str, ids: &[&str]) {
        let items: Vec<(&str, &str)> = ids.iter().map(|id| (*id, *id)).collect();
        self.approve(&button_command_consent_key(application), &items);
    }

    fn click(&self, kind: ControlActionKind, row: u32, col: u32) -> Result<DoorAnswer, String> {
        run_control_action_core(
            &self.state,
            &self.scripts,
            &self.files,
            &RunControlActionRequest { kind, sheet_index: 1, row, col, view_state: None },
        )
    }

    /// Make the workbook a working copy of APP over Dashboard; with `private`,
    /// the developer's own "Salaries" holds a cell beside it.
    fn working_copy(&self, private: bool) {
        if private {
            let effect = test_seed_effect();
            let mut salaries = engine::grid::Grid::new();
            salaries.set_cell(0, 0, engine::Cell::new_number(120_000.0));
            self.state.grids.write(&effect).unwrap().push(salaries);
            self.state.sheet_names.write(&effect).unwrap().push("Salaries".to_string());
            self.state.sheet_ids.write(&effect).unwrap().push(SheetId::from_bytes(identity::generate_uuid_v7()));
        }
        *self.state.working_copy_link.write(&test_seed_effect()).unwrap() = Some(calp::WorkingCopyLink::new(
            r"\\server\reports",
            APP,
            "report",
            "1.0.0",
            "2026-10-01T00:00:00Z",
            vec![calp::WorkingCopySheetRef { sheet_id: self.dashboard_id, name: "Dashboard".to_string() }],
        ));
    }

    fn rows(&self, event: fn(&calp::audit::AuditEvent) -> bool) -> Vec<calp::audit::AuditEntry> {
        self.state.audit_log.read().unwrap().entries.iter().filter(|e| event(&e.event)).cloned().collect()
    }

    fn run_rows(&self) -> Vec<calp::audit::AuditEntry> {
        self.rows(|e| matches!(e, calp::audit::AuditEvent::ApplicationCodeRun))
    }

    fn refused_rows(&self) -> Vec<calp::audit::AuditEntry> {
        self.rows(|e| matches!(e, calp::audit::AuditEvent::ApplicationCodeRefused))
    }

    fn button_code_rows(&self) -> Vec<calp::audit::AuditEntry> {
        self.rows(|e| matches!(e, calp::audit::AuditEvent::ButtonCodeRefused))
    }

    fn application_rows(&self) -> usize {
        self.run_rows().len() + self.refused_rows().len()
    }
}

fn sha(text: &str) -> String {
    calp::integrity::sha256_hex(text.as_bytes())
}

/// The click the door would hand the interpreter; panics on any other answer.
fn ran(answer: DoorAnswer) -> ApprovedClick {
    match answer {
        DoorAnswer::Run(click) => click,
        DoorAnswer::Answer(outcome) => panic!("expected a run, got {outcome:?}"),
    }
}

fn answered(answer: DoorAnswer) -> ControlActionOutcome {
    match answer {
        DoorAnswer::Answer(outcome) => outcome,
        DoorAnswer::Run(click) => panic!("expected an answer, got a run of {:?}", click.source),
    }
}

fn refused(answer: DoorAnswer) -> (String, String) {
    match answered(answer) {
        ControlActionOutcome::Refused { reason, message } => (reason, message),
        other => panic!("expected a refusal, got {other:?}"),
    }
}

use ControlActionKind::{Cell, Control};

// ============================================================================
// 1. Held inline code: approved by hash, or nothing runs
// ============================================================================

/// SABOTAGE (S4 a): skip the held bytes' approval question in `button_run_gate`.
#[test]
fn a_held_inline_action_is_refused_until_approved_and_the_refusal_names_button_and_application_with_auditing_off() {
    let b = book();
    b.control(1, 1, held_button(HELD, APP));
    assert!(!b.state.audit_log.read().unwrap().enabled, "precondition: auditing is off");
    let (reason, message) = refused(b.click(Control, 1, 1).unwrap());
    assert_eq!(reason, "notConsented");
    assert!(message.starts_with(DISTRIBUTED_SCRIPT_NOT_CONSENTED), "{message}");
    assert!(message.contains("Dashboard!B2") && message.contains(&format!("'{APP}'")), "{message}");
    assert!(message.contains("next time this workbook is opened"), "the refusal says when the approval screen returns: {message}");
    assert!(b.run_rows().is_empty(), "nothing ran");
    let rows = b.refused_rows();
    assert_eq!(rows.len(), 1, "{rows:?}");
    let row = &rows[0];
    assert_eq!(row.extra["reason"], "notConsented");
    assert_eq!(row.extra["surface"], "button");
    assert_eq!(row.extra["application"], APP);
    assert_eq!(row.extra["macroId"], button_action_consent_id(HELD));
    assert_eq!(row.extra["button"]["cell"], "Dashboard!B2");
    assert_eq!(row.extra["button"]["caption"], "Run report");
    assert_eq!(row.extra["button"]["application"], APP);
    assert_eq!(row.extra["button"]["held"], true);
}

/// SABOTAGE (S4 b): plan held code with `plan_own_inline` -- the user's own
/// modules are prepended and the bytes that run are no longer the bytes
/// approved.
#[test]
fn once_approved_the_decision_runs_exactly_the_stored_bytes_and_one_run_row_names_the_button() {
    let b = book();
    b.module("local-helper", "Helper", "Calcula.log('mine');", None, None);
    b.control(1, 1, held_button(HELD, APP));
    b.approve(APP, &[(&button_action_consent_id(HELD), HELD)]);
    let click = ran(b.click(Control, 1, 1).unwrap());
    assert_eq!(click.source.as_bytes(), HELD.as_bytes(), "held code runs byte for byte");
    assert_eq!(click.surface_id, "Dashboard!B2");
    assert_eq!(click.filename, "button_Dashboard_B2.js");
    let rows = b.run_rows();
    assert_eq!(rows.len(), 1, "{rows:?}");
    let row = &rows[0];
    assert_eq!(row.extra["surface"], "button");
    assert_eq!(row.extra["application"], APP);
    assert_eq!(row.extra["macroId"], button_action_consent_id(HELD));
    assert_eq!(row.extra["sourceHash"], sha(HELD));
    assert_eq!(row.extra["button"]["cell"], "Dashboard!B2");
    assert_eq!(row.extra["button"]["caption"], "Run report");
    assert!(row.description.contains("Dashboard!B2"), "{}", row.description);
    // THE ROW NAMES ITS DOOR (review of M6b), like the module runtime's and the
    // mount door's run rows: a reader filtering the trail by `door` / `startedBy`
    // sees every button run of an application's code -- held inline code and
    // `Name()` calls included, which run with the module runtime's full reach.
    // SABOTAGE: pass `None` for the access in `record_button_run` -> red.
    assert_eq!(row.extra["startedBy"], "you", "{row:?}");
    assert_eq!(row.extra["door"], "button", "{row:?}");
    assert!(row.extra.get("cellAccess").is_none(), "a module-runtime run row claims a cell grant: {row:?}");
    assert!(row.description.ends_with(" -- you started it from its button"), "{}", row.description);
    assert!(b.refused_rows().is_empty());
}

#[test]
fn an_approval_of_other_bytes_does_not_run_it() {
    // An approval of DIFFERENT bytes.
    let b = book();
    b.control(1, 1, held_button(HELD, APP));
    let other = format!("{HELD} ");
    b.approve(APP, &[(&button_action_consent_id(&other), &other)]);
    assert_eq!(refused(b.click(Control, 1, 1).unwrap()).0, "notConsented");
    // The right id, but over other bytes: the sealed writer refuses to record
    // it at all (an id of button code names its bytes), so nothing can be
    // approved that way -- and nothing runs.
    let b = book();
    b.control(1, 1, held_button(HELD, APP));
    let mismatched = crate::consent_seal::record_script_consent_core(
        &b.files,
        &FileState::default(),
        RecordScriptConsentRequest {
            package_name: APP.to_string(),
            scripts: vec![ConsentScriptInput { id: button_action_consent_id(HELD), source: other.clone() }],
            granted_capabilities: Vec::new(),
        },
    );
    assert!(mismatched.is_err(), "an approval of other bytes under this code's id was sealed");
    assert_eq!(refused(b.click(Control, 1, 1).unwrap()).0, "notConsented");
    // The right bytes, under another application's name.
    let b = book();
    b.control(1, 1, held_button(HELD, APP));
    b.approve("hr", &[(&button_action_consent_id(HELD), HELD)]);
    assert_eq!(refused(b.click(Control, 1, 1).unwrap()).0, "notConsented");
    assert!(b.run_rows().is_empty());
}

/// An approval travels inside the workbook; the key that sealed it does not.
/// A record another computer sealed counts for nothing here -- and on that
/// computer, the same workbook runs.
#[test]
fn an_approval_sealed_on_another_computer_does_not_run_it() {
    let b = book();
    b.control(1, 1, held_button(HELD, APP));
    let elsewhere = TempDir::new().unwrap();
    crate::profile_dir::with_test_profile(elsewhere.path(), || {
        b.approve(APP, &[(&button_action_consent_id(HELD), HELD)])
    });
    assert_eq!(refused(b.click(Control, 1, 1).unwrap()).0, "notConsented");
    let click = crate::profile_dir::with_test_profile(elsewhere.path(), || ran(b.click(Control, 1, 1).unwrap()));
    assert_eq!(click.source, HELD);
}

/// SABOTAGE (S4 c): drop the private-sheet step from `button_run_gate`.
#[test]
fn held_code_beside_a_private_sheet_is_refused() {
    let b = book();
    b.control(1, 1, held_button(HELD, APP));
    b.approve(APP, &[(&button_action_consent_id(HELD), HELD)]);
    b.working_copy(true);
    let (reason, message) = refused(b.click(Control, 1, 1).unwrap());
    assert_eq!(reason, "privateSheets");
    assert!(message.starts_with(APPLICATION_CODE_BESIDE_PRIVATE_SHEETS) && message.contains("Salaries"), "{message}");
    let rows = b.refused_rows();
    assert_eq!(rows.len(), 1, "{rows:?}");
    assert_eq!(rows[0].extra["reason"], "privateSheets");
    assert_eq!(rows[0].extra["privateSheets"], json!(["Salaries"]));
    assert_eq!(rows[0].extra["button"]["cell"], "Dashboard!B2");
    assert!(b.run_rows().is_empty());
    // Positive control: the same working copy without the private sheet runs.
    let clean = book();
    clean.control(1, 1, held_button(HELD, APP));
    clean.approve(APP, &[(&button_action_consent_id(HELD), HELD)]);
    clean.working_copy(false);
    assert_eq!(ran(clean.click(Control, 1, 1).unwrap()).source, HELD);
}

#[test]
fn a_live_or_held_link_answers_link_and_runs_nothing() {
    let b = book();
    let mut live = own_button("Calcula.log('never');");
    live.properties.insert(MACRO_REF_PROPERTY.to_string(), prop("macro-mine"));
    b.control(1, 1, live);
    let mut held = held_button(HELD, APP);
    held.properties.insert(HELD_MACRO_REF_PROPERTY.to_string(), prop("macro-report"));
    b.control(2, 2, held);
    for (row, col) in [(1, 1), (2, 2)] {
        assert!(matches!(answered(b.click(Control, row, col).unwrap()), ControlActionOutcome::Link));
    }
    assert_eq!(b.application_rows(), 0);
    assert!(b.button_code_rows().is_empty());
}

/// D6: the user's own inline code keeps its preamble and writes no
/// application row (its `ScriptExecuted` rows name the button instead).
#[test]
fn own_inline_code_plans_with_the_preamble_and_writes_no_application_row() {
    let b = book();
    b.module("local-helper", "Helper", "Calcula.log('mine');", None, None);
    b.control(1, 1, own_button("Helper();"));
    let click = ran(b.click(Control, 1, 1).unwrap());
    assert_eq!(click.source, "function Helper() {\nCalcula.log('mine');\n}\nHelper();");
    assert_eq!(click.surface_id, "Dashboard!B2");
    assert_eq!(b.application_rows(), 0);
    // Nothing on the button: nothing to run, and the page goes on to its
    // object-script diagnosis.
    b.control(3, 3, own_button(""));
    assert!(matches!(answered(b.click(Control, 3, 3).unwrap()), ControlActionOutcome::Nothing { message: None }));
    assert!(matches!(answered(b.click(Control, 9, 9).unwrap()), ControlActionOutcome::Nothing { message: None }));
}

#[test]
fn an_unreadable_stamp_or_a_formula_typed_held_slot_is_refused_with_a_button_code_refused_row() {
    let b = book();
    let mut broken = held_button(HELD, APP);
    broken.properties.insert(HELD_FROM_PROPERTY.to_string(), prop("{not json"));
    b.control(1, 1, broken);
    let mut formula = held_button(HELD, APP);
    formula.properties.insert(HELD_FROM_PROPERTY.to_string(), prop(&stamp_of(APP, &[(ON_SELECT_PROPERTY, "formula")])));
    b.control(2, 2, formula);
    // An approval of those very bytes changes nothing: these are refusals of
    // the button, not of its approval.
    b.approve(APP, &[(&button_action_consent_id(HELD), HELD)]);
    let (reason, _) = refused(b.click(Control, 1, 1).unwrap());
    assert_eq!(reason, "stampUnreadable");
    let (reason, message) = refused(b.click(Control, 2, 2).unwrap());
    assert_eq!(reason, "unsupportedValueType");
    assert!(message.contains("formula"), "{message}");
    let rows = b.button_code_rows();
    assert_eq!(rows.len(), 2, "{rows:?}");
    assert_eq!(rows[0].extra["reason"], "stampUnreadable");
    assert_eq!(rows[0].extra["stampUnreadable"], true);
    assert_eq!(rows[0].extra["door"], "click");
    assert_eq!(rows[1].extra["reason"], "unsupportedValueType");
    assert_eq!(rows[1].extra["application"], APP);
    assert_eq!(rows[1].extra["cells"], json!(["Dashboard!C3"]));
    assert!(b.run_rows().is_empty());
}

/// Only a button runs code when it is clicked (Controls/index.ts), but the
/// admission holds ANY control's code for a faithful push. A click on a shape
/// that holds an application's code runs nothing, approval or not.
#[test]
fn a_shape_with_a_held_on_select_runs_nothing() {
    let b = book();
    let mut shape = held_button(HELD, APP);
    shape.control_type = "shape".into();
    b.control(1, 1, shape);
    b.approve(APP, &[(&button_action_consent_id(HELD), HELD)]);
    let (reason, _) = refused(b.click(Control, 1, 1).unwrap());
    assert_eq!(reason, "notAButton");
    assert_eq!(b.button_code_rows().len(), 1);
    assert!(b.run_rows().is_empty());
}

// ============================================================================
// 2. Whose code it is: the gate is asked of the FINAL source
// ============================================================================

/// THE MISSING DOOR. The button door hands its source to the interpreter
/// directly, so `run_script`'s gate is not on the path: the user's OWN
/// `Report()` that delegates to an application module must still meet that
/// module's approval -- and its rows.
///
/// SABOTAGE (S4 f): let the user's own code skip the gate (`held.is_none()` =>
/// `Own` at the top of `button_run_gate`).
#[test]
fn an_own_name_that_delegates_to_an_application_module_is_refused_until_that_module_is_approved() {
    let b = book();
    b.module(REPORT_ID, "Report", REPORT_SRC, Some(APP), None);
    b.control(1, 1, own_button("Report()"));
    let (reason, message) = refused(b.click(Control, 1, 1).unwrap());
    assert_eq!(reason, "notConsented");
    assert!(message.starts_with(DISTRIBUTED_SCRIPT_NOT_CONSENTED), "{message}");
    let rows = b.refused_rows();
    assert_eq!(rows.len(), 1, "{rows:?}");
    assert_eq!(rows[0].extra["application"], APP);
    assert_eq!(rows[0].extra["macroId"], REPORT_ID);
    assert_eq!(rows[0].extra["button"]["cell"], "Dashboard!B2");
    assert_eq!(rows[0].extra["button"]["application"], Value::Null, "the button is the user's own");
    assert!(b.run_rows().is_empty());

    b.approve(APP, &[(REPORT_ID, REPORT_SRC)]);
    let click = ran(b.click(Control, 1, 1).unwrap());
    assert_eq!(click.source, REPORT_SRC, "the module's stored bytes, verbatim");
    let rows = b.run_rows();
    assert_eq!(rows.len(), 1, "{rows:?}");
    assert_eq!(rows[0].extra["application"], APP);
    assert_eq!(rows[0].extra["macroId"], REPORT_ID);
    assert_eq!(rows[0].extra["sourceHash"], sha(REPORT_SRC));
}

/// A held `Name()` needs BOTH approvals (D4): the button action's and the
/// module's -- one screen grants both, but neither stands in for the other.
#[test]
fn a_held_name_needs_the_button_actions_approval_and_the_modules() {
    let b = book();
    b.module(REPORT_ID, "Report", REPORT_SRC, Some(APP), None);
    b.control(1, 1, held_button("Report()", APP));
    b.approve(APP, &[(&button_action_consent_id("Report()"), "Report()")]);
    assert_eq!(refused(b.click(Control, 1, 1).unwrap()).0, "notConsented", "the module is not approved");
    b.approve(APP, &[(REPORT_ID, REPORT_SRC)]);
    assert_eq!(refused(b.click(Control, 1, 1).unwrap()).0, "notConsented", "a newer record replaced the button's approval");
    b.approve(APP, &[(&button_action_consent_id("Report()"), "Report()"), (REPORT_ID, REPORT_SRC)]);
    let click = ran(b.click(Control, 1, 1).unwrap());
    assert_eq!(click.source, REPORT_SRC);
    let row = &b.run_rows()[0];
    assert_eq!(row.extra["macroId"], button_action_consent_id("Report()"));
    assert_eq!(row.extra["artifactIds"], json!([button_action_consent_id("Report()"), REPORT_ID]));
}

#[test]
fn an_own_button_cell_naming_an_unapproved_application_module_is_refused_and_audited() {
    let b = book();
    b.module(REPORT_ID, "Report", REPORT_SRC, Some(APP), None);
    b.cell(4, 4, json!({ "label": "Go", "action": { "kind": "script", "scriptId": REPORT_ID } }));
    let (reason, _) = refused(b.click(Cell, 4, 4).unwrap());
    assert_eq!(reason, "notConsented");
    let rows = b.refused_rows();
    assert_eq!(rows.len(), 1, "{rows:?}");
    assert_eq!(rows[0].extra["button"]["kind"], "cell");
    assert_eq!(rows[0].extra["button"]["cell"], "Dashboard!E5");
    assert_eq!(rows[0].extra["button"]["caption"], "Go");
    b.approve(APP, &[(REPORT_ID, REPORT_SRC)]);
    assert_eq!(ran(b.click(Cell, 4, 4).unwrap()).source, REPORT_SRC);
    assert_eq!(b.run_rows().len(), 1);
}

#[test]
fn in_a_working_copy_an_own_name_of_an_application_module_meets_the_private_sheet_rule() {
    let b = book();
    b.module(REPORT_ID, "Report", REPORT_SRC, Some(APP), None);
    b.control(1, 1, own_button("Report()"));
    b.approve(APP, &[(REPORT_ID, REPORT_SRC)]);
    b.working_copy(true);
    let (reason, _) = refused(b.click(Control, 1, 1).unwrap());
    assert_eq!(reason, "privateSheets");
    assert_eq!(b.refused_rows()[0].extra["privateSheets"], json!(["Salaries"]));
}

/// Owner decision Q1: a button that calls, by name, a macro that runs as an
/// object script is refused by name, and -- when the macro came with an
/// application -- the refusal is on the trail.
#[test]
fn an_object_script_runtime_target_is_refused_by_name_with_a_row_for_application_code() {
    let b = book();
    let recorded = "Recorded macro \u{b7} runtime=objectScript \u{b7} 2 actions";
    b.module(REPORT_ID, "Report", "function setup(context) {}", Some(APP), Some(recorded));
    b.module("local-mine", "Mine", "function setup(context) {}", None, Some(recorded));
    b.control(1, 1, held_button("Report()", APP));
    b.control(2, 2, own_button("Report()"));
    b.control(3, 3, own_button("Mine()"));
    b.approve(APP, &[(&button_action_consent_id("Report()"), "Report()"), (REPORT_ID, "function setup(context) {}")]);

    let (reason, message) = refused(b.click(Control, 1, 1).unwrap());
    assert_eq!(reason, "objectScriptMacro");
    assert!(message.starts_with("Report runs as an object script") && message.contains("Properties > Macro"), "{message}");
    let (reason, _) = refused(b.click(Control, 2, 2).unwrap());
    assert_eq!(reason, "objectScriptMacro");
    let rows = b.refused_rows();
    assert_eq!(rows.len(), 2, "one row per refusal of application code: {rows:?}");
    assert!(rows.iter().all(|r| r.extra["reason"] == "objectScriptMacro" && r.extra["application"] == APP));
    assert_eq!(rows[0].extra["artifactIds"], json!([button_action_consent_id("Report()"), REPORT_ID]));
    // The user's own recorded macro, called by name from the user's own button:
    // refused by name, and nothing of an application's was asked for.
    let (reason, _) = refused(b.click(Control, 3, 3).unwrap());
    assert_eq!(reason, "objectScriptMacro");
    assert_eq!(b.refused_rows().len(), 2);
    assert!(b.run_rows().is_empty());
}

// ============================================================================
// 3. Button cells
// ============================================================================

fn stamped(action: Value) -> Value {
    json!({
        "label": "Go",
        "action": action,
        "fromApplication": { "workspace": "ws", "application": APP, "version": "1.0.0" }
    })
}

#[test]
fn a_stamped_cell_naming_a_macro_of_another_source_is_refused_and_audited() {
    let b = book();
    b.module("macro-mine", "Mine", "Exfiltrate();", None, None);
    b.cell(1, 1, stamped(json!({ "kind": "script", "scriptId": "macro-mine" })));
    let (reason, message) = refused(b.click(Cell, 1, 1).unwrap());
    assert_eq!(reason, "macroNotFromApplication");
    assert!(message.contains("is one of your own"), "{message}");
    let rows = b.button_code_rows();
    assert_eq!(rows.len(), 1, "{rows:?}");
    assert_eq!(rows[0].extra["kind"], "cell");
    assert_eq!(rows[0].extra["application"], APP);
    assert_eq!(rows[0].extra["cells"], json!(["Dashboard!B2"]));
    assert_eq!(rows[0].extra["refused"], "the macro \"Mine\"");
    assert_eq!(rows[0].extra["reason"], "macroNotFromApplication");
    assert!(b.run_rows().is_empty());
}

/// A stamped command NOT on Calcula's list (the production list is empty) is
/// refused by the command gate -- approved or not -- and the refusal is on the
/// trail as an application's command, naming the button. The user's own
/// command is the page's to run, and writes nothing.
///
/// SABOTAGE: skip the gate's list step -> the approved click answers
/// `command`, red.
#[test]
fn a_stamped_command_not_on_the_list_is_refused_and_audited_and_the_users_own_command_is_a_directive() {
    let b = book();
    b.cell(1, 1, stamped(json!({ "kind": "command", "commandId": "format.bold" })));
    b.cell(2, 2, json!({ "label": "Bold", "action": { "kind": "command", "commandId": "format.bold" } }));
    let (reason, message) = refused(b.click(Cell, 1, 1).unwrap());
    assert_eq!(reason, "notAllowlisted");
    assert!(message.starts_with(APPLICATION_COMMAND_NOT_ALLOWED), "{message}");
    assert!(message.contains("not on Calcula's list") && message.contains("Dashboard!B2"), "{message}");
    let rows = b.refused_rows();
    assert_eq!(rows.len(), 1, "{rows:?}");
    let row = &rows[0];
    assert_eq!(row.extra["reason"], "notAllowlisted");
    assert_eq!(row.extra["surface"], "buttonCommand");
    assert_eq!(row.extra["application"], APP);
    assert_eq!(row.extra["commandId"], "format.bold");
    assert!(row.extra.get("macroId").is_none(), "a command is recorded as a macro: {:?}", row.extra);
    assert_eq!(row.extra["button"]["kind"], "cell");
    assert_eq!(row.extra["button"]["cell"], "Dashboard!B2");
    assert_eq!(row.extra["button"]["caption"], "Go");
    assert_eq!(row.extra["button"]["application"], APP);
    assert!(b.button_code_rows().is_empty(), "the command gate's refusal is not a button-shape refusal");
    // An approval under the command's own key changes nothing: the list comes first.
    b.approve_commands(APP, &["format.bold"]);
    assert_eq!(refused(b.click(Cell, 1, 1).unwrap()).0, "notAllowlisted");
    assert_eq!(b.refused_rows().len(), 2);
    match answered(b.click(Cell, 2, 2).unwrap()) {
        ControlActionOutcome::Command { command_id, application } => {
            assert_eq!(command_id, "format.bold");
            assert_eq!(application, None, "the user's own command named an application");
        }
        other => panic!("the user's own command is the page's to run: {other:?}"),
    }
    assert_eq!(b.refused_rows().len(), 2, "the user's own command writes nothing");
    assert!(b.run_rows().is_empty());
}

#[test]
fn the_function_name_is_composed_only_for_a_local_module() {
    let b = book();
    b.module("local-tools", "Tools", "function Go() { x(); }", None, None);
    b.module(REPORT_ID, "Report", REPORT_SRC, Some(APP), None);
    b.approve(APP, &[(REPORT_ID, REPORT_SRC)]);
    b.cell(1, 1, json!({ "action": { "kind": "script", "scriptId": "local-tools", "functionName": "Go" } }));
    b.cell(2, 2, json!({ "action": { "kind": "script", "scriptId": REPORT_ID, "functionName": "Go" } }));
    assert_eq!(ran(b.click(Cell, 1, 1).unwrap()).source, "function Go() { x(); }\nGo();");
    assert_eq!(b.application_rows(), 0, "the user's own composition is the user's own code");
    let (reason, _) = refused(b.click(Cell, 2, 2).unwrap());
    assert_eq!(reason, "composesApplicationCode");
    let rows = b.refused_rows();
    assert_eq!(rows.len(), 1, "a refusal to compose an application's code is on the trail: {rows:?}");
    assert_eq!(rows[0].extra["application"], APP);
    assert_eq!(rows[0].extra["macroId"], REPORT_ID);
}

// ----------------------------------------------------------------------------
// 3b. A button cell's object-script macro: the macro seam's (owner decision B,
//     follow-up F6)
// ----------------------------------------------------------------------------

const RECORDED: &str = "Recorded macro \u{b7} runtime=objectScript \u{b7} 1 action";
const RECORDED_SRC: &str = "function setup(context) { return context.api.setCellValue(0, 0, 'recorded'); }";

/// The macro a `Macro` answer names, and the application it carries.
fn macro_answer(answer: DoorAnswer) -> (String, Option<String>) {
    match answered(answer) {
        ControlActionOutcome::Macro { macro_id, application } => (macro_id, application),
        other => panic!("expected the macro seam's answer, got {other:?}"),
    }
}

/// A button cell whose action is a recorded (object-script) macro used to be
/// REFUSED ("a button cell cannot run it"): this door's interpreter has no
/// `api`. Now the door answers `Macro`, naming the macro and the BUTTON's stamp,
/// runs nothing and records nothing -- the seam's run is gated and recorded by
/// the mount door -- and answers it BEFORE Script Security, which the seam's
/// mount asks itself (as a link is).
///
/// SABOTAGE: make `plan_cell_action` refuse an object-script module again ->
/// the first click answers `Refused`, red.
#[test]
fn a_button_cell_running_an_object_script_macro_answers_macro_for_the_seam_and_runs_and_records_nothing() {
    let b = book();
    *b.scripts.security_level.lock().unwrap() = "disabled".to_string();
    b.module(REPORT_ID, "Report", RECORDED_SRC, Some(APP), Some(RECORDED));
    b.module("local-mine", "Mine", RECORDED_SRC, None, Some(RECORDED));
    b.cell(1, 1, stamped(json!({ "kind": "script", "scriptId": REPORT_ID })));
    b.cell(2, 2, json!({ "label": "Mine", "action": { "kind": "script", "scriptId": "local-mine" } }));
    b.cell(3, 3, json!({ "label": "Theirs", "action": { "kind": "script", "scriptId": REPORT_ID } }));
    assert_eq!(macro_answer(b.click(Cell, 1, 1).unwrap()), (REPORT_ID.to_string(), Some(APP.to_string())));
    assert_eq!(macro_answer(b.click(Cell, 2, 2).unwrap()), ("local-mine".to_string(), None));
    assert_eq!(macro_answer(b.click(Cell, 3, 3).unwrap()), (REPORT_ID.to_string(), None));
    assert_eq!(b.application_rows(), 0, "the door recorded a run it did not make");
    assert!(b.button_code_rows().is_empty());
    // A "Function to call" inside one is refused, and -- the code being the
    // application's -- on the trail.
    b.cell(4, 4, stamped(json!({ "kind": "script", "scriptId": REPORT_ID, "functionName": "Go" })));
    let (reason, message) = refused(b.click(Cell, 4, 4).unwrap());
    assert_eq!(reason, "objectScriptMacro");
    assert!(message.contains("runs it as a whole macro"), "{message}");
    assert_eq!(b.refused_rows().len(), 1);
    // A working copy's HELD cell action is still refused before anything else.
    b.cell(5, 5, json!({
        "label": "Held",
        "heldAction": { "kind": "script", "scriptId": REPORT_ID },
        "fromApplication": { "workspace": "ws", "application": APP, "version": "1.0.0" }
    }));
    assert_eq!(refused(b.click(Cell, 5, 5).unwrap()).0, "heldInWorkingCopy");
}

/// THE DOOR AND THE TRIGGER AGREE. The page runs a `Macro` answer through the
/// macro seam with a `buttonCell` trigger at the cell it clicked, and the run
/// gate verifies that trigger against this same store (`verify_trigger`) on
/// runCheck and runAdmitted. So every `Macro` answer must be one the gate then
/// accepts for that cell and macro -- under the BUTTON's stamp when it has one --
/// and nothing else may pass: another cell, the control kind, another macro.
///
/// SABOTAGE: answer `application: None` for a stamped cell in `decide_cell` ->
/// the attribution's application and the answer disagree, red.
#[test]
fn the_macro_answer_and_the_trigger_the_page_builds_from_it_agree() {
    use crate::scripting::application_code_gate::verify_trigger;
    use crate::scripting::types::{ScriptRunTrigger, ScriptRunTriggerKind};
    let b = book();
    b.module(REPORT_ID, "Report", RECORDED_SRC, Some(APP), Some(RECORDED));
    b.cell(1, 1, stamped(json!({ "kind": "script", "scriptId": REPORT_ID })));
    b.cell(3, 3, json!({ "label": "Theirs", "action": { "kind": "script", "scriptId": REPORT_ID } }));
    let cell = |row: u32, col: u32| ScriptRunTrigger { kind: ScriptRunTriggerKind::ButtonCell, sheet_index: 1, row, col };
    for (row, col, label) in [(1u32, 1u32, "Dashboard!B2"), (3, 3, "Dashboard!D4")] {
        let (macro_id, application) = macro_answer(b.click(Cell, row, col).unwrap());
        let button = verify_trigger(&b.state, &cell(row, col), APP, &[macro_id.as_str()])
            .unwrap_or_else(|why| panic!("the gate refuses the trigger the door's answer implies: {why}"));
        assert_eq!(button.cell, label);
        assert_eq!(button.application, application, "the door and the gate name different applications");
        assert!(!button.held);
    }
    // Nothing else passes as that click.
    assert!(verify_trigger(&b.state, &cell(2, 2), APP, &[REPORT_ID]).is_err(), "an empty cell passed");
    let control = ScriptRunTrigger { kind: ScriptRunTriggerKind::ButtonControl, sheet_index: 1, row: 1, col: 1 };
    assert!(verify_trigger(&b.state, &control, APP, &[REPORT_ID]).is_err(), "a button CELL passed as a control");
    assert!(verify_trigger(&b.state, &cell(1, 1), APP, &["macro-other"]).is_err(), "another macro passed");
    assert!(verify_trigger(&b.state, &cell(1, 1), "hr", &[REPORT_ID]).is_err(), "another application passed");
}

#[test]
fn a_held_cell_action_is_refused_held_in_working_copy_and_audited() {
    let b = book();
    b.module(REPORT_ID, "Report", REPORT_SRC, Some(APP), None);
    b.approve(APP, &[(REPORT_ID, REPORT_SRC)]);
    b.cell(1, 1, json!({
        "label": "Go",
        "heldAction": { "kind": "script", "scriptId": REPORT_ID },
        "fromApplication": { "workspace": "ws", "application": APP, "version": "1.0.0" }
    }));
    let (reason, message) = refused(b.click(Cell, 1, 1).unwrap());
    assert_eq!(reason, "heldInWorkingCopy");
    assert!(message.contains(&format!("'{APP}' (v1.0.0)")) && message.contains("working copy"), "{message}");
    let rows = b.button_code_rows();
    assert_eq!(rows.len(), 1, "{rows:?}");
    assert_eq!(rows[0].extra["reason"], "heldInWorkingCopy");
    assert!(b.run_rows().is_empty());
}

/// A HELD cell action with no stamp at all (a crafted `.cala`: a held action
/// exists only under an application's stamp) is refused -- and the refusal is
/// on the trail, as an application's button whose record cannot be read. It
/// used to reach the audit core as "did not come with an application", which
/// recorded nothing.
///
/// SABOTAGE: make `clicked_button_origin`'s cell branch refuse an unstamped
/// cell again whether or not it holds an action.
#[test]
fn an_unstamped_held_cell_action_is_refused_and_recorded_as_unreadable() {
    let b = book();
    b.cell(1, 1, json!({ "label": "Go", "heldAction": { "kind": "script", "scriptId": REPORT_ID } }));
    let (reason, message) = refused(b.click(Cell, 1, 1).unwrap());
    assert_eq!(reason, "heldInWorkingCopy");
    assert!(message.contains("'an application'"), "{message}");
    let rows = b.button_code_rows();
    assert_eq!(rows.len(), 1, "the refusal of a held action left no row: {rows:?}");
    assert_eq!(rows[0].extra["reason"], "heldInWorkingCopy");
    assert_eq!(rows[0].extra["stampUnreadable"], true);
    assert_eq!(rows[0].extra["cells"], json!(["Dashboard!B2"]));
    // The user's own cell with no stamp and nothing held still records nothing.
    b.cell(2, 2, json!({ "label": "Bold", "action": { "kind": "command", "commandId": "format.bold" } }));
    assert!(matches!(answered(b.click(Cell, 2, 2).unwrap()), ControlActionOutcome::Command { .. }));
    assert_eq!(b.button_code_rows().len(), 1);
}

/// THE DOOR AND ITS ROW READ A CELL'S STAMP ONE WAY. A stamp that names its
/// application but carries no `workspace` (page-writable, and lax everywhere
/// else) is that application's button: the door refuses its foreign macro as
/// the application's, and the row names the same application -- not "" with
/// `stampUnreadable`. (A stamped COMMAND now goes to the command gate, which
/// names the stamp's application the same way: see
/// `a_stamped_command_not_on_the_list_is_refused_and_audited_and_the_users_own_command_is_a_directive`.)
///
/// SABOTAGE: have `clicked_button_origin` parse the stamp as a full `HeldFrom`
/// again.
#[test]
fn a_stamp_without_a_workspace_names_one_application_in_the_refusal_and_its_row() {
    let b = book();
    b.module("macro-mine", "Mine", "Calcula.log(1);", None, None);
    b.cell(1, 1, json!({
        "label": "Go",
        "action": { "kind": "script", "scriptId": "macro-mine" },
        "fromApplication": { "application": APP, "version": "1.0.0" }
    }));
    let (reason, _) = refused(b.click(Cell, 1, 1).unwrap());
    assert_eq!(reason, "macroNotFromApplication");
    let rows = b.button_code_rows();
    assert_eq!(rows.len(), 1, "{rows:?}");
    assert_eq!(rows[0].extra["application"], APP, "the row names another application than the refusal");
    assert_eq!(rows[0].extra["version"], "1.0.0");
    assert!(rows[0].extra.get("stampUnreadable").is_none(), "{:?}", rows[0].extra);
    // The same stamp on a command: the gate's row names the same application.
    b.cell(2, 2, json!({
        "label": "Go",
        "action": { "kind": "command", "commandId": "format.bold" },
        "fromApplication": { "application": APP, "version": "1.0.0" }
    }));
    assert_eq!(refused(b.click(Cell, 2, 2).unwrap()).0, "notAllowlisted");
    assert_eq!(b.refused_rows()[0].extra["application"], APP);
}

/// A stamp that names no application is not "the user's own": the button is
/// refused and the refusal recorded, saying the stamp could not be read.
#[test]
fn a_button_cell_whose_stamp_cannot_be_read_is_refused_and_audited() {
    let b = book();
    b.module("macro-mine", "Mine", "Calcula.log(1);", None, None);
    b.cell(1, 1, json!({ "action": { "kind": "script", "scriptId": "macro-mine" }, "fromApplication": { "version": "1.0.0" } }));
    let (reason, _) = refused(b.click(Cell, 1, 1).unwrap());
    assert_eq!(reason, "stampUnreadable");
    let rows = b.button_code_rows();
    assert_eq!(rows.len(), 1, "{rows:?}");
    assert_eq!(rows[0].extra["stampUnreadable"], true);
}

// ----------------------------------------------------------------------------
// 3c. An application's button COMMAND (plan_M8 S1): the door asks the command
//     gate (Check), the page checks the live registration, then
//     `authorize_button_command` asks it again and writes the run row.
// ----------------------------------------------------------------------------

/// A command on the list, for the unit tier only (the production list is
/// empty: `button_cells_tests::the_production_list_is_empty_until_the_owner_opts_a_command_in`).
const READER: &str = "test.reader.refresh";
const LIST: &[&str] = &[READER];

impl Book {
    /// A click on the button CELL at (row, col), with `allowed` as the list.
    fn click_listing(&self, row: u32, col: u32, allowed: &[&str]) -> Result<DoorAnswer, String> {
        run_control_action_core_with(
            &self.state,
            &self.scripts,
            &self.files,
            &RunControlActionRequest { kind: Cell, sheet_index: 1, row, col, view_state: None },
            allowed,
        )
    }

    /// The page's second question, with `allowed` as the list.
    fn authorize(&self, row: u32, col: u32, command_id: &str, allowed: &[&str]) -> Result<(), String> {
        authorize_button_command_core(
            &self.state,
            &self.files,
            &AuthorizeButtonCommandRequest { sheet_index: 1, row, col, command_id: command_id.to_string() },
            allowed,
        )
    }
}

/// The command a `command` answer names, and the application it carries.
fn command_answer(answer: DoorAnswer) -> (String, Option<String>) {
    match answered(answer) {
        ControlActionOutcome::Command { command_id, application } => (command_id, application),
        other => panic!("expected the page's command answer, got {other:?}"),
    }
}

/// THE DOOR'S HALF. A listed command from an application is refused until it is
/// approved under ITS OWN key -- a record under the application's bare name
/// (the object-script key), even with the same id and hash, is no approval of
/// a command -- and then answered `command` WITH the application. The door
/// writes no run row: the page has not checked its half yet.
///
/// SABOTAGES: drop the gate's approval step (the first click answers
/// `command`); have the gate ask the bare key (the bare record answers it).
#[test]
fn an_application_command_on_the_list_is_answered_only_once_approved_under_its_own_key() {
    let b = book();
    b.cell(1, 1, stamped(json!({ "kind": "command", "commandId": READER })));
    let (reason, message) = refused(b.click_listing(1, 1, LIST).unwrap());
    assert_eq!(reason, "notConsented");
    assert!(message.starts_with(APPLICATION_COMMAND_NOT_APPROVED), "{message}");
    assert!(message.contains(READER) && message.contains("Dashboard!B2"), "{message}");
    let rows = b.refused_rows();
    assert_eq!(rows.len(), 1, "{rows:?}");
    assert_eq!(rows[0].extra["reason"], "notConsented");
    assert_eq!(rows[0].extra["surface"], "buttonCommand");
    assert_eq!(rows[0].extra["commandId"], READER);
    assert_eq!(rows[0].extra["button"]["cell"], "Dashboard!B2");
    // Approved under the application's BARE name: not an approval of a command.
    b.approve(APP, &[(READER, READER)]);
    assert_eq!(refused(b.click_listing(1, 1, LIST).unwrap()).0, "notConsented", "the bare record approved a command");
    // Approved under its own key: answered, with the application.
    b.approve_commands(APP, &[READER]);
    assert_eq!(command_answer(b.click_listing(1, 1, LIST).unwrap()), (READER.to_string(), Some(APP.to_string())));
    assert!(b.run_rows().is_empty(), "the door wrote a run row before the page checked its half");
    assert_eq!(b.refused_rows().len(), 2);
    // An approval of ANOTHER application's commands is none of this one's.
    let other = book();
    other.cell(1, 1, stamped(json!({ "kind": "command", "commandId": READER })));
    other.approve_commands("hr", &[READER]);
    assert_eq!(refused(other.click_listing(1, 1, LIST).unwrap()).0, "notConsented");
}

/// THE SECOND QUESTION. `authorize_button_command` asks the gate again from the
/// store: no record, a record under the bare key -- refused, each on the trail;
/// a record under `button-commands:<app>` -- admitted, with exactly ONE
/// `ApplicationCodeRun` row naming the command (never as a macro), the button
/// cell, its caption, its application and its door. Every admitted run is
/// recorded.
///
/// SABOTAGES: drop the approval step; read the bare key; skip the run row.
#[test]
fn a_button_command_runs_only_under_its_own_approval_key_and_every_run_is_recorded() {
    let b = book();
    b.cell(1, 1, stamped(json!({ "kind": "command", "commandId": READER })));
    let err = b.authorize(1, 1, READER, LIST).unwrap_err();
    assert!(err.starts_with(APPLICATION_COMMAND_NOT_APPROVED), "{err}");
    assert_eq!(b.refused_rows().len(), 1);
    assert_eq!(b.refused_rows()[0].extra["reason"], "notConsented");
    b.approve(APP, &[(READER, READER)]);
    assert!(b.authorize(1, 1, READER, LIST).is_err(), "the bare record authorized a command");
    assert_eq!(b.refused_rows().len(), 2);
    assert!(b.run_rows().is_empty());

    b.approve_commands(APP, &[READER]);
    b.authorize(1, 1, READER, LIST).expect("an approved, listed command is authorized");
    let rows = b.run_rows();
    assert_eq!(rows.len(), 1, "{rows:?}");
    let row = &rows[0];
    assert_eq!(row.extra["surface"], "buttonCommand");
    assert_eq!(row.extra["application"], APP);
    assert_eq!(row.extra["commandId"], READER);
    assert!(row.extra.get("macroId").is_none(), "a command is recorded as a macro: {:?}", row.extra);
    assert_eq!(row.extra["sourceHash"], sha(READER));
    assert_eq!(row.extra["button"]["kind"], "cell");
    assert_eq!(row.extra["button"]["cell"], "Dashboard!B2");
    assert_eq!(row.extra["button"]["caption"], "Go");
    assert_eq!(row.extra["button"]["application"], APP);
    assert_eq!(row.extra["button"]["held"], false);
    assert_eq!(row.extra["startedBy"], "you");
    assert_eq!(row.extra["door"], "button");
    assert!(row.description.contains(&format!("the command '{READER}'")), "{}", row.description);
    assert!(row.description.contains(&format!("'{APP}'")) && row.description.contains("Dashboard!B2"), "{}", row.description);
    assert_eq!(b.refused_rows().len(), 2, "an admitted command wrote a refusal");
    b.authorize(1, 1, READER, LIST).unwrap();
    assert_eq!(b.run_rows().len(), 2, "a second run left no row");
}

/// The list comes first, on the second question too: an approved command that
/// is not on the list is refused (`notAllowlisted`), and so is every command
/// through the PRODUCTION list, which is empty.
///
/// SABOTAGE: skip the gate's list step -> admitted, red.
#[test]
fn a_command_not_on_the_list_is_refused_even_when_approved() {
    let b = book();
    b.cell(1, 1, stamped(json!({ "kind": "command", "commandId": READER })));
    b.approve_commands(APP, &[READER]);
    let err = b.authorize(1, 1, READER, &[]).unwrap_err();
    assert!(err.starts_with(APPLICATION_COMMAND_NOT_ALLOWED), "{err}");
    let err = b.authorize(1, 1, READER, crate::button_cells::DISTRIBUTABLE_BUTTON_COMMANDS).unwrap_err();
    assert!(err.starts_with(APPLICATION_COMMAND_NOT_ALLOWED), "{err}");
    let rows = b.refused_rows();
    assert_eq!(rows.len(), 2, "{rows:?}");
    assert!(rows.iter().all(|r| r.extra["reason"] == "notAllowlisted" && r.extra["commandId"] == READER));
    assert!(b.run_rows().is_empty());
    // The production DOOR refuses it too, before the page ever sees it.
    assert_eq!(refused(b.click(Cell, 1, 1).unwrap()).0, "notAllowlisted");
}

/// The second question names the cell AND the command, and the store must back
/// both: a cell holding command A, asked about B, is a mismatch recorded as the
/// claim it is; so is a stamped cell running a macro, or holding its action for
/// a working copy. A cell of the user's own, or no button cell at all, is
/// refused with no row (there is no application's command there to record).
///
/// SABOTAGE: skip the comparison with the stored action -> B is admitted, red.
#[test]
fn the_authorization_must_name_the_command_the_cell_holds() {
    let b = book();
    let both: &[&str] = &[READER, "test.other"];
    b.cell(1, 1, stamped(json!({ "kind": "command", "commandId": READER })));
    b.approve_commands(APP, both);
    let err = b.authorize(1, 1, "test.other", both).unwrap_err();
    assert!(err.starts_with(APPLICATION_CODE_TRIGGER_MISMATCH), "{err}");
    assert!(err.contains(&format!("runs the command \"{READER}\"")), "{err}");
    let rows = b.refused_rows();
    assert_eq!(rows.len(), 1, "{rows:?}");
    assert_eq!(rows[0].extra["reason"], "triggerMismatch");
    assert_eq!(rows[0].extra["commandId"], "test.other");
    assert_eq!(rows[0].extra["application"], APP);
    assert_eq!(
        rows[0].extra["claimedTrigger"],
        json!({ "kind": "buttonCell", "sheetIndex": 1, "row": 1, "col": 1 })
    );
    assert!(rows[0].extra.get("button").is_none(), "an unbacked claim named a button: {:?}", rows[0].extra);

    // A stamped cell that runs a macro, and one that holds its command for a
    // working copy: mismatches, recorded.
    b.cell(3, 3, stamped(json!({ "kind": "script", "scriptId": REPORT_ID })));
    assert!(b.authorize(3, 3, READER, both).unwrap_err().starts_with(APPLICATION_CODE_TRIGGER_MISMATCH));
    b.cell(4, 4, json!({
        "label": "Held",
        "heldAction": { "kind": "command", "commandId": READER },
        "fromApplication": { "workspace": "ws", "application": APP, "version": "1.0.0" }
    }));
    let err = b.authorize(4, 4, READER, both).unwrap_err();
    assert!(err.contains("holds its action for a working copy"), "{err}");
    assert_eq!(b.refused_rows().len(), 3);

    // The user's own button, and an empty cell: refused, nothing recorded.
    b.cell(2, 2, json!({ "label": "Mine", "action": { "kind": "command", "commandId": READER } }));
    assert!(b.authorize(2, 2, READER, both).is_err(), "a button of the user's own was authorized");
    assert!(b.authorize(9, 9, READER, both).is_err(), "an empty cell was authorized");
    assert_eq!(b.refused_rows().len(), 3, "a claim about no application's button wrote a row");
    assert!(b.button_code_rows().is_empty());
    assert!(b.run_rows().is_empty());

    // Positive control: the command the cell holds is authorized.
    b.authorize(1, 1, READER, both).unwrap();
    assert_eq!(b.run_rows().len(), 1);
}

/// A stamp that cannot be read is not the user's own: the second question
/// refuses it and records it as such, as the door does.
#[test]
fn an_unreadable_stamp_on_a_command_cell_is_refused_and_recorded() {
    let b = book();
    b.cell(1, 1, json!({ "label": "Go", "action": { "kind": "command", "commandId": READER }, "fromApplication": { "version": "1.0.0" } }));
    b.approve_commands(APP, &[READER]);
    assert_eq!(refused(b.click_listing(1, 1, LIST).unwrap()).0, "stampUnreadable");
    assert!(b.authorize(1, 1, READER, LIST).is_err());
    let rows = b.button_code_rows();
    assert_eq!(rows.len(), 2, "{rows:?}");
    assert_eq!(rows[1].extra["stampUnreadable"], true);
    assert_eq!(rows[1].extra["reason"], "stampUnreadable");
    assert_eq!(rows[1].extra["refused"], format!("the command \"{READER}\""));
    assert!(b.run_rows().is_empty());
}

/// THE PRIVATE-SHEET RULE holds for an application's command: in a working
/// copy beside the developer's own sheet, the door and the second question
/// both refuse, each on the trail; without the private sheet it is admitted.
///
/// SABOTAGE: drop the gate's private-sheet step -> both admitted, red.
#[test]
fn a_working_copy_beside_a_private_sheet_refuses_a_command() {
    let b = book();
    b.cell(1, 1, stamped(json!({ "kind": "command", "commandId": READER })));
    b.approve_commands(APP, &[READER]);
    b.working_copy(true);
    let (reason, message) = refused(b.click_listing(1, 1, LIST).unwrap());
    assert_eq!(reason, "privateSheets");
    assert!(message.starts_with(APPLICATION_CODE_BESIDE_PRIVATE_SHEETS) && message.contains("Salaries"), "{message}");
    let err = b.authorize(1, 1, READER, LIST).unwrap_err();
    assert!(err.starts_with(APPLICATION_CODE_BESIDE_PRIVATE_SHEETS), "{err}");
    let rows = b.refused_rows();
    assert_eq!(rows.len(), 2, "{rows:?}");
    assert!(rows.iter().all(|r| r.extra["reason"] == "privateSheets" && r.extra["privateSheets"] == json!(["Salaries"])));
    assert!(rows.iter().all(|r| r.extra["button"]["cell"] == "Dashboard!B2"));
    assert!(b.run_rows().is_empty());
    // Positive control: the same working copy without the private sheet.
    let clean = book();
    clean.cell(1, 1, stamped(json!({ "kind": "command", "commandId": READER })));
    clean.approve_commands(APP, &[READER]);
    clean.working_copy(false);
    assert_eq!(command_answer(clean.click_listing(1, 1, LIST).unwrap()).1, Some(APP.to_string()));
    clean.authorize(1, 1, READER, LIST).unwrap();
    assert_eq!(clean.run_rows().len(), 1);
}

/// A command approval sealed on ANOTHER computer counts for nothing here, like
/// every approval -- and on that computer, the same workbook's command is
/// admitted.
#[test]
fn a_command_approval_sealed_on_another_computer_does_not_allow_it() {
    let b = book();
    b.cell(1, 1, stamped(json!({ "kind": "command", "commandId": READER })));
    let elsewhere = TempDir::new().unwrap();
    crate::profile_dir::with_test_profile(elsewhere.path(), || b.approve_commands(APP, &[READER]));
    assert_eq!(refused(b.click_listing(1, 1, LIST).unwrap()).0, "notConsented");
    assert!(b.authorize(1, 1, READER, LIST).is_err());
    crate::profile_dir::with_test_profile(elsewhere.path(), || {
        assert_eq!(command_answer(b.click_listing(1, 1, LIST).unwrap()).1, Some(APP.to_string()));
        b.authorize(1, 1, READER, LIST).unwrap();
    });
}

/// What runs is Calcula's own command, not a script: like the user's own
/// command, an application's approved command is answered -- and authorized --
/// whatever Script Security says (it governs scripts, and the list and the
/// approval govern this).
#[test]
fn an_application_command_is_answered_and_authorized_whatever_script_security_says() {
    let b = book();
    *b.scripts.security_level.lock().unwrap() = "disabled".to_string();
    b.cell(1, 1, stamped(json!({ "kind": "command", "commandId": READER })));
    b.approve_commands(APP, &[READER]);
    assert_eq!(command_answer(b.click_listing(1, 1, LIST).unwrap()), (READER.to_string(), Some(APP.to_string())));
    b.authorize(1, 1, READER, LIST).unwrap();
    assert_eq!(b.run_rows().len(), 1);
}

/// The second question's request names a cell and a command, and nothing
/// else: the application is the cell's stamp's, never the page's word.
#[test]
fn the_authorization_request_carries_no_application() {
    let base = json!({ "sheetIndex": 1, "row": 1, "col": 1, "commandId": READER });
    assert!(serde_json::from_value::<AuthorizeButtonCommandRequest>(base.clone()).is_ok());
    for field in ["application", "source", "kind", "trigger"] {
        let mut request = base.clone();
        request[field] = json!("sales");
        assert!(
            serde_json::from_value::<AuthorizeButtonCommandRequest>(request).is_err(),
            "a request carrying '{field}' was accepted"
        );
    }
}

// ============================================================================
// 4. The request, the order, the wire
// ============================================================================

/// SABOTAGE (S4 e): drop `deny_unknown_fields` from `RunControlActionRequest`.
#[test]
fn the_request_carries_no_code() {
    let base = json!({ "kind": "control", "sheetIndex": 1, "row": 1, "col": 1 });
    assert!(serde_json::from_value::<RunControlActionRequest>(base.clone()).is_ok());
    let with_view = json!({ "kind": "cell", "sheetIndex": 1, "row": 1, "col": 1, "viewState": { "zoom": 150.0 } });
    assert!(serde_json::from_value::<RunControlActionRequest>(with_view).is_ok());
    for field in ["source", "code", "filename", "trigger"] {
        let mut request = base.clone();
        request[field] = json!("Exfiltrate();");
        assert!(
            serde_json::from_value::<RunControlActionRequest>(request).is_err(),
            "a request carrying '{field}' was accepted"
        );
    }
}

/// Script Security is asked AFTER the gates and BEFORE the run row: at
/// "prompt" with no session approval, an approved click answers the prompt
/// sentinel (the page asks and retries) and the trail does not say it ran; an
/// unapproved click is refused -- and recorded -- before Script Security.
///
/// SABOTAGE (S4 d): record the run row before `check_script_security`.
#[test]
fn script_security_is_asked_after_the_gates_and_before_the_run_row() {
    let b = book();
    *b.scripts.security_level.lock().unwrap() = "prompt".to_string();
    b.control(1, 1, held_button(HELD, APP));
    b.control(2, 2, held_button("Calcula.log('unapproved');", APP));
    b.approve(APP, &[(&button_action_consent_id(HELD), HELD)]);
    let err = match b.click(Control, 1, 1) {
        Err(e) => e,
        Ok(answer) => panic!("Script Security was not asked: {answer:?}"),
    };
    assert!(err.starts_with(SCRIPT_PROMPT_REQUIRED), "{err}");
    assert!(b.run_rows().is_empty(), "the trail says it ran, but Script Security stopped it");
    assert_eq!(refused(b.click(Control, 2, 2).unwrap()).0, "notConsented");
    assert_eq!(b.refused_rows().len(), 1);
    // ...and once the session is approved, the approved click runs.
    crate::scripting::commands::grant_session_approval(&b.scripts).unwrap();
    assert_eq!(ran(b.click(Control, 1, 1).unwrap()).source, HELD);
    assert_eq!(b.run_rows().len(), 1);
}

/// Scripts DISABLED is a final answer, and for an application's APPROVED code
/// it is a refusal of that code: on the trail, naming the button. The user's
/// own code refused the same way writes no application row (D6), and the
/// "prompt" sentinel stays unrecorded (the page asks and retries; see
/// `script_security_is_asked_after_the_gates_and_before_the_run_row`).
///
/// SABOTAGE: drop the `scriptsDisabled` row from `run_control_action_core`.
#[test]
fn scripts_disabled_refusing_an_approved_application_click_is_recorded() {
    let b = book();
    *b.scripts.security_level.lock().unwrap() = "disabled".to_string();
    b.control(1, 1, held_button(HELD, APP));
    b.control(2, 2, own_button("Calcula.log(1);"));
    b.approve(APP, &[(&button_action_consent_id(HELD), HELD)]);
    let err = b.click(Control, 1, 1).map(|_| ()).unwrap_err();
    assert!(err.starts_with(SCRIPTS_DISABLED), "{err}");
    let rows = b.refused_rows();
    assert_eq!(rows.len(), 1, "a click on an application's button that ran nothing left no row: {rows:?}");
    assert_eq!(rows[0].extra["reason"], "scriptsDisabled");
    assert_eq!(rows[0].extra["application"], APP);
    assert_eq!(rows[0].extra["macroId"], button_action_consent_id(HELD));
    assert_eq!(rows[0].extra["button"]["cell"], "Dashboard!B2");
    // ...and it names the door its run row would have named (review of M6b).
    assert_eq!(rows[0].extra["startedBy"], "you");
    assert_eq!(rows[0].extra["door"], "button");
    assert!(b.run_rows().is_empty());
    let err = b.click(Control, 2, 2).map(|_| ()).unwrap_err();
    assert!(err.starts_with(SCRIPTS_DISABLED), "{err}");
    assert_eq!(b.refused_rows().len(), 1, "the user's own code wrote an application row");
}

/// A gate that cannot read the workbook refuses (the private-sheet rule fails
/// closed) -- and, like every refusal of an application's code, says so on
/// the trail.
///
/// SABOTAGE: drop the row from `button_run_gate`'s `unavailable` refusal.
#[test]
fn a_gate_that_cannot_read_the_workbook_refuses_and_records_it() {
    let b = book();
    b.control(1, 1, held_button(HELD, APP));
    b.approve(APP, &[(&button_action_consent_id(HELD), HELD)]);
    // Poison the working-copy link: a panic while its write guard is held.
    std::thread::scope(|s| {
        let poisoned = s
            .spawn(|| {
                let _guard = b.state.working_copy_link.write(&test_seed_effect()).unwrap();
                panic!("deliberate: poisons the working-copy link for the stateUnavailable test");
            })
            .join();
        assert!(poisoned.is_err(), "precondition: the lock is poisoned");
    });
    let (reason, _) = refused(b.click(Control, 1, 1).unwrap());
    assert_eq!(reason, "stateUnavailable");
    let rows = b.refused_rows();
    assert_eq!(rows.len(), 1, "the refusal left no row: {rows:?}");
    assert_eq!(rows[0].extra["reason"], "stateUnavailable");
    assert_eq!(rows[0].extra["application"], APP);
    assert_eq!(rows[0].extra["button"]["cell"], "Dashboard!B2");
    assert!(b.run_rows().is_empty());
}

/// The user's own command button runs today with no Script Security check (the
/// page runs it), and a link is the page's own gated route: both are answered
/// BEFORE Script Security, so they keep working when scripts are disabled.
///
/// SABOTAGE (S4 g): ask `check_script_security` before answering a command.
#[test]
fn an_own_command_button_is_answered_before_script_security() {
    let b = book();
    *b.scripts.security_level.lock().unwrap() = "disabled".to_string();
    b.cell(2, 2, json!({ "label": "Bold", "action": { "kind": "command", "commandId": "format.bold" } }));
    let mut linked = own_button("");
    linked.properties.insert(MACRO_REF_PROPERTY.to_string(), prop("macro-mine"));
    b.control(3, 3, linked);
    assert!(matches!(answered(b.click(Cell, 2, 2).unwrap()), ControlActionOutcome::Command { .. }));
    assert!(matches!(answered(b.click(Control, 3, 3).unwrap()), ControlActionOutcome::Link));
    // A run is still stopped.
    b.control(1, 1, own_button("Calcula.log(1);"));
    let err = b.click(Control, 1, 1).map(|_| ()).unwrap_err();
    assert!(err.starts_with(SCRIPTS_DISABLED), "{err}");
}

#[test]
fn the_outcome_is_tagged_by_kind_in_camel_case() {
    let wire = |o: ControlActionOutcome| serde_json::to_value(o).unwrap();
    assert_eq!(wire(ControlActionOutcome::Link), json!({ "kind": "link" }));
    assert_eq!(
        wire(ControlActionOutcome::Macro { macro_id: "macro-report".into(), application: Some("sales".into()) }),
        json!({ "kind": "macro", "macroId": "macro-report", "application": "sales" })
    );
    assert_eq!(
        wire(ControlActionOutcome::Macro { macro_id: "macro-mine".into(), application: None }),
        json!({ "kind": "macro", "macroId": "macro-mine", "application": null })
    );
    assert_eq!(
        wire(ControlActionOutcome::Command { command_id: "format.bold".into(), application: None }),
        json!({ "kind": "command", "commandId": "format.bold", "application": null })
    );
    assert_eq!(
        wire(ControlActionOutcome::Command { command_id: "test.reader.refresh".into(), application: Some("sales".into()) }),
        json!({ "kind": "command", "commandId": "test.reader.refresh", "application": "sales" })
    );
    assert_eq!(
        wire(ControlActionOutcome::Refused { reason: "notConsented".into(), message: "no".into() }),
        json!({ "kind": "refused", "reason": "notConsented", "message": "no" })
    );
    assert_eq!(wire(ControlActionOutcome::Nothing { message: None }), json!({ "kind": "nothing", "message": null }));
    let ran = wire(ControlActionOutcome::Ran {
        result: RunScriptResponse::Error { message: "boom".into(), output: vec![] },
        unavailable: vec![UnavailableModule {
            id: "pkg-x".into(),
            name: "X".into(),
            reason: "distributed".into(),
            message: "m".into(),
        }],
    });
    assert_eq!(ran["kind"], "ran");
    assert_eq!(ran["result"]["type"], "error");
    assert_eq!(ran["unavailable"][0]["id"], "pkg-x");
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

/// The door: the window guard, then the core (decide -> the gate, every
/// refusal recorded -> Script Security -> the run row), and only then the
/// interpreter, under the surface "button".
#[test]
fn the_door_asks_every_gate_before_script_security_and_records_the_run_last() {
    let src = source("src/scripting/control_action.rs");
    // The production core is the list-taking one, over THE list.
    let production = body_of(&src, "pub(crate) fn run_control_action_core(");
    assert!(
        production.contains("run_control_action_core_with(") && production.contains("DISTRIBUTABLE_BUTTON_COMMANDS)"),
        "the production door does not judge commands against THE list:\n{production}"
    );
    let core = body_of(&src, "pub(crate) fn run_control_action_core_with(");
    let decide = core.find("decide(").expect("the core no longer decides from the store");
    let gate = core.find("button_run_gate(").expect("the core no longer asks the gate");
    let security = core.find("check_script_security(").expect("the core no longer asks Script Security");
    let row = core.find("record_button_run(").expect("the core no longer records the run");
    assert!(decide < gate && gate < security && security < row, "decide -> gate -> Script Security -> run row");
    assert!(core.contains("read_script_consent_file_in("), "the approval is not read through the verified reader");
    let command = body_of(&src, "pub fn run_control_action(");
    let guard = command.find("require_label(").expect("the main-window guard");
    let asked = command.find("run_control_action_core(").expect("the command skips the core");
    let run = command.find("run_in_interpreter(").expect("the command no longer runs the interpreter");
    assert!(guard < asked && asked < run);
    assert_eq!(command.matches("run_in_interpreter(").count(), 1);
    assert!(command.contains("\"button\""), "the run is not named as a button's");
}

/// THE COMMAND ROUTE, placed: the door asks the command gate's CHECK (no run
/// row) with the verified consent view; `authorize_button_command` is
/// registered, guarded to the MAIN window only before anything else, judged
/// against THE list, and asks the gate's ADMITTED phase (the run row) only
/// after comparing the claim with the store.
///
/// SABOTAGE: widen the guard to `MAIN_AND_APPLICATION_INSPECTOR` -> red.
#[test]
fn the_command_route_is_registered_main_window_only_and_reads_the_production_list() {
    let lib = source("src/lib.rs");
    assert!(
        lib.contains("            scripting::control_action::authorize_button_command,"),
        "authorize_button_command is not registered"
    );
    let src = source("src/scripting/control_action.rs");
    let command = body_of(&src, "pub fn authorize_button_command(");
    let guard = command
        .find("require_label(&window, crate::security::window_guard::MAIN)?;")
        .expect("the command is not guarded to the main window alone");
    let asked = command.find("authorize_button_command_core(").expect("the command skips the core");
    assert!(guard < asked, "the guard comes after the core");
    assert!(!command.contains("MAIN_AND_"), "the guard was widened beyond the main window:\n{command}");
    assert!(command.contains("DISTRIBUTABLE_BUTTON_COMMANDS)"), "the command does not judge against THE list");
    let core = body_of(&src, "pub(crate) fn authorize_button_command_core(");
    let compared = core.find("record_button_command_mismatch(").expect("the claim is not compared with the store");
    let consent = core.find("read_script_consent_file_in(").expect("the approval is not read through the verified reader");
    let gate = core.find("CommandGatePhase::Admitted").expect("the second question does not write the run row");
    assert!(compared < consent && consent < gate, "store -> approvals -> the gate's admitted phase");
    let door = body_of(&src, "pub(crate) fn run_control_action_core_with(");
    assert!(door.contains("CommandGatePhase::Check"), "the door asks the command gate's admitted phase (a run row before the page checked)");
    assert!(!door.contains("CommandGatePhase::Admitted"), "the door writes a command's run row");
}
