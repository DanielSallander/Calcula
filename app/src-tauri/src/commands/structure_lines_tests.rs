//! FILENAME: app/src-tauri/src/commands/structure_lines_tests.rs
//! PURPOSE: Insert/Delete Sheet Rows and Columns pinned against what live Excel
//!          did (Microsoft 365 build 20326, 2026-10-04, a fresh hidden instance
//!          driven over COM: the rust-followup lane's probe 1).
//! CONTEXT: A `#[path]` child of `structure_cells_tests`, so it drives the
//!          whole-line commands over the same `Fx` harness the band commands
//!          use. Two questions, each with ONE answer shared with Insert/Delete
//!          Cells (`BandEdit::whole_lines`):
//!          1. where a REFERENCE goes -- a range shrinks over a partial delete,
//!             only a range deleted whole is `#REF!`, and a range reaching the
//!             sheet's last line keeps reaching it;
//!          2. what an INSERTED line inherits -- its neighbour's cell formats,
//!             whole-line format, size, conditional formats and validation,
//!             but not its hidden state.

use super::*;

// ===========================================================================
// PURE: every whole-line reference shifter, against the probe table
// ===========================================================================

/// Run `formula` through BOTH whole-line shifters (the sheet-blind one the
/// print/scroll areas use, and the sheet-aware one every formula and defined
/// name uses) for `edit`.
fn through_both(formula: &str, edit: SE) -> [(&'static str, String); 2] {
    let (blind, aware) = match edit {
        SE::RowInsert { at, count } => (
            shift_formula_row_references(formula, at, count as i32),
            shift_formula_rows_sheet_aware(formula, "Sheet1", "Sheet1", at, count as i32),
        ),
        SE::RowDelete { at, count } => (
            shift_formula_row_references(formula, at, -(count as i32)),
            shift_formula_rows_sheet_aware(formula, "Sheet1", "Sheet1", at, -(count as i32)),
        ),
        SE::ColInsert { at, count } => (
            shift_formula_col_references(formula, at, count as i32),
            shift_formula_cols_sheet_aware(formula, "Sheet1", "Sheet1", at, count as i32),
        ),
        SE::ColDelete { at, count } => (
            shift_formula_col_references(formula, at, -(count as i32)),
            shift_formula_cols_sheet_aware(formula, "Sheet1", "Sheet1", at, -(count as i32)),
        ),
    };
    [("sheet-blind", blind), ("sheet-aware", aware)]
}

#[track_caller]
fn assert_line_rewrites(rows: &[(&str, SE, &str)]) {
    let mut wrong = Vec::new();
    for (before, edit, excel) in rows {
        for (path, got) in through_both(before, *edit) {
            if got != *excel {
                wrong.push(format!("{:<26} {:?} Excel {:<26} Calcula ({}) {}", before, edit, excel, path, got));
            }
            assert!(parser::parse(&got).is_ok(), "`{}` does not parse back", got);
        }
    }
    assert!(wrong.is_empty(), "disagrees with Excel:\n  {}", wrong.join("\n  "));
}

/// 0-based helpers, so the table reads in Excel's 1-based numbers.
fn del_rows(first: u32, last: u32) -> SE {
    SE::RowDelete { at: first - 1, count: last - first + 1 }
}
fn ins_rows(at: u32, count: u32) -> SE {
    SE::RowInsert { at: at - 1, count }
}
fn col(letters: &str) -> u32 {
    shift_col_to_index(letters)
}
fn del_cols(first: &str, last: &str) -> SE {
    SE::ColDelete { at: col(first), count: col(last) - col(first) + 1 }
}
fn ins_cols(at: &str, count: u32) -> SE {
    SE::ColInsert { at: col(at), count }
}

/// probe1.out.txt, "References through WHOLE-ROW / WHOLE-COLUMN edits": every
/// row, as measured. (Excel re-spells `B1:B1048576` as `B:B` and `A:XFD` as
/// `$1:$1048576`; Calcula keeps the user's spelling of the same, unchanged,
/// range.)
#[test]
fn whole_line_edits_rewrite_references_exactly_as_excel_did() {
    assert_line_rewrites(&[
        // A delete SHRINKS a range it cuts; only a range deleted whole is #REF!.
        ("=SUM(A5:A9)", del_rows(5, 5), "=SUM(A5:A8)"),
        ("=SUM(A5:A9)", del_rows(4, 6), "=SUM(A4:A6)"),
        ("=SUM(A5:A9)", del_rows(9, 12), "=SUM(A5:A8)"),
        ("=SUM(A5:A9)", del_rows(6, 7), "=SUM(A5:A7)"),
        ("=SUM(A5:A9)", del_rows(5, 9), "=SUM(#REF!)"),
        ("=SUM(A5:A9)", del_rows(3, 12), "=SUM(#REF!)"),
        ("=SUM($A$5:$A$9)", del_rows(5, 5), "=SUM($A$5:$A$8)"),
        ("=A5", del_rows(5, 5), "=#REF!"),
        ("=SUM(5:5)", del_rows(5, 5), "=SUM(#REF!)"),
        ("=SUM(3:7)", del_rows(3, 4), "=SUM(3:5)"),
        ("=SUM(3:7)", del_rows(7, 9), "=SUM(3:6)"),
        // An insert MOVES a range at or below it and GROWS one it falls inside.
        ("=SUM(3:7)", ins_rows(3, 1), "=SUM(4:8)"),
        ("=SUM(3:7)", ins_rows(4, 1), "=SUM(3:8)"),
        ("=SUM(3:7)", ins_rows(8, 1), "=SUM(3:7)"),
        ("=SUM(A5:A9)", ins_rows(5, 1), "=SUM(A6:A10)"),
        ("=SUM(A5:A9)", ins_rows(9, 1), "=SUM(A5:A10)"),
        ("=SUM(A5:A9)", ins_rows(10, 1), "=SUM(A5:A9)"),
        // THE SHEET EDGE: a range reaching the last row keeps reaching it...
        ("=SUM(B10:B1048576)", ins_rows(2, 2), "=SUM(B12:B1048576)"),
        ("=SUM(B10:B1048576)", del_rows(2, 3), "=SUM(B8:B1048576)"),
        ("=SUM(B1:B1048576)", ins_rows(5, 1), "=SUM(B1:B1048576)"),
        ("=SUM(B1:B1048576)", del_rows(5, 5), "=SUM(B1:B1048576)"),
        ("=ROWS(1:1048576)", ins_rows(5, 1), "=ROWS(1:1048576)"),
        ("=ROWS(1:1048576)", del_rows(5, 5), "=ROWS(1:1048576)"),
        ("=ROWS(10:1048576)", ins_rows(2, 2), "=ROWS(12:1048576)"),
        // ...one pushed past it is cut at it, or #REF! when its start goes too.
        ("=SUM(B1048560:B1048575)", ins_rows(1, 10), "=SUM(B1048570:B1048576)"),
        ("=SUM(B1048570:B1048575)", ins_rows(1, 10), "=SUM(#REF!)"),
        ("=SUM(B2:B1048575)", ins_rows(1, 5), "=SUM(B7:B1048576)"),
        ("=ROWS(1048570:1048575)", ins_rows(1, 10), "=ROWS(#REF!)"),
        ("=B1048575", ins_rows(1, 2), "=#REF!"),
        // Columns: the same rule on the other axis.
        ("=SUM(C5:F5)", del_cols("C", "C"), "=SUM(C5:E5)"),
        ("=SUM(C5:F5)", del_cols("B", "D"), "=SUM(B5:C5)"),
        ("=SUM(C5:F5)", del_cols("C", "F"), "=SUM(#REF!)"),
        ("=SUM(C:F)", del_cols("A", "D"), "=SUM(A:B)"),
        ("=SUM(C1:XFD1)", ins_cols("B", 1), "=SUM(D1:XFD1)"),
        ("=SUM(C1:XFD1)", del_cols("A", "A"), "=SUM(B1:XFD1)"),
        ("=COLUMNS(A:XFD)", ins_cols("B", 1), "=COLUMNS(A:XFD)"),
        ("=SUM(XEZ1:XFC1)", ins_cols("A", 5), "=SUM(#REF!)"),
        ("=XFC1", ins_cols("A", 2), "=#REF!"),
    ]);
}

/// The same rule reaches a reference on ANOTHER sheet and a defined name
/// (both go through the sheet-aware shifter; a workbook-scoped name passes
/// `""` as its own sheet so only its qualified references can match).
#[test]
fn cross_sheet_references_and_names_shrink_the_same_way() {
    assert_eq!(
        shift_formula_rows_sheet_aware("=SUM(Sheet1!A5:A9)", "Sheet2", "Sheet1", 4, -1),
        "=SUM(Sheet1!A5:A8)"
    );
    assert_eq!(
        shift_formula_rows_sheet_aware("=Sheet1!$A$5:$A$9", "", "Sheet1", 4, -1),
        "=Sheet1!$A$5:$A$8"
    );
    assert_eq!(
        shift_formula_cols_sheet_aware("='My Data'!C5:F5", "Sheet2", "My Data", 2, -1),
        "='My Data'!C5:E5"
    );
    // Control: another sheet's range is not touched.
    assert_eq!(
        shift_formula_rows_sheet_aware("=SUM(Sheet3!A5:A9)", "Sheet2", "Sheet1", 4, -1),
        "=SUM(Sheet3!A5:A9)"
    );
}

/// The band rule's whole-line form and the formula shifters must be the SAME
/// rule: a rule range (conditional format, validation) cut by a delete
/// shrinks exactly like a reference to it.
#[test]
fn rule_ranges_through_whole_lines_follow_the_reference_rule() {
    let delete5 = BandEdit::whole_lines(del_rows(5, 5));
    assert_eq!(delete5.rule_range_pieces(a1("A5:D9")[0]), a1("A5:D8"));
    let last = engine::EXCEL_MAX_ROW_INDEX;
    // A rule over a whole column keeps covering it through an insert and a
    // delete (it used to be pushed past the last row by an insert, and to
    // stop one row short of it after a delete).
    assert_eq!(
        BandEdit::whole_lines(ins_rows(5, 1)).rule_range_pieces(r(0, 0, last, 0)),
        vec![r(0, 0, last, 0)]
    );
    assert_eq!(delete5.rule_range_pieces(r(0, 0, last, 0)), vec![r(0, 0, last, 0)]);
    // Deleted whole: nothing left.
    assert!(BandEdit::whole_lines(del_rows(5, 9)).rule_range_pieces(a1("A5:D9")[0]).is_empty());
    // An insertion right under a range: the inserted lines JOIN it (one range,
    // A4:D7, as Excel reports it), and one at the first row inherits nothing.
    assert_eq!(BandEdit::whole_lines(ins_rows(5, 3)).rule_range_pieces(a1("A4:D4")[0]), a1("A4:D7"));
    assert_eq!(BandEdit::whole_lines(ins_cols("D", 1)).rule_range_pieces(a1("C2")[0]), a1("C2:D2"));
    assert_eq!(BandEdit::whole_lines(ins_rows(1, 1)).rule_range_pieces(a1("A1:D1")[0]), a1("A2:D2"));
}

// ===========================================================================
// THE COMMANDS over a real AppState
// ===========================================================================

fn delete_rows(fx: &Fx, first: u32, count: u32) {
    delete_rows_impl(&fx.state, &fx.file, &fx.pivots, &fx.files, &fx.pane, &fx.filters, &fx.slicer, &fx.timeline, first, count, None)
        .expect("delete rows");
}

fn insert_rows(fx: &Fx, at: u32, count: u32, sheet: Option<usize>) {
    insert_rows_impl(&fx.state, &fx.file, &fx.pivots, &fx.files, &fx.pane, &fx.filters, &fx.slicer, &fx.timeline, at, count, sheet)
        .expect("insert rows");
}

fn insert_columns(fx: &Fx, at: u32, count: u32, sheet: Option<usize>) {
    insert_columns_impl(&fx.state, &fx.file, &fx.pivots, &fx.files, &fx.pane, &fx.filters, &fx.slicer, &fx.timeline, at, count, sheet)
        .expect("insert columns");
}

/// THE REPRODUCTION from the rust-structure lane's report ("Not fixed" 1):
/// `=SUM(A5:A9)`, delete row 5. Calcula wrote `=SUM(#REF!)`; Excel writes
/// `=SUM(A5:A8)` and keeps summing what is left -- on this sheet and on the
/// sheet that reads it.
#[test]
fn delete_rows_shrinks_a_partly_deleted_range_and_recalculates_it() {
    let fx = Fx::new(2);
    for (i, a) in ["A5", "A6", "A7", "A8", "A9"].iter().enumerate() {
        fx.put(0, a, &format!("{}", i + 1));
    }
    fx.put(0, "H1", "=SUM(A5:A9)");
    fx.put(1, "A1", "=SUM(Sheet1!A5:A9)");
    fx.settle();
    assert_eq!(fx.number(0, "H1"), 15.0);

    delete_rows(&fx, 4, 1);
    assert_eq!(fx.formula(0, "H1").as_deref(), Some("=SUM(A5:A8)"));
    assert_eq!(fx.number(0, "H1"), 14.0, "2+3+4+5: the deleted 1 is gone, the rest still counts");
    assert_eq!(fx.formula(1, "A1").as_deref(), Some("=SUM(SHEET1!A5:A8)"));
    assert_eq!(fx.number(1, "A1"), 14.0);

    fx.undo();
    assert_eq!(fx.formula(0, "H1").as_deref(), Some("=SUM(A5:A9)"));
    assert_eq!(fx.formula(1, "A1").as_deref(), Some("=SUM(SHEET1!A5:A9)"));
}

/// The other reproduction ("Not fixed" 2): `=SUM(B10:B1048576)`, insert two
/// rows at row 2. Calcula wrote `#REF!`; Excel keeps `B12:B1048576`.
#[test]
fn insert_rows_keeps_a_range_that_reaches_the_last_row_reaching_it() {
    let fx = Fx::new(1);
    fx.put(0, "B10", "7");
    fx.put(0, "H1", "=SUM(B10:B1048576)");
    fx.settle();
    insert_rows(&fx, 1, 2, None);
    assert_eq!(fx.formula(0, "H1").as_deref(), Some("=SUM(B12:B1048576)"));
    assert_eq!(fx.number(0, "H1"), 7.0);
}

/// Format Same As Above, the probe's own sheet: row 4 red/bold/0.000 (two
/// styled cells), 30 pt, a whole-row tier, a DV on A4 and a CF on A4:D4; row 5
/// another style at 40 pt. Three rows inserted at row 5.
#[test]
fn inserted_rows_take_the_format_tier_height_and_rules_of_the_row_above() {
    let fx = Fx::new(1);
    let seed = crate::document_effect::test_seed_effect();
    fx.put(0, "A4", "41");
    fx.put(0, "F4", "46");
    fx.put(0, "A5", "51");
    {
        let mut grid = fx.state.grid.write(&seed).unwrap();
        for (pos, style) in [((3u32, 0u32), 5usize), ((3, 5), 6), ((4, 0), 9)] {
            let mut cell = grid.get_cell(pos.0, pos.1).cloned().unwrap();
            cell.style_index = style;
            grid.set_cell(pos.0, pos.1, cell);
        }
        grid.row_styles.insert(3, 7);
    }
    {
        let mut grids = fx.state.grids.write(&seed).unwrap();
        grids[0].cells = fx.state.grid.read().unwrap().cells.clone();
        grids[0].row_styles.insert(3, 7);
    }
    fx.state.row_heights.write(&seed).unwrap().insert(3, 40.0);
    fx.state.row_heights.write(&seed).unwrap().insert(4, 53.0);
    fx.state.data_validations.write(&seed).unwrap().entry(0).or_default().push(
        crate::data_validation::ValidationRange {
            start_row: 3,
            start_col: 0,
            end_row: 3,
            end_col: 0,
            validation: crate::data_validation::DataValidation::default(),
        },
    );
    crate::conditional_formatting::add_conditional_format_impl(
        &fx.state,
        &fx.file,
        crate::conditional_formatting::AddCFParams {
            target: None,
            rule: crate::conditional_formatting::ConditionalFormatRule::CellValue(
                crate::conditional_formatting::CellValueRule {
                    operator: crate::conditional_formatting::CellValueOperator::GreaterThan,
                    value1: "0".to_string(),
                    value2: None,
                },
            ),
            format: crate::conditional_formatting::ConditionalFormat {
                background_color: Some("#FFC7CE".to_string()),
                ..Default::default()
            },
            ranges: vec![crate::conditional_formatting::ConditionalFormatRange { start_row: 3, start_col: 0, end_row: 3, end_col: 3 }],
            stop_if_true: false,
        },
    );
    fx.settle();
    fx.mark_clean();
    let depth = fx.undo_depth();

    insert_rows(&fx, 4, 3, None);
    assert_eq!(fx.undo_depth(), depth + 1, "ONE undo step");

    for row in 5..=7u32 {
        let a = fx.cell(0, &format!("A{}", row)).expect("an inserted cell carrying A4's format");
        assert_eq!((a.style_index, a.value.clone()), (5, CellValue::Empty), "A{} takes A4's format, not its value", row);
        assert_eq!(fx.cell(0, &format!("F{}", row)).map(|c| c.style_index), Some(6), "F{} takes F4's", row);
        assert!(fx.cell(0, &format!("C{}", row)).is_none(), "C4 has no format of its own: nothing to copy");
        assert_eq!(fx.state.grid.read().unwrap().row_styles.get(&(row - 1)).copied(), Some(7), "row {} takes row 4's whole-row format", row);
        assert_eq!(fx.state.grids.read().unwrap()[0].row_styles.get(&(row - 1)).copied(), Some(7), "both halves of the pair");
        assert_eq!(fx.state.row_heights.read().unwrap().get(&(row - 1)).copied(), Some(40.0), "row {} takes row 4's height", row);
    }
    assert_eq!(fx.number(0, "A8"), 51.0, "the old row 5 moved down");
    assert_eq!(fx.cell(0, "A8").map(|c| c.style_index), Some(9), "and kept its own format");
    assert_eq!(fx.state.row_heights.read().unwrap().get(&7).copied(), Some(53.0), "and its own height");
    let dv: Vec<CellRange> = fx.state.data_validations.read().unwrap().get(&0).unwrap().iter().map(|v| r(v.start_row, v.start_col, v.end_row, v.end_col)).collect();
    assert_eq!(dv, a1("A4:A7"), "probe: DV on A4 covers A5..A7");
    let cf: Vec<CellRange> = fx.state.conditional_formats.read().unwrap().get(&0).unwrap()[0].ranges.iter().map(|x| r(x.start_row, x.start_col, x.end_row, x.end_col)).collect();
    assert_eq!(cf, a1("A4:D7"), "probe: CF applies-to A4:D7");

    fx.undo();
    assert!(fx.cell(0, "A5").map(|c| c.style_index) == Some(9), "undo: row 5 is the old row 5 again");
    assert!(fx.cell(0, "F5").is_none(), "undo removes the inherited cells");
    assert_eq!(fx.state.grid.read().unwrap().row_styles.get(&4).copied(), None);
    assert_eq!(fx.state.row_heights.read().unwrap().get(&4).copied(), Some(53.0));
    let dv = fx.state.data_validations.read().unwrap().get(&0).unwrap()[0].clone();
    assert_eq!((dv.start_row, dv.end_row), (3, 3));
}

/// Measured: a HIDDEN row 4 still gives its height, but the inserted row is
/// visible; and an insertion at row 1 has no neighbour, so it takes nothing.
#[test]
fn hidden_is_not_inherited_and_row_one_inherits_nothing() {
    let fx = Fx::new(1);
    let seed = crate::document_effect::test_seed_effect();
    fx.put(0, "A1", "1");
    fx.put(0, "A4", "4");
    {
        let mut grid = fx.state.grid.write(&seed).unwrap();
        for row in [0u32, 3] {
            let mut cell = grid.get_cell(row, 0).cloned().unwrap();
            cell.style_index = 5;
            grid.set_cell(row, 0, cell);
        }
    }
    fx.state.row_heights.write(&seed).unwrap().insert(3, 40.0);
    fx.state.row_heights.write(&seed).unwrap().insert(0, 44.0);
    fx.state.user_hidden_rows.write(&seed).unwrap().insert(3);

    insert_rows(&fx, 4, 1, None);
    assert_eq!(fx.state.row_heights.read().unwrap().get(&4).copied(), Some(40.0), "the hidden row's height is inherited");
    let hidden = fx.state.user_hidden_rows.read().unwrap().clone();
    assert!(hidden.contains(&3) && !hidden.contains(&4), "row 4 stays hidden, the new row 5 is visible: {:?}", hidden);

    insert_rows(&fx, 0, 1, None);
    assert!(fx.cell(0, "A1").is_none(), "a new row 1 takes nothing (Excel did not use the row below)");
    assert_eq!(fx.state.row_heights.read().unwrap().get(&0).copied(), None);
    assert_eq!(fx.cell(0, "A2").map(|c| c.style_index), Some(5), "the old row 1 moved down with its format");
}

/// Format Same As Left: an inserted column takes the column to its left's
/// cell formats and width (probe: C red/0.000/width 20 -> new D the same, the
/// old D keeps its own), on the active sheet and on a sheet that is not.
#[test]
fn inserted_columns_take_the_format_and_width_of_the_column_to_the_left() {
    let fx = Fx::new(2);
    let seed = crate::document_effect::test_seed_effect();
    for sheet in 0..2 {
        fx.put(sheet, "C1", "3");
        fx.put(sheet, "D1", "4");
    }
    {
        let mut grid = fx.state.grid.write(&seed).unwrap();
        let mut cell = grid.get_cell(0, 2).cloned().unwrap();
        cell.style_index = 5;
        grid.set_cell(0, 2, cell);
    }
    {
        let mut grids = fx.state.grids.write(&seed).unwrap();
        let mut cell = grids[1].get_cell(0, 2).cloned().unwrap();
        cell.style_index = 5;
        grids[1].set_cell(0, 2, cell);
        grids[1].column_styles.insert(2, 8);
    }
    fx.state.column_widths.write(&seed).unwrap().insert(2, 150.0);
    fx.state.all_column_widths.write(&seed).unwrap()[1].insert(2, 160.0);

    insert_columns(&fx, 3, 1, None);
    assert_eq!(fx.cell(0, "D1").map(|c| (c.style_index, c.value)), Some((5, CellValue::Empty)));
    assert_eq!(fx.state.column_widths.read().unwrap().get(&3).copied(), Some(150.0));
    assert_eq!(fx.number(0, "E1"), 4.0, "the old D moved right");

    // The off-sheet path (Wave 3 sheet-addressed insert) inherits the same way.
    insert_columns(&fx, 3, 1, Some(1));
    let grids = fx.state.grids.read().unwrap();
    assert_eq!(grids[1].get_cell(0, 3).map(|c| c.style_index), Some(5), "off-sheet: D1 takes C1's format");
    assert_eq!(grids[1].column_styles.get(&3).copied(), Some(8), "off-sheet: and C's whole-column format");
    drop(grids);
    assert_eq!(fx.state.all_column_widths.read().unwrap()[1].get(&3).copied(), Some(160.0), "off-sheet: and its width");
}

/// Review finding 7 asked whether a DELETE wrongly GROWS a range that lies
/// only on the sheet's last line(s). Measured on live Excel (fix-rust probe 1,
/// a fresh hidden instance, 2026-10-04): it does exactly that -- the range
/// keeps reaching the last line while its start moves up with its cells, so a
/// one-row range on the last row becomes two rows after one row is deleted.
/// Calcula agrees; these rows pin it.
#[test]
fn a_delete_grows_a_range_on_the_last_line_exactly_as_excel_did() {
    assert_line_rewrites(&[
        ("=SUM(A1048576:D1048576)", del_rows(5, 5), "=SUM(A1048575:D1048576)"),
        ("=SUM(A1048576:D1048576)", del_rows(5, 7), "=SUM(A1048573:D1048576)"),
        ("=SUM(1048576:1048576)", del_rows(5, 5), "=SUM(1048575:1048576)"),
        ("=SUM(1048575:1048576)", del_rows(5, 5), "=SUM(1048574:1048576)"),
        ("=SUM(A1048575:D1048576)", del_rows(5, 5), "=SUM(A1048574:D1048576)"),
        ("=SUM(A1048575:D1048576)", del_rows(5, 7), "=SUM(A1048572:D1048576)"),
        ("=SUM(A1048574:A1048576)", del_rows(5, 6), "=SUM(A1048572:A1048576)"),
        ("=SUM(A1048574:A1048576)", del_rows(5, 8), "=SUM(A1048570:A1048576)"),
        ("=A1048576", del_rows(5, 5), "=A1048575"),
        ("=SUM(XFD1:XFD4)", del_cols("B", "B"), "=SUM(XFC1:XFD4)"),
        ("=SUM(XFC1:XFD4)", del_cols("B", "B"), "=SUM(XFB1:XFD4)"),
        ("=SUM(XFD:XFD)", del_cols("B", "B"), "=SUM(XFC:XFD)"),
    ]);
    // The rule ranges grow the same way (probe: a CF on A1048576:D1048576
    // reads back as A1048575:D1048576 after row 5 is deleted; the validation
    // covers both rows; XFD1:XFD4 becomes XFC1:XFD4).
    let last = engine::EXCEL_MAX_ROW_INDEX;
    let last_col = engine::EXCEL_MAX_COL_INDEX;
    assert_eq!(
        BandEdit::whole_lines(del_rows(5, 5)).rule_range_pieces(r(last, 0, last, 3)),
        vec![r(last - 1, 0, last, 3)]
    );
    assert_eq!(
        BandEdit::whole_lines(del_cols("B", "B")).rule_range_pieces(r(0, last_col, 3, last_col)),
        vec![r(0, last_col - 1, 3, last_col)]
    );
}

// ===========================================================================
// 3-D REFERENCES through the real insert/delete bodies
// ===========================================================================

/// Four sheets. Sheet2..Sheet4 hold A5 = 1/2/4, a B-column value 10/20/40 and
/// a row-7 value 100/200/400. Sheet1 (active) reads them through 3-D spans, a
/// plain `Sheet4!A5` and a workbook-scoped name over a span; Sheet3 -- a
/// MIDDLE sheet of the span -- reads the same column span itself.
fn three_d_book() -> Fx {
    let fx = Fx::new(4);
    for (sheet, scale) in [(1usize, 1.0), (2, 2.0), (3, 4.0)] {
        fx.put(sheet, "A5", &format!("{}", scale));
        fx.put(sheet, &format!("B{}", sheet), &format!("{}", 10.0 * scale));
        fx.put(sheet, "E7", &format!("{}", 100.0 * scale));
    }
    let seed = crate::document_effect::test_seed_effect();
    fx.state.named_ranges.write(&seed).unwrap().insert(
        "SPAN".to_string(),
        crate::named_ranges::NamedRange {
            name: "SPAN".to_string(),
            sheet_index: None,
            refers_to: "=Sheet2:Sheet4!$A$5".to_string(),
            comment: None,
            folder: None,
        },
    );
    fx.put(0, "H1", "=SUM(Sheet2:Sheet4!A5)");
    fx.put(0, "H2", "=SUM(Sheet2:Sheet4!B:B)");
    fx.put(0, "H3", "=Sheet4!A5");
    fx.put(0, "H4", "=SUM(Sheet2:Sheet4!7:7)");
    fx.put(0, "H5", "=SUM(SPAN)");
    fx.put(2, "J1", "=SUM(Sheet2:Sheet4!B:B)");
    fx.settle();
    assert_eq!(
        [fx.number(0, "H1"), fx.number(0, "H2"), fx.number(0, "H3"), fx.number(0, "H4"), fx.number(0, "H5")],
        [7.0, 70.0, 4.0, 700.0, 7.0],
        "precondition: the spans read all three sheets"
    );
    assert_eq!(fx.number(2, "J1"), 70.0);
    fx
}

fn span_name(fx: &Fx) -> String {
    fx.state.named_ranges.read().unwrap().get("SPAN").expect("SPAN").refers_to.clone()
}

/// One line of a 3-D check: `got` against Excel's answer, listed when they differ.
fn differs(wrong: &mut Vec<String>, what: String, got: String, excel: &str) {
    if got != excel {
        wrong.push(format!("{what}: Excel {excel}, Calcula {got}"));
    }
}

/// UPPERCASED: a 3-D span is stored uppercased, a single qualifier as typed,
/// and these checks are about where a reference points.
fn formula_text(fx: &Fx, sheet: usize, a1_ref: &str) -> String {
    fx.formula(sheet, a1_ref).unwrap_or_default().to_ascii_uppercase()
}

fn value_text(fx: &Fx, sheet: usize, a1_ref: &str) -> String {
    format!("{:?}", fx.value(sheet, a1_ref))
}

fn number_text(n: f64) -> String {
    format!("{:?}", CellValue::Number(n))
}

/// NEW-structural-shift-rewrites-3d-span, through the commands. Excel [LIVE,
/// Excel 16, 2026-10-30, shifters/probe3d.ps1] leaves a 3-D reference as
/// written under every insert and delete -- on the span's last sheet, a middle
/// sheet, and the formula's own sheet -- and the span then reads whatever the
/// edit left at that address; `=Sheet4!A5` beside it follows its row.
#[test]
fn inserting_or_deleting_lines_on_any_sheet_leaves_a_3d_reference_as_written() {
    // Every disagreement with Excel is listed, not just the first: formulas
    // and names in `wrong`, the values they read in `values`.
    let mut wrong: Vec<String> = Vec::new();
    let mut values: Vec<String> = Vec::new();

    // A row inserted on the span's LAST sheet (off-sheet): the cell pass read
    // `:SHEET4!A5` as Sheet4's A5 and wrote `SHEET2:SHEET4!A6` everywhere.
    let case = "insert row 1 on Sheet4";
    let fx = three_d_book();
    insert_rows(&fx, 0, 1, Some(3));
    differs(&mut wrong, format!("{case}: Sheet1!H1"), formula_text(&fx, 0, "H1"), "=SUM(SHEET2:SHEET4!A5)");
    // Control: the plain reference beside it follows its row.
    differs(&mut wrong, format!("{case}: Sheet1!H3"), formula_text(&fx, 0, "H3"), "=SHEET4!A6");
    differs(&mut wrong, format!("{case}: Sheet1!H4"), formula_text(&fx, 0, "H4"), "=SUM(SHEET2:SHEET4!7:7)");
    differs(&mut wrong, format!("{case}: the name SPAN"), span_name(&fx), "=Sheet2:Sheet4!$A$5");
    // Sheet4's A5 is now the inserted row (1+2+0) and its row 7 is row 8 (100+200+0).
    differs(&mut values, format!("{case}: Sheet1!H1"), value_text(&fx, 0, "H1"), &number_text(3.0));
    differs(&mut values, format!("{case}: Sheet1!H3"), value_text(&fx, 0, "H3"), &number_text(4.0));
    differs(&mut values, format!("{case}: Sheet1!H4"), value_text(&fx, 0, "H4"), &number_text(300.0));
    differs(&mut values, format!("{case}: Sheet1!H5 =SUM(SPAN)"), value_text(&fx, 0, "H5"), &number_text(3.0));

    // A column inserted on the formula's OWN sheet (the active one): the line
    // pass read `!B:B` as Sheet1's column B and wrote `...!C:C`.
    let case = "insert column A on Sheet1";
    let fx = three_d_book();
    insert_columns(&fx, 0, 1, None);
    differs(&mut wrong, format!("{case}: Sheet1!I1"), formula_text(&fx, 0, "I1"), "=SUM(SHEET2:SHEET4!A5)");
    differs(&mut wrong, format!("{case}: Sheet1!I2"), formula_text(&fx, 0, "I2"), "=SUM(SHEET2:SHEET4!B:B)");
    differs(&mut wrong, format!("{case}: Sheet1!I4"), formula_text(&fx, 0, "I4"), "=SUM(SHEET2:SHEET4!7:7)");
    // Nothing moved on the span's sheets.
    differs(&mut values, format!("{case}: Sheet1!I2"), value_text(&fx, 0, "I2"), &number_text(70.0));

    // A column inserted on a MIDDLE sheet that holds a span formula of its own
    // (off-sheet): its own `!B:B` was read as Sheet3's column B.
    let case = "insert column A on Sheet3";
    let fx = three_d_book();
    insert_columns(&fx, 0, 1, Some(2));
    differs(&mut wrong, format!("{case}: Sheet3!K1"), formula_text(&fx, 2, "K1"), "=SUM(SHEET2:SHEET4!B:B)");
    differs(&mut wrong, format!("{case}: Sheet1!H2"), formula_text(&fx, 0, "H2"), "=SUM(SHEET2:SHEET4!B:B)");
    // Sheet3's B2 (20) moved to C2 and its A5 (2) into column B: the span
    // reads 10+2+40 from Sheet3 and from Sheet1. (Following the insert -- the
    // defect -- read C:C instead: 0+20+0.)
    differs(&mut values, format!("{case}: Sheet3!K1"), value_text(&fx, 2, "K1"), &number_text(52.0));
    differs(&mut values, format!("{case}: Sheet1!H2"), value_text(&fx, 0, "H2"), &number_text(52.0));

    // The very row the span reads deleted on its last sheet: no #REF! (Excel),
    // and the defined name used to become the unparseable `=Sheet2:#REF!`.
    let case = "delete row 5 on Sheet4";
    let fx = three_d_book();
    delete_rows_impl(&fx.state, &fx.file, &fx.pivots, &fx.files, &fx.pane, &fx.filters, &fx.slicer, &fx.timeline, 4, 1, Some(3))
        .expect("delete rows");
    differs(&mut wrong, format!("{case}: Sheet1!H1"), formula_text(&fx, 0, "H1"), "=SUM(SHEET2:SHEET4!A5)");
    // Control: the plain reference lost its row.
    differs(&mut wrong, format!("{case}: Sheet1!H3"), formula_text(&fx, 0, "H3"), "=#REF!");
    differs(&mut wrong, format!("{case}: the name SPAN"), span_name(&fx), "=Sheet2:Sheet4!$A$5");
    // Sheet4's old A6 (empty) is now A5 (1+2+0); its row 7 moved up to row 6.
    differs(&mut values, format!("{case}: Sheet1!H1"), value_text(&fx, 0, "H1"), &number_text(3.0));
    differs(&mut values, format!("{case}: Sheet1!H4"), value_text(&fx, 0, "H4"), &number_text(300.0));
    differs(&mut values, format!("{case}: Sheet1!H5 =SUM(SPAN)"), value_text(&fx, 0, "H5"), &number_text(3.0));

    assert!(
        wrong.is_empty(),
        "a structural edit rewrote a 3-D reference; Excel leaves it as written:\n  {}",
        wrong.join("\n  ")
    );
    assert!(values.is_empty(), "a 3-D reference reads the wrong cells after the edit:\n  {}", values.join("\n  "));
}

// ===========================================================================
// A BARE NON-ASCII SHEET QUALIFIER (rev13C MAJOR)
// ===========================================================================

/// Sheet1, Översikt, E, Straße -- with a workbook-scoped name over each of the
/// two non-ASCII sheets, stored BARE the way Excel saves them in an .xlsx
/// (`<definedName name="Rate">Översikt!$B$1</definedName>`, [LIVE]).
fn non_ascii_book() -> Fx {
    let fx = Fx::new(4);
    let seed = crate::document_effect::test_seed_effect();
    {
        let mut names = fx.state.sheet_names.write(&seed).unwrap();
        names[1] = "Översikt".to_string();
        names[2] = "E".to_string();
        names[3] = "Straße".to_string();
    }
    let mut store = fx.state.named_ranges.write(&seed).unwrap();
    for (name, refers_to) in [("RATE", "=Översikt!$B$1"), ("STR", "=Straße!A1")] {
        store.insert(
            name.to_string(),
            crate::named_ranges::NamedRange {
                name: name.to_string(),
                sheet_index: None,
                refers_to: refers_to.to_string(),
                comment: None,
                folder: None,
            },
        );
    }
    drop(store);
    fx
}

fn refers_to(fx: &Fx, name: &str) -> String {
    fx.state.named_ranges.read().unwrap().get(name).expect("name").refers_to.clone()
}

/// rev13C MAJOR, through the commands. Excel [LIVE, Excel 16, rev13C's
/// namedn.ps1] saves the name bare and moves it on `Rows(1).Insert` on
/// Översikt: `=Översikt!$B$2`. The shifters read the qualifier ASCII-only, so
/// the `Ö` was taken for the lead delimiter and the qualifier for `versikt`
/// (`Straße` read as `e`): the name stayed on `$B$1` -- and `=Straße!A1` would
/// have moved with a row inserted on a sheet named E.
#[test]
fn a_bare_non_ascii_qualifier_in_a_defined_name_follows_its_sheet() {
    let fx = non_ascii_book();
    insert_rows(&fx, 0, 1, Some(1));
    assert_eq!(refers_to(&fx, "RATE"), "=Översikt!$B$2", "the name follows a row inserted on Översikt");
    assert_eq!(refers_to(&fx, "STR"), "=Straße!A1", "control: a name on another sheet stays");

    let fx = non_ascii_book();
    insert_rows(&fx, 0, 1, Some(2));
    assert_eq!(refers_to(&fx, "STR"), "=Straße!A1", "a row inserted on sheet E must not move =Straße!A1");

    let fx = non_ascii_book();
    insert_columns(&fx, 0, 1, Some(3));
    assert_eq!(refers_to(&fx, "STR"), "=Straße!B1", "the name follows a column inserted on Straße");
    assert_eq!(refers_to(&fx, "RATE"), "=Översikt!$B$1", "control: a name on another sheet stays");
}

/// The same letter class at the text level: a non-ASCII letter is part of an
/// IDENTIFIER on both edges of a match (the lexer's `is_letter`), so `ÖA1` and
/// `A1ä` are names, not cell references, and a trim-reference dot beside a
/// non-ASCII qualifier keeps the qualifier whole.
#[test]
fn a_non_ascii_letter_before_a_cell_shape_makes_it_a_name() {
    // Lead edge, sheet-aware shifter: a name spelled `ÖA1` is not the cell A1.
    assert_eq!(shift_formula_rows_sheet_aware("=ÖA1+A1", "Sheet1", "Sheet1", 0, 1), "=ÖA1+A2");
}

#[test]
fn a_non_ascii_letter_before_a_cell_shape_makes_it_a_name_for_a_fill_too() {
    // Lead edge, the sheet-blind fill shifter (`CELL_REF_OR_RANGE_RE`).
    assert_eq!(shift_formula_internal("=ÅB12+B12", 1, 0), "=ÅB12+B13");
}

#[test]
fn a_non_ascii_letter_after_a_cell_shape_makes_it_a_name() {
    // Trailing edge: `A1ä` is one name to the lexer.
    assert_eq!(shift_formula_rows_sheet_aware("=A1ä+A1", "Sheet1", "Sheet1", 0, 1), "=A1ä+A2");
}

#[test]
fn a_trim_dot_beside_a_non_ascii_qualifier_keeps_it_whole() {
    // A trim dot used to send every UTF-8 byte of the segment through
    // `as char`, mangling `Ö` into two Latin-1 characters.
    assert_eq!(
        shift_formula_rows_sheet_aware("=SUM(Översikt!A1:.A8)", "Sheet1", "Översikt", 0, 1),
        "=SUM(Översikt!A2:.A9)"
    );
}

#[test]
fn whole_lines_and_3d_spans_read_a_bare_non_ascii_qualifier_whole() {
    assert_eq!(shift_formula_cols_sheet_aware("=SUM(Översikt!B:B)", "Sheet1", "Översikt", 0, 1), "=SUM(Översikt!C:C)");
    assert_eq!(shift_formula_rows_sheet_aware("=SUM(Översikt!3:4)", "Sheet1", "Översikt", 0, 1), "=SUM(Översikt!4:5)");
    // The 3-D span guard sees `:Straße!` whole, so a row inserted on sheet E
    // (the span's first sheet) leaves it as written -- read as `e`, the tail
    // used to be taken for a reference to sheet E and moved.
    assert_eq!(shift_formula_rows_sheet_aware("=SUM(E:Straße!A5)", "Sheet1", "E", 0, 1), "=SUM(E:Straße!A5)");
}
