//! FILENAME: app/src-tauri/src/commands/protected_move_format_tests.rs
//! PURPOSE: Three writes of a cell's FORMAT, through the real bodies:
//!   1. A MOVE (`CellUpdateInput::moved`, the Cut + Paste route) on a protected
//!      sheet that does not allow Format Cells: the moved cell's format moves
//!      with it, and the destination keeps its Locked flag. A COPY drops it.
//!      Excel [LIVE, Excel 16 COM, 2026-10-31, rev14A/probe-cut.ps1]: A1 = 5
//!      bold 0.00 cut to C1 (both unlocked) lands 5 bold 0.00 unlocked in C1,
//!      Format Cells off or on; a copy lands 5 in General.
//!   2. A BLANK written with no style named (a script's `setValues("")`):
//!      the value goes, the cell keeps its own format. Excel [LIVE, Excel 16
//!      COM, 2026-10-31, cutfmt/probe1.ps1]: `Range.Value2 = ""` on a bold 0.00
//!      unlocked cell leaves it bold 0.00 unlocked -- unprotected, and protected
//!      with Format Cells off or on.
//!   3. The style-only BATCH (`set_cell_styles_core`, `set_cell_style`'s
//!      `cells`): one undo step, gated once and all or nothing, the Locked flag
//!      kept on a protected sheet, `keep_borders` keeping each cell's own border
//!      sides.
//!
//! A child module of `commands::data` (declared with `#[path]` there), driven
//! through the shared `cross_sheet_recalc_tests::Workbook` harness.

use super::cross_sheet_recalc_tests::Workbook;
use super::*;
use crate::api_types::{CellStyleWrite, CellUpdateInput, MovedFrom};
use crate::protection::{SheetProtection, SheetProtectionOptions};
use engine::{BorderLineStyle, BorderStyle, CellStyle, CellValue, NumberFormat};

fn workbook() -> Workbook {
    let wb = Workbook::new(1);
    *wb.state.locale.lock().unwrap() = engine::LocaleSettings::from_locale_id("en-US");
    wb
}

fn style(wb: &Workbook, build: impl FnOnce(CellStyle) -> CellStyle) -> usize {
    wb.state
        .style_registry
        .write(&crate::document_effect::test_seed_effect())
        .unwrap()
        .get_or_create(build(CellStyle::new()))
}

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

fn write(wb: &Workbook, update: CellUpdateInput) -> Result<Vec<CellData>, String> {
    update_cells_batch_core(&wb.state, &wb.file, &wb.files, &wb.pivots, vec![update], None, None, None, None)
}

/// The cut route's destination write: the source's stored value and its
/// displayed style index, marked as a paste and -- `moved`, naming the source
/// cell on sheet 0 -- as a move.
fn landed(row: u32, col: u32, value: &str, style_index: usize, moved_from: Option<(u32, u32)>) -> CellUpdateInput {
    CellUpdateInput {
        row,
        col,
        value: value.to_string(),
        style_index: Some(style_index),
        invariant: Some(true),
        pasted: Some(true),
        moved: moved_from.map(|(row, col)| MovedFrom { sheet_index: 0, row, col, target: None }),
        source: None,
    }
}

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

fn unlocked(build: impl FnOnce(CellStyle) -> CellStyle) -> impl FnOnce(CellStyle) -> CellStyle {
    move |s| {
        let mut s = build(s);
        s.locked = false;
        s
    }
}

/// Item 1. Format Cells NOT allowed: a MOVED bold 0.00 cell keeps bold 0.00
/// at its destination, which keeps its own Locked flag; a COPIED one lands in
/// the destination's own format.
#[test]
fn protected_move_carries_the_format_without_format_cells_and_keeps_the_lock() {
    let wb = workbook();
    // The moved cell's look, as the cut route reads it: bold, 0.00 -- and
    // LOCKED, so a carried flag would show (the destinations are unlocked).
    let moved_look = style(&wb, |s| s.with_bold(true).with_number_format(two_decimals()));
    let input = style(&wb, unlocked(|s| s.with_italic(true)));
    seed(&wb, 0, 2, CellValue::Number(1.0), input); // C1: the move's destination
    seed(&wb, 1, 2, CellValue::Number(1.0), input); // C2: a copy's destination
    seed(&wb, 2, 2, CellValue::Number(1.0), input); // C3: a moved BLANK's destination
    seed(&wb, 0, 0, CellValue::Number(5.0), moved_look); // A1: the cut SOURCE, still holding its look
    protect(&wb, false);

    write(&wb, landed(0, 2, "5", moved_look, Some((0, 0)))).expect("a move onto an unlocked cell (Excel: no error)");
    assert_eq!(value(&wb, 0, 2), CellValue::Number(5.0), "the moved value landed");
    let (c1, _) = shown(&wb, 0, 2);
    assert!(c1.font.bold, "a MOVED cell keeps its bold on a protected sheet without Format Cells (Excel moves the format)");
    assert_eq!(c1.number_format, two_decimals(), "a MOVED cell keeps its 0.00 (a moved date must not turn into a serial)");
    assert!(!c1.font.italic, "the destination's own italic was replaced by the moved format");
    assert!(!c1.locked, "the destination keeps its Locked flag: a move cannot lock an unlocked cell");

    // Control: a COPY in the same setup drops the format (Excel [LIVE]).
    write(&wb, landed(1, 2, "5", moved_look, None)).expect("a copy onto an unlocked cell");
    let (c2, own) = shown(&wb, 1, 2);
    assert_eq!(own, input, "a COPY's format is dropped without Format Cells: C2 keeps its own style");
    assert!(!c2.font.bold && c2.font.italic);

    // A moved EMPTY position carries its look too, and keeps the lock.
    write(&wb, landed(2, 2, "", moved_look, Some((0, 0)))).expect("a moved blank");
    assert_eq!(value(&wb, 2, 2), CellValue::Empty);
    let (c3, _) = shown(&wb, 2, 2);
    assert!(c3.font.bold && !c3.locked, "a moved blank lands in the moved look and stays unlocked");
}

/// Round 18: `moved` is BOUND to its source, not asserted. A claim whose source
/// cell does not show the written style -- an arbitrary style index sent with
/// `moved` onto an unlocked cell of a protected sheet without Format Cells --
/// is written as a COPY (its format dropped). A claim whose source shows it is
/// honoured even when the same batch overwrites that source before the claimed
/// write (an overlapping move, A1:A2 -> A2:A3): the sources are read first.
#[test]
fn a_move_claim_carries_a_format_only_from_a_source_that_holds_it() {
    let wb = workbook();
    let bold = style(&wb, |s| s.with_bold(true));
    let forged = style(&wb, unlocked(|s| s.with_number_format(two_decimals()).with_italic(true)));
    let input = style(&wb, unlocked(|s| s.with_strikethrough(true)));
    let other = style(&wb, unlocked(|s| s.with_wrap_text(true)));
    seed(&wb, 0, 0, CellValue::Number(1.0), bold); // A1 bold (a real source)
    seed(&wb, 1, 0, CellValue::Number(2.0), input); // A2 (destination AND source)
    seed(&wb, 2, 0, CellValue::Number(3.0), other); // A3 (destination)
    seed(&wb, 0, 4, CellValue::Number(9.0), input); // E1 (forgery target)
    protect(&wb, false);

    // A forged claim: E1 named as coming from A1, but carrying a style A1 does
    // not show. Written as a copy: E1 keeps its own format.
    write(&wb, landed(0, 4, "7", forged, Some((0, 0)))).expect("the value lands (Excel: no error)");
    assert_eq!(value(&wb, 0, 4), CellValue::Number(7.0));
    let (e1, own) = shown(&wb, 0, 4);
    assert_eq!(
        own, input,
        "an UNBOUND move claim landed its style on a protected sheet without Format Cells: the source shows another style"
    );
    assert!(!e1.font.italic && e1.number_format != two_decimals());

    // A claim naming a sheet that does not exist is a copy too.
    let mut nowhere = landed(0, 4, "8", bold, Some((0, 0)));
    nowhere.moved = Some(MovedFrom { sheet_index: 7, row: 0, col: 0, target: None });
    write(&wb, nowhere).expect("the value lands");
    assert_eq!(shown(&wb, 0, 4).1, input, "a claim on a sheet that does not exist carried a format");

    // The real overlapping move A1:A2 -> A2:A3 in ONE batch: A2 gets A1's bold
    // first, then A3 is claimed from A2 with A2's ORIGINAL (strikethrough) look.
    update_cells_batch_core(
        &wb.state,
        &wb.file,
        &wb.files,
        &wb.pivots,
        vec![landed(1, 0, "1", bold, Some((0, 0))), landed(2, 0, "2", input, Some((1, 0)))],
        None,
        None,
        None,
        None,
    )
    .expect("an overlapping move");
    assert!(shown(&wb, 1, 0).0.font.bold, "A2 took A1's moved bold");
    assert_eq!(
        shown(&wb, 2, 0).1,
        input,
        "A3 took A2's look as it was BEFORE the batch (the claims are judged before any write)"
    );
}

/// Item 2. A blank written with NO style named keeps the cell's own format,
/// unprotected and protected (Format Cells off and on).
#[test]
fn blank_write_without_a_style_keeps_the_cells_own_format() {
    for protection in [None, Some(false), Some(true)] {
        let wb = workbook();
        let own_look = style(&wb, unlocked(|s| s.with_bold(true).with_number_format(two_decimals())));
        seed(&wb, 0, 0, CellValue::Number(5.0), own_look); // A1 bold 0.00 unlocked
        if let Some(allow) = protection {
            protect(&wb, allow);
        }
        write(
            &wb,
            CellUpdateInput { row: 0, col: 0, value: String::new(), style_index: None, invariant: Some(true), pasted: None, moved: None, source: None },
        )
        .unwrap_or_else(|e| panic!("protection {protection:?}: clearing A1's value: {e}"));
        assert_eq!(value(&wb, 0, 0), CellValue::Empty, "protection {protection:?}: the value went");
        let (a1, own) = shown(&wb, 0, 0);
        assert_eq!(own, own_look, "protection {protection:?}: A1 keeps its own format (Excel: Range.Value2 = \"\" keeps bold 0.00)");
        assert!(a1.font.bold && a1.number_format == two_decimals() && !a1.locked);
    }
}

fn styles_batch(wb: &Workbook, writes: &[CellStyleWrite]) -> Result<(), String> {
    crate::commands::styles::set_cell_styles_core(&wb.state, &wb.file, writes, None)
}

fn style_write(row: u32, col: u32, style_index: usize, keep_borders: bool) -> CellStyleWrite {
    CellStyleWrite { row, col, style_index, keep_borders: keep_borders.then_some(true) }
}

fn thick() -> BorderStyle {
    BorderStyle { width: 3, color: engine::ThemeColor::Absolute(engine::Color::new(0, 0, 0)), style: BorderLineStyle::Solid }
}

/// Item 3. The style-only batch: one undo step for every cell, all or nothing
/// on a protected sheet, the Locked flag kept, and `keep_borders`.
#[test]
fn style_batch_is_one_step_gated_once_and_keeps_locks_and_borders() {
    let wb = workbook();
    let bold = style(&wb, |s| s.with_bold(true));
    let bordered_italic = style(&wb, unlocked(|s| {
        let mut s = s.with_italic(true);
        s.borders.top = thick();
        s
    }));
    seed(&wb, 0, 0, CellValue::Number(1.0), bordered_italic); // A1
    seed(&wb, 1, 0, CellValue::Number(2.0), bordered_italic); // A2
    // A3 empty: a style-only write creates it.

    let depth = wb.state.undo_stack.lock().unwrap().undo_depth();
    styles_batch(&wb, &[style_write(0, 0, bold, false), style_write(1, 0, bold, true), style_write(2, 0, bold, false)])
        .expect("an unprotected style batch");
    assert_eq!(
        wb.state.undo_stack.lock().unwrap().undo_depth(),
        depth + 1,
        "the whole batch is ONE undo step"
    );
    let (a1, _) = shown(&wb, 0, 0);
    assert!(a1.font.bold && !a1.font.italic && a1.borders.top == BorderStyle::default(), "A1 took the whole source look");
    assert!(a1.locked, "unprotected, the source's Locked flag travels");
    let (a2, _) = shown(&wb, 1, 0);
    assert!(a2.font.bold && !a2.font.italic, "A2 took the source look...");
    assert_eq!(a2.borders.top, thick(), "...except its borders: keep_borders kept A2's own thick top");
    assert!(shown(&wb, 2, 0).0.font.bold, "the empty A3 was created in the look");
    assert_eq!(value(&wb, 0, 0), CellValue::Number(1.0), "a style write keeps the value");

    // Protected, Format Cells NOT allowed: refused whole, nothing written.
    let wb = workbook();
    let bold = style(&wb, |s| s.with_bold(true));
    let input = style(&wb, unlocked(|s| s.with_italic(true)));
    seed(&wb, 0, 0, CellValue::Number(1.0), input);
    seed(&wb, 1, 0, CellValue::Number(1.0), input);
    protect(&wb, false);
    let depth = wb.state.undo_stack.lock().unwrap().undo_depth();
    let refused = styles_batch(&wb, &[style_write(0, 0, bold, false), style_write(1, 0, bold, false)]);
    assert!(refused.is_err(), "Format Cells not allowed: the batch is refused");
    assert!(!shown(&wb, 0, 0).0.font.bold && !shown(&wb, 1, 0).0.font.bold, "nothing of a refused batch was written");
    assert_eq!(wb.state.undo_stack.lock().unwrap().undo_depth(), depth, "a refused batch records no step");

    // Protected, Format Cells allowed: the look lands, every lock is kept.
    let locked_plain = style(&wb, |s| s.with_italic(true)); // locked (default)
    seed(&wb, 2, 0, CellValue::Number(1.0), locked_plain);
    protect(&wb, true);
    let unlocked_bold = style(&wb, unlocked(|s| s.with_bold(true)));
    styles_batch(&wb, &[style_write(0, 0, bold, false), style_write(2, 0, unlocked_bold, false)])
        .expect("Format Cells allowed: the batch lands");
    let (a1, _) = shown(&wb, 0, 0);
    assert!(a1.font.bold && !a1.locked, "a locked look cannot lock the unlocked A1");
    let (a3, _) = shown(&wb, 2, 0);
    assert!(a3.font.bold && a3.locked, "an unlocked look cannot unlock the locked A3");
}

/// Round 18 (rev16A nit): `can_edit_cell`'s list question is BOUNDED -- past
/// `CAN_EDIT_CELLS_MAX` it is refused with a plain reason, never walked -- and
/// a list inside the bound is answered as before.
#[test]
fn can_edit_cell_refuses_a_list_past_its_bound_and_answers_one_inside_it() {
    use crate::protection::{can_edit_cell_core, ProtectionCellRef, CAN_EDIT_CELLS_MAX};
    let wb = workbook();
    let too_many: Vec<ProtectionCellRef> = (0..=CAN_EDIT_CELLS_MAX).map(|_| ProtectionCellRef { row: 0, col: 0 }).collect();
    let refused = can_edit_cell_core(&wb.state, 0, 0, Some(too_many));
    assert!(!refused.can_edit, "a list past the bound was walked (an unprotected sheet answers can-edit)");
    assert!(
        refused.reason.as_deref().is_some_and(|r| r.starts_with("Too many cells to check at once")),
        "the refusal must say why: {:?}",
        refused.reason
    );
    // Control: inside the bound, an unprotected sheet can edit.
    let answered = can_edit_cell_core(&wb.state, 0, 0, Some(vec![ProtectionCellRef { row: 0, col: 0 }; 2]));
    assert!(answered.can_edit && answered.reason.is_none());
}

/// Round 18: a move claim whose SOURCE is a floating grid's cell (`target`)
/// is judged on the grid's backing sheet, whose cells are the grid's own: a
/// cut out of Float1!A1 (bold) onto a protected sheet without Format Cells
/// lands bold; the same claim carrying a style A1 does not show is a copy.
#[test]
fn a_move_claim_from_a_floating_grid_cell_is_judged_on_its_backing_sheet() {
    let wb = workbook();
    let info = crate::floating_range::create_floating_range_inner(&wb.state, &wb.file, Some("Float1".to_string()), 100.0, 50.0)
        .expect("create a floating range");
    let target = crate::api_types::CellTargetRef::FloatingRange { id: info.range.id };
    let backing = info.backing_sheet_index;
    let bold = style(&wb, |s| s.with_bold(true));
    let italic = style(&wb, |s| s.with_italic(true));
    let input = style(&wb, unlocked(|s| s.with_strikethrough(true)));
    {
        let seed = crate::document_effect::test_seed_effect();
        let mut cell = engine::Cell::new();
        cell.value = CellValue::Number(5.0);
        cell.style_index = bold;
        wb.state.grids.write(&seed).unwrap()[backing].set_cell(0, 0, cell); // Float1!A1 bold
    }
    seed(&wb, 0, 3, CellValue::Number(1.0), input); // D1 on the protected sheet
    seed(&wb, 1, 3, CellValue::Number(1.0), input); // D2
    protect(&wb, false);
    let from_float = |style_index: usize, row: u32| {
        let mut u = landed(row, 3, "5", style_index, Some((0, 0)));
        u.moved = Some(MovedFrom { sheet_index: 0, row: 0, col: 0, target: Some(target.clone()) });
        u
    };
    write(&wb, from_float(bold, 0)).expect("a cut out of Float1 onto D1");
    assert!(shown(&wb, 0, 3).0.font.bold, "a cut out of a floating grid's cell lost its format (the claim was not judged on the backing sheet)");
    write(&wb, from_float(italic, 1)).expect("the value lands");
    assert_eq!(shown(&wb, 1, 3).1, input, "a claim naming a style Float1!A1 does not show carried it");
}
