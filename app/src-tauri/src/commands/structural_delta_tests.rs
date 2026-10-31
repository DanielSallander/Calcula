//! FILENAME: app/src-tauri/src/commands/structural_delta_tests.rs
//! PURPOSE: An undo step says WHERE its lines and cells moved, so an Undo /
//!          Redo can hand the frontend's coordinate stores (Watch Window
//!          entries, cell bookmarks, a pending Copy's source) the changes it
//!          reversed or replayed -- `UndoResult::structural_deltas`, from the
//!          `structural_delta` marker each edit records beside its snapshot.
//! CONTEXT: A `#[path]` child of `structure_cells_tests` (it shares `Fx`).
//!          Round 9 matched an undo to its edit by PARSING the step's
//!          description ("Insert 2 row(s)"), which cannot name a grouped step
//!          (a macro holding several inserts) or a cell shift at all, and broke
//!          on any change of wording. These tests pin the structured answer.

use super::*;
use crate::api_types::{DeltaBand, StructuralDelta as D};
use crate::undo_commands::UndoResult;

impl Fx {
    fn undo_result(&self) -> UndoResult {
        let transaction = self.state.undo_stack.lock().unwrap().pop_undo().expect("nothing to undo");
        crate::undo_commands::apply_changes(
            &self.state, &self.file, &self.files, &self.pivots, &self.slicer, &self.filters, &self.pane,
            &self.timeline, transaction, true,
        )
    }

    fn redo_result(&self) -> UndoResult {
        let transaction = self.state.undo_stack.lock().unwrap().pop_redo().expect("nothing to redo");
        crate::undo_commands::apply_changes(
            &self.state, &self.file, &self.files, &self.pivots, &self.slicer, &self.filters, &self.pane,
            &self.timeline, transaction, false,
        )
    }

    fn insert_rows(&self, at: u32, count: u32, sheet: Option<usize>) {
        insert_rows_impl(&self.state, &self.file, &self.pivots, &self.files, &self.pane, &self.filters, &self.slicer, &self.timeline, at, count, sheet)
            .expect("insert rows");
    }

    fn insert_columns(&self, at: u32, count: u32) {
        insert_columns_impl(&self.state, &self.file, &self.pivots, &self.files, &self.pane, &self.filters, &self.slicer, &self.timeline, at, count, None)
            .expect("insert columns");
    }

    fn delete_rows(&self, at: u32, count: u32) {
        delete_rows_impl(&self.state, &self.file, &self.pivots, &self.files, &self.pane, &self.filters, &self.slicer, &self.timeline, at, count, None)
            .expect("delete rows");
    }
}

/// An undone row insert reads as the DELETE that took its lines back, and its
/// redo as the insert again -- whatever the step's description says.
#[test]
fn an_undo_reports_the_line_edit_it_reversed_and_a_redo_replays_it() {
    let fx = Fx::new(1);
    fx.put(0, "A6", "6");
    fx.insert_rows(1, 2, None);

    let undone = fx.undo_result();
    assert!(undone.structural_restore);
    assert_eq!(
        undone.structural_deltas,
        vec![D::RowDelete { sheet_index: 0, at: 1, count: 2, band: None }],
        "the undo of Insert 2 rows at row 2 takes rows 2:3 back out"
    );

    let redone = fx.redo_result();
    assert_eq!(
        redone.structural_deltas,
        vec![D::RowInsert { sheet_index: 0, at: 1, count: 2, band: None }],
        "the redo replays the insert"
    );

    // And again: the redo's inverse step still carries the change.
    let undone_again = fx.undo_result();
    assert_eq!(undone_again.structural_deltas, vec![D::RowDelete { sheet_index: 0, at: 1, count: 2, band: None }]);
}

/// A GROUPED step -- a macro holding three edits in one transaction -- reports
/// every one: an undo newest first, each reversed; a redo oldest first. The
/// description ("Run macro") names none of them, which is exactly the case the
/// description parser could not follow.
#[test]
fn a_grouped_step_reports_every_edit_newest_first_on_undo_oldest_first_on_redo() {
    let fx = Fx::new(1);
    fx.put(0, "C12", "1");
    fx.state.undo_stack.lock().unwrap().begin_transaction("Run macro");
    fx.insert_rows(1, 2, None);
    fx.insert_columns(3, 1);
    fx.delete_rows(9, 1);
    fx.state.undo_stack.lock().unwrap().commit_transaction();
    assert_eq!(fx.undo_depth(), 1, "one step");

    let undone = fx.undo_result();
    assert_eq!(undone.description.as_deref(), Some("Run macro"));
    assert_eq!(
        undone.structural_deltas,
        vec![
            D::RowInsert { sheet_index: 0, at: 9, count: 1, band: None },
            D::ColDelete { sheet_index: 0, at: 3, count: 1, band: None },
            D::RowDelete { sheet_index: 0, at: 1, count: 2, band: None },
        ]
    );

    let redone = fx.redo_result();
    assert_eq!(
        redone.structural_deltas,
        vec![
            D::RowInsert { sheet_index: 0, at: 1, count: 2, band: None },
            D::ColInsert { sheet_index: 0, at: 3, count: 1, band: None },
            D::RowDelete { sheet_index: 0, at: 9, count: 1, band: None },
        ]
    );
}

/// Insert Cells hands its BAND back (a row insert confined to the range's
/// columns), and its undo reverses exactly that band.
#[test]
fn insert_cells_hands_back_its_band_and_its_undo_reverses_it() {
    let fx = Fx::new(1);
    fx.put(0, "B6", "6");
    let result = fx.shift("B2:C3", CellShift::Down, false).expect("insert cells");
    let band = Some(DeltaBand { start: 1, end: 2 });
    assert_eq!(result.delta, Some(D::RowInsert { sheet_index: 0, at: 1, count: 2, band }));

    let undone = fx.undo_result();
    assert_eq!(undone.structural_deltas, vec![D::RowDelete { sheet_index: 0, at: 1, count: 2, band }]);

    let right = fx.shift("B2:C3", CellShift::Left, false).expect("delete cells");
    assert_eq!(
        right.delta,
        Some(D::ColDelete { sheet_index: 0, at: 1, count: 2, band: Some(DeltaBand { start: 1, end: 2 }) }),
        "a column-wise shift is a column edit confined to the range's rows"
    );
}

/// An edit on a sheet that is not the active one names ITS sheet.
#[test]
fn an_off_sheet_edit_reports_its_own_sheet() {
    let fx = Fx::new(2);
    fx.put(1, "A5", "5");
    fx.insert_rows(2, 1, Some(1));
    let undone = fx.undo_result();
    assert_eq!(undone.structural_deltas, vec![D::RowDelete { sheet_index: 1, at: 2, count: 1, band: None }]);
}

/// A cut-paste MOVE records where the block went, in the paste's own step: its
/// undo moves the landed block back, its redo moves it again.
#[test]
fn a_cut_paste_move_is_reported_reversed_on_undo_and_replayed_on_redo() {
    let fx = Fx::new(1);
    fx.put(0, "A1", "1");
    fx.put(0, "H1", "=A1");
    fx.settle();
    fx.state.undo_stack.lock().unwrap().begin_transaction("Paste");
    relocate_cell_references_core(&fx.state, &fx.file, &fx.files, &fx.pivots, &fx.pane, &fx.filters, 0, 0, 1, 1, 4, 3, None)
        .expect("relocate");
    fx.state.undo_stack.lock().unwrap().commit_transaction();

    let moved = D::Move {
        from_sheet_index: 0,
        from_start_row: 0,
        from_start_col: 0,
        from_end_row: 1,
        from_end_col: 1,
        to_sheet_index: 0,
        to_row: 4,
        to_col: 3,
    };
    let undone = fx.undo_result();
    assert_eq!(undone.structural_deltas, vec![moved.inverse()]);
    assert_eq!(
        moved.inverse(),
        D::Move {
            from_sheet_index: 0,
            from_start_row: 4,
            from_start_col: 3,
            from_end_row: 5,
            from_end_col: 4,
            to_sheet_index: 0,
            to_row: 0,
            to_col: 0,
        }
    );
    let redone = fx.redo_result();
    assert_eq!(redone.structural_deltas, vec![moved]);
}

/// A step that moved no coordinates reports none, and the wire shape is the
/// one the frontend reads (internally tagged, camelCase).
#[test]
fn a_plain_step_reports_no_change_and_the_wire_shape_is_camel_case() {
    let fx = Fx::new(1);
    fx.state.undo_stack.lock().unwrap().record_cell_change(0, 0, 0, None);
    let undone = fx.undo_result();
    assert!(undone.structural_deltas.is_empty());

    let json = serde_json::to_value(D::RowInsert { sheet_index: 2, at: 4, count: 1, band: Some(DeltaBand { start: 1, end: 3 }) }).unwrap();
    assert_eq!(json, serde_json::json!({ "kind": "rowInsert", "sheetIndex": 2, "at": 4, "count": 1, "band": { "start": 1, "end": 3 } }));
    let json = serde_json::to_value(D::Move {
        from_sheet_index: 0,
        from_start_row: 1,
        from_start_col: 2,
        from_end_row: 3,
        from_end_col: 4,
        to_sheet_index: 1,
        to_row: 5,
        to_col: 6,
    })
    .unwrap();
    assert_eq!(
        json,
        serde_json::json!({ "kind": "move", "fromSheetIndex": 0, "fromStartRow": 1, "fromStartCol": 2, "fromEndRow": 3, "fromEndCol": 4, "toSheetIndex": 1, "toRow": 5, "toCol": 6 })
    );
}
