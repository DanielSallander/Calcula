//! FILENAME: app/src-tauri/src/scoped_undo_tests.rs
//! PURPOSE: A scoped undo must decide and pop under ONE lock, and the push
//! hold-back must be the thing that asks it to.
//!
//! CONTEXT: Unticking a change in the push diff means "publish without this,
//! keep it locally". It is implemented as: roll the cell back to its base value
//! in the LIVE document, publish, then undo. Rolling back at serialization time
//! instead would be simpler and is wrong — nothing on the receiving side ever
//! recalculates, so a formula whose inputs did not ship would show a number that
//! was never true, invisibly.
//!
//! The cost is a window in which the author's own workbook is wrong, and the
//! feature SHIPPED DISABLED because that window was not safe:
//!
//! ```text
//!   holdBackCells()      // writes, records an undo entry
//!   publish()            // seconds of signing + writing to a share
//!   undo()               // <-- blind pop_undo(): takes whatever is on TOP
//! ```
//!
//! `calp_publish` records nothing on the undo stack itself, but the dialog is
//! deliberately non-modal, so the author can edit; and an MCP tool
//! (`mcp/tools.rs:336`) or a sandboxed script can write while it runs. Any of
//! those puts an entry on top, and the bare undo reversed THAT — leaving the
//! held-back cells rolled back permanently and silently. A save then persists
//! the base value; AutoRecover does not help, because it snapshots LIVE state
//! and the undo stack is never serialized.
//!
//! `undo` now takes an optional `expected_seq`. These are SOURCE-PLACEMENT
//! guards for the same reason `refresh_resolution_tests` is: what regressed is
//! the SHAPE of a command that needs a `tauri::AppHandle` and eight `State`
//! handles to call. The arithmetic half is behavioural, in
//! `core/engine/src/undo.rs` (`the_top_id_is_what_a_plain_undo_would_take`).

/// The body of one function, comment-stripped.
///
/// COMMENTS ARE STRIPPED because every guard below is documented AT its site
/// with a comment naming the thing it is ordered against — a scanner that reads
/// comments finds the phrase in the explanation and reports a correct file as
/// broken.
fn body_of(src: &str, signature: &str) -> String {
    let start = src
        .find(signature)
        .unwrap_or_else(|| panic!("signature not found: {}", signature));
    let rest = &src[start..];
    let end = rest.find("\n}\n").unwrap_or(rest.len());
    rest[..end]
        .lines()
        .map(|line| match line.find("//") {
            Some(i) => line[..i].to_string(),
            None => line.to_string(),
        })
        .collect::<Vec<_>>()
        .join("\n")
}

const UNDO_SRC: &str = include_str!("undo_commands.rs");
const CALP_SRC: &str = include_str!("calp_commands.rs");

/// Byte offset of `needle`, or a panic naming what was missing.
fn at(hay: &str, needle: &str, what: &str) -> usize {
    hay.find(needle)
        .unwrap_or_else(|| panic!("{} is gone (looked for `{}`)", what, needle))
}

// ---------------------------------------------------------------------------
// A. The decision itself — BEHAVIOURAL
//
// The placement guards in section B cannot see a condition somebody has
// neutered: a `if false && ...` inside the check leaves every source-text
// assertion satisfied. (Measured — the first sabotage of this file's own guard
// was a no-op for exactly that reason.) The decision is therefore extracted as
// a pure function and exercised directly.
// ---------------------------------------------------------------------------

use crate::undo_commands::{scoped_undo_verdict, ScopedUndoVerdict};

/// No expectation is an ORDINARY undo. Every existing caller — the keyboard
/// shortcut, the ribbon, scripts, MCP — passes `None` and must be unaffected.
///
/// SABOTAGE: refuse when `expected` is `None`. Ctrl+Z stops working app-wide.
#[test]
fn an_unscoped_undo_always_proceeds() {
    assert_eq!(scoped_undo_verdict(None, Some(7), &[5, 6, 7]), ScopedUndoVerdict::Proceed);
    assert_eq!(scoped_undo_verdict(None, None, &[]), ScopedUndoVerdict::Proceed);
}

/// The entry the caller recorded is still on top: this is the case the hold-back
/// is in every time nothing interfered, and it must go ahead.
///
/// SABOTAGE: compare against `seqs.first()`.
#[test]
fn the_entry_it_recorded_is_undone_when_it_is_still_on_top() {
    assert_eq!(scoped_undo_verdict(Some(7), Some(7), &[5, 6, 7]), ScopedUndoVerdict::Proceed);
}

/// SOMETHING ELSE LANDED ON TOP — the author's own edit in this non-modal
/// dialog, an MCP tool (genuinely concurrent, off the main thread), one of the
/// async pivot commands. Undoing here reverses THAT and leaves the held-back
/// cells rolled back permanently and silently.
///
/// SABOTAGE: return `Proceed` whenever the entry is still present anywhere.
#[test]
fn a_buried_entry_refuses_and_counts_the_way_back() {
    let v = scoped_undo_verdict(Some(7), Some(9), &[5, 6, 7, 8, 9]);
    match v {
        ScopedUndoVerdict::Refuse(m) => {
            assert!(m.contains("2 later change(s)"), "counts what is above it: {m}");
            assert!(m.contains("Ctrl+Z 3 time(s)"), "and the steps back: {m}");
        }
        ScopedUndoVerdict::Proceed => panic!("undoing here reverses somebody else's work"),
    }
}

/// The entry is GONE — evicted by the history cap, or already undone. No number
/// of undo steps reaches it, so a message promising a count would send the user
/// chasing something that is not there.
///
/// SABOTAGE: collapse both arms into the "press Ctrl+Z N times" sentence.
#[test]
fn an_entry_that_is_gone_refuses_differently() {
    let v = scoped_undo_verdict(Some(7), Some(12), &[9, 10, 11, 12]);
    match v {
        ScopedUndoVerdict::Refuse(m) => {
            assert!(m.contains("no longer in the undo history"), "{m}");
            assert!(!m.contains("Ctrl+Z"), "must not promise a count it cannot honour: {m}");
        }
        ScopedUndoVerdict::Proceed => panic!("there is nothing there to undo"),
    }
}

/// An empty history with an expectation is the "gone" case, not the "proceed"
/// case. `top` is `None`, which equals no expectation if the two are compared
/// carelessly.
///
/// SABOTAGE: `if top == expected` without the `Some` wrapper — `None == None`
/// then proceeds, and the un-revert pops nothing while reporting success.
#[test]
fn an_empty_history_refuses_a_scoped_undo() {
    match scoped_undo_verdict(Some(7), None, &[]) {
        ScopedUndoVerdict::Refuse(m) => assert!(m.contains("no longer in the undo history"), "{m}"),
        ScopedUndoVerdict::Proceed => {
            panic!("an empty history holds nothing the caller could have recorded")
        }
    }
}

// ---------------------------------------------------------------------------
// B. The guard decides and pops under ONE lock
// ---------------------------------------------------------------------------

/// THE WHOLE POINT. Reading the top id, releasing the lock, and then popping is
/// the same race one layer up: another command can land an entry in between and
/// the pop takes it.
///
/// SABOTAGE: move the `if let ScopedUndoVerdict::Refuse` block above
/// `let mut undo_stack = state.undo_stack.lock()`, giving it its own lock.
#[test]
fn the_scoped_check_and_the_pop_share_one_critical_section() {
    let body = body_of(UNDO_SRC, "pub fn undo(");
    let lock = at(&body, "state.undo_stack.lock()", "the undo-stack lock");
    let check = at(&body, "if let ScopedUndoVerdict::Refuse", "the scoped guard");
    let pop = at(&body, "undo_stack.pop_undo()", "the pop");
    assert!(
        lock < check && check < pop,
        "the guard must sit between the lock and the pop: deciding under one \
         lock and popping under another is the race it exists to close"
    );
    // And the stack is acquired ONCE across that region — the slice starts AT
    // the acquisition, so one occurrence is the guard holding and a second is
    // the released-and-retaken shape spelled differently.
    let between = &body[lock..pop];
    assert_eq!(
        between.matches("undo_stack.lock()").count(),
        1,
        "the region between the lock and the pop re-acquires the stack: {}",
        between
    );
}

/// A refusal must not pop. The failure it prevents is reversing somebody else's
/// work; popping and then reporting a refusal would DO that and report it.
///
/// SABOTAGE: delete the `return UndoResult { ... }` and let the guard fall
/// through to `pop_undo`.
#[test]
fn a_refused_scoped_undo_returns_before_it_pops() {
    let body = body_of(UNDO_SRC, "pub fn undo(");
    let check = at(&body, "if let ScopedUndoVerdict::Refuse", "the scoped guard");
    let pop = at(&body, "undo_stack.pop_undo()", "the pop");
    let refusal_return = at(&body[check..pop], "return UndoResult {", "the refusal's return");
    assert!(
        check + refusal_return < pop,
        "the guard must RETURN, not fall through: a pop followed by a refusal \
         message reverses the very entry the refusal claims to have protected"
    );
    // The refusal is distinguishable from "there was nothing to undo", which is
    // the other `success: false` this command can return.
    assert!(
        body[check..pop].contains("refusal: Some(refusal)"),
        "a refusal must say so in its own field; conflating it with \
         `success: false` tells the caller their work was safely restored"
    );
}

/// ONE DECISION, in the function section A tests. A copy of the logic inlined
/// here would be a second decision that drifts, and the behavioural tests would
/// go on passing while the command did something else.
///
/// SABOTAGE: inline the `rposition` walk back into the command body.
#[test]
fn the_command_delegates_to_the_shared_verdict() {
    let body = body_of(UNDO_SRC, "pub fn undo(");
    assert!(
        body.contains("scoped_undo_verdict("),
        "the command must ask the shared decision, not re-derive it"
    );
    assert!(
        !body.contains("rposition"),
        "a second copy of the walk here is a second decision — section A would \
         keep passing while this one drifted"
    );
    // Both inputs the decision needs come from the SAME locked read.
    assert!(body.contains("undo_stack.top_undo_seq()"));
    assert!(body.contains("undo_stack.undo_seqs()"));
}

/// Every ordinary caller is untouched: `expected_seq` is an `Option`, so an
/// omitted key deserializes to `None` and the keyboard shortcut, the ribbon,
/// scripts and MCP all behave exactly as before.
///
/// SABOTAGE: make it a bare `u64`. Every `invoke("undo")` in the app then fails
/// to deserialize.
#[test]
fn an_omitted_expected_seq_is_an_ordinary_undo() {
    let sig = body_of(UNDO_SRC, "pub fn undo(");
    assert!(
        sig.contains("expected_seq: Option<u64>"),
        "the parameter must be optional at the wire"
    );
}

// ---------------------------------------------------------------------------
// B. The hold-back reports an id, and reports it honestly
// ---------------------------------------------------------------------------

/// The command must CLAIM the id, not OBSERVE it.
///
/// `apply_script_modified_grids` reaches the undo stack by two different routes
/// — an outer transaction when an off-sheet sheet was touched, or
/// `update_cells_batch` recording its own when only the active sheet moved —
/// and neither returns the id. Reading the top of the stack afterwards answers
/// for both, and is a SECOND critical section: an MCP tool thread
/// (`mcp/tools.rs:336`, genuinely concurrent — it is off the main thread), or
/// one of the async pivot/report commands, that records an entry between the
/// write and the read makes THAT entry the answer. The caller then scopes its
/// un-revert to a stranger's write and reverses it confidently — strictly worse
/// than the bare undo this replaces.
///
/// Owning the transaction closes the window: both inner routes join it, and the
/// commit is what stamps the id and hands it back.
///
/// SABOTAGE: replace the begin/commit pair with a `top_undo_seq()` read after
/// the write.
#[test]
fn the_hold_back_claims_its_undo_id_rather_than_observing_it() {
    let body = body_of(CALP_SRC, "pub fn calp_hold_back_cells(");
    let begin = at(&body, "undo.begin_transaction(", "the transaction this command owns");
    let apply = at(&body, "apply_script_modified_grids(", "the write");
    let commit = at(&body, "undo.commit_transaction()", "the commit that stamps the id");
    assert!(
        begin < apply && apply < commit,
        "the command must open the transaction, write inside it, and commit it \
         itself — that commit is the only unraced source of the id"
    );
    assert!(
        !body.contains("top_undo_seq()"),
        "observing the top of the stack is the race this design removes"
    );
    assert!(
        body.contains("undo_seq = {") && body.contains("undo.commit_transaction()"),
        "the id must come FROM the commit"
    );
}

/// The transaction opens AFTER every refusal, and closes on BOTH paths out.
///
/// A transaction left open by an early return bleeds into the next edit the user
/// makes — it is the hazard `apply_script_modified_grids_core`'s own "ALWAYS
/// commit" comment names.
///
/// SABOTAGE: move the `begin_transaction` above `open_verified_content`, or
/// change `let applied = ...;` back to `...?;`.
#[test]
fn the_hold_backs_transaction_cannot_dangle() {
    let body = body_of(CALP_SRC, "pub fn calp_hold_back_cells(");
    let verify = at(&body, "open_verified_content(", "the workspace verification");
    let no_sheet = at(&body, "CALP_HOLDBACK_NO_SHEET", "the missing-sheet refusal");
    let begin = at(&body, "undo.begin_transaction(", "the transaction");
    assert!(
        verify < begin && no_sheet < begin,
        "every refusal must precede the transaction"
    );

    let apply = at(&body, "let applied = crate::scripting", "the non-propagating write");
    let commit = at(&body, "undo.commit_transaction()", "the commit");
    let propagate = at(&body, "applied?;", "the deferred error propagation");
    assert!(
        apply < commit && commit < propagate,
        "the write's error must be propagated AFTER the commit, or a failed \
         write strands a partial one inside an open transaction"
    );
}

/// The pipeline must not commit a transaction its CALLER opened.
///
/// `begin_transaction` is a no-op while one is open, so
/// `apply_script_modified_grids_core` used to commit a caller's transaction as
/// if it were its own — `update_cells_batch` had always checked for that and
/// this had not, which is the asymmetry that made a wrapping caller impossible
/// to write.
///
/// SABOTAGE: drop `opened_here` and commit unconditionally. The hold-back's
/// commit then returns `None`, the caller gets no id, and it refuses every push
/// that holds anything back.
#[test]
fn the_script_pipeline_commits_only_what_it_opened() {
    const SCRIPTING: &str = include_str!("scripting/commands.rs");
    let body = body_of(SCRIPTING, "pub(crate) fn apply_script_modified_grids_core(");
    assert!(
        body.contains("opened_here = !undo.has_open_transaction()"),
        "the pipeline must record whether IT opened the transaction"
    );
    let commit = at(&body, "undo.commit_transaction()", "the commit");
    let guard = at(&body, "if opened_here {", "the ownership guard");
    assert!(guard < commit, "and commit only under that guard");
}

/// `undo_recorded` and `undo_seq` must be ONE fact. A caller handed
/// `undo_recorded: true` with no id would fall back to a bare undo, which is
/// exactly the unsafe behaviour this pair exists to remove.
///
/// SABOTAGE: `undo_recorded: held > 0`, the previous spelling.
#[test]
fn the_two_facts_the_caller_needs_cannot_disagree() {
    let body = body_of(CALP_SRC, "pub fn calp_hold_back_cells(");
    assert!(
        body.contains("undo_recorded: undo_seq.is_some()"),
        "`undo_recorded` must be DERIVED from the id, not computed beside it"
    );
}

/// The early return writes nothing, so it must claim nothing.
///
/// SABOTAGE: return `undo_recorded: true` there.
#[test]
fn an_empty_hold_back_reports_no_entry() {
    let body = body_of(CALP_SRC, "pub fn calp_hold_back_cells(");
    let empty = at(&body, "if params.cells.is_empty()", "the empty early return");
    let region = &body[empty..empty + 300];
    assert!(region.contains("undo_recorded: false"));
    assert!(region.contains("undo_seq: None"));
}
