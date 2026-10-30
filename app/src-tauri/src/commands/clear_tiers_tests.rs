//! FILENAME: app/src-tauri/src/commands/clear_tiers_tests.rs
//! PURPOSE: The clear commands after BUG-0354 made whole-line formats row /
//!          column TIERS (round-3 fix lane "clear", 2026-10-29; round-5 lane
//!          "clearfmt": almost-whole clears, rev3A#2 / #7, and the active
//!          sheet's plan in the group's gate, rev3A#5):
//!          - review A#1: Clear Formats / Clear All remove a whole-row or
//!            whole-column format, on the active sheet, an addressed off-sheet
//!            clear and the sheet group, with an exact undo; every position of
//!            the cleared rectangle SHOWS Normal afterwards, even where a row
//!            or column format that stays crosses it.
//!          - review G#1: a grouped clear is all-or-nothing -- every sheet
//!            (the active one included) is gated for every area before any
//!            write.
//!          - review G#8: a grouped clear of a subscribed sheet records the
//!            subscriber overrides, as the active sheet's clear does.
//!          - review G#9: every area of every grouped sheet in ONE call, ONE
//!            undo step, ONE recalculation.
//! CONTEXT: A `#[path]` child of `data`, so it drives the real command bodies
//!          (`clear_range_with_options_inner`, `clear_range_with_options_off_sheet`,
//!          `clear_range_on_sheets_inner`) and undoes through the real
//!          `apply_changes`, with no Tauri runtime.
//!
//! Excel facts were measured live on Excel 16 (fresh unsaved workbooks,
//! Range.ClearFormats / Range.Clear, read back through Font.Bold / Font.Italic
//! and UsedRange) on 2026-10-29:
//!   P1 row 5 bold, Columns(C).ClearFormats       -> C5 plain, D5 bold
//!   P2 column C bold, C1:C10 ClearFormats        -> C1:C10 plain, C11 bold, used C1:C10
//!   P3 column C bold, Rows(5).ClearFormats       -> C5 plain, C6 bold
//!   P4 column C bold, Columns(C).ClearFormats    -> C1 and C100 plain (value kept)
//!   P6 all bold + row 5 italic, Cells.ClearFormats -> everything plain, used A1
//!   P9 columns C:D bold, row 5 italic, Rows(5).ClearFormats -> C5 plain, C7 bold
//!   P11 row 5 bold over column C italic, Rows(5).Clear -> C5 plain and empty, C6 italic

use super::*;
use crate::pane_control::PaneControlState;
use crate::pivot::PivotState;
use crate::ribbon_filter::RibbonFilterState;
use engine::{Cell, CellStyle, CellValue};

const LAST_ROW: u32 = engine::EXCEL_MAX_ROW_INDEX;
const LAST_COL: u32 = engine::EXCEL_MAX_COL_INDEX;

struct Book {
    state: AppState,
    file: FileState,
    files: UserFilesState,
    pivots: PivotState,
    pane: PaneControlState,
    filters: RibbonFilterState,
    slicer: SlicerState,
    timeline: crate::timeline_slicer::TimelineSlicerState,
}

impl Book {
    /// `sheets` sheets, sheet 0 active.
    fn new(sheets: usize) -> Self {
        let state = crate::create_app_state();
        let seed = crate::document_effect::test_seed_effect;
        for i in 1..sheets {
            state.grids.write(&seed()).unwrap().push(Grid::new());
            state.sheet_names.write(&seed()).unwrap().push(format!("Sheet{}", i + 1));
            state.all_column_widths.write(&seed()).unwrap().push(Default::default());
            state.all_row_heights.write(&seed()).unwrap().push(Default::default());
            state.all_user_hidden_rows.write(&seed()).unwrap().push(Default::default());
            state.all_user_hidden_cols.write(&seed()).unwrap().push(Default::default());
            state
                .sheet_ids
                .write(&seed())
                .unwrap()
                .push(identity::SheetId::from_bytes(identity::generate_uuid_v7()));
        }
        {
            let mut all = state.all_merged_regions.write(&seed()).unwrap();
            while all.len() < sheets {
                all.push(Default::default());
            }
        }
        Book {
            state,
            file: FileState::default(),
            files: UserFilesState::default(),
            pivots: PivotState::new(),
            pane: PaneControlState::new(),
            filters: RibbonFilterState::new(),
            slicer: SlicerState::new(),
            timeline: crate::timeline_slicer::TimelineSlicerState::new(),
        }
    }

    fn style(&self, edit: impl FnOnce(&mut CellStyle)) -> usize {
        let seed = crate::document_effect::test_seed_effect();
        let mut registry = self.state.style_registry.write(&seed).unwrap();
        let mut style = registry.default_style().clone();
        edit(&mut style);
        registry.get_or_create_explicit(style)
    }

    fn bold(&self) -> usize {
        self.style(|s| s.font.bold = true)
    }

    fn italic(&self) -> usize {
        self.style(|s| s.font.italic = true)
    }

    /// Run `edit` on sheet `sheet`'s grid -- and on the active mirror too when
    /// it is the active sheet 0 -- as a load would have left them.
    fn seed(&self, sheet: usize, edit: impl Fn(&mut Grid)) {
        let seed = crate::document_effect::test_seed_effect();
        if sheet == 0 {
            edit(&mut self.state.grid.write(&seed).unwrap());
        }
        edit(&mut self.state.grids.write(&seed).unwrap()[sheet]);
    }

    /// The style a position on `sheet` SHOWS (both mirrors agree for sheet 0).
    fn shown(&self, sheet: usize, row: u32, col: u32) -> CellStyle {
        let grids = self.state.grids.read().unwrap();
        let idx = grids[sheet].effective_style_index(row, col);
        if sheet == 0 {
            let mirror = self.state.grid.read().unwrap();
            assert_eq!(
                mirror.effective_style_index(row, col),
                idx,
                "the active sheet's two copies disagree at ({row}, {col})"
            );
        }
        self.state.style_registry.read().unwrap().get(idx).clone()
    }

    fn bold_at(&self, sheet: usize, row: u32, col: u32) -> bool {
        self.shown(sheet, row, col).font.bold
    }

    fn italic_at(&self, sheet: usize, row: u32, col: u32) -> bool {
        self.shown(sheet, row, col).font.italic
    }

    fn value(&self, sheet: usize, row: u32, col: u32) -> CellValue {
        self.state.grids.read().unwrap()[sheet]
            .get_cell(row, col)
            .map(|c| c.value.clone())
            .unwrap_or(CellValue::Empty)
    }

    fn undo_depth(&self) -> usize {
        self.state.undo_stack.lock().unwrap().undo_depth()
    }

    /// Undo through the REAL restore path, as Ctrl+Z does.
    fn undo(&self) {
        let transaction = self.state.undo_stack.lock().unwrap().pop_undo().expect("nothing to undo");
        crate::undo_commands::apply_changes(
            &self.state, &self.file, &self.files, &self.pivots, &self.slicer, &self.filters,
            &self.pane, &self.timeline, transaction, true,
        );
    }

    /// The ACTIVE sheet's Clear (the Home tab's Clear menu on the sheet in front).
    fn clear(&self, rect: (u32, u32, u32, u32), apply_to: ClearApplyTo) -> Result<ClearRangeResult, String> {
        clear_range_with_options_inner(
            &self.state, &self.file, &self.files, &self.pivots, &self.pane, &self.filters,
            ClearRangeParams {
                start_row: rect.0,
                start_col: rect.1,
                end_row: rect.2,
                end_col: rect.3,
                apply_to,
                sheet_index: None,
                target: None,
            },
        )
    }

    /// A script's / the command line's clear ADDRESSED to a non-active sheet.
    fn clear_off_sheet(&self, sheet: usize, rect: (u32, u32, u32, u32), apply_to: ClearApplyTo) -> Result<ClearRangeResult, String> {
        clear_range_with_options_off_sheet(
            &self.state, &self.file, &self.files, &self.pivots, &self.pane, &self.filters,
            sheet,
            ClearRangeParams {
                start_row: rect.0,
                start_col: rect.1,
                end_row: rect.2,
                end_col: rect.3,
                apply_to,
                sheet_index: Some(sheet),
                target: None,
            },
        )
    }

    /// The sheet group's clear door.
    fn clear_group(&self, sheets: &[usize], areas: &[(u32, u32, u32, u32)], apply_to: ClearApplyTo) -> Result<Vec<usize>, String> {
        clear_range_on_sheets_inner(
            &self.state, &self.file, &self.files, &self.pivots, &self.pane, &self.filters,
            sheets,
            areas,
            apply_to,
        )
    }

    fn protect(&self, sheet: usize) {
        self.state.sheet_protection.write(&crate::document_effect::test_seed_effect()).unwrap().insert(
            sheet,
            crate::protection::SheetProtection { protected: true, ..Default::default() },
        );
    }

    /// Record that sheet `index` was materialised by a subscribed application.
    fn subscribe(&self, index: usize) {
        let seed = crate::document_effect::test_seed_effect();
        let local = self.state.sheet_ids.read().unwrap()[index];
        let name = self.state.sheet_names.read().unwrap()[index].clone();
        self.state.subscriptions.write(&seed).unwrap().subscriptions.push(calp::manifest::Subscription {
            package_name: "Budget".to_string(),
            registry_url: "C:/workspace".to_string(),
            version_pin: "latest".to_string(),
            resolved_version: "1.0.0".to_string(),
            resolved_at: "2026-10-29T00:00:00Z".to_string(),
            sheets: vec![calp::manifest::SubscribedSheet {
                package_sheet_id: identity::SheetId::from_bytes(identity::generate_uuid_v7()),
                local_sheet_id: local,
                local_name: name,
                extra: Default::default(),
            }],
            environment: None,
            data_source_configs: Vec::new(),
            objects: Vec::new(),
            detached_sheets: Vec::new(),
            detached_local_sheets: Vec::new(),
            upstream_removed_sheets: Vec::new(),
            extra: Default::default(),
        });
    }

    fn overrides_on(&self, sheet: usize) -> Vec<(u32, u32)> {
        let sid = self.state.sheet_ids.read().unwrap()[sheet];
        let mut at: Vec<(u32, u32)> = self
            .state
            .override_layer
            .read()
            .unwrap()
            .overrides_for_sheet(sid)
            .iter()
            .map(|o| o.position)
            .collect();
        at.sort_unstable();
        at
    }
}

fn number(n: f64) -> Cell {
    Cell::new_number(n)
}

// ---------------------------------------------------------------------------
// A#1 -- the ACTIVE sheet
// ---------------------------------------------------------------------------

/// THE REPORTED SCENARIO, through the real formatting command: click row
/// header 5, Ctrl+B (one row tier since BUG-0354), then Clear Formats on the
/// row. The row reads plain -- a value typed there afterwards too -- and ONE
/// Ctrl+Z brings the bold back.
#[test]
fn whole_row_bold_then_clear_formats_reads_plain_and_one_undo_brings_it_back() {
    let b = Book::new(1);
    let params = crate::api_types::FormattingParams {
        rows: vec![4],
        cols: (0..=LAST_COL).collect(),
        bold: Some(true),
        ..Default::default()
    };
    crate::commands::styles::apply_formatting_core(&b.state, &b.file, &params, &[]).expect("Bold on row 5");
    assert!(b.bold_at(0, 4, 2), "precondition: row 5 is bold through its tier");
    assert!(b.state.grid.read().unwrap().row_styles.contains_key(&4), "precondition: a row tier, not cells");
    let steps = b.undo_depth();

    b.clear((4, 0, 4, LAST_COL), ClearApplyTo::Formats).expect("Clear Formats on row 5");

    assert!(!b.bold_at(0, 4, 2), "row 5 is still bold after Clear Formats");
    assert!(!b.bold_at(0, 4, 16_000), "a value typed into row 5 afterwards would be bold");
    assert!(
        !b.state.grid.read().unwrap().row_styles.contains_key(&4),
        "with no column format anywhere, the row's format is simply gone (Excel's file has none)"
    );
    assert_eq!(b.undo_depth(), steps + 1, "Clear Formats is ONE undo step");

    b.undo();
    assert!(b.bold_at(0, 4, 2), "one Ctrl+Z must bring the row's bold back");
    assert!(b.bold_at(0, 4, 16_000));
}

/// P4: column C bold, Clear Formats on column C removes the column format
/// (a value in it keeps its value); Clear All on column D removes it too, with
/// the value. Undo restores both exactly.
#[test]
fn clear_formats_and_clear_all_on_a_whole_column_remove_its_format() {
    let b = Book::new(1);
    let bold = b.bold();
    b.seed(0, |g| {
        g.set_column_style(2, bold);
        g.set_column_style(3, bold);
        g.set_cell(0, 2, number(1.0));
        g.set_cell(6, 3, number(7.0));
    });

    b.clear((0, 2, LAST_ROW, 2), ClearApplyTo::Formats).expect("Clear Formats on C");
    assert!(!b.bold_at(0, 0, 2), "C1 keeps the column's bold");
    assert!(!b.bold_at(0, 99, 2), "C100 keeps the column's bold");
    assert_eq!(b.value(0, 0, 2), CellValue::Number(1.0), "Clear Formats keeps the value");
    assert!(!b.state.grids.read().unwrap()[0].column_styles.contains_key(&2), "column C's format is gone");

    b.clear((0, 3, LAST_ROW, 3), ClearApplyTo::All).expect("Clear All on D");
    assert!(!b.bold_at(0, 6, 3), "D7 keeps the column's bold after Clear All");
    assert_eq!(b.value(0, 6, 3), CellValue::Empty, "Clear All removes the value");
    assert!(!b.state.grids.read().unwrap()[0].column_styles.contains_key(&3));

    b.undo();
    assert!(b.bold_at(0, 6, 3), "undo brings column D's bold back");
    assert_eq!(b.value(0, 6, 3), CellValue::Number(7.0), "and its value");
    b.undo();
    assert!(b.bold_at(0, 99, 2), "undo brings column C's bold back");
}

/// P1 and P10: clearing whole columns that a ROW format crosses. The row tier
/// outranks the column, so the crossing gets an explicit-Normal cell of its
/// own -- C5 plain, D5 (outside the clear) still bold.
#[test]
fn a_row_format_crossing_cleared_columns_is_written_plain_at_the_crossing() {
    let b = Book::new(1);
    let bold = b.bold();
    b.seed(0, |g| g.set_row_style(4, bold));

    b.clear((0, 2, LAST_ROW, 4), ClearApplyTo::Formats).expect("Clear Formats on C:E");
    for col in 2..=4 {
        assert!(!b.bold_at(0, 4, col), "row 5 still shows bold at column {col} inside the clear");
    }
    assert!(b.bold_at(0, 4, 5), "F5 is outside the clear and keeps row 5's bold");
    assert!(b.bold_at(0, 4, 1), "B5 too");

    b.undo();
    assert!(b.bold_at(0, 4, 3), "undo restores D5's bold");
    assert!(b.state.grid.read().unwrap().get_cell(4, 3).is_none(), "and removes the crossing cell it wrote");
}

/// P2: a PARTIAL clear inside a formatted column writes each position plain
/// (Excel writes those cells; the used range grows to them). C11 stays bold.
#[test]
fn a_partial_clear_inside_a_formatted_column_writes_each_position_plain() {
    let b = Book::new(1);
    let bold = b.bold();
    b.seed(0, |g| {
        g.set_column_style(2, bold);
        g.set_cell(3, 2, number(4.0));
    });

    let result = b.clear((0, 2, 9, 2), ClearApplyTo::Formats).expect("Clear Formats on C1:C10");
    for row in 0..=9 {
        assert!(!b.bold_at(0, row, 2), "C{} keeps the column's bold", row + 1);
    }
    assert!(b.bold_at(0, 10, 2), "C11 is outside the clear");
    assert_eq!(b.value(0, 3, 2), CellValue::Number(4.0), "the stored value stays");
    assert_eq!(result.count, 10, "ten positions written");

    // Clear All over the same column: the cleared cell must not inherit the
    // bold back either.
    b.clear((0, 2, 9, 2), ClearApplyTo::All).expect("Clear All on C1:C10");
    assert!(!b.bold_at(0, 3, 2), "C4 inherits the column's bold after Clear All");
    assert_eq!(b.value(0, 3, 2), CellValue::Empty);
}

/// P3 / P9 / P11: clearing a WHOLE ROW that a column format crosses. The row
/// keeps an explicit Normal format of its own (it outranks every column, as
/// Excel's `<row customFormat="1">`); other rows keep the column's format.
#[test]
fn clearing_a_whole_row_over_a_formatted_column_keeps_the_row_plain() {
    let b = Book::new(1);
    let bold = b.bold();
    let italic = b.italic();
    b.seed(0, |g| {
        g.set_column_style(2, bold);
        g.set_row_style(4, italic);
        g.set_cell(4, 2, number(9.0));
    });

    b.clear((4, 0, 4, LAST_COL), ClearApplyTo::All).expect("Clear All on row 5");
    assert!(!b.bold_at(0, 4, 2), "C5 shows column C's bold through the cleared row");
    assert!(!b.italic_at(0, 4, 2), "C5 keeps row 5's italic");
    assert!(!b.italic_at(0, 4, 7), "H5 keeps row 5's italic");
    assert_eq!(b.value(0, 4, 2), CellValue::Empty, "Clear All removes C5's value");
    assert!(b.bold_at(0, 5, 2), "C6 keeps the column's bold");

    b.undo();
    assert!(b.italic_at(0, 4, 7), "undo restores row 5's italic");
    assert_eq!(b.value(0, 4, 2), CellValue::Number(9.0));
}

/// P6: Select All, Clear Formats leaves no row or column format anywhere.
#[test]
fn select_all_clear_formats_leaves_no_line_format() {
    let b = Book::new(1);
    let bold = b.bold();
    let italic = b.italic();
    b.seed(0, |g| {
        for col in [0, 5, 900] {
            g.set_column_style(col, bold);
        }
        g.set_row_style(4, italic);
        g.set_row_style(40_000, italic);
        let mut cell = number(2.0);
        cell.style_index = italic;
        g.set_cell(4, 5, cell);
    });

    b.clear((0, 0, LAST_ROW, LAST_COL), ClearApplyTo::Formats).expect("Select All, Clear Formats");
    let grids = b.state.grids.read().unwrap();
    assert!(grids[0].column_styles.is_empty(), "a column format survived Select All Clear Formats");
    assert!(grids[0].row_styles.is_empty(), "a row format survived Select All Clear Formats");
    assert_eq!(grids[0].get_cell(4, 5).map(|c| c.style_index), Some(0), "the cell's own format is gone");
    assert_eq!(grids[0].cells.len(), 1, "no cell was materialised");
}

/// The one refusal left: a whole-column clear whose crossings with row
/// formats would materialise millions of cells. Refused before anything is
/// written -- nothing changed, nothing recorded, the document clean.
#[test]
fn a_clear_that_would_materialise_millions_of_crossings_is_refused_cleanly() {
    let b = Book::new(1);
    let bold = b.bold();
    b.seed(0, |g| {
        for row in 0..200 {
            g.set_row_style(row * 3, bold);
        }
        g.set_column_style(7, bold);
    });

    let refusal = b.clear((0, 0, LAST_ROW, LAST_COL - 1), ClearApplyTo::Formats);
    assert!(refusal.is_err(), "200 row formats x 16,383 columns must be refused, got {refusal:?}");
    assert!(!b.file.is_dirty(), "a refusal must not dirty the document");
    assert_eq!(b.undo_depth(), 0, "a refusal must record nothing");
    assert!(b.bold_at(0, 0, 7), "nothing was cleared");
    assert!(b.state.grid.read().unwrap().column_styles.contains_key(&7));
}

// ---------------------------------------------------------------------------
// A#1 -- an addressed off-sheet clear (scripts, the command line; a floating
// grid's backing sheet takes the same body)
// ---------------------------------------------------------------------------

#[test]
fn an_off_sheet_clear_formats_removes_the_column_format_and_undo_restores_it() {
    let b = Book::new(2);
    let bold = b.bold();
    b.seed(1, |g| {
        g.set_column_style(2, bold);
        g.set_cell(5, 2, number(3.0));
    });

    b.clear_off_sheet(1, (0, 2, LAST_ROW, 2), ClearApplyTo::Formats).expect("off-sheet Clear Formats");
    assert!(!b.bold_at(1, 5, 2), "Sheet2!C6 keeps the column's bold");
    assert!(!b.bold_at(1, 500, 2), "Sheet2!C501 keeps the column's bold");
    assert_eq!(b.undo_depth(), 1, "one undo step");

    b.undo();
    assert!(b.bold_at(1, 500, 2), "undo restores the column format");
}

// ---------------------------------------------------------------------------
// G#1 / G#8 / G#9 -- the sheet group
// ---------------------------------------------------------------------------

/// G#1, Excel [LIVE]: Sheet2 protected, Sheet1 + Sheet2 grouped, Clear
/// Contents -> NOTHING is cleared on either sheet. The door gates every listed
/// sheet, the ACTIVE one included, before any write; the gesture calls it
/// FIRST, so its refusal stops the active sheet's clear too.
#[test]
fn a_grouped_clear_with_one_protected_sheet_writes_nothing_anywhere() {
    for apply_to in [ClearApplyTo::Contents, ClearApplyTo::Formats, ClearApplyTo::All] {
        let b = Book::new(3);
        let bold = b.bold();
        for sheet in 0..3 {
            b.seed(sheet, |g| {
                let mut cell = number(1.0 + sheet as f64);
                cell.style_index = bold;
                g.set_cell(0, 0, cell);
            });
        }
        b.protect(2);

        let refusal = b.clear_group(&[0, 1, 2], &[(0, 0, 0, 0)], apply_to);
        assert!(refusal.is_err(), "{apply_to:?}: a protected grouped sheet must refuse the whole group");
        for sheet in 0..3 {
            assert_eq!(b.value(sheet, 0, 0), CellValue::Number(1.0 + sheet as f64), "{apply_to:?}: sheet {sheet} was cleared");
            assert!(b.bold_at(sheet, 0, 0), "{apply_to:?}: sheet {sheet} lost its format");
        }
        assert!(!b.file.is_dirty(), "{apply_to:?}: a refusal must not dirty the document");
        assert_eq!(b.undo_depth(), 0, "{apply_to:?}: a refusal must record nothing");
    }
}

/// The ACTIVE sheet's own refusal comes from the same door (the gesture's
/// active write follows it): a protected active sheet stops the group's
/// clear before any grouped sheet is touched. And with only the active sheet
/// listed the door is a pure gate: it writes nothing and stays clean.
#[test]
fn the_active_sheet_is_gated_too_and_alone_is_a_pure_gate() {
    let b = Book::new(2);
    b.seed(0, |g| g.set_cell(0, 0, number(1.0)));
    b.seed(1, |g| g.set_cell(0, 0, number(2.0)));
    b.protect(0);
    assert!(b.clear_group(&[0, 1], &[(0, 0, 0, 0)], ClearApplyTo::Contents).is_err(), "protected active sheet");
    assert_eq!(b.value(1, 0, 0), CellValue::Number(2.0), "the grouped sheet was cleared past the active sheet's refusal");

    let b = Book::new(2);
    b.seed(0, |g| g.set_cell(0, 0, number(1.0)));
    assert_eq!(b.clear_group(&[0], &[(0, 0, 0, 0)], ClearApplyTo::All), Ok(Vec::new()));
    assert_eq!(b.value(0, 0, 0), CellValue::Number(1.0), "the door wrote the active sheet");
    assert!(!b.file.is_dirty(), "a pure gate must not dirty the document");
}

/// G#9: every area of every grouped sheet in ONE call -- one undo step that
/// one Ctrl+Z takes back whole, without switching the user to another sheet
/// (the grouped sheets' restores name no target sheet).
#[test]
fn every_area_of_every_grouped_sheet_is_one_call_one_step_and_one_recalc() {
    let b = Book::new(4);
    for sheet in 1..=2 {
        b.seed(sheet, |g| {
            g.set_cell(0, 0, number(1.0));
            g.set_cell(5, 5, number(10.0));
        });
    }
    let written = b
        .clear_group(&[0, 1, 2], &[(0, 0, 0, 0), (5, 5, 6, 6)], ClearApplyTo::Contents)
        .expect("grouped Delete over two areas");
    assert_eq!(written, vec![1, 2], "the door names the sheets it wrote (the active one is the caller's)");
    for sheet in 1..=2 {
        assert_eq!(b.value(sheet, 0, 0), CellValue::Empty, "sheet {sheet}, area 1");
        assert_eq!(b.value(sheet, 5, 5), CellValue::Empty, "sheet {sheet}, area 2");
    }
    assert_eq!(b.undo_depth(), 1, "two sheets x two areas must be ONE undo step");

    b.undo();
    for sheet in 1..=2 {
        assert_eq!(b.value(sheet, 0, 0), CellValue::Number(1.0), "undo restores sheet {sheet}, area 1");
        assert_eq!(b.value(sheet, 5, 5), CellValue::Number(10.0), "undo restores sheet {sheet}, area 2");
    }
    assert_eq!(*b.state.active_sheet.read().unwrap(), 0, "undoing a GROUP clear switched the user away from the sheet in front");
}

/// G#8: a grouped Delete on a SUBSCRIBED background sheet records a subscriber
/// override per cleared cell -- what the active sheet's clear does -- so an
/// application refresh does not put the cleared values back.
#[test]
fn a_grouped_clear_of_a_subscribed_sheet_records_the_overrides() {
    let b = Book::new(2);
    b.seed(1, |g| {
        g.set_cell(1, 1, number(5.0));
        g.set_cell(2, 1, number(6.0));
    });
    b.subscribe(1);
    assert!(b.overrides_on(1).is_empty(), "precondition: no overrides");

    b.clear_group(&[0, 1], &[(1, 1, 4, 1)], ClearApplyTo::Contents).expect("grouped Delete on B2:B5");
    assert_eq!(b.overrides_on(1), vec![(1, 1), (2, 1)], "the cleared cells of the subscribed sheet carry no override");
}

// ---------------------------------------------------------------------------
// Round-3 review rev3A#2 / rev3A#7 / rev3A#5 -- almost-whole clears, the
// row-format exception, and the active sheet's plan in the group's gate
// ---------------------------------------------------------------------------
//
// Excel 16 [LIVE, 2026-10-29: review scratchpad rev3A/probe-clear-almost.ps1
// and lane clearfmt probe.ps1, fresh unsaved workbooks, each saved as .xlsx
// and its sheet XML read back]:
//   Q1 column C bold, C1 = "hdrC", C2:C1048576 ClearFormats -> <c r=C1 s=bold>,
//      no column format, used range A1:C1
//   Q2 columns A:D bold, A2:D1048576 ClearFormats -> <c r=A1..D1 s=bold>, no
//      column format, used range A1:D1
//   Q3 column C bold, C1 = "hdr", C5 = 5, C2:C1048576 Clear -> C1 bold with
//      its value, C5 empty and plain, used range C1
//   Q4 every column bold, B2:XFD1048576 ClearFormats -> <col A bold> and
//      <row r=1 s=bold customFormat=1/>, no cell, used range A1
//   Q5 every column bold, A2:A1048576 ClearFormats -> <col B:XFD bold> and
//      <row r=1 s=bold customFormat=1/>, no cell
//   Q6 rows 5:10 bold, B5:XFD10 ClearFormats -> <c r=A5..A10 s=bold>, no row
//      format, used range A5:A10

impl Book {
    fn cells_on(&self, sheet: usize) -> usize {
        self.state.grids.read().unwrap()[sheet].cells.len()
    }

    fn own_style_on(&self, sheet: usize, row: u32, col: u32) -> usize {
        self.state.grids.read().unwrap()[sheet].get_cell(row, col).map_or(0, |c| c.style_index)
    }
}

/// rev3A#2, Q1 and Q3. Click C2, Ctrl+Shift+Down, Clear Formats under a bold
/// column C: one row short of the whole column. It was planned as a PARTIAL
/// clear -- an explicit-Normal cell for each of 1,048,575 positions, as many
/// undo records and reply rows, and the used range ran to row 1,048,576. Now
/// the column format goes and C1, left out, keeps its bold as its own cell.
// SABOTAGE: make plan_clear_formats ignore `line_extent_of` (line = None) ->
// a million cells are written ("C1 and C5 only").
#[test]
fn an_almost_whole_column_clear_removes_the_column_format_and_row_1_keeps_its_look() {
    let b = Book::new(1);
    let bold = b.bold();
    b.seed(0, |g| {
        g.set_column_style(2, bold);
        g.set_cell(0, 2, Cell::new_text("hdrC".to_string()));
        g.set_cell(4, 2, number(5.0));
    });
    let steps = b.undo_depth();

    let result = b.clear((1, 2, LAST_ROW, 2), ClearApplyTo::Formats).expect("Clear Formats on C2:C1048576");
    assert_eq!(b.cells_on(0), 2, "C1 and C5 only -- not one cell per position");
    assert!(b.state.grid.read().unwrap().max_row < 10, "the used range stays at the data");
    assert!(result.updated_cells.len() <= 2, "a handful of reply rows, got {}", result.updated_cells.len());
    assert!(!b.state.grids.read().unwrap()[0].column_styles.contains_key(&2), "column C's format is gone, as in Excel");
    assert!(b.bold_at(0, 0, 2), "C1 is not in the clear and keeps its bold");
    assert_ne!(b.own_style_on(0, 0, 2), 0, "as its own style");
    for row in [1, 4, 500_000, LAST_ROW] {
        assert!(!b.bold_at(0, row, 2), "C{} still shows the column's bold", row + 1);
    }
    assert_eq!(b.undo_depth(), steps + 1, "ONE undo step");

    b.undo();
    assert!(b.bold_at(0, 500_000, 2), "undo brings the column format back");
    assert_eq!(b.own_style_on(0, 0, 2), 0, "and C1 inherits it again");

    // Q3: Clear All keeps C1 -- value and bold -- and empties C5.
    let b = Book::new(1);
    let bold = b.bold();
    b.seed(0, |g| {
        g.set_column_style(2, bold);
        g.set_cell(0, 2, Cell::new_text("hdr".to_string()));
        g.set_cell(4, 2, number(5.0));
    });
    b.clear((1, 2, LAST_ROW, 2), ClearApplyTo::All).expect("Clear All on C2:C1048576");
    assert_eq!(b.value(0, 0, 2), CellValue::Text("hdr".to_string()), "C1 keeps its value");
    assert!(b.bold_at(0, 0, 2), "and its bold");
    assert_eq!(b.value(0, 4, 2), CellValue::Empty, "C5 is cleared");
    assert!(!b.bold_at(0, 4, 2), "and plain");
    assert_eq!(b.cells_on(0), 1, "only C1 is stored");
}

/// rev3A#2, Q2: A2:D1048576 under bold A:D needed 4,194,300 cells and was
/// REFUSED. Now four column formats go and A1:D1 keep their bold as cells.
/// The off-sheet twin (scripts, the command line) and the sheet group take
/// the same plan.
#[test]
fn an_almost_whole_clear_over_several_columns_is_applied_on_every_route() {
    let b = Book::new(1);
    let bold = b.bold();
    b.seed(0, |g| {
        for col in 0..4 {
            g.set_column_style(col, bold);
        }
    });
    b.clear((1, 0, LAST_ROW, 3), ClearApplyTo::Formats).expect("A2:D1048576 is cleared, not refused");
    assert_eq!(b.cells_on(0), 4, "A1:D1 kept as cells");
    for col in 0..4 {
        assert!(b.bold_at(0, 0, col), "row 1 keeps its bold in column {col}");
        assert!(!b.bold_at(0, 1, col) && !b.bold_at(0, LAST_ROW, col), "column {col} is plain below row 1");
    }
    assert!(!b.bold_at(0, 0, 4), "E1 never was bold");
    assert!(b.state.grid.read().unwrap().column_styles.is_empty());

    // Off-sheet: Sheet2!C2:C1048576.
    let b = Book::new(2);
    let bold = b.bold();
    b.seed(1, |g| g.set_column_style(2, bold));
    b.clear_off_sheet(1, (1, 2, LAST_ROW, 2), ClearApplyTo::Formats).expect("off-sheet C2:C1048576");
    assert_eq!(b.cells_on(1), 1, "Sheet2!C1 only");
    assert!(b.bold_at(1, 0, 2) && !b.bold_at(1, 700_000, 2));
    assert_eq!(b.undo_depth(), 1);
    b.undo();
    assert!(b.bold_at(1, 700_000, 2), "undo restores Sheet2's column format");
    assert_eq!(b.cells_on(1), 0, "and removes C1");

    // The group: the active sheet is the caller's; Sheet2 is written here.
    let b = Book::new(2);
    let bold = b.bold();
    b.seed(1, |g| g.set_column_style(2, bold));
    b.clear_group(&[0, 1], &[(1, 2, LAST_ROW, 2)], ClearApplyTo::Formats).expect("grouped C2:C1048576");
    assert_eq!(b.cells_on(1), 1, "Sheet2!C1 only");
    assert!(b.bold_at(1, 0, 2) && !b.bold_at(1, 700_000, 2));
}

/// rev3A#2, Q6: the ROW axis. Rows 5:10 bold, B5:XFD10 Clear Formats: the row
/// formats go (none shows through) and A5:A10, left out, keep their bold as
/// cells -- not the 98,298 explicit-Normal cells B5:XFD10 used to be.
#[test]
fn an_almost_whole_row_clear_removes_the_row_formats_and_column_a_keeps_its_look() {
    let b = Book::new(1);
    let bold = b.bold();
    b.seed(0, |g| {
        for row in 4..=9 {
            g.set_row_style(row, bold);
        }
    });
    b.clear((4, 1, 9, LAST_COL), ClearApplyTo::Formats).expect("B5:XFD10");
    assert!(b.state.grid.read().unwrap().row_styles.is_empty(), "the row formats are gone, as in Excel");
    assert_eq!(b.cells_on(0), 6, "A5:A10 kept as cells");
    for row in 4..=9 {
        assert!(b.bold_at(0, row, 0), "A{} keeps its bold", row + 1);
        assert!(!b.bold_at(0, row, 1) && !b.bold_at(0, row, LAST_COL), "row {} is plain from B", row + 1);
    }
    assert!(!b.bold_at(0, 10, 0), "A11 never was bold");
}

/// rev3A#7, Q4 and Q5: with EVERY column bold, the row left out keeps its
/// bold as a ROW format -- Excel's `<row r=1 s=bold customFormat=1/>` -- not
/// as 16,383 cells B1:XFD1 (which ran the used range to XFD). Before this the
/// B2 case was refused outright and A2:A1048576 wrote a million cells.
// SABOTAGE: make excluded_row_format return None -> B1:XFD1 become 16,383
// cells ("no cell").
#[test]
fn every_column_bold_then_an_almost_whole_clear_keeps_row_1_as_a_row_format() {
    let every_column_bold = |b: &Book| {
        let bold = b.bold();
        b.seed(0, |g| {
            for col in 0..=LAST_COL {
                g.set_column_style(col, bold);
            }
        });
    };

    let b = Book::new(1);
    every_column_bold(&b);
    b.clear((1, 1, LAST_ROW, LAST_COL), ClearApplyTo::Formats).expect("B2:XFD1048576");
    {
        let grid = b.state.grid.read().unwrap();
        assert_eq!(grid.cells.len(), 0, "no cell");
        assert_eq!(grid.max_col, 0, "the used range does not run to XFD");
        assert!(grid.row_styles.contains_key(&0), "row 1 keeps its look as a row format");
        assert_eq!(grid.column_styles.keys().copied().collect::<Vec<_>>(), vec![0], "only column A keeps its format");
    }
    assert!(b.bold_at(0, 0, 1) && b.bold_at(0, 0, LAST_COL), "B1 and XFD1 keep their bold");
    assert!(b.bold_at(0, 1, 0), "A2 is not in the clear");
    assert!(!b.bold_at(0, 1, 1) && !b.bold_at(0, LAST_ROW, LAST_COL), "B2 and XFD1048576 are plain");
    b.undo();
    assert_eq!(b.state.grid.read().unwrap().column_styles.len(), LAST_COL as usize + 1, "undo restores every column");
    assert!(b.state.grid.read().unwrap().row_styles.is_empty(), "and removes row 1's format");

    let b = Book::new(1);
    every_column_bold(&b);
    b.clear((1, 0, LAST_ROW, 0), ClearApplyTo::Formats).expect("A2:A1048576");
    assert_eq!(b.cells_on(0), 0, "no cell");
    assert!(b.state.grid.read().unwrap().row_styles.contains_key(&0));
    assert!(b.bold_at(0, 0, 0) && b.bold_at(0, 0, 1), "A1 and B1 keep their bold");
    assert!(!b.bold_at(0, 1, 0) && b.bold_at(0, 1, 1), "A2 is plain, B2 bold");
}

/// rev3A#5. Grouped Clear Formats where the ACTIVE sheet's plan is refused
/// (200 row formats crossing 16,383 cleared columns) and the grouped sheet's
/// is not. The door gated protection, region, claim and spill for the active
/// sheet but planned only the sheets it writes, so it cleared and committed
/// Sheet2 and the refusal came later, from the active sheet's own clear.
/// Now the door refuses first and nothing changes anywhere.
// SABOTAGE: drop the active sheet's plan from the gate (`active_grid` None) ->
// the door answers Ok([1]) having cleared Sheet2 ("must refuse the group").
#[test]
fn a_grouped_clear_whose_active_sheet_plan_is_refused_writes_nothing_anywhere() {
    let b = Book::new(2);
    let bold = b.bold();
    b.seed(0, |g| {
        for row in 0..200 {
            g.set_row_style(row * 3, bold);
        }
        g.set_column_style(7, bold);
    });
    b.seed(1, |g| {
        let mut cell = number(1.0);
        cell.style_index = bold;
        g.set_cell(0, 0, cell);
        g.set_column_style(2, bold);
    });

    let refusal = b.clear_group(&[0, 1], &[(0, 0, LAST_ROW, LAST_COL - 1)], ClearApplyTo::Formats);
    assert!(refusal.is_err(), "the active sheet's refused plan must refuse the group, got {refusal:?}");
    assert!(b.bold_at(1, 0, 0), "Sheet2 was cleared past the active sheet's refusal");
    assert!(b.bold_at(1, 500, 2), "Sheet2's column format was cleared past the refusal");
    assert!(!b.file.is_dirty(), "a refusal must not dirty the document");
    assert_eq!(b.undo_depth(), 0, "a refusal must record nothing");

    // The pure gate (only the active sheet listed) answers the same refusal.
    assert!(b.clear_group(&[0], &[(0, 0, LAST_ROW, LAST_COL - 1)], ClearApplyTo::Formats).is_err());
    // A content clear plans no formats: the same group is not refused by it.
    assert!(b.clear_group(&[0, 1], &[(0, 0, 0, 0)], ClearApplyTo::Contents).is_ok());
}

/// A#1 on the group: Clear Formats on whole column C of the grouped sheets
/// removes their column formats, and one undo restores them.
#[test]
fn a_grouped_clear_formats_removes_the_grouped_sheets_column_formats() {
    let b = Book::new(3);
    let bold = b.bold();
    for sheet in 1..=2 {
        b.seed(sheet, |g| g.set_column_style(2, bold));
    }
    b.clear_group(&[0, 1, 2], &[(0, 2, LAST_ROW, 2)], ClearApplyTo::Formats).expect("grouped Clear Formats on C");
    for sheet in 1..=2 {
        assert!(!b.bold_at(sheet, 300, 2), "sheet {sheet} keeps column C's bold");
    }
    assert_eq!(b.undo_depth(), 1);
    b.undo();
    for sheet in 1..=2 {
        assert!(b.bold_at(sheet, 300, 2), "undo restores sheet {sheet}'s column format");
    }
}
