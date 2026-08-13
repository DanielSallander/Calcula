//! FILENAME: app/src-tauri/src/undo_sheet_structure_tests.rs
//! PURPOSE: BUG-0005 — undo across a change to the workbook's SHEET STRUCTURE.
//! CONTEXT: A child module of `undo_commands` (declared with `#[path]` there),
//!          so it reaches `apply_changes` and the sibling fixture.
//!
//! THE ROOT, AND WHY IT IS THE THIRD TIME
//! --------------------------------------
//! `CellChange::SetCell` grew a `sheet` field precisely because an undo entry
//! that cannot say WHICH sheet it restores lands on whatever sheet is in front
//! of the user. That fixed the cell level. This file is the SAME missing
//! dimension one level up: the field it grew holds an INDEX, and an index is a
//! POSITION, not an identity. Add, delete, move or copy a sheet and every index
//! after the affected one is renumbered — so a queued entry silently comes to
//! describe a different sheet than the one it was recorded on, and undo writes
//! a value onto a sheet the user never edited. Silently, with nothing on screen
//! to see.
//!
//! Two of the four hazards are not about indices at all, which is why "remap
//! the indices when they shift" was never a complete answer and why the partial
//! remap that DID exist (`visit_custom_restores`, over `CustomRestore` payloads
//! only) left the ordinary cell edits beside them mis-aimed:
//!
//!   * a RENAME shifts no index, but rewrites every formula in the workbook.
//!     The `previous` cells still queued in the stack hold ASTs spelling the OLD
//!     sheet name;
//!   * width / height / merge / snapshot changes carry no sheet dimension AT
//!     ALL — they are implicitly "the active sheet" — so nothing can aim them.
//!
//! WHAT EXCEL DOES, WHICH SETTLES IT
//! ---------------------------------
//! Excel does not let a sheet structural operation be undone, and ending the
//! undo history is how it avoids this entire family. Deleting a worksheet is
//! the documented case — Excel warns that deleting sheets cannot be undone and
//! the Undo command goes unavailable — and no undo entry exists for inserting,
//! renaming, moving or copying one either. Under the project's standing "Excel
//! parity wins any design question" rule that is Calcula's behaviour too.
//!
//! It also answers, WITHOUT INVENTING ANYTHING, the question of what an undo
//! should do when its target sheet has since been DELETED: the question cannot
//! arise, because the delete ended the history that could have asked it.
//!
//! HOW THESE TESTS ARE BUILT
//! -------------------------
//! The five structural commands are `#[tauri::command]`s taking `State<_>`,
//! which has no public constructor, so they cannot be called from a unit test.
//! Each behavioural test therefore does two things the commands do, in the
//! command's order, against a real `AppState`: it performs the SAME index
//! arithmetic on the sheet vectors, and it calls (or, for the teeth tests,
//! deliberately does NOT call) the invalidator the command calls. The source
//! census at the bottom is what ties those two halves back to the real
//! commands — it fails the build if one of the five stops calling it.

use super::*;
use crate::sheets::invalidate_undo_history_for_sheet_structure;
use engine::Cell;

use super::undo_sheet_domain_tests::Fixture;

// ---------------------------------------------------------------------------
// The index arithmetic each structural command performs, in one place.
//
// Only the stores these assertions read are moved (`grids`, `sheet_names`,
// `sheet_ids`). The point of every test below is what the UNDO STACK does when
// the numbering changes underneath it, and the numbering is the same numbering
// whether or not `all_row_heights` came along for the ride.
// ---------------------------------------------------------------------------

fn loading() -> crate::document_effect::DocumentEffect {
    crate::document_effect::DocumentEffect::deliberately_clean(
        crate::document_effect::CleanReason::LoadingFromDisk,
    )
}

/// Insert a fresh empty sheet at `at`, pushing every sheet from `at` upwards.
/// This is what `copy_sheet` does (it inserts right after its source), and what
/// Excel's Insert Sheet does (it inserts BEFORE the active sheet).
fn insert_sheet_at(state: &AppState, at: usize, name: &str) {
    let e = loading();
    state.grids.write(&e).unwrap().insert(at, engine::Grid::new());
    state
        .sheet_names
        .write(&crate::document_effect::test_seed_effect())
        .unwrap()
        .insert(at, name.to_string());
    state
        .sheet_ids
        .write(&crate::document_effect::test_seed_effect())
        .unwrap()
        .insert(at, identity::SheetId::from_bytes(identity::generate_uuid_v7()));
}

/// Remove the sheet at `at`, pulling every sheet above it down by one.
fn delete_sheet_at(state: &AppState, at: usize) {
    let e = loading();
    state.grids.write(&e).unwrap().remove(at);
    state
        .sheet_names
        .write(&crate::document_effect::test_seed_effect())
        .unwrap()
        .remove(at);
    state
        .sheet_ids
        .write(&crate::document_effect::test_seed_effect())
        .unwrap()
        .remove(at);
}

/// Rotate the sheet at `from` to `to`, the way `move_sheet` does.
fn move_sheet_from_to(state: &AppState, from: usize, to: usize) {
    fn rotate<T>(v: &mut Vec<T>, from: usize, to: usize) {
        if from < to {
            v[from..=to].rotate_left(1);
        } else {
            v[to..=from].rotate_right(1);
        }
    }
    let e = loading();
    rotate(&mut state.grids.write(&e).unwrap(), from, to);
    rotate(
        &mut state
            .sheet_names
            .write(&crate::document_effect::test_seed_effect())
            .unwrap(),
        from,
        to,
    );
    rotate(
        &mut state
            .sheet_ids
            .write(&crate::document_effect::test_seed_effect())
            .unwrap(),
        from,
        to,
    );
}

/// Queue "restore `value` into (sheet, row, col)" — one committed transaction,
/// exactly as an ordinary cell edit leaves behind.
fn queue_restore(f: &Fixture, sheet: usize, row: u32, col: u32, value: f64) {
    f.state
        .undo_stack
        .lock()
        .unwrap()
        .record_cell_change(sheet, row, col, Some(Cell::new_number(value)));
}

fn cell_number(f: &Fixture, sheet: usize, row: u32, col: u32) -> Option<f64> {
    match f.state.grids.read().unwrap()[sheet]
        .get_cell(row, col)
        .map(|c| c.value.clone())
    {
        Some(engine::CellValue::Number(n)) => Some(n),
        _ => None,
    }
}

fn can_undo(f: &Fixture) -> bool {
    f.state.undo_stack.lock().unwrap().can_undo()
}

// ---------------------------------------------------------------------------
// ADD / INSERT
// ---------------------------------------------------------------------------

#[test]
fn teeth_an_entry_that_outlives_a_sheet_insert_restores_onto_the_wrong_sheet() {
    // THE HAZARD, DEMONSTRATED. This test deliberately does NOT invalidate, so
    // it shows what the product did before BUG-0005 was fixed and what it would
    // do again if a sixth structural command forgot the call. A census whose
    // failure mode has never been seen is a comment.
    //
    // Sheet2!A1 was 7 and was edited to 42. A sheet is then inserted at index 1
    // — BEFORE the edited one, which is where Excel's Insert Sheet puts it — so
    // the edited sheet is now index 2 while the undo entry still says 1.
    let f = Fixture::new(2);
    f.put(1, 0, 0, Cell::new_number(7.0));
    queue_restore(&f, 1, 0, 0, 7.0);
    f.put(1, 0, 0, Cell::new_number(42.0));

    insert_sheet_at(&f.state, 1, "Inserted");

    f.undo();

    assert_eq!(
        cell_number(&f, 1, 0, 0),
        Some(7.0),
        "the brand-new sheet, which the user has never typed into, was given a \
         value by an undo that belonged to a different sheet"
    );
    assert_eq!(
        cell_number(&f, 2, 0, 0),
        Some(42.0),
        "and the edit the user actually asked to undo is still there — the undo \
         was worse than inert, it corrupted a bystander"
    );
}

#[test]
fn adding_a_sheet_ends_the_history_so_nothing_can_land_on_the_wrong_sheet() {
    // The same setup with the invalidator the command calls. Excel's answer:
    // there is nothing to undo across a sheet insert.
    let f = Fixture::new(2);
    f.put(1, 0, 0, Cell::new_number(7.0));
    queue_restore(&f, 1, 0, 0, 7.0);
    f.put(1, 0, 0, Cell::new_number(42.0));
    assert!(can_undo(&f), "precondition: something was undoable");

    invalidate_undo_history_for_sheet_structure(&f.state, "add a sheet");
    insert_sheet_at(&f.state, 1, "Inserted");

    assert!(!can_undo(&f), "Excel offers no undo across a sheet insert");
    assert_eq!(f.undo_depth(), 0);
    assert_eq!(
        cell_number(&f, 1, 0, 0),
        None,
        "the inserted sheet stayed empty"
    );
    assert_eq!(
        cell_number(&f, 2, 0, 0),
        Some(42.0),
        "and the edited sheet was left exactly as the user left it"
    );
}

// ---------------------------------------------------------------------------
// DELETE
// ---------------------------------------------------------------------------

#[test]
fn teeth_an_entry_that_outlives_a_sheet_delete_restores_onto_the_wrong_sheet() {
    // Four sheets; the edit is on index 2. Deleting index 0 pulls everything
    // down: the edited sheet becomes 1 and the UNRELATED fourth sheet becomes
    // 2 — the number the queued entry still names.
    let f = Fixture::new(4);
    f.put(2, 0, 0, Cell::new_number(7.0));
    f.put(3, 0, 0, Cell::new_number(500.0));
    queue_restore(&f, 2, 0, 0, 7.0);
    f.put(2, 0, 0, Cell::new_number(42.0));

    delete_sheet_at(&f.state, 0);

    f.undo();

    assert_eq!(
        cell_number(&f, 2, 0, 0),
        Some(7.0),
        "the sheet that INHERITED index 2 had its A1 overwritten (it held 500)"
    );
    assert_eq!(
        cell_number(&f, 1, 0, 0),
        Some(42.0),
        "and the edited sheet, now at index 1, kept the edit"
    );
}

#[test]
fn deleting_a_sheet_ends_the_history_which_is_also_excels_answer_for_the_deleted_target() {
    // THE TARGET-SHEET-DELETED CASE, and Excel's own answer to it rather than
    // an invented one. The undo entry here belongs to the sheet being deleted,
    // so "apply it to its own sheet" has no meaning. Excel never has to decide:
    // deleting a worksheet ends the history, which is why it warns that the
    // delete cannot be undone.
    let f = Fixture::new(3);
    f.put(1, 0, 0, Cell::new_number(7.0));
    queue_restore(&f, 1, 0, 0, 7.0);
    f.put(1, 0, 0, Cell::new_number(42.0));
    assert!(can_undo(&f), "precondition");

    invalidate_undo_history_for_sheet_structure(&f.state, "delete a sheet");
    delete_sheet_at(&f.state, 1);

    assert!(
        !can_undo(&f),
        "the entry named a sheet that no longer exists; Excel's answer is that \
         the history ended with the delete"
    );
    assert_eq!(f.state.sheet_names.read().unwrap().len(), 2);
}

// ---------------------------------------------------------------------------
// MOVE / REORDER
// ---------------------------------------------------------------------------

#[test]
fn teeth_an_entry_that_outlives_a_sheet_move_restores_onto_the_wrong_sheet() {
    // Dragging the first tab to the end renumbers every sheet it passes.
    let f = Fixture::new(3);
    f.put(0, 0, 0, Cell::new_number(7.0));
    f.put(1, 0, 0, Cell::new_number(500.0));
    queue_restore(&f, 0, 0, 0, 7.0);
    f.put(0, 0, 0, Cell::new_number(42.0));

    move_sheet_from_to(&f.state, 0, 2);

    f.undo();

    assert_eq!(
        cell_number(&f, 0, 0, 0),
        Some(7.0),
        "the sheet that slid down into index 0 was overwritten (it held 500)"
    );
    assert_eq!(
        cell_number(&f, 2, 0, 0),
        Some(42.0),
        "and the moved sheet kept the edit that was supposedly undone"
    );
}

#[test]
fn moving_a_sheet_ends_the_history() {
    let f = Fixture::new(3);
    f.put(0, 0, 0, Cell::new_number(7.0));
    queue_restore(&f, 0, 0, 0, 7.0);
    f.put(0, 0, 0, Cell::new_number(42.0));

    invalidate_undo_history_for_sheet_structure(&f.state, "move a sheet");
    move_sheet_from_to(&f.state, 0, 2);

    assert!(!can_undo(&f));
    assert_eq!(
        cell_number(&f, 2, 0, 0),
        Some(42.0),
        "the moved sheet is untouched"
    );
    assert_eq!(cell_number(&f, 0, 0, 0), None, "and so is its new neighbour");
}

// ---------------------------------------------------------------------------
// RENAME — no index moves, and it is still unsafe
// ---------------------------------------------------------------------------

#[test]
fn teeth_an_entry_that_outlives_a_sheet_rename_restores_a_reference_to_the_old_name() {
    // The hazard a remap could never have fixed. A rename shifts NO index; it
    // rewrites every formula in the workbook instead. The `previous` cell in
    // the undo stack was captured before that rewrite, so it still spells the
    // old name — and undo puts it back, re-introducing a reference to a sheet
    // that no longer answers to it.
    let f = Fixture::new(2);
    let original = Cell::new_formula("=Sheet2!A1*2".to_string());
    f.put(0, 0, 0, original.clone());
    f.state
        .undo_stack
        .lock()
        .unwrap()
        .record_cell_change(0, 0, 0, Some(original));
    f.put(0, 0, 0, Cell::new_number(1.0));

    // The rename, as far as the sheet list is concerned. The live grids would
    // have been repaired by `repair_all_formulas`; the queued entry never is.
    f.state
        .sheet_names
        .write(&crate::document_effect::test_seed_effect())
        .unwrap()[1] = "Facts".to_string();

    f.undo();

    let restored = f.state.grids.read().unwrap()[0]
        .get_cell(0, 0)
        .and_then(|c| c.formula_string())
        .expect("a formula came back");
    // Case-insensitive: the lexer upper-cases bare identifiers, so the stored
    // form is `SHEET2!A1*2`. That is the same uppercasing that made a bare
    // cross-sheet reference register under the wrong key in BUG-0019, and it is
    // why sheet lookup is case-insensitive everywhere — a case-SENSITIVE probe
    // here would report "no stale reference" about a stale reference.
    assert!(
        restored.to_ascii_uppercase().contains("SHEET2"),
        "the restored formula still names the pre-rename sheet: {restored}"
    );
    assert!(
        !f.state
            .sheet_names
            .read()
            .unwrap()
            .iter()
            .any(|n| n == "Sheet2"),
        "...and no sheet is called that any more, so the reference is dangling"
    );
}

#[test]
fn renaming_a_sheet_ends_the_history() {
    let f = Fixture::new(2);
    let original = Cell::new_formula("=Sheet2!A1*2".to_string());
    f.put(0, 0, 0, original.clone());
    f.state
        .undo_stack
        .lock()
        .unwrap()
        .record_cell_change(0, 0, 0, Some(original));
    f.put(0, 0, 0, Cell::new_number(1.0));

    invalidate_undo_history_for_sheet_structure(&f.state, "rename a sheet");

    assert!(
        !can_undo(&f),
        "Excel offers no undo for a sheet rename, and the stale ASTs are why it \
         must not be improvised here"
    );
}

// ---------------------------------------------------------------------------
// COPY / DUPLICATE
// ---------------------------------------------------------------------------

#[test]
fn copying_a_sheet_ends_the_history() {
    // A copy is an INSERT right after its source, so it renumbers exactly like
    // one — and the duplicate starts life holding the source's cells, which
    // makes a mis-aimed restore land on data that looks plausible.
    let f = Fixture::new(2);
    f.put(1, 0, 0, Cell::new_number(7.0));
    queue_restore(&f, 1, 0, 0, 7.0);
    f.put(1, 0, 0, Cell::new_number(42.0));

    invalidate_undo_history_for_sheet_structure(&f.state, "copy a sheet");
    insert_sheet_at(&f.state, 1, "Sheet2 (2)");

    assert!(!can_undo(&f));
    assert_eq!(cell_number(&f, 2, 0, 0), Some(42.0));
}

// ---------------------------------------------------------------------------
// REDO IS SYMMETRIC — and it is a separate stack, so it is separately asserted
// ---------------------------------------------------------------------------

#[test]
fn the_redo_stack_ends_with_the_undo_stack() {
    // A redo entry is an undo entry facing the other way: it names its sheet by
    // the same index and is renumbered by the same operation. Leaving the redo
    // stack alive across a structural change would put the corruption back on
    // the OTHER key.
    let f = Fixture::new(2);
    f.put(1, 0, 0, Cell::new_number(7.0));
    queue_restore(&f, 1, 0, 0, 7.0);
    f.put(1, 0, 0, Cell::new_number(42.0));
    f.undo();
    assert_eq!(cell_number(&f, 1, 0, 0), Some(7.0), "precondition: undone");
    assert!(
        f.state.undo_stack.lock().unwrap().can_redo(),
        "precondition: a redo is queued"
    );

    invalidate_undo_history_for_sheet_structure(&f.state, "add a sheet");
    insert_sheet_at(&f.state, 1, "Inserted");

    assert!(
        !f.state.undo_stack.lock().unwrap().can_redo(),
        "the redo entry still named sheet index 1, which is now the new sheet"
    );
}

#[test]
fn an_open_transaction_ends_with_the_history_too() {
    // The narrowest hole: a structural command running while some other command
    // has a transaction OPEN but not committed. Leaving it open would let it be
    // committed afterwards, carrying pre-renumbering indices onto a stack that
    // was supposed to have ended.
    let f = Fixture::new(2);
    {
        let mut stack = f.state.undo_stack.lock().unwrap();
        stack.begin_transaction("half-finished".to_string());
        stack.record_cell_change(1, 0, 0, Some(Cell::new_number(7.0)));
    }

    invalidate_undo_history_for_sheet_structure(&f.state, "add a sheet");

    {
        let mut stack = f.state.undo_stack.lock().unwrap();
        assert!(!stack.has_open_transaction());
        stack.commit_transaction(); // no-op; must not resurrect anything
    }
    assert!(!can_undo(&f));
}

// ---------------------------------------------------------------------------
// THE EVIDENCE THE OUTSIDE READS
// ---------------------------------------------------------------------------

#[test]
fn the_invalidator_leaves_a_counted_trace_and_is_quiet_when_there_is_nothing_to_lose() {
    // The undo-round-trip oracle finds a remembered transaction id missing and
    // has to say WHY. Three causes, one remedy each: the cap dropped it
    // (`evicted_total`), a structural change ended the history
    // (`cleared_total`), or the walk undid past it (neither moved). Only the
    // third is ever a product defect, and reporting the second AS the third is
    // what BUG-0005's soak bundle actually did.
    let f = Fixture::new(2);
    assert_eq!(f.state.undo_stack.lock().unwrap().cleared_total(), 0);

    // Nothing queued: a structural change on a pristine workbook must not look
    // like history was lost, or every fresh document reports a phantom clear.
    invalidate_undo_history_for_sheet_structure(&f.state, "add a sheet");
    assert_eq!(f.state.undo_stack.lock().unwrap().cleared_total(), 0);

    queue_restore(&f, 0, 0, 0, 1.0);
    queue_restore(&f, 0, 1, 0, 2.0);
    invalidate_undo_history_for_sheet_structure(&f.state, "delete a sheet");

    let stack = f.state.undo_stack.lock().unwrap();
    assert_eq!(stack.cleared_total(), 2, "both transactions counted");
    assert_eq!(
        stack.evicted_total(),
        0,
        "and the cap counter did NOT move — the two causes must stay tellable apart"
    );
}

// ---------------------------------------------------------------------------
// THE CENSUS: every structural sheet command ends the history
//
// This is what ties the behavioural tests above — which reproduce the commands'
// index arithmetic rather than calling them — back to the real commands. A
// sixth structural command, or a fix to one of the five that drops the call,
// fails here BY NAME.
// ---------------------------------------------------------------------------

const SHEETS_RS: &str = include_str!("sheets.rs");

/// The five commands that change the workbook's sheet STRUCTURE: the sheet
/// list's length or order changes, or a sheet's name does. `set_active_sheet`,
/// `hide_sheet` and `set_tab_color` are deliberately absent — none of them
/// renumbers a sheet or rewrites a formula, so none of them invalidates an
/// undo entry, and Excel keeps its history across all three.
const STRUCTURAL_SHEET_COMMANDS: [&str; 5] = [
    "add_sheet",
    "delete_sheet",
    "rename_sheet",
    "move_sheet",
    "copy_sheet",
];

const INVALIDATOR: &str = "invalidate_undo_history_for_sheet_structure(";

#[test]
fn sheet_structure_commands_invalidate_the_undo_history() {
    let bodies = crate::formula_serialisation_tests::free_function_bodies(SHEETS_RS);

    let mut offenders: Vec<&str> = Vec::new();
    for command in STRUCTURAL_SHEET_COMMANDS {
        let body = bodies
            .iter()
            .find(|(name, _)| name == command)
            .map(|(_, body)| body.as_str())
            .unwrap_or_else(|| {
                panic!("`{command}` is not a free function in sheets.rs any more")
            });
        // ONE level of delegation, same allowance as the object-deps census: a
        // command split into a testable `_inner` / `_impl` body (the
        // `hide_sheet_inner` pattern — `add_sheet` and `delete_sheet` took it
        // for the floating-range work) carries its contract with it, provided
        // the command actually calls that delegate and the delegate makes the
        // call.
        let delegated = ["_inner", "_impl"].iter().any(|suffix| {
            let delegate = format!("{command}{suffix}");
            body.contains(&format!("{delegate}("))
                && bodies
                    .iter()
                    .find(|(name, _)| name == &delegate)
                    .is_some_and(|(_, inner)| inner.contains(INVALIDATOR))
        });
        if !body.contains(INVALIDATOR) && !delegated {
            offenders.push(command);
        }
    }

    assert!(
        offenders.is_empty(),
        "these commands change the workbook's sheet structure without ending the \
         undo history:\n  {}\n\nEvery queued undo entry names its sheet by INDEX, \
         and these commands renumber those indices (or, for rename, invalidate the \
         formula ASTs the entries carry). Call \
         `invalidate_undo_history_for_sheet_structure(&state, \"...\")` after the \
         last gate that can refuse and with no other state lock held.",
        offenders.join("\n  ")
    );
}

#[test]
fn the_structural_census_can_see_a_command_that_forgets() {
    // TEETH for the census. A census nobody has watched fail is a comment.
    const SABOTAGED: &str = r#"
pub fn add_sheet(state: State<AppState>) -> Result<SheetsResult, String> {
    sheet_names.push(new_name);
    crate::undo_commands::rebuild_all_dependencies(&state);
}

pub fn delete_sheet(state: State<AppState>) -> Result<SheetsResult, String> {
    invalidate_undo_history_for_sheet_structure(&state, "delete a sheet");
    crate::undo_commands::rebuild_all_dependencies(&state);
}
"#;
    let flagged: Vec<String> = crate::formula_serialisation_tests::free_function_bodies(SABOTAGED)
        .into_iter()
        .filter(|(name, _)| STRUCTURAL_SHEET_COMMANDS.contains(&name.as_str()))
        .filter(|(_, body)| !body.contains(INVALIDATOR))
        .map(|(name, _)| name)
        .collect();
    assert_eq!(
        flagged,
        vec!["add_sheet".to_string()],
        "the census cannot distinguish a command that ends the history from one \
         that does not, so it would pass on the defect it exists to catch"
    );
}

#[test]
fn the_two_commands_that_hold_their_guards_release_them_before_ending_the_history() {
    // LOCK ORDER, and it is not decorative. The crate's canonical order takes
    // `undo_stack` BEFORE `grid`/`grids` (`undo_commands::apply_changes`), and
    // the recalculation pass holds the grid pair on a BACKGROUND thread — so a
    // sheet command that clears the history while still holding a grid guard
    // closes exactly the cycle `state_digest_lock_order_tests` exists for, and
    // the symptom is a silent, unlogged hang rather than a panic.
    //
    // `move_sheet` and `copy_sheet` are the two whose guards are function-level
    // bindings that live to the end, so each releases them explicitly first.
    // The other three already end inside a block that drops everything.
    let bodies = crate::formula_serialisation_tests::free_function_bodies(SHEETS_RS);
    for command in ["move_sheet", "copy_sheet"] {
        let (_, body) = bodies
            .iter()
            .find(|(name, _)| name == command)
            .unwrap_or_else(|| panic!("`{command}` is not a free function in sheets.rs"));
        let release = body
            .find("drop((")
            .unwrap_or_else(|| panic!("`{command}` no longer releases its guards explicitly"));
        let clear = body
            .find(INVALIDATOR)
            .unwrap_or_else(|| panic!("`{command}` no longer ends the undo history"));
        assert!(
            release < clear,
            "`{command}` ends the undo history while its grid guards are still \
             alive — that is the lock-order inversion that hangs the app"
        );
    }
}

#[test]
fn the_undo_stack_is_no_longer_re_aimed_when_sheet_indices_shift() {
    // The mechanism this replaced. `remap_sheet_keyed_stores` used to rewrite
    // the sheet index inside every queued `CustomRestore` payload, on the
    // premise that undo history survives a sheet operation and merely needs
    // re-aiming. That premise is now the opposite of the product's, and the two
    // cannot coexist: re-aiming says "this entry is still valid, elsewhere",
    // ending the history says "this entry is gone". Leaving the re-aim in place
    // would be a second mechanism asserting an invariant that no longer holds —
    // and it only ever covered `CustomRestore`, never the `SetCell` indices in
    // the same transactions, which is the half that was mis-aiming.
    assert!(
        !SHEETS_RS.contains("visit_custom_restores"),
        "sheets.rs re-aims queued undo entries again; that is a second answer to \
         BUG-0005 and it contradicts ending the history"
    );
}
