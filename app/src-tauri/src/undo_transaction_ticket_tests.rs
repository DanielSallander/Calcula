//! FILENAME: app/src-tauri/src/undo_transaction_ticket_tests.rs
//! PURPOSE: Wave D review F1 / F3. A frontend caller closes only the undo
//!          transaction ITS begin opened -- and that must survive the three
//!          things that end the transaction behind its opener's back: a sheet
//!          structure command (Excel parity: it ENDS the history, open
//!          transaction included), a document swap (the same clear), and a
//!          ticketless close by a caller that only joined. Before the tickets,
//!          the opener's "my begin opened it" record went stale at any of them
//!          and its commit / cancel closed whatever was open next: a STRANGER's
//!          chart drag, paste or script batch, halfway -- or, for a cancel,
//!          with its undo record dropped.
//! CONTEXT: Drives the real doors' bodies (`open_or_join_undo_transaction` with
//!          the same `begin_transaction_from_caller` the Tauri command passes,
//!          `commit_undo_transaction_core`, `cancel_undo_transaction_core`) and
//!          the real sheet add (`sheets::add_sheet_inner`), over a real
//!          `AppState`. Nothing here moves an `AppState` between a begin and
//!          its close (tickets are keyed by the stack's address; Tauri never
//!          moves the one it manages).

use crate::persistence::FileState;
use crate::undo_commands::{
    cancel_undo_transaction_core, commit_undo_transaction_core, open_or_join_undo_transaction,
};
use crate::AppState;

/// What the Tauri `begin_undo_transaction` command does, over `&AppState`.
fn begin(state: &AppState, description: &str) -> Option<u64> {
    let description = description.to_string();
    open_or_join_undo_transaction(state, |stack| stack.begin_transaction_from_caller(description))
}

/// A cell write, as every writer records it: into the open transaction, or as
/// a step of its own when none is open.
fn write(state: &AppState, row: u32) {
    state.undo_stack.lock().unwrap().record_cell_change(0, row, 0, None);
}

fn is_open(state: &AppState) -> bool {
    state.undo_stack.lock().unwrap().has_open_transaction()
}

fn depth(state: &AppState) -> usize {
    state.undo_stack.lock().unwrap().undo_depth()
}

fn top(state: &AppState) -> Option<String> {
    state.undo_stack.lock().unwrap().undo_description().map(String::from)
}

/// The real sheet add: its `invalidate_undo_history_for_sheet_structure` ends
/// the history, open transaction included.
fn add_sheet(state: &AppState, file: &FileState) {
    crate::sheets::add_sheet_inner(state, file, None, ::persistence::SheetKind::Worksheet)
        .expect("add a sheet");
}

#[test]
fn positive_control_a_ticket_closes_the_transaction_its_begin_opened() {
    let state = crate::create_app_state();
    let ticket = begin(&state, "Build report").expect("an opening begin is handed a ticket");
    write(&state, 0);
    write(&state, 1);
    assert!(commit_undo_transaction_core(&state, Some(ticket)), "the opener's commit closed nothing");
    assert!(!is_open(&state));
    assert_eq!(depth(&state), 1);
    assert_eq!(top(&state).as_deref(), Some("Build report"));
}

#[test]
fn a_begin_that_joins_is_handed_no_ticket() {
    let state = crate::create_app_state();
    let opener = begin(&state, "Paste").expect("opened");
    assert_eq!(begin(&state, "Script"), None, "a JOINING begin was handed a ticket: it would close the opener's step");
    assert!(
        state.undo_stack.lock().unwrap().open_transaction_absorbed_begin(),
        "the join no longer MARKS the step (BUG-0200)"
    );
    assert!(commit_undo_transaction_core(&state, Some(opener)));
    assert_eq!(top(&state), None, "an empty transaction is not a step");
}

#[test]
fn a_commit_after_a_sheet_add_does_not_close_a_strangers_transaction() {
    let state = crate::create_app_state();
    let file = FileState::default();
    let script = begin(&state, "Build report").expect("the script's batch opened");
    write(&state, 0);
    add_sheet(&state, &file); // ends the history, the script's transaction with it
    assert!(!is_open(&state), "fixture: a sheet add ends the open transaction");
    let user = begin(&state, "Move chart").expect("the user's gesture opened");
    write(&state, 5);
    assert!(
        !commit_undo_transaction_core(&state, Some(script)),
        "the script's commit closed a transaction its ticket does not name"
    );
    assert!(is_open(&state), "the script's commitBatch committed the user's 'Move chart' transaction halfway");
    write(&state, 6);
    assert!(commit_undo_transaction_core(&state, Some(user)), "the user's own commit was refused");
    assert_eq!(depth(&state), 1, "the user's gesture is not ONE step");
    assert_eq!(top(&state).as_deref(), Some("Move chart"));
}

#[test]
fn a_commit_after_a_sheet_add_does_not_close_a_transaction_the_backend_opened() {
    // No ticketed begin retires the script's ticket here: the transaction that
    // follows the clear is opened by a backend command, not through the door.
    // Only the clear itself tells the ticket is spent.
    let state = crate::create_app_state();
    let file = FileState::default();
    let script = begin(&state, "Build report").expect("the script's batch opened");
    add_sheet(&state, &file);
    state.undo_stack.lock().unwrap().begin_transaction("Create table");
    write(&state, 0);
    assert!(
        !commit_undo_transaction_core(&state, Some(script)),
        "a ticket issued before the history ended closed a transaction opened after it"
    );
    assert!(is_open(&state), "the backend's own 'Create table' step was committed halfway by the script");
    state.undo_stack.lock().unwrap().commit_transaction();
    assert_eq!(top(&state).as_deref(), Some("Create table"));
}

#[test]
fn a_cancel_after_a_sheet_add_does_not_drop_a_strangers_transaction() {
    let state = crate::create_app_state();
    let file = FileState::default();
    let run = begin(&state, "Macro").expect("the run's batch opened");
    add_sheet(&state, &file);
    let user = begin(&state, "Paste").expect("the user's paste opened");
    write(&state, 0);
    assert!(
        !cancel_undo_transaction_core(&state, Some(run)),
        "the run's cleanup cancelled a transaction its ticket does not name"
    );
    assert!(is_open(&state), "the run's cleanup dropped the user's 'Paste' transaction (its undo record lost)");
    assert!(commit_undo_transaction_core(&state, Some(user)));
    assert_eq!(top(&state).as_deref(), Some("Paste"));
}

#[test]
fn a_late_cancel_from_the_previous_document_does_not_land_in_the_next() {
    // A document swap clears the stack exactly as a sheet add does
    // (persistence.rs `reset_document_scoped_stores`: `undo_stack.clear()`).
    let state = crate::create_app_state();
    let departed = begin(&state, "Script batch").expect("opened in the old document");
    state.undo_stack.lock().unwrap().clear();
    let next = begin(&state, "Fill series").expect("opened in the new document");
    write(&state, 0);
    assert!(!cancel_undo_transaction_core(&state, Some(departed)), "a sweep from the old document closed a transaction of the new one");
    assert!(is_open(&state), "the new document's transaction was dropped by the old document's sweep");
    assert!(commit_undo_transaction_core(&state, Some(next)));
    assert_eq!(depth(&state), 1);
}

#[test]
fn a_ticketless_close_retires_the_ticket_it_closed() {
    // A Core gesture JOINS the script's batch and closes it without a ticket
    // (the pre-ticket shape). The script's ticket then names a transaction that
    // is gone -- in the same history, so only the retirement can tell.
    let state = crate::create_app_state();
    let script = begin(&state, "Script batch").expect("opened");
    assert_eq!(begin(&state, "Paste"), None, "fixture: the paste joins");
    write(&state, 0);
    assert!(commit_undo_transaction_core(&state, None), "the ticketless close must still close (unadopted callers)");
    // The backend then opens one of its own, not through the door...
    state.undo_stack.lock().unwrap().begin_transaction("Internal step");
    assert!(
        !commit_undo_transaction_core(&state, Some(script)),
        "a ticket whose transaction a ticketless close already committed closed another one"
    );
    assert!(is_open(&state), "the backend's own transaction was closed by a stale ticket");
    state.undo_stack.lock().unwrap().cancel_transaction();
}

#[test]
fn a_stale_ticket_never_retires_the_live_one() {
    let state = crate::create_app_state();
    let file = FileState::default();
    let stale = begin(&state, "Old").expect("opened");
    add_sheet(&state, &file);
    let live = begin(&state, "New").expect("opened");
    write(&state, 0);
    assert!(!commit_undo_transaction_core(&state, Some(stale)));
    assert!(!cancel_undo_transaction_core(&state, Some(stale)));
    assert!(
        commit_undo_transaction_core(&state, Some(live)),
        "a stale ticket's close retired the live ticket, so its opener can no longer close its own step"
    );
    assert_eq!(top(&state).as_deref(), Some("New"));
}

#[test]
fn a_ticket_closes_once() {
    let state = crate::create_app_state();
    let ticket = begin(&state, "Once").expect("opened");
    write(&state, 0);
    assert!(commit_undo_transaction_core(&state, Some(ticket)));
    state.undo_stack.lock().unwrap().begin_transaction("Internal step");
    assert!(!commit_undo_transaction_core(&state, Some(ticket)), "a spent ticket closed the next transaction");
    assert!(is_open(&state));
    state.undo_stack.lock().unwrap().cancel_transaction();
}

#[test]
fn positive_control_a_ticketless_close_still_closes_whatever_is_open() {
    let state = crate::create_app_state();
    state.undo_stack.lock().unwrap().begin_transaction("Opened elsewhere");
    write(&state, 0);
    assert!(commit_undo_transaction_core(&state, None));
    assert!(!is_open(&state));
    assert_eq!(top(&state).as_deref(), Some("Opened elsewhere"));
    state.undo_stack.lock().unwrap().begin_transaction("Opened elsewhere too");
    assert!(cancel_undo_transaction_core(&state, None));
    assert!(!is_open(&state));
}

#[test]
fn tickets_are_per_stack() {
    let a = crate::create_app_state();
    let b = crate::create_app_state();
    let ticket_a = begin(&a, "A").expect("opened on A");
    let ticket_b = begin(&b, "B").expect("opened on B");
    assert_ne!(ticket_a, ticket_b, "two opens were handed the same ticket");
    assert!(!commit_undo_transaction_core(&b, Some(ticket_a)), "A's ticket closed B's transaction");
    assert!(is_open(&b));
    assert!(commit_undo_transaction_core(&a, Some(ticket_a)), "B's begin retired A's ticket");
    assert!(cancel_undo_transaction_core(&b, Some(ticket_b)));
}

#[test]
fn the_tauri_doors_take_and_hand_back_the_ticket() {
    // The commands are the wire: the begin answers the ticket (null = joined)
    // and the commit / cancel accept one. Their bodies must be these bodies.
    let src = include_str!("undo_commands.rs");
    let body_of = |name: &str| {
        let at = src.find(name).unwrap_or_else(|| panic!("{name} is gone"));
        &src[at..at + src[at..].find("\n}").expect("its body")]
    };
    let begin = body_of("pub fn begin_undo_transaction(");
    assert!(begin.contains("-> Option<u64>"), "the begin no longer answers a ticket:\n{begin}");
    assert!(begin.contains("open_or_join_undo_transaction("), "the begin door bypasses the ticket issue:\n{begin}");
    let commit = body_of("pub fn commit_undo_transaction(");
    assert!(commit.contains("ticket: Option<u64>") && commit.contains("commit_undo_transaction_core(&state, ticket)"), "{commit}");
    let cancel = body_of("pub fn cancel_undo_transaction(");
    assert!(cancel.contains("ticket: Option<u64>") && cancel.contains("cancel_undo_transaction_core(&state, ticket)"), "{cancel}");
}
