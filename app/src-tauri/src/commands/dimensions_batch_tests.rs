//! FILENAME: app/src-tauri/src/commands/dimensions_batch_tests.rs
//! PURPOSE: The batch Row Height / Column Width commands (`set_row_heights` /
//!          `set_column_widths`) and the protection gate on the two
//!          standard-size commands.
//! CONTEXT: A `#[path]` child of `dimensions`. Drives the state-only bodies
//!          over a real `AppState` and undoes through the real
//!          `apply_changes`, so the restore kind, its registry row and the
//!          deferral are all exercised.

use super::*;
use crate::pane_control::PaneControlState;
use crate::persistence::UserFilesState;
use crate::pivot::PivotState;
use crate::ribbon_filter::RibbonFilterState;
use crate::slicer::SlicerState;
use crate::timeline_slicer::TimelineSlicerState;

struct Fx {
    state: AppState,
    file: FileState,
    files: UserFilesState,
    pivots: PivotState,
    pane: PaneControlState,
    filters: RibbonFilterState,
    slicer: SlicerState,
    timeline: TimelineSlicerState,
}

impl Fx {
    fn new() -> Self {
        Fx {
            state: crate::create_app_state(),
            file: FileState::default(),
            files: UserFilesState::default(),
            pivots: PivotState::new(),
            pane: PaneControlState::new(),
            filters: RibbonFilterState::new(),
            slicer: SlicerState::new(),
            timeline: TimelineSlicerState::new(),
        }
    }

    fn heights(&self) -> HashMap<u32, f64> {
        self.state.row_heights.read().unwrap().clone()
    }

    fn widths(&self) -> HashMap<u32, f64> {
        self.state.column_widths.read().unwrap().clone()
    }

    fn undo_depth(&self) -> usize {
        self.state.undo_stack.lock().unwrap().undo_depth()
    }

    fn undo(&self) {
        let t = self.state.undo_stack.lock().unwrap().pop_undo().expect("nothing to undo");
        crate::undo_commands::apply_changes(
            &self.state, &self.file, &self.files, &self.pivots, &self.slicer, &self.filters, &self.pane,
            &self.timeline, t, true,
        );
    }

    fn redo(&self) {
        let t = self.state.undo_stack.lock().unwrap().pop_redo().expect("nothing to redo");
        crate::undo_commands::apply_changes(
            &self.state, &self.file, &self.files, &self.pivots, &self.slicer, &self.filters, &self.pane,
            &self.timeline, t, false,
        );
    }

    fn protect(&self) {
        let seed = crate::document_effect::test_seed_effect();
        self.state.sheet_protection.write(&seed).unwrap().entry(0).or_default().protected = true;
    }
}

const LAST_ROW: u32 = engine::EXCEL_MAX_ROW_INDEX;

// ===========================================================================
// PURE: runs and segments
// ===========================================================================

#[test]
fn runs_are_merged_and_checked_against_the_sheet() {
    assert_eq!(normalize_line_runs(&[(5, 2), (3, 9), (11, 11), (10, 10)], 100), Ok(vec![(2, 11)]));
    assert_eq!(normalize_line_runs(&[(0, 0), (2, 2)], 100), Ok(vec![(0, 0), (2, 2)]));
    assert!(normalize_line_runs(&[(0, 101)], 100).unwrap_err().contains("past the end"));
    assert_eq!(normalize_line_runs(&[], 100), Ok(vec![]));
}

/// The undo record of Select All is a handful of segments, not a million
/// entries: the previous sizes, run-length encoded.
#[test]
fn segments_run_length_encode_a_whole_axis() {
    let mut sizes: HashMap<u32, f64> = HashMap::new();
    sizes.insert(5, 40.0);
    sizes.insert(6, 40.0);
    sizes.insert(9, 12.0);
    assert_eq!(
        line_size_segments(&sizes, &[(0, LAST_ROW)]),
        vec![(0, 4, None), (5, 6, Some(40.0)), (7, 8, None), (9, 9, Some(12.0)), (10, LAST_ROW, None)]
    );
    // Applying the segments back over a resized axis restores it exactly.
    let mut resized: HashMap<u32, f64> = HashMap::new();
    apply_line_size_segments(&mut resized, &[(0, LAST_ROW, Some(30.0))]);
    assert_eq!(resized.len() as u64, LAST_ROW as u64 + 1);
    apply_line_size_segments(&mut resized, &line_size_segments(&sizes, &[(0, LAST_ROW)]));
    assert_eq!(resized, sizes);
}

// ===========================================================================
// THE COMMANDS
// ===========================================================================

/// "Select All, then Row Height": ONE call, ONE undo step, every row set; undo
/// puts back exactly the heights there were (including rows that had none);
/// redo sets them all again.
#[test]
fn select_all_row_height_is_one_command_and_one_undo_step() {
    let fx = Fx::new();
    let seed = crate::document_effect::test_seed_effect();
    fx.state.row_heights.write(&seed).unwrap().insert(5, 40.0);
    let before = fx.heights();
    let depth = fx.undo_depth();

    let changed = set_line_sizes_inner(&fx.state, &fx.file, true, &[(0, LAST_ROW)], 30.0).expect("resize");
    assert_eq!(changed, LAST_ROW as u64 + 1, "every row changed");
    let after = fx.heights();
    assert_eq!(after.len() as u64, LAST_ROW as u64 + 1);
    assert!(after.values().all(|&h| h == 30.0));
    assert!(fx.file.is_dirty(), "a resize dirties the document");
    assert_eq!(fx.undo_depth(), depth + 1, "ONE undo step");

    fx.undo();
    assert_eq!(fx.heights(), before, "undo restores the heights exactly");
    fx.redo();
    assert_eq!(fx.heights().len() as u64, LAST_ROW as u64 + 1, "redo sets every row again");
    assert!(fx.heights().values().all(|&h| h == 30.0));
}

/// Several areas (a Ctrl+click selection) are one step too, and a column
/// resize does not touch the rows.
#[test]
fn several_runs_of_columns_are_one_step() {
    let fx = Fx::new();
    let depth = fx.undo_depth();
    set_line_sizes_inner(&fx.state, &fx.file, false, &[(1, 3), (7, 7), (2, 5)], 120.0).expect("resize");
    let widths = fx.widths();
    let mut keys: Vec<u32> = widths.keys().copied().collect();
    keys.sort_unstable();
    assert_eq!(keys, vec![1, 2, 3, 4, 5, 7]);
    assert!(widths.values().all(|&w| w == 120.0));
    assert!(fx.heights().is_empty());
    assert_eq!(fx.undo_depth(), depth + 1);
    fx.undo();
    assert!(fx.widths().is_empty());
}

/// Nothing to change: nothing recorded, the document stays clean.
#[test]
fn a_resize_that_changes_nothing_records_nothing_and_stays_clean() {
    let fx = Fx::new();
    let seed = crate::document_effect::test_seed_effect();
    fx.state.row_heights.write(&seed).unwrap().insert(2, 25.0);
    fx.state.row_heights.write(&seed).unwrap().insert(3, 25.0);
    let depth = fx.undo_depth();
    assert_eq!(set_line_sizes_inner(&fx.state, &fx.file, true, &[(2, 3)], 25.0), Ok(0));
    // Size <= 0 removes a row's own height; rows that have none: no change.
    assert_eq!(set_line_sizes_inner(&fx.state, &fx.file, true, &[(10, 20)], 0.0), Ok(0));
    assert!(!fx.file.is_dirty());
    assert_eq!(fx.undo_depth(), depth);
    // ...and on a row that has one, it goes back to the default.
    assert_eq!(set_line_sizes_inner(&fx.state, &fx.file, true, &[(3, 3)], 0.0), Ok(1));
    assert_eq!(fx.heights().get(&3), None);
}

/// The sheet's Format rows / Format columns protection options gate the batch
/// exactly as they gate one line, and a refusal changes nothing.
#[test]
fn a_protected_sheet_refuses_and_stays_clean() {
    let fx = Fx::new();
    fx.protect();
    let err = set_line_sizes_inner(&fx.state, &fx.file, true, &[(0, 9)], 30.0).unwrap_err();
    assert!(err.to_lowercase().contains("protect"), "{}", err);
    assert!(set_line_sizes_inner(&fx.state, &fx.file, false, &[(0, 9)], 30.0).is_err());
    assert!(fx.heights().is_empty() && fx.widths().is_empty());
    assert!(!fx.file.is_dirty());
}

#[test]
fn bad_input_is_refused_before_anything_changes() {
    let fx = Fx::new();
    assert!(set_line_sizes_inner(&fx.state, &fx.file, true, &[(0, LAST_ROW + 1)], 30.0).is_err());
    assert!(set_line_sizes_inner(&fx.state, &fx.file, false, &[(0, engine::EXCEL_MAX_COL_INDEX + 1)], 30.0).is_err());
    assert!(set_line_sizes_inner(&fx.state, &fx.file, true, &[(0, 3)], f64::NAN).is_err());
    assert!(!fx.file.is_dirty());
}

/// shell-sheets lane, "Not fixed" 1: `set_default_column_width` had no
/// protection check, so on a sheet protected against column formatting one
/// column could not be resized but every default-width column could.
#[test]
fn the_standard_sizes_are_refused_on_a_protected_sheet() {
    let fx = Fx::new();
    let width_before = *fx.state.default_column_width.read().unwrap();
    let height_before = *fx.state.default_row_height.read().unwrap();
    fx.protect();
    assert!(set_default_column_width_inner(&fx.state, &fx.file, 120.0).is_err());
    assert!(set_default_row_height_inner(&fx.state, &fx.file, 30.0).is_err());
    assert_eq!(*fx.state.default_column_width.read().unwrap(), width_before);
    assert_eq!(*fx.state.default_row_height.read().unwrap(), height_before);
    assert!(!fx.file.is_dirty(), "a refusal leaves the document clean");

    // Control: unprotected, both apply.
    let fx = Fx::new();
    assert_eq!(set_default_column_width_inner(&fx.state, &fx.file, 120.0).map(|d| d.default_column_width), Ok(120.0));
    assert_eq!(set_default_row_height_inner(&fx.state, &fx.file, 30.0).map(|d| d.default_row_height), Ok(30.0));
    assert!(fx.file.is_dirty());
}
