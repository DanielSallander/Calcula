//! FILENAME: app/src-tauri/src/commands/merge_commands_tests.rs
//! PURPOSE: Excel's Merge menu (2026-10-02) -- what the ribbon gestures ask of
//! `merge_cells` / `unmerge_cells` / `get_merged_regions`.
//!
//! A CHILD module of `data` (declared with `#[path]` there) so it drives the
//! merge bodies through the shared `Workbook` harness `cross_sheet_recalc_tests`
//! owns, rather than a copied one.
//!
//! What is pinned here, and why each one matters:
//! - with NO options the command is Excel's Range.Merge (api.mergeCells, the
//!   fill engine and the TestRunner suites depend on it) -- over a merge it
//!   partly overlaps or contains, it merges the UNION (2026-11-05, [LIVE]);
//! - a PROBE changes nothing, records nothing and leaves the document CLEAN --
//!   it runs before Excel's data-loss warning, so a probe that dirtied would make
//!   every cancelled Merge & Center prompt to save;
//! - every REFUSED or no-op merge leaves the document clean (the old body set the
//!   flag before its 1x1 and overlap checks);
//! - Merge Across is ONE call and ONE undo step;
//! - the value rule MOVES the first value into the top-left cell (value, formula
//!   and style), and a moved formula keeps recalculating from its new cell;
//! - a whole-sheet merge finishes at once (the scans are sparse).

use super::cross_sheet_recalc_tests::Workbook;
use crate::api_types::{MergeOptions, MergeResult, MergedRegion};
use crate::merge_commands::{
    get_merged_regions_core, merge_cells_core, unmerge_cells_core, MAX_MERGE_ACROSS_ROWS,
};
use engine::{Cell, CellValue};

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

fn merge(
    wb: &Workbook,
    rect: (u32, u32, u32, u32),
    options: Option<MergeOptions>,
) -> Result<MergeResult, String> {
    merge_cells_core(
        &wb.state, &wb.file, &wb.files, &wb.pivots, &wb.pane, &wb.filters, rect.0, rect.1, rect.2,
        rect.3, None, options,
    )
}

fn gesture() -> MergeOptions {
    MergeOptions::default()
}

fn probe() -> MergeOptions {
    MergeOptions { probe: true, ..gesture() }
}

fn region(sr: u32, sc: u32, er: u32, ec: u32) -> MergedRegion {
    MergedRegion { start_row: sr, start_col: sc, end_row: er, end_col: ec }
}

fn merges(wb: &Workbook) -> Vec<MergedRegion> {
    let mut all: Vec<MergedRegion> = wb.state.merged_regions.read().unwrap().iter().cloned().collect();
    all.sort_by_key(|r| (r.start_row, r.start_col));
    all
}

fn value(wb: &Workbook, row: u32, col: u32) -> CellValue {
    wb.value(0, row, col)
}

fn text(s: &str) -> CellValue {
    CellValue::Text(s.to_string())
}

fn undo_depth(wb: &Workbook) -> usize {
    wb.state.undo_stack.lock().unwrap().undo_depth()
}

fn dirty(wb: &Workbook) -> bool {
    wb.file.is_dirty()
}

fn saved(wb: &Workbook) {
    crate::document_effect::mark_saved(&wb.file);
}

/// Store a cell as-is on the active sheet (both the mirror and the sheet).
fn put(wb: &Workbook, row: u32, col: u32, cell: Cell) {
    let effect = crate::document_effect::test_seed_effect();
    wb.state.grid.write(&effect).unwrap().set_cell(row, col, cell.clone());
    wb.state.grids.write(&effect).unwrap()[0].set_cell(row, col, cell);
}

fn style_index(wb: &Workbook, row: u32, col: u32) -> Option<usize> {
    wb.state.grids.read().unwrap()[0].get_cell(row, col).map(|c| c.style_index)
}

/// A non-default style, registered, so a moved cell's format can be traced.
fn bold_style(wb: &Workbook) -> usize {
    let effect = crate::document_effect::test_seed_effect();
    wb.state
        .style_registry
        .write(&effect)
        .unwrap()
        .get_or_create(engine::CellStyle::new().with_bold(true))
}

/// Undo through the REAL restore path (`apply_changes`), as Ctrl+Z does.
fn undo(wb: &Workbook) {
    let transaction = wb.state.undo_stack.lock().unwrap().pop_undo().expect("nothing to undo");
    crate::undo_commands::apply_changes(
        &wb.state, &wb.file, &wb.files, &wb.pivots, &wb.slicer, &wb.filters, &wb.pane,
        &wb.timelines, transaction, true,
    );
}

// ---------------------------------------------------------------------------
// The old command is unchanged
// ---------------------------------------------------------------------------

#[test]
fn without_options_a_merge_is_the_old_range_merge() {
    let wb = Workbook::new(1);
    wb.set(0, 0, "keep");
    wb.set(0, 1, "gone");
    let result = merge(&wb, (0, 0, 0, 2), None).expect("merge");
    assert!(result.success);
    assert_eq!(merges(&wb), vec![region(0, 0, 0, 2)]);
    assert_eq!(value(&wb, 0, 0), text("keep"));
    assert_eq!(value(&wb, 0, 1), CellValue::Empty, "a slave's value is discarded");
    assert_eq!(result.created_regions, vec![region(0, 0, 0, 2)]);
    assert_eq!(result.lossy_regions, 1);

    // Changed deliberately (2026-11-05): a merge already inside the range used
    // to be REFUSED without `absorb`; Excel's Range.Merge absorbs it [LIVE].
    let bigger = merge(&wb, (0, 0, 1, 3), None).expect("a merge inside the range is absorbed");
    assert_eq!(merges(&wb), vec![region(0, 0, 1, 3)]);
    assert_eq!(bigger.removed_regions, vec![region(0, 0, 0, 2)]);
}

// ---------------------------------------------------------------------------
// The UNION (NEW-merge-union): Excel's Range.Merge over a PARTIAL overlap
// ---------------------------------------------------------------------------
//
// [LIVE, Excel 16 build 20326, 2026-11-05, miscb-probe1/2.ps1] E1:F1 merged,
// Range("E1:E2").Merge -> E1:F2 (E1 keeps its value, E2's is discarded);
// E1:F1 + E3:G3 merged, Range("E1:E3").Merge -> E1:G3; E1:F2 + G2:H2 merged,
// Range("F1:G1").Merge -> E1:H2; E1:F1 merged, Range("E1:E2").Merge(True) ->
// E1:F1 and E2:F2; F2 inside E1:G3 -> E1:G3 unchanged. Calcula refused every
// partial overlap ("selection overlaps with existing merged region").

// SABOTAGE: make `expand_over_merges` return `rect.clone()` -> the plain merge
// is a partial overlap again and E1:F2 is never made.
#[test]
fn a_merge_over_a_partial_overlap_merges_the_union_as_excel_does() {
    let wb = Workbook::new(1);
    merge(&wb, (0, 4, 0, 5), None).expect("E1:F1"); // E1:F1
    wb.set(0, 4, "a"); // E1
    wb.set(1, 4, "b"); // E2
    let result = merge(&wb, (0, 4, 1, 4), None).expect("E1:E2 over E1:F1 merges the union");
    assert_eq!(merges(&wb), vec![region(0, 4, 1, 5)], "the union E1:F2 was not merged");
    assert_eq!(result.created_regions, vec![region(0, 4, 1, 5)]);
    assert_eq!(result.removed_regions, vec![region(0, 4, 0, 5)]);
    assert_eq!(value(&wb, 0, 4), text("a"), "the top-left keeps its value");
    assert_eq!(value(&wb, 1, 4), CellValue::Empty, "a slave's value is discarded");

    // One Ctrl+Z restores both the old merge and the discarded value.
    undo(&wb);
    assert_eq!(merges(&wb), vec![region(0, 4, 0, 5)]);
    assert_eq!(value(&wb, 1, 4), text("b"));
}

#[test]
fn the_union_takes_in_every_merge_it_reaches_and_merge_across_splits_it_by_row() {
    // Two merges bridged.
    let wb = Workbook::new(1);
    merge(&wb, (0, 4, 0, 5), None).expect("E1:F1");
    merge(&wb, (2, 4, 2, 6), None).expect("E3:G3");
    merge(&wb, (0, 4, 2, 4), None).expect("E1:E3");
    assert_eq!(merges(&wb), vec![region(0, 4, 2, 6)], "E1:G3");

    // The chain: the growth reaches a merge the range itself did not touch.
    let wb = Workbook::new(1);
    merge(&wb, (0, 4, 1, 5), None).expect("E1:F2");
    merge(&wb, (1, 6, 1, 7), None).expect("G2:H2");
    merge(&wb, (0, 5, 0, 6), None).expect("F1:G1");
    assert_eq!(merges(&wb), vec![region(0, 4, 1, 7)], "E1:H2");

    // Merge Across over E1:E2 with E1:F1 merged: one region per row of E1:F2.
    let wb = Workbook::new(1);
    merge(&wb, (0, 4, 0, 5), None).expect("E1:F1");
    merge(&wb, (0, 4, 1, 4), Some(MergeOptions { across: true, ..Default::default() })).expect("across");
    assert_eq!(merges(&wb), vec![region(0, 4, 0, 5), region(1, 4, 1, 5)]);

    // A range wholly inside a merge changes nothing, and leaves the document clean.
    let wb = Workbook::new(1);
    merge(&wb, (0, 4, 2, 6), None).expect("E1:G3");
    saved(&wb);
    let inside = merge(&wb, (1, 5, 1, 6), None).expect("F2:G2 inside");
    assert!(!inside.success);
    assert!(!dirty(&wb));
    assert_eq!(merges(&wb), vec![region(0, 4, 2, 6)]);
}

/// The same union on a NON-active sheet (a script's Range.Merge there).
#[test]
fn an_off_sheet_merge_over_a_partial_overlap_merges_the_union() {
    let wb = Workbook::new(2);
    let off = |rect: (u32, u32, u32, u32)| {
        merge_cells_core(
            &wb.state, &wb.file, &wb.files, &wb.pivots, &wb.pane, &wb.filters, rect.0, rect.1, rect.2,
            rect.3, Some(1), None,
        )
    };
    off((0, 1, 0, 2)).expect("B1:C1 on Sheet2");
    off((0, 1, 2, 1)).expect("B1:B3 over B1:C1 merges the union");
    let mut on_two: Vec<MergedRegion> =
        crate::report::with_sheet_merges(&wb.state, 1, |m| m.iter().cloned().collect());
    on_two.sort_by_key(|r| (r.start_row, r.start_col));
    assert_eq!(on_two, vec![region(0, 1, 2, 2)], "B1:C3");
}

/// NEW-merge-first-value. OVERRULES the old pin
/// `without_the_value_rule_an_empty_top_left_stays_empty`, deliberately:
/// [LIVE, Excel 16, 2026-11-05, miscb PLAINVAL + tablec/probe2.ps1] a PLAIN
/// `Range("E1:G1").Merge` with F1="title" leaves E1="title" -- the value rule
/// is not the ribbon's, it is every merge's -- and the value MOVES as a cut
/// and paste moves it: `=F1` reads `=E1`, `=E1` (the overwritten empty
/// top-left) reads `#REF!`. A script's api.mergeCells and the fill engine
/// reach this door with no options; they used to destroy the value and
/// re-point nothing. One Ctrl+Z takes the merge AND the re-pointing back.
/// SABOTAGE (tablec-mergeval): the value rule back behind `opts.probe` (never
/// on for a plain merge).
#[test]
fn a_plain_range_merge_moves_the_first_value_into_an_empty_top_left_as_excel_does() {
    let wb = Workbook::new(1);
    wb.set(0, 1, "title");
    wb.set(4, 0, "=B1");
    wb.set(5, 0, "=A1");
    let result = merge(&wb, (0, 0, 0, 2), None).expect("merge");
    assert_eq!(result.moved_cells.len(), 1);
    assert_eq!(value(&wb, 0, 0), text("title"), "the value moved into the empty top-left");
    assert_eq!(value(&wb, 0, 1), CellValue::Empty);
    let formula = |row: u32| {
        wb.state.grids.read().unwrap()[0].get_cell(row, 0).and_then(|c| c.formula_string()).unwrap_or_default()
    };
    assert_eq!(formula(4).to_ascii_uppercase(), "A1", "a reader of the moved value follows it");
    assert_eq!(value(&wb, 4, 0), text("title"));
    assert!(formula(5).contains("#REF!"), "a reader of the overwritten top-left is #REF!: {}", formula(5));

    undo(&wb);
    assert_eq!(value(&wb, 0, 1), text("title"), "one Ctrl+Z puts the value back");
    assert_eq!(value(&wb, 0, 0), CellValue::Empty);
    assert_eq!(formula(4).to_ascii_uppercase(), "B1", "and the reader's reference");
    assert!(merges(&wb).is_empty());
}

/// The same rule on a NON-active sheet (a script's Range.Merge there): the
/// value survives in the top-left instead of being destroyed.
#[test]
fn an_off_sheet_plain_merge_keeps_the_first_value_too() {
    let wb = Workbook::new(2);
    {
        let effect = crate::document_effect::test_seed_effect();
        wb.state.grids.write(&effect).unwrap()[1].set_cell(0, 2, Cell::new_text("far".to_string()));
    }
    merge_cells_core(
        &wb.state, &wb.file, &wb.files, &wb.pivots, &wb.pane, &wb.filters, 0, 1, 0, 3, Some(1), None,
    )
    .expect("off-sheet merge");
    let grids = wb.state.grids.read().unwrap();
    assert_eq!(grids[1].get_cell(0, 1).map(|c| c.value.clone()), Some(text("far")));
    assert!(grids[1].get_cell(0, 2).is_none(), "the moved cell is emptied");
}

// ---------------------------------------------------------------------------
// The probe and the clean document
// ---------------------------------------------------------------------------

#[test]
fn a_probe_reports_the_plan_and_changes_nothing() {
    let wb = Workbook::new(1);
    wb.set(0, 0, "a");
    wb.set(0, 1, "b");
    wb.set(2, 2, "inside");
    merge(&wb, (2, 1, 2, 2), None).expect("inner merge");
    saved(&wb);
    let depth = undo_depth(&wb);

    let plan = merge(&wb, (0, 0, 3, 3), Some(probe())).expect("probe");
    assert!(plan.success);
    assert_eq!(plan.created_regions, vec![region(0, 0, 3, 3)]);
    assert_eq!(plan.removed_regions, vec![region(2, 1, 2, 2)]);
    assert_eq!(plan.lossy_regions, 1, "two cells hold content: one region discards values");
    assert!(plan.updated_cells.is_empty());

    assert_eq!(merges(&wb), vec![region(2, 1, 2, 2)], "the probe merged nothing");
    assert_eq!(value(&wb, 0, 1), text("b"), "the probe cleared nothing");
    assert_eq!(undo_depth(&wb), depth, "the probe recorded no undo step");
    assert!(!dirty(&wb), "the probe dirtied the document");
}

#[test]
fn a_refused_or_empty_merge_leaves_the_document_clean() {
    let wb = Workbook::new(1);
    merge(&wb, (0, 0, 0, 1), None).expect("first merge");
    saved(&wb);
    let depth = undo_depth(&wb);

    // 1x1: nothing to merge.
    let one = merge(&wb, (5, 5, 5, 5), Some(gesture())).expect("1x1");
    assert!(!one.success);
    // A range inside the merge: its union IS the merge, so nothing changes.
    // (A partial overlap used to be refused here; it merges the union now --
    // see `a_merge_over_a_partial_overlap_merges_the_union_as_excel_does`.)
    let inside = merge(&wb, (0, 1, 0, 1), None).expect("inside");
    assert!(!inside.success);
    // A Merge Across over too many rows is refused.
    assert!(merge(&wb, (10, 0, 10 + MAX_MERGE_ACROSS_ROWS, 1), Some(MergeOptions { across: true, ..gesture() })).is_err());

    assert!(!dirty(&wb), "a merge that changed nothing set the dirty flag");
    assert_eq!(undo_depth(&wb), depth);
    assert_eq!(merges(&wb), vec![region(0, 0, 0, 1)]);
}

#[test]
fn merging_what_is_already_exactly_that_merge_is_a_clean_no_op() {
    let wb = Workbook::new(1);
    merge(&wb, (0, 0, 1, 2), None).expect("merge");
    saved(&wb);
    let depth = undo_depth(&wb);
    let again = merge(&wb, (0, 0, 1, 2), Some(gesture())).expect("again");
    assert!(!again.success);
    assert!(!dirty(&wb));
    assert_eq!(undo_depth(&wb), depth);
}

// ---------------------------------------------------------------------------
// Absorb
// ---------------------------------------------------------------------------

#[test]
fn absorb_dissolves_a_contained_merge_into_the_bigger_one_and_undo_restores_it() {
    let wb = Workbook::new(1);
    merge(&wb, (1, 1, 1, 2), None).expect("inner");
    let result = merge(&wb, (0, 0, 2, 3), Some(gesture())).expect("absorb");
    assert!(result.success);
    assert_eq!(result.removed_regions, vec![region(1, 1, 1, 2)]);
    assert_eq!(merges(&wb), vec![region(0, 0, 2, 3)]);

    undo(&wb);
    assert_eq!(merges(&wb), vec![region(1, 1, 1, 2)], "one undo brings the inner merge back");
}

// ---------------------------------------------------------------------------
// Merge Across
// ---------------------------------------------------------------------------

#[test]
fn merge_across_makes_one_region_per_row_in_one_undo_step() {
    let wb = Workbook::new(1);
    for row in 0..3 {
        wb.set(row, 0, &format!("r{}", row));
        wb.set(row, 1, "x");
    }
    let depth = undo_depth(&wb);
    let opts = MergeOptions { across: true, ..gesture() };
    let result = merge(&wb, (0, 0, 2, 2), Some(opts)).expect("across");
    assert!(result.success);
    assert_eq!(merges(&wb), vec![region(0, 0, 0, 2), region(1, 0, 1, 2), region(2, 0, 2, 2)]);
    assert_eq!(result.lossy_regions, 3, "every row has two filled cells");
    assert_eq!(value(&wb, 1, 1), CellValue::Empty);
    assert_eq!(undo_depth(&wb), depth + 1, "Merge Across is ONE undo step");

    undo(&wb);
    assert!(merges(&wb).is_empty(), "one undo removes all three merges");
    assert_eq!(value(&wb, 1, 1), text("x"), "and brings every discarded value back");
}

#[test]
fn merge_across_rebuilds_a_vertical_merge_as_row_merges() {
    let wb = Workbook::new(1);
    wb.set(0, 0, "top");
    merge(&wb, (0, 0, 1, 0), None).expect("vertical");
    let opts = MergeOptions { across: true, ..gesture() };
    merge(&wb, (0, 0, 1, 2), Some(opts)).expect("across");
    assert_eq!(merges(&wb), vec![region(0, 0, 0, 2), region(1, 0, 1, 2)]);
    assert_eq!(value(&wb, 0, 0), text("top"), "the value stays in row 1");
}

#[test]
fn merge_across_over_one_column_does_nothing_and_stays_clean() {
    let wb = Workbook::new(1);
    saved(&wb);
    let opts = MergeOptions { across: true, ..gesture() };
    let result = merge(&wb, (0, 0, 5, 0), Some(opts)).expect("single column");
    assert!(!result.success);
    assert!(merges(&wb).is_empty());
    assert!(!dirty(&wb));
}

#[test]
fn merge_across_refuses_more_rows_than_the_cap_and_stays_clean() {
    let wb = Workbook::new(1);
    saved(&wb);
    let opts = MergeOptions { across: true, ..gesture() };
    let err = merge(&wb, (0, 0, MAX_MERGE_ACROSS_ROWS, 1), Some(opts)).unwrap_err();
    assert!(err.contains("10,000"), "{}", err);
    assert!(!dirty(&wb));
    // Exactly the cap is allowed.
    let ok = merge(&wb, (0, 0, MAX_MERGE_ACROSS_ROWS - 1, 1), Some(opts)).expect("at the cap");
    assert_eq!(ok.created_regions.len() as u32, MAX_MERGE_ACROSS_ROWS);
}

// ---------------------------------------------------------------------------
// Excel's value rule
// ---------------------------------------------------------------------------

#[test]
fn a_lone_value_moves_into_the_top_left_with_its_format_and_no_loss() {
    let wb = Workbook::new(1);
    let bold = bold_style(&wb);
    put(&wb, 0, 1, Cell { value: text("x"), style_index: bold, ..Cell::new() });

    let plan = merge(&wb, (0, 0, 0, 2), Some(probe())).expect("probe");
    assert_eq!(plan.lossy_regions, 0, "one filled cell discards nothing: no warning");
    assert_eq!(plan.moved_cells.len(), 1);

    let result = merge(&wb, (0, 0, 0, 2), Some(gesture())).expect("merge");
    assert_eq!(value(&wb, 0, 0), text("x"), "the value moved to the top-left");
    assert_eq!(style_index(&wb, 0, 0), Some(bold), "its format came with it");
    assert_eq!(value(&wb, 0, 1), CellValue::Empty);
    let moved = &result.moved_cells[0];
    assert_eq!((moved.from_row, moved.from_col, moved.to_row, moved.to_col), (0, 1, 0, 0));

    undo(&wb);
    assert!(merges(&wb).is_empty());
    assert_eq!(value(&wb, 0, 1), text("x"), "undo puts the value back where it was");
    assert_eq!(value(&wb, 0, 0), CellValue::Empty, "and empties the top-left again");
}

#[test]
fn with_two_values_the_first_in_reading_order_survives() {
    let wb = Workbook::new(1);
    wb.set(0, 1, "right");
    wb.set(1, 0, "down");
    let result = merge(&wb, (0, 0, 1, 1), Some(gesture())).expect("merge");
    assert_eq!(result.lossy_regions, 1);
    assert_eq!(value(&wb, 0, 0), text("right"), "row by row, left to right");
    assert_eq!(value(&wb, 1, 0), CellValue::Empty);
}

#[test]
fn a_moved_formula_keeps_recalculating_from_its_new_cell() {
    let wb = Workbook::new(1);
    wb.set(0, 2, "5");
    wb.set(0, 1, "=C1*2");
    merge(&wb, (0, 0, 0, 1), Some(gesture())).expect("merge");
    assert_eq!(wb.number(0, 0, 0), 10.0);
    wb.set(0, 2, "7");
    assert_eq!(wb.number(0, 0, 0), 14.0, "the moved formula lost its dependency edges");
}

#[test]
fn content_is_a_value_or_any_formula_never_formatting_alone() {
    let wb = Workbook::new(1);
    let bold = bold_style(&wb);
    // Row 0: a value and a formatted-but-empty cell -> nothing is lost.
    wb.set(0, 0, "a");
    put(&wb, 0, 1, Cell { style_index: bold, ..Cell::new() });
    // Row 1: a value and `=""` -> a formula is content.
    wb.set(1, 0, "a");
    wb.set(1, 1, "=\"\"");
    // Row 2: a value and a single space -> a space is content.
    wb.set(2, 0, "a");
    put(&wb, 2, 1, Cell { value: text(" "), ..Cell::new() });

    let opts = MergeOptions { across: true, ..probe() };
    let plan = merge(&wb, (0, 0, 2, 1), Some(opts)).expect("probe");
    assert_eq!(plan.lossy_regions, 2, "rows 1 and 2 discard content, row 0 only a format");
}

// ---------------------------------------------------------------------------
// Off-sheet, scale, unmerge, the rectangle read
// ---------------------------------------------------------------------------

#[test]
fn merge_options_are_refused_off_sheet() {
    let wb = Workbook::new(2);
    let err = merge_cells_core(
        &wb.state, &wb.file, &wb.files, &wb.pivots, &wb.pane, &wb.filters, 0, 0, 0, 1, Some(1),
        Some(MergeOptions { across: true, ..Default::default() }),
    )
    .unwrap_err();
    assert!(err.contains("active sheet"), "{}", err);
    // Without options the off-sheet merge still works.
    let plain = merge_cells_core(
        &wb.state, &wb.file, &wb.files, &wb.pivots, &wb.pane, &wb.filters, 0, 0, 0, 1, Some(1),
        None,
    )
    .expect("plain off-sheet merge");
    assert_eq!(plain.created_regions, vec![region(0, 0, 0, 1)]);
}

#[test]
fn a_whole_sheet_merge_is_sparse_and_finishes_at_once() {
    let wb = Workbook::new(1);
    wb.set(0, 0, "a");
    wb.set(10, 3, "b");
    wb.set(500_000, 9_000, "c");
    let started = std::time::Instant::now();
    let all = (0, 0, 1_048_575, 16_383);
    let plan = merge(&wb, all, Some(probe())).expect("probe");
    assert_eq!(plan.lossy_regions, 1);
    merge(&wb, all, Some(gesture())).expect("merge");
    let elapsed = started.elapsed();
    assert_eq!(value(&wb, 0, 0), text("a"));
    assert_eq!(value(&wb, 500_000, 9_000), CellValue::Empty);
    assert!(
        elapsed < std::time::Duration::from_secs(10),
        "a whole-sheet merge took {:?}: a scan walked coordinates instead of stored cells",
        elapsed
    );
}

#[test]
fn unmerge_over_a_range_removes_every_merge_it_touches_in_one_step() {
    let wb = Workbook::new(1);
    merge(&wb, (0, 0, 0, 1), None).expect("m1");
    merge(&wb, (2, 0, 3, 1), None).expect("m2");
    merge(&wb, (9, 9, 9, 10), None).expect("outside");
    let depth = undo_depth(&wb);

    // The rectangle only CLIPS the second merge (row 2 of rows 2..3).
    let result = unmerge_cells_core(&wb.state, &wb.file, 0, 0, None, Some(2), Some(0)).expect("unmerge");
    assert!(result.success);
    assert_eq!(result.removed_regions, vec![region(0, 0, 0, 1), region(2, 0, 3, 1)]);
    assert_eq!(merges(&wb), vec![region(9, 9, 9, 10)]);
    assert_eq!(undo_depth(&wb), depth + 1, "one undo step for both");

    undo(&wb);
    assert_eq!(merges(&wb), vec![region(0, 0, 0, 1), region(2, 0, 3, 1), region(9, 9, 9, 10)]);
}

#[test]
fn unmerge_over_a_range_with_nothing_merged_is_a_clean_no_op() {
    let wb = Workbook::new(1);
    saved(&wb);
    let result = unmerge_cells_core(&wb.state, &wb.file, 0, 0, None, Some(5), Some(5)).expect("unmerge");
    assert!(!result.success);
    assert!(!dirty(&wb));
}

#[test]
fn unmerging_a_range_off_sheet_is_refused() {
    let wb = Workbook::new(2);
    let err = unmerge_cells_core(&wb.state, &wb.file, 0, 0, Some(1), Some(3), Some(3)).unwrap_err();
    assert!(err.contains("active sheet"), "{}", err);
}

#[test]
fn the_single_cell_unmerge_is_unchanged() {
    let wb = Workbook::new(1);
    merge(&wb, (0, 0, 1, 1), None).expect("merge");
    let result = unmerge_cells_core(&wb.state, &wb.file, 1, 1, None, None, None).expect("unmerge");
    assert!(result.success);
    assert!(merges(&wb).is_empty());
    assert_eq!(result.updated_cells[0].row_span, 1);
}

#[test]
fn the_merged_regions_read_filters_by_rectangle() {
    let wb = Workbook::new(1);
    merge(&wb, (0, 0, 0, 1), None).expect("m1");
    merge(&wb, (5, 5, 6, 6), None).expect("m2");
    let all = get_merged_regions_core(&wb.state, None, None, None, None).unwrap();
    assert_eq!(all.len(), 2);
    let near = get_merged_regions_core(&wb.state, Some(0), Some(1), Some(2), Some(2)).unwrap();
    assert_eq!(near, vec![region(0, 0, 0, 1)]);
    let none = get_merged_regions_core(&wb.state, Some(10), Some(10), Some(20), Some(20)).unwrap();
    assert!(none.is_empty());
}
