//! FILENAME: app/src-tauri/src/commands/let_name_fill_tests.rs
//! PURPOSE: Fill Right, Fill Down and Copy+Paste keep a LET / LAMBDA name that
//! is spelled as a column range (`b:b`) a NAME, and move every real column.
//!
//! A child module of `commands::data` (declared with `#[path]` there), driven
//! through the shared `cross_sheet_recalc_tests::Workbook` harness: the fills go
//! through the REAL `fill_range_core` (Ctrl+R / Ctrl+D, Home > Fill), the paste
//! through the REAL body of `shift_formulas_batch`
//! (`structure::shift_formula_internal_with_tables`, which `useClipboard`'s
//! paste calls) and then the REAL `update_cells_batch_core`.
//!
//! THE DEFECT. The relative shift is a text regex with no LET / LAMBDA scope,
//! so copying `=LET(b,2,SUM(B:B)*b)` one column right wrote `SUM(C:C)` -- column
//! C, a number where Excel keeps the name and answers #VALUE!.
//!
//! [LIVE] Excel 16 over COM, round 20, a fresh unsaved workbook with A1:A5 =
//! 1..5, B1:B5 = 10..50, C1:C5 = 100..500 (scratchpad parsefix/probe1.ps1),
//! the formula in F1 (and K20 for the vertical cases), Range.FillRight onto G,
//! Range.Copy onto H (two right) and FillDown / Copy forty rows down:
//!   =LET(b,2,SUM(B:B)*b)       G, H, K21, K60: unchanged, #VALUE!
//!   =LET(b,A1:A3,SUM(B:D))     G: LET(b,B1:B3,SUM(b:D)) -- the value moves,
//!                              `b:D` (two names) does not; down: A2:A4
//!   =LET(b,2,SUM(A:B))         G: SUM(B:C) = 1650, H: SUM(C:D) -- the FIRST
//!                              half decides, and A is no name
//!   =LET(x,2,SUM(B:B)*x)       G: SUM(C:C) = 3000 (b is not bound)
//!   =LET(b,2,SUM(B:B))+SUM(B:B)  G: only the outer range, SUM(C:C)
//!   =LET(b,SUM(B:B),b)         G: SUM(C:C) (b is not bound in its own value)
//!   =LAMBDA(b,SUM(B:B))(A1:A2) G: (B1:B2), the body unchanged

use super::cross_sheet_recalc_tests::Workbook;
use super::*;
use engine::{CellError, CellValue};

fn workbook() -> Workbook {
    let wb = Workbook::new(1);
    *wb.state.locale.lock().unwrap() = engine::LocaleSettings::from_locale_id("en-US");
    for i in 0..5u32 {
        let n = i + 1;
        wb.set(i, 0, &n.to_string());
        wb.set(i, 1, &(10 * n).to_string());
        wb.set(i, 2, &(100 * n).to_string());
    }
    wb
}

/// The formula a cell holds, `=` + its text, UPPERCASED (the lexer uppercases
/// bare names: `=LET(b,..)` is stored `LET(B,..)`).
fn formula(wb: &Workbook, row: u32, col: u32) -> String {
    let grids = wb.state.grids.read().unwrap();
    grids[0]
        .get_cell(row, col)
        .and_then(|cell| cell.formula_string())
        .map(|f| format!("={}", f).to_uppercase())
        .unwrap_or_default()
}

fn value(wb: &Workbook, row: u32, col: u32) -> CellValue {
    wb.value(0, row, col)
}

fn fill(wb: &Workbook, source: (u32, u32, u32, u32), dest: (u32, u32, u32, u32)) {
    fill_range_core(&wb.state, &wb.file, &wb.files, &wb.pivots, &wb.pane, &wb.filters, source, dest)
        .expect("the fill runs");
}

/// Copy (row, col) and paste it at (to_row, to_col) as `useClipboard` does:
/// the shift `shift_formulas_batch` runs for it, then the batch write.
fn copy_paste(wb: &Workbook, (row, col): (u32, u32), (to_row, to_col): (u32, u32)) {
    let source = formula(wb, row, col);
    let shifted = crate::commands::structure::shift_formula_internal_with_tables(
        &source,
        to_row as i32 - row as i32,
        to_col as i32 - col as i32,
        None,
    );
    update_cells_batch_core(
        &wb.state,
        &wb.file,
        &wb.files,
        &wb.pivots,
        vec![crate::api_types::CellUpdateInput {
            row: to_row,
            col: to_col,
            value: shifted,
            style_index: None,
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
    .expect("the paste writes");
}

/// Each case: the formula in F1, then what Excel holds after Fill Right (G1),
/// Copy+Paste two right (H1), Fill Down (F2) and Copy+Paste forty down (F41).
const CASES: &[(&str, &str, &str, &str, &str)] = &[
    (
        "=LET(b,2,SUM(B:B)*b)",
        "=LET(B,2,SUM(B:B)*B)",
        "=LET(B,2,SUM(B:B)*B)",
        "=LET(B,2,SUM(B:B)*B)",
        "=LET(B,2,SUM(B:B)*B)",
    ),
    (
        "=LET(b,A1:A3,SUM(B:D))",
        "=LET(B,B1:B3,SUM(B:D))",
        "=LET(B,C1:C3,SUM(B:D))",
        "=LET(B,A2:A4,SUM(B:D))",
        "=LET(B,A41:A43,SUM(B:D))",
    ),
    (
        "=LET(b,2,SUM(A:B))",
        "=LET(B,2,SUM(B:C))",
        "=LET(B,2,SUM(C:D))",
        "=LET(B,2,SUM(A:B))",
        "=LET(B,2,SUM(A:B))",
    ),
    (
        "=LET(x,2,SUM(B:B)*x)",
        "=LET(X,2,SUM(C:C)*X)",
        "=LET(X,2,SUM(D:D)*X)",
        "=LET(X,2,SUM(B:B)*X)",
        "=LET(X,2,SUM(B:B)*X)",
    ),
    (
        "=LET(b,2,SUM(B:B))+SUM(B:B)",
        "=LET(B,2,SUM(B:B))+SUM(C:C)",
        "=LET(B,2,SUM(B:B))+SUM(D:D)",
        "=LET(B,2,SUM(B:B))+SUM(B:B)",
        "=LET(B,2,SUM(B:B))+SUM(B:B)",
    ),
    (
        "=LET(b,SUM(B:B),b)",
        "=LET(B,SUM(C:C),B)",
        "=LET(B,SUM(D:D),B)",
        "=LET(B,SUM(B:B),B)",
        "=LET(B,SUM(B:B),B)",
    ),
    (
        "=LAMBDA(b,SUM(B:B))(A1:A2)",
        // An inline LAMBDA call renders as Excel spells it (lane formc: it
        // rendered the engine's `__INVOKE__(lambda,args)` marker before).
        "=LAMBDA(B,SUM(B:B))(B1:B2)",
        "=LAMBDA(B,SUM(B:B))(C1:C2)",
        "=LAMBDA(B,SUM(B:B))(A2:A3)",
        "=LAMBDA(B,SUM(B:B))(A41:A42)",
    ),
];

#[test]
fn fill_and_copy_paste_keep_a_let_name_spelled_as_a_column_range() {
    let mut wrong = Vec::new();
    for (typed, right, pasted_right, down, pasted_down) in CASES {
        let wb = workbook();
        wb.set(0, 5, typed); // F1
        fill(&wb, (0, 5, 0, 5), (0, 6, 0, 6)); // Fill Right onto G1
        copy_paste(&wb, (0, 5), (0, 7)); // Copy F1, paste H1
        fill(&wb, (0, 5, 0, 5), (1, 5, 1, 5)); // Fill Down onto F2
        copy_paste(&wb, (0, 5), (40, 5)); // Copy F1, paste F41
        for (what, (row, col), want) in [
            ("Fill Right", (0u32, 6u32), right),
            ("Copy+Paste right", (0, 7), pasted_right),
            ("Fill Down", (1, 5), down),
            ("Copy+Paste down", (40, 5), pasted_down),
        ] {
            let got = formula(&wb, row, col);
            if got != *want {
                wrong.push(format!("{what} of {typed}: got {got}, Excel holds {want}"));
            }
        }
    }
    assert!(wrong.is_empty(), "a LET name was shifted as a column:\n{}", wrong.join("\n"));
}

/// The values Excel shows for the filled cells [LIVE, parsefix/probe1.ps1]:
/// the bound `b:b` stays #VALUE!, and the second-half-bound `A:B` reads the
/// columns it moved to (copied two right, `C:D` = 1500).
///
/// NOT PINNED, and why: Excel's Fill Right of `=LET(b,2,SUM(A:B))` shows the
/// text `=LET(b,2,SUM(B:C))` and 1650 -- its token stays a COLUMN range,
/// although that same text TYPED reads `b:C` (#VALUE!). Calcula carries a
/// formula across a fill as text, so G2 re-reads as typed and is #VALUE!.
#[test]
fn the_filled_cells_compute_what_excel_shows() {
    let wb = workbook();
    wb.set(0, 5, "=LET(b,2,SUM(B:B)*b)");
    fill(&wb, (0, 5, 0, 5), (0, 6, 0, 6));
    assert_eq!(value(&wb, 0, 6), CellValue::Error(CellError::Value), "G1 = #VALUE! in Excel");
    wb.set(1, 5, "=LET(b,2,SUM(A:B))");
    assert_eq!(value(&wb, 1, 5), CellValue::Number(165.0), "F2 = SUM(A:B) = 165 in Excel");
    copy_paste(&wb, (1, 5), (1, 7));
    assert_eq!(value(&wb, 1, 7), CellValue::Number(1500.0), "H2 = SUM(C:D) = 1500 in Excel");
}

/// A LET / LAMBDA name SPELLED LIKE A CELL is a name to Fill and Copy+Paste,
/// and so is every plain cell spelling in a formula that declares one.
/// [LIVE, Excel 16, 2026-11-05, rev-parse probeA, Sheet2: B2 =LET(x1,5,x1*2)
/// and C2 =LET(A1,5,A1+RC4) (stored `$D2`) copied up to row 1 and filled down
/// to row 4 -- the names unchanged, `$D1` and `$D4`; XFC3 =LET(XFD1,5,XFD1*2)
/// filled right onto XFD3 and Q7 =LET(Q5,2,Q5*3) onto R7, both unchanged, 10
/// and 6.] Calcula renamed `x1` to `x2` on every fill, wrote `=LET(R5,2,R5*3)`
/// into R7 -- a formula its own typed entry refuses -- and `#REF!` names at
/// the sheet's edge.
#[test]
fn fill_and_copy_paste_keep_a_name_spelled_like_a_cell() {
    let wb = workbook();
    wb.set(1, 1, "=LET(x1,5,x1*2)"); // B2
    wb.set(1, 2, "=LET(A1,5,A1+RC4)"); // C2, entered as $D2
    assert_eq!(formula(&wb, 1, 2), "=LET(A1,5,A1+$D2)", "R1C1's RC4 is entered as $D2");
    let kept = formula(&wb, 1, 1);

    copy_paste(&wb, (1, 1), (0, 1)); // B2 -> B1
    assert_eq!(formula(&wb, 0, 1), kept, "Copy+Paste up renamed the name");
    // C2's copy up is the shift `=LET(A1,5,A1+$D1)` (pinned by
    // `structure::cell_shaped_name_shift_tests`); the batch write then puts
    // the pasted text through the TYPED-entry check, which refuses its `$`
    // (reported separately), so it is not pasted here.
    assert_eq!(
        crate::commands::structure::shift_formula_internal(&formula(&wb, 1, 2), -1, 0),
        "=LET(A1,5,A1+$D1)"
    );

    fill(&wb, (1, 1, 1, 2), (2, 1, 3, 2)); // B2:C2 filled down to row 4
    assert_eq!(formula(&wb, 3, 1), kept, "Fill Down renamed the name");
    assert_eq!(formula(&wb, 3, 2), "=LET(A1,5,A1+$D4)");
    assert_eq!(value(&wb, 3, 1), CellValue::Number(10.0));

    let xfc = engine::EXCEL_MAX_COL_INDEX - 1;
    wb.set(2, xfc, "=LET(XFD1,5,XFD1*2)");
    fill(&wb, (2, xfc, 2, xfc), (2, xfc + 1, 2, xfc + 1)); // onto XFD3
    assert_eq!(formula(&wb, 2, xfc + 1), "=LET(XFD1,5,XFD1*2)", "Fill Right at the sheet's edge broke the name");
    assert_eq!(value(&wb, 2, xfc + 1), CellValue::Number(10.0));

    wb.set(6, 16, "=LET(Q5,2,Q5*3)"); // Q7
    fill(&wb, (6, 16, 6, 16), (6, 17, 6, 17)); // onto R7
    assert_eq!(formula(&wb, 6, 17), "=LET(Q5,2,Q5*3)", "Fill Right renamed Q5 to R5");
    assert_eq!(value(&wb, 6, 17), CellValue::Number(6.0));

    copy_paste(&wb, (1, 1), (40, 7)); // B2 -> H41
    assert_eq!(formula(&wb, 40, 7), kept, "a copy across the sheet renamed the name");
}

/// NEW-typed-ref-error (lane formd), through the REAL `update_cell` door: a
/// reference into a DELETED sheet cannot be TYPED ([LIVE] Excel 16 refuses
/// `=#REF!A1` with 0x800A03EC), while a cell that already HOLDS one (here
/// laid down by a paste, which reads a formula as a stored one) keeps it on
/// F2 + Enter, as Excel's does. Kept in this file for its paste harness.
#[test]
fn a_stored_deleted_sheet_reference_survives_f2_enter_but_cannot_be_typed() {
    let wb = workbook();
    // A paste lays the formula down as stored (`parse_pasted_input`).
    update_cells_batch_core(
        &wb.state,
        &wb.file,
        &wb.files,
        &wb.pivots,
        vec![crate::api_types::CellUpdateInput {
            row: 10,
            col: 5,
            value: "=#REF!A1".to_string(),
            style_index: None,
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
    .expect("the paste writes");
    assert_eq!(formula(&wb, 10, 5), "=#REF!A1", "precondition: the cell holds the formula");
    assert_eq!(value(&wb, 10, 5), CellValue::Error(CellError::Ref));
    // F2 + Enter commits the formula bar's text unchanged: the formula stays.
    wb.set(10, 5, "=#REF!A1");
    assert_eq!(formula(&wb, 10, 5), "=#REF!A1", "F2 + Enter turned the stored formula into text");
    assert_eq!(value(&wb, 10, 5), CellValue::Error(CellError::Ref));
    // Typed into another cell it is refused, and the typed text is kept.
    wb.set(11, 5, "=#REF!A1");
    assert_eq!(formula(&wb, 11, 5), "", "a typed reference into a deleted sheet was accepted");
    assert_eq!(value(&wb, 11, 5), CellValue::Text("=#REF!A1".to_string()));
}
