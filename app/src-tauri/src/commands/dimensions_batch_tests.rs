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

    /// The ACTIVE sheet's standard sizes, as `get_default_dimensions` answers.
    fn standard(&self) -> DefaultDimensions {
        sheet_default_dimensions(&self.state.grid.read().unwrap())
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

/// BUG-0353, Excel's rule (live Excel 16, 2026-10-30): "Select All, then Row
/// Height 30" sets the sheet's STANDARD row height -- `<sheetFormatPr
/// defaultRowHeight="30" customHeight="1">`, no per-row heights -- and a row
/// that had its own 50 shows 30 too. ONE call, ONE undo step that puts back
/// the standard AND the row's own height exactly; redo sets them again. The
/// sheet stores no million-entry map (this test used to pin 1,048,576 entries,
/// the shape Excel never writes).
#[test]
fn select_all_row_height_sets_the_sheets_standard_in_one_undo_step() {
    let fx = Fx::new();
    let seed = crate::document_effect::test_seed_effect();
    fx.state.row_heights.write(&seed).unwrap().insert(5, 50.0);
    let before = fx.heights();
    let depth = fx.undo_depth();

    let changed = set_line_sizes_inner(&fx.state, &fx.file, true, &[(0, LAST_ROW)], 30.0).expect("resize");
    assert_eq!(changed, LAST_ROW as u64 + 1, "every row's height changed");
    assert!(fx.heights().is_empty(), "no row keeps a height of its own: {:?}", fx.heights().len());
    assert_eq!(fx.standard().default_row_height, 30.0, "the sheet's standard row height");
    assert_eq!(fx.state.grids.read().unwrap()[0].default_row_height, Some(30.0), "the sheet itself, not only the mirror");
    assert_eq!(fx.standard().default_column_width, ::persistence::DEFAULT_COLUMN_WIDTH_PX, "columns untouched");
    assert!(fx.file.is_dirty(), "a resize dirties the document");
    assert_eq!(fx.undo_depth(), depth + 1, "ONE undo step");

    fx.undo();
    assert_eq!(fx.heights(), before, "undo restores the rows' own heights exactly");
    assert_eq!(fx.standard().default_row_height, ::persistence::DEFAULT_ROW_HEIGHT_PX, "and the standard");
    fx.redo();
    assert!(fx.heights().is_empty());
    assert_eq!(fx.standard().default_row_height, 30.0, "redo sets the standard again");
}

/// Select All + Column Width likewise sets the sheet's standard width and drops
/// every column's own (live Excel: `defaultColWidth`, no `<cols>`).
#[test]
fn select_all_column_width_sets_the_sheets_standard_width() {
    let fx = Fx::new();
    let seed = crate::document_effect::test_seed_effect();
    fx.state.column_widths.write(&seed).unwrap().insert(2, 175.0);
    set_line_sizes_inner(&fx.state, &fx.file, false, &[(0, engine::EXCEL_MAX_COL_INDEX)], 145.0).expect("resize");
    assert!(fx.widths().is_empty());
    assert_eq!(fx.standard().default_column_width, 145.0);
    fx.undo();
    assert_eq!(fx.widths().get(&2), Some(&175.0));
    assert_eq!(fx.standard().default_column_width, ::persistence::DEFAULT_COLUMN_WIDTH_PX);
}

/// BUG-0352: the standard column width is PER SHEET (live Excel: Format >
/// Default Width 12 on Sheet2 left Sheet1 and Sheet3 at 8.47), a NEW sheet
/// starts at the application standard rather than the active sheet's, and an
/// undo after a sheet switch puts the size back on the sheet it was set on.
#[test]
fn the_standard_width_is_per_sheet_and_its_undo_follows_its_sheet() {
    let fx = Fx::new();
    crate::sheets::add_sheet_inner(&fx.state, &fx.file, None, ::persistence::SheetKind::Worksheet).expect("add");
    crate::sheets::activate_sheet(&fx.state, 0).expect("back to Sheet1");

    set_default_column_width_inner(&fx.state, &fx.file, 120.0).expect("Default Width");
    set_default_row_height_inner(&fx.state, &fx.file, 33.0).expect("standard height");
    assert_eq!(fx.standard(), DefaultDimensions { default_row_height: 33.0, default_column_width: 120.0 });

    crate::sheets::activate_sheet(&fx.state, 1).expect("to Sheet2");
    assert_eq!(
        fx.standard(),
        DefaultDimensions {
            default_row_height: ::persistence::DEFAULT_ROW_HEIGHT_PX,
            default_column_width: ::persistence::DEFAULT_COLUMN_WIDTH_PX,
        },
        "Sheet2 keeps its own standard: Sheet1's change must not reach it"
    );

    // Undo the row height while Sheet2 is showing: it lands on Sheet1.
    fx.undo();
    assert_eq!(fx.standard().default_row_height, ::persistence::DEFAULT_ROW_HEIGHT_PX, "Sheet2 untouched by the undo");
    assert_eq!(fx.state.grids.read().unwrap()[0].default_row_height, None, "Sheet1's standard height is back");
    assert_eq!(fx.state.grids.read().unwrap()[0].default_column_width, Some(120.0));
    crate::sheets::activate_sheet(&fx.state, 0).expect("to Sheet1");
    assert_eq!(fx.standard(), DefaultDimensions { default_row_height: ::persistence::DEFAULT_ROW_HEIGHT_PX, default_column_width: 120.0 });

    // A sheet added now starts at the application standard, as in Excel.
    crate::sheets::add_sheet_inner(&fx.state, &fx.file, None, ::persistence::SheetKind::Worksheet).expect("add");
    assert_eq!(fx.standard().default_column_width, ::persistence::DEFAULT_COLUMN_WIDTH_PX, "the new sheet");
}

/// The per-sheet standard reaches the saved workbook (and a loaded sheet's
/// grid), per sheet.
#[test]
fn the_per_sheet_standard_reaches_the_saved_workbook() {
    let fx = Fx::new();
    crate::sheets::add_sheet_inner(&fx.state, &fx.file, None, ::persistence::SheetKind::Worksheet).expect("add");
    // Sheet2 is active: give IT the standard, so the save must read the mirror.
    set_default_row_height_inner(&fx.state, &fx.file, 41.0).expect("standard height");
    let (workbook, _) = crate::persistence::build_workbook_for_save(
        &fx.state,
        &fx.files,
        &crate::bi::types::BiState::new(),
        crate::persistence::ChartKeysFor::Document,
    )
    .expect("save snapshot");
    assert_eq!(workbook.sheets[0].default_row_height, None);
    assert_eq!(workbook.sheets[1].default_row_height, Some(41.0));
    let (grid, _) = workbook.sheets[1].to_grid();
    assert_eq!(grid.default_row_height, Some(41.0), "a loaded sheet's grid carries it");
}

/// A height or width GIVEN to hidden lines shows them, as in Excel ([LIVE]
/// Excel 16: row 5 and column D hidden, Select All + Row Height 30 and Select
/// All + Column Width 20 unhide both; Rows 3:7 + Row Height 30 and Columns C:E
/// + Column Width 20 do too). It is the SAME undo step: one Ctrl+Z hides them
/// again and puts the sizes back. Lines outside the runs stay hidden, and a
/// reset (`size <= 0`) is not a size given, so it unhides nothing.
#[test]
fn a_size_given_to_hidden_lines_unhides_them_in_the_same_undo_step() {
    let fx = Fx::new();
    let hidden_rows = |fx: &Fx| {
        let mut v: Vec<u32> = fx.state.user_hidden_rows.read().unwrap().iter().copied().collect();
        v.sort_unstable();
        v
    };
    let hidden_cols = |fx: &Fx| {
        let mut v: Vec<u32> = fx.state.user_hidden_cols.read().unwrap().iter().copied().collect();
        v.sort_unstable();
        v
    };
    set_rows_hidden_inner(&fx.state, &fx.file, &[4, 20], true).expect("hide rows 5 and 21");
    set_cols_hidden_inner(&fx.state, &fx.file, &[3], true).expect("hide column D");
    let depth = fx.undo_depth();

    // Select All + Row Height: every hidden row shows.
    let outcome = set_line_sizes_core(&fx.state, &fx.file, true, &[(0, LAST_ROW)], 40.0).expect("resize");
    assert!(outcome.unhid, "the resize must report that it unhid rows");
    assert_eq!(
        hidden_rows(&fx),
        Vec::<u32>::new(),
        "Select All + Row Height left hidden rows hidden; Excel unhides them"
    );
    assert_eq!(hidden_cols(&fx), vec![3], "a row resize does not touch the columns");
    assert_eq!(fx.undo_depth(), depth + 1, "ONE undo step for the size and the unhide");
    fx.undo();
    assert_eq!(hidden_rows(&fx), vec![4, 20], "one Ctrl+Z hides the rows again");
    assert_eq!(fx.standard().default_row_height, ::persistence::DEFAULT_ROW_HEIGHT_PX, "and puts the standard back");
    fx.redo();
    assert_eq!(hidden_rows(&fx), Vec::<u32>::new(), "redo shows them again");
    fx.undo();

    // A partial run unhides only the hidden lines inside it.
    set_line_sizes_inner(&fx.state, &fx.file, true, &[(2, 6)], 40.0).expect("rows 3:7");
    assert_eq!(hidden_rows(&fx), vec![20], "rows 3:7 + Row Height unhides row 5 only");

    // Columns C:E + Column Width unhides D, even when D already has that width.
    let seed = crate::document_effect::test_seed_effect();
    for c in 2..=4u32 {
        fx.state.column_widths.write(&seed).unwrap().insert(c, 145.0);
    }
    let outcome = set_line_sizes_core(&fx.state, &fx.file, false, &[(2, 4)], 145.0).expect("columns C:E");
    assert_eq!(
        outcome,
        LineSizesOutcome { changed: 1, unhid: true, outline_changed: false, filter_changed: false, reached: vec![(2, 4)] },
        "a width that changes nothing still unhides"
    );
    assert_eq!(hidden_cols(&fx), Vec::<u32>::new());

    // A reset is not a size given: the hidden row stays hidden.
    set_line_sizes_inner(&fx.state, &fx.file, true, &[(20, 20)], 0.0).expect("reset");
    assert_eq!(hidden_rows(&fx), vec![20], "a reset to the standard does not unhide");
}

/// A Select All resize on a protected sheet is refused like any other.
#[test]
fn select_all_on_a_protected_sheet_changes_nothing() {
    let fx = Fx::new();
    fx.protect();
    assert!(set_line_sizes_inner(&fx.state, &fx.file, true, &[(0, LAST_ROW)], 30.0).is_err());
    assert_eq!(fx.standard().default_row_height, ::persistence::DEFAULT_ROW_HEIGHT_PX);
    assert!(!fx.file.is_dirty());
}

/// rev8B (round 9): the record of a resize must be atomic with its write. Two
/// resizes of the same column, the first parked on the undo stack (this
/// thread plays a cell writer mid-step, holding it): the second must NOT be
/// able to write the column until the first has recorded its step. If it can,
/// the steps are recorded in swapped order and two Ctrl+Z put back the
/// ORIGINAL width first and the intermediate one last.
///
/// SABOTAGE: drop the `grid` hold in `set_column_width_inner` -- the second
/// resize writes 20 while the first waits, and the test fails at
/// "SWAPPED-ORDER SHAPE".
#[test]
fn concurrent_resizes_of_one_column_record_their_steps_in_the_order_they_wrote() {
    use std::sync::Arc;
    use std::time::{Duration, Instant};
    let state = Arc::new(crate::create_app_state());
    let file = Arc::new(FileState::default());
    let width_now = |state: &Arc<AppState>| state.column_widths.read().unwrap().get(&3).copied();

    let held = state.undo_stack.lock().unwrap();
    let first = {
        let (state, file) = (Arc::clone(&state), Arc::clone(&file));
        std::thread::spawn(move || set_column_width_inner(&state, &file, 3, 10.0))
    };
    let deadline = Instant::now() + Duration::from_secs(5);
    while width_now(&state) != Some(10.0) {
        assert!(Instant::now() < deadline, "PRECONDITION FAILED: the first resize never wrote its width");
        std::thread::sleep(Duration::from_millis(5));
    }
    assert!(!first.is_finished(), "PRECONDITION FAILED: the first resize did not wait for the undo stack");
    let second = {
        let (state, file) = (Arc::clone(&state), Arc::clone(&file));
        std::thread::spawn(move || set_column_width_inner(&state, &file, 3, 20.0))
    };
    std::thread::sleep(Duration::from_millis(300));
    let seen = width_now(&state);
    drop(held);
    assert_eq!(first.join().unwrap(), Ok(()));
    assert_eq!(second.join().unwrap(), Ok(()));
    assert_eq!(
        seen,
        Some(10.0),
        "SWAPPED-ORDER SHAPE: a second resize wrote the column while the first was still waiting to record its \
         step, so the undo history can hold the two steps in the opposite order to the writes"
    );

    // And the history unwinds in order: 20 -> 10 -> no width of its own.
    let undo = |state: &Arc<AppState>| {
        let t = state.undo_stack.lock().unwrap().pop_undo().expect("nothing to undo");
        crate::undo_commands::apply_changes(
            state, &file, &UserFilesState::default(), &PivotState::new(), &SlicerState::new(),
            &RibbonFilterState::new(), &PaneControlState::new(), &TimelineSlicerState::new(), t, true,
        );
    };
    assert_eq!(width_now(&state), Some(20.0));
    undo(&state);
    assert_eq!(width_now(&state), Some(10.0), "the first Ctrl+Z puts back the intermediate width");
    undo(&state);
    assert_eq!(width_now(&state), None, "the second puts back the original");
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
    let before = fx.standard();
    fx.protect();
    assert!(set_default_column_width_inner(&fx.state, &fx.file, 120.0).is_err());
    assert!(set_default_row_height_inner(&fx.state, &fx.file, 30.0).is_err());
    assert_eq!(fx.standard(), before);
    assert!(!fx.file.is_dirty(), "a refusal leaves the document clean");

    // Control: unprotected, both apply.
    let fx = Fx::new();
    assert_eq!(set_default_column_width_inner(&fx.state, &fx.file, 120.0).map(|d| d.default_column_width), Ok(120.0));
    assert_eq!(set_default_row_height_inner(&fx.state, &fx.file, 30.0).map(|d| d.default_row_height), Ok(30.0));
    assert!(fx.file.is_dirty());
}

// ===========================================================================
// ROUND 14 (rev12B): EACH KIND OF HIDDEN LINE, as live Excel 16 does it
// ===========================================================================

fn sorted(set: &HashSet<u32>) -> Vec<u32> {
    let mut v: Vec<u32> = set.iter().copied().collect();
    v.sort_unstable();
    v
}

fn user_rows(fx: &Fx) -> Vec<u32> {
    sorted(&fx.state.user_hidden_rows.read().unwrap())
}

fn user_cols(fx: &Fx) -> Vec<u32> {
    sorted(&fx.state.user_hidden_cols.read().unwrap())
}

/// An AutoFilter over A1:A10 on the active sheet that filters out row 3
/// (index 2); `criterion: false` gives the dropdowns with no criterion.
fn filter_rows_1_to_10(fx: &Fx, criterion: bool) {
    let seed = crate::document_effect::test_seed_effect();
    let mut af = crate::autofilter::AutoFilter::new(0, 0, 9, 0);
    if criterion {
        af.column_filters.insert(
            0,
            crate::autofilter::ColumnFilter { column_index: 0, criteria: crate::autofilter::FilterCriteria::default() },
        );
        af.hidden_rows.insert(2);
    }
    fx.state.auto_filters.write(&seed).unwrap().insert(0, af);
}

fn hide_rows_by_hand(fx: &Fx, rows: &[u32]) {
    let seed = crate::document_effect::test_seed_effect();
    fx.state.user_hidden_rows.write(&seed).unwrap().extend(rows.iter().copied());
}

/// One collapsed row group `start..=end` (its summary row is `end`, below).
fn collapsed_row_group(fx: &Fx, start: u32, end: u32) {
    let seed = crate::document_effect::test_seed_effect();
    let mut outline = crate::grouping::SheetOutline::new();
    let mut g = crate::grouping::RowGroup::new(start, end, 1);
    g.collapsed = true;
    outline.row_groups.push(g);
    outline.max_row_level = 1;
    fx.state.outlines.write(&seed).unwrap().insert(0, outline);
}

fn outline_hidden_rows(fx: &Fx) -> Vec<u32> {
    sorted(&fx.state.outlines.read().unwrap().get(&0).map(|o| o.get_hidden_rows()).unwrap_or_default())
}

/// rev12B finding 1, [LIVE] Excel 16 (round 14 probe): under an APPLIED
/// AutoFilter, Rows(18:22).RowHeight = 30 with row 20 hidden by hand leaves
/// row 20 hidden at its old height and sizes the visible rows only; Select All
/// + Row Height changes the standard but no hidden row is shown, and a
/// filtered-out row comes back at its OLD height. One undo step each.
///
/// SABOTAGE: drop the filter-mode early return in `plan_line_visibility` --
/// fails at "UNDER A FILTER".
#[test]
fn under_an_applied_filter_a_batch_row_height_sizes_only_the_visible_rows() {
    let fx = Fx::new();
    filter_rows_1_to_10(&fx, true);
    hide_rows_by_hand(&fx, &[19]);
    let depth = fx.undo_depth();

    let outcome = set_line_sizes_core(&fx.state, &fx.file, true, &[(17, 21)], 40.0).expect("rows 18:22");
    assert_eq!(user_rows(&fx), vec![19], "UNDER A FILTER: Excel leaves the hand-hidden row 20 hidden");
    assert!(!outcome.unhid);
    assert_eq!(outcome.reached, vec![(17, 18), (20, 21)], "the height reaches the visible rows only");
    let h = fx.heights();
    assert_eq!(h.get(&19), None, "row 20 keeps its old height");
    assert_eq!((h.get(&17), h.get(&18), h.get(&20), h.get(&21)), (Some(&40.0), Some(&40.0), Some(&40.0), Some(&40.0)));
    assert_eq!(fx.undo_depth(), depth + 1, "one undo step");

    // Select All under the filter: the standard changes, no hidden row shows,
    // and the hidden rows keep the height they had (the old standard).
    let old_standard = fx.standard().default_row_height;
    let outcome = set_line_sizes_core(&fx.state, &fx.file, true, &[(0, LAST_ROW)], 50.0).expect("Select All");
    assert!(!outcome.unhid);
    assert_eq!(user_rows(&fx), vec![19], "UNDER A FILTER: Select All showed a hand-hidden row");
    assert_eq!(fx.standard().default_row_height, 50.0);
    let h = fx.heights();
    assert_eq!(h.get(&19), Some(&old_standard), "the hand-hidden row is pinned at its old height");
    assert_eq!(h.get(&2), Some(&old_standard), "the filtered-out row is pinned at its old height");
    assert_eq!(h.len(), 2, "every visible row follows the new standard: {:?}", h);
    assert!(fx.state.auto_filters.read().unwrap()[&0].hidden_rows.contains(&2), "the filter still hides row 3");

    fx.undo();
    assert_eq!(fx.standard().default_row_height, old_standard);
    let h = fx.heights();
    assert_eq!((h.get(&19), h.get(&2), h.get(&17)), (None, None, Some(&40.0)), "one Ctrl+Z puts every height back");
}

/// [LIVE] Excel 16: under a filter, a resize whose runs hold NO visible row
/// sizes and shows them (Rows(20:20) with row 20 hidden by hand) -- the
/// FILTERED-OUT rows included (Rows(3:4), Rows(20:20) on a filtered-out row;
/// round-14 dims3 probes). The filter keeps its criterion; the row leaves its
/// hidden set, in the same one undo step as the height.
///
/// SABOTAGE: never set `show_filtered` in `plan_line_visibility` -- fails at
/// "FILTERED-OUT".
#[test]
fn under_a_filter_a_resize_of_only_hidden_rows_shows_them() {
    let fx = Fx::new();
    filter_rows_1_to_10(&fx, true);
    hide_rows_by_hand(&fx, &[19]);
    let outcome = set_line_sizes_core(&fx.state, &fx.file, true, &[(19, 19)], 40.0).expect("row 20");
    assert!(outcome.unhid);
    assert!(!outcome.filter_changed, "row 20 was hidden by hand, not by the filter");
    assert_eq!(user_rows(&fx), Vec::<u32>::new(), "Rows(20:20).RowHeight shows row 20 even under a filter");
    assert_eq!(fx.heights().get(&19), Some(&40.0));

    let depth = fx.undo_depth();
    let outcome = set_line_sizes_core(&fx.state, &fx.file, true, &[(2, 2)], 45.0).expect("row 3");
    assert_eq!(outcome.reached, vec![(2, 2)]);
    assert_eq!(fx.heights().get(&2), Some(&45.0));
    assert!(outcome.unhid && outcome.filter_changed, "the filter's hidden set changed: {outcome:?}");
    {
        let afs = fx.state.auto_filters.read().unwrap();
        assert!(
            !afs[&0].hidden_rows.contains(&2),
            "FILTERED-OUT: Excel shows a filtered-out row a resize of only hidden rows reaches"
        );
        assert!(afs[&0].is_data_filtered(), "the filter keeps its criterion");
    }
    assert_eq!(fx.undo_depth(), depth + 1, "one undo step");

    fx.undo();
    assert!(
        fx.state.auto_filters.read().unwrap()[&0].hidden_rows.contains(&2),
        "one Ctrl+Z hides the filtered-out row again"
    );
    assert_eq!(fx.heights().get(&2), None, "and puts its height back");
}

/// misc6 (misc5-verify-5), [LIVE] Excel 16 2026-11-06 (misc6/probe.ps1): an
/// ADVANCED filter in place hiding row 4 -- Rows(4:4).RowHeight = 30 shows
/// row 4 (FilterMode stays True), while Rows(3:5).RowHeight = 30 leaves it
/// hidden. A whole-row move writes its vacated hidden rows as exactly that
/// hidden-only resize (`lineMoveVacated.ts` `lineSizeWrites`), and Excel's
/// `Range("3:5").Cut Range("A20")` shows row 4 at its old place. The row
/// leaves the filter's set in the same one undo step; Ctrl+Z hides it again
/// and Ctrl+Y shows it again.
///
/// SABOTAGE: never take a row out of the advanced filter's set in
/// `set_line_sizes_core` -- fails at "ADVANCED-FILTERED".
#[test]
fn under_an_advanced_filter_a_resize_of_only_hidden_rows_shows_them() {
    let fx = Fx::new();
    let seed = crate::document_effect::test_seed_effect();
    fx.state.advanced_filter_hidden_rows.write(&seed).unwrap().insert(0, vec![3, 8]);
    let adv = |fx: &Fx| fx.state.advanced_filter_hidden_rows.read().unwrap().get(&0).cloned();

    // Rows 3:5 hold visible rows: filter mode sizes those only.
    let outcome = set_line_sizes_core(&fx.state, &fx.file, true, &[(2, 4)], 30.0).expect("rows 3:5");
    assert_eq!(outcome.reached, vec![(2, 2), (4, 4)], "the visible rows only");
    assert!(!outcome.unhid && !outcome.filter_changed);
    assert_eq!(adv(&fx), Some(vec![3, 8]), "Rows(3:5) leaves the advanced-filtered row 4 hidden");

    let depth = fx.undo_depth();
    let outcome = set_line_sizes_core(&fx.state, &fx.file, true, &[(3, 3)], 30.0).expect("row 4");
    assert_eq!(outcome.reached, vec![(3, 3)]);
    assert!(outcome.unhid && outcome.filter_changed, "the advanced filter's set changed: {outcome:?}");
    assert_eq!(
        adv(&fx),
        Some(vec![8]),
        "ADVANCED-FILTERED: Excel shows an advanced-filtered row a resize of only hidden rows reaches"
    );
    assert_eq!(fx.heights().get(&3), Some(&30.0));
    assert_eq!(fx.undo_depth(), depth + 1, "one undo step");

    fx.undo();
    assert_eq!(adv(&fx), Some(vec![3, 8]), "one Ctrl+Z hides row 4 again");
    assert_eq!(fx.heights().get(&3), None, "and puts its height back");
    fx.redo();
    assert_eq!(adv(&fx), Some(vec![8]), "Ctrl+Y shows it again");
}

/// rev15C: THE SAME RESIZE'S UNDO RE-HIDES THE FILTERED-OUT ROW, AND THE
/// TOTALS THAT READ VISIBILITY FOLLOW IT -- as the filter itself recalculates
/// SUBTOTAL/AGGREGATE when it hides. The `obj_autofilter` restore announced no
/// visibility change, so `recalc_visibility_after_undo` skipped its pass and
/// `=SUBTOTAL(109,A1:A10)` kept counting the row Ctrl+Z had hidden again.
/// Excel: SUBTOTAL(109) skips every hidden row whatever hid it, and an
/// undo is a recalculation input like any edit.
///
/// SABOTAGE: give the `obj_autofilter` registry row `NONE` again -- fails at
/// "THE TOTAL".
#[test]
fn undoing_a_resize_that_showed_a_filtered_out_row_recalculates_subtotal() {
    let fx = Fx::new();
    let put = |row: u32, col: u32, value: &str| {
        crate::commands::data::update_cell_impl(
            &fx.state, &fx.file, &fx.files, &fx.slicer, &fx.pivots, &fx.pane, &fx.filters,
            row, col, value.to_string(), None, None, None,
        )
        .unwrap_or_else(|e| panic!("update_cell({row},{col}) failed: {e}"));
    };
    for r in 0..10u32 {
        put(r, 0, &((r + 1) * 10).to_string()); // A1..A10 = 10, 20, .., 100
    }
    put(11, 1, "=SUBTOTAL(109;A1:A10)"); // B12 (the harness's app locale separates with ';', as d8's tests do)
    filter_rows_1_to_10(&fx, true); // the filter hides row 3 (30)
    let recalc = || {
        crate::calculation::recalc_visibility_dependents_core(
            &fx.state, &fx.files, &fx.pivots, Some((&fx.pane, &fx.filters)),
        )
        .expect("the visibility pass");
    };
    let total = || match fx.state.grid.read().unwrap().get_cell(11, 1).map(|c| c.value.clone()) {
        Some(engine::CellValue::Number(n)) => n,
        other => panic!("B12 is {other:?}"),
    };
    recalc();
    assert_eq!(total(), 520.0, "the premise: SUBTOTAL(109) skips the filtered-out 30");

    // The forward resize shows row 3 and its command recalculates.
    let outcome = set_line_sizes_core(&fx.state, &fx.file, true, &[(2, 2)], 45.0).expect("row 3");
    assert!(outcome.filter_changed);
    recalc();
    assert_eq!(total(), 550.0, "the shown row counts again");

    // Ctrl+Z, and the follow-up the undo command runs on its result.
    let t = fx.state.undo_stack.lock().unwrap().pop_undo().expect("the resize's step");
    let result = crate::undo_commands::apply_changes(
        &fx.state, &fx.file, &fx.files, &fx.pivots, &fx.slicer, &fx.filters, &fx.pane, &fx.timeline, t, true,
    );
    assert!(fx.state.auto_filters.read().unwrap()[&0].hidden_rows.contains(&2), "Ctrl+Z re-hid row 3");
    crate::undo_commands::recalc_visibility_after_undo_core(
        &fx.state, &fx.files, &fx.pivots, &fx.pane, &fx.filters, &result,
    );
    assert_eq!(
        total(),
        520.0,
        "THE TOTAL: Ctrl+Z re-hid the filtered-out row and SUBTOTAL(109) kept counting it"
    );
    assert!(result.hidden_changed, "the frontend is told to re-read the hidden rows");
}

/// [LIVE] Excel 16: AutoFilter dropdowns with NO criterion are not filter
/// mode (FilterMode False) -- the resize shows the hand-hidden row as usual.
/// Columns have no filter mode: a width under an applied filter still shows a
/// hidden column.
#[test]
fn dropdowns_without_a_criterion_and_columns_are_not_filter_mode() {
    let fx = Fx::new();
    filter_rows_1_to_10(&fx, false);
    hide_rows_by_hand(&fx, &[19]);
    set_line_sizes_core(&fx.state, &fx.file, true, &[(17, 21)], 40.0).expect("rows 18:22");
    assert_eq!(user_rows(&fx), Vec::<u32>::new());

    let fx = Fx::new();
    filter_rows_1_to_10(&fx, true);
    set_cols_hidden_inner(&fx.state, &fx.file, &[4], true).expect("hide E");
    set_line_sizes_core(&fx.state, &fx.file, false, &[(0, 7)], 120.0).expect("A:H");
    assert_eq!(user_cols(&fx), Vec::<u32>::new(), "Columns(A:H).ColumnWidth shows E under a filter");
}

/// rev12B finding 2, [LIVE] Excel 16: rows 13:15 grouped and collapsed,
/// Rows(1:25).RowHeight = 30 shows them all (the group reads expanded), in the
/// same one undo step; a resize of PART of the group shows only the rows it
/// covers (Rows(14).RowHeight: 13 and 15 stay hidden, the group reads
/// expanded) -- here the group expands and the rest stay hidden by hand.
///
/// SABOTAGE: skip the outline expansion in `plan_line_visibility` -- fails at
/// "OUTLINE".
#[test]
fn a_batch_resize_shows_rows_in_a_collapsed_outline_group() {
    let fx = Fx::new();
    // Rows 13:15 are the detail (indices 12..=14); row 16 (index 15) is the summary.
    collapsed_row_group(&fx, 12, 15);
    assert_eq!(outline_hidden_rows(&fx), vec![12, 13, 14]);
    let depth = fx.undo_depth();

    let outcome = set_line_sizes_core(&fx.state, &fx.file, true, &[(0, 24)], 40.0).expect("rows 1:25");
    assert!(outcome.unhid && outcome.outline_changed);
    assert_eq!(outline_hidden_rows(&fx), Vec::<u32>::new(), "OUTLINE: Excel shows the collapsed group's rows");
    assert_eq!(user_rows(&fx), Vec::<u32>::new());
    assert!(!fx.state.outlines.read().unwrap()[&0].row_groups[0].collapsed, "the group reads expanded");
    assert_eq!(fx.undo_depth(), depth + 1, "ONE undo step for the sizes and the outline");
    fx.undo();
    assert_eq!(outline_hidden_rows(&fx), vec![12, 13, 14], "one Ctrl+Z collapses the group again");
    assert_eq!(fx.heights().get(&13), None);
    fx.redo();
    assert_eq!(outline_hidden_rows(&fx), Vec::<u32>::new());
    fx.undo();

    // Part of the group: only row 14 (index 13) shows.
    let outcome = set_line_sizes_core(&fx.state, &fx.file, true, &[(13, 13)], 40.0).expect("row 14");
    assert!(outcome.unhid && outcome.outline_changed);
    assert_eq!(outline_hidden_rows(&fx), Vec::<u32>::new());
    assert_eq!(user_rows(&fx), vec![12, 14], "OUTLINE: rows 13 and 15 stay hidden, row 14 shows");
    fx.undo();
    assert_eq!(outline_hidden_rows(&fx), vec![12, 13, 14], "undo collapses the group again");
    assert_eq!(user_rows(&fx), Vec::<u32>::new(), "and drops the hand-hides it stood in for");

    // Under an applied filter with a visible row in the runs, the outline
    // stays collapsed too ([LIVE] rows 23:25 collapsed, Rows(1:30) = 32).
    filter_rows_1_to_10(&fx, true);
    let outcome = set_line_sizes_core(&fx.state, &fx.file, true, &[(0, 24)], 40.0).expect("rows 1:25 filtered");
    assert!(!outcome.outline_changed);
    assert_eq!(outline_hidden_rows(&fx), vec![12, 13, 14]);
}

/// [LIVE] Excel 16: columns C:D grouped and collapsed, Cells.ColumnWidth = 20
/// (and Columns(A:F).ColumnWidth) shows them.
#[test]
fn a_batch_width_shows_columns_in_a_collapsed_outline_group() {
    let fx = Fx::new();
    let seed = crate::document_effect::test_seed_effect();
    let mut outline = crate::grouping::SheetOutline::new();
    let mut g = crate::grouping::ColumnGroup::new(2, 4, 1);
    g.collapsed = true;
    outline.column_groups.push(g);
    outline.max_col_level = 1;
    fx.state.outlines.write(&seed).unwrap().insert(0, outline);
    let hidden = |fx: &Fx| sorted(&fx.state.outlines.read().unwrap()[&0].get_hidden_cols());
    assert_eq!(hidden(&fx), vec![2, 3]);

    let outcome =
        set_line_sizes_core(&fx.state, &fx.file, false, &[(0, engine::EXCEL_MAX_COL_INDEX)], 140.0).expect("Select All");
    assert!(outcome.outline_changed);
    assert_eq!(hidden(&fx), Vec::<u32>::new(), "OUTLINE: Select All + Column Width shows the collapsed columns");
    fx.undo();
    assert_eq!(hidden(&fx), vec![2, 3]);
}

/// rev12B nit: the unhide decision read the hidden set BEFORE the size lock and
/// wrote it after, so an Unhide landing in between made a resize that changed
/// nothing dirty the document and record a step that restores nothing. The
/// decision is now taken under the locks it writes through.
///
/// Row 5 is hidden and already 40px; this thread holds the size store while
/// the resize (to 40) starts, then unhides row 5 the way an Unhide would and
/// lets go. The resize must find nothing to do.
///
/// SABOTAGE: read the hidden set before `store.lock_pending()` again -- fails
/// at "STALE COUNT".
#[test]
fn an_unhide_racing_a_resize_cannot_make_it_record_a_no_op() {
    use std::sync::Arc;
    use std::time::Duration;
    let state = Arc::new(crate::create_app_state());
    let file = Arc::new(FileState::default());
    let seed = crate::document_effect::test_seed_effect();
    state.user_hidden_rows.write(&seed).unwrap().insert(4);
    state.row_heights.write(&seed).unwrap().insert(4, 40.0);
    let depth = state.undo_stack.lock().unwrap().undo_depth();

    let held = state.row_heights.write(&seed).unwrap();
    let resize = {
        let (state, file) = (Arc::clone(&state), Arc::clone(&file));
        std::thread::spawn(move || set_line_sizes_core(&state, &file, true, &[(4, 4)], 40.0))
    };
    std::thread::sleep(Duration::from_millis(300));
    assert!(!resize.is_finished(), "PRECONDITION FAILED: the resize did not wait for the size store");
    state.user_hidden_rows.write(&seed).unwrap().remove(&4);
    drop(held);
    let outcome = resize.join().unwrap().expect("resize");
    assert_eq!(outcome.changed, 0, "STALE COUNT: the resize acted on a hide that an Unhide had already undone");
    assert!(!file.is_dirty(), "STALE COUNT: a resize that changed nothing dirtied the document");
    assert_eq!(state.undo_stack.lock().unwrap().undo_depth(), depth, "and recorded no step");
}

#[test]
fn runs_without_skips_the_given_lines() {
    assert_eq!(runs_without(&[(0, 9)], &[]), vec![(0, 9)]);
    assert_eq!(runs_without(&[(0, 9)], &[0, 4, 5, 9]), vec![(1, 3), (6, 8)]);
    assert_eq!(runs_without(&[(2, 3), (7, 8)], &[1, 3, 7, 8]), vec![(2, 2)]);
}

/// rev14C (round 16), [LIVE] Excel 16 (misc16/probe-outline.ps1): rows 13:15
/// grouped and collapsed, Rows(14).RowHeight = 30 shows row 14 alone; the
/// group then collapsed and expanded again shows 13, 14 AND 15. Calcula's
/// resize keeps 13 and 15 hidden by hand, and its expand only flipped
/// `collapsed`, so they never came back. An expand now shows the hand-hidden
/// lines of the detail it shows, in ONE undo step with the outline.
///
/// SABOTAGE: return early from `grouping::show_hand_hidden_in_details` --
/// fails at "RE-EXPAND".
#[test]
fn a_partly_resized_collapsed_group_shows_every_row_when_expanded_again() {
    let fx = Fx::new();
    collapsed_row_group(&fx, 12, 15);
    hide_rows_by_hand(&fx, &[20]); // a hand-hide OUTSIDE the group: a control
    set_line_sizes_core(&fx.state, &fx.file, true, &[(13, 13)], 40.0).expect("row 14");
    assert_eq!(user_rows(&fx), vec![12, 14, 20], "PRECONDITION: rows 13 and 15 are kept hidden");

    let collapsed = crate::grouping::collapse_row_group_inner(&fx.state, &fx.file, 15);
    assert!(collapsed.success, "{:?}", collapsed.error);
    let depth = fx.undo_depth();
    let expanded = crate::grouping::expand_row_group_core(&fx.state, &fx.file, 15);
    assert!(expanded.success, "{:?}", expanded.error);
    assert_eq!(outline_hidden_rows(&fx), Vec::<u32>::new());
    assert_eq!(user_rows(&fx), vec![20], "RE-EXPAND: Excel shows rows 13, 14 and 15 (the hand-hide on row 21 stays)");
    assert_eq!(expanded.hidden_rows_changed, vec![12, 13, 14], "the rows the expand showed, hand-hidden ones included");
    assert_eq!(fx.undo_depth(), depth + 1, "ONE undo step for the outline and the hand-hides");

    fx.undo();
    assert_eq!(outline_hidden_rows(&fx), vec![12, 13, 14], "one Ctrl+Z collapses the group again");
    assert_eq!(user_rows(&fx), vec![12, 14, 20], "and puts the hand-hides back");
    fx.redo();
    assert_eq!(user_rows(&fx), vec![20]);
}

/// [LIVE] Excel 16 (misc16/probe-outline.ps1): a row hidden BY HAND inside an
/// expanded group comes back when the group is collapsed and expanded, and
/// when ShowLevels shows its level; a hand-hide in a group that stays
/// collapsed stays hidden.
#[test]
fn expand_and_show_level_show_hand_hidden_detail_rows_as_excel_does() {
    let fx = Fx::new();
    collapsed_row_group(&fx, 12, 15);
    let seed = crate::document_effect::test_seed_effect();
    fx.state.outlines.write(&seed).unwrap().get_mut(&0).unwrap().row_groups[0].collapsed = false;
    hide_rows_by_hand(&fx, &[13]);

    // Collapse, then expand: row 14 (index 13) is shown.
    assert!(crate::grouping::collapse_row_group_inner(&fx.state, &fx.file, 15).success);
    assert!(crate::grouping::expand_row_group_core(&fx.state, &fx.file, 15).success);
    assert_eq!(user_rows(&fx), Vec::<u32>::new(), "collapse + expand shows a hand-hidden detail row");

    // ShowLevels over an expanded group: shown too.
    hide_rows_by_hand(&fx, &[13]);
    let shown = crate::grouping::show_outline_level_core(&fx.state, &fx.file, Some(1), None);
    assert!(shown.success, "{:?}", shown.error);
    assert_eq!(user_rows(&fx), Vec::<u32>::new(), "ShowLevels shows a hand-hidden detail row");
    fx.undo();
    assert_eq!(user_rows(&fx), vec![13], "Ctrl+Z hides it again");

    // A level that leaves the group COLLAPSED shows nothing by hand.
    let shown = crate::grouping::show_outline_level_core(&fx.state, &fx.file, Some(0), None);
    assert!(shown.success, "{:?}", shown.error);
    assert_eq!(user_rows(&fx), vec![13], "a collapsed group's hand-hidden row stays hidden");
}

/// rev14C nit (round 16): `plan_line_visibility` scanned every run for every
/// hidden line (O(hidden x runs)). It now answers "is this line in the runs?"
/// with a binary search over the sorted runs, so a filter hiding most of a
/// sheet and thousands of runs plan in well under a second.
///
/// Round 18 (rev16B nit): asserts the WORK done -- the run comparisons
/// `in_runs` counts on this thread (`IN_RUNS_COMPARISONS`) -- never a
/// wall-clock time, which a debug build on a loaded machine could push past
/// any bound. A binary search makes at most ceil(log2(runs)) + 1 comparisons
/// per hidden line; a linear scan makes up to `runs` per line.
///
/// SABOTAGE: make `in_runs` a linear scan (counting each run it looks at).
#[test]
fn plan_line_visibility_is_not_quadratic_in_hidden_lines_and_runs() {
    use super::IN_RUNS_COMPARISONS;
    let user: HashSet<u32> = HashSet::new();
    let filtered: HashSet<u32> = (0..300_000u32).filter(|r| r % 3 != 0).collect();
    // 10,000 runs of two rows each, every one holding a visible row.
    let runs: Vec<(u32, u32)> = (0..10_000u32).map(|i| (i * 6, i * 6 + 1)).collect();
    IN_RUNS_COMPARISONS.with(|n| n.set(0));
    let plan = plan_line_visibility(true, &runs, true, &user, None, true, &filtered);
    let comparisons = IN_RUNS_COMPARISONS.with(|n| n.get());
    assert_eq!(plan.skip.len(), 10_000, "one filtered row in each run is passed over");
    let per_line = u64::from(u32::BITS - (runs.len() as u32).leading_zeros()) + 1; // ceil(log2) + 1, generously
    let hidden = filtered.len() as u64;
    assert!(comparisons > 0, "PRECONDITION: the plan asked no line of the runs (the count is not wired)");
    assert!(
        comparisons <= hidden * per_line,
        "QUADRATIC: {comparisons} run comparisons for {hidden} hidden lines over {} runs (a binary search needs at most {})",
        runs.len(),
        hidden * per_line
    );
}
