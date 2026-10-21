//! FILENAME: app/src-tauri/src/commands/cell_target_content_tests.rs
//! PURPOSE: P3 S4 -- content, clear, sort, fill, the batch write, merge,
//!          search, Go To Special and conditional formatting take a CELL
//!          TARGET (a floating grid's cells).
//!
//! What is pinned here, for every command:
//!   1. the write lands on the object's BACKING sheet and NEVER on the active
//!      sheet at the same coordinates (BUG-0185's whole class);
//!   2. one gesture is ONE undo step, and Ctrl+Z restores the backing cells;
//!   3. a host formula reading the grid (`=Float1!A1`) recalculates;
//!   4. the HOST's protection gates the write, and a refusal leaves the
//!      document clean and the undo stack untouched;
//!   5. a rectangle outside the write extent refuses, naming the cell.
//!
//! A CHILD module of `commands::data` (for the shared `Workbook` harness and
//! the off-sheet bodies' plain-reference forms), like `cell_target_tests`.

use super::cross_sheet_recalc_tests::Workbook;
use crate::api_types::{
    CellTargetRef, CellUpdateInput, ClearApplyTo, ClearRangeParams, FloatingRangePatch, MergeOptions,
    MergedRegion, SortField, SortOrientation, SortRangeParams,
};
use crate::conditional_formatting::{
    AddCFParams, CellValueOperator, CellValueRule, ConditionalFormat, ConditionalFormatRange,
    ConditionalFormatRule,
};
use crate::floating_range::PatchGate;
use crate::protection::{SheetProtection, SheetProtectionOptions};
use engine::{Cell, CellStyle, CellValue};

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/// A floating range named `Float1` on the ACTIVE sheet (sheet 0), window
/// `rows` x `cols`. Returns (target, backing index).
fn float1(wb: &Workbook, rows: u32, cols: u32) -> (CellTargetRef, usize) {
    let info = crate::floating_range::create_floating_range_inner(
        &wb.state,
        &wb.file,
        Some("Float1".to_string()),
        100.0,
        50.0,
    )
    .expect("create a floating range");
    crate::floating_range::update_floating_range_inner(
        &wb.state,
        &wb.file,
        info.range.id,
        FloatingRangePatch { row_count: Some(rows), col_count: Some(cols), ..Default::default() },
        PatchGate::ObjectEdit,
    )
    .expect("size the window");
    (CellTargetRef::FloatingRange { id: info.range.id }, info.backing_sheet_index)
}

/// Type into a floating-grid cell through its own door.
fn type_in(wb: &Workbook, t: &CellTargetRef, row: u32, col: u32, value: &str) {
    let CellTargetRef::FloatingRange { id } = t;
    crate::floating_range::update_floating_range_cell_inner(
        &wb.state,
        &wb.file,
        &wb.files,
        &wb.pivots,
        &wb.pane,
        &wb.filters,
        *id,
        row,
        col,
        value.to_string(),
        None,
    )
    .unwrap_or_else(|e| panic!("type into ({row},{col}): {e}"));
}

fn backing_cell(wb: &Workbook, sheet: usize, row: u32, col: u32) -> Option<Cell> {
    wb.state.grids.read().unwrap()[sheet].get_cell(row, col).cloned()
}

fn backing_value(wb: &Workbook, sheet: usize, row: u32, col: u32) -> CellValue {
    backing_cell(wb, sheet, row, col).map(|c| c.value).unwrap_or(CellValue::Empty)
}

/// The ACTIVE sheet's mirror (what the user sees under the floating grid).
fn active_value(wb: &Workbook, row: u32, col: u32) -> CellValue {
    wb.state.grid.read().unwrap().get_cell(row, col).map(|c| c.value.clone()).unwrap_or(CellValue::Empty)
}

fn text(s: &str) -> CellValue {
    CellValue::Text(s.to_string())
}

fn depth(wb: &Workbook) -> usize {
    wb.state.undo_stack.lock().unwrap().undo_depth()
}

/// Ctrl+Z through the real restore path.
fn undo_once(wb: &Workbook) {
    let transaction = wb.state.undo_stack.lock().unwrap().pop_undo().expect("an undo step");
    crate::undo_commands::apply_changes(
        &wb.state, &wb.file, &wb.files, &wb.pivots, &wb.slicer, &wb.filters, &wb.pane, &wb.timelines, transaction, true,
    );
}

fn protect_host(wb: &Workbook, options: SheetProtectionOptions) {
    wb.state.sheet_protection.write(&crate::document_effect::test_seed_effect()).unwrap().insert(
        0,
        SheetProtection {
            protected: true,
            password_hash: None,
            password_salt: None,
            options,
            allow_edit_ranges: Vec::new(),
        },
    );
}

/// Run `refused`, which must fail, and prove it left the document clean and
/// the undo stack untouched. Returns the sentence.
fn assert_clean_refusal<T: std::fmt::Debug>(wb: &Workbook, what: &str, refused: impl FnOnce() -> Result<T, String>) -> String {
    crate::document_effect::mark_saved(&wb.file);
    let before = depth(wb);
    let err = match refused() {
        Ok(v) => panic!("{what}: must be refused, got Ok({v:?})"),
        Err(e) => e,
    };
    assert!(!wb.file.is_dirty(), "{what}: a refusal must leave the document clean");
    assert_eq!(depth(wb), before, "{what}: a refusal records no undo step");
    err
}

fn clear(wb: &Workbook, t: &CellTargetRef, rect: (u32, u32, u32, u32), apply_to: ClearApplyTo) -> Result<crate::api_types::ClearRangeResult, String> {
    super::clear_range_on_target(
        &wb.state,
        &wb.file,
        &wb.files,
        &wb.pivots,
        &wb.pane,
        &wb.filters,
        ClearRangeParams {
            start_row: rect.0,
            start_col: rect.1,
            end_row: rect.2,
            end_col: rect.3,
            apply_to,
            sheet_index: None,
            target: Some(t.clone()),
        },
    )
}

fn batch(wb: &Workbook, t: &CellTargetRef, writes: &[(u32, u32, &str)]) -> Result<Vec<crate::api_types::CellData>, String> {
    crate::cell_target::update_cells_batch_on_target(
        &wb.state,
        &wb.file,
        &wb.files,
        &wb.pivots,
        &wb.pane,
        &wb.filters,
        t,
        writes
            .iter()
            .map(|&(row, col, value)| CellUpdateInput {
                row,
                col,
                value: value.to_string(),
                style_index: None,
                invariant: Some(true),
            })
            .collect(),
        "Paste",
    )
}

fn merge(wb: &Workbook, t: &CellTargetRef, rect: (u32, u32, u32, u32), opts: MergeOptions) -> Result<crate::api_types::MergeResult, String> {
    crate::merge_commands::merge_cells_on_target(
        &wb.state,
        &wb.file,
        &wb.files,
        &wb.pivots,
        &wb.pane,
        &wb.filters,
        t,
        rect.0,
        rect.1,
        rect.2,
        rect.3,
        Some(opts),
    )
}

fn backing_merges(wb: &Workbook, backing: usize) -> Vec<MergedRegion> {
    let mut all: Vec<MergedRegion> = crate::report::with_sheet_merges(&wb.state, backing, |m| m.iter().cloned().collect());
    all.sort_by_key(|r| (r.start_row, r.start_col, r.end_row, r.end_col));
    all
}

fn region(r0: u32, c0: u32, r1: u32, c1: u32) -> MergedRegion {
    MergedRegion { start_row: r0, start_col: c0, end_row: r1, end_col: c1 }
}

// ---------------------------------------------------------------------------
// Clear
// ---------------------------------------------------------------------------

#[test]
fn clearing_a_floating_grid_range_is_one_undo_step_on_the_backing_sheet_only() {
    let wb = Workbook::new(1);
    let (t, backing) = float1(&wb, 4, 3);
    for row in 0..3 {
        type_in(&wb, &t, row, 1, &format!("{}", row + 1));
        wb.set(row, 1, "500"); // the ACTIVE sheet's B1:B3, under the grid
    }
    wb.set(0, 4, "=Float1!B2"); // Sheet1!E1 reads the grid
    assert_eq!(active_value(&wb, 0, 4), CellValue::Number(2.0));

    let before = depth(&wb);
    let result = clear(&wb, &t, (0, 1, 2, 1), ClearApplyTo::All).expect("clear B1:B3 on the grid");
    assert_eq!(result.count, 3);
    assert_eq!(depth(&wb), before + 1, "an N-cell clear is ONE undo step");
    for row in 0..3 {
        assert_eq!(backing_value(&wb, backing, row, 1), CellValue::Empty, "backing B{} cleared", row + 1);
        assert_eq!(active_value(&wb, row, 1), CellValue::Number(500.0), "the active sheet's B{} is untouched", row + 1);
    }
    assert_eq!(active_value(&wb, 0, 4), CellValue::Number(0.0), "the host formula recalculated");

    undo_once(&wb);
    for row in 0..3 {
        assert_eq!(backing_value(&wb, backing, row, 1), CellValue::Number(f64::from(row + 1)), "one Ctrl+Z restores B{}", row + 1);
    }
}

#[test]
fn a_clear_outside_the_extent_or_on_a_protected_host_refuses_and_leaves_the_document_clean() {
    let wb = Workbook::new(1);
    let (t, backing) = float1(&wb, 4, 3);
    type_in(&wb, &t, 0, 0, "1");

    let err = assert_clean_refusal(&wb, "outside the extent", || clear(&wb, &t, (0, 0, 0, 5), ClearApplyTo::All));
    assert!(err.contains("is outside floating grid 'Float1'"), "got: {err}");

    protect_host(&wb, SheetProtectionOptions::default());
    let err = assert_clean_refusal(&wb, "protected host", || clear(&wb, &t, (0, 0, 0, 0), ClearApplyTo::Contents));
    assert!(err.contains("Cannot change cell A1"), "the host's per-cell sentence, got: {err}");
    assert_eq!(backing_value(&wb, backing, 0, 0), CellValue::Number(1.0));

    // A target together with a sheet is refused before anything is read.
    let err = assert_clean_refusal(&wb, "target and sheet", || {
        super::clear_range_on_target(
            &wb.state,
            &wb.file,
            &wb.files,
            &wb.pivots,
            &wb.pane,
            &wb.filters,
            ClearRangeParams {
                start_row: 0,
                start_col: 0,
                end_row: 0,
                end_col: 0,
                apply_to: ClearApplyTo::All,
                sheet_index: Some(0),
                target: Some(t.clone()),
            },
        )
    });
    assert_eq!(err, "Pass a floating grid target or a sheet, not both.");
}

// ---------------------------------------------------------------------------
// Sort
// ---------------------------------------------------------------------------

#[test]
fn sorting_inside_a_floating_grid_moves_values_and_leaves_host_readers_text_alone() {
    let wb = Workbook::new(1);
    let (t, backing) = float1(&wb, 4, 2);
    for (row, (letter, n)) in [("c", "1"), ("a", "2"), ("d", "3"), ("b", "4")].iter().enumerate() {
        type_in(&wb, &t, row as u32, 0, letter);
        type_in(&wb, &t, row as u32, 1, n);
    }
    wb.set(0, 3, "zzz"); // the active sheet's A1-area marker, far from the grid
    wb.set(0, 0, "keep"); // Sheet1!A1 under the grid
    wb.set(0, 4, "=Float1!B3"); // Sheet1!E1 reads the grid's B3
    assert_eq!(active_value(&wb, 0, 4), CellValue::Number(3.0));

    let result = super::sort_range_on_target(
        &wb.state,
        &wb.file,
        &wb.files,
        &wb.pivots,
        &wb.pane,
        &wb.filters,
        SortRangeParams {
            start_row: 0,
            start_col: 0,
            end_row: 3,
            end_col: 1,
            fields: vec![SortField {
                key: 0,
                ascending: true,
                sort_on: Default::default(),
                color: None,
                icon: None,
                data_option: Default::default(),
                sub_field: None,
                custom_order: None,
            }],
            match_case: false,
            has_headers: false,
            orientation: SortOrientation::Rows,
            sheet_index: None,
            target: Some(t.clone()),
        },
    )
    .expect("sort A1:B4 on the grid");
    assert!(result.success, "{:?}", result.error);
    let letters: Vec<CellValue> = (0..4).map(|r| backing_value(&wb, backing, r, 0)).collect();
    assert_eq!(letters, vec![text("a"), text("b"), text("c"), text("d")]);
    let numbers: Vec<CellValue> = (0..4).map(|r| backing_value(&wb, backing, r, 1)).collect();
    assert_eq!(
        numbers,
        vec![CellValue::Number(2.0), CellValue::Number(4.0), CellValue::Number(1.0), CellValue::Number(3.0)],
        "the B values travel with their rows"
    );
    assert_eq!(active_value(&wb, 0, 0), text("keep"), "the active sheet is untouched");
    let host = wb.state.grid.read().unwrap().get_cell(0, 4).cloned().expect("E1");
    assert_eq!(host.formula_string().as_deref(), Some("Float1!B3"), "Excel's sort never rewrites other cells' references");
    assert_eq!(active_value(&wb, 0, 4), CellValue::Number(1.0), "and the reader shows the value that arrived");

    // The Sort option is the host's.
    protect_host(&wb, SheetProtectionOptions::default());
    let err = assert_clean_refusal(&wb, "sort on a protected host", || {
        super::sort_range_on_target(
            &wb.state,
            &wb.file,
            &wb.files,
            &wb.pivots,
            &wb.pane,
            &wb.filters,
            SortRangeParams {
                start_row: 0,
                start_col: 0,
                end_row: 3,
                end_col: 1,
                fields: vec![SortField {
                    key: 0,
                    ascending: false,
                    sort_on: Default::default(),
                    color: None,
                    icon: None,
                    data_option: Default::default(),
                    sub_field: None,
                    custom_order: None,
                }],
                match_case: false,
                has_headers: false,
                orientation: SortOrientation::Rows,
                sheet_index: None,
                target: Some(t.clone()),
            },
        )
    });
    assert!(err.contains("sort"), "got: {err}");
}

// ---------------------------------------------------------------------------
// The batch write (paste)
// ---------------------------------------------------------------------------

#[test]
fn a_batch_paste_lands_on_the_backing_sheet_recalculates_the_host_and_is_one_undo_step() {
    let wb = Workbook::new(1);
    let (t, backing) = float1(&wb, 4, 3);
    wb.set(0, 0, "111"); // Sheet1!A1, under the grid
    wb.set(1, 0, "222"); // Sheet1!A2
    wb.set(0, 5, "=Float1!A1*2"); // Sheet1!F1 reads the grid

    let before = depth(&wb);
    let cells = batch(&wb, &t, &[(0, 0, "5"), (1, 0, "=A1+1"), (2, 0, "x")]).expect("paste into the grid");
    assert_eq!(depth(&wb), before + 1, "a paste is ONE undo step");
    assert_eq!(backing_value(&wb, backing, 0, 0), CellValue::Number(5.0));
    assert_eq!(backing_value(&wb, backing, 1, 0), CellValue::Number(6.0), "a pasted formula evaluates on the backing sheet");
    assert_eq!(backing_value(&wb, backing, 2, 0), text("x"));
    assert_eq!(active_value(&wb, 0, 0), CellValue::Number(111.0), "the active sheet's A1 is untouched");
    assert_eq!(active_value(&wb, 1, 0), CellValue::Number(222.0), "the active sheet's A2 is untouched");
    assert_eq!(active_value(&wb, 0, 5), CellValue::Number(10.0), "the host formula recalculated (phase B)");
    let a2 = cells.iter().find(|c| (c.row, c.col) == (1, 0)).expect("A2 reported");
    assert_eq!(a2.display, "6", "the result describes the BACKING cells");

    undo_once(&wb);
    assert_eq!(backing_value(&wb, backing, 0, 0), CellValue::Empty, "one Ctrl+Z takes the whole paste back");
    assert_eq!(backing_value(&wb, backing, 1, 0), CellValue::Empty);
    assert_eq!(backing_value(&wb, backing, 2, 0), CellValue::Empty);
}

#[test]
fn a_batch_paste_on_a_protected_host_refuses_whole_and_leaves_the_document_clean() {
    let wb = Workbook::new(1);
    let (t, backing) = float1(&wb, 4, 3);
    // An UNLOCKED backing cell beside a locked one: a paste over both refuses
    // whole (never half done).
    let seed = crate::document_effect::test_seed_effect();
    let mut unlocked = CellStyle::new();
    unlocked.locked = false;
    let idx = wb.state.style_registry.write(&seed).unwrap().get_or_create(unlocked);
    wb.state.grids.write(&seed).unwrap()[backing]
        .set_cell(0, 0, Cell { value: CellValue::Empty, ast: None, style_index: idx, rich_text: None });
    protect_host(&wb, SheetProtectionOptions::default());

    let err = assert_clean_refusal(&wb, "paste on a protected host", || batch(&wb, &t, &[(0, 0, "1"), (0, 1, "2")]));
    assert!(err.contains("Cannot change cell B1"), "got: {err}");
    assert_eq!(backing_value(&wb, backing, 0, 0), CellValue::Empty, "nothing of the paste landed");

    // Positive control: the unlocked cell alone takes the paste.
    batch(&wb, &t, &[(0, 0, "1")]).expect("an unlocked backing cell takes the paste");
    assert_eq!(backing_value(&wb, backing, 0, 0), CellValue::Number(1.0));

    let err = assert_clean_refusal(&wb, "paste outside the extent", || batch(&wb, &t, &[(9, 0, "1")]));
    assert!(err.contains("A10 is outside floating grid 'Float1'"), "got: {err}");
}

// ---------------------------------------------------------------------------
// Fill
// ---------------------------------------------------------------------------

#[test]
fn fill_down_on_a_floating_grid_shifts_relative_references_on_the_backing_sheet() {
    let wb = Workbook::new(1);
    let (t, backing) = float1(&wb, 4, 3);
    type_in(&wb, &t, 0, 0, "2");
    type_in(&wb, &t, 1, 0, "3");
    type_in(&wb, &t, 2, 0, "4");
    type_in(&wb, &t, 0, 1, "=A1*10");
    wb.set(1, 1, "999"); // the active sheet's B2, under the grid

    let before = depth(&wb);
    super::fill_range_on_target(
        &wb.state,
        &wb.file,
        &wb.files,
        &wb.pivots,
        &wb.pane,
        &wb.filters,
        &t,
        (0, 1, 0, 1),
        (1, 1, 2, 1),
    )
    .expect("fill B1 down to B3");
    assert_eq!(depth(&wb), before + 1, "a fill is ONE undo step");
    let b2 = backing_cell(&wb, backing, 1, 1).expect("B2 filled");
    assert_eq!(b2.formula_string().as_deref(), Some("A2*10"), "the reference moved with the fill");
    assert_eq!(b2.value, CellValue::Number(30.0));
    assert_eq!(backing_value(&wb, backing, 2, 1), CellValue::Number(40.0));
    assert_eq!(active_value(&wb, 1, 1), CellValue::Number(999.0), "the active sheet's B2 is untouched");

    undo_once(&wb);
    assert!(backing_cell(&wb, backing, 1, 1).is_none(), "one Ctrl+Z takes the fill back");
    assert!(backing_cell(&wb, backing, 2, 1).is_none());

    protect_host(&wb, SheetProtectionOptions::default());
    let err = assert_clean_refusal(&wb, "fill on a protected host", || {
        super::fill_range_on_target(
            &wb.state, &wb.file, &wb.files, &wb.pivots, &wb.pane, &wb.filters, &t, (0, 1, 0, 1), (1, 1, 2, 1),
        )
    });
    assert!(err.contains("Cannot change cell"), "got: {err}");
}

// ---------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------

#[test]
fn a_merge_probe_reads_the_backing_grid_and_changes_nothing() {
    let wb = Workbook::new(1);
    let (t, backing) = float1(&wb, 4, 3);
    type_in(&wb, &t, 0, 0, "c");
    type_in(&wb, &t, 0, 1, "1234");
    // The ACTIVE sheet's A1:B1 is empty: a probe answered from it would
    // report no loss.
    crate::document_effect::mark_saved(&wb.file);
    let before = depth(&wb);
    let probe = merge(&wb, &t, (0, 0, 0, 1), MergeOptions { probe: true, ..Default::default() }).expect("probe");
    assert_eq!(probe.lossy_regions, 1, "the loss is counted on the BACKING grid");
    assert_eq!(probe.created_regions, vec![region(0, 0, 0, 1)]);
    assert!(!wb.file.is_dirty(), "a probe leaves the document clean");
    assert_eq!(depth(&wb), before, "and records nothing");
    assert!(backing_merges(&wb, backing).is_empty());
    assert_eq!(backing_value(&wb, backing, 0, 1), CellValue::Number(1234.0));
}

#[test]
fn a_merge_on_a_floating_grid_is_one_step_and_keeps_the_upper_left_value() {
    let wb = Workbook::new(1);
    let (t, backing) = float1(&wb, 4, 3);
    type_in(&wb, &t, 0, 0, "c");
    type_in(&wb, &t, 0, 1, "1234");
    wb.set(0, 1, "777"); // the active sheet's B1

    let before = depth(&wb);
    let result = merge(&wb, &t, (0, 0, 0, 1), MergeOptions::default()).expect("merge A1:B1");
    assert!(result.success);
    assert_eq!(depth(&wb), before + 1, "ONE undo step");
    assert_eq!(backing_merges(&wb, backing), vec![region(0, 0, 0, 1)]);
    assert!(wb.state.merged_regions.read().unwrap().is_empty(), "the ACTIVE sheet gained no merge");
    assert_eq!(backing_value(&wb, backing, 0, 0), text("c"), "the upper-left value stays");
    assert_eq!(backing_value(&wb, backing, 0, 1), CellValue::Empty, "the rest is discarded");
    assert_eq!(active_value(&wb, 0, 1), CellValue::Number(777.0), "the active sheet's B1 is untouched");

    undo_once(&wb);
    assert!(backing_merges(&wb, backing).is_empty(), "one Ctrl+Z removes the merge");
    assert_eq!(backing_value(&wb, backing, 0, 1), CellValue::Number(1234.0), "and restores B1");

    // The host gates it: Format Cells.
    protect_host(&wb, SheetProtectionOptions::default());
    let err = assert_clean_refusal(&wb, "merge on a protected host", || merge(&wb, &t, (0, 0, 0, 1), MergeOptions::default()));
    assert!(err.contains("Cannot change cell") || err.contains("merge cells"), "got: {err}");
}

#[test]
fn merge_across_makes_one_region_per_row_and_absorb_dissolves_an_inner_backing_region() {
    let wb = Workbook::new(1);
    let (t, backing) = float1(&wb, 4, 3);

    merge(&wb, &t, (0, 0, 2, 2), MergeOptions { across: true, ..Default::default() }).expect("Merge Across A1:C3");
    assert_eq!(
        backing_merges(&wb, backing),
        vec![region(0, 0, 0, 2), region(1, 0, 1, 2), region(2, 0, 2, 2)],
        "one region per row"
    );
    undo_once(&wb);
    assert!(backing_merges(&wb, backing).is_empty(), "Merge Across is ONE undo step");

    // ABSORB: B2:C2 merged on the backing sheet, then A1:C3 merged around it.
    merge(&wb, &t, (1, 1, 1, 2), MergeOptions::default()).expect("merge B2:C2");
    let err = merge(&wb, &t, (0, 0, 2, 2), MergeOptions::default()).expect_err("without absorb an inner merge refuses");
    assert!(err.contains("overlaps"), "got: {err}");
    let before = depth(&wb);
    let result = merge(&wb, &t, (0, 0, 2, 2), MergeOptions { absorb: true, ..Default::default() }).expect("absorb");
    assert_eq!(result.removed_regions, vec![region(1, 1, 1, 2)], "the inner region is dissolved");
    assert_eq!(backing_merges(&wb, backing), vec![region(0, 0, 2, 2)], "and only the new one is left");
    assert_eq!(depth(&wb), before + 1);
    undo_once(&wb);
    assert_eq!(backing_merges(&wb, backing), vec![region(1, 1, 1, 2)], "one Ctrl+Z puts the inner region back");

    // A partial overlap still refuses, absorb or not.
    let err = merge(&wb, &t, (0, 0, 1, 1), MergeOptions { absorb: true, ..Default::default() }).expect_err("partial overlap");
    assert!(err.contains("overlaps"), "got: {err}");
}

#[test]
fn keep_first_value_moves_the_value_and_re_points_its_readers_on_the_backing_sheet() {
    // Ruling Q4: ONE merge behaviour. The sheet gesture's keep-first-value
    // works on a floating grid too.
    let wb = Workbook::new(1);
    let (t, backing) = float1(&wb, 4, 3);
    type_in(&wb, &t, 0, 1, "42"); // B1 holds the first value; A1 is empty
    type_in(&wb, &t, 2, 0, "=B1+1"); // A3 reads B1

    let result = merge(&wb, &t, (0, 0, 0, 1), MergeOptions { keep_first_value: true, ..Default::default() })
        .expect("merge A1:B1 keeping the first value");
    assert_eq!(result.moved_cells.len(), 1);
    assert_eq!(backing_value(&wb, backing, 0, 0), CellValue::Number(42.0), "the value moved into A1");
    assert_eq!(backing_value(&wb, backing, 0, 1), CellValue::Empty);
    let a3 = backing_cell(&wb, backing, 2, 0).expect("A3");
    assert_eq!(a3.formula_string().as_deref(), Some("A1+1"), "the reader follows the moved value");
    assert_eq!(a3.value, CellValue::Number(43.0));

    undo_once(&wb);
    assert_eq!(backing_value(&wb, backing, 0, 1), CellValue::Number(42.0), "one Ctrl+Z restores B1");
    assert_eq!(
        backing_cell(&wb, backing, 2, 0).and_then(|c| c.formula_string()).as_deref(),
        Some("B1+1"),
        "and the reader's text"
    );
    assert!(backing_merges(&wb, backing).is_empty());
}

#[test]
fn unmerging_a_range_on_a_floating_grid_dissolves_every_intersecting_backing_region_in_one_step() {
    let wb = Workbook::new(1);
    let (t, backing) = float1(&wb, 4, 3);
    merge(&wb, &t, (0, 0, 0, 1), MergeOptions::default()).unwrap();
    merge(&wb, &t, (2, 0, 3, 0), MergeOptions::default()).unwrap();
    merge(&wb, &t, (2, 2, 3, 2), MergeOptions::default()).unwrap();

    let before = depth(&wb);
    let result = crate::merge_commands::unmerge_cells_on_target(&wb.state, &wb.file, &t, 0, 0, Some(2), Some(1))
        .expect("unmerge A1:B3");
    assert_eq!(result.removed_regions, vec![region(0, 0, 0, 1), region(2, 0, 3, 0)]);
    assert_eq!(backing_merges(&wb, backing), vec![region(2, 2, 3, 2)], "the region outside the range stays");
    assert_eq!(depth(&wb), before + 1, "ONE undo step");
    undo_once(&wb);
    assert_eq!(backing_merges(&wb, backing).len(), 3, "one Ctrl+Z restores both");
}

// ---------------------------------------------------------------------------
// Search and Go To Special
// ---------------------------------------------------------------------------

#[test]
fn find_and_replace_on_a_floating_grid_search_the_backing_sheet_and_leave_the_host_alone() {
    let wb = Workbook::new(1);
    let (t, backing) = float1(&wb, 4, 2);
    type_in(&wb, &t, 0, 0, "c");
    type_in(&wb, &t, 2, 0, "d");
    type_in(&wb, &t, 3, 1, "dd");
    wb.set(2, 0, "d"); // the HOST's A3 holds the same text

    let found = crate::commands::search::find_all_on(&wb.state, "d", false, false, false, None, Some(&t)).expect("find");
    assert_eq!(found.matches, vec![(2, 0), (3, 1)], "the backing sheet's matches, in the grid's coordinates");

    let before = depth(&wb);
    let replaced = crate::commands::search::replace_all_on_target(
        &wb.state, &wb.file, &wb.files, &wb.pivots, &wb.pane, &wb.filters, None, &t,
        "d".to_string(), "z".to_string(), false, false,
    )
    .expect("replace all");
    assert_eq!(replaced.replacement_count, 2);
    assert_eq!(depth(&wb), before + 1, "Replace All is ONE undo step");
    assert_eq!(backing_value(&wb, backing, 2, 0), text("z"));
    assert_eq!(backing_value(&wb, backing, 3, 1), text("zz"));
    assert_eq!(active_value(&wb, 2, 0), text("d"), "the host's A3 is left alone");

    let one = crate::commands::search::replace_single_on_target(
        &wb.state, &wb.file, &wb.files, &wb.pivots, &wb.pane, &wb.filters, None, &t, 0, 0,
        "c".to_string(), "q".to_string(), false,
    )
    .expect("replace one");
    assert!(one.is_some());
    assert_eq!(backing_value(&wb, backing, 0, 0), text("q"));

    protect_host(&wb, SheetProtectionOptions::default());
    let err = assert_clean_refusal(&wb, "replace on a protected host", || {
        crate::commands::search::replace_all_on_target(
            &wb.state, &wb.file, &wb.files, &wb.pivots, &wb.pane, &wb.filters, None, &t,
            "z".to_string(), "y".to_string(), false, false,
        )
    });
    assert!(err.contains("Cannot change cell"), "got: {err}");
}

#[test]
fn go_to_special_on_a_floating_grid_reads_the_backing_sheet_and_answers_last_cell_itself() {
    let wb = Workbook::new(1);
    let (t, _backing) = float1(&wb, 4, 3);
    type_in(&wb, &t, 0, 0, "1");
    type_in(&wb, &t, 1, 2, "x");
    type_in(&wb, &t, 2, 1, "=A1*2");
    wb.set(3, 0, "host constant"); // the HOST's A4: never a match

    let constants = crate::commands::nav::go_to_special_on_target(&wb.state, "constants", None, &t).expect("constants");
    let cells: Vec<(u32, u32)> = constants.cells.iter().map(|c| (c.row, c.col)).collect();
    assert_eq!(cells, vec![(0, 0), (1, 2)], "the backing sheet's constants only");

    let formulas = crate::commands::nav::go_to_special_on_target(&wb.state, "formulas", Some((0, 0, 3, 2)), &t).unwrap();
    assert_eq!(formulas.cells.iter().map(|c| (c.row, c.col)).collect::<Vec<_>>(), vec![(2, 1)]);

    let last = crate::commands::nav::go_to_special_on_target(&wb.state, "lastCell", None, &t).unwrap();
    assert_eq!(
        last.cells.iter().map(|c| (c.row, c.col)).collect::<Vec<_>>(),
        vec![(2, 2)],
        "the backing used range's far corner"
    );
}

// ---------------------------------------------------------------------------
// Conditional formatting
// ---------------------------------------------------------------------------

#[test]
fn a_rule_added_with_a_target_lives_on_the_backing_sheet_and_the_styled_read_carries_it() {
    let wb = Workbook::new(1);
    let (t, backing) = float1(&wb, 4, 2);
    for (row, n) in ["10", "20", "30"].iter().enumerate() {
        type_in(&wb, &t, row as u32 + 1, 1, n);
    }
    let added = crate::conditional_formatting::add_conditional_format_impl(
        &wb.state,
        &wb.file,
        AddCFParams {
            rule: ConditionalFormatRule::CellValue(CellValueRule {
                operator: CellValueOperator::GreaterThan,
                value1: "15".to_string(),
                value2: None,
            }),
            format: ConditionalFormat { background_color: Some("#FFC7CE".to_string()), ..Default::default() },
            ranges: vec![ConditionalFormatRange { start_row: 1, start_col: 1, end_row: 3, end_col: 1 }],
            stop_if_true: false,
            target: Some(t.clone()),
        },
    );
    assert!(added.success, "{:?}", added.error);
    let rule_id = added.rule.expect("the rule").id;
    {
        let cf = wb.state.conditional_formats.read().unwrap();
        assert_eq!(cf.get(&backing).map(|r| r.len()), Some(1), "stored under the BACKING index");
        assert!(cf.get(&0).map(|r| r.is_empty()).unwrap_or(true), "the host has no rule");
    }
    assert!(
        crate::conditional_formatting::get_all_conditional_formats_on(&wb.state, None, None).unwrap().is_empty(),
        "the active sheet's list is empty"
    );
    assert_eq!(
        crate::conditional_formatting::get_all_conditional_formats_on(&wb.state, None, Some(&t)).unwrap().len(),
        1,
        "the grid's list has it"
    );

    let read = crate::cell_target::get_cell_target_cells_inner(&wb.state, &t, 0, 0, 3, 1).unwrap();
    let hits: Vec<(u32, u32)> = read.conditional.iter().map(|c| (c.row, c.col)).collect();
    assert_eq!(hits, vec![(2, 1), (3, 1)], "evaluated on the backing grid: B3 and B4, not B2");
    assert_eq!(read.rules.iter().map(|r| r.id).collect::<Vec<_>>(), vec![rule_id], "and the read carries the rule");

    // Clear Rules from the grid's cells: the backing rule is cut.
    let changed = crate::conditional_formatting::clear_conditional_formats_in_range_on_target(
        &wb.state, &wb.file, 0, 0, 3, 1, None, &t,
    )
    .unwrap();
    assert_eq!(changed, 1);
    assert!(crate::conditional_formatting::get_all_conditional_formats_on(&wb.state, None, Some(&t)).unwrap().is_empty());

    // A protected host without Format Cells refuses a new rule.
    protect_host(&wb, SheetProtectionOptions::default());
    crate::document_effect::mark_saved(&wb.file);
    let refused = crate::conditional_formatting::add_conditional_format_impl(
        &wb.state,
        &wb.file,
        AddCFParams {
            rule: ConditionalFormatRule::NoBlanks,
            format: ConditionalFormat::default(),
            ranges: vec![ConditionalFormatRange { start_row: 0, start_col: 0, end_row: 0, end_col: 0 }],
            stop_if_true: false,
            target: Some(t.clone()),
        },
    );
    assert!(!refused.success, "refused on a protected host");
    assert!(!wb.file.is_dirty(), "and the document stays clean");
}
