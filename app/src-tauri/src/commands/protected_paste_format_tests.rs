//! FILENAME: app/src-tauri/src/commands/protected_paste_format_tests.rs
//! PURPOSE: A sheet paste's FORMAT on a PROTECTED sheet, through the real
//! `update_cells_batch_core` (every Ctrl+V / drag-fill / series / Flash Fill /
//! script paste of the active sheet sends the source's `styleIndex` here),
//! Fill Down through the real `fill_range_core`, and Clear Formats there.
//!
//! A child module of `commands::data` (declared with `#[path]` there), driven
//! through the shared `cross_sheet_recalc_tests::Workbook` harness.
//!
//! WHAT IS PINNED, and the Excel it is measured against [LIVE, Excel 16 over
//! COM, 2026-10-30, fresh unsaved workbooks, scratchpad fmtprot/probe1.ps1 and
//! probe2.ps1; A1:A4 unlocked italic, C1 = 5 bold 0.00 LOCKED]:
//!   1. Format Cells NOT allowed: `ws.Paste` of C1 onto the unlocked A3 lands
//!      the value 5 and NOT the format (still italic, General, unlocked), with
//!      no error. The batch used to write the source's style wholesale.
//!   2. Format Cells allowed: the same paste lands 5, bold, 0.00 -- and A3
//!      stays UNLOCKED. The batch used to write the source's Locked flag too,
//!      so pasting a locked cell onto an input cell locked it.
//!   3. Unprotected, the Locked flag travels with the format (positive
//!      control: the keep is a protected-sheet rule only).
//!   4. Clear Formats: on an UNLOCKED cell it succeeds and re-locks the cell
//!      (reset to Normal) whatever the Format Cells option; on a LOCKED cell it
//!      is refused ("The cell or chart you're trying to change is on a
//!      protected sheet") whatever the option.
//!   5. Fill Down (`fill_range_core`) follows the paste's rule [LIVE,
//!      protfill/probe1.ps1]: the source's format only with Format Cells
//!      allowed, and every filled cell keeps its Locked flag.

use super::cross_sheet_recalc_tests::Workbook;
use super::*;
use crate::api_types::{ClearApplyTo, ClearRangeParams, CellUpdateInput};
use crate::protection::{SheetProtection, SheetProtectionOptions};
use engine::{CellStyle, CellValue, NumberFormat};

fn workbook() -> Workbook {
    let wb = Workbook::new(1);
    *wb.state.locale.lock().unwrap() = engine::LocaleSettings::from_locale_id("en-US");
    wb
}

/// Intern a style built from the default one (which is LOCKED).
fn style(wb: &Workbook, build: impl FnOnce(CellStyle) -> CellStyle) -> usize {
    wb.state
        .style_registry
        .write(&crate::document_effect::test_seed_effect())
        .unwrap()
        .get_or_create(build(CellStyle::new()))
}

/// Seed the active sheet's cell (row, col) with `value` in style `index`
/// (canonical lock order: grid, then grids).
fn seed(wb: &Workbook, row: u32, col: u32, value: CellValue, index: usize) {
    let seed = crate::document_effect::test_seed_effect();
    let mut cell = engine::Cell::new();
    cell.value = value;
    cell.style_index = index;
    wb.state.grid.write(&seed).unwrap().set_cell(row, col, cell.clone());
    wb.state.grids.write(&seed).unwrap()[0].set_cell(row, col, cell);
}

fn protect(wb: &Workbook, allow_format_cells: bool) {
    wb.state.sheet_protection.write(&crate::document_effect::test_seed_effect()).unwrap().insert(
        0,
        SheetProtection {
            protected: true,
            password_hash: None,
            password_salt: None,
            options: SheetProtectionOptions { allow_format_cells, ..SheetProtectionOptions::default() },
            allow_edit_ranges: Vec::new(),
        },
    );
}

/// A PASTE of `value` carrying the source's style `style_index`, through the
/// REAL batch body, as `update_cells_batch` runs it.
fn paste(wb: &Workbook, row: u32, col: u32, value: &str, style_index: usize) -> Result<Vec<CellData>, String> {
    update_cells_batch_core(
        &wb.state,
        &wb.file,
        &wb.files,
        &wb.pivots,
        vec![CellUpdateInput {
            row,
            col,
            value: value.to_string(),
            style_index: Some(style_index),
            invariant: Some(true),
            pasted: Some(true),
            moved: None,
            source: None,
        }],
        None,
        None,
        None,
        None,
    )
}

/// The style the position SHOWS, and its own index (0 when none).
fn shown(wb: &Workbook, row: u32, col: u32) -> (CellStyle, usize) {
    let grid = wb.state.grid.read().unwrap();
    let styles = wb.state.style_registry.read().unwrap();
    let own = grid.get_cell(row, col).map(|c| c.style_index).unwrap_or(0);
    (styles.get(grid.effective_style_index(row, col)).clone(), own)
}

fn value(wb: &Workbook, row: u32, col: u32) -> CellValue {
    wb.state.grid.read().unwrap().get_cell(row, col).map(|c| c.value.clone()).unwrap_or(CellValue::Empty)
}

fn two_decimals() -> NumberFormat {
    NumberFormat::Number { decimal_places: 2, use_thousands_separator: false }
}

/// The copied source: bold, 0.00, LOCKED (the default flag). The input cells:
/// italic, UNLOCKED.
fn styles(wb: &Workbook) -> (usize, usize) {
    let source = style(wb, |s| s.with_bold(true).with_number_format(two_decimals()));
    let input = style(wb, |s| {
        let mut s = s.with_italic(true);
        s.locked = false;
        s
    });
    (source, input)
}

/// Item 1. Excel [LIVE, Format Cells not allowed]: the value lands, the
/// format is dropped, the cell keeps its own format and stays unlocked.
#[test]
fn protected_paste_without_format_cells_lands_the_value_and_drops_the_format() {
    let wb = workbook();
    let (source, input) = styles(&wb);
    seed(&wb, 2, 0, CellValue::Number(1.0), input); // A3
    seed(&wb, 3, 0, CellValue::Number(1.0), input); // A4
    protect(&wb, false);

    paste(&wb, 2, 0, "5", source).expect("a paste onto an unlocked cell is allowed (Excel: no error)");
    assert_eq!(value(&wb, 2, 0), CellValue::Number(5.0), "the value landed");
    let (a3, own) = shown(&wb, 2, 0);
    assert_eq!(own, input, "the source's format was dropped (Format Cells is off): A3 keeps its own style");
    assert!(!a3.font.bold && a3.font.italic, "A3 is still italic, not bold");
    assert!(!a3.locked, "A3 stays unlocked");

    // A pasted BLANK (an empty source position) clears the value and keeps the
    // cell's own format too -- it used to clear the whole cell, re-locking it.
    paste(&wb, 3, 0, "", source).expect("a pasted blank onto an unlocked cell");
    assert_eq!(value(&wb, 3, 0), CellValue::Empty, "the blank cleared A4's value");
    let (a4, own) = shown(&wb, 3, 0);
    assert_eq!(own, input, "a cleared A4 keeps its own format (Format Cells is off)");
    assert!(!a4.locked, "A4 stays unlocked");
}

/// Item 2. Excel [LIVE, Format Cells allowed]: the format lands, the cell
/// keeps its Locked flag -- a paste can neither lock nor unlock a cell.
#[test]
fn protected_paste_with_format_cells_lands_the_format_and_keeps_the_lock() {
    let wb = workbook();
    let (source, input) = styles(&wb);
    seed(&wb, 2, 0, CellValue::Number(1.0), input); // A3
    seed(&wb, 3, 0, CellValue::Number(1.0), input); // A4
    seed(&wb, 4, 0, CellValue::Number(1.0), input); // A5
    protect(&wb, true);

    paste(&wb, 2, 0, "5", source).expect("Format Cells allowed: the paste lands");
    assert_eq!(value(&wb, 2, 0), CellValue::Number(5.0));
    let (a3, _) = shown(&wb, 2, 0);
    assert!(a3.font.bold && !a3.font.italic, "the source's format landed on A3");
    assert_eq!(a3.number_format, two_decimals(), "the source's number format landed on A3");
    assert!(!a3.locked, "a paste cannot lock an unlocked cell on a protected sheet");

    paste(&wb, 3, 0, "", source).expect("a pasted styled blank");
    let (a4, _) = shown(&wb, 3, 0);
    assert!(a4.font.bold, "the blank brought the source's format");
    assert!(!a4.locked, "a pasted blank cannot lock an unlocked cell either");

    // A plain VALUE write (no style named) of a blank: the cell stays
    // unlocked (it used to be cleared whole and come back locked).
    update_cells_batch_core(
        &wb.state,
        &wb.file,
        &wb.files,
        &wb.pivots,
        vec![CellUpdateInput { row: 4, col: 0, value: String::new(), style_index: None, invariant: None, pasted: None, moved: None, source: None }],
        None,
        None,
        None,
        None,
    )
    .expect("clearing an unlocked cell's value");
    assert!(!shown(&wb, 4, 0).0.locked, "A5 stays unlocked after its value is cleared");
}

/// Item 3 (positive control): unprotected, the Locked flag travels.
#[test]
fn unprotected_paste_carries_the_sources_lock_flag() {
    let wb = workbook();
    let (source, input) = styles(&wb);
    seed(&wb, 2, 0, CellValue::Number(1.0), input);
    paste(&wb, 2, 0, "5", source).expect("an unprotected paste");
    let (a3, own) = shown(&wb, 2, 0);
    assert_eq!(own, source, "the source's whole style landed");
    assert!(a3.locked, "unprotected, the source's Locked flag travels with its format");
}

/// Item 4. Excel [LIVE, both option settings]: Clear Formats on an UNLOCKED
/// cell succeeds and re-locks it; on a LOCKED cell it is refused.
#[test]
fn protected_clear_formats_resets_an_unlocked_cell_and_refuses_a_locked_one() {
    for allow_format_cells in [false, true] {
        let wb = workbook();
        let (_, input) = styles(&wb);
        let locked_italic = style(&wb, |s| s.with_italic(true));
        seed(&wb, 0, 0, CellValue::Number(1.0), input); // A1 unlocked italic
        seed(&wb, 0, 1, CellValue::Number(2.0), locked_italic); // B1 locked italic
        protect(&wb, allow_format_cells);
        let clear = |col: u32| {
            clear_range_with_options_inner(
                &wb.state,
                &wb.file,
                &wb.files,
                &wb.pivots,
                &wb.pane,
                &wb.filters,
                ClearRangeParams {
                    start_row: 0,
                    start_col: col,
                    end_row: 0,
                    end_col: col,
                    apply_to: ClearApplyTo::Formats,
                    sheet_index: None,
                    target: None,
                },
            )
        };

        clear(0).unwrap_or_else(|e| panic!("Format Cells {allow_format_cells}: Clear Formats on the unlocked A1: {e}"));
        let (a1, _) = shown(&wb, 0, 0);
        assert!(!a1.font.italic, "Format Cells {allow_format_cells}: A1's format was cleared");
        assert!(a1.locked, "Format Cells {allow_format_cells}: A1 is reset to Normal, which is LOCKED (Excel)");
        assert_eq!(value(&wb, 0, 0), CellValue::Number(1.0), "A1 keeps its value");

        let refusal = clear(1);
        assert!(refusal.is_err(), "Format Cells {allow_format_cells}: Clear Formats on the locked B1 must be refused");
        assert!(shown(&wb, 0, 1).0.font.italic, "Format Cells {allow_format_cells}: B1 keeps its format");
    }
}

/// Fill Down through the REAL `fill_range_core` (Ctrl+D, Home > Fill > Down),
/// source `(r0, c0, r1, c1)` onto `dest`, on the active sheet.
fn fill(wb: &Workbook, source: (u32, u32, u32, u32), dest: (u32, u32, u32, u32)) -> Result<Vec<CellData>, String> {
    fill_range_core(&wb.state, &wb.file, &wb.files, &wb.pivots, &wb.pane, &wb.filters, source, dest)
}

/// Item 5. Excel [LIVE, Excel 16 COM, 2026-10-31, protfill/probe1.ps1]:
/// FillDown (and AutoFill) of a locked, bold, 0.00 A1 over UNLOCKED A2:A3 on a
/// protected sheet. Format Cells NOT allowed: A2 = 5, its own format, still
/// unlocked, no error. Allowed: A2 = 5, bold, 0.00 -- and still UNLOCKED. The
/// fill used to clone the source's whole style, so a Fill Down from a header
/// LOCKED the input cells under it. An empty source position fills as a blank
/// that keeps the cell unlocked too.
#[test]
fn protected_fill_down_obeys_format_cells_and_keeps_every_lock() {
    for allow_format_cells in [false, true] {
        let wb = workbook();
        let (source, input) = styles(&wb);
        seed(&wb, 0, 0, CellValue::Number(5.0), source); // A1 locked bold 0.00
        seed(&wb, 1, 0, CellValue::Number(1.0), input); // A2 unlocked italic
        seed(&wb, 2, 0, CellValue::Number(1.0), input); // A3 unlocked italic
        seed(&wb, 1, 1, CellValue::Number(2.0), input); // B2 unlocked italic, B1 empty
        seed(&wb, 2, 1, CellValue::Number(2.0), input); // B3 unlocked italic
        protect(&wb, allow_format_cells);

        fill(&wb, (0, 0, 0, 1), (1, 0, 2, 1))
            .unwrap_or_else(|e| panic!("Format Cells {allow_format_cells}: a fill onto unlocked cells: {e}"));
        for row in [1, 2] {
            assert_eq!(value(&wb, row, 0), CellValue::Number(5.0), "Format Cells {allow_format_cells}: the value landed");
            let (cell, own) = shown(&wb, row, 0);
            assert!(!cell.locked, "Format Cells {allow_format_cells}: a fill cannot LOCK the unlocked A{}", row + 1);
            if allow_format_cells {
                assert!(cell.font.bold && !cell.font.italic, "Format Cells allowed: the source's format landed");
                assert_eq!(cell.number_format, two_decimals(), "Format Cells allowed: the number format landed");
            } else {
                assert_eq!(own, input, "Format Cells NOT allowed: A{} keeps its own format", row + 1);
                assert!(!cell.font.bold && cell.font.italic, "Format Cells NOT allowed: not bold, still italic");
            }
        }
        assert_eq!(value(&wb, 1, 1), CellValue::Empty, "Format Cells {allow_format_cells}: the empty B1 cleared B2");
        let (b2, own) = shown(&wb, 1, 1);
        assert!(!b2.locked, "Format Cells {allow_format_cells}: a filled blank cannot lock the unlocked B2");
        if !allow_format_cells {
            assert_eq!(own, input, "Format Cells NOT allowed: the blank keeps B2's own format");
        }
    }
}

/// Item 5's positive control: unprotected, the fill carries the source's whole
/// style, Locked flag included.
#[test]
fn unprotected_fill_down_carries_the_sources_lock_flag() {
    let wb = workbook();
    let (source, input) = styles(&wb);
    seed(&wb, 0, 0, CellValue::Number(5.0), source);
    seed(&wb, 1, 0, CellValue::Number(1.0), input);
    fill(&wb, (0, 0, 0, 0), (1, 0, 1, 0)).expect("an unprotected fill");
    let (a2, own) = shown(&wb, 1, 0);
    assert_eq!(own, source, "the source's whole style landed");
    assert!(a2.locked, "unprotected, the source's Locked flag travels with the fill");
}

/// rev15C: a fill onto a LOCKED cell of a protected sheet is refused WHOLE,
/// before anything is written or dirtied -- and the refusal is asked over the
/// grid and style guards the fill holds, not before them. Asked holding
/// nothing (the old pre-check), a sheet protected between the question and the
/// write had its locked cells overwritten with only their Locked flag kept.
#[test]
fn protected_fill_onto_a_locked_cell_is_refused_whole_and_clean() {
    let wb = workbook();
    let (source, input) = styles(&wb);
    seed(&wb, 0, 0, CellValue::Number(5.0), source); // A1 locked bold 0.00
    seed(&wb, 1, 0, CellValue::Number(1.0), input); // A2 unlocked italic
    seed(&wb, 2, 0, CellValue::Number(7.0), source); // A3 LOCKED
    protect(&wb, true);
    crate::document_effect::mark_saved(&wb.file);
    let depth = wb.state.undo_stack.lock().unwrap().undo_depth();

    let refused = fill(&wb, (0, 0, 0, 0), (1, 0, 2, 0));
    assert!(refused.is_err(), "a fill over the locked A3 of a protected sheet must be refused");
    assert_eq!(value(&wb, 1, 0), CellValue::Number(1.0), "refused WHOLE: the unlocked A2 is not written either");
    assert_eq!(value(&wb, 2, 0), CellValue::Number(7.0), "the locked A3 keeps its value");
    assert!(!wb.file.is_dirty(), "a refused fill leaves the document clean");
    assert_eq!(wb.state.undo_stack.lock().unwrap().undo_depth(), depth, "a refused fill records no undo step");

    // The positive control: onto the unlocked A2 alone, the fill lands.
    fill(&wb, (0, 0, 0, 0), (1, 0, 1, 0)).expect("a fill onto an unlocked cell");
    assert_eq!(value(&wb, 1, 0), CellValue::Number(5.0));
}

/// The fill's protection gate is the HELD one: `fill_range_core` asks
/// `check_sheet_protection_range_in` over its pending grid and style guards and
/// only then builds its `DocumentEffect`; the lock-free
/// `check_sheet_protection_range` (which takes and releases its own guards) is
/// not asked at all. Read from source because the window it closes is a race a
/// sequential test cannot open.
#[test]
fn the_fills_protection_gate_is_asked_under_its_held_guards() {
    let source = include_str!("data.rs");
    let body = super::cross_sheet_recalc_tests::body_of(source, "fill_range_core");
    assert!(
        !body.contains("check_sheet_protection_range("),
        "`fill_range_core` asks the lock-free protection check again -- the refusal must be asked under the held guards"
    );
    let gate = body.find("check_sheet_protection_range_in(").expect("the held protection gate");
    let pending = body.find("state.style_registry.lock_pending()").expect("the pending style guard");
    let effect = body.find("DocumentEffect::mutates(").expect("the fill's effect");
    assert!(pending < gate && gate < effect, "the gate runs under the pending guards and before the effect");
}

/// misc19 (round 19): the fill's FORMAT decision (is the sheet protected, does
/// it allow Format Cells) comes from the SAME `sheet_protection` read as the
/// locked-cell gate. It was a second read after `authorize`, and
/// `protect_sheet` takes no grid lock, so a Protect landing between the two
/// gave a half-protected fill: LOCKED cells written (the gate saw the sheet
/// open) and the source formats dropped (the second read saw it protected),
/// which neither order of the two gestures produces. A race a sequential test
/// cannot open, so it is read from source.
///
/// SABOTAGE: re-read `state.sheet_protection` for the format decision -- fails
/// at "read sheet_protection twice".
#[test]
fn the_fills_format_decision_comes_from_the_gates_own_protection_read() {
    let source = include_str!("data.rs");
    let body = super::cross_sheet_recalc_tests::body_of(source, "fill_range_core");
    assert_eq!(
        body.matches("state.sheet_protection.read()").count(),
        1,
        "`fill_range_core` read sheet_protection twice -- the gate and the format decision must be one moment"
    );
    let gate = body.find("check_sheet_protection_range_in(").expect("the held protection gate");
    let decision = body.find("is_action_allowed(\"formatCells\")").expect("the Format Cells decision");
    let effect = body.find("DocumentEffect::mutates(").expect("the fill's effect");
    assert!(gate < decision && decision < effect, "the format decision is taken from the gate's read, before the effect");
}
