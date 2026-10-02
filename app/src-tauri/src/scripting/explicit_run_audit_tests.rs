//! FILENAME: app/src-tauri/src/scripting/explicit_run_audit_tests.rs
//! PURPOSE: Owner decision B, follow-ups F15 and F8 -- what a granted run of an
//! application's macro wrote, and a run refused before it started, on the
//! persistent trail.
//! CONTEXT: The ledger and both cores over a plain `AppState`; the placement
//! of the doors (main window only, registered, the ledger the mount door
//! fills) pinned at the source.

use std::path::Path;

use super::*;

const APP: &str = "sales";
const MACRO: &str = "macro-report";

fn state_with_sheets(names: &[&str]) -> crate::AppState {
    let state = crate::create_app_state();
    {
        let effect = crate::document_effect::test_seed_effect();
        let mut grids = state.grids.write(&effect).unwrap();
        let mut sheet_names = state.sheet_names.write(&effect).unwrap();
        let mut ids = state.sheet_ids.write(&effect).unwrap();
        grids.clear();
        sheet_names.clear();
        ids.clear();
        for name in names {
            grids.push(engine::grid::Grid::new());
            sheet_names.push(name.to_string());
            ids.push(identity::SheetId::from_bytes(identity::generate_uuid_v7()));
        }
    }
    state
}

fn granted(grants: &ExplicitRunGrants, door: ExplicitRunDoor) -> u64 {
    grants
        .open(GrantedRun { application: APP.to_string(), macro_id: MACRO.to_string(), door, button: None })
        .expect("a grant")
}

fn sheet(sheet: usize, cells: u32, (r0, r1, c0, c1): (u32, u32, u32, u32)) -> ExplicitRunSheetWrites {
    ExplicitRunSheetWrites { sheet, cells_modified: cells, first_row: r0, last_row: r1, first_col: c0, last_col: c1 }
}

fn report(grant_id: u64, sheets: Vec<ExplicitRunSheetWrites>) -> ExplicitRunWritesReport {
    ExplicitRunWritesReport {
        grant_id,
        completed: true,
        rolled_back: false,
        failed_calls: 0,
        counts_capped: false,
        others_undone: 0,
        sheets,
    }
}

fn executed(state: &crate::AppState) -> Vec<calp::audit::AuditEntry> {
    state
        .audit_log
        .read()
        .unwrap()
        .entries
        .iter()
        .filter(|e| matches!(e.event, calp::audit::AuditEvent::ScriptExecuted))
        .cloned()
        .collect()
}

fn refused(state: &crate::AppState) -> Vec<calp::audit::AuditEntry> {
    state
        .audit_log
        .read()
        .unwrap()
        .entries
        .iter()
        .filter(|e| matches!(e.event, calp::audit::AuditEvent::ApplicationCodeRefused))
        .cloned()
        .collect()
}

// ============================================================================
// F15: what a granted run wrote
// ============================================================================

/// THE OWNER'S CASE: a granted run wrote Sheet1!A1 and Sheet2!B2:B3. Two
/// always-on rows, in the module runtime's shape (surface, the macro as the
/// surface id, the sheet, the count, the bounds), naming the application and
/// the door FROM THE GRANT -- and the grant is spent.
///
/// SABOTAGE: drop the `record_script_grid_mutation_with(` call from
/// `audit_explicit_run_writes_core`; or `take` -> a peek that leaves the grant.
#[test]
fn a_granted_runs_writes_are_recorded_per_sheet_with_bounds_and_the_grant_is_spent() {
    let state = state_with_sheets(&["Sheet1", "Sheet2"]);
    assert!(!state.audit_log.read().unwrap().enabled, "precondition: auditing is off -- the rows are always-on");
    let grants = ExplicitRunGrants::default();
    let id = granted(&grants, ExplicitRunDoor::MacrosDialog);
    let written = audit_explicit_run_writes_core(
        &state,
        &grants,
        &report(id, vec![sheet(0, 1, (0, 0, 0, 0)), sheet(1, 2, (1, 2, 1, 1))]),
    )
    .expect("recorded");
    assert_eq!(written, 2);
    let rows = executed(&state);
    assert_eq!(rows.len(), 2, "{rows:?}");
    for (row, (sheet_index, cells, bounds)) in rows.iter().zip([(0, 1, (0, 0, 0, 0)), (1, 2, (1, 2, 1, 1))]) {
        assert_eq!(row.extra["surface"], "object-script");
        assert_eq!(row.extra["surfaceId"], MACRO);
        assert_eq!(row.extra["application"], APP);
        assert_eq!(row.extra["macroId"], MACRO);
        assert_eq!(row.extra["door"], "macrosDialog");
        assert_eq!(row.extra["startedBy"], "you");
        assert_eq!(row.extra["cellAccess"], true);
        assert_eq!(row.extra["grantId"], id);
        assert_eq!(row.extra["completed"], true);
        assert_eq!(row.extra["sheet"], sheet_index);
        assert_eq!(row.extra["cellsModified"], cells);
        assert_eq!(
            (row.extra["firstRow"].clone(), row.extra["lastRow"].clone(), row.extra["firstCol"].clone(), row.extra["lastCol"].clone()),
            (bounds.0.into(), bounds.1.into(), bounds.2.into(), bounds.3.into())
        );
        assert!(row.extra.get("failedCalls").is_none());
        assert!(row.extra.get("rolledBack").is_none(), "a completed run's row speaks of a rollback");
    }
    assert!(rows[0].description.contains("changed 1 cell(s) on Sheet1!A1"), "{}", rows[0].description);
    assert!(rows[1].description.contains("changed 2 cell(s) on Sheet2!B2:B3"), "{}", rows[1].description);
    assert!(rows[1].description.contains("which you started from Developer > Macros > Run"), "{}", rows[1].description);

    // Reported once: the same grant again records nothing.
    let again = audit_explicit_run_writes_core(&state, &grants, &report(id, vec![sheet(0, 1, (5, 5, 5, 5))]));
    assert!(again.unwrap_err().contains("Nothing was recorded"));
    assert_eq!(executed(&state).len(), 2, "a grant was reported twice");
    assert_eq!(grants.waiting(), 0);
}

/// A GRANT NOBODY OPENED records nothing: the page cannot name an application
/// macro the mount door never granted.
///
/// SABOTAGE: fall back to a placeholder `GrantedRun` when `take` finds none.
#[test]
fn a_report_for_a_grant_that_was_never_opened_records_nothing() {
    let state = state_with_sheets(&["Sheet1"]);
    let grants = ExplicitRunGrants::default();
    let err = audit_explicit_run_writes_core(&state, &grants, &report(41, vec![sheet(0, 1, (0, 0, 0, 0))]))
        .expect_err("never granted");
    assert!(err.contains("grant 41"), "{err}");
    assert!(executed(&state).is_empty());
}

/// A MALFORMED REPORT is refused BEFORE it spends its grant, so the shape check
/// cannot be used to throw a grant away -- and the grant still reports after.
///
/// SABOTAGE: take the grant before `validate_report`.
#[test]
fn a_malformed_report_is_refused_and_does_not_spend_the_grant() {
    let state = state_with_sheets(&["Sheet1", "Sheet2"]);
    let grants = ExplicitRunGrants::default();
    let id = granted(&grants, ExplicitRunDoor::CommandLine);
    for bad in [
        vec![sheet(0, 1, (3, 2, 0, 0))],                            // inverted rows
        vec![sheet(0, 1, (0, 0, 4, 1))],                            // inverted columns
        vec![sheet(0, 0, (0, 0, 0, 0))],                            // no cells
        vec![sheet(0, 5, (0, 1, 0, 1))],                            // more cells than the bounds hold
        vec![sheet(1, 1, (0, 0, 0, 0)), sheet(1, 1, (2, 2, 2, 2))], // a sheet twice
    ] {
        assert!(audit_explicit_run_writes_core(&state, &grants, &report(id, bad.clone())).is_err(), "{bad:?}");
    }
    assert!(executed(&state).is_empty());
    assert_eq!(grants.waiting(), 1, "a malformed report spent the grant");
    audit_explicit_run_writes_core(&state, &grants, &report(id, vec![sheet(1, 4, (0, 1, 0, 1))])).expect("recorded");
    assert_eq!(executed(&state).len(), 1);
}

/// A RUN THAT FAILED, OR WHOSE CALLS DID, is recorded with that said: a cell
/// counted may not have changed. An empty report spends its grant and records
/// nothing (the run row already says the code ran).
#[test]
fn a_failed_run_says_so_and_an_empty_report_closes_its_grant() {
    let state = state_with_sheets(&["Sheet1"]);
    let grants = ExplicitRunGrants::default();
    let id = granted(&grants, ExplicitRunDoor::Button);
    let mut failed = report(id, vec![sheet(0, 3, (0, 2, 0, 0))]);
    failed.completed = false;
    failed.failed_calls = 2;
    failed.counts_capped = true;
    audit_explicit_run_writes_core(&state, &grants, &failed).expect("recorded");
    let rows = executed(&state);
    assert_eq!(rows[0].extra["completed"], false);
    assert_eq!(rows[0].extra["failedCalls"], 2);
    assert_eq!(rows[0].extra["countsCapped"], true);
    assert_eq!(rows[0].extra["door"], "button");
    let d = &rows[0].description;
    assert!(d.contains("the run stopped with an error before it finished, and its changes could not be undone"), "{d}");
    assert_eq!(rows[0].extra["rolledBack"], false);
    assert!(d.contains("2 of its calls failed, so a cell counted here may not have changed"), "{d}");
    assert!(d.contains("which you started from its button"), "{d}");

    let quiet = granted(&grants, ExplicitRunDoor::MacrosDialog);
    assert_eq!(audit_explicit_run_writes_core(&state, &grants, &report(quiet, Vec::new())), Ok(0));
    assert_eq!(executed(&state).len(), 1, "an empty report recorded a row");
    assert_eq!(grants.waiting(), 0, "an empty report left its grant open");
}

/// A RUN THAT FAILED AND WAS TAKEN BACK (owner decision B, follow-up F9): its
/// rows say every change was undone, so a reader does not go looking for cells
/// that hold what they held before.
///
/// SABOTAGE: drop the `rolled_back` branch of the caveat -> the row still says
/// "could not be undone".
#[test]
fn a_run_that_was_taken_back_says_every_change_was_undone() {
    let state = state_with_sheets(&["Sheet1"]);
    let grants = ExplicitRunGrants::default();
    let id = granted(&grants, ExplicitRunDoor::Button);
    let mut undone = report(id, vec![sheet(0, 2, (0, 1, 0, 0))]);
    undone.completed = false;
    undone.rolled_back = true;
    audit_explicit_run_writes_core(&state, &grants, &undone).expect("recorded");
    let rows = executed(&state);
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].extra["completed"], false);
    assert_eq!(rows[0].extra["rolledBack"], true);
    let d = &rows[0].description;
    assert!(d.contains("changed 2 cell(s) on Sheet1!A1:A2"), "{d}");
    assert!(d.contains("before it finished, and every change it made was undone"), "{d}");
    assert!(!d.contains("could not be undone"), "{d}");
}

/// A COMPLETED RUN IS NEVER TAKEN BACK: a report claiming both is refused before
/// it spends its grant.
#[test]
fn a_report_of_a_completed_run_that_was_taken_back_is_refused() {
    let state = state_with_sheets(&["Sheet1"]);
    let grants = ExplicitRunGrants::default();
    let id = granted(&grants, ExplicitRunDoor::MacrosDialog);
    let mut both = report(id, vec![sheet(0, 1, (0, 0, 0, 0))]);
    both.rolled_back = true;
    let err = audit_explicit_run_writes_core(&state, &grants, &both).expect_err("contradiction");
    assert!(err.contains("completed was taken back"), "{err}");
    assert!(executed(&state).is_empty());
    assert_eq!(grants.waiting(), 1, "a contradictory report spent the grant");
}

/// THE LEDGER IS BOUNDED: a grant whose run never reports is dropped oldest
/// first, and its late report is refused like any unknown id.
#[test]
fn the_ledger_drops_the_oldest_grant_beyond_its_bound() {
    let grants = ExplicitRunGrants::default();
    let first = granted(&grants, ExplicitRunDoor::MacrosDialog);
    let second = granted(&grants, ExplicitRunDoor::MacrosDialog);
    for _ in 1..MAX_OPEN_GRANTS {
        granted(&grants, ExplicitRunDoor::MacrosDialog);
    }
    assert_eq!(grants.waiting(), MAX_OPEN_GRANTS);
    assert!(grants.take(first).is_none(), "the oldest grant was kept beyond the bound");
    assert!(grants.take(second).is_some(), "the next grant was dropped too");
}

/// A DOCUMENT SWAP closes every waiting grant: a report sent after it records
/// nothing (its rows would land on the next workbook's trail), and the closed
/// grant's id stays refused.
///
/// SABOTAGE: make `clear` a no-op -> the late report is recorded.
#[test]
fn a_document_swap_closes_every_waiting_grant() {
    let state = state_with_sheets(&["Sheet1"]);
    let grants = ExplicitRunGrants::default();
    let before = granted(&grants, ExplicitRunDoor::MacrosDialog);
    grants.clear().expect("cleared");
    assert_eq!(grants.waiting(), 0);
    assert!(audit_explicit_run_writes_core(&state, &grants, &report(before, vec![sheet(0, 1, (0, 0, 0, 0))])).is_err());
    assert!(executed(&state).is_empty(), "a report from the replaced document was recorded");
    let after = granted(&grants, ExplicitRunDoor::MacrosDialog);
    assert_ne!(after, before, "a grant id was handed out again after the swap");
    assert!(audit_explicit_run_writes_core(&state, &grants, &report(before, vec![sheet(0, 1, (0, 0, 0, 0))])).is_err());
}

/// THE WIRE the page sends: camelCase, and nothing else rides along.
#[test]
fn the_report_deserializes_from_the_wire_the_page_sends_and_refuses_extra_fields() {
    let wire = serde_json::json!({
        "grantId": 3,
        "completed": true,
        "failedCalls": 0,
        "sheets": [{ "sheet": 1, "cellsModified": 2, "firstRow": 1, "lastRow": 2, "firstCol": 1, "lastCol": 1 }],
    });
    let parsed: ExplicitRunWritesReport = serde_json::from_value(wire.clone()).unwrap();
    assert_eq!(parsed, report(3, vec![sheet(1, 2, (1, 2, 1, 1))]));
    // `rolledBack` is optional on the wire (a completed run never sends true).
    let mut taken_back = wire.clone();
    taken_back["completed"] = serde_json::json!(false);
    taken_back["rolledBack"] = serde_json::json!(true);
    let parsed: ExplicitRunWritesReport = serde_json::from_value(taken_back.clone()).unwrap();
    assert!(!parsed.completed && parsed.rolled_back);
    assert_eq!(parsed.others_undone, 0, "othersUndone is optional on the wire");
    let mut with_others = taken_back;
    with_others["othersUndone"] = serde_json::json!(3);
    let parsed: ExplicitRunWritesReport = serde_json::from_value(with_others).unwrap();
    assert_eq!(parsed.others_undone, 3);
    let mut extra = wire;
    extra["application"] = serde_json::json!("someone-else");
    assert!(
        serde_json::from_value::<ExplicitRunWritesReport>(extra).is_err(),
        "the page named the application -- Rust reads it from the grant"
    );
}

// ============================================================================
// F8: a run refused before it started
// ============================================================================

const OUTSIDE: &str = "function setup(context) {\n  context.api.setCellValue(0, 0, 1);\n  \
                       context.api.setRangeFormat(0, 0, 0, 0, { bold: true });\n  context.api.sortRange(0, 0, 9, 0);\n}\n";

fn stored(package: Option<&str>) -> Vec<(Option<String>, String, String)> {
    vec![(package.map(str::to_string), MACRO.to_string(), OUTSIDE.to_string())]
}

/// The workbook's consent file approving `source` as `MACRO` of `APP`.
fn approving(source: &str) -> serde_json::Value {
    serde_json::json!({ "consents": [{
        "packageName": APP,
        "scripts": [{ "id": MACRO, "sourceHash": calp::integrity::sha256_hex(source.as_bytes()) }],
    }] })
}

/// THE PRE-FLIGHT'S REFUSAL REACHES THE TRAIL: one always-on refusal row,
/// reason `outsideCellAccess`, the methods sorted, the application read from
/// the STORE.
///
/// SABOTAGE: drop the `record_explicit_run_refused(` call from
/// `audit_explicit_run_refusal_core`.
#[test]
fn a_refusal_before_the_run_is_recorded_naming_the_methods_and_the_stores_application() {
    let state = state_with_sheets(&["Sheet1"]);
    assert!(!state.audit_log.read().unwrap().enabled, "precondition: auditing is off");
    let methods = vec!["api.sortRange".to_string(), "api.setRangeFormat".to_string(), "api.sortRange".to_string()];
    let answer = audit_explicit_run_refusal_core(&state, &stored(Some(APP)), Some(&approving(OUTSIDE)), MACRO, OUTSIDE, &methods)
        .expect("recorded");
    assert_eq!(answer, ExplicitRunRefusalAnswer { reason: "outsideCellAccess", message: None });
    let rows = refused(&state);
    assert_eq!(rows.len(), 1);
    let row = &rows[0];
    assert_eq!(row.extra["reason"], "outsideCellAccess");
    assert_eq!(row.extra["surface"], "object-script");
    assert_eq!(row.extra["application"], APP);
    assert_eq!(row.extra["macroId"], MACRO);
    assert_eq!(row.extra["methods"], serde_json::json!(["api.setRangeFormat", "api.sortRange"]));
    assert_eq!(row.extra["sourceHash"], calp::integrity::sha256_hex(OUTSIDE.as_bytes()));
    assert!(
        row.description.contains("it also calls api.setRangeFormat, api.sortRange, which is outside the cell access"),
        "{}",
        row.description
    );
    assert!(row.description.contains("nothing was changed"), "{}", row.description);
}

/// NOT AN APPLICATION'S MACRO, OR NOT WHAT IT CALLS: nothing is recorded.
///
/// SABOTAGE: drop the `source.contains(short)` check.
#[test]
fn a_refusal_is_recorded_only_for_an_applications_stored_macro_and_methods_it_calls() {
    let state = state_with_sheets(&["Sheet1"]);
    let one = vec!["api.setRangeFormat".to_string()];
    let ok = approving(OUTSIDE);
    let ok = Some(&ok);
    assert!(audit_explicit_run_refusal_core(&state, &stored(None), ok, MACRO, OUTSIDE, &one).is_err(), "the user's own");
    assert!(audit_explicit_run_refusal_core(&state, &stored(Some("  ")), ok, MACRO, OUTSIDE, &one).is_err(), "blank stamp");
    assert!(audit_explicit_run_refusal_core(&state, &stored(Some(APP)), ok, "macro-nope", OUTSIDE, &one).is_err(), "no such macro");
    for bad in [
        vec![],
        vec!["api.insertRows".to_string()],      // not in the source
        vec!["window.close".to_string()],        // not a broker method
        vec!["api.set Range".to_string()],       // not a name
        vec!["api.".to_string()],                // no name
    ] {
        assert!(
            audit_explicit_run_refusal_core(&state, &stored(Some(APP)), ok, MACRO, OUTSIDE, &bad).is_err(),
            "{bad:?}"
        );
    }
    let many: Vec<String> = (0..=MAX_REFUSED_METHODS).map(|_| "api.sortRange".to_string()).collect();
    assert!(audit_explicit_run_refusal_core(&state, &stored(Some(APP)), ok, MACRO, OUTSIDE, &many).is_err());
    assert!(refused(&state).is_empty(), "a refusal was recorded for something that was not refused");
    // base.callMethod is spelled `callMethod(` in a macro.
    let calls = "function setup(context) { context.callMethod('x', null, 'y', []); }";
    let store = vec![(Some(APP.to_string()), MACRO.to_string(), calls.to_string())];
    audit_explicit_run_refusal_core(&state, &store, Some(&approving(calls)), MACRO, calls, &["base.callMethod".to_string()])
        .expect("recorded");
    assert_eq!(refused(&state).len(), 1);
}

/// THE APPROVAL FIRST (review of M6b). The pre-flight runs before the mount
/// gate, so an UNAPPROVED macro that also calls a method outside cell access
/// used to be recorded `outsideCellAccess` and told "when you run such a macro
/// yourself it may read and change cells..." -- a sentence that implies approved
/// code and sends the person to copy unapproved publisher code into a macro of
/// their own. Now it is recorded `notConsented`, with no methods, and the page
/// is handed the approval's own refusal to say.
///
/// SABOTAGE: drop the `distributed_module_refusal` check from
/// `audit_explicit_run_refusal_core` -> recorded as outsideCellAccess.
#[test]
fn an_unapproved_macro_is_refused_for_its_approval_not_for_what_it_calls() {
    let state = state_with_sheets(&["Sheet1"]);
    let methods = vec!["api.setRangeFormat".to_string()];
    for consent in [None, Some(approving("function setup() {}"))] {
        let answer = audit_explicit_run_refusal_core(&state, &stored(Some(APP)), consent.as_ref(), MACRO, OUTSIDE, &methods)
            .expect("recorded");
        assert_eq!(answer.reason, "notConsented", "{consent:?}");
        let message = answer.message.expect("the approval's own refusal");
        assert!(message.starts_with(super::super::commands::DISTRIBUTED_SCRIPT_NOT_CONSENTED), "{message}");
    }
    let rows = refused(&state);
    assert_eq!(rows.len(), 2);
    for row in &rows {
        assert_eq!(row.extra["reason"], "notConsented");
        assert_eq!(row.extra["surface"], "object-script");
        assert_eq!(row.extra["application"], APP);
        assert_eq!(row.extra["macroId"], MACRO);
        assert_eq!(row.extra["sourceHash"], calp::integrity::sha256_hex(OUTSIDE.as_bytes()));
        assert!(row.extra.get("methods").is_none(), "an unapproved run's row names the methods: {row:?}");
        assert!(row.description.contains("its code is not approved"), "{}", row.description);
        assert!(!row.description.contains("outside the cell access"), "{}", row.description);
    }
}

/// ONLY THE BYTES THE STORE HOLDS were about to run: a refusal for any other
/// source is not recorded (the runner runs exactly the stored module).
#[test]
fn a_refusal_is_recorded_only_for_the_source_the_store_holds() {
    let state = state_with_sheets(&["Sheet1"]);
    let other = format!("{OUTSIDE}// edited\n");
    let err = audit_explicit_run_refusal_core(
        &state,
        &stored(Some(APP)),
        Some(&approving(&other)),
        MACRO,
        &other,
        &["api.setRangeFormat".to_string()],
    )
    .expect_err("a source the store does not hold");
    assert!(err.contains("does not hold that source"), "{err}");
    assert!(refused(&state).is_empty());
}

/// GRANT IDS ARE UNGUESSABLE (review of M6b). A sequential id let any caller
/// of the report door name the NEXT grant and spend it with an empty report
/// before its run reported -- after which the run's real report was refused
/// and its writes never reached the trail. Ids are random, within the page's
/// safe-integer range, never 0, never one still open.
///
/// SABOTAGE: hand out `previous + 1` (a counter) -> red.
#[test]
fn grant_ids_are_random_safe_integers_and_never_sequential() {
    let grants = ExplicitRunGrants::default();
    let ids: Vec<u64> = (0..MAX_OPEN_GRANTS).map(|_| granted(&grants, ExplicitRunDoor::MacrosDialog)).collect();
    let distinct: HashSet<u64> = ids.iter().copied().collect();
    assert_eq!(distinct.len(), ids.len(), "two open grants share an id: {ids:?}");
    assert!(ids.iter().all(|id| (1..=MAX_GRANT_ID).contains(id)), "an id outside 1..=2^53-1: {ids:?}");
    // A counter, anywhere: the next id is the last one plus one.
    let steps_of_one = ids.windows(2).filter(|w| w[1] == w[0].wrapping_add(1)).count();
    assert_eq!(steps_of_one, 0, "grant ids follow each other: {ids:?}");
    // Knowing every id handed out so far names no waiting grant but those.
    let guess = ids.iter().max().unwrap() + 1;
    assert!(grants.take(guess).is_none() || ids.contains(&guess));
}

/// A GRANTED RUN THAT CHANGED NOTHING AND DID NOT COMPLETE (review of M6b): the
/// run row written at admission says it ran with cell access, and nothing
/// after it used to say it changed no cells -- an empty report closed its grant
/// silently. Now it leaves one always-on row. A COMPLETED run that wrote
/// nothing still records nothing more (its run row is the whole story).
///
/// SABOTAGE: return `Ok(0)` for every empty report -> no row.
#[test]
fn a_run_that_never_wrote_and_did_not_complete_leaves_a_row() {
    let state = state_with_sheets(&["Sheet1"]);
    let grants = ExplicitRunGrants::default();
    let id = granted(&grants, ExplicitRunDoor::Button);
    let mut never = report(id, Vec::new());
    never.completed = false;
    assert_eq!(audit_explicit_run_writes_core(&state, &grants, &never), Ok(1));
    let rows = executed(&state);
    assert_eq!(rows.len(), 1, "{rows:?}");
    let row = &rows[0];
    assert_eq!(row.extra["surface"], "object-script");
    assert_eq!(row.extra["surfaceId"], MACRO);
    assert_eq!(row.extra["application"], APP);
    assert_eq!(row.extra["door"], "button");
    assert_eq!(row.extra["startedBy"], "you");
    assert_eq!(row.extra["grantId"], id);
    assert_eq!(row.extra["completed"], false);
    assert_eq!(row.extra["rolledBack"], false);
    assert_eq!(row.extra["cellsModified"], 0);
    assert!(row.extra.get("sheet").is_none(), "a row that changed nothing names a sheet");
    assert!(
        row.description.contains("which you started from its button, changed no cells: it stopped before it finished, or never started"),
        "{}",
        row.description
    );
    assert_eq!(grants.waiting(), 0, "the grant is still open");

    // CONTROL: a completed run that wrote nothing -- nothing more to say.
    let quiet = granted(&grants, ExplicitRunDoor::MacrosDialog);
    assert_eq!(audit_explicit_run_writes_core(&state, &grants, &report(quiet, Vec::new())), Ok(0));
    assert_eq!(executed(&state).len(), 1);
}

/// WHAT ELSE THE ROLLBACK TOOK BACK (review of M6b): a taken-back run's rows say
/// how many cells somebody else wrote while it ran were undone with it -- and a
/// report that counts such cells for a run that was NOT taken back is refused
/// before it spends its grant.
///
/// SABOTAGE: drop the `others_undone` clause from the caveat -> red.
#[test]
fn a_rollback_that_took_back_other_changes_says_how_many() {
    let state = state_with_sheets(&["Sheet1"]);
    let grants = ExplicitRunGrants::default();
    let id = granted(&grants, ExplicitRunDoor::MacrosDialog);
    let mut wrong = report(id, vec![sheet(0, 1, (0, 0, 0, 0))]);
    wrong.completed = false;
    wrong.others_undone = 2;
    let err = audit_explicit_run_writes_core(&state, &grants, &wrong).expect_err("not taken back");
    assert!(err.contains("not taken back"), "{err}");
    assert_eq!(grants.waiting(), 1, "a contradictory report spent the grant");

    wrong.rolled_back = true;
    audit_explicit_run_writes_core(&state, &grants, &wrong).expect("recorded");
    let rows = executed(&state);
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].extra["othersUndone"], 2);
    assert!(
        rows[0].description.contains(
            "every change it made was undone -- and 2 other cell changes made while it ran were undone with it"
        ),
        "{}",
        rows[0].description
    );
}

// ============================================================================
// Placement
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

/// BOTH DOORS: main window only (every door that mints a pass is a main-window
/// gesture), over the ledger the mount door fills, registered.
///
/// SABOTAGE: drop the `require_label(` line from `audit_explicit_run_writes`.
#[test]
fn both_doors_are_main_window_only_and_registered() {
    let src = source("src/scripting/explicit_run_audit.rs");
    let writes = body_of(&src, "pub fn audit_explicit_run_writes(");
    assert!(writes.contains("window_guard::require_label(&window, crate::security::window_guard::MAIN)?"));
    assert!(writes.contains("&script_state.explicit_run_grants"), "the writes door reads another ledger");
    let refusal = body_of(&src, "pub fn audit_explicit_run_refusal(");
    assert!(refusal.contains("window_guard::require_label(&window, crate::security::window_guard::MAIN)?"));
    assert!(refusal.contains("script_state.workbook_scripts.read()"), "the refusal door does not read the store");
    let lib = source("src/lib.rs");
    for cmd in [
        "scripting::explicit_run_audit::audit_explicit_run_writes,",
        "scripting::explicit_run_audit::audit_explicit_run_refusal,",
    ] {
        assert!(lib.contains(cmd), "{cmd} is not registered");
    }
}
