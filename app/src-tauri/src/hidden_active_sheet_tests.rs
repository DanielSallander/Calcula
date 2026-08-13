//! FILENAME: app/src-tauri/src/hidden_active_sheet_tests.rs
//! PURPOSE: BUG-0046 — a hidden sheet must not be the active sheet, and hiding
//!          the active one must PERFORM the switch rather than recommend it.
//!
//! # What was wrong
//!
//! `hide_sheet` set the visibility flag, worked out which visible sheet should
//! take over, and returned that index in `SheetsResult.active_index` — WITHOUT
//! touching `state.active_sheet` or any of the per-sheet mirrors. Its own doc
//! comment said so: "Returns the recommended new active_index (frontend should
//! call set_active_sheet if it changed)".
//!
//! Not one of the three callers did.
//!
//!   * `SheetTabs.handleHide` -> `applySheetsResult(result, { backendHandledSwitch: true })`,
//!     whose own comment reads "Backend already swapped - just sync frontend state".
//!   * `ScriptNotebook/lib/deferredActionHost.setSheetVisibility` -> "Hiding the
//!     active sheet makes the backend switch; SheetTabs reloads the tab strip".
//!   * the broker's `api.setSheetVisibility` -> `announceSheetsChanged`, which
//!     dispatches `setActiveSheet` into the frontend store and emits SHEET_CHANGED.
//!
//! So all three moved the FRONTEND onto the recommended sheet while the backend
//! still had the HIDDEN sheet active. Every cell read and every cell write goes
//! to the active sheet, so the tab strip highlighted Sheet2, the canvas painted
//! Sheet1's data, and typing wrote into the sheet the user had just hidden.
//!
//! Excel's rule is the one-liner that settles it: a hidden sheet cannot be the
//! active sheet (there is no tab to select, and `Activate` raises in VBA). The
//! switch therefore belongs in the command every route passes through, and it
//! goes through `activate_sheet` — the ONE implementation that moves the grid
//! mirror, the widths, the heights, the merges and the user-hidden sets
//! together.
//!
//! # Why the existing coverage could not see it
//!
//! `TestRunner`'s "Hide and unhide a sheet" hides a sheet it has just ADDED —
//! and `add_sheet` makes the new sheet active, so that suite hides the ACTIVE
//! sheet every time it runs. It then asserts only that `visibility == "hidden"`.
//! The defect was underneath a passing test the whole time. Every assertion
//! below is about the ACTIVE SHEET, which is the half nothing was checking.

use std::collections::{HashMap, HashSet};

use crate::persistence::FileState;
use crate::AppState;

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

/// Put a number in A1 of `sheet` (and the mirror, when it is active).
fn put_a1(state: &AppState, sheet: usize, value: f64) {
    let seed = crate::document_effect::test_seed_effect;
    let active = *state.active_sheet.read().unwrap();
    state.grids.write(&seed()).unwrap()[sheet].set_cell(0, 0, engine::Cell::new_number(value));
    if sheet == active {
        state
            .grid
            .write(&seed())
            .unwrap()
            .set_cell(0, 0, engine::Cell::new_number(value));
    }
}

fn a1_of_mirror(state: &AppState) -> Option<f64> {
    match state
        .grid
        .read()
        .unwrap()
        .get_cell(0, 0)
        .map(|c| c.value.clone())
    {
        Some(engine::CellValue::Number(n)) => Some(n),
        _ => None,
    }
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

// ---------------------------------------------------------------------------
// The invariant
// ---------------------------------------------------------------------------

#[test]
fn hiding_the_active_sheet_activates_a_visible_one() {
    let state = workbook_with_sheets(2);
    let file = FileState::default();
    crate::sheets::activate_sheet(&state, 1).expect("switch to Sheet2");
    assert_eq!(*state.active_sheet.read().unwrap(), 1, "precondition");

    let result = crate::sheets::hide_sheet_inner(&state, &file, 1, None).expect("hide Sheet2");

    assert_eq!(
        *state.active_sheet.read().unwrap(),
        0,
        "the BACKEND still has the hidden sheet active — every cell read and \
         every cell write goes there while the tab strip shows another sheet"
    );
    assert_eq!(
        result.active_index, 0,
        "the result must report the sheet the backend actually activated"
    );
    assert_eq!(visibility(&state, 1), "hidden", "the sheet was hidden");
}

#[test]
fn the_grid_mirror_moves_with_it() {
    // The half a flag-only fix would miss: `active_sheet` is a number, and the
    // data the user sees comes from `state.grid`. If the index moves and the
    // mirror does not, the canvas paints the hidden sheet under the visible
    // sheet's tab — which is the defect, one layer down.
    let state = workbook_with_sheets(2);
    let file = FileState::default();
    put_a1(&state, 0, 11.0);
    crate::sheets::activate_sheet(&state, 1).expect("switch to Sheet2");
    put_a1(&state, 1, 22.0);
    assert_eq!(a1_of_mirror(&state), Some(22.0), "precondition: Sheet2 is showing");

    crate::sheets::hide_sheet_inner(&state, &file, 1, None).expect("hide Sheet2");

    assert_eq!(
        a1_of_mirror(&state),
        Some(11.0),
        "the mirror still holds the HIDDEN sheet's data, so the grid paints \
         Sheet2 while the tab strip says Sheet1"
    );
}

#[test]
fn hiding_a_sheet_that_is_not_active_moves_nothing() {
    // Non-vacuity for the two tests above: the switch must be conditional, or
    // hiding any sheet would drag the user off the one they are working on.
    let state = workbook_with_sheets(3);
    let file = FileState::default();
    crate::sheets::activate_sheet(&state, 1).expect("switch to Sheet2");
    put_a1(&state, 1, 22.0);

    let result = crate::sheets::hide_sheet_inner(&state, &file, 2, None).expect("hide Sheet3");

    assert_eq!(*state.active_sheet.read().unwrap(), 1, "the user stays put");
    assert_eq!(result.active_index, 1);
    assert_eq!(a1_of_mirror(&state), Some(22.0), "and so does the data");
}

#[test]
fn the_sheet_it_lands_on_is_visible() {
    // The nearest visible sheet, not the nearest sheet. With Sheet1 already
    // hidden, hiding Sheet2 must land on Sheet3 — landing on Sheet1 would make
    // a hidden sheet active by another route.
    let state = workbook_with_sheets(3);
    let file = FileState::default();
    crate::sheets::hide_sheet_inner(&state, &file, 0, None).expect("hide Sheet1");
    crate::sheets::activate_sheet(&state, 1).expect("switch to Sheet2");

    let result = crate::sheets::hide_sheet_inner(&state, &file, 1, None).expect("hide Sheet2");

    let landed = *state.active_sheet.read().unwrap();
    assert_eq!(landed, 2, "Sheet1 is hidden; the only other visible sheet is Sheet3");
    assert_eq!(result.active_index, landed);
    assert_eq!(
        visibility(&state, landed),
        "visible",
        "the active sheet must always be a visible one"
    );
}

#[test]
fn hiding_the_last_visible_sheet_is_refused_and_changes_nothing() {
    let state = workbook_with_sheets(2);
    let file = FileState::default();
    crate::sheets::hide_sheet_inner(&state, &file, 1, None).expect("hide Sheet2");
    assert_eq!(*state.active_sheet.read().unwrap(), 0, "precondition");

    let refused = crate::sheets::hide_sheet_inner(&state, &file, 0, None);

    assert!(refused.is_err(), "a workbook must keep one visible sheet");
    assert_eq!(visibility(&state, 0), "visible", "the refusal changed nothing");
    assert_eq!(*state.active_sheet.read().unwrap(), 0);
}

#[test]
fn very_hidden_behaves_the_same_way() {
    // `veryHidden` is a different level, not a different rule: it is still not
    // a sheet the user can be looking at.
    let state = workbook_with_sheets(2);
    let file = FileState::default();
    crate::sheets::activate_sheet(&state, 1).expect("switch to Sheet2");

    crate::sheets::hide_sheet_inner(&state, &file, 1, Some("veryHidden".to_string()))
        .expect("hide Sheet2 very hidden");

    assert_eq!(*state.active_sheet.read().unwrap(), 0);
    assert_eq!(visibility(&state, 1), "veryHidden");
}

#[test]
fn an_invalid_level_is_refused_before_anything_moves() {
    let state = workbook_with_sheets(2);
    let file = FileState::default();
    crate::sheets::activate_sheet(&state, 1).expect("switch to Sheet2");

    let refused = crate::sheets::hide_sheet_inner(&state, &file, 1, Some("sort-of".to_string()));

    assert!(refused.is_err());
    assert_eq!(visibility(&state, 1), "visible", "nothing was hidden");
    assert_eq!(
        *state.active_sheet.read().unwrap(),
        1,
        "and nothing was activated"
    );
}

// ---------------------------------------------------------------------------
// The source census: the switch must go through the ONE swap
// ---------------------------------------------------------------------------

#[test]
fn hide_sheet_performs_the_switch_through_activate_sheet() {
    // A hand-rolled `*active_sheet = target` would satisfy every assertion
    // above and leave the widths, heights, merges and user-hidden sets on the
    // old sheet — which is the precise failure `activate_sheet` was extracted
    // to prevent (BUG-0043). The assertions cannot tell the two apart for the
    // stores they do not read, so the source is read instead.
    let src = include_str!("sheets.rs");
    let body = {
        let at = src
            .find("pub(crate) fn hide_sheet_inner(")
            .expect("hide_sheet_inner was renamed — re-derive this census");
        let open = src[at..].find('{').expect("no body") + at;
        let bytes = src.as_bytes();
        let mut depth = 0usize;
        let mut end = src.len();
        for i in open..src.len() {
            match bytes[i] {
                b'{' => depth += 1,
                b'}' => {
                    depth -= 1;
                    if depth == 0 {
                        end = i + 1;
                        break;
                    }
                }
                _ => {}
            }
        }
        &src[open..end]
    };

    assert!(
        body.contains("activate_sheet("),
        "`hide_sheet_inner` no longer calls `activate_sheet`. Hiding the active \
         sheet must go through the one implementation of the swap, or the grid \
         mirror, the column widths, the row heights, the merged regions and the \
         user-hidden sets stay on the sheet that was just hidden."
    );
    assert!(
        !body.contains("*active_sheet ="),
        "`hide_sheet_inner` assigns `active_sheet` directly. That is a SECOND \
         implementation of the swap and it moves the index without the mirrors."
    );
}

#[test]
fn padding_the_visibility_vector_produces_visible_sheets() {
    // `String::default()` is `""`, and every reader of `sheet_visibility`
    // compares against the literal "visible" — so padding with the default
    // makes a sheet that has no tab, cannot be navigated to, and does not count
    // towards "at least one visible sheet must remain". Measured: a three-sheet
    // workbook whose vector had not been grown refused `hide_sheet(0)` with
    // "Cannot hide the last visible sheet".
    let state = workbook_with_sheets(3);
    let file = FileState::default();

    // Nothing has grown the vector yet; the command pads it.
    crate::sheets::hide_sheet_inner(&state, &file, 0, None).expect("hide Sheet1");

    let vis = state.sheet_visibility.read().unwrap().clone();
    assert_eq!(vis.len(), 3, "the vector was padded to the sheet count");
    assert_eq!(vis[0], "hidden");
    assert_eq!(vis[1], "visible", "a padded slot must be VISIBLE, not an empty string");
    assert_eq!(vis[2], "visible");
}

// ---------------------------------------------------------------------------
// The delete side of the same rule
// ---------------------------------------------------------------------------
//
// `delete_sheet` cannot be driven from a unit test (eight `State<T>` arguments),
// so the two decisions it now makes are pure functions with their own tier, and
// a source census ties them back to the command.

fn vis(list: &[&str]) -> Vec<String> {
    list.iter().map(|s| s.to_string()).collect()
}

#[test]
fn a_delete_that_would_leave_no_visible_sheet_is_counted_as_zero() {
    // Hide Sheet1, delete Sheet2: two sheets left over, one of them, hidden.
    let v = vis(&["hidden", "visible"]);
    assert_eq!(
        crate::sheets::visible_sheets_after_removing(&v, 2, 1),
        0,
        "deleting the only visible sheet must be refusable"
    );
    // ...and the mirror image is fine.
    assert_eq!(crate::sheets::visible_sheets_after_removing(&v, 2, 0), 1);
}

#[test]
fn a_short_visibility_vector_counts_as_visible() {
    // `build_sheet_list` reads a missing slot as "visible"; this must agree, or
    // a workbook whose vector has not been grown becomes undeletable.
    let v: Vec<String> = Vec::new();
    assert_eq!(crate::sheets::visible_sheets_after_removing(&v, 3, 1), 2);
    assert!(crate::sheets::sheet_is_visible(&v, 7));
}

#[test]
fn very_hidden_does_not_count_as_visible_either() {
    let v = vis(&["veryHidden", "visible", "hidden"]);
    assert_eq!(crate::sheets::visible_sheets_after_removing(&v, 3, 1), 0);
}

#[test]
fn the_landing_sheet_is_the_preferred_one_when_it_is_visible() {
    // Non-vacuity: the walk must not drag the active sheet to index 0 every
    // time. This is the ordinary case and it has to be a no-op.
    let v = vis(&["visible", "visible", "visible"]);
    assert_eq!(crate::sheets::nearest_visible_sheet(&v, 3, 2), 2);
}

#[test]
fn the_landing_sheet_skips_a_hidden_preference() {
    let v = vis(&["hidden", "visible", "hidden"]);
    assert_eq!(
        crate::sheets::nearest_visible_sheet(&v, 3, 2),
        1,
        "index 2 is hidden; the only visible sheet is 1"
    );
    assert_eq!(crate::sheets::nearest_visible_sheet(&v, 3, 0), 1);
}

#[test]
fn delete_sheet_asks_both_questions() {
    // The pure functions are only worth something if the command calls them.
    let src = include_str!("sheets.rs");
    let at = src
        .find("pub fn delete_sheet(")
        .expect("delete_sheet was renamed — re-derive this census");
    let open = src[at..].find('{').expect("no body") + at;
    let bytes = src.as_bytes();
    let mut depth = 0usize;
    let mut end = src.len();
    for i in open..src.len() {
        match bytes[i] {
            b'{' => depth += 1,
            b'}' => {
                depth -= 1;
                if depth == 0 {
                    end = i + 1;
                    break;
                }
            }
            _ => {}
        }
    }
    let body = &src[open..end];

    assert!(
        body.contains("visible_sheets_after_removing("),
        "`delete_sheet` no longer refuses a delete that would leave the workbook \
         with no VISIBLE sheet. \"At least one sheet\" is a different test."
    );
    assert!(
        body.contains("nearest_visible_sheet("),
        "`delete_sheet` no longer moves the active index off a hidden sheet, so \
         a delete next to a hidden sheet leaves the user on a sheet with no tab."
    );
}
