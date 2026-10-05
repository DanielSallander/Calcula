//! FILENAME: app/src-tauri/src/commands/structure_review_tests.rs
//! PURPOSE: The adversarial review of the Home-tab programme (2026-10-04) found
//!          four defects in Insert/Delete Cells and the whole-line inserts; each
//!          is pinned here with the reviewer's own reproduction:
//!          1. a formula whose range STRADDLES the band kept a stale value,
//!             because the edit changed what the range holds without changing
//!             its address, and only rewritten or moved formulas were seeded;
//!          2. the spill-claims undo record was skipped when the sheet had no
//!             claims, so claims the edit CREATED survived Undo and later
//!             erased the user's restored cells;
//!          3. Select All + Insert (and any whole-line insert) had no push-off
//!             refusal and wrote cells past the sheet's last row.
//!          Review finding 7 (a delete GROWS a range on the sheet's last line)
//!          was measured on live Excel and is what Excel does; the band half of
//!          that probe is pinned here, the whole-line half in
//!          `structure_lines_tests.rs`.
//! CONTEXT: A `#[path]` child of `structure_cells_tests`, sharing its `Fx`
//!          harness and the probe book.

use super::*;

// ===========================================================================
// 1. A range that straddles the band is recalculated, on every sheet
// ===========================================================================

/// The probe's block A1:E12 (10*row + col) with NOTHING that names the band
/// B:C -- so no formula is rewritten and no sheet is recalculated for having
/// been rewritten. (`probe_book`'s Sheet2 formulas DO name the band, and their
/// rewrite recalculates the whole active sheet, which hid this defect from the
/// reviewer's repro when it was run on that book.)
fn straddle_book() -> Fx {
    let fx = Fx::new(2);
    for row in 1..=12u32 {
        for col in 1..=5u32 {
            let a1_ref = format!("{}{}", calcula_format::cell_ref::col_to_letters(col - 1), row);
            fx.put(0, &a1_ref, &format!("{}", row * 10 + col));
        }
    }
    fx
}

/// The reviewer's reproduction: `F20 =SUM(A1:E12)` and `Sheet2!A3
/// =SUM(Sheet1!A1:E12)` straddle the band B:C, so neither address changes --
/// but Delete Cells B2:C3 (shift up) removes 22+23+32+33 = 110 from what they
/// add up and leaves B11:C12 empty. Both used to keep the old total.
#[test]
fn delete_cells_recalculates_a_range_that_straddles_the_band_on_every_sheet() {
    let fx = straddle_book();
    fx.put(0, "F20", "=SUM(A1:E12)");
    fx.put(1, "A3", "=SUM(Sheet1!A1:E12)");
    fx.settle();
    fx.mark_clean();
    let before = fx.number(0, "F20");
    assert_eq!(fx.number(1, "A3"), before, "precondition: both read the same block");

    fx.shift("B2:C3", CellShift::Up, false).expect("delete cells");
    assert_eq!(fx.formula(0, "F20").as_deref(), Some("=SUM(A1:E12)"), "it straddles: the address stays");
    assert_eq!(fx.number(0, "F20"), before - 110.0, "the deleted block no longer counts");
    assert_eq!(fx.number(1, "A3"), before - 110.0, "the other sheet is recalculated too");
}

/// Insert Cells B2:C3 (shift down) pushes B11:C12 (112+113+122+123 = 470)
/// out of A1:E12 to rows 13-14. A defined name over the same block straddles
/// the band the same way and is recalculated through its name.
#[test]
fn insert_cells_recalculates_a_straddling_range_and_a_name_over_one() {
    let fx = straddle_book();
    let seed = crate::document_effect::test_seed_effect();
    fx.state.named_ranges.write(&seed).unwrap().insert(
        "BLOCK".to_string(),
        crate::named_ranges::NamedRange {
            name: "BLOCK".to_string(),
            sheet_index: None,
            refers_to: "=Sheet1!$A$1:$E$12".to_string(),
            comment: None,
            folder: None,
        },
    );
    fx.put(0, "F20", "=SUM(A1:E12)");
    fx.put(0, "G20", "=SUM(BLOCK)");
    fx.put(1, "A3", "=SUM(Sheet1!A1:E12)");
    fx.settle();
    fx.mark_clean();
    let before = fx.number(0, "F20");
    assert_eq!(fx.number(0, "G20"), before, "precondition: the name reads the same block");

    fx.shift("B2:C3", CellShift::Down, false).expect("insert cells");
    assert_eq!(fx.formula(0, "F20").as_deref(), Some("=SUM(A1:E12)"));
    assert_eq!(fx.number(0, "F20"), before - 470.0, "B11:C12 were pushed out of the range");
    assert_eq!(fx.number(0, "G20"), before - 470.0, "the name over the block is recalculated");
    assert_eq!(fx.number(1, "A3"), before - 470.0);

    // Undo puts the cells back; the restored values add up again.
    fx.undo();
    assert_eq!(fx.number(0, "F20"), before);
}

/// The band half of review finding 7, measured on live Excel (fix-rust probe
/// 1, a fresh hidden instance, 2026-10-04): Delete Cells B2:C3 up with a
/// reference on the sheet's LAST row(s) inside the band GROWS it -- the range
/// keeps reaching the last row while its start moves up with its cells.
#[test]
fn a_band_delete_grows_a_reference_on_the_last_row_as_excel_did() {
    assert_rewrites(
        CellShift::Up,
        &[
            ("=SUM(B1048576:C1048576)", "=SUM(B1048574:C1048576)"),
            ("=SUM(B1048575:C1048576)", "=SUM(B1048573:C1048576)"),
            ("=SUM(B1048576:B1048576)", "=SUM(B1048574:B1048576)"),
        ],
    );
}

// ===========================================================================
// 2. Spill claims are undone even when the sheet had none before the edit
// ===========================================================================

/// The reviewer's trigger: `A1 =SEQUENCE(ROWS(A5:A7))` is blocked by `A3 =
/// "x"` (`#SPILL!`), so the sheet holds no claim. Delete Cells A3 (shift up)
/// rewrites A5:A7 to A4:A6, and A1 spills into A1:A3 -- a claim the edit
/// CREATED. Undo restored the cells but kept the claim, and the next
/// evaluation of A1 released it by ERASING A2:A3, the user's "x" with them.
#[test]
fn undo_removes_a_spill_claim_the_edit_created_on_a_sheet_that_had_none() {
    let fx = Fx::new(1);
    fx.put(0, "A1", "=SEQUENCE(ROWS(A5:A7))");
    fx.put(0, "A3", "x");
    fx.settle();
    assert!(!matches!(fx.value(0, "A1"), CellValue::Number(_)), "A1 is blocked before the edit");
    let claims_on_sheet =
        |fx: &Fx| fx.state.spill_ranges.read().unwrap().keys().filter(|k| k.0 == 0).count();
    assert_eq!(claims_on_sheet(&fx), 0, "precondition: no claim on the sheet");

    fx.shift("A3", CellShift::Up, false).expect("delete cells");
    assert_eq!(fx.formula(0, "A1").as_deref(), Some("=SEQUENCE(ROWS(A4:A6))"));
    assert_eq!(fx.number(0, "A3"), 3.0, "A1 spills into the room the delete made");
    assert_eq!(claims_on_sheet(&fx), 1, "the edit created a claim");

    fx.undo();
    assert_eq!(fx.value(0, "A3"), CellValue::Text("x".to_string()), "Undo puts the blocker back");
    assert_eq!(claims_on_sheet(&fx), 0, "Undo removes the claim the edit created");
    // The next evaluation of A1 must not release a claim it no longer has.
    fx.settle();
    assert_eq!(
        fx.value(0, "A3"),
        CellValue::Text("x".to_string()),
        "the restored blocker survives a recalculation"
    );
}

// ===========================================================================
// 3. Every insert path refuses to push a non-empty cell off the sheet
// ===========================================================================

fn last_col_letters() -> String {
    calcula_format::cell_ref::col_to_letters(engine::EXCEL_MAX_COL_INDEX)
}

/// Select All, then Insert (Ctrl+Plus, or the Home tab's Insert picture):
/// the range spans every column, so it becomes an entire-row insert of
/// 1,048,576 rows at row 1 -- which pushes every non-empty cell off the sheet.
/// The band path refused the same gesture; the whole-line path wrote the
/// cells past the last row. Both now give Excel's one answer.
#[test]
fn select_all_insert_is_refused_like_the_band_insert_and_changes_nothing() {
    let fx = probe_book();
    let depth = fx.undo_depth();
    let all = format!("A1:{}{}", last_col_letters(), engine::EXCEL_MAX_ROW_INDEX + 1);
    for shift in [CellShift::Right, CellShift::Down] {
        assert_eq!(fx.shift(&all, shift, false).unwrap_err(), PUSH_OFF_REFUSAL, "{:?}", shift);
    }
    assert!(!fx.file.is_dirty(), "a refusal leaves the document clean");
    assert_eq!(fx.undo_depth(), depth, "a refusal records nothing");
    assert_eq!(fx.number(0, "B2"), 22.0, "nothing moved");
    let grid = fx.state.grid.read().unwrap();
    assert!(
        grid.cells.keys().all(|&(r, c)| r <= engine::EXCEL_MAX_ROW_INDEX && c <= engine::EXCEL_MAX_COL_INDEX),
        "no cell exists past the sheet's edge"
    );
}

/// The whole-line commands themselves -- rows, columns, and the OFF-SHEET
/// path a grouped or scripted insert takes -- refuse when a non-empty cell
/// (formatting alone counts, as in Excel) would be pushed off the sheet, and
/// insert when the edge is empty.
#[test]
fn whole_line_inserts_refuse_to_push_a_non_empty_cell_off_the_sheet() {
    let last_row = engine::EXCEL_MAX_ROW_INDEX;
    let rows = |fx: &Fx, at: u32, count: u32, sheet: Option<usize>| {
        insert_rows_impl(&fx.state, &fx.file, &fx.pivots, &fx.files, &fx.pane, &fx.filters, &fx.slicer, &fx.timeline, at, count, sheet)
    };
    let cols = |fx: &Fx, at: u32, count: u32, sheet: Option<usize>| {
        insert_columns_impl(&fx.state, &fx.file, &fx.pivots, &fx.files, &fx.pane, &fx.filters, &fx.slicer, &fx.timeline, at, count, sheet)
    };

    // Rows, active sheet: a value on the last row.
    let fx = Fx::new(2);
    fx.put(0, &format!("B{}", last_row + 1), "edge");
    assert_eq!(rows(&fx, 4, 1, None).unwrap_err(), PUSH_OFF_REFUSAL);
    assert!(!fx.file.is_dirty());
    assert_eq!(fx.undo_depth(), 0);
    assert_eq!(fx.value(0, &format!("B{}", last_row + 1)), CellValue::Text("edge".to_string()));
    // ...and a formatting-only cell counts too.
    let fx = Fx::new(1);
    {
        let seed = crate::document_effect::test_seed_effect();
        let mut cell = Cell::new();
        cell.style_index = 2;
        fx.state.grid.write(&seed).unwrap().set_cell(last_row - 1, 3, cell);
    }
    assert_eq!(rows(&fx, 0, 2, None).unwrap_err(), PUSH_OFF_REFUSAL, "two rows push the second-last row off");
    assert!(rows(&fx, 0, 1, None).is_ok(), "one row pushes nothing off");

    // Columns, active sheet.
    let fx = Fx::new(1);
    fx.put(0, &format!("{}1", last_col_letters()), "edge");
    assert_eq!(cols(&fx, 1, 1, None).unwrap_err(), PUSH_OFF_REFUSAL);
    assert!(!fx.file.is_dirty());

    // The off-sheet path (sheet 1 while sheet 0 is active).
    let fx = Fx::new(2);
    fx.put(1, &format!("A{}", last_row + 1), "edge");
    assert_eq!(rows(&fx, 0, 1, Some(1)).unwrap_err(), PUSH_OFF_REFUSAL);
    assert!(!fx.file.is_dirty());
    assert_eq!(fx.undo_depth(), 0);
    assert_eq!(fx.value(1, &format!("A{}", last_row + 1)), CellValue::Text("edge".to_string()));
    fx.put(1, &format!("{}5", last_col_letters()), "edge");
    assert_eq!(cols(&fx, 0, 1, Some(1)).unwrap_err(), PUSH_OFF_REFUSAL);

    // An empty edge inserts as before.
    let fx = Fx::new(1);
    fx.put(0, "A5", "1");
    assert!(rows(&fx, 0, 3, None).is_ok());
    assert_eq!(fx.number(0, "A8"), 1.0);
}

/// Nothing to insert (0 lines) and more lines than the sheet has room for
/// below the insertion point are refused before anything happens -- on the
/// whole-line paths the band path never reaches with such a count.
#[test]
fn an_insert_of_zero_lines_or_more_than_the_sheet_holds_is_refused() {
    let last_row = engine::EXCEL_MAX_ROW_INDEX;
    let last_col = engine::EXCEL_MAX_COL_INDEX;
    let fx = Fx::new(2);
    let rows = |at: u32, count: u32, sheet: Option<usize>| {
        insert_rows_impl(&fx.state, &fx.file, &fx.pivots, &fx.files, &fx.pane, &fx.filters, &fx.slicer, &fx.timeline, at, count, sheet)
    };
    let cols = |at: u32, count: u32, sheet: Option<usize>| {
        insert_columns_impl(&fx.state, &fx.file, &fx.pivots, &fx.files, &fx.pane, &fx.filters, &fx.slicer, &fx.timeline, at, count, sheet)
    };
    assert!(rows(3, 0, None).is_err(), "zero rows");
    assert!(cols(3, 0, None).is_err(), "zero columns");
    assert!(rows(5, last_row + 1, None).is_err(), "more rows than fit below row 6");
    assert!(cols(5, last_col + 1, None).is_err(), "more columns than fit right of column F");
    assert!(rows(last_row + 1, 1, None).is_err(), "an insertion point past the sheet");
    assert!(rows(0, 0, Some(1)).is_err(), "the off-sheet path refuses zero rows too");
    assert!(rows(5, last_row + 1, Some(1)).is_err(), "and an off-sheet count past the edge");
    assert!(!fx.file.is_dirty(), "every refusal leaves the document clean");
    assert_eq!(fx.undo_depth(), 0);
    // The whole sheet's worth at row 1 of an EMPTY sheet pushes nothing off.
    assert!(rows(0, last_row + 1, None).is_ok(), "an empty sheet has nothing to push off");
}
