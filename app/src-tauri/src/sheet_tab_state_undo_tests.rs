//! FILENAME: app/src-tauri/src/sheet_tab_state_undo_tests.rs
//! PURPOSE: BUG-0050 — hiding a sheet, unhiding one, and recolouring a tab are
//!          PERSISTED changes, so undo has to be able to reverse them.
//!
//! # What was wrong
//!
//! `hide_sheet`, `unhide_sheet` and `set_tab_color` each construct
//! `DocumentEffect::mutates` — the state IS written into the `.cala` — took no
//! `undo_stack`, recorded nothing, and, unlike the five structural sheet
//! commands, did not call `invalidate_undo_history_for_sheet_structure` either.
//!
//! That is the one state that is indefensible under any reading of Excel: a
//! persisted change that undo cannot reverse, with the history still claiming it
//! can. Three actions reach it — type into Sheet1!A1, hide Sheet2, press Ctrl+Z
//! — and the cell edit is undone while Sheet2 stays hidden, with nothing to say
//! a step was skipped. Found by the soak walk (seed 90070001,
//! `undo-round-trip`): "Undoing 26 steps did not restore the checkpoint state.
//! 1 differences; first: sheets[1].visibility: \"visible\" -> \"hidden\"".
//!
//! # Why an undo ENTRY and not the history invalidation
//!
//! Argued in full on `SheetTabStateSnapshot` in `undo_commands.rs`. The short
//! form: the five structural commands end the history because they RENUMBER the
//! sheet indices every queued entry names (or, for a rename, rewrite every
//! formula that spells the name). These three renumber nothing and rewrite
//! nothing — they assign one element of a parallel `Vec` in place — so the
//! hazard the invalidation exists to prevent is absent, and what is left is an
//! asymmetry of cost: ending the history throws away every undo step the user
//! had, recording an entry costs a few bytes.

use std::collections::{HashMap, HashSet};

use crate::persistence::FileState;
use crate::AppState;

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

/// A workbook with `count` sheets, seeded the way a load does.
fn workbook_with_sheets(count: usize) -> AppState {
    let state = crate::create_app_state();
    let seed = crate::document_effect::test_seed_effect;
    for i in 1..count {
        state.grids.write(&seed()).unwrap().push(engine::Grid::new());
        state
            .sheet_names
            .write(&seed())
            .unwrap()
            .push(format!("Sheet{}", i + 1));
        state.all_column_widths.write(&seed()).unwrap().push(HashMap::new());
        state.all_row_heights.write(&seed()).unwrap().push(HashMap::new());
        state.all_user_hidden_rows.write(&seed()).unwrap().push(HashSet::new());
        state.all_user_hidden_cols.write(&seed()).unwrap().push(HashSet::new());
        state.all_merged_regions.write(&seed()).unwrap().push(HashSet::new());
        state
            .sheet_ids
            .write(&seed())
            .unwrap()
            .push(identity::SheetId::from_bytes(identity::generate_uuid_v7()));
    }
    state
}

fn visibility(state: &AppState, index: usize) -> String {
    state
        .sheet_visibility
        .read()
        .unwrap()
        .get(index)
        .cloned()
        .unwrap_or_else(|| "visible".to_string())
}

fn tab_color(state: &AppState, index: usize) -> String {
    state.tab_colors.read().unwrap().get(index).cloned().unwrap_or_default()
}

/// Replay the top undo entry the way `apply_changes` does its DEFERRED pass:
/// every guard released, one restore adapter, one inverse transaction.
///
/// Returns the inverse, so a caller can push it back and drive a redo the same
/// way. Panics if the stack is empty — "there was nothing to undo" is the
/// defect these tests are about, and it must not read as a pass.
fn undo_once(state: &AppState) -> engine::undo::Transaction {
    let transaction = state
        .undo_stack
        .lock()
        .unwrap()
        .pop_undo()
        .expect("nothing on the undo stack — the command recorded no entry");
    let mut inverse = engine::undo::Transaction::new("inverse");
    for change in &transaction.changes {
        if let engine::undo::CellChange::CustomRestore { kind, data } = change {
            assert_eq!(
                kind,
                crate::undo_commands::SHEET_TAB_STATE_RESTORE_KIND,
                "the entry is not a sheet-tab-state restore"
            );
            crate::undo_commands::apply_sheet_tab_state_restore(
                state,
                &crate::document_effect::test_seed_effect(),
                data,
                &mut inverse,
            );
        }
    }
    inverse
}

/// Replay an inverse transaction — the redo half.
fn redo(state: &AppState, inverse: &engine::undo::Transaction) {
    let mut discard = engine::undo::Transaction::new("discard");
    for change in &inverse.changes {
        if let engine::undo::CellChange::CustomRestore { kind, data } = change {
            assert_eq!(kind, crate::undo_commands::SHEET_TAB_STATE_RESTORE_KIND);
            crate::undo_commands::apply_sheet_tab_state_restore(
                state,
                &crate::document_effect::test_seed_effect(),
                data,
                &mut discard,
            );
        }
    }
}

// ---------------------------------------------------------------------------
// The invariant: each of the three is reversible
// ---------------------------------------------------------------------------

#[test]
fn undoing_a_hide_makes_the_sheet_visible_again() {
    let state = workbook_with_sheets(3);
    let file = FileState::default();

    crate::sheets::hide_sheet_inner(&state, &file, 1, None).expect("hide Sheet2");
    assert_eq!(visibility(&state, 1), "hidden", "precondition");

    undo_once(&state);

    assert_eq!(
        visibility(&state, 1),
        "visible",
        "undo left the sheet hidden — a persisted change the history claimed it could reverse"
    );
}

#[test]
fn redoing_a_hide_hides_it_again() {
    // The inverse the restore captures is the other half of the contract: a
    // restore that put the state back but recorded nothing would make the first
    // Ctrl+Y a silent no-op.
    let state = workbook_with_sheets(3);
    let file = FileState::default();

    crate::sheets::hide_sheet_inner(&state, &file, 1, None).expect("hide Sheet2");
    let inverse = undo_once(&state);
    assert_eq!(visibility(&state, 1), "visible", "precondition");

    redo(&state, &inverse);

    assert_eq!(visibility(&state, 1), "hidden", "redo did not re-apply the hide");
}

#[test]
fn undoing_an_unhide_hides_it_again() {
    let state = workbook_with_sheets(3);
    let file = FileState::default();

    crate::sheets::hide_sheet_inner(&state, &file, 2, None).expect("hide Sheet3");
    // Clear the hide's own entry so the unhide's is on top.
    state.undo_stack.lock().unwrap().pop_undo().expect("the hide recorded one");

    crate::sheets::unhide_sheet_inner(&state, &file, 2).expect("unhide Sheet3");
    assert_eq!(visibility(&state, 2), "visible", "precondition");

    undo_once(&state);

    assert_eq!(visibility(&state, 2), "hidden", "undo of an unhide did not re-hide");
}

#[test]
fn undoing_a_tab_colour_restores_the_previous_one() {
    let state = workbook_with_sheets(2);
    let file = FileState::default();

    crate::sheets::set_tab_color_inner(&state, &file, 1, "#ff0000".to_string())
        .expect("set red");
    state.undo_stack.lock().unwrap().pop_undo().expect("the first recolour recorded one");
    crate::sheets::set_tab_color_inner(&state, &file, 1, "#00ff00".to_string())
        .expect("set green");
    assert_eq!(tab_color(&state, 1), "#00ff00", "precondition");

    undo_once(&state);

    assert_eq!(
        tab_color(&state, 1),
        "#ff0000",
        "undo of a recolour must restore the PREVIOUS colour, not clear it"
    );
}

// ---------------------------------------------------------------------------
// Where the user is standing
// ---------------------------------------------------------------------------

#[test]
fn undoing_the_hide_of_the_active_sheet_puts_the_user_back_on_it() {
    // Hiding the ACTIVE sheet moves the user off it (BUG-0046). If the undo
    // only restored the flag, the sheet would come back visible while the user
    // stood somewhere else, looking at no evidence that anything happened —
    // Excel selects what an undo restored, and this is the sheet-level form of
    // it.
    let state = workbook_with_sheets(3);
    let file = FileState::default();
    crate::sheets::activate_sheet(&state, 1).expect("switch to Sheet2");

    crate::sheets::hide_sheet_inner(&state, &file, 1, None).expect("hide Sheet2");
    assert_eq!(*state.active_sheet.read().unwrap(), 0, "precondition: moved off");

    undo_once(&state);

    assert_eq!(visibility(&state, 1), "visible");
    assert_eq!(
        *state.active_sheet.read().unwrap(),
        1,
        "undo restored the sheet but left the user on another one"
    );
}

#[test]
fn undoing_the_hide_of_a_non_active_sheet_moves_nobody() {
    // Non-vacuity for the test above: the follow must be conditional, or every
    // undo of a hide would yank the user away from the sheet they are working
    // on.
    let state = workbook_with_sheets(3);
    let file = FileState::default();
    crate::sheets::activate_sheet(&state, 1).expect("switch to Sheet2");

    crate::sheets::hide_sheet_inner(&state, &file, 2, None).expect("hide Sheet3");
    assert_eq!(*state.active_sheet.read().unwrap(), 1, "precondition: stayed put");

    undo_once(&state);

    assert_eq!(visibility(&state, 2), "visible");
    assert_eq!(*state.active_sheet.read().unwrap(), 1, "the user must stay put");
}

#[test]
fn an_unhide_undo_never_moves_the_user() {
    // The `active_sheet` field is deliberately `None` for unhide and recolour:
    // a change that did not move the view must not move it back.
    let state = workbook_with_sheets(3);
    let file = FileState::default();
    crate::sheets::hide_sheet_inner(&state, &file, 2, None).expect("hide Sheet3");
    state.undo_stack.lock().unwrap().pop_undo().expect("the hide recorded one");
    crate::sheets::activate_sheet(&state, 1).expect("switch to Sheet2");

    crate::sheets::unhide_sheet_inner(&state, &file, 2).expect("unhide Sheet3");
    undo_once(&state);

    assert_eq!(*state.active_sheet.read().unwrap(), 1, "the user must stay put");
}

#[test]
fn undo_refuses_to_land_the_user_on_a_hidden_sheet() {
    // Excel cannot make a hidden sheet active — there is no tab to select and
    // `Activate` raises in VBA — so a recorded standing point that has since
    // become hidden is NOT followed. The alternative is the torn state this
    // whole family exists to prevent: the grid painting a sheet the tab strip
    // cannot show.
    //
    // Reachable without inventing anything: hide the active Sheet2 (recording
    // "the user was on 2"), unhide it, hide it again from a DIFFERENT standing
    // point, then walk the history back.
    let state = workbook_with_sheets(3);
    let file = FileState::default();
    crate::sheets::activate_sheet(&state, 1).expect("switch to Sheet2");
    crate::sheets::hide_sheet_inner(&state, &file, 1, None).expect("hide Sheet2");

    // Drive the entry's restore by hand with Sheet2 still hidden: the snapshot
    // says "the user was on sheet 1", and sheet 1 is hidden at this moment.
    let transaction = state.undo_stack.lock().unwrap().pop_undo().expect("recorded");
    // Re-hide behind the restore so the recorded target is hidden when it runs.
    let mut inverse = engine::undo::Transaction::new("inverse");
    for change in &transaction.changes {
        if let engine::undo::CellChange::CustomRestore { kind, data } = change {
            // Doctor the payload: keep the standing point, restore a visibility
            // vector in which that sheet is STILL hidden. This is exactly the
            // shape a later hide leaves behind.
            let _ = kind;
            let doctored = crate::undo_commands::sheet_tab_state_snapshot_bytes(
                Some(vec![
                    "visible".to_string(),
                    "hidden".to_string(),
                    "visible".to_string(),
                ]),
                None,
                Some(1),
            );
            let _ = data;
            crate::undo_commands::apply_sheet_tab_state_restore(
                &state,
                &crate::document_effect::test_seed_effect(),
                &doctored,
                &mut inverse,
            );
        }
    }

    assert_eq!(visibility(&state, 1), "hidden", "the restore put the state back as recorded");
    assert_eq!(
        *state.active_sheet.read().unwrap(),
        0,
        "the restore followed its recorded standing point onto a HIDDEN sheet"
    );
}

// ---------------------------------------------------------------------------
// A no-op must not burn an undo step
// ---------------------------------------------------------------------------

#[test]
fn hiding_an_already_hidden_sheet_records_nothing() {
    let state = workbook_with_sheets(3);
    let file = FileState::default();
    crate::sheets::hide_sheet_inner(&state, &file, 2, None).expect("hide Sheet3");
    state.undo_stack.lock().unwrap().pop_undo().expect("the real hide recorded one");

    crate::sheets::hide_sheet_inner(&state, &file, 2, None).expect("hide it again");

    assert!(
        state.undo_stack.lock().unwrap().pop_undo().is_none(),
        "a hide that changed nothing pushed an undo step, so Ctrl+Z would \
         consume a press and appear to do nothing"
    );
}

#[test]
fn unhiding_an_already_visible_sheet_records_nothing() {
    let state = workbook_with_sheets(3);
    let file = FileState::default();

    crate::sheets::unhide_sheet_inner(&state, &file, 2).expect("unhide a visible sheet");

    assert!(
        state.undo_stack.lock().unwrap().pop_undo().is_none(),
        "an unhide that changed nothing pushed an undo step"
    );
}

#[test]
fn setting_the_same_tab_colour_records_nothing() {
    let state = workbook_with_sheets(2);
    let file = FileState::default();
    crate::sheets::set_tab_color_inner(&state, &file, 1, "#ff0000".to_string()).expect("red");
    state.undo_stack.lock().unwrap().pop_undo().expect("the real recolour recorded one");

    crate::sheets::set_tab_color_inner(&state, &file, 1, "#ff0000".to_string()).expect("red again");

    assert!(
        state.undo_stack.lock().unwrap().pop_undo().is_none(),
        "a recolour to the SAME colour pushed an undo step"
    );
}

#[test]
fn a_refused_hide_records_nothing() {
    // "Cannot hide the last visible sheet" is a refusal, and a refusal must not
    // cost the user an undo step any more than it costs them their data.
    let state = workbook_with_sheets(2);
    let file = FileState::default();
    crate::sheets::hide_sheet_inner(&state, &file, 1, None).expect("hide Sheet2");
    state.undo_stack.lock().unwrap().pop_undo().expect("the real hide recorded one");

    let refused = crate::sheets::hide_sheet_inner(&state, &file, 0, None);

    assert!(refused.is_err(), "hiding the last visible sheet must be refused");
    assert!(
        state.undo_stack.lock().unwrap().pop_undo().is_none(),
        "a refused hide pushed an undo step"
    );
}

// ---------------------------------------------------------------------------
// The source census: all three commands record, and the kind is registered
// ---------------------------------------------------------------------------

/// Brace-matched body of a free function in `src`, starting at `signature`.
fn body_after(src: &str, signature: &str) -> String {
    let at = src
        .find(signature)
        .unwrap_or_else(|| panic!("`{}` was renamed — re-derive this census", signature));
    let open = src[at..].find('{').expect("no body") + at;
    let bytes = src.as_bytes();
    let mut depth = 0usize;
    for i in open..src.len() {
        match bytes[i] {
            b'{' => depth += 1,
            b'}' => {
                depth -= 1;
                if depth == 0 {
                    return src[open..=i].to_string();
                }
            }
            _ => {}
        }
    }
    panic!("unbalanced braces after `{}`", signature)
}

#[test]
fn every_persisted_tab_state_command_records_an_undo_entry() {
    // The assertions above drive three functions. This is the guard against a
    // FOURTH one being added — or one of these three being rewritten — without
    // the entry, which is exactly how the family got into this state: nothing
    // catches a persisted mutation that fails to be UNDOABLE, the way
    // `DocumentEffect` catches one that fails to DIRTY.
    let src = include_str!("sheets.rs");
    for signature in [
        "pub(crate) fn hide_sheet_inner(",
        "pub(crate) fn unhide_sheet_inner(",
        "pub(crate) fn set_tab_color_inner(",
    ] {
        let body = body_after(src, signature);
        assert!(
            body.contains("SHEET_TAB_STATE_RESTORE_KIND"),
            "`{}` writes persisted sheet-tab state and records no undo entry. \
             That leaves the workbook in the state BUG-0050 was filed for: a \
             persisted change undo cannot reverse, with the history still \
             claiming it can.",
            signature
        );
        assert!(
            body.contains("record_custom_restore("),
            "`{}` names the restore kind but never records it",
            signature
        );
    }
}

#[test]
fn the_restore_kind_is_in_the_registry() {
    // A kind with no registry row is dispatched to `eprintln!("[undo] Unknown
    // custom restore kind")` and silently does nothing — the entry would be
    // recorded, popped, and dropped on the floor, which looks exactly like the
    // defect it was meant to fix.
    let src = include_str!("undo_commands.rs");
    let registry = body_after(src, "static RESTORE_REGISTRY:");
    assert!(
        registry.contains("SHEET_TAB_STATE_RESTORE_KIND"),
        "the sheet-tab-state restore kind has no row in RESTORE_REGISTRY, so \
         every recorded entry would be popped and discarded in silence"
    );
    assert!(
        registry.contains("m.insert(SHEET_TAB_STATE_RESTORE_KIND, RestoreSpec { restore: r_sheet_tab_state, domains: MutationDomains::of(Sheets), defer: true });"),
        "the registry row changed shape. `Sheets` is what makes the tab strip \
         re-read the list, and `defer: true` is what keeps the re-activation \
         out of the phase that still holds the grid locks."
    );
}

#[test]
fn the_census_detector_actually_fires() {
    // A census whose parse silently matches nothing passes forever and proves
    // nothing — the failure mode every census in this programme has had to be
    // hardened against. These are synthetic sources, so the rule is exercised
    // in both directions without touching the tree.
    let forgetful = "pub(crate) fn hide_sheet_inner(a: u8) {\n    let x = 1;\n}\n";
    let body = body_after(forgetful, "pub(crate) fn hide_sheet_inner(");
    assert!(
        !body.contains("SHEET_TAB_STATE_RESTORE_KIND"),
        "the detector would accept a command that records nothing"
    );

    let compliant = "pub(crate) fn hide_sheet_inner(a: u8) {\n    \
                     undo.record_custom_restore(SHEET_TAB_STATE_RESTORE_KIND.to_string());\n}\n";
    let body = body_after(compliant, "pub(crate) fn hide_sheet_inner(");
    assert!(body.contains("SHEET_TAB_STATE_RESTORE_KIND"));
    assert!(body.contains("record_custom_restore("));

    // ...and the brace matcher must stop at the function's OWN closing brace,
    // or every body would contain every later function's text and the census
    // would pass on any file that mentioned the constant anywhere.
    let two = "pub(crate) fn hide_sheet_inner(a: u8) {\n    let x = 1;\n}\n\
               pub(crate) fn other() {\n    SHEET_TAB_STATE_RESTORE_KIND;\n}\n";
    let body = body_after(two, "pub(crate) fn hide_sheet_inner(");
    assert!(
        !body.contains("SHEET_TAB_STATE_RESTORE_KIND"),
        "the brace matcher ran past the function it was asked about"
    );
}
