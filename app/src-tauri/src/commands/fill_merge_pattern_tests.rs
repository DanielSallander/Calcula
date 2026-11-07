//! FILENAME: app/src-tauri/src/commands/fill_merge_pattern_tests.rs
//! PURPOSE: BUG-0768 -- Ctrl+D / Ctrl+R (`fill_range_core`) from a MERGED
//!          source repeat the source's merges down (across) the fill, as Excel
//!          does, and change nothing where Excel changes nothing.
//! CONTEXT: Excel [LIVE, Excel 16 COM, 2026-11-06, lane uimisc probe2]:
//!          FillDown A1:B4 from a merged A1:B1 -> A2:B2, A3:B3, A4:B4 merged,
//!          each holding the value; FillDown A1:A6 from a merged A1:A2 ->
//!          A3:A4 and A5:A6; FillRight A1:D2 from a merged A1:A2 -> B1:B2,
//!          C1:C2, D1:D2; FillDown A1:A5 from the merged A1:A2 (A5 would be
//!          half a copy) and FillDown A1:A4 with A1:B1 merged (the selection
//!          holds half of the merge) change NOTHING and say nothing. A child of
//!          `data`, driving the real body over a real `AppState`.

use super::cross_sheet_recalc_tests::Workbook;
use super::*;
use engine::CellValue;

fn seed() -> crate::document_effect::DocumentEffect {
    crate::document_effect::test_seed_effect()
}

fn merge(wb: &Workbook, r0: u32, c0: u32, r1: u32, c1: u32) {
    wb.state
        .merged_regions
        .write(&seed())
        .unwrap()
        .insert(MergedRegion { start_row: r0, start_col: c0, end_row: r1, end_col: c1 });
}

fn merges(wb: &Workbook) -> Vec<(u32, u32, u32, u32)> {
    let mut v: Vec<(u32, u32, u32, u32)> = wb
        .state
        .merged_regions
        .read()
        .unwrap()
        .iter()
        .map(|m| (m.start_row, m.start_col, m.end_row, m.end_col))
        .collect();
    v.sort_unstable();
    v
}

fn fill(wb: &Workbook, source: (u32, u32, u32, u32), dest: (u32, u32, u32, u32)) -> Vec<CellData> {
    fill_range_core(&wb.state, &wb.file, &wb.files, &wb.pivots, &wb.pane, &wb.filters, source, dest).expect("fill")
}

fn undo_depth(wb: &Workbook) -> usize {
    wb.state.undo_stack.lock().unwrap().undo_depth()
}

fn undo(wb: &Workbook) {
    let transaction = wb.state.undo_stack.lock().unwrap().pop_undo().expect("nothing to undo");
    crate::undo_commands::apply_changes(
        &wb.state, &wb.file, &wb.files, &wb.pivots, &wb.slicer, &wb.filters, &wb.pane, &wb.timeline,
        transaction, true,
    );
}

fn text(s: &str) -> CellValue {
    CellValue::Text(s.to_string())
}

#[test]
fn bug0768_fill_down_from_a_merged_row_repeats_the_merge_in_one_undo_step() {
    let wb = Workbook::new(1);
    wb.set(0, 0, "x");
    merge(&wb, 0, 0, 0, 1);
    let depth = undo_depth(&wb);

    let updated = fill(&wb, (0, 0, 0, 1), (1, 0, 3, 1));
    assert_eq!(
        merges(&wb),
        vec![(0, 0, 0, 1), (1, 0, 1, 1), (2, 0, 2, 1), (3, 0, 3, 1)],
        "Excel merges A2:B2, A3:B3 and A4:B4"
    );
    for row in 1..=3 {
        assert_eq!(wb.value(0, row, 0), text("x"), "row {row}'s master holds the value");
        assert_eq!(wb.value(0, row, 1), CellValue::Empty, "row {row}'s slave is empty");
    }
    assert!(
        updated.iter().any(|c| c.row == 1 && c.col == 0 && c.col_span == 2),
        "the reply tells the grid A2 now spans two columns"
    );
    assert_eq!(undo_depth(&wb), depth + 1, "the merges are part of the fill's ONE undo step");

    undo(&wb);
    assert_eq!(merges(&wb), vec![(0, 0, 0, 1)], "one undo removes every merge the fill made");
    assert_eq!(wb.value(0, 1, 0), CellValue::Empty, "and the values");
}

#[test]
fn bug0768_fill_down_and_right_from_a_two_cell_merge_tile_it() {
    let wb = Workbook::new(1);
    wb.set(0, 0, "y");
    merge(&wb, 0, 0, 1, 0);
    fill(&wb, (0, 0, 1, 0), (2, 0, 5, 0));
    assert_eq!(merges(&wb), vec![(0, 0, 1, 0), (2, 0, 3, 0), (4, 0, 5, 0)], "A3:A4 and A5:A6");
    assert_eq!((wb.value(0, 2, 0), wb.value(0, 4, 0)), (text("y"), text("y")));

    let wb = Workbook::new(1);
    wb.set(0, 0, "z");
    merge(&wb, 0, 0, 1, 0);
    fill(&wb, (0, 0, 1, 0), (0, 1, 1, 3));
    assert_eq!(
        merges(&wb),
        vec![(0, 0, 1, 0), (0, 1, 1, 1), (0, 2, 1, 2), (0, 3, 1, 3)],
        "Fill Right: B1:B2, C1:C2 and D1:D2"
    );
}

#[test]
fn bug0768_a_fill_that_would_cut_the_pattern_or_cuts_a_merge_changes_nothing() {
    // A1:A5 from the merged A1:A2: A5 would be half of A5:A6.
    let wb = Workbook::new(1);
    wb.set(0, 0, "y");
    merge(&wb, 0, 0, 1, 0);
    crate::document_effect::mark_saved(&wb.file);
    let depth = undo_depth(&wb);
    assert!(fill(&wb, (0, 0, 1, 0), (2, 0, 4, 0)).is_empty());
    assert_eq!(merges(&wb), vec![(0, 0, 1, 0)]);
    assert_eq!(wb.value(0, 2, 0), CellValue::Empty, "Excel leaves A3 empty");
    assert_eq!(undo_depth(&wb), depth, "nothing recorded");
    assert!(!wb.file.is_dirty(), "and the document stays clean");

    // A1:A4 with A1:B1 merged: the source holds half of the merge.
    let wb = Workbook::new(1);
    wb.set(0, 0, "x");
    merge(&wb, 0, 0, 0, 1);
    assert!(fill(&wb, (0, 0, 0, 0), (1, 0, 3, 0)).is_empty());
    assert_eq!(wb.value(0, 1, 0), CellValue::Empty, "Excel leaves A2 empty");
    assert_eq!(merges(&wb), vec![(0, 0, 0, 1)]);
}

#[test]
fn bug0768_a_plain_fill_is_unchanged() {
    let wb = Workbook::new(1);
    wb.set(0, 0, "p");
    fill(&wb, (0, 0, 0, 0), (1, 0, 2, 0));
    assert!(merges(&wb).is_empty());
    assert_eq!(wb.value(0, 2, 0), text("p"));
}
