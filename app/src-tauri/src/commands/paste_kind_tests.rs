//! FILENAME: app/src-tauri/src/commands/paste_kind_tests.rs
//! PURPOSE: A PASTE keeps its kind in a Text-formatted (`@`) cell, and the
//! typed read says which cells had a formula WITHHELD (BUG-0346 follow-up).
//!
//! A child module of `commands::data` (declared with `#[path]` there), so it
//! drives the real bodies -- `update_cells_batch_core` (every sheet paste),
//! `cell_target::update_cells_batch_on_target` (a floating grid's paste) and
//! `range_cells_typed` (the typed read) -- with no Tauri runtime, through the
//! shared `cross_sheet_recalc_tests::Workbook` harness.
//!
//! WHAT IS PINNED, and the Excel it is measured against [LIVE, Excel 16 over
//! COM, 2026-10-29, fresh unsaved workbooks]:
//!   1. `CellUpdateInput::pasted` skips the typed-entry ladder's Text rung: a
//!      pasted formula stays a formula, a pasted number / TRUE / #N/A stays
//!      one, in an `@` cell that KEEPS its own style -- on a protected sheet the
//!      unlocked input cell stays unlocked (Paste Formulas of `=A1` into an
//!      unlocked `@` cell: HasFormula True, NumberFormat `@`, no error). The
//!      frontend used to rewrite such a cell with `styleIndex: 0`, which
//!      replaced its protection flags too and LOCKED it.
//!   2. A typed entry is unchanged: `=A1` typed into an `@` cell is the text.
//!   3. The same flag on a floating grid's batch (`update_cell_on_sheets_as`).
//!   4. `TypedCellData::formula_withheld` is true for exactly the cells whose
//!      formula the read withheld -- any lock state -- and never for a hidden
//!      cell holding a constant or nothing.

use super::cross_sheet_recalc_tests::Workbook;
use super::*;
use crate::api_types::{CellTargetRef, CellUpdateInput, FloatingRangePatch};
use crate::protection::{AllowEditRange, SheetProtection, SheetProtectionOptions};
use engine::{CellError, CellStyle, CellValue, NumberFormat};

fn workbook() -> Workbook {
    let wb = Workbook::new(1);
    *wb.state.locale.lock().unwrap() = engine::LocaleSettings::from_locale_id("en-US");
    wb
}

/// Intern a style built from the default one.
fn style(wb: &Workbook, build: impl FnOnce(CellStyle) -> CellStyle) -> usize {
    wb.state
        .style_registry
        .write(&crate::document_effect::test_seed_effect())
        .unwrap()
        .get_or_create(build(CellStyle::new()))
}

fn text_format() -> NumberFormat {
    NumberFormat::Custom { format: "@".to_string() }
}

/// Give the active sheet's cell (row, col) the style `index`, keeping its
/// content (an empty styled cell when there is none). Canonical lock order:
/// grid, then grids.
fn restyle(wb: &Workbook, row: u32, col: u32, index: usize) {
    let seed = crate::document_effect::test_seed_effect();
    let mut cell = wb.state.grid.read().unwrap().get_cell(row, col).cloned().unwrap_or_else(engine::Cell::new);
    cell.style_index = index;
    wb.state.grid.write(&seed).unwrap().set_cell(row, col, cell.clone());
    wb.state.grids.write(&seed).unwrap()[0].set_cell(row, col, cell);
}

fn protect(wb: &Workbook, allow_edit_ranges: Vec<AllowEditRange>) {
    wb.state.sheet_protection.write(&crate::document_effect::test_seed_effect()).unwrap().insert(
        0,
        SheetProtection {
            protected: true,
            password_hash: None,
            password_salt: None,
            options: SheetProtectionOptions::default(),
            allow_edit_ranges,
        },
    );
}

/// One write through the REAL batch body, as `update_cells_batch` runs it.
fn batch(wb: &Workbook, update: CellUpdateInput) -> Result<Vec<CellData>, String> {
    update_cells_batch_core(&wb.state, &wb.file, &wb.files, &wb.pivots, vec![update], None, None, None, None)
}

fn update(row: u32, col: u32, value: &str, invariant: bool, pasted: bool) -> CellUpdateInput {
    CellUpdateInput {
        row,
        col,
        value: value.to_string(),
        style_index: None,
        invariant: invariant.then_some(true),
        pasted: pasted.then_some(true),
    }
}

fn cell(wb: &Workbook, row: u32, col: u32) -> engine::Cell {
    wb.state.grids.read().unwrap()[0].get_cell(row, col).cloned().expect("a stored cell")
}

// ---------------------------------------------------------------------------
// 1-3. A paste keeps its kind in a Text cell
// ---------------------------------------------------------------------------

/// rev3B#1 / rev3B#4 / revE#2: Paste Formulas of `=A1` onto an UNLOCKED `@`
/// input cell of a protected sheet. One write, the formula kept, the cell's
/// own style (unlocked, `@`) untouched -- so the user can still type there.
// SABOTAGE: `let ladder_format = Some(&target_format);` in update_cells_batch_core
// -> C3 holds the TEXT "=A1".
#[test]
fn pastekind_a_pasted_formula_stays_a_formula_in_an_unlocked_text_cell_on_a_protected_sheet() {
    let wb = workbook();
    wb.set(0, 0, "5"); // A1
    let unlocked_text = style(&wb, |s| {
        let mut s = s.with_number_format(text_format());
        s.locked = false;
        s
    });
    restyle(&wb, 2, 2, unlocked_text); // C3
    protect(&wb, Vec::new());

    batch(&wb, update(2, 2, "=A1", false, true)).expect("a paste into an unlocked input cell is allowed");
    let c3 = cell(&wb, 2, 2);
    assert!(c3.has_formula(), "the pasted =A1 landed as {:?}, not a formula", c3.value);
    assert_eq!(c3.value, CellValue::Number(5.0), "the pasted formula is evaluated");
    assert_eq!(c3.style_index, unlocked_text, "the input cell keeps its own style: still @, still UNLOCKED");

    // Still an input cell: a TYPED entry lands -- and, typed, `=A1` in an @
    // cell is the text, as Excel stores it (the ladder's Text rung, unchanged).
    batch(&wb, update(2, 2, "=A1", false, false)).expect("the cell is still unlocked");
    assert_eq!(cell(&wb, 2, 2).value, CellValue::Text("=A1".to_string()));
    assert!(!cell(&wb, 2, 2).has_formula());
}

/// revE#2 / NEW-drag-move-by-display-text: a pasted (or moved) constant's
/// stored value keeps its kind in an `@` cell; text keeps the verbatim escape.
#[test]
fn pastekind_a_pasted_number_boolean_and_error_keep_their_kind_in_a_text_cell() {
    let wb = workbook();
    let text = style(&wb, |s| s.with_number_format(text_format()));
    for col in 0..5 {
        restyle(&wb, 0, col, text);
    }
    batch(&wb, update(0, 0, "5", true, true)).unwrap();
    batch(&wb, update(0, 1, "TRUE", true, true)).unwrap();
    batch(&wb, update(0, 2, "#N/A", true, true)).unwrap();
    batch(&wb, update(0, 3, "'007", true, true)).unwrap();
    assert_eq!(cell(&wb, 0, 0).value, CellValue::Number(5.0), "a pasted 5 stays the number 5");
    assert_eq!(cell(&wb, 0, 1).value, CellValue::Boolean(true));
    assert_eq!(cell(&wb, 0, 2).value, CellValue::Error(CellError::NA));
    assert_eq!(cell(&wb, 0, 3).value, CellValue::Text("007".to_string()), "pasted text stays text, verbatim");
    for col in 0..4 {
        assert_eq!(cell(&wb, 0, col).style_index, text, "the cell keeps its @");
    }
    // Positive control: the same invariant 5 as a script's typed write is text.
    batch(&wb, update(0, 4, "5", true, false)).unwrap();
    assert_eq!(cell(&wb, 0, 4).value, CellValue::Text("5".to_string()));
}

/// Paste All from an `@` SOURCE: the source's style travels as `styleIndex`,
/// and the number stays a number under it (Excel: 5 from an @ cell pastes as
/// the number 5 with @).
#[test]
fn pastekind_a_paste_carrying_a_text_source_style_keeps_the_number() {
    let wb = workbook();
    let text = style(&wb, |s| s.with_number_format(text_format()));
    let mut pasted = update(1, 0, "5", true, true);
    pasted.style_index = Some(text);
    batch(&wb, pasted).unwrap();
    assert_eq!(cell(&wb, 1, 0).value, CellValue::Number(5.0));
    assert_eq!(cell(&wb, 1, 0).style_index, text);

    let mut typed = update(1, 1, "5", true, false);
    typed.style_index = Some(text);
    batch(&wb, typed).unwrap();
    assert_eq!(cell(&wb, 1, 1).value, CellValue::Text("5".to_string()), "positive control: an entry is text");
}

/// The floating-grid route: `update_cells_batch_on_target` hands the flag to
/// `update_cell_on_sheets_as`, which used to re-parse every entry into an `@`
/// backing cell as text.
// SABOTAGE: `let stored_as_text = is_text_format(&target_format);` in
// update_cell_on_sheets_as -> the backing cell holds the text "=1+1".
#[test]
fn pastekind_a_floating_grid_paste_keeps_its_kind_in_a_text_cell() {
    let wb = workbook();
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
    let text = style(&wb, |s| s.with_number_format(text_format()));

    let mut formula = update(0, 0, "=1+1", false, true);
    formula.style_index = Some(text);
    let mut number = update(0, 1, "5", true, true);
    number.style_index = Some(text);
    let mut typed = update(0, 2, "5", true, false);
    typed.style_index = Some(text);
    crate::cell_target::update_cells_batch_on_target(
        &wb.state,
        &wb.file,
        &wb.files,
        &wb.pivots,
        &wb.pane,
        &wb.filters,
        &target,
        vec![formula, number, typed],
        "Paste",
    )
    .expect("the grid paste writes");

    let at = |col: u32| wb.state.grids.read().unwrap()[backing].get_cell(0, col).cloned().expect("a backing cell");
    assert!(at(0).has_formula(), "the pasted =1+1 landed as {:?}", at(0).value);
    assert_eq!(at(0).value, CellValue::Number(2.0));
    assert_eq!(at(1).value, CellValue::Number(5.0), "the pasted 5 stays a number");
    assert_eq!(at(2).value, CellValue::Text("5".to_string()), "positive control: an entry into @ is text");
    for col in 0..3 {
        assert_eq!(at(col).style_index, text, "the source's @ arrived");
    }
}

// ---------------------------------------------------------------------------
// 4. The typed read reports a WITHHELD formula
// ---------------------------------------------------------------------------

/// rev3B#2 / rev3B#3 / revE#1: on a protected sheet the typed read withholds a
/// hidden formula; `formula_withheld` marks exactly those cells, locked or
/// not, and no hidden-format cell holding a constant or nothing.
// SABOTAGE: `let formula_withheld = false;` in range_cells_typed -> D5/F5 not marked.
#[test]
fn pastekind_the_typed_read_marks_exactly_the_withheld_formulas() {
    let wb = workbook();
    wb.set(0, 0, "1"); // A1
    wb.set(4, 3, "=A1"); // D5: locked + hidden, inside an allow-edit range
    wb.set(5, 4, "7"); // E6: unlocked + hidden constant
    wb.set(4, 5, "=A1"); // F5: unlocked + hidden formula
    wb.set(4, 6, "=A1"); // G5: a formula NOT hidden
    let locked_hidden = style(&wb, |mut s| {
        s.formula_hidden = true;
        s
    });
    let unlocked_hidden = style(&wb, |mut s| {
        s.formula_hidden = true;
        s.locked = false;
        s
    });
    restyle(&wb, 4, 3, locked_hidden);
    restyle(&wb, 4, 4, unlocked_hidden); // E5: blank, unlocked + hidden
    restyle(&wb, 5, 4, unlocked_hidden);
    restyle(&wb, 4, 5, unlocked_hidden);
    protect(
        &wb,
        vec![AllowEditRange {
            title: "Inputs".to_string(),
            start_row: 4,
            start_col: 3,
            end_row: 4,
            end_col: 3,
            password_hash: None,
            password_salt: None,
        }],
    );

    let read = range_cells_typed(&wb.state, None, 4, 3, 5, 6).expect("the typed read");
    let at = |row: u32, col: u32| read.iter().find(|c| c.row == row && c.col == col).cloned();
    let d5 = at(4, 3).expect("D5");
    assert!(d5.formula.is_none() && d5.formula_withheld, "D5 (locked, hidden, writable): withheld");
    let f5 = at(4, 5).expect("F5");
    assert!(f5.formula.is_none() && f5.formula_withheld, "F5 (unlocked, hidden): withheld");
    assert!(at(4, 4).map_or(true, |c| !c.formula_withheld), "E5 is blank: nothing withheld");
    let e6 = at(5, 4).expect("E6");
    assert!(!e6.formula_withheld, "E6 holds a constant: nothing withheld");
    assert_eq!(e6.value, serde_json::json!(7.0));
    let g5 = at(4, 6).expect("G5");
    assert_eq!(g5.formula.as_deref(), Some("=A1"));
    assert!(!g5.formula_withheld);

    // On the wire: present only when true.
    let wire = serde_json::to_value(&d5).unwrap();
    assert_eq!(wire["formulaWithheld"], serde_json::json!(true));
    assert!(serde_json::to_value(&g5).unwrap().get("formulaWithheld").is_none());

    // Unprotected, nothing is withheld.
    wb.state.sheet_protection.write(&crate::document_effect::test_seed_effect()).unwrap().clear();
    let open = range_cells_typed(&wb.state, None, 4, 3, 4, 3).expect("the typed read");
    assert_eq!(open[0].formula.as_deref(), Some("=A1"));
    assert!(!open[0].formula_withheld);
}

// ---------------------------------------------------------------------------
// 5. Pasted TEXT sent invariant implies no format (rev5B#3)
// ---------------------------------------------------------------------------

/// rev5B#3 (BUG-0346): a script's pasteRange (and Core's paste,
/// `pastedConstantInput`) sends copied TEXT behind the apostrophe INVARIANT.
/// The invariant ladder stores the rest verbatim and implies NO format, so a
/// `General` destination stays `General` -- Excel's PasteSpecial xlPasteValues /
/// xlPasteFormulas of `'007`, `'TRUE` and `'2020-06-01` into General keep
/// NumberFormat General, and a 5 typed there later is the number 5 [LIVE].
/// Positive control: the same text sent as an ENTRY (localized) implies Text
/// (`@`) -- the route the script paste used to take in modes 'values' and
/// 'formulas', where no styleIndex keeps the cell's own.
// SABOTAGE: the invariant branch of update_cells_batch_core reports the
// localized ladder's implied format -> the General cells become @.
#[test]
fn pastekind_pasted_text_sent_invariant_leaves_a_general_cell_general() {
    let wb = workbook();
    let format_at = |row: u32, col: u32| {
        let index = cell(&wb, row, col).style_index;
        wb.state.style_registry.read().unwrap().get(index).number_format.clone()
    };
    let texts = ["007", "TRUE", "2020-06-01", "=A1"];
    for (col, text) in texts.iter().enumerate() {
        let col = col as u32;
        batch(&wb, update(0, col, &format!("'{text}"), true, true)).unwrap();
        assert_eq!(cell(&wb, 0, col).value, CellValue::Text(text.to_string()), "pasted text {text} is stored verbatim");
        assert_eq!(format_at(0, col), NumberFormat::General, "pasting the text {text} turned a General cell into Text (@)");
    }
    // The cell is still General: a 5 typed there now is the NUMBER 5.
    batch(&wb, update(0, 0, "5", false, false)).unwrap();
    assert_eq!(cell(&wb, 0, 0).value, CellValue::Number(5.0), "a 5 typed after the paste stayed text");

    // Positive control: the same text as a localized ENTRY implies @.
    batch(&wb, update(1, 0, "'007", false, true)).unwrap();
    assert_eq!(cell(&wb, 1, 0).value, CellValue::Text("007".to_string()));
    assert_eq!(format_at(1, 0), text_format(), "control: an entry's apostrophe implies @");
}
