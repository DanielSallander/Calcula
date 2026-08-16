//! FILENAME: app/src-tauri/src/undo_sheet_activation_tests.rs
//! PURPOSE: Undo/redo ACTIVATES the sheet it restores, the way Excel does.
//! CONTEXT: A child module of `undo_commands` (declared with `#[path]` there),
//!          so it reaches `apply_changes` and the sibling fixture.
//!
//! WHAT EXCEL DOES, AND WHY IT SETTLES THIS
//! ----------------------------------------
//! Excel keeps ONE undo history and switches to the DOCUMENT (or sheet) the
//! undone action was performed in, so the user can see what changed: edit in
//! one workbook, switch to another, press Ctrl+Z, and Excel switches back and
//! reverts the change there. The same rule applies to sheets inside a workbook,
//! and under the standing "Excel parity wins any design question" rule it is
//! Calcula's rule too.
//!
//! Calcula already restored the right cells on the right sheet — that was
//! BUG-0034, the whole-grid replacement — and then said NOTHING. An undo of an
//! off-sheet edit was therefore indistinguishable from an undo that did
//! nothing: the correct value moved on a sheet nobody was looking at.
//!
//! THE HAZARD THAT DEFERRED IT
//! ---------------------------
//! A backend switch that the frontend does not follow shows Sheet1's tab over
//! Sheet2's data, which is worse than the silence. So the switch has to be
//! ATOMIC from the user's point of view: the tab strip, the grid, the formula
//! bar and every piece of per-sheet chrome — freeze panes, zoom, split, hidden
//! rows, display flags, column widths, row heights, merges — must land on the
//! same sheet in one observable step.
//!
//! The backend half of that guarantee is that the switch goes through the ONE
//! implementation that swaps every per-sheet store (`sheets::activate_sheet`,
//! which `set_active_sheet` now delegates to), never through a local
//! `*active_sheet = n`. A second copy of the swap that forgot one store is
//! exactly the startup-only hydration defect that once showed sheet 1's panes
//! on sheet 2. The census at the bottom of this file enforces it.
//!
//! WHICH UNDOS THIS EVEN APPLIES TO
//! --------------------------------
//! Every SHEET-structural operation (add / delete / rename / move / copy)
//! ENDS the undo history — Excel parity, `undo_sheet_structure_tests` — so no
//! queued entry can name a sheet that has been renumbered or removed, and the
//! `usize` index a `CellChange` carries stays valid for as long as it exists.
//! That is what makes activating by index safe. Row/column structural undos are
//! a different thing entirely: they stay in the history, they carry their sheet
//! on `GridSnapshot`, and they activate like any other restore.

use super::undo_sheet_domain_tests::Fixture;
use engine::{Cell, CellValue};

// ---------------------------------------------------------------------------
// The rule itself
// ---------------------------------------------------------------------------

#[test]
fn an_undo_of_an_off_sheet_edit_activates_that_sheet() {
    // Edit Sheet2!A1, click the Sheet1 tab, press Ctrl+Z. Excel puts you back
    // on Sheet2 looking at the cell it just restored.
    let f = Fixture::new(2);
    f.put(0, 0, 0, Cell::new_number(500.0));
    f.put(1, 0, 0, Cell::new_number(1.0));
    f.switch_to(1);
    f.state
        .undo_stack
        .lock()
        .unwrap()
        .record_cell_change(1, 0, 0, Some(Cell::new_number(1.0)));
    f.put(1, 0, 0, Cell::new_number(42.0));
    f.switch_to(0);

    let result = f.undo();

    assert_eq!(f.active(), 1, "undo did not switch to the sheet it restored");
    assert_eq!(result.active_sheet_index, 1, "and did not report the switch");
    assert_eq!(
        result.active_sheet_name, "Sheet2",
        "the frontend needs the NAME to label the tab and the sheet context; \
         fetching it separately would open a window in which the app has \
         switched sheets and cannot say which"
    );
    // THE GRID AND THE TAB AGREE. The mirror is what the canvas paints and what
    // `get_cell` answers from, so a switch that moved the tab without moving
    // the mirror is the torn state this whole change exists to avoid.
    assert_eq!(
        f.state.grid.read().unwrap().get_cell(0, 0).map(|c| c.value.clone()),
        Some(CellValue::Number(1.0)),
        "the tab says Sheet2 and the grid is still showing Sheet1"
    );
    assert_eq!(f.number(1, 0, 0), 1.0, "and the restore itself still landed");
    assert_eq!(f.number(0, 0, 0), 500.0, "Sheet1 must be untouched");
}

#[test]
fn a_redo_activates_the_sheet_too() {
    // Redo shares `apply_changes` with undo, but that is a property of today's
    // code rather than a guarantee — `is_undo` already branches inside it — so
    // the direction is asserted rather than argued.
    let f = Fixture::new(2);
    f.put(1, 2, 3, Cell::new_number(1.0));
    f.switch_to(1);
    f.state
        .undo_stack
        .lock()
        .unwrap()
        .record_cell_change(1, 2, 3, Some(Cell::new_number(1.0)));
    f.put(1, 2, 3, Cell::new_number(42.0));

    f.switch_to(0);
    f.undo();
    assert_eq!(f.active(), 1, "precondition: the undo switched");

    f.switch_to(0);
    let result = f.redo();

    assert_eq!(f.active(), 1, "redo left the user on the wrong sheet");
    assert_eq!(result.active_sheet_index, 1);
    assert_eq!(f.number(1, 2, 3), 42.0, "and the redo itself landed");
}

#[test]
fn an_undo_on_the_active_sheet_switches_nothing() {
    // THE CONTROL. The common case must cost nothing: no mirror swap, no
    // dependency rebuild, no announcement the frontend would act on.
    let f = Fixture::new(2);
    f.put(0, 0, 0, Cell::new_number(1.0));
    f.state
        .undo_stack
        .lock()
        .unwrap()
        .record_cell_change(0, 0, 0, Some(Cell::new_number(1.0)));
    f.put(0, 0, 0, Cell::new_number(42.0));

    let result = f.undo();

    assert_eq!(f.active(), 0);
    assert_eq!(result.active_sheet_index, 0);
    assert_eq!(f.number(0, 0, 0), 1.0, "the restore still happened");
}

#[test]
fn the_result_names_the_active_sheet_even_when_nothing_moved() {
    // Reported UNCONDITIONALLY. The frontend decides whether to follow by
    // comparing this with the sheet IT believes is active — the only comparison
    // that can also repair a disagreement — so a field that is only populated
    // "when it changed" would leave it comparing against zero.
    let f = Fixture::new(3);
    f.switch_to(2);
    f.put(2, 0, 0, Cell::new_number(5.0));
    f.state
        .undo_stack
        .lock()
        .unwrap()
        .record_cell_change(2, 0, 0, Some(Cell::new_number(5.0)));

    let result = f.undo();

    assert_eq!(result.active_sheet_index, 2);
    assert_eq!(result.active_sheet_name, "Sheet3");
}

// ---------------------------------------------------------------------------
// A HIDDEN target — Excel's answer, and the guard the off-sheet path keeps
// ---------------------------------------------------------------------------

#[test]
fn a_hidden_target_sheet_is_restored_but_not_activated() {
    // Excel cannot make a hidden sheet the active one: there is no tab to
    // select, and `Activate` on a hidden sheet raises an error. Following the
    // undo there would put the grid on a sheet the tab strip cannot show — the
    // torn state in the other direction — so the restore lands where the
    // changes say and the view stays put.
    //
    // It is reachable, which is why it is handled: `hide_sheet` records no undo
    // entry, so "edit Sheet2, switch to Sheet1, hide Sheet2, press Ctrl+Z" is
    // three ordinary actions.
    //
    // This is ALSO where the off-sheet restore path keeps its original teeth:
    // with no activation, an undo belonging to another sheet must leave the
    // active mirror completely alone, which is the BUG-0034 invariant.
    let f = Fixture::new(2);
    f.put(0, 0, 0, Cell::new_number(500.0));
    f.put(1, 0, 0, Cell::new_number(1.0));
    f.switch_to(1);
    f.state
        .undo_stack
        .lock()
        .unwrap()
        .record_cell_change(1, 0, 0, Some(Cell::new_number(1.0)));
    f.put(1, 0, 0, Cell::new_number(42.0));
    f.switch_to(0);
    f.hide(1);

    let result = f.undo();

    assert_eq!(f.active(), 0, "a hidden sheet must never become the active one");
    assert_eq!(result.active_sheet_index, 0);
    assert_eq!(f.number(1, 0, 0), 1.0, "the hidden sheet was still restored");
    assert_eq!(
        f.state.grid.read().unwrap().get_cell(0, 0).map(|c| c.value.clone()),
        Some(CellValue::Number(500.0)),
        "the ACTIVE mirror must not be touched by an off-sheet restore"
    );
}

#[test]
fn a_hidden_targets_geometry_restore_stays_off_sheet_too() {
    // The same rule for the four variants BUG-0034 added a sheet to. With no
    // activation, the width has to reach `all_column_widths[1]` and the mirror
    // must be left alone — the off-sheet deferred path, exercised end to end.
    let f = Fixture::new(2);
    {
        let e = crate::document_effect::test_seed_effect();
        f.state.column_widths.write(&e).unwrap().insert(3, 111.0);
        f.state.all_column_widths.write(&e).unwrap()[1].insert(3, 222.0);
    }
    f.hide(1);
    f.state
        .undo_stack
        .lock()
        .unwrap()
        .record_column_width_change(1, 3, Some(64.0));

    f.undo();

    assert_eq!(f.active(), 0, "no activation for a hidden sheet");
    assert_eq!(
        f.state.all_column_widths.read().unwrap()[1].get(&3).copied(),
        Some(64.0),
        "the hidden sheet's column 3 was not restored into its own store"
    );
    assert_eq!(
        f.state.column_widths.read().unwrap().get(&3).copied(),
        Some(111.0),
        "the ACTIVE sheet's column 3 was resized by another sheet's undo"
    );
}

// ---------------------------------------------------------------------------
// The cases where there is nothing to aim at
// ---------------------------------------------------------------------------

#[test]
fn a_custom_restore_only_transaction_leaves_the_view_alone() {
    // A `CustomRestore` carries its sheet inside opaque bytes that this layer
    // must not parse, so the transaction names no sheet and the honest answer
    // is to move nothing. Guessing "the active sheet" is exactly the
    // sheet-blindness `SetCell.sheet` was added to end.
    let f = Fixture::new(2);
    let snapshot = crate::report::ReportUndoSnapshot {
        sheet_index: 1,
        cells: vec![(0, 0, Some(Cell::new_number(7.0)))],
        definitions: Vec::new(),
        merges: Vec::new(),
    };
    f.record_custom("report_restore", serde_json::to_vec(&snapshot).unwrap());

    let result = f.undo();

    assert_eq!(f.active(), 0, "an opaque restore must not move the user");
    assert_eq!(result.active_sheet_index, 0);
    assert_eq!(f.number(1, 0, 0), 7.0, "and it still restored its cells");
}

#[test]
fn an_out_of_range_target_is_ignored_rather_than_panicking() {
    // It cannot happen while every sheet structural operation ends the history,
    // and it is checked anyway: "safe because of a rule enforced elsewhere" is
    // how the stored INDEX became a hazard the first time.
    let f = Fixture::new(2);
    f.state
        .undo_stack
        .lock()
        .unwrap()
        .record_cell_change(9, 0, 0, Some(Cell::new_number(1.0)));

    let result = f.undo();

    assert_eq!(f.active(), 0, "an impossible index must not move the user");
    assert_eq!(result.active_sheet_index, 0);
}

// ---------------------------------------------------------------------------
// What has to travel WITH the switch
// ---------------------------------------------------------------------------

#[test]
fn every_per_sheet_store_follows_the_activation() {
    // THE HAZARD, stated as a test. A switch that moves the active INDEX but
    // not the per-sheet mirrors shows one sheet's chrome over another sheet's
    // data — the same defect class as the startup-only hydration that once
    // painted sheet 1's frozen panes on sheet 2. Every store `activate_sheet`
    // swaps is asserted here, so a future store that forgets to join the swap
    // fails BY NAME rather than by a screenshot nobody took.
    let f = Fixture::new(2);
    {
        let e = crate::document_effect::test_seed_effect();
        f.state.all_column_widths.write(&e).unwrap()[1].insert(2, 300.0);
        f.state.all_row_heights.write(&e).unwrap()[1].insert(4, 55.0);
        f.state.all_user_hidden_rows.write(&e).unwrap()[1].insert(7);
        f.state.all_user_hidden_cols.write(&e).unwrap()[1].insert(8);
    }
    crate::report::with_sheet_merges_mut(
        &f.state,
        &crate::document_effect::test_seed_effect(),
        1,
        |m| {
            m.insert(crate::api_types::MergedRegion {
                start_row: 3,
                start_col: 3,
                end_row: 4,
                end_col: 4,
            });
        },
    );
    f.put(1, 0, 0, Cell::new_number(9.0));
    f.state
        .undo_stack
        .lock()
        .unwrap()
        .record_cell_change(1, 0, 0, Some(Cell::new_number(9.0)));

    f.undo();

    assert_eq!(f.active(), 1, "precondition: the undo switched");
    assert_eq!(
        f.state.column_widths.read().unwrap().get(&2).copied(),
        Some(300.0),
        "column widths did not follow the switch"
    );
    assert_eq!(
        f.state.row_heights.read().unwrap().get(&4).copied(),
        Some(55.0),
        "row heights did not follow the switch"
    );
    assert!(
        f.state.user_hidden_rows.read().unwrap().contains(&7),
        "hidden ROWS did not follow the switch — the grid would paint the other \
         sheet's hidden set"
    );
    assert!(
        f.state.user_hidden_cols.read().unwrap().contains(&8),
        "hidden COLUMNS did not follow the switch"
    );
    assert_eq!(
        f.state.merged_regions.read().unwrap().len(),
        1,
        "merged regions did not follow the switch"
    );
}

#[test]
fn the_dependency_maps_describe_the_sheet_undo_activated() {
    // The maps are keyed by bare (row, col) and describe ONE sheet. BUG-0016
    // was exactly this: switch sheets without rebuilding them and every later
    // edit recalculates against the PREVIOUS sheet's edges, producing silently
    // wrong totals with nothing on screen to see. A backend-initiated switch
    // has to pay the same rebuild a tab click does, which is one more reason it
    // goes through `activate_sheet` rather than assigning the index.
    let f = Fixture::new(2);
    f.put(0, 0, 0, Cell::new_number(1.0));
    f.put(1, 0, 0, Cell::new_number(1.0));
    // Only SHEET2 has a formula, and it sits at a coordinate Sheet1 has nothing
    // at, so the two sheets' edge sets are distinguishable.
    f.put(1, 4, 2, Cell::new_formula("=A1*2".to_string()));
    f.switch_to(1);
    f.switch_to(0);
    assert!(
        !f.state.dependents.lock().unwrap().contains_key(&(0, 0)),
        "precondition: on Sheet1, A1 feeds nothing"
    );

    f.state
        .undo_stack
        .lock()
        .unwrap()
        .record_cell_change(1, 0, 0, Some(Cell::new_number(1.0)));
    f.undo();

    assert_eq!(f.active(), 1, "precondition: the undo switched");
    let dependents = f.state.dependents.lock().unwrap();
    assert!(
        dependents.get(&(0, 0)).is_some_and(|d| d.contains(&(4, 2))),
        "the dependency maps still describe the sheet the user LEFT, so the next \
         edit on this one recalculates against another sheet's edges"
    );
}

#[test]
fn the_anchor_is_the_cell_the_restore_landed_on() {
    // Activating the sheet is only half of "so the user can see what changed":
    // the restored cells can sit far outside the viewport that sheet was left
    // at. The anchor is what the frontend aims the selection at, which is also
    // what makes the formula bar agree with the grid.
    let f = Fixture::new(2);
    f.put(1, 9, 4, Cell::new_number(1.0));
    f.put(1, 6, 7, Cell::new_number(2.0));
    {
        let mut stack = f.state.undo_stack.lock().unwrap();
        stack.begin_transaction("Fill".to_string());
        stack.record_cell_change(1, 9, 4, Some(Cell::new_number(1.0)));
        stack.record_cell_change(1, 6, 7, Some(Cell::new_number(2.0)));
        stack.commit_transaction();
    }

    let result = f.undo();

    let anchor = result.restored_anchor.expect("no anchor for a cell restore");
    assert_eq!(
        (anchor.row, anchor.col),
        (6, 4),
        "the anchor must be the CORNER of the restored box, not its first change"
    );

    // ...and the box itself, which is what Excel actually selects (open-items
    // 1.4). The anchor is its top-left corner by construction, so the active
    // cell can never fall outside the selection reported beside it.
    let range = result.restored_range.expect("no range for a cell restore");
    assert_eq!(
        (range.start_row, range.start_col, range.end_row, range.end_col),
        (6, 4, 9, 7),
        "the range must span both changes on both axes"
    );
    assert_eq!((range.start_row, range.start_col), (anchor.row, anchor.col));
}

#[test]
fn the_reported_sheet_indices_are_relative_to_the_sheet_the_undo_ended_on() {
    // `sheet_index: null` is the wire's way of saying "the ACTIVE sheet", and
    // the restore stamps every cell while the OLD sheet is still active. The
    // switch changes which sheet that word means, so without a re-stamp the
    // result arrives inside out: the restored cells labelled with a foreign
    // index, and cells on the sheet the user just LEFT labelled "active". The
    // frontend uses exactly that flag to decide what may reach the formula bar,
    // so the inversion puts one sheet's value under another sheet's cursor.
    //
    // A TRANSACTION SPANNING TWO SHEETS is what makes both kinds appear at
    // once, and it is an ordinary shape: a grouped script batch, or an edit
    // made with sheets grouped. Sheet2 is recorded FIRST, so it is where the
    // action started and where the undo ends up; Sheet1 was active throughout.
    let f = Fixture::new(2);
    f.put(1, 0, 0, Cell::new_number(10.0));
    f.put(0, 4, 4, Cell::new_number(20.0));
    {
        let mut stack = f.state.undo_stack.lock().unwrap();
        stack.begin_transaction("Grouped edit".to_string());
        stack.record_cell_change(1, 0, 0, Some(Cell::new_number(10.0)));
        stack.record_cell_change(0, 4, 4, Some(Cell::new_number(20.0)));
        stack.commit_transaction();
    }
    f.put(1, 0, 0, Cell::new_number(99.0));
    f.put(0, 4, 4, Cell::new_number(99.0));

    let result = f.undo();

    assert_eq!(f.active(), 1, "precondition: the undo switched to Sheet2");
    let restored = result
        .updated_cells
        .iter()
        .find(|c| c.row == 0 && c.col == 0)
        .expect("the restored cell on Sheet2 was not reported at all");
    assert_eq!(
        restored.sheet_index, None,
        "the restored cell is ON the sheet this undo ended on, so it is the          ACTIVE one and must be reported as such"
    );
    let left_behind = result
        .updated_cells
        .iter()
        .find(|c| c.row == 4 && c.col == 4)
        .expect("the cell restored on the sheet we left was not reported");
    assert_eq!(
        left_behind.sheet_index,
        Some(0),
        "a cell on the sheet the undo LEFT must carry that sheet's index;          reported as 'active' it would be applied to the wrong sheet"
    );
}

#[test]
fn a_geometry_only_restore_reports_no_anchor() {
    // A column width describes a whole column and a snapshot the whole sheet;
    // neither names a cell worth aiming the view at, and inventing A1 would
    // scroll the user away from what they were looking at for no reason.
    let f = Fixture::new(2);
    f.state
        .undo_stack
        .lock()
        .unwrap()
        .record_column_width_change(1, 3, Some(64.0));

    let result = f.undo();

    assert_eq!(f.active(), 1, "it still switches — the change IS on Sheet2");
    assert!(result.restored_anchor.is_none());
    // The range is silent on exactly the restores the anchor is silent on. That
    // silence is what makes selecting-on-every-undo safe: a restore with no
    // recorded coordinates leaves the cursor where it was rather than guessing.
    assert!(result.restored_range.is_none());
}

// ---------------------------------------------------------------------------
// THE CENSUS: one implementation of "become this sheet"
// ---------------------------------------------------------------------------

const UNDO_COMMANDS_RS: &str = include_str!("undo_commands.rs");
const SHEETS_RS: &str = include_str!("sheets.rs");

#[test]
fn undo_activates_through_the_shared_swap_and_never_assigns_the_index() {
    // `activate_sheet` moves the grid mirror, the column widths, the row
    // heights, the merged regions and the user-hidden row/column sets together,
    // and then rebuilds the dependency maps. A local `*active_sheet = n` in the
    // undo path would move the INDEX and none of that — the tab would say
    // Sheet2 and every one of those stores would still be Sheet1's.
    assert!(
        UNDO_COMMANDS_RS.contains("crate::sheets::activate_sheet(state, target)"),
        "the undo path no longer switches sheets through the shared swap"
    );
    assert!(
        !UNDO_COMMANDS_RS.contains("active_sheet.write("),
        "undo_commands.rs writes the active sheet index directly; that is a \
         second implementation of a swap with six moving parts"
    );
}

#[test]
fn the_set_active_sheet_command_delegates_rather_than_duplicating() {
    // The command and the undo path must be the SAME code. The census reuses
    // the existing source walker rather than growing a second one: that
    // walker's header records two defects it has already had, and every copy of
    // it is a copy of those bugs waiting to be re-found.
    let bodies = crate::formula_serialisation_tests::free_function_bodies(SHEETS_RS);
    let (_, body) = bodies
        .iter()
        .find(|(name, _)| name == "set_active_sheet")
        .expect("`set_active_sheet` is not a free function in sheets.rs any more");
    assert!(
        body.contains("activate_sheet(&state, index)"),
        "`set_active_sheet` stopped delegating, so the tab click and the undo \
         switch are now two implementations that can drift"
    );
    assert!(
        !body.contains("std::mem::take"),
        "`set_active_sheet` has grown a swap of its own again"
    );
}

#[test]
fn the_delegation_census_can_see_a_command_that_re_implements_the_swap() {
    // TEETH. A census nobody has watched fail is a comment.
    const SABOTAGED: &str = r#"
pub fn set_active_sheet(state: State<AppState>, index: usize) -> Result<SheetsResult, String> {
    *column_widths = std::mem::take(&mut all_column_widths[index]);
    Ok(result)
}
"#;
    let bodies = crate::formula_serialisation_tests::free_function_bodies(SABOTAGED);
    let (_, body) = bodies
        .iter()
        .find(|(name, _)| name == "set_active_sheet")
        .expect("the walker did not even find the sabotaged function");
    assert!(
        !body.contains("activate_sheet(&state, index)") && body.contains("std::mem::take"),
        "the census cannot tell a delegation from a re-implementation, so it \
         would pass on the defect it exists to catch"
    );
}
