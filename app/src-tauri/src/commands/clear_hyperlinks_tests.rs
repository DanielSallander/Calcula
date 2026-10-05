//! FILENAME: app/src-tauri/src/commands/clear_hyperlinks_tests.rs
//! PURPOSE: `applyTo` "hyperlinks" and "removeHyperlinks" do Excel's Clear
//!          Hyperlinks and Remove Hyperlinks (measured live by the core-grid
//!          lane, 2026-10-04), instead of the placeholder that stood there.
//! CONTEXT: A `#[path]` child of `data`, driving `clear_hyperlinks_apply_to`
//!          over a real `AppState` and undoing through the real
//!          `apply_changes`.

use super::*;
use crate::pane_control::PaneControlState;
use crate::pivot::PivotState;
use crate::ribbon_filter::RibbonFilterState;
use engine::{Cell, CellValue};

struct Fx {
    state: AppState,
    file: FileState,
    files: UserFilesState,
    pivots: PivotState,
    pane: PaneControlState,
    filters: RibbonFilterState,
    slicer: SlicerState,
    timeline: crate::timeline_slicer::TimelineSlicerState,
}

impl Fx {
    /// A1 "link" bold-ish (style 3) WITH a link, B1 "plain" (style 4) without,
    /// A2 (style 5) with a link, C3 (style 6) with a link outside A1:B2.
    fn new() -> Self {
        let fx = Fx {
            state: crate::create_app_state(),
            file: FileState::default(),
            files: UserFilesState::default(),
            pivots: PivotState::new(),
            pane: PaneControlState::new(),
            filters: RibbonFilterState::new(),
            slicer: SlicerState::new(),
            timeline: crate::timeline_slicer::TimelineSlicerState::new(),
        };
        let seed = crate::document_effect::test_seed_effect();
        for (row, col, text, style) in [(0u32, 0u32, "link", 3usize), (0, 1, "plain", 4), (1, 0, "second", 5), (2, 2, "far", 6)] {
            let mut cell = Cell::new_text(text.to_string());
            cell.style_index = style;
            fx.state.grid.write(&seed).unwrap().set_cell(row, col, cell.clone());
            fx.state.grids.write(&seed).unwrap()[0].set_cell(row, col, cell);
        }
        let mut links = fx.state.hyperlinks.write(&seed).unwrap();
        let sheet = links.entry(0).or_default();
        for (row, col) in [(0u32, 0u32), (1, 0), (2, 2)] {
            sheet.insert((row, col), crate::hyperlinks::Hyperlink::new_url(row, col, 0, format!("https://example.com/{}{}", row, col)));
        }
        drop(links);
        fx
    }

    fn params(&self, apply_to: ClearApplyTo) -> ClearRangeParams {
        // A1:B2
        ClearRangeParams { start_row: 0, start_col: 0, end_row: 1, end_col: 1, apply_to, sheet_index: None }
    }

    fn style(&self, row: u32, col: u32) -> Option<usize> {
        self.state.grid.read().unwrap().get_cell(row, col).map(|c| c.style_index)
    }

    fn value(&self, row: u32, col: u32) -> CellValue {
        self.state.grid.read().unwrap().get_cell(row, col).map(|c| c.value.clone()).unwrap_or(CellValue::Empty)
    }

    fn linked(&self) -> Vec<(u32, u32)> {
        let mut v: Vec<(u32, u32)> =
            self.state.hyperlinks.read().unwrap().get(&0).map(|m| m.keys().copied().collect()).unwrap_or_default();
        v.sort_unstable();
        v
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
}

/// Remove Hyperlinks: each LINKED cell loses its link and its format; a cell
/// without a link keeps its format; values stay; ONE undo step puts it all
/// back.
#[test]
fn remove_hyperlinks_clears_the_links_and_only_the_linked_cells_formats() {
    let fx = Fx::new();
    let depth = fx.undo_depth();
    let result = clear_hyperlinks_apply_to(&fx.state, &fx.file, 0, &fx.params(ClearApplyTo::RemoveHyperlinks)).expect("remove");
    assert_eq!(result.count, 2, "two linked cells in A1:B2");
    assert_eq!(fx.linked(), vec![(2, 2)], "the links in A1:B2 are gone, C3's stays");
    assert_eq!(fx.style(0, 0), Some(0), "A1 is back to Normal");
    assert_eq!(fx.style(1, 0), Some(0), "A2 is back to Normal");
    assert_eq!(fx.style(0, 1), Some(4), "B1 has no link: it keeps its format");
    assert_eq!(fx.style(2, 2), Some(6), "outside the range nothing changes");
    assert_eq!(fx.value(0, 0), CellValue::Text("link".into()), "the value stays");
    assert_eq!(fx.state.grids.read().unwrap()[0].get_cell(0, 0).map(|c| c.style_index), Some(0), "both halves of the pair");
    assert!(result.updated_cells.iter().any(|c| c.row == 0 && c.col == 0 && c.style_index == 0), "the reply repaints A1");
    assert!(fx.file.is_dirty());
    assert_eq!(fx.undo_depth(), depth + 1, "ONE undo step");

    fx.undo();
    assert_eq!(fx.linked(), vec![(0, 0), (1, 0), (2, 2)], "undo puts the links back");
    assert_eq!((fx.style(0, 0), fx.style(1, 0)), (Some(3), Some(5)), "and the formats");
}

/// Clear Hyperlinks: the links go, every format stays.
#[test]
fn clear_hyperlinks_keeps_every_format() {
    let fx = Fx::new();
    let result = clear_hyperlinks_apply_to(&fx.state, &fx.file, 0, &fx.params(ClearApplyTo::Hyperlinks)).expect("clear");
    assert_eq!(result.count, 2);
    assert_eq!(fx.linked(), vec![(2, 2)]);
    assert_eq!((fx.style(0, 0), fx.style(1, 0), fx.style(0, 1)), (Some(3), Some(5), Some(4)));
    assert!(fx.file.is_dirty());
}

/// No link in the range (Excel greys both items): nothing changes, nothing is
/// recorded, the document stays clean.
#[test]
fn a_range_without_links_changes_nothing() {
    let fx = Fx::new();
    let depth = fx.undo_depth();
    let params = ClearRangeParams { start_row: 0, start_col: 1, end_row: 0, end_col: 1, apply_to: ClearApplyTo::RemoveHyperlinks, sheet_index: None };
    let result = clear_hyperlinks_apply_to(&fx.state, &fx.file, 0, &params).expect("no-op");
    assert_eq!(result.count, 0);
    assert_eq!(fx.style(0, 1), Some(4));
    assert!(!fx.file.is_dirty());
    assert_eq!(fx.undo_depth(), depth);
}

/// The off-sheet path refuses the two kinds rather than doing half of them
/// (the hyperlink store is cleared on the active sheet only).
#[test]
fn the_off_sheet_path_refuses_both_hyperlink_kinds() {
    let fx = Fx::new();
    for kind in [ClearApplyTo::Hyperlinks, ClearApplyTo::RemoveHyperlinks] {
        let err = clear_range_with_options_off_sheet(
            &fx.state, &fx.file, &fx.files, &fx.pivots, &fx.pane, &fx.filters, 0,
            ClearRangeParams { start_row: 0, start_col: 0, end_row: 1, end_col: 1, apply_to: kind, sheet_index: Some(0) },
        )
        .unwrap_err();
        assert!(err.contains("active sheet"), "{}", err);
    }
    assert!(!fx.file.is_dirty());
}
