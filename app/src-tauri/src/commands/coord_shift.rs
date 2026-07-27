//! FILENAME: app/src-tauri/src/commands/coord_shift.rs
//! PURPOSE: One implementation of "move a cell coordinate through a structural
//!          grid edit", plus generic helpers for the per-sheet stores keyed by
//!          that coordinate.
//! CONTEXT: Row/column insert & delete move every cell on the sheet, so every
//!          store that remembers a cell POSITION has to move with them. Each
//!          store that learned this did so with its own hand-rolled loop
//!          (cell_types, cell_behaviors, tables, pivot regions, writeback
//!          regions, AutoFilters), and the ones that never learned it silently
//!          re-point: a comment attached to A5 stays on A5 after a row is
//!          inserted above it, so it now annotates a different value.
//!
//!          This module exists so the remaining stores are fixed as a CLASS
//!          rather than one per incident: `shift_cell` is the single source of
//!          truth for the arithmetic, and `shift_per_sheet_cell_map` applies it
//!          to the common `HashMap<sheet, HashMap<(row, col), T>>` shape.

use std::collections::HashMap;

use calp::writeback::StructuralEdit;

/// Where a cell at `(row, col)` ends up after `edit`, or `None` when the edit
/// deleted the row/column it lived in.
///
/// Boundary rules match the grid's own cell movement: an insert AT a
/// coordinate pushes that coordinate along (the new row/column takes its
/// place); a delete removes exactly `[at, at + count)`.
pub fn shift_cell(row: u32, col: u32, edit: StructuralEdit) -> Option<(u32, u32)> {
    match edit {
        StructuralEdit::RowInsert { at, count } => {
            Some(if row >= at { (row + count, col) } else { (row, col) })
        }
        StructuralEdit::ColInsert { at, count } => {
            Some(if col >= at { (row, col + count) } else { (row, col) })
        }
        StructuralEdit::RowDelete { at, count } => {
            let del_end = at.saturating_add(count);
            if row >= del_end {
                Some((row - count, col))
            } else if row >= at {
                None // The row itself was deleted.
            } else {
                Some((row, col))
            }
        }
        StructuralEdit::ColDelete { at, count } => {
            let del_end = at.saturating_add(count);
            if col >= del_end {
                Some((row, col - count))
            } else if col >= at {
                None // The column itself was deleted.
            } else {
                Some((row, col))
            }
        }
    }
}

/// A rectangular range, inclusive on both ends.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CellRange {
    pub start_row: u32,
    pub end_row: u32,
    pub start_col: u32,
    pub end_col: u32,
}

/// Where a range ends up after `edit`, or `None` when the edit deleted every
/// row or every column it covered.
///
/// The range analogue of [`shift_cell`], and the second of the two shapes these
/// stores come in: conditional formats, data validations and merged regions all
/// remember a RECTANGLE rather than a single cell.
///
/// Delegates to the same 1-D interval math the writeback-region and AutoFilter
/// shifts use, so a rectangle and a cell inside it can never disagree about
/// where the edit put them.
///
/// A row edit only moves the row interval and a column edit only the column
/// interval — an insert far to the right cannot move a range down.
pub fn shift_range(range: CellRange, edit: StructuralEdit) -> Option<CellRange> {
    use calp::writeback::{interval_delete, interval_insert};
    let mut out = range;
    match edit {
        StructuralEdit::RowInsert { at, count } => {
            let (s, e) = interval_insert(range.start_row, range.end_row, at, count);
            out.start_row = s;
            out.end_row = e;
        }
        StructuralEdit::ColInsert { at, count } => {
            let (s, e) = interval_insert(range.start_col, range.end_col, at, count);
            out.start_col = s;
            out.end_col = e;
        }
        StructuralEdit::RowDelete { at, count } => {
            let (s, e) = interval_delete(range.start_row, range.end_row, at, count)?;
            out.start_row = s;
            out.end_row = e;
        }
        StructuralEdit::ColDelete { at, count } => {
            let (s, e) = interval_delete(range.start_col, range.end_col, at, count)?;
            out.start_col = s;
            out.end_col = e;
        }
    }
    Some(out)
}

/// A stored value that ALSO remembers its own cell position.
///
/// Several of these stores duplicate the coordinate: it is the map key AND a
/// pair of fields on the value. Re-keying alone would split them, and that
/// split is worse than the original bug — reads are inconsistent (indicators
/// render from the payload, lookups go through the key), and persistence
/// re-derives the key FROM the payload on load, silently undoing the shift.
///
/// Implement this for anything driven through [`shift_per_sheet_cell_map`];
/// the no-op default is correct for values that carry no coordinates.
pub trait CellAnchored {
    fn set_cell(&mut self, _row: u32, _col: u32) {}
}

impl CellAnchored for crate::comments::Comment {
    fn set_cell(&mut self, row: u32, col: u32) {
        self.row = row;
        self.col = col;
    }
}

impl CellAnchored for crate::notes::Note {
    fn set_cell(&mut self, row: u32, col: u32) {
        self.row = row;
        self.col = col;
    }
}

impl CellAnchored for crate::hyperlinks::Hyperlink {
    fn set_cell(&mut self, row: u32, col: u32) {
        self.row = row;
        self.col = col;
    }
}

/// Carries no coordinates of its own — the map key is the only position.
impl CellAnchored for crate::protection::CellProtection {}

/// Apply [`shift_cell`] to every entry of one sheet in a
/// `HashMap<sheet_index, HashMap<(row, col), T>>` store.
///
/// Entries whose cell was deleted are dropped, and surviving entries have their
/// own coordinates re-stamped via [`CellAnchored`] so key and payload never
/// disagree. Returns whether anything changed, so the caller can skip recording
/// an undo entry for a no-op.
///
/// Rebuilds the sheet's inner map rather than mutating in place: a shift can
/// move one entry onto another's old key, and an in-place `remove`/`insert`
/// walk would clobber whichever it happened to visit first.
pub fn shift_per_sheet_cell_map<T: CellAnchored>(
    store: &mut HashMap<usize, HashMap<(u32, u32), T>>,
    sheet_index: usize,
    edit: StructuralEdit,
) -> bool {
    let Some(sheet_entries) = store.get_mut(&sheet_index) else {
        return false;
    };
    if sheet_entries.is_empty() {
        return false;
    }

    let original: Vec<((u32, u32), T)> = sheet_entries.drain().collect();
    let mut changed = false;
    let mut rebuilt: HashMap<(u32, u32), T> = HashMap::with_capacity(original.len());

    for ((row, col), mut value) in original {
        match shift_cell(row, col, edit) {
            Some(new_key) => {
                if new_key != (row, col) {
                    changed = true;
                    // Keep the payload's own coordinates in step with the key.
                    value.set_cell(new_key.0, new_key.1);
                }
                rebuilt.insert(new_key, value);
            }
            None => {
                changed = true; // Entry dropped with its row/column.
            }
        }
    }

    *sheet_entries = rebuilt;
    changed
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Stand-in for the real stores: carries its own coordinates so the
    /// key/payload sync is observable.
    #[derive(Debug, PartialEq, Clone)]
    struct Anchored {
        tag: &'static str,
        row: u32,
        col: u32,
    }
    impl CellAnchored for Anchored {
        fn set_cell(&mut self, row: u32, col: u32) {
            self.row = row;
            self.col = col;
        }
    }
    fn anchored(tag: &'static str, row: u32, col: u32) -> Anchored {
        Anchored { tag, row, col }
    }

    fn row_insert(at: u32, count: u32) -> StructuralEdit {
        StructuralEdit::RowInsert { at, count }
    }
    fn row_delete(at: u32, count: u32) -> StructuralEdit {
        StructuralEdit::RowDelete { at, count }
    }
    fn col_insert(at: u32, count: u32) -> StructuralEdit {
        StructuralEdit::ColInsert { at, count }
    }
    fn col_delete(at: u32, count: u32) -> StructuralEdit {
        StructuralEdit::ColDelete { at, count }
    }

    #[test]
    fn row_insert_pushes_cells_at_or_below() {
        assert_eq!(shift_cell(5, 2, row_insert(5, 1)), Some((6, 2)));
        assert_eq!(shift_cell(9, 2, row_insert(5, 3)), Some((12, 2)));
        // Above the insertion point: untouched.
        assert_eq!(shift_cell(4, 2, row_insert(5, 1)), Some((4, 2)));
    }

    #[test]
    fn col_insert_pushes_cells_at_or_right() {
        assert_eq!(shift_cell(3, 5, col_insert(5, 1)), Some((3, 6)));
        assert_eq!(shift_cell(3, 4, col_insert(5, 1)), Some((3, 4)));
    }

    #[test]
    fn row_delete_drops_cells_inside_and_pulls_up_below() {
        // Inside the deleted range -> gone.
        assert_eq!(shift_cell(5, 1, row_delete(5, 2)), None);
        assert_eq!(shift_cell(6, 1, row_delete(5, 2)), None);
        // Below -> pulled up.
        assert_eq!(shift_cell(7, 1, row_delete(5, 2)), Some((5, 1)));
        // Above -> untouched.
        assert_eq!(shift_cell(4, 1, row_delete(5, 2)), Some((4, 1)));
    }

    #[test]
    fn col_delete_drops_cells_inside_and_pulls_left() {
        assert_eq!(shift_cell(1, 5, col_delete(5, 2)), None);
        assert_eq!(shift_cell(1, 7, col_delete(5, 2)), Some((1, 5)));
        assert_eq!(shift_cell(1, 4, col_delete(5, 2)), Some((1, 4)));
    }

    #[test]
    fn shift_never_underflows() {
        // Every delete offset/width against a fixed cell must either drop it or
        // yield a coordinate — never panic on subtraction.
        for at in 0..20u32 {
            for count in 1..20u32 {
                let _ = shift_cell(7, 7, row_delete(at, count));
                let _ = shift_cell(7, 7, col_delete(at, count));
            }
        }
    }

    // --- Range shift ---

    fn rng(sr: u32, er: u32, sc: u32, ec: u32) -> CellRange {
        CellRange { start_row: sr, end_row: er, start_col: sc, end_col: ec }
    }

    #[test]
    fn range_row_insert_shifts_or_grows() {
        // Above the range: pushed down whole.
        assert_eq!(shift_range(rng(10, 20, 0, 3), row_insert(5, 2)), Some(rng(12, 22, 0, 3)));
        // Inside: grows.
        assert_eq!(shift_range(rng(10, 20, 0, 3), row_insert(15, 2)), Some(rng(10, 22, 0, 3)));
        // Below: untouched.
        assert_eq!(shift_range(rng(10, 20, 0, 3), row_insert(50, 2)), Some(rng(10, 20, 0, 3)));
    }

    #[test]
    fn range_col_edit_does_not_move_rows() {
        // A column insert must not touch the row interval, and vice versa.
        assert_eq!(shift_range(rng(10, 20, 5, 8), col_insert(0, 3)), Some(rng(10, 20, 8, 11)));
        assert_eq!(shift_range(rng(10, 20, 5, 8), row_insert(0, 3)), Some(rng(13, 23, 5, 8)));
    }

    #[test]
    fn range_delete_clips_and_removes() {
        // Wholly inside the deleted rows -> gone.
        assert_eq!(shift_range(rng(10, 20, 0, 3), row_delete(5, 30)), None);
        // Wholly inside the deleted cols -> gone.
        assert_eq!(shift_range(rng(10, 20, 5, 8), col_delete(0, 20)), None);
        // Spanning: shrinks.
        assert_eq!(shift_range(rng(10, 20, 0, 3), row_delete(12, 3)), Some(rng(10, 17, 0, 3)));
        // Entirely after: pulled back.
        assert_eq!(shift_range(rng(10, 20, 0, 3), row_delete(0, 5)), Some(rng(5, 15, 0, 3)));
    }

    #[test]
    fn range_shift_never_inverts() {
        for at in 0..25u32 {
            for count in 1..25u32 {
                for edit in [row_delete(at, count), col_delete(at, count)] {
                    if let Some(r) = shift_range(rng(10, 20, 5, 8), edit) {
                        assert!(r.start_row <= r.end_row, "rows inverted: {:?} {:?}", r, edit);
                        assert!(r.start_col <= r.end_col, "cols inverted: {:?} {:?}", r, edit);
                    }
                }
            }
        }
    }

    #[test]
    fn map_shift_moves_entries_and_reports_change() {
        let mut store: HashMap<usize, HashMap<(u32, u32), Anchored>> = HashMap::new();
        store.insert(
            0,
            HashMap::from([((5, 0), anchored("a", 5, 0)), ((2, 0), anchored("b", 2, 0))]),
        );

        let changed = shift_per_sheet_cell_map(&mut store, 0, row_insert(3, 2));
        assert!(changed);
        let sheet = &store[&0];
        assert_eq!(sheet[&(7, 0)].tag, "a", "at/below the insert moves");
        assert_eq!(sheet[&(2, 0)].tag, "b", "above it does not");
        assert_eq!(sheet.len(), 2);
    }

    #[test]
    fn map_shift_restamps_the_payload_coordinates() {
        // The whole point: Comment/Note/Hyperlink duplicate their position in
        // the value. If only the key moved, indicators would render at the old
        // cell while lookups resolved to the new one — and persistence, which
        // rebuilds the key FROM the payload, would undo the shift on reload.
        let mut store: HashMap<usize, HashMap<(u32, u32), Anchored>> = HashMap::new();
        store.insert(0, HashMap::from([((5, 3), anchored("a", 5, 3))]));

        shift_per_sheet_cell_map(&mut store, 0, row_insert(0, 2));
        let moved = &store[&0][&(7, 3)];
        assert_eq!((moved.row, moved.col), (7, 3), "payload must follow the key");

        shift_per_sheet_cell_map(&mut store, 0, col_insert(0, 1));
        let moved = &store[&0][&(7, 4)];
        assert_eq!((moved.row, moved.col), (7, 4));
    }

    #[test]
    fn map_shift_leaves_payload_alone_when_the_cell_did_not_move() {
        let mut store: HashMap<usize, HashMap<(u32, u32), Anchored>> = HashMap::new();
        store.insert(0, HashMap::from([((2, 0), anchored("a", 2, 0))]));
        shift_per_sheet_cell_map(&mut store, 0, row_insert(50, 1));
        let still = &store[&0][&(2, 0)];
        assert_eq!((still.row, still.col), (2, 0));
    }

    #[test]
    fn map_shift_drops_entries_on_deleted_rows() {
        let mut store: HashMap<usize, HashMap<(u32, u32), Anchored>> = HashMap::new();
        store.insert(
            0,
            HashMap::from([((5, 0), anchored("gone", 5, 0)), ((9, 0), anchored("kept", 9, 0))]),
        );

        let changed = shift_per_sheet_cell_map(&mut store, 0, row_delete(4, 3));
        assert!(changed);
        let sheet = &store[&0];
        assert_eq!(sheet.len(), 1);
        assert_eq!(sheet[&(6, 0)].tag, "kept");
        assert_eq!((sheet[&(6, 0)].row, sheet[&(6, 0)].col), (6, 0));
    }

    #[test]
    fn map_shift_does_not_clobber_when_entries_collide() {
        // Deleting row 4 pulls row 5 onto key 4. An in-place remove/insert walk
        // could visit 5 first, write it to 4, then visit the ORIGINAL 4 and
        // overwrite it. Rebuilding avoids that.
        let mut store: HashMap<usize, HashMap<(u32, u32), Anchored>> = HashMap::new();
        store.insert(
            0,
            HashMap::from([
                ((4, 0), anchored("deleted", 4, 0)),
                ((5, 0), anchored("survivor", 5, 0)),
            ]),
        );

        shift_per_sheet_cell_map(&mut store, 0, row_delete(4, 1));
        let sheet = &store[&0];
        assert_eq!(sheet.len(), 1);
        assert_eq!(sheet[&(4, 0)].tag, "survivor");
    }

    #[test]
    fn map_shift_reports_no_change_for_untouched_sheet() {
        let mut store: HashMap<usize, HashMap<(u32, u32), Anchored>> = HashMap::new();
        store.insert(0, HashMap::from([((2, 0), anchored("a", 2, 0))]));
        // Insert below everything on the sheet.
        assert!(!shift_per_sheet_cell_map(&mut store, 0, row_insert(50, 1)));
        // A sheet with no entries, and an absent sheet.
        store.insert(1, HashMap::new());
        assert!(!shift_per_sheet_cell_map(&mut store, 1, row_insert(0, 1)));
        assert!(!shift_per_sheet_cell_map(&mut store, 99, row_insert(0, 1)));
    }

    #[test]
    fn other_sheets_are_untouched() {
        let mut store: HashMap<usize, HashMap<(u32, u32), Anchored>> = HashMap::new();
        store.insert(0, HashMap::from([((5, 0), anchored("sheet0", 5, 0))]));
        store.insert(1, HashMap::from([((5, 0), anchored("sheet1", 5, 0))]));

        shift_per_sheet_cell_map(&mut store, 0, row_insert(0, 3));
        assert_eq!(store[&0][&(8, 0)].tag, "sheet0");
        assert_eq!(store[&1][&(5, 0)].tag, "sheet1", "other sheet intact");
        assert_eq!(
            (store[&1][&(5, 0)].row, store[&1][&(5, 0)].col),
            (5, 0),
            "other sheet's payload untouched"
        );
    }
}
