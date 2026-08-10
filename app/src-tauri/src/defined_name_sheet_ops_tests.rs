//! FILENAME: app/src-tauri/src/defined_name_sheet_ops_tests.rs
//! PURPOSE: Defined names must follow their sheet through a rename, a move and
//!          a delete -- both halves of what a name carries.
//!
//! CONTEXT: Measured 2026-08-10 (register section 3bb). `grep -n "named_ranges"
//! app/src-tauri/src/sheets.rs` returned NOTHING: no sheet operation touched the
//! name table at all. Two independent defects hid behind that.
//!
//!   1. `refers_to` is a formula STRING re-parsed at every evaluation, so
//!      `Sales = Sheet1!$A$1:$A$10` outlived its sheet verbatim. Combined with
//!      the evaluator's old unknown-sheet fallback (which resolved an unknown
//!      name to the formula's OWN sheet) `=SUM(Sales)` on another sheet quietly
//!      summed THAT sheet's A1:A10 -- 1000 where the answer was 55, with no
//!      error anywhere.
//!
//!   2. A sheet-scoped name carries its scope as an INDEX. Moving or deleting a
//!      sheet renumbered those indices under it, silently re-scoping every
//!      sheet-local name onto whichever sheet inherited the number.
//!
//! Both are pinned here against the helpers the commands call, because
//! `rename_sheet` / `delete_sheet` / `move_sheet` take a Tauri `State` and
//! cannot run in-process.

use crate::document_effect::test_seed_effect;
use crate::named_ranges::NamedRange;
use crate::AppState;

fn state_with_names(names: &[(&str, Option<usize>, &str)]) -> AppState {
    let state = crate::create_app_state();
    {
        let effect = test_seed_effect();
        let mut table = state.named_ranges.write(&effect).unwrap();
        for (name, sheet_index, refers_to) in names {
            table.insert(
                name.to_uppercase(),
                NamedRange {
                    name: name.to_string(),
                    sheet_index: *sheet_index,
                    refers_to: refers_to.to_string(),
                    comment: None,
                    folder: None,
                },
            );
        }
    }
    state
}

fn refers_to(state: &AppState, name: &str) -> String {
    state.named_ranges.read().unwrap()[&name.to_uppercase()]
        .refers_to
        .clone()
}

fn scope_of(state: &AppState, name: &str) -> Option<Option<usize>> {
    state
        .named_ranges
        .read()
        .unwrap()
        .get(&name.to_uppercase())
        .map(|nr| nr.sheet_index)
}

// ---------------------------------------------------------------------------
// refers_to follows a RENAME
// ---------------------------------------------------------------------------

#[test]
fn a_defined_name_follows_its_sheet_through_a_rename() {
    let state = state_with_names(&[
        ("Sales", None, "=Sheet1!$A$1:$A$10"),
        ("Rate", None, "=0.25"),
        ("Elsewhere", None, "=Sheet2!$B$1"),
    ]);
    let effect = test_seed_effect();

    crate::sheets::repair_named_ranges_for_test(&state, &effect, &|r| {
        Some(crate::repair_3d_refs_on_rename(r, "Sheet1", "Data"))
    });

    // The new name is substituted verbatim.
    assert_eq!(
        refers_to(&state, "Sales"),
        "=Data!$A$1:$A$10",
        "the name must point at the renamed sheet"
    );
    // A name that mentions no sheet, and one that mentions a DIFFERENT sheet,
    // must both come through UNTOUCHED -- character for character.
    //
    // These two assertions used to read `=SHEET2!$B$1` and called the shouting
    // "pre-existing". It was pre-existing and it was a defect: the repair
    // re-rendered every name whether or not it touched it, and the lexer
    // upper-cases every bare identifier, so renaming ANY sheet re-spelled every
    // defined name in the workbook (register section 3bd; it is section 2t on a
    // path section 2t's fix does not reach). `repair_3d_refs_on_rename` now
    // returns the caller's own text when the repair changed nothing.
    assert_eq!(refers_to(&state, "Rate"), "=0.25");
    assert_eq!(
        refers_to(&state, "Elsewhere"),
        "=Sheet2!$B$1",
        "renaming Sheet1 re-spelled a name that points at Sheet2"
    );
}

// ---------------------------------------------------------------------------
// refers_to reports #REF! after a DELETE
// ---------------------------------------------------------------------------

#[test]
fn a_defined_name_whose_sheet_is_deleted_reports_ref() {
    let state = state_with_names(&[
        ("Sales", None, "=Sheet1!$A$1:$A$10"),
        ("Survivor", None, "=Sheet3!$B$1"),
    ]);
    let effect = test_seed_effect();
    let after = vec!["Sheet2".to_string(), "Sheet3".to_string()];

    crate::sheets::repair_named_ranges_for_test(&state, &effect, &|r| {
        crate::repair_3d_refs_on_delete(r, "Sheet1", &after)
    });

    // NOT silently left pointing at a sheet that no longer exists -- which,
    // before the evaluator stopped falling back, read the local sheet instead.
    assert_eq!(refers_to(&state, "Sales"), "=#REF!");
    // ...and a name pointing at a sheet the delete did not touch keeps its own
    // spelling. See the rename test above for why this is no longer `SHEET3`.
    assert_eq!(
        refers_to(&state, "Survivor"),
        "=Sheet3!$B$1",
        "deleting Sheet1 re-spelled a name that points at Sheet3"
    );
}

// ---------------------------------------------------------------------------
// sheet_index follows a MOVE and a DELETE
// ---------------------------------------------------------------------------

#[test]
fn a_sheet_scoped_name_follows_its_sheet_through_a_move() {
    // Sheet-scoped to index 2. Move that sheet to the front and the name must
    // be scoped to 0 -- not left pointing at whatever now sits at index 2.
    let state = state_with_names(&[
        ("Local", Some(2), "=$A$1"),
        ("Global", None, "=$B$1"),
        ("Other", Some(0), "=$C$1"),
    ]);
    let effect = test_seed_effect();

    crate::sheets::remap_sheet_keyed_stores_for_test(&state, &effect, |i| {
        Some(match i {
            2 => 0,
            0 => 1,
            _ => 2,
        })
    });

    assert_eq!(scope_of(&state, "Local"), Some(Some(0)));
    assert_eq!(scope_of(&state, "Other"), Some(Some(1)));
    // A workbook-scoped name has no index and must not acquire one.
    assert_eq!(scope_of(&state, "Global"), Some(None));
}

#[test]
fn a_sheet_scoped_name_shifts_down_when_a_sheet_below_it_is_deleted() {
    let state = state_with_names(&[
        ("Above", Some(3), "=$A$1"),
        ("Below", Some(0), "=$B$1"),
        ("Global", None, "=$C$1"),
    ]);
    let effect = test_seed_effect();

    // Delete index 1: everything above shifts down by one.
    crate::sheets::remap_sheet_keyed_stores_for_test(&state, &effect, |i| {
        if i == 1 {
            None
        } else if i > 1 {
            Some(i - 1)
        } else {
            Some(i)
        }
    });

    assert_eq!(scope_of(&state, "Above"), Some(Some(2)));
    assert_eq!(scope_of(&state, "Below"), Some(Some(0)));
    assert_eq!(scope_of(&state, "Global"), Some(None));
}

#[test]
fn a_name_scoped_to_the_deleted_sheet_is_removed_with_it() {
    // Leaving it behind would re-scope it onto an unrelated sheet on the next
    // renumbering, which is the exact bug this whole file is about.
    let state = state_with_names(&[("Doomed", Some(1), "=$A$1"), ("Kept", Some(0), "=$B$1")]);
    let effect = test_seed_effect();

    crate::sheets::remap_sheet_keyed_stores_for_test(&state, &effect, |i| {
        if i == 1 {
            None
        } else if i > 1 {
            Some(i - 1)
        } else {
            Some(i)
        }
    });

    assert_eq!(scope_of(&state, "Doomed"), None, "the name must be gone");
    assert_eq!(scope_of(&state, "Kept"), Some(Some(0)));
}

// ---------------------------------------------------------------------------
// The end-to-end statement of why this matters
// ---------------------------------------------------------------------------

#[test]
fn a_name_pointing_at_a_deleted_sheet_no_longer_resolves_to_the_local_sheet() {
    // THE ORIGINAL SYMPTOM. `Sales = Sheet1!$A$1:$A$10`, `Sheet2!C1 =
    // SUM(Sales)`, then Sheet1 is deleted. The evaluator's unknown-sheet
    // fallback made that sum read SHEET2's own A1:A10 and report no error.
    // Two independent changes now stop it: the name is repaired to `#REF!`
    // here, and an unknown sheet is `#REF!` in the evaluator even if a stale
    // name ever slips through.
    let mut sheet2 = engine::Grid::new();
    for row in 0..10 {
        sheet2.set_cell(row, 0, engine::Cell::new_number(100.0));
    }
    let mut ctx = engine::evaluator::MultiSheetContext::new("Sheet2".to_string());
    ctx.add_grid("Sheet2".to_string(), &sheet2);
    ctx.sheet_order = vec!["Sheet2".to_string()];

    let evaluator = engine::evaluator::Evaluator::with_multi_sheet(&sheet2, ctx);
    let stale = parser::parse("=SUM(Sheet1!$A$1:$A$10)").expect("parses");
    assert_eq!(
        evaluator.evaluate(&stale),
        engine::EvalResult::Error(engine::CellError::Ref),
        "a stale reference to a deleted sheet must not read the local sheet"
    );
}
