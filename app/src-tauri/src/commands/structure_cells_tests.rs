//! FILENAME: app/src-tauri/src/commands/structure_cells_tests.rs
//! PURPOSE: Excel's Insert Cells / Delete Cells, pinned against what live Excel
//!          did (Microsoft 365 build 20326, 2026-10-04, driven over COM).
//! CONTEXT: A `#[path]` child of `structure_cells`. The first half is PURE --
//!          the reference rewriter and the plans, table-driven straight from the
//!          probe output, so a row that disagrees names the formula. The second
//!          half drives `shift_cells_impl` over a real `AppState`: the cells,
//!          the stores that move with them, ONE undo step, the dirty flag, and
//!          every refusal leaving the document clean.

use super::*;
use crate::conditional_formatting::{
    AddCFParams, CellValueOperator, CellValueRule, ConditionalFormat, ConditionalFormatRange,
    ConditionalFormatRule,
};
use engine::CellValue;
use std::collections::HashSet;

// ===========================================================================
// PURE: the reference rewriter (rule 1 and 2)
// ===========================================================================

/// The probe's band: B2:C3 (rows 1..2, columns 1..2 zero-based).
fn band(shift: CellShift) -> BandEdit {
    BandEdit::new(1, 1, 2, 2, shift)
}

#[track_caller]
fn assert_rewrites(shift: CellShift, rows: &[(&str, &str)]) {
    let b = band(shift);
    let mut wrong = Vec::new();
    for (before, excel) in rows {
        let got = shift_formula_in_band(before, "Sheet1", "Sheet1", &b);
        if got != *excel {
            wrong.push(format!("{:<24} Excel {:<24} Calcula {}", before, excel, got));
        }
        assert!(parser::parse(&got).is_ok(), "`{}` does not parse back", got);
    }
    assert!(wrong.is_empty(), "{:?} disagrees with Excel:\n  {}", shift, wrong.join("\n  "));
}

/// probe1.out.txt, "INSERT B2:C3 shift DOWN", every formula of column H.
#[test]
fn insert_down_rewrites_references_exactly_as_excel_did() {
    assert_rewrites(
        CellShift::Down,
        &[
            ("=B5", "=B7"),
            ("=A5", "=A5"),
            ("=D5", "=D5"),
            ("=B1", "=B1"),
            ("=B2", "=B4"),
            ("=C3", "=C5"),
            ("=SUM(B1:B10)", "=SUM(B1:B12)"),
            ("=SUM(B4:C10)", "=SUM(B6:C12)"),
            ("=SUM(A1:B10)", "=SUM(A1:B10)"),
            ("=SUM(B1:D10)", "=SUM(B1:D10)"),
            ("=SUM(A5:D5)", "=SUM(A5:D5)"),
            ("=SUM(B5:C5)", "=SUM(B7:C7)"),
            ("=SUM(B:B)", "=SUM(B:B)"),
            ("=SUM(5:5)", "=SUM(5:5)"),
            ("=SUM(B2:B3)", "=SUM(B4:B5)"),
            ("=SUM(B3:B10)", "=SUM(B5:B12)"),
            ("=SUM(B1:B2)", "=SUM(B1:B4)"),
            ("=SUM(C1:C1)", "=SUM(C1:C1)"),
            ("=$B$5", "=$B$7"),
            ("=SUM(B2:C3)", "=SUM(B4:C5)"),
            ("=B1048575", "=#REF!"),
            ("=SUM(B10:B1048576)", "=SUM(B12:B1048576)"),
            ("=SUM(B2:C2)", "=SUM(B4:C4)"),
            ("=SUM(A2:D3)", "=SUM(A2:D3)"),
            ("=SUM(B2:B5)", "=SUM(B4:B7)"),
            ("=SUM(B1:C3)", "=SUM(B1:C5)"),
            ("=SUM(A:D)", "=SUM(A:D)"),
            ("=SUM(2:3)", "=SUM(2:3)"),
            ("=SUM(B4:B4)", "=SUM(B6:B6)"),
            ("=D2", "=D2"),
            ("=E2", "=E2"),
            ("=SUM(A2:Z2)", "=SUM(A2:Z2)"),
            ("=SUM(A2:Z4)", "=SUM(A2:Z4)"),
            ("=SUM(D2:E3)", "=SUM(D2:E3)"),
            ("=SUM(B2:E2)", "=SUM(B2:E2)"),
            ("=SUM(A3:E3)", "=SUM(A3:E3)"),
            ("=XFC2", "=XFC2"),
            ("=SUM(D2:XFD2)", "=SUM(D2:XFD2)"),
            ("=SUM(C2:D2)", "=SUM(C2:D2)"),
            ("=SUM(B1:B3)", "=SUM(B1:B5)"),
            ("=SUM(B3:C3)", "=SUM(B5:C5)"),
            ("=INDIRECT(\"B5\")", "=INDIRECT(\"B5\")"),
            ("=SUM(B2:C10)", "=SUM(B4:C12)"),
            ("=SUM(B4:C4)", "=SUM(B6:C6)"),
            // The two formulas that MOVED with their cells (B5 -> B7, C6 -> C8).
            ("=A5+B6+C7", "=A5+B8+C9"),
            ("=SUM(B4:B6)", "=SUM(B6:B8)"),
        ],
    );
}

/// probe1.out.txt, "INSERT B2:C3 shift RIGHT". (H2 and H3 sat in the band and
/// moved; their own references, `=A5` / `=D5`, are outside it and stayed.)
#[test]
fn insert_right_rewrites_references_exactly_as_excel_did() {
    assert_rewrites(
        CellShift::Right,
        &[
            ("=B5", "=B5"),
            ("=A5", "=A5"),
            ("=D5", "=D5"),
            ("=B1", "=B1"),
            ("=B2", "=D2"),
            ("=C3", "=E3"),
            ("=SUM(B1:B10)", "=SUM(B1:B10)"),
            ("=SUM(B4:C10)", "=SUM(B4:C10)"),
            ("=SUM(A1:B10)", "=SUM(A1:B10)"),
            ("=SUM(B1:D10)", "=SUM(B1:D10)"),
            ("=SUM(A5:D5)", "=SUM(A5:D5)"),
            ("=SUM(B5:C5)", "=SUM(B5:C5)"),
            ("=SUM(B:B)", "=SUM(B:B)"),
            ("=SUM(5:5)", "=SUM(5:5)"),
            ("=SUM(B2:B3)", "=SUM(D2:D3)"),
            ("=SUM(B3:B10)", "=SUM(B3:B10)"),
            ("=SUM(B1:B2)", "=SUM(B1:B2)"),
            ("=$B$5", "=$B$5"),
            ("=SUM(B2:C3)", "=SUM(D2:E3)"),
            ("=B1048575", "=B1048575"),
            ("=SUM(B2:C2)", "=SUM(D2:E2)"),
            ("=SUM(A2:D3)", "=SUM(A2:F3)"),
            ("=SUM(B2:B5)", "=SUM(B2:B5)"),
            ("=SUM(B1:C3)", "=SUM(B1:C3)"),
            ("=SUM(2:3)", "=SUM(2:3)"),
            ("=D2", "=F2"),
            ("=E2", "=G2"),
            ("=SUM(A2:Z2)", "=SUM(A2:AB2)"),
            ("=SUM(A2:Z4)", "=SUM(A2:Z4)"),
            ("=SUM(D2:E3)", "=SUM(F2:G3)"),
            ("=SUM(B2:E2)", "=SUM(D2:G2)"),
            ("=SUM(A3:E3)", "=SUM(A3:G3)"),
            ("=XFC2", "=#REF!"),
            ("=SUM(D2:XFD2)", "=SUM(F2:XFD2)"),
            ("=SUM(C2:D2)", "=SUM(E2:F2)"),
            ("=SUM(B1:B3)", "=SUM(B1:B3)"),
            ("=SUM(B3:C3)", "=SUM(D3:E3)"),
            ("=SUM(B2:C10)", "=SUM(B2:C10)"),
        ],
    );
}

/// probe1.out.txt, "DELETE B2:C3 shift UP" -- including Excel's TRIM
/// (`=SUM(B2:E2)` -> `D2:E2`, `=SUM(C2:D2)` -> `D2:D2`).
#[test]
fn delete_up_rewrites_references_exactly_as_excel_did() {
    assert_rewrites(
        CellShift::Up,
        &[
            ("=B5", "=B3"),
            ("=A5", "=A5"),
            ("=D5", "=D5"),
            ("=B1", "=B1"),
            ("=B2", "=#REF!"),
            ("=C3", "=#REF!"),
            ("=SUM(B1:B10)", "=SUM(B1:B8)"),
            ("=SUM(B4:C10)", "=SUM(B2:C8)"),
            ("=SUM(A1:B10)", "=SUM(A1:B10)"),
            ("=SUM(B1:D10)", "=SUM(B1:D10)"),
            ("=SUM(A5:D5)", "=SUM(A5:D5)"),
            ("=SUM(B5:C5)", "=SUM(B3:C3)"),
            ("=SUM(B:B)", "=SUM(B:B)"),
            ("=SUM(5:5)", "=SUM(5:5)"),
            ("=SUM(B2:B3)", "=SUM(#REF!)"),
            ("=SUM(B3:B10)", "=SUM(B2:B8)"),
            ("=SUM(B1:B2)", "=SUM(B1:B1)"),
            ("=SUM(C1:C1)", "=SUM(C1:C1)"),
            ("=$B$5", "=$B$3"),
            ("=SUM(B2:C3)", "=SUM(#REF!)"),
            ("=B1048575", "=B1048573"),
            ("=SUM(B10:B1048576)", "=SUM(B8:B1048576)"),
            ("=SUM(B2:C2)", "=SUM(#REF!)"),
            ("=SUM(A2:D3)", "=SUM(A2:D3)"),
            ("=SUM(B2:B5)", "=SUM(B2:B3)"),
            ("=SUM(B1:C3)", "=SUM(B1:C1)"),
            ("=SUM(A:D)", "=SUM(A:D)"),
            ("=SUM(2:3)", "=SUM(2:3)"),
            ("=SUM(B4:B4)", "=SUM(B2:B2)"),
            ("=D2", "=D2"),
            ("=E2", "=E2"),
            ("=SUM(A2:Z2)", "=SUM(A2:Z2)"),
            ("=SUM(A2:Z4)", "=SUM(A2:Z4)"),
            ("=SUM(D2:E3)", "=SUM(D2:E3)"),
            ("=SUM(B2:E2)", "=SUM(D2:E2)"),
            ("=SUM(A3:E3)", "=SUM(A3:E3)"),
            ("=XFC2", "=XFC2"),
            ("=SUM(D2:XFD2)", "=SUM(D2:XFD2)"),
            ("=SUM(C2:D2)", "=SUM(D2:D2)"),
            ("=SUM(B1:B3)", "=SUM(B1:B1)"),
            ("=SUM(B3:C3)", "=SUM(#REF!)"),
            ("=INDIRECT(\"B5\")", "=INDIRECT(\"B5\")"),
            ("=SUM(B2:C10)", "=SUM(B2:C8)"),
            ("=SUM(B4:C4)", "=SUM(B2:C2)"),
        ],
    );
}

/// probe1.out.txt, "DELETE B2:C3 shift LEFT".
#[test]
fn delete_left_rewrites_references_exactly_as_excel_did() {
    assert_rewrites(
        CellShift::Left,
        &[
            ("=B5", "=B5"),
            ("=B1", "=B1"),
            ("=B2", "=#REF!"),
            ("=C3", "=#REF!"),
            ("=SUM(B1:B10)", "=SUM(B1:B10)"),
            ("=SUM(B4:C10)", "=SUM(B4:C10)"),
            ("=SUM(A1:B10)", "=SUM(A1:B10)"),
            ("=SUM(B1:D10)", "=SUM(B1:D10)"),
            ("=SUM(B5:C5)", "=SUM(B5:C5)"),
            ("=SUM(B2:B3)", "=SUM(#REF!)"),
            ("=SUM(B3:B10)", "=SUM(B4:B10)"),
            ("=SUM(B1:B2)", "=SUM(B1:B1)"),
            ("=$B$5", "=$B$5"),
            ("=SUM(B2:C3)", "=SUM(#REF!)"),
            ("=B1048575", "=B1048575"),
            ("=SUM(B2:C2)", "=SUM(#REF!)"),
            ("=SUM(A2:D3)", "=SUM(A2:B3)"),
            ("=SUM(B2:B5)", "=SUM(B4:B5)"),
            ("=SUM(B1:C3)", "=SUM(B1:C1)"),
            ("=SUM(B4:B4)", "=SUM(B4:B4)"),
            ("=D2", "=B2"),
            ("=E2", "=C2"),
            ("=SUM(A2:Z2)", "=SUM(A2:X2)"),
            ("=SUM(A2:Z4)", "=SUM(A2:Z4)"),
            ("=SUM(D2:E3)", "=SUM(B2:C3)"),
            ("=SUM(B2:E2)", "=SUM(B2:C2)"),
            ("=SUM(A3:E3)", "=SUM(A3:C3)"),
            ("=XFC2", "=XFA2"),
            ("=SUM(D2:XFD2)", "=SUM(B2:XFD2)"),
            ("=SUM(C2:D2)", "=SUM(B2:B2)"),
            ("=SUM(B1:B3)", "=SUM(B1:B1)"),
            ("=SUM(B3:C3)", "=SUM(#REF!)"),
            ("=SUM(B2:C10)", "=SUM(B4:C10)"),
            ("=SUM(B4:C4)", "=SUM(B4:C4)"),
        ],
    );
}

/// Sheet2's formulas and the defined names of the probe: only references
/// QUALIFIED with the edited sheet move, by the same rule.
#[test]
fn other_sheets_and_names_follow_the_same_rule() {
    let down = band(CellShift::Down);
    let rows = [
        ("=Sheet1!B5", "=Sheet1!B7"),
        ("=SUM(Sheet1!B1:B10)", "=SUM(Sheet1!B1:B12)"),
        ("=SUM(Sheet1!A1:D10)", "=SUM(Sheet1!A1:D10)"),
        ("=Sheet1!D2", "=Sheet1!D2"),
        ("=SUM(Sheet1!B2:C3)", "=SUM(Sheet1!B4:C5)"),
        // Unqualified references on Sheet2 mean Sheet2: never touched.
        ("=B5+Sheet1!B5", "=B5+Sheet1!B7"),
    ];
    for (before, excel) in rows {
        assert_eq!(shift_formula_in_band(before, "Sheet2", "Sheet1", &down), excel, "{}", before);
    }
    // Names (probe: nm_one / nm_three; nm_two and nm_four straddle or miss).
    assert_eq!(shift_formula_in_band("=Sheet1!$B$5", "", "Sheet1", &down), "=Sheet1!$B$7");
    assert_eq!(shift_formula_in_band("=Sheet1!$A$1:$D$10", "", "Sheet1", &down), "=Sheet1!$A$1:$D$10");
    assert_eq!(shift_formula_in_band("=Sheet1!$B$4:$C$6", "", "Sheet1", &down), "=Sheet1!$B$6:$C$8");
    assert_eq!(
        shift_formula_in_band("=Sheet1!$D$2:$E$3", "", "Sheet1", &band(CellShift::Right)),
        "=Sheet1!$F$2:$G$3"
    );
    // A quoted name and a string literal: the qualifier survives, the text is text.
    assert_eq!(
        shift_formula_in_band("='My Data'!B5&\"B5\"", "Other", "My Data", &down),
        "='My Data'!B7&\"B5\""
    );
}

// ===========================================================================
// PURE: rule ranges, merges, tables, inheritance
// ===========================================================================

fn r(sr: u32, sc: u32, er: u32, ec: u32) -> CellRange {
    CellRange { start_row: sr, start_col: sc, end_row: er, end_col: ec }
}

/// The cells a set of rectangles covers (Excel re-partitions `AppliesTo`, so
/// pieces are compared as cell sets).
fn cells_of(ranges: &[CellRange]) -> HashSet<(u32, u32)> {
    let mut out = HashSet::new();
    for x in ranges {
        for row in x.start_row..=x.end_row {
            for col in x.start_col..=x.end_col {
                out.insert((row, col));
            }
        }
    }
    out
}

/// A1-style rectangles, parsed for readable expectations ("A8:A9").
fn a1(text: &str) -> Vec<CellRange> {
    text.split(',')
        .map(|part| {
            let mut ends = part.split(':');
            let first = ends.next().unwrap();
            let last = ends.next().unwrap_or(first);
            let (r0, c0) = calcula_format::cell_ref::from_a1(first).expect("a1");
            let (r1, c1) = calcula_format::cell_ref::from_a1(last).expect("a1");
            r(r0, c0, r1, c1)
        })
        .collect()
}

#[track_caller]
fn assert_cut(b: &BandEdit, before: &str, excel: &str) {
    let got: Vec<CellRange> = a1(before).into_iter().flat_map(|x| b.cut_range(x)).collect();
    assert_eq!(cells_of(&got), cells_of(&a1(excel)), "rule on {} should cover {} (got {:?})", before, excel, got);
}

/// probe1 + probe2 conditional-format AppliesTo after each shift.
#[test]
fn rule_ranges_are_cut_per_cell_as_excel_cuts_them() {
    let down = band(CellShift::Down);
    assert_cut(&down, "B5:C6", "B7:C8");
    assert_cut(&down, "A8:D9", "A8:A9,D8:D9,B10:C11");
    assert_cut(&down, "B1:B10", "B1:B12");
    assert_cut(&down, "D2:E3", "D2:E3");
    assert_cut(&down, "A1:D10", "A1:D1,A2:A10,D2:D10,B2:C12");

    let right = band(CellShift::Right);
    assert_cut(&right, "B1:B10", "B1,B4:B10,D2:D3");
    assert_cut(&right, "D2:E3", "F2:G3");
    assert_cut(&right, "A8:D9", "A8:D9");

    let up = band(CellShift::Up);
    assert_cut(&up, "B5:C6", "B3:C4");
    assert_cut(&up, "A8:D9", "A8:A9,D8:D9,B6:C7");
    assert_cut(&up, "B1:B10", "B1:B8");
    assert_cut(&up, "A1:D10", "A1:D1,A2:A10,D2:D10,B2:C8");

    let left = band(CellShift::Left);
    assert_cut(&left, "A1:F10", "A1:F1,A4:F10,A2:D3");
    assert_cut(&left, "D1:D10", "D1,D4:D10,B2:B3");
    // Nothing of B1:B10 that survives moves -- Excel keeps the address.
    assert_cut(&left, "B1:B10", "B1:B10");
    assert_cut(&left, "D2:E3", "B2:C3");
}

/// probe2 + probe7: inserted cells take their neighbour's rules (a CF on A1:D1
/// above an insertion at B2:C3 also covers B2:C3; a DV on B1:C1 covers B2:C3).
#[test]
fn inserted_cells_inherit_the_rules_of_their_neighbour() {
    let down = band(CellShift::Down);
    assert_eq!(down.inherited_piece(&r(0, 0, 0, 3)), Some(r(1, 1, 2, 2)), "A1:D1 -> B2:C3");
    assert_eq!(down.inherited_piece(&r(0, 1, 0, 2)), Some(r(1, 1, 2, 2)), "B1:C1 -> B2:C3");
    // A range that already spans the insertion grows over it instead.
    assert_eq!(down.inherited_piece(&r(0, 1, 9, 1)), None);
    // Not adjacent / not in the band / a delete: nothing inherited.
    assert_eq!(down.inherited_piece(&r(0, 4, 0, 5)), None);
    assert_eq!(band(CellShift::Up).inherited_piece(&r(0, 0, 0, 3)), None);
    // Shift right inherits from the column on the LEFT.
    assert_eq!(band(CellShift::Right).inherited_piece(&r(0, 0, 5, 0)), Some(r(1, 1, 2, 2)));
}

/// probe2 "MERGES" and probe3 (the question, Cancel and OK).
#[test]
fn merges_move_inside_the_band_and_are_cut_across_its_edge() {
    let down = band(CellShift::Down);
    assert_eq!(plan_merge(&down, a1("A8:B8")[0]), MergePlan::Cut);
    assert_eq!(plan_merge(&down, a1("B8:C8")[0]), MergePlan::Reshape(a1("B10:C10")[0]));
    assert_eq!(plan_merge(&down, a1("B2:B3")[0]), MergePlan::Reshape(a1("B4:B5")[0]));
    assert_eq!(plan_merge(&down, a1("A2:B2")[0]), MergePlan::Cut);
    assert_eq!(plan_merge(&down, a1("A1:B1")[0]), MergePlan::Untouched);
    assert_eq!(plan_merge(&down, a1("B5:D5")[0]), MergePlan::Cut);
    assert_eq!(plan_merge(&down, a1("B1:B2")[0]), MergePlan::Reshape(a1("B1:B4")[0]));
    let up = band(CellShift::Up);
    assert_eq!(plan_merge(&up, a1("A8:B8")[0]), MergePlan::Cut);
    // B3:B4 loses B3 and shrinks to one cell: dropped, with no question
    // (probe3 recorded no dialog for it).
    assert_eq!(plan_merge(&up, a1("B3:B4")[0]), MergePlan::Drop);
    assert_eq!(plan_merge(&up, a1("B2:C3")[0]), MergePlan::Drop);
    assert_eq!(plan_merge(&up, a1("B8:C8")[0]), MergePlan::Reshape(a1("B6:C6")[0]));
    let right = band(CellShift::Right);
    assert_eq!(plan_merge(&right, a1("B5:C5")[0]), MergePlan::Untouched);
    assert_eq!(plan_merge(&right, a1("D3:D4")[0]), MergePlan::Cut);
    assert_eq!(plan_merge(&right, a1("D2:E3")[0]), MergePlan::Reshape(a1("F2:G3")[0]));
}

#[track_caller]
fn assert_table(b: &BandEdit, table: &str, excel: Option<&str>) {
    let got = plan_table(b, a1(table)[0], true, false);
    match excel {
        Some(next) if next == table => assert_eq!(got, TablePlan::Untouched, "table {}", table),
        Some(next) => assert_eq!(got, TablePlan::Reshape(a1(next)[0]), "table {}", table),
        None => assert!(matches!(got, TablePlan::Refuse(_)), "table {} must be refused, got {:?}", table, got),
    }
}

/// probe2 "TABLES" and probe7 (header row, last data row, one data row kept).
#[test]
fn tables_move_whole_or_grow_inside_and_refuse_a_cut() {
    let down = band(CellShift::Down); // insert B2:C3 down
    assert_table(&down, "B10:C12", Some("B12:C14"));
    assert_table(&down, "A10:D12", None);
    assert_table(&down, "B10:B12", Some("B12:B14"));
    assert_table(&BandEdit::new(4, 1, 5, 2, CellShift::Down), "A12:D14", None);
    assert_table(&BandEdit::new(13, 1, 13, 2, CellShift::Down), "B13:C16", Some("B13:C17"));
    assert_table(&BandEdit::new(13, 1, 13, 1, CellShift::Down), "B13:C16", None);
    assert_table(&BandEdit::new(13, 0, 13, 3, CellShift::Down), "B13:C16", None);
    assert_table(&BandEdit::new(4, 1, 5, 2, CellShift::Down), "A1:F3", Some("A1:F3"));
    assert_table(&BandEdit::new(1, 1, 1, 2, CellShift::Down), "B2:C4", Some("B3:C5"));
    assert_table(&BandEdit::new(4, 1, 4, 2, CellShift::Down), "B2:C4", Some("B2:C4"));
    let right = band(CellShift::Right);
    assert_table(&right, "E1:F5", None);
    assert_table(&right, "E2:F3", Some("G2:H3"));
    assert_table(&BandEdit::new(1, 1, 3, 1, CellShift::Right), "B2:C4", Some("C2:D4"));
    assert_table(&BandEdit::new(1, 3, 3, 3, CellShift::Right), "B2:C4", Some("B2:C4"));

    let up = band(CellShift::Up); // delete B2:C3 up
    assert_table(&up, "B10:C12", Some("B8:C10"));
    assert_table(&up, "A10:D12", None);
    assert_table(&BandEdit::new(13, 1, 13, 2, CellShift::Up), "B13:C16", Some("B13:C15"));
    // Every data row deleted: Excel keeps one.
    assert_table(&BandEdit::new(13, 1, 15, 2, CellShift::Up), "B13:C16", Some("B13:C14"));
    // The header row cannot be deleted.
    assert_table(&BandEdit::new(12, 1, 12, 2, CellShift::Up), "B13:C16", None);
    assert_table(&up, "B3:C5", None);
    assert_table(&BandEdit::new(3, 1, 3, 2, CellShift::Up), "B2:C4", Some("B2:C3"));
    assert_table(&BandEdit::new(2, 1, 2, 2, CellShift::Up), "B2:C3", Some("B2:C3"));
}

/// A cell only moves inside the band, and an (empty) cell pushed past the
/// sheet's last row has nowhere to go: it is dropped, never stored at row
/// 1,048,577. (A non-empty one is refused before anything moves -- rule 2.)
#[test]
fn cells_move_inside_the_band_only_and_never_past_the_sheet_edge() {
    let down = band(CellShift::Down);
    assert_eq!(down.shift_cell(4, 1), Some((6, 1)), "B5 -> B7");
    assert_eq!(down.shift_cell(4, 0), Some((4, 0)), "A5 stays");
    assert_eq!(down.shift_cell(0, 1), Some((0, 1)), "B1 stays");
    assert_eq!(down.shift_cell(engine::EXCEL_MAX_ROW_INDEX - 1, 2), None, "pushed off the bottom");
    let up = band(CellShift::Up);
    assert_eq!(up.shift_cell(1, 1), None, "B2 deleted");
    assert_eq!(up.shift_cell(3, 2), Some((1, 2)), "C4 -> C2");
    let left = band(CellShift::Left);
    assert_eq!(left.shift_cell(1, 4), Some((1, 2)), "E2 -> C2");
    assert_eq!(left.shift_cell(3, 4), Some((3, 4)), "E4 is outside the band rows");
}

#[test]
fn shift_parsing_names_the_whole_line_commands_on_a_wrong_value() {
    assert_eq!(CellShift::parse_insert("down"), Ok(CellShift::Down));
    assert_eq!(CellShift::parse_delete("left"), Ok(CellShift::Left));
    assert!(CellShift::parse_insert("left").unwrap_err().contains("insert_rows"));
    assert!(CellShift::parse_delete("entireRow").unwrap_err().contains("delete_rows"));
}

// ===========================================================================
// THE COMMAND over a real AppState
// ===========================================================================

struct Fx {
    state: AppState,
    file: FileState,
    files: crate::persistence::UserFilesState,
    pivots: PivotState,
    pane: crate::pane_control::PaneControlState,
    filters: crate::ribbon_filter::RibbonFilterState,
    slicer: crate::slicer::SlicerState,
    timeline: crate::timeline_slicer::TimelineSlicerState,
}

impl Fx {
    /// `sheets` sheets named Sheet1..SheetN, sheet 0 active (the same seeding
    /// the data-module harness uses).
    fn new(sheets: usize) -> Self {
        let state = crate::create_app_state();
        let seed = crate::document_effect::test_seed_effect();
        for i in 1..sheets {
            state.grids.write(&seed).unwrap().push(engine::Grid::new());
            state.sheet_names.write(&seed).unwrap().push(format!("Sheet{}", i + 1));
            state.all_column_widths.write(&seed).unwrap().push(HashMap::new());
            state.all_row_heights.write(&seed).unwrap().push(HashMap::new());
            state.all_user_hidden_rows.write(&seed).unwrap().push(HashSet::new());
            state.all_user_hidden_cols.write(&seed).unwrap().push(HashSet::new());
            state
                .sheet_ids
                .write(&seed)
                .unwrap()
                .push(identity::SheetId::from_bytes(identity::generate_uuid_v7()));
        }
        {
            let mut all = state.all_merged_regions.write(&seed).unwrap();
            while all.len() < sheets {
                all.push(HashSet::new());
            }
        }
        Fx {
            state,
            file: FileState::default(),
            files: crate::persistence::UserFilesState::default(),
            pivots: PivotState::new(),
            pane: crate::pane_control::PaneControlState::new(),
            filters: crate::ribbon_filter::RibbonFilterState::new(),
            slicer: crate::slicer::SlicerState::new(),
            timeline: crate::timeline_slicer::TimelineSlicerState::new(),
        }
    }

    /// Put a cell, as a load would: `=...` is a formula, a number a number.
    fn put(&self, sheet: usize, a1_ref: &str, text: &str) {
        let (row, col) = calcula_format::cell_ref::from_a1(a1_ref).expect("a1");
        let cell = if text.starts_with('=') {
            Cell::new_formula(text.to_string())
        } else if let Ok(n) = text.parse::<f64>() {
            Cell::new_number(n)
        } else {
            Cell::new_text(text.to_string())
        };
        let seed = crate::document_effect::test_seed_effect();
        let active = *self.state.active_sheet.read().unwrap();
        self.state.grids.write(&seed).unwrap()[sheet].set_cell(row, col, cell.clone());
        if sheet == active {
            self.state.grid.write(&seed).unwrap().set_cell(row, col, cell);
        }
    }

    /// Edges and values from the stored formulas -- what a load produces.
    fn settle(&self) {
        crate::undo_commands::rebuild_all_dependencies(&self.state);
        let sheets = self.state.sheet_names.read().unwrap().len();
        for idx in 0..sheets {
            crate::calculation::recalculate_sheet_values(&self.state, &self.files, &self.pivots, idx, None);
        }
    }

    fn shift(&self, range: &str, shift: CellShift, unmerge: bool) -> Result<CellShiftResult, String> {
        let r = a1(range)[0];
        shift_cells_impl(
            &self.state, &self.file, &self.pivots, &self.files, &self.pane, &self.filters, &self.slicer,
            &self.timeline, r.start_row, r.start_col, r.end_row, r.end_col, shift, unmerge,
        )
    }

    fn cell(&self, sheet: usize, a1_ref: &str) -> Option<Cell> {
        let (row, col) = calcula_format::cell_ref::from_a1(a1_ref).expect("a1");
        let active = *self.state.active_sheet.read().unwrap();
        if sheet == active {
            self.state.grid.read().unwrap().get_cell(row, col).cloned()
        } else {
            self.state.grids.read().unwrap()[sheet].get_cell(row, col).cloned()
        }
    }

    fn formula(&self, sheet: usize, a1_ref: &str) -> Option<String> {
        // `formula_string` renders without the leading `=`; the expectations
        // read the way a user types them.
        self.cell(sheet, a1_ref).and_then(|c| c.formula_string()).map(|f| format!("={}", f))
    }

    fn value(&self, sheet: usize, a1_ref: &str) -> CellValue {
        self.cell(sheet, a1_ref).map(|c| c.value).unwrap_or(CellValue::Empty)
    }

    fn number(&self, sheet: usize, a1_ref: &str) -> f64 {
        match self.value(sheet, a1_ref) {
            CellValue::Number(n) => n,
            other => panic!("{} is {:?}, expected a number", a1_ref, other),
        }
    }

    fn undo_depth(&self) -> usize {
        self.state.undo_stack.lock().unwrap().undo_depth()
    }

    fn undo(&self) {
        let transaction = self.state.undo_stack.lock().unwrap().pop_undo().expect("nothing to undo");
        crate::undo_commands::apply_changes(
            &self.state, &self.file, &self.files, &self.pivots, &self.slicer, &self.filters, &self.pane,
            &self.timeline, transaction, true,
        );
    }

    fn mark_clean(&self) {
        crate::document_effect::mark_saved(&self.file);
    }
}

/// The probe's sheet in miniature: values in A1:E12 (10*row + col, 1-based as
/// Excel's `Fill`), the two moving formulas, Sheet2 reading Sheet1.
fn probe_book() -> Fx {
    let fx = Fx::new(2);
    for row in 1..=12u32 {
        for col in 1..=5u32 {
            let a1_ref = format!("{}{}", calcula_format::cell_ref::col_to_letters(col - 1), row);
            fx.put(0, &a1_ref, &format!("{}", row * 10 + col));
        }
    }
    fx.put(0, "B5", "=A5+B6+C7");
    fx.put(0, "C6", "=SUM(B4:B6)");
    fx.put(0, "H1", "=SUM(B1:B10)");
    fx.put(0, "H2", "=B5");
    fx.put(1, "A1", "=Sheet1!B5");
    fx.put(1, "A2", "=SUM(Sheet1!B1:B10)");
    fx.settle();
    fx.mark_clean();
    fx
}

#[test]
fn insert_down_moves_the_band_rewrites_every_sheet_and_is_one_undo_step() {
    let fx = probe_book();
    let depth = fx.undo_depth();
    let sum_before = fx.number(0, "H1");
    let b5_before = fx.number(0, "B5");

    let result = fx.shift("B2:C3", CellShift::Down, false).expect("insert cells");
    assert_eq!(result, CellShiftResult { applied: true, confirm: None, whole_lines: false });
    assert!(fx.file.is_dirty(), "a committed insert dirties the document");
    assert_eq!(fx.undo_depth(), depth + 1, "ONE undo step");

    // The band moved; the cells beside it did not.
    assert_eq!(fx.value(0, "B2"), CellValue::Empty);
    assert_eq!(fx.value(0, "C3"), CellValue::Empty);
    assert_eq!(fx.number(0, "B4"), 22.0, "old B2 is now B4");
    assert_eq!(fx.number(0, "A2"), 21.0, "column A never moves");
    assert_eq!(fx.number(0, "D2"), 24.0, "column D never moves");
    assert_eq!(fx.formula(0, "B7").as_deref(), Some("=A5+B8+C9"));
    assert_eq!(fx.formula(0, "C8").as_deref(), Some("=SUM(B6:B8)"));
    // References into the band, on this sheet and the next.
    assert_eq!(fx.formula(0, "H1").as_deref(), Some("=SUM(B1:B12)"));
    assert_eq!(fx.formula(0, "H2").as_deref(), Some("=B7"));
    // The lexer upper-cases a bare sheet name (CLAUDE.md), so compare in that case.
    assert_eq!(fx.formula(1, "A1").as_deref(), Some("=SHEET1!B7"));
    assert_eq!(fx.formula(1, "A2").as_deref(), Some("=SUM(SHEET1!B1:B12)"));
    // Values follow (the inserted cells are empty, so the SUM is unchanged).
    assert_eq!(fx.number(0, "H1"), sum_before);
    assert_eq!(fx.number(0, "H2"), b5_before);
    assert_eq!(fx.number(1, "A1"), b5_before);

    fx.undo();
    assert_eq!(fx.number(0, "B2"), 22.0);
    assert_eq!(fx.formula(0, "B5").as_deref(), Some("=A5+B6+C7"));
    assert_eq!(fx.formula(0, "H1").as_deref(), Some("=SUM(B1:B10)"));
    assert_eq!(fx.formula(1, "A1").as_deref(), Some("=SHEET1!B5"));
    assert_eq!(fx.value(0, "B7"), CellValue::Number(72.0));
}

#[test]
fn delete_up_removes_the_block_and_recalculates_what_read_it() {
    let fx = probe_book();
    fx.put(0, "H3", "=ROW(B10)");
    fx.settle();
    fx.mark_clean();

    fx.shift("B2:C3", CellShift::Up, false).expect("delete cells");
    assert_eq!(fx.number(0, "B2"), 42.0, "old B4 is now B2");
    assert_eq!(fx.number(0, "A2"), 21.0);
    assert_eq!(fx.formula(0, "B3").as_deref(), Some("=A5+B4+C5"), "B5 moved up; A5 stayed");
    assert_eq!(fx.formula(0, "H1").as_deref(), Some("=SUM(B1:B8)"));
    // The value moved with the reference: SUM lost B2+B3 (22+32) and read
    // nothing else -- recalculated, not carried.
    let sum: f64 = [12.0, 42.0, 0.0, 62.0, 72.0, 82.0, 92.0, 102.0].iter().sum::<f64>() + fx.number(0, "B3");
    assert_eq!(fx.number(0, "H1"), sum);
    // A shape-sensitive formula whose argument moved is recalculated (D8).
    assert_eq!(fx.formula(0, "H3").as_deref(), Some("=ROW(B8)"));
    assert_eq!(fx.number(0, "H3"), 8.0);
}

#[test]
fn notes_comments_hyperlinks_and_formatting_move_with_their_cells() {
    let fx = probe_book();
    let seed = crate::document_effect::test_seed_effect();
    fx.state.notes.write(&seed).unwrap().entry(0).or_default().insert(
        (4, 1),
        crate::notes::Note::new(4, 1, 0, "me".into(), "note-B5".into()),
    );
    fx.state.notes.write(&seed).unwrap().entry(0).or_default().insert(
        (4, 0),
        crate::notes::Note::new(4, 0, 0, "me".into(), "note-A5".into()),
    );
    fx.state.comments.write(&seed).unwrap().entry(0).or_default().insert(
        (5, 2),
        crate::comments::Comment::new(5, 2, 0, "a@b".into(), "me".into(), "c-C6".into()),
    );
    fx.state.hyperlinks.write(&seed).unwrap().entry(0).or_default().insert(
        (4, 2),
        crate::hyperlinks::Hyperlink::new_url(4, 2, 0, "https://example.com/c5".into()),
    );
    {
        let mut grid = fx.state.grid.write(&seed).unwrap();
        let mut cell = grid.get_cell(4, 1).cloned().unwrap();
        cell.style_index = 3;
        grid.set_cell(4, 1, cell);
    }

    fx.shift("B2:C3", CellShift::Down, false).expect("insert cells");

    let notes = fx.state.notes.read().unwrap();
    let sheet_notes = notes.get(&0).unwrap();
    assert_eq!(sheet_notes.get(&(6, 1)).map(|n| (n.content.as_str(), n.row)), Some(("note-B5", 6)));
    assert_eq!(sheet_notes.get(&(4, 0)).map(|n| n.content.as_str()), Some("note-A5"), "A5's note stays");
    drop(notes);
    assert!(fx.state.comments.read().unwrap().get(&0).unwrap().contains_key(&(7, 2)), "C6 -> C8");
    assert!(fx.state.hyperlinks.read().unwrap().get(&0).unwrap().contains_key(&(6, 2)), "C5 -> C7");
    assert_eq!(fx.cell(0, "B7").map(|c| c.style_index), Some(3), "formatting moves with the cell");

    fx.undo();
    assert!(fx.state.notes.read().unwrap().get(&0).unwrap().contains_key(&(4, 1)), "undo puts the note back");
    assert!(fx.state.hyperlinks.read().unwrap().get(&0).unwrap().contains_key(&(4, 2)));
}

#[test]
fn inserted_cells_take_the_format_of_the_cell_above() {
    let fx = probe_book();
    let seed = crate::document_effect::test_seed_effect();
    {
        let mut grid = fx.state.grid.write(&seed).unwrap();
        for col in [1u32, 2] {
            let mut cell = grid.get_cell(0, col).cloned().unwrap();
            cell.style_index = 5;
            grid.set_cell(0, col, cell);
        }
    }
    fx.shift("B2:C3", CellShift::Down, false).expect("insert cells");
    for a in ["B2", "C2", "B3", "C3"] {
        let cell = fx.cell(0, a).expect("an inserted cell carrying the neighbour's format");
        assert_eq!(cell.style_index, 5, "{} takes B1/C1's format", a);
        assert_eq!(cell.value, CellValue::Empty, "{} is empty", a);
    }
    assert_eq!(fx.cell(0, "D2").map(|c| c.style_index), Some(0), "outside the band nothing is inherited");
}

#[test]
fn conditional_formats_and_validations_are_cut_and_undone() {
    let fx = probe_book();
    crate::conditional_formatting::add_conditional_format_impl(
        &fx.state,
        &fx.file,
        AddCFParams {
            target: None,
            rule: ConditionalFormatRule::CellValue(CellValueRule {
                operator: CellValueOperator::GreaterThan,
                value1: "2".to_string(),
                value2: None,
            }),
            format: ConditionalFormat { background_color: Some("#FFC7CE".to_string()), ..Default::default() },
            ranges: vec![ConditionalFormatRange { start_row: 7, start_col: 0, end_row: 8, end_col: 3 }],
            stop_if_true: false,
        },
    );
    let seed = crate::document_effect::test_seed_effect();
    fx.state.data_validations.write(&seed).unwrap().entry(0).or_default().push(
        crate::data_validation::ValidationRange {
            start_row: 7,
            start_col: 0,
            end_row: 7,
            end_col: 3,
            validation: crate::data_validation::DataValidation::default(),
        },
    );
    fx.mark_clean();

    fx.shift("B2:C3", CellShift::Down, false).expect("insert cells");
    let rules = fx.state.conditional_formats.read().unwrap().get(&0).cloned().unwrap();
    let cf: Vec<CellRange> = rules[0].ranges.iter().map(|x| r(x.start_row, x.start_col, x.end_row, x.end_col)).collect();
    assert_eq!(cells_of(&cf), cells_of(&a1("A8:A9,D8:D9,B10:C11")));
    let dv: Vec<CellRange> = fx.state.data_validations.read().unwrap().get(&0).unwrap().iter().map(|v| r(v.start_row, v.start_col, v.end_row, v.end_col)).collect();
    assert_eq!(cells_of(&dv), cells_of(&a1("A8,D8,B10:C10")), "probe1: DV A8:D8 -> A8, D8, B10:C10");

    fx.undo();
    let rules = fx.state.conditional_formats.read().unwrap().get(&0).cloned().unwrap();
    assert_eq!(rules[0].ranges.len(), 1);
    assert_eq!(fx.state.data_validations.read().unwrap().get(&0).unwrap().len(), 1);
}

#[test]
fn a_cut_merge_asks_first_and_changes_nothing_until_the_answer_is_yes() {
    let fx = probe_book();
    let seed = crate::document_effect::test_seed_effect();
    fx.state.merged_regions.write(&seed).unwrap().insert(to_merge(a1("A8:B8")[0]));
    fx.state.merged_regions.write(&seed).unwrap().insert(to_merge(a1("B10:C10")[0]));
    let depth = fx.undo_depth();

    let asked = fx.shift("B2:C3", CellShift::Down, false).expect("asks, does not refuse");
    assert_eq!(asked.applied, false);
    assert_eq!(asked.confirm.as_deref(), Some(UNMERGE_QUESTION));
    assert_eq!(fx.number(0, "B2"), 22.0, "Cancel: nothing moved");
    assert!(!fx.file.is_dirty(), "asking leaves the document clean");
    assert_eq!(fx.undo_depth(), depth, "asking records nothing");

    fx.shift("B2:C3", CellShift::Down, true).expect("OK: unmerge and go on");
    let merges = fx.state.merged_regions.read().unwrap().clone();
    assert!(!merges.contains(&to_merge(a1("A8:B8")[0])), "the cut merge is unmerged");
    assert!(merges.contains(&to_merge(a1("B12:C12")[0])), "the merge inside the band moved");
    assert_eq!(merges.len(), 1);

    fx.undo();
    let merges = fx.state.merged_regions.read().unwrap().clone();
    assert!(merges.contains(&to_merge(a1("A8:B8")[0])) && merges.contains(&to_merge(a1("B10:C10")[0])));
}

#[test]
fn every_refusal_leaves_the_document_clean_and_the_cells_where_they_were() {
    // Protected sheet (rule 9).
    let fx = probe_book();
    let seed = crate::document_effect::test_seed_effect();
    fx.state.sheet_protection.write(&seed).unwrap().entry(0).or_default().protected = true;
    let err = fx.shift("B2:C3", CellShift::Down, false).unwrap_err();
    assert!(err.contains("protected sheet"), "{}", err);
    assert!(!fx.file.is_dirty());
    assert_eq!(fx.number(0, "B2"), 22.0);

    // A PivotTable the band cuts (rule 8), and one it would only move.
    let fx = probe_book();
    fx.state.protected_regions.lock().unwrap().push(crate::ProtectedRegion {
        id: "pivot-1".into(),
        region_type: "pivot".into(),
        owner_id: identity::EntityId::from_bytes(identity::generate_uuid_v7()),
        sheet_index: 0,
        start_row: 9,
        start_col: 0,
        end_row: 12,
        end_col: 1,
        reserved_only: false,
    });
    assert_eq!(fx.shift("B2:C3", CellShift::Down, false).unwrap_err(), PIVOT_REFUSAL);
    assert_eq!(fx.shift("E2:F3", CellShift::Down, false).map(|r| r.applied), Ok(true), "a pivot outside the band is not in the way");
    fx.mark_clean();

    // A table the band cuts (rule 7).
    let fx = probe_book();
    let table_id = identity::EntityId::from_bytes(identity::generate_uuid_v7());
    fx.state.tables.write(&seed).unwrap().entry(0).or_default().insert(
        table_id,
        crate::tables::Table {
            id: table_id,
            name: "Table1".into(),
            sheet_index: 0,
            start_row: 9,
            start_col: 0,
            end_row: 11,
            end_col: 3,
            columns: Vec::new(),
            style_options: Default::default(),
            style_name: "TableStyleMedium2".into(),
            auto_filter_id: None,
        },
    );
    assert_eq!(fx.shift("B2:C3", CellShift::Down, false).unwrap_err(), TABLE_REFUSAL);
    assert!(!fx.file.is_dirty());

    // Pushed off the sheet (rule 2) -- formatting alone counts.
    let fx = probe_book();
    {
        let mut grid = fx.state.grid.write(&seed).unwrap();
        let mut cell = Cell::new();
        cell.style_index = 2;
        grid.set_cell(engine::EXCEL_MAX_ROW_INDEX, 1, cell);
    }
    assert_eq!(fx.shift("B2:C3", CellShift::Down, false).unwrap_err(), PUSH_OFF_REFUSAL);
    assert!(fx.shift("D2:E3", CellShift::Down, false).is_ok(), "the band that holds nothing at the edge inserts");
}

#[test]
fn a_table_inside_the_band_moves_and_one_its_columns_match_grows() {
    let fx = probe_book();
    let seed = crate::document_effect::test_seed_effect();
    let table_id = identity::EntityId::from_bytes(identity::generate_uuid_v7());
    fx.state.tables.write(&seed).unwrap().entry(0).or_default().insert(
        table_id,
        crate::tables::Table {
            id: table_id,
            name: "Table1".into(),
            sheet_index: 0,
            start_row: 9,
            start_col: 1,
            end_row: 11,
            end_col: 2,
            columns: Vec::new(),
            style_options: Default::default(),
            style_name: "TableStyleMedium2".into(),
            auto_filter_id: None,
        },
    );
    fx.shift("B2:C3", CellShift::Down, false).expect("a table inside the band moves");
    let t = fx.state.tables.read().unwrap().get(&0).unwrap().get(&table_id).cloned().unwrap();
    assert_eq!((t.start_row, t.end_row), (11, 13), "B10:C12 -> B12:C14");
    fx.undo();
    let t = fx.state.tables.read().unwrap().get(&0).unwrap().get(&table_id).cloned().unwrap();
    assert_eq!((t.start_row, t.end_row), (9, 11), "undo puts the table back");
}

#[test]
fn a_spill_inside_the_band_moves_whole_and_a_cut_one_spills_again() {
    let fx = Fx::new(1);
    fx.put(0, "B5", "=SEQUENCE(3)");
    fx.settle();
    assert_eq!(fx.number(0, "B7"), 3.0, "the spill is live before the edit");
    fx.shift("B2:C3", CellShift::Down, false).expect("insert cells");
    assert_eq!(fx.formula(0, "B7").as_deref(), Some("=SEQUENCE(3)"));
    assert_eq!(fx.number(0, "B9"), 3.0, "the whole spill moved with its origin");
    assert_eq!(fx.value(0, "B5"), CellValue::Empty);

    // A spill crossing the band edge (A5 =SEQUENCE(1,3) fills A5:C5): its
    // outputs are re-derived, not carried down as typed values.
    let fx = Fx::new(1);
    fx.put(0, "A5", "=SEQUENCE(1,3)");
    fx.settle();
    assert_eq!(fx.number(0, "C5"), 3.0);
    fx.shift("B2:C3", CellShift::Down, false).expect("insert cells");
    assert_eq!(fx.formula(0, "A5").as_deref(), Some("=SEQUENCE(1,3)"));
    assert_eq!(fx.number(0, "C5"), 3.0, "the origin spilled again into the cells it owns");
    assert_eq!(fx.value(0, "C7"), CellValue::Empty, "no stale copy of the old output below");
}

#[test]
fn a_range_spanning_every_column_inserts_entire_rows() {
    let fx = probe_book();
    let result = fx
        .shift(&format!("A2:{}3", calcula_format::cell_ref::col_to_letters(engine::EXCEL_MAX_COL_INDEX)), CellShift::Right, false)
        .expect("whole rows");
    assert!(result.whole_lines, "Excel inserts entire rows whatever the shift");
    assert_eq!(fx.number(0, "A4"), 21.0, "column A moved down too");
    assert_eq!(fx.formula(0, "H3").as_deref(), None);
}

/// MEASURED BEFORE THE FIX: undoing an Insert Cells that had moved
/// `B5 =SEQUENCE(3)` put the cells back but left both spill maps EMPTY, so the
/// restored B6:B7 read as typed values and the undo's own recalculation turned
/// B5 into `#SPILL!`. The edit now records the sheet's spill claims beside its
/// snapshot (the `spill_claims` restore).
#[test]
fn undo_puts_a_moved_spill_back_whole() {
    let fx = Fx::new(1);
    fx.put(0, "B5", "=SEQUENCE(3)");
    fx.settle();
    fx.shift("B2:C3", CellShift::Down, false).expect("insert cells");
    fx.undo();
    assert_eq!(fx.number(0, "B5"), 1.0, "the origin is a spill again, not #SPILL!");
    assert_eq!(fx.number(0, "B7"), 3.0);
    let claims = fx.state.spill_ranges.read().unwrap().get(&(0, 4, 1)).cloned();
    assert!(claims.map(|c| c.contains(&(6, 1))).unwrap_or(false), "B5 owns B5:B7 again");
    assert!(fx.state.spill_ranges.read().unwrap().get(&(0, 6, 1)).is_none(), "no claim left at the moved origin");
}

/// The same defect on the WHOLE-ROW path, which records the same
/// `GridSnapshot`: measured before the fix, undoing Insert Rows above
/// `B5 =SEQUENCE(3)` left the spill maps empty and B5 showing `#SPILL!`.
#[test]
fn undo_of_insert_rows_puts_a_moved_spill_back_whole() {
    let fx = Fx::new(1);
    fx.put(0, "B5", "=SEQUENCE(3)");
    fx.settle();
    insert_rows_impl(&fx.state, &fx.file, &fx.pivots, &fx.files, &fx.pane, &fx.filters, &fx.slicer, &fx.timeline, 1, 2, None)
        .expect("insert rows");
    assert_eq!(fx.number(0, "B9"), 3.0, "the spill moved down with its rows");
    fx.undo();
    assert_eq!(fx.number(0, "B5"), 1.0, "the origin is a spill again, not #SPILL!");
    assert!(fx.state.spill_ranges.read().unwrap().contains_key(&(0, 4, 1)), "B5 owns its cells again");
}

// Insert/Delete Sheet Rows and Columns: the same rules, through
// `BandEdit::whole_lines` (a child so it shares `Fx` and the A1 helpers).
#[path = "structure_lines_tests.rs"]
mod lines;

// The adversarial review's findings on this command and the whole-line inserts
// (straddling ranges, spill-claims undo, push-off on every insert path).
#[path = "structure_review_tests.rs"]
mod review;
