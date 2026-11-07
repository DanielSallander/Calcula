//! FILENAME: app/src-tauri/src/commands/multi_area_tests.rs
//! PURPOSE: The multi-area doors (open-ledger programme 2026-11-04, lane
//!          multiarea):
//!          - BUG-0395: a clear over several areas is ALL OR NOTHING -- one
//!            refusing area clears no area. Excel 16 [LIVE, 2026-11-04, lane
//!            multiarea probe3]: A1 unlocked, C1 locked, sheet protected, A1 and
//!            C1 selected, Delete -- refused, A1 keeps its value.
//!          - BUG-0394: every area in ONE backend call, ONE undo step and ONE
//!            dependents cascade (`clear_range_with_options_areas`,
//!            `over_clear_areas`, `styles::apply_formatting_areas`).
//!          - Delete is Clear CONTENTS: the cell keeps its format (Excel), which
//!            the multi-area door does through the Contents arm.
//!          - BUG-0369, the backend half: clearing one side over a WHOLE column
//!            (the Borders runner's write beside a whole-column No Border)
//!            changes only the cells whose line it removes -- no cell is created
//!            and no column format is written for a neighbour with no line.
//! CONTEXT: A `#[path]` child of `data`, driving the real bodies through the
//!          `cross_sheet_recalc_tests::Workbook` harness with no Tauri runtime.

use super::cross_sheet_recalc_tests::Workbook;
use super::*;
use crate::api_types::{ClearArea, FormattingArea, FormattingParams};
use engine::CellValue;

fn seed() -> crate::document_effect::DocumentEffect {
    crate::document_effect::test_seed_effect()
}

/// Give (row, col) on the active sheet (both mirrors) the style `index`.
fn restyle(wb: &Workbook, row: u32, col: u32, index: usize) {
    {
        let mut grid = wb.state.grid.write(&seed()).unwrap();
        let mut cell = grid.get_cell(row, col).cloned().unwrap_or_else(engine::Cell::new);
        cell.style_index = index;
        grid.set_cell(row, col, cell);
    }
    let mut grids = wb.state.grids.write(&seed()).unwrap();
    let mut cell = grids[0].get_cell(row, col).cloned().unwrap_or_else(engine::Cell::new);
    cell.style_index = index;
    grids[0].set_cell(row, col, cell);
}

fn style_with(wb: &Workbook, edit: impl FnOnce(&mut engine::CellStyle)) -> usize {
    let mut registry = wb.state.style_registry.write(&seed()).unwrap();
    let mut style = registry.default_style().clone();
    edit(&mut style);
    registry.get_or_create_explicit(style)
}

fn protect_active(wb: &Workbook) {
    wb.state.sheet_protection.write(&seed()).unwrap().insert(
        0,
        crate::protection::SheetProtection { protected: true, ..Default::default() },
    );
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

fn area(r0: u32, c0: u32, r1: u32, c1: u32) -> ClearArea {
    ClearArea { start_row: r0, start_col: c0, end_row: r1, end_col: c1 }
}

/// The multi-area clear: `first` plus `more`, as the gesture sends it.
fn clear_areas(
    wb: &Workbook,
    first: (u32, u32, u32, u32),
    more: &[ClearArea],
    apply_to: ClearApplyTo,
) -> Result<ClearRangeResult, String> {
    clear_range_with_options_areas(
        &wb.state, &wb.file, &wb.files, &wb.pivots, &wb.pane, &wb.filters,
        ClearRangeParams {
            start_row: first.0,
            start_col: first.1,
            end_row: first.2,
            end_col: first.3,
            apply_to,
            sheet_index: None,
            target: None,
        },
        more,
    )
}

// ---------------------------------------------------------------------------
// BUG-0395 -- all or nothing
// ---------------------------------------------------------------------------

#[test]
fn bug0395_a_multi_area_clear_one_area_refuses_clears_no_area() {
    for apply_to in [ClearApplyTo::Contents, ClearApplyTo::All, ClearApplyTo::Formats] {
        let wb = Workbook::new(1);
        wb.set(0, 0, "1");
        wb.set(0, 2, "2");
        let bold_unlocked = style_with(&wb, |s| {
            s.locked = false;
            s.font.bold = true;
        });
        restyle(&wb, 0, 0, bold_unlocked);
        protect_active(&wb);
        crate::document_effect::mark_saved(&wb.file);
        let depth = undo_depth(&wb);

        // A1 (unlocked) first, C1 (locked) second: the LATER area refuses.
        let refused = clear_areas(&wb, (0, 0, 0, 0), &[area(0, 2, 0, 2)], apply_to);
        assert!(refused.is_err(), "{apply_to:?}: a locked area on a protected sheet must refuse the clear");
        assert_eq!(wb.value(0, 0, 0), CellValue::Number(1.0), "{apply_to:?}: A1 was cleared before C1 refused");
        assert!(
            wb.state.style_registry.read().unwrap().get(wb.state.grid.read().unwrap().effective_style_index(0, 0)).font.bold,
            "{apply_to:?}: A1 lost its format before C1 refused"
        );
        assert_eq!(undo_depth(&wb), depth, "{apply_to:?}: a refused clear records no step");
        assert!(!wb.file.is_dirty(), "{apply_to:?}: a refused clear leaves the document clean");
    }
}

// ---------------------------------------------------------------------------
// BUG-0394 -- one call, one step, one cascade
// ---------------------------------------------------------------------------

#[test]
fn bug0394_every_area_in_one_call_is_one_undo_step_and_one_cascade() {
    let wb = Workbook::new(1);
    wb.set(0, 0, "10");
    wb.set(0, 2, "20");
    wb.set(2, 1, "5");
    wb.set(0, 4, "=SUM(A1:C1)+B3");
    assert_eq!(wb.number(0, 0, 4), 35.0, "precondition");
    let depth = undo_depth(&wb);

    let result = clear_areas(&wb, (0, 0, 0, 0), &[area(0, 2, 0, 2), area(2, 1, 2, 1)], ClearApplyTo::Contents)
        .expect("nothing refuses here");
    assert_eq!(result.count, 3);
    for (r, c) in [(0, 0), (0, 2), (2, 1)] {
        assert_eq!(wb.value(0, r, c), CellValue::Empty, "({r},{c}) was not cleared");
    }
    assert_eq!(wb.number(0, 0, 4), 0.0, "the dependent of every area recalculated");
    // ONE cascade: the dependent is reported once, not once per area.
    let e1 = result.updated_cells.iter().filter(|c| c.row == 0 && c.col == 4).count();
    assert_eq!(e1, 1, "E1 was recalculated {e1} times -- one cascade per area, not one for the selection");
    assert_eq!(undo_depth(&wb), depth + 1, "every area is ONE undo step");

    // The cascade is not left deferred: a later single clear recalculates.
    wb.set(0, 0, "7");
    let single = clear_range_with_options_inner(
        &wb.state, &wb.file, &wb.files, &wb.pivots, &wb.pane, &wb.filters,
        ClearRangeParams { start_row: 0, start_col: 0, end_row: 0, end_col: 0, apply_to: ClearApplyTo::Contents, sheet_index: None, target: None },
    )
    .unwrap();
    assert!(single.updated_cells.iter().any(|c| c.row == 0 && c.col == 4), "a later clear's cascade was swallowed");

    // Back past the later single clear and the "7" typed before it; then ONE
    // Ctrl+Z restores every area of the multi-area clear.
    undo(&wb);
    undo(&wb);
    undo(&wb);
    assert_eq!(wb.value(0, 0, 0), CellValue::Number(10.0));
    assert_eq!(wb.value(0, 0, 2), CellValue::Number(20.0));
    assert_eq!(wb.value(0, 2, 1), CellValue::Number(5.0));
}

#[test]
fn delete_over_several_areas_keeps_every_cells_format() {
    // Delete is Clear Contents: Excel keeps the formatting.
    let wb = Workbook::new(1);
    wb.set(0, 0, "1");
    wb.set(3, 3, "2");
    let bold = style_with(&wb, |s| s.font.bold = true);
    restyle(&wb, 0, 0, bold);
    restyle(&wb, 3, 3, bold);
    clear_areas(&wb, (0, 0, 0, 0), &[area(3, 3, 3, 3)], ClearApplyTo::Contents).unwrap();
    for (r, c) in [(0, 0), (3, 3)] {
        assert_eq!(wb.value(0, r, c), CellValue::Empty);
        let index = wb.state.grid.read().unwrap().effective_style_index(r, c);
        assert!(wb.state.style_registry.read().unwrap().get(index).font.bold, "({r},{c}) lost its format to Delete");
    }
}

#[test]
fn bug0394_the_annotation_clears_take_every_area_as_one_step() {
    let wb = Workbook::new(1);
    let depth = undo_depth(&wb);
    let mut calls = Vec::new();
    let total = over_clear_areas(&wb.state, "Clear notes", (0, 0, 0, 0), &[area(2, 2, 2, 2), area(5, 1, 6, 1)], |r0, c0, r1, c1| {
        calls.push((r0, c0, r1, c1));
        // What each range clear records: one removed note, in the open step.
        wb.state.undo_stack.lock().unwrap().record_cell_change(0, r0, c0, None);
        1usize
    });
    assert_eq!(total, 3);
    assert_eq!(calls, vec![(0, 0, 0, 0), (2, 2, 2, 2), (5, 1, 6, 1)]);
    assert_eq!(undo_depth(&wb), depth + 1, "three areas made {} undo steps", undo_depth(&wb) - depth);
}

// ---------------------------------------------------------------------------
// BUG-0736 -- Remove Hyperlinks / Clear Hyperlinks over several areas
// ---------------------------------------------------------------------------

fn link(wb: &Workbook, row: u32, col: u32) {
    wb.state
        .hyperlinks
        .write(&seed())
        .unwrap()
        .entry(0)
        .or_default()
        .insert((row, col), crate::hyperlinks::Hyperlink::new_url(row, col, 0, format!("https://example.com/{row}/{col}")));
}

fn linked(wb: &Workbook) -> Vec<(u32, u32)> {
    let mut v: Vec<(u32, u32)> =
        wb.state.hyperlinks.read().unwrap().get(&0).map(|m| m.keys().copied().collect()).unwrap_or_default();
    v.sort_unstable();
    v
}

#[test]
fn bug0736_remove_hyperlinks_over_several_areas_is_one_call_and_one_step() {
    let wb = Workbook::new(1);
    let bold = style_with(&wb, |s| s.font.bold = true);
    for (r, c) in [(0u32, 0u32), (2, 2), (4, 4)] {
        wb.set(r, c, "x");
        restyle(&wb, r, c, bold);
    }
    link(&wb, 0, 0);
    link(&wb, 2, 2);
    link(&wb, 9, 9);
    crate::document_effect::mark_saved(&wb.file);
    let depth = undo_depth(&wb);

    let result = clear_areas(&wb, (0, 0, 0, 0), &[area(2, 2, 2, 2), area(4, 4, 4, 4)], ClearApplyTo::RemoveHyperlinks)
        .expect("Remove Hyperlinks over three areas is ONE call");
    assert_eq!(result.count, 2, "two linked cells across the areas");
    assert_eq!(linked(&wb), vec![(9, 9)], "both areas' links are gone, the link outside stays");
    let style_at = |r, c| wb.state.grid.read().unwrap().get_cell(r, c).map(|cell| cell.style_index);
    assert_eq!((style_at(0, 0), style_at(2, 2)), (Some(0), Some(0)), "each linked cell is back to Normal");
    assert_eq!(style_at(4, 4), Some(bold), "a cell without a link keeps its format");
    assert_eq!(undo_depth(&wb), depth + 1, "ONE undo step for every area");
    assert!(wb.file.is_dirty());

    undo(&wb);
    assert_eq!(linked(&wb), vec![(0, 0), (2, 2), (9, 9)], "one undo puts every area's links back");
    assert_eq!((style_at(0, 0), style_at(2, 2)), (Some(bold), Some(bold)), "and their formats");

    // Clear Hyperlinks the same way: the links go, the formats stay.
    let result = clear_areas(&wb, (0, 0, 0, 0), &[area(2, 2, 2, 2)], ClearApplyTo::Hyperlinks).expect("Clear Hyperlinks");
    assert_eq!(result.count, 2);
    assert_eq!(linked(&wb), vec![(9, 9)]);
    assert_eq!((style_at(0, 0), style_at(2, 2)), (Some(bold), Some(bold)));
}

#[test]
fn bug0736_remove_hyperlinks_a_refusing_later_area_removes_nothing() {
    let wb = Workbook::new(1);
    let bold_unlocked = style_with(&wb, |s| {
        s.locked = false;
        s.font.bold = true;
    });
    wb.set(0, 0, "a");
    wb.set(0, 2, "c");
    restyle(&wb, 0, 0, bold_unlocked);
    link(&wb, 0, 0);
    link(&wb, 0, 2);
    protect_active(&wb);
    crate::document_effect::mark_saved(&wb.file);
    let depth = undo_depth(&wb);

    let refused = clear_areas(&wb, (0, 0, 0, 0), &[area(0, 2, 0, 2)], ClearApplyTo::RemoveHyperlinks);
    assert!(refused.is_err(), "C1 is locked on a protected sheet: the gesture refuses");
    assert_eq!(linked(&wb), vec![(0, 0), (0, 2)], "A1's link went before C1 refused");
    assert_eq!(wb.state.grid.read().unwrap().get_cell(0, 0).map(|c| c.style_index), Some(bold_unlocked));
    assert_eq!(undo_depth(&wb), depth);
    assert!(!wb.file.is_dirty());
}

// ---------------------------------------------------------------------------
// BUG-0394 -- formatting over several areas
// ---------------------------------------------------------------------------

fn bold_params(rows: Vec<u32>, cols: Vec<u32>) -> FormattingParams {
    FormattingParams { rows, cols, bold: Some(true), ..Default::default() }
}

fn bold_at(wb: &Workbook, row: u32, col: u32) -> bool {
    let index = wb.state.grid.read().unwrap().effective_style_index(row, col);
    wb.state.style_registry.read().unwrap().get(index).font.bold
}

#[test]
fn bug0394_formatting_every_area_in_one_call_is_one_undo_step() {
    let wb = Workbook::new(1);
    let depth = undo_depth(&wb);
    let more = vec![
        FormattingArea { rows: vec![2], cols: vec![2] },
        FormattingArea { rows: vec![4, 5], cols: vec![4] },
    ];
    let result = crate::commands::styles::apply_formatting_areas(&wb.state, &wb.file, &bold_params(vec![0], vec![0]), &[], &more)
        .expect("nothing refuses here");
    for (r, c) in [(0, 0), (2, 2), (4, 4), (5, 4)] {
        assert!(bold_at(&wb, r, c), "({r},{c}) is not bold");
        assert!(result.cells.iter().any(|cell| cell.row == r && cell.col == c), "({r},{c}) is not reported");
    }
    assert!(!bold_at(&wb, 1, 1));
    assert_eq!(undo_depth(&wb), depth + 1, "every area is ONE undo step");
    undo(&wb);
    for (r, c) in [(0, 0), (2, 2), (4, 4), (5, 4)] {
        assert!(!bold_at(&wb, r, c), "one undo left ({r},{c}) bold");
    }
}

#[test]
fn bug0394_a_later_area_too_large_to_style_cell_by_cell_refuses_before_any_write() {
    let wb = Workbook::new(1);
    crate::document_effect::mark_saved(&wb.file);
    let huge = FormattingArea { rows: (0..3000).collect(), cols: (0..2000).collect() };
    let refused =
        crate::commands::styles::apply_formatting_areas(&wb.state, &wb.file, &bold_params(vec![0], vec![5000]), &[], &[huge]);
    assert!(refused.is_err(), "6,000,000 cells styled one by one must be refused");
    assert!(!bold_at(&wb, 0, 5000), "the first area was written before the second refused");
    assert!(!wb.file.is_dirty(), "a refused format leaves the document clean");
}

// ---------------------------------------------------------------------------
// BUG-0369 -- the backend half of the whole-column shared edge
// ---------------------------------------------------------------------------

#[test]
fn bug0369_clearing_a_whole_columns_right_side_touches_only_the_cells_with_that_line() {
    let wb = Workbook::new(1);
    let right = style_with(&wb, |s| {
        s.borders.right = engine::BorderStyle { width: 1, style: engine::BorderLineStyle::Solid, ..Default::default() };
    });
    wb.set(0, 0, "x");
    restyle(&wb, 0, 0, right);
    restyle(&wb, 499_999, 0, right);
    wb.set(3, 0, "plain");

    let params: FormattingParams = serde_json::from_value(serde_json::json!({
        "rows": { "first": 0, "last": engine::EXCEL_MAX_ROW_INDEX },
        "cols": [0],
        "borderRight": { "style": "none", "color": "#000000" },
    }))
    .expect("the runner's wire shape");
    let result = crate::commands::styles::apply_formatting_core(&wb.state, &wb.file, &params, &[]).unwrap();

    let grid = wb.state.grid.read().unwrap();
    let registry = wb.state.style_registry.read().unwrap();
    for row in [0, 499_999] {
        let shown = registry.get(grid.effective_style_index(row, 0));
        assert!(shown.borders.right.width == 0 || shown.borders.right.style == engine::BorderLineStyle::None, "A{} kept its right line", row + 1);
    }
    assert!(grid.get_cell(1, 0).is_none(), "A2 had no line and no cell: none may be created");
    assert!(grid.column_styles.get(&0).copied().unwrap_or(0) == 0, "column A gained a column format for a line it never had");
    assert_eq!(grid.get_cell(3, 0).map(|c| c.style_index), Some(0), "A4 had no line: its style must not be rewritten");
    let mut reported: Vec<u32> = result.cells.iter().map(|c| c.row).collect();
    reported.sort_unstable();
    assert_eq!(reported, vec![0, 499_999], "only the two cells whose line went are written");
}

// ---------------------------------------------------------------------------
// BUG-0355 -- Increase / Decrease Decimal counts the decimals SHOWN
// ---------------------------------------------------------------------------

/// Excel 16 [LIVE, 2026-11-04, lane multiarea probe3]: 1234.5678 in a default
/// column SHOWS `1234,568`; Increase Decimal makes it `0,0000`, Decrease `0,00`.
#[test]
fn bug0355_general_steps_from_the_decimals_the_column_shows() {
    use crate::commands::styles::next_decimal_format_shown;
    use engine::NumberFormat;
    let value = CellValue::Number(1234.5678);
    let number = |d: u8| Some(NumberFormat::Number { decimal_places: d, use_thousands_separator: false });
    assert_eq!(next_decimal_format_shown(&NumberFormat::General, Some(&value), 1, Some("1234,568")), number(4));
    assert_eq!(next_decimal_format_shown(&NumberFormat::General, Some(&value), -1, Some("1234,568")), number(2));
    assert_eq!(next_decimal_format_shown(&NumberFormat::General, Some(&value), 1, Some("1234.568")), number(4));
    // A column wide enough to show everything: the full rendering's 4 -> 5.
    assert_eq!(next_decimal_format_shown(&NumberFormat::General, Some(&value), 1, None), number(5));
    // Rounded to a whole number at its width: Increase gives one decimal.
    assert_eq!(next_decimal_format_shown(&NumberFormat::General, Some(&value), 1, Some("1235")), number(1));
    // Scientific at its width keeps the scientific kind.
    assert_eq!(
        next_decimal_format_shown(&NumberFormat::General, Some(&CellValue::Number(1.23e9)), 1, Some("1,2E+09")),
        Some(NumberFormat::Scientific { decimal_places: 2 })
    );
    // Anything that is no General number display is ignored, never trusted.
    for junk in ["####", "abc", "", "1.2.3", "E+09"] {
        assert_eq!(next_decimal_format_shown(&NumberFormat::General, Some(&value), 1, Some(junk)), number(5), "{junk:?}");
    }
    // A non-General format never reads it.
    assert_eq!(
        next_decimal_format_shown(&NumberFormat::Number { decimal_places: 2, use_thousands_separator: false }, Some(&value), 1, Some("1234,568")),
        number(3)
    );
}
