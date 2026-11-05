//! FILENAME: app/src-tauri/src/commands/paste_source_tests.rs
//! PURPOSE: BUG-0657 -- a paste writes what its SOURCE holds at the write.
//!
//! A child module of `commands::data` (declared with `#[path]` there), driving
//! the real bodies -- `update_cells_batch_core` (every sheet paste) and
//! `cell_target::update_cells_batch_on_target` (a floating grid's paste) --
//! through the shared `cross_sheet_recalc_tests::Workbook` harness.
//!
//! THE DEFECT. Under a source written continuously (an animation, a fast
//! scheduled job), Paste wrote the LAST frontend re-read of the source, which
//! the writer had already outrun by the time the batch landed. Excel pastes
//! what the source holds at the paste [LIVE, round 19, misc19/probe3.ps1: with
//! A1 = B1*2 copied, a write of 5 into B1 keeps the copy pending and Paste
//! Values gives 10]. `CellUpdateInput::source` names the source cell; the batch
//! reads it under its own held grid guards, before any of its writes, and the
//! caller's `value` is only the fallback.

use super::cross_sheet_recalc_tests::Workbook;
use super::*;
use crate::api_types::{CellTargetRef, CellUpdateInput, FloatingRangePatch, PasteSource};
use engine::CellValue;

fn workbook() -> Workbook {
    let wb = Workbook::new(1);
    *wb.state.locale.lock().unwrap() = engine::LocaleSettings::from_locale_id("en-US");
    wb
}

/// A paste of `from` (sheet 0) into (row, col), carrying the STALE text the
/// frontend's last re-read saw.
fn pasted(row: u32, col: u32, stale: &str, from: (u32, u32), values_only: bool) -> CellUpdateInput {
    CellUpdateInput {
        row,
        col,
        value: stale.to_string(),
        style_index: None,
        invariant: Some(true),
        pasted: Some(true),
        moved: None,
        source: Some(PasteSource {
            sheet_index: 0,
            row: from.0,
            col: from.1,
            target: None,
            values_only: values_only.then_some(true),
            unshifted: None,
        }),
    }
}

fn batch(wb: &Workbook, updates: Vec<CellUpdateInput>) {
    update_cells_batch_core(&wb.state, &wb.file, &wb.files, &wb.pivots, updates, None, None, None, None)
        .expect("the paste writes");
}

fn cell(wb: &Workbook, row: u32, col: u32) -> engine::Cell {
    wb.state.grids.read().unwrap()[0].get_cell(row, col).cloned().expect("a stored cell")
}

// SABOTAGE: `let value = &update.value;` in update_cells_batch_core -> C1 is the
// stale 1, not the 5 A1 holds.
#[test]
fn pastesource_a_paste_writes_what_the_source_holds_at_the_write_not_the_stale_reread() {
    let wb = workbook();
    wb.set(0, 0, "5"); // A1 = 5 NOW; the frontend's re-read saw 1.
    batch(&wb, vec![pasted(0, 2, "1", (0, 0), false)]);
    assert_eq!(cell(&wb, 0, 2).value, CellValue::Number(5.0), "the paste wrote the stale re-read");

    // The writer moves on; the next paste follows it.
    wb.set(0, 0, "7");
    batch(&wb, vec![pasted(0, 2, "5", (0, 0), false)]);
    assert_eq!(cell(&wb, 0, 2).value, CellValue::Number(7.0));
}

#[test]
fn pastesource_a_source_formula_is_shifted_as_copy_and_paste_shifts_it() {
    let wb = workbook();
    wb.set(0, 0, "3"); // A1
    wb.set(0, 1, "=A1*2"); // B1
    wb.set(2, 2, "10"); // C3
    // B1 pasted into D3: two rows down, two columns right -> =C3*2.
    batch(&wb, vec![pasted(2, 3, "=Z99", (0, 1), false)]);
    let d3 = cell(&wb, 2, 3);
    assert_eq!(d3.formula_string().as_deref(), Some("C3*2"), "the formula was not shifted from its source");
    assert_eq!(d3.value, CellValue::Number(20.0));
}

#[test]
fn pastesource_values_only_pastes_the_current_result_and_text_errors_and_blanks_keep_their_kind() {
    let wb = workbook();
    wb.set(0, 0, "3"); // A1
    wb.set(0, 1, "=A1*2"); // B1 = 6
    wb.set(1, 0, "007x"); // A2 text
    wb.set(1, 1, "=NA()"); // B2 #N/A
    wb.set(3, 3, "stale"); // D4, pasted over by the empty A9
    batch(
        &wb,
        vec![
            pasted(0, 4, "2", (0, 1), true),
            pasted(1, 4, "", (1, 0), false),
            pasted(1, 5, "", (1, 1), true),
            pasted(3, 3, "stale", (8, 0), false),
        ],
    );
    let e1 = cell(&wb, 0, 4);
    assert!(!e1.has_formula(), "Paste Values wrote the formula");
    assert_eq!(e1.value, CellValue::Number(6.0), "Paste Values wrote the stale result");
    assert_eq!(cell(&wb, 1, 4).value, CellValue::Text("007x".to_string()));
    assert_eq!(cell(&wb, 1, 5).value, CellValue::Error(engine::CellError::NA));
    let d4 = wb.state.grids.read().unwrap()[0].get_cell(3, 3).cloned();
    assert!(d4.map_or(true, |c| c.value == CellValue::Empty), "an empty source pastes an empty cell");
}

/// Positive control for the fallback: no source -> `value`, as before; a
/// source sheet that does not exist -> `value`.
#[test]
fn pastesource_without_a_resolvable_source_the_callers_value_is_written() {
    let wb = workbook();
    wb.set(0, 0, "5");
    let mut plain = pasted(0, 2, "1", (0, 0), false);
    plain.source = None;
    let mut nowhere = pasted(0, 3, "2", (0, 0), false);
    nowhere.source.as_mut().unwrap().sheet_index = 9;
    batch(&wb, vec![plain, nowhere]);
    assert_eq!(cell(&wb, 0, 2).value, CellValue::Number(1.0));
    assert_eq!(cell(&wb, 0, 3).value, CellValue::Number(2.0));
}

/// The floating-grid route reads the source the same way, before its writes.
// SABOTAGE: drop the `if let Some(text) = from_source` block in
// write_batch_on_backing -> the backing cell is the stale 1.
#[test]
fn pastesource_a_floating_grid_paste_writes_what_the_source_holds_now() {
    let wb = workbook();
    wb.set(0, 0, "5"); // the sheet's A1
    let info = crate::floating_range::create_floating_range_inner(&wb.state, &wb.file, Some("Float1".to_string()), 100.0, 50.0)
        .expect("create a floating range");
    crate::floating_range::update_floating_range_inner(
        &wb.state,
        &wb.file,
        info.range.id,
        FloatingRangePatch { row_count: Some(5), col_count: Some(5), ..Default::default() },
        crate::floating_range::PatchGate::ObjectEdit,
    )
    .expect("size the window");
    let target = CellTargetRef::FloatingRange { id: info.range.id };
    let backing = info.backing_sheet_index;
    crate::cell_target::update_cells_batch_on_target(
        &wb.state,
        &wb.file,
        &wb.files,
        &wb.pivots,
        &wb.pane,
        &wb.filters,
        &target,
        vec![pasted(0, 0, "1", (0, 0), false)],
        "Paste",
    )
    .expect("the grid paste writes");
    let at = wb.state.grids.read().unwrap()[backing].get_cell(0, 0).cloned().expect("a backing cell");
    assert_eq!(at.value, CellValue::Number(5.0), "the floating grid pasted the stale re-read");
}

/// rev-backend-8: `write_batch_on_backing` reads the active index UNDER the
/// grid guards it pairs it with, as `update_cells_batch_core` does. A race
/// between two reads cannot be provoked deterministically here, so the order
/// is pinned in the source.
#[test]
fn pastesource_write_batch_on_backing_reads_the_active_index_under_its_grid_guards() {
    let src = include_str!("../cell_target.rs");
    let start = src.find("pub(crate) fn write_batch_on_backing(").expect("the function");
    let body = &src[start..];
    let body = &body[..body.find("let mut written").expect("the write loop")];
    let grid_at = body.find("state.grid.read()").expect("the grid guard");
    let active_at = body.find("state.active_sheet.read()").expect("the active index");
    assert!(grid_at < active_at, "the active index is read before the grid guards it is paired with");
}

/// A MOVE (`unshifted`: Cut + Paste, a drag move) writes the source's formula
/// as it stands -- the move's relocation re-points the references into the
/// moved block, and every other reference stays (Excel's move: `=A1*2` moved
/// from B1 to D3 stays `=A1*2`). A copy of the same source shifts it.
// SABOTAGE: ignore `unshifted` in resolve_paste_sources -> D3 is =C3*2.
#[test]
fn pastesource_a_move_writes_the_source_formula_unshifted() {
    let wb = workbook();
    wb.set(0, 0, "3"); // A1
    wb.set(0, 1, "=A1*2"); // B1
    let mut moved = pasted(2, 3, "=Z99", (0, 1), false);
    moved.source.as_mut().unwrap().unshifted = Some(true);
    batch(&wb, vec![moved]);
    let d3 = cell(&wb, 2, 3);
    assert_eq!(d3.formula_string().as_deref(), Some("A1*2"), "a moved formula was shifted");
    assert_eq!(d3.value, CellValue::Number(6.0));
}

/// A formula its PROTECTED sheet hides (`formula_hidden`) is pasted as its
/// VALUE through a source reference: the copy's own read withholds it, and a
/// source reference must not be the way round that -- a script naming a
/// hidden cell as a paste source would read the formula out of the cell it
/// pasted into. (Sheet2 is protected; the paste lands on Sheet1.)
// SABOTAGE: drop `&& !hidden` in resolve_paste_sources -> the formula is pasted.
#[test]
fn pastesource_a_hidden_formula_of_a_protected_sheet_pastes_as_its_value() {
    let wb = Workbook::new(2);
    *wb.state.locale.lock().unwrap() = engine::LocaleSettings::from_locale_id("en-US");
    wb.switch_to(1);
    wb.set(0, 0, "3"); // Sheet2!A1
    wb.set(0, 1, "=A1*2"); // Sheet2!B1 = 6
    let hidden = wb
        .state
        .style_registry
        .write(&crate::document_effect::test_seed_effect())
        .unwrap()
        .get_or_create({
            let mut s = engine::CellStyle::new();
            s.formula_hidden = true;
            s
        });
    {
        let seed = crate::document_effect::test_seed_effect();
        let mut b1 = wb.state.grid.read().unwrap().get_cell(0, 1).cloned().expect("B1");
        b1.style_index = hidden;
        wb.state.grid.write(&seed).unwrap().set_cell(0, 1, b1.clone());
        wb.state.grids.write(&seed).unwrap()[1].set_cell(0, 1, b1);
    }
    wb.switch_to(0);
    wb.state.sheet_protection.write(&crate::document_effect::test_seed_effect()).unwrap().insert(
        1,
        crate::protection::SheetProtection {
            protected: true,
            password_hash: None,
            password_salt: None,
            options: crate::protection::SheetProtectionOptions::default(),
            allow_edit_ranges: Vec::new(),
        },
    );
    let mut from_hidden = pasted(0, 2, "6", (0, 1), false);
    from_hidden.source.as_mut().unwrap().sheet_index = 1;
    batch(&wb, vec![from_hidden]);
    let c1 = cell(&wb, 0, 2);
    assert!(!c1.has_formula(), "HIDDEN FORMULA PASTED: {:?}", c1.formula_string());
    assert_eq!(c1.value, CellValue::Number(6.0));

    // Control: with the protection off, the same source pastes its formula.
    wb.state.sheet_protection.write(&crate::document_effect::test_seed_effect()).unwrap().clear();
    let mut plain = pasted(0, 3, "6", (0, 1), false);
    plain.source.as_mut().unwrap().sheet_index = 1;
    batch(&wb, vec![plain]);
    assert!(cell(&wb, 0, 3).has_formula(), "control: an unprotected source pastes its formula");
}
